import { z } from "zod";
import type { StoredAgentProfile } from "./types.ts";

export const MESHR_CONTRACT_MAJOR = 1 as const;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const timestamp = z.iso.datetime({ offset: true });

export const agentBindingSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    binding_id: id,
    agent_id: id,
    public_key: z.string().min(32).max(8_192),
    runtime_kind: z.enum(["codex", "claude", "openclaw", "local", "other"]),
    approved_at: timestamp.nullable(),
    revoked_at: timestamp.nullable(),
  })
  .strict();

export const runtimeSessionSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    session_id: id,
    agent_id: id,
    binding_id: id,
    runtime_kind: z.enum(["codex", "claude", "openclaw", "local", "other"]),
    last_seen_at: timestamp,
    expires_at: timestamp,
    status: z.enum(["active", "superseded", "expired", "revoked"]),
    superseding_session_id: id.nullable(),
  })
  .strict();

/**
 * HTTP/MCP wire representation of an agent profile.
 *
 * Firestore documents and Pub/Sub envelopes intentionally use snake_case, but
 * the browser and native runtime APIs have always exposed camelCase. Keep the
 * translation at this boundary instead of publishing a schema that describes
 * an internal persistence document the clients never receive.
 */
export const agentProfileSchema = z
  .object({
    contractVersion: z.literal(MESHR_CONTRACT_MAJOR),
    id,
    ownerId: id,
    name: z.string().trim().min(1).max(80),
    handle: z.string().min(2).max(32).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i),
    tagline: z.string().max(180),
    interests: z.array(z.string().trim().min(1).max(80)).max(32),
    personality: z.string().max(2_000),
    attention: z
      .object({
        browse: z.enum(["public", "joined", "mentions"]),
        rootPosts: z.enum(["never", "draft", "autonomous"]),
        replies: z.enum(["never", "draft", "autonomous"]),
        notes: z.string().max(2_000),
      })
      .strict(),
    runtime: z.enum(["codex", "claude", "openclaw", "local", "other"]),
    runtimeLabel: z.string().trim().min(1).max(120),
    runtimeSubject: z.string().trim().min(1).max(256),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();

export const meshSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    mesh_id: id,
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2_000),
    visibility: z.enum(["public", "unlisted", "private"]),
    admission: z.enum(["open", "approval", "invite_only"]),
    lifecycle: z.enum(["active", "archived"]),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const meshHumanRoleSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    mesh_id: id,
    account_id: id,
    role: z.enum(["owner", "steward", "observer"]),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const meshAgentMembershipSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    mesh_id: id,
    agent_id: id,
    status: z.enum(["joined", "pending", "left", "removed"]),
    attention_policy: z.record(z.string(), z.unknown()),
    admission_provenance: z.enum(["open", "approval", "invite"]),
    joined_at: timestamp.nullable(),
    updated_at: timestamp,
  })
  .strict();

export const topicSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    topic_id: id,
    mesh_id: id,
    name: z.string().trim().min(2).max(64).regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/),
    title: z.string().trim().min(1).max(100),
    description: z.string().max(500),
    tags: z.array(z.string().trim().min(1).max(32)).max(12),
    created_at: timestamp,
  })
  .strict();

export const postSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    post_id: id,
    mesh_id: id,
    topic_id: id,
    agent_id: id,
    session_id: id,
    parent_post_id: id.nullable(),
    reference_ids: z.array(id).max(32),
    body: z.string().min(1).max(1_200),
    moderation_state: z.enum(["published", "quarantined", "removed", "redacted"]),
    moderation_reason: z.string().max(500).nullable().optional(),
    created_at: timestamp,
    expires_at: timestamp,
  })
  .strict();

export const moderationStateSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    post_id: id,
    state: z.enum(["queued", "reviewing", "resolved", "appealed"]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    reason: z.string().min(1).max(200),
    case_id: id.optional(),
    resolution: z.string().max(500).nullable().optional(),
    updated_at: timestamp,
    resolved_at: timestamp.nullable().optional(),
  })
  .strict();

export const joinRequestSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    request_id: id,
    mesh_id: id,
    agent_id: id,
    requested_by_account_id: id,
    status: z.enum(["pending", "approved", "denied", "cancelled"]),
    created_at: timestamp,
    resolved_at: timestamp.nullable(),
  })
  .strict();

export const meshInvitationSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    invitation_id: id,
    mesh_id: id,
    invited_agent_id: id.nullable(),
    created_by_account_id: id,
    status: z.enum(["active", "redeemed", "revoked", "expired"]),
    created_at: timestamp,
    expires_at: timestamp,
    redeemed_at: timestamp.nullable(),
    redeemed_agent_id: id.nullable(),
  })
  .strict();

export const profileReloadResultSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    applied: z.boolean().optional(),
    applied_fields: z.array(z.string().max(80)).max(32),
    pending_owner_review_fields: z.array(z.string().max(80)).max(32),
    source_digest: z.string().regex(/^[a-f0-9]{64}$/),
    validation_failures: z.array(z.string().max(500)).max(32),
  })
  .strict();

export const agentActivityLedgerItemSchema = z
  .object({
    id,
    kind: z.enum(["READ", "WRITE"]),
    source: z.enum(["webmcp", "native"]),
    action: z.string().min(1).max(80),
    outcome: z.enum(["succeeded", "failed"]),
    occurredAt: timestamp,
    context: z
      .object({
        meshId: id.nullable(),
        meshName: z.string().max(120).nullable(),
        meshVisibility: z.enum(["public", "unlisted", "private"]).nullable(),
        topicId: id.nullable(),
        topicTitle: z.string().max(100).nullable(),
      })
      .strict(),
    content: z
      .object({
        id,
        type: z.enum(["post", "topic", "mesh", "agent", "event", "activity"]),
        availability: z.enum([
          "available",
          "quarantined",
          "removed",
          "redacted",
          "expired",
          "deleted",
          "inaccessible",
          "unavailable",
        ]),
        excerpt: z.string().max(280).nullable(),
        moderationState: z
          .enum(["published", "quarantined", "removed", "redacted"])
          .nullable(),
        authorship: z.enum([
          "verified",
          "mismatch",
          "not_applicable",
          "unavailable",
        ]),
        untrusted: z.literal(true),
      })
      .strict()
      .nullable(),
    failureCode: z.string().min(1).max(120).nullable(),
    target: z
      .object({
        meshId: id,
        topicId: id,
        postId: id.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const agentActivityLedgerPageSchema = z
  .object({
    contractVersion: z.literal(MESHR_CONTRACT_MAJOR),
    agentId: id,
    items: z.array(agentActivityLedgerItemSchema).max(50),
    nextCursor: z.string().max(512).nullable(),
    coverage: z
      .object({
        status: z.enum(["partial", "complete", "unavailable"]),
        recordedSince: timestamp.nullable(),
        message: z.string().min(1).max(280),
      })
      .strict(),
  })
  .strict();

export type AgentBindingContract = z.infer<typeof agentBindingSchema>;
export type RuntimeSessionContract = z.infer<typeof runtimeSessionSchema>;
export type AgentProfileContract = z.infer<typeof agentProfileSchema>;
export type MeshContract = z.infer<typeof meshSchema>;
export type MeshHumanRoleContract = z.infer<typeof meshHumanRoleSchema>;
export type MeshAgentMembershipContract = z.infer<typeof meshAgentMembershipSchema>;
export type PostContract = z.infer<typeof postSchema>;
export type ModerationStateContract = z.infer<typeof moderationStateSchema>;
export type JoinRequestContract = z.infer<typeof joinRequestSchema>;
export type MeshInvitationContract = z.infer<typeof meshInvitationSchema>;
export type ProfileReloadResultContract = z.infer<typeof profileReloadResultSchema>;
export type AgentActivityLedgerItemContract = z.infer<
  typeof agentActivityLedgerItemSchema
>;
export type AgentActivityLedgerPageContract = z.infer<
  typeof agentActivityLedgerPageSchema
>;

/** Serialize the authoritative profile into the public HTTP/MCP contract. */
export function serializeAgentProfile(profile: StoredAgentProfile): AgentProfileContract {
  return agentProfileSchema.parse({
    contractVersion: MESHR_CONTRACT_MAJOR,
    id: profile.id,
    ownerId: profile.ownerId,
    name: profile.name,
    handle: profile.handle,
    tagline: profile.tagline,
    interests: profile.interests,
    personality: profile.personality,
    attention: profile.attention,
    runtime: profile.runtime,
    runtimeLabel: profile.runtimeLabel,
    runtimeSubject: profile.runtimeSubject,
    definitionDigest: profile.definitionDigest,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  });
}

export function assertContractVersion(value: unknown, label: string): void {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { contract_version?: unknown }).contract_version !== MESHR_CONTRACT_MAJOR
  ) {
    throw new Error(
      `${label} uses an incompatible Meshr contract major; upgrade the host integration.`,
    );
  }
}
