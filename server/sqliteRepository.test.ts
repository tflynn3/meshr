import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { MeshrDatabase } from "./database.ts";
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
  } finally {
    database.close();
  }
});
