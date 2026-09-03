import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createMeshrServer, type MeshrServer } from "./app.ts";
import type { MeshrRepository } from "./repository.ts";
import { sha256 } from "./security.ts";
import type { AgentProfileInput, Clock } from "./types.ts";

class TestClock implements Clock {
  constructor(private value = new Date("2026-08-27T18:00:00.000Z")) {}
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

interface ConnectedAgent {
  id: string;
  authorization?: string;
  pairingId?: string;
}

const running: RunningServer[] = [];
const grantedAgentByCookie = new Map<string, string>();

afterEach(async () => {
  grantedAgentByCookie.clear();
  while (running.length) {
    const item = running.pop();
    if (!item) continue;
    await item.app.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

async function start(options: {
  webMcpTransfersSession?: boolean;
  repository?: MeshrRepository;
} = {}): Promise<RunningServer> {
  const directory = mkdtempSync(join(tmpdir(), "meshr-webmcp-test-"));
  const clock = new TestClock();
  let appReference: MeshrServer;
  const repository = options.repository
    ? (new Proxy(options.repository, {
        get(target, property, receiver) {
          const supplied = Reflect.get(target, property, receiver);
          if (supplied !== undefined) {
            return typeof supplied === "function"
              ? supplied.bind(target)
              : supplied;
          }
          if (property === "findHumanSession") {
            return async (tokenHash: string) => {
              const row = appReference.database.sqlite
                .prepare(
                  `SELECT account_id, csrf_token, created_at, expires_at,
                          absolute_expires_at, last_seen_at
                   FROM human_sessions WHERE token_hash = ?`,
                )
                .get(tokenHash) as
                | {
                    account_id: string;
                    csrf_token: string;
                    created_at: string;
                    expires_at: string;
                    absolute_expires_at: string;
                    last_seen_at: string;
                  }
                | undefined;
              return row
                ? {
                    accountId: row.account_id,
                    csrfToken: row.csrf_token,
                    createdAt: row.created_at,
                    expiresAt: row.expires_at,
                    absoluteExpiresAt: row.absolute_expires_at,
                    lastSeenAt: row.last_seen_at,
                  }
                : null;
            };
          }
          if (property === "touchHumanSession") {
            return async (tokenHash: string, lastSeenAt: string) => {
              appReference.database.sqlite
                .prepare(
                  "UPDATE human_sessions SET last_seen_at = ? WHERE token_hash = ?",
                )
                .run(lastSeenAt, tokenHash);
            };
          }
          if (property === "findAccountById") {
            return async (accountId: string) => {
              const row = appReference.database.sqlite
                .prepare(
                  "SELECT id, email, display_name, created_at FROM accounts WHERE id = ?",
                )
                .get(accountId) as
                | {
                    id: string;
                    email: string;
                    display_name: string;
                    created_at: string;
                  }
                | undefined;
              return row
                ? {
                    accountId: row.id,
                    email: row.email,
                    displayName: row.display_name,
                    createdAt: row.created_at,
                  }
                : null;
            };
          }
          return undefined;
        },
      }) as MeshrRepository)
    : undefined;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    webMcpTransfersSession: options.webMcpTransfersSession,
    repository,
  });
  appReference = app;
  const { baseUrl } = await app.listen();
  const value = { app, baseUrl, directory, clock };
  running.push(value);
  return value;
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
    webMcpAgentId?: string | null;
  } = {},
): Promise<{ response: Response; json: any }> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-Meshr-CSRF", options.csrf);
  if (options.authorization) headers.set("Authorization", options.authorization);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  const pageGrantCookie = options.cookie
    ?.split(/;\s*/)
    .find((cookie) => cookie.startsWith("meshr_webmcp="));
  const webMcpAgentId =
    options.webMcpAgentId === null
      ? undefined
      : options.webMcpAgentId ??
        (pageGrantCookie ? grantedAgentByCookie.get(pageGrantCookie) : undefined);
  if (webMcpAgentId) headers.set("X-Meshr-WebMCP-Agent", webMcpAgentId);
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
  claim = true,
): Promise<ConnectedAgent> {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const pairing = await requestJson(run.baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "local",
      label: `Runtime ${handle}`,
      externalSubject: `local:${handle}`,
      publicKey,
      profile: {
        name: handle[0]!.toUpperCase() + handle.slice(1),
        handle,
        tagline: `Agent ${handle}`,
        interests: ["testing"],
        personality: "Careful and concise.",
        attention,
      },
    },
  });
  const pairingAuthorization = `Pairing ${pairing.json.pairingSecret}`;
  const approval = await requestJson(
    run.baseUrl,
    `/v1/pairings/${pairing.json.pairingId}/approve`,
    {
      method: "POST",
      body: {
        acknowledgeAutonomous:
          attention.browse !== "mentions" ||
          attention.rootPosts === "autonomous" ||
          attention.replies === "autonomous",
      },
      cookie: owner.cookie,
      csrf: owner.csrf,
    },
  );
  assert.equal(approval.response.status, 200);
  if (!claim) {
    return { id: approval.json.agent.id, pairingId: pairing.json.pairingId };
  }
  const challenge = await requestJson(
    run.baseUrl,
    `/v1/pairings/${pairing.json.pairingId}/challenges`,
    { method: "POST", body: {}, authorization: pairingAuthorization },
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
    pairingId: pairing.json.pairingId,
  };
}

async function enableGrant(
  run: RunningServer,
  owner: OwnerSession,
  agentId: string,
): Promise<{ cookie: string; response: Response; json: any }> {
  const enabled = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { agentId },
  });
  const cookie = cookieFrom(enabled.response);
  grantedAgentByCookie.set(cookie, agentId);
  return { cookie, ...enabled };
}

async function createBrowserAgent(
  run: RunningServer,
  owner: OwnerSession,
  input: {
    name: string;
    handle: string;
    tagline?: string;
    interests?: string[];
    personality?: string;
    participation: "observe" | "interactive" | "autonomous";
    acknowledgeAutonomous?: boolean;
  },
  idempotencyKey: string,
): Promise<{ cookie: string; response: Response; json: any }> {
  const created = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey,
    body: { createAgent: input },
  });
  const cookie = cookieFrom(created.response);
  if (created.json?.agent?.id) {
    grantedAgentByCookie.set(cookie, created.json.agent.id);
  }
  return { cookie, ...created };
}

const combinedCookie = (owner: OwnerSession, webMcpCookie: string): string =>
  `${owner.cookie}; ${webMcpCookie}`;

function seedLocalReadAuthority(
  run: RunningServer,
  label: string,
): {
  agentId: string;
  nativeAuthorization: string;
  pageCookie: string;
} {
  const now = run.app.database.now();
  const expiresAt = new Date(
    run.clock.now().getTime() + 60 * 60_000,
  ).toISOString();
  const accountId = `account-${label}`;
  const agentId = `agent-${label}`;
  const pairingId = `pairing-${label}`;
  const sessionId = `session-${label}`;
  const nativeToken = `native-token-${label}`;
  const humanToken = `human-token-${label}`;
  const pageToken = `page-token-${label}`;
  const nativeHash = sha256(nativeToken);
  const humanHash = sha256(humanToken);
  const pageHash = sha256(pageToken);
  run.app.database.transaction(() => {
    run.app.database.sqlite
      .prepare(
        "INSERT INTO accounts(id, email, display_name, password_hash, created_at) VALUES(?, ?, ?, '', ?)",
      )
      .run(accountId, `${label}@example.test`, label, now);
    run.app.database.sqlite
      .prepare(
        `INSERT INTO human_sessions(
           token_hash, account_id, csrf_token, created_at, expires_at,
           last_seen_at, absolute_expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(humanHash, accountId, `csrf-${label}`, now, expiresAt, now, expiresAt);
    run.app.database.sqlite
      .prepare(
        `INSERT INTO agents(
           id, owner_account_id, name, handle, tagline, interests_json,
           personality, attention_json, runtime, runtime_label, runtime_subject,
           public_key_pem, definition_digest, created_at, updated_at
         ) VALUES(?, ?, ?, ?, '', '[]', '', ?, 'local', ?, ?, 'fixture-key', NULL, ?, ?)`,
      )
      .run(
        agentId,
        accountId,
        label,
        `handle-${label}`,
        JSON.stringify({
          browse: "public",
          rootPosts: "autonomous",
          replies: "autonomous",
        }),
        label,
        `fixture:${label}`,
        now,
        now,
      );
    run.app.database.sqlite
      .prepare(
        `INSERT INTO pairings(
           id, code, secret_hash, runtime, runtime_label, external_subject,
           public_key_pem, status, owner_account_id, agent_id, created_at,
           expires_at, approved_at, claimed_at
         ) VALUES(?, ?, 'fixture-secret', 'local', ?, ?, 'fixture-key',
                  'claimed', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pairingId,
        `CODE-${label}`,
        label,
        `fixture:${label}`,
        accountId,
        agentId,
        now,
        expiresAt,
        now,
        now,
      );
    run.app.database.sqlite
      .prepare(
        `INSERT INTO agent_sessions(
           token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
           session_id, runtime_kind, status, authority_epoch
         ) VALUES(?, ?, ?, ?, ?, ?, ?, 'local', 'active', 1)`,
      )
      .run(
        nativeHash,
        agentId,
        pairingId,
        now,
        expiresAt,
        now,
        sessionId,
      );
    run.app.database.sqlite
      .prepare(
        `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
         VALUES(?, 1, 'native', ?, ?)`,
      )
      .run(agentId, sessionId, now);
    run.app.database.sqlite
      .prepare(
        `INSERT INTO webmcp_grants(
           token_hash, human_session_hash, agent_id, created_at, expires_at,
           last_used_at, revoked_at, session_id, authority_epoch
         ) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, 1)`,
      )
      .run(pageHash, humanHash, agentId, now, expiresAt, now, sessionId);
    run.app.database.sqlite
      .prepare(
        "INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at) VALUES('mesh-public', ?, ?)",
      )
      .run(agentId, now);
  });
  return {
    agentId,
    nativeAuthorization: `Bearer ${nativeToken}`,
    pageCookie: `meshr_session=${humanToken}; meshr_webmcp=${pageToken}`,
  };
}

async function startPausedJsonPost(input: {
  baseUrl: string;
  path: string;
  cookie?: string;
  csrf?: string;
  agentId?: string;
  authorization?: string;
  idempotencyKey: string;
  body: unknown;
}): Promise<{
  finish(): Promise<{ status: number; json: any }>;
}> {
  const payload = Buffer.from(JSON.stringify(input.body));
  assert.ok(payload.length > 1);
  let resolveResponse!: (value: { status: number; json: any }) => void;
  let rejectResponse!: (error: Error) => void;
  const responsePromise = new Promise<{ status: number; json: any }>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Content-Length": String(payload.length),
    "Idempotency-Key": input.idempotencyKey,
  };
  if (input.cookie) headers.Cookie = input.cookie;
  if (input.csrf) headers["X-Meshr-CSRF"] = input.csrf;
  if (input.agentId) headers["X-Meshr-WebMCP-Agent"] = input.agentId;
  if (input.authorization) headers.Authorization = input.authorization;
  const request = httpRequest(new URL(input.path, input.baseUrl), {
    method: "POST",
    headers,
  });
  request.on("response", (response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    response.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolveResponse({
        status: response.statusCode ?? 0,
        json: text ? JSON.parse(text) : null,
      });
    });
  });
  request.on("error", rejectResponse);
  request.flushHeaders();
  await new Promise<void>((resolve, reject) => {
    request.write(payload.subarray(0, payload.length - 1), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return {
    async finish() {
      request.end(payload.subarray(payload.length - 1));
      return responsePromise;
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for server request admission.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const autonomous = {
  browse: "public" as const,
  rootPosts: "autonomous" as const,
  replies: "autonomous" as const,
  notes: "Participate autonomously.",
};

test("a human can create an observe-only agent with page authority before attaching a native runtime", async () => {
  const run = await start();
  const owner = await createOwner(run, "browser-first");
  const created = await createBrowserAgent(
    run,
    owner,
    {
      name: "Browser Observer",
      handle: "browser-observer",
      tagline: "Starts in the page.",
      interests: ["WebMCP", "agent commons"],
      personality: "Curious and careful.",
      participation: "observe",
    },
    "browser-agent-create-001",
  );

  assert.equal(created.response.status, 201);
  assert.equal(created.json.enabled, true);
  assert.equal(created.json.agent.ownerId, owner.id);
  assert.equal(created.json.agent.handle, "browser-observer");
  assert.deepEqual(
    {
      browse: created.json.agent.attention.browse,
      rootPosts: created.json.agent.attention.rootPosts,
      replies: created.json.agent.attention.replies,
    },
    {
      browse: "public",
      rootPosts: "never",
      replies: "never",
    },
  );
  assert.equal("token" in created.json, false);
  assert.match(created.response.headers.get("set-cookie") ?? "", /meshr_webmcp=/);

  const cookie = combinedCookie(owner, created.cookie);
  const profile = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie,
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.json.agent.id, created.json.agent.id);
  const portfolio = await requestJson(run.baseUrl, "/v1/agents", {
    cookie: owner.cookie,
  });
  const durableAgent = portfolio.json.agents.find(
    (agent: { id: string }) => agent.id === created.json.agent.id,
  );
  assert.ok(durableAgent);
  assert.equal(durableAgent.runtimeAttached, false);
  assert.equal(durableAgent.connectionStatus, "offline");
  const meshes = await requestJson(run.baseUrl, "/v1/webmcp/meshes", {
    cookie,
  });
  assert.equal(meshes.response.status, 200);
  assert.ok(
    meshes.json.meshes.some((mesh: { id: string }) => mesh.id === "mesh-public"),
  );
  const deniedWrite = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "browser-observer-post-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: "Observe-only agents must not publish.",
    },
  });
  assert.equal(deniedWrite.response.status, 403);
  assert.equal(deniedWrite.json.error.code, "attention_policy_denied");

  const nativeState = run.app.database.sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM pairings WHERE agent_id = ?) AS pairings,
         (SELECT COUNT(*) FROM agent_sessions WHERE agent_id = ?) AS sessions,
         (SELECT COUNT(*) FROM mesh_members
          WHERE mesh_id = 'mesh-public' AND agent_id = ?) AS public_memberships`,
    )
    .get(
      created.json.agent.id,
      created.json.agent.id,
      created.json.agent.id,
    ) as { pairings: number; sessions: number; public_memberships: number };
  assert.deepEqual({ ...nativeState }, {
    pairings: 0,
    sessions: 0,
    public_memberships: 1,
  });
});

test("an interactive page agent can join, read, and write through its normal identity", async () => {
  const run = await start();
  const owner = await createOwner(run, "interactive-page");
  const created = await createBrowserAgent(
    run,
    owner,
    {
      name: "Computational Chemist",
      handle: "interactive-chemist",
      tagline: "Models molecular systems.",
      interests: ["computational chemistry", "molecular simulation"],
      personality: "Rigorous and curious.",
      participation: "interactive",
    },
    "interactive-page-agent-001",
  );
  assert.equal(created.response.status, 201);
  assert.equal(created.json.agent.attention.rootPosts, "draft");
  assert.equal(created.json.agent.attention.replies, "draft");
  const cookie = combinedCookie(owner, created.cookie);

  const mesh = await requestJson(run.baseUrl, "/v1/meshes", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "interactive-page-mesh-001",
    body: {
      name: "Molecular modeling",
      description: "Computational chemistry and molecular simulation.",
      visibility: "public",
      joinPolicy: "open",
      agentIds: [],
    },
  });
  assert.equal(mesh.response.status, 201);

  const joined = await requestJson(
    run.baseUrl,
    `/v1/webmcp/meshes/${encodeURIComponent(mesh.json.mesh.id)}/join`,
    {
      method: "POST",
      cookie,
      csrf: owner.csrf,
      webMcpAgentId: created.json.agent.id,
      idempotencyKey: "interactive-page-join-001",
      body: {},
    },
  );
  assert.equal(joined.response.status, 201);
  assert.equal(joined.json.status, "joined");

  const published = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    webMcpAgentId: created.json.agent.id,
    idempotencyKey: "interactive-page-post-001",
    body: {
      meshId: mesh.json.mesh.id,
      topicId: mesh.json.topic.id,
      body: "A directly requested note about molecular dynamics.",
    },
  });
  assert.equal(published.response.status, 201);
  assert.equal(published.json.post.agentId, created.json.agent.id);

  const read = await requestJson(
    run.baseUrl,
    `/v1/webmcp/topics/${encodeURIComponent(mesh.json.topic.id)}/posts`,
    {
      cookie,
      webMcpAgentId: created.json.agent.id,
    },
  );
  assert.equal(read.response.status, 200);
  assert.equal(read.json.posts.at(-1)?.body, "A directly requested note about molecular dynamics.");
});

test("a browser-created identity survives page revocation and receives a fresh reactivation grant", async () => {
  const run = await start();
  const owner = await createOwner(run, "browser-reactivation");
  const created = await createBrowserAgent(
    run,
    owner,
    {
      name: "Persistent Browser Agent",
      handle: "persistent-browser-agent",
      participation: "observe",
    },
    "browser-agent-reactivation-001",
  );
  const firstCookie = combinedCookie(owner, created.cookie);

  const revoked = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "DELETE",
    cookie: firstCookie,
    csrf: owner.csrf,
  });
  assert.equal(revoked.response.status, 200);
  const oldGrant = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: firstCookie,
  });
  assert.equal(oldGrant.response.status, 401);

  const reactivated = await enableGrant(run, owner, created.json.agent.id);
  assert.equal(reactivated.response.status, 201);
  assert.notEqual(reactivated.cookie, created.cookie);
  const profile = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, reactivated.cookie),
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.json.agent.id, created.json.agent.id);
  assert.equal(
    (run.app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agents WHERE id = ?")
      .get(created.json.agent.id) as { count: number }).count,
    1,
  );
});

test("the first native attachment reuses a browser identity without inventing a replaced binding", async () => {
  const run = await start();
  const owner = await createOwner(run, "browser-native-attach");
  const created = await createBrowserAgent(
    run,
    owner,
    {
      name: "Browser Native Attach",
      handle: "browser-native-attach",
      participation: "observe",
    },
    "browser-agent-native-attach-001",
  );
  const attention = {
    browse: "public" as const,
    rootPosts: "never" as const,
    replies: "never" as const,
    notes: "Observe without publishing.",
  };

  const firstNative = await connectAgent(
    run,
    owner,
    "browser-native-attach",
    attention,
    false,
  );
  assert.equal(firstNative.id, created.json.agent.id);
  assert.ok(firstNative.pairingId);
  const firstEvent = run.app.database.sqlite
    .prepare(
      "SELECT data_json FROM events WHERE type = 'agent.binding.approved' AND agent_id = ? ORDER BY sequence DESC LIMIT 1",
    )
    .get(firstNative.id) as { data_json: string };
  assert.deepEqual(JSON.parse(firstEvent.data_json), {
    agentId: firstNative.id,
    bindingId: firstNative.pairingId,
    reusedIdentity: true,
    replacedBinding: false,
  });

  const replacement = await connectAgent(
    run,
    owner,
    "browser-native-attach",
    attention,
    false,
  );
  assert.equal(replacement.id, firstNative.id);
  assert.ok(replacement.pairingId);
  const replacementAudit = run.app.database.sqlite
    .prepare(
      "SELECT data_json FROM audit_events WHERE action = 'agent.binding.approved' AND resource_id = ?",
    )
    .get(replacement.pairingId) as { data_json: string };
  assert.deepEqual(JSON.parse(replacementAudit.data_json), {
    agentId: firstNative.id,
    reusedIdentity: true,
    replacedBinding: true,
  });
});

test("browser-agent creation requires CSRF, idempotency, and autonomous acknowledgement", async () => {
  const run = await start();
  const owner = await createOwner(run, "browser-consent");
  const missingCsrf = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    idempotencyKey: "browser-agent-missing-csrf-001",
    body: {
      createAgent: {
        name: "Missing CSRF",
        handle: "missing-csrf",
        participation: "observe",
      },
    },
  });
  assert.equal(missingCsrf.response.status, 403);
  assert.equal(missingCsrf.json.error.code, "csrf_failed");

  const missingIdempotency = await requestJson(
    run.baseUrl,
    "/v1/webmcp/session",
    {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: {
        createAgent: {
          name: "Missing Idempotency",
          handle: "missing-idempotency",
          participation: "observe",
        },
      },
    },
  );
  assert.equal(missingIdempotency.response.status, 400);
  assert.equal(missingIdempotency.json.error.code, "idempotency_key_required");

  const missingAcknowledgement = await requestJson(
    run.baseUrl,
    "/v1/webmcp/session",
    {
      method: "POST",
      cookie: owner.cookie,
      csrf: owner.csrf,
      idempotencyKey: "browser-agent-unacknowledged-001",
      body: {
        createAgent: {
          name: "Unacknowledged Participant",
          handle: "unacknowledged-participant",
          participation: "autonomous",
        },
      },
    },
  );
  assert.equal(missingAcknowledgement.response.status, 400);
  assert.equal(
    missingAcknowledgement.json.error.code,
    "autonomous_acknowledgement_required",
  );
  assert.equal(
    (run.app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agents WHERE owner_account_id = ?")
      .get(owner.id) as { count: number }).count,
    0,
  );
});

test("browser-agent creation replays one grant and autonomous participation enables writes", async () => {
  const run = await start();
  const owner = await createOwner(run, "browser-replay");
  const input = {
    name: "Browser Participant",
    handle: "browser-participant",
    tagline: "Participates from the page.",
    interests: ["WebMCP"],
    personality: "Constructive and concise.",
    participation: "autonomous" as const,
    acknowledgeAutonomous: true,
  };
  const first = await createBrowserAgent(
    run,
    owner,
    input,
    "browser-agent-replay-001",
  );
  const replay = await createBrowserAgent(
    run,
    owner,
    input,
    "browser-agent-replay-001",
  );

  assert.equal(first.response.status, 201);
  assert.ok(replay.response.status === 200 || replay.response.status === 201);
  assert.equal(replay.json.agent.id, first.json.agent.id);
  assert.equal(replay.json.createdAt, first.json.createdAt);
  assert.equal(replay.json.expiresAt, first.json.expiresAt);
  assert.equal(replay.cookie, first.cookie);
  assert.equal(first.json.agent.attention.browse, "public");
  assert.equal(first.json.agent.attention.rootPosts, "autonomous");
  assert.equal(first.json.agent.attention.replies, "autonomous");

  const cookie = combinedCookie(owner, replay.cookie);
  const published = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "browser-participant-post-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: "A browser-first autonomous post.",
    },
  });
  assert.equal(published.response.status, 201);
  assert.equal(published.json.post.agentId, first.json.agent.id);

  const conflict = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "browser-agent-replay-001",
    body: {
      createAgent: {
        ...input,
        tagline: "A changed command must not reuse the key.",
      },
    },
  });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.json.error.code, "idempotency_conflict");
  const identities = run.app.database.sqlite
    .prepare("SELECT COUNT(*) AS count FROM agents WHERE handle = ?")
    .get(input.handle) as { count: number };
  assert.equal(identities.count, 1);
});

test("browser-agent response-loss replay survives exhausted control and cost budgets", async (context) => {
  const previousCostMode = process.env.MESHR_COST_PROTECTION_MODE;
  process.env.MESHR_COST_PROTECTION_MODE = "normal";
  context.after(() => {
    if (previousCostMode === undefined) {
      delete process.env.MESHR_COST_PROTECTION_MODE;
    } else {
      process.env.MESHR_COST_PROTECTION_MODE = previousCostMode;
    }
  });

  const run = await start();
  const owner = await createOwner(run, "browser-recovery-budget");
  const input = {
    name: "Browser Recovery",
    handle: "browser-recovery",
    tagline: "A stable response-loss replay candidate.",
    interests: ["WebMCP"],
    personality: "Patient and exact.",
    participation: "observe" as const,
  };
  const first = await createBrowserAgent(
    run,
    owner,
    input,
    "browser-agent-recovery-budget-001",
  );
  assert.equal(first.response.status, 201);

  // The create consumed one account/session control token. Exact no-op owner
  // updates consume the remaining budget without changing the deterministic
  // profile used to recognize a response-loss replay.
  for (let index = 0; index < 19; index += 1) {
    const updated = await requestJson(
      run.baseUrl,
      `/v1/agents/${first.json.agent.id}/profile`,
      {
        method: "PUT",
        cookie: owner.cookie,
        csrf: owner.csrf,
        body: { tagline: input.tagline },
      },
    );
    assert.equal(updated.response.status, 200);
  }
  const overBudget = await requestJson(
    run.baseUrl,
    `/v1/agents/${first.json.agent.id}/profile`,
    {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { tagline: input.tagline },
    },
  );
  assert.equal(overBudget.response.status, 429);
  assert.equal(overBudget.json.error.code, "human_control_rate_limited");

  process.env.MESHR_COST_PROTECTION_MODE = "protect";
  const recovered = await createBrowserAgent(
    run,
    owner,
    input,
    "browser-agent-recovery-budget-001",
  );
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.cookie, first.cookie);
  assert.equal(recovered.json.agent.id, first.json.agent.id);
  assert.equal(recovered.json.createdAt, first.json.createdAt);
  assert.equal(recovered.json.expiresAt, first.json.expiresAt);

  // A new command still reaches the ordinary first-attempt gates. The hot
  // owner is rate limited, while a fresh owner proves cost protection remains
  // effective independently of that exhausted bucket.
  const hotNewAttempt = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "browser-agent-recovery-new-001",
    body: {
      createAgent: {
        name: "Hot New Browser Agent",
        handle: "hot-new-browser-agent",
        participation: "observe",
      },
    },
  });
  assert.equal(hotNewAttempt.response.status, 429);
  assert.equal(hotNewAttempt.json.error.code, "human_control_rate_limited");

  const freshOwner = await createOwner(run, "browser-cost-protection");
  const costBlocked = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: freshOwner.cookie,
    csrf: freshOwner.csrf,
    idempotencyKey: "browser-agent-cost-blocked-001",
    body: {
      createAgent: {
        name: "Cost Blocked Browser Agent",
        handle: "cost-blocked-browser-agent",
        participation: "observe",
      },
    },
  });
  assert.equal(costBlocked.response.status, 503);
  assert.equal(costBlocked.json.error.code, "cost_protection_active");
});

test("browser-agent creation preserves the account portfolio limit", async () => {
  const run = await start();
  const owner = await createOwner(run, "browser-limit");
  const insert = run.app.database.sqlite.prepare(
    `INSERT INTO agents(
       id, owner_account_id, name, handle, tagline, interests_json,
       personality, attention_json, runtime, runtime_label, runtime_subject,
       public_key_pem, definition_digest, created_at, updated_at
     ) VALUES(?, ?, ?, ?, '', '[]', '', ?, 'other', 'Page WebMCP', ?, '', NULL, ?, ?)`,
  );
  run.app.database.transaction(() => {
    for (let index = 0; index < 25; index += 1) {
      insert.run(
        `limit-agent-${index}`,
        owner.id,
        `Limit Agent ${index}`,
        `limit-agent-${index}`,
        JSON.stringify({
          browse: "public",
          rootPosts: "never",
          replies: "never",
          notes: "Observe only.",
        }),
        `webmcp:limit-agent-${index}`,
        run.app.database.now(),
        run.app.database.now(),
      );
    }
  });

  const limited = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "browser-agent-limit-001",
    body: {
      createAgent: {
        name: "Twenty Sixth Agent",
        handle: "twenty-sixth-agent",
        participation: "observe",
      },
    },
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, "agent_limit_reached");
  assert.equal(
    (run.app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM agents WHERE owner_account_id = ?")
      .get(owner.id) as { count: number }).count,
    25,
  );
});

test("a human explicitly grants one owned identity using only HttpOnly cookies", async () => {
  const run = await start();
  const owner = await createOwner(run, "owner");
  const otherOwner = await createOwner(run, "other");
  const connected = await connectAgent(run, owner, "selected-agent", autonomous);
  const secondConnected = await connectAgent(run, owner, "second-agent", autonomous);
  const otherAgent = await connectAgent(run, otherOwner, "other-agent", autonomous);
  const offline = await connectAgent(run, owner, "offline-agent", autonomous, false);

  const empty = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    cookie: owner.cookie,
  });
  assert.deepEqual(empty.json, {
    enabled: false,
    agent: null,
    createdAt: null,
    expiresAt: null,
  });

  const missingCsrf = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    body: { agentId: connected.id },
  });
  assert.equal(missingCsrf.response.status, 403);

  const foreign = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { agentId: otherAgent.id },
  });
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.json.error.code, "agent_not_found");

  const offlineGrant = await enableGrant(run, owner, offline.id);
  assert.equal(offlineGrant.response.status, 201);
  const offlineProfile = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, offlineGrant.cookie),
  });
  assert.equal(offlineProfile.response.status, 200);
  assert.equal(offlineProfile.json.agent.id, offline.id);

  const grant = await enableGrant(run, owner, connected.id);
  assert.equal(grant.response.status, 201);
  assert.equal(grant.json.agent.id, connected.id);
  assert.equal("token" in grant.json, false);
  assert.doesNotMatch(JSON.stringify(grant.json), /Bearer |pairingSecret|agentToken/);
  const setCookie = grant.response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /meshr_webmcp=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/v1\/webmcp/i);
  const rawToken = decodeURIComponent(grant.cookie.split("=")[1] ?? "");
  const stored = run.app.database.sqlite
    .prepare("SELECT token_hash, human_session_hash FROM webmcp_grants WHERE agent_id = ?")
    .get(connected.id) as { token_hash: string; human_session_hash: string };
  assert.notEqual(stored.token_hash, rawToken);
  assert.equal(stored.token_hash, sha256(rawToken));
  assert.equal(stored.human_session_hash, owner.cookie.split("=")[1] && sha256(owner.cookie.split("=")[1]!));

  const webOnly = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: grant.cookie,
  });
  assert.equal(webOnly.response.status, 401);
  const selected = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, grant.cookie),
  });
  assert.equal(selected.response.status, 200);
  assert.equal(selected.json.agent.id, connected.id);
  assert.equal("token" in selected.json.pageGrant, false);

  const missingAgentPrecondition = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, grant.cookie),
    webMcpAgentId: null,
  });
  assert.equal(missingAgentPrecondition.response.status, 428);
  assert.equal(
    missingAgentPrecondition.json.error.code,
    "webmcp_agent_precondition_required",
  );
  const mismatchedAgentPrecondition = await requestJson(
    run.baseUrl,
    "/v1/webmcp/profile",
    {
      cookie: combinedCookie(owner, grant.cookie),
      webMcpAgentId: secondConnected.id,
    },
  );
  assert.equal(mismatchedAgentPrecondition.response.status, 409);
  assert.equal(mismatchedAgentPrecondition.json.error.code, "webmcp_agent_mismatch");

  const switched = await enableGrant(run, owner, secondConnected.id);
  const oldGrantAfterSwitch = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, grant.cookie),
  });
  assert.equal(oldGrantAfterSwitch.response.status, 401);
  const switchedProfile = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, switched.cookie),
  });
  assert.equal(switchedProfile.json.agent.id, secondConnected.id);
  const staleTabOnNewGrant = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, switched.cookie),
    webMcpAgentId: connected.id,
  });
  assert.equal(staleTabOnNewGrant.response.status, 409);
  assert.equal(staleTabOnNewGrant.json.error.code, "webmcp_agent_mismatch");
  const staleMutationBody = "A stale tab must not author as the switched agent.";
  const staleMutation = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie: combinedCookie(owner, switched.cookie),
    csrf: owner.csrf,
    webMcpAgentId: connected.id,
    idempotencyKey: "stale-tab-post-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: staleMutationBody,
    },
  });
  assert.equal(staleMutation.response.status, 409);
  assert.equal(staleMutation.json.error.code, "webmcp_agent_mismatch");
  const staleMutationCount = run.app.database.sqlite
    .prepare("SELECT COUNT(*) AS count FROM posts WHERE body = ?")
    .get(staleMutationBody) as { count: number };
  assert.equal(staleMutationCount.count, 0);

  const expiringGrant = await enableGrant(run, owner, connected.id);

  run.clock.advance(8 * 60 * 60 * 1_000 + 1);
  const expired = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, expiringGrant.cookie),
  });
  assert.equal(expired.response.status, 401);
  assert.equal(expired.json.error.code, "webmcp_grant_required");

  const renewed = await enableGrant(run, owner, connected.id);
  const revoked = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "DELETE",
    cookie: combinedCookie(owner, renewed.cookie),
    csrf: owner.csrf,
  });
  assert.equal(revoked.response.status, 200);
  const afterRevoke = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, renewed.cookie),
  });
  assert.equal(afterRevoke.response.status, 401);

  const beforeLogout = await enableGrant(run, owner, connected.id);
  const logout = await requestJson(run.baseUrl, "/v1/session", {
    method: "DELETE",
    cookie: combinedCookie(owner, beforeLogout.cookie),
    csrf: owner.csrf,
  });
  assert.equal(logout.response.status, 200);
  const logoutCookies = logout.response.headers.get("set-cookie") ?? "";
  assert.match(logoutCookies, /meshr_session=/);
  assert.match(logoutCookies, /meshr_webmcp=/);
  const afterLogout = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, beforeLogout.cookie),
  });
  assert.equal(afterLogout.response.status, 401);
});

test("WebMCP revocation is bounded before and after human authentication", async () => {
  let durableSessionReads = 0;
  const preauthRun = await start({
    repository: {
      findHumanSession: async () => {
        durableSessionReads += 1;
        return null;
      },
    } as unknown as MeshrRepository,
  });
  const invalidResponses = [];
  for (let index = 0; index < 21; index += 1) {
    invalidResponses.push(
      await requestJson(preauthRun.baseUrl, "/v1/webmcp/session", {
        method: "DELETE",
        cookie: "meshr_session=invalid-webmcp-session",
        csrf: "invalid-csrf",
      }),
    );
  }
  assert.equal(
    invalidResponses.slice(0, 20).every(({ response }) => response.status === 401),
    true,
  );
  assert.equal(invalidResponses.at(-1)?.response.status, 429);
  assert.equal(
    invalidResponses.at(-1)?.json.error.code,
    "webmcp_session_rate_limited",
  );
  assert.equal(durableSessionReads, 20);

  const authenticatedRun = await start();
  const owner = await createOwner(authenticatedRun, "webmcp-revoke-budget");
  const authenticatedResponses = [];
  for (let index = 0; index < 6; index += 1) {
    authenticatedResponses.push(
      await requestJson(authenticatedRun.baseUrl, "/v1/webmcp/session", {
        method: "DELETE",
        cookie: owner.cookie,
        csrf: owner.csrf,
      }),
    );
  }
  assert.equal(
    authenticatedResponses.slice(0, 5).every(({ response }) => response.status === 200),
    true,
  );
  assert.equal(authenticatedResponses.at(-1)?.response.status, 429);
  assert.equal(
    authenticatedResponses.at(-1)?.json.error.code,
    "webmcp_session_rate_limited",
  );
  assert.ok(
    Number(authenticatedResponses.at(-1)?.response.headers.get("retry-after")) >= 1,
  );
});

test("page WebMCP state remains readable when transfer fencing is enabled", async () => {
  const run = await start({ webMcpTransfersSession: true });
  const owner = await createOwner(run, "webmcp-state");
  const agent = await connectAgent(run, owner, "state-agent", {
    browse: "public",
    rootPosts: "never",
    replies: "never",
  });
  const grant = await enableGrant(run, owner, agent.id);
  const state = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    cookie: combinedCookie(owner, grant.cookie),
  });
  assert.equal(state.response.status, 200);
  assert.equal(state.json.enabled, true);
  assert.equal(state.json.agent.id, agent.id);
});

test("transfer grants recover after a lost response and rotate after reactivation", async () => {
  const run = await start({ webMcpTransfersSession: true });
  const owner = await createOwner(run, "webmcp-rotation");
  const agent = await connectAgent(run, owner, "rotation-agent", autonomous);

  const first = await enableGrant(run, owner, agent.id);
  assert.equal(first.response.status, 201);
  const firstToken = decodeURIComponent(first.cookie.split("=")[1] ?? "");
  const firstHash = sha256(firstToken);
  const retry = await enableGrant(run, owner, agent.id);
  assert.equal(retry.response.status, 200);
  assert.equal(retry.cookie, first.cookie);
  assert.equal(
    (run.app.database.sqlite
      .prepare("SELECT session_id FROM webmcp_grants WHERE token_hash = ?")
      .get(firstHash) as { session_id: string }).session_id.startsWith("page_"),
    true,
  );

  const revoked = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "DELETE",
    cookie: combinedCookie(owner, first.cookie),
    csrf: owner.csrf,
  });
  assert.equal(revoked.response.status, 200);

  // Re-pairing the same handle replaces the native binding for the persistent
  // identity. The next page transfer must receive a new bearer, not revive the
  // copied token from the earlier activation.
  const reconnected = await connectAgent(run, owner, "rotation-agent", autonomous);
  assert.equal(reconnected.id, agent.id);
  const second = await enableGrant(run, owner, reconnected.id);
  assert.equal(second.response.status, 201);
  assert.notEqual(second.cookie, first.cookie);
  const secondToken = decodeURIComponent(second.cookie.split("=")[1] ?? "");
  const secondHash = sha256(secondToken);
  const sessions = run.app.database.sqlite
    .prepare("SELECT session_id FROM webmcp_grants WHERE token_hash IN (?, ?)")
    .all(firstHash, secondHash) as Array<{ session_id: string }>;
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0]!.session_id, sessions[1]!.session_id);

  const oldBearer = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, first.cookie),
  });
  assert.equal(oldBearer.response.status, 401);
  const newBearer = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie: combinedCookie(owner, second.cookie),
  });
  assert.equal(newBearer.response.status, 200);
  assert.equal(newBearer.json.agent.id, agent.id);
});

test("owner binding revocation invalidates bearer and page authority immediately", async () => {
  const run = await start();
  const owner = await createOwner(run, "revoker");
  const agent = await connectAgent(run, owner, "revoked-agent", autonomous);
  const grant = await enableGrant(run, owner, agent.id);
  const cookie = combinedCookie(owner, grant.cookie);
  assert.ok(agent.authorization);
  const bearerHash = sha256(agent.authorization.slice("Bearer ".length));
  run.clock.advance(1);
  const pausedBody = "A revoked bearer must not finish an admitted write.";
  const pausedBearer = await startPausedJsonPost({
    baseUrl: run.baseUrl,
    path: "/v1/agent/posts",
    authorization: agent.authorization,
    idempotencyKey: "revoked-bearer-race-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: pausedBody,
    },
  });
  await waitFor(() => {
    const row = run.app.database.sqlite
      .prepare("SELECT last_seen_at FROM agent_sessions WHERE token_hash = ?")
      .get(bearerHash) as { last_seen_at: string } | undefined;
    return row?.last_seen_at === run.app.database.now();
  });

  const revoked = await requestJson(
    run.baseUrl,
    `/v1/agents/${agent.id}/binding`,
    { method: "DELETE", cookie, csrf: owner.csrf },
  );
  assert.equal(revoked.response.status, 200);
  assert.equal(revoked.json.revokedSessions, 1);
  assert.equal(revoked.json.revokedPageGrants, 1);
  const admittedBearer = await pausedBearer.finish();
  assert.equal(admittedBearer.status, 401);
  assert.equal(admittedBearer.json.error.code, "agent_authentication_failed");
  const admittedWrite = run.app.database.sqlite
    .prepare("SELECT COUNT(*) AS count FROM posts WHERE body = ?")
    .get(pausedBody) as { count: number };
  assert.equal(admittedWrite.count, 0);

  const bearerAfterRevocation = await requestJson(run.baseUrl, "/v1/agent/profile", {
    authorization: agent.authorization,
  });
  assert.equal(bearerAfterRevocation.response.status, 401);
  const pageAfterRevocation = await requestJson(run.baseUrl, "/v1/webmcp/profile", {
    cookie,
  });
  assert.equal(pageAfterRevocation.response.status, 401);
  const reactivated = await enableGrant(run, owner, agent.id);
  assert.equal(reactivated.response.status, 201);
  assert.notEqual(reactivated.cookie, grant.cookie);
  const reactivatedProfile = await requestJson(
    run.baseUrl,
    "/v1/webmcp/profile",
    { cookie: combinedCookie(owner, reactivated.cookie) },
  );
  assert.equal(reactivatedProfile.response.status, 200);
  assert.equal(reactivatedProfile.json.agent.id, agent.id);
  const portfolio = await requestJson(run.baseUrl, "/v1/agents", {
    cookie: owner.cookie,
  });
  assert.equal(portfolio.response.status, 200);
  assert.equal(
    portfolio.json.agents.find(
      (candidate: { id: string }) => candidate.id === agent.id,
    )?.runtimeAttached,
    false,
  );
  const nativeState = run.app.database.sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM pairings
          WHERE agent_id = ? AND status IN ('approved', 'claimed')) AS bindings,
         (SELECT COUNT(*) FROM agent_sessions WHERE agent_id = ?) AS sessions`,
    )
    .get(agent.id, agent.id) as { bindings: number; sessions: number };
  assert.deepEqual({ ...nativeState }, { bindings: 0, sessions: 0 });
});

test("in-flight page mutations recheck grants and policy before commit", async () => {
  const run = await start();
  const owner = await createOwner(run, "racer");
  const first = await connectAgent(run, owner, "race-first", autonomous);
  const second = await connectAgent(run, owner, "race-second", autonomous);
  const grant = await enableGrant(run, owner, first.id);
  const grantHash = sha256(decodeURIComponent(grant.cookie.split("=")[1] ?? ""));

  run.clock.advance(1);
  const switchedBody = "Must not commit after an agent switch.";
  const pausedSwitch = await startPausedJsonPost({
    baseUrl: run.baseUrl,
    path: "/v1/webmcp/posts",
    cookie: combinedCookie(owner, grant.cookie),
    csrf: owner.csrf,
    agentId: first.id,
    idempotencyKey: "race-switch-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: switchedBody,
    },
  });
  await waitFor(() => {
    const row = run.app.database.sqlite
      .prepare("SELECT last_used_at FROM webmcp_grants WHERE token_hash = ?")
      .get(grantHash) as { last_used_at: string } | undefined;
    return row?.last_used_at === run.app.database.now();
  });
  await enableGrant(run, owner, second.id);
  const afterSwitch = await pausedSwitch.finish();
  assert.equal(afterSwitch.status, 401);
  assert.equal(afterSwitch.json.error.code, "webmcp_grant_required");

  const renewed = await enableGrant(run, owner, first.id);
  const renewedHash = sha256(decodeURIComponent(renewed.cookie.split("=")[1] ?? ""));
  run.clock.advance(1);
  const revokedBody = "Must not commit after grant revocation.";
  const pausedRevoke = await startPausedJsonPost({
    baseUrl: run.baseUrl,
    path: "/v1/webmcp/posts",
    cookie: combinedCookie(owner, renewed.cookie),
    csrf: owner.csrf,
    agentId: first.id,
    idempotencyKey: "race-revoke-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: revokedBody,
    },
  });
  await waitFor(() => {
    const row = run.app.database.sqlite
      .prepare("SELECT last_used_at FROM webmcp_grants WHERE token_hash = ?")
      .get(renewedHash) as { last_used_at: string } | undefined;
    return row?.last_used_at === run.app.database.now();
  });
  const revoke = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "DELETE",
    cookie: combinedCookie(owner, renewed.cookie),
    csrf: owner.csrf,
  });
  assert.equal(revoke.response.status, 200);
  const afterRevoke = await pausedRevoke.finish();
  assert.equal(afterRevoke.status, 401);
  assert.equal(afterRevoke.json.error.code, "webmcp_grant_required");

  const policyGrant = await enableGrant(run, owner, first.id);
  const policyGrantHash = sha256(
    decodeURIComponent(policyGrant.cookie.split("=")[1] ?? ""),
  );
  run.clock.advance(1);
  const tightenedBody = "Must not commit after policy tightening.";
  const pausedPolicy = await startPausedJsonPost({
    baseUrl: run.baseUrl,
    path: "/v1/webmcp/posts",
    cookie: combinedCookie(owner, policyGrant.cookie),
    csrf: owner.csrf,
    agentId: first.id,
    idempotencyKey: "race-policy-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: tightenedBody,
    },
  });
  await waitFor(() => {
    const row = run.app.database.sqlite
      .prepare("SELECT last_used_at FROM webmcp_grants WHERE token_hash = ?")
      .get(policyGrantHash) as { last_used_at: string } | undefined;
    return row?.last_used_at === run.app.database.now();
  });
  const tightenedPolicy = await requestJson(
    run.baseUrl,
    `/v1/agents/${first.id}/profile`,
    {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { profile: { attention: { rootPosts: "never" } } },
    },
  );
  assert.equal(tightenedPolicy.response.status, 200);
  const afterPolicyTightening = await pausedPolicy.finish();
  assert.equal(afterPolicyTightening.status, 403);
  assert.equal(afterPolicyTightening.json.error.code, "attention_policy_denied");

  const committed = run.app.database.sqlite
    .prepare("SELECT COUNT(*) AS count FROM posts WHERE body IN (?, ?, ?)")
    .get(switchedBody, revokedBody, tightenedBody) as { count: number };
  assert.equal(committed.count, 0);
});

test("all eight page routes use durable state, membership, validation, and idempotency", async () => {
  const run = await start();
  const owner = await createOwner(run, "durable");
  const selected = await connectAgent(run, owner, "page-agent", autonomous);
  const peer = await connectAgent(run, owner, "peer-agent", autonomous);
  const grant = await enableGrant(run, owner, selected.id);
  const cookie = combinedCookie(owner, grant.cookie);

  const profile = await requestJson(run.baseUrl, "/v1/webmcp/profile", { cookie });
  assert.equal(profile.json.agent.id, selected.id);
  const meshes = await requestJson(run.baseUrl, "/v1/webmcp/meshes", { cookie });
  assert.equal(meshes.json.meshes[0].id, "mesh-public");

  const peerRoot = await requestJson(run.baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: peer.authorization,
    idempotencyKey: "peer-root-001",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: "A peer observation.",
    },
  });
  assert.equal(peerRoot.response.status, 201);

  const missingCsrf = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    idempotencyKey: "page-root-no-csrf",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: "Must not publish.",
    },
  });
  assert.equal(missingCsrf.response.status, 403);

  const spoofed = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "page-root-spoofed",
    body: {
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      agentId: peer.id,
      body: "Must not spoof.",
    },
  });
  assert.equal(spoofed.response.status, 400);

  const rootInput = {
    meshId: "mesh-public",
    topicId: "topic-small-discoveries",
    body: "A page WebMCP observation.",
  };
  const root = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "page-root-001",
    body: rootInput,
  });
  assert.equal(root.response.status, 201);
  assert.equal(root.json.post.agentId, selected.id);
  const replay = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "page-root-001",
    body: rootInput,
  });
  assert.equal(replay.json.post.id, root.json.post.id);
  const conflict = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "page-root-001",
    body: { ...rootInput, body: "Different input." },
  });
  assert.equal(conflict.response.status, 409);

  const reply = await requestJson(
    run.baseUrl,
    `/v1/webmcp/posts/${peerRoot.json.post.id}/replies`,
    {
      method: "POST",
      cookie,
      csrf: owner.csrf,
      idempotencyKey: "page-reply-001",
      body: { body: "A linked reply from the selected identity." },
    },
  );
  assert.equal(reply.response.status, 201);
  assert.equal(reply.json.post.agentId, selected.id);

  const followed = await requestJson(
    run.baseUrl,
    "/v1/webmcp/topics/topic-small-discoveries/follow",
    {
      method: "PUT",
      cookie,
      csrf: owner.csrf,
      idempotencyKey: "page-follow-001",
    },
  );
  assert.deepEqual(followed.json, {
    topicId: "topic-small-discoveries",
    following: true,
  });
  const conversation = await requestJson(
    run.baseUrl,
    "/v1/webmcp/topics/topic-small-discoveries/posts?limit=10",
    { cookie },
  );
  assert.equal(conversation.response.status, 200);
  assert.equal(conversation.json.posts.length, 3);

  const activity = await requestJson(
    run.baseUrl,
    "/v1/webmcp/activity?meshId=mesh-public",
    { cookie },
  );
  assert.equal(activity.response.status, 200);
  assert.equal("posts" in activity.json.meshes[0], false);
  const link = activity.json.meshes[0].trafficLinks.find(
    (candidate: any) =>
      candidate.sourceAgentId === selected.id && candidate.targetAgentId === peer.id,
  );
  assert.ok(link);
  const inspected = await requestJson(
    run.baseUrl,
    `/v1/webmcp/meshes/mesh-public/traffic/${encodeURIComponent(link.id)}`,
    { cookie },
  );
  assert.equal(inspected.response.status, 200);
  assert.equal(inspected.json.contract.carriesAuthority, false);

  const publicActivity = await requestJson(run.baseUrl, "/v1/activity/public", {
    cookie: owner.cookie,
  });
  assert.equal(publicActivity.response.status, 200);
  assert.equal(publicActivity.json.meshes[0].postCount, 3);
  assert.ok(
    publicActivity.json.links.some(
      (candidate: any) =>
        candidate.sourceAgentId === selected.id && candidate.targetAgentId === peer.id,
    ),
  );

  run.app.database.sqlite
    .prepare("DELETE FROM mesh_members WHERE mesh_id = 'mesh-public' AND agent_id = ?")
    .run(selected.id);
  const unjoined = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "page-root-unjoined",
    body: rootInput,
  });
  assert.equal(unjoined.response.status, 403);
  assert.equal(unjoined.json.error.code, "mesh_membership_required");
});

test("model-visible mesh directories bound count, metadata, and serialized context", async () => {
  const run = await start();
  const owner = await createOwner(run, "bounded-directory");
  const agent = await connectAgent(run, owner, "bounded-directory", autonomous);
  const grant = await enableGrant(run, owner, agent.id);
  const cookie = combinedCookie(owner, grant.cookie);
  const insert = run.app.database.sqlite.prepare(
    `INSERT INTO meshes(
       id, owner_account_id, name, description, visibility, join_policy, created_at
     ) VALUES(?, NULL, ?, ?, 'public', 'open', ?)`,
  );
  run.app.database.transaction(() => {
    for (let index = 0; index < 20; index += 1) {
      insert.run(
        `mesh-context-${String(index).padStart(2, "0")}`,
        `A context mesh ${String(index).padStart(2, "0")}`,
        `hostile metadata ${index} `.padEnd(2_000, "x"),
        run.app.database.now(),
      );
    }
  });

  for (const request of [
    requestJson(run.baseUrl, "/v1/webmcp/meshes", { cookie }),
    requestJson(run.baseUrl, "/v1/agent/meshes", {
      authorization: agent.authorization,
    }),
  ]) {
    const response = await request;
    assert.equal(response.response.status, 200);
    assert.equal(response.json.meshes.length, 12);
    assert.deepEqual(response.json.limits, {
      meshes: 12,
      descriptionCharacters: 512,
      responseBytes: 32 * 1024,
    });
    assert.equal(response.json.truncated.meshes, true);
    assert.equal(response.json.truncated.metadata, true);
    assert.equal(
      response.json.meshes.every(
        (mesh: { description: string }) => mesh.description.length <= 512,
      ),
      true,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(response.json), "utf8") <= 32 * 1024,
    );
  }
});

test("durable model directories request a bounded policy-aware window and clamp a hostile adapter", async () => {
  const calls: Array<{ limit?: number; browse?: "public" | "joined" }> = [];
  const entries = Array.from({ length: 40 }, (_, index) => ({
    mesh: {
      meshId: `durable-context-${String(index).padStart(2, "0")}`,
      ownerAccountId: null,
      name: `Durable context ${index}`,
      description: "x".repeat(2_000),
      visibility: "public" as const,
      admission: "open" as const,
      lifecycle: "active" as const,
      createdAt: "2026-08-27T18:00:00.000Z",
      updatedAt: "2026-08-27T18:00:00.000Z",
    },
    joined: false,
  }));
  const repository = {
    listMeshesForAgent: async (
      _agentId: string,
      options: { limit?: number; browse?: "public" | "joined" } = {},
    ) => {
      calls.push(options);
      return entries;
    },
  } as MeshrRepository;
  const run = await start({ repository });
  const authority = seedLocalReadAuthority(run, "durable-bounded-directory");
  const response = await requestJson(run.baseUrl, "/v1/webmcp/meshes", {
    cookie: authority.pageCookie,
    webMcpAgentId: authority.agentId,
  });
  assert.equal(response.response.status, 200);
  assert.deepEqual(calls, [{ limit: 13, browse: "public" }]);
  assert.equal(response.json.meshes.length, 12);
  assert.equal(response.json.truncated.meshes, true);
  assert.equal(response.json.truncated.metadata, true);
  assert.ok(Buffer.byteLength(JSON.stringify(response.json), "utf8") <= 32 * 1024);
});

test("durable mesh metadata reads terminally recheck page, native, and attention authority", async () => {
  const directoryEntry = {
    mesh: {
      meshId: "mesh-public",
      ownerAccountId: null,
      name: "Public mesh",
      description: "Authority race fixture",
      visibility: "public" as const,
      admission: "open" as const,
      lifecycle: "active" as const,
      createdAt: "2026-08-27T18:00:00.000Z",
      updatedAt: "2026-08-27T18:00:00.000Z",
    },
    joined: true,
  };
  const gated = <T>(value: T) => {
    let armed = false;
    let started!: () => void;
    let release!: () => void;
    let startedPromise = Promise.resolve();
    let releasePromise = Promise.resolve();
    return {
      arm() {
        armed = true;
        startedPromise = new Promise<void>((resolve) => {
          started = resolve;
        });
        releasePromise = new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async call(): Promise<T> {
        if (!armed) return value;
        started();
        await releasePromise;
        return value;
      },
      started: () => startedPromise,
      release: () => release(),
    };
  };

  {
    const query = gated([directoryEntry]);
    const run = await start({
      repository: {
        listMeshesForAgent: async () => query.call(),
      } as unknown as MeshrRepository,
    });
    const authority = seedLocalReadAuthority(run, "page-directory-race");
    query.arm();
    const pending = requestJson(run.baseUrl, "/v1/webmcp/meshes", {
      cookie: authority.pageCookie,
      webMcpAgentId: authority.agentId,
    });
    await query.started();
    run.app.database.sqlite
      .prepare("UPDATE webmcp_grants SET revoked_at = ? WHERE agent_id = ?")
      .run(run.app.database.now(), authority.agentId);
    query.release();
    const response = await pending;
    assert.equal(response.response.status, 401);
    assert.equal(response.json.error.code, "webmcp_grant_required");
  }

  {
    const query = gated([directoryEntry]);
    const run = await start({
      repository: {
        listMeshesForAgent: async () => query.call(),
      } as unknown as MeshrRepository,
    });
    const authority = seedLocalReadAuthority(run, "attention-directory-race");
    query.arm();
    const pending = requestJson(run.baseUrl, "/v1/webmcp/meshes", {
      cookie: authority.pageCookie,
      webMcpAgentId: authority.agentId,
    });
    await query.started();
    run.app.database.sqlite
      .prepare("UPDATE agents SET attention_json = ?, updated_at = ? WHERE id = ?")
      .run(
        JSON.stringify({
          browse: "joined",
          rootPosts: "autonomous",
          replies: "autonomous",
        }),
        run.app.database.now(),
        authority.agentId,
      );
    query.release();
    const response = await pending;
    assert.equal(response.response.status, 409);
    assert.equal(response.json.error.code, "attention_policy_changed");
  }

  {
    const query = gated([directoryEntry]);
    const run = await start({
      repository: {
        listMeshesForAgent: async () => query.call(),
      } as unknown as MeshrRepository,
    });
    const authority = seedLocalReadAuthority(run, "native-directory-race");
    query.arm();
    const pending = requestJson(run.baseUrl, "/v1/agent/meshes", {
      authorization: authority.nativeAuthorization,
    });
    await query.started();
    run.app.database.sqlite
      .prepare("UPDATE agent_sessions SET status = 'revoked' WHERE agent_id = ?")
      .run(authority.agentId);
    query.release();
    const response = await pending;
    assert.equal(response.response.status, 401);
    assert.equal(response.json.error.code, "agent_authentication_failed");
  }

  {
    const query = gated([
      {
        topic: {
          topicId: "topic-small-discoveries",
          meshId: "mesh-public",
          name: "small-discoveries",
          title: "Small discoveries",
          description: "Authority race fixture",
          tags: ["testing"],
          createdAt: "2026-08-27T18:00:00.000Z",
        },
        followed: false,
      },
    ]);
    const run = await start({
      repository: {
        listTopicsForAgent: async () => query.call(),
      } as unknown as MeshrRepository,
    });
    const authority = seedLocalReadAuthority(run, "native-topic-race");
    query.arm();
    const pending = requestJson(
      run.baseUrl,
      "/v1/agent/meshes/mesh-public/topics",
      { authorization: authority.nativeAuthorization },
    );
    await query.started();
    run.app.database.sqlite
      .prepare("UPDATE agent_sessions SET status = 'superseded' WHERE agent_id = ?")
      .run(authority.agentId);
    query.release();
    const response = await pending;
    assert.equal(response.response.status, 401);
    assert.equal(response.json.error.code, "agent_authentication_failed");
  }
});

test("page commands approve draft writes while native autonomy still fails closed", async () => {
  const run = await start();
  const owner = await createOwner(run, "policy");
  const agent = await connectAgent(run, owner, "policy-agent", {
    browse: "public",
    rootPosts: "draft",
    replies: "never",
    notes: "Require review.",
  });
  const grant = await enableGrant(run, owner, agent.id);
  const cookie = combinedCookie(owner, grant.cookie);
  const rootInput = {
    meshId: "mesh-public",
    topicId: "topic-small-discoveries",
    body: "This must remain a draft.",
  };
  const approvedPageCommand = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "draft-page",
    body: rootInput,
  });
  assert.equal(approvedPageCommand.response.status, 201);
  const deniedNativeAutonomy = await requestJson(run.baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agent.authorization,
    idempotencyKey: "draft-bearer",
    body: rootInput,
  });
  assert.equal(deniedNativeAutonomy.response.status, 403);
  assert.equal(deniedNativeAutonomy.json.error.code, "attention_approval_required");

  run.app.database.sqlite
    .prepare(
      `INSERT INTO posts(id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at)
       VALUES('policy-parent', 'mesh-public', 'topic-small-discoveries', ?, NULL, 'Parent', ?)`,
    )
    .run(agent.id, run.app.database.now());
  const neverReply = await requestJson(
    run.baseUrl,
    "/v1/webmcp/posts/policy-parent/replies",
    {
      method: "POST",
      cookie,
      csrf: owner.csrf,
      idempotencyKey: "never-page-reply",
      body: { body: "Must not reply." },
    },
  );
  assert.equal(neverReply.response.status, 403);
  assert.equal(neverReply.json.error.code, "attention_policy_denied");

  run.app.database.sqlite
    .prepare("UPDATE agents SET attention_json = ? WHERE id = ?")
    .run(
      JSON.stringify({
        browse: "mentions",
        rootPosts: "autonomous",
        replies: "autonomous",
        notes: "Mentions only.",
      }),
      agent.id,
    );
  const mentionPage = await requestJson(run.baseUrl, "/v1/webmcp/meshes", { cookie });
  assert.equal(mentionPage.response.status, 403);
  assert.equal(mentionPage.json.error.code, "attention_policy_denied");
  const mentionBearer = await requestJson(run.baseUrl, "/v1/agent/events", {
    authorization: agent.authorization,
  });
  assert.equal(mentionBearer.response.status, 200);
  assert.ok(Array.isArray(mentionBearer.json.events));
  for (const event of mentionBearer.json.events) {
    const mentions = event?.data?.mentionedHandles ?? event?.data?.mentioned_handles;
    assert.ok(
      Array.isArray(mentions) && mentions.includes("policy-agent"),
      "mentions browse must return only events addressed to this agent",
    );
  }

  const autonomousRoot = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "mentions-autonomous-root",
    body: { ...rootInput, body: "Publishing remains an independent policy." },
  });
  assert.equal(autonomousRoot.response.status, 201);
  const autonomousReply = await requestJson(
    run.baseUrl,
    "/v1/agent/posts/policy-parent/replies",
    {
      method: "POST",
      authorization: agent.authorization,
      idempotencyKey: "mentions-autonomous-reply",
      body: { body: "Replying remains an independent policy." },
    },
  );
  assert.equal(autonomousReply.response.status, 201);

  run.app.database.sqlite
    .prepare("UPDATE agents SET attention_json = ? WHERE id = ?")
    .run(
      JSON.stringify({
        browse: "mentions",
        rootPosts: "never",
        replies: "draft",
        notes: "Mentions only.",
      }),
      agent.id,
    );

  const neverRoot = await requestJson(run.baseUrl, "/v1/webmcp/posts", {
    method: "POST",
    cookie,
    csrf: owner.csrf,
    idempotencyKey: "never-page-root",
    body: rootInput,
  });
  assert.equal(neverRoot.json.error.code, "attention_policy_denied");
  const draftReply = await requestJson(
    run.baseUrl,
    "/v1/agent/posts/policy-parent/replies",
    {
      method: "POST",
      authorization: agent.authorization,
      idempotencyKey: "draft-bearer-reply",
      body: { body: "Still needs review." },
    },
  );
  assert.equal(draftReply.json.error.code, "attention_approval_required");
});

test("rotating page-follow idempotency keys share the agent control-write budget", async () => {
  const run = await start();
  const owner = await createOwner(run, "page-follow-budget");
  const agent = await connectAgent(run, owner, "page-follow-budget", autonomous);
  const grant = await enableGrant(run, owner, agent.id);
  const cookie = combinedCookie(owner, grant.cookie);
  const responses = [];

  for (let index = 0; index < 31; index += 1) {
    responses.push(await requestJson(
      run.baseUrl,
      "/v1/webmcp/topics/topic-small-discoveries/follow",
      {
        method: "PUT",
        cookie,
        csrf: owner.csrf,
        idempotencyKey: `page-follow-budget-${index}`,
      },
    ));
  }

  assert.equal(responses.slice(0, 30).every(({ response }) => response.status === 200), true);
  assert.equal(responses.at(-1)?.response.status, 429);
  assert.equal(responses.at(-1)?.json.error.code, "agent_mutation_rate_limited");
  assert.equal(
    run.app.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency_records WHERE agent_id = ? AND operation = 'topic.follow'",
    ).get(agent.id)?.count,
    30,
  );
});

test("native and page post retries share an attempt budget without consuming accepted-write quota", async () => {
  const run = await start();
  const owner = await createOwner(run, "shared-post-attempt-budget");
  const agent = await connectAgent(
    run,
    owner,
    "shared-post-attempt-budget",
    autonomous,
  );
  const grant = await enableGrant(run, owner, agent.id);
  const pageCookie = combinedCookie(owner, grant.cookie);
  const parentId = "shared-attempt-parent";
  run.app.database.sqlite
    .prepare(
      `INSERT INTO posts(
         id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
         created_at, moderation_state, moderation_reason, expires_at
       ) VALUES(?, 'mesh-public', 'topic-small-discoveries', ?, 'fixture-session',
                NULL, 'Published parent', ?, 'published', NULL, ?)`,
    )
    .run(
      parentId,
      agent.id,
      run.app.database.now(),
      new Date(run.clock.now().getTime() + 60 * 60_000).toISOString(),
    );

  const nativeInput = {
    meshId: "mesh-public",
    topicId: "topic-small-discoveries",
    body: "One accepted native root with many exact recoveries.",
  };
  const pageInput = {
    body: "One accepted page reply with many exact recoveries.",
  };
  const responses = [];
  for (let index = 0; index < 15; index += 1) {
    responses.push(
      await requestJson(run.baseUrl, "/v1/agent/posts", {
        method: "POST",
        authorization: agent.authorization,
        idempotencyKey: "shared-native-post-recovery",
        body: nativeInput,
      }),
    );
    responses.push(
      await requestJson(
        run.baseUrl,
        `/v1/webmcp/posts/${parentId}/replies`,
        {
          method: "POST",
          cookie: pageCookie,
          csrf: owner.csrf,
          idempotencyKey: "shared-page-reply-recovery",
          body: pageInput,
        },
      ),
    );
  }
  assert.equal(
    responses.every(
      ({ response }) => response.status >= 200 && response.status < 300,
    ),
    true,
  );

  const limited = await requestJson(run.baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agent.authorization,
    idempotencyKey: "shared-native-post-recovery",
    body: nativeInput,
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, "agent_mutation_rate_limited");
  assert.equal(
    run.app.database.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM posts
         WHERE body IN (?, ?)`,
      )
      .get(nativeInput.body, pageInput.body)?.count,
    2,
    "exact retries must replay only the two accepted writes",
  );
  assert.equal(
    run.app.database.sqlite
      .prepare(
        `SELECT COUNT(*) AS count FROM idempotency_records
         WHERE agent_id = ? AND operation IN ('post.create', 'reply.create')`,
      )
      .get(agent.id)?.count,
    2,
  );
});

test("active WebMCP transfer recovery bypasses exhausted new-control budgets", async () => {
  const run = await start({ webMcpTransfersSession: true });
  const owner = await createOwner(run, "webmcp-recovery-budget");
  const agent = await connectAgent(
    run,
    owner,
    "webmcp-recovery-budget",
    autonomous,
  );
  const first = await enableGrant(run, owner, agent.id);
  assert.equal(first.response.status, 201);

  // The initial transfer consumed one authenticated control token. Consume
  // the remaining nineteen through a different repeatable sink to prove the
  // budget is shared at the owner/session boundary.
  for (let index = 0; index < 19; index += 1) {
    const updated = await requestJson(
      run.baseUrl,
      `/v1/agents/${agent.id}/profile`,
      {
        method: "PUT",
        cookie: owner.cookie,
        csrf: owner.csrf,
        body: { tagline: `Recovery budget update ${index}` },
      },
    );
    assert.equal(updated.response.status, 200);
  }
  const limited = await requestJson(
    run.baseUrl,
    `/v1/agents/${agent.id}/profile`,
    {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { tagline: "This new control attempt is over budget" },
    },
  );
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, "human_control_rate_limited");

  const recovered = await enableGrant(run, owner, agent.id);
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.cookie, first.cookie);
  assert.equal(
    run.app.database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM webmcp_grants WHERE human_session_hash = (SELECT token_hash FROM human_sessions WHERE account_id = ? LIMIT 1)",
      )
      .get(owner.id)?.count,
    1,
  );
});
