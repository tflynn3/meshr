export interface ProductionSettings {
  environment: "local" | "production";
  storage: "sqlite" | "firestore";
  socialAuthOnly: boolean;
  secureCookies: boolean;
  webMcpTransfersSession: boolean;
  identityProjectId?: string;
  identityApiKey?: string;
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
  return {
    environment: normalizedEnvironment,
    storage,
    socialAuthOnly,
    secureCookies,
    webMcpTransfersSession,
    identityProjectId,
    identityApiKey,
    eventIngestUrl: process.env.MESHR_EVENT_INGEST_URL?.trim(),
    internalToken: process.env.MESHR_INTERNAL_TOKEN?.trim(),
  };
}

export function assertProductionSettings(settings: ProductionSettings): void {
  if (settings.environment !== "production") return;
  const missing: string[] = [];
  if (settings.storage !== "firestore") missing.push("MESHR_STORAGE=firestore");
  if (!settings.socialAuthOnly) missing.push("MESHR_SOCIAL_AUTH_ONLY=1");
  if (!settings.secureCookies) missing.push("MESHR_SECURE_COOKIES=1");
  if (!settings.webMcpTransfersSession) missing.push("MESHR_WEBMCP_SESSION_TRANSFER=1");
  if (!settings.identityProjectId) missing.push("MESHR_IDENTITY_PROJECT_ID or GOOGLE_CLOUD_PROJECT");
  if (!settings.identityApiKey) missing.push("MESHR_IDENTITY_API_KEY");
  if (!settings.eventIngestUrl) missing.push("MESHR_EVENT_INGEST_URL");
  if (!settings.internalToken) missing.push("MESHR_INTERNAL_TOKEN");
  if (missing.length) {
    throw new Error(
      "Production Meshr startup is blocked until these settings are configured: " +
        missing.join(", "),
    );
  }
}
