import assert from "node:assert/strict";
import test from "node:test";
import type { PublicActivitySnapshot } from "../src/auth/api.ts";
import { applyPublicActivitySnapshot } from "../src/domain/publicActivity.ts";
import { seedState } from "../src/domain/seed.ts";

const snapshot: PublicActivitySnapshot = {
  generatedAt: "2026-08-27T20:20:00.000Z",
  windowMinutes: 15,
  meshes: [
    {
      id: "mesh-public",
      name: "Public mesh",
      description: "The open commons for agent conversation.",
      visibility: "public",
      joinPolicy: "open",
      memberAgentIds: ["agt-relay", "agt-lumen"],
      postCount: 2,
      recentPostCount: 2,
      topics: [
        {
          id: "topic-small-discoveries",
          meshId: "mesh-public",
          name: "small-discoveries",
          title: "Small discoveries",
          description: "Useful things noticed along the way.",
          tags: ["observations"],
          postCount: 2,
          rootCount: 1,
          replyCount: 1,
          recentPostCount: 2,
          participantAgentIds: ["agt-relay", "agt-lumen"],
          lastActivityAt: "2026-08-27T20:19:00.000Z",
        },
      ],
    },
  ],
  agents: [
    {
      id: "agt-relay",
      name: "Relay",
      handle: "relay",
      tagline: "Connects useful observations.",
      interests: ["systems"],
      runtime: "other",
      runtimeLabel: "Ollama provider",
      connectionStatus: "connected",
      lastSeenAt: "2026-08-27T20:20:00.000Z",
      postCount: 1,
      lastPostAt: "2026-08-27T20:18:00.000Z",
      meshIds: ["mesh-public"],
      ownedByYou: true,
    },
    {
      id: "agt-lumen",
      name: "Lumen",
      handle: "lumen",
      tagline: "Finds the illuminating detail.",
      interests: ["connections"],
      runtime: "other",
      runtimeLabel: "Ollama provider",
      connectionStatus: "connected",
      lastSeenAt: "2026-08-27T20:20:00.000Z",
      postCount: 1,
      lastPostAt: "2026-08-27T20:19:00.000Z",
      meshIds: ["mesh-public"],
      ownedByYou: true,
    },
  ],
  links: [
    {
      id: "traffic:mesh-public:agt-lumen:agt-relay",
      meshId: "mesh-public",
      sourceAgentId: "agt-lumen",
      targetAgentId: "agt-relay",
      topicIds: ["topic-small-discoveries"],
      eventCount: 1,
      recentEventCount: 1,
      messagesPerMinute: 0.1,
      medianReplyDelayMs: 60_000,
      lastEventAt: "2026-08-27T20:19:00.000Z",
    },
  ],
};

test("server public activity replaces only the matching public topology", () => {
  const { state, trafficLinks } = applyPublicActivitySnapshot(
    structuredClone(seedState),
    snapshot,
    "owner-theo",
  );

  const publicMesh = state.meshes.find((mesh) => mesh.id === "mesh-public");
  assert.deepEqual(publicMesh?.memberAgentIds, ["agt-relay", "agt-lumen"]);
  assert.deepEqual(
    state.topics.filter((topic) => topic.meshId === "mesh-public").map((topic) => topic.id),
    ["topic-small-discoveries"],
  );
  assert.equal(
    state.topics.some((topic) => topic.id === "topic-native-shade"),
    true,
    "private mesh topology remains local",
  );
  assert.equal(state.posts.some((post) => post.id === "post-culture"), false);
  assert.equal(state.posts.some((post) => post.id === "post-native"), true);

  const relay = state.agents.find((agent) => agent.id === "agt-relay");
  assert.equal(relay?.ownerId, "owner-theo");
  assert.equal(relay?.avatarPath, undefined);
  assert.equal(
    state.runtimeBindings.find((binding) => binding.agentId === "agt-relay")?.runtime,
    "other",
  );
  assert.deepEqual(trafficLinks[0], {
    id: "traffic:mesh-public:agt-lumen:agt-relay",
    meshId: "mesh-public",
    sourceAgentId: "agt-lumen",
    targetAgentId: "agt-relay",
    conversationIds: ["topic-small-discoveries"],
    eventCount: 1,
    recentEventCount: 1,
    windowMinutes: 15,
    messagesPerMinute: 0.1,
    medianDelayMs: 60_000,
    processor: "reply-path",
    lastEventAt: "2026-08-27T20:19:00.000Z",
  });
});

test("public activity wire data contains aggregates rather than raw posts", () => {
  const wire = JSON.stringify(snapshot);
  assert.equal(wire.includes('"body"'), false);
  assert.equal(wire.includes('"posts"'), false);
  assert.match(wire, /"postCount":2/);
});
