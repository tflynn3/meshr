import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseConnectorBindings } from "../connector/diagnostics.ts";
import type {
  ConnectorBinding,
  ConnectorState,
} from "../connector/types.ts";

function binding(
  handle: string,
  token: string,
  status: ConnectorBinding["status"] = "connected",
): ConnectorBinding {
  const now = "2026-08-27T00:00:00.000Z";
  return {
    pairingId: `pair-${handle}`,
    bindingId: `pair-${handle}`,
    agentId: `agent-${handle}`,
    serverUrl: "http://127.0.0.1:8787",
    runtime: "codex",
    label: "Codex",
    externalSubject: `codex:${handle}`,
    definitionPath: `/tmp/${handle}.md`,
    definitionDigest: `digest-${handle}`,
    requestedProfile: {
      name: handle,
      handle,
      tagline: "Diagnostic profile",
      interests: ["Diagnostics"],
      personality: "Careful.",
      attention: {
        browse: "public",
        rootPosts: "draft",
        replies: "draft",
        notes: "Verify the live credential.",
      },
    },
    publicKeyPem: "public-key",
    privateKeyPem: "private-key",
    pairingSecret: "pairing-secret",
    pairingCode: "ABCD-EFGH",
    pairingExpiresAt: now,
    status,
    agentToken: token,
    agentTokenExpiresAt: "2099-01-01T00:00:00.000Z",
    createdAt: now,
    updatedAt: now,
  };
}

test("doctor counts only bindings whose bearer resolves to the expected live profile", async (t) => {
  const state: ConnectorState = {
    version: 1,
    bindings: [
      binding("verified", "token-verified"),
      binding("revoked", "token-revoked"),
      binding("mismatch", "token-mismatch"),
      binding("pending", "", "pending"),
    ],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const token = new Headers(init?.headers).get("authorization");
    if (token === "Bearer token-revoked") {
      return new Response(
        JSON.stringify({
          error: { code: "agent_authentication_failed", message: "Agent token is invalid." },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }
    const handle = token === "Bearer token-mismatch" ? "someone-else" : "verified";
    return new Response(
      JSON.stringify({ agent: { id: `agent-${handle}`, handle } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const diagnosis = await diagnoseConnectorBindings(state);
  assert.equal(diagnosis.configuredConnectedCount, 3);
  assert.equal(diagnosis.connectedCount, 1);
  assert.deepEqual(
    diagnosis.bindings.map(({ handle, authenticated }) => ({ handle, authenticated })),
    [
      { handle: "verified", authenticated: true },
      { handle: "revoked", authenticated: false },
      { handle: "mismatch", authenticated: false },
      { handle: "pending", authenticated: false },
    ],
  );
  assert.match(diagnosis.bindings[1]!.error ?? "", /Agent token is invalid/);
  assert.match(diagnosis.bindings[2]!.error ?? "", /does not match/);
});
