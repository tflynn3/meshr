import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ZodError } from "zod";
import { parseEventEnvelope, sameEvent, type EventEnvelope } from "./eventEnvelope.ts";
import { createFirestore, createPubSub, eventPlaneConfig } from "./googleClients.ts";

const MAX_BODY_BYTES = 64 * 1024;
const port = Number(process.env.MESHR_PORT ?? "8080");
const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
const basePath = (process.env.MESHR_BASE_PATH?.trim() || "").replace(/\/$/, "");
const internalToken = process.env.MESHR_INTERNAL_TOKEN?.trim();
if (!internalToken) throw new Error("MESHR_INTERNAL_TOKEN is required.");

const config = eventPlaneConfig();
const firestore = createFirestore(config.projectId);
const pubsub = createPubSub(config.projectId);
const topic = pubsub.topic(config.topicName, { messageOrdering: true });
const inFlight = new Set<string>();

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
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
  return firestore.runTransaction(async (transaction) => {
    const existing = await transaction.get(reference);
    if (existing.exists) {
      const stored = existing.get("envelope") as EventEnvelope;
      if (!sameEvent(stored, envelope)) throw new Error("event_id_conflict");
      return "existing";
    }
    transaction.create(reference, {
      envelope,
      status: "pending",
      attempts: 0,
      created_at: new Date().toISOString(),
    });
    return "created";
  });
}

async function publishPending(eventId: string): Promise<void> {
  if (inFlight.has(eventId)) return;
  inFlight.add(eventId);
  const reference = firestore.collection("event_outbox").doc(eventId);
  try {
    const snapshot = await reference.get();
    if (!snapshot.exists || snapshot.get("status") === "published") return;
    const envelope = snapshot.get("envelope") as EventEnvelope;
    const messageId = await topic.publishMessage({
      data: Buffer.from(JSON.stringify(envelope)),
      orderingKey: envelope.mesh_id,
      attributes: {
        event_id: envelope.event_id,
        mesh_id: envelope.mesh_id,
        type: envelope.type,
      },
    });
    await reference.update({
      status: "published",
      pubsub_message_id: messageId,
      published_at: new Date().toISOString(),
      attempts: (snapshot.get("attempts") as number | undefined ?? 0) + 1,
      last_error: null,
    });
  } catch (error) {
    await reference.set(
      {
        attempts: 1,
        last_attempt_at: new Date().toISOString(),
        last_error: error instanceof Error ? error.message : String(error),
      },
      { merge: true },
    );
    throw error;
  } finally {
    inFlight.delete(eventId);
  }
}

async function retryPending(): Promise<void> {
  const pending = await firestore
    .collection("event_outbox")
    .where("status", "==", "pending")
    .limit(50)
    .get();
  await Promise.allSettled(pending.docs.map((document) => publishPending(document.id)));
}

const retryTimer = setInterval(() => void retryPending(), 2_000);
retryTimer.unref();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const path = basePath && url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length) || "/"
      : url.pathname;
    if (request.method === "GET" && path === "/healthz") {
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
      await publishPending(envelope.event_id);
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
