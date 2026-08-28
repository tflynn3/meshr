import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createMeshrServer, type MeshrServer } from "./app.ts";
import type { Clock } from "./types.ts";

class TestClock implements Clock {
  now(): Date {
    return new Date("2026-08-27T18:00:00.000Z");
  }
}

const running: Array<{ app: MeshrServer; directory: string }> = [];

afterEach(async () => {
  while (running.length) {
    const item = running.pop();
    if (!item) continue;
    await item.app.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

async function start() {
  const directory = mkdtempSync(join(tmpdir(), "meshr-public-activity-test-"));
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock: new TestClock(),
  });
  const { baseUrl } = await app.listen();
  running.push({ app, directory });
  return { app, baseUrl };
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, json: await response.json() as any };
}

test("signed-in humans receive aggregate-only public topology from persisted agent activity", async () => {
  const { app, baseUrl } = await start();
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "activity@example.test",
      password: "correct horse battery staple",
      displayName: "Activity Owner",
    },
  });
  const accountId = registration.json.user.id as string;
  const cookie = (registration.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  assert.ok(cookie);

  const unauthenticated = await requestJson(baseUrl, "/v1/activity/public");
  assert.equal(unauthenticated.response.status, 401);

  const db = app.database.sqlite;
  const attention = JSON.stringify({
    browse: "public",
    rootPosts: "autonomous",
    replies: "autonomous",
    notes: "",
  });
  const insertAgent = db.prepare(
    `INSERT INTO agents(
       id, owner_account_id, name, handle, tagline, interests_json, personality,
       attention_json, runtime, runtime_label, runtime_subject, public_key_pem,
       definition_digest, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, 'test-key', NULL, ?, ?)`,
  );
  insertAgent.run(
    "agt-relay",
    accountId,
    "Relay",
    "relay-live",
    "Connects useful observations.",
    JSON.stringify(["systems"]),
    attention,
    "ollama",
    "Ollama",
    "ollama:relay",
    "2026-08-27T17:40:00.000Z",
    "2026-08-27T17:40:00.000Z",
  );
  insertAgent.run(
    "agt-lumen",
    accountId,
    "Lumen",
    "lumen-live",
    "Finds the illuminating detail.",
    JSON.stringify(["connections"]),
    attention,
    "ollama",
    "Ollama",
    "ollama:lumen",
    "2026-08-27T17:41:00.000Z",
    "2026-08-27T17:41:00.000Z",
  );
  db.prepare("INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES('mesh-public', ?, ?)")
    .run("agt-relay", "2026-08-27T17:42:00.000Z");
  db.prepare("INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES('mesh-public', ?, ?)")
    .run("agt-lumen", "2026-08-27T17:42:00.000Z");
  db.prepare(
    `INSERT INTO posts(id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at)
     VALUES('post-root', 'mesh-public', 'topic-small-discoveries', 'agt-relay', NULL, ?, ?)`,
  ).run("A private payload that must not reach the aggregate.", "2026-08-27T17:55:00.000Z");
  db.prepare(
    `INSERT INTO posts(id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at)
     VALUES('post-reply', 'mesh-public', 'topic-small-discoveries', 'agt-lumen', 'post-root', ?, ?)`,
  ).run("Another private payload.", "2026-08-27T17:57:00.000Z");

  const activity = await requestJson(baseUrl, "/v1/activity/public", { cookie });
  assert.equal(activity.response.status, 200);
  assert.equal(activity.json.generatedAt, "2026-08-27T18:00:00.000Z");
  assert.equal(activity.json.windowMinutes, 15);
  assert.deepEqual(activity.json.meshes.map((mesh: any) => mesh.id), ["mesh-public"]);
  const topic = activity.json.meshes[0].topics.find(
    (candidate: any) => candidate.id === "topic-small-discoveries",
  );
  assert.deepEqual(
    {
      postCount: topic.postCount,
      rootCount: topic.rootCount,
      replyCount: topic.replyCount,
      recentPostCount: topic.recentPostCount,
      participantAgentIds: topic.participantAgentIds,
    },
    {
      postCount: 2,
      rootCount: 1,
      replyCount: 1,
      recentPostCount: 2,
      participantAgentIds: ["agt-lumen", "agt-relay"],
    },
  );
  assert.deepEqual(activity.json.links, [
    {
      id: "traffic:mesh-public:agt-lumen:agt-relay",
      meshId: "mesh-public",
      sourceAgentId: "agt-lumen",
      targetAgentId: "agt-relay",
      topicIds: ["topic-small-discoveries"],
      eventCount: 1,
      recentEventCount: 1,
      messagesPerMinute: 0.1,
      medianReplyDelayMs: 120_000,
      lastEventAt: "2026-08-27T17:57:00.000Z",
    },
  ]);
  assert.equal(activity.json.agents.every((agent: any) => agent.ownedByYou), true);
  assert.equal(activity.json.agents.every((agent: any) => agent.connectionStatus === "offline"), true);
  const wire = JSON.stringify(activity.json);
  assert.equal(wire.includes("private payload"), false);
  assert.equal(wire.includes('"body"'), false);
  assert.equal(wire.includes('"parentPostId"'), false);
  assert.equal(wire.includes('"runtimeSubject"'), false);
  assert.equal(wire.includes('"ownerAccountId"'), false);
  assert.equal(wire.includes('"definitionDigest"'), false);
  assert.equal(wire.includes('"pairingSecret"'), false);
  assert.equal(wire.includes('"agentToken"'), false);
});
