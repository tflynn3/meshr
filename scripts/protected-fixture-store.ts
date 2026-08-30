#!/usr/bin/env node

import { readFile, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Firestore } from "@google-cloud/firestore";

/**
 * Keep the current protected native-session envelope in the dedicated
 * release-audit database. GitHub Actions artifacts remain useful evidence,
 * but they are not a recovery authority: a rerun can make a prior attempt's
 * artifact unavailable. The envelope is already AES-256-GCM encrypted by
 * protected-fixture-state.ts; this helper never receives the decryption key.
 */

const COLLECTION = "protected_fixture_state";
const POINTER_DOCUMENT = "current";
const ENVELOPE_DOCUMENT_PREFIX = "envelope_";
// Firestore documents are limited to 1 MiB. The envelope is base64 encoded
// inside the document, so keep the binary payload well below that limit with
// room for metadata and future fields. The plaintext companion helper caps
// state at 384 KiB, keeping the encrypted JSON envelope inside this bound.
const MAX_ENVELOPE_BYTES = 512 * 1024;

function argument(values: string[], name: string): string | undefined {
  const index = values.indexOf(name);
  return index === -1 ? undefined : values[index + 1];
}

function requiredArgument(values: string[], name: string): string {
  const value = argument(values, name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function environmentName(): "canary" | "production" {
  const value = (process.env.MESHR_PROTECTED_FIXTURE_ENVIRONMENT ?? "").trim().toLowerCase();
  if (value !== "canary" && value !== "production") {
    throw new Error("MESHR_PROTECTED_FIXTURE_ENVIRONMENT must be canary or production.");
  }
  return value;
}

function databaseName(environment: "canary" | "production"): string {
  const value = process.env.MESHR_AUDIT_FIRESTORE_DATABASE?.trim();
  const expected = environment === "canary"
    ? "meshr-canary-release-audit"
    : "meshr-release-audit";
  if (value !== expected) {
    throw new Error(`MESHR_AUDIT_FIRESTORE_DATABASE must be ${expected} for ${environment} protected fixture state.`);
  }
  return value;
}

function projectId(): string {
  const value = (process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT_ID)?.trim();
  if (!value) throw new Error("GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID is required.");
  return value;
}

function documentId(environment: string, generation: string): string {
  const safeEnvironment = environment.replace(/[^a-z0-9_-]/gi, "");
  const safeGeneration = generation.replace(/[^a-z0-9_.:-]/gi, "");
  if (!safeEnvironment || !safeGeneration) throw new Error("Protected fixture generation is invalid.");
  return `${ENVELOPE_DOCUMENT_PREFIX}${safeEnvironment}_${safeGeneration}`.slice(0, 1_500);
}

export async function getCurrent(outputPath: string, generationOutputPath?: string): Promise<void> {
  // Always clear the requested output before reading the pointer. A reused
  // runner or a failed lookup must never leave an older encrypted envelope in
  // place for the caller to mistake for the current fixture.
  const resolvedOutputPath = resolve(outputPath);
  await writeFile(resolvedOutputPath, Buffer.alloc(0), { mode: 0o600 });
  await chmod(resolvedOutputPath, 0o600);
  const resolvedGenerationOutputPath = generationOutputPath ? resolve(generationOutputPath) : undefined;
  if (resolvedGenerationOutputPath) {
    await writeFile(resolvedGenerationOutputPath, Buffer.alloc(0), { mode: 0o600 });
    await chmod(resolvedGenerationOutputPath, 0o600);
  }
  const environment = environmentName();
  const firestore = new Firestore({ projectId: projectId(), databaseId: databaseName(environment) });
  try {
    const pointer = await firestore.collection(COLLECTION).doc(POINTER_DOCUMENT).get();
    if (!pointer.exists) return;
    const generation = pointer.get("generation");
    if (typeof generation !== "string" || !generation.trim()) {
      throw new Error("Protected fixture pointer is missing its generation.");
    }
    if (resolvedGenerationOutputPath) {
      await writeFile(resolvedGenerationOutputPath, generation, { mode: 0o600 });
      await chmod(resolvedGenerationOutputPath, 0o600);
    }
    const pointerDocument = pointer.get("envelope_document");
    if (typeof pointerDocument !== "string" || pointerDocument !== documentId(environment, generation)) {
      throw new Error("Protected fixture pointer is malformed.");
    }
    const envelope = await firestore.collection(COLLECTION).doc(pointerDocument).get();
    if (!envelope.exists) throw new Error("Protected fixture pointer target is missing.");
    const encoded = envelope.get("envelope");
    if (envelope.get("environment") !== environment || envelope.get("generation") !== generation) {
      throw new Error("Protected fixture pointer target has the wrong environment or generation.");
    }
    if (typeof encoded !== "string" || !encoded.trim()) {
      throw new Error("Protected fixture envelope is malformed.");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) {
      throw new Error("Protected fixture envelope has an invalid size.");
    }
    await writeFile(resolvedOutputPath, bytes, { mode: 0o600 });
    await chmod(resolvedOutputPath, 0o600);
  } finally {
    await firestore.terminate();
  }
}

export async function putStaged(inputPath: string, generation: string): Promise<void> {
  const bytes = await readFile(resolve(inputPath));
  if (bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) {
    throw new Error("Protected fixture envelope has an invalid size.");
  }
  const environment = environmentName();
  const firestore = new Firestore({ projectId: projectId(), databaseId: databaseName(environment) });
  const envelopeDocument = documentId(environment, generation);
  const envelopeRef = firestore.collection(COLLECTION).doc(envelopeDocument);
  const pointerRef = firestore.collection(COLLECTION).doc(POINTER_DOCUMENT);
  try {
    await firestore.runTransaction(async (transaction) => {
      const pointer = await transaction.get(pointerRef);
      const existing = await transaction.get(envelopeRef);
      if (existing.exists) {
        const existingEnvironment = existing.get("environment");
        const existingGeneration = existing.get("generation");
        const existingEnvelope = existing.get("envelope");
        if (existingEnvironment !== environment || existingGeneration !== generation) {
          throw new Error("Protected fixture generation collides with another environment or generation.");
        }
        if (existingEnvelope === bytes.toString("base64")) {
          return;
        }
        // A staged envelope can be replaced when it is not the live pointer.
        // Once promoted, its generation is immutable so a retry cannot swap
        // the credentials underneath an active protected runtime.
        if (pointer.exists && pointer.get("generation") === generation) {
          throw new Error("Protected fixture generation already contains a different envelope.");
        }
      }
      transaction.set(envelopeRef, {
        version: 1,
        environment,
        generation,
        envelope: bytes.toString("base64"),
        updated_at: new Date().toISOString(),
      }, { merge: false });
    });
  } finally {
    await firestore.terminate();
  }
}

export async function promote(inputGeneration: string, expectedGeneration: string): Promise<void> {
  const environment = environmentName();
  const firestore = new Firestore({ projectId: projectId(), databaseId: databaseName(environment) });
  const pointerRef = firestore.collection(COLLECTION).doc(POINTER_DOCUMENT);
  const envelopeDocument = documentId(environment, inputGeneration);
  const envelopeRef = firestore.collection(COLLECTION).doc(envelopeDocument);
  try {
    await firestore.runTransaction(async (transaction) => {
      const pointer = await transaction.get(pointerRef);
      if (pointer.exists && pointer.get("environment") !== environment) {
        throw new Error("Protected fixture pointer belongs to another environment.");
      }
      const currentGeneration = pointer.exists ? pointer.get("generation") : "";
      if (typeof currentGeneration !== "string") {
        throw new Error("Protected fixture pointer is malformed.");
      }
      // A lost response after a successful promotion is safe to retry. Keep
      // the CAS guard for every other pointer value, but treat the requested
      // generation already being current as an idempotent success after
      // validating that the pointer still targets the expected envelope.
      if (currentGeneration === inputGeneration) {
        if (pointer.get("envelope_document") !== envelopeDocument) {
          throw new Error("Protected fixture pointer is malformed.");
        }
        const currentEnvelope = await transaction.get(envelopeRef);
        if (
          !currentEnvelope.exists ||
          currentEnvelope.get("environment") !== environment ||
          currentEnvelope.get("generation") !== inputGeneration
        ) {
          throw new Error("Current protected fixture pointer target is missing or malformed.");
        }
        return;
      }
      if (currentGeneration !== expectedGeneration) {
        throw new Error(`Protected fixture pointer changed from expected generation ${expectedGeneration || "<empty>"}.`);
      }
      const envelope = await transaction.get(envelopeRef);
      if (!envelope.exists) throw new Error("Cannot promote a protected fixture that was not staged.");
      if (envelope.get("environment") !== environment || envelope.get("generation") !== inputGeneration) {
        throw new Error("Staged protected fixture envelope is malformed.");
      }
      const encoded = envelope.get("envelope");
      if (typeof encoded !== "string" || !encoded.trim()) {
        throw new Error("Staged protected fixture envelope is malformed.");
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length === 0 || bytes.length > MAX_ENVELOPE_BYTES) {
        throw new Error("Staged protected fixture envelope has an invalid size.");
      }
      transaction.set(pointerRef, {
        version: 1,
        environment,
        generation: inputGeneration,
        envelope_document: envelopeDocument,
        updated_at: new Date().toISOString(),
      }, { merge: false });
    });
  } finally {
    await firestore.terminate();
  }
}

export async function prune(generation: string): Promise<void> {
  const environment = environmentName();
  const firestore = new Firestore({ projectId: projectId(), databaseId: databaseName(environment) });
  const pointerRef = firestore.collection(COLLECTION).doc(POINTER_DOCUMENT);
  const envelopeRef = firestore.collection(COLLECTION).doc(documentId(environment, generation));
  try {
    await firestore.runTransaction(async (transaction) => {
      const pointer = await transaction.get(pointerRef);
      if (pointer.exists && pointer.get("generation") === generation) {
        throw new Error("Refusing to prune the current protected fixture generation.");
      }
      const envelope = await transaction.get(envelopeRef);
      if (envelope.exists && envelope.get("environment") !== environment) {
        throw new Error("Protected fixture envelope belongs to another environment.");
      }
      if (envelope.exists) transaction.delete(envelopeRef);
    });
  } finally {
    await firestore.terminate();
  }
}

function usage(): string {
  return [
    "Usage:",
    "  npm run protected:state:store -- get --output <encrypted-envelope> [--generation-output <file>]",
    "  npm run protected:state:store -- put --input <encrypted-envelope> --generation <id>",
    "  npm run protected:state:store -- promote --generation <id> --expected-generation <id-or-empty>",
    "  npm run protected:state:store -- prune --generation <superseded-id>",
    "",
    "Environment:",
    "  MESHR_PROTECTED_FIXTURE_ENVIRONMENT=canary|production",
    "  MESHR_AUDIT_FIRESTORE_DATABASE=<dedicated release-audit database>",
    "  GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID=<project>",
  ].join("\n");
}

async function main(values = process.argv.slice(2)): Promise<void> {
  const mode = values[0];
  if (mode === "--help" || mode === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (mode === "get") {
    await getCurrent(requiredArgument(values, "--output"), argument(values, "--generation-output"));
    return;
  }
  if (mode === "put") {
    await putStaged(requiredArgument(values, "--input"), requiredArgument(values, "--generation"));
    return;
  }
  if (mode === "promote") {
    const expectedGeneration = argument(values, "--expected-generation");
    if (expectedGeneration === undefined) throw new Error("--expected-generation is required (use an empty value when no pointer exists).");
    await promote(requiredArgument(values, "--generation"), expectedGeneration.trim());
    return;
  }
  if (mode === "prune") {
    await prune(requiredArgument(values, "--generation"));
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
