import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import { test } from "node:test";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";

/**
 * The production adapter is exercised against the official Firestore
 * emulator in CI.  Keep this test skippable for the fast local SQLite suite;
 * `npm run test:firestore` supplies FIRESTORE_EMULATOR_HOST explicitly.
 */
test("Firestore repository preserves the launch authority and outbox contract", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
  const firestore = new Firestore({ projectId, databaseId: "(default)" });
  const prefix = `conformance_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const collection = (name: string) => firestore.collection(`${prefix}_${name}`);
  const now = "2026-08-28T18:00:00.000Z";
  const clock = { now: () => new Date(now) };
  const repository = new FirestoreMeshrRepository({ firestore, collectionPrefix: prefix, clock });
  const expiresAt = "2026-08-28T18:15:00.000Z";
  const postExpiresAt = "2026-08-29T18:00:00.000Z";
  const accountSessionHash = createHash("sha256").update(`${prefix}:human`).digest("hex");
  const agentId = `${prefix}_agent`;
  const pairingId = `${prefix}_binding`;
  const runtimeSessionId = `${prefix}_runtime`;
  const postId = `${prefix}_post`;
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  try {
    // A clean repository is allowed to create exactly the system taxonomy and
    // empty global commons. This is the same bootstrap guard used by the API.
    await repository.ensureEmptyProduction();
    await repository.checkReady();

    const account = await repository.createSocialAccount({
      provider: "google",
      subject: `${prefix}:google-subject`,
      email: `${prefix}@example.test`,
      displayName: "Emulator Owner",
    });
    await repository.createHumanSession({
      tokenHash: accountSessionHash,
      accountId: account.accountId,
      csrfToken: `${prefix}:csrf`,
      createdAt: now,
      expiresAt: "2026-08-29T06:00:00.000Z",
      absoluteExpiresAt: "2026-09-04T18:00:00.000Z",
    });

    await repository.createPairing({
      pairingId,
      code: `${prefix.slice(-8)}ABCD`,
      secretHash: createHash("sha256").update(`${prefix}:secret`).digest("hex"),
      runtime: "openclaw",
      runtimeLabel: "Emulator OpenClaw",
      externalSubject: `${prefix}:openclaw`,
      publicKeyPem,
      requestedProfile: null,
      definitionDigest: null,
      status: "pending",
      ownerAccountId: null,
      agentId: null,
      createdAt: now,
      expiresAt: "2026-08-29T18:00:00.000Z",
      approvedAt: null,
      claimedAt: null,
    });
    const approval = await repository.approvePairing({
      pairingId,
      ownerAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      agentId,
      profile: {
        name: "Emulator Observer",
        handle: `${prefix.slice(0, 20)}-observer`,
        tagline: "A conformance participant",
        interests: ["testing"],
        personality: "Careful and concise.",
        attention: { browse: "public", rootPosts: "autonomous", replies: "autonomous" },
      },
      approvedAt: now,
    });
    assert.equal(approval.agentId, agentId);

    const started = await repository.startRuntimeSession({
      agentId,
      bindingId: pairingId,
      sessionId: runtimeSessionId,
      runtimeKind: "openclaw",
      tokenHash: createHash("sha256").update(`${prefix}:runtime-token`).digest("hex"),
      expiresAt,
    });
    assert.equal(started.authorityEpoch, 1);

    const ownedAgents = await repository.listAgentsForAccount(account.accountId);
    assert.deepEqual(ownedAgents.map((agent) => agent.agentId), [agentId]);
    const liveSessions = await repository.listRuntimeSessionsForAgents(
      [agentId],
      now,
      "2026-08-28T17:58:30.000Z",
    );
    assert.deepEqual(liveSessions.map((session) => session.sessionId), [runtimeSessionId]);
    const meshDirectory = await repository.listMeshDirectoryForAccount(account.accountId);
    assert.equal(meshDirectory.some((entry) => entry.mesh.meshId === "mesh-public"), true);
    const publicMeshes = await repository.listPublicMeshes();
    assert.deepEqual(publicMeshes.map((mesh) => mesh.meshId), ["mesh-public"]);

    const write = await repository.createPostWithOutbox({
      postId,
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      agentId,
      sessionId: runtimeSessionId,
      parentPostId: null,
      body: "Firestore authority is durable.",
      moderationState: "published",
      moderationReason: null,
      expiresAt: postExpiresAt,
      eventType: "post.created",
      idempotencyKey: `${prefix}:post-key`,
      requestHash: createHash("sha256").update(`${prefix}:post-request`).digest("hex"),
    });
    assert.equal(write.duplicate, false);
    assert.equal(write.post.post_id, postId);

    // The topology reader consumes the one-document mesh snapshot when it is
    // fresh, avoiding a 15-minute bucket fan-out on every browser refresh.
    await collection("topology_activity_snapshots").doc("mesh-public").set({
      contract_version: 1,
      mesh_id: "mesh-public",
      generated_at: now,
      source_updated_at: now,
      totals: {
        post_count: 1,
        root_count: 1,
        reply_count: 0,
        last_activity_at: now,
        topics: {
          "topic-small-discoveries": {
            post_count: 1,
            root_count: 1,
            reply_count: 0,
            last_activity_at: now,
            participants: { [agentId]: true },
          },
        },
        agents: { [agentId]: { post_count: 1, last_post_at: now } },
        links: {},
      },
      recent: {
        post_count: 1,
        root_count: 1,
        reply_count: 0,
        recent_post_count: 1,
        last_activity_at: now,
        topics: {
          "topic-small-discoveries": {
            post_count: 1,
            root_count: 1,
            reply_count: 0,
            last_activity_at: now,
            participants: { [agentId]: true },
          },
        },
        agents: { [agentId]: { post_count: 1, last_post_at: now } },
        links: {},
      },
    });

    const duplicate = await repository.createPostWithOutbox({
      postId,
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      agentId,
      sessionId: runtimeSessionId,
      parentPostId: null,
      body: "Firestore authority is durable.",
      moderationState: "published",
      moderationReason: null,
      expiresAt: postExpiresAt,
      eventType: "post.created",
      idempotencyKey: `${prefix}:post-key`,
      requestHash: createHash("sha256").update(`${prefix}:post-request`).digest("hex"),
    });
    assert.equal(duplicate.duplicate, true);

    const projection = await repository.loadProjection({ accountId: account.accountId });
    assert.equal(projection.meshes.some((mesh) => mesh.meshId === "mesh-public"), true);
    assert.equal(projection.posts.some((post) => post.postId === postId), true);
    assert.equal(projection.activity?.meshes.find((mesh) => mesh.meshId === "mesh-public")?.postCount, 1);
    assert.equal(projection.activity?.meshes.find((mesh) => mesh.meshId === "mesh-public")?.recentPostCount, 1);
    const outbox = await collection("event_outbox").doc(postId).get();
    const ready = await collection("event_outbox_ready").doc(postId).get();
    assert.equal(outbox.exists, true);
    assert.equal(outbox.get("status"), "pending");
    assert.equal(outbox.get("observation_scope"), "public");
    assert.equal(ready.exists, true);
    assert.equal(ready.get("ordering_key"), "mesh-public");
    const events = await repository.listAgentEvents({
      agentId,
      browse: "public",
      limit: 10,
    });
    assert.equal(events.events.length, 1);
    assert.equal(events.events[0]?.topicId, "topic-small-discoveries");

    const followEventId = `${prefix}_follow_event`;
    await repository.upsertFollow({
      topicId: "topic-small-discoveries",
      agentId,
      meshId: "mesh-public",
      following: true,
      updatedAt: now,
      sessionId: runtimeSessionId,
      authorityEpoch: 1,
      authorityKind: "native",
      eventId: followEventId,
      idempotencyKey: `${prefix}:follow`,
    });
    const followOutbox = await collection("event_outbox").doc(followEventId).get();
    assert.equal(followOutbox.get("observation_scope"), "public");
    const followEvents = await repository.listAgentEvents({
      agentId,
      browse: "public",
      limit: 10,
    });
    assert.equal(followEvents.events.some((event) => event.eventId === followEventId), true);

    // Public browse also includes private meshes this agent has explicitly
    // joined. The private stream must be selected by membership, while an
    // unrelated private mesh remains invisible.
    const privateVisibleMeshId = `${prefix}_private_visible`;
    const privateHiddenMeshId = `${prefix}_private_hidden`;
    const privateVisibleEventId = `${prefix}_private_visible_event`;
    const privateHiddenEventId = `${prefix}_private_hidden_event`;
    const staleEventId = `${prefix}_stale_event`;
    const privateBatch = firestore.batch();
    privateBatch.set(collection("meshes").doc(privateVisibleMeshId), {
      contract_version: 1,
      mesh_id: privateVisibleMeshId,
      owner_account_id: account.accountId,
      name: "Private joined mesh",
      description: "A private conformance mesh",
      visibility: "private",
      admission: "invite_only",
      lifecycle: "active",
      created_at: now,
      updated_at: now,
    });
    privateBatch.set(collection("meshes").doc(privateHiddenMeshId), {
      contract_version: 1,
      mesh_id: privateHiddenMeshId,
      owner_account_id: account.accountId,
      name: "Private hidden mesh",
      description: "An unrelated private mesh",
      visibility: "private",
      admission: "invite_only",
      lifecycle: "active",
      created_at: now,
      updated_at: now,
    });
    privateBatch.set(collection("mesh_agent_memberships").doc(`${privateVisibleMeshId}:${agentId}`), {
      contract_version: 1,
      mesh_id: privateVisibleMeshId,
      agent_id: agentId,
      status: "joined",
      attention_policy: { browse: "public" },
      admission_provenance: "invite",
      joined_at: now,
      updated_at: now,
    });
    for (const [eventId, meshId] of [
      [privateVisibleEventId, privateVisibleMeshId],
      [privateHiddenEventId, privateHiddenMeshId],
    ] as const) {
      const createdAt = new Date(Date.parse(now) + (eventId === privateVisibleEventId ? 500 : 600)).toISOString();
      privateBatch.set(collection("event_outbox").doc(eventId), {
        contract_version: 1,
        observation_scope: "private",
        event_id: eventId,
        mesh_id: meshId,
        status: "published",
        attempts: 1,
        created_at: createdAt,
        envelope: {
          event_id: eventId,
          schema_version: 1,
          mesh_id: meshId,
          agent_id: agentId,
          session_id: runtimeSessionId,
          runtime_kind: "openclaw",
          type: "post.created",
          occurred_at: createdAt,
          payload: { topic_id: "topic-small-discoveries" },
        },
      });
    }
    privateBatch.set(collection("event_outbox").doc(staleEventId), {
      contract_version: 1,
      observation_scope: "public",
      event_id: staleEventId,
      mesh_id: "mesh-public",
      status: "published",
      attempts: 1,
      created_at: "2026-08-28T17:30:00.000Z",
      envelope: {
        event_id: staleEventId,
        schema_version: 1,
        mesh_id: "mesh-public",
        agent_id: agentId,
        session_id: runtimeSessionId,
        runtime_kind: "openclaw",
        type: "post.created",
        occurred_at: "2026-08-28T17:30:00.000Z",
        payload: { topic_id: "topic-small-discoveries" },
      },
    });
    await privateBatch.commit();
    const publicBrowseWithPrivate = await repository.listAgentEvents({
      agentId,
      browse: "public",
      limit: 100,
    });
    assert.equal(publicBrowseWithPrivate.events.some((event) => event.eventId === privateVisibleEventId), true);
    assert.equal(publicBrowseWithPrivate.events.some((event) => event.eventId === privateHiddenEventId), false);

    // A page smaller than the candidate scan must resume from the last
    // returned visible event, not from the scan high-water mark. This proves
    // that bounded overscan cannot skip a large public stream.
    const bulkBatch = firestore.batch();
    const bulkIds: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const bulkId = `${prefix}_bulk_${String(index).padStart(3, "0")}`;
      bulkIds.push(bulkId);
      const createdAt = new Date(Date.parse(now) + (index + 1) * 1_000).toISOString();
      bulkBatch.set(collection("event_outbox").doc(bulkId), {
        contract_version: 1,
        observation_scope: "public",
        event_id: bulkId,
        mesh_id: "mesh-public",
        status: "published",
        attempts: 1,
        created_at: createdAt,
        envelope: {
          event_id: bulkId,
          schema_version: 1,
          mesh_id: "mesh-public",
          agent_id: agentId,
          session_id: runtimeSessionId,
          runtime_kind: "openclaw",
          type: "post.created",
          occurred_at: createdAt,
          payload: { topic_id: "topic-small-discoveries", index },
        },
      });
    }
    await bulkBatch.commit();
    const newestPage = await repository.listAgentEvents({
      agentId,
      browse: "public",
      limit: 100,
    });
    assert.equal(newestPage.events.length, 100);
    assert.equal(newestPage.events.some((event) => event.eventId === bulkIds[0]), false);
    assert.equal(newestPage.events.some((event) => event.eventId === bulkIds.at(-1)), true);
    assert.equal(newestPage.events.some((event) => event.eventId === staleEventId), false);
    const pagedIds: string[] = [];
    // Resume from the pre-bulk cursor so this loop exercises durable
    // ascending pagination rather than the cursorless newest-page contract.
    let after: string | undefined = followEvents.nextAfter ?? undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await repository.listAgentEvents({
        agentId,
        browse: "public",
        limit: 10,
        after,
      });
      pagedIds.push(...result.events
        .map((event) => event.eventId)
        .filter((eventId) => eventId.startsWith(`${prefix}_bulk_`)));
      if (result.events.length === 0 || !result.nextAfter) break;
      after = result.nextAfter;
    }
    assert.deepEqual([...new Set(pagedIds)].sort(), [...bulkIds].sort());
  } finally {
    // The random collection prefix isolates tests running against a shared
    // emulator. Delete only this test's collections so a failed test never
    // touches another worker's fixture data.
    const names = [
      "system", "meshes", "topics", "accounts", "provider_identities", "human_sessions",
      "pairings", "agents", "agent_handles", "agent_bindings", "mesh_agent_memberships",
      "agent_authority", "runtime_sessions", "posts", "idempotency", "quota_counters",
      "event_outbox", "event_outbox_ready", "moderation_cases", "live_access_epochs",
      "audit_events", "governance_events", "event_audit", "topology_activity_totals",
      "topology_activity_buckets", "topology_activity_recent", "topology_activity_snapshots",
      "processed_events", "topology_shards", "topology_events",
    ];
    for (const name of names) {
      const snapshot = await collection(name).get();
      if (!snapshot.empty) await firestore.recursiveDelete(collection(name));
    }
    await firestore.terminate();
  }
});
