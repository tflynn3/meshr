import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    healthcheckUrl: "https://moderation.example.test/health",
    auth: "static",
    token: "provider-token",
    required: true,
    environment: "local",
    authorization: async () => {
      authorizationCalls += 1;
      return "provider-token";
    },
    fetchImpl: (async (input, init) => {
      calls += 1;
      assert.equal(String(input), "https://moderation.example.test/health");
      assert.equal((init?.headers as Headers).get("authorization"), "Bearer provider-token");
      assert.equal((init?.headers as Headers).get("x-meshr-contract-version"), "1");
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
  const releaseSha = "a".repeat(40);
  const revisionTag = `r-${releaseSha.slice(0, 20)}`;
  const audience =
    "https://meshr-moderation-adapter-123456789012.us-central1.run.app";
  const taggedOrigin = `https://${revisionTag}---meshr-moderation-adapter-123456789012.us-central1.run.app`;
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "http://moderation.example.test/screen",
      healthcheckUrl: "http://moderation.example.test/health",
      auth: "adc",
      required: true,
      environment: "production",
    }),
    "moderation_endpoint_must_use_https",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: `${taggedOrigin}/screen`,
      healthcheckUrl: `${taggedOrigin}/health`,
      auth: "static",
      token: "provider-token",
      audience,
      revisionTag,
      releaseSha,
      required: true,
      environment: "production",
    }),
    "moderation_production_auth_invalid",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: `${taggedOrigin}/screen`,
      healthcheckUrl: `${taggedOrigin}/health`,
      auth: "adc",
      token: "stale-static-token",
      tokenType: "id_token",
      audience,
      revisionTag,
      releaseSha,
      required: true,
      environment: "production",
    }),
    "moderation_production_token_invalid",
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
      healthcheckUrl: "https://moderation.example.test/health",
      auth: "none",
      required: true,
      environment: "production",
    }),
    "moderation_auth_required",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "https://moderation.example.test/screen",
      healthcheckUrl: "https://health.example.test/health",
      auth: "adc",
      tokenType: "id_token",
      audience,
      revisionTag,
      releaseSha,
      required: true,
      environment: "production",
    }),
    "moderation_urls_origin_mismatch",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "https://moderation.example.test/screen",
      healthcheckUrl: "https://moderation.example.test/health",
      auth: "adc",
      tokenType: "id_token",
      required: true,
      environment: "production",
    }),
    "moderation_audience_missing",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: `${taggedOrigin}/screen`,
      healthcheckUrl: `${taggedOrigin}/health`,
      auth: "adc",
      tokenType: "id_token",
      audience,
      releaseSha,
      required: true,
      environment: "production",
    }),
    "moderation_revision_tag_missing",
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: `${taggedOrigin}/screen`,
      healthcheckUrl: `${taggedOrigin}/health`,
      auth: "adc",
      tokenType: "id_token",
      audience,
      revisionTag: `r-${"b".repeat(20)}`,
      releaseSha,
      required: true,
      environment: "production",
    }),
    "moderation_revision_tag_mismatch",
  );
  const exactTaggedConfig = {
    endpoint: `${taggedOrigin}/screen`,
    healthcheckUrl: `${taggedOrigin}/health`,
    auth: "adc" as const,
    tokenType: "id_token" as const,
    audience,
    revisionTag,
    releaseSha,
    required: true,
    environment: "production",
  };
  assert.equal(moderationReadinessConfigError(exactTaggedConfig), undefined);
  for (const reservedPath of ["healthz", "readyz"]) {
    assert.equal(
      moderationReadinessConfigError({
        ...exactTaggedConfig,
        healthcheckUrl: `${taggedOrigin}/${reservedPath}`,
      }),
      "moderation_revision_url_mismatch",
    );
  }
  assert.equal(
    revisionTag.length + 3 + new URL(audience).hostname.split(".")[0]!.length,
    62,
  );
  assert.equal(
    moderationReadinessConfigError({
      ...exactTaggedConfig,
      environment: "Production",
    }),
    undefined,
  );
  assert.equal(
    moderationReadinessConfigError({
      ...exactTaggedConfig,
      environment: "prod",
    }),
    "moderation_environment_invalid",
  );
  assert.equal(
    moderationReadinessConfigError({
      ...exactTaggedConfig,
      revisionTag: `r-${releaseSha.slice(0, 14)}`,
      endpoint: `https://r-${releaseSha.slice(0, 14)}---${audience.slice("https://".length)}/screen`,
      healthcheckUrl: `https://r-${releaseSha.slice(0, 14)}---${audience.slice("https://".length)}/health`,
    }),
    "moderation_revision_tag_mismatch",
  );
  for (const [overrides, expected] of [
    [
      {
        endpoint: `${audience}/screen`,
        healthcheckUrl: `${audience}/health`,
      },
      "moderation_revision_url_mismatch",
    ],
    [
      {
        endpoint: `https://r-${"b".repeat(20)}---meshr-moderation-adapter-123456789012.us-central1.run.app/screen`,
        healthcheckUrl: `https://r-${"b".repeat(20)}---meshr-moderation-adapter-123456789012.us-central1.run.app/health`,
      },
      "moderation_revision_url_mismatch",
    ],
    [
      {
        endpoint: `https://${revisionTag}---foreign-123456789012.us-central1.run.app/screen`,
        healthcheckUrl: `https://${revisionTag}---foreign-123456789012.us-central1.run.app/health`,
      },
      "moderation_revision_url_mismatch",
    ],
    [
      { endpoint: `${taggedOrigin}/screen?redirect=1` },
      "moderation_revision_url_mismatch",
    ],
    [
      {
        endpoint: `https://user@${revisionTag}---meshr-moderation-adapter-123456789012.us-central1.run.app/screen`,
      },
      "moderation_endpoint_invalid",
    ],
    [
      {
        endpoint: `https://${revisionTag}---meshr-moderation-adapter-123456789012.us-central1.run.app:8443/screen`,
        healthcheckUrl: `https://${revisionTag}---meshr-moderation-adapter-123456789012.us-central1.run.app:8443/health`,
      },
      "moderation_revision_url_mismatch",
    ],
    [{ audience: `${audience}:8443` }, "moderation_audience_invalid"],
    [
      {
        audience: `https://${revisionTag}---meshr-moderation-adapter-123456789012.us-central1.run.app`,
      },
      "moderation_audience_invalid",
    ],
    [
      {
        audience: audience.replace("https://", "https://xx"),
        endpoint: `${taggedOrigin.replace("---", "---xx")}/screen`,
        healthcheckUrl: `${taggedOrigin.replace("---", "---xx")}/health`,
      },
      "moderation_audience_invalid",
    ],
  ] as const) {
    assert.equal(
      moderationReadinessConfigError({ ...exactTaggedConfig, ...overrides }),
      expected,
    );
  }
  const canaryReleaseSha = "b".repeat(40);
  const canaryTag = `r-${canaryReleaseSha.slice(0, 14)}`;
  const canaryAudience =
    "https://meshr-moderation-adapter-canary-123456789012.us-central1.run.app";
  const canaryTaggedOrigin = `https://${canaryTag}---${canaryAudience.slice("https://".length)}`;
  assert.equal(
    canaryTag.length +
      3 +
      new URL(canaryAudience).hostname.split(".")[0]!.length,
    63,
  );
  assert.equal(
    moderationReadinessConfigError({
      ...exactTaggedConfig,
      releaseSha: canaryReleaseSha,
      revisionTag: canaryTag,
      audience: canaryAudience,
      endpoint: `${canaryTaggedOrigin}/screen`,
      healthcheckUrl: `${canaryTaggedOrigin}/health`,
    }),
    undefined,
  );
  assert.equal(
    moderationReadinessConfigError({
      endpoint: "https://moderation.example.test/screen",
      healthcheckUrl: "https://moderation.example.test/health",
      auth: "adc",
      tokenType: "access_token",
      required: true,
      environment: "production",
    }),
    "moderation_id_token_required",
  );
});

test("ADC moderation never substitutes an injected static token", () => {
  const source = readFileSync(
    new URL("../platform/materializer.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /if \(moderationAuth === "static"\) return moderationToken;\s+if \(moderationAuth !== "adc"\) return undefined;/,
  );
  assert.doesNotMatch(source, /if \(moderationToken\) return moderationToken;/);
});

test("moderation readiness fails closed when ADC or the provider is unavailable", async () => {
  const releaseSha = "a".repeat(40);
  const revisionTag = `r-${releaseSha.slice(0, 20)}`;
  const audience =
    "https://meshr-moderation-adapter-123456789012.us-central1.run.app";
  const taggedOrigin = `https://${revisionTag}---meshr-moderation-adapter-123456789012.us-central1.run.app`;
  const authFailure = createModerationReadinessProbe({
    endpoint: `${taggedOrigin}/screen`,
    healthcheckUrl: `${taggedOrigin}/health`,
    auth: "adc",
    tokenType: "id_token",
    audience,
    revisionTag,
    releaseSha,
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
    endpoint: `${taggedOrigin}/screen`,
    healthcheckUrl: `${taggedOrigin}/health`,
    auth: "adc",
    tokenType: "id_token",
    audience,
    revisionTag,
    releaseSha,
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

test("production moderation readiness attests the adapter contract and release", async () => {
  const releaseSha = "a".repeat(40);
  const revisionTag = `r-${releaseSha.slice(0, 20)}`;
  const audience =
    "https://meshr-moderation-adapter-123456789012.us-central1.run.app";
  const taggedOrigin = `https://${revisionTag}---meshr-moderation-adapter-123456789012.us-central1.run.app`;
  const makeProbe = (response: Response, environment = "production") =>
    createModerationReadinessProbe({
      endpoint: `${taggedOrigin}/screen`,
      healthcheckUrl: `${taggedOrigin}/health`,
      auth: "adc",
      tokenType: "id_token",
      audience,
      revisionTag,
      releaseSha,
      required: true,
      environment,
      authorization: async () => "short-lived-token",
      fetchImpl: (async () => response) as typeof fetch,
    });
  const response = (body: string, contractVersion = "1") =>
    new Response(body, {
      status: 200,
      headers: { "x-meshr-contract-version": contractVersion },
    });
  const exactBody = JSON.stringify({
    ok: true,
    service: "meshr-moderation-adapter",
    releaseSha,
  });

  assert.deepEqual(await makeProbe(response(exactBody)).check(), { ok: true });
  assert.deepEqual(
    await makeProbe(response(exactBody, "2"), "Production").check(),
    {
      ok: false,
      error: "moderation_provider_unreachable",
    },
  );
  for (const candidate of [
    response(exactBody, "2"),
    response(
      JSON.stringify({
        ok: true,
        service: "meshr-moderation-adapter",
        releaseSha: "b".repeat(40),
      }),
    ),
    response(JSON.stringify({ ok: true, releaseSha })),
    response("not-json"),
  ]) {
    assert.deepEqual(await makeProbe(candidate).check(), {
      ok: false,
      error: "moderation_provider_unreachable",
    });
  }
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
