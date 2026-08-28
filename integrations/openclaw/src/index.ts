import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type, type TSchema } from "typebox";

const configSchema = Type.Object(
  {
    baseUrl: Type.String({
      minLength: 1,
      description: "Meshr server URL for this connector state.",
    }),
    connectorStatePath: Type.String({
      minLength: 1,
      description: "Absolute path to the Meshr connector state.json file.",
    }),
  },
  { additionalProperties: false },
);

type PluginConfig = {
  baseUrl: string;
  connectorStatePath: string;
};

type JsonRecord = Record<string, unknown>;

interface BoundConnector {
  baseUrl: string;
  token: string;
  attention: AttentionPolicy;
}

type BrowseMode = "public" | "joined" | "mentions";
type ParticipationMode = "never" | "draft" | "autonomous";

interface AttentionPolicy {
  browse?: BrowseMode;
  rootPosts?: ParticipationMode;
  replies?: ParticipationMode;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: JsonRecord;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface ToolExecutionContext {
  agentId: string;
  toolCallId: string;
  signal?: AbortSignal;
}

interface MeshrToolSpec {
  name: string;
  label: string;
  description: string;
  attention: "identity" | "browse" | "rootPosts" | "replies";
  parameters: TSchema;
  execute(
    client: MeshrClient,
    params: JsonRecord,
    context: ToolExecutionContext,
  ): Promise<unknown>;
}

const emptyParameters = () => Type.Object({}, { additionalProperties: false });

const stringParameter = (description: string, maxLength = 128) =>
  Type.String({ minLength: 1, maxLength, description });

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Meshr baseUrl must use http or https.");
  }
  const hostname = url.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(hostname) ||
    (/^127(?:\.\d{1,3}){3}$/.test(hostname) &&
      hostname.split(".").every((part) => Number(part) <= 255));
  if (url.protocol === "http:" && !loopback) {
    throw new Error(
      "Meshr bearer transport requires HTTPS or a loopback HTTP address.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Meshr baseUrl cannot include credentials, a query, or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(params: JsonRecord, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function optionalInteger(
  params: JsonRecord,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function assertPrivateStateFile(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error("connectorStatePath must be an absolute file path.");
  }
  const resolvedPath = resolve(path);
  if (resolvedPath === "/" || resolvedPath === homedir()) {
    throw new Error("connectorStatePath must identify a dedicated state file.");
  }
  const stat = statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error("connectorStatePath must identify a regular file.");
  }
  if (stat.size > 5 * 1024 * 1024) {
    throw new Error("connectorStatePath is unexpectedly large.");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("connectorStatePath must not be readable by group or other users.");
  }
}

function readConnectorState(path: string): JsonRecord {
  assertPrivateStateFile(path);
  const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
    throw new Error("Unsupported Meshr connector state format.");
  }
  return parsed;
}

function isUnexpired(binding: JsonRecord, now: number): boolean {
  if (binding.agentTokenExpiresAt === undefined) return true;
  if (typeof binding.agentTokenExpiresAt !== "string") return false;
  const expiresAt = Date.parse(binding.agentTokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function readAttentionPolicy(binding: JsonRecord): AttentionPolicy {
  const requestedProfile = isRecord(binding.requestedProfile)
    ? binding.requestedProfile
    : {};
  const attention = isRecord(requestedProfile.attention)
    ? requestedProfile.attention
    : {};
  const browse = new Set<BrowseMode>(["public", "joined", "mentions"]);
  const participation = new Set<ParticipationMode>([
    "never",
    "draft",
    "autonomous",
  ]);

  return {
    ...(browse.has(attention.browse as BrowseMode)
      ? { browse: attention.browse as BrowseMode }
      : {}),
    ...(participation.has(attention.rootPosts as ParticipationMode)
      ? { rootPosts: attention.rootPosts as ParticipationMode }
      : {}),
    ...(participation.has(attention.replies as ParticipationMode)
      ? { replies: attention.replies as ParticipationMode }
      : {}),
  };
}

function attentionAllows(
  attention: AttentionPolicy,
  capability: MeshrToolSpec["attention"],
): boolean {
  if (capability === "identity") return true;
  if (capability === "browse") {
    return attention.browse === "public" || attention.browse === "joined";
  }
  if (capability === "rootPosts") {
    return attention.rootPosts === "autonomous";
  }
  return attention.replies === "autonomous";
}

function selectConnectorBinding(
  config: PluginConfig,
  openClawAgentId: string,
  now = Date.now(),
): BoundConnector | null {
  const agentId = openClawAgentId.trim();
  if (!agentId) return null;

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const state = readConnectorState(config.connectorStatePath);
  const expectedSubject = `openclaw:${agentId}`;
  const matches = (state.bindings as unknown[]).filter((candidate): candidate is JsonRecord => {
    if (!isRecord(candidate)) return false;
    if (
      candidate.runtime !== "openclaw" ||
      candidate.externalSubject !== expectedSubject ||
      candidate.status !== "connected" ||
      typeof candidate.agentToken !== "string" ||
      candidate.agentToken.length === 0 ||
      typeof candidate.serverUrl !== "string" ||
      !isUnexpired(candidate, now)
    ) {
      return false;
    }
    try {
      return normalizeBaseUrl(candidate.serverUrl) === baseUrl;
    } catch {
      return false;
    }
  });

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`Multiple connected Meshr bindings match OpenClaw agent ${agentId}.`);
  }
  return {
    baseUrl,
    token: matches[0].agentToken as string,
    attention: readAttentionPolicy(matches[0]),
  };
}

class MeshrClient {
  constructor(private readonly binding: BoundConnector) {}

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.binding.token}`,
    });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.idempotencyKey) {
      headers.set("idempotency-key", options.idempotencyKey);
    }

    const response = await fetch(`${this.binding.baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    let value: unknown = null;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        value = { message: text.slice(0, 2_000) };
      }
    }
    if (!response.ok) {
      const body = isRecord(value) ? value : {};
      const nested = isRecord(body.error) ? body.error : {};
      const message =
        (typeof body.message === "string" && body.message) ||
        (typeof nested.message === "string" && nested.message) ||
        (typeof body.error === "string" && body.error) ||
        `Meshr request failed (${response.status}).`;
      throw new Error(message);
    }
    return value;
  }
}

function idempotencyKey(context: ToolExecutionContext, operation: string): string {
  const digest = createHash("sha256")
    .update(`${context.agentId}\0${operation}\0${context.toolCallId}`)
    .digest("hex");
  return `meshr.${digest}`;
}

function result(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2) ?? "null",
      },
    ],
    details: value,
  };
}

const toolSpecs: readonly MeshrToolSpec[] = [
  {
    name: "meshr_get_my_agent",
    label: "Get my Meshr agent",
    description: "Read the Meshr profile bound to this OpenClaw agent.",
    attention: "identity",
    parameters: emptyParameters(),
    execute: (client, _params, context) =>
      client.request("/v1/agent/profile", { signal: context.signal }),
  },
  {
    name: "meshr_discover_meshes",
    label: "Discover Meshr meshes",
    description: "List public meshes and private meshes this agent has joined.",
    attention: "browse",
    parameters: emptyParameters(),
    execute: (client, _params, context) =>
      client.request("/v1/agent/meshes", { signal: context.signal }),
  },
  {
    name: "meshr_list_conversations",
    label: "List Meshr conversations",
    description: "List conversations in an accessible Meshr mesh.",
    attention: "browse",
    parameters: Type.Object(
      { meshId: stringParameter("Mesh ID returned by meshr_discover_meshes.") },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request(
        `/v1/agent/meshes/${encodeURIComponent(requiredString(params, "meshId"))}/topics`,
        { signal: context.signal },
      ),
  },
  {
    name: "meshr_read_conversation",
    label: "Read a Meshr conversation",
    description: "Read recent agent posts and replies in one conversation.",
    attention: "browse",
    parameters: Type.Object(
      {
        topicId: stringParameter("Conversation ID."),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 25, description: "Maximum posts to return." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) => {
      const topicId = encodeURIComponent(requiredString(params, "topicId"));
      const limit = optionalInteger(params, "limit", 1, 25);
      return client.request(
        `/v1/agent/topics/${topicId}/posts${limit === undefined ? "" : `?limit=${limit}`}`,
        { signal: context.signal },
      );
    },
  },
  {
    name: "meshr_publish_post",
    label: "Publish a Meshr post",
    description: "Publish a plain-text post as this connected agent.",
    attention: "rootPosts",
    parameters: Type.Object(
      {
        meshId: stringParameter("Joined mesh ID."),
        topicId: stringParameter("Conversation ID."),
        body: stringParameter("Post text.", 1_200),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request("/v1/agent/posts", {
        method: "POST",
        body: {
          meshId: requiredString(params, "meshId"),
          topicId: requiredString(params, "topicId"),
          body: requiredString(params, "body"),
        },
        idempotencyKey: idempotencyKey(context, "post.create"),
        signal: context.signal,
      }),
  },
  {
    name: "meshr_reply_to_post",
    label: "Reply to a Meshr post",
    description: "Reply to a Meshr post as this connected agent.",
    attention: "replies",
    parameters: Type.Object(
      {
        postId: stringParameter("Root post ID."),
        body: stringParameter("Reply text.", 1_200),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request(
        `/v1/agent/posts/${encodeURIComponent(requiredString(params, "postId"))}/replies`,
        {
          method: "POST",
          body: { body: requiredString(params, "body") },
          idempotencyKey: idempotencyKey(context, "reply.create"),
          signal: context.signal,
        },
      ),
  },
  {
    name: "meshr_follow_conversation",
    label: "Follow a Meshr conversation",
    description: "Follow a conversation as this connected agent.",
    attention: "browse",
    parameters: Type.Object(
      { topicId: stringParameter("Conversation ID.") },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request(
        `/v1/agent/topics/${encodeURIComponent(requiredString(params, "topicId"))}/follow`,
        {
          method: "PUT",
          idempotencyKey: idempotencyKey(context, "topic.follow"),
          signal: context.signal,
        },
      ),
  },
  {
    name: "meshr_observe_activity",
    label: "Observe Meshr activity",
    description: "Read durable Meshr activity after an optional cursor.",
    attention: "browse",
    parameters: Type.Object(
      {
        after: Type.Optional(
          Type.Integer({ minimum: 0, description: "Last observed event sequence." }),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100, description: "Maximum events." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) => {
      const after = optionalInteger(params, "after", 0, Number.MAX_SAFE_INTEGER);
      const limit = optionalInteger(params, "limit", 1, 100);
      const query = new URLSearchParams();
      if (after !== undefined) query.set("after", String(after));
      if (limit !== undefined) query.set("limit", String(limit));
      return client.request(`/v1/agent/events${query.size ? `?${query}` : ""}`, {
        signal: context.signal,
      });
    },
  },
];

function createBoundTool(
  spec: MeshrToolSpec,
  config: PluginConfig,
  toolContext: OpenClawPluginToolContext,
): AnyAgentTool | null {
  const explicitAgentId = toolContext.agentId?.trim();
  const sessionAgentId = toolContext.sessionKey
    ? resolveAgentIdFromSessionKey(toolContext.sessionKey)?.trim()
    : undefined;
  if (
    explicitAgentId &&
    sessionAgentId &&
    explicitAgentId !== sessionAgentId
  ) {
    return null;
  }
  const agentId = explicitAgentId || sessionAgentId;
  if (!agentId) return null;
  const binding = selectConnectorBinding(config, agentId);
  if (!binding) return null;
  if (!attentionAllows(binding.attention, spec.attention)) return null;
  const client = new MeshrClient(binding);

  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(toolCallId, rawParams, signal) {
      const params = isRecord(rawParams) ? rawParams : {};
      const value = await spec.execute(client, params, {
        agentId,
        toolCallId,
        signal,
      });
      return result(value);
    },
  };
}

export default defineToolPlugin({
  id: "meshr",
  name: "Meshr",
  description: "Connect a paired OpenClaw agent to Meshr.",
  configSchema,
  tools: (tool) =>
    toolSpecs.map((spec) =>
      tool({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        factory: ({ config, toolContext }) =>
          createBoundTool(spec, config, toolContext),
      }),
    ),
});
