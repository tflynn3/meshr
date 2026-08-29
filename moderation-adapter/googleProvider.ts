import type {
  ModerationDecision,
  ModerationProvider,
  ModerationScreenRequest,
} from "./types.ts";

const DLP_INFO_TYPES = [
  "CREDIT_CARD_NUMBER",
  "US_SOCIAL_SECURITY_NUMBER",
  "US_INDIVIDUAL_TAXPAYER_IDENTIFICATION_NUMBER",
  "JSON_WEB_TOKEN",
  "AUTH_TOKEN",
] as const;

const HIGH_LIKELIHOODS = new Set(["LIKELY", "VERY_LIKELY"]);

export interface GoogleModerationProviderOptions {
  projectId: string;
  modelArmorEndpoint: string;
  modelArmorTemplate: string;
  dlpEndpoint: string;
  dlpParent: string;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
  accessToken?: () => Promise<string>;
}

function errorForProvider(status: number, service: string): Error {
  return new Error(`${service}_provider_http_${status}`);
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function modelArmorUrl(options: GoogleModerationProviderOptions): string {
  return `${options.modelArmorEndpoint.replace(/\/+$/, "")}/v1/${options.modelArmorTemplate}:sanitizeUserPrompt`;
}

function dlpInspectUrl(options: GoogleModerationProviderOptions): string {
  return `${options.dlpEndpoint.replace(/\/+$/, "")}/v2/${options.dlpParent}/content:inspect`;
}

function requireModelArmorResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model_armor_response_invalid");
  }
  const result = value as Record<string, unknown>;
  const invocationResult = trim(result.invocationResult);
  const filterMatchState = trim(result.filterMatchState);
  // A successful HTTP response is not sufficient: Model Armor can report a
  // partial/failed invocation, or omit its filter state, while still returning
  // status 200. Unknown states fail closed so a provider contract change
  // cannot silently become an allow decision.
  if (invocationResult !== "SUCCESS") throw new Error("model_armor_invocation_failed");
  if (filterMatchState !== "NO_MATCH_FOUND" && filterMatchState !== "MATCH_FOUND") {
    throw new Error("model_armor_response_invalid");
  }
  return result;
}

function requireDlpResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("dlp_response_invalid");
  }
  return value as Record<string, unknown>;
}

function hasModelArmorMatch(result: Record<string, unknown>): boolean {
  if (trim(result.filterMatchState) === "MATCH_FOUND") return true;
  const filters = Array.isArray(result.filterResults) ? result.filterResults : [];
  return filters.some((entry) => JSON.stringify(entry).includes("MATCH_FOUND"));
}

function hasDlpHighLikelihood(result: Record<string, unknown>): boolean {
  const findings = Array.isArray(result.findings) ? result.findings : [];
  return findings.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const finding = entry as Record<string, unknown>;
    return HIGH_LIKELIHOODS.has(trim(finding.likelihood));
  });
}

async function metadataAccessToken(fetchImpl: typeof fetch): Promise<string> {
  const configured = process.env.MESHR_ADAPTER_ACCESS_TOKEN?.trim();
  if (configured && process.env.MESHR_ENV?.trim() !== "production") return configured;
  const host = process.env.GOOGLE_METADATA_HOST?.trim() || "metadata.google.internal";
  const response = await fetchImpl(
    `http://${host}/computeMetadata/v1/instance/service-accounts/default/token`,
    {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2_000),
    },
  );
  if (!response.ok) throw errorForProvider(response.status, "metadata");
  const payload = await response.json() as { access_token?: unknown };
  const token = trim(payload.access_token);
  if (!token) throw new Error("metadata_provider_token_missing");
  return token;
}

export class GoogleModerationProvider implements ModerationProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private cachedToken: { token: string; expiresAt: number } | undefined;

  constructor(private readonly options: GoogleModerationProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = Math.max(500, Math.min(15_000, Math.trunc(options.timeoutMs ?? 5_000)));
  }

  private async token(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) return this.cachedToken.token;
    const token = this.options.accessToken
      ? await this.options.accessToken()
      : await metadataAccessToken(this.fetchImpl);
    this.cachedToken = { token, expiresAt: now + 5 * 60_000 };
    return token;
  }

  private async request(url: string, init: RequestInit): Promise<any> {
    const token = await this.token();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    const response = await this.fetchImpl(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw errorForProvider(response.status, "moderation");
    return response.status === 204 ? {} : await response.json();
  }

  async health(): Promise<void> {
    // Exercise the exact provider operations used for screening. This avoids
    // readiness-only permissions (template GET or stored-info-type listing)
    // that do not prove the service account can actually screen content.
    await this.screen({
      postId: "healthcheck",
      meshId: null,
      agentId: null,
      text: "meshr moderation adapter healthcheck",
    });
  }

  async screen(input: ModerationScreenRequest): Promise<ModerationDecision> {
    const [armor, dlp] = await Promise.all([
      this.request(modelArmorUrl(this.options), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userPromptData: { text: input.text },
        }),
      }),
      this.request(dlpInspectUrl(this.options), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inspectConfig: {
            infoTypes: DLP_INFO_TYPES.map((name) => ({ name })),
            minLikelihood: "LIKELY",
            limits: { maxFindingsPerRequest: 10 },
            includeQuote: false,
          },
          item: { value: input.text },
        }),
      }),
    ]);
    const armorResult = requireModelArmorResult(armor?.sanitizationResult);
    const dlpResult = requireDlpResult(dlp?.result);
    if (hasModelArmorMatch(armorResult)) {
      return {
        action: "quarantine",
        reason: "model_armor_filter_match",
        severity: "high",
      };
    }
    if (hasDlpHighLikelihood(dlpResult)) {
      return {
        action: "quarantine",
        reason: "sensitive_data_finding",
        severity: "high",
      };
    }
    return { action: "allow", reason: "provider_checks_passed", severity: "low" };
  }
}
