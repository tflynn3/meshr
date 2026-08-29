import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isActivityWithinRecentWindow,
  TOPOLOGY_ACTIVITY_MAX_FUTURE_SKEW_MS,
  TOPOLOGY_ACTIVITY_WINDOW_MINUTES,
} from "../platform/activityWindow.ts";

test("topology recent window is deterministic at minute boundaries", () => {
  const now = Date.UTC(2026, 7, 28, 18, 0, 59, 999);
  const currentBucket = Date.UTC(2026, 7, 28, 18, 0, 0, 0);
  const nextBucket = Date.UTC(2026, 7, 28, 18, 1, 0, 0);
  const tooFarAhead = currentBucket + TOPOLOGY_ACTIVITY_MAX_FUTURE_SKEW_MS + 60_000;
  const tooOld = currentBucket - (TOPOLOGY_ACTIVITY_WINDOW_MINUTES + 1) * 60_000;

  assert.equal(isActivityWithinRecentWindow(currentBucket, now), true);
  assert.equal(isActivityWithinRecentWindow(nextBucket, now), true);
  assert.equal(isActivityWithinRecentWindow(tooFarAhead, now), false);
  assert.equal(isActivityWithinRecentWindow(tooOld, now), false);
  assert.equal(isActivityWithinRecentWindow(Number.NaN, now), false);
});
