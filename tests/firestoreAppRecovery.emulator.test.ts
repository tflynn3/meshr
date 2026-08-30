import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { test } from "node:test";
import { createMeshrServer } from "../server/app.ts";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";

/**
 * This is intentionally a separate emulator gate from the repository
 * conformance test. It proves the API behavior that a two-replica deployment
 * relies on: the second replica may have an empty SQLite projection after the
 * first replica committed a renewal, but it can still recover the durable
 * durable successor from Firestore.
 */
test("Firestore API renewal recovery survives a fresh replica", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
  const firestore = new Firestore({ projectId, databaseId: "(default)" });
  const prefix = `app_recovery_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const invitationPepper = `${prefix}:invitation-pepper`;
  const repository = new FirestoreMeshrRepository({
    firestore,
    collectionPrefix: prefix,
    invitationPepper,
  });
  const directories: string[] = [];
  const apps: Array<{ close(): Promise<void> }> = [];
  const requestJson = async (
    baseUrl: string,
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      csrf?: string;
      authorization?: string;
      webMcpAgent?: string;
    } = {},
  ): Promise<{ response: Response; json: any }> => {
    const headers = new Headers();
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.cookie) headers.set("Cookie", options.cookie);
    if (options.csrf) headers.set("X-Meshr-CSRF", options.csrf);
    if (options.authorization) headers.set("Authorization", options.authorization);
    if (options.webMcpAgent) headers.set("X-Meshr-WebMCP-Agent", options.webMcpAgent);
    // The API enforces same-origin CSRF protection for every state-changing
    // request. Keep this helper representative of a browser/native host
    // request so the cross-replica recovery gate exercises the real boundary.
    if ((options.method ?? "GET") !== "GET") headers.set("Origin", new URL(baseUrl).origin);
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { response, json: await response.json() };
  };
  const cleanup = async () => {
    for (const app of apps.reverse()) await app.close();
    const names = [
      "system", "meshes", "topics", "accounts", "provider_identities", "human_sessions",
      "pairings", "pairing_challenges", "agents", "agent_handles", "agent_bindings",
      "mesh_agent_memberships", "agent_authority", "runtime_sessions", "webmcp_grants",
      "webmcp_authority", "live_access_epochs", "mesh_human_roles", "mesh_join_requests",
      "event_outbox", "event_outbox_ready", "event_audit", "audit_events", "governance_events",
      "idempotency", "quota_counters", "posts", "follows", "mesh_invitations",
      "mesh_role_invitations", "moderation_cases", "topology_activity_totals",
      "topology_activity_buckets", "topology_activity_recent", "topology_activity_snapshots",
      "projection_bootstrap",
      "processed_events", "topology_shards", "topology_events", "mesh_access_epochs", "live_access_epochs",
    ];
    for (const name of names) {
      const collection = firestore.collection(`${prefix}_${name}`);
      const snapshot = await collection.get();
      if (!snapshot.empty) await firestore.recursiveDelete(collection);
    }
    await firestore.terminate();
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  };

  try {
    await repository.ensureEmptyProduction();
    const keyPair = generateKeyPairSync("ed25519");
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const firstDirectory = mkdtempSync(join(tmpdir(), "meshr-firestore-recovery-"));
    directories.push(firstDirectory);
    const firstApp = createMeshrServer({
      dbPath: join(firstDirectory, "meshr.db"),
      repository,
      invitationPepper,
      secureCookies: false,
      webMcpTransfersSession: true,
    });
    apps.push(firstApp);
    const first = await firstApp.listen();
    // Seed the human through the same durable account/session port used by
    // the Identity Platform exchange. The recovery gate intentionally starts
    // with a fresh SQLite projection, so a local-only password account would
    // create an invalid hybrid authority fixture.
    const account = await repository.createSocialAccount({
      provider: "github",
      subject: `${prefix}:github-owner`,
      email: `${prefix}@example.test`,
      displayName: "Replica Recovery Owner",
    });
    const humanToken = `human-${prefix}`;
    const humanTokenHash = createHash("sha256").update(humanToken).digest("hex");
    const csrf = `${prefix}:csrf`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1_000).toISOString();
    await repository.createHumanSession({
      tokenHash: humanTokenHash,
      accountId: account.accountId,
      csrfToken: csrf,
      createdAt,
      expiresAt,
      absoluteExpiresAt: expiresAt,
    });
    const cookie = `meshr_session=${humanToken}`;
    const pairing = await requestJson(first.baseUrl, "/v1/pairings", {
      method: "POST",
      body: {
        runtime: "openclaw",
        label: "Recovery fixture",
        externalSubject: `${prefix}:openclaw`,
        publicKey,
        profile: {
          name: "Replica Recovery Agent",
          handle: `${prefix.slice(0, 20)}-agent`,
          attention: { browse: "public", rootPosts: "draft", replies: "never" },
        },
      },
    });
    assert.equal(pairing.response.status, 201);
    const pairingId = pairing.json.pairingId as string;
    const pairingAuth = `Pairing ${pairing.json.pairingSecret as string}`;
    const approval = await requestJson(first.baseUrl, `/v1/pairings/${pairingId}/approve`, {
      method: "POST",
      cookie,
      csrf,
      body: {},
    });
    assert.equal(approval.response.status, 200);
    const claimChallenge = await requestJson(first.baseUrl, `/v1/pairings/${pairingId}/challenges`, {
      method: "POST",
      authorization: pairingAuth,
      body: {},
    });
    assert.equal(claimChallenge.response.status, 201);
    const claimSignature = sign(
      null,
      Buffer.from(claimChallenge.json.message as string, "utf8"),
      keyPair.privateKey,
    ).toString("base64url");
    const claim = await requestJson(first.baseUrl, "/v1/agent-sessions", {
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

    // Force the durable predecessor into the expired window. The first API
    // replica can therefore commit a renewal, while the second starts with no
    // local session rows and must recover from Firestore alone.
    const predecessorRef = firestore
      .collection(`${prefix}_runtime_sessions`)
      .doc(predecessorSessionId);
    await predecessorRef.update({
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    const recoveryChallenge = await requestJson(first.baseUrl, `/v1/pairings/${pairingId}/challenges`, {
      method: "POST",
      authorization: pairingAuth,
      body: { sessionId: predecessorSessionId },
    });
    assert.equal(recoveryChallenge.response.status, 201);
    const recoverySignature = sign(
      null,
      Buffer.from(recoveryChallenge.json.message as string, "utf8"),
      keyPair.privateKey,
    ).toString("base64url");
    const firstRenewal = await requestJson(first.baseUrl, "/v1/agent-sessions/renew", {
      method: "POST",
      authorization: pairingAuth,
      body: {
        pairingId,
        challengeId: recoveryChallenge.json.challengeId,
        sessionId: predecessorSessionId,
        signature: recoverySignature,
      },
    });
    assert.equal(firstRenewal.response.status, 201);

    const secondDirectory = mkdtempSync(join(tmpdir(), "meshr-firestore-recovery-"));
    directories.push(secondDirectory);
    const secondApp = createMeshrServer({
      dbPath: join(secondDirectory, "meshr.db"),
      repository,
      invitationPepper,
      secureCookies: false,
      webMcpTransfersSession: true,
    });
    apps.push(secondApp);
    const second = await secondApp.listen();
    const retryChallenge = await requestJson(second.baseUrl, `/v1/pairings/${pairingId}/challenges`, {
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
    const recovered = await requestJson(second.baseUrl, "/v1/agent-sessions/renew", {
      method: "POST",
      authorization: pairingAuth,
      body: {
        pairingId,
        challengeId: retryChallenge.json.challengeId,
        sessionId: predecessorSessionId,
        signature: retrySignature,
      },
    });
    assert.equal(recovered.response.status, 200);
    assert.equal(recovered.json.sessionId, firstRenewal.json.sessionId);
    assert.equal(recovered.json.token, firstRenewal.json.token);

    const localSuccessor = secondApp.database.sqlite
      .prepare("SELECT status FROM agent_sessions WHERE session_id = ? AND agent_id = ?")
      .get(firstRenewal.json.sessionId, agentId) as { status: string } | undefined;
    assert.equal(localSuccessor?.status, "active");
    assert.equal(
      (await repository.findRuntimeSessionById(predecessorSessionId))?.status,
      "superseded",
    );

    // The page handoff is committed by the first API replica, then the
    // browser lands on a fresh replica with an empty SQLite projection. A
    // valid durable grant must restore both local authority fences before a
    // real page-tool request is admitted.
    const transfer = await requestJson(first.baseUrl, "/v1/webmcp/session", {
      method: "POST",
      cookie,
      csrf,
      body: { agentId },
    });
    assert.equal(transfer.response.status, 201);
    const webMcpCookie = (transfer.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.match(webMcpCookie, /^meshr_webmcp=/);
    const recoveredPageState = await requestJson(second.baseUrl, "/v1/webmcp/session", {
      method: "POST",
      cookie,
      csrf,
      body: { agentId },
    });
    assert.equal(recoveredPageState.response.status, 200);
    assert.equal(recoveredPageState.json.enabled, true);
    assert.equal(recoveredPageState.json.agent.id, agentId);
    const recoveredPageCookie = (recoveredPageState.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.equal(recoveredPageCookie, webMcpCookie);
    const recoveredPageProfile = await requestJson(second.baseUrl, "/v1/webmcp/profile", {
      cookie: `${cookie}; ${webMcpCookie}`,
      webMcpAgent: agentId,
    });
    assert.equal(recoveredPageProfile.response.status, 200);
    assert.equal(recoveredPageProfile.json.agent.id, agentId);
    const recoveredPageAuthority = secondApp.database.sqlite
      .prepare("SELECT grant_id, agent_id, session_id FROM webmcp_authority WHERE human_session_hash = ?")
      .get(humanTokenHash) as { grant_id: string; agent_id: string; session_id: string } | undefined;
    assert.equal(recoveredPageAuthority?.agent_id, agentId);
    assert.match(recoveredPageAuthority?.grant_id ?? "", /^[a-f0-9]{64}$/);
    assert.match(recoveredPageAuthority?.session_id ?? "", /^page_/);

    // Activation itself may also land on a replica with no local profile
    // projection. The durable grant is the retry/recovery source of truth, so
    // a fresh third replica must hydrate the owned agent before returning the
    // already-committed handoff rather than responding with a replica-local 404.
    const thirdDirectory = mkdtempSync(join(tmpdir(), "meshr-firestore-recovery-"));
    directories.push(thirdDirectory);
    const thirdApp = createMeshrServer({
      dbPath: join(thirdDirectory, "meshr.db"),
      repository,
      invitationPepper,
      secureCookies: false,
      webMcpTransfersSession: true,
    });
    apps.push(thirdApp);
    const third = await thirdApp.listen();
    const thirdLocalAgent = thirdApp.database.sqlite
      .prepare("SELECT id FROM agents WHERE id = ?")
      .get(agentId) as { id: string } | undefined;
    assert.equal(thirdLocalAgent, undefined);
    const reactivated = await requestJson(third.baseUrl, "/v1/webmcp/session", {
      method: "POST",
      cookie,
      csrf,
      body: { agentId },
    });
    assert.equal(reactivated.response.status, 200);
    assert.equal(reactivated.json.enabled, true);
    assert.equal(reactivated.json.agent.id, agentId);
    const reactivatedCookie = (reactivated.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.match(reactivatedCookie, /^meshr_webmcp=/);
    const reactivatedProfile = await requestJson(third.baseUrl, "/v1/webmcp/profile", {
      cookie: `${cookie}; ${reactivatedCookie}`,
      webMcpAgent: agentId,
    });
    assert.equal(reactivatedProfile.response.status, 200);
    assert.equal(reactivatedProfile.json.agent.id, agentId);
  } finally {
    await cleanup();
  }
});
