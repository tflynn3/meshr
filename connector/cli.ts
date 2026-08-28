#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MeshrApi } from "./api";
import { diagnoseConnectorBindings } from "./diagnostics";
import { loadAgentDefinition } from "./definition";
import { serveBindingFromState, publicBindingState } from "./mcp";
import { configureOpenClawBinding } from "./openclaw";
import { beginPairing, claimPairing, refreshPairing } from "./pairing";
import { syncBindingDefinition } from "./profileSync";
import { ConnectorStateStore, assertPrivateStatePath } from "./state";
import { createRemoteAgentTools } from "./tools";
import type { ConnectorRuntime } from "./types";

interface ParsedArguments {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

function parseArguments(values: string[]): ParsedArguments {
  const [command = "help", ...rest] = values;
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [rawName, inline] = value.slice(2).split("=", 2);
    if (!rawName) throw new Error("Invalid empty flag.");
    if (inline !== undefined) {
      flags.set(rawName, inline);
      continue;
    }
    const next = rest[index + 1];
    if (next && !next.startsWith("--")) {
      flags.set(rawName, next);
      index += 1;
    } else {
      flags.set(rawName, true);
    }
  }
  return { command, positionals, flags };
}

function flag(args: ParsedArguments, name: string, fallback?: string): string {
  const value = args.flags.get(name) ?? fallback;
  if (value === undefined || value === true || !String(value).trim()) {
    throw new Error(`Missing required --${name}.`);
  }
  return String(value);
}

function optionalFlag(args: ParsedArguments, name: string): string | undefined {
  const value = args.flags.get(name);
  return value === undefined || value === true ? undefined : String(value);
}

function runtime(value: string): ConnectorRuntime {
  if (!["codex", "claude", "openclaw", "ollama"].includes(value)) {
    throw new Error("--runtime must be codex, claude, openclaw, or ollama.");
  }
  return value as ConnectorRuntime;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function storeFor(args: ParsedArguments): ConnectorStateStore {
  const directory = optionalFlag(args, "state-dir");
  if (directory) assertPrivateStatePath(resolve(directory));
  return new ConnectorStateStore(directory);
}

async function connect(args: ParsedArguments): Promise<void> {
  const definitionPath = flag(args, "definition");
  const selectedRuntime = runtime(flag(args, "runtime"));
  const { profile } = await loadAgentDefinition(definitionPath);
  const result = await beginPairing({
    runtime: selectedRuntime,
    label: optionalFlag(args, "label") ?? selectedRuntime,
    externalSubject:
      optionalFlag(args, "subject") ?? `${selectedRuntime}:${profile.handle}`,
    definitionPath,
    serverUrl: flag(args, "server", "http://127.0.0.1:8787"),
    store: storeFor(args),
  });
  output({
    status: result.binding.status,
    pairingId: result.binding.pairingId,
    code: result.binding.pairingCode,
    expiresAt: result.binding.pairingExpiresAt,
    verificationUri: result.verificationUri,
    agent: result.binding.requestedProfile,
    runtime: result.binding.runtime,
  });
}

async function status(args: ParsedArguments): Promise<void> {
  const store = storeFor(args);
  const selector = optionalFlag(args, "binding");
  if (selector && !args.flags.has("offline")) {
    await refreshPairing(selector, store);
  }
  const state = await store.load();
  const publicState = publicBindingState(state);
  output(selector ? publicState.filter((item) => item.pairingId === selector || item.bindingId === selector || item.requestedProfile.handle === selector) : publicState);
}

async function claim(args: ParsedArguments): Promise<void> {
  const binding = await claimPairing(flag(args, "binding"), storeFor(args));
  output({
    status: binding.status,
    bindingId: binding.bindingId,
    agentId: binding.agentId,
    handle: binding.requestedProfile.handle,
    runtime: binding.runtime,
    tokenExpiresAt: binding.agentTokenExpiresAt,
  });
}

async function sync(args: ParsedArguments): Promise<void> {
  const store = storeFor(args);
  const selector = flag(args, "binding");
  const result = await syncBindingDefinition({
    selector,
    store,
    definitionPath: optionalFlag(args, "definition"),
  });
  output(
    result.changed
      ? result.response
      : { synced: true, changed: false, definitionDigest: result.binding.definitionDigest },
  );
}

async function callTool(args: ParsedArguments): Promise<void> {
  const store = storeFor(args);
  const binding = await store.require(flag(args, "binding"));
  const toolName = flag(args, "tool");
  const rawInput = optionalFlag(args, "input") ?? "{}";
  const parsedInput = JSON.parse(rawInput) as unknown;
  if (!parsedInput || typeof parsedInput !== "object" || Array.isArray(parsedInput)) {
    throw new Error("--input must be a JSON object.");
  }
  const tool = createRemoteAgentTools({
    api: new MeshrApi(binding.serverUrl),
    binding,
  }).find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}.`);
  output(await tool.execute(parsedInput as Record<string, unknown>));
}

async function configureOpenClaw(args: ParsedArguments): Promise<void> {
  const configured = await configureOpenClawBinding({
    selector: flag(args, "binding"),
    openClawAgentId: flag(args, "agent-id"),
    store: storeFor(args),
    openClawCommand: optionalFlag(args, "openclaw-command"),
  });
  output(configured);
}

function commandVersion(command: string, arguments_: string[] = ["--version"]) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    installed: !result.error && result.status === 0,
    version: result.status === 0 ? result.stdout.trim() || result.stderr.trim() : undefined,
  };
}

async function doctor(args: ParsedArguments): Promise<void> {
  const serverUrl = flag(args, "server", "http://127.0.0.1:8787");
  let server: { reachable: boolean; result?: unknown; error?: string };
  try {
    server = { reachable: true, result: await new MeshrApi(serverUrl).health() };
  } catch (error) {
    server = { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
  const state = await storeFor(args).load();
  const diagnosis = await diagnoseConnectorBindings(state);
  output({
    server,
    connector: {
      stateReadable: true,
      ...diagnosis,
    },
    runtimes: {
      codex: commandVersion("codex"),
      claude: commandVersion("claude"),
      openclaw: commandVersion("openclaw"),
      ollama: commandVersion("ollama"),
    },
  });
}

function help() {
  output({
    usage: [
      "meshr connect --runtime codex --definition .meshr/agents/euclid.md [--server URL]",
      "meshr status [--binding HANDLE]",
      "meshr claim --binding HANDLE",
      "meshr sync --binding HANDLE [--definition PATH]",
      "meshr call --binding HANDLE --tool discover_meshes [--input '{}']",
      "meshr mcp serve --binding HANDLE",
      "meshr openclaw configure --binding HANDLE --agent-id OPENCLAW_AGENT_ID",
      "meshr doctor [--server URL]",
    ],
  });
}

export async function main(values = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(values);
  if (args.command === "connect") return connect(args);
  if (args.command === "status") return status(args);
  if (args.command === "claim") return claim(args);
  if (args.command === "sync") return sync(args);
  if (args.command === "call") return callTool(args);
  if (args.command === "doctor") return doctor(args);
  if (args.command === "openclaw" && args.positionals[0] === "configure") {
    return configureOpenClaw(args);
  }
  if (args.command === "mcp" && args.positionals[0] === "serve") {
    return serveBindingFromState({
      selector: flag(args, "binding"),
      stateDirectory: optionalFlag(args, "state-dir"),
    });
  }
  return help();
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
// The package wrapper calls `main()` explicitly. When esbuild bundles this
// module into packages/mcp/dist/cli.js, import.meta.url becomes the wrapper's
// URL and the old direct-entry guard would invoke main a second time against
// the same stdio stream. The bundler defines this marker for that artifact;
// direct `tsx connector/cli.ts` execution remains supported.
declare const __MESHR_MCP_BUNDLED__: boolean;
if ((typeof __MESHR_MCP_BUNDLED__ === "undefined" || !__MESHR_MCP_BUNDLED__) && import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
