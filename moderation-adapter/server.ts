import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { adapterOptionsFromConfig, loadModerationAdapterConfig } from "./config.ts";
import { GoogleModerationProvider } from "./googleProvider.ts";
import type {
  ModerationAdapterOptions,
  ModerationProvider,
  ModerationScreenRequest,
} from "./types.ts";

const MAX_TEXT_LENGTH = 1_200;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function logRequest(path: string, status: number): void {
  // Never log request bodies, provider tokens, or provider responses.
  console.log(JSON.stringify({
    component: "meshr-moderation-adapter",
    event: "moderation.adapter_request",
    path,
    status,
  }));
}

function authorized(request: IncomingMessage, options: ModerationAdapterOptions): boolean {
  if (!options.requireCallerAuth) return true;
  const header = request.headers.authorization;
  return typeof header === "string" && /^Bearer\s+\S+$/i.test(header);
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new Error("request_body_required");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request_json_invalid");
  }
}

function screenRequest(value: unknown): ModerationScreenRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request_invalid");
  const input = value as Record<string, unknown>;
  const postId = typeof input.postId === "string" ? input.postId.trim() : "";
  const meshId = input.meshId == null ? null : typeof input.meshId === "string" ? input.meshId.trim() : "";
  const agentId = input.agentId == null ? null : typeof input.agentId === "string" ? input.agentId.trim() : "";
  const text = typeof input.text === "string" ? input.text : "";
  if (!postId || (input.meshId != null && !meshId) || (input.agentId != null && !agentId)) {
    throw new Error("request_invalid");
  }
  if (!text || text.length > MAX_TEXT_LENGTH) throw new Error("text_invalid");
  return { postId, meshId, agentId, text };
}

export function createModerationAdapterServer(options: ModerationAdapterOptions): Server {
  const maxBodyBytes = Math.max(2_048, Math.min(64 * 1024, Math.trunc(options.maxBodyBytes ?? 16 * 1024)));
  return createServer(async (request, response) => {
    const path = (request.url ?? "").split("?", 1)[0] || "/";
    if (request.method === "GET" && (path === "/healthz" || path === "/readyz")) {
      if (!authorized(request, options)) {
        logRequest(path, 401);
        json(response, 401, { error: { code: "authentication_required" } });
        return;
      }
      try {
        await options.provider.health();
        logRequest(path, 200);
        json(response, 200, { ok: true, service: "meshr-moderation-adapter" });
      } catch {
        logRequest(path, 503);
        json(response, 503, { error: { code: "provider_unavailable" } });
      }
      return;
    }
    if (request.method !== "POST" || path !== "/screen") {
      logRequest(path, 404);
      json(response, 404, { error: { code: "not_found" } });
      return;
    }
    if (!authorized(request, options)) {
      logRequest(path, 401);
      json(response, 401, { error: { code: "authentication_required" } });
      return;
    }
    try {
      const input = screenRequest(await readBody(request, maxBodyBytes));
      const decision = await options.provider.screen(input);
      logRequest(path, 200);
      json(response, 200, decision);
    } catch (error) {
      const code = error instanceof Error && ["request_too_large", "request_body_required", "request_json_invalid", "request_invalid", "text_invalid"].includes(error.message)
        ? error.message
        : "provider_unavailable";
      const status = code === "provider_unavailable" ? 503 : 400;
      logRequest(path, status);
      json(response, status, { error: { code } });
    }
  });
}

async function main(): Promise<void> {
  const parsed = loadModerationAdapterConfig();
  if (!parsed.config) throw new Error(`moderation adapter configuration failed: ${parsed.error}`);
  const config = parsed.config;
  const provider: ModerationProvider = new GoogleModerationProvider({
    projectId: config.projectId,
    modelArmorEndpoint: config.modelArmorEndpoint,
    modelArmorTemplate: config.modelArmorTemplate,
    dlpEndpoint: config.dlpEndpoint,
    dlpParent: config.dlpParent,
    timeoutMs: config.timeoutMs,
  });
  const server = createModerationAdapterServer(adapterOptionsFromConfig(config, provider));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  console.log(JSON.stringify({
    component: "meshr-moderation-adapter",
    event: "moderation.adapter_started",
    port: config.port,
    environment: config.environment,
  }));
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
