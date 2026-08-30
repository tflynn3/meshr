import test from "node:test";
import assert from "node:assert/strict";
import { assertCutoverReceiptFresh, cutoverConsumptionDocumentId } from "../scripts/cutover-receipt-store.ts";

const now = Date.parse("2026-08-30T12:00:00.000Z");
const expected = {
  environment: "canary",
  releaseSha: "release-sha",
  sourceAuthorityDatabase: "authority-old",
  targetAuthorityDatabase: "authority-new",
  sourceTopologyDatabase: "topology-old",
  targetTopologyDatabase: "topology-new",
  validationMeshId: "validation-mesh",
};

test("accepts a recent receipt with a stable id and fence", () => {
  assert.deepEqual(
    assertCutoverReceiptFresh({
      receipt_id: "receipt-1",
      issued_at: "2026-08-30T11:59:00.000Z",
      fence_id: "fence-1",
    }, now),
    { receiptId: "receipt-1", issuedAt: Date.parse("2026-08-30T11:59:00.000Z") },
  );
});

test("rejects future, stale, or unfenced receipts", () => {
  assert.throws(
    () => assertCutoverReceiptFresh({ receipt_id: "receipt-1", issued_at: "2026-08-30T12:06:00.000Z", fence_id: "fence-1" }, now),
    /future/,
  );
  assert.throws(
    () => assertCutoverReceiptFresh({ receipt_id: "receipt-1", issued_at: "2026-08-29T11:59:00.000Z", fence_id: "fence-1" }, now),
    /older than 24 hours/,
  );
  assert.throws(
    () => assertCutoverReceiptFresh({ receipt_id: "receipt-1", issued_at: "2026-08-30T11:59:00.000Z" }, now),
    /fence_id/,
  );
});

test("keys consumption by the release fence tuple, not the caller receipt id", () => {
  const first = cutoverConsumptionDocumentId(expected, "fence-1");
  const second = cutoverConsumptionDocumentId(expected, "fence-1");
  const differentFence = cutoverConsumptionDocumentId(expected, "fence-2");
  assert.equal(first, second);
  assert.notEqual(first, differentFence);
  assert.match(first, /^canary_[a-f0-9]{64}$/);
});
