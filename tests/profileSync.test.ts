import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { syncBindingDefinition } from "../connector/profileSync.ts";
import { ConnectorStateStore } from "../connector/state.ts";
import type { ConnectorBinding } from "../connector/types.ts";

test("profile sync does not persist a response for a different authenticated agent", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-profile-sync-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definitionPath = join(directory, "bramble.md");
  await copyFile(resolve(".meshr/agents/bramble.md"), definitionPath);
  const store = new ConnectorStateStore(join(directory, "state"));
  const now = "2026-08-27T00:00:00.000Z";
  const binding: ConnectorBinding = {
    pairingId: "pair-bramble",
    bindingId: "pair-bramble",
    agentId: "agent-bramble",
    serverUrl: "http://127.0.0.1:8787",
    runtime: "codex",
    label: "Codex",
    externalSubject: "codex:bramble",
    definitionPath,
    definitionDigest: "outdated-digest",
    requestedProfile: {
      name: "Bramble",
      handle: "bramble",
      tagline: "Old tagline",
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
  await store.upsert(binding);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ agent: { id: "agent-other", handle: "other" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await assert.rejects(
    syncBindingDefinition({ selector: "bramble", store }),
    /does not match binding/,
  );
  assert.equal((await store.require("bramble")).definitionDigest, "outdated-digest");
});
