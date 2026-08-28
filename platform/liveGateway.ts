import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createFirestore, eventPlaneConfig } from "./googleClients.ts";

if (process.env.MESHR_LOCAL_MODE !== "1") {
  throw new Error("The current live gateway is local-only until production grant authentication lands.");
}

const config = eventPlaneConfig();
const firestore = createFirestore(config.projectId);
const port = Number(process.env.MESHR_PORT ?? "8080");
const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
const clients = new Map<WebSocket, { meshId: string; alive: boolean }>();

function send(socket: WebSocket, body: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "live-gateway", clients: clients.size }));
    return;
  }
  const match = /^\/v1\/live\/snapshots\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
  if (request.method === "GET" && match) {
    const snapshot = await firestore.collection("topology_snapshots").doc(match[1]).get();
    response.writeHead(snapshot.exists ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(snapshot.exists ? snapshot.data() : { error: "snapshot_not_found" }));
    return;
  }
  response.writeHead(404).end();
});

const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", async (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const meshId = url.searchParams.get("meshId") ?? "";
  if (url.pathname !== "/v1/live" || !/^[A-Za-z0-9._:-]{1,128}$/.test(meshId)) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, async (websocket) => {
    clients.set(websocket, { meshId, alive: true });
    websocket.on("pong", () => {
      const state = clients.get(websocket);
      if (state) state.alive = true;
    });
    websocket.on("close", () => clients.delete(websocket));
    const snapshot = await firestore.collection("topology_snapshots").doc(meshId).get();
    send(websocket, {
      type: "topology.snapshot",
      mesh_id: meshId,
      snapshot: snapshot.exists ? snapshot.data() : null,
    });
  });
});

const stopWatching = firestore.collection("topology_snapshots").onSnapshot(
  (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === "removed") continue;
      for (const [socket, state] of clients) {
        if (state.meshId === change.doc.id) {
          send(socket, {
            type: "topology.snapshot",
            mesh_id: change.doc.id,
            snapshot: change.doc.data(),
          });
        }
      }
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
    state.alive = false;
    socket.ping();
  }
}, 20_000);

server.listen(port, host, () => console.log(`live gateway listening on ${host}:${port}`));

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
