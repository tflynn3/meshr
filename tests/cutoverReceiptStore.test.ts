import test from "node:test";
import assert from "node:assert/strict";
import { assertCutoverReceiptFresh } from "../scripts/cutover-receipt-store.ts";

const now = Date.parse("2026-08-30T12:00:00.000Z");

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
