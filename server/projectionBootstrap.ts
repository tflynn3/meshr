import { Firestore, type DocumentSnapshot } from "@google-cloud/firestore";
import { MESHR_CONTRACT_MAJOR } from "./contracts.ts";

export const PROJECTION_BOOTSTRAP_COLLECTION = "projection_bootstrap" as const;
export const PROJECTION_BOOTSTRAP_DOCUMENT = "default" as const;
export const PROJECTION_COLLECTIONS = [
  // Event/materializer state and access epochs live beside the aggregate
  // snapshots in the isolated topology database. A clean-launch attestation
  // must cover all of them; otherwise a stale shard or processed-event ledger
  // could survive while the visible activity collections look empty.
  "topology_shards",
  "topology_events",
  "topology_activity_snapshots",
  "topology_activity_totals",
  "topology_activity_recent",
  "topology_activity_buckets",
  "processed_events",
  "mesh_access_epochs",
  "live_access_epochs",
] as const;

export type ProjectionBootstrapStatus = {
  exists: boolean;
  valid: boolean;
  authorityBootstrapId?: string;
};

function collectionName(name: string, prefix?: string): string {
  const normalized = prefix?.replace(/[^A-Za-z0-9_-]/g, "") || "";
  return normalized ? `${normalized}_${name}` : name;
}

function markerRef(store: Firestore, prefix?: string) {
  return store
    .collection(collectionName(PROJECTION_BOOTSTRAP_COLLECTION, prefix))
    .doc(PROJECTION_BOOTSTRAP_DOCUMENT);
}

function markerIsValid(snapshot: DocumentSnapshot): boolean {
  return snapshot.exists &&
    snapshot.get("contract_version") === MESHR_CONTRACT_MAJOR &&
    snapshot.get("key") === "projection-bootstrap" &&
    snapshot.get("authority_bootstrap") === "system/bootstrap" &&
    snapshot.get("empty_launch") === true &&
    typeof snapshot.get("authority_bootstrap_id") === "string" &&
    snapshot.get("authority_bootstrap_id").length > 0;
}

function markerData(now: string, authorityBootstrapId: string): Record<string, unknown> {
  return {
    contract_version: MESHR_CONTRACT_MAJOR,
    key: "projection-bootstrap",
    authority_bootstrap: "system/bootstrap",
    authority_bootstrap_id: authorityBootstrapId,
    initialized_at: now,
    empty_launch: true,
  };
}

export async function readProjectionBootstrap(
  store: Firestore,
  prefix?: string,
): Promise<ProjectionBootstrapStatus> {
  const snapshot = await markerRef(store, prefix).get();
  return {
    exists: snapshot.exists,
    valid: markerIsValid(snapshot),
    ...(typeof snapshot.get("authority_bootstrap_id") === "string"
      ? { authorityBootstrapId: snapshot.get("authority_bootstrap_id") as string }
      : {}),
  };
}

/** Fail closed if any aggregate collection already contains launch data. */
export async function assertProjectionEmpty(
  store: Firestore,
  prefix?: string,
): Promise<void> {
  const snapshots = await Promise.all(
    PROJECTION_COLLECTIONS.map((name) =>
      store.collection(collectionName(name, prefix)).limit(1).get(),
    ),
  );
  const nonEmptyIndex = snapshots.findIndex((snapshot) => !snapshot.empty);
  if (nonEmptyIndex >= 0) {
    throw new Error(`topology_projection_not_empty:${PROJECTION_COLLECTIONS[nonEmptyIndex]}`);
  }
}

/**
 * Create or verify the projection launch marker with a transaction-level
 * emptiness check. `forceScanExistingMarker` is used when the authority
 * bootstrap was absent at the start of a first launch: even a valid marker
 * from a partial attempt must not let a concurrent projection write escape
 * the clean-start guard.
 */
export async function ensureProjectionBootstrap(
  store: Firestore,
  now: string,
  options: {
    collectionPrefix?: string;
    /** The current authority system/bootstrap generation. */
    expectedAuthorityBootstrapId: string;
    forceScanExistingMarker?: boolean;
    createIfMissing?: boolean;
  },
): Promise<void> {
  const prefix = options.collectionPrefix;
  const expectedAuthorityBootstrapId = options.expectedAuthorityBootstrapId?.trim();
  if (!expectedAuthorityBootstrapId) throw new Error("topology_projection_bootstrap_generation_missing");
  const ref = markerRef(store, prefix);
  const forceScanExistingMarker = options.forceScanExistingMarker === true;
  const createIfMissing = options.createIfMissing !== false;
  await store.runTransaction(async (transaction) => {
    const existing = await transaction.get(ref);
    if (existing.exists && !markerIsValid(existing)) {
      throw new Error("topology_projection_bootstrap_invalid");
    }
    const generationMatches = existing.exists &&
      existing.get("authority_bootstrap_id") === expectedAuthorityBootstrapId;
    if (generationMatches && !forceScanExistingMarker) return;

    const snapshots = await Promise.all(
      PROJECTION_COLLECTIONS.map((name) =>
        transaction.get(
          store.collection(collectionName(name, prefix)).limit(1),
        ),
      ),
    );
    const nonEmptyIndex = snapshots.findIndex((snapshot) => !snapshot.empty);
    if (nonEmptyIndex >= 0) {
      throw new Error(`topology_projection_not_empty:${PROJECTION_COLLECTIONS[nonEmptyIndex]}`);
    }
    if (existing.exists) {
      if (!createIfMissing) throw new Error("topology_projection_bootstrap_missing");
      // A marker from a different authority generation is not evidence that
      // this projection database is clean. Once the transaction has proved
      // that every aggregate collection is empty, replace the attestation
      // with the current generation fence.
      transaction.set(ref, markerData(now, expectedAuthorityBootstrapId), { merge: false });
      return;
    }
    if (!createIfMissing) throw new Error("topology_projection_bootstrap_missing");
    transaction.create(ref, markerData(now, expectedAuthorityBootstrapId));
  });
}
