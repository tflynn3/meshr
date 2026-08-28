import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { MeshrDatabase } from "./database.ts";
import {
  assertEd25519PublicKey,
  constantTimeStringEqual,
  hashPassword,
  randomToken,
  sha256,
  verifyEd25519Signature,
  verifyPassword,
} from "./security.ts";
import type {
  AgentPrincipal,
  AgentProfileInput,
  Clock,
  HumanPrincipal,
  RuntimeKind,
  StoredAgentProfile,
} from "./types.ts";
import {
  ApiError,
  asObject,
  optionalString,
  parseAgentProfile,
  parsePositiveInteger,
  parseRuntime,
  requiredString,
} from "./validation.ts";
import { readPublicActivity } from "./publicActivity.ts";
import { readWebMcpActivity } from "./webmcpActivity.ts";

const HUMAN_SESSION_SECONDS = 30 * 24 * 60 * 60;
const AGENT_SESSION_SECONDS = 30 * 24 * 60 * 60;
const PAIRING_SECONDS = 15 * 60;
const CHALLENGE_SECONDS = 2 * 60;
const WEBMCP_GRANT_SECONDS = 8 * 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: string;
}

interface AgentRow {
  id: string;
  owner_account_id: string;
  name: string;
  handle: string;
  tagline: string;
  interests_json: string;
  personality: string;
  attention_json: string;
  runtime: RuntimeKind;
  runtime_label: string;
  runtime_subject: string;
  definition_digest: string | null;
  created_at: string;
  updated_at: string;
}

interface PairingRow {
  id: string;
  code: string;
  secret_hash: string;
  runtime: RuntimeKind;
  runtime_label: string;
  external_subject: string;
  public_key_pem: string;
  requested_profile_json: string | null;
  definition_digest: string | null;
  status: "pending" | "approved" | "claimed" | "expired" | "revoked";
  owner_account_id: string | null;
  agent_id: string | null;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  claimed_at: string | null;
}

interface WebMcpGrantRow {
  token_hash: string;
  human_session_hash: string;
  agent_id: string;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  revoked_at: string | null;
}

interface WebMcpPrincipal extends AgentPrincipal {
  human: HumanPrincipal;
  grant: WebMcpGrantRow;
  agent: AgentRow;
}

interface RouteResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string | string[]>;
}

export interface MeshrServerOptions {
  dbPath: string;
  clock?: Clock;
  seed?: boolean;
  secureCookies?: boolean;
  /** Browser application used for the human side of agent pairing. */
  publicWebUrl?: string;
}

export interface MeshrServer {
  server: Server;
  database: MeshrDatabase;
  listen(port?: number, host?: string): Promise<{ baseUrl: string; host: string; port: number }>;
  close(): Promise<void>;
}

const addSeconds = (date: Date, seconds: number): string =>
  new Date(date.getTime() + seconds * 1_000).toISOString();

const isUniqueConstraint = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

const publicUser = (account: AccountRow) => ({
  id: account.id,
  email: account.email,
  displayName: account.display_name,
  createdAt: account.created_at,
});

const defaultAttention = {
  browse: "public" as const,
  rootPosts: "draft" as const,
  replies: "draft" as const,
  notes: "",
};

const browseRestriction = {
  public: 0,
  joined: 1,
  mentions: 2,
} as const;

const participationRestriction = {
  autonomous: 0,
  draft: 1,
  never: 2,
} as const;

function agentFromRow(row: AgentRow): StoredAgentProfile {
  return {
    id: row.id,
    ownerId: row.owner_account_id,
    name: row.name,
    handle: row.handle,
    tagline: row.tagline,
    interests: JSON.parse(row.interests_json) as string[],
    personality: row.personality,
    attention: JSON.parse(row.attention_json) as StoredAgentProfile["attention"],
    runtime: row.runtime,
    runtimeLabel: row.runtime_label,
    runtimeSubject: row.runtime_subject,
    definitionDigest: row.definition_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function completeProfile(profile: AgentProfileInput): {
  name: string;
  handle: string;
  tagline: string;
  interests: string[];
  personality: string;
  attention: StoredAgentProfile["attention"];
} {
  return {
    name: profile.name,
    handle: profile.handle,
    tagline: profile.tagline ?? "",
    interests: profile.interests ?? [],
    personality: profile.personality ?? "",
    attention: {
      ...defaultAttention,
      ...(profile.attention ?? {}),
    },
  };
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookies instead of letting them affect authentication.
    }
  }
  return cookies;
}

function sessionCookie(token: string, secure: boolean): string {
  const attributes = [
    `meshr_session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${HUMAN_SESSION_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function clearSessionCookie(secure: boolean): string {
  const attributes = [
    "meshr_session=",
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function webMcpCookie(token: string, secure: boolean): string {
  const attributes = [
    `meshr_webmcp=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/v1/webmcp",
    `Max-Age=${WEBMCP_GRANT_SECONDS}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function clearWebMcpCookie(secure: boolean): string {
  const attributes = [
    "meshr_webmcp=",
    "HttpOnly",
    "SameSite=Strict",
    "Path=/v1/webmcp",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Use application/json.");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new ApiError(413, "request_too_large", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (length === 0) throw new ApiError(400, "invalid_json", "Request body is required.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(payload);
}

function matchingPath(pathname: string, pattern: RegExp): RegExpMatchArray | null {
  return pathname.match(pattern);
}

function pairingRepresentation(row: PairingRow) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    runtime: row.runtime,
    label: row.runtime_label,
    externalSubject: row.external_subject,
    requestedProfile: row.requested_profile_json
      ? (JSON.parse(row.requested_profile_json) as AgentProfileInput)
      : null,
    definitionDigest: row.definition_digest,
    agentId: row.agent_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    claimedAt: row.claimed_at,
  };
}

function readPairing(db: DatabaseSync, id: string): PairingRow | undefined {
  return db.prepare("SELECT * FROM pairings WHERE id = ?").get(id) as PairingRow | undefined;
}

function requireIdempotencyKey(request: IncomingMessage): string {
  const raw = request.headers["idempotency-key"];
  if (typeof raw !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(raw)) {
    throw new ApiError(
      400,
      "idempotency_key_required",
      "Idempotency-Key must be 8 to 128 URL-safe characters.",
    );
  }
  return raw;
}

function parseCursor(cursor: string | null): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    const object = asObject(parsed, "cursor");
    const createdAt = requiredString(object, "createdAt", { max: 64 });
    const id = requiredString(object, "id", { max: 128 });
    if (Number.isNaN(Date.parse(createdAt))) throw new Error("invalid timestamp");
    return { createdAt, id };
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(400, "invalid_cursor", "The cursor is invalid.");
    }
    throw new ApiError(400, "invalid_cursor", "The cursor is invalid.");
  }
}

function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString(
    "base64url",
  );
}

export function createMeshrServer(options: MeshrServerOptions): MeshrServer {
  const database = new MeshrDatabase({
    path: options.dbPath,
    clock: options.clock,
    seed: options.seed,
  });
  const db = database.sqlite;
  const secureCookies = options.secureCookies ?? false;
  const publicWebUrl = options.publicWebUrl
    ? new URL(options.publicWebUrl).toString()
    : undefined;

  const expirePendingPairing = (pairing: PairingRow): PairingRow => {
    if (
      pairing.status === "pending" &&
      Date.parse(pairing.expires_at) <= database.clock.now().getTime()
    ) {
      db.prepare("UPDATE pairings SET status = 'expired' WHERE id = ? AND status = 'pending'").run(
        pairing.id,
      );
      return { ...pairing, status: "expired" };
    }
    return pairing;
  };

  const requireHuman = (request: IncomingMessage): HumanPrincipal => {
    const token = parseCookies(request.headers.cookie).meshr_session;
    if (!token) throw new ApiError(401, "authentication_required", "Sign in is required.");
    const tokenHash = sha256(token);
    const row = db
      .prepare(
        `SELECT hs.account_id, hs.csrf_token, a.email, a.display_name
         FROM human_sessions hs
         JOIN accounts a ON a.id = hs.account_id
         WHERE hs.token_hash = ? AND hs.expires_at > ?`,
      )
      .get(tokenHash, database.now()) as
      | { account_id: string; csrf_token: string; email: string; display_name: string }
      | undefined;
    if (!row) throw new ApiError(401, "authentication_required", "Sign in is required.");
    return {
      accountId: row.account_id,
      email: row.email,
      displayName: row.display_name,
      csrfToken: row.csrf_token,
      sessionHash: tokenHash,
    };
  };

  const requireCsrf = (request: IncomingMessage, principal: HumanPrincipal): void => {
    const csrf = request.headers["x-meshr-csrf"];
    if (typeof csrf !== "string" || !constantTimeStringEqual(csrf, principal.csrfToken)) {
      throw new ApiError(403, "csrf_failed", "The CSRF token is missing or invalid.");
    }
  };

  const requirePairing = (request: IncomingMessage, id: string): PairingRow => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Pairing ")) {
      throw new ApiError(401, "pairing_authentication_required", "Pairing secret is required.");
    }
    const secret = authorization.slice("Pairing ".length).trim();
    const pairing = readPairing(db, id);
    if (!pairing || !constantTimeStringEqual(sha256(secret), pairing.secret_hash)) {
      throw new ApiError(401, "pairing_authentication_failed", "Pairing secret is invalid.");
    }
    return expirePendingPairing(pairing);
  };

  const requireAgent = (request: IncomingMessage): AgentPrincipal => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new ApiError(401, "agent_authentication_required", "Agent bearer token is required.");
    }
    const tokenHash = sha256(authorization.slice("Bearer ".length).trim());
    const now = database.now();
    const row = db
      .prepare(
        `SELECT s.agent_id, a.owner_account_id
         FROM agent_sessions s
         JOIN agents a ON a.id = s.agent_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now) as
      | { agent_id: string; owner_account_id: string }
      | undefined;
    if (!row) throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid.");
    db.prepare("UPDATE agent_sessions SET last_seen_at = ? WHERE token_hash = ?").run(
      now,
      tokenHash,
    );
    return {
      agentId: row.agent_id,
      ownerId: row.owner_account_id,
      sessionHash: tokenHash,
    };
  };

  const readWebMcpGrant = (
    request: IncomingMessage,
    human: HumanPrincipal,
  ): { grant: WebMcpGrantRow; agent: AgentRow } | null => {
    const token = parseCookies(request.headers.cookie).meshr_webmcp;
    if (!token) return null;
    const grant = db
      .prepare(
        `SELECT token_hash, human_session_hash, agent_id, created_at,
                expires_at, last_used_at, revoked_at
         FROM webmcp_grants
         WHERE token_hash = ? AND human_session_hash = ?
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(sha256(token), human.sessionHash, database.now()) as WebMcpGrantRow | undefined;
    if (!grant) return null;
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(grant.agent_id) as
      | (AgentRow & { public_key_pem: string })
      | undefined;
    if (!agent || agent.owner_account_id !== human.accountId) return null;
    return { grant, agent };
  };

  const requireWebMcp = (request: IncomingMessage): WebMcpPrincipal => {
    const human = requireHuman(request);
    const active = readWebMcpGrant(request, human);
    if (!active) {
      throw new ApiError(
        401,
        "webmcp_grant_required",
        "Enable WebMCP for one of your connected agents first.",
      );
    }
    const expectedAgentId = request.headers["x-meshr-webmcp-agent"];
    if (typeof expectedAgentId !== "string" || !expectedAgentId.trim()) {
      throw new ApiError(
        428,
        "webmcp_agent_precondition_required",
        "X-Meshr-WebMCP-Agent must identify the page-selected agent.",
      );
    }
    if (expectedAgentId.trim() !== active.agent.id) {
      throw new ApiError(
        409,
        "webmcp_agent_mismatch",
        "The page-selected agent no longer matches the active WebMCP grant.",
      );
    }
    const now = database.now();
    db.prepare("UPDATE webmcp_grants SET last_used_at = ? WHERE token_hash = ?").run(
      now,
      active.grant.token_hash,
    );
    return {
      agentId: active.agent.id,
      ownerId: active.agent.owner_account_id,
      sessionHash: active.grant.token_hash,
      human,
      grant: { ...active.grant, last_used_at: now },
      agent: active.agent,
    };
  };

  const assertCurrentAgentSession = (principal: AgentPrincipal): void => {
    const active = db
      .prepare(
        `SELECT 1 AS active
         FROM agent_sessions
         WHERE token_hash = ? AND agent_id = ? AND expires_at > ?`,
      )
      .get(principal.sessionHash, principal.agentId, database.now());
    if (!active) {
      throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid.");
    }
  };

  const currentAgentForCommit = (agentId: string): AgentRow => {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as unknown as
      | AgentRow
      | undefined;
    if (!agent) throw new ApiError(401, "agent_authentication_failed", "Agent no longer exists.");
    return agent;
  };

  const assertCurrentWebMcpGrant = (principal: WebMcpPrincipal): void => {
    const active = db
      .prepare(
        `SELECT 1 AS active
         FROM webmcp_grants wg
         JOIN human_sessions hs ON hs.token_hash = wg.human_session_hash
         JOIN agents a ON a.id = wg.agent_id
         WHERE wg.token_hash = ?
           AND wg.human_session_hash = ?
           AND wg.agent_id = ?
           AND wg.revoked_at IS NULL
           AND wg.expires_at > ?
           AND hs.token_hash = ?
           AND hs.account_id = ?
           AND hs.expires_at > ?
           AND a.owner_account_id = ?`,
      )
      .get(
        principal.sessionHash,
        principal.human.sessionHash,
        principal.agentId,
        database.now(),
        principal.human.sessionHash,
        principal.human.accountId,
        database.now(),
        principal.ownerId,
      );
    if (!active) {
      throw new ApiError(
        401,
        "webmcp_grant_required",
        "The WebMCP grant was revoked, expired, or switched before the action committed.",
      );
    }
  };

  const attentionFor = (agent: AgentRow): StoredAgentProfile["attention"] =>
    JSON.parse(agent.attention_json) as StoredAgentProfile["attention"];

  const requireBrowsePolicy = (agent: AgentRow): "public" | "joined" => {
    const browse = attentionFor(agent).browse;
    if (browse === "mentions") {
      throw new ApiError(
        403,
        "attention_policy_denied",
        "This agent only browses mentions, which page tools cannot scope yet.",
      );
    }
    return browse;
  };

  const requireAutonomousAttention = (
    agent: AgentRow,
    field: "rootPosts" | "replies",
  ): void => {
    const policy = attentionFor(agent)[field];
    if (policy === "autonomous") return;
    if (policy === "draft") {
      throw new ApiError(
        403,
        "attention_approval_required",
        `This agent's ${field} policy requires approval; page WebMCP cannot publish it autonomously.`,
      );
    }
    throw new ApiError(
      403,
      "attention_policy_denied",
      `This agent's ${field} policy does not allow publishing.`,
    );
  };

  const createHumanSession = (accountId: string) => {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const nowDate = database.clock.now();
    const now = nowDate.toISOString();
    const expiresAt = addSeconds(nowDate, HUMAN_SESSION_SECONDS);
    db.prepare(
      `INSERT INTO human_sessions(token_hash, account_id, csrf_token, created_at, expires_at)
       VALUES(?, ?, ?, ?, ?)`,
    ).run(sha256(token), accountId, csrfToken, now, expiresAt);
    return { token, csrfToken, expiresAt };
  };

  const ensureMeshAccess = (agentId: string, meshId: string) => {
    const mesh = db
      .prepare(
        `SELECT m.id, m.visibility,
                EXISTS(SELECT 1 FROM mesh_members mm WHERE mm.mesh_id = m.id AND mm.agent_id = ?) AS joined
         FROM meshes m WHERE m.id = ?`,
      )
      .get(agentId, meshId) as
      | { id: string; visibility: string; joined: number }
      | undefined;
    if (!mesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
    if (mesh.visibility !== "public" && mesh.joined !== 1) {
      throw new ApiError(403, "mesh_access_denied", "The agent cannot access this mesh.");
    }
    return mesh;
  };

  const ensureMeshMembership = (agentId: string, meshId: string): void => {
    const membership = db
      .prepare("SELECT 1 AS joined FROM mesh_members WHERE mesh_id = ? AND agent_id = ?")
      .get(meshId, agentId);
    if (!membership) {
      throw new ApiError(
        403,
        "mesh_membership_required",
        "The agent must join this mesh before participating.",
      );
    }
  };

  const ensureAttentionMeshAccess = (
    agent: AgentRow,
    agentId: string,
    meshId: string,
  ): { id: string; visibility: string; joined: number } => {
    const browse = requireBrowsePolicy(agent);
    const mesh = ensureMeshAccess(agentId, meshId);
    if (browse === "joined" && mesh.joined !== 1) {
      throw new ApiError(
        403,
        "attention_policy_denied",
        "This agent's browse policy is limited to joined meshes.",
      );
    }
    return mesh;
  };

  const ensureWebMcpMeshAccess = (
    principal: WebMcpPrincipal,
    meshId: string,
  ): { id: string; visibility: string; joined: number } =>
    ensureAttentionMeshAccess(principal.agent, principal.agentId, meshId);

  const webMcpTopicWithAccess = (principal: WebMcpPrincipal, topicId: string) => {
    const topic = db
      .prepare("SELECT id, mesh_id, name, title, description, tags_json FROM topics WHERE id = ?")
      .get(topicId) as
      | {
          id: string;
          mesh_id: string;
          name: string;
          title: string;
          description: string;
          tags_json: string;
        }
      | undefined;
    if (!topic) throw new ApiError(404, "topic_not_found", "Topic not found.");
    ensureWebMcpMeshAccess(principal, topic.mesh_id);
    return topic;
  };

  const topicWithAccess = (agentId: string, topicId: string) => {
    const topic = db
      .prepare("SELECT id, mesh_id, name, title, description, tags_json FROM topics WHERE id = ?")
      .get(topicId) as
      | {
          id: string;
          mesh_id: string;
          name: string;
          title: string;
          description: string;
          tags_json: string;
        }
      | undefined;
    if (!topic) throw new ApiError(404, "topic_not_found", "Topic not found.");
    ensureMeshAccess(agentId, topic.mesh_id);
    return topic;
  };

  const emitEvent = (
    type: string,
    agentId: string | null,
    meshId: string | null,
    topicId: string | null,
    data: unknown,
  ) => {
    const result = db
      .prepare(
        `INSERT INTO events(type, mesh_id, topic_id, agent_id, data_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(type, meshId, topicId, agentId, JSON.stringify(data), database.now());
    return Number(result.lastInsertRowid);
  };

  const updateAgentProfile = (
    agentId: string,
    input: Record<string, unknown>,
    authority: "agent-sync" | "owner-approval",
  ): AgentRow => {
    if (input.profile !== undefined) {
      for (const key of Object.keys(input)) {
        if (key !== "profile" && key !== "definitionDigest") {
          throw new ApiError(400, "invalid_profile", `${key} is not allowed.`);
        }
      }
    }
    const { definitionDigest: _definitionDigest, ...inlineProfile } = input;
    const profileInput = input.profile ?? inlineProfile;
    const profile = parseAgentProfile(profileInput, { partial: true });
    const definitionDigest = optionalString(input, "definitionDigest", 64)?.toLowerCase();
    if (definitionDigest !== undefined && !/^[a-f0-9]{64}$/.test(definitionDigest)) {
      throw new ApiError(
        400,
        "invalid_definition_digest",
        "definitionDigest must be a lowercase SHA-256 hex digest.",
      );
    }
    if (Object.keys(profile).length === 0 && definitionDigest === undefined) {
      throw new ApiError(400, "invalid_profile", "At least one profile field is required.");
    }

    const currentRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as
      | AgentRow
      | undefined;
    if (!currentRow) throw new ApiError(404, "agent_not_found", "Agent not found.");
    const current = agentFromRow(currentRow);
    const merged = completeProfile({
      name: profile.name ?? current.name,
      handle: profile.handle ?? current.handle,
      tagline: profile.tagline ?? current.tagline,
      interests: profile.interests ?? current.interests,
      personality: profile.personality ?? current.personality,
      attention: { ...current.attention, ...(profile.attention ?? {}) },
    });

    if (authority === "agent-sync") {
      const approvalRequired: string[] = [];
      if (merged.name !== current.name) approvalRequired.push("name");
      if (merged.handle !== current.handle) approvalRequired.push("handle");
      if (
        browseRestriction[merged.attention.browse] <
        browseRestriction[current.attention.browse]
      ) {
        approvalRequired.push("attention.browse");
      }
      for (const field of ["rootPosts", "replies"] as const) {
        if (
          participationRestriction[merged.attention[field]] <
          participationRestriction[current.attention[field]]
        ) {
          approvalRequired.push(`attention.${field}`);
        }
      }
      if (approvalRequired.length > 0) {
        throw new ApiError(
          403,
          "profile_approval_required",
          `Owner approval is required to change ${approvalRequired.join(", ")}.`,
        );
      }
    }

    const now = database.now();
    try {
      db.prepare(
        `UPDATE agents SET
           name = ?, handle = ?, tagline = ?, interests_json = ?, personality = ?,
           attention_json = ?, definition_digest = COALESCE(?, definition_digest), updated_at = ?
         WHERE id = ?`,
      ).run(
        merged.name,
        merged.handle,
        merged.tagline,
        JSON.stringify(merged.interests),
        merged.personality,
        JSON.stringify(merged.attention),
        definitionDigest ?? null,
        now,
        agentId,
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new ApiError(409, "handle_unavailable", "That agent handle is already in use.");
      }
      throw error;
    }
    emitEvent("agent.profile.updated", agentId, null, null, {
      agentId,
      authority,
    });
    return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as unknown as AgentRow;
  };

  const idempotent = (
    principal: AgentPrincipal,
    operation: string,
    key: string,
    requestValue: unknown,
    action: () => { status: number; body: unknown },
    authorizeCommit?: () => void,
  ): { status: number; body: unknown } => {
    const requestHash = sha256(JSON.stringify(requestValue));
    return database.transaction(() => {
      // Authentication is deliberately rechecked after BEGIN IMMEDIATE. This
      // serializes the check with grant/session revocation and identity switches,
      // so an admitted request cannot commit under authority that disappeared
      // while its body was being read or validated.
      authorizeCommit?.();
      const existing = db
        .prepare(
          `SELECT request_hash, response_status, response_json
           FROM idempotency_records
           WHERE agent_id = ? AND operation = ? AND idempotency_key = ?`,
        )
        .get(principal.agentId, operation, key) as
        | { request_hash: string; response_status: number; response_json: string }
        | undefined;
      if (existing) {
        if (!constantTimeStringEqual(existing.request_hash, requestHash)) {
          throw new ApiError(
            409,
            "idempotency_conflict",
            "This idempotency key was already used for a different request.",
          );
        }
        return {
          status: existing.response_status,
          body: JSON.parse(existing.response_json) as unknown,
        };
      }
      const result = action();
      db.prepare(
        `INSERT INTO idempotency_records(
           agent_id, operation, idempotency_key, request_hash,
           response_status, response_json, created_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        principal.agentId,
        operation,
        key,
        requestHash,
        result.status,
        JSON.stringify(result.body),
        database.now(),
      );
      return result;
    });
  };

  const route = async (request: IncomingMessage, url: URL): Promise<RouteResult> => {
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/healthz") {
      const migration = db
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number };
      return {
        body: { status: "ok", database: "ok", schemaVersion: migration.version },
      };
    }

    if (method === "POST" && path === "/v1/accounts") {
      const input = asObject(await readJson(request));
      const email = normalizeEmail(requiredString(input, "email", { max: 254 }));
      const password = requiredString(input, "password", { min: 12, max: 256 });
      const displayName = requiredString(input, "displayName", { max: 80 });
      const passwordHash = await hashPassword(password);
      const account: AccountRow = {
        id: database.id("usr"),
        email,
        display_name: displayName,
        password_hash: passwordHash,
        created_at: database.now(),
      };
      try {
        db.prepare(
          `INSERT INTO accounts(id, email, display_name, password_hash, created_at)
           VALUES(?, ?, ?, ?, ?)`,
        ).run(
          account.id,
          account.email,
          account.display_name,
          account.password_hash,
          account.created_at,
        );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new ApiError(409, "account_exists", "An account already exists for this email.");
        }
        throw error;
      }
      const session = createHumanSession(account.id);
      return {
        status: 201,
        headers: { "Set-Cookie": sessionCookie(session.token, secureCookies) },
        body: {
          user: publicUser(account),
          csrfToken: session.csrfToken,
          sessionExpiresAt: session.expiresAt,
        },
      };
    }

    if (method === "POST" && path === "/v1/sessions") {
      const input = asObject(await readJson(request));
      const email = normalizeEmail(requiredString(input, "email", { max: 254 }));
      const password = requiredString(input, "password", { min: 1, max: 256 });
      const account = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as
        | AccountRow
        | undefined;
      const valid = account
        ? await verifyPassword(password, account.password_hash)
        : (await hashPassword(password), false);
      if (!account || !valid) {
        throw new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
      }
      const session = createHumanSession(account.id);
      return {
        headers: { "Set-Cookie": sessionCookie(session.token, secureCookies) },
        body: {
          user: publicUser(account),
          csrfToken: session.csrfToken,
          sessionExpiresAt: session.expiresAt,
        },
      };
    }

    if (method === "GET" && path === "/v1/me") {
      const principal = requireHuman(request);
      const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(principal.accountId) as
        | AccountRow
        | undefined;
      if (!account) throw new ApiError(401, "authentication_required", "Sign in is required.");
      return { body: { user: publicUser(account), csrfToken: principal.csrfToken } };
    }

    if (method === "GET" && path === "/v1/agents") {
      const principal = requireHuman(request);
      const rows = db
        .prepare(
          `SELECT a.*,
             (SELECT MAX(s.last_seen_at) FROM agent_sessions s WHERE s.agent_id = a.id) AS last_seen_at,
             EXISTS(
               SELECT 1 FROM agent_sessions s
               WHERE s.agent_id = a.id AND s.expires_at > ?
             ) AS connected
           FROM agents a
           WHERE a.owner_account_id = ?
           ORDER BY a.created_at ASC, a.id ASC`,
        )
        .all(database.now(), principal.accountId) as unknown as Array<
        AgentRow & { last_seen_at: string | null; connected: number }
      >;
      return {
        body: {
          agents: rows.map((row) => ({
            ...agentFromRow(row),
            connectionStatus: row.connected ? "connected" : "offline",
            lastSeenAt: row.last_seen_at,
          })),
        },
      };
    }

    const ownerProfileMatch = matchingPath(path, /^\/v1\/agents\/([^/]+)\/profile$/);
    if (method === "PUT" && ownerProfileMatch) {
      const principal = requireHuman(request);
      requireCsrf(request, principal);
      const agentId = decodeURIComponent(ownerProfileMatch[1]);
      const owned = db
        .prepare("SELECT 1 AS owned FROM agents WHERE id = ? AND owner_account_id = ?")
        .get(agentId, principal.accountId);
      if (!owned) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      const profileInput = asObject(await readJson(request));
      const updated = database.transaction(() =>
        updateAgentProfile(agentId, profileInput, "owner-approval"),
      );
      return { body: { agent: agentFromRow(updated) } };
    }

    const bindingMatch = matchingPath(path, /^\/v1\/agents\/([^/]+)\/binding$/);
    if (method === "DELETE" && bindingMatch) {
      const principal = requireHuman(request);
      requireCsrf(request, principal);
      const agentId = decodeURIComponent(bindingMatch[1]);
      const owned = db
        .prepare("SELECT 1 AS owned FROM agents WHERE id = ? AND owner_account_id = ?")
        .get(agentId, principal.accountId);
      if (!owned) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      const now = database.now();
      const revoked = database.transaction(() => {
        const pairings = db
          .prepare(
            `UPDATE pairings SET status = 'revoked'
             WHERE agent_id = ? AND owner_account_id = ?
               AND status IN ('approved', 'claimed')`,
          )
          .run(agentId, principal.accountId);
        const sessions = db.prepare("DELETE FROM agent_sessions WHERE agent_id = ?").run(agentId);
        const pageGrants = db
          .prepare(
            `UPDATE webmcp_grants SET revoked_at = ?
             WHERE agent_id = ? AND revoked_at IS NULL`,
          )
          .run(now, agentId);
        if (pairings.changes > 0 || sessions.changes > 0 || pageGrants.changes > 0) {
          emitEvent("agent.disconnected", agentId, null, null, { agentId });
        }
        return {
          pairings: Number(pairings.changes),
          sessions: Number(sessions.changes),
          pageGrants: Number(pageGrants.changes),
        };
      });
      return {
        body: {
          agentId,
          revoked: true,
          revokedPairings: revoked.pairings,
          revokedSessions: revoked.sessions,
          revokedPageGrants: revoked.pageGrants,
        },
      };
    }

    if (method === "GET" && path === "/v1/webmcp/session") {
      const human = requireHuman(request);
      const active = readWebMcpGrant(request, human);
      if (!active) {
        return {
          body: { enabled: false, agent: null, createdAt: null, expiresAt: null },
          headers: { "Set-Cookie": clearWebMcpCookie(secureCookies) },
        };
      }
      return {
        body: {
          enabled: true,
          agent: agentFromRow(active.agent),
          createdAt: active.grant.created_at,
          expiresAt: active.grant.expires_at,
        },
      };
    }

    if (method === "POST" && path === "/v1/webmcp/session") {
      const human = requireHuman(request);
      requireCsrf(request, human);
      const input = asObject(await readJson(request));
      for (const field of Object.keys(input)) {
        if (field !== "agentId") {
          throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
        }
      }
      const agentId = requiredString(input, "agentId", { max: 128 });
      const agent = db
        .prepare("SELECT * FROM agents WHERE id = ? AND owner_account_id = ?")
        .get(agentId, human.accountId) as (AgentRow & { public_key_pem: string }) | undefined;
      if (!agent) {
        throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      }
      const connected = db
        .prepare(
          `SELECT 1 AS connected FROM agent_sessions
           WHERE agent_id = ? AND expires_at > ? LIMIT 1`,
        )
        .get(agent.id, database.now());
      if (!connected) {
        throw new ApiError(
          409,
          "agent_not_connected",
          "Only a connected agent can be enabled for page WebMCP.",
        );
      }
      const token = randomToken();
      const tokenHash = sha256(token);
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, WEBMCP_GRANT_SECONDS);
      database.transaction(() => {
        db.prepare(
          `UPDATE webmcp_grants SET revoked_at = ?
           WHERE human_session_hash = ? AND revoked_at IS NULL`,
        ).run(now, human.sessionHash);
        db.prepare(
          `INSERT INTO webmcp_grants(
             token_hash, human_session_hash, agent_id, created_at,
             expires_at, last_used_at, revoked_at
           ) VALUES(?, ?, ?, ?, ?, ?, NULL)`,
        ).run(tokenHash, human.sessionHash, agent.id, now, expiresAt, now);
      });
      return {
        status: 201,
        headers: { "Set-Cookie": webMcpCookie(token, secureCookies) },
        body: {
          enabled: true,
          agent: agentFromRow(agent),
          createdAt: now,
          expiresAt,
        },
      };
    }

    if (method === "DELETE" && path === "/v1/webmcp/session") {
      const human = requireHuman(request);
      requireCsrf(request, human);
      db.prepare(
        `UPDATE webmcp_grants SET revoked_at = ?
         WHERE human_session_hash = ? AND revoked_at IS NULL`,
      ).run(database.now(), human.sessionHash);
      return {
        body: { enabled: false, agent: null, createdAt: null, expiresAt: null },
        headers: { "Set-Cookie": clearWebMcpCookie(secureCookies) },
      };
    }

    if (method === "GET" && path === "/v1/activity/public") {
      const principal = requireHuman(request);
      return {
        body: readPublicActivity(db, principal.accountId, database.now()),
      };
    }

    if (method === "DELETE" && path === "/v1/session") {
      const principal = requireHuman(request);
      requireCsrf(request, principal);
      db.prepare("DELETE FROM human_sessions WHERE token_hash = ?").run(principal.sessionHash);
      return {
        body: { signedOut: true },
        headers: {
          "Set-Cookie": [
            clearSessionCookie(secureCookies),
            clearWebMcpCookie(secureCookies),
          ],
        },
      };
    }

    if (method === "POST" && path === "/v1/pairings") {
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (
          !new Set([
            "runtime",
            "label",
            "externalSubject",
            "publicKey",
            "profile",
            "definitionDigest",
          ]).has(key)
        ) {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const runtime = parseRuntime(input.runtime);
      const label = requiredString(input, "label", { max: 100 });
      const externalSubject =
        optionalString(input, "externalSubject", 256) || `${runtime}:${label}`;
      const publicKey = requiredString(input, "publicKey", { max: 8_192 });
      try {
        assertEd25519PublicKey(publicKey);
      } catch {
        throw new ApiError(400, "invalid_public_key", "publicKey must be an Ed25519 public key.");
      }
      const requestedProfile =
        input.profile === undefined
          ? null
          : (parseAgentProfile(input.profile) as AgentProfileInput);
      const definitionDigest = optionalString(input, "definitionDigest", 64)?.toLowerCase();
      if (definitionDigest !== undefined && !/^[a-f0-9]{64}$/.test(definitionDigest)) {
        throw new ApiError(
          400,
          "invalid_definition_digest",
          "definitionDigest must be a lowercase SHA-256 hex digest.",
        );
      }
      const id = database.id("pair");
      const secret = randomToken();
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, PAIRING_SECONDS);
      let code = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const bytes = Buffer.from(randomToken(8), "base64url");
        const symbols = Array.from(bytes.subarray(0, 8), (byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]);
        code = `${symbols.slice(0, 4).join("")}-${symbols.slice(4, 8).join("")}`;
        const collision = db.prepare("SELECT 1 AS found FROM pairings WHERE code = ?").get(code);
        if (!collision) break;
        code = "";
      }
      if (!code) throw new ApiError(503, "pairing_unavailable", "Could not allocate a pairing code.");
      db.prepare(
        `INSERT INTO pairings(
           id, code, secret_hash, runtime, runtime_label, external_subject, public_key_pem,
           requested_profile_json, definition_digest, status, created_at, expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        code,
        sha256(secret),
        runtime,
        label,
        externalSubject,
        publicKey,
        requestedProfile ? JSON.stringify(requestedProfile) : null,
        definitionDigest ?? null,
        now,
        expiresAt,
      );
      const verificationUri = publicWebUrl ? new URL(publicWebUrl) : undefined;
      verificationUri?.searchParams.set("code", code);
      return {
        status: 201,
        body: {
          pairingId: id,
          code,
          pairingSecret: secret,
          status: "pending",
          expiresAt,
          ...(verificationUri ? { verificationUri: verificationUri.toString() } : {}),
        },
      };
    }

    const pairingStatusMatch = matchingPath(path, /^\/v1\/pairings\/([^/]+)$/);
    if (method === "GET" && pairingStatusMatch && path !== "/v1/pairings/lookup") {
      const id = decodeURIComponent(pairingStatusMatch[1]);
      const pairing = requirePairing(request, id);
      const representation = pairingRepresentation(pairing);
      const activeSession =
        pairing.status === "claimed" && pairing.agent_id
          ? db
              .prepare(
                `SELECT 1 AS active FROM agent_sessions
                 WHERE pairing_id = ? AND agent_id = ? AND expires_at > ? LIMIT 1`,
              )
              .get(pairing.id, pairing.agent_id, database.now())
          : undefined;
      const connectionStatus =
        pairing.status === "claimed"
          ? activeSession
            ? "connected"
            : "approved"
          : pairing.status;
      return {
        body: {
          pairingId: pairing.id,
          bindingId:
            connectionStatus === "approved" || connectionStatus === "connected"
              ? pairing.id
              : null,
          status: connectionStatus,
          agentId: pairing.agent_id,
          expiresAt: pairing.expires_at,
          pairing: representation,
        },
      };
    }

    if (method === "GET" && path === "/v1/pairings/lookup") {
      requireHuman(request);
      const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
      if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
        throw new ApiError(400, "invalid_pairing_code", "Pairing code is invalid.");
      }
      const found = db.prepare("SELECT * FROM pairings WHERE code = ?").get(code) as
        | PairingRow
        | undefined;
      if (!found) throw new ApiError(404, "pairing_not_found", "Pairing not found.");
      const pairing = expirePendingPairing(found);
      return { body: { pairing: pairingRepresentation(pairing) } };
    }

    const approveMatch = matchingPath(path, /^\/v1\/pairings\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) {
      const principal = requireHuman(request);
      requireCsrf(request, principal);
      const id = decodeURIComponent(approveMatch[1]);
      const found = readPairing(db, id);
      if (!found) throw new ApiError(404, "pairing_not_found", "Pairing not found.");
      const pairing = expirePendingPairing(found);
      if (pairing.status !== "pending") {
        if (
          (pairing.status === "approved" || pairing.status === "claimed") &&
          pairing.owner_account_id === principal.accountId &&
          pairing.agent_id
        ) {
          const existingAgent = db
            .prepare("SELECT * FROM agents WHERE id = ?")
            .get(pairing.agent_id) as unknown as AgentRow;
          return {
            body: {
              pairing: pairingRepresentation(pairing),
              agent: agentFromRow(existingAgent),
            },
          };
        }
        throw new ApiError(409, "pairing_not_pending", "Pairing is no longer pending.");
      }
      const input = asObject(await readJson(request));
      const rawProfile = input.profile ??
        (pairing.requested_profile_json
          ? (JSON.parse(pairing.requested_profile_json) as unknown)
          : undefined);
      if (!rawProfile) {
        throw new ApiError(400, "profile_required", "An agent profile is required to approve pairing.");
      }
      const profile = completeProfile(parseAgentProfile(rawProfile) as AgentProfileInput);
      const now = database.now();
      let agentId = database.id("agt");
      try {
        database.transaction(() => {
          const matchingAgent = db
            .prepare("SELECT * FROM agents WHERE handle = ?")
            .get(profile.handle) as unknown as AgentRow | undefined;
          if (matchingAgent && matchingAgent.owner_account_id !== principal.accountId) {
            throw new ApiError(409, "handle_unavailable", "That agent handle is already in use.");
          }
          if (matchingAgent) {
            // A handle is the stable, human-approved identity key. Approving a
            // fresh pairing for an identity owned by this same human replaces
            // its runtime binding instead of minting a duplicate agent.
            agentId = matchingAgent.id;
            db.prepare(
              `UPDATE pairings SET status = 'revoked'
               WHERE agent_id = ? AND id <> ?
                 AND status IN ('approved', 'claimed')`,
            ).run(agentId, pairing.id);
            db.prepare("DELETE FROM agent_sessions WHERE agent_id = ?").run(agentId);
            db.prepare(
              `UPDATE webmcp_grants SET revoked_at = ?
               WHERE agent_id = ? AND revoked_at IS NULL`,
            ).run(now, agentId);
            db.prepare(
              `UPDATE agents SET
                 name = ?, handle = ?, tagline = ?, interests_json = ?, personality = ?,
                 attention_json = ?, runtime = ?, runtime_label = ?, runtime_subject = ?,
                 public_key_pem = ?,
                 definition_digest = COALESCE(?, definition_digest), updated_at = ?
               WHERE id = ? AND owner_account_id = ?`,
            ).run(
              profile.name,
              profile.handle,
              profile.tagline,
              JSON.stringify(profile.interests),
              profile.personality,
              JSON.stringify(profile.attention),
              pairing.runtime,
              pairing.runtime_label,
              pairing.external_subject,
              pairing.public_key_pem,
              pairing.definition_digest,
              now,
              agentId,
              principal.accountId,
            );
          } else {
            db.prepare(
              `INSERT INTO agents(
                 id, owner_account_id, name, handle, tagline, interests_json,
                 personality, attention_json, runtime, runtime_label, runtime_subject,
                 public_key_pem, definition_digest, created_at, updated_at
               ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              agentId,
              principal.accountId,
              profile.name,
              profile.handle,
              profile.tagline,
              JSON.stringify(profile.interests),
              profile.personality,
              JSON.stringify(profile.attention),
              pairing.runtime,
              pairing.runtime_label,
              pairing.external_subject,
              pairing.public_key_pem,
              pairing.definition_digest,
              now,
              now,
            );
          }
          const updated = db.prepare(
            `UPDATE pairings
             SET status = 'approved', owner_account_id = ?, agent_id = ?, approved_at = ?
             WHERE id = ? AND status = 'pending'`,
          ).run(principal.accountId, agentId, now, pairing.id);
          if (updated.changes !== 1) {
            throw new ApiError(409, "pairing_not_pending", "Pairing is no longer pending.");
          }
          db.prepare(
            `INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at)
             VALUES('mesh-public', ?, ?)`,
          ).run(agentId, now);
          emitEvent("agent.binding.approved", agentId, "mesh-public", null, {
            agentId,
            bindingId: pairing.id,
            replacedBinding: Boolean(matchingAgent),
          });
        });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new ApiError(409, "handle_unavailable", "That agent handle is already in use.");
        }
        throw error;
      }
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as unknown as AgentRow;
      return {
        body: {
          pairing: pairingRepresentation({
            ...pairing,
            status: "approved",
            owner_account_id: principal.accountId,
            agent_id: agentId,
            approved_at: now,
          }),
          agent: agentFromRow(agent),
        },
      };
    }

    const challengeMatch = matchingPath(path, /^\/v1\/pairings\/([^/]+)\/challenges$/);
    if (method === "POST" && challengeMatch) {
      const id = decodeURIComponent(challengeMatch[1]);
      const pairing = requirePairing(request, id);
      if (pairing.status !== "approved" && pairing.status !== "claimed") {
        throw new ApiError(409, "pairing_not_approved", "Pairing has not been approved.");
      }
      const challengeId = database.id("chal");
      const nonce = randomToken();
      const message = `meshr-agent-session:v1:${pairing.id}:${challengeId}:${nonce}`;
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, CHALLENGE_SECONDS);
      db.prepare(
        `INSERT INTO pairing_challenges(id, pairing_id, message, created_at, expires_at)
         VALUES(?, ?, ?, ?, ?)`,
      ).run(challengeId, pairing.id, message, now, expiresAt);
      return { status: 201, body: { challengeId, challenge: nonce, message, expiresAt } };
    }

    if (method === "POST" && path === "/v1/agent-sessions") {
      const input = asObject(await readJson(request));
      const pairingId = requiredString(input, "pairingId", { max: 128 });
      const challengeId = requiredString(input, "challengeId", { max: 128 });
      const signature = requiredString(input, "signature", {
        max: 256,
        pattern: /^[A-Za-z0-9_-]+$/,
      });
      const pairing = requirePairing(request, pairingId);
      if ((pairing.status !== "approved" && pairing.status !== "claimed") || !pairing.agent_id) {
        throw new ApiError(409, "pairing_not_approved", "Pairing has not been approved.");
      }
      const challenge = db
        .prepare(
          `SELECT id, pairing_id, message, expires_at, used_at
           FROM pairing_challenges WHERE id = ? AND pairing_id = ?`,
        )
        .get(challengeId, pairing.id) as
        | { id: string; pairing_id: string; message: string; expires_at: string; used_at: string | null }
        | undefined;
      if (
        !challenge ||
        challenge.used_at ||
        Date.parse(challenge.expires_at) <= database.clock.now().getTime()
      ) {
        throw new ApiError(401, "challenge_invalid", "Challenge is missing, expired, or already used.");
      }
      if (!verifyEd25519Signature(pairing.public_key_pem, challenge.message, signature)) {
        throw new ApiError(401, "signature_invalid", "Challenge signature is invalid.");
      }
      const token = randomToken();
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, AGENT_SESSION_SECONDS);
      database.transaction(() => {
        const currentPairing = db
          .prepare("SELECT status, agent_id FROM pairings WHERE id = ?")
          .get(pairing.id) as
          | { status: PairingRow["status"]; agent_id: string | null }
          | undefined;
        if (
          !currentPairing ||
          (currentPairing.status !== "approved" && currentPairing.status !== "claimed") ||
          currentPairing.agent_id !== pairing.agent_id
        ) {
          throw new ApiError(409, "pairing_not_approved", "Pairing has not been approved.");
        }
        const consumed = db
          .prepare("UPDATE pairing_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL")
          .run(now, challenge.id);
        if (consumed.changes !== 1) {
          throw new ApiError(401, "challenge_invalid", "Challenge was already used.");
        }
        db.prepare(
          `INSERT INTO agent_sessions(
             token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at
           ) VALUES(?, ?, ?, ?, ?, ?)`,
        ).run(sha256(token), pairing.agent_id, pairing.id, now, expiresAt, now);
        db.prepare(
          `UPDATE pairings
           SET status = 'claimed', claimed_at = COALESCE(claimed_at, ?)
           WHERE id = ? AND status IN ('approved', 'claimed')`,
        ).run(now, pairing.id);
        emitEvent("agent.connected", pairing.agent_id, "mesh-public", null, {
          agentId: pairing.agent_id,
          bindingId: pairing.id,
        });
      });
      const agent = db
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(pairing.agent_id) as unknown as AgentRow;
      return {
        status: 201,
        body: {
          token,
          tokenType: "Bearer",
          bindingId: pairing.id,
          expiresAt,
          agent: agentFromRow(agent),
        },
      };
    }

    if (method === "GET" && path === "/v1/public/meshes") {
      const meshes = db
        .prepare(
          `SELECT id, name, description, visibility, join_policy, created_at
           FROM meshes WHERE visibility = 'public' ORDER BY name, id`,
        )
        .all()
        .map((row) => {
          const mesh = row as Record<string, string>;
          return {
            id: mesh.id,
            name: mesh.name,
            description: mesh.description,
            visibility: mesh.visibility,
            joinPolicy: mesh.join_policy,
            createdAt: mesh.created_at,
          };
        });
      return { body: { meshes } };
    }

    const publicTopicsMatch = matchingPath(path, /^\/v1\/public\/meshes\/([^/]+)\/topics$/);
    if (method === "GET" && publicTopicsMatch) {
      const meshId = decodeURIComponent(publicTopicsMatch[1]);
      const mesh = db
        .prepare("SELECT id FROM meshes WHERE id = ? AND visibility = 'public'")
        .get(meshId);
      if (!mesh) throw new ApiError(404, "mesh_not_found", "Public mesh not found.");
      const topics = db
        .prepare(
          `SELECT id, mesh_id, name, title, description, tags_json, created_at
           FROM topics WHERE mesh_id = ? ORDER BY title, id`,
        )
        .all(meshId)
        .map((raw) => {
          const row = raw as Record<string, string>;
          return {
            id: row.id,
            meshId: row.mesh_id,
            name: row.name,
            title: row.title,
            description: row.description,
            tags: JSON.parse(row.tags_json) as string[],
            createdAt: row.created_at,
          };
        });
      return { body: { topics } };
    }

    if (path.startsWith("/v1/webmcp/")) {
      const principal = requireWebMcp(request);

      if (method === "GET" && path === "/v1/webmcp/profile") {
        return {
          body: {
            agent: agentFromRow(principal.agent),
            pageGrant: {
              createdAt: principal.grant.created_at,
              expiresAt: principal.grant.expires_at,
            },
          },
        };
      }

      if (method === "GET" && path === "/v1/webmcp/meshes") {
        const browse = requireBrowsePolicy(principal.agent);
        const browseClause =
          browse === "joined"
            ? `EXISTS(SELECT 1 FROM mesh_members mm
                       WHERE mm.mesh_id = m.id AND mm.agent_id = ?)`
            : `(m.visibility = 'public'
                OR EXISTS(SELECT 1 FROM mesh_members mm
                          WHERE mm.mesh_id = m.id AND mm.agent_id = ?))`;
        const meshes = db
          .prepare(
            `SELECT m.id, m.name, m.description, m.visibility, m.join_policy, m.created_at,
                    EXISTS(SELECT 1 FROM mesh_members mm
                           WHERE mm.mesh_id = m.id AND mm.agent_id = ?) AS joined
             FROM meshes m
             WHERE ${browseClause}
             ORDER BY m.name, m.id`,
          )
          .all(principal.agentId, principal.agentId)
          .map((raw) => {
            const row = raw as Record<string, string | number>;
            return {
              id: row.id,
              name: row.name,
              description: row.description,
              visibility: row.visibility,
              joinPolicy: row.join_policy,
              joined: row.joined === 1,
              createdAt: row.created_at,
            };
          });
        return { body: { meshes } };
      }

      if (method === "GET" && path === "/v1/webmcp/activity") {
        const browse = requireBrowsePolicy(principal.agent);
        const rawMeshId = url.searchParams.get("meshId");
        let meshId: string | undefined;
        if (rawMeshId !== null) {
          meshId = rawMeshId.trim();
          if (!meshId || meshId.length > 128) {
            throw new ApiError(400, "invalid_request", "meshId is invalid.");
          }
          ensureWebMcpMeshAccess(principal, meshId);
        }
        return {
          body: readWebMcpActivity(db, {
            agentId: principal.agentId,
            browse,
            generatedAt: database.now(),
            meshId,
          }),
        };
      }

      const webMcpReadPostsMatch = matchingPath(
        path,
        /^\/v1\/webmcp\/topics\/([^/]+)\/posts$/,
      );
      if (method === "GET" && webMcpReadPostsMatch) {
        const topicId = decodeURIComponent(webMcpReadPostsMatch[1]);
        webMcpTopicWithAccess(principal, topicId);
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 10, 25, 1);
        const rows = db
          .prepare(
            `SELECT recent.*, a.name AS agent_name, a.handle AS agent_handle
             FROM (
               SELECT p.* FROM posts p
               WHERE p.topic_id = ?
               ORDER BY p.created_at DESC, p.id DESC LIMIT ?
             ) recent
             JOIN agents a ON a.id = recent.agent_id
             ORDER BY recent.created_at ASC, recent.id ASC`,
          )
          .all(topicId, limit) as unknown as Array<Record<string, string | null>>;
        return {
          body: {
            posts: rows.map((row) => ({
              id: row.id,
              meshId: row.mesh_id,
              topicId: row.topic_id,
              agentId: row.agent_id,
              parentPostId: row.parent_post_id,
              body: row.body,
              createdAt: row.created_at,
              agent: {
                id: row.agent_id,
                name: row.agent_name,
                handle: row.agent_handle,
              },
            })),
          },
        };
      }

      if (method === "POST" && path === "/v1/webmcp/posts") {
        requireCsrf(request, principal.human);
        requireAutonomousAttention(principal.agent, "rootPosts");
        const input = asObject(await readJson(request));
        for (const field of Object.keys(input)) {
          if (!new Set(["meshId", "topicId", "body"]).has(field)) {
            throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
          }
        }
        const key = requireIdempotencyKey(request);
        const meshId = requiredString(input, "meshId", { max: 128 });
        const topicId = requiredString(input, "topicId", { max: 128 });
        const body = requiredString(input, "body", { max: 1_200 });
        ensureMeshAccess(principal.agentId, meshId);
        ensureMeshMembership(principal.agentId, meshId);
        const topic = topicWithAccess(principal.agentId, topicId);
        if (topic.mesh_id !== meshId) {
          throw new ApiError(400, "topic_mesh_mismatch", "Topic does not belong to this mesh.");
        }
        return idempotent(principal, "post.create", key, input, () => {
          const post = {
            id: database.id("post"),
            meshId,
            topicId,
            agentId: principal.agentId,
            parentPostId: null,
            body,
            createdAt: database.now(),
          };
          db.prepare(
            `INSERT INTO posts(id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at)
             VALUES(?, ?, ?, ?, NULL, ?, ?)`,
          ).run(post.id, meshId, topicId, principal.agentId, body, post.createdAt);
          emitEvent("post.created", principal.agentId, meshId, topicId, { post });
          return { status: 201, body: { post } };
        }, () => {
          assertCurrentWebMcpGrant(principal);
          requireAutonomousAttention(currentAgentForCommit(principal.agentId), "rootPosts");
          ensureMeshAccess(principal.agentId, meshId);
          ensureMeshMembership(principal.agentId, meshId);
        });
      }

      const webMcpReplyMatch = matchingPath(
        path,
        /^\/v1\/webmcp\/posts\/([^/]+)\/replies$/,
      );
      if (method === "POST" && webMcpReplyMatch) {
        requireCsrf(request, principal.human);
        requireAutonomousAttention(principal.agent, "replies");
        const parentId = decodeURIComponent(webMcpReplyMatch[1]);
        const input = asObject(await readJson(request));
        for (const field of Object.keys(input)) {
          if (field !== "body") {
            throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
          }
        }
        const key = requireIdempotencyKey(request);
        const body = requiredString(input, "body", { max: 1_200 });
        const parent = db
          .prepare("SELECT id, mesh_id, topic_id FROM posts WHERE id = ?")
          .get(parentId) as { id: string; mesh_id: string; topic_id: string } | undefined;
        if (!parent) throw new ApiError(404, "post_not_found", "Post not found.");
        ensureMeshAccess(principal.agentId, parent.mesh_id);
        ensureMeshMembership(principal.agentId, parent.mesh_id);
        const requestValue = { parentPostId: parentId, body };
        return idempotent(principal, "reply.create", key, requestValue, () => {
          const post = {
            id: database.id("post"),
            meshId: parent.mesh_id,
            topicId: parent.topic_id,
            agentId: principal.agentId,
            parentPostId: parent.id,
            body,
            createdAt: database.now(),
          };
          db.prepare(
            `INSERT INTO posts(id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            post.id,
            post.meshId,
            post.topicId,
            post.agentId,
            post.parentPostId,
            post.body,
            post.createdAt,
          );
          emitEvent("reply.created", principal.agentId, post.meshId, post.topicId, { post });
          return { status: 201, body: { post } };
        }, () => {
          assertCurrentWebMcpGrant(principal);
          requireAutonomousAttention(currentAgentForCommit(principal.agentId), "replies");
          ensureMeshAccess(principal.agentId, parent.mesh_id);
          ensureMeshMembership(principal.agentId, parent.mesh_id);
        });
      }

      const webMcpFollowMatch = matchingPath(
        path,
        /^\/v1\/webmcp\/topics\/([^/]+)\/follow$/,
      );
      if (method === "PUT" && webMcpFollowMatch) {
        requireCsrf(request, principal.human);
        const topicId = decodeURIComponent(webMcpFollowMatch[1]);
        const key = requireIdempotencyKey(request);
        const topic = webMcpTopicWithAccess(principal, topicId);
        ensureMeshMembership(principal.agentId, topic.mesh_id);
        return idempotent(
          principal,
          "topic.follow",
          key,
          { topicId, following: true },
          () => {
            db.prepare(
              `INSERT OR IGNORE INTO follows(topic_id, agent_id, created_at) VALUES(?, ?, ?)`,
            ).run(topicId, principal.agentId, database.now());
            emitEvent("topic.followed", principal.agentId, topic.mesh_id, topicId, {
              topicId,
              following: true,
            });
            return { status: 200, body: { topicId, following: true } };
          },
          () => {
            assertCurrentWebMcpGrant(principal);
            ensureAttentionMeshAccess(
              currentAgentForCommit(principal.agentId),
              principal.agentId,
              topic.mesh_id,
            );
            ensureMeshMembership(principal.agentId, topic.mesh_id);
          },
        );
      }

      const webMcpTrafficMatch = matchingPath(
        path,
        /^\/v1\/webmcp\/meshes\/([^/]+)\/traffic\/([^/]+)$/,
      );
      if (method === "GET" && webMcpTrafficMatch) {
        const meshId = decodeURIComponent(webMcpTrafficMatch[1]);
        const linkId = decodeURIComponent(webMcpTrafficMatch[2]);
        const browse = requireBrowsePolicy(principal.agent);
        ensureWebMcpMeshAccess(principal, meshId);
        const activity = readWebMcpActivity(db, {
          agentId: principal.agentId,
          browse,
          generatedAt: database.now(),
          meshId,
        });
        const link = activity.meshes
          .flatMap((mesh) => mesh.trafficLinks)
          .find((candidate) => candidate.id === linkId);
        if (!link) {
          throw new ApiError(
            404,
            "traffic_link_not_found",
            "Traffic link is not available to this session.",
          );
        }
        const readAgent = (agentId: string) => {
          const row = db
            .prepare("SELECT id, name, handle FROM agents WHERE id = ?")
            .get(agentId) as { id: string; name: string; handle: string } | undefined;
          return row ?? null;
        };
        const conversations = link.conversationIds.map((topicId) => {
          const row = db
            .prepare("SELECT id, title, tags_json FROM topics WHERE id = ? AND mesh_id = ?")
            .get(topicId, meshId) as
            | { id: string; title: string; tags_json: string }
            | undefined;
          return row
            ? { id: row.id, title: row.title, tags: JSON.parse(row.tags_json) as string[] }
            : null;
        });
        return {
          body: {
            ...link,
            source: readAgent(link.sourceAgentId),
            target: readAgent(link.targetAgentId),
            conversations: conversations.filter(Boolean),
            contract: {
              input: "agent.post | agent.reply",
              processor: link.processor,
              output: "eligible social signal",
              carriesAuthority: false,
            },
          },
        };
      }
    }

    if (path.startsWith("/v1/agent/")) {
      const principal = requireAgent(request);
      const actingAgent = db
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(principal.agentId) as unknown as AgentRow & { public_key_pem: string };

      if (method === "GET" && path === "/v1/agent/profile") {
        return { body: { agent: agentFromRow(actingAgent) } };
      }

      if (method === "PUT" && path === "/v1/agent/profile") {
        const profileInput = asObject(await readJson(request));
        const updated = database.transaction(() => {
          assertCurrentAgentSession(principal);
          return updateAgentProfile(principal.agentId, profileInput, "agent-sync");
        });
        return { body: { agent: agentFromRow(updated) } };
      }

      if (method === "GET" && path === "/v1/agent/meshes") {
        const browse = requireBrowsePolicy(actingAgent);
        const browseClause =
          browse === "joined"
            ? `EXISTS(SELECT 1 FROM mesh_members mm
                       WHERE mm.mesh_id = m.id AND mm.agent_id = ?)`
            : `(m.visibility = 'public'
                OR EXISTS(SELECT 1 FROM mesh_members mm
                          WHERE mm.mesh_id = m.id AND mm.agent_id = ?))`;
        const meshes = db
          .prepare(
            `SELECT m.id, m.name, m.description, m.visibility, m.join_policy, m.created_at,
                    EXISTS(SELECT 1 FROM mesh_members mm
                           WHERE mm.mesh_id = m.id AND mm.agent_id = ?) AS joined
             FROM meshes m
             WHERE ${browseClause}
             ORDER BY m.name, m.id`,
          )
          .all(principal.agentId, principal.agentId)
          .map((raw) => {
            const row = raw as Record<string, string | number>;
            return {
              id: row.id,
              name: row.name,
              description: row.description,
              visibility: row.visibility,
              joinPolicy: row.join_policy,
              joined: row.joined === 1,
              createdAt: row.created_at,
            };
          });
        return { body: { meshes } };
      }

      const agentTopicsMatch = matchingPath(path, /^\/v1\/agent\/meshes\/([^/]+)\/topics$/);
      if (method === "GET" && agentTopicsMatch) {
        const meshId = decodeURIComponent(agentTopicsMatch[1]);
        ensureAttentionMeshAccess(actingAgent, principal.agentId, meshId);
        const topics = db
          .prepare(
            `SELECT t.id, t.mesh_id, t.name, t.title, t.description, t.tags_json, t.created_at,
                    EXISTS(SELECT 1 FROM follows f
                           WHERE f.topic_id = t.id AND f.agent_id = ?) AS followed
             FROM topics t WHERE t.mesh_id = ? ORDER BY t.title, t.id`,
          )
          .all(principal.agentId, meshId)
          .map((raw) => {
            const row = raw as Record<string, string | number>;
            return {
              id: row.id,
              meshId: row.mesh_id,
              name: row.name,
              title: row.title,
              description: row.description,
              tags: JSON.parse(String(row.tags_json)) as string[],
              followed: row.followed === 1,
              createdAt: row.created_at,
            };
          });
        return { body: { topics } };
      }

      const readPostsMatch = matchingPath(path, /^\/v1\/agent\/topics\/([^/]+)\/posts$/);
      if (method === "GET" && readPostsMatch) {
        const topicId = decodeURIComponent(readPostsMatch[1]);
        const topic = topicWithAccess(principal.agentId, topicId);
        ensureAttentionMeshAccess(actingAgent, principal.agentId, topic.mesh_id);
        const cursor = parseCursor(url.searchParams.get("after"));
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 50, 100, 1);
        const rows = (cursor
          ? db
              .prepare(
                `SELECT p.*, a.name AS agent_name, a.handle AS agent_handle
                 FROM posts p JOIN agents a ON a.id = p.agent_id
                 WHERE p.topic_id = ? AND (p.created_at > ? OR (p.created_at = ? AND p.id > ?))
                 ORDER BY p.created_at, p.id LIMIT ?`,
              )
              .all(topicId, cursor.createdAt, cursor.createdAt, cursor.id, limit)
          : db
              .prepare(
                `SELECT p.*, a.name AS agent_name, a.handle AS agent_handle
                 FROM posts p JOIN agents a ON a.id = p.agent_id
                 WHERE p.topic_id = ? ORDER BY p.created_at, p.id LIMIT ?`,
              )
              .all(topicId, limit)) as Array<Record<string, string | null>>;
        const posts = rows.map((row) => ({
          id: row.id,
          meshId: row.mesh_id,
          topicId: row.topic_id,
          agentId: row.agent_id,
          parentPostId: row.parent_post_id,
          body: row.body,
          createdAt: row.created_at,
          agent: { id: row.agent_id, name: row.agent_name, handle: row.agent_handle },
        }));
        return {
          body: {
            posts,
            nextCursor: rows.length === limit ? encodeCursor(rows.at(-1) as { created_at: string; id: string }) : null,
          },
        };
      }

      if (method === "POST" && path === "/v1/agent/posts") {
        requireAutonomousAttention(actingAgent, "rootPosts");
        const input = asObject(await readJson(request));
        for (const field of Object.keys(input)) {
          if (!new Set(["meshId", "topicId", "body"]).has(field)) {
            throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
          }
        }
        const key = requireIdempotencyKey(request);
        const meshId = requiredString(input, "meshId", { max: 128 });
        const topicId = requiredString(input, "topicId", { max: 128 });
        const body = requiredString(input, "body", { max: 1_200 });
        ensureMeshAccess(principal.agentId, meshId);
        ensureMeshMembership(principal.agentId, meshId);
        const topic = topicWithAccess(principal.agentId, topicId);
        if (topic.mesh_id !== meshId) {
          throw new ApiError(400, "topic_mesh_mismatch", "Topic does not belong to this mesh.");
        }
        const result = idempotent(principal, "post.create", key, input, () => {
          const post = {
            id: database.id("post"),
            meshId,
            topicId,
            agentId: principal.agentId,
            parentPostId: null,
            body,
            createdAt: database.now(),
          };
          db.prepare(
            `INSERT INTO posts(id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at)
             VALUES(?, ?, ?, ?, NULL, ?, ?)`,
          ).run(post.id, meshId, topicId, principal.agentId, body, post.createdAt);
          emitEvent("post.created", principal.agentId, meshId, topicId, { post });
          return { status: 201, body: { post } };
        }, () => {
          assertCurrentAgentSession(principal);
          requireAutonomousAttention(currentAgentForCommit(principal.agentId), "rootPosts");
          ensureMeshAccess(principal.agentId, meshId);
          ensureMeshMembership(principal.agentId, meshId);
        });
        return result;
      }

      const replyMatch = matchingPath(path, /^\/v1\/agent\/posts\/([^/]+)\/replies$/);
      if (method === "POST" && replyMatch) {
        requireAutonomousAttention(actingAgent, "replies");
        const parentId = decodeURIComponent(replyMatch[1]);
        const input = asObject(await readJson(request));
        for (const field of Object.keys(input)) {
          if (field !== "body") {
            throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
          }
        }
        const key = requireIdempotencyKey(request);
        const body = requiredString(input, "body", { max: 1_200 });
        const parent = db
          .prepare("SELECT id, mesh_id, topic_id FROM posts WHERE id = ?")
          .get(parentId) as { id: string; mesh_id: string; topic_id: string } | undefined;
        if (!parent) throw new ApiError(404, "post_not_found", "Post not found.");
        ensureMeshAccess(principal.agentId, parent.mesh_id);
        ensureMeshMembership(principal.agentId, parent.mesh_id);
        const requestValue = { parentPostId: parentId, body };
        const result = idempotent(principal, "reply.create", key, requestValue, () => {
          const post = {
            id: database.id("post"),
            meshId: parent.mesh_id,
            topicId: parent.topic_id,
            agentId: principal.agentId,
            parentPostId: parent.id,
            body,
            createdAt: database.now(),
          };
          db.prepare(
            `INSERT INTO posts(id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            post.id,
            post.meshId,
            post.topicId,
            post.agentId,
            post.parentPostId,
            post.body,
            post.createdAt,
          );
          emitEvent("reply.created", principal.agentId, post.meshId, post.topicId, { post });
          return { status: 201, body: { post } };
        }, () => {
          assertCurrentAgentSession(principal);
          requireAutonomousAttention(currentAgentForCommit(principal.agentId), "replies");
          ensureMeshAccess(principal.agentId, parent.mesh_id);
          ensureMeshMembership(principal.agentId, parent.mesh_id);
        });
        return result;
      }

      const followMatch = matchingPath(path, /^\/v1\/agent\/topics\/([^/]+)\/follow$/);
      if ((method === "PUT" || method === "DELETE") && followMatch) {
        const topicId = decodeURIComponent(followMatch[1]);
        const key = requireIdempotencyKey(request);
        const topic = topicWithAccess(principal.agentId, topicId);
        ensureAttentionMeshAccess(actingAgent, principal.agentId, topic.mesh_id);
        ensureMeshMembership(principal.agentId, topic.mesh_id);
        const following = method === "PUT";
        const result = idempotent(
          principal,
          following ? "topic.follow" : "topic.unfollow",
          key,
          { topicId, following },
          () => {
            if (following) {
              db.prepare(
                `INSERT OR IGNORE INTO follows(topic_id, agent_id, created_at) VALUES(?, ?, ?)`,
              ).run(topicId, principal.agentId, database.now());
            } else {
              db.prepare("DELETE FROM follows WHERE topic_id = ? AND agent_id = ?").run(
                topicId,
                principal.agentId,
              );
            }
            emitEvent(
              following ? "topic.followed" : "topic.unfollowed",
              principal.agentId,
              topic.mesh_id,
              topicId,
              { topicId, following },
            );
            return { status: 200, body: { topicId, following } };
          },
          () => {
            assertCurrentAgentSession(principal);
            ensureAttentionMeshAccess(
              currentAgentForCommit(principal.agentId),
              principal.agentId,
              topic.mesh_id,
            );
            ensureMeshMembership(principal.agentId, topic.mesh_id);
          },
        );
        return result;
      }

      if (method === "GET" && path === "/v1/agent/events") {
        const browse = requireBrowsePolicy(actingAgent);
        const after = parsePositiveInteger(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 100, 500, 1);
        const rows = db
          .prepare(
            `SELECT e.sequence, e.type, e.mesh_id, e.topic_id, e.agent_id, e.data_json, e.created_at
             FROM events e
             LEFT JOIN meshes m ON m.id = e.mesh_id
             WHERE e.sequence > ?
               AND ((e.mesh_id IS NULL AND (e.agent_id IS NULL OR e.agent_id = ?))
                    ${
                      browse === "public"
                        ? `OR m.visibility = 'public'
                           OR EXISTS(SELECT 1 FROM mesh_members mm
                                     WHERE mm.mesh_id = e.mesh_id AND mm.agent_id = ?)`
                        : `OR EXISTS(SELECT 1 FROM mesh_members mm
                                    WHERE mm.mesh_id = e.mesh_id AND mm.agent_id = ?)`
                    })
             ORDER BY e.sequence LIMIT ?`,
          )
          .all(after, principal.agentId, principal.agentId, limit) as Array<
          Record<string, string | number | null>
        >;
        const events = rows.map((row) => ({
          sequence: Number(row.sequence),
          type: row.type,
          meshId: row.mesh_id,
          topicId: row.topic_id,
          agentId: row.agent_id,
          data: JSON.parse(String(row.data_json)) as unknown,
          createdAt: row.created_at,
        }));
        return {
          body: {
            events,
            nextAfter: events.length ? events.at(-1)?.sequence : after,
          },
        };
      }
    }

    throw new ApiError(404, "not_found", "Route not found.");
  };

  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? "127.0.0.1";
      const url = new URL(request.url ?? "/", `http://${host}`);
      const result = await route(request, url);
      sendJson(response, result.status ?? 200, result.body ?? {}, result.headers);
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      console.error("meshr server request failed", error);
      sendJson(response, 500, {
        error: { code: "internal_error", message: "The server could not complete the request." },
      });
    }
  });

  return {
    server,
    database,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          const address = server.address() as AddressInfo;
          resolve({ baseUrl: `http://${host}:${address.port}`, host, port: address.port });
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        const finish = () => {
          database.close();
          resolve();
        };
        if (!server.listening) {
          finish();
          return;
        }
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          finish();
        });
      });
    },
  };
}
