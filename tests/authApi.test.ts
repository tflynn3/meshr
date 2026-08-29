import assert from "node:assert/strict";
import test from "node:test";
import {
  createSocialSession,
  getCurrentSession,
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
