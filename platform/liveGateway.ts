import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createFirestore, eventPlaneConfig } from "./googleClients.ts";

/**
 * The live gateway is a read-only projection service. It never accepts a
 * client-supplied identity and never writes topology. Before a HTTP or
 * WebSocket subscription is admitted it asks the API to authorize the
 * browser session (or agent bearer grant) for the requested mesh.
 */
const config = eventPlaneConfig();
const firestore = createFirestore(config.projectId);
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

interface ClientState {
  meshId: string;
  alive: boolean;
  cursor: number;
  principal: "human" | "agent" | "anonymous";
  cookie?: string;
  authorization?: string;
  authPending: boolean;
}

const clients = new Map<WebSocket, ClientState>();

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
  cursor: number;
}> {
  if (allowAnonymousLocal) return { allowed: true, principal: "anonymous", cursor: 0 };
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
    return { allowed: false, principal: "anonymous", cursor: 0 };
  }
  if (!response.ok) return { allowed: false, principal: "anonymous", cursor: 0 };
  const body = (await response.json()) as {
    allowed?: boolean;
    principal?: "human" | "agent";
    cursor?: number;
  };
  return {
    allowed: body.allowed === true,
    principal: body.principal === "agent" ? "agent" : "human",
    cursor: Number.isSafeInteger(body.cursor) ? Number(body.cursor) : 0,
  };
}

async function authorize(request: IncomingMessage, meshId: string) {
  return authorizeCredentials(meshId, {
    cookie: headerValue(request.headers.cookie),
    authorization: headerValue(request.headers.authorization),
  });
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
    clients.delete(socket);
    return false;
  }
  socket.send(encoded);
  return true;
}

const snapshotCache = new Map<string, { expiresAt: number; value: Record<string, unknown> | null }>();

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
    latest_session_id: data[0]?.latest_session_id ?? null,
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
    if (!originAllowed(request)) {
      json(response, 403, { error: { code: "origin_denied" } });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
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
    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, {
        ok: true,
        service: "live-gateway",
        clients: clients.size,
        authenticated: !allowAnonymousLocal,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const taxonomy = await firestore.collection("system").doc("taxonomy").get();
      if (!taxonomy.exists) {
        json(response, 503, { ok: false, service: "live-gateway", error: "dependencies_unavailable" });
        return;
      }
      json(response, 200, { ok: true, service: "live-gateway" });
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
    const access = await authorize(request, meshId);
    if (!access.allowed) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, async (websocket) => {
      const state: ClientState = {
        meshId,
        alive: true,
        cursor: access.cursor,
        principal: access.principal,
        cookie: headerValue(request.headers.cookie),
        authorization: headerValue(request.headers.authorization),
        authPending: false,
      };
      clients.set(websocket, state);
      websocket.on("pong", () => {
        const current = clients.get(websocket);
        if (current) current.alive = true;
      });
      websocket.on("close", () => clients.delete(websocket));
      websocket.on("error", () => {
        websocket.close(1011, "live socket error");
        clients.delete(websocket);
      });
      const snapshot = await readSnapshot(meshId);
      const cursor = snapshotCursor(snapshot ?? undefined);
      state.cursor = cursor;
      send(websocket, {
        type: "topology.snapshot",
        mesh_id: meshId,
        cursor,
        snapshot,
      });
    });
  } catch {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
  }
});

const stopWatching = firestore.collection("topology_shards").onSnapshot(
  (snapshot) => {
    const changedMeshes = new Set<string>();
    for (const change of snapshot.docChanges()) {
      const data = (change.doc.data() ?? {}) as Record<string, unknown>;
      const meshId = String(data.mesh_id ?? change.doc.id.replace(/:\d+$/, ""));
      if (meshId) changedMeshes.add(meshId);
    }
    for (const meshId of changedMeshes) {
      // A shard update invalidates the short read cache. Rebuild one bounded
      // aggregate snapshot per affected mesh before notifying subscribers.
      snapshotCache.delete(meshId);
      void readSnapshot(meshId)
        .then((snapshotValue) => {
          const cursor = snapshotCursor(snapshotValue ?? undefined);
          for (const [socket, state] of clients) {
            if (state.meshId !== meshId || cursor <= state.cursor) continue;
            state.cursor = cursor;
            send(socket, {
              type: "topology.snapshot",
              mesh_id: meshId,
              cursor,
              snapshot: snapshotValue,
            });
          }
        })
        .catch((error) => console.error("topology snapshot refresh failed", error));
    }
  },
  (error) => console.error("topology watch failed", error),
);

const heartbeat = setInterval(() => {
  for (const [socket, state] of clients) {
    if (!state.alive) {
      socket.terminate();
      clients.delete(socket);
      continue;
    }
    if (socket.bufferedAmount > maxBufferedBytes) {
      socket.close(1009, "live consumer is too slow");
      clients.delete(socket);
      continue;
    }
    if (!state.authPending && !allowAnonymousLocal) {
      state.authPending = true;
      void authorizeCredentials(state.meshId, {
        cookie: state.cookie,
        authorization: state.authorization,
      })
        .then((access) => {
          const current = clients.get(socket);
          if (!current || !access.allowed) {
            socket.close(4001, "live authorization expired");
            clients.delete(socket);
            return;
          }
          current.principal = access.principal;
        })
        .catch(() => {
          socket.close(1013, "live authorization unavailable");
          clients.delete(socket);
        })
        .finally(() => {
          const current = clients.get(socket);
          if (current) current.authPending = false;
        });
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
  clearInterval(heartbeat);
  stopWatching();
  for (const socket of clients.keys()) socket.close(1001, "server shutdown");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await firestore.terminate();
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
