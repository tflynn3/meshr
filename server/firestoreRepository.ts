import {
  Firestore,
  type DocumentReference,
  type DocumentSnapshot,
} from "@google-cloud/firestore";
import { createHash } from "node:crypto";
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
  RepositoryProjection,
  RepositoryPostRecord,
  RepositoryEventInput,
  RepositoryAuditInput,
  RepositoryModerationCase,
  RepositoryJoinRequest,
} from "./repository.ts";
import type { Clock, RuntimeKind, SocialProvider } from "./types.ts";
import { systemClock } from "./types.ts";

export interface FirestoreRepositoryOptions {
  firestore: Firestore;
  clock?: Clock;
  collectionPrefix?: string;
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
  authorityKind?: "native" | "page";
  authorityEpoch?: number;
  ownerAccountId?: string;
  grantId?: string;
  humanSessionHash?: string;
}

export interface RepositoryPostResult {
  duplicate: boolean;
  post: Record<string, unknown>;
}

const costProtectionMode = process.env.MESHR_COST_PROTECTION_MODE?.trim().toLowerCase();
const agentPostLimit = costProtectionMode === "throttle" ? 30 : 60;
const agentBurstLimit = costProtectionMode === "throttle" ? 5 : 10;
const globalPostLimit = costProtectionMode === "throttle" ? 3_600 : 7_200;
// The launch ceiling is 120 accepted posts/second with a 200/second burst
// over ten seconds (2,000 posts per ten-second window).  Shard counters so a
// single Firestore document does not become a write hotspot under fan-in.
const globalBurstLimit = costProtectionMode === "throttle" ? 1_000 : 2_000;
const GLOBAL_QUOTA_SHARDS = 20;
const IDEMPOTENCY_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const RAW_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

function quotaShard(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % GLOBAL_QUOTA_SHARDS;
}

/**
 * Firestore authority adapter. Route handlers can depend on this port while
 * the SQLite adapter remains available for isolated fixtures and stories.
 * Every mutating social operation uses one transaction for authority,
 * idempotency, post state, and its outbox envelope.
 */
export class FirestoreMeshrRepository implements MeshrRepository {
  readonly firestore: Firestore;
  readonly clock: Clock;
  private readonly prefix: string;

  constructor(options: FirestoreRepositoryOptions) {
    this.firestore = options.firestore;
    this.clock = options.clock ?? systemClock;
    this.prefix = options.collectionPrefix?.replace(/[^A-Za-z0-9_-]/g, "") || "";
  }

  async checkReady(): Promise<void> {
    const taxonomy = await this.doc("system", "taxonomy").get();
    if (!taxonomy.exists) throw new Error("system taxonomy is not initialized");
  }

  private collection(name: string): string {
    return this.prefix ? this.prefix + "_" + name : name;
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  private doc<T = Record<string, unknown>>(collection: string, id: string): DocumentReference<T> {
    return this.firestore.collection(this.collection(collection)).doc(id) as DocumentReference<T>;
  }

  private authorityRef(agentId: string): DocumentReference {
    return this.doc("agent_authority", agentId);
  }

  private pairingFromSnapshot(snapshot: DocumentSnapshot): RepositoryPairingInput {
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
      status: String(snapshot.get("status")) as RepositoryPairingInput["status"],
      ownerAccountId:
        snapshot.get("owner_account_id") == null
          ? null
          : String(snapshot.get("owner_account_id")),
      agentId: snapshot.get("agent_id") == null ? null : String(snapshot.get("agent_id")),
      createdAt: String(snapshot.get("created_at")),
      expiresAt: String(snapshot.get("expires_at")),
      approvedAt: snapshot.get("approved_at") == null ? null : String(snapshot.get("approved_at")),
      claimedAt: snapshot.get("claimed_at") == null ? null : String(snapshot.get("claimed_at")),
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
    });
  }

  async approvePairing(input: {
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
  }): Promise<{ agentId: string; replaced: boolean }> {
    const pairingRef = this.doc("pairings", input.pairingId);
    const handleKey = input.profile.handle.trim().normalize("NFKC").toLowerCase();
    const handleRef = this.doc("agent_handles", handleKey);
    const meshRef = this.doc("meshes", "mesh-public");
    return this.firestore.runTransaction(async (transaction) => {
      const [pairing, handle, mesh] = await Promise.all([
        transaction.get(pairingRef),
        transaction.get(handleRef),
        transaction.get(meshRef),
      ]);
      if (!pairing.exists || pairing.get("status") !== "pending") {
        throw new Error("pairing_not_pending");
      }
      if (Date.parse(String(pairing.get("expires_at"))) <= Date.parse(input.approvedAt)) {
        throw new Error("pairing_not_pending");
      }
      if (!mesh.exists) throw new Error("mesh_not_found");
      const handleAgentId = handle.exists ? String(handle.get("agent_id")) : null;
      const selectedAgentId = handleAgentId ?? input.agentId;
      const agentRef = this.doc("agents", selectedAgentId);
      const bindingRef = this.doc("agent_bindings", input.pairingId);
      const agent = await transaction.get(agentRef);
      if (agent.exists && String(agent.get("owner_account_id")) !== input.ownerAccountId) {
        throw new Error("handle_unavailable");
      }
      let replaced = agent.exists;
      if (!agent.exists) {
        const ownedAgents = await transaction.get(
          this.firestore
            .collection(this.collection("agents"))
            .where("owner_account_id", "==", input.ownerAccountId)
            .limit(26),
        );
        if (ownedAgents.size >= 25) throw new Error("agent_limit_reached");
      }
      const priorPairings = replaced
        ? await transaction.get(
            this.firestore
              .collection(this.collection("pairings"))
              .where("agent_id", "==", selectedAgentId)
              .where("status", "in", ["approved", "claimed"]),
          )
        : undefined;
      const activeSessions = replaced
        ? await transaction.get(
            this.firestore
              .collection(this.collection("runtime_sessions"))
              .where("agent_id", "==", selectedAgentId)
              .where("status", "==", "active"),
          )
        : undefined;
      const activeGrants = replaced
        ? await transaction.get(
            this.firestore
              .collection(this.collection("webmcp_grants"))
              .where("agent_id", "==", selectedAgentId)
              .where("revoked_at", "==", null),
          )
        : undefined;
      if (priorPairings) {
        for (const prior of priorPairings.docs) {
          if (prior.id !== input.pairingId) transaction.update(prior.ref, { status: "revoked", revoked_at: input.approvedAt });
        }
      }
      if (activeSessions) {
        for (const session of activeSessions.docs) {
          transaction.update(session.ref, {
            status: "superseded",
            superseded_by: input.pairingId,
            expires_at: input.approvedAt,
          });
        }
      }
      if (activeGrants) {
        for (const grant of activeGrants.docs) transaction.update(grant.ref, { revoked_at: input.approvedAt });
      }
      transaction.set(agentRef, {
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
      }, { merge: true });
      transaction.set(handleRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        handle: input.profile.handle,
        agent_id: selectedAgentId,
        updated_at: input.approvedAt,
      }, { merge: true });
      transaction.set(bindingRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        binding_id: input.pairingId,
        agent_id: selectedAgentId,
        public_key: pairing.get("public_key_pem") ?? "",
        runtime_kind: pairing.get("runtime") ?? "other",
        approved_at: input.approvedAt,
        revoked_at: null,
        updated_at: input.approvedAt,
      }, { merge: true });
      transaction.update(pairingRef, {
        status: "approved",
        owner_account_id: input.ownerAccountId,
        agent_id: selectedAgentId,
        approved_at: input.approvedAt,
      });
      transaction.set(
        this.doc("mesh_agent_memberships", "mesh-public:" + selectedAgentId),
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          mesh_id: "mesh-public",
          agent_id: selectedAgentId,
          status: "joined",
          attention_policy: input.profile.attention,
          admission_provenance: "open",
          joined_at: input.approvedAt,
          updated_at: input.approvedAt,
        },
        { merge: true },
      );
      return { agentId: selectedAgentId, replaced };
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
    if (patch.runtimeLabel !== undefined) update.runtime_label = patch.runtimeLabel;
    if (patch.externalSubject !== undefined) update.external_subject = patch.externalSubject;
    if (patch.publicKeyPem !== undefined) update.public_key_pem = patch.publicKeyPem;
    if (patch.requestedProfile !== undefined) update.requested_profile = patch.requestedProfile;
    if (patch.definitionDigest !== undefined) update.definition_digest = patch.definitionDigest;
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.ownerAccountId !== undefined) update.owner_account_id = patch.ownerAccountId;
    if (patch.agentId !== undefined) update.agent_id = patch.agentId;
    if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt;
    if (patch.approvedAt !== undefined) update.approved_at = patch.approvedAt;
    if (patch.claimedAt !== undefined) update.claimed_at = patch.claimedAt;
    update.updated_at = this.now();
    await this.doc("pairings", pairingId).set(
      { contract_version: MESHR_CONTRACT_MAJOR, pairing_id: pairingId, ...update },
      { merge: true },
    );
  }

  async findPairing(pairingId: string): Promise<RepositoryPairingInput | null> {
    const snapshot = await this.doc("pairings", pairingId).get();
    return snapshot.exists ? this.pairingFromSnapshot(snapshot) : null;
  }

  async findPairingByCode(code: string): Promise<RepositoryPairingInput | null> {
    const snapshot = await this.firestore
      .collection(this.collection("pairings"))
      .where("code", "==", code)
      .limit(1)
      .get();
    const document = snapshot.docs[0];
    return document ? this.pairingFromSnapshot(document) : null;
  }

  async createPairingChallenge(input: RepositoryPairingChallenge): Promise<void> {
    await this.doc("pairing_challenges", input.challengeId).create({
      contract_version: MESHR_CONTRACT_MAJOR,
      challenge_id: input.challengeId,
      pairing_id: input.pairingId,
      message: input.message,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      used_at: input.usedAt,
    });
  }

  async findPairingChallenge(
    challengeId: string,
    pairingId: string,
  ): Promise<RepositoryPairingChallenge | null> {
    const snapshot = await this.doc("pairing_challenges", challengeId).get();
    if (!snapshot.exists || snapshot.get("pairing_id") !== pairingId) return null;
    return {
      challengeId,
      pairingId,
      message: String(snapshot.get("message")),
      createdAt: String(snapshot.get("created_at")),
      expiresAt: String(snapshot.get("expires_at")),
      usedAt: snapshot.get("used_at") == null ? null : String(snapshot.get("used_at")),
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

  async upsertAgent(input: RepositoryAgentInput): Promise<void> {
    const agentRef = this.doc("agents", input.agentId);
    const handleKey = input.handle.trim().normalize("NFKC").toLowerCase();
    const handleRef = this.doc("agent_handles", handleKey);
    const bindingRef = this.doc("agent_bindings", input.bindingId ?? input.agentId);
    await this.firestore.runTransaction(async (transaction) => {
      const [agent, handle] = await Promise.all([
        transaction.get(agentRef),
        transaction.get(handleRef),
      ]);
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
      const previousHandle = agent.exists ? String(agent.get("handle") ?? "") : "";
      const previousHandleKey = previousHandle.trim().normalize("NFKC").toLowerCase();
      const previousHandleRef = previousHandleKey && previousHandleKey !== handleKey
        ? this.doc("agent_handles", previousHandleKey)
        : undefined;
      if (previousHandleRef) {
        const previous = await transaction.get(previousHandleRef);
        if (previous.exists && String(previous.get("agent_id")) === input.agentId) {
          transaction.delete(previousHandleRef);
        }
      }
      transaction.set(agentRef, {
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
        updated_at: input.updatedAt,
      }, { merge: true });
      transaction.set(handleRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        handle: input.handle,
        agent_id: input.agentId,
        updated_at: input.updatedAt,
      }, { merge: true });
      transaction.set(bindingRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        binding_id: input.bindingId ?? input.agentId,
        agent_id: input.agentId,
        public_key: input.publicKeyPem,
        runtime_kind: input.runtime,
        approved_at: input.createdAt,
        revoked_at: null,
        updated_at: input.updatedAt,
      }, { merge: true });
    });
  }

  async revokeAgent(agentId: string, revokedAt: string): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const bindingQuery = this.firestore
        .collection(this.collection("agent_bindings"))
        .where("agent_id", "==", agentId);
      const sessionQuery = this.firestore
        .collection(this.collection("runtime_sessions"))
        .where("agent_id", "==", agentId)
        .where("status", "==", "active");
      const grantQuery = this.firestore
        .collection(this.collection("webmcp_grants"))
        .where("agent_id", "==", agentId)
        .where("revoked_at", "==", null);
      const [bindings, sessions, grants, authority] = await Promise.all([
        transaction.get(bindingQuery),
        transaction.get(sessionQuery),
        transaction.get(grantQuery),
        transaction.get(this.authorityRef(agentId)),
      ]);
      if (bindings.empty) {
        transaction.set(
          this.doc("agent_bindings", agentId),
          { contract_version: MESHR_CONTRACT_MAJOR, agent_id: agentId, revoked_at: revokedAt },
          { merge: true },
        );
      } else {
        for (const binding of bindings.docs) {
          transaction.set(
            binding.ref,
            { contract_version: MESHR_CONTRACT_MAJOR, agent_id: agentId, revoked_at: revokedAt },
            { merge: true },
          );
        }
      }
      for (const session of sessions.docs) {
        transaction.update(session.ref, { status: "revoked", expires_at: revokedAt });
      }
      for (const grant of grants.docs) transaction.update(grant.ref, { revoked_at: revokedAt });
      transaction.set(
        this.authorityRef(agentId),
        {
          contract_version: MESHR_CONTRACT_MAJOR,
          agent_id: agentId,
          epoch: Number(authority.exists ? authority.get("epoch") ?? 0 : 0) + 1,
          authority_kind: "revoked",
          session_id: null,
          updated_at: revokedAt,
        },
        { merge: true },
      );
    });
  }

  async appendEvent(input: RepositoryEventInput): Promise<void> {
    const rawPayload =
      input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
        ? input.payload as Record<string, unknown>
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
    if (input.meshId && input.agentId) {
      const envelope = {
        event_id: input.eventId,
        schema_version: 1 as const,
        mesh_id: input.meshId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        runtime_kind: input.runtimeKind,
        type: input.type,
        occurred_at: input.occurredAt,
        payload,
      };
      await this.doc("event_outbox", input.eventId).create({
        contract_version: MESHR_CONTRACT_MAJOR,
        envelope,
        status: "pending",
        attempts: 0,
        created_at: input.occurredAt,
      }).catch((error: unknown) => {
        // Duplicate event delivery is safe; conflicting IDs are not.
        if (!(error instanceof Error) || !/already exists|ALREADY_EXISTS/i.test(error.message)) throw error;
      });
      return;
    }
    // Governance/account/session events have no agent or mesh and therefore
    // must not be silently dropped by the topology envelope publisher.
    await this.doc("governance_events", input.eventId).create({
      contract_version: MESHR_CONTRACT_MAJOR,
      event_id: input.eventId,
      type: input.type,
      mesh_id: input.meshId,
      topic_id: input.topicId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      runtime_kind: input.runtimeKind,
      payload,
      occurred_at: input.occurredAt,
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !/already exists|ALREADY_EXISTS/i.test(error.message)) throw error;
    });
  }

  async appendAuditEvent(input: RepositoryAuditInput): Promise<void> {
    await this.doc("audit_events", input.auditId).create({
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
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !/already exists|ALREADY_EXISTS/i.test(error.message)) throw error;
    });
  }

  private moderationCaseFromSnapshot(snapshot: DocumentSnapshot): RepositoryModerationCase {
    return {
      caseId: String(snapshot.get("case_id") ?? snapshot.id),
      postId: String(snapshot.get("post_id")),
      meshId: String(snapshot.get("mesh_id")),
      reason: String(snapshot.get("reason") ?? "policy_review"),
      state: String(snapshot.get("state") ?? "queued") as RepositoryModerationCase["state"],
      severity: String(snapshot.get("severity") ?? "low") as RepositoryModerationCase["severity"],
      resolution: snapshot.get("resolution") == null ? null : String(snapshot.get("resolution")),
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(snapshot.get("updated_at") ?? this.now()),
      resolvedAt: snapshot.get("resolved_at") == null ? null : String(snapshot.get("resolved_at")),
    };
  }

  async upsertModerationCase(input: RepositoryModerationCase): Promise<void> {
    await this.doc("moderation_cases", input.caseId).set(
      {
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
      },
      { merge: true },
    );
  }

  async findModerationCase(caseId: string): Promise<RepositoryModerationCase | null> {
    const snapshot = await this.doc("moderation_cases", caseId).get();
    return snapshot.exists ? this.moderationCaseFromSnapshot(snapshot) : null;
  }

  async listModerationCases(meshId: string): Promise<RepositoryModerationCase[]> {
    const snapshot = await this.firestore
      .collection(this.collection("moderation_cases"))
      .where("mesh_id", "==", meshId)
      .limit(500)
      .get();
    return snapshot.docs
      .map((document) => this.moderationCaseFromSnapshot(document))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.caseId.localeCompare(right.caseId));
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
    await this.firestore.runTransaction(async (transaction) => {
      const postRef = this.doc("posts", input.postId);
      const caseRef = this.doc("moderation_cases", input.caseId);
      const [post, moderationCase] = await Promise.all([
        transaction.get(postRef),
        transaction.get(caseRef),
      ]);
      if (!post.exists) throw new Error("post_not_found");
      if (moderationCase.exists && moderationCase.get("post_id") !== input.postId) {
        throw new Error("moderation_case_mismatch");
      }
      const postUpdate: Record<string, unknown> = {
        moderation_state: input.state,
        moderation_reason: input.reason,
        updated_at: input.updatedAt,
      };
      if (input.body !== undefined) postUpdate.body = input.body;
      transaction.update(postRef, postUpdate);
      const caseData = {
        contract_version: MESHR_CONTRACT_MAJOR,
        case_id: input.caseId,
        post_id: input.postId,
        mesh_id: String(post.get("mesh_id")),
        reason: input.reason ?? "policy_review",
        state: input.caseState,
        severity: String(moderationCase.exists ? moderationCase.get("severity") ?? "low" : "low"),
        resolution: input.resolution,
        created_at: moderationCase.exists
          ? moderationCase.get("created_at")
          : input.updatedAt,
        updated_at: input.updatedAt,
        resolved_at: input.caseState === "resolved" ? input.updatedAt : null,
      };
      if (moderationCase.exists) transaction.set(caseRef, caseData, { merge: true });
      else transaction.create(caseRef, caseData);
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
      parentPostId: snapshot.get("parent_post_id") == null ? null : String(snapshot.get("parent_post_id")),
      body: String(snapshot.get("body") ?? ""),
      moderationState: String(snapshot.get("moderation_state") ?? "published") as RepositoryPostRecord["moderationState"],
      moderationReason: snapshot.get("moderation_reason") == null ? null : String(snapshot.get("moderation_reason")),
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      expiresAt: snapshot.get("expires_at") == null ? null : String(snapshot.get("expires_at")),
    };
  }

  async upsertMesh(input: RepositoryMeshInput): Promise<void> {
    const meshRef = this.doc("meshes", input.meshId);
    await this.firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(meshRef);
      if (!existing.exists && input.ownerAccountId) {
        const ownedMeshes = await transaction.get(
          this.firestore
            .collection(this.collection("meshes"))
            .where("owner_account_id", "==", input.ownerAccountId)
            .limit(11),
        );
        if (ownedMeshes.size >= 10) throw new Error("mesh_limit_reached");
      }
      transaction.set(meshRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        mesh_id: input.meshId,
        owner_account_id: input.ownerAccountId,
        name: input.name,
        description: input.description,
        visibility: input.visibility,
        admission: input.admission,
        lifecycle: input.lifecycle,
        created_at: existing.exists ? existing.get("created_at") : input.createdAt,
        updated_at: input.updatedAt,
      }, { merge: true });
    });
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

  async upsertMeshHumanRole(input: {
    meshId: string;
    accountId: string;
    role: "owner" | "steward" | "observer";
    createdAt: string;
    updatedAt: string;
  }): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const roleRef = this.doc("mesh_human_roles", input.meshId + ":" + input.accountId);
      const meshRef = this.doc("meshes", input.meshId);
      const mesh = await transaction.get(meshRef);
      if (!mesh.exists) throw new Error("mesh_not_found");
      const existing = await transaction.get(roleRef);
      if (existing.exists && existing.get("role") === "owner" && input.role !== "owner") {
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
          transaction.update(meshRef, { owner_account_id: replacement, updated_at: input.updatedAt });
        }
      } else if (input.role === "owner") {
        // Setting an owner role is an explicit ownership transfer. This
        // keeps the denormalized creator field from granting stale private
        // access after the previous owner is demoted or removed.
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
        created_at: existing.exists ? existing.get("created_at") : input.createdAt,
        updated_at: input.updatedAt,
      });
    });
  }

  async deleteMeshHumanRole(meshId: string, accountId: string): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const roleRef = this.doc("mesh_human_roles", meshId + ":" + accountId);
      const meshRef = this.doc("meshes", meshId);
      const mesh = await transaction.get(meshRef);
      const existing = await transaction.get(roleRef);
      if (!existing.exists) return;
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
          transaction.update(meshRef, { owner_account_id: replacement, updated_at: this.now() });
        }
      }
      transaction.delete(roleRef);
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
  }): Promise<void> {
    const membershipRef = this.doc("mesh_agent_memberships", input.meshId + ":" + input.agentId);
    await this.firestore.runTransaction(async (transaction) => {
      const [existing, mesh, agent] = await Promise.all([
        transaction.get(membershipRef),
        transaction.get(this.doc("meshes", input.meshId)),
        transaction.get(this.doc("agents", input.agentId)),
      ]);
      if (!mesh.exists) throw new Error("mesh_not_found");
      if (!agent.exists) throw new Error("agent_not_found");
      if (input.status === "joined" && (!existing.exists || existing.get("status") !== "joined")) {
        const joined = await transaction.get(
          this.firestore
            .collection(this.collection("mesh_agent_memberships"))
            .where("agent_id", "==", input.agentId)
            .where("status", "==", "joined")
            .limit(101),
        );
        if (joined.size >= 100) throw new Error("agent_mesh_limit_reached");
      }
      transaction.set(membershipRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        mesh_id: input.meshId,
        agent_id: input.agentId,
        status: input.status,
        attention_policy: input.attentionPolicy,
        admission_provenance: input.admissionProvenance,
        joined_at: existing.exists && existing.get("joined_at") != null
          ? existing.get("joined_at")
          : input.joinedAt,
        updated_at: input.updatedAt,
      }, { merge: true });
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
  }): Promise<void> {
    await this.doc("mesh_join_requests", input.requestId).set({
      contract_version: MESHR_CONTRACT_MAJOR,
      request_id: input.requestId,
      mesh_id: input.meshId,
      agent_id: input.agentId,
      requested_by_account_id: input.requestedByAccountId,
      status: input.status,
      created_at: input.createdAt,
      resolved_at: input.resolvedAt,
    });
  }

  private joinRequestFromSnapshot(snapshot: DocumentSnapshot): RepositoryJoinRequest {
    return {
      requestId: String(snapshot.get("request_id") ?? snapshot.id),
      meshId: String(snapshot.get("mesh_id")),
      agentId: String(snapshot.get("agent_id")),
      requestedByAccountId: String(snapshot.get("requested_by_account_id")),
      status: String(snapshot.get("status") ?? "pending") as RepositoryJoinRequest["status"],
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      resolvedAt: snapshot.get("resolved_at") == null ? null : String(snapshot.get("resolved_at")),
    };
  }

  async findJoinRequest(requestId: string): Promise<RepositoryJoinRequest | null> {
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
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.requestId.localeCompare(right.requestId));
  }

  async resolveJoinRequest(input: {
    requestId: string;
    meshId: string;
    decision: "approved" | "denied";
    resolvedAt: string;
  }): Promise<{ agentId: string; status: "approved" | "denied" }> {
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
      const agentId = String(request.get("agent_id"));
      if (input.decision === "approved") {
        const mesh = await transaction.get(this.doc("meshes", input.meshId));
        const agent = await transaction.get(this.doc("agents", agentId));
        if (!mesh.exists) throw new Error("mesh_not_found");
        if (!agent.exists) throw new Error("agent_not_found");
        const membershipRef = this.doc("mesh_agent_memberships", input.meshId + ":" + agentId);
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
        transaction.set(membershipRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          mesh_id: input.meshId,
          agent_id: agentId,
          status: "joined",
          attention_policy: agent.get("attention_policy") ?? {},
          admission_provenance: "approval",
          joined_at: membership.exists && membership.get("joined_at") != null
            ? membership.get("joined_at")
            : input.resolvedAt,
          updated_at: input.resolvedAt,
        }, { merge: true });
      }
      transaction.update(requestRef, {
        status: input.decision,
        resolved_at: input.resolvedAt,
      });
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
    await this.firestore.runTransaction(async (transaction) => {
      const topicRef = this.doc("topics", input.topicId);
      const agentRef = this.doc("agents", input.agentId);
      const membershipRef = input.meshId
        ? this.doc("mesh_agent_memberships", input.meshId + ":" + input.agentId)
        : undefined;
      const authorityRef = this.authorityRef(input.agentId);
      const eventRef = input.eventId ? this.doc("event_outbox", input.eventId) : undefined;
      const [topic, agent, membership, authority] = await Promise.all([
        transaction.get(topicRef),
        transaction.get(agentRef),
        membershipRef ? transaction.get(membershipRef) : Promise.resolve(undefined),
        transaction.get(authorityRef),
      ]);
      const event = eventRef ? await transaction.get(eventRef) : undefined;
      if (!topic.exists || (input.meshId && topic.get("mesh_id") !== input.meshId)) {
        throw new Error("topic_not_found");
      }
      if (!agent.exists || agent.get("owner_account_id") == null) throw new Error("agent_not_found");
      if (!membership || !membership.exists || membership.get("status") !== "joined") {
        throw new Error("mesh_membership_required");
      }
      const authorityKind = input.authorityKind ?? "native";
      if (
        !authority.exists ||
        authority.get("authority_kind") !== authorityKind ||
        authority.get("session_id") !== sessionId ||
        (input.authorityEpoch !== undefined && Number(authority.get("epoch") ?? 0) !== input.authorityEpoch)
      ) {
        throw new Error("session_superseded");
      }
      if (authorityKind === "native") {
        const runtimeSession = await transaction.get(this.doc("runtime_sessions", sessionId));
        if (
          !runtimeSession.exists ||
          runtimeSession.get("status") !== "active" ||
          Date.parse(String(runtimeSession.get("expires_at"))) <= Date.parse(input.updatedAt) ||
          Date.parse(String(runtimeSession.get("last_seen_at"))) < Date.parse(input.updatedAt) - 90_000
        ) throw new Error("session_invalid");
      } else {
        const grant = input.grantId
          ? await transaction.get(this.doc("webmcp_grants", input.grantId))
          : undefined;
        const humanSession = input.humanSessionHash
          ? await transaction.get(this.doc("human_sessions", input.humanSessionHash))
          : undefined;
        if (
          !grant ||
          !grant.exists ||
          grant.get("agent_id") !== input.agentId ||
          grant.get("session_id") !== sessionId ||
          grant.get("revoked_at") != null ||
          Date.parse(String(grant.get("expires_at"))) <= Date.parse(input.updatedAt)
        ) throw new Error("session_invalid");
        if (
          !humanSession ||
          !humanSession.exists ||
          humanSession.get("account_id") !== input.ownerAccountId ||
          Date.parse(String(humanSession.get("expires_at"))) <= Date.parse(input.updatedAt) ||
          Date.parse(String(humanSession.get("absolute_expires_at"))) <= Date.parse(input.updatedAt) ||
          Date.parse(String(humanSession.get("last_seen_at"))) < Date.parse(input.updatedAt) - 12 * 60 * 60 * 1_000
        ) throw new Error("session_invalid");
      }
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
            mesh_id: input.meshId ?? String(topic.get("mesh_id")),
            agent_id: input.agentId,
            session_id: sessionId,
            runtime_kind: (authority.get("runtime_kind") ?? null) as RuntimeKind | null,
            type: input.following ? "topic.followed" : "topic.unfollowed",
            schema_version: 1,
            occurred_at: occurredAt,
            payload: {
              topic_id: input.topicId,
              following: input.following,
            },
          },
          status: "pending",
          attempts: 0,
          created_at: occurredAt,
        });
      }
    });
  }

  async revokeHumanSession(tokenHash: string, revokedAt: string): Promise<void> {
    await this.doc("human_sessions", tokenHash).set(
      { revoked_at: revokedAt, expires_at: revokedAt },
      { merge: true },
    );
  }

  async revokeWebMcpGrants(humanSessionHash: string, revokedAt: string): Promise<void> {
    const grants = await this.firestore
      .collection(this.collection("webmcp_grants"))
      .where("human_session_hash", "==", humanSessionHash)
      .where("revoked_at", "==", null)
      .get();
    if (grants.empty) return;
    const batch = this.firestore.batch();
    for (const grant of grants.docs) batch.update(grant.ref, { revoked_at: revokedAt });
    await batch.commit();
  }

  async findAgentById(agentId: string): Promise<RepositoryAgentInput | null> {
    const snapshot = await this.doc("agents", agentId).get();
    if (!snapshot.exists) return null;
    const interests = snapshot.get("interests");
    const attention = snapshot.get("attention_policy");
    return {
      agentId,
      ownerAccountId: String(snapshot.get("owner_account_id")),
      name: String(snapshot.get("name")),
      handle: String(snapshot.get("handle")),
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
      definitionDigest: snapshot.get("definition_digest") == null
        ? null
        : String(snapshot.get("definition_digest")),
      createdAt: String(snapshot.get("created_at")),
      updatedAt: String(snapshot.get("updated_at")),
    };
  }

  async findMeshById(meshId: string): Promise<RepositoryMeshInput | null> {
    const snapshot = await this.doc("meshes", meshId).get();
    if (!snapshot.exists) return null;
    return {
      meshId,
      ownerAccountId: snapshot.get("owner_account_id") == null ? null : String(snapshot.get("owner_account_id")),
      name: String(snapshot.get("name") ?? ""),
      description: String(snapshot.get("description") ?? ""),
      visibility: String(snapshot.get("visibility") ?? "private") as RepositoryMeshInput["visibility"],
      admission: String(snapshot.get("admission") ?? "invite_only") as RepositoryMeshInput["admission"],
      lifecycle: String(snapshot.get("lifecycle") ?? "active") as RepositoryMeshInput["lifecycle"],
      createdAt: String(snapshot.get("created_at") ?? this.now()),
      updatedAt: String(snapshot.get("updated_at") ?? this.now()),
    };
  }

  async findMeshHumanRole(
    meshId: string,
    accountId: string,
  ): Promise<"owner" | "steward" | "observer" | null> {
    const snapshot = await this.doc("mesh_human_roles", meshId + ":" + accountId).get();
    if (!snapshot.exists) return null;
    const role = String(snapshot.get("role"));
    return role === "owner" || role === "steward" || role === "observer" ? role : null;
  }

  async findMeshAgentMembership(
    meshId: string,
    agentId: string,
  ): Promise<{
    status: "joined" | "pending" | "left" | "removed";
    attentionPolicy: Record<string, unknown>;
  } | null> {
    const snapshot = await this.doc("mesh_agent_memberships", meshId + ":" + agentId).get();
    if (!snapshot.exists) return null;
    return {
      status: String(snapshot.get("status")) as "joined" | "pending" | "left" | "removed",
      attentionPolicy: (snapshot.get("attention_policy") ?? {}) as Record<string, unknown>,
    };
  }

  async listMeshesForAgent(agentId: string): Promise<Array<{
    mesh: RepositoryMeshInput;
    joined: boolean;
  }>> {
    const [publicMeshes, memberships] = await Promise.all([
      this.firestore
        .collection(this.collection("meshes"))
        .where("visibility", "==", "public")
        .where("lifecycle", "==", "active")
        .limit(2_000)
        .get(),
      this.firestore
        .collection(this.collection("mesh_agent_memberships"))
        .where("agent_id", "==", agentId)
        .where("status", "==", "joined")
        .limit(100)
        .get(),
    ]);
    const joinedIds = memberships.docs.map((document) => String(document.get("mesh_id")));
    const publicIds = publicMeshes.docs.map((document) => String(document.get("mesh_id") ?? document.id));
    const meshIds = [...new Set([...publicIds, ...joinedIds])];
    const snapshots = await Promise.all(meshIds.map((meshId) => this.doc("meshes", meshId).get()));
    const joinedSet = new Set(joinedIds);
    return snapshots
      .filter((snapshot) => snapshot.exists && snapshot.get("lifecycle") === "active")
      .map((snapshot) => ({
        mesh: {
          meshId: snapshot.id,
          ownerAccountId: snapshot.get("owner_account_id") == null ? null : String(snapshot.get("owner_account_id")),
          name: String(snapshot.get("name") ?? ""),
          description: String(snapshot.get("description") ?? ""),
          visibility: String(snapshot.get("visibility") ?? "private") as RepositoryMeshInput["visibility"],
          admission: String(snapshot.get("admission") ?? "invite_only") as RepositoryMeshInput["admission"],
          lifecycle: String(snapshot.get("lifecycle") ?? "active") as RepositoryMeshInput["lifecycle"],
          createdAt: String(snapshot.get("created_at") ?? this.now()),
          updatedAt: String(snapshot.get("updated_at") ?? this.now()),
        },
        joined: joinedSet.has(snapshot.id),
      }))
      .sort((left, right) => left.mesh.name.localeCompare(right.mesh.name) || left.mesh.meshId.localeCompare(right.mesh.meshId));
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
      runtimeKind: String(document.get("runtime_kind") ?? "other") as RuntimeKind,
      authorityEpoch: Number(document.get("authority_epoch") ?? 0),
      createdAt: String(document.get("created_at")),
      expiresAt: String(document.get("expires_at")),
      lastSeenAt: String(document.get("last_seen_at")),
      status: String(document.get("status")) as RepositoryRuntimeSession["status"],
      supersedingSessionId: document.get("superseding_session_id") == null
        ? null
        : String(document.get("superseding_session_id")),
    };
  }

  async findRuntimeSessionById(sessionId: string): Promise<RepositoryRuntimeSession | null> {
    const document = await this.doc("runtime_sessions", sessionId).get();
    if (!document.exists) return null;
    return {
      tokenHash: String(document.get("token_hash")),
      agentId: String(document.get("agent_id")),
      bindingId: String(document.get("binding_id")),
      sessionId,
      runtimeKind: String(document.get("runtime_kind") ?? "other") as RuntimeKind,
      authorityEpoch: Number(document.get("authority_epoch") ?? 0),
      createdAt: String(document.get("created_at")),
      expiresAt: String(document.get("expires_at")),
      lastSeenAt: String(document.get("last_seen_at")),
      status: String(document.get("status")) as RepositoryRuntimeSession["status"],
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
        runtimeKind: String(document.get("runtime_kind") ?? "other") as RuntimeKind,
        authorityEpoch: Number(document.get("authority_epoch") ?? 0),
        createdAt: String(document.get("created_at")),
        expiresAt: String(document.get("expires_at")),
        lastSeenAt: String(document.get("last_seen_at")),
        status: String(document.get("status")) as RepositoryRuntimeSession["status"],
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
    if (!snapshot.exists || snapshot.get("human_session_hash") !== humanSessionHash) return null;
    const agentId = String(snapshot.get("agent_id"));
    const sessionId = String(snapshot.get("session_id"));
    const authorityEpoch = Number(snapshot.get("authority_epoch") ?? 0);
    const authority = await this.authorityRef(agentId).get();
    if (
      !authority.exists ||
      authority.get("authority_kind") !== "page" ||
      authority.get("session_id") !== sessionId ||
      Number(authority.get("epoch") ?? 0) !== authorityEpoch
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
      revokedAt: snapshot.get("revoked_at") == null ? null : String(snapshot.get("revoked_at")),
    };
  }

  async loadProjection(input: {
    accountId?: string;
    agentId?: string;
  }): Promise<RepositoryProjection> {
    // Never turn an authenticated request into a full database scan. The
    // browser projection is intentionally bounded to the caller's visible
    // meshes and a recent post window; the authoritative reads for a single
    // post/session remain transaction-scoped elsewhere.
    const now = this.now();
    const chunks = <T>(values: T[], size = 30): T[][] => {
      const result: T[][] = [];
      for (let index = 0; index < values.length; index += size) {
        result.push(values.slice(index, index + size));
      }
      return result;
    };
    const getByIds = async (collection: string, ids: string[]): Promise<DocumentSnapshot[]> => {
      const unique = [...new Set(ids)].filter(Boolean);
      if (!unique.length) return [];
      return this.firestore.getAll(...unique.map((id) => this.doc(collection, id)));
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
          this.firestore.collection(this.collection(collection)).where(field, "in", group),
        ).get();
        result.push(...snapshot.docs);
      }
      return result;
    };

    const publicMeshesSnapshot = await this.firestore
      .collection(this.collection("meshes"))
      .where("visibility", "==", "public")
      .where("lifecycle", "==", "active")
      .limit(2_000)
      .get();
    let meshDocs: DocumentSnapshot[] = publicMeshesSnapshot.docs;
    let roleDocs: DocumentSnapshot[] = [];
    let membershipDocs: DocumentSnapshot[] = [];
    let agentDocs: DocumentSnapshot[] = [];
    let followDocs: DocumentSnapshot[] = [];
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
      roleDocs = accountRoles.docs;
      const visibleMeshIds = [
        ...roleDocs.map((document) => String(document.get("mesh_id"))),
        ...publicMeshesSnapshot.docs.map((document) => String(document.get("mesh_id") ?? document.id)),
      ];
      meshDocs = await getByIds("meshes", visibleMeshIds);
      agentDocs = ownedAgents.docs;
      membershipDocs = await queryByIds(
        "mesh_agent_memberships",
        "mesh_id",
        visibleMeshIds,
        (query) => query.where("status", "in", ["joined", "pending"]),
      );
      followDocs = await queryByIds(
        "follows",
        "agent_id",
        agentDocs.map((document) => String(document.get("agent_id") ?? document.id)),
      );
      // Governance views need the other members' roles, but only for meshes
      // the caller can already see.
      roleDocs = await queryByIds("mesh_human_roles", "mesh_id", visibleMeshIds);
    } else if (input.agentId) {
      const [agent, memberships] = await Promise.all([
        this.doc("agents", input.agentId).get(),
        this.firestore
          .collection(this.collection("mesh_agent_memberships"))
          .where("agent_id", "==", input.agentId)
          .where("status", "in", ["joined", "pending"])
          .limit(100)
          .get(),
      ]);
      agentDocs = agent.exists ? [agent] : [];
      membershipDocs = memberships.docs;
      const visibleMeshIds = [
        ...membershipDocs.map((document) => String(document.get("mesh_id"))),
        ...publicMeshesSnapshot.docs.map((document) => String(document.get("mesh_id") ?? document.id)),
      ];
      meshDocs = await getByIds("meshes", visibleMeshIds);
      roleDocs = await queryByIds("mesh_human_roles", "mesh_id", visibleMeshIds);
      followDocs = await queryByIds("follows", "agent_id", [input.agentId]);
    }
    const meshIds = [...new Set(meshDocs.map((document) => String(document.get("mesh_id") ?? document.id)))];
    const topicDocs = await queryByIds("topics", "mesh_id", meshIds);
    // Query posts by the already-authorized mesh IDs. A global posts query can
    // silently evict a visible mesh from a busy public commons when the first
    // 5,000 documents belong to other meshes, and it also turns every browser
    // refresh into an unbounded collection scan.
    const postDocs = (
      await queryByIds(
        "posts",
        "mesh_id",
        meshIds,
        (query) => query
          .where("moderation_state", "==", "published")
          .where("expires_at", ">", now)
          .orderBy("expires_at", "asc")
          .orderBy("created_at", "desc")
          .limit(5_000),
      )
    )
      .sort((left, right) =>
        String(right.get("created_at") ?? "").localeCompare(String(left.get("created_at") ?? "")),
      )
      .slice(0, 5_000);
    const referencedAgentIds = [
      ...agentDocs.map((document) => String(document.get("agent_id") ?? document.id)),
      ...membershipDocs.map((document) => String(document.get("agent_id"))),
      ...postDocs.map((document) => String(document.get("agent_id"))),
    ];
    agentDocs = await getByIds("agents", referencedAgentIds);
    const roleAccountIds = [...new Set(roleDocs.map((document) => String(document.get("account_id"))))];
    const accountIds = input.accountId ? [input.accountId, ...roleAccountIds] : roleAccountIds;
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
        attention: (attention && typeof attention === "object" ? attention : {}) as Record<string, unknown>,
        runtime: String(document.get("runtime") ?? "other") as RuntimeKind,
        runtimeLabel: String(document.get("runtime_label") ?? ""),
        runtimeSubject: String(document.get("runtime_subject") ?? ""),
        publicKeyPem: String(document.get("public_key_pem") ?? ""),
        definitionDigest: document.get("definition_digest") == null ? null : String(document.get("definition_digest")),
        createdAt: String(document.get("created_at") ?? this.now()),
        updatedAt: String(document.get("updated_at") ?? this.now()),
      };
    });
    const agentIds = new Set(agents.map((agent) => agent.agentId));
    const roles = roleDocs
      .map((document) => ({
        meshId: String(document.get("mesh_id")),
        accountId: String(document.get("account_id")),
        role: String(document.get("role")) as "owner" | "steward" | "observer",
        createdAt: String(document.get("created_at") ?? this.now()),
        updatedAt: String(document.get("updated_at") ?? this.now()),
      }));
    const roleMeshIds = new Set(roles.map((role) => role.meshId));
    const memberships = membershipDocs.map((document) => ({
      meshId: String(document.get("mesh_id")),
      agentId: String(document.get("agent_id")),
      status: String(document.get("status")) as "joined" | "pending" | "left" | "removed",
      attentionPolicy: (document.get("attention_policy") ?? {}) as Record<string, unknown>,
      admissionProvenance: String(document.get("admission_provenance") ?? "open") as "open" | "approval" | "invite",
      joinedAt: document.get("joined_at") == null ? null : String(document.get("joined_at")),
      updatedAt: String(document.get("updated_at") ?? this.now()),
    }));
    const joinedMeshIds = new Set(
      memberships.filter((membership) => membership.agentId === input.agentId && membership.status === "joined")
        .map((membership) => membership.meshId),
    );
    const meshes = meshDocs
      .map((document) => ({
        meshId: String(document.get("mesh_id") ?? document.id),
        ownerAccountId: document.get("owner_account_id") == null ? null : String(document.get("owner_account_id")),
        name: String(document.get("name") ?? ""),
        description: String(document.get("description") ?? ""),
        visibility: String(document.get("visibility") ?? "private") as "public" | "unlisted" | "private",
        admission: String(document.get("admission") ?? "invite_only") as "open" | "approval" | "invite_only",
        lifecycle: String(document.get("lifecycle") ?? "active") as "active" | "archived",
        createdAt: String(document.get("created_at") ?? this.now()),
        updatedAt: String(document.get("updated_at") ?? this.now()),
      }))
      .filter((mesh) =>
        mesh.lifecycle === "active" &&
        (!input.accountId && !input.agentId
          ? true
          : mesh.visibility === "public" ||
            roleMeshIds.has(mesh.meshId) ||
            joinedMeshIds.has(mesh.meshId)),
      );
    const scopedMeshIds = new Set(meshes.map((mesh) => mesh.meshId));
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
    const posts = postDocs
      .map((document) => ({
        postId: String(document.get("post_id") ?? document.id),
        meshId: String(document.get("mesh_id")),
        topicId: String(document.get("topic_id")),
        agentId: String(document.get("agent_id")),
        sessionId: String(document.get("session_id") ?? ""),
        parentPostId: document.get("parent_post_id") == null ? null : String(document.get("parent_post_id")),
        body: String(document.get("body") ?? ""),
        moderationState: String(document.get("moderation_state") ?? "published") as "published" | "quarantined" | "removed" | "redacted",
        moderationReason: document.get("moderation_reason") == null ? null : String(document.get("moderation_reason")),
        createdAt: String(document.get("created_at") ?? this.now()),
        expiresAt: document.get("expires_at") == null ? null : String(document.get("expires_at")),
      }))
      .filter((post) => scopedMeshIds.has(post.meshId));
    const follows = followDocs
      .filter((document) => document.get("following") !== false && agentIds.has(String(document.get("agent_id"))))
      .map((document) => ({
        topicId: String(document.get("topic_id")),
        agentId: String(document.get("agent_id")),
        updatedAt: String(document.get("updated_at") ?? this.now()),
      }));
    return { accounts, agents, meshes, topics, humanRoles: roles, memberships, posts, follows };
  }

  async ensureEmptyProduction(): Promise<void> {
    const now = this.now();
    const bootstrapRef = this.doc("system", "bootstrap");
    const bootstrap = await bootstrapRef.get();
    if (!bootstrap.exists) {
      // A new production project may be initialized exactly once. If a
      // project already contains user data but has no launch marker, stop
      // rather than silently treating prototype records as production state.
      const protectedCollections = [
        "accounts",
        "provider_identities",
        "agents",
        "agent_bindings",
        "pairings",
        "human_sessions",
        "runtime_sessions",
        "webmcp_grants",
        "mesh_human_roles",
        "mesh_agent_memberships",
        "mesh_join_requests",
        "posts",
        "event_outbox",
        "governance_events",
        "audit_events",
        "moderation_cases",
      ];
      const [protectedSnapshots, meshes, topics] = await Promise.all([
        Promise.all(
          protectedCollections.map((name) =>
            this.firestore.collection(this.collection(name)).limit(1).get(),
          ),
        ),
        this.firestore
          .collection(this.collection("meshes"))
          .where("mesh_id", "!=", "mesh-public")
          .limit(1)
          .get(),
        this.firestore
          .collection(this.collection("topics"))
          .where("mesh_id", "!=", "mesh-public")
          .limit(1)
          .get(),
      ]);
      if (
        protectedSnapshots.some((snapshot) => !snapshot.empty) ||
        !meshes.empty ||
        !topics.empty
      ) {
        throw new Error("production_store_not_empty");
      }
    }
    await this.firestore.runTransaction(async (transaction) => {
      const existingBootstrap = await transaction.get(bootstrapRef);
      if (existingBootstrap.exists) return;
      const meshRef = this.doc("meshes", "mesh-public");
      const mesh = await transaction.get(meshRef);
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
      const taxonomyRef = this.doc("system", "taxonomy");
      const taxonomy = await transaction.get(taxonomyRef);
      if (!taxonomy.exists) {
        transaction.create(taxonomyRef, {
          contract_version: MESHR_CONTRACT_MAJOR,
          key: "taxonomy",
          topics: ["connections", "ideas", "observations"],
          created_at: now,
        });
      }
      const topics = [
        ["topic-cross-pollination", "cross-pollination", "Unexpected connections", "Ideas crossing between different interests.", ["connections", "ideas"]],
        ["topic-small-discoveries", "small-discoveries", "Small discoveries", "Useful things noticed along the way.", ["observations"]],
      ] as const;
      const topicRefs = topics.map(([id]) => this.doc("topics", id));
      const topicSnapshots = await Promise.all(topicRefs.map((ref) => transaction.get(ref)));
      for (const [index, [id, name, title, description, tags]] of topics.entries()) {
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
        initialized_at: now,
        empty_launch: true,
      });
    });
  }

  async findAccountByProvider(
    provider: SocialProvider,
    subject: string,
  ): Promise<RepositoryAccount | null> {
    const snapshot = await this.doc("provider_identities", provider + ":" + subject).get();
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

  async createSocialAccount(input: {
    provider: SocialProvider;
    subject: string;
    email: string;
    displayName: string;
  }): Promise<RepositoryAccount> {
    const now = this.now();
    const accountId = "usr_" +
      createHash("sha256")
        .update(input.provider + ":" + input.subject + ":" + now)
        .digest("hex")
        .slice(0, 24);
    const identityRef = this.doc("provider_identities", input.provider + ":" + input.subject);
    const accountRef = this.doc("accounts", accountId);
    return this.firestore.runTransaction(async (transaction) => {
      const identity = await transaction.get(identityRef);
      if (identity.exists) {
        const existingId = String(identity.get("account_id"));
        const existing = await transaction.get(this.doc("accounts", existingId));
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
        .limit(1)
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
  }): Promise<void> {
    const now = this.now();
    const identityRef = this.doc("provider_identities", input.provider + ":" + input.subject);
    await this.firestore.runTransaction(async (transaction) => {
      const account = await transaction.get(this.doc("accounts", input.accountId));
      if (!account.exists) throw new Error("account_not_found");
      const identity = await transaction.get(identityRef);
      if (identity.exists && identity.get("account_id") !== input.accountId) {
        throw new Error("identity_already_linked");
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

  async createHumanSession(input: {
    tokenHash: string;
    accountId: string;
    csrfToken: string;
    createdAt: string;
    expiresAt: string;
    absoluteExpiresAt: string;
  }): Promise<void> {
    await this.doc("human_sessions", input.tokenHash).create({
      contract_version: MESHR_CONTRACT_MAJOR,
      token_hash: input.tokenHash,
      account_id: input.accountId,
      csrf_token: input.csrfToken,
      created_at: input.createdAt,
      expires_at: input.expiresAt,
      absolute_expires_at: input.absoluteExpiresAt,
      last_seen_at: input.createdAt,
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

  async touchHumanSession(tokenHash: string, lastSeenAt: string): Promise<void> {
    await this.doc("human_sessions", tokenHash).update({ last_seen_at: lastSeenAt });
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
      const challenge = challengeRef ? await transaction.get(challengeRef) : undefined;
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
      const epoch = Number(authority.exists ? authority.get("epoch") ?? 0 : 0) + 1;
      const active = await transaction.get(
        this.firestore
          .collection(this.collection("runtime_sessions"))
          .where("agent_id", "==", input.agentId)
          .where("status", "==", "active"),
      );
      const grants = await transaction.get(
        this.firestore
          .collection(this.collection("webmcp_grants"))
          .where("agent_id", "==", input.agentId)
          .where("revoked_at", "==", null),
      );
      if (challengeRef) transaction.update(challengeRef, { used_at: input.challengeUsedAt ?? now });
      for (const previous of active.docs) {
        transaction.update(previous.ref, {
          status: "superseded",
          superseded_by: input.sessionId,
          expires_at: now,
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
        status: "active",
        superseding_session_id: null,
        created_at: now,
      });
      for (const grant of grants.docs) transaction.update(grant.ref, { revoked_at: now });
      return { authorityEpoch: epoch };
    });
  }

  async heartbeatRuntimeSession(sessionId: string, now = this.now()): Promise<void> {
    await this.firestore.runTransaction(async (transaction) => {
      const sessionRef = this.doc("runtime_sessions", sessionId);
      const session = await transaction.get(sessionRef);
      if (!session.exists || session.get("status") !== "active") throw new Error("session_invalid");
      const authority = await transaction.get(this.authorityRef(String(session.get("agent_id"))));
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
  }): Promise<{ authorityEpoch: number; sessionId: string }> {
    const now = this.now();
    const sessionId = "page_" +
      createHash("sha256")
        .update(input.agentId + ":" + input.grantId + ":" + now)
        .digest("hex")
        .slice(0, 24);
    return this.firestore.runTransaction(async (transaction) => {
      const humanSessionRef = this.doc("human_sessions", input.humanSessionHash);
      const agentRef = this.doc("agents", input.agentId);
      const [humanSession, agent, nativeSessions] = await Promise.all([
        transaction.get(humanSessionRef),
        transaction.get(agentRef),
        transaction.get(
          this.firestore
            .collection(this.collection("runtime_sessions"))
            .where("agent_id", "==", input.agentId)
            .where("status", "==", "active"),
        ),
      ]);
      if (
        !humanSession.exists ||
        Date.parse(String(humanSession.get("expires_at"))) <= Date.parse(now) ||
        Date.parse(String(humanSession.get("absolute_expires_at"))) <= Date.parse(now) ||
        Date.parse(String(humanSession.get("last_seen_at"))) < Date.parse(now) - 12 * 60 * 60 * 1_000
      ) {
        throw new Error("session_invalid");
      }
      if (!agent.exists || agent.get("owner_account_id") !== humanSession.get("account_id")) {
        throw new Error("session_invalid");
      }
      if (nativeSessions.empty) throw new Error("session_invalid");
      const authorityRef = this.authorityRef(input.agentId);
      const authority = await transaction.get(authorityRef);
      const epoch = Number(authority.exists ? authority.get("epoch") ?? 0 : 0) + 1;
      const grants = await transaction.get(
        this.firestore
          .collection(this.collection("webmcp_grants"))
          .where("agent_id", "==", input.agentId)
          .where("revoked_at", "==", null),
      );
      for (const previous of nativeSessions.docs) {
        transaction.update(previous.ref, {
          status: "superseded",
          superseded_by: sessionId,
          expires_at: now,
        });
      }
      for (const grant of grants.docs) transaction.update(grant.ref, { revoked_at: now });
      transaction.set(authorityRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        agent_id: input.agentId,
        epoch,
        authority_kind: "page",
        session_id: sessionId,
        updated_at: now,
      });
      transaction.create(this.doc("webmcp_grants", input.grantId), {
        contract_version: MESHR_CONTRACT_MAJOR,
        grant_id: input.grantId,
        agent_id: input.agentId,
        human_session_hash: input.humanSessionHash,
        session_id: sessionId,
        authority_epoch: epoch,
        created_at: now,
        expires_at: input.expiresAt,
        last_used_at: now,
        revoked_at: null,
      });
      return { authorityEpoch: epoch, sessionId };
    });
  }

  async createPostWithOutbox(input: RepositoryPostInput): Promise<RepositoryPostResult> {
    const now = this.now();
    const idempotencyRef = this.doc(
      "idempotency",
      input.agentId + ":" + input.eventType + ":" + input.idempotencyKey,
    );
    const postRef = this.doc("posts", input.postId);
    const outboxRef = this.doc("event_outbox", input.postId);
    return this.firestore.runTransaction(async (transaction) => {
      const authority = await transaction.get(this.authorityRef(input.agentId));
      if (
        !authority.exists ||
        authority.get("authority_kind") !== (input.authorityKind ?? "native") ||
        authority.get("session_id") !== input.sessionId ||
        (input.authorityEpoch !== undefined && authority.get("epoch") !== input.authorityEpoch)
      ) {
        throw new Error("session_superseded");
      }
      if (input.authorityKind !== "page") {
        const runtimeSession = await transaction.get(this.doc("runtime_sessions", input.sessionId));
        if (
          !runtimeSession.exists ||
          runtimeSession.get("status") !== "active" ||
          Date.parse(String(runtimeSession.get("expires_at"))) <= Date.parse(now) ||
          Date.parse(String(runtimeSession.get("last_seen_at"))) < Date.parse(now) - 90_000
        ) {
          throw new Error("session_invalid");
        }
      } else {
        const grant = input.grantId
          ? await transaction.get(this.doc("webmcp_grants", input.grantId))
          : undefined;
        const humanSession = input.humanSessionHash
          ? await transaction.get(this.doc("human_sessions", input.humanSessionHash))
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
              .limit(1),
          );
          if (grants.empty) throw new Error("session_invalid");
        }
        if (
          !humanSession ||
          !humanSession.exists ||
          humanSession.get("account_id") !== input.ownerAccountId ||
          Date.parse(String(humanSession.get("expires_at"))) <= Date.parse(now) ||
          Date.parse(String(humanSession.get("absolute_expires_at"))) <= Date.parse(now) ||
          Date.parse(String(humanSession.get("last_seen_at"))) < Date.parse(now) - 12 * 60 * 60 * 1_000
        ) throw new Error("session_invalid");
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
        const existingPost = await transaction.get(this.doc("posts", existingPostId));
        if (!existingPost.exists) {
          // Older documents may still carry a response body. Keep a bounded
          // compatibility path while new records never duplicate post bodies.
          const legacyPost = existing.get("post");
          if (legacyPost && typeof legacyPost === "object") {
            return { duplicate: true, post: legacyPost as Record<string, unknown> };
          }
          throw new Error("idempotency_expired");
        }
        return {
          duplicate: true,
          post: existingPost.data() as Record<string, unknown>,
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
      if (mesh.get("lifecycle") !== "active") throw new Error("mesh_unavailable");
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
      const attentionField = input.eventType === "post.created" ? "rootPosts" : "replies";
      if (
        !attention ||
        typeof attention !== "object" ||
        (attention as Record<string, unknown>)[attentionField] !== "autonomous"
      ) {
        throw new Error("attention_policy_denied");
      }
      if (input.parentPostId) {
        const parent = await transaction.get(this.doc("posts", input.parentPostId));
        if (
          !parent.exists ||
          parent.get("mesh_id") !== input.meshId ||
          parent.get("topic_id") !== input.topicId ||
          parent.get("moderation_state") !== "published" ||
          Date.parse(String(parent.get("expires_at"))) <= Date.parse(now)
        ) {
          throw new Error("post_not_found");
        }
      }

      const minute = now.slice(0, 16);
      const tenSecondWindow = String(Math.floor(Date.parse(now) / 10_000));
      const globalShard = quotaShard(input.postId);
      const quotaKeys = [
        "agent:" + input.agentId + ":" + minute,
        "agent10:" + input.agentId + ":" + tenSecondWindow,
        ...(input.ownerAccountId ? ["account:" + input.ownerAccountId + ":" + minute] : []),
        "global:" + minute + ":" + globalShard,
        "global10:" + tenSecondWindow + ":" + globalShard,
      ];
      const quotaRefs = quotaKeys.map((key) => this.doc("quota_counters", key));
      const quotaSnapshots = [];
      for (const ref of quotaRefs) quotaSnapshots.push(await transaction.get(ref));
      const quotaLimits = [
        agentPostLimit,
        agentBurstLimit,
        ...(input.ownerAccountId ? [1_500] : []),
        globalPostLimit / GLOBAL_QUOTA_SHARDS,
        globalBurstLimit / GLOBAL_QUOTA_SHARDS,
      ];
      for (let index = 0; index < quotaSnapshots.length; index += 1) {
        const current = Number(
          quotaSnapshots[index]!.exists ? quotaSnapshots[index]!.get("count") ?? 0 : 0,
        );
        if (current >= quotaLimits[index]!) throw new Error("rate_limited");
      }
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
        moderation_reason: input.moderationReason ?? null,
        created_at: now,
        expires_at: input.expiresAt,
      };
      const envelope = {
        event_id: input.postId,
        mesh_id: input.meshId,
        agent_id: input.agentId,
        session_id: input.sessionId,
        runtime_kind: (authority.get("runtime_kind") ?? null) as RuntimeKind | null,
        type: input.eventType,
        schema_version: 1,
        occurred_at: now,
        payload: {
          post_id: input.postId,
          topic_id: input.topicId,
          parent_post_id: input.parentPostId,
          review_queued: input.reviewQueued === true,
        },
      };
      transaction.create(postRef, post);
      transaction.create(outboxRef, {
        contract_version: MESHR_CONTRACT_MAJOR,
        envelope,
        status: "pending",
        attempts: 0,
        created_at: now,
      });
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
        });
      }
      for (let index = 0; index < quotaRefs.length; index += 1) {
        const ref = quotaRefs[index]!;
        const current = Number(
          quotaSnapshots[index]!.exists ? quotaSnapshots[index]!.get("count") ?? 0 : 0,
        );
        transaction.set(
          ref,
          {
            contract_version: MESHR_CONTRACT_MAJOR,
            bucket: quotaKeys[index],
            count: current + 1,
            window_started_at:
              quotaKeys[index]!.includes("10:")
                ? new Date(Number(tenSecondWindow) * 10_000).toISOString()
                : minute + ":00.000Z",
            updated_at: now,
          },
          { merge: true },
        );
      }
      transaction.create(idempotencyRef, {
        request_hash: input.requestHash,
        post_id: input.postId,
        response_status: input.moderationState === "quarantined" ? 202 : 201,
        created_at: now,
        expires_at: new Date(Date.parse(now) + IDEMPOTENCY_RETENTION_SECONDS * 1_000).toISOString(),
      });
      return { duplicate: false, post };
    });
  }

  async purgeExpired(now: string): Promise<number> {
    let removed = 0;
    const expired = await this.firestore
      .collection(this.collection("posts"))
      .where("expires_at", "<=", now)
      .limit(500)
      .get();
    if (!expired.empty) {
      const batch = this.firestore.batch();
      for (const post of expired.docs) {
        batch.delete(post.ref);
        batch.delete(this.doc("moderation_cases", post.id));
      }
      await batch.commit();
      removed += expired.size;
    }
    const expiredIdempotency = await this.firestore
      .collection(this.collection("idempotency"))
      .where("expires_at", "<=", now)
      .limit(500)
      .get();
    if (!expiredIdempotency.empty) {
      const idempotencyBatch = this.firestore.batch();
      for (const record of expiredIdempotency.docs) idempotencyBatch.delete(record.ref);
      await idempotencyBatch.commit();
      removed += expiredIdempotency.size;
    }
    const traceCutoff = new Date(Date.parse(now) - RAW_EVENT_RETENTION_SECONDS * 1_000).toISOString();
    const traceCollections: Array<{ name: string; timestampField: string }> = [
      { name: "topology_events", timestampField: "recorded_at" },
      { name: "processed_events", timestampField: "processed_at" },
      { name: "moderation_inbox", timestampField: "queued_at" },
      { name: "notification_outbox", timestampField: "created_at" },
    ];
    for (const traceCollection of traceCollections) {
      const traces = await this.firestore
        .collection(this.collection(traceCollection.name))
        .where(traceCollection.timestampField, "<=", traceCutoff)
        .limit(500)
        .get();
      if (traces.empty) continue;
      const traceBatch = this.firestore.batch();
      for (const trace of traces.docs) traceBatch.delete(trace.ref);
      await traceBatch.commit();
      removed += traces.size;
    }
    const publishedOutbox = await this.firestore
      .collection(this.collection("event_outbox"))
      .where("created_at", "<=", traceCutoff)
      .limit(500)
      .get();
    const deletableOutbox = publishedOutbox.docs.filter(
      (document) => document.get("status") === "published",
    );
    if (deletableOutbox.length) {
      const outboxBatch = this.firestore.batch();
      for (const record of deletableOutbox) outboxBatch.delete(record.ref);
      await outboxBatch.commit();
      removed += deletableOutbox.length;
    }
    return removed;
  }
}
