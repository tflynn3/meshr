import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { MeshrDatabase } from "../server/database.ts";
import type { RepositoryProjection } from "../server/repository.ts";
import {
  readWebMcpActivity,
  WEBMCP_ACTIVITY_LIMITS,
} from "../server/webmcpActivity.ts";

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
        attention: {
          browse: "public",
          rootPosts: "autonomous",
          replies: "autonomous",
        },
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
      meshes: [
        {
          meshId: "mesh-public",
          postCount: 3,
          rootCount: 2,
          replyCount: 1,
          recentPostCount: 3,
          lastActivityAt: "2026-08-29T15:02:00.000Z",
        },
      ],
      topics: [
        {
          topicId: "topic-ideas",
          meshId: "mesh-public",
          postCount: 3,
          rootCount: 2,
          replyCount: 1,
          recentPostCount: 3,
          participantAgentIds: ["agent-a", "agent-b"],
          lastActivityAt: "2026-08-29T15:02:00.000Z",
        },
      ],
      agents: [
        {
          agentId: "agent-a",
          meshId: "mesh-public",
          postCount: 2,
          lastPostAt: "2026-08-29T15:02:00.000Z",
        },
      ],
      links: [
        {
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
        },
      ],
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
  assert.deepEqual(activity.meshes[0]?.conversations[0]?.participantAgentIds, [
    "agent-a",
    "agent-b",
  ]);
  assert.equal(activity.meshes[0]?.trafficLinks[0]?.eventCount, 1);
  assert.equal(activity.meshes[0]?.trafficLinks[0]?.medianDelayMs, 3_000);
  assert.deepEqual(activity.limits, WEBMCP_ACTIVITY_LIMITS);
  assert.deepEqual(activity.truncated, {
    responseBytes: false,
    meshes: false,
    conversations: false,
    participants: false,
    trafficLinks: false,
    metadata: false,
  });
  db.close();
});

test("WebMCP activity bounds attacker-controlled model context", () => {
  const timestamp = "2026-08-29T15:00:00.000Z";
  const meshCount = WEBMCP_ACTIVITY_LIMITS.meshes + 2;
  const topicsPerMesh = WEBMCP_ACTIVITY_LIMITS.conversationsPerMesh + 2;
  const participantsPerTopic =
    WEBMCP_ACTIVITY_LIMITS.participantsPerConversation + 2;
  const linksPerMesh = WEBMCP_ACTIVITY_LIMITS.trafficLinksPerMesh + 2;
  const meshes = Array.from({ length: meshCount }, (_, meshIndex) => ({
    meshId: `mesh-${String(meshIndex).padStart(3, "0")}`,
    ownerAccountId: null,
    name: `Mesh ${meshIndex}`,
    description: "m".repeat(500),
    visibility: "public" as const,
    admission: "open" as const,
    lifecycle: "active" as const,
    createdAt: new Date(Date.parse(timestamp) + meshIndex).toISOString(),
    updatedAt: timestamp,
  }));
  const topics = meshes.flatMap((mesh, meshIndex) =>
    Array.from({ length: topicsPerMesh }, (_, topicIndex) => ({
      topicId: `topic-${String(meshIndex).padStart(3, "0")}-${String(topicIndex).padStart(3, "0")}`,
      meshId: mesh.meshId,
      name: `topic-${topicIndex}`,
      title: `Topic ${topicIndex}`,
      description: "t".repeat(500),
      tags: Array.from({ length: 12 }, () => "x".repeat(32)),
      createdAt: new Date(
        Date.parse(timestamp) + meshIndex * topicsPerMesh + topicIndex,
      ).toISOString(),
    })),
  );
  const participantIds = Array.from(
    { length: participantsPerTopic },
    (_, index) => `agent-${String(index).padStart(3, "0")}-${"a".repeat(110)}`,
  );
  const projection: RepositoryProjection = {
    accounts: [],
    agents: [],
    meshes,
    topics: [...topics].reverse(),
    humanRoles: [],
    memberships: meshes.flatMap((mesh) =>
      Array.from(
        { length: WEBMCP_ACTIVITY_LIMITS.participantsPerMesh + 2 },
        (_, index) => ({
          meshId: mesh.meshId,
          agentId: `member-${String(index).padStart(3, "0")}-${"b".repeat(109)}`,
          status: "joined" as const,
          attentionPolicy: {},
          admissionProvenance: "open" as const,
          joinedAt: timestamp,
          updatedAt: timestamp,
        }),
      ),
    ),
    runtimeSessions: [],
    posts: [],
    activity: {
      meshes: [],
      topics: [...topics].reverse().map((topic) => ({
        topicId: topic.topicId,
        meshId: topic.meshId,
        postCount: 1,
        rootCount: 1,
        replyCount: 0,
        recentPostCount: 1,
        participantAgentIds: participantIds,
        lastActivityAt: timestamp,
      })),
      agents: [],
      links: meshes.flatMap((mesh, meshIndex) =>
        Array.from({ length: linksPerMesh }, (_, linkIndex) => ({
          meshId: mesh.meshId,
          sourceAgentId: `source-${String(linkIndex).padStart(3, "0")}-${"s".repeat(109)}`,
          targetAgentId: `target-${String(linkIndex).padStart(3, "0")}-${"d".repeat(109)}`,
          topicIds: topics
            .filter((topic) => topic.meshId === mesh.meshId)
            .map((topic) => topic.topicId),
          eventCount: meshIndex + linkIndex + 1,
          recentEventCount: 1,
          delaySumMs: 1_000,
          delayCount: 1,
          delayBuckets: [0, 1],
          lastEventAt: timestamp,
        })).reverse(),
      ),
    },
    follows: [],
  };
  const db = new DatabaseSync(":memory:");
  const activity = readWebMcpActivity(db, {
    agentId: "agent-reader",
    browse: "public",
    generatedAt: "2026-08-29T15:03:00.000Z",
    durableProjection: projection,
  });

  assert.ok(
    Buffer.byteLength(JSON.stringify(activity)) <=
      WEBMCP_ACTIVITY_LIMITS.responseBytes,
  );
  assert.ok(activity.meshes.length <= WEBMCP_ACTIVITY_LIMITS.meshes);
  assert.equal(activity.meshes[0]?.conversations[0]?.id, "topic-000-000");
  assert.match(
    activity.meshes[0]?.trafficLinks[0]?.sourceAgentId ?? "",
    /^source-000-/,
  );
  for (const mesh of activity.meshes) {
    assert.ok(
      mesh.conversations.length <= WEBMCP_ACTIVITY_LIMITS.conversationsPerMesh,
    );
    assert.ok(
      mesh.participantAgentIds.length <=
        WEBMCP_ACTIVITY_LIMITS.participantsPerMesh,
    );
    assert.ok(
      mesh.trafficLinks.length <= WEBMCP_ACTIVITY_LIMITS.trafficLinksPerMesh,
    );
    for (const conversation of mesh.conversations) {
      assert.ok(
        conversation.participantAgentIds.length <=
          WEBMCP_ACTIVITY_LIMITS.participantsPerConversation,
      );
    }
    for (const link of mesh.trafficLinks) {
      assert.ok(
        link.conversationIds.length <=
          WEBMCP_ACTIVITY_LIMITS.conversationsPerTrafficLink,
      );
    }
  }
  assert.equal(activity.truncated.meshes, true);
  assert.equal(activity.truncated.responseBytes, true);
  assert.equal(activity.truncated.conversations, true);
  assert.equal(activity.truncated.participants, true);
  assert.equal(activity.truncated.trafficLinks, true);
  db.close();
});

test("SQLite activity saturation retains newest traffic", () => {
  const database = new MeshrDatabase({ path: ":memory:", seed: false });
  const db = database.sqlite;
  const oldTimestamp = "2026-08-28T15:00:00.000Z";
  const recentTimestamp = "2026-08-29T15:02:00.000Z";
  const generatedAt = "2026-08-29T15:03:00.000Z";
  db.prepare(
    `INSERT INTO accounts(id, email, display_name, password_hash, created_at)
     VALUES('account-1', 'owner@example.test', 'Owner', 'unused', ?)`,
  ).run(oldTimestamp);
  const insertAgent = db.prepare(
    `INSERT INTO agents(
       id, owner_account_id, name, handle, tagline, interests_json,
       personality, attention_json, runtime, runtime_label, runtime_subject,
       public_key_pem, created_at, updated_at
     ) VALUES(?, 'account-1', ?, ?, '', '[]', '', ?, 'local', 'Local', ?, '', ?, ?)`,
  );
  for (const agentId of [
    "agent-reader",
    "agent-old",
    "agent-new",
    "agent-target",
  ]) {
    insertAgent.run(
      agentId,
      agentId,
      agentId,
      JSON.stringify({ browse: "public" }),
      `local:${agentId}`,
      oldTimestamp,
      oldTimestamp,
    );
  }
  db.prepare(
    `INSERT INTO meshes(
       id, owner_account_id, name, description, visibility, join_policy,
       lifecycle, created_at, updated_at
     ) VALUES('mesh-1', NULL, 'Mesh', '', 'public', 'open', 'active', ?, ?)`,
  ).run(oldTimestamp, oldTimestamp);
  db.prepare(
    `INSERT INTO topics(id, mesh_id, name, title, description, tags_json, created_at)
     VALUES('topic-1', 'mesh-1', 'general', 'General', '', '[]', ?)`,
  ).run(oldTimestamp);
  db.prepare(
    `INSERT INTO mesh_members(mesh_id, agent_id, joined_at)
     VALUES('mesh-1', 'agent-reader', ?)`,
  ).run(oldTimestamp);
  const insertPost = db.prepare(
    `INSERT INTO posts(
       id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at,
       moderation_state, session_id
     ) VALUES(?, 'mesh-1', 'topic-1', ?, ?, '', ?, 'published', 'session')`,
  );
  insertPost.run("root", "agent-target", null, oldTimestamp);
  database.transaction(() => {
    for (let index = 0; index < 1_500; index += 1) {
      insertPost.run(
        `old-reply-${String(index).padStart(4, "0")}`,
        "agent-old",
        "root",
        oldTimestamp,
      );
    }
    insertPost.run("recent-reply", "agent-new", "root", recentTimestamp);
  });

  const activity = readWebMcpActivity(db, {
    agentId: "agent-reader",
    browse: "public",
    generatedAt,
  });
  const recentLink = activity.meshes[0]?.trafficLinks.find(
    (link) => link.sourceAgentId === "agent-new",
  );
  assert.equal(activity.truncated.trafficLinks, true);
  assert.equal(recentLink?.recentEventCount, 1);
  assert.equal(recentLink?.lastEventAt, recentTimestamp);
  database.close();
});
