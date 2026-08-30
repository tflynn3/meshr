#!/usr/bin/env node

import { sign } from "node:crypto";
import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshrApi, MeshrApiError } from "../connector/api.ts";
import { ConnectorStateStore } from "../connector/state.ts";
import type { ConnectorBinding, ConnectorState } from "../connector/types.ts";
import { sha256Bytes } from "../live/receipt.ts";

interface Options {
  stateFile: string;
  selectors: string[];
  evidencePaths: string[];
  serverUrl?: string;
  offlineWaitSeconds: number;
  outputPath?: string;
}

interface NativeSessionWitness {
  pairingId: string;
  handle: string;
  sessionId: string;
  onlineVerifiedAt: string;
  hostExitedAt?: string;
  offlineObservedAt?: string;
  offlineAfterSeconds?: number;
}

function usage(): string {
  return [
    "Usage: npm run verify:session-gates -- --state-file <path> --selectors <a,b> [--evidence <path>] [--server <url>] [--offline-wait-seconds 90] [--output <path>]",
    "",
    "Proves the actual persisted native session goes offline after host exit",
    "within 90 seconds, then separately checks signed-session supersession.",
  ].join("\n");
}

function valueAfter(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index === -1 ? undefined : values[index + 1];
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function allValuesAfter(values: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === name) {
      const value = values[index + 1];
      if (value) result.push(value);
      index += 1;
    }
  }
  return result;
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
  const waitValue = valueAfter(values, "--offline-wait-seconds") ?? "90";
  const offlineWaitSeconds = Number(waitValue);
  if (!Number.isSafeInteger(offlineWaitSeconds) || offlineWaitSeconds < 90 || offlineWaitSeconds > 600) {
    throw new Error("--offline-wait-seconds must be an integer from 90 to 600.");
  }
  return {
    stateFile: resolve(stateFile),
    selectors,
    evidencePaths: allValuesAfter(values, "--evidence").map(resolve),
    ...(valueAfter(values, "--server") ? { serverUrl: valueAfter(values, "--server") } : {}),
    offlineWaitSeconds,
    ...(valueAfter(values, "--output") ? { outputPath: resolve(valueAfter(values, "--output")!) } : {}),
  };
}

async function writeLifecycleOutput(path: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

function matches(binding: ConnectorBinding, selector: string): boolean {
  return binding.pairingId === selector || binding.bindingId === selector || binding.requestedProfile.handle === selector;
}

function selectBindings(state: ConnectorState, selectors: string[]): ConnectorBinding[] {
  return selectors.map((selector) => {
    const found = state.bindings.filter((binding) => matches(binding, selector));
    if (found.length !== 1) throw new Error(`Expected exactly one binding for ${selector}; found ${found.length}.`);
    const binding = found[0]!;
    if (binding.status !== "connected" || !binding.agentToken || !binding.privateKeyPem || !binding.pairingSecret) {
      throw new Error(`Binding ${selector} must be connected with signed session credentials.`);
    }
    return binding;
  });
}

async function assertPrivateStateFile(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Runtime state must be a regular file.");
  if (metadata.size > 5 * 1024 * 1024) throw new Error("Runtime state is unexpectedly large.");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Runtime state must not be readable by group or other users.");
  }
}

async function loadSessionWitnesses(paths: string[]): Promise<Map<string, NativeSessionWitness>> {
  const witnesses = new Map<string, NativeSessionWitness>();
  for (const path of paths) {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) {
      throw new Error(`Lifecycle evidence must be a bounded regular file: ${path}`);
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new Error(`Lifecycle evidence must be mode 0600: ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch {
      throw new Error(`Lifecycle evidence must contain valid JSON: ${path}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Lifecycle evidence must be a JSON object: ${path}`);
    }
    const record = parsed as Record<string, unknown>;
    const runtimeValues = record.kind === "openclaw-live"
      ? [record]
      : record.schemaVersion === 2 && Array.isArray(record.runtimes)
        ? record.runtimes
        : [];
    for (const runtime of runtimeValues) {
      if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) continue;
      const phases = Array.isArray((runtime as Record<string, unknown>).phases)
        ? (runtime as Record<string, unknown>).phases
        : [];
      for (const phase of phases) {
        if (!phase || typeof phase !== "object" || Array.isArray(phase)) continue;
        const value = phase as Record<string, unknown>;
        if (value.status !== "passed" || !value.nativeSession || typeof value.nativeSession !== "object" || Array.isArray(value.nativeSession)) continue;
        const binding = value.binding;
        const nativeSession = value.nativeSession as Record<string, unknown>;
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
        const pairingId = (binding as Record<string, unknown>).pairingId;
        const handle = (binding as Record<string, unknown>).handle;
        const sessionId = nativeSession.sessionId;
        const onlineVerifiedAt = nativeSession.onlineVerifiedAt;
        if (typeof pairingId !== "string" || typeof handle !== "string" || typeof sessionId !== "string" || typeof onlineVerifiedAt !== "string") continue;
        if (!Number.isFinite(Date.parse(onlineVerifiedAt))) {
          throw new Error(`Lifecycle evidence has an invalid online verification timestamp: ${path}`);
        }
        const hostExitedAt = typeof nativeSession.hostExitedAt === "string" ? nativeSession.hostExitedAt : undefined;
        const offlineObservedAt = typeof nativeSession.offlineObservedAt === "string" ? nativeSession.offlineObservedAt : undefined;
        const offlineAfterSeconds = typeof nativeSession.offlineAfterSeconds === "number" ? nativeSession.offlineAfterSeconds : undefined;
        if (hostExitedAt && !Number.isFinite(Date.parse(hostExitedAt))) {
          throw new Error(`Lifecycle evidence has an invalid host-exit timestamp: ${path}`);
        }
        if (offlineObservedAt && !Number.isFinite(Date.parse(offlineObservedAt))) {
          throw new Error(`Lifecycle evidence has an invalid offline timestamp: ${path}`);
        }
        if (offlineAfterSeconds !== undefined && (!Number.isFinite(offlineAfterSeconds) || offlineAfterSeconds < 0 || offlineAfterSeconds > 600)) {
          throw new Error(`Lifecycle evidence has an invalid offline duration: ${path}`);
        }
        witnesses.set(pairingId, {
          pairingId,
          handle,
          sessionId,
          onlineVerifiedAt,
          ...(hostExitedAt ? { hostExitedAt } : {}),
          ...(offlineObservedAt ? { offlineObservedAt } : {}),
          ...(offlineAfterSeconds !== undefined ? { offlineAfterSeconds } : {}),
        });
      }
    }
  }
  return witnesses;
}

async function startSecondSession(binding: ConnectorBinding, serverUrl?: string): Promise<{
  predecessorToken: string;
  successor: ConnectorBinding;
}> {
  const api = new MeshrApi(binding.serverUrl);
  if (serverUrl && api.serverUrl !== new MeshrApi(serverUrl).serverUrl) {
    throw new Error(`Binding ${binding.pairingId} is connected to an unexpected Meshr server.`);
  }
  const challenge = await api.createChallenge(binding);
  const signature = sign(null, Buffer.from(challenge.message, "utf8"), binding.privateKeyPem).toString("base64url");
  const session = await api.createAgentSession({ binding, challengeId: challenge.challengeId, signature });
  return {
    predecessorToken: binding.agentToken!,
    successor: {
      ...binding,
      status: "connected",
      agentToken: session.token,
      agentTokenExpiresAt: session.expiresAt,
      sessionId: session.sessionId,
      bindingId: session.bindingId ?? binding.bindingId,
      agentId: session.agent.id,
    },
  };
}

async function assertPredecessorFenced(binding: ConnectorBinding, predecessorToken: string): Promise<void> {
  const api = new MeshrApi(binding.serverUrl);
  try {
    await api.agentRequest({ ...binding, agentToken: predecessorToken }, "/v1/agent/profile");
  } catch (error) {
    if (error instanceof MeshrApiError && error.status === 401 && (error.code === "session_superseded" || error.message.includes("superseded"))) return;
    throw error;
  }
  throw new Error(`Predecessor session for ${binding.requestedProfile.handle} remained authorized after supersession.`);
}

async function assertSuccessorHeartbeat(binding: ConnectorBinding): Promise<void> {
  await new MeshrApi(binding.serverUrl).heartbeatAgentSession(binding);
}

async function assertNativeSessionOnline(
  binding: ConnectorBinding,
  witness?: NativeSessionWitness,
): Promise<void> {
  // The state file is reread after the native host exits. A successful session
  // read here proves this is the bearer/session the host actually left behind,
  // rather than a freshly minted test token.
  if (witness && witness.sessionId !== binding.sessionId) {
    throw new Error(`Lifecycle evidence for ${binding.requestedProfile.handle} does not match the persisted host session.`);
  }
  const api = new MeshrApi(binding.serverUrl);
  try {
    const session = await api.agentRequest<{ sessionId?: string }>(binding, "/v1/agent/session");
    if (session.sessionId !== binding.sessionId) {
      throw new Error(`Native session probe for ${binding.requestedProfile.handle} returned an unexpected session.`);
    }
    const pairing = await api.pairingStatus(binding);
    if (pairing.status !== "connected" || pairing.agentId !== binding.agentId) {
      throw new Error(`Native host did not leave ${binding.requestedProfile.handle} in a connected pairing state.`);
    }
  } catch (error) {
    // A phase can legitimately be more than 90 seconds old by the time the
    // other runtime finishes. Its passed phase witness proves it was online
    // immediately after host exit; accept only the exact offline response and
    // only when the pairing remains approved (not revoked or superseded).
    if (!witness || !(error instanceof MeshrApiError) || error.status !== 401 || error.code !== "agent_authentication_failed" || !/offline|expired/i.test(error.message)) {
      throw error;
    }
    const pairing = await api.pairingStatus(binding);
    if (pairing.status !== "approved" || pairing.agentId !== binding.agentId) {
      throw new Error(`Native host session for ${binding.requestedProfile.handle} was not observed offline; pairing status is ${pairing.status}.`);
    }
  }
}

async function assertOfflineAfterWait(
  binding: ConnectorBinding,
  waitSeconds: number,
  witness?: NativeSessionWitness,
): Promise<void> {
  const verifiedAt = witness
    ? Date.parse(witness.hostExitedAt ?? witness.onlineVerifiedAt)
    : Date.now();
  if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() + 5_000) {
    throw new Error(`Lifecycle evidence for ${binding.requestedProfile.handle} has an invalid future timestamp.`);
  }
  const witnessOfflineAt = witness?.offlineObservedAt ? Date.parse(witness.offlineObservedAt) : NaN;
  const witnessOfflineSeconds = witness?.offlineAfterSeconds;
  const hasBoundOfflineWitness =
    Number.isFinite(witnessOfflineAt) &&
    Number.isFinite(witnessOfflineSeconds) &&
    witnessOfflineSeconds! >= 0 &&
    witnessOfflineSeconds! <= waitSeconds &&
    witnessOfflineAt! >= verifiedAt &&
    witnessOfflineAt! <= verifiedAt + waitSeconds * 1_000;
  const deadline = verifiedAt + waitSeconds * 1_000;
  if (hasBoundOfflineWitness) {
    const api = new MeshrApi(binding.serverUrl);
    const pairing = await api.pairingStatus(binding);
    if (pairing.status !== "approved" || pairing.agentId !== binding.agentId) {
      throw new Error(`Native host session for ${binding.requestedProfile.handle} did not transition to approved/offline state.`);
    }
    try {
      await api.agentRequest(binding, "/v1/agent/session");
    } catch (error) {
      if (
        error instanceof MeshrApiError &&
        error.status === 401 &&
        error.code === "agent_authentication_failed" &&
        /offline|expired/i.test(error.message)
      ) {
        return;
      }
      throw error;
    }
    throw new Error(`Session for ${binding.requestedProfile.handle} remained online after its recorded offline transition.`);
  }
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await new Promise((resolveWait) => setTimeout(resolveWait, Math.min(10_000, Math.max(100, remaining))));
  }
  const api = new MeshrApi(binding.serverUrl);
  const pairing = await api.pairingStatus(binding);
  if (pairing.status !== "approved" || pairing.agentId !== binding.agentId) {
    throw new Error(`Native host session for ${binding.requestedProfile.handle} did not transition to approved/offline state.`);
  }
  try {
    await api.agentRequest(binding, "/v1/agent/session");
  } catch (error) {
    if (
      error instanceof MeshrApiError &&
      error.status === 401 &&
      error.code === "agent_authentication_failed" &&
      /offline|expired/i.test(error.message)
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`Session for ${binding.requestedProfile.handle} remained online after ${waitSeconds} seconds without a heartbeat.`);
}

async function assertSignedSessionSupersession(
  binding: ConnectorBinding,
): Promise<void> {
  // Keep the control-plane supersession check separate from the native-host
  // lifecycle check above. The native token is never superseded before the
  // offline assertion, so an orphaned host heartbeat cannot make this gate
  // pass accidentally.
  const first = await startSecondSession(binding);
  const second = await startSecondSession(first.successor);
  await assertPredecessorFenced(first.successor, second.predecessorToken);
  await assertSuccessorHeartbeat(second.successor);
}

export async function verifyRuntimeSessionGates(values = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(values);
  await assertPrivateStateFile(options.stateFile);
  const store = new ConnectorStateStore(dirname(options.stateFile), { useKeychain: false });
  if (store.path !== options.stateFile) throw new Error("--state-file must be the state.json file inside its state directory.");
  const state = await store.load();
  if (state.version !== 1 || !Array.isArray(state.bindings)) throw new Error("Unsupported Meshr runtime state format.");
  const selected = selectBindings(state, options.selectors);
  const witnesses = await loadSessionWitnesses(options.evidencePaths);
  const selectedWitnesses = selected.map((binding) => {
    const witness = witnesses.get(binding.pairingId);
    if (options.evidencePaths.length > 0 && !witness) {
      throw new Error(`Lifecycle evidence is missing a passed native session witness for ${binding.requestedProfile.handle}.`);
    }
    return witness;
  });
  await Promise.all(selected.map((binding, index) => assertNativeSessionOnline(binding, selectedWitnesses[index])));
  await Promise.all(selected.map((binding, index) => assertOfflineAfterWait(binding, options.offlineWaitSeconds, selectedWitnesses[index])));
  await Promise.all(selected.map((binding) => assertSignedSessionSupersession(binding)));
  const result: Record<string, unknown> = {
    ok: true,
    checked: selected.map((binding) => binding.requestedProfile.handle),
    nativeHostLifecycle: "actual_session_offline",
    supersession: "signed_predecessor_fenced",
    offlineAfterSeconds: options.offlineWaitSeconds,
  };
  if (options.outputPath) {
    if (options.evidencePaths.length !== 1) {
      throw new Error("--output requires exactly one --evidence file so the lifecycle receipt can be source-bound.");
    }
    const sourceBytes = await readFile(options.evidencePaths[0]!);
    let sourceValue: unknown;
    try {
      sourceValue = JSON.parse(sourceBytes.toString("utf8")) as unknown;
    } catch {
      throw new Error("Lifecycle evidence source is not valid JSON.");
    }
    const runtime = sourceValue && typeof sourceValue === "object" && !Array.isArray(sourceValue)
      ? (sourceValue as Record<string, unknown>).kind === "openclaw-live"
        ? "openclaw"
        : Array.isArray((sourceValue as Record<string, unknown>).runtimes) &&
            ((sourceValue as Record<string, unknown>).runtimes as unknown[]).length === 1 &&
            (sourceValue as Record<string, unknown>).runtimes[0] &&
            typeof (sourceValue as Record<string, unknown>).runtimes[0] === "object"
          ? ((sourceValue as Record<string, unknown>).runtimes[0] as Record<string, unknown>).runtime
          : undefined
      : undefined;
    if (typeof runtime !== "string" || !runtime.trim()) {
      throw new Error("Lifecycle evidence source must contain exactly one runtime.");
    }
    const lifecycleWitnesses = selectedWitnesses.map((witness, index) => {
      const binding = selected[index]!;
      if (
        !witness ||
        witness.handle !== binding.requestedProfile.handle ||
        !witness.hostExitedAt ||
        !witness.offlineObservedAt ||
        witness.offlineAfterSeconds === undefined
      ) {
        throw new Error(`Lifecycle evidence for ${binding.requestedProfile.handle} is missing a phase-bound offline witness.`);
      }
      return {
        pairingId: witness.pairingId,
        handle: witness.handle,
        sessionId: witness.sessionId,
        hostExitedAt: witness.hostExitedAt,
        onlineVerifiedAt: witness.onlineVerifiedAt,
        offlineObservedAt: witness.offlineObservedAt,
        offlineAfterSeconds: witness.offlineAfterSeconds,
      };
    });
    result.runtime = runtime;
    result.sourceSha256 = sha256Bytes(sourceBytes);
    result.witnesses = lifecycleWitnesses;
    await writeLifecycleOutput(options.outputPath, result);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  verifyRuntimeSessionGates().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
