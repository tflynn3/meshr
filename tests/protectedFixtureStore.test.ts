import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Firestore } from "@google-cloud/firestore";
import {
  getCurrent,
  promote,
  prune,
  putStaged,
} from "../scripts/protected-fixture-store.ts";

/**
 * Exercise the release-audit pointer and generation CAS against the official
 * emulator. The fast unit suite skips this because it must not require a
 * Firestore process; `npm run test:firestore` supplies the emulator endpoint.
 */
test("protected fixture store is idempotent, generation-fenced, and prunable", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const previousEnvironment = process.env.MESHR_PROTECTED_FIXTURE_ENVIRONMENT;
  const previousDatabase = process.env.MESHR_AUDIT_FIRESTORE_DATABASE;
  const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
  const environment = "canary" as const;
  const database = "meshr-canary-release-audit";
  const project = previousProject?.trim() || "meshr-emulator";
  process.env.MESHR_PROTECTED_FIXTURE_ENVIRONMENT = environment;
  process.env.MESHR_AUDIT_FIRESTORE_DATABASE = database;
  process.env.GOOGLE_CLOUD_PROJECT = project;

  const directory = await mkdtemp(join(tmpdir(), "meshr-protected-fixture-store-"));
  const inputOne = join(directory, "one.enc");
  const inputTwo = join(directory, "two.enc");
  const currentOutput = join(directory, "current.enc");
  const generationOutput = join(directory, "current-generation");
  const firestore = new Firestore({ projectId: project, databaseId: database });
  const pointerRef = firestore.collection("protected_fixture_state").doc("current");
  const originalPointer = await pointerRef.get();
  const originalPointerData = originalPointer.exists ? originalPointer.data() : undefined;
  const generationOne = `emulator-${randomUUID()}`;
  const generationTwo = `emulator-${randomUUID()}`;

  try {
    const originalGeneration = originalPointerData?.generation;
    assert.equal(typeof originalGeneration === "undefined" || typeof originalGeneration === "string", true);
    await writeFile(inputOne, Buffer.from("encrypted-fixture-one"), { mode: 0o600 });
    await writeFile(inputTwo, Buffer.from("encrypted-fixture-two"), { mode: 0o600 });

    await putStaged(inputOne, generationOne);
    await promote(generationOne, typeof originalGeneration === "string" ? originalGeneration : "");
    // A lost response after promotion must be safe to retry even when the
    // retry carries a stale expected-generation value.
    await promote(generationOne, "stale-expected-generation");
    await getCurrent(currentOutput, generationOutput);
    assert.equal(await readFile(currentOutput, "utf8"), "encrypted-fixture-one");
    assert.equal(await readFile(generationOutput, "utf8"), generationOne);

    await putStaged(inputTwo, generationTwo);
    await promote(generationTwo, generationOne);
    await getCurrent(currentOutput, generationOutput);
    assert.equal(await readFile(currentOutput, "utf8"), "encrypted-fixture-two");
    assert.equal(await readFile(generationOutput, "utf8"), generationTwo);

    await prune(generationOne);
    await assert.rejects(prune(generationTwo), /current protected fixture generation/);
    await assert.rejects(
      promote(generationOne, generationTwo),
      /Cannot promote a protected fixture that was not staged/,
    );
  } finally {
    // Restore the emulator pointer so this conformance test is non-invasive
    // when it is run alongside another emulator-backed test process.
    await firestore.runTransaction(async (transaction) => {
      if (originalPointerData) transaction.set(pointerRef, originalPointerData, { merge: false });
      else transaction.delete(pointerRef);
      transaction.delete(firestore.collection("protected_fixture_state").doc(`envelope_canary_${generationOne}`));
      transaction.delete(firestore.collection("protected_fixture_state").doc(`envelope_canary_${generationTwo}`));
    });
    await firestore.terminate();
    await rm(directory, { recursive: true, force: true });
    if (previousEnvironment === undefined) delete process.env.MESHR_PROTECTED_FIXTURE_ENVIRONMENT;
    else process.env.MESHR_PROTECTED_FIXTURE_ENVIRONMENT = previousEnvironment;
    if (previousDatabase === undefined) delete process.env.MESHR_AUDIT_FIRESTORE_DATABASE;
    else process.env.MESHR_AUDIT_FIRESTORE_DATABASE = previousDatabase;
    if (previousProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
    else process.env.GOOGLE_CLOUD_PROJECT = previousProject;
  }
});
