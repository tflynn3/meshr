import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseLoadRehearsalOptions } from "../load/options.ts";
import {
  readLoadFixture,
  runLoadRehearsal,
  summarizeHistogram,
} from "../load/rehearsal.ts";
import type { LoadFixture, LoadRehearsalOptions } from "../load/types.ts";

const fixture: LoadFixture = {
  contractVersion: 1,
  baseUrl: "http://127.0.0.1:8787",
  meshId: "mesh-public",
  topicId: "topic-public",
  agents: [
    { agentId: "agent-one", token: "Bearer token-one" },
    { agentId: "agent-two", token: "Bearer token-two" },
  ],
  viewers: [
    { cookie: "meshr_session=session-one" },
    { cookie: "meshr_session=session-two" },
  ],
};

const options = (overrides: Partial<LoadRehearsalOptions> = {}): LoadRehearsalOptions => ({
  fixturePath: "/tmp/meshr-load-fixture.json",
  workerRole: "combined",
  durationSeconds: 1,
  postRate: 1,
  viewerCount: 1,
  viewerOffset: 0,
  totalViewerCount: 1,
  strictTarget: false,
  maxInflightWrites: 1,
  requestTimeoutMs: 500,
  reconnect: true,
  reconnectMaxDelayMs: 100,
  dryRun: false,
  ...overrides,
});

test("load options expose help without requiring a credential fixture", () => {
  const parsed = parseLoadRehearsalOptions(["--help"]);
  assert.equal(parsed.help, true);
  assert.equal(parsed.durationSeconds, 1_800);
  assert.equal(parsed.totalAgentCount, 100);
});

test("load options keep distributed agent target separate from local viewer shards", () => {
  const parsed = parseLoadRehearsalOptions([
    "--fixture", "/secure/viewer.json",
    "--role", "viewer",
    "--viewers", "100",
    "--viewer-offset", "400",
    "--total-viewers", "500",
    "--total-agents", "100",
  ]);
  assert.equal(parsed.workerRole, "viewer");
  assert.equal(parsed.viewerOffset, 400);
  assert.equal(parsed.viewerCount, 100);
  assert.equal(parsed.totalAgentCount, 100);
});

test("load histogram is stable for large samples", () => {
  const values = Array.from({ length: 200_000 }, (_, index) => index % 101);
  const histogram = summarizeHistogram(values);
  assert.equal(histogram.count, 200_000);
  assert.equal(histogram.p50Ms, 50);
  assert.equal(histogram.p95Ms, 95);
  assert.equal(histogram.maxMs, 100);
});

test("load fixtures require restrictive permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-load-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture.json");
  await writeFile(path, `${JSON.stringify(fixture)}\n`, { mode: 0o600 });
  await chmod(path, 0o644);
  await assert.rejects(readLoadFixture(path), /fixture_permissions_must_be_0600/);
  await chmod(path, 0o600);
  assert.deepEqual(await readLoadFixture(path), fixture);
});

test("load fixtures reject client-supplied proxy identity fields", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-load-fixture-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "fixture.json");
  await writeFile(path, `${JSON.stringify({
    ...fixture,
    viewers: [{ ...fixture.viewers[0], forwardedFor: "198.51.100.10" }],
  })}\n`, { mode: 0o600 });
  await assert.rejects(readLoadFixture(path), /viewer_0_forwardedFor_unsupported/);
});

test("long rehearsals fail closed without signed renewal material", async () => {
  await assert.rejects(
    runLoadRehearsal(options({ durationSeconds: 901 }), fixture),
    /long_rehearsal_requires_signed_renewal_credentials/,
  );
});

test("dry-run records that runtime gates still need live evidence", async () => {
  const evidence = await runLoadRehearsal(options({ dryRun: true }), fixture);
  assert.equal(evidence.observed.writeAttempts, 0);
  assert.equal(evidence.gates.qualified, false);
  assert.equal(evidence.gates.viewerCoveragePassed, false);
  assert.ok(evidence.limitations.some((entry) => entry.includes("no API or live-gateway request")));
});
