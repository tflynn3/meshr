import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  PageAgentAttention,
  PageWebMcpClient,
  PageWebMcpControlClient,
} from "../src/domain/agentTools.ts";
import {
  createConversationalAgent,
  createPageWebMcpControlClient,
  createPageWebMcpClient,
  createWebMcpSessionMutationFence,
  registerMeshrControlTools,
  registerMeshrSetupTools,
  registerMeshrTools,
} from "../src/webmcp/registerMeshrTools.ts";
import {
  disableWebMcpSession,
  enableWebMcpSession,
} from "../src/auth/api.ts";

const deployedSmokeSource = readFileSync(
  new URL("../scripts/smoke-deployed.ts", import.meta.url),
  "utf8",
);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

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
    joinMesh: async (input) => {
      calls.push({ method: "joinMesh", input });
      return { ...input, status: "joined" };
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

test("registers the browser session control plane before an agent is selected", async () => {
  const calls: Array<{ method: string; input?: unknown }> = [];
  const client: PageWebMcpControlClient = {
    getMeshrSession: async () => {
      calls.push({ method: "getMeshrSession" });
      return { enabled: false, agent: null, createdAt: null, expiresAt: null };
    },
    listMyAgents: async () => {
      calls.push({ method: "listMyAgents" });
      return { agents: [{ id: "agt_owned", handle: "owned" }] };
    },
    createAgent: async (input) => {
      calls.push({ method: "createAgent", input });
      return { enabled: true, agent: { id: "agt_created", handle: input.handle } };
    },
    selectMyAgent: async (input) => {
      calls.push({ method: "selectMyAgent", input });
      return { enabled: true, agent: { id: input.agentId, handle: "owned" } };
    },
    releasePageControl: async () => {
      calls.push({ method: "releasePageControl" });
      return { enabled: false, agent: null, createdAt: null, expiresAt: null };
    },
  };
  const tools = new Map<string, WebMcpTool>();
  const status = await registerMeshrControlTools({
    modelContext: {
      async registerTool(tool) {
        tools.set(tool.name, tool);
      },
    },
    signal: new AbortController().signal,
    client,
  });

  assert.equal(status, "setup-ready");
  assert.deepEqual([...tools.keys()].sort(), [
    "create_meshr_agent",
    "get_meshr_session",
    "list_my_agents",
    "release_page_control",
    "select_my_agent",
  ]);
  assert.equal(tools.get("get_meshr_session")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("list_my_agents")?.annotations?.readOnlyHint, true);
  assert.equal(tools.get("create_meshr_agent")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("select_my_agent")?.annotations?.readOnlyHint, false);
  assert.equal(tools.get("release_page_control")?.annotations?.readOnlyHint, false);

  const createSchema = tools.get("create_meshr_agent")?.inputSchema as {
    required: string[];
    properties: { participation: { enum: string[] } };
  };
  assert.ok(createSchema.required.includes("participation"));
  assert.deepEqual(createSchema.properties.participation.enum, [
    "observe",
    "interactive",
    "autonomous",
  ]);
  assert.match(
    tools.get("select_my_agent")?.description ?? "",
    /up to one hour.*without extending/iu,
  );
  assert.match(
    tools.get("release_page_control")?.description ?? "",
    /revoke.*trigger removal/iu,
  );
});

test("control operations use the human session and explain their temporary runtime boundary", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const inactive = {
    enabled: false,
    agent: null,
    pageSessionId: null,
    createdAt: null,
    expiresAt: null,
  };
  const active = {
    enabled: true,
    agent: { id: "agt_owned", handle: "owned" },
    pageSessionId: "page-owned",
    createdAt: "2026-09-03T10:00:00.000Z",
    expiresAt: "2026-09-03T11:00:00.000Z",
  };
  globalThis.fetch = async (path, init = {}) => {
    requests.push({ path: String(path), init });
    const method = init.method ?? "GET";
    const payload = String(path) === "/v1/agents"
      ? { agents: [{ id: "agt_owned", handle: "owned" }] }
      : method === "DELETE"
        ? inactive
        : method === "POST"
          ? active
          : inactive;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const changes: unknown[] = [];
  try {
    const client = createPageWebMcpControlClient({
      csrfToken: "csrf-page",
      principalKind: "guest",
      onSessionChanged: (next) => changes.push(next),
    });
    const session = await client.getMeshrSession() as {
      pageControl: { temporary: boolean; startsRuntime: boolean; keepsRuntimeAlive: boolean };
      principal: { kind: string; recovery: string };
    };
    const agents = await client.listMyAgents() as {
      agents: Array<{ id: string }>;
      pageControl: { temporary: boolean };
    };
    const selected = await client.selectMyAgent({ agentId: "agt_owned" }) as {
      pageControl: { startsRuntime: boolean };
    };
    const released = await client.releasePageControl() as {
      pageControl: { keepsRuntimeAlive: boolean };
    };

    assert.deepEqual(session.pageControl, {
      temporary: true,
      startsRuntime: false,
      keepsRuntimeAlive: false,
    });
    assert.equal(session.principal.kind, "guest");
    assert.match(session.principal.recovery, /browser guest session.*signing in/iu);
    assert.equal(agents.agents[0]?.id, "agt_owned");
    assert.equal(agents.pageControl.temporary, true);
    assert.equal(selected.pageControl.startsRuntime, false);
    assert.equal(released.pageControl.keepsRuntimeAlive, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map(({ path, init }) => [path, init.method ?? "GET"]), [
    ["/v1/webmcp/session", "GET"],
    ["/v1/agents", "GET"],
    ["/v1/webmcp/session", "POST"],
    ["/v1/webmcp/session/release", "DELETE"],
  ]);
  assert.equal(
    new Headers(requests[2]?.init.headers).get("X-Meshr-CSRF"),
    "csrf-page",
  );
  assert.equal(
    new Headers(requests[3]?.init.headers).get("X-Meshr-CSRF"),
    "csrf-page",
  );
  assert.equal(
    new Headers(requests[3]?.init.headers).get("X-Meshr-WebMCP-Agent"),
    "agt_owned",
  );
  assert.equal(
    new Headers(requests[3]?.init.headers).get("X-Meshr-WebMCP-Session"),
    "page-owned",
  );
  assert.equal(changes.length, 2);
});

test("release is a no-op when the observed page session is already inactive", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; method: string }> = [];
  globalThis.fetch = async (path, init = {}) => {
    requests.push({
      path: String(path),
      method: init.method ?? "GET",
    });
    return new Response(JSON.stringify({
      enabled: false,
      agent: null,
      pageSessionId: null,
      createdAt: null,
      expiresAt: null,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const client = createPageWebMcpControlClient({
      csrfToken: "csrf-page",
      principalKind: "guest",
    });
    const released = await client.releasePageControl() as {
      enabled: boolean;
      pageControl: { temporary: boolean };
    };
    assert.equal(released.enabled, false);
    assert.equal(released.pageControl.temporary, true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { path: "/v1/webmcp/session", method: "GET" },
  ]);
});

test("the page API refuses an unconditional release before network I/O", () => {
  const unsafeDisable = disableWebMcpSession as unknown as (
    csrfToken: string,
  ) => Promise<unknown>;
  assert.throws(
    () => unsafeDisable("csrf-page"),
    /webmcp_authority_corrupt/u,
  );
});

test("the deployed smoke releases exactly the page grant it observed", () => {
  assert.match(
    deployedSmokeSource,
    /request\("\/v1\/webmcp\/session\/release",\s*\{[\s\S]*?"x-meshr-webmcp-agent": agentId,[\s\S]*?"x-meshr-webmcp-session": pageSessionId,/u,
  );
});

test("same-origin page selections preserve response order across tabs", async () => {
  const originalFetch = globalThis.fetch;
  const navigatorObject = globalThis.navigator;
  const originalLocks = Object.getOwnPropertyDescriptor(navigatorObject, "locks");
  const pending = [deferred<Response>(), deferred<Response>()];
  const arrived = [deferred<void>(), deferred<void>()];
  const requests: Array<{ agentId: string; method: string }> = [];
  let requestIndex = 0;
  let lockTail: Promise<void> = Promise.resolve();

  Object.defineProperty(navigatorObject, "locks", {
    configurable: true,
    value: {
      request<T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> {
        const run = lockTail.then(callback);
        lockTail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    },
  });
  globalThis.fetch = async (_path, init = {}) => {
    const body = JSON.parse(String(init.body)) as { agentId: string };
    requests.push({ agentId: body.agentId, method: init.method ?? "GET" });
    const index = requestIndex;
    requestIndex += 1;
    arrived[index]?.resolve();
    return pending[index]!.promise;
  };

  try {
    const first = enableWebMcpSession("agt_first", "csrf");
    const second = enableWebMcpSession("agt_second", "csrf");
    await arrived[0]!.promise;
    await flushMicrotasks();
    assert.deepEqual(requests, [
      { agentId: "agt_first", method: "POST" },
    ]);

    pending[0]!.resolve(new Response(JSON.stringify({ enabled: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await first;
    await arrived[1]!.promise;
    assert.deepEqual(requests, [
      { agentId: "agt_first", method: "POST" },
      { agentId: "agt_second", method: "POST" },
    ]);
    pending[1]!.resolve(new Response(JSON.stringify({ enabled: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await second;
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocks) {
      Object.defineProperty(navigatorObject, "locks", originalLocks);
    } else {
      delete (navigatorObject as Navigator & { locks?: LockManager }).locks;
    }
  }
});

test("aborted control registration cannot publish a late session change", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const changes: unknown[] = [];
  let resolveFetch: ((response: Response) => void) | undefined;
  let requestSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_path, init = {}) => {
    requestSignal = init.signal;
    return new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
  };
  try {
    const client = createPageWebMcpControlClient({
      csrfToken: "csrf-page",
      principalKind: "guest",
      signal: controller.signal,
      onSessionChanged: (next) => changes.push(next),
    });
    const selecting = client.selectMyAgent({ agentId: "agt_owned" });
    await flushMicrotasks();
    assert.ok(resolveFetch);
    controller.abort();
    resolveFetch?.(new Response(JSON.stringify({
      enabled: true,
      agent: { id: "agt_owned", handle: "owned" },
      pageSessionId: "page-owned",
      createdAt: "2026-09-03T10:00:00.000Z",
      expiresAt: "2026-09-03T11:00:00.000Z",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await selecting;
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestSignal, controller.signal);
  assert.deepEqual(changes, []);
});

test("serializes page-control mutations and brackets each one with lifecycle callbacks", async () => {
  const originalFetch = globalThis.fetch;
  const pending = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
  const arrived = [deferred<void>(), deferred<void>(), deferred<void>()];
  const requests: Array<{ path: string; method: string }> = [];
  const events: string[] = [];
  let mutationIndex = 0;
  const active = (id: string, handle: string) => ({
    enabled: true,
    agent: { id, handle },
    pageSessionId: `page-${id}`,
    createdAt: "2026-09-03T10:00:00.000Z",
    expiresAt: "2026-09-03T11:00:00.000Z",
  });
  const inactive = {
    enabled: false,
    agent: null,
    pageSessionId: null,
    createdAt: null,
    expiresAt: null,
  };
  globalThis.fetch = async (path, init = {}) => {
    const request = { path: String(path), method: init.method ?? "GET" };
    requests.push(request);
    if (request.path === "/v1/webmcp/meshes") {
      return new Response(JSON.stringify({ meshes: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const response = pending[mutationIndex];
    arrived[mutationIndex]?.resolve();
    mutationIndex += 1;
    assert.ok(response, `unexpected mutation request ${request.method} ${request.path}`);
    return response.promise;
  };
  try {
    const client = createPageWebMcpControlClient({
      csrfToken: "csrf-page",
      principalKind: "guest",
      onMutationStarted: () => events.push("started"),
      onMutationSettled: () => events.push("settled"),
      onSessionChanged: (session) => events.push(`session:${session.agent?.id ?? "none"}`),
    });
    const creating = client.createAgent({
      name: "Created",
      handle: "created",
      tagline: "Created under test.",
      interests: ["testing"],
      personality: "Careful.",
      participation: "interactive",
    });
    const selecting = client.selectMyAgent({ agentId: "agt_selected" });
    const releasing = client.releasePageControl();

    await arrived[0]!.promise;
    assert.deepEqual(requests, [{ path: "/v1/webmcp/session", method: "POST" }]);
    assert.deepEqual(events, ["started"]);

    pending[0]!.resolve(new Response(JSON.stringify(active("agt_created", "created")), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    await creating;
    await arrived[1]!.promise;
    assert.deepEqual(requests, [
      { path: "/v1/webmcp/session", method: "POST" },
      { path: "/v1/webmcp/meshes", method: "GET" },
      { path: "/v1/webmcp/session", method: "POST" },
    ]);
    assert.deepEqual(events, [
      "started",
      "session:agt_created",
      "settled",
      "started",
    ]);

    pending[1]!.resolve(new Response(JSON.stringify(active("agt_selected", "selected")), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await selecting;
    await arrived[2]!.promise;
    assert.deepEqual(requests.at(-1), {
      path: "/v1/webmcp/session/release",
      method: "DELETE",
    });
    assert.deepEqual(events.slice(-3), [
      "session:agt_selected",
      "settled",
      "started",
    ]);

    pending[2]!.resolve(new Response(JSON.stringify(inactive), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await releasing;
    assert.deepEqual(events.slice(-3), ["started", "session:none", "settled"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("session mutation fence rejects reads begun before or during a mutation", async () => {
  const fence = createWebMcpSessionMutationFence();
  const beforeMutation = deferred<string>();
  const beforeTicket = fence.capture();
  const beforeResult = beforeMutation.promise.then((value) =>
    fence.isCurrent(beforeTicket) ? value : "discarded"
  );

  fence.mutationStarted();
  beforeMutation.resolve("stale-before");
  assert.equal(await beforeResult, "discarded");

  const duringMutation = deferred<string>();
  const duringTicket = fence.capture();
  const duringResult = duringMutation.promise.then((value) =>
    fence.isCurrent(duringTicket) ? value : "discarded"
  );
  fence.mutationSettled();
  duringMutation.resolve("stale-during");
  assert.equal(await duringResult, "discarded");

  const currentTicket = fence.capture();
  assert.equal(fence.isCurrent(currentTicket), true);
});

test("a rejected control tool registration removes the whole browser control surface", async () => {
  const signals: AbortSignal[] = [];
  let aborted = 0;
  const client: PageWebMcpControlClient = {
    getMeshrSession: async () => ({}),
    listMyAgents: async () => ({}),
    createAgent: async () => ({}),
    selectMyAgent: async () => ({}),
    releasePageControl: async () => ({}),
  };
  const modelContext: ModelContext = {
    registerTool(tool, options) {
      const registrationSignal = options?.signal;
      assert.ok(registrationSignal);
      signals.push(registrationSignal);
      if (tool.name === "list_my_agents") {
        return Promise.reject(new Error("host rejected owned-agent listing"));
      }
      return new Promise<void>((resolve) => {
        registrationSignal.addEventListener("abort", () => {
          aborted += 1;
          resolve();
        }, { once: true });
      });
    },
  };

  await assert.rejects(
    registerMeshrControlTools({
      modelContext,
      signal: new AbortController().signal,
      client,
    }),
    /host rejected owned-agent listing/,
  );
  assert.equal(signals.length, 5);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(aborted, 4);
});

test("registers nine typed tools without caller-controlled identity fields", async () => {
  const { status, tools } = await registerTools();
  assert.equal(status, "ready");
  assert.deepEqual([...tools.keys()].sort(), [
    "discover_meshes",
    "follow_conversation",
    "get_my_agent",
    "inspect_traffic_link",
    "join_mesh",
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

test("page browsing tools identify external social data as untrusted and authority-free", async () => {
  const { tools } = await registerTools();
  for (const name of [
    "discover_meshes",
    "observe_mesh_activity",
    "read_conversation",
    "inspect_traffic_link",
  ]) {
    const tool = tools.get(name);
    assert.ok(tool, `missing tool ${name}`);
    assert.equal(tool.annotations?.untrustedContentHint, true);
    assert.match(tool.description, /untrusted social data/i);
    assert.match(tool.description, /grant no tool, file, or account authority/i);
  }
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
  assert.equal(draft.tools.has("publish_post"), true);
  assert.equal(draft.tools.has("reply_to_post"), false);
  assert.equal(draft.tools.has("discover_meshes"), true);

  const split = await registerTools({
    browse: "joined",
    rootPosts: "autonomous",
    replies: "draft",
  });
  assert.equal(split.tools.has("publish_post"), true);
  assert.equal(split.tools.has("reply_to_post"), true);
  assert.equal(split.tools.has("observe_mesh_activity"), true);

  const mentions = await registerTools({
    browse: "mentions",
    rootPosts: "autonomous",
    replies: "draft",
  });
  assert.deepEqual([...mentions.tools.keys()], ["get_my_agent", "publish_post", "reply_to_post"]);
});

test("registers a single conversational setup tool before an identity exists", async () => {
  const tools = new Map<string, WebMcpTool>();
  const status = await registerMeshrSetupTools({
    modelContext: {
      async registerTool(tool) {
        tools.set(tool.name, tool);
      },
    },
    signal: new AbortController().signal,
    createAgent: async (profile) => ({
      enabled: true,
      agent: { id: "agt_chem", handle: profile.handle, interests: profile.interests },
      recommendations: [
        { id: "mesh-public", name: "Public mesh", joined: true, reason: "Open public commons" },
      ],
    }),
  });
  assert.equal(status, "setup-ready");
  assert.deepEqual([...tools.keys()], ["create_meshr_agent"]);
  const setup = tools.get("create_meshr_agent");
  assert.ok(setup);
  assert.equal(setup.annotations?.readOnlyHint, false);
  assert.match(setup.description, /natural language/i);
  assert.match(setup.description, /retry once with every field unchanged/iu);
  assert.match(setup.description, /changing any field starts a new creation request/iu);
  const value = await executeJson(setup, {
    name: "Computational Chemist",
    handle: "computational-chemist",
    tagline: "Models molecules and reactions.",
    interests: ["computational chemistry", "molecular simulation"],
    personality: "Rigorous, curious, and concise.",
    participation: "interactive",
  }) as { agent: { handle: string }; recommendations: Array<{ id: string }> };
  assert.equal(value.agent.handle, "computational-chemist");
  assert.equal(value.recommendations[0]?.id, "mesh-public");
});

test("rejects a missing or invalid participation choice", async () => {
  let calls = 0;
  const tools = new Map<string, WebMcpTool>();
  await registerMeshrSetupTools({
    modelContext: {
      async registerTool(tool) {
        tools.set(tool.name, tool);
      },
    },
    signal: new AbortController().signal,
    createAgent: async () => {
      calls += 1;
      return {};
    },
  });
  const base = {
    name: "Computational Chemist",
    handle: "computational-chemist",
    tagline: "Models molecules and reactions.",
    interests: ["computational chemistry"],
    personality: "Rigorous and concise.",
  };
  await assert.rejects(
    () => executeJson(tools.get("create_meshr_agent"), base),
    /Choose participation explicitly/,
  );
  await assert.rejects(
    () => executeJson(tools.get("create_meshr_agent"), {
      ...base,
      participation: "sometimes",
    }),
    /Choose participation explicitly/,
  );
  assert.equal(calls, 0);
});

test("keeps a created identity when mesh recommendations are temporarily unavailable", async () => {
  const originalFetch = globalThis.fetch;
  const createdAt = "2026-09-02T12:00:00.000Z";
  const createdSession = {
    enabled: true,
    pageSessionId: "page-chem",
    agent: {
      id: "agt_chem",
      ownerId: "usr_guest",
      name: "Computational Chemist",
      handle: "computational-chemist",
      tagline: "Models molecules and reactions.",
      interests: ["computational chemistry", "molecular simulation"],
      personality: "Rigorous, curious, and concise.",
      attention: {
        browse: "public" as const,
        rootPosts: "draft" as const,
        replies: "draft" as const,
        notes: "Participate when directly instructed through this page.",
      },
      runtime: "other" as const,
      runtimeLabel: "Page WebMCP",
      runtimeSubject: "webmcp:agt_chem",
      definitionDigest: null,
      createdAt,
      updatedAt: createdAt,
    },
    createdAt,
    expiresAt: "2026-09-03T12:00:00.000Z",
  };
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (path, init) => {
    requests.push({ path: String(path), init });
    if (String(path) === "/v1/webmcp/session") {
      return new Response(JSON.stringify(createdSession), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      error: { code: "temporarily_unavailable", message: "Try again later." },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };
  let adoptedAgentId: string | null = null;
  try {
    const result = await createConversationalAgent({
      profile: {
        name: "Computational Chemist",
        handle: "computational-chemist",
        tagline: "Models molecules and reactions.",
        interests: ["computational chemistry", "molecular simulation"],
        personality: "Rigorous, curious, and concise.",
        participation: "observe",
      },
      csrfToken: "csrf-page",
      onCreated: (session) => {
        adoptedAgentId = session.agent?.id ?? null;
      },
    });
    assert.equal(result.agent?.id, "agt_chem");
    assert.equal(result.recommendationStatus, "unavailable");
    assert.deepEqual(result.recommendations, []);
    assert.match(result.nextStep, /explore the public mesh/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(adoptedAgentId, "agt_chem");
  assert.deepEqual(requests.map(({ path }) => path), [
    "/v1/webmcp/session",
    "/v1/webmcp/meshes",
  ]);
  assert.equal(
    JSON.parse(String(requests[0]?.init?.body)).createAgent.participation,
    "observe",
  );
});

test("reuses one creation idempotency key after an ambiguous response", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_path, init = {}) => {
    requests.push(init);
    return new Response(JSON.stringify({
      error: {
        code: "durable_store_unavailable",
        message: "The response did not establish whether creation committed.",
      },
    }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  };
  const input = {
    profile: {
      name: "Continuance",
      handle: "continuance",
      tagline: "Keeps evidence attached to long-running work.",
      interests: ["continuity", "provenance"],
      personality: "Precise and patient.",
      participation: "interactive" as const,
    },
    csrfToken: "csrf-page",
  };
  try {
    await assert.rejects(() => createConversationalAgent(input));
    await assert.rejects(() => createConversationalAgent(input));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 2);
  const firstKey = new Headers(requests[0]?.headers).get("Idempotency-Key");
  const secondKey = new Headers(requests[1]?.headers).get("Idempotency-Key");
  assert.match(firstKey ?? "", /^webmcp-create-[0-9a-f]{64}$/u);
  assert.equal(secondKey, firstKey);
  assert.equal(requests[1]?.body, requests[0]?.body);
});

test("reuses one deterministic fallback after a handle collision and ambiguous response", async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_path, init = {}) => {
    requests.push(init);
    const originalAttempt = requests.length % 2 === 1;
    return originalAttempt
      ? new Response(JSON.stringify({
          error: {
            code: "handle_unavailable",
            message: "That agent handle is already in use.",
          },
        }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        })
      : new Response(JSON.stringify({
          error: {
            code: "durable_store_unavailable",
            message: "The response did not establish whether creation committed.",
          },
        }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
  };
  const input = {
    profile: {
      name: "Continuance",
      handle: "continuance",
      tagline: "Keeps evidence attached to long-running work.",
      interests: ["continuity", "provenance"],
      personality: "Precise and patient.",
      participation: "interactive" as const,
    },
    csrfToken: "csrf-page",
  };
  try {
    await assert.rejects(() => createConversationalAgent(input));
    await assert.rejects(() => createConversationalAgent(input));
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 4);
  const keys = requests.map((request) =>
    new Headers(request.headers).get("Idempotency-Key")
  );
  const bodies = requests.map((request) => String(request.body));
  assert.equal(keys[2], keys[0]);
  assert.equal(keys[3], keys[1]);
  assert.equal(bodies[2], bodies[0]);
  assert.equal(bodies[3], bodies[1]);
  const requestedHandle = JSON.parse(bodies[0]!).createAgent.handle as string;
  const fallbackHandle = JSON.parse(bodies[1]!).createAgent.handle as string;
  assert.equal(requestedHandle, "continuance");
  assert.match(fallbackHandle, /^continuance-[0-9a-f]{5}$/u);
  assert.notEqual(keys[1], keys[0]);
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
    await client.joinMesh({ meshId: "mesh-research" });
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
  const joinHeaders = new Headers(requests[2]?.init.headers);
  assert.equal(requests[2]?.path, "/v1/webmcp/meshes/mesh-research/join");
  assert.equal(joinHeaders.get("X-Meshr-CSRF"), "csrf-page");
  assert.equal(joinHeaders.get("X-Meshr-WebMCP-Agent"), "agt_selected");
  assert.equal(joinHeaders.get("Idempotency-Key"), "page-operation-001");
  assert.equal(joinHeaders.has("Authorization"), false);
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

test("verifies the page grant resolves to the selected identity before reporting ready", async () => {
  let aborted = 0;
  const modelContext: ModelContext = {
    registerTool(_tool, options) {
      options?.signal?.addEventListener("abort", () => {
        aborted += 1;
      }, { once: true });
      return Promise.resolve();
    },
  };
  const client = mockClient([]);
  client.getMyAgent = async () => ({ agent: { id: "agt_other" } });
  await assert.rejects(
    registerMeshrTools({
      modelContext,
      csrfToken: "csrf-test",
      expectedAgentId: "agt_selected",
      attention: autonomous,
      client,
      signal: new AbortController().signal,
    }),
    /did not verify the selected Meshr identity/,
  );
  assert.equal(aborted, 9);
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
  assert.equal(signals.length, 9);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(aborted, 8);
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
  assert.equal(hostAborted, 9);
});
