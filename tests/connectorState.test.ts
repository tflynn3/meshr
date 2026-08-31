import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

test("credential storage mode rejects unsafe configuration typos", () => {
  const previous = process.env.MESHR_CREDENTIAL_STORAGE;
  process.env.MESHR_CREDENTIAL_STORAGE = "vault";
  try {
    assert.throws(
      () => new ConnectorStateStore("/tmp/meshr-invalid-credential-mode"),
      /MESHR_CREDENTIAL_STORAGE must be auto, keychain, or file/,
    );
  } finally {
    if (previous === undefined) delete process.env.MESHR_CREDENTIAL_STORAGE;
    else process.env.MESHR_CREDENTIAL_STORAGE = previous;
  }
});

test("connector state refuses insecure directories, files, and symlinks", async (t) => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "meshr-state-boundary-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, "state.json");
  const state = `${JSON.stringify({ version: CONNECTOR_STATE_VERSION, bindings: [] })}\n`;

  await chmod(directory, 0o755);
  await assert.rejects(
    new ConnectorStateStore(directory, { useKeychain: false }).load(),
    /state directory must not be accessible/,
  );

  await chmod(directory, 0o700);
  await writeFile(statePath, state, { mode: 0o644 });
  await assert.rejects(
    new ConnectorStateStore(directory, { useKeychain: false }).load(),
    /session state must not be readable/,
  );

  await chmod(statePath, 0o600);
  const targetPath = join(directory, "state-target.json");
  await rename(statePath, targetPath);
  await symlink(targetPath, statePath);
  await assert.rejects(
    new ConnectorStateStore(directory, { useKeychain: false }).load(),
    /session state must be a regular file, not a symlink/,
  );

  const targetDirectory = join(directory, "target-directory");
  const linkedDirectory = join(directory, "linked-directory");
  await mkdir(targetDirectory, { mode: 0o700 });
  await symlink(targetDirectory, linkedDirectory, "dir");
  await assert.rejects(
    new ConnectorStateStore(linkedDirectory, { useKeychain: false }).save({
      version: CONNECTOR_STATE_VERSION,
      bindings: [],
    }),
    /state directory must be a regular directory/,
  );

  // Keep the test's cleanup assertion honest if a platform's symlink support
  // changes: the target remains a private regular file.
  assert.equal((await readFile(targetPath, "utf8")), state);
});

test("connector state rejects oversized serialized output before keychain writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-state-size-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let keychainWrites = 0;
  const store = new ConnectorStateStore(directory, {
    credentialBackend: {
      supported: () => true,
      save: async () => {
        keychainWrites += 1;
      },
      load: async () => ({ privateKeyPem: "private-key", pairingSecret: "pairing-secret" }),
      remove: async () => undefined,
    },
  });
  const oversized = binding({
    pairingId: "pair-oversized",
    status: "connected",
    createdAt: "2026-08-30T00:00:00.000Z",
  });
  oversized.requestedProfile.personality = "x".repeat(5 * 1024 * 1024);

  await assert.rejects(
    store.save({ version: CONNECTOR_STATE_VERSION, bindings: [oversized] }),
    /session state is unexpectedly large/,
  );
  assert.equal(keychainWrites, 0);
});
