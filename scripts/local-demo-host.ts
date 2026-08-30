import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  LOCAL_DEMO_AGENT_SPECS,
  localDemoPairingSecret,
  signLocalDemoChallenge,
} from "../server/localDemo.ts";

interface DemoSessionRecord {
  token: string;
  sessionId: string;
  expiresAt: string;
  launcherGeneration?: string;
  pageAuthorityBlocked?: boolean;
}
type DemoSessionStore = Record<string, DemoSessionRecord>;

interface PersistedDemoSessionStore {
  version: 1;
  apiOrigin: string;
  sessions: DemoSessionStore;
}

interface ApiResult {
  status: number;
  body: any;
}

export interface LocalDemoHostResult {
  connected: string[];
  reused: string[];
  heartbeats: string[];
  renewed: string[];
  blockedByPageAuthority: string[];
}

function apiOrigin(): string {
  const raw = process.env.MESHR_DEMO_API_URL?.trim() || "http://127.0.0.1:8787";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("MESHR_DEMO_API_URL must be a loopback HTTP origin.");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      "MESHR_DEMO_API_URL must be a loopback HTTP origin (127.0.0.1, localhost, or ::1); refusing to send local credentials elsewhere.",
    );
  }
  return parsed.origin;
}

function sessionFile(): string {
  const configured = process.env.MESHR_DEMO_SESSION_FILE?.trim();
  if (configured) return resolve(configured);
  const databasePath = process.env.MESHR_DB_PATH?.trim();
  if (databasePath && databasePath !== ":memory:") {
    return join(dirname(resolve(databasePath)), "local-demo-sessions.json");
  }
  return resolve(".meshr", "local-demo-sessions.json");
}

function parseSessions(value: unknown): DemoSessionStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([handle, entry]) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      if (
        typeof record.token !== "string" ||
        typeof record.sessionId !== "string" ||
        typeof record.expiresAt !== "string"
      ) {
        return [];
      }
      return [[handle, {
        token: record.token,
        sessionId: record.sessionId,
        expiresAt: record.expiresAt,
        ...(typeof record.launcherGeneration === "string"
          ? { launcherGeneration: record.launcherGeneration }
          : {}),
        ...(record.pageAuthorityBlocked === true ? { pageAuthorityBlocked: true } : {}),
      } satisfies DemoSessionRecord]];
    }),
  );
}

async function loadStore(path: string, origin: string): Promise<DemoSessionStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const file = parsed as Partial<PersistedDemoSessionStore>;
    // Older stores had no origin binding. Discard them instead of risking a
    // bearer token being replayed against a different local service.
    if (file.version !== 1 || file.apiOrigin !== origin) return {};
    return parseSessions(file.sessions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function saveStore(path: string, origin: string, store: DemoSessionStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const persisted: PersistedDemoSessionStore = { version: 1, apiOrigin: origin, sessions: store };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function requestJson(
  path: string,
  options: { method?: string; authorization?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Meshr-Contract-Version": "1",
  };
  if (options.authorization) headers.Authorization = options.authorization;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetch(`${apiOrigin()}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the local Meshr API at ${apiOrigin()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { code: "invalid_api_response", message: text.slice(0, 300) } };
    }
  }
  return { status: response.status, body };
}

function errorMessage(path: string, result: ApiResult): string {
  const error = result.body?.error;
  return `${path} failed (${result.status}): ${typeof error?.message === "string" ? error.message : "unexpected API response"}`;
}

function isPageAuthorityBlock(result: ApiResult): boolean {
  return result.status === 409 && result.body?.error?.code === "page_authority_active";
}

function isRenewalTooEarly(result: ApiResult): boolean {
  return result.status === 429 && result.body?.error?.code === "renewal_too_early";
}

function launcherGeneration(): string {
  return process.env.MESHR_DEMO_LAUNCHER_GENERATION?.trim() || `direct-${process.pid}`;
}

function pageAuthorityBlock(
  store: DemoSessionStore,
  handle: string,
  generation: string,
): void {
  store[handle] = {
    token: "",
    sessionId: "",
    expiresAt: "",
    launcherGeneration: generation,
    pageAuthorityBlocked: true,
  };
}

/**
 * Connect the three local host fixtures through the same signed challenge,
 * renewal, and heartbeat endpoints used by native hosts. The launcher owns
 * the short-lived bearer tokens in an origin-bound permission-0600 file; no
 * token is printed. Page WebMCP authority is never reclaimed by the same
 * launcher generation.
 */
export async function connectLocalDemoSessions(): Promise<LocalDemoHostResult> {
  const origin = apiOrigin();
  const sessionPath = sessionFile();
  const store = await loadStore(sessionPath, origin);
  const now = Date.now();
  const generation = launcherGeneration();
  const result: LocalDemoHostResult = {
    connected: [],
    reused: [],
    heartbeats: [],
    renewed: [],
    blockedByPageAuthority: [],
  };

  for (const spec of LOCAL_DEMO_AGENT_SPECS) {
    let current = store[spec.handle];
    if (current?.pageAuthorityBlocked && current.launcherGeneration === generation) {
      result.blockedByPageAuthority.push(spec.handle);
      continue;
    }
    if (current?.pageAuthorityBlocked) {
      // A new launcher generation is an explicit operator decision to reclaim
      // native authority after a page WebMCP handoff. Never reclaim it from a
      // background heartbeat belonging to the same host generation.
      delete store[spec.handle];
      current = undefined;
    }
    if (current?.token) {
      const expiresAt = Date.parse(current.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt - now <= 120_000) {
        const pairingId = `pair_demo_${spec.handle}`;
        const renewalChallenge = await requestJson(
          `/v1/pairings/${encodeURIComponent(pairingId)}/challenges`,
          {
            method: "POST",
            authorization: `Pairing ${localDemoPairingSecret(spec.handle)}`,
            body: { sessionId: current.sessionId },
          },
        );
        if (isPageAuthorityBlock(renewalChallenge)) {
          pageAuthorityBlock(store, spec.handle, generation);
          result.blockedByPageAuthority.push(spec.handle);
          continue;
        }
        if (![401, 404].includes(renewalChallenge.status) && !isRenewalTooEarly(renewalChallenge)) {
          if (renewalChallenge.status !== 201 || typeof renewalChallenge.body?.message !== "string") {
            throw new Error(errorMessage(`/v1/pairings/${pairingId}/challenges`, renewalChallenge));
          }
          const renewed = await requestJson("/v1/agent-sessions/renew", {
            method: "POST",
            authorization: `Pairing ${localDemoPairingSecret(spec.handle)}`,
            body: {
              pairingId,
              challengeId: renewalChallenge.body.challengeId,
              sessionId: current.sessionId,
              signature: signLocalDemoChallenge(spec.handle, renewalChallenge.body.message),
            },
          });
          if (isPageAuthorityBlock(renewed)) {
            pageAuthorityBlock(store, spec.handle, generation);
            result.blockedByPageAuthority.push(spec.handle);
            continue;
          }
          if (![200, 201].includes(renewed.status)) {
            if (![401, 404].includes(renewed.status)) {
              throw new Error(errorMessage("/v1/agent-sessions/renew", renewed));
            }
            delete store[spec.handle];
            current = undefined;
          } else if (
            typeof renewed.body?.token === "string" &&
            typeof renewed.body?.sessionId === "string" &&
            typeof renewed.body?.expiresAt === "string"
          ) {
            current = store[spec.handle] = {
              token: renewed.body.token,
              sessionId: renewed.body.sessionId,
              expiresAt: renewed.body.expiresAt,
              launcherGeneration: generation,
            };
            result.renewed.push(spec.handle);
            continue;
          } else {
            throw new Error(errorMessage("/v1/agent-sessions/renew", renewed));
          }
        } else if (![401, 404].includes(renewalChallenge.status) && isRenewalTooEarly(renewalChallenge)) {
          // Clock skew or a just-issued session can make the server reject an
          // early renewal. A heartbeat still proves the host is alive.
        } else {
          delete store[spec.handle];
          current = undefined;
        }
      }
      if (current?.token) {
        const heartbeat = await requestJson("/v1/agent-sessions/heartbeat", {
          method: "POST",
          authorization: `Bearer ${current.token}`,
        });
        if (heartbeat.status === 200) {
          delete current.pageAuthorityBlocked;
          current.launcherGeneration = generation;
          result.heartbeats.push(spec.handle);
          result.reused.push(spec.handle);
          continue;
        }
        if (isPageAuthorityBlock(heartbeat)) {
          pageAuthorityBlock(store, spec.handle, generation);
          result.blockedByPageAuthority.push(spec.handle);
          continue;
        }
        if (![401, 404].includes(heartbeat.status)) {
          throw new Error(errorMessage("/v1/agent-sessions/heartbeat", heartbeat));
        }
        delete store[spec.handle];
        current = undefined;
      }
    }

    const pairingId = `pair_demo_${spec.handle}`;
    const pairing = await requestJson(`/v1/pairings/${encodeURIComponent(pairingId)}`, {
      authorization: `Pairing ${localDemoPairingSecret(spec.handle)}`,
    });
    if (pairing.status !== 200) throw new Error(errorMessage(`/v1/pairings/${pairingId}`, pairing));

    const challenge = await requestJson(`/v1/pairings/${encodeURIComponent(pairingId)}/challenges`, {
      method: "POST",
      authorization: `Pairing ${localDemoPairingSecret(spec.handle)}`,
      body: {},
    });
    if (isPageAuthorityBlock(challenge)) {
      pageAuthorityBlock(store, spec.handle, generation);
      result.blockedByPageAuthority.push(spec.handle);
      continue;
    }
    if (challenge.status !== 201 || typeof challenge.body?.message !== "string") {
      throw new Error(errorMessage(`/v1/pairings/${pairingId}/challenges`, challenge));
    }

    const session = await requestJson("/v1/agent-sessions", {
      method: "POST",
      authorization: `Pairing ${localDemoPairingSecret(spec.handle)}`,
      body: {
        pairingId,
        challengeId: challenge.body.challengeId,
        signature: signLocalDemoChallenge(spec.handle, challenge.body.message),
      },
    });
    if (isPageAuthorityBlock(session)) {
      pageAuthorityBlock(store, spec.handle, generation);
      result.blockedByPageAuthority.push(spec.handle);
      continue;
    }
    if (
      session.status !== 201 ||
      typeof session.body?.token !== "string" ||
      typeof session.body?.sessionId !== "string" ||
      typeof session.body?.expiresAt !== "string"
    ) {
      throw new Error(errorMessage("/v1/agent-sessions", session));
    }
    store[spec.handle] = {
      token: session.body.token,
      sessionId: session.body.sessionId,
      expiresAt: session.body.expiresAt,
      launcherGeneration: generation,
    };
    result.connected.push(spec.handle);
  }

  await saveStore(sessionPath, origin, store);
  return result;
}
