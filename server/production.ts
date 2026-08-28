export interface ProductionSettings {
  environment: "local" | "production";
  storage: "sqlite" | "firestore";
  socialAuthOnly: boolean;
  secureCookies: boolean;
  webMcpTransfersSession: boolean;
  identityProjectId?: string;
  identityApiKey?: string;
  renewalRecoverySecret?: string;
  eventIngestUrl?: string;
  internalToken?: string;
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
  return {
    environment: normalizedEnvironment,
    storage,
    socialAuthOnly,
    secureCookies,
    webMcpTransfersSession,
    identityProjectId,
    identityApiKey,
    renewalRecoverySecret,
    eventIngestUrl: process.env.MESHR_EVENT_INGEST_URL?.trim(),
    internalToken: process.env.MESHR_INTERNAL_TOKEN?.trim(),
  };
}

export function assertProductionSettings(settings: ProductionSettings): void {
  const costProtectionMode = process.env.MESHR_COST_PROTECTION_MODE?.trim().toLowerCase();
  if (costProtectionMode && !["normal", "protect", "throttle"].includes(costProtectionMode)) {
    throw new Error("MESHR_COST_PROTECTION_MODE must be normal, protect, or throttle.");
  }
  if (settings.environment !== "production") return;
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
  if (!usable(settings.eventIngestUrl)) missing.push("MESHR_EVENT_INGEST_URL");
  if (!usable(settings.internalToken)) missing.push("MESHR_INTERNAL_TOKEN");
  if (missing.length) {
    throw new Error(
      "Production Meshr startup is blocked until these settings are configured: " +
        missing.join(", "),
    );
  }
}
