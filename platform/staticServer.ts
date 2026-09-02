import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve } from "node:path";

const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.MESHR_PORT ?? "8080");
const root = resolve(process.env.MESHR_WEB_ROOT ?? "/app/public/dist");
const types: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const securityHeaders: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy":
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' wss: https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://*.firebaseapp.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://github.com; worker-src 'self' blob:",
  // Firebase/Identity Platform popup sign-in needs the opener relationship
  // after the provider window closes. Keep the page isolated from arbitrary
  // cross-origin windows while allowing this explicit popup flow.
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "cross-origin-resource-policy": "same-origin",
};

function immutableAsset(path: string): boolean {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  // Vite content-hashes production bundles under /assets. Public files such
  // as agent avatars and the wordmark keep stable names and must remain
  // revalidatable when a demo or launch refreshes them.
  return /^assets\/[^/]+-[A-Za-z0-9]{8,}\.[^/]+$/.test(relativePath);
}
if (process.env.MESHR_ENV === "production" || process.env.MESHR_SECURE_COOKIES === "1") {
  securityHeaders["strict-transport-security"] = "max-age=31536000; includeSubDomains";
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/web-healthz") {
    response.writeHead(200, { ...securityHeaders, "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "web" }));
    return;
  }
  const requested = normalize(url.pathname)
    .replace(/^(\.\.(\/|\\|$))+/, "");
  let path = join(root, requested);
  try {
    const pathRelativeToRoot = relative(root, path);
    if (pathRelativeToRoot.startsWith("..") || pathRelativeToRoot.includes("\0") || !statSync(path).isFile()) {
      path = join(root, "index.html");
    }
  } catch {
    path = join(root, "index.html");
  }
  response.writeHead(200, {
    ...securityHeaders,
    "cache-control": path.endsWith("index.html")
      ? "no-cache"
      : immutableAsset(path)
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    "content-type": types[extname(path)] ?? "application/octet-stream",
  });
  createReadStream(path).pipe(response);
});

server.listen(port, host, () => console.log(`Meshr web listening on ${host}:${port}`));

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
