import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createMeshrServer } from "./app.ts";
import { createIdentityPlatformVerifier } from "./identity.ts";
import { startSqliteOutboxPublisher } from "./outboxPublisher.ts";
import { productionSettings, assertProductionSettings } from "./production.ts";
import { createFirestore } from "../platform/googleClients.ts";
import { FirestoreMeshrRepository } from "./firestoreRepository.ts";

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
    ? createFirestore(settings.identityProjectId)
    : undefined;
const repository = firestore ? new FirestoreMeshrRepository({ firestore }) : undefined;
if (firestore) {
  // Production starts empty apart from the public commons and system
  // taxonomy. No local prototype identities or content are imported.
  await repository!.ensureEmptyProduction();
}

// SQLite is an ephemeral projection in production, never an authority. A
// writable path is still required by the HTTP process for cursors and local
// cache reads; the deployment mounts it on an emptyDir rather than a PVC.
const projectionDbPath =
  settings.environment === "production"
    ? resolve(process.env.MESHR_PROJECTION_DB_PATH ?? "/tmp/meshr-projection.db")
    : dbPath;
mkdirSync(dirname(projectionDbPath), { recursive: true });
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

const retentionSweep = repository?.purgeExpired
  ? setInterval(() => {
      repository
        ?.purgeExpired(new Date().toISOString())
        .catch((error: unknown) => console.error("meshr retention sweep failed", error));
    }, 15 * 60 * 1_000)
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
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
