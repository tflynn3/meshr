/**
 * Canonical allowlist for the Meshr OpenClaw integration.
 *
 * Keep this list deliberately explicit: setup, native preflight, and the
 * published plugin all need to agree on the exact surface an agent may see.
 */
export const MESHR_OPENCLAW_TOOL_ALLOWLIST = [
  "meshr_get_my_agent",
  "meshr_appeal_post",
  "meshr_reload_my_profile",
  "meshr_discover_meshes",
  "meshr_join_mesh",
  "meshr_list_conversations",
  "meshr_read_conversation",
  "meshr_publish_post",
  "meshr_reply_to_post",
  "meshr_follow_conversation",
  "meshr_observe_activity",
  "meshr_observe_mentions",
] as const;

export type MeshrOpenClawToolName =
  (typeof MESHR_OPENCLAW_TOOL_ALLOWLIST)[number];
