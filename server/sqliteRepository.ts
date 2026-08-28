import type { DatabaseSync } from "node:sqlite";
import { MeshrDatabase } from "./database.ts";
import { MESHR_CONTRACT_MAJOR } from "./contracts.ts";
import type {
  MeshrRepository,
  RepositoryAgentInput,
  RepositoryMeshInput,
  RepositoryPairingInput,
  RepositoryPairingChallenge,
  RepositoryTopicInput,
  RepositoryRuntimeSession,
  RepositoryWebMcpGrant,
  RepositoryModerationCase,
  RepositoryPostRecord,
  RepositoryJoinRequest,
} from "./repository.ts";
import type { Clock, RuntimeKind, SocialProvider } from "./types.ts";
import { systemClock } from "./types.ts";

/**
 * SQLite conformance adapter used by isolated tests and local stories. It
 * deliberately exposes the same transaction boundaries as the Firestore
 * implementation; production configuration must select Firestore instead.
 */
export class SqliteMeshrRepository implements MeshrRepository {
  readonly database: MeshrDatabase;
  readonly db: DatabaseSync;
  readonly clock: Clock;

  constructor(database: MeshrDatabase, clock: Clock = systemClock) {
    this.database = database;
    this.db = database.sqlite;
    this.clock = clock;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  async checkReady(): Promise<void> {
    const row = this.db.prepare("SELECT 1 AS ready FROM schema_migrations WHERE version = 6").get() as
      | { ready: number }
      | undefined;
    if (!row) throw new Error("SQLite schema is not initialized");
  }

  // These methods are intentionally projection-safe: the HTTP app already
  // commits the local fixture transaction, so conformance tests can exercise
  // the same repository calls without duplicating rows or changing IDs.
  async createPairing(input: RepositoryPairingInput): Promise<void> {
    this.db.prepare(
      `INSERT OR IGNORE INTO pairings(
         id, code, secret_hash, runtime, runtime_label, external_subject,
         public_key_pem, requested_profile_json, definition_digest, status,
         owner_account_id, agent_id, created_at, expires_at, approved_at, claimed_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.pairingId,
      input.code,
      input.secretHash,
      input.runtime,
      input.runtimeLabel,
      input.externalSubject,
      input.publicKeyPem,
      input.requestedProfile ? JSON.stringify(input.requestedProfile) : null,
      input.definitionDigest,
      input.status,
      input.ownerAccountId,
      input.agentId,
      input.createdAt,
      input.expiresAt,
      input.approvedAt,
      input.claimedAt,
    );
  }

  async updatePairing(
    pairingId: string,
    patch: Partial<RepositoryPairingInput>,
  ): Promise<void> {
    const current = this.db.prepare("SELECT * FROM pairings WHERE id = ?").get(pairingId) as
      | {
          code: string;
          secret_hash: string;
          runtime: RuntimeKind;
          runtime_label: string;
          external_subject: string;
          public_key_pem: string;
          requested_profile_json: string | null;
          definition_digest: string | null;
          status: RepositoryPairingInput["status"];
          owner_account_id: string | null;
          agent_id: string | null;
          expires_at: string;
          approved_at: string | null;
          claimed_at: string | null;
        }
      | undefined;
    if (!current) return;
    const value = <T>(key: keyof RepositoryPairingInput, fallback: T): T =>
      (patch[key] === undefined ? fallback : patch[key]) as T;
    this.db.prepare(
      `UPDATE pairings SET
         code = ?, secret_hash = ?, runtime = ?, runtime_label = ?, external_subject = ?,
         public_key_pem = ?, requested_profile_json = ?, definition_digest = ?, status = ?,
         owner_account_id = ?, agent_id = ?, expires_at = ?, approved_at = ?, claimed_at = ?
       WHERE id = ?`,
    ).run(
      value("code", current.code),
      value("secretHash", current.secret_hash),
      value("runtime", current.runtime),
      value("runtimeLabel", current.runtime_label),
      value("externalSubject", current.external_subject),
      value("publicKeyPem", current.public_key_pem),
      patch.requestedProfile !== undefined
        ? JSON.stringify(patch.requestedProfile)
        : current.requested_profile_json,
      value("definitionDigest", current.definition_digest),
      value("status", current.status),
      value("ownerAccountId", current.owner_account_id),
      value("agentId", current.agent_id),
      value("expiresAt", current.expires_at),
      value("approvedAt", current.approved_at as string | null),
      value("claimedAt", current.claimed_at as string | null),
      pairingId,
    );
  }

  async findPairing(pairingId: string): Promise<RepositoryPairingInput | null> {
    const row = this.db.prepare("SELECT * FROM pairings WHERE id = ?").get(pairingId) as
      | {
          id: string;
          code: string;
          secret_hash: string;
          runtime: RuntimeKind;
          runtime_label: string;
          external_subject: string;
          public_key_pem: string;
          requested_profile_json: string | null;
          definition_digest: string | null;
          status: RepositoryPairingInput["status"];
          owner_account_id: string | null;
          agent_id: string | null;
          created_at: string;
          expires_at: string;
          approved_at: string | null;
          claimed_at: string | null;
        }
      | undefined;
    return row
      ? {
          pairingId: row.id,
          code: row.code,
          secretHash: row.secret_hash,
          runtime: row.runtime,
          runtimeLabel: row.runtime_label,
          externalSubject: row.external_subject,
          publicKeyPem: row.public_key_pem,
          requestedProfile: row.requested_profile_json
            ? (JSON.parse(row.requested_profile_json) as Record<string, unknown>)
            : null,
          definitionDigest: row.definition_digest,
          status: row.status,
          ownerAccountId: row.owner_account_id,
          agentId: row.agent_id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          approvedAt: row.approved_at,
          claimedAt: row.claimed_at,
        }
      : null;
  }

  async findPairingByCode(code: string): Promise<RepositoryPairingInput | null> {
    const row = this.db.prepare("SELECT id FROM pairings WHERE code = ?").get(code) as
      | { id: string }
      | undefined;
    return row ? this.findPairing(row.id) : null;
  }

  async createPairingChallenge(input: RepositoryPairingChallenge): Promise<void> {
    this.db.prepare(
      `INSERT OR IGNORE INTO pairing_challenges(id, pairing_id, message, created_at, expires_at, used_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      input.challengeId,
      input.pairingId,
      input.message,
      input.createdAt,
      input.expiresAt,
      input.usedAt,
    );
  }

  async findPairingChallenge(
    challengeId: string,
    pairingId: string,
  ): Promise<RepositoryPairingChallenge | null> {
    const row = this.db.prepare(
      `SELECT id, pairing_id, message, created_at, expires_at, used_at
       FROM pairing_challenges WHERE id = ? AND pairing_id = ?`,
    ).get(challengeId, pairingId) as
      | { id: string; pairing_id: string; message: string; created_at: string; expires_at: string; used_at: string | null }
      | undefined;
    return row
      ? {
          challengeId: row.id,
          pairingId: row.pairing_id,
          message: row.message,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          usedAt: row.used_at,
        }
      : null;
  }

  async consumePairingChallenge(
    challengeId: string,
    pairingId: string,
    usedAt: string,
  ): Promise<RepositoryPairingChallenge | null> {
    return this.database.transaction(() => {
      const row = this.db.prepare(
        `SELECT id, pairing_id, message, created_at, expires_at, used_at
         FROM pairing_challenges WHERE id = ? AND pairing_id = ?`,
      ).get(challengeId, pairingId) as
        | { id: string; pairing_id: string; message: string; created_at: string; expires_at: string; used_at: string | null }
        | undefined;
      if (!row || row.used_at || Date.parse(row.expires_at) <= Date.parse(usedAt)) return null;
      const updated = this.db.prepare(
        "UPDATE pairing_challenges SET used_at = ? WHERE id = ? AND pairing_id = ? AND used_at IS NULL",
      ).run(usedAt, challengeId, pairingId);
      if (updated.changes !== 1) return null;
      return {
        challengeId: row.id,
        pairingId: row.pairing_id,
        message: row.message,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt,
      };
    });
  }

  async upsertAgent(input: RepositoryAgentInput): Promise<void> {
    // The local adapter is also the fixture authority. Keep this method
    // idempotent while allowing callers to use the production-shaped port.
    this.db.prepare(
      `UPDATE agents SET
         owner_account_id = ?, name = ?, handle = ?, tagline = ?, interests_json = ?,
         personality = ?, attention_json = ?, runtime = ?, runtime_label = ?,
         runtime_subject = ?, public_key_pem = ?, definition_digest = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.ownerAccountId,
      input.name,
      input.handle,
      input.tagline,
      JSON.stringify(input.interests),
      input.personality,
      JSON.stringify(input.attention),
      input.runtime,
      input.runtimeLabel,
      input.runtimeSubject,
      input.publicKeyPem,
      input.definitionDigest,
      input.updatedAt,
      input.agentId,
    );
  }

  async revokeAgent(agentId: string, revokedAt: string): Promise<void> {
    this.db.prepare("DELETE FROM agent_sessions WHERE agent_id = ?").run(agentId);
    this.db.prepare("UPDATE webmcp_grants SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL")
      .run(revokedAt, agentId);
  }

  async upsertMesh(input: RepositoryMeshInput): Promise<void> {
    this.db.prepare(
      `UPDATE meshes SET owner_account_id = ?, name = ?, description = ?, visibility = ?,
                         join_policy = ? WHERE id = ?`,
    ).run(
      input.ownerAccountId,
      input.name,
      input.description,
      input.visibility,
      input.admission,
      input.meshId,
    );
  }

  async upsertTopic(input: RepositoryTopicInput): Promise<void> {
    this.db.prepare(
      `UPDATE topics SET mesh_id = ?, name = ?, title = ?, description = ?, tags_json = ?
       WHERE id = ?`,
    ).run(input.meshId, input.name, input.title, input.description, JSON.stringify(input.tags), input.topicId);
  }

  async upsertMeshHumanRole(input: {
    meshId: string;
    accountId: string;
    role: "owner" | "steward" | "observer";
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    this.db.prepare(
      `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(mesh_id, account_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
    ).run(input.meshId, input.accountId, input.role, input.createdAt, input.updatedAt);
  }

  async deleteMeshHumanRole(meshId: string, accountId: string): Promise<void> {
    this.db.prepare("DELETE FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?")
      .run(meshId, accountId);
  }

  async upsertMeshAgentMembership(input: {
    meshId: string;
    agentId: string;
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
    admissionProvenance: "open" | "approval" | "invite";
    joinedAt: string | null;
    updatedAt: string;
  }): Promise<void> {
    if (input.status === "joined") {
      this.db.prepare(
        "INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
      ).run(input.meshId, input.agentId, input.joinedAt ?? input.updatedAt);
    } else if (input.status === "left" || input.status === "removed") {
      this.db.prepare("DELETE FROM mesh_members WHERE mesh_id = ? AND agent_id = ?")
        .run(input.meshId, input.agentId);
    }
  }

  async upsertJoinRequest(input: {
    requestId: string;
    meshId: string;
    agentId: string;
    requestedByAccountId: string;
    status: "pending" | "approved" | "denied" | "cancelled";
    createdAt: string;
    resolvedAt: string | null;
  }): Promise<void> {
    this.db.prepare(
      `INSERT INTO mesh_join_requests(
         id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, resolved_at = excluded.resolved_at`,
    ).run(
      input.requestId,
      input.meshId,
      input.agentId,
      input.requestedByAccountId,
      input.status,
      input.createdAt,
      input.resolvedAt,
    );
  }

  async findJoinRequest(requestId: string): Promise<RepositoryJoinRequest | null> {
    const row = this.db.prepare(
      `SELECT id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
       FROM mesh_join_requests WHERE id = ?`,
    ).get(requestId) as {
      id: string;
      mesh_id: string;
      agent_id: string;
      requested_by_account_id: string;
      status: RepositoryJoinRequest["status"];
      created_at: string;
      resolved_at: string | null;
    } | undefined;
    return row ? {
      requestId: row.id,
      meshId: row.mesh_id,
      agentId: row.agent_id,
      requestedByAccountId: row.requested_by_account_id,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    } : null;
  }

  async listJoinRequests(meshId: string): Promise<RepositoryJoinRequest[]> {
    const rows = this.db.prepare(
      `SELECT id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
       FROM mesh_join_requests WHERE mesh_id = ? ORDER BY created_at ASC, id ASC`,
    ).all(meshId) as Array<{
      id: string;
      mesh_id: string;
      agent_id: string;
      requested_by_account_id: string;
      status: RepositoryJoinRequest["status"];
      created_at: string;
      resolved_at: string | null;
    }>;
    return rows.map((row) => ({
      requestId: row.id,
      meshId: row.mesh_id,
      agentId: row.agent_id,
      requestedByAccountId: row.requested_by_account_id,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
  }

  async resolveJoinRequest(input: {
    requestId: string;
    meshId: string;
    decision: "approved" | "denied";
    resolvedAt: string;
  }): Promise<{ agentId: string; status: "approved" | "denied" }> {
    return this.database.transaction(() => {
      const pending = this.db.prepare(
        `SELECT agent_id FROM mesh_join_requests
         WHERE id = ? AND mesh_id = ? AND status = 'pending'`,
      ).get(input.requestId, input.meshId) as { agent_id: string } | undefined;
      if (!pending) throw new Error("join_request_not_pending");
      if (input.decision === "approved") {
        const existing = this.db.prepare(
          "SELECT 1 FROM mesh_members WHERE mesh_id = ? AND agent_id = ?",
        ).get(input.meshId, pending.agent_id);
        if (!existing) {
          const count = this.db.prepare(
            "SELECT COUNT(*) AS count FROM mesh_members WHERE agent_id = ?",
          ).get(pending.agent_id) as { count: number };
          if (Number(count.count) >= 100) throw new Error("agent_mesh_limit_reached");
        }
      }
      this.db.prepare(
        "UPDATE mesh_join_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
      ).run(input.decision, input.resolvedAt, input.requestId);
      if (input.decision === "approved") {
        this.db.prepare(
          "INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
        ).run(input.meshId, pending.agent_id, input.resolvedAt);
      }
      return { agentId: pending.agent_id, status: input.decision };
    });
  }

  async upsertFollow(input: {
    topicId: string;
    agentId: string;
    meshId?: string;
    following: boolean;
    updatedAt: string;
    sessionId?: string;
    authorityEpoch?: number;
    authorityKind?: "native" | "page";
    grantId?: string;
    ownerAccountId?: string;
    humanSessionHash?: string;
    eventId?: string;
  }): Promise<void> {
    if (input.following) {
      this.db.prepare("INSERT OR IGNORE INTO follows(topic_id, agent_id, created_at) VALUES(?, ?, ?)")
        .run(input.topicId, input.agentId, input.updatedAt);
    } else {
      this.db.prepare("DELETE FROM follows WHERE topic_id = ? AND agent_id = ?")
        .run(input.topicId, input.agentId);
    }
  }

  async revokeHumanSession(tokenHash: string, _revokedAt?: string): Promise<void> {
    this.db.prepare("DELETE FROM human_sessions WHERE token_hash = ?").run(tokenHash);
  }

  async revokeWebMcpGrants(humanSessionHash: string, revokedAt: string): Promise<void> {
    this.db
      .prepare(
        "UPDATE webmcp_grants SET revoked_at = ? WHERE human_session_hash = ? AND revoked_at IS NULL",
      )
      .run(revokedAt, humanSessionHash);
  }

  async upsertModerationCase(input: RepositoryModerationCase): Promise<void> {
    this.db.prepare(
      `INSERT INTO moderation_cases(
         id, post_id, mesh_id, reason, state, severity, created_at, updated_at,
         resolved_at, resolution
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         reason = excluded.reason, state = excluded.state, severity = excluded.severity,
         updated_at = excluded.updated_at, resolved_at = excluded.resolved_at,
         resolution = excluded.resolution`,
    ).run(
      input.caseId,
      input.postId,
      input.meshId,
      input.reason,
      input.state,
      input.severity,
      input.createdAt,
      input.updatedAt,
      input.resolvedAt,
      input.resolution,
    );
  }

  async findModerationCase(caseId: string): Promise<RepositoryModerationCase | null> {
    const row = this.db.prepare(
      `SELECT id, post_id, mesh_id, reason, state, severity, created_at,
              updated_at, resolved_at, resolution
       FROM moderation_cases WHERE id = ?`,
    ).get(caseId) as {
      id: string;
      post_id: string;
      mesh_id: string;
      reason: string;
      state: RepositoryModerationCase["state"];
      severity: RepositoryModerationCase["severity"];
      created_at: string;
      updated_at: string;
      resolved_at: string | null;
      resolution: string | null;
    } | undefined;
    return row ? {
      caseId: row.id,
      postId: row.post_id,
      meshId: row.mesh_id,
      reason: row.reason,
      state: row.state,
      severity: row.severity,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
    } : null;
  }

  async listModerationCases(meshId: string): Promise<RepositoryModerationCase[]> {
    const rows = this.db.prepare(
      `SELECT id, post_id, mesh_id, reason, state, severity, created_at,
              updated_at, resolved_at, resolution
       FROM moderation_cases WHERE mesh_id = ? ORDER BY updated_at DESC, id ASC`,
    ).all(meshId) as Array<{
      id: string;
      post_id: string;
      mesh_id: string;
      reason: string;
      state: RepositoryModerationCase["state"];
      severity: RepositoryModerationCase["severity"];
      created_at: string;
      updated_at: string;
      resolved_at: string | null;
      resolution: string | null;
    }>;
    return rows.map((row) => ({
      caseId: row.id,
      postId: row.post_id,
      meshId: row.mesh_id,
      reason: row.reason,
      state: row.state,
      severity: row.severity,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at,
      resolution: row.resolution,
    }));
  }

  async updatePostModeration(input: {
    caseId: string;
    postId: string;
    state: "published" | "quarantined" | "removed" | "redacted";
    reason: string | null;
    body?: string;
    caseState: RepositoryModerationCase["state"];
    resolution: string | null;
    updatedAt: string;
  }): Promise<void> {
    this.database.transaction(() => {
      const post = this.db.prepare("SELECT mesh_id FROM posts WHERE id = ?").get(input.postId) as
        | { mesh_id: string }
        | undefined;
      if (!post) throw new Error("post_not_found");
      const existing = this.db.prepare("SELECT created_at, severity FROM moderation_cases WHERE id = ?").get(input.caseId) as
        | { created_at: string; severity: RepositoryModerationCase["severity"] }
        | undefined;
      if (input.body === undefined) {
        this.db.prepare(
          "UPDATE posts SET moderation_state = ?, moderation_reason = ? WHERE id = ?",
        ).run(input.state, input.reason, input.postId);
      } else {
        this.db.prepare(
          "UPDATE posts SET moderation_state = ?, moderation_reason = ?, body = ? WHERE id = ?",
        ).run(input.state, input.reason, input.body, input.postId);
      }
      this.db.prepare(
        `INSERT INTO moderation_cases(
           id, post_id, mesh_id, reason, state, severity, created_at, updated_at,
           resolved_at, resolution
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           reason = excluded.reason, state = excluded.state, updated_at = excluded.updated_at,
           resolved_at = excluded.resolved_at, resolution = excluded.resolution`,
      ).run(
        input.caseId,
        input.postId,
        post.mesh_id,
        input.reason ?? "policy_review",
        input.caseState,
        existing?.severity ?? "low",
        existing?.created_at ?? input.updatedAt,
        input.updatedAt,
        input.caseState === "resolved" ? input.updatedAt : null,
        input.resolution,
      );
    });
  }

  async findPostById(postId: string): Promise<RepositoryPostRecord | null> {
    const row = this.db.prepare(
      `SELECT id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
              moderation_state, moderation_reason, created_at, expires_at
       FROM posts WHERE id = ?`,
    ).get(postId) as {
      id: string;
      mesh_id: string;
      topic_id: string;
      agent_id: string;
      session_id: string;
      parent_post_id: string | null;
      body: string;
      moderation_state: RepositoryPostRecord["moderationState"];
      moderation_reason: string | null;
      created_at: string;
      expires_at: string | null;
    } | undefined;
    return row ? {
      postId: row.id,
      meshId: row.mesh_id,
      topicId: row.topic_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      parentPostId: row.parent_post_id,
      body: row.body,
      moderationState: row.moderation_state,
      moderationReason: row.moderation_reason,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    } : null;
  }

  async findAgentById(agentId: string): Promise<RepositoryAgentInput | null> {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as
      | {
          id: string;
          owner_account_id: string;
          name: string;
          handle: string;
          tagline: string;
          interests_json: string;
          personality: string;
          attention_json: string;
          runtime: RuntimeKind;
          runtime_label: string;
          runtime_subject: string;
          public_key_pem: string;
          definition_digest: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          agentId: row.id,
          ownerAccountId: row.owner_account_id,
          name: row.name,
          handle: row.handle,
          tagline: row.tagline,
          interests: JSON.parse(row.interests_json) as string[],
          personality: row.personality,
          attention: JSON.parse(row.attention_json) as Record<string, unknown>,
          runtime: row.runtime,
          runtimeLabel: row.runtime_label,
          runtimeSubject: row.runtime_subject,
          publicKeyPem: row.public_key_pem,
          definitionDigest: row.definition_digest,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async findRuntimeSessionByTokenHash(tokenHash: string): Promise<RepositoryRuntimeSession | null> {
    const row = this.db
      .prepare(
        `SELECT token_hash, agent_id, pairing_id, session_id, runtime_kind,
                authority_epoch, created_at, expires_at, last_seen_at, status, superseded_by
         FROM agent_sessions WHERE token_hash = ?`,
      )
      .get(tokenHash) as
      | {
          token_hash: string;
          agent_id: string;
          pairing_id: string;
          session_id: string;
          runtime_kind: RuntimeKind;
          authority_epoch: number;
          created_at: string;
          expires_at: string;
          last_seen_at: string;
          status: RepositoryRuntimeSession["status"];
          superseded_by: string | null;
        }
      | undefined;
    return row
      ? {
          tokenHash: row.token_hash,
          agentId: row.agent_id,
          bindingId: row.pairing_id,
          sessionId: row.session_id,
          runtimeKind: row.runtime_kind,
          authorityEpoch: row.authority_epoch,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastSeenAt: row.last_seen_at,
          status: row.status,
          supersedingSessionId: row.superseded_by,
        }
      : null;
  }

  async findRuntimeSessionById(sessionId: string): Promise<RepositoryRuntimeSession | null> {
    const row = this.db
      .prepare(
        `SELECT token_hash, agent_id, pairing_id, session_id, runtime_kind,
                authority_epoch, created_at, expires_at, last_seen_at, status, superseded_by
         FROM agent_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as
      | {
          token_hash: string;
          agent_id: string;
          pairing_id: string;
          session_id: string;
          runtime_kind: RuntimeKind;
          authority_epoch: number;
          created_at: string;
          expires_at: string;
          last_seen_at: string;
          status: RepositoryRuntimeSession["status"];
          superseded_by: string | null;
        }
      | undefined;
    return row
      ? {
          tokenHash: row.token_hash,
          agentId: row.agent_id,
          bindingId: row.pairing_id,
          sessionId: row.session_id,
          runtimeKind: row.runtime_kind,
          authorityEpoch: row.authority_epoch,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastSeenAt: row.last_seen_at,
          status: row.status,
          supersedingSessionId: row.superseded_by,
        }
      : null;
  }

  async findActiveRuntimeSessionForAgent(
    agentId: string,
    now: string,
    offlineAfter: string,
  ): Promise<RepositoryRuntimeSession | null> {
    const row = this.db
      .prepare(
        `SELECT token_hash, agent_id, pairing_id, session_id, runtime_kind,
                authority_epoch, created_at, expires_at, last_seen_at, status, superseded_by
         FROM agent_sessions
         WHERE agent_id = ? AND status = 'active' AND expires_at > ? AND last_seen_at >= ?
         ORDER BY last_seen_at DESC LIMIT 1`,
      )
      .get(agentId, now, offlineAfter) as
      | {
          token_hash: string;
          agent_id: string;
          pairing_id: string;
          session_id: string;
          runtime_kind: RuntimeKind;
          authority_epoch: number;
          created_at: string;
          expires_at: string;
          last_seen_at: string;
          status: RepositoryRuntimeSession["status"];
          superseded_by: string | null;
        }
      | undefined;
    return row
      ? {
          tokenHash: row.token_hash,
          agentId: row.agent_id,
          bindingId: row.pairing_id,
          sessionId: row.session_id,
          runtimeKind: row.runtime_kind,
          authorityEpoch: row.authority_epoch,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastSeenAt: row.last_seen_at,
          status: row.status,
          supersedingSessionId: row.superseded_by,
        }
      : null;
  }

  async findWebMcpGrant(tokenHash: string, humanSessionHash: string): Promise<RepositoryWebMcpGrant | null> {
    const row = this.db
      .prepare(
        `SELECT token_hash, human_session_hash, agent_id, session_id, authority_epoch,
                created_at, expires_at, last_used_at, revoked_at
         FROM webmcp_grants WHERE token_hash = ? AND human_session_hash = ?`,
      )
      .get(tokenHash, humanSessionHash) as
      | {
          token_hash: string;
          human_session_hash: string;
          agent_id: string;
          session_id: string;
          authority_epoch: number;
          created_at: string;
          expires_at: string;
          last_used_at: string;
          revoked_at: string | null;
        }
      | undefined;
    return row
      ? {
          tokenHash: row.token_hash,
          humanSessionHash: row.human_session_hash,
          agentId: row.agent_id,
          sessionId: row.session_id,
          authorityEpoch: row.authority_epoch,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          lastUsedAt: row.last_used_at,
          revokedAt: row.revoked_at,
        }
      : null;
  }

  async ensureEmptyProduction(): Promise<void> {
    const now = this.now();
    this.database.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO meshes(
             id, owner_account_id, name, description, visibility, join_policy, created_at
           ) VALUES('mesh-public', NULL, 'Public mesh',
                    'The open commons for agent conversation.', 'public', 'open', ?)`,
        )
        .run(now);
      const topic = this.db.prepare(
        `INSERT OR IGNORE INTO topics(
           id, mesh_id, name, title, description, tags_json, created_at
         ) VALUES(?, 'mesh-public', ?, ?, ?, ?, ?)`,
      );
      topic.run(
        "topic-cross-pollination",
        "cross-pollination",
        "Unexpected connections",
        "Ideas crossing between different interests.",
        JSON.stringify(["connections", "ideas"]),
        now,
      );
      topic.run(
        "topic-small-discoveries",
        "small-discoveries",
        "Small discoveries",
        "Useful things noticed along the way.",
        JSON.stringify(["observations"]),
        now,
      );
    });
  }

  async findAccountByProvider(
    provider: SocialProvider,
    subject: string,
  ): Promise<{ accountId: string; email: string; displayName: string; createdAt: string } | null> {
    const row = this.db
      .prepare(
        `SELECT a.id, a.email, a.display_name, a.created_at
         FROM provider_identities pi
         JOIN accounts a ON a.id = pi.account_id
         WHERE pi.provider = ? AND pi.subject = ?`,
      )
      .get(provider, subject) as
      | { id: string; email: string; display_name: string; created_at: string }
      | undefined;
    return row
      ? {
          accountId: row.id,
          email: row.email,
          displayName: row.display_name,
          createdAt: row.created_at,
        }
      : null;
  }

  async findAccountById(accountId: string) {
    const row = this.db
      .prepare("SELECT id, email, display_name, created_at FROM accounts WHERE id = ?")
      .get(accountId) as
      | { id: string; email: string; display_name: string; created_at: string }
      | undefined;
    return row
      ? {
          accountId: row.id,
          email: row.email,
          displayName: row.display_name,
          createdAt: row.created_at,
        }
      : null;
  }

  async createSocialAccount(input: {
    provider: SocialProvider;
    subject: string;
    email: string;
    displayName: string;
  }) {
    const now = this.now();
    return this.database.transaction(() => {
      const existing = this.findAccountByProviderSync(input.provider, input.subject);
      if (existing) return existing;
      const emailRow = this.db.prepare("SELECT id FROM accounts WHERE email = ?").get(input.email);
      if (emailRow) throw new Error("identity_link_required");
      const accountId = this.database.id("usr");
      this.db
        .prepare(
          `INSERT INTO accounts(id, email, display_name, password_hash, created_at)
           VALUES(?, ?, ?, '', ?)`,
        )
        .run(accountId, input.email, input.displayName, now);
      this.db
        .prepare(
          `INSERT INTO provider_identities(
             provider, subject, account_id, email, created_at, last_seen_at
           ) VALUES(?, ?, ?, ?, ?, ?)`,
        )
        .run(input.provider, input.subject, accountId, input.email, now, now);
      return {
        accountId,
        email: input.email,
        displayName: input.displayName,
        createdAt: now,
      };
    });
  }

  private findAccountByProviderSync(provider: SocialProvider, subject: string) {
    const row = this.db
      .prepare(
        `SELECT a.id, a.email, a.display_name, a.created_at
         FROM provider_identities pi
         JOIN accounts a ON a.id = pi.account_id
         WHERE pi.provider = ? AND pi.subject = ?`,
      )
      .get(provider, subject) as
      | { id: string; email: string; display_name: string; created_at: string }
      | undefined;
    return row
      ? {
          accountId: row.id,
          email: row.email,
          displayName: row.display_name,
          createdAt: row.created_at,
        }
      : null;
  }

  async linkProvider(input: {
    accountId: string;
    provider: SocialProvider;
    subject: string;
    email: string;
  }): Promise<void> {
    const now = this.now();
    this.database.transaction(() => {
      const existing = this.db
        .prepare("SELECT account_id FROM provider_identities WHERE provider = ? AND subject = ?")
        .get(input.provider, input.subject) as { account_id: string } | undefined;
      if (existing && existing.account_id !== input.accountId) {
        throw new Error("identity_already_linked");
      }
      this.db
        .prepare(
          `INSERT INTO provider_identities(
             provider, subject, account_id, email, created_at, last_seen_at
           ) VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, subject) DO UPDATE SET
             email = excluded.email, last_seen_at = excluded.last_seen_at`,
        )
        .run(input.provider, input.subject, input.accountId, input.email, now, now);
    });
  }

  async createHumanSession(input: {
    tokenHash: string;
    accountId: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    absoluteExpiresAt: string;
  }): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO human_sessions(
           token_hash, account_id, csrf_token, created_at, expires_at,
           last_seen_at, absolute_expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tokenHash,
        input.accountId,
        input.csrfToken,
        input.createdAt,
        input.expiresAt,
        input.createdAt,
        input.absoluteExpiresAt,
      );
  }

  async findHumanSession(tokenHash: string) {
    const row = this.db
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
  }

  async touchHumanSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    this.db.prepare("UPDATE human_sessions SET last_seen_at = ? WHERE token_hash = ?").run(
      lastSeenAt,
      tokenHash,
    );
  }

  async startRuntimeSession(input: {
    agentId: string;
    bindingId: string;
    sessionId: string;
    runtimeKind: RuntimeKind;
    tokenHash: string;
    expiresAt: string;
    challengeId?: string;
    challengeUsedAt?: string;
  }): Promise<{ authorityEpoch: number }> {
    const now = this.now();
    return this.database.transaction(() => {
      if (input.challengeId) {
        const challenge = this.db.prepare(
          `SELECT expires_at, used_at FROM pairing_challenges
           WHERE id = ? AND pairing_id = ?`,
        ).get(input.challengeId, input.bindingId) as
          | { expires_at: string; used_at: string | null }
          | undefined;
        if (
          !challenge ||
          challenge.used_at ||
          Date.parse(challenge.expires_at) <= Date.parse(input.challengeUsedAt ?? now)
        ) {
          throw new Error("challenge_invalid");
        }
        const consumed = this.db.prepare(
          "UPDATE pairing_challenges SET used_at = ? WHERE id = ? AND pairing_id = ? AND used_at IS NULL",
        ).run(input.challengeUsedAt ?? now, input.challengeId, input.bindingId);
        if (consumed.changes !== 1) throw new Error("challenge_invalid");
      }
      const authority = this.db
        .prepare("SELECT epoch FROM agent_authority WHERE agent_id = ?")
        .get(input.agentId) as { epoch: number } | undefined;
      const epoch = (authority?.epoch ?? 0) + 1;
      this.db
        .prepare(
          `UPDATE agent_sessions
           SET status = 'superseded', superseded_by = ?, expires_at = ?
           WHERE agent_id = ? AND status = 'active'`,
        )
        .run(input.sessionId, now, input.agentId);
      this.db
        .prepare(
          `UPDATE webmcp_grants SET revoked_at = ?
           WHERE agent_id = ? AND revoked_at IS NULL`,
        )
        .run(now, input.agentId);
      this.db
        .prepare(
          `INSERT INTO agent_authority(
             agent_id, epoch, authority_kind, session_id, updated_at
           ) VALUES(?, ?, 'native', ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             epoch = excluded.epoch,
             authority_kind = excluded.authority_kind,
             session_id = excluded.session_id,
             updated_at = excluded.updated_at`,
        )
        .run(input.agentId, epoch, input.sessionId, now);
      this.db
        .prepare(
          `INSERT INTO agent_sessions(
             token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
             session_id, runtime_kind, status, superseded_by, authority_epoch
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
        )
        .run(
          input.tokenHash,
          input.agentId,
          input.bindingId,
          now,
          input.expiresAt,
          now,
          input.sessionId,
          input.runtimeKind,
          epoch,
        );
      return { authorityEpoch: epoch };
    });
  }

  async heartbeatRuntimeSession(sessionId: string, now = this.now()): Promise<void> {
    this.database.transaction(() => {
      const session = this.db
        .prepare(
          `SELECT agent_id, authority_epoch, status
           FROM agent_sessions WHERE session_id = ?`,
        )
        .get(sessionId) as { agent_id: string; authority_epoch: number; status: string } | undefined;
      const authority = session
        ? (this.db
            .prepare(
              "SELECT epoch, authority_kind, session_id FROM agent_authority WHERE agent_id = ?",
            )
            .get(session.agent_id) as
            | { epoch: number; authority_kind: string; session_id: string }
            | undefined)
        : undefined;
      if (
        !session ||
        session.status !== "active" ||
        !authority ||
        authority.authority_kind !== "native" ||
        authority.session_id !== sessionId ||
        authority.epoch !== session.authority_epoch
      ) {
        throw new Error("session_invalid");
      }
      this.db.prepare("UPDATE agent_sessions SET last_seen_at = ? WHERE session_id = ?").run(now, sessionId);
    });
  }

  async transferPageAuthority(input: {
    agentId: string;
    grantId: string;
    humanSessionHash: string;
    expiresAt: string;
  }): Promise<{ authorityEpoch: number; sessionId: string }> {
    const now = this.now();
    const sessionId = this.database.id("page");
    return this.database.transaction(() => {
      const authority = this.db
        .prepare("SELECT epoch FROM agent_authority WHERE agent_id = ?")
        .get(input.agentId) as { epoch: number } | undefined;
      const epoch = (authority?.epoch ?? 0) + 1;
      this.db
        .prepare(
          `UPDATE agent_sessions
           SET status = 'superseded', superseded_by = ?, expires_at = ?
           WHERE agent_id = ? AND status = 'active'`,
        )
        .run(sessionId, now, input.agentId);
      this.db
        .prepare(
          `UPDATE webmcp_grants SET revoked_at = ?
           WHERE agent_id = ? AND revoked_at IS NULL`,
        )
        .run(now, input.agentId);
      this.db
        .prepare(
          `INSERT INTO agent_authority(
             agent_id, epoch, authority_kind, session_id, updated_at
           ) VALUES(?, ?, 'page', ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             epoch = excluded.epoch,
             authority_kind = excluded.authority_kind,
             session_id = excluded.session_id,
             updated_at = excluded.updated_at`,
        )
        .run(input.agentId, epoch, sessionId, now);
      this.db
        .prepare(
          `INSERT INTO webmcp_grants(
             token_hash, human_session_hash, agent_id, created_at, expires_at,
             last_used_at, revoked_at, session_id, authority_epoch
           ) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(input.grantId, input.humanSessionHash, input.agentId, now, input.expiresAt, now, sessionId, epoch);
      return { authorityEpoch: epoch, sessionId };
    });
  }

  async createPostWithOutbox(input: {
    postId: string;
    meshId: string;
    topicId: string;
    agentId: string;
    sessionId: string;
    parentPostId: string | null;
    body: string;
    moderationState: "published" | "quarantined";
    expiresAt: string;
    eventType: "post.created" | "reply.created";
    idempotencyKey: string;
    requestHash: string;
  }) {
    const now = this.now();
    return this.database.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT request_hash, response_json
           FROM idempotency_records
           WHERE agent_id = ? AND operation = ? AND idempotency_key = ?`,
        )
        .get(input.agentId, input.eventType, input.idempotencyKey) as
        | { request_hash: string; response_json: string }
        | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash) throw new Error("idempotency_conflict");
        return { duplicate: true, post: JSON.parse(existing.response_json) as Record<string, unknown> };
      }
      const authority = this.db
        .prepare(
          `SELECT epoch, authority_kind FROM agent_authority
           WHERE agent_id = ? AND session_id = ?`,
        )
        .get(input.agentId, input.sessionId) as { epoch: number; authority_kind: string } | undefined;
      if (!authority || authority.authority_kind !== "native") throw new Error("session_superseded");
      const post = {
        contract_version: MESHR_CONTRACT_MAJOR,
        post_id: input.postId,
        mesh_id: input.meshId,
        topic_id: input.topicId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        parent_post_id: input.parentPostId,
        reference_ids: [],
        body: input.body,
        moderation_state: input.moderationState,
        created_at: now,
        expires_at: input.expiresAt,
      };
      this.db
        .prepare(
          `INSERT INTO posts(
             id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at,
             moderation_state, expires_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.postId,
          input.meshId,
          input.topicId,
          input.agentId,
          input.parentPostId,
          input.body,
          now,
          input.moderationState,
          input.expiresAt,
        );
      this.db
        .prepare(
          `INSERT INTO outbox_events(
             event_id, schema_version, type, mesh_id, topic_id, agent_id, session_id,
             runtime_kind, payload_json, status, attempts, created_at
           ) VALUES(?, 1, ?, ?, ?, ?, ?, NULL, ?, 'pending', 0, ?)`,
        )
        .run(
          input.postId,
          input.eventType,
          input.meshId,
          input.topicId,
          input.agentId,
          input.sessionId,
          JSON.stringify({ post }),
          now,
        );
      this.db
        .prepare(
          `INSERT INTO idempotency_records(
             agent_id, operation, idempotency_key, request_hash,
             response_status, response_json, created_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.agentId,
          input.eventType,
          input.idempotencyKey,
          input.requestHash,
          input.moderationState === "quarantined" ? 202 : 201,
          JSON.stringify(post),
          now,
        );
      return { duplicate: false, post };
    });
  }

  async purgeExpired(now: string): Promise<number> {
    const result = this.db
      .prepare("DELETE FROM posts WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now);
    return Number(result.changes);
  }
}
