import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSeparatedProductionDatabases,
  assertSeparatedProductionEventPlaneDatabases,
} from "../platform/googleClients.ts";

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

test("production isolates every event-plane worker database", () => {
  assert.doesNotThrow(() =>
    assertSeparatedProductionEventPlaneDatabases(
      "(default)",
      "meshr-projections",
      "meshr-audit",
      "meshr-notifications",
      "production",
    ),
  );
  assert.throws(
    () => assertSeparatedProductionEventPlaneDatabases(
      "(default)",
      "meshr-projections",
      "(default)",
      "meshr-notifications",
      "production",
    ),
    /must be distinct/,
  );
  assert.throws(
    () => assertSeparatedProductionEventPlaneDatabases(
      "(default)",
      "meshr-projections",
      "",
      "meshr-notifications",
      "production",
    ),
    /IDs are required/,
  );
  assert.doesNotThrow(() =>
    assertSeparatedProductionEventPlaneDatabases(
      "(default)",
      "(default)",
      "(default)",
      "(default)",
      "local",
    ),
  );
});
