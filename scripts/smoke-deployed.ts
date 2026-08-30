import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, resolve } from "node:path";
import { WebSocket } from "ws";
import { MeshrApi, MeshrApiError } from "../connector/api.ts";
import { ConnectorStateStore } from "../connector/state.ts";

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
  if (path.startsWith("/v1/live") && !headers.has("origin")) {
    headers.set("origin", baseOrigin);
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

async function readLiveSnapshot(meshId: string): Promise<Record<string, unknown>> {
  const target = new URL(`${base.replace(/^http/, "ws")}/v1/live`);
  target.searchParams.set("meshId", meshId);
  const cookie = cookieHeader();
  const socket = new WebSocket(target, {
    origin: baseOrigin,
    ...(cookie ? { headers: { cookie } } : {}),
  });
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("live WebSocket snapshot timed out")), 15_000);
    const finish = (error: Error | null, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners("message");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      try { socket.close(1000, "smoke snapshot read"); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(value!);
    };
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString()) as unknown;
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
          finish(new Error("live WebSocket returned an invalid frame"));
          return;
        }
        const record = frame as Record<string, unknown>;
        if (record.type !== "topology.snapshot") return;
        if (record.contract_version !== 1 || record.mesh_id !== meshId ||
            !Number.isSafeInteger(record.cursor) ||
            !record.snapshot || typeof record.snapshot !== "object" || Array.isArray(record.snapshot)) {
          finish(new Error("live WebSocket snapshot failed its contract/cursor checks"));
          return;
        }
        finish(null, record);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.on("close", () => {
      if (!settled) finish(new Error("live WebSocket closed before a topology snapshot"));
    });
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

function objectBody(value: Json, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid JSON object.`);
  }
  return value as Record<string, unknown>;
}

function eventPostId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) return null;
  const data = record.data as Record<string, unknown>;
  // Firestore-backed production events expose the bounded envelope payload
  // directly (post_id). Keep accepting the older projection shape (post.id)
  // so this smoke remains compatible with local/legacy deployments.
  if (typeof data.post_id === "string") return data.post_id;
  if (!data.post || typeof data.post !== "object" || Array.isArray(data.post)) return null;
  const postId = (data.post as Record<string, unknown>).id;
  return typeof postId === "string" ? postId : null;
}

/**
 * Protected-mode smoke uses one already-approved binding from a CI secret to
 * prove the real session-start boundary. Pairing creation alone is not enough:
 * an implementation could block new identities while accidentally allowing a
 * fresh runtime session for an existing binding.
 */
async function assertProtectedSessionStartBlocked(stateFile: string, selectorValue: string): Promise<void> {
  const statePath = resolve(stateFile);
  const store = new ConnectorStateStore(dirname(statePath), { useKeychain: false });
  if (store.path !== statePath) throw new Error("MESHR_E2E_PROTECTED_STATE_FILE must point to a state.json file in a dedicated directory.");
  const state = await store.load();
  const selector = selectorValue.split(",").map((value) => value.trim()).filter(Boolean)[0];
  if (!selector) throw new Error("MESHR_E2E_PROTECTED_BINDING_SELECTOR must identify an approved binding.");
  const candidates = state.bindings.filter((binding) =>
    binding.pairingId === selector || binding.bindingId === selector || binding.requestedProfile.handle === selector,
  );
  if (candidates.length !== 1) throw new Error(`Expected exactly one protected smoke binding for ${selector}; found ${candidates.length}.`);
  const binding = candidates[0]!;
  if (!binding.pairingSecret || !binding.privateKeyPem || !binding.publicKeyPem) {
    throw new Error(`Protected smoke binding ${selector} must include signed pairing credentials in the CI state file.`);
  }
  const api = new MeshrApi(binding.serverUrl);
  if (new URL(api.serverUrl).origin !== baseOrigin) {
    throw new Error(`Protected smoke binding ${selector} points at ${api.serverUrl}, not the deployed origin.`);
  }
  const expectBlocked = (error: unknown, operation: string): void => {
    if (error instanceof MeshrApiError && error.status === 503 && error.code === "cost_protection_active") return;
    throw new Error(`${operation} was not blocked by cost protection: ${error instanceof Error ? error.message : String(error)}`);
  };
  let challenge: Awaited<ReturnType<MeshrApi["createChallenge"]>>;
  try {
    challenge = await api.createChallenge(binding);
  } catch (error) {
    expectBlocked(error, "protected session challenge");
    checks.push("cost-protection session-start block");
    return;
  }
  if (!challenge.challengeId || !challenge.message) throw new Error("Protected smoke session challenge omitted signed challenge fields.");
  const signature = sign(null, Buffer.from(challenge.message, "utf8"), binding.privateKeyPem).toString("base64url");
  try {
    await api.createAgentSession({ binding, challengeId: challenge.challengeId, signature });
  } catch (error) {
    expectBlocked(error, "protected runtime session start");
    checks.push("cost-protection session-start block");
    return;
  }
  throw new Error("Protected mode allowed a new runtime session for an existing binding.");
}

async function eventually<T>(
  label: string,
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | undefined;
  while (Date.now() < deadline) {
    latest = await operation();
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not reach the expected state within ${timeoutMs}ms.`);
}

async function main(): Promise<void> {
  const requireFull = process.env.MESHR_REQUIRE_DEPLOYED_E2E === "1";
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

  // Release acceptance writes only to an isolated private validation mesh.
  // The public commons is for real agents and must never accumulate CI
  // markers or implementation chatter. Local/manual smoke can continue to
  // use the seeded commons when the full deployed gate is not requested.
  const validationMeshId = process.env.MESHR_RELEASE_VALIDATION_MESH_ID?.trim() || "mesh-public";
  const validationTopicId = process.env.MESHR_RELEASE_VALIDATION_TOPIC_ID?.trim();
  if (requireFull && (validationMeshId === "mesh-public" || !validationTopicId)) {
    throw new Error(
      "Full deployed E2E requires MESHR_RELEASE_VALIDATION_MESH_ID (private) and MESHR_RELEASE_VALIDATION_TOPIC_ID; release smoke must not write to mesh-public.",
    );
  }

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
    attention: { browse: "public", rootPosts: "autonomous", replies: "autonomous", notes: "Launch verification only." },
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
    const blockedMesh = await request("/v1/meshes", {
      method: "POST",
      headers: { "x-meshr-csrf": csrfToken },
      body: json({
        name: "Protected-mode smoke mesh",
        description: "Should not be created while cost protection is active.",
      }),
    });
    expectStatus(blockedMesh, 503, "cost-protection mesh creation block");
    if (!blockedMesh.body || typeof blockedMesh.body !== "object" || Array.isArray(blockedMesh.body) ||
        !blockedMesh.body.error || typeof blockedMesh.body.error !== "object" || Array.isArray(blockedMesh.body.error) ||
        blockedMesh.body.error.code !== "cost_protection_active") {
      throw new Error("protected-mode mesh response did not identify cost_protection_active.");
    }
    if (requireFull) {
      const protectedStateFile = process.env.MESHR_E2E_PROTECTED_STATE_FILE?.trim();
      const protectedBindingSelector = process.env.MESHR_E2E_PROTECTED_BINDING_SELECTOR?.trim();
      if (!protectedStateFile || !protectedBindingSelector) {
        throw new Error("Full protected-mode E2E requires MESHR_E2E_PROTECTED_STATE_FILE and MESHR_E2E_PROTECTED_BINDING_SELECTOR.");
      }
      await assertProtectedSessionStartBlocked(protectedStateFile, protectedBindingSelector);
    }
    checks.push("protected-mode read, session, and creation policy");
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
    body: json({ profile, acknowledgeAutonomous: true }),
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

  // Exercise the real native social path before handing authority to the page.
  // This proves mesh/topic authorization, an accepted root and reply, durable
  // readback, and cursor-based event recovery instead of only proving that a
  // session can be paired and immediately fenced.
  const agentAuthorization = { authorization: `Bearer ${agentToken}` };
  const runMarker = `launch-smoke:${Date.now()}:${randomUUID().slice(0, 8)}`;
  let meshes = await request("/v1/agent/meshes", { headers: agentAuthorization });
  expectStatus(meshes, 200, "agent mesh discovery");
  let meshList = objectBody(meshes.body, "agent mesh discovery").meshes;
  if (!Array.isArray(meshList)) throw new Error("agent mesh discovery returned no mesh list.");
  let mesh = meshList.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Record<string, unknown>;
    return record.id === validationMeshId;
  });
  // Private validation meshes are intentionally not discoverable before the
  // agent joins. An open-admission private mesh can still be joined by ID;
  // approval/invite-only meshes must be provisioned with the agent ahead of
  // the release run and are rejected here if the membership is absent.
  if (!mesh && validationMeshId !== "mesh-public") {
    const join = await request(`/v1/agent/meshes/${encodeURIComponent(validationMeshId)}/join`, {
      method: "POST",
      headers: { ...agentAuthorization, "idempotency-key": `${runMarker}:join` },
      body: json({}),
    });
    if (![200, 201].includes(join.status) || objectBody(join.body, "validation mesh join").status !== "joined") {
      throw new Error(`Validation mesh ${validationMeshId} must be an open private mesh already provisioned for release agents.`);
    }
    meshes = await request("/v1/agent/meshes", { headers: agentAuthorization });
    expectStatus(meshes, 200, "validation mesh rediscovery");
    meshList = objectBody(meshes.body, "validation mesh rediscovery").meshes;
    if (!Array.isArray(meshList)) throw new Error("validation mesh rediscovery returned no mesh list.");
    mesh = meshList.find((candidate) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).id === validationMeshId,
    );
  }
  if (mesh && typeof mesh === "object" && !Array.isArray(mesh) &&
      (mesh as Record<string, unknown>).joined !== true) {
    const join = await request(`/v1/agent/meshes/${encodeURIComponent(validationMeshId)}/join`, {
      method: "POST",
      headers: { ...agentAuthorization, "idempotency-key": `${runMarker}:join` },
      body: json({}),
    });
    if (![200, 201].includes(join.status) || objectBody(join.body, "validation mesh join").status !== "joined") {
      throw new Error(`Validation mesh ${validationMeshId} did not admit the release agent.`);
    }
    meshes = await request("/v1/agent/meshes", { headers: agentAuthorization });
    expectStatus(meshes, 200, "validation mesh rediscovery");
    meshList = objectBody(meshes.body, "validation mesh rediscovery").meshes;
    if (!Array.isArray(meshList)) throw new Error("validation mesh rediscovery returned no mesh list.");
    mesh = meshList.find((candidate) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).id === validationMeshId,
    );
  }
  if (!mesh || typeof mesh !== "object" || Array.isArray(mesh)) {
    throw new Error(`agent mesh discovery returned no validation mesh ${validationMeshId}.`);
  }
  const meshRecord = mesh as Record<string, unknown>;
  if (meshRecord.joined !== true) throw new Error(`Validation mesh ${validationMeshId} is not joined by the release agent.`);
  if (requireFull && (meshRecord.visibility !== "private" || meshRecord.joinPolicy !== "open")) {
    throw new Error("The release validation mesh must be private with open admission so each ephemeral smoke agent can join without public writes.");
  }
  const meshId = String(meshRecord.id);
  const topics = await request(`/v1/agent/meshes/${encodeURIComponent(meshId)}/topics`, {
    headers: agentAuthorization,
  });
  expectStatus(topics, 200, "agent topic discovery");
  const topicList = objectBody(topics.body, "agent topic discovery").topics;
  if (!Array.isArray(topicList) || !topicList.length) throw new Error("agent topic discovery returned no topics.");
  const topicCandidate = topicList.find((candidate) =>
    candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
    typeof (candidate as Record<string, unknown>).id === "string" &&
    (!validationTopicId || (candidate as Record<string, unknown>).id === validationTopicId),
  );
  if (!topicCandidate || typeof topicCandidate !== "object" || Array.isArray(topicCandidate)) throw new Error("agent topic discovery returned no usable topic.");
  const topicId = String((topicCandidate as Record<string, unknown>).id);
  if (requireFull && topicId !== validationTopicId) throw new Error("The release validation topic was not found in the private validation mesh.");

  // Capture both the durable activity cursor and the aggregate/live gateway
  // high-water mark before writing. The post check below must advance the
  // opaque cursor returned by the server; repeatedly asking for after=0 is a
  // cursorless newest-page read and can hide gaps under concurrent traffic.
  const eventBaseline = await request("/v1/agent/events?after=0&limit=100", {
    headers: agentAuthorization,
  });
  expectStatus(eventBaseline, 200, "agent event cursor baseline");
  const eventBaselineBody = objectBody(eventBaseline.body, "agent event cursor baseline");
  let eventCursor = typeof eventBaselineBody.nextAfter === "string"
    ? eventBaselineBody.nextAfter
    : null;
  const gatewayBaseline = await request(`/v1/live/snapshots/${encodeURIComponent(meshId)}`);
  expectStatus(gatewayBaseline, 200, "live gateway baseline snapshot");
  const gatewayBaselineBody = objectBody(gatewayBaseline.body, "live gateway baseline snapshot");
  const gatewayBaselineCursor = Number(gatewayBaselineBody.cursor ?? 0);
  const gatewayBaselineSnapshot = gatewayBaselineBody.snapshot && typeof gatewayBaselineBody.snapshot === "object" && !Array.isArray(gatewayBaselineBody.snapshot)
    ? gatewayBaselineBody.snapshot as Record<string, unknown>
    : {};
  const gatewayBaselineCount = Number(gatewayBaselineSnapshot.event_count ?? 0);
  const topologyBaseline = await request(`/v1/activity/public?includeAuthorized=1&meshId=${encodeURIComponent(meshId)}`);
  expectStatus(topologyBaseline, 200, "topology projection baseline");
  const topologyBaselineBody = objectBody(topologyBaseline.body, "topology projection baseline");
  const topologyBaselineMesh = Array.isArray(topologyBaselineBody.meshes)
    ? topologyBaselineBody.meshes.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === meshId)
    : undefined;
  const topologyBaselineMeshRecord = topologyBaselineMesh && typeof topologyBaselineMesh === "object" && !Array.isArray(topologyBaselineMesh)
    ? topologyBaselineMesh as Record<string, unknown>
    : {};
  const topologyBaselineTopic = Array.isArray(topologyBaselineMeshRecord.topics)
    ? topologyBaselineMeshRecord.topics.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === topicId)
    : undefined;
  const topologyBaselineTopicRecord = topologyBaselineTopic && typeof topologyBaselineTopic === "object" && !Array.isArray(topologyBaselineTopic)
    ? topologyBaselineTopic as Record<string, unknown>
    : {};
  const topologyBaselinePostCount = Number(topologyBaselineTopicRecord.postCount ?? topologyBaselineMeshRecord.postCount ?? 0);
  const rootPost = await request("/v1/agent/posts", {
    method: "POST",
    headers: { ...agentAuthorization, "idempotency-key": `${runMarker}:root` },
    body: json({ meshId, topicId, body: `${runMarker} root observation` }),
  });
  expectStatus(rootPost, 201, "agent root post");
  const rootPostBody = objectBody(rootPost.body, "agent root post");
  const rootPostRecord = objectBody(rootPostBody.post as Json, "agent root post");
  const rootPostId = String(rootPostRecord.id ?? "");
  if (!rootPostId) throw new Error("agent root post omitted its ID.");
  const replyPost = await request(`/v1/agent/posts/${encodeURIComponent(rootPostId)}/replies`, {
    method: "POST",
    headers: { ...agentAuthorization, "idempotency-key": `${runMarker}:reply` },
    body: json({ body: `${runMarker} reply observation` }),
  });
  expectStatus(replyPost, 201, "agent reply post");
  const replyPostBody = objectBody(replyPost.body, "agent reply post");
  const replyPostRecord = objectBody(replyPostBody.post as Json, "agent reply post");
  const replyPostId = String(replyPostRecord.id ?? "");
  if (!replyPostId) throw new Error("agent reply post omitted its ID.");
  const postReadback = await request(`/v1/agent/topics/${encodeURIComponent(topicId)}/posts`, {
    headers: agentAuthorization,
  });
  expectStatus(postReadback, 200, "agent post readback");
  const readbackPosts = objectBody(postReadback.body, "agent post readback").posts;
  if (!Array.isArray(readbackPosts) || !readbackPosts.some((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === rootPostId) || !readbackPosts.some((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === replyPostId)) {
    throw new Error("agent post readback did not include both accepted writes.");
  }
  const seenPostEvents = new Set<string>();
  await eventually(
    "agent event cursor recovery",
    async () => {
      const query = eventCursor
        ? `?after=${encodeURIComponent(eventCursor)}&limit=100`
        : "?after=0&limit=100";
      const events = await request(`/v1/agent/events${query}`, { headers: agentAuthorization });
      if (events.status === 200) {
        const body = objectBody(events.body, "agent event cursor recovery");
        const records = Array.isArray(body.events) ? body.events : [];
        for (const candidate of records) {
          if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
          const record = candidate as Record<string, unknown>;
          const postId = eventPostId(record);
          if (postId && (record.type === "post.created" || record.type === "reply.created")) {
            seenPostEvents.add(`${record.type}:${postId}`);
          }
        }
        if (typeof body.nextAfter === "string" && body.nextAfter !== eventCursor) {
          eventCursor = body.nextAfter;
        }
      }
      return events;
    },
    (events) => {
      if (events.status !== 200) return false;
      return seenPostEvents.has(`post.created:${rootPostId}`) && seenPostEvents.has(`reply.created:${replyPostId}`);
    },
  );
  checks.push("agent event cursor recovery");

  const propagatedGateway = await eventually(
    "live gateway topology cursor",
    () => request(`/v1/live/snapshots/${encodeURIComponent(meshId)}?after=${gatewayBaselineCursor}`),
    (result) => {
      if (result.status !== 200) return false;
      const body = objectBody(result.body, "live gateway topology cursor");
      const cursor = Number(body.cursor ?? 0);
      const snapshot = body.snapshot && typeof body.snapshot === "object" && !Array.isArray(body.snapshot)
        ? body.snapshot as Record<string, unknown>
        : {};
      return cursor > gatewayBaselineCursor && Number(snapshot.event_count ?? 0) >= gatewayBaselineCount + 2;
    },
  );
  const propagatedGatewayBody = objectBody(propagatedGateway.body, "live gateway topology cursor");
  const propagatedGatewayCursor = Number(propagatedGatewayBody.cursor ?? 0);
  checks.push("live gateway topology cursor");

  await eventually(
    "topology projection post propagation",
    () => request(`/v1/activity/public?includeAuthorized=1&meshId=${encodeURIComponent(meshId)}`),
    (result) => {
      if (result.status !== 200) return false;
      const body = objectBody(result.body, "topology projection post propagation");
      const meshValue = Array.isArray(body.meshes)
        ? body.meshes.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === meshId)
        : undefined;
      const meshRecord = meshValue && typeof meshValue === "object" && !Array.isArray(meshValue)
        ? meshValue as Record<string, unknown>
        : {};
      const topicValue = Array.isArray(meshRecord.topics)
        ? meshRecord.topics.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === topicId)
        : undefined;
      const topicRecord = topicValue && typeof topicValue === "object" && !Array.isArray(topicValue)
        ? topicValue as Record<string, unknown>
        : {};
      return Number(topicRecord.postCount ?? meshRecord.postCount ?? 0) >= topologyBaselinePostCount + 2;
    },
  );
  checks.push("topology projection post propagation");

  const liveFrame = await readLiveSnapshot(meshId);
  if (Number(liveFrame.cursor) < propagatedGatewayCursor) {
    throw new Error("live WebSocket snapshot cursor lagged the propagated gateway cursor.");
  }
  const liveSnapshot = liveFrame.snapshot as Record<string, unknown>;
  if (Number(liveSnapshot.event_count ?? 0) < gatewayBaselineCount + 2) {
    throw new Error("live WebSocket snapshot did not include both accepted writes.");
  }
  checks.push("live WebSocket snapshot contract and cursor");

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
