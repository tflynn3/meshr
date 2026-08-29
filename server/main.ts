import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createMeshrServer } from "./app.ts";
import { createIdentityPlatformVerifier } from "./identity.ts";
import { startSqliteOutboxPublisher } from "./outboxPublisher.ts";
import { productionSettings, assertProductionSettings } from "./production.ts";
import { createFirestore } from "../platform/googleClients.ts";
import { FirestoreMeshrRepository } from "./firestoreRepository.ts";
import { loadRuntimeSecrets } from "../platform/runtimeSecrets.ts";

loadRuntimeSecrets();
const settings = productionSettings();
assertProductionSettings(settings);
const dbPath = resolve(process.env.MESHR_DB_PATH ?? ".meshr/meshr.db");
const host = process.env.MESHR_HOST?.trim() || "127.0.0.1";
const publicWebUrl = process.env.MESHR_WEB_URL?.trim() || "http://127.0.0.1:5173/";
const socialAuthOnly = settings.socialAuthOnly;
const identityProjectId =
  process.env.MESHR_IDENTITY_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim();
const rawPort = Number(process.env.MESHR_PORT ?? "8787");
if (!Number.isSafeInteger(rawPort) || rawPort < 1 || rawPort > 65_535) {
  throw new Error("MESHR_PORT must be an integer from 1 to 65535.");
}

const firestore =
  settings.environment === "production" && settings.identityProjectId
    ? createFirestore(settings.identityProjectId, process.env.MESHR_FIRESTORE_DATABASE)
    : undefined;
const topologyFirestore = firestore && settings.identityProjectId
  ? createFirestore(
      settings.identityProjectId,
      process.env.MESHR_TOPOLOGY_FIRESTORE_DATABASE || process.env.MESHR_FIRESTORE_DATABASE,
    )
  : undefined;
const repository = firestore
  ? new FirestoreMeshrRepository({
      firestore,
      topologyFirestore,
      invitationPepper: settings.invitationPepper,
      invitationPepperPrevious: settings.invitationPepperPrevious,
    })
  : undefined;
if (settings.environment === "production") {
  // The repository port keeps optional methods so SQLite fixtures and small
  // unit doubles can stay focused. Production must never silently fall back
  // to its disposable projection when one authoritative capability is
  // missing, so fail before opening the listener instead.
  const requiredProductionMethods = [
    "ensureEmptyProduction", "checkReady", "createPairing", "approvePairing",
    "updatePairing", "findPairing", "findPairingByCode", "createPairingChallenge",
    "findPairingChallenge", "consumePairingChallenge", "upsertAgent",
    "updateAgentProfileFromSession", "revokeAgent", "upsertMesh", "updateMeshGovernance", "createMeshWithOwner",
    "upsertTopic", "consumeGovernanceRateLimit", "createTopic", "updateTopic", "deleteTopic", "upsertMeshHumanRole", "deleteMeshHumanRole",
    "upsertMeshAgentMembership", "joinMeshForAgent", "createMeshInvitation", "createMeshRoleInvitation",
    "findMeshRoleInvitation", "listMeshRoleInvitations", "listMeshRoleInvitationsForEmail", "revokeMeshRoleInvitation", "acceptMeshRoleInvitation",
    "listMeshInvitations", "revokeMeshInvitation", "upsertJoinRequest", "findJoinRequest",
    "listJoinRequests", "resolveJoinRequest", "upsertFollow", "listProfileReviewProposals",
    "resolveProfileReviewProposal", "listHumanActivityPreferences", "upsertHumanActivityPreference",
    "revokeHumanSession", "revokeWebMcpGrants", "appendEvent", "appendAuditEvent",
    "listAgentEvents", "upsertModerationCase", "findModerationCase", "listModerationCases",
    "updatePostModeration", "findPostById", "listPublishedPostsByTopic", "findAgentById",
    "listModerationCasesPage",
    "listAgentsForAccount", "listRuntimeSessionsForAgents", "findMeshById", "findTopicById",
    "listTopicsForAgent", "listPublicMeshes", "listPublicTopics", "listMeshDirectoryForAccount",
    "findMeshHumanRole", "findMeshAgentMembership", "listMeshesForAgent", "listJoinedMeshIdsForAgent",
    "loadProjection", "findRuntimeSessionByTokenHash", "findRuntimeSessionById",
    "findActiveRuntimeSessionForAgent", "purgeExpired", "findWebMcpGrant", "findAccountByProvider",
    "findAccountByEmail", "findAccountById", "createSocialAccount", "linkProvider", "listProviderIdentities",
    "createHumanSession", "findHumanSession", "touchHumanSession", "startRuntimeSession",
    "heartbeatRuntimeSession", "transferPageAuthority", "createPostWithOutbox",
  ] as const;
  const missing = requiredProductionMethods.filter(
    (name) => typeof (repository as unknown as Record<string, unknown> | undefined)?.[name] !== "function",
  );
  if (!repository || missing.length > 0) {
    throw new Error(`Production Firestore repository is incomplete: ${missing.join(", ") || "not configured"}`);
  }
}
if (firestore) {
  // Production starts empty apart from the public commons and system
  // taxonomy. No local prototype identities or content are imported.
  await repository!.ensureEmptyProduction();
}

// SQLite is an ephemeral projection in production, never an authority. Keep
// the production cache in memory so a restart cannot preserve stale identity,
// membership, post, or topology state and no filesystem volume can be
// mistaken for durable authority. Firestore is hydrated on demand for every
// authoritative path. Local development keeps its file-backed fixture DB.
const projectionDbPath =
  settings.environment === "production"
    ? ":memory:"
    : dbPath;
if (projectionDbPath !== ":memory:") {
  mkdirSync(dirname(projectionDbPath), { recursive: true });
}
const app = createMeshrServer({
  dbPath: projectionDbPath,
  secureCookies: settings.secureCookies,
  // The projection needs the required public commons taxonomy in every
  // environment. No accounts, bindings, posts, or prototype evidence are
  // seeded by MeshrDatabase.
  seed: true,
  publicWebUrl,
  socialAuthOnly,
  identityVerifier:
    identityProjectId && socialAuthOnly
      ? createIdentityPlatformVerifier(identityProjectId)
      : undefined,
  webMcpTransfersSession: settings.webMcpTransfersSession,
  invitationPepper: settings.invitationPepper,
  invitationPepperPrevious: settings.invitationPepperPrevious,
  repository,
});

const ingestUrl = process.env.MESHR_EVENT_INGEST_URL?.trim();
const internalToken = process.env.MESHR_INTERNAL_TOKEN?.trim();
const outboxPublisher =
  !repository && ingestUrl && internalToken
    ? startSqliteOutboxPublisher({
        db: app.database.sqlite,
        ingestUrl,
        internalToken,
      })
    : undefined;

const address = await app.listen(rawPort, host);
console.log(`meshr server listening at ${address.baseUrl}`);
console.log(`meshr projection database: ${projectionDbPath}`);
console.log(`meshr web app: ${publicWebUrl}`);

// The repository uses a distributed lease so multiple API replicas can run
// this frequently without overlapping. Five-second cadence keeps the
// thread-aware 90-day body-retention backlog bounded at launch throughput;
// Firestore TTL remains the backstop for the auxiliary trace collections.
const retentionSweep = repository?.purgeExpired
  ? setInterval(() => {
      repository
        ?.purgeExpired(new Date().toISOString())
        .catch((error: unknown) => console.error("meshr retention sweep failed", error));
    }, 5 * 1_000)
  : undefined;
retentionSweep?.unref();

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (retentionSweep) clearInterval(retentionSweep);
  outboxPublisher?.stop();
  await app.close();
  await firestore?.terminate();
  if (topologyFirestore && topologyFirestore !== firestore) await topologyFirestore.terminate();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
