import assert from "node:assert/strict";
import test from "node:test";
import {
  actOnModerationCase,
  createSocialSession,
  getCurrentSession,
  linkSocialProvider,
  listMeshModerationCases,
  MeshrApiError,
} from "../src/auth/api.ts";

test("only an expired human session dispatches the browser session-expired event", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;
  const events: Event[] = [];
  (globalThis as { window?: unknown }).window = {
    dispatchEvent: (event: Event) => {
      events.push(event);
      return true;
    },
  };
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: "invalid_identity_token", message: "Re-authenticate." } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      () => createSocialSession({ provider: "google", idToken: "expired" }),
      (error: unknown) => error instanceof MeshrApiError && error.code === "invalid_identity_token",
    );
    assert.equal(events.length, 0);

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: "authentication_required", message: "Sign in." } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(
      () => getCurrentSession(),
      (error: unknown) => error instanceof MeshrApiError && error.code === "authentication_required",
    );
    assert.equal(events.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
});

test("social auth clients serialize matching GitHub provider proofs", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      requests.push({ path: String(input), init });
      return new Response(JSON.stringify({
        user: { id: "account-1", email: "owner@example.test", displayName: "Owner" },
        csrfToken: "csrf",
        sessionExpiresAt: "2026-09-03T00:00:00.000Z",
        identity: { provider: "github", email: "owner@example.test", linkedAt: "2026-09-02T00:00:00.000Z" },
      }), { headers: { "Content-Type": "application/json" } });
    };

    await createSocialSession({
      provider: "github",
      idToken: "target-id",
      providerAccessToken: "target-access",
      state: "oauth-state",
    });
    await linkSocialProvider({
      provider: "github",
      idToken: "target-id",
      providerAccessToken: "target-access",
      currentProvider: "google",
      currentIdToken: "current-id",
      csrfToken: "csrf",
    });
    await linkSocialProvider({
      provider: "google",
      idToken: "target-google-id",
      currentProvider: "github",
      currentIdToken: "current-github-id",
      currentProviderAccessToken: "current-github-access",
      csrfToken: "csrf",
    });

    assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
      provider: "github",
      idToken: "target-id",
      providerAccessToken: "target-access",
      state: "oauth-state",
    });
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
      provider: "github",
      idToken: "target-id",
      providerAccessToken: "target-access",
      currentProvider: "google",
      currentIdToken: "current-id",
    });
    assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
      provider: "google",
      idToken: "target-google-id",
      currentProvider: "github",
      currentIdToken: "current-github-id",
      currentProviderAccessToken: "current-github-access",
    });
    assert.equal(new Headers(requests[1]?.init?.headers).get("X-Meshr-CSRF"), "csrf");
    assert.equal(new Headers(requests[2]?.init?.headers).get("X-Meshr-CSRF"), "csrf");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("moderation clients scope reads and protect actions with CSRF and idempotency", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = async (input, init) => {
      requests.push({ path: String(input), init });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ cases: [], nextCursor: null }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        id: "case/1",
        postId: "post-1",
        meshId: "mesh/private",
        reason: "credential-like text",
        state: "resolved",
        severity: "high",
        resolution: "quarantine",
        createdAt: "2026-08-30T00:00:00.000Z",
        updatedAt: "2026-08-30T00:01:00.000Z",
        resolvedAt: "2026-08-30T00:01:00.000Z",
        post: null,
      }), { headers: { "Content-Type": "application/json" } });
    };

    await listMeshModerationCases("mesh/private", {
      state: "appealed",
      after: "cursor/1",
      limit: 3,
    });
    await actOnModerationCase(
      "mesh/private",
      "case/1",
      { action: "quarantine", idempotencyKey: "moderation-retry-1" },
      "csrf-token",
    );

    assert.equal(
      requests[0]?.path,
      "/v1/meshes/mesh%2Fprivate/moderation?state=appealed&after=cursor%2F1&limit=3",
    );
    assert.equal(requests[0]?.init?.method, undefined);
    assert.equal(
      requests[1]?.path,
      "/v1/meshes/mesh%2Fprivate/moderation/case%2F1",
    );
    assert.equal(requests[1]?.init?.method, "POST");
    const headers = new Headers(requests[1]?.init?.headers);
    assert.equal(headers.get("X-Meshr-CSRF"), "csrf-token");
    assert.equal(headers.get("Idempotency-Key"), "moderation-retry-1");
    assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), { action: "quarantine" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
