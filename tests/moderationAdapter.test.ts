import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadModerationAdapterConfig } from "../moderation-adapter/config.ts";
import { GoogleModerationProvider } from "../moderation-adapter/googleProvider.ts";
import { createModerationAdapterServer } from "../moderation-adapter/server.ts";
import type {
  ModerationDecision,
  ModerationProvider,
  ModerationScreenRequest,
} from "../moderation-adapter/types.ts";

async function listen(provider: ModerationProvider, options: {
  requireCallerAuth?: boolean;
  environment?: "local" | "production";
  releaseSha?: string;
} = {}) {
  const server = createModerationAdapterServer({
    provider,
    environment: options.environment ?? "local",
    releaseSha: options.releaseSha,
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

test("production adapter health attests its exact release and contract", async (t) => {
  const releaseSha = "a".repeat(40);
  const provider: ModerationProvider = {
    health: async () => undefined,
    screen: async () => ({ action: "allow" }),
  };
  assert.throws(
    () => createModerationAdapterServer({ provider, environment: "production" }),
    /exact release SHA/,
  );
  assert.throws(
    () => createModerationAdapterServer({
      provider,
      environment: "production",
      releaseSha: "not-a-release",
    }),
    /exact release SHA/,
  );
  const { server, url } = await listen(provider, {
    environment: "production",
    releaseSha,
    requireCallerAuth: true,
  });
  t.after(() => server.close());

  for (const path of ["healthz", "readyz"]) {
    const response = await fetch(`${url}/${path}`, {
      headers: { authorization: "Bearer caller-id-token" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-meshr-contract-version"), "1");
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "meshr-moderation-adapter",
      releaseSha,
    });
  }
});

test("moderation adapter image bakes the public release witness", () => {
  const dockerfile = readFileSync(
    new URL("../deploy/images/moderation-adapter.Dockerfile", import.meta.url),
    "utf8",
  );
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    dockerfile,
    /ARG MESHR_MODERATION_RELEASE_SHA[\s\S]*\^\[a-f0-9\]\{40\}\$[\s\S]*org\.opencontainers\.image\.revision="\$MESHR_MODERATION_RELEASE_SHA"[\s\S]*MESHR_MODERATION_RELEASE_SHA="\$MESHR_MODERATION_RELEASE_SHA"/,
  );
  assert.match(
    workflow,
    /moderation-adapter\.Dockerfile[\s\S]*--build-arg "MESHR_MODERATION_RELEASE_SHA=\$GITHUB_SHA"/,
  );
  assert.match(
    workflow,
    /--provenance="mode=max,version=v1,builder-id=https:\/\/github\.com\/tflynn3\/meshr\/actions\/runs\/\$GITHUB_RUN_ID"/,
  );
  assert.match(workflow, /moby\/buildkit:v0\.32\.2@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8/);
  assert.match(workflow, /tonistiigi\/binfmt:qemu-v9\.2\.0-51@sha256:ea2f0dd74e74f101df59f9a6b31d0960994060c7982a921cbceecee0f1841125/);
  assert.match(
    workflow,
    /Scan every immutable runtime image manifest[\s\S]*trivy image[\s\S]*--platform "\$platform"[\s\S]*"\$child_ref"[\s\S]*length == 8/,
  );
  assert.match(workflow, /version: v0\.73\.0/);
  assert.match(workflow, /cosign sign --yes "\$REGISTRY\/\$IMAGE_REPOSITORY\/\$image@\$digest"/);
  assert.match(workflow, /bash scripts\/verify-moderation-adapter-image\.sh[\s\S]*Upload immutable release image receipt/);
  assert.match(workflow, /github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /github\.run_attempt\s*==\s*1/);
  assert.match(
    workflow,
    /repositoryId:"1348689949"[\s\S]*repositoryOwnerId:"19698887"[\s\S]*workflowRef:"tflynn3\/meshr\/\.github\/workflows\/ci\.yml@refs\/heads\/main"/,
  );
  assert.doesNotMatch(workflow, /^  (?:canary|promote):/m);
  assert.doesNotMatch(workflow, /GCP_(?:CANARY_)?DEPLOY_/);
  assert.doesNotMatch(workflow, /attestations:\s*write/);
  assert.doesNotMatch(workflow, /gcloud run|gcloud container/);
  assert.doesNotMatch(workflow, /kubectl (?:apply|patch|create|delete|rollout|wait|auth can-i)/);
});

test("production adapter configuration requires a matching Model Armor template", () => {
  const releaseSha = "a".repeat(40);
  const valid = loadModerationAdapterConfig({
    MESHR_ENV: "production",
    GOOGLE_CLOUD_PROJECT: "meshr-prod",
    MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    MESHR_DLP_LOCATION: "us-central1",
    MESHR_MODERATION_RELEASE_SHA: releaseSha,
  });
  assert.equal(valid.error, undefined);
  assert.equal(valid.config?.modelArmorEndpoint, "https://modelarmor.us-central1.rep.googleapis.com");
  assert.equal(valid.config?.dlpParent, "projects/meshr-prod/locations/us-central1");
  assert.equal(valid.config?.dlpEndpoint, "https://dlp.us-central1.rep.googleapis.com");
  assert.equal(valid.config?.releaseSha, releaseSha);

  const mixedCaseProduction = loadModerationAdapterConfig({
    MESHR_ENV: "Production",
    GOOGLE_CLOUD_PROJECT: "meshr-prod",
    MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    MESHR_DLP_LOCATION: "us-central1",
    MESHR_MODERATION_RELEASE_SHA: releaseSha,
  });
  assert.equal(mixedCaseProduction.error, undefined);
  assert.equal(mixedCaseProduction.config?.environment, "production");
  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "prod",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
      MESHR_DLP_LOCATION: "us-central1",
      MESHR_MODERATION_RELEASE_SHA: releaseSha,
    }).error,
    "environment_invalid",
  );

  const otherwiseValid = {
    MESHR_ENV: "production",
    GOOGLE_CLOUD_PROJECT: "meshr-prod",
    MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    MESHR_DLP_LOCATION: "us-central1",
  };
  assert.equal(loadModerationAdapterConfig(otherwiseValid).error, "release_sha_missing");
  assert.equal(
    loadModerationAdapterConfig({
      ...otherwiseValid,
      MESHR_MODERATION_RELEASE_SHA: "A".repeat(40),
    }).error,
    "release_sha_invalid",
  );

  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    }).error,
    "dlp_location_must_be_regional",
  );

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
      MESHR_DLP_LOCATION: "us-central1",
      MESHR_MODEL_ARMOR_ENDPOINT: "http://modelarmor.example.invalid",
    }).error,
    "model_armor_endpoint_must_use_https",
  );
  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
      MESHR_DLP_LOCATION: "us-central1",
      MESHR_MODEL_ARMOR_ENDPOINT: "https://evil.example.invalid",
    }).error,
    "model_armor_endpoint_host_invalid",
  );
  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
      MESHR_DLP_LOCATION: "us-central1",
      MESHR_DLP_ENDPOINT: "https://evil.example.invalid",
    }).error,
    "dlp_endpoint_host_invalid",
  );
  assert.equal(
    loadModerationAdapterConfig({
      MESHR_ENV: "production",
      GOOGLE_CLOUD_PROJECT: "meshr-prod",
      MESHR_MODEL_ARMOR_TEMPLATE: "projects/meshr-prod/locations/us-central1/templates/agent-text",
      MESHR_DLP_LOCATION: "us-central1",
      MESHR_DLP_ENDPOINT: "https://dlp.us-central1.rep.googleapis.com.evil.invalid",
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
    dlpEndpoint: "https://dlp.us-central1.rep.googleapis.com",
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
  assert.equal(new URL(dlpCall.url).hostname, "dlp.us-central1.rep.googleapis.com");
  assert.match(armorCall.url, /v1\/projects\/meshr-prod\/locations\/us-central1\/templates\/agent-text:sanitizeUserPrompt$/);
  assert.match(dlpCall.url, /v2\/projects\/meshr-prod\/locations\/us-central1\/content:inspect$/);
  assert.deepEqual(JSON.parse(armorCall.body ?? "{}"), {
    userPromptData: { text: "a small observation" },
    multiLanguageDetectionMetadata: {
      enableMultiLanguageDetection: true,
    },
  });
  assert.match(dlpCall.body ?? "", /CREDIT_CARD_NUMBER/);
});

test("Google provider fails closed when Model Armor does not complete", async () => {
  const provider = new GoogleModerationProvider({
    projectId: "meshr-prod",
    modelArmorEndpoint: "https://modelarmor.us-central1.rep.googleapis.com",
    modelArmorTemplate: "projects/meshr-prod/locations/us-central1/templates/agent-text",
    dlpEndpoint: "https://dlp.us-central1.rep.googleapis.com",
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
    dlpEndpoint: "https://dlp.us-central1.rep.googleapis.com",
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
    dlpEndpoint: "https://dlp.us-central1.rep.googleapis.com",
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
    dlpEndpoint: "https://dlp.us-central1.rep.googleapis.com",
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
