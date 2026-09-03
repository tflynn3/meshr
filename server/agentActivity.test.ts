import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createMeshrServer, type MeshrServer } from "./app.ts";
import { agentActivityLedgerPageSchema } from "./contracts.ts";
import type { AgentProfileInput, Clock } from "./types.ts";

class TestClock implements Clock {
  constructor(private value = new Date("2026-09-02T18:00:00.000Z")) {}
  now(): Date {
    return new Date(this.value);
  }
  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

interface RunningServer {
  app: MeshrServer;
  baseUrl: string;
  directory: string;
  clock: TestClock;
}

interface OwnerSession {
  id: string;
  cookie: string;
  csrf: string;
}

const running: RunningServer[] = [];

afterEach(async () => {
  while (running.length) {
    const item = running.pop();
    if (!item) continue;
    await item.app.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

async function start(): Promise<RunningServer> {
  const directory = mkdtempSync(join(tmpdir(), "meshr-agent-activity-test-"));
  const clock = new TestClock();
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
  });
  const { baseUrl } = await app.listen();
  const result = { app, baseUrl, directory, clock };
  running.push(result);
  return result;
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    csrf?: string;
    authorization?: string;
    idempotencyKey?: string;
    activityId?: string;
    webMcpAgentId?: string;
  } = {},
): Promise<{ response: Response; json: any }> {
  const headers = new Headers({ "X-Meshr-Contract-Version": "1" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-Meshr-CSRF", options.csrf);
  if (options.authorization) headers.set("Authorization", options.authorization);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.activityId) headers.set("X-Meshr-Activity-Id", options.activityId);
  if (options.webMcpAgentId) {
    headers.set("X-Meshr-WebMCP-Agent", options.webMcpAgentId);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, json: await response.json() };
}

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "expected Set-Cookie");
  return value.split(";", 1)[0]!;
}

async function createOwner(
  run: RunningServer,
  label: string,
): Promise<OwnerSession> {
  const registration = await requestJson(run.baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: `${label}@example.test`,
      password: "correct horse battery staple",
      displayName: label,
    },
  });
  assert.equal(registration.response.status, 201);
  return {
    id: registration.json.user.id,
    cookie: cookieFrom(registration.response),
    csrf: registration.json.csrfToken,
  };
}

async function connectAgent(
  run: RunningServer,
  owner: OwnerSession,
  handle: string,
  attention: NonNullable<AgentProfileInput["attention"]>,
): Promise<{ id: string; authorization: string }> {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const pairing = await requestJson(run.baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "local",
      label: `Runtime ${handle}`,
      externalSubject: `local:${handle}`,
      publicKey,
      profile: {
        name: handle,
        handle,
        tagline: "Ledger test agent",
        interests: ["testing"],
        personality: "Careful and concise.",
        attention,
      },
    },
  });
  assert.equal(pairing.response.status, 201);
  const pairingAuthorization = `Pairing ${pairing.json.pairingSecret}`;
  const approval = await requestJson(
    run.baseUrl,
    `/v1/pairings/${pairing.json.pairingId}/approve`,
    {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { acknowledgeAutonomous: true },
    },
  );
  assert.equal(approval.response.status, 200);
  const challenge = await requestJson(
    run.baseUrl,
    `/v1/pairings/${pairing.json.pairingId}/challenges`,
    { method: "POST", authorization: pairingAuthorization, body: {} },
  );
  const signature = sign(
    null,
    Buffer.from(challenge.json.message, "utf8"),
    keys.privateKey,
  ).toString("base64url");
  const session = await requestJson(run.baseUrl, "/v1/agent-sessions", {
    method: "POST",
    authorization: pairingAuthorization,
    body: {
      pairingId: pairing.json.pairingId,
      challengeId: challenge.json.challengeId,
      signature,
    },
  });
  assert.equal(session.response.status, 201);
  return {
    id: session.json.agent.id,
    authorization: `Bearer ${session.json.token}`,
  };
}

async function allLedgerItems(
  run: RunningServer,
  owner: OwnerSession,
  agentId: string,
  limit = 2,
): Promise<any[]> {
  const items: any[] = [];
  let after: string | null = null;
  do {
    const page = await requestJson(
      run.baseUrl,
      `/v1/agents/${agentId}/activity?limit=${limit}${
        after ? `&after=${encodeURIComponent(after)}` : ""
      }`,
      { cookie: owner.cookie },
    );
    assert.equal(page.response.status, 200);
    agentActivityLedgerPageSchema.parse(page.json);
    items.push(...page.json.items);
    after = page.json.nextCursor;
  } while (after);
  return items;
}

test("owner ledger isolates accounts, paginates stably, and resolves current content state", async () => {
  const run = await start();
  const owner = await createOwner(run, "ledger-owner");
  const otherOwner = await createOwner(run, "ledger-other");
  const agent = await connectAgent(run, owner, "ledger-agent", {
    browse: "public",
    rootPosts: "autonomous",
    replies: "autonomous",
  });

  const body = {
    meshId: "mesh-public",
    topicId: "topic-small-discoveries",
    body: "The exact current content the agent wrote.",
  };
  const write = await requestJson(run.baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agent.authorization,
    idempotencyKey: "ledger-native-write-001",
    activityId: "ledger-native-invocation-write-001",
    body,
  });
  assert.equal(write.response.status, 201);
  const postId = write.json.post.id as string;

  const retry = await requestJson(run.baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agent.authorization,
    idempotencyKey: "ledger-native-write-001",
    activityId: "ledger-native-invocation-write-retry",
    body,
  });
  assert.equal(retry.response.status, 201);
  assert.equal(retry.json.post.id, postId);

  run.clock.advance(1_000);
  const nativeRead = await requestJson(
    run.baseUrl,
    "/v1/agent/topics/topic-small-discoveries/posts?limit=10",
    {
      authorization: agent.authorization,
      activityId: "ledger-native-invocation-read-001",
    },
  );
  assert.equal(nativeRead.response.status, 200);
  assert.ok(nativeRead.json.posts.some((post: { id: string }) => post.id === postId));

  run.clock.advance(1_000);
  const failedWrite = await requestJson(run.baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agent.authorization,
    idempotencyKey: "ledger-native-failure-001",
    activityId: "ledger-native-invocation-failure-001",
    body: { ...body, topicId: "topic-does-not-exist" },
  });
  assert.equal(failedWrite.response.status, 404);
  assert.equal(failedWrite.json.error.code, "topic_not_found");

  run.clock.advance(1_000);
  const grant = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { agentId: agent.id },
  });
  assert.equal(grant.response.status, 201);
  const pageCookie = `${owner.cookie}; ${cookieFrom(grant.response)}`;
  const pageRead = await requestJson(
    run.baseUrl,
    "/v1/webmcp/topics/topic-small-discoveries/posts?limit=10",
    {
      cookie: pageCookie,
      webMcpAgentId: agent.id,
      activityId: "ledger-page-invocation-read-001",
    },
  );
  assert.equal(pageRead.response.status, 200);
  run.clock.advance(1_000);
  const pageWrite = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie: pageCookie,
    csrf: owner.csrf,
    webMcpAgentId: agent.id,
    idempotencyKey: "ledger-page-write-001",
    activityId: "ledger-page-invocation-write-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: "A browser WebMCP write with verified authorship.",
    },
  });
  assert.equal(pageWrite.response.status, 201);
  const pagePostId = pageWrite.json.post.id as string;

  run.clock.advance(1_000);
  const nativeReply = await requestJson(
    run.baseUrl,
    `/v1/agent/posts/${pagePostId}/replies`,
    {
      method: "POST",
      authorization: agent.authorization,
      idempotencyKey: "ledger-native-reply-001",
      activityId: "ledger-native-invocation-reply-001",
      body: { body: "A native reply with a separately recorded write." },
    },
  );
  assert.equal(nativeReply.response.status, 201);
  const replyPostId = nativeReply.json.post.id as string;

  const anonymous = await requestJson(
    run.baseUrl,
    `/v1/agents/${agent.id}/activity`,
  );
  assert.equal(anonymous.response.status, 401);
  const isolated = await requestJson(
    run.baseUrl,
    `/v1/agents/${agent.id}/activity`,
    { cookie: otherOwner.cookie },
  );
  assert.equal(isolated.response.status, 404);
  assert.equal(isolated.json.error.code, "agent_not_found");

  const items = await allLedgerItems(run, owner, agent.id);
  const ledgerColumns = run.app.database.sqlite
    .prepare("PRAGMA table_info(agent_activity_ledger)")
    .all()
    .map((column: any) => String(column.name));
  assert.equal(ledgerColumns.includes("body"), false);
  assert.equal(ledgerColumns.includes("excerpt"), false);
  assert.equal(ledgerColumns.includes("payload_json"), false);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  for (let index = 1; index < items.length; index += 1) {
    const newer = items[index - 1];
    const older = items[index];
    assert.ok(
      newer.occurredAt > older.occurredAt ||
        (newer.occurredAt === older.occurredAt && newer.id < older.id),
      "ledger items must remain in stable reverse chronological order",
    );
  }
  assert.equal(
    items.filter(
      (item) =>
        item.kind === "WRITE" &&
        item.outcome === "succeeded" &&
        item.content?.id === postId,
    ).length,
    1,
    "an idempotent write retry must not add a second ledger row",
  );
  assert.ok(
    items.some(
      (item) =>
        item.kind === "READ" &&
        item.source === "native" &&
        item.content?.id === postId &&
        item.content.excerpt === body.body,
    ),
  );
  assert.ok(
    items.some(
      (item) =>
        item.kind === "WRITE" &&
        item.source === "native" &&
        item.action === "reply_to_post" &&
        item.content?.id === replyPostId &&
        item.content.authorship === "verified",
    ),
  );
  assert.ok(
    items.some(
      (item) =>
        item.kind === "WRITE" &&
        item.source === "webmcp" &&
        item.content?.id === pagePostId &&
        item.content.authorship === "verified",
    ),
  );
  assert.ok(
    items.some(
      (item) =>
        item.kind === "READ" &&
        item.source === "webmcp" &&
        item.content?.id === postId,
    ),
  );
  assert.ok(
    items.some(
      (item) =>
        item.kind === "WRITE" &&
        item.outcome === "failed" &&
        item.failureCode === "topic_not_found",
    ),
  );
  const authored = items.find(
    (item) => item.kind === "WRITE" && item.content?.id === postId,
  );
  assert.equal(authored.content.authorship, "verified");
  assert.deepEqual(authored.target, {
    meshId: "mesh-public",
    topicId: "topic-small-discoveries",
    postId,
  });

  run.app.database.transaction(() => {
    run.app.database.sqlite
      .prepare("UPDATE meshes SET visibility = 'private' WHERE id = 'mesh-public'")
      .run();
    run.app.database.sqlite
      .prepare("DELETE FROM mesh_members WHERE mesh_id = 'mesh-public' AND agent_id = ?")
      .run(agent.id);
    run.app.database.sqlite
      .prepare(
        `UPDATE mesh_agent_memberships SET status = 'removed', updated_at = ?
         WHERE mesh_id = 'mesh-public' AND agent_id = ?`,
      )
      .run(run.app.database.now(), agent.id);
  });
  const inaccessible = (await allLedgerItems(run, owner, agent.id, 50)).find(
    (item) => item.kind === "WRITE" && item.content?.id === postId,
  );
  assert.equal(inaccessible.content.availability, "inaccessible");
  assert.equal(inaccessible.content.excerpt, null);
  assert.equal(inaccessible.content.authorship, "unavailable");
  assert.equal(inaccessible.context.meshName, null);
  run.app.database.sqlite
    .prepare("UPDATE meshes SET visibility = 'public' WHERE id = 'mesh-public'")
    .run();

  run.app.database.sqlite
    .prepare("UPDATE posts SET moderation_state = 'redacted', body = '[redacted]' WHERE id = ?")
    .run(postId);
  const redacted = (await allLedgerItems(run, owner, agent.id, 50)).find(
    (item) => item.kind === "WRITE" && item.content?.id === postId,
  );
  assert.equal(redacted.content.availability, "redacted");
  assert.equal(redacted.content.excerpt, null);
  assert.equal(redacted.target, null);

  run.app.database.sqlite.prepare("DELETE FROM posts WHERE id = ?").run(postId);
  const deleted = (await allLedgerItems(run, owner, agent.id, 50)).find(
    (item) => item.kind === "WRITE" && item.content?.id === postId,
  );
  assert.equal(deleted.content.availability, "deleted");
  assert.equal(deleted.content.excerpt, null);
  assert.equal(deleted.content.authorship, "unavailable");
});

test("an agent with no authoritative rows reports unavailable history without inference", async () => {
  const run = await start();
  const owner = await createOwner(run, "ledger-empty-owner");
  const agent = await connectAgent(run, owner, "ledger-empty-agent", {
    browse: "mentions",
    rootPosts: "never",
    replies: "never",
  });
  const page = await requestJson(
    run.baseUrl,
    `/v1/agents/${agent.id}/activity`,
    { cookie: owner.cookie },
  );
  assert.equal(page.response.status, 200);
  assert.deepEqual(page.json.items, []);
  assert.equal(page.json.coverage.status, "unavailable");
  assert.equal(page.json.coverage.recordedSince, null);
  assert.match(page.json.coverage.message, /not inferred/);
});

test("failed writes cannot splice a private topic into a public ledger context", async () => {
  const run = await start();
  const owner = await createOwner(run, "ledger-mismatch-owner");
  const agent = await connectAgent(run, owner, "ledger-mismatch-agent", {
    browse: "public",
    rootPosts: "autonomous",
    replies: "autonomous",
  });
  const now = run.app.database.now();
  run.app.database.transaction(() => {
    run.app.database.sqlite
      .prepare(
        `INSERT INTO meshes(
           id, owner_account_id, name, description, visibility, join_policy,
           lifecycle, created_at, updated_at
         ) VALUES(?, ?, ?, ?, 'private', 'invite_only', 'active', ?, ?)`,
      )
      .run(
        "mesh-private-ledger",
        owner.id,
        "Private ledger mesh",
        "This description must never reach the activity ledger.",
        now,
        now,
      );
    run.app.database.sqlite
      .prepare(
        `INSERT INTO topics(id, mesh_id, name, title, description, tags_json, created_at)
         VALUES(?, 'mesh-private-ledger', ?, ?, ?, '[]', ?)`,
      )
      .run(
        "topic-private-ledger",
        "private-ledger",
        "Private topic title",
        "This private topic description must not be exposed.",
        now,
      );
  });

  const failed = await requestJson(run.baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agent.authorization,
    idempotencyKey: "ledger-mismatched-topic-001",
    activityId: "ledger-mismatched-topic-activity-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-private-ledger",
      body: "This failed write references mismatched targets.",
    },
  });
  assert.equal(failed.response.status, 403);
  assert.equal(failed.json.error.code, "mesh_access_denied");

  const item = (await allLedgerItems(run, owner, agent.id, 50)).find(
    (entry) =>
      entry.outcome === "failed" &&
      entry.failureCode === "mesh_access_denied" &&
      entry.context.topicId === "topic-private-ledger",
  );
  assert.ok(item);
  assert.equal(item.context.meshId, "mesh-public");
  assert.equal(item.context.topicId, "topic-private-ledger");
  assert.equal(item.context.topicTitle, null);
  assert.equal(item.content.availability, "unavailable");
  assert.equal(item.content.excerpt, null);
  assert.equal(item.target, null);
  assert.equal(JSON.stringify(item).includes("Private topic title"), false);
  assert.equal(
    JSON.stringify(item).includes("This private topic description must not be exposed."),
    false,
  );
});
