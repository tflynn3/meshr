#!/usr/bin/env node
import { chmod, readFile, stat, writeFile, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLaunchRuntimeReceipt, sha256Bytes, type LaunchRuntimeLifecycle, type LaunchRuntimeLifecycleWitness, type LaunchRuntimeReceipt, type LaunchRuntimeReceiptBundle } from "../live/receipt.ts";
import type { LiveMatrixEvidence } from "../live/types.ts";
import type { OpenClawLiveEvidence } from "../live/openclaw-types.ts";

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_LIFECYCLE_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLifecycle(path: string): Promise<LaunchRuntimeLifecycle> {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`lifecycle_must_be_a_file:${absolute}`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`lifecycle_permissions_must_be_0600:${absolute}`);
  }
  if (metadata.size > MAX_LIFECYCLE_BYTES) throw new Error(`lifecycle_too_large:${absolute}`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  } catch {
    throw new Error(`lifecycle_json_invalid:${absolute}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`lifecycle_object_required:${absolute}`);
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.checked) || record.checked.length === 0 || record.checked.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`lifecycle_checked_required:${absolute}`);
  }
  if (record.nativeHostLifecycle !== "actual_session_offline") throw new Error(`lifecycle_offline_proof_required:${absolute}`);
  if (record.supersession !== "signed_predecessor_fenced") throw new Error(`lifecycle_supersession_proof_required:${absolute}`);
  if (!Number.isSafeInteger(record.offlineAfterSeconds) || Number(record.offlineAfterSeconds) < 90 || Number(record.offlineAfterSeconds) > 600) {
    throw new Error(`lifecycle_timeout_invalid:${absolute}`);
  }
  if (typeof record.runtime !== "string" || !record.runtime.trim()) {
    throw new Error(`lifecycle_runtime_required:${absolute}`);
  }
  if (typeof record.sourceSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(record.sourceSha256)) {
    throw new Error(`lifecycle_source_sha_invalid:${absolute}`);
  }
  if (!Array.isArray(record.witnesses) || record.witnesses.length === 0) {
    throw new Error(`lifecycle_witnesses_required:${absolute}`);
  }
  const witnesses: LaunchRuntimeLifecycleWitness[] = record.witnesses.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`lifecycle_witness_invalid:${absolute}:${index}`);
    }
    const witness = value as Record<string, unknown>;
    for (const field of ["pairingId", "handle", "sessionId", "hostExitedAt", "onlineVerifiedAt", "offlineObservedAt"] as const) {
      if (typeof witness[field] !== "string" || !witness[field].trim()) {
        throw new Error(`lifecycle_witness_${field}_required:${absolute}:${index}`);
      }
      if (["hostExitedAt", "onlineVerifiedAt", "offlineObservedAt"].includes(field) && !Number.isFinite(Date.parse(witness[field] as string))) {
        throw new Error(`lifecycle_witness_${field}_invalid:${absolute}:${index}`);
      }
    }
    if (!Number.isFinite(witness.offlineAfterSeconds) || Number(witness.offlineAfterSeconds) < 0 || Number(witness.offlineAfterSeconds) > 90) {
      throw new Error(`lifecycle_witness_duration_invalid:${absolute}:${index}`);
    }
    return {
      pairingId: witness.pairingId as string,
      handle: witness.handle as string,
      sessionId: witness.sessionId as string,
      hostExitedAt: witness.hostExitedAt as string,
      onlineVerifiedAt: witness.onlineVerifiedAt as string,
      offlineObservedAt: witness.offlineObservedAt as string,
      offlineAfterSeconds: Number(witness.offlineAfterSeconds),
    };
  });
  return {
    checked: [...new Set(record.checked as string[])],
    nativeHostLifecycle: "actual_session_offline",
    supersession: "signed_predecessor_fenced",
    offlineAfterSeconds: Number(record.offlineAfterSeconds),
    runtime: record.runtime,
    sourceSha256: record.sourceSha256,
    witnesses,
  };
}

async function readInput(path: string, lifecycle?: LaunchRuntimeLifecycle): Promise<LaunchRuntimeReceipt> {
  const absolute = resolve(path);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error(`evidence_must_be_a_file:${absolute}`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`evidence_permissions_must_be_0600:${absolute}`);
  }
  if (metadata.size > MAX_EVIDENCE_BYTES) throw new Error(`evidence_too_large:${absolute}`);
  const bytes = await readFile(absolute);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`evidence_json_invalid:${absolute}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`evidence_object_required:${absolute}`);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion === 2 && "runtimes" in record) {
    if (lifecycle) validateLifecycleAgainstEvidence(record, bytes, lifecycle, absolute);
    return createLaunchRuntimeReceipt({ value: value as LiveMatrixEvidence, sourceBytes: bytes, ...(lifecycle ? { lifecycle } : {}) });
  }
  if (record.schemaVersion === 1 && record.kind === "openclaw-live") {
    if (lifecycle) validateLifecycleAgainstEvidence(record, bytes, lifecycle, absolute);
    return createLaunchRuntimeReceipt({ value: value as OpenClawLiveEvidence, sourceBytes: bytes, ...(lifecycle ? { lifecycle } : {}) });
  }
  throw new Error(`unsupported_evidence_kind:${absolute}`);
}

function validateLifecycleAgainstEvidence(
  evidence: Record<string, unknown>,
  sourceBytes: Uint8Array,
  lifecycle: LaunchRuntimeLifecycle,
  path: string,
): void {
  const sourceSha256 = sha256Bytes(sourceBytes);
  if (lifecycle.sourceSha256 !== sourceSha256) {
    throw new Error(`lifecycle_source_sha_mismatch:${path}`);
  }
  const runtimes = evidence.kind === "openclaw-live"
    ? [evidence]
    : Array.isArray(evidence.runtimes) ? evidence.runtimes.filter(isRecord) : [];
  const runtimeNames = runtimes.map((runtime) => runtime.kind === "openclaw-live" ? "openclaw" : runtime.runtime).filter((name): name is string => typeof name === "string");
  if (!runtimeNames.includes(lifecycle.runtime ?? "")) {
    throw new Error(`lifecycle_runtime_mismatch:${path}`);
  }
  const phases = runtimes.flatMap((runtime) => Array.isArray(runtime.phases) ? runtime.phases.filter(isRecord) : []);
  const expected = phases
    .filter((phase) => phase.status === "passed" && isRecord(phase.binding) && isRecord(phase.nativeSession) && isRecord(phase.authorBinding))
    .map((phase) => ({
      pairingId: (phase.binding as Record<string, unknown>).pairingId,
      handle: (phase.authorBinding as Record<string, unknown>).expectedHandle,
      sessionId: (phase.nativeSession as Record<string, unknown>).sessionId,
    }))
    .filter((entry) => typeof entry.pairingId === "string" && typeof entry.handle === "string" && typeof entry.sessionId === "string");
  const witnesses = lifecycle.witnesses ?? [];
  if (witnesses.length !== expected.length) {
    throw new Error(`lifecycle_witness_count_mismatch:${path}`);
  }
  for (const entry of expected) {
    const witness = witnesses.find((candidate) => candidate.pairingId === entry.pairingId);
    if (!witness || witness.handle !== entry.handle || witness.sessionId !== entry.sessionId) {
      throw new Error(`lifecycle_session_mismatch:${path}`);
    }
  }
  const expectedHandles = new Set(expected.map((entry) => entry.handle as string));
  const checkedHandles = new Set(lifecycle.checked);
  if (expectedHandles.size !== checkedHandles.size || [...expectedHandles].some((handle) => !checkedHandles.has(handle))) {
    throw new Error(`lifecycle_checked_mismatch:${path}`);
  }
}

async function writeOutput(path: string, value: LaunchRuntimeReceipt | LaunchRuntimeReceiptBundle): Promise<void> {
  const absolute = resolve(path);
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, absolute);
}

export const WRITE_LAUNCH_RECEIPT_HELP = `Usage:
  npm run evidence:receipt -- --evidence <path> [--evidence <path> ...] [--lifecycle <path> ...] --output <path>

Create a minimal mode-0600 runtime receipt. Raw model output, prompts, bodies,
and local paths are never copied into the receipt. Lifecycle files are supplied
in the same order as evidence files and record host-offline and supersession
proofs for a release gate.
`;

export async function main(values = process.argv.slice(2)): Promise<void> {
  if (values.includes("--help") || values.includes("-h")) {
    process.stdout.write(WRITE_LAUNCH_RECEIPT_HELP);
    return;
  }
  const paths: string[] = [];
  const lifecyclePaths: string[] = [];
  let output: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const next = values[index + 1];
    if (value === "--evidence" && next) {
      paths.push(next);
      index += 1;
    } else if (value === "--lifecycle" && next) {
      lifecyclePaths.push(next);
      index += 1;
    } else if (value === "--output" && next) {
      output = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${value}`);
    }
  }
  if (!paths.length) throw new Error("--evidence is required");
  if (!output) throw new Error("--output is required");
  if (lifecyclePaths.length !== 0 && lifecyclePaths.length !== paths.length) {
    throw new Error("--lifecycle must be supplied once per --evidence file");
  }
  const lifecycles = await Promise.all(lifecyclePaths.map(readLifecycle));
  const receipts = await Promise.all(paths.map((path, index) => readInput(path, lifecycles[index])));
  const value: LaunchRuntimeReceipt | LaunchRuntimeReceiptBundle = receipts.length === 1
    ? receipts[0]!
    : { kind: "launch-runtime-receipt-bundle", schemaVersion: 1, receipts };
  await writeOutput(output, value);
  process.stdout.write(`${JSON.stringify({ output: resolve(output), receipts: receipts.length }, null, 2)}\n`);
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
