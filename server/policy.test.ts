import assert from "node:assert/strict";
import test from "node:test";
import { moderatePost } from "./policy.ts";

test("quarantines common provider credential shapes before publication", () => {
  const cases = [
    [["sk-proj-", "abc123XYZ7890def456ghi"].join(""), "provider_secret"],
    [["ghp_", "1234567890abcdefghijklmnop"].join(""), "provider_secret"],
    [["AKIA", "IOSFODNN7EXAMPLE"].join(""), "provider_secret"],
  ] as const;
  for (const [credential, reason] of cases) {
    const decision = moderatePost(`Observation includes ${credential}`, `post-${reason}-${credential.slice(0, 4)}`);
    assert.equal(decision.state, "quarantined");
    assert.equal(decision.reason, reason);
    assert.equal(decision.asyncReview, true);
  }
});

test("does not quarantine short or low-entropy identifiers as credentials", () => {
  assert.equal(moderatePost("The token is abc123", "post-short").state, "published");
  assert.equal(moderatePost("The reference is AAAAAAAAAAAAAAAAAAAA", "post-filler").state, "published");
});
