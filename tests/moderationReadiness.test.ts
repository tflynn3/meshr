import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createModerationReadinessProbe,
  moderationReadinessConfigError,
} from "../platform/moderationReadiness.ts";

test("mandatory moderation readiness probes an authenticated health endpoint and caches success", async () => {
  let calls = 0;
  let authorizationCalls = 0;
  const probe = createModerationReadinessProbe({
    endpoint: "https://moderation.example.test/screen",
    healthcheckUrl: "https://moderation.example.test/healthz",
    auth: "static",
    token: "provider-token",
    required: true,
    environment: "production",
    authorization: async () => {
      authorizationCalls += 1;
      return "provider-token";
    },
    fetchImpl: (async (input, init) => {
      calls += 1;
      assert.equal(String(input), "https://moderation.example.test/healthz");
      assert.equal((init?.headers as Headers).get("authorization"), "Bearer provider-token");
      return { ok: true, status: 204 } as Response;
    }) as typeof fetch,
    cacheMs: 5_000,
  });

  assert.equal(probe.configError, undefined);
  assert.deepEqual(await probe.check(), { ok: true });
  assert.deepEqual(await probe.check(), { ok: true });
  assert.equal(calls, 1);
  assert.equal(authorizationCalls, 1);
});

test("mandatory moderation readiness rejects incomplete or insecure production configuration", () => {
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "http://moderation.example.test/screen",
      healthcheckUrl: "http://moderation.example.test/healthz",
      auth: "adc",
      required: true,
      environment: "production",
    }),
    "moderation_endpoint_must_use_https",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "https://moderation.example.test/screen",
      healthcheckUrl: undefined,
      auth: "adc",
      required: true,
      environment: "production",
    }),
    "moderation_healthcheck_url_missing",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "https://moderation.example.test/screen",
      healthcheckUrl: "https://moderation.example.test/healthz",
      auth: "none",
      required: true,
      environment: "production",
    }),
    "moderation_auth_required",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "https://moderation.example.test/screen",
      healthcheckUrl: "https://health.example.test/healthz",
      auth: "adc",
      tokenType: "id_token",
      audience: "https://moderation.example.test",
      required: true,
      environment: "production",
    }),
    "moderation_urls_origin_mismatch",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "https://moderation.example.test/screen",
      healthcheckUrl: "https://moderation.example.test/healthz",
      auth: "adc",
      tokenType: "id_token",
      required: true,
      environment: "production",
    }),
    "moderation_audience_missing",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "https://moderation.example.test/screen",
      healthcheckUrl: "https://moderation.example.test/healthz",
      auth: "adc",
      tokenType: "access_token",
      required: true,
      environment: "production",
    }),
    "moderation_access_token_endpoint_not_allowed",
  );
});

test("moderation readiness fails closed when ADC or the provider is unavailable", async () => {
  const authFailure = createModerationReadinessProbe({
    endpoint: "https://moderation.example.test/screen",
    healthcheckUrl: "https://moderation.example.test/healthz",
    auth: "adc",
    tokenType: "id_token",
    audience: "https://moderation.example.test",
    required: true,
    environment: "production",
    authorization: async () => undefined,
    fetchImpl: (async () => {
      throw new Error("must not call provider without a token");
    }) as typeof fetch,
  });
  assert.deepEqual(await authFailure.check(), {
    ok: false,
    error: "moderation_provider_auth_unavailable",
  });

  const providerFailure = createModerationReadinessProbe({
    endpoint: "https://moderation.example.test/screen",
    healthcheckUrl: "https://moderation.example.test/healthz",
    auth: "adc",
    tokenType: "id_token",
    audience: "https://moderation.example.test",
    required: true,
    environment: "production",
    authorization: async () => "short-lived-token",
    fetchImpl: (async () => ({ ok: false, status: 503 })) as typeof fetch,
  });
  assert.deepEqual(await providerFailure.check(), {
    ok: false,
    error: "moderation_provider_unreachable",
  });
});

test("optional moderation readiness remains permissive for local topology workers", async () => {
  const probe = createModerationReadinessProbe({
    endpoint: undefined,
    healthcheckUrl: undefined,
    auth: "none",
    required: false,
    environment: "local",
    authorization: async () => undefined,
  });
  assert.equal(probe.configError, undefined);
  assert.deepEqual(await probe.check(), { ok: true });
});
