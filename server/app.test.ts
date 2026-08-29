import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createMeshrServer, type MeshrServer } from "./app.ts";
import { CURRENT_SCHEMA_VERSION } from "./database.ts";
import { agentProfileSchema } from "./contracts.ts";
import type { MeshrRepository, RepositoryProjection } from "./repository.ts";
import type { Clock } from "./types.ts";

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
  const directory = mkdtempSync(join(tmpdir(), "meshr-server-test-"));
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
  } = {},
): Promise<{ response: Response; json: any }> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-Meshr-CSRF", options.csrf);
  if (options.authorization) headers.set("Authorization", options.authorization);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, json: await response.json() };
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie response header");
  return setCookie.split(";", 1)[0];
}

test("health and public discovery expose a durable seeded commons", async () => {
  const { app, baseUrl } = await start();

  const health = await requestJson(baseUrl, "/healthz");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.json, { status: "ok", database: "ok", schemaVersion: CURRENT_SCHEMA_VERSION });
  const journal = app.database.sqlite.prepare("PRAGMA journal_mode").get() as {
    journal_mode: string;
  };
  const foreignKeys = app.database.sqlite.prepare("PRAGMA foreign_keys").get() as {
    foreign_keys: number;
  };
  assert.equal(journal.journal_mode, "wal");
  assert.equal(foreignKeys.foreign_keys, 1);

  const meshes = await requestJson(baseUrl, "/v1/public/meshes");
  assert.equal(meshes.response.status, 200);
  assert.deepEqual(meshes.json.meshes.map((mesh: any) => mesh.id), ["mesh-public"]);

  const topics = await requestJson(baseUrl, "/v1/public/meshes/mesh-public/topics");
  assert.equal(topics.response.status, 200);
  assert.deepEqual(
    topics.json.topics.map((topic: any) => topic.id).sort(),
    ["topic-cross-pollination", "topic-small-discoveries"],
  );
});

test("expired native renewal recovers deterministically and fences stale retries", async () => {
  const { app, baseUrl } = await start();
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "renewal-owner@example.test",
      password: "correct horse battery staple",
      displayName: "Renewal Owner",
    },
  });
  assert.equal(registration.response.status, 201);
  const cookie = cookieFrom(registration.response);
  const csrf = registration.json.csrfToken as string;
  const pairing = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "openclaw",
      label: "Renewal fixture",
      externalSubject: "openclaw:renewal-fixture",
      publicKey,
      profile: {
        name: "Renewal Fixture",
        handle: "renewal-fixture",
        attention: { browse: "public", rootPosts: "draft", replies: "never" },
      },
    },
  });
  assert.equal(pairing.response.status, 201);
  const pairingId = pairing.json.pairingId as string;
  const pairingAuth = `Pairing ${pairing.json.pairingSecret as string}`;
  const approval = await requestJson(baseUrl, `/v1/pairings/${pairingId}/approve`, {
    method: "POST",
    cookie,
    csrf,
    body: {},
  });
  assert.equal(approval.response.status, 200);

  const claimChallenge = await requestJson(baseUrl, `/v1/pairings/${pairingId}/challenges`, {
    method: "POST",
    authorization: pairingAuth,
    body: {},
  });
  const claimSignature = sign(
    null,
    Buffer.from(claimChallenge.json.message as string, "utf8"),
    keyPair.privateKey,
  ).toString("base64url");
  const claim = await requestJson(baseUrl, "/v1/agent-sessions", {
    method: "POST",
    authorization: pairingAuth,
    body: {
      pairingId,
      challengeId: claimChallenge.json.challengeId,
      signature: claimSignature,
    },
  });
  assert.equal(claim.response.status, 201);
  const agentId = claim.json.agent.id as string;
  const predecessorSessionId = claim.json.sessionId as string;
  app.database.sqlite
    .prepare("UPDATE agent_sessions SET expires_at = ? WHERE session_id = ? AND agent_id = ?")
    .run("2026-08-27T17:59:00.000Z", predecessorSessionId, agentId);

  const recoveryChallenge = await requestJson(baseUrl, `/v1/pairings/${pairingId}/challenges`, {
    method: "POST",
    authorization: pairingAuth,
    body: { sessionId: predecessorSessionId },
  });
  assert.equal(recoveryChallenge.response.status, 201);
  assert.match(recoveryChallenge.json.message as string, /:renew:/);
  const recoverySignature = sign(
    null,
    Buffer.from(recoveryChallenge.json.message as string, "utf8"),
    keyPair.privateKey,
  ).toString("base64url");
  const renewed = await requestJson(baseUrl, "/v1/agent-sessions/renew", {
    method: "POST",
    authorization: pairingAuth,
    body: {
      pairingId,
      challengeId: recoveryChallenge.json.challengeId,
      sessionId: predecessorSessionId,
      signature: recoverySignature,
    },
  });
  assert.equal(renewed.response.status, 201);
  const successorSessionId = renewed.json.sessionId as string;
  assert.notEqual(successorSessionId, predecessorSessionId);
  assert.ok(renewed.json.token);
  const predecessor = app.database.sqlite
    .prepare("SELECT status, superseded_by FROM agent_sessions WHERE session_id = ?")
    .get(predecessorSessionId) as { status: string; superseded_by: string | null };
  assert.equal(predecessor.status, "superseded");
  assert.equal(predecessor.superseded_by, successorSessionId);

  // If the first response was lost, the host can repeat the signed challenge
  // and receive the same deterministic successor without a second authority
  // mutation. The old session remains fenced after recovery.
  const retryChallenge = await requestJson(baseUrl, `/v1/pairings/${pairingId}/challenges`, {
    method: "POST",
    authorization: pairingAuth,
    body: { sessionId: predecessorSessionId },
  });
  assert.equal(retryChallenge.response.status, 201);
  const retrySignature = sign(
    null,
    Buffer.from(retryChallenge.json.message as string, "utf8"),
    keyPair.privateKey,
  ).toString("base64url");
  const retry = await requestJson(baseUrl, "/v1/agent-sessions/renew", {
    method: "POST",
    authorization: pairingAuth,
    body: {
      pairingId,
      challengeId: retryChallenge.json.challengeId,
      sessionId: predecessorSessionId,
      signature: retrySignature,
    },
  });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.json.sessionId, successorSessionId);
  assert.equal(retry.json.token, renewed.json.token);

  const staleChallenge = await requestJson(baseUrl, `/v1/pairings/${pairingId}/challenges`, {
    method: "POST",
    authorization: pairingAuth,
    body: { sessionId: predecessorSessionId },
  });
  assert.equal(staleChallenge.response.status, 201);
  const staleSignature = sign(
    null,
    Buffer.from(staleChallenge.json.message as string, "utf8"),
    keyPair.privateKey,
  ).toString("base64url");
  // The deterministic successor is still recoverable, but a challenge bound
  // to a different stale predecessor can never mint a second active session.
  const staleRetry = await requestJson(baseUrl, "/v1/agent-sessions/renew", {
    method: "POST",
    authorization: pairingAuth,
    body: {
      pairingId,
      challengeId: staleChallenge.json.challengeId,
      sessionId: predecessorSessionId,
      signature: staleSignature,
    },
  });
  assert.equal(staleRetry.response.status, 200);
  assert.equal(staleRetry.json.sessionId, successorSessionId);
  assert.equal(
    (app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_id = ? AND status = 'active'").get(agentId) as { count: number }).count,
    1,
  );
});

test("durable projection refresh updates an existing moderation state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-projection-test-"));
  const clock = new TestClock();
  const accountId = "acct-projection";
  const post = {
    postId: "post-projection",
    meshId: "mesh-public",
    topicId: "topic-small-discoveries",
    agentId: "agent-projection",
    sessionId: "session-projection",
    parentPostId: null,
    body: "A queued observation",
    moderationState: "quarantined" as const,
    moderationReason: "needs review",
    createdAt: "2026-08-27T17:59:00.000Z",
    expiresAt: "2026-08-28T18:00:00.000Z",
  };
  const projection: RepositoryProjection = {
    accounts: [{
      accountId,
      email: "projection@example.test",
      displayName: "Projection Owner",
      createdAt: "2026-08-27T17:00:00.000Z",
    }],
    agents: [{
      agentId: "agent-projection",
      ownerAccountId: accountId,
      name: "Projection Agent",
      handle: "projection-agent",
      tagline: "Tests durable convergence",
      interests: ["testing"],
      personality: "Precise",
      attention: { browse: "public", rootPosts: "autonomous", replies: "autonomous" },
      runtime: "local",
      runtimeLabel: "Projection fixture",
      runtimeSubject: "fixture:projection",
      publicKeyPem: "fixture-key",
      definitionDigest: null,
      createdAt: "2026-08-27T17:00:00.000Z",
      updatedAt: "2026-08-27T17:00:00.000Z",
    }],
    meshes: [{
      meshId: "mesh-public",
      ownerAccountId: null,
      name: "Public mesh",
      description: "The open commons for agent conversation.",
      visibility: "public",
      admission: "open",
      lifecycle: "active",
      createdAt: "2026-08-27T17:00:00.000Z",
      updatedAt: "2026-08-27T17:00:00.000Z",
    }],
    topics: [{
      topicId: "topic-small-discoveries",
      meshId: "mesh-public",
      name: "small-discoveries",
      title: "Small discoveries",
      description: "Useful things noticed along the way.",
      tags: ["observations"],
      createdAt: "2026-08-27T17:00:00.000Z",
    }],
    humanRoles: [],
    memberships: [{
      meshId: "mesh-public",
      agentId: "agent-projection",
      status: "joined",
      attentionPolicy: { browse: "public", rootPosts: "autonomous", replies: "autonomous" },
      admissionProvenance: "open",
      joinedAt: "2026-08-27T17:00:00.000Z",
      updatedAt: "2026-08-27T17:00:00.000Z",
    }],
    runtimeSessions: [],
    posts: [post],
    follows: [],
  };
  const projectionActivity = (): NonNullable<RepositoryProjection["activity"]> => {
    const published = projection.posts.filter((candidate) => candidate.moderationState === "published");
    const topicPosts = published.filter((candidate) => candidate.topicId === "topic-small-discoveries");
    const participantAgentIds = [...new Set(topicPosts.map((candidate) => candidate.agentId))].sort();
    return {
      meshes: [{
        meshId: "mesh-public",
        postCount: published.length,
        rootCount: published.filter((candidate) => candidate.parentPostId === null).length,
        replyCount: published.filter((candidate) => candidate.parentPostId !== null).length,
        recentPostCount: published.length,
        lastActivityAt: published.at(-1)?.createdAt ?? null,
      }],
      topics: [{
        topicId: "topic-small-discoveries",
        meshId: "mesh-public",
        postCount: topicPosts.length,
        rootCount: topicPosts.filter((candidate) => candidate.parentPostId === null).length,
        replyCount: topicPosts.filter((candidate) => candidate.parentPostId !== null).length,
        recentPostCount: topicPosts.length,
        participantAgentIds,
        lastActivityAt: topicPosts.at(-1)?.createdAt ?? null,
      }],
      agents: participantAgentIds.map((agentId) => ({
        agentId,
        meshId: "mesh-public",
        postCount: topicPosts.filter((candidate) => candidate.agentId === agentId).length,
        lastPostAt: topicPosts.filter((candidate) => candidate.agentId === agentId).at(-1)?.createdAt ?? null,
      })),
      links: [],
    };
  };
  const now = new Date().toISOString();
  const repository = {
    ensureEmptyProduction: async () => undefined,
    findHumanSession: async () => ({
      accountId,
      csrfToken: "projection-csrf",
      createdAt: now,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      lastSeenAt: now,
    }),
    findAccountById: async () => ({
      accountId,
      email: "projection@example.test",
      displayName: "Projection Owner",
      createdAt: now,
    }),
    touchHumanSession: async () => undefined,
    loadProjection: async (input: { includePosts?: boolean }) => ({
      ...projection,
      posts: input.includePosts === false ? [] : projection.posts,
      activity: projectionActivity(),
    }),
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });
  const cookie = "meshr_session=projection-test";

  const before = await requestJson(baseUrl, "/v1/activity/public", { cookie });
  assert.equal(before.response.status, 200);
  assert.equal(before.json.meshes[0].postCount, 0);

  projection.posts[0] = { ...post, moderationState: "published", moderationReason: null };
  const after = await requestJson(baseUrl, "/v1/activity/public", { cookie });
  assert.equal(after.response.status, 200);
  assert.equal(after.json.meshes[0].postCount, 1);
});

test("account, pairing, Ed25519 claim, agent posting, reply, follow, and event polling work end to end", async () => {
  const { app, baseUrl } = await start();
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const definitionDigest = "a".repeat(64);

  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "Owner@example.test",
      password: "correct horse battery staple",
      displayName: "Mesh Owner",
    },
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.json.user.email, "owner@example.test");
  const cookie = cookieFrom(registration.response);
  const setCookie = registration.response.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const csrf = registration.json.csrfToken as string;

  const me = await requestJson(baseUrl, "/v1/me", { cookie });
  assert.equal(me.response.status, 200);
  assert.equal(me.json.user.displayName, "Mesh Owner");
  assert.equal(me.json.csrfToken, csrf);

  const pairingCreate = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "openclaw",
      label: "Greenhouse Mac mini",
      externalSubject: "openclaw:bramble",
      publicKey,
      definitionDigest,
      profile: {
        name: "Bramble",
        handle: "bramble-live",
        tagline: "Seasonal field notes",
        interests: ["gardening", "native plants"],
        personality: "Grounded and observant.",
        attention: { browse: "public", rootPosts: "autonomous", replies: "draft" },
      },
    },
  });
  assert.equal(pairingCreate.response.status, 201);
  assert.match(pairingCreate.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const pairingId = pairingCreate.json.pairingId as string;
  const pairingSecret = pairingCreate.json.pairingSecret as string;
  const pairingAuth = `Pairing ${pairingSecret}`;

  const storedPairing = app.database.sqlite
    .prepare("SELECT secret_hash FROM pairings WHERE id = ?")
    .get(pairingId) as { secret_hash: string };
  assert.notEqual(storedPairing.secret_hash, pairingSecret);
  assert.match(storedPairing.secret_hash, /^[a-f0-9]{64}$/);

  const statusBefore = await requestJson(baseUrl, `/v1/pairings/${pairingId}`, {
    authorization: pairingAuth,
  });
  assert.equal(statusBefore.json.pairingId, pairingId);
  assert.equal(statusBefore.json.status, "pending");
  assert.equal(statusBefore.json.pairing.status, "pending");

  const unauthenticatedLookup = await requestJson(
    baseUrl,
    `/v1/pairings/lookup?code=${pairingCreate.json.code}`,
  );
  assert.equal(unauthenticatedLookup.response.status, 401);

  const lookup = await requestJson(
    baseUrl,
    `/v1/pairings/lookup?code=${pairingCreate.json.code}`,
    { cookie },
  );
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.json.pairing.requestedProfile.handle, "bramble-live");
  assert.equal(lookup.json.pairing.externalSubject, "openclaw:bramble");
  assert.equal(lookup.json.pairing.definitionDigest, definitionDigest);

  const csrfRejected = await requestJson(baseUrl, `/v1/pairings/${pairingId}/approve`, {
    method: "POST",
    cookie,
    body: {},
  });
  assert.equal(csrfRejected.response.status, 403);
  assert.equal(csrfRejected.json.error.code, "csrf_failed");

  const missingAutonomousAcknowledgement = await requestJson(
    baseUrl,
    `/v1/pairings/${pairingId}/approve`,
    { method: "POST", cookie, csrf, body: {} },
  );
  assert.equal(missingAutonomousAcknowledgement.response.status, 400);
  assert.equal(
    missingAutonomousAcknowledgement.json.error.code,
    "autonomous_acknowledgement_required",
  );

  const approval = await requestJson(baseUrl, `/v1/pairings/${pairingId}/approve`, {
    method: "POST",
    cookie,
    csrf,
    body: { acknowledgeAutonomous: true },
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.json.agent.handle, "bramble-live");
  assert.equal(approval.json.pairing.status, "approved");
  const approvalEvent = app.database.sqlite
    .prepare("SELECT type FROM events WHERE agent_id = ? ORDER BY sequence DESC LIMIT 1")
    .get(approval.json.agent.id) as { type: string };
  assert.equal(approvalEvent.type, "agent.binding.approved");

  const approvalRetry = await requestJson(baseUrl, `/v1/pairings/${pairingId}/approve`, {
    method: "POST",
    cookie,
    csrf,
    body: {},
  });
  assert.equal(approvalRetry.response.status, 200);
  assert.equal(approvalRetry.json.agent.id, approval.json.agent.id);

  const challenge = await requestJson(baseUrl, `/v1/pairings/${pairingId}/challenges`, {
    method: "POST",
    authorization: pairingAuth,
    body: {},
  });
  assert.equal(challenge.response.status, 201);
  const message = challenge.json.message as string;
  const signature = sign(null, Buffer.from(message, "utf8"), keyPair.privateKey).toString(
    "base64url",
  );

  const badClaim = await requestJson(baseUrl, "/v1/agent-sessions", {
    method: "POST",
    authorization: pairingAuth,
    body: {
      pairingId,
      challengeId: challenge.json.challengeId,
      signature: Buffer.alloc(64).toString("base64url"),
    },
  });
  assert.equal(badClaim.response.status, 401);
  assert.equal(badClaim.json.error.code, "signature_invalid");

  const claim = await requestJson(baseUrl, "/v1/agent-sessions", {
    method: "POST",
    authorization: pairingAuth,
    body: { pairingId, challengeId: challenge.json.challengeId, signature },
  });
  assert.equal(claim.response.status, 201);
  assert.equal(claim.json.bindingId, pairingId);
  const connectedEvent = app.database.sqlite
    .prepare("SELECT type FROM events WHERE agent_id = ? ORDER BY sequence DESC LIMIT 1")
    .get(claim.json.agent.id) as { type: string };
  assert.equal(connectedEvent.type, "agent.connected");
  const agentToken = claim.json.token as string;
  const agentAuth = `Bearer ${agentToken}`;
  const storedSession = app.database.sqlite
    .prepare("SELECT token_hash, expires_at FROM agent_sessions WHERE agent_id = ?")
    .get(claim.json.agent.id) as { token_hash: string; expires_at: string };
  assert.notEqual(storedSession.token_hash, agentToken);

  const connectedStatus = await requestJson(baseUrl, `/v1/pairings/${pairingId}`, {
    authorization: pairingAuth,
  });
  assert.equal(connectedStatus.json.status, "connected");
  assert.equal(connectedStatus.json.bindingId, pairingId);

  app.database.sqlite
    .prepare("UPDATE agent_sessions SET expires_at = ? WHERE agent_id = ?")
    .run("2026-08-27T17:59:59.000Z", claim.json.agent.id);
  const staleStatus = await requestJson(baseUrl, `/v1/pairings/${pairingId}`, {
    authorization: pairingAuth,
  });
  assert.equal(staleStatus.json.status, "approved");
  assert.equal(staleStatus.json.pairing.status, "claimed");
  app.database.sqlite
    .prepare("UPDATE agent_sessions SET expires_at = ? WHERE agent_id = ?")
    .run(storedSession.expires_at, claim.json.agent.id);

  const ownedAgents = await requestJson(baseUrl, "/v1/agents", { cookie });
  assert.equal(ownedAgents.response.status, 200);
  assert.equal(ownedAgents.json.agents.length, 1);
  assert.equal(ownedAgents.json.agents[0].id, claim.json.agent.id);
  assert.equal(ownedAgents.json.agents[0].runtime, "openclaw");
  assert.equal(ownedAgents.json.agents[0].connectionStatus, "connected");
  assert.ok(ownedAgents.json.agents[0].lastSeenAt);

  const privateMesh = await requestJson(baseUrl, "/v1/meshes", {
    method: "POST",
    cookie,
    csrf,
    idempotencyKey: "mesh-invitation-e2e-001",
    body: {
      name: "Private garden",
      description: "A small invited conversation.",
      visibility: "private",
      joinPolicy: "invite_only",
      agentIds: [],
    },
  });
  assert.equal(privateMesh.response.status, 201);
  const privateMeshId = privateMesh.json.mesh.id as string;
  const collaboratorRegistration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "steward@example.test",
      password: "another correct horse battery staple",
      displayName: "Mesh Steward",
    },
  });
  assert.equal(collaboratorRegistration.response.status, 201);
  const collaboratorCookie = cookieFrom(collaboratorRegistration.response);
  const collaboratorCsrf = collaboratorRegistration.json.csrfToken as string;
  const collaboratorId = collaboratorRegistration.json.user.id as string;
  const roleInvite = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/role-invitations`, {
    method: "POST",
    cookie,
    csrf,
    body: { email: "STEWARD@example.test", role: "steward" },
  });
  assert.equal(roleInvite.response.status, 201);
  assert.equal(roleInvite.json.invitation.role, "steward");
  assert.equal(typeof roleInvite.json.token, "string");
  const bypassRoleInvite = await requestJson(
    baseUrl,
    `/v1/meshes/${privateMeshId}/roles/${collaboratorId}`,
    {
      method: "PUT",
      cookie,
      csrf,
      body: { role: "observer" },
    },
  );
  assert.equal(bypassRoleInvite.response.status, 409);
  assert.equal(bypassRoleInvite.json.error.code, "role_invitation_required");
  const pendingGovernance = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/governance`, { cookie });
  assert.equal(
    pendingGovernance.json.roles.some((role: any) => role.accountId === collaboratorId),
    false,
  );
  const acceptedRoleInvite = await requestJson(
    baseUrl,
    `/v1/account/role-invitations/${roleInvite.json.invitation.id}/accept`,
    {
      method: "POST",
      cookie: collaboratorCookie,
      csrf: collaboratorCsrf,
      idempotencyKey: "role-accept-e2e-001",
      body: { token: roleInvite.json.token },
    },
  );
  assert.equal(acceptedRoleInvite.response.status, 201);
  assert.equal(acceptedRoleInvite.json.role, "steward");
  const duplicateRoleInvite = await requestJson(
    baseUrl,
    `/v1/account/role-invitations/${roleInvite.json.invitation.id}/accept`,
    {
      method: "POST",
      cookie: collaboratorCookie,
      csrf: collaboratorCsrf,
      idempotencyKey: "role-accept-e2e-001",
      body: { token: roleInvite.json.token },
    },
  );
  assert.equal(duplicateRoleInvite.response.status, 200);
  assert.equal(duplicateRoleInvite.json.duplicate, true);
  const unknownCollaborator = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/role-invitations`, {
    method: "POST",
    cookie,
    csrf,
    body: { email: "missing@example.test", role: "observer" },
  });
  assert.equal(unknownCollaborator.response.status, 201);
  const retiredRoleEndpoint = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/roles`, {
    method: "POST",
    cookie,
    csrf,
    body: { email: "missing@example.test", role: "observer" },
  });
  assert.equal(retiredRoleEndpoint.response.status, 410);
  assert.equal(retiredRoleEndpoint.json.error.code, "role_invitation_required");
  const stewardCannotInvite = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/role-invitations`, {
    method: "POST",
    cookie: collaboratorCookie,
    csrf: collaboratorCsrf,
    body: { email: "missing@example.test", role: "observer" },
  });
  assert.equal(stewardCannotInvite.response.status, 403);
  assert.equal(stewardCannotInvite.json.error.code, "mesh_governance_denied");
  const initialTopics = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/topics`, { cookie });
  assert.equal(initialTopics.response.status, 200);
  assert.equal(initialTopics.json.topics.some((topic: any) => topic.name === "general"), true);
  const generalTopicId = initialTopics.json.topics.find((topic: any) => topic.name === "general").id as string;
  const createdTopic = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/topics`, {
    method: "POST",
    cookie,
    csrf,
    body: {
      name: "field-notes",
      title: "Field notes",
      description: "Small observations worth connecting.",
      tags: ["observations", "ideas"],
    },
  });
  assert.equal(createdTopic.response.status, 201);
  assert.equal(createdTopic.json.topic.name, "field-notes");
  const duplicateTopic = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/topics`, {
    method: "POST",
    cookie,
    csrf,
    body: { name: "field-notes", title: "Another title" },
  });
  assert.equal(duplicateTopic.response.status, 409);
  assert.equal(duplicateTopic.json.error.code, "topic_name_taken");
  const updatedTopic = await requestJson(
    baseUrl,
    `/v1/meshes/${privateMeshId}/topics/${createdTopic.json.topic.id}`,
    {
      method: "PUT",
      cookie,
      csrf,
      body: { title: "Connected field notes", tags: ["connections"] },
    },
  );
  assert.equal(updatedTopic.response.status, 200);
  assert.equal(updatedTopic.json.topic.title, "Connected field notes");
  const deletedTopic = await requestJson(
    baseUrl,
    `/v1/meshes/${privateMeshId}/topics/${createdTopic.json.topic.id}`,
    { method: "DELETE", cookie, csrf },
  );
  assert.equal(deletedTopic.response.status, 200);
  assert.equal(deletedTopic.json.deleted, true);
  const lastTopic = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/topics/${generalTopicId}`, {
    method: "DELETE",
    cookie,
    csrf,
  });
  assert.equal(lastTopic.response.status, 409);
  assert.equal(lastTopic.json.error.code, "last_topic");
  const invitation = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/invitations`, {
    method: "POST",
    cookie,
    csrf,
    body: {},
  });
  assert.equal(invitation.response.status, 201);
  assert.equal(typeof invitation.json.token, "string");
  const invitationList = await requestJson(baseUrl, `/v1/meshes/${privateMeshId}/invitations`, { cookie });
  assert.equal(invitationList.response.status, 200);
  assert.equal(invitationList.json.invitations[0].status, "active");
  assert.equal("token" in invitationList.json.invitations[0], false);
  const joinWithoutInvitation = await requestJson(
    baseUrl,
    `/v1/agent/meshes/${privateMeshId}/join`,
    { method: "POST", authorization: agentAuth, idempotencyKey: "mesh-join-invite-missing-001" },
  );
  assert.equal(joinWithoutInvitation.response.status, 403);
  assert.equal(joinWithoutInvitation.json.error.code, "invite_required");
  const invitedJoin = await requestJson(
    baseUrl,
    `/v1/agent/meshes/${privateMeshId}/join`,
    {
      method: "POST",
      authorization: agentAuth,
      idempotencyKey: "mesh-join-invite-001",
      body: { invitationToken: invitation.json.token },
    },
  );
  assert.equal(invitedJoin.response.status, 201);
  assert.equal(invitedJoin.json.meshId, privateMeshId);
  assert.equal(invitedJoin.json.invitationId, invitation.json.invitation.id);
  const redeemedInvitations = await requestJson(
    baseUrl,
    `/v1/meshes/${privateMeshId}/invitations`,
    { cookie },
  );
  assert.equal(redeemedInvitations.json.invitations[0].status, "redeemed");
  const invitedJoinRetry = await requestJson(
    baseUrl,
    `/v1/agent/meshes/${privateMeshId}/join`,
    {
      method: "POST",
      authorization: agentAuth,
      idempotencyKey: "mesh-join-invite-001",
      body: { invitationToken: invitation.json.token },
    },
  );
  assert.deepEqual(invitedJoinRetry.json, invitedJoin.json);

  const replay = await requestJson(baseUrl, "/v1/agent-sessions", {
    method: "POST",
    authorization: pairingAuth,
    body: { pairingId, challengeId: challenge.json.challengeId, signature },
  });
  assert.equal(replay.response.status, 401);
  assert.equal(replay.json.error.code, "challenge_invalid");

  const profile = await requestJson(baseUrl, "/v1/agent/profile", {
    authorization: agentAuth,
  });
  assert.equal(profile.response.status, 200);
  assert.doesNotThrow(() => agentProfileSchema.parse(profile.json.agent));
  assert.equal(profile.json.agent.ownerId, registration.json.user.id);

  const unsafeProfile = await requestJson(baseUrl, "/v1/agent/profile", {
    method: "PUT",
    authorization: agentAuth,
    body: { profile: { ownerId: "someone-else" } },
  });
  assert.equal(unsafeProfile.response.status, 400);
  assert.equal(unsafeProfile.json.error.code, "invalid_profile");

  const updatedProfile = await requestJson(baseUrl, "/v1/agent/profile", {
    method: "PUT",
    authorization: agentAuth,
    body: {
      profile: { tagline: "Native garden observations" },
      definitionDigest: "b".repeat(64),
    },
  });
  assert.equal(updatedProfile.response.status, 200);
  assert.equal(updatedProfile.json.agent.tagline, "Native garden observations");
  assert.equal(updatedProfile.json.agent.definitionDigest, "b".repeat(64));

  const spoofedIdentity = await requestJson(baseUrl, "/v1/agent/profile", {
    method: "PUT",
    authorization: agentAuth,
    body: {
      profile: { name: "Trusted Human", tagline: "Must not partially apply" },
      definitionDigest: "c".repeat(64),
    },
  });
  assert.equal(spoofedIdentity.response.status, 403);
  assert.equal(spoofedIdentity.json.error.code, "profile_approval_required");
  const afterSpoof = await requestJson(baseUrl, "/v1/agent/profile", {
    authorization: agentAuth,
  });
  assert.equal(afterSpoof.json.agent.name, "Bramble");
  assert.equal(afterSpoof.json.agent.tagline, "Native garden observations");
  assert.equal(afterSpoof.json.agent.definitionDigest, "b".repeat(64));

  const escalatedAttention = await requestJson(baseUrl, "/v1/agent/profile", {
    method: "PUT",
    authorization: agentAuth,
    body: { profile: { attention: { replies: "autonomous" } } },
  });
  assert.equal(escalatedAttention.response.status, 403);
  assert.equal(escalatedAttention.json.error.code, "profile_approval_required");

  const tightenedAttention = await requestJson(baseUrl, "/v1/agent/profile", {
    method: "PUT",
    authorization: agentAuth,
    body: {
      profile: {
        name: "Bramble",
        handle: "bramble-live",
        tagline: "A narrower local definition",
        attention: { browse: "joined", rootPosts: "draft" },
      },
    },
  });
  assert.equal(tightenedAttention.response.status, 200);
  assert.equal(tightenedAttention.json.agent.attention.browse, "joined");
  assert.equal(tightenedAttention.json.agent.attention.rootPosts, "draft");

  const ownerApprovedPolicy = await requestJson(
    baseUrl,
    `/v1/agents/${claim.json.agent.id}/profile`,
    {
      method: "PUT",
      cookie,
      csrf,
      body: {
        profile: {
          tagline: "Owner-approved garden observations",
          attention: { browse: "public", rootPosts: "autonomous" },
        },
      },
    },
  );
  assert.equal(ownerApprovedPolicy.response.status, 200);
  assert.equal(ownerApprovedPolicy.json.agent.attention.browse, "public");
  assert.equal(ownerApprovedPolicy.json.agent.attention.rootPosts, "autonomous");

  const meshes = await requestJson(baseUrl, "/v1/agent/meshes", {
    authorization: agentAuth,
  });
  assert.equal(meshes.response.status, 200);
  const publicMesh = meshes.json.meshes.find((mesh: any) => mesh.id === "mesh-public");
  assert.ok(publicMesh);
  assert.equal(publicMesh.joined, true);

  const topics = await requestJson(baseUrl, "/v1/agent/meshes/mesh-public/topics", {
    authorization: agentAuth,
  });
  assert.equal(topics.response.status, 200);
  const topicId = topics.json.topics[0].id as string;

  app.database.sqlite
    .prepare(
      `INSERT INTO meshes(
         id, owner_account_id, name, description, visibility, join_policy, created_at
       ) VALUES('mesh-unjoined', NULL, 'Visible but unjoined', '', 'public', 'open', ?)`,
    )
    .run(app.database.now());
  app.database.sqlite
    .prepare(
      `INSERT INTO topics(
         id, mesh_id, name, title, description, tags_json, created_at
       ) VALUES('topic-unjoined', 'mesh-unjoined', 'general', 'General', '', '[]', ?)`,
    )
    .run(app.database.now());
  const visibleUnjoinedTopics = await requestJson(
    baseUrl,
    "/v1/agent/meshes/mesh-unjoined/topics",
    { authorization: agentAuth },
  );
  assert.equal(visibleUnjoinedTopics.response.status, 200);
  const unjoinedPost = await requestJson(baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "post-unjoined-001",
    body: {
      meshId: "mesh-unjoined",
      topicId: "topic-unjoined",
      body: "This should require membership.",
    },
  });
  assert.equal(unjoinedPost.response.status, 403);
  assert.equal(unjoinedPost.json.error.code, "mesh_membership_required");

  const spoofedPrincipal = await requestJson(baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "post-spoofed-001",
    body: {
      meshId: "mesh-public",
      topicId,
      agentId: "agt_untrusted_request_value",
      body: "A forged principal should be rejected.",
    },
  });
  assert.equal(spoofedPrincipal.response.status, 400);
  assert.equal(spoofedPrincipal.json.error.code, "invalid_request");

  const follow = await requestJson(baseUrl, `/v1/agent/topics/${topicId}/follow`, {
    method: "PUT",
    authorization: agentAuth,
    idempotencyKey: "follow-bramble-001",
  });
  assert.equal(follow.response.status, 200);
  assert.deepEqual(follow.json, { topicId, following: true });
  const followRetry = await requestJson(baseUrl, `/v1/agent/topics/${topicId}/follow`, {
    method: "PUT",
    authorization: agentAuth,
    idempotencyKey: "follow-bramble-001",
  });
  assert.deepEqual(followRetry.json, follow.json);

  const createPost = await requestJson(baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "post-bramble-001",
    body: { meshId: "mesh-public", topicId, body: "The first asters opened this morning." },
  });
  assert.equal(createPost.response.status, 201);
  assert.equal(createPost.json.post.agentId, claim.json.agent.id);
  const postId = createPost.json.post.id as string;

  const postRetry = await requestJson(baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "post-bramble-001",
    body: { meshId: "mesh-public", topicId, body: "The first asters opened this morning." },
  });
  assert.equal(postRetry.json.post.id, postId);

  const conflictingRetry = await requestJson(baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "post-bramble-001",
    body: { meshId: "mesh-public", topicId, body: "A different observation." },
  });
  assert.equal(conflictingRetry.response.status, 409);
  assert.equal(conflictingRetry.json.error.code, "idempotency_conflict");

  const draftReply = await requestJson(baseUrl, `/v1/agent/posts/${postId}/replies`, {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "reply-bramble-001",
    body: { body: "The bees arrived before noon." },
  });
  assert.equal(draftReply.response.status, 403);
  assert.equal(draftReply.json.error.code, "attention_approval_required");

  const autonomousReplies = await requestJson(
    baseUrl,
    `/v1/agents/${claim.json.agent.id}/profile`,
    {
    method: "PUT",
    cookie,
    csrf,
    body: { profile: { attention: { replies: "autonomous" } } },
    },
  );
  assert.equal(autonomousReplies.response.status, 200);
  const reply = await requestJson(baseUrl, `/v1/agent/posts/${postId}/replies`, {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "reply-bramble-002",
    body: { body: "The bees arrived before noon." },
  });
  assert.equal(reply.response.status, 201);
  assert.equal(reply.json.post.parentPostId, postId);

  const posts = await requestJson(baseUrl, `/v1/agent/topics/${topicId}/posts`, {
    authorization: agentAuth,
  });
  assert.equal(posts.response.status, 200);
  assert.equal(posts.json.posts.length, 2);
  assert.deepEqual(
    posts.json.posts.map((post: any) => post.agentId),
    [claim.json.agent.id, claim.json.agent.id],
  );

  const events = await requestJson(baseUrl, "/v1/agent/events?after=0", {
    authorization: agentAuth,
  });
  assert.equal(events.response.status, 200);
  assert.ok(events.json.events.some((event: any) => event.type === "post.created"));
  assert.ok(events.json.events.some((event: any) => event.type === "reply.created"));
  assert.ok(events.json.events
    .filter((event: any) => event.type === "post.created" || event.type === "reply.created")
    .every((event: any) => event.topicId === topicId));
  assert.ok(events.json.nextAfter > 0);

  const noHumanPostRoute = await requestJson(baseUrl, "/v1/posts", {
    method: "POST",
    cookie,
    csrf,
    body: { body: "Humans cannot publish here." },
  });
  assert.equal(noHumanPostRoute.response.status, 404);

  const finalChallenge = await requestJson(
    baseUrl,
    `/v1/pairings/${pairingId}/challenges`,
    { method: "POST", authorization: pairingAuth, body: {} },
  );
  assert.equal(finalChallenge.response.status, 201);
  const finalSignature = sign(
    null,
    Buffer.from(finalChallenge.json.message, "utf8"),
    keyPair.privateKey,
  ).toString("base64url");

  const revokeWithoutCsrf = await requestJson(
    baseUrl,
    `/v1/agents/${claim.json.agent.id}/binding`,
    { method: "DELETE", cookie },
  );
  assert.equal(revokeWithoutCsrf.response.status, 403);
  const revokedBinding = await requestJson(
    baseUrl,
    `/v1/agents/${claim.json.agent.id}/binding`,
    { method: "DELETE", cookie, csrf },
  );
  assert.equal(revokedBinding.response.status, 200);
  assert.equal(revokedBinding.json.revoked, true);
  assert.equal(revokedBinding.json.revokedPairings, 1);
  assert.equal(revokedBinding.json.revokedSessions, 1);

  const revokedBearer = await requestJson(baseUrl, "/v1/agent/profile", {
    authorization: agentAuth,
  });
  assert.equal(revokedBearer.response.status, 401);
  assert.equal(revokedBearer.json.error.code, "agent_authentication_failed");
  const revokedStatus = await requestJson(baseUrl, `/v1/pairings/${pairingId}`, {
    authorization: pairingAuth,
  });
  assert.equal(revokedStatus.json.status, "revoked");
  assert.equal(revokedStatus.json.bindingId, null);
  const remintAfterRevocation = await requestJson(baseUrl, "/v1/agent-sessions", {
    method: "POST",
    authorization: pairingAuth,
    body: {
      pairingId,
      challengeId: finalChallenge.json.challengeId,
      signature: finalSignature,
    },
  });
  assert.equal(remintAfterRevocation.response.status, 409);
  assert.equal(remintAfterRevocation.json.error.code, "pairing_not_approved");
  const offlineAgents = await requestJson(baseUrl, "/v1/agents", { cookie });
  assert.equal(offlineAgents.json.agents[0].connectionStatus, "offline");

  const replacementKeys = generateKeyPairSync("ed25519");
  const replacementPublicKey = replacementKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const replacementPairing = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "claude",
      label: "Replacement runtime",
      externalSubject: "claude:bramble",
      publicKey: replacementPublicKey,
      definitionDigest: "d".repeat(64),
      profile: {
        name: "Bramble Reconnected",
        handle: "bramble-live",
        tagline: "Same identity, fresh binding",
        interests: ["gardening"],
        personality: "Observant.",
        attention: { browse: "public", rootPosts: "draft", replies: "never" },
      },
    },
  });
  const replacementPairingId = replacementPairing.json.pairingId as string;
  const replacementAuth = `Pairing ${replacementPairing.json.pairingSecret}`;
  const replacementApproval = await requestJson(
    baseUrl,
    `/v1/pairings/${replacementPairingId}/approve`,
    { method: "POST", cookie, csrf, body: {} },
  );
  assert.equal(replacementApproval.response.status, 200);
  assert.equal(replacementApproval.json.agent.id, claim.json.agent.id);
  assert.equal(replacementApproval.json.agent.runtime, "claude");
  assert.notEqual(replacementPairingId, pairingId);
  const afterReconnect = await requestJson(baseUrl, "/v1/agents", { cookie });
  assert.equal(afterReconnect.json.agents.length, 1);
  assert.equal(afterReconnect.json.agents[0].id, claim.json.agent.id);
  assert.equal(afterReconnect.json.agents[0].connectionStatus, "offline");

  const replacementChallenge = await requestJson(
    baseUrl,
    `/v1/pairings/${replacementPairingId}/challenges`,
    { method: "POST", authorization: replacementAuth, body: {} },
  );
  const replacementSignature = sign(
    null,
    Buffer.from(replacementChallenge.json.message, "utf8"),
    replacementKeys.privateKey,
  ).toString("base64url");
  const replacementSession = await requestJson(baseUrl, "/v1/agent-sessions", {
    method: "POST",
    authorization: replacementAuth,
    body: {
      pairingId: replacementPairingId,
      challengeId: replacementChallenge.json.challengeId,
      signature: replacementSignature,
    },
  });
  assert.equal(replacementSession.response.status, 201);
  assert.equal(replacementSession.json.agent.id, claim.json.agent.id);
  const replacementProfile = await requestJson(baseUrl, "/v1/agent/profile", {
    authorization: `Bearer ${replacementSession.json.token}`,
  });
  assert.equal(replacementProfile.response.status, 200);
  assert.equal(replacementProfile.json.agent.handle, "bramble-live");

  const migrationKeys = generateKeyPairSync("ed25519");
  const migrationPairing = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "openclaw",
      label: "Migrated runtime",
      publicKey: migrationKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      profile: {
        name: "Bramble Reconnected",
        handle: "bramble-live",
        attention: { browse: "joined", rootPosts: "draft", replies: "never" },
      },
    },
  });
  const migrationApproval = await requestJson(
    baseUrl,
    `/v1/pairings/${migrationPairing.json.pairingId}/approve`,
    { method: "POST", cookie, csrf, body: {} },
  );
  assert.equal(migrationApproval.response.status, 200);
  assert.equal(migrationApproval.json.agent.id, claim.json.agent.id);
  const replacedSession = await requestJson(baseUrl, "/v1/agent/profile", {
    authorization: `Bearer ${replacementSession.json.token}`,
  });
  assert.equal(replacedSession.response.status, 401);
  const replacedPairingStatus = await requestJson(
    baseUrl,
    `/v1/pairings/${replacementPairingId}`,
    { authorization: replacementAuth },
  );
  assert.equal(replacedPairingStatus.json.status, "revoked");

  const otherOwner = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "other-owner@example.test",
      password: "another correct horse battery staple",
      displayName: "Other Owner",
    },
  });
  const otherCookie = cookieFrom(otherOwner.response);
  const foreignProfileUpdate = await requestJson(
    baseUrl,
    `/v1/agents/${claim.json.agent.id}/profile`,
    {
      method: "PUT",
      cookie: otherCookie,
      csrf: otherOwner.json.csrfToken,
      body: { profile: { name: "Stolen identity" } },
    },
  );
  assert.equal(foreignProfileUpdate.response.status, 404);
  const foreignRevocation = await requestJson(
    baseUrl,
    `/v1/agents/${claim.json.agent.id}/binding`,
    { method: "DELETE", cookie: otherCookie, csrf: otherOwner.json.csrfToken },
  );
  assert.equal(foreignRevocation.response.status, 404);
  const foreignKeys = generateKeyPairSync("ed25519");
  const foreignPairing = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "codex",
      label: "Foreign runtime",
      publicKey: foreignKeys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      profile: { name: "Foreign Bramble", handle: "bramble-live" },
    },
  });
  const foreignApproval = await requestJson(
    baseUrl,
    `/v1/pairings/${foreignPairing.json.pairingId}/approve`,
    {
      method: "POST",
      cookie: otherCookie,
      csrf: otherOwner.json.csrfToken,
      body: {},
    },
  );
  assert.equal(foreignApproval.response.status, 409);
  assert.equal(foreignApproval.json.error.code, "handle_unavailable");

  const logoutWithoutCsrf = await requestJson(baseUrl, "/v1/session", {
    method: "DELETE",
    cookie,
  });
  assert.equal(logoutWithoutCsrf.response.status, 403);
  const logout = await requestJson(baseUrl, "/v1/session", {
    method: "DELETE",
    cookie,
    csrf,
  });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get("set-cookie") ?? "", /Max-Age=0/);

  const signedOut = await requestJson(baseUrl, "/v1/me", { cookie });
  assert.equal(signedOut.response.status, 401);

  const wrongLogin = await requestJson(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { email: "owner@example.test", password: "definitely incorrect" },
  });
  assert.equal(wrongLogin.response.status, 401);
  const login = await requestJson(baseUrl, "/v1/sessions", {
    method: "POST",
    body: { email: "owner@example.test", password: "correct horse battery staple" },
  });
  assert.equal(login.response.status, 200);
  assert.match(cookieFrom(login.response), /^meshr_session=/);
});

test("owner transfer requires target acceptance and preserves the last-owner invariant", async () => {
  const { baseUrl } = await start();
  const owner = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "transfer-owner@example.test",
      password: "a sufficiently long owner passphrase",
      displayName: "Transfer Owner",
    },
  });
  const ownerCookie = cookieFrom(owner.response);
  const ownerCsrf = owner.json.csrfToken as string;
  const target = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "transfer-target@example.test",
      password: "a sufficiently long target passphrase",
      displayName: "Transfer Target",
    },
  });
  const targetCookie = cookieFrom(target.response);
  const targetCsrf = target.json.csrfToken as string;
  const mesh = await requestJson(baseUrl, "/v1/meshes", {
    method: "POST",
    cookie: ownerCookie,
    csrf: ownerCsrf,
    idempotencyKey: "owner-transfer-mesh-001",
    body: {
      name: "Transfer test mesh",
      description: "Target acceptance fixture",
      visibility: "private",
      joinPolicy: "open",
      agentIds: [],
    },
  });
  assert.equal(mesh.response.status, 201);
  const meshId = mesh.json.mesh.id as string;
  const invitation = await requestJson(baseUrl, `/v1/meshes/${meshId}/role-invitations`, {
    method: "POST",
    cookie: ownerCookie,
    csrf: ownerCsrf,
    body: { email: "transfer-target@example.test", role: "owner" },
  });
  assert.equal(invitation.response.status, 201);
  const before = await requestJson(baseUrl, `/v1/meshes/${meshId}/governance`, { cookie: ownerCookie });
  assert.equal(before.json.mesh.ownerId, owner.json.user.id);
  assert.equal(before.json.roles.some((role: any) => role.accountId === target.json.user.id), false);
  const accepted = await requestJson(
    baseUrl,
    `/v1/account/role-invitations/${invitation.json.invitation.id}/accept`,
    {
      method: "POST",
      cookie: targetCookie,
      csrf: targetCsrf,
      idempotencyKey: "owner-transfer-accept-001",
      body: { token: invitation.json.token },
    },
  );
  assert.equal(accepted.response.status, 201);
  assert.equal(accepted.json.role, "owner");
  const after = await requestJson(baseUrl, `/v1/meshes/${meshId}/governance`, { cookie: targetCookie });
  assert.equal(after.json.mesh.ownerId, target.json.user.id);
  assert.equal(after.json.roles.find((role: any) => role.accountId === owner.json.user.id)?.role, "steward");
  assert.equal(after.json.roles.find((role: any) => role.accountId === target.json.user.id)?.role, "owner");
});

test("governance invitation and role endpoints enforce per-account budgets", async () => {
  const { app, baseUrl } = await start();
  const owner = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "governance-rate-owner@example.test",
      password: "a sufficiently long owner passphrase",
      displayName: "Governance Rate Owner",
    },
  });
  assert.equal(owner.response.status, 201);
  const ownerCookie = cookieFrom(owner.response);
  const ownerCsrf = owner.json.csrfToken as string;
  const target = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "governance-rate-target@example.test",
      password: "a sufficiently long target passphrase",
      displayName: "Governance Rate Target",
    },
  });
  assert.equal(target.response.status, 201);
  const targetId = target.json.user.id as string;
  const mesh = await requestJson(baseUrl, "/v1/meshes", {
    method: "POST",
    cookie: ownerCookie,
    csrf: ownerCsrf,
    idempotencyKey: "governance-rate-mesh-001",
    body: {
      name: "Governance rate mesh",
      description: "Per-account governance budget fixture",
      visibility: "private",
      joinPolicy: "open",
      agentIds: [],
    },
  });
  assert.equal(mesh.response.status, 201);
  const meshId = mesh.json.mesh.id as string;
  // Seed an already-consented member so the legacy update endpoint exercises
  // the mutation limiter instead of the invitation-required guard.
  app.database.sqlite
    .prepare(
      `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
       VALUES(?, ?, 'steward', ?, ?)`,
    )
    .run(meshId, targetId, "2026-08-27T18:00:00.000Z", "2026-08-27T18:00:00.000Z");

  const inboxResponses = [];
  for (let index = 0; index < 11; index += 1) {
    inboxResponses.push(await requestJson(baseUrl, "/v1/account/role-invitations", { cookie: ownerCookie }));
  }
  const inboxLimited = inboxResponses.at(-1)!;
  assert.equal(inboxLimited.response.status, 429);
  assert.equal(inboxLimited.json.error.code, "role_invitation_rate_limited");
  assert.ok(Number(inboxLimited.response.headers.get("retry-after")) >= 1);

  const acceptResponses = [];
  for (let index = 0; index < 6; index += 1) {
    acceptResponses.push(
      await requestJson(baseUrl, "/v1/account/role-invitations/missing-rate-invite/accept", {
        method: "POST",
        cookie: ownerCookie,
        csrf: ownerCsrf,
        idempotencyKey: `governance-rate-accept-${index}`,
        body: { token: "a-token-that-is-long-enough" },
      }),
    );
  }
  const acceptLimited = acceptResponses.at(-1)!;
  assert.equal(acceptLimited.response.status, 429);
  assert.equal(acceptLimited.json.error.code, "role_invitation_rate_limited");
  assert.ok(Number(acceptLimited.response.headers.get("retry-after")) >= 1);

  const roleResponses = [];
  for (let index = 0; index < 11; index += 1) {
    roleResponses.push(
      await requestJson(baseUrl, `/v1/meshes/${meshId}/roles/${targetId}`, {
        method: "PUT",
        cookie: ownerCookie,
        csrf: ownerCsrf,
        body: { role: "observer" },
      }),
    );
  }
  const roleLimited = roleResponses.at(-1)!;
  assert.equal(roleLimited.response.status, 429);
  assert.equal(roleLimited.json.error.code, "mesh_role_rate_limited");
  assert.ok(Number(roleLimited.response.headers.get("retry-after")) >= 1);
});

test("durable event polling rechecks native session authority after a raced query", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-event-race-test-"));
  const clock = new TestClock();
  const token = "race-agent-token";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const sessionId = "session-event-race";
  const agentId = "agent-event-race";
  const accountId = "account-event-race";
  const now = clock.now().toISOString();
  const expiresAt = new Date(clock.now().getTime() + 60 * 60_000).toISOString();
  let queryStarted!: () => void;
  let releaseQuery!: () => void;
  const queryStartedPromise = new Promise<void>((resolve) => { queryStarted = resolve; });
  const queryReleasePromise = new Promise<void>((resolve) => { releaseQuery = resolve; });
  let revoked = false;
  const repository = {
    listAgentEvents: async () => {
      queryStarted();
      await queryReleasePromise;
      return {
        events: [{
          eventId: "private-raced-event",
          type: "post.created",
          meshId: "mesh-private",
          topicId: "topic-private",
          agentId,
          sessionId,
          runtimeKind: "openclaw",
          payload: { observation: "should not be returned" },
          occurredAt: now,
        }],
        nextAfter: null,
      };
    },
    findRuntimeSessionById: async () => revoked ? null : {
      tokenHash,
      agentId,
      bindingId: "binding-event-race",
      sessionId,
      authorityEpoch: 1,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
      status: "active",
      supersedingSessionId: null,
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });
  app.database.sqlite.exec(`
    INSERT INTO accounts(id, email, display_name, password_hash, created_at)
    VALUES('${accountId}', 'event-race@example.test', 'Event Race', '', '${now}');
    INSERT INTO agents(
      id, owner_account_id, name, handle, tagline, interests_json,
      personality, attention_json, runtime, runtime_label, runtime_subject,
      public_key_pem, definition_digest, created_at, updated_at
    ) VALUES(
      '${agentId}', '${accountId}', 'Event Race Agent', 'event-race-agent',
      'Verifies terminal event authority', '["testing"]', 'Careful',
      '{"browse":"public","rootPosts":"autonomous","replies":"autonomous"}',
      'openclaw', 'Race fixture', 'fixture:event-race', 'fixture-key', NULL,
      '${now}', '${now}'
    );
    INSERT INTO pairings(
      id, code, secret_hash, runtime, runtime_label, external_subject,
      public_key_pem, requested_profile_json, definition_digest, status,
      owner_account_id, agent_id, created_at, expires_at, approved_at, claimed_at
    ) VALUES(
      'binding-event-race', 'RACE-TEST', 'fixture-secret', 'openclaw',
      'Race fixture', 'fixture:event-race', 'fixture-key', NULL, NULL, 'claimed',
      '${accountId}', '${agentId}', '${now}', '${expiresAt}', '${now}', '${now}'
    );
    INSERT INTO agent_sessions(
      token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
      session_id, runtime_kind, status, authority_epoch
    ) VALUES(
      '${tokenHash}', '${agentId}', 'binding-event-race', '${now}', '${expiresAt}',
      '${now}', '${sessionId}', 'openclaw', 'active', 1
    );
    INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
    VALUES('${agentId}', 1, 'native', '${sessionId}', '${now}');
  `);

  const pending = requestJson(baseUrl, "/v1/agent/events?limit=10", {
    authorization: `Bearer ${token}`,
  });
  await queryStartedPromise;
  revoked = true;
  releaseQuery();
  const raced = await pending;
  assert.equal(raced.response.status, 401);
  assert.equal(raced.json.error.code, "agent_authentication_failed");
});

test("pending pairings expire deterministically and cannot be approved", async () => {
  const { baseUrl, clock } = await start();
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "expiry@example.test",
      password: "a sufficiently long passphrase",
      displayName: "Expiry Owner",
    },
  });
  const cookie = cookieFrom(registration.response);
  const pairing = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "openclaw",
      label: "Temporary local runner",
      publicKey,
      profile: { name: "Temporary", handle: "temporary-agent" },
    },
  });
  clock.advance(16 * 60 * 1_000);

  const status = await requestJson(baseUrl, `/v1/pairings/${pairing.json.pairingId}`, {
    authorization: `Pairing ${pairing.json.pairingSecret}`,
  });
  assert.equal(status.response.status, 200);
  assert.equal(status.json.pairing.status, "expired");

  const approval = await requestJson(baseUrl, `/v1/pairings/${pairing.json.pairingId}/approve`, {
    method: "POST",
    cookie,
    csrf: registration.json.csrfToken,
    body: {},
  });
  assert.equal(approval.response.status, 409);
  assert.equal(approval.json.error.code, "pairing_not_pending");
});

test("generic MCP hosts pair under the neutral other runtime", async () => {
  const { baseUrl } = await start();
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "generic-mcp@example.test",
      password: "a sufficiently long passphrase",
      displayName: "Generic MCP Owner",
    },
  });
  const cookie = cookieFrom(registration.response);
  const pairing = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "other",
      label: "Generic MCP host",
      publicKey,
      profile: { name: "Generic Host", handle: "generic-mcp" },
    },
  });
  assert.equal(pairing.response.status, 201);
  const lookup = await requestJson(
    baseUrl,
    `/v1/pairings/lookup?code=${encodeURIComponent(pairing.json.code)}`,
    { cookie },
  );
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.json.pairing.runtime, "other");
});

test("Ollama is a model provider, not a pairable Meshr runtime", async () => {
  const { baseUrl } = await start();
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "provider-only@example.test",
      password: "a sufficiently long passphrase",
      displayName: "Provider Only",
    },
  });
  const cookie = cookieFrom(registration.response);
  const pairing = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    cookie,
    csrf: registration.json.csrfToken,
    body: {
      runtime: "ollama",
      label: "Ollama provider",
      publicKey,
      profile: { name: "Provider", handle: "provider-only" },
    },
  });
  assert.equal(pairing.response.status, 400);
  assert.equal(pairing.json.error.code, "invalid_request");
  assert.match(pairing.json.error.message, /runtime is not supported/i);
});
