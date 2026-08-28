import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { CURRENT_SCHEMA_VERSION, MeshrDatabase } from "./database.ts";
import { MESHR_CONTRACT_MAJOR } from "./contracts.ts";
import type {
  MeshrRepository,
  RepositoryAgentInput,
  RepositoryProfileReloadResult,
  RepositoryProfileReviewProposal,
  RepositoryMeshInput,
  RepositoryPairingInput,
  RepositoryPairingChallenge,
  RepositoryTopicInput,
  RepositoryAgentTopic,
  RepositoryMeshDirectoryEntry,
  RepositoryRuntimeSession,
  RepositoryWebMcpGrant,
  RepositoryModerationCase,
  RepositoryPostRecord,
  RepositoryTopicPostsPage,
  RepositoryJoinRequest,
  RepositoryHumanActivityPreference,
  RepositoryMutationArtifacts,
  RepositoryEventInput,
  RepositoryAuditInput,
} from "./repository.ts";
import type { Clock, RuntimeKind, SocialProvider } from "./types.ts";
import { systemClock } from "./types.ts";

const HUMAN_IDLE_SECONDS = 12 * 60 * 60;
const NEW_IDENTITY_REVIEW_POSTS = 5;
const NEW_IDENTITY_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;

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
    if (input.actingAccountId || input.humanSessionHash) {
      this.assertHumanSession(input.actingAccountId, input.humanSessionHash, input.updatedAt);
      if (input.actingAccountId !== input.ownerAccountId) throw new Error("mesh_governance_denied");
      const owner = this.db.prepare("SELECT owner_account_id FROM agents WHERE id = ?").get(input.agentId) as
        | { owner_account_id: string }
        | undefined;
      if (owner && owner.owner_account_id !== input.ownerAccountId) throw new Error("agent_access_denied");
    }
    if (input.expectedUpdatedAt !== undefined) {
      const current = this.db.prepare("SELECT updated_at FROM agents WHERE id = ?").get(input.agentId) as
        | { updated_at: string }
        | undefined;
      if (!current || current.updated_at !== input.expectedUpdatedAt) {
        throw new Error("profile_conflict");
      }
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
  ): Promise<void> {
    this.database.transaction(() => {
      if (actingAccountId || humanSessionHash) {
        this.assertHumanSession(actingAccountId, humanSessionHash, revokedAt);
        const agent = this.db
          .prepare("SELECT owner_account_id FROM agents WHERE id = ?")
          .get(agentId) as { owner_account_id: string } | undefined;
        if (!agent || agent.owner_account_id !== actingAccountId) {
          throw new Error("agent_access_denied");
        }
      }
      this.db.prepare("DELETE FROM agent_sessions WHERE agent_id = ?").run(agentId);
      this.db.prepare("UPDATE webmcp_grants SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL")
        .run(revokedAt, agentId);
      this.writeMutationArtifacts({ event, audit });
    });
  }

  async upsertMesh(input: RepositoryMeshInput & RepositoryMutationArtifacts): Promise<void> {
    if (input.actingAccountId) {
      this.assertHumanSession(input.actingAccountId, input.humanSessionHash, input.updatedAt);
      const existing = this.db.prepare("SELECT 1 FROM meshes WHERE id = ?").get(input.meshId);
      if (existing) this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner"],
        input.updatedAt,
      );
      else if (input.actingAccountId !== input.ownerAccountId) throw new Error("mesh_governance_denied");
    }
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

  async createMeshWithOwner(input: {
    mesh: RepositoryMeshInput;
    topic: RepositoryTopicInput;
    agentIds: string[];
  } & RepositoryMutationArtifacts): Promise<void> {
    const { mesh, topic } = input;
    const agentIds = [...new Set(input.agentIds)];
    this.database.transaction(() => {
      const existing = this.db.prepare("SELECT 1 FROM meshes WHERE id = ?").get(mesh.meshId);
      if (existing) throw new Error("mesh_already_exists");
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
        `INSERT INTO meshes(id, owner_account_id, name, description, visibility, join_policy, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mesh.meshId,
        mesh.ownerAccountId,
        mesh.name,
        mesh.description,
        mesh.visibility,
        mesh.admission,
        mesh.createdAt,
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
      for (const agentId of agentIds) insertMembership.run(mesh.meshId, agentId, mesh.createdAt);
    });
  }

  async upsertTopic(input: RepositoryTopicInput): Promise<void> {
    this.db.prepare(
      `UPDATE topics SET mesh_id = ?, name = ?, title = ?, description = ?, tags_json = ?
       WHERE id = ?`,
    ).run(input.meshId, input.name, input.title, input.description, JSON.stringify(input.tags), input.topicId);
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

  async listTopicsForAgent(meshId: string, agentId: string): Promise<RepositoryAgentTopic[]> {
    const mesh = this.db
      .prepare("SELECT id, visibility FROM meshes WHERE id = ?")
      .get(meshId) as { id: string; visibility: string } | undefined;
    if (!mesh) throw new Error("mesh_not_found");
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

  async listPublicMeshes(): Promise<RepositoryMeshInput[]> {
    return (this.db.prepare(
      `SELECT id, owner_account_id, name, description, visibility, join_policy, created_at
       FROM meshes WHERE visibility = 'public' ORDER BY name, id`,
    ).all() as Array<Record<string, string | null>>).map((row) => ({
      meshId: String(row.id),
      ownerAccountId: row.owner_account_id == null ? null : String(row.owner_account_id),
      name: String(row.name),
      description: String(row.description),
      visibility: "public",
      admission: String(row.join_policy) as RepositoryMeshInput["admission"],
      lifecycle: "active",
      createdAt: String(row.created_at),
      updatedAt: String(row.created_at),
    }));
  }

  async listPublicTopics(meshId: string): Promise<RepositoryTopicInput[]> {
    const mesh = this.db
      .prepare("SELECT 1 AS present FROM meshes WHERE id = ? AND visibility = 'public'")
      .get(meshId);
    if (!mesh) throw new Error("mesh_not_found");
    return (this.db.prepare(
      `SELECT id, mesh_id, name, title, description, tags_json, created_at
       FROM topics WHERE mesh_id = ? ORDER BY title, id`,
    ).all(meshId) as Array<Record<string, string>>).map((row) => {
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
      const mesh = this.db
        .prepare("SELECT owner_account_id FROM meshes WHERE id = ?")
        .get(input.meshId) as { owner_account_id: string | null } | undefined;
      if (input.role === "owner" && existing?.role !== "owner") {
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
  } & RepositoryMutationArtifacts): Promise<void> {
    if (input.actingAccountId) {
      this.assertHumanGovernance(
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.updatedAt,
      );
    }
    if (input.status === "joined") {
      this.db.prepare(
        "INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
      ).run(input.meshId, input.agentId, input.joinedAt ?? input.updatedAt);
    } else if (input.status === "left" || input.status === "removed") {
      this.db.prepare("DELETE FROM mesh_members WHERE mesh_id = ? AND agent_id = ?")
        .run(input.meshId, input.agentId);
    }
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
    attentionPolicy: Record<string, unknown>;
  }): Promise<{ status: "joined" | "pending"; requestId?: string; duplicate: boolean }> {
    return this.database.transaction(() => {
      const requestHash = createHash("sha256")
        .update(JSON.stringify({ meshId: input.meshId }))
        .digest("hex");
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
        "SELECT owner_account_id FROM agents WHERE id = ?",
      ).get(input.agentId) as { owner_account_id: string } | undefined;
      if (!agent) throw new Error("agent_not_found");
      if (agent.owner_account_id !== input.ownerAccountId) throw new Error("agent_access_denied");
      const mesh = this.db.prepare(
        "SELECT join_policy FROM meshes WHERE id = ?",
      ).get(input.meshId) as { join_policy: "open" | "approval" | "invite_only" } | undefined;
      if (!mesh) throw new Error("mesh_not_found");
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
      if (mesh.join_policy === "invite_only") throw new Error("invite_required");
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
          "INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
        ).run(input.meshId, input.agentId, input.requestedAt);
        responseStatus = 201;
        body = { meshId: input.meshId, status: "joined" };
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
        ...(responseStatus === 202 ? { requestId: input.requestId } : {}),
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
    actingAccountId?: string;
    humanSessionHash?: string;
  } & RepositoryMutationArtifacts): Promise<{ agentId: string; status: "approved" | "denied" }> {
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

  async upsertHumanActivityPreference(input: RepositoryHumanActivityPreference): Promise<void> {
    this.db.prepare(
      `INSERT INTO human_activity_preferences(
         account_id, kind, resource_id, watching, muted, updated_at
       ) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, kind, resource_id) DO UPDATE SET
         watching = excluded.watching,
         muted = excluded.muted,
         updated_at = excluded.updated_at`,
    ).run(
      input.accountId,
      input.kind,
      input.resourceId,
      input.watching ? 1 : 0,
      input.muted ? 1 : 0,
      input.updatedAt,
    );
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
      this.db
        .prepare(
          "UPDATE webmcp_grants SET revoked_at = ? WHERE human_session_hash = ? AND revoked_at IS NULL",
        )
        .run(revokedAt, humanSessionHash);
      const fence = this.db
        .prepare("SELECT epoch FROM webmcp_authority WHERE human_session_hash = ?")
        .get(humanSessionHash) as { epoch: number } | undefined;
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
  } & RepositoryMutationArtifacts): Promise<void> {
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
      write();
      return;
    }
    this.database.transaction(() => {
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
          return;
        }
      } else {
        this.assertHumanModerator(
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          input.updatedAt,
        );
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
    actingAccountId: string;
    humanSessionHash: string;
  } & RepositoryMutationArtifacts): Promise<void> {
    this.database.transaction(() => {
      const post = this.db.prepare("SELECT mesh_id FROM posts WHERE id = ?").get(input.postId) as
        | { mesh_id: string }
        | undefined;
      if (!post) throw new Error("post_not_found");
      const existing = this.db.prepare("SELECT created_at, severity FROM moderation_cases WHERE id = ?").get(input.caseId) as
        | { created_at: string; severity: RepositoryModerationCase["severity"] }
        | undefined;
      this.assertHumanModerator(
        post.mesh_id,
        input.actingAccountId,
        input.humanSessionHash,
        input.updatedAt,
      );
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
          Date.parse(predecessor.expires_at) <= Date.parse(now)
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
    sessionId?: string;
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{ authorityEpoch: number; sessionId: string }> {
    const now = this.now();
    const sessionId = input.sessionId ?? this.database.id("page");
    return this.database.transaction(() => {
      const fence = this.db
        .prepare("SELECT epoch FROM webmcp_authority WHERE human_session_hash = ?")
        .get(input.humanSessionHash) as { epoch: number } | undefined;
      const epoch = (fence?.epoch ?? 0) + 1;
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
    reviewQueued?: boolean;
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
          JSON.stringify({
            post,
            reviewQueued: input.reviewQueued === true || newIdentityReview,
            ...(newIdentityReview ? { reviewReason: "new_identity" } : {}),
          }),
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
      return {
        duplicate: false,
        post,
        reviewQueued: input.reviewQueued === true || newIdentityReview,
      };
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
    return removed;
  }
}
