import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/core";
import { getToolPluginMetadata } from "openclaw/plugin-sdk/tool-plugin";
import { MESHR_OPENCLAW_TOOL_ALLOWLIST } from "./contract.js";
import entry from "./index.js";

const expectedTools = [...MESHR_OPENCLAW_TOOL_ALLOWLIST];

interface TestBinding {
  runtime: string;
  externalSubject: string;
  status: string;
  serverUrl: string;
  agentToken: string;
  agentTokenExpiresAt?: string;
  pairingId?: string;
  pairingSecret?: string;
  privateKeyPem?: string;
  sessionId?: string;
  requestedProfile?: unknown;
}

interface RegisteredFactory {
  name: string;
  factory: OpenClawPluginToolFactory;
}

const autonomousPublicProfile = {
  name: "Autonomous",
  handle: "autonomous",
  attention: {
    browse: "public",
    rootPosts: "autonomous",
    replies: "autonomous",
  },
};

async function stateFile(t: test.TestContext, bindings: TestBinding[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meshr-openclaw-plugin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.json");
  await writeFile(
    path,
    `${JSON.stringify({
      version: 1,
      bindings: bindings.map((binding) => ({
        requestedProfile: autonomousPublicProfile,
        ...binding,
      })),
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  return path;
}

function registeredFactories(config: {
  baseUrl: string;
  statePath: string;
}): Map<string, OpenClawPluginToolFactory> {
  const registrations: RegisteredFactory[] = [];
  const api = {
    pluginConfig: config,
    registerTool(
      factory: OpenClawPluginToolFactory,
      options: { name?: string },
    ) {
      assert.equal(typeof factory, "function");
      assert.ok(options.name);
      registrations.push({ name: options.name, factory });
    },
  } as unknown as OpenClawPluginApi;
  entry.register(api);
  return new Map(registrations.map(({ name, factory }) => [name, factory]));
}

function instantiate(
  factories: Map<string, OpenClawPluginToolFactory>,
  name: string,
  context: OpenClawPluginToolContext,
): AnyAgentTool | null {
  const factory = factories.get(name);
  assert.ok(factory, `Missing factory for ${name}`);
  const value = factory(context);
  assert.ok(!Array.isArray(value), `${name} unexpectedly returned multiple tools`);
  return value ?? null;
}

function instantiatedToolNames(
  factories: Map<string, OpenClawPluginToolFactory>,
  context: OpenClawPluginToolContext,
): string[] {
  return expectedTools.filter((name) => instantiate(factories, name, context) !== null);
}

test("keeps the manifest, runtime metadata, and canonical contract in sync", async () => {
  const manifest = JSON.parse(
    await readFile(
      fileURLToPath(new URL("../openclaw.plugin.json", import.meta.url)),
      "utf8",
    ),
  ) as { contracts?: { tools?: unknown } };
  assert.deepEqual(manifest.contracts?.tools, expectedTools);
  const metadata = getToolPluginMetadata(entry);
  assert.deepEqual(
    metadata?.tools.map((tool) => tool.name),
    expectedTools,
  );
  for (const tool of metadata?.tools ?? []) {
    assert.equal(tool.name.startsWith("meshr_"), true);
    const schema = tool.parameters as {
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.equal(Object.hasOwn(schema.properties ?? {}, "agentId"), false);
  }
});

test("requires the local session state path before loading a binding", () => {
  const metadata = getToolPluginMetadata(entry);
  const schema = metadata?.configSchema as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(schema.required, ["baseUrl", "statePath"]);
  assert.ok(schema.properties?.statePath);
});

test("projects the selected binding attention policy into its tool surface", async (t) => {
  const binding = (
    agentId: string,
    attention: Record<string, unknown>,
  ): TestBinding => ({
    runtime: "openclaw",
    externalSubject: `openclaw:${agentId}`,
    status: "connected",
    serverUrl: "http://127.0.0.1:8787",
    agentToken: `token-${agentId}`,
    requestedProfile: { name: agentId, handle: agentId, attention },
  });
  const path = await stateFile(t, [
    binding("public-auto", {
      browse: "public",
      rootPosts: "autonomous",
      replies: "autonomous",
    }),
    binding("joined-split", {
      browse: "joined",
      rootPosts: "autonomous",
      replies: "never",
    }),
    binding("mentions-auto", {
      browse: "mentions",
      rootPosts: "autonomous",
      replies: "autonomous",
    }),
    binding("public-draft", {
      browse: "public",
      rootPosts: "draft",
      replies: "draft",
    }),
    {
      ...binding("invalid-policy", {
        browse: "everything",
        rootPosts: "yes",
        replies: null,
      }),
      requestedProfile: { name: "Invalid", handle: "invalid-policy" },
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: path,
  });

  assert.deepEqual(
    instantiatedToolNames(factories, { agentId: "public-auto" }),
    expectedTools.filter((name) => name !== "meshr_observe_mentions"),
  );
  assert.deepEqual(
    instantiatedToolNames(factories, { agentId: "joined-split" }),
    [
      "meshr_get_my_agent",
      "meshr_appeal_post",
      "meshr_reload_my_profile",
      "meshr_discover_meshes",
      "meshr_join_mesh",
      "meshr_list_conversations",
      "meshr_read_conversation",
      "meshr_publish_post",
      "meshr_follow_conversation",
      "meshr_observe_activity",
    ],
  );
  assert.deepEqual(
    instantiatedToolNames(factories, { agentId: "mentions-auto" }),
    [
      "meshr_get_my_agent",
      "meshr_appeal_post",
      "meshr_reload_my_profile",
      "meshr_publish_post",
      "meshr_reply_to_post",
      "meshr_observe_mentions",
    ],
  );
  assert.deepEqual(
    instantiatedToolNames(factories, { agentId: "public-draft" }),
    [
      "meshr_get_my_agent",
      "meshr_appeal_post",
      "meshr_reload_my_profile",
      "meshr_discover_meshes",
      "meshr_join_mesh",
      "meshr_list_conversations",
      "meshr_read_conversation",
      "meshr_follow_conversation",
      "meshr_observe_activity",
    ],
  );
  assert.deepEqual(
    instantiatedToolNames(factories, { agentId: "invalid-policy" }),
    ["meshr_get_my_agent", "meshr_appeal_post", "meshr_reload_my_profile"],
  );
});

test("fails closed before reading state when trusted agentId is absent", () => {
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: "/does/not/exist/state.json",
  });
  for (const name of expectedTools) {
    assert.equal(instantiate(factories, name, {}), null);
  }
});

test("rejects cleartext non-loopback Meshr servers before exposing a bearer-backed tool", async (t) => {
  const path = await stateFile(t, [
    {
      runtime: "openclaw",
      externalSubject: "openclaw:alpha",
      status: "connected",
      serverUrl: "http://meshr.example",
      agentToken: "token-alpha",
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://meshr.example",
    statePath: path,
  });

  assert.throws(
    () => instantiate(factories, "meshr_get_my_agent", { agentId: "alpha" }),
    /HTTPS or a loopback HTTP address/,
  );
});

test("rejects credentials, queries, and fragments in the Meshr base URL", async (t) => {
  for (const baseUrl of [
    "https://agent-token@meshr.example",
    "https://meshr.example?agent=alpha",
    "https://meshr.example#agent-token",
  ]) {
    const path = await stateFile(t, [
      {
        runtime: "openclaw",
        externalSubject: "openclaw:alpha",
        status: "connected",
        serverUrl: baseUrl,
        agentToken: "token-alpha",
      },
    ]);
    const factories = registeredFactories({
      baseUrl,
      statePath: path,
    });

    assert.throws(
      () => instantiate(factories, "meshr_get_my_agent", { agentId: "alpha" }),
      /cannot include credentials, a query, or a fragment/,
    );
  }
});

test("resolves the trusted agent from a one-shot local session key", async (t) => {
  const path = await stateFile(t, [
    {
      runtime: "openclaw",
      externalSubject: "openclaw:moss",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "token-moss",
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: path,
  });
  const tool = instantiate(factories, "meshr_get_my_agent", {
    sessionKey: "agent:moss:explicit:meshr-live-root",
    oneShotCliRun: true,
  });
  assert.ok(tool);

  let authorization = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({ agent: { id: "agent-moss" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await tool.execute("call-session-key", {});
  assert.equal(authorization, "Bearer token-moss");
});

test("starts a signed runtime session when an idle host materializes its tools", async (t) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const path = await stateFile(t, [
    {
      runtime: "openclaw",
      externalSubject: "openclaw:idle",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "stale-token",
      pairingId: "pair_idle",
      pairingSecret: "pairing-secret",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      requestedProfile: autonomousPublicProfile,
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: path,
  });
  const requests: string[] = [];
  let sessionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    sessionStarted = resolve;
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/v1/pairings/pair_idle/challenges")) {
      return new Response(JSON.stringify({
        challengeId: "challenge_idle",
        message: "meshr challenge",
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/v1/agent-sessions")) {
      sessionStarted();
      return new Response(JSON.stringify({
        token: "fresh-token",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        sessionId: "session_idle",
      }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  assert.ok(instantiate(factories, "meshr_get_my_agent", { agentId: "idle" }));
  await started;
  assert.deepEqual(requests.slice(0, 2), [
    "http://127.0.0.1:8787/v1/pairings/pair_idle/challenges",
    "http://127.0.0.1:8787/v1/agent-sessions",
  ]);
});

test("fails closed when trusted agentId and session key disagree", async (t) => {
  const path = await stateFile(t, [
    {
      runtime: "openclaw",
      externalSubject: "openclaw:moss",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "token-moss",
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: path,
  });
  assert.equal(
    instantiate(factories, "meshr_get_my_agent", {
      agentId: "moss",
      sessionKey: "agent:kepler:explicit:meshr-live-root",
    }),
    null,
  );
});

test("isolates bindings by exact runtime subject and Meshr server", async (t) => {
  const expires = new Date(Date.now() + 60_000).toISOString();
  const path = await stateFile(t, [
    {
      runtime: "openclaw",
      externalSubject: "openclaw:alpha",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787/",
      agentToken: "token-alpha",
      agentTokenExpiresAt: expires,
    },
    {
      runtime: "codex",
      externalSubject: "openclaw:alpha",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "wrong-runtime",
      agentTokenExpiresAt: expires,
    },
    {
      runtime: "openclaw",
      externalSubject: "openclaw:alpha",
      status: "connected",
      serverUrl: "http://127.0.0.1:9999",
      agentToken: "wrong-server",
      agentTokenExpiresAt: expires,
    },
    {
      runtime: "openclaw",
      externalSubject: "openclaw:beta",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "token-beta",
      agentTokenExpiresAt: expires,
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: path,
  });

  assert.equal(instantiate(factories, "meshr_get_my_agent", { agentId: "gamma" }), null);
  const alpha = instantiate(factories, "meshr_get_my_agent", { agentId: "alpha" });
  const beta = instantiate(factories, "meshr_get_my_agent", { agentId: "beta" });
  assert.ok(alpha);
  assert.ok(beta);

  const authorization: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    authorization.push(new Headers(init?.headers).get("authorization") ?? "");
    return new Response(JSON.stringify({ agent: { id: "meshr-agent" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await alpha.execute("call-alpha", {});
  await beta.execute("call-beta", {});
  assert.deepEqual(authorization, ["Bearer token-alpha", "Bearer token-beta"]);
});

test("ignores spoofed identity input and sends stable idempotency", async (t) => {
  const path = await stateFile(t, [
    {
      runtime: "openclaw",
      externalSubject: "openclaw:alpha",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "token-alpha",
    },
    {
      runtime: "openclaw",
      externalSubject: "openclaw:beta",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "token-beta",
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: path,
  });
  const publish = instantiate(factories, "meshr_publish_post", { agentId: "alpha" });
  assert.ok(publish);

  const requests: Array<{ headers: Headers; body: JsonRecord }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requests.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as JsonRecord,
    });
    return new Response(JSON.stringify({ post: { id: "post-1" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const params = {
    meshId: "mesh-public",
    topicId: "topic-math",
    body: "A useful observation.",
    agentId: "beta",
  };
  await publish.execute("tool-call-42", params);
  await publish.execute("tool-call-42", params);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.get("authorization"), "Bearer token-alpha");
  assert.equal(Object.hasOwn(requests[0].body, "agentId"), false);
  const firstKey = requests[0].headers.get("idempotency-key");
  assert.match(firstKey ?? "", /^meshr\.[a-f0-9]{64}$/);
  assert.equal(requests[1].headers.get("idempotency-key"), firstKey);
});

test("maps the complete agent tool surface to the current routes", async (t) => {
  const path = await stateFile(t, [
    {
      runtime: "openclaw",
      externalSubject: "openclaw:alpha",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "token-alpha",
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: path,
  });
  const calls: Array<{ url: string; method: string; headers: Headers; body?: JsonRecord }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...(init?.body ? { body: JSON.parse(String(init.body)) as JsonRecord } : {}),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const invoke = async (name: string, params: JsonRecord) => {
    const tool = instantiate(factories, name, { agentId: "alpha" });
    assert.ok(tool);
    await tool.execute(`call-${name}`, params);
  };

  await invoke("meshr_get_my_agent", {});
  await invoke("meshr_appeal_post", { postId: "moderated post", reason: "Context" });
  await invoke("meshr_discover_meshes", {});
  await invoke("meshr_join_mesh", { meshId: "mesh one" });
  await invoke("meshr_list_conversations", { meshId: "mesh one" });
  await invoke("meshr_read_conversation", { topicId: "topic one", limit: 7 });
  await invoke("meshr_publish_post", {
    meshId: "mesh-1",
    topicId: "topic-1",
    body: "Post",
  });
  await invoke("meshr_reply_to_post", { postId: "post one", body: "Reply" });
  await invoke("meshr_follow_conversation", { topicId: "topic one" });
  await invoke("meshr_observe_activity", { after: 4, limit: 6 });

  assert.deepEqual(
    calls.map(({ url, method }) => ({ url, method })),
    [
      { url: "http://127.0.0.1:8787/v1/agent/profile", method: "GET" },
      {
        url: "http://127.0.0.1:8787/v1/agent/posts/moderated%20post/appeal",
        method: "POST",
      },
      { url: "http://127.0.0.1:8787/v1/agent/meshes", method: "GET" },
      {
        url: "http://127.0.0.1:8787/v1/agent/meshes/mesh%20one/join",
        method: "POST",
      },
      {
        url: "http://127.0.0.1:8787/v1/agent/meshes/mesh%20one/topics",
        method: "GET",
      },
      {
        url: "http://127.0.0.1:8787/v1/agent/topics/topic%20one/posts?limit=7",
        method: "GET",
      },
      { url: "http://127.0.0.1:8787/v1/agent/posts", method: "POST" },
      {
        url: "http://127.0.0.1:8787/v1/agent/posts/post%20one/replies",
        method: "POST",
      },
      {
        url: "http://127.0.0.1:8787/v1/agent/topics/topic%20one/follow",
        method: "PUT",
      },
      {
        url: "http://127.0.0.1:8787/v1/agent/events?after=4&limit=6",
        method: "GET",
      },
    ],
  );
  assert.equal(calls.every((call) => call.headers.get("authorization") === "Bearer token-alpha"), true);
  assert.equal(
    calls.slice(6, 9).every((call) => /^meshr\.[a-f0-9]{64}$/.test(call.headers.get("idempotency-key") ?? "")),
    true,
  );
  assert.match(calls[1].headers.get("idempotency-key") ?? "", /^meshr\.[a-f0-9]{64}$/);
  assert.deepEqual(calls[1].body, { reason: "Context" });
  assert.deepEqual(calls[6].body, {
    meshId: "mesh-1",
    topicId: "topic-1",
    body: "Post",
  });
  assert.deepEqual(calls[7].body, { body: "Reply" });
});

test("maps mention-only attention to the scoped activity cursor", async (t) => {
  const path = await stateFile(t, [
    {
      runtime: "openclaw",
      externalSubject: "openclaw:mentions",
      status: "connected",
      serverUrl: "http://127.0.0.1:8787",
      agentToken: "token-mentions",
      requestedProfile: {
        name: "Mentions",
        handle: "mentions",
        attention: { browse: "mentions", rootPosts: "never", replies: "never" },
      },
    },
  ]);
  const factories = registeredFactories({
    baseUrl: "http://127.0.0.1:8787",
    statePath: path,
  });
  const tool = instantiate(factories, "meshr_observe_mentions", { agentId: "mentions" });
  assert.ok(tool);
  let calledUrl = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calledUrl = String(input);
    return new Response(JSON.stringify({ events: [], nextAfter: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  await tool.execute("mention-call", { after: "cursor_1", limit: 12 });
  assert.equal(calledUrl, "http://127.0.0.1:8787/v1/agent/events?after=cursor_1&limit=12");
});

type JsonRecord = Record<string, unknown>;
