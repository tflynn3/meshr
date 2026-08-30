#!/usr/bin/env node

import { sign } from "node:crypto";
import { chmod, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshrApi } from "../connector/api.ts";
import { ConnectorStateStore } from "../connector/state.ts";
import type { ConnectorBinding, ConnectorState } from "../connector/types.ts";

interface Options {
  stateFile: string;
  serverUrl?: string;
  selectors: string[];
  openClawAgents: string[];
}

function usage(): string {
  return [
    "Usage: npm run refresh:sessions -- --state-file <path> --selectors <a,b> --openclaw-agents <a,b> [--server <url>]",
    "",
    "Refreshes selected bindings with signed challenges before native release acceptance.",
  ].join("\n");
}

function valueAfter(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index === -1 ? undefined : values[index + 1];
}

function csv(value: string | undefined): string[] {
  return value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseOptions(values: string[]): Options {
  if (values.includes("--help") || values.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const stateFileValue = valueAfter(values, "--state-file");
  if (!stateFileValue) throw new Error("--state-file is required.");
  const selectors = csv(valueAfter(values, "--selectors"));
  const openClawAgents = csv(valueAfter(values, "--openclaw-agents"));
  if (selectors.length === 0 && openClawAgents.length === 0) {
    throw new Error("At least one --selectors or --openclaw-agents value is required.");
  }
  return {
    stateFile: resolve(stateFileValue),
    ...(valueAfter(values, "--server") ? { serverUrl: valueAfter(values, "--server") } : {}),
    selectors,
    openClawAgents,
  };
}

function isBinding(value: unknown): value is ConnectorBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ConnectorBinding>;
  return (
    typeof candidate.pairingId === "string" &&
    typeof candidate.serverUrl === "string" &&
    typeof candidate.runtime === "string" &&
    typeof candidate.externalSubject === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.pairingSecret === "string" &&
    typeof candidate.privateKeyPem === "string"
  );
}

async function assertPrivateStateFile(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Runtime state must be a regular file.");
  if (metadata.size > 5 * 1024 * 1024) throw new Error("Runtime state is unexpectedly large.");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Runtime state must not be readable by group or other users.");
  }
}

function matchesSelector(binding: ConnectorBinding, selector: string): boolean {
  return (
    binding.pairingId === selector ||
    binding.bindingId === selector ||
    binding.requestedProfile.handle === selector
  );
}

function selectBindings(state: ConnectorState, options: Options): ConnectorBinding[] {
  const selected = new Map<string, ConnectorBinding>();
  for (const selector of options.selectors) {
    const matches = state.bindings.filter((binding) => matchesSelector(binding, selector));
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one runtime binding for selector ${selector}; found ${matches.length}.`);
    }
    selected.set(matches[0]!.pairingId, matches[0]!);
  }
  for (const agentId of options.openClawAgents) {
    const subject = `openclaw:${agentId}`;
    const matches = state.bindings.filter((binding) => binding.externalSubject === subject);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one OpenClaw binding for ${agentId}; found ${matches.length}.`);
    }
    selected.set(matches[0]!.pairingId, matches[0]!);
  }
  return [...selected.values()];
}

async function refreshBinding(binding: ConnectorBinding, expectedServer?: string): Promise<void> {
  if (binding.status !== "connected" && binding.status !== "approved") {
    throw new Error(`Binding ${binding.pairingId} is not approved for a runtime session.`);
  }
  if (!binding.pairingSecret || !binding.privateKeyPem) {
    throw new Error(`Binding ${binding.pairingId} is missing signed session credentials.`);
  }
  const api = new MeshrApi(binding.serverUrl);
  if (expectedServer && api.serverUrl !== new MeshrApi(expectedServer).serverUrl) {
    throw new Error(`Binding ${binding.pairingId} is connected to an unexpected Meshr server.`);
  }
  const challenge = await api.createChallenge(binding);
  const signature = sign(
    null,
    Buffer.from(challenge.message, "utf8"),
    binding.privateKeyPem,
  ).toString("base64url");
  const session = await api.createAgentSession({
    binding,
    challengeId: challenge.challengeId,
    signature,
  });
  Object.assign(binding, {
    status: "connected" as const,
    agentToken: session.token,
    agentTokenExpiresAt: session.expiresAt,
    sessionId: session.sessionId,
    bindingId: session.bindingId ?? binding.bindingId,
    agentId: session.agent.id,
  });
}

export async function refreshRuntimeSessions(values = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(values);
  await assertPrivateStateFile(options.stateFile);
  const store = new ConnectorStateStore(dirname(options.stateFile), { useKeychain: false });
  if (store.path !== options.stateFile) {
    throw new Error("--state-file must be the state.json file inside its state directory.");
  }
  const state = await store.load();
  if (state.version !== 1 || !Array.isArray(state.bindings) || state.bindings.some((binding) => !isBinding(binding))) {
    throw new Error("Unsupported Meshr runtime state format.");
  }
  const selected = selectBindings(state, options);
  await Promise.all(selected.map((binding) => refreshBinding(binding, options.serverUrl)));
  await store.save(state);
  await chmod(options.stateFile, 0o600);
  process.stdout.write(`${JSON.stringify({
    refreshed: selected.map((binding) => ({
      pairingId: binding.pairingId,
      runtime: binding.runtime,
      agentId: binding.agentId ?? null,
      externalSubject: binding.externalSubject,
      expiresAt: binding.agentTokenExpiresAt ?? null,
    })),
  }, null, 2)}\n`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  refreshRuntimeSessions().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
