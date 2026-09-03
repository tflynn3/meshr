import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CURRENT_SCHEMA_VERSION, MeshrDatabase } from "./database.ts";
import { MESHR_CONTRACT_MAJOR } from "./contracts.ts";
import {
  MAX_ACTIVITY_PREFERENCES_PER_ACCOUNT,
  MAX_MESH_DETAIL_MEMBER_ROWS,
  MAX_MESH_DETAIL_ROLE_ROWS,
  MAX_MESH_DIRECTORY_ENTRIES,
  MAX_MESH_DIRECTORY_MEMBER_ROWS,
  MAX_MESH_DIRECTORY_ROLE_ROWS,
  MAX_MESH_DIRECTORY_TOPIC_ROWS,
  MAX_TOPICS_PER_MESH,
} from "./repository.ts";
import type {
  MeshrRepository,
  RepositoryAgentInput,
  RepositoryProfileReloadResult,
  RepositoryProfileReviewProposal,
  RepositoryMeshInput,
  RepositoryMeshGovernancePatch,
  RepositoryPairingInput,
  RepositoryPairingChallenge,
  RepositoryTopicInput,
  RepositoryTopicCreateInput,
  RepositoryTopicUpdateInput,
  RepositoryTopicDeleteInput,
  RepositoryAgentTopic,
  RepositoryMeshDirectoryEntry,
  RepositoryPublicMeshDirectory,
  RepositoryPublicTopicDirectory,
  RepositoryRuntimeSession,
  RepositoryWebMcpGrant,
  RepositoryBrowserAgentGrant,
  RepositoryCreateBrowserAgentInput,
  RepositoryCreateBrowserAgentResult,
  RepositoryAgentRevocationResult,
  RepositoryModerationCase,
  RepositoryModerationCasesPage,
  RepositoryModerationMutationResult,
  RepositoryPostRecord,
  RepositoryTopicPostsPage,
  RepositoryJoinRequest,
  RepositoryMeshInvitation,
  RepositoryMeshRoleInvitation,
  RepositoryHumanActivityPreference,
  RepositoryHumanActivityPreferencePatch,
  RepositoryMutationArtifacts,
  RepositoryEventInput,
  RepositoryOutboxClaim,
  RepositoryOutboxCompletion,
  RepositoryOutboxCompletionResult,
  RepositoryOutboxHealth,
  RepositoryAuditInput,
  RepositoryAgentActivityRecord,
  RepositoryAgentActivityPage,
} from "./repository.ts";
import type { Clock, RuntimeKind, SocialProvider } from "./types.ts";
import { publicRuntimeKind } from "./types.ts";
import { constantTimeStringEqual, hmacSha256 } from "./security.ts";
import { requireJoinCapableAttentionPolicy } from "./attentionPolicy.ts";
import type { RepositoryPostInput } from "./firestoreRepository.ts";

const HUMAN_IDLE_SECONDS = 12 * 60 * 60;
const PAGE_AUTHORITY_GRANT_SECONDS = 60 * 60;
const NEW_IDENTITY_REVIEW_POSTS = 5;
const NEW_IDENTITY_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MODERATION_IDEMPOTENCY_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const BROWSER_AGENT_IDEMPOTENCY_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * SQLite conformance adapter used by isolated tests and local stories. It
 * deliberately exposes the same transaction boundaries as the Firestore
 * implementation; production configuration must select Firestore instead.
 */
export class SqliteMeshrRepository implements MeshrRepository {
  readonly database: MeshrDatabase;
  readonly db: DatabaseSync;
  readonly clock: Clock;
  private readonly invitationPepper: string;

  constructor(database: MeshrDatabase, clock: Clock = database.clock) {
    this.database = database;
    this.db = database.sqlite;
    this.clock = clock;
    this.invitationPepper = process.env.MESHR_INVITATION_PEPPER?.trim() ||
      "meshr-local-invitation-pepper";
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private writeMutationArtifacts(artifacts: RepositoryMutationArtifacts): void {
    if (artifacts.event) {
      const event = artifacts.event;
      this.db.prepare(
        `INSERT OR IGNORE INTO outbox_events(
           event_id, schema_version, type, mesh_id, topic_id, agent_id, session_id,
           runtime_kind, payload_json, status, attempts, created_at
         ) VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      ).run(
        event.eventId,
        event.type,
        event.meshId,
        event.topicId,
        event.agentId,
        event.sessionId,
        event.runtimeKind,
        JSON.stringify(event.payload),
        event.occurredAt,
      );
    }
    if (artifacts.audit) {
      const audit = artifacts.audit;
      this.db.prepare(
        `INSERT OR IGNORE INTO audit_events(
           id, actor_type, actor_id, session_id, action, resource_type, resource_id,
           data_json, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        audit.auditId,
        audit.actorType,
        audit.actorId,
        audit.sessionId,
        audit.action,
        audit.resourceType,
        audit.resourceId,
        JSON.stringify(audit.data),
        audit.createdAt,
      );
    }
  }

  /** Recheck moderation authority at the mutation boundary, not just in the
   * HTTP handler where a role/session can change concurrently. */
  private assertHumanModerator(
    meshId: string,
    accountId: string | undefined,
    sessionHash: string | undefined,
    now = this.now(),
  ): void {
    if (!accountId || !sessionHash) throw new Error("moderation_authorization_denied");
    const role = this.db.prepare(
      "SELECT role FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?",
    ).get(meshId, accountId) as { role: string } | undefined;
    const session = this.db.prepare(
      `SELECT account_id, expires_at, absolute_expires_at, last_seen_at
       FROM human_sessions WHERE token_hash = ?`,
    ).get(sessionHash) as {
      account_id: string;
      expires_at: string;
      absolute_expires_at: string;
      last_seen_at: string;
    } | undefined;
    const nowMs = Date.parse(now);
    const lastSeenAt = session ? Date.parse(session.last_seen_at) : NaN;
    const expiresAt = session ? Date.parse(session.expires_at) : NaN;
    const absoluteExpiresAt = session ? Date.parse(session.absolute_expires_at) : NaN;
    if (
      !role || (role.role !== "owner" && role.role !== "steward") ||
      !session || session.account_id !== accountId ||
      !Number.isFinite(lastSeenAt) || !Number.isFinite(expiresAt) ||
      !Number.isFinite(absoluteExpiresAt) || expiresAt <= nowMs ||
      absoluteExpiresAt <= nowMs || lastSeenAt <= nowMs - HUMAN_IDLE_SECONDS * 1_000
    ) {
      throw new Error("moderation_authorization_denied");
    }
  }

  /** Recheck a human session and mesh role at the SQLite transaction boundary
   * so the conformance adapter has the same revocation semantics as Firestore. */
  private assertHumanGovernance(
    meshId: string,
    accountId: string | undefined,
    sessionHash: string | undefined,
    roles: readonly string[],
    now = this.now(),
  ): void {
    if (!accountId || !sessionHash) throw new Error("mesh_governance_denied");
    const role = this.db.prepare(
      "SELECT role FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?",
    ).get(meshId, accountId) as { role: string } | undefined;
    const session = this.db.prepare(
      `SELECT account_id, expires_at, absolute_expires_at, last_seen_at
       FROM human_sessions WHERE token_hash = ?`,
    ).get(sessionHash) as {
      account_id: string;
      expires_at: string;
      absolute_expires_at: string;
      last_seen_at: string;
    } | undefined;
    const nowMs = Date.parse(now);
    const validSession = Boolean(
      session && session.account_id === accountId &&
      Number.isFinite(Date.parse(session.expires_at)) &&
      Number.isFinite(Date.parse(session.absolute_expires_at)) &&
      Number.isFinite(Date.parse(session.last_seen_at)) &&
      Date.parse(session.expires_at) > nowMs &&
      Date.parse(session.absolute_expires_at) > nowMs &&
      Date.parse(session.last_seen_at) > nowMs - HUMAN_IDLE_SECONDS * 1_000,
    );
    if (!role || !roles.includes(role.role) || !validSession) {
      throw new Error("mesh_governance_denied");
    }
  }

  private postRecord(postId: string): RepositoryPostRecord | null {
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
      updatedAt: row.created_at,
      expiresAt: row.expires_at,
    } : null;
  }

  private moderationCaseRecord(caseId: string): RepositoryModerationCase | null {
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

  private moderationIdempotencyResponse(
    moderationCase: RepositoryModerationCase,
    post: RepositoryPostRecord,
  ): string {
    return JSON.stringify({
      caseId: moderationCase.caseId,
      postId: post.postId,
      caseReason: moderationCase.reason,
      caseState: moderationCase.state,
      caseResolution: moderationCase.resolution,
      postModerationState: post.moderationState,
      postModerationReason: post.moderationReason,
      bodyDigest: createHash("sha256").update(post.body).digest("hex"),
    });
  }

  private assertModerationReplayMatches(
    reference: Record<string, unknown>,
    moderationCase: RepositoryModerationCase,
    post: RepositoryPostRecord,
  ): void {
    if (
      (reference.caseReason !== undefined && reference.caseReason !== moderationCase.reason) ||
      (reference.caseState !== undefined && reference.caseState !== moderationCase.state) ||
      (reference.caseResolution !== undefined && reference.caseResolution !== moderationCase.resolution) ||
      (reference.postModerationState !== undefined && reference.postModerationState !== post.moderationState) ||
      (reference.postModerationReason !== undefined && reference.postModerationReason !== post.moderationReason) ||
      (reference.bodyDigest !== undefined && reference.bodyDigest !== createHash("sha256").update(post.body).digest("hex"))
    ) {
      throw new Error("idempotency_replay_superseded");
    }
  }

  private moderationArtifacts(
    event: RepositoryEventInput | undefined,
    audit: RepositoryAuditInput | undefined,
    post: RepositoryPostRecord,
    nextPostState: RepositoryPostRecord["moderationState"],
  ): RepositoryMutationArtifacts {
    const parent = post.parentPostId ? this.postRecord(post.parentPostId) : null;
    const payload = event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};
    const data = audit?.data && typeof audit.data === "object" && !Array.isArray(audit.data)
      ? audit.data as Record<string, unknown>
      : {};
    return {
      event: event ? {
        ...event,
        meshId: post.meshId,
        topicId: post.topicId,
        agentId: post.agentId,
        payload: {
          ...payload,
          state: nextPostState,
          moderation_state: nextPostState,
          previous_moderation_state: post.moderationState,
          original_event_type: post.parentPostId ? "reply.created" : "post.created",
          topic_id: post.topicId,
          parent_post_id: post.parentPostId,
          parent_agent_id: parent?.agentId ?? null,
          parent_created_at: parent?.createdAt ?? null,
        },
      } : undefined,
      audit: audit ? {
        ...audit,
        data: {
          ...data,
          meshId: post.meshId,
          postId: post.postId,
          previous_moderation_state: post.moderationState,
        },
      } : undefined,
    };
  }

  private moderationIdempotencyExpiry(updatedAt: string, _postExpiresAt: string | null): string {
    // Keep a tombstone for the whole moderation-case retention window. Post
    // bodies may expire first, but dropping the key at that boundary would
    // allow a deterministic retry to reopen a terminal case and collide with
    // its immutable audit/outbox artifacts.
    return new Date(
      Date.parse(updatedAt) + MODERATION_IDEMPOTENCY_RETENTION_SECONDS * 1_000,
    ).toISOString();
  }

  private assertHumanSession(
    accountId: string | undefined,
    sessionHash: string | undefined,
    now = this.now(),
  ): void {
    if (!accountId || !sessionHash) throw new Error("mesh_governance_denied");
    const session = this.db.prepare(
      `SELECT account_id, expires_at, absolute_expires_at, last_seen_at
       FROM human_sessions WHERE token_hash = ?`,
    ).get(sessionHash) as {
      account_id: string;
      expires_at: string;
      absolute_expires_at: string;
      last_seen_at: string;
    } | undefined;
    const nowMs = Date.parse(now);
    if (
      !session || session.account_id !== accountId ||
      !Number.isFinite(Date.parse(session.expires_at)) ||
      !Number.isFinite(Date.parse(session.absolute_expires_at)) ||
      !Number.isFinite(Date.parse(session.last_seen_at)) ||
      Date.parse(session.expires_at) <= nowMs ||
      Date.parse(session.absolute_expires_at) <= nowMs ||
      Date.parse(session.last_seen_at) <= nowMs - HUMAN_IDLE_SECONDS * 1_000
    ) throw new Error("mesh_governance_denied");
  }

  async checkReady(): Promise<void> {
    const row = this.db.prepare("SELECT 1 AS ready FROM schema_migrations WHERE version = ?").get(CURRENT_SCHEMA_VERSION) as
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

  async expirePairingIfPending(
    pairingId: string,
    expiredAt: string,
  ): Promise<RepositoryPairingInput | null> {
    this.db.prepare(
      `UPDATE pairings SET status = 'expired'
       WHERE id = ? AND status = 'pending' AND expires_at <= ?`,
    ).run(pairingId, expiredAt);
    return this.findPairing(pairingId);
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

  async upsertAgent(
    input: RepositoryAgentInput,
  ): Promise<{ changed: boolean; updatedAt: string }> {
    // The local adapter is also the fixture authority. Keep this method
    // idempotent while allowing callers to use the production-shaped port.
    const current = this.db.prepare(
      `SELECT owner_account_id, name, handle, tagline, interests_json,
              personality, attention_json, runtime, runtime_label,
              runtime_subject, public_key_pem, definition_digest,
              created_at, updated_at
       FROM agents WHERE id = ?`,
    ).get(input.agentId) as
      | {
          owner_account_id: string;
          name: string;
          handle: string;
          tagline: string;
          interests_json: string;
          personality: string;
          attention_json: string;
          runtime: string;
          runtime_label: string;
          runtime_subject: string;
          public_key_pem: string;
          definition_digest: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (input.actingAccountId || input.humanSessionHash) {
      this.assertHumanSession(input.actingAccountId, input.humanSessionHash, input.updatedAt);
      if (input.actingAccountId !== input.ownerAccountId) throw new Error("mesh_governance_denied");
      if (current && current.owner_account_id !== input.ownerAccountId) throw new Error("agent_access_denied");
    }
    if (input.expectedUpdatedAt !== undefined) {
      if (!current || current.updated_at !== input.expectedUpdatedAt) {
        throw new Error("profile_conflict");
      }
    }
    let storedInterests: unknown = null;
    let storedAttention: unknown = null;
    try {
      storedInterests = current ? JSON.parse(current.interests_json) : null;
      storedAttention = current ? JSON.parse(current.attention_json) : null;
    } catch {
      // A malformed durable profile is not semantically equal and is repaired
      // by the normal authorized update below.
    }
    const exactOwnerNoop =
      Boolean(input.actingAccountId) &&
      !input.profileReviewProposal &&
      current !== undefined &&
      current.owner_account_id === input.ownerAccountId &&
      current.name === input.name &&
      current.handle === input.handle &&
      current.tagline === input.tagline &&
      isDeepStrictEqual(storedInterests, input.interests) &&
      current.personality === input.personality &&
      isDeepStrictEqual(storedAttention, input.attention) &&
      current.runtime === input.runtime &&
      current.runtime_label === input.runtimeLabel &&
      current.runtime_subject === input.runtimeSubject &&
      current.public_key_pem === input.publicKeyPem &&
      current.definition_digest === input.definitionDigest &&
      current.created_at === input.createdAt;
    if (exactOwnerNoop) {
      return { changed: false, updatedAt: current.updated_at };
    }
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
    if (input.profileReviewProposal) {
      const proposal = input.profileReviewProposal;
      this.db.prepare(
        `INSERT INTO profile_review_proposals(
           id, agent_id, owner_account_id, source_digest, requested_json, pending_fields_json,
           status, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           source_digest = excluded.source_digest,
           requested_json = excluded.requested_json,
           pending_fields_json = excluded.pending_fields_json,
           status = 'pending', resolution = NULL, resolved_at = NULL,
           updated_at = excluded.updated_at`,
      ).run(
        proposal.proposalId,
        input.agentId,
        input.ownerAccountId,
        proposal.sourceDigest,
        JSON.stringify(proposal.requested),
        JSON.stringify(proposal.pendingFields),
        proposal.createdAt,
        input.updatedAt,
      );
    }
    return { changed: true, updatedAt: input.updatedAt };
  }

  async createBrowserAgentWithPageAuthority(
    input: RepositoryCreateBrowserAgentInput,
  ): Promise<RepositoryCreateBrowserAgentResult> {
    const now = this.now();
    const nowMs = Date.parse(now);
    const agent = input.agent;
    const browserRuntimeValid =
      agent.bindingId === undefined &&
      agent.runtime === "other" &&
      agent.runtimeLabel === "Page WebMCP" &&
      agent.runtimeSubject === `webmcp:${agent.agentId}` &&
      agent.publicKeyPem === "" &&
      agent.definitionDigest === null;
    if (!browserRuntimeValid) throw new Error("browser_agent_runtime_invalid");
    if (
      !agent.agentId ||
      !agent.ownerAccountId ||
      !agent.handle.trim().normalize("NFKC") ||
      !input.grantId ||
      !input.humanSessionHash ||
      !input.sessionId ||
      !input.idempotencyKey ||
      !input.requestHash
    ) {
      throw new Error("browser_agent_input_invalid");
    }

    type AgentRow = {
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
    };
    const toAgent = (row: AgentRow): RepositoryAgentInput => ({
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
    });
    const profileMatches = (row: AgentRow): boolean => {
      let interests: unknown;
      let attention: unknown;
      try {
        interests = JSON.parse(row.interests_json);
        attention = JSON.parse(row.attention_json);
      } catch {
        return false;
      }
      return (
        row.id === agent.agentId &&
        row.owner_account_id === agent.ownerAccountId &&
        row.name === agent.name &&
        row.handle === agent.handle &&
        row.tagline === agent.tagline &&
        isDeepStrictEqual(interests, agent.interests) &&
        row.personality === agent.personality &&
        isDeepStrictEqual(attention, agent.attention) &&
        row.runtime === agent.runtime &&
        row.runtime_label === agent.runtimeLabel &&
        row.runtime_subject === agent.runtimeSubject &&
        row.public_key_pem === agent.publicKeyPem &&
        row.definition_digest === agent.definitionDigest
      );
    };

    return this.database.transaction(() => {
      const humanSession = this.db.prepare(
        `SELECT account_id, expires_at, absolute_expires_at, last_seen_at
         FROM human_sessions WHERE token_hash = ?`,
      ).get(input.humanSessionHash) as
        | {
            account_id: string;
            expires_at: string;
            absolute_expires_at: string;
            last_seen_at: string;
          }
        | undefined;
      const humanExpiresAt = humanSession ? Date.parse(humanSession.expires_at) : NaN;
      const humanAbsoluteExpiresAt = humanSession
        ? Date.parse(humanSession.absolute_expires_at)
        : NaN;
      const humanLastSeenAt = humanSession ? Date.parse(humanSession.last_seen_at) : NaN;
      if (
        !humanSession ||
        humanSession.account_id !== agent.ownerAccountId ||
        !Number.isFinite(nowMs) ||
        !Number.isFinite(humanExpiresAt) ||
        !Number.isFinite(humanAbsoluteExpiresAt) ||
        !Number.isFinite(humanLastSeenAt) ||
        humanExpiresAt <= nowMs ||
        humanAbsoluteExpiresAt <= nowMs ||
        humanLastSeenAt <= nowMs - HUMAN_IDLE_SECONDS * 1_000
      ) {
        throw new Error("session_invalid");
      }
      const activeSessions = this.db.prepare(
        `SELECT session_id, authority_epoch
         FROM agent_sessions
         WHERE agent_id = ? AND status = 'active' LIMIT 2`,
      ).all(agent.agentId) as Array<{ session_id: string; authority_epoch: number }>;
      const humanGrants = this.db.prepare(
        `SELECT token_hash, agent_id, session_id, authority_epoch
         FROM webmcp_grants
         WHERE human_session_hash = ? AND revoked_at IS NULL LIMIT 2`,
      ).all(input.humanSessionHash) as Array<{
        token_hash: string;
        agent_id: string;
        session_id: string;
        authority_epoch: number;
      }>;
      const agentGrants = this.db.prepare(
        `SELECT token_hash, human_session_hash, session_id, authority_epoch
         FROM webmcp_grants
         WHERE agent_id = ? AND revoked_at IS NULL LIMIT 2`,
      ).all(agent.agentId) as Array<{
        token_hash: string;
        human_session_hash: string;
        session_id: string;
        authority_epoch: number;
      }>;
      if (
        activeSessions.length > 1 ||
        humanGrants.length > 1 ||
        agentGrants.length > 1
      ) {
        throw new Error("agent_authority_corrupt");
      }
      const idempotency = this.db.prepare(
        `SELECT request_hash, response_json, expires_at
         FROM human_idempotency_records
         WHERE account_id = ? AND operation = 'webmcp.agent.create'
           AND idempotency_key = ?`,
      ).get(agent.ownerAccountId, input.idempotencyKey) as
        | { request_hash: string; response_json: string; expires_at: string }
        | undefined;
      if (idempotency) {
        if (!constantTimeStringEqual(idempotency.request_hash, input.requestHash)) {
          throw new Error("idempotency_conflict");
        }
        const idempotencyExpiresAt = Date.parse(idempotency.expires_at);
        if (
          !Number.isFinite(idempotencyExpiresAt) ||
          idempotencyExpiresAt <= nowMs
        ) {
          throw new Error("idempotency_expired");
        }
        let reference: Record<string, unknown>;
        try {
          reference = JSON.parse(idempotency.response_json) as Record<string, unknown>;
        } catch {
          throw new Error("idempotency_expired");
        }
        const storedAgentId = String(reference.agent_id ?? "");
        const storedGrantId = String(reference.grant_id ?? "");
        const storedSessionId = String(reference.session_id ?? "");
        const storedEpoch = Number(reference.authority_epoch);
        if (
          storedAgentId !== agent.agentId ||
          storedGrantId !== input.grantId ||
          storedSessionId !== input.sessionId ||
          !Number.isInteger(storedEpoch) ||
          storedEpoch < 1
        ) {
          throw new Error("idempotency_conflict");
        }
        const storedAgent = this.db.prepare("SELECT * FROM agents WHERE id = ?")
          .get(storedAgentId) as AgentRow | undefined;
        if (!storedAgent) throw new Error("idempotency_conflict");
        if (!profileMatches(storedAgent)) throw new Error("idempotency_conflict");

        const membership = this.db.prepare(
          `SELECT status, attention_policy_json, admission_provenance
           FROM mesh_agent_memberships
           WHERE mesh_id = 'mesh-public' AND agent_id = ?`,
        ).get(storedAgentId) as
          | { status: string; attention_policy_json: string; admission_provenance: string }
          | undefined;
        const activeMembership = this.db.prepare(
          "SELECT 1 AS present FROM mesh_members WHERE mesh_id = 'mesh-public' AND agent_id = ?",
        ).get(storedAgentId);
        let membershipAttention: unknown;
        try {
          membershipAttention = membership
            ? JSON.parse(membership.attention_policy_json)
            : undefined;
        } catch {
          membershipAttention = undefined;
        }
        if (
          !membership ||
          !activeMembership ||
          membership.status !== "joined" ||
          membership.admission_provenance !== "open" ||
          !isDeepStrictEqual(membershipAttention, agent.attention)
        ) {
          throw new Error("idempotency_conflict");
        }

        const grantRow = this.db.prepare(
          `SELECT token_hash, human_session_hash, agent_id, session_id,
                  authority_epoch, created_at, expires_at, last_used_at, revoked_at
           FROM webmcp_grants WHERE token_hash = ?`,
        ).get(storedGrantId) as
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
        const authority = this.db.prepare(
          "SELECT epoch, authority_kind, session_id FROM agent_authority WHERE agent_id = ?",
        ).get(storedAgentId) as
          | { epoch: number; authority_kind: string; session_id: string }
          | undefined;
        const fence = this.db.prepare(
          `SELECT epoch, grant_id, agent_id, session_id, revoked_at
           FROM webmcp_authority WHERE human_session_hash = ?`,
        ).get(input.humanSessionHash) as
          | {
              epoch: number;
              grant_id: string | null;
              agent_id: string | null;
              session_id: string | null;
              revoked_at: string | null;
            }
          | undefined;
        if (!grantRow) throw new Error("idempotency_conflict");
        if (
          grantRow.human_session_hash !== input.humanSessionHash ||
          grantRow.agent_id !== storedAgentId ||
          grantRow.session_id !== storedSessionId ||
          Number(grantRow.authority_epoch) !== storedEpoch ||
          grantRow.revoked_at !== null ||
          !Number.isFinite(Date.parse(grantRow.expires_at)) ||
          Date.parse(grantRow.expires_at) <= nowMs ||
          activeSessions.length !== 0 ||
          humanGrants.length !== 1 ||
          humanGrants[0]!.token_hash !== storedGrantId ||
          agentGrants.length !== 1 ||
          agentGrants[0]!.token_hash !== storedGrantId ||
          !authority ||
          authority.authority_kind !== "page" ||
          authority.session_id !== storedSessionId ||
          Number(authority.epoch) !== storedEpoch ||
          !fence ||
          fence.grant_id !== storedGrantId ||
          fence.agent_id !== storedAgentId ||
          fence.session_id !== storedSessionId ||
          fence.revoked_at !== null ||
          Number(fence.epoch) !== storedEpoch
        ) {
          throw new Error("idempotency_expired");
        }
        const grant: RepositoryBrowserAgentGrant = {
          grantId: grantRow.token_hash,
          tokenHash: grantRow.token_hash,
          humanSessionHash: grantRow.human_session_hash,
          agentId: grantRow.agent_id,
          sessionId: grantRow.session_id,
          authorityEpoch: Number(grantRow.authority_epoch),
          createdAt: grantRow.created_at,
          expiresAt: grantRow.expires_at,
          lastUsedAt: grantRow.last_used_at,
          revokedAt: grantRow.revoked_at,
        };
        return {
          agent: toAgent(storedAgent),
          grant,
          authorityEpoch: storedEpoch,
          sessionId: storedSessionId,
          duplicate: true,
        };
      }

      if (
        this.db.prepare("SELECT 1 AS present FROM agents WHERE id = ?").get(agent.agentId) ||
        this.db.prepare("SELECT 1 AS present FROM webmcp_grants WHERE token_hash = ?")
          .get(input.grantId)
      ) {
        throw new Error("idempotency_conflict");
      }
      const handleOwner = this.db.prepare(
        "SELECT id FROM agents WHERE handle = ? COLLATE NOCASE LIMIT 1",
      ).get(agent.handle) as { id: string } | undefined;
      if (handleOwner) throw new Error("handle_unavailable");
      const owned = this.db.prepare(
        "SELECT COUNT(*) AS count FROM agents WHERE owner_account_id = ?",
      ).get(agent.ownerAccountId) as { count: number };
      if (Number(owned.count) >= 25) throw new Error("agent_limit_reached");
      const publicMesh = this.db.prepare(
        "SELECT visibility, join_policy, lifecycle FROM meshes WHERE id = 'mesh-public'",
      ).get() as
        | { visibility: string; join_policy: string; lifecycle: string }
        | undefined;
      if (!publicMesh) throw new Error("mesh_not_found");
      if (
        publicMesh.visibility !== "public" ||
        publicMesh.join_policy !== "open" ||
        publicMesh.lifecycle !== "active"
      ) {
        throw new Error("mesh_unavailable");
      }
      const grantExpiresAt = Date.parse(input.expiresAt);
      if (
        !Number.isFinite(grantExpiresAt) ||
        grantExpiresAt <= nowMs ||
        grantExpiresAt > nowMs + PAGE_AUTHORITY_GRANT_SECONDS * 1_000 ||
        grantExpiresAt > humanExpiresAt ||
        grantExpiresAt > humanAbsoluteExpiresAt
      ) {
        throw new Error("page_grant_expiry_invalid");
      }

      const humanFence = this.db.prepare(
        "SELECT epoch FROM webmcp_authority WHERE human_session_hash = ?",
      ).get(input.humanSessionHash) as { epoch: number } | undefined;
      if (humanGrants[0]) {
        const previousFence = this.db.prepare(
          `SELECT epoch, grant_id, agent_id, session_id, revoked_at
           FROM webmcp_authority WHERE human_session_hash = ?`,
        ).get(input.humanSessionHash) as
          | {
              epoch: number;
              grant_id: string | null;
              agent_id: string | null;
              session_id: string | null;
              revoked_at: string | null;
            }
          | undefined;
        if (
          !previousFence ||
          previousFence.grant_id !== humanGrants[0].token_hash ||
          previousFence.agent_id !== humanGrants[0].agent_id ||
          previousFence.session_id !== humanGrants[0].session_id ||
          previousFence.revoked_at !== null ||
          Number(previousFence.epoch) !== Number(humanGrants[0].authority_epoch)
        ) {
          throw new Error("webmcp_authority_corrupt");
        }
      }
      const agentFence = this.db.prepare(
        "SELECT epoch FROM agent_authority WHERE agent_id = ?",
      ).get(agent.agentId) as { epoch: number } | undefined;
      const epoch = Math.max(
        Number(humanFence?.epoch ?? 0),
        Number(agentFence?.epoch ?? 0),
      ) + 1;

      this.db.prepare(
        `INSERT INTO agents(
           id, owner_account_id, name, handle, tagline, interests_json,
           personality, attention_json, runtime, runtime_label, runtime_subject,
           public_key_pem, definition_digest, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        agent.agentId,
        agent.ownerAccountId,
        agent.name,
        agent.handle,
        agent.tagline,
        JSON.stringify(agent.interests),
        agent.personality,
        JSON.stringify(agent.attention),
        agent.runtime,
        agent.runtimeLabel,
        agent.runtimeSubject,
        agent.publicKeyPem,
        agent.definitionDigest,
        agent.createdAt,
        agent.updatedAt,
      );
      this.db.prepare(
        "INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES('mesh-public', ?, ?)",
      ).run(agent.agentId, agent.createdAt);
      this.db.prepare(
        `INSERT INTO mesh_agent_memberships(
           mesh_id, agent_id, status, attention_policy_json,
           admission_provenance, joined_at, updated_at
         ) VALUES('mesh-public', ?, 'joined', ?, 'open', ?, ?)`,
      ).run(
        agent.agentId,
        JSON.stringify(agent.attention),
        agent.createdAt,
        agent.updatedAt,
      );

      this.db.prepare(
        `UPDATE agent_sessions
         SET status = 'superseded', superseded_by = ?, expires_at = ?
         WHERE agent_id = ? AND status = 'active'`,
      ).run(input.sessionId, now, agent.agentId);
      this.db.prepare(
        `UPDATE webmcp_grants SET revoked_at = ?
         WHERE human_session_hash = ? AND revoked_at IS NULL`,
      ).run(now, input.humanSessionHash);
      this.db.prepare(
        `INSERT INTO agent_authority(
           agent_id, epoch, authority_kind, session_id, updated_at
         ) VALUES(?, ?, 'page', ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           epoch = excluded.epoch,
           authority_kind = excluded.authority_kind,
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`,
      ).run(agent.agentId, epoch, input.sessionId, now);
      this.db.prepare(
        `INSERT INTO webmcp_authority(
           human_session_hash, epoch, grant_id, agent_id, session_id, updated_at, revoked_at
         ) VALUES(?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(human_session_hash) DO UPDATE SET
           epoch = excluded.epoch,
           grant_id = excluded.grant_id,
           agent_id = excluded.agent_id,
           session_id = excluded.session_id,
           updated_at = excluded.updated_at,
           revoked_at = NULL`,
      ).run(
        input.humanSessionHash,
        epoch,
        input.grantId,
        agent.agentId,
        input.sessionId,
        now,
      );
      this.db.prepare(
        `INSERT INTO webmcp_grants(
           token_hash, human_session_hash, agent_id, created_at, expires_at,
           last_used_at, revoked_at, session_id, authority_epoch
         ) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        input.grantId,
        input.humanSessionHash,
        agent.agentId,
        now,
        input.expiresAt,
        now,
        input.sessionId,
        epoch,
      );

      this.writeMutationArtifacts({ event: input.event, audit: input.audit });
      const idempotencyExpiresAt = new Date(
        nowMs + BROWSER_AGENT_IDEMPOTENCY_RETENTION_SECONDS * 1_000,
      ).toISOString();
      this.db.prepare(
        `INSERT INTO human_idempotency_records(
           account_id, operation, idempotency_key, request_hash,
           response_status, response_json, created_at, expires_at
         ) VALUES(?, 'webmcp.agent.create', ?, ?, 201, ?, ?, ?)`,
      ).run(
        agent.ownerAccountId,
        input.idempotencyKey,
        input.requestHash,
        JSON.stringify({
          agent_id: agent.agentId,
          grant_id: input.grantId,
          session_id: input.sessionId,
          authority_epoch: epoch,
        }),
        now,
        idempotencyExpiresAt,
      );

      const grant: RepositoryBrowserAgentGrant = {
        grantId: input.grantId,
        tokenHash: input.grantId,
        humanSessionHash: input.humanSessionHash,
        agentId: agent.agentId,
        sessionId: input.sessionId,
        authorityEpoch: epoch,
        createdAt: now,
        expiresAt: input.expiresAt,
        lastUsedAt: now,
        revokedAt: null,
      };
      return {
        agent: { ...agent },
        grant,
        authorityEpoch: epoch,
        sessionId: input.sessionId,
        duplicate: false,
      };
    });
  }

  async updateAgentProfileFromSession(input: {
    agent: RepositoryAgentInput;
    sessionId: string;
    authorityEpoch: number;
    idempotencyKey: string;
    requestHash: string;
    updatedAt: string;
    expectedUpdatedAt?: string;
    profileReload?: RepositoryProfileReloadResult;
  }): Promise<{
    agent: RepositoryAgentInput;
    duplicate: boolean;
    profileReload?: RepositoryProfileReloadResult;
  }> {
    const bindingId = input.agent.bindingId;
    if (!bindingId) throw new Error("binding_invalid");
    return this.database.transaction(() => {
      const current = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(input.agent.agentId) as
        | (Record<string, unknown> & {
            id: string;
            owner_account_id: string;
            created_at: string;
            updated_at: string;
          })
        | undefined;
      const authority = this.db.prepare(
        `SELECT epoch, authority_kind, session_id
         FROM agent_authority WHERE agent_id = ?`,
      ).get(input.agent.agentId) as
        | { epoch: number; authority_kind: string; session_id: string }
        | undefined;
      const session = this.db.prepare(
        `SELECT agent_id, pairing_id, status, authority_epoch, expires_at, last_seen_at
         FROM agent_sessions WHERE session_id = ?`,
      ).get(input.sessionId) as
        | {
            agent_id: string;
            pairing_id: string;
            status: string;
            authority_epoch: number;
            expires_at: string;
            last_seen_at: string;
          }
        | undefined;
      const binding = this.db.prepare(
        `SELECT id, agent_id, status, owner_account_id
         FROM pairings WHERE id = ?`,
      ).get(bindingId) as
        | { id: string; agent_id: string | null; status: string; owner_account_id: string | null }
        | undefined;
      const nowMs = Date.parse(input.updatedAt);
      if (
        !current ||
        !authority || authority.authority_kind !== "native" ||
        authority.session_id !== input.sessionId ||
        Number(authority.epoch) !== input.authorityEpoch ||
        !session || session.agent_id !== input.agent.agentId ||
        session.status !== "active" ||
        Number(session.authority_epoch) !== input.authorityEpoch ||
        !Number.isFinite(Date.parse(session.expires_at)) ||
        Date.parse(session.expires_at) <= nowMs ||
        !Number.isFinite(Date.parse(session.last_seen_at)) ||
        Date.parse(session.last_seen_at) < nowMs - 90_000 ||
        !binding || binding.agent_id !== input.agent.agentId ||
        !["approved", "claimed"].includes(binding.status) ||
        binding.owner_account_id !== input.agent.ownerAccountId ||
        current.owner_account_id !== input.agent.ownerAccountId
      ) {
        throw new Error("session_superseded");
      }

      const existing = this.db.prepare(
        `SELECT request_hash, response_json
         FROM idempotency_records
         WHERE agent_id = ? AND operation = 'agent.profile.update' AND idempotency_key = ?`,
      ).get(input.agent.agentId, input.idempotencyKey) as
        | { request_hash: string; response_json: string }
        | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash) throw new Error("idempotency_conflict");
        const stored = JSON.parse(existing.response_json) as Record<string, unknown>;
        const response = stored.response_agent && typeof stored.response_agent === "object"
          ? stored.response_agent as Record<string, unknown>
          : stored;
        return {
          duplicate: true,
          agent: {
            ...input.agent,
            name: String(response.name ?? input.agent.name),
            handle: String(response.handle ?? input.agent.handle),
            tagline: String(response.tagline ?? input.agent.tagline),
            interests: Array.isArray(response.interests)
              ? response.interests.map(String)
              : input.agent.interests,
            personality: String(response.personality ?? input.agent.personality),
            attention: (response.attention_policy && typeof response.attention_policy === "object"
              ? response.attention_policy
              : input.agent.attention) as Record<string, unknown>,
            definitionDigest: response.definition_digest == null
              ? input.agent.definitionDigest
              : String(response.definition_digest),
            createdAt: String(response.created_at ?? current.created_at),
            updatedAt: String(response.updated_at ?? input.agent.updatedAt),
          },
          ...(stored.profile_reload && typeof stored.profile_reload === "object"
            ? { profileReload: stored.profile_reload as RepositoryProfileReloadResult }
            : {}),
        };
      }
      if (
        input.expectedUpdatedAt !== undefined &&
        current.updated_at !== input.expectedUpdatedAt
      ) throw new Error("profile_conflict");
      const currentUpdatedMs = Date.parse(current.updated_at);
      const requestedUpdatedMs = Date.parse(input.updatedAt);
      const effectiveUpdatedAt = Number.isFinite(currentUpdatedMs) &&
          (!Number.isFinite(requestedUpdatedMs) || requestedUpdatedMs <= currentUpdatedMs)
        ? new Date(currentUpdatedMs + 1).toISOString()
        : input.updatedAt;
      const handleOwner = this.db.prepare(
        "SELECT id FROM agents WHERE handle = ? COLLATE NOCASE AND id <> ?",
      ).get(input.agent.handle, input.agent.agentId) as { id: string } | undefined;
      if (handleOwner) throw new Error("handle_unavailable");
      this.db.prepare(
        `UPDATE agents SET name = ?, handle = ?, tagline = ?, interests_json = ?,
           personality = ?, attention_json = ?, definition_digest = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        input.agent.name,
        input.agent.handle,
        input.agent.tagline,
        JSON.stringify(input.agent.interests),
        input.agent.personality,
        JSON.stringify(input.agent.attention),
        input.agent.definitionDigest,
        effectiveUpdatedAt,
        input.agent.agentId,
      );
      if (input.agent.profileReviewProposal) {
        const proposal = input.agent.profileReviewProposal;
        this.db.prepare(
          `INSERT INTO profile_review_proposals(
             id, agent_id, owner_account_id, source_digest, requested_json, pending_fields_json,
             status, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             source_digest = excluded.source_digest,
             requested_json = excluded.requested_json,
             pending_fields_json = excluded.pending_fields_json,
             status = 'pending', resolution = NULL, resolved_at = NULL,
             updated_at = excluded.updated_at`,
        ).run(
          proposal.proposalId,
          input.agent.agentId,
          input.agent.ownerAccountId,
          proposal.sourceDigest,
          JSON.stringify(proposal.requested),
          JSON.stringify(proposal.pendingFields),
          proposal.createdAt,
          effectiveUpdatedAt,
        );
      }
      const responseAgent = {
        contract_version: MESHR_CONTRACT_MAJOR,
        agent_id: input.agent.agentId,
        owner_account_id: input.agent.ownerAccountId,
        name: input.agent.name,
        handle: input.agent.handle,
        tagline: input.agent.tagline,
        interests: input.agent.interests,
        personality: input.agent.personality,
        attention_policy: input.agent.attention,
        runtime: input.agent.runtime,
        runtime_label: input.agent.runtimeLabel,
        runtime_subject: input.agent.runtimeSubject,
        public_key_pem: input.agent.publicKeyPem,
        definition_digest: input.agent.definitionDigest,
        created_at: current.created_at,
        updated_at: effectiveUpdatedAt,
      };
      this.db.prepare(
        `INSERT INTO idempotency_records(
           agent_id, operation, idempotency_key, request_hash,
           response_status, response_json, created_at
         ) VALUES(?, 'agent.profile.update', ?, ?, 200, ?, ?)`,
      ).run(
        input.agent.agentId,
        input.idempotencyKey,
        input.requestHash,
        JSON.stringify({
          response_agent: responseAgent,
          ...(input.profileReload ? { profile_reload: input.profileReload } : {}),
        }),
        effectiveUpdatedAt,
      );
      return {
        duplicate: false,
        agent: { ...input.agent, updatedAt: effectiveUpdatedAt },
        ...(input.profileReload ? { profileReload: input.profileReload } : {}),
      };
    });
  }

  async listProfileReviewProposals(input: {
    agentId: string;
    ownerAccountId: string;
    humanSessionHash: string;
  }): Promise<RepositoryProfileReviewProposal[]> {
    this.assertHumanSession(input.ownerAccountId, input.humanSessionHash);
    const rows = this.db.prepare(
      `SELECT id, agent_id, owner_account_id, source_digest, requested_json,
              pending_fields_json, status, created_at, updated_at, resolved_at, resolution
       FROM profile_review_proposals
       WHERE agent_id = ? AND owner_account_id = ?
       ORDER BY updated_at DESC, id ASC LIMIT 100`,
    ).all(input.agentId, input.ownerAccountId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      proposalId: String(row.id),
      agentId: String(row.agent_id),
      ownerAccountId: String(row.owner_account_id ?? input.ownerAccountId),
      sourceDigest: String(row.source_digest),
      requested: JSON.parse(String(row.requested_json)) as Record<string, unknown>,
      pendingFields: JSON.parse(String(row.pending_fields_json)) as string[],
      status: String(row.status) as RepositoryProfileReviewProposal["status"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
      resolution: row.resolution === "approved" || row.resolution === "denied"
        ? row.resolution
        : null,
    }));
  }

  async resolveProfileReviewProposal(input: {
    proposalId: string;
    agentId: string;
    ownerAccountId: string;
    humanSessionHash: string;
    decision: "approved" | "denied";
    resolvedAt: string;
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{ proposal: RepositoryProfileReviewProposal; agent: RepositoryAgentInput }> {
    return this.database.transaction(() => {
      this.assertHumanSession(input.ownerAccountId, input.humanSessionHash, input.resolvedAt);
      const row = this.db.prepare(
        `SELECT id, agent_id, owner_account_id, source_digest, requested_json,
                pending_fields_json, status, created_at, updated_at, resolved_at, resolution
         FROM profile_review_proposals WHERE id = ?`,
      ).get(input.proposalId) as Record<string, unknown> | undefined;
      if (!row || String(row.agent_id) !== input.agentId || String(row.owner_account_id ?? "") !== input.ownerAccountId) {
        throw new Error("profile_proposal_not_found");
      }
      if (row.status !== "pending") throw new Error("profile_proposal_not_pending");
      const agentRow = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(input.agentId) as Record<string, unknown> | undefined;
      if (!agentRow || String(agentRow.owner_account_id) !== input.ownerAccountId) throw new Error("agent_not_found");
      if (String(row.updated_at) !== String(agentRow.updated_at)) {
        throw new Error("profile_proposal_stale");
      }
      const currentUpdatedMs = Date.parse(String(agentRow.updated_at));
      const requestedResolvedMs = Date.parse(input.resolvedAt);
      const effectiveResolvedAt = Number.isFinite(currentUpdatedMs) &&
          (!Number.isFinite(requestedResolvedMs) || requestedResolvedMs <= currentUpdatedMs)
        ? new Date(currentUpdatedMs + 1).toISOString()
        : input.resolvedAt;
      const requested = JSON.parse(String(row.requested_json)) as Record<string, unknown>;
      const currentAttention = JSON.parse(String(agentRow.attention_json ?? "{}")) as Record<string, unknown>;
      let agent: RepositoryAgentInput = {
        agentId: String(agentRow.id),
        ownerAccountId: String(agentRow.owner_account_id),
        name: String(agentRow.name),
        handle: String(agentRow.handle),
        tagline: String(agentRow.tagline),
        interests: JSON.parse(String(agentRow.interests_json)) as string[],
        personality: String(agentRow.personality),
        attention: currentAttention,
        runtime: String(agentRow.runtime) as RuntimeKind,
        runtimeLabel: String(agentRow.runtime_label),
        runtimeSubject: String(agentRow.runtime_subject),
        publicKeyPem: String(agentRow.public_key_pem),
        definitionDigest: agentRow.definition_digest == null ? null : String(agentRow.definition_digest),
        createdAt: String(agentRow.created_at),
        updatedAt: effectiveResolvedAt,
      };
      if (input.decision === "approved") {
        const nextName = requested.name === undefined ? agent.name : String(requested.name);
        const nextHandle = requested.handle === undefined ? agent.handle : String(requested.handle);
        if (!nextName.trim() || !nextHandle.trim() || nextName.length > 100 || nextHandle.length > 80) {
          throw new Error("profile_proposal_invalid");
        }
        const handleOwner = this.db.prepare(
          "SELECT id FROM agents WHERE handle = ? COLLATE NOCASE AND id <> ?",
        ).get(nextHandle, input.agentId) as { id: string } | undefined;
        if (handleOwner) throw new Error("handle_unavailable");
        const nextAttention = { ...agent.attention };
        if (requested.attention && typeof requested.attention === "object" && !Array.isArray(requested.attention)) {
          const attention = requested.attention as Record<string, unknown>;
          for (const field of ["browse", "rootPosts", "replies"] as const) {
            if (attention[field] !== undefined) nextAttention[field] = attention[field];
          }
        }
        this.db.prepare(
          `UPDATE agents SET name = ?, handle = ?, attention_json = ?, definition_digest = ?, updated_at = ? WHERE id = ?`,
        ).run(
          nextName,
          nextHandle,
          JSON.stringify(nextAttention),
          String(row.source_digest) || agent.definitionDigest,
          effectiveResolvedAt,
          input.agentId,
        );
        agent = { ...agent, name: nextName, handle: nextHandle, attention: nextAttention, definitionDigest: String(row.source_digest) || agent.definitionDigest };
      }
      this.db.prepare(
        `UPDATE profile_review_proposals
         SET status = ?, resolution = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(input.decision, input.decision, effectiveResolvedAt, effectiveResolvedAt, input.proposalId);
      if (input.event) {
        this.db.prepare(
          `INSERT OR IGNORE INTO outbox_events(
             event_id, schema_version, type, mesh_id, topic_id, agent_id, session_id,
             runtime_kind, payload_json, status, attempts, created_at
           ) VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
        ).run(
          input.event.eventId,
          input.event.type,
          input.event.meshId,
          input.event.topicId,
          input.event.agentId,
          input.event.sessionId,
          input.event.runtimeKind,
          JSON.stringify(input.event.payload),
          input.event.occurredAt,
        );
      }
      if (input.audit) {
        this.db.prepare(
          `INSERT OR IGNORE INTO audit_events(
             id, actor_type, actor_id, session_id, action, resource_type,
             resource_id, data_json, created_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.audit.auditId,
          input.audit.actorType,
          input.audit.actorId,
          input.audit.sessionId,
          input.audit.action,
          input.audit.resourceType,
          input.audit.resourceId,
          JSON.stringify(input.audit.data),
          input.audit.createdAt,
        );
      }
      const proposal: RepositoryProfileReviewProposal = {
        proposalId: String(row.id),
        agentId: input.agentId,
        ownerAccountId: input.ownerAccountId,
        sourceDigest: String(row.source_digest),
        requested,
        pendingFields: JSON.parse(String(row.pending_fields_json)) as string[],
        status: input.decision,
        createdAt: String(row.created_at),
        updatedAt: effectiveResolvedAt,
        resolvedAt: effectiveResolvedAt,
        resolution: input.decision,
      };
      return { proposal, agent };
    });
  }

  async revokeAgent(
    agentId: string,
    revokedAt: string,
    event?: RepositoryEventInput,
    audit?: RepositoryAuditInput,
    actingAccountId?: string,
    humanSessionHash?: string,
  ): Promise<RepositoryAgentRevocationResult> {
    return this.database.transaction(() => {
      if (actingAccountId || humanSessionHash) {
        this.assertHumanSession(actingAccountId, humanSessionHash, revokedAt);
        const agent = this.db
          .prepare("SELECT owner_account_id FROM agents WHERE id = ?")
          .get(agentId) as { owner_account_id: string } | undefined;
        if (!agent || agent.owner_account_id !== actingAccountId) {
          throw new Error("agent_access_denied");
        }
      }
      const activeBindings = this.db.prepare(
        `SELECT id FROM pairings
         WHERE agent_id = ? AND status IN ('approved', 'claimed') LIMIT 2`,
      ).all(agentId);
      const activeSessions = this.db.prepare(
        `SELECT session_id FROM agent_sessions
         WHERE agent_id = ? AND status = 'active' LIMIT 2`,
      ).all(agentId);
      const activeGrants = this.db.prepare(
        `SELECT token_hash FROM webmcp_grants
         WHERE agent_id = ? AND revoked_at IS NULL LIMIT 2`,
      ).all(agentId);
      if (
        activeBindings.length > 1 ||
        activeSessions.length > 1 ||
        activeGrants.length > 1
      ) {
        throw new Error("agent_authority_corrupt");
      }
      if (
        activeBindings.length === 0 &&
        activeSessions.length === 0 &&
        activeGrants.length === 0
      ) {
        return {
          changed: false,
          bindings: 0,
          sessions: 0,
          pageGrants: 0,
          pairings: 0,
        };
      }
      this.db.prepare(
        `UPDATE pairings SET status = 'revoked'
         WHERE agent_id = ? AND status IN ('approved', 'claimed')`,
      ).run(agentId);
      this.db.prepare(
        `UPDATE agent_sessions SET status = 'revoked', expires_at = ?
         WHERE agent_id = ? AND status = 'active'`,
      ).run(revokedAt, agentId);
      this.db.prepare("UPDATE webmcp_grants SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL")
        .run(revokedAt, agentId);
      this.writeMutationArtifacts({ event, audit });
      return {
        changed: true,
        bindings: activeBindings.length,
        sessions: activeSessions.length,
        pageGrants: activeGrants.length,
        pairings: activeBindings.length,
      };
    });
  }

  async upsertMesh(input: RepositoryMeshInput & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      const existing = this.db.prepare(
        "SELECT created_at FROM meshes WHERE id = ?",
      ).get(input.meshId) as { created_at: string } | undefined;
      if (input.actingAccountId) {
        this.assertHumanSession(input.actingAccountId, input.humanSessionHash, input.updatedAt);
        if (!input.ownerAccountId || (!existing && input.actingAccountId !== input.ownerAccountId)) {
          throw new Error("mesh_governance_denied");
        }
        if (existing) this.assertHumanGovernance(
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          ["owner"],
          input.updatedAt,
        );
      }
      if (!existing && input.ownerAccountId) {
        const ownedMeshes = this.db.prepare(
          "SELECT COUNT(*) AS count FROM meshes WHERE owner_account_id = ?",
        ).get(input.ownerAccountId) as { count: number };
        if (ownedMeshes.count >= 10) throw new Error("mesh_limit_reached");
      }
      this.db.prepare(
        `INSERT INTO meshes(
           id, owner_account_id, name, description, visibility, join_policy,
           lifecycle, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_account_id = excluded.owner_account_id,
           name = excluded.name,
           description = excluded.description,
           visibility = excluded.visibility,
           join_policy = excluded.join_policy,
           lifecycle = excluded.lifecycle,
           updated_at = excluded.updated_at`,
      ).run(
        input.meshId,
        input.ownerAccountId,
        input.name,
        input.description,
        input.visibility,
        input.admission,
        input.lifecycle,
        existing?.created_at ?? input.createdAt,
        input.updatedAt,
      );
      this.writeMutationArtifacts(input);
    });
  }

  async updateMeshGovernance(
    input: RepositoryMeshGovernancePatch,
  ): Promise<RepositoryMeshInput> {
    return this.database.transaction(() => {
      const current = this.db.prepare(
        `SELECT id, owner_account_id, name, description, visibility, join_policy,
                lifecycle, created_at, updated_at
         FROM meshes WHERE id = ?`,
      ).get(input.meshId) as {
        id: string;
        owner_account_id: string | null;
        name: string;
        description: string;
        visibility: RepositoryMeshInput["visibility"];
        join_policy: RepositoryMeshInput["admission"];
        lifecycle: RepositoryMeshInput["lifecycle"];
        created_at: string;
        updated_at: string;
      } | undefined;
      if (!current) throw new Error("mesh_not_found");
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner"],
        input.updatedAt,
      );
      const next: RepositoryMeshInput = {
        meshId: current.id,
        ownerAccountId: current.owner_account_id,
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        visibility: input.visibility ?? current.visibility,
        admission: input.admission ?? current.join_policy,
        lifecycle: current.lifecycle,
        createdAt: current.created_at,
        updatedAt: current.updated_at,
      };
      const changed =
        (input.name !== undefined && input.name !== current.name) ||
        (input.description !== undefined &&
          input.description !== current.description) ||
        (input.visibility !== undefined &&
          input.visibility !== current.visibility) ||
        (input.admission !== undefined &&
          input.admission !== current.join_policy);
      if (!changed) return next;
      next.updatedAt = input.updatedAt;
      this.db.prepare(
        `UPDATE meshes SET name = ?, description = ?, visibility = ?,
                          join_policy = ?, updated_at = ? WHERE id = ?`,
      ).run(
        next.name,
        next.description,
        next.visibility,
        next.admission,
        next.updatedAt,
        input.meshId,
      );
      this.writeMutationArtifacts(input);
      return next;
    });
  }

  async createMeshWithOwner(input: {
    mesh: RepositoryMeshInput;
    topic: RepositoryTopicInput;
    agentIds: string[];
    idempotencyKey?: string;
    requestHash?: string;
  } & RepositoryMutationArtifacts): Promise<{ duplicate: boolean }> {
    const { mesh, topic } = input;
    const agentIds = [...new Set(input.agentIds)];
    return this.database.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM meshes WHERE id = ?").get(mesh.meshId);
      if (existing) {
        const current = this.db.prepare(
          `SELECT owner_account_id, name, description, visibility, join_policy
           FROM meshes WHERE id = ?`,
        ).get(mesh.meshId) as {
          owner_account_id: string | null;
          name: string;
          description: string;
          visibility: RepositoryMeshInput["visibility"];
          join_policy: RepositoryMeshInput["admission"];
        } | undefined;
        const topicExists = this.db.prepare(
          "SELECT 1 FROM topics WHERE id = ? AND mesh_id = ?",
        ).get(topic.topicId, mesh.meshId);
        const existingAgentIds = this.db
          .prepare(
            `SELECT agent_id FROM mesh_members
             WHERE mesh_id = ? ORDER BY agent_id`,
          )
          .all(mesh.meshId)
          .map((row) => (row as { agent_id: string }).agent_id);
        const requestedAgentIds = [...agentIds].sort();
        if (
          input.idempotencyKey && current && topicExists &&
          current.owner_account_id === mesh.ownerAccountId &&
          current.name === mesh.name && current.description === mesh.description &&
          current.visibility === mesh.visibility && current.join_policy === mesh.admission &&
          existingAgentIds.length === requestedAgentIds.length &&
          existingAgentIds.every((agentId, index) => agentId === requestedAgentIds[index])
        ) {
          return { duplicate: true };
        }
        throw new Error(input.idempotencyKey ? "idempotency_conflict" : "mesh_already_exists");
      }
      if (!mesh.ownerAccountId) throw new Error("owner_required");
      this.assertHumanSession(mesh.actingAccountId, mesh.humanSessionHash, mesh.updatedAt);
      if (mesh.actingAccountId !== mesh.ownerAccountId) throw new Error("mesh_governance_denied");
      const owner = this.db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(mesh.ownerAccountId);
      if (!owner) throw new Error("account_not_found");
      const owned = this.db
        .prepare("SELECT COUNT(*) AS count FROM mesh_human_roles WHERE account_id = ? AND role = 'owner'")
        .get(mesh.ownerAccountId) as { count: number };
      if (Number(owned.count) >= 10) throw new Error("mesh_limit_reached");
      const agentQuery = this.db.prepare("SELECT owner_account_id, attention_json FROM agents WHERE id = ?");
      const agents = agentIds.map((agentId) => agentQuery.get(agentId) as {
        owner_account_id: string;
        attention_json: string;
      } | undefined);
      if (agents.some((agent) => !agent || agent.owner_account_id !== mesh.ownerAccountId)) {
        throw new Error("agent_access_denied");
      }
      const joinedCountQuery = this.db.prepare(
        "SELECT COUNT(*) AS count FROM mesh_members WHERE agent_id = ?",
      );
      if (agentIds.some((agentId) => Number((joinedCountQuery.get(agentId) as { count: number }).count) >= 100)) {
        throw new Error("agent_mesh_limit_reached");
      }
      this.db.prepare(
        `INSERT INTO meshes(
           id, owner_account_id, name, description, visibility, join_policy,
           lifecycle, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mesh.meshId,
        mesh.ownerAccountId,
        mesh.name,
        mesh.description,
        mesh.visibility,
        mesh.admission,
        mesh.lifecycle,
        mesh.createdAt,
        mesh.updatedAt,
      );
      this.db.prepare(
        `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
         VALUES(?, ?, 'owner', ?, ?)`,
      ).run(mesh.meshId, mesh.ownerAccountId, mesh.createdAt, mesh.updatedAt);
      this.db.prepare(
        `INSERT INTO topics(id, mesh_id, name, title, description, tags_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        topic.topicId,
        topic.meshId,
        topic.name,
        topic.title,
        topic.description,
        JSON.stringify(topic.tags),
        topic.createdAt,
      );
      const insertMembership = this.db.prepare(
        "INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
      );
      const insertMembershipState = this.db.prepare(
        `INSERT INTO mesh_agent_memberships(
           mesh_id, agent_id, status, attention_policy_json,
           admission_provenance, joined_at, updated_at
         ) VALUES(?, ?, 'joined', ?, 'open', ?, ?)
         ON CONFLICT(mesh_id, agent_id) DO UPDATE SET
           status = 'joined', attention_policy_json = excluded.attention_policy_json,
           admission_provenance = excluded.admission_provenance,
           joined_at = COALESCE(mesh_agent_memberships.joined_at, excluded.joined_at),
           updated_at = excluded.updated_at`,
      );
      for (let index = 0; index < agentIds.length; index += 1) {
        const agentId = agentIds[index]!;
        insertMembership.run(mesh.meshId, agentId, mesh.createdAt);
        insertMembershipState.run(mesh.meshId, agentId, agents[index]!.attention_json, mesh.createdAt, mesh.updatedAt);
      }
      this.writeMutationArtifacts(input);
      return { duplicate: false };
    });
  }

  async upsertTopic(input: RepositoryTopicInput): Promise<void> {
    this.db.prepare(
      `UPDATE topics SET mesh_id = ?, name = ?, title = ?, description = ?, tags_json = ?
       WHERE id = ?`,
    ).run(input.meshId, input.name, input.title, input.description, JSON.stringify(input.tags), input.topicId);
  }

  async createTopic(input: RepositoryTopicCreateInput & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      const mesh = this.db.prepare(
        "SELECT lifecycle FROM meshes WHERE id = ?",
      ).get(input.meshId) as { lifecycle: RepositoryMeshInput["lifecycle"] } | undefined;
      if (!mesh || mesh.lifecycle !== "active") {
        throw new Error("mesh_not_found");
      }
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.createdAt,
      );
      if (this.db.prepare("SELECT 1 FROM topics WHERE id = ?").get(input.topicId)) {
        throw new Error("topic_already_exists");
      }
      const topicCount = this.db
        .prepare("SELECT COUNT(*) AS count FROM topics WHERE mesh_id = ?")
        .get(input.meshId) as { count: number };
      if (Number(topicCount.count) >= MAX_TOPICS_PER_MESH) {
        throw new Error("topic_limit_reached");
      }
      if (this.db.prepare("SELECT 1 FROM topics WHERE mesh_id = ? AND name = ?").get(input.meshId, input.name)) {
        throw new Error("topic_name_taken");
      }
      this.db.prepare(
        `INSERT INTO topics(id, mesh_id, name, title, description, tags_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.topicId,
        input.meshId,
        input.name,
        input.title,
        input.description,
        JSON.stringify(input.tags),
        input.createdAt,
      );
      this.writeMutationArtifacts(input);
    });
  }

  async updateTopic(input: RepositoryTopicUpdateInput & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      const mesh = this.db.prepare(
        "SELECT lifecycle FROM meshes WHERE id = ?",
      ).get(input.meshId) as { lifecycle: RepositoryMeshInput["lifecycle"] } | undefined;
      if (!mesh || mesh.lifecycle !== "active") {
        throw new Error("mesh_not_found");
      }
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.updatedAt,
      );
      const existing = this.db.prepare(
        "SELECT mesh_id FROM topics WHERE id = ?",
      ).get(input.topicId) as { mesh_id: string } | undefined;
      if (!existing || existing.mesh_id !== input.meshId) throw new Error("topic_not_found");
      const sameName = this.db.prepare(
        "SELECT id FROM topics WHERE mesh_id = ? AND name = ? AND id <> ?",
      ).get(input.meshId, input.name, input.topicId) as { id: string } | undefined;
      if (sameName) throw new Error("topic_name_taken");
      this.db.prepare(
        `UPDATE topics SET name = ?, title = ?, description = ?, tags_json = ?
         WHERE id = ? AND mesh_id = ?`,
      ).run(
        input.name,
        input.title,
        input.description,
        JSON.stringify(input.tags),
        input.topicId,
        input.meshId,
      );
      this.writeMutationArtifacts(input);
    });
  }

  async deleteTopic(input: RepositoryTopicDeleteInput & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      const mesh = this.db.prepare(
        "SELECT lifecycle FROM meshes WHERE id = ?",
      ).get(input.meshId) as { lifecycle: RepositoryMeshInput["lifecycle"] } | undefined;
      if (!mesh || mesh.lifecycle !== "active") {
        throw new Error("mesh_not_found");
      }
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.deletedAt,
      );
      const existing = this.db.prepare(
        "SELECT mesh_id FROM topics WHERE id = ?",
      ).get(input.topicId) as { mesh_id: string } | undefined;
      if (!existing || existing.mesh_id !== input.meshId) throw new Error("topic_not_found");
      const topicCount = this.db
        .prepare("SELECT COUNT(*) AS count FROM topics WHERE mesh_id = ?")
        .get(input.meshId) as { count: number };
      if (Number(topicCount.count) <= 1) throw new Error("last_topic");
      if (this.db.prepare("SELECT 1 FROM posts WHERE topic_id = ? LIMIT 1").get(input.topicId)) {
        throw new Error("topic_not_empty");
      }
      // Follows are derived intent and the local schema cascades them when a
      // topic is removed. Unlike retained posts, they never block deletion.
      this.db.prepare("DELETE FROM follows WHERE topic_id = ?").run(input.topicId);
      this.db.prepare("DELETE FROM topics WHERE id = ? AND mesh_id = ?").run(input.topicId, input.meshId);
      this.writeMutationArtifacts(input);
    });
  }

  async findTopicById(topicId: string): Promise<RepositoryTopicInput | null> {
    const row = this.db.prepare(
      `SELECT id, mesh_id, name, title, description, tags_json, created_at
       FROM topics WHERE id = ?`,
    ).get(topicId) as {
      id: string;
      mesh_id: string;
      name: string;
      title: string;
      description: string;
      tags_json: string;
      created_at: string;
    } | undefined;
    if (!row) return null;
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json);
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = [];
    }
    return {
      topicId: row.id,
      meshId: row.mesh_id,
      name: row.name,
      title: row.title,
      description: row.description,
      tags,
      createdAt: row.created_at,
    };
  }

  async findMeshById(meshId: string): Promise<RepositoryMeshInput | null> {
    const row = this.db
      .prepare(
        `SELECT id, owner_account_id, name, description, visibility,
                join_policy, lifecycle, created_at, updated_at
         FROM meshes WHERE id = ?`,
      )
      .get(meshId) as
      | {
          id: string;
          owner_account_id: string | null;
          name: string;
          description: string;
          visibility: RepositoryMeshInput["visibility"];
          join_policy: RepositoryMeshInput["admission"];
          lifecycle: RepositoryMeshInput["lifecycle"];
          created_at: string;
          updated_at: string;
        }
      | undefined;
    return row
      ? {
          meshId: row.id,
          ownerAccountId: row.owner_account_id,
          name: row.name,
          description: row.description,
          visibility: row.visibility,
          admission: row.join_policy,
          lifecycle: row.lifecycle,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async findMeshHumanRole(
    meshId: string,
    accountId: string,
  ): Promise<"owner" | "steward" | "observer" | null> {
    const row = this.db
      .prepare(
        "SELECT role FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?",
      )
      .get(meshId, accountId) as
      | { role: "owner" | "steward" | "observer" }
      | undefined;
    return row?.role ?? null;
  }

  async listTopicsForAgent(meshId: string, agentId: string): Promise<RepositoryAgentTopic[]> {
    const mesh = this.db
      .prepare("SELECT id, visibility, lifecycle FROM meshes WHERE id = ?")
      .get(meshId) as { id: string; visibility: string; lifecycle: string } | undefined;
    if (!mesh || mesh.lifecycle !== "active") throw new Error("mesh_not_found");
    const membership = this.db
      .prepare("SELECT 1 AS joined FROM mesh_members WHERE mesh_id = ? AND agent_id = ?")
      .get(meshId, agentId);
    if (mesh.visibility !== "public" && !membership) throw new Error("mesh_access_denied");
    const agent = this.db.prepare("SELECT attention_json FROM agents WHERE id = ?").get(agentId) as
      | { attention_json: string }
      | undefined;
    if (!agent) throw new Error("agent_not_found");
    let attention: Record<string, unknown> = {};
    try {
      attention = JSON.parse(agent.attention_json) as Record<string, unknown>;
    } catch {
      attention = {};
    }
    const browse = String(attention.browse ?? "");
    if (browse !== "public" && browse !== "joined") throw new Error("attention_policy_denied");
    if (browse === "joined" && !membership) throw new Error("attention_policy_denied");
    return (this.db.prepare(
      `SELECT t.id, t.mesh_id, t.name, t.title, t.description, t.tags_json, t.created_at,
              EXISTS(SELECT 1 FROM follows f WHERE f.topic_id = t.id AND f.agent_id = ?) AS followed
       FROM topics t WHERE t.mesh_id = ? ORDER BY t.title, t.id`,
    ).all(agentId, meshId) as Array<Record<string, string | number>>).map((row) => {
      let tags: string[] = [];
      try {
        const parsed = JSON.parse(String(row.tags_json));
        if (Array.isArray(parsed)) tags = parsed.map(String);
      } catch {
        tags = [];
      }
      return {
        topic: {
          topicId: String(row.id),
          meshId: String(row.mesh_id),
          name: String(row.name),
          title: String(row.title),
          description: String(row.description),
          tags,
          createdAt: String(row.created_at),
        },
        followed: Number(row.followed) === 1,
      } satisfies RepositoryAgentTopic;
    });
  }

  private meshDirectoryEntryForAccount(
    meshId: string,
    accountId: string,
    limits: { members: number; topics: number; roles: number },
  ): RepositoryMeshDirectoryEntry | null {
    const row = this.db
      .prepare(
        `SELECT m.id, m.owner_account_id, m.name, m.description, m.visibility,
                m.join_policy, m.lifecycle, m.created_at, m.updated_at, r.role
         FROM meshes m
         LEFT JOIN mesh_human_roles r
           ON r.mesh_id = m.id AND r.account_id = ?
         WHERE m.id = ? AND m.lifecycle = 'active'
           AND (m.visibility = 'public' OR r.role IS NOT NULL)`,
      )
      .get(accountId, meshId) as Record<string, string | null> | undefined;
    if (!row) return null;

    const memberRows = this.db
      .prepare(
        `SELECT agent_id FROM mesh_members
         WHERE mesh_id = ? ORDER BY agent_id LIMIT ?`,
      )
      .all(meshId, Math.max(0, limits.members) + 1) as Array<{
      agent_id: string;
    }>;
    const topicRows = this.db
      .prepare(
        `SELECT id, mesh_id, name, title, description, tags_json, created_at
         FROM topics WHERE mesh_id = ? ORDER BY title, id LIMIT ?`,
      )
      .all(meshId, Math.max(0, limits.topics) + 1) as Array<
      Record<string, string>
    >;
    const roleRows = this.db
      .prepare(
        `SELECT r.account_id, r.role, r.created_at, r.updated_at,
                a.display_name, a.email
         FROM mesh_human_roles r
         JOIN accounts a ON a.id = r.account_id
         WHERE r.mesh_id = ? ORDER BY r.role, r.account_id LIMIT ?`,
      )
      .all(meshId, Math.max(0, limits.roles) + 1) as Array<
      Record<string, string>
    >;
    const truncated =
      memberRows.length > limits.members ||
      topicRows.length > limits.topics ||
      roleRows.length > limits.roles;
    const role =
      row.role === "owner" ||
      row.role === "steward" ||
      row.role === "observer"
        ? row.role
        : null;
    return {
      mesh: {
        meshId: String(row.id),
        ownerAccountId:
          row.owner_account_id == null ? null : String(row.owner_account_id),
        name: String(row.name),
        description: String(row.description),
        visibility: String(row.visibility) as RepositoryMeshInput["visibility"],
        admission: String(row.join_policy) as RepositoryMeshInput["admission"],
        lifecycle: String(row.lifecycle) as RepositoryMeshInput["lifecycle"],
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at || row.created_at),
      },
      role,
      memberAgentIds: memberRows
        .slice(0, limits.members)
        .map((member) => member.agent_id),
      topics: topicRows.slice(0, limits.topics).map((topicRow) => {
        let tags: string[] = [];
        try {
          const parsed = JSON.parse(String(topicRow.tags_json ?? "[]")) as unknown;
          if (Array.isArray(parsed)) tags = parsed.map(String);
        } catch {
          tags = [];
        }
        return {
          topic: {
            topicId: String(topicRow.id),
            meshId: String(topicRow.mesh_id),
            name: String(topicRow.name),
            title: String(topicRow.title),
            description: String(topicRow.description),
            tags,
            createdAt: String(topicRow.created_at),
          },
          // Aggregate activity is refreshed through /v1/activity/public. The
          // navigation directory must not scan the retained post table.
          activityCount: 0,
          recentActivityCount: 0,
          participantAgentIds: [],
          lastActivityAt: null,
        };
      }),
      roles: roleRows.slice(0, limits.roles).map((roleRow) => ({
        accountId: String(roleRow.account_id),
        role: String(roleRow.role) as "owner" | "steward" | "observer",
        displayName: String(roleRow.display_name),
        email: String(roleRow.email),
        createdAt: String(roleRow.created_at),
        updatedAt: String(roleRow.updated_at),
      })),
      ...(truncated ? { truncated: true } : {}),
    };
  }

  async listMeshDirectoryForAccount(
    accountId: string,
  ): Promise<RepositoryMeshDirectoryEntry[]> {
    const candidates = this.db
      .prepare(
        `SELECT m.id
         FROM meshes m
         LEFT JOIN mesh_human_roles r
           ON r.mesh_id = m.id AND r.account_id = ?
         WHERE m.lifecycle = 'active'
           AND (m.visibility = 'public' OR r.role IS NOT NULL)
         ORDER BY CASE WHEN r.role IS NULL THEN 1 ELSE 0 END,
                  m.created_at, m.id
         LIMIT ?`,
      )
      .all(accountId, MAX_MESH_DIRECTORY_ENTRIES + 1) as Array<{ id: string }>;
    const directoryTruncated = candidates.length > MAX_MESH_DIRECTORY_ENTRIES;
    let membersRemaining = MAX_MESH_DIRECTORY_MEMBER_ROWS;
    let topicsRemaining = MAX_MESH_DIRECTORY_TOPIC_ROWS;
    let rolesRemaining = MAX_MESH_DIRECTORY_ROLE_ROWS;
    const entries: RepositoryMeshDirectoryEntry[] = [];
    for (const candidate of candidates.slice(0, MAX_MESH_DIRECTORY_ENTRIES)) {
      const entry = this.meshDirectoryEntryForAccount(candidate.id, accountId, {
        members: membersRemaining,
        topics: topicsRemaining,
        roles: rolesRemaining,
      });
      if (!entry) continue;
      membersRemaining = Math.max(
        0,
        membersRemaining - entry.memberAgentIds.length,
      );
      topicsRemaining = Math.max(0, topicsRemaining - entry.topics.length);
      rolesRemaining = Math.max(0, rolesRemaining - entry.roles.length);
      entries.push(
        directoryTruncated || entry.truncated
          ? { ...entry, truncated: true }
          : entry,
      );
    }
    return entries;
  }

  async findMeshDirectoryEntryForAccount(
    meshId: string,
    accountId: string,
  ): Promise<RepositoryMeshDirectoryEntry | null> {
    return this.meshDirectoryEntryForAccount(meshId, accountId, {
      members: MAX_MESH_DETAIL_MEMBER_ROWS,
      topics: MAX_TOPICS_PER_MESH,
      roles: MAX_MESH_DETAIL_ROLE_ROWS,
    });
  }

  async listPublicMeshes(): Promise<RepositoryPublicMeshDirectory> {
    const rows = this.db.prepare(
      `SELECT id, owner_account_id, name, description, visibility, join_policy,
              lifecycle, created_at, updated_at
       FROM meshes WHERE visibility = 'public' AND lifecycle = 'active'
       ORDER BY name, id LIMIT ?`,
    ).all(MAX_MESH_DIRECTORY_ENTRIES + 1) as Array<
      Record<string, string | null>
    >;
    return {
      meshes: rows.slice(0, MAX_MESH_DIRECTORY_ENTRIES).map((row) => ({
      meshId: String(row.id),
      ownerAccountId: row.owner_account_id == null ? null : String(row.owner_account_id),
      name: String(row.name),
      description: String(row.description),
      visibility: "public",
      admission: String(row.join_policy) as RepositoryMeshInput["admission"],
      lifecycle: String(row.lifecycle) as RepositoryMeshInput["lifecycle"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at || row.created_at),
      })),
      truncated: rows.length > MAX_MESH_DIRECTORY_ENTRIES,
    };
  }

  async listPublicTopics(
    meshId: string,
  ): Promise<RepositoryPublicTopicDirectory> {
    return this.database.transaction(() => {
      const mesh = this.db
        .prepare(
          "SELECT 1 AS present FROM meshes WHERE id = ? AND visibility = 'public' AND lifecycle = 'active'",
        )
        .get(meshId);
      if (!mesh) throw new Error("mesh_not_found");
      const rows = this.db.prepare(
        `SELECT id, mesh_id, name, title, description, tags_json, created_at
         FROM topics WHERE mesh_id = ? ORDER BY title, id LIMIT ?`,
      ).all(meshId, MAX_TOPICS_PER_MESH + 1) as Array<Record<string, string>>;
      return {
        topics: rows.slice(0, MAX_TOPICS_PER_MESH).map((row) => {
          let tags: string[] = [];
          try {
            const parsed = JSON.parse(String(row.tags_json));
            if (Array.isArray(parsed)) tags = parsed.map(String);
          } catch {
            tags = [];
          }
          return {
            topicId: String(row.id),
            meshId: String(row.mesh_id),
            name: String(row.name),
            title: String(row.title),
            description: String(row.description),
            tags,
            createdAt: String(row.created_at),
          };
        }),
        truncated: rows.length > MAX_TOPICS_PER_MESH,
      };
    });
  }

  async upsertMeshHumanRole(input: {
    meshId: string;
    accountId: string;
    role: "owner" | "steward" | "observer";
    createdAt: string;
    updatedAt: string;
    actingAccountId?: string;
    humanSessionHash?: string;
  } & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      if (input.actingAccountId) {
        this.assertHumanGovernance(input.meshId, input.actingAccountId, input.humanSessionHash, ["owner"], input.updatedAt);
      }
      const existing = this.db
        .prepare("SELECT role FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?")
        .get(input.meshId, input.accountId) as { role: string } | undefined;
      // Keep the local compatibility adapter aligned with Firestore: a
      // human-authorized update cannot create a new membership without a
      // recipient-accepted role invitation.
      if (input.actingAccountId && !existing) {
        throw new Error("role_invitation_required");
      }
      const mesh = this.db
        .prepare("SELECT owner_account_id FROM meshes WHERE id = ?")
        .get(input.meshId) as { owner_account_id: string | null } | undefined;
      if (!mesh) throw new Error("mesh_not_found");
      if (input.role === "owner" && existing?.role !== "owner") {
        if (!existing) throw new Error("owner_transfer_requires_member");
        const owned = this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM mesh_human_roles WHERE account_id = ? AND role = 'owner'",
          )
          .get(input.accountId) as { count: number };
        if (owned.count >= 10) throw new Error("mesh_limit_reached");
        const previousOwnerId = mesh?.owner_account_id;
        if (previousOwnerId && previousOwnerId !== input.accountId) {
          this.db.prepare(
            `UPDATE mesh_human_roles SET role = 'steward', updated_at = ?
             WHERE mesh_id = ? AND account_id = ? AND role = 'owner'`,
          ).run(input.updatedAt, input.meshId, previousOwnerId);
        }
        this.db.prepare(
          "UPDATE meshes SET owner_account_id = ? WHERE id = ?",
        ).run(input.accountId, input.meshId);
      } else if (existing?.role === "owner" && input.role !== "owner") {
        const owners = this.db
          .prepare("SELECT account_id FROM mesh_human_roles WHERE mesh_id = ? AND role = 'owner'")
          .all(input.meshId) as Array<{ account_id: string }>;
        if (owners.length <= 1) throw new Error("last_owner");
        if (mesh?.owner_account_id === input.accountId) {
          const replacement = owners
            .map((owner) => owner.account_id)
            .filter((accountId) => accountId !== input.accountId)
            .sort()[0];
          if (!replacement) throw new Error("last_owner");
          this.db.prepare("UPDATE meshes SET owner_account_id = ? WHERE id = ?")
            .run(replacement, input.meshId);
        }
      }
      this.db.prepare(
        `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(mesh_id, account_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      ).run(input.meshId, input.accountId, input.role, input.createdAt, input.updatedAt);
      this.writeMutationArtifacts(input);
    });
  }

  async deleteMeshHumanRole(
    meshId: string,
    accountId: string,
    actingAccountId?: string,
    humanSessionHash?: string,
    event?: RepositoryEventInput,
    audit?: RepositoryAuditInput,
  ): Promise<void> {
    this.database.transaction(() => {
      const existing = this.db
        .prepare("SELECT role FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?")
        .get(meshId, accountId) as { role: string } | undefined;
      if (!existing) return;

      const updatedAt = this.now();
      if (actingAccountId) {
        this.assertHumanGovernance(meshId, actingAccountId, humanSessionHash, ["owner"], updatedAt);
      }

      const mesh = this.db
        .prepare("SELECT owner_account_id FROM meshes WHERE id = ?")
        .get(meshId) as { owner_account_id: string | null } | undefined;
      if (existing.role === "owner") {
        const owners = this.db
          .prepare("SELECT account_id FROM mesh_human_roles WHERE mesh_id = ? AND role = 'owner'")
          .all(meshId) as Array<{ account_id: string }>;
        if (owners.length <= 1) throw new Error("last_owner");
        if (mesh?.owner_account_id === accountId) {
          const replacement = owners
            .map((owner) => owner.account_id)
            .filter((candidate) => candidate !== accountId)
            .sort()[0];
          if (!replacement) throw new Error("last_owner");
          this.db.prepare("UPDATE meshes SET owner_account_id = ? WHERE id = ?")
            .run(replacement, meshId);
        }
      }

      this.db.prepare("DELETE FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?")
        .run(meshId, accountId);
      this.writeMutationArtifacts({ event, audit });
    });
  }

  async upsertMeshAgentMembership(input: {
    meshId: string;
    agentId: string;
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
    admissionProvenance: "open" | "approval" | "invite";
    joinedAt: string | null;
    updatedAt: string;
    actingAccountId?: string;
    humanSessionHash?: string;
  } & RepositoryMutationArtifacts): Promise<{ changed: boolean }> {
    return this.database.transaction(() => {
      if (input.actingAccountId) {
        this.assertHumanGovernance(
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          ["owner", "steward"],
          input.updatedAt,
        );
      }
      const existing = this.db.prepare(
        `SELECT status FROM mesh_agent_memberships
         WHERE mesh_id = ? AND agent_id = ?`,
      ).get(input.meshId, input.agentId) as { status: string } | undefined;
      if (
        input.status === "removed" &&
        (!existing || !["joined", "pending"].includes(existing.status))
      ) {
        return { changed: false };
      }
      if (input.status === "removed") {
        this.db.prepare(
          `UPDATE mesh_agent_memberships
           SET status = 'removed', updated_at = ?
           WHERE mesh_id = ? AND agent_id = ?`,
        ).run(input.updatedAt, input.meshId, input.agentId);
        this.db.prepare(
          "DELETE FROM mesh_members WHERE mesh_id = ? AND agent_id = ?",
        ).run(input.meshId, input.agentId);
        this.writeMutationArtifacts(input);
        return { changed: true };
      }
      this.db.prepare(
        `INSERT INTO mesh_agent_memberships(
           mesh_id, agent_id, status, attention_policy_json,
           admission_provenance, joined_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mesh_id, agent_id) DO UPDATE SET
           status = excluded.status,
           attention_policy_json = excluded.attention_policy_json,
           admission_provenance = excluded.admission_provenance,
           joined_at = COALESCE(mesh_agent_memberships.joined_at, excluded.joined_at),
           updated_at = excluded.updated_at`,
      ).run(
        input.meshId,
        input.agentId,
        input.status,
        JSON.stringify(input.attentionPolicy),
        input.admissionProvenance,
        input.joinedAt,
        input.updatedAt,
      );
      if (input.status === "joined") {
        this.db.prepare(
          `INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)
           ON CONFLICT(mesh_id, agent_id) DO UPDATE SET joined_at = COALESCE(mesh_members.joined_at, excluded.joined_at)`,
        ).run(input.meshId, input.agentId, input.joinedAt ?? input.updatedAt);
      } else {
        // mesh_members is intentionally the active-only projection used by
        // older local read paths. The full state above remains durable for
        // conformance and recovery checks.
        this.db.prepare("DELETE FROM mesh_members WHERE mesh_id = ? AND agent_id = ?")
          .run(input.meshId, input.agentId);
      }
      this.writeMutationArtifacts(input);
      return { changed: true };
    });
  }

  async findMeshAgentMembership(meshId: string, agentId: string): Promise<{
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
  } | null> {
    const row = this.db.prepare(
      `SELECT status, attention_policy_json
       FROM mesh_agent_memberships
       WHERE mesh_id = ? AND agent_id = ?`,
    ).get(meshId, agentId) as { status: "joined" | "pending" | "left" | "removed"; attention_policy_json: string } | undefined;
    if (!row) return null;
    let attentionPolicy: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.attention_policy_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        attentionPolicy = parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve the durable row while treating malformed local fixture data
      // as an empty policy, matching the Firestore adapter's defensive read.
    }
    return { status: row.status, attentionPolicy };
  }

  async joinMeshForAgent(input: {
    meshId: string;
    agentId: string;
    ownerAccountId: string;
    sessionId: string;
    authorityEpoch: number;
    runtimeKind: RuntimeKind;
    idempotencyKey: string;
    requestId: string;
    requestedAt: string;
    invitationTokenHash?: string;
  }): Promise<{ status: "joined" | "pending"; requestId?: string; duplicate: boolean }> {
    return this.database.transaction(() => {
      const requestHash = createHash("sha256")
        .update(JSON.stringify({
          meshId: input.meshId,
          invitationTokenHash: input.invitationTokenHash ?? null,
        }))
        .digest("hex");
      // A replayed idempotency key is still an authenticated mutation. Check
      // the current native session and authority fence before returning the
      // cached response; otherwise a superseded token could keep replaying an
      // old successful join indefinitely.
      const active = this.db.prepare(
        `SELECT s.agent_id
         FROM agent_sessions s
         JOIN agent_authority aa ON aa.agent_id = s.agent_id
           AND aa.authority_kind = 'native'
           AND aa.session_id = s.session_id
           AND aa.epoch = s.authority_epoch
         WHERE s.session_id = ? AND s.agent_id = ? AND s.runtime_kind = ?
           AND s.authority_epoch = ? AND s.status = 'active'
           AND s.expires_at > ? AND s.last_seen_at >= ?`,
      ).get(
        input.sessionId,
        input.agentId,
        input.runtimeKind,
        input.authorityEpoch,
        input.requestedAt,
        new Date(Date.parse(input.requestedAt) - 90_000).toISOString(),
      ) as { agent_id: string } | undefined;
      if (!active) throw new Error("session_invalid");
      const agent = this.db.prepare(
        "SELECT owner_account_id, attention_json FROM agents WHERE id = ?",
      ).get(input.agentId) as {
        owner_account_id: string;
        attention_json: string;
      } | undefined;
      if (!agent) throw new Error("agent_not_found");
      if (agent.owner_account_id !== input.ownerAccountId) throw new Error("agent_access_denied");
      const durableAttention = requireJoinCapableAttentionPolicy(agent.attention_json);
      const existingIdempotency = this.db.prepare(
        `SELECT request_hash, response_status, response_json
         FROM idempotency_records
         WHERE agent_id = ? AND operation = 'mesh.join' AND idempotency_key = ?`,
      ).get(input.agentId, input.idempotencyKey) as {
        request_hash: string;
        response_status: number;
        response_json: string;
      } | undefined;
      if (existingIdempotency) {
        if (existingIdempotency.request_hash !== requestHash) throw new Error("idempotency_conflict");
        const body = JSON.parse(existingIdempotency.response_json) as Record<string, unknown>;
        return {
          status: existingIdempotency.response_status === 202 ? "pending" : "joined",
          ...(typeof body.requestId === "string" ? { requestId: body.requestId } : {}),
          duplicate: true,
        };
      }
      const mesh = this.db.prepare(
        "SELECT join_policy, lifecycle FROM meshes WHERE id = ?",
      ).get(input.meshId) as {
        join_policy: "open" | "approval" | "invite_only";
        lifecycle: RepositoryMeshInput["lifecycle"];
      } | undefined;
      if (!mesh) throw new Error("mesh_not_found");
      if (mesh.lifecycle !== "active") throw new Error("mesh_unavailable");
      const membership = this.db.prepare(
        "SELECT 1 AS joined FROM mesh_members WHERE mesh_id = ? AND agent_id = ?",
      ).get(input.meshId, input.agentId);
      if (membership) {
        const body = { meshId: input.meshId, status: "joined" as const };
        this.db.prepare(
          `INSERT INTO idempotency_records(
             agent_id, operation, idempotency_key, request_hash,
             response_status, response_json, created_at
           ) VALUES(?, 'mesh.join', ?, ?, 201, ?, ?)`,
        ).run(input.agentId, input.idempotencyKey, requestHash, JSON.stringify(body), input.requestedAt);
        return { status: "joined", duplicate: false };
      }
      let invitationId: string | null = null;
      if (mesh.join_policy === "invite_only") {
        if (!input.invitationTokenHash) throw new Error("invite_required");
        const invitation = this.db.prepare(
          `SELECT id, invited_agent_id, status, expires_at
           FROM mesh_invitations WHERE token_hash = ? AND mesh_id = ? LIMIT 1`,
        ).get(input.invitationTokenHash, input.meshId) as {
          id: string;
          invited_agent_id: string | null;
          status: RepositoryMeshInvitation["status"];
          expires_at: string;
        } | undefined;
        if (!invitation) throw new Error("invitation_invalid");
        if (invitation.status !== "active") {
          if (invitation.status === "redeemed") throw new Error("invitation_redeemed");
          if (invitation.status === "revoked") throw new Error("invitation_revoked");
          if (invitation.status === "expired") throw new Error("invitation_expired");
          throw new Error("invitation_invalid");
        }
        if (Date.parse(invitation.expires_at) <= Date.parse(input.requestedAt)) {
          this.db.prepare(
            "UPDATE mesh_invitations SET status = 'expired' WHERE id = ? AND status = 'active'",
          ).run(invitation.id);
          throw new Error("invitation_expired");
        }
        if (invitation.invited_agent_id && invitation.invited_agent_id !== input.agentId) {
          throw new Error("invitation_invalid");
        }
        invitationId = invitation.id;
      }
      let responseStatus: 201 | 202;
      let body: Record<string, unknown>;
      if (mesh.join_policy === "approval") {
        const existingRequest = this.db.prepare(
          `SELECT id FROM mesh_join_requests
           WHERE mesh_id = ? AND agent_id = ? AND status = 'pending'
           ORDER BY created_at, id LIMIT 1`,
        ).get(input.meshId, input.agentId) as { id: string } | undefined;
        const requestId = existingRequest?.id ?? input.requestId;
        if (!existingRequest) {
          this.db.prepare(
            `INSERT INTO mesh_join_requests(
               id, mesh_id, agent_id, requested_by_account_id, status, created_at
             ) VALUES(?, ?, ?, ?, 'pending', ?)
             ON CONFLICT(id) DO UPDATE SET status = 'pending', resolved_at = NULL`,
          ).run(requestId, input.meshId, input.agentId, input.ownerAccountId, input.requestedAt);
        }
        this.db.prepare(
          `INSERT INTO mesh_agent_memberships(
             mesh_id, agent_id, status, attention_policy_json,
             admission_provenance, joined_at, updated_at
           ) VALUES(?, ?, 'pending', ?, 'approval', NULL, ?)
           ON CONFLICT(mesh_id, agent_id) DO UPDATE SET
             status = 'pending', attention_policy_json = excluded.attention_policy_json,
             admission_provenance = 'approval', updated_at = excluded.updated_at`,
        ).run(input.meshId, input.agentId, JSON.stringify(durableAttention), input.requestedAt);
        responseStatus = 202;
        body = { meshId: input.meshId, requestId, status: "pending" };
        if (!existingRequest) {
          const eventId = `evt_${createHash("sha256")
            .update(`mesh.join_requested:${input.meshId}:${input.agentId}:${requestId}`)
            .digest("hex")
            .slice(0, 40)}`;
          this.db.prepare(
            `INSERT INTO events(type, mesh_id, topic_id, agent_id, data_json, created_at)
             VALUES('mesh.join_requested', ?, NULL, ?, ?, ?)`,
          ).run(input.meshId, input.agentId, JSON.stringify(body), input.requestedAt);
          this.db.prepare(
            `INSERT OR IGNORE INTO outbox_events(
               event_id, schema_version, type, mesh_id, topic_id, agent_id, session_id,
               runtime_kind, payload_json, status, attempts, created_at
             ) VALUES(?, 1, 'mesh.join_requested', ?, NULL, ?, ?, ?, ?, 'pending', 0, ?)`,
          ).run(
            eventId,
            input.meshId,
            input.agentId,
            input.sessionId,
            input.runtimeKind,
            JSON.stringify(body),
            input.requestedAt,
          );
        }
      } else {
        const joinedCount = this.db.prepare(
          "SELECT COUNT(*) AS count FROM mesh_members WHERE agent_id = ?",
        ).get(input.agentId) as { count: number };
        if (Number(joinedCount.count) >= 100) throw new Error("agent_mesh_limit_reached");
        this.db.prepare(
          `INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)
           ON CONFLICT(mesh_id, agent_id) DO UPDATE SET joined_at = COALESCE(mesh_members.joined_at, excluded.joined_at)`,
        ).run(input.meshId, input.agentId, input.requestedAt);
        this.db.prepare(
          `INSERT INTO mesh_agent_memberships(
             mesh_id, agent_id, status, attention_policy_json,
             admission_provenance, joined_at, updated_at
           ) VALUES(?, ?, 'joined', ?, ?, ?, ?)
           ON CONFLICT(mesh_id, agent_id) DO UPDATE SET
             status = 'joined', attention_policy_json = excluded.attention_policy_json,
             admission_provenance = excluded.admission_provenance,
             joined_at = COALESCE(mesh_agent_memberships.joined_at, excluded.joined_at),
             updated_at = excluded.updated_at`,
        ).run(
          input.meshId,
          input.agentId,
          JSON.stringify(durableAttention),
          invitationId ? "invite" : "open",
          input.requestedAt,
          input.requestedAt,
        );
        if (invitationId) {
          const redeemed = this.db.prepare(
            `UPDATE mesh_invitations
             SET status = 'redeemed', redeemed_at = ?, redeemed_agent_id = ?
             WHERE id = ? AND status = 'active'`,
          ).run(input.requestedAt, input.agentId, invitationId);
          if (redeemed.changes !== 1) throw new Error("invitation_invalid");
        }
        responseStatus = 201;
        body = { meshId: input.meshId, status: "joined", ...(invitationId ? { invitationId } : {}) };
        const eventId = `evt_${createHash("sha256")
          .update(`mesh.agent.joined:${input.meshId}:${input.agentId}:${input.idempotencyKey}`)
          .digest("hex")
          .slice(0, 40)}`;
        this.db.prepare(
          `INSERT INTO events(type, mesh_id, topic_id, agent_id, data_json, created_at)
           VALUES('mesh.agent.joined', ?, NULL, ?, ?, ?)`,
        ).run(input.meshId, input.agentId, JSON.stringify(body), input.requestedAt);
        this.db.prepare(
          `INSERT OR IGNORE INTO outbox_events(
             event_id, schema_version, type, mesh_id, topic_id, agent_id, session_id,
             runtime_kind, payload_json, status, attempts, created_at
           ) VALUES(?, 1, 'mesh.agent.joined', ?, NULL, ?, ?, ?, ?, 'pending', 0, ?)`,
        ).run(
          eventId,
          input.meshId,
          input.agentId,
          input.sessionId,
          input.runtimeKind,
          JSON.stringify(body),
          input.requestedAt,
        );
      }
      this.db.prepare(
        `INSERT INTO idempotency_records(
           agent_id, operation, idempotency_key, request_hash,
           response_status, response_json, created_at
         ) VALUES(?, 'mesh.join', ?, ?, ?, ?, ?)`,
      ).run(input.agentId, input.idempotencyKey, requestHash, responseStatus, JSON.stringify(body), input.requestedAt);
      return {
        status: responseStatus === 202 ? "pending" : "joined",
        ...(responseStatus === 202 && typeof body.requestId === "string"
          ? { requestId: body.requestId }
          : {}),
        duplicate: false,
      };
    });
  }

  async createMeshInvitation(input: {
    invitationId: string;
    meshId: string;
    tokenHash: string;
    invitedAgentId: string | null;
    createdByAccountId: string;
    createdAt: string;
    expiresAt: string;
    actingAccountId: string;
    humanSessionHash: string;
  } & RepositoryMutationArtifacts): Promise<RepositoryMeshInvitation> {
    return this.database.transaction(() => {
      const mesh = this.db.prepare(
        "SELECT lifecycle FROM meshes WHERE id = ?",
      ).get(input.meshId) as { lifecycle: RepositoryMeshInput["lifecycle"] } | undefined;
      if (!mesh || mesh.lifecycle !== "active") throw new Error("mesh_not_found");
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.createdAt,
      );
      const active = this.db.prepare(
        "SELECT COUNT(*) AS count FROM mesh_invitations WHERE mesh_id = ? AND status = 'active' AND expires_at > ?",
      ).get(input.meshId, input.createdAt) as { count: number };
      if (Number(active.count) >= 50) throw new Error("invitation_limit_reached");
      if (input.invitedAgentId) {
        const agent = this.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(input.invitedAgentId);
        if (!agent) throw new Error("agent_not_found");
      }
      this.db.prepare(
        `INSERT INTO mesh_invitations(
           id, mesh_id, token_hash, invited_agent_id, created_by_account_id,
           status, created_at, expires_at, redeemed_at, redeemed_agent_id
         ) VALUES(?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
      ).run(
        input.invitationId,
        input.meshId,
        input.tokenHash,
        input.invitedAgentId,
        input.createdByAccountId,
        input.createdAt,
        input.expiresAt,
      );
      this.writeMutationArtifacts(input);
      return {
        invitationId: input.invitationId,
        meshId: input.meshId,
        invitedAgentId: input.invitedAgentId,
        createdByAccountId: input.createdByAccountId,
        status: "active",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        redeemedAt: null,
        redeemedAgentId: null,
      } satisfies RepositoryMeshInvitation;
    });
  }

  async listMeshInvitations(meshId: string): Promise<RepositoryMeshInvitation[]> {
    const now = Date.parse(this.now());
    const rows = this.db.prepare(
      `SELECT id, mesh_id, invited_agent_id, created_by_account_id, status,
              created_at, expires_at, redeemed_at, redeemed_agent_id
       FROM mesh_invitations WHERE mesh_id = ? ORDER BY created_at DESC, id ASC`,
    ).all(meshId) as Array<Record<string, string | null>>;
    return rows.map((row) => {
      const status = String(row.status) as RepositoryMeshInvitation["status"];
      return {
        invitationId: String(row.id),
        meshId: String(row.mesh_id),
        invitedAgentId: row.invited_agent_id == null ? null : String(row.invited_agent_id),
        createdByAccountId: String(row.created_by_account_id),
        status: status === "active" && Date.parse(String(row.expires_at)) <= now ? "expired" : status,
        createdAt: String(row.created_at),
        expiresAt: String(row.expires_at),
        redeemedAt: row.redeemed_at == null ? null : String(row.redeemed_at),
        redeemedAgentId: row.redeemed_agent_id == null ? null : String(row.redeemed_agent_id),
      } satisfies RepositoryMeshInvitation;
    });
  }

  async revokeMeshInvitation(input: {
    invitationId: string;
    meshId: string;
    revokedAt: string;
    actingAccountId: string;
    humanSessionHash: string;
  } & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.revokedAt,
      );
      const result = this.db.prepare(
        `UPDATE mesh_invitations SET status = 'revoked'
         WHERE id = ? AND mesh_id = ? AND status = 'active'`,
      ).run(input.invitationId, input.meshId);
      if (result.changes !== 1) throw new Error("invitation_not_active");
      this.writeMutationArtifacts(input);
    });
  }

  private roleInvitationFromRow(
    row: Record<string, string | null>,
    now = this.now(),
  ): RepositoryMeshRoleInvitation {
    const status = String(row.status) as RepositoryMeshRoleInvitation["status"];
    const expiresAt = String(row.expires_at);
    return {
      invitationId: String(row.id),
      meshId: String(row.mesh_id),
      role: String(row.role) as RepositoryMeshRoleInvitation["role"],
      createdByAccountId: String(row.created_by_account_id),
      status: status === "active" && Date.parse(expiresAt) <= Date.parse(now) ? "expired" : status,
      createdAt: String(row.created_at),
      expiresAt,
      redeemedAt: row.redeemed_at == null ? null : String(row.redeemed_at),
      redeemedByAccountId: row.redeemed_by_account_id == null ? null : String(row.redeemed_by_account_id),
    };
  }

  async createMeshRoleInvitation(input: {
    invitationId: string;
    meshId: string;
    tokenHash: string;
    targetEmailHash: string;
    role: "owner" | "steward" | "observer";
    createdByAccountId: string;
    createdAt: string;
    expiresAt: string;
    actingAccountId: string;
    humanSessionHash: string;
  } & RepositoryMutationArtifacts): Promise<RepositoryMeshRoleInvitation> {
    return this.database.transaction(() => {
      const mesh = this.db.prepare("SELECT id, lifecycle FROM meshes WHERE id = ?").get(input.meshId) as
        | { id: string; lifecycle: RepositoryMeshInput["lifecycle"] }
        | undefined;
      if (!mesh || mesh.lifecycle !== "active") throw new Error("mesh_not_found");
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner"],
        input.createdAt,
      );
      const active = this.db.prepare(
        "SELECT COUNT(*) AS count FROM mesh_role_invitations WHERE mesh_id = ? AND status = 'active' AND expires_at > ?",
      ).get(input.meshId, input.createdAt) as { count: number };
      if (Number(active.count) >= 50) throw new Error("role_invitation_limit_reached");
      if (this.db.prepare("SELECT 1 FROM mesh_role_invitations WHERE id = ?").get(input.invitationId)) {
        throw new Error("role_invitation_already_exists");
      }
      this.db.prepare(
        `INSERT INTO mesh_role_invitations(
           id, mesh_id, token_hash, target_email_hash, role, created_by_account_id,
           status, created_at, expires_at, redeemed_at, redeemed_by_account_id
         ) VALUES(?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
      ).run(
        input.invitationId,
        input.meshId,
        input.tokenHash,
        input.targetEmailHash,
        input.role,
        input.createdByAccountId,
        input.createdAt,
        input.expiresAt,
      );
      this.writeMutationArtifacts(input);
      return {
        invitationId: input.invitationId,
        meshId: input.meshId,
        role: input.role,
        createdByAccountId: input.createdByAccountId,
        status: "active",
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        redeemedAt: null,
        redeemedByAccountId: null,
      } satisfies RepositoryMeshRoleInvitation;
    });
  }

  async listMeshRoleInvitationsForEmail(
    targetEmailHash: string,
  ): Promise<RepositoryMeshRoleInvitation[]> {
    const rows = this.db.prepare(
      `SELECT id, mesh_id, role, created_by_account_id, status, created_at,
              expires_at, redeemed_at, redeemed_by_account_id
       FROM mesh_role_invitations WHERE target_email_hash = ? ORDER BY created_at DESC, id ASC
       LIMIT 100`,
    ).all(targetEmailHash) as Array<Record<string, string | null>>;
    return rows.map((row) => this.roleInvitationFromRow(row));
  }

  async findMeshRoleInvitation(input: {
    invitationId: string;
    targetEmailHash: string;
  }): Promise<RepositoryMeshRoleInvitation | null> {
    const row = this.db.prepare(
      `SELECT id, mesh_id, role, created_by_account_id, status, created_at,
              expires_at, redeemed_at, redeemed_by_account_id
       FROM mesh_role_invitations
       WHERE id = ? AND target_email_hash = ?
       LIMIT 1`,
    ).get(input.invitationId, input.targetEmailHash) as Record<string, string | null> | undefined;
    return row ? this.roleInvitationFromRow(row) : null;
  }

  async listMeshRoleInvitations(meshId: string): Promise<RepositoryMeshRoleInvitation[]> {
    const rows = this.db.prepare(
      `SELECT id, mesh_id, role, created_by_account_id, status, created_at,
              expires_at, redeemed_at, redeemed_by_account_id
       FROM mesh_role_invitations WHERE mesh_id = ? ORDER BY created_at DESC, id ASC
       LIMIT 100`,
    ).all(meshId) as Array<Record<string, string | null>>;
    return rows.map((row) => this.roleInvitationFromRow(row));
  }

  async revokeMeshRoleInvitation(input: {
    invitationId: string;
    meshId: string;
    revokedAt: string;
    actingAccountId: string;
    humanSessionHash: string;
  } & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner"],
        input.revokedAt,
      );
      const result = this.db.prepare(
        `UPDATE mesh_role_invitations SET status = 'revoked'
         WHERE id = ? AND mesh_id = ? AND status = 'active'`,
      ).run(input.invitationId, input.meshId);
      if (result.changes !== 1) throw new Error("role_invitation_not_active");
      this.writeMutationArtifacts(input);
    });
  }

  async acceptMeshRoleInvitation(input: {
    invitationId: string;
    tokenHash: string;
    targetEmailHash?: string;
    accountId: string;
    humanSessionHash: string;
    acceptedAt: string;
    idempotencyKey?: string;
    requestHash?: string;
  } & RepositoryMutationArtifacts): Promise<{
    invitation: RepositoryMeshRoleInvitation;
    role: "owner" | "steward" | "observer";
    duplicate: boolean;
  }> {
    return this.database.transaction(() => {
      this.assertHumanSession(input.accountId, input.humanSessionHash, input.acceptedAt);
      const row = this.db.prepare(
        `SELECT id, mesh_id, token_hash, target_email_hash, role, created_by_account_id,
                status, created_at, expires_at, redeemed_at, redeemed_by_account_id
         FROM mesh_role_invitations WHERE id = ?`,
      ).get(input.invitationId) as Record<string, string | null> | undefined;
      if (!row) throw new Error("role_invitation_not_found");
      if (String(row.token_hash) !== input.tokenHash) throw new Error("role_invitation_invalid");
      const account = this.db.prepare("SELECT email FROM accounts WHERE id = ?").get(input.accountId) as
        | { email: string }
        | undefined;
      if (!account) throw new Error("account_not_found");
      const expectedTargetEmailHash = input.targetEmailHash ??
        hmacSha256(account.email.trim().toLowerCase(), this.invitationPepper);
      if (expectedTargetEmailHash !== String(row.target_email_hash)) {
        throw new Error("role_invitation_target_mismatch");
      }
      const existingInvitation = this.roleInvitationFromRow(row, input.acceptedAt);
      if (existingInvitation.status === "redeemed") {
        if (existingInvitation.redeemedByAccountId === input.accountId) {
          return { invitation: existingInvitation, role: existingInvitation.role, duplicate: true };
        }
        throw new Error("role_invitation_redeemed");
      }
      if (existingInvitation.status === "revoked") throw new Error("role_invitation_revoked");
      if (existingInvitation.status === "expired" || Date.parse(existingInvitation.expiresAt) <= Date.parse(input.acceptedAt)) {
        throw new Error("role_invitation_expired");
      }
      const meshId = String(row.mesh_id);
      const mesh = this.db.prepare("SELECT owner_account_id FROM meshes WHERE id = ?").get(meshId) as
        | { owner_account_id: string | null }
        | undefined;
      if (!mesh) throw new Error("mesh_not_found");
      const role = String(row.role) as "owner" | "steward" | "observer";
      const transferringOwnerId = String(row.created_by_account_id);
      const currentOwner = this.db.prepare(
        "SELECT role FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?",
      ).get(meshId, transferringOwnerId) as { role: string } | undefined;
      if (mesh.owner_account_id !== transferringOwnerId || currentOwner?.role !== "owner") {
        throw new Error("role_invitation_inviter_not_owner");
      }
      const targetRole = this.db.prepare(
        "SELECT role, created_at FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?",
      ).get(meshId, input.accountId) as { role: string; created_at: string } | undefined;
      if (targetRole?.role === "owner" && role !== "owner") throw new Error("owner_role_protected");
      if (role === "owner") {
        if (input.accountId !== transferringOwnerId && targetRole?.role !== "owner") {
          const owned = this.db.prepare(
            "SELECT COUNT(*) AS count FROM mesh_human_roles WHERE account_id = ? AND role = 'owner'",
          ).get(input.accountId) as { count: number };
          if (Number(owned.count) >= 10) throw new Error("mesh_limit_reached");
          this.db.prepare(
            "UPDATE mesh_human_roles SET role = 'steward', updated_at = ? WHERE mesh_id = ? AND account_id = ?",
          ).run(input.acceptedAt, meshId, transferringOwnerId);
          this.db.prepare("UPDATE meshes SET owner_account_id = ? WHERE id = ?")
            .run(input.accountId, meshId);
        }
      }
      this.db.prepare(
        `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(mesh_id, account_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      ).run(meshId, input.accountId, role, targetRole?.created_at ?? input.acceptedAt, input.acceptedAt);
      this.db.prepare(
        `UPDATE mesh_role_invitations
         SET status = 'redeemed', redeemed_at = ?, redeemed_by_account_id = ?
         WHERE id = ? AND status = 'active'`,
      ).run(input.acceptedAt, input.accountId, input.invitationId);
      this.writeMutationArtifacts(input);
      return {
        invitation: {
          ...existingInvitation,
          status: "redeemed",
          redeemedAt: input.acceptedAt,
          redeemedByAccountId: input.accountId,
        },
        role,
        duplicate: false,
      };
    });
  }

  async upsertJoinRequest(input: {
    requestId: string;
    meshId: string;
    agentId: string;
    requestedByAccountId: string;
    status: "pending" | "approved" | "denied" | "cancelled";
    createdAt: string;
    resolvedAt: string | null;
    actingAccountId?: string;
    humanSessionHash?: string;
  } & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      const mesh = this.db.prepare(
        "SELECT lifecycle FROM meshes WHERE id = ?",
      ).get(input.meshId) as { lifecycle: RepositoryMeshInput["lifecycle"] } | undefined;
      if (!mesh) throw new Error("mesh_not_found");
      const agent = this.db.prepare(
        "SELECT owner_account_id FROM agents WHERE id = ?",
      ).get(input.agentId) as { owner_account_id: string } | undefined;
      if (!agent || agent.owner_account_id !== input.requestedByAccountId) {
        throw new Error("agent_access_denied");
      }
      if (input.actingAccountId) {
        this.assertHumanGovernance(
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          ["owner", "steward"],
          // Authorization is evaluated at commit time. The request's
          // client-supplied creation timestamp must not resurrect an expired
          // human session in the local conformance adapter.
          this.now(),
        );
      } else if (input.status !== "pending") {
        // A native agent may only create/retain its own pending request. Any
        // resolution is a human governance mutation and must carry the
        // authenticated owner/steward session above.
        throw new Error("mesh_governance_denied");
      }
      const existing = this.db.prepare(
        "SELECT created_at FROM mesh_join_requests WHERE id = ?",
      ).get(input.requestId) as { created_at: string } | undefined;
      this.db.prepare(
        `INSERT INTO mesh_join_requests(
           id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           resolved_at = excluded.resolved_at`,
      ).run(
        input.requestId,
        input.meshId,
        input.agentId,
        input.requestedByAccountId,
        input.status,
        existing?.created_at ?? input.createdAt,
        input.resolvedAt,
      );
      this.writeMutationArtifacts(input);
    });
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
    actingAccountId?: string;
    humanSessionHash?: string;
  } & RepositoryMutationArtifacts): Promise<{ agentId: string; status: "approved" | "denied" }> {
    return this.database.transaction(() => {
      const pending = this.db.prepare(
        `SELECT agent_id FROM mesh_join_requests
         WHERE id = ? AND mesh_id = ? AND status = 'pending'`,
      ).get(input.requestId, input.meshId) as { agent_id: string } | undefined;
      if (!pending) throw new Error("join_request_not_pending");
      // Resolve is a human governance mutation. Re-check the role and the
      // exact session inside the same SQLite transaction as the status change
      // so a concurrent revoke/demotion cannot approve a request.
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.resolvedAt,
      );
      let approvalAttentionJson: string | undefined;
      if (input.decision === "approved") {
        const mesh = this.db.prepare(
          "SELECT join_policy, lifecycle FROM meshes WHERE id = ?",
        ).get(input.meshId) as {
          join_policy: RepositoryMeshInput["admission"];
          lifecycle: RepositoryMeshInput["lifecycle"];
        } | undefined;
        if (!mesh) throw new Error("mesh_not_found");
        if (mesh.lifecycle !== "active") throw new Error("mesh_unavailable");
        if (mesh.join_policy !== "approval")
          throw new Error("mesh_admission_changed");
        const agent = this.db.prepare(
          "SELECT attention_json FROM agents WHERE id = ?",
        ).get(pending.agent_id) as { attention_json: string } | undefined;
        if (!agent) throw new Error("agent_not_found");
        requireJoinCapableAttentionPolicy(agent.attention_json);
        approvalAttentionJson = agent.attention_json;
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
        this.db.prepare(
          `INSERT INTO mesh_agent_memberships(
             mesh_id, agent_id, status, attention_policy_json,
             admission_provenance, joined_at, updated_at
           ) VALUES(?, ?, 'joined', ?, 'approval', ?, ?)
           ON CONFLICT(mesh_id, agent_id) DO UPDATE SET
             status = 'joined',
             attention_policy_json = COALESCE(NULLIF(mesh_agent_memberships.attention_policy_json, '{}'), excluded.attention_policy_json),
             admission_provenance = 'approval',
             joined_at = COALESCE(mesh_agent_memberships.joined_at, excluded.joined_at),
             updated_at = excluded.updated_at`,
        ).run(
          input.meshId,
          pending.agent_id,
          approvalAttentionJson!,
          input.resolvedAt,
          input.resolvedAt,
        );
      }
      this.writeMutationArtifacts(input);
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

  async listHumanActivityPreferences(accountId: string): Promise<RepositoryHumanActivityPreference[]> {
    const rows = this.db.prepare(
      `SELECT account_id, kind, resource_id, watching, muted, updated_at
       FROM human_activity_preferences
       WHERE account_id = ?
       ORDER BY updated_at DESC, kind ASC, resource_id ASC`,
    ).all(accountId) as Array<{
      account_id: string;
      kind: RepositoryHumanActivityPreference["kind"];
      resource_id: string;
      watching: number;
      muted: number;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      kind: row.kind,
      resourceId: row.resource_id,
      watching: row.watching === 1,
      muted: row.muted === 1,
      updatedAt: row.updated_at,
    }));
  }

  async upsertHumanActivityPreference(
    input: RepositoryHumanActivityPreferencePatch,
  ): Promise<RepositoryHumanActivityPreference> {
    return this.database.transaction(() => {
      this.assertHumanSession(input.accountId, input.humanSessionHash, input.updatedAt);
      const mesh = this.db.prepare(
        "SELECT visibility, lifecycle FROM meshes WHERE id = ?",
      ).get(input.meshId) as { visibility: RepositoryMeshInput["visibility"]; lifecycle: string } | undefined;
      if (!mesh || mesh.lifecycle !== "active") throw new Error("mesh_not_found");
      if (input.kind === "topic") {
        const topic = this.db.prepare(
          "SELECT mesh_id FROM topics WHERE id = ?",
        ).get(input.resourceId) as { mesh_id: string } | undefined;
        if (!topic || topic.mesh_id !== input.meshId) throw new Error("topic_not_found");
      }
      if (mesh.visibility !== "public") {
        const role = this.db.prepare(
          "SELECT 1 AS present FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?",
        ).get(input.meshId, input.accountId);
        if (!role) throw new Error("mesh_access_denied");
      }
      const existing = this.db.prepare(
        `SELECT watching, muted FROM human_activity_preferences
         WHERE account_id = ? AND kind = ? AND resource_id = ?`,
      ).get(input.accountId, input.kind, input.resourceId) as
        | { watching: number; muted: number }
        | undefined;
      const preference: RepositoryHumanActivityPreference = {
        accountId: input.accountId,
        kind: input.kind,
        resourceId: input.resourceId,
        watching: input.watching ?? (existing?.watching === 1),
        muted: input.muted ?? (existing?.muted === 1),
        updatedAt: input.updatedAt,
      };
      if (!preference.watching && !preference.muted) {
        this.db.prepare(
          `DELETE FROM human_activity_preferences
           WHERE account_id = ? AND kind = ? AND resource_id = ?`,
        ).run(preference.accountId, preference.kind, preference.resourceId);
        return preference;
      }
      if (!existing) {
        const count = this.db.prepare(
          "SELECT COUNT(*) AS count FROM human_activity_preferences WHERE account_id = ?",
        ).get(input.accountId) as { count: number };
        if (Number(count.count) >= MAX_ACTIVITY_PREFERENCES_PER_ACCOUNT) {
          throw new Error("activity_preference_limit_reached");
        }
      }
      this.db.prepare(
        `INSERT INTO human_activity_preferences(
           account_id, kind, resource_id, watching, muted, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, kind, resource_id) DO UPDATE SET
           watching = excluded.watching,
           muted = excluded.muted,
           updated_at = excluded.updated_at`,
      ).run(
        preference.accountId,
        preference.kind,
        preference.resourceId,
        preference.watching ? 1 : 0,
        preference.muted ? 1 : 0,
        preference.updatedAt,
      );
      return preference;
    });
  }

  async revokeHumanSession(tokenHash: string, _revokedAt?: string): Promise<void> {
    this.db.prepare("DELETE FROM human_sessions WHERE token_hash = ?").run(tokenHash);
  }

  async revokeWebMcpGrants(humanSessionHash: string, revokedAt: string): Promise<void> {
    this.database.transaction(() => {
      const session = this.db
        .prepare("SELECT 1 AS present FROM human_sessions WHERE token_hash = ?")
        .get(humanSessionHash) as { present: number } | undefined;
      // Logout removes the human session first in the compatibility path;
      // its foreign-key cascade has already removed grants and the fence.
      if (!session) return;
      const activeGrant = this.db
        .prepare(
          `SELECT 1 AS present FROM webmcp_grants
           WHERE human_session_hash = ? AND revoked_at IS NULL LIMIT 1`,
        )
        .get(humanSessionHash);
      const fence = this.db
        .prepare(
          `SELECT epoch, grant_id, agent_id, session_id, revoked_at
           FROM webmcp_authority WHERE human_session_hash = ?`,
        )
        .get(humanSessionHash) as
        | {
            epoch: number;
            grant_id: string | null;
            agent_id: string | null;
            session_id: string | null;
            revoked_at: string | null;
          }
        | undefined;
      if (
        !activeGrant &&
        (!fence ||
          (fence.revoked_at != null &&
            fence.grant_id == null &&
            fence.agent_id == null &&
            fence.session_id == null))
      ) {
        return;
      }
      this.db
        .prepare(
          "UPDATE webmcp_grants SET revoked_at = ? WHERE human_session_hash = ? AND revoked_at IS NULL",
        )
        .run(revokedAt, humanSessionHash);
      this.db.prepare(
        `INSERT INTO webmcp_authority(
           human_session_hash, epoch, grant_id, agent_id, session_id, updated_at, revoked_at
         ) VALUES(?, ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(human_session_hash) DO UPDATE SET
           epoch = excluded.epoch, grant_id = NULL, agent_id = NULL, session_id = NULL,
           updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`,
      ).run(humanSessionHash, (fence?.epoch ?? 0) + 1, revokedAt, revokedAt);
    });
  }

  async upsertModerationCase(input: RepositoryModerationCase & {
    actingAccountId?: string;
    humanSessionHash?: string;
    actingAgentId?: string;
    agentSessionId?: string;
    agentAuthorityEpoch?: number;
    idempotencyKey?: string;
    requestHash?: string;
    idempotencyOperation?: "moderation.report" | "moderation.action";
  } & RepositoryMutationArtifacts): Promise<RepositoryModerationMutationResult> {
    const write = () => {
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
    };
    if (!input.actingAccountId && !input.humanSessionHash && !input.actingAgentId) {
      return this.database.transaction(() => {
        write();
        this.writeMutationArtifacts(input);
        return { duplicate: false };
      });
    }
    return this.database.transaction(() => {
      const humanOperation = input.idempotencyOperation ?? "moderation.action";
      const humanIdempotent = Boolean(input.actingAccountId && (input.idempotencyKey || input.requestHash));
      const humanAction = humanIdempotent && humanOperation === "moderation.action";
      if (input.actingAgentId) {
        const post = this.db.prepare(
          `SELECT agent_id, mesh_id, moderation_state
           FROM posts WHERE id = ?`,
        ).get(input.postId) as
          | { agent_id: string; mesh_id: string; moderation_state: string }
          | undefined;
        if (
          !post ||
          post.agent_id !== input.actingAgentId ||
          post.mesh_id !== input.meshId ||
          post.moderation_state === "published"
        ) throw new Error("post_authorization_denied");
        const authority = this.db.prepare(
          `SELECT epoch, authority_kind, session_id
           FROM agent_authority WHERE agent_id = ?`,
        ).get(input.actingAgentId) as
          | { epoch: number; authority_kind: string; session_id: string }
          | undefined;
        const session = input.agentSessionId
          ? this.db.prepare(
              `SELECT agent_id, authority_epoch, status, expires_at, last_seen_at
               FROM agent_sessions WHERE session_id = ?`,
            ).get(input.agentSessionId) as
              | { agent_id: string; authority_epoch: number; status: string; expires_at: string; last_seen_at: string }
              | undefined
          : undefined;
        const nowMs = Date.parse(input.updatedAt);
        if (
          !authority || authority.authority_kind !== "native" ||
          authority.session_id !== input.agentSessionId ||
          Number(authority.epoch) !== Number(input.agentAuthorityEpoch) ||
          !session || session.agent_id !== input.actingAgentId ||
          session.status !== "active" ||
          Number(session.authority_epoch) !== Number(input.agentAuthorityEpoch) ||
          !Number.isFinite(nowMs) ||
          Date.parse(session.expires_at) <= nowMs ||
          Date.parse(session.last_seen_at) < nowMs - 90_000
        ) throw new Error("session_invalid");
        if (!input.idempotencyKey || !input.requestHash) {
          throw new Error("idempotency_required");
        }
        const existing = this.db.prepare(
          `SELECT request_hash FROM idempotency_records
           WHERE agent_id = ? AND operation = 'post.appeal' AND idempotency_key = ?`,
        ).get(input.actingAgentId, input.idempotencyKey) as { request_hash: string } | undefined;
        if (existing) {
          if (existing.request_hash !== input.requestHash) throw new Error("idempotency_conflict");
          return { duplicate: true };
        }
      } else {
        this.assertHumanModerator(
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          input.updatedAt,
        );
        if (input.idempotencyKey || input.requestHash) {
          if (!input.idempotencyKey || !input.requestHash || !input.actingAccountId) {
            throw new Error("idempotency_required");
          }
          const existing = this.db.prepare(
            `SELECT request_hash, response_json, expires_at
             FROM human_idempotency_records
             WHERE account_id = ? AND operation = ? AND idempotency_key = ?`,
          ).get(input.actingAccountId, humanOperation, input.idempotencyKey) as {
            request_hash: string;
            response_json: string;
            expires_at: string;
          } | undefined;
          if (existing) {
            if (!constantTimeStringEqual(existing.request_hash, input.requestHash)) {
              throw new Error("idempotency_conflict");
            }
            if (Date.parse(existing.expires_at) <= Date.parse(input.updatedAt)) {
              throw new Error("idempotency_expired");
            }
            let reference: Record<string, unknown> = {};
            try {
              reference = JSON.parse(existing.response_json) as Record<string, unknown>;
            } catch {
              throw new Error("idempotency_expired");
            }
            const replayCase = this.moderationCaseRecord(
              typeof reference.caseId === "string" ? reference.caseId : input.caseId,
            );
            const replayPost = this.postRecord(
              typeof reference.postId === "string" ? reference.postId : input.postId,
            );
            if (!replayCase || !replayPost) throw new Error("idempotency_expired");
            this.assertModerationReplayMatches(reference, replayCase, replayPost);
            return { duplicate: true, moderationCase: replayCase, post: replayPost };
          }
        }
      }

      const currentCase = this.moderationCaseRecord(input.caseId);
      if (currentCase && (currentCase.postId !== input.postId || currentCase.meshId !== input.meshId)) {
        throw new Error("moderation_case_mismatch");
      }
      const post = this.postRecord(input.postId);
      // Internal queue fixtures and legacy moderation workers may create a
      // case before the retained post projection arrives. The public HTTP
      // report/action routes always provide a key and therefore take the
      // post-bound branch below; preserve the unkeyed repository contract
      // without allowing a keyed mutation to proceed without its post.
      if (!post && !humanIdempotent) {
        write();
        this.writeMutationArtifacts({ event: input.event, audit: input.audit });
        return { duplicate: false };
      }
      if (!post || post.meshId !== input.meshId) throw new Error("post_not_found");
      if (humanAction) {
        if (!currentCase || (currentCase.state !== "queued" && currentCase.state !== "appealed")) {
          throw new Error("moderation_transition_conflict");
        }
        const authoritativeCase: RepositoryModerationCase = {
          ...currentCase,
          reason: input.reason,
          state: "reviewing",
          resolution: null,
          updatedAt: input.updatedAt,
          resolvedAt: null,
        };
        this.db.prepare(
          `UPDATE moderation_cases SET reason = ?, state = 'reviewing', updated_at = ?,
             resolved_at = NULL, resolution = NULL WHERE id = ?`,
        ).run(authoritativeCase.reason, authoritativeCase.updatedAt, authoritativeCase.caseId);
        this.writeMutationArtifacts(this.moderationArtifacts(
          input.event,
          input.audit,
          post,
          post.moderationState,
        ));
        this.db.prepare(
          `INSERT INTO human_idempotency_records(
             account_id, operation, idempotency_key, request_hash,
             response_status, response_json, created_at, expires_at
           ) VALUES(?, ?, ?, ?, 200, ?, ?, ?)`,
        ).run(
          input.actingAccountId!,
          humanOperation,
          input.idempotencyKey!,
          input.requestHash!,
          this.moderationIdempotencyResponse(
            authoritativeCase,
            this.postRecord(input.postId)!,
          ),
          input.updatedAt,
          this.moderationIdempotencyExpiry(input.updatedAt, post.expiresAt),
        );
        return {
          duplicate: false,
          moderationCase: authoritativeCase,
          post: this.postRecord(input.postId),
        };
      }

      write();
      this.writeMutationArtifacts({ event: input.event, audit: input.audit });
      if (input.actingAgentId && input.idempotencyKey && input.requestHash) {
        this.db.prepare(
          `INSERT INTO idempotency_records(
             agent_id, operation, idempotency_key, request_hash,
             response_status, response_json, created_at
           ) VALUES(?, 'post.appeal', ?, ?, 202, ?, ?)`,
        ).run(
          input.actingAgentId,
          input.idempotencyKey,
          input.requestHash,
          JSON.stringify({ caseId: input.caseId, postId: input.postId, reason: input.reason }),
          input.updatedAt,
        );
      }
      if (humanIdempotent) {
        const resultCase = this.moderationCaseRecord(input.caseId);
        const resultPost = this.postRecord(input.postId);
        if (!resultCase || !resultPost) throw new Error("post_not_found");
        this.db.prepare(
          `INSERT INTO human_idempotency_records(
             account_id, operation, idempotency_key, request_hash,
             response_status, response_json, created_at, expires_at
           ) VALUES(?, ?, ?, ?, 202, ?, ?, ?)`,
        ).run(
          input.actingAccountId!,
          humanOperation,
          input.idempotencyKey!,
          input.requestHash!,
        this.moderationIdempotencyResponse(resultCase, resultPost),
          input.updatedAt,
          this.moderationIdempotencyExpiry(input.updatedAt, resultPost.expiresAt),
        );
        return { duplicate: false, moderationCase: resultCase, post: resultPost };
      }
      return { duplicate: false };
    });
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
    return (await this.listModerationCasesPage({ meshId, limit: 500 })).cases;
  }

  async listModerationCasesPage(input: {
    meshId: string;
    state?: RepositoryModerationCase["state"];
    after?: { updatedAt: string; caseId: string };
    limit: number;
  }): Promise<RepositoryModerationCasesPage> {
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
    const where = ["mesh_id = ?"];
    const params: Array<string | number> = [input.meshId];
    if (input.state) {
      where.push("state = ?");
      params.push(input.state);
    }
    if (input.after) {
      where.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      params.push(input.after.updatedAt, input.after.updatedAt, input.after.caseId);
    }
    const rows = this.db.prepare(
      `SELECT id, post_id, mesh_id, reason, state, severity, created_at,
              updated_at, resolved_at, resolution
       FROM moderation_cases WHERE ${where.join(" AND ")}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...params, limit + 1) as Array<{
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
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      cases: pageRows.map((row) => ({
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
      })),
      nextAfter: rows.length > limit && last
        ? { updatedAt: last.updated_at, caseId: last.id }
        : null,
    };
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
    actingAccountId: string;
    humanSessionHash: string;
    idempotencyKey?: string;
    requestHash?: string;
    automated?: {
      expectedPostState: RepositoryPostRecord["moderationState"];
      expectedPostUpdatedAt: string;
    };
  } & RepositoryMutationArtifacts): Promise<RepositoryModerationMutationResult> {
    return this.database.transaction(() => {
      const post = this.postRecord(input.postId);
      if (!post) throw new Error("post_not_found");
      const currentCase = this.moderationCaseRecord(input.caseId);
      if (currentCase && (currentCase.postId !== input.postId || currentCase.meshId !== post.meshId)) {
        throw new Error("moderation_case_mismatch");
      }
      if (input.automated) {
        if (input.actingAccountId !== "moderation-worker" || input.humanSessionHash !== "internal") {
          throw new Error("moderation_authorization_denied");
        }
      } else {
        this.assertHumanModerator(
          post.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          input.updatedAt,
        );
      }

      const keyedAction = Boolean(input.idempotencyKey || input.requestHash);
      if (keyedAction) {
        if (!input.idempotencyKey || !input.requestHash) throw new Error("idempotency_required");
        const existing = input.automated
          ? this.db.prepare(
              `SELECT request_hash, response_json, expires_at
               FROM automated_idempotency_records
               WHERE operation = 'moderation.action' AND idempotency_key = ?`,
            ).get(input.idempotencyKey)
          : this.db.prepare(
              `SELECT request_hash, response_json, expires_at
               FROM human_idempotency_records
               WHERE account_id = ? AND operation = 'moderation.action' AND idempotency_key = ?`,
            ).get(input.actingAccountId, input.idempotencyKey) as {
          request_hash: string;
          response_json: string;
          expires_at: string;
        } | undefined;
        const typedExisting = existing as {
          request_hash: string;
          response_json: string;
          expires_at: string;
        } | undefined;
        if (typedExisting) {
          if (!constantTimeStringEqual(typedExisting.request_hash, input.requestHash)) {
            throw new Error("idempotency_conflict");
          }
          if (Date.parse(typedExisting.expires_at) <= Date.parse(input.updatedAt)) {
            throw new Error("idempotency_expired");
          }
          let reference: Record<string, unknown> = {};
          try {
            reference = JSON.parse(typedExisting.response_json) as Record<string, unknown>;
          } catch {
            throw new Error("idempotency_expired");
          }
          const replayCase = this.moderationCaseRecord(
            typeof reference.caseId === "string" ? reference.caseId : input.caseId,
          );
          const replayPost = this.postRecord(
            typeof reference.postId === "string" ? reference.postId : input.postId,
          );
          if (!replayCase || !replayPost) throw new Error("idempotency_expired");
          this.assertModerationReplayMatches(reference, replayCase, replayPost);
          return { duplicate: true, moderationCase: replayCase, post: replayPost };
        }
        if (input.automated && (
          post.moderationState !== input.automated.expectedPostState ||
          post.updatedAt !== input.automated.expectedPostUpdatedAt ||
          !currentCase ||
          !["queued", "appealed"].includes(currentCase.state)
        )) {
          throw new Error("moderation_transition_conflict");
        }
        if (!currentCase || !["queued", "appealed", "reviewing"].includes(currentCase.state)) {
          throw new Error("moderation_transition_conflict");
        }
        if (input.caseState !== "resolved") throw new Error("moderation_transition_conflict");
      }

      // A post can have more than one report (for example, from an owner and
      // a steward). Resolve the selected case and supersede every other live
      // case in the same transaction so a stale queue item cannot later
      // overwrite the post's moderation decision.
      const supersededSiblingRows = keyedAction && input.caseState === "resolved"
        ? this.db.prepare(
            `SELECT id FROM moderation_cases
             WHERE post_id = ? AND id <> ?
               AND state IN ('queued', 'reviewing', 'appealed')
             ORDER BY created_at ASC, id ASC`,
          ).all(input.postId, input.caseId) as Array<{ id: string }>
        : [];

      if (input.body === undefined) {
        this.db.prepare(
          "UPDATE posts SET moderation_state = ?, moderation_reason = ? WHERE id = ?",
        ).run(input.state, input.reason, input.postId);
      } else {
        this.db.prepare(
          "UPDATE posts SET moderation_state = ?, moderation_reason = ?, body = ? WHERE id = ?",
        ).run(input.state, input.reason, input.body, input.postId);
      }
      const nextCase: RepositoryModerationCase = {
        ...(currentCase ?? {
          caseId: input.caseId,
          postId: input.postId,
          meshId: post.meshId,
          reason: input.reason ?? "policy_review",
          state: "queued" as const,
          severity: "low" as const,
          resolution: null,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
          resolvedAt: null,
        }),
        reason: input.reason ?? currentCase?.reason ?? "policy_review",
        state: input.caseState,
        resolution: input.resolution,
        updatedAt: input.updatedAt,
        resolvedAt: input.caseState === "resolved" ? input.updatedAt : null,
      };
      this.db.prepare(
        `INSERT INTO moderation_cases(
           id, post_id, mesh_id, reason, state, severity, created_at, updated_at,
           resolved_at, resolution
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           reason = excluded.reason, state = excluded.state, updated_at = excluded.updated_at,
           resolved_at = excluded.resolved_at, resolution = excluded.resolution`,
      ).run(
        nextCase.caseId,
        nextCase.postId,
        nextCase.meshId,
        nextCase.reason,
        nextCase.state,
        nextCase.severity,
        nextCase.createdAt,
        nextCase.updatedAt,
        nextCase.resolvedAt,
        nextCase.resolution,
      );
      if (supersededSiblingRows.length > 0) {
        this.db.prepare(
          `UPDATE moderation_cases
           SET state = 'resolved', resolution = 'superseded',
               resolved_at = ?, updated_at = ?
           WHERE post_id = ? AND id <> ?
             AND state IN ('queued', 'reviewing', 'appealed')`,
        ).run(input.updatedAt, input.updatedAt, input.postId, input.caseId);
      }
      const updatedPost = this.postRecord(input.postId);
      if (!updatedPost) throw new Error("post_not_found");
      const artifacts = this.moderationArtifacts(
        input.event,
        input.audit,
        post,
        input.state,
      );
      if (supersededSiblingRows.length > 0) {
        const supersededCaseIds = supersededSiblingRows.slice(0, 64).map((row) => row.id);
        if (artifacts.event) {
          const payload = artifacts.event.payload && typeof artifacts.event.payload === "object" && !Array.isArray(artifacts.event.payload)
            ? artifacts.event.payload as Record<string, unknown>
            : {};
          artifacts.event = {
            ...artifacts.event,
            payload: {
              ...payload,
              superseded_case_count: supersededSiblingRows.length,
              superseded_case_ids: supersededCaseIds,
            },
          };
        }
        if (artifacts.audit) {
          const data = artifacts.audit.data && typeof artifacts.audit.data === "object" && !Array.isArray(artifacts.audit.data)
            ? artifacts.audit.data as Record<string, unknown>
            : {};
          artifacts.audit = {
            ...artifacts.audit,
            data: {
              ...data,
              superseded_case_count: supersededSiblingRows.length,
              superseded_case_ids: supersededCaseIds,
            },
          };
        }
      }
      this.writeMutationArtifacts(artifacts);
      if (keyedAction) {
        if (input.automated) {
          this.db.prepare(
            `INSERT INTO automated_idempotency_records(
               operation, idempotency_key, request_hash,
               response_status, response_json, created_at, expires_at
             ) VALUES('moderation.action', ?, ?, 200, ?, ?, ?)`,
          ).run(
            input.idempotencyKey!,
            input.requestHash!,
            this.moderationIdempotencyResponse(nextCase, updatedPost),
            input.updatedAt,
            this.moderationIdempotencyExpiry(input.updatedAt, updatedPost.expiresAt),
          );
        } else {
          this.db.prepare(
            `INSERT INTO human_idempotency_records(
               account_id, operation, idempotency_key, request_hash,
               response_status, response_json, created_at, expires_at
             ) VALUES(?, 'moderation.action', ?, ?, 200, ?, ?, ?)`,
          ).run(
            input.actingAccountId,
            input.idempotencyKey!,
            input.requestHash!,
            this.moderationIdempotencyResponse(nextCase, updatedPost),
            input.updatedAt,
            this.moderationIdempotencyExpiry(input.updatedAt, updatedPost.expiresAt),
          );
        }
      }
      return { duplicate: false, moderationCase: nextCase, post: updatedPost };
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
      updatedAt: row.created_at,
      expiresAt: row.expires_at,
    } : null;
  }

  async listPublishedPostsByTopic(input: {
    topicId: string;
    now: string;
    after?: { createdAt: string; id: string };
    limit: number;
  }): Promise<RepositoryTopicPostsPage> {
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100);
    const latestWindow = !input.after;
    const rows = this.db.prepare(
      `SELECT id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
              moderation_state, moderation_reason, created_at, expires_at
       FROM posts
       WHERE topic_id = ? AND moderation_state = 'published'
         AND (expires_at IS NULL OR expires_at > ?)
         AND (
           ? IS NULL OR created_at > ? OR (created_at = ? AND id > ?)
         )
       ORDER BY created_at ${latestWindow ? "DESC" : "ASC"}, id ${latestWindow ? "DESC" : "ASC"} LIMIT ?`,
    ).all(
      input.topicId,
      input.now,
      input.after ? 0 : null,
      input.after?.createdAt ?? "",
      input.after?.createdAt ?? "",
      input.after?.id ?? "",
      limit,
    ) as Array<{
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
    }>;
    const posts = rows.map((row) => ({
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
    }));
    const orderedPosts = latestWindow ? posts.reverse() : posts;
    const newest = orderedPosts.at(-1);
    const agents = [...new Set(orderedPosts.map((post) => post.agentId))]
      .map((agentId) => this.db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as Record<string, any> | undefined)
      .filter((row): row is Record<string, any> => Boolean(row))
      .map((row) => ({
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
      }));
    const last = rows.at(-1);
    return {
      posts: orderedPosts,
      nextAfter: latestWindow ? newest
        ? { createdAt: newest.createdAt, id: newest.postId }
        : null : rows.length === limit && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
      agents,
    };
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

  async listAgentsForAccount(accountId: string): Promise<RepositoryAgentInput[]> {
    const rows = this.db
      .prepare("SELECT id FROM agents WHERE owner_account_id = ? ORDER BY created_at ASC, id ASC LIMIT 25")
      .all(accountId) as Array<{ id: string }>;
    const agents = await Promise.all(rows.map((row) => this.findAgentById(row.id)));
    return agents.filter((agent): agent is RepositoryAgentInput => agent !== null);
  }

  async listNativeBoundAgentIds(agentIds: string[]): Promise<string[]> {
    const unique = [...new Set(agentIds)].filter(Boolean);
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT agent_id, COUNT(*) AS binding_count
         FROM pairings
         WHERE agent_id IN (${placeholders})
           AND status IN ('approved', 'claimed')
         GROUP BY agent_id
         ORDER BY agent_id`,
      )
      .all(...unique) as Array<{ agent_id: string; binding_count: number }>;
    if (rows.some((row) => Number(row.binding_count) > 1)) {
      throw new Error("agent_authority_corrupt");
    }
    return rows.map((row) => row.agent_id);
  }

  async listRuntimeSessionsForAgents(
    agentIds: string[],
    now: string,
    offlineAfter: string,
  ): Promise<RepositoryRuntimeSession[]> {
    const unique = [...new Set(agentIds)].filter(Boolean);
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT token_hash, agent_id, pairing_id, session_id, runtime_kind,
              authority_epoch, created_at, expires_at, last_seen_at, status, superseded_by
       FROM agent_sessions
       WHERE agent_id IN (${placeholders}) AND status = 'active'
         AND expires_at > ? AND last_seen_at >= ?
       ORDER BY last_seen_at ASC, session_id ASC`,
    ).all(...unique, now, offlineAfter) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      tokenHash: String(row.token_hash ?? ""),
      agentId: String(row.agent_id),
      bindingId: String(row.pairing_id ?? ""),
      sessionId: String(row.session_id),
      runtimeKind: String(row.runtime_kind ?? "other") as RuntimeKind,
      authorityEpoch: Number(row.authority_epoch ?? 0),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      lastSeenAt: String(row.last_seen_at),
      status: String(row.status) as RepositoryRuntimeSession["status"],
      supersedingSessionId: row.superseded_by == null ? null : String(row.superseded_by),
    }));
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

  async findActiveWebMcpGrant(
    humanSessionHash: string,
    agentId: string,
  ): Promise<RepositoryWebMcpGrant | null> {
    const row = this.db
      .prepare(
        `SELECT wg.token_hash, wg.human_session_hash, wg.agent_id, wg.session_id, wg.authority_epoch,
                wg.created_at, wg.expires_at, wg.last_used_at, wg.revoked_at
         FROM webmcp_grants wg
         JOIN agent_authority aa
           ON aa.agent_id = wg.agent_id
          AND aa.authority_kind = 'page'
          AND aa.session_id = wg.session_id
          AND aa.epoch = wg.authority_epoch
         JOIN webmcp_authority wa
           ON wa.human_session_hash = wg.human_session_hash
          AND wa.grant_id = wg.token_hash
          AND wa.epoch = wg.authority_epoch
          AND wa.revoked_at IS NULL
         WHERE wg.human_session_hash = ? AND wg.agent_id = ?
           AND wg.revoked_at IS NULL AND wg.expires_at > ?
         ORDER BY wg.created_at DESC, wg.token_hash DESC
         LIMIT 1`,
      )
      .get(humanSessionHash, agentId, this.now()) as
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
             id, owner_account_id, name, description, visibility, join_policy,
             lifecycle, created_at, updated_at
           ) VALUES('mesh-public', NULL, 'Public mesh',
                    'The open commons for agent conversation.', 'public', 'open',
                    'active', ?, ?)`,
        )
        .run(now, now);
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

  async findAccountByEmail(email: string) {
    const row = this.db
      .prepare("SELECT id, email, display_name, created_at FROM accounts WHERE email = ? COLLATE NOCASE")
      .get(email.trim().toLowerCase()) as
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

  async createPasswordAccount(input: {
    accountId: string;
    email: string;
    displayName: string;
    passwordHash: string;
    createdAt: string;
  }) {
    try {
      this.db
        .prepare(
          `INSERT INTO accounts(id, email, display_name, password_hash, created_at)
           VALUES(?, ?, ?, ?, ?)`,
        )
        .run(
          input.accountId,
          input.email.trim().toLowerCase(),
          input.displayName,
          input.passwordHash,
          input.createdAt,
        );
    } catch (error) {
      if (error instanceof Error && /unique/i.test(error.message)) {
        throw new Error("account_exists");
      }
      throw error;
    }
    return {
      accountId: input.accountId,
      email: input.email.trim().toLowerCase(),
      displayName: input.displayName,
      createdAt: input.createdAt,
    };
  }

  async findPasswordAccountByEmail(email: string) {
    const row = this.db
      .prepare(
        `SELECT id, email, display_name, password_hash, created_at
         FROM accounts WHERE email = ? COLLATE NOCASE`,
      )
      .get(email.trim().toLowerCase()) as
      | {
          id: string;
          email: string;
          display_name: string;
          password_hash: string;
          created_at: string;
        }
      | undefined;
    if (!row || !row.password_hash) return null;
    return {
      account: {
        accountId: row.id,
        email: row.email,
        displayName: row.display_name,
        createdAt: row.created_at,
      },
      passwordHash: row.password_hash,
    };
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
    humanSessionHash?: string;
    reauthProvider?: SocialProvider;
    reauthSubject?: string;
    linkedAt?: string;
  }): Promise<void> {
    const now = input.linkedAt ?? this.now();
    this.database.transaction(() => {
      if ((input.reauthProvider === undefined) !== (input.reauthSubject === undefined)) {
        throw new Error("identity_reauthentication_required");
      }
      if (input.humanSessionHash) {
        try {
          this.assertHumanSession(input.accountId, input.humanSessionHash, now);
        } catch {
          throw new Error("human_session_invalid");
        }
      }
      if (input.reauthProvider && input.reauthSubject) {
        const reauth = this.db
          .prepare("SELECT account_id FROM provider_identities WHERE provider = ? AND subject = ?")
          .get(input.reauthProvider, input.reauthSubject) as { account_id: string } | undefined;
        if (!reauth || reauth.account_id !== input.accountId) {
          throw new Error("identity_reauthentication_required");
        }
      }
      const existing = this.db
        .prepare("SELECT account_id, email FROM provider_identities WHERE provider = ? AND subject = ?")
        .get(input.provider, input.subject) as { account_id: string; email: string } | undefined;
      if (existing && existing.account_id !== input.accountId) {
        throw new Error("identity_already_linked");
      }
      if (
        existing &&
        existing.account_id === input.accountId &&
        existing.email === input.email
      ) {
        return;
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

  async listProviderIdentities(accountId: string): Promise<Array<{
    provider: SocialProvider;
    email: string;
    linkedAt: string;
  }>> {
    const rows = this.db.prepare(
      `SELECT provider, email, created_at
       FROM provider_identities
       WHERE account_id = ?
       ORDER BY provider ASC`,
    ).all(accountId) as Array<{ provider: SocialProvider; email: string; created_at: string }>;
    return rows
      .filter((identity) => identity.provider === "google" || identity.provider === "github")
      .map((identity) => ({
        provider: identity.provider,
        email: identity.email,
        linkedAt: identity.created_at,
      }));
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
    expectedSessionId?: string;
    expectedAuthorityEpoch?: number;
    allowExpiredPredecessorRecovery?: boolean;
    claimPairing?: boolean;
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{ authorityEpoch: number }> {
    const now = this.now();
    return this.database.transaction(() => {
      const pairing = this.db
        .prepare("SELECT status, agent_id FROM pairings WHERE id = ?")
        .get(input.bindingId) as { status: string; agent_id: string | null } | undefined;
      if (
        !pairing ||
        (pairing.status !== "approved" && pairing.status !== "claimed") ||
        pairing.agent_id !== input.agentId
      ) {
        throw new Error("binding_invalid");
      }
      const currentAuthority = this.db
        .prepare("SELECT epoch, authority_kind, session_id FROM agent_authority WHERE agent_id = ?")
        .get(input.agentId) as { epoch: number; authority_kind: string; session_id: string } | undefined;
      if (input.expectedSessionId !== undefined || input.expectedAuthorityEpoch !== undefined) {
        if (
          !currentAuthority ||
          currentAuthority.authority_kind !== "native" ||
          currentAuthority.session_id !== input.expectedSessionId ||
          currentAuthority.epoch !== input.expectedAuthorityEpoch
        ) {
          throw new Error("session_superseded");
        }
        const predecessor = this.db.prepare(
          `SELECT status, agent_id, authority_epoch, expires_at
           FROM agent_sessions WHERE session_id = ?`,
        ).get(input.expectedSessionId) as
          | { status: string; agent_id: string; authority_epoch: number; expires_at: string }
          | undefined;
        if (
          !predecessor || predecessor.status !== "active" || predecessor.agent_id !== input.agentId ||
          predecessor.authority_epoch !== input.expectedAuthorityEpoch ||
          (Date.parse(predecessor.expires_at) <= Date.parse(now) &&
            !input.allowExpiredPredecessorRecovery)
        ) {
          throw new Error("session_invalid");
        }
      }
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
      // A page WebMCP handoff is a one-hour, non-renewing authority grant.
      // Keep a restarted native host from silently taking control back while
      // that grant remains active; the human must let it expire or revoke it.
      const activePageGrant = this.db
        .prepare(
          `SELECT 1 FROM webmcp_grants
           WHERE agent_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
        )
        .get(input.agentId, now);
      if (activePageGrant) throw new Error("page_authority_active");
      const authority = currentAuthority;
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
      if (input.claimPairing !== false) {
        this.db
          .prepare(
            `UPDATE pairings
             SET status = 'claimed', claimed_at = COALESCE(claimed_at, ?)
             WHERE id = ? AND status IN ('approved', 'claimed')`,
          )
          .run(now, input.bindingId);
      }
      this.writeMutationArtifacts({ event: input.event, audit: input.audit });
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
    sessionId: string;
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{ authorityEpoch: number; sessionId: string }> {
    const now = this.now();
    const nowMs = Date.parse(now);
    const grantExpiresAt = Date.parse(input.expiresAt);
    if (
      !Number.isFinite(grantExpiresAt) ||
      grantExpiresAt <= nowMs ||
      grantExpiresAt > nowMs + PAGE_AUTHORITY_GRANT_SECONDS * 1_000
    ) {
      throw new Error("page_grant_expiry_invalid");
    }
    const sessionId = input.sessionId;
    return this.database.transaction(() => {
      const humanSession = this.db
        .prepare(
          `SELECT account_id, expires_at, absolute_expires_at, last_seen_at
           FROM human_sessions WHERE token_hash = ?`,
        )
        .get(input.humanSessionHash) as
        | {
            account_id: string;
            expires_at: string;
            absolute_expires_at: string;
            last_seen_at: string;
          }
        | undefined;
      const agent = this.db
        .prepare("SELECT owner_account_id FROM agents WHERE id = ?")
        .get(input.agentId) as { owner_account_id: string } | undefined;
      const authority = this.db
        .prepare(
          "SELECT epoch, authority_kind, session_id FROM agent_authority WHERE agent_id = ?",
        )
        .get(input.agentId) as
        | { epoch: number; authority_kind: string; session_id: string }
        | undefined;
      const fence = this.db
        .prepare(
          `SELECT epoch, grant_id, agent_id, session_id, revoked_at
           FROM webmcp_authority WHERE human_session_hash = ?`,
        )
        .get(input.humanSessionHash) as
        | {
            epoch: number;
            grant_id: string | null;
            agent_id: string | null;
            session_id: string | null;
            revoked_at: string | null;
          }
        | undefined;
      const nativeSessions = this.db
        .prepare(
          `SELECT session_id, authority_epoch FROM agent_sessions
           WHERE agent_id = ? AND status = 'active' LIMIT 2`,
        )
        .all(input.agentId) as Array<{
        session_id: string;
        authority_epoch: number;
      }>;
      const humanGrants = this.db
        .prepare(
          `SELECT token_hash, agent_id, session_id, authority_epoch
           FROM webmcp_grants
           WHERE human_session_hash = ? AND revoked_at IS NULL LIMIT 2`,
        )
        .all(input.humanSessionHash) as Array<{
        token_hash: string;
        agent_id: string;
        session_id: string;
        authority_epoch: number;
      }>;
      const agentGrants = this.db
        .prepare(
          `SELECT token_hash, human_session_hash, session_id, authority_epoch
           FROM webmcp_grants
           WHERE agent_id = ? AND revoked_at IS NULL LIMIT 2`,
        )
        .all(input.agentId) as Array<{
        token_hash: string;
        human_session_hash: string;
        session_id: string;
        authority_epoch: number;
      }>;
      if (
        nativeSessions.length > 1 ||
        humanGrants.length > 1 ||
        agentGrants.length > 1
      ) {
        throw new Error("agent_authority_corrupt");
      }
      const humanExpiresAt = humanSession
        ? Date.parse(humanSession.expires_at)
        : NaN;
      const humanAbsoluteExpiresAt = humanSession
        ? Date.parse(humanSession.absolute_expires_at)
        : NaN;
      const humanLastSeenAt = humanSession
        ? Date.parse(humanSession.last_seen_at)
        : NaN;
      if (
        !humanSession ||
        !Number.isFinite(humanExpiresAt) ||
        !Number.isFinite(humanAbsoluteExpiresAt) ||
        !Number.isFinite(humanLastSeenAt) ||
        humanExpiresAt <= nowMs ||
        humanAbsoluteExpiresAt <= nowMs ||
        humanLastSeenAt <= nowMs - HUMAN_IDLE_SECONDS * 1_000 ||
        grantExpiresAt > humanExpiresAt ||
        grantExpiresAt > humanAbsoluteExpiresAt ||
        !agent ||
        agent.owner_account_id !== humanSession.account_id
      ) {
        throw new Error("session_invalid");
      }
      if (
        this.db
          .prepare("SELECT 1 AS present FROM webmcp_grants WHERE token_hash = ?")
          .get(input.grantId)
      ) {
        throw new Error("grant_already_exists");
      }

      const currentNative = nativeSessions[0];
      const currentAgentGrant = agentGrants[0];
      if (currentNative) {
        if (
          !authority ||
          authority.authority_kind !== "native" ||
          authority.session_id !== currentNative.session_id ||
          Number(authority.epoch) !== Number(currentNative.authority_epoch) ||
          currentAgentGrant
        ) {
          throw new Error("agent_authority_corrupt");
        }
      } else if (currentAgentGrant) {
        if (
          !authority ||
          authority.authority_kind !== "page" ||
          authority.session_id !== currentAgentGrant.session_id ||
          Number(authority.epoch) !==
            Number(currentAgentGrant.authority_epoch)
        ) {
          throw new Error("agent_authority_corrupt");
        }
      }

      const currentHumanGrant = humanGrants[0];
      if (
        currentHumanGrant &&
        (!fence ||
          fence.grant_id !== currentHumanGrant.token_hash ||
          fence.agent_id !== currentHumanGrant.agent_id ||
          fence.session_id !== currentHumanGrant.session_id ||
          fence.revoked_at !== null ||
          Number(fence.epoch) !== Number(currentHumanGrant.authority_epoch))
      ) {
        throw new Error("webmcp_authority_corrupt");
      }
      const epoch =
        Math.max(Number(fence?.epoch ?? 0), Number(authority?.epoch ?? 0)) + 1;
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
           WHERE (human_session_hash = ? OR agent_id = ?) AND revoked_at IS NULL`,
        )
        .run(now, input.humanSessionHash, input.agentId);
      this.db
        .prepare(
          `INSERT INTO webmcp_authority(
             human_session_hash, epoch, grant_id, agent_id, session_id, updated_at, revoked_at
           ) VALUES(?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(human_session_hash) DO UPDATE SET
             epoch = excluded.epoch, grant_id = excluded.grant_id,
             agent_id = excluded.agent_id, session_id = excluded.session_id,
             updated_at = excluded.updated_at, revoked_at = NULL`,
        )
        .run(input.humanSessionHash, epoch, input.grantId, input.agentId, sessionId, now);
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
      this.writeMutationArtifacts({ event: input.event, audit: input.audit });
      return { authorityEpoch: epoch, sessionId };
    });
  }

  async createPostWithOutbox(input: RepositoryPostInput) {
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
      const agent = this.db
        .prepare("SELECT created_at FROM agents WHERE id = ?")
        .get(input.agentId) as { created_at: string } | undefined;
      const priorPosts = this.db
        .prepare("SELECT COUNT(*) AS count FROM posts WHERE agent_id = ?")
        .get(input.agentId) as { count: number };
      const createdAtMs = Date.parse(agent?.created_at ?? "");
      const newIdentityReview = Number(priorPosts.count ?? 0) < NEW_IDENTITY_REVIEW_POSTS ||
        (Number.isFinite(createdAtMs) && createdAtMs >= Date.parse(now) - NEW_IDENTITY_REVIEW_WINDOW_MS);
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
             id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body, created_at,
             moderation_state, expires_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.postId,
          input.meshId,
          input.topicId,
          input.agentId,
          input.sessionId,
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
          JSON.stringify({
            post,
            reviewQueued: input.reviewQueued === true || newIdentityReview,
            ...(newIdentityReview ? { reviewReason: "new_identity" } : {}),
          }),
          now,
        );
      if (input.activity) {
        this.db
          .prepare(
            `INSERT INTO agent_activity_ledger(
               id, agent_id, kind, source, action, outcome, resource_type,
               resource_id, mesh_id, topic_id, failure_code, occurred_at
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.activity.activityId,
            input.activity.agentId,
            input.activity.kind,
            input.activity.source,
            input.activity.action,
            input.activity.outcome,
            input.activity.resourceType,
            input.activity.resourceId,
            input.activity.meshId,
            input.activity.topicId,
            input.activity.failureCode,
            now,
          );
      }
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
      return {
        duplicate: false,
        post,
        reviewQueued: input.reviewQueued === true || newIdentityReview,
      };
    });
  }

  async appendAgentActivities(
    inputs: RepositoryAgentActivityRecord[],
  ): Promise<{ inserted: number; duplicates: number }> {
    if (inputs.length > 100) throw new Error("activity_batch_too_large");
    return this.database.transaction(() => {
      let inserted = 0;
      let duplicates = 0;
      const select = this.db.prepare(
        `SELECT agent_id, kind, source, action, outcome, resource_type,
                resource_id, mesh_id, topic_id, failure_code, occurred_at
         FROM agent_activity_ledger WHERE id = ?`,
      );
      const insert = this.db.prepare(
        `INSERT INTO agent_activity_ledger(
           id, agent_id, kind, source, action, outcome, resource_type,
           resource_id, mesh_id, topic_id, failure_code, occurred_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const input of inputs) {
        const existing = select.get(input.activityId) as
          | Record<string, string | null>
          | undefined;
        const values = [
          input.agentId,
          input.kind,
          input.source,
          input.action,
          input.outcome,
          input.resourceType,
          input.resourceId,
          input.meshId,
          input.topicId,
          input.failureCode,
          input.occurredAt,
        ];
        if (existing) {
          const stored = [
            existing.agent_id,
            existing.kind,
            existing.source,
            existing.action,
            existing.outcome,
            existing.resource_type,
            existing.resource_id,
            existing.mesh_id,
            existing.topic_id,
            existing.failure_code,
          ];
          if (!isDeepStrictEqual(stored, values.slice(0, -1))) {
            throw new Error("activity_id_conflict");
          }
          duplicates += 1;
          continue;
        }
        insert.run(input.activityId, ...values);
        inserted += 1;
      }
      return { inserted, duplicates };
    });
  }

  async listAgentActivities(input: {
    agentId: string;
    after?: { occurredAt: string; id: string };
    limit: number;
  }): Promise<RepositoryAgentActivityPage> {
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 50);
    const rows = (input.after
      ? this.db
          .prepare(
            `SELECT * FROM agent_activity_ledger
             WHERE agent_id = ?
               AND (occurred_at < ? OR (occurred_at = ? AND id > ?))
             ORDER BY occurred_at DESC, id ASC LIMIT ?`,
          )
          .all(
            input.agentId,
            input.after.occurredAt,
            input.after.occurredAt,
            input.after.id,
            limit + 1,
          )
      : this.db
          .prepare(
            `SELECT * FROM agent_activity_ledger WHERE agent_id = ?
             ORDER BY occurred_at DESC, id ASC LIMIT ?`,
          )
          .all(input.agentId, limit + 1)) as Array<
      Record<string, string | null>
    >;
    const pageRows = rows.slice(0, limit);
    const earliest = this.db
      .prepare(
        `SELECT occurred_at FROM agent_activity_ledger
         WHERE agent_id = ? ORDER BY occurred_at ASC, id ASC LIMIT 1`,
      )
      .get(input.agentId) as { occurred_at: string } | undefined;
    const activities = pageRows.map((row) => ({
      activityId: String(row.id),
      agentId: String(row.agent_id),
      kind: row.kind as RepositoryAgentActivityRecord["kind"],
      source: row.source as RepositoryAgentActivityRecord["source"],
      action: String(row.action),
      outcome: row.outcome as RepositoryAgentActivityRecord["outcome"],
      resourceType: row.resource_type as RepositoryAgentActivityRecord["resourceType"],
      resourceId: row.resource_id,
      meshId: row.mesh_id,
      topicId: row.topic_id,
      failureCode: row.failure_code,
      occurredAt: String(row.occurred_at),
    }));
    const last = pageRows.at(-1);
    return {
      activities,
      nextAfter:
        rows.length > limit && last
          ? { occurredAt: String(last.occurred_at), id: String(last.id) }
          : null,
      recordedSince: earliest?.occurred_at ?? null,
    };
  }

  async appendEvent(input: RepositoryEventInput): Promise<{ duplicate: boolean }> {
    return this.database.transaction(() => {
      const existing = this.db.prepare(
        `SELECT type, mesh_id, topic_id, agent_id, session_id, runtime_kind,
                payload_json, created_at
         FROM outbox_events WHERE event_id = ?`,
      ).get(input.eventId) as {
        type: string;
        mesh_id: string | null;
        topic_id: string | null;
        agent_id: string | null;
        session_id: string | null;
        runtime_kind: RuntimeKind | null;
        payload_json: string;
        created_at: string;
      } | undefined;
      const runtimeKind = input.runtimeKind == null ? null : publicRuntimeKind(input.runtimeKind);
      if (existing) {
        const same = existing.type === input.type && existing.mesh_id === input.meshId &&
          existing.topic_id === input.topicId && existing.agent_id === input.agentId &&
          existing.session_id === input.sessionId && existing.runtime_kind === runtimeKind &&
          existing.created_at === input.occurredAt &&
          JSON.stringify(JSON.parse(existing.payload_json) as unknown) === JSON.stringify(input.payload);
        if (!same) throw new Error("event_id_conflict");
        return { duplicate: true };
      }
      this.db.prepare(
        `INSERT INTO outbox_events(
           event_id, schema_version, type, mesh_id, topic_id, agent_id, session_id,
           runtime_kind, payload_json, status, attempts, created_at
         ) VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      ).run(
        input.eventId,
        input.type,
        input.meshId,
        input.topicId,
        input.agentId,
        input.sessionId,
        runtimeKind,
        JSON.stringify(input.payload),
        input.occurredAt,
      );
      return { duplicate: false };
    });
  }

  async getOutboxHealth(input: { now: string }): Promise<RepositoryOutboxHealth> {
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) throw new Error("invalid_outbox_health_time");
    const row = this.db.prepare(
      `SELECT created_at
       FROM outbox_events
       WHERE status IN ('pending', 'failed')
       ORDER BY created_at ASC, event_id ASC
       LIMIT 1`,
    ).get() as { created_at?: unknown } | undefined;
    const oldestPendingAt = typeof row?.created_at === "string" ? row.created_at : null;
    const oldestPendingMs = oldestPendingAt ? Date.parse(oldestPendingAt) : NaN;
    return {
      oldestPendingAt,
      oldestPendingAgeMs: Number.isFinite(oldestPendingMs)
        ? Math.max(0, nowMs - oldestPendingMs)
        : 0,
    };
  }

  async claimOutboxEvents(input: {
    now: string;
    leaseSeconds: number;
    maxEvents: number;
  }): Promise<RepositoryOutboxClaim[]> {
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) throw new Error("invalid_outbox_claim_time");
    const maxEvents = Math.max(1, Math.min(200, Math.trunc(input.maxEvents)));
    const leaseSeconds = Math.max(5, Math.min(120, Math.trunc(input.leaseSeconds)));
    return this.database.transaction(() => {
      type Row = {
        event_id: string;
        type: string;
        mesh_id: string | null;
        topic_id: string | null;
        agent_id: string | null;
        session_id: string | null;
        runtime_kind: RuntimeKind | null;
        payload_json: string;
        attempts: number;
        created_at: string;
        next_attempt_at: string | null;
        lease_until: string | null;
      };
      const candidates = this.db.prepare(
        `SELECT event_id, type, mesh_id, topic_id, agent_id, session_id,
                runtime_kind, payload_json, attempts, created_at,
                next_attempt_at, lease_until
         FROM outbox_events
         WHERE status IN ('pending', 'failed')
         ORDER BY created_at ASC, event_id ASC
         LIMIT 5000`,
      ).all() as unknown as Row[];
      const blockedKeys = new Set<string>();
      const selected: Array<Row & { orderingKey: string; leaseId: string }> = [];
      for (const row of candidates) {
        const orderingKey = row.mesh_id ?? "system";
        if (blockedKeys.has(orderingKey)) continue;
        const leaseUntilMs = row.lease_until ? Date.parse(row.lease_until) : NaN;
        const retryAtMs = row.next_attempt_at ? Date.parse(row.next_attempt_at) : NaN;
        if (
          (Number.isFinite(leaseUntilMs) && leaseUntilMs > nowMs) ||
          (Number.isFinite(retryAtMs) && retryAtMs > nowMs)
        ) {
          blockedKeys.add(orderingKey);
          continue;
        }
        selected.push({ ...row, orderingKey, leaseId: randomUUID() });
        if (selected.length >= maxEvents) break;
      }
      const leaseUntil = new Date(nowMs + leaseSeconds * 1_000).toISOString();
      const update = this.db.prepare(
        `UPDATE outbox_events
         SET lease_id = ?, lease_until = ?, last_attempt_at = ?, completed_lease_id = NULL
         WHERE event_id = ? AND status IN ('pending', 'failed')`,
      );
      for (const row of selected) update.run(row.leaseId, leaseUntil, input.now, row.event_id);
      return selected.map((row) => {
        const raw = JSON.parse(row.payload_json) as unknown;
        const payload = raw && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown>
          : { value: raw };
        return {
          eventId: row.event_id,
          leaseId: row.leaseId,
          orderingKey: row.orderingKey,
          attempts: row.attempts,
          envelope: {
            event_id: row.event_id,
            schema_version: 1,
            mesh_id: row.mesh_id,
            agent_id: row.agent_id,
            session_id: row.session_id,
            runtime_kind: row.runtime_kind == null ? null : publicRuntimeKind(row.runtime_kind),
            type: row.type,
            occurred_at: row.created_at,
            payload: { ...(row.topic_id ? { topic_id: row.topic_id } : {}), ...payload },
          },
        };
      });
    });
  }

  async completeOutboxEvents(input: {
    completedAt: string;
    results: RepositoryOutboxCompletion[];
  }): Promise<RepositoryOutboxCompletionResult> {
    const completedAtMs = Date.parse(input.completedAt);
    if (!Number.isFinite(completedAtMs)) throw new Error("invalid_outbox_completion_time");
    return this.database.transaction(() => {
      const completed: string[] = [];
      const stale: string[] = [];
      for (const result of input.results) {
        const current = this.db.prepare(
          `SELECT status, attempts, lease_id, completed_lease_id, pubsub_message_id
           FROM outbox_events WHERE event_id = ?`,
        ).get(result.eventId) as {
          status: string;
          attempts: number;
          lease_id: string | null;
          completed_lease_id: string | null;
          pubsub_message_id: string | null;
        } | undefined;
        if (
          current?.status === "published" && result.outcome === "published" &&
          current.completed_lease_id === result.leaseId &&
          current.pubsub_message_id === result.messageId
        ) {
          completed.push(result.eventId);
          continue;
        }
        if (!current || current.lease_id !== result.leaseId || current.status === "published") {
          stale.push(result.eventId);
          continue;
        }
        const attempts = current.attempts + 1;
        if (result.outcome === "published") {
          this.db.prepare(
            `UPDATE outbox_events
             SET status = 'published', attempts = ?, published_at = ?,
                 pubsub_message_id = ?, completed_lease_id = ?, last_error = NULL,
                 next_attempt_at = NULL, lease_id = NULL, lease_until = NULL
             WHERE event_id = ? AND lease_id = ?`,
          ).run(
            attempts,
            input.completedAt,
            result.messageId ?? null,
            result.leaseId,
            result.eventId,
            result.leaseId,
          );
        } else {
          const retrySeconds = Math.min(600, 2 ** Math.min(Math.max(0, attempts - 1), 10));
          const nextAttemptAt = new Date(completedAtMs + retrySeconds * 1_000).toISOString();
          this.db.prepare(
            `UPDATE outbox_events
             SET status = 'failed', attempts = ?, last_error = ?, next_attempt_at = ?,
                 completed_lease_id = ?, lease_id = NULL, lease_until = NULL
             WHERE event_id = ? AND lease_id = ?`,
          ).run(
            attempts,
            (result.error ?? "pubsub_publish_failed").slice(0, 1_000),
            nextAttemptAt,
            result.leaseId,
            result.eventId,
            result.leaseId,
          );
        }
        completed.push(result.eventId);
      }
      return { completed, stale };
    });
  }

  async purgeExpired(now: string): Promise<number> {
    // Keep SQLite fixtures aligned with Firestore retention semantics. A
    // moderation case may be opened shortly before a post expires; redact
    // the body at the 90-day boundary, retain the non-reconstructive case,
    // then remove the tombstone once the case's own 90-day window elapses.
    const expiredPosts = this.db.prepare(
      "SELECT id FROM posts WHERE expires_at IS NOT NULL AND expires_at <= ?",
    ).all(now) as Array<{ id: string }>;
    let removed = 0;
    const retentionExtensionMs = 90 * 24 * 60 * 60 * 1_000;
    for (const post of expiredPosts) {
      // Keep a parent row alive until every descendant has expired. SQLite's
      // FK is intentionally `ON DELETE CASCADE`, so deleting an expired root
      // without this check would silently erase a still-live reply. The
      // recursive CTE covers arbitrarily deep reply chains in one read.
      const descendants = this.db.prepare(
        `WITH RECURSIVE descendants(id, expires_at) AS (
           SELECT id, expires_at FROM posts WHERE parent_post_id = ?
           UNION ALL
           SELECT child.id, child.expires_at
           FROM posts child
           JOIN descendants parent ON child.parent_post_id = parent.id
         )
         SELECT COUNT(*) AS count, MAX(expires_at) AS max_expires_at
         FROM descendants`,
      ).get(post.id) as { count: number; max_expires_at: string | null };
      if (descendants.count > 0) {
        const maxExpiry = descendants.max_expires_at &&
          Number.isFinite(Date.parse(descendants.max_expires_at)) &&
          Date.parse(descendants.max_expires_at) > Date.parse(now)
          ? descendants.max_expires_at
          : new Date(Date.parse(now) + retentionExtensionMs).toISOString();
        this.db.prepare(
          `UPDATE posts SET body = '', moderation_state = 'removed',
             moderation_reason = 'retention_expired', expires_at = ?
           WHERE id = ?`,
        ).run(maxExpiry, post.id);
        continue;
      }
      const cases = this.db.prepare(
        "SELECT id FROM moderation_cases WHERE post_id = ? LIMIT 1",
      ).all(post.id) as Array<{ id: string }>;
      if (cases.length) {
        this.db.prepare(
          `UPDATE posts SET body = '', moderation_state = 'removed',
             moderation_reason = 'retention_expired', expires_at = NULL
           WHERE id = ?`,
        ).run(post.id);
      } else {
        removed += Number(this.db.prepare("DELETE FROM posts WHERE id = ?").run(post.id).changes);
      }
    }
    // Cases use created_at as their retention anchor in the local adapter;
    // SQLite's date functions keep the same UTC boundary used by Firestore's
    // native TTL timestamp.
    removed += Number(this.db.prepare(
      `DELETE FROM moderation_cases
       WHERE datetime(created_at, '+90 days') <= datetime(?)`,
    ).run(now).changes);
    removed += Number(this.db.prepare(
      `DELETE FROM posts
       WHERE expires_at IS NULL AND body = '' AND moderation_state = 'removed'
         AND NOT EXISTS (SELECT 1 FROM moderation_cases WHERE post_id = posts.id)`,
    ).run().changes);
    removed += Number(this.db.prepare(
      `DELETE FROM human_idempotency_records WHERE expires_at <= ?`,
    ).run(now).changes);
    removed += Number(this.db.prepare(
      `DELETE FROM automated_idempotency_records WHERE expires_at <= ?`,
    ).run(now).changes);
    return removed;
  }
}
