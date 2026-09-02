export interface ProductionSettings {
  environment: "local" | "production";
  storage: "sqlite" | "firestore";
  socialAuthOnly: boolean;
  secureCookies: boolean;
  webMcpTransfersSession: boolean;
  identityProjectId?: string;
  identityApiKey?: string;
  renewalRecoverySecret?: string;
  renewalRecoveryPreviousSecret?: string;
  invitationPepper?: string;
  invitationPepperPrevious?: string;
  internalToken?: string;
  moderationAuthorityToken?: string;
  /** Public, cohort-level notice for project-operated resident agents. */
  residentCohortEnabled: boolean;
  /** Whether the cohort notice is exposed through the public auth config. */
  residentPublicDisclosure: boolean;
  residentDisclosureText?: string;
  residentDisclosureUrl?: string;
}

export interface ResidentCohortDisclosure {
  text: string;
  url: string;
}

export const RESIDENT_COHORT_POLICY_PATH = "/about/seeded-participants";
export const RESIDENT_COHORT_POLICY_MARKER = "meshr-seeded-participants-policy-v1";

const MINIMUM_PRODUCTION_SECRET_BYTES = 32;
const SECRET_PLACEHOLDER_PATTERNS = [
  /^(?:replace(?:[_\s-]?me)?|change(?:[_\s-]?me)?|placeholder|example|sample|dummy|test|todo|secret|password|token|pepper)(?:[_\s-].*)?$/i,
  /^(?:your|insert|enter|set)(?:[_\s-]+).*(?:secret|token|pepper|password|key)(?:[_\s-].*)?$/i,
  /^(?:meshr[_\s-]?local|local[_\s-]?development)(?:[_\s-].*)?$/i,
  /^\$\{[^}]+\}$/,
  /^<[^>]+>$/,
];

function isRepeatedSecretPattern(value: string): boolean {
  const symbols = [...value];
  for (let width = 1; width <= Math.floor(symbols.length / 2); width += 1) {
    if (symbols.length % width !== 0) continue;
    const pattern = symbols.slice(0, width);
    if (symbols.every((symbol, index) => symbol === pattern[index % width])) return true;
  }
  return false;
}

/**
 * Startup cannot prove that an operator generated a value unpredictably, but
 * it can reject representations that are too short for 256-bit material and
 * obvious development/template values. This check deliberately counts UTF-8
 * bytes because Secret Manager values are byte strings, not JavaScript code
 * units.
 */
function usableProductionSecret(value: string | undefined): value is string {
  const normalized = value?.trim() ?? "";
  return Boolean(
    normalized &&
      Buffer.byteLength(normalized, "utf8") >= MINIMUM_PRODUCTION_SECRET_BYTES &&
      !SECRET_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized)) &&
      !isRepeatedSecretPattern(normalized),
  );
}

/**
 * Resolve the public resident-cohort notice. Individual resident principals
 * remain ordinary accounts; this site-level disclosure prevents the initial
 * project-operated activity from being presented as undisclosed organic
 * adoption.
 */
export function residentCohortDisclosure(
  enabled: boolean,
  text: string | undefined,
  url: string | undefined,
): ResidentCohortDisclosure | undefined {
  if (!enabled) return undefined;
  const normalizedText = text?.trim() ?? "";
  const normalizedUrl = url?.trim() ?? "";
  if (normalizedText.length < 20 || normalizedText.length > 280) {
    throw new Error(
      "MESHR_RESIDENT_DISCLOSURE_TEXT must be between 20 and 280 characters when the resident cohort is enabled.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new Error(
      "MESHR_RESIDENT_DISCLOSURE_URL must be an absolute HTTPS URL when the resident cohort is enabled.",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      "MESHR_RESIDENT_DISCLOSURE_URL must be an absolute HTTPS URL when the resident cohort is enabled.",
    );
  }
  if (
    parsed.pathname !== RESIDENT_COHORT_POLICY_PATH ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `MESHR_RESIDENT_DISCLOSURE_URL must point to the served ${RESIDENT_COHORT_POLICY_PATH} policy page.`,
    );
  }
  return { text: normalizedText, url: parsed.toString() };
}

export function productionSettings(
  environment = process.env.MESHR_ENV?.trim() || "local",
): ProductionSettings {
  const normalizedEnvironment = environment === "production" ? "production" : "local";
  const storage = process.env.MESHR_STORAGE?.trim() === "firestore" ? "firestore" : "sqlite";
  const socialAuthOnly = process.env.MESHR_SOCIAL_AUTH_ONLY === "1";
  const secureCookies = process.env.MESHR_SECURE_COOKIES === "1";
  const webMcpTransfersSession = process.env.MESHR_WEBMCP_SESSION_TRANSFER !== "0";
  const identityProjectId =
    process.env.MESHR_IDENTITY_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim();
  const identityApiKey = process.env.MESHR_IDENTITY_API_KEY?.trim();
  const renewalRecoverySecret = process.env.MESHR_RENEWAL_RECOVERY_SECRET?.trim();
  const renewalRecoveryPreviousSecret = process.env.MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS?.trim();
  const invitationPepper = process.env.MESHR_INVITATION_PEPPER?.trim();
  const invitationPepperPrevious = process.env.MESHR_INVITATION_PEPPER_PREVIOUS?.trim();
  const residentCohortEnabled = process.env.MESHR_RESIDENT_COHORT_ENABLED?.trim() === "1";
  const residentPublicDisclosure =
    process.env.MESHR_RESIDENT_PUBLIC_DISCLOSURE?.trim() !== "0";
  return {
    environment: normalizedEnvironment,
    storage,
    socialAuthOnly,
    secureCookies,
    webMcpTransfersSession,
    identityProjectId,
    identityApiKey,
    renewalRecoverySecret,
    renewalRecoveryPreviousSecret,
    invitationPepper,
    invitationPepperPrevious,
    internalToken: process.env.MESHR_INTERNAL_TOKEN?.trim(),
    moderationAuthorityToken: process.env.MESHR_MODERATION_AUTHORITY_TOKEN?.trim(),
    residentCohortEnabled,
    residentPublicDisclosure,
    residentDisclosureText: process.env.MESHR_RESIDENT_DISCLOSURE_TEXT?.trim(),
    residentDisclosureUrl: process.env.MESHR_RESIDENT_DISCLOSURE_URL?.trim(),
  };
}

export function assertProductionSettings(settings: ProductionSettings): void {
  const costProtectionMode = process.env.MESHR_COST_PROTECTION_MODE?.trim().toLowerCase();
  if (costProtectionMode && !["normal", "protect", "throttle"].includes(costProtectionMode)) {
    throw new Error("MESHR_COST_PROTECTION_MODE must be normal, protect, or throttle.");
  }
  if (settings.environment !== "production") return;
  if (settings.residentCohortEnabled && settings.residentPublicDisclosure) {
    residentCohortDisclosure(
      true,
      settings.residentDisclosureText,
      settings.residentDisclosureUrl,
    );
  }
  const invalid: string[] = [];
  const usable = (value: string | undefined): value is string => Boolean(
    value &&
      value.trim() &&
      !/^(?:REPLACE(?:_|$)|PROJECT_ID$|\$\{[^}]+\})/i.test(value.trim()),
  );
  if (settings.storage !== "firestore") invalid.push("MESHR_STORAGE=firestore");
  // Email/password admission is backed by the Firestore account authority in
  // production. Social-only mode remains available for deployments that
  // choose it, but it is not a production safety invariant.
  if (!settings.secureCookies) invalid.push("MESHR_SECURE_COOKIES=1");
  if (!settings.webMcpTransfersSession) invalid.push("MESHR_WEBMCP_SESSION_TRANSFER=1");
  if (!usable(settings.identityProjectId)) invalid.push("MESHR_IDENTITY_PROJECT_ID or GOOGLE_CLOUD_PROJECT");
  if (!usable(settings.identityApiKey)) invalid.push("MESHR_IDENTITY_API_KEY");
  if (!usableProductionSecret(settings.renewalRecoverySecret)) invalid.push("MESHR_RENEWAL_RECOVERY_SECRET");
  if (!usableProductionSecret(settings.renewalRecoveryPreviousSecret)) invalid.push("MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS");
  if (!usableProductionSecret(settings.invitationPepper)) invalid.push("MESHR_INVITATION_PEPPER");
  if (!usableProductionSecret(settings.invitationPepperPrevious)) invalid.push("MESHR_INVITATION_PEPPER_PREVIOUS");
  if (!usableProductionSecret(settings.internalToken)) invalid.push("MESHR_INTERNAL_TOKEN");
  if (!usableProductionSecret(settings.moderationAuthorityToken)) invalid.push("MESHR_MODERATION_AUTHORITY_TOKEN");
  if (
    usableProductionSecret(settings.renewalRecoverySecret) &&
    usableProductionSecret(settings.renewalRecoveryPreviousSecret) &&
    settings.renewalRecoverySecret.trim() === settings.renewalRecoveryPreviousSecret.trim()
  ) {
    invalid.push("MESHR_RENEWAL_RECOVERY_SECRET and MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS must differ");
  }
  if (
    usableProductionSecret(settings.invitationPepper) &&
    usableProductionSecret(settings.invitationPepperPrevious) &&
    settings.invitationPepper.trim() === settings.invitationPepperPrevious.trim()
  ) {
    invalid.push("MESHR_INVITATION_PEPPER and MESHR_INVITATION_PEPPER_PREVIOUS must differ");
  }
  if (invalid.length) {
    throw new Error(
      "Production Meshr startup is blocked until these settings are configured: " +
        invalid.join(", "),
    );
  }
}
