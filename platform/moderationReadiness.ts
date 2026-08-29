export type ModerationReadinessAuth = "none" | "static" | "adc";
export type ModerationTokenType = "access_token" | "id_token";

export interface ModerationReadinessOptions {
  endpoint?: string;
  healthcheckUrl?: string;
  auth: ModerationReadinessAuth;
  token?: string;
  tokenType?: ModerationTokenType;
  audience?: string;
  required: boolean;
  environment?: string;
  authorization: () => Promise<string | undefined>;
  fetchImpl?: typeof globalThis.fetch;
  cacheMs?: number;
}

export interface ModerationReadinessResult {
  ok: boolean;
  error?:
    | "moderation_provider_unconfigured"
    | "moderation_provider_auth_unavailable"
    | "moderation_provider_unreachable";
}

function trim(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function validateHttpsUrl(name: string, value: string | undefined, production: boolean): string | undefined {
  if (!value) return `${name}_missing`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${name}_invalid`;
  }
  if (parsed.username || parsed.password || parsed.hash) return `${name}_invalid`;
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && !production)) {
    return `${name}_must_use_https`;
  }
  return undefined;
}

/**
 * Validate the mandatory production adapter contract without making a network
 * request. The health URL is separate from the screening POST endpoint so a
 * readiness probe can never create or mutate moderation work.
 */
export function moderationReadinessConfigError(options: Pick<ModerationReadinessOptions,
  "endpoint" | "healthcheckUrl" | "auth" | "token" | "tokenType" | "audience" | "required" | "environment">): string | undefined {
  if (!options.required) return undefined;
  const production = options.environment === "production";
  const endpointError = validateHttpsUrl("moderation_endpoint", trim(options.endpoint), production);
  if (endpointError) return endpointError;
  const healthcheckError = validateHttpsUrl("moderation_healthcheck_url", trim(options.healthcheckUrl), production);
  if (healthcheckError) return healthcheckError;
  let endpoint: URL;
  let healthcheck: URL;
  try {
    endpoint = new URL(trim(options.endpoint)!);
    healthcheck = new URL(trim(options.healthcheckUrl)!);
  } catch {
    return "moderation_endpoint_invalid";
  }
  if (endpoint.origin !== healthcheck.origin) return "moderation_urls_origin_mismatch";
  if (options.auth !== "static" && options.auth !== "adc") return "moderation_auth_required";
  if (options.auth === "static" && !trim(options.token)) return "moderation_token_missing";
  if (options.auth === "adc" && (options.tokenType ?? "access_token") === "id_token" && !trim(options.audience)) {
    return "moderation_audience_missing";
  }
  if (production && options.auth === "adc" && (options.tokenType ?? "access_token") === "access_token" &&
      !endpoint.hostname.endsWith(".googleapis.com") && endpoint.hostname !== "googleapis.com") {
    return "moderation_access_token_endpoint_not_allowed";
  }
  if (options.auth === "adc" && (options.tokenType ?? "access_token") === "id_token" && trim(options.audience)) {
    try {
      const audience = new URL(trim(options.audience)!);
      if (audience.origin !== endpoint.origin) return "moderation_audience_origin_mismatch";
    } catch {
      return "moderation_audience_invalid";
    }
  }
  return undefined;
}

function failure(error: ModerationReadinessResult["error"]): ModerationReadinessResult {
  return { ok: false, error };
}

/**
 * Build a bounded, cached provider probe for the moderation worker readiness
 * endpoint. Credentials are supplied by the worker's existing short-lived
 * authorization callback and are never included in a result or log value.
 */
export function createModerationReadinessProbe(options: ModerationReadinessOptions): {
  configError?: string;
  check: () => Promise<ModerationReadinessResult>;
} {
  const endpoint = trim(options.endpoint);
  const healthcheckUrl = trim(options.healthcheckUrl);
  const configError = moderationReadinessConfigError({
    endpoint,
    healthcheckUrl,
    auth: options.auth,
    token: options.token,
    tokenType: options.tokenType,
    audience: options.audience,
    required: options.required,
    environment: options.environment,
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cacheMs = Math.max(1_000, Math.min(60_000, Math.trunc(options.cacheMs ?? 5_000)));
  let cached: { result: ModerationReadinessResult; expiresAt: number } | undefined;
  let inFlight: Promise<ModerationReadinessResult> | undefined;

  async function check(): Promise<ModerationReadinessResult> {
    if (!options.required) return { ok: true };
    if (configError) return failure("moderation_provider_unconfigured");
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.result;
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<ModerationReadinessResult> => {
      try {
        const token = await options.authorization();
        if (!token) {
          const result = failure("moderation_provider_auth_unavailable");
          cached = { result, expiresAt: Date.now() + Math.min(cacheMs, 2_000) };
          return result;
        }
        const headers = new Headers({
          accept: "application/json",
          "x-meshr-contract-version": "1",
        });
        headers.set("authorization", `Bearer ${token}`);
        const response = await fetchImpl(healthcheckUrl!, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(2_000),
        });
        const result = response.ok
          ? { ok: true }
          : failure("moderation_provider_unreachable");
        cached = { result, expiresAt: Date.now() + (result.ok ? cacheMs : Math.min(cacheMs, 2_000)) };
        return result;
      } catch {
        const result = failure("moderation_provider_unreachable");
        cached = { result, expiresAt: Date.now() + Math.min(cacheMs, 2_000) };
        return result;
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  }

  return { configError, check };
}
