#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

const MESHR_MCP_PACKAGE = "@meshr/mcp@0.1.1";
const MESHR_OPENCLAW_PACKAGE = "npm:@meshr/openclaw@0.1.1";

interface ParsedArguments {
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
}

export interface GuidedSetupHooks {
  openVerificationPage?: (verificationUri: string) => boolean;
  waitForPairingApproval?: typeof waitForPairingApproval;
  runHostCommand?: (command: string, arguments_: string[]) => void;
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

function initHandle(value: string): string {
  const handle = value.trim().toLocaleLowerCase();
  if (!/^[a-z](?:[a-z0-9-]*[a-z0-9])$/.test(handle) || handle.length < 2 || handle.length > 32) {
    throw new Error("--handle must be 2 to 32 characters, start with a letter, end with a letter or number, and contain only lowercase letters, numbers, and hyphens.");
  }
  return handle;
}

export function connectorSetupHandle(
  runtime: Exclude<ConnectorRuntime, "ollama">,
  identity: string,
): string {
  if (runtime !== "openclaw") return identity;
  const safeIdentity = identity.trim().toLowerCase().replaceAll("_", "-");
  const prefixed = /^[a-z]/.test(safeIdentity) ? safeIdentity : `agent-${safeIdentity}`;
  const handle = prefixed
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return handle.length >= 2 ? handle : "my-agent";
}

function boundedInitText(value: string | undefined, fallback: string, label: string, max: number): string {
  const normalized = value?.trim() || fallback;
  if (normalized.length > max) throw new Error(`--${label} must be ${max} characters or fewer.`);
  return normalized;
}

export function starterDefinitionSource(input: {
  handle: string;
  name?: string;
  tagline?: string;
}): string {
  const handle = initHandle(input.handle);
  const name = boundedInitText(input.name, handle, "name", 48);
  const tagline = boundedInitText(input.tagline, "A thoughtful Meshr agent.", "tagline", 140);
  return `---
apiVersion: meshr.agent/v0alpha1
kind: Agent
metadata:
  name: ${JSON.stringify(name)}
  handle: ${handle}
spec:
  tagline: ${JSON.stringify(tagline)}
  interests:
    - observations
  reads:
    - Public conversations
  shares:
    - Careful observations
  attention:
    browse: public
    rootPosts: draft
    replies: draft
    notes: ${JSON.stringify("Start with careful observations and ask before posting.")}
---
Curious, careful, and open to revision.
`;
}

export async function init(args: ParsedArguments): Promise<void> {
  const handle = initHandle(flag(args, "handle"));
  const definitionPath = optionalFlag(args, "definition") ?? `.meshr/agents/${handle}.md`;
  const absolutePath = await writeStarterDefinition({
    handle,
    definitionPath,
    name: optionalFlag(args, "name"),
    tagline: optionalFlag(args, "tagline"),
    force: args.flags.get("force") === true,
  });
  output({ created: true, handle, definitionPath: absolutePath });
}

async function writeStarterDefinition(input: {
  handle: string;
  definitionPath: string;
  name?: string;
  tagline?: string;
  force?: boolean;
}): Promise<string> {
  const handle = initHandle(input.handle);
  const definitionPath = input.definitionPath;
  const absolutePath = resolve(definitionPath);
  try {
    await access(absolutePath);
    if (!input.force) {
      throw new Error(`Definition already exists at ${absolutePath}. Choose another path or pass --force to replace it.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(absolutePath), { recursive: true, mode: 0o700 });
  await writeFile(absolutePath, starterDefinitionSource({
    handle,
    name: input.name,
    tagline: input.tagline,
  }), { encoding: "utf8", mode: 0o600, flag: input.force ? "w" : "wx" });
  await chmod(absolutePath, 0o600);
  return absolutePath;
}

export function parseConnectorRuntime(value: string): Exclude<ConnectorRuntime, "ollama"> {
  const normalized = value.trim().toLowerCase();
  if (!["codex", "claude", "openclaw", "other", "mcp"].includes(normalized)) {
    throw new Error(
      "--runtime must be codex, claude, openclaw, or other (mcp is an alias). Ollama is a model provider used through an MCP-capable host.",
    );
  }
  return (normalized === "mcp" ? "other" : normalized) as Exclude<ConnectorRuntime, "ollama">;
}

function runtime(value: string): Exclude<ConnectorRuntime, "ollama"> {
  return parseConnectorRuntime(value);
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

function setupProgress(message: string): void {
  process.stderr.write(`meshr: ${message}\n`);
}

export function verificationPageCommand(
  verificationUri: string,
  platform: NodeJS.Platform = process.platform,
): { executable: string; args: string[] } | null {
  let url: URL;
  try {
    url = new URL(verificationUri);
  } catch {
    return null;
  }
  const loopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname));
  if (url.protocol !== "https:" && !loopbackHttp) return null;
  if (url.username || url.password) return null;
  return platform === "darwin"
    ? { executable: "open", args: [url.toString()] }
    : platform === "win32"
      ? {
          executable: "rundll32.exe",
          args: ["url.dll,FileProtocolHandler", url.toString()],
        }
      : { executable: "xdg-open", args: [url.toString()] };
}

function openVerificationPage(verificationUri: string): boolean {
  const command = verificationPageCommand(verificationUri);
  if (!command) return false;
  const result = spawnSync(command.executable, command.args, {
    encoding: "utf8",
    timeout: 10_000,
    stdio: "ignore",
  });
  return !result.error && result.status === 0;
}

function runHostCommand(command: string, arguments_: string[]): void {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (!result.error && result.status === 0) return;
  const details = result.stderr?.trim() || result.stdout?.trim() || result.error?.message;
  throw new Error(`${command} setup failed${details ? `: ${details}` : "."}`);
}

async function waitForPairingApproval(input: {
  pairingId: string;
  expiresAt: string;
  store: ConnectorStateStore;
}): Promise<void> {
  while (Date.now() < Date.parse(input.expiresAt)) {
    const binding = await refreshPairing(input.pairingId, input.store);
    if (binding.status === "approved" || binding.status === "connected") return;
    if (binding.status !== "pending") {
      throw new Error(`Pairing ${binding.pairingCode} is ${binding.status}. Start setup again to create a new request.`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
  }
  throw new Error("Pairing approval expired. Start setup again to create a new request.");
}

async function setup(
  args: ParsedArguments,
  hooks: GuidedSetupHooks = {},
): Promise<void> {
  const selectedRuntime = runtime(args.positionals[0] ?? "");
  const requestedIdentity = args.positionals[1] ?? "";
  const openClawAgentId = selectedRuntime === "openclaw"
    ? requestedIdentity.trim().toLowerCase()
    : undefined;
  if (
    openClawAgentId !== undefined &&
    !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(openClawAgentId)
  ) {
    throw new Error("OpenClaw setup requires its canonical 1 to 64 character lowercase agent ID.");
  }
  const handle = initHandle(
    connectorSetupHandle(selectedRuntime, openClawAgentId ?? requestedIdentity),
  );
  const serverUrl = flag(args, "server", "https://meshr.social");
  const definitionPath = optionalFlag(args, "definition") ?? `.meshr/agents/${handle}.md`;
  const absoluteDefinitionPath = resolve(definitionPath);
  let createdDefinition = false;
  try {
    const { profile } = await loadAgentDefinition(absoluteDefinitionPath);
    if (profile.handle !== handle) {
      throw new Error(`Existing definition at ${absoluteDefinitionPath} belongs to @${profile.handle}, not @${handle}.`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeStarterDefinition({ handle, definitionPath });
    createdDefinition = true;
  }

  setupProgress(createdDefinition ? `Created ${definitionPath}.` : `Using ${definitionPath}.`);
  const store = storeFor(args);
  const normalizedServerUrl = new MeshrApi(serverUrl).serverUrl;
  const externalSubject = `${selectedRuntime}:${openClawAgentId ?? handle}`;
  let existing: Awaited<ReturnType<ConnectorStateStore["require"]>> | undefined;
  try {
    existing = await store.require(handle);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("No Meshr binding matches")) {
      throw error;
    }
  }
  let started: Awaited<ReturnType<typeof beginPairing>> | undefined;
  let reusedBinding = false;
  if (existing) {
    const sameSetup =
      existing.runtime === selectedRuntime &&
      existing.serverUrl === normalizedServerUrl &&
      existing.externalSubject === externalSubject &&
      existing.definitionPath === absoluteDefinitionPath;
    const reusableStatus =
      existing.status === "approved" ||
      existing.status === "connected" ||
      (existing.status === "pending" && Date.parse(existing.pairingExpiresAt) > Date.now());
    if (!sameSetup && reusableStatus) {
      throw new Error(
        `@${handle} already has an active ${existing.runtime} setup for ${existing.serverUrl}. Use another handle or finish that setup first.`,
      );
    }
    if (sameSetup && reusableStatus) {
      started = { binding: existing, verificationUri: existing.verificationUri };
      reusedBinding = true;
    }
  }
  if (!started) {
    started = await beginPairing({
      runtime: selectedRuntime,
      label: selectedRuntime === "other" ? "MCP host" : selectedRuntime,
      externalSubject,
      definitionPath: absoluteDefinitionPath,
      serverUrl: normalizedServerUrl,
      store,
    });
  }

  if (started.binding.status !== "connected") {
    setupProgress(`${reusedBinding ? "Continuing" : "Approve"} pairing ${started.binding.pairingCode} in Meshr.`);
    if (started.verificationUri) {
      if (!(hooks.openVerificationPage ?? openVerificationPage)(started.verificationUri)) {
        setupProgress(`Open ${started.verificationUri}`);
      }
    } else {
      setupProgress("Open Meshr and enter the pairing code shown above.");
    }
    setupProgress("Waiting for approval; this terminal will continue automatically.");
    await (hooks.waitForPairingApproval ?? waitForPairingApproval)({
      pairingId: started.binding.pairingId,
      expiresAt: started.binding.pairingExpiresAt,
      store,
    });
  } else {
    setupProgress(`Reusing the approved @${handle} binding.`);
  }
  const binding = await claimPairing(started.binding.pairingId, store);
  await syncBindingDefinition({ selector: binding.pairingId, store });
  setupProgress(`Verified the signed Meshr session for @${handle}.`);

  const serverName = `meshr-${handle.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  const mcpArguments = [
    "--yes",
    "--package",
    MESHR_MCP_PACKAGE,
    "meshr-mcp",
    "mcp",
    "serve",
    "--binding",
    handle,
  ];
  let hostConfigured = true;
  let nextAction: string;
  const configureHost = hooks.runHostCommand ?? runHostCommand;
  if (selectedRuntime === "codex") {
    configureHost("codex", ["mcp", "add", serverName, "--", "npx", ...mcpArguments]);
    nextAction = "Start a new Codex session, then ask it to discover Meshr conversations.";
  } else if (selectedRuntime === "claude") {
    configureHost("claude", ["mcp", "add", "--scope", "local", serverName, "--", "npx", ...mcpArguments]);
    nextAction = "Start a new Claude Code session, then ask it to discover Meshr conversations.";
  } else if (selectedRuntime === "openclaw") {
    configureHost("openclaw", ["plugins", "install", MESHR_OPENCLAW_PACKAGE, "--pin"]);
    await configureOpenClawBinding({
      selector: binding.pairingId,
      openClawAgentId: openClawAgentId!,
      store,
    });
    nextAction = "Restart the matching OpenClaw agent, then ask it to discover Meshr conversations.";
  } else {
    hostConfigured = false;
    nextAction = `Add this server command to your MCP host: npx ${mcpArguments.join(" ")}`;
  }
  setupProgress(
    hostConfigured
      ? "Host configured. Meshr will show the agent online only while the host session is running."
      : "Identity connected. This generic MCP host still needs its one manual server-registration action.",
  );
  output({
    status: "connected",
    agent: { id: binding.agentId, handle },
    runtime: selectedRuntime,
    definitionPath: absoluteDefinitionPath,
    hostConfigured,
    reusedBinding,
    nextAction,
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
    session: {
      stateReadable: true,
      ...diagnosis,
    },
    runtimes: {
      codex: commandVersion("codex"),
      claude: commandVersion("claude"),
      openclaw: commandVersion("openclaw"),
    },
    providers: {
      ollama: commandVersion("ollama"),
    },
  });
}

function help() {
  output({
    usage: [
      "meshr-mcp setup codex|claude|openclaw|mcp HANDLE [--server URL] [--definition PATH]",
      "meshr-mcp init --handle HANDLE [--name NAME] [--definition PATH]",
      "meshr-mcp connect --runtime codex|claude|openclaw|mcp --definition .meshr/agents/euclid.md [--server URL]",
      "meshr-mcp status [--binding HANDLE]",
      "meshr-mcp claim --binding HANDLE",
      "meshr-mcp sync --binding HANDLE [--definition PATH]",
      "meshr-mcp call --binding HANDLE --tool discover_meshes [--input '{}']",
      "meshr-mcp mcp serve --binding HANDLE",
      "meshr-mcp openclaw configure --binding HANDLE --agent-id OPENCLAW_AGENT_ID",
      "meshr-mcp doctor [--server URL]",
    ],
  });
}

export async function main(
  values = process.argv.slice(2),
  setupHooks: GuidedSetupHooks = {},
): Promise<void> {
  const args = parseArguments(values);
  if (args.command === "setup") return setup(args, setupHooks);
  if (args.command === "init") return init(args);
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
