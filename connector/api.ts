import type {
  AgentSessionResponse,
  ConnectorBinding,
  ConnectorRuntime,
  PairingResponse,
  PairingStatusResponse,
  SafeAgentProfile,
} from "./types";

const MESHR_CONTRACT_MAJOR = "1";

interface RequestOptions {
  method?: string;
  body?: unknown;
  authorization?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export class MeshrApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(
    message: string,
    options: { status: number; code?: string; details?: unknown },
  ) {
    super(message);
    this.name = "MeshrApiError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "::1") return true;
  if (/^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)) return true;
  if (!/^127(?:\.\d{1,3}){3}$/.test(normalized)) return false;
  return normalized.split(".").every((part) => Number(part) <= 255);
}

export function normalizeMeshrServerUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Meshr server URL must use http or https.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Meshr server URL cannot include credentials, a query, or a fragment.",
    );
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      "Meshr bearer transport requires HTTPS or a loopback HTTP address.",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

export class MeshrApi {
  readonly serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = normalizeMeshrServerUrl(serverUrl);
  }

  async health(signal?: AbortSignal): Promise<unknown> {
    return this.request("/healthz", { signal });
  }

  async createPairing(input: {
    runtime: ConnectorRuntime;
    label: string;
    externalSubject: string;
    publicKey: string;
    profile: SafeAgentProfile;
    definitionDigest: string;
  }): Promise<PairingResponse> {
    return this.request("/v1/pairings", { method: "POST", body: input });
  }

  async pairingStatus(binding: ConnectorBinding): Promise<PairingStatusResponse> {
    return this.request(`/v1/pairings/${encodeURIComponent(binding.pairingId)}`, {
      authorization: `Pairing ${binding.pairingSecret}`,
    });
  }

  async createChallenge(
    binding: ConnectorBinding,
    sessionId?: string,
  ): Promise<{
    challengeId: string;
    challenge?: string;
    message: string;
    expiresAt: string;
  }> {
    return this.request(
      `/v1/pairings/${encodeURIComponent(binding.pairingId)}/challenges`,
      {
        method: "POST",
        authorization: `Pairing ${binding.pairingSecret}`,
        ...(sessionId ? { body: { sessionId } } : {}),
      },
    );
  }

  async createAgentSession(input: {
    binding: ConnectorBinding;
    challengeId: string;
    signature: string;
  }): Promise<AgentSessionResponse> {
    return this.request("/v1/agent-sessions", {
      method: "POST",
      authorization: `Pairing ${input.binding.pairingSecret}`,
      body: {
        pairingId: input.binding.pairingId,
        challengeId: input.challengeId,
        signature: input.signature,
      },
    });
  }

  async renewAgentSession(input: {
    binding: ConnectorBinding;
    challengeId: string;
    sessionId: string;
    signature: string;
  }): Promise<AgentSessionResponse> {
    return this.request("/v1/agent-sessions/renew", {
      method: "POST",
      authorization: `Pairing ${input.binding.pairingSecret}`,
      body: {
        pairingId: input.binding.pairingId,
        challengeId: input.challengeId,
        sessionId: input.sessionId,
        signature: input.signature,
      },
    });
  }

  async heartbeatAgentSession(binding: ConnectorBinding): Promise<unknown> {
    return this.agentRequest(binding, "/v1/agent-sessions/heartbeat", {
      method: "POST",
    });
  }

  async agentRequest<T = unknown>(
    binding: ConnectorBinding,
    path: string,
    options: Omit<RequestOptions, "authorization"> = {},
  ): Promise<T> {
    if (!binding.agentToken) {
      throw new Error(`Binding ${binding.requestedProfile.handle} is not connected.`);
    }
    return this.request(path, {
      ...options,
      authorization: `Bearer ${binding.agentToken}`,
    });
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers = new Headers({ accept: "application/json" });
    headers.set("x-meshr-contract-version", MESHR_CONTRACT_MAJOR);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.authorization) headers.set("authorization", options.authorization);
    if (options.idempotencyKey) headers.set("idempotency-key", options.idempotencyKey);
    const response = await fetch(`${this.serverUrl}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
    const text = await response.text();
    let value: unknown = null;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        value = { message: text };
      }
    }
    if (!response.ok) {
      const payload = value as {
        error?: string | { code?: string; message?: string };
        message?: string;
        code?: string;
      } | null;
      const nested =
        payload?.error && typeof payload.error === "object"
          ? payload.error
          : undefined;
      throw new MeshrApiError(
        payload?.message ??
          nested?.message ??
          (typeof payload?.error === "string" ? payload.error : undefined) ??
          `Meshr request failed (${response.status}).`,
        {
          status: response.status,
          code: payload?.code ?? nested?.code,
          details: value,
        },
      );
    }
    return value as T;
  }
}
