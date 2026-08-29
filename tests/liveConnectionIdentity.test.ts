import assert from "node:assert/strict";
import { test } from "node:test";
import { liveCredentialValue, liveSourceAddress } from "../platform/liveConnectionIdentity.ts";

test("live credential bucketing follows bearer-over-cookie authorization precedence", () => {
  const bearer = "Bearer agent-grant";
  assert.equal(liveCredentialValue("meshr_session=one", bearer), "bearer:agent-grant");
  assert.equal(liveCredentialValue("junk=one; meshr_session=ignored", "Bearer   agent-grant  "), "bearer:agent-grant");
  assert.equal(liveCredentialValue("junk=one; meshr_session=one", undefined), "session:one");
  assert.equal(liveCredentialValue("junk=one; meshr_session=two", undefined), "session:two");
  assert.equal(liveCredentialValue("meshr_session=old; meshr_session=current", undefined), "session:current");
  assert.equal(liveCredentialValue("meshr_session=old; meshr_session=%ZZ", undefined), "session:old");
  assert.equal(liveCredentialValue("meshr_session=one", "bearer agent-grant"), "session:one");
  assert.equal(liveCredentialValue(undefined, undefined), "anonymous");
});

test("live source address trusts only a valid Cloudflare connecting IP", () => {
  assert.equal(liveSourceAddress("203.0.113.10", "10.0.0.4"), "203.0.113.10");
  assert.equal(liveSourceAddress("not-an-ip", "10.0.0.4"), "10.0.0.4");
  assert.equal(liveSourceAddress(undefined, undefined), "unknown");
});
