import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
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
  blockedUntil?: number;
}
type DemoSessionStore = Record<string, DemoSessionRecord>;

interface ApiResult {
  status: number;
  body: any;
}

export interface LocalDemoHostResult {
  connected: string[];
  reused: string[];
  heartbeats: string[];
  blockedByPageAuthority: string[];
}

function apiUrl(): string {
  return (process.env.MESHR_DEMO_API_URL?.trim() || "http://127.0.0.1:8787").replace(/\/$/, "");
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

async function loadStore(path: string): Promise<DemoSessionStore> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(([handle, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const record = value as Record<string, unknown>;
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
          ...(typeof record.blockedUntil === "number" ? { blockedUntil: record.blockedUntil } : {}),
        } satisfies DemoSessionRecord]];
      }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function saveStore(path: string, store: DemoSessionStore): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function requestJson(
  path: string,
  options: { method?: string; authorization?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.authorization) headers.Authorization = options.authorization;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let response: Response;
  try {
    response = await fetch(`${apiUrl()}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch (error) {
    throw new Error(
      `Could not reach the local Meshr API at ${apiUrl()}: ${error instanceof Error ? error.message : String(error)}`,
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

/**
 * Connect the three local demo identities through the same signed challenge
 * and heartbeat endpoints used by native hosts. The launcher owns the short-
 * lived bearer tokens in a permission-0600 file; no token is printed.
 */
export async function connectLocalDemoSessions(): Promise<LocalDemoHostResult> {
  const sessionPath = sessionFile();
  const store = await loadStore(sessionPath);
  const now = Date.now();
  const result: LocalDemoHostResult = {
    connected: [],
    reused: [],
    heartbeats: [],
    blockedByPageAuthority: [],
  };

  for (const spec of LOCAL_DEMO_AGENT_SPECS) {
    const current = store[spec.handle];
    if (current?.blockedUntil && current.blockedUntil > now) {
      result.blockedByPageAuthority.push(spec.handle);
      continue;
    }
    if (current?.token) {
      const heartbeat = await requestJson("/v1/agent-sessions/heartbeat", {
        method: "POST",
        authorization: `Bearer ${current.token}`,
      });
      if (heartbeat.status === 200) {
        delete current.blockedUntil;
        result.heartbeats.push(spec.handle);
        result.reused.push(spec.handle);
        continue;
      }
      if (![401, 404].includes(heartbeat.status)) {
        throw new Error(errorMessage("/v1/agent-sessions/heartbeat", heartbeat));
      }
      delete store[spec.handle];
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
      store[spec.handle] = {
        token: "",
        sessionId: "",
        expiresAt: "",
        blockedUntil: now + 60_000,
      };
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
      store[spec.handle] = {
        token: "",
        sessionId: "",
        expiresAt: "",
        blockedUntil: now + 60_000,
      };
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
    };
    result.connected.push(spec.handle);
  }

  await saveStore(sessionPath, store);
  return result;
}
