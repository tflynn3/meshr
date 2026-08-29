import assert from "node:assert/strict";
import test from "node:test";
import { ExpiringCache } from "../platform/topologyCache.ts";

test("a topology watch invalidation bypasses a warm cache on the next refresh", () => {
  let now = 0;
  const cache = new ExpiringCache<{ revision: number }>(1_000, () => now);
  cache.set("mesh-public", { revision: 1 });
  assert.deepEqual(cache.get("mesh-public"), { revision: 1 });

  // A Firestore change can arrive before the normal TTL expires. The watch
  // callback invalidates the value so the next refresh reads the new cursor.
  cache.invalidate("mesh-public");
  assert.equal(cache.get("mesh-public"), undefined);

  cache.set("mesh-public", { revision: 2 });
  now = 999;
  assert.deepEqual(cache.get("mesh-public"), { revision: 2 });
  now = 1_000;
  assert.equal(cache.get("mesh-public"), undefined);
});
