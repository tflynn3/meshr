import { FieldPath, Firestore, Timestamp } from "@google-cloud/firestore";
import { PubSub, v1 } from "@google-cloud/pubsub";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { parseEventEnvelope, type EventEnvelope } from "../platform/eventEnvelope.ts";

const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim();
const source = process.env.MESHR_REPLAY_SOURCE?.trim().toLowerCase() || "dlq";
const databaseId = process.env.MESHR_FIRESTORE_DATABASE?.trim();
const subscriptionName = process.env.MESHR_DLQ_SUBSCRIPTION?.trim() || "mesh-events-dlq-replay";
const topicName = process.env.MESHR_EVENTS_TOPIC?.trim() || "mesh-events";
const maxMessages = Math.max(1, Math.min(Number(process.env.MESHR_REPLAY_MAX ?? "100"), 1_000));
const pageSize = Math.max(1, Math.min(Number(process.env.MESHR_REPLAY_PAGE_SIZE ?? "100"), 1_000));
const apply = process.env.MESHR_REPLAY_APPLY === "1";
const since = process.env.MESHR_REPLAY_SINCE?.trim();
const until = process.env.MESHR_REPLAY_UNTIL?.trim();
const checkpointPath = process.env.MESHR_REPLAY_CHECKPOINT?.trim();
const eventIds = (process.env.MESHR_REPLAY_EVENT_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!projectId || /^(?:PROJECT_ID|\$\{[^}]+\})$/i.test(projectId)) {
  throw new Error("GOOGLE_CLOUD_PROJECT is required for DLQ replay.");
}
if (source !== "dlq" && source !== "outbox") {
  throw new Error("MESHR_REPLAY_SOURCE must be dlq or outbox.");
}
if (source === "outbox" && !databaseId) {
  throw new Error("MESHR_FIRESTORE_DATABASE is required for outbox replay.");
}
if (source === "outbox" && eventIds.length > maxMessages) {
  throw new Error(
    `MESHR_REPLAY_EVENT_IDS contains ${eventIds.length} IDs, above MESHR_REPLAY_MAX=${maxMessages}; increase the cap or split the reviewed set explicitly.`,
  );
}

const subscriber = new v1.SubscriberClient({ projectId });
const pubsub = new PubSub({ projectId });
const subscription = subscriber.subscriptionPath(projectId, subscriptionName);
const topic = pubsub.topic(topicName, { messageOrdering: true });

interface ReplayEvent {
  envelope: EventEnvelope;
  ackId?: string;
}

interface ReplayCursor {
  publishedAt: string;
  eventId: string;
}

interface ReplayCheckpoint {
  version: 1;
  runId: string;
  source: "outbox";
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

const received: ReplayEvent[] = [];
let firestore: Firestore | undefined;
let replayCursor: ReplayCursor | null = null;
// A Pub/Sub Pull response has no backlog watermark. An under-filled response
// therefore cannot prove that a DLQ is empty; expose that uncertainty instead
// of issuing a false completion receipt.
let replayComplete: boolean | "unknown" = source === "dlq" ? "unknown" : eventIds.length > 0;
let replayCheckpoint: ReplayCheckpoint | undefined;
const defaultSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
const defaultUntil = new Date().toISOString();
if (checkpointPath) {
  try {
    const raw = JSON.parse(await readFile(checkpointPath, "utf8")) as Partial<ReplayCheckpoint>;
    if (
      raw.version !== 1 || raw.source !== "outbox" || typeof raw.runId !== "string" ||
      typeof raw.since !== "string" || typeof raw.until !== "string" ||
      (raw.cursor !== null && raw.cursor !== undefined &&
        (typeof raw.cursor !== "object" || typeof raw.cursor.publishedAt !== "string" || typeof raw.cursor.eventId !== "string"))
    ) {
      throw new Error("invalid replay checkpoint");
    }
    if (source !== raw.source) throw new Error("replay checkpoint source mismatch");
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
  const [response] = await subscriber.pull({
    subscription,
    maxMessages,
    returnImmediately: false,
  });
  const pulled = response.receivedMessages ?? [];
  // Pull has no total-count metadata. A page that fills the requested cap is
  // definitely incomplete; an under-filled non-empty page is deliberately
  // `unknown` because Pub/Sub may return fewer messages while backlog remains.
  // Only an empty response is treated as a point-in-time empty observation.
  replayComplete = pulled.length === 0 ? true : pulled.length < maxMessages ? "unknown" : false;
  for (const item of pulled) {
    const ackId = item.ackId;
    if (!ackId || !item.message) continue;
    const data = messageData(item.message.data);
    const envelope = parseEventEnvelope(JSON.parse(data.toString("utf8")) as unknown);
    received.push({ ackId, envelope });
  }
} else {
  firestore = new Firestore({ projectId, databaseId });
  if (eventIds.length) {
    const snapshots = await firestore.getAll(
      ...eventIds.slice(0, maxMessages).map((id) => firestore!.collection("event_outbox").doc(id)),
    );
    for (const snapshot of snapshots) {
      if (!snapshot.exists || snapshot.get("status") !== "published") continue;
      try {
        received.push({ envelope: parseEventEnvelope(snapshot.get("envelope")) });
      } catch (error) {
        throw new Error(`Invalid stored event ${snapshot.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
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
          received.push({ envelope: parseEventEnvelope(snapshot.get("envelope")) });
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
  subscription: subscriptionName,
  topic: topicName,
  source,
  count: received.length,
  mode: apply ? "apply" : "dry-run",
  event_ids: received.map(({ envelope }) => envelope.event_id),
  complete: replayComplete,
  cursor: replayCursor,
  since: source === "outbox" ? effectiveSince : undefined,
  until: source === "outbox" ? effectiveUntil : undefined,
};
console.log(JSON.stringify(summary));

if (apply && received.length) {
  for (const { envelope } of received) {
    await topic.publishMessage({
      data: Buffer.from(JSON.stringify(envelope)),
      orderingKey: envelope.mesh_id ?? "system",
      attributes: {
        event_id: envelope.event_id,
        mesh_id: envelope.mesh_id ?? "",
        type: envelope.type,
      },
    });
  }
  if (source === "dlq") {
    await subscriber.acknowledge({
      subscription,
      ackIds: received.flatMap(({ ackId }) => ackId ? [ackId] : []),
    });
    console.log(JSON.stringify({ acknowledged: received.length }));
  } else {
    console.log(JSON.stringify({ replayed: received.length }));
  }
}

if (apply && source === "outbox" && firestore) {
  const cumulativeReplayed = (replayCheckpoint?.replayed ?? 0) + received.length;
  const cursorKey = replayCursor
    ? `${replayCursor.publishedAt}:${replayCursor.eventId}`
    : "empty";
  const pageDigest = createHash("sha256")
    .update(`${runId}:${cursorKey}:${received.length}:${replayComplete}`)
    .digest("hex")
    .slice(0, 32);
  // Each applied page is an immutable audit event. A final completion receipt
  // gets its own deterministic ID, so a resumed run cannot leave the first
  // page's `complete:false` status as the only durable record.
  const auditId = replayComplete
    ? `audit_replay_${runId}_complete`
    : `audit_replay_${runId}_page_${pageDigest}`;
  const audit = {
    contract_version: 1,
    audit_id: auditId,
    actor_type: "system",
    actor_id: "replay-tool",
    session_id: null,
    action: "events.replayed",
    resource_type: "event_outbox",
    resource_id: runId,
    data: {
      run_id: runId,
      source,
      count: received.length,
      complete: replayComplete,
      cumulative_replayed: cumulativeReplayed,
      since: effectiveSince,
      until: effectiveUntil,
      cursor: replayCursor,
      last_event_id: received.at(-1)?.envelope.event_id ?? null,
    },
    created_at: new Date().toISOString(),
    retention_at: Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1_000),
  };
  try {
    await firestore.collection("audit_events").doc(auditId).create(audit);
  } catch (error) {
    // A resumed run reuses its run ID and therefore its immutable audit ID.
    // Treat an existing receipt as success; surface all other failures.
    if ((error as { code?: number }).code !== 6) throw error;
  }
}

// Advance the local cursor only after the page has been published and its
// immutable receipt has been recorded. If the checkpoint write fails, the page
// will be safely republished on retry rather than becoming an unaudited hole.
if (source === "outbox" && checkpointPath && apply) {
  const checkpoint: ReplayCheckpoint = {
    version: 1,
    runId,
    source,
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
