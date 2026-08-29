import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureOpenClawBinding,
  MESHR_OPENCLAW_TOOL_ALLOWLIST,
} from "../connector/openclaw.ts";
import { ConnectorStateStore } from "../connector/state.ts";
import type { ConnectorBinding } from "../connector/types.ts";

function openClawBinding(): ConnectorBinding {
  const now = "2026-08-27T00:00:00.000Z";
  return {
    pairingId: "pair-bramble",
    bindingId: "pair-bramble",
    agentId: "agent-bramble",
    serverUrl: "http://127.0.0.1:8787",
    runtime: "openclaw",
    label: "OpenClaw Bramble",
    externalSubject: "openclaw:garden-main",
    definitionPath: "/tmp/bramble.md",
    definitionDigest: "digest-bramble",
    requestedProfile: {
      name: "Bramble",
      handle: "bramble",
      tagline: "Garden observer",
      interests: ["Gardening"],
      personality: "Grounded.",
      attention: {
        browse: "public",
        rootPosts: "autonomous",
        replies: "autonomous",
        notes: "Notice field evidence.",
      },
    },
    publicKeyPem: "public-key",
    privateKeyPem: "private-key",
    pairingSecret: "pairing-secret",
    pairingCode: "ABCD-EFGH",
    pairingExpiresAt: now,
    status: "connected",
    agentToken: "agent-token",
    agentTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: now,
    updatedAt: now,
  };
}

test("OpenClaw configuration targets the exact agent and installs the exact Meshr allowlist", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-openclaw-setup-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ConnectorStateStore(directory, { useKeychain: false });
  await store.upsert(openClawBinding());
  const calls: string[][] = [];
  const events: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    events.push("verify-bearer");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer agent-token",
    );
    return new Response(
      JSON.stringify({ agent: { id: "agent-bramble", handle: "bramble" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const configured = await configureOpenClawBinding({
    selector: "bramble",
    openClawAgentId: "garden-main",
    store,
    runCommand: async (_command, args) => {
      events.push(args.slice(0, 2).join(" "));
      calls.push(args);
      if (args[0] === "config" && args[1] === "get") {
        return {
          stdout: JSON.stringify([
            { id: "main" },
            { id: "garden-main", tools: { profile: "coding" } },
          ]),
          stderr: "",
        };
      }
      return { stdout: "ok", stderr: "" };
    },
  });

  assert.equal(events[0], "verify-bearer");
  assert.deepEqual(calls[0], ["config", "get", "agents.list", "--json"]);
  assert.equal(calls[1]?.[0], "config");
  assert.equal(calls[1]?.[1], "set");
  assert.equal(calls[1]?.[2], "--batch-json");
  const operations = JSON.parse(calls[1]?.[3] ?? "null") as Array<{
    path: string;
    value: unknown;
  }>;
  assert.deepEqual(operations, [
    { path: "plugins.entries.meshr.enabled", value: true },
    {
      path: "plugins.entries.meshr.config.baseUrl",
      value: "http://127.0.0.1:8787",
    },
    {
      path: "plugins.entries.meshr.config.statePath",
      value: store.path,
    },
    { path: "agents.list[1].tools.profile", value: "full" },
    {
      path: "agents.list[1].tools.allow",
      value: MESHR_OPENCLAW_TOOL_ALLOWLIST,
    },
  ]);
  assert.deepEqual(calls[2], ["config", "validate", "--json"]);
  assert.deepEqual(configured, {
    openClawAgentId: "garden-main",
    bindingHandle: "bramble",
    serverUrl: "http://127.0.0.1:8787",
    statePath: store.path,
    toolAllowlist: MESHR_OPENCLAW_TOOL_ALLOWLIST,
  });
  assert.equal(JSON.stringify({ calls, configured }).includes("agent-token"), false);
});
