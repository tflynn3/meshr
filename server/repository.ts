import type {
  FirestoreMeshrRepository,
  RepositoryAccount,
  RepositoryPostInput,
  RepositoryPostResult,
} from "./firestoreRepository.ts";
import type { RuntimeKind, SocialProvider } from "./types.ts";

/**
 * Topic administration writes a topic plus event, audit, and outbox records.
 * Keep that bounded so an otherwise-authorized account cannot turn the topic
 * directory into an unbounded read/write amplification vector.
 */
export const MAX_TOPICS_PER_MESH = 50;

/** Human activity preferences are user-controlled durable records. Keep the
 * useful set bounded so rotating synthetic resource ids cannot grow storage
 * without limit. The false/false default is represented by no document. */
export const MAX_ACTIVITY_PREFERENCES_PER_ACCOUNT = 500;

/**
 * Browser directory reads are previews, not bulk export APIs. These budgets
 * keep one request within the launch-scale (100-agent) envelope even when a
 * public mesh or the public directory is deliberately over-populated.
 */
export const MAX_MESH_DIRECTORY_ENTRIES = 100;
export const MAX_MESH_DIRECTORY_MEMBER_ROWS = 1_000;
export const MAX_MESH_DIRECTORY_ROLE_ROWS = 500;
export const MAX_MESH_DIRECTORY_TOPIC_ROWS = 1_000;
export const MAX_MESH_DETAIL_MEMBER_ROWS = 500;
export const MAX_MESH_DETAIL_ROLE_ROWS = 200;

export interface RepositoryAgentInput {
  agentId: string;
  /** The current runtime binding. A persistent agent may receive a new binding on reconnect. */
  bindingId?: string;
  ownerAccountId: string;
  name: string;
  handle: string;
  tagline: string;
  interests: string[];
  personality: string;
  attention: Record<string, unknown>;
  runtime: RuntimeKind;
  runtimeLabel: string;
  runtimeSubject: string;
  publicKeyPem: string;
  definitionDigest: string | null;
  createdAt: string;
  updatedAt: string;
  /** Human actor for an owner profile edit; omitted for native session sync. */
  actingAccountId?: string;
  humanSessionHash?: string;
  /** Owner edits must compare against the revision used to build the full
   * candidate so a concurrent native profile reload cannot be overwritten. */
  expectedUpdatedAt?: string;
  /** Restricted fields requested by a local definition and held for owner review. */
  profileReviewProposal?: {
    proposalId: string;
    sourceDigest: string;
    requested: Record<string, unknown>;
    pendingFields: string[];
    createdAt: string;
  };
}

export interface RepositoryProfileReloadResult {
  contract_version: 1;
  applied: boolean;
  applied_fields: string[];
  pending_owner_review_fields: string[];
  source_digest: string;
  validation_failures: string[];
}

export type RepositoryProfileReviewProposalStatus =
  "pending" | "approved" | "denied";

export interface RepositoryProfileReviewProposal {
  proposalId: string;
  agentId: string;
  ownerAccountId: string;
  sourceDigest: string;
  requested: Record<string, unknown>;
  pendingFields: string[];
  status: RepositoryProfileReviewProposalStatus;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolution: "approved" | "denied" | null;
}

export interface RepositoryMeshInput {
  meshId: string;
  ownerAccountId: string | null;
  name: string;
  description: string;
  visibility: "public" | "unlisted" | "private";
  admission: "open" | "approval" | "invite_only";
  lifecycle: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  /** Human actor for governance writes; omitted only for bootstrap/read models. */
  actingAccountId?: string;
  /** Hash of the authenticated human session used for the mutation. */
  humanSessionHash?: string;
}

/** Field-level mesh governance update. The authoritative adapter resolves the
 * current mesh inside its transaction and merges only the fields supplied by
 * the caller, so a stale replica cannot reopen a private mesh or overwrite a
 * concurrent owner edit with an old snapshot. */
export interface RepositoryMeshGovernancePatch extends RepositoryMutationArtifacts {
  meshId: string;
  name?: string;
  description?: string;
  visibility?: "public" | "unlisted" | "private";
  admission?: "open" | "approval" | "invite_only";
  updatedAt: string;
  actingAccountId: string;
  humanSessionHash: string;
}

export interface RepositoryTopicInput {
  topicId: string;
  meshId: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  createdAt: string;
}

export interface RepositoryTopicCreateInput extends RepositoryTopicInput {
  /** Authenticated human that is creating the topic. */
  actingAccountId: string;
  humanSessionHash: string;
}

export interface RepositoryTopicUpdateInput {
  topicId: string;
  meshId: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  updatedAt: string;
  /** Authenticated human that is updating the topic. */
  actingAccountId: string;
  humanSessionHash: string;
}

export interface RepositoryTopicDeleteInput {
  topicId: string;
  meshId: string;
  deletedAt: string;
  /** Authenticated human that is deleting the topic. */
  actingAccountId: string;
  humanSessionHash: string;
}

/** A topic row scoped to one agent's current browse authority. */
export interface RepositoryAgentTopic {
  topic: RepositoryTopicInput;
  followed: boolean;
}

/** Metadata-only mesh directory row used by authenticated browser polling. */
export interface RepositoryMeshDirectoryEntry {
  mesh: RepositoryMeshInput;
  role: "owner" | "steward" | "observer" | null;
  memberAgentIds: string[];
  topics: Array<{
    topic: RepositoryTopicInput;
    activityCount: number;
    recentActivityCount: number;
    participantAgentIds: string[];
    lastActivityAt: string | null;
  }>;
  roles: Array<{
    accountId: string;
    role: "owner" | "steward" | "observer";
    displayName: string;
    email: string;
    createdAt: string;
    updatedAt: string;
  }>;
  /**
   * At least one metadata collection hit the directory read budget. Callers
   * may render the bounded preview, but must not treat it as a complete roster.
   */
  truncated?: boolean;
}

export interface RepositoryPublicMeshDirectory {
  meshes: RepositoryMeshInput[];
  truncated: boolean;
}

export interface RepositoryPublicTopicDirectory {
  topics: RepositoryTopicInput[];
  truncated: boolean;
}

export interface RepositoryPairingInput {
  pairingId: string;
  code: string;
  secretHash: string;
  runtime: RuntimeKind;
  runtimeLabel: string;
  externalSubject: string;
  publicKeyPem: string;
  requestedProfile: Record<string, unknown> | null;
  definitionDigest: string | null;
  status: "pending" | "approved" | "claimed" | "expired" | "revoked";
  ownerAccountId: string | null;
  agentId: string | null;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  claimedAt: string | null;
}

export interface RepositoryPairingChallenge {
  challengeId: string;
  pairingId: string;
  message: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export interface RepositoryRuntimeSession {
  tokenHash: string;
  agentId: string;
  bindingId: string;
  sessionId: string;
  runtimeKind: RuntimeKind;
  authorityEpoch: number;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  status: "active" | "superseded" | "expired" | "revoked";
  supersedingSessionId: string | null;
}

export interface RepositoryPostRecord {
  postId: string;
  meshId: string;
  topicId: string;
  agentId: string;
  sessionId: string;
  parentPostId: string | null;
  body: string;
  moderationState: "published" | "quarantined" | "removed" | "redacted";
  moderationReason: string | null;
  createdAt: string;
  /** Durable revision timestamp used by asynchronous moderation decisions. */
  updatedAt?: string;
  expiresAt: string | null;
}

export interface RepositoryProjection {
  accounts: RepositoryAccount[];
  agents: RepositoryAgentInput[];
  meshes: RepositoryMeshInput[];
  topics: RepositoryTopicInput[];
  humanRoles: Array<{
    meshId: string;
    accountId: string;
    role: "owner" | "steward" | "observer";
    createdAt: string;
    updatedAt: string;
  }>;
  memberships: Array<{
    meshId: string;
    agentId: string;
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
    admissionProvenance: "open" | "approval" | "invite";
    joinedAt: string | null;
    updatedAt: string;
  }>;
  /** Active and recently-active runtime sessions for presence projections. */
  runtimeSessions: RepositoryRuntimeSession[];
  posts: RepositoryPostRecord[];
  /** Aggregate-only topology counters materialized from the event plane. */
  activity?: RepositoryActivityProjection;
  follows: Array<{ topicId: string; agentId: string; updatedAt: string }>;
  /** True when the bounded public discovery query hit its launch cap. */
  publicMeshesTruncated?: boolean;
}

export interface RepositoryTopicPostsPage {
  posts: RepositoryPostRecord[];
  /** Opaque to callers; null means the topic has no more retained posts. */
  nextAfter: { createdAt: string; id: string } | null;
  /** Display metadata for the immutable post authors, loaded from authority. */
  agents: RepositoryAgentInput[];
}

export interface RepositoryActivityProjection {
  truncated?: boolean;
  meshes: Array<{
    meshId: string;
    postCount: number;
    rootCount: number;
    replyCount: number;
    recentPostCount: number;
    lastActivityAt: string | null;
  }>;
  topics: Array<{
    topicId: string;
    meshId: string;
    postCount: number;
    rootCount: number;
    replyCount: number;
    recentPostCount: number;
    participantAgentIds: string[];
    lastActivityAt: string | null;
  }>;
  agents: Array<{
    agentId: string;
    meshId: string;
    postCount: number;
    lastPostAt: string | null;
  }>;
  links: Array<{
    meshId: string;
    sourceAgentId: string;
    targetAgentId: string;
    topicIds: string[];
    eventCount: number;
    recentEventCount: number;
    delaySumMs: number;
    delayCount: number;
    delayBuckets: number[];
    lastEventAt: string;
  }>;
}

export interface RepositoryAgentEvent {
  eventId: string;
  type: string;
  meshId: string | null;
  topicId: string | null;
  agentId: string | null;
  sessionId: string | null;
  runtimeKind: RuntimeKind | null;
  payload: unknown;
  occurredAt: string;
}

export interface RepositoryAgentEventsPage {
  events: RepositoryAgentEvent[];
  /** Opaque cursor for the next page; null when the scan is exhausted. */
  nextAfter: string | null;
}

export interface RepositoryWebMcpGrant {
  tokenHash: string;
  humanSessionHash: string;
  agentId: string;
  sessionId: string;
  authorityEpoch: number;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
}

export interface RepositoryAgentRevocationResult {
  changed: boolean;
  bindings: number;
  sessions: number;
  pageGrants: number;
  pairings: number;
}

export interface RepositoryEventInput {
  eventId: string;
  type: string;
  meshId: string | null;
  topicId: string | null;
  agentId: string | null;
  sessionId: string | null;
  runtimeKind: RuntimeKind | null;
  payload: unknown;
  occurredAt: string;
  /** Stable ingest selector used to avoid polling private traffic globally. */
  observationScope?: "public" | "private" | "system";
}

/** A lease-fenced event returned to the delivery worker. The worker never
 * receives Firestore credentials; it can publish only envelopes selected by
 * the authoritative repository transaction. */
export interface RepositoryOutboxClaim {
  eventId: string;
  leaseId: string;
  orderingKey: string;
  attempts: number;
  envelope: Record<string, unknown>;
}

export interface RepositoryOutboxCompletion {
  eventId: string;
  leaseId: string;
  outcome: "published" | "failed";
  messageId?: string;
  error?: string;
}

export interface RepositoryOutboxCompletionResult {
  completed: string[];
  stale: string[];
}

/**
 * Operational view of the durable delivery queue. This is intentionally
 * limited to age metadata: delivery workers do not receive a broad database
 * read API, while operators still need to detect a pre-publish stall.
 */
export interface RepositoryOutboxHealth {
  oldestPendingAt: string | null;
  oldestPendingAgeMs: number;
}

export interface RepositoryAuditInput {
  auditId: string;
  actorType: "human" | "agent" | "system";
  actorId: string | null;
  sessionId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  data: unknown;
  createdAt: string;
}

/**
 * Immutable records emitted alongside a durable command.  Production
 * repositories write these in the same transaction as the state mutation;
 * the local adapter accepts them so conformance fixtures exercise the same
 * command shape.
 */
export interface RepositoryMutationArtifacts {
  event?: RepositoryEventInput;
  audit?: RepositoryAuditInput;
}

/**
 * Operator-only provisioning command for a project-operated resident Human.
 * The resulting account and session use the same documents and authority
 * checks as any other Human; provenance stays in a non-projected registry and
 * immutable audit record.
 */
export interface RepositoryResidentPrincipalInput {
  principalKey: string;
  accountId: string;
  email: string;
  displayName: string;
  operator: string;
  purpose: string;
  generation: string;
  manifestDigest: string;
  disclosureTextHash: string;
  disclosureUrl: string;
  session: {
    tokenHash: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    absoluteExpiresAt: string;
  };
  audit: RepositoryAuditInput;
}

export interface RepositoryResidentPrincipalResult {
  account: RepositoryAccount;
  created: boolean;
  sessionRotated: boolean;
}

export type RepositoryModerationCaseState =
  "queued" | "reviewing" | "resolved" | "appealed";

export interface RepositoryModerationCase {
  caseId: string;
  postId: string;
  meshId: string;
  reason: string;
  state: RepositoryModerationCaseState;
  severity: "low" | "medium" | "high" | "critical";
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface RepositoryModerationCasesPage {
  cases: RepositoryModerationCase[];
  /** Opaque to callers; null means there are no older cases. */
  nextAfter: { updatedAt: string; caseId: string } | null;
}

/** Result of a durable moderation mutation. Replays return the authoritative
 * case/post referenced by the idempotency record when its body-free result
 * metadata still matches; superseded results are rejected explicitly rather
 * than rendered as if they were the original action. */
export interface RepositoryModerationMutationResult {
  duplicate: boolean;
  moderationCase?: RepositoryModerationCase;
  post?: RepositoryPostRecord | null;
}

export interface RepositoryJoinRequest {
  requestId: string;
  meshId: string;
  agentId: string;
  requestedByAccountId: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  createdAt: string;
  resolvedAt: string | null;
}

export type RepositoryMeshInvitationStatus =
  "active" | "redeemed" | "revoked" | "expired";

/** A one-use, expiring admission token for an invite-only mesh. */
export interface RepositoryMeshInvitation {
  invitationId: string;
  meshId: string;
  invitedAgentId: string | null;
  createdByAccountId: string;
  status: RepositoryMeshInvitationStatus;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedAgentId: string | null;
}

export type RepositoryMeshRoleInvitationStatus =
  "active" | "redeemed" | "revoked" | "expired";

/** A one-use, expiring human role invitation addressed by an HMAC email
 * fingerprint. The plaintext email and token are never persisted. */
export interface RepositoryMeshRoleInvitation {
  invitationId: string;
  meshId: string;
  role: "owner" | "steward" | "observer";
  createdByAccountId: string;
  status: RepositoryMeshRoleInvitationStatus;
  createdAt: string;
  expiresAt: string;
  redeemedAt: string | null;
  redeemedByAccountId: string | null;
}

export type RepositoryActivityPreferenceKind = "topic" | "link";

export interface RepositoryHumanActivityPreference {
  accountId: string;
  kind: RepositoryActivityPreferenceKind;
  resourceId: string;
  watching: boolean;
  muted: boolean;
  updatedAt: string;
}

/** Field-level browser observation update. The authoritative adapter resolves
 * the resource's mesh and rechecks session/access inside its transaction so a
 * stale replica cannot overwrite a concurrent preference or private mesh
 * transition. */
export interface RepositoryHumanActivityPreferencePatch {
  accountId: string;
  kind: RepositoryActivityPreferenceKind;
  resourceId: string;
  meshId: string;
  watching?: boolean;
  muted?: boolean;
  updatedAt: string;
  humanSessionHash: string;
}

/**
 * Storage port shared by the local conformance adapter and Firestore
 * production implementation. Keeping the port free of HTTP concerns prevents
 * route handlers from smuggling identity or authority through tool input.
 */
export interface MeshrRepository {
  ensureEmptyProduction(): Promise<void>;
  /** Check the authoritative store without mutating it. Used by readiness probes. */
  checkReady?(): Promise<void>;
  createPairing?(input: RepositoryPairingInput): Promise<void>;
  /** Atomically approves a pending pairing, binds its persistent agent, and
   * joins the global commons. Concurrent approvals must observe one winner. */
  approvePairing?(input: {
    pairingId: string;
    ownerAccountId: string;
    /** Authenticated human session that approved the pairing. */
    humanSessionHash: string;
    agentId: string;
    profile: {
      name: string;
      handle: string;
      tagline: string;
      interests: string[];
      personality: string;
      attention: Record<string, unknown>;
    };
    approvedAt: string;
    /** Immutable authority/audit records committed with the approval. */
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{ agentId: string; replaced: boolean }>;
  updatePairing?(
    pairingId: string,
    patch: Partial<RepositoryPairingInput>,
  ): Promise<void>;
  /** Atomically expires a pairing only when it is still pending and its
   * stored deadline has passed. Returns the authoritative current row so a
   * concurrent approval can never be overwritten by a stale status poll. */
  expirePairingIfPending?(
    pairingId: string,
    expiredAt: string,
  ): Promise<RepositoryPairingInput | null>;
  findPairing?(pairingId: string): Promise<RepositoryPairingInput | null>;
  findPairingByCode?(code: string): Promise<RepositoryPairingInput | null>;
  createPairingChallenge?(input: RepositoryPairingChallenge): Promise<void>;
  findPairingChallenge?(
    challengeId: string,
    pairingId: string,
  ): Promise<RepositoryPairingChallenge | null>;
  consumePairingChallenge?(
    challengeId: string,
    pairingId: string,
    usedAt: string,
  ): Promise<RepositoryPairingChallenge | null>;
  upsertAgent?(
    input: RepositoryAgentInput,
  ): Promise<{ changed: boolean; updatedAt: string }>;
  /** Atomically reloads a native session's profile without changing binding authority. */
  updateAgentProfileFromSession?(input: {
    agent: RepositoryAgentInput;
    sessionId: string;
    authorityEpoch: number;
    idempotencyKey: string;
    requestHash: string;
    updatedAt: string;
    /** Revision observed before the host built its profile patch. The
     * authoritative store rejects a stale host instead of overwriting a
     * concurrent owner edit. */
    expectedUpdatedAt?: string;
    /** Complete reload result persisted with the idempotency record. */
    profileReload?: RepositoryProfileReloadResult;
  }): Promise<{
    agent: RepositoryAgentInput;
    duplicate: boolean;
    profileReload?: RepositoryProfileReloadResult;
  }>;
  revokeAgent?(
    agentId: string,
    revokedAt: string,
    event?: RepositoryEventInput,
    audit?: RepositoryAuditInput,
    actingAccountId?: string,
    humanSessionHash?: string,
  ): Promise<RepositoryAgentRevocationResult>;
  upsertMesh?(
    input: RepositoryMeshInput & RepositoryMutationArtifacts,
  ): Promise<void>;
  /** Atomically merges owner-governed mesh fields against the authoritative
   * document and returns the committed mesh. */
  updateMeshGovernance?(
    input: RepositoryMeshGovernancePatch,
  ): Promise<RepositoryMeshInput>;
  /** Atomically creates a mesh, its first topic/owner role, and initial agent
   * memberships. Production callers must prefer this over a sequence of
   * independent upserts so a crash can never leave an ownerless mesh. */
  createMeshWithOwner?(
    input: {
      mesh: RepositoryMeshInput;
      topic: RepositoryTopicInput;
      agentIds: string[];
      /** Stable client key used to make retries return the original mesh. */
      idempotencyKey?: string;
      requestHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<{ duplicate: boolean }>;
  upsertTopic?(input: RepositoryTopicInput): Promise<void>;
  /** Cross-replica token bucket for bounded human governance mutations. */
  consumeGovernanceRateLimit?(input: {
    accountId: string;
    bucket: string;
    now: string;
    capacity: number;
    refillPerSecond: number;
  }): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  /** Durable owner/steward topic administration. */
  createTopic?(
    input: RepositoryTopicCreateInput & RepositoryMutationArtifacts,
  ): Promise<void>;
  updateTopic?(
    input: RepositoryTopicUpdateInput & RepositoryMutationArtifacts,
  ): Promise<void>;
  deleteTopic?(
    input: RepositoryTopicDeleteInput & RepositoryMutationArtifacts,
  ): Promise<void>;
  upsertMeshHumanRole?(
    input: {
      meshId: string;
      accountId: string;
      role: "owner" | "steward" | "observer";
      createdAt: string;
      updatedAt: string;
      actingAccountId?: string;
      humanSessionHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<void>;
  deleteMeshHumanRole?(
    meshId: string,
    accountId: string,
    actingAccountId?: string,
    humanSessionHash?: string,
    event?: RepositoryEventInput,
    audit?: RepositoryAuditInput,
  ): Promise<void>;
  upsertMeshAgentMembership?(
    input: {
      meshId: string;
      agentId: string;
      status: "joined" | "pending" | "left" | "removed";
      attentionPolicy: Record<string, unknown>;
      admissionProvenance: "open" | "approval" | "invite";
      joinedAt: string | null;
      updatedAt: string;
      actingAccountId?: string;
      humanSessionHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<{ changed: boolean }>;
  /**
   * Atomically admits an authenticated runtime session to a mesh. The
   * command rechecks the current session authority, durable agent attention,
   * and mesh admission policy inside the durable transaction; callers must
   * not implement this as a read-then-upsert sequence against a projection.
   */
  joinMeshForAgent?(input: {
    meshId: string;
    agentId: string;
    ownerAccountId: string;
    sessionId: string;
    authorityEpoch: number;
    runtimeKind: RuntimeKind;
    idempotencyKey: string;
    requestId: string;
    requestedAt: string;
    /** SHA-256 of the one-use invitation token, when joining invite-only meshes. */
    invitationTokenHash?: string;
  }): Promise<{
    status: "joined" | "pending";
    requestId?: string;
    duplicate: boolean;
  }>;
  createMeshInvitation?(
    input: {
      invitationId: string;
      meshId: string;
      tokenHash: string;
      invitedAgentId: string | null;
      createdByAccountId: string;
      createdAt: string;
      expiresAt: string;
      actingAccountId: string;
      humanSessionHash: string;
    } & RepositoryMutationArtifacts,
  ): Promise<RepositoryMeshInvitation>;
  listMeshInvitations?(meshId: string): Promise<RepositoryMeshInvitation[]>;
  revokeMeshInvitation?(
    input: {
      invitationId: string;
      meshId: string;
      revokedAt: string;
      actingAccountId: string;
      humanSessionHash: string;
    } & RepositoryMutationArtifacts,
  ): Promise<void>;
  createMeshRoleInvitation?(
    input: {
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
    } & RepositoryMutationArtifacts,
  ): Promise<RepositoryMeshRoleInvitation>;
  /** Direct, bounded lookup used by token redemption; avoids a capped inbox query. */
  findMeshRoleInvitation?(input: {
    invitationId: string;
    targetEmailHash: string;
  }): Promise<RepositoryMeshRoleInvitation | null>;
  listMeshRoleInvitations?(
    meshId: string,
  ): Promise<RepositoryMeshRoleInvitation[]>;
  listMeshRoleInvitationsForEmail?(
    targetEmailHash: string,
  ): Promise<RepositoryMeshRoleInvitation[]>;
  revokeMeshRoleInvitation?(
    input: {
      invitationId: string;
      meshId: string;
      revokedAt: string;
      actingAccountId: string;
      humanSessionHash: string;
    } & RepositoryMutationArtifacts,
  ): Promise<void>;
  acceptMeshRoleInvitation?(
    input: {
      invitationId: string;
      tokenHash: string;
      /** HMAC of the authenticated recipient's email, selected from the active key overlap. */
      targetEmailHash?: string;
      accountId: string;
      humanSessionHash: string;
      acceptedAt: string;
      idempotencyKey?: string;
      requestHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<{
    invitation: RepositoryMeshRoleInvitation;
    role: "owner" | "steward" | "observer";
    duplicate: boolean;
  }>;
  upsertJoinRequest?(
    input: {
      requestId: string;
      meshId: string;
      agentId: string;
      requestedByAccountId: string;
      status: "pending" | "approved" | "denied" | "cancelled";
      createdAt: string;
      resolvedAt: string | null;
      actingAccountId?: string;
      humanSessionHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<void>;
  findJoinRequest?(requestId: string): Promise<RepositoryJoinRequest | null>;
  listJoinRequests?(meshId: string): Promise<RepositoryJoinRequest[]>;
  resolveJoinRequest?(
    input: {
      requestId: string;
      meshId: string;
      decision: "approved" | "denied";
      resolvedAt: string;
      actingAccountId?: string;
      humanSessionHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<{ agentId: string; status: "approved" | "denied" }>;
  upsertFollow?(input: {
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
    /** Required for production agent mutations so retries are durable across replicas. */
    idempotencyKey?: string;
  }): Promise<void>;
  listProfileReviewProposals?(input: {
    agentId: string;
    ownerAccountId: string;
    humanSessionHash: string;
  }): Promise<RepositoryProfileReviewProposal[]>;
  resolveProfileReviewProposal?(input: {
    proposalId: string;
    agentId: string;
    ownerAccountId: string;
    humanSessionHash: string;
    decision: "approved" | "denied";
    resolvedAt: string;
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{
    proposal: RepositoryProfileReviewProposal;
    agent: RepositoryAgentInput;
  }>;
  listHumanActivityPreferences?(
    accountId: string,
  ): Promise<RepositoryHumanActivityPreference[]>;
  upsertHumanActivityPreference?(
    input: RepositoryHumanActivityPreferencePatch,
  ): Promise<RepositoryHumanActivityPreference>;
  revokeHumanSession?(tokenHash: string, revokedAt: string): Promise<void>;
  revokeWebMcpGrants?(
    humanSessionHash: string,
    revokedAt: string,
  ): Promise<void>;
  appendEvent?(input: RepositoryEventInput): Promise<{ duplicate: boolean }>;
  /** Atomically leases a bounded, per-ordering-key prefix of the durable
   * outbox. Active leases and future retry deadlines fence later events for
   * the same key so Pub/Sub invocation order remains deterministic. */
  claimOutboxEvents?(input: {
    now: string;
    leaseSeconds: number;
    maxEvents: number;
  }): Promise<RepositoryOutboxClaim[]>;
  /** Completes only leases minted by claimOutboxEvents. Stale workers cannot
   * acknowledge or reschedule a lease that another worker has reclaimed. */
  completeOutboxEvents?(input: {
    completedAt: string;
    results: RepositoryOutboxCompletion[];
  }): Promise<RepositoryOutboxCompletionResult>;
  /** Returns bounded age telemetry for pending, failed, or leased events. */
  getOutboxHealth?(input: { now: string }): Promise<RepositoryOutboxHealth>;
  appendAuditEvent?(input: RepositoryAuditInput): Promise<void>;
  /** Read the durable cross-replica event stream with an opaque cursor. */
  listAgentEvents?(input: {
    agentId: string;
    browse: "public" | "joined" | "mentions";
    after?: string;
    limit: number;
  }): Promise<RepositoryAgentEventsPage>;
  upsertModerationCase?(
    input: RepositoryModerationCase & {
      /** Set for review actions so the durable transaction rechecks authority. */
      actingAccountId?: string;
      humanSessionHash?: string;
      /** Set for agent appeals so the durable transaction rechecks session authority. */
      actingAgentId?: string;
      agentSessionId?: string;
      agentAuthorityEpoch?: number;
      idempotencyKey?: string;
      requestHash?: string;
      idempotencyOperation?: "moderation.report" | "moderation.action";
    } & RepositoryMutationArtifacts,
  ): Promise<RepositoryModerationMutationResult>;
  findModerationCase?(caseId: string): Promise<RepositoryModerationCase | null>;
  listModerationCases?(meshId: string): Promise<RepositoryModerationCase[]>;
  listModerationCasesPage?(input: {
    meshId: string;
    state?: RepositoryModerationCaseState;
    after?: { updatedAt: string; caseId: string };
    limit: number;
  }): Promise<RepositoryModerationCasesPage>;
  updatePostModeration?(
    input: {
      caseId: string;
      postId: string;
      state: "published" | "quarantined" | "removed" | "redacted";
      reason: string | null;
      /** Optional replacement body used by a redaction action. */
      body?: string;
      caseState: RepositoryModerationCaseState;
      resolution: string | null;
      updatedAt: string;
      /** The actor/session are revalidated in the same durable transaction. */
      actingAccountId: string;
      humanSessionHash: string;
      /** Stable retry key for human governance actions. */
      idempotencyKey?: string;
      requestHash?: string;
      /**
       * Internal moderation decisions are accepted only with a compare-and-set
       * revision. The route that supplies this field is protected by the
       * authority service token; repositories still recheck it transactionally.
       */
      automated?: {
        expectedPostState: RepositoryPostRecord["moderationState"];
        expectedPostUpdatedAt: string;
      };
    } & RepositoryMutationArtifacts,
  ): Promise<RepositoryModerationMutationResult>;
  findPostById?(postId: string): Promise<RepositoryPostRecord | null>;
  /** Read retained, published posts for one topic without the global feed cap. */
  listPublishedPostsByTopic?(input: {
    topicId: string;
    now: string;
    after?: { createdAt: string; id: string };
    limit: number;
  }): Promise<RepositoryTopicPostsPage>;
  findAgentById?(agentId: string): Promise<RepositoryAgentInput | null>;
  /** Metadata-only owner directory read; never loads post bodies. */
  listAgentsForAccount?(accountId: string): Promise<RepositoryAgentInput[]>;
  listRuntimeSessionsForAgents?(
    agentIds: string[],
    now: string,
    offlineAfter: string,
  ): Promise<RepositoryRuntimeSession[]>;
  findMeshById?(meshId: string): Promise<RepositoryMeshInput | null>;
  findTopicById?(topicId: string): Promise<RepositoryTopicInput | null>;
  /** Read only topics and follows for an agent without hydrating a global projection. */
  listTopicsForAgent?(
    meshId: string,
    agentId: string,
  ): Promise<RepositoryAgentTopic[]>;
  /** Read public directory metadata without loading post bodies. */
  listPublicMeshes?(): Promise<RepositoryPublicMeshDirectory>;
  listPublicTopics?(meshId: string): Promise<RepositoryPublicTopicDirectory>;
  /** Metadata/aggregate-only authenticated mesh directory read. */
  listMeshDirectoryForAccount?(
    accountId: string,
  ): Promise<RepositoryMeshDirectoryEntry[]>;
  /**
   * Read one authorized mesh directory entry without hydrating every public
   * mesh visible to the account.
   */
  findMeshDirectoryEntryForAccount?(
    meshId: string,
    accountId: string,
  ): Promise<RepositoryMeshDirectoryEntry | null>;
  findMeshHumanRole?(
    meshId: string,
    accountId: string,
  ): Promise<"owner" | "steward" | "observer" | null>;
  findMeshAgentMembership?(
    meshId: string,
    agentId: string,
  ): Promise<{
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
  } | null>;
  listMeshesForAgent?(
    agentId: string,
    options?: {
      limit?: number;
      /** Exclude public-only meshes for a joined-only attention policy. */
      browse?: "public" | "joined";
    },
  ): Promise<
    Array<{
      mesh: RepositoryMeshInput;
      joined: boolean;
    }>
  >;
  /** Bounded membership lookup used by page WebMCP transfer setup. */
  listJoinedMeshIdsForAgent?(agentId: string): Promise<string[]>;
  loadProjection?(input: {
    accountId?: string;
    agentId?: string;
    /** Bypass the short public-post cache for live propagation checks. */
    forcePublicPosts?: boolean;
    /** Omit post bodies for directory/topology reads that only need aggregates. */
    includePosts?: boolean;
    /** Omit aggregate activity when a metadata/presence read does not need it. */
    includeActivity?: boolean;
    /**
     * Return only the mesh/topic/caller-membership/activity fields consumed by
     * WebMCP topology. This prevents model-context reads from hydrating
     * governance, profile, presence, follow, or post collections.
     */
    activityOnly?: boolean;
    /**
     * Restrict a topology read to a small candidate set. Implementations must
     * still revalidate current caller visibility before returning any mesh.
     */
    meshIds?: string[];
  }): Promise<RepositoryProjection>;
  findRuntimeSessionByTokenHash?(
    tokenHash: string,
  ): Promise<RepositoryRuntimeSession | null>;
  findRuntimeSessionById?(
    sessionId: string,
  ): Promise<RepositoryRuntimeSession | null>;
  findActiveRuntimeSessionForAgent?(
    agentId: string,
    now: string,
    offlineAfter: string,
  ): Promise<RepositoryRuntimeSession | null>;
  purgeExpired?(now: string): Promise<number>;
  findWebMcpGrant?(
    tokenHash: string,
    humanSessionHash: string,
  ): Promise<RepositoryWebMcpGrant | null>;
  /**
   * Recover the currently active page grant after a transfer response or
   * cookie write was interrupted. Implementations must validate the
   * human-scoped fence before returning the grant.
   */
  findActiveWebMcpGrant?(
    humanSessionHash: string,
    agentId: string,
  ): Promise<RepositoryWebMcpGrant | null>;
  findAccountByProvider(
    provider: SocialProvider,
    subject: string,
  ): Promise<RepositoryAccount | null>;
  /** Resolve an existing account for an explicit owner-invited collaborator. */
  findAccountByEmail(email: string): Promise<RepositoryAccount | null>;
  findAccountById(accountId: string): Promise<RepositoryAccount | null>;
  createSocialAccount(input: {
    provider: SocialProvider;
    subject: string;
    email: string;
    displayName: string;
  }): Promise<RepositoryAccount>;
  /** Production-only, audited account/session bootstrap used by the resident
   * cohort operator. API request handlers never call this capability. */
  provisionResidentPrincipal?(
    input: RepositoryResidentPrincipalInput,
  ): Promise<RepositoryResidentPrincipalResult>;
  linkProvider(input: {
    accountId: string;
    provider: SocialProvider;
    subject: string;
    email: string;
    /** Session proof is revalidated in the same transaction as the link. */
    humanSessionHash?: string;
    /** Fresh proof of an already-linked identity, required for production account linking. */
    reauthProvider?: SocialProvider;
    reauthSubject?: string;
    linkedAt?: string;
  }): Promise<void>;
  /** Provider identities attached to an account; subjects are never exposed. */
  listProviderIdentities?(accountId: string): Promise<
    Array<{
      provider: SocialProvider;
      email: string;
      linkedAt: string;
    }>
  >;
  createHumanSession(input: {
    tokenHash: string;
    accountId: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    absoluteExpiresAt: string;
    /**
     * Production social sign-in admission. Firestore consumes both the
     * stable provider-subject and resolved-account buckets in the same
     * transaction that creates the durable session. SQLite intentionally
     * ignores this optional hint and retains the process-local limiter used
     * by isolated/local servers.
    */
    socialRateLimit?: {
      /**
       * SHA-256 of `<provider>:<subject>`; raw provider subjects never enter
       * quota keys.
       */
      subjectHash: string;
      capacity: number;
      refillPerSecond: number;
    };
  }): Promise<void>;
  findHumanSession(tokenHash: string): Promise<{
    accountId: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    absoluteExpiresAt: string;
    lastSeenAt: string;
  } | null>;
  touchHumanSession(tokenHash: string, lastSeenAt: string): Promise<void>;
  startRuntimeSession(input: {
    agentId: string;
    bindingId: string;
    sessionId: string;
    runtimeKind: RuntimeKind;
    tokenHash: string;
    expiresAt: string;
    challengeId?: string;
    challengeUsedAt?: string;
    /** Renewal-only compare-and-swap guard. Fresh starts intentionally omit it. */
    expectedSessionId?: string;
    expectedAuthorityEpoch?: number;
    /**
     * Allow a signed renewal to replace an expired predecessor when the
     * authority fence still points at that exact native session. This is the
     * bounded recovery path for a host that was offline longer than the
     * fifteen-minute session TTL; it never bypasses the epoch/kind/session
     * compare-and-set checks above.
     */
    allowExpiredPredecessorRecovery?: boolean;
    /** Mark the approved binding claimed in the same transaction as the session. */
    claimPairing?: boolean;
    /** Immutable session lifecycle records committed with the authority change. */
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{ authorityEpoch: number }>;
  heartbeatRuntimeSession(sessionId: string, now?: string): Promise<void>;
  transferPageAuthority(input: {
    agentId: string;
    grantId: string;
    humanSessionHash: string;
    expiresAt: string;
    sessionId: string;
    /** Optional immutable records committed with the authority transfer. */
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{ authorityEpoch: number; sessionId: string }>;
  createPostWithOutbox(
    input: RepositoryPostInput,
  ): Promise<RepositoryPostResult>;
}

export type FirestoreRepository = FirestoreMeshrRepository;
