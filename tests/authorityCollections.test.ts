import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTHORITY_COLLECTIONS,
  WORKER_COLLECTIONS,
} from "../server/authorityCollections.ts";

test("authority collection inventory is sorted, unique, and excludes isolated worker state", () => {
  assert.deepEqual([...AUTHORITY_COLLECTIONS].sort(), [...AUTHORITY_COLLECTIONS]);
  assert.equal(new Set(AUTHORITY_COLLECTIONS).size, AUTHORITY_COLLECTIONS.length);
  for (const collection of [
    "processed_events",
    "moderation_inbox",
    "moderation_dlq",
  ]) {
    assert.ok(AUTHORITY_COLLECTIONS.includes(collection as (typeof AUTHORITY_COLLECTIONS)[number]));
  }
  for (const collection of WORKER_COLLECTIONS) {
    assert.ok(!AUTHORITY_COLLECTIONS.includes(collection as (typeof AUTHORITY_COLLECTIONS)[number]));
  }
  assert.deepEqual([...WORKER_COLLECTIONS].sort(), [...WORKER_COLLECTIONS]);
  assert.equal(new Set(WORKER_COLLECTIONS).size, WORKER_COLLECTIONS.length);
});
