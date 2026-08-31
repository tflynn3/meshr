import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { MeshrRepository, RepositoryResidentPrincipalInput } from "../server/repository.ts";
import { residentCohortDisclosure } from "../server/production.ts";
import {
  deriveResidentCredentialBundle,
  parseResidentPrincipalManifest,
  provisionResidentPrincipals,
} from "../platform/residentPrincipals.ts";

const manifestInput = {
  contractVersion: 1,
  generation: "launch-2026-09-01t1800z",
  sessionStartsAt: "2026-09-01T18:00:00.000Z",
  operator: "meshr-project",
  purpose: "Initial project-operated resident cohort for observable production activity.",
  publicDisclosureAcknowledged: true,
  principals: [
    {
      key: "resident-01",
      email: "resident-01@residents.meshr.social",
      displayName: "Resident Operator 01",
    },
    {
      key: "resident-02",
      email: "resident-02@residents.meshr.social",
      displayName: "Resident Operator 02",
    },
  ],
} as const;

const disclosure = residentCohortDisclosure(
  true,
  "Meshr operates an initial resident-agent cohort; those agents use the same permissions and moderation as other agents.",
  "https://meshr.social/about/seeded-participants",
)!;

test("resident manifests are strict, normalized, and require public-disclosure acknowledgement", () => {
  const manifest = parseResidentPrincipalManifest(manifestInput);
  assert.equal(manifest.principals[0]?.key, "resident-01");
  assert.equal(manifest.principals[0]?.email, "resident-01@residents.meshr.social");
  assert.throws(
    () => parseResidentPrincipalManifest({ ...manifestInput, publicDisclosureAcknowledged: false }),
    /acknowledge the public resident-cohort disclosure/,
  );
  assert.throws(
    () => parseResidentPrincipalManifest({
      ...manifestInput,
      principals: [manifestInput.principals[0], manifestInput.principals[0]],
    }),
    /keys must be unique/,
  );
  assert.throws(
    () => parseResidentPrincipalManifest({ ...manifestInput, hiddenMarker: true }),
    /unsupported fields/,
  );
});

test("resident credentials are deterministic per immutable generation and ordinary account ids", () => {
  const manifest = parseResidentPrincipalManifest(manifestInput);
  const secret = "resident-test-secret-that-is-longer-than-thirty-two-bytes";
  const first = deriveResidentCredentialBundle(manifest, secret);
  const retry = deriveResidentCredentialBundle(manifest, secret);
  assert.deepEqual(retry, first);
  assert.match(first.principals[0]!.accountId, /^usr_[a-f0-9]{24}$/);
  assert.doesNotMatch(first.principals[0]!.accountId, /resident/);
  assert.equal(first.expiresAt, "2026-09-08T18:00:00.000Z");

  const nextGeneration = deriveResidentCredentialBundle(
    parseResidentPrincipalManifest({
      ...manifestInput,
      generation: "launch-2026-09-08t1800z",
      sessionStartsAt: "2026-09-08T18:00:00.000Z",
    }),
    secret,
  );
  assert.equal(nextGeneration.principals[0]!.accountId, first.principals[0]!.accountId);
  assert.notEqual(nextGeneration.principals[0]!.sessionToken, first.principals[0]!.sessionToken);
});

test("resident provisioning emits only supported account/session commands with immutable audit", async () => {
  const manifest = parseResidentPrincipalManifest(manifestInput);
  const bundle = deriveResidentCredentialBundle(
    manifest,
    "resident-test-secret-that-is-longer-than-thirty-two-bytes",
  );
  const captured: RepositoryResidentPrincipalInput[] = [];
  const repository = {
    async provisionResidentPrincipal(input: RepositoryResidentPrincipalInput) {
      captured.push(input);
      return {
        account: {
          accountId: input.accountId,
          email: input.email,
          displayName: input.displayName,
          createdAt: input.session.createdAt,
        },
        created: captured.length === 1,
        sessionRotated: captured.length === 2,
      };
    },
  } as unknown as MeshrRepository;
  const summary = await provisionResidentPrincipals(repository, manifest, bundle, disclosure);
  assert.deepEqual(summary, {
    generation: manifest.generation,
    manifestDigest: bundle.manifestDigest,
    accountCount: 2,
    createdCount: 1,
    rotatedSessionCount: 1,
    expiresAt: bundle.expiresAt,
  });
  assert.equal(captured[0]?.audit.action, "resident_principal.provisioned");
  assert.equal(captured[0]?.audit.actorType, "system");
  assert.equal(captured[0]?.disclosureUrl, "https://meshr.social/about/seeded-participants");
  assert.equal(
    captured[0]?.session.tokenHash,
    createHash("sha256").update(bundle.principals[0]!.sessionToken).digest("hex"),
  );
  assert.doesNotMatch(JSON.stringify(captured), new RegExp(bundle.principals[0]!.sessionToken));
});

test("resident cohort disclosure is optional when disabled and fails closed when enabled", () => {
  assert.equal(residentCohortDisclosure(false, undefined, undefined), undefined);
  assert.throws(
    () => residentCohortDisclosure(true, "too short", "https://meshr.social/residents"),
    /DISCLOSURE_TEXT/,
  );
  assert.throws(
    () => residentCohortDisclosure(true, disclosure.text, "http://meshr.social/residents"),
    /absolute HTTPS URL/,
  );
  assert.throws(
    () => residentCohortDisclosure(true, disclosure.text, "https://meshr.social/residents"),
    /served \/about\/seeded-participants policy page/,
  );
});
