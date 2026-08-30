import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import { test } from "node:test";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";
import { hmacSha256 } from "../server/security.ts";

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
  const invitationPepper = `${prefix}:role-invitation-pepper`;
  const repository = new FirestoreMeshrRepository({
    firestore,
    collectionPrefix: prefix,
    clock,
    invitationPepper,
  });
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

    const privateMeshId = `${prefix}_private_mesh`;
    const privateTopicId = `${prefix}_private_topic`;
    await repository.createMeshWithOwner({
      mesh: {
        meshId: privateMeshId,
        ownerAccountId: account.accountId,
        name: "Durable private mesh",
        description: "A private authority fixture",
        visibility: "private",
        admission: "invite_only",
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
        actingAccountId: account.accountId,
        humanSessionHash: accountSessionHash,
      },
      topic: {
        topicId: privateTopicId,
        meshId: privateMeshId,
        name: "private-notes",
        title: "Private notes",
        description: "A durable topic fixture",
        tags: ["conformance"],
        createdAt: now,
      },
      agentIds: [],
    });

    // Human governance is target-consent based. Creating an invitation must
    // not add a role or reveal whether an email belongs to an account; only
    // the signed-in target can redeem the one-use capability.
    const targetAccount = await repository.createSocialAccount({
      provider: "github",
      subject: `${prefix}:github-target`,
      email: `${prefix}.steward@example.test`,
      displayName: "Emulator Steward",
    });
    const targetSessionHash = createHash("sha256").update(`${prefix}:target-human`).digest("hex");
    await repository.createHumanSession({
      tokenHash: targetSessionHash,
      accountId: targetAccount.accountId,
      csrfToken: `${prefix}:target-csrf`,
      createdAt: now,
      expiresAt: "2026-08-29T06:00:00.000Z",
      absoluteExpiresAt: "2026-09-04T18:00:00.000Z",
    });
    const roleInvitationId = `${prefix}_role_invitation`;
    const roleTokenHash = createHash("sha256").update(`${prefix}:role-token`).digest("hex");
    const roleMutationArtifacts = {
      event: {
        eventId: `${prefix}_role_invitation_created`,
        type: "mesh.role.invitation.created",
        meshId: privateMeshId,
        topicId: null,
        agentId: null,
        sessionId: accountSessionHash,
        runtimeKind: null,
        payload: { invitationId: roleInvitationId, meshId: privateMeshId, role: "steward" },
        occurredAt: now,
      },
      audit: {
        auditId: `${prefix}_role_invitation_created_audit`,
        actorType: "human",
        actorId: account.accountId,
        sessionId: accountSessionHash,
        action: "mesh.role.invitation.created",
        resourceType: "mesh_role_invitation",
        resourceId: roleInvitationId,
        data: { invitationId: roleInvitationId, meshId: privateMeshId, role: "steward" },
        createdAt: now,
      },
    } as const;
    const createdRoleInvitation = await repository.createMeshRoleInvitation({
      invitationId: roleInvitationId,
      meshId: privateMeshId,
      tokenHash: roleTokenHash,
      targetEmailHash: hmacSha256(`${prefix}.steward@example.test`, invitationPepper),
      role: "steward",
      createdByAccountId: account.accountId,
      createdAt: now,
      expiresAt: "2026-08-29T18:00:00.000Z",
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      ...roleMutationArtifacts,
    });
    assert.equal(createdRoleInvitation.status, "active");
    assert.equal((await repository.listMeshRoleInvitations(privateMeshId))[0]?.invitationId, roleInvitationId);
    await assert.rejects(
      repository.acceptMeshRoleInvitation({
        invitationId: roleInvitationId,
        tokenHash: roleTokenHash,
        accountId: account.accountId,
        humanSessionHash: accountSessionHash,
        acceptedAt: now,
        idempotencyKey: `${prefix}:wrong-role-accept`,
        requestHash: `${prefix}:wrong-role-accept-hash`,
        event: {
          eventId: `${prefix}_wrong_role_accept`,
          type: "mesh.role.invitation.accepted",
          meshId: privateMeshId,
          topicId: null,
          agentId: null,
          sessionId: accountSessionHash,
          runtimeKind: null,
          payload: { invitationId: roleInvitationId },
          occurredAt: now,
        },
        audit: {
          auditId: `${prefix}_wrong_role_accept_audit`,
          actorType: "human",
          actorId: account.accountId,
          sessionId: accountSessionHash,
          action: "mesh.role.invitation.accepted",
          resourceType: "mesh_role_invitation",
          resourceId: roleInvitationId,
          data: { invitationId: roleInvitationId },
          createdAt: now,
        },
      }),
      /role_invitation_target_mismatch/,
    );
    const acceptedRoleInvitation = await repository.acceptMeshRoleInvitation({
      invitationId: roleInvitationId,
      tokenHash: roleTokenHash,
      accountId: targetAccount.accountId,
      humanSessionHash: targetSessionHash,
      acceptedAt: now,
      idempotencyKey: `${prefix}:role-accept`,
      requestHash: `${prefix}:role-accept-hash`,
      event: {
        eventId: `${prefix}_role_invitation_accepted`,
        type: "mesh.role.invitation.accepted",
        meshId: privateMeshId,
        topicId: null,
        agentId: null,
        sessionId: targetSessionHash,
        runtimeKind: null,
        payload: { invitationId: roleInvitationId, meshId: privateMeshId, role: "steward" },
        occurredAt: now,
      },
      audit: {
        auditId: `${prefix}_role_invitation_accepted_audit`,
        actorType: "human",
        actorId: targetAccount.accountId,
        sessionId: targetSessionHash,
        action: "mesh.role.invitation.accepted",
        resourceType: "mesh_role_invitation",
        resourceId: roleInvitationId,
        data: { invitationId: roleInvitationId, meshId: privateMeshId, role: "steward" },
        createdAt: now,
      },
    });
    assert.equal(acceptedRoleInvitation.role, "steward");
    assert.equal(acceptedRoleInvitation.duplicate, false);
    const acceptedRoleInvitationRetry = await repository.acceptMeshRoleInvitation({
      invitationId: roleInvitationId,
      tokenHash: roleTokenHash,
      accountId: targetAccount.accountId,
      humanSessionHash: targetSessionHash,
      acceptedAt: now,
      idempotencyKey: `${prefix}:role-accept`,
      requestHash: `${prefix}:role-accept-hash`,
      event: {
        eventId: `${prefix}_role_invitation_accepted_retry`,
        type: "mesh.role.invitation.accepted",
        meshId: privateMeshId,
        topicId: null,
        agentId: null,
        sessionId: targetSessionHash,
        runtimeKind: null,
        payload: { invitationId: roleInvitationId },
        occurredAt: now,
      },
      audit: {
        auditId: `${prefix}_role_invitation_accepted_retry_audit`,
        actorType: "human",
        actorId: targetAccount.accountId,
        sessionId: targetSessionHash,
        action: "mesh.role.invitation.accepted",
        resourceType: "mesh_role_invitation",
        resourceId: roleInvitationId,
        data: { invitationId: roleInvitationId },
        createdAt: now,
      },
    });
    assert.equal(acceptedRoleInvitationRetry.duplicate, true);
    const targetDirectory = await repository.listMeshDirectoryForAccount(targetAccount.accountId);
    assert.equal(targetDirectory.find((entry) => entry.mesh.meshId === privateMeshId)?.role, "steward");

    const roleArtifacts = (
      invitationId: string,
      actorAccountId: string,
      actorSessionHash: string,
      role: "owner" | "steward" | "observer",
      accepted = false,
    ) => ({
      event: {
        eventId: `${invitationId}_${accepted ? "accepted" : "created"}`,
        type: accepted ? "mesh.role.invitation.accepted" : "mesh.role.invitation.created",
        meshId: privateMeshId,
        topicId: null,
        agentId: null,
        sessionId: actorSessionHash,
        runtimeKind: null,
        payload: { invitationId, meshId: privateMeshId, role },
        occurredAt: now,
      },
      audit: {
        auditId: `${invitationId}_${accepted ? "accepted" : "created"}_audit`,
        actorType: "human" as const,
        actorId: actorAccountId,
        sessionId: actorSessionHash,
        action: accepted ? "mesh.role.invitation.accepted" : "mesh.role.invitation.created",
        resourceType: "mesh_role_invitation",
        resourceId: invitationId,
        data: { invitationId, meshId: privateMeshId, role },
        createdAt: now,
      },
    });
    const createHumanFixture = async (suffix: string, displayName: string) => {
      const fixture = await repository.createSocialAccount({
        provider: "github",
        subject: `${prefix}:github-${suffix}`,
        email: `${prefix}.${suffix}@example.test`,
        displayName,
      });
      const sessionHash = createHash("sha256").update(`${prefix}:${suffix}-human`).digest("hex");
      await repository.createHumanSession({
        tokenHash: sessionHash,
        accountId: fixture.accountId,
        csrfToken: `${prefix}:${suffix}-csrf`,
        createdAt: now,
        expiresAt: "2026-08-29T06:00:00.000Z",
        absoluteExpiresAt: "2026-09-04T18:00:00.000Z",
      });
      return { account: fixture, sessionHash };
    };
    const transferTarget = await createHumanFixture("transfer-target", "Emulator Transfer Target");
    const quotaTarget = await createHumanFixture("quota-target", "Emulator Quota Target");
    const transferInvitationId = `${prefix}_owner_transfer_invitation`;
    const staleInvitationId = `${prefix}_stale_invitation`;
    const quotaInvitationId = `${prefix}_quota_owner_invitation`;
    const createRoleInvitation = (
      invitationId: string,
      targetEmail: string,
      role: "owner" | "steward" | "observer",
    ) => repository.createMeshRoleInvitation({
      invitationId,
      meshId: privateMeshId,
      tokenHash: createHash("sha256").update(`${prefix}:${invitationId}:token`).digest("hex"),
      targetEmailHash: hmacSha256(targetEmail, invitationPepper),
      role,
      createdByAccountId: account.accountId,
      createdAt: now,
      expiresAt: "2026-08-29T18:00:00.000Z",
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      ...roleArtifacts(invitationId, account.accountId, accountSessionHash, role),
    });
    const transferInvitation = await createRoleInvitation(
      transferInvitationId,
      transferTarget.account.email,
      "owner",
    );
    const staleInvitation = await createRoleInvitation(
      staleInvitationId,
      quotaTarget.account.email,
      "observer",
    );
    const quotaInvitation = await createRoleInvitation(
      quotaInvitationId,
      quotaTarget.account.email,
      "owner",
    );
    assert.equal(
      (await repository.findMeshRoleInvitation({
        invitationId: transferInvitationId,
        targetEmailHash: hmacSha256(transferTarget.account.email, invitationPepper),
      }))?.role,
      "owner",
    );

    // The ten-owned-mesh cap is evaluated in the same acceptance transaction
    // as the role write. A target at the cap cannot receive ownership, and
    // the original owner remains authoritative after the rejected attempt.
    for (let index = 0; index < 10; index += 1) {
      const quotaMeshId = `${prefix}_quota_mesh_${index}`;
      await repository.createMeshWithOwner({
        mesh: {
          meshId: quotaMeshId,
          ownerAccountId: quotaTarget.account.accountId,
          name: `Quota mesh ${index}`,
          description: "Ownership quota fixture",
          visibility: "private",
          admission: "invite_only",
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
          actingAccountId: quotaTarget.account.accountId,
          humanSessionHash: quotaTarget.sessionHash,
        },
        topic: {
          topicId: `${prefix}_quota_topic_${index}`,
          meshId: quotaMeshId,
          name: "general",
          title: "General",
          description: "Quota fixture topic",
          tags: [],
          createdAt: now,
        },
        agentIds: [],
      });
    }
    await assert.rejects(
      repository.acceptMeshRoleInvitation({
        invitationId: quotaInvitationId,
        tokenHash: createHash("sha256").update(`${prefix}:${quotaInvitationId}:token`).digest("hex"),
        accountId: quotaTarget.account.accountId,
        humanSessionHash: quotaTarget.sessionHash,
        acceptedAt: now,
        idempotencyKey: `${prefix}:quota-owner-accept`,
        ...roleArtifacts(quotaInvitationId, quotaTarget.account.accountId, quotaTarget.sessionHash, "owner", true),
      }),
      /mesh_limit_reached/,
    );
    assert.equal((await repository.findMeshById(privateMeshId))?.ownerAccountId, account.accountId);

    const acceptedTransfer = await repository.acceptMeshRoleInvitation({
      invitationId: transferInvitationId,
      tokenHash: createHash("sha256").update(`${prefix}:${transferInvitationId}:token`).digest("hex"),
      accountId: transferTarget.account.accountId,
      humanSessionHash: transferTarget.sessionHash,
      acceptedAt: now,
      idempotencyKey: `${prefix}:owner-transfer-accept`,
      ...roleArtifacts(transferInvitationId, transferTarget.account.accountId, transferTarget.sessionHash, "owner", true),
    });
    assert.equal(acceptedTransfer.role, "owner");
    assert.equal((await repository.findMeshById(privateMeshId))?.ownerAccountId, transferTarget.account.accountId);
    assert.equal(await repository.findMeshHumanRole(privateMeshId, transferTarget.account.accountId), "owner");
    assert.equal(await repository.findMeshHumanRole(privateMeshId, account.accountId), "steward");

    // A role invitation created by the former owner cannot be redeemed after
    // the atomic transfer, even if its token and recipient are otherwise
    // valid. This is the stale-inviter fence for concurrent acceptance.
    await assert.rejects(
      repository.acceptMeshRoleInvitation({
        invitationId: staleInvitationId,
        tokenHash: createHash("sha256").update(`${prefix}:${staleInvitationId}:token`).digest("hex"),
        accountId: quotaTarget.account.accountId,
        humanSessionHash: quotaTarget.sessionHash,
        acceptedAt: now,
        idempotencyKey: `${prefix}:stale-inviter-accept`,
        ...roleArtifacts(staleInvitationId, quotaTarget.account.accountId, quotaTarget.sessionHash, "observer", true),
      }),
      /role_invitation_inviter_not_owner/,
    );

    const managedTopicId = `${prefix}_managed_topic`;
    await repository.createTopic({
      topicId: managedTopicId,
      meshId: privateMeshId,
      name: "garden-links",
      title: "Garden links",
      description: "Connections collected by the agents.",
      tags: ["links"],
      createdAt: now,
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      event: {
        eventId: `${prefix}_topic_created`,
        type: "mesh.topic.created",
        meshId: privateMeshId,
        topicId: managedTopicId,
        agentId: null,
        sessionId: accountSessionHash,
        runtimeKind: null,
        payload: { topicId: managedTopicId },
        occurredAt: now,
      },
      audit: {
        auditId: `${prefix}_topic_created_audit`,
        actorType: "human",
        actorId: account.accountId,
        sessionId: accountSessionHash,
        action: "mesh.topic.created",
        resourceType: "topic",
        resourceId: managedTopicId,
        data: {},
        createdAt: now,
      },
    });
    await repository.updateTopic({
      topicId: managedTopicId,
      meshId: privateMeshId,
      name: "garden-links",
      title: "Connected garden links",
      description: "Updated durable topic.",
      tags: ["connections"],
      updatedAt: "2026-08-28T18:01:00.000Z",
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
    });
    assert.equal((await repository.findTopicById(managedTopicId))?.title, "Connected garden links");
    await repository.deleteTopic({
      topicId: managedTopicId,
      meshId: privateMeshId,
      deletedAt: "2026-08-28T18:02:00.000Z",
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
    });
    assert.equal(await repository.findTopicById(managedTopicId), null);
    await assert.rejects(
      repository.deleteTopic({
        topicId: privateTopicId,
        meshId: privateMeshId,
        deletedAt: "2026-08-28T18:03:00.000Z",
        actingAccountId: account.accountId,
        humanSessionHash: accountSessionHash,
      }),
      /last_topic/,
    );

    // Moderation queues are consumed newest-first with an explicit cursor and
    // optional state filter. Keep this at the repository boundary so a busy
    // mesh cannot hide cases behind a fixed unordered limit.
    const moderationCases = [
      { caseId: `${prefix}_case_old`, postId: `${prefix}_case_post_old`, state: "resolved" as const, updatedAt: "2026-08-28T18:03:00.000Z" },
      { caseId: `${prefix}_case_new`, postId: `${prefix}_case_post_new`, state: "queued" as const, updatedAt: "2026-08-28T18:05:00.000Z" },
      { caseId: `${prefix}_case_mid`, postId: `${prefix}_case_post_mid`, state: "queued" as const, updatedAt: "2026-08-28T18:04:00.000Z" },
    ];
    for (const moderationCase of moderationCases) {
      await repository.upsertModerationCase({
        ...moderationCase,
        meshId: privateMeshId,
        reason: "conformance review",
        severity: "medium",
        createdAt: moderationCase.updatedAt,
        resolvedAt: moderationCase.state === "resolved" ? moderationCase.updatedAt : null,
        resolution: moderationCase.state === "resolved" ? "allow" : null,
        actingAccountId: account.accountId,
        humanSessionHash: accountSessionHash,
      });
    }
    const moderationPage = await repository.listModerationCasesPage({ meshId: privateMeshId, limit: 2 });
    assert.deepEqual(moderationPage.cases.map((item) => item.caseId), [
      `${prefix}_case_new`,
      `${prefix}_case_mid`,
    ]);
    assert.deepEqual(moderationPage.nextAfter, {
      updatedAt: "2026-08-28T18:04:00.000Z",
      caseId: `${prefix}_case_mid`,
    });
    const moderationTail = await repository.listModerationCasesPage({
      meshId: privateMeshId,
      state: "queued",
      after: moderationPage.nextAfter ?? undefined,
      limit: 2,
    });
    assert.deepEqual(moderationTail.cases.map((item) => item.caseId), []);
    const queuedModeration = await repository.listModerationCasesPage({
      meshId: privateMeshId,
      state: "queued",
      limit: 10,
    });
    assert.deepEqual(queuedModeration.cases.map((item) => item.caseId), [
      `${prefix}_case_new`,
      `${prefix}_case_mid`,
    ]);
    const invitationId = `${prefix}_invitation`;
    const invitationTokenHash = createHash("sha256").update(`${prefix}:invitation`).digest("hex");
    const invitation = await repository.createMeshInvitation({
      invitationId,
      meshId: privateMeshId,
      tokenHash: invitationTokenHash,
      invitedAgentId: agentId,
      createdByAccountId: account.accountId,
      createdAt: now,
      expiresAt: "2026-08-29T18:00:00.000Z",
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
    });
    assert.equal(invitation.status, "active");
    assert.equal((await repository.listMeshInvitations(privateMeshId))[0]?.invitationId, invitationId);
    const joinedPrivate = await repository.joinMeshForAgent({
      meshId: privateMeshId,
      agentId,
      ownerAccountId: account.accountId,
      sessionId: runtimeSessionId,
      authorityEpoch: 1,
      runtimeKind: "openclaw",
      idempotencyKey: `${prefix}:private-join`,
      requestId: `${prefix}:private-join-request`,
      requestedAt: now,
      attentionPolicy: { browse: "public" },
      invitationTokenHash,
    });
    assert.deepEqual(joinedPrivate, { status: "joined", duplicate: false });
    const joinedPrivateRetry = await repository.joinMeshForAgent({
      meshId: privateMeshId,
      agentId,
      ownerAccountId: account.accountId,
      sessionId: runtimeSessionId,
      authorityEpoch: 1,
      runtimeKind: "openclaw",
      idempotencyKey: `${prefix}:private-join`,
      requestId: `${prefix}:private-join-request`,
      requestedAt: now,
      attentionPolicy: { browse: "public" },
      invitationTokenHash,
    });
    assert.deepEqual(joinedPrivateRetry, { status: "joined", duplicate: true });
    assert.equal((await repository.listMeshInvitations(privateMeshId))[0]?.status, "redeemed");

    // Keyed moderation writes exercise the same replay and race semantics as
    // the HTTP governance path. Two reports for one post are retained for
    // auditability; finalizing one atomically supersedes the other so a stale
    // review retry cannot overwrite the post.
    const moderationPostId = `${prefix}_moderation_post`;
    await repository.createPostWithOutbox({
      postId: moderationPostId,
      meshId: privateMeshId,
      topicId: privateTopicId,
      agentId,
      sessionId: runtimeSessionId,
      parentPostId: null,
      body: "A moderation race fixture.",
      moderationState: "published",
      moderationReason: null,
      expiresAt: postExpiresAt,
      eventType: "post.created",
      idempotencyKey: `${prefix}:moderation-post-key`,
      requestHash: createHash("sha256").update(`${prefix}:moderation-post-request`).digest("hex"),
    });
    const moderationArtifacts = (
      caseId: string,
      accountId: string,
      sessionHash: string,
      suffix: string,
      type: string,
      data: Record<string, unknown>,
    ) => ({
      event: {
        eventId: `${prefix}_${suffix}_event`,
        type,
        meshId: privateMeshId,
        topicId: privateTopicId,
        agentId,
        sessionId: sessionHash,
        runtimeKind: null,
        payload: { caseId, postId: moderationPostId, ...data },
        occurredAt: now,
      },
      audit: {
        auditId: `${prefix}_${suffix}_audit`,
        actorType: "human" as const,
        actorId: accountId,
        sessionId: sessionHash,
        action: type,
        resourceType: "moderation_case",
        resourceId: caseId,
        data: { caseId, postId: moderationPostId, ...data },
        createdAt: now,
      },
    });
    const moderationCaseA = `${prefix}_moderation_case_a`;
    const moderationCaseB = `${prefix}_moderation_case_b`;
    const reportAHash = createHash("sha256").update(`${prefix}:report-a`).digest("hex");
    const reportBHash = createHash("sha256").update(`${prefix}:report-b`).digest("hex");
    const reportA = await repository.upsertModerationCase({
      caseId: moderationCaseA,
      postId: moderationPostId,
      meshId: privateMeshId,
      reason: "Owner review",
      state: "queued",
      severity: "medium",
      resolution: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      idempotencyKey: `${prefix}:report-a-key`,
      requestHash: reportAHash,
      idempotencyOperation: "moderation.report",
      ...moderationArtifacts(moderationCaseA, account.accountId, accountSessionHash, "report-a", "moderation.reported", { reason: "Owner review" }),
    });
    assert.equal(reportA.duplicate, false);
    const reportARetry = await repository.upsertModerationCase({
      caseId: moderationCaseA,
      postId: moderationPostId,
      meshId: privateMeshId,
      reason: "Owner review",
      state: "queued",
      severity: "medium",
      resolution: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      idempotencyKey: `${prefix}:report-a-key`,
      requestHash: reportAHash,
      idempotencyOperation: "moderation.report",
      ...moderationArtifacts(moderationCaseA, account.accountId, accountSessionHash, "report-a-retry", "moderation.reported", { reason: "Owner review" }),
    });
    assert.equal(reportARetry.duplicate, true);
    assert.equal(reportARetry.moderationCase?.state, "queued");
    const reportB = await repository.upsertModerationCase({
      caseId: moderationCaseB,
      postId: moderationPostId,
      meshId: privateMeshId,
      reason: "Steward review",
      state: "queued",
      severity: "medium",
      resolution: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
      actingAccountId: transferTarget.account.accountId,
      humanSessionHash: transferTarget.sessionHash,
      idempotencyKey: `${prefix}:report-b-key`,
      requestHash: reportBHash,
      idempotencyOperation: "moderation.report",
      ...moderationArtifacts(moderationCaseB, transferTarget.account.accountId, transferTarget.sessionHash, "report-b", "moderation.reported", { reason: "Steward review" }),
    });
    assert.equal(reportB.duplicate, false);
    const reviewBHash = createHash("sha256").update(`${prefix}:review-b`).digest("hex");
    const reviewB = await repository.upsertModerationCase({
      caseId: moderationCaseB,
      postId: moderationPostId,
      meshId: privateMeshId,
      reason: "Steward review",
      state: "reviewing",
      severity: "medium",
      resolution: null,
      createdAt: now,
      updatedAt: "2026-08-28T18:06:00.000Z",
      resolvedAt: null,
      actingAccountId: transferTarget.account.accountId,
      humanSessionHash: transferTarget.sessionHash,
      idempotencyKey: `${prefix}:review-b-key`,
      requestHash: reviewBHash,
      idempotencyOperation: "moderation.action",
      ...moderationArtifacts(moderationCaseB, transferTarget.account.accountId, transferTarget.sessionHash, "review-b", "moderation.start_review", { action: "start_review" }),
    });
    assert.equal(reviewB.moderationCase?.state, "reviewing");
    const resolveA = await repository.updatePostModeration({
      caseId: moderationCaseA,
      postId: moderationPostId,
      state: "quarantined",
      reason: "Owner decision",
      caseState: "resolved",
      resolution: "quarantine",
      updatedAt: "2026-08-28T18:07:00.000Z",
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      idempotencyKey: `${prefix}:resolve-a-key`,
      requestHash: createHash("sha256").update(`${prefix}:resolve-a`).digest("hex"),
      ...moderationArtifacts(moderationCaseA, account.accountId, accountSessionHash, "resolve-a", "moderation.quarantine", { action: "quarantine" }),
    });
    assert.equal(resolveA.moderationCase?.state, "resolved");
    assert.equal(resolveA.post?.moderationState, "quarantined");
    assert.equal((await repository.findModerationCase(moderationCaseB))?.resolution, "superseded");
    await assert.rejects(
      repository.upsertModerationCase({
        caseId: moderationCaseB,
        postId: moderationPostId,
        meshId: privateMeshId,
        reason: "Steward review",
        state: "reviewing",
        severity: "medium",
        resolution: null,
        createdAt: now,
        updatedAt: "2026-08-28T18:06:00.000Z",
        resolvedAt: null,
        actingAccountId: transferTarget.account.accountId,
        humanSessionHash: transferTarget.sessionHash,
        idempotencyKey: `${prefix}:review-b-key`,
        requestHash: reviewBHash,
        idempotencyOperation: "moderation.action",
        ...moderationArtifacts(moderationCaseB, transferTarget.account.accountId, transferTarget.sessionHash, "review-b-retry", "moderation.start_review", { action: "start_review" }),
      }),
      /idempotency_replay_superseded/,
    );

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
      limit: 50,
    });
    assert.equal(events.events.some((event) => event.type === "post.created" && event.topicId === "topic-small-discoveries"), true);

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
      limit: 50,
    });
    assert.equal(followEvents.events.some((event) => event.eventId === followEventId), true);

    // Follows are derived state and can legitimately outlive a deleted topic
    // until the retention worker sweeps them. Projection hydration must omit
    // that orphan instead of attempting to insert it into the local topic FK.
    const orphanTopicId = `${prefix}_orphan_topic`;
    await repository.createTopic({
      topicId: orphanTopicId,
      meshId: privateMeshId,
      name: "orphan-check",
      title: "Orphan check",
      description: "Temporary topic for derived-state cleanup.",
      tags: [],
      createdAt: now,
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      event: {
        eventId: `${prefix}_orphan_topic_created`,
        type: "mesh.topic.created",
        meshId: privateMeshId,
        topicId: orphanTopicId,
        agentId: null,
        sessionId: accountSessionHash,
        runtimeKind: null,
        payload: { topicId: orphanTopicId },
        occurredAt: now,
      },
      audit: {
        auditId: `${prefix}_orphan_topic_created_audit`,
        actorType: "human",
        actorId: account.accountId,
        sessionId: accountSessionHash,
        action: "mesh.topic.created",
        resourceType: "topic",
        resourceId: orphanTopicId,
        data: {},
        createdAt: now,
      },
    });
    await repository.upsertFollow({
      topicId: orphanTopicId,
      agentId,
      meshId: privateMeshId,
      following: true,
      updatedAt: now,
      sessionId: runtimeSessionId,
      authorityEpoch: 1,
      authorityKind: "native",
      idempotencyKey: `${prefix}:orphan-follow`,
    });
    await repository.deleteTopic({
      topicId: orphanTopicId,
      meshId: privateMeshId,
      deletedAt: "2026-08-28T18:02:30.000Z",
      actingAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
    });
    assert.equal((await collection("follows").doc(`${orphanTopicId}:${agentId}`).get()).exists, true);
    const projectionAfterTopicDelete = await repository.loadProjection({ accountId: account.accountId });
    assert.equal(
      projectionAfterTopicDelete.follows.some((follow) => follow.topicId === orphanTopicId),
      false,
    );

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

    // Page WebMCP authority is a bounded handoff from the native host. A
    // stale native session cannot keep heartbeating or post after transfer;
    // explicit revocation permits a fresh native session, and a later native
    // start supersedes the previous one atomically.
    const pageGrantId = `${prefix}_page_grant`;
    const pageTransfer = await repository.transferPageAuthority({
      agentId,
      grantId: pageGrantId,
      humanSessionHash: accountSessionHash,
      expiresAt: "2026-08-28T19:00:00.000Z",
      sessionId: `${prefix}_page_session`,
    });
    assert.equal(pageTransfer.authorityEpoch, 1);
    assert.equal(pageTransfer.sessionId, `${prefix}_page_session`);
    const pageGrant = await collection("webmcp_grants").doc(pageGrantId).get();
    assert.equal(pageGrant.exists, true);
    assert.equal(pageGrant.get("authority_epoch"), 1);
    await assert.rejects(
      () => repository.heartbeatRuntimeSession(runtimeSessionId, now),
      /session_invalid/,
    );
    await repository.revokeWebMcpGrants(accountSessionHash, now);
    const nativeRecovery = await repository.startRuntimeSession({
      agentId,
      bindingId: pairingId,
      sessionId: `${prefix}_native_recovery`,
      runtimeKind: "openclaw",
      tokenHash: createHash("sha256").update(`${prefix}:recovery-token`).digest("hex"),
      expiresAt: "2026-08-28T18:15:00.000Z",
      claimPairing: false,
    });
    assert.equal(nativeRecovery.authorityEpoch, 2);
    const superseding = await repository.startRuntimeSession({
      agentId,
      bindingId: pairingId,
      sessionId: `${prefix}_native_superseding`,
      runtimeKind: "openclaw",
      tokenHash: createHash("sha256").update(`${prefix}:superseding-token`).digest("hex"),
      expiresAt: "2026-08-28T18:15:00.000Z",
      claimPairing: false,
    });
    assert.equal(superseding.authorityEpoch, 3);
    await assert.rejects(
      () => repository.heartbeatRuntimeSession(`${prefix}_native_recovery`, now),
      /session_invalid/,
    );
    await repository.heartbeatRuntimeSession(`${prefix}_native_superseding`, now);

    // An expired predecessor may recover exactly once while the authority
    // fence still points at its epoch. A second CAS using that epoch is
    // rejected after the successor commits, proving the Firestore fence is
    // authoritative rather than relying on a replica-local session row.
    const recoveryNow = "2026-08-28T18:20:00.000Z";
    const recoveryRepository = new FirestoreMeshrRepository({
      firestore,
      collectionPrefix: prefix,
      clock: { now: () => new Date(recoveryNow) },
      invitationPepper,
    });
    const recoveryChallengeId = `${prefix}_expired_recovery_challenge`;
    await recoveryRepository.createPairingChallenge({
      challengeId: recoveryChallengeId,
      pairingId,
      message: `${prefix}:expired-recovery`,
      createdAt: recoveryNow,
      expiresAt: "2026-08-28T18:21:00.000Z",
      usedAt: null,
    });
    const recoverySuccessorId = `${prefix}_expired_recovery_successor`;
    const recovery = await recoveryRepository.startRuntimeSession({
      agentId,
      bindingId: pairingId,
      sessionId: recoverySuccessorId,
      runtimeKind: "openclaw",
      tokenHash: createHash("sha256").update(`${prefix}:expired-recovery-token`).digest("hex"),
      expiresAt: "2026-08-28T18:35:00.000Z",
      challengeId: recoveryChallengeId,
      challengeUsedAt: recoveryNow,
      expectedSessionId: `${prefix}_native_superseding`,
      expectedAuthorityEpoch: 3,
      allowExpiredPredecessorRecovery: true,
      event: {
        eventId: `${prefix}_expired_recovery_event`,
        type: "agent.session.renewed",
        meshId: null,
        topicId: null,
        agentId,
        sessionId: recoverySuccessorId,
        runtimeKind: "openclaw",
        payload: { previousSessionId: `${prefix}_native_superseding`, sessionId: recoverySuccessorId },
        occurredAt: recoveryNow,
      },
      audit: {
        auditId: `${prefix}_expired_recovery_audit`,
        actorType: "agent",
        actorId: agentId,
        sessionId: recoverySuccessorId,
        action: "agent.session.renewed",
        resourceType: "agent",
        resourceId: agentId,
        data: { previousSessionId: `${prefix}_native_superseding` },
        createdAt: recoveryNow,
      },
    });
    assert.equal(recovery.authorityEpoch, 4);
    assert.equal((await recoveryRepository.findRuntimeSessionById(`${prefix}_native_superseding`))?.status, "superseded");
    assert.equal((await recoveryRepository.findRuntimeSessionById(recoverySuccessorId))?.status, "active");
    await assert.rejects(
      recoveryRepository.startRuntimeSession({
        agentId,
        bindingId: pairingId,
        sessionId: `${prefix}_expired_recovery_race`,
        runtimeKind: "openclaw",
        tokenHash: createHash("sha256").update(`${prefix}:expired-recovery-race-token`).digest("hex"),
        expiresAt: "2026-08-28T18:35:00.000Z",
        expectedSessionId: `${prefix}_native_superseding`,
        expectedAuthorityEpoch: 3,
        allowExpiredPredecessorRecovery: true,
      }),
      /session_superseded/,
    );
  } finally {
    // The random collection prefix isolates tests running against a shared
    // emulator. Delete only this test's collections so a failed test never
    // touches another worker's fixture data.
    const names = [
      "system", "meshes", "topics", "accounts", "provider_identities", "human_sessions",
      "pairings", "agents", "agent_handles", "agent_bindings", "mesh_agent_memberships",
      "agent_authority", "runtime_sessions", "webmcp_grants", "webmcp_authority", "live_access_epochs",
      "mesh_human_roles", "mesh_join_requests", "follows", "posts", "mesh_invitations", "mesh_role_invitations", "idempotency", "quota_counters",
      "event_outbox", "event_outbox_ready", "moderation_cases",
      "audit_events", "governance_events", "event_audit", "topology_activity_totals",
      "topology_activity_buckets", "topology_activity_recent", "topology_activity_snapshots",
      "projection_bootstrap", "processed_events", "topology_shards", "topology_events",
      "mesh_access_epochs", "live_access_epochs",
    ];
    for (const name of names) {
      const snapshot = await collection(name).get();
      if (!snapshot.empty) await firestore.recursiveDelete(collection(name));
    }
    await firestore.terminate();
  }
});

test("Firestore activity preferences and mesh governance merge partial updates atomically", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
  const firestore = new Firestore({ projectId, databaseId: "(default)" });
  const prefix = `atomic_preferences_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = "2026-08-28T20:00:00.000Z";
  const invitationPepper = `${prefix}:invitation-pepper`;
  const repositoryA = new FirestoreMeshrRepository({
    firestore,
    collectionPrefix: prefix,
    clock: { now: () => new Date(now) },
    invitationPepper,
  });
  const repositoryB = new FirestoreMeshrRepository({
    firestore,
    collectionPrefix: prefix,
    clock: { now: () => new Date(now) },
    invitationPepper,
  });
  const names = [
    "system", "meshes", "topics", "accounts", "provider_identities", "human_sessions",
    "mesh_human_roles", "human_activity_preferences", "event_outbox", "event_outbox_ready",
    "event_audit", "audit_events", "governance_events", "idempotency", "quota_counters",
  ];
  try {
    await repositoryA.ensureEmptyProduction();
    const account = await repositoryA.createSocialAccount({
      provider: "google",
      subject: `${prefix}:owner`,
      email: `${prefix}@example.test`,
      displayName: "Atomic Preference Owner",
    });
    const sessionHash = createHash("sha256").update(`${prefix}:session`).digest("hex");
    await repositoryA.createHumanSession({
      tokenHash: sessionHash,
      accountId: account.accountId,
      csrfToken: `${prefix}:csrf`,
      createdAt: now,
      expiresAt: "2026-08-29T20:00:00.000Z",
      absoluteExpiresAt: "2026-09-04T20:00:00.000Z",
    });
    const meshId = `${prefix}_mesh`;
    const topicId = `${prefix}_topic`;
    await repositoryA.createMeshWithOwner({
      mesh: {
        meshId,
        ownerAccountId: account.accountId,
        name: "Atomic mesh",
        description: "Partial update fixture",
        visibility: "public",
        admission: "open",
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
        actingAccountId: account.accountId,
        humanSessionHash: sessionHash,
      },
      topic: {
        topicId,
        meshId,
        name: "general",
        title: "General",
        description: "Atomic preference fixture",
        tags: [],
        createdAt: now,
      },
      agentIds: [],
    });

    await repositoryA.upsertHumanActivityPreference({
      accountId: account.accountId,
      kind: "topic",
      resourceId: topicId,
      meshId,
      watching: false,
      muted: false,
      updatedAt: now,
      humanSessionHash: sessionHash,
    });
    // These writes intentionally provide one field each. Firestore retries
    // the loser of the transaction conflict against the winner's document,
    // so neither stale replica can erase the other field.
    await Promise.all([
      repositoryA.upsertHumanActivityPreference({
        accountId: account.accountId,
        kind: "topic",
        resourceId: topicId,
        meshId,
        watching: true,
        updatedAt: "2026-08-28T20:00:01.000Z",
        humanSessionHash: sessionHash,
      }),
      repositoryB.upsertHumanActivityPreference({
        accountId: account.accountId,
        kind: "topic",
        resourceId: topicId,
        meshId,
        muted: true,
        updatedAt: "2026-08-28T20:00:01.000Z",
        humanSessionHash: sessionHash,
      }),
    ]);
    const preference = (await repositoryA.listHumanActivityPreferences(account.accountId))
      .find((item) => item.resourceId === topicId);
    assert.deepEqual(
      preference && { watching: preference.watching, muted: preference.muted },
      { watching: true, muted: true },
    );

    // Governance uses the same field-level transaction contract. A stale
    // name edit racing a visibility transition must preserve the private
    // decision rather than writing a complete old public snapshot.
    await Promise.all([
      repositoryA.updateMeshGovernance({
        meshId,
        visibility: "private",
        updatedAt: "2026-08-28T20:00:02.000Z",
        actingAccountId: account.accountId,
        humanSessionHash: sessionHash,
      }),
      repositoryB.updateMeshGovernance({
        meshId,
        name: "Renamed atomically",
        updatedAt: "2026-08-28T20:00:02.000Z",
        actingAccountId: account.accountId,
        humanSessionHash: sessionHash,
      }),
    ]);
    const mesh = await repositoryA.findMeshById(meshId);
    assert.equal(mesh?.visibility, "private");
    assert.equal(mesh?.name, "Renamed atomically");

    // A private transition immediately removes a non-member's observation
    // authority. This check is deliberately after the transition, matching
    // the race boundary used by the HTTP route.
    const outsider = await repositoryA.createSocialAccount({
      provider: "github",
      subject: `${prefix}:outsider`,
      email: `${prefix}.outsider@example.test`,
      displayName: "Atomic Preference Outsider",
    });
    const outsiderSession = createHash("sha256").update(`${prefix}:outsider-session`).digest("hex");
    await repositoryA.createHumanSession({
      tokenHash: outsiderSession,
      accountId: outsider.accountId,
      csrfToken: `${prefix}:outsider-csrf`,
      createdAt: now,
      expiresAt: "2026-08-29T20:00:00.000Z",
      absoluteExpiresAt: "2026-09-04T20:00:00.000Z",
    });
    await assert.rejects(
      repositoryB.upsertHumanActivityPreference({
        accountId: outsider.accountId,
        kind: "topic",
        resourceId: topicId,
        meshId,
        watching: true,
        updatedAt: "2026-08-28T20:00:03.000Z",
        humanSessionHash: outsiderSession,
      }),
      /mesh_access_denied/,
    );
  } finally {
    for (const name of names) {
      const collection = firestore.collection(`${prefix}_${name}`);
      const snapshot = await collection.get();
      if (!snapshot.empty) await firestore.recursiveDelete(collection);
    }
    await firestore.terminate();
  }
});

test("Firestore launch bootstrap refuses stale data in an isolated topology database", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
  const authority = new Firestore({ projectId, databaseId: "(default)" });
  // Use a named database so the test exercises the same authority/projection
  // split as production rather than accidentally reading the authority
  // collections through both handles.
  const topologyDatabaseId = `meshr-topology-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const topology = new Firestore({ projectId, databaseId: topologyDatabaseId });
  const cleanPrefix = `launch_clean_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const stalePrefix = `launch_stale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const projectionNames = [
    "projection_bootstrap",
    "topology_shards",
    "topology_events",
    "topology_activity_snapshots",
    "topology_activity_totals",
    "topology_activity_recent",
    "topology_activity_buckets",
    "processed_events",
    "mesh_access_epochs",
    "live_access_epochs",
  ];
  const authorityNames = ["system", "meshes", "topics"];
  const cleanupPrefix = async (store: Firestore, prefix: string, names: string[]) => {
    for (const name of names) {
      const collection = store.collection(`${prefix}_${name}`);
      const snapshot = await collection.get();
      if (!snapshot.empty) await store.recursiveDelete(collection);
    }
  };
  const stalePrefixes: string[] = [stalePrefix];

  try {
    const cleanRepository = new FirestoreMeshrRepository({
      firestore: authority,
      topologyFirestore: topology,
      collectionPrefix: cleanPrefix,
      invitationPepper: `${cleanPrefix}:pepper`,
    });
    await cleanRepository.ensureEmptyProduction();
    const marker = await topology
      .collection(`${cleanPrefix}_projection_bootstrap`)
      .doc("default")
      .get();
    assert.equal(marker.exists, true);
    assert.equal(marker.get("empty_launch"), true);
    assert.equal(marker.get("authority_bootstrap"), "system/bootstrap");
    const authorityBootstrap = await authority
      .collection(`${cleanPrefix}_system`)
      .doc("bootstrap")
      .get();
    assert.equal(typeof authorityBootstrap.get("bootstrap_id"), "string");
    assert.equal(marker.get("authority_bootstrap_id"), authorityBootstrap.get("bootstrap_id"));

    // Any projection-only stale state must block first launch even when the
    // authority database has no identities, posts, or bootstrap marker. Test
    // each collection separately so a future addition cannot accidentally be
    // omitted from the clean-start attestation scan.
    for (const [index, collectionName] of projectionNames
      .filter((name) => name !== "projection_bootstrap")
      .entries()) {
      const prefix = index === 0
        ? stalePrefix
        : `launch_stale_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`;
      if (prefix !== stalePrefix) stalePrefixes.push(prefix);
      await topology
        .collection(`${prefix}_${collectionName}`)
        .doc(`stale-${index}`)
        .set({ mesh_id: "mesh-old", generated_at: "2026-08-28T18:00:00.000Z" });
      const staleRepository = new FirestoreMeshrRepository({
        firestore: authority,
        topologyFirestore: topology,
        collectionPrefix: prefix,
        invitationPepper: `${prefix}:pepper`,
      });
      await assert.rejects(
        staleRepository.ensureEmptyProduction(),
        new RegExp(`topology_projection_not_empty:${collectionName}`),
      );
      assert.equal(
        (await authority.collection(`${prefix}_system`).doc("bootstrap").get()).exists,
        false,
      );
    }
  } finally {
    await cleanupPrefix(authority, cleanPrefix, authorityNames);
    // Cleanup is intentionally bounded to the named prefixes created by this
    // test, including each isolated stale projection fixture.
    for (const prefix of stalePrefixes) {
      await cleanupPrefix(authority, prefix, authorityNames);
      await cleanupPrefix(topology, prefix, projectionNames);
    }
    await cleanupPrefix(topology, cleanPrefix, projectionNames);
    await authority.terminate();
    await topology.terminate();
  }
});

test("Firestore API bootstrap is read-only until the protected store job attests projections", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
  const authority = new Firestore({ projectId, databaseId: "(default)" });
  const topologyDatabaseId = `meshr-topology-reader-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const topology = new Firestore({ projectId, databaseId: topologyDatabaseId });
  const prefix = `launch_reader_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const names = [
    "system", "meshes", "topics", "projection_bootstrap", "topology_activity_snapshots",
    "topology_activity_totals", "topology_activity_recent", "topology_activity_buckets",
    "topology_shards", "topology_events", "processed_events", "mesh_access_epochs", "live_access_epochs",
  ];
  try {
    const reader = new FirestoreMeshrRepository({
      firestore: authority,
      topologyFirestore: topology,
      collectionPrefix: prefix,
      projectionBootstrapWriter: false,
    });
    await assert.rejects(reader.ensureEmptyProduction(), /production_bootstrap_required/);
    assert.equal((await authority.collection(`${prefix}_system`).doc("bootstrap").get()).exists, false);

    const bootstrap = new FirestoreMeshrRepository({
      firestore: authority,
      topologyFirestore: topology,
      collectionPrefix: prefix,
      projectionBootstrapWriter: true,
    });
    await bootstrap.ensureEmptyProduction();
    await reader.ensureEmptyProduction();
    await reader.checkReady();
    const markerRef = topology.collection(`${prefix}_projection_bootstrap`).doc("default");
    await markerRef.update({ authority_bootstrap_id: "stale-generation" });
    await assert.rejects(reader.ensureEmptyProduction(), /topology_projection_bootstrap_missing/);
    await bootstrap.ensureEmptyProduction();
    assert.equal(
      (await markerRef.get()).get("authority_bootstrap_id"),
      (await authority.collection(`${prefix}_system`).doc("bootstrap").get()).get("bootstrap_id"),
    );
    await topology.collection(`${prefix}_topology_activity_totals`).doc("mesh-stale:0").set({ mesh_id: "mesh-stale" });
    await markerRef.update({ authority_bootstrap_id: "stale-generation" });
    await assert.rejects(
      bootstrap.ensureEmptyProduction(),
      /topology_projection_not_empty:topology_activity_totals/,
    );
  } finally {
    for (const name of names) {
      const authorityCollection = authority.collection(`${prefix}_${name}`);
      const authoritySnapshot = await authorityCollection.get();
      if (!authoritySnapshot.empty) await authority.recursiveDelete(authorityCollection);
      const topologyCollection = topology.collection(`${prefix}_${name}`);
      const topologySnapshot = await topologyCollection.get();
      if (!topologySnapshot.empty) await topology.recursiveDelete(topologyCollection);
    }
    await authority.terminate();
    await topology.terminate();
  }
});
