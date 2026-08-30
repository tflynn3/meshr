#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { AUTHORITY_COLLECTIONS as MESHR_AUTHORITY_COLLECTIONS } from "../server/authorityCollections.ts";

type CutoverReceipt = {
  schema_version?: unknown;
  environment?: unknown;
  release_sha?: unknown;
  source_authority_database?: unknown;
  target_authority_database?: unknown;
  source_topology_database?: unknown;
  target_topology_database?: unknown;
  fence_id?: unknown;
  fenced_at?: unknown;
  restored_at?: unknown;
  outbox_drained_at?: unknown;
  verified_at?: unknown;
  source_writes_after_fence?: unknown;
  delta_replay_completed?: unknown;
  authority_delta_copy_completed?: unknown;
  authority_delta_fence_id?: unknown;
  authority_delta_source_digest?: unknown;
  authority_delta_target_digest?: unknown;
  authority_delta_collections_match?: unknown;
  authority_delta_source_manifest?: unknown;
  authority_delta_target_manifest?: unknown;
  authority_delta_replayed_at?: unknown;
  source_outbox_high_watermark?: unknown;
  target_outbox_high_watermark?: unknown;
  validation_mesh_id?: unknown;
  receipt_id?: unknown;
  issued_at?: unknown;
};

const AUTHORITY_MANIFEST_ALGORITHM = "sha256-canonical-json-v1";
const AUTHORITY_MANIFEST_PRODUCER = "meshr-authority-delta/v1";
const MAX_MANIFEST_COLLECTIONS = 128;
const MAX_MANIFEST_COLLECTION_NAME = 128;
// This is the authority database boundary. Topology shards/events and
// aggregate-only projections live in the separate topology database and must
// never be silently included in (or omitted from) a restore attestation.
// Re-export the inventory from the server boundary so receipt tooling and
// production repository guards cannot silently drift apart.
export const AUTHORITY_COLLECTIONS = MESHR_AUTHORITY_COLLECTIONS;

type AuthorityManifestEntry = {
  name: string;
  count: number;
  digest: string;
};

type AuthorityManifest = {
  algorithm: string;
  producer: string;
  collections: AuthorityManifestEntry[];
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Cutover receipt field ${field} is required.`);
  return value.trim();
}

function timestamp(value: unknown, field: string): number {
  const parsed = Date.parse(requiredString(value, field));
  if (!Number.isFinite(parsed)) throw new Error(`Cutover receipt field ${field} must be an ISO timestamp.`);
  return parsed;
}

function authorityManifest(value: unknown, field: string): AuthorityManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cutover receipt field ${field} must be an authority collection manifest.`);
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.algorithm !== AUTHORITY_MANIFEST_ALGORITHM) {
    throw new Error(`Cutover receipt field ${field}.algorithm must be ${AUTHORITY_MANIFEST_ALGORITHM}.`);
  }
  if (manifest.producer !== AUTHORITY_MANIFEST_PRODUCER) {
    throw new Error(`Cutover receipt field ${field}.producer must be ${AUTHORITY_MANIFEST_PRODUCER}.`);
  }
  if (!Array.isArray(manifest.collections) || manifest.collections.length === 0 || manifest.collections.length > MAX_MANIFEST_COLLECTIONS) {
    throw new Error(`Cutover receipt field ${field}.collections must contain 1-${MAX_MANIFEST_COLLECTIONS} entries.`);
  }
  const entries: AuthorityManifestEntry[] = [];
  let previousName = "";
  for (const [index, rawEntry] of manifest.collections.entries()) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new Error(`Cutover receipt field ${field}.collections[${index}] must be an object.`);
    }
    const entry = rawEntry as Record<string, unknown>;
    const name = requiredString(entry.name, `${field}.collections[${index}].name`);
    if (name.length > MAX_MANIFEST_COLLECTION_NAME || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name)) {
      throw new Error(`Cutover receipt field ${field}.collections[${index}].name is invalid.`);
    }
    if (name <= previousName) {
      throw new Error(`Cutover receipt field ${field}.collections must be sorted and unique by name.`);
    }
    previousName = name;
    if (!Number.isSafeInteger(entry.count) || (entry.count as number) < 0) {
      throw new Error(`Cutover receipt field ${field}.collections[${index}].count must be a non-negative safe integer.`);
    }
    const digest = requiredString(entry.digest, `${field}.collections[${index}].digest`);
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Cutover receipt field ${field}.collections[${index}].digest must be a lowercase SHA-256 hex digest.`);
    }
    entries.push({ name, count: entry.count as number, digest });
  }
  const actualNames = entries.map((entry) => entry.name);
  const expectedNames = [...AUTHORITY_COLLECTIONS];
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error(`Cutover receipt field ${field}.collections must exactly enumerate the authority collection allowlist.`);
  }
  return {
    algorithm: manifest.algorithm as string,
    producer: manifest.producer as string,
    collections: entries,
  };
}

function canonicalManifest(value: AuthorityManifest): string {
  return JSON.stringify(value);
}

function environment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a database cutover.`);
  return value;
}

export function verifyCutoverReceipt(
  raw: string,
  expected: {
    environment: string;
    releaseSha: string;
    sourceAuthorityDatabase: string;
    targetAuthorityDatabase: string;
    sourceTopologyDatabase: string;
    targetTopologyDatabase: string;
    validationMeshId: string;
  },
): void {
  if (raw.length > 64 * 1024) throw new Error("Cutover receipt is unexpectedly large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("MESHR_DATABASE_CUTOVER_RECEIPT must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MESHR_DATABASE_CUTOVER_RECEIPT must be a JSON object.");
  }
  const receipt = parsed as CutoverReceipt;
  if (receipt.schema_version !== 2) {
    throw new Error("Cutover receipt schema_version must be 2; generate a fence-bound authority-delta receipt before retrying.");
  }
  if (requiredString(receipt.environment, "environment") !== expected.environment) {
    throw new Error("Cutover receipt environment does not match the requested promotion.");
  }
  if (requiredString(receipt.release_sha, "release_sha") !== expected.releaseSha) {
    throw new Error("Cutover receipt release SHA does not match the requested promotion.");
  }
  if (requiredString(receipt.source_authority_database, "source_authority_database") !== expected.sourceAuthorityDatabase) {
    throw new Error("Cutover receipt source authority database does not match the protected runtime.");
  }
  if (requiredString(receipt.target_authority_database, "target_authority_database") !== expected.targetAuthorityDatabase) {
    throw new Error("Cutover receipt target authority database does not match the requested release.");
  }
  if (requiredString(receipt.source_topology_database, "source_topology_database") !== expected.sourceTopologyDatabase) {
    throw new Error("Cutover receipt source topology database does not match the protected runtime.");
  }
  if (requiredString(receipt.target_topology_database, "target_topology_database") !== expected.targetTopologyDatabase) {
    throw new Error("Cutover receipt target topology database does not match the requested release.");
  }
  if (requiredString(receipt.validation_mesh_id, "validation_mesh_id") !== expected.validationMeshId) {
    throw new Error("Cutover receipt validation mesh does not match the protected release mesh.");
  }
  requiredString(receipt.receipt_id, "receipt_id");
  const issuedAt = timestamp(receipt.issued_at, "issued_at");
  requiredString(receipt.fence_id, "fence_id");
  const fencedAt = timestamp(receipt.fenced_at, "fenced_at");
  const restoredAt = timestamp(receipt.restored_at, "restored_at");
  const replayedAt = timestamp(receipt.authority_delta_replayed_at, "authority_delta_replayed_at");
  const drainedAt = timestamp(receipt.outbox_drained_at, "outbox_drained_at");
  const verifiedAt = timestamp(receipt.verified_at, "verified_at");
  if (issuedAt < verifiedAt) {
    throw new Error("Cutover receipt issued_at must be at or after verified_at; obtain a newly attested receipt after the cutover evidence is complete.");
  }
  if (restoredAt < fencedAt || replayedAt < restoredAt || drainedAt < replayedAt || verifiedAt < drainedAt) {
    throw new Error("Cutover receipt ordering is invalid; fence writers, restore, replay the authority delta, drain the outbox, then verify.");
  }
  if (receipt.source_writes_after_fence !== 0) {
    throw new Error("Cutover receipt reports writes after the source fence; refusing an automatic authority switch.");
  }
  if (receipt.delta_replay_completed !== true) {
    throw new Error("Cutover receipt must confirm delta replay completion.");
  }
  if (receipt.authority_delta_copy_completed !== true || receipt.authority_delta_collections_match !== true) {
    throw new Error("Cutover receipt must confirm a complete, fence-bound authority delta copy with matching collection digests and counts.");
  }
  if (requiredString(receipt.authority_delta_fence_id, "authority_delta_fence_id") !== requiredString(receipt.fence_id, "fence_id")) {
    throw new Error("Cutover receipt authority delta is not bound to the writer fence.");
  }
  const sourceAuthorityDigest = requiredString(receipt.authority_delta_source_digest, "authority_delta_source_digest");
  const targetAuthorityDigest = requiredString(receipt.authority_delta_target_digest, "authority_delta_target_digest");
  if (sourceAuthorityDigest !== targetAuthorityDigest) {
    throw new Error("Cutover receipt source and target authority digests differ; refusing to switch authorities.");
  }
  const sourceManifest = authorityManifest(receipt.authority_delta_source_manifest, "authority_delta_source_manifest");
  const targetManifest = authorityManifest(receipt.authority_delta_target_manifest, "authority_delta_target_manifest");
  if (canonicalManifest(sourceManifest) !== canonicalManifest(targetManifest)) {
    throw new Error("Cutover receipt source and target authority collection manifests differ; refusing to switch authorities.");
  }
  const manifestDigest = createHash("sha256").update(canonicalManifest(sourceManifest)).digest("hex");
  if (
    sourceAuthorityDigest !== `sha256:${manifestDigest}` ||
    targetAuthorityDigest !== `sha256:${manifestDigest}`
  ) {
    throw new Error("Cutover receipt authority digests do not match the canonical per-collection manifest.");
  }
  const sourceWatermark = requiredString(receipt.source_outbox_high_watermark, "source_outbox_high_watermark");
  const targetWatermark = requiredString(receipt.target_outbox_high_watermark, "target_outbox_high_watermark");
  if (sourceWatermark !== targetWatermark) {
    throw new Error("Cutover receipt source and target outbox high-watermarks differ; refusing to switch authorities.");
  }
}

function main(): void {
  const raw = environment("MESHR_DATABASE_CUTOVER_RECEIPT");
  verifyCutoverReceipt(raw, {
    environment: environment("MESHR_CUTOVER_ENVIRONMENT"),
    releaseSha: environment("MESHR_CUTOVER_RELEASE_SHA"),
    sourceAuthorityDatabase: environment("MESHR_CUTOVER_SOURCE_AUTHORITY_DATABASE"),
    targetAuthorityDatabase: environment("MESHR_CUTOVER_TARGET_AUTHORITY_DATABASE"),
    sourceTopologyDatabase: environment("MESHR_CUTOVER_SOURCE_TOPOLOGY_DATABASE"),
    targetTopologyDatabase: environment("MESHR_CUTOVER_TARGET_TOPOLOGY_DATABASE"),
    validationMeshId: environment("MESHR_CUTOVER_VALIDATION_MESH_ID"),
  });
  process.stdout.write("Cutover receipt verified: source fence, delta replay, and outbox high-watermark are aligned.\n");
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked && fileURLToPath(import.meta.url) === invoked) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
