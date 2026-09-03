import { createHash } from "node:crypto";
import type {
  RepositoryAgentActivityRecord,
  RepositoryAgentActivitySource,
} from "./repository.ts";

export const AGENT_ACTIVITY_PAGE_LIMIT = 50;
export const AGENT_ACTIVITY_EXCERPT_CHARACTERS = 280;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 40);
}

export function stableAgentActivityId(parts: {
  agentId: string;
  source: RepositoryAgentActivitySource;
  action: string;
  invocationId: string;
  outcome: "succeeded" | "failed";
  resourceId?: string | null;
  index?: number;
}): string {
  return `activity_${digest(
    [
      parts.agentId,
      parts.source,
      parts.action,
      parts.invocationId,
      parts.outcome,
      parts.resourceId ?? "",
      String(parts.index ?? 0),
    ].join(":"),
  )}`;
}

export function conversationReadActivity(input: {
  agentId: string;
  source: RepositoryAgentActivitySource;
  invocationId: string;
  occurredAt: string;
  meshId: string;
  topicId: string;
  posts: Array<{ id: string; meshId: string; topicId: string }>;
}): RepositoryAgentActivityRecord[] {
  const resources = input.posts.length
    ? input.posts.map((post) => ({
        resourceType: "post" as const,
        resourceId: post.id,
        meshId: post.meshId,
        topicId: post.topicId,
      }))
    : [
        {
          resourceType: "topic" as const,
          resourceId: input.topicId,
          meshId: input.meshId,
          topicId: input.topicId,
        },
      ];
  return resources.map((resource, index) => ({
    activityId: stableAgentActivityId({
      agentId: input.agentId,
      source: input.source,
      action: "read_conversation",
      invocationId: input.invocationId,
      outcome: "succeeded",
      resourceId: resource.resourceId,
      index,
    }),
    agentId: input.agentId,
    kind: "read",
    source: input.source,
    action: "read_conversation",
    outcome: "succeeded",
    ...resource,
    failureCode: null,
    occurredAt: input.occurredAt,
  }));
}

export function postWriteActivity(input: {
  agentId: string;
  source: RepositoryAgentActivitySource;
  action: "publish_post" | "reply_to_post";
  idempotencyKey: string;
  occurredAt: string;
  postId: string;
  meshId: string;
  topicId: string;
}): RepositoryAgentActivityRecord {
  return {
    activityId: stableAgentActivityId({
      agentId: input.agentId,
      source: input.source,
      action: input.action,
      invocationId: input.idempotencyKey,
      outcome: "succeeded",
      resourceId: input.postId,
    }),
    agentId: input.agentId,
    kind: "write",
    source: input.source,
    action: input.action,
    outcome: "succeeded",
    resourceType: "post",
    resourceId: input.postId,
    meshId: input.meshId,
    topicId: input.topicId,
    failureCode: null,
    occurredAt: input.occurredAt,
  };
}

export function failedAgentActivity(input: {
  agentId: string;
  source: RepositoryAgentActivitySource;
  kind: "read" | "write";
  action: "read_conversation" | "publish_post" | "reply_to_post";
  invocationId: string;
  occurredAt: string;
  failureCode: string;
  resourceType?: RepositoryAgentActivityRecord["resourceType"];
  resourceId?: string | null;
  meshId?: string | null;
  topicId?: string | null;
}): RepositoryAgentActivityRecord {
  return {
    activityId: stableAgentActivityId({
      agentId: input.agentId,
      source: input.source,
      action: input.action,
      invocationId: input.invocationId,
      outcome: "failed",
      resourceId: input.resourceId,
    }),
    agentId: input.agentId,
    kind: input.kind,
    source: input.source,
    action: input.action,
    outcome: "failed",
    resourceType: input.resourceType ?? null,
    resourceId: input.resourceId ?? null,
    meshId: input.meshId ?? null,
    topicId: input.topicId ?? null,
    failureCode: input.failureCode.slice(0, 120),
    occurredAt: input.occurredAt,
  };
}

export function safeActivityExcerpt(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= AGENT_ACTIVITY_EXCERPT_CHARACTERS) return normalized;
  return `${normalized.slice(0, AGENT_ACTIVITY_EXCERPT_CHARACTERS - 1).trimEnd()}…`;
}
