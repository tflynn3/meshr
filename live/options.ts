import { resolve } from "node:path";
import {
  CODEX_PUBLISH_MODES,
  LIVE_PROVIDERS,
  LIVE_RUNTIMES,
  type CodexPublishMode,
  type LiveMatrixOptions,
  type LiveProvider,
  type LiveRuntime,
} from "./types.ts";

export const LIVE_MATRIX_HELP = `Usage:
  npx tsx scripts/run-live-matrix.ts [options]

Options:
  --dry-run                         Validate readiness and print plans without model calls or posts.
  --runtime <name[,name]>           Run codex, claude, or a comma-separated subset.
  --bindings <runtime=a,b>          Select two connected binding IDs or handles for a runtime.
  --provider <name[,name]>          Add an explicit model-provider rehearsal (ollama).
  --provider-bindings <provider=a,b> Select two bindings for a provider rehearsal.
  --state-dir <path>                Meshr session state directory (default: ~/.meshr/session).
  --server <url>                    Require all selected bindings to use this Meshr server.
  --timeout-ms <ms>                 One-attempt phase timeout (default: 300000; max: 900000).
  --version-timeout-ms <ms>         Runtime version timeout (default: 10000; max: 30000).
  --evidence <path>                 Evidence JSON destination (default: live/evidence/<run>.json).
  --codex-command <path>            Codex executable (default: codex).
  --claude-command <path>           Claude executable (default: claude).
  --ollama-command <path>           Ollama executable (default: ollama).
  --codex-model <name>              Optional Codex model override.
  --codex-publish-mode <mode>       direct-mcp (default) or managed.
  --claude-model <name>             Optional Claude model override.
  --ollama-model <name>             Required for a live Ollama run.
  --ollama-url <url>                Loopback Ollama API (default: http://127.0.0.1:11434).
  --claude-budget-usd <amount>      Maximum per Claude invocation (default: 0.25; max: 2).
  --help                            Show this help.

Each selected target gets one root invocation and one reply invocation. There are no retries.`;

interface RawOption {
  name: string;
  value?: string;
}

function tokenize(values: string[]): RawOption[] {
  const result: RawOption[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index]!;
    if (!raw.startsWith("--"))
      throw new Error(`Unexpected positional argument: ${raw}.`);
    const equal = raw.indexOf("=");
    if (equal > 2) {
      result.push({ name: raw.slice(2, equal), value: raw.slice(equal + 1) });
      continue;
    }
    const name = raw.slice(2);
    if (["dry-run", "help"].includes(name)) {
      result.push({ name });
      continue;
    }
    const next = values[index + 1];
    if (!next || next.startsWith("--"))
      throw new Error(`Missing value for --${name}.`);
    result.push({ name, value: next });
    index += 1;
  }
  return result;
}

function asRuntime(value: string): LiveRuntime {
  if (!LIVE_RUNTIMES.includes(value as LiveRuntime)) {
    throw new Error(`Unsupported live runtime: ${value}. Use --provider for model providers.`);
  }
  return value as LiveRuntime;
}

function asProvider(value: string): LiveProvider {
  if (!LIVE_PROVIDERS.includes(value as LiveProvider)) {
    throw new Error(`Unsupported live provider: ${value}.`);
  }
  return value as LiveProvider;
}

function asCodexPublishMode(value: string): CodexPublishMode {
  if (!CODEX_PUBLISH_MODES.includes(value as CodexPublishMode)) {
    throw new Error(
      `Unsupported Codex publish mode: ${value}. Use direct-mcp or managed.`,
    );
  }
  return value as CodexPublishMode;
}

function boundedInteger(
  value: string,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function boundedNumber(
  value: string,
  name: string,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

export function parseLiveMatrixOptions(
  values: string[],
  cwd = process.cwd(),
): LiveMatrixOptions & { help: boolean } {
  const raw = tokenize(values);
  const known = new Set([
    "dry-run",
    "help",
    "runtime",
    "bindings",
    "provider",
    "provider-bindings",
    "state-dir",
    "server",
    "timeout-ms",
    "version-timeout-ms",
    "evidence",
    "codex-command",
    "claude-command",
    "ollama-command",
    "codex-model",
    "codex-publish-mode",
    "claude-model",
    "ollama-model",
    "ollama-url",
    "claude-budget-usd",
  ]);
  for (const option of raw) {
    if (!known.has(option.name))
      throw new Error(`Unknown option --${option.name}.`);
  }
  const valuesFor = (name: string): string[] =>
    raw
      .filter((item) => item.name === name)
      .flatMap((item) => item.value ?? []);
  const last = (name: string, fallback?: string): string | undefined =>
    valuesFor(name).at(-1) ?? fallback;

  const runtimeValues = valuesFor("runtime").flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const nativeRuntimes = runtimeValues.length
    ? [...new Set(runtimeValues.map(asRuntime))]
    : [...LIVE_RUNTIMES];
  const providers = valuesFor("provider").flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const runtimes = [...new Set<LiveRuntime>([
    ...nativeRuntimes,
    ...providers.map(asProvider),
  ])];

  const bindings: LiveMatrixOptions["bindings"] = {};
  for (const value of valuesFor("bindings")) {
    const equal = value.indexOf("=");
    if (equal <= 0)
      throw new Error("--bindings must use runtime=first,second.");
    const runtime = asRuntime(value.slice(0, equal));
    const selectors = value
      .slice(equal + 1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (selectors.length !== 2) {
      throw new Error(
        `--bindings for ${runtime} must contain exactly two selectors.`,
      );
    }
    bindings[runtime] = selectors as [string, string];
  }
  for (const value of valuesFor("provider-bindings")) {
    const equal = value.indexOf("=");
    if (equal <= 0) {
      throw new Error("--provider-bindings must use provider=first,second.");
    }
    const provider = asProvider(value.slice(0, equal));
    const selectors = value
      .slice(equal + 1)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (selectors.length !== 2) {
      throw new Error(
        `--provider-bindings for ${provider} must contain exactly two selectors.`,
      );
    }
    bindings[provider] = selectors as [string, string];
  }

  const timeout = last("timeout-ms", "300000")!;
  const versionTimeout = last("version-timeout-ms", "10000")!;
  const budget = last("claude-budget-usd", "0.25")!;
  const stateDirectory = last("state-dir");
  const evidencePath = last("evidence");
  const serverUrl = last("server");
  if (serverUrl) new URL(serverUrl);

  return {
    help: raw.some((item) => item.name === "help"),
    projectRoot: resolve(cwd),
    ...(stateDirectory ? { stateDirectory: resolve(cwd, stateDirectory) } : {}),
    ...(serverUrl ? { serverUrl } : {}),
    runtimes,
    bindings,
    dryRun: raw.some((item) => item.name === "dry-run"),
    timeoutMs: boundedInteger(timeout, "timeout-ms", 10_000, 900_000),
    versionTimeoutMs: boundedInteger(
      versionTimeout,
      "version-timeout-ms",
      1_000,
      30_000,
    ),
    ...(evidencePath ? { evidencePath: resolve(cwd, evidencePath) } : {}),
    commands: {
      codex: last("codex-command", "codex")!,
      claude: last("claude-command", "claude")!,
      ollama: last("ollama-command", "ollama")!,
    },
    models: {
      ...(last("codex-model") ? { codex: last("codex-model")! } : {}),
      ...(last("claude-model") ? { claude: last("claude-model")! } : {}),
      ...(last("ollama-model") ? { ollama: last("ollama-model")! } : {}),
    },
    codexPublishMode: asCodexPublishMode(
      last("codex-publish-mode", "direct-mcp")!,
    ),
    ollamaUrl: last("ollama-url", "http://127.0.0.1:11434")!,
    claudeBudgetUsd: boundedNumber(budget, "claude-budget-usd", 0.01, 2),
  };
}
