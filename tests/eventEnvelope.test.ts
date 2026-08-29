import assert from "node:assert/strict";
import test from "node:test";
import { parseEventEnvelope, sameEvent } from "../platform/eventEnvelope.ts";

test("event envelopes are closed, versioned, and receive an ingest timestamp", () => {
  const event = parseEventEnvelope(
    {
      event_id: "evt-local-0001",
      mesh_id: "mesh-public",
      agent_id: "agent-euclid",
      type: "post.created",
      schema_version: 1,
      occurred_at: "2026-08-27T20:00:00.000Z",
      payload: { post_id: "post-1" },
    },
    new Date("2026-08-27T20:00:01.000Z"),
  );
  assert.equal(event.received_at, "2026-08-27T20:00:01.000Z");
  assert.equal(sameEvent(event, { ...event }), true);
});

test("event envelopes reject unknown authority-bearing fields", () => {
  assert.throws(() =>
    parseEventEnvelope({
      event_id: "evt-local-0002",
      mesh_id: "mesh-public",
      agent_id: "agent-euclid",
      type: "post.created",
      schema_version: 1,
      occurred_at: "2026-08-27T20:00:00.000Z",
      payload: {},
      credential: "must-not-pass",
    }),
  );
});

test("event envelopes reject Ollama as a runtime marker", () => {
  assert.throws(() =>
    parseEventEnvelope({
      event_id: "evt-local-ollama",
      mesh_id: "mesh-public",
      agent_id: "agent-relay",
      runtime_kind: "ollama",
      type: "post.created",
      schema_version: 1,
      occurred_at: "2026-08-27T20:00:00.000Z",
      payload: {},
    }),
  );
});

test("event envelopes require an explicit payload object", () => {
  assert.throws(() =>
    parseEventEnvelope({
      event_id: "evt-local-missing-payload",
      mesh_id: "mesh-public",
      agent_id: "agent-euclid",
      type: "post.created",
      schema_version: 1,
      occurred_at: "2026-08-27T20:00:00.000Z",
    }),
  );
});

test("receipt timestamps do not change event identity", () => {
  const original = parseEventEnvelope(
    {
      event_id: "evt-local-0003",
      mesh_id: "mesh-public",
      agent_id: "agent-euclid",
      type: "post.created",
      schema_version: 1,
      occurred_at: "2026-08-27T20:00:00.000Z",
      payload: { post_id: "post-3" },
    },
    new Date("2026-08-27T20:00:01.000Z"),
  );
  const retry = parseEventEnvelope(
    {
      event_id: "evt-local-0003",
      mesh_id: "mesh-public",
      agent_id: "agent-euclid",
      type: "post.created",
      schema_version: 1,
      occurred_at: "2026-08-27T20:00:00.000Z",
      payload: { post_id: "post-3" },
    },
    new Date("2026-08-27T20:01:00.000Z"),
  );

  assert.equal(sameEvent(original, retry), true);
  assert.equal(
    sameEvent(original, {
      ...retry,
      payload: { another_field: true, post_id: "post-3" },
    }),
    false,
  );
});
