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
  IdentityVerifier,
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
  parseSocialProvider,
  requiredString,
} from "./validation.ts";
import { readPublicActivity } from "./publicActivity.ts";
import { readWebMcpActivity } from "./webmcpActivity.ts";
import { moderatePost, TokenBucketLimiter } from "./policy.ts";
import { MESHR_CONTRACT_MAJOR } from "./contracts.ts";
import type {
  MeshrRepository,
  RepositoryAgentInput,
  RepositoryMeshInput,
  RepositoryPairingInput,
  RepositoryPairingChallenge,
  RepositoryTopicInput,
  RepositoryModerationCase,
  RepositoryPostRecord,
  RepositoryJoinRequest,
} from "./repository.ts";
import type { RepositoryPostInput } from "./firestoreRepository.ts";

const HUMAN_SESSION_SECONDS = 7 * 24 * 60 * 60;
const HUMAN_IDLE_SECONDS = 12 * 60 * 60;
const AGENT_SESSION_SECONDS = 15 * 60;
const PAIRING_SECONDS = 15 * 60;
const CHALLENGE_SECONDS = 2 * 60;
const WEBMCP_GRANT_SECONDS = 60 * 60;
const MAX_BODY_BYTES = 64 * 1024;
const PAIRING_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const AGENT_HEARTBEAT_SECONDS = 30;
const AGENT_OFFLINE_SECONDS = 90;
const MAX_AGENTS_PER_ACCOUNT = 25;
const MAX_OWNED_MESHES_PER_ACCOUNT = 10;
const MAX_JOINED_MESHES_PER_AGENT = 100;
const MAX_POSTS_PER_MINUTE = 60;
const POST_BURST = 10;
const POST_RETENTION_SECONDS = 90 * 24 * 60 * 60;
type CostProtectionMode = "normal" | "protect" | "throttle";

function readCostProtectionMode(): CostProtectionMode {
  const value = process.env.MESHR_COST_PROTECTION_MODE?.trim().toLowerCase();
  return value === "protect" || value === "throttle" ? value : "normal";
}

interface AccountRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
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
  public_key_pem: string;
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
  session_id: string;
  authority_epoch: number;
  created_at: string;
  expires_at: string;
  last_used_at: string;
  revoked_at: string | null;
}

interface AgentAuthorityRow {
  agent_id: string;
  epoch: number;
  authority_kind: "native" | "page";
  session_id: string;
  updated_at: string;
}

interface WebMcpPrincipal extends AgentPrincipal {
  human: HumanPrincipal;
  grant: WebMcpGrantRow;
  agent: AgentRow;
}

const isWebMcpPrincipal = (principal: AgentPrincipal): principal is WebMcpPrincipal =>
  "human" in principal && "grant" in principal;

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
  /** Identity Platform verifier used by the social-login exchange route. */
  identityVerifier?: IdentityVerifier;
  /** Production mode disables the local password endpoints. */
  socialAuthOnly?: boolean;
  /** Production page WebMCP activation transfers write authority from a native host session. */
  webMcpTransfersSession?: boolean;
  /** Firestore is the authoritative write store in public mode. SQLite is retained as a read cache for local fixtures. */
  repository?: MeshrRepository;
}

export interface MeshrServer {
  server: Server;
  database: MeshrDatabase;
  /** Effective authority for mutating social state. */
  storage: "firestore" | "sqlite";
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
    secure ? "SameSite=Lax" : "SameSite=Strict",
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
    secure ? "SameSite=Lax" : "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function oauthStateCookie(state: string, secure: boolean): string {
  const attributes = [
    `meshr_oauth_state=${encodeURIComponent(state)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=600",
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function clearOauthStateCookie(secure: boolean): string {
  const attributes = [
    "meshr_oauth_state=",
    "HttpOnly",
    "SameSite=Lax",
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
    "X-Meshr-Contract-Version": String(MESHR_CONTRACT_MAJOR),
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

function pairingFromRepository(input: RepositoryPairingInput): PairingRow {
  return {
    id: input.pairingId,
    code: input.code,
    secret_hash: input.secretHash,
    runtime: input.runtime,
    runtime_label: input.runtimeLabel,
    external_subject: input.externalSubject,
    public_key_pem: input.publicKeyPem,
    requested_profile_json: input.requestedProfile
      ? JSON.stringify(input.requestedProfile)
      : null,
    definition_digest: input.definitionDigest,
    status: input.status,
    owner_account_id: input.ownerAccountId,
    agent_id: input.agentId,
    created_at: input.createdAt,
    expires_at: input.expiresAt,
    approved_at: input.approvedAt,
    claimed_at: input.claimedAt,
  };
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
  const identityVerifier = options.identityVerifier;
  const identityProjectId =
    process.env.MESHR_IDENTITY_PROJECT_ID?.trim() || process.env.GOOGLE_CLOUD_PROJECT?.trim() || "";
  const identityApiKey = process.env.MESHR_IDENTITY_API_KEY?.trim() || "";
  const identityAuthDomain =
    process.env.MESHR_IDENTITY_AUTH_DOMAIN?.trim() ||
    (identityProjectId ? `${identityProjectId}.firebaseapp.com` : "");
  const socialAuthOnly = options.socialAuthOnly ?? false;
  const webMcpTransfersSession = options.webMcpTransfersSession ?? false;
  const repository = options.repository;
  const costProtectionMode = readCostProtectionMode();
  const assertCostProtectionAllows = (operation: "pairing" | "session" | "mesh"): void => {
    if (costProtectionMode !== "protect") return;
    throw new ApiError(
      503,
      "cost_protection_active",
      `Meshr is in cost-protection mode; new ${operation} starts are temporarily paused.`,
      60,
    );
  };
  const durableWrite = async (
    label: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (!repository) return;
    try {
      await operation();
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.message === "handle_unavailable") {
        throw new ApiError(409, "handle_unavailable", "That agent handle is already in use.");
      }
      if (error instanceof Error && error.message === "last_owner") {
        throw new ApiError(409, "last_owner", "A mesh must always retain at least one owner.");
      }
      if (error instanceof Error && error.message === "agent_limit_reached") {
        throw new ApiError(429, "agent_limit_reached", "This account has reached the 25-agent launch limit.");
      }
      if (error instanceof Error && error.message === "mesh_limit_reached") {
        throw new ApiError(429, "mesh_limit_reached", "This account has reached its mesh limit.");
      }
      if (error instanceof Error && error.message === "agent_mesh_limit_reached") {
        throw new ApiError(429, "agent_mesh_limit_reached", "This agent has reached its mesh limit.");
      }
      if (error instanceof Error && error.message === "join_request_not_pending") {
        throw new ApiError(404, "join_request_not_found", "Join request is not pending.");
      }
      if (error instanceof Error && error.message === "mesh_not_found") {
        throw new ApiError(404, "mesh_not_found", "Mesh not found.");
      }
      if (error instanceof Error && error.message === "agent_not_found") {
        throw new ApiError(404, "agent_not_found", "Agent not found.");
      }
      if (error instanceof Error && error.message === "topic_not_found") {
        throw new ApiError(404, "topic_not_found", "Topic not found.");
      }
      if (error instanceof Error && error.message === "mesh_membership_required") {
        throw new ApiError(403, "mesh_membership_required", "The agent is not currently joined to this mesh.");
      }
      if (error instanceof Error && error.message === "session_superseded") {
        throw new ApiError(401, "session_superseded", "This runtime session has been superseded by a newer session.");
      }
      if (error instanceof Error && error.message === "session_invalid") {
        throw new ApiError(401, "session_invalid", "The runtime session is expired or offline.");
      }
      throw new ApiError(
        503,
        "durable_store_unavailable",
        error instanceof Error
          ? `${label}: ${error.message}`
          : `${label}: durable store unavailable.`,
      );
    }
  };
  const repositoryAgent = (agent: AgentRow): RepositoryAgentInput => ({
    agentId: agent.id,
    ownerAccountId: agent.owner_account_id,
    name: agent.name,
    handle: agent.handle,
    tagline: agent.tagline,
    interests: JSON.parse(agent.interests_json) as string[],
    personality: agent.personality,
    attention: JSON.parse(agent.attention_json) as Record<string, unknown>,
    runtime: agent.runtime,
    runtimeLabel: agent.runtime_label,
    runtimeSubject: agent.runtime_subject,
    publicKeyPem: agent.public_key_pem,
    definitionDigest: agent.definition_digest,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
  });
  const projectionHydratedAt = new Map<string, number>();
  const hydrateProjection = async (scope: {
    accountId?: string;
    agentId?: string;
  }): Promise<void> => {
    if (!repository?.loadProjection) return;
    const key = (scope.accountId ?? "") + ":" + (scope.agentId ?? "");
    const last = projectionHydratedAt.get(key) ?? 0;
    if (Date.now() - last < 2_000) return;
    const projection = await repository.loadProjection(scope);
    database.transaction(() => {
      // A projection is a cache, not an authority. Reconcile the scoped
      // records that affect authorization before applying the fresh snapshot;
      // otherwise a role or mesh removed on another API replica could linger
      // in SQLite and be mistaken for durable access.
      if (scope.accountId || scope.agentId) {
        const accessibleMeshIds = projection.meshes.map((mesh) => mesh.meshId);
        const placeholders = accessibleMeshIds.length
          ? accessibleMeshIds.map(() => "?").join(",")
          : "NULL";
        if (scope.accountId) {
          // Remove private meshes while the account-role rows still exist.
          // Deleting the role rows first would make the EXISTS guard below
          // false and leave a stale private mesh in the local projection.
          const staleMeshIdPredicate = accessibleMeshIds.length
            ? `id NOT IN (${placeholders})`
            : "1 = 1";
          db.prepare(
            `DELETE FROM meshes
             WHERE visibility <> 'public'
               AND EXISTS(
                 SELECT 1 FROM mesh_human_roles r
                 WHERE r.mesh_id = meshes.id AND r.account_id = ?
               )
               AND ${staleMeshIdPredicate}`,
          ).run(scope.accountId, ...accessibleMeshIds);
          const staleMeshPredicate = accessibleMeshIds.length
            ? `mesh_id NOT IN (${placeholders})`
            : "1 = 1";
          db.prepare(
            `DELETE FROM mesh_human_roles
             WHERE account_id = ? AND ${staleMeshPredicate}`,
          ).run(scope.accountId, ...accessibleMeshIds);
        }
        for (const meshId of accessibleMeshIds) {
          const meshTopics = projection.topics.filter((topic) => topic.meshId === meshId);
          const topicIds = meshTopics.map((topic) => topic.topicId);
          if (topicIds.length) {
            db.prepare(
              `DELETE FROM topics WHERE mesh_id = ? AND id NOT IN (${topicIds.map(() => "?").join(",")})`,
            ).run(meshId, ...topicIds);
          } else {
            db.prepare("DELETE FROM topics WHERE mesh_id = ?").run(meshId);
          }
          const meshPosts = projection.posts.filter((post) => post.meshId === meshId);
          const postIds = meshPosts.map((post) => post.postId);
          if (postIds.length) {
            db.prepare(
              `DELETE FROM posts WHERE mesh_id = ? AND id NOT IN (${postIds.map(() => "?").join(",")})`,
            ).run(meshId, ...postIds);
          } else {
            db.prepare("DELETE FROM posts WHERE mesh_id = ?").run(meshId);
          }
          const meshMemberships = projection.memberships.filter((membership) => membership.meshId === meshId);
          const membershipKeys = meshMemberships.map((membership) => `${membership.meshId}:${membership.agentId}`);
          if (membershipKeys.length) {
            db.prepare(
              `DELETE FROM mesh_members
               WHERE mesh_id = ? AND (mesh_id || ':' || agent_id) NOT IN (${membershipKeys.map(() => "?").join(",")})`,
            ).run(meshId, ...membershipKeys);
          } else {
            db.prepare("DELETE FROM mesh_members WHERE mesh_id = ?").run(meshId);
          }
        }
        if (scope.agentId) {
          // Agent-scoped hydration is the authority for private membership.
          // Remove local memberships that disappeared from Firestore (or from
          // the agent's joined set) before any WebMCP/read path consults them.
          const joinedMembershipKeys = projection.memberships
            .filter((membership) => membership.agentId === scope.agentId && membership.status === "joined")
            .map((membership) => `${membership.meshId}:${membership.agentId}`);
          if (joinedMembershipKeys.length) {
            db.prepare(
              `DELETE FROM mesh_members
               WHERE agent_id = ? AND (mesh_id || ':' || agent_id) NOT IN (${joinedMembershipKeys.map(() => "?").join(",")})`,
            ).run(scope.agentId, ...joinedMembershipKeys);
          } else {
            db.prepare("DELETE FROM mesh_members WHERE agent_id = ?").run(scope.agentId);
          }
        }
      } else {
        // The unauthenticated public discovery cache is also disposable. Do
        // not leave a deleted/hidden public mesh visible after a Firestore
        // refresh, while keeping private meshes out of this cache's route
        // surface.
        const publicMeshIds = projection.meshes
          .filter((mesh) => mesh.visibility === "public")
          .map((mesh) => mesh.meshId);
        const publicMeshPlaceholders = publicMeshIds.length
          ? publicMeshIds.map(() => "?").join(",")
          : "NULL";
        db.prepare(
          `DELETE FROM meshes
           WHERE visibility = 'public' AND id NOT IN (${publicMeshPlaceholders})`,
        ).run(...publicMeshIds);
        for (const meshId of publicMeshIds) {
          const meshTopics = projection.topics.filter((topic) => topic.meshId === meshId);
          const topicIds = meshTopics.map((topic) => topic.topicId);
          if (topicIds.length) {
            db.prepare(
              `DELETE FROM topics WHERE mesh_id = ? AND id NOT IN (${topicIds.map(() => "?").join(",")})`,
            ).run(meshId, ...topicIds);
          } else {
            db.prepare("DELETE FROM topics WHERE mesh_id = ?").run(meshId);
          }
          const meshPosts = projection.posts.filter((post) => post.meshId === meshId);
          const postIds = meshPosts.map((post) => post.postId);
          if (postIds.length) {
            db.prepare(
              `DELETE FROM posts WHERE mesh_id = ? AND id NOT IN (${postIds.map(() => "?").join(",")})`,
            ).run(meshId, ...postIds);
          } else {
            db.prepare("DELETE FROM posts WHERE mesh_id = ?").run(meshId);
          }
        }
      }
      if (scope.agentId && !projection.agents.some((agent) => agent.agentId === scope.agentId)) {
        db.prepare("DELETE FROM agents WHERE id = ?").run(scope.agentId);
      }
      for (const account of projection.accounts) {
        db.prepare(
          `INSERT OR IGNORE INTO accounts(id, email, display_name, password_hash, created_at)
           VALUES(?, ?, ?, '', ?)`,
        ).run(account.accountId, account.email, account.displayName, account.createdAt);
      }
      for (const mesh of projection.meshes) {
        db.prepare(
          `INSERT INTO meshes(
             id, owner_account_id, name, description, visibility, join_policy, created_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             owner_account_id = excluded.owner_account_id, name = excluded.name,
             description = excluded.description, visibility = excluded.visibility,
             join_policy = excluded.join_policy`,
        ).run(
          mesh.meshId,
          mesh.ownerAccountId,
          mesh.name,
          mesh.description,
          mesh.visibility,
          mesh.admission,
          mesh.createdAt,
        );
      }
      for (const agent of projection.agents) {
        db.prepare(
          `INSERT INTO agents(
             id, owner_account_id, name, handle, tagline, interests_json,
             personality, attention_json, runtime, runtime_label, runtime_subject,
             public_key_pem, definition_digest, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             owner_account_id = excluded.owner_account_id, name = excluded.name,
             handle = excluded.handle, tagline = excluded.tagline,
             interests_json = excluded.interests_json, personality = excluded.personality,
             attention_json = excluded.attention_json, runtime = excluded.runtime,
             runtime_label = excluded.runtime_label, runtime_subject = excluded.runtime_subject,
             public_key_pem = excluded.public_key_pem,
             definition_digest = excluded.definition_digest, updated_at = excluded.updated_at`,
        ).run(
          agent.agentId,
          agent.ownerAccountId,
          agent.name,
          agent.handle,
          agent.tagline,
          JSON.stringify(agent.interests),
          agent.personality,
          JSON.stringify(agent.attention),
          agent.runtime,
          agent.runtimeLabel,
          agent.runtimeSubject,
          agent.publicKeyPem,
          agent.definitionDigest,
          agent.createdAt,
          agent.updatedAt,
        );
      }
      for (const topic of projection.topics) {
        db.prepare(
          `INSERT INTO topics(id, mesh_id, name, title, description, tags_json, created_at)
           VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             mesh_id = excluded.mesh_id, name = excluded.name, title = excluded.title,
             description = excluded.description, tags_json = excluded.tags_json`,
        ).run(
          topic.topicId,
          topic.meshId,
          topic.name,
          topic.title,
          topic.description,
          JSON.stringify(topic.tags),
          topic.createdAt,
        );
      }
      for (const role of projection.humanRoles) {
        db.prepare(
          `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(mesh_id, account_id) DO UPDATE SET
             role = excluded.role, updated_at = excluded.updated_at`,
        ).run(role.meshId, role.accountId, role.role, role.createdAt, role.updatedAt);
      }
      for (const membership of projection.memberships) {
        if (membership.status === "joined") {
          db.prepare(
            `INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at)
             VALUES(?, ?, ?)`,
          ).run(membership.meshId, membership.agentId, membership.joinedAt ?? membership.updatedAt);
        } else if (membership.status === "left" || membership.status === "removed") {
          db.prepare("DELETE FROM mesh_members WHERE mesh_id = ? AND agent_id = ?")
            .run(membership.meshId, membership.agentId);
        }
      }
      for (const post of [...projection.posts].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.postId.localeCompare(right.postId))) {
        db.prepare(
          `INSERT OR IGNORE INTO posts(
             id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at,
             moderation_state, moderation_reason, expires_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          post.postId,
          post.meshId,
          post.topicId,
          post.agentId,
          post.parentPostId,
          post.body,
          post.createdAt,
          post.moderationState,
          post.moderationReason,
          post.expiresAt,
        );
      }
      for (const follow of projection.follows) {
        db.prepare(
          `INSERT OR IGNORE INTO follows(topic_id, agent_id, created_at) VALUES(?, ?, ?)`,
        ).run(follow.topicId, follow.agentId, follow.updatedAt);
      }
    });
    projectionHydratedAt.set(key, Date.now());
  };
  // The local compatibility adapter keeps the original long-lived fixture
  // sessions so existing offline stories remain reproducible. Public mode
  // (social auth or an explicit strict flag) uses the launch contract.
  const strictRuntimeSessions =
    socialAuthOnly || process.env.MESHR_STRICT_SESSIONS === "1";
  const runtimeAgentSessionSeconds = strictRuntimeSessions
    ? AGENT_SESSION_SECONDS
    : 12 * 60 * 60;
  const runtimeOfflineSeconds = strictRuntimeSessions ? AGENT_OFFLINE_SECONDS : 24 * 60 * 60;
  const readAuthority = (agentId: string): AgentAuthorityRow | undefined =>
    db
      .prepare(
        `SELECT agent_id, epoch, authority_kind, session_id, updated_at
         FROM agent_authority WHERE agent_id = ?`,
      )
      .get(agentId) as AgentAuthorityRow | undefined;
  const advanceAuthority = (
    agentId: string,
    kind: AgentAuthorityRow["authority_kind"],
    sessionId: string,
    updatedAt: string,
  ): number => {
    const current = readAuthority(agentId);
    const epoch = (current?.epoch ?? 0) + 1;
    db.prepare(
      `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         epoch = excluded.epoch,
         authority_kind = excluded.authority_kind,
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`,
    ).run(agentId, epoch, kind, sessionId, updatedAt);
    return epoch;
  };
  const postLimit = costProtectionMode === "throttle" ? 30 : MAX_POSTS_PER_MINUTE;
  const postBurst = costProtectionMode === "throttle" ? 5 : POST_BURST;
  const postLimiter = new TokenBucketLimiter(postBurst, postLimit / 60);
  const accountPostLimiter = new TokenBucketLimiter(
    MAX_AGENTS_PER_ACCOUNT * postLimit,
    (MAX_AGENTS_PER_ACCOUNT * postLimit) / 60,
  );
  const globalPostLimiter = new TokenBucketLimiter(
    costProtectionMode === "throttle" ? 100 : 200,
    costProtectionMode === "throttle" ? 60 : 120,
  );
  const pageAuthorityJoin = webMcpTransfersSession
    ? `JOIN agent_authority aa
           ON aa.agent_id = wg.agent_id
          AND aa.authority_kind = 'page'
          AND aa.session_id = wg.session_id
          AND aa.epoch = wg.authority_epoch`
    : "";

  const enforcePostCapacity = (agent: AgentRow): void => {
    const globalResult = globalPostLimiter.consume("global");
    if (!globalResult.allowed) {
      throw new ApiError(
        429,
        "global_rate_limited",
        "Meshr is processing the maximum write rate. Retry after the indicated delay.",
        globalResult.retryAfterSeconds,
      );
    }
    const agentResult = postLimiter.consume(`agent:${agent.id}`);
    if (!agentResult.allowed) {
      throw new ApiError(
        429,
        "agent_rate_limited",
        "This agent is posting too quickly. Retry after the indicated delay.",
        agentResult.retryAfterSeconds,
      );
    }
    const accountResult = accountPostLimiter.consume(`account:${agent.owner_account_id}`);
    if (!accountResult.allowed) {
      throw new ApiError(
        429,
        "account_rate_limited",
        "This account has reached its aggregate posting limit. Retry after the indicated delay.",
        accountResult.retryAfterSeconds,
      );
    }
  };
  const publicWebUrl = options.publicWebUrl
    ? new URL(options.publicWebUrl).toString()
    : undefined;
  const allowedOrigins = new Set(
    [
      publicWebUrl ? new URL(publicWebUrl).origin : undefined,
      ...(process.env.MESHR_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ].filter((value): value is string => Boolean(value)),
  );

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

  const requireHuman = async (request: IncomingMessage): Promise<HumanPrincipal> => {
    const token = parseCookies(request.headers.cookie).meshr_session;
    if (!token) throw new ApiError(401, "authentication_required", "Sign in is required.");
    const tokenHash = sha256(token);
    const row = db
      .prepare(
        `SELECT hs.account_id, hs.csrf_token, a.email, a.display_name
         FROM human_sessions hs
         JOIN accounts a ON a.id = hs.account_id
         WHERE hs.token_hash = ? AND hs.expires_at > ?
           AND COALESCE(hs.absolute_expires_at, hs.expires_at) > ?
           AND hs.last_seen_at > ?`,
      )
      .get(
        tokenHash,
        database.now(),
        database.now(),
        addSeconds(database.clock.now(), -HUMAN_IDLE_SECONDS),
      ) as
      | { account_id: string; csrf_token: string; email: string; display_name: string }
      | undefined;
    const now = database.now();
    let accountId: string;
    let csrfToken: string;
    let email: string;
    let displayName: string;
    // In Firestore mode the cookie is only a bearer handle. Always re-check
    // the durable session so logout/expiry on another API replica takes
    // effect immediately instead of waiting for an in-memory projection to
    // catch up.
    let durable:
      | {
          accountId: string;
          csrfToken: string;
          createdAt: string;
          expiresAt: string;
          absoluteExpiresAt: string;
          lastSeenAt: string;
        }
      | null = null;
    if (repository) {
      try {
        durable = await repository.findHumanSession(tokenHash);
      } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The session store is unavailable.",
        );
      }
      if (
        !durable ||
        Date.parse(durable.expiresAt) <= Date.parse(now) ||
        Date.parse(durable.absoluteExpiresAt) <= Date.parse(now) ||
        Date.parse(durable.lastSeenAt) <=
          Date.parse(addSeconds(database.clock.now(), -HUMAN_IDLE_SECONDS))
      ) {
        throw new ApiError(401, "authentication_required", "Sign in is required.");
      }
    }
    if (durable) {
      accountId = durable.accountId;
      csrfToken = durable.csrfToken;
      const localAccount = db
        .prepare("SELECT email, display_name FROM accounts WHERE id = ?")
        .get(accountId) as { email: string; display_name: string } | undefined;
      let durableAccount: { email: string; displayName: string } | null;
      if (localAccount) {
        durableAccount = { email: localAccount.email, displayName: localAccount.display_name };
      } else {
        try {
          durableAccount = await repository!.findAccountById(accountId);
        } catch (error) {
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The account store is unavailable.",
          );
        }
      }
      if (!durableAccount) throw new ApiError(401, "authentication_required", "Sign in is required.");
      email = durableAccount.email;
      displayName = durableAccount.displayName;
      database.transaction(() => {
        db.prepare(
          `INSERT INTO accounts(id, email, display_name, password_hash, created_at)
           VALUES(?, ?, ?, '', ?)
           ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name`,
        ).run(accountId, durableAccount.email, durableAccount.displayName, durable.createdAt);
        db.prepare(
          `INSERT INTO human_sessions(
             token_hash, account_id, csrf_token, created_at, expires_at,
             last_seen_at, absolute_expires_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(token_hash) DO UPDATE SET
             account_id = excluded.account_id, csrf_token = excluded.csrf_token,
             created_at = excluded.created_at, expires_at = excluded.expires_at,
             last_seen_at = excluded.last_seen_at,
             absolute_expires_at = excluded.absolute_expires_at`,
        ).run(
          tokenHash,
          durable.accountId,
          durable.csrfToken,
          durable.createdAt,
          durable.expiresAt,
          durable.lastSeenAt,
          durable.absoluteExpiresAt,
        );
      });
    } else if (row) {
      accountId = row.account_id;
      csrfToken = row.csrf_token;
      email = row.email;
      displayName = row.display_name;
    } else {
      throw new ApiError(401, "authentication_required", "Sign in is required.");
    }
    db.prepare("UPDATE human_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, tokenHash);
    if (repository) {
      try {
        await repository.touchHumanSession(tokenHash, now);
      } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The session store is unavailable.",
        );
      }
      try {
        await hydrateProjection({ accountId });
      } catch (error) {
        throw new ApiError(
          503,
          "projection_unavailable",
          error instanceof Error ? error.message : "The durable projection is unavailable.",
        );
      }
    }
    return {
      accountId,
      email,
      displayName,
      csrfToken,
      sessionHash: tokenHash,
    };
  };

  const requireCsrf = (request: IncomingMessage, principal: HumanPrincipal): void => {
    const suppliedOrigin = request.headers.origin ?? (() => {
      const referer = request.headers.referer;
      if (typeof referer !== "string" || !referer) return undefined;
      try {
        return new URL(referer).origin;
      } catch {
        return "invalid";
      }
    })();
    if ((repository || secureCookies) && typeof suppliedOrigin !== "string") {
      throw new ApiError(403, "origin_failed", "A same-origin request is required.");
    }
    if (typeof suppliedOrigin === "string") {
      const localDevelopmentOrigin =
        !secureCookies && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(suppliedOrigin);
      if (!allowedOrigins.has(suppliedOrigin) && !localDevelopmentOrigin) {
        throw new ApiError(403, "origin_failed", "The request origin is not allowed.");
      }
    }
    const csrf = request.headers["x-meshr-csrf"];
    if (typeof csrf !== "string" || !constantTimeStringEqual(csrf, principal.csrfToken)) {
      throw new ApiError(403, "csrf_failed", "The CSRF token is missing or invalid.");
    }
  };

  const loadPairing = async (id: string): Promise<PairingRow | undefined> => {
    const local = readPairing(db, id);
    if (!repository?.findPairing) return local;
    let durable: RepositoryPairingInput | null;
    try {
      durable = await repository.findPairing(id);
    } catch (error) {
      throw new ApiError(
        503,
        "session_store_unavailable",
        error instanceof Error ? error.message : "The pairing store is unavailable.",
      );
    }
    if (!durable) return undefined;
    const pairing = pairingFromRepository(durable);
    database.transaction(() => {
      db.prepare(
        `INSERT INTO pairings(
           id, code, secret_hash, runtime, runtime_label, external_subject, public_key_pem,
           requested_profile_json, definition_digest, status, owner_account_id, agent_id,
           created_at, expires_at, approved_at, claimed_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           code = excluded.code, secret_hash = excluded.secret_hash,
           runtime = excluded.runtime, runtime_label = excluded.runtime_label,
           external_subject = excluded.external_subject, public_key_pem = excluded.public_key_pem,
           requested_profile_json = excluded.requested_profile_json,
           definition_digest = excluded.definition_digest, status = excluded.status,
           owner_account_id = excluded.owner_account_id, agent_id = excluded.agent_id,
           expires_at = excluded.expires_at, approved_at = excluded.approved_at,
           claimed_at = excluded.claimed_at`,
      ).run(
        pairing.id,
        pairing.code,
        pairing.secret_hash,
        pairing.runtime,
        pairing.runtime_label,
        pairing.external_subject,
        pairing.public_key_pem,
        pairing.requested_profile_json,
        pairing.definition_digest,
        pairing.status,
        pairing.owner_account_id,
        pairing.agent_id,
        pairing.created_at,
        pairing.expires_at,
        pairing.approved_at,
        pairing.claimed_at,
      );
    });
    return pairing;
  };

  const loadPairingByCode = async (code: string): Promise<PairingRow | undefined> => {
    const local = db.prepare("SELECT * FROM pairings WHERE code = ?").get(code) as
      | PairingRow
      | undefined;
    if (!repository?.findPairingByCode) return local;
    let durable: RepositoryPairingInput | null;
    try {
      durable = await repository.findPairingByCode(code);
    } catch (error) {
      throw new ApiError(
        503,
        "session_store_unavailable",
        error instanceof Error ? error.message : "The pairing store is unavailable.",
      );
    }
    if (!durable) return undefined;
    const pairing = pairingFromRepository(durable);
    database.transaction(() => {
      db.prepare(
        `INSERT INTO pairings(
           id, code, secret_hash, runtime, runtime_label, external_subject, public_key_pem,
           requested_profile_json, definition_digest, status, owner_account_id, agent_id,
           created_at, expires_at, approved_at, claimed_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           code = excluded.code, secret_hash = excluded.secret_hash,
           runtime = excluded.runtime, runtime_label = excluded.runtime_label,
           external_subject = excluded.external_subject, public_key_pem = excluded.public_key_pem,
           requested_profile_json = excluded.requested_profile_json,
           definition_digest = excluded.definition_digest, status = excluded.status,
           owner_account_id = excluded.owner_account_id, agent_id = excluded.agent_id,
           expires_at = excluded.expires_at, approved_at = excluded.approved_at,
           claimed_at = excluded.claimed_at`,
      ).run(
        pairing.id,
        pairing.code,
        pairing.secret_hash,
        pairing.runtime,
        pairing.runtime_label,
        pairing.external_subject,
        pairing.public_key_pem,
        pairing.requested_profile_json,
        pairing.definition_digest,
        pairing.status,
        pairing.owner_account_id,
        pairing.agent_id,
        pairing.created_at,
        pairing.expires_at,
        pairing.approved_at,
        pairing.claimed_at,
      );
    });
    return pairing;
  };

  const loadPairingChallenge = async (
    challengeId: string,
    pairingId: string,
  ): Promise<RepositoryPairingChallenge | null> => {
    if (repository?.findPairingChallenge) {
      let durable: RepositoryPairingChallenge | null;
      try {
        durable = await repository.findPairingChallenge(challengeId, pairingId);
      } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The pairing store is unavailable.",
        );
      }
      if (!durable) return null;
      db.prepare(
        `INSERT INTO pairing_challenges(id, pairing_id, message, created_at, expires_at, used_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           pairing_id = excluded.pairing_id, message = excluded.message,
           created_at = excluded.created_at, expires_at = excluded.expires_at,
           used_at = excluded.used_at`,
      ).run(
        durable.challengeId,
        durable.pairingId,
        durable.message,
        durable.createdAt,
        durable.expiresAt,
        durable.usedAt,
      );
      return durable;
    }
    const local = db
      .prepare(
        `SELECT id, pairing_id, message, created_at, expires_at, used_at
         FROM pairing_challenges WHERE id = ? AND pairing_id = ?`,
      )
      .get(challengeId, pairingId) as
      | {
          id: string;
          pairing_id: string;
          message: string;
          created_at: string;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;
    return local
      ? {
          challengeId: local.id,
          pairingId: local.pairing_id,
          message: local.message,
          createdAt: local.created_at,
          expiresAt: local.expires_at,
          usedAt: local.used_at,
        }
      : null;
  };

  const consumePairingChallenge = async (
    challengeId: string,
    pairingId: string,
    usedAt: string,
  ): Promise<RepositoryPairingChallenge | null> => {
    if (repository?.consumePairingChallenge) {
      let consumed: RepositoryPairingChallenge | null;
      try {
        consumed = await repository.consumePairingChallenge(challengeId, pairingId, usedAt);
      } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The pairing store is unavailable.",
        );
      }
      if (!consumed) return null;
      db.prepare(
        "UPDATE pairing_challenges SET used_at = ? WHERE id = ? AND pairing_id = ?",
      ).run(usedAt, challengeId, pairingId);
      return consumed;
    }
    const updated = db.prepare(
      "UPDATE pairing_challenges SET used_at = ? WHERE id = ? AND pairing_id = ? AND used_at IS NULL",
    ).run(usedAt, challengeId, pairingId);
    if (updated.changes !== 1) return null;
    return loadPairingChallenge(challengeId, pairingId);
  };

  const requirePairing = async (request: IncomingMessage, id: string): Promise<PairingRow> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Pairing ")) {
      throw new ApiError(401, "pairing_authentication_required", "Pairing secret is required.");
    }
    const secret = authorization.slice("Pairing ".length).trim();
    const pairing = await loadPairing(id);
    if (!pairing || !constantTimeStringEqual(sha256(secret), pairing.secret_hash)) {
      throw new ApiError(401, "pairing_authentication_failed", "Pairing secret is invalid.");
    }
    const expired = expirePendingPairing(pairing);
    if (expired.status === "expired" && repository?.updatePairing) {
      try {
        await repository.updatePairing(id, { status: "expired" });
      } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The pairing store is unavailable.",
        );
      }
    }
    return expired;
  };

  const hydrateDurableAgentSession = async (
    tokenHash: string,
    now: string,
  ): Promise<boolean> => {
    if (!repository?.findRuntimeSessionByTokenHash || !repository.findAgentById) return false;
    const durableSession = await repository.findRuntimeSessionByTokenHash(tokenHash);
    if (
      !durableSession ||
      durableSession.status !== "active" ||
      Date.parse(durableSession.expiresAt) <= Date.parse(now)
    ) {
      return false;
    }
    const durableAgent = await repository.findAgentById(durableSession.agentId);
    if (!durableAgent) return false;
    const account = await repository.findAccountById(durableAgent.ownerAccountId);
    if (!account) return false;
    database.transaction(() => {
      db.prepare(
        `INSERT OR IGNORE INTO accounts(id, email, display_name, password_hash, created_at)
         VALUES(?, ?, ?, '', ?)`,
      ).run(account.accountId, account.email, account.displayName, account.createdAt);
      db.prepare(
        `INSERT INTO agents(
           id, owner_account_id, name, handle, tagline, interests_json,
           personality, attention_json, runtime, runtime_label, runtime_subject,
           public_key_pem, definition_digest, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           owner_account_id = excluded.owner_account_id, name = excluded.name,
           handle = excluded.handle, tagline = excluded.tagline,
           interests_json = excluded.interests_json, personality = excluded.personality,
           attention_json = excluded.attention_json, runtime = excluded.runtime,
           runtime_label = excluded.runtime_label, runtime_subject = excluded.runtime_subject,
           public_key_pem = excluded.public_key_pem,
           definition_digest = excluded.definition_digest, updated_at = excluded.updated_at`,
      ).run(
        durableAgent.agentId,
        durableAgent.ownerAccountId,
        durableAgent.name,
        durableAgent.handle,
        durableAgent.tagline,
        JSON.stringify(durableAgent.interests),
        durableAgent.personality,
        JSON.stringify(durableAgent.attention),
        durableAgent.runtime,
        durableAgent.runtimeLabel,
        durableAgent.runtimeSubject,
        durableAgent.publicKeyPem,
        durableAgent.definitionDigest,
        durableAgent.createdAt,
        durableAgent.updatedAt,
      );
      db.prepare(
        `INSERT OR IGNORE INTO pairings(
           id, code, secret_hash, runtime, runtime_label, external_subject,
           public_key_pem, requested_profile_json, definition_digest, status,
           owner_account_id, agent_id, created_at, expires_at, claimed_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, 'claimed', ?, ?, ?, ?, ?)`,
      ).run(
        durableSession.bindingId,
        `durable-${durableSession.bindingId}`,
        sha256(durableSession.bindingId),
        durableAgent.runtime,
        durableAgent.runtimeLabel,
        durableAgent.runtimeSubject,
        durableAgent.publicKeyPem,
        durableAgent.definitionDigest,
        durableAgent.ownerAccountId,
        durableAgent.agentId,
        durableAgent.createdAt,
        durableSession.expiresAt,
        durableSession.createdAt,
      );
      db.prepare(
        `INSERT INTO agent_sessions(
           token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
           session_id, runtime_kind, status, superseded_by, authority_epoch
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET
           agent_id = excluded.agent_id, pairing_id = excluded.pairing_id,
           expires_at = excluded.expires_at, last_seen_at = excluded.last_seen_at,
           session_id = excluded.session_id, runtime_kind = excluded.runtime_kind,
           status = excluded.status, superseded_by = excluded.superseded_by,
           authority_epoch = excluded.authority_epoch`,
      ).run(
        durableSession.tokenHash,
        durableSession.agentId,
        durableSession.bindingId,
        durableSession.createdAt,
        durableSession.expiresAt,
        durableSession.lastSeenAt,
        durableSession.sessionId,
        durableSession.runtimeKind,
        durableSession.status,
        durableSession.supersedingSessionId,
        durableSession.authorityEpoch,
      );
      db.prepare(
        `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
         VALUES(?, ?, 'native', ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           epoch = excluded.epoch, authority_kind = excluded.authority_kind,
           session_id = excluded.session_id, updated_at = excluded.updated_at`,
      ).run(
        durableSession.agentId,
        durableSession.authorityEpoch,
        durableSession.sessionId,
        durableSession.lastSeenAt,
      );
    });
    return true;
  };

  const requireAgent = async (
    request: IncomingMessage,
    options: { allowStaleHeartbeat?: boolean } = {},
  ): Promise<AgentPrincipal> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new ApiError(401, "agent_authentication_required", "Agent bearer token is required.");
    }
    const tokenHash = sha256(authorization.slice("Bearer ".length).trim());
    const now = database.now();
    const onlineAfter = addSeconds(database.clock.now(), -runtimeOfflineSeconds);
    let row = db
      .prepare(
        `SELECT s.agent_id, a.owner_account_id, s.session_id, s.runtime_kind,
                s.authority_epoch
         FROM agent_sessions s
         JOIN agents a ON a.id = s.agent_id
         JOIN agent_authority aa
           ON aa.agent_id = s.agent_id
          AND aa.authority_kind = 'native'
          AND aa.session_id = s.session_id
          AND aa.epoch = s.authority_epoch
         WHERE s.token_hash = ? AND s.expires_at > ? AND s.status = 'active'
           AND (? = 1 OR s.last_seen_at >= ?)`,
      )
      .get(tokenHash, now, options.allowStaleHeartbeat ? 1 : 0, onlineAfter) as
      | {
          agent_id: string;
          owner_account_id: string;
          session_id: string;
          runtime_kind: RuntimeKind;
          authority_epoch: number;
        }
      | undefined;
    if (repository?.findRuntimeSessionByTokenHash) {
      let durableSession: Awaited<ReturnType<NonNullable<MeshrRepository["findRuntimeSessionByTokenHash"]>>>;
      try {
        durableSession = await repository.findRuntimeSessionByTokenHash(tokenHash);
      } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The session store is unavailable.",
        );
      }
      if (
        !durableSession ||
        durableSession.status !== "active" ||
        Date.parse(durableSession.expiresAt) <= Date.parse(now) ||
        (!options.allowStaleHeartbeat && Date.parse(durableSession.lastSeenAt) < Date.parse(onlineAfter))
      ) {
        throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid or offline.");
      }
      if (
        !row ||
        row.agent_id !== durableSession.agentId ||
        row.session_id !== durableSession.sessionId ||
        row.authority_epoch !== durableSession.authorityEpoch ||
        row.runtime_kind !== durableSession.runtimeKind
      ) {
        try {
          await hydrateDurableAgentSession(tokenHash, now);
        } catch (error) {
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The session store is unavailable.",
          );
        }
        row = db
          .prepare(
            `SELECT s.agent_id, a.owner_account_id, s.session_id, s.runtime_kind,
                    s.authority_epoch
             FROM agent_sessions s
             JOIN agents a ON a.id = s.agent_id
             JOIN agent_authority aa
               ON aa.agent_id = s.agent_id AND aa.authority_kind = 'native'
              AND aa.session_id = s.session_id AND aa.epoch = s.authority_epoch
             WHERE s.token_hash = ? AND s.expires_at > ? AND s.status = 'active'
               AND (? = 1 OR s.last_seen_at >= ?)`,
          )
          .get(tokenHash, now, options.allowStaleHeartbeat ? 1 : 0, onlineAfter) as typeof row;
      }
    }
    if (!row && repository) {
      try {
        await hydrateDurableAgentSession(tokenHash, now);
        row = db
          .prepare(
            `SELECT s.agent_id, a.owner_account_id, s.session_id, s.runtime_kind,
                    s.authority_epoch
             FROM agent_sessions s
             JOIN agents a ON a.id = s.agent_id
             JOIN agent_authority aa
               ON aa.agent_id = s.agent_id AND aa.authority_kind = 'native'
              AND aa.session_id = s.session_id AND aa.epoch = s.authority_epoch
             WHERE s.token_hash = ? AND s.expires_at > ? AND s.status = 'active'
               AND (? = 1 OR s.last_seen_at >= ?)`,
          )
          .get(tokenHash, now, options.allowStaleHeartbeat ? 1 : 0, onlineAfter) as typeof row;
      } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The session store is unavailable.",
        );
      }
    }
    if (!row) throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid.");
    if (repository) {
      try {
        await hydrateProjection({ agentId: row.agent_id });
      } catch (error) {
        throw new ApiError(
          503,
          "projection_unavailable",
          error instanceof Error ? error.message : "The durable projection is unavailable.",
        );
      }
    }
    // A request from an already-online host is a useful liveness signal, but
    // the freshness predicate above prevents a stale/stolen token from
    // resurrecting an offline session. Native runtimes still send the
    // documented 30-second heartbeat so idle sessions remain observable.
    db.prepare(
      "UPDATE agent_sessions SET last_seen_at = ? WHERE token_hash = ? AND status = 'active'",
    ).run(now, tokenHash);
    return {
      agentId: row.agent_id,
      ownerId: row.owner_account_id,
      sessionHash: tokenHash,
      sessionId: row.session_id,
      authorityEpoch: row.authority_epoch,
      runtime: row.runtime_kind,
    };
  };

  const readWebMcpGrant = async (
    request: IncomingMessage,
    human: HumanPrincipal,
  ): Promise<{ grant: WebMcpGrantRow; agent: AgentRow } | null> => {
    const token = parseCookies(request.headers.cookie).meshr_webmcp;
    if (!token) return null;
    const tokenHash = sha256(token);
    let grant = db
      .prepare(
         `SELECT token_hash, human_session_hash, agent_id, created_at,
                expires_at, last_used_at, revoked_at, session_id, authority_epoch
         FROM webmcp_grants wg
         ${pageAuthorityJoin}
         WHERE wg.token_hash = ? AND wg.human_session_hash = ?
           AND wg.revoked_at IS NULL AND wg.expires_at > ?`,
      )
      .get(tokenHash, human.sessionHash, database.now()) as WebMcpGrantRow | undefined;
    if (repository?.findWebMcpGrant && repository.findAgentById) {
      try {
        const durableGrant = await repository.findWebMcpGrant(tokenHash, human.sessionHash);
        if (
          !durableGrant ||
          durableGrant.revokedAt ||
          Date.parse(durableGrant.expiresAt) <= Date.parse(database.now())
        ) {
          // A local projection can outlive a grant revoked on another API
          // replica. Durable absence is authoritative in Firestore mode.
          grant = undefined;
        } else {
          const durableAgent = await repository.findAgentById(durableGrant.agentId);
          if (!durableAgent || durableAgent.ownerAccountId !== human.accountId) {
            grant = undefined;
          } else {
            // The human may not itself be a member of a private mesh. Hydrate
            // the agent-scoped membership projection before page tools apply
            // the agent's attention and mesh-access policy.
            await hydrateProjection({ agentId: durableGrant.agentId });
            database.transaction(() => {
              db.prepare(
                `INSERT INTO agents(
                   id, owner_account_id, name, handle, tagline, interests_json,
                   personality, attention_json, runtime, runtime_label, runtime_subject,
                   public_key_pem, definition_digest, created_at, updated_at
                 ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   owner_account_id = excluded.owner_account_id, name = excluded.name,
                   handle = excluded.handle, tagline = excluded.tagline,
                   interests_json = excluded.interests_json, personality = excluded.personality,
                   attention_json = excluded.attention_json, runtime = excluded.runtime,
                   runtime_label = excluded.runtime_label, runtime_subject = excluded.runtime_subject,
                   public_key_pem = excluded.public_key_pem,
                   definition_digest = excluded.definition_digest, updated_at = excluded.updated_at`,
              ).run(
                durableAgent.agentId,
                durableAgent.ownerAccountId,
                durableAgent.name,
                durableAgent.handle,
                durableAgent.tagline,
                JSON.stringify(durableAgent.interests),
                durableAgent.personality,
                JSON.stringify(durableAgent.attention),
                durableAgent.runtime,
                durableAgent.runtimeLabel,
                durableAgent.runtimeSubject,
                durableAgent.publicKeyPem,
                durableAgent.definitionDigest,
                durableAgent.createdAt,
                durableAgent.updatedAt,
              );
              db.prepare(
                `INSERT INTO webmcp_grants(
                   token_hash, human_session_hash, agent_id, created_at, expires_at,
                   last_used_at, revoked_at, session_id, authority_epoch
                 ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(token_hash) DO UPDATE SET
                   human_session_hash = excluded.human_session_hash,
                   agent_id = excluded.agent_id, expires_at = excluded.expires_at,
                   last_used_at = excluded.last_used_at, revoked_at = excluded.revoked_at,
                   session_id = excluded.session_id, authority_epoch = excluded.authority_epoch`,
              ).run(
                durableGrant.tokenHash,
                durableGrant.humanSessionHash,
                durableGrant.agentId,
                durableGrant.createdAt,
                durableGrant.expiresAt,
                durableGrant.lastUsedAt,
                durableGrant.revokedAt,
                durableGrant.sessionId,
                durableGrant.authorityEpoch,
              );
              db.prepare(
                `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
                 VALUES(?, ?, 'page', ?, ?)
                 ON CONFLICT(agent_id) DO UPDATE SET
                   epoch = excluded.epoch, authority_kind = excluded.authority_kind,
                   session_id = excluded.session_id, updated_at = excluded.updated_at`,
              ).run(
                durableGrant.agentId,
                durableGrant.authorityEpoch,
                durableGrant.sessionId,
                durableGrant.lastUsedAt,
              );
            });
              grant = db
                .prepare(
                  `SELECT token_hash, human_session_hash, agent_id, created_at,
                          expires_at, last_used_at, revoked_at, session_id, authority_epoch
                   FROM webmcp_grants wg
                   ${pageAuthorityJoin}
                   WHERE wg.token_hash = ? AND wg.human_session_hash = ?
                     AND wg.revoked_at IS NULL AND wg.expires_at > ?`,
                )
                .get(tokenHash, human.sessionHash, database.now()) as WebMcpGrantRow | undefined;
            }
          }
        } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The session store is unavailable.",
        );
      }
    }
    if (!grant) return null;
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(grant.agent_id) as
      | (AgentRow & { public_key_pem: string })
      | undefined;
    if (!agent || agent.owner_account_id !== human.accountId) return null;
    return { grant, agent };
  };

  const requireWebMcp = async (request: IncomingMessage): Promise<WebMcpPrincipal> => {
    const human = await requireHuman(request);
    const active = await readWebMcpGrant(request, human);
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
      sessionId: active.grant.session_id,
      authorityEpoch: active.grant.authority_epoch,
      human,
      grant: { ...active.grant, last_used_at: now },
      agent: active.agent,
    };
  };

  const assertCurrentAgentSession = (
    principal: AgentPrincipal,
    options: { allowStaleHeartbeat?: boolean } = {},
  ): void => {
    const active = db
      .prepare(
        `SELECT 1 AS active
         FROM agent_sessions s
         JOIN agent_authority aa ON aa.agent_id = s.agent_id
           AND aa.authority_kind = 'native'
           AND aa.session_id = s.session_id
           AND aa.epoch = s.authority_epoch
         WHERE s.token_hash = ? AND s.agent_id = ? AND s.expires_at > ?
           AND s.status = 'active' AND (? = 1 OR s.last_seen_at >= ?)`,
      )
      .get(
        principal.sessionHash,
        principal.agentId,
        database.now(),
        options.allowStaleHeartbeat ? 1 : 0,
        addSeconds(database.clock.now(), -runtimeOfflineSeconds),
      );
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
         ${pageAuthorityJoin}
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

  const createHumanSession = async (accountId: string) => {
    const token = randomToken();
    const csrfToken = randomToken(24);
    const nowDate = database.clock.now();
    const now = nowDate.toISOString();
    const expiresAt = addSeconds(nowDate, HUMAN_SESSION_SECONDS);
    db.prepare(
      `INSERT INTO human_sessions(
         token_hash, account_id, csrf_token, created_at, expires_at,
         last_seen_at, absolute_expires_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(sha256(token), accountId, csrfToken, now, expiresAt, now, expiresAt);
    if (repository) {
      try {
        await repository.createHumanSession({
          tokenHash: sha256(token),
          accountId,
          csrfToken,
          createdAt: now,
          expiresAt,
          absoluteExpiresAt: expiresAt,
        });
      } catch (error) {
        db.prepare("DELETE FROM human_sessions WHERE token_hash = ?").run(sha256(token));
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The session store is unavailable.",
        );
      }
    }
    return { token, csrfToken, expiresAt };
  };

  const createSocialAccountSession = async (
    provider: Parameters<IdentityVerifier>[0],
    idToken: string,
  ) => {
    if (!identityVerifier) {
      throw new ApiError(
        503,
        "social_auth_unconfigured",
        "Social login is not configured on this Meshr server.",
      );
    }
    let claims;
    try {
      claims = await identityVerifier(provider, idToken);
    } catch {
      throw new ApiError(401, "invalid_identity_token", "The social identity token is invalid.");
    }
    if (claims.provider !== provider) {
      throw new ApiError(401, "invalid_identity_token", "The social identity provider does not match the selected login.");
    }
    if (claims.emailVerified !== true) {
      throw new ApiError(
        403,
        "identity_email_unverified",
        "A verified Google or GitHub identity is required.",
      );
    }
    const email = normalizeEmail(claims.email);
    const displayName = claims.displayName.trim().slice(0, 80) || email.split("@", 1)[0]!;
    const now = database.now();
    let accountId = "";
    if (repository) {
      try {
        const existing = await repository.findAccountByProvider(provider, claims.subject);
        const account = existing ??
          await repository.createSocialAccount({
            provider,
            subject: claims.subject,
            email,
            displayName,
          });
        accountId = account.accountId;
      } catch (error) {
        if (error instanceof Error && error.message === "identity_link_required") {
          throw new ApiError(
            409,
            "identity_link_required",
            "This email already has a Meshr account. Sign in and explicitly link the social identity.",
          );
        }
        throw new ApiError(
          503,
          "identity_store_unavailable",
          error instanceof Error ? error.message : "The identity store is unavailable.",
        );
      }
      database.transaction(() => {
        db.prepare(
          `INSERT OR IGNORE INTO accounts(id, email, display_name, password_hash, created_at)
           VALUES(?, ?, ?, '', ?)`,
        ).run(accountId, email, displayName, now);
        db.prepare(
          `INSERT INTO provider_identities(provider, subject, account_id, email, created_at, last_seen_at)
           VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, subject) DO UPDATE SET
             account_id = excluded.account_id, email = excluded.email, last_seen_at = excluded.last_seen_at`,
        ).run(provider, claims.subject, accountId, email, now, now);
      });
      const session = await createHumanSession(accountId);
      const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId) as unknown as AccountRow;
      return { account, session };
    }
    database.transaction(() => {
      const existingIdentity = db
        .prepare("SELECT account_id FROM provider_identities WHERE provider = ? AND subject = ?")
        .get(provider, claims.subject) as { account_id: string } | undefined;
      if (existingIdentity) {
        const account = db.prepare("SELECT id FROM accounts WHERE id = ?").get(existingIdentity.account_id);
        if (!account) throw new ApiError(401, "identity_unavailable", "The social identity is unavailable.");
        accountId = existingIdentity.account_id;
        db.prepare(
          "UPDATE provider_identities SET email = ?, last_seen_at = ? WHERE provider = ? AND subject = ?",
        ).run(email, now, provider, claims.subject);
      } else {
        const existingEmail = db.prepare("SELECT id FROM accounts WHERE email = ?").get(email) as
          | { id: string }
          | undefined;
        if (existingEmail) {
          throw new ApiError(
            409,
            "identity_link_required",
            "This email already has a Meshr account. Sign in and explicitly link the social identity.",
          );
        }
        accountId = database.id("usr");
        db.prepare(
          `INSERT INTO accounts(id, email, display_name, password_hash, created_at)
           VALUES(?, ?, ?, '', ?)`,
        ).run(accountId, email, displayName, now);
        db.prepare(
          `INSERT INTO provider_identities(provider, subject, account_id, email, created_at, last_seen_at)
           VALUES(?, ?, ?, ?, ?, ?)`,
        ).run(provider, claims.subject, accountId, email, now, now);
      }
    });
    const session = await createHumanSession(accountId!);
    const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId!) as unknown as AccountRow;
    return { account, session };
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

  const ensureMeshAccessAuthoritatively = async (
    agentId: string,
    meshId: string,
  ): Promise<{ id: string; visibility: string; joined: number }> => {
    if (!repository?.findMeshById || !repository.findMeshAgentMembership) {
      return ensureMeshAccess(agentId, meshId);
    }
    let mesh: Awaited<ReturnType<NonNullable<MeshrRepository["findMeshById"]>>>;
    let membership: Awaited<ReturnType<NonNullable<MeshrRepository["findMeshAgentMembership"]>>>;
    try {
      [mesh, membership] = await Promise.all([
        repository.findMeshById(meshId),
        repository.findMeshAgentMembership(meshId, agentId),
      ]);
    } catch (error) {
      throw new ApiError(
        503,
        "authorization_store_unavailable",
        error instanceof Error ? error.message : "The mesh authorization store is unavailable.",
      );
    }
    if (!mesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
    const joined = membership?.status === "joined" ? 1 : 0;
    if (mesh.visibility !== "public" && joined !== 1) {
      throw new ApiError(403, "mesh_access_denied", "The agent cannot access this mesh.");
    }
    return { id: mesh.meshId, visibility: mesh.visibility, joined };
  };

  const ensureAttentionMeshAccessAuthoritatively = async (
    agent: AgentRow,
    agentId: string,
    meshId: string,
  ): Promise<{ id: string; visibility: string; joined: number }> => {
    const browse = requireBrowsePolicy(agent);
    const mesh = await ensureMeshAccessAuthoritatively(agentId, meshId);
    if (browse === "joined" && mesh.joined !== 1) {
      throw new ApiError(
        403,
        "attention_policy_denied",
        "This agent's browse policy is limited to joined meshes.",
      );
    }
    return mesh;
  };

  const ensureMeshMembershipAuthoritatively = async (
    agentId: string,
    meshId: string,
  ): Promise<void> => {
    if (!repository?.findMeshAgentMembership) {
      ensureMeshMembership(agentId, meshId);
      return;
    }
    try {
      const membership = await repository.findMeshAgentMembership(meshId, agentId);
      if (!membership || membership.status !== "joined") {
        throw new ApiError(
          403,
          "mesh_membership_required",
          "The agent must join this mesh before participating.",
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        "authorization_store_unavailable",
        error instanceof Error ? error.message : "The mesh authorization store is unavailable.",
      );
    }
  };

  type MeshRole = "owner" | "steward" | "observer";

  const meshRoleFor = (accountId: string, meshId: string): MeshRole | null => {
    const row = db
      .prepare("SELECT role FROM mesh_human_roles WHERE account_id = ? AND mesh_id = ?")
      .get(accountId, meshId) as { role: MeshRole } | undefined;
    return row?.role ?? null;
  };

  const meshRoleForAuthoritatively = async (
    accountId: string,
    meshId: string,
  ): Promise<MeshRole | null> => {
    if (!repository?.findMeshHumanRole) return meshRoleFor(accountId, meshId);
    try {
      return await repository.findMeshHumanRole(meshId, accountId);
    } catch (error) {
      throw new ApiError(
        503,
        "authorization_store_unavailable",
        error instanceof Error ? error.message : "The mesh authorization store is unavailable.",
      );
    }
  };

  const requireMeshRole = async (
    accountId: string,
    meshId: string,
    allowed: MeshRole[],
  ): Promise<MeshRole> => {
    const role = await meshRoleForAuthoritatively(accountId, meshId);
    if (!role || !allowed.includes(role)) {
      throw new ApiError(403, "mesh_governance_denied", "You do not have the required mesh role.");
    }
    return role;
  };

  // The role table is the source of truth for human access. The mesh's
  // owner_account_id is retained as a display/creation hint, but is kept in
  // sync with the surviving owner so a transferred owner cannot retain
  // private access through a stale creator field.
  const syncCanonicalOwner = (meshId: string): void => {
    const owner = db
      .prepare(
        `SELECT account_id FROM mesh_human_roles
         WHERE mesh_id = ? AND role = 'owner'
         ORDER BY created_at, account_id LIMIT 1`,
      )
      .get(meshId) as { account_id: string } | undefined;
    db.prepare("UPDATE meshes SET owner_account_id = ? WHERE id = ?")
      .run(owner?.account_id ?? null, meshId);
  };

  const readMesh = (meshId: string) => {
    const mesh = db
      .prepare(
        `SELECT id, owner_account_id, name, description, visibility, join_policy, created_at
         FROM meshes WHERE id = ?`,
      )
      .get(meshId) as
      | {
          id: string;
          owner_account_id: string | null;
          name: string;
          description: string;
          visibility: "public" | "unlisted" | "private";
          join_policy: "open" | "approval" | "invite_only";
          created_at: string;
        }
      | undefined;
    if (!mesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
    return mesh;
  };

  const publicMesh = (mesh: ReturnType<typeof readMesh>) => ({
    id: mesh.id,
    ownerId: mesh.owner_account_id ?? "system",
    name: mesh.name,
    description: mesh.description,
    visibility: mesh.visibility,
    joinPolicy: mesh.join_policy,
    createdAt: mesh.created_at,
  });

  const meshSummary = (
    mesh: ReturnType<typeof readMesh>,
    accountId: string,
  ) => {
    const memberAgentIds = db
      .prepare("SELECT agent_id FROM mesh_members WHERE mesh_id = ? ORDER BY agent_id")
      .all(mesh.id)
      .map((raw) => (raw as { agent_id: string }).agent_id);
    const topics = db
      .prepare(
        `SELECT t.id, t.mesh_id, t.name, t.title, t.description, t.tags_json, t.created_at,
                COUNT(CASE WHEN p.moderation_state = 'published'
                                AND (p.expires_at IS NULL OR p.expires_at > ?) THEN 1 END) AS activity_count,
                COUNT(CASE WHEN p.moderation_state = 'published'
                                AND (p.expires_at IS NULL OR p.expires_at > ?)
                                AND p.created_at >= ? THEN 1 END) AS recent_activity_count,
                MAX(CASE WHEN p.moderation_state = 'published'
                              AND (p.expires_at IS NULL OR p.expires_at > ?) THEN p.created_at END) AS last_activity_at
         FROM topics t
         LEFT JOIN posts p ON p.topic_id = t.id
         WHERE t.mesh_id = ?
         GROUP BY t.id
         ORDER BY t.title, t.id`,
      )
      .all(
        database.now(),
        database.now(),
        addSeconds(new Date(database.now()), -5 * 60),
        database.now(),
        mesh.id,
      )
      .map((raw) => {
        const row = raw as Record<string, string | number | null>;
        const participantAgentIds = db
          .prepare(
            `SELECT DISTINCT p.agent_id
             FROM posts p
             WHERE p.topic_id = ? AND p.moderation_state = 'published'
               AND (p.expires_at IS NULL OR p.expires_at > ?)
             ORDER BY p.agent_id`,
          )
          .all(row.id, database.now())
          .map((entry) => (entry as { agent_id: string }).agent_id);
        return {
          id: row.id,
          meshId: row.mesh_id,
          name: row.name,
          title: row.title,
          description: row.description,
          tags: (() => {
            try {
              return JSON.parse(String(row.tags_json ?? "[]")) as string[];
            } catch {
              return [];
            }
          })(),
          activityCount: Number(row.activity_count ?? 0),
          recentActivityCount: Number(row.recent_activity_count ?? 0),
          participantAgentIds,
          lastActivityAt: row.last_activity_at,
          createdAt: row.created_at,
        };
      });
    const roles = db
      .prepare(
        `SELECT r.account_id, r.role, r.created_at, r.updated_at,
                a.display_name, a.email
         FROM mesh_human_roles r
         JOIN accounts a ON a.id = r.account_id
         WHERE r.mesh_id = ? ORDER BY r.role, r.account_id`,
      )
      .all(mesh.id)
      .map((raw) => {
        const row = raw as Record<string, string>;
        return {
          accountId: row.account_id,
          role: row.role,
          displayName: row.display_name,
          email: row.email,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });
    const viewerRole = roles.find((role) => role.accountId === accountId)?.role;
    const visibleRoles = roles.map((role) => {
      if (viewerRole === "owner" || viewerRole === "steward") return role;
      const { email: _email, ...withoutEmail } = role;
      return withoutEmail;
    });
    return {
      ...publicMesh(mesh),
      role: viewerRole ?? null,
      memberAgentIds,
      agentCount: memberAgentIds.length,
      topics,
      roles: visibleRoles,
    };
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
    context: { sessionId?: string | null; runtimeKind?: RuntimeKind | null } = {},
  ) => {
    const activeSession = agentId
      ? (db
          .prepare(
            `SELECT session_id, runtime_kind FROM agent_sessions
             WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
          )
          .get(agentId) as { session_id: string; runtime_kind: RuntimeKind } | undefined)
      : undefined;
    const sessionId = context.sessionId ?? activeSession?.session_id ?? null;
    const runtimeKind = context.runtimeKind ?? activeSession?.runtime_kind ?? null;
    const eventId = database.id("evt");
    const createdAt = database.now();
    const result = db
      .prepare(
        `INSERT INTO events(type, mesh_id, topic_id, agent_id, data_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`,
      )
      .run(type, meshId, topicId, agentId, JSON.stringify(data), createdAt);
    db.prepare(
      `INSERT INTO outbox_events(
         event_id, schema_version, type, mesh_id, topic_id, agent_id, session_id,
         runtime_kind, payload_json, status, attempts, created_at
       ) VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(
      eventId,
      type,
      meshId,
      topicId,
      agentId,
      sessionId,
      runtimeKind,
      JSON.stringify(data),
      createdAt,
    );
    if (repository?.appendEvent) {
      void repository.appendEvent({
        eventId,
        type,
        meshId,
        topicId,
        agentId,
        sessionId,
        runtimeKind,
        payload: data,
        occurredAt: createdAt,
      }).catch((error: unknown) => {
        console.error(JSON.stringify({
          component: "meshr-api",
          event: "durable_event_append_failed",
          event_id: eventId,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    }
    return Number(result.lastInsertRowid);
  };

  const emitAudit = (input: {
    actorType: "human" | "agent" | "system";
    actorId?: string | null;
    sessionId?: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    data?: unknown;
  }): void => {
    const auditId = database.id("audit");
    const createdAt = database.now();
    db.prepare(
      `INSERT INTO audit_events(
         id, actor_type, actor_id, session_id, action, resource_type, resource_id,
         data_json, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      auditId,
      input.actorType,
      input.actorId ?? null,
      input.sessionId ?? null,
      input.action,
      input.resourceType,
      input.resourceId,
      JSON.stringify(input.data ?? {}),
      createdAt,
    );
    if (repository?.appendAuditEvent) {
      void repository.appendAuditEvent({
        auditId,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        sessionId: input.sessionId ?? null,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        data: input.data ?? {},
        createdAt,
      }).catch((error: unknown) => {
        console.error(JSON.stringify({
          component: "meshr-api",
          event: "durable_audit_append_failed",
          audit_id: auditId,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    }
  };

  type ModerationCaseRow = {
    id: string;
    post_id: string;
    mesh_id: string;
    reason: string;
    state: RepositoryModerationCase["state"];
    severity: RepositoryModerationCase["severity"];
    created_at: string;
    updated_at: string;
    resolved_at: string | null;
    resolution: string | null;
  };

  const moderationCaseFromRow = (row: ModerationCaseRow): RepositoryModerationCase => ({
    caseId: row.id,
    postId: row.post_id,
    meshId: row.mesh_id,
    reason: row.reason,
    state: row.state,
    severity: row.severity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  });

  const localPostRecord = (postId: string): RepositoryPostRecord | null => {
    const row = db.prepare(
      `SELECT id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body,
              moderation_state, moderation_reason, created_at, expires_at
       FROM posts WHERE id = ?`,
    ).get(postId) as {
      id: string;
      mesh_id: string;
      topic_id: string;
      agent_id: string;
      session_id: string;
      parent_post_id: string | null;
      body: string;
      moderation_state: RepositoryPostRecord["moderationState"];
      moderation_reason: string | null;
      created_at: string;
      expires_at: string | null;
    } | undefined;
    return row ? {
      postId: row.id,
      meshId: row.mesh_id,
      topicId: row.topic_id,
      agentId: row.agent_id,
      sessionId: row.session_id,
      parentPostId: row.parent_post_id,
      body: row.body,
      moderationState: row.moderation_state,
      moderationReason: row.moderation_reason,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    } : null;
  };

  const findPostForModeration = async (postId: string): Promise<RepositoryPostRecord | null> => {
    if (repository?.findPostById) {
      try {
        return await repository.findPostById(postId);
      } catch (error) {
        throw new ApiError(
          503,
          "moderation_store_unavailable",
          error instanceof Error ? error.message : "The moderation store is unavailable.",
        );
      }
    }
    return localPostRecord(postId);
  };

  const findMeshForModeration = async (meshId: string): Promise<RepositoryMeshInput | null> => {
    if (repository?.findMeshById) {
      try {
        return await repository.findMeshById(meshId);
      } catch (error) {
        throw new ApiError(
          503,
          "moderation_store_unavailable",
          error instanceof Error ? error.message : "The moderation store is unavailable.",
        );
      }
    }
    const row = db.prepare(
      `SELECT id, owner_account_id, name, description, visibility, join_policy, created_at
       FROM meshes WHERE id = ?`,
    ).get(meshId) as {
      id: string;
      owner_account_id: string | null;
      name: string;
      description: string;
      visibility: RepositoryMeshInput["visibility"];
      join_policy: RepositoryMeshInput["admission"];
      created_at: string;
    } | undefined;
    return row ? {
      meshId: row.id,
      ownerAccountId: row.owner_account_id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      admission: row.join_policy,
      lifecycle: "active",
      createdAt: row.created_at,
      updatedAt: row.created_at,
    } : null;
  };

  const findModerationCaseForRoute = async (caseId: string): Promise<RepositoryModerationCase | null> => {
    if (repository?.findModerationCase) {
      try {
        return await repository.findModerationCase(caseId);
      } catch (error) {
        throw new ApiError(
          503,
          "moderation_store_unavailable",
          error instanceof Error ? error.message : "The moderation store is unavailable.",
        );
      }
    }
    const row = db.prepare(
      `SELECT id, post_id, mesh_id, reason, state, severity, created_at,
              updated_at, resolved_at, resolution
       FROM moderation_cases WHERE id = ?`,
    ).get(caseId) as ModerationCaseRow | undefined;
    return row ? moderationCaseFromRow(row) : null;
  };

  const listModerationCasesForRoute = async (meshId: string): Promise<RepositoryModerationCase[]> => {
    if (repository?.listModerationCases) {
      try {
        return await repository.listModerationCases(meshId);
      } catch (error) {
        throw new ApiError(
          503,
          "moderation_store_unavailable",
          error instanceof Error ? error.message : "The moderation store is unavailable.",
        );
      }
    }
    const rows = db.prepare(
      `SELECT id, post_id, mesh_id, reason, state, severity, created_at,
              updated_at, resolved_at, resolution
       FROM moderation_cases WHERE mesh_id = ? ORDER BY updated_at DESC, id ASC`,
    ).all(meshId) as ModerationCaseRow[];
    return rows.map(moderationCaseFromRow);
  };

  const listJoinRequestsForRoute = async (meshId: string): Promise<RepositoryJoinRequest[]> => {
    if (repository?.listJoinRequests) {
      try {
        return await repository.listJoinRequests(meshId);
      } catch (error) {
        throw new ApiError(
          503,
          "governance_store_unavailable",
          error instanceof Error ? error.message : "The governance store is unavailable.",
        );
      }
    }
    const rows = db.prepare(
      `SELECT id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
       FROM mesh_join_requests WHERE mesh_id = ? ORDER BY created_at ASC, id ASC`,
    ).all(meshId) as Array<{
      id: string;
      mesh_id: string;
      agent_id: string;
      requested_by_account_id: string;
      status: RepositoryJoinRequest["status"];
      created_at: string;
      resolved_at: string | null;
    }>;
    return rows.map((row) => ({
      requestId: row.id,
      meshId: row.mesh_id,
      agentId: row.agent_id,
      requestedByAccountId: row.requested_by_account_id,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    }));
  };

  const findJoinRequestForRoute = async (requestId: string): Promise<RepositoryJoinRequest | null> => {
    if (repository?.findJoinRequest) {
      try {
        return await repository.findJoinRequest(requestId);
      } catch (error) {
        throw new ApiError(
          503,
          "governance_store_unavailable",
          error instanceof Error ? error.message : "The governance store is unavailable.",
        );
      }
    }
    const row = db.prepare(
      `SELECT id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
       FROM mesh_join_requests WHERE id = ?`,
    ).get(requestId) as {
      id: string;
      mesh_id: string;
      agent_id: string;
      requested_by_account_id: string;
      status: RepositoryJoinRequest["status"];
      created_at: string;
      resolved_at: string | null;
    } | undefined;
    return row ? {
      requestId: row.id,
      meshId: row.mesh_id,
      agentId: row.agent_id,
      requestedByAccountId: row.requested_by_account_id,
      status: row.status,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    } : null;
  };

  const resolveJoinRequestForRoute = async (input: {
    requestId: string;
    meshId: string;
    decision: "approved" | "denied";
    resolvedAt: string;
  }): Promise<{ agentId: string; status: "approved" | "denied" } | null> => {
    if (!repository?.resolveJoinRequest) return null;
    try {
      return await repository.resolveJoinRequest(input);
    } catch (error) {
      if (error instanceof Error && error.message === "join_request_not_pending") {
        throw new ApiError(404, "join_request_not_found", "Join request is not pending.");
      }
      if (error instanceof Error && error.message === "agent_mesh_limit_reached") {
        throw new ApiError(429, "agent_mesh_limit_reached", "This agent has reached its mesh limit.");
      }
      throw new ApiError(
        503,
        "governance_store_unavailable",
        error instanceof Error ? error.message : "The governance store is unavailable.",
      );
    }
  };

  const moderationCaseRepresentation = (
    moderationCase: RepositoryModerationCase,
    post: RepositoryPostRecord | null,
    includeBody: boolean,
  ) => ({
    id: moderationCase.caseId,
    postId: moderationCase.postId,
    meshId: moderationCase.meshId,
    reason: moderationCase.reason,
    state: moderationCase.state,
    severity: moderationCase.severity,
    resolution: moderationCase.resolution,
    createdAt: moderationCase.createdAt,
    updatedAt: moderationCase.updatedAt,
    resolvedAt: moderationCase.resolvedAt,
    post: post
      ? {
          id: post.postId,
          meshId: post.meshId,
          topicId: post.topicId,
          agentId: post.agentId,
          parentPostId: post.parentPostId,
          ...(includeBody ? { body: post.body } : {}),
          moderationState: post.moderationState,
          moderationReason: post.moderationReason,
          createdAt: post.createdAt,
          expiresAt: post.expiresAt,
        }
      : null,
  });

  const persistPost = (input: {
    principal: AgentPrincipal;
    meshId: string;
    topicId: string;
    parentPostId: string | null;
    body: string;
    eventType: "post.created" | "reply.created";
  }) => {
    const agent = currentAgentForCommit(input.principal.agentId);
    enforcePostCapacity(agent);
    const postId = database.id("post");
    const createdAt = database.now();
    const moderation = moderatePost(input.body, postId);
    const expiresAt = addSeconds(new Date(createdAt), POST_RETENTION_SECONDS);
    const post = {
      id: postId,
      meshId: input.meshId,
      topicId: input.topicId,
      agentId: input.principal.agentId,
      parentPostId: input.parentPostId,
      body: input.body,
      createdAt,
      moderationState: moderation.state,
      moderationReason: moderation.reason,
      expiresAt,
    };
    db.prepare(
      `INSERT INTO posts(
         id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at,
         moderation_state, moderation_reason, expires_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      post.id,
      post.meshId,
      post.topicId,
      post.agentId,
      post.parentPostId,
      post.body,
      post.createdAt,
      post.moderationState,
      post.moderationReason,
      post.expiresAt,
    );
    if (moderation.asyncReview) {
      db.prepare(
        `INSERT INTO moderation_cases(
           id, post_id, mesh_id, reason, state, severity, created_at, updated_at
         ) VALUES(?, ?, ?, ?, 'queued', ?, ?, ?)`,
      ).run(
        database.id("case"),
        post.id,
        post.meshId,
        moderation.reason ?? "sampled_review",
        moderation.severity,
        createdAt,
        createdAt,
      );
    }
    emitEvent(input.eventType, input.principal.agentId, post.meshId, post.topicId, {
      post,
      reviewQueued: moderation.asyncReview,
    }, {
      sessionId: input.principal.sessionId,
      runtimeKind: input.principal.runtime,
    });
    return {
      post,
      moderation: { state: moderation.state, reviewQueued: moderation.asyncReview },
    };
  };

  const projectAuthoritativePost = (raw: Record<string, unknown>): {
    id: string;
    meshId: string;
    topicId: string;
    agentId: string;
    parentPostId: string | null;
    body: string;
    createdAt: string;
    moderationState: "published" | "quarantined";
    moderationReason: string | null;
    expiresAt: string;
  } => ({
    id: String(raw.post_id),
    meshId: String(raw.mesh_id),
    topicId: String(raw.topic_id),
    agentId: String(raw.agent_id),
    parentPostId: raw.parent_post_id == null ? null : String(raw.parent_post_id),
    body: String(raw.body),
    createdAt: String(raw.created_at),
    moderationState: raw.moderation_state === "quarantined" ? "quarantined" : "published",
    moderationReason: raw.moderation_reason == null ? null : String(raw.moderation_reason),
    expiresAt: String(raw.expires_at),
  });

  /**
   * Firestore mode commits the post and event outbox in one authoritative
   * transaction, then writes a small SQLite projection for low-latency reads
   * and local event cursors. The projection is disposable; a retry is safe via
   * the repository's idempotency record.
   */
  const persistPostAuthoritatively = async (input: {
    principal: AgentPrincipal;
    meshId: string;
    topicId: string;
    parentPostId: string | null;
    body: string;
    eventType: "post.created" | "reply.created";
    idempotencyKey: string;
    requestHash: string;
  }) => {
    if (!repository) {
      return persistPost(input);
    }
    const agent = currentAgentForCommit(input.principal.agentId);
    enforcePostCapacity(agent);
    const postId = database.id("post");
    const createdAt = database.now();
    const moderation = moderatePost(input.body, postId);
    const expiresAt = addSeconds(new Date(createdAt), POST_RETENTION_SECONDS);
    const pagePrincipal = isWebMcpPrincipal(input.principal) ? input.principal : undefined;
    const repositoryInput: RepositoryPostInput = {
      postId,
      meshId: input.meshId,
      topicId: input.topicId,
      agentId: input.principal.agentId,
      sessionId: input.principal.sessionId ?? "",
      parentPostId: input.parentPostId,
      body: input.body,
      moderationState: moderation.state,
      moderationReason: moderation.reason,
      moderationSeverity: moderation.severity,
      expiresAt,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      reviewQueued: moderation.asyncReview,
      authorityKind: pagePrincipal ? "page" : "native",
      authorityEpoch: input.principal.authorityEpoch,
      ownerAccountId: agent.owner_account_id,
      grantId: pagePrincipal ? pagePrincipal.grant.token_hash : undefined,
      humanSessionHash: pagePrincipal ? pagePrincipal.human.sessionHash : undefined,
    };
    const committed = await repository.createPostWithOutbox(repositoryInput);
    const post = projectAuthoritativePost(committed.post);
    database.transaction(() => {
      const existing = db.prepare("SELECT 1 FROM posts WHERE id = ?").get(post.id);
      if (existing) return;
      db.prepare(
        `INSERT INTO posts(
           id, mesh_id, topic_id, agent_id, parent_post_id, body, created_at,
           moderation_state, moderation_reason, expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        post.id,
        post.meshId,
        post.topicId,
        post.agentId,
        post.parentPostId,
        post.body,
        post.createdAt,
        post.moderationState,
        post.moderationReason,
        post.expiresAt,
      );
      db.prepare(
        `INSERT INTO events(type, mesh_id, topic_id, agent_id, data_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`
      ).run(
        input.eventType,
        post.meshId,
        post.topicId,
        post.agentId,
        JSON.stringify({ post, eventId: post.id, authoritative: true }),
        post.createdAt,
      );
    });
    return {
      post,
      moderation: {
        // The repository is authoritative on retries. In particular, a
        // sampled moderation decision is derived from the committed post ID;
        // recomputing it for a duplicate request could otherwise return a
        // different HTTP status than the original write.
        state: post.moderationState,
        reviewQueued: post.moderationState === "quarantined" || Boolean(post.moderationReason),
      },
      duplicate: committed.duplicate,
    };
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

  const executePostMutation = async (input: {
    principal: AgentPrincipal;
    operation: "post.create" | "reply.create";
    key: string;
    requestValue: unknown;
    post: {
      meshId: string;
      topicId: string;
      parentPostId: string | null;
      body: string;
      eventType: "post.created" | "reply.created";
    };
    authorizeCommit?: () => void;
  }): Promise<{ status: number; body: unknown }> => {
    if (!repository) {
      return idempotent(
        input.principal,
        input.operation,
        input.key,
        input.requestValue,
        () => {
          const result = persistPost({ principal: input.principal, ...input.post });
          return {
            status: result.moderation.state === "quarantined" ? 202 : 201,
            body: result,
          };
        },
        input.authorizeCommit,
      );
    }
    input.authorizeCommit?.();
    let result;
    try {
      result = await persistPostAuthoritatively({
        principal: input.principal,
        ...input.post,
        idempotencyKey: input.key,
        requestHash: sha256(JSON.stringify(input.requestValue)),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "rate_limited") {
        throw new ApiError(
          429,
          "global_rate_limited",
          "Meshr is processing the maximum write rate. Retry after the indicated delay.",
          1,
        );
      }
      if (error instanceof Error && error.message === "session_superseded") {
        throw new ApiError(401, "agent_authentication_failed", "This authority is no longer current.");
      }
      if (error instanceof Error && error.message === "session_invalid") {
        throw new ApiError(401, "agent_authentication_failed", "This session is no longer active.");
      }
      if (error instanceof Error && error.message === "binding_invalid") {
        throw new ApiError(401, "agent_authentication_failed", "This agent binding is no longer valid.");
      }
      if (error instanceof Error && error.message === "idempotency_conflict") {
        throw new ApiError(
          409,
          "idempotency_conflict",
          "This idempotency key was already used for a different request.",
        );
      }
      if (error instanceof Error && error.message === "idempotency_expired") {
        throw new ApiError(
          409,
          "idempotency_expired",
          "The idempotency record has expired; retry with a new key.",
        );
      }
      if (error instanceof Error && error.message === "mesh_unavailable") {
        throw new ApiError(409, "mesh_unavailable", "This mesh is not accepting new activity.");
      }
      if (error instanceof Error && error.message === "mesh_not_found") {
        throw new ApiError(404, "mesh_not_found", "Mesh not found.");
      }
      if (error instanceof Error && error.message === "topic_not_found") {
        throw new ApiError(404, "topic_not_found", "Topic not found.");
      }
      if (error instanceof Error && error.message === "post_not_found") {
        throw new ApiError(404, "post_not_found", "Post not found.");
      }
      if (error instanceof Error && error.message === "mesh_membership_required") {
        throw new ApiError(
          403,
          "mesh_membership_required",
          "The agent must join this mesh before participating.",
        );
      }
      if (error instanceof Error && error.message === "attention_policy_denied") {
        throw new ApiError(
          403,
          "attention_policy_denied",
          "This agent's attention policy does not permit autonomous participation for this operation.",
        );
      }
      if (error instanceof Error && error.message === "agent_not_found") {
        throw new ApiError(401, "agent_authentication_failed", "Agent no longer exists.");
      }
      throw error;
    }
    return {
      status: result.moderation.state === "quarantined" ? 202 : 201,
      body: result,
    };
  };

  const route = async (request: IncomingMessage, url: URL): Promise<RouteResult> => {
    const method = request.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/healthz") {
      const migration = db
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number };
      return {
        // Keep the health response contract stable while migrations remain
        // additive and observable through the database migration table.
        body: { status: "ok", database: "ok", schemaVersion: 2 },
      };
    }

    if (method === "GET" && path === "/readyz") {
      try {
        if (repository?.checkReady) await repository.checkReady();
        else {
          db.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get();
        }
        return { body: { status: "ready", database: repository ? "firestore" : "sqlite" } };
      } catch (error) {
        throw new ApiError(
          503,
          "dependencies_unavailable",
          error instanceof Error ? error.message : "The Meshr dependencies are unavailable.",
        );
      }
    }

    if (method === "GET" && path === "/v1/config/auth") {
      return {
        body: {
          socialOnly: socialAuthOnly,
          providers: ["google", "github"],
          identityPlatformConfigured: Boolean(identityVerifier && identityApiKey),
          firebase:
            identityVerifier && identityApiKey && identityProjectId && identityAuthDomain
              ? {
                  apiKey: identityApiKey,
                  authDomain: identityAuthDomain,
                  projectId: identityProjectId,
                }
              : undefined,
        },
      };
    }

    if (method === "POST" && path === "/v1/auth/state") {
      if (socialAuthOnly && (!identityVerifier || !identityApiKey)) {
        throw new ApiError(
          503,
          "social_auth_unconfigured",
          "Identity Platform social login is not configured on this Meshr server.",
        );
      }
      const state = randomToken(32);
      return {
        status: 201,
        headers: { "Set-Cookie": oauthStateCookie(state, secureCookies) },
        body: { state, expiresInSeconds: 600 },
      };
    }

    const socialStartMatch = matchingPath(path, /^\/v1\/auth\/(google|github)\/start$/);
    if (method === "GET" && socialStartMatch) {
      const provider = socialStartMatch[1] as "google" | "github";
      const environmentKey =
        provider === "google" ? "MESHR_GOOGLE_AUTH_URL" : "MESHR_GITHUB_AUTH_URL";
      const target = process.env[environmentKey]?.trim();
      if (!target) {
        throw new ApiError(
          503,
          "social_auth_unconfigured",
          `${provider} sign-in is not configured on this Meshr server.`,
        );
      }
      let redirect: URL;
      try {
        redirect = new URL(target);
      } catch {
        throw new ApiError(503, "social_auth_unconfigured", "The social sign-in URL is invalid.");
      }
      if (redirect.protocol !== "https:" && redirect.hostname !== "localhost") {
        throw new ApiError(503, "social_auth_unconfigured", "The social sign-in URL must use HTTPS.");
      }
      const state = randomToken(32);
      redirect.searchParams.set("state", state);
      return {
        status: 302,
        headers: {
          Location: redirect.toString(),
          "Set-Cookie": oauthStateCookie(state, secureCookies),
        },
        body: { provider, state },
      };
    }

    if (method === "POST" && path === "/v1/accounts") {
      if (socialAuthOnly) {
        throw new ApiError(
          410,
          "social_auth_required",
          "Meshr public accounts use Google or GitHub sign-in.",
        );
      }
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
      const session = await createHumanSession(account.id);
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
      if (socialAuthOnly) {
        throw new ApiError(
          410,
          "social_auth_required",
          "Meshr public accounts use Google or GitHub sign-in.",
        );
      }
      const input = asObject(await readJson(request));
      const email = normalizeEmail(requiredString(input, "email", { max: 254 }));
      const password = requiredString(input, "password", { min: 1, max: 256 });
      const account = db.prepare("SELECT * FROM accounts WHERE email = ?").get(email) as
        | AccountRow
        | undefined;
      const valid = account && account.password_hash
        ? await verifyPassword(password, account.password_hash)
        : (await hashPassword(password), false);
      if (!account || !valid) {
        throw new ApiError(401, "invalid_credentials", "Email or password is incorrect.");
      }
      const session = await createHumanSession(account.id);
      return {
        headers: { "Set-Cookie": sessionCookie(session.token, secureCookies) },
        body: {
          user: publicUser(account),
          csrfToken: session.csrfToken,
          sessionExpiresAt: session.expiresAt,
        },
      };
    }

    if (method === "POST" && path === "/v1/sessions/social") {
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (key !== "provider" && key !== "idToken" && key !== "state") {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const provider = parseSocialProvider(input.provider);
      const idToken = requiredString(input, "idToken", { max: 16_384 });
      const state = input.state === undefined ? undefined : requiredString(input, "state", { max: 256 });
      if (socialAuthOnly) {
        const expectedState = parseCookies(request.headers.cookie).meshr_oauth_state;
        if (!state || !expectedState || !constantTimeStringEqual(state, expectedState)) {
          throw new ApiError(403, "oauth_state_failed", "The social sign-in state is invalid or expired.");
        }
      }
      const result = await createSocialAccountSession(provider, idToken);
      return {
        status: 201,
        headers: {
          "Set-Cookie": [
            sessionCookie(result.session.token, secureCookies),
            ...(state ? [clearOauthStateCookie(secureCookies)] : []),
          ],
        },
        body: {
          user: publicUser(result.account),
          csrfToken: result.session.csrfToken,
          sessionExpiresAt: result.session.expiresAt,
          provider,
        },
      };
    }

    if (method === "GET" && path === "/v1/me") {
      const principal = await requireHuman(request);
      const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(principal.accountId) as
        | AccountRow
        | undefined;
      if (!account) throw new ApiError(401, "authentication_required", "Sign in is required.");
      return { body: { user: publicUser(account), csrfToken: principal.csrfToken } };
    }

    if (method === "POST" && path === "/v1/account/providers/link") {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (key !== "provider" && key !== "idToken") {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const provider = parseSocialProvider(input.provider);
      const idToken = requiredString(input, "idToken", { max: 16_384 });
      if (!identityVerifier) {
        throw new ApiError(503, "social_auth_unconfigured", "Social login is not configured.");
      }
      let claims;
      try {
        claims = await identityVerifier(provider, idToken);
      } catch {
        throw new ApiError(401, "invalid_identity_token", "The social identity token is invalid.");
      }
      if (claims.provider !== provider) {
        throw new ApiError(401, "invalid_identity_token", "The social identity provider does not match the selected login.");
      }
      const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(principal.accountId) as
        | AccountRow
        | undefined;
      if (!account) throw new ApiError(401, "authentication_required", "Sign in is required.");
      if (claims.emailVerified !== true) {
        throw new ApiError(
          403,
          "identity_email_unverified",
          "A verified Google or GitHub identity is required.",
        );
      }
      const now = database.now();
      if (repository) {
        try {
          await repository.linkProvider({
            accountId: principal.accountId,
            provider,
            subject: claims.subject,
            email: normalizeEmail(claims.email),
          });
        } catch (error) {
          if (error instanceof Error && error.message === "identity_already_linked") {
            throw new ApiError(409, "identity_already_linked", "That social identity belongs to another account.");
          }
          if (error instanceof Error && error.message === "account_not_found") {
            throw new ApiError(401, "authentication_required", "Sign in is required.");
          }
          throw new ApiError(
            503,
            "identity_store_unavailable",
            error instanceof Error ? error.message : "The identity store is unavailable.",
          );
        }
      }
      const linked = database.transaction(() => {
        const existing = db
          .prepare("SELECT account_id FROM provider_identities WHERE provider = ? AND subject = ?")
          .get(provider, claims.subject) as { account_id: string } | undefined;
        if (existing && existing.account_id !== principal.accountId) {
          throw new ApiError(409, "identity_already_linked", "That social identity belongs to another account.");
        }
        db.prepare(
          `INSERT INTO provider_identities(provider, subject, account_id, email, created_at, last_seen_at)
           VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, subject) DO UPDATE SET email = excluded.email, last_seen_at = excluded.last_seen_at`,
        ).run(provider, claims.subject, principal.accountId, normalizeEmail(claims.email), now, now);
        return { provider, subject: claims.subject, linkedAt: now };
      });
      return { status: 201, body: { identity: linked } };
    }

    if (method === "GET" && path === "/v1/agents") {
      const principal = await requireHuman(request);
      const onlineAfter = addSeconds(database.clock.now(), -runtimeOfflineSeconds);
      const rows = db
        .prepare(
          `SELECT a.*,
             (SELECT MAX(s.last_seen_at) FROM agent_sessions s
              WHERE s.agent_id = a.id AND s.status = 'active') AS last_seen_at,
             EXISTS(
               SELECT 1 FROM agent_sessions s
               WHERE s.agent_id = a.id AND s.status = 'active'
                 AND s.expires_at > ? AND s.last_seen_at >= ?
             ) AS connected
           FROM agents a
           WHERE a.owner_account_id = ?
           ORDER BY a.created_at ASC, a.id ASC`,
        )
        .all(database.now(), onlineAfter, principal.accountId) as unknown as Array<
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
      const principal = await requireHuman(request);
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
      await durableWrite("agent profile update", async () => {
        await repository?.upsertAgent?.(repositoryAgent(updated));
      });
      return { body: { agent: agentFromRow(updated) } };
    }

    const bindingMatch = matchingPath(path, /^\/v1\/agents\/([^/]+)\/binding$/);
    if (method === "DELETE" && bindingMatch) {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const agentId = decodeURIComponent(bindingMatch[1]);
      const owned = db
        .prepare("SELECT 1 AS owned FROM agents WHERE id = ? AND owner_account_id = ?")
        .get(agentId, principal.accountId);
      if (!owned) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      const now = database.now();
      await durableWrite("agent binding revoke", async () => {
        await repository?.revokeAgent?.(agentId, now);
      });
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
      const human = await requireHuman(request);
      const active = await readWebMcpGrant(request, human);
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
      const human = await requireHuman(request);
      requireCsrf(request, human);
      assertCostProtectionAllows("session");
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
      let connected = db
        .prepare(
          `SELECT 1 AS connected FROM agent_sessions
           WHERE agent_id = ? AND status = 'active' AND expires_at > ?
             AND last_seen_at >= ? LIMIT 1`,
        )
        .get(agent.id, database.now(), addSeconds(database.clock.now(), -runtimeOfflineSeconds));
      if (!connected && repository?.findActiveRuntimeSessionForAgent) {
        try {
          const durableSession = await repository.findActiveRuntimeSessionForAgent(
            agent.id,
            database.now(),
            addSeconds(database.clock.now(), -runtimeOfflineSeconds),
          );
          if (durableSession) {
            await hydrateDurableAgentSession(durableSession.tokenHash, database.now());
            connected = { connected: 1 };
          }
        } catch (error) {
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The session store is unavailable.",
          );
        }
      }
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
      let transferSessionId = database.id("page");
      let authoritativeEpoch: number | undefined;
      if (repository && webMcpTransfersSession) {
        try {
          const committed = await repository.transferPageAuthority({
            agentId: agent.id,
            grantId: tokenHash,
            humanSessionHash: human.sessionHash,
            expiresAt,
          });
          transferSessionId = committed.sessionId;
          authoritativeEpoch = committed.authorityEpoch;
        } catch (error) {
          if (error instanceof Error && error.message === "session_invalid") {
            throw new ApiError(
              401,
              "webmcp_session_invalid",
              "The human session or native agent session is no longer active.",
            );
          }
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The session store is unavailable.",
          );
        }
      }
      database.transaction(() => {
        db.prepare(
          `UPDATE webmcp_grants SET revoked_at = ?
           WHERE ${webMcpTransfersSession ? "agent_id = ?" : "human_session_hash = ?"}
             AND revoked_at IS NULL`,
        ).run(now, webMcpTransfersSession ? agent.id : human.sessionHash);
        let authorityEpoch = readAuthority(agent.id)?.epoch ?? 0;
        if (webMcpTransfersSession) {
          const superseded = db
            .prepare(
              `UPDATE agent_sessions
               SET status = 'superseded', superseded_by = ?, expires_at = ?
               WHERE agent_id = ? AND status = 'active'`,
            )
            .run(transferSessionId, now, agent.id);
          authorityEpoch = authoritativeEpoch ?? advanceAuthority(agent.id, "page", transferSessionId, now);
          if (authoritativeEpoch !== undefined) {
            db.prepare(
              `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
               VALUES(?, ?, 'page', ?, ?)
               ON CONFLICT(agent_id) DO UPDATE SET
                 epoch = excluded.epoch,
                 authority_kind = excluded.authority_kind,
                 session_id = excluded.session_id,
                 updated_at = excluded.updated_at`,
            ).run(agent.id, authorityEpoch, transferSessionId, now);
          }
          if (superseded.changes > 0) {
            emitAudit({
              actorType: "human",
              actorId: human.accountId,
              sessionId: human.sessionHash,
              action: "webmcp.session.transferred",
              resourceType: "agent",
              resourceId: agent.id,
              data: { transferSessionId, authorityEpoch },
            });
            emitEvent("agent.session.transferred", agent.id, null, null, {
              agentId: agent.id,
              transferSessionId,
              authority: "page_webmcp",
            }, { sessionId: transferSessionId, runtimeKind: agent.runtime });
          }
        }
        db.prepare(
          `INSERT INTO webmcp_grants(
             token_hash, human_session_hash, agent_id, created_at,
             expires_at, last_used_at, revoked_at, session_id, authority_epoch
           ) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        ).run(
          tokenHash,
          human.sessionHash,
          agent.id,
          now,
          expiresAt,
          now,
          transferSessionId,
          authorityEpoch,
        );
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
      const human = await requireHuman(request);
      requireCsrf(request, human);
      const now = database.now();
      await durableWrite("WebMCP grant revoke", async () => {
        await repository?.revokeWebMcpGrants?.(human.sessionHash, now);
      });
      db.prepare(
        `UPDATE webmcp_grants SET revoked_at = ?
         WHERE human_session_hash = ? AND revoked_at IS NULL`,
      ).run(now, human.sessionHash);
      return {
        body: { enabled: false, agent: null, createdAt: null, expiresAt: null },
        headers: { "Set-Cookie": clearWebMcpCookie(secureCookies) },
      };
    }

    if (method === "GET" && path === "/v1/activity/public") {
      const principal = await requireHuman(request);
      return {
        body: readPublicActivity(db, principal.accountId, database.now()),
      };
    }

    // The live gateway is a separate process, but it must never make its own
    // visibility decision from a client-supplied mesh id.  It calls this
    // narrow endpoint with the browser cookie (or an agent bearer grant) and
    // receives the same access decision used by the API read paths.
    if (method === "GET" && path === "/v1/live/authorize") {
      const meshId = requiredString(
        { meshId: url.searchParams.get("meshId") ?? undefined },
        "meshId",
        { max: 128 },
      );
      const authorization = request.headers.authorization ?? "";
      if (authorization.startsWith("Bearer ")) {
        const principal = await requireAgent(request);
        const agent = db
          .prepare("SELECT * FROM agents WHERE id = ?")
          .get(principal.agentId) as unknown as AgentRow;
        await ensureAttentionMeshAccessAuthoritatively(agent, principal.agentId, meshId);
        return {
          body: {
            allowed: true,
            principal: "agent",
            meshId,
            cursor: Number(
              (db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE mesh_id = ?")
                .get(meshId) as { sequence: number }).sequence ?? 0,
            ),
          },
        };
      }
      const principal = await requireHuman(request);
      const mesh = readMesh(meshId);
      const role = await meshRoleForAuthoritatively(principal.accountId, meshId);
      const allowed =
        mesh.visibility !== "private" ||
        role !== null;
      if (!allowed) {
        throw new ApiError(403, "mesh_access_denied", "You do not have access to this mesh.");
      }
      return {
        body: {
          allowed: true,
          principal: "human",
          meshId,
          cursor: Number(
            (db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE mesh_id = ?")
              .get(meshId) as { sequence: number }).sequence ?? 0,
          ),
        },
      };
    }

    if (method === "GET" && path === "/v1/meshes") {
      const principal = await requireHuman(request);
      const meshes = db
        .prepare(
          `SELECT m.id, m.owner_account_id, m.name, m.description, m.visibility,
                  m.join_policy, m.created_at,
                  r.role,
                  (SELECT COUNT(*) FROM mesh_members mm WHERE mm.mesh_id = m.id) AS agent_count
           FROM meshes m
           LEFT JOIN mesh_human_roles r
             ON r.mesh_id = m.id AND r.account_id = ?
           WHERE r.role IS NOT NULL
              OR m.visibility = 'public'
           ORDER BY m.created_at ASC, m.id ASC`,
        )
        .all(principal.accountId)
        .map((raw) => meshSummary(readMesh(String((raw as { id: string }).id)), principal.accountId));
      return { body: { meshes } };
    }

    if (method === "POST" && path === "/v1/meshes") {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      assertCostProtectionAllows("mesh");
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (!["name", "description", "visibility", "joinPolicy", "agentIds"].includes(key)) {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const name = requiredString(input, "name", { max: 80 });
      const description = optionalString(input, "description", 500) ?? "";
      const visibility = input.visibility === undefined ? "private" : input.visibility;
      if (visibility !== "public" && visibility !== "unlisted" && visibility !== "private") {
        throw new ApiError(400, "invalid_mesh", "visibility must be public, unlisted, or private.");
      }
      const defaultJoinPolicy = visibility === "public" ? "open" : "invite_only";
      const joinPolicy = input.joinPolicy === undefined ? defaultJoinPolicy : input.joinPolicy;
      if (joinPolicy !== "open" && joinPolicy !== "approval" && joinPolicy !== "invite_only") {
        throw new ApiError(400, "invalid_mesh", "joinPolicy is invalid.");
      }
      const agentIds = input.agentIds === undefined
        ? []
        : (() => {
            if (!Array.isArray(input.agentIds) || input.agentIds.length > MAX_AGENTS_PER_ACCOUNT) {
              throw new ApiError(400, "invalid_mesh", "agentIds must be an array of connected agents.");
            }
            const unique = [...new Set(input.agentIds.map((value) => {
              if (typeof value !== "string" || !value.trim() || value.length > 128) {
                throw new ApiError(400, "invalid_mesh", "agentIds must contain valid agent IDs.");
              }
              return value.trim();
            }))];
            const owned = db
              .prepare("SELECT id FROM agents WHERE owner_account_id = ?")
              .all(principal.accountId)
              .map((raw) => (raw as { id: string }).id);
            const ownedSet = new Set(owned);
            if (unique.some((agentId) => !ownedSet.has(agentId))) {
              throw new ApiError(403, "agent_access_denied", "Only your connected agents can join a new mesh.");
            }
            return unique;
          })();
      const ownedCount = db
        .prepare("SELECT COUNT(*) AS count FROM meshes WHERE owner_account_id = ?")
        .get(principal.accountId) as { count: number };
      if (Number(ownedCount.count) >= MAX_OWNED_MESHES_PER_ACCOUNT) {
        throw new ApiError(429, "mesh_limit_reached", "This account has reached its mesh limit.");
      }
      const now = database.now();
      const meshId = database.id("mesh");
      const topicId = database.id("topic");
      await durableWrite("mesh create", async () => {
        const meshInput: RepositoryMeshInput = {
          meshId,
          ownerAccountId: principal.accountId,
          name,
          description,
          visibility,
          admission: joinPolicy,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
        };
        await repository?.upsertMesh?.(meshInput);
        const topicInput: RepositoryTopicInput = {
          topicId,
          meshId,
          name: "general",
          title: "General",
          description: "A place for agents to begin a conversation.",
          tags: [],
          createdAt: now,
        };
        await repository?.upsertTopic?.(topicInput);
        await repository?.upsertMeshHumanRole?.({
          meshId,
          accountId: principal.accountId,
          role: "owner",
          createdAt: now,
          updatedAt: now,
        });
        for (const agentId of agentIds) {
          await repository?.upsertMeshAgentMembership?.({
            meshId,
            agentId,
            status: "joined",
            attentionPolicy: {},
            admissionProvenance: "invite",
            joinedAt: now,
            updatedAt: now,
          });
        }
      });
      const mesh = database.transaction(() => {
        db.prepare(
          `INSERT INTO meshes(
             id, owner_account_id, name, description, visibility, join_policy, created_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?)`,
        ).run(meshId, principal.accountId, name, description, visibility, joinPolicy, now);
        db.prepare(
          `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
           VALUES(?, ?, 'owner', ?, ?)`,
        ).run(meshId, principal.accountId, now, now);
        db.prepare(
          `INSERT INTO topics(id, mesh_id, name, title, description, tags_json, created_at)
           VALUES(?, ?, 'general', 'General', 'A place for agents to begin a conversation.', '[]', ?)`,
        ).run(topicId, meshId, now);
        const memberInsert = db.prepare(
          "INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
        );
        for (const agentId of agentIds) memberInsert.run(meshId, agentId, now);
        emitAudit({
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: "mesh.created",
          resourceType: "mesh",
          resourceId: meshId,
          data: { visibility, joinPolicy },
        });
        emitEvent("mesh.created", null, meshId, topicId, {
          meshId,
          ownerAccountId: principal.accountId,
          visibility,
          joinPolicy,
        });
        return { id: meshId, topicId };
      });
      return {
        status: 201,
        body: {
          mesh: meshSummary(readMesh(mesh.id), principal.accountId),
          topic: meshSummary(readMesh(mesh.id), principal.accountId).topics.find(
            (topic) => topic.id === mesh.topicId,
          ),
        },
      };
    }

    const meshGovernanceMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/governance$/);
    if (meshGovernanceMatch && (method === "GET" || method === "PUT")) {
      const principal = await requireHuman(request);
      const meshId = decodeURIComponent(meshGovernanceMatch[1]);
      const mesh = readMesh(meshId);
      if (method === "GET") {
        const role = await meshRoleForAuthoritatively(principal.accountId, meshId);
        if (!role && mesh.visibility !== "public") {
          throw new ApiError(403, "mesh_access_denied", "You cannot view this mesh governance.");
        }
        const roles = db
          .prepare(
            `SELECT r.account_id, r.role, r.created_at, r.updated_at,
                    a.display_name, a.email
             FROM mesh_human_roles r
             JOIN accounts a ON a.id = r.account_id
             WHERE r.mesh_id = ? ORDER BY r.role, r.account_id`,
          )
          .all(meshId)
          .map((raw) => {
            const row = raw as Record<string, string>;
            const roleSummary = {
              accountId: row.account_id,
              role: row.role,
              displayName: row.display_name,
              email: row.email,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            };
            if (role === "owner" || role === "steward") return roleSummary;
            const { email: _email, ...withoutEmail } = roleSummary;
            return withoutEmail;
          });
        return { body: { mesh: meshSummary(mesh, principal.accountId), role, roles } };
      }
      requireCsrf(request, principal);
      await requireMeshRole(principal.accountId, meshId, ["owner"]);
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (!["name", "description", "visibility", "joinPolicy"].includes(key)) {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const name = input.name === undefined ? mesh.name : requiredString(input, "name", { max: 80 });
      const description = input.description === undefined
        ? mesh.description
        : optionalString(input, "description", 500) ?? "";
      const visibility = input.visibility === undefined ? mesh.visibility : input.visibility;
      const joinPolicy = input.joinPolicy === undefined ? mesh.join_policy : input.joinPolicy;
      if (!["public", "unlisted", "private"].includes(String(visibility))) {
        throw new ApiError(400, "invalid_mesh", "visibility must be public, unlisted, or private.");
      }
      if (!["open", "approval", "invite_only"].includes(String(joinPolicy))) {
        throw new ApiError(400, "invalid_mesh", "joinPolicy is invalid.");
      }
      const now = database.now();
      await durableWrite("mesh governance update", async () => {
        await repository?.upsertMesh?.({
          meshId,
          ownerAccountId: mesh.owner_account_id,
          name,
          description,
          visibility: visibility as "public" | "unlisted" | "private",
          admission: joinPolicy as "open" | "approval" | "invite_only",
          lifecycle: "active",
          createdAt: mesh.created_at,
          updatedAt: now,
        });
      });
      database.transaction(() => {
        db.prepare(
          `UPDATE meshes SET name = ?, description = ?, visibility = ?, join_policy = ? WHERE id = ?`,
        ).run(name, description, String(visibility), String(joinPolicy), meshId);
        emitAudit({
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: "mesh.governance.updated",
          resourceType: "mesh",
          resourceId: meshId,
          data: { visibility, joinPolicy },
        });
        emitEvent("mesh.governance.updated", null, meshId, null, {
          meshId,
          visibility,
          joinPolicy,
        });
      });
      return { body: { mesh: meshSummary(readMesh(meshId), principal.accountId) } };
    }

    const meshRoleMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/roles\/([^/]+)$/);
    if ((method === "PUT" || method === "DELETE") && meshRoleMatch) {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(meshRoleMatch[1]);
      const accountId = decodeURIComponent(meshRoleMatch[2]);
      await requireMeshRole(principal.accountId, meshId, ["owner"]);
      readMesh(meshId);
      if (!db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId)) {
        throw new ApiError(404, "account_not_found", "Account not found.");
      }
      if (method === "DELETE") {
        const current = await meshRoleForAuthoritatively(accountId, meshId);
        if (!current) return { body: { meshId, accountId, removed: false } };
        if (current === "owner") {
          const ownerCount = db
            .prepare("SELECT COUNT(*) AS count FROM mesh_human_roles WHERE mesh_id = ? AND role = 'owner'")
            .get(meshId) as { count: number };
          if (Number(ownerCount.count) <= 1) {
            throw new ApiError(409, "last_owner", "Transfer ownership before removing the last owner.");
          }
        }
        const now = database.now();
        await durableWrite("mesh role removal", async () => {
          await repository?.deleteMeshHumanRole?.(meshId, accountId);
        });
        database.transaction(() => {
          db.prepare("DELETE FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?")
            .run(meshId, accountId);
          syncCanonicalOwner(meshId);
          emitAudit({
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.role.removed",
            resourceType: "mesh_human_role",
            resourceId: `${meshId}:${accountId}`,
            data: { role: current },
          });
          emitEvent("mesh.role.removed", null, meshId, null, { meshId, accountId });
        });
        return { body: { meshId, accountId, removed: true } };
      }
      const input = asObject(await readJson(request));
      const role = input.role;
      if (role !== "owner" && role !== "steward" && role !== "observer") {
        throw new ApiError(400, "invalid_role", "role must be owner, steward, or observer.");
      }
      const current = await meshRoleForAuthoritatively(accountId, meshId);
      if (current === "owner" && role !== "owner") {
        const ownerCount = db
          .prepare("SELECT COUNT(*) AS count FROM mesh_human_roles WHERE mesh_id = ? AND role = 'owner'")
          .get(meshId) as { count: number };
        if (Number(ownerCount.count) <= 1) {
          throw new ApiError(409, "last_owner", "A mesh must always retain at least one owner.");
        }
      }
      const now = database.now();
      await durableWrite("mesh role update", async () => {
        await repository?.upsertMeshHumanRole?.({
          meshId,
          accountId,
          role,
          createdAt: now,
          updatedAt: now,
        });
      });
      database.transaction(() => {
        db.prepare(
          `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(mesh_id, account_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
        ).run(meshId, accountId, role, now, now);
        syncCanonicalOwner(meshId);
        emitAudit({
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: "mesh.role.updated",
          resourceType: "mesh_human_role",
          resourceId: `${meshId}:${accountId}`,
          data: { role },
        });
        emitEvent("mesh.role.updated", null, meshId, null, { meshId, accountId, role });
      });
      return { body: { meshId, accountId, role } };
    }

    const meshAgentMembershipMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/agents\/([^/]+)$/,
    );
    if ((method === "PUT" || method === "DELETE") && meshAgentMembershipMatch) {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(meshAgentMembershipMatch[1]);
      const agentId = decodeURIComponent(meshAgentMembershipMatch[2]);
      const mesh = readMesh(meshId);
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      const agent = db
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(agentId) as unknown as AgentRow | undefined;
      if (!agent) throw new ApiError(404, "agent_not_found", "Agent not found.");
      const now = database.now();
      if (method === "PUT") {
        const existing = db
          .prepare("SELECT 1 FROM mesh_members WHERE mesh_id = ? AND agent_id = ?")
          .get(meshId, agentId);
        if (!existing) {
          const count = db
            .prepare("SELECT COUNT(*) AS count FROM mesh_members WHERE agent_id = ?")
            .get(agentId) as { count: number };
          if (Number(count.count) >= MAX_JOINED_MESHES_PER_AGENT) {
            throw new ApiError(429, "agent_mesh_limit_reached", "This agent has reached its mesh limit.");
          }
        }
        await durableWrite("mesh membership update", async () => {
          await repository?.upsertMeshAgentMembership?.({
            meshId,
            agentId,
            status: "joined",
            attentionPolicy: JSON.parse(agent.attention_json) as Record<string, unknown>,
            admissionProvenance: "invite",
            joinedAt: now,
            updatedAt: now,
          });
        });
        database.transaction(() => {
          db.prepare(
            "INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
          ).run(meshId, agentId, now);
          emitAudit({
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.agent.added",
            resourceType: "mesh_agent_membership",
            resourceId: `${meshId}:${agentId}`,
            data: { meshId, agentId },
          });
          emitEvent("mesh.agent.joined", agentId, meshId, null, { meshId, agentId }, {
            sessionId: principal.sessionHash,
          });
        });
        return { status: existing ? 200 : 201, body: { meshId, agentId, status: "joined" } };
      }
      await durableWrite("mesh membership removal", async () => {
        await repository?.upsertMeshAgentMembership?.({
          meshId,
          agentId,
          status: "removed",
          attentionPolicy: {},
          admissionProvenance: "invite",
          joinedAt: null,
          updatedAt: now,
        });
      });
      database.transaction(() => {
        db.prepare("DELETE FROM mesh_members WHERE mesh_id = ? AND agent_id = ?").run(meshId, agentId);
        emitAudit({
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: "mesh.agent.removed",
          resourceType: "mesh_agent_membership",
          resourceId: `${meshId}:${agentId}`,
          data: { meshId, agentId },
        });
        emitEvent("mesh.agent.removed", agentId, meshId, null, { meshId, agentId }, {
          sessionId: principal.sessionHash,
        });
      });
      return { body: { meshId, agentId, status: "removed" } };
    }

    const joinRequestListMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/join-requests$/);
    if (method === "GET" && joinRequestListMatch) {
      const principal = await requireHuman(request);
      const meshId = decodeURIComponent(joinRequestListMatch[1]);
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      const durableRequests = await listJoinRequestsForRoute(meshId);
      const requests = await Promise.all(durableRequests.map(async (joinRequest) => {
        const localAgent = db.prepare("SELECT id, name, handle FROM agents WHERE id = ?")
          .get(joinRequest.agentId) as { id: string; name: string; handle: string } | undefined;
        let agent = localAgent;
        if (!agent && repository?.findAgentById) {
          const durableAgent = await repository.findAgentById(joinRequest.agentId);
          if (durableAgent) {
            agent = { id: durableAgent.agentId, name: durableAgent.name, handle: durableAgent.handle };
          }
        }
        return {
          id: joinRequest.requestId,
          meshId: joinRequest.meshId,
          agentId: joinRequest.agentId,
          requestedByAccountId: joinRequest.requestedByAccountId,
          status: joinRequest.status,
          agent: agent ?? { id: joinRequest.agentId, name: "Unknown agent", handle: "unknown" },
          createdAt: joinRequest.createdAt,
          resolvedAt: joinRequest.resolvedAt,
        };
      }));
      return { body: { requests } };
    }

    const joinRequestResolveMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/join-requests\/([^/]+)\/resolve$/,
    );
    if (method === "POST" && joinRequestResolveMatch) {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(joinRequestResolveMatch[1]);
      const requestId = decodeURIComponent(joinRequestResolveMatch[2]);
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      const input = asObject(await readJson(request));
      if (input.decision !== "approved" && input.decision !== "denied") {
        throw new ApiError(400, "invalid_decision", "decision must be approved or denied.");
      }
      const decision = input.decision;
      const now = database.now();
      const authoritativeOutcome = await resolveJoinRequestForRoute({
        requestId,
        meshId,
        decision,
        resolvedAt: now,
      });
      if (authoritativeOutcome) {
        const resolvedRequest = await findJoinRequestForRoute(requestId);
        if (!resolvedRequest) {
          throw new ApiError(503, "governance_store_unavailable", "The resolved join request could not be read back.");
        }
        database.transaction(() => {
          db.prepare(
            `INSERT INTO mesh_join_requests(
               id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
             ) VALUES(?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, resolved_at = excluded.resolved_at`,
          ).run(
            resolvedRequest.requestId,
            resolvedRequest.meshId,
            resolvedRequest.agentId,
            resolvedRequest.requestedByAccountId,
            resolvedRequest.status,
            resolvedRequest.createdAt,
            resolvedRequest.resolvedAt,
          );
          if (authoritativeOutcome.status === "approved") {
            db.prepare(
              "INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
            ).run(meshId, authoritativeOutcome.agentId, now);
          }
          emitAudit({
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: `mesh.join_request.${decision}`,
            resourceType: "mesh_join_request",
            resourceId: requestId,
            data: { agentId: authoritativeOutcome.agentId, meshId },
          });
          emitEvent(`mesh.agent.${decision}`, authoritativeOutcome.agentId, meshId, null, {
            requestId,
            agentId: authoritativeOutcome.agentId,
            meshId,
          }, { sessionId: principal.sessionHash });
        });
        return {
          body: {
            requestId,
            meshId,
            agentId: authoritativeOutcome.agentId,
            decision,
          },
        };
      }
      const outcome = database.transaction(() => {
        const pending = db
          .prepare(
            `SELECT agent_id FROM mesh_join_requests
             WHERE id = ? AND mesh_id = ? AND status = 'pending'`,
          )
          .get(requestId, meshId) as { agent_id: string } | undefined;
        if (!pending) throw new ApiError(404, "join_request_not_found", "Join request is not pending.");
        db.prepare(
          "UPDATE mesh_join_requests SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'",
        ).run(decision, now, requestId);
        if (decision === "approved") {
          db.prepare(
            "INSERT OR IGNORE INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
          ).run(meshId, pending.agent_id, now);
        }
        emitAudit({
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: `mesh.join_request.${decision}`,
          resourceType: "mesh_join_request",
          resourceId: requestId,
          data: { agentId: pending.agent_id, meshId },
        });
        emitEvent(`mesh.agent.${decision}`, pending.agent_id, meshId, null, {
          requestId,
          agentId: pending.agent_id,
          meshId,
        });
        return pending.agent_id;
      });
      const resolvedRequest = db
        .prepare(
          `SELECT id, mesh_id, agent_id, requested_by_account_id, status, created_at, resolved_at
           FROM mesh_join_requests WHERE id = ?`,
        )
        .get(requestId) as
        | {
            id: string;
            mesh_id: string;
            agent_id: string;
            requested_by_account_id: string;
            status: "pending" | "approved" | "denied" | "cancelled";
            created_at: string;
            resolved_at: string | null;
          }
        | undefined;
      await durableWrite("mesh join request resolution", async () => {
        if (!resolvedRequest) return;
        await repository?.upsertJoinRequest?.({
          requestId: resolvedRequest.id,
          meshId: resolvedRequest.mesh_id,
          agentId: resolvedRequest.agent_id,
          requestedByAccountId: resolvedRequest.requested_by_account_id,
          status: resolvedRequest.status,
          createdAt: resolvedRequest.created_at,
          resolvedAt: resolvedRequest.resolved_at,
        });
        if (resolvedRequest.status === "approved") {
          const joinedAgent = db.prepare("SELECT attention_json FROM agents WHERE id = ?")
            .get(resolvedRequest.agent_id) as { attention_json: string } | undefined;
          await repository?.upsertMeshAgentMembership?.({
            meshId: resolvedRequest.mesh_id,
            agentId: resolvedRequest.agent_id,
            status: "joined",
            attentionPolicy: joinedAgent
              ? (JSON.parse(joinedAgent.attention_json) as Record<string, unknown>)
              : {},
            admissionProvenance: "approval",
            joinedAt: resolvedRequest.resolved_at,
            updatedAt: resolvedRequest.resolved_at ?? database.now(),
          });
        }
      });
      return { body: { requestId, meshId, agentId: outcome, decision } };
    }

    // Humans do not post to Meshr, but owners and stewards can report and
    // resolve agent-produced content. Reports are durable moderation cases;
    // they never mutate the social stream until an explicit review action is
    // taken.
    const postReportMatch = matchingPath(path, /^\/v1\/posts\/([^/]+)\/report$/);
    if (method === "POST" && postReportMatch) {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const postId = decodeURIComponent(postReportMatch[1]);
      const post = await findPostForModeration(postId);
      if (!post) throw new ApiError(404, "post_not_found", "Post not found.");
      const mesh = await findMeshForModeration(post.meshId);
      if (!mesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
      const role = await meshRoleForAuthoritatively(principal.accountId, post.meshId);
      if (mesh.visibility !== "public" && !role) {
        throw new ApiError(403, "mesh_access_denied", "You cannot report content in this mesh.");
      }
      const input = asObject(await readJson(request));
      for (const field of Object.keys(input)) {
        if (field !== "reason") {
          throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
        }
      }
      const reason = optionalString(input, "reason", 500) ?? "reported_by_user";
      const now = database.now();
      const moderationCase: RepositoryModerationCase = {
        caseId: database.id("case"),
        postId,
        meshId: post.meshId,
        reason,
        state: "queued",
        severity: "low",
        resolution: null,
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
      };
      await durableWrite("moderation report", async () => {
        await repository?.upsertModerationCase?.(moderationCase);
      });
      if (localPostRecord(postId)) {
        database.transaction(() => {
          db.prepare(
            `INSERT INTO moderation_cases(
               id, post_id, mesh_id, reason, state, severity, created_at, updated_at
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            moderationCase.caseId,
            moderationCase.postId,
            moderationCase.meshId,
            moderationCase.reason,
            moderationCase.state,
            moderationCase.severity,
            moderationCase.createdAt,
            moderationCase.updatedAt,
          );
          emitAudit({
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "moderation.reported",
            resourceType: "post",
            resourceId: postId,
            data: { caseId: moderationCase.caseId, meshId: post.meshId, reason },
          });
          emitEvent("moderation.reported", post.agentId, post.meshId, post.topicId, {
            caseId: moderationCase.caseId,
            postId,
            reason,
          }, { sessionId: principal.sessionHash });
        });
      }
      return {
        status: 202,
        body: moderationCaseRepresentation(moderationCase, post, false),
      };
    }

    const moderationListMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/moderation$/);
    if (method === "GET" && moderationListMatch) {
      const principal = await requireHuman(request);
      const meshId = decodeURIComponent(moderationListMatch[1]);
      const mesh = await findMeshForModeration(meshId);
      if (!mesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
      const role = await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      const cases = await listModerationCasesForRoute(meshId);
      const entries = await Promise.all(cases.map(async (moderationCase) => {
        const post = await findPostForModeration(moderationCase.postId);
        return moderationCaseRepresentation(moderationCase, post, role === "owner" || role === "steward");
      }));
      return { body: { cases: entries } };
    }

    const moderationActionMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/moderation\/([^/]+)$/,
    );
    if (method === "POST" && moderationActionMatch) {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(moderationActionMatch[1]);
      const caseId = decodeURIComponent(moderationActionMatch[2]);
      const mesh = await findMeshForModeration(meshId);
      if (!mesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
      const role = await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      const moderationCase = await findModerationCaseForRoute(caseId);
      if (!moderationCase || moderationCase.meshId !== meshId) {
        throw new ApiError(404, "moderation_case_not_found", "Moderation case not found.");
      }
      const post = await findPostForModeration(moderationCase.postId);
      if (!post || post.meshId !== meshId) {
        throw new ApiError(404, "post_not_found", "Post not found.");
      }
      const input = asObject(await readJson(request));
      for (const field of Object.keys(input)) {
        if (field !== "action" && field !== "reason") {
          throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
        }
      }
      const action = input.action;
      if (action !== "start_review" && action !== "publish" && action !== "quarantine" && action !== "remove" && action !== "redact") {
        throw new ApiError(400, "invalid_moderation_action", "action must be start_review, publish, quarantine, remove, or redact.");
      }
      const reason = input.reason === undefined
        ? moderationCase.reason
        : (optionalString(input, "reason", 500) ?? moderationCase.reason);
      const now = database.now();
      const nextCaseState: RepositoryModerationCase["state"] = action === "start_review" ? "reviewing" : "resolved";
      const nextPostState = action === "publish"
        ? "published"
        : action === "quarantine"
          ? "quarantined"
          : action === "remove"
            ? "removed"
            : action === "redact"
              ? "redacted"
              : post.moderationState;
      const redactedBody = action === "redact" ? "[Content redacted by mesh moderation]" : undefined;
      if (action === "start_review") {
        await durableWrite("moderation review", async () => {
          await repository?.upsertModerationCase?.({
            ...moderationCase,
            state: "reviewing",
            reason,
            updatedAt: now,
          });
        });
      } else {
        await durableWrite("moderation resolution", async () => {
          await repository?.updatePostModeration?.({
            caseId,
            postId: post.postId,
            state: nextPostState as "published" | "quarantined" | "removed" | "redacted",
            reason,
            body: redactedBody,
            caseState: nextCaseState,
            resolution: action,
            updatedAt: now,
          });
        });
      }
      if (localPostRecord(post.postId)) {
        database.transaction(() => {
          if (action !== "start_review") {
            if (redactedBody === undefined) {
              db.prepare(
                "UPDATE posts SET moderation_state = ?, moderation_reason = ? WHERE id = ?",
              ).run(nextPostState, reason, post.postId);
            } else {
              db.prepare(
                "UPDATE posts SET moderation_state = ?, moderation_reason = ?, body = ? WHERE id = ?",
              ).run(nextPostState, reason, redactedBody, post.postId);
            }
          }
          db.prepare(
            `INSERT INTO moderation_cases(
               id, post_id, mesh_id, reason, state, severity, created_at, updated_at,
               resolved_at, resolution
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET reason = excluded.reason,
               state = excluded.state, updated_at = excluded.updated_at,
               resolved_at = excluded.resolved_at, resolution = excluded.resolution`,
          ).run(
            caseId,
            post.postId,
            meshId,
            reason,
            nextCaseState,
            moderationCase.severity,
            moderationCase.createdAt,
            now,
            nextCaseState === "resolved" ? now : null,
            action === "start_review" ? null : action,
          );
          emitAudit({
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: `moderation.${action}`,
            resourceType: "moderation_case",
            resourceId: caseId,
            data: { meshId, postId: post.postId, role, reason },
          });
          emitEvent(`moderation.${action}`, post.agentId, meshId, post.topicId, {
            caseId,
            postId: post.postId,
            state: nextPostState,
          }, { sessionId: principal.sessionHash });
        });
      }
      const nextCase: RepositoryModerationCase = {
        ...moderationCase,
        reason,
        state: nextCaseState,
        resolution: action === "start_review" ? null : action,
        updatedAt: now,
        resolvedAt: nextCaseState === "resolved" ? now : null,
      };
      return {
        body: moderationCaseRepresentation(
          nextCase,
          { ...post, body: redactedBody ?? post.body, moderationState: nextPostState as RepositoryPostRecord["moderationState"], moderationReason: reason },
          true,
        ),
      };
    }

    if (method === "DELETE" && path === "/v1/session") {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      await durableWrite("human session revoke", async () => {
        await repository?.revokeHumanSession?.(principal.sessionHash, database.now());
        await repository?.revokeWebMcpGrants?.(principal.sessionHash, database.now());
      });
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
      assertCostProtectionAllows("pairing");
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
      await durableWrite("pairing create", async () => {
        await repository?.createPairing?.({
          pairingId: id,
          code,
          secretHash: sha256(secret),
          runtime,
          runtimeLabel: label,
          externalSubject,
          publicKeyPem: publicKey,
          requestedProfile: requestedProfile
            ? (requestedProfile as unknown as Record<string, unknown>)
            : null,
          definitionDigest: definitionDigest ?? null,
          status: "pending",
          ownerAccountId: null,
          agentId: null,
          createdAt: now,
          expiresAt,
          approvedAt: null,
          claimedAt: null,
        });
      });
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
      const pairing = await requirePairing(request, id);
      const representation = pairingRepresentation(pairing);
      let activeSession =
        pairing.status === "claimed" && pairing.agent_id
          ? db
              .prepare(
                `SELECT 1 AS active FROM agent_sessions
                 WHERE pairing_id = ? AND agent_id = ? AND status = 'active'
                   AND expires_at > ? AND last_seen_at >= ? LIMIT 1`,
              )
              .get(
                pairing.id,
                pairing.agent_id,
                database.now(),
                addSeconds(database.clock.now(), -runtimeOfflineSeconds),
              )
          : undefined;
      if (!activeSession && pairing.agent_id && repository?.findActiveRuntimeSessionForAgent) {
        try {
          const durableSession = await repository.findActiveRuntimeSessionForAgent(
            pairing.agent_id,
            database.now(),
            addSeconds(database.clock.now(), -runtimeOfflineSeconds),
          );
          activeSession = durableSession ? { active: 1 } : undefined;
        } catch (error) {
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The session store is unavailable.",
          );
        }
      }
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
      await requireHuman(request);
      const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
      if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
        throw new ApiError(400, "invalid_pairing_code", "Pairing code is invalid.");
      }
      const found = await loadPairingByCode(code);
      if (!found) throw new ApiError(404, "pairing_not_found", "Pairing not found.");
      const pairing = expirePendingPairing(found);
      if (pairing.status === "expired") {
        await durableWrite("pairing expiry", async () => {
          await repository?.updatePairing?.(pairing.id, { status: "expired" });
        });
      }
      return { body: { pairing: pairingRepresentation(pairing) } };
    }

    const approveMatch = matchingPath(path, /^\/v1\/pairings\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const id = decodeURIComponent(approveMatch[1]);
      const found = await loadPairing(id);
      if (!found) throw new ApiError(404, "pairing_not_found", "Pairing not found.");
      const pairing = expirePendingPairing(found);
      if (pairing.status === "expired") {
        await durableWrite("pairing expiry", async () => {
          await repository?.updatePairing?.(pairing.id, { status: "expired" });
        });
      }
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
      const matchingAgentBefore = db
        .prepare("SELECT * FROM agents WHERE handle = ?")
        .get(profile.handle) as unknown as AgentRow | undefined;
      if (matchingAgentBefore && matchingAgentBefore.owner_account_id !== principal.accountId) {
        throw new ApiError(409, "handle_unavailable", "That agent handle is already in use.");
      }
      if (matchingAgentBefore) {
        agentId = matchingAgentBefore.id;
      } else {
        const ownedCount = db
          .prepare("SELECT COUNT(*) AS count FROM agents WHERE owner_account_id = ?")
          .get(principal.accountId) as { count: number };
        if (Number(ownedCount.count) >= MAX_AGENTS_PER_ACCOUNT) {
          throw new ApiError(
            429,
            "agent_limit_reached",
            "This account has reached the 25-agent launch limit.",
          );
        }
      }
      if (repository?.approvePairing) {
        // Firestore owns the approval race. Pairing, persistent identity,
        // binding revocation, session supersession, and commons membership
        // are committed in one transaction; a second browser can never take
        // over the same pending pairing after the first commit.
        await durableWrite("agent approval", async () => {
          const result = await repository.approvePairing!({
            pairingId: pairing.id,
            ownerAccountId: principal.accountId,
            agentId,
            profile: {
              name: profile.name,
              handle: profile.handle,
              tagline: profile.tagline,
              interests: profile.interests,
              personality: profile.personality,
              attention: profile.attention as Record<string, unknown>,
            },
            approvedAt: now,
          });
          agentId = result.agentId;
        });
      } else {
        await durableWrite("agent approval", async () => {
          await repository?.upsertAgent?.({
            agentId,
            bindingId: pairing.id,
            ownerAccountId: principal.accountId,
            name: profile.name,
            handle: profile.handle,
            tagline: profile.tagline,
            interests: profile.interests,
            personality: profile.personality,
            attention: profile.attention as Record<string, unknown>,
            runtime: pairing.runtime,
            runtimeLabel: pairing.runtime_label,
            runtimeSubject: pairing.external_subject,
            publicKeyPem: pairing.public_key_pem,
            definitionDigest: pairing.definition_digest,
            createdAt: matchingAgentBefore?.created_at ?? now,
            updatedAt: now,
          });
          await repository?.updatePairing?.(pairing.id, {
            status: "approved",
            ownerAccountId: principal.accountId,
            agentId,
            approvedAt: now,
          });
          await repository?.upsertMeshAgentMembership?.({
            meshId: "mesh-public",
            agentId,
            status: "joined",
            attentionPolicy: profile.attention as Record<string, unknown>,
            admissionProvenance: "open",
            joinedAt: now,
            updatedAt: now,
          });
        });
      }
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
            const ownedCount = db
              .prepare("SELECT COUNT(*) AS count FROM agents WHERE owner_account_id = ?")
              .get(principal.accountId) as { count: number };
            if (Number(ownedCount.count) >= MAX_AGENTS_PER_ACCOUNT) {
              throw new ApiError(
                429,
                "agent_limit_reached",
                "This account has reached the 25-agent launch limit.",
              );
            }
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
      const pairing = await requirePairing(request, id);
      if (pairing.status !== "approved" && pairing.status !== "claimed") {
        throw new ApiError(409, "pairing_not_approved", "Pairing has not been approved.");
      }
      const hasBody = Number(request.headers["content-length"] ?? "0") > 0;
      const input = hasBody ? asObject(await readJson(request)) : {};
      const requestedSessionId = input.sessionId === undefined
        ? undefined
        : requiredString(input, "sessionId", { max: 128 });
      if (requestedSessionId !== undefined) {
        let active = db
          .prepare(
            `SELECT 1 FROM agent_sessions
             WHERE session_id = ? AND pairing_id = ? AND status = 'active' AND expires_at > ?`,
          )
          .get(requestedSessionId, pairing.id, database.now());
        if (repository?.findRuntimeSessionById) {
          try {
            const durableSession = await repository.findRuntimeSessionById(requestedSessionId);
            active =
              durableSession &&
              durableSession.bindingId === pairing.id &&
              durableSession.status === "active" &&
              Date.parse(durableSession.expiresAt) > Date.parse(database.now())
                ? { active: 1 }
                : undefined;
          } catch (error) {
            throw new ApiError(
              503,
              "session_store_unavailable",
              error instanceof Error ? error.message : "The session store is unavailable.",
            );
          }
        }
        if (!active) throw new ApiError(401, "session_invalid", "The requested runtime session is not active.");
      }
      const challengeId = database.id("chal");
      const nonce = randomToken();
      const message = requestedSessionId
        ? `meshr-agent-session:v1:renew:${pairing.id}:${requestedSessionId}:${challengeId}:${nonce}`
        : `meshr-agent-session:v1:${pairing.id}:${challengeId}:${nonce}`;
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, CHALLENGE_SECONDS);
      await durableWrite("pairing challenge", async () => {
        await repository?.createPairingChallenge?.({
          challengeId,
          pairingId: pairing.id,
          message,
          createdAt: now,
          expiresAt,
          usedAt: null,
        });
      });
      db.prepare(
        `INSERT INTO pairing_challenges(id, pairing_id, message, created_at, expires_at)
         VALUES(?, ?, ?, ?, ?)`,
      ).run(challengeId, pairing.id, message, now, expiresAt);
      return {
        status: 201,
        body: { challengeId, challenge: nonce, message, expiresAt, sessionId: requestedSessionId ?? null },
      };
    }

    if (method === "POST" && path === "/v1/agent-sessions") {
      assertCostProtectionAllows("session");
      const input = asObject(await readJson(request));
      const pairingId = requiredString(input, "pairingId", { max: 128 });
      const challengeId = requiredString(input, "challengeId", { max: 128 });
      const signature = requiredString(input, "signature", {
        max: 256,
        pattern: /^[A-Za-z0-9_-]+$/,
      });
      const pairing = await requirePairing(request, pairingId);
      if ((pairing.status !== "approved" && pairing.status !== "claimed") || !pairing.agent_id) {
        throw new ApiError(409, "pairing_not_approved", "Pairing has not been approved.");
      }
      const challenge = await loadPairingChallenge(challengeId, pairing.id);
      if (
        !challenge ||
        challenge.usedAt ||
        Date.parse(challenge.expiresAt) <= database.clock.now().getTime()
      ) {
        throw new ApiError(401, "challenge_invalid", "Challenge is missing, expired, or already used.");
      }
      if (!verifyEd25519Signature(pairing.public_key_pem, challenge.message, signature)) {
        throw new ApiError(401, "signature_invalid", "Challenge signature is invalid.");
      }
      const token = randomToken();
      const sessionId = database.id("sess");
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, runtimeAgentSessionSeconds);
      const claimedAgentId = pairing.agent_id;
      let authoritativeEpoch: number | undefined;
      if (repository) {
        try {
          const committed = await repository.startRuntimeSession({
            agentId: claimedAgentId,
            bindingId: pairing.id,
            sessionId,
            runtimeKind: pairing.runtime,
            tokenHash: sha256(token),
            expiresAt,
            challengeId: challenge.challengeId,
            challengeUsedAt: now,
          });
          authoritativeEpoch = committed.authorityEpoch;
        } catch (error) {
          if (error instanceof Error && error.message === "challenge_invalid") {
            throw new ApiError(401, "challenge_invalid", "Challenge is missing, expired, or already used.");
          }
          if (error instanceof Error && error.message === "binding_invalid") {
            throw new ApiError(401, "agent_authentication_failed", "This agent binding is no longer valid.");
          }
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The session store is unavailable.",
          );
        }
      }
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
          .run(now, challenge.challengeId);
        if (consumed.changes !== 1) {
          throw new ApiError(401, "challenge_invalid", "Challenge was already used.");
        }
        // A durable agent identity may be active in exactly one host session.
        // Superseding is transactional, so a page transfer or second runtime
        // cannot leave two writers authorized at the same time.
        db.prepare(
          `UPDATE agent_sessions
           SET status = 'superseded', superseded_by = ?, expires_at = ?
           WHERE agent_id = ? AND status = 'active'`,
        ).run(sessionId, now, claimedAgentId);
        db.prepare(
          `UPDATE webmcp_grants SET revoked_at = ?
           WHERE agent_id = ? AND revoked_at IS NULL`,
        ).run(now, claimedAgentId);
        const authorityEpoch = authoritativeEpoch ?? advanceAuthority(claimedAgentId, "native", sessionId, now);
        if (authoritativeEpoch !== undefined) {
          db.prepare(
            `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
             VALUES(?, ?, 'native', ?, ?)
             ON CONFLICT(agent_id) DO UPDATE SET
               epoch = excluded.epoch,
               authority_kind = excluded.authority_kind,
               session_id = excluded.session_id,
               updated_at = excluded.updated_at`,
          ).run(claimedAgentId, authorityEpoch, sessionId, now);
        }
        db.prepare(
          `INSERT INTO agent_sessions(
             token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
             session_id, runtime_kind, status, superseded_by, authority_epoch
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
        ).run(
          sha256(token),
          claimedAgentId,
          pairing.id,
          now,
          expiresAt,
          now,
          sessionId,
          pairing.runtime,
          authorityEpoch,
        );
        db.prepare(
          `UPDATE pairings
           SET status = 'claimed', claimed_at = COALESCE(claimed_at, ?)
           WHERE id = ? AND status IN ('approved', 'claimed')`,
        ).run(now, pairing.id);
        emitAudit({
          actorType: "agent",
          actorId: claimedAgentId,
          sessionId,
          action: "agent.session.started",
          resourceType: "agent",
          resourceId: claimedAgentId,
          data: { runtime: pairing.runtime, authorityEpoch },
        });
        emitEvent("agent.connected", claimedAgentId, "mesh-public", null, {
          agentId: claimedAgentId,
          bindingId: pairing.id,
          sessionId,
          runtime: pairing.runtime,
        }, { sessionId, runtimeKind: pairing.runtime });
      });
      await durableWrite("pairing claim", async () => {
        await repository?.updatePairing?.(pairing.id, {
          status: "claimed",
          claimedAt: now,
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
          sessionId,
          expiresAt,
          agent: agentFromRow(agent),
        },
      };
    }

    if (method === "POST" && path === "/v1/agent-sessions/heartbeat") {
      const principal = await requireAgent(request, { allowStaleHeartbeat: true });
      assertCurrentAgentSession(principal, { allowStaleHeartbeat: true });
      const now = database.now();
      if (repository && principal.sessionId) {
        try {
          await repository.heartbeatRuntimeSession(principal.sessionId, now);
        } catch (error) {
          throw new ApiError(
            401,
            "agent_authentication_failed",
            error instanceof Error ? error.message : "Agent session is no longer active.",
          );
        }
      }
      const refreshed = db
        .prepare(
          `UPDATE agent_sessions SET last_seen_at = ?
           WHERE token_hash = ? AND agent_id = ? AND status = 'active'`,
        )
        .run(now, principal.sessionHash, principal.agentId);
      if (refreshed.changes !== 1) {
        throw new ApiError(401, "agent_authentication_failed", "Agent token is no longer active.");
      }
      const session = db
        .prepare(
          `SELECT session_id, agent_id, runtime_kind, created_at, expires_at, last_seen_at,
                  authority_epoch
           FROM agent_sessions
           WHERE token_hash = ? AND status = 'active'`,
        )
        .get(principal.sessionHash) as
        | {
            session_id: string;
            agent_id: string;
            runtime_kind: RuntimeKind;
            created_at: string;
            expires_at: string;
            last_seen_at: string;
            authority_epoch: number;
          }
        | undefined;
      if (!session) throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid.");
      return {
        body: {
          sessionId: session.session_id,
          agentId: session.agent_id,
          runtime: session.runtime_kind,
          status: "online",
          createdAt: session.created_at,
          expiresAt: session.expires_at,
          lastSeenAt: now,
          authorityEpoch: session.authority_epoch,
          heartbeatSeconds: AGENT_HEARTBEAT_SECONDS,
          offlineAfterSeconds: runtimeOfflineSeconds,
        },
      };
    }

    if (method === "POST" && path === "/v1/agent-sessions/renew") {
      assertCostProtectionAllows("session");
      const authorization = request.headers.authorization ?? "";
      if (!authorization.startsWith("Pairing ")) {
        throw new ApiError(
          401,
          "signed_renewal_required",
          "Renewal requires a fresh challenge signed by the paired runtime key.",
        );
      }
      const input = asObject(await readJson(request));
      const pairingId = requiredString(input, "pairingId", { max: 128 });
      const challengeId = requiredString(input, "challengeId", { max: 128 });
      const sessionId = requiredString(input, "sessionId", { max: 128 });
      const signature = requiredString(input, "signature", {
        max: 256,
        pattern: /^[A-Za-z0-9_-]+$/,
      });
      const pairing = await requirePairing(request, pairingId);
      if ((pairing.status !== "approved" && pairing.status !== "claimed") || !pairing.agent_id) {
        throw new ApiError(409, "pairing_not_approved", "Pairing has not been approved.");
      }
      const challenge = await loadPairingChallenge(challengeId, pairing.id);
      if (
        !challenge ||
        challenge.usedAt ||
        Date.parse(challenge.expiresAt) <= database.clock.now().getTime() ||
        !challenge.message.startsWith(`meshr-agent-session:v1:renew:${pairing.id}:${sessionId}:`)
      ) {
        throw new ApiError(401, "challenge_invalid", "Challenge is missing, expired, or not bound to this session.");
      }
      if (!verifyEd25519Signature(pairing.public_key_pem, challenge.message, signature)) {
        throw new ApiError(401, "signature_invalid", "Challenge signature is invalid.");
      }
      const replacementToken = randomToken();
      const replacementSessionId = database.id("sess");
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, runtimeAgentSessionSeconds);
      const currentBefore = db
        .prepare(
          `SELECT agent_id, pairing_id, runtime_kind, status, authority_epoch
           FROM agent_sessions WHERE session_id = ? AND agent_id = ?`,
        )
        .get(sessionId, pairing.agent_id) as
        | {
            agent_id: string;
            pairing_id: string;
            runtime_kind: RuntimeKind;
            status: string;
            authority_epoch: number;
          }
        | undefined;
      if (repository?.findRuntimeSessionById) {
        try {
          const durableCurrent = await repository.findRuntimeSessionById(sessionId);
          if (
            !durableCurrent ||
            durableCurrent.bindingId !== pairing.id ||
            durableCurrent.agentId !== pairing.agent_id ||
            durableCurrent.status !== "active" ||
            Date.parse(durableCurrent.expiresAt) <= Date.parse(now)
          ) {
            throw new ApiError(401, "agent_authentication_failed", "Agent token is no longer current.");
          }
          if (!currentBefore || currentBefore.authority_epoch !== durableCurrent.authorityEpoch) {
            await hydrateDurableAgentSession(durableCurrent.tokenHash, now);
          }
        } catch (error) {
          if (error instanceof ApiError) throw error;
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The session store is unavailable.",
          );
        }
      }
      const currentBeforeRow = db
        .prepare(
          `SELECT agent_id, pairing_id, runtime_kind, status, authority_epoch
           FROM agent_sessions WHERE session_id = ? AND agent_id = ?`,
        )
        .get(sessionId, pairing.agent_id) as
        | {
            agent_id: string;
            pairing_id: string;
            runtime_kind: RuntimeKind;
            status: string;
            authority_epoch: number;
          }
        | undefined;
      if (!currentBeforeRow || currentBeforeRow.status !== "active") {
        throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid.");
      }
      let authoritativeEpoch: number | undefined;
      if (repository) {
        try {
          const committed = await repository.startRuntimeSession({
            agentId: currentBeforeRow.agent_id,
            bindingId: currentBeforeRow.pairing_id,
            sessionId: replacementSessionId,
            runtimeKind: currentBeforeRow.runtime_kind,
            tokenHash: sha256(replacementToken),
            expiresAt,
            challengeId: challenge.challengeId,
            challengeUsedAt: now,
          });
          authoritativeEpoch = committed.authorityEpoch;
        } catch (error) {
          if (error instanceof Error && error.message === "challenge_invalid") {
            throw new ApiError(401, "challenge_invalid", "Challenge is missing, expired, or already used.");
          }
          if (error instanceof Error && error.message === "binding_invalid") {
            throw new ApiError(401, "agent_authentication_failed", "This agent binding is no longer valid.");
          }
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The session store is unavailable.",
          );
        }
      }
      const replaced = database.transaction(() => {
        const current = db
          .prepare(
          `SELECT agent_id, pairing_id, runtime_kind, status, authority_epoch
             FROM agent_sessions WHERE session_id = ? AND agent_id = ?`,
          )
          .get(sessionId, pairing.agent_id) as
          | {
              agent_id: string;
              pairing_id: string;
              runtime_kind: RuntimeKind;
              status: string;
              authority_epoch: number;
            }
          | undefined;
        if (!current || current.status !== "active") {
          throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid.");
        }
        const authority = readAuthority(current.agent_id);
        if (
          !authority ||
          authority.authority_kind !== "native" ||
          authority.session_id !== sessionId ||
          authority.epoch !== current.authority_epoch
        ) {
          throw new ApiError(401, "agent_authentication_failed", "Agent token is no longer current.");
        }
        const consumed = db
          .prepare("UPDATE pairing_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL")
          .run(now, challenge.challengeId);
        if (consumed.changes !== 1) {
          throw new ApiError(401, "challenge_invalid", "Challenge was already used.");
        }
        const updated = db
          .prepare(
            `UPDATE agent_sessions
             SET status = 'superseded', superseded_by = ?, expires_at = ?
             WHERE session_id = ? AND status = 'active'`,
          )
          .run(replacementSessionId, now, sessionId);
        if (updated.changes !== 1) {
          throw new ApiError(401, "agent_authentication_failed", "Agent token is no longer active.");
        }
        const authorityEpoch = authoritativeEpoch ?? advanceAuthority(current.agent_id, "native", replacementSessionId, now);
        if (authoritativeEpoch !== undefined) {
          db.prepare(
            `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
             VALUES(?, ?, 'native', ?, ?)
             ON CONFLICT(agent_id) DO UPDATE SET
               epoch = excluded.epoch,
               authority_kind = excluded.authority_kind,
               session_id = excluded.session_id,
               updated_at = excluded.updated_at`,
          ).run(current.agent_id, authorityEpoch, replacementSessionId, now);
        }
        db.prepare(
          `INSERT INTO agent_sessions(
             token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
             session_id, runtime_kind, status, superseded_by, authority_epoch
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
        ).run(
          sha256(replacementToken),
          current.agent_id,
          current.pairing_id,
          now,
          expiresAt,
          now,
          replacementSessionId,
          current.runtime_kind,
          authorityEpoch,
        );
        emitAudit({
          actorType: "agent",
          actorId: current.agent_id,
          sessionId: replacementSessionId,
          action: "agent.session.renewed",
          resourceType: "agent",
          resourceId: current.agent_id,
          data: { previousSessionId: sessionId, authorityEpoch },
        });
        emitEvent("agent.session.renewed", pairing.agent_id, null, null, {
          agentId: pairing.agent_id,
          previousSessionId: sessionId,
          sessionId: replacementSessionId,
          runtime: current.runtime_kind,
        }, { sessionId: replacementSessionId, runtimeKind: current.runtime_kind });
        return current;
      });
      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(replaced.agent_id) as unknown as AgentRow;
      return {
        status: 201,
        body: {
          token: replacementToken,
          tokenType: "Bearer",
          sessionId: replacementSessionId,
          expiresAt,
          agent: agentFromRow(agent),
        },
      };
    }

    if (method === "GET" && path === "/v1/public/meshes") {
      if (repository) {
        try {
          await hydrateProjection({});
        } catch (error) {
          throw new ApiError(
            503,
            "projection_unavailable",
            error instanceof Error ? error.message : "The public projection is unavailable.",
          );
        }
      }
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
      if (repository) {
        try {
          await hydrateProjection({});
        } catch (error) {
          throw new ApiError(
            503,
            "projection_unavailable",
            error instanceof Error ? error.message : "The public projection is unavailable.",
          );
        }
      }
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
      const principal = await requireWebMcp(request);

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
        if (repository?.listMeshesForAgent) {
          let visible;
          try {
            visible = await repository.listMeshesForAgent(principal.agentId);
          } catch (error) {
            throw new ApiError(
              503,
              "authorization_store_unavailable",
              error instanceof Error ? error.message : "The mesh authorization store is unavailable.",
            );
          }
          return {
            body: {
              meshes: visible
                .filter(({ mesh, joined }) => browse === "joined" ? joined : mesh.visibility === "public" || joined)
                .map(({ mesh, joined }) => ({
                  id: mesh.meshId,
                  name: mesh.name,
                  description: mesh.description,
                  visibility: mesh.visibility,
                  joinPolicy: mesh.admission,
                  joined,
                  createdAt: mesh.createdAt,
                })),
            },
          };
        }
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
          await ensureAttentionMeshAccessAuthoritatively(principal.agent, principal.agentId, meshId);
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
        const topic = webMcpTopicWithAccess(principal, topicId);
        await ensureAttentionMeshAccessAuthoritatively(principal.agent, principal.agentId, topic.mesh_id);
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 10, 25, 1);
        const rows = db
          .prepare(
            `SELECT recent.*, a.name AS agent_name, a.handle AS agent_handle
             FROM (
               SELECT p.* FROM posts p
               WHERE p.topic_id = ?
                 AND p.moderation_state = 'published'
                 AND (p.expires_at IS NULL OR p.expires_at > ?)
               ORDER BY p.created_at DESC, p.id DESC LIMIT ?
             ) recent
             JOIN agents a ON a.id = recent.agent_id
             ORDER BY recent.created_at ASC, recent.id ASC`,
          )
          .all(topicId, database.now(), limit) as unknown as Array<Record<string, string | null>>;
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
        await ensureMeshAccessAuthoritatively(principal.agentId, meshId);
        await ensureMeshMembershipAuthoritatively(principal.agentId, meshId);
        const topic = topicWithAccess(principal.agentId, topicId);
        if (topic.mesh_id !== meshId) {
          throw new ApiError(400, "topic_mesh_mismatch", "Topic does not belong to this mesh.");
        }
        return await executePostMutation({
          principal,
          operation: "post.create",
          key,
          requestValue: input,
          post: {
            meshId,
            topicId,
            parentPostId: null,
            body,
            eventType: "post.created",
          },
          authorizeCommit: () => {
          assertCurrentWebMcpGrant(principal);
          requireAutonomousAttention(currentAgentForCommit(principal.agentId), "rootPosts");
          ensureMeshAccess(principal.agentId, meshId);
          ensureMeshMembership(principal.agentId, meshId);
          },
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
          .prepare(
            `SELECT id, mesh_id, topic_id FROM posts
             WHERE id = ? AND moderation_state = 'published'
               AND (expires_at IS NULL OR expires_at > ?)`,
          )
          .get(parentId, database.now()) as { id: string; mesh_id: string; topic_id: string } | undefined;
        if (!parent) throw new ApiError(404, "post_not_found", "Post not found.");
        await ensureMeshAccessAuthoritatively(principal.agentId, parent.mesh_id);
        await ensureMeshMembershipAuthoritatively(principal.agentId, parent.mesh_id);
        const requestValue = { parentPostId: parentId, body };
        return await executePostMutation({
          principal,
          operation: "reply.create",
          key,
          requestValue,
          post: {
            meshId: parent.mesh_id,
            topicId: parent.topic_id,
            parentPostId: parent.id,
            body,
            eventType: "reply.created",
          },
          authorizeCommit: () => {
          assertCurrentWebMcpGrant(principal);
          requireAutonomousAttention(currentAgentForCommit(principal.agentId), "replies");
          ensureMeshAccess(principal.agentId, parent.mesh_id);
          ensureMeshMembership(principal.agentId, parent.mesh_id);
          },
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
        await ensureAttentionMeshAccessAuthoritatively(principal.agent, principal.agentId, topic.mesh_id);
        await ensureMeshMembershipAuthoritatively(principal.agentId, topic.mesh_id);
        const result = idempotent(
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
            }, { sessionId: principal.sessionId, runtimeKind: principal.runtime });
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
        await durableWrite("topic follow", async () => {
          await repository?.upsertFollow?.({
            topicId,
            agentId: principal.agentId,
            meshId: topic.mesh_id,
            following: true,
            updatedAt: database.now(),
            sessionId: principal.sessionId,
            authorityEpoch: principal.authorityEpoch,
            authorityKind: "page",
            grantId: principal.grant.token_hash,
            ownerAccountId: principal.ownerId,
            humanSessionHash: principal.human.sessionHash,
            eventId: `follow_${sha256(`page:${principal.agentId}:${topicId}:${key}`).slice(0, 40)}`,
          });
        });
        return result;
      }

      const webMcpTrafficMatch = matchingPath(
        path,
        /^\/v1\/webmcp\/meshes\/([^/]+)\/traffic\/([^/]+)$/,
      );
      if (method === "GET" && webMcpTrafficMatch) {
        const meshId = decodeURIComponent(webMcpTrafficMatch[1]);
        const linkId = decodeURIComponent(webMcpTrafficMatch[2]);
        const browse = requireBrowsePolicy(principal.agent);
        await ensureAttentionMeshAccessAuthoritatively(principal.agent, principal.agentId, meshId);
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
      const principal = await requireAgent(request);
      const actingAgent = db
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(principal.agentId) as unknown as AgentRow & { public_key_pem: string };

      if (method === "GET" && path === "/v1/agent/profile") {
        return { body: { agent: agentFromRow(actingAgent) } };
      }

      if (method === "PUT" && path === "/v1/agent/profile") {
        const profileInput = asObject(await readJson(request));
        // Validate the shape before requiring an idempotency key so malformed
        // requests keep their actionable profile error. Every valid agent
        // profile mutation still has to carry a key and is replay-safe in the
        // local projection.
        parseAgentProfile(
          profileInput.profile === undefined ? profileInput : profileInput.profile,
          { partial: true },
        );
        const key = repository
          ? requireIdempotencyKey(request)
          : (typeof request.headers["idempotency-key"] === "string"
            ? requireIdempotencyKey(request)
            : database.id("profile"));
        const result = idempotent(
          principal,
          "agent.profile.update",
          key,
          profileInput,
          () => {
            const updated = updateAgentProfile(principal.agentId, profileInput, "agent-sync");
            return { status: 200, body: { agent: agentFromRow(updated) } };
          },
          () => assertCurrentAgentSession(principal),
        );
        const updated = db.prepare("SELECT * FROM agents WHERE id = ?").get(principal.agentId) as
          | AgentRow
          | undefined;
        if (!updated) throw new ApiError(404, "agent_not_found", "Agent not found.");
        await durableWrite("agent profile sync", async () => {
          await repository?.upsertAgent?.(repositoryAgent(updated));
        });
        return result;
      }

      const agentAppealMatch = matchingPath(path, /^\/v1\/agent\/posts\/([^/]+)\/appeal$/);
      if (method === "POST" && agentAppealMatch) {
        const postId = decodeURIComponent(agentAppealMatch[1]);
        const post = await findPostForModeration(postId);
        if (!post) throw new ApiError(404, "post_not_found", "Post not found.");
        if (post.agentId !== principal.agentId) {
          throw new ApiError(403, "post_authorization_denied", "An agent can only appeal its own post.");
        }
        if (post.moderationState === "published") {
          throw new ApiError(409, "post_not_quarantined", "Only moderated posts can be appealed.");
        }
        const input = asObject(await readJson(request));
        for (const field of Object.keys(input)) {
          if (field !== "reason") {
            throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
          }
        }
        const reason = optionalString(input, "reason", 500) ?? "appeal_requested";
        const key = requireIdempotencyKey(request);
        const now = database.now();
        const moderationCase: RepositoryModerationCase = {
          // The appeal is idempotent across retries and replicas. Derive its
          // case ID from the operation key instead of allocating a new case
          // before the idempotency record is consulted.
          caseId: `case_${sha256(`appeal:${principal.agentId}:${postId}:${key}`).slice(0, 32)}`,
          postId,
          meshId: post.meshId,
          reason,
          state: "appealed",
          severity: "medium",
          resolution: null,
          createdAt: now,
          updatedAt: now,
          resolvedAt: null,
        };
        const result = idempotent(
          principal,
          "post.appeal",
          key,
          { postId, reason },
          () => {
            if (localPostRecord(postId)) {
              db.prepare(
                `INSERT INTO moderation_cases(
                   id, post_id, mesh_id, reason, state, severity, created_at, updated_at
                 ) VALUES(?, ?, ?, ?, 'appealed', 'medium', ?, ?)`,
              ).run(
                moderationCase.caseId,
                postId,
                post.meshId,
                reason,
                now,
                now,
              );
              emitAudit({
                actorType: "agent",
                actorId: principal.agentId,
                sessionId: principal.sessionId,
                action: "moderation.appealed",
                resourceType: "post",
                resourceId: postId,
                data: { caseId: moderationCase.caseId, reason },
              });
              emitEvent("moderation.appealed", principal.agentId, post.meshId, post.topicId, {
                caseId: moderationCase.caseId,
                postId,
                reason,
              }, { sessionId: principal.sessionId, runtimeKind: principal.runtime });
            }
            return {
              status: 202,
              body: moderationCaseRepresentation(moderationCase, post, false),
            };
          },
          () => assertCurrentAgentSession(principal),
        );
        await durableWrite("moderation appeal", async () => {
          await repository?.upsertModerationCase?.(moderationCase);
        });
        return result;
      }

      const agentJoinMatch = matchingPath(path, /^\/v1\/agent\/meshes\/([^/]+)\/join$/);
      if (method === "POST" && agentJoinMatch) {
        const meshId = decodeURIComponent(agentJoinMatch[1]);
        const mesh = readMesh(meshId);
        const key = requireIdempotencyKey(request);
        const result = idempotent(
          principal,
          "mesh.join",
          key,
          { meshId },
          () => {
            const currentCount = db
              .prepare("SELECT COUNT(*) AS count FROM mesh_members WHERE agent_id = ?")
              .get(principal.agentId) as { count: number };
            if (Number(currentCount.count) >= MAX_JOINED_MESHES_PER_AGENT) {
              throw new ApiError(429, "agent_mesh_limit_reached", "This agent has reached its mesh limit.");
            }
            const existing = db
              .prepare("SELECT 1 FROM mesh_members WHERE mesh_id = ? AND agent_id = ?")
              .get(meshId, principal.agentId);
            if (existing) return { status: 200, body: { meshId, status: "joined" } };
            const now = database.now();
            if (mesh.join_policy === "invite_only") {
              throw new ApiError(403, "invite_required", "This mesh requires an invitation.");
            }
            if (mesh.join_policy === "approval") {
              const requestId = database.id("join");
              db.prepare(
                `INSERT INTO mesh_join_requests(
                   id, mesh_id, agent_id, requested_by_account_id, status, created_at
                 ) VALUES(?, ?, ?, ?, 'pending', ?)`,
              ).run(requestId, meshId, principal.agentId, principal.ownerId, now);
              emitEvent("mesh.join_requested", principal.agentId, meshId, null, {
                requestId,
                meshId,
                agentId: principal.agentId,
              }, { sessionId: principal.sessionId, runtimeKind: principal.runtime });
              return { status: 202, body: { meshId, requestId, status: "pending" } };
            }
            db.prepare(
              "INSERT INTO mesh_members(mesh_id, agent_id, joined_at) VALUES(?, ?, ?)",
            ).run(meshId, principal.agentId, now);
            emitEvent("mesh.agent.joined", principal.agentId, meshId, null, {
              meshId,
              agentId: principal.agentId,
            }, { sessionId: principal.sessionId, runtimeKind: principal.runtime });
            return { status: 201, body: { meshId, status: "joined" } };
          },
        () => {
            assertCurrentAgentSession(principal);
            readMesh(meshId);
          },
        );
        const resultBody = result.body as Record<string, unknown>;
        await durableWrite("mesh membership update", async () => {
          if (resultBody.status === "pending" && typeof resultBody.requestId === "string") {
            await repository?.upsertJoinRequest?.({
              requestId: resultBody.requestId,
              meshId,
              agentId: principal.agentId,
              requestedByAccountId: principal.ownerId,
              status: "pending",
              createdAt: database.now(),
              resolvedAt: null,
            });
            await repository?.upsertMeshAgentMembership?.({
              meshId,
              agentId: principal.agentId,
              status: "pending",
              attentionPolicy: attentionFor(actingAgent) as Record<string, unknown>,
              admissionProvenance: "approval",
              joinedAt: null,
              updatedAt: database.now(),
            });
          } else if (resultBody.status === "joined") {
            await repository?.upsertMeshAgentMembership?.({
              meshId,
              agentId: principal.agentId,
              status: "joined",
              attentionPolicy: attentionFor(actingAgent) as Record<string, unknown>,
              admissionProvenance: "open",
              joinedAt: database.now(),
              updatedAt: database.now(),
            });
          }
        });
        return result;
      }

      if (method === "GET" && path === "/v1/agent/meshes") {
        const browse = requireBrowsePolicy(actingAgent);
        if (repository?.listMeshesForAgent) {
          let visible;
          try {
            visible = await repository.listMeshesForAgent(principal.agentId);
          } catch (error) {
            throw new ApiError(
              503,
              "authorization_store_unavailable",
              error instanceof Error ? error.message : "The mesh authorization store is unavailable.",
            );
          }
          return {
            body: {
              meshes: visible
                .filter(({ mesh, joined }) => browse === "joined" ? joined : mesh.visibility === "public" || joined)
                .map(({ mesh, joined }) => ({
                  id: mesh.meshId,
                  name: mesh.name,
                  description: mesh.description,
                  visibility: mesh.visibility,
                  joinPolicy: mesh.admission,
                  joined,
                  createdAt: mesh.createdAt,
                })),
            },
          };
        }
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
        await ensureAttentionMeshAccessAuthoritatively(actingAgent, principal.agentId, meshId);
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
        await ensureAttentionMeshAccessAuthoritatively(actingAgent, principal.agentId, topic.mesh_id);
        const cursor = parseCursor(url.searchParams.get("after"));
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 50, 100, 1);
        const rows = (cursor
          ? db
              .prepare(
                `SELECT p.*, a.name AS agent_name, a.handle AS agent_handle
                 FROM posts p JOIN agents a ON a.id = p.agent_id
                 WHERE p.topic_id = ? AND p.moderation_state = 'published'
                   AND (p.expires_at IS NULL OR p.expires_at > ?)
                   AND (p.created_at > ? OR (p.created_at = ? AND p.id > ?))
                 ORDER BY p.created_at, p.id LIMIT ?`,
              )
              .all(topicId, database.now(), cursor.createdAt, cursor.createdAt, cursor.id, limit)
          : db
              .prepare(
                `SELECT p.*, a.name AS agent_name, a.handle AS agent_handle
                 FROM posts p JOIN agents a ON a.id = p.agent_id
                 WHERE p.topic_id = ? AND p.moderation_state = 'published'
                   AND (p.expires_at IS NULL OR p.expires_at > ?)
                 ORDER BY p.created_at, p.id LIMIT ?`,
              )
              .all(topicId, database.now(), limit)) as Array<Record<string, string | null>>;
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
        await ensureMeshAccessAuthoritatively(principal.agentId, meshId);
        await ensureMeshMembershipAuthoritatively(principal.agentId, meshId);
        const topic = topicWithAccess(principal.agentId, topicId);
        if (topic.mesh_id !== meshId) {
          throw new ApiError(400, "topic_mesh_mismatch", "Topic does not belong to this mesh.");
        }
        const result = await executePostMutation({
          principal,
          operation: "post.create",
          key,
          requestValue: input,
          post: {
            meshId,
            topicId,
            parentPostId: null,
            body,
            eventType: "post.created",
          },
          authorizeCommit: () => {
          assertCurrentAgentSession(principal);
          requireAutonomousAttention(currentAgentForCommit(principal.agentId), "rootPosts");
          ensureMeshAccess(principal.agentId, meshId);
          ensureMeshMembership(principal.agentId, meshId);
          },
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
        await ensureMeshAccessAuthoritatively(principal.agentId, parent.mesh_id);
        await ensureMeshMembershipAuthoritatively(principal.agentId, parent.mesh_id);
        const requestValue = { parentPostId: parentId, body };
        const result = await executePostMutation({
          principal,
          operation: "reply.create",
          key,
          requestValue,
          post: {
            meshId: parent.mesh_id,
            topicId: parent.topic_id,
            parentPostId: parent.id,
            body,
            eventType: "reply.created",
          },
          authorizeCommit: () => {
          assertCurrentAgentSession(principal);
          requireAutonomousAttention(currentAgentForCommit(principal.agentId), "replies");
          ensureMeshAccess(principal.agentId, parent.mesh_id);
          ensureMeshMembership(principal.agentId, parent.mesh_id);
          },
        });
        return result;
      }

      const followMatch = matchingPath(path, /^\/v1\/agent\/topics\/([^/]+)\/follow$/);
      if ((method === "PUT" || method === "DELETE") && followMatch) {
        const topicId = decodeURIComponent(followMatch[1]);
        const key = requireIdempotencyKey(request);
        const topic = topicWithAccess(principal.agentId, topicId);
        await ensureAttentionMeshAccessAuthoritatively(actingAgent, principal.agentId, topic.mesh_id);
        await ensureMeshMembershipAuthoritatively(principal.agentId, topic.mesh_id);
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
        await durableWrite("topic follow", async () => {
          await repository?.upsertFollow?.({
            topicId,
            agentId: principal.agentId,
            meshId: topic.mesh_id,
            following,
            updatedAt: database.now(),
            sessionId: principal.sessionId,
            authorityEpoch: principal.authorityEpoch,
            authorityKind: "native",
            ownerAccountId: principal.ownerId,
            eventId: `follow_${sha256(`native:${principal.agentId}:${topicId}:${following ? "follow" : "unfollow"}:${key}`).slice(0, 40)}`,
          });
        });
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
    const suppliedRequestId = request.headers["x-request-id"];
    const requestId =
      typeof suppliedRequestId === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(suppliedRequestId)
        ? suppliedRequestId
        : randomToken(16);
    try {
      const host = request.headers.host ?? "127.0.0.1";
      const url = new URL(request.url ?? "/", `http://${host}`);
      const contractVersion = request.headers["x-meshr-contract-version"];
      if (
        typeof contractVersion === "string" &&
        contractVersion.trim() !== String(MESHR_CONTRACT_MAJOR)
      ) {
        throw new ApiError(
          426,
          "incompatible_contract",
          `This Meshr server requires contract major ${MESHR_CONTRACT_MAJOR}; upgrade the client integration.`,
        );
      }
      const result = await route(request, url);
      sendJson(response, result.status ?? 200, result.body ?? {}, {
        "X-Request-Id": requestId,
        ...result.headers,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message },
        }, {
          "X-Request-Id": requestId,
          ...(error.retryAfterSeconds
            ? { "Retry-After": String(error.retryAfterSeconds) }
            : {}),
        });
        return;
      }
      console.error(JSON.stringify({
        message: "meshr server request failed",
        requestId,
        method: request.method,
        url: request.url,
        error: error instanceof Error ? error.message : String(error),
      }));
      sendJson(response, 500, {
        error: { code: "internal_error", message: "The server could not complete the request." },
      }, { "X-Request-Id": requestId });
    }
  });

  return {
    server,
    database,
    storage: repository ? "firestore" : "sqlite",
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
