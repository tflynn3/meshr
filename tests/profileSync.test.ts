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
  const store = new ConnectorStateStore(join(directory, "state"), { useKeychain: false });
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

test("profile reload keeps the live runtime authority when shared state is stale", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-profile-sync-live-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const definitionPath = join(directory, "bramble.md");
  await copyFile(resolve(".meshr/agents/bramble.md"), definitionPath);
  const store = new ConnectorStateStore(join(directory, "state"), { useKeychain: false });
  const now = "2026-08-27T00:00:00.000Z";
  const persisted: ConnectorBinding = {
    pairingId: "pair-live-authority",
    bindingId: "binding-live-authority",
    agentId: "agent-bramble",
    serverUrl: "http://127.0.0.1:8787",
    runtime: "codex",
    label: "Codex",
    externalSubject: "codex:bramble-live",
    definitionPath,
    definitionDigest: "outdated-digest",
    requestedProfile: {
      name: "Bramble",
      handle: "bramble-live",
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
    agentToken: "old-token",
    agentTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    sessionId: "old-session",
    createdAt: now,
    updatedAt: now,
  };
  await store.upsert(persisted);
  const live = {
    ...persisted,
    agentToken: "live-token",
    agentTokenExpiresAt: "2099-01-01T00:15:00.000Z",
    sessionId: "live-session",
  };
  const originalFetch = globalThis.fetch;
  let authorization = "";
  globalThis.fetch = async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(
      JSON.stringify({
        agent: {
          id: "agent-bramble",
          handle: "bramble-live",
          name: "Bramble",
          tagline: "New tagline",
          interests: ["Gardening"],
          personality: "Grounded.",
          attention: live.requestedProfile.attention,
        },
        profileReload: {
          contract_version: 1,
          applied: true,
          applied_fields: ["tagline"],
          pending_owner_review_fields: [],
          source_digest: "fresh-digest",
          validation_failures: [],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await syncBindingDefinition({
    selector: persisted.pairingId,
    store,
    binding: live,
    allowIdentityChanges: true,
  });
  assert.equal(authorization, "Bearer live-token");
  assert.equal(result.binding.agentToken, "live-token");
  assert.equal(result.binding.sessionId, "live-session");
  assert.equal(result.binding.requestedProfile.tagline, "New tagline");
  assert.equal((await store.require(persisted.pairingId)).agentToken, "old-token");
});
