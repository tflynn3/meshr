#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmod, lstat, rename, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackHostname } from "../connector/api.ts";

type ReplicaLabel = "a" | "b";
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface RequestResult {
  status: number;
  body: Json;
  code?: string;
  retryAfter: number;
}

interface HookResult {
  exitCode: number;
  durationMs: number;
}

const HOOK_FORCE_KILL_GRACE_MS = 1_000;

function signalHookTree(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill(signal);
}

export interface MultiReplicaEvidence {
  schemaVersion: 1;
  kind: "meshr-multi-replica-security-verification";
  ok: boolean;
  executed: boolean;
  mode: "dry-run" | "live";
  startedAt?: string;
  completedAt?: string;
  checks: string[];
  configuration: {
    logicalOrigin: string;
    logicalHost: string;
    expectedReleaseSha: string;
    podConnectionFingerprints: { a: string; b: string };
    meshId: string;
    topicId: string;
    agentHandle: string;
    runId: string;
    quotaBurst: number;
    expectedAgentBurstLimit: number;
    restartHookConfigured: boolean;
  };
  results?: {
    connectivity?: {
      a: number;
      b: number;
      instanceFingerprints: { a: string; b: string };
      finalInstanceFingerprints?: { a: string; b: string };
      observedReleaseShas: {
        initial: { a: string; b: string };
        final?: { a: string; b: string };
      };
    };
    authority?: {
      humanSessionReplica: ReplicaLabel;
      pairingCreatedReplica: ReplicaLabel;
      pairingApprovedReplica: ReplicaLabel;
      sessionClaimedReplica: ReplicaLabel;
      bearerUsedReplica: ReplicaLabel;
      agentIdFingerprint: string;
    };
    idempotency?: {
      exactReplayStatuses: number[];
      conflictStatuses: number[];
      conflictWinner?: ReplicaLabel;
      winnerReplayReplica?: ReplicaLabel;
      winnerReplayStatus?: number;
      loserRetryStatus?: number;
    };
    restart?: {
      configured: boolean;
      exitCode?: number;
      durationMs?: number;
      failoverReplica: ReplicaLabel;
      failoverStatus: number;
    };
    quota?: {
      totalSubmitted: number;
      accepted: number;
      agentLimited: number;
      accountLimited: number;
      globalLimited: number;
      perReplica: Record<ReplicaLabel, {
        submitted: number;
        accepted: number;
        agentLimited: number;
      }>;
    };
    revocation?: {
      replica: ReplicaLabel;
      status: number;
      revokedPairings: number;
      revokedSessions: number;
      retryReplica: ReplicaLabel;
      retryStatus: number;
      otherReplicaStatus: number;
    };
    failureCleanup?: {
      revocationAttempted: boolean;
      revocationStatus?: number;
      logoutStatus?: number;
    };
  };
  failure?: { stage: string; message: string };
}

interface MultiReplicaDependencies {
  /** Dry-run tests use this sentinel to prove no network adapter is touched. */
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  runHook?: (
    path: string,
    timeoutMs: number,
    environment: NodeJS.ProcessEnv,
  ) => Promise<HookResult>;
  now?: () => Date;
}

interface Options {
  execute: boolean;
  podAUrl: string;
  podBUrl: string;
  origin: string;
  logicalHost: string;
  meshId: string;
  topicId: string;
  agentHandle: string;
  runId: string;
  expectedReleaseSha: string;
  socialProvider: "google" | "github";
  idTokenEnvironment: string;
  outputPath?: string;
  restartHook?: string;
  restartTimeoutMs: number;
  requestTimeoutMs: number;
  settleMs: number;
  quotaBurst: number;
  expectedAgentBurstLimit: number;
}

const plannedChecks = [
  "pod A and pod B health through distinct connection URLs, pod fingerprints, and the expected release SHA",
  "human session and pairing authority cross-replica visibility",
  "pod-A claim accepted by pod B",
  "simultaneous exact-replay and conflicting idempotency races",
  "optional operator-owned restart hook followed by pod-B failover use",
  "split cross-pod aggregate agent quota burst",
  "pod-B revocation followed by denied retries on both pods",
];

function usage(): string {
  return [
    "Usage: npm run verify:multi-replica -- --pod-a-url <connection-origin> --pod-b-url <connection-origin> --origin <logical-https-origin> --logical-host <host> --mesh-id <private-mesh> --topic-id <topic> --agent-handle <handle> --run-id <id> --expected-release-sha <40-lowercase-hex> [--execute --social-provider google|github --output <path>]",
    "",
    "The default is a non-passing, network-free dry run. Live mutation requires --execute,",
    "a fresh identity token in MESHR_MULTI_REPLICA_ID_TOKEN, and a mode-0600 evidence path.",
    "HTTP connection origins are accepted only on loopback (for direct pod port-forwards);",
    "the logical HTTPS Origin and Host remain independent from those connection URLs.",
    "",
    "Optional: --id-token-env <NAME> --restart-hook <absolute-executable>",
    "          --restart-timeout-seconds <30..600> --request-timeout-seconds <5..60>",
    "          --quota-settle-seconds <0..30> --quota-burst <11..30>",
    "          --expected-agent-burst-limit <1..29>",
  ].join("\n");
}

function valueAfter(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index === -1 ? undefined : values[index + 1];
}

function required(values: string[], name: string): string {
  const value = valueAfter(values, name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedInteger(
  values: string[],
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = valueAfter(values, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function connectionUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a canonical HTTP(S) origin.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "") ||
    value !== url.origin
  ) {
    throw new Error(
      `${name} must be an HTTP(S) origin without credentials, path, query, or fragment.`,
    );
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(`${name} may use cleartext HTTP only for a loopback port-forward.`);
  }
  return url.origin;
}

function safeResourceId(value: string, name: string): string {
  if (value.length < 1 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`${name} must be a bounded Meshr resource identifier.`);
  }
  return value;
}

function validateArguments(values: string[]): void {
  const flags = new Set(["--execute"]);
  const valued = new Set([
    "--pod-a-url",
    "--pod-b-url",
    "--origin",
    "--logical-host",
    "--mesh-id",
    "--topic-id",
    "--agent-handle",
    "--run-id",
    "--expected-release-sha",
    "--social-provider",
    "--id-token-env",
    "--output",
    "--restart-hook",
    "--restart-timeout-seconds",
    "--request-timeout-seconds",
    "--quota-settle-seconds",
    "--quota-burst",
    "--expected-agent-burst-limit",
  ]);
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index]!;
    if (!flags.has(option) && !valued.has(option)) {
      throw new Error(`Unknown option ${option}.`);
    }
    if (seen.has(option)) throw new Error(`${option} may be supplied only once.`);
    seen.add(option);
    if (!valued.has(option)) continue;
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value.`);
    }
    index += 1;
  }
}

function parseOptions(values: string[]): Options {
  validateArguments(values);
  const originInput = required(values, "--origin");
  let originUrl: URL;
  try {
    originUrl = new URL(originInput);
  } catch {
    throw new Error("--origin must be a canonical non-loopback HTTPS origin.");
  }
  if (
    originUrl.protocol !== "https:" ||
    originUrl.username ||
    originUrl.password ||
    originUrl.pathname !== "/" ||
    originUrl.search ||
    originUrl.hash ||
    isLoopbackHostname(originUrl.hostname) ||
    originInput !== originUrl.origin
  ) {
    throw new Error(
      "--origin must be a non-loopback HTTPS origin without credentials, path, query, or fragment.",
    );
  }
  const logicalHost = required(values, "--logical-host").toLowerCase();
  if (logicalHost !== originUrl.host.toLowerCase()) {
    throw new Error(
      "--logical-host must exactly match the host (and optional port) in --origin.",
    );
  }
  const agentHandle = required(values, "--agent-handle").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])$/.test(agentHandle)) {
    throw new Error(
      "--agent-handle must be a lowercase Meshr handle from 2 to 32 characters.",
    );
  }
  const runId = required(values, "--run-id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,47}$/.test(runId)) {
    throw new Error("--run-id must contain 8 to 48 safe identifier characters.");
  }
  const expectedReleaseSha = valueAfter(values, "--expected-release-sha");
  if (expectedReleaseSha === undefined || expectedReleaseSha.length === 0) {
    throw new Error("--expected-release-sha is required.");
  }
  if (!/^[a-f0-9]{40}$/.test(expectedReleaseSha)) {
    throw new Error("--expected-release-sha must be exactly 40 lowercase hexadecimal characters.");
  }
  const podAUrl = connectionUrl(required(values, "--pod-a-url"), "--pod-a-url");
  const podBUrl = connectionUrl(required(values, "--pod-b-url"), "--pod-b-url");
  if (podAUrl === podBUrl) {
    throw new Error("--pod-a-url and --pod-b-url must be distinct connection origins.");
  }
  const provider = (valueAfter(values, "--social-provider") ?? "google").trim();
  if (provider !== "google" && provider !== "github") {
    throw new Error("--social-provider must be google or github.");
  }
  const idTokenEnvironment = (
    valueAfter(values, "--id-token-env") ?? "MESHR_MULTI_REPLICA_ID_TOKEN"
  ).trim();
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(idTokenEnvironment)) {
    throw new Error("--id-token-env must name an uppercase environment variable.");
  }
  const restartHookValue = valueAfter(values, "--restart-hook")?.trim();
  if (restartHookValue && !isAbsolute(restartHookValue)) {
    throw new Error("--restart-hook must be an absolute executable path.");
  }
  const quotaBurst = boundedInteger(values, "--quota-burst", 12, 11, 30);
  const expectedAgentBurstLimit = boundedInteger(
    values,
    "--expected-agent-burst-limit",
    10,
    1,
    29,
  );
  if (quotaBurst <= expectedAgentBurstLimit) {
    throw new Error("--quota-burst must exceed --expected-agent-burst-limit.");
  }
  return {
    execute: values.includes("--execute"),
    podAUrl,
    podBUrl,
    origin: originUrl.origin,
    logicalHost,
    meshId: safeResourceId(required(values, "--mesh-id"), "--mesh-id"),
    topicId: safeResourceId(required(values, "--topic-id"), "--topic-id"),
    agentHandle,
    runId,
    expectedReleaseSha,
    socialProvider: provider,
    idTokenEnvironment,
    ...(valueAfter(values, "--output")
      ? { outputPath: resolve(valueAfter(values, "--output")!) }
      : {}),
    ...(restartHookValue ? { restartHook: restartHookValue } : {}),
    restartTimeoutMs:
      boundedInteger(values, "--restart-timeout-seconds", 180, 30, 600) * 1_000,
    requestTimeoutMs:
      boundedInteger(values, "--request-timeout-seconds", 15, 5, 60) * 1_000,
    settleMs:
      boundedInteger(values, "--quota-settle-seconds", 11, 0, 30) * 1_000,
    quotaBurst,
    expectedAgentBurstLimit,
  };
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function baseEvidence(options: Options): MultiReplicaEvidence {
  return {
    schemaVersion: 1,
    kind: "meshr-multi-replica-security-verification",
    ok: false,
    executed: false,
    mode: options.execute ? "live" : "dry-run",
    checks: [...plannedChecks],
    configuration: {
      logicalOrigin: options.origin,
      logicalHost: options.logicalHost,
      expectedReleaseSha: options.expectedReleaseSha,
      podConnectionFingerprints: {
        a: fingerprint(options.podAUrl),
        b: fingerprint(options.podBUrl),
      },
      meshId: options.meshId,
      topicId: options.topicId,
      agentHandle: options.agentHandle,
      runId: options.runId,
      quotaBurst: options.quotaBurst,
      expectedAgentBurstLimit: options.expectedAgentBurstLimit,
      restartHookConfigured: Boolean(options.restartHook),
    },
  };
}

class CookieJar {
  readonly #values = new Map<string, string>();

  capture(header: string | string[] | undefined): void {
    const values = Array.isArray(header)
      ? header
      : (header ?? "")
          .split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/)
          .filter(Boolean);
    for (const value of values) {
      const first = value.split(";", 1)[0]?.trim() ?? "";
      const separator = first.indexOf("=");
      if (separator <= 0) continue;
      const name = first.slice(0, separator);
      const cookieValue = first.slice(separator + 1);
      if (!cookieValue || /(?:^|;)\s*max-age=0(?:;|$)/i.test(value)) {
        this.#values.delete(name);
      } else {
        this.#values.set(name, cookieValue);
      }
    }
  }

  header(): string {
    return [...this.#values.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}

class ReplicaClient {
  readonly label: ReplicaLabel;
  readonly #connectionUrl: string;
  readonly #origin: string;
  readonly #logicalHost: string;
  readonly #logicalHostname: string;
  readonly #cookies: CookieJar;
  readonly #timeoutMs: number;

  constructor(input: {
    label: ReplicaLabel;
    connectionUrl: string;
    origin: string;
    logicalHost: string;
    cookies: CookieJar;
    timeoutMs: number;
  }) {
    this.label = input.label;
    this.#connectionUrl = input.connectionUrl;
    this.#origin = input.origin;
    this.#logicalHost = input.logicalHost;
    this.#logicalHostname = new URL(input.origin).hostname;
    this.#cookies = input.cookies;
    this.#timeoutMs = input.timeoutMs;
  }

  async request(
    path: string,
    input: {
      method?: string;
      body?: unknown;
      authorization?: string;
      idempotencyKey?: string;
      csrf?: string;
    } = {},
  ): Promise<RequestResult> {
    if (!path.startsWith("/")) throw new Error("Verification request paths must be absolute.");
    const headers: Record<string, string> = {
      accept: "application/json",
      host: this.#logicalHost,
      origin: this.#origin,
      referer: `${this.#origin}/`,
      "x-meshr-contract-version": "1",
    };
    const cookie = this.#cookies.header();
    if (cookie) headers.cookie = cookie;
    const encodedBody = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (encodedBody !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(encodedBody));
    }
    if (input.authorization) headers.authorization = input.authorization;
    if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
    if (input.csrf) headers["x-meshr-csrf"] = input.csrf;
    const target = new URL(path, `${this.#connectionUrl}/`);
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const wireResponse = await new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      text: string;
    }>((resolveResponse, rejectResponse) => {
      const request = transport({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        path: `${target.pathname}${target.search}`,
        method: input.method ?? "GET",
        headers,
        ...(target.protocol === "https:" ? { servername: this.#logicalHostname } : {}),
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const value = Buffer.from(chunk);
          size += value.length;
          if (size > 1_048_576) {
            request.destroy(new Error("response_too_large"));
            return;
          }
          chunks.push(value);
        });
        response.once("end", () => resolveResponse({
          status: response.statusCode ?? 0,
          headers: response.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      request.setTimeout(this.#timeoutMs, () => request.destroy(new Error("request_timeout")));
      request.once("error", rejectResponse);
      request.end(encodedBody);
    }).catch(() => {
      throw new Error(`Replica ${this.label.toUpperCase()} request transport failed.`);
    });
    if (wireResponse.headers["x-meshr-contract-version"] !== "1") {
      throw new Error(
        `Replica ${this.label.toUpperCase()} omitted the expected Meshr contract response header.`,
      );
    }
    this.#cookies.capture(wireResponse.headers["set-cookie"]);
    const contentLength = Number(wireResponse.headers["content-length"] ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 1_048_576) {
      throw new Error(`Replica ${this.label.toUpperCase()} returned an oversized response.`);
    }
    const text = wireResponse.text;
    let body: Json = null;
    if (text) {
      try {
        body = JSON.parse(text) as Json;
      } catch {
        throw new Error(`Replica ${this.label.toUpperCase()} returned non-JSON evidence.`);
      }
    }
    const error = body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).error
      : undefined;
    const code = error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>).code
      : undefined;
    return {
      status: wireResponse.status,
      body,
      ...(typeof code === "string" ? { code } : {}),
      retryAfter: Number(wireResponse.headers["retry-after"] ?? "0"),
    };
  }
}

function objectBody(value: Json, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid JSON object.`);
  }
  return value as Record<string, unknown>;
}

function healthInstanceFingerprint(result: RequestResult, label: string): string {
  const value = objectBody(result.body, label).instanceFingerprint;
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) {
    throw new Error(
      `${label} omitted the Downward API-backed pod instance fingerprint.`,
    );
  }
  return value;
}

function healthReleaseSha(result: RequestResult, label: string): string {
  const body = objectBody(result.body, label);
  if (body.status !== "ok") {
    throw new Error(`${label} did not report Meshr API health.`);
  }
  const value = body.releaseSha;
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) {
    throw new Error(`${label} omitted a valid deployed public release SHA.`);
  }
  return value;
}

function assertExpectedReleaseShas(
  observed: { a: string; b: string },
  expected: string,
  phase: "initial" | "final",
): void {
  if (observed.a !== observed.b) {
    throw new Error(
      `Replica health responses reported mixed release SHAs during the ${phase} provenance check; expected ${expected}.`,
    );
  }
  if (observed.a !== expected) {
    throw new Error(
      `Replica health responses reported stale release SHA ${observed.a} during the ${phase} provenance check; expected ${expected}.`,
    );
  }
}

function assertDistinctInstanceFingerprints(
  observed: { a: string; b: string },
  phase: "initial" | "final",
): void {
  if (observed.a === observed.b) {
    throw new Error(
      `Replica A and replica B resolved to the same Kubernetes pod instance during the ${phase} provenance check.`,
    );
  }
}

function assertExpectedFinalInstances(
  initial: { a: string; b: string },
  final: { a: string; b: string },
  restartHookConfigured: boolean,
): void {
  if (!restartHookConfigured) {
    if (final.a !== initial.a || final.b !== initial.b) {
      throw new Error(
        "A replica connection was rebound during a run without a restart hook.",
      );
    }
    return;
  }
  if (final.a === initial.a) {
    throw new Error(
      "The restart hook did not replace replica A with a new Kubernetes pod instance.",
    );
  }
  if (final.b !== initial.b) {
    throw new Error(
      "Replica B changed while the restart hook was scoped to replica A.",
    );
  }
}

function expectStatus(
  result: RequestResult,
  expected: number | number[],
  label: string,
): void {
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(result.status)) {
    throw new Error(
      `${label} returned HTTP ${result.status}; expected ${accepted.join(" or ")}.`,
    );
  }
}

async function assertRestartHook(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 1024 * 1024) {
    throw new Error("--restart-hook must be a bounded regular file.");
  }
  if (process.platform !== "win32") {
    if ((metadata.mode & 0o022) !== 0) {
      throw new Error("--restart-hook must not be writable by group or other users.");
    }
    if ((metadata.mode & 0o100) === 0) {
      throw new Error("--restart-hook must be executable by its owner.");
    }
  }
}

export async function runRestartHook(
  path: string,
  timeoutMs: number,
  environment: NodeJS.ProcessEnv,
): Promise<HookResult> {
  const started = Date.now();
  return await new Promise<HookResult>((resolveHook, rejectHook) => {
    let settled = false;
    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timedOutExitCode: number | null | undefined;
    const child = spawn(path, [], {
      shell: false,
      stdio: "ignore",
      env: environment,
      detached: process.platform !== "win32",
    });

    const finish = (error: Error | undefined, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (error) rejectHook(error);
      else resolveHook({ exitCode: exitCode ?? 1, durationMs: Date.now() - started });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      signalHookTree(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined;
        signalHookTree(child, "SIGKILL");
        if (timedOutExitCode !== undefined) {
          finish(
            new Error("The restart hook exceeded its bounded timeout."),
            timedOutExitCode,
          );
        }
      }, HOOK_FORCE_KILL_GRACE_MS);
    }, timeoutMs);
    child.once("error", () => {
      finish(new Error("The restart hook could not be executed."), null);
    });
    child.once("close", (code) => {
      if (timedOut && forceKillTimer) {
        timedOutExitCode = code;
        return;
      }
      // A successful operator hook must finish its own work. Do not allow it
      // to leave an untracked disruption helper running after the gate moves
      // on to failover assertions.
      if (!timedOut) signalHookTree(child, "SIGKILL");
      finish(
        timedOut
          ? new Error("The restart hook exceeded its bounded timeout.")
          : undefined,
        code,
      );
    });
  });
}

async function writeEvidence(path: string, evidence: MultiReplicaEvidence): Promise<void> {
  const parent = dirname(path);
  const parentMetadata = await stat(parent);
  if (!parentMetadata.isDirectory()) throw new Error("Evidence parent must be a directory.");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function assertEvidenceTarget(path: string): Promise<void> {
  const parentMetadata = await stat(dirname(path));
  if (!parentMetadata.isDirectory()) throw new Error("Evidence parent must be a directory.");
  if (process.platform !== "win32" && (parentMetadata.mode & 0o022) !== 0) {
    throw new Error("Evidence parent must not be writable by group or other users.");
  }
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("--output must name a new evidence file.");
}

function profileTagline(body: Json): string | undefined {
  const record = objectBody(body, "agent profile mutation");
  const agent = record.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) return undefined;
  const tagline = (agent as Record<string, unknown>).tagline;
  return typeof tagline === "string" ? tagline : undefined;
}

function redactedFailure(error: unknown, sensitiveValues: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of sensitiveValues.filter(Boolean)) {
    message = message.split(value).join("[redacted]");
  }
  return message.slice(0, 512);
}

export async function verifyMultiReplica(
  values = process.argv.slice(2),
  dependencies: MultiReplicaDependencies = {},
): Promise<MultiReplicaEvidence> {
  const options = parseOptions(values);
  const evidence = baseEvidence(options);
  if (!options.execute) return evidence;
  if (!options.outputPath) {
    throw new Error("--output is required with --execute so live evidence cannot be discarded.");
  }
  if (options.meshId === "mesh-public") {
    throw new Error("Live multi-replica verification refuses to write to mesh-public.");
  }
  const idToken = process.env[options.idTokenEnvironment]?.trim() ?? "";
  if (!idToken) {
    throw new Error(
      `--execute requires a fresh social identity token in ${options.idTokenEnvironment}.`,
    );
  }
  await assertEvidenceTarget(options.outputPath);
  if (options.restartHook) await assertRestartHook(options.restartHook);

  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const hookRunner = dependencies.runHook ?? runRestartHook;
  const now = dependencies.now ?? (() => new Date());
  const cookies = new CookieJar();
  const a = new ReplicaClient({
    label: "a",
    connectionUrl: options.podAUrl,
    origin: options.origin,
    logicalHost: options.logicalHost,
    cookies,
    timeoutMs: options.requestTimeoutMs,
  });
  const b = new ReplicaClient({
    label: "b",
    connectionUrl: options.podBUrl,
    origin: options.origin,
    logicalHost: options.logicalHost,
    cookies,
    timeoutMs: options.requestTimeoutMs,
  });
  const sensitiveValues = [idToken];
  let stage = "initialization";
  let cleanupAgentId: string | undefined;
  let cleanupCsrf: string | undefined;
  evidence.startedAt = now().toISOString();
  evidence.executed = true;
  evidence.results = {};

  try {
    stage = "replica connectivity";
    const [healthA, healthB] = await Promise.all([
      a.request("/healthz"),
      b.request("/healthz"),
    ]);
    expectStatus(healthA, 200, "replica A health");
    expectStatus(healthB, 200, "replica B health");
    const instanceA = healthInstanceFingerprint(healthA, "replica A health");
    const instanceB = healthInstanceFingerprint(healthB, "replica B health");
    const initialReleaseShas = {
      a: healthReleaseSha(healthA, "replica A health"),
      b: healthReleaseSha(healthB, "replica B health"),
    };
    evidence.results.connectivity = {
      a: healthA.status,
      b: healthB.status,
      instanceFingerprints: { a: instanceA, b: instanceB },
      observedReleaseShas: { initial: initialReleaseShas },
    };
    assertExpectedReleaseShas(
      initialReleaseShas,
      options.expectedReleaseSha,
      "initial",
    );
    assertDistinctInstanceFingerprints({ a: instanceA, b: instanceB }, "initial");

    stage = "social session exchange";
    const state = await a.request("/v1/auth/state", { method: "POST" });
    expectStatus(state, 201, "social auth state");
    const stateValue = String(objectBody(state.body, "social auth state").state ?? "");
    if (!stateValue) throw new Error("Social auth state omitted its value.");
    sensitiveValues.push(stateValue);
    const session = await a.request("/v1/sessions/social", {
      method: "POST",
      body: {
        provider: options.socialProvider,
        idToken,
        state: stateValue,
      },
    });
    expectStatus(session, 201, "social session exchange");
    const csrf = String(objectBody(session.body, "social session exchange").csrfToken ?? "");
    if (!csrf) throw new Error("Social session exchange omitted its CSRF token.");
    sensitiveValues.push(csrf, cookies.header());
    cleanupCsrf = csrf;
    const crossReplicaHuman = await b.request("/v1/me");
    expectStatus(crossReplicaHuman, 200, "cross-replica human session read");

    stage = "pairing creation and claim";
    const profile = {
      name: "Meshr Multi-Replica Verifier",
      handle: options.agentHandle,
      tagline: "A disposable multi-replica verification identity.",
      interests: ["verification"],
      personality: "Deterministic, bounded, and careful.",
      attention: {
        browse: "public",
        rootPosts: "autonomous",
        replies: "autonomous",
        notes: "Private release verification only.",
      },
    };
    const keyPair = generateKeyPairSync("ed25519");
    const publicKey = keyPair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const pairing = await a.request("/v1/pairings", {
      method: "POST",
      body: {
        runtime: "local",
        label: "multi-replica verification",
        externalSubject: `multi-replica:${options.runId}`,
        publicKey,
        definitionDigest: createHash("sha256")
          .update(JSON.stringify(profile))
          .digest("hex"),
        profile,
      },
    });
    expectStatus(pairing, 201, "pairing creation on replica A");
    const pairingBody = objectBody(pairing.body, "pairing creation");
    const pairingId = String(pairingBody.pairingId ?? "");
    const pairingSecret = String(pairingBody.pairingSecret ?? "");
    if (!pairingId || !pairingSecret) {
      throw new Error("Pairing creation omitted its credentials.");
    }
    sensitiveValues.push(
      pairingSecret,
      keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    const pairingAuthorization = `Pairing ${pairingSecret}`;
    const approval = await b.request(
      `/v1/pairings/${encodeURIComponent(pairingId)}/approve`,
      {
        method: "POST",
        csrf,
        body: { profile, acknowledgeAutonomous: true },
      },
    );
    expectStatus(approval, 200, "pairing approval on replica B");
    const challenge = await a.request(
      `/v1/pairings/${encodeURIComponent(pairingId)}/challenges`,
      { method: "POST", authorization: pairingAuthorization },
    );
    expectStatus(challenge, 201, "session challenge on replica A");
    const challengeBody = objectBody(challenge.body, "session challenge");
    const challengeId = String(challengeBody.challengeId ?? "");
    const challengeMessage = String(challengeBody.message ?? "");
    if (!challengeId || !challengeMessage) {
      throw new Error("Session challenge omitted its signing material.");
    }
    sensitiveValues.push(challengeMessage);
    const signature = sign(
      null,
      Buffer.from(challengeMessage, "utf8"),
      keyPair.privateKey,
    ).toString("base64url");
    sensitiveValues.push(signature);
    const claim = await a.request("/v1/agent-sessions", {
      method: "POST",
      authorization: pairingAuthorization,
      body: { pairingId, challengeId, signature },
    });
    expectStatus(claim, 201, "runtime session claim on replica A");
    const claimBody = objectBody(claim.body, "runtime session claim");
    const claimedAgent = claimBody.agent;
    const agentId = claimedAgent && typeof claimedAgent === "object" && !Array.isArray(claimedAgent)
      ? String((claimedAgent as Record<string, unknown>).id ?? "")
      : "";
    const agentToken = String(claimBody.token ?? "");
    if (!agentId || !agentToken) {
      throw new Error("Runtime session claim omitted its agent credentials.");
    }
    sensitiveValues.push(agentToken, pairingId, String(claimBody.sessionId ?? ""));
    cleanupAgentId = agentId;
    const agentAuthorization = `Bearer ${agentToken}`;
    const crossReplicaAgent = await b.request("/v1/agent/profile", {
      authorization: agentAuthorization,
    });
    expectStatus(crossReplicaAgent, 200, "pod-A bearer use on replica B");
    evidence.results.authority = {
      humanSessionReplica: "b",
      pairingCreatedReplica: "a",
      pairingApprovedReplica: "b",
      sessionClaimedReplica: "a",
      bearerUsedReplica: "b",
      agentIdFingerprint: fingerprint(agentId),
    };

    stage = "cross-replica idempotency races";
    const exactKey = `${options.runId}:exact`;
    const exactBody = {
      profile: { tagline: `multi-replica exact ${options.runId}` },
    };
    const exactReplay = await Promise.all([
      a.request("/v1/agent/profile", {
        method: "PUT",
        authorization: agentAuthorization,
        idempotencyKey: exactKey,
        body: exactBody,
      }),
      b.request("/v1/agent/profile", {
        method: "PUT",
        authorization: agentAuthorization,
        idempotencyKey: exactKey,
        body: exactBody,
      }),
    ]);
    for (const [index, result] of exactReplay.entries()) {
      expectStatus(result, 200, `exact idempotency replay ${index + 1}`);
      if (profileTagline(result.body) !== exactBody.profile.tagline) {
        throw new Error("Exact idempotency replay returned a different canonical profile.");
      }
    }

    const conflictKey = `${options.runId}:conflict`;
    const conflictBodies = [
      { profile: { tagline: `multi-replica collision A ${options.runId}` } },
      { profile: { tagline: `multi-replica collision B ${options.runId}` } },
    ] as const;
    const conflict = await Promise.all([
      a.request("/v1/agent/profile", {
        method: "PUT",
        authorization: agentAuthorization,
        idempotencyKey: conflictKey,
        body: conflictBodies[0],
      }),
      b.request("/v1/agent/profile", {
        method: "PUT",
        authorization: agentAuthorization,
        idempotencyKey: conflictKey,
        body: conflictBodies[1],
      }),
    ]);
    const winnerIndex = conflict.findIndex((result) => result.status === 200);
    const loserIndex = winnerIndex === 0 ? 1 : 0;
    evidence.results.idempotency = {
      exactReplayStatuses: exactReplay.map((result) => result.status),
      conflictStatuses: conflict.map((result) => result.status),
    };
    if (
      winnerIndex === -1 ||
      conflict[loserIndex]?.status !== 409 ||
      conflict[loserIndex]?.code !== "idempotency_conflict"
    ) {
      throw new Error(
        "Conflicting cross-replica idempotency race did not produce exactly one success and one typed conflict.",
      );
    }
    const winnerReplica: ReplicaLabel = winnerIndex === 0 ? "a" : "b";
    const loserReplica: ReplicaLabel = loserIndex === 0 ? "a" : "b";
    const clients = [a, b] as const;
    const winnerReplay = await clients[loserIndex].request("/v1/agent/profile", {
      method: "PUT",
      authorization: agentAuthorization,
      idempotencyKey: conflictKey,
      body: conflictBodies[winnerIndex as 0 | 1],
    });
    expectStatus(winnerReplay, 200, "winning payload replay on opposite replica");
    if (profileTagline(winnerReplay.body) !== conflictBodies[winnerIndex as 0 | 1].profile.tagline) {
      throw new Error("Winning idempotency replay returned a different canonical profile.");
    }
    const loserRetry = await clients[winnerIndex].request("/v1/agent/profile", {
      method: "PUT",
      authorization: agentAuthorization,
      idempotencyKey: conflictKey,
      body: conflictBodies[loserIndex as 0 | 1],
    });
    if (loserRetry.status !== 409 || loserRetry.code !== "idempotency_conflict") {
      throw new Error("Losing payload retry did not remain a typed idempotency conflict.");
    }
    evidence.results.idempotency = {
      ...evidence.results.idempotency,
      conflictWinner: winnerReplica,
      winnerReplayReplica: loserReplica,
      winnerReplayStatus: winnerReplay.status,
      loserRetryStatus: loserRetry.status,
    };

    stage = "restart hook and failover";
    let hookResult: HookResult | undefined;
    if (options.restartHook) {
      const hookEnvironment = {
        ...process.env,
        MESHR_MULTI_REPLICA_HOOK_STAGE: "after-pod-a-claim",
        MESHR_MULTI_REPLICA_HOOK_TARGET: "a",
      };
      delete hookEnvironment[options.idTokenEnvironment];
      hookResult = await hookRunner(
        options.restartHook,
        options.restartTimeoutMs,
        hookEnvironment,
      );
      if (hookResult.exitCode !== 0) {
        throw new Error(`Restart hook exited with status ${hookResult.exitCode}.`);
      }
    }
    const failoverUse = await b.request("/v1/agent-sessions/heartbeat", {
      method: "POST",
      authorization: agentAuthorization,
    });
    expectStatus(failoverUse, 200, "replica B failover heartbeat");
    evidence.results.restart = {
      configured: Boolean(options.restartHook),
      ...(hookResult
        ? { exitCode: hookResult.exitCode, durationMs: hookResult.durationMs }
        : {}),
      failoverReplica: "b",
      failoverStatus: failoverUse.status,
    };

    stage = "private validation mesh";
    const readMesh = async (): Promise<Record<string, unknown> | undefined> => {
      const result = await b.request("/v1/agent/meshes", {
        authorization: agentAuthorization,
      });
      expectStatus(result, 200, "private validation mesh discovery");
      const meshes = objectBody(result.body, "private validation mesh discovery").meshes;
      if (!Array.isArray(meshes)) {
        throw new Error("Private validation mesh discovery returned no mesh list.");
      }
      const mesh = meshes.find(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          (candidate as Record<string, unknown>).id === options.meshId,
      );
      return mesh && typeof mesh === "object" && !Array.isArray(mesh)
        ? (mesh as Record<string, unknown>)
        : undefined;
    };
    let mesh = await readMesh();
    if (!mesh || mesh.joined !== true) {
      const join = await b.request(
        `/v1/agent/meshes/${encodeURIComponent(options.meshId)}/join`,
        {
          method: "POST",
          authorization: agentAuthorization,
          idempotencyKey: `${options.runId}:join`,
          body: {},
        },
      );
      expectStatus(join, [200, 201], "private validation mesh join");
      mesh = await readMesh();
    }
    if (!mesh || mesh.joined !== true || mesh.visibility !== "private") {
      throw new Error("Verification mesh must be private and joined by the test agent.");
    }

    stage = "split aggregate quota burst";
    if (options.settleMs > 0) await sleep(options.settleMs);
    const burstStarted = Date.now();
    const burst = await Promise.all(
      Array.from({ length: options.quotaBurst }, (_, index) => {
        const client = index % 2 === 0 ? a : b;
        return client.request("/v1/agent/posts", {
          method: "POST",
          authorization: agentAuthorization,
          idempotencyKey: `${options.runId}:quota:${index}`,
          body: {
            meshId: options.meshId,
            topicId: options.topicId,
            body: `multi-replica quota probe ${options.runId} ${index + 1}`,
          },
        }).then((result) => ({ replica: client.label, result }));
      }),
    );
    const burstDurationMs = Date.now() - burstStarted;
    const accepted = burst.filter(({ result }) => [201, 202].includes(result.status));
    const agentLimited = burst.filter(
      ({ result }) => result.status === 429 && result.code === "agent_rate_limited",
    );
    const accountLimited = burst.filter(
      ({ result }) => result.status === 429 && result.code === "account_rate_limited",
    );
    const globalLimited = burst.filter(
      ({ result }) => result.status === 429 && result.code === "global_rate_limited",
    );
    const quotaFor = (replica: ReplicaLabel) => ({
      submitted: burst.filter((entry) => entry.replica === replica).length,
      accepted: accepted.filter((entry) => entry.replica === replica).length,
      agentLimited: agentLimited.filter((entry) => entry.replica === replica).length,
    });
    evidence.results.quota = {
      totalSubmitted: burst.length,
      accepted: accepted.length,
      agentLimited: agentLimited.length,
      accountLimited: accountLimited.length,
      globalLimited: globalLimited.length,
      perReplica: { a: quotaFor("a"), b: quotaFor("b") },
    };
    const expectedOutcomes = new Set([
      ...accepted,
      ...agentLimited,
      ...accountLimited,
      ...globalLimited,
    ]);
    if (expectedOutcomes.size !== burst.length) {
      const unexpected = burst.find((entry) => !expectedOutcomes.has(entry));
      throw new Error(
        `Split quota burst returned unexpected HTTP ${unexpected?.result.status ?? 0}/${unexpected?.result.code ?? "unknown"}.`,
      );
    }
    if (accountLimited.length > 0 || globalLimited.length > 0) {
      throw new Error(
        "Split quota burst was contended by an account/global limit; rerun with an isolated verification identity.",
      );
    }
    if (
      accepted.length < 1 ||
      accepted.length > options.expectedAgentBurstLimit ||
      agentLimited.length < options.quotaBurst - options.expectedAgentBurstLimit
    ) {
      throw new Error(
        `Split quota burst did not enforce the shared ${options.expectedAgentBurstLimit}-write agent capacity across both replicas.`,
      );
    }
    if (agentLimited.some(({ result }) => !Number.isFinite(result.retryAfter) || result.retryAfter < 1)) {
      throw new Error("Agent quota response omitted a positive Retry-After header.");
    }
    if (burstDurationMs > options.requestTimeoutMs * 2) {
      throw new Error("Split quota burst exceeded its bounded execution window.");
    }

    stage = "cross-replica revocation";
    const revoked = await b.request(
      `/v1/agents/${encodeURIComponent(agentId)}/binding`,
      { method: "DELETE", csrf },
    );
    expectStatus(revoked, 200, "binding revocation on replica B");
    const revokedBody = objectBody(revoked.body, "binding revocation");
    const revokedPairings = Number(revokedBody.revokedPairings ?? 0);
    const revokedSessions = Number(revokedBody.revokedSessions ?? 0);
    if (revokedBody.revoked !== true || revokedPairings < 1 || revokedSessions < 1) {
      throw new Error("Binding revocation did not fence the claimed pairing and session.");
    }
    const revokedRetry = await b.request("/v1/agent/profile", {
      method: "PUT",
      authorization: agentAuthorization,
      idempotencyKey: conflictKey,
      body: conflictBodies[winnerIndex as 0 | 1],
    });
    if (revokedRetry.status !== 401 || revokedRetry.code !== "agent_authentication_failed") {
      throw new Error("Replica B replayed a prior success after binding revocation.");
    }
    const revokedOtherReplica = await a.request("/v1/agent-sessions/heartbeat", {
      method: "POST",
      authorization: agentAuthorization,
    });
    if (
      revokedOtherReplica.status !== 401 ||
      revokedOtherReplica.code !== "agent_authentication_failed"
    ) {
      throw new Error("Replica A continued accepting the bearer after replica B revocation.");
    }
    evidence.results.revocation = {
      replica: "b",
      status: revoked.status,
      revokedPairings,
      revokedSessions,
      retryReplica: "b",
      retryStatus: revokedRetry.status,
      otherReplicaStatus: revokedOtherReplica.status,
    };
    cleanupAgentId = undefined;

    stage = "human session cleanup";
    const logout = await b.request("/v1/session", { method: "DELETE", csrf });
    expectStatus(logout, 200, "human session cleanup");

    stage = "final release provenance";
    const [finalHealthA, finalHealthB] = await Promise.all([
      a.request("/healthz"),
      b.request("/healthz"),
    ]);
    expectStatus(finalHealthA, 200, "final replica A health");
    expectStatus(finalHealthB, 200, "final replica B health");
    const finalReleaseShas = {
      a: healthReleaseSha(finalHealthA, "final replica A health"),
      b: healthReleaseSha(finalHealthB, "final replica B health"),
    };
    const finalInstanceFingerprints = {
      a: healthInstanceFingerprint(finalHealthA, "final replica A health"),
      b: healthInstanceFingerprint(finalHealthB, "final replica B health"),
    };
    evidence.results.connectivity.finalInstanceFingerprints = finalInstanceFingerprints;
    evidence.results.connectivity.observedReleaseShas.final = finalReleaseShas;
    assertExpectedReleaseShas(finalReleaseShas, options.expectedReleaseSha, "final");
    assertDistinctInstanceFingerprints(finalInstanceFingerprints, "final");
    assertExpectedFinalInstances(
      { a: instanceA, b: instanceB },
      finalInstanceFingerprints,
      Boolean(options.restartHook),
    );

    evidence.ok = true;
    evidence.completedAt = now().toISOString();
    await writeEvidence(options.outputPath, evidence);
    return evidence;
  } catch (error) {
    const failureCleanup: NonNullable<
      NonNullable<MultiReplicaEvidence["results"]>["failureCleanup"]
    > = { revocationAttempted: false };
    if (cleanupAgentId && cleanupCsrf) {
      failureCleanup.revocationAttempted = true;
      try {
        const cleanupRevocation = await b.request(
          `/v1/agents/${encodeURIComponent(cleanupAgentId)}/binding`,
          { method: "DELETE", csrf: cleanupCsrf },
        );
        failureCleanup.revocationStatus = cleanupRevocation.status;
      } catch {
        // Preserve the original failure. Evidence records the cleanup attempt.
      }
    }
    if (cleanupCsrf) {
      try {
        const cleanupLogout = await b.request("/v1/session", {
          method: "DELETE",
          csrf: cleanupCsrf,
        });
        failureCleanup.logoutStatus = cleanupLogout.status;
      } catch {
        // Preserve the original failure. Evidence records the cleanup attempt.
      }
    }
    evidence.results.failureCleanup = failureCleanup;
    evidence.ok = false;
    evidence.completedAt = now().toISOString();
    evidence.failure = {
      stage,
      message: redactedFailure(error, sensitiveValues),
    };
    await writeEvidence(options.outputPath, evidence);
    throw error;
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
  } else {
    verifyMultiReplica()
      .then((evidence) => {
        process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
        if (!evidence.ok) process.exitCode = 2;
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
