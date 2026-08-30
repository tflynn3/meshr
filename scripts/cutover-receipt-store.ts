#!/usr/bin/env node

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Firestore } from "@google-cloud/firestore";
import { resolve } from "node:path";
import { createFirestore } from "../platform/googleClients.ts";
import { verifyCutoverReceipt } from "./verify-cutover-receipt.ts";

/**
 * A receipt is an external attestation, not a reusable deployment variable.
 * This collection is in the isolated release-audit database so a successful
 * cutover consumes the attestation atomically before any target writes reopen.
 * A retry must obtain a newly fenced receipt instead of replaying one from an
 * earlier attempt against a stale target database.
 */
const COLLECTION = "cutover_receipt_consumptions";
const MAX_RECEIPT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

type ReceiptObject = {
  receipt_id?: unknown;
  issued_at?: unknown;
  fence_id?: unknown;
};

export type CutoverReceiptFreshness = {
  receiptId: string;
  issuedAt: number;
};

function required(name: string, max = 256): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value || value.length > max) throw new Error(`${name} is required and must be at most ${max} characters.`);
  return value;
}

function parseReceipt(raw: string): ReceiptObject {
  if (raw.length > 64 * 1024) throw new Error("Cutover receipt is unexpectedly large.");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("MESHR_DATABASE_CUTOVER_RECEIPT must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MESHR_DATABASE_CUTOVER_RECEIPT must be a JSON object.");
  }
  return value as ReceiptObject;
}

/**
 * Validate freshness separately from the structural verifier so tests and
 * operators can use an explicit clock while the release workflow uses the
 * runner clock. The timestamp is intentionally bounded on both sides to
 * avoid accepting a receipt copied from a future or long-finished cutover.
 */
export function assertCutoverReceiptFresh(
  receipt: ReceiptObject,
  now = Date.now(),
): CutoverReceiptFreshness {
  if (typeof receipt.receipt_id !== "string" || !receipt.receipt_id.trim() || receipt.receipt_id.length > 256) {
    throw new Error("Cutover receipt field receipt_id is required and must be at most 256 characters.");
  }
  const issuedAt = typeof receipt.issued_at === "string" ? Date.parse(receipt.issued_at) : Number.NaN;
  if (!Number.isFinite(issuedAt)) throw new Error("Cutover receipt field issued_at must be an ISO timestamp.");
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) {
    throw new Error("Cutover receipt was issued in the future; refusing to consume it.");
  }
  if (now - issuedAt > MAX_RECEIPT_AGE_MS) {
    throw new Error("Cutover receipt is older than 24 hours; obtain a fresh fence-bound receipt before retrying.");
  }
  if (typeof receipt.fence_id !== "string" || !receipt.fence_id.trim()) {
    throw new Error("Cutover receipt field fence_id is required before consumption.");
  }
  return { receiptId: receipt.receipt_id.trim(), issuedAt };
}

function auditDatabase(environment: string): string {
  const value = required("MESHR_AUDIT_FIRESTORE_DATABASE", 128);
  const expected = environment === "canary" ? "meshr-canary-release-audit" : "meshr-release-audit";
  if (value !== expected) throw new Error(`MESHR_AUDIT_FIRESTORE_DATABASE must be ${expected} for ${environment} cutover receipts.`);
  return value;
}

export function cutoverConsumptionDocumentId(
  expected: Parameters<typeof verifyCutoverReceipt>[1],
  fenceId: string,
): string {
  // A receipt ID is operator-facing metadata and can be accidentally or
  // maliciously rewrapped. Consume the fence/source/target/release tuple
  // instead, so changing receipt_id cannot replay the same authority delta.
  const tuple = [
    expected.environment,
    expected.releaseSha,
    expected.sourceAuthorityDatabase,
    expected.targetAuthorityDatabase,
    expected.sourceTopologyDatabase,
    expected.targetTopologyDatabase,
    expected.validationMeshId,
    fenceId,
  ].join(":");
  const digest = createHash("sha256").update(tuple).digest("hex");
  return `${expected.environment}_${digest}`;
}

export async function consumeCutoverReceipt(
  raw: string,
  expected: Parameters<typeof verifyCutoverReceipt>[1],
  metadata: { projectId: string; auditDatabase: string; workflowRunId: string; workflowRunAttempt: string },
  now = Date.now(),
): Promise<{ receiptId: string; consumedAt: string; documentId: string }> {
  verifyCutoverReceipt(raw, expected);
  const receipt = parseReceipt(raw);
  const freshness = assertCutoverReceiptFresh(receipt, now);
  const firestore = createFirestore(metadata.projectId, metadata.auditDatabase);
  const fenceId = String(receipt.fence_id);
  const ref = firestore.collection(COLLECTION).doc(cutoverConsumptionDocumentId(expected, fenceId));
  const consumedAt = new Date(now).toISOString();
  const receiptDigest = createHash("sha256").update(raw).digest("hex");
  try {
    await firestore.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        throw new Error("cutover_receipt_already_consumed: obtain a new fence-bound receipt for this retry.");
      }
      transaction.create(ref, {
        schema_version: 1,
        receipt_id: freshness.receiptId,
        receipt_digest: receiptDigest,
        issued_at: new Date(freshness.issuedAt).toISOString(),
        fence_id: String(receipt.fence_id),
        environment: expected.environment,
        release_sha: expected.releaseSha,
        source_authority_database: expected.sourceAuthorityDatabase,
        target_authority_database: expected.targetAuthorityDatabase,
        source_topology_database: expected.sourceTopologyDatabase,
        target_topology_database: expected.targetTopologyDatabase,
        validation_mesh_id: expected.validationMeshId,
        workflow_run_id: metadata.workflowRunId,
        workflow_run_attempt: metadata.workflowRunAttempt,
        consumed_at: consumedAt,
      });
    });
  } finally {
    await firestore.terminate();
  }
  return { receiptId: freshness.receiptId, consumedAt, documentId: ref.id };
}

function main(): Promise<void> {
  const raw = required("MESHR_DATABASE_CUTOVER_RECEIPT", 64 * 1024);
  const environment = required("MESHR_CUTOVER_ENVIRONMENT", 32);
  if (environment !== "canary" && environment !== "production") {
    throw new Error("MESHR_CUTOVER_ENVIRONMENT must be canary or production.");
  }
  const result = consumeCutoverReceipt(raw, {
    environment,
    releaseSha: required("MESHR_CUTOVER_RELEASE_SHA"),
    sourceAuthorityDatabase: required("MESHR_CUTOVER_SOURCE_AUTHORITY_DATABASE"),
    targetAuthorityDatabase: required("MESHR_CUTOVER_TARGET_AUTHORITY_DATABASE"),
    sourceTopologyDatabase: required("MESHR_CUTOVER_SOURCE_TOPOLOGY_DATABASE"),
    targetTopologyDatabase: required("MESHR_CUTOVER_TARGET_TOPOLOGY_DATABASE"),
    validationMeshId: required("MESHR_CUTOVER_VALIDATION_MESH_ID"),
  }, {
    projectId: (process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT_ID ?? "").trim() || required("GOOGLE_CLOUD_PROJECT"),
    auditDatabase: auditDatabase(environment),
    workflowRunId: required("MESHR_CUTOVER_WORKFLOW_RUN_ID", 128),
    workflowRunAttempt: required("MESHR_CUTOVER_WORKFLOW_RUN_ATTEMPT", 32),
  });
  return result.then((value) => {
    process.stdout.write(`${JSON.stringify({ consumed: true, ...value })}\n`);
  });
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
