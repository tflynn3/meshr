#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isLoopbackHostname } from "../connector/api.ts";
import type { LiveMatrixEvidence } from "../live/types.ts";
import type { OpenClawLiveEvidence } from "../live/openclaw-types.ts";
import {
  isLaunchRuntimeReceipt,
  isLaunchRuntimeReceiptBundle,
  type LaunchRuntimeReceipt,
} from "../live/receipt.ts";
import {
  LIVE_EVIDENCE_CONTRACT_MAJOR,
  LIVE_EVIDENCE_ENVIRONMENTS,
  type EvidenceProvenance,
  type LiveEvidenceEnvironment,
} from "../live/provenance.ts";

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const DEFAULT_REQUIRED_RUNTIMES = ["claude", "openclaw"] as const;
const SUPPORTED_REQUIRED_RUNTIMES = ["codex", "claude", "ollama", "openclaw"] as const;
type RequiredRuntime = (typeof SUPPORTED_REQUIRED_RUNTIMES)[number];

export interface LaunchEvidenceVerificationOptions {
  expectedEnvironment: Exclude<LiveEvidenceEnvironment, "local">;
  expectedGitSha: string;
  /** The deployed origin that produced the traces. */
  expectedOrigin: string;
  /** The private mesh/topic reserved for release acceptance writes. */
  expectedValidationTarget?: { meshId: string; topicId: string };
  requiredRuntimes?: RequiredRuntime[];
}

export interface LaunchEvidenceVerificationSummary {
  files: number;
  runtimeEvidence: RequiredRuntime[];
  environments: LiveEvidenceEnvironment[];
  gitShas: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, reason: string): never {
  throw new Error(`launch_evidence_invalid:${path}:${reason}`);
}

function stringValue(value: unknown, path: string, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail(path, `${field}_required`);
  return value;
}

function provenance(value: unknown, path: string, options: LaunchEvidenceVerificationOptions): EvidenceProvenance {
  if (!isRecord(value)) fail(path, "provenance_required");
  if (value.contractMajor !== LIVE_EVIDENCE_CONTRACT_MAJOR) {
    fail(path, "contract_major_mismatch");
  }
  const gitSha = stringValue(value.gitSha, path, "git_sha");
  if (gitSha !== options.expectedGitSha) fail(path, "git_sha_mismatch");
  if (value.workingTreeClean !== true) fail(path, "working_tree_must_be_clean");
  if (value.environment !== options.expectedEnvironment) {
    fail(path, "environment_mismatch");
  }
  return value as unknown as EvidenceProvenance;
}

function normalizedOrigin(value: string, path: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(path, "origin_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    fail(path, "origin_must_be_https_origin");
  }
  if (isLoopbackHostname(url.hostname)) {
    fail(path, "origin_must_not_be_loopback");
  }
  return url.origin;
}

function assertOrigin(value: unknown, path: string, expected: string): void {
  const actual = stringValue(value, path, "server_url");
  let origin: string;
  try {
    origin = new URL(actual).origin;
  } catch {
    fail(path, "server_url_invalid");
  }
  if (origin !== expected) fail(path, "server_origin_mismatch");
}

function passedAuthorBinding(value: unknown, path: string): void {
  if (!isRecord(value)) fail(path, "author_binding_required");
  if (value.agentIdMatches !== true || value.handleMatches !== true) {
    fail(path, "author_binding_mismatch");
  }
  stringValue(value.postId, path, "post_id");
  stringValue(value.expectedAgentId, path, "expected_agent_id");
  stringValue(value.observedAgentId, path, "observed_agent_id");
  stringValue(value.expectedHandle, path, "expected_handle");
  stringValue(value.observedHandle, path, "observed_handle");
}

function passedPhase(value: unknown, path: string, phase: "root" | "reply"): void {
  if (!isRecord(value)) fail(path, "phase_required");
  if (value.phase !== phase || value.status !== "passed") fail(path, `${phase}_must_pass`);
  passedAuthorBinding(value.authorBinding, path);
  if (typeof value.marker !== "string" || !value.marker.endsWith(`:${phase}]`)) {
    fail(path, `${phase}_marker_invalid`);
  }
}

function verifyLifecycle(
  value: unknown,
  path: string,
  sourceSha256: string,
  runtimes: LaunchRuntimeReceipt["runtimes"],
): void {
  if (!isRecord(value)) fail(path, "lifecycle_required");
  if (!Array.isArray(value.checked) || value.checked.length === 0 || value.checked.some((item) => typeof item !== "string" || !item.trim())) {
    fail(path, "lifecycle_checked_required");
  }
  if (value.nativeHostLifecycle !== "actual_session_offline") fail(path, "native_host_offline_proof_required");
  if (value.supersession !== "signed_predecessor_fenced") fail(path, "supersession_proof_required");
  if (!Number.isSafeInteger(value.offlineAfterSeconds) || Number(value.offlineAfterSeconds) < 90 || Number(value.offlineAfterSeconds) > 600) {
    fail(path, "offline_timeout_invalid");
  }
  if (typeof value.runtime !== "string" || !value.runtime.trim()) fail(path, "lifecycle_runtime_required");
  if (value.sourceSha256 !== sourceSha256) fail(path, "lifecycle_source_sha_mismatch");
  if (!Array.isArray(value.witnesses) || value.witnesses.length === 0) fail(path, "lifecycle_witnesses_required");
  const runtimeNames = runtimes.map((runtime) => runtime.runtime);
  const expectedLifecycleRuntime = runtimeNames.length === 1 ? runtimeNames[0] : "mixed";
  if (value.runtime !== expectedLifecycleRuntime) fail(path, "lifecycle_runtime_mismatch");
  const checkedValues = value.checked as unknown[];
  if (new Set(checkedValues).size !== checkedValues.length) fail(path, "lifecycle_checked_duplicate");
  const witnessPairingIds = new Set<string>();
  for (const [index, witness] of value.witnesses.entries()) {
    const witnessPath = `${path}:witnesses[${index}]`;
    if (!isRecord(witness)) fail(witnessPath, "witness_required");
    for (const field of ["pairingId", "handle", "sessionId", "hostExitedAt", "onlineVerifiedAt", "offlineObservedAt"] as const) {
      stringValue(witness[field], witnessPath, field);
      if (["hostExitedAt", "onlineVerifiedAt", "offlineObservedAt"].includes(field) && !Number.isFinite(Date.parse(witness[field] as string))) {
        fail(witnessPath, `${field}_invalid`);
      }
    }
    if (!Number.isFinite(witness.offlineAfterSeconds) || Number(witness.offlineAfterSeconds) < 0 || Number(witness.offlineAfterSeconds) > 90) {
      fail(witnessPath, "offline_duration_invalid");
    }
    if (witnessPairingIds.has(witness.pairingId as string)) fail(witnessPath, "witness_duplicate");
    witnessPairingIds.add(witness.pairingId as string);
    const hostExitedAt = Date.parse(witness.hostExitedAt as string);
    const onlineVerifiedAt = Date.parse(witness.onlineVerifiedAt as string);
    const offlineObservedAt = Date.parse(witness.offlineObservedAt as string);
    if (onlineVerifiedAt < hostExitedAt || offlineObservedAt < onlineVerifiedAt) {
      fail(witnessPath, "lifecycle_timestamp_order_invalid");
    }
    const measuredSeconds = (offlineObservedAt - hostExitedAt) / 1_000;
    if (Math.abs(measuredSeconds - Number(witness.offlineAfterSeconds)) > 1) {
      fail(witnessPath, "offline_duration_mismatch");
    }
  }
  const expected = runtimes.flatMap((runtime) => runtime.phases.map((phase) => ({
    pairingId: phase.pairingId,
    handle: phase.expectedHandle,
    sessionId: phase.sessionId,
  })));
  if (value.witnesses.length !== expected.length) fail(path, "lifecycle_witness_count_mismatch");
  for (const entry of expected) {
    const witness = value.witnesses.find((candidate) =>
      isRecord(candidate) && candidate.pairingId === entry.pairingId,
    );
    if (!witness || witness.handle !== entry.handle || witness.sessionId !== entry.sessionId) {
      fail(path, "lifecycle_session_mismatch");
    }
  }
  const expectedHandles = new Set(expected.map((entry) => entry.handle));
  const checked = new Set(value.checked as string[]);
  if (expectedHandles.size !== checked.size || [...expectedHandles].some((handle) => !checked.has(handle as string))) {
    fail(path, "lifecycle_checked_mismatch");
  }
}

function verifyMatrix(value: LiveMatrixEvidence, path: string, options: LaunchEvidenceVerificationOptions): RequiredRuntime[] {
  if (value.schemaVersion !== 2) fail(path, "matrix_schema_version");
  provenance(value.provenance, path, options);
  const expectedOrigin = normalizedOrigin(options.expectedOrigin, "options");
  if (value.dryRun) fail(path, "dry_run_not_release_evidence");
  if (value.outcome !== "passed") fail(path, "matrix_outcome_not_passed");
  if (!Array.isArray(value.serverHealth) || value.serverHealth.length === 0 || value.serverHealth.some((health) => !isRecord(health) || health.reachable !== true)) {
    fail(path, "server_health_not_reachable");
  }
  for (const [index, health] of value.serverHealth.entries()) {
    const healthPath = `${path}:serverHealth[${index}]`;
    assertOrigin(isRecord(health) ? health.serverUrl : undefined, healthPath, expectedOrigin);
    if (!isRecord(health) || !isRecord(health.result) || health.result.releaseSha !== options.expectedGitSha) {
      fail(healthPath, "deployed_release_sha_mismatch");
    }
  }
  if (!Array.isArray(value.runtimes) || value.runtimes.length === 0) fail(path, "runtime_evidence_required");
  const runtimes: RequiredRuntime[] = [];
  for (const [index, runtime] of value.runtimes.entries()) {
    const runtimePath = `${path}:runtimes[${index}]`;
    if (!isRecord(runtime)) fail(runtimePath, "unsupported_runtime");
    const matrixRuntime = runtime.runtime;
    if (matrixRuntime !== "codex" && matrixRuntime !== "claude" && matrixRuntime !== "ollama") {
      fail(runtimePath, "unsupported_runtime");
    }
    const runtimeName = runtime.runtime as RequiredRuntime;
    runtimes.push(runtimeName);
    if (runtime.outcome !== "passed") fail(runtimePath, "runtime_outcome_not_passed");
    if (!isRecord(runtime.version) || runtime.version.installed !== true) fail(runtimePath, "runtime_not_installed");
    if (!Array.isArray(runtime.identities) || runtime.identities.length < 2 || runtime.identities.some((identity) => !isRecord(identity) || identity.matches !== true)) {
      fail(runtimePath, "identity_verification_failed");
    }
    for (const [identityIndex, identity] of runtime.identities.entries()) {
      const binding = isRecord(identity) ? identity.binding : undefined;
      assertOrigin(
        isRecord(binding) ? binding.serverUrl : undefined,
        `${runtimePath}:identities[${identityIndex}]`,
        expectedOrigin,
      );
    }
    if (!Array.isArray(runtime.phases) || runtime.phases.length !== 2) fail(runtimePath, "root_and_reply_required");
    const root = runtime.phases.find((phase) => isRecord(phase) && phase.phase === "root");
    const reply = runtime.phases.find((phase) => isRecord(phase) && phase.phase === "reply");
    passedPhase(root, `${runtimePath}:root`, "root");
    passedPhase(reply, `${runtimePath}:reply`, "reply");
  }
  return runtimes;
}

function verifyOpenClaw(value: OpenClawLiveEvidence, path: string, options: LaunchEvidenceVerificationOptions): RequiredRuntime[] {
  if (value.schemaVersion !== 1) fail(path, "openclaw_schema_version");
  provenance(value.provenance, path, options);
  const expectedOrigin = normalizedOrigin(options.expectedOrigin, "options");
  if (value.dryRun) fail(path, "dry_run_not_release_evidence");
  if (value.outcome !== "passed") fail(path, "openclaw_outcome_not_passed");
  if (!Array.isArray(value.serverHealth) || value.serverHealth.length === 0 || value.serverHealth.some((health) => !isRecord(health) || health.reachable !== true)) {
    fail(path, "server_health_not_reachable");
  }
  for (const [index, health] of value.serverHealth.entries()) {
    const healthPath = `${path}:serverHealth[${index}]`;
    assertOrigin(isRecord(health) ? health.serverUrl : undefined, healthPath, expectedOrigin);
    if (!isRecord(health) || !isRecord(health.result) || health.result.releaseSha !== options.expectedGitSha) {
      fail(healthPath, "deployed_release_sha_mismatch");
    }
  }
  if (!value.plugin || value.plugin.enabled !== true || value.plugin.runtimeFactoryValidated !== true) {
    fail(path, "openclaw_plugin_not_validated");
  }
  if (!value.version || value.version.installed !== true) fail(path, "openclaw_not_installed");
  if (!Array.isArray(value.agents) || value.agents.length !== 2 || value.agents.some((agent) => !isRecord(agent) || !isRecord(agent.identity) || agent.identity.matches !== true)) {
    fail(path, "openclaw_identity_verification_failed");
  }
  for (const [index, agent] of value.agents.entries()) {
    const binding = isRecord(agent) ? agent.binding : undefined;
    assertOrigin(
      isRecord(binding) ? binding.serverUrl : undefined,
      `${path}:agents[${index}]`,
      expectedOrigin,
    );
  }
  if (!Array.isArray(value.phases) || value.phases.length !== 2) fail(path, "openclaw_root_and_reply_required");
  const root = value.phases.find((phase) => isRecord(phase) && phase.phase === "root");
  const reply = value.phases.find((phase) => isRecord(phase) && phase.phase === "reply");
  passedPhase(root, `${path}:root`, "root");
  passedPhase(reply, `${path}:reply`, "reply");
  return ["openclaw"];
}

function verifyReceipt(
  value: LaunchRuntimeReceipt,
  path: string,
  options: LaunchEvidenceVerificationOptions,
): RequiredRuntime[] {
  if (value.kind !== "launch-runtime-receipt" || value.schemaVersion !== 1) {
    fail(path, "receipt_schema_version");
  }
  provenance(value.provenance, path, options);
  const expectedOrigin = normalizedOrigin(options.expectedOrigin, "options");
  if (value.dryRun) fail(path, "dry_run_not_release_evidence");
  if (value.outcome !== "passed") fail(path, "receipt_outcome_not_passed");
  if (!isRecord(value.source) || (value.source.evidenceKind !== "live-matrix" && value.source.evidenceKind !== "openclaw-live")) {
    fail(path, "receipt_source_invalid");
  }
  if (typeof value.source.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.source.sha256)) {
    fail(path, "receipt_source_hash_invalid");
  }
  if (!Number.isSafeInteger(value.source.bytes) || value.source.bytes <= 0 || value.source.bytes > MAX_EVIDENCE_BYTES) {
    fail(path, "receipt_source_size_invalid");
  }
  verifyLifecycle(value.lifecycle, `${path}:lifecycle`, value.source.sha256, value.runtimes);
  if (typeof value.origin !== "string") fail(path, "receipt_origin_required");
  const receiptOrigin = normalizedOrigin(value.origin, `${path}:origin`);
  if (receiptOrigin !== expectedOrigin) fail(path, "receipt_origin_mismatch");
  if (!Array.isArray(value.serverHealth) || value.serverHealth.length === 0 || value.serverHealth.some((health) => !isRecord(health) || health.reachable !== true)) {
    fail(path, "receipt_server_health_required");
  }
  for (const [index, health] of value.serverHealth.entries()) {
    const healthPath = `${path}:serverHealth[${index}]`;
    if (!isRecord(health) || health.reachable !== true) fail(healthPath, "server_health_not_reachable");
    assertOrigin(isRecord(health) ? health.serverUrl : undefined, healthPath, expectedOrigin);
    if (!isRecord(health) || health.releaseSha !== options.expectedGitSha) {
      fail(healthPath, "deployed_release_sha_mismatch");
    }
  }
  if (!Array.isArray(value.runtimes) || value.runtimes.length === 0) fail(path, "runtime_evidence_required");
  const runtimes: RequiredRuntime[] = [];
  for (const [index, runtime] of value.runtimes.entries()) {
    const runtimePath = `${path}:runtimes[${index}]`;
    if (!isRecord(runtime)) fail(runtimePath, "unsupported_runtime");
    const runtimeName = runtime.runtime;
    if (runtimeName !== "codex" && runtimeName !== "claude" && runtimeName !== "ollama" && runtimeName !== "openclaw") {
      fail(runtimePath, "unsupported_runtime");
    }
    runtimes.push(runtimeName);
    if (runtime.outcome !== "passed") fail(runtimePath, "runtime_outcome_not_passed");
    if (!isRecord(runtime.version) || runtime.version.installed !== true || typeof runtime.version.version !== "string" || !runtime.version.version.trim()) {
      fail(runtimePath, "runtime_not_installed");
    }
    if (!isRecord(runtime.validationTarget) || runtime.validationTarget.matches !== true) {
      fail(runtimePath, "validation_target_not_verified");
    }
    const targetMeshId = runtime.validationTarget.meshId;
    const targetTopicId = runtime.validationTarget.topicId;
    if (typeof targetMeshId !== "string" || !targetMeshId || targetMeshId === "mesh-public" || typeof targetTopicId !== "string" || !targetTopicId) {
      fail(runtimePath, "validation_target_invalid");
    }
    if (options.expectedValidationTarget &&
        (targetMeshId !== options.expectedValidationTarget.meshId || targetTopicId !== options.expectedValidationTarget.topicId)) {
      fail(runtimePath, "validation_target_mismatch");
    }
    if (runtime.distinctAuthors !== true) fail(runtimePath, "distinct_authors_required");
    if (!Array.isArray(runtime.identities) || runtime.identities.length < 2 || runtime.identities.some((identity) => !isRecord(identity) || identity.matches !== true)) {
      fail(runtimePath, "identity_verification_failed");
    }
    for (const [identityIndex, identity] of runtime.identities.entries()) {
      assertOrigin(
        isRecord(identity) ? identity.serverUrl : undefined,
        `${runtimePath}:identities[${identityIndex}]`,
        expectedOrigin,
      );
    }
    if (!Array.isArray(runtime.phases) || runtime.phases.length !== 2) fail(runtimePath, "root_and_reply_required");
    const observedAuthors = new Set<string>();
    for (const [phaseIndex, phase] of runtime.phases.entries()) {
      const phasePath = `${runtimePath}:phases[${phaseIndex}]`;
      if (!isRecord(phase) || phase.status !== "passed" || phase.authorMatches !== true) fail(phasePath, "phase_author_must_pass");
      if (phase.meshId !== targetMeshId || phase.topicId !== targetTopicId) fail(phasePath, "phase_target_mismatch");
      for (const field of ["expectedAgentId", "observedAgentId", "expectedHandle", "observedHandle"] as const) {
        stringValue(phase[field], phasePath, field);
      }
      if (phase.expectedAgentId !== phase.observedAgentId || phase.expectedHandle !== phase.observedHandle) {
        fail(phasePath, "phase_author_binding_mismatch");
      }
      stringValue(phase.pairingId, phasePath, "pairing_id");
      stringValue(phase.sessionId, phasePath, "session_id");
      for (const field of ["hostExitedAt", "onlineVerifiedAt", "offlineObservedAt"] as const) {
        const timestamp = stringValue(phase[field], phasePath, field);
        if (!Number.isFinite(Date.parse(timestamp))) fail(phasePath, `${field}_invalid`);
      }
      if (!Number.isFinite(phase.offlineAfterSeconds) || Number(phase.offlineAfterSeconds) < 0 || Number(phase.offlineAfterSeconds) > 90) {
        fail(phasePath, "offline_duration_invalid");
      }
      observedAuthors.add(phase.observedAgentId as string);
    }
    if (observedAuthors.size !== 2) fail(runtimePath, "distinct_observed_authors_required");
    const root = runtime.phases.find((phase) => isRecord(phase) && phase.phase === "root");
    const reply = runtime.phases.find((phase) => isRecord(phase) && phase.phase === "reply");
    if (!isRecord(root) || root.authorMatches !== true || root.status !== "passed") fail(`${runtimePath}:root`, "root_must_pass");
    if (!isRecord(reply) || reply.authorMatches !== true || reply.status !== "passed") fail(`${runtimePath}:reply`, "reply_must_pass");
    if (runtimeName === "openclaw" && runtime.pluginValidated !== true) fail(runtimePath, "openclaw_plugin_not_validated");
  }
  return runtimes;
}

/**
 * Validate redacted runtime acceptance artifacts before a release consumes
 * them. This is intentionally stricter than the diagnostic live runners: a
 * historical or local trace remains useful for debugging, but cannot satisfy
 * a canary/production launch gate.
 */
export function verifyLaunchEvidenceValues(
  values: Array<{ path: string; value: unknown }>,
  options: LaunchEvidenceVerificationOptions,
): LaunchEvidenceVerificationSummary {
  if (!values.length) throw new Error("launch_evidence_required");
  if (!options.expectedGitSha || !/^[0-9a-f]{7,64}$/i.test(options.expectedGitSha)) {
    throw new Error("expected_release_sha_invalid");
  }
  if (!(LIVE_EVIDENCE_ENVIRONMENTS as readonly string[]).includes(options.expectedEnvironment)) {
    throw new Error("expected_evidence_environment_invalid");
  }
  const runtimeEvidence: RequiredRuntime[] = [];
  const environments: LiveEvidenceEnvironment[] = [];
  const gitShas: string[] = [];
  for (const entry of values) {
    const path = entry.path;
    if (!isRecord(entry.value)) fail(path, "object_required");
    const candidate = entry.value;
    if (isLaunchRuntimeReceiptBundle(candidate)) {
      if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.receipts) || candidate.receipts.length === 0) {
        fail(path, "receipt_bundle_invalid");
      }
      for (const [index, receipt] of candidate.receipts.entries()) {
        if (!isLaunchRuntimeReceipt(receipt)) fail(`${path}:receipts[${index}]`, "receipt_required");
        const verified = verifyReceipt(receipt, `${path}:receipts[${index}]`, options);
        runtimeEvidence.push(...verified);
        environments.push(receipt.provenance.environment);
        gitShas.push(receipt.provenance.gitSha!);
      }
    } else if (isLaunchRuntimeReceipt(candidate)) {
      const verified = verifyReceipt(candidate, path, options);
      runtimeEvidence.push(...verified);
      environments.push(candidate.provenance.environment);
      gitShas.push(candidate.provenance.gitSha!);
    } else {
      // Detailed live diagnostics contain bounded process output and local
      // paths for debugging. They must be converted to a minimal receipt
      // before entering a release gate, so a caller cannot bypass the privacy
      // boundary by submitting the raw diagnostic shape directly.
      fail(path, "receipt_required");
    }
  }
  const uniqueRuntimes = [...new Set(runtimeEvidence)];
  const required = options.requiredRuntimes?.length
    ? options.requiredRuntimes
    : [...DEFAULT_REQUIRED_RUNTIMES];
  for (const runtime of required) {
    if (!uniqueRuntimes.includes(runtime)) fail("summary", `required_runtime_missing:${runtime}`);
  }
  return {
    files: values.length,
    runtimeEvidence: uniqueRuntimes,
    environments: [...new Set(environments)],
    gitShas: [...new Set(gitShas)],
  };
}

async function currentGitSha(projectRoot: string): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, "rev-parse", "HEAD"], {
      timeout: 2_000,
      maxBuffer: 1_024,
    });
    const sha = result.stdout.trim();
    if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error("invalid sha");
    return sha;
  } catch {
    throw new Error("release_sha_required_or_git_checkout_unavailable");
  }
}

async function readEvidence(path: string): Promise<{ path: string; value: unknown }> {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`evidence_must_be_a_file:${absolute}`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`evidence_permissions_must_be_0600:${absolute}`);
  }
  if (metadata.size > MAX_EVIDENCE_BYTES) throw new Error(`evidence_too_large:${absolute}`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  } catch {
    throw new Error(`evidence_json_invalid:${absolute}`);
  }
  return { path: absolute, value };
}

export const VERIFY_LAUNCH_EVIDENCE_HELP = `Usage:
  npm run verify:runtime-evidence -- --environment canary|production --origin <https-origin> [--sha <commit>] --evidence <receipt-or-bundle> [--evidence <path> ...]

Verify current-commit, non-dry-run Claude/OpenClaw acceptance receipts before
release. Use --require-runtime to override the default Claude + OpenClaw gate.
Use --mesh-id and --topic-id to pin the receipt to the private validation
conversation used by the release job.
Receipts must be mode 0600 artifacts from a clean checkout. Convert detailed
diagnostics with npm run evidence:receipt before handing them to a release;
raw diagnostic files are rejected.
`;

export async function main(values = process.argv.slice(2)): Promise<void> {
  if (values.includes("--help") || values.includes("-h")) {
    process.stdout.write(VERIFY_LAUNCH_EVIDENCE_HELP);
    return;
  }
  let environment: Exclude<LiveEvidenceEnvironment, "local"> | undefined;
  let sha: string | undefined;
  let origin: string | undefined;
  let meshId: string | undefined;
  let topicId: string | undefined;
  const paths: string[] = [];
  const required: RequiredRuntime[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    const next = values[index + 1];
    if (value === "--environment" && next) {
      if (next !== "canary" && next !== "production") throw new Error("--environment must be canary or production");
      environment = next;
      index += 1;
    } else if (value === "--sha" && next) {
      sha = next;
      index += 1;
    } else if (value === "--origin" && next) {
      origin = next;
      index += 1;
    } else if (value === "--mesh-id" && next) {
      meshId = next;
      index += 1;
    } else if (value === "--topic-id" && next) {
      topicId = next;
      index += 1;
    } else if (value === "--evidence" && next) {
      paths.push(next);
      index += 1;
    } else if (value === "--require-runtime" && next) {
      if (!(SUPPORTED_REQUIRED_RUNTIMES as readonly string[]).includes(next)) throw new Error(`Unsupported runtime: ${next}`);
      required.push(next as RequiredRuntime);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${value}`);
    }
  }
  if (!environment) throw new Error("--environment is required");
  if (!paths.length) throw new Error("--evidence is required");
  if ((meshId && !topicId) || (!meshId && topicId)) throw new Error("--mesh-id and --topic-id must be supplied together");
  const projectRoot = process.env.MESHR_PROJECT_ROOT?.trim() || process.cwd();
  const expectedGitSha = sha ?? process.env.MESHR_RELEASE_SHA?.trim() ?? await currentGitSha(projectRoot);
  const expectedOrigin = origin ?? process.env.MESHR_RELEASE_ORIGIN?.trim();
  if (!expectedOrigin) throw new Error("--origin or MESHR_RELEASE_ORIGIN is required");
  const summary = verifyLaunchEvidenceValues(
    await Promise.all(paths.map(readEvidence)),
    {
      expectedEnvironment: environment,
      expectedGitSha,
      expectedOrigin,
      ...(meshId && topicId ? { expectedValidationTarget: { meshId, topicId } } : {}),
      requiredRuntimes: required,
    },
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
