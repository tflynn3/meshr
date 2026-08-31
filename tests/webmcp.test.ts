import assert from "node:assert/strict";
import test from "node:test";
import type { PageWebMcpClient } from "../src/domain/agentTools.ts";
import type { PageAgentAttention } from "../src/domain/agentTools.ts";
import {
  createPageWebMcpClient,
  registerMeshrTools,
} from "../src/webmcp/registerMeshrTools.ts";

function mockClient(calls: Array<{ method: string; input?: unknown }>): PageWebMcpClient {
  return {
    getMyAgent: async () => {
      calls.push({ method: "getMyAgent" });
      return { agent: { id: "agt_selected", handle: "selected" } };
    },
    discoverMeshes: async () => {
      calls.push({ method: "discoverMeshes" });
      return { meshes: [] };
    },
    observeMeshActivity: async (input) => {
      calls.push({ method: "observeMeshActivity", input });
      return { meshes: [] };
    },
    readConversation: async (input) => {
      calls.push({ method: "readConversation", input });
      return { posts: [] };
    },
    publishPost: async (input) => {
      calls.push({ method: "publishPost", input });
      return { post: { id: "post_1", ...input, agentId: "agt_selected" } };
    },
    replyToPost: async (input) => {
      calls.push({ method: "replyToPost", input });
      return { post: { id: "post_2", parentPostId: input.postId } };
    },
    followConversation: async (input) => {
      calls.push({ method: "followConversation", input });
      return { ...input, following: true };
    },
    inspectTrafficLink: async (input) => {
      calls.push({ method: "inspectTrafficLink", input });
      return { ...input, contract: { carriesAuthority: false } };
    },
  };
}

const autonomous: PageAgentAttention = {
  browse: "public",
  rootPosts: "autonomous",
  replies: "autonomous",
};

async function registerTools(attention: PageAgentAttention = autonomous) {
  const calls: Array<{ method: string; input?: unknown }> = [];
  const tools = new Map<string, WebMcpTool>();
  const modelContext: ModelContext = {
    async registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
  const status = await registerMeshrTools({
    modelContext,
    csrfToken: "csrf-test",
    expectedAgentId: "agt_selected",
    attention,
    client: mockClient(calls),
    signal: new AbortController().signal,
  });
  return { calls, status, tools };
}

async function executeJson(tool: WebMcpTool | undefined, input: Record<string, unknown> = {}) {
  assert.ok(tool);
  const response = await tool.execute(input);
  return JSON.parse(response.content[0]?.text ?? "null") as unknown;
}

test("registers eight typed tools without caller-controlled identity fields", async () => {
  const { status, tools } = await registerTools();
  assert.equal(status, "ready");
  assert.deepEqual([...tools.keys()].sort(), [
    "discover_meshes",
    "follow_conversation",
    "get_my_agent",
    "inspect_traffic_link",
    "observe_mesh_activity",
    "publish_post",
    "read_conversation",
    "reply_to_post",
  ]);
  for (const tool of tools.values()) {
    const schema = tool.inputSchema as {
      additionalProperties: boolean;
      properties: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.equal("agentId" in schema.properties, false);
    assert.equal("ownerId" in schema.properties, false);
  }
  assert.equal(tools.has("create_mesh"), false);
  assert.equal(tools.has("update_mesh_governance"), false);
});

test("tool execution dispatches to the server-backed page client", async () => {
  const { calls, tools } = await registerTools();
  const identity = (await executeJson(tools.get("get_my_agent"))) as {
    agent: { id: string };
  };
  assert.equal(identity.agent.id, "agt_selected");
  await executeJson(tools.get("observe_mesh_activity"), { meshId: "mesh-public" });
  await executeJson(tools.get("publish_post"), {
    meshId: "mesh-public",
    topicId: "topic-small-discoveries",
    body: "A durable observation.",
  });
  await executeJson(tools.get("reply_to_post"), {
    postId: "post_1",
    body: "A durable reply.",
  });
  assert.deepEqual(calls, [
    { method: "getMyAgent" },
    { method: "observeMeshActivity", input: { meshId: "mesh-public" } },
    {
      method: "publishPost",
      input: {
        meshId: "mesh-public",
        topicId: "topic-small-discoveries",
        body: "A durable observation.",
      },
    },
    { method: "replyToPost", input: { postId: "post_1", body: "A durable reply." } },
  ]);
});

test("page tool discovery follows the selected agent attention policy", async () => {
  const draft = await registerTools({
    browse: "public",
    rootPosts: "draft",
    replies: "never",
  });
  assert.equal(draft.tools.has("publish_post"), false);
  assert.equal(draft.tools.has("reply_to_post"), false);
  assert.equal(draft.tools.has("discover_meshes"), true);

  const split = await registerTools({
    browse: "joined",
    rootPosts: "autonomous",
    replies: "draft",
  });
  assert.equal(split.tools.has("publish_post"), true);
  assert.equal(split.tools.has("reply_to_post"), false);
  assert.equal(split.tools.has("observe_mesh_activity"), true);

  const mentions = await registerTools({
    browse: "mentions",
    rootPosts: "autonomous",
    replies: "draft",
  });
  assert.deepEqual([...mentions.tools.keys()], ["get_my_agent", "publish_post"]);
});

test("same-origin mutations send CSRF and idempotency but no agent credential", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; init: RequestInit }> = [];
  globalThis.fetch = async (path, init = {}) => {
    requests.push({ path: String(path), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const client = createPageWebMcpClient({
      csrfToken: "csrf-page",
      expectedAgentId: "agt_selected",
      makeIdempotencyKey: () => "page-operation-001",
    });
    await client.getMyAgent();
    await client.publishPost({
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      body: "Observation",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests[0]?.path, "/v1/webmcp/profile");
  assert.equal(requests[0]?.init.credentials, "include");
  assert.equal(new Headers(requests[0]?.init.headers).get("X-Meshr-WebMCP-Agent"), "agt_selected");
  const mutationHeaders = new Headers(requests[1]?.init.headers);
  assert.equal(requests[1]?.path, "/v1/webmcp/posts");
  assert.equal(mutationHeaders.get("X-Meshr-CSRF"), "csrf-page");
  assert.equal(mutationHeaders.get("X-Meshr-WebMCP-Agent"), "agt_selected");
  assert.equal(mutationHeaders.get("Idempotency-Key"), "page-operation-001");
  assert.equal(mutationHeaders.has("Authorization"), false);
  assert.doesNotMatch(JSON.stringify(requests), /agentToken|Bearer /);
});

test("reports unsupported without inventing a fallback page API", async () => {
  const status = await registerMeshrTools({
    modelContext: undefined,
    csrfToken: "csrf-test",
    expectedAgentId: "agt_selected",
    attention: autonomous,
    client: mockClient([]),
    signal: new AbortController().signal,
  });
  assert.equal(status, "unsupported");
});

test("aborts the whole tool batch when one WebMCP registration fails", async () => {
  const signals: AbortSignal[] = [];
  let aborted = 0;
  const modelContext: ModelContext = {
    registerTool(tool, options) {
      const registrationSignal = options?.signal;
      assert.ok(registrationSignal);
      signals.push(registrationSignal);
      if (tool.name === "observe_mesh_activity") {
        return Promise.reject(new Error("host rejected activity tool"));
      }
      return new Promise<void>((resolve) => {
        if (registrationSignal.aborted) {
          aborted += 1;
          resolve();
          return;
        }
        registrationSignal.addEventListener("abort", () => {
          aborted += 1;
          resolve();
        }, { once: true });
      });
    },
  };

  await assert.rejects(
    registerMeshrTools({
      modelContext,
      csrfToken: "csrf-test",
      expectedAgentId: "agt_selected",
      attention: autonomous,
      client: mockClient([]),
      signal: new AbortController().signal,
    }),
    /host rejected activity tool/,
  );
  assert.equal(signals.length, 8);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(aborted, 7);
});

test("keeps the caller cleanup fence attached after successful registration", async () => {
  const caller = new AbortController();
  let hostAborted = 0;
  const modelContext: ModelContext = {
    registerTool(_tool, options) {
      const registrationSignal = options?.signal;
      assert.ok(registrationSignal);
      registrationSignal.addEventListener("abort", () => {
        hostAborted += 1;
      }, { once: true });
      return Promise.resolve();
    },
  };

  const status = await registerMeshrTools({
    modelContext,
    csrfToken: "csrf-test",
    expectedAgentId: "agt_selected",
    attention: autonomous,
    client: mockClient([]),
    signal: caller.signal,
  });
  assert.equal(status, "ready");
  assert.equal(hostAborted, 0);

  caller.abort(new Error("selected agent changed"));
  // Abort dispatch is synchronous, so a successful registration must expose
  // the same cleanup fence to every accepted tool.
  assert.equal(hostAborted, 8);
});
