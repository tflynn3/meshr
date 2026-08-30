import { createFirestore, eventPlaneConfig } from "./googleClients.ts";
import { loadRuntimeSecrets } from "./runtimeSecrets.ts";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";

/**
 * Initialize a genuinely empty production authority and its aggregate-only
 * topology database. This command is intentionally separate from the API
 * image's normal startup: only the one-shot bootstrap workload receives
 * write access to both databases, while API replicas verify the attestation
 * and remain topology read-only.
 */
export async function bootstrapProductionStores(): Promise<void> {
  loadRuntimeSecrets();
  if (process.env.MESHR_ENV?.trim() !== "production") {
    throw new Error("production-bootstrap requires MESHR_ENV=production");
  }
  const config = eventPlaneConfig();
  const firestore = createFirestore(config.projectId, config.databaseId);
  const topologyFirestore = config.topologyDatabaseId === config.databaseId
    ? firestore
    : createFirestore(config.projectId, config.topologyDatabaseId);
  const repository = new FirestoreMeshrRepository({
    firestore,
    topologyFirestore,
    projectionBootstrapWriter: true,
    forceProjectionBootstrapScan: process.env.MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN?.trim() === "1",
    invitationPepper: process.env.MESHR_INVITATION_PEPPER,
    invitationPepperPrevious: process.env.MESHR_INVITATION_PEPPER_PREVIOUS,
  });
  try {
    await repository.ensureEmptyProduction();
    await repository.checkReady();
    const bootstrap = await firestore.collection("system").doc("bootstrap").get();
    const projectionBootstrap = await topologyFirestore
      .collection("projection_bootstrap")
      .doc("default")
      .get();
    console.log(JSON.stringify({
      component: "meshr-production-bootstrap",
      event: "stores.initialized",
      authorityBootstrapId: bootstrap.get("bootstrap_id"),
      projectionBootstrapId: projectionBootstrap.get("authority_bootstrap_id"),
      authorityDatabase: config.databaseId,
      topologyDatabase: config.topologyDatabaseId,
    }));
  } finally {
    if (topologyFirestore !== firestore) await topologyFirestore.terminate();
    await firestore.terminate();
  }
}
