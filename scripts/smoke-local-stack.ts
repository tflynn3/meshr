import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { WebSocket } from "ws";

const sameOriginBaseUrl = (process.env.MESHR_LOCAL_URL?.trim() || "http://localhost:8080")
  .replace(/\/+$/, "");
const componentUrl = (localName: string, genericName: string, fallback: string): string =>
  (process.env[localName]?.trim() || process.env[genericName]?.trim() || fallback)
    .replace(/\/+$/, "");
const apiBaseUrl = componentUrl("MESHR_LOCAL_API_URL", "MESHR_SMOKE_API_URL", sameOriginBaseUrl);
const webBaseUrl = componentUrl("MESHR_LOCAL_WEB_URL", "MESHR_SMOKE_WEB_URL", sameOriginBaseUrl);
const ingestBaseUrl = componentUrl(
  "MESHR_LOCAL_INGEST_URL",
  "MESHR_SMOKE_INGEST_URL",
  `${sameOriginBaseUrl}/__local/ingest`,
);
const liveBaseUrl = componentUrl("MESHR_LOCAL_LIVE_URL", "MESHR_SMOKE_LIVE_URL", sameOriginBaseUrl);
const webOrigin = new URL(webBaseUrl).origin;
const token = process.env.MESHR_LOCAL_INTERNAL_TOKEN?.trim();
assert.ok(token, "MESHR_LOCAL_INTERNAL_TOKEN must be supplied from the live Kubernetes Secret");
const meshId = "mesh-public";

async function json(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as Record<string, unknown>;
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function postEventWithRetry(
  url: string,
  headers: Record<string, string>,
  envelope: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
      });
      if (response.ok) return (await response.json()) as Record<string, unknown>;
      lastResponse = response;
      // A restarted ingress or event-plane client can briefly return a 5xx
      // after Kubernetes reports the pod ready. Reusing the same event ID is
      // safe because the ingest transaction is idempotent.
      if (![502, 503, 504].includes(response.status)) {
        return await json(response);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (lastResponse) return await json(lastResponse);
  throw new Error(`event ingest did not recover after restart: ${String(lastError)}`);
}

const health = await json(await fetch(`${apiBaseUrl}/healthz`));
assert.equal(health.status, "ok");
assert.equal(health.database, "ok");

const root = await fetch(`${webBaseUrl}/`);
assert.equal(root.status, 200);
assert.match(await root.text(), /<div id="root"><\/div>/);

for (const [path, expectedId] of [
  ["/schemas/agent-v0alpha1.json", "https://meshr.social/schemas/agent-v0alpha1.json"],
  [
    "/schemas/meshr/v1/contracts.schema.json",
    "https://meshr.social/schemas/meshr/v1/contracts.schema.json",
  ],
] as const) {
  const response = await fetch(`${webBaseUrl}${path}`);
  assert.equal(response.status, 200, `${path} was not published`);
  assert.match(response.headers.get("content-type") ?? "", /json/);
  const schema = (await response.json()) as Record<string, unknown>;
  assert.equal(schema.$id, expectedId, `${path} returned the application shell`);
}

const websocketUrl = new URL("/v1/live", liveBaseUrl.replace(/^http/, "ws"));
websocketUrl.searchParams.set("meshId", meshId);
const messages: Array<Record<string, unknown>> = [];
async function connectWebSocketWithRetry(url: URL): Promise<WebSocket> {
  let lastError: unknown;
  // Ingress controllers can retain a terminating gateway endpoint for a few
  // seconds after Kubernetes reports the rollout complete. Treat an upgrade
  // error (including a transient 502/504) as retryable so the restart smoke
  // proves recovery rather than racing endpoint propagation.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = new WebSocket(url, { origin: webOrigin });
    // Register the frame handler before waiting for `open`. The gateway can
    // send the initial snapshot immediately after the upgrade, so attaching
    // the handler only after this helper resolves would lose that first frame
    // during a fast post-rollout reconnect.
    candidate.on("message", (data) => {
      messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    const opened = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        candidate.removeListener("open", onOpen);
        candidate.removeListener("error", onError);
        resolve(value);
      };
      const onOpen = () => finish(true);
      const onError = (error: unknown) => {
        lastError = error;
        finish(false);
      };
      candidate.once("open", onOpen);
      candidate.once("error", onError);
      setTimeout(() => finish(false), 1_000).unref();
    });
    if (opened) return candidate;
    candidate.on("error", () => undefined);
    candidate.terminate();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`WebSocket upgrade did not recover after rollout: ${String(lastError)}`);
}

const socket = await connectWebSocketWithRetry(websocketUrl);

const initial = await new Promise<Record<string, unknown>>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("initial WebSocket snapshot timed out")), 10_000);
  const poll = setInterval(() => {
    const message = messages.shift();
    if (!message) return;
    clearInterval(poll);
    clearTimeout(timeout);
    resolve(message);
  }, 25);
});
assert.equal(initial.type, "topology.snapshot");
const initialSnapshot = initial.snapshot as Record<string, unknown> | null;
const beforeCount = Number(initialSnapshot?.event_count ?? 0);
const eventUrl = `${ingestBaseUrl}/v1/events`;
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
const replayFile = process.env.MESHR_LOCAL_SMOKE_REPLAY_FILE?.trim();
if (replayFile) {
  const replayArtifact = JSON.parse(readFileSync(replayFile, "utf8")) as {
    event?: Record<string, unknown>;
    eventCount?: unknown;
  };
  const replayEvent = replayArtifact.event;
  const replayEventId = typeof replayEvent?.event_id === "string" ? replayEvent.event_id : "";
  const replayEventCount = Number(replayArtifact.eventCount);
  assert.ok(replayEvent && replayEventId, "restart smoke artifact has no event envelope");
  assert.ok(Number.isSafeInteger(replayEventCount), "restart smoke artifact has no event count");
  assert.equal(
    initialSnapshot?.latest_event_id,
    replayEventId,
    "restart lost the latest materialized event",
  );
  assert.ok(
    Number(initialSnapshot?.event_count ?? 0) >= replayEventCount,
    "restart lost materialized event count",
  );
  const replayResponse = await postEventWithRetry(eventUrl, headers, replayEvent);
  assert.equal(replayResponse.duplicate, true, "restart lost event deduplication state");
  const replaySnapshotResponse = await json(await fetch(
    `${liveBaseUrl}/v1/live/snapshots/${meshId}`,
    { headers: { origin: webOrigin } },
  ));
  const replaySnapshot = replaySnapshotResponse.snapshot as Record<string, unknown> | null;
  assert.ok(replaySnapshot, "restart smoke returned no replay snapshot");
  assert.equal(
    Number(replaySnapshot.event_count ?? 0),
    beforeCount,
    "replaying the pre-restart event changed the materialized count",
  );
}

const now = new Date().toISOString();
const envelope = {
  event_id: `local-smoke-${randomUUID()}`,
  mesh_id: meshId,
  agent_id: "agent-local-smoke",
  type: "local.smoke",
  schema_version: 1,
  occurred_at: now,
  received_at: now,
  payload: { source: "scripts/smoke-local-stack.ts" },
};
const accepted = await postEventWithRetry(eventUrl, headers, envelope);
assert.equal(accepted.accepted, true);
assert.equal(accepted.duplicate, false);

const projected = await new Promise<Record<string, unknown>>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("materialized WebSocket update timed out")), 30_000);
  const poll = setInterval(() => {
    const message = messages.shift();
    if (!message) return;
    const snapshot = message.snapshot as Record<string, unknown> | null;
    if (snapshot?.latest_event_id !== envelope.event_id) return;
    clearInterval(poll);
    clearTimeout(timeout);
    resolve(snapshot);
  }, 25);
});
assert.equal(projected.event_count, beforeCount + 1);

const duplicate = await postEventWithRetry(eventUrl, headers, envelope);
assert.equal(duplicate.duplicate, true);

const snapshotResponse = await json(await fetch(
  `${liveBaseUrl}/v1/live/snapshots/${meshId}`,
  { headers: { origin: webOrigin } },
));
const snapshot = snapshotResponse.snapshot as Record<string, unknown> | null;
assert.ok(snapshot, "live snapshot endpoint returned no snapshot");
assert.equal(snapshot.latest_event_id, envelope.event_id);
assert.equal(snapshot.event_count, beforeCount + 1);
const eventFile = process.env.MESHR_LOCAL_SMOKE_EVENT_FILE?.trim();
if (eventFile) {
  writeFileSync(
    eventFile,
    JSON.stringify({ event: envelope, eventCount: snapshot.event_count }),
    { mode: 0o600 },
  );
}

socket.close(1000, "smoke complete");
console.log(
  JSON.stringify(
    {
      ok: true,
      event_id: envelope.event_id,
      revision: snapshotResponse.cursor,
      event_count: snapshot.event_count,
      duplicate_increment_prevented: true,
    },
    null,
    2,
  ),
);
