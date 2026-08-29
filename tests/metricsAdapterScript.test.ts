import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const scriptPath = join(process.cwd(), "scripts", "check-gke-metrics-adapter.sh");

function runAdapterCheck(metricResponse: string, hpaStatus: string): { status: number; output: string } {
  const directory = mkdtempSync(join(tmpdir(), "meshr-metrics-adapter-test-"));
  try {
    const kubectl = join(directory, "kubectl");
    writeFileSync(kubectl, `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *"/namespaces/"* ]]; then
  printf '%s\\n' "$FAKE_METRIC_RESPONSE"
  exit 0
fi
if [[ "$args" == *"-o jsonpath="* ]]; then
  printf '%s\\n' 'External=pubsub.googleapis.com|subscription|num_undelivered_messages'
  exit 0
fi
if [[ "$args" == *"-o json"* ]]; then
  printf '%s\\n' "$FAKE_HPA_STATUS"
  exit 0
fi
if [[ "$args" == *"--raw"* ]]; then
  printf '%s\\n' '{}'
  exit 0
fi
exit 0
`);
    chmodSync(kubectl, 0o755);
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ""}`,
      FAKE_METRIC_RESPONSE: metricResponse,
      FAKE_HPA_STATUS: hpaStatus,
      METRICS_ADAPTER_CHECK_ATTEMPTS: "1",
      METRICS_ADAPTER_CHECK_INTERVAL_SECONDS: "0",
    };
    try {
      const output = execFileSync(
        "bash",
        [scriptPath, "test-ns", "test-hpa", "subscription-1"],
        { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { status: 0, output };
    } catch (error) {
      const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
      return {
        status: failure.status ?? 1,
        output: `${failure.stdout?.toString() ?? ""}${failure.stderr?.toString() ?? ""}`,
      };
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const validHpaStatus = JSON.stringify({
  status: {
    conditions: [{ type: "ScalingActive", status: "True" }],
    currentMetrics: [{
      type: "External",
      external: {
        metric: { name: "pubsub.googleapis.com|subscription|num_undelivered_messages" },
        current: { value: "1" },
      },
    }],
  },
});

test("metrics adapter check rejects an empty external metric response", () => {
  const result = runAdapterCheck(JSON.stringify({ items: [] }), validHpaStatus);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /not actively consuming/);
});

test("metrics adapter check requires the HPA status to use the external metric", () => {
  const result = runAdapterCheck(
    JSON.stringify({
      items: [{
        metricLabels: { "resource.labels.subscription_id": "subscription-1" },
        value: "1",
      }],
    }),
    JSON.stringify({
      status: {
        conditions: [{ type: "ScalingActive", status: "True" }],
        currentMetrics: [{ type: "Resource", resource: { name: "cpu", current: { averageUtilization: 10 } } }],
      },
    }),
  );
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /not actively consuming/);
});

test("metrics adapter check accepts a labelled external metric in HPA status", () => {
  const result = runAdapterCheck(
    JSON.stringify({
      items: [{
        metricLabels: { "resource.labels.subscription_id": "subscription-1" },
        value: "1",
      }],
    }),
    validHpaStatus,
  );
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /GKE external metric ready/);
});
