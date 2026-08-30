import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseEventEnvelope, type EventEnvelope } from "./eventEnvelope.ts";
import { createPubSub, eventPlaneConfig } from "./googleClients.ts";
import { loadRuntimeSecrets } from "./runtimeSecrets.ts";

loadRuntimeSecrets();

const MESHR_CONTRACT_MAJOR = "1";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PUBLISH_BATCH = 200;
const PUBLISH_LEASE_SECONDS = 30;
const port = Number(process.env.MESHR_PORT ?? "8080");
const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
const basePath = (process.env.MESHR_BASE_PATH?.trim() || "").replace(/\/$/, "");
const internalToken = process.env.MESHR_INTERNAL_TOKEN?.trim();
const apiUrl = process.env.MESHR_API_URL?.trim();
if (!internalToken) throw new Error("MESHR_INTERNAL_TOKEN is required.");
if (!apiUrl) throw new Error("MESHR_API_URL is required.");

const config = eventPlaneConfig();
const pubsub = createPubSub(config.projectId);
const topic = pubsub.topic(config.topicName, { messageOrdering: true });
const claimUrl = new URL("/internal/v1/outbox/claim", apiUrl).toString();
const completeUrl = new URL("/internal/v1/outbox/complete", apiUrl).toString();
const eventUrl = new URL("/internal/v1/outbox/events", apiUrl).toString();
const apiReadyUrl = new URL("/readyz", apiUrl).toString();

interface OutboxClaim {
  eventId: string;
  leaseId: string;
  orderingKey: string;
  attempts: number;
  envelope: EventEnvelope;
}

interface OutboxCompletion {
  eventId: string;
  leaseId: string;
  outcome: "published" | "failed";
  messageId?: string;
  error?: string;
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

async function apiRequest(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Meshr-Contract-Version": MESHR_CONTRACT_MAJOR,
      Authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error && typeof payload.error === "object"
      ? payload.error as Record<string, unknown>
      : {};
    throw new Error(`authority_api_${response.status}:${String(error.code ?? "request_failed")}`);
  }
  return payload;
}

function parseClaims(payload: Record<string, unknown>): OutboxClaim[] {
  if (!Array.isArray(payload.claims) || payload.claims.length > MAX_PUBLISH_BATCH) {
    throw new Error("authority_api_invalid_claims");
  }
  return payload.claims.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`authority_api_invalid_claim:${index}`);
    }
    const claim = raw as Record<string, unknown>;
    if (
      typeof claim.eventId !== "string" || typeof claim.leaseId !== "string" ||
      typeof claim.orderingKey !== "string" || !Number.isSafeInteger(claim.attempts)
    ) throw new Error(`authority_api_invalid_claim:${index}`);
    const envelope = parseEventEnvelope(claim.envelope);
    const expectedOrderingKey = envelope.mesh_id ?? "system";
    if (claim.eventId !== envelope.event_id || claim.orderingKey !== expectedOrderingKey) {
      throw new Error(`authority_api_claim_mismatch:${claim.eventId}`);
    }
    return {
      eventId: claim.eventId,
      leaseId: claim.leaseId,
      orderingKey: claim.orderingKey,
      attempts: Number(claim.attempts),
      envelope,
    };
  });
}

async function publishClaims(claims: OutboxClaim[]): Promise<OutboxCompletion[]> {
  const groups = new Map<string, OutboxClaim[]>();
  for (const claim of claims) {
    const group = groups.get(claim.orderingKey) ?? [];
    group.push(claim);
    groups.set(claim.orderingKey, group);
  }
  const completed = await Promise.all([...groups.entries()].map(async ([orderingKey, group]) => {
    // Invoke publishes in the repository order. The ordered Pub/Sub client
    // serializes messages with the same key while independent meshes proceed
    // concurrently.
    const publications = group.map(async (claim): Promise<OutboxCompletion> => {
      try {
        const messageId = await topic.publishMessage({
          data: Buffer.from(JSON.stringify(claim.envelope)),
          orderingKey,
          attributes: {
            event_id: claim.envelope.event_id,
            mesh_id: claim.envelope.mesh_id ?? "",
            type: claim.envelope.type,
          },
        });
        return { eventId: claim.eventId, leaseId: claim.leaseId, outcome: "published", messageId };
      } catch (error) {
        return {
          eventId: claim.eventId,
          leaseId: claim.leaseId,
          outcome: "failed",
          error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
        };
      }
    });
    const results = await Promise.all(publications);
    if (results.some((result) => result.outcome === "failed")) topic.resumePublishing(orderingKey);
    return results;
  }));
  return completed.flat();
}

let sweepInProgress = false;
async function sweep(): Promise<void> {
  if (sweepInProgress) return;
  sweepInProgress = true;
  try {
    const claims = parseClaims(await apiRequest(claimUrl, {
      maxEvents: MAX_PUBLISH_BATCH,
      leaseSeconds: PUBLISH_LEASE_SECONDS,
    }));
    if (!claims.length) return;
    const results = await publishClaims(claims);
    await apiRequest(completeUrl, { results });
    const failures = results.filter((result) => result.outcome === "failed");
    console.log(JSON.stringify({
      component: "meshr-ingest",
      event: "outbox_batch_completed",
      claimed: claims.length,
      published: results.length - failures.length,
      failed: failures.length,
    }));
  } finally {
    sweepInProgress = false;
  }
}

function reportSweepFailure(error: unknown, requestId?: string): void {
  console.error(JSON.stringify({
    component: "meshr-ingest",
    event: "outbox_sweep_failed",
    ...(requestId ? { request_id: requestId } : {}),
    error: error instanceof Error ? error.message : String(error),
  }));
}

function startSweep(requestId?: string): void {
  void sweep().catch((error) => reportSweepFailure(error, requestId));
}

const retryTimer = setInterval(() => {
  startSweep();
}, 1_000);
retryTimer.unref();

const server = createServer(async (request, response) => {
  const suppliedRequestId = request.headers["x-request-id"];
  const requestId = typeof suppliedRequestId === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(suppliedRequestId)
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
        (typeof suppliedContractVersion !== "string" || suppliedContractVersion.trim() !== MESHR_CONTRACT_MAJOR)) {
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
      const [api, topicState] = await Promise.all([
        fetch(apiReadyUrl, { signal: AbortSignal.timeout(5_000) }),
        topic.exists(),
      ]);
      if (!api.ok || !topicState[0]) {
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
    // Backward-compatible local/operator injection. The ingest process merely
    // forwards the envelope to the authoritative API; it never persists or
    // publishes caller-supplied bytes directly.
    if (request.method === "POST" && path === "/v1/events") {
      const envelope = parseEventEnvelope(await readBody(request));
      const result = await apiRequest(eventUrl, envelope);
      startSweep(requestId);
      json(response, result.duplicate === true ? 200 : 202, result);
      return;
    }
    json(response, 404, { error: { code: "not_found" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SyntaxError || /invalid_type|invalid_format|unrecognized_keys/i.test(message)) {
      json(response, 400, { error: { code: "invalid_event", message } });
    } else if (message === "body_too_large" || message.startsWith("event_payload_too_large:")) {
      json(response, 413, { error: { code: "event_payload_too_large", message } });
    } else if (message.includes("authority_api_409:event_id_conflict")) {
      json(response, 409, { error: { code: "event_id_conflict" } });
    } else {
      console.error(JSON.stringify({
        component: "meshr-ingest",
        event: "request_failed",
        request_id: requestId,
        error: message,
      }));
      json(response, 503, { error: { code: "event_ingest_unavailable" } });
    }
  }
});

server.listen(port, host, () => {
  console.log(`ingest listening on ${host}:${port}`);
  startSweep();
});

async function shutdown(): Promise<void> {
  clearInterval(retryTimer);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pubsub.close();
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
