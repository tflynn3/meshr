import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { transformProtectedFixture } from "../scripts/protected-fixture-state.ts";

test("protected fixture state encrypts, authenticates, and preserves private file mode", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-protected-fixture-"));
  const inputPath = join(directory, "state.json");
  const encryptedPath = join(directory, "protected-state.enc");
  const decryptedPath = join(directory, "round-trip.json");
  const wrongDecryptedPath = join(directory, "wrong-key.json");
  const input = JSON.stringify({ version: 1, bindings: [{ pairingId: "pairing-demo", agentToken: "secret" }] });
  const key = randomBytes(32).toString("base64");
  const previousKey = process.env.MESHR_PROTECTED_STATE_KEY;
  process.env.MESHR_PROTECTED_STATE_KEY = key;
  try {
    await writeFile(inputPath, input, { mode: 0o600 });
    await transformProtectedFixture("encrypt", inputPath, encryptedPath);
    const encrypted = await readFile(encryptedPath, "utf8");
    assert.notEqual(encrypted, input);
    assert.deepEqual((await stat(encryptedPath)).mode & 0o077, 0);

    await transformProtectedFixture("decrypt", encryptedPath, decryptedPath);
    assert.equal(await readFile(decryptedPath, "utf8"), input);
    assert.deepEqual((await stat(decryptedPath)).mode & 0o077, 0);

    process.env.MESHR_PROTECTED_STATE_KEY = randomBytes(32).toString("base64");
    await assert.rejects(
      transformProtectedFixture("decrypt", encryptedPath, wrongDecryptedPath),
      /authentication failed/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.MESHR_PROTECTED_STATE_KEY;
    else process.env.MESHR_PROTECTED_STATE_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});

test("protected fixture state supports an explicit key-rotation reseed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-protected-fixture-rotation-"));
  const inputPath = join(directory, "state.json");
  const oldEncryptedPath = join(directory, "old.enc");
  const newEncryptedPath = join(directory, "new.enc");
  const restoredPath = join(directory, "restored.json");
  const input = JSON.stringify({ version: 1, bindings: [{ pairingId: "pairing-rotation" }] });
  const oldKey = randomBytes(32).toString("base64");
  const newKey = randomBytes(32).toString("base64");
  const previousKey = process.env.MESHR_PROTECTED_STATE_KEY;
  process.env.MESHR_PROTECTED_STATE_KEY = oldKey;
  try {
    await writeFile(inputPath, input, { mode: 0o600 });
    await transformProtectedFixture("encrypt", inputPath, oldEncryptedPath);
    process.env.MESHR_PROTECTED_STATE_KEY = newKey;
    await assert.rejects(
      transformProtectedFixture("decrypt", oldEncryptedPath, restoredPath),
      /authentication failed/,
    );
    // The normal -> protected workflow deliberately falls back to its
    // reviewed plaintext fixture, then writes a replacement envelope under
    // the new key before switching runtime mode.
    await transformProtectedFixture("encrypt", inputPath, newEncryptedPath);
    await transformProtectedFixture("decrypt", newEncryptedPath, restoredPath);
    assert.equal(await readFile(restoredPath, "utf8"), input);
  } finally {
    if (previousKey === undefined) delete process.env.MESHR_PROTECTED_STATE_KEY;
    else process.env.MESHR_PROTECTED_STATE_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
