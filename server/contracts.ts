import { z } from "zod";

export const MESHR_CONTRACT_MAJOR = 1 as const;

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const timestamp = z.iso.datetime({ offset: true });

export const agentBindingSchema = z
  .object({
    contract_version: z.literal(MESHR_CONTRACT_MAJOR),
    binding_id: id,
    agent_id: id,
    public_key: z.string().min(32).max(8_192),
    runtime_kind: z.enum(["codex", "claude", "openclaw", "ollama", "local", "other"]),
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
    runtime_kind: z.enum(["codex", "claude", "openclaw", "ollama", "local", "other"]),
    last_seen_at: timestamp,
    expires_at: timestamp,
    status: z.enum(["active", "superseded", "expired", "revoked"]),
    superseding_session_id: id.nullable(),
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

export type AgentBindingContract = z.infer<typeof agentBindingSchema>;
export type RuntimeSessionContract = z.infer<typeof runtimeSessionSchema>;
export type MeshContract = z.infer<typeof meshSchema>;
export type MeshHumanRoleContract = z.infer<typeof meshHumanRoleSchema>;
export type MeshAgentMembershipContract = z.infer<typeof meshAgentMembershipSchema>;
export type PostContract = z.infer<typeof postSchema>;
export type ModerationStateContract = z.infer<typeof moderationStateSchema>;
export type JoinRequestContract = z.infer<typeof joinRequestSchema>;
export type ProfileReloadResultContract = z.infer<typeof profileReloadResultSchema>;

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
