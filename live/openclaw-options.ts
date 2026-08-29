import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OpenClawLiveOptions } from "./openclaw-types.ts";

export const OPENCLAW_LIVE_HELP = `Usage:
  npx tsx scripts/run-openclaw-live.ts [options]

Options:
  --dry-run                         Validate paths, plugin wiring, bindings, identities, and plans without model calls or posts.
  --agents <root,reply>             Two distinct OpenClaw agent IDs (required).
  --bindings <root,reply>           Optional Meshr binding selectors; defaults to exact openclaw:<agent-id> matches.
  --openclaw-command <path>         OpenClaw executable (default: openclaw).
  --openclaw-state-dir <path>       OpenClaw state directory (default: ~/.openclaw).
  --openclaw-config <path>          OpenClaw config file (default: <state-dir>/openclaw.json).
  --state-file <path>               Meshr session state file (default: ~/.meshr/session/state.json).
  --connector-state <path>          Deprecated compatibility alias for --state-file.
  --server <url>                    Require both bindings and the plugin to use this Meshr server.
  --model <provider/model>          Optional OpenClaw model override for both one-attempt turns.
  --timeout-ms <ms>                 Outer timeout for each agent process (default: 180000; max: 900000).
  --version-timeout-ms <ms>         OpenClaw version timeout (default: 10000; max: 30000).
  --evidence <path>                 Evidence destination (default: live/evidence/openclaw-<run>.json).
  --help                            Show this help.

The live path starts exactly one root turn and, after server verification, exactly one reply turn. It never retries a model call.`;

interface RawOption {
  name: string;
  value?: string;
}

function tokenize(values: string[]): RawOption[] {
  const result: RawOption[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index]!;
    if (!raw.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${raw}.`);
    }
    const equal = raw.indexOf("=");
    if (equal > 2) {
      result.push({ name: raw.slice(2, equal), value: raw.slice(equal + 1) });
      continue;
    }
    const name = raw.slice(2);
    if (name === "dry-run" || name === "help") {
      result.push({ name });
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${name}.`);
    }
    result.push({ name, value: next });
    index += 1;
  }
  return result;
}

function pair(value: string | undefined, name: string): [string, string] {
  if (!value) throw new Error(`--${name} is required.`);
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length !== 2) {
    throw new Error(`--${name} must contain exactly two comma-separated values.`);
  }
  if (values[0] === values[1]) {
    throw new Error(`--${name} must contain two distinct values.`);
  }
  return values as [string, string];
}

function boundedInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `--${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}

export function parseOpenClawLiveOptions(
  values: string[],
  cwd = process.cwd(),
): OpenClawLiveOptions & { help: boolean } {
  const raw = tokenize(values);
  const known = new Set([
    "dry-run",
    "help",
    "agents",
    "bindings",
    "openclaw-command",
    "openclaw-state-dir",
    "openclaw-config",
    "state-file",
    "connector-state",
    "server",
    "model",
    "timeout-ms",
    "version-timeout-ms",
    "evidence",
  ]);
  for (const option of raw) {
    if (!known.has(option.name)) {
      throw new Error(`Unknown option --${option.name}.`);
    }
  }
  const valuesFor = (name: string): string[] =>
    raw
      .filter((item) => item.name === name)
      .flatMap((item) => item.value ?? []);
  const last = (name: string, fallback?: string): string | undefined =>
    valuesFor(name).at(-1) ?? fallback;
  const help = raw.some((item) => item.name === "help");

  const openClawStateDirectory = resolve(
    cwd,
    last("openclaw-state-dir", join(homedir(), ".openclaw"))!,
  );
  const openClawConfigPath = resolve(
    cwd,
    last("openclaw-config", join(openClawStateDirectory, "openclaw.json"))!,
  );
  const stateFile = resolve(
    cwd,
    last(
      "state-file",
      last("connector-state", join(homedir(), ".meshr", "session", "state.json")),
    )!,
  );
  const serverUrl = last("server");
  if (serverUrl) {
    const parsed = new URL(serverUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("--server must use http or https.");
    }
  }
  const bindingValue = last("bindings");
  const evidencePath = last("evidence");
  const model = last("model");

  return {
    help,
    projectRoot: resolve(cwd),
    dryRun: raw.some((item) => item.name === "dry-run"),
    agentIds: help ? ["<root>", "<reply>"] : pair(last("agents"), "agents"),
    ...(bindingValue
      ? { bindingSelectors: pair(bindingValue, "bindings") }
      : {}),
    openClawCommand: last("openclaw-command", "openclaw")!,
    openClawStateDirectory,
    openClawConfigPath,
    connectorStatePath: stateFile,
    ...(serverUrl ? { serverUrl } : {}),
    ...(model ? { model } : {}),
    timeoutMs: boundedInteger(
      last("timeout-ms", "180000")!,
      "timeout-ms",
      10_000,
      900_000,
    ),
    versionTimeoutMs: boundedInteger(
      last("version-timeout-ms", "10000")!,
      "version-timeout-ms",
      1_000,
      30_000,
    ),
    ...(evidencePath ? { evidencePath: resolve(cwd, evidencePath) } : {}),
  };
}
