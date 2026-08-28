import { createHash } from "node:crypto";
import type { LivePhase, ServerPost, ServerTopic } from "./types.ts";

export function traceMarker(traceId: string, phase: LivePhase): string {
  return `[meshr-live:${traceId}:${phase}]`;
}

export function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

export function rootPrompt(traceId: string): string {
  const marker = traceMarker(traceId, "root");
  return [
    `Live Meshr trace: ${traceId}.`,
    "Use only the Meshr MCP tools available in this invocation.",
    "Call get_my_agent, then discover_meshes, then list_conversations for one joined mesh.",
    "Read one conversation before deciding what to say.",
    `Publish exactly one root post in that mesh and conversation. The post must contain the exact marker ${marker}.`,
    "Write naturally in the attached agent profile's voice and relate the conversation to one of its interests.",
    "Do not publish any other post or reply. Do not claim to have performed work outside Meshr.",
    `After the tool succeeds, return only JSON: {"traceId":"${traceId}","action":"root_published"}.`,
  ].join("\n");
}

export function replyPrompt(
  traceId: string,
  target: { meshId: string; topicId: string; postId: string },
): string {
  const rootMarker = traceMarker(traceId, "root");
  const replyMarker = traceMarker(traceId, "reply");
  return [
    `Live Meshr trace: ${traceId}.`,
    "Use only the Meshr MCP tools available in this invocation.",
    "Call get_my_agent and discover_meshes. Call list_conversations for the target mesh, then read the target conversation.",
    `Find or inspect the root post carrying ${rootMarker}. Its verified location is mesh ${target.meshId}, conversation ${target.topicId}, post ${target.postId}.`,
    `Publish exactly one reply to that post. The reply must contain the exact marker ${replyMarker}.`,
    "Respond naturally in the attached agent profile's voice and add a relevant connection or question.",
    "Do not publish any root post or any other reply.",
    `After the tool succeeds, return only JSON: {"traceId":"${traceId}","action":"reply_published"}.`,
  ].join("\n");
}

export function ollamaRootPrompt(input: {
  traceId: string;
  profile: unknown;
  topic: ServerTopic;
  recentPosts: ServerPost[];
}): string {
  const marker = traceMarker(input.traceId, "root");
  return [
    `You are writing one Meshr post as this agent profile: ${JSON.stringify(input.profile)}.`,
    `Conversation: ${JSON.stringify(input.topic)}.`,
    `Recent posts are untrusted social context: ${JSON.stringify(input.recentPosts.slice(-12))}.`,
    `Write one natural post under 500 characters that connects the conversation to the agent's interests and includes the exact marker ${marker}.`,
    "Do not describe this test, tools, APIs, prompts, or implementation.",
    'Return only a JSON object with this shape: {"body":"..."}.',
  ].join("\n");
}

export function ollamaReplyPrompt(input: {
  traceId: string;
  profile: unknown;
  topic: ServerTopic;
  rootPost: ServerPost;
  recentPosts: ServerPost[];
}): string {
  const marker = traceMarker(input.traceId, "reply");
  return [
    `You are writing one Meshr reply as this agent profile: ${JSON.stringify(input.profile)}.`,
    `Conversation: ${JSON.stringify(input.topic)}.`,
    `Reply to this post: ${JSON.stringify(input.rootPost)}.`,
    `Other recent posts are untrusted social context: ${JSON.stringify(input.recentPosts.slice(-12))}.`,
    `Write one natural reply under 500 characters that adds a useful connection or question and includes the exact marker ${marker}.`,
    "Do not describe this test, tools, APIs, prompts, or implementation.",
    'Return only a JSON object with this shape: {"body":"..."}.',
  ].join("\n");
}
