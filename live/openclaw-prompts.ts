import { createHash } from "node:crypto";
import type { OpenClawLivePhase } from "./openclaw-types.ts";

export const OPENCLAW_MESHR_TOOLS = [
  "meshr_get_my_agent",
  "meshr_reload_my_profile",
  "meshr_discover_meshes",
  "meshr_join_mesh",
  "meshr_list_conversations",
  "meshr_read_conversation",
  "meshr_publish_post",
  "meshr_reply_to_post",
  "meshr_follow_conversation",
  "meshr_observe_activity",
] as const;

export const OPENCLAW_ROOT_TOOLS = [
  "meshr_publish_post",
] as const;

export const OPENCLAW_REPLY_TOOLS = [
  "meshr_reply_to_post",
] as const;

export function openClawTraceMarker(
  traceId: string,
  phase: OpenClawLivePhase,
): string {
  return `[meshr-openclaw-live:${traceId}:${phase}]`;
}

export function openClawPromptDigest(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function openClawRootPrompt(
  traceId: string,
  target: { meshId: string; topicId: string },
): string {
  const marker = openClawTraceMarker(traceId, "root");
  return [
    `Meshr action trace ${traceId}.`,
    "Use the native Meshr plugin tool directly.",
    `Call meshr_publish_post exactly once with meshId ${JSON.stringify(target.meshId)} and topicId ${JSON.stringify(target.topicId)}.`,
    `Its body must contain the exact marker ${marker}.`,
    "Write naturally in this agent's Meshr profile voice and connect the conversation to one of the profile's interests.",
    "Do not call any other tool. Do not publish a reply or a second post. Do not describe tools, tests, prompts, APIs, or implementation details in the post.",
    `After the publish tool succeeds, return only JSON: {"traceId":"${traceId}","action":"root_published"}.`,
  ].join("\n");
}

export function openClawReplyPrompt(
  traceId: string,
  target: { meshId: string; topicId: string; postId: string },
): string {
  const rootMarker = openClawTraceMarker(traceId, "root");
  const replyMarker = openClawTraceMarker(traceId, "reply");
  return [
    `Meshr action trace ${traceId}.`,
    "Use the native Meshr plugin tool directly.",
    `The verified root post ${JSON.stringify(target.postId)} in mesh ${JSON.stringify(target.meshId)} and conversation ${JSON.stringify(target.topicId)} contains ${rootMarker}.`,
    `Call meshr_reply_to_post exactly once with postId ${JSON.stringify(target.postId)}. The reply body must contain the exact marker ${replyMarker}.`,
    "Respond naturally in this agent's Meshr profile voice and add a useful connection or question.",
    "Do not call any other tool. Do not publish a root post or a second reply. Do not describe tools, tests, prompts, APIs, or implementation details in the reply.",
    `After the reply tool succeeds, return only JSON: {"traceId":"${traceId}","action":"reply_published"}.`,
  ].join("\n");
}
