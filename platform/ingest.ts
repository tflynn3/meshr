import { timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
} from "@google-cloud/firestore";
import { ZodError } from "zod";
import { parseEventEnvelope, sameEvent, type EventEnvelope } from "./eventEnvelope.ts";
import { createFirestore, createPubSub, eventPlaneConfig } from "./googleClients.ts";
import { loadRuntimeSecrets } from "./runtimeSecrets.ts";

loadRuntimeSecrets();
const MAX_BODY_BYTES = 64 * 1024;
const port = Number(process.env.MESHR_PORT ?? "8080");
const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
const basePath = (process.env.MESHR_BASE_PATH?.trim() || "").replace(/\/$/, "");
const internalToken = process.env.MESHR_INTERNAL_TOKEN?.trim();
if (!internalToken) throw new Error("MESHR_INTERNAL_TOKEN is required.");

const config = eventPlaneConfig();
const firestore = createFirestore(config.projectId, config.databaseId);
const pubsub = createPubSub(config.projectId);
const MESHR_CONTRACT_MAJOR = "1";
const topic = pubsub.topic(config.topicName, { messageOrdering: true });
const PUBLISH_LEASE_SECONDS = 30;
const MAX_PUBLISH_BATCH = 200;
const MIN_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 600;
const OUTBOX_READY_COLLECTION = "event_outbox_ready";
const READY_DISCOVERY_PAGE_SIZE = 500;
const READY_NEWEST_PAGE_SIZE = 200;
const LEGACY_DISCOVERY_INTERVAL_MS = 10_000;
const OUTBOX_READY_SHARDS = 32;

// Keep ready-marker sharding deterministic across API and event-plane
// writers. The shard is a discovery hint only; per-mesh ordering still comes
// from the ordering key used by the publisher.
function readyDiscoveryShard(eventId: string): number {
  let hash = 0;
  for (const character of eventId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % OUTBOX_READY_SHARDS;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-meshr-contract-version": MESHR_CONTRACT_MAJOR,
  });
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(internalToken!);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function storeEvent(envelope: EventEnvelope): Promise<"created" | "existing"> {
  const reference = firestore.collection("event_outbox").doc(envelope.event_id);
  const orderingKey = envelope.mesh_id ?? "system";
  const readyReference = firestore.collection(OUTBOX_READY_COLLECTION).doc(envelope.event_id);
  return firestore.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);
    if (existing.exists) {
      const stored = existing.get("envelope") as EventEnvelope;
      if (!sameEvent(stored, envelope)) throw new Error("event_id_conflict");
      return "existing";
    }
    transaction.create(reference, {
      contract_version: 1,
      envelope,
      mesh_id: envelope.mesh_id,
      event_id: envelope.event_id,
      status: "pending",
      attempts: 0,
      created_at: new Date().toISOString(),
      // Do not attach a TTL while delivery is pending. Accepted writes must
      // remain replayable until Pub/Sub acknowledges them; the publisher adds
      // the retention timestamp only after the durable publish succeeds.
    });
    transaction.set(
      readyReference,
      {
        contract_version: 1,
        event_id: envelope.event_id,
        mesh_id: envelope.mesh_id ?? null,
        ordering_key: orderingKey,
        ready_shard: readyDiscoveryShard(envelope.event_id),
        status: "pending",
        next_attempt_at: envelope.occurred_at,
        created_at: envelope.occurred_at,
        updated_at: envelope.occurred_at,
      },
      { merge: true },
    );
    return "created";
  });
}

interface ClaimedEvent {
  envelope: EventEnvelope;
  leaseId: string;
  attempts: number;
}

interface ClaimedBatchEvent extends ClaimedEvent {
  eventId: string;
  orderingKey: string;
  readyRef?: DocumentReference;
}

const orderingInFlight = new Set<string>();

async function claimPendingBatch(orderingKey: string): Promise<ClaimedBatchEvent[]> {
  const now = new Date();
  const meshValue = orderingKey === "system" ? null : orderingKey;
  return firestore.runTransaction(async (transaction) => {
    // Ready markers are immutable, one-per-event discovery records. They
    // avoid a write-hot per-mesh head while preserving a single ordered
    // publisher for each mesh. Include legacy raw outbox rows so a rolling
    // deployment drains records created before the marker schema shipped.
    const [readyCandidates, legacyCandidates] = await Promise.all([
      transaction.get(
        firestore
          .collection(OUTBOX_READY_COLLECTION)
          .where("ordering_key", "==", orderingKey)
          .where("status", "in", ["pending", "failed", "processing"])
          .orderBy("created_at", "asc")
          .limit(MAX_PUBLISH_BATCH + 25),
      ),
      transaction.get(
        firestore
          .collection("event_outbox")
          .where("mesh_id", "==", meshValue)
          .where("status", "in", ["pending", "failed"])
          .orderBy("created_at", "asc")
          .limit(MAX_PUBLISH_BATCH + 25),
      ),
    ]);
    const readyEvents = await Promise.all(
      readyCandidates.docs.map(async (ready) => ({
        ready,
        event: await transaction.get(firestore.collection("event_outbox").doc(ready.id)),
      })),
    );
    const candidateById = new Map<string, { event: DocumentSnapshot; ready?: DocumentSnapshot }>();
    for (const candidate of readyEvents) {
      if (candidate.event.exists) candidateById.set(candidate.event.id, candidate);
    }
    for (const event of legacyCandidates.docs) {
      if (!candidateById.has(event.id)) candidateById.set(event.id, { event });
    }
    const ordered = [...candidateById.values()]
      .sort((left, right) =>
        String(left.event.get("created_at") ?? "").localeCompare(String(right.event.get("created_at") ?? "")) ||
        left.event.id.localeCompare(right.event.id),
      );
    const selected: Array<{ event: DocumentSnapshot; ready?: DocumentSnapshot }> = [];
    for (const candidate of ordered) {
      const document = candidate.event;
      const ready = candidate.ready;
      const leaseUntil = document.get("lease_until") ?? ready?.get("lease_until");
      // A marker may briefly outlive its outbox row update if a publisher
      // crashed between the two writes. Do not republish an already-published
      // event; simply heal the marker while holding the same transaction.
      if (document.get("status") === "published") {
        if (ready && ready.get("status") !== "published") {
          transaction.update(ready.ref, {
            status: "published",
            updated_at: now.toISOString(),
          });
        }
        continue;
      }
      if (leaseUntil && Date.parse(String(leaseUntil)) > now.getTime()) break;
      if (document.get("status") === "failed" || ready?.get("status") === "failed") {
        const nextAttemptAt = document.get("next_attempt_at") ?? ready?.get("next_attempt_at");
        if (nextAttemptAt && Date.parse(String(nextAttemptAt)) > now.getTime()) break;
      }
      selected.push(candidate);
      if (selected.length >= MAX_PUBLISH_BATCH) break;
    }
    if (!selected.length) return [];
    const leaseUntil = new Date(now.getTime() + PUBLISH_LEASE_SECONDS * 1_000).toISOString();
    const leaseIds = selected.map(() => randomUUID());
    for (let index = 0; index < selected.length; index += 1) {
      const candidate = selected[index]!;
      const document = candidate.event;
      const ready = candidate.ready;
      transaction.update(document.ref, {
        lease_id: leaseIds[index],
        lease_until: leaseUntil,
        last_attempt_at: now.toISOString(),
      });
      if (ready) {
        transaction.update(ready.ref, {
          status: "processing",
          lease_id: leaseIds[index],
          lease_until: leaseUntil,
          updated_at: now.toISOString(),
        });
      }
    }
    return selected.map((candidate, index) => ({
      eventId: candidate.event.id,
      orderingKey,
      envelope: candidate.event.get("envelope") as EventEnvelope,
      leaseId: leaseIds[index]!,
      attempts: Number(candidate.event.get("attempts") ?? 0),
      readyRef: candidate.ready?.ref,
    }));
  });
}

/*
 * Publish a claimed batch and atomically advance both the authoritative
 * outbox row and its ready marker. Pub/Sub invocation order remains the
 * ordering guarantee; Firestore leases only prevent duplicate claims.
 */
async function publishOrderingKey(orderingKey: string): Promise<void> {
  if (orderingInFlight.has(orderingKey)) return;
  orderingInFlight.add(orderingKey);
  let claimed: ClaimedBatchEvent[] = [];
  try {
    claimed = await claimPendingBatch(orderingKey);
    if (!claimed.length) return;
    const results = await Promise.all(
      claimed.map(async (event) => {
        try {
          const messageId = await topic.publishMessage({
            data: Buffer.from(JSON.stringify(event.envelope)),
            orderingKey,
            attributes: {
              event_id: event.envelope.event_id,
              mesh_id: event.envelope.mesh_id ?? "",
              type: event.envelope.type,
            },
          });
          return { event, messageId, error: undefined as unknown };
        } catch (error) {
          return { event, messageId: undefined, error };
        }
      }),
    );
    const publishedIds = new Set(results.filter((result) => !result.error).map((result) => result.event.eventId));
    const failures = results.filter((result) => result.error);
    const failureMessage = failures[0]?.error;
    await firestore.runTransaction(async (transaction) => {
      const snapshots = await Promise.all(
        claimed.map((event) => transaction.get(firestore.collection("event_outbox").doc(event.eventId))),
      );
      const readySnapshots = await Promise.all(
        claimed.map((event) => event.readyRef ? transaction.get(event.readyRef) : Promise.resolve(undefined)),
      );
      for (let index = 0; index < claimed.length; index += 1) {
        const event = claimed[index]!;
        const snapshot = snapshots[index]!;
        if (!snapshot.exists || snapshot.get("lease_id") !== event.leaseId) continue;
        const ready = readySnapshots[index];
        if (publishedIds.has(event.eventId)) {
          const result = results[index]!;
          const publishedAt = new Date().toISOString();
          const retentionAt = Timestamp.fromMillis(Date.now() + 30 * 24 * 60 * 60 * 1_000);
          transaction.update(snapshot.ref, {
            status: "published",
            pubsub_message_id: result.messageId,
            published_at: publishedAt,
            retention_at: retentionAt,
            attempts: event.attempts + 1,
            last_error: null,
            lease_id: null,
            lease_until: null,
            next_attempt_at: null,
          });
          if (ready?.exists) transaction.update(ready.ref, {
            status: "published",
            published_at: publishedAt,
            retention_at: retentionAt,
            attempts: event.attempts + 1,
            lease_id: null,
            lease_until: null,
            next_attempt_at: null,
            updated_at: publishedAt,
          });
        } else {
          const error = results[index]!.error;
          const attempts = event.attempts + 1;
          const retrySeconds = Math.min(
            MAX_RETRY_SECONDS,
            MIN_RETRY_SECONDS * 2 ** Math.min(attempts - 1, 10),
          );
          const nextAttemptAt = new Date(Date.now() + retrySeconds * 1_000).toISOString();
          transaction.update(snapshot.ref, {
            status: "failed",
            attempts,
            last_error: error instanceof Error ? error.message : String(error),
            next_attempt_at: nextAttemptAt,
            lease_id: null,
            lease_until: null,
          });
          if (ready?.exists) transaction.update(ready.ref, {
            status: "failed",
            attempts,
            last_error: error instanceof Error ? error.message : String(error),
            next_attempt_at: nextAttemptAt,
            lease_id: null,
            lease_until: null,
            updated_at: new Date().toISOString(),
          });
        }
      }
    });
    if (failureMessage) topic.resumePublishing(orderingKey);
  } catch (error) {
    if (claimed.length) topic.resumePublishing(orderingKey);
    console.error(JSON.stringify({
      component: "meshr-ingest",
      event: "outbox_batch_publish_failed",
      ordering_key: orderingKey,
      error: error instanceof Error ? error.message : String(error),
    }));
    throw error;
  } finally {
    orderingInFlight.delete(orderingKey);
  }
}


let retryInProgress = false;
let orderingKeyCache: { expiresAt: number; keys: string[] } | undefined;
// Recovery uses one globally ordered cursor plus a bounded newest-page probe.
// The old implementation queried 32 shards in both directions every second;
// two replicas therefore issued 130 Firestore queries/sec while idle. A
// global cursor preserves eventual fairness, while the newest probe keeps a
// fresh write visible within the one-second sweep even when an older outage
// backlog is large. Cursors are process-local because markers are durable; a
// restart simply begins another bounded pass from the oldest page.
let readyDiscoveryCursor: DocumentSnapshot | undefined;
let legacyDiscoveryAt = 0;

async function retryPending(): Promise<void> {
  if (retryInProgress) return;
  retryInProgress = true;
  try {
    // Discover keys through a globally ordered ready-marker page and a newest
    // page probe. Normal ingest writes also trigger an immediate publish
    // attempt, so recovery fairness does not delay fresh traffic.
    if (!orderingKeyCache || orderingKeyCache.expiresAt <= Date.now()) {
      let oldestQuery = firestore
        .collection(OUTBOX_READY_COLLECTION)
        .where("status", "in", ["pending", "failed", "processing"])
        .orderBy("created_at", "asc")
        .limit(READY_DISCOVERY_PAGE_SIZE);
      if (readyDiscoveryCursor) oldestQuery = oldestQuery.startAfter(readyDiscoveryCursor);
      const probes: [Promise<any>, Promise<any>] = [
        oldestQuery.get(),
        // Always sample the newest page so a fresh write is discovered even
        // while the cursor is walking an outage backlog.
        firestore
          .collection(OUTBOX_READY_COLLECTION)
          .where("status", "in", ["pending", "failed", "processing"])
          .orderBy("created_at", "desc")
          .limit(READY_NEWEST_PAGE_SIZE)
          .get(),
      ];
      const [oldest, newest] = await Promise.all(probes);
      const readyPages = [oldest, newest];
      readyDiscoveryCursor = oldest.docs.length >= READY_DISCOVERY_PAGE_SIZE
        ? oldest.docs[oldest.docs.length - 1]
        : undefined;
      const keys = new Set<string>(["system"]);
      for (const page of readyPages) {
        for (const marker of page.docs) {
          const orderingKey = marker.get("ordering_key");
          if (typeof orderingKey === "string" && orderingKey) keys.add(orderingKey);
          else {
            const meshId = marker.get("mesh_id");
            keys.add(typeof meshId === "string" && meshId ? meshId : "system");
          }
        }
      }
      // Keep a slow raw-outbox fallback while rolling deployments drain rows
      // created before ready markers existed. It is intentionally not part of
      // the hot one-second path once the marker schema is established.
      if (Date.now() - legacyDiscoveryAt >= LEGACY_DISCOVERY_INTERVAL_MS) {
        legacyDiscoveryAt = Date.now();
        const pending = await firestore
          .collection("event_outbox")
          .where("status", "in", ["pending", "failed"])
          .orderBy("created_at", "asc")
          .limit(500)
          .get();
        for (const event of pending.docs) {
          const meshId = event.get("mesh_id");
          keys.add(typeof meshId === "string" && meshId ? meshId : "system");
        }
      }
      orderingKeyCache = { expiresAt: Date.now() + 900, keys: [...keys] };
    }
    await Promise.all(
      orderingKeyCache.keys.map(async (orderingKey) => {
        try {
          await publishOrderingKey(orderingKey);
        } catch {
          // The durable failure state is recorded by publishOrderingKey. Keep
          // other ordering keys moving during a provider outage.
        }
      }),
    );
  } finally {
    retryInProgress = false;
  }
}

// A one-second sweep catches events written by non-HTTP repository paths. The
// globally ordered marker cursor keeps recovery fair without a per-shard query
// storm; normal writes also trigger an immediate publish attempt from the HTTP
// ingest path.
const retryTimer = setInterval(() => {
  void retryPending().catch((error) => {
    console.error(JSON.stringify({
      component: "meshr-ingest",
      event: "outbox_sweep_failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}, 1_000);
retryTimer.unref();

const server = createServer(async (request, response) => {
  const suppliedRequestId = request.headers["x-request-id"];
  const requestId =
    typeof suppliedRequestId === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();
  response.setHeader("X-Request-Id", requestId);
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const path = basePath && url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length) || "/"
      : url.pathname;
    const suppliedContractVersion = request.headers["x-meshr-contract-version"];
    if (suppliedContractVersion !== undefined &&
        (typeof suppliedContractVersion !== "string" ||
          suppliedContractVersion.trim() !== MESHR_CONTRACT_MAJOR)) {
      json(response, 426, {
        error: {
          code: "incompatible_contract",
          message: `This Meshr ingest service requires contract major ${MESHR_CONTRACT_MAJOR}; upgrade the client integration.`,
        },
      });
      return;
    }
    if (request.method === "GET" && path === "/healthz") {
      json(response, 200, { ok: true, service: "ingest" });
      return;
    }
    if (request.method === "GET" && path === "/readyz") {
      const taxonomy = await firestore.collection("system").doc("taxonomy").get();
      const [topicExists] = await topic.exists();
      if (!taxonomy.exists || !topicExists) {
        json(response, 503, { ok: false, service: "ingest", error: "dependencies_unavailable" });
        return;
      }
      json(response, 200, { ok: true, service: "ingest" });
      return;
    }
    if (!authorized(request)) {
      json(response, 401, { error: { code: "internal_authentication_required" } });
      return;
    }
    const match = /^\/v1\/events\/([A-Za-z0-9._:-]+)$/.exec(path);
    if (request.method === "GET" && match) {
      const snapshot = await firestore.collection("event_outbox").doc(match[1]).get();
      if (!snapshot.exists) {
        json(response, 404, { error: { code: "event_not_found" } });
        return;
      }
      json(response, 200, { id: snapshot.id, ...snapshot.data() });
      return;
    }
    if (request.method === "POST" && path === "/v1/events") {
      const envelope = parseEventEnvelope(await readBody(request));
      const outcome = await storeEvent(envelope);
      // Durability is acknowledged by storeEvent. Publishing is retried by
      // the fair per-mesh sweep so a Pub/Sub blip cannot turn an accepted
      // event into a client-visible failure or serialize the HTTP path.
      void publishOrderingKey(envelope.mesh_id ?? "system").catch((error: unknown) => {
        console.error(JSON.stringify({
          component: "meshr-ingest",
          event: "outbox_async_publish_failed",
          request_id: requestId,
          event_id: envelope.event_id,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
      console.log(JSON.stringify({
        component: "meshr-ingest",
        event: "event.accepted",
        request_id: requestId,
        event_id: envelope.event_id,
        mesh_id: envelope.mesh_id,
        agent_id: envelope.agent_id,
        session_id: envelope.session_id,
        runtime_kind: envelope.runtime_kind,
        duplicate: outcome === "existing",
      }));
      json(response, outcome === "created" ? 202 : 200, {
        accepted: true,
        duplicate: outcome === "existing",
        event_id: envelope.event_id,
      });
      return;
    }
    json(response, 404, { error: { code: "not_found" } });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      json(response, 400, { error: { code: "invalid_event", message: error.message } });
    } else if (error instanceof Error && error.message === "body_too_large") {
      json(response, 413, { error: { code: "body_too_large" } });
    } else if (error instanceof Error && error.message.startsWith("event_payload_too_large:")) {
      json(response, 413, { error: { code: "event_payload_too_large", message: error.message } });
    } else if (error instanceof Error && error.message === "event_id_conflict") {
      json(response, 409, { error: { code: "event_id_conflict" } });
    } else {
      console.error(error);
      json(response, 503, { error: { code: "event_ingest_unavailable" } });
    }
  }
});

server.listen(port, host, () => console.log(`ingest listening on ${host}:${port}`));

async function shutdown(): Promise<void> {
  clearInterval(retryTimer);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await Promise.all([pubsub.close(), firestore.terminate()]);
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
