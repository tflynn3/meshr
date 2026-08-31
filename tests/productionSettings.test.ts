import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  assertProductionSettings,
  type ProductionSettings,
} from "../server/production.ts";

function secret(label: string): string {
  return createHash("sha256").update(`meshr-production-settings:${label}`).digest("hex");
}

function validProductionSettings(): ProductionSettings {
  return {
    environment: "production",
    storage: "firestore",
    socialAuthOnly: true,
    secureCookies: true,
    webMcpTransfersSession: true,
    identityProjectId: "meshr-production",
    identityApiKey: "identity-api-key",
    renewalRecoverySecret: secret("renewal-current"),
    renewalRecoveryPreviousSecret: secret("renewal-previous"),
    invitationPepper: secret("invitation-current"),
    invitationPepperPrevious: secret("invitation-previous"),
    internalToken: secret("internal-token"),
    moderationAuthorityToken: secret("moderation-authority"),
    residentCohortEnabled: false,
  };
}

test("production accepts distinct cryptographic secret material", () => {
  assert.doesNotThrow(() => assertProductionSettings(validProductionSettings()));
  assert.doesNotThrow(() => assertProductionSettings({
    ...validProductionSettings(),
    // Eight distinct emoji are exactly 32 UTF-8 bytes, despite being only
    // sixteen JavaScript UTF-16 code units.
    internalToken: "😀😁😂😃😄😅😆😇",
  }));
});

test("production rejects short or known-placeholder values for every sensitive setting", () => {
  const fields = [
    ["renewalRecoverySecret", "MESHR_RENEWAL_RECOVERY_SECRET"],
    ["renewalRecoveryPreviousSecret", "MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS"],
    ["invitationPepper", "MESHR_INVITATION_PEPPER"],
    ["invitationPepperPrevious", "MESHR_INVITATION_PEPPER_PREVIOUS"],
    ["internalToken", "MESHR_INTERNAL_TOKEN"],
    ["moderationAuthorityToken", "MESHR_MODERATION_AUTHORITY_TOKEN"],
  ] as const;

  for (const [field, environmentName] of fields) {
    assert.throws(
      () => assertProductionSettings({
        ...validProductionSettings(),
        [field]: secret(field).slice(0, 31),
      }),
      new RegExp(environmentName),
    );
  }

  for (const placeholder of [
    "REPLACE_ME_WITH_A_SECURE_RANDOM_VALUE_NOW",
    "${MESHR_SECRET_FROM_SECRET_MANAGER}",
    "meshr-local-development-only-placeholder",
    "abcabcabcabcabcabcabcabcabcabcabcabc",
  ]) {
    assert.throws(
      () => assertProductionSettings({
        ...validProductionSettings(),
        internalToken: placeholder,
      }),
      /MESHR_INTERNAL_TOKEN/,
    );
  }
});

test("production rejects reused current and previous rotation values", () => {
  const renewal = secret("same-renewal");
  assert.throws(
    () => assertProductionSettings({
      ...validProductionSettings(),
      renewalRecoverySecret: renewal,
      renewalRecoveryPreviousSecret: renewal,
    }),
    /MESHR_RENEWAL_RECOVERY_SECRET and MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS must differ/,
  );

  const pepper = secret("same-pepper");
  assert.throws(
    () => assertProductionSettings({
      ...validProductionSettings(),
      invitationPepper: pepper,
      invitationPepperPrevious: pepper,
    }),
    /MESHR_INVITATION_PEPPER and MESHR_INVITATION_PEPPER_PREVIOUS must differ/,
  );
});

test("local startup preserves optional development secret semantics", () => {
  assert.doesNotThrow(() => assertProductionSettings({
    environment: "local",
    storage: "sqlite",
    socialAuthOnly: false,
    secureCookies: false,
    webMcpTransfersSession: true,
    renewalRecoverySecret: "short",
    renewalRecoveryPreviousSecret: "short",
    invitationPepper: "meshr-local-invitation-pepper",
    invitationPepperPrevious: "meshr-local-invitation-pepper",
    internalToken: "meshr-local-development-only",
    moderationAuthorityToken: undefined,
    residentCohortEnabled: false,
  }));
});
