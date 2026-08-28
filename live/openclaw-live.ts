import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectorBinding, ConnectorState } from "../connector/types.ts";
import { runProcess } from "./process.ts";
import {
  authorBindingEvidence,
  discoverContext,
  locateMarkedPost,
  publicBinding,
  readTargetContext,
  verifyIdentity,
} from "./server.ts";
import type {
  IdentityEvidence,
  LocatedPost,
  ProcessEvidence,
} from "./types.ts";
import {
  OPENCLAW_MESHR_TOOLS,
  OPENCLAW_REPLY_TOOLS,
  OPENCLAW_ROOT_TOOLS,
  openClawPromptDigest,
  openClawReplyPrompt,
  openClawRootPrompt,
  openClawTraceMarker,
} from "./openclaw-prompts.ts";
import type {
  OpenClawInvocationPlan,
  OpenClawLiveEvidence,
  OpenClawLiveOptions,
  OpenClawLivePhase,
  OpenClawPhaseEvidence,
  OpenClawPluginValidationEvidence,
  OpenClawSafeProcessEvidence,
  OpenClawTargetEvidence,
  OpenClawVersionEvidence,
  SelectedOpenClawBindings,
} from "./openclaw-types.ts";

type JsonRecord = Record<string, unknown>;

interface ProcessInput {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export interface OpenClawLiveDependencies {
  runProcess: (input: ProcessInput) => Promise<ProcessEvidence>;
  verifyIdentity: (
    binding: ConnectorBinding,
    timeoutMs: number,
  ) => Promise<IdentityEvidence>;
  discoverContext: typeof discoverContext;
  readTargetContext: typeof readTargetContext;
  locateMarkedPost: typeof locateMarkedPost;
  uuid: () => string;
}

const defaultDependencies: OpenClawLiveDependencies = {
  runProcess,
  verifyIdentity,
  discoverContext,
  readTargetContext,
  locateMarkedPost,
  uuid: randomUUID,
};

const MAX_PRIVATE_FILE_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Meshr server URL must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Meshr server URL cannot include credentials, a query, or a fragment.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

async function assertPrivateDirectory(path: string, label: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory.`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users.`);
  }
}

async function readPrivateJson(path: string, label: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path.`);
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
  if (metadata.size > MAX_PRIVATE_FILE_BYTES) {
    throw new Error(`${label} is unexpectedly large.`);
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable by group or other users.`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function isEligibleBinding(
  value: unknown,
  expectedServer?: string,
): value is ConnectorBinding {
  if (!isRecord(value)) return false;
  if (
    value.runtime !== "openclaw" ||
    value.status !== "connected" ||
    typeof value.agentToken !== "string" ||
    value.agentToken.length === 0 ||
    typeof value.externalSubject !== "string" ||
    typeof value.serverUrl !== "string" ||
    typeof value.pairingId !== "string" ||
    !isRecord(value.requestedProfile) ||
    typeof value.requestedProfile.handle !== "string"
  ) {
    return false;
  }
  if (typeof value.agentTokenExpiresAt === "string") {
    const expiresAt = Date.parse(value.agentTokenExpiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  }
  try {
    return (
      expectedServer === undefined ||
      normalizeServerUrl(value.serverUrl) === expectedServer
    );
  } catch {
    return false;
  }
}

function bindingMatchesSelector(
  binding: ConnectorBinding,
  selector: string,
): boolean {
  return (
    binding.pairingId === selector ||
    binding.bindingId === selector ||
    binding.requestedProfile.handle === selector
  );
}

export function selectOpenClawBindings(input: {
  state: ConnectorState;
  agentIds: [string, string];
  bindingSelectors?: [string, string];
  serverUrl?: string;
}): SelectedOpenClawBindings {
  if (input.state.version !== 1 || !Array.isArray(input.state.bindings)) {
    throw new Error("Unsupported Meshr connector state format.");
  }
  const expectedServer = input.serverUrl
    ? normalizeServerUrl(input.serverUrl)
    : undefined;
  const eligible = input.state.bindings.filter((binding) =>
    isEligibleBinding(binding, expectedServer),
  );
  const select = (index: 0 | 1): ConnectorBinding => {
    const agentId = input.agentIds[index];
    const subject = `openclaw:${agentId}`;
    const selector = input.bindingSelectors?.[index];
    const matches = eligible.filter(
      (binding) =>
        binding.externalSubject === subject &&
        (!selector || bindingMatchesSelector(binding, selector)),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one connected Meshr binding for ${subject}${selector ? ` matching ${selector}` : ""}; found ${matches.length}.`,
      );
    }
    return matches[0]!;
  };
  const root = select(0);
  const reply = select(1);
  if (root.pairingId === reply.pairingId) {
    throw new Error("OpenClaw live E2E requires two distinct Meshr bindings.");
  }
  if (normalizeServerUrl(root.serverUrl) !== normalizeServerUrl(reply.serverUrl)) {
    throw new Error("Both OpenClaw bindings must use the same Meshr server.");
  }
  return { root, reply };
}

function requiredPluginConfig(config: JsonRecord): JsonRecord {
  const plugins = config.plugins;
  const entries = isRecord(plugins) ? plugins.entries : undefined;
  const meshr = isRecord(entries) ? entries.meshr : undefined;
  if (!isRecord(meshr) || meshr.enabled !== true || !isRecord(meshr.config)) {
    throw new Error("The OpenClaw Meshr plugin must be enabled and configured.");
  }
  return meshr.config;
}

async function readJsonFile(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

async function resolveMeshrPluginEntry(config: JsonRecord): Promise<string> {
  const plugins = config.plugins;
  const load = isRecord(plugins) ? plugins.load : undefined;
  const paths = isRecord(load) && Array.isArray(load.paths) ? load.paths : [];
  for (const candidate of paths) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const root = resolve(candidate);
    const manifest = await readJsonFile(
      join(root, "openclaw.plugin.json"),
      "OpenClaw plugin manifest",
    ).catch(() => undefined);
    if (!isRecord(manifest) || manifest.id !== "meshr") continue;
    const packageValue = await readJsonFile(
      join(root, "package.json"),
      "OpenClaw plugin package",
    );
    const openclaw = isRecord(packageValue) ? packageValue.openclaw : undefined;
    const extensions = isRecord(openclaw) ? openclaw.extensions : undefined;
    const extension = Array.isArray(extensions)
      ? extensions.find((value): value is string =>
          typeof value === "string" && value.length > 0,
        )
      : undefined;
    if (!extension) {
      throw new Error("Meshr OpenClaw plugin package has no runtime extension.");
    }
    return realpath(resolve(root, extension));
  }
  throw new Error(
    "OpenClaw config must load the Meshr plugin from a configured plugin path.",
  );
}

interface RuntimeToolRegistration {
  factory: (context: JsonRecord) => unknown;
  names: string[];
}

async function validateRuntimeToolFactories(input: {
  config: JsonRecord;
  pluginConfig: JsonRecord;
  agentIds: [string, string];
}): Promise<string> {
  const entryPath = await resolveMeshrPluginEntry(input.config);
  const imported = (await import(
    `${pathToFileURL(entryPath).href}?meshr-preflight=${Date.now()}`
  )) as { default?: { register?: (api: JsonRecord) => void } };
  if (!imported.default || typeof imported.default.register !== "function") {
    throw new Error("Meshr OpenClaw plugin runtime entry is invalid.");
  }
  const registrations: RuntimeToolRegistration[] = [];
  imported.default.register({
    pluginConfig: input.pluginConfig,
    registerTool(tool: unknown, options?: unknown) {
      if (typeof tool !== "function" || !isRecord(options)) return;
      const names = Array.isArray(options.names)
        ? options.names.filter((value): value is string =>
            typeof value === "string",
          )
        : typeof options.name === "string"
          ? [options.name]
          : [];
      registrations.push({
        factory: tool as (context: JsonRecord) => unknown,
        names,
      });
    },
  });
  for (const agentId of input.agentIds) {
    for (const toolName of OPENCLAW_MESHR_TOOLS) {
      const registration = registrations.find((candidate) =>
        candidate.names.includes(toolName),
      );
      if (!registration) {
        throw new Error(
          `Meshr OpenClaw plugin did not register runtime factory ${toolName}.`,
        );
      }
      const value = registration.factory({
        sessionKey: `agent:${agentId}:explicit:meshr-live-preflight`,
        oneShotCliRun: true,
      });
      const tools = Array.isArray(value) ? value : value ? [value] : [];
      if (
        tools.length !== 1 ||
        !isRecord(tools[0]) ||
        tools[0].name !== toolName
      ) {
        throw new Error(
          `Meshr OpenClaw plugin factory ${toolName} is unavailable for agent ${agentId}.`,
        );
      }
    }
  }
  return entryPath;
}

function configuredAgent(config: JsonRecord, agentId: string): JsonRecord {
  const agents = config.agents;
  const list = isRecord(agents) ? agents.list : undefined;
  if (!Array.isArray(list)) {
    throw new Error("OpenClaw config must contain agents.list.");
  }
  const matches = list.filter(
    (candidate) => isRecord(candidate) && candidate.id === agentId,
  );
  if (matches.length !== 1) {
    throw new Error(
      `OpenClaw config must contain exactly one agent with id ${agentId}.`,
    );
  }
  return matches[0] as JsonRecord;
}

function requiredToolsForPhase(phase: OpenClawLivePhase): readonly string[] {
  return phase === "root" ? OPENCLAW_ROOT_TOOLS : OPENCLAW_REPLY_TOOLS;
}

function effectiveAgentToolProfile(config: JsonRecord, agent: JsonRecord): string {
  const agentTools = isRecord(agent.tools) ? agent.tools : undefined;
  if (typeof agentTools?.profile === "string" && agentTools.profile.trim()) {
    return agentTools.profile.trim();
  }
  const globalTools = isRecord(config.tools) ? config.tools : undefined;
  if (typeof globalTools?.profile === "string" && globalTools.profile.trim()) {
    return globalTools.profile.trim();
  }
  return "full";
}

function validateMeshrOnlyToolPolicy(
  config: JsonRecord,
  agent: JsonRecord,
  agentId: string,
): void {
  const tools = isRecord(agent.tools) ? agent.tools : undefined;
  const allow = Array.isArray(tools?.allow) ? tools.allow : [];
  const effectiveProfile = effectiveAgentToolProfile(config, agent);
  if (effectiveProfile !== "full") {
    throw new Error(
      `OpenClaw agent ${agentId} must use effective tools.profile full before its exact Meshr allowlist; profile ${effectiveProfile} can filter plugin tools first.`,
    );
  }

  const expected = new Set<string>(OPENCLAW_MESHR_TOOLS);
  const normalized = allow.filter(
    (value): value is string => typeof value === "string",
  );
  const actual = new Set(normalized);
  const missing = OPENCLAW_MESHR_TOOLS.filter((tool) => !actual.has(tool));
  const unexpected = normalized.filter((tool) => !expected.has(tool));
  if (
    missing.length > 0 ||
    unexpected.length > 0 ||
    normalized.length !== allow.length ||
    actual.size !== normalized.length
  ) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
      unexpected.length > 0 ? `unexpected: ${unexpected.join(", ")}` : "",
      normalized.length !== allow.length ? "non-string entries" : "",
      actual.size !== normalized.length ? "duplicate entries" : "",
    ].filter(Boolean);
    throw new Error(
      `OpenClaw agent ${agentId} must allow exactly the nine Meshr plugin tools${details.length > 0 ? ` (${details.join("; ")})` : ""}.`,
    );
  }
}

export async function validateOpenClawPluginConfig(input: {
  config: unknown;
  connectorStatePath: string;
  expectedServerUrl: string;
  agentIds: [string, string];
}): Promise<OpenClawPluginValidationEvidence> {
  if (!isRecord(input.config)) {
    throw new Error("OpenClaw config must be a JSON object.");
  }
  const plugin = requiredPluginConfig(input.config);
  if (
    typeof plugin.baseUrl !== "string" ||
    normalizeServerUrl(plugin.baseUrl) !==
      normalizeServerUrl(input.expectedServerUrl)
  ) {
    throw new Error("The OpenClaw Meshr plugin server does not match the bindings.");
  }
  if (
    typeof plugin.connectorStatePath !== "string" ||
    !isAbsolute(plugin.connectorStatePath)
  ) {
    throw new Error(
      "The OpenClaw Meshr plugin connectorStatePath must be absolute.",
    );
  }
  const [configuredState, suppliedState] = await Promise.all([
    realpath(plugin.connectorStatePath),
    realpath(input.connectorStatePath),
  ]);
  if (configuredState !== suppliedState) {
    throw new Error(
      "The OpenClaw Meshr plugin does not use the supplied connector state file.",
    );
  }
  const agents = input.agentIds.map((agentId, index) => {
    const phase: OpenClawLivePhase = index === 0 ? "root" : "reply";
    const agent = configuredAgent(input.config as JsonRecord, agentId);
    validateMeshrOnlyToolPolicy(input.config as JsonRecord, agent, agentId);
    const tools = isRecord(agent.tools) ? agent.tools : undefined;
    const allow = isRecord(tools) && Array.isArray(tools.allow) ? tools.allow : [];
    const requiredTools = [...requiredToolsForPhase(phase)];
    const missingTools = requiredTools.filter((tool) => !allow.includes(tool));
    if (missingTools.length) {
      throw new Error(
        `OpenClaw agent ${agentId} is missing required Meshr tools: ${missingTools.join(", ")}.`,
      );
    }
    return {
      agentId,
      effectiveProfile: "full" as const,
      exactMeshrAllowlistValidated: true as const,
      requiredTools,
      missingTools: [] as [],
    };
  });
  const pluginEntryPath = await validateRuntimeToolFactories({
    config: input.config,
    pluginConfig: plugin,
    agentIds: input.agentIds,
  });
  return {
    enabled: true,
    serverUrl: normalizeServerUrl(input.expectedServerUrl),
    connectorStatePathMatches: true,
    runtimeFactoryValidated: true,
    pluginEntryPath,
    agents,
  };
}

export function buildOpenClawEnvironment(
  options: OpenClawLiveOptions,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...base };
  delete environment.OPENCLAW_PROFILE;
  delete environment.OPENCLAW_CONTAINER;
  delete environment.MESHR_STATE_DIR;
  environment.OPENCLAW_STATE_DIR = options.openClawStateDirectory;
  environment.OPENCLAW_CONFIG_PATH = options.openClawConfigPath;
  return environment;
}

function openClawTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.floor((timeoutMs - 2_000) / 1_000));
}

interface BuiltInvocation {
  process: ProcessInput;
  plan: OpenClawInvocationPlan;
}

export function buildOpenClawInvocation(input: {
  options: OpenClawLiveOptions;
  phase: OpenClawLivePhase;
  traceId: string;
  agentId: string;
  prompt: string;
  promptPath: string;
}): BuiltInvocation {
  const seconds = openClawTimeoutSeconds(input.options.timeoutMs);
  const args = [
    "agent",
    "--local",
    "--agent",
    input.agentId,
    "--json",
    "--message-file",
    input.promptPath,
    "--session-id",
    `${input.traceId}-${input.phase}`,
    "--timeout",
    String(seconds),
    "--thinking",
    "off",
  ];
  if (input.options.model) args.push("--model", input.options.model);
  const redactedArgs = args.map((value) =>
    value === input.promptPath ? "<private-prompt-file>" : value,
  );
  return {
    process: {
      command: input.options.openClawCommand,
      args,
      cwd: input.options.projectRoot,
      timeoutMs: input.options.timeoutMs,
      env: buildOpenClawEnvironment(input.options),
    },
    plan: {
      command: input.options.openClawCommand,
      args: redactedArgs,
      environmentOverrides: ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"],
      promptSha256: openClawPromptDigest(input.prompt),
      requiredTools: [...requiredToolsForPhase(input.phase)],
      outerTimeoutMs: input.options.timeoutMs,
      openClawTimeoutSeconds: seconds,
      attempts: 1,
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isJson(value: string): boolean {
  if (!value.trim()) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

export function safeProcessEvidence(
  execution: ProcessEvidence,
  args: string[],
): OpenClawSafeProcessEvidence {
  let failureKind: OpenClawSafeProcessEvidence["failureKind"];
  if (execution.error) failureKind = "spawn-error";
  else if (execution.timedOut) failureKind = "timeout";
  else if (execution.exitCode !== 0) failureKind = "nonzero-exit";
  return {
    command: execution.command,
    args,
    startedAt: execution.startedAt,
    elapsedMs: execution.elapsedMs,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    outputTruncated: execution.outputTruncated,
    stdoutBytes: Buffer.byteLength(execution.stdout),
    stderrBytes: Buffer.byteLength(execution.stderr),
    stdoutSha256: digest(execution.stdout),
    stderrSha256: digest(execution.stderr),
    stdoutJson: isJson(execution.stdout),
    ...(failureKind ? { failureKind } : {}),
  };
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/Pairing\s+\S+/gi, "Pairing <redacted>")
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      "<redacted-pem>",
    )
    .slice(0, 1_000);
}

function safeIdentity(identity: IdentityEvidence): IdentityEvidence {
  return {
    ...identity,
    ...(identity.error ? { error: safeError(identity.error) } : {}),
  };
}

function processSucceeded(execution: ProcessEvidence): boolean {
  return (
    execution.exitCode === 0 &&
    !execution.timedOut &&
    !execution.error &&
    isJson(execution.stdout)
  );
}

function phaseEvidence(input: {
  phase: OpenClawLivePhase;
  traceId: string;
  agentId: string;
  binding: ConnectorBinding;
  target: OpenClawTargetEvidence;
  plan: OpenClawInvocationPlan;
  status: OpenClawPhaseEvidence["status"];
  error?: string;
}): OpenClawPhaseEvidence {
  return {
    phase: input.phase,
    traceId: input.traceId,
    marker: openClawTraceMarker(input.traceId, input.phase),
    openClawAgentId: input.agentId,
    binding: publicBinding(input.binding),
    target: input.target,
    plan: input.plan,
    status: input.status,
    ...(input.error ? { error: input.error } : {}),
  };
}

async function versionEvidence(
  options: OpenClawLiveOptions,
  dependencies: OpenClawLiveDependencies,
): Promise<OpenClawVersionEvidence> {
  const execution = await dependencies.runProcess({
    command: options.openClawCommand,
    args: ["--version"],
    cwd: options.projectRoot,
    timeoutMs: options.versionTimeoutMs,
    env: buildOpenClawEnvironment(options),
  });
  const output = `${execution.stdout}\n${execution.stderr}`;
  const match = output.match(/OpenClaw\s+([0-9][0-9A-Za-z.+-]*)/);
  const installed =
    execution.exitCode === 0 && !execution.timedOut && !execution.error;
  return {
    installed,
    ...(installed && match ? { version: match[1] } : {}),
    execution: safeProcessEvidence(execution, ["--version"]),
  };
}

async function writePrompt(path: string, prompt: string): Promise<void> {
  await writeFile(path, `${prompt}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function placeholderTarget(): { meshId: string; topicId: string; postId: string } {
  return {
    meshId: "<verified-root-mesh-id>",
    topicId: "<verified-root-topic-id>",
    postId: "<verified-root-post-id>",
  };
}

function optionsWithResolvedPaths(options: OpenClawLiveOptions): OpenClawLiveOptions {
  return {
    ...options,
    projectRoot: resolve(options.projectRoot),
    openClawStateDirectory: resolve(options.openClawStateDirectory),
    openClawConfigPath: resolve(options.openClawConfigPath),
    connectorStatePath: resolve(options.connectorStatePath),
    ...(options.evidencePath
      ? { evidencePath: resolve(options.evidencePath) }
      : {}),
  };
}

export async function runOpenClawLive(
  suppliedOptions: OpenClawLiveOptions,
  suppliedDependencies: Partial<OpenClawLiveDependencies> = {},
): Promise<OpenClawLiveEvidence> {
  const options = optionsWithResolvedPaths(suppliedOptions);
  const dependencies = { ...defaultDependencies, ...suppliedDependencies };
  const runId = `openclaw-${dependencies.uuid()}`;
  const traceId = `openclaw-${dependencies.uuid()}`;
  const startedAt = new Date().toISOString();
  const evidence: OpenClawLiveEvidence = {
    schemaVersion: 1,
    runId,
    traceId,
    startedAt,
    finishedAt: startedAt,
    dryRun: options.dryRun,
    projectRoot: options.projectRoot,
    isolation: {
      openClawCommand: options.openClawCommand,
      openClawStateDirectory: options.openClawStateDirectory,
      openClawConfigPath: options.openClawConfigPath,
      connectorStatePath: options.connectorStatePath,
      privateStateValidated: false,
    },
    agents: [],
    phases: [],
    outcome: "failed",
  };
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "meshr-openclaw-live-"),
  );
  await chmod(temporaryDirectory, 0o700);

  try {
    await assertPrivateDirectory(
      options.openClawStateDirectory,
      "OpenClaw state directory",
    );
    const [configValue, stateValue] = await Promise.all([
      readPrivateJson(options.openClawConfigPath, "OpenClaw config"),
      readPrivateJson(options.connectorStatePath, "Meshr connector state"),
    ]);
    if (!isRecord(stateValue) || !Array.isArray(stateValue.bindings)) {
      throw new Error("Unsupported Meshr connector state format.");
    }
    const selected = selectOpenClawBindings({
      state: stateValue as unknown as ConnectorState,
      agentIds: options.agentIds,
      bindingSelectors: options.bindingSelectors,
      serverUrl: options.serverUrl,
    });
    const selectedServer = normalizeServerUrl(selected.root.serverUrl);
    evidence.plugin = await validateOpenClawPluginConfig({
      config: configValue,
      connectorStatePath: options.connectorStatePath,
      expectedServerUrl: selectedServer,
      agentIds: options.agentIds,
    });
    evidence.isolation.privateStateValidated = true;
    evidence.version = await versionEvidence(options, dependencies);

    const identities = (
      await Promise.all([
        dependencies.verifyIdentity(selected.root, options.timeoutMs),
        dependencies.verifyIdentity(selected.reply, options.timeoutMs),
      ])
    ).map(safeIdentity);
    evidence.agents = [
      {
        role: "root",
        openClawAgentId: options.agentIds[0],
        binding: publicBinding(selected.root),
        identity: identities[0]!,
      },
      {
        role: "reply",
        openClawAgentId: options.agentIds[1],
        binding: publicBinding(selected.reply),
        identity: identities[1]!,
      },
    ];

    const prerequisites: string[] = [];
    if (!evidence.version.installed) {
      prerequisites.push("OpenClaw executable is unavailable.");
    }
    if (identities.some((identity) => !identity.matches)) {
      prerequisites.push(
        "One or more server identities do not match connector state.",
      );
    }

    let target = placeholderTarget();
    if (prerequisites.length === 0) {
      try {
        const rootContext = await dependencies.discoverContext(
          selected.root,
          options.timeoutMs,
        );
        await dependencies.readTargetContext({
          binding: selected.reply,
          meshId: rootContext.mesh.id,
          topicId: rootContext.topic.id,
          timeoutMs: options.timeoutMs,
        });
        target = {
          meshId: rootContext.mesh.id,
          topicId: rootContext.topic.id,
          postId: "<verified-root-post-id>",
        };
      } catch (error) {
        prerequisites.push(
          `OpenClaw agents do not share a readable Meshr conversation: ${safeError(error)}`,
        );
      }
    }

    const rootPrompt = openClawRootPrompt(traceId, target);
    const rootPath = join(temporaryDirectory, "root-prompt.txt");
    const rootInvocation = buildOpenClawInvocation({
      options,
      phase: "root",
      traceId,
      agentId: options.agentIds[0],
      prompt: rootPrompt,
      promptPath: rootPath,
    });
    const plannedReplyPrompt = openClawReplyPrompt(traceId, target);
    const plannedReplyPath = join(temporaryDirectory, "reply-prompt.txt");
    const plannedReplyInvocation = buildOpenClawInvocation({
      options,
      phase: "reply",
      traceId,
      agentId: options.agentIds[1],
      prompt: plannedReplyPrompt,
      promptPath: plannedReplyPath,
    });

    if (prerequisites.length) {
      evidence.phases = [
        phaseEvidence({
          phase: "root",
          traceId,
          agentId: options.agentIds[0],
          binding: selected.root,
          target: { meshId: target.meshId, topicId: target.topicId },
          plan: rootInvocation.plan,
          status: "skipped",
          error: prerequisites.join(" "),
        }),
        phaseEvidence({
          phase: "reply",
          traceId,
          agentId: options.agentIds[1],
          binding: selected.reply,
          target,
          plan: plannedReplyInvocation.plan,
          status: "skipped",
          error: prerequisites.join(" "),
        }),
      ];
      evidence.error = prerequisites.join(" ");
      return evidence;
    }

    if (options.dryRun) {
      evidence.phases = [
        phaseEvidence({
          phase: "root",
          traceId,
          agentId: options.agentIds[0],
          binding: selected.root,
          target: { meshId: target.meshId, topicId: target.topicId },
          plan: rootInvocation.plan,
          status: "planned",
        }),
        phaseEvidence({
          phase: "reply",
          traceId,
          agentId: options.agentIds[1],
          binding: selected.reply,
          target,
          plan: plannedReplyInvocation.plan,
          status: "planned",
        }),
      ];
      evidence.outcome = "planned";
      return evidence;
    }

    const rootPhase = phaseEvidence({
      phase: "root",
      traceId,
      agentId: options.agentIds[0],
      binding: selected.root,
      target: { meshId: target.meshId, topicId: target.topicId },
      plan: rootInvocation.plan,
      status: "failed",
    });
    let rootLocated: LocatedPost;
    try {
      await writePrompt(rootPath, rootPrompt);
      const execution = await dependencies.runProcess(rootInvocation.process);
      rootPhase.execution = safeProcessEvidence(
        execution,
        rootInvocation.plan.args,
      );
      if (!processSucceeded(execution)) {
        throw new Error(
          execution.timedOut
            ? "OpenClaw root process timed out."
            : execution.error
              ? "OpenClaw root process could not start."
              : execution.exitCode !== 0
                ? "OpenClaw root process exited unsuccessfully."
                : "OpenClaw root process did not return valid JSON.",
        );
      }
      rootLocated = await dependencies.locateMarkedPost({
        binding: selected.root,
        marker: rootPhase.marker,
        timeoutMs: options.timeoutMs,
        parentPostId: null,
        targetMeshId: target.meshId,
        targetTopicId: target.topicId,
      });
      rootPhase.authorBinding = authorBindingEvidence(
        selected.root,
        rootPhase.marker,
        rootLocated,
      );
      if (
        !rootPhase.authorBinding.agentIdMatches ||
        !rootPhase.authorBinding.handleMatches
      ) {
        throw new Error(
          "Root post author does not match the plugin-backed Meshr binding.",
        );
      }
      rootPhase.status = "passed";
      evidence.phases.push(rootPhase);
    } catch (error) {
      rootPhase.error = safeError(error);
      evidence.phases.push(rootPhase);
      evidence.phases.push(
        phaseEvidence({
          phase: "reply",
          traceId,
          agentId: options.agentIds[1],
          binding: selected.reply,
          target,
          plan: plannedReplyInvocation.plan,
          status: "skipped",
          error: "Root phase failed; reply was not attempted.",
        }),
      );
      evidence.error = rootPhase.error;
      return evidence;
    }

    const replyPrompt = openClawReplyPrompt(traceId, {
      meshId: rootLocated.post.meshId,
      topicId: rootLocated.post.topicId,
      postId: rootLocated.post.id,
    });
    const replyInvocation = buildOpenClawInvocation({
      options,
      phase: "reply",
      traceId,
      agentId: options.agentIds[1],
      prompt: replyPrompt,
      promptPath: plannedReplyPath,
    });
    const replyPhase = phaseEvidence({
      phase: "reply",
      traceId,
      agentId: options.agentIds[1],
      binding: selected.reply,
      target: {
        meshId: rootLocated.post.meshId,
        topicId: rootLocated.post.topicId,
        postId: rootLocated.post.id,
      },
      plan: replyInvocation.plan,
      status: "failed",
    });
    try {
      await writePrompt(plannedReplyPath, replyPrompt);
      const execution = await dependencies.runProcess(replyInvocation.process);
      replyPhase.execution = safeProcessEvidence(
        execution,
        replyInvocation.plan.args,
      );
      if (!processSucceeded(execution)) {
        throw new Error(
          execution.timedOut
            ? "OpenClaw reply process timed out."
            : execution.error
              ? "OpenClaw reply process could not start."
              : execution.exitCode !== 0
                ? "OpenClaw reply process exited unsuccessfully."
                : "OpenClaw reply process did not return valid JSON.",
        );
      }
      const located = await dependencies.locateMarkedPost({
        binding: selected.reply,
        marker: replyPhase.marker,
        timeoutMs: options.timeoutMs,
        parentPostId: rootLocated.post.id,
        targetMeshId: rootLocated.post.meshId,
        targetTopicId: rootLocated.post.topicId,
      });
      replyPhase.authorBinding = authorBindingEvidence(
        selected.reply,
        replyPhase.marker,
        located,
      );
      if (
        !replyPhase.authorBinding.agentIdMatches ||
        !replyPhase.authorBinding.handleMatches
      ) {
        throw new Error(
          "Reply author does not match the plugin-backed Meshr binding.",
        );
      }
      replyPhase.status = "passed";
      evidence.outcome = "passed";
    } catch (error) {
      replyPhase.error = safeError(error);
      evidence.error = replyPhase.error;
    }
    evidence.phases.push(replyPhase);
    return evidence;
  } catch (error) {
    evidence.error = safeError(error);
    return evidence;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function defaultOpenClawEvidencePath(
  evidence: OpenClawLiveEvidence,
): string {
  const timestamp = evidence.startedAt.replace(/[:.]/g, "-");
  return join(
    evidence.projectRoot,
    "live",
    "evidence",
    `${timestamp}-${evidence.runId}.json`,
  );
}

export async function writeOpenClawEvidence(
  evidence: OpenClawLiveEvidence,
  path = defaultOpenClawEvidencePath(evidence),
): Promise<string> {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, absolute);
  return absolute;
}
