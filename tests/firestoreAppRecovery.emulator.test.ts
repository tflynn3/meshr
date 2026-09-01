import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Firestore, Timestamp } from "@google-cloud/firestore";
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
test(
  "Firestore API renewal recovery survives a fresh replica",
  {
    skip: !process.env.FIRESTORE_EMULATOR_HOST,
  },
  async () => {
    const projectId =
      process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
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
      if (options.body !== undefined)
        headers.set("Content-Type", "application/json");
      if (options.cookie) headers.set("Cookie", options.cookie);
      if (options.csrf) headers.set("X-Meshr-CSRF", options.csrf);
      if (options.authorization)
        headers.set("Authorization", options.authorization);
      if (options.webMcpAgent)
        headers.set("X-Meshr-WebMCP-Agent", options.webMcpAgent);
      // The API enforces same-origin CSRF protection for every state-changing
      // request. Keep this helper representative of a browser/native host
      // request so the cross-replica recovery gate exercises the real boundary.
      if ((options.method ?? "GET") !== "GET")
        headers.set("Origin", new URL(baseUrl).origin);
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      return { response, json: await response.json() };
    };
    const cleanup = async () => {
      for (const app of apps.reverse()) await app.close();
      const names = [
        "system",
        "meshes",
        "topics",
        "accounts",
        "provider_identities",
        "human_sessions",
        "pairings",
        "pairing_challenges",
        "agents",
        "agent_handles",
        "agent_bindings",
        "mesh_agent_memberships",
        "agent_authority",
        "runtime_sessions",
        "webmcp_grants",
        "webmcp_authority",
        "live_access_epochs",
        "mesh_human_roles",
        "mesh_join_requests",
        "event_outbox",
        "event_outbox_ready",
        "event_audit",
        "audit_events",
        "governance_events",
        "idempotency",
        "quota_counters",
        "posts",
        "follows",
        "mesh_invitations",
        "mesh_role_invitations",
        "moderation_cases",
        "topology_activity_totals",
        "topology_activity_buckets",
        "topology_activity_recent",
        "topology_activity_snapshots",
        "projection_bootstrap",
        "processed_events",
        "topology_shards",
        "topology_events",
        "mesh_access_epochs",
        "live_access_epochs",
      ];
      for (const name of names) {
        const collection = firestore.collection(`${prefix}_${name}`);
        const snapshot = await collection.get();
        if (!snapshot.empty) await firestore.recursiveDelete(collection);
      }
      await firestore.terminate();
      for (const directory of directories)
        rmSync(directory, { recursive: true, force: true });
    };

    try {
      await repository.ensureEmptyProduction();
      const keyPair = generateKeyPairSync("ed25519");
      const publicKey = keyPair.publicKey
        .export({ type: "spki", format: "pem" })
        .toString();
      const firstDirectory = mkdtempSync(
        join(tmpdir(), "meshr-firestore-recovery-"),
      );
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
      const humanTokenHash = createHash("sha256")
        .update(humanToken)
        .digest("hex");
      const csrf = `${prefix}:csrf`;
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(
        Date.parse(createdAt) + 7 * 24 * 60 * 60 * 1_000,
      ).toISOString();
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
            attention: {
              browse: "public",
              rootPosts: "draft",
              replies: "never",
            },
          },
        },
      });
      assert.equal(pairing.response.status, 201);
      const pairingId = pairing.json.pairingId as string;
      const pairingAuth = `Pairing ${pairing.json.pairingSecret as string}`;
      const approval = await requestJson(
        first.baseUrl,
        `/v1/pairings/${pairingId}/approve`,
        {
          method: "POST",
          cookie,
          csrf,
          body: { acknowledgeAutonomous: true },
        },
      );
      assert.equal(approval.response.status, 200);
      const claimChallenge = await requestJson(
        first.baseUrl,
        `/v1/pairings/${pairingId}/challenges`,
        {
          method: "POST",
          authorization: pairingAuth,
          body: {},
        },
      );
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
      const recoveryChallenge = await requestJson(
        first.baseUrl,
        `/v1/pairings/${pairingId}/challenges`,
        {
          method: "POST",
          authorization: pairingAuth,
          body: { sessionId: predecessorSessionId },
        },
      );
      assert.equal(recoveryChallenge.response.status, 201);
      const recoverySignature = sign(
        null,
        Buffer.from(recoveryChallenge.json.message as string, "utf8"),
        keyPair.privateKey,
      ).toString("base64url");
      const firstRenewal = await requestJson(
        first.baseUrl,
        "/v1/agent-sessions/renew",
        {
          method: "POST",
          authorization: pairingAuth,
          body: {
            pairingId,
            challengeId: recoveryChallenge.json.challengeId,
            sessionId: predecessorSessionId,
            signature: recoverySignature,
          },
        },
      );
      assert.equal(firstRenewal.response.status, 201);

      const secondDirectory = mkdtempSync(
        join(tmpdir(), "meshr-firestore-recovery-"),
      );
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
      const retryChallenge = await requestJson(
        second.baseUrl,
        `/v1/pairings/${pairingId}/challenges`,
        {
          method: "POST",
          authorization: pairingAuth,
          body: { sessionId: predecessorSessionId },
        },
      );
      assert.equal(retryChallenge.response.status, 201);
      const retrySignature = sign(
        null,
        Buffer.from(retryChallenge.json.message as string, "utf8"),
        keyPair.privateKey,
      ).toString("base64url");
      const recovered = await requestJson(
        second.baseUrl,
        "/v1/agent-sessions/renew",
        {
          method: "POST",
          authorization: pairingAuth,
          body: {
            pairingId,
            challengeId: retryChallenge.json.challengeId,
            sessionId: predecessorSessionId,
            signature: retrySignature,
          },
        },
      );
      assert.equal(recovered.response.status, 200);
      assert.equal(recovered.json.sessionId, firstRenewal.json.sessionId);
      assert.equal(recovered.json.token, firstRenewal.json.token);

      const localSuccessor = secondApp.database.sqlite
        .prepare(
          "SELECT status FROM agent_sessions WHERE session_id = ? AND agent_id = ?",
        )
        .get(firstRenewal.json.sessionId, agentId) as
        { status: string } | undefined;
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
      const webMcpCookie = (
        transfer.response.headers.get("set-cookie") ?? ""
      ).split(";", 1)[0];
      assert.match(webMcpCookie, /^meshr_webmcp=/);
      const recoveredPageState = await requestJson(
        second.baseUrl,
        "/v1/webmcp/session",
        {
          method: "POST",
          cookie,
          csrf,
          body: { agentId },
        },
      );
      assert.equal(recoveredPageState.response.status, 200);
      assert.equal(recoveredPageState.json.enabled, true);
      assert.equal(recoveredPageState.json.agent.id, agentId);
      const recoveredPageCookie = (
        recoveredPageState.response.headers.get("set-cookie") ?? ""
      ).split(";", 1)[0];
      assert.equal(recoveredPageCookie, webMcpCookie);
      const recoveredPageProfile = await requestJson(
        second.baseUrl,
        "/v1/webmcp/profile",
        {
          cookie: `${cookie}; ${webMcpCookie}`,
          webMcpAgent: agentId,
        },
      );
      assert.equal(recoveredPageProfile.response.status, 200);
      assert.equal(recoveredPageProfile.json.agent.id, agentId);
      const recoveredPageAuthority = secondApp.database.sqlite
        .prepare(
          "SELECT grant_id, agent_id, session_id FROM webmcp_authority WHERE human_session_hash = ?",
        )
        .get(humanTokenHash) as
        { grant_id: string; agent_id: string; session_id: string } | undefined;
      assert.equal(recoveredPageAuthority?.agent_id, agentId);
      assert.match(recoveredPageAuthority?.grant_id ?? "", /^[a-f0-9]{64}$/);
      assert.match(recoveredPageAuthority?.session_id ?? "", /^page_/);

      // Activation itself may also land on a replica with no local profile
      // projection. The durable grant is the retry/recovery source of truth, so
      // a fresh third replica must hydrate the owned agent before returning the
      // already-committed handoff rather than responding with a replica-local 404.
      const thirdDirectory = mkdtempSync(
        join(tmpdir(), "meshr-firestore-recovery-"),
      );
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
      let recoveryProjectionReads = 0;
      const loadProjection = repository.loadProjection.bind(repository);
      repository.loadProjection = async (input) => {
        recoveryProjectionReads += 1;
        return loadProjection(input);
      };
      const reactivated = await requestJson(
        third.baseUrl,
        "/v1/webmcp/session",
        {
          method: "POST",
          cookie,
          csrf,
          body: { agentId },
        },
      );
      assert.equal(reactivated.response.status, 200);
      assert.equal(reactivated.json.enabled, true);
      assert.equal(reactivated.json.agent.id, agentId);
      assert.equal(
        recoveryProjectionReads,
        0,
        "grant recovery must hydrate only the exact agent and authority rows",
      );
      repository.loadProjection = loadProjection;
      const reactivatedCookie = (
        reactivated.response.headers.get("set-cookie") ?? ""
      ).split(";", 1)[0];
      assert.match(reactivatedCookie, /^meshr_webmcp=/);
      const reactivatedProfile = await requestJson(
        third.baseUrl,
        "/v1/webmcp/profile",
        {
          cookie: `${cookie}; ${reactivatedCookie}`,
          webMcpAgent: agentId,
        },
      );
      assert.equal(reactivatedProfile.response.status, 200);
      assert.equal(reactivatedProfile.json.agent.id, agentId);
    } finally {
      await cleanup();
    }
  },
);

test(
  "Firestore social-session issuance cap survives replicas and restart",
  {
    skip: !process.env.FIRESTORE_EMULATOR_HOST,
  },
  async () => {
    const projectId =
      process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
    const firestore = new Firestore({ projectId, databaseId: "(default)" });
    const prefix = `social_session_limit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = "2026-08-31T18:00:00.000Z";
    const subject = `${prefix}:shared-provider-subject`;
    const directories: string[] = [];
    const liveApps = new Set<ReturnType<typeof createMeshrServer>>();
    const repository = () =>
      new FirestoreMeshrRepository({
        firestore,
        collectionPrefix: prefix,
        clock: { now: () => new Date(now) },
        invitationPepper: `${prefix}:invitation-pepper`,
      });
    const startReplica = async () => {
      const directory = mkdtempSync(
        join(tmpdir(), "meshr-firestore-social-limit-"),
      );
      directories.push(directory);
      const app = createMeshrServer({
        dbPath: join(directory, "meshr.db"),
        clock: { now: () => new Date(now) },
        repository: repository(),
        identityVerifier: async (provider) => ({
          provider,
          subject,
          email: `${prefix}@example.test`,
          displayName: "Distributed Social Limit",
          emailVerified: true,
        }),
      });
      liveApps.add(app);
      return { app, ...(await app.listen()) };
    };
    const stopReplica = async (app: ReturnType<typeof createMeshrServer>) => {
      if (!liveApps.delete(app)) return;
      await app.close();
    };
    const createSocialSession = async (baseUrl: string, replay: number) => {
      const response = await fetch(`${baseUrl}/v1/sessions/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: new URL(baseUrl).origin,
        },
        body: JSON.stringify({
          provider: "google",
          idToken: `replayed-provider-token-${replay}`,
        }),
      });
      return { response, json: await response.json() };
    };

    try {
      await repository().ensureEmptyProduction();
      const first = await startReplica();
      const second = await startReplica();
      // Three requests per process stay below every local identity bucket. The
      // shared Firestore transaction must serialize this race to five admitted
      // sessions rather than letting a non-atomic read/set admit all six.
      const raced = await Promise.all(
        Array.from({ length: 6 }, (_, replay) =>
          createSocialSession(
            replay % 2 === 0 ? first.baseUrl : second.baseUrl,
            replay,
          ),
        ),
      );
      assert.equal(
        raced.filter(({ response }) => response.status === 201).length,
        5,
      );
      const raceRejection = raced.find(
        ({ response }) => response.status === 429,
      );
      assert.equal(
        raceRejection?.json.error.code,
        "social_session_rate_limited",
      );

      await stopReplica(second.app);
      const restarted = await startReplica();
      const rejected = await createSocialSession(restarted.baseUrl, 6);
      assert.equal(rejected.response.status, 429);
      assert.equal(rejected.response.headers.get("retry-after"), "6");
      assert.equal(rejected.json.error.code, "social_session_rate_limited");

      const sessions = await firestore
        .collection(`${prefix}_human_sessions`)
        .get();
      assert.equal(sessions.size, 5);
      const accounts = await firestore.collection(`${prefix}_accounts`).get();
      assert.equal(accounts.size, 1);
      const accountId = String(accounts.docs[0]!.get("account_id"));
      const subjectHash = createHash("sha256")
        .update(`google:${subject}`)
        .digest("hex");
      const accountHash = createHash("sha256").update(accountId).digest("hex");
      const quotaSnapshot = await firestore
        .collection(`${prefix}_quota_counters`)
        .get();
      assert.deepEqual(
        quotaSnapshot.docs.map(({ id }) => id).sort(),
        [
          `social-session:subject:${subjectHash}`,
          `social-session:account:${accountHash}`,
        ].sort(),
      );
      const quotaDocuments = quotaSnapshot.docs;
      for (const quota of quotaDocuments) {
        assert.equal(quota.exists, true);
        assert.equal(quota.get("tokens"), 0);
        assert.equal(quota.get("expires_at_ttl") instanceof Timestamp, true);
        assert.equal(quota.id.includes(subject), false);
      }
      assert.equal(
        restarted.app.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM human_sessions")
          .get()?.count,
        0,
        "the restarted replica must remove its rejected local session row",
      );
      assert.equal(
        restarted.app.database.sqlite
          .prepare("SELECT COUNT(*) AS count FROM provider_identities")
          .get()?.count,
        1,
        "identity metadata may remain hydrated as a non-authoritative cache without session authority",
      );
    } finally {
      for (const app of Array.from(liveApps).reverse()) await stopReplica(app);
      for (const name of [
        "system",
        "meshes",
        "topics",
        "accounts",
        "provider_identities",
        "human_sessions",
        "quota_counters",
      ]) {
        const collection = firestore.collection(`${prefix}_${name}`);
        const snapshot = await collection.get();
        if (!snapshot.empty) await firestore.recursiveDelete(collection);
      }
      await firestore.terminate();
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);

test(
  "Firestore social-session issuance fails closed on corrupt durable buckets",
  {
    skip: !process.env.FIRESTORE_EMULATOR_HOST,
  },
  async () => {
    const projectId =
      process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
    const firestore = new Firestore({ projectId, databaseId: "(default)" });
    const prefix = `social_session_corrupt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const now = "2026-08-31T18:00:00.000Z";
    const corruptions = [
      { name: "missing tokens", document: { last_refill_ms: Date.parse(now) } },
      {
        name: "coercible string tokens",
        document: { tokens: "4", last_refill_ms: Date.parse(now) },
      },
      {
        name: "boolean refill cursor",
        document: { tokens: 4, last_refill_ms: true },
      },
      {
        name: "over-capacity tokens",
        document: { tokens: 6, last_refill_ms: Date.parse(now) },
      },
    ] as const;
    const directories: string[] = [];
    const liveApps = new Set<ReturnType<typeof createMeshrServer>>();

    try {
      for (const [index, corruption] of corruptions.entries()) {
        const subject = `${prefix}:${corruption.name}`;
        const subjectHash = createHash("sha256")
          .update(`google:${subject}`)
          .digest("hex");
        const quotaRef = firestore
          .collection(`${prefix}_quota_counters`)
          .doc(`social-session:subject:${subjectHash}`);
        await quotaRef.create(corruption.document);
        const directory = mkdtempSync(
          join(tmpdir(), "meshr-firestore-social-corrupt-"),
        );
        directories.push(directory);
        const app = createMeshrServer({
          dbPath: join(directory, "meshr.db"),
          clock: { now: () => new Date(now) },
          repository: new FirestoreMeshrRepository({
            firestore,
            collectionPrefix: prefix,
            clock: { now: () => new Date(now) },
            invitationPepper: `${prefix}:invitation-pepper`,
          }),
          identityVerifier: async (provider) => ({
            provider,
            subject,
            email: `${prefix}-${index}@example.test`,
            displayName: "Corrupt Durable Limit",
            emailVerified: true,
          }),
        });
        liveApps.add(app);
        const { baseUrl } = await app.listen();
        const response = await fetch(`${baseUrl}/v1/sessions/social`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: new URL(baseUrl).origin,
          },
          body: JSON.stringify({
            provider: "google",
            idToken: `corrupt-provider-token-${index}`,
          }),
        });
        const json = await response.json();
        assert.equal(response.status, 503, corruption.name);
        assert.equal(
          json.error.code,
          "session_store_unavailable",
          corruption.name,
        );
        assert.deepEqual(
          (await quotaRef.get()).data(),
          corruption.document,
          `${corruption.name} must not be repaired into a fresh bucket`,
        );
        assert.equal(
          app.database.sqlite
            .prepare("SELECT COUNT(*) AS count FROM human_sessions")
            .get()?.count,
          0,
          `${corruption.name} must not leave local session authority`,
        );
        await app.close();
        liveApps.delete(app);
      }
      assert.equal(
        (await firestore.collection(`${prefix}_human_sessions`).get()).size,
        0,
        "corrupt counters must not create durable sessions",
      );
    } finally {
      for (const app of Array.from(liveApps).reverse()) await app.close();
      for (const name of [
        "system",
        "meshes",
        "topics",
        "accounts",
        "provider_identities",
        "human_sessions",
        "quota_counters",
      ]) {
        const collection = firestore.collection(`${prefix}_${name}`);
        const snapshot = await collection.get();
        if (!snapshot.empty) await firestore.recursiveDelete(collection);
      }
      await firestore.terminate();
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);
