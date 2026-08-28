import assert from "node:assert/strict";
import test from "node:test";
import { MeshStore } from "../src/domain/meshStore.ts";
import { seedState } from "../src/domain/seed.ts";
import { projectMeshTopology } from "../src/domain/topology.ts";

const now = "2026-08-27T20:20:00.000Z";

test("an empty mesh has no traffic links", () => {
  const store = new MeshStore({
    initialState: structuredClone(seedState),
    now: () => now,
    makeId: (() => {
      let id = 0;
      return () => `empty-${++id}`;
    })(),
  });
  const { mesh } = store.createMesh({
    actingOwnerId: "owner-theo",
    name: "Invariant Circle",
    visibility: "private",
    joinPolicy: "invite_only",
    initialAgentIds: ["agent-euclid", "agent-bramble"],
  });

  const topology = projectMeshTopology(store.getSnapshot(), {
    connectedAgentId: "agent-euclid",
    meshId: mesh.id,
    now,
  });

  assert.equal(topology.meshes[0]?.messageCount, 0);
  assert.deepEqual(topology.meshes[0]?.trafficLinks, []);
});

test("traffic links are derived from actual cross-agent replies", () => {
  const topology = projectMeshTopology(structuredClone(seedState), {
    connectedAgentId: "agent-bramble",
    meshId: "mesh-garden-circle",
    now,
  });
  const links = topology.meshes[0]?.trafficLinks ?? [];

  assert.equal(links.length, 3);
  assert.deepEqual(
    links.map((link) => ({
      source: link.sourceAgentId,
      target: link.targetAgentId,
      conversations: link.conversationIds,
      count: link.eventCount,
      recent: link.recentEventCount,
      rate: link.messagesPerMinute,
      delay: link.medianDelayMs,
      processor: link.processor,
    })),
    [
      {
        source: "agent-willow",
        target: "agent-bramble",
        conversations: ["topic-native-shade"],
        count: 1,
        recent: 1,
        rate: 0.1,
        delay: 120_000,
        processor: "reply-path",
      },
      {
        source: "agent-hearth",
        target: "agent-bramble",
        conversations: ["topic-native-shade"],
        count: 1,
        recent: 1,
        rate: 0.1,
        delay: 240_000,
        processor: "reply-path",
      },
      {
        source: "agent-bramble",
        target: "agent-hearth",
        conversations: ["topic-irrigation"],
        count: 1,
        recent: 1,
        rate: 0.1,
        delay: 180_000,
        processor: "reply-path",
      },
    ],
  );
});

test("traffic rates become zero outside the observation window", () => {
  const topology = projectMeshTopology(structuredClone(seedState), {
    connectedAgentId: "agent-bramble",
    meshId: "mesh-garden-circle",
    now: "2026-08-27T21:20:00.000Z",
  });

  for (const link of topology.meshes[0]?.trafficLinks ?? []) {
    assert.equal(link.recentEventCount, 0);
    assert.equal(link.messagesPerMinute, 0);
    assert.notEqual(link.lastEventAt, "2026-08-27T21:20:00.000Z");
  }
});
