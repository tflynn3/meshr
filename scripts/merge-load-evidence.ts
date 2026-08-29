#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeLoadEvidence } from "../load/rehearsal.ts";
import type {
  HistogramSummary,
  LoadRehearsalEvidence,
} from "../load/types.ts";

const TARGET = {
  agents: 100,
  viewers: 500,
  postRate: 100,
  durationSeconds: 1_800,
} as const;

export const LOAD_EVIDENCE_MERGE_HELP = `Usage:
  npm run load:merge -- --output <path> --input <writer.json> --input <viewer-shard.json> ...

Merge one writer evidence file and non-overlapping viewer-shard evidence files
from a shared --run-id into the 100-agent/500-viewer launch qualification.
Each input must be mode-0600 redacted evidence; credentials are never read.
`;

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function maxNullable(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.max(...present) : null;
}

function mergeHistograms(values: HistogramSummary[]): HistogramSummary {
  return {
    count: values.reduce((sum, value) => sum + value.count, 0),
    // Taking the slowest shard quantile is conservative. Raw samples are not
    // needed in the merged artifact and this cannot turn a failing shard into
    // a passing aggregate.
    p50Ms: maxNullable(values.map((value) => value.p50Ms)),
    p95Ms: maxNullable(values.map((value) => value.p95Ms)),
    p99Ms: maxNullable(values.map((value) => value.p99Ms)),
    maxMs: maxNullable(values.map((value) => value.maxMs)),
  };
}

function addStatusCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + numberOrZero(value);
}

async function readEvidence(path: string): Promise<LoadRehearsalEvidence> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`evidence_must_be_a_file:${path}`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`evidence_permissions_must_be_0600:${path}`);
  }
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents, "utf8") > 8 * 1024 * 1024) throw new Error(`evidence_too_large:${path}`);
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`evidence_json_invalid:${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`evidence_invalid:${path}`);
  const evidence = value as LoadRehearsalEvidence;
  if (evidence.contractVersion !== 1 || !evidence.target || !evidence.observed || !evidence.latencyMs) {
    throw new Error(`evidence_contract_invalid:${path}`);
  }
  return evidence;
}

function validateShardLayout(
  writer: LoadRehearsalEvidence,
  viewers: LoadRehearsalEvidence[],
): void {
  if (writer.target.workerRole !== "writer" || writer.target.viewerCount !== 0) {
    throw new Error("exactly_one_writer_evidence_required");
  }
  if (!viewers.length) throw new Error("viewer_shard_evidence_required");
  const ranges = viewers
    .map((evidence) => ({
      start: evidence.target.viewerOffset,
      end: evidence.target.viewerOffset + evidence.target.viewerCount,
      count: evidence.target.viewerCount,
      evidence,
    }))
    .sort((left, right) => left.start - right.start);
  let cursor = 0;
  for (const range of ranges) {
    if (range.count < 1 || range.start !== cursor) throw new Error("viewer_shards_must_cover_contiguous_non_overlapping_range");
    if (range.evidence.observed.writeAttempts !== 0 || range.evidence.observed.acceptedPosts !== 0) {
      throw new Error("viewer_shard_must_not_publish");
    }
    cursor = range.end;
  }
  if (cursor !== TARGET.viewers) throw new Error("viewer_shards_must_cover_500_viewers");
}

export async function mergeLoadEvidence(
  paths: string[],
  expectedRunId?: string,
): Promise<LoadRehearsalEvidence> {
  if (!paths.length) throw new Error("evidence_inputs_required");
  const inputs = await Promise.all(paths.map(readEvidence));
  const runId = inputs[0]!.runId;
  if (!runId || (expectedRunId && runId !== expectedRunId)) throw new Error("run_id_mismatch");
  if (inputs.some((evidence) => evidence.runId !== runId)) throw new Error("run_id_mismatch");
  if (inputs.some((evidence) => evidence.target.totalViewerCount !== TARGET.viewers)) {
    throw new Error("target_viewer_count_must_be_500");
  }
  if (inputs.some((evidence) => evidence.target.totalAgentCount !== TARGET.agents)) {
    throw new Error("target_agent_count_must_be_100");
  }
  if (inputs.some((evidence) => evidence.target.postRatePerSecond !== TARGET.postRate)) throw new Error("target_post_rate_must_be_100");
  if (inputs.some((evidence) => evidence.target.durationSeconds !== TARGET.durationSeconds)) throw new Error("target_duration_must_be_1800");
  if (inputs.some((evidence) => !evidence.gates.strictTarget)) throw new Error("strict_target_evidence_required");
  const writers = inputs.filter((evidence) => evidence.target.workerRole === "writer");
  const viewers = inputs.filter((evidence) => evidence.target.workerRole === "viewer");
  if (writers.length !== 1 || writers[0] === undefined) throw new Error("exactly_one_writer_evidence_required");
  validateShardLayout(writers[0], viewers);
  const writer = writers[0];
  if (writer.target.agentCount !== TARGET.agents) throw new Error("writer_must_include_100_agents");
  if (viewers.some((evidence) => evidence.target.agentCount !== 0)) {
    throw new Error("viewer_shards_must_not_include_agent_credentials");
  }
  const all = [writer, ...viewers];
  const intervals = all.map((evidence) => {
    const started = Date.parse(evidence.startedAt);
    const finished = Date.parse(evidence.finishedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
      throw new Error("evidence_time_window_invalid");
    }
    return { started, finished };
  });
  const overlapStart = Math.max(...intervals.map((interval) => interval.started));
  const overlapEnd = Math.min(...intervals.map((interval) => interval.finished));
  if (overlapEnd - overlapStart < TARGET.durationSeconds * 1_000 * 0.99) {
    throw new Error("evidence_time_windows_must_overlap_for_99_percent_of_run");
  }
  const clockOffsets = all.map((evidence) => evidence.observed.clockOffsetMs);
  const clockSkewBelow1s = clockOffsets.every((offset) =>
    typeof offset === "number" && Number.isFinite(offset) && Math.abs(offset) <= 1_000,
  );
  const statusCounts: Record<string, number> = {};
  for (const evidence of all) addStatusCounts(statusCounts, evidence.observed.statusCounts);
  const writerDuration = numberOrZero(writer.observed.runDurationSeconds);
  const runDurationSeconds = Math.min(...all.map((evidence) => numberOrZero(evidence.observed.runDurationSeconds)));
  const acceptedPosts = numberOrZero(writer.observed.acceptedPosts);
  const writeAttempts = numberOrZero(writer.observed.writeAttempts);
  const writeErrors = numberOrZero(writer.observed.writeErrors);
  const acceptedTarget = Math.max(1, Math.floor(TARGET.postRate * TARGET.durationSeconds * 0.99));
  const achievedRate = acceptedPosts / Math.max(writerDuration, 0.001);
  const latencyMs = {
    writes: writer.latencyMs.writes,
    topologyUpdates: mergeHistograms(viewers.map((evidence) => evidence.latencyMs.topologyUpdates)),
    reconnectRecovery: mergeHistograms(viewers.map((evidence) => evidence.latencyMs.reconnectRecovery)),
  };
  const viewerPostUpdateBuckets: Record<string, number[]> = {};
  for (const evidence of viewers) {
    const raw = evidence.observed.viewerPostUpdateBuckets;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const start = evidence.target.viewerOffset;
    const end = start + evidence.target.viewerCount;
    for (const [rawViewerIndex, rawBuckets] of Object.entries(raw)) {
      const viewerIndex = Number(rawViewerIndex);
      if (!Number.isSafeInteger(viewerIndex) || viewerIndex < start || viewerIndex >= end) {
        throw new Error("viewer_update_buckets_outside_shard");
      }
      if (!Array.isArray(rawBuckets)) continue;
      viewerPostUpdateBuckets[String(viewerIndex)] = [...new Set(rawBuckets.filter((bucket): bucket is number => Number.isSafeInteger(bucket)))]
        .sort((left, right) => left - right);
    }
  }
  const observed = {
    writeAttempts,
    acceptedPosts,
    writeErrors,
    achievedPostRatePerSecond: achievedRate,
    runDurationSeconds,
    statusCounts,
    sessionHeartbeats: numberOrZero(writer.observed.sessionHeartbeats),
    sessionRenewals: numberOrZero(writer.observed.sessionRenewals),
    sessionErrors: numberOrZero(writer.observed.sessionErrors),
    viewerConnectAttempts: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerConnectAttempts), 0),
    viewerConnections: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerConnections), 0),
    viewerInitialConnections: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerInitialConnections), 0),
    viewerConnectionErrors: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerConnectionErrors), 0),
    viewerFrames: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerFrames), 0),
    viewerSnapshotReceipts: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerSnapshotReceipts), 0),
    viewerTopologyObservations: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerTopologyObservations), 0),
    topologyLatencyObservations: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.topologyLatencyObservations), 0),
    viewerPostUpdateReceipts: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerPostUpdateReceipts), 0),
    viewerPostUpdateBuckets,
    viewerProcessingErrors: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerProcessingErrors), 0),
    reconnectAttempts: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.reconnectAttempts), 0),
    reconnects: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.reconnects), 0),
    viewerReconnectReceipts: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.viewerReconnectReceipts), 0),
    reconnectErrors: viewers.reduce((sum, evidence) => sum + numberOrZero(evidence.observed.reconnectErrors), 0),
    clockOffsetMs: clockOffsets.length
      ? clockOffsets.reduce(
        (max, offset) => typeof offset === "number" && Math.abs(offset) > Math.abs(max ?? 0) ? offset : max,
        null as number | null,
      )
      : null,
  };
  const writerWriteErrorRateBelow1Percent = writeErrors / Math.max(1, writeAttempts) < 0.01;
  const viewerConnectionErrorRateBelow1Percent = observed.viewerConnectionErrors /
    Math.max(1, observed.viewerConnectAttempts) < 0.01;
  const viewerProcessingErrorRateBelow1Percent = observed.viewerProcessingErrors /
    Math.max(1, observed.viewerFrames) < 0.01;
  const requiredTopologyBuckets = Math.max(1, Math.ceil(TARGET.durationSeconds / 60 * 0.99));
  const topologyTemporalCoveragePassed = Array.from({ length: TARGET.viewers }, (_, viewerIndex) => viewerIndex)
    .every((viewerIndex) => {
      const buckets = observed.viewerPostUpdateBuckets[String(viewerIndex)] ?? [];
      return Array.from({ length: requiredTopologyBuckets }, (_, bucket) => bucket)
        .every((requiredBucket) => buckets.includes(requiredBucket));
    });
  const gates = {
    strictTarget: true,
    targetShapePassed: true,
    achievedPostRatePassed: acceptedPosts >= acceptedTarget && achievedRate >= TARGET.postRate * 0.99,
    durationPassed: runDurationSeconds >= TARGET.durationSeconds * 0.99,
    viewerCoveragePassed: observed.viewerInitialConnections >= TARGET.viewers &&
      observed.viewerSnapshotReceipts >= TARGET.viewers &&
      observed.viewerPostUpdateReceipts >= TARGET.viewers,
    topologyTemporalCoveragePassed,
    sessionContinuityPassed: all.every((evidence) => evidence.gates.sessionContinuityPassed),
    writeP95Below750Ms: latencyMs.writes.p95Ms !== null && latencyMs.writes.p95Ms < 750,
    topologyP95Below2s: latencyMs.topologyUpdates.p95Ms !== null && latencyMs.topologyUpdates.p95Ms < 2_000,
    reconnectP95Below5s: observed.viewerReconnectReceipts >= TARGET.viewers &&
      latencyMs.reconnectRecovery.p95Ms !== null && latencyMs.reconnectRecovery.p95Ms < 5_000,
    unexpectedErrorRateBelow1Percent: writerWriteErrorRateBelow1Percent &&
      viewerConnectionErrorRateBelow1Percent && viewerProcessingErrorRateBelow1Percent,
    clockSkewBelow1s,
    qualified: false,
  };
  gates.qualified = gates.strictTarget && gates.targetShapePassed && gates.achievedPostRatePassed &&
    gates.durationPassed && gates.viewerCoveragePassed && gates.topologyTemporalCoveragePassed && gates.sessionContinuityPassed &&
    gates.writeP95Below750Ms && gates.topologyP95Below2s && gates.reconnectP95Below5s &&
    gates.unexpectedErrorRateBelow1Percent && gates.clockSkewBelow1s;
  return {
    contractVersion: 1,
    runId,
    fixturePath: "distributed-evidence",
    startedAt: new Date(Math.min(...all.map((evidence) => Date.parse(evidence.startedAt) || Date.now()))).toISOString(),
    finishedAt: new Date(Math.max(...all.map((evidence) => Date.parse(evidence.finishedAt) || Date.now()))).toISOString(),
    target: {
      agentCount: TARGET.agents,
      totalAgentCount: TARGET.agents,
      viewerCount: TARGET.viewers,
      viewerOffset: 0,
      totalViewerCount: TARGET.viewers,
      workerRole: "distributed",
      postRatePerSecond: TARGET.postRate,
      durationSeconds: TARGET.durationSeconds,
    },
    observed,
    latencyMs,
    gates,
    limitations: [
      "distributed evidence merges one writer and contiguous viewer shards; each shard must use the same run id and distinct source egress",
      "merged shard quantiles use the slowest shard quantile as a conservative bound rather than reconstructing raw samples",
      "each worker measures its clock against the target HTTP Date header; offsets over one second fail the merged gate",
      "strict qualification requires correlated post-driven updates in every minute bucket; frame and feed processing errors are kept separate from connection errors",
      "Firestore/Pub/Sub usage, egress, logging, and billing-export evidence must still be captured from Cloud Monitoring",
    ],
  };
}

function parseArgs(values: string[]): { output: string; inputs: string[]; runId?: string; help: boolean } {
  let output = "";
  let runId: string | undefined;
  const inputs: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--help") return { output, inputs, runId, help: true };
    const next = values[index + 1];
    if (value === "--output" || value === "--input" || value === "--run-id") {
      if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
      if (value === "--output") output = next;
      else if (value === "--input") inputs.push(next);
      else runId = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument ${value}`);
  }
  if (!output) throw new Error("--output is required");
  if (!inputs.length) throw new Error("--input is required");
  return { output, inputs, runId, help: false };
}

export async function main(values = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(values);
  if (args.help) {
    process.stdout.write(LOAD_EVIDENCE_MERGE_HELP);
    return;
  }
  const evidence = await mergeLoadEvidence(args.inputs, args.runId);
  const path = await writeLoadEvidence(evidence, resolve(args.output));
  process.stdout.write(`${JSON.stringify({
    runId: evidence.runId,
    outcome: evidence.gates.qualified ? "qualified" : "not-qualified",
    evidencePath: path,
    gates: evidence.gates,
    observed: evidence.observed,
    latencyMs: evidence.latencyMs,
  }, null, 2)}\n`);
  if (!evidence.gates.qualified) process.exitCode = 1;
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
