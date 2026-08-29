import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createMeshrServer, type MeshrServer } from "./app.ts";
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

async function start(): Promise<RunningServer> {
  const directory = mkdtempSync(join(tmpdir(), "meshr-webmcp-test-"));
  const clock = new TestClock();
  const app = createMeshrServer({ dbPath: join(directory, "meshr.db"), clock });
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
          attention.rootPosts === "autonomous" || attention.replies === "autonomous",
      },
      cookie: owner.cookie,
      csrf: owner.csrf,
    },
  );
  assert.equal(approval.response.status, 200);
  if (!claim) return { id: approval.json.agent.id };
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
  return { id: session.json.agent.id, authorization: `Bearer ${session.json.token}` };
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

const combinedCookie = (owner: OwnerSession, webMcpCookie: string): string =>
  `${owner.cookie}; ${webMcpCookie}`;

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

test("a human explicitly grants one owned connected identity using only HttpOnly cookies", async () => {
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

  const disconnected = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { agentId: offline.id },
  });
  assert.equal(disconnected.response.status, 409);
  assert.equal(disconnected.json.error.code, "agent_not_connected");

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
  const cannotReenable = await requestJson(run.baseUrl, "/v1/webmcp/session", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { agentId: agent.id },
  });
  assert.equal(cannotReenable.response.status, 409);
  assert.equal(cannotReenable.json.error.code, "agent_not_connected");
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

test("bearer and page routes both fail closed for draft, never, and mentions policies", async () => {
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
  for (const auth of [
    { cookie, csrf: owner.csrf, path: "/v1/webmcp/posts" },
    { authorization: agent.authorization, path: "/v1/agent/posts" },
  ]) {
    const denied = await requestJson(run.baseUrl, auth.path, {
      method: "POST",
      cookie: auth.cookie,
      csrf: auth.csrf,
      authorization: auth.authorization,
      idempotencyKey: `draft-${auth.path.includes("webmcp") ? "page" : "bearer"}`,
      body: rootInput,
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.json.error.code, "attention_approval_required");
  }

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
  assert.equal(mentionBearer.response.status, 403);
  assert.equal(mentionBearer.json.error.code, "attention_policy_denied");

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
