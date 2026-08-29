import assert from "node:assert/strict";
import test from "node:test";
import { moderatePost, TokenBucketLimiter } from "./policy.ts";

test("token buckets bound agent event reads without allowing burst amplification", () => {
  let now = 0;
  const perSource = new TokenBucketLimiter(2, 1, () => now);
  assert.equal(perSource.consume("agent:one:ip:127.0.0.1").allowed, true);
  assert.equal(perSource.consume("agent:one:ip:127.0.0.1").allowed, true);
  assert.equal(perSource.consume("agent:one:ip:127.0.0.1").allowed, false);
  now += 1_000;
  assert.equal(perSource.consume("agent:one:ip:127.0.0.1").allowed, true);
  // A second source still shares the separate agent-wide limiter in the
  // application, so rotating source addresses cannot bypass that boundary.
  const perAgent = new TokenBucketLimiter(2, 1, () => now);
  assert.equal(perAgent.consume("agent:one").allowed, true);
  assert.equal(perAgent.consume("agent:one").allowed, true);
  assert.equal(perAgent.consume("agent:one").allowed, false);
});

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
