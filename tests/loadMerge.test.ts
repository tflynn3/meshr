import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeLoadEvidence } from "../scripts/merge-load-evidence.ts";
import type { LoadRehearsalEvidence } from "../load/types.ts";

const runId = "merge-test-run";
const startedAt = "2026-08-28T00:00:00.000Z";
const finishedAt = "2026-08-28T00:30:00.000Z";

function histogram() {
  return { count: 10, p50Ms: 10, p95Ms: 20, p99Ms: 30, maxMs: 40 };
}

function evidence(role: "writer" | "viewer", viewerOffset = 0): LoadRehearsalEvidence {
  const viewerCount = role === "writer" ? 0 : 100;
  return {
    contractVersion: 1,
    runId,
    fixturePath: `${role}-fixture.json`,
    startedAt,
    finishedAt,
    target: {
      agentCount: role === "writer" ? 100 : 0,
      totalAgentCount: 100,
      viewerCount,
      viewerOffset,
      totalViewerCount: 500,
      workerRole: role,
      postRatePerSecond: 100,
      durationSeconds: 1_800,
    },
    observed: {
      writeAttempts: role === "writer" ? 180_000 : 0,
      acceptedPosts: role === "writer" ? 180_000 : 0,
      writeErrors: 0,
      achievedPostRatePerSecond: role === "writer" ? 100 : 0,
      runDurationSeconds: 1_800,
      statusCounts: {},
      sessionHeartbeats: role === "writer" ? 6_000 : 0,
      sessionRenewals: role === "writer" ? 100 : 0,
      sessionErrors: 0,
      viewerConnectAttempts: role === "viewer" ? 100 : 0,
      viewerConnections: role === "viewer" ? 100 : 0,
      viewerInitialConnections: role === "viewer" ? 100 : 0,
      viewerConnectionErrors: 0,
      viewerFrames: role === "viewer" ? 1_000 : 0,
      viewerSnapshotReceipts: role === "viewer" ? 100 : 0,
      viewerTopologyObservations: role === "viewer" ? 100 : 0,
      topologyLatencyObservations: role === "viewer" ? 100 : 0,
      viewerPostUpdateReceipts: role === "viewer" ? 100 : 0,
      viewerPostUpdateBuckets: role === "viewer"
        ? Object.fromEntries(
          Array.from({ length: 100 }, (_, index) => [
            String(viewerOffset + index),
            Array.from({ length: 30 }, (_, bucket) => bucket),
          ]),
        )
        : {},
      viewerProcessingErrors: 0,
      reconnectAttempts: role === "viewer" ? 100 : 0,
      reconnects: role === "viewer" ? 100 : 0,
      viewerReconnectReceipts: role === "viewer" ? 100 : 0,
      reconnectErrors: 0,
      clockOffsetMs: 0,
    },
    latencyMs: {
      writes: histogram(),
      topologyUpdates: histogram(),
      reconnectRecovery: histogram(),
    },
    gates: {
      strictTarget: true,
      targetShapePassed: true,
      achievedPostRatePassed: true,
      durationPassed: true,
      viewerCoveragePassed: role === "viewer",
      topologyTemporalCoveragePassed: role === "viewer",
      sessionContinuityPassed: true,
      writeP95Below750Ms: true,
      topologyP95Below2s: role === "viewer",
      reconnectP95Below5s: role === "viewer",
      unexpectedErrorRateBelow1Percent: true,
      clockSkewBelow1s: true,
      qualified: role === "writer",
    },
    limitations: [],
  };
}

async function writeEvidence(directory: string, name: string, value: LoadRehearsalEvidence): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

test("distributed load evidence merges role-scoped fixtures and qualifies only with full coverage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-load-merge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = [await writeEvidence(directory, "writer.json", evidence("writer"))];
  for (let offset = 0; offset < 500; offset += 100) {
    paths.push(await writeEvidence(directory, `viewer-${offset}.json`, evidence("viewer", offset)));
  }
  const merged = await mergeLoadEvidence(paths, runId);
  assert.equal(merged.gates.qualified, true);
  assert.equal(merged.observed.viewerInitialConnections, 500);
  assert.equal(merged.target.workerRole, "distributed");
});

test("distributed load evidence rejects viewer windows that do not overlap the writer run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-load-merge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writer = evidence("writer");
  const paths = [await writeEvidence(directory, "writer.json", writer)];
  for (let offset = 0; offset < 500; offset += 100) {
    const viewer = evidence("viewer", offset);
    if (offset === 0) {
      viewer.startedAt = "2026-08-28T01:00:00.000Z";
      viewer.finishedAt = "2026-08-28T01:30:00.000Z";
    }
    paths.push(await writeEvidence(directory, `viewer-${offset}.json`, viewer));
  }
  await assert.rejects(mergeLoadEvidence(paths), /evidence_time_windows_must_overlap/);
});
