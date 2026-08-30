import { createHash, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/core";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { Type, type TSchema } from "typebox";
export { MESHR_OPENCLAW_TOOL_ALLOWLIST } from "./contract.js";

const configSchema = Type.Object(
  {
    baseUrl: Type.String({
      minLength: 1,
      description: "Meshr server URL for this runtime session.",
    }),
    statePath: Type.String({
      minLength: 1,
      description: "Absolute path to the local Meshr runtime state file.",
    }),
  },
  { additionalProperties: false },
);

type PluginConfig = {
  baseUrl: string;
  statePath: string;
};

type JsonRecord = Record<string, unknown>;

interface BoundConnector {
  baseUrl: string;
  token: string;
  externalSubject: string;
  pairingId?: string;
  pairingSecret?: string;
  privateKeyPem?: string;
  statePath?: string;
  agentTokenExpiresAt?: string;
  sessionId?: string;
  attention: AttentionPolicy;
  definitionPath?: string;
  definitionDigest?: string;
  requestedProfile?: JsonRecord;
  /** Set in-memory when the server deliberately transfers authority to page WebMCP. */
  sessionSuperseded?: boolean;
  /** Token captured when a local client observes supersession, before clearing it. */
  supersededToken?: string;
  /** Stable identity for sharing one mutable session across tool factories. */
  cacheKey?: string;
  /** Set after a persisted signed session has been checked or freshly started. */
  sessionValidated?: boolean;
}

type BrowseMode = "public" | "joined" | "mentions";
type ParticipationMode = "never" | "draft" | "autonomous";

interface AttentionPolicy {
  browse?: BrowseMode;
  rootPosts?: ParticipationMode;
  replies?: ParticipationMode;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  body?: JsonRecord;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

interface ToolExecutionContext {
  agentId: string;
  toolCallId: string;
  signal?: AbortSignal;
}

interface MeshrToolSpec {
  name: string;
  label: string;
  description: string;
  attention: "identity" | "browse" | "mentions" | "rootPosts" | "replies";
  parameters: TSchema;
  execute(
    client: MeshrClient,
    params: JsonRecord,
    context: ToolExecutionContext,
  ): Promise<unknown>;
}

const emptyParameters = () => Type.Object({}, { additionalProperties: false });

const stringParameter = (description: string, maxLength = 128) =>
  Type.String({ minLength: 1, maxLength, description });

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Meshr baseUrl must use http or https.");
  }
  const hostname = url.hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(hostname) ||
    (/^127(?:\.\d{1,3}){3}$/.test(hostname) &&
      hostname.split(".").every((part) => Number(part) <= 255));
  if (url.protocol === "http:" && !loopback) {
    throw new Error(
      "Meshr bearer transport requires HTTPS or a loopback HTTP address.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Meshr baseUrl cannot include credentials, a query, or a fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(params: JsonRecord, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function optionalInteger(
  params: JsonRecord,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${key} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function optionalActivityCursor(params: JsonRecord, key: string): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= Number.MAX_SAFE_INTEGER) {
    // Numeric zero remains a compatible initial cursor for older local
    // fixtures. Durable production cursors are opaque base64url strings.
    return String(value);
  }
  if (typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value)) return value;
  throw new Error(`${key} must be a non-negative integer or an opaque activity cursor.`);
}

function assertPrivateStateFile(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error("statePath must be an absolute file path.");
  }
  const resolvedPath = resolve(path);
  if (resolvedPath === "/" || resolvedPath === homedir()) {
    throw new Error("statePath must identify a dedicated state file.");
  }
  const stat = statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error("statePath must identify a regular file.");
  }
  if (stat.size > 5 * 1024 * 1024) {
    throw new Error("statePath is unexpectedly large.");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("statePath must not be readable by group or other users.");
  }
}

function readRuntimeState(path: string): JsonRecord {
  assertPrivateStateFile(path);
  const parsed: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
    throw new Error("Unsupported Meshr runtime state format.");
  }
  const bindings = parsed.bindings.map((candidate) => {
    if (!isRecord(candidate)) return candidate;
    const credentialRef = typeof candidate.credentialRef === "string" ? candidate.credentialRef : "";
    const hasFileCredentials =
      typeof candidate.privateKeyPem === "string" &&
      typeof candidate.pairingSecret === "string";
    if (!credentialRef || hasFileCredentials) return candidate;
    if (process.platform !== "darwin") {
      throw new Error(
        "This Meshr binding uses the macOS keychain; run OpenClaw on the paired host or reconnect with a supported keychain.",
      );
    }
    const credentials = readKeychainCredentials(credentialRef);
    return {
      ...candidate,
      privateKeyPem: credentials.privateKeyPem,
      pairingSecret: credentials.pairingSecret,
      ...(typeof credentials.agentToken === "string" ? { agentToken: credentials.agentToken } : {}),
    };
  });
  return { ...parsed, bindings };
}

function readKeychainValue(service: string): string {
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", "meshr", "-s", service, "-w"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("Meshr keychain credentials are unavailable.");
  }
  return result.stdout.trim();
}

function readKeychainCredentials(ref: string): {
  privateKeyPem: string;
  pairingSecret: string;
  agentToken?: string;
} {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readKeychainValue(`Meshr/${ref}`));
  } catch {
    throw new Error("Meshr keychain credentials are corrupt.");
  }
  const fields = isRecord(manifest) && manifest.version === 1 && isRecord(manifest.fields)
    ? manifest.fields
    : null;
  if (
    !fields ||
    !Number.isInteger(fields.privateKeyPem) || Number(fields.privateKeyPem) < 1 ||
    !Number.isInteger(fields.pairingSecret) || Number(fields.pairingSecret) < 1 ||
    !Number.isInteger(fields.agentToken) || Number(fields.agentToken) < 0
  ) {
    throw new Error("Meshr keychain credentials are corrupt.");
  }
  const decode = (field: string, count: number): string => {
    if (count > 128) throw new Error("Meshr keychain credentials are corrupt.");
    let encoded = "";
    for (let index = 0; index < count; index += 1) {
      const chunk = readKeychainValue(`Meshr/${ref}/${field}/${index}`);
      if (!/^[A-Za-z0-9+/=]+$/.test(chunk) || chunk.length > 100) {
        throw new Error("Meshr keychain credentials are corrupt.");
      }
      encoded += chunk;
    }
    return Buffer.from(encoded, "base64").toString("utf8");
  };
  const privateKeyPem = decode("privateKeyPem", Number(fields.privateKeyPem));
  const pairingSecret = decode("pairingSecret", Number(fields.pairingSecret));
  const agentToken = Number(fields.agentToken)
    ? decode("agentToken", Number(fields.agentToken))
    : "";
  return {
    privateKeyPem,
    pairingSecret,
    ...(agentToken ? { agentToken } : {}),
  };
}

function writeKeychainValue(service: string, value: string): void {
  const result = spawnSync(
    "security",
    ["add-generic-password", "-a", "meshr", "-s", service, "-U", "-w"],
    { input: value + "\n" + value + "\n", encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("Meshr keychain credentials could not be updated.");
}

function encodeKeychainChunks(value: string): string[] {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < encoded.length; offset += 100) {
    chunks.push(encoded.slice(offset, offset + 100));
  }
  return chunks;
}

/**
 * Persist a rotated bearer in the same macOS keychain record used for the
 * pairing key. The public state file intentionally never contains these
 * secrets, so updating only state.json would make a clean restart resurrect a
 * superseded token.
 */
function writeKeychainCredentials(
  ref: string,
  credentials: { privateKeyPem: string; pairingSecret: string; agentToken?: string },
): void {
  if (process.platform !== "darwin") {
    throw new Error("Meshr keychain credentials require macOS.");
  }
  const fields = {
    privateKeyPem: encodeKeychainChunks(credentials.privateKeyPem),
    pairingSecret: encodeKeychainChunks(credentials.pairingSecret),
    agentToken: encodeKeychainChunks(credentials.agentToken ?? ""),
  };
  writeKeychainValue(`Meshr/${ref}`, JSON.stringify({
    version: 1,
    fields: {
      privateKeyPem: fields.privateKeyPem.length,
      pairingSecret: fields.pairingSecret.length,
      agentToken: fields.agentToken.length,
    },
  }));
  for (const [field, chunks] of Object.entries(fields)) {
    for (const [index, chunk] of chunks.entries()) {
      writeKeychainValue(`Meshr/${ref}/${field}/${index}`, chunk);
    }
  }
}

const stateWriteQueues = new Map<string, Promise<void>>();

/**
 * Keep the bearer/session rotation durable. OpenClaw may instantiate a tool
 * factory more than once, so writes are serialized per state file and replace
 * only the exact pairing selected by runtime subject and server URL.
 */
function persistBindingState(
  binding: BoundConnector,
  agentId: string,
  patch: {
    agentToken?: string;
    agentTokenExpiresAt?: string;
    sessionId?: string;
    definitionDigest?: string;
    requestedProfile?: JsonRecord;
    status: "connected" | "approved";
  },
): Promise<void> {
  if (!binding.statePath || !binding.pairingId) return Promise.resolve();
  const statePath = resolve(binding.statePath);
  const previous = stateWriteQueues.get(statePath) ?? Promise.resolve();
  const next = previous.then(() => {
    const state = readRuntimeState(statePath);
    const expectedSubject = `openclaw:${agentId}`;
    const matches = (state.bindings as unknown[]).filter((candidate): candidate is JsonRecord =>
      isRecord(candidate) &&
      candidate.pairingId === binding.pairingId &&
      candidate.runtime === "openclaw" &&
      candidate.externalSubject === expectedSubject &&
      typeof candidate.serverUrl === "string" &&
      normalizeBaseUrl(candidate.serverUrl) === binding.baseUrl,
    );
    if (matches.length !== 1) {
      throw new Error(`OpenClaw Meshr binding ${binding.pairingId} is no longer uniquely present in state.`);
    }
    const credentialRef = typeof matches[0].credentialRef === "string" ? matches[0].credentialRef : "";
    if (
      credentialRef &&
      process.platform === "darwin" &&
      Object.prototype.hasOwnProperty.call(patch, "agentToken")
    ) {
      const existing = readKeychainCredentials(credentialRef);
      writeKeychainCredentials(credentialRef, {
        privateKeyPem:
          typeof matches[0].privateKeyPem === "string" ? matches[0].privateKeyPem : existing.privateKeyPem,
        pairingSecret:
          typeof matches[0].pairingSecret === "string" ? matches[0].pairingSecret : existing.pairingSecret,
        ...(patch.agentToken ? { agentToken: patch.agentToken } : {}),
      });
    }
    Object.assign(matches[0], patch, { updatedAt: new Date().toISOString() });
    const temporary = `${statePath}.${process.pid}.tmp`;
    const persistedBindings = (state.bindings as unknown[]).map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.credentialRef !== "string") return candidate;
      const {
        privateKeyPem: _privateKeyPem,
        pairingSecret: _pairingSecret,
        agentToken: _agentToken,
        ...publicBinding
      } = candidate;
      return publicBinding;
    });
    writeFileSync(temporary, `${JSON.stringify({ ...state, bindings: persistedBindings }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, statePath);
  });
  stateWriteQueues.set(statePath, next.catch(() => undefined));
  return next;
}

function jsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

async function readJsonResponse(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  let value: unknown = null;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      value = { message: text.slice(0, 2_000) };
    }
  }
  const body = jsonRecord(value);
  if (!response.ok) {
    const nested = jsonRecord(body.error);
    const message =
      (typeof body.message === "string" && body.message) ||
      (typeof nested.message === "string" && nested.message) ||
      (typeof body.error === "string" && body.error) ||
      `Meshr request failed (${response.status}).`;
    const error = new Error(message) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = typeof nested.code === "string" ? nested.code : undefined;
    throw error;
  }
  return body;
}

function isSessionSupersededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; message?: unknown };
  return value.code === "session_superseded" ||
    (typeof value.message === "string" && value.message.toLowerCase().includes("superseded"));
}

async function signedSessionStart(
  binding: BoundConnector,
  sessionId?: string,
): Promise<{ token: string; expiresAt: string; sessionId: string }> {
  if (!binding.pairingId || !binding.pairingSecret || !binding.privateKeyPem) {
    throw new Error("OpenClaw binding lacks signed renewal credentials.");
  }
  const challengeResponse = await fetch(
    `${binding.baseUrl}/v1/pairings/${encodeURIComponent(binding.pairingId)}/challenges`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Pairing ${binding.pairingSecret}`,
        "x-meshr-contract-version": "1",
      },
      body: sessionId ? JSON.stringify({ sessionId }) : undefined,
    },
  );
  const challenge = await readJsonResponse(challengeResponse);
  const challengeId = typeof challenge.challengeId === "string" ? challenge.challengeId : "";
  const message = typeof challenge.message === "string" ? challenge.message : "";
  if (!challengeId || !message) throw new Error("Meshr returned an invalid renewal challenge.");
  const signature = sign(null, Buffer.from(message, "utf8"), binding.privateKeyPem).toString("base64url");
  const path = sessionId ? "/v1/agent-sessions/renew" : "/v1/agent-sessions";
  const response = await fetch(`${binding.baseUrl}${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Pairing ${binding.pairingSecret}`,
      "x-meshr-contract-version": "1",
    },
    body: JSON.stringify({
      pairingId: binding.pairingId,
      challengeId,
      ...(sessionId ? { sessionId } : {}),
      signature,
    }),
  });
  const result = await readJsonResponse(response);
  const token = typeof result.token === "string" ? result.token : "";
  const expiresAt = typeof result.expiresAt === "string" ? result.expiresAt : "";
  const renewedSessionId = typeof result.sessionId === "string" ? result.sessionId : "";
  if (!token || !expiresAt || !renewedSessionId) throw new Error("Meshr returned an invalid agent session.");
  return { token, expiresAt, sessionId: renewedSessionId };
}

/** Start a new host-owned session and atomically supersede any old session. */
async function startOpenClawSession(binding: BoundConnector, agentId: string): Promise<void> {
  const started = await signedSessionStart(binding);
  Object.assign(binding, {
    token: started.token,
    agentTokenExpiresAt: started.expiresAt,
    sessionId: started.sessionId,
    sessionSuperseded: false,
    supersededToken: undefined,
    sessionValidated: true,
  });
  await persistBindingState(binding, agentId, {
    agentToken: started.token,
    agentTokenExpiresAt: started.expiresAt,
    sessionId: started.sessionId,
    status: "connected",
  });
}

async function renewOpenClawSession(binding: BoundConnector, agentId: string): Promise<void> {
  if (!binding.pairingId || !binding.pairingSecret || !binding.privateKeyPem) return;
  let renewed: { token: string; expiresAt: string; sessionId: string };
  try {
    renewed = await signedSessionStart(binding, binding.sessionId);
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : 0;
    // A page WebMCP transfer or newer native host deliberately owns the
    // identity now. Reclaiming here would silently defeat that handoff.
    if (isSessionSupersededError(error) || !binding.sessionId || (status !== 401 && status !== 403 && status !== 404)) {
      throw error;
    }
    renewed = await signedSessionStart(binding);
  }
  Object.assign(binding, {
    token: renewed.token,
    agentTokenExpiresAt: renewed.expiresAt,
    sessionId: renewed.sessionId,
  });
  await persistBindingState(binding, agentId, {
    agentToken: renewed.token,
    agentTokenExpiresAt: renewed.expiresAt,
    sessionId: renewed.sessionId,
    status: "connected",
  });
}

function assertDefinitionText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} must be between 1 and ${max} characters.`);
  }
  return value.trim();
}

function assertDefinitionList(value: unknown, label: string, maxItems: number, maxItemLength: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new Error(`${label} must contain 1 to ${maxItems} items.`);
  }
  return value.map((item, index) => assertDefinitionText(item, `${label}[${index}]`, maxItemLength));
}

async function loadDefinitionProfile(binding: BoundConnector): Promise<{
  profile: JsonRecord;
  digest: string;
}> {
  if (!binding.definitionPath) throw new Error("This binding has no .meshr definition path.");
  const source = await readFile(resolve(binding.definitionPath), "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  const parsed = parseYaml(source) as unknown;
  const root = jsonRecord(parsed);
  if (root.apiVersion !== "meshr.agent/v0alpha1") {
    throw new Error("apiVersion must be meshr.agent/v0alpha1.");
  }
  if (root.kind !== "Agent") throw new Error("kind must be Agent.");
  const metadata = jsonRecord(root.metadata);
  const spec = jsonRecord(root.spec);
  const name = assertDefinitionText(metadata.name, "metadata.name", 48);
  const handle = assertDefinitionText(metadata.handle, "metadata.handle", 32).toLowerCase();
  if (handle.length < 2 || !/^[a-z](?:[a-z0-9-]*[a-z0-9])$/.test(handle)) {
    throw new Error("metadata.handle must contain only lowercase letters, numbers, and hyphens.");
  }
  const interests = assertDefinitionList(spec.interests, "spec.interests", 12, 80);
  assertDefinitionList(spec.reads, "spec.reads", 12, 120);
  assertDefinitionList(spec.shares, "spec.shares", 12, 120);
  const attention = jsonRecord(spec.attention);
  const browse = attention.browse;
  const rootPosts = attention.rootPosts;
  const replies = attention.replies;
  if (!new Set(["public", "joined", "mentions"]).has(String(browse))) {
    throw new Error("spec.attention.browse must be public, joined, or mentions.");
  }
  if (!new Set(["never", "draft", "autonomous"]).has(String(rootPosts))) {
    throw new Error("spec.attention.rootPosts must be never, draft, or autonomous.");
  }
  if (!new Set(["never", "draft", "autonomous"]).has(String(replies))) {
    throw new Error("spec.attention.replies must be never, draft, or autonomous.");
  }
  const notes = assertDefinitionText(attention.notes, "spec.attention.notes", 500);
  const profile: JsonRecord = {
    name,
    handle,
    tagline: assertDefinitionText(spec.tagline, "spec.tagline", 140),
    interests,
    personality: assertDefinitionText(root.personality, "personality", 2_000),
    attention: { browse, rootPosts, replies, notes },
  };
  return { profile, digest };
}

async function readDefinitionDigest(path: string | undefined, fallback = ""): Promise<string> {
  if (!path) return fallback;
  try {
    const source = await readFile(resolve(path), "utf8");
    return createHash("sha256").update(source).digest("hex");
  } catch {
    return fallback;
  }
}

function isUnexpired(binding: JsonRecord, now: number): boolean {
  if (binding.agentTokenExpiresAt === undefined) return true;
  if (typeof binding.agentTokenExpiresAt !== "string") return false;
  const expiresAt = Date.parse(binding.agentTokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function readAttentionPolicy(binding: JsonRecord): AttentionPolicy {
  const requestedProfile = isRecord(binding.requestedProfile)
    ? binding.requestedProfile
    : {};
  const attention = isRecord(requestedProfile.attention)
    ? requestedProfile.attention
    : {};
  const browse = new Set<BrowseMode>(["public", "joined", "mentions"]);
  const participation = new Set<ParticipationMode>([
    "never",
    "draft",
    "autonomous",
  ]);

  return {
    ...(browse.has(attention.browse as BrowseMode)
      ? { browse: attention.browse as BrowseMode }
      : {}),
    ...(participation.has(attention.rootPosts as ParticipationMode)
      ? { rootPosts: attention.rootPosts as ParticipationMode }
      : {}),
    ...(participation.has(attention.replies as ParticipationMode)
      ? { replies: attention.replies as ParticipationMode }
      : {}),
  } satisfies AttentionPolicy;
}

function attentionAllows(
  attention: AttentionPolicy,
  capability: MeshrToolSpec["attention"],
): boolean {
  if (capability === "identity") return true;
  if (capability === "mentions") return attention.browse === "mentions";
  if (capability === "browse") {
    return attention.browse === "public" || attention.browse === "joined";
  }
  if (capability === "rootPosts") {
    return attention.rootPosts === "autonomous";
  }
  return attention.replies === "autonomous";
}

function selectConnectorBinding(
  config: PluginConfig,
  openClawAgentId: string,
  now = Date.now(),
): BoundConnector | null {
  const agentId = openClawAgentId.trim();
  if (!agentId) return null;

  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const statePath = config.statePath;
  if (!statePath) throw new Error("statePath is required.");
  const state = readRuntimeState(statePath);
  const expectedSubject = `openclaw:${agentId}`;
  const matches = (state.bindings as unknown[]).filter((candidate): candidate is JsonRecord => {
    if (!isRecord(candidate)) return false;
    const canRenew =
      typeof candidate.pairingId === "string" &&
      typeof candidate.pairingSecret === "string" &&
      typeof candidate.privateKeyPem === "string";
    if (
      candidate.runtime !== "openclaw" ||
      candidate.externalSubject !== expectedSubject ||
      (candidate.status !== "connected" && candidate.status !== "approved") ||
      ((typeof candidate.agentToken !== "string" || candidate.agentToken.length === 0) &&
        !canRenew) ||
      typeof candidate.serverUrl !== "string" ||
      (!isUnexpired(candidate, now) && !canRenew)
    ) {
      return false;
    }
    try {
      return normalizeBaseUrl(candidate.serverUrl) === baseUrl;
    } catch {
      return false;
    }
  });

  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`Multiple connected Meshr bindings match OpenClaw agent ${agentId}.`);
  }
  const candidate: BoundConnector = {
    baseUrl,
    token: typeof matches[0].agentToken === "string" ? matches[0].agentToken : "",
    externalSubject: expectedSubject,
    pairingId: typeof matches[0].pairingId === "string" ? matches[0].pairingId : undefined,
    pairingSecret: typeof matches[0].pairingSecret === "string" ? matches[0].pairingSecret : undefined,
    privateKeyPem: typeof matches[0].privateKeyPem === "string" ? matches[0].privateKeyPem : undefined,
    statePath,
    definitionPath:
      typeof matches[0].definitionPath === "string" ? resolve(matches[0].definitionPath) : undefined,
    definitionDigest:
      typeof matches[0].definitionDigest === "string" ? matches[0].definitionDigest : undefined,
    requestedProfile: isRecord(matches[0].requestedProfile) ? matches[0].requestedProfile : undefined,
    agentTokenExpiresAt:
      typeof matches[0].agentTokenExpiresAt === "string" ? matches[0].agentTokenExpiresAt : undefined,
    sessionId:
      typeof matches[0].sessionId === "string" ? (matches[0].sessionId as string) : undefined,
    attention: readAttentionPolicy(matches[0]),
    sessionValidated: false,
  };
  const cacheKey = bindingCacheKey(candidate);
  candidate.cacheKey = cacheKey;
  const cached = bindingCache.get(cacheKey);
  if (cached) {
    // Every OpenClaw tool factory receives this same mutable object. Renewals
    // and supersession therefore update root/reply/observe clients together
    // instead of leaving factories with stale bearer tokens.
    // A binding cleared by this process after a deliberate WebMCP handoff is
    // not eligible for same-process reclaim. A fresh process starts with an
    // empty cache and may obtain a new signed session when the host restarts.
    if (cached.sessionSuperseded &&
        (cached.supersededToken === candidate.token || candidate.token.length === 0)) return null;
    const cachedExpiry = cached.agentTokenExpiresAt ? Date.parse(cached.agentTokenExpiresAt) : 0;
    const candidateExpiry = candidate.agentTokenExpiresAt ? Date.parse(candidate.agentTokenExpiresAt) : 0;
    // A renewal updates the shared object before its serialized state file is
    // flushed. Do not let a second factory briefly overwrite that newer token
    // with the older on-disk snapshot; an externally newer session still wins
    // when its expiry is later.
    if (cached.token && cachedExpiry > candidateExpiry) return cached;
    const sameSession = cached.sessionId === candidate.sessionId && cached.token === candidate.token;
    Object.assign(cached, candidate, {
      sessionSuperseded: false,
      supersededToken: undefined,
      sessionValidated: sameSession ? cached.sessionValidated : false,
    });
    return cached;
  }
  bindingCache.set(cacheKey, candidate);
  return candidate;
}

const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
// A slow gateway/provider must not let the 30-second timer overlap itself.
// Overlapping renewals race on the single active-session invariant: the first
// renewal supersedes the old session and the second can then stop the freshly
// renewed token. Keep one in-flight heartbeat/renewal per binding instead.
const heartbeatWork = new Map<string, Promise<void>>();
const sessionStartWork = new Map<string, Promise<void>>();
const bindingCache = new Map<string, BoundConnector>();

function bindingCacheKey(binding: Pick<BoundConnector, "baseUrl" | "statePath" | "pairingId" | "externalSubject">): string {
  return [binding.statePath ?? "", binding.baseUrl, binding.pairingId ?? binding.externalSubject].join("\u0000");
}

function stopRuntimeSession(binding: BoundConnector, agentId: string): void {
  binding.supersededToken = binding.token;
  binding.sessionSuperseded = true;
  binding.token = "";
  binding.sessionId = undefined;
  binding.agentTokenExpiresAt = undefined;
  binding.sessionValidated = false;
  const timerKey = binding.cacheKey ?? bindingCacheKey(binding);
  const timer = heartbeatTimers.get(timerKey);
  if (timer) {
    clearInterval(timer);
    heartbeatTimers.delete(timerKey);
  }
  heartbeatWork.delete(timerKey);
  void persistBindingState(binding, agentId, {
    status: "approved",
    agentToken: undefined,
    agentTokenExpiresAt: undefined,
    sessionId: undefined,
  }).catch(() => undefined);
}

function keepRuntimeSessionAlive(binding: BoundConnector, agentId: string): void {
  const timerKey = binding.cacheKey ?? bindingCacheKey(binding);
  if (!binding.sessionId || binding.sessionSuperseded || heartbeatTimers.has(timerKey)) return;
  const maintain = async (): Promise<void> => {
    if (!binding.sessionId) return;
    let heartbeatOk = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    timeout.unref?.();
    try {
      const response = await fetch(binding.baseUrl + "/v1/agent-sessions/heartbeat", {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: "Bearer " + binding.token,
          "x-meshr-contract-version": "1",
        },
        signal: controller.signal,
      });
      await readJsonResponse(response);
      heartbeatOk = true;
    } catch (error) {
      if (isSessionSupersededError(error)) {
        stopRuntimeSession(binding, agentId);
        return;
      }
      heartbeatOk = false;
    } finally {
      clearTimeout(timeout);
    }
    const expiry = binding.agentTokenExpiresAt ? Date.parse(binding.agentTokenExpiresAt) : 0;
    if (!heartbeatOk || !Number.isFinite(expiry) || expiry - Date.now() <= 120_000) {
      try {
        await renewOpenClawSession(binding, agentId);
      } catch (error) {
        if (isSessionSupersededError(error)) {
          stopRuntimeSession(binding, agentId);
          return;
        }
        // Keep the timer alive; the next tick can recover after a transient
        // gateway/provider outage. Tools remain bound to the last known token.
      }
    }
  };
  const runMaintain = (): Promise<void> => {
    const existing = heartbeatWork.get(timerKey);
    if (existing) return existing;
    const work = maintain();
    const tracked = work.finally(() => {
      if (heartbeatWork.get(timerKey) === tracked) heartbeatWork.delete(timerKey);
    });
    heartbeatWork.set(timerKey, tracked);
    return tracked;
  };
  const timer = setInterval(() => void runMaintain(), 30_000);
  timer.unref();
  heartbeatTimers.set(timerKey, timer);
  void runMaintain();
}

async function ensureRuntimeSession(binding: BoundConnector, agentId: string): Promise<void> {
  if (binding.sessionSuperseded) {
    throw Object.assign(new Error("This OpenClaw runtime session has been superseded."), {
      code: "session_superseded",
    });
  }
  if (binding.token && binding.sessionId) {
    const canRenew = Boolean(binding.pairingId && binding.pairingSecret && binding.privateKeyPem);
    if (canRenew && !binding.sessionValidated) {
      // A new OpenClaw host process must own a new runtime session even when
      // its state file contains an unexpired bearer. This prevents two host
      // processes from sharing write authority. The shared start-work map
      // below keeps multiple tool factories in one process from racing.
      const timerKey = binding.cacheKey ?? bindingCacheKey(binding);
      const existing = sessionStartWork.get(timerKey);
      if (existing) {
        await existing;
      } else {
        const work = startOpenClawSession(binding, agentId);
        const tracked = work.finally(() => {
          if (sessionStartWork.get(timerKey) === tracked) sessionStartWork.delete(timerKey);
        });
        sessionStartWork.set(timerKey, tracked);
        await tracked;
      }
    }
    keepRuntimeSessionAlive(binding, agentId);
    return;
  }
  // Older state files may contain a bearer-only binding without the signed
  // renewal material introduced with durable runtime sessions. Preserve that
  // compatibility path: the server still authenticates the bearer, but this
  // process cannot renew or reclaim it. New paired bindings always carry the
  // credentials below and establish a fresh signed session on restart.
  if (binding.token && (!binding.pairingId || !binding.pairingSecret || !binding.privateKeyPem)) {
    return;
  }
  const timerKey = binding.cacheKey ?? bindingCacheKey(binding);
  const existing = sessionStartWork.get(timerKey);
  if (existing) {
    await existing;
    return;
  }
  const work = (async () => {
    const started = await signedSessionStart(binding);
    Object.assign(binding, {
      token: started.token,
      agentTokenExpiresAt: started.expiresAt,
      sessionId: started.sessionId,
      sessionSuperseded: false,
      supersededToken: undefined,
      sessionValidated: true,
    });
    await persistBindingState(binding, agentId, {
      agentToken: started.token,
      agentTokenExpiresAt: started.expiresAt,
      sessionId: started.sessionId,
      status: "connected",
    });
    keepRuntimeSessionAlive(binding, agentId);
  })();
  const tracked = work.finally(() => {
    if (sessionStartWork.get(timerKey) === tracked) sessionStartWork.delete(timerKey);
  });
  sessionStartWork.set(timerKey, tracked);
  await tracked;
}

class MeshrClient {
  constructor(readonly binding: BoundConnector, readonly agentId?: string) {}

  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    if (this.agentId) await ensureRuntimeSession(this.binding, this.agentId);
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${this.binding.token}`,
      "x-meshr-contract-version": "1",
    });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (options.idempotencyKey) {
      headers.set("idempotency-key", options.idempotencyKey);
    }

    const response = await fetch(`${this.binding.baseUrl}${path}`, {
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
        value = { message: text.slice(0, 2_000) };
      }
    }
    if (!response.ok) {
      const body = isRecord(value) ? value : {};
      const nested = isRecord(body.error) ? body.error : {};
      const message =
        (typeof body.message === "string" && body.message) ||
        (typeof nested.message === "string" && nested.message) ||
        (typeof body.error === "string" && body.error) ||
        `Meshr request failed (${response.status}).`;
      const error = new Error(message) as Error & { status?: number; code?: string };
      error.status = response.status;
      error.code = typeof nested.code === "string" ? nested.code : undefined;
      throw error;
    }
    return value;
  }

  async reloadProfile(toolCallId: string, signal?: AbortSignal): Promise<unknown> {
    let profile: JsonRecord;
    let digest: string;
    try {
      const loaded = await loadDefinitionProfile(this.binding);
      profile = loaded.profile;
      digest = loaded.digest;
    } catch (error) {
      const message = error instanceof Error ? error.message : "The agent definition is invalid.";
      return {
        contract_version: 1,
        applied: false,
        applied_fields: [],
        pending_owner_review_fields: [],
        source_digest: await readDefinitionDigest(this.binding.definitionPath, this.binding.definitionDigest),
        validation_failures: [message.slice(0, 240)],
      };
    }
    let response: unknown;
    try {
      response = await this.request("/v1/agent/profile", {
        method: "PUT",
        body: { profile, definitionDigest: digest, reload: true },
        idempotencyKey: idempotencyKey({ agentId: this.binding.externalSubject, toolCallId, signal }, "profile.reload"),
        signal,
      });
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : 0;
      if (status === 400) {
        const message = error instanceof Error ? error.message : "The agent definition failed Meshr validation.";
        return {
          contract_version: 1,
          applied: false,
          applied_fields: [],
          pending_owner_review_fields: [],
          source_digest: digest,
          validation_failures: [message.slice(0, 240)],
        };
      }
      throw error;
    }
    const record = isRecord(response) ? response : {};
    const agent = isRecord(record.agent) ? record.agent : {};
    const serverProfile: JsonRecord = {
      ...(isRecord(this.binding.requestedProfile) ? this.binding.requestedProfile : {}),
      ...(typeof agent.name === "string" ? { name: agent.name } : {}),
      ...(typeof agent.handle === "string" ? { handle: agent.handle } : {}),
      ...(typeof agent.tagline === "string" ? { tagline: agent.tagline } : {}),
      ...(Array.isArray(agent.interests) ? { interests: agent.interests.filter((value): value is string => typeof value === "string") } : {}),
      ...(typeof agent.personality === "string" ? { personality: agent.personality } : {}),
      ...(isRecord(agent.attention) ? { attention: agent.attention } : {}),
    };
    const reload = isRecord(record.profileReload) ? record.profileReload : undefined;
    Object.assign(this.binding, {
      requestedProfile: serverProfile,
      definitionDigest: typeof reload?.source_digest === "string" ? reload.source_digest : digest,
      attention: readAttentionPolicy({ requestedProfile: serverProfile }),
    });
    await persistBindingState(this.binding, this.binding.externalSubject.replace(/^openclaw:/, ""), {
      agentToken: this.binding.token,
      agentTokenExpiresAt: this.binding.agentTokenExpiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString(),
      sessionId: this.binding.sessionId ?? "",
      definitionDigest: this.binding.definitionDigest,
      requestedProfile: this.binding.requestedProfile,
      status: "connected",
    });
    return reload ?? response;
  }
}

function idempotencyKey(context: ToolExecutionContext, operation: string): string {
  const digest = createHash("sha256")
    .update(`${context.agentId}\0${operation}\0${context.toolCallId}`)
    .digest("hex");
  return `meshr.${digest}`;
}

function result(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2) ?? "null",
      },
    ],
    details: value,
  };
}

const toolSpecs: readonly MeshrToolSpec[] = [
  {
    name: "meshr_get_my_agent",
    label: "Get my Meshr agent",
    description: "Read the Meshr profile bound to this OpenClaw agent.",
    attention: "identity",
    parameters: emptyParameters(),
    execute: (client, _params, context) =>
      client.request("/v1/agent/profile", { signal: context.signal }),
  },
  {
    name: "meshr_appeal_post",
    label: "Appeal a moderated Meshr post",
    description: "Request review of a moderated post authored by this OpenClaw agent.",
    attention: "identity",
    parameters: Type.Object(
      {
        postId: stringParameter("Moderated post ID."),
        reason: Type.Optional(stringParameter("Optional appeal context.", 500)),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request(
        `/v1/agent/posts/${encodeURIComponent(requiredString(params, "postId"))}/appeal`,
        {
          method: "POST",
          ...(params.reason === undefined
            ? {}
            : { body: { reason: requiredString(params, "reason") } }),
          idempotencyKey: idempotencyKey(context, "post.appeal"),
          signal: context.signal,
        },
      ),
  },
  {
    name: "meshr_reload_my_profile",
    label: "Reload my Meshr profile",
    description: "Re-read this agent's paired .meshr definition and apply safe profile changes.",
    attention: "identity",
    parameters: emptyParameters(),
    execute: (client, _params, context) => client.reloadProfile(context.toolCallId, context.signal),
  },
  {
    name: "meshr_discover_meshes",
    label: "Discover Meshr meshes",
    description: "List public meshes and private meshes this agent has joined.",
    attention: "browse",
    parameters: emptyParameters(),
    execute: (client, _params, context) =>
      client.request("/v1/agent/meshes", { signal: context.signal }),
  },
  {
    name: "meshr_join_mesh",
    label: "Join a Meshr mesh",
    description: "Join an open mesh or request admission to an approval-based mesh.",
    attention: "browse",
    parameters: Type.Object(
      { meshId: stringParameter("Mesh ID returned by meshr_discover_meshes.") },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request(
        `/v1/agent/meshes/${encodeURIComponent(requiredString(params, "meshId"))}/join`,
        {
          method: "POST",
          idempotencyKey: idempotencyKey(context, "mesh.join"),
          signal: context.signal,
        },
      ),
  },
  {
    name: "meshr_list_conversations",
    label: "List Meshr conversations",
    description: "List conversations in an accessible Meshr mesh.",
    attention: "browse",
    parameters: Type.Object(
      { meshId: stringParameter("Mesh ID returned by meshr_discover_meshes.") },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request(
        `/v1/agent/meshes/${encodeURIComponent(requiredString(params, "meshId"))}/topics`,
        { signal: context.signal },
      ),
  },
  {
    name: "meshr_read_conversation",
    label: "Read a Meshr conversation",
    description: "Read recent agent posts and replies in one conversation.",
    attention: "browse",
    parameters: Type.Object(
      {
        topicId: stringParameter("Conversation ID."),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 25, description: "Maximum posts to return." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) => {
      const topicId = encodeURIComponent(requiredString(params, "topicId"));
      const limit = optionalInteger(params, "limit", 1, 25);
      return client.request(
        `/v1/agent/topics/${topicId}/posts${limit === undefined ? "" : `?limit=${limit}`}`,
        { signal: context.signal },
      );
    },
  },
  {
    name: "meshr_publish_post",
    label: "Publish a Meshr post",
    description: "Publish a plain-text post as this connected agent.",
    attention: "rootPosts",
    parameters: Type.Object(
      {
        meshId: stringParameter("Joined mesh ID."),
        topicId: stringParameter("Conversation ID."),
        body: stringParameter("Post text.", 1_200),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request("/v1/agent/posts", {
        method: "POST",
        body: {
          meshId: requiredString(params, "meshId"),
          topicId: requiredString(params, "topicId"),
          body: requiredString(params, "body"),
        },
        idempotencyKey: idempotencyKey(context, "post.create"),
        signal: context.signal,
      }),
  },
  {
    name: "meshr_reply_to_post",
    label: "Reply to a Meshr post",
    description: "Reply to a Meshr post as this connected agent.",
    attention: "replies",
    parameters: Type.Object(
      {
        postId: stringParameter("Root post ID."),
        body: stringParameter("Reply text.", 1_200),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request(
        `/v1/agent/posts/${encodeURIComponent(requiredString(params, "postId"))}/replies`,
        {
          method: "POST",
          body: { body: requiredString(params, "body") },
          idempotencyKey: idempotencyKey(context, "reply.create"),
          signal: context.signal,
        },
      ),
  },
  {
    name: "meshr_follow_conversation",
    label: "Follow a Meshr conversation",
    description: "Follow a conversation as this connected agent.",
    attention: "browse",
    parameters: Type.Object(
      { topicId: stringParameter("Conversation ID.") },
      { additionalProperties: false },
    ),
    execute: (client, params, context) =>
      client.request(
        `/v1/agent/topics/${encodeURIComponent(requiredString(params, "topicId"))}/follow`,
        {
          method: "PUT",
          idempotencyKey: idempotencyKey(context, "topic.follow"),
          signal: context.signal,
        },
      ),
  },
  {
    name: "meshr_observe_activity",
    label: "Observe Meshr activity",
    description: "Read durable Meshr activity after an optional cursor.",
    attention: "browse",
    parameters: Type.Object(
      {
        after: Type.Optional(
          Type.Union([
            Type.Integer({ minimum: 0, description: "Legacy local event sequence; use the returned opaque cursor in production." }),
            Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$", description: "Opaque durable activity cursor." }),
          ]),
        ),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 100, description: "Maximum events." }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) => {
      const after = optionalActivityCursor(params, "after");
      const limit = optionalInteger(params, "limit", 1, 100);
      const query = new URLSearchParams();
      if (after !== undefined) query.set("after", String(after));
      if (limit !== undefined) query.set("limit", String(limit));
      return client.request(`/v1/agent/events${query.size ? `?${query}` : ""}`, {
        signal: context.signal,
      });
    },
  },
  {
    name: "meshr_observe_mentions",
    label: "Observe Meshr mentions",
    description: "Read durable activity that mentions this agent's handle.",
    attention: "mentions",
    parameters: Type.Object(
      {
        after: Type.Optional(
          Type.Union([
            Type.Integer({ minimum: 0, description: "Legacy local event sequence." }),
            Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$", description: "Opaque durable activity cursor." }),
          ]),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum events." })),
      },
      { additionalProperties: false },
    ),
    execute: (client, params, context) => {
      const after = optionalActivityCursor(params, "after");
      const limit = optionalInteger(params, "limit", 1, 100);
      const query = new URLSearchParams();
      if (after !== undefined) query.set("after", after);
      if (limit !== undefined) query.set("limit", String(limit));
      return client.request(`/v1/agent/events${query.size ? `?${query}` : ""}`, {
        signal: context.signal,
      });
    },
  },
];

function createBoundTool(
  spec: MeshrToolSpec,
  config: PluginConfig,
  toolContext: OpenClawPluginToolContext,
): AnyAgentTool | null {
  const explicitAgentId = toolContext.agentId?.trim();
  const sessionAgentId = toolContext.sessionKey
    ? resolveAgentIdFromSessionKey(toolContext.sessionKey)?.trim()
    : undefined;
  if (
    explicitAgentId &&
    sessionAgentId &&
    explicitAgentId !== sessionAgentId
  ) {
    return null;
  }
  const agentId = explicitAgentId || sessionAgentId;
  if (!agentId) return null;
  const binding = selectConnectorBinding(config, agentId);
  if (!binding) return null;
  if (binding.sessionSuperseded) return null;
  if (!attentionAllows(binding.attention, spec.attention)) return null;
  const client = new MeshrClient(binding, agentId);

  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(toolCallId, rawParams, signal) {
      const params = isRecord(rawParams) ? rawParams : {};
      const value = await spec.execute(client, params, {
        agentId,
        toolCallId,
        signal,
      });
      return result(value);
    },
  };
}

export default defineToolPlugin({
  id: "meshr",
  name: "Meshr",
  description: "Connect a paired OpenClaw agent to Meshr.",
  configSchema,
  tools: (tool) =>
    toolSpecs.map((spec) =>
      tool({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        factory: ({ config, toolContext }) =>
          createBoundTool(spec, config, toolContext),
      }),
    ),
});
