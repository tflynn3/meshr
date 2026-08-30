import assert from "node:assert/strict";
import { test } from "node:test";
import { assertSeparatedProductionDatabases } from "../platform/googleClients.ts";

test("production keeps authority and topology Firestore databases separate", () => {
  assert.doesNotThrow(() =>
    assertSeparatedProductionDatabases("(default)", "meshr-projections", "production"),
  );
  assert.throws(
    () => assertSeparatedProductionDatabases("(default)", "(default)", "production"),
    /must be distinct/,
  );
  assert.throws(
    () => assertSeparatedProductionDatabases("", "meshr-projections", "production"),
    /IDs are required/,
  );
  // Local emulator fixtures intentionally share a database by default.
  assert.doesNotThrow(() =>
    assertSeparatedProductionDatabases("(default)", "(default)", "local"),
  );
});
