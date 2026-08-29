import { resolve } from "node:path";
import type { LoadRehearsalOptions } from "./types.ts";

export const LOAD_REHEARSAL_HELP = `Usage:
  npx tsx scripts/run-load-rehearsal.ts --fixture <path> [options]

Options:
  --fixture <path>              Mode-0600 JSON fixture with agent/viewer credentials.
  --role <combined|writer|viewer> Worker role; use one writer plus viewer shards for 500 viewers.
  --run-id <id>                 Shared run id when merging distributed shard evidence.
  --accepted-events <path>      Shared mode-0600 writer event feed for viewer shards.
  --total-agents <n>            Total agent target represented by the writer (default: 100).
  --duration-seconds <n>        Run duration (default: 1800; max: 7200).
  --post-rate <n>               Accepted-post target per second (default: 1; use 100 for launch).
  --viewers <n>                 Viewer connections to open (default: all fixtures).
  --viewer-offset <n>           Zero-based viewer slice offset for a viewer shard (default: 0).
  --total-viewers <n>           Total viewer target across shards (default: --viewers).
  --evidence <path>             Mode-0600 evidence JSON destination.
  --strict-target               Require 100 agents, 500 viewers, 100 posts/s, 1800 seconds plus observed coverage.
  --max-inflight-writes <n>     Write request concurrency cap (default: 512).
  --request-timeout-ms <n>      Per-request timeout (default: 10000; max: 60000).
  --no-reconnect                Do not reconnect viewers after an unexpected close.
  --reconnect-max-delay-ms <n>  Maximum reconnect backoff (default: 5000; max: 30000).
  --dry-run                     Validate the fixture and target without network calls.
  --help                        Show this help.

The runner never prints or stores bearer tokens, cookies, post bodies, or provider
responses. A successful qualification still requires Cloud Monitoring evidence for
Firestore/Pub/Sub usage and an operator review of the redacted output.`;

interface RawOption {
  name: string;
  value?: string;
}

function tokenize(values: string[]): RawOption[] {
  const result: RawOption[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index]!;
    if (!raw.startsWith("--")) throw new Error(`Unexpected positional argument: ${raw}.`);
    const equal = raw.indexOf("=");
    if (equal > 2) {
      result.push({ name: raw.slice(2, equal), value: raw.slice(equal + 1) });
      continue;
    }
    const name = raw.slice(2);
    if (["dry-run", "strict-target", "no-reconnect", "help"].includes(name)) {
      result.push({ name });
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${name}.`);
    result.push({ name, value: next });
    index += 1;
  }
  return result;
}

function boundedInteger(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function parseLoadRehearsalOptions(
  values: string[],
  cwd = process.cwd(),
): LoadRehearsalOptions & { help: boolean } {
  const raw = tokenize(values);
  const known = new Set([
    "fixture",
    "role",
    "run-id",
    "accepted-events",
    "total-agents",
    "duration-seconds",
    "post-rate",
    "viewers",
    "viewer-offset",
    "total-viewers",
    "evidence",
    "strict-target",
    "max-inflight-writes",
    "request-timeout-ms",
    "no-reconnect",
    "reconnect-max-delay-ms",
    "dry-run",
    "help",
  ]);
  for (const option of raw) {
    if (!known.has(option.name)) throw new Error(`Unknown option --${option.name}.`);
  }
  const valuesFor = (name: string): string[] =>
    raw.filter((item) => item.name === name).flatMap((item) => item.value ?? []);
  const last = (name: string): string | undefined => valuesFor(name).at(-1);
  const fixture = last("fixture");
  const help = raw.some((item) => item.name === "help");
  if (!fixture && help) {
    return {
      help: true,
      // Keep the display-only placeholder under the already ignored E2E
      // directory. A real run still requires an explicit --fixture path so a
      // credential-bearing file is never silently read from the repository.
      fixturePath: resolve(cwd, ".meshr-e2e/load-fixture.json"),
      workerRole: "combined",
      totalAgentCount: 100,
      durationSeconds: 1_800,
      postRate: 1,
      viewerCount: 1,
      viewerOffset: 0,
      totalViewerCount: 1,
      strictTarget: false,
      maxInflightWrites: 512,
      requestTimeoutMs: 10_000,
      reconnect: true,
      reconnectMaxDelayMs: 5_000,
      dryRun: false,
    };
  }
  if (!fixture) throw new Error("--fixture is required.");
  const workerRole = last("role") ?? "combined";
  if (workerRole !== "combined" && workerRole !== "writer" && workerRole !== "viewer") {
    throw new Error("--role must be combined, writer, or viewer.");
  }
  const runId = last("run-id");
  if (runId !== undefined && (!runId || runId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(runId))) {
    throw new Error("--run-id must contain only letters, numbers, dot, underscore, colon, or hyphen.");
  }
  const eventFeedPath = last("accepted-events");
  if (eventFeedPath !== undefined && (!eventFeedPath || eventFeedPath.length > 4_096)) {
    throw new Error("--accepted-events path is invalid.");
  }
  const totalAgentCount = boundedInteger(last("total-agents") ?? "100", "total-agents", 1, 2_000);
  const durationSeconds = boundedInteger(
    last("duration-seconds") ?? "1800",
    "duration-seconds",
    1,
    7_200,
  );
  const postRate = boundedInteger(last("post-rate") ?? "1", "post-rate", 1, 500);
  const viewerCount = boundedInteger(last("viewers") ?? (workerRole === "writer" ? "0" : "1"), "viewers", 0, 2_000);
  if (workerRole === "viewer" && viewerCount < 1) throw new Error("--viewers must be at least 1 for a viewer worker.");
  if (workerRole === "combined" && viewerCount < 1) throw new Error("--viewers must be at least 1 for a combined worker.");
  const viewerOffset = boundedInteger(last("viewer-offset") ?? "0", "viewer-offset", 0, 2_000);
  const totalViewerCount = boundedInteger(last("total-viewers") ?? String(Math.max(1, viewerCount)), "total-viewers", 1, 2_000);
  if (viewerOffset + viewerCount > totalViewerCount) {
    throw new Error("--viewer-offset plus --viewers cannot exceed --total-viewers.");
  }
  const maxInflightWrites = boundedInteger(
    last("max-inflight-writes") ?? "512",
    "max-inflight-writes",
    1,
    2_000,
  );
  const requestTimeoutMs = boundedInteger(
    last("request-timeout-ms") ?? "10000",
    "request-timeout-ms",
    500,
    60_000,
  );
  const reconnectMaxDelayMs = boundedInteger(
    last("reconnect-max-delay-ms") ?? "5000",
    "reconnect-max-delay-ms",
    100,
    30_000,
  );
  const evidence = last("evidence");
  return {
    help,
    fixturePath: resolve(cwd, fixture),
    ...(evidence ? { evidencePath: resolve(cwd, evidence) } : {}),
    ...(runId ? { runId } : {}),
    ...(eventFeedPath ? { eventFeedPath: resolve(cwd, eventFeedPath) } : {}),
    workerRole,
    totalAgentCount,
    durationSeconds,
    postRate,
    viewerCount,
    viewerOffset,
    totalViewerCount,
    strictTarget: raw.some((item) => item.name === "strict-target"),
    maxInflightWrites,
    requestTimeoutMs,
    reconnect: !raw.some((item) => item.name === "no-reconnect"),
    reconnectMaxDelayMs,
    dryRun: raw.some((item) => item.name === "dry-run"),
  };
}
