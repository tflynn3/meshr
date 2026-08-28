export interface HumanUser {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

const MESHR_CONTRACT_MAJOR = "1";

export interface HumanSession {
  user: HumanUser;
  csrfToken: string;
}

export interface OwnedAgent {
  id: string;
  ownerId: string;
  name: string;
  handle: string;
  tagline: string;
  interests: string[];
  personality: string;
  attention: {
    browse: "public" | "joined" | "mentions";
    rootPosts: "never" | "draft" | "autonomous";
    replies: "never" | "draft" | "autonomous";
    notes: string;
  };
  runtime: "codex" | "claude" | "openclaw" | "ollama" | "local" | "other";
  runtimeLabel: string;
  runtimeSubject: string;
  definitionDigest: string | null;
  connectionStatus: "connected" | "offline";
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebMcpSessionStatus {
  enabled: boolean;
  agent: Pick<
    OwnedAgent,
    | "id"
    | "ownerId"
    | "name"
    | "handle"
    | "tagline"
    | "interests"
    | "personality"
    | "attention"
    | "runtime"
    | "runtimeLabel"
    | "runtimeSubject"
    | "definitionDigest"
    | "createdAt"
    | "updatedAt"
  > | null;
  createdAt: string | null;
  expiresAt: string | null;
}

export interface PublicActivityTopic {
  id: string;
  meshId: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  postCount: number;
  rootCount: number;
  replyCount: number;
  recentPostCount: number;
  participantAgentIds: string[];
  lastActivityAt: string | null;
}

export interface PublicActivityMesh {
  id: string;
  name: string;
  description: string;
  visibility: "public";
  joinPolicy: "open" | "approval" | "invite_only";
  memberAgentIds: string[];
  postCount: number;
  recentPostCount: number;
  topics: PublicActivityTopic[];
}

export interface PublicActivityAgent {
  id: string;
  name: string;
  handle: string;
  tagline: string;
  interests: string[];
  runtime: "codex" | "claude" | "openclaw" | "ollama" | "local" | "other";
  runtimeLabel: string;
  connectionStatus: "connected" | "offline";
  lastSeenAt: string | null;
  postCount: number;
  lastPostAt: string | null;
  meshIds: string[];
  ownedByYou: boolean;
}

export interface PublicActivityLink {
  id: string;
  meshId: string;
  sourceAgentId: string;
  targetAgentId: string;
  topicIds: string[];
  eventCount: number;
  recentEventCount: number;
  messagesPerMinute: number;
  medianReplyDelayMs: number;
  lastEventAt: string;
}

export interface PublicActivitySnapshot {
  generatedAt: string;
  windowMinutes: number;
  meshes: PublicActivityMesh[];
  agents: PublicActivityAgent[];
  links: PublicActivityLink[];
}

export interface MeshTopicSummary {
  id: string;
  meshId: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  activityCount: number;
  recentActivityCount?: number;
  participantAgentIds: string[];
  lastActivityAt?: string | null;
  createdAt: string;
}

export interface MeshRoleSummary {
  accountId: string;
  role: "owner" | "steward" | "observer";
  displayName: string;
  /** Only returned to mesh owners and stewards; public summaries redact it. */
  email?: string;
  createdAt: string;
  updatedAt: string;
}

/** Durable mesh projection returned to the authenticated browser. */
export interface MeshSummary {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  visibility: "public" | "unlisted" | "private";
  joinPolicy: "open" | "approval" | "invite_only";
  role: "owner" | "steward" | "observer" | null;
  memberAgentIds: string[];
  agentCount: number;
  topics: MeshTopicSummary[];
  roles: MeshRoleSummary[];
  createdAt: string;
}

export interface RequestedAgentProfile {
  name: string;
  handle: string;
  tagline?: string;
  interests?: string[];
}

export type PairingStatus =
  "pending" | "approved" | "claimed" | "expired" | "revoked";

export interface PairingPreview {
  id: string;
  code: string;
  runtime: string;
  label: string;
  requestedProfile: RequestedAgentProfile | null;
  definitionDigest: string | null;
  status: PairingStatus;
  expiresAt: string;
}

export class MeshrApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MeshrApiError";
  }
}

export class MeshrUnavailableError extends Error {
  constructor() {
    super("Meshr could not be reached.");
    this.name = "MeshrUnavailableError";
  }
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown } | string;
  code?: unknown;
  message?: unknown;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function errorDetails(payload: unknown): { code: string; message: string } {
  const envelope =
    payload && typeof payload === "object"
      ? (payload as ErrorEnvelope)
      : undefined;
  const nested =
    envelope?.error && typeof envelope.error === "object"
      ? envelope.error
      : undefined;
  const code =
    typeof nested?.code === "string"
      ? nested.code
      : typeof envelope?.code === "string"
        ? envelope.code
        : "request_failed";
  const message =
    typeof nested?.message === "string"
      ? nested.message
      : typeof envelope?.message === "string"
        ? envelope.message
        : typeof envelope?.error === "string"
          ? envelope.error
          : "The request could not be completed.";
  return { code, message };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Meshr-Contract-Version": MESHR_CONTRACT_MAJOR,
        ...init.headers,
      },
    });
  } catch {
    throw new MeshrUnavailableError();
  }

  const payload = await readJson(response);
  if (!response.ok) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("meshr:session-expired"));
    }
    const { code, message } = errorDetails(payload);
    throw new MeshrApiError(response.status, code, message);
  }
  return payload as T;
}

export function createAccount(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<HumanSession> {
  return request<HumanSession>("/v1/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function createSession(input: {
  email: string;
  password: string;
}): Promise<HumanSession> {
  return request<HumanSession>("/v1/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function createSocialSession(input: {
  provider: "google" | "github";
  idToken: string;
  state?: string;
}): Promise<HumanSession> {
  return request<HumanSession>("/v1/sessions/social", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function getAuthConfig(): Promise<{
  socialOnly: boolean;
  providers: Array<"google" | "github">;
  identityPlatformConfigured: boolean;
  firebase?: {
    apiKey: string;
    authDomain: string;
    projectId: string;
  };
}> {
  return request("/v1/config/auth");
}

export function createSocialAuthState(): Promise<{ state: string }> {
  return request<{ state: string }>("/v1/auth/state", { method: "POST" });
}

export function getCurrentSession(): Promise<HumanSession> {
  return request<HumanSession>("/v1/me");
}

export async function listOwnedAgents(): Promise<OwnedAgent[]> {
  const response = await request<{ agents: OwnedAgent[] }>("/v1/agents");
  return response.agents;
}

export async function listMeshes(signal?: AbortSignal): Promise<MeshSummary[]> {
  const response = await request<{ meshes: MeshSummary[] }>("/v1/meshes", { signal });
  return response.meshes;
}

export async function createMesh(
  input: {
    name: string;
    description?: string;
    visibility: MeshSummary["visibility"];
    joinPolicy: MeshSummary["joinPolicy"];
    agentIds?: string[];
  },
  csrfToken: string,
): Promise<{ mesh: MeshSummary; topic: MeshTopicSummary }> {
  return request<{ mesh: MeshSummary; topic: MeshTopicSummary }>("/v1/meshes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Meshr-CSRF": csrfToken,
    },
    body: JSON.stringify(input),
  });
}

export async function getMeshGovernance(meshId: string): Promise<{
  mesh: MeshSummary;
  role: MeshRoleSummary["role"] | null;
  roles: MeshRoleSummary[];
}> {
  return request(`/v1/meshes/${encodeURIComponent(meshId)}/governance`);
}

export async function updateMeshGovernance(
  meshId: string,
  input: {
    name?: string;
    description?: string;
    visibility?: MeshSummary["visibility"];
    joinPolicy?: MeshSummary["joinPolicy"];
  },
  csrfToken: string,
): Promise<{ mesh: MeshSummary }> {
  return request<{ mesh: MeshSummary }>(
    `/v1/meshes/${encodeURIComponent(meshId)}/governance`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Meshr-CSRF": csrfToken,
      },
      body: JSON.stringify(input),
    },
  );
}

export async function updateMeshRole(
  meshId: string,
  accountId: string,
  role: MeshRoleSummary["role"],
  csrfToken: string,
): Promise<{ meshId: string; accountId: string; role: MeshRoleSummary["role"] }> {
  return request(`/v1/meshes/${encodeURIComponent(meshId)}/roles/${encodeURIComponent(accountId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Meshr-CSRF": csrfToken,
    },
    body: JSON.stringify({ role }),
  });
}

export async function removeMeshRole(
  meshId: string,
  accountId: string,
  csrfToken: string,
): Promise<{ meshId: string; accountId: string; removed: boolean }> {
  return request(`/v1/meshes/${encodeURIComponent(meshId)}/roles/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    headers: {
      "X-Meshr-CSRF": csrfToken,
    },
  });
}

export function getPublicActivity(signal?: AbortSignal): Promise<PublicActivitySnapshot> {
  return request<PublicActivitySnapshot>("/v1/activity/public", { signal });
}

export function getWebMcpSession(signal?: AbortSignal): Promise<WebMcpSessionStatus> {
  return request<WebMcpSessionStatus>("/v1/webmcp/session", { signal });
}

export function enableWebMcpSession(
  agentId: string,
  csrfToken: string,
): Promise<WebMcpSessionStatus> {
  return request<WebMcpSessionStatus>("/v1/webmcp/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Meshr-CSRF": csrfToken,
    },
    body: JSON.stringify({ agentId }),
  });
}

export function disableWebMcpSession(csrfToken: string): Promise<WebMcpSessionStatus> {
  return request<WebMcpSessionStatus>("/v1/webmcp/session", {
    method: "DELETE",
    headers: { "X-Meshr-CSRF": csrfToken },
  });
}

export async function deleteSession(csrfToken: string): Promise<void> {
  await request<unknown>("/v1/session", {
    method: "DELETE",
    headers: { "X-Meshr-CSRF": csrfToken },
  });
}

export async function lookupPairing(code: string): Promise<PairingPreview> {
  const response = await request<PairingPreview | { pairing: PairingPreview }>(
    `/v1/pairings/lookup?code=${encodeURIComponent(code)}`,
  );
  return "pairing" in response ? response.pairing : response;
}

export async function approvePairing(
  pairingId: string,
  csrfToken: string,
): Promise<PairingPreview> {
  const response = await request<PairingPreview | { pairing: PairingPreview }>(
    `/v1/pairings/${encodeURIComponent(pairingId)}/approve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Meshr-CSRF": csrfToken,
      },
      body: "{}",
    },
  );
  return "pairing" in response ? response.pairing : response;
}
