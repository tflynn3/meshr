import { generateKeyPairSync, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const rawBase = process.env.MESHR_DEPLOYED_URL?.trim() || process.env.MESHR_CANARY_URL?.trim();
if (!rawBase) throw new Error("Set MESHR_DEPLOYED_URL (or MESHR_CANARY_URL) to the same-origin deployment under test.");
const base = rawBase.replace(/\/$/, "");
const baseOrigin = new URL(base).origin;
const cookies = new Map<string, string>();
const checks: string[] = [];

function rememberCookies(headers: Headers): void {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);
  for (const value of values) {
    const first = value.split(";", 1)[0] ?? "";
    const separator = first.indexOf("=");
    if (separator > 0) cookies.set(first.slice(0, separator), first.slice(separator + 1));
  }
}

function cookieHeader(): string {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: Json; headers: Headers }> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  // The deployed API deliberately enforces browser-style CSRF checks. Keep
  // this smoke client honest by sending the same same-origin provenance a
  // browser would attach to mutating requests.
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    if (!headers.has("origin")) headers.set("origin", baseOrigin);
    if (!headers.has("referer")) headers.set("referer", `${baseOrigin}/`);
  }
  const cookie = cookieHeader();
  if (cookie) headers.set("cookie", cookie);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, headers, redirect: "manual" });
  } catch (error) {
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  rememberCookies(response.headers);
  const text = await response.text();
  let body: Json = null;
  if (text) {
    try { body = JSON.parse(text) as Json; } catch { body = text; }
  }
  return { status: response.status, body, headers: response.headers };
}

function probeLiveContract(): Promise<number> {
  const target = new URL(`${base}/v1/live?meshId=mesh-public&contractVersion=999`);
  const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = transport({
      hostname: target.hostname,
      port: target.port ? Number(target.port) : undefined,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        origin: baseOrigin,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.setTimeout(15_000, () => request.destroy(new Error("live contract probe timed out")));
    request.once("error", reject);
    request.end();
  });
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Identity Platform ID tokens are intentionally short lived.  CI can keep a
 * refresh token in the protected environment and exchange it immediately
 * before the smoke starts, so a long image rollout cannot consume the token
 * minted during job validation.  A static ID token remains useful for a
 * manually-run local smoke where no refresh credential is available.
 */
async function resolveSocialIdToken(
  staticIdToken: string | undefined,
  refreshToken: string | undefined,
  identityApiKey: string | undefined,
): Promise<string | undefined> {
  if ((refreshToken && !identityApiKey) || (!refreshToken && identityApiKey)) {
    throw new Error("MESHR_E2E_SOCIAL_REFRESH_TOKEN and MESHR_E2E_IDENTITY_API_KEY must be supplied together.");
  }
  if (!refreshToken || !identityApiKey) return staticIdToken;
  let response: Response;
  try {
    response = await fetch(
      `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(identityApiKey)}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch (error) {
    throw new Error(`Identity Platform refresh-token exchange failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const payload = await response.json().catch(() => null) as unknown;
  const nextIdToken = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).id_token
    : undefined;
  if (!response.ok || typeof nextIdToken !== "string" || !nextIdToken) {
    throw new Error(`Identity Platform refresh-token exchange returned HTTP ${response.status}.`);
  }
  return nextIdToken;
}

function expectStatus(result: { status: number }, expected: number, label: string): void {
  if (result.status !== expected) throw new Error(`${label} returned HTTP ${result.status}; expected ${expected}.`);
  checks.push(label);
}

async function main(): Promise<void> {
  const health = await request("/web-healthz");
  expectStatus(health, 200, "web health");
  const publicMeshes = await request("/v1/public/meshes");
  expectStatus(publicMeshes, 200, "public mesh discovery");
  if (!publicMeshes.body || typeof publicMeshes.body !== "object" || Array.isArray(publicMeshes.body) || !Array.isArray(publicMeshes.body.meshes)) {
    throw new Error("public mesh discovery returned an invalid mesh list.");
  }
  const config = await request("/v1/config/auth");
  expectStatus(config, 200, "auth configuration");
  if (!config.body || typeof config.body !== "object" || Array.isArray(config.body) || !Array.isArray(config.body.providers)) {
    throw new Error("auth configuration did not advertise provider metadata.");
  }

  // The live edge must reject incompatible clients with an actionable contract
  // response before any authentication or topology work is attempted.
  const liveContractStatus = await probeLiveContract();
  expectStatus({ status: liveContractStatus }, 426, "live contract guard");

  const provider = process.env.MESHR_E2E_SOCIAL_PROVIDER?.trim();
  const staticIdToken = process.env.MESHR_E2E_SOCIAL_ID_TOKEN?.trim();
  const refreshToken = process.env.MESHR_E2E_SOCIAL_REFRESH_TOKEN?.trim();
  const identityApiKey = process.env.MESHR_E2E_IDENTITY_API_KEY?.trim();
  const idToken = await resolveSocialIdToken(staticIdToken, refreshToken, identityApiKey);
  const email = process.env.MESHR_E2E_EMAIL?.trim();
  const password = process.env.MESHR_E2E_PASSWORD ?? "";
  const requireFull = process.env.MESHR_REQUIRE_DEPLOYED_E2E === "1";
  const costProtectionMode = (process.env.MESHR_COST_PROTECTION_MODE?.trim().toLowerCase() || "normal");
  if (costProtectionMode !== "normal" && costProtectionMode !== "protect" && costProtectionMode !== "throttle") {
    throw new Error("MESHR_COST_PROTECTION_MODE must be normal, protect, or throttle when supplied.");
  }
  if ((!provider || !idToken) && (!email || !password)) {
    if (requireFull) {
      throw new Error("Full deployed E2E requires MESHR_E2E_SOCIAL_PROVIDER plus a static MESHR_E2E_SOCIAL_ID_TOKEN or the refresh-token/API-key pair, or MESHR_E2E_EMAIL + MESHR_E2E_PASSWORD.");
    }
    console.log(JSON.stringify({ ok: true, fullAuth: false, checks, skipped: "authenticated pairing/WebMCP flow (credentials not supplied)" }));
    return;
  }

  let csrfToken = "";
  if (provider && idToken) {
    if (provider !== "google" && provider !== "github") throw new Error("MESHR_E2E_SOCIAL_PROVIDER must be google or github.");
    const state = await request("/v1/auth/state", { method: "POST" });
    expectStatus(state, 201, "social auth state");
    const stateValue = state.body && typeof state.body === "object" && !Array.isArray(state.body)
      ? String(state.body.state ?? "") : "";
    if (!stateValue) throw new Error("social auth state did not return a state value.");
    const session = await request("/v1/sessions/social", {
      method: "POST",
      body: json({ provider, idToken, state: stateValue }),
    });
    expectStatus(session, 201, "social session exchange");
    csrfToken = session.body && typeof session.body === "object" && !Array.isArray(session.body)
      ? String(session.body.csrfToken ?? "") : "";
  } else {
    const session = await request("/v1/sessions", {
      method: "POST",
      body: json({ email, password }),
    });
    expectStatus(session, 200, "email session exchange");
    csrfToken = session.body && typeof session.body === "object" && !Array.isArray(session.body)
      ? String(session.body.csrfToken ?? "") : "";
  }
  if (!csrfToken) throw new Error("session exchange did not return a CSRF token.");
  const me = await request("/v1/me");
  expectStatus(me, 200, "authenticated account read");

  // Reuse one owner-approved identity for repeated release checks so a daily
  // canary does not consume the account's 25-agent launch quota. Set a
  // different handle only when a deployment has a dedicated test account.
  const handle = (process.env.MESHR_E2E_AGENT_HANDLE?.trim() || "launch-smoke").toLowerCase();
  if (handle.length < 2 || !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/.test(handle) || handle.length > 32) {
    throw new Error("MESHR_E2E_AGENT_HANDLE must be a lowercase agent handle (2-32 characters).");
  }
  const profile = {
    name: "Meshr E2E Agent",
    handle,
    tagline: "A disposable launch verification agent.",
    interests: ["verification"],
    personality: "Concise and careful.",
    attention: { browse: "public", rootPosts: "never", replies: "never", notes: "Launch verification only." },
  };
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  if (costProtectionMode !== "normal") {
    // Protection mode deliberately blocks new pairings/session starts while
    // preserving login, reads, owner controls, and moderation. The release
    // smoke must assert that safety behavior instead of trying to create a
    // disposable identity that the server is required to reject.
    const blockedPairing = await request("/v1/pairings", {
      method: "POST",
      body: json({ runtime: "local", label: "protected-mode smoke", externalSubject: `smoke:${handle}`, publicKey, profile }),
    });
    expectStatus(blockedPairing, 503, "cost-protection pairing block");
    if (!blockedPairing.body || typeof blockedPairing.body !== "object" || Array.isArray(blockedPairing.body) ||
        !blockedPairing.body.error || typeof blockedPairing.body.error !== "object" || Array.isArray(blockedPairing.body.error) ||
        blockedPairing.body.error.code !== "cost_protection_active") {
      throw new Error("protected-mode pairing response did not identify cost_protection_active.");
    }
    console.log(JSON.stringify({ ok: true, fullAuth: true, checks, protectedMode: costProtectionMode }));
    return;
  }
  const pairing = await request("/v1/pairings", {
    method: "POST",
    body: json({ runtime: "local", label: "deployed smoke", externalSubject: `smoke:${handle}`, publicKey, profile }),
  });
  expectStatus(pairing, 201, "pairing creation");
  if (!pairing.body || typeof pairing.body !== "object" || Array.isArray(pairing.body)) throw new Error("pairing creation returned no body.");
  const pairingId = String(pairing.body.pairingId ?? "");
  const pairingSecret = String(pairing.body.pairingSecret ?? "");
  if (!pairingId || !pairingSecret) throw new Error("pairing creation omitted its one-time credentials.");

  const approval = await request(`/v1/pairings/${encodeURIComponent(pairingId)}/approve`, {
    method: "POST",
    headers: { "x-meshr-csrf": csrfToken },
    body: json({ profile }),
  });
  expectStatus(approval, 200, "pairing approval");
  const challenge = await request(`/v1/pairings/${encodeURIComponent(pairingId)}/challenges`, {
    method: "POST",
    headers: { authorization: `Pairing ${pairingSecret}` },
  });
  expectStatus(challenge, 201, "session challenge");
  if (!challenge.body || typeof challenge.body !== "object" || Array.isArray(challenge.body)) throw new Error("session challenge returned no body.");
  const challengeId = String(challenge.body.challengeId ?? "");
  const message = String(challenge.body.message ?? "");
  if (!challengeId || !message) throw new Error("session challenge omitted its signed message.");
  const signature = sign(null, Buffer.from(message), keyPair.privateKey).toString("base64url");
  const claimed = await request("/v1/agent-sessions", {
    method: "POST",
    headers: { authorization: `Pairing ${pairingSecret}` },
    body: json({ pairingId, challengeId, signature }),
  });
  expectStatus(claimed, 201, "runtime session claim");
  if (!claimed.body || typeof claimed.body !== "object" || Array.isArray(claimed.body)) throw new Error("runtime session claim returned no body.");
  const agentId = String(claimed.body.agent && typeof claimed.body.agent === "object" ? (claimed.body.agent as Record<string, unknown>).id ?? "" : "");
  const agentToken = String(claimed.body.token ?? "");
  if (!agentId || !agentToken) throw new Error("runtime session claim omitted agent credentials.");

  const page = await request("/v1/webmcp/session", {
    method: "POST",
    headers: { "x-meshr-csrf": csrfToken },
    body: json({ agentId }),
  });
  expectStatus(page, 201, "page WebMCP transfer");
  const pageState = await request("/v1/webmcp/session");
  expectStatus(pageState, 200, "page WebMCP state read");
  if (!pageState.body || typeof pageState.body !== "object" || Array.isArray(pageState.body) || pageState.body.enabled !== true) {
    throw new Error("page WebMCP state did not report an enabled grant.");
  }
  // Exercise a real page-tool endpoint, not only the grant metadata route.
  // This catches a cross-replica hydration regression where the grant exists
  // but the page authority fence was not restored on the receiving replica.
  const pageTool = await request("/v1/webmcp/profile", {
    headers: { "x-meshr-webmcp-agent": agentId },
  });
  expectStatus(pageTool, 200, "page WebMCP profile tool");
  const staleHeartbeat = await request("/v1/agent-sessions/heartbeat", {
    method: "POST",
    headers: { authorization: `Bearer ${agentToken}` },
  });
  expectStatus(staleHeartbeat, 401, "superseded native heartbeat rejection");
  const revoked = await request("/v1/webmcp/session", {
    method: "DELETE",
    headers: { "x-meshr-csrf": csrfToken },
  });
  expectStatus(revoked, 200, "page WebMCP revocation");
  const revokedTool = await request("/v1/webmcp/profile", {
    headers: { "x-meshr-webmcp-agent": agentId },
  });
  expectStatus(revokedTool, 401, "page WebMCP revocation enforcement");
  console.log(JSON.stringify({ ok: true, fullAuth: true, checks, agentId }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
