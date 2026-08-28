import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { createFirestore, eventPlaneConfig } from "./googleClients.ts";
import { loadRuntimeSecrets } from "./runtimeSecrets.ts";

/**
 * The live gateway is a read-only projection service. It never accepts a
 * client-supplied identity and never writes topology. Before a HTTP or
 * WebSocket subscription is admitted it asks the API to authorize the
 * browser session (or agent bearer grant) for the requested mesh.
 */
loadRuntimeSecrets();
const config = eventPlaneConfig();
// The gateway only needs the aggregate topology projection. In production
// this is a separate Firestore database with a database-scoped viewer grant;
// account, session, post, and governance records remain inaccessible here.
const firestore = createFirestore(config.projectId, config.topologyDatabaseId);
const port = Number(process.env.MESHR_PORT ?? "8080");
const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
const apiUrl = (process.env.MESHR_API_URL?.trim() || "http://127.0.0.1:8787").replace(/\/+$/, "");
const internalToken = process.env.MESHR_INTERNAL_TOKEN?.trim();
const allowAnonymousLocal =
  process.env.MESHR_LOCAL_MODE === "1" && process.env.MESHR_LIVE_ALLOW_ANONYMOUS === "1";
const maxFrameBytes = Math.max(
  16 * 1024,
  Math.min(Number(process.env.MESHR_LIVE_MAX_FRAME_BYTES ?? 256 * 1024), 1024 * 1024),
);
const maxBufferedBytes = Math.max(
  maxFrameBytes * 2,
  Math.min(Number(process.env.MESHR_LIVE_MAX_BUFFERED_BYTES ?? 1024 * 1024), 8 * 1024 * 1024),
);
const allowedOrigins = new Set(
  (process.env.MESHR_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const requireOrigin = process.env.MESHR_ENV?.trim().toLowerCase() === "production" || allowedOrigins.size > 0;
const MESHR_CONTRACT_MAJOR = "1";
function boundedEnvInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(Math.floor(parsed), maximum)) : fallback;
}
// Access-epoch listeners trigger immediate reauthorization for security
// changes. This slower fail-safe interval bounds missed listener delivery
// without turning every idle viewer into a high-rate API/Firestore poll.
const liveAuthRecheckMs = boundedEnvInt("MESHR_LIVE_AUTH_RECHECK_MS", 60_000, 10_000, 300_000);
const liveAuthCacheMs = liveAuthRecheckMs;
const maxClients = boundedEnvInt("MESHR_LIVE_MAX_CLIENTS", 512, 32, 10_000);
const maxConnectionsPerCredential = boundedEnvInt(
  "MESHR_LIVE_MAX_CONNECTIONS_PER_CREDENTIAL",
  8,
  1,
  256,
);
const maxConnectionsPerIp = boundedEnvInt(
  "MESHR_LIVE_MAX_CONNECTIONS_PER_IP",
  64,
  2,
  512,
);
type CostProtectionMode = "normal" | "protect" | "throttle";
function readCostProtectionMode(): CostProtectionMode {
  const value = process.env.MESHR_COST_PROTECTION_MODE?.trim().toLowerCase();
  if (!value || value === "normal") return "normal";
  if (value === "protect" || value === "throttle") return value;
  throw new Error("MESHR_COST_PROTECTION_MODE must be normal, protect, or throttle.");
}
const costProtectionMode = readCostProtectionMode();
// Topology snapshots are retained aggregates, so coalescing several events
// into one frame is safe. Under cost protection this bounds both Firestore
// reads and per-viewer fan-out while preserving the latest cursor.
const fanoutRefreshDelayMs = costProtectionMode === "throttle"
  ? 2_000
  : costProtectionMode === "protect"
    ? 1_000
    : 200;
const fanoutMinimumIntervalMs = fanoutRefreshDelayMs;

interface ClientState {
  meshId: string;
  agentId?: string;
  alive: boolean;
  cursor: number;
  principal: "human" | "agent" | "anonymous";
  meshVisibility: "public" | "unlisted" | "private";
  cookie?: string;
  authorization?: string;
  authPending: boolean;
  authDirty: boolean;
  authCheckedAt: number;
  credentialKey: string;
  ipKey: string;
}

const clients = new Map<WebSocket, ClientState>();
const activeCredentialCounts = new Map<string, number>();
const activeIpCounts = new Map<string, number>();
const pendingCredentialCounts = new Map<string, number>();
const pendingIpCounts = new Map<string, number>();
let pendingConnectionCount = 0;

function connectionKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function requestCredentialKey(request: IncomingMessage): string {
  const credential = headerValue(request.headers.cookie) ?? headerValue(request.headers.authorization) ?? "anonymous";
  return connectionKey(credential);
}

function requestIpKey(request: IncomingMessage): string {
  const forwarded = headerValue(request.headers["x-forwarded-for"])?.split(",", 1)[0]?.trim();
  return connectionKey(forwarded || request.socket.remoteAddress || "unknown");
}

interface ConnectionReservation {
  credentialKey: string;
  ipKey: string;
  active: boolean;
  released: boolean;
}

function countFor(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, countFor(map, key) + 1);
}

function decrementCount(map: Map<string, number>, key: string): void {
  const next = countFor(map, key) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function reserveConnection(request: IncomingMessage): ConnectionReservation | null {
  const credentialKey = requestCredentialKey(request);
  const ipKey = requestIpKey(request);
  if (clients.size + pendingConnectionCount >= maxClients) return null;
  if (
    countFor(activeCredentialCounts, credentialKey) + countFor(pendingCredentialCounts, credentialKey) >=
      maxConnectionsPerCredential ||
    countFor(activeIpCounts, ipKey) + countFor(pendingIpCounts, ipKey) >= maxConnectionsPerIp
  ) return null;
  pendingConnectionCount += 1;
  incrementCount(pendingCredentialCounts, credentialKey);
  incrementCount(pendingIpCounts, ipKey);
  return { credentialKey, ipKey, active: false, released: false };
}

function activateConnection(reservation: ConnectionReservation): void {
  if (reservation.released || reservation.active) return;
  pendingConnectionCount = Math.max(0, pendingConnectionCount - 1);
  decrementCount(pendingCredentialCounts, reservation.credentialKey);
  decrementCount(pendingIpCounts, reservation.ipKey);
  incrementCount(activeCredentialCounts, reservation.credentialKey);
  incrementCount(activeIpCounts, reservation.ipKey);
  reservation.active = true;
}

function releaseConnection(reservation: ConnectionReservation): void {
  if (reservation.released) return;
  if (reservation.active) {
    decrementCount(activeCredentialCounts, reservation.credentialKey);
    decrementCount(activeIpCounts, reservation.ipKey);
  } else {
    pendingConnectionCount = Math.max(0, pendingConnectionCount - 1);
    decrementCount(pendingCredentialCounts, reservation.credentialKey);
    decrementCount(pendingIpCounts, reservation.ipKey);
  }
  reservation.released = true;
}

function removeClient(socket: WebSocket): void {
  const state = clients.get(socket);
  if (!state) return;
  clients.delete(socket);
  decrementCount(activeCredentialCounts, state.credentialKey);
  decrementCount(activeIpCounts, state.ipKey);
  console.log(JSON.stringify({
    component: "meshr-live-gateway",
    event: "live.connection",
    action: "closed",
    mesh_id: state.meshId,
    clients: clients.size,
  }));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-meshr-contract-version": MESHR_CONTRACT_MAJOR,
  });
  response.end(JSON.stringify(body));
}

function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return !requireOrigin;
  return allowedOrigins.size === 0 || allowedOrigins.has(origin);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function authorizeCredentials(
  meshId: string,
  credentials: { cookie?: string; authorization?: string },
): Promise<{
  allowed: boolean;
  principal: ClientState["principal"];
  agentId?: string;
  meshVisibility: ClientState["meshVisibility"];
  cursor: number;
}> {
  if (allowAnonymousLocal) {
    return { allowed: true, principal: "anonymous", meshVisibility: "public", cursor: 0 };
  }
  const headers = new Headers({ accept: "application/json" });
  if (credentials.cookie) headers.set("cookie", credentials.cookie);
  if (credentials.authorization) headers.set("authorization", credentials.authorization);
  if (internalToken) headers.set("x-meshr-live-internal", internalToken);
  let response: Response;
  try {
    response = await fetch(
      `${apiUrl}/v1/live/authorize?meshId=${encodeURIComponent(meshId)}`,
      { headers, signal: AbortSignal.timeout(3_000) },
    );
  } catch {
    return { allowed: false, principal: "anonymous", meshVisibility: "private", cursor: 0 };
  }
  if (!response.ok) {
    return { allowed: false, principal: "anonymous", meshVisibility: "private", cursor: 0 };
  }
  const body = (await response.json()) as {
    allowed?: boolean;
    principal?: "human" | "agent";
    agentId?: string;
    meshVisibility?: "public" | "unlisted" | "private";
    cursor?: number;
  };
  return {
    allowed: body.allowed === true,
    principal: body.principal === "agent" ? "agent" : "human",
    agentId: body.principal === "agent" && typeof body.agentId === "string" ? body.agentId : undefined,
    meshVisibility:
      body.meshVisibility === "public" || body.meshVisibility === "unlisted"
        ? body.meshVisibility
        : "private",
    cursor: Number.isSafeInteger(body.cursor) ? Number(body.cursor) : 0,
  };
}

async function authorize(request: IncomingMessage, meshId: string) {
  return authorizeCredentials(meshId, {
    cookie: headerValue(request.headers.cookie),
    authorization: headerValue(request.headers.authorization),
  });
}

/**
 * Visibility and membership can change without a topology event. Recheck the
 * browser/agent grant immediately before every fan-out so a private-mesh
 * transition or role revocation cannot leak one more cached snapshot during
 * the reauthorization interval. A pending reauthorization deliberately wins over this
 * check; skipping one update is safer than sending stale-authorized data.
 */
async function reauthorizeForFanout(
  socket: WebSocket,
  state: ClientState,
  force = false,
): Promise<boolean> {
  if (allowAnonymousLocal) return true;
  // Normal post traffic does not change access. Cache the authoritative
  // decision briefly; the explicit auth recheck timer below bounds revocation
  // visibility without granting this public workload access to private
  // session fences.
  if (!force && !state.authDirty && Date.now() - state.authCheckedAt < liveAuthCacheMs) return true;
  if (state.authPending) return false;
  state.authPending = true;
  try {
    const access = await authorizeCredentials(state.meshId, {
      cookie: state.cookie,
      authorization: state.authorization,
    });
    const current = clients.get(socket);
    if (!current) return false;
    if (!access.allowed) {
      socket.close(4001, "live authorization expired");
      removeClient(socket);
      return false;
    }
    current.principal = access.principal;
    current.agentId = access.agentId;
    current.meshVisibility = access.meshVisibility;
    current.authDirty = false;
    current.authCheckedAt = Date.now();
    return true;
  } catch {
    socket.close(1013, "live authorization unavailable");
    removeClient(socket);
    return false;
  } finally {
    const current = clients.get(socket);
    if (current) current.authPending = false;
  }
}

function snapshotCursor(data: Record<string, unknown> | undefined): number {
  const revision = data?.revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) ? revision : 0;
}

function send(socket: WebSocket, body: unknown): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, "utf8") > maxFrameBytes || socket.bufferedAmount > maxBufferedBytes) {
    socket.close(1009, "live frame too large or consumer too slow");
    removeClient(socket);
    return false;
  }
  socket.send(encoded);
  return true;
}

const snapshotCache = new Map<string, { expiresAt: number; value: Record<string, unknown> | null }>();

// A public activity response is safe to share between viewers of the same
// public mesh. Keep it at the gateway and coalesce refreshes so a topology
// burst does not turn into one API snapshot request per socket.
const activityCache = new Map<
  string,
  {
    expiresAt: number;
    value: Record<string, unknown> | null;
    pending?: Promise<Record<string, unknown> | null>;
  }
>();

async function readPublicActivity(
  meshId: string,
  credentials: { cookie?: string; authorization?: string },
): Promise<Record<string, unknown> | null> {
  const cached = activityCache.get(meshId);
  if (cached?.pending) return cached.pending;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const headers = new Headers({
    accept: "application/json",
    "x-meshr-contract-version": MESHR_CONTRACT_MAJOR,
  });
  if (credentials.cookie) headers.set("cookie", credentials.cookie);
  if (credentials.authorization) headers.set("authorization", credentials.authorization);
  if (internalToken) headers.set("x-meshr-live-internal", internalToken);
  const pending = fetch(
    `${apiUrl}/v1/activity/public?shared=1&meshId=${encodeURIComponent(meshId)}`,
    {
    headers,
    signal: AbortSignal.timeout(3_000),
    },
  )
    .then(async (response) => {
      if (!response.ok) return null;
      const body = (await response.json()) as unknown;
      if (!body || typeof body !== "object" || Array.isArray(body)) return null;
      const snapshot = body as Record<string, unknown>;
      // Keep the network frame bounded even if an older API instance has not
      // yet deployed the mesh-scoped activity response. The API also applies
      // these limits authoritatively; this is a last-line gateway guard.
      const rawAgents = Array.isArray(snapshot.agents) ? snapshot.agents : [];
      const rawLinks = Array.isArray(snapshot.links) ? snapshot.links : [];
      const agentsForMesh = rawAgents.filter((agent) => {
        if (!agent || typeof agent !== "object" || Array.isArray(agent)) return false;
        const meshIds = (agent as Record<string, unknown>).meshIds;
        return Array.isArray(meshIds) && meshIds.includes(meshId);
      });
      const linksForMesh = rawLinks.filter((link) =>
        Boolean(link && typeof link === "object" && !Array.isArray(link) &&
          (link as Record<string, unknown>).meshId === meshId),
      );
      const boundedAgents = agentsForMesh
        .sort((left, right) => Number((right as Record<string, unknown>).postCount ?? 0) - Number((left as Record<string, unknown>).postCount ?? 0))
        .slice(0, 256);
      const boundedLinks = linksForMesh
        .sort((left, right) => Number((right as Record<string, unknown>).recentEventCount ?? 0) - Number((left as Record<string, unknown>).recentEventCount ?? 0))
        .slice(0, 512);
      // The gateway coalesces one public snapshot across sockets. Remove the
      // viewer-specific ownership bit before fan-out so the representative
      // browser's account can never be disclosed to other viewers.
      const agents = boundedAgents.map((agent) => {
            if (!agent || typeof agent !== "object" || Array.isArray(agent)) return agent;
            const neutral = { ...(agent as Record<string, unknown>) };
            neutral.ownedByYou = false;
            return neutral;
          });
      return {
        ...snapshot,
        meshId,
        meshes: Array.isArray(snapshot.meshes)
          ? snapshot.meshes.filter((mesh) =>
              Boolean(mesh && typeof mesh === "object" && !Array.isArray(mesh) &&
                (mesh as Record<string, unknown>).id === meshId),
            )
          : [],
        agents,
        links: boundedLinks,
        truncated:
          snapshot.truncated === true ||
          agentsForMesh.length > boundedAgents.length ||
          linksForMesh.length > boundedLinks.length,
      };
    })
    .catch(() => null)
    .then((value) => {
      activityCache.set(meshId, { expiresAt: Date.now() + 500, value });
      return value;
    });
  activityCache.set(meshId, { expiresAt: Date.now() + 500, value: null, pending });
  return pending;
}

async function readSnapshot(meshId: string): Promise<Record<string, unknown> | null> {
  const cached = snapshotCache.get(meshId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const shards = await firestore
    .collection("topology_shards")
    .where("mesh_id", "==", meshId)
    .limit(32)
    .get();
  if (shards.empty) {
    snapshotCache.set(meshId, { expiresAt: Date.now() + 1_000, value: null });
    return null;
  }
  const data = shards.docs
    .map((document) => document.data() as Record<string, unknown>)
    .sort((left, right) => String(right.latest_occurred_at ?? "").localeCompare(String(left.latest_occurred_at ?? "")));
  const snapshot: Record<string, unknown> = {
    mesh_id: meshId,
    revision: data.reduce((sum, shard) => sum + Number(shard.revision ?? 0), 0),
    event_count: data.reduce((sum, shard) => sum + Number(shard.event_count ?? 0), 0),
    latest_event_id: data[0]?.latest_event_id ?? null,
    latest_event_type: data[0]?.latest_event_type ?? null,
    latest_agent_id: data[0]?.latest_agent_id ?? null,
    latest_runtime_kind: data[0]?.latest_runtime_kind ?? null,
    latest_occurred_at: data[0]?.latest_occurred_at ?? null,
    updated_at: data[0]?.updated_at ?? null,
    shards: shards.size,
  };
  snapshotCache.set(meshId, { expiresAt: Date.now() + 1_000, value: snapshot });
  return snapshot;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    // Kubernetes probes are internal and intentionally have no browser
    // Origin. Keep process/dependency health unauthenticated and route it
    // before the browser-origin gate; user WebSocket/snapshot routes remain
    // origin-checked below.
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, {
        ok: true,
        service: "live-gateway",
        clients: clients.size,
        maxClients,
        authenticated: !allowAnonymousLocal,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const [projectionRead, apiReady] = await Promise.all([
        // An empty projection is valid on a clean launch. A bounded read is a
        // dependency check without requiring access to authoritative taxonomy.
        firestore.collection("topology_shards").limit(1).get(),
        fetch(`${apiUrl}/readyz`, {
          headers: internalToken ? { "x-meshr-live-internal": internalToken } : undefined,
          signal: AbortSignal.timeout(3_000),
        }).then((result) => result.ok).catch(() => false),
      ]);
      if (!projectionRead || !apiReady) {
        json(response, 503, { ok: false, service: "live-gateway", error: "dependencies_unavailable" });
        return;
      }
      json(response, 200, { ok: true, service: "live-gateway" });
      return;
    }
    if (!originAllowed(request)) {
      json(response, 403, { error: { code: "origin_denied" } });
      return;
    }
    const contractVersion = url.searchParams.get("contractVersion") ?? request.headers["x-meshr-contract-version"];
    if (typeof contractVersion === "string" && contractVersion.trim() !== MESHR_CONTRACT_MAJOR) {
      json(response, 426, {
        error: {
          code: "incompatible_contract",
          message: `This live gateway requires contract major ${MESHR_CONTRACT_MAJOR}; upgrade the client integration.`,
        },
      });
      return;
    }
    const match = /^\/v1\/live\/snapshots\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
    if (request.method === "GET" && match) {
      const meshId = match[1]!;
      const access = await authorize(request, meshId);
      if (!access.allowed) {
        json(response, 403, { error: { code: "mesh_access_denied" } });
        return;
      }
      const snapshot = await readSnapshot(meshId);
      const terminalAccess = await authorize(request, meshId);
      if (!terminalAccess.allowed) {
        json(response, 403, { error: { code: "mesh_access_denied" } });
        return;
      }
      const cursor = snapshotCursor(snapshot ?? undefined);
      const after = Number(url.searchParams.get("after") ?? "0");
      json(response, 200, {
        mesh_id: meshId,
        cursor,
        reset: Number.isSafeInteger(after) && after > cursor,
        snapshot,
      });
      return;
    }
    json(response, 404, { error: { code: "not_found" } });
  } catch (error) {
    console.error("live gateway request failed", error);
    json(response, 503, { error: { code: "live_unavailable" } });
  }
});

const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes });
server.on("upgrade", async (request, socket, head) => {
  let reservation: ConnectionReservation | undefined;
  try {
    if (!originAllowed(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const contractVersion = url.searchParams.get("contractVersion") ?? request.headers["x-meshr-contract-version"];
    if (typeof contractVersion === "string" && contractVersion.trim() !== MESHR_CONTRACT_MAJOR) {
      socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const meshId = url.searchParams.get("meshId") ?? "";
    if (url.pathname !== "/v1/live" || !/^[A-Za-z0-9._:-]{1,128}$/.test(meshId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    reservation = reserveConnection(request);
    if (!reservation) {
      socket.write(
        "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 5\r\nConnection: close\r\n\r\n",
      );
      socket.destroy();
      return;
    }
    const access = await authorize(request, meshId);
    if (!access.allowed) {
      releaseConnection(reservation);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, async (websocket) => {
      activateConnection(reservation!);
      const state: ClientState = {
        meshId,
        agentId: access.agentId,
        alive: true,
        cursor: access.cursor,
        principal: access.principal,
        meshVisibility: access.meshVisibility,
        cookie: headerValue(request.headers.cookie),
        authorization: headerValue(request.headers.authorization),
        authPending: false,
        authDirty: false,
        authCheckedAt: Date.now(),
        credentialKey: reservation!.credentialKey,
        ipKey: reservation!.ipKey,
      };
      clients.set(websocket, state);
      console.log(JSON.stringify({
        component: "meshr-live-gateway",
        event: "live.connection",
        action: "opened",
        mesh_id: meshId,
        principal: state.principal,
        clients: clients.size,
      }));
      websocket.on("pong", () => {
        const current = clients.get(websocket);
        if (current) current.alive = true;
      });
      websocket.on("close", () => removeClient(websocket));
      websocket.on("error", () => {
        websocket.close(1011, "live socket error");
        removeClient(websocket);
      });
      try {
        const snapshot = await readSnapshot(meshId);
        if (!(await reauthorizeForFanout(websocket, state, true))) return;
        const cursor = snapshotCursor(snapshot ?? undefined);
        state.cursor = cursor;
        const activity = state.principal === "human" && state.meshVisibility === "public"
          ? await readPublicActivity(meshId, {
              cookie: state.cookie,
              authorization: state.authorization,
            })
          : null;
        send(websocket, {
          type: "topology.snapshot",
          mesh_id: meshId,
          cursor,
          snapshot,
          ...(activity ? { activity } : {}),
        });
      } catch {
        websocket.close(1013, "live snapshot unavailable");
        removeClient(websocket);
      }
    });
  } catch {
    if (reservation) releaseConnection(reservation);
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

const pendingMeshRefreshes = new Map<string, NodeJS.Timeout>();
const lastMeshFanoutAt = new Map<string, number>();

function meshHasSubscribers(meshId: string): boolean {
  for (const state of clients.values()) if (state.meshId === meshId) return true;
  return false;
}

async function refreshMesh(meshId: string): Promise<void> {
  if (!meshHasSubscribers(meshId)) return;
  const snapshotValue = await readSnapshot(meshId);
  const cursor = snapshotCursor(snapshotValue ?? undefined);
  const candidates = [...clients.entries()].filter(([, state]) => state.meshId === meshId);
  const authorized = await Promise.all(
    candidates.map(async ([socket, state]) => ({
      socket,
      state,
      allowed: await reauthorizeForFanout(socket, state),
    })),
  );
  const publicRepresentative = authorized.find(
    ({ state, allowed }) => allowed && state.principal === "human" && state.meshVisibility === "public",
  );
  const activity = publicRepresentative
    ? await readPublicActivity(meshId, {
        cookie: publicRepresentative.state.cookie,
        authorization: publicRepresentative.state.authorization,
      })
    : null;
  for (const { socket, state, allowed } of authorized) {
    if (!allowed || cursor <= state.cursor) continue;
    state.cursor = cursor;
    send(socket, {
      type: "topology.snapshot",
      mesh_id: meshId,
      cursor,
      snapshot: snapshotValue,
      ...(activity && state.meshVisibility === "public" ? { activity } : {}),
    });
  }
  lastMeshFanoutAt.set(meshId, Date.now());
}

function scheduleMeshRefresh(meshId: string): void {
  if (pendingMeshRefreshes.has(meshId) || !meshHasSubscribers(meshId)) return;
  const elapsed = Date.now() - (lastMeshFanoutAt.get(meshId) ?? 0);
  const delay = Math.max(0, fanoutMinimumIntervalMs - elapsed, fanoutRefreshDelayMs);
  const timer = setTimeout(() => {
    pendingMeshRefreshes.delete(meshId);
    void refreshMesh(meshId).catch((error) => console.error("topology snapshot refresh failed", error));
  }, delay);
  timer.unref();
  pendingMeshRefreshes.set(meshId, timer);
}

const stopWatching = firestore.collection("topology_shards").onSnapshot(
  (snapshot) => {
    const changedMeshes = new Set<string>();
    for (const change of snapshot.docChanges()) {
      const data = (change.doc.data() ?? {}) as Record<string, unknown>;
      const meshId = String(data.mesh_id ?? change.doc.id.replace(/:\d+$/, ""));
      if (meshId) changedMeshes.add(meshId);
      if (meshId && String(data.latest_event_type ?? "").startsWith("mesh.")) {
        for (const [, state] of clients) {
          if (state.meshId === meshId) state.authDirty = true;
        }
      }
    }
    for (const meshId of changedMeshes) {
      // Invalidate caches even when there are no subscribers, but do not read
      // Firestore or fan out a frame until a viewer is actually present.
      snapshotCache.delete(meshId);
      activityCache.delete(meshId);
      scheduleMeshRefresh(meshId);
    }
  },
  (error) => console.error("topology watch failed", error),
);

// Access epochs are written only for mesh visibility, role, and admission
// events. They invalidate the short per-socket authorization cache without
// forcing a Firestore/API read for every ordinary post fan-out.
const stopWatchingAccessEpochs = firestore.collection("mesh_access_epochs").onSnapshot(
  (snapshot) => {
    const changedMeshes = new Set(
      snapshot.docChanges().map((change) => String(change.doc.get("mesh_id") ?? change.doc.id)),
    );
    if (!changedMeshes.size) return;
    for (const [, state] of clients) {
      if (changedMeshes.has(state.meshId)) state.authDirty = true;
    }
  },
  (error) => console.error("mesh access epoch watch failed", error),
);

// Human logout, WebMCP revocation, agent disconnect, and native-session
// supersession can affect sockets without a mesh event. Global changes dirty
// every socket; ordinary agent-session replacement uses an agent-scoped fence
// so one renewal cannot trigger O(all viewers) authorization work.
// Live-access fences are authoritative in the private database and mirrored
// as a non-sensitive ordered event into this projection database. Watch the
// projection unconditionally: production deliberately separates the two
// databases, while local mode points both handles at the same database.
const stopWatchingLiveAccess = firestore.collection("live_access_epochs").onSnapshot(
  (snapshot) => {
    for (const change of snapshot.docChanges()) {
      const agentId = typeof change.doc.get("agent_id") === "string"
        ? String(change.doc.get("agent_id"))
        : undefined;
      for (const [socket, state] of clients) {
        if (agentId && state.agentId !== agentId) continue;
        state.authDirty = true;
        void reauthorizeForFanout(socket, state, true);
      }
    }
  },
  (error) => console.error("live access epoch watch failed", error),
);

const authorizationRecheck = setInterval(() => {
  if (allowAnonymousLocal) return;
  for (const [socket, state] of clients) {
    if (state.authPending) continue;
    void reauthorizeForFanout(socket, state, true);
  }
}, liveAuthRecheckMs);
authorizationRecheck.unref();

const heartbeat = setInterval(() => {
  for (const [socket, state] of clients) {
    if (!state.alive) {
      socket.terminate();
      removeClient(socket);
      continue;
    }
    if (socket.bufferedAmount > maxBufferedBytes) {
      socket.close(1009, "live consumer is too slow");
      removeClient(socket);
      continue;
    }
    state.alive = false;
    socket.ping();
  }
}, 20_000);
heartbeat.unref();

server.listen(port, host, () =>
  console.log(`live gateway listening on ${host}:${port} (auth=${!allowAnonymousLocal})`),
);

async function shutdown(): Promise<void> {
  clearInterval(authorizationRecheck);
  clearInterval(heartbeat);
  for (const timer of pendingMeshRefreshes.values()) clearTimeout(timer);
  pendingMeshRefreshes.clear();
  stopWatching();
  stopWatchingAccessEpochs();
  stopWatchingLiveAccess();
  for (const socket of clients.keys()) socket.close(1001, "server shutdown");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await firestore.terminate();
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
