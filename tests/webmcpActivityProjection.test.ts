import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { RepositoryProjection } from "../server/repository.ts";
import { readWebMcpActivity } from "../server/webmcpActivity.ts";

test("WebMCP activity reads the shared topology projection", () => {
  const projection: RepositoryProjection = {
    accounts: [],
    agents: [
      {
        agentId: "agent-a",
        ownerAccountId: "account-1",
        name: "Aster",
        handle: "aster",
        tagline: "Connects ideas.",
        interests: ["Math"],
        personality: "Curious",
        attention: { browse: "public", rootPosts: "autonomous", replies: "autonomous" },
        runtime: "claude",
        runtimeLabel: "Claude",
        runtimeSubject: "claude:agent-a",
        publicKeyPem: "public-key",
        definitionDigest: null,
        createdAt: "2026-08-29T15:00:00.000Z",
        updatedAt: "2026-08-29T15:00:00.000Z",
      },
    ],
    meshes: [
      {
        meshId: "mesh-public",
        ownerAccountId: null,
        name: "Public Commons",
        description: "A shared place for observations.",
        visibility: "public",
        admission: "open",
        lifecycle: "active",
        createdAt: "2026-08-29T15:00:00.000Z",
        updatedAt: "2026-08-29T15:00:00.000Z",
      },
    ],
    topics: [
      {
        topicId: "topic-ideas",
        meshId: "mesh-public",
        name: "ideas",
        title: "Small discoveries",
        description: "Useful connections.",
        tags: ["cross-pollination"],
        createdAt: "2026-08-29T15:00:00.000Z",
      },
    ],
    humanRoles: [],
    memberships: [
      {
        meshId: "mesh-public",
        agentId: "agent-a",
        status: "joined",
        attentionPolicy: {},
        admissionProvenance: "open",
        joinedAt: "2026-08-29T15:00:00.000Z",
        updatedAt: "2026-08-29T15:00:00.000Z",
      },
    ],
    runtimeSessions: [],
    posts: [],
    activity: {
      meshes: [{
        meshId: "mesh-public",
        postCount: 3,
        rootCount: 2,
        replyCount: 1,
        recentPostCount: 3,
        lastActivityAt: "2026-08-29T15:02:00.000Z",
      }],
      topics: [{
        topicId: "topic-ideas",
        meshId: "mesh-public",
        postCount: 3,
        rootCount: 2,
        replyCount: 1,
        recentPostCount: 3,
        participantAgentIds: ["agent-a", "agent-b"],
        lastActivityAt: "2026-08-29T15:02:00.000Z",
      }],
      agents: [{
        agentId: "agent-a",
        meshId: "mesh-public",
        postCount: 2,
        lastPostAt: "2026-08-29T15:02:00.000Z",
      }],
      links: [{
        meshId: "mesh-public",
        sourceAgentId: "agent-a",
        targetAgentId: "agent-b",
        topicIds: ["topic-ideas"],
        eventCount: 1,
        recentEventCount: 1,
        delaySumMs: 3_000,
        delayCount: 1,
        delayBuckets: [0, 1],
        lastEventAt: "2026-08-29T15:02:00.000Z",
      }],
    },
    follows: [],
  };
  const db = new DatabaseSync(":memory:");
  const activity = readWebMcpActivity(db, {
    agentId: "agent-a",
    browse: "public",
    generatedAt: "2026-08-29T15:03:00.000Z",
    durableProjection: projection,
  });
  assert.equal(activity.meshes[0]?.messageCount, 3);
  assert.equal(activity.meshes[0]?.recentMessageCount, 3);
  assert.deepEqual(activity.meshes[0]?.conversations[0]?.participantAgentIds, ["agent-a", "agent-b"]);
  assert.equal(activity.meshes[0]?.trafficLinks[0]?.eventCount, 1);
  assert.equal(activity.meshes[0]?.trafficLinks[0]?.medianDelayMs, 3_000);
  db.close();
});
