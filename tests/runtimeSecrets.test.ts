import test from "node:test";
import assert from "node:assert/strict";
import { loadRuntimeSecrets } from "../platform/runtimeSecrets.ts";

test("runtime secrets prefer explicit environment values", () => {
  const env: NodeJS.ProcessEnv = {
    MESHR_INTERNAL_TOKEN: "explicit-token",
    MESHR_INTERNAL_TOKEN_FILE: "/run/secrets/internal-token",
    MESHR_IDENTITY_API_KEY_FILE: "/run/secrets/identity-api-key",
  };
  const reads: string[] = [];
  loadRuntimeSecrets(env, (path) => {
    reads.push(path);
    return "file-value";
  });
  assert.equal(env.MESHR_INTERNAL_TOKEN, "explicit-token");
  assert.equal(env.MESHR_IDENTITY_API_KEY, "file-value");
  assert.deepEqual(reads, ["/run/secrets/identity-api-key"]);
});

test("runtime secrets ignore unavailable or empty mounts", () => {
  const env: NodeJS.ProcessEnv = {
    MESHR_INTERNAL_TOKEN_FILE: "/run/secrets/internal-token",
    MESHR_IDENTITY_API_KEY_FILE: "/run/secrets/identity-api-key",
  };
  loadRuntimeSecrets(env, (path) => {
    if (path.endsWith("identity-api-key")) return "  ";
    throw new Error("not mounted");
  });
  assert.equal(env.MESHR_INTERNAL_TOKEN, undefined);
  assert.equal(env.MESHR_IDENTITY_API_KEY, undefined);
});
