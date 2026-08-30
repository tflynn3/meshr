import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AUTHORITY_COLLECTIONS, verifyCutoverReceipt } from "../scripts/verify-cutover-receipt.ts";

const expected = {
  environment: "canary",
  releaseSha: "release-sha-123",
  sourceAuthorityDatabase: "meshr-authority-old",
  targetAuthorityDatabase: "meshr-authority-new",
  sourceTopologyDatabase: "meshr-topology-old",
  targetTopologyDatabase: "meshr-topology-new",
  validationMeshId: "mesh-release-validation",
};

const sourceManifest = {
  algorithm: "sha256-canonical-json-v1",
  producer: "meshr-authority-delta/v1",
  collections: AUTHORITY_COLLECTIONS.map((name, index) => ({
    name,
    count: index === 0 ? 1 : 0,
    digest: createHash("sha256").update(`${name}:fixture`).digest("hex"),
  })),
};
const targetManifest = structuredClone(sourceManifest);
const manifestDigest = createHash("sha256").update(JSON.stringify(sourceManifest)).digest("hex");

function receipt(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 2,
    environment: expected.environment,
    release_sha: expected.releaseSha,
    source_authority_database: expected.sourceAuthorityDatabase,
    target_authority_database: expected.targetAuthorityDatabase,
    source_topology_database: expected.sourceTopologyDatabase,
    target_topology_database: expected.targetTopologyDatabase,
    validation_mesh_id: expected.validationMeshId,
    receipt_id: "receipt-2026-08-30-0001",
    issued_at: "2026-08-30T12:07:00.000Z",
    fence_id: "fence-2026-08-30T12:00:00Z",
    fenced_at: "2026-08-30T12:00:00.000Z",
    restored_at: "2026-08-30T12:03:00.000Z",
    outbox_drained_at: "2026-08-30T12:05:00.000Z",
    verified_at: "2026-08-30T12:06:00.000Z",
    source_writes_after_fence: 0,
    delta_replay_completed: true,
    authority_delta_copy_completed: true,
    authority_delta_fence_id: "fence-2026-08-30T12:00:00Z",
    authority_delta_source_digest: `sha256:${manifestDigest}`,
    authority_delta_target_digest: `sha256:${manifestDigest}`,
    authority_delta_collections_match: true,
    authority_delta_source_manifest: sourceManifest,
    authority_delta_target_manifest: targetManifest,
    authority_delta_replayed_at: "2026-08-30T12:04:00.000Z",
    source_outbox_high_watermark: "evt-00042",
    target_outbox_high_watermark: "evt-00042",
    ...overrides,
  });
}

test("accepts a fence-before-restore receipt with aligned outbox watermarks", () => {
  assert.doesNotThrow(() => verifyCutoverReceipt(receipt(), expected));
});

test("rejects writes after the source fence", () => {
  assert.throws(
    () => verifyCutoverReceipt(receipt({ source_writes_after_fence: 1 }), expected),
    /writes after the source fence/,
  );
});

test("rejects a restore that precedes the fence or an incomplete delta replay", () => {
  assert.throws(
    () => verifyCutoverReceipt(receipt({ restored_at: "2026-08-30T11:59:00.000Z" }), expected),
    /ordering is invalid/,
  );
  assert.throws(
    () => verifyCutoverReceipt(receipt({ delta_replay_completed: false }), expected),
    /delta replay completion/,
  );
});

test("rejects source and target high-watermark divergence", () => {
  assert.throws(
    () => verifyCutoverReceipt(receipt({ target_outbox_high_watermark: "evt-00041" }), expected),
    /high-watermarks differ/,
  );
});

test("requires the attestation to be issued after verification", () => {
  assert.throws(
    () => verifyCutoverReceipt(receipt({ issued_at: "2026-08-30T12:05:30.000Z" }), expected),
    /issued_at must be at or after verified_at/,
  );
});

test("rejects an authority delta that is not fence-bound or fully equal", () => {
  assert.throws(
    () => verifyCutoverReceipt(receipt({ authority_delta_fence_id: "different-fence" }), expected),
    /not bound to the writer fence/,
  );
  assert.throws(
    () => verifyCutoverReceipt(receipt({ authority_delta_target_digest: "sha256:authority-other" }), expected),
    /authority digests differ/,
  );
  assert.throws(
    () => verifyCutoverReceipt(receipt({ authority_delta_collections_match: false }), expected),
    /complete, fence-bound authority delta/,
  );
});

test("rejects missing, malformed, or divergent per-collection manifests", () => {
  assert.throws(
    () => verifyCutoverReceipt(receipt({ authority_delta_source_manifest: undefined }), expected),
    /authority_delta_source_manifest must be an authority collection manifest/,
  );
  assert.throws(
    () => verifyCutoverReceipt(receipt({
      authority_delta_source_manifest: {
        algorithm: "sha256-canonical-json-v1",
        producer: "meshr-authority-delta/v1",
        collections: sourceManifest.collections.map((entry, index) => index === 0
          ? { ...entry, digest: "not-a-digest" }
          : entry),
      },
    }), expected),
    /lowercase SHA-256 hex digest/,
  );
  assert.throws(
    () => verifyCutoverReceipt(receipt({
      authority_delta_target_manifest: {
        ...targetManifest,
        collections: targetManifest.collections.map((entry, index) => index === targetManifest.collections.length - 1
          ? { ...entry, count: entry.count + 1 }
          : entry),
      },
    }), expected),
    /collection manifests differ/,
  );
});

test("requires replay ordering after restore and before verification", () => {
  assert.throws(
    () => verifyCutoverReceipt(receipt({ authority_delta_replayed_at: "2026-08-30T12:02:00.000Z" }), expected),
    /ordering is invalid/,
  );
  assert.throws(
    () => verifyCutoverReceipt(receipt({ outbox_drained_at: "2026-08-30T12:03:30.000Z" }), expected),
    /ordering is invalid/,
  );
});
