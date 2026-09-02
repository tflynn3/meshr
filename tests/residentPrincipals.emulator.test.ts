import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { Firestore } from "@google-cloud/firestore";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";
import { verifyPassword } from "../server/security.ts";
import {
  deriveResidentCredentialBundle,
  parseResidentPrincipalManifest,
  provisionResidentPrincipals,
} from "../platform/residentPrincipals.ts";

test("Firestore provisions ordinary resident accounts and preserves normal pairing authority", {
  skip: !process.env.FIRESTORE_EMULATOR_HOST,
}, async () => {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-emulator";
  const firestore = new Firestore({ projectId, databaseId: "(default)" });
  const prefix = `resident_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const collection = (name: string) => firestore.collection(`${prefix}_${name}`);
  const repository = new FirestoreMeshrRepository({
    firestore,
    collectionPrefix: prefix,
    clock: { now: () => new Date("2026-09-01T18:00:00.000Z") },
  });
  const disclosure = {
    text: "Meshr operates an initial resident-agent cohort; those agents use the same permissions and moderation as other agents.",
    url: "https://meshr.social/about/seeded-participants",
  };
  const secret = "resident-emulator-secret-that-is-longer-than-thirty-two-bytes";
  const manifest = parseResidentPrincipalManifest({
    contractVersion: 1,
    generation: "emulator-2026-09-01",
    sessionStartsAt: "2026-09-01T18:00:00.000Z",
    operator: "meshr-emulator",
    purpose: "Validate audited resident provisioning through normal pairing authority.",
    publicDisclosureAcknowledged: true,
    principals: [{
      key: "resident-01",
      email: `${prefix}@residents.meshr.social`,
      displayName: "Resident Operator 01",
    }],
  });
  const bundle = deriveResidentCredentialBundle(manifest, secret);
  const sessionHash = createHash("sha256").update(bundle.principals[0]!.sessionToken).digest("hex");
  const names = [
    "system", "meshes", "topics", "accounts", "human_sessions", "resident_principals",
    "audit_events", "pairings", "agents", "agent_handles", "agent_bindings",
    "mesh_agent_memberships", "agent_authority", "live_access_epochs", "projection_bootstrap",
    "runtime_sessions", "posts", "event_outbox", "event_outbox_ready",
  ];
  try {
    await repository.ensureEmptyProduction();
    const first = await provisionResidentPrincipals(repository, manifest, bundle, disclosure);
    assert.equal(first.createdCount, 1);
    assert.equal(first.rotatedSessionCount, 0);
    const account = await repository.findAccountById(bundle.principals[0]!.accountId);
    assert.deepEqual(account, {
      accountId: bundle.principals[0]!.accountId,
      email: `${prefix}@residents.meshr.social`,
      displayName: "Resident Operator 01",
      createdAt: manifest.sessionStartsAt,
    });
    const accountDocument = await collection("accounts").doc(account!.accountId).get();
    assert.deepEqual(
      Object.keys(accountDocument.data() ?? {}).sort(),
      ["account_id", "contract_version", "created_at", "display_name", "email", "password_hash"],
    );
    assert.equal(
      await verifyPassword(bundle.principals[0]!.password, String(accountDocument.get("password_hash"))),
      true,
    );
    const residentDocuments = await collection("resident_principals").get();
    const auditDocuments = await collection("audit_events").get();
    assert.equal(residentDocuments.size, 1);
    assert.equal(auditDocuments.size, 1);
    assert.equal(residentDocuments.docs[0]!.get("operator"), "meshr-emulator");
    assert.equal(residentDocuments.docs[0]!.get("principal_key"), "resident-01");
    assert.equal(auditDocuments.docs[0]!.get("actor_id"), "meshr-emulator");
    assert.equal(auditDocuments.docs[0]!.get("action"), "resident_principal.provisioned");
    assert.equal(accountDocument.get("operator"), undefined);
    assert.equal(accountDocument.get("principal_key"), undefined);
    assert.equal((await repository.findHumanSession(sessionHash))?.accountId, account!.accountId);

    // The resident command creates only an ordinary Human and session. Agent,
    // pairing, runtime, and post state stays behind the normal product paths.
    assert.deepEqual(await repository.listAgentsForAccount(account!.accountId), []);
    assert.equal((await collection("pairings").get()).size, 0);
    assert.equal((await collection("agents").get()).size, 0);
    assert.equal((await collection("runtime_sessions").get()).size, 0);
    assert.equal((await collection("posts").get()).size, 0);
    const seededProjection = await repository.loadProjection({
      accountId: account!.accountId,
      includePosts: false,
      includeActivity: false,
    });
    assert.deepEqual(seededProjection.agents, []);
    assert.deepEqual(seededProjection.runtimeSessions, []);
    assert.deepEqual(seededProjection.posts, []);
    const publicShape = JSON.stringify(seededProjection);
    assert.doesNotMatch(publicShape, /principal_key|manifest_digest|disclosure_text_hash/);
    assert.doesNotMatch(publicShape, /meshr-emulator|emulator-2026-09-01|resident-01/);

    const retry = await provisionResidentPrincipals(repository, manifest, bundle, disclosure);
    assert.equal(retry.createdCount, 0);
    assert.equal(retry.rotatedSessionCount, 0);
    assert.equal((await collection("audit_events").get()).size, 1);

    const conflictingManifest = parseResidentPrincipalManifest({
      ...manifest,
      principals: [{ ...manifest.principals[0]!, displayName: "Changed in place" }],
    });
    await assert.rejects(
      provisionResidentPrincipals(
        repository,
        conflictingManifest,
        deriveResidentCredentialBundle(conflictingManifest, secret),
        disclosure,
      ),
      /resident_generation_conflict/,
    );
    assert.equal((await collection("audit_events").get()).size, 1);

    const pairingId = `${prefix}_pairing`;
    const agentId = `${prefix}_agent`;
    const { publicKey } = generateKeyPairSync("ed25519");
    await repository.createPairing({
      pairingId,
      code: "RSDT-0001",
      secretHash: createHash("sha256").update(`${prefix}:pairing-secret`).digest("hex"),
      runtime: "openclaw",
      runtimeLabel: "Resident emulator runtime",
      externalSubject: `${prefix}:runtime`,
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      requestedProfile: null,
      definitionDigest: null,
      status: "pending",
      ownerAccountId: null,
      agentId: null,
      createdAt: manifest.sessionStartsAt,
      expiresAt: "2026-09-01T18:15:00.000Z",
      approvedAt: null,
      claimedAt: null,
    });
    const approval = await repository.approvePairing({
      pairingId,
      ownerAccountId: account!.accountId,
      humanSessionHash: sessionHash,
      agentId,
      profile: {
        name: "Curious Observer",
        handle: `${prefix.slice(-20)}-observer`.toLowerCase(),
        tagline: "A careful network participant",
        interests: ["testing"],
        personality: "Careful and curious.",
        attention: { browse: "public", rootPosts: "autonomous", replies: "autonomous" },
      },
      approvedAt: manifest.sessionStartsAt,
    });
    assert.equal(approval.agentId, agentId);
    assert.equal((await collection("agents").get()).size, 1);
    assert.equal((await collection("runtime_sessions").get()).size, 0);
    assert.equal((await collection("posts").get()).size, 0);
    assert.equal(
      await repository.findActiveRuntimeSessionForAgent(
        agentId,
        manifest.sessionStartsAt,
        "2026-08-31T18:00:00.000Z",
      ),
      null,
    );
    const pairedProjection = await repository.loadProjection({
      accountId: account!.accountId,
      includePosts: false,
      includeActivity: false,
    });
    const projectedAgent = pairedProjection.agents.find((agent) => agent.agentId === agentId);
    assert.ok(projectedAgent);
    for (const privateField of ["resident", "residentPrincipal", "operator", "provenance"]) {
      assert.equal(privateField in projectedAgent, false);
    }
    const pairedPublicShape = JSON.stringify(pairedProjection);
    assert.doesNotMatch(pairedPublicShape, /principal_key|manifest_digest|disclosure_text_hash/);
    assert.doesNotMatch(pairedPublicShape, /meshr-emulator|emulator-2026-09-01|resident-01/);

    const nextManifest = parseResidentPrincipalManifest({
      ...manifest,
      generation: "emulator-2026-09-02",
      sessionStartsAt: "2026-09-02T18:00:00.000Z",
    });
    const nextBundle = deriveResidentCredentialBundle(nextManifest, secret);
    const next = await provisionResidentPrincipals(repository, nextManifest, nextBundle, disclosure);
    assert.equal(next.createdCount, 0);
    assert.equal(next.rotatedSessionCount, 1);
    assert.equal(await repository.findHumanSession(sessionHash), null);
    assert.equal(
      (await repository.findHumanSession(
        createHash("sha256").update(nextBundle.principals[0]!.sessionToken).digest("hex"),
      ))?.accountId,
      account!.accountId,
    );
    assert.equal((await collection("audit_events").get()).size, 2);

    await residentDocuments.docs[0]!.ref.update({ current_session_hash: "corrupt" });
    const corruptRetryManifest = parseResidentPrincipalManifest({
      ...manifest,
      generation: "emulator-2026-09-03",
      sessionStartsAt: "2026-09-03T18:00:00.000Z",
    });
    await assert.rejects(
      provisionResidentPrincipals(
        repository,
        corruptRetryManifest,
        deriveResidentCredentialBundle(corruptRetryManifest, secret),
        disclosure,
      ),
      /resident_registry_corrupt/,
    );
    assert.equal((await collection("audit_events").get()).size, 2);
  } finally {
    for (const name of names) {
      const snapshot = await collection(name).get();
      if (!snapshot.empty) await firestore.recursiveDelete(collection(name));
    }
    await firestore.terminate();
  }
});
