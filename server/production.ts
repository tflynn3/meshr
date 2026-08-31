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
  residentDisclosureText?: string;
  residentDisclosureUrl?: string;
}

export interface ResidentCohortDisclosure {
  text: string;
  url: string;
}

export const RESIDENT_COHORT_POLICY_PATH = "/about/seeded-participants";
export const RESIDENT_COHORT_POLICY_MARKER = "meshr-seeded-participants-policy-v1";

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
  residentCohortDisclosure(
    settings.residentCohortEnabled,
    settings.residentDisclosureText,
    settings.residentDisclosureUrl,
  );
  const missing: string[] = [];
  const usable = (value: string | undefined): value is string => Boolean(
    value &&
      value.trim() &&
      !/^(?:REPLACE(?:_|$)|PROJECT_ID$|\$\{[^}]+\})/i.test(value.trim()),
  );
  if (settings.storage !== "firestore") missing.push("MESHR_STORAGE=firestore");
  if (!settings.socialAuthOnly) missing.push("MESHR_SOCIAL_AUTH_ONLY=1");
  if (!settings.secureCookies) missing.push("MESHR_SECURE_COOKIES=1");
  if (!settings.webMcpTransfersSession) missing.push("MESHR_WEBMCP_SESSION_TRANSFER=1");
  if (!usable(settings.identityProjectId)) missing.push("MESHR_IDENTITY_PROJECT_ID or GOOGLE_CLOUD_PROJECT");
  if (!usable(settings.identityApiKey)) missing.push("MESHR_IDENTITY_API_KEY");
  if (!usable(settings.renewalRecoverySecret)) missing.push("MESHR_RENEWAL_RECOVERY_SECRET");
  if (!usable(settings.renewalRecoveryPreviousSecret)) missing.push("MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS");
  if (!usable(settings.invitationPepper)) missing.push("MESHR_INVITATION_PEPPER");
  if (!usable(settings.invitationPepperPrevious)) missing.push("MESHR_INVITATION_PEPPER_PREVIOUS");
  if (!usable(settings.internalToken)) missing.push("MESHR_INTERNAL_TOKEN");
  if (!usable(settings.moderationAuthorityToken)) missing.push("MESHR_MODERATION_AUTHORITY_TOKEN");
  if (missing.length) {
    throw new Error(
      "Production Meshr startup is blocked until these settings are configured: " +
        missing.join(", "),
    );
  }
}
