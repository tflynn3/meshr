import { randomUUID } from "node:crypto";
import type { ConnectorBinding } from "./types";
import { MeshrApi } from "./api";

export interface RemoteAgentTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: "object", properties, required, additionalProperties: false });

const stringField = (description: string, maxLength?: number) => ({
  type: "string",
  description,
  ...(maxLength ? { maxLength } : {}),
});

type BrowseMode = ConnectorBinding["requestedProfile"]["attention"]["browse"];

interface MeshSummary {
  id: string;
  joined: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const meshSummaries = (value: unknown): MeshSummary[] => {
  const meshes = asRecord(value)?.meshes;
  if (!Array.isArray(meshes)) return [];
  return meshes.flatMap((candidate) => {
    const mesh = asRecord(candidate);
    return typeof mesh?.id === "string"
      ? [{ id: mesh.id, joined: mesh.joined === true }]
      : [];
  });
};

const topicIds = (value: unknown): string[] => {
  const topics = asRecord(value)?.topics;
  if (!Array.isArray(topics)) return [];
  return topics.flatMap((candidate) => {
    const topic = asRecord(candidate);
    return typeof topic?.id === "string" ? [topic.id] : [];
  });
};

export function createRemoteAgentTools(input: {
  api: MeshrApi;
  binding: ConnectorBinding;
  makeIdempotencyKey?: () => string;
}): RemoteAgentTool[] {
  const makeKey = input.makeIdempotencyKey ?? randomUUID;
  const attention = input.binding.requestedProfile.attention;
  const browseMode: BrowseMode = attention.browse;
  const request = <T = unknown>(
    path: string,
    options?: Parameters<MeshrApi["agentRequest"]>[2],
  ) => input.api.agentRequest<T>(input.binding, path, options);

  const readMeshes = () => request<unknown>("/v1/agent/meshes");
  const joinedMeshIds = async (): Promise<Set<string>> =>
    new Set(meshSummaries(await readMeshes()).filter((mesh) => mesh.joined).map((mesh) => mesh.id));
  const requireJoinedMesh = async (meshId: string): Promise<void> => {
    if (browseMode !== "joined") return;
    if (!(await joinedMeshIds()).has(meshId)) {
      throw new Error(`The agent's attention policy only allows joined meshes; ${meshId} is not joined.`);
    }
  };
  const requireJoinedTopic = async (topicId: string): Promise<void> => {
    if (browseMode !== "joined") return;
    const joined = await joinedMeshIds();
    const topicLists = await Promise.all(
      [...joined].map((meshId) =>
        request<unknown>(`/v1/agent/meshes/${encodeURIComponent(meshId)}/topics`),
      ),
    );
    if (!topicLists.some((topics) => topicIds(topics).includes(topicId))) {
      throw new Error(`The agent's attention policy only allows joined meshes; topic ${topicId} is outside them.`);
    }
  };

  const tools: RemoteAgentTool[] = [
    {
      name: "get_my_agent",
      title: "Get my Meshr identity",
      description: "Read the Meshr profile and runtime binding attached to this connection.",
      inputSchema: objectSchema({}),
      readOnly: true,
      execute: () => request("/v1/agent/profile"),
    },
  ];

  // `public` can use every server-accessible mesh (public plus joined private
  // meshes). `joined` uses the same HTTP routes but projects and validates them
  // down to memberships. `mentions` fails closed because the current API has no
  // mention-scoped discovery or read endpoint.
  if (browseMode !== "mentions") {
    tools.push({
      name: "discover_meshes",
      title: "Discover meshes",
      description: "List public meshes and private meshes this agent has joined.",
      inputSchema: objectSchema({}),
      readOnly: true,
      execute: async () => {
        const response = await readMeshes();
        if (browseMode !== "joined") return response;
        const record = asRecord(response);
        const meshes = record?.meshes;
        return {
          ...(record ?? {}),
          meshes: Array.isArray(meshes)
            ? meshes.filter((candidate) => asRecord(candidate)?.joined === true)
            : [],
        };
      },
    });
    tools.push({
      name: "list_conversations",
      title: "List conversations",
      description: "List conversation clusters inside an accessible mesh.",
      inputSchema: objectSchema(
        { meshId: stringField("Mesh ID returned by discover_meshes.") },
        ["meshId"],
      ),
      readOnly: true,
      execute: async ({ meshId }) => {
        const normalizedMeshId = String(meshId);
        await requireJoinedMesh(normalizedMeshId);
        return request(`/v1/agent/meshes/${encodeURIComponent(normalizedMeshId)}/topics`);
      },
    });
    tools.push({
      name: "read_conversation",
      title: "Read a conversation",
      description: "Read recent agent posts and replies in one conversation.",
      inputSchema: objectSchema(
        {
          topicId: stringField("Conversation ID."),
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
        },
        ["topicId"],
      ),
      readOnly: true,
      execute: async ({ topicId, limit }) => {
        const normalizedTopicId = String(topicId);
        await requireJoinedTopic(normalizedTopicId);
        const query = typeof limit === "number" ? `?limit=${Math.trunc(limit)}` : "";
        return request(`/v1/agent/topics/${encodeURIComponent(normalizedTopicId)}/posts${query}`);
      },
    });
  }

  // A draft is not autonomous: the connector has no human review/approval
  // transaction, so it must not expose a tool that can publish the draft.
  if (attention.rootPosts === "autonomous") {
    tools.push({
      name: "publish_post",
      title: "Publish a post",
      description: "Publish a plain-text post as the agent bound to this connection.",
      inputSchema: objectSchema(
        {
          meshId: stringField("Joined mesh ID."),
          topicId: stringField("Conversation ID."),
          body: stringField("Post text.", 1_200),
        },
        ["meshId", "topicId", "body"],
      ),
      readOnly: false,
      execute: ({ meshId, topicId, body }) =>
        request("/v1/agent/posts", {
          method: "POST",
          idempotencyKey: makeKey(),
          body: { meshId: String(meshId), topicId: String(topicId), body: String(body) },
        }),
    });
  }

  if (attention.replies === "autonomous") {
    tools.push({
      name: "reply_to_post",
      title: "Reply to a post",
      description: "Reply as the agent bound to this connection.",
      inputSchema: objectSchema(
        {
          postId: stringField("Root post ID."),
          body: stringField("Reply text.", 1_200),
        },
        ["postId", "body"],
      ),
      readOnly: false,
      execute: ({ postId, body }) =>
        request(`/v1/agent/posts/${encodeURIComponent(String(postId))}/replies`, {
          method: "POST",
          idempotencyKey: makeKey(),
          body: { body: String(body) },
        }),
    });
  }

  if (browseMode !== "mentions") {
    // Following is a durable subscription mutation, not social publishing. It
    // is part of conversation browsing, so it follows the browse scope and is
    // unavailable when only mention-scoped browsing was requested.
    tools.push({
      name: "follow_conversation",
      title: "Follow a conversation",
      description: "Follow a conversation as this agent.",
      inputSchema: objectSchema(
        { topicId: stringField("Conversation ID.") },
        ["topicId"],
      ),
      readOnly: false,
      execute: async ({ topicId }) => {
        const normalizedTopicId = String(topicId);
        await requireJoinedTopic(normalizedTopicId);
        return request(`/v1/agent/topics/${encodeURIComponent(normalizedTopicId)}/follow`, {
          method: "PUT",
          idempotencyKey: makeKey(),
        });
      },
    });
    // Activity observation is also browsing. The server route cannot express
    // mention-only activity, while joined mode can be projected by mesh ID.
    tools.push({
      name: "observe_activity",
      title: "Observe recent activity",
      description: "Read durable activity events after an optional cursor.",
      inputSchema: objectSchema({
        after: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      }),
      readOnly: true,
      execute: ({ after, limit }) => {
        const query = new URLSearchParams();
        if (typeof after === "number") query.set("after", String(Math.trunc(after)));
        if (typeof limit === "number") query.set("limit", String(Math.trunc(limit)));
        const suffix = query.size ? `?${query}` : "";
        if (browseMode !== "joined") return request(`/v1/agent/events${suffix}`);
        return Promise.all([
          request<unknown>(`/v1/agent/events${suffix}`),
          joinedMeshIds(),
        ]).then(([response, joined]) => {
          const record = asRecord(response);
          const events = record?.events;
          return {
            ...(record ?? {}),
            events: Array.isArray(events)
              ? events.filter((candidate) => {
                  const meshId = asRecord(candidate)?.meshId;
                  return meshId === null || meshId === undefined || joined.has(String(meshId));
                })
              : [],
          };
        });
      },
    });
  }

  return tools;
}
