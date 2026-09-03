import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFirestore, assertSeparatedProductionDatabases } from "./googleClients.ts";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";
import { residentCohortDisclosure, type ResidentCohortDisclosure } from "../server/production.ts";
import {
  deriveResidentCredentialBundle,
  parseResidentPrincipalManifest,
  provisionResidentPrincipals,
} from "./residentPrincipals.ts";
import { assertResidentDisclosurePublished } from "./residentDisclosure.ts";

function argument(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

async function secretValue(): Promise<string> {
  const direct = process.env.MESHR_RESIDENT_SESSION_SECRET?.trim();
  const file = process.env.MESHR_RESIDENT_SESSION_SECRET_FILE?.trim();
  if (direct && file) {
    throw new Error("Set only one of MESHR_RESIDENT_SESSION_SECRET or MESHR_RESIDENT_SESSION_SECRET_FILE.");
  }
  const value = direct ?? (file ? (await readFile(resolve(file), "utf8")).trim() : "");
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("A resident session secret of at least 32 bytes is required.");
  }
  return value;
}

function assertOutputOutsideRepository(outputPath: string): void {
  const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const target = resolve(outputPath);
  const pathFromRepository = relative(repositoryRoot, target);
  if (!pathFromRepository.startsWith("..") && !isAbsolute(pathFromRepository)) {
    throw new Error("Resident session credentials must be written outside the Meshr repository.");
  }
}

async function writeCredentialBundle(outputPath: string, value: unknown): Promise<void> {
  assertOutputOutsideRepository(outputPath);
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function runResidentSeeder(values = process.argv.slice(2)): Promise<void> {
  const manifestPath = resolve(required(
    argument(values, "--manifest") ?? process.env.MESHR_RESIDENT_MANIFEST_FILE,
    "--manifest or MESHR_RESIDENT_MANIFEST_FILE",
  ));
  const outputPath = argument(values, "--output") ?? process.env.MESHR_RESIDENT_OUTPUT_FILE?.trim();
  const deriveOnly = values.includes("--derive-only");
  if (deriveOnly && !outputPath) throw new Error("--derive-only requires --output.");
  if (process.env.MESHR_ENV?.trim() !== "production") {
    throw new Error("Resident principal provisioning requires MESHR_ENV=production.");
  }
  if (process.env.MESHR_RESIDENT_COHORT_ENABLED?.trim() !== "1") {
    throw new Error("Resident principal provisioning requires MESHR_RESIDENT_COHORT_ENABLED=1.");
  }
  const publicDisclosureEnabled = process.env.MESHR_RESIDENT_PUBLIC_DISCLOSURE?.trim() !== "0";
  let disclosure: ResidentCohortDisclosure;
  if (publicDisclosureEnabled) {
    disclosure = residentCohortDisclosure(
      true,
      process.env.MESHR_RESIDENT_DISCLOSURE_TEXT,
      process.env.MESHR_RESIDENT_DISCLOSURE_URL,
    )!;
  } else {
    const webUrl = new URL(required(process.env.MESHR_WEB_URL, "MESHR_WEB_URL"));
    if (webUrl.protocol !== "https:") {
      throw new Error("MESHR_WEB_URL must be HTTPS when resident public disclosure is disabled.");
    }
    disclosure = {
      text: "Operator-only resident cohort; public disclosure is disabled by explicit production policy.",
      url: webUrl.toString(),
    };
  }
  const manifest = parseResidentPrincipalManifest(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  const secret = await secretValue();
  const bundle = deriveResidentCredentialBundle(manifest, secret);
  const now = Date.now();
  const startsAt = Date.parse(bundle.createdAt);
  if (!deriveOnly && startsAt > now + 15 * 60 * 1_000) {
    throw new Error("Resident sessionStartsAt cannot be more than 15 minutes in the future.");
  }
  if (!deriveOnly && Date.parse(bundle.expiresAt) <= now) {
    throw new Error("Resident session generation is already expired; create a new generation.");
  }

  if (deriveOnly) {
    await writeCredentialBundle(outputPath!, bundle);
    console.log(JSON.stringify({
      component: "meshr-resident-seeder",
      event: "credentials.derived",
      generation: bundle.generation,
      manifestDigest: bundle.manifestDigest,
      accountCount: bundle.principals.length,
      expiresAt: bundle.expiresAt,
      credentialsWritten: true,
    }));
    return;
  }

  if (process.env.MESHR_STORAGE?.trim() !== "firestore") {
    throw new Error("Resident principal provisioning requires MESHR_STORAGE=firestore.");
  }
  if (publicDisclosureEnabled) {
    await assertResidentDisclosurePublished(
      disclosure,
      required(process.env.MESHR_WEB_URL, "MESHR_WEB_URL"),
    );
  }
  const projectId = required(process.env.GOOGLE_CLOUD_PROJECT, "GOOGLE_CLOUD_PROJECT");
  const databaseId = required(process.env.MESHR_FIRESTORE_DATABASE, "MESHR_FIRESTORE_DATABASE");
  const topologyDatabaseId = required(
    process.env.MESHR_TOPOLOGY_FIRESTORE_DATABASE,
    "MESHR_TOPOLOGY_FIRESTORE_DATABASE",
  );
  assertSeparatedProductionDatabases(databaseId, topologyDatabaseId, "production");
  const firestore = createFirestore(projectId, databaseId);
  const topologyFirestore = topologyDatabaseId === databaseId
    ? firestore
    : createFirestore(projectId, topologyDatabaseId);
  try {
    const repository = new FirestoreMeshrRepository({
      firestore,
      topologyFirestore,
      projectionBootstrapWriter: false,
    });
    await repository.checkReady();
    const summary = await provisionResidentPrincipals(repository, manifest, bundle, disclosure);
    if (outputPath) await writeCredentialBundle(outputPath, bundle);
    console.log(JSON.stringify({
      component: "meshr-resident-seeder",
      event: "principals.provisioned",
      ...summary,
      credentialsWritten: Boolean(outputPath),
    }));
  } finally {
    if (topologyFirestore !== firestore) await topologyFirestore.terminate();
    await firestore.terminate();
  }
}
