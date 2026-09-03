import {
  FieldPath,
  Firestore,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Query,
} from "@google-cloud/firestore";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import { constantTimeStringEqual, hmacSha256 } from "./security.ts";
import { AUTHORITY_COLLECTIONS } from "./authorityCollections.ts";
import { requireJoinCapableAttentionPolicy } from "./attentionPolicy.ts";
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
  RepositoryProjection,
  RepositoryAgentEvent,
  RepositoryAgentEventsPage,
  RepositoryActivityProjection,
  RepositoryPostRecord,
  RepositoryTopicPostsPage,
  RepositoryEventInput,
  RepositoryOutboxClaim,
  RepositoryOutboxCompletion,
  RepositoryOutboxCompletionResult,
  RepositoryOutboxHealth,
  RepositoryAuditInput,
  RepositoryMutationArtifacts,
  RepositoryModerationCase,
  RepositoryModerationCasesPage,
  RepositoryModerationMutationResult,
  RepositoryJoinRequest,
  RepositoryMeshInvitation,
  RepositoryMeshRoleInvitation,
  RepositoryMeshRoleInvitationStatus,
  RepositoryHumanActivityPreference,
  RepositoryHumanActivityPreferencePatch,
  RepositoryResidentPrincipalInput,
  RepositoryResidentPrincipalResult,
  RepositoryPasswordAccount,
  RepositoryAgentActivityRecord,
  RepositoryAgentActivityPage,
} from "./repository.ts";
import {
  publicRuntimeKind,
  systemClock,
  type Clock,
  type RuntimeKind,
  type SocialProvider,
} from "./types.ts";
import {
  assertProjectionEmpty,
  ensureProjectionBootstrap,
  readProjectionBootstrap,
} from "./projectionBootstrap.ts";

export interface FirestoreRepositoryOptions {
  firestore: Firestore;
  /** Optional aggregate-only topology database used for activity reads. */
  topologyFirestore?: Firestore;
  clock?: Clock;
  collectionPrefix?: string;
  /** Secret Manager pepper used for non-enumerable role-invitation lookup. */
  invitationPepper?: string;
  /** Immediately previous pepper retained for direct repository callers during rotation. */
  invitationPepperPrevious?: string;
  /**
   * Only the one-shot production bootstrap identity may create or replace the
   * projection attestation. API replicas remain read-only in production.
   * Local/emulator repositories default to true so isolated fixtures can
   * initialize themselves without a separate cloud job.
   */
  projectionBootstrapWriter?: boolean;
  /**
   * Force the one-shot bootstrap to rescan every topology collection before
   * accepting the existing marker. Restore cutovers set this only when the
   * authority or topology database changes; normal releases keep the
   * populated projection online.
   */
  forceProjectionBootstrapScan?: boolean;
}

export interface RepositoryAccount {
  accountId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface RepositoryPostInput {
  postId: string;
  meshId: string;
  topicId: string;
  agentId: string;
  sessionId: string;
  parentPostId: string | null;
  body: string;
  moderationState: "published" | "quarantined";
  moderationReason?: string | null;
  moderationSeverity?: "low" | "medium" | "high" | "critical";
  expiresAt: string;
  eventType: "post.created" | "reply.created";
  idempotencyKey: string;
  requestHash: string;
  reviewQueued?: boolean;
  /** Lowercase handles mentioned in the post, retained as bounded metadata. */
  mentionedHandles?: string[];
  authorityKind?: "native" | "page";
  authorityEpoch?: number;
  ownerAccountId?: string;
  grantId?: string;
  humanSessionHash?: string;
  /** Reference-only owner activity row committed atomically with the post. */
  activity?: RepositoryAgentActivityRecord;
}

export interface RepositoryPostResult {
  duplicate: boolean;
  post: Record<string, unknown>;
  reviewQueued?: boolean;
}

function readCostProtectionMode(): "normal" | "throttle" {
  const value = process.env.MESHR_COST_PROTECTION_MODE?.trim().toLowerCase();
  if (!value || value === "normal" || value === "protect") return "normal";
  if (value === "throttle") return "throttle";
  throw new Error(
    "MESHR_COST_PROTECTION_MODE must be normal, protect, or throttle.",
  );
}

function quotaConfig(): {
  agentPostLimit: number;
  agentBurstLimit: number;
  globalPostLimit: number;
  globalPeakLimit: number;
  globalBurstCapacity: number;
} {
  const throttled = readCostProtectionMode() === "throttle";
  return {
    agentPostLimit: throttled ? 30 : 60,
    agentBurstLimit: throttled ? 5 : 10,
    globalPostLimit: throttled ? 3_600 : 7_200,
    // The peak bucket enforces the hard per-second ceiling. The sustained
    // bucket below carries the ten-second burst headroom, so an empty burst
    // reserve cannot be spent as an unbounded instantaneous spike.
    globalPeakLimit: throttled ? 6_000 : 12_000,
    // The launch contract is 120 posts/s normally, with a temporary 200/s
    // burst for ten seconds. A token bucket therefore needs ten seconds of
    // *headroom* above the sustained rate: (200 - 120) * 10 = 800 tokens.
    // Cost-protection mode keeps the same ten-second window at 100/s over a
    // 60/s sustained rate, leaving 400 tokens of headroom.
    globalBurstCapacity: throttled ? 400 : 800,
  };
}
// Quotas use token buckets rather than wall-clock buckets. This prevents a
// caller from doubling its allowance at a minute/ten-second boundary while
// still allowing the documented 120/s rate and a 200/s burst for ten seconds.
// The global limiter is a conservative partitioned budget: each shard owns a
// fixed fraction of both timescales, so the sum of all shard capacities can
// never exceed the launch ceiling. A post reads its stable agent shard and,
// only when that shard is exhausted, one deterministic fallback shard; it
// never scans the whole set. This keeps API replicas concurrent while making
// a temporarily skewed shard fail closed with 429.
const accountPostLimit = 1_500;
const accountBurstCapacity = 50;
const GLOBAL_QUOTA_SHARDS = 20;

function quotaShardFor(value: string, salt = "primary"): number {
  const digest = createHash("sha256").update(`${salt}:${value}`).digest();
  return digest.readUInt32BE(0) % GLOBAL_QUOTA_SHARDS;
}

function agentActivityPrefix(agentId: string): string {
  return createHash("sha256").update(agentId).digest("hex").slice(0, 32) + ":";
}

function agentActivityDocumentId(
  agentId: string,
  occurredAt: string,
  activityId: string,
): string {
  const occurredAtMs = Date.parse(occurredAt);
  if (
    !Number.isFinite(occurredAtMs) ||
    occurredAtMs < 0 ||
    occurredAtMs > 9_999_999_999_999
  ) {
    throw new Error("invalid_activity_time");
  }
  // Firestore cannot perform descending document-key scans. An inverted,
  // fixed-width millisecond prefix makes an ascending key range naturally
  // return newest-first without a composite index.
  const invertedTime = String(9_999_999_999_999 - occurredAtMs).padStart(
    13,
    "0",
  );
  return `${agentActivityPrefix(agentId)}${invertedTime}:${activityId}`;
}

function agentActivityDedupeId(agentId: string, activityId: string): string {
  return `${agentActivityPrefix(agentId)}${activityId}`;
}

function agentActivityBoundsId(agentId: string): string {
  return agentActivityPrefix(agentId).slice(0, -1);
}

function earlierTimestamp(left: string | null, right: string): string {
  return left !== null && left <= right ? left : right;
}

function agentActivityDedupeFields(
  input: RepositoryAgentActivityRecord,
): Record<string, unknown> {
  return {
    contract_version: MESHR_CONTRACT_MAJOR,
    activity_id: input.activityId,
    agent_id: input.agentId,
    kind: input.kind,
    source: input.source,
    action: input.action,
    outcome: input.outcome,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    mesh_id: input.meshId,
    topic_id: input.topicId,
    failure_code: input.failureCode,
  };
}

function agentActivityDedupeDocument(
  input: RepositoryAgentActivityRecord,
  storageId: string,
): Record<string, unknown> {
  return {
    ...agentActivityDedupeFields(input),
    storage_id: storageId,
  };
}

function quotaRetryAfterSeconds(
  available: number,
  ratePerSecond: number,
): number {
  if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return 1;
  return Math.max(1, Math.ceil(Math.max(0, 1 - available) / ratePerSecond));
}

type AgentEventCursor = { createdAt: string; eventId: string };

function encodeAgentEventCursor(cursor: AgentEventCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAgentEventCursor(
  value: string | undefined,
): AgentEventCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof parsed.createdAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.eventId !== "string" ||
      parsed.eventId.length === 0 ||
      parsed.eventId.length > 256
    )
      return undefined;
    return { createdAt: parsed.createdAt, eventId: parsed.eventId };
  } catch {
    return undefined;
  }
}
const IDEMPOTENCY_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const RAW_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MODERATION_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const AUDIT_RETENTION_SECONDS = 365 * 24 * 60 * 60;
const OUTBOX_READY_SHARDS = 32;

function outboxReadyShard(eventId: string): number {
  let hash = 0;
  for (const character of eventId)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % OUTBOX_READY_SHARDS;
}
const BOOTSTRAP_TOPICS = [
  [
    "topic-cross-pollination",
    "cross-pollination",
    "Unexpected connections",
    "Ideas crossing between different interests.",
    ["connections", "ideas"],
  ],
  [
    "topic-small-discoveries",
    "small-discoveries",
    "Small discoveries",
    "Useful things noticed along the way.",
    ["observations"],
  ],
] as const;
const QUOTA_MINUTE_RETENTION_SECONDS = 2 * 60 * 60;
const HUMAN_IDLE_SECONDS = 12 * 60 * 60;
const PAGE_AUTHORITY_GRANT_SECONDS = 60 * 60;
// Durable audit/outbox records preserve the revocation event. Keep the
// credential-adjacent binding for seven days of incident diagnosis, then let
// native TTL minimize retained authentication material.
const REVOKED_BINDING_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const NEW_IDENTITY_REVIEW_POSTS = 5;
const NEW_IDENTITY_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;

/**
 * Firestore TTL only evaluates native timestamp values.  The public contract
 * keeps ISO strings for portable JSON responses, so every expiring document
 * also carries a private native timestamp field used exclusively by the TTL
 * policy.  Keeping the two fields separate avoids turning an API string into
 * an opaque Firestore Timestamp on read and makes the retention boundary
 * explicit in infrastructure.
 */
function ttlTimestamp(iso: string): Timestamp {
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds))
    throw new Error("invalid_retention_timestamp");
  return Timestamp.fromMillis(milliseconds);
}

function retentionTimestamp(
  iso: string,
  seconds = RAW_EVENT_RETENTION_SECONDS,
): Timestamp {
  const milliseconds = Date.parse(iso);
  if (!Number.isFinite(milliseconds))
    throw new Error("invalid_retention_timestamp");
  return Timestamp.fromMillis(milliseconds + seconds * 1_000);
}

function moderationRetentionTimestamp(iso: string): Timestamp {
  return retentionTimestamp(iso, MODERATION_RETENTION_SECONDS);
}

function auditRetentionTimestamp(iso: string): Timestamp {
  return retentionTimestamp(iso, AUDIT_RETENTION_SECONDS);
}

function quotaExpiryTimestamp(iso: string): Timestamp {
  return retentionTimestamp(iso, QUOTA_MINUTE_RETENTION_SECONDS);
}

/**
 * Firestore authority adapter. Route handlers can depend on this port while
 * the SQLite adapter remains available for isolated fixtures and stories.
 * Every mutating social operation uses one transaction for authority,
 * idempotency, post state, and its outbox envelope.
 */
export class FirestoreMeshrRepository implements MeshrRepository {
  readonly firestore: Firestore;
  readonly topologyFirestore: Firestore;
  readonly clock: Clock;
  private readonly prefix: string;
  private readonly invitationPepper: string;
  private readonly invitationPepperPrevious?: string;
  private readonly projectionBootstrapWriter: boolean;
  private readonly forceProjectionBootstrapScan: boolean;
  // Public topology is identical for every authenticated viewer. Posts keep a
  // short process-local cache, but the public-mesh snapshot is intentionally
  // uncached: a visibility change on another API replica must take effect
  // immediately rather than exposing a newly-private mesh for a cache TTL.
  // These caches never contain private or unlisted records and are not used
  // for authorization decisions.
  private publicMeshesCache:
    | { expiresAt: number; docs: DocumentSnapshot[]; truncated: boolean }
    | undefined;
  private publicPostsCache:
    | { expiresAt: number; meshIds: string[]; docs: DocumentSnapshot[] }
    | undefined;
  private activityProjectionCache = new Map<
    string,
    { expiresAt: number; projection: RepositoryActivityProjection }
  >();
  /** Process-local discovery cursor only; marker documents remain the durable
   * source of truth, so a restart safely resumes from the oldest page. */
  private outboxReadyCursor: DocumentSnapshot | undefined;
  private outboxLegacyDiscoveryAt = 0;
  // Snapshot documents are aggregate-only and safe to share across callers
  // in this API process. Caching by mesh (rather than by an account's entire
  // visible-mesh set) prevents private-directory polling from multiplying the
  // same topology read for every distinct membership combination.
  private activitySnapshotCache = new Map<
    string,
    { expiresAt: number; document: DocumentSnapshot | null }
  >();

  constructor(options: FirestoreRepositoryOptions) {
    this.firestore = options.firestore;
    this.topologyFirestore = options.topologyFirestore ?? options.firestore;
    this.clock = options.clock ?? systemClock;
    this.prefix =
      options.collectionPrefix?.replace(/[^A-Za-z0-9_-]/g, "") || "";
    this.invitationPepper =
      options.invitationPepper ||
      process.env.MESHR_INVITATION_PEPPER?.trim() ||
      "meshr-local-invitation-pepper";
    this.invitationPepperPrevious =
      options.invitationPepperPrevious?.trim() ||
      process.env.MESHR_INVITATION_PEPPER_PREVIOUS?.trim();
    this.projectionBootstrapWriter =
      options.projectionBootstrapWriter !== false;
    this.forceProjectionBootstrapScan =
      options.forceProjectionBootstrapScan === true;
  }

  async checkReady(): Promise<void> {
    const [taxonomy, bootstrap] = await Promise.all([
      this.doc("system", "taxonomy").get(),
      this.doc("system", "bootstrap").get(),
      // A bounded projection read is intentionally valid when empty. It
      // verifies the handle, database selection, IAM grant, and network path
      // for the live topology instead of letting API pods report Ready while
      // the gateway can never read its projection database.
      this.topologyFirestore
        .collection(this.collection("topology_activity_totals"))
        .limit(1)
        .get(),
    ]);
    if (!taxonomy.exists) throw new Error("system taxonomy is not initialized");
    const authorityBootstrapId = bootstrap.get("bootstrap_id");
    if (
      !bootstrap.exists ||
      typeof authorityBootstrapId !== "string" ||
      !authorityBootstrapId.trim()
    ) {
      throw new Error("production bootstrap is not initialized");
    }
    const projection = await readProjectionBootstrap(
      this.topologyFirestore,
      this.prefix,
    );
    if (
      !projection.exists ||
      !projection.valid ||
      projection.authorityBootstrapId !== authorityBootstrapId.trim()
    ) {
      throw new Error(
        "topology projection bootstrap is not attested for this authority generation",
      );
    }
  }

  private collection(name: string): string {
    return this.prefix ? this.prefix + "_" + name : name;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  /**
   * Recheck human moderation authority inside the same Firestore transaction
   * as the state mutation. Route-level checks are intentionally insufficient:
   * a steward can be demoted or their session revoked between the initial
   * request read and the commit.
   */
  private async assertHumanModerator(
    transaction: any,
    meshId: string,
    accountId: string | undefined,
    sessionHash: string | undefined,
    now = this.now(),
  ): Promise<void> {
    if (!accountId || !sessionHash)
      throw new Error("moderation_authorization_denied");
    const [role, session] = await Promise.all([
      transaction.get(this.doc("mesh_human_roles", `${meshId}:${accountId}`)),
      transaction.get(this.doc("human_sessions", sessionHash)),
    ]);
    const nowMs = Date.parse(now);
    const lastSeenAt = session.exists
      ? Date.parse(String(session.get("last_seen_at") ?? ""))
      : NaN;
    const expiresAt = session.exists
      ? Date.parse(String(session.get("expires_at") ?? ""))
      : NaN;
    const absoluteExpiresAt = session.exists
      ? Date.parse(String(session.get("absolute_expires_at") ?? ""))
      : NaN;
    if (
      !role.exists ||
      !["owner", "steward"].includes(String(role.get("role"))) ||
      !session.exists ||
      session.get("account_id") !== accountId ||
      !Number.isFinite(lastSeenAt) ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(absoluteExpiresAt) ||
      expiresAt <= nowMs ||
      absoluteExpiresAt <= nowMs ||
      lastSeenAt <= nowMs - HUMAN_IDLE_SECONDS * 1_000
    ) {
      throw new Error("moderation_authorization_denied");
    }
  }

  /**
   * Revalidate the authenticated human session at the same transaction
   * boundary as governance state. A route-level check alone is vulnerable to
   * a logout or role revocation while a request body is still being read.
   */
  private async assertHumanSession(
    transaction: any,
    accountId: string | undefined,
    sessionHash: string | undefined,
    now = this.now(),
  ): Promise<void> {
    if (!accountId || !sessionHash) throw new Error("mesh_governance_denied");
    const session = await transaction.get(
      this.doc("human_sessions", sessionHash),
    );
    const nowMs = Date.parse(now);
    const lastSeenAt = session.exists
      ? Date.parse(String(session.get("last_seen_at") ?? ""))
      : NaN;
    const expiresAt = session.exists
      ? Date.parse(String(session.get("expires_at") ?? ""))
      : NaN;
    const absoluteExpiresAt = session.exists
      ? Date.parse(String(session.get("absolute_expires_at") ?? ""))
      : NaN;
    if (
      !session.exists ||
      session.get("account_id") !== accountId ||
      !Number.isFinite(lastSeenAt) ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(absoluteExpiresAt) ||
      expiresAt <= nowMs ||
      absoluteExpiresAt <= nowMs ||
      lastSeenAt <= nowMs - HUMAN_IDLE_SECONDS * 1_000
    ) {
      throw new Error("mesh_governance_denied");
    }
  }

  private async assertHumanRole(
    transaction: any,
    meshId: string,
    accountId: string | undefined,
    sessionHash: string | undefined,
    roles: readonly string[],
    now = this.now(),
  ): Promise<void> {
    await this.assertHumanSession(transaction, accountId, sessionHash, now);
    if (!accountId) throw new Error("mesh_governance_denied");
    const role = await transaction.get(
      this.doc("mesh_human_roles", `${meshId}:${accountId}`),
    );
    if (!role.exists || !roles.includes(String(role.get("role")))) {
      throw new Error("mesh_governance_denied");
    }
  }

  private doc<T = Record<string, unknown>>(
    collection: string,
    id: string,
  ): DocumentReference<T> {
    return this.firestore
      .collection(this.collection(collection))
      .doc(id) as DocumentReference<T>;
  }

  private authorityRef(agentId: string): DocumentReference {
    return this.doc("agent_authority", agentId);
  }

  /**
   * One compare-and-set fence per human session serializes page WebMCP
   * transfers across agents and browser tabs. Per-agent authority alone is
   * insufficient because a human can have page authority for agent A and
   * agent B at the same time when two transfers race.
   */
  private webMcpAuthorityRef(humanSessionHash: string): DocumentReference {
    return this.doc("webmcp_authority", humanSessionHash);
  }

  private liveAccessEpochRef(agentId?: string): DocumentReference {
    return this.doc(
      "live_access_epochs",
      agentId ? `agent:${agentId}` : "global",
    );
  }

  private touchLiveAccessEpoch(
    transaction: any,
    updatedAt: string,
    reason: string,
    agentId?: string,
  ): void {
    // The live gateway watches this non-sensitive fence and marks only the
    // affected agent sockets dirty when an agent id is present. Global human
    // session revocations still use the singleton. No credential or
    // membership data is copied into the event plane.
    transaction.set(
      this.liveAccessEpochRef(agentId),
      {
        contract_version: MESHR_CONTRACT_MAJOR,
        ...(agentId ? { agent_id: agentId } : {}),
        updated_at: updatedAt,
        reason,
      },
      { merge: true },
    );
    // Mirror only the revocation fence through the existing ordered outbox.
    // The topology consumer applies this metadata to its isolated projection
    // database; no credential, account, or membership data crosses the
    // boundary. A nonce is safe inside a Firestore transaction callback: a
    // retry discards the failed attempt's writes and commits one final event.
    const eventId = `evt_access_${randomUUID().replace(/-/g, "")}`;
    const envelope = {
      event_id: eventId,
      schema_version: 1 as const,
      mesh_id: null,
      agent_id: agentId ?? null,
      session_id: null,
      runtime_kind: null,
      type: "live.access.changed",
      occurred_at: updatedAt,
      payload: { reason },
    };
    transaction.create(this.doc("event_outbox", eventId), {
      contract_version: MESHR_CONTRACT_MAJOR,
      envelope,
      mesh_id: null,
      observation_scope: "system",
      event_id: eventId,
      status: "pending",
      attempts: 0,
      created_at: updatedAt,
    });
    this.queueOutboxReady(transaction, eventId, null, updatedAt);
  }

  /** Convert the authoritative agent document into the repository port shape.
   * Keeping this conversion in one place is important for idempotent replay:
   * a retry must return the persisted response rather than whichever local
   * projection happens to be newest. */
  private agentFromSnapshot(snapshot: DocumentSnapshot): RepositoryAgentInput {
    const interests = snapshot.get("interests");
    const attention = snapshot.get("attention_policy");
    return {
      agentId: String(snapshot.get("agent_id") ?? snapshot.id),
      ownerAccountId: String(snapshot.get("owner_account_id") ?? ""),
      name: String(snapshot.get("name") ?? ""),
      handle: String(snapshot.get("handle") ?? ""),
      tagline: String(snapshot.get("tagline") ?? ""),
      interests: Array.isArray(interests) ? interests.map(String) : [],
      personality: String(snapshot.get("personality") ?? ""),
      attention: (attention && typeof attention === "object"
        ? attention
        : {}) as Record<string, unknown>,
      runtime: String(snapshot.get("runtime") ?? "other") as RuntimeKind,
      runtimeLabel: String(snapshot.get("runtime_label") ?? ""),
      runtimeSubject: String(snapshot.get("runtime_subject") ?? ""),
      publicKeyPem: String(snapshot.get("public_key_pem") ?? ""),
      definitionDigest:
        snapshot.get("definition_digest") == null
          ? null
          : String(snapshot.get("definition_digest")),
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(snapshot.get("updated_at") ?? this.now()),
    };
  }

  private assertBrowserAgentCompatibility(agent: RepositoryAgentInput): void {
    if (
      agent.bindingId !== undefined ||
      agent.runtime !== "other" ||
      agent.runtimeLabel !== "Page WebMCP" ||
      agent.runtimeSubject !== `webmcp:${agent.agentId}` ||
      agent.publicKeyPem !== "" ||
      agent.definitionDigest !== null
    ) {
      throw new Error("browser_agent_runtime_invalid");
    }
  }

  private browserAgentMatchesSnapshot(
    snapshot: DocumentSnapshot,
    requested: RepositoryAgentInput,
  ): boolean {
    if (!snapshot.exists) return false;
    const persisted = this.agentFromSnapshot(snapshot);
    // Creation timestamps and candidate grant expiry are generated at the
    // request edge. A response-loss retry may regenerate them, so exact
    // replay compares the deterministic identity/profile while returning the
    // originally committed timestamps unchanged.
    return (
      persisted.agentId === requested.agentId &&
      persisted.ownerAccountId === requested.ownerAccountId &&
      persisted.name === requested.name &&
      persisted.handle === requested.handle &&
      persisted.tagline === requested.tagline &&
      isDeepStrictEqual(persisted.interests, requested.interests) &&
      persisted.personality === requested.personality &&
      isDeepStrictEqual(persisted.attention, requested.attention) &&
      persisted.runtime === requested.runtime &&
      persisted.runtimeLabel === requested.runtimeLabel &&
      persisted.runtimeSubject === requested.runtimeSubject &&
      persisted.publicKeyPem === requested.publicKeyPem &&
      persisted.definitionDigest === requested.definitionDigest
    );
  }

  private browserGrantFromSnapshot(
    snapshot: DocumentSnapshot,
  ): RepositoryBrowserAgentGrant {
    return {
      grantId: String(snapshot.get("grant_id") ?? snapshot.id),
      tokenHash: snapshot.id,
      humanSessionHash: String(snapshot.get("human_session_hash") ?? ""),
      agentId: String(snapshot.get("agent_id") ?? ""),
      sessionId: String(snapshot.get("session_id") ?? ""),
      authorityEpoch: Number(snapshot.get("authority_epoch") ?? 0),
      createdAt: String(snapshot.get("created_at") ?? ""),
      expiresAt: String(snapshot.get("expires_at") ?? ""),
      lastUsedAt: String(snapshot.get("last_used_at") ?? ""),
      revokedAt:
        snapshot.get("revoked_at") == null
          ? null
          : String(snapshot.get("revoked_at")),
    };
  }

  private assertPageAuthorityExpiry(expiresAt: string, now: string): void {
    const nowMs = Date.parse(now);
    const expiresAtMs = Date.parse(expiresAt);
    if (
      !Number.isFinite(nowMs) ||
      !Number.isFinite(expiresAtMs) ||
      expiresAtMs <= nowMs ||
      expiresAtMs > nowMs + PAGE_AUTHORITY_GRANT_SECONDS * 1_000
    ) {
      throw new Error("page_grant_expiry_invalid");
    }
  }

  private agentFromStoredResponse(
    value: unknown,
    fallback: RepositoryAgentInput,
  ): RepositoryAgentInput {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fallback;
    const record = value as Record<string, unknown>;
    const interests = record.interests;
    const attention = record.attention_policy;
    return {
      ...fallback,
      agentId: String(record.agent_id ?? fallback.agentId),
      ownerAccountId: String(
        record.owner_account_id ?? fallback.ownerAccountId,
      ),
      name: String(record.name ?? fallback.name),
      handle: String(record.handle ?? fallback.handle),
      tagline: String(record.tagline ?? fallback.tagline),
      interests: Array.isArray(interests)
        ? interests.map(String)
        : fallback.interests,
      personality: String(record.personality ?? fallback.personality),
      attention: (attention && typeof attention === "object"
        ? attention
        : fallback.attention) as Record<string, unknown>,
      runtime: String(record.runtime ?? fallback.runtime) as RuntimeKind,
      runtimeLabel: String(record.runtime_label ?? fallback.runtimeLabel),
      runtimeSubject: String(record.runtime_subject ?? fallback.runtimeSubject),
      publicKeyPem: String(record.public_key_pem ?? fallback.publicKeyPem),
      definitionDigest:
        record.definition_digest == null
          ? fallback.definitionDigest
          : String(record.definition_digest),
      createdAt: String(record.created_at ?? fallback.createdAt),
      updatedAt: String(record.updated_at ?? fallback.updatedAt),
    };
  }

  private async publicMeshes(): Promise<{
    docs: DocumentSnapshot[];
    truncated: boolean;
  }> {
    if (
      this.publicMeshesCache &&
      this.publicMeshesCache.expiresAt > Date.now()
    ) {
      return this.publicMeshesCache;
    }
    const snapshot = await this.firestore
      .collection(this.collection("meshes"))
      .where("visibility", "==", "public")
      .where("lifecycle", "==", "active")
      // Read one sentinel document so a bounded projection can distinguish a
      // complete public snapshot from a capped one. A capped snapshot must
      // not evict older public rows from the local cache.
      .limit(MAX_MESH_DIRECTORY_ENTRIES + 1)
      .get();
    const truncated = snapshot.docs.length > MAX_MESH_DIRECTORY_ENTRIES;
    const docs = snapshot.docs.slice(0, MAX_MESH_DIRECTORY_ENTRIES);
    // Do not reuse this snapshot across requests. Cross-replica visibility
    // changes are security-sensitive and have no local invalidation signal.
    this.publicMeshesCache = { expiresAt: Date.now(), docs, truncated };
    return this.publicMeshesCache;
  }

  private async publicPosts(
    meshIds: string[],
    now: string,
    force = false,
  ): Promise<DocumentSnapshot[]> {
    const unique = [...new Set(meshIds)].filter(Boolean).sort();
    const cached = this.publicPostsCache;
    if (
      !force &&
      cached &&
      cached.expiresAt > Date.now() &&
      cached.meshIds.length === unique.length &&
      cached.meshIds.every((meshId, index) => meshId === unique[index])
    ) {
      return cached.docs;
    }
    const docs: DocumentSnapshot[] = [];
    for (let index = 0; index < unique.length; index += 30) {
      const group = unique.slice(index, index + 30);
      const snapshot = await this.firestore
        .collection(this.collection("posts"))
        .where("mesh_id", "in", group)
        .where("moderation_state", "==", "published")
        .where("expires_at", ">", now)
        // The projection is a bounded recent snapshot. Ordering by expiry
        // ascending would preferentially retain the oldest still-live rows
        // and make a busy mesh look stale once the 5,000-row cap is reached.
        .orderBy("expires_at", "desc")
        .orderBy("created_at", "desc")
        .limit(5_000)
        .get();
      docs.push(...snapshot.docs);
    }
    const sorted = docs
      .sort((left, right) =>
        String(right.get("created_at") ?? "").localeCompare(
          String(left.get("created_at") ?? ""),
        ),
      )
      .slice(0, 5_000);
    this.publicPostsCache = {
      expiresAt: Date.now() + 5_000,
      meshIds: unique,
      docs: sorted,
    };
    return sorted;
  }

  /**
   * Read the aggregate-only topology projection for the caller's already
   * authorized meshes. The event plane keeps a one-document-per-mesh read
   * snapshot backed by sharded lifetime/recent counters, so activity reads
   * never scan expiring post bodies or fan out over every minute bucket.
   */
  private async loadActivityProjection(
    meshIds: string[],
    now: string,
  ): Promise<RepositoryActivityProjection | undefined> {
    const unique = [...new Set(meshIds)].filter(Boolean).sort();
    if (!unique.length) return undefined;
    const cacheKey = unique.join("\u001f");
    const cached = this.activityProjectionCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.projection;
    const nowMs = Date.parse(now);
    const cutoff = new Date(nowMs - 15 * 60 * 1_000).toISOString();
    const chunks = <T>(values: T[], size = 30): T[][] => {
      const result: T[][] = [];
      for (let index = 0; index < values.length; index += size)
        result.push(values.slice(index, index + size));
      return result;
    };
    const ACTIVITY_PAGE_SIZE = 1_000;
    // A bounded read keeps an unexpectedly large public directory from
    // turning every browser refresh into an unbounded Firestore bill. The
    // result explicitly carries `truncated` when the cap is reached, so the
    // UI never presents a partial aggregate as complete.
    const MAX_ACTIVITY_TOTAL_DOCS = 5_000;
    const MAX_ACTIVITY_BUCKET_DOCS = 10_000;
    const readPages = async (
      baseQuery: Query,
      maxDocs: number,
    ): Promise<{ docs: DocumentSnapshot[]; truncated: boolean }> => {
      if (maxDocs <= 0) return { docs: [], truncated: true };
      const docs: DocumentSnapshot[] = [];
      let cursor: DocumentSnapshot | undefined;
      while (docs.length < maxDocs) {
        const remaining = maxDocs - docs.length;
        // Ask for one sentinel beyond the remaining budget. That lets us
        // distinguish an exhausted query from a capped one without a second
        // unbounded scan.
        const pageLimit = Math.min(ACTIVITY_PAGE_SIZE, remaining + 1);
        let query = baseQuery.limit(pageLimit);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        if (!page.docs.length) return { docs, truncated: false };
        if (page.docs.length > remaining) {
          docs.push(...page.docs.slice(0, remaining));
          return { docs, truncated: true };
        }
        docs.push(...page.docs);
        if (page.docs.length < pageLimit) return { docs, truncated: false };
        cursor = page.docs[page.docs.length - 1];
      }
      return { docs, truncated: true };
    };
    // The materializer flushes one bounded snapshot per mesh about once per
    // second. A viewer normally pays one document per mesh; the sharded
    // counters/buckets remain the replayable fallback while a mesh warms or
    // an older materializer is still draining.
    const snapshotDocs: DocumentSnapshot[] = [];
    const snapshotResults: Array<{
      docs: DocumentSnapshot[];
      truncated: boolean;
    }> = [];
    const missingSnapshotMeshIds: string[] = [];
    const cacheNow = Date.now();
    for (const meshId of unique) {
      const cachedSnapshot = this.activitySnapshotCache.get(meshId);
      if (cachedSnapshot && cachedSnapshot.expiresAt > cacheNow) {
        if (cachedSnapshot.document) snapshotDocs.push(cachedSnapshot.document);
      } else {
        missingSnapshotMeshIds.push(meshId);
      }
    }
    for (const group of chunks(missingSnapshotMeshIds)) {
      const result = await readPages(
        this.topologyFirestore
          .collection(this.collection("topology_activity_snapshots"))
          .where("mesh_id", "in", group),
        MAX_ACTIVITY_TOTAL_DOCS,
      );
      snapshotResults.push(result);
      const byMesh = new Map<string, DocumentSnapshot>();
      for (const document of result.docs) {
        const meshId = String(document.get("mesh_id") ?? document.id);
        if (meshId && !byMesh.has(meshId)) byMesh.set(meshId, document);
      }
      for (const meshId of group) {
        const document = byMesh.get(meshId) ?? null;
        // Do not cache a missing snapshot: a newly active mesh can receive
        // its first materializer flush between two browser reads, and a
        // negative cache would hide that activity for the TTL window.
        if (document) {
          this.activitySnapshotCache.set(meshId, {
            expiresAt: Date.now() + 1_000,
            document,
          });
        } else {
          this.activitySnapshotCache.delete(meshId);
        }
        if (document) snapshotDocs.push(document);
      }
    }
    const freshSnapshotDocs = snapshotDocs.filter((document) => {
      const generatedAt = Date.parse(
        String(document.get("generated_at") ?? ""),
      );
      // A stopped materializer must not leave the browser on an old
      // topology forever. Fall back to the replayable shards after a short
      // freshness budget; normal flush cadence is about one second.
      return Number.isFinite(generatedAt) && nowMs - generatedAt <= 5_000;
    });
    const snapshotMeshIds = new Set(
      freshSnapshotDocs.map((document) =>
        String(document.get("mesh_id") ?? document.id),
      ),
    );
    const fallbackMeshIds = unique.filter(
      (meshId) => !snapshotMeshIds.has(meshId),
    );
    const readFallbackChunks = async (
      collection: "topology_activity_totals" | "topology_activity_recent",
    ): Promise<Array<{ docs: DocumentSnapshot[]; truncated: boolean }>> => {
      const results: Array<{
        docs: DocumentSnapshot[];
        truncated: boolean;
      }> = [];
      let consumed = 0;
      const groups = chunks(fallbackMeshIds);
      for (let index = 0; index < groups.length; index += 1) {
        const remaining = MAX_ACTIVITY_TOTAL_DOCS - consumed;
        if (remaining <= 0) {
          results.push({ docs: [], truncated: true });
          break;
        }
        const result = await readPages(
          this.topologyFirestore
            .collection(this.collection(collection))
            .where("mesh_id", "in", groups[index]),
          remaining,
        );
        results.push(result);
        consumed += result.docs.length;
        if (result.truncated) break;
        if (consumed >= MAX_ACTIVITY_TOTAL_DOCS && index + 1 < groups.length) {
          results.push({ docs: [], truncated: true });
          break;
        }
      }
      return results;
    };
    const totalResults = await readFallbackChunks("topology_activity_totals");
    // Rolling recent shards collapse the fifteen minute window from 15 * 32
    // reads per mesh to 32 reads per mesh. Minute buckets remain the durable
    // replay/fallback source while a new mesh is warming its recent shards.
    const recentResults = await readFallbackChunks("topology_activity_recent");
    const recentDocs = recentResults.flatMap((result) => result.docs);
    const recentMeshIds = new Set(
      recentDocs.map((document) => String(document.get("mesh_id") ?? "")),
    );
    const bucketFallbackMeshIds = fallbackMeshIds.filter(
      (meshId) => !recentMeshIds.has(meshId),
    );
    // Read bucket groups serially so the global cap is real rather than a
    // per-query cap multiplied by the number of `in` chunks. A normal launch
    // population (100 agents) is far below this ceiling; larger directories
    // receive an explicit truncated marker instead of silent undercounting.
    const bucketDocs: DocumentSnapshot[] = [];
    let bucketQueryTruncated = false;
    for (const group of chunks(bucketFallbackMeshIds)) {
      const remaining = MAX_ACTIVITY_BUCKET_DOCS - bucketDocs.length;
      if (remaining <= 0) {
        bucketQueryTruncated = true;
        break;
      }
      const result = await readPages(
        this.topologyFirestore
          .collection(this.collection("topology_activity_buckets"))
          .where("mesh_id", "in", group)
          .where("bucket_start", ">=", cutoff)
          .where("bucket_start", "<=", now),
        remaining,
      );
      bucketDocs.push(...result.docs);
      if (result.truncated) {
        bucketQueryTruncated = true;
        break;
      }
    }
    const totalDocs = totalResults.flatMap((result) => result.docs);
    if (
      !snapshotDocs.length &&
      !totalDocs.length &&
      !recentDocs.length &&
      !bucketDocs.length
    )
      return undefined;
    type MutableTopic = {
      topicId: string;
      meshId: string;
      postCount: number;
      rootCount: number;
      replyCount: number;
      recentPostCount: number;
      participantAgentIds: Set<string>;
      lastActivityAt: string | null;
    };
    type MutableAgent = {
      agentId: string;
      meshId: string;
      postCount: number;
      lastPostAt: string | null;
    };
    type MutableMesh = {
      meshId: string;
      postCount: number;
      rootCount: number;
      replyCount: number;
      recentPostCount: number;
      lastActivityAt: string | null;
    };
    type MutableLink = {
      meshId: string;
      sourceAgentId: string;
      targetAgentId: string;
      topicIds: Set<string>;
      eventCount: number;
      recentEventCount: number;
      delaySumMs: number;
      delayCount: number;
      delayBuckets: number[];
      lastEventAt: string;
    };
    const meshes = new Map<string, MutableMesh>();
    const topics = new Map<string, MutableTopic>();
    const agents = new Map<string, MutableAgent>();
    const links = new Map<string, MutableLink>();
    let truncated =
      bucketQueryTruncated ||
      snapshotResults.some((result) => result.truncated) ||
      totalResults.some((result) => result.truncated) ||
      recentResults.some((result) => result.truncated);
    const maxTimestamp = (
      current: string | null,
      candidate: unknown,
    ): string | null => {
      const value = typeof candidate === "string" ? candidate : "";
      return value && (!current || value > current) ? value : current;
    };
    const number = (value: unknown): number =>
      Number.isFinite(Number(value)) ? Number(value) : 0;
    const record = (value: unknown): Record<string, any> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, any>)
        : {};
    const applyData = (data: Record<string, any>, recent: boolean): void => {
      if (data.activity_truncated === true) truncated = true;
      const meshId = String(data.mesh_id ?? "");
      if (!unique.includes(meshId)) return;
      const mesh =
        meshes.get(meshId) ??
        ({
          meshId,
          postCount: 0,
          rootCount: 0,
          replyCount: 0,
          recentPostCount: 0,
          lastActivityAt: null,
        } satisfies MutableMesh);
      const postCount = number(data.post_count);
      if (recent) mesh.recentPostCount += postCount;
      else {
        mesh.postCount += postCount;
        mesh.rootCount += number(data.root_count);
        mesh.replyCount += number(data.reply_count);
      }
      mesh.lastActivityAt = maxTimestamp(
        mesh.lastActivityAt,
        data.last_activity_at,
      );
      meshes.set(meshId, mesh);
      for (const [topicId, raw] of Object.entries(record(data.topics))) {
        const value = record(raw);
        const key = `${meshId}:${topicId}`;
        const topic =
          topics.get(key) ??
          ({
            topicId,
            meshId,
            postCount: 0,
            rootCount: 0,
            replyCount: 0,
            recentPostCount: 0,
            participantAgentIds: new Set<string>(),
            lastActivityAt: null,
          } satisfies MutableTopic);
        if (recent) topic.recentPostCount += number(value.post_count);
        else {
          topic.postCount += number(value.post_count);
          topic.rootCount += number(value.root_count);
          topic.replyCount += number(value.reply_count);
        }
        topic.lastActivityAt = maxTimestamp(
          topic.lastActivityAt,
          value.last_activity_at,
        );
        for (const [agentId, present] of Object.entries(
          record(value.participants),
        )) {
          if (present === true) topic.participantAgentIds.add(agentId);
        }
        topics.set(key, topic);
      }
      for (const [agentId, raw] of Object.entries(record(data.agents))) {
        const value = record(raw);
        const key = `${meshId}:${agentId}`;
        const agent =
          agents.get(key) ??
          ({
            agentId,
            meshId,
            postCount: 0,
            lastPostAt: null,
          } satisfies MutableAgent);
        if (!recent) agent.postCount += number(value.post_count);
        agent.lastPostAt = maxTimestamp(agent.lastPostAt, value.last_post_at);
        agents.set(key, agent);
      }
      for (const [linkId, raw] of Object.entries(record(data.links))) {
        const value = record(raw);
        const sourceAgentId = String(
          value.source_agent_id ?? linkId.split(">", 1)[0] ?? "",
        );
        const targetAgentId = String(
          value.target_agent_id ?? linkId.split(">")[1] ?? "",
        );
        if (!sourceAgentId || !targetAgentId) continue;
        const key = `${meshId}:${sourceAgentId}:${targetAgentId}`;
        const link =
          links.get(key) ??
          ({
            meshId,
            sourceAgentId,
            targetAgentId,
            topicIds: new Set<string>(),
            eventCount: 0,
            recentEventCount: 0,
            delaySumMs: 0,
            delayCount: 0,
            delayBuckets: [],
            lastEventAt: "",
          } satisfies MutableLink);
        const count = number(value.event_count);
        if (recent) link.recentEventCount += count;
        else {
          link.eventCount += count;
          link.delaySumMs += number(value.delay_sum_ms);
          link.delayCount += number(value.delay_count);
          const buckets = Array.isArray(value.delay_buckets)
            ? value.delay_buckets
            : [];
          for (let index = 0; index < buckets.length; index += 1) {
            link.delayBuckets[index] =
              (link.delayBuckets[index] ?? 0) + number(buckets[index]);
          }
        }
        for (const [topicId, present] of Object.entries(
          record(value.topic_ids),
        )) {
          if (present === true) link.topicIds.add(topicId);
        }
        link.lastEventAt =
          maxTimestamp(link.lastEventAt || null, value.last_event_at) ??
          link.lastEventAt;
        links.set(key, link);
      }
    };
    const apply = (document: DocumentSnapshot, recent: boolean): void => {
      applyData((document.data() ?? {}) as Record<string, any>, recent);
    };
    const applySnapshot = (document: DocumentSnapshot): void => {
      const data = (document.data() ?? {}) as Record<string, any>;
      if (data.activity_truncated === true) truncated = true;
      const meshId = String(data.mesh_id ?? document.id);
      if (!unique.includes(meshId)) return;
      const totals = record(data.totals);
      const recent = record(data.recent);
      if (Object.keys(totals).length)
        applyData({ ...totals, mesh_id: meshId }, false);
      if (Object.keys(recent).length)
        applyData({ ...recent, mesh_id: meshId }, true);
    };
    freshSnapshotDocs.forEach((document) => applySnapshot(document));
    totalDocs.forEach((document) => apply(document, false));
    recentDocs.forEach((document) => apply(document, true));
    bucketDocs.forEach((document) => apply(document, true));
    const projection: RepositoryActivityProjection = {
      ...(truncated ? { truncated: true } : {}),
      meshes: [...meshes.values()].map((mesh) => ({ ...mesh })),
      topics: [...topics.values()].map((topic) => ({
        ...topic,
        participantAgentIds: [...topic.participantAgentIds].sort(),
      })),
      agents: [...agents.values()],
      links: [...links.values()].map((link) => ({
        ...link,
        topicIds: [...link.topicIds].sort(),
      })),
    };
    // Aggregate topology is safe to share across viewers with the same
    // authorized mesh set. Keep the window below the two-second propagation
    // target while collapsing the 15-second browser poll fan-out.
    this.activityProjectionCache.set(cacheKey, {
      expiresAt: Date.now() + 1_000,
      projection,
    });
    return projection;
  }

  /**
   * Build a bounded metadata-plus-aggregate projection for the browser's hot
   * activity poll. This deliberately avoids the general projection's post,
   * follow, and all-role queries.
   */
  private async loadDirectoryActivityProjection(input: {
    accountId?: string;
    requestedMeshIds?: string[];
    now: string;
  }): Promise<RepositoryProjection> {
    const directoryAccountId = input.accountId ?? "";
    const entries = input.requestedMeshIds
      ? (
          await Promise.all(
            input.requestedMeshIds.map((meshId) =>
              this.findMeshDirectoryEntryForAccount(meshId, directoryAccountId),
            ),
          )
        ).filter(
          (entry): entry is RepositoryMeshDirectoryEntry => entry !== null,
        )
      : await this.listMeshDirectoryForAccount(directoryAccountId);
    const visibleEntries = input.accountId
      ? entries
      : entries.filter((entry) => entry.mesh.visibility === "public");
    const meshIds = visibleEntries.map((entry) => entry.mesh.meshId);
    const discoveredAgentIds = [
      ...new Set(visibleEntries.flatMap((entry) => entry.memberAgentIds)),
    ].filter(Boolean);
    // The activity surface is a bounded preview, not an exhaustive directory.
    // Reuse the mesh-detail cap so an oversized roster cannot multiply point
    // reads on every poll.
    const activityAgentLimit = MAX_MESH_DETAIL_MEMBER_ROWS;
    const requestedAgentIds = discoveredAgentIds.slice(0, activityAgentLimit);
    const agentDocs: DocumentSnapshot[] = [];
    for (let index = 0; index < requestedAgentIds.length; index += 100) {
      agentDocs.push(
        ...(await this.firestore.getAll(
          ...requestedAgentIds
            .slice(index, index + 100)
            .map((agentId) => this.doc("agents", agentId)),
        )),
      );
    }
    const agents = agentDocs
      .filter((document) => document.exists)
      .map((document) => this.agentFromSnapshot(document));
    const accounts = new Map<string, RepositoryAccount>();
    for (const role of visibleEntries.flatMap((entry) => entry.roles)) {
      if (accounts.has(role.accountId)) continue;
      accounts.set(role.accountId, {
        accountId: role.accountId,
        email: role.email,
        displayName: role.displayName,
        createdAt: role.createdAt,
      });
    }
    const requiredAccountIds = [
      ...new Set([
        ...(input.accountId ? [input.accountId] : []),
        ...agents.map((agent) => agent.ownerAccountId),
      ]),
    ].filter((accountId) => !accounts.has(accountId));
    for (let index = 0; index < requiredAccountIds.length; index += 100) {
      const documents = await this.firestore.getAll(
        ...requiredAccountIds
          .slice(index, index + 100)
          .map((accountId) => this.doc("accounts", accountId)),
      );
      for (const document of documents) {
        if (!document.exists) continue;
        accounts.set(document.id, {
          accountId: document.id,
          email: String(document.get("email") ?? ""),
          displayName: String(document.get("display_name") ?? ""),
          createdAt: String(document.get("created_at") ?? input.now),
        });
      }
    }
    const agentIdSet = new Set(agents.map((agent) => agent.agentId));
    const runtimeSessions = await this.listRuntimeSessionsForAgents(
      [...agentIdSet],
      input.now,
      new Date(Date.parse(input.now) - 90_000).toISOString(),
    );
    const activity = (await this.loadActivityProjection(
      meshIds,
      input.now,
    )) ?? {
      meshes: [],
      topics: [],
      agents: [],
      links: [],
    };
    const truncated =
      visibleEntries.some((entry) => entry.truncated) ||
      discoveredAgentIds.length > activityAgentLimit ||
      activity.truncated === true;
    return {
      accounts: [...accounts.values()],
      agents,
      meshes: visibleEntries.map((entry) => entry.mesh),
      topics: visibleEntries.flatMap((entry) =>
        entry.topics.map(({ topic }) => topic),
      ),
      humanRoles: input.accountId
        ? visibleEntries.flatMap((entry) =>
            entry.roles.map((role) => ({
              meshId: entry.mesh.meshId,
              accountId: role.accountId,
              role: role.role,
              createdAt: role.createdAt,
              updatedAt: role.updatedAt,
            })),
          )
        : [],
      memberships: visibleEntries.flatMap((entry) =>
        entry.memberAgentIds
          .filter((agentId) => agentIdSet.has(agentId))
          .map((agentId) => ({
            meshId: entry.mesh.meshId,
            agentId,
            status: "joined" as const,
            attentionPolicy: {},
            admissionProvenance: "open" as const,
            joinedAt: null,
            updatedAt: entry.mesh.updatedAt,
          })),
      ),
      runtimeSessions,
      posts: [],
      follows: [],
      activity: truncated ? { ...activity, truncated: true } : activity,
      publicMeshesTruncated: truncated,
    };
  }

  private eventEnvelope(input: RepositoryEventInput): Record<string, unknown> {
    const rawPayload =
      input.payload &&
      typeof input.payload === "object" &&
      !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : { value: input.payload };
    // Raw delivery/topology traces must not become a second long-lived copy of
    // a post body. Keep attribution and moderation metadata, but strip body
    // text before it enters Firestore event collections.
    const payload = { ...rawPayload };
    const post = payload.post;
    if (post && typeof post === "object" && !Array.isArray(post)) {
      const { body: _body, ...postReference } = post as Record<string, unknown>;
      payload.post = postReference;
    }
    return {
      event_id: input.eventId,
      schema_version: 1 as const,
      mesh_id: input.meshId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      runtime_kind:
        input.runtimeKind == null ? null : publicRuntimeKind(input.runtimeKind),
      type: input.type,
      occurred_at: input.occurredAt,
      payload,
    };
  }

  private eventOutboxDocument(
    input: RepositoryEventInput,
  ): Record<string, unknown> {
    return {
      contract_version: MESHR_CONTRACT_MAJOR,
      envelope: this.eventEnvelope(input),
      // Keep the ordering key denormalized at the document root so the
      // publisher can serialize a mesh without opening every envelope.
      mesh_id: input.meshId,
      // Visibility itself remains authoritative and is revalidated at read
      // time. The stable selector keeps private traffic out of the public
      // candidate stream; production launches with typed scopes only.
      observation_scope:
        input.observationScope ?? (input.meshId == null ? "system" : "private"),
      event_id: input.eventId,
      status: "pending",
      attempts: 0,
      created_at: input.occurredAt,
      // Do not attach a TTL while delivery is pending. The ingest publisher
      // adds retention_at only after Pub/Sub acknowledges the event so an
      // outage cannot delete an accepted write before it is delivered.
    };
  }

  private queueOutboxReady(
    transaction: any,
    eventId: string,
    meshId: string | null | undefined,
    occurredAt: string,
  ): void {
    // One immutable ready marker per event avoids a hot per-mesh document on
    // the social-write path. The ingest publisher groups these markers by
    // ordering key and still serializes the authoritative outbox query.
    const orderingKey = meshId ?? "system";
    transaction.set(
      this.doc("event_outbox_ready", eventId),
      {
        contract_version: MESHR_CONTRACT_MAJOR,
        event_id: eventId,
        mesh_id: meshId ?? null,
        ordering_key: orderingKey,
        ready_shard: outboxReadyShard(eventId),
        status: "pending",
        next_attempt_at: occurredAt,
        created_at: occurredAt,
        updated_at: occurredAt,
      },
      { merge: true },
    );
  }

  private auditDocument(input: RepositoryAuditInput): Record<string, unknown> {
    return {
      contract_version: MESHR_CONTRACT_MAJOR,
      audit_id: input.auditId,
      actor_type: input.actorType,
      actor_id: input.actorId,
      session_id: input.sessionId,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      data: input.data,
      created_at: input.createdAt,
      retention_at: auditRetentionTimestamp(input.createdAt),
    };
  }

  /**
   * Persist immutable command records inside the caller's transaction.  The
   * outbox and audit collections are intentionally written after all reads
   * have been performed so a governance state change can never commit without
   * its trace.  Event IDs are allocated by the command boundary and therefore
   * remain stable if Firestore retries the transaction callback.
   */
  private writeMutationArtifacts(
    transaction: any,
    artifacts: RepositoryMutationArtifacts,
  ): void {
    if (artifacts.event) {
      transaction.create(
        this.doc("event_outbox", artifacts.event.eventId),
        this.eventOutboxDocument(artifacts.event),
      );
      this.queueOutboxReady(
        transaction,
        artifacts.event.eventId,
        artifacts.event.meshId,
        artifacts.event.occurredAt,
      );
    }
    if (artifacts.audit) {
      transaction.create(
        this.doc("audit_events", artifacts.audit.auditId),
        this.auditDocument(artifacts.audit),
      );
    }
  }

  private pairingFromSnapshot(
    snapshot: DocumentSnapshot,
  ): RepositoryPairingInput {
    const requestedProfile = snapshot.get("requested_profile");
    return {
      pairingId: String(snapshot.get("pairing_id") ?? snapshot.id),
      code: String(snapshot.get("code")),
      secretHash: String(snapshot.get("secret_hash")),
      runtime: String(snapshot.get("runtime") ?? "other") as RuntimeKind,
      runtimeLabel: String(snapshot.get("runtime_label") ?? ""),
      externalSubject: String(snapshot.get("external_subject") ?? ""),
      publicKeyPem: String(snapshot.get("public_key_pem") ?? ""),
      requestedProfile:
        requestedProfile && typeof requestedProfile === "object"
          ? (requestedProfile as Record<string, unknown>)
          : null,
      definitionDigest:
        snapshot.get("definition_digest") == null
          ? null
          : String(snapshot.get("definition_digest")),
      status: String(
        snapshot.get("status"),
      ) as RepositoryPairingInput["status"],
      ownerAccountId:
        snapshot.get("owner_account_id") == null
          ? null
          : String(snapshot.get("owner_account_id")),
      agentId:
        snapshot.get("agent_id") == null
          ? null
          : String(snapshot.get("agent_id")),
      createdAt: String(snapshot.get("created_at")),
      expiresAt: String(snapshot.get("expires_at")),
      approvedAt:
        snapshot.get("approved_at") == null
          ? null
          : String(snapshot.get("approved_at")),
      claimedAt:
        snapshot.get("claimed_at") == null
          ? null
          : String(snapshot.get("claimed_at")),
    };
  }

  async createPairing(input: RepositoryPairingInput): Promise<void> {
    await this.doc("pairings", input.pairingId).create({
      contract_version: MESHR_CONTRACT_MAJOR,
      pairing_id: input.pairingId,
      code: input.code,
      secret_hash: input.secretHash,
      runtime: input.runtime,
      runtime_label: input.runtimeLabel,
      external_subject: input.externalSubject,
      public_key_pem: input.publicKeyPem,
      requested_profile: input.requestedProfile,
      definition_digest: input.definitionDigest,
      status: input.status,
      owner_account_id: input.ownerAccountId,
      agent_id: input.agentId,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      approved_at: input.approvedAt,
      claimed_at: input.claimedAt,
      // Only pending pairings receive this TTL marker. Approved/claimed
      // bindings can outlive the short pairing-code window for renewals.
      pending_expires_at_ttl:
        input.status === "pending" ? ttlTimestamp(input.expiresAt) : null,
    });
  }

  async approvePairing(input: {
    pairingId: string;
    ownerAccountId: string;
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
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
  }): Promise<{ agentId: string; replaced: boolean }> {
    const pairingRef = this.doc("pairings", input.pairingId);
    const handleKey = input.profile.handle
      .trim()
      .normalize("NFKC")
      .toLowerCase();
    const handleRef = this.doc("agent_handles", handleKey);
    const meshRef = this.doc("meshes", "mesh-public");
    const humanSessionRef = this.doc("human_sessions", input.humanSessionHash);
    return this.firestore.runTransaction(async (transaction) => {
      const [pairing, handle, mesh, humanSession] = await Promise.all([
        transaction.get(pairingRef),
        transaction.get(handleRef),
        transaction.get(meshRef),
        transaction.get(humanSessionRef),
      ]);
      const approvedAtMs = Date.parse(input.approvedAt);
      const lastSeenAt = humanSession.exists
        ? Date.parse(String(humanSession.get("last_seen_at") ?? ""))
        : NaN;
      const expiresAt = humanSession.exists
        ? Date.parse(String(humanSession.get("expires_at") ?? ""))
        : NaN;
      const absoluteExpiresAt = humanSession.exists
        ? Date.parse(String(humanSession.get("absolute_expires_at") ?? ""))
        : NaN;
      if (
        !humanSession.exists ||
        humanSession.get("account_id") !== input.ownerAccountId ||
        !Number.isFinite(approvedAtMs) ||
        !Number.isFinite(lastSeenAt) ||
        !Number.isFinite(expiresAt) ||
        !Number.isFinite(absoluteExpiresAt) ||
        expiresAt <= approvedAtMs ||
        absoluteExpiresAt <= approvedAtMs ||
        lastSeenAt <= approvedAtMs - HUMAN_IDLE_SECONDS * 1_000
      ) {
        throw new Error("pairing_authorization_denied");
      }
      if (!pairing.exists || pairing.get("status") !== "pending") {
        throw new Error("pairing_not_pending");
      }
      if (
        Date.parse(String(pairing.get("expires_at"))) <=
        Date.parse(input.approvedAt)
      ) {
        throw new Error("pairing_not_pending");
      }
      if (!mesh.exists) throw new Error("mesh_not_found");
      const handleAgentId = handle.exists
        ? String(handle.get("agent_id"))
        : null;
      const selectedAgentId = handleAgentId ?? input.agentId;
      const agentRef = this.doc("agents", selectedAgentId);
      const bindingRef = this.doc("agent_bindings", input.pairingId);
      const publicMembershipRef = this.doc(
        "mesh_agent_memberships",
        "mesh-public:" + selectedAgentId,
      );
      const [agent, publicMembership] = await Promise.all([
        transaction.get(agentRef),
        transaction.get(publicMembershipRef),
      ]);
      if (
        agent.exists &&
        String(agent.get("owner_account_id")) !== input.ownerAccountId
      ) {
        throw new Error("handle_unavailable");
      }
      const reusedIdentity = agent.exists;
      if (!agent.exists) {
        const ownedAgents = await transaction.get(
          this.firestore
            .collection(this.collection("agents"))
            .where("owner_account_id", "==", input.ownerAccountId)
            .limit(26),
        );
        if (ownedAgents.size >= 25) throw new Error("agent_limit_reached");
      }
      const priorPairings = reusedIdentity
        ? await transaction.get(
            this.firestore
              .collection(this.collection("pairings"))
              .where("agent_id", "==", selectedAgentId)
              .where("status", "in", ["approved", "claimed"])
              .limit(2),
          )
        : undefined;
      const priorBindings = reusedIdentity
        ? await transaction.get(
            this.firestore
              .collection(this.collection("agent_bindings"))
              .where("agent_id", "==", selectedAgentId)
              .where("revoked_at", "==", null)
              .limit(2),
          )
        : undefined;
      const activeSessions = reusedIdentity
        ? await transaction.get(
            this.firestore
              .collection(this.collection("runtime_sessions"))
              .where("agent_id", "==", selectedAgentId)
              .where("status", "==", "active")
              .limit(2),
          )
        : undefined;
      const activeGrants = reusedIdentity
        ? await transaction.get(
            this.firestore
              .collection(this.collection("webmcp_grants"))
              .where("agent_id", "==", selectedAgentId)
              .where("revoked_at", "==", null)
              .limit(2),
          )
        : undefined;
      if (
        (priorPairings?.size ?? 0) > 1 ||
        (priorBindings?.size ?? 0) > 1 ||
        (activeSessions?.size ?? 0) > 1 ||
        (activeGrants?.size ?? 0) > 1
      ) {
        throw new Error("agent_authority_corrupt");
      }
      const replacedBinding = (priorBindings?.size ?? 0) > 0;
      if (priorPairings) {
        for (const prior of priorPairings.docs) {
          if (prior.id !== input.pairingId)
            transaction.update(prior.ref, {
              status: "revoked",
              revoked_at: input.approvedAt,
              pending_expires_at_ttl: ttlTimestamp(
                String(prior.get("expires_at") ?? input.approvedAt),
              ),
            });
        }
      }
      if (priorBindings) {
        for (const prior of priorBindings.docs) {
          if (prior.id !== input.pairingId) {
            transaction.update(prior.ref, {
              revoked_at: input.approvedAt,
              updated_at: input.approvedAt,
              revoked_at_ttl: retentionTimestamp(
                input.approvedAt,
                REVOKED_BINDING_RETENTION_SECONDS,
              ),
            });
          }
        }
      }
      if (activeSessions) {
        for (const session of activeSessions.docs) {
          transaction.update(session.ref, {
            status: "superseded",
            superseding_session_id: input.pairingId,
            expires_at: input.approvedAt,
            inactive_expires_at_ttl: ttlTimestamp(input.approvedAt),
          });
        }
      }
      if (activeGrants) {
        for (const grant of activeGrants.docs) {
          const expiresAt = String(grant.get("expires_at") ?? input.approvedAt);
          transaction.update(grant.ref, {
            revoked_at: input.approvedAt,
            expires_at_ttl: ttlTimestamp(expiresAt),
          });
        }
      }
      // Rebinding an existing identity revokes native/page authority without a
      // mesh.* event. Wake live gateways in the same transaction so sockets
      // cannot continue using a cached grant until their heartbeat.
      if (
        (activeSessions?.size ?? 0) > 0 ||
        (activeGrants?.size ?? 0) > 0 ||
        (priorBindings?.size ?? 0) > 0
      ) {
        this.touchLiveAccessEpoch(
          transaction,
          input.approvedAt,
          "agent_binding_replaced",
          selectedAgentId,
        );
      }
      transaction.set(
        agentRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          agent_id: selectedAgentId,
          owner_account_id: input.ownerAccountId,
          name: input.profile.name,
          handle: input.profile.handle,
          tagline: input.profile.tagline,
          interests: input.profile.interests,
          personality: input.profile.personality,
          attention_policy: input.profile.attention,
          runtime: pairing.get("runtime") ?? "other",
          runtime_label: pairing.get("runtime_label") ?? "",
          runtime_subject: pairing.get("external_subject") ?? "",
          public_key_pem: pairing.get("public_key_pem") ?? "",
          definition_digest: pairing.get("definition_digest") ?? null,
          created_at: agent.exists ? agent.get("created_at") : input.approvedAt,
          updated_at: input.approvedAt,
        },
        { merge: true },
      );
      transaction.set(
        handleRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          handle: input.profile.handle,
          agent_id: selectedAgentId,
          updated_at: input.approvedAt,
        },
        { merge: true },
      );
      transaction.set(
        bindingRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          binding_id: input.pairingId,
          agent_id: selectedAgentId,
          public_key: pairing.get("public_key_pem") ?? "",
          runtime_kind: pairing.get("runtime") ?? "other",
          approved_at: input.approvedAt,
          revoked_at: null,
          revoked_at_ttl: null,
          updated_at: input.approvedAt,
        },
        { merge: true },
      );
      transaction.update(pairingRef, {
        status: "approved",
        owner_account_id: input.ownerAccountId,
        agent_id: selectedAgentId,
        approved_at: input.approvedAt,
        pending_expires_at_ttl: null,
      });
      transaction.set(
        publicMembershipRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          mesh_id: "mesh-public",
          agent_id: selectedAgentId,
          status: "joined",
          attention_policy: input.profile.attention,
          admission_provenance: "open",
          joined_at:
            publicMembership.exists &&
            publicMembership.get("status") === "joined" &&
            publicMembership.get("joined_at") != null
              ? publicMembership.get("joined_at")
              : input.approvedAt,
          updated_at: input.approvedAt,
        },
        { merge: true },
      );
      // The durable transaction may resolve a normalized handle to a
      // different canonical agent than the local projection suggested. Never
      // let caller-supplied audit/outbox attribution name that stale ID.
      const event = input.event
        ? {
            ...input.event,
            agentId: selectedAgentId,
            payload: {
              ...(input.event.payload && typeof input.event.payload === "object"
                ? (input.event.payload as Record<string, unknown>)
                : {}),
              agentId: selectedAgentId,
              bindingId: input.pairingId,
              reusedIdentity,
              replacedBinding,
            },
          }
        : undefined;
      const audit = input.audit
        ? {
            ...input.audit,
            data: {
              ...(input.audit.data && typeof input.audit.data === "object"
                ? (input.audit.data as Record<string, unknown>)
                : {}),
              agentId: selectedAgentId,
              reusedIdentity,
              replacedBinding,
            },
          }
        : undefined;
      this.writeMutationArtifacts(transaction, { event, audit });
      return { agentId: selectedAgentId, replaced: replacedBinding };
    });
  }

  async updatePairing(
    pairingId: string,
    patch: Partial<RepositoryPairingInput>,
  ): Promise<void> {
    const update: Record<string, unknown> = {};
    if (patch.code !== undefined) update.code = patch.code;
    if (patch.secretHash !== undefined) update.secret_hash = patch.secretHash;
    if (patch.runtime !== undefined) update.runtime = patch.runtime;
    if (patch.runtimeLabel !== undefined)
      update.runtime_label = patch.runtimeLabel;
    if (patch.externalSubject !== undefined)
      update.external_subject = patch.externalSubject;
    if (patch.publicKeyPem !== undefined)
      update.public_key_pem = patch.publicKeyPem;
    if (patch.requestedProfile !== undefined)
      update.requested_profile = patch.requestedProfile;
    if (patch.definitionDigest !== undefined)
      update.definition_digest = patch.definitionDigest;
    if (patch.status !== undefined) {
      update.status = patch.status;
      update.pending_expires_at_ttl =
        patch.status === "pending" ||
        patch.status === "expired" ||
        patch.status === "revoked"
          ? ttlTimestamp(patch.expiresAt ?? this.now())
          : null;
    }
    if (patch.ownerAccountId !== undefined)
      update.owner_account_id = patch.ownerAccountId;
    if (patch.agentId !== undefined) update.agent_id = patch.agentId;
    if (patch.expiresAt !== undefined) {
      update.expires_at = patch.expiresAt;
      if (patch.status === undefined) {
        update.pending_expires_at_ttl = ttlTimestamp(patch.expiresAt);
      }
    }
    if (patch.approvedAt !== undefined) update.approved_at = patch.approvedAt;
    if (patch.claimedAt !== undefined) update.claimed_at = patch.claimedAt;
    update.updated_at = this.now();
    await this.doc("pairings", pairingId).set(
      {
        contract_version: MESHR_CONTRACT_MAJOR,
        pairing_id: pairingId,
        ...update,
      },
      { merge: true },
    );
  }

  async expirePairingIfPending(
    pairingId: string,
    expiredAt: string,
  ): Promise<RepositoryPairingInput | null> {
    const expiredAtMs = Date.parse(expiredAt);
    if (!Number.isFinite(expiredAtMs)) throw new Error("invalid_expiry_time");
    const pairingRef = this.doc("pairings", pairingId);
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(pairingRef);
      if (!snapshot.exists) return null;
      const current = this.pairingFromSnapshot(snapshot);
      if (
        current.status !== "pending" ||
        !Number.isFinite(Date.parse(current.expiresAt)) ||
        Date.parse(current.expiresAt) > expiredAtMs
      ) {
        return current;
      }
      transaction.update(pairingRef, {
        status: "expired",
        // Keep the original short-lived credential deadline as the native
        // TTL and bounded-sweeper marker. Only approved/claimed bindings clear
        // this field because they are required for runtime renewal.
        pending_expires_at_ttl: ttlTimestamp(current.expiresAt),
        updated_at: expiredAt,
      });
      return { ...current, status: "expired" };
    });
  }

  async findPairing(pairingId: string): Promise<RepositoryPairingInput | null> {
    const snapshot = await this.doc("pairings", pairingId).get();
    return snapshot.exists ? this.pairingFromSnapshot(snapshot) : null;
  }

  async findPairingByCode(
    code: string,
  ): Promise<RepositoryPairingInput | null> {
    const snapshot = await this.firestore
      .collection(this.collection("pairings"))
      .where("code", "==", code)
      .limit(1)
      .get();
    const document = snapshot.docs[0];
    return document ? this.pairingFromSnapshot(document) : null;
  }

  async createPairingChallenge(
    input: RepositoryPairingChallenge,
  ): Promise<void> {
    await this.doc("pairing_challenges", input.challengeId).create({
      contract_version: MESHR_CONTRACT_MAJOR,
      challenge_id: input.challengeId,
      pairing_id: input.pairingId,
      message: input.message,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      used_at: input.usedAt,
      expires_at_ttl: ttlTimestamp(input.expiresAt),
    });
  }

  async findPairingChallenge(
    challengeId: string,
    pairingId: string,
  ): Promise<RepositoryPairingChallenge | null> {
    const snapshot = await this.doc("pairing_challenges", challengeId).get();
    if (!snapshot.exists || snapshot.get("pairing_id") !== pairingId)
      return null;
    return {
      challengeId,
      pairingId,
      message: String(snapshot.get("message")),
      createdAt: String(snapshot.get("created_at")),
      expiresAt: String(snapshot.get("expires_at")),
      usedAt:
        snapshot.get("used_at") == null
          ? null
          : String(snapshot.get("used_at")),
    };
  }

  async consumePairingChallenge(
    challengeId: string,
    pairingId: string,
    usedAt: string,
  ): Promise<RepositoryPairingChallenge | null> {
    return this.firestore.runTransaction(async (transaction) => {
      const ref = this.doc("pairing_challenges", challengeId);
      const snapshot = await transaction.get(ref);
      if (
        !snapshot.exists ||
        snapshot.get("pairing_id") !== pairingId ||
        snapshot.get("used_at") != null ||
        Date.parse(String(snapshot.get("expires_at"))) <= Date.parse(usedAt)
      ) {
        return null;
      }
      transaction.update(ref, { used_at: usedAt });
      return {
        challengeId,
        pairingId,
        message: String(snapshot.get("message")),
        createdAt: String(snapshot.get("created_at")),
        expiresAt: String(snapshot.get("expires_at")),
        usedAt,
      };
    });
  }

  async upsertAgent(
    input: RepositoryAgentInput,
  ): Promise<{ changed: boolean; updatedAt: string }> {
    const agentRef = this.doc("agents", input.agentId);
    const handleKey = input.handle.trim().normalize("NFKC").toLowerCase();
    const handleRef = this.doc("agent_handles", handleKey);
    const inputBindingRef = input.bindingId
      ? this.doc("agent_bindings", input.bindingId)
      : undefined;
    return this.firestore.runTransaction(async (transaction) => {
      const [agent, handle, bindings, inputBinding] = await Promise.all([
        transaction.get(agentRef),
        transaction.get(handleRef),
        input.bindingId
          ? Promise.resolve({ docs: [] as DocumentSnapshot[] })
          : transaction.get(
              this.firestore
                .collection(this.collection("agent_bindings"))
                .where("agent_id", "==", input.agentId)
                .where("revoked_at", "==", null)
                .limit(2),
            ),
        inputBindingRef
          ? transaction.get(inputBindingRef)
          : Promise.resolve(undefined),
      ]);
      // Owner profile edits do not carry a runtime binding. Preserve the
      // approved binding instead of silently creating an agent-id binding
      // that would orphan the actual pairing key. Active runtime syncs pass
      // their binding explicitly through the authenticated session.
      if (bindings.docs.length > 1) throw new Error("agent_authority_corrupt");
      const existingBinding = bindings.docs[0];
      if (input.actingAccountId || input.humanSessionHash) {
        await this.assertHumanSession(
          transaction,
          input.actingAccountId,
          input.humanSessionHash,
          input.updatedAt,
        );
        if (input.actingAccountId !== input.ownerAccountId) {
          throw new Error("mesh_governance_denied");
        }
        if (
          agent.exists &&
          agent.get("owner_account_id") !== input.ownerAccountId
        ) {
          throw new Error("agent_access_denied");
        }
      }
      const bindingId =
        input.bindingId ??
        existingBinding?.id ??
        (!agent.exists ? input.agentId : undefined);
      if (!agent.exists) {
        // The API performs an early limit check for friendly errors, but the
        // authoritative transaction must enforce it as well so concurrent
        // approvals cannot create more than the launch allowance.
        const ownedAgents = await transaction.get(
          this.firestore
            .collection(this.collection("agents"))
            .where("owner_account_id", "==", input.ownerAccountId)
            .limit(26),
        );
        if (ownedAgents.size >= 25) throw new Error("agent_limit_reached");
      }
      if (handle.exists && String(handle.get("agent_id")) !== input.agentId) {
        throw new Error("handle_unavailable");
      }
      const previousHandle = agent.exists
        ? String(agent.get("handle") ?? "")
        : "";
      const previousHandleKey = previousHandle
        .trim()
        .normalize("NFKC")
        .toLowerCase();
      const previousHandleRef =
        previousHandleKey && previousHandleKey !== handleKey
          ? this.doc("agent_handles", previousHandleKey)
          : undefined;
      if (previousHandleRef) {
        const previous = await transaction.get(previousHandleRef);
        if (
          previous.exists &&
          String(previous.get("agent_id")) === input.agentId
        ) {
          transaction.delete(previousHandleRef);
        }
      }
      const currentUpdatedAt = agent.exists
        ? String(agent.get("updated_at") ?? "")
        : "";
      const attentionChanged =
        agent.exists &&
        JSON.stringify(agent.get("attention_policy") ?? {}) !==
          JSON.stringify(input.attention);
      if (
        input.expectedUpdatedAt !== undefined &&
        currentUpdatedAt !== input.expectedUpdatedAt
      ) {
        throw new Error("profile_conflict");
      }
      const exactOwnerNoop =
        Boolean(input.actingAccountId) &&
        !input.profileReviewProposal &&
        agent.exists &&
        handle.exists &&
        String(handle.get("agent_id")) === input.agentId &&
        String(agent.get("agent_id") ?? agent.id) === input.agentId &&
        String(agent.get("owner_account_id") ?? "") === input.ownerAccountId &&
        String(agent.get("name") ?? "") === input.name &&
        String(agent.get("handle") ?? "") === input.handle &&
        String(agent.get("tagline") ?? "") === input.tagline &&
        isDeepStrictEqual(agent.get("interests") ?? [], input.interests) &&
        String(agent.get("personality") ?? "") === input.personality &&
        isDeepStrictEqual(
          agent.get("attention_policy") ?? {},
          input.attention,
        ) &&
        String(agent.get("runtime") ?? "other") === input.runtime &&
        String(agent.get("runtime_label") ?? "") === input.runtimeLabel &&
        String(agent.get("runtime_subject") ?? "") === input.runtimeSubject &&
        String(agent.get("public_key_pem") ?? "") === input.publicKeyPem &&
        (agent.get("definition_digest") == null
          ? null
          : String(agent.get("definition_digest"))) ===
          input.definitionDigest &&
        String(agent.get("created_at") ?? "") === input.createdAt;
      if (exactOwnerNoop) {
        return { changed: false, updatedAt: currentUpdatedAt };
      }
      const currentUpdatedMs = Date.parse(currentUpdatedAt);
      const requestedUpdatedMs = Date.parse(input.updatedAt);
      const effectiveUpdatedAt =
        agent.exists &&
        Number.isFinite(currentUpdatedMs) &&
        (!Number.isFinite(requestedUpdatedMs) ||
          requestedUpdatedMs <= currentUpdatedMs)
          ? new Date(currentUpdatedMs + 1).toISOString()
          : input.updatedAt;
      if (attentionChanged) {
        this.touchLiveAccessEpoch(
          transaction,
          effectiveUpdatedAt,
          "agent_attention_policy_changed",
          input.agentId,
        );
      }
      transaction.set(
        agentRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          agent_id: input.agentId,
          owner_account_id: input.ownerAccountId,
          name: input.name,
          handle: input.handle,
          tagline: input.tagline,
          interests: input.interests,
          personality: input.personality,
          attention_policy: input.attention,
          runtime: input.runtime,
          runtime_label: input.runtimeLabel,
          runtime_subject: input.runtimeSubject,
          public_key_pem: input.publicKeyPem,
          definition_digest: input.definitionDigest,
          created_at: input.createdAt,
          updated_at: effectiveUpdatedAt,
        },
        { merge: true },
      );
      transaction.set(
        handleRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          handle: input.handle,
          agent_id: input.agentId,
          updated_at: effectiveUpdatedAt,
        },
        { merge: true },
      );
      if (bindingId) {
        // A profile edit must never revive a revoked binding. Runtime syncs
        // pass the currently authenticated binding; owner edits preserve an
        // existing active binding and create one only for a brand-new agent.
        const bindingRef = this.doc("agent_bindings", bindingId);
        const binding = input.bindingId ? inputBinding : existingBinding;
        if (!binding || !binding.exists) {
          transaction.set(
            bindingRef,
            {
              contract_version: MESHR_CONTRACT_MAJOR,
              binding_id: bindingId,
              agent_id: input.agentId,
              public_key: input.publicKeyPem,
              runtime_kind: input.runtime,
              approved_at: input.createdAt,
              ...(binding?.exists && binding.get("revoked_at") != null
                ? { revoked_at: binding.get("revoked_at") }
                : { revoked_at: null }),
              updated_at: effectiveUpdatedAt,
            },
            { merge: true },
          );
        } else if (binding.get("revoked_at") == null) {
          // The binding key, runtime provenance, and approval timestamp are
          // immutable authority facts. A profile edit may only refresh a
          // bookkeeping timestamp on an already-approved binding.
          transaction.update(bindingRef, { updated_at: effectiveUpdatedAt });
        }
      }
      if (input.profileReviewProposal) {
        const proposal = input.profileReviewProposal;
        transaction.set(
          this.doc("profile_review_proposals", proposal.proposalId),
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            proposal_id: proposal.proposalId,
            agent_id: input.agentId,
            owner_account_id: input.ownerAccountId,
            source_digest: proposal.sourceDigest,
            requested: proposal.requested,
            pending_fields: proposal.pendingFields,
            status: "pending",
            resolution: null,
            resolved_at: null,
            created_at: proposal.createdAt,
            updated_at: effectiveUpdatedAt,
          },
          { merge: true },
        );
      }
      return { changed: true, updatedAt: effectiveUpdatedAt };
    });
  }

  async createBrowserAgentWithPageAuthority(
    input: RepositoryCreateBrowserAgentInput,
  ): Promise<RepositoryCreateBrowserAgentResult> {
    const agent = input.agent;
    this.assertBrowserAgentCompatibility(agent);
    const handleKey = agent.handle.trim().normalize("NFKC").toLowerCase();
    if (
      !agent.agentId ||
      !agent.ownerAccountId ||
      !handleKey ||
      !input.grantId ||
      !input.humanSessionHash ||
      !input.sessionId ||
      !input.idempotencyKey ||
      !input.requestHash
    ) {
      throw new Error("browser_agent_input_invalid");
    }
    const committedAgent: RepositoryAgentInput = {
      agentId: agent.agentId,
      ownerAccountId: agent.ownerAccountId,
      name: agent.name,
      handle: agent.handle,
      tagline: agent.tagline,
      interests: [...agent.interests],
      personality: agent.personality,
      attention: { ...agent.attention },
      runtime: "other",
      runtimeLabel: "Page WebMCP",
      runtimeSubject: `webmcp:${agent.agentId}`,
      publicKeyPem: "",
      definitionDigest: null,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };

    const now = this.now();
    const agentRef = this.doc("agents", agent.agentId);
    const handleRef = this.doc("agent_handles", handleKey);
    const membershipRef = this.doc(
      "mesh_agent_memberships",
      `mesh-public:${agent.agentId}`,
    );
    const meshRef = this.doc("meshes", "mesh-public");
    const authorityRef = this.authorityRef(agent.agentId);
    const fenceRef = this.webMcpAuthorityRef(input.humanSessionHash);
    const grantRef = this.doc("webmcp_grants", input.grantId);
    const idempotencyRef = this.doc(
      "idempotency",
      `${agent.ownerAccountId}:webmcp.agent.create:${input.idempotencyKey}`,
    );

    return this.firestore.runTransaction(async (transaction) => {
      const [
        humanSession,
        account,
        currentAgent,
        handle,
        membership,
        mesh,
        authority,
        fence,
        grant,
        idempotency,
        activeSessions,
        humanGrants,
        agentGrants,
        ownedAgents,
      ] = await Promise.all([
        transaction.get(
          this.doc("human_sessions", input.humanSessionHash),
        ),
        transaction.get(this.doc("accounts", agent.ownerAccountId)),
        transaction.get(agentRef),
        transaction.get(handleRef),
        transaction.get(membershipRef),
        transaction.get(meshRef),
        transaction.get(authorityRef),
        transaction.get(fenceRef),
        transaction.get(grantRef),
        transaction.get(idempotencyRef),
        transaction.get(
          this.firestore
            .collection(this.collection("runtime_sessions"))
            .where("agent_id", "==", agent.agentId)
            .where("status", "==", "active")
            .limit(2),
        ),
        transaction.get(
          this.firestore
            .collection(this.collection("webmcp_grants"))
            .where("human_session_hash", "==", input.humanSessionHash)
            .where("revoked_at", "==", null)
            .limit(2),
        ),
        transaction.get(
          this.firestore
            .collection(this.collection("webmcp_grants"))
            .where("agent_id", "==", agent.agentId)
            .where("revoked_at", "==", null)
            .limit(2),
        ),
        transaction.get(
          this.firestore
            .collection(this.collection("agents"))
            .where("owner_account_id", "==", agent.ownerAccountId)
            .limit(26),
        ),
      ]);

      const nowMs = Date.parse(now);
      const humanExpiresAt = humanSession.exists
        ? Date.parse(String(humanSession.get("expires_at") ?? ""))
        : NaN;
      const humanAbsoluteExpiresAt = humanSession.exists
        ? Date.parse(String(humanSession.get("absolute_expires_at") ?? ""))
        : NaN;
      const humanLastSeenAt = humanSession.exists
        ? Date.parse(String(humanSession.get("last_seen_at") ?? ""))
        : NaN;
      if (
        !humanSession.exists ||
        humanSession.get("account_id") !== agent.ownerAccountId ||
        !account.exists ||
        !Number.isFinite(humanExpiresAt) ||
        !Number.isFinite(humanAbsoluteExpiresAt) ||
        !Number.isFinite(humanLastSeenAt) ||
        humanExpiresAt <= nowMs ||
        humanAbsoluteExpiresAt <= nowMs ||
        humanLastSeenAt <= nowMs - HUMAN_IDLE_SECONDS * 1_000
      ) {
        throw new Error("session_invalid");
      }
      if (
        activeSessions.size > 1 ||
        humanGrants.size > 1 ||
        agentGrants.size > 1
      ) {
        throw new Error("agent_authority_corrupt");
      }

      if (idempotency.exists) {
        if (
          !constantTimeStringEqual(
            String(idempotency.get("request_hash") ?? ""),
            input.requestHash,
          )
        ) {
          throw new Error("idempotency_conflict");
        }
        const idempotencyExpiresAt = Date.parse(
          String(idempotency.get("expires_at") ?? ""),
        );
        if (
          !Number.isFinite(idempotencyExpiresAt) ||
          idempotencyExpiresAt <= nowMs
        ) {
          throw new Error("idempotency_expired");
        }
        const response = idempotency.get("response_body");
        const responseRecord =
          response && typeof response === "object" && !Array.isArray(response)
            ? (response as Record<string, unknown>)
            : {};
        const persistedGrant = grant.exists
          ? this.browserGrantFromSnapshot(grant)
          : null;
        const persistedAgent = currentAgent.exists
          ? this.agentFromSnapshot(currentAgent)
          : null;
        const entityMatches =
          this.browserAgentMatchesSnapshot(currentAgent, agent) &&
          handle.exists &&
          String(handle.get("agent_id") ?? "") === agent.agentId &&
          membership.exists &&
          membership.get("mesh_id") === "mesh-public" &&
          membership.get("agent_id") === agent.agentId &&
          membership.get("status") === "joined" &&
          isDeepStrictEqual(
            membership.get("attention_policy") ?? {},
            agent.attention,
          ) &&
          responseRecord.agent_id === agent.agentId &&
          responseRecord.grant_id === input.grantId &&
          responseRecord.session_id === input.sessionId;
        if (!entityMatches || !persistedAgent || !persistedGrant) {
          throw new Error("idempotency_conflict");
        }
        const epoch = Number(responseRecord.authority_epoch ?? -1);
        const activeGrantMatches =
          humanGrants.size === 1 &&
          humanGrants.docs[0]!.id === input.grantId &&
          agentGrants.size === 1 &&
          agentGrants.docs[0]!.id === input.grantId &&
          activeSessions.empty &&
          persistedGrant.grantId === input.grantId &&
          persistedGrant.tokenHash === input.grantId &&
          persistedGrant.humanSessionHash === input.humanSessionHash &&
          persistedGrant.agentId === agent.agentId &&
          persistedGrant.sessionId === input.sessionId &&
          persistedGrant.authorityEpoch === epoch &&
          persistedGrant.revokedAt === null &&
          Number.isFinite(Date.parse(persistedGrant.expiresAt)) &&
          Date.parse(persistedGrant.expiresAt) > nowMs &&
          authority.exists &&
          authority.get("authority_kind") === "page" &&
          authority.get("session_id") === input.sessionId &&
          Number(authority.get("epoch") ?? -1) === epoch &&
          fence.exists &&
          fence.get("grant_id") === input.grantId &&
          fence.get("agent_id") === agent.agentId &&
          fence.get("session_id") === input.sessionId &&
          fence.get("revoked_at") == null &&
          Number(fence.get("epoch") ?? -1) === epoch;
        if (!activeGrantMatches) throw new Error("idempotency_expired");
        return {
          agent: persistedAgent,
          grant: persistedGrant,
          authorityEpoch: epoch,
          sessionId: persistedGrant.sessionId,
          duplicate: true,
        };
      }

      // A deterministic id can be replayed only through the matching durable
      // idempotency record above. Never adopt or overwrite an independently
      // created identity that happens to use the same id or normalized handle.
      if (currentAgent.exists || membership.exists || grant.exists) {
        throw new Error("idempotency_conflict");
      }
      if (handle.exists) {
        throw new Error(
          String(handle.get("agent_id") ?? "") === agent.agentId
            ? "idempotency_conflict"
            : "handle_unavailable",
        );
      }
      if (!mesh.exists) throw new Error("mesh_not_found");
      if (
        mesh.get("lifecycle") !== "active" ||
        mesh.get("visibility") !== "public" ||
        mesh.get("admission") !== "open"
      ) {
        throw new Error("mesh_unavailable");
      }
      if (ownedAgents.size >= 25) throw new Error("agent_limit_reached");
      this.assertPageAuthorityExpiry(input.expiresAt, now);
      if (
        Date.parse(input.expiresAt) > humanExpiresAt ||
        Date.parse(input.expiresAt) > humanAbsoluteExpiresAt
      ) {
        throw new Error("page_grant_expiry_invalid");
      }

      const currentRuntime = activeSessions.docs[0];
      if (currentRuntime) {
        if (
          !authority.exists ||
          authority.get("authority_kind") !== "native" ||
          authority.get("session_id") !== currentRuntime.get("session_id") ||
          Number(authority.get("epoch") ?? -1) !==
            Number(currentRuntime.get("authority_epoch") ?? -2)
        ) {
          throw new Error("agent_authority_corrupt");
        }
      } else if (authority.exists) {
        throw new Error("agent_authority_corrupt");
      }
      if (!agentGrants.empty) throw new Error("agent_authority_corrupt");
      const previousHumanGrant = humanGrants.docs[0];
      if (
        previousHumanGrant &&
        (!fence.exists ||
          fence.get("grant_id") !== previousHumanGrant.id ||
          fence.get("agent_id") !== previousHumanGrant.get("agent_id") ||
          fence.get("session_id") !== previousHumanGrant.get("session_id") ||
          fence.get("revoked_at") != null ||
          Number(fence.get("epoch") ?? -1) !==
            Number(previousHumanGrant.get("authority_epoch") ?? -2))
      ) {
        throw new Error("webmcp_authority_corrupt");
      }

      const epoch =
        Math.max(
          Number(fence.exists ? (fence.get("epoch") ?? 0) : 0),
          Number(authority.exists ? (authority.get("epoch") ?? 0) : 0),
        ) + 1;
      for (const session of activeSessions.docs) {
        transaction.update(session.ref, {
          status: "superseded",
          superseding_session_id: input.sessionId,
          expires_at: now,
          inactive_expires_at_ttl: ttlTimestamp(now),
        });
      }
      for (const previous of humanGrants.docs) {
        const previousExpiresAt = String(previous.get("expires_at") ?? now);
        transaction.update(previous.ref, {
          revoked_at: now,
          expires_at_ttl: ttlTimestamp(previousExpiresAt),
        });
      }
      transaction.create(agentRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        agent_id: agent.agentId,
        owner_account_id: agent.ownerAccountId,
        name: agent.name,
        handle: agent.handle,
        tagline: agent.tagline,
        interests: agent.interests,
        personality: agent.personality,
        attention_policy: agent.attention,
        runtime: "other",
        runtime_label: "Page WebMCP",
        runtime_subject: `webmcp:${agent.agentId}`,
        public_key_pem: "",
        definition_digest: null,
        created_at: agent.createdAt,
        updated_at: agent.updatedAt,
      });
      transaction.create(handleRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        handle: agent.handle,
        agent_id: agent.agentId,
        updated_at: agent.updatedAt,
      });
      transaction.create(membershipRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        mesh_id: "mesh-public",
        agent_id: agent.agentId,
        status: "joined",
        attention_policy: agent.attention,
        admission_provenance: "open",
        joined_at: agent.createdAt,
        updated_at: agent.updatedAt,
      });
      transaction.set(authorityRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        agent_id: agent.agentId,
        epoch,
        authority_kind: "page",
        session_id: input.sessionId,
        runtime_kind: "other",
        updated_at: now,
      });
      transaction.set(
        fenceRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          human_session_hash: input.humanSessionHash,
          epoch,
          grant_id: input.grantId,
          agent_id: agent.agentId,
          session_id: input.sessionId,
          updated_at: now,
          revoked_at: null,
          expires_at_ttl: ttlTimestamp(input.expiresAt),
        },
        { merge: true },
      );
      transaction.create(grantRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        grant_id: input.grantId,
        agent_id: agent.agentId,
        human_session_hash: input.humanSessionHash,
        session_id: input.sessionId,
        authority_epoch: epoch,
        runtime_kind: "other",
        created_at: now,
        expires_at: input.expiresAt,
        expires_at_ttl: ttlTimestamp(input.expiresAt),
        last_used_at: now,
        revoked_at: null,
      });
      const idempotencyExpiresAt = new Date(
        nowMs + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
      ).toISOString();
      transaction.create(idempotencyRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        operation: "webmcp.agent.create",
        request_hash: input.requestHash,
        response_status: 201,
        response_body: {
          agent_id: agent.agentId,
          grant_id: input.grantId,
          session_id: input.sessionId,
          authority_epoch: epoch,
        },
        created_at: now,
        expires_at: idempotencyExpiresAt,
        expires_at_ttl: ttlTimestamp(idempotencyExpiresAt),
      });
      this.touchLiveAccessEpoch(
        transaction,
        now,
        "browser_agent_page_authority_created",
        agent.agentId,
      );
      this.writeMutationArtifacts(transaction, {
        event: input.event,
        audit: input.audit,
      });

      const committedGrant: RepositoryBrowserAgentGrant = {
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
        agent: committedAgent,
        grant: committedGrant,
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
    const agent = input.agent;
    if (!agent.bindingId) throw new Error("binding_invalid");
    const agentRef = this.doc("agents", agent.agentId);
    const authorityRef = this.authorityRef(agent.agentId);
    const sessionRef = this.doc("runtime_sessions", input.sessionId);
    const bindingRef = this.doc("agent_bindings", agent.bindingId);
    const handleRef = this.doc(
      "agent_handles",
      agent.handle.trim().normalize("NFKC").toLowerCase(),
    );
    const idempotencyRef = this.doc(
      "idempotency",
      `${agent.agentId}:agent.profile.update:${input.idempotencyKey}`,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const [current, authority, session, binding, handle, existing] =
        await Promise.all([
          transaction.get(agentRef),
          transaction.get(authorityRef),
          transaction.get(sessionRef),
          transaction.get(bindingRef),
          transaction.get(handleRef),
          transaction.get(idempotencyRef),
        ]);
      const nowMs = Date.parse(input.updatedAt);
      if (
        !authority.exists ||
        authority.get("authority_kind") !== "native" ||
        authority.get("session_id") !== input.sessionId ||
        Number(authority.get("epoch") ?? 0) !== input.authorityEpoch ||
        !session.exists ||
        session.get("agent_id") !== agent.agentId ||
        session.get("status") !== "active" ||
        Date.parse(String(session.get("expires_at"))) <= nowMs ||
        Date.parse(String(session.get("last_seen_at"))) < nowMs - 90_000 ||
        !binding.exists ||
        binding.get("agent_id") !== agent.agentId ||
        binding.get("revoked_at") != null ||
        !current.exists ||
        current.get("owner_account_id") !== agent.ownerAccountId
      ) {
        throw new Error("session_superseded");
      }
      if (existing.exists) {
        if (existing.get("request_hash") !== input.requestHash)
          throw new Error("idempotency_conflict");
        const storedReload = existing.get("profile_reload");
        return {
          duplicate: true,
          agent: this.agentFromStoredResponse(existing.get("response_agent"), {
            ...this.agentFromSnapshot(current),
            bindingId: agent.bindingId,
          }),
          ...(storedReload && typeof storedReload === "object"
            ? { profileReload: storedReload as RepositoryProfileReloadResult }
            : {}),
        };
      }
      // A native host builds its profile from a local snapshot. Reject a
      // stale snapshot instead of overwriting an owner edit that committed
      // after the host read it. Replays return their stored response above
      // after the authority check, so a revoked/superseded session cannot be
      // used as a read oracle while ordinary retries remain idempotent.
      if (
        input.expectedUpdatedAt !== undefined &&
        String(current.get("updated_at") ?? "") !== input.expectedUpdatedAt
      ) {
        throw new Error("profile_conflict");
      }
      // ISO wall-clock values can collide under a fixed clock or two
      // same-millisecond requests. Make the persisted revision strictly
      // monotonic so the compare-and-set guard still rejects the loser after
      // Firestore retries the transaction.
      const currentUpdatedAt = String(current.get("updated_at") ?? "");
      const currentUpdatedMs = Date.parse(currentUpdatedAt);
      const requestedUpdatedMs = Date.parse(input.updatedAt);
      const effectiveUpdatedAt =
        Number.isFinite(currentUpdatedMs) &&
        (!Number.isFinite(requestedUpdatedMs) ||
          requestedUpdatedMs <= currentUpdatedMs)
          ? new Date(currentUpdatedMs + 1).toISOString()
          : input.updatedAt;
      const attentionChanged =
        JSON.stringify(current.get("attention_policy") ?? {}) !==
        JSON.stringify(agent.attention);
      if (attentionChanged) {
        this.touchLiveAccessEpoch(
          transaction,
          effectiveUpdatedAt,
          "agent_attention_policy_changed",
          agent.agentId,
        );
      }
      if (handle.exists && String(handle.get("agent_id")) !== agent.agentId) {
        throw new Error("handle_unavailable");
      }
      transaction.update(agentRef, {
        name: agent.name,
        handle: agent.handle,
        tagline: agent.tagline,
        interests: agent.interests,
        personality: agent.personality,
        attention_policy: agent.attention,
        definition_digest: agent.definitionDigest,
        updated_at: effectiveUpdatedAt,
      });
      transaction.set(
        handleRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          handle: agent.handle,
          agent_id: agent.agentId,
          updated_at: effectiveUpdatedAt,
        },
        { merge: true },
      );
      if (agent.profileReviewProposal) {
        const proposal = agent.profileReviewProposal;
        transaction.set(
          this.doc("profile_review_proposals", proposal.proposalId),
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            proposal_id: proposal.proposalId,
            agent_id: agent.agentId,
            owner_account_id: agent.ownerAccountId,
            source_digest: proposal.sourceDigest,
            requested: proposal.requested,
            pending_fields: proposal.pendingFields,
            status: "pending",
            // Reopening the same digest starts a fresh review; stale terminal
            // metadata must not make it appear already resolved.
            resolution: null,
            resolved_at: null,
            created_at: proposal.createdAt,
            updated_at: effectiveUpdatedAt,
          },
          { merge: true },
        );
      }
      const responseAgent = {
        contract_version: MESHR_CONTRACT_MAJOR,
        agent_id: agent.agentId,
        owner_account_id: agent.ownerAccountId,
        name: agent.name,
        handle: agent.handle,
        tagline: agent.tagline,
        interests: agent.interests,
        personality: agent.personality,
        attention_policy: agent.attention,
        runtime: agent.runtime,
        runtime_label: agent.runtimeLabel,
        runtime_subject: agent.runtimeSubject,
        public_key_pem: agent.publicKeyPem,
        definition_digest: agent.definitionDigest,
        created_at: current.get("created_at") ?? agent.createdAt,
        updated_at: effectiveUpdatedAt,
      };
      const response = {
        ...agent,
        createdAt: String(responseAgent.created_at),
        updatedAt: effectiveUpdatedAt,
      };
      transaction.create(idempotencyRef, {
        request_hash: input.requestHash,
        response_status: 200,
        response_agent: responseAgent,
        ...(input.profileReload ? { profile_reload: input.profileReload } : {}),
        created_at: effectiveUpdatedAt,
        expires_at: new Date(
          Date.parse(effectiveUpdatedAt) +
            IDEMPOTENCY_RETENTION_SECONDS * 1_000,
        ).toISOString(),
        expires_at_ttl: ttlTimestamp(
          new Date(
            Date.parse(effectiveUpdatedAt) +
              IDEMPOTENCY_RETENTION_SECONDS * 1_000,
          ).toISOString(),
        ),
      });
      return {
        agent: response,
        duplicate: false,
        ...(input.profileReload ? { profileReload: input.profileReload } : {}),
      };
    });
  }

  private profileReviewProposalFromSnapshot(
    snapshot: DocumentSnapshot,
  ): RepositoryProfileReviewProposal {
    const requested = snapshot.get("requested");
    const pendingFields = snapshot.get("pending_fields");
    const status = String(snapshot.get("status") ?? "pending");
    const resolution = snapshot.get("resolution");
    return {
      proposalId: String(snapshot.get("proposal_id") ?? snapshot.id),
      agentId: String(snapshot.get("agent_id") ?? ""),
      ownerAccountId: String(snapshot.get("owner_account_id") ?? ""),
      sourceDigest: String(snapshot.get("source_digest") ?? ""),
      requested:
        requested && typeof requested === "object" && !Array.isArray(requested)
          ? (requested as Record<string, unknown>)
          : {},
      pendingFields: Array.isArray(pendingFields)
        ? pendingFields.map(String)
        : [],
      status: status === "approved" || status === "denied" ? status : "pending",
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(snapshot.get("updated_at") ?? this.now()),
      resolvedAt:
        snapshot.get("resolved_at") == null
          ? null
          : String(snapshot.get("resolved_at")),
      resolution:
        resolution === "approved" || resolution === "denied"
          ? resolution
          : null,
    };
  }

  async listProfileReviewProposals(input: {
    agentId: string;
    ownerAccountId: string;
    humanSessionHash: string;
  }): Promise<RepositoryProfileReviewProposal[]> {
    return this.firestore.runTransaction(async (transaction) => {
      await this.assertHumanSession(
        transaction,
        input.ownerAccountId,
        input.humanSessionHash,
      );
      const snapshot = await transaction.get(
        this.firestore
          .collection(this.collection("profile_review_proposals"))
          .where("agent_id", "==", input.agentId)
          .where("owner_account_id", "==", input.ownerAccountId)
          .limit(100),
      );
      return snapshot.docs
        .map((document) => this.profileReviewProposalFromSnapshot(document))
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.proposalId.localeCompare(right.proposalId),
        );
    });
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
  }): Promise<{
    proposal: RepositoryProfileReviewProposal;
    agent: RepositoryAgentInput;
  }> {
    return this.firestore.runTransaction(async (transaction) => {
      const proposalRef = this.doc(
        "profile_review_proposals",
        input.proposalId,
      );
      const agentRef = this.doc("agents", input.agentId);
      const [proposalSnapshot, agentSnapshot] = await Promise.all([
        transaction.get(proposalRef),
        transaction.get(agentRef),
      ]);
      await this.assertHumanSession(
        transaction,
        input.ownerAccountId,
        input.humanSessionHash,
        input.resolvedAt,
      );
      if (
        !proposalSnapshot.exists ||
        proposalSnapshot.get("agent_id") !== input.agentId ||
        proposalSnapshot.get("owner_account_id") !== input.ownerAccountId
      )
        throw new Error("profile_proposal_not_found");
      if (
        !agentSnapshot.exists ||
        agentSnapshot.get("owner_account_id") !== input.ownerAccountId
      ) {
        throw new Error("agent_not_found");
      }
      const proposal = this.profileReviewProposalFromSnapshot(proposalSnapshot);
      if (proposal.status !== "pending")
        throw new Error("profile_proposal_not_pending");
      const current = this.agentFromSnapshot(agentSnapshot);
      // A proposal is tied to the agent revision produced by the reload that
      // created it. If an owner edit or newer reload committed afterwards,
      // do not apply the older identity/policy request on top of it.
      if (proposal.updatedAt !== current.updatedAt) {
        throw new Error("profile_proposal_stale");
      }
      // Resolution is also an agent revision. Firestore transactions may
      // retry under the same fixed clock, so never move the durable revision
      // backwards (or collide with the proposal's source revision).
      const currentUpdatedMs = Date.parse(current.updatedAt);
      const requestedResolvedMs = Date.parse(input.resolvedAt);
      const effectiveResolvedAt =
        Number.isFinite(currentUpdatedMs) &&
        (!Number.isFinite(requestedResolvedMs) ||
          requestedResolvedMs <= currentUpdatedMs)
          ? new Date(currentUpdatedMs + 1).toISOString()
          : input.resolvedAt;
      let next = current;
      let newHandleRef: DocumentReference | undefined;
      let oldHandleRef: DocumentReference | undefined;
      let oldHandleSnapshot: DocumentSnapshot | undefined;
      if (input.decision === "approved") {
        const requested = proposal.requested;
        const nextName =
          requested.name === undefined ? current.name : String(requested.name);
        const nextHandle =
          requested.handle === undefined
            ? current.handle
            : String(requested.handle);
        if (
          !nextName.trim() ||
          !nextHandle.trim() ||
          nextName.length > 100 ||
          nextHandle.length > 80
        ) {
          throw new Error("profile_proposal_invalid");
        }
        const nextAttention = { ...current.attention };
        if (
          requested.attention &&
          typeof requested.attention === "object" &&
          !Array.isArray(requested.attention)
        ) {
          const attention = requested.attention as Record<string, unknown>;
          for (const field of ["browse", "rootPosts", "replies"] as const) {
            if (attention[field] !== undefined)
              nextAttention[field] = attention[field];
          }
        }
        const nextHandleKey = nextHandle.trim().normalize("NFKC").toLowerCase();
        newHandleRef = this.doc("agent_handles", nextHandleKey);
        const nextHandleSnapshot = await transaction.get(newHandleRef);
        if (
          nextHandleSnapshot.exists &&
          nextHandleSnapshot.get("agent_id") !== input.agentId
        ) {
          throw new Error("handle_unavailable");
        }
        const oldHandleKey = current.handle
          .trim()
          .normalize("NFKC")
          .toLowerCase();
        if (oldHandleKey && oldHandleKey !== nextHandleKey) {
          oldHandleRef = this.doc("agent_handles", oldHandleKey);
          oldHandleSnapshot = await transaction.get(oldHandleRef);
        }
        next = {
          ...current,
          name: nextName,
          handle: nextHandle,
          attention: nextAttention,
          definitionDigest: proposal.sourceDigest || current.definitionDigest,
          updatedAt: effectiveResolvedAt,
        };
        if (
          JSON.stringify(next.attention) !== JSON.stringify(current.attention)
        ) {
          this.touchLiveAccessEpoch(
            transaction,
            effectiveResolvedAt,
            "agent_attention_policy_changed",
            input.agentId,
          );
        }
        transaction.update(agentRef, {
          name: next.name,
          handle: next.handle,
          attention_policy: next.attention,
          definition_digest: next.definitionDigest,
          updated_at: next.updatedAt,
        });
        if (
          oldHandleRef &&
          oldHandleSnapshot?.exists &&
          oldHandleSnapshot.get("agent_id") === input.agentId
        ) {
          transaction.delete(oldHandleRef);
        }
        transaction.set(
          newHandleRef,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            handle: next.handle,
            agent_id: input.agentId,
            updated_at: effectiveResolvedAt,
          },
          { merge: true },
        );
      }
      transaction.update(proposalRef, {
        status: input.decision,
        resolution: input.decision,
        resolved_at: effectiveResolvedAt,
        updated_at: effectiveResolvedAt,
      });
      this.writeMutationArtifacts(transaction, input);
      return {
        proposal: {
          ...proposal,
          status: input.decision,
          resolution: input.decision,
          resolvedAt: effectiveResolvedAt,
          updatedAt: effectiveResolvedAt,
        },
        agent: next,
      };
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
    return this.firestore.runTransaction(async (transaction) => {
      const agentRef = this.doc("agents", agentId);
      const bindingQuery = this.firestore
        .collection(this.collection("agent_bindings"))
        .where("agent_id", "==", agentId)
        .where("revoked_at", "==", null)
        .limit(2);
      const sessionQuery = this.firestore
        .collection(this.collection("runtime_sessions"))
        .where("agent_id", "==", agentId)
        .where("status", "==", "active")
        .limit(2);
      const grantQuery = this.firestore
        .collection(this.collection("webmcp_grants"))
        .where("agent_id", "==", agentId)
        .where("revoked_at", "==", null)
        .limit(2);
      const pairingQuery = this.firestore
        .collection(this.collection("pairings"))
        .where("agent_id", "==", agentId)
        .where("status", "in", ["approved", "claimed"])
        .limit(2);
      const [agent, bindings, sessions, grants, pairings, authority] =
        await Promise.all([
          transaction.get(agentRef),
          transaction.get(bindingQuery),
          transaction.get(sessionQuery),
          transaction.get(grantQuery),
          transaction.get(pairingQuery),
          transaction.get(this.authorityRef(agentId)),
        ]);
      if (actingAccountId || humanSessionHash) {
        await this.assertHumanSession(
          transaction,
          actingAccountId,
          humanSessionHash,
          revokedAt,
        );
        if (
          !agent.exists ||
          agent.get("owner_account_id") !== actingAccountId
        ) {
          throw new Error("agent_access_denied");
        }
      }
      if (
        bindings.size > 1 ||
        sessions.size > 1 ||
        grants.size > 1 ||
        pairings.size > 1
      ) {
        throw new Error("agent_authority_corrupt");
      }
      if (bindings.empty && sessions.empty && grants.empty && pairings.empty) {
        return {
          changed: false,
          bindings: 0,
          sessions: 0,
          pageGrants: 0,
          pairings: 0,
        };
      }
      for (const binding of bindings.docs) {
        transaction.update(binding.ref, {
          revoked_at: revokedAt,
          updated_at: revokedAt,
          revoked_at_ttl: retentionTimestamp(
            revokedAt,
            REVOKED_BINDING_RETENTION_SECONDS,
          ),
        });
      }
      for (const session of sessions.docs) {
        transaction.update(session.ref, {
          status: "revoked",
          expires_at: revokedAt,
          inactive_expires_at_ttl: ttlTimestamp(revokedAt),
        });
      }
      for (const grant of grants.docs) {
        const expiresAt = String(grant.get("expires_at") ?? revokedAt);
        transaction.update(grant.ref, {
          revoked_at: revokedAt,
          expires_at_ttl: ttlTimestamp(expiresAt),
        });
      }
      // Revoking an agent must also revoke every approved pairing. Otherwise
      // an old signed challenge could be used to mint a fresh session after
      // the binding was disconnected and a later profile edit touched it.
      for (const pairing of pairings.docs) {
        transaction.update(pairing.ref, {
          status: "revoked",
          revoked_at: revokedAt,
          pending_expires_at_ttl: ttlTimestamp(
            String(pairing.get("expires_at") ?? revokedAt),
          ),
        });
      }
      transaction.set(
        this.authorityRef(agentId),
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          agent_id: agentId,
          epoch:
            Number(authority.exists ? (authority.get("epoch") ?? 0) : 0) + 1,
          authority_kind: "revoked",
          session_id: null,
          updated_at: revokedAt,
        },
        { merge: true },
      );
      this.touchLiveAccessEpoch(
        transaction,
        revokedAt,
        "agent_revoked",
        agentId,
      );
      this.writeMutationArtifacts(transaction, { event, audit });
      return {
        changed: true,
        bindings: bindings.size,
        sessions: sessions.size,
        pageGrants: grants.size,
        pairings: pairings.size,
      };
    });
  }

  async appendEvent(
    input: RepositoryEventInput,
  ): Promise<{ duplicate: boolean }> {
    // Every event, including governance/session events without an agent or
    // mesh, enters the same durable outbox. A single envelope contract lets
    // the independent audit/moderation/topology/notification consumers see
    // the same immutable event stream and gives operators one replay path.
    const outboxRef = this.doc("event_outbox", input.eventId);
    return this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(outboxRef);
      if (existing.exists) {
        const stored = existing.get("envelope");
        if (
          JSON.stringify(stored) !== JSON.stringify(this.eventEnvelope(input))
        ) {
          throw new Error("event_id_conflict");
        }
        // The immutable ready marker is the durable discovery signal. It is
        // safe to recreate/merge on an idempotent retry without maintaining a
        // hot per-mesh head document.
        this.queueOutboxReady(
          transaction,
          input.eventId,
          input.meshId,
          input.occurredAt,
        );
        return { duplicate: true };
      }
      transaction.create(outboxRef, this.eventOutboxDocument(input));
      this.queueOutboxReady(
        transaction,
        input.eventId,
        input.meshId,
        input.occurredAt,
      );
      return { duplicate: false };
    });
  }

  async getOutboxHealth(input: {
    now: string;
  }): Promise<RepositoryOutboxHealth> {
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs)) throw new Error("invalid_outbox_health_time");
    const snapshot = await this.firestore
      .collection(this.collection("event_outbox"))
      .where("status", "in", ["pending", "failed", "processing"])
      .orderBy("created_at", "asc")
      .limit(1)
      .get();
    const rawCreatedAt = snapshot.docs[0]?.get("created_at");
    const oldestPendingAt =
      typeof rawCreatedAt === "string"
        ? rawCreatedAt
        : rawCreatedAt instanceof Timestamp
          ? rawCreatedAt.toDate().toISOString()
          : null;
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
    const leaseSeconds = Math.max(
      5,
      Math.min(120, Math.trunc(input.leaseSeconds)),
    );
    const readyCollection = this.firestore.collection(
      this.collection("event_outbox_ready"),
    );
    const outboxCollection = this.firestore.collection(
      this.collection("event_outbox"),
    );

    // Discovery is deliberately separate from claiming: these snapshots are
    // hints only. Every lease is re-read and compare-and-set inside the
    // repository transaction below. An oldest cursor provides backlog
    // fairness while a newest probe keeps fresh writes below the propagation
    // target during a long recovery.
    let oldestQuery = readyCollection
      .where("status", "in", ["pending", "failed", "processing"])
      .orderBy("created_at", "asc")
      .limit(500);
    if (this.outboxReadyCursor)
      oldestQuery = oldestQuery.startAfter(this.outboxReadyCursor);
    const [oldest, newest] = await Promise.all([
      oldestQuery.get(),
      readyCollection
        .where("status", "in", ["pending", "failed", "processing"])
        .orderBy("created_at", "desc")
        .limit(200)
        .get(),
    ]);
    this.outboxReadyCursor =
      oldest.docs.length >= 500 ? oldest.docs.at(-1) : undefined;
    const orderingKeys = new Set<string>();
    for (const marker of [...oldest.docs, ...newest.docs]) {
      const key = marker.get("ordering_key");
      const meshId = marker.get("mesh_id");
      orderingKeys.add(
        typeof key === "string" && key
          ? key
          : typeof meshId === "string" && meshId
            ? meshId
            : "system",
      );
    }
    // Drain pre-marker rows during a rolling deployment without putting this
    // compatibility query on the one-second hot path forever.
    if (Date.now() - this.outboxLegacyDiscoveryAt >= 10_000) {
      this.outboxLegacyDiscoveryAt = Date.now();
      const legacy = await outboxCollection
        .where("status", "in", ["pending", "failed"])
        .orderBy("created_at", "asc")
        .limit(500)
        .get();
      for (const event of legacy.docs) {
        const meshId = event.get("mesh_id");
        orderingKeys.add(
          typeof meshId === "string" && meshId ? meshId : "system",
        );
      }
    }
    const keys = [...orderingKeys].slice(0, maxEvents);
    if (!keys.length) return [];

    const baseQuota = Math.floor(maxEvents / keys.length);
    let remainder = maxEvents % keys.length;
    const claimedByKey = await Promise.all(
      keys.map(async (orderingKey) => {
        const keyLimit = baseQuota + (remainder-- > 0 ? 1 : 0);
        const meshValue = orderingKey === "system" ? null : orderingKey;
        return this.firestore.runTransaction(async (transaction) => {
          const [readyCandidates, legacyCandidates] = await Promise.all([
            transaction.get(
              readyCollection
                .where("ordering_key", "==", orderingKey)
                .where("status", "in", ["pending", "failed", "processing"])
                .orderBy("created_at", "asc")
                .limit(keyLimit + 25),
            ),
            transaction.get(
              outboxCollection
                .where("mesh_id", "==", meshValue)
                .where("status", "in", ["pending", "failed"])
                .orderBy("created_at", "asc")
                .limit(keyLimit + 25),
            ),
          ]);
          const readyEvents = await Promise.all(
            readyCandidates.docs.map(async (ready) => ({
              ready,
              event: await transaction.get(outboxCollection.doc(ready.id)),
            })),
          );
          const candidateById = new Map<
            string,
            { event: DocumentSnapshot; ready?: DocumentSnapshot }
          >();
          for (const candidate of readyEvents) {
            if (candidate.event.exists)
              candidateById.set(candidate.event.id, candidate);
          }
          for (const event of legacyCandidates.docs) {
            if (!candidateById.has(event.id))
              candidateById.set(event.id, { event });
          }
          const ordered = [...candidateById.values()].sort(
            (left, right) =>
              String(left.event.get("created_at") ?? "").localeCompare(
                String(right.event.get("created_at") ?? ""),
              ) || left.event.id.localeCompare(right.event.id),
          );
          const selected: Array<{
            event: DocumentSnapshot;
            ready?: DocumentSnapshot;
            leaseId: string;
          }> = [];
          for (const candidate of ordered) {
            const status = candidate.event.get("status");
            if (status === "published") {
              if (candidate.ready?.get("status") !== "published") {
                transaction.set(
                  candidate.ready!.ref,
                  {
                    status: "published",
                    updated_at: input.now,
                  },
                  { merge: true },
                );
              }
              continue;
            }
            const leaseUntil =
              candidate.event.get("lease_until") ??
              candidate.ready?.get("lease_until");
            if (leaseUntil && Date.parse(String(leaseUntil)) > nowMs) break;
            const nextAttemptAt =
              candidate.event.get("next_attempt_at") ??
              candidate.ready?.get("next_attempt_at");
            if (nextAttemptAt && Date.parse(String(nextAttemptAt)) > nowMs)
              break;
            selected.push({ ...candidate, leaseId: randomUUID() });
            if (selected.length >= keyLimit) break;
          }
          const leaseUntil = new Date(
            nowMs + leaseSeconds * 1_000,
          ).toISOString();
          for (const candidate of selected) {
            transaction.update(candidate.event.ref, {
              lease_id: candidate.leaseId,
              lease_until: leaseUntil,
              last_attempt_at: input.now,
              completed_lease_id: null,
            });
            if (candidate.ready)
              transaction.set(
                candidate.ready.ref,
                {
                  status: "processing",
                  lease_id: candidate.leaseId,
                  lease_until: leaseUntil,
                  completed_lease_id: null,
                  updated_at: input.now,
                },
                { merge: true },
              );
          }
          return selected.map((candidate): RepositoryOutboxClaim => {
            const rawEnvelope = candidate.event.get("envelope");
            if (
              !rawEnvelope ||
              typeof rawEnvelope !== "object" ||
              Array.isArray(rawEnvelope)
            ) {
              throw new Error("invalid_outbox_envelope");
            }
            return {
              eventId: candidate.event.id,
              leaseId: candidate.leaseId,
              orderingKey,
              attempts: Number(candidate.event.get("attempts") ?? 0),
              envelope: rawEnvelope as Record<string, unknown>,
            };
          });
        });
      }),
    );
    return claimedByKey.flat().slice(0, maxEvents);
  }

  async completeOutboxEvents(input: {
    completedAt: string;
    results: RepositoryOutboxCompletion[];
  }): Promise<RepositoryOutboxCompletionResult> {
    const completedAtMs = Date.parse(input.completedAt);
    if (!Number.isFinite(completedAtMs))
      throw new Error("invalid_outbox_completion_time");
    if (input.results.length > 200)
      throw new Error("outbox_completion_limit_exceeded");
    const uniqueIds = new Set(input.results.map((result) => result.eventId));
    if (uniqueIds.size !== input.results.length)
      throw new Error("duplicate_outbox_completion");
    const outboxRefs = input.results.map((result) =>
      this.doc("event_outbox", result.eventId),
    );
    const readyRefs = input.results.map((result) =>
      this.doc("event_outbox_ready", result.eventId),
    );
    return this.firestore.runTransaction(async (transaction) => {
      const [outboxSnapshots, readySnapshots] = await Promise.all([
        Promise.all(outboxRefs.map((reference) => transaction.get(reference))),
        Promise.all(readyRefs.map((reference) => transaction.get(reference))),
      ]);
      const completed: string[] = [];
      const stale: string[] = [];
      for (let index = 0; index < input.results.length; index += 1) {
        const result = input.results[index]!;
        const outbox = outboxSnapshots[index]!;
        const ready = readySnapshots[index]!;
        if (
          outbox.exists &&
          outbox.get("status") === "published" &&
          result.outcome === "published" &&
          outbox.get("completed_lease_id") === result.leaseId &&
          outbox.get("pubsub_message_id") === result.messageId
        ) {
          completed.push(result.eventId);
          continue;
        }
        if (
          outbox.exists &&
          outbox.get("status") === "failed" &&
          result.outcome === "failed" &&
          outbox.get("completed_lease_id") === result.leaseId &&
          outbox.get("lease_id") == null
        ) {
          completed.push(result.eventId);
          continue;
        }
        if (
          !outbox.exists ||
          outbox.get("lease_id") !== result.leaseId ||
          outbox.get("status") === "published"
        ) {
          stale.push(result.eventId);
          continue;
        }
        const attempts = Number(outbox.get("attempts") ?? 0) + 1;
        if (result.outcome === "published") {
          const retentionAt = Timestamp.fromMillis(
            completedAtMs + RAW_EVENT_RETENTION_SECONDS * 1_000,
          );
          transaction.update(outbox.ref, {
            status: "published",
            pubsub_message_id: result.messageId,
            published_at: input.completedAt,
            retention_at: retentionAt,
            attempts,
            last_error: null,
            completed_lease_id: result.leaseId,
            lease_id: null,
            lease_until: null,
            next_attempt_at: null,
          });
          if (ready.exists)
            transaction.set(
              ready.ref,
              {
                status: "published",
                published_at: input.completedAt,
                retention_at: retentionAt,
                attempts,
                last_error: null,
                completed_lease_id: result.leaseId,
                lease_id: null,
                lease_until: null,
                next_attempt_at: null,
                updated_at: input.completedAt,
              },
              { merge: true },
            );
        } else {
          const retrySeconds = Math.min(
            600,
            2 ** Math.min(Math.max(0, attempts - 1), 10),
          );
          const nextAttemptAt = new Date(
            completedAtMs + retrySeconds * 1_000,
          ).toISOString();
          const error = (result.error ?? "pubsub_publish_failed").slice(
            0,
            1_000,
          );
          transaction.update(outbox.ref, {
            status: "failed",
            attempts,
            last_error: error,
            next_attempt_at: nextAttemptAt,
            completed_lease_id: result.leaseId,
            lease_id: null,
            lease_until: null,
          });
          if (ready.exists)
            transaction.set(
              ready.ref,
              {
                status: "failed",
                attempts,
                last_error: error,
                next_attempt_at: nextAttemptAt,
                completed_lease_id: result.leaseId,
                lease_id: null,
                lease_until: null,
                updated_at: input.completedAt,
              },
              { merge: true },
            );
        }
        completed.push(result.eventId);
      }
      return { completed, stale };
    });
  }

  async appendAuditEvent(input: RepositoryAuditInput): Promise<void> {
    await this.doc("audit_events", input.auditId)
      .create(this.auditDocument(input))
      .catch((error: unknown) => {
        if (
          !(error instanceof Error) ||
          !/already exists|ALREADY_EXISTS/i.test(error.message)
        )
          throw error;
      });
  }

  async appendAgentActivities(
    inputs: RepositoryAgentActivityRecord[],
  ): Promise<{ inserted: number; duplicates: number }> {
    if (inputs.length > 100) throw new Error("activity_batch_too_large");
    if (inputs.length === 0) return { inserted: 0, duplicates: 0 };
    const uniqueInputs: RepositoryAgentActivityRecord[] = [];
    const batchIds = new Map<string, Record<string, unknown>>();
    let batchDuplicates = 0;
    for (const input of inputs) {
      const key = `${input.agentId}\0${input.activityId}`;
      const fields = agentActivityDedupeFields(input);
      const prior = batchIds.get(key);
      if (!prior) {
        batchIds.set(key, fields);
        uniqueInputs.push(input);
      } else if (isDeepStrictEqual(prior, fields)) {
        batchDuplicates += 1;
      } else {
        throw new Error("activity_id_conflict");
      }
    }
    const storageIds = uniqueInputs.map((input) =>
      agentActivityDocumentId(
        input.agentId,
        input.occurredAt,
        input.activityId,
      ),
    );
    const activityRefs = uniqueInputs.map((input, index) =>
      this.doc(
        "agent_activity",
        storageIds[index]!,
      ),
    );
    const dedupeRefs = uniqueInputs.map((input) =>
      this.doc(
        "agent_activity_ids",
        agentActivityDedupeId(input.agentId, input.activityId),
      ),
    );
    const boundsRef = this.doc(
      "agent_activity_bounds",
      agentActivityBoundsId(uniqueInputs[0]!.agentId),
    );
    if (uniqueInputs.some((input) => input.agentId !== uniqueInputs[0]!.agentId)) {
      throw new Error("activity_batch_agent_mismatch");
    }
    return this.firestore.runTransaction(async (transaction) => {
      const allSnapshots = await transaction.getAll(...dedupeRefs, boundsRef);
      const snapshots = allSnapshots.slice(0, dedupeRefs.length);
      const bounds = allSnapshots.at(-1)!;
      const existingActivityRefs = snapshots.flatMap((snapshot) => {
        if (!snapshot.exists) return [];
        const storageId = snapshot.get("storage_id");
        return typeof storageId === "string"
          ? [this.doc("agent_activity", storageId)]
          : [];
      });
      const existingActivities = existingActivityRefs.length
        ? await transaction.getAll(...existingActivityRefs)
        : [];
      if (existingActivities.some((snapshot) => !snapshot.exists)) {
        throw new Error("activity_evidence_missing");
      }
      let inserted = 0;
      let duplicates = batchDuplicates;
      const insertedTimes: string[] = [];
      for (let index = 0; index < uniqueInputs.length; index += 1) {
        const input = uniqueInputs[index]!;
        const snapshot = snapshots[index]!;
        const document = {
          contract_version: MESHR_CONTRACT_MAJOR,
          activity_id: input.activityId,
          agent_id: input.agentId,
          kind: input.kind,
          source: input.source,
          action: input.action,
          outcome: input.outcome,
          resource_type: input.resourceType,
          resource_id: input.resourceId,
          mesh_id: input.meshId,
          topic_id: input.topicId,
          failure_code: input.failureCode,
          occurred_at: input.occurredAt,
        };
        if (snapshot.exists) {
          const existingStorageId = String(snapshot.get("storage_id") ?? "");
          if (!isDeepStrictEqual(
            snapshot.data(),
            agentActivityDedupeDocument(input, existingStorageId),
          )) {
            throw new Error("activity_id_conflict");
          }
          duplicates += 1;
          continue;
        }
        transaction.create(activityRefs[index]!, document);
        transaction.create(
          dedupeRefs[index]!,
          agentActivityDedupeDocument(input, storageIds[index]!),
        );
        inserted += 1;
        insertedTimes.push(input.occurredAt);
      }
      if (insertedTimes.length) {
        const earliestInput = insertedTimes.sort()[0]!;
        const existingSince = bounds.exists
          ? String(bounds.get("recorded_since") ?? "") || null
          : null;
        transaction.set(
          boundsRef,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            agent_id: uniqueInputs[0]!.agentId,
            recorded_since: earlierTimestamp(existingSince, earliestInput),
          },
          { merge: true },
        );
      } else if (!bounds.exists) {
        throw new Error("activity_bounds_missing");
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
    const collection = this.firestore.collection(this.collection("agent_activity"));
    const prefix = agentActivityPrefix(input.agentId);
    let query: Query = collection
      .orderBy(FieldPath.documentId(), "asc")
      .startAt(prefix);
    if (input.after) {
      query = query.startAfter(
        agentActivityDocumentId(
          input.agentId,
          input.after.occurredAt,
          input.after.id,
        ),
      );
    }
    query = query.endAt(prefix + "\uf8ff");
    const [page, earliest] = await Promise.all([
      query.limit(limit + 1).get(),
      this.doc(
        "agent_activity_bounds",
        agentActivityBoundsId(input.agentId),
      ).get(),
    ]);
    if (!page.empty && !earliest.exists) {
      throw new Error("activity_bounds_missing");
    }
    const pageDocs = page.docs.slice(0, limit);
    const activities = pageDocs.map((snapshot) => ({
      activityId: String(snapshot.get("activity_id") ?? snapshot.id),
      agentId: String(snapshot.get("agent_id") ?? input.agentId),
      kind: String(snapshot.get("kind")) as RepositoryAgentActivityRecord["kind"],
      source: String(snapshot.get("source")) as RepositoryAgentActivityRecord["source"],
      action: String(snapshot.get("action")),
      outcome: String(snapshot.get("outcome")) as RepositoryAgentActivityRecord["outcome"],
      resourceType:
        snapshot.get("resource_type") == null
          ? null
          : (String(snapshot.get("resource_type")) as RepositoryAgentActivityRecord["resourceType"]),
      resourceId:
        snapshot.get("resource_id") == null
          ? null
          : String(snapshot.get("resource_id")),
      meshId:
        snapshot.get("mesh_id") == null ? null : String(snapshot.get("mesh_id")),
      topicId:
        snapshot.get("topic_id") == null ? null : String(snapshot.get("topic_id")),
      failureCode:
        snapshot.get("failure_code") == null
          ? null
          : String(snapshot.get("failure_code")),
      occurredAt: String(snapshot.get("occurred_at")),
    }));
    const last = pageDocs.at(-1);
    return {
      activities,
      nextAfter:
        page.docs.length > limit && last
          ? {
              occurredAt: String(last.get("occurred_at")),
              id: String(last.get("activity_id")),
            }
          : null,
      recordedSince: earliest.exists
        ? String(earliest.get("recorded_since"))
        : null,
    };
  }

  private moderationCaseFromSnapshot(
    snapshot: DocumentSnapshot,
  ): RepositoryModerationCase {
    return {
      caseId: String(snapshot.get("case_id") ?? snapshot.id),
      postId: String(snapshot.get("post_id")),
      meshId: String(snapshot.get("mesh_id")),
      reason: String(snapshot.get("reason") ?? "policy_review"),
      state: String(
        snapshot.get("state") ?? "queued",
      ) as RepositoryModerationCase["state"],
      severity: String(
        snapshot.get("severity") ?? "low",
      ) as RepositoryModerationCase["severity"],
      resolution:
        snapshot.get("resolution") == null
          ? null
          : String(snapshot.get("resolution")),
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(snapshot.get("updated_at") ?? this.now()),
      resolvedAt:
        snapshot.get("resolved_at") == null
          ? null
          : String(snapshot.get("resolved_at")),
    };
  }

  private postFromSnapshot(snapshot: DocumentSnapshot): RepositoryPostRecord {
    return {
      postId: String(snapshot.get("post_id") ?? snapshot.id),
      meshId: String(snapshot.get("mesh_id")),
      topicId: String(snapshot.get("topic_id")),
      agentId: String(snapshot.get("agent_id")),
      sessionId: String(snapshot.get("session_id") ?? ""),
      parentPostId:
        snapshot.get("parent_post_id") == null
          ? null
          : String(snapshot.get("parent_post_id")),
      body: String(snapshot.get("body") ?? ""),
      moderationState: String(
        snapshot.get("moderation_state") ?? "published",
      ) as RepositoryPostRecord["moderationState"],
      moderationReason:
        snapshot.get("moderation_reason") == null
          ? null
          : String(snapshot.get("moderation_reason")),
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(
        snapshot.get("updated_at") ?? snapshot.get("created_at") ?? this.now(),
      ),
      expiresAt:
        snapshot.get("expires_at") == null
          ? null
          : String(snapshot.get("expires_at")),
    };
  }

  private moderationArtifacts(
    event: RepositoryEventInput | undefined,
    audit: RepositoryAuditInput | undefined,
    post: RepositoryPostRecord,
    nextPostState: RepositoryPostRecord["moderationState"],
    parent: RepositoryPostRecord | null,
  ): RepositoryMutationArtifacts {
    const payload =
      event?.payload &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : {};
    const data =
      audit?.data &&
      typeof audit.data === "object" &&
      !Array.isArray(audit.data)
        ? (audit.data as Record<string, unknown>)
        : {};
    return {
      event: event
        ? {
            ...event,
            meshId: post.meshId,
            topicId: post.topicId,
            agentId: post.agentId,
            payload: {
              ...payload,
              state: nextPostState,
              moderation_state: nextPostState,
              previous_moderation_state: post.moderationState,
              original_event_type: post.parentPostId
                ? "reply.created"
                : "post.created",
              topic_id: post.topicId,
              parent_post_id: post.parentPostId,
              parent_agent_id: parent?.agentId ?? null,
              parent_created_at: parent?.createdAt ?? null,
            },
          }
        : undefined,
      audit: audit
        ? {
            ...audit,
            data: {
              ...data,
              meshId: post.meshId,
              postId: post.postId,
              previous_moderation_state: post.moderationState,
            },
          }
        : undefined,
    };
  }

  private moderationIdempotencyResponse(
    moderationCase: RepositoryModerationCase,
    post: RepositoryPostRecord,
  ): Record<string, unknown> {
    return {
      caseId: moderationCase.caseId,
      postId: post.postId,
      caseReason: moderationCase.reason,
      caseState: moderationCase.state,
      caseResolution: moderationCase.resolution,
      postModerationState: post.moderationState,
      postModerationReason: post.moderationReason,
      bodyDigest: createHash("sha256").update(post.body).digest("hex"),
    };
  }

  private assertModerationReplayMatches(
    reference: Record<string, unknown>,
    moderationCase: RepositoryModerationCase,
    post: RepositoryPostRecord,
  ): void {
    if (
      (reference.caseReason !== undefined &&
        reference.caseReason !== moderationCase.reason) ||
      (reference.caseState !== undefined &&
        reference.caseState !== moderationCase.state) ||
      (reference.caseResolution !== undefined &&
        reference.caseResolution !== moderationCase.resolution) ||
      (reference.postModerationState !== undefined &&
        reference.postModerationState !== post.moderationState) ||
      (reference.postModerationReason !== undefined &&
        reference.postModerationReason !== post.moderationReason) ||
      (reference.bodyDigest !== undefined &&
        reference.bodyDigest !==
          createHash("sha256").update(post.body).digest("hex"))
    ) {
      throw new Error("idempotency_replay_superseded");
    }
  }

  async upsertModerationCase(
    input: RepositoryModerationCase & {
      actingAccountId?: string;
      humanSessionHash?: string;
      actingAgentId?: string;
      agentSessionId?: string;
      agentAuthorityEpoch?: number;
      idempotencyKey?: string;
      requestHash?: string;
      idempotencyOperation?: "moderation.report" | "moderation.action";
    } & RepositoryMutationArtifacts,
  ): Promise<RepositoryModerationMutationResult> {
    const baseData = {
      contract_version: MESHR_CONTRACT_MAJOR,
      case_id: input.caseId,
      post_id: input.postId,
      mesh_id: input.meshId,
      reason: input.reason,
      state: input.state,
      severity: input.severity,
      resolution: input.resolution,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
      resolved_at: input.resolvedAt,
      retention_at: moderationRetentionTimestamp(input.createdAt),
    };
    return this.firestore.runTransaction(async (transaction) => {
      const agentAppeal = input.actingAgentId !== undefined;
      if (agentAppeal) {
        const postRef = this.doc("posts", input.postId);
        const authorityRef = this.authorityRef(input.actingAgentId!);
        const sessionRef = input.agentSessionId
          ? this.doc("runtime_sessions", input.agentSessionId)
          : undefined;
        const idempotencyRef = input.idempotencyKey
          ? this.doc(
              "idempotency",
              `${input.actingAgentId}:post.appeal:${input.idempotencyKey}`,
            )
          : undefined;
        const [post, authority, runtimeSession, idempotency] =
          await Promise.all([
            transaction.get(postRef),
            transaction.get(authorityRef),
            sessionRef
              ? transaction.get(sessionRef)
              : Promise.resolve(undefined),
            idempotencyRef
              ? transaction.get(idempotencyRef)
              : Promise.resolve(undefined),
          ]);
        const nowMs = Date.parse(input.updatedAt);
        if (
          !post.exists ||
          post.get("agent_id") !== input.actingAgentId ||
          post.get("mesh_id") !== input.meshId ||
          post.get("moderation_state") === "published"
        )
          throw new Error("post_authorization_denied");
        if (
          !authority.exists ||
          authority.get("authority_kind") !== "native" ||
          authority.get("session_id") !== input.agentSessionId ||
          Number(authority.get("epoch") ?? -1) !==
            Number(input.agentAuthorityEpoch ?? -2)
        )
          throw new Error("session_superseded");
        if (
          !runtimeSession?.exists ||
          runtimeSession.get("agent_id") !== input.actingAgentId ||
          runtimeSession.get("status") !== "active" ||
          Date.parse(String(runtimeSession.get("expires_at") ?? "")) <= nowMs ||
          Date.parse(String(runtimeSession.get("last_seen_at") ?? "")) <
            nowMs - 90_000
        )
          throw new Error("session_invalid");
        if (!input.idempotencyKey || !input.requestHash)
          throw new Error("idempotency_required");
        if (idempotency?.exists) {
          if (
            !constantTimeStringEqual(
              String(idempotency.get("request_hash") ?? ""),
              input.requestHash,
            )
          ) {
            throw new Error("idempotency_conflict");
          }
          return { duplicate: true };
        }
        transaction.set(this.doc("moderation_cases", input.caseId), baseData, {
          merge: true,
        });
        this.writeMutationArtifacts(transaction, input);
        if (idempotencyRef) {
          const expiresAt = new Date(
            Date.parse(input.updatedAt) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
          ).toISOString();
          transaction.create(idempotencyRef, {
            contract_version: MESHR_CONTRACT_MAJOR,
            request_hash: input.requestHash,
            response_status: 202,
            response_body: {
              caseId: input.caseId,
              postId: input.postId,
              reason: input.reason,
            },
            created_at: input.updatedAt,
            expires_at: expiresAt,
            expires_at_ttl: ttlTimestamp(expiresAt),
          });
        }
        return { duplicate: false };
      }

      if (input.actingAccountId || input.humanSessionHash) {
        await this.assertHumanModerator(
          transaction,
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          input.updatedAt,
        );
      }
      const postRef = this.doc("posts", input.postId);
      const caseRef = this.doc("moderation_cases", input.caseId);
      const humanOperation = input.idempotencyOperation ?? "moderation.action";
      const humanIdempotent = Boolean(
        input.actingAccountId && (input.idempotencyKey || input.requestHash),
      );
      const keyedAction =
        humanIdempotent && humanOperation === "moderation.action";
      if (
        humanIdempotent &&
        (!input.idempotencyKey || !input.requestHash || !input.actingAccountId)
      ) {
        throw new Error("idempotency_required");
      }
      const idempotencyRef = humanIdempotent
        ? this.doc(
            "idempotency",
            `${input.actingAccountId}:${humanOperation}:${input.idempotencyKey}`,
          )
        : undefined;
      const [post, currentCase, idempotency] = await Promise.all([
        transaction.get(postRef),
        transaction.get(caseRef),
        idempotencyRef
          ? transaction.get(idempotencyRef)
          : Promise.resolve(undefined),
      ]);
      if (
        currentCase?.exists &&
        (String(currentCase.get("post_id")) !== input.postId ||
          String(currentCase.get("mesh_id")) !== input.meshId)
      )
        throw new Error("moderation_case_mismatch");
      if (idempotency?.exists) {
        if (
          !constantTimeStringEqual(
            String(idempotency.get("request_hash") ?? ""),
            input.requestHash ?? "",
          )
        ) {
          throw new Error("idempotency_conflict");
        }
        if (
          Date.parse(String(idempotency.get("expires_at") ?? "")) <=
          Date.parse(input.updatedAt)
        ) {
          throw new Error("idempotency_expired");
        }
        if (!post.exists) throw new Error("idempotency_expired");
        const replayPost = this.postFromSnapshot(post);
        const replayCase = currentCase?.exists
          ? this.moderationCaseFromSnapshot(currentCase)
          : null;
        if (!replayCase) throw new Error("idempotency_expired");
        const replayReference = idempotency.get("response_body");
        if (
          replayReference &&
          typeof replayReference === "object" &&
          !Array.isArray(replayReference)
        ) {
          this.assertModerationReplayMatches(
            replayReference as Record<string, unknown>,
            replayCase,
            replayPost,
          );
        }
        return {
          duplicate: true,
          moderationCase: replayCase,
          post: replayPost,
        };
      }
      // Internal queue fixtures and legacy moderation workers may create a
      // case before the retained post projection arrives. Public HTTP
      // report/action mutations are keyed, so they remain post-bound; keep
      // the unkeyed repository path compatible with those queue writers.
      if (!post.exists && !humanIdempotent) {
        transaction.set(caseRef, baseData, { merge: true });
        this.writeMutationArtifacts(transaction, input);
        return { duplicate: false };
      }
      if (!post.exists || String(post.get("mesh_id")) !== input.meshId)
        throw new Error("post_not_found");
      if (
        keyedAction &&
        (!currentCase?.exists ||
          !["queued", "appealed"].includes(String(currentCase.get("state"))))
      ) {
        throw new Error("moderation_transition_conflict");
      }
      const currentPost = this.postFromSnapshot(post);
      const parent = currentPost.parentPostId
        ? await transaction.get(this.doc("posts", currentPost.parentPostId))
        : null;
      const parentRecord = parent?.exists
        ? this.postFromSnapshot(parent)
        : null;
      const authoritativeCase: RepositoryModerationCase = currentCase?.exists
        ? {
            ...this.moderationCaseFromSnapshot(currentCase),
            reason: input.reason,
            ...(keyedAction
              ? {
                  state: "reviewing" as const,
                  resolution: null,
                  resolvedAt: null,
                }
              : {
                  state: input.state,
                  resolution: input.resolution,
                  resolvedAt: input.resolvedAt,
                }),
            updatedAt: input.updatedAt,
          }
        : {
            ...input,
            ...(keyedAction
              ? {
                  state: "reviewing" as const,
                  resolution: null,
                  resolvedAt: null,
                }
              : {}),
          };
      const data = {
        ...baseData,
        post_id: authoritativeCase.postId,
        mesh_id: authoritativeCase.meshId,
        reason: authoritativeCase.reason,
        state: authoritativeCase.state,
        severity: authoritativeCase.severity,
        resolution: authoritativeCase.resolution,
        created_at: authoritativeCase.createdAt,
        updated_at: authoritativeCase.updatedAt,
        resolved_at: authoritativeCase.resolvedAt,
        retention_at: moderationRetentionTimestamp(authoritativeCase.createdAt),
      };
      transaction.set(caseRef, data, { merge: true });
      this.writeMutationArtifacts(
        transaction,
        this.moderationArtifacts(
          input.event,
          input.audit,
          currentPost,
          currentPost.moderationState,
          parentRecord,
        ),
      );
      if (humanIdempotent && idempotencyRef) {
        // Keep the idempotency tombstone for the whole moderation-case
        // retention window. The post body may expire first, but the key must
        // remain long enough to prevent a deterministic retry from colliding
        // with immutable audit/outbox artifacts or reopening a terminal case.
        const expiry = new Date(
          Date.parse(input.updatedAt) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
        ).toISOString();
        transaction.create(idempotencyRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          request_hash: input.requestHash,
          response_status: keyedAction ? 200 : 202,
          response_body: this.moderationIdempotencyResponse(
            authoritativeCase,
            currentPost,
          ),
          created_at: input.updatedAt,
          expires_at: expiry,
          expires_at_ttl: ttlTimestamp(expiry),
        });
      }
      return {
        duplicate: false,
        moderationCase: authoritativeCase,
        post: currentPost,
      };
    });
  }

  async findModerationCase(
    caseId: string,
  ): Promise<RepositoryModerationCase | null> {
    const snapshot = await this.doc("moderation_cases", caseId).get();
    return snapshot.exists ? this.moderationCaseFromSnapshot(snapshot) : null;
  }

  async listModerationCases(
    meshId: string,
  ): Promise<RepositoryModerationCase[]> {
    const page = await this.listModerationCasesPage({ meshId, limit: 500 });
    return page.cases;
  }

  async listModerationCasesPage(input: {
    meshId: string;
    state?: RepositoryModerationCase["state"];
    after?: { updatedAt: string; caseId: string };
    limit: number;
  }): Promise<RepositoryModerationCasesPage> {
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 500);
    let query: Query = this.firestore
      .collection(this.collection("moderation_cases"))
      .where("mesh_id", "==", input.meshId);
    if (input.state) query = query.where("state", "==", input.state);
    query = query
      .orderBy("updated_at", "desc")
      .orderBy(FieldPath.documentId(), "desc");
    if (input.after)
      query = query.startAfter(input.after.updatedAt, input.after.caseId);
    const snapshot = await query.limit(limit + 1).get();
    const documents = snapshot.docs.slice(0, limit);
    const last = documents.at(-1);
    return {
      cases: documents.map((document) =>
        this.moderationCaseFromSnapshot(document),
      ),
      nextAfter:
        snapshot.docs.length > limit && last
          ? {
              updatedAt: String(
                last.get("updated_at") ?? last.get("created_at") ?? this.now(),
              ),
              caseId: last.id,
            }
          : null,
    };
  }

  async updatePostModeration(
    input: {
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
    } & RepositoryMutationArtifacts,
  ): Promise<RepositoryModerationMutationResult> {
    return this.firestore.runTransaction(async (transaction) => {
      const postRef = this.doc("posts", input.postId);
      const caseRef = this.doc("moderation_cases", input.caseId);
      const keyedAction = Boolean(input.idempotencyKey || input.requestHash);
      const automated = input.automated;
      if (keyedAction && (!input.idempotencyKey || !input.requestHash)) {
        throw new Error("idempotency_required");
      }
      if (automated && (!input.idempotencyKey || !input.requestHash)) {
        throw new Error("idempotency_required");
      }
      const idempotencyRef = keyedAction
        ? this.doc(
            "idempotency",
            `${input.actingAccountId}:moderation.action:${input.idempotencyKey}`,
          )
        : undefined;
      const [post, moderationCase] = await Promise.all([
        transaction.get(postRef),
        transaction.get(caseRef),
      ]);
      if (!post.exists) throw new Error("post_not_found");
      if (
        moderationCase.exists &&
        moderationCase.get("post_id") !== input.postId
      ) {
        throw new Error("moderation_case_mismatch");
      }
      const meshId = String(post.get("mesh_id"));
      if (
        moderationCase.exists &&
        String(moderationCase.get("mesh_id")) !== meshId
      ) {
        throw new Error("moderation_case_mismatch");
      }
      if (automated) {
        // The HTTP authority route authenticates the service token before it
        // reaches this repository. Keep a second explicit marker here so a
        // future caller cannot accidentally turn a human action into an
        // unaudited worker mutation.
        if (
          input.actingAccountId !== "moderation-worker" ||
          input.humanSessionHash !== "internal"
        ) {
          throw new Error("moderation_authorization_denied");
        }
      } else {
        await this.assertHumanModerator(
          transaction,
          meshId,
          input.actingAccountId,
          input.humanSessionHash,
          input.updatedAt,
        );
      }
      if (idempotencyRef) {
        const idempotency = await transaction.get(idempotencyRef);
        if (idempotency.exists) {
          if (
            !constantTimeStringEqual(
              String(idempotency.get("request_hash") ?? ""),
              input.requestHash ?? "",
            )
          ) {
            throw new Error("idempotency_conflict");
          }
          if (
            Date.parse(String(idempotency.get("expires_at") ?? "")) <=
            Date.parse(input.updatedAt)
          ) {
            throw new Error("idempotency_expired");
          }
          if (!moderationCase.exists) throw new Error("idempotency_expired");
          const replayCase = this.moderationCaseFromSnapshot(moderationCase);
          const replayPost = this.postFromSnapshot(post);
          const replayReference = idempotency.get("response_body");
          if (
            replayReference &&
            typeof replayReference === "object" &&
            !Array.isArray(replayReference)
          ) {
            this.assertModerationReplayMatches(
              replayReference as Record<string, unknown>,
              replayCase,
              replayPost,
            );
          }
          return {
            duplicate: true,
            moderationCase: replayCase,
            post: replayPost,
          };
        }
      }
      if (automated) {
        const currentState = String(
          post.get("moderation_state") ?? "published",
        );
        const currentUpdatedAt = String(
          post.get("updated_at") ?? post.get("created_at") ?? "",
        );
        if (
          currentState !== automated.expectedPostState ||
          currentUpdatedAt !== automated.expectedPostUpdatedAt ||
          !moderationCase.exists ||
          !["queued", "appealed"].includes(String(moderationCase.get("state")))
        ) {
          throw new Error("moderation_transition_conflict");
        }
      }
      if (
        keyedAction &&
        (!moderationCase.exists ||
          !["queued", "appealed", "reviewing"].includes(
            String(moderationCase.get("state")),
          ))
      ) {
        throw new Error("moderation_transition_conflict");
      }
      if (keyedAction && input.caseState !== "resolved")
        throw new Error("moderation_transition_conflict");
      const currentPost = this.postFromSnapshot(post);
      const activeSiblingQuery =
        keyedAction && input.caseState === "resolved"
          ? this.firestore
              .collection(this.collection("moderation_cases"))
              .where("post_id", "==", input.postId)
          : null;
      const activeSiblingSnapshot = activeSiblingQuery
        ? await transaction.get(activeSiblingQuery)
        : null;
      const supersededSiblings = activeSiblingSnapshot
        ? activeSiblingSnapshot.docs.filter(
            (document) =>
              document.id !== input.caseId &&
              ["queued", "reviewing", "appealed"].includes(
                String(document.get("state")),
              ),
          )
        : [];
      const parent = currentPost.parentPostId
        ? await transaction.get(this.doc("posts", currentPost.parentPostId))
        : null;
      const parentRecord = parent?.exists
        ? this.postFromSnapshot(parent)
        : null;
      const postUpdate: Record<string, unknown> = {
        moderation_state: input.state,
        moderation_reason: input.reason,
        updated_at: input.updatedAt,
      };
      if (input.body !== undefined) postUpdate.body = input.body;
      transaction.update(postRef, postUpdate);
      const currentCase = moderationCase.exists
        ? this.moderationCaseFromSnapshot(moderationCase)
        : null;
      const nextCase: RepositoryModerationCase = {
        ...(currentCase ?? {
          caseId: input.caseId,
          postId: input.postId,
          meshId,
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
      const caseData = {
        contract_version: MESHR_CONTRACT_MAJOR,
        case_id: input.caseId,
        post_id: input.postId,
        mesh_id: meshId,
        reason: nextCase.reason,
        state: nextCase.state,
        severity: nextCase.severity,
        resolution: nextCase.resolution,
        created_at: nextCase.createdAt,
        updated_at: nextCase.updatedAt,
        resolved_at: nextCase.resolvedAt,
        retention_at: moderationRetentionTimestamp(nextCase.createdAt),
      };
      if (moderationCase.exists)
        transaction.set(caseRef, caseData, { merge: true });
      else transaction.create(caseRef, caseData);
      for (const sibling of supersededSiblings) {
        transaction.update(sibling.ref, {
          state: "resolved",
          resolution: "superseded",
          resolved_at: input.updatedAt,
          updated_at: input.updatedAt,
        });
      }
      const artifacts = this.moderationArtifacts(
        input.event,
        input.audit,
        currentPost,
        input.state,
        parentRecord,
      );
      if (supersededSiblings.length > 0) {
        const supersededCaseIds = supersededSiblings
          .slice(0, 64)
          .map((document) => document.id);
        if (artifacts.event) {
          const payload =
            artifacts.event.payload &&
            typeof artifacts.event.payload === "object" &&
            !Array.isArray(artifacts.event.payload)
              ? (artifacts.event.payload as Record<string, unknown>)
              : {};
          artifacts.event = {
            ...artifacts.event,
            payload: {
              ...payload,
              superseded_case_count: supersededSiblings.length,
              superseded_case_ids: supersededCaseIds,
            },
          };
        }
        if (artifacts.audit) {
          const data =
            artifacts.audit.data &&
            typeof artifacts.audit.data === "object" &&
            !Array.isArray(artifacts.audit.data)
              ? (artifacts.audit.data as Record<string, unknown>)
              : {};
          artifacts.audit = {
            ...artifacts.audit,
            data: {
              ...data,
              superseded_case_count: supersededSiblings.length,
              superseded_case_ids: supersededCaseIds,
            },
          };
        }
      }
      this.writeMutationArtifacts(transaction, artifacts);
      if (idempotencyRef) {
        const expiry = new Date(
          Date.parse(input.updatedAt) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
        ).toISOString();
        transaction.create(idempotencyRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          request_hash: input.requestHash,
          response_status: 200,
          response_body: this.moderationIdempotencyResponse(nextCase, {
            ...currentPost,
            body: input.body ?? currentPost.body,
            moderationState: input.state,
            moderationReason: input.reason,
          }),
          created_at: input.updatedAt,
          expires_at: expiry,
          expires_at_ttl: ttlTimestamp(expiry),
        });
      }
      return {
        duplicate: false,
        moderationCase: nextCase,
        post: {
          ...currentPost,
          body: input.body ?? currentPost.body,
          moderationState: input.state,
          moderationReason: input.reason,
        },
      };
    });
  }

  async findPostById(postId: string): Promise<RepositoryPostRecord | null> {
    const snapshot = await this.doc("posts", postId).get();
    if (!snapshot.exists) return null;
    return {
      postId: String(snapshot.get("post_id") ?? snapshot.id),
      meshId: String(snapshot.get("mesh_id")),
      topicId: String(snapshot.get("topic_id")),
      agentId: String(snapshot.get("agent_id")),
      sessionId: String(snapshot.get("session_id") ?? ""),
      parentPostId:
        snapshot.get("parent_post_id") == null
          ? null
          : String(snapshot.get("parent_post_id")),
      body: String(snapshot.get("body") ?? ""),
      moderationState: String(
        snapshot.get("moderation_state") ?? "published",
      ) as RepositoryPostRecord["moderationState"],
      moderationReason:
        snapshot.get("moderation_reason") == null
          ? null
          : String(snapshot.get("moderation_reason")),
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(
        snapshot.get("updated_at") ?? snapshot.get("created_at") ?? this.now(),
      ),
      expiresAt:
        snapshot.get("expires_at") == null
          ? null
          : String(snapshot.get("expires_at")),
    };
  }

  async listPublishedPostsByTopic(input: {
    topicId: string;
    now: string;
    after?: { createdAt: string; id: string };
    limit: number;
  }): Promise<RepositoryTopicPostsPage> {
    const limit = Math.min(Math.max(Math.floor(input.limit), 1), 100);
    // Expired documents can remain briefly while Firestore TTL runs. Scan a
    // bounded number of ordered rows, filtering expiry in-process, so stale
    // TTL rows cannot starve a quiet topic forever or turn a request into an
    // unbounded collection walk.
    const scanBatch = Math.min(Math.max(limit * 3, 50), 500);
    const scanCap = 10_000;
    const nowMs = Date.parse(input.now);
    const latestWindow = !input.after;
    let after = input.after;
    let scanned = 0;
    let exhausted = false;
    const posts: RepositoryPostRecord[] = [];
    let nextAfter: { createdAt: string; id: string } | null = null;
    while (posts.length < limit && scanned < scanCap) {
      let query: Query = this.firestore
        .collection(this.collection("posts"))
        .where("topic_id", "==", input.topicId)
        .where("moderation_state", "==", "published")
        .orderBy("created_at", latestWindow ? "desc" : "asc")
        .orderBy(FieldPath.documentId(), latestWindow ? "desc" : "asc");
      if (after) query = query.startAfter(after.createdAt, after.id);
      const snapshot = await query.limit(scanBatch).get();
      if (!snapshot.docs.length) {
        exhausted = true;
        break;
      }
      let lastScanned: { createdAt: string; id: string } | undefined;
      for (const document of snapshot.docs) {
        const createdAt = String(document.get("created_at") ?? "");
        lastScanned = { createdAt, id: document.id };
        scanned += 1;
        const expiresAt = document.get("expires_at");
        const expiresMs =
          expiresAt == null ? undefined : Date.parse(String(expiresAt));
        if (
          expiresMs !== undefined &&
          Number.isFinite(expiresMs) &&
          expiresMs <= nowMs
        )
          continue;
        posts.push({
          postId: String(document.get("post_id") ?? document.id),
          meshId: String(document.get("mesh_id") ?? ""),
          topicId: String(document.get("topic_id") ?? input.topicId),
          agentId: String(document.get("agent_id") ?? ""),
          sessionId: String(document.get("session_id") ?? ""),
          parentPostId:
            document.get("parent_post_id") == null
              ? null
              : String(document.get("parent_post_id")),
          body: String(document.get("body") ?? ""),
          moderationState: "published",
          moderationReason:
            document.get("moderation_reason") == null
              ? null
              : String(document.get("moderation_reason")),
          createdAt,
          expiresAt: expiresAt == null ? null : String(expiresAt),
        });
        if (posts.length >= limit) {
          nextAfter = lastScanned;
          break;
        }
      }
      if (posts.length >= limit) break;
      if (snapshot.docs.length < scanBatch || !lastScanned) {
        exhausted = true;
        break;
      }
      after = lastScanned;
    }
    if (!nextAfter && !exhausted && after) nextAfter = after;
    const agentIds = [
      ...new Set(posts.map((post) => post.agentId).filter(Boolean)),
    ];
    const agentDocs = agentIds.length
      ? await this.firestore.getAll(
          ...agentIds.map((agentId) => this.doc("agents", agentId)),
        )
      : [];
    const orderedPosts = latestWindow ? posts.reverse() : posts;
    const newest = orderedPosts.at(-1);
    return {
      posts: orderedPosts,
      // A cursorless call is a latest-window read, but it still exposes the
      // newest returned row as a forward cursor. Hosts can then observe posts
      // appended while the initial page was in flight without replaying the
      // whole window.
      nextAfter: latestWindow
        ? newest
          ? { createdAt: newest.createdAt, id: newest.postId }
          : null
        : posts.length >= limit
          ? nextAfter
          : exhausted
            ? null
            : nextAfter,
      agents: agentDocs
        .filter((document) => document.exists)
        .map((document) => this.agentFromSnapshot(document)),
    };
  }

  async findTopicById(topicId: string): Promise<RepositoryTopicInput | null> {
    const snapshot = await this.doc("topics", topicId).get();
    if (!snapshot.exists) return null;
    const tags = snapshot.get("tags") ?? snapshot.get("tags_json") ?? [];
    return {
      topicId: String(snapshot.get("topic_id") ?? snapshot.id),
      meshId: String(snapshot.get("mesh_id")),
      name: String(snapshot.get("name") ?? ""),
      title: String(snapshot.get("title") ?? snapshot.get("name") ?? ""),
      description: String(snapshot.get("description") ?? ""),
      tags: Array.isArray(tags) ? tags.map(String) : [],
      createdAt: String(snapshot.get("created_at") ?? this.now()),
    };
  }

  async listTopicsForAgent(
    meshId: string,
    agentId: string,
  ): Promise<RepositoryAgentTopic[]> {
    // This is deliberately mesh-scoped. The agent topic route is a hot read
    // path and must not hydrate the account-wide projection (or its post
    // bodies) merely to render topic names and follow state.
    const [mesh, agent, membership, topics] = await Promise.all([
      this.doc("meshes", meshId).get(),
      this.doc("agents", agentId).get(),
      this.doc("mesh_agent_memberships", `${meshId}:${agentId}`).get(),
      this.firestore
        .collection(this.collection("topics"))
        .where("mesh_id", "==", meshId)
        .limit(MAX_TOPICS_PER_MESH)
        .get(),
    ]);
    if (!mesh.exists || mesh.get("lifecycle") !== "active")
      throw new Error("mesh_not_found");
    if (!agent.exists) throw new Error("agent_not_found");
    const joined = membership.exists && membership.get("status") === "joined";
    const visibility = String(mesh.get("visibility") ?? "private");
    if (visibility !== "public" && !joined)
      throw new Error("mesh_access_denied");
    const attention = agent.get("attention_policy");
    const browse =
      attention && typeof attention === "object" && !Array.isArray(attention)
        ? String((attention as Record<string, unknown>).browse ?? "")
        : "";
    if (browse !== "public" && browse !== "joined")
      throw new Error("attention_policy_denied");
    if (browse === "joined" && !joined)
      throw new Error("attention_policy_denied");
    const topicRows: RepositoryAgentTopic[] = topics.docs.map((document) => {
      const tags = document.get("tags") ?? document.get("tags_json") ?? [];
      let normalizedTags: string[] = [];
      if (Array.isArray(tags)) normalizedTags = tags.map(String);
      else if (typeof tags === "string") {
        try {
          const parsed = JSON.parse(tags) as unknown;
          if (Array.isArray(parsed)) normalizedTags = parsed.map(String);
        } catch {
          normalizedTags = [];
        }
      }
      return {
        topic: {
          topicId: String(document.get("topic_id") ?? document.id),
          meshId: String(document.get("mesh_id") ?? meshId),
          name: String(document.get("name") ?? ""),
          title: String(document.get("title") ?? document.get("name") ?? ""),
          description: String(document.get("description") ?? ""),
          tags: normalizedTags,
          createdAt: String(document.get("created_at") ?? this.now()),
        },
        followed: false,
      };
    });
    if (topicRows.length) {
      // A mesh contains at most MAX_TOPICS_PER_MESH topics, and follow ids are
      // deterministic. Point-read only those rows instead of scanning an
      // agent's global follows, whose cardinality grows with every joined
      // mesh and could both overcharge and truncate the follow flags.
      const follows = await this.firestore.getAll(
        ...topicRows.map(({ topic }) =>
          this.doc("follows", `${topic.topicId}:${agentId}`),
        ),
      );
      const followedIds = new Set(
        follows
          .filter(
            (document) =>
              document.exists &&
              document.get("agent_id") === agentId &&
              document.get("following") === true,
          )
          .map((document) => String(document.get("topic_id") ?? "")),
      );
      for (const row of topicRows)
        row.followed = followedIds.has(row.topic.topicId);
    }
    return topicRows.sort(
      (left, right) =>
        left.topic.title.localeCompare(right.topic.title) ||
        left.topic.topicId.localeCompare(right.topic.topicId),
    );
  }

  async listPublicMeshes(): Promise<RepositoryPublicMeshDirectory> {
    const snapshot = await this.firestore
      .collection(this.collection("meshes"))
      .where("visibility", "==", "public")
      .where("lifecycle", "==", "active")
      .limit(MAX_MESH_DIRECTORY_ENTRIES + 1)
      .get();
    const initial = snapshot.docs
      .map((document) => this.meshDirectoryMesh(document))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.meshId.localeCompare(right.meshId),
      )
      .slice(0, MAX_MESH_DIRECTORY_ENTRIES);
    // A public-to-private transition may race the broad directory query. A
    // terminal public query prevents an unauthenticated response from
    // returning a stale private mesh entry.
    const finalSnapshot = await this.firestore
      .collection(this.collection("meshes"))
      .where("visibility", "==", "public")
      .where("lifecycle", "==", "active")
      .limit(MAX_MESH_DIRECTORY_ENTRIES + 1)
      .get();
    const finalPublicIds = new Set(
      finalSnapshot.docs.map((document) =>
        String(document.get("mesh_id") ?? document.id),
      ),
    );
    return {
      meshes: initial.filter((mesh) => finalPublicIds.has(mesh.meshId)),
      truncated:
        snapshot.size > MAX_MESH_DIRECTORY_ENTRIES ||
        finalSnapshot.size > MAX_MESH_DIRECTORY_ENTRIES,
    };
  }

  async listPublicTopics(
    meshId: string,
  ): Promise<RepositoryPublicTopicDirectory> {
    const mesh = await this.doc("meshes", meshId).get();
    if (
      !mesh.exists ||
      mesh.get("lifecycle") !== "active" ||
      mesh.get("visibility") !== "public"
    ) {
      throw new Error("mesh_not_found");
    }
    const snapshot = await this.firestore
      .collection(this.collection("topics"))
      .where("mesh_id", "==", meshId)
      .limit(MAX_TOPICS_PER_MESH + 1)
      .get();
    // A public-to-private transition may race the topic query. Re-read the
    // mesh at the response boundary so an unauthenticated directory request
    // cannot return one stale private topic page.
    const finalMesh = await this.doc("meshes", meshId).get();
    if (
      !finalMesh.exists ||
      finalMesh.get("lifecycle") !== "active" ||
      finalMesh.get("visibility") !== "public"
    ) {
      throw new Error("mesh_not_found");
    }
    const topics = snapshot.docs
      .map((document) => {
        const tags = document.get("tags") ?? document.get("tags_json") ?? [];
        let normalizedTags: string[] = [];
        if (Array.isArray(tags)) normalizedTags = tags.map(String);
        else if (typeof tags === "string") {
          try {
            const parsed = JSON.parse(tags) as unknown;
            if (Array.isArray(parsed)) normalizedTags = parsed.map(String);
          } catch {
            normalizedTags = [];
          }
        }
        return {
          topicId: String(document.get("topic_id") ?? document.id),
          meshId,
          name: String(document.get("name") ?? ""),
          title: String(document.get("title") ?? document.get("name") ?? ""),
          description: String(document.get("description") ?? ""),
          tags: normalizedTags,
          createdAt: String(document.get("created_at") ?? this.now()),
        };
      })
      .sort(
        (left, right) =>
          left.title.localeCompare(right.title) ||
          left.topicId.localeCompare(right.topicId),
      )
      .slice(0, MAX_TOPICS_PER_MESH);
    return {
      topics,
      truncated: snapshot.size > MAX_TOPICS_PER_MESH,
    };
  }

  async upsertMesh(
    input: RepositoryMeshInput & RepositoryMutationArtifacts,
  ): Promise<void> {
    const meshRef = this.doc("meshes", input.meshId);
    await this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(meshRef);
      if (input.actingAccountId) {
        await this.assertHumanSession(
          transaction,
          input.actingAccountId,
          input.humanSessionHash,
          input.updatedAt,
        );
        if (
          !input.ownerAccountId ||
          (!existing.exists && input.actingAccountId !== input.ownerAccountId)
        ) {
          throw new Error("mesh_governance_denied");
        }
        const actorRole = await transaction.get(
          this.doc(
            "mesh_human_roles",
            `${input.meshId}:${input.actingAccountId}`,
          ),
        );
        if (
          existing.exists &&
          (!actorRole.exists || actorRole.get("role") !== "owner")
        ) {
          throw new Error("mesh_governance_denied");
        }
      }
      if (!existing.exists && input.ownerAccountId) {
        const ownedMeshes = await transaction.get(
          this.firestore
            .collection(this.collection("meshes"))
            .where("owner_account_id", "==", input.ownerAccountId)
            .limit(11),
        );
        if (ownedMeshes.size >= 10) throw new Error("mesh_limit_reached");
      }
      transaction.set(
        meshRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          mesh_id: input.meshId,
          owner_account_id: input.ownerAccountId,
          name: input.name,
          description: input.description,
          visibility: input.visibility,
          admission: input.admission,
          lifecycle: input.lifecycle,
          created_at: existing.exists
            ? existing.get("created_at")
            : input.createdAt,
          updated_at: input.updatedAt,
        },
        { merge: true },
      );
      this.writeMutationArtifacts(transaction, input);
    });
  }

  async updateMeshGovernance(
    input: RepositoryMeshGovernancePatch,
  ): Promise<RepositoryMeshInput> {
    const meshRef = this.doc("meshes", input.meshId);
    return this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(meshRef);
      if (!existing.exists) throw new Error("mesh_not_found");
      await this.assertHumanRole(
        transaction,
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner"],
        input.updatedAt,
      );
      const current: RepositoryMeshInput = {
        meshId: input.meshId,
        ownerAccountId:
          existing.get("owner_account_id") == null
            ? null
            : String(existing.get("owner_account_id")),
        name: String(existing.get("name") ?? ""),
        description: String(existing.get("description") ?? ""),
        visibility: String(
          existing.get("visibility") ?? "private",
        ) as RepositoryMeshInput["visibility"],
        admission: String(
          existing.get("admission") ?? "invite_only",
        ) as RepositoryMeshInput["admission"],
        lifecycle: String(
          existing.get("lifecycle") ?? "active",
        ) as RepositoryMeshInput["lifecycle"],
        createdAt: String(existing.get("created_at") ?? input.updatedAt),
        updatedAt: String(existing.get("updated_at") ?? input.updatedAt),
      };
      const changed =
        (input.name !== undefined && input.name !== current.name) ||
        (input.description !== undefined &&
          input.description !== current.description) ||
        (input.visibility !== undefined &&
          input.visibility !== current.visibility) ||
        (input.admission !== undefined &&
          input.admission !== current.admission);
      if (!changed) return current;
      const next: RepositoryMeshInput = {
        ...current,
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        visibility: input.visibility ?? current.visibility,
        admission: input.admission ?? current.admission,
        updatedAt: input.updatedAt,
      };
      transaction.set(
        meshRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          mesh_id: next.meshId,
          owner_account_id: next.ownerAccountId,
          name: next.name,
          description: next.description,
          visibility: next.visibility,
          admission: next.admission,
          lifecycle: next.lifecycle,
          created_at: current.createdAt,
          updated_at: next.updatedAt,
        },
        { merge: true },
      );
      this.writeMutationArtifacts(transaction, input);
      return next;
    });
  }

  async createMeshWithOwner(
    input: {
      mesh: RepositoryMeshInput;
      topic: RepositoryTopicInput;
      agentIds: string[];
      idempotencyKey?: string;
      requestHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<{ duplicate: boolean }> {
    const { mesh, topic } = input;
    const agentIds = [...new Set(input.agentIds)];
    const result = await this.firestore.runTransaction(async (transaction) => {
      const meshRef = this.doc("meshes", mesh.meshId);
      const topicRef = this.doc("topics", topic.topicId);
      const roleRef = this.doc(
        "mesh_human_roles",
        `${mesh.meshId}:${mesh.ownerAccountId}`,
      );
      const existingMesh = await transaction.get(meshRef);
      const existingTopic = existingMesh.exists
        ? await transaction.get(topicRef)
        : null;
      const existingMemberships = existingMesh.exists
        ? await transaction.get(
            this.firestore
              .collection(this.collection("mesh_agent_memberships"))
              .where("mesh_id", "==", mesh.meshId)
              .where("status", "==", "joined")
              .limit(101),
          )
        : null;
      if (existingMesh.exists) {
        const existingAgentIds =
          existingMemberships?.docs
            .map((document) => String(document.get("agent_id")))
            .sort() ?? [];
        const requestedAgentIds = [...agentIds].sort();
        const matches =
          input.idempotencyKey &&
          existingTopic?.exists &&
          String(existingMesh.get("owner_account_id")) ===
            mesh.ownerAccountId &&
          String(existingMesh.get("name")) === mesh.name &&
          String(existingMesh.get("description")) === mesh.description &&
          String(existingMesh.get("visibility")) === mesh.visibility &&
          String(existingMesh.get("admission")) === mesh.admission &&
          existingAgentIds.length === requestedAgentIds.length &&
          existingAgentIds.every(
            (agentId, index) => agentId === requestedAgentIds[index],
          );
        if (matches) return { duplicate: true };
        throw new Error(
          input.idempotencyKey ? "idempotency_conflict" : "mesh_already_exists",
        );
      }
      if (!mesh.ownerAccountId) throw new Error("owner_required");
      await this.assertHumanSession(
        transaction,
        mesh.actingAccountId,
        mesh.humanSessionHash,
        mesh.updatedAt,
      );
      if (mesh.actingAccountId !== mesh.ownerAccountId)
        throw new Error("mesh_governance_denied");
      const owner = await transaction.get(
        this.doc("accounts", mesh.ownerAccountId),
      );
      if (!owner.exists) throw new Error("account_not_found");
      const ownedMeshes = await transaction.get(
        this.firestore
          .collection(this.collection("meshes"))
          .where("owner_account_id", "==", mesh.ownerAccountId)
          .limit(11),
      );
      if (ownedMeshes.size >= 10) throw new Error("mesh_limit_reached");
      const agentRefs = agentIds.map((agentId) => this.doc("agents", agentId));
      const agents = agentRefs.length
        ? await transaction.getAll(...agentRefs)
        : [];
      if (
        agents.some(
          (agent) =>
            !agent.exists ||
            agent.get("owner_account_id") !== mesh.ownerAccountId,
        )
      ) {
        throw new Error("agent_access_denied");
      }
      const joinedCounts = await Promise.all(
        agentIds.map(async (agentId) =>
          transaction.get(
            this.firestore
              .collection(this.collection("mesh_agent_memberships"))
              .where("agent_id", "==", agentId)
              .where("status", "==", "joined")
              .limit(101),
          ),
        ),
      );
      if (joinedCounts.some((snapshot) => snapshot.size >= 100)) {
        throw new Error("agent_mesh_limit_reached");
      }
      const now = mesh.createdAt;
      transaction.create(meshRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        mesh_id: mesh.meshId,
        owner_account_id: mesh.ownerAccountId,
        name: mesh.name,
        description: mesh.description,
        visibility: mesh.visibility,
        admission: mesh.admission,
        lifecycle: mesh.lifecycle,
        created_at: now,
        updated_at: mesh.updatedAt,
      });
      transaction.create(topicRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        topic_id: topic.topicId,
        mesh_id: topic.meshId,
        name: topic.name,
        title: topic.title,
        description: topic.description,
        tags: topic.tags,
        created_at: topic.createdAt,
      });
      transaction.create(roleRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        mesh_id: mesh.meshId,
        account_id: mesh.ownerAccountId,
        role: "owner",
        created_at: now,
        updated_at: mesh.updatedAt,
      });
      for (let index = 0; index < agentIds.length; index += 1) {
        const agentId = agentIds[index]!;
        const agent = agents[index]!;
        transaction.create(
          this.doc("mesh_agent_memberships", `${mesh.meshId}:${agentId}`),
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            mesh_id: mesh.meshId,
            agent_id: agentId,
            status: "joined",
            attention_policy: agent.get("attention_policy") ?? {},
            admission_provenance: "invite",
            joined_at: now,
            updated_at: mesh.updatedAt,
          },
        );
      }
      this.writeMutationArtifacts(transaction, input);
      return { duplicate: false };
    });
    return result;
  }

  async upsertTopic(input: RepositoryTopicInput): Promise<void> {
    await this.doc("topics", input.topicId).set(
      {
        contract_version: MESHR_CONTRACT_MAJOR,
        topic_id: input.topicId,
        mesh_id: input.meshId,
        name: input.name,
        title: input.title,
        description: input.description,
        tags: input.tags,
        created_at: input.createdAt,
      },
      { merge: true },
    );
  }

  async consumeGovernanceRateLimit(input: {
    accountId: string;
    bucket: string;
    now: string;
    capacity: number;
    refillPerSecond: number;
  }): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    if (
      !input.accountId ||
      !input.bucket ||
      input.capacity <= 0 ||
      input.refillPerSecond <= 0
    ) {
      throw new Error("invalid_governance_rate_limit");
    }
    const nowMs = Date.parse(input.now);
    if (!Number.isFinite(nowMs))
      throw new Error("invalid_governance_rate_limit");
    const ref = this.doc(
      "quota_counters",
      `governance:${input.bucket}:${input.accountId}`,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const previousTokens = snapshot.exists
        ? Number(snapshot.get("tokens") ?? input.capacity)
        : input.capacity;
      const previousRefillMs = snapshot.exists
        ? Number(snapshot.get("last_refill_ms") ?? nowMs)
        : nowMs;
      const elapsedSeconds = Math.max(0, (nowMs - previousRefillMs) / 1_000);
      const available = Math.min(
        input.capacity,
        (Number.isFinite(previousTokens) ? previousTokens : input.capacity) +
          elapsedSeconds * input.refillPerSecond,
      );
      if (available < 1) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((1 - available) / input.refillPerSecond),
          ),
        };
      }
      transaction.set(
        ref,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          bucket: `governance:${input.bucket}:${input.accountId}`,
          tokens: available - 1,
          last_refill_ms: nowMs,
          updated_at: input.now,
          expires_at_ttl: quotaExpiryTimestamp(input.now),
        },
        { merge: true },
      );
      return { allowed: true, retryAfterSeconds: 0 };
    });
  }

  async createTopic(
    input: RepositoryTopicCreateInput & RepositoryMutationArtifacts,
  ): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const meshRef = this.doc("meshes", input.meshId);
      const topicRef = this.doc("topics", input.topicId);
      const mesh = await transaction.get(meshRef);
      if (!mesh.exists || mesh.get("lifecycle") !== "active")
        throw new Error("mesh_not_found");
      await this.assertHumanRole(
        transaction,
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.createdAt,
      );
      const [existingTopic, sameName] = await Promise.all([
        transaction.get(topicRef),
        transaction.get(
          this.firestore
            .collection(this.collection("topics"))
            .where("mesh_id", "==", input.meshId)
            .where("name", "==", input.name)
            .limit(1),
        ),
      ]);
      if (existingTopic.exists) throw new Error("topic_already_exists");
      const topicCount = await transaction.get(
        this.firestore
          .collection(this.collection("topics"))
          .where("mesh_id", "==", input.meshId)
          .limit(MAX_TOPICS_PER_MESH + 1),
      );
      if (topicCount.size >= MAX_TOPICS_PER_MESH) {
        throw new Error("topic_limit_reached");
      }
      if (sameName.docs.some((document) => document.id !== input.topicId)) {
        throw new Error("topic_name_taken");
      }
      transaction.create(topicRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        topic_id: input.topicId,
        mesh_id: input.meshId,
        name: input.name,
        title: input.title,
        description: input.description,
        tags: input.tags,
        created_at: input.createdAt,
        updated_at: input.createdAt,
      });
      this.writeMutationArtifacts(transaction, input);
    });
  }

  async updateTopic(
    input: RepositoryTopicUpdateInput & RepositoryMutationArtifacts,
  ): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const meshRef = this.doc("meshes", input.meshId);
      const topicRef = this.doc("topics", input.topicId);
      const mesh = await transaction.get(meshRef);
      if (!mesh.exists || mesh.get("lifecycle") !== "active")
        throw new Error("mesh_not_found");
      await this.assertHumanRole(
        transaction,
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.updatedAt,
      );
      const existingTopic = await transaction.get(topicRef);
      if (
        !existingTopic.exists ||
        String(existingTopic.get("mesh_id")) !== input.meshId
      ) {
        throw new Error("topic_not_found");
      }
      const sameName = await transaction.get(
        this.firestore
          .collection(this.collection("topics"))
          .where("mesh_id", "==", input.meshId)
          .where("name", "==", input.name)
          .limit(2),
      );
      if (sameName.docs.some((document) => document.id !== input.topicId)) {
        throw new Error("topic_name_taken");
      }
      transaction.update(topicRef, {
        name: input.name,
        title: input.title,
        description: input.description,
        tags: input.tags,
        updated_at: input.updatedAt,
      });
      this.writeMutationArtifacts(transaction, input);
    });
  }

  async deleteTopic(
    input: RepositoryTopicDeleteInput & RepositoryMutationArtifacts,
  ): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const meshRef = this.doc("meshes", input.meshId);
      const topicRef = this.doc("topics", input.topicId);
      const mesh = await transaction.get(meshRef);
      if (!mesh.exists || mesh.get("lifecycle") !== "active")
        throw new Error("mesh_not_found");
      await this.assertHumanRole(
        transaction,
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.deletedAt,
      );
      const existingTopic = await transaction.get(topicRef);
      if (
        !existingTopic.exists ||
        String(existingTopic.get("mesh_id")) !== input.meshId
      ) {
        throw new Error("topic_not_found");
      }
      const posts = await transaction.get(
        this.firestore
          .collection(this.collection("posts"))
          .where("topic_id", "==", input.topicId)
          .limit(1),
      );
      const remainingTopics = await transaction.get(
        this.firestore
          .collection(this.collection("topics"))
          .where("mesh_id", "==", input.meshId)
          .limit(2),
      );
      if (remainingTopics.size <= 1) throw new Error("last_topic");
      // Retained posts are immutable social history. Do not permit a topic
      // delete to orphan or silently erase them; archive/remove the topic in
      // a future lifecycle command instead.
      if (!posts.empty) throw new Error("topic_not_empty");
      // Follow documents are derived intent, not retained social history. Do
      // not read or delete them in this transaction: a popular topic may have
      // thousands of followers and Firestore transactions are capped at 500
      // writes. The follow mutation accepts an explicit unsubscribe for a
      // deleted topic, allowing stale records to be cleaned without exposing
      // the topic again; the retention worker can also sweep orphan follows.
      transaction.delete(topicRef);
      this.writeMutationArtifacts(transaction, input);
    });
  }

  async upsertMeshHumanRole(
    input: {
      meshId: string;
      accountId: string;
      role: "owner" | "steward" | "observer";
      createdAt: string;
      updatedAt: string;
      actingAccountId?: string;
      humanSessionHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const roleRef = this.doc(
        "mesh_human_roles",
        input.meshId + ":" + input.accountId,
      );
      const meshRef = this.doc("meshes", input.meshId);
      const mesh = await transaction.get(meshRef);
      if (!mesh.exists) throw new Error("mesh_not_found");
      const existing = await transaction.get(roleRef);
      if (input.actingAccountId) {
        await this.assertHumanRole(
          transaction,
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          ["owner"],
          input.updatedAt,
        );
      }
      // A human-authorized role mutation may update an existing assignment,
      // but it may not create a membership. Creation requires the separate
      // one-use invitation and recipient acceptance flow.
      if (input.actingAccountId && !existing.exists) {
        throw new Error("role_invitation_required");
      }
      if (
        existing.exists &&
        existing.get("role") === "owner" &&
        input.role !== "owner"
      ) {
        const owners = await transaction.get(
          this.firestore
            .collection(this.collection("mesh_human_roles"))
            .where("mesh_id", "==", input.meshId)
            .where("role", "==", "owner"),
        );
        if (owners.size <= 1) throw new Error("last_owner");
        if (mesh.get("owner_account_id") === input.accountId) {
          const replacement = owners.docs
            .map((document) => String(document.get("account_id")))
            .filter((accountId) => accountId !== input.accountId)
            .sort()[0];
          if (!replacement) throw new Error("last_owner");
          transaction.update(meshRef, {
            owner_account_id: replacement,
            updated_at: input.updatedAt,
          });
        }
      } else if (input.role === "owner") {
        // Ownership transfer is only valid for an existing mesh member. The
        // email-based collaborator endpoint deliberately cannot mint a new
        // owner role for an unrelated account.
        if (!existing.exists) throw new Error("owner_transfer_requires_member");
        if (!existing.exists || existing.get("role") !== "owner") {
          const ownedMeshes = await transaction.get(
            this.firestore
              .collection(this.collection("mesh_human_roles"))
              .where("account_id", "==", input.accountId)
              .where("role", "==", "owner")
              .limit(11),
          );
          if (ownedMeshes.size >= 10) throw new Error("mesh_limit_reached");
        }
        // Setting an owner role is an explicit ownership transfer. Demote the
        // previous canonical owner in the same transaction so a collaborator
        // cannot accumulate owner roles while the mesh's display field moves.
        const previousOwnerId = mesh.get("owner_account_id");
        if (previousOwnerId && previousOwnerId !== input.accountId) {
          const previousOwnerRef = this.doc(
            "mesh_human_roles",
            `${input.meshId}:${String(previousOwnerId)}`,
          );
          const previousOwner = await transaction.get(previousOwnerRef);
          if (previousOwner.exists && previousOwner.get("role") === "owner") {
            transaction.set(
              previousOwnerRef,
              { role: "steward", updated_at: input.updatedAt },
              { merge: true },
            );
          }
        }
        transaction.update(meshRef, {
          owner_account_id: input.accountId,
          updated_at: input.updatedAt,
        });
      }
      transaction.set(roleRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        mesh_id: input.meshId,
        account_id: input.accountId,
        role: input.role,
        created_at: existing.exists
          ? existing.get("created_at")
          : input.createdAt,
        updated_at: input.updatedAt,
      });
      this.writeMutationArtifacts(transaction, input);
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
    await this.firestore.runTransaction(async (transaction) => {
      const roleRef = this.doc("mesh_human_roles", meshId + ":" + accountId);
      const meshRef = this.doc("meshes", meshId);
      const mesh = await transaction.get(meshRef);
      const existing = await transaction.get(roleRef);
      if (!existing.exists) return;
      if (actingAccountId) {
        await this.assertHumanRole(
          transaction,
          meshId,
          actingAccountId,
          humanSessionHash,
          ["owner"],
        );
      }
      if (existing.get("role") === "owner") {
        const owners = await transaction.get(
          this.firestore
            .collection(this.collection("mesh_human_roles"))
            .where("mesh_id", "==", meshId)
            .where("role", "==", "owner"),
        );
        if (owners.size <= 1) throw new Error("last_owner");
        if (mesh.exists && mesh.get("owner_account_id") === accountId) {
          const replacement = owners.docs
            .map((document) => String(document.get("account_id")))
            .filter((candidate) => candidate !== accountId)
            .sort()[0];
          if (!replacement) throw new Error("last_owner");
          transaction.update(meshRef, {
            owner_account_id: replacement,
            updated_at: this.now(),
          });
        }
      }
      transaction.delete(roleRef);
      this.writeMutationArtifacts(transaction, { event, audit });
    });
  }

  async upsertMeshAgentMembership(
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
  ): Promise<{ changed: boolean }> {
    const membershipRef = this.doc(
      "mesh_agent_memberships",
      input.meshId + ":" + input.agentId,
    );
    return this.firestore.runTransaction(async (transaction) => {
      const [existing, mesh, agent] = await Promise.all([
        transaction.get(membershipRef),
        transaction.get(this.doc("meshes", input.meshId)),
        transaction.get(this.doc("agents", input.agentId)),
      ]);
      if (!mesh.exists) throw new Error("mesh_not_found");
      if (input.actingAccountId) {
        await this.assertHumanRole(
          transaction,
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          ["owner", "steward"],
          input.updatedAt,
        );
      }
      if (
        input.status === "removed" &&
        (!existing.exists ||
          !["joined", "pending"].includes(String(existing.get("status"))))
      ) {
        return { changed: false };
      }
      if (!agent.exists) throw new Error("agent_not_found");
      if (input.status === "removed") {
        transaction.update(membershipRef, {
          status: "removed",
          updated_at: input.updatedAt,
        });
        this.writeMutationArtifacts(transaction, input);
        return { changed: true };
      }
      if (
        input.status === "joined" &&
        (!existing.exists || existing.get("status") !== "joined")
      ) {
        const joined = await transaction.get(
          this.firestore
            .collection(this.collection("mesh_agent_memberships"))
            .where("agent_id", "==", input.agentId)
            .where("status", "==", "joined")
            .limit(101),
        );
        if (joined.size >= 100) throw new Error("agent_mesh_limit_reached");
      }
      transaction.set(
        membershipRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          mesh_id: input.meshId,
          agent_id: input.agentId,
          status: input.status,
          attention_policy: input.attentionPolicy,
          admission_provenance: input.admissionProvenance,
          joined_at:
            existing.exists && existing.get("joined_at") != null
              ? existing.get("joined_at")
              : input.joinedAt,
          updated_at: input.updatedAt,
        },
        { merge: true },
      );
      this.writeMutationArtifacts(transaction, input);
      return { changed: true };
    });
  }

  async joinMeshForAgent(input: {
    meshId: string;
    agentId: string;
    ownerAccountId: string;
    sessionId: string;
    authorityEpoch: number;
    runtimeKind: RuntimeKind;
    authorityKind?: "native" | "page";
    grantId?: string;
    humanSessionHash?: string;
    idempotencyKey: string;
    requestId: string;
    requestedAt: string;
    invitationTokenHash?: string;
  }): Promise<{
    status: "joined" | "pending";
    requestId?: string;
    duplicate: boolean;
  }> {
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          meshId: input.meshId,
          invitationTokenHash: input.invitationTokenHash ?? null,
        }),
      )
      .digest("hex");
    const idempotencyRef = this.doc(
      "idempotency",
      `${input.agentId}:mesh.join:${input.idempotencyKey}`,
    );
    const meshRef = this.doc("meshes", input.meshId);
    const membershipRef = this.doc(
      "mesh_agent_memberships",
      `${input.meshId}:${input.agentId}`,
    );
    const requestRef = this.doc("mesh_join_requests", input.requestId);
    const invitationQuery = input.invitationTokenHash
      ? this.firestore
          .collection(this.collection("mesh_invitations"))
          .where("token_hash", "==", input.invitationTokenHash)
          .limit(1)
      : null;
    const authorityRef = this.authorityRef(input.agentId);
    const authorityKind = input.authorityKind ?? "native";
    if (
      authorityKind === "page" &&
      (!input.grantId || !input.humanSessionHash)
    ) {
      throw new Error("session_invalid");
    }
    const sessionRef = authorityKind === "page"
      ? this.doc("webmcp_grants", input.grantId!)
      : this.doc("runtime_sessions", input.sessionId);
    const humanSessionRef = authorityKind === "page"
      ? this.doc("human_sessions", input.humanSessionHash!)
      : null;
    const pageFenceRef = authorityKind === "page"
      ? this.webMcpAuthorityRef(input.humanSessionHash!)
      : null;
    const now = input.requestedAt;
    if (!Number.isFinite(Date.parse(now)))
      throw new Error("invalid_request_timestamp");

    return this.firestore.runTransaction(async (transaction) => {
      const [
        existingIdempotency,
        authority,
        session,
        mesh,
        agent,
        membership,
        pendingRequests,
        invitationCandidates,
        humanSession,
        pageFence,
      ] = await Promise.all([
        transaction.get(idempotencyRef),
        transaction.get(authorityRef),
        transaction.get(sessionRef),
        transaction.get(meshRef),
        transaction.get(this.doc("agents", input.agentId)),
        transaction.get(membershipRef),
        transaction.get(
          this.firestore
            .collection(this.collection("mesh_join_requests"))
            .where("mesh_id", "==", input.meshId)
            .where("agent_id", "==", input.agentId)
            .where("status", "==", "pending")
            .limit(1),
        ),
        invitationQuery
          ? transaction.get(invitationQuery)
          : Promise.resolve(null),
        humanSessionRef
          ? transaction.get(humanSessionRef)
          : Promise.resolve(null),
        pageFenceRef
          ? transaction.get(pageFenceRef)
          : Promise.resolve(null),
      ]);

      if (
        !authority.exists ||
        authority.get("authority_kind") !== authorityKind ||
        authority.get("session_id") !== input.sessionId ||
        Number(authority.get("epoch") ?? -1) !== input.authorityEpoch
      ) {
        throw new Error("session_superseded");
      }
      if (authorityKind === "page") {
        if (
          !session.exists ||
          session.get("revoked_at") != null ||
          session.get("human_session_hash") !== input.humanSessionHash ||
          session.get("agent_id") !== input.agentId ||
          session.get("session_id") !== input.sessionId ||
          Number(session.get("authority_epoch") ?? -1) !== input.authorityEpoch ||
          Date.parse(String(session.get("expires_at") ?? "")) <= Date.parse(now) ||
          !humanSession ||
          !humanSession.exists ||
          humanSession.get("account_id") !== input.ownerAccountId ||
          Date.parse(String(humanSession.get("expires_at") ?? "")) <= Date.parse(now) ||
          Date.parse(String(humanSession.get("absolute_expires_at") ?? "")) <= Date.parse(now) ||
          Date.parse(String(humanSession.get("last_seen_at") ?? "")) <=
            Date.parse(now) - HUMAN_IDLE_SECONDS * 1_000 ||
          !pageFence ||
          !pageFence.exists ||
          pageFence.get("grant_id") !== input.grantId ||
          pageFence.get("agent_id") !== input.agentId ||
          pageFence.get("session_id") !== input.sessionId ||
          Number(pageFence.get("epoch") ?? -1) !== input.authorityEpoch ||
          pageFence.get("revoked_at") != null
        ) {
          throw new Error("session_invalid");
        }
      } else if (
        !session.exists ||
        session.get("status") !== "active" ||
        session.get("agent_id") !== input.agentId ||
        Number(session.get("authority_epoch") ?? -1) !== input.authorityEpoch ||
        Date.parse(String(session.get("expires_at") ?? "")) <= Date.parse(now) ||
        Date.parse(String(session.get("last_seen_at") ?? "")) < Date.parse(now) - 90 * 1_000
      ) {
        throw new Error("session_invalid");
      }
      if (!mesh.exists) throw new Error("mesh_not_found");
      if (mesh.get("lifecycle") !== "active")
        throw new Error("mesh_unavailable");
      if (!agent.exists) throw new Error("agent_not_found");
      if (String(agent.get("owner_account_id")) !== input.ownerAccountId) {
        throw new Error("agent_access_denied");
      }
      // Browse policy is durable agent authority. Recheck it in the same
      // transaction as admission so a stale API replica cannot race an owner
      // tightening the profile to mention-only. This check deliberately
      // precedes idempotency replay: old accepted responses do not restore
      // authority that has since been withdrawn.
      const durableAttention = requireJoinCapableAttentionPolicy(
        agent.get("attention_policy"),
      );

      // Authentication and current authority are deliberately checked before
      // replaying an idempotency record. A token captured before a session
      // supersession must not regain even a previously accepted response.
      if (existingIdempotency.exists) {
        const expiresAt = String(existingIdempotency.get("expires_at") ?? "");
        if (expiresAt && Date.parse(expiresAt) <= Date.parse(now)) {
          throw new Error("idempotency_expired");
        }
        if (
          String(existingIdempotency.get("request_hash") ?? "") !== requestHash
        ) {
          throw new Error("idempotency_conflict");
        }
        const body = existingIdempotency.get("response_body");
        const status =
          String(existingIdempotency.get("response_status")) === "pending"
            ? "pending"
            : "joined";
        return {
          status,
          ...(status === "pending"
            ? {
                requestId:
                  typeof body === "object" && body && "requestId" in body
                    ? String((body as Record<string, unknown>).requestId)
                    : input.requestId,
              }
            : {}),
          duplicate: true,
        };
      }

      const currentMembershipStatus = membership.exists
        ? String(membership.get("status"))
        : null;
      if (currentMembershipStatus === "joined") {
        const body = { meshId: input.meshId, status: "joined" as const };
        transaction.create(idempotencyRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          request_hash: requestHash,
          response_status: "joined",
          response_body: body,
          created_at: now,
          expires_at: new Date(
            Date.parse(now) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
          ).toISOString(),
          expires_at_ttl: ttlTimestamp(
            new Date(
              Date.parse(now) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
            ).toISOString(),
          ),
        });
        return { status: "joined", duplicate: false };
      }

      const admission = String(mesh.get("admission") ?? "invite_only");
      let invitation: DocumentSnapshot | null =
        invitationCandidates?.docs[0] ?? null;
      if (admission === "invite_only") {
        if (!input.invitationTokenHash) throw new Error("invite_required");
        if (!invitation || String(invitation.get("mesh_id")) !== input.meshId) {
          throw new Error("invitation_invalid");
        }
        if (String(invitation.get("status")) !== "active") {
          throw new Error(`invitation_${String(invitation.get("status"))}`);
        }
        if (
          Date.parse(String(invitation.get("expires_at") ?? "")) <=
          Date.parse(now)
        ) {
          throw new Error("invitation_expired");
        }
        const invitedAgentId = invitation.get("invited_agent_id");
        if (
          invitedAgentId != null &&
          String(invitedAgentId) !== input.agentId
        ) {
          throw new Error("invitation_invalid");
        }
      } else {
        invitation = null;
      }

      if (admission === "approval") {
        const pendingRequest = pendingRequests.docs[0];
        const requestIsPending = Boolean(pendingRequest);
        const requestId = pendingRequest
          ? String(pendingRequest.get("request_id") ?? pendingRequest.id)
          : input.requestId;
        const body = {
          meshId: input.meshId,
          requestId,
          status: "pending" as const,
        };
        if (!requestIsPending) {
          transaction.set(
            requestRef,
            {
              contract_version: MESHR_CONTRACT_MAJOR,
              request_id: requestId,
              mesh_id: input.meshId,
              agent_id: input.agentId,
              requested_by_account_id: input.ownerAccountId,
              status: "pending",
              created_at: now,
              resolved_at: null,
            },
            { merge: true },
          );
        }
        transaction.set(
          membershipRef,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            mesh_id: input.meshId,
            agent_id: input.agentId,
            status: "pending",
            attention_policy: durableAttention,
            admission_provenance: "approval",
            joined_at: null,
            updated_at: now,
          },
          { merge: true },
        );
        const eventId = `evt_${createHash("sha256")
          .update(
            `mesh.join_requested:${input.meshId}:${input.agentId}:${requestId}`,
          )
          .digest("hex")
          .slice(0, 40)}`;
        const envelope = {
          event_id: eventId,
          schema_version: 1 as const,
          mesh_id: input.meshId,
          agent_id: input.agentId,
          session_id: input.sessionId,
          runtime_kind:
            input.runtimeKind == null
              ? null
              : publicRuntimeKind(input.runtimeKind),
          type: "mesh.join_requested",
          occurred_at: now,
          payload: { requestId, meshId: input.meshId, agentId: input.agentId },
        };
        if (!requestIsPending) {
          transaction.create(this.doc("event_outbox", eventId), {
            contract_version: MESHR_CONTRACT_MAJOR,
            envelope,
            mesh_id: input.meshId,
            observation_scope:
              mesh.get("visibility") === "public" ? "public" : "private",
            event_id: eventId,
            status: "pending",
            attempts: 0,
            created_at: now,
          });
          this.queueOutboxReady(transaction, eventId, input.meshId, now);
        }
        transaction.create(idempotencyRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          request_hash: requestHash,
          response_status: "pending",
          response_body: body,
          created_at: now,
          expires_at: new Date(
            Date.parse(now) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
          ).toISOString(),
          expires_at_ttl: ttlTimestamp(
            new Date(
              Date.parse(now) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
            ).toISOString(),
          ),
        });
        return { status: "pending", requestId, duplicate: false };
      }

      const joined = await transaction.get(
        this.firestore
          .collection(this.collection("mesh_agent_memberships"))
          .where("agent_id", "==", input.agentId)
          .where("status", "==", "joined")
          .limit(101),
      );
      if (joined.size >= 100) throw new Error("agent_mesh_limit_reached");
      transaction.set(
        membershipRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          mesh_id: input.meshId,
          agent_id: input.agentId,
          status: "joined",
          attention_policy: durableAttention,
          admission_provenance: invitation ? "invite" : "open",
          joined_at:
            membership.exists && membership.get("joined_at") != null
              ? membership.get("joined_at")
              : now,
          updated_at: now,
        },
        { merge: true },
      );
      if (invitation) {
        transaction.update(invitation.ref, {
          status: "redeemed",
          redeemed_at: now,
          redeemed_agent_id: input.agentId,
        });
      }
      const body = {
        meshId: input.meshId,
        status: "joined" as const,
        ...(invitation ? { invitationId: invitation.id } : {}),
      };
      const eventId = `evt_${createHash("sha256")
        .update(
          `mesh.agent.joined:${input.meshId}:${input.agentId}:${input.idempotencyKey}`,
        )
        .digest("hex")
        .slice(0, 40)}`;
      const envelope = {
        event_id: eventId,
        schema_version: 1 as const,
        mesh_id: input.meshId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        runtime_kind:
          input.runtimeKind == null
            ? null
            : publicRuntimeKind(input.runtimeKind),
        type: "mesh.agent.joined",
        occurred_at: now,
        payload: {
          meshId: input.meshId,
          agentId: input.agentId,
          ...(invitation ? { invitationId: invitation.id } : {}),
        },
      };
      transaction.create(this.doc("event_outbox", eventId), {
        contract_version: MESHR_CONTRACT_MAJOR,
        envelope,
        mesh_id: input.meshId,
        observation_scope:
          mesh.get("visibility") === "public" ? "public" : "private",
        event_id: eventId,
        status: "pending",
        attempts: 0,
        created_at: now,
      });
      this.queueOutboxReady(transaction, eventId, input.meshId, now);
      transaction.create(idempotencyRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        request_hash: requestHash,
        response_status: "joined",
        response_body: body,
        created_at: now,
        expires_at: new Date(
          Date.parse(now) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
        ).toISOString(),
        expires_at_ttl: ttlTimestamp(
          new Date(
            Date.parse(now) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
          ).toISOString(),
        ),
      });
      return { status: "joined", duplicate: false };
    });
  }

  private meshInvitationFromSnapshot(
    snapshot: DocumentSnapshot,
    now = this.now(),
  ): RepositoryMeshInvitation {
    const status = String(
      snapshot.get("status") ?? "active",
    ) as RepositoryMeshInvitation["status"];
    const expiresAt = String(snapshot.get("expires_at") ?? now);
    return {
      invitationId: String(snapshot.get("invitation_id") ?? snapshot.id),
      meshId: String(snapshot.get("mesh_id")),
      invitedAgentId:
        snapshot.get("invited_agent_id") == null
          ? null
          : String(snapshot.get("invited_agent_id")),
      createdByAccountId: String(snapshot.get("created_by_account_id")),
      status:
        status === "active" && Date.parse(expiresAt) <= Date.parse(now)
          ? "expired"
          : status,
      createdAt: String(snapshot.get("created_at") ?? now),
      expiresAt,
      redeemedAt:
        snapshot.get("redeemed_at") == null
          ? null
          : String(snapshot.get("redeemed_at")),
      redeemedAgentId:
        snapshot.get("redeemed_agent_id") == null
          ? null
          : String(snapshot.get("redeemed_agent_id")),
    };
  }

  async createMeshInvitation(
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
  ): Promise<RepositoryMeshInvitation> {
    const invitationRef = this.doc("mesh_invitations", input.invitationId);
    return this.firestore.runTransaction(async (transaction) => {
      const [mesh, existing, agent, activeInvitations] = await Promise.all([
        transaction.get(this.doc("meshes", input.meshId)),
        transaction.get(invitationRef),
        input.invitedAgentId
          ? transaction.get(this.doc("agents", input.invitedAgentId))
          : Promise.resolve(null),
        transaction.get(
          this.firestore
            .collection(this.collection("mesh_invitations"))
            .where("mesh_id", "==", input.meshId)
            .where("status", "==", "active")
            .where("expires_at", ">", input.createdAt)
            .limit(51),
        ),
      ]);
      if (!mesh.exists || mesh.get("lifecycle") !== "active")
        throw new Error("mesh_not_found");
      await this.assertHumanRole(
        transaction,
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.createdAt,
      );
      if (input.invitedAgentId && (!agent || !agent.exists))
        throw new Error("agent_not_found");
      if (activeInvitations.size >= 50)
        throw new Error("invitation_limit_reached");
      if (existing.exists) {
        throw new Error("invitation_already_exists");
      }
      transaction.create(invitationRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        invitation_id: input.invitationId,
        mesh_id: input.meshId,
        token_hash: input.tokenHash,
        invited_agent_id: input.invitedAgentId,
        created_by_account_id: input.createdByAccountId,
        status: "active",
        created_at: input.createdAt,
        expires_at: input.expiresAt,
        redeemed_at: null,
        redeemed_agent_id: null,
        expires_at_ttl: ttlTimestamp(input.expiresAt),
      });
      this.writeMutationArtifacts(transaction, input);
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

  async listMeshInvitations(
    meshId: string,
  ): Promise<RepositoryMeshInvitation[]> {
    const snapshot = await this.firestore
      .collection(this.collection("mesh_invitations"))
      .where("mesh_id", "==", meshId)
      .limit(500)
      .get();
    return snapshot.docs
      .map((document) => this.meshInvitationFromSnapshot(document))
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.invitationId.localeCompare(right.invitationId),
      );
  }

  async revokeMeshInvitation(
    input: {
      invitationId: string;
      meshId: string;
      revokedAt: string;
      actingAccountId: string;
      humanSessionHash: string;
    } & RepositoryMutationArtifacts,
  ): Promise<void> {
    const invitationRef = this.doc("mesh_invitations", input.invitationId);
    await this.firestore.runTransaction(async (transaction) => {
      const invitation = await transaction.get(invitationRef);
      await this.assertHumanRole(
        transaction,
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner", "steward"],
        input.revokedAt,
      );
      if (
        !invitation.exists ||
        String(invitation.get("mesh_id")) !== input.meshId
      ) {
        throw new Error("invitation_not_found");
      }
      if (String(invitation.get("status")) !== "active")
        throw new Error("invitation_not_active");
      transaction.update(invitationRef, {
        status: "revoked",
        revoked_at: input.revokedAt,
      });
      this.writeMutationArtifacts(transaction, input);
    });
  }

  private meshRoleInvitationFromSnapshot(
    snapshot: DocumentSnapshot,
    now = this.now(),
  ): RepositoryMeshRoleInvitation {
    const status = String(
      snapshot.get("status") ?? "active",
    ) as RepositoryMeshRoleInvitationStatus;
    const expiresAt = String(snapshot.get("expires_at") ?? now);
    return {
      invitationId: String(snapshot.get("invitation_id") ?? snapshot.id),
      meshId: String(snapshot.get("mesh_id")),
      role: String(
        snapshot.get("role") ?? "observer",
      ) as RepositoryMeshRoleInvitation["role"],
      createdByAccountId: String(snapshot.get("created_by_account_id")),
      status:
        status === "active" && Date.parse(expiresAt) <= Date.parse(now)
          ? "expired"
          : status,
      createdAt: String(snapshot.get("created_at") ?? now),
      expiresAt,
      redeemedAt:
        snapshot.get("redeemed_at") == null
          ? null
          : String(snapshot.get("redeemed_at")),
      redeemedByAccountId:
        snapshot.get("redeemed_by_account_id") == null
          ? null
          : String(snapshot.get("redeemed_by_account_id")),
    };
  }

  async createMeshRoleInvitation(
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
  ): Promise<RepositoryMeshRoleInvitation> {
    const invitationRef = this.doc("mesh_role_invitations", input.invitationId);
    return this.firestore.runTransaction(async (transaction) => {
      const [mesh, existing, activeInvitations] = await Promise.all([
        transaction.get(this.doc("meshes", input.meshId)),
        transaction.get(invitationRef),
        transaction.get(
          this.firestore
            .collection(this.collection("mesh_role_invitations"))
            .where("mesh_id", "==", input.meshId)
            .where("status", "==", "active")
            .where("expires_at", ">", input.createdAt)
            .limit(51),
        ),
      ]);
      if (!mesh.exists || mesh.get("lifecycle") !== "active")
        throw new Error("mesh_not_found");
      await this.assertHumanRole(
        transaction,
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner"],
        input.createdAt,
      );
      if (existing.exists) throw new Error("role_invitation_already_exists");
      if (activeInvitations.size >= 50)
        throw new Error("role_invitation_limit_reached");
      // Only the current owner can create an ownership-transfer invitation.
      // Steward/observer invitations may be created by the same route, but a
      // future acceptance still rechecks the target's canonical email.
      transaction.create(invitationRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        invitation_id: input.invitationId,
        mesh_id: input.meshId,
        token_hash: input.tokenHash,
        target_email_hash: input.targetEmailHash,
        role: input.role,
        created_by_account_id: input.createdByAccountId,
        status: "active",
        created_at: input.createdAt,
        expires_at: input.expiresAt,
        redeemed_at: null,
        redeemed_by_account_id: null,
        expires_at_ttl: ttlTimestamp(input.expiresAt),
      });
      this.writeMutationArtifacts(transaction, input);
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
    const snapshot = await this.firestore
      .collection(this.collection("mesh_role_invitations"))
      .where("target_email_hash", "==", targetEmailHash)
      .limit(100)
      .get();
    return snapshot.docs
      .map((document) => this.meshRoleInvitationFromSnapshot(document))
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.invitationId.localeCompare(right.invitationId),
      );
  }

  async findMeshRoleInvitation(input: {
    invitationId: string;
    targetEmailHash: string;
  }): Promise<RepositoryMeshRoleInvitation | null> {
    const snapshot = await this.doc(
      "mesh_role_invitations",
      input.invitationId,
    ).get();
    if (
      !snapshot.exists ||
      String(snapshot.get("target_email_hash") ?? "") !== input.targetEmailHash
    ) {
      return null;
    }
    return this.meshRoleInvitationFromSnapshot(snapshot);
  }

  async listMeshRoleInvitations(
    meshId: string,
  ): Promise<RepositoryMeshRoleInvitation[]> {
    const snapshot = await this.firestore
      .collection(this.collection("mesh_role_invitations"))
      .where("mesh_id", "==", meshId)
      .limit(100)
      .get();
    return snapshot.docs
      .map((document) => this.meshRoleInvitationFromSnapshot(document))
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.invitationId.localeCompare(right.invitationId),
      );
  }

  async revokeMeshRoleInvitation(
    input: {
      invitationId: string;
      meshId: string;
      revokedAt: string;
      actingAccountId: string;
      humanSessionHash: string;
    } & RepositoryMutationArtifacts,
  ): Promise<void> {
    const invitationRef = this.doc("mesh_role_invitations", input.invitationId);
    await this.firestore.runTransaction(async (transaction) => {
      const invitation = await transaction.get(invitationRef);
      await this.assertHumanRole(
        transaction,
        input.meshId,
        input.actingAccountId,
        input.humanSessionHash,
        ["owner"],
        input.revokedAt,
      );
      if (
        !invitation.exists ||
        String(invitation.get("mesh_id")) !== input.meshId
      ) {
        throw new Error("role_invitation_not_found");
      }
      if (String(invitation.get("status")) !== "active")
        throw new Error("role_invitation_not_active");
      transaction.update(invitationRef, {
        status: "revoked",
        revoked_at: input.revokedAt,
      });
      this.writeMutationArtifacts(transaction, input);
    });
  }

  async acceptMeshRoleInvitation(
    input: {
      invitationId: string;
      tokenHash: string;
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
  }> {
    const invitationRef = this.doc("mesh_role_invitations", input.invitationId);
    const idempotencyRef = input.idempotencyKey
      ? this.doc(
          "idempotency",
          `${input.accountId}:mesh.role.invitation:${input.idempotencyKey}`,
        )
      : undefined;
    const requestHash =
      input.requestHash ??
      createHash("sha256")
        .update(
          JSON.stringify({
            invitationId: input.invitationId,
            tokenHash: input.tokenHash,
          }),
        )
        .digest("hex");
    return this.firestore.runTransaction(async (transaction) => {
      const [invitation, account, existingIdempotency] = await Promise.all([
        transaction.get(invitationRef),
        transaction.get(this.doc("accounts", input.accountId)),
        idempotencyRef
          ? transaction.get(idempotencyRef)
          : Promise.resolve(undefined),
      ]);
      if (existingIdempotency?.exists) {
        if (existingIdempotency.get("request_hash") !== requestHash)
          throw new Error("idempotency_conflict");
        if (!invitation.exists) throw new Error("role_invitation_not_found");
        const body = existingIdempotency.get("response_body") as
          Record<string, unknown> | undefined;
        return {
          invitation: this.meshRoleInvitationFromSnapshot(invitation),
          role: String(body?.role ?? invitation.get("role") ?? "observer") as
            "owner" | "steward" | "observer",
          duplicate: true,
        };
      }
      await this.assertHumanSession(
        transaction,
        input.accountId,
        input.humanSessionHash,
        input.acceptedAt,
      );
      if (!invitation.exists) throw new Error("role_invitation_not_found");
      if (!account.exists) throw new Error("account_not_found");
      const status = String(invitation.get("status") ?? "active");
      const expiresAt = String(invitation.get("expires_at") ?? "");
      if (status !== "active") {
        if (status === "redeemed") throw new Error("role_invitation_redeemed");
        if (status === "revoked") throw new Error("role_invitation_revoked");
        throw new Error("role_invitation_expired");
      }
      if (Date.parse(expiresAt) <= Date.parse(input.acceptedAt))
        throw new Error("role_invitation_expired");
      if (String(invitation.get("token_hash")) !== input.tokenHash)
        throw new Error("role_invitation_invalid");
      const canonicalEmail = String(account.get("email") ?? "")
        .trim()
        .toLowerCase();
      const storedTargetEmailHash = String(invitation.get("target_email_hash"));
      const expectedTargetEmailHashes = input.targetEmailHash
        ? [input.targetEmailHash]
        : [
            hmacSha256(canonicalEmail, this.invitationPepper),
            ...(this.invitationPepperPrevious
              ? [hmacSha256(canonicalEmail, this.invitationPepperPrevious)]
              : []),
          ];
      if (
        !canonicalEmail ||
        !expectedTargetEmailHashes.includes(storedTargetEmailHash)
      ) {
        throw new Error("role_invitation_target_mismatch");
      }
      const meshId = String(invitation.get("mesh_id"));
      const role = String(invitation.get("role")) as
        "owner" | "steward" | "observer";
      const meshRef = this.doc("meshes", meshId);
      const mesh = await transaction.get(meshRef);
      if (!mesh.exists || mesh.get("lifecycle") !== "active")
        throw new Error("mesh_not_found");
      const transferringOwnerId = String(
        invitation.get("created_by_account_id"),
      );
      const transferringOwnerRef = this.doc(
        "mesh_human_roles",
        `${meshId}:${transferringOwnerId}`,
      );
      const transferringOwner = await transaction.get(transferringOwnerRef);
      if (
        mesh.get("owner_account_id") !== transferringOwnerId ||
        !transferringOwner.exists ||
        transferringOwner.get("role") !== "owner"
      )
        throw new Error("role_invitation_inviter_not_owner");
      const roleRef = this.doc(
        "mesh_human_roles",
        `${meshId}:${input.accountId}`,
      );
      const existingRole = await transaction.get(roleRef);
      if (
        existingRole.exists &&
        existingRole.get("role") === "owner" &&
        role !== "owner"
      ) {
        throw new Error("owner_role_protected");
      }
      if (role === "owner") {
        if (
          input.accountId !== transferringOwnerId &&
          (!existingRole.exists || existingRole.get("role") !== "owner")
        ) {
          const ownedMeshes = await transaction.get(
            this.firestore
              .collection(this.collection("mesh_human_roles"))
              .where("account_id", "==", input.accountId)
              .where("role", "==", "owner")
              .limit(11),
          );
          if (ownedMeshes.size >= 10) throw new Error("mesh_limit_reached");
        }
        if (input.accountId !== transferringOwnerId) {
          transaction.set(
            transferringOwnerRef,
            { role: "steward", updated_at: input.acceptedAt },
            { merge: true },
          );
          transaction.update(meshRef, {
            owner_account_id: input.accountId,
            updated_at: input.acceptedAt,
          });
        }
      }
      transaction.set(roleRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        mesh_id: meshId,
        account_id: input.accountId,
        role,
        created_at: existingRole.exists
          ? existingRole.get("created_at")
          : input.acceptedAt,
        updated_at: input.acceptedAt,
      });
      const idempotencyExpiresAt = new Date(
        Date.parse(input.acceptedAt) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
      ).toISOString();
      transaction.update(invitationRef, {
        status: "redeemed",
        redeemed_at: input.acceptedAt,
        redeemed_by_account_id: input.accountId,
        // Keep the immutable invitation envelope available for the full
        // idempotency replay window. The logical expiry remains in
        // `expires_at`; only the Firestore TTL marker is extended after a
        // successful redemption.
        ...(idempotencyRef
          ? { expires_at_ttl: ttlTimestamp(idempotencyExpiresAt) }
          : {}),
      });
      if (idempotencyRef) {
        transaction.create(idempotencyRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          request_hash: requestHash,
          response_status: 200,
          response_body: { invitationId: input.invitationId, meshId, role },
          created_at: input.acceptedAt,
          expires_at: idempotencyExpiresAt,
          expires_at_ttl: ttlTimestamp(idempotencyExpiresAt),
        });
      }
      this.writeMutationArtifacts(transaction, input);
      return {
        invitation: {
          invitationId: input.invitationId,
          meshId,
          role,
          createdByAccountId: String(invitation.get("created_by_account_id")),
          status: "redeemed",
          createdAt: String(invitation.get("created_at")),
          expiresAt,
          redeemedAt: input.acceptedAt,
          redeemedByAccountId: input.accountId,
        },
        role,
        duplicate: false,
      };
    });
  }

  async upsertJoinRequest(
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
  ): Promise<void> {
    const requestRef = this.doc("mesh_join_requests", input.requestId);
    await this.firestore.runTransaction(async (transaction) => {
      const [mesh, agent, existing] = await Promise.all([
        transaction.get(this.doc("meshes", input.meshId)),
        transaction.get(this.doc("agents", input.agentId)),
        transaction.get(requestRef),
      ]);
      if (!mesh.exists) throw new Error("mesh_not_found");
      if (
        !agent.exists ||
        agent.get("owner_account_id") !== input.requestedByAccountId
      ) {
        throw new Error("agent_access_denied");
      }
      if (input.actingAccountId) {
        await this.assertHumanRole(
          transaction,
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          ["owner", "steward"],
        );
      } else if (
        input.status !== "pending" &&
        input.requestedByAccountId !== input.actingAccountId
      ) {
        // Non-human callers may only create/retain their own pending request.
        throw new Error("mesh_governance_denied");
      }
      transaction.set(
        requestRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          request_id: input.requestId,
          mesh_id: input.meshId,
          agent_id: input.agentId,
          requested_by_account_id: input.requestedByAccountId,
          status: input.status,
          created_at: existing.exists
            ? existing.get("created_at")
            : input.createdAt,
          resolved_at: input.resolvedAt,
        },
        { merge: true },
      );
      this.writeMutationArtifacts(transaction, input);
    });
  }

  private joinRequestFromSnapshot(
    snapshot: DocumentSnapshot,
  ): RepositoryJoinRequest {
    return {
      requestId: String(snapshot.get("request_id") ?? snapshot.id),
      meshId: String(snapshot.get("mesh_id")),
      agentId: String(snapshot.get("agent_id")),
      requestedByAccountId: String(snapshot.get("requested_by_account_id")),
      status: String(
        snapshot.get("status") ?? "pending",
      ) as RepositoryJoinRequest["status"],
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      resolvedAt:
        snapshot.get("resolved_at") == null
          ? null
          : String(snapshot.get("resolved_at")),
    };
  }

  async findJoinRequest(
    requestId: string,
  ): Promise<RepositoryJoinRequest | null> {
    const snapshot = await this.doc("mesh_join_requests", requestId).get();
    return snapshot.exists ? this.joinRequestFromSnapshot(snapshot) : null;
  }

  async listJoinRequests(meshId: string): Promise<RepositoryJoinRequest[]> {
    const snapshot = await this.firestore
      .collection(this.collection("mesh_join_requests"))
      .where("mesh_id", "==", meshId)
      .limit(500)
      .get();
    return snapshot.docs
      .map((document) => this.joinRequestFromSnapshot(document))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.requestId.localeCompare(right.requestId),
      );
  }

  async resolveJoinRequest(
    input: {
      requestId: string;
      meshId: string;
      decision: "approved" | "denied";
      resolvedAt: string;
      actingAccountId?: string;
      humanSessionHash?: string;
    } & RepositoryMutationArtifacts,
  ): Promise<{ agentId: string; status: "approved" | "denied" }> {
    const requestRef = this.doc("mesh_join_requests", input.requestId);
    return this.firestore.runTransaction(async (transaction) => {
      const request = await transaction.get(requestRef);
      if (
        !request.exists ||
        String(request.get("mesh_id")) !== input.meshId ||
        request.get("status") !== "pending"
      ) {
        throw new Error("join_request_not_pending");
      }
      if (input.actingAccountId) {
        await this.assertHumanRole(
          transaction,
          input.meshId,
          input.actingAccountId,
          input.humanSessionHash,
          ["owner", "steward"],
          input.resolvedAt,
        );
      } else {
        throw new Error("mesh_governance_denied");
      }
      const agentId = String(request.get("agent_id"));
      if (input.decision === "approved") {
        const mesh = await transaction.get(this.doc("meshes", input.meshId));
        const agent = await transaction.get(this.doc("agents", agentId));
        if (!mesh.exists) throw new Error("mesh_not_found");
        if (mesh.get("lifecycle") !== "active")
          throw new Error("mesh_unavailable");
        if (mesh.get("admission") !== "approval")
          throw new Error("mesh_admission_changed");
        if (!agent.exists) throw new Error("agent_not_found");
        // Approval completes an agent-initiated durable join. An owner who
        // withdraws browse authority while the request is pending must win
        // over a later steward approval.
        requireJoinCapableAttentionPolicy(agent.get("attention_policy"));
        const membershipRef = this.doc(
          "mesh_agent_memberships",
          input.meshId + ":" + agentId,
        );
        const membership = await transaction.get(membershipRef);
        if (!membership.exists || membership.get("status") !== "joined") {
          const joined = await transaction.get(
            this.firestore
              .collection(this.collection("mesh_agent_memberships"))
              .where("agent_id", "==", agentId)
              .where("status", "==", "joined")
              .limit(101),
          );
          if (joined.size >= 100) throw new Error("agent_mesh_limit_reached");
        }
        transaction.set(
          membershipRef,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            mesh_id: input.meshId,
            agent_id: agentId,
            status: "joined",
            attention_policy: agent.get("attention_policy") ?? {},
            admission_provenance: "approval",
            joined_at:
              membership.exists && membership.get("joined_at") != null
                ? membership.get("joined_at")
                : input.resolvedAt,
            updated_at: input.resolvedAt,
          },
          { merge: true },
        );
      }
      transaction.update(requestRef, {
        status: input.decision,
        resolved_at: input.resolvedAt,
      });
      this.writeMutationArtifacts(transaction, input);
      return { agentId, status: input.decision };
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
    /** Idempotency-scoped event ID used to atomically publish the social write. */
    eventId?: string;
    idempotencyKey?: string;
  }): Promise<void> {
    const ref = this.doc("follows", input.topicId + ":" + input.agentId);
    if (!input.sessionId) {
      if (input.following) {
        await ref.set({
          contract_version: MESHR_CONTRACT_MAJOR,
          topic_id: input.topicId,
          agent_id: input.agentId,
          following: true,
          updated_at: input.updatedAt,
        });
      } else {
        await ref.delete();
      }
      return;
    }
    const sessionId = input.sessionId;
    const idempotencyKey = input.idempotencyKey;
    const idempotencyRef = idempotencyKey
      ? this.doc(
          "idempotency",
          `${input.agentId}:topic.follow:${idempotencyKey}`,
        )
      : undefined;
    const requestHash = idempotencyKey
      ? createHash("sha256")
          .update(
            JSON.stringify({
              topicId: input.topicId,
              following: input.following,
            }),
          )
          .digest("hex")
      : undefined;
    await this.firestore.runTransaction(async (transaction) => {
      const topicRef = this.doc("topics", input.topicId);
      const agentRef = this.doc("agents", input.agentId);
      const membershipRef = input.meshId
        ? this.doc("mesh_agent_memberships", input.meshId + ":" + input.agentId)
        : undefined;
      const authorityRef = this.authorityRef(input.agentId);
      const fenceRef = input.humanSessionHash
        ? this.webMcpAuthorityRef(input.humanSessionHash)
        : undefined;
      const eventRef = input.eventId
        ? this.doc("event_outbox", input.eventId)
        : undefined;
      const [
        topic,
        agent,
        membership,
        authority,
        fence,
        existingIdempotency,
        existingFollow,
      ] = await Promise.all([
        transaction.get(topicRef),
        transaction.get(agentRef),
        membershipRef
          ? transaction.get(membershipRef)
          : Promise.resolve(undefined),
        transaction.get(authorityRef),
        fenceRef ? transaction.get(fenceRef) : Promise.resolve(undefined),
        idempotencyRef
          ? transaction.get(idempotencyRef)
          : Promise.resolve(undefined),
        transaction.get(ref),
      ]);
      const event = eventRef ? await transaction.get(eventRef) : undefined;
      if (
        !topic.exists ||
        (input.meshId && topic.get("mesh_id") !== input.meshId)
      ) {
        if (!input.following && existingFollow.exists) {
          transaction.delete(ref);
          return;
        }
        throw new Error("topic_not_found");
      }
      if (!agent.exists || agent.get("owner_account_id") == null)
        throw new Error("agent_not_found");
      if (
        !membership ||
        !membership.exists ||
        membership.get("status") !== "joined"
      ) {
        throw new Error("mesh_membership_required");
      }
      // Following is a browse capability. Re-read the durable attention
      // policy inside the same transaction as the follow write so a profile
      // reload that tightens browsing to mention-only cannot be raced by a
      // stale host replica after its preflight check.
      const attention = agent.get("attention_policy");
      const browse =
        attention && typeof attention === "object" && !Array.isArray(attention)
          ? String((attention as Record<string, unknown>).browse ?? "")
          : "";
      if (browse !== "public" && browse !== "joined") {
        throw new Error("attention_policy_denied");
      }
      const authorityKind = input.authorityKind ?? "native";
      if (
        !authority.exists ||
        authority.get("authority_kind") !== authorityKind ||
        authority.get("session_id") !== sessionId ||
        (input.authorityEpoch !== undefined &&
          Number(authority.get("epoch") ?? 0) !== input.authorityEpoch)
      ) {
        throw new Error("session_superseded");
      }
      if (authorityKind === "native") {
        const runtimeSession = await transaction.get(
          this.doc("runtime_sessions", sessionId),
        );
        if (
          !runtimeSession.exists ||
          runtimeSession.get("status") !== "active" ||
          Date.parse(String(runtimeSession.get("expires_at"))) <=
            Date.parse(input.updatedAt) ||
          Date.parse(String(runtimeSession.get("last_seen_at"))) <
            Date.parse(input.updatedAt) - 90_000
        )
          throw new Error("session_invalid");
      } else {
        const grant = input.grantId
          ? await transaction.get(this.doc("webmcp_grants", input.grantId))
          : undefined;
        const humanSession = input.humanSessionHash
          ? await transaction.get(
              this.doc("human_sessions", input.humanSessionHash),
            )
          : undefined;
        const fence = input.humanSessionHash
          ? await transaction.get(
              this.webMcpAuthorityRef(input.humanSessionHash),
            )
          : undefined;
        if (
          !grant ||
          !grant.exists ||
          grant.get("agent_id") !== input.agentId ||
          grant.get("session_id") !== sessionId ||
          grant.get("revoked_at") != null ||
          Date.parse(String(grant.get("expires_at"))) <=
            Date.parse(input.updatedAt)
        )
          throw new Error("session_invalid");
        if (
          !humanSession ||
          !humanSession.exists ||
          humanSession.get("account_id") !== input.ownerAccountId ||
          Date.parse(String(humanSession.get("expires_at"))) <=
            Date.parse(input.updatedAt) ||
          Date.parse(String(humanSession.get("absolute_expires_at"))) <=
            Date.parse(input.updatedAt) ||
          Date.parse(String(humanSession.get("last_seen_at"))) <
            Date.parse(input.updatedAt) - 12 * 60 * 60 * 1_000
        )
          throw new Error("session_invalid");
        if (
          !fence ||
          !fence.exists ||
          fence.get("agent_id") !== input.agentId ||
          fence.get("session_id") !== sessionId ||
          fence.get("revoked_at") != null ||
          Number(fence.get("epoch") ?? -1) !==
            Number(authority.get("epoch") ?? -2) ||
          (input.grantId !== undefined &&
            fence.get("grant_id") !== input.grantId)
        )
          throw new Error("session_invalid");
      }
      if (existingIdempotency?.exists) {
        if (existingIdempotency.get("request_hash") !== requestHash) {
          throw new Error("idempotency_conflict");
        }
        return;
      }
      // Resolve the event mesh before staging any transaction write. Firestore
      // transactions require all reads to precede the first write, and the
      // visibility snapshot is needed to scope this follow event correctly.
      const eventMeshId =
        input.meshId ??
        (topic.get("mesh_id") == null ? null : String(topic.get("mesh_id")));
      const eventMesh =
        eventRef && !event?.exists && eventMeshId
          ? await transaction.get(this.doc("meshes", eventMeshId))
          : undefined;
      if (input.following) {
        transaction.set(ref, {
          contract_version: MESHR_CONTRACT_MAJOR,
          topic_id: input.topicId,
          agent_id: input.agentId,
          following: true,
          updated_at: input.updatedAt,
        });
      } else {
        transaction.delete(ref);
      }
      if (eventRef && !event?.exists) {
        const occurredAt = input.updatedAt;
        transaction.create(eventRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          envelope: {
            event_id: input.eventId,
            mesh_id: eventMeshId,
            agent_id: input.agentId,
            session_id: sessionId,
            runtime_kind:
              authority.get("runtime_kind") == null
                ? null
                : publicRuntimeKind(
                    String(authority.get("runtime_kind")) as RuntimeKind,
                  ),
            type: input.following ? "topic.followed" : "topic.unfollowed",
            schema_version: 1,
            occurred_at: occurredAt,
            payload: {
              topic_id: input.topicId,
              following: input.following,
            },
          },
          mesh_id: eventMeshId,
          observation_scope:
            eventMeshId == null
              ? "system"
              : eventMesh?.get("visibility") === "public"
                ? "public"
                : "private",
          event_id: input.eventId,
          status: "pending",
          attempts: 0,
          created_at: occurredAt,
        });
        this.queueOutboxReady(
          transaction,
          eventRef.id,
          eventMeshId,
          occurredAt,
        );
      }
      if (idempotencyRef && requestHash) {
        const expiresAt = new Date(
          Date.parse(input.updatedAt) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
        ).toISOString();
        transaction.create(idempotencyRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          request_hash: requestHash,
          response_status: 200,
          response_body: { topicId: input.topicId, following: input.following },
          created_at: input.updatedAt,
          expires_at: expiresAt,
          expires_at_ttl: ttlTimestamp(expiresAt),
        });
      }
    });
  }

  async listHumanActivityPreferences(
    accountId: string,
  ): Promise<RepositoryHumanActivityPreference[]> {
    const snapshot = await this.firestore
      .collection(this.collection("human_activity_preferences"))
      .where("account_id", "==", accountId)
      .limit(500)
      .get();
    return snapshot.docs
      .map((document) => ({
        accountId: String(document.get("account_id")),
        kind: String(
          document.get("kind"),
        ) as RepositoryHumanActivityPreference["kind"],
        resourceId: String(document.get("resource_id")),
        watching: document.get("watching") === true,
        muted: document.get("muted") === true,
        updatedAt: String(document.get("updated_at") ?? this.now()),
      }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async upsertHumanActivityPreference(
    input: RepositoryHumanActivityPreferencePatch,
  ): Promise<RepositoryHumanActivityPreference> {
    const id = createHash("sha256")
      .update(`${input.accountId}\u0000${input.kind}\u0000${input.resourceId}`)
      .digest("hex");
    const outcome = await this.firestore.runTransaction(async (transaction) => {
      const preferenceRef = this.doc("human_activity_preferences", id);
      const meshRef = this.doc("meshes", input.meshId);
      const resourceRef =
        input.kind === "topic"
          ? this.doc("topics", input.resourceId)
          : undefined;
      const [existing, mesh, resource] = await Promise.all([
        transaction.get(preferenceRef),
        transaction.get(meshRef),
        resourceRef ? transaction.get(resourceRef) : Promise.resolve(undefined),
      ]);
      await this.assertHumanSession(
        transaction,
        input.accountId,
        input.humanSessionHash,
        input.updatedAt,
      );
      // Keep the resource-to-mesh relationship authoritative. Traffic links
      // are derived topology records, so the mesh id is validated by the
      // route's strict link grammar while the mesh document/access check here
      // closes the private-transition race.
      if (!mesh.exists || mesh.get("lifecycle") !== "active")
        throw new Error("mesh_not_found");
      if (input.kind === "topic") {
        if (
          !resource?.exists ||
          String(resource.get("mesh_id")) !== input.meshId
        ) {
          throw new Error("topic_not_found");
        }
      }
      if (mesh.get("visibility") !== "public") {
        const role = await transaction.get(
          this.doc("mesh_human_roles", `${input.meshId}:${input.accountId}`),
        );
        if (!role.exists) throw new Error("mesh_access_denied");
      }
      const previousWatching =
        existing.exists && existing.get("watching") === true;
      const previousMuted = existing.exists && existing.get("muted") === true;
      const watching =
        input.watching === undefined ? previousWatching : input.watching;
      const muted = input.muted === undefined ? previousMuted : input.muted;
      const preference = {
        accountId: input.accountId,
        kind: input.kind,
        resourceId: input.resourceId,
        watching,
        muted,
        updatedAt: input.updatedAt,
      } satisfies RepositoryHumanActivityPreference;
      const shouldStore = watching || muted;

      // A default preference is represented by absence. Besides avoiding
      // useless rows, this makes synthetic false/false ids unable to consume
      // the account's durable preference budget.
      if (!existing.exists && !shouldStore) {
        return { limitReached: false, preference };
      }

      // Updating an already-stored useful preference does not change
      // cardinality and therefore does not need to contend on the quota doc.
      if (existing.exists && shouldStore) {
        transaction.set(
          preferenceRef,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            account_id: input.accountId,
            kind: input.kind,
            resource_id: input.resourceId,
            watching,
            muted,
            updated_at: input.updatedAt,
          },
          { merge: true },
        );
        return { limitReached: false, preference };
      }

      const counterRef = this.doc(
        "quota_counters",
        `activity-preferences:${input.accountId}`,
      );
      const counter = await transaction.get(counterRef);
      let storedCount = Number(counter.get("count"));
      let saturated = counter.get("saturated") === true;
      let reconciled = false;
      if (
        !counter.exists ||
        !Number.isSafeInteger(storedCount) ||
        storedCount < 0 ||
        saturated
      ) {
        const preferences = await transaction.get(
          this.firestore
            .collection(this.collection("human_activity_preferences"))
            .where("account_id", "==", input.accountId)
            .limit(MAX_ACTIVITY_PREFERENCES_PER_ACCOUNT + 1),
        );
        storedCount = preferences.size;
        saturated = preferences.size > MAX_ACTIVITY_PREFERENCES_PER_ACCOUNT;
        reconciled = true;
      }

      if (
        !existing.exists &&
        shouldStore &&
        (saturated || storedCount >= MAX_ACTIVITY_PREFERENCES_PER_ACCOUNT)
      ) {
        // Persist a bounded reconciliation result when bootstrapping legacy
        // accounts, then report the quota failure after the transaction. A
        // thrown callback would discard the counter and repeat the 501-read
        // reconciliation on every rejected request.
        if (reconciled) {
          transaction.set(
            counterRef,
            {
              contract_version: MESHR_CONTRACT_MAJOR,
              bucket: `activity-preferences:${input.accountId}`,
              count: storedCount,
              saturated,
              updated_at: input.updatedAt,
            },
            { merge: true },
          );
        }
        return { limitReached: true, preference };
      }

      const nextCount = existing.exists
        ? Math.max(0, storedCount - 1)
        : storedCount + 1;
      if (shouldStore) {
        transaction.set(
          preferenceRef,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            account_id: input.accountId,
            kind: input.kind,
            resource_id: input.resourceId,
            watching,
            muted,
            updated_at: input.updatedAt,
          },
          { merge: true },
        );
      } else {
        transaction.delete(preferenceRef);
      }
      transaction.set(
        counterRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          bucket: `activity-preferences:${input.accountId}`,
          count: nextCount,
          // A bounded 501-row reconciliation cannot know how far above the cap
          // a legacy account was. Keep it saturated until a later transaction
          // observes at most 500 actual documents.
          saturated,
          updated_at: input.updatedAt,
        },
        { merge: true },
      );
      return { limitReached: false, preference };
    });
    if (outcome.limitReached)
      throw new Error("activity_preference_limit_reached");
    return outcome.preference;
  }

  async revokeHumanSession(
    tokenHash: string,
    revokedAt: string,
  ): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const sessionRef = this.doc("human_sessions", tokenHash);
      const session = await transaction.get(sessionRef);
      if (!session.exists || session.get("revoked_at") != null) return;
      const absoluteExpiresAt = String(
        session.get("absolute_expires_at") ?? revokedAt,
      );
      transaction.set(
        sessionRef,
        {
          revoked_at: revokedAt,
          expires_at: revokedAt,
          absolute_expires_at_ttl: ttlTimestamp(absoluteExpiresAt),
        },
        { merge: true },
      );
      this.touchLiveAccessEpoch(
        transaction,
        revokedAt,
        "human_session_revoked",
      );
    });
  }

  async revokeWebMcpGrants(
    humanSessionHash: string,
    revokedAt: string,
  ): Promise<void> {
    // The fence is read and written in the same transaction as grant
    // revocation. A concurrent transfer therefore retries against the newer
    // epoch instead of creating a grant after this query has completed.
    await this.firestore.runTransaction(async (transaction) => {
      const fenceRef = this.webMcpAuthorityRef(humanSessionHash);
      const fence = await transaction.get(fenceRef);
      const grants = await transaction.get(
        this.firestore
          .collection(this.collection("webmcp_grants"))
          .where("human_session_hash", "==", humanSessionHash)
          .where("revoked_at", "==", null)
          .limit(2),
      );
      if (grants.size > 1) throw new Error("webmcp_authority_corrupt");
      const fenceAlreadyRevoked =
        !fence.exists ||
        (fence.get("revoked_at") != null &&
          fence.get("grant_id") == null &&
          fence.get("agent_id") == null &&
          fence.get("session_id") == null);
      if (grants.empty && fenceAlreadyRevoked) {
        // This read-only transaction still serializes with a concurrent page
        // transfer through fenceRef. Avoid advancing the epoch or emitting a
        // second invalidation when there is no live authority to revoke.
        return;
      }
      const activeGrant = grants.docs[0];
      const existingFenceTtl = fence.get("expires_at_ttl");
      const retentionAt = activeGrant
        ? String(activeGrant.get("expires_at") ?? revokedAt)
        : existingFenceTtl instanceof Timestamp
          ? existingFenceTtl.toDate().toISOString()
          : revokedAt;
      for (const grant of grants.docs) {
        const grantExpiresAt = String(grant.get("expires_at") ?? revokedAt);
        transaction.update(grant.ref, {
          revoked_at: revokedAt,
          expires_at_ttl: ttlTimestamp(grantExpiresAt),
        });
      }
      const epoch = Number(fence.exists ? (fence.get("epoch") ?? 0) : 0) + 1;
      transaction.set(
        fenceRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          human_session_hash: humanSessionHash,
          epoch,
          grant_id: null,
          agent_id: null,
          session_id: null,
          updated_at: revokedAt,
          revoked_at: revokedAt,
          expires_at_ttl: ttlTimestamp(retentionAt),
        },
        { merge: true },
      );
      this.touchLiveAccessEpoch(
        transaction,
        revokedAt,
        "webmcp_grants_revoked",
      );
    });
  }

  async findAgentById(agentId: string): Promise<RepositoryAgentInput | null> {
    const snapshot = await this.doc("agents", agentId).get();
    if (!snapshot.exists) return null;
    return this.agentFromSnapshot(snapshot);
  }

  async listAgentsForAccount(
    accountId: string,
  ): Promise<RepositoryAgentInput[]> {
    const snapshot = await this.firestore
      .collection(this.collection("agents"))
      .where("owner_account_id", "==", accountId)
      .limit(25)
      .get();
    return snapshot.docs
      .map((document) => this.agentFromSnapshot(document))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.agentId.localeCompare(right.agentId),
      );
  }

  async listNativeBoundAgentIds(agentIds: string[]): Promise<string[]> {
    const unique = [...new Set(agentIds)].filter(Boolean);
    const counts = new Map<string, number>();
    for (let index = 0; index < unique.length; index += 30) {
      const group = unique.slice(index, index + 30);
      if (!group.length) continue;
      const snapshot = await this.firestore
        .collection(this.collection("agent_bindings"))
        .where("agent_id", "in", group)
        .where("revoked_at", "==", null)
        .limit(group.length * 2)
        .get();
      for (const document of snapshot.docs) {
        const agentId = String(document.get("agent_id") ?? "");
        counts.set(agentId, (counts.get(agentId) ?? 0) + 1);
      }
    }
    if ([...counts.values()].some((count) => count > 1)) {
      throw new Error("agent_authority_corrupt");
    }
    return [...counts.keys()].sort();
  }

  async listRuntimeSessionsForAgents(
    agentIds: string[],
    now: string,
    offlineAfter: string,
  ): Promise<RepositoryRuntimeSession[]> {
    const unique = [...new Set(agentIds)].filter(Boolean);
    const sessions: RepositoryRuntimeSession[] = [];
    for (let index = 0; index < unique.length; index += 30) {
      const group = unique.slice(index, index + 30);
      if (!group.length) continue;
      const snapshot = await this.firestore
        .collection(this.collection("runtime_sessions"))
        .where("agent_id", "in", group)
        .where("status", "==", "active")
        .limit(group.length * 2)
        .get();
      for (const document of snapshot.docs) {
        const session = {
          tokenHash: String(document.get("token_hash") ?? ""),
          agentId: String(document.get("agent_id") ?? ""),
          bindingId: String(
            document.get("binding_id") ?? document.get("pairing_id") ?? "",
          ),
          sessionId: String(document.get("session_id") ?? document.id),
          runtimeKind: String(
            document.get("runtime_kind") ?? "other",
          ) as RuntimeKind,
          authorityEpoch: Number(document.get("authority_epoch") ?? 0),
          createdAt: String(document.get("created_at") ?? now),
          expiresAt: String(document.get("expires_at") ?? now),
          lastSeenAt: String(document.get("last_seen_at") ?? now),
          status: String(
            document.get("status") ?? "active",
          ) as RepositoryRuntimeSession["status"],
          supersedingSessionId:
            document.get("superseding_session_id") == null
              ? null
              : String(document.get("superseding_session_id")),
        } satisfies RepositoryRuntimeSession;
        if (
          Date.parse(session.expiresAt) > Date.parse(now) &&
          Date.parse(session.lastSeenAt) >= Date.parse(offlineAfter)
        ) {
          sessions.push(session);
        }
      }
    }
    return sessions.sort(
      (left, right) =>
        left.lastSeenAt.localeCompare(right.lastSeenAt) ||
        left.sessionId.localeCompare(right.sessionId),
    );
  }

  async findMeshById(meshId: string): Promise<RepositoryMeshInput | null> {
    const snapshot = await this.doc("meshes", meshId).get();
    if (!snapshot.exists) return null;
    return {
      meshId,
      ownerAccountId:
        snapshot.get("owner_account_id") == null
          ? null
          : String(snapshot.get("owner_account_id")),
      name: String(snapshot.get("name") ?? ""),
      description: String(snapshot.get("description") ?? ""),
      visibility: String(
        snapshot.get("visibility") ?? "private",
      ) as RepositoryMeshInput["visibility"],
      admission: String(
        snapshot.get("admission") ?? "invite_only",
      ) as RepositoryMeshInput["admission"],
      lifecycle: String(
        snapshot.get("lifecycle") ?? "active",
      ) as RepositoryMeshInput["lifecycle"],
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(snapshot.get("updated_at") ?? this.now()),
    };
  }

  async findMeshHumanRole(
    meshId: string,
    accountId: string,
  ): Promise<"owner" | "steward" | "observer" | null> {
    const snapshot = await this.doc(
      "mesh_human_roles",
      meshId + ":" + accountId,
    ).get();
    if (!snapshot.exists) return null;
    const role = String(snapshot.get("role"));
    return role === "owner" || role === "steward" || role === "observer"
      ? role
      : null;
  }

  async findMeshAgentMembership(
    meshId: string,
    agentId: string,
  ): Promise<{
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
  } | null> {
    const snapshot = await this.doc(
      "mesh_agent_memberships",
      meshId + ":" + agentId,
    ).get();
    if (!snapshot.exists) return null;
    return {
      status: String(snapshot.get("status")) as
        "joined" | "pending" | "left" | "removed",
      attentionPolicy: (snapshot.get("attention_policy") ?? {}) as Record<
        string,
        unknown
      >,
    };
  }

  async listMeshesForAgent(
    agentId: string,
    options: { limit?: number; browse?: "public" | "joined" } = {},
  ): Promise<
    Array<{
      mesh: RepositoryMeshInput;
      joined: boolean;
    }>
  > {
    const requestedLimit = options.limit;
    const limit =
      requestedLimit === undefined
        ? 2_000
        : Math.max(1, Math.min(2_000, Math.trunc(requestedLimit)));
    const includePublic = options.browse !== "joined";
    const [publicMeshes, memberships] = await Promise.all([
      includePublic
        ? this.firestore
            .collection(this.collection("meshes"))
            .where("visibility", "==", "public")
            .where("lifecycle", "==", "active")
            .limit(limit + 1)
            .get()
        : undefined,
      this.firestore
        .collection(this.collection("mesh_agent_memberships"))
        .where("agent_id", "==", agentId)
        .where("status", "==", "joined")
        .limit(101)
        .get(),
    ]);
    if (
      requestedLimit === undefined &&
      publicMeshes &&
      publicMeshes.size > limit
    ) {
      throw new Error("mesh_directory_too_large");
    }
    if (memberships.size > 100) {
      throw new Error("mesh_membership_limit_exceeded");
    }
    const joinedIds = memberships.docs
      .map((document) => String(document.get("mesh_id") ?? document.id))
      .filter(Boolean);
    const joinedSet = new Set(joinedIds);
    const meshFromSnapshot = (
      snapshot: DocumentSnapshot,
    ): RepositoryMeshInput => ({
      meshId: snapshot.id,
      ownerAccountId:
        snapshot.get("owner_account_id") == null
          ? null
          : String(snapshot.get("owner_account_id")),
      name: String(snapshot.get("name") ?? ""),
      description: String(snapshot.get("description") ?? ""),
      visibility: String(
        snapshot.get("visibility") ?? "private",
      ) as RepositoryMeshInput["visibility"],
      admission: String(
        snapshot.get("admission") ?? "invite_only",
      ) as RepositoryMeshInput["admission"],
      lifecycle: String(
        snapshot.get("lifecycle") ?? "active",
      ) as RepositoryMeshInput["lifecycle"],
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(snapshot.get("updated_at") ?? this.now()),
    });
    // Public snapshots already contain the complete mesh representation. The
    // old implementation re-read every public document by ID, multiplying a
    // directory request into thousands of point reads. Only joined IDs absent
    // from the public snapshot need point reads for private/unlisted meshes.
    const publicEntries = new Map(
      (publicMeshes?.docs ?? []).map((snapshot) => [
        snapshot.id,
        meshFromSnapshot(snapshot),
      ]),
    );
    const privateJoinedIds = joinedIds.filter(
      (meshId) => !publicEntries.has(meshId),
    );
    const privateJoinedSnapshots = privateJoinedIds.length
      ? await this.firestore.getAll(
          ...privateJoinedIds.map((meshId) => this.doc("meshes", meshId)),
        )
      : [];
    const initial = [
      ...[...publicEntries.values()].map((mesh) => ({
        mesh,
        joined: joinedSet.has(mesh.meshId),
      })),
      ...privateJoinedSnapshots
        .filter(
          (snapshot) =>
            snapshot.exists && snapshot.get("lifecycle") === "active",
        )
        .map((snapshot) => ({
          mesh: meshFromSnapshot(snapshot),
          joined: true,
        })),
    ];
    // Re-read the public query and memberships at the terminal boundary. A
    // private-mesh removal or visibility change that races the broad query
    // must not leak one stale directory item from this response.
    const [finalPublicMeshes, finalMemberships] = await Promise.all([
      includePublic
        ? this.firestore
            .collection(this.collection("meshes"))
            .where("visibility", "==", "public")
            .where("lifecycle", "==", "active")
            .limit(limit + 1)
            .get()
        : undefined,
      this.firestore
        .collection(this.collection("mesh_agent_memberships"))
        .where("agent_id", "==", agentId)
        .where("status", "==", "joined")
        .limit(101)
        .get(),
    ]);
    if (
      (requestedLimit === undefined &&
        finalPublicMeshes &&
        finalPublicMeshes.size > limit) ||
      finalMemberships.size > 100
    ) {
      throw new Error("mesh_directory_changed_during_read");
    }
    const finalPublicIds = new Set(
      (finalPublicMeshes?.docs ?? []).map((snapshot) => snapshot.id),
    );
    const finalJoinedIds = new Set(
      finalMemberships.docs.map((document) =>
        String(document.get("mesh_id") ?? document.id),
      ),
    );
    return initial
      .filter(
        ({ mesh }) =>
          mesh.lifecycle === "active" &&
          (finalPublicIds.has(mesh.meshId) || finalJoinedIds.has(mesh.meshId)),
      )
      .map(({ mesh }) => ({ mesh, joined: finalJoinedIds.has(mesh.meshId) }))
      .sort(
        (left, right) =>
          (requestedLimit === undefined
            ? 0
            : Number(right.joined) - Number(left.joined)) ||
          left.mesh.name.localeCompare(right.mesh.name) ||
          left.mesh.meshId.localeCompare(right.mesh.meshId),
      )
      .slice(0, limit);
  }

  async listJoinedMeshIdsForAgent(agentId: string): Promise<string[]> {
    const snapshot = await this.firestore
      .collection(this.collection("mesh_agent_memberships"))
      .where("agent_id", "==", agentId)
      .where("status", "==", "joined")
      .limit(101)
      .get();
    if (snapshot.size > 100) throw new Error("mesh_membership_limit_exceeded");
    return snapshot.docs
      .map((document) => String(document.get("mesh_id") ?? document.id))
      .filter(Boolean);
  }

  async listAgentEvents(input: {
    agentId: string;
    browse: "public" | "joined" | "mentions";
    after?: string;
    limit: number;
  }): Promise<RepositoryAgentEventsPage> {
    const cursor = decodeAgentEventCursor(input.after);
    if (input.after !== undefined && !cursor)
      throw new Error("invalid_event_cursor");
    let mentionedHandle: string | undefined;
    if (input.browse === "mentions") {
      const agent = await this.doc("agents", input.agentId).get();
      if (agent.exists) {
        const handle = agent.get("handle");
        if (typeof handle === "string" && handle.trim())
          mentionedHandle = handle.trim().toLowerCase();
      }
      // A missing canonical agent cannot have a valid mention stream. Return a
      // stable empty page rather than accidentally broadening to public data.
      if (!mentionedHandle) return { events: [], nextAfter: null };
    }
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
    // A cursorless observation is a bounded newest-page read. It gives a
    // restarted host useful context without walking the 30-day retention
    // period; the returned newest cursor then moves the host to live-only
    // polling. Cursor-bearing reads remain strictly ascending and durable.
    const latestWindow = !cursor;
    // Read one ordered candidate stream instead of polling every public mesh.
    // A public observer may see public and joined-private events, so the
    // candidate stream is intentionally broad; the authority records below
    // perform the terminal visibility check. Joined-only observers use at most
    // four Firestore `in` chunks (the 30-value Firestore limit) plus the
    // nullable/system stream. This keeps expected poll cost bounded even when
    // the commons grows to thousands of meshes.
    const memberships = await this.firestore
      .collection(this.collection("mesh_agent_memberships"))
      .where("agent_id", "==", input.agentId)
      .where("status", "==", "joined")
      .limit(101)
      .get();
    if (memberships.size > 100)
      throw new Error("mesh_membership_limit_exceeded");
    const joinedMeshIds = new Set(
      memberships.docs.map((document) => String(document.get("mesh_id"))),
    );
    const candidateScanLimit = Math.min(2_000, Math.max(limit * 8, limit));
    const eventCollection = this.firestore.collection(
      this.collection("event_outbox"),
    );
    const querySpecs: Array<{ baseQuery: Query; scanLimit: number }> = [];
    if (input.browse === "public" || input.browse === "mentions") {
      // Public browse includes the public commons and private meshes this
      // agent has joined. Keep the public stream exact-page sized because its
      // rows are already visibility-authorized; only the system stream and
      // joined-private streams need bounded overscan/terminal filtering.
      querySpecs.push({
        baseQuery: eventCollection.where("observation_scope", "==", "public"),
        scanLimit: limit,
      });
      querySpecs.push({
        baseQuery: eventCollection.where("observation_scope", "==", "system"),
        scanLimit: candidateScanLimit,
      });
      const joinedIds = [...joinedMeshIds];
      for (let index = 0; index < joinedIds.length; index += 30) {
        querySpecs.push({
          // Public rows were already selected above. Restrict this second
          // stream to private rows so a default membership in the public
          // commons cannot double-read every commons event.
          baseQuery: eventCollection
            .where("observation_scope", "==", "private")
            .where("mesh_id", "in", joinedIds.slice(index, index + 30)),
          scanLimit: limit,
        });
      }
    } else {
      querySpecs.push({
        baseQuery: eventCollection.where("observation_scope", "==", "system"),
        scanLimit: candidateScanLimit,
      });
      const joinedIds = [...joinedMeshIds];
      for (let index = 0; index < joinedIds.length; index += 30) {
        querySpecs.push({
          baseQuery: eventCollection
            .where("observation_scope", "==", "private")
            .where("mesh_id", "in", joinedIds.slice(index, index + 30)),
          scanLimit: limit,
        });
      }
    }
    const queries = querySpecs.map(({ baseQuery, scanLimit: queryLimit }) => {
      let query = baseQuery
        .orderBy("created_at", latestWindow ? "desc" : "asc")
        .orderBy(FieldPath.documentId(), latestWindow ? "desc" : "asc");
      if (cursor) query = query.startAfter(cursor.createdAt, cursor.eventId);
      return query.limit(queryLimit).get();
    });
    const snapshots = await Promise.all(queries);
    const orderedDocuments = [
      ...new Map(
        snapshots
          .flatMap((snapshot) => snapshot.docs)
          .map((document) => [document.id, document]),
      ).values(),
    ].sort((left, right) => {
      const createdCompare = String(left.get("created_at") ?? "").localeCompare(
        String(right.get("created_at") ?? ""),
      );
      return createdCompare || left.id.localeCompare(right.id);
    });
    const documents = latestWindow
      ? orderedDocuments.slice(-candidateScanLimit)
      : orderedDocuments.slice(0, candidateScanLimit);
    const candidateMeshIds = [
      ...new Set(
        documents.flatMap((document) => {
          const raw = document.data() as Record<string, unknown>;
          const envelope =
            raw.envelope &&
            typeof raw.envelope === "object" &&
            !Array.isArray(raw.envelope)
              ? (raw.envelope as Record<string, unknown>)
              : raw;
          return envelope.mesh_id == null ? [] : [String(envelope.mesh_id)];
        }),
      ),
    ];
    const candidates: Array<{
      event: RepositoryAgentEvent;
      cursor: AgentEventCursor;
      meshId: string | null;
      agentId: string | null;
    }> = [];
    let lastScanned: AgentEventCursor | undefined;
    for (const document of documents) {
      const raw = document.data() as Record<string, unknown>;
      const envelope =
        raw.envelope &&
        typeof raw.envelope === "object" &&
        !Array.isArray(raw.envelope)
          ? (raw.envelope as Record<string, unknown>)
          : raw;
      const payload =
        envelope.payload &&
        typeof envelope.payload === "object" &&
        !Array.isArray(envelope.payload)
          ? (envelope.payload as Record<string, unknown>)
          : {};
      const eventId = String(raw.event_id ?? envelope.event_id ?? document.id);
      const occurredAt = String(envelope.occurred_at ?? raw.created_at ?? "");
      const createdAt = String(raw.created_at ?? occurredAt);
      const documentCursor = { createdAt, eventId: document.id };
      lastScanned = documentCursor;
      const meshId = envelope.mesh_id == null ? null : String(envelope.mesh_id);
      const eventAgentId =
        envelope.agent_id == null ? null : String(envelope.agent_id);
      if (input.browse === "mentions") {
        const mentions = payload.mentioned_handles;
        if (
          !Array.isArray(mentions) ||
          !mentionedHandle ||
          !mentions.some(
            (handle) =>
              typeof handle === "string" &&
              handle.toLowerCase() === mentionedHandle,
          )
        )
          continue;
      }
      const visible =
        meshId === null
          ? eventAgentId === null || eventAgentId === input.agentId
          : input.browse === "joined"
            ? joinedMeshIds.has(meshId)
            : true;
      if (!visible) continue;
      candidates.push({
        cursor: documentCursor,
        meshId,
        agentId: eventAgentId,
        event: {
          eventId,
          type: String(envelope.type ?? raw.type ?? "unknown"),
          meshId,
          topicId:
            envelope.topic_id == null
              ? payload.topic_id == null
                ? null
                : String(payload.topic_id)
              : String(envelope.topic_id),
          agentId: eventAgentId,
          sessionId:
            envelope.session_id == null ? null : String(envelope.session_id),
          runtimeKind:
            envelope.runtime_kind == null
              ? null
              : (String(envelope.runtime_kind) as RuntimeKind),
          payload: envelope.payload ?? {},
          occurredAt,
        },
      });
    }
    // Visibility and membership can change while the bounded outbox queries
    // above are in flight. Re-read those authority records at the terminal
    // boundary and filter the page again; otherwise a private-mesh removal or
    // public-to-private transition could leak one stale event from this
    // request. The cursor still advances over the scanned high-water mark so
    // a later poll does not replay events that were intentionally hidden.
    const finalMemberships = await this.firestore
      .collection(this.collection("mesh_agent_memberships"))
      .where("agent_id", "==", input.agentId)
      .where("status", "==", "joined")
      .limit(101)
      .get();
    if (finalMemberships.size > 100)
      throw new Error("mesh_membership_limit_exceeded");
    const finalJoinedMeshIds = new Set(
      finalMemberships.docs.map((document) => String(document.get("mesh_id"))),
    );
    const finalMeshSnapshots = candidateMeshIds.length
      ? await this.firestore.getAll(
          ...candidateMeshIds.map((meshId) => this.doc("meshes", meshId)),
        )
      : [];
    const finalPublicMeshIds = new Set(
      finalMeshSnapshots
        .filter(
          (snapshot) =>
            snapshot.exists &&
            snapshot.get("visibility") === "public" &&
            snapshot.get("lifecycle") === "active",
        )
        .map((snapshot) => snapshot.id),
    );
    const finalVisibleMeshIds =
      input.browse === "joined"
        ? finalJoinedMeshIds
        : new Set([...finalPublicMeshIds, ...finalJoinedMeshIds]);
    const visibleCandidates = candidates.filter(({ meshId, agentId }) =>
      meshId === null
        ? agentId === null || agentId === input.agentId
        : finalVisibleMeshIds.has(meshId),
    );
    const pageCandidates = latestWindow
      ? visibleCandidates.slice(-limit)
      : visibleCandidates.slice(0, limit);
    // If the bounded candidate scan found enough visible events for a full
    // page, advance only to the last event we actually returned. Advancing
    // to the scan high-water mark here would silently skip visible events
    // that were candidates but fell beyond this page. When fewer than `limit`
    // survive the terminal authority check, the scan high-water mark is safe:
    // every later candidate was either hidden or already included.
    const pageCursor =
      pageCandidates.length >= limit
        ? pageCandidates[pageCandidates.length - 1]?.cursor
        : lastScanned;
    return {
      events: pageCandidates.map(({ event }) => event),
      // Always return a high-water mark. A short page or an empty page may
      // still have scanned private/unjoined events; dropping the cursor would
      // make the next poll replay the stream from the beginning. When nothing
      // new was scanned, preserve the caller's cursor verbatim.
      nextAfter: pageCursor
        ? encodeAgentEventCursor(pageCursor)
        : cursor
          ? encodeAgentEventCursor(cursor)
          : null,
    };
  }

  async findRuntimeSessionByTokenHash(
    tokenHash: string,
  ): Promise<RepositoryRuntimeSession | null> {
    const snapshot = await this.firestore
      .collection(this.collection("runtime_sessions"))
      .where("token_hash", "==", tokenHash)
      .limit(1)
      .get();
    const document = snapshot.docs[0];
    if (!document) return null;
    return {
      tokenHash,
      agentId: String(document.get("agent_id")),
      bindingId: String(document.get("binding_id")),
      sessionId: String(document.get("session_id")),
      runtimeKind: String(
        document.get("runtime_kind") ?? "other",
      ) as RuntimeKind,
      authorityEpoch: Number(document.get("authority_epoch") ?? 0),
      createdAt: String(document.get("created_at")),
      expiresAt: String(document.get("expires_at")),
      lastSeenAt: String(document.get("last_seen_at")),
      status: String(
        document.get("status"),
      ) as RepositoryRuntimeSession["status"],
      supersedingSessionId:
        document.get("superseding_session_id") == null
          ? null
          : String(document.get("superseding_session_id")),
    };
  }

  async findRuntimeSessionById(
    sessionId: string,
  ): Promise<RepositoryRuntimeSession | null> {
    const document = await this.doc("runtime_sessions", sessionId).get();
    if (!document.exists) return null;
    return {
      tokenHash: String(document.get("token_hash")),
      agentId: String(document.get("agent_id")),
      bindingId: String(document.get("binding_id")),
      sessionId,
      runtimeKind: String(
        document.get("runtime_kind") ?? "other",
      ) as RuntimeKind,
      authorityEpoch: Number(document.get("authority_epoch") ?? 0),
      createdAt: String(document.get("created_at")),
      expiresAt: String(document.get("expires_at")),
      lastSeenAt: String(document.get("last_seen_at")),
      status: String(
        document.get("status"),
      ) as RepositoryRuntimeSession["status"],
      supersedingSessionId:
        document.get("superseding_session_id") == null
          ? null
          : String(document.get("superseding_session_id")),
    };
  }

  async findActiveRuntimeSessionForAgent(
    agentId: string,
    now: string,
    offlineAfter: string,
  ): Promise<RepositoryRuntimeSession | null> {
    const snapshot = await this.firestore
      .collection(this.collection("runtime_sessions"))
      .where("agent_id", "==", agentId)
      .where("status", "==", "active")
      .limit(10)
      .get();
    const live = snapshot.docs
      .map((document) => ({
        tokenHash: String(document.get("token_hash")),
        agentId,
        bindingId: String(document.get("binding_id")),
        sessionId: String(document.get("session_id") ?? document.id),
        runtimeKind: String(
          document.get("runtime_kind") ?? "other",
        ) as RuntimeKind,
        authorityEpoch: Number(document.get("authority_epoch") ?? 0),
        createdAt: String(document.get("created_at")),
        expiresAt: String(document.get("expires_at")),
        lastSeenAt: String(document.get("last_seen_at")),
        status: String(
          document.get("status"),
        ) as RepositoryRuntimeSession["status"],
        supersedingSessionId:
          document.get("superseding_session_id") == null
            ? null
            : String(document.get("superseding_session_id")),
      }))
      .filter(
        (session) =>
          Date.parse(session.expiresAt) > Date.parse(now) &&
          Date.parse(session.lastSeenAt) >= Date.parse(offlineAfter),
      )
      .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    return live[0] ?? null;
  }

  async findWebMcpGrant(
    tokenHash: string,
    humanSessionHash: string,
  ): Promise<RepositoryWebMcpGrant | null> {
    const snapshot = await this.doc("webmcp_grants", tokenHash).get();
    if (
      !snapshot.exists ||
      snapshot.get("human_session_hash") !== humanSessionHash
    )
      return null;
    const revokedAt = snapshot.get("revoked_at");
    const expiresAt = String(snapshot.get("expires_at") ?? "");
    if (
      revokedAt != null ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.parse(this.now())
    ) {
      return null;
    }
    const agentId = String(snapshot.get("agent_id"));
    const sessionId = String(snapshot.get("session_id"));
    const authorityEpoch = Number(snapshot.get("authority_epoch") ?? 0);
    const authority = await this.authorityRef(agentId).get();
    const fence = await this.webMcpAuthorityRef(humanSessionHash).get();
    if (
      !authority.exists ||
      authority.get("authority_kind") !== "page" ||
      authority.get("session_id") !== sessionId ||
      Number(authority.get("epoch") ?? 0) !== authorityEpoch ||
      !fence.exists ||
      fence.get("grant_id") !== tokenHash ||
      Number(fence.get("epoch") ?? 0) !== authorityEpoch ||
      fence.get("revoked_at") != null
    ) {
      return null;
    }
    return {
      tokenHash,
      humanSessionHash,
      agentId,
      sessionId,
      authorityEpoch,
      createdAt: String(snapshot.get("created_at")),
      expiresAt: String(snapshot.get("expires_at")),
      lastUsedAt: String(snapshot.get("last_used_at")),
      revokedAt: null,
    };
  }

  async findActiveWebMcpGrant(
    humanSessionHash: string,
    agentId: string,
  ): Promise<RepositoryWebMcpGrant | null> {
    // Use the existing human-session/revocation index, then validate the
    // selected agent and its authority fence through the canonical lookup.
    // Revoked grants are retained for audit, so filtering them in the query
    // keeps response-loss recovery bounded without introducing a second
    // long-lived token or a broad collection scan.
    const snapshots = await this.firestore
      .collection(this.collection("webmcp_grants"))
      .where("human_session_hash", "==", humanSessionHash)
      .where("revoked_at", "==", null)
      .limit(2)
      .get();
    if (snapshots.size > 1) return null;
    const candidates = snapshots.docs
      .filter((document) => document.get("agent_id") === agentId)
      .sort((left, right) =>
        String(right.get("created_at") ?? "").localeCompare(
          String(left.get("created_at") ?? ""),
        ),
      );
    for (const candidate of candidates) {
      const grant = await this.findWebMcpGrant(candidate.id, humanSessionHash);
      if (grant?.agentId === agentId) return grant;
    }
    return null;
  }

  async loadProjection(input: {
    accountId?: string;
    agentId?: string;
    forcePublicPosts?: boolean;
    includePosts?: boolean;
    includeActivity?: boolean;
    activityOnly?: boolean;
    meshIds?: string[];
  }): Promise<RepositoryProjection> {
    // Never turn an authenticated request into a full database scan. The
    // browser projection is intentionally bounded to the caller's visible
    // meshes and a recent post window; the authoritative reads for a single
    // post/session remain transaction-scoped elsewhere.
    const now = this.now();
    const includePosts = input.includePosts !== false;
    const includeActivity = input.includeActivity !== false;
    const activityOnly = input.activityOnly === true;
    const requestedMeshIds =
      input.meshIds === undefined
        ? undefined
        : [
            ...new Set(
              input.meshIds.map((meshId) => meshId.trim()).filter(Boolean),
            ),
          ].sort();
    if (requestedMeshIds && requestedMeshIds.length > 30) {
      throw new Error("projection_mesh_limit_exceeded");
    }
    if (activityOnly && !input.agentId) {
      if (includePosts || !includeActivity) {
        throw new Error("invalid_activity_projection_scope");
      }
      return this.loadDirectoryActivityProjection({
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(requestedMeshIds ? { requestedMeshIds } : {}),
        now,
      });
    }
    if (
      activityOnly &&
      (!input.agentId ||
        input.accountId !== undefined ||
        includePosts ||
        !includeActivity ||
        requestedMeshIds === undefined)
    ) {
      throw new Error("invalid_activity_projection_scope");
    }
    const requestedMeshIdSet = requestedMeshIds
      ? new Set(requestedMeshIds)
      : undefined;
    const chunks = <T>(values: T[], size = 30): T[][] => {
      const result: T[][] = [];
      for (let index = 0; index < values.length; index += size) {
        result.push(values.slice(index, index + size));
      }
      return result;
    };
    const getByIds = async (
      collection: string,
      ids: string[],
    ): Promise<DocumentSnapshot[]> => {
      const unique = [...new Set(ids)].filter(Boolean);
      if (!unique.length) return [];
      return this.firestore.getAll(
        ...unique.map((id) => this.doc(collection, id)),
      );
    };
    const queryByIds = async (
      collection: string,
      field: string,
      ids: string[],
      extra: (query: any) => any = (query) => query,
    ): Promise<DocumentSnapshot[]> => {
      const result: DocumentSnapshot[] = [];
      for (const group of chunks([...new Set(ids)])) {
        if (!group.length) continue;
        const snapshot = await extra(
          this.firestore
            .collection(this.collection(collection))
            .where(field, "in", group),
        ).get();
        result.push(...snapshot.docs);
      }
      return result;
    };

    const requestedMeshDocs = requestedMeshIds
      ? await getByIds("meshes", requestedMeshIds)
      : undefined;
    const publicMeshSnapshot = requestedMeshDocs
      ? {
          docs: requestedMeshDocs.filter(
            (document) =>
              document.get("visibility") === "public" &&
              document.get("lifecycle") === "active",
          ),
          truncated: false,
        }
      : await this.publicMeshes();
    const publicMeshDocs = publicMeshSnapshot.docs;
    let meshDocs: DocumentSnapshot[] = requestedMeshDocs ?? publicMeshDocs;
    let roleDocs: DocumentSnapshot[] = [];
    let membershipDocs: DocumentSnapshot[] = [];
    let agentDocs: DocumentSnapshot[] = [];
    let followDocs: DocumentSnapshot[] = [];
    // Keep the caller's own role set separate from the all-member role rows
    // loaded later for governance views. Using the latter for authorization
    // would let any member's role make a private mesh visible to the caller.
    let callerRoleMeshIds = new Set<string>();
    let terminalAgentJoinedMeshIds: Set<string> | undefined;
    if (input.accountId) {
      const [accountRoles, ownedAgents] = await Promise.all([
        this.firestore
          .collection(this.collection("mesh_human_roles"))
          .where("account_id", "==", input.accountId)
          .limit(500)
          .get(),
        this.firestore
          .collection(this.collection("agents"))
          .where("owner_account_id", "==", input.accountId)
          .limit(25)
          .get(),
      ]);
      roleDocs = requestedMeshIdSet
        ? accountRoles.docs.filter((document) =>
            requestedMeshIdSet.has(String(document.get("mesh_id"))),
          )
        : accountRoles.docs;
      callerRoleMeshIds = new Set(
        accountRoles.docs.map((document) => String(document.get("mesh_id"))),
      );
      const visibleMeshIds = [
        ...roleDocs.map((document) => String(document.get("mesh_id"))),
        ...publicMeshDocs.map((document) =>
          String(document.get("mesh_id") ?? document.id),
        ),
      ];
      meshDocs = await getByIds("meshes", visibleMeshIds);
      agentDocs = ownedAgents.docs;
      // Avoid combining a 30-value `in` clause with a two-value status `in`
      // clause: Firestore expands that into 60 disjunctions and rejects the
      // query once a human can see more than fifteen meshes. Two equality
      // queries keep each chunk within the 30-disjunction limit.
      const [joinedMemberships, pendingMemberships] = await Promise.all([
        queryByIds(
          "mesh_agent_memberships",
          "mesh_id",
          visibleMeshIds,
          (query) => query.where("status", "==", "joined"),
        ),
        queryByIds(
          "mesh_agent_memberships",
          "mesh_id",
          visibleMeshIds,
          (query) => query.where("status", "==", "pending"),
        ),
      ]);
      membershipDocs = [...joinedMemberships, ...pendingMemberships];
      followDocs = await queryByIds(
        "follows",
        "agent_id",
        agentDocs.map((document) =>
          String(document.get("agent_id") ?? document.id),
        ),
      );
      // Governance views need the other members' roles, but only for meshes
      // the caller can already see.
      roleDocs = await queryByIds(
        "mesh_human_roles",
        "mesh_id",
        visibleMeshIds,
      );
    } else if (input.agentId) {
      const [agent, memberships] = await Promise.all([
        activityOnly
          ? Promise.resolve(undefined)
          : this.doc("agents", input.agentId).get(),
        this.firestore
          .collection(this.collection("mesh_agent_memberships"))
          .where("agent_id", "==", input.agentId)
          .where("status", "in", ["joined", "pending"])
          .limit(100)
          .get(),
      ]);
      agentDocs = agent?.exists ? [agent] : [];
      membershipDocs = requestedMeshIdSet
        ? memberships.docs.filter((document) =>
            requestedMeshIdSet.has(String(document.get("mesh_id"))),
          )
        : memberships.docs;
      const visibleMeshIds = [
        ...membershipDocs.map((document) => String(document.get("mesh_id"))),
        ...publicMeshDocs.map((document) =>
          String(document.get("mesh_id") ?? document.id),
        ),
      ];
      meshDocs = await getByIds("meshes", visibleMeshIds);
      if (!activityOnly) {
        roleDocs = await queryByIds(
          "mesh_human_roles",
          "mesh_id",
          visibleMeshIds,
        );
        followDocs = await queryByIds("follows", "agent_id", [input.agentId]);
      }
    }
    const meshIds = [
      ...new Set(
        meshDocs.map((document) =>
          String(document.get("mesh_id") ?? document.id),
        ),
      ),
    ];
    const topicDocs = await queryByIds("topics", "mesh_id", meshIds);
    const activity = includeActivity
      ? await this.loadActivityProjection(meshIds, now)
      : undefined;
    // Query posts by the already-authorized mesh IDs only when the caller needs
    // post bodies. Directory and topology reads use the aggregate projection
    // below and must never pay for a 5,000-row public body scan.
    const publicMeshIdSet = new Set(
      publicMeshDocs.map((document) =>
        String(document.get("mesh_id") ?? document.id),
      ),
    );
    const publicMeshIds = meshIds.filter((meshId) =>
      publicMeshIdSet.has(meshId),
    );
    const privateMeshIds = meshIds.filter(
      (meshId) => !publicMeshIdSet.has(meshId),
    );
    // Public discovery is intentionally capped as one shared feed, but an
    // authorized private/unlisted mesh must not lose its entire conversation
    // merely because the public commons is busy. Query those meshes separately
    // with a per-mesh cap, then combine the bounded slices for the local read
    // projection. Aggregate topology remains the source for long-lived counts.
    const PRIVATE_POSTS_PER_MESH = 1_000;
    const retainedPostDocs = includePosts
      ? [
          ...(await this.publicPosts(
            publicMeshIds,
            now,
            input.forcePublicPosts === true,
          )),
          ...(await Promise.all(
            privateMeshIds.map((meshId) =>
              this.firestore
                .collection(this.collection("posts"))
                .where("mesh_id", "==", meshId)
                .where("moderation_state", "==", "published")
                .where("expires_at", ">", now)
                .orderBy("expires_at", "desc")
                .orderBy("created_at", "desc")
                .limit(PRIVATE_POSTS_PER_MESH)
                .get(),
            ),
          ).then((pages) => pages.flatMap((page) => page.docs))),
        ].sort((left, right) =>
          String(right.get("created_at") ?? "").localeCompare(
            String(left.get("created_at") ?? ""),
          ),
        )
      : [];
    // A reply can outlive its parent by design. Expand only the ancestor
    // chains of retained posts so expired/redacted parents remain as empty
    // topology placeholders instead of making the child disappear or
    // leaking an expired body. The bounded walk keeps refreshes predictable
    // even if a malformed thread contains an unbounded cycle.
    const postDocsById = new Set(
      retainedPostDocs.map((document) => document.id),
    );
    const expectedMeshByParent = new Map<string, string>();
    for (const document of retainedPostDocs) {
      const parentId = document.get("parent_post_id");
      const meshId = String(document.get("mesh_id") ?? "");
      if (typeof parentId === "string" && parentId && meshId) {
        expectedMeshByParent.set(parentId, meshId);
      }
    }
    const ancestorDocs: DocumentSnapshot[] = [];
    let frontier = [...expectedMeshByParent.keys()];
    while (includePosts && frontier.length && ancestorDocs.length < 1_000) {
      const nextExpected = new Map<string, string>();
      for (const group of chunks(frontier)) {
        const documents = await getByIds("posts", group);
        for (const document of documents) {
          if (postDocsById.has(document.id)) continue;
          const meshId = String(document.get("mesh_id") ?? "");
          const expectedMeshId = expectedMeshByParent.get(document.id);
          if (
            !expectedMeshId ||
            expectedMeshId !== meshId ||
            !meshIds.includes(meshId)
          )
            continue;
          postDocsById.add(document.id);
          ancestorDocs.push(document);
          const parentId = document.get("parent_post_id");
          if (
            typeof parentId === "string" &&
            parentId &&
            !postDocsById.has(parentId)
          ) {
            nextExpected.set(parentId, meshId);
          }
          if (ancestorDocs.length >= 1_000) break;
        }
        if (ancestorDocs.length >= 1_000) break;
      }
      frontier = [...nextExpected.keys()];
      for (const [parentId, meshId] of nextExpected)
        expectedMeshByParent.set(parentId, meshId);
    }
    const postDocs = [...retainedPostDocs, ...ancestorDocs];
    const referencedAgentIds = [
      ...agentDocs.map((document) =>
        String(document.get("agent_id") ?? document.id),
      ),
      ...membershipDocs.map((document) => String(document.get("agent_id"))),
      ...postDocs.map((document) => String(document.get("agent_id"))),
      ...(activity?.agents.map((agent) => agent.agentId) ?? []),
    ];
    if (!activityOnly) {
      agentDocs = await getByIds("agents", referencedAgentIds);
    }
    const agentIdsForPresence = [
      ...new Set(
        agentDocs.map((document) =>
          String(document.get("agent_id") ?? document.id),
        ),
      ),
    ];
    const runtimeSessionDocs = activityOnly
      ? []
      : await queryByIds(
          "runtime_sessions",
          "agent_id",
          agentIdsForPresence,
          (query) => query.where("status", "==", "active").limit(100),
        );
    // Terminal authorization barrier. The initial discovery queries may race
    // a role revocation or a public-to-private transition on another API
    // replica. Re-read the caller's roles and candidate mesh lifecycle in one
    // Firestore transaction immediately before building the response so a
    // stale all-member role row cannot widen access.
    let terminalMeshState = new Map<
      string,
      { visibility: string; lifecycle: string }
    >();
    let terminalRoleDocs: DocumentSnapshot[] = [];
    let terminalAgentMembershipDocs: DocumentSnapshot[] | undefined;
    {
      const terminal = await this.firestore.runTransaction(
        async (transaction) => {
          const rolesSnapshot = input.accountId
            ? await transaction.get(
                this.firestore
                  .collection(this.collection("mesh_human_roles"))
                  .where("account_id", "==", input.accountId)
                  .limit(500),
              )
            : undefined;
          const membershipsSnapshot = input.agentId
            ? await transaction.get(
                this.firestore
                  .collection(this.collection("mesh_agent_memberships"))
                  .where("agent_id", "==", input.agentId)
                  .where("status", "in", ["joined", "pending"])
                  .limit(101),
              )
            : undefined;
          if (membershipsSnapshot && membershipsSnapshot.size > 100) {
            throw new Error("mesh_membership_limit_exceeded");
          }
          const meshSnapshots: DocumentSnapshot[] = [];
          for (const meshId of meshIds) {
            meshSnapshots.push(
              await transaction.get(this.doc("meshes", meshId)),
            );
          }
          // Re-read every role for the already-authorized mesh set in the same
          // transaction. The initial discovery query can be stale when a role
          // is removed on another API replica, which would otherwise resurrect
          // a collaborator in governance responses.
          const currentRoleDocs: DocumentSnapshot[] = [];
          if (!activityOnly) {
            for (const group of chunks(meshIds)) {
              if (!group.length) continue;
              const snapshot = await transaction.get(
                this.firestore
                  .collection(this.collection("mesh_human_roles"))
                  .where("mesh_id", "in", group),
              );
              currentRoleDocs.push(...snapshot.docs);
            }
          }
          return {
            roleMeshIds: new Set(
              rolesSnapshot?.docs.map((document) =>
                String(document.get("mesh_id")),
              ) ?? [],
            ),
            joinedMeshIds: new Set(
              membershipsSnapshot?.docs
                .filter((document) => document.get("status") === "joined")
                .map((document) => String(document.get("mesh_id"))) ?? [],
            ),
            membershipDocs: membershipsSnapshot?.docs ?? [],
            meshState: new Map(
              meshSnapshots
                .filter((document) => document.exists)
                .map((document) => [
                  String(document.get("mesh_id") ?? document.id),
                  {
                    visibility: String(document.get("visibility") ?? "private"),
                    lifecycle: String(document.get("lifecycle") ?? "active"),
                  },
                ]),
            ),
            roleDocs: currentRoleDocs,
          };
        },
      );
      callerRoleMeshIds = terminal.roleMeshIds;
      terminalAgentJoinedMeshIds = terminal.joinedMeshIds;
      terminalAgentMembershipDocs = terminal.membershipDocs;
      terminalMeshState = terminal.meshState;
      terminalRoleDocs = terminal.roleDocs;
    }
    // Downstream directory/governance projections must use the transaction
    // consistent roster rather than the earlier discovery snapshot.
    roleDocs = terminalRoleDocs;
    const roleAccountIds = [
      ...new Set(
        roleDocs.map((document) => String(document.get("account_id"))),
      ),
    ];
    const accountIds = input.accountId
      ? [input.accountId, ...roleAccountIds]
      : roleAccountIds;
    const accountDocs = await getByIds("accounts", accountIds);
    const accounts = accountDocs.map((document) => ({
      accountId: String(document.get("account_id") ?? document.id),
      email: String(document.get("email") ?? ""),
      displayName: String(document.get("display_name") ?? ""),
      createdAt: String(document.get("created_at") ?? this.now()),
    }));
    const agents = agentDocs.map((document) => {
      const interests = document.get("interests");
      const attention = document.get("attention_policy");
      return {
        agentId: String(document.get("agent_id") ?? document.id),
        ownerAccountId: String(document.get("owner_account_id")),
        name: String(document.get("name") ?? ""),
        handle: String(document.get("handle") ?? ""),
        tagline: String(document.get("tagline") ?? ""),
        interests: Array.isArray(interests) ? interests.map(String) : [],
        personality: String(document.get("personality") ?? ""),
        attention: (attention && typeof attention === "object"
          ? attention
          : {}) as Record<string, unknown>,
        runtime: String(document.get("runtime") ?? "other") as RuntimeKind,
        runtimeLabel: String(document.get("runtime_label") ?? ""),
        runtimeSubject: String(document.get("runtime_subject") ?? ""),
        publicKeyPem: String(document.get("public_key_pem") ?? ""),
        definitionDigest:
          document.get("definition_digest") == null
            ? null
            : String(document.get("definition_digest")),
        createdAt: String(document.get("created_at") ?? this.now()),
        updatedAt: String(document.get("updated_at") ?? this.now()),
      };
    });
    const agentIds = new Set(agents.map((agent) => agent.agentId));
    const roles = roleDocs.map((document) => ({
      meshId: String(document.get("mesh_id")),
      accountId: String(document.get("account_id")),
      role: String(document.get("role")) as "owner" | "steward" | "observer",
      createdAt: String(document.get("created_at") ?? this.now()),
      updatedAt: String(document.get("updated_at") ?? this.now()),
    }));
    // Replace every caller membership discovered earlier with the transaction-
    // consistent rows. A public mesh can remain visible after withdrawal, but
    // it must not retain a stale `joined` marker that widens joined-only reads.
    const currentMembershipDocs = input.agentId
      ? [
          ...membershipDocs.filter(
            (document) => String(document.get("agent_id")) !== input.agentId,
          ),
          ...(terminalAgentMembershipDocs ?? []),
        ]
      : membershipDocs;
    const memberships = currentMembershipDocs.map((document) => ({
      meshId: String(document.get("mesh_id")),
      agentId: String(document.get("agent_id")),
      status: String(document.get("status")) as
        "joined" | "pending" | "left" | "removed",
      attentionPolicy: (document.get("attention_policy") ?? {}) as Record<
        string,
        unknown
      >,
      admissionProvenance: String(
        document.get("admission_provenance") ?? "open",
      ) as "open" | "approval" | "invite",
      joinedAt:
        document.get("joined_at") == null
          ? null
          : String(document.get("joined_at")),
      updatedAt: String(document.get("updated_at") ?? this.now()),
    }));
    const meshes = meshDocs
      .map((document) => ({
        meshId: String(document.get("mesh_id") ?? document.id),
        ownerAccountId:
          document.get("owner_account_id") == null
            ? null
            : String(document.get("owner_account_id")),
        name: String(document.get("name") ?? ""),
        description: String(document.get("description") ?? ""),
        visibility: String(document.get("visibility") ?? "private") as
          "public" | "unlisted" | "private",
        admission: String(document.get("admission") ?? "invite_only") as
          "open" | "approval" | "invite_only",
        lifecycle: String(document.get("lifecycle") ?? "active") as
          "active" | "archived",
        createdAt: String(document.get("created_at") ?? this.now()),
        updatedAt: String(document.get("updated_at") ?? this.now()),
      }))
      .filter(
        (mesh) =>
          // The terminal transaction is the only visibility authority for the
          // response. Initial discovery may have raced a public-to-private or
          // archive transition; never fall back to the earlier snapshot.
          terminalMeshState.get(mesh.meshId)?.lifecycle === "active" &&
          (terminalMeshState.get(mesh.meshId)?.visibility === "public" ||
            Boolean(input.accountId && callerRoleMeshIds.has(mesh.meshId)) ||
            Boolean(
              input.agentId &&
              terminalAgentJoinedMeshIds?.has(mesh.meshId) === true,
            )),
      );
    const scopedMeshIds = new Set(meshes.map((mesh) => mesh.meshId));
    const scopedActivity = activity
      ? {
          ...activity,
          meshes: activity.meshes.filter((mesh) =>
            scopedMeshIds.has(mesh.meshId),
          ),
          topics: activity.topics.filter((topic) =>
            scopedMeshIds.has(topic.meshId),
          ),
          agents: activity.agents.filter((agent) =>
            scopedMeshIds.has(agent.meshId),
          ),
          links: activity.links.filter((link) =>
            scopedMeshIds.has(link.meshId),
          ),
        }
      : undefined;
    const topics = topicDocs
      .map((document) => {
        const tags = document.get("tags");
        const tagsJson = document.get("tags_json");
        let normalizedTags: string[] = [];
        if (Array.isArray(tags)) {
          normalizedTags = tags.map(String);
        } else if (typeof tagsJson === "string") {
          try {
            const parsed = JSON.parse(tagsJson) as unknown;
            if (Array.isArray(parsed)) normalizedTags = parsed.map(String);
          } catch {
            normalizedTags = [];
          }
        }
        return {
          topicId: String(document.get("topic_id") ?? document.id),
          meshId: String(document.get("mesh_id")),
          name: String(document.get("name") ?? ""),
          title: String(document.get("title") ?? ""),
          description: String(document.get("description") ?? ""),
          tags: normalizedTags,
          createdAt: String(document.get("created_at") ?? this.now()),
        };
      })
      .filter((topic) => scopedMeshIds.has(topic.meshId));
    const nowMs = Date.parse(now);
    const posts = postDocs
      .map((document) => ({
        postId: String(document.get("post_id") ?? document.id),
        meshId: String(document.get("mesh_id")),
        topicId: String(document.get("topic_id")),
        agentId: String(document.get("agent_id")),
        sessionId: String(document.get("session_id") ?? ""),
        parentPostId:
          document.get("parent_post_id") == null
            ? null
            : String(document.get("parent_post_id")),
        body: String(document.get("body") ?? ""),
        moderationState: String(
          document.get("moderation_state") ?? "published",
        ) as "published" | "quarantined" | "removed" | "redacted",
        moderationReason:
          document.get("moderation_reason") == null
            ? null
            : String(document.get("moderation_reason")),
        createdAt: String(document.get("created_at") ?? this.now()),
        expiresAt:
          document.get("expires_at") == null
            ? null
            : String(document.get("expires_at")),
      }))
      .filter((post) => scopedMeshIds.has(post.meshId))
      .map((post) => {
        const expired =
          post.expiresAt != null && Date.parse(post.expiresAt) <= nowMs;
        return expired || post.moderationState !== "published"
          ? { ...post, body: "" }
          : post;
      });
    // Topic deletion intentionally leaves derived follow documents for the
    // retention/cleanup worker. Never hydrate those orphaned rows into the
    // SQLite compatibility projection: its topic foreign key is stricter than
    // Firestore's document model and a deleted topic must not break refreshes.
    const scopedTopicIds = new Set(topics.map((topic) => topic.topicId));
    const follows = followDocs
      .filter(
        (document) =>
          document.get("following") !== false &&
          agentIds.has(String(document.get("agent_id"))) &&
          scopedTopicIds.has(String(document.get("topic_id"))),
      )
      .map((document) => ({
        topicId: String(document.get("topic_id")),
        agentId: String(document.get("agent_id")),
        updatedAt: String(document.get("updated_at") ?? this.now()),
      }));
    const runtimeSessions = runtimeSessionDocs.map((document) => ({
      tokenHash: String(document.get("token_hash") ?? ""),
      agentId: String(document.get("agent_id")),
      bindingId: String(
        document.get("binding_id") ?? document.get("pairing_id") ?? "",
      ),
      sessionId: String(document.get("session_id") ?? document.id),
      runtimeKind: String(
        document.get("runtime_kind") ?? "other",
      ) as RuntimeKind,
      authorityEpoch: Number(document.get("authority_epoch") ?? 0),
      createdAt: String(document.get("created_at") ?? this.now()),
      expiresAt: String(document.get("expires_at") ?? this.now()),
      lastSeenAt: String(document.get("last_seen_at") ?? this.now()),
      status: String(
        document.get("status") ?? "active",
      ) as RepositoryRuntimeSession["status"],
      supersedingSessionId:
        document.get("superseding_session_id") == null
          ? null
          : String(document.get("superseding_session_id")),
    }));
    return {
      accounts,
      agents,
      meshes,
      topics,
      humanRoles: roles.filter((role) => scopedMeshIds.has(role.meshId)),
      memberships: memberships.filter((membership) =>
        scopedMeshIds.has(membership.meshId),
      ),
      runtimeSessions,
      posts,
      follows,
      ...(scopedActivity ? { activity: scopedActivity } : {}),
      publicMeshesTruncated: publicMeshSnapshot.truncated,
    };
  }

  private meshDirectoryMesh(document: DocumentSnapshot): RepositoryMeshInput {
    return {
      meshId: String(document.get("mesh_id") ?? document.id),
      ownerAccountId:
        document.get("owner_account_id") == null
          ? null
          : String(document.get("owner_account_id")),
      name: String(document.get("name") ?? ""),
      description: String(document.get("description") ?? ""),
      visibility: String(
        document.get("visibility") ?? "private",
      ) as RepositoryMeshInput["visibility"],
      admission: String(
        document.get("admission") ?? "invite_only",
      ) as RepositoryMeshInput["admission"],
      lifecycle: String(
        document.get("lifecycle") ?? "active",
      ) as RepositoryMeshInput["lifecycle"],
      createdAt: String(document.get("created_at") ?? this.now()),
      updatedAt: String(document.get("updated_at") ?? this.now()),
    };
  }

  private meshDirectoryTopic(document: DocumentSnapshot): RepositoryTopicInput {
    const rawTags = document.get("tags") ?? document.get("tags_json") ?? [];
    let tags: string[] = [];
    if (Array.isArray(rawTags)) tags = rawTags.map(String);
    else if (typeof rawTags === "string") {
      try {
        const parsed = JSON.parse(rawTags) as unknown;
        if (Array.isArray(parsed)) tags = parsed.map(String);
      } catch {
        tags = [];
      }
    }
    return {
      topicId: String(document.get("topic_id") ?? document.id),
      meshId: String(document.get("mesh_id") ?? ""),
      name: String(document.get("name") ?? ""),
      title: String(document.get("title") ?? document.get("name") ?? ""),
      description: String(document.get("description") ?? ""),
      tags,
      createdAt: String(document.get("created_at") ?? this.now()),
    };
  }

  private meshDirectoryRole(
    document: DocumentSnapshot | undefined,
  ): "owner" | "steward" | "observer" | null {
    if (!document?.exists) return null;
    const role = String(document.get("role") ?? "");
    return role === "owner" || role === "steward" || role === "observer"
      ? role
      : null;
  }

  private async boundedDirectoryQueryByMeshIds(
    collection: string,
    meshIds: string[],
    maxRows: number,
    extra: (query: Query) => Query = (query) => query,
  ): Promise<{ docs: DocumentSnapshot[]; truncated: boolean }> {
    const unique = [...new Set(meshIds)].filter(Boolean);
    const docs: DocumentSnapshot[] = [];
    for (let index = 0; index < unique.length; index += 30) {
      const remaining = maxRows - docs.length;
      if (remaining <= 0) return { docs, truncated: true };
      const group = unique.slice(index, index + 30);
      const snapshot = await extra(
        this.firestore
          .collection(this.collection(collection))
          .where("mesh_id", "in", group),
      )
        .limit(remaining + 1)
        .get();
      if (snapshot.size > remaining) {
        docs.push(...snapshot.docs.slice(0, remaining));
        return { docs, truncated: true };
      }
      docs.push(...snapshot.docs);
      if (docs.length >= maxRows && index + 30 < unique.length) {
        return { docs, truncated: true };
      }
    }
    return { docs, truncated: false };
  }

  private async meshDirectoryAccounts(
    roleDocs: DocumentSnapshot[],
  ): Promise<Map<string, RepositoryAccount>> {
    const accountIds = [
      ...new Set(
        roleDocs.map((document) => String(document.get("account_id") ?? "")),
      ),
    ].filter(Boolean);
    const accounts = new Map<string, RepositoryAccount>();
    for (let index = 0; index < accountIds.length; index += 100) {
      const group = accountIds.slice(index, index + 100);
      const snapshots = await this.firestore.getAll(
        ...group.map((accountId) => this.doc("accounts", accountId)),
      );
      for (const document of snapshots) {
        if (!document.exists) continue;
        accounts.set(document.id, {
          accountId: document.id,
          email: String(document.get("email") ?? ""),
          displayName: String(document.get("display_name") ?? ""),
          createdAt: String(document.get("created_at") ?? this.now()),
        });
      }
    }
    return accounts;
  }

  private meshDirectoryEntries(input: {
    accountId: string;
    meshDocs: DocumentSnapshot[];
    callerRoleDocs: DocumentSnapshot[];
    membershipDocs: DocumentSnapshot[];
    topicDocs: DocumentSnapshot[];
    roleDocs: DocumentSnapshot[];
    accounts: Map<string, RepositoryAccount>;
    truncated: boolean;
  }): RepositoryMeshDirectoryEntry[] {
    const callerRoles = new Map(
      input.callerRoleDocs
        .map(
          (document) =>
            [
              String(document.get("mesh_id") ?? ""),
              this.meshDirectoryRole(document),
            ] as const,
        )
        .filter((entry): entry is [string, "owner" | "steward" | "observer"] =>
          Boolean(entry[0] && entry[1]),
        ),
    );
    const membershipsByMesh = new Map<string, string[]>();
    for (const document of input.membershipDocs) {
      if (document.get("status") !== "joined") continue;
      const meshId = String(document.get("mesh_id") ?? "");
      const agentId = String(document.get("agent_id") ?? "");
      if (!meshId || !agentId) continue;
      const values = membershipsByMesh.get(meshId) ?? [];
      values.push(agentId);
      membershipsByMesh.set(meshId, values);
    }
    const topicsByMesh = new Map<string, RepositoryTopicInput[]>();
    for (const document of input.topicDocs) {
      const topic = this.meshDirectoryTopic(document);
      if (!topic.meshId) continue;
      const values = topicsByMesh.get(topic.meshId) ?? [];
      values.push(topic);
      topicsByMesh.set(topic.meshId, values);
    }
    const rolesByMesh = new Map<
      string,
      RepositoryMeshDirectoryEntry["roles"]
    >();
    for (const document of input.roleDocs) {
      const role = this.meshDirectoryRole(document);
      const meshId = String(document.get("mesh_id") ?? "");
      const accountId = String(document.get("account_id") ?? "");
      if (!role || !meshId || !accountId) continue;
      const account = input.accounts.get(accountId);
      const values = rolesByMesh.get(meshId) ?? [];
      values.push({
        accountId,
        role,
        displayName: account?.displayName ?? "",
        email: account?.email ?? "",
        createdAt: String(document.get("created_at") ?? this.now()),
        updatedAt: String(document.get("updated_at") ?? this.now()),
      });
      rolesByMesh.set(meshId, values);
    }
    return input.meshDocs
      .map((document) => this.meshDirectoryMesh(document))
      .filter((mesh) => {
        const role = callerRoles.get(mesh.meshId) ?? null;
        return (
          mesh.lifecycle === "active" &&
          (mesh.visibility === "public" || role !== null)
        );
      })
      .map((mesh) => ({
        mesh,
        role: callerRoles.get(mesh.meshId) ?? null,
        memberAgentIds: [
          ...new Set(membershipsByMesh.get(mesh.meshId) ?? []),
        ].sort(),
        topics: (topicsByMesh.get(mesh.meshId) ?? [])
          .map((topic) => ({
            topic,
            // The live activity endpoint owns aggregate refresh. Directory
            // navigation deliberately does not replay counter shards.
            activityCount: 0,
            recentActivityCount: 0,
            participantAgentIds: [],
            lastActivityAt: null,
          }))
          .sort(
            (left, right) =>
              left.topic.title.localeCompare(right.topic.title) ||
              left.topic.topicId.localeCompare(right.topic.topicId),
          ),
        roles: (rolesByMesh.get(mesh.meshId) ?? []).sort(
          (left, right) =>
            left.role.localeCompare(right.role) ||
            left.accountId.localeCompare(right.accountId),
        ),
        ...(input.truncated ? { truncated: true } : {}),
      }))
      .sort(
        (left, right) =>
          left.mesh.createdAt.localeCompare(right.mesh.createdAt) ||
          left.mesh.meshId.localeCompare(right.mesh.meshId),
      );
  }

  /**
   * Return a bounded metadata preview for browser navigation. The old path
   * reused loadProjection(), which read every membership, role, topic, agent,
   * session, and activity shard reachable from every public mesh.
   */
  async listMeshDirectoryForAccount(
    accountId: string,
  ): Promise<RepositoryMeshDirectoryEntry[]> {
    const [publicMeshes, accountRoles] = await Promise.all([
      this.firestore
        .collection(this.collection("meshes"))
        .where("visibility", "==", "public")
        .where("lifecycle", "==", "active")
        .limit(MAX_MESH_DIRECTORY_ENTRIES + 1)
        .get(),
      this.firestore
        .collection(this.collection("mesh_human_roles"))
        .where("account_id", "==", accountId)
        .limit(MAX_MESH_DIRECTORY_ENTRIES + 1)
        .get(),
    ]);
    const discoveredRoleDocs = accountRoles.docs
      .slice(0, MAX_MESH_DIRECTORY_ENTRIES)
      .sort((left, right) =>
        String(left.get("mesh_id") ?? left.id).localeCompare(
          String(right.get("mesh_id") ?? right.id),
        ),
      );
    const candidateMeshIds = [
      ...new Set([
        ...discoveredRoleDocs.map((document) =>
          String(document.get("mesh_id") ?? ""),
        ),
        ...publicMeshes.docs
          .slice(0, MAX_MESH_DIRECTORY_ENTRIES)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((document) => document.id),
      ]),
    ]
      .filter(Boolean)
      .slice(0, MAX_MESH_DIRECTORY_ENTRIES);
    if (!candidateMeshIds.length) return [];
    let truncated =
      publicMeshes.size > MAX_MESH_DIRECTORY_ENTRIES ||
      accountRoles.size > MAX_MESH_DIRECTORY_ENTRIES ||
      new Set([
        ...discoveredRoleDocs.map((document) =>
          String(document.get("mesh_id") ?? ""),
        ),
        ...publicMeshes.docs.map((document) => document.id),
      ]).size > MAX_MESH_DIRECTORY_ENTRIES;

    const initialMeshDocs = await this.firestore.getAll(
      ...candidateMeshIds.map((meshId) => this.doc("meshes", meshId)),
    );
    const discoveredCallerRoleIds = new Set(
      discoveredRoleDocs.map((document) =>
        String(document.get("mesh_id") ?? ""),
      ),
    );
    const initiallyVisibleMeshIds = initialMeshDocs
      .filter((document) => {
        const mesh = this.meshDirectoryMesh(document);
        return (
          document.exists &&
          mesh.lifecycle === "active" &&
          (mesh.visibility === "public" ||
            discoveredCallerRoleIds.has(mesh.meshId))
        );
      })
      .map((document) => document.id);
    if (!initiallyVisibleMeshIds.length) return [];

    const [memberships, topics] = await Promise.all([
      this.boundedDirectoryQueryByMeshIds(
        "mesh_agent_memberships",
        initiallyVisibleMeshIds,
        MAX_MESH_DIRECTORY_MEMBER_ROWS,
        (query) => query.where("status", "==", "joined"),
      ),
      this.boundedDirectoryQueryByMeshIds(
        "topics",
        initiallyVisibleMeshIds,
        MAX_MESH_DIRECTORY_TOPIC_ROWS,
      ),
    ]);
    truncated ||= memberships.truncated || topics.truncated;

    // Terminally re-read the candidate meshes and the caller's exact role in
    // one snapshot. A concurrent public-to-private transition cannot expose
    // the metadata gathered above to a non-member.
    const terminal = await this.firestore.runTransaction(
      async (transaction) => {
        const snapshots = await transaction.getAll(
          ...initiallyVisibleMeshIds.map((meshId) =>
            this.doc("meshes", meshId),
          ),
          ...initiallyVisibleMeshIds.map((meshId) =>
            this.doc("mesh_human_roles", `${meshId}:${accountId}`),
          ),
        );
        const meshDocs = snapshots.slice(0, initiallyVisibleMeshIds.length);
        const callerRoleDocs = snapshots.slice(initiallyVisibleMeshIds.length);
        const roleDocs: DocumentSnapshot[] = [];
        let rolesTruncated = false;
        for (
          let index = 0;
          index < initiallyVisibleMeshIds.length;
          index += 30
        ) {
          const remaining = MAX_MESH_DIRECTORY_ROLE_ROWS - roleDocs.length;
          if (remaining <= 0) {
            rolesTruncated = true;
            break;
          }
          const group = initiallyVisibleMeshIds.slice(index, index + 30);
          const page = await transaction.get(
            this.firestore
              .collection(this.collection("mesh_human_roles"))
              .where("mesh_id", "in", group)
              .limit(remaining + 1),
          );
          if (page.size > remaining) {
            roleDocs.push(...page.docs.slice(0, remaining));
            rolesTruncated = true;
            break;
          }
          roleDocs.push(...page.docs);
          if (
            roleDocs.length >= MAX_MESH_DIRECTORY_ROLE_ROWS &&
            index + 30 < initiallyVisibleMeshIds.length
          ) {
            rolesTruncated = true;
            break;
          }
        }
        return { meshDocs, callerRoleDocs, roleDocs, rolesTruncated };
      },
    );
    truncated ||= terminal.rolesTruncated;
    const roleDocs = [
      ...new Map(
        [...terminal.roleDocs, ...terminal.callerRoleDocs]
          .filter((document) => document.exists)
          .map((document) => [document.id, document]),
      ).values(),
    ];
    const accounts = await this.meshDirectoryAccounts(roleDocs);
    return this.meshDirectoryEntries({
      accountId,
      meshDocs: terminal.meshDocs,
      callerRoleDocs: terminal.callerRoleDocs,
      membershipDocs: memberships.docs,
      topicDocs: topics.docs,
      roleDocs,
      accounts,
      truncated,
    });
  }

  /** Read one mesh's bounded directory metadata without account-wide fan-out. */
  async findMeshDirectoryEntryForAccount(
    meshId: string,
    accountId: string,
  ): Promise<RepositoryMeshDirectoryEntry | null> {
    const [initialMesh, initialRole] = await Promise.all([
      this.doc("meshes", meshId).get(),
      this.doc("mesh_human_roles", `${meshId}:${accountId}`).get(),
    ]);
    const initialCallerRole = this.meshDirectoryRole(initialRole);
    if (!initialMesh.exists) return null;
    const initial = this.meshDirectoryMesh(initialMesh);
    if (
      initial.lifecycle !== "active" ||
      (initial.visibility !== "public" && initialCallerRole === null)
    ) {
      return null;
    }
    const [memberships, topics] = await Promise.all([
      this.firestore
        .collection(this.collection("mesh_agent_memberships"))
        .where("mesh_id", "==", meshId)
        .where("status", "==", "joined")
        .limit(MAX_MESH_DETAIL_MEMBER_ROWS + 1)
        .get(),
      this.firestore
        .collection(this.collection("topics"))
        .where("mesh_id", "==", meshId)
        .limit(MAX_TOPICS_PER_MESH + 1)
        .get(),
    ]);
    const terminal = await this.firestore.runTransaction(
      async (transaction) => {
        const [mesh, callerRole, roles] = await Promise.all([
          transaction.get(this.doc("meshes", meshId)),
          transaction.get(
            this.doc("mesh_human_roles", `${meshId}:${accountId}`),
          ),
          transaction.get(
            this.firestore
              .collection(this.collection("mesh_human_roles"))
              .where("mesh_id", "==", meshId)
              .limit(MAX_MESH_DETAIL_ROLE_ROWS + 1),
          ),
        ]);
        return { mesh, callerRole, roles };
      },
    );
    const terminalCallerRole = this.meshDirectoryRole(terminal.callerRole);
    if (!terminal.mesh.exists) return null;
    const finalMesh = this.meshDirectoryMesh(terminal.mesh);
    if (
      finalMesh.lifecycle !== "active" ||
      (finalMesh.visibility !== "public" && terminalCallerRole === null)
    ) {
      return null;
    }
    const roleDocs = [
      ...new Map(
        [
          ...terminal.roles.docs.slice(0, MAX_MESH_DETAIL_ROLE_ROWS),
          terminal.callerRole,
        ]
          .filter((document) => document.exists)
          .map((document) => [document.id, document]),
      ).values(),
    ];
    const accounts = await this.meshDirectoryAccounts(roleDocs);
    return (
      this.meshDirectoryEntries({
        accountId,
        meshDocs: [terminal.mesh],
        callerRoleDocs: [terminal.callerRole],
        membershipDocs: memberships.docs.slice(0, MAX_MESH_DETAIL_MEMBER_ROWS),
        topicDocs: topics.docs.slice(0, MAX_TOPICS_PER_MESH),
        roleDocs,
        accounts,
        truncated:
          memberships.size > MAX_MESH_DETAIL_MEMBER_ROWS ||
          topics.size > MAX_TOPICS_PER_MESH ||
          terminal.roles.size > MAX_MESH_DETAIL_ROLE_ROWS,
      })[0] ?? null
    );
  }

  async ensureEmptyProduction(): Promise<void> {
    const now = this.now();
    const bootstrapRef = this.doc("system", "bootstrap");
    const bootstrap = await bootstrapRef.get();
    const authorityBootstrapMissing = !bootstrap.exists;
    const projectionBootstrap = await readProjectionBootstrap(
      this.topologyFirestore,
      this.prefix,
    );
    if (projectionBootstrap.exists && !projectionBootstrap.valid) {
      throw new Error("topology_projection_bootstrap_invalid");
    }
    // The topology projection may live in a separate Firestore database. A
    // launch marker in the authority database alone cannot prove that this
    // aggregate store is clean: a stale projections database would otherwise
    // pass bootstrap and immediately expose old activity to every viewer.
    // Before creating the first authority generation, do an inexpensive
    // preflight scan. The shared marker transaction repeats this scan after
    // the authority transaction, closing the race with a concurrent worker.
    if (authorityBootstrapMissing)
      await assertProjectionEmpty(this.topologyFirestore, this.prefix);
    if (!bootstrap.exists) {
      // A new production project may be initialized exactly once. If a
      // project already contains user data but has no launch marker, stop
      // rather than silently treating prototype records as production state.
      const protectedCollections = [
        // Meshes, topics, and the canonical system bootstrap marker are
        // validated below rather than treated as empty; the rest of the
        // authority inventory must be completely absent on first launch.
        ...AUTHORITY_COLLECTIONS.filter(
          (name) => !["meshes", "system", "topics"].includes(name),
        ),
        "topology_shards",
        "topology_events",
        "topology_activity_totals",
        "topology_activity_buckets",
        "topology_activity_recent",
        "topology_activity_snapshots",
      ];
      const readAll = async (name: string): Promise<DocumentSnapshot[]> => {
        const documents: DocumentSnapshot[] = [];
        let query = this.firestore
          .collection(this.collection(name))
          .orderBy(FieldPath.documentId())
          .limit(500);
        while (true) {
          const page = await query.get();
          documents.push(...page.docs);
          if (page.size < 500) return documents;
          query = query.startAfter(page.docs[page.docs.length - 1]!);
        }
      };
      const [protectedSnapshots, meshes, topics, systemDocs] =
        await Promise.all([
          Promise.all(
            protectedCollections.map((name) =>
              this.firestore.collection(this.collection(name)).limit(1).get(),
            ),
          ),
          readAll("meshes"),
          readAll("topics"),
          readAll("system"),
        ]);
      const canonicalMesh = meshes.find(
        (document) => document.id === "mesh-public",
      );
      const meshMatches =
        !canonicalMesh ||
        (canonicalMesh.get("mesh_id") === "mesh-public" &&
          canonicalMesh.get("name") === "Public mesh" &&
          canonicalMesh.get("description") ===
            "The open commons for agent conversation." &&
          canonicalMesh.get("visibility") === "public" &&
          canonicalMesh.get("admission") === "open" &&
          canonicalMesh.get("lifecycle") === "active" &&
          canonicalMesh.get("owner_account_id") == null);
      const unexpectedMeshes =
        meshes.length !== (canonicalMesh ? 1 : 0) || !meshMatches;
      const expectedTopicIds = new Set(BOOTSTRAP_TOPICS.map(([id]) => id));
      const unexpectedTopics =
        topics.length > expectedTopicIds.size ||
        topics.some((document) => {
          const definition = BOOTSTRAP_TOPICS.find(
            ([id]) => id === document.id,
          );
          if (!definition) return true;
          const [, name, title, description, tags] = definition;
          return (
            document.get("topic_id") !== document.id ||
            document.get("mesh_id") !== "mesh-public" ||
            document.get("name") !== name ||
            document.get("title") !== title ||
            document.get("description") !== description ||
            document.get("tags_json") !== JSON.stringify(tags)
          );
        });
      const taxonomy = systemDocs.find(
        (document) => document.id === "taxonomy",
      );
      const taxonomyTopics = taxonomy?.get("topics");
      const taxonomyMatches =
        !taxonomy ||
        (taxonomy.get("key") === "taxonomy" &&
          Array.isArray(taxonomyTopics) &&
          JSON.stringify(taxonomyTopics) ===
            JSON.stringify(["connections", "ideas", "observations"]));
      const unexpectedSystem =
        systemDocs.some(
          (document) =>
            document.id !== "taxonomy" && document.id !== "bootstrap",
        ) || !taxonomyMatches;
      if (
        protectedSnapshots.some((snapshot) => !snapshot.empty) ||
        unexpectedMeshes ||
        unexpectedTopics ||
        unexpectedSystem
      ) {
        throw new Error("production_store_not_empty");
      }
      if (!this.projectionBootstrapWriter) {
        // Production API replicas intentionally cannot create the launch
        // attestation. A one-shot bootstrap identity performs that operation
        // before traffic is admitted; keeping this boundary here makes an API
        // rollout fail closed instead of accidentally assuming ownership of
        // the topology database.
        throw new Error("production_bootstrap_required");
      }
    }
    await this.firestore.runTransaction(async (transaction) => {
      const existingBootstrap = await transaction.get(bootstrapRef);
      if (existingBootstrap.exists) return;
      const meshRef = this.doc("meshes", "mesh-public");
      const taxonomyRef = this.doc("system", "taxonomy");
      const topicRefs = BOOTSTRAP_TOPICS.map(([id]) => this.doc("topics", id));
      // Firestore transactions require every read to happen before the first
      // write. Read the complete bootstrap set up front so an empty clean
      // project can initialize without a transaction-ordering failure.
      const [mesh, taxonomy, topicSnapshots] = await Promise.all([
        transaction.get(meshRef),
        transaction.get(taxonomyRef),
        Promise.all(topicRefs.map((ref) => transaction.get(ref))),
      ]);
      if (!mesh.exists) {
        transaction.create(meshRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          mesh_id: "mesh-public",
          name: "Public mesh",
          description: "The open commons for agent conversation.",
          visibility: "public",
          admission: "open",
          lifecycle: "active",
          owner_account_id: null,
          created_at: now,
          updated_at: now,
        });
      }
      if (!taxonomy.exists) {
        transaction.create(taxonomyRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          key: "taxonomy",
          topics: ["connections", "ideas", "observations"],
          created_at: now,
        });
      }
      for (const [
        index,
        [id, name, title, description, tags],
      ] of BOOTSTRAP_TOPICS.entries()) {
        const topicRef = topicRefs[index]!;
        const topic = topicSnapshots[index]!;
        if (!topic.exists) {
          transaction.create(topicRef, {
            contract_version: MESHR_CONTRACT_MAJOR,
            topic_id: id,
            mesh_id: "mesh-public",
            name,
            title,
            description,
            tags_json: JSON.stringify(tags),
            created_at: now,
          });
        }
      }
      transaction.create(bootstrapRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        key: "bootstrap",
        bootstrap_id: randomUUID(),
        initialized_at: now,
        empty_launch: true,
      });
    });

    // A generation fence prevents a marker left by a previous empty launch
    // from being mistaken for the marker belonging to this authority store.
    // Older prototype markers did not carry a generation; derive a stable
    // value from their immutable initialization timestamp once, then use the
    // same value in every replica and in the projection attestation.
    let currentBootstrap = await bootstrapRef.get();
    if (!currentBootstrap.exists)
      throw new Error("production_bootstrap_missing");
    const existingBootstrapId = currentBootstrap.get("bootstrap_id");
    let authorityBootstrapId: string;
    if (typeof existingBootstrapId === "string" && existingBootstrapId.trim()) {
      authorityBootstrapId = existingBootstrapId.trim();
    } else {
      const initializedAt = currentBootstrap.get("initialized_at");
      if (typeof initializedAt !== "string" || !initializedAt.trim()) {
        throw new Error("production_bootstrap_generation_missing");
      }
      authorityBootstrapId = createHash("sha256")
        .update(`meshr-bootstrap:v1:${initializedAt}`)
        .digest("hex");
      await this.firestore.runTransaction(async (transaction) => {
        const existing = await transaction.get(bootstrapRef);
        if (!existing.exists) throw new Error("production_bootstrap_missing");
        const current = existing.get("bootstrap_id");
        if (typeof current === "string" && current.trim()) return;
        transaction.update(bootstrapRef, {
          bootstrap_id: authorityBootstrapId,
        });
      });
      currentBootstrap = await bootstrapRef.get();
      const persistedBootstrapId = currentBootstrap.get("bootstrap_id");
      if (
        typeof persistedBootstrapId !== "string" ||
        !persistedBootstrapId.trim()
      ) {
        throw new Error("production_bootstrap_generation_missing");
      }
      authorityBootstrapId = persistedBootstrapId.trim();
    }

    await ensureProjectionBootstrap(this.topologyFirestore, now, {
      collectionPrefix: this.prefix,
      expectedAuthorityBootstrapId: authorityBootstrapId,
      // If this caller observed an absent authority marker at process start,
      // always re-scan an existing projection marker inside the transaction.
      // This is the first-launch race fence; an existing generation can use
      // the marker as a stable readiness attestation.
      forceScanExistingMarker:
        authorityBootstrapMissing || this.forceProjectionBootstrapScan,
      createIfMissing: this.projectionBootstrapWriter,
    });
  }

  async findAccountByProvider(
    provider: SocialProvider,
    subject: string,
  ): Promise<RepositoryAccount | null> {
    const snapshot = await this.doc(
      "provider_identities",
      provider + ":" + subject,
    ).get();
    if (!snapshot.exists) return null;
    const accountId = String(snapshot.get("account_id"));
    const account = await this.doc("accounts", accountId).get();
    if (!account.exists) return null;
    return {
      accountId,
      email: String(account.get("email")),
      displayName: String(account.get("display_name")),
      createdAt: String(account.get("created_at")),
    };
  }

  async findAccountById(accountId: string): Promise<RepositoryAccount | null> {
    const snapshot = await this.doc("accounts", accountId).get();
    if (!snapshot.exists) return null;
    return {
      accountId,
      email: String(snapshot.get("email")),
      displayName: String(snapshot.get("display_name")),
      createdAt: String(snapshot.get("created_at")),
    };
  }

  async findAccountByEmail(email: string): Promise<RepositoryAccount | null> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return null;
    const snapshot = await this.firestore
      .collection(this.collection("accounts"))
      .where("email", "==", normalized)
      .limit(1)
      .get();
    const account = snapshot.docs[0];
    if (!account) return null;
    return {
      accountId: account.id,
      email: String(account.get("email")),
      displayName: String(account.get("display_name")),
      createdAt: String(account.get("created_at")),
    };
  }

  async createPasswordAccount(input: {
    accountId: string;
    email: string;
    displayName: string;
    passwordHash: string;
    createdAt: string;
  }): Promise<RepositoryAccount> {
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    if (!/^usr_[A-Za-z0-9_-]{16,128}$/.test(input.accountId) || !email || !displayName) {
      throw new Error("account_invalid");
    }
    const accountRef = this.doc("accounts", input.accountId);
    await this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(
        this.firestore
          .collection(this.collection("accounts"))
          .where("email", "==", email)
          .limit(1),
      );
      if (!existing.empty) throw new Error("account_exists");
      const account = await transaction.get(accountRef);
      if (account.exists) throw new Error("account_exists");
      transaction.create(accountRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        account_id: input.accountId,
        email,
        display_name: displayName,
        password_hash: input.passwordHash,
        created_at: input.createdAt,
      });
    });
    return {
      accountId: input.accountId,
      email,
      displayName,
      createdAt: input.createdAt,
    };
  }

  async findPasswordAccountByEmail(
    emailValue: string,
  ): Promise<RepositoryPasswordAccount | null> {
    const email = emailValue.trim().toLowerCase();
    if (!email) return null;
    const snapshot = await this.firestore
      .collection(this.collection("accounts"))
      .where("email", "==", email)
      .limit(1)
      .get();
    const document = snapshot.docs[0];
    if (!document) return null;
    const passwordHash = String(document.get("password_hash") ?? "");
    if (!passwordHash) return null;
    return {
      account: {
        accountId: document.id,
        email: String(document.get("email")),
        displayName: String(document.get("display_name")),
        createdAt: String(document.get("created_at")),
      },
      passwordHash,
    };
  }

  async provisionResidentPrincipal(
    input: RepositoryResidentPrincipalInput,
  ): Promise<RepositoryResidentPrincipalResult> {
    const principalKey = input.principalKey.trim().toLowerCase();
    const email = input.email.trim().toLowerCase();
    const displayName = input.displayName.trim();
    const expectedAccountId =
      "usr_" +
      createHash("sha256")
        .update(`meshr-resident:v1:${principalKey}`)
        .digest("hex")
        .slice(0, 24);
    const createdAtMs = Date.parse(input.session.createdAt);
    const expiresAtMs = Date.parse(input.session.expiresAt);
    const absoluteExpiresAtMs = Date.parse(input.session.absoluteExpiresAt);
    if (
      !/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(principalKey) ||
      input.accountId !== expectedAccountId ||
      !email ||
      email.length > 254 ||
      !displayName ||
      displayName.length > 80 ||
      !/^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[^$]+\$[^$]+$/.test(input.passwordHash) ||
      !input.operator.trim() ||
      input.operator.trim().length > 128 ||
      !input.purpose.trim() ||
      input.purpose.trim().length > 500 ||
      !/^[a-z0-9][a-z0-9_.:-]{0,127}$/i.test(input.generation) ||
      !/^[a-f0-9]{64}$/.test(input.manifestDigest) ||
      !/^[a-f0-9]{64}$/.test(input.disclosureTextHash) ||
      !/^[a-f0-9]{64}$/.test(input.session.tokenHash) ||
      !input.session.csrfToken ||
      input.session.csrfToken.length > 256 ||
      !Number.isFinite(createdAtMs) ||
      !Number.isFinite(expiresAtMs) ||
      !Number.isFinite(absoluteExpiresAtMs) ||
      expiresAtMs <= createdAtMs ||
      absoluteExpiresAtMs < expiresAtMs
    ) {
      throw new Error("resident_principal_invalid");
    }
    let disclosureUrl: URL;
    try {
      disclosureUrl = new URL(input.disclosureUrl);
    } catch {
      throw new Error("resident_disclosure_invalid");
    }
    if (disclosureUrl.protocol !== "https:")
      throw new Error("resident_disclosure_invalid");
    if (
      input.audit.action !== "resident_principal.provisioned" ||
      input.audit.actorType !== "system" ||
      input.audit.resourceType !== "resident_principal" ||
      input.audit.resourceId !== principalKey ||
      input.audit.createdAt !== input.session.createdAt
    ) {
      throw new Error("resident_audit_invalid");
    }

    const principalDocumentId =
      "resident_" +
      createHash("sha256")
        .update(`meshr-resident-registry:v1:${principalKey}`)
        .digest("hex")
        .slice(0, 40);
    const principalRef = this.doc("resident_principals", principalDocumentId);
    const accountRef = this.doc("accounts", input.accountId);
    const sessionRef = this.doc("human_sessions", input.session.tokenHash);
    const auditRef = this.doc("audit_events", input.audit.auditId);

    return this.firestore.runTransaction(async (transaction) => {
      const principal = await transaction.get(principalRef);
      const previousSessionHash =
        principal.exists &&
        typeof principal.get("current_session_hash") === "string"
          ? String(principal.get("current_session_hash"))
          : "";
      if (principal.exists && !/^[a-f0-9]{64}$/.test(previousSessionHash)) {
        throw new Error("resident_registry_corrupt");
      }
      const previousSessionRef =
        previousSessionHash && previousSessionHash !== input.session.tokenHash
          ? this.doc("human_sessions", previousSessionHash)
          : undefined;
      const [account, session, audit, previousSession, emailMatches] =
        await Promise.all([
          transaction.get(accountRef),
          transaction.get(sessionRef),
          transaction.get(auditRef),
          previousSessionRef
            ? transaction.get(previousSessionRef)
            : Promise.resolve(undefined),
          transaction.get(
            this.firestore
              .collection(this.collection("accounts"))
              .where("email", "==", email)
              .limit(1),
          ),
        ]);

      const emailOwner = emailMatches.docs[0];
      if (emailOwner && emailOwner.id !== input.accountId)
        throw new Error("resident_email_conflict");
      if (principal.exists) {
        if (
          principal.get("principal_key") !== principalKey ||
          principal.get("account_id") !== input.accountId ||
          !account.exists
        ) {
          throw new Error("resident_registry_corrupt");
        }
      } else if (account.exists) {
        // A deterministic account id must never silently claim an ordinary
        // account that was not created through the resident registry.
        throw new Error("resident_account_conflict");
      }
      if (
        account.exists &&
        String(account.get("email") ?? "").toLowerCase() !== email
      ) {
        throw new Error("resident_account_conflict");
      }

      const sameGeneration =
        principal.exists && principal.get("generation") === input.generation;
      if (sameGeneration) {
        if (
          principal.get("current_session_hash") !== input.session.tokenHash ||
          principal.get("manifest_digest") !== input.manifestDigest ||
          !account.exists ||
          !session.exists ||
          session.get("account_id") !== input.accountId
        ) {
          throw new Error("resident_generation_conflict");
        }
        if (!account.get("password_hash")) {
          transaction.update(accountRef, { password_hash: input.passwordHash });
        }
        if (
          principal.get("disclosure_text_hash") !== input.disclosureTextHash ||
          principal.get("disclosure_url") !== disclosureUrl.toString()
        ) {
          transaction.update(principalRef, {
            disclosure_text_hash: input.disclosureTextHash,
            disclosure_url: disclosureUrl.toString(),
            updated_at: this.now(),
          });
        }
        if (!audit.exists)
          transaction.create(auditRef, this.auditDocument(input.audit));
        return {
          account: {
            accountId: input.accountId,
            email,
            displayName: String(account.get("display_name")),
            createdAt: String(account.get("created_at")),
          },
          created: false,
          sessionRotated: false,
        };
      }
      if (session.exists) throw new Error("resident_session_conflict");
      if (audit.exists) throw new Error("resident_audit_conflict");

      const accountCreatedAt = account.exists
        ? String(account.get("created_at"))
        : input.session.createdAt;
      if (!account.exists) {
        transaction.create(accountRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          account_id: input.accountId,
          email,
          display_name: displayName,
          password_hash: input.passwordHash,
          created_at: accountCreatedAt,
        });
      } else {
        const accountUpdate: Record<string, string> = {};
        if (account.get("display_name") !== displayName) {
          accountUpdate.display_name = displayName;
        }
        // Older resident generations predate durable password admission. Add
        // the normal password authority exactly once, while preserving an
        // existing password chosen for the ordinary account.
        if (!String(account.get("password_hash") ?? "")) {
          accountUpdate.password_hash = input.passwordHash;
        }
        if (Object.keys(accountUpdate).length > 0) {
          transaction.update(accountRef, accountUpdate);
        }
      }
      transaction.create(sessionRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        token_hash: input.session.tokenHash,
        account_id: input.accountId,
        csrf_token: input.session.csrfToken,
        created_at: input.session.createdAt,
        expires_at: input.session.expiresAt,
        absolute_expires_at: input.session.absoluteExpiresAt,
        absolute_expires_at_ttl: ttlTimestamp(input.session.absoluteExpiresAt),
        last_seen_at: input.session.createdAt,
      });
      if (previousSessionRef && previousSession?.exists)
        transaction.delete(previousSessionRef);
      transaction.set(
        principalRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          principal_key: principalKey,
          account_id: input.accountId,
          operator: input.operator.trim(),
          purpose: input.purpose.trim(),
          generation: input.generation,
          manifest_digest: input.manifestDigest,
          disclosure_text_hash: input.disclosureTextHash,
          disclosure_url: disclosureUrl.toString(),
          current_session_hash: input.session.tokenHash,
          created_at: principal.exists
            ? principal.get("created_at")
            : input.session.createdAt,
          updated_at: input.session.createdAt,
        },
        { merge: false },
      );
      transaction.create(auditRef, this.auditDocument(input.audit));
      return {
        account: {
          accountId: input.accountId,
          email,
          displayName,
          createdAt: accountCreatedAt,
        },
        created: !account.exists,
        sessionRotated: Boolean(previousSessionHash),
      };
    });
  }

  async createSocialAccount(input: {
    provider: SocialProvider;
    subject: string;
    email: string;
    displayName: string;
  }): Promise<RepositoryAccount> {
    const now = this.now();
    const accountId =
      "usr_" +
      createHash("sha256")
        .update(input.provider + ":" + input.subject + ":" + now)
        .digest("hex")
        .slice(0, 24);
    const identityRef = this.doc(
      "provider_identities",
      input.provider + ":" + input.subject,
    );
    const accountRef = this.doc("accounts", accountId);
    return this.firestore.runTransaction(async (transaction) => {
      const identity = await transaction.get(identityRef);
      if (identity.exists) {
        const existingId = String(identity.get("account_id"));
        const existing = await transaction.get(
          this.doc("accounts", existingId),
        );
        if (!existing.exists) throw new Error("identity_account_missing");
        return {
          accountId: existingId,
          email: String(existing.get("email")),
          displayName: String(existing.get("display_name")),
          createdAt: String(existing.get("created_at")),
        };
      }
      const existingEmail = await transaction.get(
        this.firestore
          .collection(this.collection("accounts"))
          .where("email", "==", input.email)
          .limit(1),
      );
      if (!existingEmail.empty) throw new Error("identity_link_required");
      transaction.create(accountRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        account_id: accountId,
        email: input.email,
        display_name: input.displayName,
        created_at: now,
      });
      transaction.create(identityRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        provider: input.provider,
        subject: input.subject,
        account_id: accountId,
        email: input.email,
        created_at: now,
        last_seen_at: now,
      });
      return {
        accountId,
        email: input.email,
        displayName: input.displayName,
        createdAt: now,
      };
    });
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
    const identityRef = this.doc(
      "provider_identities",
      input.provider + ":" + input.subject,
    );
    await this.firestore.runTransaction(async (transaction) => {
      const accountRef = this.doc("accounts", input.accountId);
      const account = await transaction.get(accountRef);
      if (!account.exists) throw new Error("account_not_found");
      if (
        (input.reauthProvider === undefined) !==
        (input.reauthSubject === undefined)
      ) {
        throw new Error("identity_reauthentication_required");
      }
      if (input.humanSessionHash) {
        const session = await transaction.get(
          this.doc("human_sessions", input.humanSessionHash),
        );
        const nowMs = Date.parse(now);
        const valid =
          session.exists &&
          session.get("account_id") === input.accountId &&
          Number.isFinite(nowMs) &&
          Date.parse(String(session.get("expires_at") ?? "")) > nowMs &&
          Date.parse(String(session.get("absolute_expires_at") ?? "")) >
            nowMs &&
          Date.parse(String(session.get("last_seen_at") ?? "")) >
            nowMs - HUMAN_IDLE_SECONDS * 1_000;
        if (!valid) throw new Error("human_session_invalid");
      }
      const reauthIdentity =
        input.reauthProvider && input.reauthSubject
          ? await transaction.get(
              this.doc(
                "provider_identities",
                input.reauthProvider + ":" + input.reauthSubject,
              ),
            )
          : undefined;
      if (
        input.reauthProvider &&
        input.reauthSubject &&
        (!reauthIdentity?.exists ||
          reauthIdentity.get("account_id") !== input.accountId)
      ) {
        throw new Error("identity_reauthentication_required");
      }
      const identity = await transaction.get(identityRef);
      if (identity.exists && identity.get("account_id") !== input.accountId) {
        throw new Error("identity_already_linked");
      }
      if (
        identity.exists &&
        identity.get("account_id") === input.accountId &&
        String(identity.get("email") ?? "") === input.email
      ) {
        return;
      }
      transaction.set(identityRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        provider: input.provider,
        subject: input.subject,
        account_id: input.accountId,
        email: input.email,
        created_at: identity.exists ? identity.get("created_at") : now,
        last_seen_at: now,
      });
    });
  }

  async listProviderIdentities(accountId: string): Promise<
    Array<{
      provider: SocialProvider;
      email: string;
      linkedAt: string;
    }>
  > {
    const snapshot = await this.firestore
      .collection(this.collection("provider_identities"))
      .where("account_id", "==", accountId)
      .limit(10)
      .get();
    return snapshot.docs
      .map((document) => ({
        provider: String(document.get("provider")) as SocialProvider,
        email: String(document.get("email") ?? ""),
        linkedAt: String(document.get("created_at") ?? this.now()),
      }))
      .filter(
        (identity) =>
          identity.provider === "google" || identity.provider === "github",
      )
      .sort((left, right) => left.provider.localeCompare(right.provider));
  }

  async createHumanSession(input: {
    tokenHash: string;
    accountId: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    absoluteExpiresAt: string;
    socialRateLimit?: {
      subjectHash: string;
      capacity: number;
      refillPerSecond: number;
    };
  }): Promise<void> {
    const sessionRef = this.doc("human_sessions", input.tokenHash);
    const sessionDocument = {
      contract_version: MESHR_CONTRACT_MAJOR,
      token_hash: input.tokenHash,
      account_id: input.accountId,
      csrf_token: input.csrfToken,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      absolute_expires_at: input.absoluteExpiresAt,
      absolute_expires_at_ttl: ttlTimestamp(input.absoluteExpiresAt),
      last_seen_at: input.createdAt,
    };
    const rateLimit = input.socialRateLimit;
    if (!rateLimit) {
      await sessionRef.create(sessionDocument);
      return;
    }
    const nowMs = Date.parse(input.createdAt);
    if (
      !/^[a-f0-9]{64}$/.test(rateLimit.subjectHash) ||
      !Number.isSafeInteger(rateLimit.capacity) ||
      rateLimit.capacity < 1 ||
      !Number.isFinite(rateLimit.refillPerSecond) ||
      rateLimit.refillPerSecond <= 0 ||
      !Number.isSafeInteger(nowMs) ||
      nowMs < 0
    ) {
      throw new Error("invalid_social_session_rate_limit");
    }
    const accountHash = createHash("sha256")
      .update(input.accountId)
      .digest("hex");
    const buckets = Array.from(
      new Map(
        [
          {
            key: `social-session:subject:${rateLimit.subjectHash}`,
            scope: "subject",
          },
          {
            key: `social-session:account:${accountHash}`,
            scope: "account",
          },
        ].map((bucket) => [bucket.key, bucket] as const),
      ).values(),
    );
    await this.firestore.runTransaction(async (transaction) => {
      const snapshots: DocumentSnapshot[] = [];
      for (const bucket of buckets) {
        snapshots.push(
          await transaction.get(this.doc("quota_counters", bucket.key)),
        );
      }
      const bucketStates = snapshots.map((snapshot) => {
        const storedTokens = snapshot.get("tokens");
        const storedRefillMs = snapshot.get("last_refill_ms");
        const previousTokens = snapshot.exists
          ? storedTokens
          : rateLimit.capacity;
        const previousRefillMs = snapshot.exists ? storedRefillMs : nowMs;
        if (
          typeof previousTokens !== "number" ||
          !Number.isFinite(previousTokens) ||
          previousTokens < 0 ||
          previousTokens > rateLimit.capacity ||
          typeof previousRefillMs !== "number" ||
          !Number.isSafeInteger(previousRefillMs) ||
          previousRefillMs < 0
        ) {
          throw new Error("social_session_rate_limit_corrupt");
        }
        const elapsedSeconds = Math.max(0, (nowMs - previousRefillMs) / 1_000);
        return {
          available: Math.min(
            rateLimit.capacity,
            previousTokens + elapsedSeconds * rateLimit.refillPerSecond,
          ),
          // A slow replica must never move the refill cursor backwards and
          // grant the same elapsed interval again on a later request.
          refillMs: Math.max(nowMs, previousRefillMs),
        };
      });
      const exhaustedRetrySeconds = bucketStates
        .filter(({ available }) => available < 1)
        .map(({ available }) =>
          quotaRetryAfterSeconds(available, rateLimit.refillPerSecond),
        );
      if (exhaustedRetrySeconds.length > 0) {
        const retryAfterSeconds = Math.min(
          60,
          Math.max(1, ...exhaustedRetrySeconds),
        );
        throw new Error(`social_session_rate_limited:${retryAfterSeconds}`);
      }
      transaction.create(sessionRef, sessionDocument);
      for (let index = 0; index < buckets.length; index += 1) {
        const bucket = buckets[index]!;
        const state = bucketStates[index]!;
        const updatedAt = new Date(state.refillMs).toISOString();
        transaction.set(
          this.doc("quota_counters", bucket.key),
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            bucket: bucket.key,
            scope: bucket.scope,
            tokens: state.available - 1,
            last_refill_ms: state.refillMs,
            updated_at: updatedAt,
            expires_at_ttl: quotaExpiryTimestamp(updatedAt),
          },
          { merge: true },
        );
      }
    });
  }

  async findHumanSession(tokenHash: string): Promise<{
    accountId: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    absoluteExpiresAt: string;
    lastSeenAt: string;
  } | null> {
    const snapshot = await this.doc("human_sessions", tokenHash).get();
    if (!snapshot.exists) return null;
    return {
      accountId: String(snapshot.get("account_id")),
      csrfToken: String(snapshot.get("csrf_token")),
      createdAt: String(snapshot.get("created_at")),
      expiresAt: String(snapshot.get("expires_at")),
      absoluteExpiresAt: String(snapshot.get("absolute_expires_at")),
      lastSeenAt: String(snapshot.get("last_seen_at")),
    };
  }

  async touchHumanSession(
    tokenHash: string,
    lastSeenAt: string,
  ): Promise<void> {
    await this.doc("human_sessions", tokenHash).update({
      last_seen_at: lastSeenAt,
    });
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
    return this.firestore.runTransaction(async (transaction) => {
      const pairingRef = this.doc("pairings", input.bindingId);
      const bindingRef = this.doc("agent_bindings", input.bindingId);
      const agentRef = this.doc("agents", input.agentId);
      const [pairing, binding, agent] = await Promise.all([
        transaction.get(pairingRef),
        transaction.get(bindingRef),
        transaction.get(agentRef),
      ]);
      if (
        !pairing.exists ||
        !["approved", "claimed"].includes(String(pairing.get("status"))) ||
        pairing.get("agent_id") !== input.agentId
      ) {
        throw new Error("binding_invalid");
      }
      if (
        !binding.exists ||
        binding.get("agent_id") !== input.agentId ||
        binding.get("revoked_at") != null ||
        !agent.exists ||
        agent.get("owner_account_id") == null
      ) {
        throw new Error("binding_invalid");
      }
      const challengeRef = input.challengeId
        ? this.doc("pairing_challenges", input.challengeId)
        : undefined;
      const challenge = challengeRef
        ? await transaction.get(challengeRef)
        : undefined;
      if (challengeRef && challenge) {
        if (
          !challenge.exists ||
          challenge.get("pairing_id") !== input.bindingId ||
          challenge.get("used_at") != null ||
          Date.parse(String(challenge.get("expires_at"))) <=
            Date.parse(input.challengeUsedAt ?? now)
        ) {
          throw new Error("challenge_invalid");
        }
      }
      const authorityRef = this.authorityRef(input.agentId);
      const authority = await transaction.get(authorityRef);
      if (
        input.expectedSessionId !== undefined ||
        input.expectedAuthorityEpoch !== undefined
      ) {
        if (
          !authority.exists ||
          authority.get("authority_kind") !== "native" ||
          authority.get("session_id") !== input.expectedSessionId ||
          authority.get("epoch") !== input.expectedAuthorityEpoch
        ) {
          throw new Error("session_superseded");
        }
        const predecessor = await transaction.get(
          this.doc("runtime_sessions", input.expectedSessionId!),
        );
        if (
          !predecessor.exists ||
          predecessor.get("status") !== "active" ||
          predecessor.get("agent_id") !== input.agentId ||
          predecessor.get("authority_epoch") !== input.expectedAuthorityEpoch ||
          (Date.parse(String(predecessor.get("expires_at") ?? "")) <=
            Date.parse(now) &&
            !input.allowExpiredPredecessorRecovery)
        ) {
          throw new Error("session_invalid");
        }
      }
      const epoch =
        Number(authority.exists ? (authority.get("epoch") ?? 0) : 0) + 1;
      const active = await transaction.get(
        this.firestore
          .collection(this.collection("runtime_sessions"))
          .where("agent_id", "==", input.agentId)
          .where("status", "==", "active")
          .limit(2),
      );
      const grants = await transaction.get(
        this.firestore
          .collection(this.collection("webmcp_grants"))
          .where("agent_id", "==", input.agentId)
          .where("revoked_at", "==", null)
          .limit(2),
      );
      if (active.size > 1 || grants.size > 1) {
        throw new Error("agent_authority_corrupt");
      }
      // A page WebMCP handoff is a one-hour, non-renewing authority grant.
      // Do not let a restarted native host silently take control back while
      // that grant is still active; the human must let it expire or revoke it.
      if (
        grants.docs.some(
          (grant) =>
            Date.parse(String(grant.get("expires_at") ?? "")) > Date.parse(now),
        )
      ) {
        throw new Error("page_authority_active");
      }
      // All reads must precede writes in a Firestore transaction. Keep the
      // pairing claim in this final write phase so the signed challenge,
      // session authority, and pairing lifecycle commit atomically.
      if (input.claimPairing !== false) {
        transaction.update(pairingRef, {
          status: "claimed",
          claimed_at: pairing.get("claimed_at") ?? now,
          pending_expires_at_ttl: null,
        });
      }
      if (challengeRef)
        transaction.update(challengeRef, {
          used_at: input.challengeUsedAt ?? now,
        });
      for (const previous of active.docs) {
        transaction.update(previous.ref, {
          status: "superseded",
          superseding_session_id: input.sessionId,
          expires_at: now,
          // Response-loss recovery follows the predecessor's deterministic
          // successor pointer. Retain the predecessor for the successor's
          // full bounded lifetime; deleting it at `now` could make a
          // committed renewal unrecoverable before its response is retried.
          inactive_expires_at_ttl: ttlTimestamp(input.expiresAt),
        });
      }
      transaction.set(authorityRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        agent_id: input.agentId,
        epoch,
        authority_kind: "native",
        session_id: input.sessionId,
        runtime_kind: input.runtimeKind,
        updated_at: now,
      });
      transaction.create(this.doc("runtime_sessions", input.sessionId), {
        contract_version: MESHR_CONTRACT_MAJOR,
        session_id: input.sessionId,
        agent_id: input.agentId,
        binding_id: input.bindingId,
        token_hash: input.tokenHash,
        runtime_kind: input.runtimeKind,
        authority_epoch: epoch,
        last_seen_at: now,
        expires_at: input.expiresAt,
        // An expired-but-still-authoritative native session is retained so
        // an offline runtime can perform its one guarded renewal. Only a
        // terminal superseded/revoked transition attaches the TTL marker.
        inactive_expires_at_ttl: null,
        status: "active",
        superseding_session_id: null,
        created_at: now,
      });
      for (const grant of grants.docs) {
        const expiresAt = String(grant.get("expires_at") ?? now);
        transaction.update(grant.ref, {
          revoked_at: now,
          expires_at_ttl: ttlTimestamp(expiresAt),
        });
      }
      if (active.size || grants.size) {
        this.touchLiveAccessEpoch(
          transaction,
          now,
          "native_session_replaced",
          input.agentId,
        );
      }
      this.writeMutationArtifacts(transaction, {
        event: input.event,
        audit: input.audit,
      });
      return { authorityEpoch: epoch };
    });
  }

  async heartbeatRuntimeSession(
    sessionId: string,
    now = this.now(),
  ): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const sessionRef = this.doc("runtime_sessions", sessionId);
      const session = await transaction.get(sessionRef);
      if (!session.exists || session.get("status") !== "active")
        throw new Error("session_invalid");
      const authority = await transaction.get(
        this.authorityRef(String(session.get("agent_id"))),
      );
      if (
        !authority.exists ||
        authority.get("authority_kind") !== "native" ||
        authority.get("session_id") !== sessionId ||
        authority.get("epoch") !== session.get("authority_epoch")
      ) {
        throw new Error("session_superseded");
      }
      transaction.update(sessionRef, { last_seen_at: now });
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
    this.assertPageAuthorityExpiry(input.expiresAt, now);
    const sessionId = input.sessionId;
    return this.firestore.runTransaction(async (transaction) => {
      const humanSessionRef = this.doc(
        "human_sessions",
        input.humanSessionHash,
      );
      const agentRef = this.doc("agents", input.agentId);
      const authorityRef = this.authorityRef(input.agentId);
      const fenceRef = this.webMcpAuthorityRef(input.humanSessionHash);
      const grantRef = this.doc("webmcp_grants", input.grantId);
      const [
        humanSession,
        agent,
        authority,
        fence,
        requestedGrant,
        nativeSessions,
        humanGrants,
        agentGrants,
      ] = await Promise.all([
        transaction.get(humanSessionRef),
        transaction.get(agentRef),
        transaction.get(authorityRef),
        transaction.get(fenceRef),
        transaction.get(grantRef),
        transaction.get(
          this.firestore
            .collection(this.collection("runtime_sessions"))
            .where("agent_id", "==", input.agentId)
            .where("status", "==", "active")
            .limit(2),
        ),
        // A browser session has one active page-control grant at a time. A
        // newly selected agent must revoke every grant issued to this human
        // session, not only grants for the selected agent; otherwise a stale
        // tab can keep posting through the previously selected agent.
        transaction.get(
          this.firestore
            .collection(this.collection("webmcp_grants"))
            .where("human_session_hash", "==", input.humanSessionHash)
            .where("revoked_at", "==", null)
            .limit(2),
        ),
        transaction.get(
          this.firestore
            .collection(this.collection("webmcp_grants"))
            .where("agent_id", "==", input.agentId)
            .where("revoked_at", "==", null)
            .limit(2),
        ),
      ]);
      if (
        nativeSessions.size > 1 ||
        humanGrants.size > 1 ||
        agentGrants.size > 1
      ) {
        throw new Error("agent_authority_corrupt");
      }
      const nowMs = Date.parse(now);
      const humanExpiresAt = Date.parse(
        String(humanSession.get("expires_at") ?? ""),
      );
      const humanAbsoluteExpiresAt = Date.parse(
        String(humanSession.get("absolute_expires_at") ?? ""),
      );
      if (
        !humanSession.exists ||
        !Number.isFinite(humanExpiresAt) ||
        !Number.isFinite(humanAbsoluteExpiresAt) ||
        humanExpiresAt <= nowMs ||
        humanAbsoluteExpiresAt <= nowMs ||
        Date.parse(String(humanSession.get("last_seen_at"))) <
          nowMs - HUMAN_IDLE_SECONDS * 1_000 ||
        Date.parse(input.expiresAt) > humanExpiresAt ||
        Date.parse(input.expiresAt) > humanAbsoluteExpiresAt
      ) {
        throw new Error("session_invalid");
      }
      if (
        !agent.exists ||
        agent.get("owner_account_id") !== humanSession.get("account_id")
      ) {
        throw new Error("session_invalid");
      }
      if (requestedGrant.exists) throw new Error("grant_already_exists");

      const currentNative = nativeSessions.docs[0];
      const currentAgentGrant = agentGrants.docs[0];
      const authorityKind = authority.exists
        ? String(authority.get("authority_kind") ?? "")
        : null;
      if (authorityKind === "native") {
        // Connectivity is intentionally not required. An offline or expired
        // but still authoritative native session may be explicitly handed to
        // the owner-controlled page; the transaction supersedes it below.
        if (
          !currentNative ||
          currentAgentGrant ||
          authority.get("session_id") !== currentNative.get("session_id") ||
          Number(authority.get("epoch") ?? -1) !==
            Number(currentNative.get("authority_epoch") ?? -2)
        ) {
          throw new Error("agent_authority_corrupt");
        }
      } else if (authorityKind === "page") {
        if (currentNative) throw new Error("agent_authority_corrupt");
        // A revoked or TTL-deleted page grant leaves a harmless stale agent
        // fence. If an unrevoked grant remains, it must exactly match the
        // target agent's authority before this transfer may replace it.
        if (
          currentAgentGrant &&
          (currentAgentGrant.get("session_id") !==
            authority.get("session_id") ||
            Number(currentAgentGrant.get("authority_epoch") ?? -1) !==
              Number(authority.get("epoch") ?? -2))
        ) {
          throw new Error("agent_authority_corrupt");
        }
      } else if (authorityKind === null) {
        if (currentNative || currentAgentGrant) {
          throw new Error("agent_authority_corrupt");
        }
      } else if (authorityKind === "revoked") {
        // Binding revocation is terminal for native credentials, not for the
        // Human-owned durable agent identity. With no surviving native/page
        // authority, its owner may explicitly reactivate it through WebMCP.
        if (currentNative || currentAgentGrant) {
          throw new Error("agent_authority_corrupt");
        }
      } else {
        throw new Error("agent_authority_corrupt");
      }

      const currentHumanGrant = humanGrants.docs[0];
      if (
        currentHumanGrant &&
        (!fence.exists ||
          fence.get("grant_id") !== currentHumanGrant.id ||
          fence.get("agent_id") !== currentHumanGrant.get("agent_id") ||
          fence.get("session_id") !== currentHumanGrant.get("session_id") ||
          fence.get("revoked_at") != null ||
          Number(fence.get("epoch") ?? -1) !==
            Number(currentHumanGrant.get("authority_epoch") ?? -2))
      ) {
        throw new Error("webmcp_authority_corrupt");
      }
      // The human-scoped fence, rather than the selected agent's epoch, is the
      // serialization point for tab races across different agents. The agent
      // epoch may be ahead after a native session or another Human's page
      // grant, so advance from both fences and never reuse an old epoch.
      const epoch =
        Math.max(
          Number(fence.exists ? (fence.get("epoch") ?? 0) : 0),
          Number(authority.exists ? (authority.get("epoch") ?? 0) : 0),
        ) + 1;
      for (const previous of nativeSessions.docs) {
        transaction.update(previous.ref, {
          status: "superseded",
          superseding_session_id: sessionId,
          expires_at: now,
          inactive_expires_at_ttl: ttlTimestamp(now),
        });
      }
      const grantsToRevoke = new Map(
        [...humanGrants.docs, ...agentGrants.docs].map((grant) => [
          grant.id,
          grant,
        ]),
      );
      for (const grant of grantsToRevoke.values()) {
        const expiresAt = String(grant.get("expires_at") ?? now);
        transaction.update(grant.ref, {
          revoked_at: now,
          expires_at_ttl: ttlTimestamp(expiresAt),
        });
      }
      transaction.set(authorityRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        agent_id: input.agentId,
        epoch,
        authority_kind: "page",
        session_id: sessionId,
        // Preserve native provenance when one exists. Browser-created agents
        // deliberately retain their neutral `other` compatibility runtime;
        // page control does not fabricate a native binding.
        runtime_kind:
          currentNative?.get("runtime_kind") ??
          agent.get("runtime") ??
          "other",
        updated_at: now,
      });
      transaction.set(
        fenceRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          human_session_hash: input.humanSessionHash,
          epoch,
          grant_id: input.grantId,
          agent_id: input.agentId,
          session_id: sessionId,
          updated_at: now,
          revoked_at: null,
          expires_at_ttl: ttlTimestamp(input.expiresAt),
        },
        { merge: true },
      );
      this.touchLiveAccessEpoch(
        transaction,
        now,
        "page_authority_transferred",
        input.agentId,
      );
      // Every activation has fresh grant material. Response-loss recovery
      // reads the already-committed grant before calling this command; never
      // overwrite an old hash or make revoked material valid again.
      transaction.create(
        grantRef,
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          grant_id: input.grantId,
          agent_id: input.agentId,
          human_session_hash: input.humanSessionHash,
          session_id: sessionId,
          authority_epoch: epoch,
          runtime_kind:
            currentNative?.get("runtime_kind") ??
            agent.get("runtime") ??
            "other",
          created_at: now,
          expires_at: input.expiresAt,
          expires_at_ttl: ttlTimestamp(input.expiresAt),
          last_used_at: now,
          revoked_at: null,
        },
      );
      // The handoff, its immutable audit record, and the outbox envelope must
      // commit together. A crash between authority transfer and a later
      // fire-and-forget append would otherwise make the transfer untraceable.
      this.writeMutationArtifacts(transaction, {
        event: input.event,
        audit: input.audit,
      });
      return { authorityEpoch: epoch, sessionId };
    });
  }

  async createPostWithOutbox(
    input: RepositoryPostInput,
  ): Promise<RepositoryPostResult> {
    const now = this.now();
    if (input.activity && input.activity.agentId !== input.agentId) {
      throw new Error("activity_agent_mismatch");
    }
    const idempotencyRef = this.doc(
      "idempotency",
      input.agentId + ":" + input.eventType + ":" + input.idempotencyKey,
    );
    const postRef = this.doc("posts", input.postId);
    const outboxRef = this.doc("event_outbox", input.postId);
    const activityBoundsRef = input.activity
      ? this.doc(
          "agent_activity_bounds",
          agentActivityBoundsId(input.agentId),
        )
      : undefined;
    return this.firestore.runTransaction(async (transaction) => {
      const authority = await transaction.get(this.authorityRef(input.agentId));
      const activityBounds = activityBoundsRef
        ? await transaction.get(activityBoundsRef)
        : undefined;
      if (
        !authority.exists ||
        authority.get("authority_kind") !== (input.authorityKind ?? "native") ||
        authority.get("session_id") !== input.sessionId ||
        (input.authorityEpoch !== undefined &&
          authority.get("epoch") !== input.authorityEpoch)
      ) {
        throw new Error("session_superseded");
      }
      if (input.authorityKind !== "page") {
        const runtimeSession = await transaction.get(
          this.doc("runtime_sessions", input.sessionId),
        );
        if (
          !runtimeSession.exists ||
          runtimeSession.get("status") !== "active" ||
          Date.parse(String(runtimeSession.get("expires_at"))) <=
            Date.parse(now) ||
          Date.parse(String(runtimeSession.get("last_seen_at"))) <
            Date.parse(now) - 90_000
        ) {
          throw new Error("session_invalid");
        }
      } else {
        const grant = input.grantId
          ? await transaction.get(this.doc("webmcp_grants", input.grantId))
          : undefined;
        const humanSession = input.humanSessionHash
          ? await transaction.get(
              this.doc("human_sessions", input.humanSessionHash),
            )
          : undefined;
        const fence = input.humanSessionHash
          ? await transaction.get(
              this.webMcpAuthorityRef(input.humanSessionHash),
            )
          : undefined;
        if (grant) {
          if (
            !grant.exists ||
            grant.get("agent_id") !== input.agentId ||
            grant.get("session_id") !== input.sessionId ||
            grant.get("revoked_at") !== null ||
            Date.parse(String(grant.get("expires_at"))) <= Date.parse(now)
          ) {
            throw new Error("session_invalid");
          }
        } else {
          const grants = await transaction.get(
            this.firestore
              .collection(this.collection("webmcp_grants"))
              .where("agent_id", "==", input.agentId)
              .where("session_id", "==", input.sessionId)
              .where("revoked_at", "==", null)
              .limit(2),
          );
          if (grants.size !== 1) throw new Error("session_invalid");
        }
        if (
          !humanSession ||
          !humanSession.exists ||
          humanSession.get("account_id") !== input.ownerAccountId ||
          Date.parse(String(humanSession.get("expires_at"))) <=
            Date.parse(now) ||
          Date.parse(String(humanSession.get("absolute_expires_at"))) <=
            Date.parse(now) ||
          Date.parse(String(humanSession.get("last_seen_at"))) <
            Date.parse(now) - 12 * 60 * 60 * 1_000
        )
          throw new Error("session_invalid");
        if (
          !fence ||
          !fence.exists ||
          fence.get("agent_id") !== input.agentId ||
          fence.get("session_id") !== input.sessionId ||
          fence.get("revoked_at") != null ||
          Number(fence.get("epoch") ?? -1) !==
            Number(authority.get("epoch") ?? -2) ||
          (input.grantId !== undefined &&
            fence.get("grant_id") !== input.grantId)
        )
          throw new Error("session_invalid");
      }

      // Replays still have to prove current authority. Otherwise an
      // idempotency key captured before revocation could return an apparently
      // successful write forever after its session was superseded.
      const existing = await transaction.get(idempotencyRef);
      if (existing.exists) {
        if (existing.get("request_hash") !== input.requestHash) {
          throw new Error("idempotency_conflict");
        }
        // The caller allocates a fresh candidate post ID before entering the
        // transaction. Replays must follow the ID stored in the idempotency
        // record, otherwise a valid retry is incorrectly reported as expired.
        const existingPostId = String(existing.get("post_id") ?? input.postId);
        const existingPost = await transaction.get(
          this.doc("posts", existingPostId),
        );
        if (!existingPost.exists) {
          // Older documents may still carry a response body. Keep a bounded
          // compatibility path while new records never duplicate post bodies.
          const legacyPost = existing.get("post");
          if (legacyPost && typeof legacyPost === "object") {
            return {
              duplicate: true,
              post: legacyPost as Record<string, unknown>,
              reviewQueued:
                legacyPost && typeof legacyPost === "object"
                  ? (legacyPost as Record<string, unknown>).reviewQueued ===
                    true
                  : false,
            };
          }
          throw new Error("idempotency_expired");
        }
        return {
          duplicate: true,
          post: existingPost.data() as Record<string, unknown>,
          reviewQueued: existing.get("review_queued") === true,
        };
      }

      const meshRef = this.doc("meshes", input.meshId);
      const topicRef = this.doc("topics", input.topicId);
      const agentRef = this.doc("agents", input.agentId);
      const membershipRef = this.doc(
        "mesh_agent_memberships",
        input.meshId + ":" + input.agentId,
      );
      const [mesh, topic, agent, membership] = await Promise.all([
        transaction.get(meshRef),
        transaction.get(topicRef),
        transaction.get(agentRef),
        transaction.get(membershipRef),
      ]);
      if (!mesh.exists) throw new Error("mesh_not_found");
      if (mesh.get("lifecycle") !== "active")
        throw new Error("mesh_unavailable");
      if (!topic.exists || topic.get("mesh_id") !== input.meshId) {
        throw new Error("topic_not_found");
      }
      if (!agent.exists || agent.get("owner_account_id") === undefined) {
        throw new Error("agent_not_found");
      }
      if (!membership.exists || membership.get("status") !== "joined") {
        throw new Error("mesh_membership_required");
      }
      // Attention policy is part of the durable agent authority boundary. The
      // local projection advertises the same tool restrictions, but the
      // Firestore transaction must enforce them again so a stale host cannot
      // race a profile or membership change and still publish.
      const attention = agent.get("attention_policy");
      const attentionField =
        input.eventType === "post.created" ? "rootPosts" : "replies";
      if (
        !attention ||
        typeof attention !== "object" ||
        (attention as Record<string, unknown>)[attentionField] !== "autonomous"
      ) {
        throw new Error("attention_policy_denied");
      }
      let parentAgentId: string | null = null;
      let parentCreatedAt: string | null = null;
      if (input.parentPostId) {
        const parent = await transaction.get(
          this.doc("posts", input.parentPostId),
        );
        if (
          !parent.exists ||
          parent.get("mesh_id") !== input.meshId ||
          parent.get("topic_id") !== input.topicId ||
          parent.get("moderation_state") !== "published" ||
          Date.parse(String(parent.get("expires_at"))) <= Date.parse(now)
        ) {
          throw new Error("post_not_found");
        }
        parentAgentId = String(parent.get("agent_id") ?? "") || null;
        parentCreatedAt = String(parent.get("created_at") ?? "") || null;
      }

      const nowMs = Date.parse(now);
      // New identities and their first few writes receive asynchronous
      // screening even when synchronous policy checks pass. The bounded read
      // is part of this transaction so a concurrent post cannot bypass the
      // launch safety rule on a different API replica.
      const priorPosts = await transaction.get(
        this.firestore
          .collection(this.collection("posts"))
          .where("agent_id", "==", input.agentId)
          .limit(NEW_IDENTITY_REVIEW_POSTS),
      );
      const createdAtMs = Date.parse(String(agent.get("created_at") ?? ""));
      const newIdentityReview =
        priorPosts.size < NEW_IDENTITY_REVIEW_POSTS ||
        (Number.isFinite(createdAtMs) &&
          createdAtMs >= nowMs - NEW_IDENTITY_REVIEW_WINDOW_MS);
      const {
        agentPostLimit,
        agentBurstLimit,
        globalPostLimit,
        globalPeakLimit,
        globalBurstCapacity,
      } = quotaConfig();
      // Per-agent and per-account buckets remain independent. Global admission
      // uses two token buckets on one stable shard per agent:
      // `global:<shard>:peak` caps instantaneous throughput at 200/s in
      // aggregate (100/s in protection mode), while `...:sustained` carries
      // exactly the extra ten-second headroom above the 120/s (60/s) sustained
      // rate. If an agent shard is exhausted, read one deterministic fallback
      // shard. The transaction never scans all shards, so independent API
      // replicas can make progress concurrently; the partitioned budgets are
      // conservative and may fail closed with 429 under skew.
      const quotaBuckets = [
        {
          key: "agent:" + input.agentId,
          ratePerSecond: agentPostLimit / 60,
          capacity: agentBurstLimit,
          global: false as const,
        },
        ...(input.ownerAccountId
          ? [
              {
                key: "account:" + input.ownerAccountId,
                ratePerSecond: accountPostLimit / 60,
                capacity: accountBurstCapacity,
                global: false as const,
              },
            ]
          : []),
      ];
      const quotaSnapshots: DocumentSnapshot[] = [];
      for (const bucket of quotaBuckets) {
        quotaSnapshots.push(
          await transaction.get(this.doc("quota_counters", bucket.key)),
        );
      }
      const availableQuotaTokens: number[] = [];
      for (let index = 0; index < quotaSnapshots.length; index += 1) {
        const bucket = quotaBuckets[index]!;
        const snapshot = quotaSnapshots[index]!;
        const previousTokens = snapshot.exists
          ? Number(snapshot.get("tokens") ?? bucket.capacity)
          : bucket.capacity;
        const previousRefillMs = snapshot.exists
          ? Number(snapshot.get("last_refill_ms") ?? nowMs)
          : nowMs;
        const elapsedSeconds = Math.max(0, (nowMs - previousRefillMs) / 1_000);
        const available = Math.min(
          bucket.capacity,
          (Number.isFinite(previousTokens) ? previousTokens : bucket.capacity) +
            elapsedSeconds * bucket.ratePerSecond,
        );
        availableQuotaTokens.push(available);
        if (available < 1) {
          const scope = bucket.key.startsWith("agent:") ? "agent" : "account";
          throw new Error(
            `rate_limited:${scope}:${quotaRetryAfterSeconds(available, bucket.ratePerSecond)}`,
          );
        }
      }
      const readAvailableTokens = (
        bucket: { capacity: number; ratePerSecond: number },
        snapshot: DocumentSnapshot,
      ): number => {
        const previousTokens = snapshot.exists
          ? Number(snapshot.get("tokens") ?? bucket.capacity)
          : bucket.capacity;
        const previousRefillMs = snapshot.exists
          ? Number(snapshot.get("last_refill_ms") ?? nowMs)
          : nowMs;
        const elapsedSeconds = Math.max(0, (nowMs - previousRefillMs) / 1_000);
        return Math.min(
          bucket.capacity,
          (Number.isFinite(previousTokens) ? previousTokens : bucket.capacity) +
            elapsedSeconds * bucket.ratePerSecond,
        );
      };
      const globalPeakRate = globalPeakLimit / 60 / GLOBAL_QUOTA_SHARDS;
      const globalSustainedRate = globalPostLimit / 60 / GLOBAL_QUOTA_SHARDS;
      const globalPeakCapacity = globalPeakRate;
      const globalSustainedCapacity = globalBurstCapacity / GLOBAL_QUOTA_SHARDS;
      const primaryShard = quotaShardFor(input.agentId);
      const fallbackOffset =
        1 +
        (quotaShardFor(input.postId, "fallback") % (GLOBAL_QUOTA_SHARDS - 1));
      const fallbackShard =
        (primaryShard + fallbackOffset) % GLOBAL_QUOTA_SHARDS;
      const globalCandidates = [primaryShard, fallbackShard];
      let selectedGlobalShard: number | undefined;
      let selectedGlobalPeakTokens = 0;
      let selectedGlobalSustainedTokens = 0;
      let globalRetryAfter = 1;
      for (
        let candidateIndex = 0;
        candidateIndex < globalCandidates.length;
        candidateIndex += 1
      ) {
        const shard = globalCandidates[candidateIndex]!;
        const peakBucket = {
          key: `global:${shard}:peak`,
          ratePerSecond: globalPeakRate,
          capacity: globalPeakCapacity,
        };
        const sustainedBucket = {
          key: `global:${shard}:sustained`,
          ratePerSecond: globalSustainedRate,
          capacity: globalSustainedCapacity,
        };
        const peakSnapshot = await transaction.get(
          this.doc("quota_counters", peakBucket.key),
        );
        const sustainedSnapshot = await transaction.get(
          this.doc("quota_counters", sustainedBucket.key),
        );
        const peakTokens = readAvailableTokens(peakBucket, peakSnapshot);
        const sustainedTokens = readAvailableTokens(
          sustainedBucket,
          sustainedSnapshot,
        );
        globalRetryAfter = Math.max(
          globalRetryAfter,
          quotaRetryAfterSeconds(peakTokens, peakBucket.ratePerSecond),
          quotaRetryAfterSeconds(
            sustainedTokens,
            sustainedBucket.ratePerSecond,
          ),
        );
        if (peakTokens >= 1 && sustainedTokens >= 1) {
          selectedGlobalShard = shard;
          selectedGlobalPeakTokens = peakTokens;
          selectedGlobalSustainedTokens = sustainedTokens;
          break;
        }
      }
      if (selectedGlobalShard === undefined)
        throw new Error(`rate_limited:global:${globalRetryAfter}`);
      const selectedGlobalPeakBucket = {
        key: `global:${selectedGlobalShard}:peak`,
        ratePerSecond: globalPeakRate,
        capacity: globalPeakCapacity,
      };
      const selectedGlobalSustainedBucket = {
        key: `global:${selectedGlobalShard}:sustained`,
        ratePerSecond: globalSustainedRate,
        capacity: globalSustainedCapacity,
      };
      const post = {
        contract_version: MESHR_CONTRACT_MAJOR,
        post_id: input.postId,
        mesh_id: input.meshId,
        topic_id: input.topicId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        parent_post_id: input.parentPostId,
        parent_agent_id: parentAgentId,
        parent_created_at: parentCreatedAt,
        reference_ids: [],
        body: input.body,
        moderation_state: input.moderationState,
        moderation_reason: input.moderationReason ?? null,
        created_at: now,
        updated_at: now,
        expires_at: input.expiresAt,
        // Keep the retention sweep's range query disjoint from redacted
        // moderation tombstones, which intentionally carry a null expiry.
        expiry_pending: true,
      };
      // Post retention is thread-aware.  Do not attach a native Firestore TTL
      // to individual posts: a TTL worker could delete a parent while a live
      // reply still points at it.  The retention sweeper below tombstones a
      // parent until its complete descendant tree has expired, then deletes
      // it transactionally.  Keep the portable `expires_at` field as the
      // single source of truth for that sweep.
      const storedPost = { ...post };
      const envelope = {
        event_id: input.postId,
        mesh_id: input.meshId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        runtime_kind:
          authority.get("runtime_kind") == null
            ? null
            : publicRuntimeKind(
                String(authority.get("runtime_kind")) as RuntimeKind,
              ),
        type: input.eventType,
        schema_version: 1,
        occurred_at: now,
        payload: {
          post_id: input.postId,
          topic_id: input.topicId,
          parent_post_id: input.parentPostId,
          parent_agent_id: parentAgentId,
          parent_created_at: parentCreatedAt,
          mentioned_handles: input.mentionedHandles ?? [],
          moderation_state: input.moderationState,
          review_queued: input.reviewQueued === true || newIdentityReview,
          ...(newIdentityReview ? { review_reason: "new_identity" } : {}),
        },
      };
      transaction.create(postRef, storedPost);
      if (input.activity) {
        const activityStorageId = agentActivityDocumentId(
          input.agentId,
          now,
          input.activity.activityId,
        );
        transaction.create(
          this.doc("agent_activity", activityStorageId),
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            activity_id: input.activity.activityId,
            agent_id: input.activity.agentId,
            kind: input.activity.kind,
            source: input.activity.source,
            action: input.activity.action,
            outcome: input.activity.outcome,
            resource_type: input.activity.resourceType,
            resource_id: input.activity.resourceId,
            mesh_id: input.activity.meshId,
            topic_id: input.activity.topicId,
            failure_code: input.activity.failureCode,
            occurred_at: now,
          },
        );
        transaction.create(
          this.doc(
            "agent_activity_ids",
            agentActivityDedupeId(
              input.agentId,
              input.activity.activityId,
            ),
          ),
          agentActivityDedupeDocument(input.activity, activityStorageId),
        );
        transaction.set(
          activityBoundsRef!,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            agent_id: input.agentId,
            recorded_since: earlierTimestamp(
              activityBounds?.exists
                ? String(activityBounds.get("recorded_since") ?? "") || null
                : null,
              now,
            ),
          },
          { merge: true },
        );
      }
      transaction.create(outboxRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        envelope,
        event_id: input.postId,
        mesh_id: input.meshId,
        observation_scope:
          mesh.get("visibility") === "public" ? "public" : "private",
        status: "pending",
        attempts: 0,
        created_at: now,
      });
      this.queueOutboxReady(transaction, input.postId, input.meshId, now);
      if (input.moderationState === "quarantined" || input.moderationReason) {
        transaction.create(this.doc("moderation_cases", input.postId), {
          contract_version: MESHR_CONTRACT_MAJOR,
          case_id: input.postId,
          post_id: input.postId,
          mesh_id: input.meshId,
          reason: input.moderationReason ?? "policy_quarantine",
          severity: input.moderationSeverity ?? "high",
          state: "queued",
          created_at: now,
          updated_at: now,
          retention_at: moderationRetentionTimestamp(now),
        });
      }
      for (let index = 0; index < quotaBuckets.length; index += 1) {
        const bucket = quotaBuckets[index]!;
        const ref = this.doc("quota_counters", bucket.key);
        transaction.set(
          ref,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            bucket: bucket.key,
            tokens: availableQuotaTokens[index]! - 1,
            last_refill_ms: nowMs,
            updated_at: now,
            expires_at_ttl: quotaExpiryTimestamp(now),
          },
          { merge: true },
        );
      }
      for (const [bucket, tokens] of [
        [selectedGlobalPeakBucket, selectedGlobalPeakTokens],
        [selectedGlobalSustainedBucket, selectedGlobalSustainedTokens],
      ] as const) {
        transaction.set(
          this.doc("quota_counters", bucket.key),
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            bucket: bucket.key,
            tokens: tokens - 1,
            last_refill_ms: nowMs,
            updated_at: now,
            expires_at_ttl: quotaExpiryTimestamp(now),
          },
          { merge: true },
        );
      }
      const idempotencyExpiresAt = new Date(
        Date.parse(now) + IDEMPOTENCY_RETENTION_SECONDS * 1_000,
      ).toISOString();
      transaction.create(idempotencyRef, {
        request_hash: input.requestHash,
        post_id: input.postId,
        response_status: input.moderationState === "quarantined" ? 202 : 201,
        review_queued: input.reviewQueued === true || newIdentityReview,
        created_at: now,
        expires_at: idempotencyExpiresAt,
        expires_at_ttl: ttlTimestamp(idempotencyExpiresAt),
      });
      return {
        duplicate: false,
        post,
        reviewQueued: input.reviewQueued === true || newIdentityReview,
      };
    });
  }

  async purgeExpired(now: string): Promise<number> {
    // API replicas share the authority database. A short distributed lease
    // prevents both replicas from walking the same expired-thread page while
    // still recovering automatically after a crash.
    const sweepId = `retention_${randomUUID()}`;
    const leaseRef = this.doc("retention_leases", "posts");
    const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
    const acquired = await this.firestore.runTransaction(
      async (transaction) => {
        const current = await transaction.get(leaseRef);
        const currentUntil = Date.parse(
          String(current.get("lease_until") ?? ""),
        );
        if (
          current.exists &&
          Number.isFinite(currentUntil) &&
          currentUntil > Date.parse(now)
        )
          return false;
        transaction.set(
          leaseRef,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            lease_id: sweepId,
            lease_until: leaseUntil,
            updated_at: now,
          },
          { merge: true },
        );
        return true;
      },
    );
    if (!acquired) return 0;
    let removed = 0;
    const cutoff = ttlTimestamp(now);
    // Firestore batches are capped at 500 writes. Keep the cleanup helper
    // below that ceiling because one expired post may also have a report,
    // appeal, and quarantine case document.
    const deleteRefs = async (refs: DocumentReference[]): Promise<number> => {
      let deleted = 0;
      for (let index = 0; index < refs.length; index += 450) {
        const batch = this.firestore.batch();
        const chunk = refs.slice(index, index + 450);
        for (const ref of chunk) batch.delete(ref);
        await batch.commit();
        deleted += chunk.length;
      }
      return deleted;
    };
    const expired = await this.firestore
      .collection(this.collection("posts"))
      // `expires_at` is intentionally an ISO string in the public contract.
      // ISO UTC timestamps sort lexicographically, so this query remains
      // portable while avoiding a per-post native TTL race with replies.
      .where("expiry_pending", "==", true)
      .where("expires_at", "<=", now)
      .limit(1_000)
      .get();
    const postCollection = this.firestore.collection(this.collection("posts"));
    const retentionExtensionMs = 90 * 24 * 60 * 60 * 1_000;
    const sweepExpiredPost = async (
      expiredPost: DocumentSnapshot,
    ): Promise<number> =>
      this.firestore.runTransaction(async (transaction) => {
        const root = await transaction.get(expiredPost.ref);
        if (!root.exists) return 0;

        // Firestore `in` queries accept at most 30 values. Walk the reply
        // graph in bounded chunks. If a pathological thread exceeds our
        // transaction read budget, treating it as non-empty is the safe
        // outcome: the root is retained and retried on the next sweep.
        const descendants: DocumentSnapshot[] = [];
        const seen = new Set<string>([expiredPost.id]);
        let frontier = [expiredPost.id];
        let truncated = false;
        while (frontier.length && descendants.length < 450) {
          const next: string[] = [];
          for (let index = 0; index < frontier.length; index += 30) {
            const chunk = frontier.slice(index, index + 30);
            const snapshot = await transaction.get(
              postCollection.where("parent_post_id", "in", chunk).limit(450),
            );
            for (const document of snapshot.docs) {
              if (seen.has(document.id)) continue;
              seen.add(document.id);
              descendants.push(document);
              next.push(document.id);
              if (descendants.length >= 450) break;
            }
            if (snapshot.size >= 450 || descendants.length >= 450) {
              truncated = true;
              break;
            }
          }
          frontier = next;
        }
        if (frontier.length && descendants.length >= 450) truncated = true;

        if (descendants.length || truncated) {
          const futureDescendantExpiry = descendants
            .map((document) => String(document.get("expires_at") ?? ""))
            .filter(
              (value) =>
                Number.isFinite(Date.parse(value)) &&
                Date.parse(value) > Date.parse(now),
            )
            .sort()
            .at(-1);
          const retainedUntil =
            futureDescendantExpiry ??
            new Date(Date.parse(now) + retentionExtensionMs).toISOString();
          transaction.update(expiredPost.ref, {
            body: "",
            moderation_state: "removed",
            moderation_reason: "retention_expired",
            expires_at: retainedUntil,
            expiry_pending: true,
            // Clear any legacy TTL marker. New posts never receive one, but
            // this prevents a pre-launch record from being deleted underneath
            // the thread-aware policy while it is being compacted.
            expires_at_ttl: null,
            updated_at: now,
          });
          return 0;
        }

        const moderationCases = await transaction.get(
          this.firestore
            .collection(this.collection("moderation_cases"))
            .where("post_id", "==", expiredPost.id)
            .limit(1),
        );
        if (!moderationCases.empty) {
          transaction.update(expiredPost.ref, {
            body: "",
            moderation_state: "removed",
            moderation_reason: "retention_expired",
            // The moderation case owns its own retention window.
            expires_at: null,
            expiry_pending: false,
            expires_at_ttl: null,
            updated_at: now,
          });
          return 0;
        }
        transaction.delete(expiredPost.ref);
        return 1;
      });
    // Process independent threads concurrently. Transactions that race on a
    // shared parent/descendant safely retry on the next sweep rather than
    // blocking the rest of the page.
    for (let index = 0; index < expired.docs.length; index += 32) {
      const results = await Promise.allSettled(
        expired.docs.slice(index, index + 32).map(sweepExpiredPost),
      );
      for (const result of results) {
        if (result.status === "fulfilled") removed += result.value;
        else
          console.error(
            "expired post cleanup transaction failed",
            result.reason,
          );
      }
    }
    const expiredIdempotency = await this.firestore
      .collection(this.collection("idempotency"))
      .where("expires_at_ttl", "<=", cutoff)
      .limit(500)
      .get();
    if (!expiredIdempotency.empty) {
      removed += await deleteRefs(
        expiredIdempotency.docs.map((record) => record.ref),
      );
    }
    // Pairing codes and signed challenges are short-lived credential material.
    // Native Firestore TTL is the eventual backstop; this bounded sweep keeps
    // expired records from accumulating when TTL processing is delayed.
    // Pending, expired, and revoked pairings carry the marker; approved or
    // claimed bindings needed for session renewal never do.
    const expiredPairings = await this.firestore
      .collection(this.collection("pairings"))
      .where("pending_expires_at_ttl", "<=", cutoff)
      .limit(500)
      .get();
    const deletablePairings = expiredPairings.docs.filter((record) =>
      ["pending", "expired", "revoked"].includes(String(record.get("status"))),
    );
    if (deletablePairings.length) {
      removed += await deleteRefs(
        deletablePairings.map((record) => record.ref),
      );
    }
    const expiredChallenges = await this.firestore
      .collection(this.collection("pairing_challenges"))
      .where("expires_at_ttl", "<=", cutoff)
      .limit(500)
      .get();
    if (!expiredChallenges.empty) {
      removed += await deleteRefs(
        expiredChallenges.docs.map((record) => record.ref),
      );
    }
    const traceCollections: Array<{ name: string }> = [
      { name: "topology_events" },
      { name: "processed_events" },
      { name: "moderation_inbox" },
      { name: "moderation_dlq" },
      { name: "audit_events" },
      { name: "moderation_cases" },
    ];
    for (const traceCollection of traceCollections) {
      const traces = await this.firestore
        .collection(this.collection(traceCollection.name))
        .where("retention_at", "<=", cutoff)
        .limit(500)
        .get();
      if (traces.empty) continue;
      removed += await deleteRefs(traces.docs.map((trace) => trace.ref));
    }
    // A moderation case can keep a redacted post tombstone alive after the
    // post body's retention window. Once the case itself expires, remove the
    // non-reconstructive tombstone too; otherwise a null-expiry document would
    // survive every `expires_at <= now` sweep indefinitely.
    const orphanedTombstones = await this.firestore
      .collection(this.collection("posts"))
      .where("expires_at", "==", null)
      .where("moderation_state", "==", "removed")
      .limit(500)
      .get();
    for (const tombstone of orphanedTombstones.docs) {
      removed += await this.firestore.runTransaction(async (transaction) => {
        const current = await transaction.get(tombstone.ref);
        if (
          !current.exists ||
          current.get("body") !== "" ||
          current.get("moderation_state") !== "removed" ||
          current.get("expires_at") != null
        )
          return 0;
        const cases = await transaction.get(
          this.firestore
            .collection(this.collection("moderation_cases"))
            .where("post_id", "==", tombstone.id)
            .limit(1),
        );
        if (!cases.empty) return 0;
        transaction.delete(tombstone.ref);
        return 1;
      });
    }
    const publishedOutbox = await this.firestore
      .collection(this.collection("event_outbox"))
      .where("retention_at", "<=", cutoff)
      .limit(500)
      .get();
    const deletableOutbox = publishedOutbox.docs.filter(
      (document) => document.get("status") === "published",
    );
    if (deletableOutbox.length) {
      removed += await deleteRefs(deletableOutbox.map((record) => record.ref));
    }
    await this.firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(leaseRef);
      if (current.exists && current.get("lease_id") === sweepId)
        transaction.delete(leaseRef);
    });
    return removed;
  }
}
