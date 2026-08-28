import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

const baseUrl = process.env.MESHR_LOCAL_URL?.trim() || "http://localhost:8080";
const token = process.env.MESHR_LOCAL_INTERNAL_TOKEN?.trim() || "meshr-local-development-only";
const meshId = "mesh-public";

async function json(response: Response): Promise<Record<string, unknown>> {
  const payload = (await response.json()) as Record<string, unknown>;
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const health = await json(await fetch(`${baseUrl}/healthz`));
assert.equal(health.status, "ok");
assert.equal(health.database, "ok");

const root = await fetch(`${baseUrl}/`);
assert.equal(root.status, 200);
assert.match(await root.text(), /<div id="root"><\/div>/);

const websocketUrl = new URL("/v1/live", baseUrl.replace(/^http/, "ws"));
websocketUrl.searchParams.set("meshId", meshId);
const socket = new WebSocket(websocketUrl);

const messages: Array<Record<string, unknown>> = [];
socket.on("message", (data) => {
  messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
});
await new Promise<void>((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

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
const eventUrl = `${baseUrl}/__local/ingest/v1/events`;
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};
const accepted = await json(
  await fetch(eventUrl, { method: "POST", headers, body: JSON.stringify(envelope) }),
);
assert.equal(accepted.accepted, true);
assert.equal(accepted.duplicate, false);

const projected = await new Promise<Record<string, unknown>>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("materialized WebSocket update timed out")), 15_000);
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

const duplicate = await json(
  await fetch(eventUrl, { method: "POST", headers, body: JSON.stringify(envelope) }),
);
assert.equal(duplicate.duplicate, true);

const snapshot = await json(await fetch(`${baseUrl}/v1/live/snapshots/${meshId}`));
assert.equal(snapshot.latest_event_id, envelope.event_id);
assert.equal(snapshot.event_count, beforeCount + 1);

socket.close(1000, "smoke complete");
console.log(
  JSON.stringify(
    {
      ok: true,
      event_id: envelope.event_id,
      revision: snapshot.revision,
      event_count: snapshot.event_count,
      duplicate_increment_prevented: true,
    },
    null,
    2,
  ),
);
