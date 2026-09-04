import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MeshrDatabase } from "./database.ts";
import {
  MAX_ACTIVITY_PREFERENCES_PER_ACCOUNT,
  MAX_MESH_DETAIL_MEMBER_ROWS,
  MAX_MESH_DIRECTORY_ENTRIES,
  MAX_TOPICS_PER_MESH,
} from "./repository.ts";
import { SqliteMeshrRepository } from "./sqliteRepository.ts";
import type { Clock } from "./types.ts";

class MutableClock implements Clock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  set(value: string): void {
    this.value = new Date(value);
  }
}

const artifact = (prefix: string, meshId: string, sessionId: string, occurredAt: string) => ({
  event: {
    eventId: `${prefix}-event`,
    type: "repository.conformance",
    meshId,
    topicId: null,
    agentId: null,
    sessionId,
    runtimeKind: null,
    payload: { prefix },
    occurredAt,
  },
  audit: {
    auditId: `${prefix}-audit`,
    actorType: "human" as const,
    actorId: "owner-sqlite",
    sessionId,
    action: "repository.conformance",
    resourceType: "mesh",
    resourceId: meshId,
    data: { prefix },
    createdAt: occurredAt,
  },
});

test("SQLite adapter matches Firestore transaction boundaries for corrected authority writes", async () => {
  const now = "2026-08-28T18:00:00.000Z";
  const clock = new MutableClock(new Date(now));
  const database = new MeshrDatabase({ path: ":memory:", clock, seed: false });
  const repository = new SqliteMeshrRepository(database, clock);
  const ownerSessionHash = createHash("sha256").update("owner-sqlite-session").digest("hex");

  try {
    const owner = await repository.createSocialAccount({
      provider: "google",
      subject: "sqlite-owner-google",
      email: "sqlite-owner@example.test",
      displayName: "SQLite Owner",
    });
    await repository.createHumanSession({
      tokenHash: ownerSessionHash,
      accountId: owner.accountId,
      csrfToken: "sqlite-csrf",
      createdAt: now,
      expiresAt: "2026-08-28T18:15:00.000Z",
      absoluteExpiresAt: "2026-09-04T18:00:00.000Z",
    });

    const meshId = "sqlite-conformance-mesh";
    const topicId = "sqlite-conformance-topic";
    await repository.createMeshWithOwner({
      mesh: {
        meshId,
        ownerAccountId: owner.accountId,
        name: "SQLite conformance",
        description: "Transaction boundary fixture",
        visibility: "private",
        admission: "approval",
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
        actingAccountId: owner.accountId,
        humanSessionHash: ownerSessionHash,
      },
      topic: {
        topicId,
        meshId,
        name: "conformance",
        title: "Conformance",
        description: "Repository contract checks",
        tags: ["test"],
        createdAt: now,
      },
      agentIds: [],
    });

    // A successful upsert preserves the immutable creation timestamp and
    // commits its audit/outbox records in the same local transaction.
    const meshUpdateAt = "2026-08-28T18:05:00.000Z";
    await repository.upsertMesh({
      meshId,
      ownerAccountId: owner.accountId,
      name: "SQLite conformance updated",
      description: "Updated transaction fixture",
      visibility: "unlisted",
      admission: "invite_only",
      lifecycle: "active",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: meshUpdateAt,
      actingAccountId: owner.accountId,
      humanSessionHash: ownerSessionHash,
      ...artifact("mesh-update", meshId, ownerSessionHash, meshUpdateAt),
    });
    const mesh = database.sqlite.prepare(
      "SELECT created_at, name, visibility FROM meshes WHERE id = ?",
    ).get(meshId) as { created_at: string; name: string; visibility: string };
    assert.ok(mesh);
    assert.equal(mesh.created_at, now);
    assert.equal(mesh.name, "SQLite conformance updated");
    assert.equal(mesh.visibility, "unlisted");
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE event_id = ?")
        .get("mesh-update-event")?.count,
      1,
    );
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id = ?")
        .get("mesh-update-audit")?.count,
      1,
    );

    // The client timestamp must not resurrect an expired owner session. The
    // failed transaction leaves both state and mutation artifacts untouched.
    const expiredNow = "2026-08-28T19:00:00.000Z";
    clock.set(expiredNow);
    await assert.rejects(
      repository.upsertMesh({
        meshId,
        ownerAccountId: owner.accountId,
        name: "must not apply",
        description: "must not apply",
        visibility: "private",
        admission: "approval",
        lifecycle: "active",
        createdAt: now,
        updatedAt: expiredNow,
        actingAccountId: owner.accountId,
        humanSessionHash: ownerSessionHash,
        ...artifact("expired-mesh-update", meshId, ownerSessionHash, expiredNow),
      }),
      /mesh_governance_denied/,
    );
    const afterRejectedMesh = database.sqlite.prepare("SELECT name FROM meshes WHERE id = ?").get(meshId) as { name: string };
    assert.equal(afterRejectedMesh.name, "SQLite conformance updated");
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE event_id = ?")
        .get("expired-mesh-update-event")?.count,
      0,
    );

    // Build one agent row for join-request and post authority checks. The
    // adapter's public pairing flow is covered by the broader API suite; this
    // fixture keeps the repository conformance test focused on the corrected
    // mutation boundaries.
    const agentId = "sqlite-conformance-agent";
    database.sqlite.prepare(
      `INSERT INTO agents(
         id, owner_account_id, name, handle, tagline, interests_json,
         personality, attention_json, runtime, runtime_label, runtime_subject,
         public_key_pem, definition_digest, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentId,
      owner.accountId,
      "SQLite Agent",
      "sqlite-agent",
      "Conformance agent",
      JSON.stringify(["testing"]),
      "careful",
      JSON.stringify({ browse: "public", rootPosts: "draft", replies: "draft" }),
      "local",
      "SQLite fixture",
      "sqlite-conformance",
      "test-public-key",
      null,
      now,
      now,
    );

    const nativePairingId = "sqlite-native-pairing";
    const nativeSessionId = "sqlite-native-session";
    database.sqlite.prepare(
      `INSERT INTO pairings(
         id, code, secret_hash, runtime, runtime_label, external_subject,
         public_key_pem, requested_profile_json, definition_digest, status,
         owner_account_id, agent_id, created_at, expires_at, claimed_at
       ) VALUES(?, ?, ?, 'local', ?, ?, ?, NULL, NULL, 'claimed', ?, ?, ?, ?, ?)`,
    ).run(
      nativePairingId,
      "SQLI-TEST",
      createHash("sha256").update("sqlite-native-secret").digest("hex"),
      "SQLite native fixture",
      "sqlite:native",
      "test-public-key",
      owner.accountId,
      agentId,
      now,
      "2026-08-28T19:10:00.000Z",
      now,
    );
    database.sqlite.prepare(
      `INSERT INTO agent_sessions(
         token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
         session_id, runtime_kind, status, superseded_by, authority_epoch
       ) VALUES(?, ?, ?, ?, ?, ?, ?, 'local', 'active', NULL, 1)`,
    ).run(
      createHash("sha256").update("sqlite-native-token").digest("hex"),
      agentId,
      nativePairingId,
      now,
      "2026-08-28T19:10:00.000Z",
      "2026-08-28T18:10:00.000Z",
      nativeSessionId,
    );
    database.sqlite.prepare(
      `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
       VALUES(?, 1, 'native', ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         epoch = excluded.epoch, authority_kind = excluded.authority_kind,
         session_id = excluded.session_id, updated_at = excluded.updated_at`,
    ).run(agentId, nativeSessionId, "2026-08-28T18:10:00.000Z");

    const invitationTokenHash = createHash("sha256").update("sqlite-cross-mesh-invite").digest("hex");
    for (const [candidateId, name] of [
      ["sqlite-invite-source", "SQLite invite source"],
      ["sqlite-invite-target", "SQLite invite target"],
    ] as const) {
      database.sqlite.prepare(
        `INSERT INTO meshes(
           id, owner_account_id, name, description, visibility, join_policy,
           lifecycle, created_at, updated_at
         ) VALUES(?, ?, ?, '', 'private', 'invite_only', 'active', ?, ?)`,
      ).run(candidateId, owner.accountId, name, now, now);
    }
    database.sqlite.prepare(
      `INSERT INTO mesh_invitations(
         id, mesh_id, token_hash, invited_agent_id, created_by_account_id,
         status, created_at, expires_at, redeemed_at, redeemed_agent_id
       ) VALUES('sqlite-cross-mesh-invite', 'sqlite-invite-source', ?, ?, ?,
                'active', ?, '2026-08-28T19:10:00.000Z', NULL, NULL)`,
    ).run(invitationTokenHash, agentId, owner.accountId, now);
    await assert.rejects(
      repository.joinMeshForAgent({
        meshId: "sqlite-invite-target",
        agentId,
        ownerAccountId: owner.accountId,
        sessionId: nativeSessionId,
        authorityEpoch: 1,
        runtimeKind: "local",
        idempotencyKey: "sqlite-cross-mesh-join",
        requestId: "sqlite-cross-mesh-request",
        requestedAt: "2026-08-28T18:10:00.000Z",
        invitationTokenHash,
      }),
      /invitation_invalid/,
      "an invitation must be bound to the mesh that issued it",
    );
    assert.equal(await repository.findMeshAgentMembership("sqlite-invite-target", agentId), null);
    assert.equal(
      database.sqlite.prepare("SELECT status FROM mesh_invitations WHERE id = 'sqlite-cross-mesh-invite'")
        .get()?.status,
      "active",
    );
    database.sqlite.prepare("UPDATE meshes SET join_policy = 'approval' WHERE id = ?")
      .run(meshId);

    const authoritativeJoin = {
      meshId,
      agentId,
      ownerAccountId: owner.accountId,
      sessionId: nativeSessionId,
      authorityEpoch: 1,
      runtimeKind: "local" as const,
      idempotencyKey: "sqlite-authoritative-join",
      requestId: "sqlite-command-join-request",
      requestedAt: "2026-08-28T18:10:00.000Z",
    };
    const pendingJoin = await repository.joinMeshForAgent(authoritativeJoin);
    assert.equal(pendingJoin.status, "pending");
    assert.equal(
      (await repository.findMeshAgentMembership(meshId, agentId))?.attentionPolicy.browse,
      "public",
    );
    database.sqlite.prepare("UPDATE agents SET attention_json = ? WHERE id = ?")
      .run(JSON.stringify({ browse: "mentions", rootPosts: "draft", replies: "draft" }), agentId);
    await assert.rejects(
      repository.joinMeshForAgent(authoritativeJoin),
      /attention_policy_denied/,
      "an idempotent replay must not restore join authority after policy withdrawal",
    );
    clock.set("2026-08-28T18:10:00.000Z");
    await assert.rejects(
      repository.resolveJoinRequest({
        requestId: authoritativeJoin.requestId,
        meshId,
        decision: "approved",
        resolvedAt: "2026-08-28T18:10:00.000Z",
        actingAccountId: owner.accountId,
        humanSessionHash: ownerSessionHash,
        ...artifact("withdrawn-join-approval", meshId, ownerSessionHash, "2026-08-28T18:10:00.000Z"),
      }),
      /attention_policy_denied/,
      "a steward approval must not complete a join after owner policy withdrawal",
    );
    assert.equal((await repository.findJoinRequest(authoritativeJoin.requestId))?.status, "pending");
    database.sqlite.prepare("UPDATE agents SET attention_json = ? WHERE id = ?")
      .run(JSON.stringify({ browse: "public", rootPosts: "draft", replies: "draft" }), agentId);
    database.sqlite.prepare("UPDATE meshes SET join_policy = 'invite_only' WHERE id = ?")
      .run(meshId);
    await assert.rejects(
      repository.resolveJoinRequest({
        requestId: authoritativeJoin.requestId,
        meshId,
        decision: "approved",
        resolvedAt: "2026-08-28T18:10:00.000Z",
        actingAccountId: owner.accountId,
        humanSessionHash: ownerSessionHash,
        ...artifact("withdrawn-admission-approval", meshId, ownerSessionHash, "2026-08-28T18:10:00.000Z"),
      }),
      /mesh_admission_changed/,
      "a pending approval must not bypass a later invite-only policy",
    );
    assert.equal((await repository.findJoinRequest(authoritativeJoin.requestId))?.status, "pending");
    database.sqlite.prepare(
      "UPDATE meshes SET join_policy = 'approval', lifecycle = 'archived' WHERE id = ?",
    ).run(meshId);
    await assert.rejects(
      repository.resolveJoinRequest({
        requestId: authoritativeJoin.requestId,
        meshId,
        decision: "approved",
        resolvedAt: "2026-08-28T18:10:00.000Z",
        actingAccountId: owner.accountId,
        humanSessionHash: ownerSessionHash,
        ...artifact("archived-admission-approval", meshId, ownerSessionHash, "2026-08-28T18:10:00.000Z"),
      }),
      /mesh_unavailable/,
      "an archived mesh must not accept a pending approval",
    );
    assert.equal((await repository.findJoinRequest(authoritativeJoin.requestId))?.status, "pending");
    database.sqlite.prepare("UPDATE meshes SET lifecycle = 'active' WHERE id = ?").run(meshId);
    clock.set(expiredNow);

    // Join authorization uses the repository's current clock, not the
    // request's historical createdAt. The same request succeeds once the
    // clock is moved back inside the live human session.
    const joinInput = {
      requestId: "sqlite-join-request",
      meshId,
      agentId,
      requestedByAccountId: owner.accountId,
      status: "approved" as const,
      createdAt: now,
      resolvedAt: "2026-08-28T18:01:00.000Z",
      actingAccountId: owner.accountId,
      humanSessionHash: ownerSessionHash,
    };
    await assert.rejects(
      repository.upsertJoinRequest({
        ...joinInput,
        ...artifact("expired-join", meshId, ownerSessionHash, now),
      }),
      /mesh_governance_denied/,
    );
    assert.equal(await repository.findJoinRequest(joinInput.requestId), null);
    clock.set("2026-08-28T18:10:00.000Z");
    await repository.upsertJoinRequest({
      ...joinInput,
      ...artifact("join", meshId, ownerSessionHash, "2026-08-28T18:10:00.000Z"),
    });
    const join = await repository.findJoinRequest(joinInput.requestId);
    assert.ok(join);
    assert.equal(join.status, "approved");
    assert.equal(join.createdAt, now);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id = ?")
        .get("join-audit")?.count,
      1,
    );

    const defaultPreference = await repository.upsertHumanActivityPreference({
      accountId: owner.accountId,
      kind: "topic",
      resourceId: topicId,
      meshId,
      watching: false,
      muted: false,
      updatedAt: "2026-08-28T18:10:00.000Z",
      humanSessionHash: ownerSessionHash,
    });
    assert.deepEqual(
      { watching: defaultPreference.watching, muted: defaultPreference.muted },
      { watching: false, muted: false },
    );
    assert.equal((await repository.listHumanActivityPreferences(owner.accountId)).length, 0);

    database.transaction(() => {
      const insert = database.sqlite.prepare(
        `INSERT INTO human_activity_preferences(
           account_id, kind, resource_id, watching, muted, updated_at
         ) VALUES(?, 'link', ?, 1, 0, ?)`,
      );
      for (let index = 0; index < MAX_ACTIVITY_PREFERENCES_PER_ACCOUNT; index += 1) {
        insert.run(owner.accountId, `traffic:${meshId}:source-${index}:target-${index}`, now);
      }
    });
    await assert.rejects(
      repository.upsertHumanActivityPreference({
        accountId: owner.accountId,
        kind: "link",
        resourceId: `traffic:${meshId}:new-source:new-target`,
        meshId,
        watching: true,
        updatedAt: "2026-08-28T18:10:00.000Z",
        humanSessionHash: ownerSessionHash,
      }),
      /activity_preference_limit_reached/,
    );
    await repository.upsertHumanActivityPreference({
      accountId: owner.accountId,
      kind: "link",
      resourceId: `traffic:${meshId}:source-0:target-0`,
      meshId,
      watching: false,
      muted: false,
      updatedAt: "2026-08-28T18:10:00.000Z",
      humanSessionHash: ownerSessionHash,
    });
    await repository.upsertHumanActivityPreference({
      accountId: owner.accountId,
      kind: "link",
      resourceId: `traffic:${meshId}:new-source:new-target`,
      meshId,
      watching: true,
      updatedAt: "2026-08-28T18:10:00.000Z",
      humanSessionHash: ownerSessionHash,
    });
    assert.equal((await repository.listHumanActivityPreferences(owner.accountId)).length, 500);

    // Page-grant recovery must require both authority fences. A matching
    // grant row alone is not enough to reissue a browser bearer after a
    // response-loss retry.
    const pageSessionId = "sqlite-page-session";
    const pageGrantHash = createHash("sha256")
      .update("sqlite-page-grant")
      .digest("hex");
    await repository.transferPageAuthority({
      agentId,
      grantId: pageGrantHash,
      humanSessionHash: ownerSessionHash,
      expiresAt: "2026-08-28T18:14:00.000Z",
      sessionId: pageSessionId,
    });
    const activePageGrant = await repository.findActiveWebMcpGrant(ownerSessionHash, agentId);
    assert.equal(activePageGrant?.tokenHash, pageGrantHash);
    assert.equal(activePageGrant?.sessionId, pageSessionId);
    assert.equal(
      await repository.revokeWebMcpGrants(
        ownerSessionHash,
        "2026-08-28T18:10:00.500Z",
        { agentId, sessionId: "sqlite-stale-page-session" },
      ),
      false,
    );
    assert.equal(
      (await repository.findActiveWebMcpGrant(ownerSessionHash, agentId))
        ?.sessionId,
      pageSessionId,
    );
    database.sqlite.prepare("UPDATE agent_authority SET session_id = ? WHERE agent_id = ?")
      .run("sqlite-stale-page-session", agentId);
    assert.equal(await repository.findActiveWebMcpGrant(ownerSessionHash, agentId), null);
    database.sqlite.prepare("UPDATE agent_authority SET session_id = ? WHERE agent_id = ?")
      .run(pageSessionId, agentId);
    assert.equal(
      await repository.revokeWebMcpGrants(
        ownerSessionHash,
        "2026-08-28T18:10:01.000Z",
        { agentId, sessionId: pageSessionId },
      ),
      true,
    );
    assert.equal(await repository.findActiveWebMcpGrant(ownerSessionHash, agentId), null);
    const revokedWebMcpEpoch = database.sqlite.prepare(
      "SELECT epoch FROM webmcp_authority WHERE human_session_hash = ?",
    ).get(ownerSessionHash)?.epoch;
    assert.equal(
      await repository.revokeWebMcpGrants(
        ownerSessionHash,
        "2026-08-28T18:10:02.000Z",
      ),
      true,
    );
    assert.equal(
      database.sqlite.prepare(
        "SELECT epoch FROM webmcp_authority WHERE human_session_hash = ?",
      ).get(ownerSessionHash)?.epoch,
      revokedWebMcpEpoch,
    );

    const postId = "sqlite-conformance-post";
    database.sqlite.prepare(
      `INSERT INTO posts(
         id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
         created_at, moderation_state, moderation_reason, expires_at
       ) VALUES(?, ?, ?, ?, ?, NULL, ?, ?, 'quarantined', ?, ?)`,
    ).run(
      postId,
      meshId,
      topicId,
      agentId,
      "sqlite-native-session",
      "untrusted body",
      "2026-08-28T18:02:00.000Z",
      "policy review",
      "2026-11-26T18:02:00.000Z",
    );
    const caseId = "sqlite-conformance-case";
    await repository.upsertModerationCase({
      caseId,
      postId,
      meshId,
      reason: "policy review",
      state: "queued",
      severity: "medium",
      resolution: null,
      createdAt: "2026-08-28T18:02:00.000Z",
      updatedAt: "2026-08-28T18:02:00.000Z",
      resolvedAt: null,
      ...artifact("moderation-open", meshId, ownerSessionHash, "2026-08-28T18:02:00.000Z"),
    });
    await repository.updatePostModeration({
      caseId,
      postId,
      state: "redacted",
      reason: "operator review",
      body: "[redacted]",
      caseState: "resolved",
      resolution: "redact",
      updatedAt: "2026-08-28T18:10:00.000Z",
      actingAccountId: owner.accountId,
      humanSessionHash: ownerSessionHash,
      ...artifact("moderation-resolve", meshId, ownerSessionHash, "2026-08-28T18:10:00.000Z"),
    });
    const moderatedPost = await repository.findPostById(postId);
    assert.ok(moderatedPost);
    assert.equal(moderatedPost.moderationState, "redacted");
    assert.equal(moderatedPost.body, "[redacted]");
    const moderatedCase = await repository.findModerationCase(caseId);
    assert.ok(moderatedCase);
    assert.equal(moderatedCase.state, "resolved");
    assert.equal(moderatedCase.resolution, "redact");
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE event_id = ?")
        .get("moderation-resolve-event")?.count,
      1,
    );

    // Automated decisions must carry the worker marker and the exact post
    // revision observed by the provider. A stale provider result is rejected
    // even when the caller supplies a valid idempotency key.
    const automatedPostId = "sqlite-automated-moderation-post";
    const automatedCreatedAt = "2026-08-28T18:20:00.000Z";
    database.sqlite.prepare(
      `INSERT INTO posts(
         id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
         created_at, moderation_state, moderation_reason, expires_at
       ) VALUES(?, ?, ?, ?, ?, NULL, ?, ?, 'quarantined', ?, ?)`,
    ).run(
      automatedPostId,
      meshId,
      topicId,
      agentId,
      "sqlite-automated-session",
      "automated body",
      automatedCreatedAt,
      "policy review",
      "2026-11-26T18:20:00.000Z",
    );
    const automatedCaseId = "sqlite-automated-moderation-case";
    await repository.upsertModerationCase({
      caseId: automatedCaseId,
      postId: automatedPostId,
      meshId,
      reason: "policy review",
      state: "queued",
      severity: "high",
      resolution: null,
      createdAt: automatedCreatedAt,
      updatedAt: automatedCreatedAt,
      resolvedAt: null,
    });
    await assert.rejects(
      repository.updatePostModeration({
        caseId: automatedCaseId,
        postId: automatedPostId,
        state: "published",
        reason: "automated allow",
        caseState: "resolved",
        resolution: "allow",
        updatedAt: "2026-08-28T18:21:00.000Z",
        actingAccountId: owner.accountId,
        humanSessionHash: ownerSessionHash,
        idempotencyKey: "sqlite-automated-invalid-marker",
        requestHash: "sqlite-automated-invalid-marker-hash",
        automated: { expectedPostState: "quarantined", expectedPostUpdatedAt: automatedCreatedAt },
      }),
      /moderation_authorization_denied/,
    );
    const automated = await repository.updatePostModeration({
      caseId: automatedCaseId,
      postId: automatedPostId,
      state: "published",
      reason: "automated allow",
      caseState: "resolved",
      resolution: "allow",
      updatedAt: "2026-08-28T18:21:00.000Z",
      actingAccountId: "moderation-worker",
      humanSessionHash: "internal",
      idempotencyKey: "sqlite-automated-allow",
      requestHash: "sqlite-automated-allow-hash",
      automated: { expectedPostState: "quarantined", expectedPostUpdatedAt: automatedCreatedAt },
      ...artifact("moderation-automated", meshId, "internal", "2026-08-28T18:21:00.000Z"),
    });
    assert.equal(automated.duplicate, false);
    assert.equal(automated.post?.moderationState, "published");
    await assert.rejects(
      repository.updatePostModeration({
        caseId: automatedCaseId,
        postId: automatedPostId,
        state: "removed",
        reason: "stale provider result",
        caseState: "resolved",
        resolution: "remove",
        updatedAt: "2026-08-28T18:22:00.000Z",
        actingAccountId: "moderation-worker",
        humanSessionHash: "internal",
        idempotencyKey: "sqlite-automated-stale",
        requestHash: "sqlite-automated-stale-hash",
        automated: { expectedPostState: "quarantined", expectedPostUpdatedAt: automatedCreatedAt },
      }),
      /moderation_transition_conflict/,
    );

    // Two operators racing to start the same queued case must not both win.
    // SQLite's transaction boundary is the local conformance stand-in for the
    // Firestore transaction: one request records its idempotency result and
    // the other observes the reviewing state and gets a deterministic
    // transition conflict.
    const racePostId = "sqlite-moderation-race-post";
    database.sqlite.prepare(
      `INSERT INTO posts(
         id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
         created_at, moderation_state, moderation_reason, expires_at
       ) VALUES(?, ?, ?, ?, ?, NULL, ?, ?, 'quarantined', ?, ?)`,
    ).run(
      racePostId,
      meshId,
      topicId,
      agentId,
      "sqlite-race-session",
      "race body",
      "2026-08-28T18:11:00.000Z",
      "needs review",
      "2026-11-26T18:11:00.000Z",
    );
    const raceCaseId = "sqlite-moderation-race-case";
    await repository.upsertModerationCase({
      caseId: raceCaseId,
      postId: racePostId,
      meshId,
      reason: "needs review",
      state: "queued",
      severity: "medium",
      resolution: null,
      createdAt: "2026-08-28T18:11:00.000Z",
      updatedAt: "2026-08-28T18:11:00.000Z",
      resolvedAt: null,
    });
    const raceRequest = (suffix: string) => repository.upsertModerationCase({
      caseId: raceCaseId,
      postId: racePostId,
      meshId,
      reason: "needs review",
      state: "reviewing",
      severity: "medium",
      resolution: null,
      createdAt: "2026-08-28T18:11:00.000Z",
      updatedAt: "2026-08-28T18:12:00.000Z",
      resolvedAt: null,
      actingAccountId: owner.accountId,
      humanSessionHash: ownerSessionHash,
      idempotencyKey: `sqlite-race-${suffix}`,
      requestHash: `sqlite-race-hash-${suffix}`,
      ...artifact(`moderation-race-${suffix}`, meshId, ownerSessionHash, "2026-08-28T18:12:00.000Z"),
    });
    const raceResults = await Promise.allSettled([
      raceRequest("a"),
      raceRequest("b"),
    ]);
    assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(raceResults.filter((result) => result.status === "rejected").length, 1);
    const rejectedRace = raceResults.find((result) => result.status === "rejected");
    assert.ok(rejectedRace && rejectedRace.reason instanceof Error);
    assert.equal(rejectedRace.reason.message, "moderation_transition_conflict");
    const winningRace = raceResults.find((result) => result.status === "fulfilled");
    assert.ok(winningRace && winningRace.value.moderationCase?.state === "reviewing");
    const winningSuffix = raceResults[0]?.status === "fulfilled" ? "a" : "b";
    const raceRetry = await raceRequest(winningSuffix);
    assert.equal(raceRetry.duplicate, true);
    assert.equal(raceRetry.moderationCase?.state, "reviewing");
    await assert.rejects(
      repository.upsertModerationCase({
        caseId: raceCaseId,
        postId: racePostId,
        meshId,
        reason: "needs review",
        state: "reviewing",
        severity: "medium",
        resolution: null,
        createdAt: "2026-08-28T18:11:00.000Z",
        updatedAt: "2026-08-28T18:12:00.000Z",
        resolvedAt: null,
        actingAccountId: owner.accountId,
        humanSessionHash: ownerSessionHash,
        idempotencyKey: `sqlite-race-${winningSuffix}`,
        requestHash: "different-request",
        ...artifact("moderation-race-conflict", meshId, ownerSessionHash, "2026-08-28T18:12:00.000Z"),
      }),
      /idempotency_conflict/,
    );
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE id LIKE 'moderation-race-%-audit'")
        .get()?.count,
      1,
    );
  } finally {
    database.close();
  }
});

test("SQLite repairs expired orphaned page grants but rejects current fence mismatches", async () => {
  const initialNow = "2026-09-04T18:00:00.000Z";
  const clock = new MutableClock(new Date(initialNow));
  const database = new MeshrDatabase({ path: ":memory:", clock });
  const repository = new SqliteMeshrRepository(database, clock);
  const humanSessionHash = createHash("sha256")
    .update("sqlite-webmcp-ttl-race")
    .digest("hex");

  try {
    const owner = await repository.createSocialAccount({
      provider: "google",
      subject: "sqlite-webmcp-ttl-owner",
      email: "sqlite-webmcp-ttl@example.test",
      displayName: "SQLite WebMCP TTL Owner",
    });
    await repository.createHumanSession({
      tokenHash: humanSessionHash,
      accountId: owner.accountId,
      csrfToken: "sqlite-webmcp-ttl-csrf",
      createdAt: initialNow,
      expiresAt: "2026-09-04T20:00:00.000Z",
      absoluteExpiresAt: "2026-09-11T18:00:00.000Z",
    });

    const command = (ordinal: number, expiresAt: string) => {
      const now = clock.now().toISOString();
      const agentId = `sqlite-webmcp-ttl-agent-${ordinal}`;
      const sessionId = `sqlite-webmcp-ttl-page-${ordinal}`;
      return {
        agent: {
          agentId,
          ownerAccountId: owner.accountId,
          name: `SQLite TTL Agent ${ordinal}`,
          handle: `sqlite-ttl-agent-${ordinal}`,
          tagline: "Exercises page-authority cleanup skew.",
          interests: ["WebMCP"],
          personality: "Careful.",
          attention: {
            browse: "public" as const,
            rootPosts: "draft" as const,
            replies: "draft" as const,
            notes: "Act only from the page.",
          },
          runtime: "other" as const,
          runtimeLabel: "Page WebMCP",
          runtimeSubject: `webmcp:${agentId}`,
          publicKeyPem: "",
          definitionDigest: null,
          createdAt: now,
          updatedAt: now,
        },
        grantId: createHash("sha256")
          .update(`sqlite-webmcp-ttl-grant-${ordinal}`)
          .digest("hex"),
        humanSessionHash,
        expiresAt,
        sessionId,
        idempotencyKey: `sqlite-webmcp-ttl-create-${ordinal}`,
        requestHash: createHash("sha256")
          .update(`sqlite-webmcp-ttl-request-${ordinal}`)
          .digest("hex"),
        event: {
          eventId: `sqlite-webmcp-ttl-event-${ordinal}`,
          type: "agent.created",
          meshId: "mesh-public",
          topicId: null,
          agentId,
          sessionId,
          runtimeKind: null,
          payload: { agentId, authority: "page_webmcp" },
          occurredAt: now,
        },
        audit: {
          auditId: `sqlite-webmcp-ttl-audit-${ordinal}`,
          actorType: "human" as const,
          actorId: owner.accountId,
          sessionId: humanSessionHash,
          action: "webmcp.agent.created",
          resourceType: "agent",
          resourceId: agentId,
          data: { authority: "page_webmcp" },
          createdAt: now,
        },
      };
    };

    const firstInput = command(1, "2026-09-04T18:30:00.000Z");
    const first = await repository.createBrowserAgentWithPageAuthority(firstInput);
    assert.equal(first.authorityEpoch, 1);

    clock.set("2026-09-04T18:31:00.000Z");
    database.sqlite
      .prepare("DELETE FROM webmcp_authority WHERE human_session_hash = ?")
      .run(humanSessionHash);
    const secondInput = command(2, "2026-09-04T19:15:00.000Z");
    const second = await repository.createBrowserAgentWithPageAuthority(secondInput);
    assert.equal(second.authorityEpoch, first.authorityEpoch + 1);
    assert.equal(
      database.sqlite
        .prepare("SELECT revoked_at FROM webmcp_grants WHERE token_hash = ?")
        .get(firstInput.grantId)?.revoked_at,
      "2026-09-04T18:31:00.000Z",
    );

    // A missing fence is repairable only after its grant expires.
    database.sqlite
      .prepare("DELETE FROM webmcp_authority WHERE human_session_hash = ?")
      .run(humanSessionHash);
    const blockedCreate = command(3, "2026-09-04T19:20:00.000Z");
    await assert.rejects(
      repository.createBrowserAgentWithPageAuthority(blockedCreate),
      /webmcp_authority_corrupt/,
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM agents WHERE id = ?")
        .get(blockedCreate.agent.agentId)?.count,
      0,
    );

    clock.set("2026-09-04T19:16:00.000Z");
    const exhaustedEpoch = Number.MAX_SAFE_INTEGER;
    database.sqlite
      .prepare(
        "UPDATE webmcp_grants SET authority_epoch = ? WHERE token_hash = ?",
      )
      .run(exhaustedEpoch, secondInput.grantId);
    database.sqlite
      .prepare(
        `INSERT INTO webmcp_authority(
           human_session_hash, epoch, grant_id, agent_id, session_id, updated_at, revoked_at
         ) VALUES(?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        humanSessionHash,
        exhaustedEpoch,
        secondInput.grantId,
        secondInput.agent.agentId,
        secondInput.sessionId,
        clock.now().toISOString(),
      );
    const unsafeFenceCreate = command(4, "2026-09-04T19:50:00.000Z");
    await assert.rejects(
      repository.createBrowserAgentWithPageAuthority(unsafeFenceCreate),
      /webmcp_authority_corrupt/,
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM agents WHERE id = ?")
        .get(unsafeFenceCreate.agent.agentId)?.count,
      0,
    );
    await assert.rejects(
      repository.revokeWebMcpGrants(
        humanSessionHash,
        clock.now().toISOString(),
        {
          agentId: secondInput.agent.agentId,
          sessionId: secondInput.sessionId,
        },
      ),
      /webmcp_authority_corrupt/,
    );
    assert.equal(
      database.sqlite
        .prepare(
          "SELECT revoked_at FROM webmcp_grants WHERE token_hash = ?",
        )
        .get(secondInput.grantId)?.revoked_at,
      null,
    );
    assert.equal(
      database.sqlite
        .prepare(
          "SELECT CAST(epoch AS REAL) AS epoch FROM webmcp_authority WHERE human_session_hash = ?",
        )
        .get(humanSessionHash)?.epoch,
      exhaustedEpoch,
    );
    database.sqlite
      .prepare("DELETE FROM webmcp_authority WHERE human_session_hash = ?")
      .run(humanSessionHash);
    database.sqlite
      .prepare(
        "UPDATE webmcp_grants SET authority_epoch = ? WHERE token_hash = ?",
      )
      .run(second.authorityEpoch, secondInput.grantId);

    database.sqlite
      .prepare(
        `UPDATE agent_authority
         SET epoch = ?, authority_kind = 'page', session_id = ?
         WHERE agent_id = ?`,
      )
      .run(exhaustedEpoch, firstInput.sessionId, firstInput.agent.agentId);
    const unsafeAuthorityGrantId = createHash("sha256")
      .update("sqlite-webmcp-unsafe-agent-authority-grant")
      .digest("hex");
    await assert.rejects(
      repository.transferPageAuthority({
        agentId: firstInput.agent.agentId,
        grantId: unsafeAuthorityGrantId,
        humanSessionHash,
        expiresAt: "2026-09-04T19:45:00.000Z",
        sessionId: "sqlite-webmcp-unsafe-agent-authority-page",
      }),
      /agent_authority_corrupt/,
    );
    assert.equal(
      database.sqlite
        .prepare("SELECT COUNT(*) AS count FROM webmcp_grants WHERE token_hash = ?")
        .get(unsafeAuthorityGrantId)?.count,
      0,
    );

    database.sqlite
      .prepare(
        `UPDATE agent_authority
         SET epoch = ?, authority_kind = 'native', session_id = 'missing-native-session'
         WHERE agent_id = ?`,
      )
      .run(first.authorityEpoch, firstInput.agent.agentId);
    await assert.rejects(
      repository.transferPageAuthority({
        agentId: firstInput.agent.agentId,
        grantId: createHash("sha256")
          .update("sqlite-webmcp-stale-native-grant")
          .digest("hex"),
        humanSessionHash,
        expiresAt: "2026-09-04T19:45:00.000Z",
        sessionId: "sqlite-webmcp-stale-native-page",
      }),
      /agent_authority_corrupt/,
    );
    database.sqlite
      .prepare(
        `UPDATE agent_authority
         SET authority_kind = 'page', session_id = ?, epoch = ?
         WHERE agent_id = ?`,
      )
      .run(
        firstInput.sessionId,
        first.authorityEpoch,
        firstInput.agent.agentId,
      );
    const transfer = await repository.transferPageAuthority({
      agentId: firstInput.agent.agentId,
      grantId: createHash("sha256")
        .update("sqlite-webmcp-ttl-transfer-grant")
        .digest("hex"),
      humanSessionHash,
      expiresAt: "2026-09-04T19:45:00.000Z",
      sessionId: "sqlite-webmcp-ttl-transfer-page",
    });
    assert.equal(transfer.authorityEpoch, second.authorityEpoch + 1);
    assert.equal(
      database.sqlite
        .prepare("SELECT revoked_at FROM webmcp_grants WHERE token_hash = ?")
        .get(secondInput.grantId)?.revoked_at,
      "2026-09-04T19:16:00.000Z",
    );

    database.sqlite
      .prepare("DELETE FROM webmcp_authority WHERE human_session_hash = ?")
      .run(humanSessionHash);
    await assert.rejects(
      repository.transferPageAuthority({
        agentId: secondInput.agent.agentId,
        grantId: createHash("sha256")
          .update("sqlite-webmcp-ttl-blocked-transfer")
          .digest("hex"),
        humanSessionHash,
        expiresAt: "2026-09-04T19:50:00.000Z",
        sessionId: "sqlite-webmcp-ttl-blocked-page",
      }),
      /webmcp_authority_corrupt/,
    );
  } finally {
    database.close();
  }
});

test("SQLite durable authority commands are semantic no-ops after terminal state", async () => {
  const now = "2026-08-31T20:00:00.000Z";
  const later = "2026-08-31T20:01:00.000Z";
  const clock = new MutableClock(new Date(now));
  const database = new MeshrDatabase({ path: ":memory:", clock, seed: false });
  const repository = new SqliteMeshrRepository(database, clock);
  const sessionHash = createHash("sha256").update("sqlite-noop-owner").digest("hex");

  try {
    const owner = await repository.createSocialAccount({
      provider: "google",
      subject: "sqlite-noop-owner",
      email: "sqlite-noop@example.test",
      displayName: "SQLite No-op Owner",
    });
    await repository.createHumanSession({
      tokenHash: sessionHash,
      accountId: owner.accountId,
      csrfToken: "sqlite-noop-csrf",
      createdAt: now,
      expiresAt: "2026-09-01T08:00:00.000Z",
      absoluteExpiresAt: "2026-09-07T20:00:00.000Z",
    });
    const providerBeforeNoop = database.sqlite.prepare(
      `SELECT created_at, last_seen_at FROM provider_identities
       WHERE provider = 'google' AND subject = 'sqlite-noop-owner'`,
    ).get() as { created_at: string; last_seen_at: string };
    await repository.linkProvider({
      accountId: owner.accountId,
      provider: "google",
      subject: "sqlite-noop-owner",
      email: "sqlite-noop@example.test",
      humanSessionHash: sessionHash,
      linkedAt: later,
    });
    assert.deepEqual(
      {
        ...database.sqlite.prepare(
          `SELECT created_at, last_seen_at FROM provider_identities
           WHERE provider = 'google' AND subject = 'sqlite-noop-owner'`,
        ).get(),
      },
      { ...providerBeforeNoop },
    );
    const meshId = "sqlite-noop-mesh";
    await repository.createMeshWithOwner({
      mesh: {
        meshId,
        ownerAccountId: owner.accountId,
        name: "No-op mesh",
        description: "Durable transition fixture",
        visibility: "private",
        admission: "approval",
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
        actingAccountId: owner.accountId,
        humanSessionHash: sessionHash,
      },
      topic: {
        topicId: "sqlite-noop-topic",
        meshId,
        name: "general",
        title: "General",
        description: "No-op fixture",
        tags: [],
        createdAt: now,
      },
      agentIds: [],
    });
    const agentId = "sqlite-noop-agent";
    const attention = { browse: "joined", rootPosts: "draft", replies: "draft" };
    database.sqlite.prepare(
      `INSERT INTO agents(
         id, owner_account_id, name, handle, tagline, interests_json,
         personality, attention_json, runtime, runtime_label, runtime_subject,
         public_key_pem, definition_digest, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentId,
      owner.accountId,
      "No-op Agent",
      "sqlite-noop-agent",
      "Keeps retries quiet",
      JSON.stringify(["testing"]),
      "careful",
      JSON.stringify(attention),
      "local",
      "SQLite",
      "sqlite:no-op",
      "fixture-public-key",
      "fixture-digest",
      now,
      now,
    );

    const agentNoop = await repository.upsertAgent({
      agentId,
      ownerAccountId: owner.accountId,
      name: "No-op Agent",
      handle: "sqlite-noop-agent",
      tagline: "Keeps retries quiet",
      interests: ["testing"],
      personality: "careful",
      attention,
      runtime: "local",
      runtimeLabel: "SQLite",
      runtimeSubject: "sqlite:no-op",
      publicKeyPem: "fixture-public-key",
      definitionDigest: "fixture-digest",
      createdAt: now,
      updatedAt: later,
      expectedUpdatedAt: now,
      actingAccountId: owner.accountId,
      humanSessionHash: sessionHash,
    });
    assert.deepEqual(agentNoop, { changed: false, updatedAt: now });
    assert.equal(
      database.sqlite.prepare("SELECT updated_at FROM agents WHERE id = ?").get(agentId)?.updated_at,
      now,
    );

    const governanceNoop = await repository.updateMeshGovernance({
      meshId,
      name: "No-op mesh",
      description: "Durable transition fixture",
      visibility: "private",
      admission: "approval",
      updatedAt: later,
      actingAccountId: owner.accountId,
      humanSessionHash: sessionHash,
      ...artifact("sqlite-governance-noop", meshId, sessionHash, later),
    });
    assert.equal(governanceNoop.updatedAt, now);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE event_id = ?")
        .get("sqlite-governance-noop-event")?.count,
      0,
    );

    const absentRemoval = await repository.upsertMeshAgentMembership({
      meshId,
      agentId,
      status: "removed",
      attentionPolicy: {},
      admissionProvenance: "invite",
      joinedAt: null,
      updatedAt: later,
      actingAccountId: owner.accountId,
      humanSessionHash: sessionHash,
      ...artifact("sqlite-absent-removal", meshId, sessionHash, later),
    });
    assert.equal(absentRemoval.changed, false);
    database.sqlite.prepare(
      `INSERT INTO mesh_agent_memberships(
         mesh_id, agent_id, status, attention_policy_json,
         admission_provenance, joined_at, updated_at
       ) VALUES(?, ?, 'left', ?, 'open', ?, ?)`,
    ).run(meshId, agentId, JSON.stringify(attention), now, now);
    const terminalRemoval = await repository.upsertMeshAgentMembership({
      meshId,
      agentId,
      status: "removed",
      attentionPolicy: {},
      admissionProvenance: "invite",
      joinedAt: null,
      updatedAt: later,
      actingAccountId: owner.accountId,
      humanSessionHash: sessionHash,
      ...artifact("sqlite-terminal-removal", meshId, sessionHash, later),
    });
    assert.equal(terminalRemoval.changed, false);
    const left = database.sqlite.prepare(
      `SELECT status, attention_policy_json, admission_provenance, updated_at
       FROM mesh_agent_memberships WHERE mesh_id = ? AND agent_id = ?`,
    ).get(meshId, agentId) as Record<string, unknown>;
    assert.deepEqual({ ...left }, {
      status: "left",
      attention_policy_json: JSON.stringify(attention),
      admission_provenance: "open",
      updated_at: now,
    });

    database.sqlite.prepare(
      "UPDATE mesh_agent_memberships SET status = 'pending' WHERE mesh_id = ? AND agent_id = ?",
    ).run(meshId, agentId);
    const pendingRemoval = await repository.upsertMeshAgentMembership({
      meshId,
      agentId,
      status: "removed",
      attentionPolicy: {},
      admissionProvenance: "invite",
      joinedAt: null,
      updatedAt: later,
      actingAccountId: owner.accountId,
      humanSessionHash: sessionHash,
      ...artifact("sqlite-pending-removal", meshId, sessionHash, later),
    });
    assert.equal(pendingRemoval.changed, true);
    const removed = database.sqlite.prepare(
      `SELECT status, attention_policy_json, admission_provenance, updated_at
       FROM mesh_agent_memberships WHERE mesh_id = ? AND agent_id = ?`,
    ).get(meshId, agentId) as Record<string, unknown>;
    assert.deepEqual({ ...removed }, {
      status: "removed",
      attention_policy_json: JSON.stringify(attention),
      admission_provenance: "open",
      updated_at: later,
    });

    const pairingId = "sqlite-noop-pairing";
    database.sqlite.prepare(
      `INSERT INTO pairings(
         id, code, secret_hash, runtime, runtime_label, external_subject,
         public_key_pem, status, owner_account_id, agent_id, created_at,
         expires_at, approved_at
       ) VALUES(?, 'NOOP-PAIR', 'fixture-secret', 'local', 'SQLite',
                'sqlite:no-op', 'fixture-public-key', 'approved', ?, ?, ?, ?, ?)`,
    ).run(pairingId, owner.accountId, agentId, now, "2026-09-01T20:00:00.000Z", now);
    database.sqlite.prepare(
      `INSERT INTO agent_sessions(
         token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
         session_id, runtime_kind, status, superseded_by, authority_epoch
       ) VALUES('sqlite-noop-token', ?, ?, ?, ?, ?, 'sqlite-noop-session',
                'local', 'active', NULL, 1)`,
    ).run(agentId, pairingId, now, "2026-09-01T20:00:00.000Z", now);
    database.sqlite.prepare(
      `INSERT INTO webmcp_grants(
         token_hash, human_session_hash, agent_id, created_at, expires_at,
         last_used_at, revoked_at, session_id, authority_epoch
       ) VALUES('sqlite-noop-grant', ?, ?, ?, ?, ?, NULL, 'sqlite-page-session', 2)`,
    ).run(sessionHash, agentId, now, "2026-09-01T20:00:00.000Z", now);

    const revokeArtifacts = artifact("sqlite-agent-revoke", meshId, sessionHash, later);
    const revoked = await repository.revokeAgent(
      agentId,
      later,
      revokeArtifacts.event,
      revokeArtifacts.audit,
      owner.accountId,
      sessionHash,
    );
    assert.deepEqual(revoked, {
      changed: true,
      bindings: 1,
      sessions: 1,
      pageGrants: 1,
      pairings: 1,
    });
    const repeated = await repository.revokeAgent(
      agentId,
      "2026-08-31T20:02:00.000Z",
      artifact("sqlite-agent-revoke-repeat", meshId, sessionHash, later).event,
      artifact("sqlite-agent-revoke-repeat", meshId, sessionHash, later).audit,
      owner.accountId,
      sessionHash,
    );
    assert.equal(repeated.changed, false);
    assert.equal(
      database.sqlite.prepare("SELECT expires_at FROM agent_sessions WHERE session_id = 'sqlite-noop-session'")
        .get()?.expires_at,
      later,
    );
    assert.equal(
      database.sqlite.prepare("SELECT revoked_at FROM webmcp_grants WHERE token_hash = 'sqlite-noop-grant'")
        .get()?.revoked_at,
      later,
    );
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE event_id = ?")
        .get("sqlite-agent-revoke-repeat-event")?.count,
      0,
    );

    const corruptAgentId = "sqlite-corrupt-binding-agent";
    database.sqlite.prepare(
      `INSERT INTO agents(
         id, owner_account_id, name, handle, tagline, interests_json,
         personality, attention_json, runtime, runtime_label, runtime_subject,
         public_key_pem, definition_digest, created_at, updated_at
       ) VALUES(?, ?, 'Corrupt Agent', 'sqlite-corrupt-agent', '', '[]', '', '{}',
                'local', 'SQLite', 'sqlite:corrupt', 'fixture-key', NULL, ?, ?)`,
    ).run(corruptAgentId, owner.accountId, now, now);
    for (const suffix of ["a", "b"]) {
      database.sqlite.prepare(
        `INSERT INTO pairings(
           id, code, secret_hash, runtime, runtime_label, external_subject,
           public_key_pem, status, owner_account_id, agent_id, created_at,
           expires_at, approved_at
         ) VALUES(?, ?, ?, 'local', 'SQLite', 'sqlite:corrupt', 'fixture-key',
                  'approved', ?, ?, ?, ?, ?)`,
      ).run(
        `sqlite-corrupt-pair-${suffix}`,
        `CORR-${suffix.toUpperCase()}`,
        `corrupt-secret-${suffix}`,
        owner.accountId,
        corruptAgentId,
        now,
        "2026-09-01T20:00:00.000Z",
        now,
      );
    }
    await assert.rejects(
      repository.revokeAgent(corruptAgentId, later),
      /agent_authority_corrupt/,
    );
    assert.equal(
      database.sqlite.prepare(
        `SELECT COUNT(*) AS count FROM pairings
         WHERE agent_id = ? AND status = 'approved'`,
      ).get(corruptAgentId)?.count,
      2,
    );
  } finally {
    database.close();
  }
});

test("SQLite mesh directory reads stay mesh-scoped and mark bounded rosters", async () => {
  const now = "2026-08-31T20:00:00.000Z";
  const clock = new MutableClock(new Date(now));
  const database = new MeshrDatabase({ path: ":memory:", clock, seed: false });
  const repository = new SqliteMeshrRepository(database, clock);
  try {
    const owner = await repository.createSocialAccount({
      provider: "google",
      subject: "directory-owner-google",
      email: "directory-owner@example.test",
      displayName: "Directory Owner",
    });
    const ownerSessionHash = createHash("sha256")
      .update("directory-owner-session")
      .digest("hex");
    await repository.createHumanSession({
      tokenHash: ownerSessionHash,
      accountId: owner.accountId,
      csrfToken: "directory-owner-csrf",
      createdAt: now,
      expiresAt: "2026-09-01T20:00:00.000Z",
      absoluteExpiresAt: "2026-09-01T20:00:00.000Z",
    });
    const meshId = "directory-private-mesh";
    await repository.createMeshWithOwner({
      mesh: {
        meshId,
        ownerAccountId: owner.accountId,
        name: "Bounded directory",
        description: "A deliberately oversized local roster",
        visibility: "private",
        admission: "invite_only",
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
        actingAccountId: owner.accountId,
        humanSessionHash: ownerSessionHash,
      },
      topic: {
        topicId: "directory-private-topic",
        meshId,
        name: "general",
        title: "General",
        description: "Directory fixture",
        tags: [],
        createdAt: now,
      },
      agentIds: [],
    });

    const insertAgent = database.sqlite.prepare(
      `INSERT INTO agents(
         id, owner_account_id, name, handle, tagline, interests_json,
         personality, attention_json, runtime, runtime_label, runtime_subject,
         public_key_pem, definition_digest, created_at, updated_at
       ) VALUES(?, ?, ?, ?, '', '[]', '', ?, 'local', '', ?, '', NULL, ?, ?)`,
    );
    const insertMember = database.sqlite.prepare(
      "INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
    );
    database.transaction(() => {
      for (let index = 0; index <= MAX_MESH_DETAIL_MEMBER_ROWS; index += 1) {
        const agentId = `directory-agent-${String(index).padStart(4, "0")}`;
        insertAgent.run(
          agentId,
          owner.accountId,
          `Directory Agent ${index}`,
          `directory-agent-${index}`,
          JSON.stringify({
            browse: "public",
            rootPosts: "draft",
            replies: "draft",
          }),
          `directory:${index}`,
          now,
          now,
        );
        insertMember.run(meshId, agentId, now);
      }
    });

    const entry = await repository.findMeshDirectoryEntryForAccount(
      meshId,
      owner.accountId,
    );
    assert.ok(entry);
    assert.equal(entry.memberAgentIds.length, MAX_MESH_DETAIL_MEMBER_ROWS);
    assert.equal(entry.truncated, true);
    assert.deepEqual(
      (await repository.listMeshDirectoryForAccount(owner.accountId)).map(
        (candidate) => candidate.mesh.meshId,
      ),
      [meshId],
    );

    const insertPublicMesh = database.sqlite.prepare(
      `INSERT INTO meshes(
         id, owner_account_id, name, description, visibility, join_policy,
         lifecycle, created_at, updated_at
       ) VALUES(?, ?, ?, '', 'public', 'open', 'active', ?, ?)`,
    );
    const insertTopic = database.sqlite.prepare(
      `INSERT INTO topics(
         id, mesh_id, name, title, description, tags_json, created_at
       ) VALUES(?, ?, ?, ?, '', '[]', ?)`,
    );
    const publicMeshId = "directory-public-000";
    database.transaction(() => {
      for (let index = 0; index <= MAX_MESH_DIRECTORY_ENTRIES; index += 1) {
        const candidateId = `directory-public-${String(index).padStart(3, "0")}`;
        insertPublicMesh.run(
          candidateId,
          owner.accountId,
          `Public ${String(index).padStart(3, "0")}`,
          now,
          now,
        );
      }
      for (let index = 0; index <= MAX_TOPICS_PER_MESH; index += 1) {
        const topicId = `directory-topic-${String(index).padStart(3, "0")}`;
        insertTopic.run(
          topicId,
          publicMeshId,
          `topic-${index}`,
          `Topic ${String(index).padStart(3, "0")}`,
          now,
        );
      }
    });
    const publicMeshes = await repository.listPublicMeshes();
    assert.equal(publicMeshes.meshes.length, MAX_MESH_DIRECTORY_ENTRIES);
    assert.equal(publicMeshes.truncated, true);
    const publicTopics = await repository.listPublicTopics(publicMeshId);
    assert.equal(publicTopics.topics.length, MAX_TOPICS_PER_MESH);
    assert.equal(publicTopics.truncated, true);

    const outsider = await repository.createSocialAccount({
      provider: "github",
      subject: "directory-outsider-github",
      email: "directory-outsider@example.test",
      displayName: "Directory Outsider",
    });
    assert.equal(
      await repository.findMeshDirectoryEntryForAccount(
        meshId,
        outsider.accountId,
      ),
      null,
    );
  } finally {
    database.close();
  }
});
