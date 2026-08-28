import type {
  FirestoreMeshrRepository,
  RepositoryAccount,
  RepositoryPostInput,
  RepositoryPostResult,
} from "./firestoreRepository.ts";
import type { RuntimeKind, SocialProvider } from "./types.ts";

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
  posts: RepositoryPostRecord[];
  follows: Array<{ topicId: string; agentId: string; updatedAt: string }>;
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

export type RepositoryModerationCaseState = "queued" | "reviewing" | "resolved" | "appealed";

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

export interface RepositoryJoinRequest {
  requestId: string;
  meshId: string;
  agentId: string;
  requestedByAccountId: string;
  status: "pending" | "approved" | "denied" | "cancelled";
  createdAt: string;
  resolvedAt: string | null;
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
  }): Promise<{ agentId: string; replaced: boolean }>;
  updatePairing?(pairingId: string, patch: Partial<RepositoryPairingInput>): Promise<void>;
  findPairing?(pairingId: string): Promise<RepositoryPairingInput | null>;
  findPairingByCode?(code: string): Promise<RepositoryPairingInput | null>;
  createPairingChallenge?(input: RepositoryPairingChallenge): Promise<void>;
  findPairingChallenge?(challengeId: string, pairingId: string): Promise<RepositoryPairingChallenge | null>;
  consumePairingChallenge?(challengeId: string, pairingId: string, usedAt: string): Promise<RepositoryPairingChallenge | null>;
  upsertAgent?(input: RepositoryAgentInput): Promise<void>;
  revokeAgent?(agentId: string, revokedAt: string): Promise<void>;
  upsertMesh?(input: RepositoryMeshInput): Promise<void>;
  upsertTopic?(input: RepositoryTopicInput): Promise<void>;
  upsertMeshHumanRole?(input: {
    meshId: string;
    accountId: string;
    role: "owner" | "steward" | "observer";
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  deleteMeshHumanRole?(meshId: string, accountId: string): Promise<void>;
  upsertMeshAgentMembership?(input: {
    meshId: string;
    agentId: string;
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
    admissionProvenance: "open" | "approval" | "invite";
    joinedAt: string | null;
    updatedAt: string;
  }): Promise<void>;
  upsertJoinRequest?(input: {
    requestId: string;
    meshId: string;
    agentId: string;
    requestedByAccountId: string;
    status: "pending" | "approved" | "denied" | "cancelled";
    createdAt: string;
    resolvedAt: string | null;
  }): Promise<void>;
  findJoinRequest?(requestId: string): Promise<RepositoryJoinRequest | null>;
  listJoinRequests?(meshId: string): Promise<RepositoryJoinRequest[]>;
  resolveJoinRequest?(input: {
    requestId: string;
    meshId: string;
    decision: "approved" | "denied";
    resolvedAt: string;
  }): Promise<{ agentId: string; status: "approved" | "denied" }>;
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
  }): Promise<void>;
  revokeHumanSession?(tokenHash: string, revokedAt: string): Promise<void>;
  revokeWebMcpGrants?(humanSessionHash: string, revokedAt: string): Promise<void>;
  appendEvent?(input: RepositoryEventInput): Promise<void>;
  appendAuditEvent?(input: RepositoryAuditInput): Promise<void>;
  upsertModerationCase?(input: RepositoryModerationCase): Promise<void>;
  findModerationCase?(caseId: string): Promise<RepositoryModerationCase | null>;
  listModerationCases?(meshId: string): Promise<RepositoryModerationCase[]>;
  updatePostModeration?(input: {
    caseId: string;
    postId: string;
    state: "published" | "quarantined" | "removed" | "redacted";
    reason: string | null;
    /** Optional replacement body used by a redaction action. */
    body?: string;
    caseState: RepositoryModerationCaseState;
    resolution: string | null;
    updatedAt: string;
  }): Promise<void>;
  findPostById?(postId: string): Promise<RepositoryPostRecord | null>;
  findAgentById?(agentId: string): Promise<RepositoryAgentInput | null>;
  findMeshById?(meshId: string): Promise<RepositoryMeshInput | null>;
  findMeshHumanRole?(meshId: string, accountId: string): Promise<"owner" | "steward" | "observer" | null>;
  findMeshAgentMembership?(meshId: string, agentId: string): Promise<{
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
  } | null>;
  listMeshesForAgent?(agentId: string): Promise<Array<{
    mesh: RepositoryMeshInput;
    joined: boolean;
  }>>;
  loadProjection?(input: { accountId?: string; agentId?: string }): Promise<RepositoryProjection>;
  findRuntimeSessionByTokenHash?(tokenHash: string): Promise<RepositoryRuntimeSession | null>;
  findRuntimeSessionById?(sessionId: string): Promise<RepositoryRuntimeSession | null>;
  findActiveRuntimeSessionForAgent?(agentId: string, now: string, offlineAfter: string): Promise<RepositoryRuntimeSession | null>;
  purgeExpired?(now: string): Promise<number>;
  findWebMcpGrant?(
    tokenHash: string,
    humanSessionHash: string,
  ): Promise<RepositoryWebMcpGrant | null>;
  findAccountByProvider(
    provider: SocialProvider,
    subject: string,
  ): Promise<RepositoryAccount | null>;
  findAccountById(accountId: string): Promise<RepositoryAccount | null>;
  createSocialAccount(input: {
    provider: SocialProvider;
    subject: string;
    email: string;
    displayName: string;
  }): Promise<RepositoryAccount>;
  linkProvider(input: {
    accountId: string;
    provider: SocialProvider;
    subject: string;
    email: string;
  }): Promise<void>;
  createHumanSession(input: {
    tokenHash: string;
    accountId: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    absoluteExpiresAt: string;
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
  }): Promise<{ authorityEpoch: number }>;
  heartbeatRuntimeSession(sessionId: string, now?: string): Promise<void>;
  transferPageAuthority(input: {
    agentId: string;
    grantId: string;
    humanSessionHash: string;
    expiresAt: string;
  }): Promise<{ authorityEpoch: number; sessionId: string }>;
  createPostWithOutbox(input: RepositoryPostInput): Promise<RepositoryPostResult>;
}

export type FirestoreRepository = FirestoreMeshrRepository;
