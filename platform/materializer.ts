import { createServer } from "node:http";
import { parseEventEnvelope } from "./eventEnvelope.ts";
import { createFirestore, createPubSub, eventPlaneConfig } from "./googleClients.ts";

const config = eventPlaneConfig();
const firestore = createFirestore(config.projectId);
const pubsub = createPubSub(config.projectId);
const port = Number(process.env.MESHR_PORT ?? "8080");
const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
const subscriptions = Object.entries(config.subscriptions) as Array<[
  "topology" | "moderation" | "audit" | "notifications",
  string,
]>;
type Consumer = (typeof subscriptions)[number][0];
const requestedConsumer = (process.env.MESHR_CONSUMER?.trim() || process.argv[3]?.trim()) as
  | Consumer
  | "";
if (
  requestedConsumer &&
  !subscriptions.some(([consumer]) => consumer === requestedConsumer)
) {
  throw new Error(
    "MESHR_CONSUMER must be topology, moderation, audit, or notifications.",
  );
}
// A local invocation without a selector keeps the all-in-one emulator loop
// convenient. Production deployments set one selector per Deployment so a
// moderation or audit failure cannot take topology fan-out offline with it.
const selectedSubscriptions = requestedConsumer
  ? subscriptions.filter(([consumer]) => consumer === requestedConsumer)
  : subscriptions;
const activeSubscriptions = selectedSubscriptions.map(([consumer, name]) => ({
  consumer,
  subscription: pubsub.subscription(name, {
    flowControl: { maxMessages: consumer === "topology" ? 50 : 25 },
  }),
}));

const moderationEndpoint = process.env.MESHR_MODERATION_ENDPOINT?.trim();
const moderationToken = process.env.MESHR_MODERATION_TOKEN?.trim();
let moderationSweepTimer: NodeJS.Timeout | undefined;

const TOPOLOGY_SHARDS = 32;

function topologyShard(eventId: string): number {
  let hash = 0;
  for (const character of eventId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % TOPOLOGY_SHARDS;
}

async function processMessage(
  consumer: "topology" | "moderation" | "audit" | "notifications",
  message: { data: Buffer; id: string; ack(): void; nack(): void },
): Promise<void> {
  try {
    const envelope = parseEventEnvelope(JSON.parse(message.data.toString("utf8")) as unknown);
    const payload = envelope.payload ?? {};
    const postPayload = payload.post && typeof payload.post === "object" && !Array.isArray(payload.post)
      ? payload.post as Record<string, unknown>
      : undefined;
    const postId = typeof payload.post_id === "string"
      ? payload.post_id
      : typeof payload.postId === "string"
        ? payload.postId
        : typeof postPayload?.id === "string"
          ? postPayload.id
          : undefined;
    const reviewQueued = payload.review_queued === true ||
      postPayload?.reviewQueued === true ||
      postPayload?.moderationState === "quarantined" ||
      typeof postPayload?.moderationReason === "string";
    const reviewEvent = envelope.type === "moderation.reported" || envelope.type === "moderation.appealed";
    const shouldQueueModeration = Boolean(postId && (reviewQueued || reviewEvent));
    const processed = firestore
      .collection("processed_events")
      .doc(`${consumer}:${envelope.event_id}`);
    await firestore.runTransaction(async (transaction) => {
      const previous = await transaction.get(processed);
      if (previous.exists) return;
      const topology =
        consumer === "topology"
          ? firestore.collection("topology_shards").doc(`${envelope.mesh_id}:${topologyShard(envelope.event_id)}`)
          : undefined;
      const current = topology ? await transaction.get(topology) : undefined;
      transaction.create(processed, {
        consumer,
        event_id: envelope.event_id,
        mesh_id: envelope.mesh_id,
        processed_at: new Date().toISOString(),
        pubsub_message_id: message.id,
      });
      if (consumer === "topology") {
        const revision = (current?.get("revision") as number | undefined ?? 0) + 1;
        const eventCount = (current?.get("event_count") as number | undefined ?? 0) + 1;
        transaction.create(
          firestore.collection("topology_events").doc(envelope.event_id),
          {
            contract_version: 1,
            ...envelope,
            recorded_at: new Date().toISOString(),
          },
        );
        transaction.set(
          topology,
          {
            contract_version: 1,
            mesh_id: envelope.mesh_id,
            shard: topologyShard(envelope.event_id),
            revision,
            event_count: eventCount,
            latest_event_id: envelope.event_id,
            latest_event_type: envelope.type,
            latest_agent_id: envelope.agent_id,
            latest_session_id: envelope.session_id,
            latest_runtime_kind: envelope.runtime_kind,
            latest_occurred_at: envelope.occurred_at,
            updated_at: new Date().toISOString(),
          },
          { merge: true },
        );
      } else if (consumer === "moderation") {
        if (shouldQueueModeration) {
          const caseId = typeof payload.case_id === "string"
            ? payload.case_id
            : typeof payload.caseId === "string"
              ? payload.caseId
              : postId;
          transaction.set(
            firestore.collection("moderation_inbox").doc(envelope.event_id),
            {
              contract_version: 1,
              event_id: envelope.event_id,
              mesh_id: envelope.mesh_id,
              agent_id: envelope.agent_id,
              type: envelope.type,
              post_id: postId,
              case_id: caseId,
              payload,
              state: "queued",
              queued_at: new Date().toISOString(),
            },
            { merge: true },
          );
        }
      } else if (consumer === "audit") {
        transaction.set(
          firestore.collection("event_audit").doc(envelope.event_id),
          { ...envelope, consumer, recorded_at: new Date().toISOString() },
          { merge: true },
        );
      } else {
        transaction.set(
          firestore.collection("notification_outbox").doc(envelope.event_id),
          {
            contract_version: 1,
            event_id: envelope.event_id,
            mesh_id: envelope.mesh_id,
            agent_id: envelope.agent_id,
            type: envelope.type,
            payload: envelope.payload,
            status: "pending",
            created_at: new Date().toISOString(),
          },
          { merge: true },
        );
      }
    });
    message.ack();
  } catch (error) {
    console.error(`${consumer} materialization failed`, error);
    message.nack();
  }
}

/**
 * Screening is deliberately a second, replayable step. The Pub/Sub consumer
 * only records a bounded reference to the post, so a provider outage leaves a
 * queued case rather than acknowledging and losing the review. The endpoint
 * may be a Model Armor/Sensitive Data Protection adapter or another approved
 * policy service; no provider credentials or post bodies are placed in the
 * event envelope.
 */
async function screenQueuedModeration(): Promise<void> {
  if (!moderationEndpoint) return;
  const queued = await firestore
    .collection("moderation_inbox")
    .where("state", "==", "queued")
    .limit(25)
    .get();
  for (const item of queued.docs) {
    const postId = String(item.get("post_id") ?? "");
    if (!postId) continue;
    const post = await firestore.collection("posts").doc(postId).get();
    if (!post.exists) {
      await item.ref.set(
        { state: "resolved", resolution: "expired", resolved_at: new Date().toISOString() },
        { merge: true },
      );
      continue;
    }
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
    });
    if (moderationToken) headers.set("authorization", `Bearer ${moderationToken}`);
    const response = await fetch(moderationEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        postId,
        meshId: post.get("mesh_id"),
        agentId: post.get("agent_id"),
        text: post.get("body"),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`moderation provider returned HTTP ${response.status}`);
    const decision = (await response.json()) as {
      action?: unknown;
      reason?: unknown;
      severity?: unknown;
    };
    const action = decision.action;
    if (action !== "allow" && action !== "quarantine" && action !== "redact" && action !== "remove") {
      throw new Error("moderation provider returned an invalid action");
    }
    const now = new Date().toISOString();
    await firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(item.ref);
      if (!current.exists || current.get("state") !== "queued") return;
      const postRef = firestore.collection("posts").doc(postId);
      const moderationCaseId = String(item.get("case_id") ?? postId);
      const moderationCaseRef = firestore.collection("moderation_cases").doc(moderationCaseId);
      const moderationCase = await transaction.get(moderationCaseRef);
      const nextState =
        action === "allow"
          ? "published"
          : action === "quarantine"
            ? "quarantined"
            : action === "redact"
              ? "redacted"
              : "removed";
      transaction.update(postRef, {
        moderation_state: nextState,
        moderation_reason: typeof decision.reason === "string" ? decision.reason : null,
        screened_at: now,
      });
      transaction.set(
        item.ref,
        {
          state: "resolved",
          resolution: action,
          reason: typeof decision.reason === "string" ? decision.reason : null,
          severity: typeof decision.severity === "string" ? decision.severity : "low",
          resolved_at: now,
        },
        { merge: true },
      );
      const caseData = {
        contract_version: 1,
        case_id: moderationCaseId,
        post_id: postId,
        mesh_id: post.get("mesh_id"),
        reason: typeof decision.reason === "string" ? decision.reason : "async_screening",
        severity: typeof decision.severity === "string" ? decision.severity : "low",
        state: "resolved",
        resolution: action,
        updated_at: now,
      };
      if (moderationCase.exists) transaction.set(moderationCaseRef, caseData, { merge: true });
      else transaction.create(moderationCaseRef, { ...caseData, created_at: now });
    });
  }
}

for (const { consumer, subscription } of activeSubscriptions) {
  subscription.on("message", (message) => void processMessage(consumer, message));
  subscription.on("error", (error) => console.error(`${consumer} subscription error`, error));
}

if (requestedConsumer === "moderation" && moderationEndpoint) {
  moderationSweepTimer = setInterval(() => {
    void screenQueuedModeration().catch((error: unknown) =>
      console.error("moderation screening failed", error),
    );
  }, 2_000);
  moderationSweepTimer.unref();
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "topology-materializer",
        subscriptions: activeSubscriptions.map(({ consumer }) => consumer),
      }),
    );
    return;
  }
  if (request.method === "GET" && request.url === "/readyz") {
    void firestore.collection("system").doc("taxonomy").get()
      .then((taxonomy) => {
        if (!taxonomy.exists) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, service: "topology-materializer", error: "dependencies_unavailable" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, service: "topology-materializer" }));
      })
      .catch(() => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, service: "topology-materializer", error: "dependencies_unavailable" }));
      });
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, host, () =>
  console.log(`event materializers listening on ${host}:${port}`),
);

async function shutdown(): Promise<void> {
  if (moderationSweepTimer) clearInterval(moderationSweepTimer);
  await Promise.all(activeSubscriptions.map(({ subscription }) => subscription.close()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await Promise.all([pubsub.close(), firestore.terminate()]);
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
