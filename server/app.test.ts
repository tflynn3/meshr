import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createMeshrServer,
  cutoverValidationSessionIds,
  isCutoverValidationSessionAuthorized,
  type MeshrServer,
} from "./app.ts";
import { CURRENT_SCHEMA_VERSION } from "./database.ts";
import { agentProfileSchema } from "./contracts.ts";
import type { MeshrRepository, RepositoryProjection } from "./repository.ts";
import type { Clock, IdentityVerifier } from "./types.ts";

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

test("cutover validation accepts only the reviewed session or its deterministic successor", () => {
  const predecessor = "cutover-predecessor";
  const allowed = cutoverValidationSessionIds(predecessor);
  assert.equal(allowed.length, 2);
  assert.equal(isCutoverValidationSessionAuthorized(predecessor, predecessor), true);
  assert.equal(isCutoverValidationSessionAuthorized(allowed[1], predecessor), true);
  assert.equal(isCutoverValidationSessionAuthorized("different-active-session", predecessor), false);
  assert.equal(isCutoverValidationSessionAuthorized(undefined, predecessor), false);
});

afterEach(async () => {
  while (running.length) {
    const item = running.pop();
    if (!item) continue;
    await item.app.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

async function start(options: {
  identityVerifier?: IdentityVerifier;
  moderationAuthorityToken?: string;
  internalToken?: string;
  repository?: MeshrRepository;
  residentCohortDisclosure?: { text: string; url: string };
  socialAuthOnly?: boolean;
  trustCloudflareConnectingIp?: boolean;
  webMcpTransfersSession?: boolean;
} = {}): Promise<RunningServer> {
  const directory = mkdtempSync(join(tmpdir(), "meshr-server-test-"));
  const clock = new TestClock();
  const app = createMeshrServer({ dbPath: join(directory, "meshr.db"), clock, ...options });
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
    clientIp?: string;
    origin?: string;
  } = {},
): Promise<{ response: Response; json: any }> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.csrf) headers.set("X-Meshr-CSRF", options.csrf);
  if (options.authorization) headers.set("Authorization", options.authorization);
  if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.clientIp) headers.set("CF-Connecting-IP", options.clientIp);
  if (options.origin) headers.set("Origin", options.origin);
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

test("unexpected request logs never include query-string credentials", async (t) => {
  const { baseUrl } = await start();
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    logged.push(values.map(String).join(" "));
  };
  t.after(() => {
    console.error = originalError;
  });

  const status = await new Promise<number>((resolve, reject) => {
    const outgoing = httpRequest(
      new URL("/v1/pairings/lookup?code=ABCD-EFGH", baseUrl),
      { headers: { Host: "[" } },
      (incoming) => {
        incoming.resume();
        incoming.on("end", () => resolve(incoming.statusCode ?? 0));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });

  assert.equal(status, 500);
  assert.ok(logged.some((line) => line.includes("meshr server request failed")));
  assert.ok(logged.every((line) => !line.includes("ABCD-EFGH")));
  assert.ok(logged.every((line) => !line.includes("?code=")));
});

function beginSlowJsonRequest(
  baseUrl: string,
  path: string,
  options: { cookie: string; csrf: string },
): { finish(jsonRemainder: string): Promise<{ status: number; json: any }> } {
  const responseRequest: { outgoing?: ReturnType<typeof httpRequest> } = {};
  const response = new Promise<{ status: number; json: any }>((resolve, reject) => {
    const outgoing = httpRequest(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: options.cookie,
        "X-Meshr-CSRF": options.csrf,
      },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const payload = Buffer.concat(chunks).toString("utf8");
        resolve({ status: incoming.statusCode ?? 0, json: JSON.parse(payload) });
      });
      incoming.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.flushHeaders();
    outgoing.write('{"decision":');
    Object.assign(responseRequest, { outgoing });
  });
  return {
    finish(jsonRemainder: string) {
      const outgoing = responseRequest.outgoing;
      if (!outgoing) {
        const error = new Error("Slow request was not initialized.");
        return Promise.reject(error);
      }
      outgoing.end(jsonRemainder);
      return response;
    },
  };
}

test("health and public discovery expose a durable seeded commons", async () => {
  const { app, baseUrl } = await start();

  const health = await requestJson(baseUrl, "/healthz");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.json, {
    status: "ok",
    database: "ok",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    sessionPolicy: "compat",
    runtimeSessionSeconds: 12 * 60 * 60,
    runtimeOfflineSeconds: 24 * 60 * 60,
  });
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

test("public auth config exposes cohort-level resident transparency without principal fingerprints", async () => {
  const disclosure = {
    text: "Meshr operates an initial resident-agent cohort under the same permissions and moderation as other agents.",
    url: "https://meshr.social/about/seeded-participants",
  };
  const { baseUrl } = await start({ residentCohortDisclosure: disclosure });
  const config = await requestJson(baseUrl, "/v1/config/auth");
  assert.equal(config.response.status, 200);
  assert.deepEqual(config.json.residentCohortDisclosure, disclosure);
  assert.doesNotMatch(JSON.stringify(config.json), /principal|resident-01|accountId/);
});

test("operator-only resident provenance is absent from public auth config", async () => {
  const { baseUrl } = await start();
  const config = await requestJson(baseUrl, "/v1/config/auth");
  assert.equal(config.response.status, 200);
  assert.equal("residentCohortDisclosure" in config.json, false);
});

test("automated moderation authority routes require the service token", async () => {
  const { baseUrl } = await start({ moderationAuthorityToken: "internal-moderation-test-token" });
  const body = { eventId: "evt_test", caseId: "case_test", postId: "post_test" };

  const missing = await requestJson(baseUrl, "/internal/v1/moderation/candidate", {
    method: "POST",
    body,
  });
  assert.equal(missing.response.status, 401);
  assert.equal(missing.json.error.code, "internal_authentication_required");

  const wrong = await requestJson(baseUrl, "/internal/v1/moderation/candidate", {
    method: "POST",
    authorization: "Bearer wrong-token",
    body,
  });
  assert.equal(wrong.response.status, 401);

  const candidate = await requestJson(baseUrl, "/internal/v1/moderation/candidate", {
    method: "POST",
    authorization: "Bearer internal-moderation-test-token",
    body,
  });
  assert.equal(candidate.response.status, 200);
  assert.deepEqual(candidate.json, { eventId: "evt_test", exists: false });
});

test("outbox broker requires its service token and fences lease completion", async () => {
  const { app, baseUrl, clock } = await start({ internalToken: "internal-outbox-test-token" });
  const auth = "Bearer internal-outbox-test-token";
  const envelope = {
    event_id: "evt_outbox_test_0001",
    schema_version: 1,
    mesh_id: "mesh-public",
    agent_id: "agent-outbox-test",
    session_id: null,
    runtime_kind: "local",
    type: "local.smoke",
    occurred_at: "2026-08-27T18:00:00.000Z",
    payload: { topic_id: "topic-small-discoveries", source: "broker-test" },
  };

  const unauthorized = await requestJson(baseUrl, "/internal/v1/outbox/claim", {
    method: "POST",
    body: { maxEvents: 10, leaseSeconds: 30 },
  });
  assert.equal(unauthorized.response.status, 401);

  const healthUnauthorized = await requestJson(baseUrl, "/internal/v1/outbox/health", {
    method: "POST",
    body: {},
  });
  assert.equal(healthUnauthorized.response.status, 401);

  const accepted = await requestJson(baseUrl, "/internal/v1/outbox/events", {
    method: "POST",
    authorization: auth,
    body: envelope,
  });
  assert.equal(accepted.response.status, 202);
  assert.equal(accepted.json.duplicate, false);
  const duplicate = await requestJson(baseUrl, "/internal/v1/outbox/events", {
    method: "POST",
    authorization: auth,
    body: envelope,
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.json.duplicate, true);

  const pendingHealth = await requestJson(baseUrl, "/internal/v1/outbox/health", {
    method: "POST",
    authorization: auth,
    body: {},
  });
  assert.equal(pendingHealth.response.status, 200);
  assert.deepEqual(pendingHealth.json, {
    oldestPendingAt: envelope.occurred_at,
    oldestPendingAgeMs: 0,
  });
  clock.advance(45_000);
  const agedHealth = await requestJson(baseUrl, "/internal/v1/outbox/health", {
    method: "POST",
    authorization: auth,
    body: {},
  });
  assert.deepEqual(agedHealth.json, {
    oldestPendingAt: envelope.occurred_at,
    oldestPendingAgeMs: 45_000,
  });

  const claimed = await requestJson(baseUrl, "/internal/v1/outbox/claim", {
    method: "POST",
    authorization: auth,
    body: { maxEvents: 10, leaseSeconds: 30 },
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.json.claims.length, 1);
  assert.equal(claimed.json.claims[0].eventId, envelope.event_id);
  assert.deepEqual(claimed.json.claims[0].envelope.payload, envelope.payload);

  const leasedAgain = await requestJson(baseUrl, "/internal/v1/outbox/claim", {
    method: "POST",
    authorization: auth,
    body: { maxEvents: 10, leaseSeconds: 30 },
  });
  assert.deepEqual(leasedAgain.json.claims, []);

  const stale = await requestJson(baseUrl, "/internal/v1/outbox/complete", {
    method: "POST",
    authorization: auth,
    body: {
      results: [{
        eventId: envelope.event_id,
        leaseId: "wrong-lease",
        outcome: "published",
        messageId: "pubsub-wrong",
      }],
    },
  });
  assert.deepEqual(stale.json, { completed: [], stale: [envelope.event_id] });

  const leaseId = claimed.json.claims[0].leaseId as string;
  const completed = await requestJson(baseUrl, "/internal/v1/outbox/complete", {
    method: "POST",
    authorization: auth,
    body: {
      results: [{
        eventId: envelope.event_id,
        leaseId,
        outcome: "published",
        messageId: "pubsub-1",
      }],
    },
  });
  assert.deepEqual(completed.json, { completed: [envelope.event_id], stale: [] });
  const drainedHealth = await requestJson(baseUrl, "/internal/v1/outbox/health", {
    method: "POST",
    authorization: auth,
    body: {},
  });
  assert.deepEqual(drainedHealth.json, {
    oldestPendingAt: null,
    oldestPendingAgeMs: 0,
  });
  const replay = await requestJson(baseUrl, "/internal/v1/outbox/complete", {
    method: "POST",
    authorization: auth,
    body: {
      results: [{
        eventId: envelope.event_id,
        leaseId,
        outcome: "published",
        messageId: "pubsub-1",
      }],
    },
  });
  assert.deepEqual(replay.json, completed.json);
  const row = app.database.sqlite.prepare(
    "SELECT status, completed_lease_id, pubsub_message_id FROM outbox_events WHERE event_id = ?",
  ).get(envelope.event_id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, {
    status: "published",
    completed_lease_id: leaseId,
    pubsub_message_id: "pubsub-1",
  });
});

test("automated moderation decisions are idempotent and revision fenced", async () => {
  const { app, baseUrl } = await start({ moderationAuthorityToken: "internal-moderation-test-token" });
  const accountId = "internal-moderation-account";
  const agentId = "internal-moderation-agent";
  const postId = "internal-moderation-post";
  const caseId = "internal-moderation-case";
  const createdAt = "2026-08-27T18:00:00.000Z";
  app.database.sqlite.prepare(
    "INSERT INTO accounts(id, email, display_name, password_hash, created_at) VALUES(?, ?, ?, ?, ?)",
  ).run(accountId, "internal-moderation@example.test", "Internal moderation", "fixture", createdAt);
  app.database.sqlite.prepare(
    `INSERT INTO agents(
       id, owner_account_id, name, handle, tagline, interests_json,
       personality, attention_json, runtime, runtime_label, runtime_subject,
       public_key_pem, definition_digest, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agentId,
    accountId,
    "Internal moderation agent",
    "internal-moderation-agent",
    "fixture",
    "[]",
    "careful",
    JSON.stringify({ browse: "public", rootPosts: "autonomous", replies: "autonomous" }),
    "local",
    "Fixture",
    "internal",
    "fixture-key",
    null,
    createdAt,
    createdAt,
  );
  app.database.sqlite.prepare(
    `INSERT INTO posts(
       id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
       created_at, moderation_state, moderation_reason, expires_at
     ) VALUES(?, 'mesh-public', 'topic-cross-pollination', ?, ?, NULL, ?, ?, 'quarantined', ?, ?)`,
  ).run(postId, agentId, "internal-session", "candidate body", createdAt, "policy review", "2026-11-25T18:00:00.000Z");
  app.database.sqlite.prepare(
    `INSERT INTO moderation_cases(
       id, post_id, mesh_id, reason, state, severity, created_at, updated_at
     ) VALUES(?, ?, 'mesh-public', 'policy review', 'queued', 'medium', ?, ?)`,
  ).run(caseId, postId, createdAt, createdAt);

  const auth = "Bearer internal-moderation-test-token";
  const candidate = await requestJson(baseUrl, "/internal/v1/moderation/candidate", {
    method: "POST",
    authorization: auth,
    body: { eventId: "evt_internal", caseId, postId },
  });
  assert.equal(candidate.response.status, 200);
  assert.equal(candidate.json.exists, true);
  assert.equal(candidate.json.eligible, true);
  assert.equal(candidate.json.post.body, "candidate body");

  const decision = {
    eventId: "evt_internal",
    caseId,
    postId,
    expectedPostState: "quarantined",
    expectedPostUpdatedAt: createdAt,
    action: "allow",
    reason: "safe",
    severity: "low",
  };
  const applied = await requestJson(baseUrl, "/internal/v1/moderation/decision", {
    method: "POST",
    authorization: auth,
    body: decision,
  });
  assert.equal(applied.response.status, 200);
  assert.equal(applied.json.accepted, true);
  assert.equal(applied.json.duplicate, false);
  assert.equal(applied.json.moderationState, "published");

  const replay = await requestJson(baseUrl, "/internal/v1/moderation/decision", {
    method: "POST",
    authorization: auth,
    body: decision,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.json.duplicate, true);

  const stale = await requestJson(baseUrl, "/internal/v1/moderation/decision", {
    method: "POST",
    authorization: auth,
    body: { ...decision, action: "remove", reason: "stale result" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.json.error.code, "moderation_transition_conflict");
});

test("health reports the immutable release SHA when configured", async () => {
  const previous = process.env.MESHR_RELEASE_SHA;
  process.env.MESHR_RELEASE_SHA = "release-sha-for-health-test";
  try {
    const { baseUrl } = await start();
    const health = await requestJson(baseUrl, "/healthz");
    assert.equal(health.response.status, 200);
    assert.equal(health.json.releaseSha, "release-sha-for-health-test");
  } finally {
    if (previous === undefined) delete process.env.MESHR_RELEASE_SHA;
    else process.env.MESHR_RELEASE_SHA = previous;
  }
});

test("health exposes only a fingerprint of the Kubernetes pod UID", async () => {
  const previous = process.env.MESHR_POD_UID;
  const podUid = "fd922327-233f-4f62-bf74-315618ee4f44";
  process.env.MESHR_POD_UID = podUid;
  try {
    const { baseUrl } = await start();
    const health = await requestJson(baseUrl, "/healthz");
    assert.equal(health.response.status, 200);
    assert.equal(
      health.json.instanceFingerprint,
      createHash("sha256")
        .update(`meshr-pod-instance:v1:${podUid}`)
        .digest("hex")
        .slice(0, 32),
    );
    assert.equal(JSON.stringify(health.json).includes(podUid), false);
  } finally {
    if (previous === undefined) delete process.env.MESHR_POD_UID;
    else process.env.MESHR_POD_UID = previous;
  }
});

test("moderation reports are limited to mesh owners and stewards", async () => {
  const { app, baseUrl } = await start();
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();

  const register = async (email: string, displayName: string) => {
    const response = await requestJson(baseUrl, "/v1/accounts", {
      method: "POST",
      body: { email, password: "a sufficiently long passphrase", displayName },
    });
    assert.equal(response.response.status, 201);
    return {
      id: response.json.user.id as string,
      cookie: cookieFrom(response.response),
      csrf: response.json.csrfToken as string,
    };
  };

  const owner = await register("moderation-owner@example.test", "Moderation Owner");
  const pairing = await requestJson(baseUrl, "/v1/pairings", {
    method: "POST",
    body: {
      runtime: "claude",
      label: "Moderation fixture",
      externalSubject: "claude:moderation-fixture",
      publicKey,
      profile: {
        name: "Moderation Fixture",
        handle: "moderation-fixture",
        tagline: "Posts for governance tests",
        interests: ["testing"],
        personality: "Careful.",
        attention: { browse: "public", rootPosts: "autonomous", replies: "autonomous" },
      },
    },
  });
  assert.equal(pairing.response.status, 201);
  const pairingId = pairing.json.pairingId as string;
  const pairingAuth = `Pairing ${pairing.json.pairingSecret as string}`;
  const approved = await requestJson(baseUrl, `/v1/pairings/${pairingId}/approve`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { acknowledgeAutonomous: true },
  });
  assert.equal(approved.response.status, 200);
  const challenge = await requestJson(baseUrl, `/v1/pairings/${pairingId}/challenges`, {
    method: "POST",
    authorization: pairingAuth,
    body: {},
  });
  const signature = sign(
    null,
    Buffer.from(challenge.json.message as string, "utf8"),
    keyPair.privateKey,
  ).toString("base64url");
  const claim = await requestJson(baseUrl, "/v1/agent-sessions", {
    method: "POST",
    authorization: pairingAuth,
    body: {
      pairingId,
      challengeId: challenge.json.challengeId,
      signature,
    },
  });
  assert.equal(claim.response.status, 201);
  const agentAuth = `Bearer ${claim.json.token as string}`;
  const agentId = claim.json.agent.id as string;

  const publicMesh = await requestJson(baseUrl, "/v1/meshes", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-public-mesh",
    body: {
      name: "Moderation public",
      description: "Public moderation fixture",
      visibility: "public",
      joinPolicy: "open",
      agentIds: [agentId],
    },
  });
  assert.equal(publicMesh.response.status, 201);
  const publicMeshId = publicMesh.json.mesh.id as string;
  const publicTopicId = publicMesh.json.topic.id as string;
  const publicPost = await requestJson(baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "moderation-public-post",
    body: { meshId: publicMeshId, topicId: publicTopicId, body: "A reportable observation." },
  });
  assert.equal(publicPost.response.status, 201);
  const publicPostId = publicPost.json.post.id as string;

  const ownerReport = await requestJson(baseUrl, `/v1/posts/${publicPostId}/report`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-report-owner-1",
    body: { reason: "Owner review" },
  });
  assert.equal(ownerReport.response.status, 202);
  assert.equal(ownerReport.json.state, "queued");
  const ownerReportRetry = await requestJson(baseUrl, `/v1/posts/${publicPostId}/report`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-report-owner-1",
    body: { reason: "Owner review" },
  });
  assert.equal(ownerReportRetry.response.status, 202);
  assert.deepEqual(ownerReportRetry.json, ownerReport.json);

  const steward = await register("moderation-steward@example.test", "Moderation Steward");
  app.database.sqlite.prepare(
    `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
     VALUES(?, ?, 'steward', ?, ?)`,
  ).run(publicMeshId, steward.id, app.database.now(), app.database.now());
  const stewardReport = await requestJson(baseUrl, `/v1/posts/${publicPostId}/report`, {
    method: "POST",
    cookie: steward.cookie,
    csrf: steward.csrf,
    idempotencyKey: "moderation-report-steward-1",
    body: { reason: "Steward review" },
  });
  assert.equal(stewardReport.response.status, 202);

  // An omitted reason is part of the idempotency intent, not a snapshot of a
  // mutable queue field. If another reviewer changes the case before retry,
  // the same key is rejected as a superseded replay instead of being applied
  // with a different request hash or silently returning a different result.
  const omittedReasonReview = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${stewardReport.json.id as string}`, {
    method: "POST",
    cookie: steward.cookie,
    csrf: steward.csrf,
    idempotencyKey: "moderation-action-review-omitted-1",
    body: { action: "start_review" },
  });
  assert.equal(omittedReasonReview.response.status, 200);
  app.database.sqlite.prepare("UPDATE moderation_cases SET reason = ? WHERE id = ?")
    .run("Changed by another reviewer", stewardReport.json.id as string);
  const omittedReasonReplay = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${stewardReport.json.id as string}`, {
    method: "POST",
    cookie: steward.cookie,
    csrf: steward.csrf,
    idempotencyKey: "moderation-action-review-omitted-1",
    body: { action: "start_review" },
  });
  assert.equal(omittedReasonReplay.response.status, 409);
  assert.equal(omittedReasonReplay.json.error.code, "idempotency_replay_superseded");

  const moderationCaseId = ownerReport.json.id as string;
  const missingModerationKey = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${moderationCaseId}`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    body: { action: "start_review" },
  });
  assert.equal(missingModerationKey.response.status, 400);
  assert.equal(missingModerationKey.json.error.code, "idempotency_key_required");

  const startReview = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${moderationCaseId}`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-action-review-1",
    body: { action: "start_review", reason: "Owner review" },
  });
  assert.equal(startReview.response.status, 200);
  assert.equal(startReview.json.state, "reviewing");
  const startReviewRetry = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${moderationCaseId}`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-action-review-1",
    body: { action: "start_review", reason: "Owner review" },
  });
  assert.equal(startReviewRetry.response.status, 200);
  assert.deepEqual(startReviewRetry.json, startReview.json);

  const conflictingRetry = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${moderationCaseId}`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-action-review-1",
    body: { action: "publish", reason: "Owner review" },
  });
  assert.equal(conflictingRetry.response.status, 409);
  assert.equal(conflictingRetry.json.error.code, "idempotency_conflict");

  const resolveModeration = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${moderationCaseId}`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-action-resolve-1",
    body: { action: "publish", reason: "Approved by owner" },
  });
  assert.equal(resolveModeration.response.status, 200);
  assert.equal(resolveModeration.json.state, "resolved");
  assert.equal(resolveModeration.json.post.moderationState, "published");
  const stewardCaseId = stewardReport.json.id as string;
  assert.equal(
    app.database.sqlite.prepare("SELECT state, resolution FROM moderation_cases WHERE id = ?")
      .get(stewardCaseId)?.resolution,
    "superseded",
  );
  const staleSiblingAction = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${stewardCaseId}`, {
    method: "POST",
    cookie: steward.cookie,
    csrf: steward.csrf,
    idempotencyKey: "moderation-action-stale-sibling-1",
    body: { action: "quarantine", reason: "A stale sibling decision" },
  });
  assert.equal(staleSiblingAction.response.status, 409);
  assert.equal(staleSiblingAction.json.error.code, "moderation_transition_conflict");
  const terminalConflict = await requestJson(baseUrl, `/v1/meshes/${publicMeshId}/moderation/${moderationCaseId}`, {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-action-resolve-2",
    body: { action: "quarantine", reason: "A stale decision" },
  });
  assert.equal(terminalConflict.response.status, 409);
  assert.equal(terminalConflict.json.error.code, "moderation_transition_conflict");
  assert.equal(
    app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE resource_id = ?")
      .get(moderationCaseId)?.count,
    2,
  );
  assert.equal(
    app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE type IN ('moderation.start_review', 'moderation.publish')")
      .get()?.count,
    3,
  );

  const outsider = await register("moderation-outsider@example.test", "Public Reader");
  const outsiderReport = await requestJson(baseUrl, `/v1/posts/${publicPostId}/report`, {
    method: "POST",
    cookie: outsider.cookie,
    csrf: outsider.csrf,
    body: { reason: "Should be rejected" },
  });
  assert.equal(outsiderReport.response.status, 403);
  assert.equal(outsiderReport.json.error.code, "mesh_governance_denied");

  const privateMesh = await requestJson(baseUrl, "/v1/meshes", {
    method: "POST",
    cookie: owner.cookie,
    csrf: owner.csrf,
    idempotencyKey: "moderation-private-mesh",
    body: {
      name: "Moderation private",
      description: "Private moderation fixture",
      visibility: "private",
      joinPolicy: "invite_only",
      agentIds: [agentId],
    },
  });
  assert.equal(privateMesh.response.status, 201);
  const privateMeshId = privateMesh.json.mesh.id as string;
  const privateTopicId = privateMesh.json.topic.id as string;
  const privatePost = await requestJson(baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "moderation-private-post",
    body: { meshId: privateMeshId, topicId: privateTopicId, body: "A private reportable observation." },
  });
  assert.equal(privatePost.response.status, 201);
  const privatePostId = privatePost.json.post.id as string;
  const observer = await register("moderation-observer@example.test", "Private Reader");
  app.database.sqlite.prepare(
    `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
     VALUES(?, ?, 'observer', ?, ?)`,
  ).run(privateMeshId, observer.id, app.database.now(), app.database.now());
  const observerReport = await requestJson(baseUrl, `/v1/posts/${privatePostId}/report`, {
    method: "POST",
    cookie: observer.cookie,
    csrf: observer.csrf,
    body: { reason: "Observers cannot govern" },
  });
  assert.equal(observerReport.response.status, 403);
  assert.equal(observerReport.json.error.code, "mesh_governance_denied");

  const rateReporter = await register("moderation-rate@example.test", "Moderation Rate");
  app.database.sqlite.prepare(
    `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
     VALUES(?, ?, 'steward', ?, ?)`,
  ).run(publicMeshId, rateReporter.id, app.database.now(), app.database.now());
  const reportBurst = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    requestJson(baseUrl, `/v1/posts/${publicPostId}/report`, {
      method: "POST",
      cookie: rateReporter.cookie,
      csrf: rateReporter.csrf,
      idempotencyKey: `moderation-rate-${index}`,
      body: { reason: `Bounded report ${index}` },
    })));
  assert.equal(reportBurst.filter(({ response }) => response.status === 202).length, 5);
  const reportLimited = reportBurst.find(({ response }) => response.status === 429);
  assert.equal(reportLimited?.json.error.code, "moderation_report_rate_limited");
  assert.ok(Number(reportLimited?.response.headers.get("retry-after")) >= 1);
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
    body: { acknowledgeAutonomous: true },
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

  // A cutover candidate must be able to rotate the reviewed predecessor
  // while writes are still fenced, even when the normal two-minute renewal
  // window has not started. The exception is scoped to the configured
  // binding/agent/session and its joined private validation mesh.
  const validationMesh = await requestJson(baseUrl, "/v1/meshes", {
    method: "POST",
    cookie,
    csrf,
    idempotencyKey: "renewal-validation-mesh",
    body: {
      name: "Renewal validation",
      description: "Private cutover validation mesh",
      visibility: "private",
      joinPolicy: "open",
      agentIds: [agentId],
    },
  });
  assert.equal(validationMesh.response.status, 201);
  const previousCutoverEnvironment = {
    mode: process.env.MESHR_DATABASE_CUTOVER_MODE,
    meshId: process.env.MESHR_CUTOVER_VALIDATION_MESH_ID,
    bindingId: process.env.MESHR_CUTOVER_VALIDATION_BINDING_ID,
    agentId: process.env.MESHR_CUTOVER_VALIDATION_AGENT_ID,
    sessionId: process.env.MESHR_CUTOVER_VALIDATION_SESSION_ID,
  };
  process.env.MESHR_DATABASE_CUTOVER_MODE = "validation";
  process.env.MESHR_CUTOVER_VALIDATION_MESH_ID = validationMesh.json.mesh.id as string;
  process.env.MESHR_CUTOVER_VALIDATION_BINDING_ID = pairingId;
  process.env.MESHR_CUTOVER_VALIDATION_AGENT_ID = agentId;
  process.env.MESHR_CUTOVER_VALIDATION_SESSION_ID = predecessorSessionId;
  try {
    const earlyValidationChallenge = await requestJson(baseUrl, `/v1/pairings/${pairingId}/challenges`, {
      method: "POST",
      authorization: pairingAuth,
      body: { sessionId: predecessorSessionId },
    });
    assert.equal(earlyValidationChallenge.response.status, 201);
    assert.match(earlyValidationChallenge.json.message as string, /:renew:/);
  } finally {
    const restoreEnvironment = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restoreEnvironment("MESHR_DATABASE_CUTOVER_MODE", previousCutoverEnvironment.mode);
    restoreEnvironment("MESHR_CUTOVER_VALIDATION_MESH_ID", previousCutoverEnvironment.meshId);
    restoreEnvironment("MESHR_CUTOVER_VALIDATION_BINDING_ID", previousCutoverEnvironment.bindingId);
    restoreEnvironment("MESHR_CUTOVER_VALIDATION_AGENT_ID", previousCutoverEnvironment.agentId);
    restoreEnvironment("MESHR_CUTOVER_VALIDATION_SESSION_ID", previousCutoverEnvironment.sessionId);
  }
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

test("expensive account reads and the public directory enforce process-local budgets", async () => {
  const { baseUrl } = await start();
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "read-budget@example.test",
      password: "a sufficiently long read budget passphrase",
      displayName: "Read Budget",
    },
  });
  assert.equal(registration.response.status, 201);
  const cookie = cookieFrom(registration.response);
  const accountPaths = [
    "/v1/activity/public",
    "/v1/activity/preferences",
    "/v1/meshes",
    "/v1/meshes/mesh-public/governance",
    "/v1/meshes/mesh-public/topics",
  ];
  const accountReads = await Promise.all(Array.from({ length: 13 }, (_, index) =>
    requestJson(baseUrl, accountPaths[index % accountPaths.length]!, { cookie })));
  assert.equal(accountReads.filter(({ response }) => response.status === 200).length, 12);
  const accountLimited = accountReads.find(({ response }) => response.status === 429);
  assert.equal(accountLimited?.json.error.code, "account_read_rate_limited");
  assert.ok(Number(accountLimited?.response.headers.get("retry-after")) >= 1);

  const untrustedProxyRun = await start();
  const spoofedReads = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    requestJson(untrustedProxyRun.baseUrl, "/v1/public/meshes", {
      clientIp: `198.51.100.${index + 1}`,
    })));
  assert.equal(spoofedReads.filter(({ response }) => response.status === 200).length, 5);
  assert.equal(
    spoofedReads.find(({ response }) => response.status === 429)?.json.error.code,
    "public_mesh_directory_rate_limited",
  );

  const perIpRun = await start({ trustCloudflareConnectingIp: true });
  const perIpReads = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    requestJson(
      perIpRun.baseUrl,
      index % 2 === 0 ? "/v1/public/meshes" : "/v1/public/meshes/mesh-public/topics",
      { clientIp: "192.0.2.10" },
    )));
  assert.equal(perIpReads.filter(({ response }) => response.status === 200).length, 5);
  assert.equal(
    perIpReads.find(({ response }) => response.status === 429)?.json.error.code,
    "public_mesh_directory_rate_limited",
  );

  const globalRun = await start({ trustCloudflareConnectingIp: true });
  const globalReads = await Promise.all(Array.from({ length: 21 }, (_, index) =>
    requestJson(
      globalRun.baseUrl,
      index % 2 === 0 ? "/v1/public/meshes" : "/v1/public/meshes/mesh-public/topics",
      { clientIp: `198.51.100.${index + 1}` },
    )));
  assert.equal(globalReads.filter(({ response }) => response.status === 200).length, 20);
  assert.equal(
    globalReads.find(({ response }) => response.status === 429)?.json.error.code,
    "public_mesh_directory_rate_limited",
  );

  const sourceRun = await start({ trustCloudflareConnectingIp: true });
  const sourceAccounts = await Promise.all(Array.from({ length: 31 }, (_, index) =>
    requestJson(sourceRun.baseUrl, "/v1/accounts", {
      method: "POST",
      body: {
        email: `source-budget-${index}@example.test`,
        password: "a sufficiently long source budget passphrase",
        displayName: `Source Budget ${index}`,
      },
    })));
  const sourceReads = await Promise.all(sourceAccounts.map(({ response }, index) =>
    requestJson(sourceRun.baseUrl, "/v1/meshes", {
      cookie: cookieFrom(response),
      clientIp: "203.0.113.20",
    })));
  assert.equal(sourceReads.filter(({ response }) => response.status === 200).length, 30);
  assert.equal(
    sourceReads.find(({ response }) => response.status === 429)?.json.error.code,
    "account_read_rate_limited",
  );
});

test("expensive-read source rejection happens before durable human-session lookup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-read-preauth-test-"));
  const clock = new TestClock();
  let sessionReads = 0;
  const repository = {
    findHumanSession: async () => {
      sessionReads += 1;
      return null;
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  const attempts = [];
  for (let index = 0; index < 31; index += 1) {
    attempts.push(await requestJson(baseUrl, "/v1/meshes", {
      cookie: "meshr_session=invalid-session-token",
    }));
  }
  assert.equal(attempts.slice(0, 30).every(({ response }) => response.status === 401), true);
  assert.equal(attempts.at(-1)?.response.status, 429);
  assert.equal(attempts.at(-1)?.json.error.code, "account_read_rate_limited");
  assert.equal(sessionReads, 30, "the rejected request must not reach the durable session store");
});

test("account read rejection happens before the durable directory fan-out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-read-fanout-test-"));
  const clock = new TestClock();
  const now = clock.now().toISOString();
  const accountId = "account-read-fanout";
  let directoryReads = 0;
  const repository = {
    findHumanSession: async () => ({
      accountId,
      csrfToken: "read-fanout-csrf",
      createdAt: now,
      expiresAt: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
      absoluteExpiresAt: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
      lastSeenAt: now,
    }),
    findAccountById: async () => ({
      accountId,
      email: "read-fanout@example.test",
      displayName: "Read Fanout",
      createdAt: now,
    }),
    listMeshDirectoryForAccount: async () => {
      directoryReads += 1;
      return [];
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  const responses = [];
  for (let index = 0; index < 13; index += 1) {
    responses.push(await requestJson(baseUrl, "/v1/meshes", {
      cookie: "meshr_session=valid-read-fanout-token",
    }));
  }
  assert.equal(responses.slice(0, 12).every(({ response }) => response.status === 200), true);
  assert.equal(responses.at(-1)?.response.status, 429);
  assert.equal(directoryReads, 12, "the limited request must not query the durable directory");
});

test("single-mesh governance and topic reads avoid the account-wide directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-mesh-scoped-read-test-"));
  const clock = new TestClock();
  const now = clock.now().toISOString();
  const accountId = "account-mesh-scoped-read";
  const meshId = "mesh-scoped-read";
  let narrowReads = 0;
  let directoryReads = 0;
  const mesh = {
    meshId,
    ownerAccountId: null,
    name: "Scoped public mesh",
    description: "A narrow directory fixture",
    visibility: "public" as const,
    admission: "open" as const,
    lifecycle: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  const entry = {
    mesh,
    role: null,
    memberAgentIds: [],
    topics: [
      {
        topic: {
          topicId: "topic-scoped-read",
          meshId,
          name: "general",
          title: "General",
          description: "Scoped topic",
          tags: [],
          createdAt: now,
        },
        activityCount: 0,
        recentActivityCount: 0,
        participantAgentIds: [],
        lastActivityAt: null,
      },
    ],
    roles: [],
  };
  const repository = {
    findHumanSession: async () => ({
      accountId,
      csrfToken: "mesh-scoped-read-csrf",
      createdAt: now,
      expiresAt: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
      absoluteExpiresAt: new Date(
        clock.now().getTime() + 60 * 60_000,
      ).toISOString(),
      lastSeenAt: now,
    }),
    findAccountById: async () => ({
      accountId,
      email: "mesh-scoped-read@example.test",
      displayName: "Scoped Reader",
      createdAt: now,
    }),
    findMeshById: async () => mesh,
    findMeshHumanRole: async () => null,
    findMeshDirectoryEntryForAccount: async (
      requestedMeshId: string,
      requestedAccountId: string,
    ) => {
      narrowReads += 1;
      assert.equal(requestedMeshId, meshId);
      assert.equal(requestedAccountId, accountId);
      return entry;
    },
    listMeshDirectoryForAccount: async () => {
      directoryReads += 1;
      return [entry];
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  const cookie = "meshr_session=mesh-scoped-read-token";
  const governance = await requestJson(
    baseUrl,
    `/v1/meshes/${meshId}/governance`,
    { cookie },
  );
  assert.equal(governance.response.status, 200);
  const topics = await requestJson(baseUrl, `/v1/meshes/${meshId}/topics`, {
    cookie,
  });
  assert.equal(topics.response.status, 200);
  assert.deepEqual(
    topics.json.topics.map((topic: { id: string }) => topic.id),
    ["topic-scoped-read"],
  );
  assert.equal(narrowReads, 2);
  assert.equal(directoryReads, 0);
});

test("mutation authentication never hydrates the account-wide projection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-mutation-scope-test-"));
  const clock = new TestClock();
  const now = clock.now().toISOString();
  const accountId = "account-mutation-scope";
  const meshId = "mesh-mutation-scope";
  let projectionReads = 0;
  let meshReads = 0;
  const mesh = {
    meshId,
    ownerAccountId: accountId,
    name: "Mutation scope",
    description: "A narrow mutation fixture",
    visibility: "private" as const,
    admission: "invite_only" as const,
    lifecycle: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  const repository = {
    findHumanSession: async () => ({
      accountId,
      csrfToken: "mutation-scope-csrf",
      createdAt: now,
      expiresAt: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
      absoluteExpiresAt: new Date(
        clock.now().getTime() + 60 * 60_000,
      ).toISOString(),
      lastSeenAt: now,
    }),
    findAccountById: async () => ({
      accountId,
      email: "mutation-scope@example.test",
      displayName: "Mutation Scope",
      createdAt: now,
    }),
    touchHumanSession: async () => undefined,
    loadProjection: async () => {
      projectionReads += 1;
      throw new Error("account projection must not be loaded by a mutation");
    },
    findMeshById: async () => {
      meshReads += 1;
      return mesh;
    },
    findMeshHumanRole: async () => "owner" as const,
    consumeGovernanceRateLimit: async () => ({
      allowed: true,
      retryAfterSeconds: 0,
    }),
    updateMeshGovernance: async (patch: { name?: string; updatedAt: string }) =>
      ({
        ...mesh,
        name: patch.name ?? mesh.name,
        updatedAt: patch.updatedAt,
      }),
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  const cookie = "meshr_session=mutation-scope-token";
  const rejected = await requestJson(
    baseUrl,
    `/v1/meshes/${meshId}/governance`,
    {
      method: "PUT",
      cookie,
      csrf: "wrong-csrf",
      origin: "http://127.0.0.1",
      body: { name: "Rejected" },
    },
  );
  assert.equal(rejected.response.status, 403);
  assert.equal(meshReads, 0, "failed CSRF must precede mesh reads");
  assert.equal(projectionReads, 0);

  const accepted = await requestJson(
    baseUrl,
    `/v1/meshes/${meshId}/governance`,
    {
      method: "PUT",
      cookie,
      csrf: "mutation-scope-csrf",
      origin: "http://127.0.0.1",
      body: { name: "Narrow mutation" },
    },
  );
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.json.mesh.name, "Narrow mutation");
  assert.equal(projectionReads, 0);
});

test("public previews propagate repository truncation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-public-preview-test-"));
  const clock = new TestClock();
  const now = clock.now().toISOString();
  const mesh = {
    meshId: "mesh-public-preview",
    ownerAccountId: null,
    name: "Public preview",
    description: "Bounded preview fixture",
    visibility: "public" as const,
    admission: "open" as const,
    lifecycle: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  const repository = {
    listPublicMeshes: async () => ({ meshes: [mesh], truncated: true }),
    listPublicTopics: async () => ({
      topics: [
        {
          topicId: "topic-public-preview",
          meshId: mesh.meshId,
          name: "general",
          title: "General",
          description: "Bounded topic fixture",
          tags: [],
          createdAt: now,
        },
      ],
      truncated: true,
    }),
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  const meshes = await requestJson(baseUrl, "/v1/public/meshes");
  assert.equal(meshes.response.status, 200);
  assert.equal(meshes.json.meshes.length, 1);
  assert.equal(meshes.json.truncated, true);
  const topics = await requestJson(
    baseUrl,
    `/v1/public/meshes/${mesh.meshId}/topics`,
  );
  assert.equal(topics.response.status, 200);
  assert.equal(topics.json.topics.length, 1);
  assert.equal(topics.json.truncated, true);
});

test("activity polling requests the bounded activity-only projection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-activity-scope-test-"));
  const clock = new TestClock();
  const now = clock.now().toISOString();
  const accountId = "account-activity-scope";
  const meshId = "mesh-activity-scope";
  const projectionInputs: Array<Record<string, unknown>> = [];
  const repository = {
    findHumanSession: async () => ({
      accountId,
      csrfToken: "activity-scope-csrf",
      createdAt: now,
      expiresAt: new Date(clock.now().getTime() + 60 * 60_000).toISOString(),
      absoluteExpiresAt: new Date(
        clock.now().getTime() + 60 * 60_000,
      ).toISOString(),
      lastSeenAt: now,
    }),
    findAccountById: async () => ({
      accountId,
      email: "activity-scope@example.test",
      displayName: "Activity Scope",
      createdAt: now,
    }),
    loadProjection: async (input: Record<string, unknown>) => {
      projectionInputs.push(input);
      return {
        accounts: [],
        agents: [],
        meshes: [
          {
            meshId,
            ownerAccountId: accountId,
            name: "Scoped activity",
            description: "Aggregate-only fixture",
            visibility: "private" as const,
            admission: "invite_only" as const,
            lifecycle: "active" as const,
            createdAt: now,
            updatedAt: now,
          },
        ],
        topics: [],
        humanRoles: [],
        memberships: [],
        runtimeSessions: [],
        posts: [],
        follows: [],
        activity: { meshes: [], topics: [], agents: [], links: [] },
      } satisfies RepositoryProjection;
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  const activity = await requestJson(
    baseUrl,
    `/v1/activity/public?includeAuthorized=1&meshId=${meshId}`,
    { cookie: "meshr_session=activity-scope-token" },
  );
  assert.equal(activity.response.status, 200);
  assert.equal(projectionInputs.length, 1);
  assert.equal(projectionInputs[0]?.activityOnly, true);
  assert.equal(projectionInputs[0]?.includePosts, false);
  assert.deepEqual(projectionInputs[0]?.meshIds, [meshId]);
});

test("heartbeat bearer rejection happens before durable runtime-session lookup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-heartbeat-preauth-test-"));
  const clock = new TestClock();
  let sessionReads = 0;
  const repository = {
    findRuntimeSessionByTokenHash: async () => {
      sessionReads += 1;
      return null;
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  for (let index = 0; index < 6; index += 1) {
    const rejected = await requestJson(baseUrl, "/v1/agent-sessions/heartbeat", {
      method: "POST",
      authorization: "Bearer repeated-invalid-runtime-token",
    });
    assert.equal(rejected.response.status, 401);
  }
  const readsBeforeLimit = sessionReads;
  const limited = await requestJson(baseUrl, "/v1/agent-sessions/heartbeat", {
    method: "POST",
    authorization: "Bearer repeated-invalid-runtime-token",
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, "heartbeat_rate_limited");
  assert.equal(sessionReads, readsBeforeLimit, "the limited heartbeat must not query the durable session store");
});

test("event pre-auth limits a bearer without throttling a same-source evaluation fleet", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-event-preauth-test-"));
  const clock = new TestClock();
  let sessionReads = 0;
  const repository = {
    findRuntimeSessionByTokenHash: async () => {
      sessionReads += 1;
      return null;
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  const fleetResponses = await Promise.all(Array.from({ length: 36 }, (_, index) =>
    requestJson(baseUrl, "/v1/agent/events", {
      authorization: `Bearer fleet-runtime-token-${index}`,
    })));
  assert.equal(fleetResponses.every(({ response }) => response.status === 401), true);

  // token 0 consumed one slot above; 29 more requests fill its 30-token burst.
  for (let index = 1; index < 30; index += 1) {
    const rejected = await requestJson(baseUrl, "/v1/agent/events", {
      authorization: "Bearer fleet-runtime-token-0",
    });
    assert.equal(rejected.response.status, 401);
  }
  const readsBeforeLimit = sessionReads;
  const limited = await requestJson(baseUrl, "/v1/agent/events", {
    authorization: "Bearer fleet-runtime-token-0",
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, "activity_rate_limited");
  assert.equal(sessionReads, readsBeforeLimit, "the bearer limit must run before durable authentication");
});

test("agent control-mutation source rejection happens before durable session lookup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-agent-mutation-preauth-test-"));
  const clock = new TestClock();
  let sessionReads = 0;
  const repository = {
    findRuntimeSessionByTokenHash: async () => {
      sessionReads += 1;
      return null;
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  for (let index = 0; index < 60; index += 1) {
    const rejected = await requestJson(baseUrl, "/v1/agent/meshes/mesh-public/join", {
      method: "POST",
      authorization: "Bearer repeated-invalid-control-token",
      idempotencyKey: `invalid-control-${index}`,
    });
    assert.equal(rejected.response.status, 401);
  }
  const readsBeforeLimit = sessionReads;
  const limited = await requestJson(baseUrl, "/v1/agent/meshes/mesh-public/join", {
    method: "POST",
    authorization: "Bearer repeated-invalid-control-token",
    idempotencyKey: "invalid-control-limited",
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, "agent_mutation_rate_limited");
  assert.equal(
    sessionReads,
    readsBeforeLimit,
    "the source-limited mutation must not query the durable session store",
  );
});

test("human control source rejection happens before durable session auth or provider verification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-human-control-preauth-test-"));
  const clock = new TestClock();
  let sessionReads = 0;
  let verifierCalls = 0;
  const repository = {
    findHumanSession: async () => {
      sessionReads += 1;
      return null;
    },
  } as unknown as MeshrRepository;
  const identityVerifier: IdentityVerifier = async () => {
    verifierCalls += 1;
    throw new Error("must not verify before human authentication");
  };
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
    identityVerifier,
  });
  const { baseUrl } = await app.listen();
  running.push({ app, baseUrl, directory, clock });

  for (let index = 0; index < 60; index += 1) {
    const rejected = await requestJson(baseUrl, "/v1/account/providers/link", {
      method: "POST",
      cookie: "meshr_session=invalid-human-control-session",
      csrf: "invalid-csrf",
      body: { provider: "google", idToken: `invalid-${index}` },
    });
    assert.equal(rejected.response.status, 401);
  }
  const readsBeforeLimit = sessionReads;
  const limited = await requestJson(baseUrl, "/v1/account/providers/link", {
    method: "POST",
    cookie: "meshr_session=invalid-human-control-session",
    csrf: "invalid-csrf",
    body: { provider: "google", idToken: "invalid-limited" },
  });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, "human_control_rate_limited");
  assert.equal(sessionReads, readsBeforeLimit);
  assert.equal(verifierCalls, 0);
});

test("verified social token replays cannot mint unbounded browser sessions", async () => {
  let verifierCalls = 0;
  let providerFinds = 0;
  let providerCreates = 0;
  let durableSessions = 0;
  const durableRateLimits: Array<
    NonNullable<
      Parameters<MeshrRepository["createHumanSession"]>[0]["socialRateLimit"]
    >
  > = [];
  let durableAccountExists = false;
  const identityVerifier: IdentityVerifier = async (provider) => {
    verifierCalls += 1;
    return {
      provider,
      subject: "bounded-social-subject",
      email: "bounded-social@example.test",
      displayName: "Bounded Social",
      emailVerified: true,
    };
  };
  const durableAccount = {
    accountId: "account-bounded-social",
    email: "bounded-social@example.test",
    displayName: "Bounded Social",
    createdAt: "2026-08-27T18:00:00.000Z",
  };
  const repository = {
    findAccountByProvider: async () => {
      providerFinds += 1;
      return durableAccountExists ? durableAccount : null;
    },
    createSocialAccount: async () => {
      providerCreates += 1;
      durableAccountExists = true;
      return durableAccount;
    },
    createHumanSession: async (
      input: Parameters<MeshrRepository["createHumanSession"]>[0],
    ) => {
      durableSessions += 1;
      assert.ok(input.socialRateLimit);
      durableRateLimits.push(input.socialRateLimit);
    },
  } as unknown as MeshrRepository;
  const { app, baseUrl, clock } = await start({
    identityVerifier,
    repository,
  });
  const responses = [];
  for (let index = 0; index < 5; index += 1) {
    responses.push(
      await requestJson(baseUrl, "/v1/sessions/social", {
        method: "POST",
        body: { provider: "google", idToken: `valid-replay-${index}` },
      }),
    );
  }
  const identityBeforeLimit = app.database.sqlite
    .prepare(
      "SELECT last_seen_at FROM provider_identities WHERE provider = ? AND subject = ?",
    )
    .get("google", "bounded-social-subject") as { last_seen_at: string };
  clock.advance(1_000);
  responses.push(
    await requestJson(baseUrl, "/v1/sessions/social", {
      method: "POST",
      body: { provider: "google", idToken: "valid-replay-limited" },
    }),
  );

  assert.equal(
    responses.slice(0, 5).every(({ response }) => response.status === 201),
    true,
  );
  assert.equal(responses.at(-1)?.response.status, 429);
  assert.equal(
    responses.at(-1)?.json.error.code,
    "social_session_rate_limited",
  );
  assert.equal(verifierCalls, 6, "identity limiting follows successful verification");
  assert.equal(providerFinds, 5, "the rejected replay must not resolve an account");
  assert.equal(providerCreates, 1, "the rejected replay must not create an account");
  assert.equal(durableSessions, 5);
  assert.deepEqual(
    durableRateLimits,
    Array.from({ length: 5 }, () => ({
      subjectHash: createHash("sha256")
        .update("google:bounded-social-subject")
        .digest("hex"),
      capacity: 5,
      refillPerSecond: 10 / 60,
    })),
    "every durable social session must carry the stable distributed bucket contract",
  );
  assert.equal(
    (
      app.database.sqlite
        .prepare(
          "SELECT last_seen_at FROM provider_identities WHERE provider = ? AND subject = ?",
        )
        .get("google", "bounded-social-subject") as { last_seen_at: string }
    ).last_seen_at,
    identityBeforeLimit.last_seen_at,
    "the rejected replay must not advance the local identity projection",
  );
  assert.equal(
    app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM human_sessions")
      .get()?.count,
    5,
  );
});

test("local SQLite social sessions retain the process-local replay cap", async () => {
  const { app, baseUrl } = await start({
    identityVerifier: async (provider) => ({
      provider,
      subject: "local-bounded-social-subject",
      email: "local-bounded-social@example.test",
      displayName: "Local Bounded Social",
      emailVerified: true,
    }),
  });
  const responses = [];
  for (let replay = 0; replay < 6; replay += 1) {
    responses.push(
      await requestJson(baseUrl, "/v1/sessions/social", {
        method: "POST",
        body: { provider: "google", idToken: `local-replay-${replay}` },
      }),
    );
  }

  assert.equal(
    responses.filter(({ response }) => response.status === 201).length,
    5,
  );
  assert.equal(responses.at(-1)?.response.status, 429);
  assert.equal(
    responses.at(-1)?.json.error.code,
    "social_session_rate_limited",
  );
  assert.equal(
    app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM human_sessions")
      .get()?.count,
    5,
  );
});

test("durable social session rate limits return 429 and roll back the local row", async () => {
  const subject = "durably-bounded-social-subject";
  const account = {
    accountId: "account-durably-bounded-social",
    email: "durably-bounded-social@example.test",
    displayName: "Durably Bounded Social",
    createdAt: "2026-08-27T18:00:00.000Z",
  };
  let attemptedSession:
    | Parameters<MeshrRepository["createHumanSession"]>[0]
    | undefined;
  const repository = {
    findAccountByProvider: async () => account,
    createSocialAccount: async () => account,
    createHumanSession: async (
      input: Parameters<MeshrRepository["createHumanSession"]>[0],
    ) => {
      attemptedSession = input;
      throw new Error("social_session_rate_limited:6");
    },
  } as unknown as MeshrRepository;
  const { app, baseUrl } = await start({
    repository,
    identityVerifier: async (provider) => ({
      provider,
      subject,
      email: account.email,
      displayName: account.displayName,
      emailVerified: true,
    }),
  });

  const limited = await requestJson(baseUrl, "/v1/sessions/social", {
    method: "POST",
    body: { provider: "google", idToken: "replayed-provider-token" },
  });

  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "6");
  assert.equal(limited.json.error.code, "social_session_rate_limited");
  assert.deepEqual(attemptedSession?.socialRateLimit, {
    subjectHash: createHash("sha256")
      .update(`google:${subject}`)
      .digest("hex"),
    capacity: 5,
    refillPerSecond: 10 / 60,
  });
  assert.equal(
    app.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM human_sessions")
      .get()?.count,
    0,
    "a durable rejection must remove the session inserted into the replica cache",
  );
});

test("repeatable human control sinks share an authenticated account budget", async () => {
  let verifierCalls = 0;
  const identityVerifier: IdentityVerifier = async () => {
    verifierCalls += 1;
    throw new Error("invalid test provider token");
  };
  const { baseUrl } = await start({ identityVerifier });
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "human-control-budget@example.test",
      password: "a sufficiently long human control passphrase",
      displayName: "Human Control Budget",
    },
  });
  const cookie = cookieFrom(registration.response);
  const csrf = registration.json.csrfToken as string;
  const attempts = [
    await requestJson(baseUrl, "/v1/agents/missing-profile-agent/profile", {
      method: "PUT",
      cookie,
      csrf,
      body: { tagline: "Attempted update" },
    }),
    await requestJson(baseUrl, "/v1/agents/missing-binding-agent/binding", {
      method: "DELETE",
      cookie,
      csrf,
    }),
    await requestJson(baseUrl, "/v1/meshes/mesh-public/governance", {
      method: "PUT",
      cookie,
      csrf,
      body: { description: "Attempted governance update" },
    }),
    await requestJson(baseUrl, "/v1/meshes/mesh-public/agents/missing-agent", {
      method: "DELETE",
      cookie,
      csrf,
    }),
  ];
  assert.equal(attempts.every(({ response }) => response.status !== 429), true);

  for (let index = attempts.length; index < 20; index += 1) {
    const rejected = await requestJson(baseUrl, "/v1/account/providers/link", {
      method: "POST",
      cookie,
      csrf,
      body: { provider: "google", idToken: `invalid-link-${index}` },
    });
    assert.equal(rejected.response.status, 401);
  }
  const limited = await requestJson(
    baseUrl,
    "/v1/agents/another-missing-agent/profile",
    {
      method: "PUT",
      cookie,
      csrf,
      body: { tagline: "This attempt is rejected before target lookup" },
    },
  );
  assert.equal(limited.response.status, 429);
  assert.equal(limited.json.error.code, "human_control_rate_limited");
  assert.equal(verifierCalls, 16);

  // A control budget may never trap the user in a signed-in session.
  const logout = await requestJson(baseUrl, "/v1/session", {
    method: "DELETE",
    cookie,
    csrf,
  });
  assert.equal(logout.response.status, 200);
});

test("semantic owner-profile and mesh-governance replays do not advance local revisions", async () => {
  const { app, baseUrl, clock } = await start();
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "semantic-control-noop@example.test",
      password: "a sufficiently long semantic no-op passphrase",
      displayName: "Semantic No-op",
    },
  });
  const accountId = registration.json.user.id as string;
  const cookie = cookieFrom(registration.response);
  const csrf = registration.json.csrfToken as string;
  const agentId = "agent-semantic-control-noop";
  const createdAt = clock.now().toISOString();
  app.database.sqlite
    .prepare(
      `INSERT INTO agents(
         id, owner_account_id, name, handle, tagline, interests_json,
         personality, attention_json, runtime, runtime_label, runtime_subject,
         public_key_pem, definition_digest, created_at, updated_at
       ) VALUES(?, ?, 'Semantic Agent', 'semantic-agent', 'Stable tagline',
                '[]', 'Careful', ?, 'local', 'Fixture', 'fixture:semantic',
                'fixture-key', NULL, ?, ?)`,
    )
    .run(
      agentId,
      accountId,
      JSON.stringify({
        browse: "public",
        rootPosts: "draft",
        replies: "draft",
        notes: "",
      }),
      createdAt,
      createdAt,
    );
  clock.advance(1_000);
  const profileReplay = await requestJson(
    baseUrl,
    `/v1/agents/${agentId}/profile`,
    {
      method: "PUT",
      cookie,
      csrf,
      body: { tagline: "Stable tagline" },
    },
  );
  assert.equal(profileReplay.response.status, 200);
  assert.equal(profileReplay.json.agent.updatedAt, createdAt);
  assert.equal(
    app.database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE type = 'agent.profile.updated' AND agent_id = ?",
      )
      .get(agentId)?.count,
    0,
  );

  const createdMesh = await requestJson(baseUrl, "/v1/meshes", {
    method: "POST",
    cookie,
    csrf,
    idempotencyKey: "semantic-noop-mesh-create",
    body: {
      name: "Semantic No-op Mesh",
      description: "Stable governance",
      visibility: "private",
      joinPolicy: "invite_only",
    },
  });
  assert.equal(createdMesh.response.status, 201);
  const meshId = createdMesh.json.mesh.id as string;
  const before = app.database.sqlite
    .prepare("SELECT updated_at FROM meshes WHERE id = ?")
    .get(meshId) as { updated_at: string };
  const auditsBefore = app.database.sqlite
    .prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'mesh.governance.updated' AND resource_id = ?",
    )
    .get(meshId) as { count: number };
  clock.advance(1_000);
  const governanceReplay = await requestJson(
    baseUrl,
    `/v1/meshes/${meshId}/governance`,
    {
      method: "PUT",
      cookie,
      csrf,
      body: {
        name: "Semantic No-op Mesh",
        description: "Stable governance",
        visibility: "private",
        joinPolicy: "invite_only",
      },
    },
  );
  assert.equal(governanceReplay.response.status, 200);
  assert.equal(
    (
      app.database.sqlite
        .prepare("SELECT updated_at FROM meshes WHERE id = ?")
        .get(meshId) as { updated_at: string }
    ).updated_at,
    before.updated_at,
  );
  assert.equal(
    (
      app.database.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'mesh.governance.updated' AND resource_id = ?",
        )
        .get(meshId) as { count: number }
    ).count,
    auditsBefore.count,
  );
});

test("durable membership removal preserves observed provenance without fabricating missing history", async () => {
  const accountId = "account-membership-removal-mirror";
  const csrfToken = "membership-removal-csrf";
  const sessionToken = "membership-removal-session";
  const createdAt = "2026-08-27T18:00:00.000Z";
  const expiresAt = "2026-08-28T18:00:00.000Z";
  const repository = {
    findHumanSession: async () => ({
      accountId,
      csrfToken,
      createdAt,
      expiresAt,
      absoluteExpiresAt: expiresAt,
      lastSeenAt: createdAt,
    }),
    touchHumanSession: async () => {},
    findAccountById: async () => ({
      accountId,
      email: "membership-removal@example.test",
      displayName: "Membership Removal",
      createdAt,
    }),
    upsertMeshAgentMembership: async () => ({ changed: true }),
  } as unknown as MeshrRepository;
  const { app, baseUrl, clock } = await start({ repository });
  const meshId = "mesh-public";
  const observedAgentId = "agent-observed-membership";
  const unobservedAgentId = "agent-unobserved-membership";
  const attentionPolicy = JSON.stringify({ replies: "draft", notes: "keep" });

  app.database.transaction(() => {
    app.database.sqlite
      .prepare(
        `INSERT INTO accounts(id, email, display_name, password_hash, created_at)
         VALUES(?, ?, ?, '', ?)`,
      )
      .run(
        accountId,
        "membership-removal@example.test",
        "Membership Removal",
        createdAt,
      );
    app.database.sqlite
      .prepare(
        `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
         VALUES(?, ?, 'steward', ?, ?)`,
      )
      .run(meshId, accountId, createdAt, createdAt);
    const insertAgent = app.database.sqlite.prepare(
      `INSERT INTO agents(
         id, owner_account_id, name, handle, tagline, interests_json,
         personality, attention_json, runtime, runtime_label, runtime_subject,
         public_key_pem, definition_digest, created_at, updated_at
       ) VALUES(?, ?, ?, ?, '', '[]', '', '{}', 'local', 'Fixture', ?,
                'fixture-key', NULL, ?, ?)`,
    );
    insertAgent.run(
      observedAgentId,
      accountId,
      "Observed Membership",
      "observed-membership",
      `fixture:${observedAgentId}`,
      createdAt,
      createdAt,
    );
    insertAgent.run(
      unobservedAgentId,
      accountId,
      "Unobserved Membership",
      "unobserved-membership",
      `fixture:${unobservedAgentId}`,
      createdAt,
      createdAt,
    );
    app.database.sqlite
      .prepare(
        "INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
      )
      .run(meshId, observedAgentId, createdAt);
    app.database.sqlite
      .prepare(
        `INSERT INTO mesh_agent_memberships(
           mesh_id, agent_id, status, attention_policy_json,
           admission_provenance, joined_at, updated_at
         ) VALUES(?, ?, 'joined', ?, 'approval', ?, ?)`,
      )
      .run(meshId, observedAgentId, attentionPolicy, createdAt, createdAt);
  });
  clock.advance(1_000);

  const cookie = `meshr_session=${sessionToken}`;
  const observedRemoval = await requestJson(
    baseUrl,
    `/v1/meshes/${meshId}/agents/${observedAgentId}`,
    { method: "DELETE", cookie, csrf: csrfToken, origin: baseUrl },
  );
  assert.equal(observedRemoval.response.status, 200);
  const preserved = app.database.sqlite
    .prepare(
      `SELECT status, attention_policy_json, admission_provenance, joined_at, updated_at
       FROM mesh_agent_memberships WHERE mesh_id = ? AND agent_id = ?`,
    )
    .get(meshId, observedAgentId) as {
    status: string;
    attention_policy_json: string;
    admission_provenance: string;
    joined_at: string;
    updated_at: string;
  };
  assert.deepEqual({ ...preserved }, {
    status: "removed",
    attention_policy_json: attentionPolicy,
    admission_provenance: "approval",
    joined_at: createdAt,
    updated_at: clock.now().toISOString(),
  });
  assert.equal(
    app.database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM mesh_members WHERE mesh_id = ? AND agent_id = ?",
      )
      .get(meshId, observedAgentId)?.count,
    0,
  );

  const unobservedRemoval = await requestJson(
    baseUrl,
    `/v1/meshes/${meshId}/agents/${unobservedAgentId}`,
    { method: "DELETE", cookie, csrf: csrfToken, origin: baseUrl },
  );
  assert.equal(unobservedRemoval.response.status, 200);
  assert.equal(
    app.database.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM mesh_agent_memberships WHERE mesh_id = ? AND agent_id = ?",
      )
      .get(meshId, unobservedAgentId)?.count,
    0,
    "a replica missing the durable row must not invent admission provenance",
  );
});

test("rotating idempotency keys cannot amplify native agent control writes", async () => {
  const { app, baseUrl, clock } = await start();
  const now = clock.now().toISOString();
  const expiresAt = new Date(clock.now().getTime() + 60 * 60_000).toISOString();
  const token = "bounded-agent-control-token";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const agentId = "agent-control-budget";
  const accountId = "account-control-budget";
  const pairingId = "pairing-control-budget";
  const sessionId = "session-control-budget";
  const postId = "post-control-budget";

  app.database.transaction(() => {
    app.database.sqlite.prepare(
      "INSERT INTO accounts(id, email, display_name, password_hash, created_at) VALUES(?, ?, ?, ?, ?)",
    ).run(accountId, "control-budget@example.test", "Control Budget", "fixture", now);
    app.database.sqlite.prepare(
      `INSERT INTO agents(
         id, owner_account_id, name, handle, tagline, interests_json,
         personality, attention_json, runtime, runtime_label, runtime_subject,
         public_key_pem, definition_digest, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentId,
      accountId,
      "Control Budget Agent",
      "control-budget-agent",
      "Exercises bounded control writes",
      "[]",
      "Careful",
      JSON.stringify({ browse: "public", rootPosts: "autonomous", replies: "autonomous" }),
      "local",
      "Control budget fixture",
      "fixture:control-budget",
      "fixture-key",
      null,
      now,
      now,
    );
    app.database.sqlite.prepare(
      `INSERT INTO pairings(
         id, code, secret_hash, runtime, runtime_label, external_subject,
         public_key_pem, requested_profile_json, definition_digest, status,
         owner_account_id, agent_id, created_at, expires_at, approved_at, claimed_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'claimed', ?, ?, ?, ?, ?, ?)`,
    ).run(
      pairingId,
      "CONTROL-BUDGET",
      "fixture-secret",
      "local",
      "Control budget fixture",
      "fixture:control-budget",
      "fixture-key",
      accountId,
      agentId,
      now,
      expiresAt,
      now,
      now,
    );
    app.database.sqlite.prepare(
      `INSERT INTO agent_sessions(
         token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
         session_id, runtime_kind, status, authority_epoch
       ) VALUES(?, ?, ?, ?, ?, ?, ?, 'local', 'active', 1)`,
    ).run(tokenHash, agentId, pairingId, now, expiresAt, now, sessionId);
    app.database.sqlite.prepare(
      `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
       VALUES(?, 1, 'native', ?, ?)`,
    ).run(agentId, sessionId, now);
    app.database.sqlite.prepare(
      "INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES('mesh-public', ?, ?)",
    ).run(agentId, now);
    app.database.sqlite.prepare(
      `INSERT INTO posts(
         id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
         created_at, moderation_state, moderation_reason, expires_at
       ) VALUES(?, 'mesh-public', 'topic-small-discoveries', ?, ?, NULL, ?, ?, 'quarantined', ?, ?)`,
    ).run(
      postId,
      agentId,
      sessionId,
      "A fixture post awaiting appeal.",
      now,
      "fixture_review",
      "2026-11-25T18:00:00.000Z",
    );
  });

  const authorization = `Bearer ${token}`;
  const responses = [];
  for (let index = 0; index < 31; index += 1) {
    const idempotencyKey = `agent-control-${index}`;
    switch (index % 4) {
      case 0:
        responses.push(await requestJson(baseUrl, "/v1/agent/meshes/mesh-public/join", {
          method: "POST",
          authorization,
          idempotencyKey,
        }));
        break;
      case 1:
        responses.push(await requestJson(
          baseUrl,
          "/v1/agent/topics/topic-small-discoveries/follow",
          { method: "PUT", authorization, idempotencyKey },
        ));
        break;
      case 2:
        responses.push(await requestJson(baseUrl, "/v1/agent/profile", {
          method: "PUT",
          authorization,
          idempotencyKey,
          body: { profile: { tagline: `Bounded control update ${index}` } },
        }));
        break;
      default:
        responses.push(await requestJson(baseUrl, `/v1/agent/posts/${postId}/appeal`, {
          method: "POST",
          authorization,
          idempotencyKey,
          body: { reason: `Bounded appeal ${index}` },
        }));
    }
  }

  assert.equal(
    responses.slice(0, 30).every(({ response }) => response.status >= 200 && response.status < 300),
    true,
  );
  assert.equal(responses.at(-1)?.response.status, 429);
  assert.equal(responses.at(-1)?.json.error.code, "agent_mutation_rate_limited");
  assert.ok(Number(responses.at(-1)?.response.headers.get("retry-after")) >= 1);
  assert.equal(
    app.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM idempotency_records WHERE agent_id = ?",
    ).get(agentId)?.count,
    30,
    "the rejected rotating key must not allocate another idempotency record",
  );
});

test("mesh creation is rate limited before its account-wide quota projection", async () => {
  const { baseUrl } = await start();
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "mesh-create-budget@example.test",
      password: "a sufficiently long mesh creation passphrase",
      displayName: "Mesh Creation Budget",
    },
  });
  assert.equal(registration.response.status, 201);
  const cookie = cookieFrom(registration.response);
  const csrf = registration.json.csrfToken as string;
  const creates = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    requestJson(baseUrl, "/v1/meshes", {
      method: "POST",
      cookie,
      csrf,
      idempotencyKey: `mesh-create-budget-${index}`,
      body: {
        name: `Bounded mesh ${index}`,
        visibility: "private",
        joinPolicy: "invite_only",
      },
    })));
  assert.equal(creates.filter(({ response }) => response.status === 201).length, 5);
  assert.equal(
    creates.find(({ response }) => response.status === 429)?.json.error.code,
    "mesh_create_rate_limited",
  );
});

test("activity preference writes are bounded and default state consumes no row", async () => {
  const { app, baseUrl } = await start();
  const register = async (email: string) => {
    const response = await requestJson(baseUrl, "/v1/accounts", {
      method: "POST",
      body: {
        email,
        password: "a sufficiently long preference passphrase",
        displayName: "Preference Budget",
      },
    });
    assert.equal(response.response.status, 201);
    return {
      id: response.json.user.id as string,
      cookie: cookieFrom(response.response),
      csrf: response.json.csrfToken as string,
    };
  };
  const owner = await register("preference-budget@example.test");
  const defaultPreference = await requestJson(
    baseUrl,
    "/v1/activity/preferences/topic/topic-small-discoveries",
    {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { watching: false, muted: false },
    },
  );
  assert.equal(defaultPreference.response.status, 200);
  assert.equal(
    app.database.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM human_activity_preferences WHERE account_id = ?",
    ).get(owner.id)?.count,
    0,
  );

  app.database.transaction(() => {
    const insert = app.database.sqlite.prepare(
      `INSERT INTO human_activity_preferences(
         account_id, kind, resource_id, watching, muted, updated_at
       ) VALUES(?, 'link', ?, 1, 0, ?)`,
    );
    for (let index = 0; index < 500; index += 1) {
      insert.run(owner.id, `traffic:mesh-public:source-${index}:target-${index}`, app.database.now());
    }
  });
  const capped = await requestJson(
    baseUrl,
    "/v1/activity/preferences/link/traffic%3Amesh-public%3Anew-source%3Anew-target",
    {
      method: "PUT",
      cookie: owner.cookie,
      csrf: owner.csrf,
      body: { watching: true },
    },
  );
  assert.equal(capped.response.status, 429);
  assert.equal(capped.json.error.code, "activity_preference_limit_reached");

  const rateOwner = await register("preference-rate@example.test");
  const rateResponses = await Promise.all(Array.from({ length: 21 }, (_, index) =>
    requestJson(baseUrl, `/v1/activity/preferences/link/invalid-${index}`, {
      method: "PUT",
      cookie: rateOwner.cookie,
      csrf: rateOwner.csrf,
      body: { watching: true },
    })));
  assert.equal(rateResponses.filter(({ response }) => response.status === 400).length, 20);
  assert.equal(
    rateResponses.find(({ response }) => response.status === 429)?.json.error.code,
    "activity_preference_rate_limited",
  );
});

test("account, pairing, Ed25519 claim, agent posting, reply, follow, and event polling work end to end", async () => {
  const { app, baseUrl, clock } = await start();
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
        // Omit browse/replies intentionally. The approval representation must
        // disclose the same effective defaults the server will authorize.
        attention: { rootPosts: "autonomous" },
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
  assert.deepEqual(lookup.json.pairing.requestedProfile.attention, {
    browse: "public",
    rootPosts: "autonomous",
    replies: "draft",
    notes: "",
  });
  assert.equal(lookup.json.pairing.externalSubject, "openclaw:bramble");
  assert.equal(lookup.json.pairing.definitionDigest, definitionDigest);

  const csrfRejected = await requestJson(baseUrl, `/v1/pairings/${pairingId}/approve`, {
    method: "POST",
    cookie,
    body: {},
  });
  assert.equal(csrfRejected.response.status, 403);
  assert.equal(csrfRejected.json.error.code, "csrf_failed");

  const missingDurableActionAcknowledgement = await requestJson(
    baseUrl,
    `/v1/pairings/${pairingId}/approve`,
    { method: "POST", cookie, csrf, body: {} },
  );
  assert.equal(missingDurableActionAcknowledgement.response.status, 400);
  assert.equal(
    missingDurableActionAcknowledgement.json.error.code,
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
  const lastSeenBeforeProbe = (app.database.sqlite
    .prepare("SELECT last_seen_at FROM agent_sessions WHERE session_id = ?")
    .get(claim.json.sessionId) as { last_seen_at: string }).last_seen_at;
  clock.advance(1_000);
  const sessionProbe = await requestJson(baseUrl, "/v1/agent/session", {
    authorization: agentAuth,
  });
  assert.equal(sessionProbe.response.status, 200);
  assert.equal(sessionProbe.json.sessionId, claim.json.sessionId);
  assert.equal(sessionProbe.json.status, "online");
  const lastSeenAfterProbe = (app.database.sqlite
    .prepare("SELECT last_seen_at FROM agent_sessions WHERE session_id = ?")
    .get(claim.json.sessionId) as { last_seen_at: string }).last_seen_at;
  assert.equal(lastSeenAfterProbe, lastSeenBeforeProbe);
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
  const otherInviteOnlyMesh = await requestJson(baseUrl, "/v1/meshes", {
    method: "POST",
    cookie,
    csrf,
    idempotencyKey: "cross-mesh-invitation-target",
    body: {
      name: "Other invite-only mesh",
      visibility: "private",
      joinPolicy: "invite_only",
    },
  });
  assert.equal(otherInviteOnlyMesh.response.status, 201);
  const crossMeshReplay = await requestJson(
    baseUrl,
    `/v1/agent/meshes/${otherInviteOnlyMesh.json.mesh.id}/join`,
    {
      method: "POST",
      authorization: agentAuth,
      idempotencyKey: "mesh-join-cross-mesh-invite-001",
      body: { invitationToken: invitation.json.token },
    },
  );
  assert.equal(crossMeshReplay.response.status, 403);
  assert.equal(crossMeshReplay.json.error.code, "invitation_invalid");
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
  const storedPost = app.database.sqlite
    .prepare("SELECT session_id FROM posts WHERE id = ?")
    .get(postId) as { session_id: string };
  assert.equal(storedPost.session_id, claim.json.sessionId);

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

  const mentionPolicy = await requestJson(
    baseUrl,
    `/v1/agents/${claim.json.agent.id}/profile`,
    {
      method: "PUT",
      cookie,
      csrf,
      body: { profile: { attention: { browse: "mentions" } } },
    },
  );
  assert.equal(mentionPolicy.response.status, 200);
  const mentionJoin = await requestJson(baseUrl, "/v1/agent/meshes/mesh-unjoined/join", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "mesh-join-mentions-denied-001",
  });
  assert.equal(mentionJoin.response.status, 403);
  assert.equal(mentionJoin.json.error.code, "attention_policy_denied");
  const mentionFollow = await requestJson(baseUrl, `/v1/agent/topics/${topicId}/follow`, {
    method: "PUT",
    authorization: agentAuth,
    idempotencyKey: "follow-mentions-denied-001",
  });
  assert.equal(mentionFollow.response.status, 403);
  assert.equal(mentionFollow.json.error.code, "attention_policy_denied");
  const mentionPost = await requestJson(baseUrl, "/v1/agent/posts", {
    method: "POST",
    authorization: agentAuth,
    idempotencyKey: "post-bramble-mention-001",
    body: { meshId: "mesh-public", topicId, body: "A note for @bramble-live and @2fast_agent." },
  });
  assert.equal(mentionPost.response.status, 201);
  const mentions = await requestJson(baseUrl, "/v1/agent/events?after=0", {
    authorization: agentAuth,
  });
  assert.equal(mentions.response.status, 200);
  assert.ok(mentions.json.events.length > 0);
  assert.ok(mentions.json.events.every((event: any) =>
    Array.isArray(event.data?.mentionedHandles) &&
    event.data.mentionedHandles.includes("bramble-live") &&
    event.data.mentionedHandles.includes("2fast_agent"),
  ));

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
    { method: "POST", cookie, csrf, body: { acknowledgeAutonomous: true } },
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
    { method: "POST", cookie, csrf, body: { acknowledgeAutonomous: true } },
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
      body: { acknowledgeAutonomous: true },
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

test("durable event polling rechecks native session and browse authority after a raced query", async () => {
  for (const racedAuthority of ["attention", "session"] as const) {
    const directory = mkdtempSync(join(tmpdir(), `meshr-event-${racedAuthority}-race-test-`));
    const clock = new TestClock();
    const token = `race-agent-token-${racedAuthority}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const sessionId = `session-event-race-${racedAuthority}`;
    const agentId = `agent-event-race-${racedAuthority}`;
    const accountId = `account-event-race-${racedAuthority}`;
    const now = clock.now().toISOString();
    const expiresAt = new Date(clock.now().getTime() + 60 * 60_000).toISOString();
    let queryStarted!: () => void;
    let releaseQuery!: () => void;
    const queryStartedPromise = new Promise<void>((resolve) => { queryStarted = resolve; });
    const queryReleasePromise = new Promise<void>((resolve) => { releaseQuery = resolve; });
    let revoked = false;
    let browse: "public" | "mentions" = "public";
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
      findAgentById: async () => ({
        agentId,
        bindingId: "binding-event-race",
        ownerAccountId: accountId,
        name: "Event Race Agent",
        handle: "event-race-agent",
        tagline: "Verifies terminal event authority",
        interests: ["testing"],
        personality: "Careful",
        attention: { browse, rootPosts: "autonomous", replies: "autonomous" },
        runtime: "openclaw",
        runtimeLabel: "Race fixture",
        runtimeSubject: "fixture:event-race",
        publicKeyPem: "fixture-key",
        definitionDigest: null,
        createdAt: now,
        updatedAt: now,
      }),
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
      VALUES('${accountId}', '${racedAuthority}-event-race@example.test', 'Event Race', '', '${now}');
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
    if (racedAuthority === "attention") browse = "mentions";
    else revoked = true;
    releaseQuery();
    const raced = await pending;
    assert.equal(raced.response.status, racedAuthority === "attention" ? 409 : 401);
    assert.equal(
      raced.json.error.code,
      racedAuthority === "attention" ? "attention_policy_changed" : "agent_authentication_failed",
    );
  }
});

test("local join-request resolution rechecks session, role, and admission after a slow body", async () => {
  const { app, baseUrl, clock } = await start();
  const registration = await requestJson(baseUrl, "/v1/accounts", {
    method: "POST",
    body: {
      email: "slow-governance@example.test",
      password: "a sufficiently long governance passphrase",
      displayName: "Slow Governance",
    },
  });
  assert.equal(registration.response.status, 201);
  const cookie = cookieFrom(registration.response);
  const csrf = registration.json.csrfToken as string;
  const accountId = registration.json.user.id as string;
  const agentId = "agent-slow-governance";
  const requestId = "join-request-slow-governance";
  const now = app.database.now();
  app.database.sqlite.prepare(
    `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
     VALUES('mesh-public', ?, 'steward', ?, ?)`,
  ).run(accountId, now, now);
  app.database.sqlite.prepare(
    `INSERT INTO agents(
       id, owner_account_id, name, handle, tagline, interests_json,
       personality, attention_json, runtime, runtime_label, runtime_subject,
       public_key_pem, definition_digest, created_at, updated_at
     ) VALUES(?, ?, 'Slow Agent', 'slow-governance-agent', '', '[]', '', ?,
       'other', 'Slow fixture', 'fixture:slow-governance', 'fixture-key', NULL, ?, ?)`,
  ).run(
    agentId,
    accountId,
    JSON.stringify({ browse: "public", rootPosts: "draft", replies: "draft", notes: "" }),
    now,
    now,
  );
  app.database.sqlite.prepare(
    `INSERT INTO mesh_join_requests(
       id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
     ) VALUES(?, 'mesh-public', ?, ?, 'pending', ?, NULL)`,
  ).run(requestId, agentId, accountId, now);

  clock.advance(1_000);
  const requestStartedAt = app.database.now();
  const slowRequest = beginSlowJsonRequest(
    baseUrl,
    `/v1/meshes/mesh-public/join-requests/${requestId}/resolve`,
    { cookie, csrf },
  );
  let admitted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = app.database.sqlite
      .prepare("SELECT last_seen_at FROM human_sessions WHERE account_id = ?")
      .get(accountId) as { last_seen_at: string } | undefined;
    if (session?.last_seen_at === requestStartedAt) {
      admitted = true;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(admitted, true, "the slow request must pass initial authentication before demotion");
  await new Promise<void>((resolve) => setImmediate(resolve));
  app.database.sqlite
    .prepare("UPDATE mesh_human_roles SET role = 'observer', updated_at = ? WHERE mesh_id = 'mesh-public' AND account_id = ?")
    .run(app.database.now(), accountId);

  const raced = await slowRequest.finish('"approved"}');
  assert.equal(raced.status, 403);
  assert.equal(raced.json.error.code, "mesh_governance_denied");
  assert.equal(
    (app.database.sqlite.prepare("SELECT status FROM mesh_join_requests WHERE id = ?").get(requestId) as { status: string }).status,
    "pending",
  );
  assert.equal(
    app.database.sqlite.prepare("SELECT 1 FROM mesh_members WHERE mesh_id = 'mesh-public' AND agent_id = ?").get(agentId),
    undefined,
  );

  app.database.sqlite
    .prepare(
      "UPDATE mesh_human_roles SET role = 'steward', updated_at = ? WHERE mesh_id = 'mesh-public' AND account_id = ?",
    )
    .run(app.database.now(), accountId);
  app.database.sqlite
    .prepare("UPDATE meshes SET join_policy = 'approval' WHERE id = 'mesh-public'")
    .run();
  clock.advance(1_000);
  const policyRequestStartedAt = app.database.now();
  const policyRace = beginSlowJsonRequest(
    baseUrl,
    `/v1/meshes/mesh-public/join-requests/${requestId}/resolve`,
    { cookie, csrf },
  );
  admitted = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const session = app.database.sqlite
      .prepare("SELECT last_seen_at FROM human_sessions WHERE account_id = ?")
      .get(accountId) as { last_seen_at: string } | undefined;
    if (session?.last_seen_at === policyRequestStartedAt) {
      admitted = true;
      break;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(admitted, true, "the policy-race request must pass initial authentication");
  await new Promise<void>((resolve) => setImmediate(resolve));
  app.database.sqlite
    .prepare("UPDATE meshes SET join_policy = 'invite_only' WHERE id = 'mesh-public'")
    .run();

  const policyRejected = await policyRace.finish('"approved"}');
  assert.equal(policyRejected.status, 409);
  assert.equal(policyRejected.json.error.code, "mesh_admission_changed");
  assert.equal(
    (app.database.sqlite.prepare("SELECT status FROM mesh_join_requests WHERE id = ?").get(requestId) as { status: string }).status,
    "pending",
  );
  const denied = await requestJson(
    baseUrl,
    `/v1/meshes/mesh-public/join-requests/${requestId}/resolve`,
    { method: "POST", cookie, csrf, body: { decision: "denied" } },
  );
  assert.equal(denied.response.status, 200);
  assert.equal(
    (app.database.sqlite.prepare("SELECT status FROM mesh_join_requests WHERE id = ?").get(requestId) as { status: string }).status,
    "denied",
  );
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
