import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistRuntimeBindingWithRetry } from "../connector/mcp.ts";
import {
  ConnectorStateConflictError,
  ConnectorStateStore,
} from "../connector/state.ts";
import type { ConnectorBinding } from "../connector/types.ts";

function nextBinding(): ConnectorBinding {
  return {
    pairingId: "pair-persistence-test",
    bindingId: "binding-persistence-test",
    agentId: "agent-persistence-test",
    serverUrl: "http://127.0.0.1:8787",
    runtime: "codex",
    label: "Persistence test",
    externalSubject: "codex:persistence-test",
    definitionPath: "/tmp/persistence-test.md",
    definitionDigest: "digest-persistence-test",
    requestedProfile: {
      name: "Persistence test",
      handle: "persistence-test",
      tagline: "Persistence test",
      interests: ["testing"],
      personality: "Careful",
      attention: {
        browse: "public",
        rootPosts: "autonomous",
        replies: "autonomous",
        notes: "Test",
      },
    },
    publicKeyPem: "public-key",
    privateKeyPem: "private-key",
    pairingSecret: "pairing-secret",
    pairingCode: "ABCD-EFGH",
    pairingExpiresAt: "2026-08-30T00:00:00.000Z",
    status: "connected",
    agentToken: "successor-token",
    agentTokenExpiresAt: "2026-08-30T00:15:00.000Z",
    sessionId: "session-successor",
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

test("runtime successor is adopted before a transient persistence retry", async () => {
  const successor = nextBinding();
  let attempts = 0;
  const adopted: ConnectorBinding[] = [];
  const result = await persistRuntimeBindingWithRetry({
    nextBinding: successor,
    required: true,
    retryDelaysMs: [0, 0],
    persist: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary keychain failure");
      return { ...successor, updatedAt: "2026-08-30T00:00:01.000Z" };
    },
    onAdopt: (binding) => adopted.push(binding),
  });

  assert.equal(attempts, 2);
  assert.equal(result.persisted, true);
  assert.equal(result.binding.agentToken, "successor-token");
  assert.deepEqual(adopted.map((binding) => binding.updatedAt), [
    successor.updatedAt,
    "2026-08-30T00:00:01.000Z",
  ]);
});

test("best-effort persistence keeps the live successor when local storage stays unavailable", async () => {
  const successor = nextBinding();
  let attempts = 0;
  const adopted: ConnectorBinding[] = [];
  const result = await persistRuntimeBindingWithRetry({
    nextBinding: successor,
    required: false,
    retryDelaysMs: [0],
    persist: async () => {
      attempts += 1;
      throw new Error("locked keychain");
    },
    onAdopt: (binding) => adopted.push(binding),
  });

  assert.equal(attempts, 1);
  assert.equal(result.persisted, false);
  assert.equal(result.binding.sessionId, "session-successor");
  assert.deepEqual(adopted, [successor]);
});

test("a newer authority preflight stops a retry before stale successor adoption", async () => {
  const successor = nextBinding();
  let adopted = 0;
  let persisted = 0;
  await assert.rejects(
    persistRuntimeBindingWithRetry({
      nextBinding: successor,
      required: false,
      retryDelaysMs: [0],
      preflight: async () => {
        throw new ConnectorStateConflictError();
      },
      persist: async () => {
        persisted += 1;
        return successor;
      },
      onAdopt: () => {
        adopted += 1;
      },
    }),
    ConnectorStateConflictError,
  );
  assert.equal(adopted, 0);
  assert.equal(persisted, 0);
});

test("a transient preflight failure still adopts the successor before retrying persistence", async () => {
  const successor = nextBinding();
  let preflightAttempts = 0;
  const adopted: ConnectorBinding[] = [];
  const result = await persistRuntimeBindingWithRetry({
    nextBinding: successor,
    required: true,
    retryDelaysMs: [0],
    preflight: async () => {
      preflightAttempts += 1;
      throw new Error("temporary state read failure");
    },
    persist: async () => successor,
    onAdopt: (binding) => adopted.push(binding),
  });
  assert.equal(preflightAttempts, 1);
  assert.equal(result.persisted, true);
  assert.deepEqual(adopted.map((binding) => binding.sessionId), [
    successor.sessionId,
    successor.sessionId,
  ]);
});

test("persistence retry pins the original pairing when a newer same-handle retry appears", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-session-selector-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ConnectorStateStore(directory, { useKeychain: false });
  const original = nextBinding();
  await store.upsert(original);
  const successor = {
    ...original,
    agentToken: "original-successor-token",
    sessionId: "original-successor-session",
  };
  const newerRetry = {
    ...original,
    pairingId: "pair-persistence-newer",
    bindingId: "binding-persistence-newer",
    agentId: "agent-persistence-newer",
    agentToken: "newer-retry-token",
    sessionId: "newer-retry-session",
    createdAt: "2026-08-30T00:01:00.000Z",
    updatedAt: "2026-08-30T00:01:00.000Z",
  };
  let attempts = 0;
  const result = await persistRuntimeBindingWithRetry({
    nextBinding: successor,
    required: true,
    retryDelaysMs: [0, 0],
    persist: async () => {
      attempts += 1;
      if (attempts === 1) {
        await store.upsert(newerRetry);
        assert.equal((await store.require(original.requestedProfile.handle)).pairingId, newerRetry.pairingId);
        throw new Error("temporary persistence failure");
      }
      return store.patch(original.pairingId, {
        status: "connected",
        agentToken: successor.agentToken,
        agentTokenExpiresAt: successor.agentTokenExpiresAt,
        sessionId: successor.sessionId,
        bindingId: successor.bindingId,
        agentId: successor.agentId,
      });
    },
  });

  assert.equal(result.persisted, true);
  const state = await store.load();
  const persistedOriginal = state.bindings.find((binding) => binding.pairingId === original.pairingId);
  const persistedNewer = state.bindings.find((binding) => binding.pairingId === newerRetry.pairingId);
  assert.equal(persistedOriginal?.agentToken, successor.agentToken);
  assert.equal(persistedOriginal?.sessionId, successor.sessionId);
  assert.equal(persistedNewer?.agentToken, newerRetry.agentToken);
  assert.equal(persistedNewer?.sessionId, newerRetry.sessionId);
});

test("a compare-and-set race can reconcile against the observed successor authority", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-session-cas-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ConnectorStateStore(directory, { useKeychain: false });
  const original = nextBinding();
  await store.upsert(original);
  const successor = {
    ...original,
    agentToken: "candidate-token",
    sessionId: "candidate-session",
    agentTokenExpiresAt: "2026-08-30T00:20:00.000Z",
  };
  const observed = {
    ...original,
    agentToken: "observed-token",
    sessionId: "observed-session",
    agentTokenExpiresAt: "2026-08-30T00:19:00.000Z",
  };
  await store.upsert(observed);

  await assert.rejects(
    store.patch(original.pairingId, {
      sessionId: successor.sessionId,
      agentToken: successor.agentToken,
      agentTokenExpiresAt: successor.agentTokenExpiresAt,
    }, {
      expectedAuthorities: [{
        sessionId: original.sessionId,
        agentTokenExpiresAt: original.agentTokenExpiresAt,
        bindingId: original.bindingId,
        agentId: original.agentId,
      }],
    }),
    ConnectorStateConflictError,
  );

  const reconciled = await store.patch(original.pairingId, {
    status: "connected",
    sessionId: successor.sessionId,
    agentToken: successor.agentToken,
    agentTokenExpiresAt: successor.agentTokenExpiresAt,
  }, {
    expectedAuthorities: [
      {
        sessionId: observed.sessionId,
        agentTokenExpiresAt: observed.agentTokenExpiresAt,
        bindingId: observed.bindingId,
        agentId: observed.agentId,
      },
      {
        sessionId: successor.sessionId,
        agentTokenExpiresAt: successor.agentTokenExpiresAt,
        bindingId: successor.bindingId,
        agentId: successor.agentId,
      },
    ],
  });
  assert.equal(reconciled.sessionId, successor.sessionId);
  assert.equal((await store.require(original.pairingId)).agentToken, successor.agentToken);
});
