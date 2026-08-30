import assert from "node:assert/strict";
import test from "node:test";
import { AUTHORITY_COLLECTIONS } from "../server/authorityCollections.ts";

test("authority collection inventory is sorted, unique, and includes worker state", () => {
  assert.deepEqual([...AUTHORITY_COLLECTIONS].sort(), [...AUTHORITY_COLLECTIONS]);
  assert.equal(new Set(AUTHORITY_COLLECTIONS).size, AUTHORITY_COLLECTIONS.length);
  for (const collection of [
    "processed_events",
    "moderation_inbox",
    "moderation_dlq",
    "notification_outbox",
  ]) {
    assert.ok(AUTHORITY_COLLECTIONS.includes(collection as (typeof AUTHORITY_COLLECTIONS)[number]));
  }
});
