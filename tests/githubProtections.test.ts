import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appliesToRef,
  assertDistinctReleaseAppIds,
  isNamespaceWideReleaseTagRule,
  matchesRefPattern,
} from "../scripts/check-github-protections.mjs";

test("GitHub ref matching honors exact refs, wildcards, and exclusion precedence", () => {
  assert.equal(matchesRefPattern("refs/heads/main", "main", "heads"), true);
  assert.equal(matchesRefPattern("refs/heads/main", "canary", "heads"), false);
  assert.equal(matchesRefPattern("refs/tags/v*", "v1.2.3-rc.1", "tags"), true);
  assert.equal(matchesRefPattern("~ALL", "production", "heads"), true);
  assert.equal(
    appliesToRef({ conditions: { ref_name: { include: ["refs/heads/~ALL"], exclude: ["refs/heads/main"] } } }, "main", "heads"),
    false,
  );
});

test("release tag protection must cover the complete v* namespace", () => {
  const namespaceRule = (include: string[], exclude: string[] = []) => ({
    conditions: { ref_name: { include, exclude } },
  });
  assert.equal(isNamespaceWideReleaseTagRule(namespaceRule(["refs/tags/v*"])), true);
  assert.equal(isNamespaceWideReleaseTagRule(namespaceRule(["v*"])), true);
  assert.equal(isNamespaceWideReleaseTagRule(namespaceRule(["refs/tags/v1.2.3"])), false);
  assert.equal(isNamespaceWideReleaseTagRule(namespaceRule(["refs/tags/v*"], ["refs/tags/v0.*"])), false);
  assert.equal(isNamespaceWideReleaseTagRule(namespaceRule(["refs/tags/~ALL"])), false);
});

test("canary and production release identities must be distinct", () => {
  assert.deepEqual(assertDistinctReleaseAppIds(101, 202), {
    canaryId: 101,
    productionId: 202,
  });
  assert.throws(() => assertDistinctReleaseAppIds(101, 101), /distinct integrations/);
  assert.throws(() => assertDistinctReleaseAppIds(0, 202), /positive integers/);
});
