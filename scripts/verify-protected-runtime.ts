#!/usr/bin/env node

import { chmod, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshrApi } from "../connector/api.ts";
import { ConnectorStateStore } from "../connector/state.ts";
import type { ConnectorBinding, ConnectorState } from "../connector/types.ts";

interface Options {
  stateFile: string;
  selectors: string[];
  serverUrl?: string;
}

function valueAfter(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index === -1 ? undefined : values[index + 1];
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function usage(): string {
  return [
    "Usage: npm run verify:protected-runtime -- --state-file <path> --selectors <a,b> [--server <url>]",
    "",
    "Reads a decrypted protected runtime fixture, authenticates its agent",
    "bearers, and proves the canonical post-cutover sessions can read and heartbeat.",
  ].join("\n");
}

function parseOptions(values: string[]): Options {
  if (values.includes("--help") || values.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  const stateFile = valueAfter(values, "--state-file");
  const selectors = csv(valueAfter(values, "--selectors"));
  if (!stateFile) throw new Error("--state-file is required.");
  if (selectors.length === 0) throw new Error("--selectors must contain at least one binding selector.");
  return {
    stateFile: resolve(stateFile),
    selectors,
    ...(valueAfter(values, "--server") ? { serverUrl: valueAfter(values, "--server") } : {}),
  };
}

async function assertPrivateStateFile(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Protected runtime state must be a regular file.");
  if (metadata.size > 5 * 1024 * 1024) throw new Error("Protected runtime state is unexpectedly large.");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Protected runtime state must not be readable by group or other users.");
  }
  await chmod(path, 0o600);
}

function isBinding(value: unknown): value is ConnectorBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ConnectorBinding>;
  return (
    typeof candidate.pairingId === "string" &&
    typeof candidate.serverUrl === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.requestedProfile?.handle === "string"
  );
}

function selectBindings(state: ConnectorState, selectors: string[]): ConnectorBinding[] {
  return selectors.map((selector) => {
    const matches = state.bindings.filter((binding) =>
      binding.pairingId === selector ||
      binding.bindingId === selector ||
      binding.requestedProfile.handle === selector,
    );
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one protected runtime binding for ${selector}; found ${matches.length}.`);
    }
    return matches[0]!;
  });
}

export async function verifyProtectedRuntime(values = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(values);
  await assertPrivateStateFile(options.stateFile);
  const store = new ConnectorStateStore(dirname(options.stateFile), { useKeychain: false });
  if (store.path !== options.stateFile) {
    throw new Error("--state-file must be the state.json file inside a dedicated directory.");
  }
  const state = await store.load();
  if (state.version !== 1 || !Array.isArray(state.bindings) || state.bindings.some((binding) => !isBinding(binding))) {
    throw new Error("Unsupported Meshr protected runtime state format.");
  }

  const selected = selectBindings(state, options.selectors);
  const verified = await Promise.all(selected.map(async (binding) => {
    if (binding.status !== "connected" || !binding.agentToken || !binding.sessionId) {
      throw new Error(`Protected runtime binding ${binding.requestedProfile.handle} is not connected with a session bearer.`);
    }
    const api = new MeshrApi(binding.serverUrl);
    if (options.serverUrl && api.serverUrl !== new MeshrApi(options.serverUrl).serverUrl) {
      throw new Error(`Protected runtime binding ${binding.requestedProfile.handle} points at an unexpected Meshr server.`);
    }
    const profile = await api.agentRequest<{ agent?: unknown }>(binding, "/v1/agent/profile");
    if (!profile || typeof profile !== "object" || !profile.agent || typeof profile.agent !== "object") {
      throw new Error(`Protected runtime profile read for ${binding.requestedProfile.handle} returned an invalid response.`);
    }
    const heartbeat = await api.heartbeatAgentSession(binding) as {
      sessionId?: unknown;
      status?: unknown;
      expiresAt?: unknown;
    };
    if (heartbeat.sessionId !== binding.sessionId || heartbeat.status !== "online") {
      throw new Error(`Protected runtime heartbeat for ${binding.requestedProfile.handle} did not confirm its canonical session.`);
    }
    return {
      handle: binding.requestedProfile.handle,
      sessionId: binding.sessionId,
      expiresAt: typeof heartbeat.expiresAt === "string" ? heartbeat.expiresAt : null,
    };
  }));
  process.stdout.write(`${JSON.stringify({ ok: true, verified }, null, 2)}\n`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  verifyProtectedRuntime().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
