import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION, MeshrDatabase } from "./database.ts";
import { publicRuntimeKind } from "./types.ts";
import {
  assertEd25519PublicKey,
  constantTimeStringEqual,
  hashPassword,
  hmacSha256,
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
  SocialProvider,
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
import { MESHR_CONTRACT_MAJOR, serializeAgentProfile } from "./contracts.ts";
import { MAX_TOPICS_PER_MESH } from "./repository.ts";
import type {
  MeshrRepository,
  RepositoryAgentInput,
  RepositoryProfileReviewProposal,
  RepositoryMeshInput,
  RepositoryMeshDirectoryEntry,
  RepositoryPairingInput,
  RepositoryPairingChallenge,
  RepositoryTopicInput,
  RepositoryTopicCreateInput,
  RepositoryTopicUpdateInput,
  RepositoryTopicDeleteInput,
  RepositoryModerationCase,
  RepositoryModerationCasesPage,
  RepositoryPostRecord,
  RepositoryJoinRequest,
  RepositoryMeshInvitation,
  RepositoryMeshRoleInvitation,
  RepositoryProjection,
  RepositoryHumanActivityPreference,
  RepositoryHumanActivityPreferencePatch,
  RepositoryMeshGovernancePatch,
  RepositoryEventInput,
  RepositoryAuditInput,
  RepositoryWebMcpGrant,
} from "./repository.ts";
import type { RepositoryAccount, RepositoryPostInput } from "./firestoreRepository.ts";
import { SqliteMeshrRepository } from "./sqliteRepository.ts";

const HUMAN_SESSION_SECONDS = 7 * 24 * 60 * 60;
const HUMAN_IDLE_SECONDS = 12 * 60 * 60;
const IDENTITY_REAUTH_SECONDS = 10 * 60;
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
const TOPIC_ADMIN_BURST = 10;
const TOPIC_ADMIN_PER_MINUTE = 30;
const MESH_INVITATION_BURST = 10;
const MESH_INVITATION_PER_MINUTE = 30;
const ROLE_INVITATION_READ_BURST = 10;
const ROLE_INVITATION_READ_PER_MINUTE = 60;
const ROLE_INVITATION_ACCEPT_BURST = 5;
const ROLE_INVITATION_ACCEPT_PER_MINUTE = 20;
const MESH_ROLE_MUTATION_BURST = 10;
const MESH_ROLE_MUTATION_PER_MINUTE = 30;
const MAX_POSTS_PER_MINUTE = 60;
const POST_BURST = 10;
// Agent hosts normally poll the activity cursor every few seconds. Keep the
// read budget generous enough for that cadence, while bounding repeated cursor
// replays before they fan out into Firestore. A cursorless production read is
// a bounded newest-page catch-up; it never walks the full retention period.
const MAX_AGENT_EVENT_READS_PER_MINUTE = 120;
const AGENT_EVENT_READ_BURST = 30;
const MAX_AGENT_EVENT_READS_PER_AGENT_MINUTE = 300;
const AGENT_EVENT_READ_AGENT_BURST = 60;
const MAX_AGENT_EVENT_PAGE_SIZE = 100;
const POST_RETENTION_SECONDS = 90 * 24 * 60 * 60;
const NEW_IDENTITY_REVIEW_POSTS = 5;
const NEW_IDENTITY_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1_000;

const extractMentionedHandles = (body: string): string[] => [
  ...new Set(
    [...body.matchAll(/@([a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)\b/gi)].map((match) => match[1]!.toLowerCase()),
  ),
].slice(0, 32);
type CostProtectionMode = "normal" | "protect" | "throttle";

function readCostProtectionMode(): CostProtectionMode {
  const value = process.env.MESHR_COST_PROTECTION_MODE?.trim().toLowerCase();
  if (!value || value === "normal") return "normal";
  if (value === "protect" || value === "throttle") return value;
  throw new Error("MESHR_COST_PROTECTION_MODE must be normal, protect, or throttle.");
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
  /** Secret Manager pepper used to address human role invitations. */
  invitationPepper?: string;
  /** Immediately previous invitation pepper retained during rotation. */
  invitationPepperPrevious?: string;
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
    runtime: publicRuntimeKind(row.runtime),
    runtimeLabel: row.runtime_label,
    runtimeSubject: row.runtime_subject,
    definitionDigest: row.definition_digest,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function agentFromRepository(agent: RepositoryAgentInput): StoredAgentProfile {
  return {
    id: agent.agentId,
    ownerId: agent.ownerAccountId,
    name: agent.name,
    handle: agent.handle,
    tagline: agent.tagline,
    interests: agent.interests,
    personality: agent.personality,
    attention: agent.attention as StoredAgentProfile["attention"],
    runtime: publicRuntimeKind(agent.runtime),
    runtimeLabel: agent.runtimeLabel,
    runtimeSubject: agent.runtimeSubject,
    definitionDigest: agent.definitionDigest,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function profileReviewProposalFromRow(row: Record<string, unknown>): RepositoryProfileReviewProposal {
  const resolution = row.resolution;
  return {
    proposalId: String(row.id),
    agentId: String(row.agent_id),
    ownerAccountId: String(row.owner_account_id ?? ""),
    sourceDigest: String(row.source_digest ?? ""),
    requested: JSON.parse(String(row.requested_json ?? "{}")) as Record<string, unknown>,
    pendingFields: JSON.parse(String(row.pending_fields_json ?? "[]")) as string[],
    status: String(row.status) as RepositoryProfileReviewProposal["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    resolution: resolution === "approved" || resolution === "denied" ? resolution : null,
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
    runtime: publicRuntimeKind(row.runtime),
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

/**
 * Renewal credentials are deterministic for a predecessor session. The
 * The recovery secret is loaded only by the API process (and is never written
 * to Firestore). A host that loses the renewal response can prove the same
 * challenge again and recover the already-committed successor without
 * exposing a derivation key to read-only projection workers.
 */
function renewalMaterials(predecessorSessionId: string): Array<{
  token: string;
  sessionId: string;
}> {
  const configured = [
    process.env.MESHR_RENEWAL_RECOVERY_SECRET?.trim(),
    process.env.MESHR_RENEWAL_RECOVERY_SECRET_PREVIOUS?.trim(),
  ].filter((value): value is string => Boolean(value));
  const secrets = configured.length
    ? [...new Set(configured)]
    : [
        // Tests and local fixtures do not mount Secret Manager. Production
        // startup validation requires the real secret, so this fallback is
        // never accepted by a production process.
        "meshr-local-renewal-recovery-v1",
      ];
  return secrets.map((recoverySecret) => {
    const digest = sha256(`meshr-agent-renewal:v1:${recoverySecret}:${predecessorSessionId}`);
    return {
      token: Buffer.from(digest, "hex").toString("base64url"),
      sessionId: `sess_${digest.slice(0, 24)}`,
    };
  });
}

/**
 * During a database cutover only the reviewed predecessor session and the
 * deterministic successor that its signed renewal can produce may write.
 * A second active session for the same binding is intentionally not enough:
 * it could not be reproduced if the cutover rolls back.
 */
export function cutoverValidationSessionIds(predecessorSessionId: string): string[] {
  const normalized = predecessorSessionId.trim();
  if (!normalized) return [];
  return [normalized, ...renewalMaterials(normalized).map((material) => material.sessionId)];
}

export function isCutoverValidationSessionAuthorized(
  sessionId: string | undefined,
  predecessorSessionId: string,
): boolean {
  return typeof sessionId === "string" && cutoverValidationSessionIds(predecessorSessionId).includes(sessionId);
}

/** Stable page-grant material lets a browser retry a handoff after the
 * durable authority transaction succeeded but the response/cookie write was
 * interrupted. The grant remains bearer-protected by the human session and
 * its one-hour expiry/revocation checks; only the server can derive the
 * plaintext from the HttpOnly session hash.
 */
function webMcpMaterial(humanSessionHash: string, agentId: string): {
  token: string;
  tokenHash: string;
} {
  const digest = sha256(`meshr-webmcp:v1:${humanSessionHash}:${agentId}`);
  const token = Buffer.from(digest, "hex").toString("base64url");
  return { token, tokenHash: sha256(token) };
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
  // Fail closed on a misspelled protection mode. Treating an operator typo as
  // normal traffic would silently disable the 95%-budget safety response.
  readCostProtectionMode();
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
  const invitationPepper = options.invitationPepper?.trim() ||
    process.env.MESHR_INVITATION_PEPPER?.trim() ||
    "meshr-local-invitation-pepper";
  const invitationPepperPrevious = options.invitationPepperPrevious?.trim() ||
    process.env.MESHR_INVITATION_PEPPER_PREVIOUS?.trim();
  // The SQLite adapter remains the isolated/local authority. Production
  // always injects Firestore and is blocked at startup if its role-invitation
  // methods are missing.
  const roleInvitationStore: MeshrRepository = repository ?? new SqliteMeshrRepository(database);
  const roleInvitationEmailHashes = (email: string): string[] => [
    hmacSha256(email, invitationPepper),
    ...(invitationPepperPrevious ? [hmacSha256(email, invitationPepperPrevious)] : []),
  ].filter((hash, index, values) => values.indexOf(hash) === index);
  // Read the mode per request so tests and explicitly managed runtime
  // environments cannot accidentally keep a stale launch mode in a long-lived
  // server object. The production overlay renders this value into the pod
  // template so a protected ConfigMap update rolls every replica.
  const assertCostProtectionAllows = (operation: "pairing" | "session" | "mesh"): void => {
    const mode = readCostProtectionMode();
    if (mode === "normal") return;
    throw new ApiError(
      503,
      "cost_protection_active",
      `Meshr is in cost-protection mode; new ${operation} starts are temporarily paused.`,
      60,
    );
  };
  // During a Firestore database cutover the old and new stores must never
  // receive user-visible writes that could be lost if the promotion rolls
  // back. The promotion workflow temporarily permits only its private,
  // owner-controlled validation mesh so release smoke can exercise the real
  // write path while public agents remain read-only.
  const assertDatabaseCutoverAllows = (meshId?: string): void => {
    const mode = process.env.MESHR_DATABASE_CUTOVER_MODE?.trim().toLowerCase() || "off";
    if (mode === "off" || mode === "normal") return;
    if (mode !== "validation") {
      throw new ApiError(503, "database_cutover_active", "Meshr is completing a database cutover; writes are temporarily paused.", 30);
    }
    const validationMeshId = process.env.MESHR_CUTOVER_VALIDATION_MESH_ID?.trim();
    if (!validationMeshId || !meshId || meshId !== validationMeshId) {
      throw new ApiError(503, "database_cutover_active", "Meshr is completing a database cutover; writes are temporarily paused.", 30);
    }
  };
  const assertDatabaseCutoverRouteAllowed = (method: string, path: string): void => {
    const mode = process.env.MESHR_DATABASE_CUTOVER_MODE?.trim().toLowerCase() || "off";
    if (mode !== "off" && mode !== "normal" && mode !== "validation") {
      throw new ApiError(503, "database_cutover_active", "Meshr is completing a database cutover; writes are temporarily paused.", 30);
    }
    if (mode !== "validation" || ["GET", "HEAD", "OPTIONS"].includes(method)) return;
    // Human auth-state/session creation, logout, pairing, profile,
    // membership, governance, and page WebMCP writes stay fenced. Only the
    // reviewed native binding can exercise the write/renewal path while the
    // restored authority is being validated. The endpoint-level scope check
    // below rejects every other binding after authentication.
    const validationRoute = path === "/v1/agent-sessions/heartbeat" ||
      path === "/v1/agent/posts" ||
      /^\/v1\/agent\/posts\/[^/]+\/replies$/.test(path) ||
      // A reviewed validation binding may renew its existing session after
      // the restored authority is serving. New session starts remain fenced.
      /^\/v1\/pairings\/[^/]+\/challenges$/.test(path) ||
      path === "/v1/agent-sessions/renew";
    if (validationRoute) return;
    throw new ApiError(
      503,
      "database_cutover_active",
      "Meshr is completing a database cutover; writes are temporarily paused.",
      30,
    );
  };
  const assertDatabaseCutoverPairingScope = async (
    pairing: PairingRow,
    requestedSessionId?: string,
  ): Promise<void> => {
    const mode = process.env.MESHR_DATABASE_CUTOVER_MODE?.trim().toLowerCase() || "off";
    if (mode !== "validation") return;
    const validationMeshId = process.env.MESHR_CUTOVER_VALIDATION_MESH_ID?.trim();
    const validationBindingId = process.env.MESHR_CUTOVER_VALIDATION_BINDING_ID?.trim();
    const validationAgentId = process.env.MESHR_CUTOVER_VALIDATION_AGENT_ID?.trim();
    const validationSessionId = process.env.MESHR_CUTOVER_VALIDATION_SESSION_ID?.trim();
    if (
      !validationMeshId ||
      !validationBindingId ||
      !validationAgentId ||
      !validationSessionId ||
      !pairing.agent_id
    ) {
      throw new ApiError(503, "database_cutover_active", "Meshr is completing a database cutover; only the reviewed validation session may renew.", 30);
    }
    if (pairing.id !== validationBindingId || pairing.agent_id !== validationAgentId) {
      throw new ApiError(503, "database_cutover_active", "Meshr is completing a database cutover; only the reviewed validation session may renew.", 30);
    }
    // A challenge must be explicitly bound to the canonical predecessor. Do
    // not let an empty body turn this validation-only endpoint into a new
    // session start, and do not accept a challenge for a different session.
    if (requestedSessionId !== validationSessionId) {
      throw new ApiError(503, "database_cutover_active", "Meshr is completing a database cutover; only the reviewed validation session may renew.", 30);
    }
    try {
      let visibility: string | undefined;
      let membership: { status: string } | null | undefined;
      if (repository?.findMeshById && repository.findMeshAgentMembership) {
        const [mesh, member] = await Promise.all([
          repository.findMeshById(validationMeshId),
          repository.findMeshAgentMembership(validationMeshId, pairing.agent_id),
        ]);
        visibility = mesh?.visibility;
        membership = member;
      } else {
        const mesh = db.prepare("SELECT visibility FROM meshes WHERE id = ?").get(validationMeshId) as
          | { visibility: string }
          | undefined;
        visibility = mesh?.visibility;
        membership = db.prepare(
          "SELECT 'joined' AS status FROM mesh_members WHERE mesh_id = ? AND agent_id = ? LIMIT 1",
        ).get(validationMeshId, pairing.agent_id) as { status: string } | undefined;
      }
      if (visibility !== "private" || membership?.status !== "joined") {
        throw new ApiError(503, "database_cutover_active", "Meshr is completing a database cutover; only the reviewed private validation session may renew.", 30);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        503,
        "authorization_store_unavailable",
        error instanceof Error ? error.message : "The validation-session authorization store is unavailable.",
      );
    }
  };
  const assertDatabaseCutoverAgentScope = (principal: AgentPrincipal): void => {
    const mode = process.env.MESHR_DATABASE_CUTOVER_MODE?.trim().toLowerCase() || "off";
    if (mode !== "validation") return;
    const validationBindingId = process.env.MESHR_CUTOVER_VALIDATION_BINDING_ID?.trim();
    const validationAgentId = process.env.MESHR_CUTOVER_VALIDATION_AGENT_ID?.trim();
    const validationSessionId = process.env.MESHR_CUTOVER_VALIDATION_SESSION_ID?.trim();
    if (
      !validationBindingId ||
      !validationAgentId ||
      !validationSessionId ||
      principal.bindingId !== validationBindingId ||
      principal.agentId !== validationAgentId ||
      !isCutoverValidationSessionAuthorized(principal.sessionId, validationSessionId)
    ) {
      throw new ApiError(503, "database_cutover_active", "Meshr is completing a database cutover; only the reviewed validation session may write.", 30);
    }
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
      if (error instanceof Error && error.message === "owner_transfer_requires_member") {
        throw new ApiError(
          409,
          "owner_transfer_requires_member",
          "Add the account as a steward or observer before transferring ownership.",
        );
      }
      if (error instanceof Error && error.message === "owner_transfer_requires_acceptance") {
        throw new ApiError(
          409,
          "owner_transfer_requires_acceptance",
          "Ownership transfer requires the target account to explicitly accept it.",
        );
      }
      if (error instanceof Error && error.message === "role_invitation_required") {
        throw new ApiError(
          409,
          "role_invitation_required",
          "Invite this account and wait for it to accept before changing its role.",
        );
      }
      if (error instanceof Error && error.message === "agent_limit_reached") {
        throw new ApiError(429, "agent_limit_reached", "This account has reached the 25-agent launch limit.");
      }
      if (error instanceof Error && error.message === "agent_access_denied") {
        throw new ApiError(403, "agent_access_denied", "Only your connected agents can join this mesh.");
      }
      if (error instanceof Error && error.message === "post_authorization_denied") {
        throw new ApiError(403, "post_authorization_denied", "This agent is not authorized to act on that post.");
      }
      if (error instanceof Error && error.message === "account_not_found") {
        throw new ApiError(401, "authentication_required", "The owner account is no longer available.");
      }
      if (error instanceof Error && error.message === "pairing_authorization_denied") {
        throw new ApiError(401, "authentication_required", "The approving human session is no longer valid.");
      }
      if (error instanceof Error && error.message === "human_session_invalid") {
        throw new ApiError(401, "authentication_required", "The human session is no longer valid.");
      }
      if (error instanceof Error && error.message === "mesh_already_exists") {
        throw new ApiError(409, "mesh_already_exists", "That mesh already exists.");
      }
      if (error instanceof Error && error.message === "mesh_governance_denied") {
        throw new ApiError(403, "mesh_governance_denied", "Only a mesh owner can change governance.");
      }
      if (error instanceof Error && error.message === "moderation_authorization_denied") {
        throw new ApiError(403, "moderation_authorization_denied", "Your moderation role or session is no longer valid.");
      }
      if (error instanceof Error && error.message === "mesh_limit_reached") {
        throw new ApiError(429, "mesh_limit_reached", "This account has reached its mesh limit.");
      }
      if (error instanceof Error && error.message === "agent_mesh_limit_reached") {
        throw new ApiError(429, "agent_mesh_limit_reached", "This agent has reached its mesh limit.");
      }
      if (error instanceof Error && error.message === "invite_required") {
        throw new ApiError(403, "invite_required", "This mesh requires an invitation.");
      }
      if (error instanceof Error && error.message === "invitation_invalid") {
        throw new ApiError(403, "invitation_invalid", "That invitation is not valid for this agent or mesh.");
      }
      if (error instanceof Error && error.message === "invitation_expired") {
        throw new ApiError(410, "invitation_expired", "That invitation has expired.");
      }
      if (error instanceof Error && error.message === "invitation_redeemed") {
        throw new ApiError(410, "invitation_redeemed", "That invitation has already been used.");
      }
      if (error instanceof Error && error.message === "invitation_revoked") {
        throw new ApiError(410, "invitation_revoked", "That invitation has been revoked.");
      }
      if (error instanceof Error && error.message === "invitation_not_active") {
        throw new ApiError(409, "invitation_not_active", "That invitation is no longer active.");
      }
      if (error instanceof Error && error.message === "invitation_not_found") {
        throw new ApiError(404, "invitation_not_found", "Invitation not found.");
      }
      if (error instanceof Error && error.message === "invitation_already_exists") {
        throw new ApiError(409, "invitation_already_exists", "That invitation already exists.");
      }
      if (error instanceof Error && error.message === "mesh_unavailable") {
        throw new ApiError(409, "mesh_unavailable", "This mesh is not accepting new activity.");
      }
      if (error instanceof Error && error.message === "idempotency_conflict") {
        throw new ApiError(409, "idempotency_conflict", "This idempotency key was already used for a different request.");
      }
      if (error instanceof Error && error.message === "profile_conflict") {
        throw new ApiError(
          409,
          "profile_conflict",
          "The agent profile changed while this runtime was preparing a reload. Refresh the definition and retry.",
        );
      }
      if (error instanceof Error && error.message === "profile_proposal_stale") {
        throw new ApiError(
          409,
          "profile_proposal_stale",
          "This profile proposal is based on an older agent revision. Reload the agent definition and review the new proposal.",
        );
      }
      if (error instanceof Error && error.message === "idempotency_expired") {
        throw new ApiError(409, "idempotency_expired", "The idempotency record has expired; retry with a new key.");
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
      if (error instanceof Error && error.message === "topic_already_exists") {
        throw new ApiError(409, "topic_already_exists", "That topic already exists.");
      }
      if (error instanceof Error && error.message === "topic_name_taken") {
        throw new ApiError(409, "topic_name_taken", "Choose a different topic name.");
      }
      if (error instanceof Error && error.message === "topic_limit_reached") {
        throw new ApiError(429, "topic_limit_reached", "This mesh has reached its topic limit.");
      }
      if (error instanceof Error && error.message === "topic_not_empty") {
        throw new ApiError(409, "topic_not_empty", "Topics with retained posts cannot be deleted.");
      }
      if (error instanceof Error && error.message === "topic_in_use") {
        throw new ApiError(409, "topic_in_use", "Clear the topic's follows before deleting it.");
      }
      if (error instanceof Error && error.message === "role_invitation_already_exists") {
        throw new ApiError(409, "role_invitation_already_exists", "An active invitation already exists for this request.");
      }
      if (error instanceof Error && error.message === "role_invitation_limit_reached") {
        throw new ApiError(429, "role_invitation_limit_reached", "This mesh has reached its active role-invitation limit.");
      }
      if (error instanceof Error && error.message === "role_invitation_not_found") {
        throw new ApiError(404, "role_invitation_not_found", "Role invitation not found.");
      }
      if (error instanceof Error && error.message === "role_invitation_not_active") {
        throw new ApiError(409, "role_invitation_not_active", "That role invitation is no longer active.");
      }
      if (error instanceof Error && error.message === "role_invitation_invalid") {
        throw new ApiError(403, "role_invitation_invalid", "That role invitation token is invalid.");
      }
      if (error instanceof Error && error.message === "role_invitation_target_mismatch") {
        throw new ApiError(403, "role_invitation_target_mismatch", "This invitation is addressed to a different account.");
      }
      if (error instanceof Error && error.message === "role_invitation_expired") {
        throw new ApiError(410, "role_invitation_expired", "That role invitation has expired.");
      }
      if (error instanceof Error && error.message === "role_invitation_revoked") {
        throw new ApiError(410, "role_invitation_revoked", "That role invitation has been revoked.");
      }
      if (error instanceof Error && error.message === "role_invitation_redeemed") {
        throw new ApiError(410, "role_invitation_redeemed", "That role invitation has already been accepted.");
      }
      if (error instanceof Error && error.message === "role_invitation_inviter_not_owner") {
        throw new ApiError(409, "role_invitation_inviter_not_owner", "The transferring owner is no longer the current owner.");
      }
      if (error instanceof Error && error.message === "owner_role_protected") {
        throw new ApiError(409, "owner_role_protected", "An owner must transfer ownership explicitly before accepting a collaborator role.");
      }
      if (error instanceof Error && error.message === "last_topic") {
        throw new ApiError(409, "last_topic", "A mesh must keep at least one topic.");
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
  const mapRoleInvitationError = (error: unknown): never => {
    if (!(error instanceof Error)) throw error;
    const mappings: Record<string, [number, string, string]> = {
      role_invitation_already_exists: [409, "role_invitation_already_exists", "An active invitation already exists for this request."],
      role_invitation_limit_reached: [429, "role_invitation_limit_reached", "This mesh has reached its active role-invitation limit."],
      role_invitation_not_found: [404, "role_invitation_not_found", "Role invitation not found."],
      role_invitation_not_active: [409, "role_invitation_not_active", "That role invitation is no longer active."],
      role_invitation_invalid: [403, "role_invitation_invalid", "That role invitation token is invalid."],
      role_invitation_target_mismatch: [403, "role_invitation_target_mismatch", "This invitation is addressed to a different account."],
      role_invitation_expired: [410, "role_invitation_expired", "That role invitation has expired."],
      role_invitation_revoked: [410, "role_invitation_revoked", "That role invitation has been revoked."],
      role_invitation_redeemed: [410, "role_invitation_redeemed", "That role invitation has already been accepted."],
      role_invitation_inviter_not_owner: [409, "role_invitation_inviter_not_owner", "The transferring owner is no longer the current owner."],
      owner_role_protected: [409, "owner_role_protected", "An owner must transfer ownership explicitly before accepting a collaborator role."],
      mesh_limit_reached: [429, "mesh_limit_reached", "This account has reached its mesh limit."],
      mesh_not_found: [404, "mesh_not_found", "Mesh not found."],
      account_not_found: [401, "authentication_required", "Sign in is required."],
      mesh_governance_denied: [403, "mesh_governance_denied", "You do not have the required mesh role."],
      idempotency_conflict: [409, "idempotency_conflict", "This idempotency key was already used for a different request."],
    };
    const mapping = mappings[error.message];
    if (mapping) throw new ApiError(mapping[0], mapping[1], mapping[2]);
    // A repository failure during invitation metadata lookup or acceptance
    // must never fall through as a generic 500: callers should be able to
    // retry without learning whether a target account or invitation exists.
    throw new ApiError(
      503,
      "governance_store_unavailable",
      "The role-invitation store is temporarily unavailable. Try again shortly.",
    );
  };
  const repositoryAgent = (
    agent: AgentRow,
    bindingId?: string,
    profileReview?: {
      sourceDigest: string;
      requested: Record<string, unknown>;
      pendingFields: string[];
      createdAt: string;
    },
    actingAccountId?: string,
    humanSessionHash?: string,
  ): RepositoryAgentInput => ({
    agentId: agent.id,
    bindingId,
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
    ...(actingAccountId ? { actingAccountId, humanSessionHash } : {}),
    ...(profileReview
      ? {
          profileReviewProposal: {
            proposalId: `profile_review_${sha256(`${agent.id}:${profileReview.sourceDigest}`).slice(0, 40)}`,
            ...profileReview,
          },
        }
      : {}),
  });
  const projectionHydratedAt = new Map<string, number>();
  const scopedProjectionCache = new Map<string, RepositoryProjection>();
  const humanSessionTouchedAt = new Map<string, number>();
  const projectionCacheKey = (scope: { accountId?: string; agentId?: string }): string =>
    scope.accountId || scope.agentId
      ? `${scope.accountId ?? ""}:${scope.agentId ?? ""}`
      : "public";
  const hydrateProjection = async (
    scope: { accountId?: string; agentId?: string },
    force = false,
    options: { includePosts?: boolean; includeActivity?: boolean } = {},
  ): Promise<void> => {
    if (!repository?.loadProjection) return;
    const includePosts = options.includePosts !== false;
    const key = projectionCacheKey(scope);
    const last = projectionHydratedAt.get(key) ?? 0;
    if (!force && Date.now() - last < 10_000) return;
    const projection = await repository.loadProjection({
      ...scope,
      forcePublicPosts: includePosts && force,
      includePosts,
      includeActivity: options.includeActivity,
    });
    scopedProjectionCache.set(key, projection);
    // A durable retention sweep can race an older projection snapshot. Keep
    // the local FK-safe cache deterministic by admitting only posts whose
    // parent chain is present in the same snapshot and in the same mesh.
    // Orphan replies are omitted until the authoritative snapshot contains a
    // retained/tombstoned parent; they must never make hydration fail or
    // resurrect a deleted thread through a stale local row.
    const orderedProjectionPosts = [...projection.posts].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.postId.localeCompare(right.postId));
    const projectionPosts: typeof projection.posts = [];
    const admittedPostIds = new Set<string>();
    const admittedPostMeshes = new Map<string, string>();
    for (const post of orderedProjectionPosts) {
      if (
        post.parentPostId &&
        (!admittedPostIds.has(post.parentPostId) ||
          admittedPostMeshes.get(post.parentPostId) !== post.meshId)
      ) {
        continue;
      }
      projectionPosts.push(post);
      admittedPostIds.add(post.postId);
      admittedPostMeshes.set(post.postId, post.meshId);
    }
    database.transaction(() => {
      // A projection is a cache, not an authority. Reconcile the scoped
      // records that affect authorization before applying the fresh snapshot;
      // otherwise a role or mesh removed on another API replica could linger
      // in SQLite and be mistaken for durable access.
      // Public meshes are shared discovery state, so every authoritative
      // refresh (including the shared scope) evicts rows omitted by Firestore.
      // This matters when another replica changes a mesh from public to
      // private: retaining the old row would expose its aggregate activity
      // until the next process restart. A capped discovery snapshot is not
      // authoritative enough to evict anything.
      const publicMeshIds = projection.meshes
        .filter((mesh) => mesh.visibility === "public")
        .map((mesh) => mesh.meshId);
      const stalePublicMeshes = projection.publicMeshesTruncated
        ? []
        : publicMeshIds.length
          ? db.prepare(
              `SELECT id FROM meshes
               WHERE visibility = 'public' AND id NOT IN (${publicMeshIds.map(() => "?").join(",")})`,
            ).all(...publicMeshIds) as Array<{ id: string }>
          : db.prepare("SELECT id FROM meshes WHERE visibility = 'public'").all() as Array<{ id: string }>;
      for (const stale of stalePublicMeshes) {
        db.prepare("DELETE FROM topics WHERE mesh_id = ?").run(stale.id);
        db.prepare("DELETE FROM posts WHERE mesh_id = ?").run(stale.id);
        db.prepare("DELETE FROM meshes WHERE id = ? AND visibility = 'public'").run(stale.id);
      }
      if (scope.accountId || scope.agentId) {
        const accessibleMeshIds = projection.meshes.map((mesh) => mesh.meshId);
        const placeholders = accessibleMeshIds.length
          ? accessibleMeshIds.map(() => "?").join(",")
          : "NULL";
        if (scope.accountId) {
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
          if (includePosts) {
            const meshPosts = projectionPosts.filter((post) => post.meshId === meshId);
            const postIds = meshPosts.map((post) => post.postId);
            if (postIds.length) {
              db.prepare(
                `DELETE FROM posts WHERE mesh_id = ? AND id NOT IN (${postIds.map(() => "?").join(",")})`,
              ).run(meshId, ...postIds);
            } else {
              db.prepare("DELETE FROM posts WHERE mesh_id = ?").run(meshId);
            }
          }
          // Account-scoped snapshots include every visible agent membership,
          // so they can reconcile a mesh as a whole. Agent-scoped snapshots
          // intentionally include only the requesting agent; reconciling a
          // whole mesh there would delete other agents' cached memberships.
          if (scope.accountId) {
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
            if (membershipKeys.length) {
              db.prepare(
                `DELETE FROM mesh_agent_memberships
                 WHERE mesh_id = ? AND (mesh_id || ':' || agent_id) NOT IN (${membershipKeys.map(() => "?").join(",")})`,
              ).run(meshId, ...membershipKeys);
            } else {
              db.prepare("DELETE FROM mesh_agent_memberships WHERE mesh_id = ?").run(meshId);
            }
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
          const membershipKeys = projection.memberships
            .filter((membership) => membership.agentId === scope.agentId)
            .map((membership) => `${membership.meshId}:${membership.agentId}`);
          if (membershipKeys.length) {
            db.prepare(
              `DELETE FROM mesh_agent_memberships
               WHERE agent_id = ? AND (mesh_id || ':' || agent_id) NOT IN (${membershipKeys.map(() => "?").join(",")})`,
            ).run(scope.agentId, ...membershipKeys);
          } else {
            db.prepare("DELETE FROM mesh_agent_memberships WHERE agent_id = ?").run(scope.agentId);
          }
        }
      } else {
        // The shared public scope does not reconcile private memberships, but
        // it still refreshes the public topic/post rows below.
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
          if (includePosts) {
            const meshPosts = projectionPosts.filter((post) => post.meshId === meshId);
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
             id, owner_account_id, name, description, visibility, join_policy,
             lifecycle, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             owner_account_id = excluded.owner_account_id, name = excluded.name,
             description = excluded.description, visibility = excluded.visibility,
             join_policy = excluded.join_policy, lifecycle = excluded.lifecycle,
             updated_at = excluded.updated_at`,
        ).run(
          mesh.meshId,
          mesh.ownerAccountId,
          mesh.name,
          mesh.description,
          mesh.visibility,
          mesh.admission,
          mesh.lifecycle,
          mesh.createdAt,
          mesh.updatedAt,
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
        db.prepare(
          `INSERT INTO mesh_agent_memberships(
             mesh_id, agent_id, status, attention_policy_json,
             admission_provenance, joined_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(mesh_id, agent_id) DO UPDATE SET
             status = excluded.status,
             attention_policy_json = excluded.attention_policy_json,
             admission_provenance = excluded.admission_provenance,
             joined_at = excluded.joined_at,
             updated_at = excluded.updated_at`,
        ).run(
          membership.meshId,
          membership.agentId,
          membership.status,
          JSON.stringify(membership.attentionPolicy),
          membership.admissionProvenance,
          membership.joinedAt,
          membership.updatedAt,
        );
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
      if (includePosts) {
        for (const post of projectionPosts) {
          db.prepare(
            `INSERT INTO posts(
               id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body, created_at,
               moderation_state, moderation_reason, expires_at
             ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               mesh_id = excluded.mesh_id, topic_id = excluded.topic_id,
               agent_id = excluded.agent_id, session_id = excluded.session_id,
               parent_post_id = excluded.parent_post_id,
               body = excluded.body, created_at = excluded.created_at,
               moderation_state = excluded.moderation_state,
               moderation_reason = excluded.moderation_reason,
               expires_at = excluded.expires_at`,
          ).run(
            post.postId,
            post.meshId,
            post.topicId,
            post.agentId,
            post.sessionId,
            post.parentPostId,
            post.body,
            post.createdAt,
            post.moderationState,
            post.moderationReason,
            post.expiresAt,
          );
        }
      }
      for (const follow of projection.follows) {
        db.prepare(
          `INSERT OR IGNORE INTO follows(topic_id, agent_id, created_at) VALUES(?, ?, ?)`,
        ).run(follow.topicId, follow.agentId, follow.updatedAt);
      }
    });
    projectionHydratedAt.set(key, Date.now());
  };

  const refreshHumanProjection = async (accountId: string): Promise<void> => {
    try {
      await hydrateProjection({ accountId }, true);
    } catch (error) {
      throw new ApiError(
        503,
        "projection_unavailable",
        error instanceof Error ? error.message : "The durable projection is unavailable.",
      );
    }
  };

  const refreshHumanActivityProjection = async (accountId: string): Promise<void> => {
    try {
      await hydrateProjection({ accountId }, true, { includePosts: false });
    } catch (error) {
      throw new ApiError(
        503,
        "projection_unavailable",
        error instanceof Error ? error.message : "The durable topology projection is unavailable.",
      );
    }
  };

  const cachedProjection = (scope: { accountId?: string; agentId?: string }): RepositoryProjection | undefined => {
    return scopedProjectionCache.get(projectionCacheKey(scope));
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
  if (strictRuntimeSessions) {
    // A local compatibility process may have issued twelve-hour fixture
    // tokens before the strict launch policy was enabled. Clamp only those
    // legacy active rows to the lifetime they were actually meant to have so
    // a strict restart cannot accidentally keep an old bearer alive. Fresh
    // strict sessions (including renewals) already have a fifteen-minute
    // created_at/expiry window and are left untouched.
    const legacySessions = db
      .prepare(
        `SELECT session_id, created_at, expires_at
         FROM agent_sessions WHERE status = 'active'`,
      )
      .all() as Array<{ session_id: string; created_at: string; expires_at: string }>;
    database.transaction(() => {
      for (const session of legacySessions) {
        const createdAt = Date.parse(session.created_at);
        const expiresAt = Date.parse(session.expires_at);
        if (
          !Number.isFinite(createdAt) ||
          !Number.isFinite(expiresAt) ||
          expiresAt - createdAt <= AGENT_SESSION_SECONDS * 1_000
        ) {
          continue;
        }
        db.prepare("UPDATE agent_sessions SET expires_at = ? WHERE session_id = ? AND status = 'active'")
          .run(addSeconds(new Date(createdAt), AGENT_SESSION_SECONDS), session.session_id);
      }
    });
  }
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
  const normalPostLimiter = new TokenBucketLimiter(POST_BURST, MAX_POSTS_PER_MINUTE / 60);
  const throttlePostLimiter = new TokenBucketLimiter(5, 30 / 60);
  const normalAccountPostLimiter = new TokenBucketLimiter(
    MAX_AGENTS_PER_ACCOUNT * MAX_POSTS_PER_MINUTE,
    (MAX_AGENTS_PER_ACCOUNT * MAX_POSTS_PER_MINUTE) / 60,
  );
  const throttleAccountPostLimiter = new TokenBucketLimiter(
    MAX_AGENTS_PER_ACCOUNT * 30,
    (MAX_AGENTS_PER_ACCOUNT * 30) / 60,
  );
  const normalGlobalPostLimiter = new TokenBucketLimiter(200, 120);
  const throttleGlobalPostLimiter = new TokenBucketLimiter(100, 60);
  // Pairing and challenge issuance are credential-material writes. Cloud
  // Armor provides an edge-wide ceiling, while these bounded per-process
  // buckets stop a single source from consuming the Firestore write budget
  // before the edge rule reacts. The challenge limiter is also keyed by the
  // pairing id so one approved binding cannot be used as a write sink.
  const pairingCreationLimiter = new TokenBucketLimiter(5, 5 / 60);
  const pairingChallengeIpLimiter = new TokenBucketLimiter(30, 30 / 60);
  const pairingChallengePairLimiter = new TokenBucketLimiter(10, 10 / 60);
  const agentSessionIpLimiter = new TokenBucketLimiter(30, 30 / 60);
  const topicAdminLimiter = new TokenBucketLimiter(
    TOPIC_ADMIN_BURST,
    TOPIC_ADMIN_PER_MINUTE / 60,
  );
  const meshInvitationLimiter = new TokenBucketLimiter(
    MESH_INVITATION_BURST,
    MESH_INVITATION_PER_MINUTE / 60,
  );
  const roleInvitationReadLimiter = new TokenBucketLimiter(
    ROLE_INVITATION_READ_BURST,
    ROLE_INVITATION_READ_PER_MINUTE / 60,
  );
  const roleInvitationAcceptLimiter = new TokenBucketLimiter(
    ROLE_INVITATION_ACCEPT_BURST,
    ROLE_INVITATION_ACCEPT_PER_MINUTE / 60,
  );
  const meshRoleMutationLimiter = new TokenBucketLimiter(
    MESH_ROLE_MUTATION_BURST,
    MESH_ROLE_MUTATION_PER_MINUTE / 60,
  );
  // Event observation is a potentially expensive fan-out read in Firestore:
  // one request can touch every public mesh visible to the agent. Apply both
  // an agent-wide and an agent+source guard. Cloud Armor remains the edge-wide
  // control; these process-local buckets protect each API replica and bound
  // cursor replay/mesh fan-out during a provider or edge incident.
  const agentEventReadLimiter = new TokenBucketLimiter(
    AGENT_EVENT_READ_BURST,
    MAX_AGENT_EVENT_READS_PER_MINUTE / 60,
  );
  const agentEventReadAgentLimiter = new TokenBucketLimiter(
    AGENT_EVENT_READ_AGENT_BURST,
    MAX_AGENT_EVENT_READS_PER_AGENT_MINUTE / 60,
  );

  const requestClientKey = (request: IncomingMessage): string => {
    const forwarded = request.headers["cf-connecting-ip"];
    const candidate = typeof forwarded === "string" ? forwarded.trim() : "";
    if (candidate && isIP(candidate) !== 0) return `ip:${candidate}`;
    const remote = request.socket?.remoteAddress?.trim() ?? "unknown";
    return `ip:${remote && isIP(remote) !== 0 ? remote : "unknown"}`;
  };

  const enforceEndpointRate = (
    limiter: TokenBucketLimiter,
    key: string,
    code: string,
    message: string,
  ): void => {
    const result = limiter.consume(key);
    if (!result.allowed) {
      throw new ApiError(429, code, message, result.retryAfterSeconds);
    }
  };
  const enforceGovernanceRate = async (
    accountId: string,
    options: {
      bucket?: string;
      code?: string;
      message?: string;
      capacity?: number;
      perMinute?: number;
    } = {},
  ): Promise<void> => {
    const bucket = options.bucket ?? "topic";
    const code = options.code ?? "topic_rate_limited";
    const message = options.message ?? "Topic administration is temporarily rate limited. Try again shortly.";
    const limits = (() => {
      switch (bucket) {
        case "mesh-invitation":
          return { capacity: MESH_INVITATION_BURST, perMinute: MESH_INVITATION_PER_MINUTE };
        case "role-invitation-read":
          return { capacity: ROLE_INVITATION_READ_BURST, perMinute: ROLE_INVITATION_READ_PER_MINUTE };
        case "role-invitation-accept":
          return { capacity: ROLE_INVITATION_ACCEPT_BURST, perMinute: ROLE_INVITATION_ACCEPT_PER_MINUTE };
        case "mesh-role-mutation":
          return { capacity: MESH_ROLE_MUTATION_BURST, perMinute: MESH_ROLE_MUTATION_PER_MINUTE };
        default:
          return { capacity: TOPIC_ADMIN_BURST, perMinute: TOPIC_ADMIN_PER_MINUTE };
      }
    })();
    const capacity = options.capacity ?? limits.capacity;
    const perMinute = options.perMinute ?? limits.perMinute;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isFinite(perMinute) || perMinute <= 0) {
      throw new ApiError(500, "configuration_error", "Invalid governance rate-limit configuration.");
    }
    if (repository?.consumeGovernanceRateLimit) {
      let result: { allowed: boolean; retryAfterSeconds: number };
      try {
        result = await repository.consumeGovernanceRateLimit({
          accountId,
          bucket,
          now: database.now(),
          capacity,
          refillPerSecond: perMinute / 60,
        });
      } catch (error) {
        throw new ApiError(
          503,
          "governance_store_unavailable",
          error instanceof Error ? error.message : "The governance store is unavailable.",
        );
      }
      if (!result.allowed) {
        throw new ApiError(
          429,
          code,
          message,
          result.retryAfterSeconds,
        );
      }
      return;
    }
    const limiter = (() => {
      switch (bucket) {
        case "mesh-invitation":
          return meshInvitationLimiter;
        case "role-invitation-read":
          return roleInvitationReadLimiter;
        case "role-invitation-accept":
          return roleInvitationAcceptLimiter;
        case "mesh-role-mutation":
          return meshRoleMutationLimiter;
        default:
          return topicAdminLimiter;
      }
    })();
    enforceEndpointRate(limiter, accountId, code, message);
  };
  const pageAuthorityJoin = webMcpTransfersSession
    ? `JOIN agent_authority aa
           ON aa.agent_id = wg.agent_id
          AND aa.authority_kind = 'page'
          AND aa.session_id = wg.session_id
          AND aa.epoch = wg.authority_epoch
       JOIN webmcp_authority wa
           ON wa.human_session_hash = wg.human_session_hash
          AND wa.grant_id = wg.token_hash
          AND wa.epoch = wg.authority_epoch
          AND wa.revoked_at IS NULL`
    : "";

  const enforcePostCapacity = (agent: AgentRow): void => {
    const throttled = readCostProtectionMode() === "throttle";
    const globalResult = (throttled ? throttleGlobalPostLimiter : normalGlobalPostLimiter).consume("global");
    if (!globalResult.allowed) {
      throw new ApiError(
        429,
        "global_rate_limited",
        "Meshr is processing the maximum write rate. Retry after the indicated delay.",
        globalResult.retryAfterSeconds,
      );
    }
    const agentResult = (throttled ? throttlePostLimiter : normalPostLimiter).consume(`agent:${agent.id}`);
    if (!agentResult.allowed) {
      throw new ApiError(
        429,
        "agent_rate_limited",
        "This agent is posting too quickly. Retry after the indicated delay.",
        agentResult.retryAfterSeconds,
      );
    }
    const accountResult = (throttled ? throttleAccountPostLimiter : normalAccountPostLimiter)
      .consume(`account:${agent.owner_account_id}`);
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

  const requireHuman = async (
    request: IncomingMessage,
    refreshProjection: boolean | "cached" = false,
    options: { touchSession?: boolean } = {},
  ): Promise<HumanPrincipal> => {
    const touchSession = options.touchSession !== false;
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
    if (touchSession) {
      db.prepare("UPDATE human_sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, tokenHash);
    }
    if (repository && touchSession) {
      const lastDurableTouch = humanSessionTouchedAt.get(tokenHash) ?? 0;
      const shouldTouchDurableSession = Date.parse(now) - lastDurableTouch >= 60_000;
      try {
        if (shouldTouchDurableSession) await repository.touchHumanSession(tokenHash, now);
      } catch (error) {
        throw new ApiError(
          503,
          "session_store_unavailable",
          error instanceof Error ? error.message : "The session store is unavailable.",
        );
      }
      if (shouldTouchDurableSession) humanSessionTouchedAt.set(tokenHash, Date.parse(now));
      if (refreshProjection === true) await refreshHumanProjection(accountId);
      else if (refreshProjection === "cached") {
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
    // In Firestore mode this is an authoritative read, not a request to
    // materialize a partial SQLite row. A claimed pairing references the
    // durable agent/account and inserting it first would violate the local
    // projection's foreign keys on a fresh API replica. Write projections
    // only through the explicit hydration paths that insert dependencies in
    // the correct order.
    if (repository) return pairing;
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
    if (repository) return pairing;
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
      // Durable challenge rows are sufficient for verification and consume;
      // do not mirror them into a fresh SQLite projection where the pairing
      // (and its referenced agent/account) may not yet have been hydrated.
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
    options: { allowExpired?: boolean } = {},
  ): Promise<boolean> => {
    if (!repository?.findRuntimeSessionByTokenHash || !repository.findAgentById) return false;
    const durableSession = await repository.findRuntimeSessionByTokenHash(tokenHash);
    if (
      !durableSession ||
      durableSession.status !== "active" ||
      (!options.allowExpired && Date.parse(durableSession.expiresAt) <= Date.parse(now))
    ) {
      return false;
    }
    const durableAgent = await repository.findAgentById(durableSession.agentId);
    if (!durableAgent) {
      return false;
    }
    const account = await repository.findAccountById(durableAgent.ownerAccountId);
    if (!account) {
      return false;
    }
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

  // An approved pairing can be replayed on a replica that never handled the
  // approval request. Hydrate the canonical agent before returning that
  // idempotent response instead of dereferencing a missing local row.
  const hydrateDurableAgent = async (agentId: string): Promise<AgentRow | undefined> => {
    if (!repository?.findAgentById) return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
    let durableAgent: RepositoryAgentInput | null;
    try {
      durableAgent = await repository.findAgentById(agentId);
    } catch (error) {
      throw new ApiError(
        503,
        "agent_store_unavailable",
        error instanceof Error ? error.message : "The agent store is unavailable.",
      );
    }
    if (!durableAgent) return undefined;
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
           public_key_pem = excluded.public_key_pem, definition_digest = excluded.definition_digest,
           updated_at = excluded.updated_at`,
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
    });
    return db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
  };

  const requireAgent = async (
    request: IncomingMessage,
    options: {
      allowStaleHeartbeat?: boolean;
      refreshProjection?: boolean;
      /** Refresh the canonical profile before applying attention policy. */
      refreshAgent?: boolean;
      /** Read-only probes can validate liveness without extending a session. */
      touchHeartbeat?: boolean;
    } = {},
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
        `SELECT s.agent_id, s.pairing_id, a.owner_account_id, s.session_id, s.runtime_kind,
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
          pairing_id: string;
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
      if (durableSession?.status === "superseded") {
        throw new ApiError(
          401,
          "session_superseded",
          "This runtime session has been superseded by a newer session.",
        );
      }
      if (durableSession?.status === "revoked") {
        throw new ApiError(401, "session_invalid", "This runtime session has been revoked.");
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
            `SELECT s.agent_id, s.pairing_id, a.owner_account_id, s.session_id, s.runtime_kind,
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
                    `SELECT s.agent_id, s.pairing_id, a.owner_account_id, s.session_id, s.runtime_kind,
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
    if (!row && !repository) {
      const superseded = db
        .prepare("SELECT status FROM agent_sessions WHERE token_hash = ? LIMIT 1")
        .get(tokenHash) as { status: string } | undefined;
      if (superseded?.status === "superseded") {
        throw new ApiError(
          401,
          "session_superseded",
          "This runtime session has been superseded by a newer session.",
        );
      }
    }
    if (!row) throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid.");
    if (repository && options.refreshAgent) {
      // Attention is an authorization boundary, not a disposable read-model
      // hint. A profile reload on another API replica must take effect before
      // this request decides whether the agent may browse or publish.
      const durableAgent = await hydrateDurableAgent(row.agent_id);
      if (!durableAgent) {
        throw new ApiError(401, "agent_authentication_failed", "Agent identity is no longer available.");
      }
    }
    if (repository && options.refreshProjection === true) {
      try {
        await hydrateProjection({ agentId: row.agent_id }, true);
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
    // Presence is driven by explicit heartbeats and mutating agent activity.
    // Read-only observations must not keep a host session online after the
    // native runtime exits, which also makes lifecycle probes non-extending.
    const touchHeartbeat = options.touchHeartbeat ?? request.method !== "GET";
    if (touchHeartbeat) {
      db.prepare(
        "UPDATE agent_sessions SET last_seen_at = ? WHERE token_hash = ? AND status = 'active'",
      ).run(now, tokenHash);
    }
    return {
      agentId: row.agent_id,
      ownerId: row.owner_account_id,
      sessionHash: tokenHash,
      bindingId: row.pairing_id,
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
         `SELECT wg.token_hash, wg.human_session_hash, wg.agent_id, wg.created_at,
                wg.expires_at, wg.last_used_at, wg.revoked_at, wg.session_id, wg.authority_epoch
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
            // The human may not itself be a member of a private mesh. Page
            // tools re-check membership and attention in the authoritative
            // repository; only hydrate the canonical profile here. This
            // status/read path must never scan retained post bodies.
            await hydrateDurableAgent(durableGrant.agentId);
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
              if (webMcpTransfersSession) {
                // The page grant and its agent fence can be hydrated on a
                // different API replica after a transfer. Restore the
                // human-scoped authority row as well, otherwise the joined
                // grant query below (and every page tool) fails closed even
                // though Firestore still holds a valid grant.
                db.prepare(
                  `INSERT INTO webmcp_authority(
                     human_session_hash, epoch, grant_id, agent_id, session_id, updated_at, revoked_at
                   ) VALUES(?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(human_session_hash) DO UPDATE SET
                     epoch = excluded.epoch, grant_id = excluded.grant_id,
                     agent_id = excluded.agent_id, session_id = excluded.session_id,
                     updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`,
                ).run(
                  durableGrant.humanSessionHash,
                  durableGrant.authorityEpoch,
                  durableGrant.tokenHash,
                  durableGrant.agentId,
                  durableGrant.sessionId,
                  durableGrant.lastUsedAt,
                  durableGrant.revokedAt,
                );
              }
            });
              grant = db
                .prepare(
                  `SELECT wg.token_hash, wg.human_session_hash, wg.agent_id, wg.created_at,
                          wg.expires_at, wg.last_used_at, wg.revoked_at, wg.session_id, wg.authority_epoch
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

  // Reconcile a durable page grant into the disposable local projection. This
  // is also the recovery path for a transfer whose HTTP response/cookie was
  // lost after Firestore committed the authority transaction: the stable
  // grant material can be reissued without superseding the agent a second
  // time.
  const reconcileDurableWebMcpGrant = async (
    durableGrant: RepositoryWebMcpGrant,
    human: HumanPrincipal,
  ): Promise<{ grant: WebMcpGrantRow; agent: AgentRow } | null> => {
    if (
      durableGrant.revokedAt ||
      Date.parse(durableGrant.expiresAt) <= Date.parse(database.now()) ||
      !repository?.findAgentById
    ) {
      return null;
    }
    const durableAgent = await repository.findAgentById(durableGrant.agentId);
    if (!durableAgent || durableAgent.ownerAccountId !== human.accountId) return null;
    await hydrateProjection({ agentId: durableGrant.agentId }, true);
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
      if (webMcpTransfersSession) {
        db.prepare(
          `INSERT INTO webmcp_authority(
             human_session_hash, epoch, grant_id, agent_id, session_id, updated_at, revoked_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(human_session_hash) DO UPDATE SET
             epoch = excluded.epoch, grant_id = excluded.grant_id,
             agent_id = excluded.agent_id, session_id = excluded.session_id,
             updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`,
        ).run(
          durableGrant.humanSessionHash,
          durableGrant.authorityEpoch,
          durableGrant.tokenHash,
          durableGrant.agentId,
          durableGrant.sessionId,
          durableGrant.lastUsedAt,
          durableGrant.revokedAt,
        );
      }
    });
    const grant = db
      .prepare(
        `SELECT wg.token_hash, wg.human_session_hash, wg.agent_id, wg.created_at,
                wg.expires_at, wg.last_used_at, wg.revoked_at, wg.session_id, wg.authority_epoch
         FROM webmcp_grants wg
         ${pageAuthorityJoin}
         WHERE wg.token_hash = ? AND wg.human_session_hash = ?
           AND wg.revoked_at IS NULL AND wg.expires_at > ?`,
      )
      .get(durableGrant.tokenHash, human.sessionHash, database.now()) as WebMcpGrantRow | undefined;
    if (!grant) return null;
    const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(grant.agent_id) as AgentRow | undefined;
    return agent && agent.owner_account_id === human.accountId ? { grant, agent } : null;
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

  // Mention-scoped activity is a deliberately narrow observation surface. It
  // cannot be used to enumerate meshes or read arbitrary conversations, but
  // it still needs a server-side event cursor so agents configured for
  // mentions do not silently receive an empty tool catalog.
  const requireEventBrowsePolicy = (agent: AgentRow): "public" | "joined" | "mentions" => {
    const browse = attentionFor(agent).browse;
    if (browse !== "public" && browse !== "joined" && browse !== "mentions") {
      throw new ApiError(403, "attention_policy_denied", "This agent's browse policy is invalid.");
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

  const meshSummaryFromDirectory = (entry: RepositoryMeshDirectoryEntry) => {
    const { mesh } = entry;
    const visibleRoles = entry.roles.map((role) => {
      if (entry.role === "owner" || entry.role === "steward") return role;
      const { email: _email, ...withoutEmail } = role;
      return withoutEmail;
    });
    return {
      id: mesh.meshId,
      ownerId: mesh.ownerAccountId ?? "system",
      name: mesh.name,
      description: mesh.description,
      visibility: mesh.visibility,
      joinPolicy: mesh.admission,
      role: entry.role,
      memberAgentIds: entry.memberAgentIds,
      agentCount: entry.memberAgentIds.length,
      topics: entry.topics.map(({ topic, activityCount, recentActivityCount, participantAgentIds, lastActivityAt }) => ({
        id: topic.topicId,
        meshId: topic.meshId,
        name: topic.name,
        title: topic.title,
        description: topic.description,
        tags: topic.tags,
        activityCount,
        recentActivityCount,
        participantAgentIds,
        lastActivityAt,
        createdAt: topic.createdAt,
      })),
      roles: visibleRoles,
      createdAt: mesh.createdAt,
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

  const webMcpTopicForAccess = async (principal: WebMcpPrincipal, topicId: string) => {
    if (repository?.findTopicById) {
      let topic: RepositoryTopicInput | null;
      try {
        topic = await repository.findTopicById(topicId);
      } catch (error) {
        throw new ApiError(
          503,
          "authorization_store_unavailable",
          error instanceof Error ? error.message : "The topic store is unavailable.",
        );
      }
      if (!topic) throw new ApiError(404, "topic_not_found", "Topic not found.");
      return {
        id: topic.topicId,
        mesh_id: topic.meshId,
        name: topic.name,
        title: topic.title,
        description: topic.description,
        tags_json: JSON.stringify(topic.tags),
      };
    }
    return webMcpTopicWithAccess(principal, topicId);
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

  const topicForAgentRoute = async (agentId: string, topicId: string) => {
    if (repository?.findTopicById) {
      let topic: RepositoryTopicInput | null;
      try {
        topic = await repository.findTopicById(topicId);
      } catch (error) {
        throw new ApiError(
          503,
          "authorization_store_unavailable",
          error instanceof Error ? error.message : "The topic store is unavailable.",
        );
      }
      if (!topic) throw new ApiError(404, "topic_not_found", "Topic not found.");
      return {
        id: topic.topicId,
        mesh_id: topic.meshId,
        name: topic.name,
        title: topic.title,
        description: topic.description,
        tags_json: JSON.stringify(topic.tags),
      };
    }
    return topicWithAccess(agentId, topicId);
  };

  /**
   * A topic post query is intentionally identity-blind so Firestore can use
   * its topic/time indexes. Re-read the topic, canonical profile, and mesh
   * admission after the query completes before returning any body. This is
   * the terminal authorization boundary for a request that may have raced a
   * visibility, membership, or attention-policy change on another replica.
   */
  const revalidateTopicAccessAuthoritatively = async (input: {
    agent: AgentRow;
    agentId: string;
    topicId: string;
    expectedMeshId: string;
  }): Promise<AgentRow> => {
    if (repository?.findTopicById) {
      let topic: RepositoryTopicInput | null;
      try {
        topic = await repository.findTopicById(input.topicId);
      } catch (error) {
        throw new ApiError(
          503,
          "authorization_store_unavailable",
          error instanceof Error ? error.message : "The topic store is unavailable.",
        );
      }
      if (!topic || topic.meshId !== input.expectedMeshId) {
        throw new ApiError(404, "topic_not_found", "Topic not found.");
      }
    }
    const currentAgent = repository?.findAgentById
      ? await hydrateDurableAgent(input.agentId)
      : input.agent;
    if (!currentAgent) {
      throw new ApiError(401, "agent_authentication_failed", "Agent identity is no longer available.");
    }
    await ensureAttentionMeshAccessAuthoritatively(
      currentAgent,
      input.agentId,
      input.expectedMeshId,
    );
    return currentAgent;
  };

  /**
   * A body-bearing topic read must revalidate the authority that authorized
   * the request after the Firestore query completes. Mesh visibility alone is
   * insufficient: a native session or page grant may have been superseded
   * while the post query was in flight.
   */
  const revalidatePostReadAuthority = async (principal: AgentPrincipal): Promise<void> => {
    const now = database.now();
    const offlineAfter = addSeconds(database.clock.now(), -runtimeOfflineSeconds);
    const humanIdleAfter = addSeconds(database.clock.now(), -HUMAN_IDLE_SECONDS);
    if (isWebMcpPrincipal(principal)) {
      if (repository?.findWebMcpGrant) {
        let grant: RepositoryWebMcpGrant | null;
        let humanSession: Awaited<ReturnType<MeshrRepository["findHumanSession"]>>;
        try {
          [grant, humanSession] = await Promise.all([
            repository.findWebMcpGrant(principal.sessionHash, principal.human.sessionHash),
            repository.findHumanSession(principal.human.sessionHash),
          ]);
        } catch (error) {
          throw new ApiError(
            503,
            "authorization_store_unavailable",
            error instanceof Error ? error.message : "The authorization store is unavailable.",
          );
        }
        if (
          !grant ||
          grant.agentId !== principal.agentId ||
          grant.sessionId !== principal.sessionId ||
          grant.authorityEpoch !== principal.authorityEpoch ||
          Date.parse(grant.expiresAt) <= Date.parse(now) ||
          !humanSession ||
          humanSession.accountId !== principal.ownerId ||
          Date.parse(humanSession.expiresAt) <= Date.parse(now) ||
          Date.parse(humanSession.absoluteExpiresAt) <= Date.parse(now) ||
          Date.parse(humanSession.lastSeenAt) < Date.parse(humanIdleAfter)
        ) {
          throw new ApiError(
            401,
            "webmcp_grant_required",
            "The WebMCP grant or human session was revoked while reading this topic.",
          );
        }
      } else {
        assertCurrentWebMcpGrant(principal);
      }
      return;
    }
    if (repository?.findRuntimeSessionById) {
      if (!principal.sessionId) {
        throw new ApiError(401, "agent_authentication_failed", "The runtime session is unavailable.");
      }
      let session: Awaited<ReturnType<NonNullable<MeshrRepository["findRuntimeSessionById"]>>>;
      try {
        session = await repository.findRuntimeSessionById(principal.sessionId);
      } catch (error) {
        throw new ApiError(
          503,
          "authorization_store_unavailable",
          error instanceof Error ? error.message : "The authorization store is unavailable.",
        );
      }
      if (
        !session ||
        session.agentId !== principal.agentId ||
        session.sessionId !== principal.sessionId ||
        session.bindingId !== principal.bindingId ||
        session.authorityEpoch !== principal.authorityEpoch ||
        session.status !== "active" ||
        Date.parse(session.expiresAt) <= Date.parse(now) ||
        Date.parse(session.lastSeenAt) < Date.parse(offlineAfter)
      ) {
        throw new ApiError(
          401,
          "agent_authentication_failed",
          "The runtime session was superseded or revoked while reading this topic.",
        );
      }
    } else {
      assertCurrentAgentSession(principal);
    }
  };

  const formatAuthoritativeTopicPosts = (
    page: import("./repository.ts").RepositoryTopicPostsPage,
  ) => {
    const agents = new Map(page.agents.map((agent) => [agent.agentId, agent]));
    return page.posts.map((post) => {
      const agent = agents.get(post.agentId);
      return {
        id: post.postId,
        meshId: post.meshId,
        topicId: post.topicId,
        agentId: post.agentId,
        sessionId: post.sessionId,
        parentPostId: post.parentPostId,
        body: post.body,
        createdAt: post.createdAt,
        agent: agent
          ? { id: agent.agentId, name: agent.name, handle: agent.handle }
          : { id: post.agentId, name: "", handle: "" },
      };
    });
  };

  const emitEvent = (
    type: string,
    agentId: string | null,
    meshId: string | null,
    topicId: string | null,
    data: unknown,
    context: {
      sessionId?: string | null;
      runtimeKind?: RuntimeKind | null;
      eventId?: string;
      occurredAt?: string;
      /** The durable repository already committed this event atomically. */
      durable?: boolean;
    } = {},
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
    const rawRuntimeKind = context.runtimeKind ?? activeSession?.runtime_kind ?? null;
    // Legacy/provider fixtures may still carry the internal `ollama` marker;
    // never emit that value on the public event contract. Ollama is a model
    // provider used through an MCP-capable host, not a Meshr runtime.
    const runtimeKind = rawRuntimeKind == null ? null : publicRuntimeKind(rawRuntimeKind);
    const eventId = context.eventId ?? database.id("evt");
    const createdAt = context.occurredAt ?? database.now();
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
    if (repository?.appendEvent && !context.durable) {
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
    auditId?: string;
    createdAt?: string;
    /** The durable repository already committed this audit record atomically. */
    durable?: boolean;
  }): void => {
    const auditId = input.auditId ?? database.id("audit");
    const createdAt = input.createdAt ?? database.now();
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
    if (repository?.appendAuditEvent && !input.durable) {
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

  const listModerationCasesForRoute = async (input: {
    meshId: string;
    state?: RepositoryModerationCase["state"];
    after?: { updatedAt: string; caseId: string };
    limit: number;
  }): Promise<RepositoryModerationCasesPage> => {
    if (repository?.listModerationCasesPage) {
      try {
        return await repository.listModerationCasesPage(input);
      } catch (error) {
        throw new ApiError(
          503,
          "moderation_store_unavailable",
          error instanceof Error ? error.message : "The moderation store is unavailable.",
        );
      }
    }
    if (repository?.listModerationCases) {
      try {
        const cases = await repository.listModerationCases(input.meshId);
        const filtered = input.state
          ? cases.filter((moderationCase) => moderationCase.state === input.state)
          : cases;
        // Older repository implementations returned an unordered bounded
        // list. Normalize before applying the cursor so the compatibility
        // path has the same newest-first semantics as Firestore/SQLite.
        filtered.sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) || right.caseId.localeCompare(left.caseId));
        const start = input.after
          ? filtered.findIndex((moderationCase) =>
              moderationCase.updatedAt < input.after!.updatedAt ||
              (moderationCase.updatedAt === input.after!.updatedAt && moderationCase.caseId < input.after!.caseId))
          : 0;
        const offset = start < 0 ? filtered.length : start;
        const page = filtered.slice(offset, offset + input.limit);
        const last = page.at(-1);
        return {
          cases: page,
          nextAfter: filtered.length > offset + input.limit && last
            ? { updatedAt: last.updatedAt, caseId: last.caseId }
            : null,
        };
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
       FROM moderation_cases
       WHERE mesh_id = ? ${input.state ? "AND state = ?" : ""}
         ${input.after ? "AND (updated_at < ? OR (updated_at = ? AND id < ?))" : ""}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(
      input.meshId,
      ...(input.state ? [input.state] : []),
      ...(input.after ? [input.after.updatedAt, input.after.updatedAt, input.after.caseId] : []),
      input.limit + 1,
    ) as ModerationCaseRow[];
    const pageRows = rows.slice(0, input.limit);
    const last = pageRows.at(-1);
    return {
      cases: pageRows.map(moderationCaseFromRow),
      nextAfter: rows.length > input.limit && last
        ? { updatedAt: last.updated_at, caseId: last.id }
        : null,
    };
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

  const meshInvitationRepresentation = (invitation: RepositoryMeshInvitation) => ({
    id: invitation.invitationId,
    meshId: invitation.meshId,
    invitedAgentId: invitation.invitedAgentId,
    createdByAccountId: invitation.createdByAccountId,
    status: invitation.status,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    redeemedAt: invitation.redeemedAt,
    redeemedAgentId: invitation.redeemedAgentId,
  });

  const meshRoleInvitationRepresentation = (invitation: RepositoryMeshRoleInvitation) => ({
    id: invitation.invitationId,
    meshId: invitation.meshId,
    role: invitation.role,
    createdByAccountId: invitation.createdByAccountId,
    status: invitation.status,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    redeemedAt: invitation.redeemedAt,
    redeemedByAccountId: invitation.redeemedByAccountId,
  });

  const listMeshInvitationsForRoute = async (meshId: string): Promise<RepositoryMeshInvitation[]> => {
    if (repository?.listMeshInvitations) {
      try {
        return await repository.listMeshInvitations(meshId);
      } catch (error) {
        throw new ApiError(
          503,
          "governance_store_unavailable",
          error instanceof Error ? error.message : "The invitation store is unavailable.",
        );
      }
    }
    const now = Date.parse(database.now());
    return (db.prepare(
      `SELECT id, mesh_id, invited_agent_id, created_by_account_id, status,
              created_at, expires_at, redeemed_at, redeemed_agent_id
       FROM mesh_invitations WHERE mesh_id = ? ORDER BY created_at DESC, id ASC`,
    ).all(meshId) as Array<Record<string, string | null>>).map((row) => {
      const status = String(row.status) as RepositoryMeshInvitation["status"];
      return {
        invitationId: String(row.id),
        meshId: String(row.mesh_id),
        invitedAgentId: row.invited_agent_id == null ? null : String(row.invited_agent_id),
        createdByAccountId: String(row.created_by_account_id),
        status: status === "active" && Date.parse(String(row.expires_at)) <= now ? "expired" : status,
        createdAt: String(row.created_at),
        expiresAt: String(row.expires_at),
        redeemedAt: row.redeemed_at == null ? null : String(row.redeemed_at),
        redeemedAgentId: row.redeemed_agent_id == null ? null : String(row.redeemed_agent_id),
      } satisfies RepositoryMeshInvitation;
    });
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
    actingAccountId: string;
    humanSessionHash: string;
    event?: RepositoryEventInput;
    audit?: RepositoryAuditInput;
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

  const joinMeshForAgentAuthoritatively = async (input: {
    meshId: string;
    agentId: string;
    ownerAccountId: string;
    sessionId: string;
    authorityEpoch: number;
    runtimeKind: RuntimeKind;
    idempotencyKey: string;
    requestId: string;
    requestedAt: string;
    attentionPolicy: Record<string, unknown>;
    invitationTokenHash?: string;
  }): Promise<{ status: "joined" | "pending"; requestId?: string; duplicate: boolean } | null> => {
    if (!repository?.joinMeshForAgent) return null;
    try {
      return await repository.joinMeshForAgent(input);
    } catch (error) {
      if (error instanceof Error && error.message === "invite_required") {
        throw new ApiError(403, "invite_required", "This mesh requires an invitation.");
      }
      if (error instanceof Error && error.message === "invitation_invalid") {
        throw new ApiError(403, "invitation_invalid", "That invitation is not valid for this agent or mesh.");
      }
      if (error instanceof Error && error.message === "invitation_expired") {
        throw new ApiError(410, "invitation_expired", "That invitation has expired.");
      }
      if (error instanceof Error && error.message === "invitation_redeemed") {
        throw new ApiError(410, "invitation_redeemed", "That invitation has already been used.");
      }
      if (error instanceof Error && error.message === "invitation_revoked") {
        throw new ApiError(410, "invitation_revoked", "That invitation has been revoked.");
      }
      if (error instanceof Error && error.message === "mesh_unavailable") {
        throw new ApiError(409, "mesh_unavailable", "This mesh is not accepting new activity.");
      }
      if (error instanceof Error && error.message === "idempotency_conflict") {
        throw new ApiError(409, "idempotency_conflict", "This idempotency key was already used for a different request.");
      }
      if (error instanceof Error && error.message === "idempotency_expired") {
        throw new ApiError(409, "idempotency_expired", "The idempotency record has expired; retry with a new key.");
      }
      if (error instanceof Error && error.message === "invalid_request_timestamp") {
        throw new ApiError(400, "invalid_request", "The request timestamp is invalid.");
      }
      if (error instanceof Error && error.message === "session_superseded") {
        throw new ApiError(401, "session_superseded", "This runtime session has been superseded by a newer session.");
      }
      if (error instanceof Error && error.message === "session_invalid") {
        throw new ApiError(401, "agent_authentication_failed", "This runtime session is expired or offline.");
      }
      throw new ApiError(
        503,
        "authorization_store_unavailable",
        error instanceof Error ? error.message : "The mesh authorization store is unavailable.",
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
          sessionId: post.sessionId,
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
    const priorPostCount = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM posts WHERE agent_id = ?").get(input.principal.agentId) as { count: number }).count ?? 0,
    );
    const newIdentityReview = priorPostCount < NEW_IDENTITY_REVIEW_POSTS ||
      Date.parse(agent.created_at) >= Date.parse(createdAt) - NEW_IDENTITY_REVIEW_WINDOW_MS;
    const reviewQueued = moderation.asyncReview || newIdentityReview;
    const expiresAt = addSeconds(new Date(createdAt), POST_RETENTION_SECONDS);
    const post = {
      id: postId,
      meshId: input.meshId,
      topicId: input.topicId,
      agentId: input.principal.agentId,
      sessionId: input.principal.sessionId ?? "",
      parentPostId: input.parentPostId,
      body: input.body,
      createdAt,
      moderationState: moderation.state,
      moderationReason: moderation.reason,
      expiresAt,
    };
    db.prepare(
      `INSERT INTO posts(
         id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body, created_at,
         moderation_state, moderation_reason, expires_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      post.id,
      post.meshId,
      post.topicId,
      post.agentId,
      post.sessionId,
      post.parentPostId,
      post.body,
      post.createdAt,
      post.moderationState,
      post.moderationReason,
      post.expiresAt,
    );
    if (reviewQueued) {
      db.prepare(
        `INSERT INTO moderation_cases(
           id, post_id, mesh_id, reason, state, severity, created_at, updated_at
         ) VALUES(?, ?, ?, ?, 'queued', ?, ?, ?)`,
      ).run(
        database.id("case"),
        post.id,
        post.meshId,
        newIdentityReview ? "new_identity" : moderation.reason ?? "sampled_review",
        moderation.severity,
        createdAt,
        createdAt,
      );
    }
    emitEvent(input.eventType, input.principal.agentId, post.meshId, post.topicId, {
      post,
      reviewQueued,
      mentionedHandles: extractMentionedHandles(input.body),
    }, {
      sessionId: input.principal.sessionId,
      runtimeKind: input.principal.runtime,
    });
    return {
      post,
      moderation: { state: moderation.state, reviewQueued },
    };
  };

  const projectAuthoritativePost = (raw: Record<string, unknown>): {
    id: string;
    meshId: string;
    topicId: string;
    agentId: string;
    sessionId: string;
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
    sessionId: String(raw.session_id ?? ""),
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
    // Firestore owns the quota transaction in production. Do not consume a
    // process-local token bucket before the idempotency record is checked: an
    // exact retry must replay its original response even when it lands on a
    // different API replica or arrives in a retry storm.
    const agent = currentAgentForCommit(input.principal.agentId);
    const postId = database.id("post");
    const createdAt = database.now();
    const moderation = moderatePost(input.body, postId);
    const priorPostCount = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM posts WHERE agent_id = ?").get(input.principal.agentId) as { count: number }).count ?? 0,
    );
    const newIdentityReview = priorPostCount < NEW_IDENTITY_REVIEW_POSTS ||
      Date.parse(agent.created_at) >= Date.parse(createdAt) - NEW_IDENTITY_REVIEW_WINDOW_MS;
    const reviewQueued = moderation.asyncReview || newIdentityReview;
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
      reviewQueued,
      mentionedHandles: extractMentionedHandles(input.body),
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
           id, mesh_id, topic_id, agent_id, session_id, parent_post_id, body, created_at,
           moderation_state, moderation_reason, expires_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        post.id,
        post.meshId,
        post.topicId,
        post.agentId,
        post.sessionId,
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
        reviewQueued: committed.reviewQueued ?? reviewQueued,
      },
      duplicate: committed.duplicate,
    };
  };

  const updateAgentProfile = (
    agentId: string,
    input: Record<string, unknown>,
    authority: "agent-sync" | "owner-approval",
    review?: {
      appliedFields: string[];
      pendingFields: string[];
      requested: Record<string, unknown>;
      sourceDigest: string | null;
    },
    options: { persist?: boolean } = {},
  ): AgentRow => {
    const persist = options.persist ?? true;
    if (input.profile !== undefined) {
      for (const key of Object.keys(input)) {
        if (key !== "profile" && key !== "definitionDigest" && key !== "reload") {
          throw new ApiError(400, "invalid_profile", `${key} is not allowed.`);
        }
      }
    }
    const { definitionDigest: _definitionDigest, reload: _reload, ...inlineProfile } = input;
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
    if (review && definitionDigest === undefined) {
      throw new ApiError(
        400,
        "invalid_definition_digest",
        "A profile reload must include the SHA-256 digest of its local definition.",
      );
    }
    const current = agentFromRow(currentRow);
    const merged = completeProfile({
      name: profile.name ?? current.name,
      handle: profile.handle ?? current.handle,
      tagline: profile.tagline ?? current.tagline,
      interests: profile.interests ?? current.interests,
      personality: profile.personality ?? current.personality,
      attention: { ...current.attention, ...(profile.attention ?? {}) },
    });

    const requestedRestricted: Record<string, unknown> = {};
    if (authority === "agent-sync") {
      const approvalRequired: string[] = [];
      if (merged.name !== current.name) {
        approvalRequired.push("name");
        requestedRestricted.name = merged.name;
      }
      if (merged.handle !== current.handle) {
        approvalRequired.push("handle");
        requestedRestricted.handle = merged.handle;
      }
      if (
        browseRestriction[merged.attention.browse] <
        browseRestriction[current.attention.browse]
      ) {
        approvalRequired.push("attention.browse");
        requestedRestricted.attention = {
          ...(requestedRestricted.attention as Record<string, unknown> | undefined),
          browse: merged.attention.browse,
        };
      }
      for (const field of ["rootPosts", "replies"] as const) {
        if (
          participationRestriction[merged.attention[field]] <
          participationRestriction[current.attention[field]]
        ) {
          approvalRequired.push(`attention.${field}`);
          requestedRestricted.attention = {
            ...(requestedRestricted.attention as Record<string, unknown> | undefined),
            [field]: merged.attention[field],
          };
        }
      }
      if (approvalRequired.length > 0) {
        if (!review) {
          throw new ApiError(
            403,
            "profile_approval_required",
            `Owner approval is required to change ${approvalRequired.join(", ")}.`,
          );
        }
        review.pendingFields.push(...approvalRequired);
        Object.assign(review.requested, requestedRestricted);
        // A reload is intentionally partial: safe presentation edits apply
        // now, while identity and policy relaxation remain proposals for the
        // owner. Never persist the restricted values in the agent record.
        if (approvalRequired.includes("name")) merged.name = current.name;
        if (approvalRequired.includes("handle")) merged.handle = current.handle;
        const pendingAttention = new Set(approvalRequired);
        if (pendingAttention.has("attention.browse")) merged.attention.browse = current.attention.browse;
        if (pendingAttention.has("attention.rootPosts")) merged.attention.rootPosts = current.attention.rootPosts;
        if (pendingAttention.has("attention.replies")) merged.attention.replies = current.attention.replies;
      }
    }

    if (review) {
      const candidateFields: Array<[string, unknown, unknown]> = [
        ["name", current.name, merged.name],
        ["handle", current.handle, merged.handle],
        ["tagline", current.tagline, merged.tagline],
        ["interests", current.interests, merged.interests],
        ["personality", current.personality, merged.personality],
        ["attention.browse", current.attention.browse, merged.attention.browse],
        ["attention.rootPosts", current.attention.rootPosts, merged.attention.rootPosts],
        ["attention.replies", current.attention.replies, merged.attention.replies],
        ["attention.notes", current.attention.notes, merged.attention.notes],
      ];
      review.appliedFields.push(
        ...candidateFields
          .filter(([, before, after]) => JSON.stringify(before) !== JSON.stringify(after))
          .map(([field]) => field),
      );
      // A reload is a statement about the exact local source. Never reuse an
      // older digest: doing so would make owner-review provenance point at a
      // different definition than the one the runtime just submitted.
      review.sourceDigest = definitionDigest!;
    }

    const now = database.now();
    const candidate: AgentRow = {
      ...currentRow,
      name: merged.name,
      handle: merged.handle,
      tagline: merged.tagline,
      interests_json: JSON.stringify(merged.interests),
      personality: merged.personality,
      attention_json: JSON.stringify(merged.attention),
      definition_digest: definitionDigest ?? currentRow.definition_digest,
      updated_at: now,
    };
    if (!persist) {
      // Repository-backed routes use this pure candidate to validate and
      // commit the authoritative Firestore transaction before touching the
      // local SQLite projection. A failed durable write must leave this
      // replica exactly as it was.
      if (candidate.handle.trim().toLowerCase() !== currentRow.handle.trim().toLowerCase()) {
        const handleOwner = db
          .prepare("SELECT id FROM agents WHERE handle = ? COLLATE NOCASE AND id <> ?")
          .get(candidate.handle, agentId) as { id: string } | undefined;
        if (handleOwner) {
          throw new ApiError(409, "handle_unavailable", "That agent handle is already in use.");
        }
      }
      return candidate;
    }
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
      if (error instanceof Error) {
        const quota = /^rate_limited:(agent|account|global):(\d+)$/.exec(error.message);
        if (quota) {
          const scope = quota[1]!;
          const retryAfter = Math.max(1, Number(quota[2]));
          throw new ApiError(
            429,
            `${scope}_rate_limited`,
            "Meshr is processing the maximum write rate. Retry after the indicated delay.",
            retryAfter,
          );
        }
        // Keep accepting the legacy repository error while older workers roll
        // through a deployment. New writes always use the typed scope above.
        if (error.message === "rate_limited") {
          throw new ApiError(
            429,
            "global_rate_limited",
            "Meshr is processing the maximum write rate. Retry after the indicated delay.",
            1,
          );
        }
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
    assertDatabaseCutoverRouteAllowed(method, path);

    if (method === "GET" && path === "/healthz") {
      const migration = db
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number | null };
      const releaseSha = process.env.MESHR_RELEASE_SHA?.trim();
      return {
        // Report the schema actually serving this process.  Readiness still
        // enforces the current migration, while health remains useful during
        // a rolling upgrade where an older projection pod may be draining.
        body: {
          status: "ok",
          database: "ok",
          schemaVersion: migration.version ?? 0,
          sessionPolicy: strictRuntimeSessions ? "strict" : "compat",
          runtimeSessionSeconds: runtimeAgentSessionSeconds,
          runtimeOfflineSeconds,
          ...(releaseSha ? { releaseSha } : {}),
        },
      };
    }

    if (method === "GET" && path === "/readyz") {
      try {
        if (repository?.checkReady) await repository.checkReady();
        else {
          const current = db
            .prepare("SELECT 1 AS ready FROM schema_migrations WHERE version = ?")
            .get(CURRENT_SCHEMA_VERSION) as { ready: number } | undefined;
          if (!current) throw new Error("SQLite schema is not initialized");
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

    if (method === "GET" && path === "/v1/account/providers") {
      const principal = await requireHuman(request);
      let identities: Array<{ provider: SocialProvider; email: string; linkedAt: string }>;
      if (repository?.listProviderIdentities) {
        try {
          identities = await repository.listProviderIdentities(principal.accountId);
        } catch (error) {
          throw new ApiError(
            503,
            "identity_store_unavailable",
            error instanceof Error ? error.message : "The identity store is unavailable.",
          );
        }
      } else {
        identities = (db.prepare(
          `SELECT provider, email, created_at AS linked_at
           FROM provider_identities WHERE account_id = ? ORDER BY provider ASC`,
        ).all(principal.accountId) as Array<{
          provider: SocialProvider;
          email: string;
          linked_at: string;
        }>).map((identity) => ({
          provider: identity.provider,
          email: identity.email,
          linkedAt: identity.linked_at,
        }));
      }
      return { body: { providers: identities } };
    }

    if (method === "POST" && path === "/v1/account/providers/link") {
      const principal = await requireHuman(request);
      requireCsrf(request, principal);
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (key !== "provider" && key !== "idToken" && key !== "currentProvider" && key !== "currentIdToken") {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const provider = parseSocialProvider(input.provider);
      const idToken = requiredString(input, "idToken", { max: 16_384 });
      const currentProvider = input.currentProvider === undefined
        ? undefined
        : parseSocialProvider(input.currentProvider);
      const currentIdToken = input.currentIdToken === undefined
        ? undefined
        : requiredString(input, "currentIdToken", { max: 16_384 });
      if ((currentProvider === undefined) !== (currentIdToken === undefined)) {
        throw new ApiError(
          400,
          "identity_reauthentication_required",
          "Authenticate with the existing provider before linking a new one.",
        );
      }
      if (currentProvider === provider) {
        throw new ApiError(
          400,
          "identity_provider_already_selected",
          "Choose a different provider to link to this account.",
        );
      }
      if (!identityVerifier) {
        throw new ApiError(503, "social_auth_unconfigured", "Social login is not configured.");
      }
      let reauthSubject: string | undefined;
      if (currentProvider && currentIdToken) {
        let currentClaims;
        try {
          currentClaims = await identityVerifier(currentProvider, currentIdToken);
        } catch {
          throw new ApiError(401, "invalid_identity_token", "The existing social identity token is invalid.");
        }
        if (currentClaims.provider !== currentProvider || currentClaims.emailVerified !== true) {
          throw new ApiError(401, "invalid_identity_token", "The existing social identity token is invalid.");
        }
        const authTime = currentClaims.authTime;
        const nowSeconds = Math.floor(database.clock.now().getTime() / 1_000);
        if (
          socialAuthOnly &&
          (typeof authTime !== "number" || !Number.isFinite(authTime) ||
            authTime > nowSeconds + 60 || nowSeconds - authTime > IDENTITY_REAUTH_SECONDS)
        ) {
          throw new ApiError(
            401,
            "identity_reauthentication_required",
            "Authenticate again with the existing provider before linking a new one.",
          );
        }
        let currentIdentity: RepositoryAccount | null = null;
        try {
          currentIdentity = repository
            ? await repository.findAccountByProvider(currentProvider, currentClaims.subject)
            : (() => {
                const row = db.prepare(
                  "SELECT account_id FROM provider_identities WHERE provider = ? AND subject = ?",
                ).get(currentProvider, currentClaims.subject) as { account_id: string } | undefined;
                return row && row.account_id === principal.accountId
                  ? { accountId: row.account_id, email: principal.email, displayName: principal.displayName, createdAt: database.now() }
                  : null;
              })();
        } catch (error) {
          throw new ApiError(
            503,
            "identity_store_unavailable",
            error instanceof Error ? error.message : "The identity store is unavailable.",
          );
        }
        if (!currentIdentity || currentIdentity.accountId !== principal.accountId) {
          throw new ApiError(
            403,
            "identity_reauthentication_required",
            "Authenticate with an identity already linked to this account.",
          );
        }
        reauthSubject = currentClaims.subject;
      } else if (socialAuthOnly) {
        throw new ApiError(
          401,
          "identity_reauthentication_required",
          "Authenticate with the existing provider before linking a new one.",
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
      if (
        socialAuthOnly &&
        (typeof claims.authTime !== "number" ||
          !Number.isFinite(claims.authTime) ||
          claims.authTime > Math.floor(database.clock.now().getTime() / 1_000) + 60 ||
          Math.floor(database.clock.now().getTime() / 1_000) - claims.authTime > IDENTITY_REAUTH_SECONDS)
      ) {
        throw new ApiError(
          401,
          "identity_reauthentication_required",
          "Authenticate with the target provider again before linking it.",
        );
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
            humanSessionHash: principal.sessionHash,
            reauthProvider: currentProvider,
            reauthSubject,
            linkedAt: now,
          });
        } catch (error) {
          if (error instanceof Error && error.message === "identity_already_linked") {
            throw new ApiError(409, "identity_already_linked", "That social identity belongs to another account.");
          }
          if (error instanceof Error && error.message === "account_not_found") {
            throw new ApiError(401, "authentication_required", "Sign in is required.");
          }
          if (error instanceof Error && error.message === "identity_reauthentication_required") {
            throw new ApiError(
              401,
              "identity_reauthentication_required",
              "Authenticate with the existing provider before linking a new one.",
            );
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
        return { provider, email: normalizeEmail(claims.email), linkedAt: now };
      });
      return { status: 201, body: { identity: linked } };
    }

    if (method === "GET" && path === "/v1/agents") {
      const principal = await requireHuman(request, false, { touchSession: false });
      if (repository?.listAgentsForAccount && repository.listRuntimeSessionsForAgents) {
        try {
          const agents = await repository.listAgentsForAccount(principal.accountId);
          const sessions = await repository.listRuntimeSessionsForAgents(
            agents.map((agent) => agent.agentId),
            database.now(),
            addSeconds(database.clock.now(), -runtimeOfflineSeconds),
          );
          const nowMs = Date.parse(database.now());
          const presenceByAgent = new Map<string, { lastSeenAt: string; connected: boolean }>();
          for (const session of sessions) {
            const connected =
              session.status === "active" &&
              Date.parse(session.expiresAt) > nowMs &&
              Date.parse(session.lastSeenAt) >= nowMs - runtimeOfflineSeconds * 1_000;
            const previous = presenceByAgent.get(session.agentId);
            if (!previous || session.lastSeenAt > previous.lastSeenAt) {
              presenceByAgent.set(session.agentId, { lastSeenAt: session.lastSeenAt, connected });
            }
          }
          return {
            body: {
              agents: agents.map((agent) => ({
                ...agentFromRepository(agent),
                connectionStatus: presenceByAgent.get(agent.agentId)?.connected ? "connected" : "offline",
                lastSeenAt: presenceByAgent.get(agent.agentId)?.lastSeenAt ?? null,
              })),
            },
          };
        } catch (error) {
          throw new ApiError(
            503,
            "agent_store_unavailable",
            error instanceof Error ? error.message : "The agent store is unavailable.",
          );
        }
      }
      if (repository?.loadProjection) {
        try {
          await hydrateProjection({ accountId: principal.accountId }, true, {
            includePosts: false,
            includeActivity: false,
          });
        } catch (error) {
          throw new ApiError(
            503,
            "projection_unavailable",
            error instanceof Error ? error.message : "The durable projection is unavailable.",
          );
        }
      }
      const projection = repository?.loadProjection
        ? cachedProjection({ accountId: principal.accountId })
        : undefined;
      if (projection) {
        const nowMs = Date.parse(database.now());
        const presenceByAgent = new Map<string, { lastSeenAt: string; connected: boolean }>();
        for (const session of projection.runtimeSessions) {
          const lastSeenAt = session.lastSeenAt;
          const connected =
            session.status === "active" &&
            Date.parse(session.expiresAt) > nowMs &&
            Date.parse(lastSeenAt) >= nowMs - runtimeOfflineSeconds * 1_000;
          const previous = presenceByAgent.get(session.agentId);
          if (!previous || lastSeenAt > previous.lastSeenAt) {
            presenceByAgent.set(session.agentId, { lastSeenAt, connected });
          }
        }
        return {
          body: {
            agents: projection.agents
              .filter((agent) => agent.ownerAccountId === principal.accountId)
              .map((agent) => ({
                ...agentFromRepository(agent),
                connectionStatus: presenceByAgent.get(agent.agentId)?.connected
                  ? "connected"
                  : "offline",
                lastSeenAt: presenceByAgent.get(agent.agentId)?.lastSeenAt ?? null,
              })),
          },
        };
      }
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
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const agentId = decodeURIComponent(ownerProfileMatch[1]);
      const owned = db
        .prepare("SELECT 1 AS owned FROM agents WHERE id = ? AND owner_account_id = ?")
        .get(agentId, principal.accountId);
      if (!owned) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      const profileInput = asObject(await readJson(request));
      if (repository?.upsertAgent) {
        const before = db.prepare("SELECT updated_at FROM agents WHERE id = ?").get(agentId) as
          | { updated_at: string }
          | undefined;
        if (!before) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
        const candidate = updateAgentProfile(
          agentId,
          profileInput,
          "owner-approval",
          undefined,
          { persist: false },
        );
        await durableWrite("agent profile update", async () => {
          await repository.upsertAgent?.({
            ...repositoryAgent(
              candidate,
              undefined,
              undefined,
              principal.accountId,
              principal.sessionHash,
            ),
            expectedUpdatedAt: before.updated_at,
          });
        });
        // SQLite is a read projection in production. Reconcile it only after
        // Firestore accepts the owner edit so a rejected transaction cannot
        // leave this replica ahead of the authoritative profile.
        database.transaction(() => {
          db.prepare(
            `UPDATE agents SET name = ?, handle = ?, tagline = ?, interests_json = ?,
               personality = ?, attention_json = ?, definition_digest = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            candidate.name,
            candidate.handle,
            candidate.tagline,
            candidate.interests_json,
            candidate.personality,
            candidate.attention_json,
            candidate.definition_digest,
            candidate.updated_at,
            candidate.id,
          );
        });
        return { body: { agent: agentFromRow(candidate) } };
      }
      const updated = database.transaction(() =>
        updateAgentProfile(agentId, profileInput, "owner-approval"),
      );
      return { body: { agent: agentFromRow(updated) } };
    }

    const profileProposalListMatch = matchingPath(path, /^\/v1\/agents\/([^/]+)\/profile\/proposals$/);
    if (method === "GET" && profileProposalListMatch) {
      const principal = await requireHuman(request, true);
      const agentId = decodeURIComponent(profileProposalListMatch[1]);
      const owned = db
        .prepare("SELECT 1 AS owned FROM agents WHERE id = ? AND owner_account_id = ?")
        .get(agentId, principal.accountId);
      if (!owned) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      if (repository?.listProfileReviewProposals) {
        try {
          const proposals = await repository.listProfileReviewProposals({
            agentId,
            ownerAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
          });
          return { body: { proposals } };
        } catch (error) {
          if (error instanceof Error && error.message === "mesh_governance_denied") {
            throw new ApiError(401, "authentication_required", "The human session is no longer valid.");
          }
          throw new ApiError(
            503,
            "profile_store_unavailable",
            error instanceof Error ? error.message : "The profile review store is unavailable.",
          );
        }
      }
      const rows = db.prepare(
        `SELECT id, agent_id, owner_account_id, source_digest, requested_json,
                pending_fields_json, status, created_at, updated_at, resolved_at, resolution
         FROM profile_review_proposals
         WHERE agent_id = ? AND owner_account_id = ?
         ORDER BY updated_at DESC, id ASC LIMIT 100`,
      ).all(agentId, principal.accountId) as Array<Record<string, unknown>>;
      return { body: { proposals: rows.map(profileReviewProposalFromRow) } };
    }

    const profileProposalResolveMatch = matchingPath(
      path,
      /^\/v1\/agents\/([^/]+)\/profile\/proposals\/([^/]+)$/,
    );
    if (method === "POST" && profileProposalResolveMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const agentId = decodeURIComponent(profileProposalResolveMatch[1]);
      const proposalId = decodeURIComponent(profileProposalResolveMatch[2]);
      const input = asObject(await readJson(request));
      for (const field of Object.keys(input)) {
        if (field !== "decision") throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
      }
      const decision = input.decision;
      if (decision !== "approved" && decision !== "denied") {
        throw new ApiError(400, "invalid_request", "decision must be approved or denied.");
      }
      const owned = db
        .prepare("SELECT 1 AS owned FROM agents WHERE id = ? AND owner_account_id = ?")
        .get(agentId, principal.accountId);
      if (!owned) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      const resolvedAt = database.now();
      const eventId = `evt_${sha256(`profile-review:${proposalId}:${decision}`).slice(0, 40)}`;
      const auditId = `audit_${sha256(`profile-review:${proposalId}:${decision}`).slice(0, 40)}`;
      const event: RepositoryEventInput = {
        eventId,
        type: `agent.profile.review.${decision}`,
        meshId: null,
        topicId: null,
        agentId,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: { proposalId, agentId, decision },
        occurredAt: resolvedAt,
      };
      const audit: RepositoryAuditInput = {
        auditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: `agent.profile.review.${decision}`,
        resourceType: "profile_review_proposal",
        resourceId: proposalId,
        data: { agentId, decision },
        createdAt: resolvedAt,
      };
      if (repository?.resolveProfileReviewProposal) {
        let resolved: Awaited<ReturnType<NonNullable<MeshrRepository["resolveProfileReviewProposal"]>>> | undefined;
        try {
          resolved = await repository.resolveProfileReviewProposal({
            proposalId,
            agentId,
            ownerAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
            decision,
            resolvedAt,
            event,
            audit,
          });
        } catch (error) {
          if (error instanceof Error && error.message === "profile_proposal_not_found") {
            throw new ApiError(404, "profile_proposal_not_found", "Profile review proposal not found.");
          }
          if (error instanceof Error && error.message === "profile_proposal_not_pending") {
            throw new ApiError(409, "profile_proposal_not_pending", "This profile review proposal is already resolved.");
          }
          if (error instanceof Error && error.message === "handle_unavailable") {
            throw new ApiError(409, "handle_unavailable", "That agent handle is already in use.");
          }
          if (error instanceof Error && error.message === "profile_proposal_invalid") {
            throw new ApiError(409, "profile_proposal_invalid", "The proposed profile is no longer valid.");
          }
          if (error instanceof Error && error.message === "profile_proposal_stale") {
            throw new ApiError(
              409,
              "profile_proposal_stale",
              "This profile proposal is based on an older agent revision. Reload the agent definition and review the new proposal.",
            );
          }
          if (error instanceof Error && error.message === "mesh_governance_denied") {
            throw new ApiError(401, "authentication_required", "The human session is no longer valid.");
          }
          throw new ApiError(
            503,
            "profile_store_unavailable",
            error instanceof Error ? error.message : "The profile review store is unavailable.",
          );
        }
        if (!resolved) throw new ApiError(503, "profile_store_unavailable", "The profile review store is unavailable.");
        const canonical = resolved.agent;
        database.transaction(() => {
          db.prepare(
            `UPDATE agents SET name = ?, handle = ?, attention_json = ?, definition_digest = ?, updated_at = ? WHERE id = ?`,
          ).run(
            canonical.name,
            canonical.handle,
            JSON.stringify(canonical.attention),
            canonical.definitionDigest,
            canonical.updatedAt,
            canonical.agentId,
          );
          db.prepare(
            `UPDATE profile_review_proposals SET status = ?, resolution = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
          ).run(
            decision,
            decision,
            resolved.proposal.resolvedAt ?? resolved.proposal.updatedAt,
            resolved.proposal.updatedAt,
            proposalId,
          );
        });
        return { body: { proposal: resolved.proposal, agent: agentFromRepository(canonical) } };
      }
      const resolved = database.transaction(() => {
        const row = db.prepare(
          `SELECT id, agent_id, owner_account_id, source_digest, requested_json,
                  pending_fields_json, status, created_at, updated_at, resolved_at, resolution
           FROM profile_review_proposals WHERE id = ?`,
        ).get(proposalId) as Record<string, unknown> | undefined;
        if (!row || String(row.agent_id) !== agentId || String(row.owner_account_id ?? "") !== principal.accountId) {
          throw new ApiError(404, "profile_proposal_not_found", "Profile review proposal not found.");
        }
        if (row.status !== "pending") throw new ApiError(409, "profile_proposal_not_pending", "This profile review proposal is already resolved.");
        const agentRow = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as AgentRow | undefined;
        if (!agentRow) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
        if (String(row.updated_at) !== String(agentRow.updated_at)) {
          throw new ApiError(
            409,
            "profile_proposal_stale",
            "This profile proposal is based on an older agent revision. Reload the agent definition and review the new proposal.",
          );
        }
        const requested = JSON.parse(String(row.requested_json)) as Record<string, unknown>;
        let next = agentFromRow(agentRow);
        if (decision === "approved") {
          const nextName = requested.name === undefined ? next.name : String(requested.name);
          const nextHandle = requested.handle === undefined ? next.handle : String(requested.handle);
          const handleOwner = db.prepare("SELECT id FROM agents WHERE handle = ? COLLATE NOCASE AND id <> ?").get(nextHandle, agentId);
          if (handleOwner) throw new ApiError(409, "handle_unavailable", "That agent handle is already in use.");
          const attention = { ...next.attention };
          if (requested.attention && typeof requested.attention === "object" && !Array.isArray(requested.attention)) {
            for (const field of ["browse", "rootPosts", "replies"] as const) {
              const value = (requested.attention as Record<string, unknown>)[field];
              if (value !== undefined) attention[field] = value as never;
            }
          }
          db.prepare("UPDATE agents SET name = ?, handle = ?, attention_json = ?, definition_digest = ?, updated_at = ? WHERE id = ?")
            .run(nextName, nextHandle, JSON.stringify(attention), String(row.source_digest) || next.definitionDigest, resolvedAt, agentId);
          next = { ...next, name: nextName, handle: nextHandle, attention, definitionDigest: String(row.source_digest) || next.definitionDigest, updatedAt: resolvedAt };
        }
        db.prepare("UPDATE profile_review_proposals SET status = ?, resolution = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
          .run(decision, decision, resolvedAt, resolvedAt, proposalId);
        db.prepare(
          `INSERT OR IGNORE INTO outbox_events(event_id, schema_version, type, mesh_id, topic_id, agent_id, session_id, runtime_kind, payload_json, status, attempts, created_at)
           VALUES(?, 1, ?, NULL, NULL, ?, ?, NULL, ?, 'pending', 0, ?)`,
        ).run(eventId, event.type, agentId, principal.sessionHash, JSON.stringify(event.payload), resolvedAt);
        db.prepare(
          `INSERT OR IGNORE INTO audit_events(id, actor_type, actor_id, session_id, action, resource_type, resource_id, data_json, created_at)
           VALUES(?, 'human', ?, ?, ?, 'profile_review_proposal', ?, ?, ?)`,
        ).run(auditId, principal.accountId, principal.sessionHash, audit.action, proposalId, JSON.stringify(audit.data), resolvedAt);
        return {
          proposal: {
            ...profileReviewProposalFromRow(row),
            status: decision,
            resolution: decision,
            resolvedAt,
            updatedAt: resolvedAt,
          },
          agent: next,
        };
      });
      return { body: { proposal: resolved.proposal, agent: agentFromRow(db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as unknown as AgentRow) } };
    }

    const bindingMatch = matchingPath(path, /^\/v1\/agents\/([^/]+)\/binding$/);
    if (method === "DELETE" && bindingMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const agentId = decodeURIComponent(bindingMatch[1]);
      const owned = db
        .prepare("SELECT 1 AS owned FROM agents WHERE id = ? AND owner_account_id = ?")
        .get(agentId, principal.accountId);
      if (!owned) throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      const now = database.now();
      const revokeEventId = database.id("evt");
      const revokeAuditId = database.id("audit");
      const revokeEvent: RepositoryEventInput = {
        eventId: revokeEventId,
        type: "agent.disconnected",
        meshId: null,
        topicId: null,
        agentId,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: { agentId, reason: "owner_revoked" },
        occurredAt: now,
      };
      const revokeAudit: RepositoryAuditInput = {
        auditId: revokeAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "agent.binding.revoked",
        resourceType: "agent",
        resourceId: agentId,
        data: { agentId, reason: "owner_revoked" },
        createdAt: now,
      };
      await durableWrite("agent binding revoke", async () => {
        await repository?.revokeAgent?.(
          agentId,
          now,
          revokeEvent,
          revokeAudit,
          principal.accountId,
          principal.sessionHash,
        );
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
          emitEvent("agent.disconnected", agentId, null, null, { agentId, reason: "owner_revoked" }, {
            eventId: revokeEventId,
            occurredAt: now,
            durable: Boolean(repository?.revokeAgent),
          });
          emitAudit({
            auditId: revokeAuditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "agent.binding.revoked",
            resourceType: "agent",
            resourceId: agentId,
            data: { agentId, reason: "owner_revoked" },
            durable: Boolean(repository?.revokeAgent),
          });
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
      const human = await requireHuman(request, false, { touchSession: false });
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
      const human = await requireHuman(request, true);
      requireCsrf(request, human);
      const input = asObject(await readJson(request));
      for (const field of Object.keys(input)) {
        if (field !== "agentId") {
          throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
        }
      }
      const agentId = requiredString(input, "agentId", { max: 128 });
      // WebMCP activation can land on any API replica after the browser's
      // previous request. In production the local SQLite database is only a
      // disposable projection, so an agent approved or connected on another
      // replica may not exist here yet. Hydrate the canonical Firestore
      // profile before checking ownership instead of turning a valid agent
      // into a replica-local 404.
      const agent = repository?.findAgentById
        ? await hydrateDurableAgent(agentId)
        : (db
            .prepare("SELECT * FROM agents WHERE id = ? AND owner_account_id = ?")
            .get(agentId, human.accountId) as AgentRow | undefined);
      if (agent && agent.owner_account_id !== human.accountId) {
        throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      }
      if (!agent) {
        throw new ApiError(404, "agent_not_found", "Owned agent not found.");
      }
      const pageMaterial = webMcpMaterial(human.sessionHash, agent.id);
      // The durable handoff can commit before the browser receives its
      // response (or before the Set-Cookie reaches storage). Reissue the same
      // deterministic grant on retry before checking native connectivity;
      // the native session was intentionally superseded by that handoff.
      if (repository?.findWebMcpGrant && webMcpTransfersSession) {
        try {
          const durableGrant = await repository.findWebMcpGrant(
            pageMaterial.tokenHash,
            human.sessionHash,
          );
          if (durableGrant) {
            const recovered = await reconcileDurableWebMcpGrant(durableGrant, human);
            if (recovered) {
              return {
                status: 200,
                headers: { "Set-Cookie": webMcpCookie(pageMaterial.token, secureCookies) },
                body: {
                  enabled: true,
                  agent: agentFromRow(recovered.agent),
                  createdAt: recovered.grant.created_at,
                  expiresAt: recovered.grant.expires_at,
                },
              };
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
      // A committed handoff may have lost its HTTP response. Reissuing that
      // deterministic grant is recovery, not a new session start, and must
      // remain available while cost protection is active. New transfers are
      // blocked below after the recovery path has been exhausted.
      assertCostProtectionAllows("session");
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
      const token = pageMaterial.token;
      const tokenHash = pageMaterial.tokenHash;
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, WEBMCP_GRANT_SECONDS);
      let transferSessionId = database.id("page");
      let authoritativeEpoch: number | undefined;
      const transferMeshIds = new Set<string>(
        (db
          .prepare("SELECT mesh_id FROM mesh_members WHERE agent_id = ?")
          .all(agent.id) as Array<{ mesh_id: string }>).map((row) => row.mesh_id),
      );
      if (repository?.listJoinedMeshIdsForAgent) {
        try {
          transferMeshIds.clear();
          for (const meshId of await repository.listJoinedMeshIdsForAgent(agent.id)) {
            transferMeshIds.add(meshId);
          }
        } catch (error) {
          throw new ApiError(
            503,
            "mesh_store_unavailable",
            error instanceof Error ? error.message : "The mesh store is unavailable.",
          );
        }
      } else if (repository?.listMeshesForAgent) {
        try {
          const durableMeshes = await repository.listMeshesForAgent(agent.id);
          transferMeshIds.clear();
          for (const entry of durableMeshes) {
            if (entry.joined) transferMeshIds.add(entry.mesh.meshId);
          }
        } catch (error) {
          throw new ApiError(
            503,
            "mesh_store_unavailable",
            error instanceof Error ? error.message : "The mesh store is unavailable.",
          );
        }
      }
      const transferEventId = database.id("evt");
      const transferAuditId = database.id("audit");
      const transferEvent: RepositoryEventInput = {
        eventId: transferEventId,
        type: "agent.session.transferred",
        meshId: null,
        topicId: null,
        agentId: agent.id,
        sessionId: transferSessionId,
        runtimeKind: agent.runtime,
        payload: {
          agentId: agent.id,
          transferSessionId,
          authority: "page_webmcp",
          // The transfer is system-scoped, but topology still needs a bounded
          // per-mesh projection so observers can see the authority change.
          meshIds: [...transferMeshIds].slice(0, MAX_JOINED_MESHES_PER_AGENT),
        },
        occurredAt: now,
      };
      const transferAudit: RepositoryAuditInput = {
        auditId: transferAuditId,
        actorType: "human",
        actorId: human.accountId,
        sessionId: human.sessionHash,
        action: "webmcp.session.transferred",
        resourceType: "agent",
        resourceId: agent.id,
        data: { transferSessionId, authority: "page_webmcp" },
        createdAt: now,
      };
      if (repository && webMcpTransfersSession) {
        try {
          const committed = await repository.transferPageAuthority({
            agentId: agent.id,
            grantId: tokenHash,
            humanSessionHash: human.sessionHash,
            expiresAt,
            sessionId: transferSessionId,
            event: transferEvent,
            audit: transferAudit,
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
           WHERE human_session_hash = ?
             AND revoked_at IS NULL`,
        ).run(now, human.sessionHash);
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
              auditId: transferAuditId,
              createdAt: now,
              actorType: "human",
              actorId: human.accountId,
              sessionId: human.sessionHash,
              action: "webmcp.session.transferred",
              resourceType: "agent",
              resourceId: agent.id,
              data: { transferSessionId, authorityEpoch },
              durable: Boolean(repository && webMcpTransfersSession),
            });
            emitEvent("agent.session.transferred", agent.id, null, null, {
              agentId: agent.id,
              transferSessionId,
              authority: "page_webmcp",
            }, {
              sessionId: transferSessionId,
              runtimeKind: agent.runtime,
              eventId: transferEventId,
              occurredAt: now,
              durable: Boolean(repository && webMcpTransfersSession),
            });
          }
          db.prepare(
            `INSERT INTO webmcp_authority(
               human_session_hash, epoch, grant_id, agent_id, session_id, updated_at, revoked_at
             ) VALUES(?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(human_session_hash) DO UPDATE SET
               epoch = excluded.epoch, grant_id = excluded.grant_id,
               agent_id = excluded.agent_id, session_id = excluded.session_id,
               updated_at = excluded.updated_at, revoked_at = NULL`,
          ).run(
            human.sessionHash,
            authorityEpoch,
            tokenHash,
            agent.id,
            transferSessionId,
            now,
          );
        }
        db.prepare(
          `INSERT INTO webmcp_grants(
             token_hash, human_session_hash, agent_id, created_at,
             expires_at, last_used_at, revoked_at, session_id, authority_epoch
           ) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(token_hash) DO UPDATE SET
             human_session_hash = excluded.human_session_hash,
             agent_id = excluded.agent_id,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at,
             last_used_at = excluded.last_used_at,
             revoked_at = NULL,
             session_id = excluded.session_id,
             authority_epoch = excluded.authority_epoch`,
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
      const human = await requireHuman(request, true);
      requireCsrf(request, human);
      const now = database.now();
      await durableWrite("WebMCP grant revoke", async () => {
        await repository?.revokeWebMcpGrants?.(human.sessionHash, now);
      });
      database.transaction(() => {
        db.prepare(
          `UPDATE webmcp_grants SET revoked_at = ?
           WHERE human_session_hash = ? AND revoked_at IS NULL`,
        ).run(now, human.sessionHash);
        if (webMcpTransfersSession) {
          const fence = db
            .prepare("SELECT epoch FROM webmcp_authority WHERE human_session_hash = ?")
            .get(human.sessionHash) as { epoch: number } | undefined;
          db.prepare(
            `INSERT INTO webmcp_authority(
               human_session_hash, epoch, grant_id, agent_id, session_id, updated_at, revoked_at
             ) VALUES(?, ?, NULL, NULL, NULL, ?, ?)
             ON CONFLICT(human_session_hash) DO UPDATE SET
               epoch = excluded.epoch, grant_id = NULL, agent_id = NULL, session_id = NULL,
               updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`,
          ).run(human.sessionHash, (fence?.epoch ?? 0) + 1, now, now);
        }
      });
      return {
        body: { enabled: false, agent: null, createdAt: null, expiresAt: null },
        headers: { "Set-Cookie": clearWebMcpCookie(secureCookies) },
      };
    }

    if (method === "GET" && path === "/v1/activity/public") {
      const includeAuthorized = url.searchParams.get("includeAuthorized") === "1";
      const sharedSnapshot = url.searchParams.get("shared") === "1";
      const requestedMeshId = url.searchParams.get("meshId") ?? undefined;
      if (requestedMeshId !== undefined &&
          !/^[A-Za-z0-9._:-]{1,128}$/.test(requestedMeshId)) {
        throw new ApiError(400, "invalid_mesh", "The requested mesh is invalid.");
      }
      // Public viewers use the bounded shared projection cache. Private or
      // unlisted activity is deliberately refreshed authoritatively because a
      // role/admission change must not leave a stale private mesh in a browser
      // response. The live gateway calls this route without includeAuthorized,
      // so a topology burst cannot turn into a full account projection read.
      // Shared gateway polling must not extend a human's idle session. Only
      // account-scoped browser reads refresh the rolling 12-hour idle window;
      // the gateway authenticates once and uses its own short-lived grant.
      const principal = await requireHuman(
        request,
        false,
        { touchSession: false },
      );
      if (repository?.loadProjection) {
        try {
          if (includeAuthorized) {
            // Topology is an aggregate-only read model. Do not hydrate
            // expiring post bodies for the browser's 15-second activity poll.
            await refreshHumanActivityProjection(principal.accountId);
          } else {
            // The live gateway opts into the short shared cache after it has
            // authenticated the browser/agent subscription. Direct browser
            // reads stay authoritative so a governance change is visible on
            // the next refresh and local fixtures do not hide convergence.
            // Mesh-scoped live frames must converge with the topology worker
            // within the two-second launch target. Keep the shared route
            // inexpensive through a short public projection cache, while
            // direct browser reads remain authoritative.
            const publicProjectionAge = Date.now() - (projectionHydratedAt.get("public") ?? 0);
            const refreshSharedMesh = Boolean(requestedMeshId) && publicProjectionAge >= 1_000;
            await hydrateProjection({}, !sharedSnapshot || refreshSharedMesh, { includePosts: false });
          }
        } catch (error) {
          throw new ApiError(
            503,
            "projection_unavailable",
            error instanceof Error ? error.message : "The public projection is unavailable.",
          );
        }
      }
      const projection = repository?.loadProjection
        ? cachedProjection(includeAuthorized ? { accountId: principal.accountId } : {})
        : undefined;
      const authorizedMeshIds = includeAuthorized
        ? projection
          ? new Set(projection.meshes.map((mesh) => mesh.meshId))
          : new Set<string>([
              ...(db
                .prepare("SELECT id FROM meshes WHERE visibility = 'public'")
                .all() as Array<{ id: string }>).map((mesh) => mesh.id),
              ...(db
                .prepare("SELECT mesh_id AS id FROM mesh_human_roles WHERE account_id = ?")
                .all(principal.accountId) as Array<{ id: string }>).map((mesh) => mesh.id),
            ])
        : undefined;
      const generatedAt = database.now();
      const nowMs = Date.parse(generatedAt);
      const durablePresence = projection
        ? new Map(
            projection.runtimeSessions.map((session) => [session.agentId, {
              lastSeenAt: session.lastSeenAt,
              connected:
                session.status === "active" &&
                Date.parse(session.expiresAt) > nowMs &&
                Date.parse(session.lastSeenAt) >= nowMs - runtimeOfflineSeconds * 1_000,
            }]),
          )
        : undefined;
      return {
        body: readPublicActivity(
          db,
          principal.accountId,
          generatedAt,
          authorizedMeshIds,
          durablePresence,
          requestedMeshId,
          projection?.activity,
        ),
      };
    }

    if (method === "GET" && path === "/v1/activity/preferences") {
      const principal = await requireHuman(request, false, { touchSession: false });
      let preferences: RepositoryHumanActivityPreference[];
      if (repository?.listHumanActivityPreferences) {
        try {
          preferences = await repository.listHumanActivityPreferences(principal.accountId);
        } catch (error) {
          throw new ApiError(
            503,
            "preference_store_unavailable",
            error instanceof Error ? error.message : "The activity preference store is unavailable.",
          );
        }
      } else {
        const rows = db.prepare(
          `SELECT account_id, kind, resource_id, watching, muted, updated_at
           FROM human_activity_preferences
           WHERE account_id = ?
           ORDER BY updated_at DESC, kind ASC, resource_id ASC`,
        ).all(principal.accountId) as Array<{
          account_id: string;
          kind: RepositoryHumanActivityPreference["kind"];
          resource_id: string;
          watching: number;
          muted: number;
          updated_at: string;
        }>;
        preferences = rows.map((row) => ({
          accountId: row.account_id,
          kind: row.kind,
          resourceId: row.resource_id,
          watching: row.watching === 1,
          muted: row.muted === 1,
          updatedAt: row.updated_at,
        }));
      }
      return { body: { preferences } };
    }

    const activityPreferenceMatch = matchingPath(
      path,
      /^\/v1\/activity\/preferences\/(topic|link)\/([^/]+)$/,
    );
    if (method === "PUT" && activityPreferenceMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const kind = activityPreferenceMatch[1] as RepositoryHumanActivityPreference["kind"];
      const resourceId = decodeURIComponent(activityPreferenceMatch[2]);
      if (resourceId.length < 1 || resourceId.length > 256) {
        throw new ApiError(400, "invalid_preference", "The activity resource is invalid.");
      }
      const input = asObject(await readJson(request));
      const requestedWatching = input.watching as unknown;
      const requestedMuted = input.muted as unknown;
      for (const key of Object.keys(input)) {
        if (key !== "watching" && key !== "muted") {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
        if (typeof input[key] !== "boolean") {
          throw new ApiError(400, "invalid_preference", `${key} must be a boolean.`);
        }
      }
      if (requestedWatching === undefined && requestedMuted === undefined) {
        throw new ApiError(400, "invalid_preference", "Set watching or muted.");
      }

      let meshId: string;
      if (kind === "topic") {
        if (repository?.findTopicById) {
          let topic: RepositoryTopicInput | null;
          try {
            topic = await repository.findTopicById(resourceId);
          } catch (error) {
            throw new ApiError(
              503,
              "preference_store_unavailable",
              error instanceof Error ? error.message : "The activity preference store is unavailable.",
            );
          }
          if (!topic) throw new ApiError(404, "topic_not_found", "Conversation not found.");
          meshId = topic.meshId;
        } else {
          const topic = db.prepare("SELECT mesh_id FROM topics WHERE id = ?").get(resourceId) as
            | { mesh_id: string }
            | undefined;
          if (!topic) throw new ApiError(404, "topic_not_found", "Conversation not found.");
          meshId = topic.mesh_id;
        }
      } else {
        const parts = resourceId.split(":");
        if (parts.length !== 4 || parts[0] !== "traffic" || parts.slice(1).some((part) => !part)) {
          throw new ApiError(400, "invalid_preference", "The traffic link is invalid.");
        }
        meshId = parts[1]!;
      }
      let preference: RepositoryHumanActivityPreference;
      if (repository) {
        if (!repository.upsertHumanActivityPreference) {
          throw new ApiError(503, "preference_store_unavailable", "The activity preference store is unavailable.");
        }
        const patch: RepositoryHumanActivityPreferencePatch = {
          accountId: principal.accountId,
          kind,
          resourceId,
          meshId,
          ...(requestedWatching === undefined ? {} : { watching: requestedWatching as boolean }),
          ...(requestedMuted === undefined ? {} : { muted: requestedMuted as boolean }),
          updatedAt: database.now(),
          humanSessionHash: principal.sessionHash,
        };
        try {
          preference = await repository.upsertHumanActivityPreference(patch);
        } catch (error) {
          const message = error instanceof Error ? error.message : "The activity preference store is unavailable.";
          if (message === "topic_not_found") {
            throw new ApiError(404, "topic_not_found", "Conversation not found.");
          }
          if (message === "mesh_not_found") {
            throw new ApiError(404, "mesh_not_found", "Mesh not found.");
          }
          if (message === "mesh_access_denied") {
            throw new ApiError(403, "mesh_access_denied", "You do not have access to this mesh.");
          }
          if (message === "mesh_governance_denied") {
            // The durable transaction rechecks the session after the route's
            // initial authentication. A revoked/expired session therefore
            // fails closed even when the request raced another replica.
            throw new ApiError(401, "authentication_required", "Sign in is required.");
          }
          throw new ApiError(503, "preference_store_unavailable", message);
        }
      } else {
        const mesh = readMesh(meshId);
        if (mesh.visibility !== "public") {
          const role = await meshRoleForAuthoritatively(principal.accountId, meshId);
          if (!role) throw new ApiError(403, "mesh_access_denied", "You do not have access to this mesh.");
        }
        const current = db.prepare(
          `SELECT watching, muted FROM human_activity_preferences
           WHERE account_id = ? AND kind = ? AND resource_id = ?`,
        ).get(principal.accountId, kind, resourceId) as
          | { watching: number; muted: number }
          | undefined;
        preference = {
          accountId: principal.accountId,
          kind,
          resourceId,
          watching: requestedWatching === undefined ? current?.watching === 1 : requestedWatching as boolean,
          muted: requestedMuted === undefined ? current?.muted === 1 : requestedMuted as boolean,
          updatedAt: database.now(),
        };
      }
      db.prepare(
        `INSERT INTO human_activity_preferences(
           account_id, kind, resource_id, watching, muted, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, kind, resource_id) DO UPDATE SET
           watching = excluded.watching,
           muted = excluded.muted,
           updated_at = excluded.updated_at`,
      ).run(
        preference.accountId,
        preference.kind,
        preference.resourceId,
        preference.watching ? 1 : 0,
        preference.muted ? 1 : 0,
        preference.updatedAt,
      );
      return { body: { preference } };
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
        const principal = await requireAgent(request, { refreshAgent: true });
        const agent = db
          .prepare("SELECT * FROM agents WHERE id = ?")
          .get(principal.agentId) as unknown as AgentRow;
        const meshAccess = await ensureAttentionMeshAccessAuthoritatively(agent, principal.agentId, meshId);
        return {
          body: {
            allowed: true,
            principal: "agent",
            agentId: principal.agentId,
            meshId,
            meshVisibility: meshAccess.visibility,
            cursor: Number(
              (db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE mesh_id = ?")
                .get(meshId) as { sequence: number }).sequence ?? 0,
            ),
          },
        };
      }
      // This endpoint is called by the live gateway on access-epoch changes;
      // it only needs the durable session plus the mesh/role lookup below.
      // Avoid hydrating the full browser projection on the hot authorization
      // path.
      // Gateway heartbeats/reauthorizations must not keep an unattended
      // browser session alive. Only direct user activity advances idle time.
      const principal = await requireHuman(request, false, { touchSession: false });
      let mesh: { visibility: "public" | "unlisted" | "private" };
      let role: MeshRole | null;
      if (repository?.findMeshById && repository.findMeshHumanRole) {
        const [authoritativeMesh, authoritativeRole] = await Promise.all([
          repository.findMeshById(meshId),
          repository.findMeshHumanRole(meshId, principal.accountId),
        ]);
        if (!authoritativeMesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
        mesh = authoritativeMesh;
        role = authoritativeRole;
      } else {
        mesh = readMesh(meshId);
        role = await meshRoleForAuthoritatively(principal.accountId, meshId);
      }
      const allowed = mesh.visibility !== "private" || role !== null;
      if (!allowed) {
        throw new ApiError(403, "mesh_access_denied", "You do not have access to this mesh.");
      }
      return {
        body: {
          allowed: true,
          principal: "human",
          meshId,
          meshVisibility: mesh.visibility,
          cursor: Number(
            (db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE mesh_id = ?")
              .get(meshId) as { sequence: number }).sequence ?? 0,
          ),
        },
      };
    }

    if (method === "GET" && path === "/v1/meshes") {
      const principal = await requireHuman(request, false, { touchSession: false });
      if (repository?.listMeshDirectoryForAccount) {
        try {
          const directory = await repository.listMeshDirectoryForAccount(principal.accountId);
          return { body: { meshes: directory.map(meshSummaryFromDirectory) } };
        } catch (error) {
          throw new ApiError(
            503,
            "mesh_store_unavailable",
            error instanceof Error ? error.message : "The mesh directory is unavailable.",
          );
        }
      }
      if (repository?.loadProjection) {
        try {
          await hydrateProjection({ accountId: principal.accountId }, true, {
            includePosts: false,
            includeActivity: true,
          });
        } catch (error) {
          throw new ApiError(
            503,
            "projection_unavailable",
            error instanceof Error ? error.message : "The durable projection is unavailable.",
          );
        }
      }
      const authorizedMeshIds = repository?.loadProjection
        ? new Set(cachedProjection({ accountId: principal.accountId })?.meshes.map((mesh) => mesh.meshId) ?? [])
        : undefined;
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
        .filter((raw) => !authorizedMeshIds || authorizedMeshIds.has(String((raw as { id: string }).id)))
        .map((raw) => meshSummary(readMesh(String((raw as { id: string }).id)), principal.accountId));
      return { body: { meshes } };
    }

    if (method === "POST" && path === "/v1/meshes") {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      assertCostProtectionAllows("mesh");
      const idempotencyKey = requireIdempotencyKey(request);
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
      // The production API keeps only an in-memory projection. Resolve the
      // account's agents and owned-mesh count from Firestore before validating
      // the request so a fresh replica can still create a mesh with the
      // correct connected identities and quota.
      let durableOwnedAgents: RepositoryAgentInput[] | undefined;
      let durableOwnedMeshes: RepositoryMeshDirectoryEntry[] | undefined;
      if (repository?.listAgentsForAccount) {
        try {
          durableOwnedAgents = await repository.listAgentsForAccount(principal.accountId);
          if (repository.listMeshDirectoryForAccount) {
            durableOwnedMeshes = await repository.listMeshDirectoryForAccount(principal.accountId);
          }
        } catch (error) {
          throw new ApiError(
            503,
            "mesh_store_unavailable",
            error instanceof Error ? error.message : "The mesh store is unavailable.",
          );
        }
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
            const owned = durableOwnedAgents
              ? durableOwnedAgents.map((agent) => agent.agentId)
              : db
                  .prepare("SELECT id FROM agents WHERE owner_account_id = ?")
                  .all(principal.accountId)
                  .map((raw) => (raw as { id: string }).id);
            const ownedSet = new Set(owned);
            if (unique.some((agentId) => !ownedSet.has(agentId))) {
              throw new ApiError(403, "agent_access_denied", "Only your connected agents can join a new mesh.");
            }
            return unique;
          })();
      const now = database.now();
      const requestHash = sha256(JSON.stringify({ name, description, visibility, joinPolicy, agentIds }));
      const meshSeed = sha256(`mesh:create:${principal.accountId}:${idempotencyKey}`);
      const meshId = `mesh_${meshSeed.slice(0, 40)}`;
      const topicId = `topic_${sha256(`${meshSeed}:topic`).slice(0, 40)}`;
      const meshEventId = `evt_${sha256(`${meshSeed}:event`).slice(0, 40)}`;
      const meshAuditId = `audit_${sha256(`${meshSeed}:audit`).slice(0, 40)}`;
      const durableMeshForIdempotency = durableOwnedMeshes?.find(
        (entry) => entry.mesh.meshId === meshId,
      );
      const existingMeshForIdempotency: { ownerAccountId: string | null } | undefined =
        durableMeshForIdempotency
          ? { ownerAccountId: durableMeshForIdempotency.mesh.ownerAccountId }
          : (() => {
              const row = db.prepare(
                "SELECT owner_account_id FROM meshes WHERE id = ?",
              ).get(meshId) as { owner_account_id: string | null } | undefined;
              return row ? { ownerAccountId: row.owner_account_id } : undefined;
            })();
      const ownedMeshCount = durableOwnedMeshes
        ? durableOwnedMeshes.filter((entry) => entry.role === "owner").length
        : Number((db
            .prepare("SELECT COUNT(*) AS count FROM meshes WHERE owner_account_id = ?")
            .get(principal.accountId) as { count: number }).count);
      // A retry must reach the durable idempotency check even when the account
      // has since reached its ten-mesh quota. New keys still fail fast here.
      if (
        ownedMeshCount >= MAX_OWNED_MESHES_PER_ACCOUNT &&
        existingMeshForIdempotency?.ownerAccountId !== principal.accountId
      ) {
        throw new ApiError(429, "mesh_limit_reached", "This account has reached its mesh limit.");
      }
      const meshEvent: RepositoryEventInput = {
        eventId: meshEventId,
        type: "mesh.created",
        meshId,
        topicId,
        agentId: null,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: { meshId, ownerAccountId: principal.accountId, visibility, joinPolicy },
        occurredAt: now,
      };
      const meshAudit: RepositoryAuditInput = {
        auditId: meshAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.created",
        resourceType: "mesh",
        resourceId: meshId,
        data: { visibility, joinPolicy },
        createdAt: now,
      };
      let durableMeshDuplicate = false;
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
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
        };
        const topicInput: RepositoryTopicInput = {
          topicId,
          meshId,
          name: "general",
          title: "General",
          description: "A place for agents to begin a conversation.",
          tags: [],
          createdAt: now,
        };
        if (repository?.createMeshWithOwner) {
          const result = await repository.createMeshWithOwner({
            mesh: meshInput,
            topic: topicInput,
            agentIds,
            idempotencyKey,
            requestHash,
            event: meshEvent,
            audit: meshAudit,
          });
          durableMeshDuplicate = result.duplicate;
          // The SQLite conformance adapter writes directly into the same
          // database used by this handler. Firestore has a separate durable
          // store and therefore needs the local projection step below.
          if (!repository.loadProjection) durableMeshDuplicate = true;
        } else {
          await repository?.upsertMesh?.(meshInput);
          await repository?.upsertTopic?.(topicInput);
          await repository?.upsertMeshHumanRole?.({
            meshId,
            accountId: principal.accountId,
            role: "owner",
            createdAt: now,
            updatedAt: now,
            actingAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
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
              actingAccountId: principal.accountId,
              humanSessionHash: principal.sessionHash,
            });
          }
        }
      });
      if (!repository) {
        const existing = db.prepare(
          `SELECT owner_account_id, name, description, visibility, join_policy
           FROM meshes WHERE id = ?`,
        ).get(meshId) as {
          owner_account_id: string | null;
          name: string;
          description: string;
          visibility: string;
          join_policy: string;
        } | undefined;
        const topicExists = db.prepare(
          "SELECT 1 FROM topics WHERE id = ? AND mesh_id = ?",
        ).get(topicId, meshId);
        const existingAgentIds = db
          .prepare("SELECT agent_id FROM mesh_members WHERE mesh_id = ? ORDER BY agent_id")
          .all(meshId)
          .map((row) => (row as { agent_id: string }).agent_id);
        const requestedAgentIds = [...agentIds].sort();
        if (existing) {
          const matches = topicExists && existing.owner_account_id === principal.accountId &&
            existing.name === name && existing.description === description &&
            existing.visibility === visibility && existing.join_policy === joinPolicy &&
            existingAgentIds.length === requestedAgentIds.length &&
            existingAgentIds.every((agentId, index) => agentId === requestedAgentIds[index]);
          if (!matches) throw new ApiError(409, "idempotency_conflict", "This idempotency key was already used for a different mesh.");
          durableMeshDuplicate = true;
        }
      }
      if (durableMeshDuplicate && repository?.loadProjection) {
        await refreshHumanProjection(principal.accountId);
      }
      const mesh = database.transaction(() => {
        if (durableMeshDuplicate) return { id: meshId, topicId };
        db.prepare(
          `INSERT INTO meshes(
             id, owner_account_id, name, description, visibility, join_policy,
             lifecycle, created_at, updated_at
           ) VALUES(?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(meshId, principal.accountId, name, description, visibility, joinPolicy, now, now);
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
          auditId: meshAuditId,
          createdAt: now,
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: "mesh.created",
          resourceType: "mesh",
          resourceId: meshId,
          data: { visibility, joinPolicy },
          durable: Boolean(repository?.createMeshWithOwner),
        });
        emitEvent("mesh.created", null, meshId, topicId, meshEvent.payload, {
          eventId: meshEventId,
          occurredAt: now,
          sessionId: principal.sessionHash,
          durable: Boolean(repository?.createMeshWithOwner),
        });
        return { id: meshId, topicId };
      });
      const summary = meshSummary(readMesh(mesh.id), principal.accountId);
      return {
        status: durableMeshDuplicate ? 200 : 201,
        body: {
          mesh: summary,
          topic: summary.topics.find(
            (topic) => topic.id === mesh.topicId,
          ),
        },
      };
    }

    const meshGovernanceMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/governance$/);
    if (meshGovernanceMatch && (method === "GET" || method === "PUT")) {
      // Governance is a sensitive metadata surface. Force a fresh durable
      // projection so a public-to-private transition cannot leave stale local
      // topics, members, or roles visible during the cache window.
      const principal = await requireHuman(request, true);
      const meshId = decodeURIComponent(meshGovernanceMatch[1]);
      let mesh: ReturnType<typeof readMesh>;
      if (repository?.findMeshById) {
        let authoritativeMesh: RepositoryMeshInput | null;
        try {
          authoritativeMesh = await repository.findMeshById(meshId);
        } catch (error) {
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The governance store is unavailable.",
          );
        }
        if (!authoritativeMesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
        mesh = {
          id: authoritativeMesh.meshId,
          owner_account_id: authoritativeMesh.ownerAccountId,
          name: authoritativeMesh.name,
          description: authoritativeMesh.description,
          visibility: authoritativeMesh.visibility,
          join_policy: authoritativeMesh.admission,
          created_at: authoritativeMesh.createdAt,
        };
      } else {
        mesh = readMesh(meshId);
      }
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
        // Recheck the durable visibility and role immediately before sending
        // governance metadata. A public-to-private transition can race the
        // initial read above; returning the cached roles/topics in that case
        // would disclose a private mesh to a non-member.
        let finalMesh = mesh;
        let finalRole = role;
        if (repository?.findMeshById && repository.findMeshHumanRole) {
          let authoritativeFinalMesh: RepositoryMeshInput | null;
          try {
            [authoritativeFinalMesh, finalRole] = await Promise.all([
              repository.findMeshById(meshId),
              repository.findMeshHumanRole(meshId, principal.accountId),
            ]);
          } catch (error) {
            throw new ApiError(
              503,
              "governance_store_unavailable",
              error instanceof Error ? error.message : "The governance store is unavailable.",
            );
          }
          if (!authoritativeFinalMesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
          finalMesh = {
            id: authoritativeFinalMesh.meshId,
            owner_account_id: authoritativeFinalMesh.ownerAccountId,
            name: authoritativeFinalMesh.name,
            description: authoritativeFinalMesh.description,
            visibility: authoritativeFinalMesh.visibility,
            join_policy: authoritativeFinalMesh.admission,
            created_at: authoritativeFinalMesh.createdAt,
          };
        }
        if (!finalRole && finalMesh.visibility !== "public") {
          throw new ApiError(403, "mesh_access_denied", "You cannot view this mesh governance.");
        }
        // A replica-local SQLite roster can retain a collaborator after a
        // role removal was committed on another API replica. When Firestore is
        // authoritative, use its metadata-only directory entry (which performs
        // a transaction-consistent role read) for the response instead of the
        // stale compatibility projection. Public meshes may legitimately have
        // no directory entry if they disappeared between the terminal checks;
        // fail closed with an empty roster rather than disclose cached roles.
        if (repository?.listMeshDirectoryForAccount) {
          let directory: RepositoryMeshDirectoryEntry[];
          try {
            directory = await repository.listMeshDirectoryForAccount(principal.accountId);
          } catch (error) {
            throw new ApiError(
              503,
              "governance_store_unavailable",
              error instanceof Error ? error.message : "The governance store is unavailable.",
            );
          }
          const entry = directory.find((candidate) => candidate.mesh.meshId === meshId);
          // Do not combine an absent authoritative entry with the replica's
          // cached mesh summary. The entry is the complete metadata boundary;
          // if it disappeared between the terminal checks, fail closed rather
          // than returning stale topics, members, or activity for a mesh that
          // may have just become private or archived.
          if (!entry) {
            throw new ApiError(404, "mesh_not_found", "Mesh not found.");
          }
          const authoritativeRole = entry.role;
          if (!authoritativeRole && entry.mesh.visibility !== "public") {
            throw new ApiError(403, "mesh_access_denied", "You cannot view this mesh governance.");
          }
          const authoritativeSummary = meshSummaryFromDirectory(entry);
          return {
            body: {
              mesh: authoritativeSummary,
              role: authoritativeRole,
              roles: authoritativeSummary.roles,
            },
          };
        }
        return { body: { mesh: meshSummary(finalMesh, principal.accountId), role: finalRole, roles } };
      }
      requireCsrf(request, principal);
      await requireMeshRole(principal.accountId, meshId, ["owner"]);
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (!["name", "description", "visibility", "joinPolicy"].includes(key)) {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const name = input.name === undefined ? undefined : requiredString(input, "name", { max: 80 });
      const description = input.description === undefined
        ? undefined
        : optionalString(input, "description", 500) ?? "";
      const visibility = input.visibility === undefined ? undefined : input.visibility;
      const joinPolicy = input.joinPolicy === undefined ? undefined : input.joinPolicy;
      if (visibility !== undefined && !["public", "unlisted", "private"].includes(String(visibility))) {
        throw new ApiError(400, "invalid_mesh", "visibility must be public, unlisted, or private.");
      }
      if (joinPolicy !== undefined && !["open", "approval", "invite_only"].includes(String(joinPolicy))) {
        throw new ApiError(400, "invalid_mesh", "joinPolicy is invalid.");
      }
      if (name === undefined && description === undefined && visibility === undefined && joinPolicy === undefined) {
        throw new ApiError(400, "invalid_mesh", "Set at least one governance field.");
      }
      const now = database.now();
      const governanceEventId = database.id("evt");
      const governanceAuditId = database.id("audit");
      const governancePayload = {
        meshId,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(visibility === undefined ? {} : { visibility }),
        ...(joinPolicy === undefined ? {} : { joinPolicy }),
      };
      const governanceEvent: RepositoryEventInput = {
        eventId: governanceEventId,
        type: "mesh.governance.updated",
        meshId,
        topicId: null,
        agentId: null,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: governancePayload,
        occurredAt: now,
      };
      const governanceAudit: RepositoryAuditInput = {
        auditId: governanceAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.governance.updated",
        resourceType: "mesh",
        resourceId: meshId,
        data: governancePayload,
        createdAt: now,
      };
      const governancePatch: RepositoryMeshGovernancePatch = {
        meshId,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(visibility === undefined ? {} : { visibility: visibility as RepositoryMeshGovernancePatch["visibility"] }),
        ...(joinPolicy === undefined ? {} : { admission: joinPolicy as RepositoryMeshGovernancePatch["admission"] }),
        updatedAt: now,
        actingAccountId: principal.accountId,
        humanSessionHash: principal.sessionHash,
        event: governanceEvent,
        audit: governanceAudit,
      };
      let committedMesh: RepositoryMeshInput;
      if (repository?.updateMeshGovernance) {
        try {
          committedMesh = await repository.updateMeshGovernance(governancePatch);
        } catch (error) {
          const message = error instanceof Error ? error.message : "The governance store is unavailable.";
          if (message === "mesh_not_found") throw new ApiError(404, "mesh_not_found", "Mesh not found.");
          if (message === "mesh_governance_denied") {
            throw new ApiError(403, "mesh_governance_denied", "You do not have the required mesh role.");
          }
          throw new ApiError(503, "governance_store_unavailable", message);
        }
      } else {
        // SQLite and focused test doubles use the complete merged shape for
        // compatibility. The production repository above is the authoritative
        // compare-and-set path that never trusts this projection snapshot.
        committedMesh = {
          meshId,
          ownerAccountId: mesh.owner_account_id,
          name: name ?? mesh.name,
          description: description ?? mesh.description,
          visibility: (visibility ?? mesh.visibility) as RepositoryMeshInput["visibility"],
          admission: (joinPolicy ?? mesh.join_policy) as RepositoryMeshInput["admission"],
          lifecycle: "active",
          createdAt: mesh.created_at,
          updatedAt: now,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
        };
        await durableWrite("mesh governance update", async () => {
          await repository?.upsertMesh?.({ ...committedMesh, event: governanceEvent, audit: governanceAudit });
        });
      }
      database.transaction(() => {
        db.prepare(
          `UPDATE meshes SET name = ?, description = ?, visibility = ?, join_policy = ?,
                             lifecycle = ?, updated_at = ? WHERE id = ?`,
        ).run(
          committedMesh.name,
          committedMesh.description,
          committedMesh.visibility,
          committedMesh.admission,
          committedMesh.lifecycle,
          committedMesh.updatedAt,
          meshId,
        );
        emitAudit({
          auditId: governanceAuditId,
          createdAt: now,
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: "mesh.governance.updated",
          resourceType: "mesh",
          resourceId: meshId,
          data: governancePayload,
          durable: Boolean(repository?.updateMeshGovernance ?? repository?.upsertMesh),
        });
        emitEvent("mesh.governance.updated", null, meshId, null, governancePayload, {
          eventId: governanceEventId,
          occurredAt: now,
          sessionId: principal.sessionHash,
          durable: Boolean(repository?.updateMeshGovernance ?? repository?.upsertMesh),
        });
      });
      return { body: { mesh: meshSummary(readMesh(meshId), principal.accountId) } };
    }

    const meshTopicListMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/topics$/);
    if (meshTopicListMatch && (method === "GET" || method === "POST")) {
      const principal = await requireHuman(request, true);
      const meshId = decodeURIComponent(meshTopicListMatch[1]);
      if (method === "GET") {
        if (repository?.listMeshDirectoryForAccount) {
          let directory: RepositoryMeshDirectoryEntry[];
          try {
            directory = await repository.listMeshDirectoryForAccount(principal.accountId);
          } catch (error) {
            throw new ApiError(
              503,
              "topic_store_unavailable",
              error instanceof Error ? error.message : "The topic store is unavailable.",
            );
          }
          const entry = directory.find((candidate) => candidate.mesh.meshId === meshId);
          if (!entry) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
          return {
            body: {
              topics: entry.topics.map(({ topic, activityCount, recentActivityCount, participantAgentIds, lastActivityAt }) => ({
                id: topic.topicId,
                meshId: topic.meshId,
                name: topic.name,
                title: topic.title,
                description: topic.description,
                tags: topic.tags,
                activityCount,
                recentActivityCount,
                participantAgentIds,
                lastActivityAt,
                createdAt: topic.createdAt,
              })),
            },
          };
        }
        const mesh = readMesh(meshId);
        const role = await meshRoleForAuthoritatively(principal.accountId, meshId);
        if (!role && mesh.visibility !== "public") {
          throw new ApiError(403, "mesh_access_denied", "You cannot view topics in this mesh.");
        }
        return { body: { topics: meshSummary(mesh, principal.accountId).topics } };
      }

      requireCsrf(request, principal);
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      await enforceGovernanceRate(principal.accountId);
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (!["name", "title", "description", "tags"].includes(key)) {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const name = requiredString(input, "name", {
        min: 2,
        max: 64,
        pattern: /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i,
      }).toLowerCase();
      const title = requiredString(input, "title", { max: 100 });
      const description = optionalString(input, "description", 500) ?? "";
      const tags = input.tags === undefined
        ? []
        : (() => {
            if (!Array.isArray(input.tags) || input.tags.length > 12) {
              throw new ApiError(400, "invalid_topic", "tags must be an array with at most 12 entries.");
            }
            return input.tags.map((tag) => {
              if (typeof tag !== "string" || tag.trim().length < 1 || tag.trim().length > 32) {
                throw new ApiError(400, "invalid_topic", "Each topic tag must be between 1 and 32 characters.");
              }
              return tag.trim().toLowerCase();
            });
          })();
      const now = database.now();
      const topicId = database.id("topic");
      const eventId = database.id("evt");
      const auditId = database.id("audit");
      const payload = { topicId, meshId, name, title, description, tags };
      const event: RepositoryEventInput = {
        eventId,
        type: "mesh.topic.created",
        meshId,
        topicId,
        agentId: null,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload,
        occurredAt: now,
      };
      const audit: RepositoryAuditInput = {
        auditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.topic.created",
        resourceType: "topic",
        resourceId: topicId,
        data: payload,
        createdAt: now,
      };
      if (repository && typeof repository.createTopic !== "function") {
        throw new ApiError(503, "topic_store_unavailable", "The topic store is unavailable.");
      }
      await durableWrite("topic create", async () => {
        await repository?.createTopic?.({
          topicId,
          meshId,
          name,
          title,
          description,
          tags,
          createdAt: now,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          event,
          audit,
        });
      });
      if (repository?.createTopic && repository?.loadProjection) {
        await refreshHumanProjection(principal.accountId);
      } else if (!repository) {
        database.transaction(() => {
          if (db.prepare("SELECT 1 FROM topics WHERE id = ?").get(topicId)) {
            throw new ApiError(409, "topic_already_exists", "That topic already exists.");
          }
          const topicCount = db
            .prepare("SELECT COUNT(*) AS count FROM topics WHERE mesh_id = ?")
            .get(meshId) as { count: number };
          if (Number(topicCount.count) >= MAX_TOPICS_PER_MESH) {
            throw new ApiError(429, "topic_limit_reached", "This mesh has reached its topic limit.");
          }
          if (db.prepare("SELECT 1 FROM topics WHERE mesh_id = ? AND name = ?").get(meshId, name)) {
            throw new ApiError(409, "topic_name_taken", "Choose a different topic name.");
          }
          db.prepare(
            `INSERT INTO topics(id, mesh_id, name, title, description, tags_json, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)`,
          ).run(topicId, meshId, name, title, description, JSON.stringify(tags), now);
          emitAudit({
            auditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.topic.created",
            resourceType: "topic",
            resourceId: topicId,
            data: payload,
          });
          emitEvent("mesh.topic.created", null, meshId, topicId, payload, {
            eventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
          });
        });
      }
      const summary = meshSummary(readMesh(meshId), principal.accountId);
      return {
        status: 201,
        body: { topic: summary.topics.find((topic) => topic.id === topicId) ?? payload },
      };
    }

    const meshTopicItemMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/topics\/([^/]+)$/);
    if (meshTopicItemMatch && (method === "PUT" || method === "DELETE")) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(meshTopicItemMatch[1]);
      const topicId = decodeURIComponent(meshTopicItemMatch[2]);
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      await enforceGovernanceRate(principal.accountId);
      let currentTopic: RepositoryTopicInput | null = null;
      if (repository?.findTopicById) {
        try {
          currentTopic = await repository.findTopicById(topicId);
        } catch (error) {
          throw new ApiError(
            503,
            "topic_store_unavailable",
            error instanceof Error ? error.message : "The topic store is unavailable.",
          );
        }
      } else {
        const row = db.prepare(
          `SELECT id, mesh_id, name, title, description, tags_json, created_at
           FROM topics WHERE id = ?`,
        ).get(topicId) as {
          id: string;
          mesh_id: string;
          name: string;
          title: string;
          description: string;
          tags_json: string;
          created_at: string;
        } | undefined;
        if (row) {
          let parsedTags: string[] = [];
          try {
            const rawTags = JSON.parse(row.tags_json) as unknown;
            if (Array.isArray(rawTags)) parsedTags = rawTags.map(String);
          } catch {
            parsedTags = [];
          }
          currentTopic = {
            topicId: row.id,
            meshId: row.mesh_id,
            name: row.name,
            title: row.title,
            description: row.description,
            tags: parsedTags,
            createdAt: row.created_at,
          };
        }
      }
      if (!currentTopic || currentTopic.meshId !== meshId) {
        throw new ApiError(404, "topic_not_found", "Topic not found.");
      }
      const now = database.now();
      if (method === "DELETE") {
        const eventId = database.id("evt");
        const auditId = database.id("audit");
        const payload = { topicId, meshId };
        const event: RepositoryEventInput = {
          eventId,
          type: "mesh.topic.deleted",
          meshId,
          topicId,
          agentId: null,
          sessionId: principal.sessionHash,
          runtimeKind: null,
          payload,
          occurredAt: now,
        };
        const audit: RepositoryAuditInput = {
          auditId,
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: "mesh.topic.deleted",
          resourceType: "topic",
          resourceId: topicId,
          data: payload,
          createdAt: now,
        };
        if (repository && typeof repository.deleteTopic !== "function") {
          throw new ApiError(503, "topic_store_unavailable", "The topic store is unavailable.");
        }
        await durableWrite("topic delete", async () => {
          await repository?.deleteTopic?.({
            topicId,
            meshId,
            deletedAt: now,
            actingAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
            event,
            audit,
          });
        });
        if (repository?.deleteTopic && repository?.loadProjection) {
          await refreshHumanProjection(principal.accountId);
        } else if (!repository) {
          database.transaction(() => {
            const topicCount = db
              .prepare("SELECT COUNT(*) AS count FROM topics WHERE mesh_id = ?")
              .get(meshId) as { count: number };
            if (Number(topicCount.count) <= 1) {
              throw new ApiError(409, "last_topic", "A mesh must keep at least one topic.");
            }
            if (db.prepare("SELECT 1 FROM posts WHERE topic_id = ? LIMIT 1").get(topicId)) {
              throw new ApiError(409, "topic_not_empty", "Topics with retained posts cannot be deleted.");
            }
            db.prepare("DELETE FROM follows WHERE topic_id = ?").run(topicId);
            db.prepare("DELETE FROM topics WHERE id = ? AND mesh_id = ?").run(topicId, meshId);
            emitAudit({
              auditId,
              createdAt: now,
              actorType: "human",
              actorId: principal.accountId,
              sessionId: principal.sessionHash,
              action: "mesh.topic.deleted",
              resourceType: "topic",
              resourceId: topicId,
              data: payload,
            });
            // The local compatibility schema cascades topic references from
            // `events`; retain the deleted id in the payload while keeping
            // the event row itself reference-free so the audit survives.
            emitEvent("mesh.topic.deleted", null, meshId, null, payload, {
              eventId,
              occurredAt: now,
              sessionId: principal.sessionHash,
            });
          });
        }
        return { body: { meshId, topicId, deleted: true } };
      }

      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (!["name", "title", "description", "tags"].includes(key)) {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const name = input.name === undefined
        ? currentTopic.name
        : requiredString(input, "name", {
            min: 2,
            max: 64,
            pattern: /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/i,
          }).toLowerCase();
      const title = input.title === undefined ? currentTopic.title : requiredString(input, "title", { max: 100 });
      const description = input.description === undefined
        ? currentTopic.description
        : optionalString(input, "description", 500) ?? "";
      const tags = input.tags === undefined
        ? currentTopic.tags
        : (() => {
            if (!Array.isArray(input.tags) || input.tags.length > 12) {
              throw new ApiError(400, "invalid_topic", "tags must be an array with at most 12 entries.");
            }
            return input.tags.map((tag) => {
              if (typeof tag !== "string" || tag.trim().length < 1 || tag.trim().length > 32) {
                throw new ApiError(400, "invalid_topic", "Each topic tag must be between 1 and 32 characters.");
              }
              return tag.trim().toLowerCase();
            });
          })();
      const eventId = database.id("evt");
      const auditId = database.id("audit");
      const payload = { topicId, meshId, name, title, description, tags };
      const event: RepositoryEventInput = {
        eventId,
        type: "mesh.topic.updated",
        meshId,
        topicId,
        agentId: null,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload,
        occurredAt: now,
      };
      const audit: RepositoryAuditInput = {
        auditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.topic.updated",
        resourceType: "topic",
        resourceId: topicId,
        data: payload,
        createdAt: now,
      };
      if (repository && typeof repository.updateTopic !== "function") {
        throw new ApiError(503, "topic_store_unavailable", "The topic store is unavailable.");
      }
      await durableWrite("topic update", async () => {
        await repository?.updateTopic?.({
          topicId,
          meshId,
          name,
          title,
          description,
          tags,
          updatedAt: now,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          event,
          audit,
        });
      });
      if (repository?.updateTopic && repository?.loadProjection) {
        await refreshHumanProjection(principal.accountId);
      } else if (!repository) {
        database.transaction(() => {
          if (db.prepare("SELECT 1 FROM topics WHERE mesh_id = ? AND name = ? AND id <> ?").get(meshId, name, topicId)) {
            throw new ApiError(409, "topic_name_taken", "Choose a different topic name.");
          }
          db.prepare(
            `UPDATE topics SET name = ?, title = ?, description = ?, tags_json = ?
             WHERE id = ? AND mesh_id = ?`,
          ).run(name, title, description, JSON.stringify(tags), topicId, meshId);
          emitAudit({
            auditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.topic.updated",
            resourceType: "topic",
            resourceId: topicId,
            data: payload,
          });
          emitEvent("mesh.topic.updated", null, meshId, topicId, payload, {
            eventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
          });
        });
      }
      const summary = meshSummary(readMesh(meshId), principal.accountId);
      return {
        body: { topic: summary.topics.find((topic) => topic.id === topicId) ?? payload },
      };
    }

    const meshInvitationListMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/invitations$/);
    if (meshInvitationListMatch && (method === "GET" || method === "POST")) {
      const principal = await requireHuman(request, true);
      const meshId = decodeURIComponent(meshInvitationListMatch[1]);
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      if (method === "GET") {
        const invitations = await listMeshInvitationsForRoute(meshId);
        // Revalidate both the browser session and the durable governance role
        // after the potentially slow invitation read. A role removal on
        // another replica must not leave a stale private invitation roster in
        // the response.
        const terminalPrincipal = await requireHuman(request, false, { touchSession: false });
        await requireMeshRole(terminalPrincipal.accountId, meshId, ["owner", "steward"]);
        return { body: { invitations: invitations.map(meshInvitationRepresentation) } };
      }
      requireCsrf(request, principal);
      await enforceGovernanceRate(principal.accountId, {
        bucket: "mesh-invitation",
        code: "mesh_invitation_rate_limited",
        message: "Mesh invitations are temporarily rate limited. Try again shortly.",
      });
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (!["agentId", "expiresInSeconds"].includes(key)) {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const invitedAgentId = input.agentId === undefined
        ? null
        : requiredString(input, "agentId", { max: 128 });
      if (invitedAgentId && repository?.findAgentById) {
        let invitedAgent: RepositoryAgentInput | null;
        try {
          invitedAgent = await repository.findAgentById(invitedAgentId);
        } catch (error) {
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The agent store is unavailable.",
          );
        }
        if (!invitedAgent) throw new ApiError(404, "agent_not_found", "Agent not found.");
      } else if (invitedAgentId && !db.prepare("SELECT 1 FROM agents WHERE id = ?").get(invitedAgentId)) {
        throw new ApiError(404, "agent_not_found", "Agent not found.");
      }
      const rawExpiry = input.expiresInSeconds;
      const expiresInSeconds = rawExpiry === undefined ? 7 * 24 * 60 * 60 : rawExpiry;
      if (
        typeof expiresInSeconds !== "number" ||
        !Number.isSafeInteger(expiresInSeconds) ||
        expiresInSeconds < 60 ||
        expiresInSeconds > 30 * 24 * 60 * 60
      ) {
        throw new ApiError(400, "invalid_request", "expiresInSeconds must be between 60 seconds and 30 days.");
      }
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, expiresInSeconds);
      const invitationId = database.id("invite");
      const token = randomToken(32);
      const tokenHash = sha256(token);
      const eventId = database.id("evt");
      const auditId = database.id("audit");
      const payload = { invitationId, meshId, invitedAgentId, expiresAt };
      const event: RepositoryEventInput = {
        eventId,
        type: "mesh.invitation.created",
        meshId,
        topicId: null,
        agentId: invitedAgentId,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload,
        occurredAt: now,
      };
      const audit: RepositoryAuditInput = {
        auditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.invitation.created",
        resourceType: "mesh_invitation",
        resourceId: invitationId,
        data: payload,
        createdAt: now,
      };
      if (repository?.createMeshInvitation) {
        try {
          await repository.createMeshInvitation({
            invitationId,
            meshId,
            tokenHash,
            invitedAgentId,
            createdByAccountId: principal.accountId,
            createdAt: now,
            expiresAt,
            actingAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
            event,
            audit,
          });
        } catch (error) {
          if (error instanceof Error && error.message === "mesh_governance_denied") {
            throw new ApiError(403, "mesh_governance_denied", "You do not have the required mesh role.");
          }
          if (error instanceof Error && error.message === "mesh_not_found") {
            throw new ApiError(404, "mesh_not_found", "Mesh not found.");
          }
          if (error instanceof Error && error.message === "agent_not_found") {
            throw new ApiError(404, "agent_not_found", "Agent not found.");
          }
          if (error instanceof Error && error.message === "invitation_limit_reached") {
            throw new ApiError(429, "invitation_limit_reached", "This mesh has reached the 50 active-invitation limit.");
          }
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The invitation store is unavailable.",
          );
        }
        // Firestore owns the invitation and its event/audit records. A fresh
        // API replica may not have the mesh row in its disposable SQLite
        // projection yet, so only mirror when this repository explicitly does
        // not provide a durable list (the local compatibility case).
        if (!repository.listMeshInvitations) {
          const localMesh = db.prepare("SELECT 1 FROM meshes WHERE id = ?").get(meshId);
          if (localMesh) {
            database.transaction(() => {
              db.prepare(
                `INSERT INTO mesh_invitations(
                   id, mesh_id, token_hash, invited_agent_id, created_by_account_id,
                   status, created_at, expires_at, redeemed_at, redeemed_agent_id
                 ) VALUES(?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
              ).run(invitationId, meshId, tokenHash, invitedAgentId, principal.accountId, now, expiresAt);
              emitAudit({
                auditId,
                createdAt: now,
                actorType: "human",
                actorId: principal.accountId,
                sessionId: principal.sessionHash,
                action: "mesh.invitation.created",
                resourceType: "mesh_invitation",
                resourceId: invitationId,
                data: payload,
                durable: true,
              });
              emitEvent("mesh.invitation.created", invitedAgentId, meshId, null, payload, {
                eventId,
                occurredAt: now,
                sessionId: principal.sessionHash,
                durable: true,
              });
            });
          }
        }
      } else {
        database.transaction(() => {
          db.prepare(
            `INSERT INTO mesh_invitations(
               id, mesh_id, token_hash, invited_agent_id, created_by_account_id,
               status, created_at, expires_at, redeemed_at, redeemed_agent_id
             ) VALUES(?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL)`,
          ).run(invitationId, meshId, tokenHash, invitedAgentId, principal.accountId, now, expiresAt);
          emitAudit({
            auditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.invitation.created",
            resourceType: "mesh_invitation",
            resourceId: invitationId,
            data: payload,
          });
          emitEvent("mesh.invitation.created", invitedAgentId, meshId, null, payload, {
            eventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
          });
        });
      }
      return {
        status: 201,
        body: {
          invitation: {
            id: invitationId,
            meshId,
            invitedAgentId,
            createdByAccountId: principal.accountId,
            status: "active",
            createdAt: now,
            expiresAt,
            redeemedAt: null,
            redeemedAgentId: null,
          },
          token,
        },
      };
    }

    const meshInvitationRevokeMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/invitations\/([^/]+)\/revoke$/,
    );
    if (method === "POST" && meshInvitationRevokeMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(meshInvitationRevokeMatch[1]);
      const invitationId = decodeURIComponent(meshInvitationRevokeMatch[2]);
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      await enforceGovernanceRate(principal.accountId, {
        bucket: "mesh-invitation",
        code: "mesh_invitation_rate_limited",
        message: "Mesh invitations are temporarily rate limited. Try again shortly.",
      });
      const now = database.now();
      const eventId = database.id("evt");
      const auditId = database.id("audit");
      const payload = { invitationId, meshId };
      const event: RepositoryEventInput = {
        eventId,
        type: "mesh.invitation.revoked",
        meshId,
        topicId: null,
        agentId: null,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload,
        occurredAt: now,
      };
      const audit: RepositoryAuditInput = {
        auditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.invitation.revoked",
        resourceType: "mesh_invitation",
        resourceId: invitationId,
        data: payload,
        createdAt: now,
      };
      if (repository?.revokeMeshInvitation) {
        try {
          await repository.revokeMeshInvitation({
            invitationId,
            meshId,
            revokedAt: now,
            actingAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
            event,
            audit,
          });
        } catch (error) {
          if (error instanceof Error && error.message === "invitation_not_found") {
            throw new ApiError(404, "invitation_not_found", "Invitation not found.");
          }
          if (error instanceof Error && error.message === "invitation_not_active") {
            throw new ApiError(409, "invitation_not_active", "That invitation is no longer active.");
          }
          if (error instanceof Error && error.message === "mesh_governance_denied") {
            throw new ApiError(403, "mesh_governance_denied", "You do not have the required mesh role.");
          }
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The invitation store is unavailable.",
          );
        }
        // Firestore replicas do not need a local invitation row: the durable
        // transaction already contains the authoritative state and event.
        if (!repository.listMeshInvitations) {
          db.prepare(
            "UPDATE mesh_invitations SET status = 'revoked' WHERE id = ? AND mesh_id = ? AND status = 'active'",
          ).run(invitationId, meshId);
          emitAudit({
            auditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.invitation.revoked",
            resourceType: "mesh_invitation",
            resourceId: invitationId,
            data: payload,
            durable: true,
          });
          emitEvent("mesh.invitation.revoked", null, meshId, null, payload, {
            eventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
            durable: true,
          });
        }
      } else {
        const result = database.transaction(() => {
          const outcome = db.prepare(
            "UPDATE mesh_invitations SET status = 'revoked' WHERE id = ? AND mesh_id = ? AND status = 'active'",
          ).run(invitationId, meshId);
          if (outcome.changes !== 1) throw new ApiError(404, "invitation_not_found", "Invitation not found or already inactive.");
          emitAudit({
            auditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.invitation.revoked",
            resourceType: "mesh_invitation",
            resourceId: invitationId,
            data: payload,
          });
          emitEvent("mesh.invitation.revoked", null, meshId, null, payload, {
            eventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
          });
        });
        void result;
      }
      return { body: { invitationId, meshId, status: "revoked" } };
    }

    const meshRoleInvitationCollectionMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/role-invitations$/,
    );
    if ((method === "GET" || method === "POST") && meshRoleInvitationCollectionMatch) {
      const principal = await requireHuman(request, true);
      const meshId = decodeURIComponent(meshRoleInvitationCollectionMatch[1]);
      await requireMeshRole(principal.accountId, meshId, ["owner"]);
      if (method === "GET") {
        await enforceGovernanceRate(principal.accountId, {
          bucket: "role-invitation-read",
          code: "role_invitation_rate_limited",
          message: "Role-invitation reads are temporarily rate limited. Try again shortly.",
        });
        let invitations: RepositoryMeshRoleInvitation[] = [];
        try {
          invitations = await roleInvitationStore.listMeshRoleInvitations!(meshId);
        } catch (error) {
          mapRoleInvitationError(error);
        }
        // Return the value only after the durable read succeeds; keep the
        // session and role barrier outside the repository-error mapper so an
        // authorization failure is not mislabeled as a store outage.
        const terminalPrincipal = await requireHuman(request, false, { touchSession: false });
        await requireMeshRole(terminalPrincipal.accountId, meshId, ["owner"]);
        return { body: { invitations: invitations.map(meshRoleInvitationRepresentation) } };
      }
      requireCsrf(request, principal);
      await enforceGovernanceRate(principal.accountId);
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (!["email", "role", "expiresInSeconds"].includes(key)) {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      // Do not resolve the email to an account here. A role invitation is a
      // one-use capability addressed by a peppered fingerprint; account
      // existence is revealed only to the authenticated target at acceptance.
      const email = normalizeEmail(requiredString(input, "email", { max: 254 }));
      const role = input.role === undefined ? "observer" : input.role;
      if (role !== "owner" && role !== "steward" && role !== "observer") {
        throw new ApiError(400, "invalid_role", "role must be owner, steward, or observer.");
      }
      const rawExpiry = input.expiresInSeconds;
      const expiresInSeconds = rawExpiry === undefined ? 7 * 24 * 60 * 60 : rawExpiry;
      if (
        typeof expiresInSeconds !== "number" ||
        !Number.isSafeInteger(expiresInSeconds) ||
        expiresInSeconds < 60 ||
        expiresInSeconds > 30 * 24 * 60 * 60
      ) {
        throw new ApiError(400, "invalid_request", "expiresInSeconds must be between 60 seconds and 30 days.");
      }
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, expiresInSeconds);
      const invitationId = database.id("role-invite");
      const token = randomToken(32);
      const tokenHash = sha256(token);
      const targetEmailHash = hmacSha256(email, invitationPepper);
      const eventId = database.id("evt");
      const auditId = database.id("audit");
      const payload = { invitationId, meshId, role, expiresAt };
      const event: RepositoryEventInput = {
        eventId,
        type: "mesh.role.invitation.created",
        meshId,
        topicId: null,
        agentId: null,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload,
        occurredAt: now,
      };
      const audit: RepositoryAuditInput = {
        auditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.role.invitation.created",
        resourceType: "mesh_role_invitation",
        resourceId: invitationId,
        data: payload,
        createdAt: now,
      };
      let created!: RepositoryMeshRoleInvitation;
      try {
        created = await roleInvitationStore.createMeshRoleInvitation!({
          invitationId,
          meshId,
          tokenHash,
          targetEmailHash,
          role,
          createdByAccountId: principal.accountId,
          createdAt: now,
          expiresAt,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          event,
          audit,
        });
      } catch (error) {
        mapRoleInvitationError(error);
      }
      return {
        status: 201,
        body: {
          invitation: meshRoleInvitationRepresentation(created),
          // The plaintext token is returned once to the inviter for delivery
          // through their trusted channel. It is never stored or logged.
          token,
        },
      };
    }

    const meshRoleInvitationRevokeMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/role-invitations\/([^/]+)\/revoke$/,
    );
    if (method === "POST" && meshRoleInvitationRevokeMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(meshRoleInvitationRevokeMatch[1]);
      const invitationId = decodeURIComponent(meshRoleInvitationRevokeMatch[2]);
      await requireMeshRole(principal.accountId, meshId, ["owner"]);
      await enforceGovernanceRate(principal.accountId);
      const now = database.now();
      const eventId = database.id("evt");
      const auditId = database.id("audit");
      const payload = { invitationId, meshId };
      try {
        await roleInvitationStore.revokeMeshRoleInvitation!({
          invitationId,
          meshId,
          revokedAt: now,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          event: {
            eventId,
            type: "mesh.role.invitation.revoked",
            meshId,
            topicId: null,
            agentId: null,
            sessionId: principal.sessionHash,
            runtimeKind: null,
            payload,
            occurredAt: now,
          },
          audit: {
            auditId,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.role.invitation.revoked",
            resourceType: "mesh_role_invitation",
            resourceId: invitationId,
            data: payload,
            createdAt: now,
          },
        });
      } catch (error) {
        mapRoleInvitationError(error);
      }
      return { body: { invitationId, meshId, status: "revoked" } };
    }

    if (method === "GET" && path === "/v1/account/role-invitations") {
      const principal = await requireHuman(request, false, { touchSession: false });
      await enforceGovernanceRate(principal.accountId, {
        bucket: "role-invitation-read",
        code: "role_invitation_rate_limited",
        message: "Role-invitation reads are temporarily rate limited. Try again shortly.",
      });
      const emailHashes = roleInvitationEmailHashes(normalizeEmail(principal.email));
      const pages = await Promise.all(
        emailHashes.map((emailHash) => roleInvitationStore.listMeshRoleInvitationsForEmail!(emailHash)),
      );
      const unique = new Map<string, RepositoryMeshRoleInvitation>();
      for (const invitation of pages.flat()) unique.set(invitation.invitationId, invitation);
      const invitations = [...unique.values()].sort(
        (left, right) => right.createdAt.localeCompare(left.createdAt) || left.invitationId.localeCompare(right.invitationId),
      );
      // The list can span multiple durable reads. Ensure a logout, expiry, or
      // provider-side account change that races those reads fails closed before
      // returning invitation metadata.
      await requireHuman(request, false, { touchSession: false });
      return { body: { invitations: invitations.map(meshRoleInvitationRepresentation) } };
    }

    const roleInvitationAcceptMatch = matchingPath(
      path,
      /^\/v1\/account\/role-invitations\/([^/]+)\/accept$/,
    );
    if (method === "POST" && roleInvitationAcceptMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      await enforceGovernanceRate(principal.accountId, {
        bucket: "role-invitation-accept",
        code: "role_invitation_rate_limited",
        message: "Role-invitation acceptance is temporarily rate limited. Try again shortly.",
      });
      const invitationId = decodeURIComponent(roleInvitationAcceptMatch[1]);
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (key !== "token") throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
      }
      const token = requiredString(input, "token", { min: 16, max: 512 });
      const key = requireIdempotencyKey(request);
      const requestHash = sha256(JSON.stringify({ invitationId, token }));
      const now = database.now();
      let invitationMeta: RepositoryMeshRoleInvitation | undefined;
      let targetEmailHash: string | undefined;
      try {
        for (const emailHash of roleInvitationEmailHashes(normalizeEmail(principal.email))) {
          const candidate = await roleInvitationStore.findMeshRoleInvitation!({
            invitationId,
            targetEmailHash: emailHash,
          });
          if (candidate) {
            invitationMeta = candidate;
            targetEmailHash = emailHash;
            break;
          }
        }
      } catch (error) {
        // The event/audit payload is part of the same durable mutation. Do not
        // fabricate mesh/role metadata or silently continue when the lookup
        // path is unavailable.
        mapRoleInvitationError(error);
      }
      if (!invitationMeta) {
        throw new ApiError(
          403,
          "role_invitation_invalid",
          "That role invitation is not addressed to this account.",
        );
      }
      const meshId = invitationMeta.meshId;
      const role = invitationMeta.role;
      const payload = { invitationId, meshId, role, accountId: principal.accountId };
      let accepted!: Awaited<ReturnType<NonNullable<MeshrRepository["acceptMeshRoleInvitation"]>>>;
      try {
        accepted = await roleInvitationStore.acceptMeshRoleInvitation!({
          invitationId,
          tokenHash: sha256(token),
          targetEmailHash,
          accountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          acceptedAt: now,
          idempotencyKey: key,
          requestHash,
          event: {
            eventId: database.id("evt"),
            type: "mesh.role.invitation.accepted",
            meshId,
            topicId: null,
            agentId: null,
            sessionId: principal.sessionHash,
            runtimeKind: null,
            payload,
            occurredAt: now,
          },
          audit: {
            auditId: database.id("audit"),
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.role.invitation.accepted",
            resourceType: "mesh_role_invitation",
            resourceId: invitationId,
            data: payload,
            createdAt: now,
          },
        });
      } catch (error) {
        mapRoleInvitationError(error);
      }
      if (repository?.loadProjection) await refreshHumanProjection(principal.accountId);
      return {
        status: accepted.duplicate ? 200 : 201,
        body: {
          invitation: meshRoleInvitationRepresentation(accepted.invitation),
          role: accepted.role,
          duplicate: accepted.duplicate,
        },
      };
    }

    const meshRoleCollectionMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/roles$/);
    if (method === "POST" && meshRoleCollectionMatch) {
      // The pre-launch email-assignment endpoint is intentionally retired:
      // it both revealed account existence and granted a role without target
      // consent. Use /role-invitations and require the recipient to accept.
      throw new ApiError(
        410,
        "role_invitation_required",
        "Human roles are granted through an invitation that the recipient accepts.",
      );
      /*
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(meshRoleCollectionMatch[1]);
      await requireMeshRole(principal.accountId, meshId, ["owner"]);
      const input = asObject(await readJson(request));
      for (const key of Object.keys(input)) {
        if (key !== "email" && key !== "role") {
          throw new ApiError(400, "invalid_request", `${key} is not allowed.`);
        }
      }
      const email = normalizeEmail(requiredString(input, "email", { max: 254 }));
      const role = input.role === undefined ? "observer" : input.role;
      if (role !== "owner" && role !== "steward" && role !== "observer") {
        throw new ApiError(400, "invalid_role", "role must be owner, steward, or observer.");
      }
      if (role === "owner") {
        throw new ApiError(
          409,
          "owner_transfer_requires_member",
          "Add the account as a steward or observer before transferring ownership.",
        );
      }
      let targetAccount: {
        accountId: string;
        email: string;
        displayName: string;
        createdAt: string;
      } | null = null;
      const localAccount = db
        .prepare("SELECT id, email, display_name, created_at FROM accounts WHERE email = ? COLLATE NOCASE")
        .get(email) as
        | { id: string; email: string; display_name: string; created_at: string }
        | undefined;
      if (localAccount) {
        targetAccount = {
          accountId: localAccount.id,
          email: localAccount.email,
          displayName: localAccount.display_name,
          createdAt: localAccount.created_at,
        };
      } else if (repository?.findAccountByEmail) {
        try {
          targetAccount = await repository.findAccountByEmail(email);
        } catch (error) {
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The account store is unavailable.",
          );
        }
      } else if (repository) {
        throw new ApiError(503, "governance_store_unavailable", "The account store is unavailable.");
      }
      if (!targetAccount) throw new ApiError(404, "account_not_found", "No Meshr account exists for that email.");
      if (targetAccount.accountId === principal.accountId) {
        throw new ApiError(400, "self_role_change", "You already own this mesh.");
      }
      const current = await meshRoleForAuthoritatively(targetAccount.accountId, meshId);
      const now = database.now();
      const roleEventId = database.id("evt");
      const roleAuditId = database.id("audit");
      const roleEventType = current ? "mesh.role.updated" : "mesh.role.added";
      const rolePayload = { meshId, accountId: targetAccount.accountId, role };
      const roleEvent: RepositoryEventInput = {
        eventId: roleEventId,
        type: roleEventType,
        meshId,
        topicId: null,
        agentId: null,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: rolePayload,
        occurredAt: now,
      };
      const roleAudit: RepositoryAuditInput = {
        auditId: roleAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: roleEventType,
        resourceType: "mesh_human_role",
        resourceId: `${meshId}:${targetAccount.accountId}`,
        data: { role, email: targetAccount.email },
        createdAt: now,
      };
      if (repository && typeof repository.upsertMeshHumanRole !== "function") {
        throw new ApiError(503, "governance_store_unavailable", "The role store is unavailable.");
      }
      await durableWrite("mesh role add", async () => {
        await repository?.upsertMeshHumanRole?.({
          meshId,
          accountId: targetAccount!.accountId,
          role,
          createdAt: current ? now : targetAccount!.createdAt,
          updatedAt: now,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          event: roleEvent,
          audit: roleAudit,
        });
      });
      if (repository?.upsertMeshHumanRole && repository?.loadProjection) {
        await refreshHumanProjection(principal.accountId);
      } else if (!repository) {
        database.transaction(() => {
          const mesh = db.prepare("SELECT owner_account_id FROM meshes WHERE id = ?").get(meshId) as
            | { owner_account_id: string | null }
            | undefined;
          if (!mesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
          db.prepare(
            `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?)
             ON CONFLICT(mesh_id, account_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
          ).run(meshId, targetAccount!.accountId, role, current ? now : targetAccount!.createdAt, now);
          syncCanonicalOwner(meshId);
          emitAudit({
            auditId: roleAuditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: roleEventType,
            resourceType: "mesh_human_role",
            resourceId: `${meshId}:${targetAccount!.accountId}`,
            data: { role, email: targetAccount!.email },
          });
          emitEvent(roleEventType, null, meshId, null, rolePayload, {
            eventId: roleEventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
          });
        });
      }
      return {
        body: {
          meshId,
          accountId: targetAccount.accountId,
          role,
          member: {
            accountId: targetAccount.accountId,
            role,
            displayName: targetAccount.displayName,
            email: targetAccount.email,
            createdAt: current ? now : targetAccount.createdAt,
            updatedAt: now,
          },
        },
      };
      */
    }

    const meshRoleMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/roles\/([^/]+)$/);
    if ((method === "PUT" || method === "DELETE") && meshRoleMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(meshRoleMatch[1]);
      const accountId = decodeURIComponent(meshRoleMatch[2]);
      await requireMeshRole(principal.accountId, meshId, ["owner"]);
      if (repository?.findMeshById) {
        let durableMesh: RepositoryMeshInput | null;
        try {
          durableMesh = await repository.findMeshById(meshId);
        } catch (error) {
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The mesh store is unavailable.",
          );
        }
        if (!durableMesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
      } else {
        readMesh(meshId);
      }
      await enforceGovernanceRate(principal.accountId, {
        bucket: "mesh-role-mutation",
        code: "mesh_role_rate_limited",
        message: "Mesh role changes are temporarily rate limited. Try again shortly.",
      });
      let targetAccountExists = Boolean(db.prepare("SELECT 1 FROM accounts WHERE id = ?").get(accountId));
      if (!targetAccountExists && repository?.findAccountById) {
        try {
          targetAccountExists = Boolean(await repository.findAccountById(accountId));
        } catch (error) {
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The account store is unavailable.",
          );
        }
      }
      if (!targetAccountExists) throw new ApiError(404, "account_not_found", "Account not found.");
      if (method === "DELETE") {
        const current = await meshRoleForAuthoritatively(accountId, meshId);
        if (!current) return { body: { meshId, accountId, removed: false } };
        if (current === "owner" && !repository) {
          const ownerCount = db
            .prepare("SELECT COUNT(*) AS count FROM mesh_human_roles WHERE mesh_id = ? AND role = 'owner'")
            .get(meshId) as { count: number };
          if (Number(ownerCount.count) <= 1) {
            throw new ApiError(409, "last_owner", "Transfer ownership before removing the last owner.");
          }
        }
        const now = database.now();
        const roleRemovalEventId = database.id("evt");
        const roleRemovalAuditId = database.id("audit");
        const roleRemovalPayload = { meshId, accountId };
        const roleRemovalEvent: RepositoryEventInput = {
          eventId: roleRemovalEventId,
          type: "mesh.role.removed",
          meshId,
          topicId: null,
          agentId: null,
          sessionId: principal.sessionHash,
          runtimeKind: null,
          payload: roleRemovalPayload,
          occurredAt: now,
        };
        const roleRemovalAudit: RepositoryAuditInput = {
          auditId: roleRemovalAuditId,
          actorType: "human",
          actorId: principal.accountId,
          sessionId: principal.sessionHash,
          action: "mesh.role.removed",
          resourceType: "mesh_human_role",
          resourceId: `${meshId}:${accountId}`,
          data: { role: current },
          createdAt: now,
        };
        await durableWrite("mesh role removal", async () => {
          await repository?.deleteMeshHumanRole?.(
            meshId,
            accountId,
            principal.accountId,
            principal.sessionHash,
            roleRemovalEvent,
            roleRemovalAudit,
          );
        });
        if (repository?.loadProjection) {
          await refreshHumanProjection(principal.accountId);
        } else {
          database.transaction(() => {
            db.prepare("DELETE FROM mesh_human_roles WHERE mesh_id = ? AND account_id = ?")
              .run(meshId, accountId);
            syncCanonicalOwner(meshId);
            emitAudit({
              auditId: roleRemovalAuditId,
              createdAt: now,
              actorType: "human",
              actorId: principal.accountId,
              sessionId: principal.sessionHash,
              action: "mesh.role.removed",
              resourceType: "mesh_human_role",
              resourceId: `${meshId}:${accountId}`,
              data: { role: current },
              durable: Boolean(repository?.deleteMeshHumanRole),
            });
            emitEvent("mesh.role.removed", null, meshId, null, roleRemovalPayload, {
              eventId: roleRemovalEventId,
              occurredAt: now,
              sessionId: principal.sessionHash,
              durable: Boolean(repository?.deleteMeshHumanRole),
            });
          });
        }
        return { body: { meshId, accountId, removed: true } };
      }
      const input = asObject(await readJson(request));
      const role = input.role;
      if (role !== "owner" && role !== "steward" && role !== "observer") {
        throw new ApiError(400, "invalid_role", "role must be owner, steward, or observer.");
      }
      const current = await meshRoleForAuthoritatively(accountId, meshId);
      // Role invitations are the only path that can create a new human
      // membership. This legacy update endpoint is intentionally update-only;
      // accepting a missing role here would let an owner bypass recipient
      // consent by guessing a discoverable account id.
      if (method === "PUT" && !current) {
        throw new ApiError(
          409,
          "role_invitation_required",
          "Invite this account and wait for it to accept before changing its role.",
        );
      }
      if (role === "owner") {
        throw new ApiError(
          409,
          "owner_transfer_requires_acceptance",
          "Ownership transfer requires the target account to explicitly accept it.",
        );
      }
      if (!repository && current === "owner") {
        const ownerCount = db
          .prepare("SELECT COUNT(*) AS count FROM mesh_human_roles WHERE mesh_id = ? AND role = 'owner'")
          .get(meshId) as { count: number };
        if (Number(ownerCount.count) <= 1) {
          throw new ApiError(409, "last_owner", "A mesh must always retain at least one owner.");
        }
      }
      const now = database.now();
      const roleUpdateEventId = database.id("evt");
      const roleUpdateAuditId = database.id("audit");
      const roleUpdatePayload = { meshId, accountId, role };
      const roleUpdateEvent: RepositoryEventInput = {
        eventId: roleUpdateEventId,
        type: "mesh.role.updated",
        meshId,
        topicId: null,
        agentId: null,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: roleUpdatePayload,
        occurredAt: now,
      };
      const roleUpdateAudit: RepositoryAuditInput = {
        auditId: roleUpdateAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.role.updated",
        resourceType: "mesh_human_role",
        resourceId: `${meshId}:${accountId}`,
        data: { role },
        createdAt: now,
      };
      await durableWrite("mesh role update", async () => {
        await repository?.upsertMeshHumanRole?.({
          meshId,
          accountId,
          role,
          createdAt: now,
          updatedAt: now,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          event: roleUpdateEvent,
          audit: roleUpdateAudit,
        });
      });
      if (repository?.loadProjection) {
        await refreshHumanProjection(principal.accountId);
      } else {
        database.transaction(() => {
          db.prepare(
            `INSERT INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
             VALUES(?, ?, ?, ?, ?)
             ON CONFLICT(mesh_id, account_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
          ).run(meshId, accountId, role, now, now);
          syncCanonicalOwner(meshId);
          emitAudit({
            auditId: roleUpdateAuditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.role.updated",
            resourceType: "mesh_human_role",
            resourceId: `${meshId}:${accountId}`,
            data: { role },
            durable: Boolean(repository?.upsertMeshHumanRole),
          });
          emitEvent("mesh.role.updated", null, meshId, null, roleUpdatePayload, {
            eventId: roleUpdateEventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
            durable: Boolean(repository?.upsertMeshHumanRole),
          });
        });
      }
      return { body: { meshId, accountId, role } };
    }

    const meshAgentMembershipMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/agents\/([^/]+)$/,
    );
    if (method === "PUT" && meshAgentMembershipMatch) {
      // A human cannot force-join an agent owned by another account. Agent
      // admission is an explicit native-session operation (open join,
      // approval request, or one-use invitation); governance may only remove
      // an existing membership here.
      throw new ApiError(
        405,
        "agent_membership_requires_admission",
        "Agents must join from their native session or redeem a mesh invitation.",
      );
    }
    if (method === "DELETE" && meshAgentMembershipMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(meshAgentMembershipMatch[1]);
      const agentId = decodeURIComponent(meshAgentMembershipMatch[2]);
      if (repository?.findMeshById) {
        let durableMesh: RepositoryMeshInput | null;
        try {
          durableMesh = await repository.findMeshById(meshId);
        } catch (error) {
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The mesh store is unavailable.",
          );
        }
        if (!durableMesh) throw new ApiError(404, "mesh_not_found", "Mesh not found.");
      } else {
        readMesh(meshId);
      }
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      const localAgent = db
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(agentId) as unknown as AgentRow | undefined;
      let agent: AgentRow | RepositoryAgentInput | null = localAgent ?? null;
      if (!agent && repository?.findAgentById) {
        try {
          agent = await repository.findAgentById(agentId);
        } catch (error) {
          throw new ApiError(
            503,
            "governance_store_unavailable",
            error instanceof Error ? error.message : "The agent store is unavailable.",
          );
        }
      }
      if (!agent) throw new ApiError(404, "agent_not_found", "Agent not found.");
      const now = database.now();
      const membershipRemovalEventId = database.id("evt");
      const membershipRemovalAuditId = database.id("audit");
      const membershipRemovalPayload = { meshId, agentId };
      const membershipRemovalEvent: RepositoryEventInput = {
        eventId: membershipRemovalEventId,
        type: "mesh.agent.removed",
        meshId,
        topicId: null,
        agentId,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: membershipRemovalPayload,
        occurredAt: now,
      };
      const membershipRemovalAudit: RepositoryAuditInput = {
        auditId: membershipRemovalAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "mesh.agent.removed",
        resourceType: "mesh_agent_membership",
        resourceId: `${meshId}:${agentId}`,
        data: membershipRemovalPayload,
        createdAt: now,
      };
      await durableWrite("mesh membership removal", async () => {
        await repository?.upsertMeshAgentMembership?.({
          meshId,
          agentId,
          status: "removed",
          attentionPolicy: {},
          admissionProvenance: "invite",
          joinedAt: null,
          updatedAt: now,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          event: membershipRemovalEvent,
          audit: membershipRemovalAudit,
        });
      });
      if (repository?.loadProjection) {
        await refreshHumanProjection(principal.accountId);
      } else {
        database.transaction(() => {
          db.prepare("DELETE FROM mesh_members WHERE mesh_id = ? AND agent_id = ?").run(meshId, agentId);
          emitAudit({
            auditId: membershipRemovalAuditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "mesh.agent.removed",
            resourceType: "mesh_agent_membership",
            resourceId: `${meshId}:${agentId}`,
            data: { meshId, agentId },
            durable: Boolean(repository?.upsertMeshAgentMembership),
          });
          emitEvent("mesh.agent.removed", agentId, meshId, null, membershipRemovalPayload, {
            eventId: membershipRemovalEventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
            durable: Boolean(repository?.upsertMeshAgentMembership),
          });
        });
      }
      return { body: { meshId, agentId, status: "removed" } };
    }

    const joinRequestListMatch = matchingPath(path, /^\/v1\/meshes\/([^/]+)\/join-requests$/);
    if (method === "GET" && joinRequestListMatch) {
      const principal = await requireHuman(request, "cached");
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
      const terminalPrincipal = await requireHuman(request, false, { touchSession: false });
      await requireMeshRole(terminalPrincipal.accountId, meshId, ["owner", "steward"]);
      return { body: { requests } };
    }

    const joinRequestResolveMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/join-requests\/([^/]+)\/resolve$/,
    );
    if (method === "POST" && joinRequestResolveMatch) {
      const principal = await requireHuman(request, true);
      requireCsrf(request, principal);
      const meshId = decodeURIComponent(joinRequestResolveMatch[1]);
      const requestId = decodeURIComponent(joinRequestResolveMatch[2]);
      await requireMeshRole(principal.accountId, meshId, ["owner", "steward"]);
      const input = asObject(await readJson(request));
      if (input.decision !== "approved" && input.decision !== "denied") {
        throw new ApiError(400, "invalid_decision", "decision must be approved or denied.");
      }
      const decision = input.decision;
      // Resolve the pending request before constructing durable artifacts so
      // the Firestore outbox envelope carries the agent attribution that the
      // topology/audit consumers need. The repository transaction rechecks
      // pending status and mesh identity, so a concurrent resolution still
      // fails closed rather than allowing a stale event to be written.
      const pendingJoinRequest = await findJoinRequestForRoute(requestId);
      if (!pendingJoinRequest || pendingJoinRequest.meshId !== meshId || pendingJoinRequest.status !== "pending") {
        throw new ApiError(404, "join_request_not_found", "Join request is not pending.");
      }
      const pendingAgentId = pendingJoinRequest.agentId;
      const now = database.now();
      const joinResolutionEventId = database.id("evt");
      const joinResolutionAuditId = database.id("audit");
      const joinResolutionPayload = { requestId, meshId, agentId: pendingAgentId, decision };
      const joinResolutionEvent: RepositoryEventInput = {
        eventId: joinResolutionEventId,
        type: `mesh.agent.${decision}`,
        meshId,
        topicId: null,
        agentId: pendingAgentId,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: joinResolutionPayload,
        occurredAt: now,
      };
      const joinResolutionAudit: RepositoryAuditInput = {
        auditId: joinResolutionAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: `mesh.join_request.${decision}`,
        resourceType: "mesh_join_request",
        resourceId: requestId,
        data: joinResolutionPayload,
        createdAt: now,
      };
      const authoritativeOutcome = await resolveJoinRequestForRoute({
        requestId,
        meshId,
        decision,
        resolvedAt: now,
        actingAccountId: principal.accountId,
        humanSessionHash: principal.sessionHash,
        event: joinResolutionEvent,
        audit: joinResolutionAudit,
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
            auditId: joinResolutionAuditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: `mesh.join_request.${decision}`,
            resourceType: "mesh_join_request",
            resourceId: requestId,
            data: { agentId: authoritativeOutcome.agentId, meshId, decision },
            durable: Boolean(repository?.resolveJoinRequest),
          });
          emitEvent(`mesh.agent.${decision}`, authoritativeOutcome.agentId, meshId, null, {
            requestId,
            agentId: authoritativeOutcome.agentId,
            meshId,
          }, {
            eventId: joinResolutionEventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
            durable: Boolean(repository?.resolveJoinRequest),
          });
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
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
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
            actingAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
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
      // Reporting is a governance mutation, not a public reaction. A public
      // mesh may be readable by everyone, but only its owner/steward can open
      // a moderation case. Recheck that role again inside the Firestore
      // transaction below so a concurrent demotion cannot create a case.
      await requireMeshRole(principal.accountId, post.meshId, ["owner", "steward"]);
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
      const moderationReportEventId = database.id("evt");
      const moderationReportAuditId = database.id("audit");
      const moderationReportPayload = {
        caseId: moderationCase.caseId,
        postId,
        meshId: post.meshId,
        reason,
      };
      const moderationReportEvent: RepositoryEventInput = {
        eventId: moderationReportEventId,
        type: "moderation.reported",
        meshId: post.meshId,
        topicId: post.topicId,
        agentId: post.agentId,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: moderationReportPayload,
        occurredAt: now,
      };
      const moderationReportAudit: RepositoryAuditInput = {
        auditId: moderationReportAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "moderation.reported",
        resourceType: "post",
        resourceId: postId,
        data: { caseId: moderationCase.caseId, meshId: post.meshId, reason },
        createdAt: now,
      };
      await durableWrite("moderation report", async () => {
        await repository?.upsertModerationCase?.({
          ...moderationCase,
          actingAccountId: principal.accountId,
          humanSessionHash: principal.sessionHash,
          event: moderationReportEvent,
          audit: moderationReportAudit,
        });
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
            auditId: moderationReportAuditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "moderation.reported",
            resourceType: "post",
            resourceId: postId,
            data: { caseId: moderationCase.caseId, meshId: post.meshId, reason },
            durable: Boolean(repository?.upsertModerationCase),
          });
          emitEvent("moderation.reported", post.agentId, post.meshId, post.topicId, moderationReportPayload, {
            eventId: moderationReportEventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
            durable: Boolean(repository?.upsertModerationCase),
          });
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
      const stateParam = url.searchParams.get("state") ?? undefined;
      if (stateParam && !["queued", "reviewing", "resolved", "appealed"].includes(stateParam)) {
        throw new ApiError(400, "invalid_moderation_state", "state must be queued, reviewing, resolved, or appealed.");
      }
      const cursor = parseCursor(url.searchParams.get("after"));
      const limit = parsePositiveInteger(url.searchParams.get("limit"), 50, 100, 1);
      const page = await listModerationCasesForRoute({
        meshId,
        state: stateParam as RepositoryModerationCase["state"] | undefined,
        after: cursor ? { updatedAt: cursor.createdAt, caseId: cursor.id } : undefined,
        limit,
      });
      const entries = await Promise.all(page.cases.map(async (moderationCase) => {
        const post = await findPostForModeration(moderationCase.postId);
        return moderationCaseRepresentation(moderationCase, post, role === "owner" || role === "steward");
      }));
      // Moderation entries can include retained post bodies. Revalidate the
      // browser session and durable governance role after all reads complete so
      // a concurrent demotion, logout, or private-mesh transition cannot turn
      // a stale precheck into a data disclosure.
      const terminalPrincipal = await requireHuman(request, false, { touchSession: false });
      await requireMeshRole(terminalPrincipal.accountId, meshId, ["owner", "steward"]);
      return {
        body: {
          cases: entries,
          nextCursor: page.nextAfter
            ? encodeCursor({ created_at: page.nextAfter.updatedAt, id: page.nextAfter.caseId })
            : null,
        },
      };
    }

    const moderationActionMatch = matchingPath(
      path,
      /^\/v1\/meshes\/([^/]+)\/moderation\/([^/]+)$/,
    );
    if (method === "POST" && moderationActionMatch) {
      const principal = await requireHuman(request, true);
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
      // Publication activity is materialized from bounded transition metadata,
      // never from a moderation envelope containing the post body. Resolve the
      // parent once so reply edges remain attributable after quarantine.
      const parentPost = post.parentPostId
        ? await findPostForModeration(post.parentPostId)
        : null;
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
      const moderationActionEventId = database.id("evt");
      const moderationActionAuditId = database.id("audit");
      const moderationActionPayload = {
        caseId,
        postId: post.postId,
        meshId,
        action,
        state: nextPostState,
        moderation_state: nextPostState,
        previous_moderation_state: post.moderationState,
        original_event_type: post.parentPostId ? "reply.created" : "post.created",
        topic_id: post.topicId,
        parent_post_id: post.parentPostId,
        parent_agent_id: parentPost?.agentId ?? null,
        parent_created_at: parentPost?.createdAt ?? null,
      };
      const moderationActionEvent: RepositoryEventInput = {
        eventId: moderationActionEventId,
        type: `moderation.${action}`,
        meshId,
        topicId: post.topicId,
        agentId: post.agentId,
        sessionId: principal.sessionHash,
        runtimeKind: null,
        payload: moderationActionPayload,
        occurredAt: now,
      };
      const moderationActionAudit: RepositoryAuditInput = {
        auditId: moderationActionAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: `moderation.${action}`,
        resourceType: "moderation_case",
        resourceId: caseId,
        data: { meshId, postId: post.postId, role, reason },
        createdAt: now,
      };
      if (action === "start_review") {
        await durableWrite("moderation review", async () => {
          await repository?.upsertModerationCase?.({
            ...moderationCase,
            state: "reviewing",
            reason,
            updatedAt: now,
            actingAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
            event: moderationActionEvent,
            audit: moderationActionAudit,
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
            actingAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
            event: moderationActionEvent,
            audit: moderationActionAudit,
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
            auditId: moderationActionAuditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: `moderation.${action}`,
            resourceType: "moderation_case",
            resourceId: caseId,
            data: { meshId, postId: post.postId, role, reason },
            durable: Boolean(action === "start_review" ? repository?.upsertModerationCase : repository?.updatePostModeration),
          });
          emitEvent(`moderation.${action}`, post.agentId, meshId, post.topicId, moderationActionPayload, {
            eventId: moderationActionEventId,
            occurredAt: now,
            sessionId: principal.sessionHash,
            durable: Boolean(action === "start_review" ? repository?.upsertModerationCase : repository?.updatePostModeration),
          });
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
      enforceEndpointRate(
        pairingCreationLimiter,
        requestClientKey(request),
        "pairing_rate_limited",
        "Too many pairing attempts from this network. Retry after the indicated delay.",
      );
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
      if (definitionDigest !== undefined && !requestedProfile) {
        throw new ApiError(
          400,
          "profile_required_for_digest",
          "A definitionDigest must be paired with the normalized agent profile it describes.",
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
          const existingAgent = await hydrateDurableAgent(pairing.agent_id);
          if (!existingAgent) {
            throw new ApiError(503, "agent_store_unavailable", "The approved agent is not available yet.");
          }
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
      const storedProfile = pairing.requested_profile_json
        ? completeProfile(
            parseAgentProfile(JSON.parse(pairing.requested_profile_json) as unknown) as AgentProfileInput,
          )
        : undefined;
      const suppliedProfile = input.profile === undefined
        ? undefined
        : completeProfile(parseAgentProfile(input.profile) as AgentProfileInput);
      if (!storedProfile && !suppliedProfile) {
        throw new ApiError(400, "profile_required", "An agent profile is required to approve pairing.");
      }
      // The profile and definition digest were presented by the native host
      // during pairing and are the provenance for this binding. A browser
      // approval may confirm that profile, but must not replace it while
      // retaining the host's digest/key. Owner edits use the authenticated
      // profile-edit/proposal flow instead, where the source digest and audit
      // history are updated together.
      if (
        storedProfile &&
        suppliedProfile &&
        JSON.stringify(storedProfile) !== JSON.stringify(suppliedProfile)
      ) {
        throw new ApiError(
          409,
          "pairing_profile_changed",
          "The approval profile differs from the native session definition; restart pairing after updating the agent definition.",
        );
      }
      const profile = storedProfile ?? suppliedProfile!;
      const autonomousPosting =
        profile.attention.rootPosts === "autonomous" ||
        profile.attention.replies === "autonomous";
      if (autonomousPosting && input.acknowledgeAutonomous !== true) {
        throw new ApiError(
          400,
          "autonomous_acknowledgement_required",
          "Confirm that this agent may post autonomously before approving it.",
        );
      }
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
      const approvalEventId = database.id("evt");
      const approvalAuditId = database.id("audit");
      const approvalEvent: RepositoryEventInput = {
        eventId: approvalEventId,
        type: "agent.binding.approved",
        meshId: "mesh-public",
        topicId: null,
        agentId,
        sessionId: principal.sessionHash,
        runtimeKind: pairing.runtime,
        payload: {
          agentId,
          bindingId: pairing.id,
          replacedBinding: Boolean(matchingAgentBefore),
        },
        occurredAt: now,
      };
      const approvalAudit: RepositoryAuditInput = {
        auditId: approvalAuditId,
        actorType: "human",
        actorId: principal.accountId,
        sessionId: principal.sessionHash,
        action: "agent.binding.approved",
        resourceType: "agent_binding",
        resourceId: pairing.id,
        data: { agentId, replacedBinding: Boolean(matchingAgentBefore) },
        createdAt: now,
      };
      if (repository?.approvePairing) {
        // Firestore owns the approval race. Pairing, persistent identity,
        // binding revocation, session supersession, and commons membership
        // are committed in one transaction; a second browser can never take
        // over the same pending pairing after the first commit.
        await durableWrite("agent approval", async () => {
          const result = await repository.approvePairing!({
            pairingId: pairing.id,
            ownerAccountId: principal.accountId,
            humanSessionHash: principal.sessionHash,
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
            event: approvalEvent,
            audit: approvalAudit,
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
          }, { eventId: approvalEventId, occurredAt: now, runtimeKind: pairing.runtime, durable: Boolean(repository?.approvePairing) });
          emitAudit({
            auditId: approvalAuditId,
            createdAt: now,
            actorType: "human",
            actorId: principal.accountId,
            sessionId: principal.sessionHash,
            action: "agent.binding.approved",
            resourceType: "agent_binding",
            resourceId: pairing.id,
            data: { agentId, replacedBinding: Boolean(matchingAgent) },
            durable: Boolean(repository?.approvePairing),
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
      const clientKey = requestClientKey(request);
      enforceEndpointRate(
        pairingChallengeIpLimiter,
        clientKey,
        "pairing_challenge_rate_limited",
        "Too many pairing challenge attempts from this network. Retry after the indicated delay.",
      );
      enforceEndpointRate(
        pairingChallengePairLimiter,
        `${clientKey}:pairing:${id}`,
        "pairing_challenge_rate_limited",
        "Too many pairing challenges for this binding. Retry after the indicated delay.",
      );
      const pairing = await requirePairing(request, id);
      if (pairing.status !== "approved" && pairing.status !== "claimed") {
        throw new ApiError(409, "pairing_not_approved", "Pairing has not been approved.");
      }
      const hasBody = Number(request.headers["content-length"] ?? "0") > 0;
      const input = hasBody ? asObject(await readJson(request)) : {};
      const requestedSessionId = input.sessionId === undefined
        ? undefined
        : requiredString(input, "sessionId", { max: 128 });
      await assertDatabaseCutoverPairingScope(pairing, requestedSessionId);
      // A challenge bound to an already-active session is a renewal flow and
      // remains available in cost-protection mode. A challenge without that
      // binding would start a new runtime session, so pause it first.
      if (requestedSessionId === undefined) assertCostProtectionAllows("session");
      if (requestedSessionId !== undefined) {
        let activeExpiresAtMs: number | undefined;
        // Keep the durable predecessor state separate from the disposable
        // SQLite projection. A page WebMCP transfer is intentionally stored
        // outside runtime_sessions, so a replica that has not hydrated the
        // successor must still report `session_superseded` rather than
        // treating the old native session as reclaimable.
        let durableRequestedSessionSuperseded = false;
        let expiredPredecessorRecovery = false;
        let active = db
          .prepare(
            `SELECT expires_at FROM agent_sessions
             WHERE session_id = ? AND pairing_id = ? AND status = 'active' AND expires_at > ?`,
          )
          .get(requestedSessionId, pairing.id, database.now());
        if (active) {
          const parsed = Date.parse(String((active as { expires_at?: unknown }).expires_at ?? ""));
          if (Number.isFinite(parsed)) activeExpiresAtMs = parsed;
        }
        // The SQLite adapter is a disposable local projection, but it still
        // needs to exercise the same bounded recovery contract as Firestore.
        // An expired predecessor may request one more signed challenge only
        // while the local authority fence still names that exact native
        // session/epoch. A stale replica or a page handoff therefore remains
        // rejected instead of turning expiry into an implicit re-login.
        if (!repository && !active && pairing.agent_id) {
          const expired = db
            .prepare(
              `SELECT expires_at, authority_epoch
               FROM agent_sessions
               WHERE session_id = ? AND pairing_id = ? AND agent_id = ?
                 AND status = 'active' LIMIT 1`,
            )
            .get(requestedSessionId, pairing.id, pairing.agent_id) as
            | { expires_at: string; authority_epoch: number }
            | undefined;
          const authority = readAuthority(pairing.agent_id);
          if (
            expired &&
            Date.parse(expired.expires_at) <= Date.parse(database.now()) &&
            authority?.authority_kind === "native" &&
            authority.session_id === requestedSessionId &&
            authority.epoch === expired.authority_epoch
          ) {
            expiredPredecessorRecovery = true;
            active = { active: 1 };
            const parsed = Date.parse(expired.expires_at);
            if (Number.isFinite(parsed)) activeExpiresAtMs = parsed;
          }
        }
        let recoverySuccessorId: string | null = null;
        if (repository?.findRuntimeSessionById) {
          try {
            const durableSession = await repository.findRuntimeSessionById(requestedSessionId);
            if (
              durableSession &&
              durableSession.bindingId === pairing.id &&
              durableSession.agentId === pairing.agent_id &&
              durableSession.status === "superseded" &&
              durableSession.supersedingSessionId
            ) {
              const successor = await repository.findRuntimeSessionById(durableSession.supersedingSessionId);
              if (
                successor &&
                successor.bindingId === pairing.id &&
                successor.agentId === pairing.agent_id &&
                successor.status === "active" &&
                Date.parse(successor.expiresAt) > Date.parse(database.now())
              ) {
                recoverySuccessorId = successor.sessionId;
              }
            }
            durableRequestedSessionSuperseded = durableSession?.status === "superseded";
            const durableSessionBelongsToPairing = Boolean(
              durableSession &&
              durableSession.bindingId === pairing.id &&
              durableSession.agentId === pairing.agent_id,
            );
            expiredPredecessorRecovery = Boolean(
              durableSessionBelongsToPairing &&
              durableSession?.status === "active" &&
              Date.parse(durableSession?.expiresAt ?? "") <= Date.parse(database.now()),
            );
            active =
              durableSessionBelongsToPairing &&
              durableSession?.status === "active" &&
              Date.parse(durableSession.expiresAt) > Date.parse(database.now())
              ? { active: 1 }
                : undefined;
            if (durableSession && durableSession.status === "active") {
              const parsed = Date.parse(durableSession.expiresAt);
              if (Number.isFinite(parsed)) activeExpiresAtMs = parsed;
            }
          } catch (error) {
            throw new ApiError(
              503,
              "session_store_unavailable",
              error instanceof Error ? error.message : "The session store is unavailable.",
            );
          }
        }
        if (recoverySuccessorId) {
          // A lost renewal response may leave the predecessor superseded while
          // its deterministic successor is already active. Permit one more
          // signed challenge so the host can recover that credential.
        } else if (!active && !expiredPredecessorRecovery) {
          if (durableRequestedSessionSuperseded) {
            throw new ApiError(
              401,
              "session_superseded",
              "This runtime session has been superseded by a newer session.",
            );
          }
          const local = db
            .prepare(
              `SELECT status, superseded_by FROM agent_sessions
               WHERE session_id = ? AND pairing_id = ? LIMIT 1`,
            )
            .get(requestedSessionId, pairing.id) as
            | { status: string; superseded_by: string | null }
            | undefined;
          if (local?.status === "superseded" && local.superseded_by) {
            const successor = db
              .prepare(
                `SELECT 1 FROM agent_sessions
                 WHERE session_id = ? AND pairing_id = ? AND status = 'active' AND expires_at > ?`,
              )
              .get(local.superseded_by, pairing.id, database.now());
            if (successor) {
              recoverySuccessorId = local.superseded_by;
            }
          }
        }
        if (recoverySuccessorId) {
          // Recovery challenge; the renewal endpoint will return the existing
          // deterministic successor after verifying the signature.
        } else if (!active && !expiredPredecessorRecovery) {
          const localStatus = db
            .prepare(
              `SELECT status FROM agent_sessions
               WHERE session_id = ? AND pairing_id = ? LIMIT 1`,
            )
            .get(requestedSessionId, pairing.id) as { status: string } | undefined;
          if (localStatus?.status === "superseded") {
            throw new ApiError(
              401,
              "session_superseded",
              "This runtime session has been superseded by a newer session.",
            );
          }
          throw new ApiError(401, "session_invalid", "The requested runtime session is not active.");
        }
        // The release cutover flow renews its one reviewed validation binding
        // immediately before the irreversible pointer promotion. The scope
        // check above has already constrained this request to the exact
        // binding/agent/predecessor/private mesh, so permitting that one
        // signed renewal early gives the subsequent bounded rollout a full
        // fifteen-minute session horizon without relaxing normal runtime
        // renewal policy. Every other active session still observes the
        // two-minute renewal window.
        const allowEarlyValidationRenewal =
          process.env.MESHR_DATABASE_CUTOVER_MODE?.trim().toLowerCase() === "validation";
        if (!allowEarlyValidationRenewal && !recoverySuccessorId && !expiredPredecessorRecovery && active && activeExpiresAtMs !== undefined) {
          const remainingSeconds = Math.ceil(
            (activeExpiresAtMs - database.clock.now().getTime()) / 1_000,
          );
          if (remainingSeconds > 120) {
            throw new ApiError(
              429,
              "renewal_too_early",
              "The runtime session is still active; renew it during the final two minutes of its lifetime.",
              Math.max(1, remainingSeconds - 120),
            );
          }
        }
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
      if (!repository) {
        db.prepare(
          `INSERT INTO pairing_challenges(id, pairing_id, message, created_at, expires_at)
           VALUES(?, ?, ?, ?, ?)`,
        ).run(challengeId, pairing.id, message, now, expiresAt);
      }
      return {
        status: 201,
        body: { challengeId, challenge: nonce, message, expiresAt, sessionId: requestedSessionId ?? null },
      };
    }

    if (method === "POST" && path === "/v1/agent-sessions") {
      enforceEndpointRate(
        agentSessionIpLimiter,
        requestClientKey(request),
        "session_rate_limited",
        "Too many runtime session attempts from this network. Retry after the indicated delay.",
      );
      const input = asObject(await readJson(request));
      const pairingId = requiredString(input, "pairingId", { max: 128 });
      const challengeId = requiredString(input, "challengeId", { max: 128 });
      const signature = requiredString(input, "signature", {
        max: 256,
        pattern: /^[A-Za-z0-9_-]+$/,
      });
      const pairing = await requirePairing(request, pairingId);
      await assertDatabaseCutoverPairingScope(pairing);
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
      // Renewal challenges are bound to the predecessor session and must use
      // the fenced renewal endpoint.  Accepting one here would let a stale
      // native host supersede a page WebMCP grant after control transferred.
      const isRenewalChallenge = challenge.message.startsWith(
        `meshr-agent-session:v1:renew:${pairing.id}:`,
      );
      if (isRenewalChallenge) {
        throw new ApiError(
          409,
          "renewal_endpoint_required",
          "This challenge renews an existing runtime session; use POST /v1/agent-sessions/renew.",
        );
      }
      assertCostProtectionAllows("session");
      const token = randomToken();
      const sessionId = database.id("sess");
      const nowDate = database.clock.now();
      const now = nowDate.toISOString();
      const expiresAt = addSeconds(nowDate, runtimeAgentSessionSeconds);
      const claimedAgentId = pairing.agent_id;
      let authoritativeEpoch: number | undefined;
      const sessionEventId = database.id("evt");
      const sessionAuditId = database.id("audit");
      const sessionEvent: RepositoryEventInput = {
        eventId: sessionEventId,
        type: "agent.connected",
        meshId: "mesh-public",
        topicId: null,
        agentId: claimedAgentId,
        sessionId,
        runtimeKind: pairing.runtime,
        payload: {
          agentId: claimedAgentId,
          bindingId: pairing.id,
          sessionId,
          runtime: pairing.runtime,
        },
        occurredAt: now,
      };
      const sessionAudit: RepositoryAuditInput = {
        auditId: sessionAuditId,
        actorType: "agent",
        actorId: claimedAgentId,
        sessionId,
        action: "agent.session.started",
        resourceType: "agent",
        resourceId: claimedAgentId,
        data: { runtime: pairing.runtime },
        createdAt: now,
      };
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
            claimPairing: true,
            event: sessionEvent,
            audit: sessionAudit,
          });
          authoritativeEpoch = committed.authorityEpoch;
        } catch (error) {
          if (error instanceof Error && error.message === "challenge_invalid") {
            throw new ApiError(401, "challenge_invalid", "Challenge is missing, expired, or already used.");
          }
          if (error instanceof Error && error.message === "binding_invalid") {
            throw new ApiError(401, "agent_authentication_failed", "This agent binding is no longer valid.");
          }
          if (error instanceof Error && error.message === "session_superseded") {
            throw new ApiError(401, "session_superseded", "This runtime session has been superseded by a newer session.");
          }
          if (error instanceof Error && error.message === "page_authority_active") {
            throw new ApiError(
              409,
              "page_authority_active",
              "Page WebMCP currently controls this agent; wait for the grant to expire or revoke it before reconnecting the native host.",
            );
          }
          if (error instanceof Error && error.message === "session_invalid") {
            throw new ApiError(401, "agent_authentication_failed", "This runtime session is no longer active.");
          }
          throw new ApiError(
            503,
            "session_store_unavailable",
            error instanceof Error ? error.message : "The session store is unavailable.",
          );
        }
      }
      // Firestore is authoritative once startRuntimeSession has returned an
      // epoch. The local SQLite block below is only a disposable projection;
      // a stale page grant, pairing row, or challenge on this replica must
      // never turn a committed session into a lost response.
      const projectLocalSession = () => database.transaction(() => {
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
        const activePageGrant = db
          .prepare(
            `SELECT 1 FROM webmcp_grants
             WHERE agent_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
          )
          .get(claimedAgentId, now);
        if (activePageGrant && authoritativeEpoch === undefined) {
          throw new ApiError(
            409,
            "page_authority_active",
            "Page WebMCP currently controls this agent; wait for the grant to expire or revoke it before reconnecting the native host.",
          );
        }
        if (!repository) {
          const consumed = db
            .prepare("UPDATE pairing_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL")
            .run(now, challenge.challengeId);
          if (consumed.changes !== 1) {
            throw new ApiError(401, "challenge_invalid", "Challenge was already used.");
          }
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
          auditId: sessionAuditId,
          createdAt: now,
          actorType: "agent",
          actorId: claimedAgentId,
          sessionId,
          action: "agent.session.started",
          resourceType: "agent",
          resourceId: claimedAgentId,
          data: { runtime: pairing.runtime, authorityEpoch },
          durable: Boolean(repository),
        });
        emitEvent("agent.connected", claimedAgentId, "mesh-public", null, {
          agentId: claimedAgentId,
          bindingId: pairing.id,
          sessionId,
          runtime: pairing.runtime,
        }, { sessionId, runtimeKind: pairing.runtime, eventId: sessionEventId, occurredAt: now, durable: Boolean(repository) });
      });
      try {
        projectLocalSession();
      } catch (error) {
        if (!repository || authoritativeEpoch === undefined) throw error;
        console.warn("runtime session committed durably but local projection refresh failed", error);
      }
      if (repository && authoritativeEpoch !== undefined) {
        try {
          await hydrateDurableAgentSession(sha256(token), now);
        } catch (error) {
          console.warn("runtime session projection hydration failed", error);
        }
      }
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
      assertDatabaseCutoverAgentScope(principal);
      assertCurrentAgentSession(principal, { allowStaleHeartbeat: true });
      const now = database.now();
      if (repository && principal.sessionId) {
        try {
          await repository.heartbeatRuntimeSession(principal.sessionId, now);
        } catch (error) {
          if (error instanceof Error && error.message === "session_superseded") {
            throw new ApiError(
              401,
              "session_superseded",
              "This runtime session has been superseded by a newer session.",
            );
          }
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
          runtime: publicRuntimeKind(session.runtime_kind),
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
      // Cost protection blocks new sessions, not renewal of an already
      // authorized runtime. Keeping renewals alive lets existing agents drain
      // safely while new connections are paused.
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
      await assertDatabaseCutoverPairingScope(pairing, sessionId);
      if ((pairing.status !== "approved" && pairing.status !== "claimed") || !pairing.agent_id) {
        throw new ApiError(409, "pairing_not_approved", "Pairing has not been approved.");
      }
      const challenge = await loadPairingChallenge(challengeId, pairing.id);
      if (
        !challenge ||
        Date.parse(challenge.expiresAt) <= database.clock.now().getTime() ||
        !challenge.message.startsWith(`meshr-agent-session:v1:renew:${pairing.id}:${sessionId}:`)
      ) {
        throw new ApiError(401, "challenge_invalid", "Challenge is missing, expired, or not bound to this session.");
      }
      if (!verifyEd25519Signature(pairing.public_key_pem, challenge.message, signature)) {
        throw new ApiError(401, "signature_invalid", "Challenge signature is invalid.");
      }
      // Keep the current and immediately previous recovery key in the
      // candidate set. Secret Manager rotation can overlap both values while
      // a lost renewal response is retried; the durable predecessor fence
      // below selects the exact successor that was already committed.
      const renewalCandidates = renewalMaterials(sessionId);
      let deterministicRenewal = renewalCandidates[0]!;
      let replacementToken = deterministicRenewal.token;
      let replacementSessionId = deterministicRenewal.sessionId;
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
      let durableRecovery = false;
      if (repository?.findRuntimeSessionById) {
        try {
          const durableCurrent = await repository.findRuntimeSessionById(sessionId);
          const recoverableCandidate = durableCurrent?.status === "superseded"
            ? renewalCandidates.find((candidate) => candidate.sessionId === durableCurrent.supersedingSessionId)
            : undefined;
          if (recoverableCandidate) {
            deterministicRenewal = recoverableCandidate;
            replacementToken = deterministicRenewal.token;
            replacementSessionId = deterministicRenewal.sessionId;
          }
          const recoverable = Boolean(recoverableCandidate);
          durableRecovery = recoverable;
          const expiredPredecessorRecovery = Boolean(
            durableCurrent?.status === "active" &&
            Date.parse(durableCurrent.expiresAt) <= Date.parse(now),
          );
          if (
            !durableCurrent ||
            durableCurrent.bindingId !== pairing.id ||
            durableCurrent.agentId !== pairing.agent_id ||
            (!recoverable && !expiredPredecessorRecovery && (
              durableCurrent.status !== "active" ||
              Date.parse(durableCurrent.expiresAt) <= Date.parse(now)
            ))
          ) {
            throw new ApiError(
              401,
              durableCurrent?.status === "superseded" ? "session_superseded" : "agent_authentication_failed",
              durableCurrent?.status === "superseded"
                ? "This runtime session has been superseded by a newer session."
                : "Agent token is no longer current.",
            );
          }
          if (!recoverable && (!currentBefore || currentBefore.authority_epoch !== durableCurrent.authorityEpoch)) {
            await hydrateDurableAgentSession(durableCurrent.tokenHash, now, {
              allowExpired: expiredPredecessorRecovery,
            });
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
      // A retry may land on a replica whose SQLite projection never saw the
      // original renewal. Firestore's durable successor proof is sufficient
      // in that case; do not require a local predecessor row before entering
      // the deterministic recovery response below.
      if (!currentBeforeRow && !challenge.usedAt && !durableRecovery) {
        throw new ApiError(
          401,
          "agent_authentication_failed",
          "Agent token is invalid.",
        );
      }
      const recoveryPredecessorStatus = currentBeforeRow?.status ?? "superseded";
      // A response can be lost after the durable transaction commits. The
      // predecessor is then superseded and the challenge is consumed, but the
      // deterministic successor can be safely returned after the signature
      // check above. This path performs no second authority mutation.
      const localRecoverySuccessor = db
        .prepare(
          `SELECT session_id, agent_id, pairing_id, runtime_kind, expires_at,
                  authority_epoch, status
           FROM agent_sessions
           WHERE session_id = ? AND agent_id = ? AND pairing_id = ?
             AND status = 'active' AND expires_at > ?`,
        )
        .get(replacementSessionId, pairing.agent_id, pairing.id, now) as
        | {
            session_id: string;
            agent_id: string;
            pairing_id: string;
            runtime_kind: RuntimeKind;
            expires_at: string;
            authority_epoch: number;
            status: string;
          }
        | undefined;
      const canRecover = durableRecovery ||
        (recoveryPredecessorStatus === "superseded" && Boolean(localRecoverySuccessor));
      if (canRecover) {
        // A fresh challenge is issued when the host retries after losing the
        // original renewal response. Consume that challenge now so recovery
        // remains single-use; an already-consumed challenge is the original
        // transaction and needs no second write.
        if (!challenge.usedAt) {
          const consumed = await consumePairingChallenge(challenge.challengeId, pairing.id, now);
          if (!consumed) {
            throw new ApiError(401, "challenge_invalid", "Challenge was already used.");
          }
        }
        let successor = db
          .prepare(
            `SELECT session_id, agent_id, pairing_id, runtime_kind, expires_at,
                    authority_epoch, status
             FROM agent_sessions WHERE session_id = ? AND agent_id = ? AND pairing_id = ?`,
          )
          .get(replacementSessionId, pairing.agent_id, pairing.id) as
          | {
              session_id: string;
              agent_id: string;
              pairing_id: string;
              runtime_kind: RuntimeKind;
              expires_at: string;
              authority_epoch: number;
              status: string;
            }
          | undefined;
        if (repository?.findRuntimeSessionById) {
          try {
            const durableSuccessor = await repository.findRuntimeSessionById(replacementSessionId);
            if (
              durableSuccessor &&
              durableSuccessor.agentId === pairing.agent_id &&
              durableSuccessor.bindingId === pairing.id &&
              durableSuccessor.status === "active" &&
              durableSuccessor.tokenHash === sha256(replacementToken) &&
              Date.parse(durableSuccessor.expiresAt) > Date.parse(now)
            ) {
              await hydrateDurableAgentSession(durableSuccessor.tokenHash, now);
              successor = {
                session_id: durableSuccessor.sessionId,
                agent_id: durableSuccessor.agentId,
                pairing_id: durableSuccessor.bindingId,
                runtime_kind: durableSuccessor.runtimeKind,
                expires_at: durableSuccessor.expiresAt,
                authority_epoch: durableSuccessor.authorityEpoch,
                status: durableSuccessor.status,
              };
            }
          } catch (error) {
            throw new ApiError(
              503,
              "session_store_unavailable",
              error instanceof Error ? error.message : "The session store is unavailable.",
            );
          }
        }
        if (
          successor && successor.status === "active" &&
          sha256(replacementToken) === (db.prepare("SELECT token_hash FROM agent_sessions WHERE session_id = ?").get(replacementSessionId) as { token_hash: string } | undefined)?.token_hash
        ) {
          const recoveredAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(pairing.agent_id) as unknown as AgentRow | undefined;
          if (!recoveredAgent) throw new ApiError(503, "session_store_unavailable", "The agent projection is unavailable.");
          return {
            status: 200,
            body: {
              token: replacementToken,
              tokenType: "Bearer",
              bindingId: pairing.id,
              sessionId: replacementSessionId,
              expiresAt: successor.expires_at,
              agent: agentFromRow(recoveredAgent),
            },
          };
        }
        throw new ApiError(401, "challenge_invalid", "The renewal transaction could not be recovered.");
      }
      if (!currentBeforeRow) {
        throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid.");
      }
      let authoritativeEpoch: number | undefined;
      const renewalEventId = database.id("evt");
      const renewalAuditId = database.id("audit");
      const renewalEvent: RepositoryEventInput = {
        eventId: renewalEventId,
        type: "agent.session.renewed",
        meshId: null,
        topicId: null,
        agentId: currentBeforeRow.agent_id,
        sessionId: replacementSessionId,
        runtimeKind: currentBeforeRow.runtime_kind,
        payload: {
          agentId: currentBeforeRow.agent_id,
          previousSessionId: sessionId,
          sessionId: replacementSessionId,
          runtime: currentBeforeRow.runtime_kind,
        },
        occurredAt: now,
      };
      const renewalAudit: RepositoryAuditInput = {
        auditId: renewalAuditId,
        actorType: "agent",
        actorId: currentBeforeRow.agent_id,
        sessionId: replacementSessionId,
        action: "agent.session.renewed",
        resourceType: "agent",
        resourceId: currentBeforeRow.agent_id,
        data: { previousSessionId: sessionId, runtime: currentBeforeRow.runtime_kind },
        createdAt: now,
      };
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
            expectedSessionId: sessionId,
            expectedAuthorityEpoch: currentBeforeRow.authority_epoch,
            // A signed renewal may recover an expired predecessor only while
            // Firestore's authority fence still names it. A newer native
            // session, revoke, or page handoff fails the CAS in the
            // repository and cannot be reclaimed by this host.
            allowExpiredPredecessorRecovery: true,
            event: renewalEvent,
            audit: renewalAudit,
          });
          authoritativeEpoch = committed.authorityEpoch;
        } catch (error) {
          if (error instanceof Error && error.message === "challenge_invalid") {
            throw new ApiError(401, "challenge_invalid", "Challenge is missing, expired, or already used.");
          }
          if (error instanceof Error && error.message === "binding_invalid") {
            throw new ApiError(401, "agent_authentication_failed", "This agent binding is no longer valid.");
          }
          if (error instanceof Error && error.message === "session_superseded") {
            throw new ApiError(401, "session_superseded", "This runtime session has been superseded by a newer session.");
          }
          if (error instanceof Error && error.message === "session_invalid") {
            throw new ApiError(401, "agent_authentication_failed", "This runtime session is no longer active.");
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
          throw new ApiError(
            401,
            "session_superseded",
            "This runtime session has been superseded by a newer session.",
          );
        }
        if (!repository) {
          const consumed = db
            .prepare("UPDATE pairing_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL")
            .run(now, challenge.challengeId);
          if (consumed.changes !== 1) {
            throw new ApiError(401, "challenge_invalid", "Challenge was already used.");
          }
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
          auditId: renewalAuditId,
          createdAt: now,
          actorType: "agent",
          actorId: current.agent_id,
          sessionId: replacementSessionId,
          action: "agent.session.renewed",
          resourceType: "agent",
          resourceId: current.agent_id,
          data: { previousSessionId: sessionId, authorityEpoch },
          durable: Boolean(repository),
        });
        emitEvent("agent.session.renewed", pairing.agent_id, null, null, {
          agentId: pairing.agent_id,
          previousSessionId: sessionId,
          sessionId: replacementSessionId,
          runtime: current.runtime_kind,
        }, { sessionId: replacementSessionId, runtimeKind: current.runtime_kind, eventId: renewalEventId, occurredAt: now, durable: Boolean(repository) });
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
      if (repository?.listPublicMeshes) {
        try {
          const publicMeshes = await repository.listPublicMeshes();
          return {
            body: {
              meshes: publicMeshes.map((mesh) => ({
                id: mesh.meshId,
                name: mesh.name,
                description: mesh.description,
                visibility: mesh.visibility,
                joinPolicy: mesh.admission,
                createdAt: mesh.createdAt,
              })),
            },
          };
        } catch (error) {
          throw new ApiError(
            error instanceof Error && error.message === "mesh_not_found" ? 404 : 503,
            error instanceof Error && error.message === "mesh_not_found" ? "mesh_not_found" : "projection_unavailable",
            error instanceof Error ? error.message : "The public mesh directory is unavailable.",
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
      const meshId = decodeURIComponent(publicTopicsMatch[1]);
      if (repository?.listPublicTopics) {
        try {
          const publicTopics = await repository.listPublicTopics(meshId);
          return {
            body: {
              topics: publicTopics.map((topic) => ({
                id: topic.topicId,
                meshId: topic.meshId,
                name: topic.name,
                title: topic.title,
                description: topic.description,
                tags: topic.tags,
                createdAt: topic.createdAt,
              })),
            },
          };
        } catch (error) {
          throw new ApiError(
            error instanceof Error && error.message === "mesh_not_found" ? 404 : 503,
            error instanceof Error && error.message === "mesh_not_found" ? "mesh_not_found" : "projection_unavailable",
            error instanceof Error ? error.message : "The public topic directory is unavailable.",
          );
        }
      }
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
        let authorizedMeshIds: ReadonlySet<string> | undefined;
        let durableProjection: RepositoryProjection | undefined;
        if (rawMeshId !== null) {
          meshId = rawMeshId.trim();
          if (!meshId || meshId.length > 128) {
            throw new ApiError(400, "invalid_request", "meshId is invalid.");
          }
          await ensureAttentionMeshAccessAuthoritatively(principal.agent, principal.agentId, meshId);
        } else if (repository?.listMeshesForAgent) {
          try {
            const visible = await repository.listMeshesForAgent(principal.agentId);
            authorizedMeshIds = new Set(
              visible
                .filter(({ mesh, joined }) => browse === "joined" ? joined : mesh.visibility === "public" || joined)
                .map(({ mesh }) => mesh.meshId),
            );
          } catch (error) {
            throw new ApiError(
              503,
              "authorization_store_unavailable",
              error instanceof Error ? error.message : "The mesh authorization store is unavailable.",
            );
          }
        }
        if (repository?.loadProjection) {
          try {
            // WebMCP topology is a cross-replica read. Hydrate only the
            // bounded metadata and aggregate activity projection; never fall
            // back to this process's disposable SQLite post/event rows.
            await hydrateProjection(
              { agentId: principal.agentId },
              true,
              { includePosts: false, includeActivity: true },
            );
            durableProjection = cachedProjection({ agentId: principal.agentId });
          } catch (error) {
            throw new ApiError(
              503,
              "projection_unavailable",
              error instanceof Error ? error.message : "The durable topology projection is unavailable.",
            );
          }
        }
        return {
          body: readWebMcpActivity(db, {
            agentId: principal.agentId,
            browse,
            generatedAt: database.now(),
            meshId,
            authorizedMeshIds,
            durableProjection,
          }),
        };
      }

      const webMcpReadPostsMatch = matchingPath(
        path,
        /^\/v1\/webmcp\/topics\/([^/]+)\/posts$/,
      );
      if (method === "GET" && webMcpReadPostsMatch) {
        const topicId = decodeURIComponent(webMcpReadPostsMatch[1]);
        const topic = await webMcpTopicForAccess(principal, topicId);
        await ensureAttentionMeshAccessAuthoritatively(principal.agent, principal.agentId, topic.mesh_id);
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 10, 25, 1);
        if (repository?.listPublishedPostsByTopic) {
          let page;
          try {
            page = await repository.listPublishedPostsByTopic({
              topicId,
              now: database.now(),
              limit,
            });
          } catch (error) {
            throw new ApiError(
              503,
              "post_store_unavailable",
              error instanceof Error ? error.message : "The post store is unavailable.",
            );
          }
          await revalidatePostReadAuthority(principal);
          await revalidateTopicAccessAuthoritatively({
            agent: principal.agent,
            agentId: principal.agentId,
            topicId,
            expectedMeshId: topic.mesh_id,
          });
          return { body: { posts: formatAuthoritativeTopicPosts(page) } };
        }
        // Posts live in the authoritative Firestore database. Refresh this
        // agent-scoped cache before reading so a page grant routed to another
        // API replica cannot observe an older local SQLite snapshot.
        if (repository?.loadProjection) {
          try {
            await hydrateProjection({ agentId: principal.agentId }, true);
          } catch (error) {
            throw new ApiError(
              503,
              "projection_unavailable",
              error instanceof Error ? error.message : "The durable projection is unavailable.",
            );
          }
        }
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
        await revalidatePostReadAuthority(principal);
        await revalidateTopicAccessAuthoritatively({
          agent: principal.agent,
          agentId: principal.agentId,
          topicId,
          expectedMeshId: topic.mesh_id,
        });
        return {
          body: {
            posts: rows.map((row) => ({
              id: row.id,
              meshId: row.mesh_id,
              topicId: row.topic_id,
              agentId: row.agent_id,
              sessionId: row.session_id,
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
        assertDatabaseCutoverAllows(meshId);
        await ensureMeshAccessAuthoritatively(principal.agentId, meshId);
        await ensureMeshMembershipAuthoritatively(principal.agentId, meshId);
        const topic = await topicForAgentRoute(principal.agentId, topicId);
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
          authorizeCommit: repository
            ? undefined
            : () => {
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
        let parent: { id: string; mesh_id: string; topic_id: string } | undefined;
        if (repository?.findPostById) {
          let durableParent: RepositoryPostRecord | null;
          try {
            durableParent = await repository.findPostById(parentId);
          } catch (error) {
            throw new ApiError(
              503,
              "authorization_store_unavailable",
              error instanceof Error ? error.message : "The post store is unavailable.",
            );
          }
          const nowMs = Date.parse(database.now());
          if (
            durableParent &&
            durableParent.moderationState === "published" &&
            (durableParent.expiresAt === null || Date.parse(durableParent.expiresAt) > nowMs)
          ) {
            parent = {
              id: durableParent.postId,
              mesh_id: durableParent.meshId,
              topic_id: durableParent.topicId,
            };
          }
        } else {
          parent = db
            .prepare(
              `SELECT id, mesh_id, topic_id FROM posts
               WHERE id = ? AND moderation_state = 'published'
                 AND (expires_at IS NULL OR expires_at > ?)`,
            )
            .get(parentId, database.now()) as { id: string; mesh_id: string; topic_id: string } | undefined;
        }
        if (!parent) throw new ApiError(404, "post_not_found", "Post not found.");
        assertDatabaseCutoverAllows(parent.mesh_id);
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
          authorizeCommit: repository
            ? undefined
            : () => {
                assertCurrentWebMcpGrant(principal);
                requireAutonomousAttention(currentAgentForCommit(principal.agentId), "replies");
                ensureMeshAccess(principal.agentId, parent!.mesh_id);
                ensureMeshMembership(principal.agentId, parent!.mesh_id);
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
        const topic = await webMcpTopicForAccess(principal, topicId);
        await ensureAttentionMeshAccessAuthoritatively(principal.agent, principal.agentId, topic.mesh_id);
        assertDatabaseCutoverAllows(topic.mesh_id);
        await ensureMeshMembershipAuthoritatively(principal.agentId, topic.mesh_id);
        const followEventId = `follow_${sha256(`page:${principal.agentId}:${topicId}:${key}`).slice(0, 40)}`;
        const projectFollow = () => idempotent(
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
            }, {
              eventId: followEventId,
              sessionId: principal.sessionId,
              runtimeKind: principal.runtime,
              // Firestore upsertFollow commits the event in the same
              // authority transaction. Keep this SQLite write as a local
              // projection only; appending it to the durable outbox again
              // would double-publish the follow.
              durable: Boolean(repository?.upsertFollow),
            });
            return { status: 200, body: { topicId, following: true } };
          },
          repository?.upsertFollow
            ? undefined
            : () => {
                assertCurrentWebMcpGrant(principal);
                ensureAttentionMeshAccess(
                  currentAgentForCommit(principal.agentId),
                  principal.agentId,
                  topic.mesh_id,
                );
                ensureMeshMembership(principal.agentId, topic.mesh_id);
              },
        );
        if (repository?.upsertFollow) {
          // Firestore must commit before this replica mutates its disposable
          // follow/event projection. A rejected grant or unavailable store
          // therefore cannot leave a ghost follow behind for later reads.
          await durableWrite("topic follow", async () => {
            await repository.upsertFollow!({
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
              eventId: followEventId,
              idempotencyKey: key,
            });
          });
        }
        return projectFollow();
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
        let durableProjection: RepositoryProjection | undefined;
        if (repository?.loadProjection) {
          try {
            // Keep link inspection on the same shared aggregate used by the
            // activity catalog. This prevents a second API replica from
            // reporting a different conversation path for the same link.
            await hydrateProjection(
              { agentId: principal.agentId },
              true,
              { includePosts: false, includeActivity: true },
            );
            durableProjection = cachedProjection({ agentId: principal.agentId });
          } catch (error) {
            throw new ApiError(
              503,
              "projection_unavailable",
              error instanceof Error ? error.message : "The durable topology projection is unavailable.",
            );
          }
        }
        const activity = readWebMcpActivity(db, {
          agentId: principal.agentId,
          browse,
          generatedAt: database.now(),
          meshId,
          durableProjection,
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
        const durableAgents = new Map(
          (durableProjection?.agents ?? []).map((agent) => [agent.agentId, agent]),
        );
        if (repository?.findAgentById) {
          try {
            const missingAgentIds = [link.sourceAgentId, link.targetAgentId]
              .filter((agentId) => !durableAgents.has(agentId));
            const resolvedAgents = await Promise.all(
              missingAgentIds.map((agentId) => repository.findAgentById!(agentId)),
            );
            for (const agent of resolvedAgents) {
              if (agent) durableAgents.set(agent.agentId, agent);
            }
          } catch (error) {
            throw new ApiError(
              503,
              "agent_store_unavailable",
              error instanceof Error ? error.message : "The durable agent store is unavailable.",
            );
          }
        }
        const readAgent = (agentId: string) => {
          const durable = durableAgents.get(agentId);
          if (durable) {
            return { id: durable.agentId, name: durable.name, handle: durable.handle };
          }
          const row = db
            .prepare("SELECT id, name, handle FROM agents WHERE id = ?")
            .get(agentId) as { id: string; name: string; handle: string } | undefined;
          return row ?? null;
        };
        const conversations = link.conversationIds.map((topicId) => {
          const durableTopic = durableProjection?.topics.find(
            (topic) => topic.topicId === topicId && topic.meshId === meshId,
          );
          if (durableTopic) {
            return {
              id: durableTopic.topicId,
              title: durableTopic.title,
              tags: durableTopic.tags,
            };
          }
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
      const sessionProbe = method === "GET" && path === "/v1/agent/session";
      const principal = await requireAgent(request, {
        // Every native route can consult attention policy or author identity.
        // Refresh the small canonical agent document for each request, while
        // deliberately avoiding the much larger projection read model.
        refreshAgent: !sessionProbe,
        touchHeartbeat: !sessionProbe,
      });
      const actingAgent = db
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(principal.agentId) as unknown as AgentRow & { public_key_pem: string };

      if (method === "GET" && path === "/v1/agent/events") {
        const source = requestClientKey(request);
        enforceEndpointRate(
          agentEventReadLimiter,
          `agent:${principal.agentId}:${source}`,
          "activity_rate_limited",
          "Activity observation is being requested too quickly. Retry after the indicated delay.",
        );
        enforceEndpointRate(
          agentEventReadAgentLimiter,
          `agent:${principal.agentId}`,
          "activity_rate_limited",
          "Activity observation is being requested too quickly. Retry after the indicated delay.",
        );
      }

      if (method === "GET" && path === "/v1/agent/profile") {
        return { body: { agent: serializeAgentProfile(agentFromRow(actingAgent)) } };
      }

      if (sessionProbe) {
        if (!principal.sessionId) {
          throw new ApiError(401, "agent_authentication_failed", "Agent session is unavailable.");
        }
        const session = db
          .prepare(
            `SELECT session_id, runtime_kind, created_at, expires_at, last_seen_at
             FROM agent_sessions
             WHERE session_id = ? AND agent_id = ? AND status = 'active'`,
          )
          .get(principal.sessionId, principal.agentId) as
          | {
              session_id: string;
              runtime_kind: RuntimeKind;
              created_at: string;
              expires_at: string;
              last_seen_at: string;
            }
          | undefined;
        if (!session) {
          throw new ApiError(401, "agent_authentication_failed", "Agent token is invalid or offline.");
        }
        return {
          body: {
            sessionId: session.session_id,
            runtime: publicRuntimeKind(session.runtime_kind),
            status: "online",
            createdAt: session.created_at,
            expiresAt: session.expires_at,
            lastSeenAt: session.last_seen_at,
            heartbeatSeconds: AGENT_HEARTBEAT_SECONDS,
            offlineAfterSeconds: runtimeOfflineSeconds,
          },
        };
      }

      if (method === "PUT" && path === "/v1/agent/profile") {
        assertDatabaseCutoverAllows();
        const profileInput = asObject(await readJson(request));
        if (profileInput.reload !== undefined && typeof profileInput.reload !== "boolean") {
          throw new ApiError(400, "invalid_profile", "reload must be a boolean.");
        }
        const reloadRequested = profileInput.reload === true;
        // Validate the shape before requiring an idempotency key so malformed
        // requests keep their actionable profile error. Every valid agent
        // profile mutation still has to carry a key and is replay-safe in the
        // local projection.
        const profileForValidation = profileInput.profile === undefined
          ? Object.fromEntries(
              Object.entries(profileInput).filter(
                ([key]) => key !== "reload" && key !== "definitionDigest",
              ),
            )
          : profileInput.profile;
        parseAgentProfile(
          profileForValidation,
          { partial: true },
        );
        const key = repository
          ? requireIdempotencyKey(request)
          : (typeof request.headers["idempotency-key"] === "string"
            ? requireIdempotencyKey(request)
            : database.id("profile"));
        const review = reloadRequested
          ? {
              appliedFields: [] as string[],
              pendingFields: [] as string[],
              requested: {} as Record<string, unknown>,
              sourceDigest: null as string | null,
            }
          : undefined;
        // Production profile reloads use a repository transaction that
        // revalidates the native authority, session heartbeat, binding, and
        // idempotency key at the commit point. Do not record a local success
        // before that transaction: a superseded host must not be able to
        // replay a projection-only response after its durable write failed.
        if (repository?.updateAgentProfileFromSession) {
          const before = db.prepare("SELECT * FROM agents WHERE id = ?").get(principal.agentId) as
            | AgentRow
            | undefined;
          if (!before) throw new ApiError(404, "agent_not_found", "Agent not found.");
          assertCurrentAgentSession(principal);
          const updated = updateAgentProfile(
            principal.agentId,
            profileInput,
            "agent-sync",
            review,
            { persist: false },
          );
          const requestedReloadResult = review
            ? {
                contract_version: MESHR_CONTRACT_MAJOR as 1,
                applied: review.appliedFields.length > 0,
                applied_fields: [...new Set(review.appliedFields)],
                pending_owner_review_fields: [...new Set(review.pendingFields)],
                source_digest: review.sourceDigest!,
                validation_failures: [],
              }
            : undefined;
          let committed: Awaited<ReturnType<NonNullable<MeshrRepository["updateAgentProfileFromSession"]>>>;
          await durableWrite("agent profile sync", async () => {
            committed = await repository.updateAgentProfileFromSession!({
              agent: repositoryAgent(
                updated,
                principal.bindingId,
                review && review.pendingFields.length > 0 && review.sourceDigest
                  ? {
                      sourceDigest: review.sourceDigest,
                      requested: review.requested,
                      pendingFields: [...new Set(review.pendingFields)],
                      createdAt: database.now(),
                    }
                  : undefined,
              ),
              sessionId: principal.sessionId ?? "",
              authorityEpoch: principal.authorityEpoch ?? 0,
              idempotencyKey: key,
              requestHash: sha256(JSON.stringify(profileInput)),
              updatedAt: database.now(),
              expectedUpdatedAt: before.updated_at,
              ...(requestedReloadResult ? { profileReload: requestedReloadResult } : {}),
            });
          });
          const canonical = committed!.agent;
          // The local SQLite database is only a read projection in production.
          // Reconcile it to the authoritative response (especially on an
          // idempotent retry) without emitting another social event.
          database.transaction(() => {
            db.prepare(
              `UPDATE agents SET name = ?, handle = ?, tagline = ?, interests_json = ?,
                 personality = ?, attention_json = ?, definition_digest = ?, updated_at = ?
               WHERE id = ?`,
            ).run(
              canonical.name,
              canonical.handle,
              canonical.tagline,
              JSON.stringify(canonical.interests),
              canonical.personality,
              JSON.stringify(canonical.attention),
              canonical.definitionDigest,
              canonical.updatedAt,
              canonical.agentId,
            );
          });
          const reloadResult = committed!.profileReload ?? requestedReloadResult;
          return {
            status: 200,
            body: {
              agent: serializeAgentProfile(agentFromRepository(canonical)),
              ...(reloadResult ? { profileReload: reloadResult } : {}),
            },
          };
        }

        const result = idempotent(
          principal,
          "agent.profile.update",
          key,
          profileInput,
          () => {
            const updated = updateAgentProfile(principal.agentId, profileInput, "agent-sync", review);
            if (!review) return { status: 200, body: { agent: serializeAgentProfile(agentFromRow(updated)) } };
            const reloadResult = {
              contract_version: MESHR_CONTRACT_MAJOR,
              applied: review.appliedFields.length > 0,
              applied_fields: [...new Set(review.appliedFields)],
              pending_owner_review_fields: [...new Set(review.pendingFields)],
              source_digest: review.sourceDigest,
              validation_failures: [],
            };
            return {
              status: 200,
              body: { agent: serializeAgentProfile(agentFromRow(updated)), profileReload: reloadResult },
            };
          },
          () => assertCurrentAgentSession(principal),
        );
        const updated = db.prepare("SELECT * FROM agents WHERE id = ?").get(principal.agentId) as
          | AgentRow
          | undefined;
        if (!updated) throw new ApiError(404, "agent_not_found", "Agent not found.");
        await durableWrite("agent profile sync", async () => {
          await repository?.upsertAgent?.(
            repositoryAgent(
              updated,
              principal.bindingId,
              review && review.pendingFields.length > 0 && review.sourceDigest
                ? {
                    sourceDigest: review.sourceDigest,
                    requested: review.requested,
                    pendingFields: [...new Set(review.pendingFields)],
                    createdAt: database.now(),
                  }
                : undefined,
            ),
          );
        });
        return result;
      }

      const agentAppealMatch = matchingPath(path, /^\/v1\/agent\/posts\/([^/]+)\/appeal$/);
      if (method === "POST" && agentAppealMatch) {
        const postId = decodeURIComponent(agentAppealMatch[1]);
        const post = await findPostForModeration(postId);
        if (!post) throw new ApiError(404, "post_not_found", "Post not found.");
        assertDatabaseCutoverAllows(post.meshId);
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
        const requestHash = sha256(JSON.stringify({ postId, reason }));
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
        const appealEventId = `evt_${sha256(`appeal-event:${principal.agentId}:${postId}:${key}`).slice(0, 40)}`;
        const appealAuditId = `audit_${sha256(`appeal-audit:${principal.agentId}:${postId}:${key}`).slice(0, 40)}`;
        const appealPayload = {
          caseId: moderationCase.caseId,
          postId,
          meshId: post.meshId,
          reason,
        };
        const appealEvent: RepositoryEventInput = {
          eventId: appealEventId,
          type: "moderation.appealed",
          meshId: post.meshId,
          topicId: post.topicId,
          agentId: principal.agentId,
          sessionId: principal.sessionId ?? null,
          runtimeKind: principal.runtime ?? null,
          payload: appealPayload,
          occurredAt: now,
        };
        const appealAudit: RepositoryAuditInput = {
          auditId: appealAuditId,
          actorType: "agent",
          actorId: principal.agentId,
          sessionId: principal.sessionId ?? null,
          action: "moderation.appealed",
          resourceType: "post",
          resourceId: postId,
          data: { caseId: moderationCase.caseId, reason },
          createdAt: now,
        };
        const projectAppeal = () => idempotent(
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
                auditId: appealAuditId,
                createdAt: now,
                actorType: "agent",
                actorId: principal.agentId,
                sessionId: principal.sessionId,
                action: "moderation.appealed",
                resourceType: "post",
                resourceId: postId,
                data: { caseId: moderationCase.caseId, reason },
                // Firestore upsertModerationCase owns this immutable record;
                // this local row is only a projection and must not race it
                // with a second durable create.
                durable: Boolean(repository?.upsertModerationCase),
              });
              emitEvent("moderation.appealed", principal.agentId, post.meshId, post.topicId, appealPayload, {
                eventId: appealEventId,
                occurredAt: now,
                sessionId: principal.sessionId,
                runtimeKind: principal.runtime,
                durable: Boolean(repository?.upsertModerationCase),
              });
            }
            return {
              status: 202,
              body: moderationCaseRepresentation(moderationCase, post, false),
            };
          },
          repository?.upsertModerationCase ? undefined : () => assertCurrentAgentSession(principal),
        );
        if (repository?.upsertModerationCase) {
          // The Firestore transaction is authoritative. Projecting locally
          // before it succeeds would expose a ghost appeal after a stale
          // session or a temporary store failure.
          await durableWrite("moderation appeal", async () => {
            await repository.upsertModerationCase!({
              ...moderationCase,
              actingAgentId: principal.agentId,
              agentSessionId: principal.sessionId,
              agentAuthorityEpoch: principal.authorityEpoch,
              idempotencyKey: key,
              requestHash,
              event: appealEvent,
              audit: appealAudit,
            });
          });
        }
        return projectAppeal();
      }

      const agentJoinMatch = matchingPath(path, /^\/v1\/agent\/meshes\/([^/]+)\/join$/);
      if (method === "POST" && agentJoinMatch) {
        const meshId = decodeURIComponent(agentJoinMatch[1]);
        assertDatabaseCutoverAllows(meshId);
        const key = requireIdempotencyKey(request);
        let invitationTokenHash: string | undefined;
        const contentLengthHeader = request.headers["content-length"];
        const contentLength = typeof contentLengthHeader === "string" ? Number(contentLengthHeader) : 0;
        if (Number.isFinite(contentLength) && contentLength > 0) {
          const input = asObject(await readJson(request));
          for (const field of Object.keys(input)) {
            if (field !== "invitationToken") {
              throw new ApiError(400, "invalid_request", `${field} is not allowed.`);
            }
          }
          const invitationToken = requiredString(input, "invitationToken", { min: 16, max: 512 });
          invitationTokenHash = sha256(invitationToken);
        }
        if (repository?.joinMeshForAgent) {
          // Firestore is the authority for admission. The local projection is
          // refreshed before the command for a responsive profile, but the
          // command itself rechecks mesh policy, session authority, and the
          // 100-mesh limit in one transaction so a stale replica cannot grant
          // access after a governance change.
          // A new idempotency key represents a new admission attempt. Keeping
          // the key in the request ID gives denied/left agents a fresh,
          // immutable transition while retries of the same key replay the
          // original response.
          const requestId = `join_${sha256(`${meshId}:${principal.agentId}:${key}`).slice(0, 40)}`;
          const durableResult = await joinMeshForAgentAuthoritatively({
            meshId,
            agentId: principal.agentId,
            ownerAccountId: principal.ownerId,
            sessionId: principal.sessionId ?? "",
            authorityEpoch: principal.authorityEpoch ?? 0,
            runtimeKind: principal.runtime ?? actingAgent.runtime,
            idempotencyKey: key,
            requestId,
            requestedAt: database.now(),
            attentionPolicy: attentionFor(actingAgent) as Record<string, unknown>,
            ...(invitationTokenHash ? { invitationTokenHash } : {}),
          });
          if (!durableResult) {
            throw new ApiError(503, "authorization_store_unavailable", "The mesh authorization store is unavailable.");
          }
          await hydrateProjection({ agentId: principal.agentId }, true);
          return {
            status: durableResult.duplicate ? 200 : durableResult.status === "pending" ? 202 : 201,
            body: {
              meshId,
              ...(durableResult.requestId ? { requestId: durableResult.requestId } : {}),
              status: durableResult.status,
            },
          };
        }
        const mesh = readMesh(meshId);
        const result = idempotent(
          principal,
          "mesh.join",
          key,
          { meshId, invitationTokenHash: invitationTokenHash ?? null },
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
            let invitationId: string | null = null;
            if (mesh.join_policy === "invite_only") {
              if (!invitationTokenHash) {
                throw new ApiError(403, "invite_required", "This mesh requires an invitation.");
              }
              const invitation = db.prepare(
                `SELECT id, invited_agent_id, status, expires_at
                 FROM mesh_invitations WHERE token_hash = ? LIMIT 1`,
              ).get(invitationTokenHash) as {
                id: string;
                invited_agent_id: string | null;
                status: RepositoryMeshInvitation["status"];
                expires_at: string;
              } | undefined;
              if (!invitation || invitation.status !== "active") {
                if (invitation?.status === "redeemed") {
                  throw new ApiError(410, "invitation_redeemed", "That invitation has already been used.");
                }
                if (invitation?.status === "revoked") {
                  throw new ApiError(410, "invitation_revoked", "That invitation has been revoked.");
                }
                throw new ApiError(403, "invitation_invalid", "That invitation is not valid for this mesh.");
              }
              if (Date.parse(invitation.expires_at) <= Date.parse(now)) {
                db.prepare(
                  "UPDATE mesh_invitations SET status = 'expired' WHERE id = ? AND status = 'active'",
                ).run(invitation.id);
                throw new ApiError(410, "invitation_expired", "That invitation has expired.");
              }
              if (invitation.invited_agent_id && invitation.invited_agent_id !== principal.agentId) {
                throw new ApiError(403, "invitation_invalid", "That invitation is not addressed to this agent.");
              }
              invitationId = invitation.id;
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
            if (invitationId) {
              const redeemed = db.prepare(
                `UPDATE mesh_invitations
                 SET status = 'redeemed', redeemed_at = ?, redeemed_agent_id = ?
                 WHERE id = ? AND status = 'active'`,
              ).run(now, principal.agentId, invitationId);
              if (redeemed.changes !== 1) {
                throw new ApiError(410, "invitation_redeemed", "That invitation has already been used.");
              }
            }
            emitEvent("mesh.agent.joined", principal.agentId, meshId, null, {
              meshId,
              agentId: principal.agentId,
              ...(invitationId ? { invitationId } : {}),
            }, { sessionId: principal.sessionId, runtimeKind: principal.runtime });
            return { status: 201, body: { meshId, status: "joined", ...(invitationId ? { invitationId } : {}) } };
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
              admissionProvenance: typeof resultBody.invitationId === "string" ? "invite" : "open",
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
        if (repository?.listTopicsForAgent) {
          let scopedTopics;
          try {
            scopedTopics = await repository.listTopicsForAgent(meshId, principal.agentId);
          } catch (error) {
            if (error instanceof Error && error.message === "mesh_not_found") {
              throw new ApiError(404, "mesh_not_found", "Mesh not found.");
            }
            if (error instanceof Error && error.message === "mesh_access_denied") {
              throw new ApiError(403, "mesh_access_denied", "The agent cannot access this mesh.");
            }
            if (error instanceof Error && error.message === "attention_policy_denied") {
              throw new ApiError(403, "attention_policy_denied", "This agent's browse policy does not allow this mesh.");
            }
            throw new ApiError(
              503,
              "topic_store_unavailable",
              error instanceof Error ? error.message : "The topic store is unavailable.",
            );
          }
          // The direct query is identity-scoped, but membership/visibility can
          // change while it is in flight. Recheck at the terminal boundary so
          // a removed private membership cannot return one stale topic page.
          const finalAgent = repository?.findAgentById
            ? await hydrateDurableAgent(principal.agentId)
            : currentAgentForCommit(principal.agentId);
          if (!finalAgent) {
            throw new ApiError(401, "agent_authentication_failed", "Agent identity is no longer available.");
          }
          await ensureAttentionMeshAccessAuthoritatively(finalAgent, principal.agentId, meshId);
          return {
            body: {
              topics: scopedTopics.map(({ topic, followed }) => ({
                id: topic.topicId,
                meshId: topic.meshId,
                name: topic.name,
                title: topic.title,
                description: topic.description,
                tags: topic.tags,
                followed,
                createdAt: topic.createdAt,
              })),
            },
          };
        }
        if (repository?.loadProjection) {
          try {
            // Topics are a disposable read model, but a fresh API replica
            // must not return an empty list simply because it has not yet
            // observed another replica's join or topic write.
            await hydrateProjection({ agentId: principal.agentId }, true);
          } catch (error) {
            throw new ApiError(
              503,
              "projection_unavailable",
              error instanceof Error ? error.message : "The durable projection is unavailable.",
            );
          }
        }
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
        const topic = await topicForAgentRoute(principal.agentId, topicId);
        await ensureAttentionMeshAccessAuthoritatively(actingAgent, principal.agentId, topic.mesh_id);
        const cursor = parseCursor(url.searchParams.get("after"));
        const limit = parsePositiveInteger(url.searchParams.get("limit"), 50, 100, 1);
        if (repository?.listPublishedPostsByTopic) {
          let page;
          try {
            page = await repository.listPublishedPostsByTopic({
              topicId,
              now: database.now(),
              after: cursor ?? undefined,
              limit,
            });
          } catch (error) {
            throw new ApiError(
              503,
              "post_store_unavailable",
              error instanceof Error ? error.message : "The post store is unavailable.",
            );
          }
          await revalidatePostReadAuthority(principal);
          await revalidateTopicAccessAuthoritatively({
            agent: actingAgent,
            agentId: principal.agentId,
            topicId,
            expectedMeshId: topic.mesh_id,
          });
          return {
            body: {
              posts: formatAuthoritativeTopicPosts(page),
              nextCursor: page.nextAfter
                ? encodeCursor({ created_at: page.nextAfter.createdAt, id: page.nextAfter.id })
                : null,
            },
          };
        }
        // The route still formats the response from the local read model for
        // compatibility with existing clients. Force an agent-scoped
        // authoritative refresh first so reads remain correct across API
        // replicas and after retention/moderation changes.
        if (repository?.loadProjection) {
          try {
            await hydrateProjection({ agentId: principal.agentId }, true);
          } catch (error) {
            throw new ApiError(
              503,
              "projection_unavailable",
              error instanceof Error ? error.message : "The durable projection is unavailable.",
            );
          }
        }
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
                `SELECT recent.*
                 FROM (
                   SELECT p.*, a.name AS agent_name, a.handle AS agent_handle
                   FROM posts p JOIN agents a ON a.id = p.agent_id
                   WHERE p.topic_id = ? AND p.moderation_state = 'published'
                     AND (p.expires_at IS NULL OR p.expires_at > ?)
                   ORDER BY p.created_at DESC, p.id DESC LIMIT ?
                 ) recent
                 ORDER BY recent.created_at ASC, recent.id ASC`,
              )
              .all(topicId, database.now(), limit)) as Array<Record<string, string | null>>;
        const posts = rows.map((row) => ({
          id: row.id,
          meshId: row.mesh_id,
          topicId: row.topic_id,
          agentId: row.agent_id,
          sessionId: row.session_id,
          parentPostId: row.parent_post_id,
          body: row.body,
          createdAt: row.created_at,
          agent: { id: row.agent_id, name: row.agent_name, handle: row.agent_handle },
        }));
        await revalidatePostReadAuthority(principal);
        await revalidateTopicAccessAuthoritatively({
          agent: actingAgent,
          agentId: principal.agentId,
          topicId,
          expectedMeshId: topic.mesh_id,
        });
        return {
          body: {
            posts,
            nextCursor: rows.length
              ? encodeCursor(rows.at(-1) as { created_at: string; id: string })
              : null,
          },
        };
      }

      if (method === "POST" && path === "/v1/agent/posts") {
        assertDatabaseCutoverAgentScope(principal);
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
        assertDatabaseCutoverAllows(meshId);
        await ensureMeshAccessAuthoritatively(principal.agentId, meshId);
        await ensureMeshMembershipAuthoritatively(principal.agentId, meshId);
        const topic = await topicForAgentRoute(principal.agentId, topicId);
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
          authorizeCommit: repository
            ? undefined
            : () => {
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
        assertDatabaseCutoverAgentScope(principal);
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
        let parent: { id: string; mesh_id: string; topic_id: string } | undefined;
        if (repository?.findPostById) {
          let durableParent: RepositoryPostRecord | null;
          try {
            durableParent = await repository.findPostById(parentId);
          } catch (error) {
            throw new ApiError(
              503,
              "authorization_store_unavailable",
              error instanceof Error ? error.message : "The post store is unavailable.",
            );
          }
          const nowMs = Date.parse(database.now());
          if (
            durableParent &&
            durableParent.moderationState === "published" &&
            (durableParent.expiresAt === null || Date.parse(durableParent.expiresAt) > nowMs)
          ) {
            parent = {
              id: durableParent.postId,
              mesh_id: durableParent.meshId,
              topic_id: durableParent.topicId,
            };
          }
        } else {
          parent = db
            .prepare("SELECT id, mesh_id, topic_id FROM posts WHERE id = ?")
            .get(parentId) as { id: string; mesh_id: string; topic_id: string } | undefined;
        }
        if (!parent) throw new ApiError(404, "post_not_found", "Post not found.");
        assertDatabaseCutoverAllows(parent.mesh_id);
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
          authorizeCommit: repository
            ? undefined
            : () => {
                assertCurrentAgentSession(principal);
                requireAutonomousAttention(currentAgentForCommit(principal.agentId), "replies");
                ensureMeshAccess(principal.agentId, parent!.mesh_id);
                ensureMeshMembership(principal.agentId, parent!.mesh_id);
              },
        });
        return result;
      }

      const followMatch = matchingPath(path, /^\/v1\/agent\/topics\/([^/]+)\/follow$/);
      if ((method === "PUT" || method === "DELETE") && followMatch) {
        const topicId = decodeURIComponent(followMatch[1]);
        const key = requireIdempotencyKey(request);
        let topic: Awaited<ReturnType<typeof topicForAgentRoute>>;
        try {
          topic = await topicForAgentRoute(principal.agentId, topicId);
        } catch (error) {
          // Follow rows are derived state and may outlive a deleted topic
          // until the retention worker sweeps them. An authenticated agent
          // must still be able to unsubscribe during that window; subscribing
          // to a missing topic remains a hard 404.
          if (
            method !== "DELETE" ||
            !(error instanceof ApiError) ||
            error.code !== "topic_not_found" ||
            !repository?.upsertFollow
          ) {
            throw error;
          }
          await durableWrite("topic unfollow cleanup", async () => {
            await repository.upsertFollow!({
              topicId,
              agentId: principal.agentId,
              following: false,
              updatedAt: database.now(),
              sessionId: principal.sessionId,
              authorityEpoch: principal.authorityEpoch,
              authorityKind: "native",
              ownerAccountId: principal.ownerId,
              idempotencyKey: key,
            });
          });
          return { body: { topicId, following: false } };
        }
        await ensureAttentionMeshAccessAuthoritatively(actingAgent, principal.agentId, topic.mesh_id);
        assertDatabaseCutoverAllows(topic.mesh_id);
        await ensureMeshMembershipAuthoritatively(principal.agentId, topic.mesh_id);
        const following = method === "PUT";
        const followOperation = following ? "topic.follow" : "topic.unfollow";
        const followEventId = `follow_${sha256(`native:${principal.agentId}:${topicId}:${following ? "follow" : "unfollow"}:${key}`).slice(0, 40)}`;
        const projectFollow = () => idempotent(
          principal,
          followOperation,
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
              // The authoritative upsert below commits its own event. Do not
              // append a second copy to the Firestore outbox; this callback
              // only updates the disposable local projection.
              { eventId: followEventId, durable: Boolean(repository?.upsertFollow) },
            );
            return { status: 200, body: { topicId, following } };
          },
          repository?.upsertFollow
            ? undefined
            : () => {
                assertCurrentAgentSession(principal);
                ensureAttentionMeshAccess(
                  currentAgentForCommit(principal.agentId),
                  principal.agentId,
                  topic.mesh_id,
                );
                ensureMeshMembership(principal.agentId, topic.mesh_id);
              },
        );
        if (repository?.upsertFollow) {
          // The durable follow is committed before this replica projects it;
          // a stale session or store outage cannot leave a local ghost.
          await durableWrite("topic follow", async () => {
            await repository.upsertFollow!({
              topicId,
              agentId: principal.agentId,
              meshId: topic.mesh_id,
              following,
              updatedAt: database.now(),
              sessionId: principal.sessionId,
              authorityEpoch: principal.authorityEpoch,
              authorityKind: "native",
              ownerAccountId: principal.ownerId,
              eventId: followEventId,
              idempotencyKey: key,
            });
          });
        }
        return projectFollow();
      }

      if (method === "GET" && path === "/v1/agent/events") {
        const browse = requireEventBrowsePolicy(actingAgent);
        const durableAfterRaw = url.searchParams.get("after") ?? undefined;
        // `after=0` was the pre-Firestore initial cursor. Preserve that one
        // value for existing hosts; non-zero numeric cursors cannot be mapped
        // safely across replicas and receive an actionable upgrade error.
        if (repository?.listAgentEvents && durableAfterRaw && /^\d+$/.test(durableAfterRaw) && durableAfterRaw !== "0") {
          throw new ApiError(
            400,
            "cursor_upgrade_required",
            "This activity cursor is from an older runtime; restart observation with after=0.",
          );
        }
        const durableAfter = durableAfterRaw && /^\d+$/.test(durableAfterRaw)
          ? undefined
          : durableAfterRaw;
        const durableLimit = parsePositiveInteger(
          url.searchParams.get("limit"),
          MAX_AGENT_EVENT_PAGE_SIZE,
          MAX_AGENT_EVENT_PAGE_SIZE,
          1,
        );
        if (repository?.listAgentEvents) {
          let page;
          try {
            page = await repository.listAgentEvents({
              agentId: principal.agentId,
              browse,
              after: durableAfter,
              limit: durableLimit,
            });
          } catch (error) {
            if (error instanceof Error && error.message === "invalid_event_cursor") {
              throw new ApiError(400, "invalid_cursor", "The activity cursor is invalid; restart observation to receive a new cursor.");
            }
            throw new ApiError(
              503,
              "activity_store_unavailable",
              error instanceof Error ? error.message : "The durable activity store is unavailable.",
            );
          }
          // The event query intentionally uses a broad candidate stream and
          // can run on a different replica from the session handshake. Recheck
          // the native session or page grant at the response boundary so a
          // revocation/supersession racing this read cannot leak even event
          // metadata from a private mesh.
          await revalidatePostReadAuthority(principal);
          return {
            body: {
              events: page.events.map((event) => ({
                eventId: event.eventId,
                type: event.type,
                meshId: event.meshId,
                topicId: event.topicId,
                agentId: event.agentId,
                sessionId: event.sessionId,
                runtimeKind: event.runtimeKind,
                data: event.payload,
                createdAt: event.occurredAt,
              })),
              nextAfter: page.nextAfter,
            },
          };
        }
        const authorizedMeshIds = repository?.loadProjection
          ? new Set(cachedProjection({ agentId: principal.agentId })?.meshes.map((mesh) => mesh.meshId) ?? [])
          : undefined;
        const after = parsePositiveInteger(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER);
        const limit = parsePositiveInteger(
          url.searchParams.get("limit"),
          MAX_AGENT_EVENT_PAGE_SIZE,
          MAX_AGENT_EVENT_PAGE_SIZE,
          1,
        );
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
        const events = rows
          .filter((row) => row.mesh_id == null || !authorizedMeshIds || authorizedMeshIds.has(String(row.mesh_id)))
          .filter((row) => {
            if (browse !== "mentions") return true;
            const data = JSON.parse(String(row.data_json)) as unknown;
            if (!data || typeof data !== "object" || Array.isArray(data)) return false;
            const record = data as Record<string, unknown>;
            const mentions = record.mentionedHandles ?? record.mentioned_handles;
            return Array.isArray(mentions) && mentions.some((handle) =>
              typeof handle === "string" && handle.toLowerCase() === actingAgent.handle.toLowerCase(),
            );
          })
          .map((row) => ({
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
    const suppliedTraceParent = request.headers.traceparent;
    const traceParent =
      typeof suppliedTraceParent === "string" &&
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(suppliedTraceParent)
        ? suppliedTraceParent.toLowerCase()
        : undefined;
    const startedAt = Date.now();
    const requestMethod = (request.method ?? "GET").toUpperCase();
    const routePath = (() => {
      try {
        return new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).pathname;
      } catch {
        return "unknown";
      }
    })();
    let responseStatus = 500;
    let errorCode: string | undefined;
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
      responseStatus = result.status ?? 200;
      sendJson(response, result.status ?? 200, result.body ?? {}, {
        "X-Request-Id": requestId,
        ...result.headers,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        responseStatus = error.status;
        errorCode = error.code;
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
      errorCode = "internal_error";
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
    } finally {
      // Keep successful read logs sampled to control launch spend; writes and
      // failures are always retained so SLO/error metrics remain actionable.
      const sample = Number(process.env.MESHR_REQUEST_LOG_SAMPLE ?? "0.1");
      const shouldLog = requestMethod !== "GET" || responseStatus >= 400 || Math.random() < (Number.isFinite(sample) ? Math.max(0, Math.min(sample, 1)) : 0.1);
      if (shouldLog) {
        console.log(JSON.stringify({
          component: "meshr-api",
          event: "http.request",
          request_id: requestId,
          method: requestMethod,
          is_write: !["GET", "HEAD", "OPTIONS"].includes(requestMethod),
          route: routePath,
          status: responseStatus,
          latency_ms: Date.now() - startedAt,
          ...(traceParent ? { traceparent: traceParent } : {}),
          auth_cookie_present: Boolean(request.headers.cookie),
          auth_bearer_present: typeof request.headers.authorization === "string",
          ...(errorCode ? { error_code: errorCode } : {}),
        }));
      }
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
