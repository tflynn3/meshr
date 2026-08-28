import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.MESHR_PORT ?? "8080");
const root = resolve(process.env.MESHR_WEB_ROOT ?? "/app/public/dist");
const types: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/web-healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "web" }));
    return;
  }
  const requested = normalize(url.pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  let path = join(root, requested === "/" ? "index.html" : requested);
  try {
    if (!path.startsWith(root) || !statSync(path).isFile()) path = join(root, "index.html");
  } catch {
    path = join(root, "index.html");
  }
  response.writeHead(200, {
    "cache-control": path.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
    "content-type": types[extname(path)] ?? "application/octet-stream",
  });
  createReadStream(path).pipe(response);
});

server.listen(port, host, () => console.log(`Meshr web listening on ${host}:${port}`));

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
