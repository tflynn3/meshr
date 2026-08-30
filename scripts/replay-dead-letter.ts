import { FieldPath, Firestore, Timestamp } from "@google-cloud/firestore";
import { PubSub, v1 } from "@google-cloud/pubsub";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  classifyDeadLetterSource,
  DEAD_LETTER_TARGETS,
  normalizeSourceSubscription,
  parseModerationScreeningJob,
  parseReplaySelectors,
  replayPayload,
  type ReplayEnvironment,
  type ReplayRoute,
} from "../platform/deadLetterReplay.ts";
import { parseEventEnvelope, type EventEnvelope } from "../platform/eventEnvelope.ts";

const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
const source = process.env.MESHR_REPLAY_SOURCE?.trim().toLowerCase() || "dlq";
const databaseId = process.env.MESHR_FIRESTORE_DATABASE?.trim();
const restoreDatabaseId = process.env.MESHR_REPLAY_RESTORE_DATABASE?.trim();
const restoreApproval = process.env.MESHR_REPLAY_RESTORE_APPROVAL?.trim();
const auditDatabaseId = process.env.MESHR_AUDIT_FIRESTORE_DATABASE?.trim();
const replayEnvironmentValue = process.env.MESHR_REPLAY_ENVIRONMENT?.trim().toLowerCase();
const configuredSubscriptionName = process.env.MESHR_DLQ_SUBSCRIPTION?.trim();
const configuredTopicName = process.env.MESHR_EVENTS_TOPIC?.trim();
const subscriptionName = configuredSubscriptionName || "mesh-events-dlq-replay";
const topicName = configuredTopicName || "mesh-events";
const maxMessages = Math.max(1, Math.min(Number(process.env.MESHR_REPLAY_MAX ?? "100"), 1_000));
const pageSize = Math.max(1, Math.min(Number(process.env.MESHR_REPLAY_PAGE_SIZE ?? "100"), 1_000));
const apply = process.env.MESHR_REPLAY_APPLY === "1";
const since = process.env.MESHR_REPLAY_SINCE?.trim();
const until = process.env.MESHR_REPLAY_UNTIL?.trim();
const checkpointPath = process.env.MESHR_REPLAY_CHECKPOINT?.trim();
const replaySelectors = parseReplaySelectors(process.env.MESHR_REPLAY_EVENT_IDS ?? "");

if (!projectId || /^(?:PROJECT_ID|\$\{[^}]+\})$/i.test(projectId)) {
  throw new Error("GOOGLE_CLOUD_PROJECT is required for DLQ replay.");
}
if (source !== "dlq" && source !== "outbox") {
  throw new Error("MESHR_REPLAY_SOURCE must be dlq or outbox.");
}
if (source === "outbox" && !databaseId) {
  throw new Error("MESHR_FIRESTORE_DATABASE is required for outbox replay.");
}
if (restoreDatabaseId && source !== "outbox") {
  throw new Error("MESHR_REPLAY_RESTORE_DATABASE is supported only for outbox replay.");
}
if (restoreApproval && !restoreDatabaseId) {
  throw new Error("MESHR_REPLAY_RESTORE_APPROVAL requires MESHR_REPLAY_RESTORE_DATABASE.");
}
if (restoreDatabaseId && !/^[A-Za-z0-9._()~-]{1,128}$/.test(restoreDatabaseId)) {
  throw new Error("MESHR_REPLAY_RESTORE_DATABASE must be a bounded Firestore database ID.");
}
if (restoreDatabaseId && ["(default)", "meshr-canary"].includes(restoreDatabaseId)) {
  throw new Error(
    "MESHR_REPLAY_RESTORE_DATABASE cannot name a live production or canary authority database; use an isolated restore database.",
  );
}
if (restoreDatabaseId && restoreApproval !== `database:${restoreDatabaseId}`) {
  throw new Error(
    "MESHR_REPLAY_RESTORE_APPROVAL must exactly equal database:<restore_database_id> when selecting an explicit outbox restore database.",
  );
}
let replayEnvironment: ReplayEnvironment | undefined;
let dlqTarget: (typeof DEAD_LETTER_TARGETS)[ReplayEnvironment] | undefined;
if (source === "dlq" || source === "outbox") {
  if (replayEnvironmentValue !== "production" && replayEnvironmentValue !== "canary") {
    throw new Error(
      "MESHR_REPLAY_ENVIRONMENT must be production or canary for replay; this binds the source, destination, authority, and audit databases as one tuple.",
    );
  }
  replayEnvironment = replayEnvironmentValue;
  dlqTarget = DEAD_LETTER_TARGETS[replayEnvironment];
  if (source === "dlq" && (subscriptionName !== dlqTarget.deadLetterSubscription || topicName !== dlqTarget.eventTopic)) {
    throw new Error(
      `DLQ replay target mismatch for ${replayEnvironment}: use ${dlqTarget.deadLetterSubscription} and ${dlqTarget.eventTopic} together.`,
    );
  }
  if (source === "outbox" && databaseId !== dlqTarget.authorityDatabase) {
    throw new Error(
      `MESHR_FIRESTORE_DATABASE must be ${dlqTarget.authorityDatabase} for ${replayEnvironment} outbox replay; use MESHR_REPLAY_RESTORE_DATABASE with explicit approval for a reviewed restore source.`,
    );
  }
  if (source === "outbox" && topicName !== dlqTarget.eventTopic) {
    throw new Error(
      `MESHR_EVENTS_TOPIC must be ${dlqTarget.eventTopic} for ${replayEnvironment} outbox replay.`,
    );
  }
  if (auditDatabaseId && auditDatabaseId !== dlqTarget.auditDatabase) {
    throw new Error(
      `MESHR_AUDIT_FIRESTORE_DATABASE must be ${dlqTarget.auditDatabase} for ${replayEnvironment} replay.`,
    );
  }
}
if (apply && (!auditDatabaseId || !["meshr-release-audit", "meshr-canary-release-audit"].includes(auditDatabaseId))) {
  throw new Error(
    "MESHR_AUDIT_FIRESTORE_DATABASE must name a dedicated release-audit database for apply mode; dry-run first and never use an authority database.",
  );
}
if (apply && source === "dlq" && auditDatabaseId !== dlqTarget?.auditDatabase) {
  throw new Error(
    `MESHR_AUDIT_FIRESTORE_DATABASE must be ${dlqTarget?.auditDatabase} for the selected DLQ environment.`,
  );
}
if (replaySelectors.length > maxMessages) {
  throw new Error(
    `MESHR_REPLAY_EVENT_IDS contains ${replaySelectors.length} selectors, above MESHR_REPLAY_MAX=${maxMessages}; increase the cap or split the reviewed set explicitly.`,
  );
}
if (source === "outbox" && replaySelectors.some(({ route }) => route !== "events")) {
  throw new Error("Outbox replay selectors must use the events:event_id route.");
}
if (source === "outbox" && new Set(replaySelectors.map(({ eventId }) => eventId)).size !== replaySelectors.length) {
  throw new Error("Outbox replay selectors must not contain duplicate event IDs.");
}
if (apply && source === "dlq" && !replaySelectors.length) {
  throw new Error(
    "DLQ apply requires route-qualified MESHR_REPLAY_EVENT_IDS from a reviewed dry-run; this prevents applying a different leased batch or contract.",
  );
}

// The optional restore source is deliberately separate from the environment
// tuple. It is only for a reviewed outbox restore into a named database; the
// normal source database and destination topic must still identify the target
// production/canary environment above.
const firestoreDatabaseId = source === "outbox" ? (restoreDatabaseId || databaseId) : databaseId;

const subscriber = new v1.SubscriberClient({ projectId });
const pubsub = new PubSub({ projectId });
const subscription = subscriber.subscriptionPath(projectId, subscriptionName);
const topic = pubsub.topic(topicName, { messageOrdering: true });
const screeningTopic = pubsub.topic(
  dlqTarget?.screeningTopic || "moderation-screening",
  { messageOrdering: true },
);

async function modifyDlqAckDeadline(ackIds: string[], ackDeadlineSeconds: number): Promise<void> {
  if (!ackIds.length) return;
  await subscriber.modifyAckDeadline({
    subscription,
    ackIds,
    ackDeadlineSeconds,
  });
}

interface ReplayEvent {
  route: ReplayRoute;
  eventId: string;
  envelope?: EventEnvelope;
  screeningJob?: ReturnType<typeof parseModerationScreeningJob>;
  sourceSubscription?: string;
  ackId?: string;
}

interface ReplayCursor {
  publishedAt: string;
  eventId: string;
}

interface ReplayCheckpoint {
  version: 2;
  runId: string;
  source: "outbox";
  environment: ReplayEnvironment;
  authorityDatabase: string;
  restoreDatabase: string | null;
  eventTopic: string;
  auditDatabase: string;
  since: string;
  until: string;
  cursor: ReplayCursor | null;
  complete: boolean;
  updatedAt: string;
  replayed: number;
}

function messageData(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "base64");
  return Buffer.alloc(0);
}

interface PulledMessage {
  ackId?: string;
  message?: {
    data?: unknown;
    attributes?: Record<string, string>;
  };
}

function parseDeadLetterMessage(item: PulledMessage): ReplayEvent {
  if (!dlqTarget || !projectId || !item.message) {
    throw new Error("DLQ replay has no selected environment or message payload.");
  }
  const attributes = item.message.attributes;
  const sourceSubscription = normalizeSourceSubscription(
    attributes?.CloudPubSubDeadLetterSourceSubscription,
    projectId,
  );
  const route = classifyDeadLetterSource(attributes, dlqTarget, projectId);
  const payload = JSON.parse(messageData(item.message.data).toString("utf8")) as unknown;
  if (route === "moderation-screening") {
    const screeningJob = parseModerationScreeningJob(payload);
    return {
      route,
      eventId: screeningJob.event_id,
      screeningJob,
      sourceSubscription: sourceSubscription ?? undefined,
      ackId: item.ackId,
    };
  }
  const envelope = parseEventEnvelope(payload);
  return {
    route,
    eventId: envelope.event_id,
    envelope,
    sourceSubscription: sourceSubscription ?? undefined,
    ackId: item.ackId,
  };
}

const received: ReplayEvent[] = [];
let firestore: Firestore | undefined;
let auditFirestore: Firestore | undefined;
let dlqLeaseTimer: NodeJS.Timeout | undefined;
let dlqLeaseHealthy = true;
let replayCursor: ReplayCursor | null = null;
// A Pub/Sub Pull response has no backlog watermark. An under-filled response
// therefore cannot prove that a DLQ is empty; expose that uncertainty instead
// of issuing a false completion receipt.
let replayComplete: boolean | "unknown" = source === "dlq" ? "unknown" : replaySelectors.length > 0;
let replayCheckpoint: ReplayCheckpoint | undefined;
const defaultSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
const defaultUntil = new Date().toISOString();
if (checkpointPath) {
  try {
    const raw = JSON.parse(await readFile(checkpointPath, "utf8")) as Partial<ReplayCheckpoint>;
    if (
      raw.version !== 2 || raw.source !== "outbox" || typeof raw.runId !== "string" ||
      (raw.environment !== "production" && raw.environment !== "canary") ||
      typeof raw.authorityDatabase !== "string" ||
      (raw.restoreDatabase !== null && typeof raw.restoreDatabase !== "string") ||
      typeof raw.eventTopic !== "string" || typeof raw.auditDatabase !== "string" ||
      typeof raw.since !== "string" || typeof raw.until !== "string" ||
      (raw.cursor !== null && raw.cursor !== undefined &&
        (typeof raw.cursor !== "object" || typeof raw.cursor.publishedAt !== "string" || typeof raw.cursor.eventId !== "string"))
    ) {
      throw new Error("invalid replay checkpoint");
    }
    if (source !== raw.source) throw new Error("replay checkpoint source mismatch");
    if (raw.environment !== replayEnvironment) throw new Error("replay checkpoint environment mismatch");
    if (raw.authorityDatabase !== dlqTarget?.authorityDatabase) throw new Error("replay checkpoint authority database mismatch");
    if (raw.restoreDatabase !== (restoreDatabaseId ?? null)) throw new Error("replay checkpoint restore database mismatch");
    if (raw.eventTopic !== topicName) throw new Error("replay checkpoint event topic mismatch");
    if (auditDatabaseId && raw.auditDatabase !== auditDatabaseId) throw new Error("replay checkpoint audit database mismatch");
    if (since && since !== raw.since) throw new Error("replay checkpoint since mismatch");
    if (until && until !== raw.until) throw new Error("replay checkpoint until mismatch");
    replayCheckpoint = raw as ReplayCheckpoint;
    replayCursor = replayCheckpoint.cursor ?? null;
    replayComplete = replayCheckpoint.complete;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
const effectiveSince = since ?? replayCheckpoint?.since ?? defaultSince;
const effectiveUntil = until ?? replayCheckpoint?.until ?? defaultUntil;
if (source === "outbox" && apply && !replayCheckpoint && (!since || !until)) {
  throw new Error(
    "Outbox apply requires MESHR_REPLAY_SINCE and MESHR_REPLAY_UNTIL when no prior checkpoint exists; repeat the reviewed dry-run range explicitly.",
  );
}
const runId = replayCheckpoint?.runId ?? `replay_${Date.now()}_${randomUUID().slice(0, 12)}`;
if (source === "dlq") {
  if (apply) auditFirestore = new Firestore({ projectId, databaseId: auditDatabaseId });
  const targetKeys = replaySelectors.length ? new Set(replaySelectors.map(({ key }) => key)) : undefined;
  const targetCounts = new Map<string, number>();
  for (const { key } of replaySelectors) targetCounts.set(key, (targetCounts.get(key) ?? 0) + 1);
  const targetMessageCount = [...targetCounts.values()].reduce((sum, count) => sum + count, 0);
  const foundTargetCounts = new Map<string, number>();
  // An event envelope and its moderation-screening job intentionally share an
  // event_id but are different contracts. Deduplicate only the same route and
  // event ID so a reviewed batch can contain both messages.
  const seen = new Set<string>();
  const configuredPullAttempts = Number(process.env.MESHR_REPLAY_PULL_ATTEMPTS ?? "10");
  const pullAttempts = Number.isFinite(configuredPullAttempts) && Number.isInteger(configuredPullAttempts)
    ? Math.max(1, Math.min(configuredPullAttempts, 100))
    : 10;
  let attempts = 0;
  while (true) {
    attempts += 1;
    const [response] = await subscriber.pull({
      subscription,
      maxMessages: targetKeys ? Math.max(1, Math.min(maxMessages, targetMessageCount - received.length)) : maxMessages,
      returnImmediately: false,
    });
    const pulled = (response.receivedMessages ?? []) as PulledMessage[];
    // Pull has no backlog watermark. A page that fills the requested cap is
    // definitely incomplete; an under-filled non-empty page is deliberately
    // `unknown` because Pub/Sub may return fewer messages while backlog remains.
    // Only an empty response is treated as a point-in-time empty observation.
    replayComplete = pulled.length === 0 ? true : pulled.length < maxMessages ? "unknown" : false;
    const pulledAckIds = pulled.flatMap(({ ackId }) => ackId ? [ackId] : []);
    const releaseAckIds: string[] = [];
    try {
      for (const item of pulled) {
        const ackId = item.ackId;
        if (!ackId || !item.message) continue;
        const replayEvent = parseDeadLetterMessage(item);
        const replayKey = `${replayEvent.route}:${replayEvent.eventId}`;
        if (targetKeys && !targetKeys.has(replayKey)) {
          releaseAckIds.push(ackId);
          continue;
        }
        if (seen.has(replayKey)) {
          // A best-effort DLQ can forward the same source event more than
          // once. Keep one reviewed delivery and release duplicates.
          releaseAckIds.push(ackId);
          continue;
        }
        seen.add(replayKey);
        if (targetKeys) {
          foundTargetCounts.set(replayKey, (foundTargetCounts.get(replayKey) ?? 0) + 1);
        }
        received.push(replayEvent);
        if (apply) {
          // Extend a selected lease before the next blocking pull. A reviewed
          // event must not expire while the tool searches for later IDs.
          await modifyDlqAckDeadline([ackId], 600);
        } else {
          // Dry-runs are observational; do not make the reviewed batch
          // temporarily unavailable to the subsequent apply.
          releaseAckIds.push(ackId);
        }
      }
      await modifyDlqAckDeadline(releaseAckIds, 0);
    } catch (error) {
      // A malformed or untrusted DLQ message must never remain leased merely
      // because a page failed validation. Best-effort release preserves the
      // message for a later operator run without masking the root error.
      await modifyDlqAckDeadline(pulledAckIds, 0).catch(() => undefined);
      throw error;
    }
    if (!targetKeys || received.length >= targetMessageCount || pulled.length === 0 || attempts >= pullAttempts) break;
  }
  if (targetKeys) {
    const missing = replaySelectors
      .map(({ key }) => key)
      .filter(
      (key) => (foundTargetCounts.get(key) ?? 0) < (targetCounts.get(key) ?? 0),
    );
    if (missing.length) {
      await modifyDlqAckDeadline(
        received.flatMap(({ ackId }) => ackId ? [ackId] : []),
        0,
      );
      throw new Error(`DLQ replay selectors were not found in ${pullAttempts} pull attempts: ${missing.join(",")}`);
    }
    // A targeted batch is complete when every reviewed ID is present, even
    // though the subscription itself may still contain unrelated messages.
    replayComplete = true;
  }
} else {
  firestore = new Firestore({ projectId, databaseId: firestoreDatabaseId });
  if (apply) auditFirestore = new Firestore({ projectId, databaseId: auditDatabaseId });
  if (replaySelectors.length) {
    const snapshots = await firestore.getAll(
      ...replaySelectors.slice(0, maxMessages).map(({ eventId }) => firestore!.collection("event_outbox").doc(eventId)),
    );
    const foundSelectors = new Set<string>();
    for (const snapshot of snapshots) {
      if (!snapshot.exists || snapshot.get("status") !== "published") continue;
      try {
        const envelope = parseEventEnvelope(snapshot.get("envelope"));
        received.push({ route: "events", eventId: envelope.event_id, envelope });
        foundSelectors.add(`events:${envelope.event_id}`);
      } catch (error) {
        throw new Error(`Invalid stored event ${snapshot.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const missing = replaySelectors
      .map(({ key }) => key)
      .filter((key) => !foundSelectors.has(key));
    if (missing.length) {
      throw new Error(`Outbox replay selectors were not found or are not published: ${missing.join(",")}`);
    }
  } else if (!replayComplete) {
    // A completed checkpoint is retained as an auditable receipt. A resumed
    // run starts strictly after the last published_at/document-id tuple and
    // paginates until its per-run cap, so large outbox ranges cannot silently
    // stop at the first 1,000 documents.
    while (received.length < maxMessages) {
      const requested = Math.min(pageSize, maxMessages - received.length);
      let query = firestore
        .collection("event_outbox")
        .where("published_at", ">=", effectiveSince)
        .where("published_at", "<=", effectiveUntil)
        .orderBy("published_at", "asc")
        .orderBy(FieldPath.documentId(), "asc")
        .limit(requested);
      if (replayCursor) query = query.startAfter(replayCursor.publishedAt, replayCursor.eventId);
      const page = await query.get();
      if (!page.docs.length) {
        replayComplete = true;
        break;
      }
      for (const snapshot of page.docs) {
        replayCursor = {
          publishedAt: String(snapshot.get("published_at") ?? ""),
          eventId: snapshot.id,
        };
        if (!snapshot.exists || snapshot.get("status") !== "published") continue;
        try {
          const envelope = parseEventEnvelope(snapshot.get("envelope"));
          received.push({ route: "events", eventId: envelope.event_id, envelope });
        } catch (error) {
          throw new Error(`Invalid stored event ${snapshot.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (received.length >= maxMessages) break;
      }
      if (page.docs.length < requested) {
        replayComplete = true;
        break;
      }
      if (received.length >= maxMessages) {
        replayComplete = false;
        break;
      }
      // A full page can still contain non-published rows. Keep walking until
      // the event cap or the range's end is reached.
    }
  } else {
    // Nothing remains after a previously completed range.
    replayComplete = true;
  }
}

const summary = {
  run_id: runId,
  environment: replayEnvironment,
  subscription: subscriptionName,
  topic: topicName,
  screening_topic: dlqTarget?.screeningTopic,
  source,
  count: received.length,
  mode: apply ? "apply" : "dry-run",
  event_ids: received.map(({ eventId }) => eventId),
  routes: received.map(({ eventId, route, sourceSubscription }) => ({ event_id: eventId, route, source_subscription: sourceSubscription })),
  selectors: received.map(({ eventId, route }) => `${route}:${eventId}`),
  authority_database: source === "outbox" ? firestoreDatabaseId : undefined,
  restore_database: restoreDatabaseId,
  complete: replayComplete,
  cursor: replayCursor,
  since: source === "outbox" ? effectiveSince : undefined,
  until: source === "outbox" ? effectiveUntil : undefined,
};
console.log(JSON.stringify(summary));

if (apply && received.length) {
  if (apply && source === "dlq" && received.some(({ ackId }) => !ackId)) {
    throw new Error("DLQ replay cannot apply a message without an acknowledgement ID.");
  }
  if (source === "dlq") {
    const ackIds = received.flatMap(({ ackId }) => ackId ? [ackId] : []);
    // Pub/Sub leases are short-lived by default. Extend the bounded batch to
    // the service maximum and renew every 30 seconds while publishing and
    // recording the receipt, otherwise a slow replay could acknowledge an
    // expired lease and redeliver an apparently successful batch.
    await modifyDlqAckDeadline(ackIds, 600);
    dlqLeaseTimer = setInterval(() => {
      void modifyDlqAckDeadline(ackIds, 600).catch((error: unknown) => {
        dlqLeaseHealthy = false;
        console.error(JSON.stringify({
          event: "replay.dlq_lease_renewal_failed",
          message: error instanceof Error ? error.message : String(error),
        }));
      });
    }, 30_000);
    dlqLeaseTimer.unref?.();
  }
  for (const replayEvent of received) {
    const envelope = replayEvent.envelope;
    const screeningJob = replayEvent.screeningJob;
    const meshId = envelope?.mesh_id ?? screeningJob?.mesh_id ?? null;
    const replayTopic = replayEvent.route === "moderation-screening" ? screeningTopic : topic;
    await replayTopic.publishMessage({
      data: Buffer.from(replayPayload(replayEvent)),
      orderingKey: meshId ?? "system",
      attributes: {
        event_id: replayEvent.eventId,
        mesh_id: meshId ?? "",
        type: replayEvent.route,
      },
    });
  }
}

if (apply && auditFirestore) {
  const cumulativeReplayed = (replayCheckpoint?.replayed ?? 0) + received.length;
  const cursorKey = replayCursor
    ? `${replayCursor.publishedAt}:${replayCursor.eventId}`
    : "empty";
  const pageDigest = createHash("sha256")
    .update(`${runId}:${source}:${replayEnvironment ?? ""}:${cursorKey}:${received.map(({ eventId, route }) => `${route}:${eventId}`).join(",")}:${received.length}:${replayComplete}`)
    .digest("hex")
    .slice(0, 32);
  // Each applied page is an immutable audit event. A final completion receipt
  // gets its own deterministic ID, so a resumed run cannot leave the first
  // page's `complete:false` status as the only durable record.
  const auditId = source === "outbox"
    ? (replayComplete ? `audit_replay_${runId}_complete` : `audit_replay_${runId}_page_${pageDigest}`)
    : `audit_dlq_replay_${runId}_${pageDigest}`;
  const audit = {
    contract_version: 1,
    audit_id: auditId,
    actor_type: "system",
    actor_id: "replay-tool",
    session_id: null,
    action: "events.replayed",
    resource_type: source === "outbox" ? "event_outbox" : "pubsub_dead_letter",
    resource_id: runId,
    data: {
      run_id: runId,
      environment: replayEnvironment ?? null,
      source,
      count: received.length,
      complete: replayComplete,
      cumulative_replayed: cumulativeReplayed,
      since: source === "outbox" ? effectiveSince : null,
      until: source === "outbox" ? effectiveUntil : null,
      cursor: replayCursor,
      last_event_id: received.at(-1)?.eventId ?? null,
      event_ids: received.map(({ eventId }) => eventId),
      routes: received.map(({ eventId, route, sourceSubscription }) => ({
        event_id: eventId,
        route,
        source_subscription: sourceSubscription ?? null,
      })),
      selectors: received.map(({ eventId, route }) => `${route}:${eventId}`),
      authority_database: source === "outbox" ? firestoreDatabaseId : null,
      restore_database: restoreDatabaseId ?? null,
    },
    created_at: new Date().toISOString(),
    retention_at: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1_000),
  };
  try {
    await auditFirestore.collection("audit_events").doc(auditId).create(audit);
  } catch (error) {
    // A resumed run reuses its run ID and therefore its immutable audit ID.
    // Treat an existing receipt as success; surface all other failures.
    if ((error as { code?: number }).code !== 6) throw error;
  }
}

// DLQ acknowledgements happen only after every event has been republished and
// the immutable receipt exists. If either operation fails, the messages stay
// available for a bounded retry; downstream consumers deduplicate event IDs.
if (apply && source === "dlq") {
  try {
    if (!dlqLeaseHealthy) throw new Error("DLQ lease renewal failed; refusing to acknowledge the replay batch.");
    if (received.length) {
      await subscriber.acknowledge({
        subscription,
        ackIds: received.flatMap(({ ackId }) => ackId ? [ackId] : []),
      });
    }
    console.log(JSON.stringify({ acknowledged: received.length }));
  } finally {
    if (dlqLeaseTimer) clearInterval(dlqLeaseTimer);
  }
} else if (apply && source === "outbox" && received.length) {
  console.log(JSON.stringify({ replayed: received.length }));
}

// Advance the local cursor only after the page has been published and its
// immutable receipt has been recorded. If the checkpoint write fails, the page
// will be safely republished on retry rather than becoming an unaudited hole.
if (source === "outbox" && checkpointPath && apply) {
  const checkpoint: ReplayCheckpoint = {
    version: 2,
    runId,
    source,
    environment: replayEnvironment!,
    authorityDatabase: dlqTarget!.authorityDatabase,
    restoreDatabase: restoreDatabaseId ?? null,
    eventTopic: topicName,
    auditDatabase: auditDatabaseId!,
    since: effectiveSince,
    until: effectiveUntil,
    cursor: replayCursor,
    complete: replayComplete,
    updatedAt: new Date().toISOString(),
    replayed: (replayCheckpoint?.replayed ?? 0) + received.length,
  };
  const temporaryPath = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, checkpointPath);
}

await subscriber.close();
await pubsub.close();
if (firestore) await firestore.terminate();
if (auditFirestore && auditFirestore !== firestore) await auditFirestore.terminate();
