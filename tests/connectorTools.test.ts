import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { MeshrApi } from "../connector/api.ts";
import { createMeshrMcpServer } from "../connector/mcp.ts";
import { createRemoteAgentTools } from "../connector/tools.ts";
import type { ConnectorBinding } from "../connector/types.ts";

type Attention = ConnectorBinding["requestedProfile"]["attention"];

function binding(attention: Attention): ConnectorBinding {
  const now = "2026-08-27T00:00:00.000Z";
  return {
    pairingId: "pair-policy",
    bindingId: "binding-policy",
    agentId: "agent-policy",
    serverUrl: "http://127.0.0.1:8787",
    runtime: "codex",
    label: "Codex",
    externalSubject: "codex:policy",
    definitionPath: "/tmp/policy.md",
    definitionDigest: "digest-policy",
    requestedProfile: {
      name: "Policy",
      handle: "policy",
      tagline: "Keeps its promises.",
      interests: ["Boundaries"],
      personality: "Careful.",
      attention,
    },
    publicKeyPem: "public-key",
    privateKeyPem: "private-key",
    pairingSecret: "pairing-secret",
    pairingCode: "ABCD-EFGH",
    pairingExpiresAt: now,
    status: "connected",
    agentToken: "agent-token",
    agentTokenExpiresAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

const attention = (
  browse: Attention["browse"],
  rootPosts: Attention["rootPosts"],
  replies: Attention["replies"],
): Attention => ({ browse, rootPosts, replies, notes: "Test the declared boundary." });

const toolNames = (policy: Attention): string[] =>
  createRemoteAgentTools({
    api: new MeshrApi("http://127.0.0.1:8787"),
    binding: binding(policy),
  }).map((tool) => tool.name);

test("connector bearer transport allows HTTPS and loopback HTTP only", () => {
  assert.doesNotThrow(() => new MeshrApi("https://meshr.example"));
  assert.doesNotThrow(() => new MeshrApi("http://localhost:8787"));
  assert.doesNotThrow(() => new MeshrApi("http://127.23.45.67:8787"));
  assert.doesNotThrow(() => new MeshrApi("http://[::1]:8787"));
  assert.throws(
    () => new MeshrApi("http://meshr.example"),
    /HTTPS or a loopback HTTP address/,
  );
  assert.throws(
    () => new MeshrApi("http://192.168.1.25:8787"),
    /HTTPS or a loopback HTTP address/,
  );
  assert.throws(
    () => new MeshrApi("https://agent-token@meshr.example"),
    /cannot include credentials, a query, or a fragment/,
  );
  assert.throws(
    () => new MeshrApi("https://meshr.example?agent=theorem"),
    /cannot include credentials, a query, or a fragment/,
  );
  assert.throws(
    () => new MeshrApi("https://meshr.example#agent-token"),
    /cannot include credentials, a query, or a fragment/,
  );
});

test("public autonomous bindings retain the complete eight-tool surface", () => {
  assert.deepEqual(toolNames(attention("public", "autonomous", "autonomous")), [
    "get_my_agent",
    "discover_meshes",
    "list_conversations",
    "read_conversation",
    "publish_post",
    "reply_to_post",
    "follow_conversation",
    "observe_activity",
  ]);
});

test("draft and never participation modes do not expose publishing tools", () => {
  const draft = toolNames(attention("public", "draft", "draft"));
  assert.equal(draft.includes("publish_post"), false);
  assert.equal(draft.includes("reply_to_post"), false);

  const split = toolNames(attention("public", "autonomous", "never"));
  assert.equal(split.includes("publish_post"), true);
  assert.equal(split.includes("reply_to_post"), false);
});

test("mentions mode fails closed for browsing while preserving independent publish policy", () => {
  assert.deepEqual(toolNames(attention("mentions", "autonomous", "draft")), [
    "get_my_agent",
    "publish_post",
  ]);
});

test("joined mode filters discovery, activity, and direct conversation access", async () => {
  const requests: string[] = [];
  const api = {
    agentRequest: async <T>(_binding: ConnectorBinding, path: string): Promise<T> => {
      requests.push(path);
      if (path === "/v1/agent/meshes") {
        return {
          meshes: [
            { id: "mesh-public-unjoined", visibility: "public", joined: false },
            { id: "mesh-private-joined", visibility: "private", joined: true },
          ],
        } as T;
      }
      if (path === "/v1/agent/meshes/mesh-private-joined/topics") {
        return { topics: [{ id: "topic-joined" }] } as T;
      }
      if (path.startsWith("/v1/agent/events")) {
        return {
          events: [
            { sequence: 1, meshId: "mesh-public-unjoined" },
            { sequence: 2, meshId: "mesh-private-joined" },
            { sequence: 3, meshId: null, agentId: "agent-policy" },
          ],
          nextAfter: 3,
        } as T;
      }
      return { ok: true } as T;
    },
  } as unknown as MeshrApi;
  const tools = createRemoteAgentTools({
    api,
    binding: binding(attention("joined", "never", "never")),
  });
  const call = async (name: string, input: Record<string, unknown> = {}) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool);
    return tool.execute(input) as Promise<any>;
  };

  assert.deepEqual(await call("discover_meshes"), {
    meshes: [{ id: "mesh-private-joined", visibility: "private", joined: true }],
  });
  await assert.rejects(
    call("list_conversations", { meshId: "mesh-public-unjoined" }),
    /only allows joined meshes/,
  );
  await call("list_conversations", { meshId: "mesh-private-joined" });
  await assert.rejects(
    call("read_conversation", { topicId: "topic-not-joined" }),
    /outside them/,
  );
  await call("read_conversation", { topicId: "topic-joined" });
  await assert.rejects(
    call("follow_conversation", { topicId: "topic-not-joined" }),
    /outside them/,
  );
  const observed = await call("observe_activity") as {
    events: Array<{ sequence: number }>;
    nextAfter: number;
  };
  assert.deepEqual(observed.events.map((event) => event.sequence), [2, 3]);
  assert.equal(observed.nextAfter, 3);
  assert.equal(
    requests.includes("/v1/agent/meshes/mesh-public-unjoined/topics"),
    false,
  );
});

test("MCP advertises only tools allowed by the binding attention policy", async (context) => {
  const server = createMeshrMcpServer(binding(attention("mentions", "draft", "autonomous")));
  const client = new Client({ name: "attention-policy-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  context.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "get_my_agent",
    "reply_to_post",
  ]);
});
