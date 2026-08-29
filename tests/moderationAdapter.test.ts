import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { loadModerationAdapterConfig } from "../moderation-adapter/config.ts";
import { GoogleModerationProvider } from "../moderation-adapter/googleProvider.ts";
import { createModerationAdapterServer } from "../moderation-adapter/server.ts";
import type {
  ModerationDecision,
  ModerationProvider,
  ModerationScreenRequest,
} from "../moderation-adapter/types.ts";

async function listen(provider: ModerationProvider, options: { requireCallerAuth?: boolean } = {}) {
  const server = createModerationAdapterServer({
    provider,
    environment: "local",
    requireCallerAuth: options.requireCallerAuth,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

test("moderation adapter authenticates, bounds, and delegates screen requests", async (t) => {
  const requests: ModerationScreenRequest[] = [];
  const decision: ModerationDecision = {
    action: "quarantine",
    reason: "model_armor_filter_match",
    severity: "high",
  };
  const provider: ModerationProvider = {
    health: async () => undefined,
    screen: async (input) => {
      requests.push(input);
      return decision;
    },
  };
  const { server, url } = await listen(provider, { requireCallerAuth: true });
  t.after(() => server.close());

  const unauthenticated = await fetch(`${url}/screen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postId: "post-1", text: "hello" }),
  });
  assert.equal(unauthenticated.status, 401);

  const screened = await fetch(`${url}/screen`, {
    method: "POST",
    headers: {
      authorization: "Bearer caller-id-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ postId: "post-1", meshId: "mesh-1", agentId: "agent-1", text: "hello" }),
  });
  assert.equal(screened.status, 200);
  assert.equal(screened.headers.get("x-meshr-contract-version"), "1");
  assert.deepEqual(await screened.json(), decision);
  assert.deepEqual(requests, [{ postId: "post-1", meshId: "mesh-1", agentId: "agent-1", text: "hello" }]);

  const oversized = await fetch(`${url}/screen`, {
    method: "POST",
    headers: {
      authorization: "Bearer caller-id-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ postId: "post-2", text: "x".repeat(1_201) }),
  });
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: { code: "text_invalid" } });
});

test("moderation adapter rejects incompatible contract majors", async (t) => {
  const provider: ModerationProvider = {
    health: async () => undefined,
    screen: async () => ({ action: "allow" }),
  };
  const { server, url } = await listen(provider);
  t.after(() => server.close());

  const response = await fetch(`${url}/screen`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-meshr-contract-version": "2",
    },
    body: JSON.stringify({ postId: "post-1", text: "hello" }),
  });
  assert.equal(response.status, 426);
  assert.equal(response.headers.get("x-meshr-contract-version"), "1");
  assert.deepEqual(await response.json(), {
    error: {
      code: "incompatible_contract",
      message: "This moderation adapter requires contract major 1; upgrade the client integration.",
    },
  });
});

test("moderation adapter health is authenticated and fails closed on provider errors", async (t) => {
  let healthCalls = 0;
  const provider: ModerationProvider = {
    health: async () => {
      healthCalls += 1;
      throw new Error("provider down");
    },
    screen: async () => ({ action: "allow" }),
  };
  const { server, url } = await listen(provider, { requireCallerAuth: true });
  t.after(() => server.close());

  assert.equal((await fetch(`${url}/healthz`)).status, 401);
  const response = await fetch(`${url}/healthz`, {
    headers: { authorization: "Bearer caller-id-token" },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: "provider_unavailable" } });
  assert.equal(healthCalls, 1);
});

test("production adapter configuration requires a matching Model Armor template", () => {
  const valid = loadModerationAdapterConfig({
    MESHR_ENV: "production",
    GOOGLE_CLOUD_PROJECT: "meshr-prod",
    MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    MESHR_DLP_LOCATION: "us-central1",
  });
  assert.equal(valid.error, undefined);
  assert.equal(valid.config?.modelArmorEndpoint, "https://modelarmor.us-central1.rep.googleapis.com");
  assert.equal(valid.config?.dlpParent, "projects/meshr-prod/locations/us-central1");

  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/other/locations/us-central1/templates/agent-text",
    }).error,
    "model_armor_template_project_mismatch",
  );
  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
      MESHR_MODEL_ARMOR_ENDPOINT: "http://modelarmor.example.invalid",
    }).error,
    "model_armor_endpoint_must_use_https",
  );
  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
      MESHR_MODEL_ARMOR_ENDPOINT: "https://evil.example.invalid",
    }).error,
    "model_armor_endpoint_host_invalid",
  );
  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
      MESHR_DLP_ENDPOINT: "https://evil.example.invalid",
    }).error,
    "dlp_endpoint_host_invalid",
  );
});

test("Google provider calls Model Armor and DLP without exposing provider responses", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const provider = new GoogleModerationProvider({
    projectId: "meshr-prod",
    modelArmorEndpoint: "https://modelarmor.us-central1.rep.googleapis.com",
    modelArmorTemplate: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    dlpEndpoint: "https://dlp.googleapis.com",
    dlpParent: "projects/meshr-prod/locations/us-central1",
    accessToken: async () => "adapter-access-token",
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : undefined });
      if (String(input).includes("sanitizeUserPrompt")) {
        return new Response(JSON.stringify({
          sanitizationResult: { filterMatchState: "NO_MATCH_FOUND", invocationResult: "SUCCESS" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { findings: [] } }), { status: 200 });
    }) as typeof fetch,
  });
  const result = await provider.screen({
    postId: "post-1",
    meshId: "mesh-1",
    agentId: "agent-1",
    text: "a small observation",
  });
  assert.deepEqual(result, { action: "allow", reason: "provider_checks_passed", severity: "low" });
  assert.equal(calls.length, 2);
  const armorCall = calls.find((call) => call.url.includes("sanitizeUserPrompt"));
  const dlpCall = calls.find((call) => call.url.endsWith(":inspect"));
  assert.ok(armorCall);
  assert.ok(dlpCall);
  assert.match(armorCall.url, /v1\/projects\/meshr-prod\/locations\/us-central1\/templates\/agent-text:sanitizeUserPrompt$/);
  assert.match(dlpCall.url, /v2\/projects\/meshr-prod\/locations\/us-central1\/content:inspect$/);
  assert.match(armorCall.body ?? "", /a small observation/);
  assert.match(dlpCall.body ?? "", /CREDIT_CARD_NUMBER/);
});

test("Google provider fails closed when Model Armor does not complete", async () => {
  const provider = new GoogleModerationProvider({
    projectId: "meshr-prod",
    modelArmorEndpoint: "https://modelarmor.us-central1.rep.googleapis.com",
    modelArmorTemplate: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    dlpEndpoint: "https://dlp.googleapis.com",
    dlpParent: "projects/meshr-prod/locations/us-central1",
    accessToken: async () => "adapter-access-token",
    fetchImpl: (async (input) => {
      if (String(input).includes("sanitizeUserPrompt")) {
        return new Response(JSON.stringify({
          sanitizationResult: { filterMatchState: "NO_MATCH_FOUND", invocationResult: "PARTIAL" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { findings: [] } }), { status: 200 });
    }) as typeof fetch,
  });
  await assert.rejects(
    provider.screen({ postId: "post-1", meshId: null, agentId: null, text: "hello" }),
    /model_armor_invocation_failed/,
  );
});

test("Google provider rejects an incomplete Model Armor result", async () => {
  const provider = new GoogleModerationProvider({
    projectId: "meshr-prod",
    modelArmorEndpoint: "https://modelarmor.us-central1.rep.googleapis.com",
    modelArmorTemplate: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    dlpEndpoint: "https://dlp.googleapis.com",
    dlpParent: "projects/meshr-prod/locations/us-central1",
    accessToken: async () => "adapter-access-token",
    fetchImpl: (async (input) => {
      if (String(input).includes("sanitizeUserPrompt")) {
        return new Response(JSON.stringify({
          sanitizationResult: { invocationResult: "SUCCESS" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { findings: [] } }), { status: 200 });
    }) as typeof fetch,
  });
  await assert.rejects(
    provider.screen({ postId: "post-1", meshId: null, agentId: null, text: "hello" }),
    /model_armor_response_invalid/,
  );
});

test("Google provider rejects a missing DLP result", async () => {
  const provider = new GoogleModerationProvider({
    projectId: "meshr-prod",
    modelArmorEndpoint: "https://modelarmor.us-central1.rep.googleapis.com",
    modelArmorTemplate: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    dlpEndpoint: "https://dlp.googleapis.com",
    dlpParent: "projects/meshr-prod/locations/us-central1",
    accessToken: async () => "adapter-access-token",
    fetchImpl: (async (input) => {
      if (String(input).includes("sanitizeUserPrompt")) {
        return new Response(JSON.stringify({
          sanitizationResult: { filterMatchState: "NO_MATCH_FOUND", invocationResult: "SUCCESS" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch,
  });
  await assert.rejects(
    provider.screen({ postId: "post-1", meshId: null, agentId: null, text: "hello" }),
    /dlp_response_invalid/,
  );
});

test("Google provider readiness uses screening endpoints", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const provider = new GoogleModerationProvider({
    projectId: "meshr-prod",
    modelArmorEndpoint: "https://modelarmor.us-central1.rep.googleapis.com",
    modelArmorTemplate: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    dlpEndpoint: "https://dlp.googleapis.com",
    dlpParent: "projects/meshr-prod/locations/us-central1",
    accessToken: async () => "adapter-access-token",
    fetchImpl: (async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      if (String(input).includes("sanitizeUserPrompt")) {
        return new Response(JSON.stringify({
          sanitizationResult: { filterMatchState: "NO_MATCH_FOUND", invocationResult: "SUCCESS" },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ result: { findings: [] } }), { status: 200 });
    }) as typeof fetch,
  });
  await provider.health();
  assert.deepEqual(calls.map(({ url, method }) => ({
    path: new URL(url).pathname,
    method,
  })), [
    {
      path: "/v1/projects/meshr-prod/locations/us-central1/templates/agent-text:sanitizeUserPrompt",
      method: "POST",
    },
    {
      path: "/v2/projects/meshr-prod/locations/us-central1/content:inspect",
      method: "POST",
    },
  ]);
});
