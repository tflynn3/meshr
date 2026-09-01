export type ModerationReadinessAuth = "none" | "static" | "adc";
export type ModerationTokenType = "access_token" | "id_token";

export interface ModerationReadinessOptions {
  endpoint?: string;
  healthcheckUrl?: string;
  auth: ModerationReadinessAuth;
  token?: string;
  tokenType?: ModerationTokenType;
  audience?: string;
  revisionTag?: string;
  releaseSha?: string;
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
  "endpoint" | "healthcheckUrl" | "auth" | "token" | "tokenType" | "audience" | "revisionTag" |
  "releaseSha" | "required" | "environment">): string | undefined {
  if (!options.required) return undefined;
  const environment = trim(options.environment)?.toLowerCase() ?? "local";
  if (!["local", "development", "test", "production"].includes(environment)) {
    return "moderation_environment_invalid";
  }
  const production = environment === "production";
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
  if (production && options.auth !== "adc") return "moderation_production_auth_invalid";
  if (production && trim(options.token)) return "moderation_production_token_invalid";
  if (production && (options.tokenType ?? "access_token") !== "id_token") {
    return "moderation_id_token_required";
  }
  if (options.auth === "adc" && (options.tokenType ?? "access_token") === "id_token" && !trim(options.audience)) {
    return "moderation_audience_missing";
  }
  if (options.auth === "adc" && (options.tokenType ?? "access_token") === "id_token" && trim(options.audience)) {
    try {
      const audienceValue = trim(options.audience)!;
      const audience = new URL(audienceValue);
      if (production) {
        const revisionTag = trim(options.revisionTag);
        const releaseSha = trim(options.releaseSha);
        if (!revisionTag) return "moderation_revision_tag_missing";
        if (!releaseSha) return "moderation_release_sha_missing";
        if (!/^[a-f0-9]{40}$/.test(releaseSha)) return "moderation_release_sha_invalid";
        if (audience.protocol !== "https:" || audience.port !== "" || audienceValue !== audience.origin ||
            audience.hostname.includes("---") ||
            !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.run\.app$/.test(audience.hostname)) {
          return "moderation_audience_invalid";
        }
        const stableServiceLabel = audience.hostname.split(".")[0]!;
        const revisionPrefixLength = /^meshr-moderation-adapter-canary-[0-9]+$/.test(stableServiceLabel)
          ? 14
          : /^meshr-moderation-adapter-[0-9]+$/.test(stableServiceLabel)
            ? 20
            : undefined;
        if (!revisionPrefixLength) return "moderation_audience_invalid";
        if (revisionTag !== `r-${releaseSha.slice(0, revisionPrefixLength)}`) {
          return "moderation_revision_tag_mismatch";
        }
        if (revisionTag.length + 3 + stableServiceLabel.length > 63) {
          return "moderation_revision_url_too_long";
        }
        const taggedOrigin = `https://${revisionTag}---${audience.hostname}`;
        if (trim(options.endpoint) !== `${taggedOrigin}/screen` ||
            trim(options.healthcheckUrl) !== `${taggedOrigin}/healthz`) {
          return "moderation_revision_url_mismatch";
        }
      } else if (audience.origin !== endpoint.origin) {
        return "moderation_audience_origin_mismatch";
      }
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
    revisionTag: options.revisionTag,
    releaseSha: options.releaseSha,
    required: options.required,
    environment: options.environment,
  });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const requireReleaseAttestation = trim(options.environment)?.toLowerCase() === "production" &&
    options.auth === "adc" && (options.tokenType ?? "access_token") === "id_token";
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
        let result: ModerationReadinessResult;
        if (!response.ok) {
          result = failure("moderation_provider_unreachable");
        } else if (requireReleaseAttestation) {
          const body = await response.text();
          let payload: unknown;
          try {
            payload = body.length <= 4_096 ? JSON.parse(body) : undefined;
          } catch {
            payload = undefined;
          }
          const expectedReleaseSha = trim(options.releaseSha);
          if (response.headers.get("x-meshr-contract-version") !== "1" || !payload ||
              typeof payload !== "object" || Array.isArray(payload) ||
              (payload as Record<string, unknown>).ok !== true ||
              (payload as Record<string, unknown>).service !== "meshr-moderation-adapter" ||
              (payload as Record<string, unknown>).releaseSha !== expectedReleaseSha) {
            result = failure("moderation_provider_unreachable");
          } else {
            result = { ok: true };
          }
        } else {
          result = { ok: true };
        }
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
