import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConnectorStateStore } from "../connector/state.ts";
import {
  CONNECTOR_STATE_VERSION,
  type ConnectorBinding,
} from "../connector/types.ts";

function binding(input: {
  pairingId: string;
  status: ConnectorBinding["status"];
  createdAt: string;
  updatedAt?: string;
  handle?: string;
  bindingId?: string;
}): ConnectorBinding {
  return {
    pairingId: input.pairingId,
    bindingId: input.bindingId,
    serverUrl: "http://127.0.0.1:8787/",
    runtime: "codex",
    label: "Codex",
    externalSubject: `subject-${input.pairingId}`,
    definitionPath: "/tmp/agent.md",
    definitionDigest: `digest-${input.pairingId}`,
    requestedProfile: {
      name: "Retry",
      handle: input.handle ?? "retry",
      tagline: "Tests connection retries.",
      interests: ["Testing"],
      personality: "Careful.",
      attention: {
        browse: "public",
        rootPosts: "draft",
        replies: "autonomous",
        notes: "Prefer explicit state.",
      },
    },
    publicKeyPem: "public-key",
    privateKeyPem: "private-key",
    pairingSecret: `secret-${input.pairingId}`,
    pairingCode: "ABCD-EFGH",
    pairingExpiresAt: "2026-08-28T00:00:00.000Z",
    status: input.status,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

async function stateStore(t: test.TestContext): Promise<ConnectorStateStore> {
  const directory = await mkdtemp(join(tmpdir(), "meshr-state-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new ConnectorStateStore(directory, { useKeychain: false });
}

test("handle lookup prefers the newest viable retry over an expired first attempt", async (t) => {
  const store = await stateStore(t);
  const expired = binding({
    pairingId: "pair-expired",
    status: "expired",
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T12:00:00.000Z",
  });
  const approvedRetry = binding({
    pairingId: "pair-approved-retry",
    status: "approved",
    createdAt: "2026-08-27T11:00:00.000Z",
  });
  await store.save({
    version: CONNECTOR_STATE_VERSION,
    bindings: [expired, approvedRetry],
  });

  assert.equal((await store.require("retry")).pairingId, approvedRetry.pairingId);
  assert.equal((await store.require(expired.pairingId)).status, "expired");
});

test("handle lookup is deterministic for multiple viable and terminal attempts", async (t) => {
  const store = await stateStore(t);
  const oldestViable = binding({
    pairingId: "pair-pending-old",
    status: "pending",
    createdAt: "2026-08-27T09:00:00.000Z",
  });
  const newestViable = binding({
    pairingId: "pair-approved-new",
    status: "approved",
    createdAt: "2026-08-27T11:00:00.000Z",
  });
  const newestOverall = binding({
    pairingId: "pair-revoked-newest",
    status: "revoked",
    createdAt: "2026-08-27T12:00:00.000Z",
  });
  await store.save({
    version: CONNECTOR_STATE_VERSION,
    bindings: [newestOverall, oldestViable, newestViable],
  });

  assert.equal((await store.require("retry")).pairingId, newestViable.pairingId);

  await store.save({
    version: CONNECTOR_STATE_VERSION,
    bindings: [
      { ...oldestViable, status: "denied" },
      newestOverall,
    ],
  });
  assert.equal((await store.require("retry")).pairingId, newestOverall.pairingId);
});

test("duplicate exact connector identifiers fail with an actionable ambiguity error", async (t) => {
  const store = await stateStore(t);
  await store.save({
    version: CONNECTOR_STATE_VERSION,
    bindings: [
      binding({
        pairingId: "pair-duplicate",
        status: "pending",
        createdAt: "2026-08-27T09:00:00.000Z",
      }),
      binding({
        pairingId: "pair-duplicate",
        status: "approved",
        createdAt: "2026-08-27T10:00:00.000Z",
        handle: "other-handle",
      }),
    ],
  });

  await assert.rejects(
    store.require("pair-duplicate"),
    /Meshr session state is ambiguous.*pairing ID pair-duplicate/,
  );
});
