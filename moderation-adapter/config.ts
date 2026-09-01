import type { ModerationAdapterOptions } from "./types.ts";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

export interface ModerationAdapterConfig {
  environment: "local" | "production";
  port: number;
  projectId: string;
  modelArmorTemplate: string;
  modelArmorEndpoint: string;
  dlpParent: string;
  dlpEndpoint: string;
  releaseSha?: string;
  timeoutMs: number;
  maxBodyBytes: number;
  requireCallerAuth: boolean;
}

export interface ModerationAdapterConfigResult {
  config?: ModerationAdapterConfig;
  error?: string;
}

function required(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function httpsBase(name: string, value: string, production: boolean): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${name}_invalid`;
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && !production)) {
    return `${name}_must_use_https`;
  }
  if (parsed.username || parsed.password || parsed.hash || parsed.search) {
    return `${name}_invalid`;
  }
  return undefined;
}

function templateParts(resource: string): { projectId: string; location: string } | undefined {
  const match = /^projects\/([A-Za-z0-9][A-Za-z0-9-_.:]{0,99})\/locations\/([A-Za-z0-9][A-Za-z0-9-_.-]{0,62})\/templates\/[A-Za-z0-9][A-Za-z0-9-_.-]{0,99}$/.exec(resource);
  return match ? { projectId: match[1]!, location: match[2]! } : undefined;
}

function dlpParent(projectId: string, location: string): string {
  return `projects/${projectId}/locations/${location}`;
}

function modelArmorEndpoint(location: string, override: string | undefined): string {
  if (override) return override.replace(/\/+$/, "");
  return location === "global"
    ? "https://modelarmor.googleapis.com"
    : `https://modelarmor.${location}.rep.googleapis.com`;
}

function dlpEndpoint(location: string, override: string | undefined): string {
  if (override) return override.replace(/\/+$/, "");
  return location === "global"
    ? "https://dlp.googleapis.com"
    : `https://dlp.${location}.rep.googleapis.com`;
}

/**
 * Parse the adapter's launch configuration without contacting Google APIs.
 * Production requires a real Model Armor template and a regional DLP parent;
 * the local fake provider is intentionally selected by the caller instead of
 * being an implicit fallback in a production image.
 */
export function loadModerationAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): ModerationAdapterConfigResult {
  const environmentValue = env.MESHR_ENV?.trim().toLowerCase() || "local";
  if (environmentValue !== "local" && environmentValue !== "production") {
    return { error: "environment_invalid" };
  }
  const environment = environmentValue;
  const projectId = required(env.GOOGLE_CLOUD_PROJECT || env.MESHR_MODERATION_PROJECT_ID);
  const template = required(env.MESHR_MODEL_ARMOR_TEMPLATE);
  const parsedTemplate = template ? templateParts(template) : undefined;
  if (!projectId) return { error: "project_id_missing" };
  if (!template || !parsedTemplate) return { error: "model_armor_template_invalid" };
  if (parsedTemplate.projectId !== projectId) return { error: "model_armor_template_project_mismatch" };
  const armorEndpoint = modelArmorEndpoint(
    parsedTemplate.location!,
    required(env.MESHR_MODEL_ARMOR_ENDPOINT),
  );
  const dlpLocation = required(env.MESHR_DLP_LOCATION) || "global";
  if (environment === "production" && dlpLocation === "global") {
    return { error: "dlp_location_must_be_regional" };
  }
  const parent = dlpParent(projectId, dlpLocation);
  const dlpApiEndpoint = dlpEndpoint(
    dlpLocation,
    required(env.MESHR_DLP_ENDPOINT),
  );
  const armorError = httpsBase("model_armor_endpoint", armorEndpoint, environment === "production");
  if (armorError) return { error: armorError };
  if (environment === "production" && required(env.MESHR_MODEL_ARMOR_ENDPOINT)) {
    const expectedHost = parsedTemplate.location === "global"
      ? "modelarmor.googleapis.com"
      : `modelarmor.${parsedTemplate.location}.rep.googleapis.com`;
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(armorEndpoint);
    } catch {
      return { error: "model_armor_endpoint_invalid" };
    }
    if (parsedEndpoint.hostname.toLowerCase() !== expectedHost.toLowerCase()) {
      return { error: "model_armor_endpoint_host_invalid" };
    }
  }
  const dlpError = httpsBase("dlp_endpoint", dlpApiEndpoint, environment === "production");
  if (dlpError) return { error: dlpError };
  if (environment === "production") {
    const expectedDlpEndpoint = dlpEndpoint(dlpLocation, undefined);
    if (dlpApiEndpoint.toLowerCase() !== expectedDlpEndpoint.toLowerCase()) {
      return { error: "dlp_endpoint_host_invalid" };
    }
  }
  const releaseSha = required(env.MESHR_MODERATION_RELEASE_SHA);
  if (environment === "production" && !releaseSha) {
    return { error: "release_sha_missing" };
  }
  if (releaseSha && !/^[a-f0-9]{40}$/.test(releaseSha)) {
    return { error: "release_sha_invalid" };
  }
  const timeoutMs = positiveInteger(env.MESHR_MODERATION_ADAPTER_TIMEOUT_MS, 5_000);
  const maxBodyBytes = positiveInteger(env.MESHR_MODERATION_ADAPTER_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);
  const requireCallerAuth = environment === "production" || env.MESHR_ADAPTER_REQUIRE_CALLER_AUTH === "1";
  return {
    config: {
      environment,
      port: positiveInteger(env.PORT || env.MESHR_PORT, 8080),
      projectId,
      modelArmorTemplate: template,
      modelArmorEndpoint: armorEndpoint,
      dlpParent: parent,
      dlpEndpoint: dlpApiEndpoint,
      releaseSha,
      timeoutMs,
      maxBodyBytes,
      requireCallerAuth,
    },
  };
}

export function adapterOptionsFromConfig(
  config: ModerationAdapterConfig,
  provider: ModerationAdapterOptions["provider"],
): ModerationAdapterOptions {
  return {
    provider,
    environment: config.environment,
    releaseSha: config.releaseSha,
    requireCallerAuth: config.requireCallerAuth,
    maxBodyBytes: config.maxBodyBytes,
  };
}
