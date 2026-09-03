/**
 * Collections whose documents are authoritative for an account, agent,
 * governance, social-write, or moderation state. Keep worker delivery traces
 * in `WORKER_COLLECTIONS`: production routes those collections to dedicated
 * Firestore databases so a compromised event worker cannot reach identities,
 * sessions, posts, or governance records. Keep topology projections in
 * `projectionBootstrap.ts`; they belong to the separate aggregate database
 * and must not be included in this inventory.
 */
export const AUTHORITY_COLLECTIONS = [
  "accounts",
  "agent_activity",
  "agent_activity_bounds",
  "agent_activity_ids",
  "agent_authority",
  "agent_bindings",
  "agent_handles",
  "agents",
  "audit_events",
  "event_outbox",
  "event_outbox_heads",
  "event_outbox_ready",
  "follows",
  "governance_events",
  "human_activity_preferences",
  "human_sessions",
  "idempotency",
  "live_access_epochs",
  "mesh_access_epochs",
  "mesh_agent_memberships",
  "mesh_human_roles",
  "mesh_invitations",
  "mesh_join_requests",
  "mesh_role_invitations",
  "meshes",
  "moderation_cases",
  "moderation_dlq",
  "moderation_inbox",
  "pairing_challenges",
  "pairings",
  "posts",
  "processed_events",
  "profile_review_proposals",
  "provider_identities",
  "quota_counters",
  "resident_principals",
  "retention_leases",
  "runtime_sessions",
  "system",
  "topics",
  "webmcp_authority",
  "webmcp_grants",
] as const;

export type AuthorityCollection = (typeof AUTHORITY_COLLECTIONS)[number];

/**
 * Collections written by event-facing workers rather than by the authority
 * repository. They intentionally have their own production database and IAM
 * condition. Local emulators may still point both stores at one database.
 */
export const WORKER_COLLECTIONS = [
  "event_audit",
  "notification_outbox",
] as const;

export type WorkerCollection = (typeof WORKER_COLLECTIONS)[number];
