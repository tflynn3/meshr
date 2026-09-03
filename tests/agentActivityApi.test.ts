import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import {
  AgentActivityApiError,
  AgentActivityUnavailableError,
  listAgentActivity,
} from "../src/agentActivity/api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const validPage = {
  contractVersion: 1 as const,
  agentId: "agent-1",
  items: [
    {
      id: "activity-1",
      kind: "READ",
      source: "native",
      action: "read_conversation",
      outcome: "succeeded",
      occurredAt: "2026-09-02T18:00:00.000Z",
      context: {
        meshId: "mesh-1",
        meshName: "Mesh one",
        meshVisibility: "public",
        topicId: "topic-1",
        topicTitle: "Topic one",
      },
      content: {
        id: "post-1",
        type: "post",
        availability: "available",
        excerpt: "Untrusted content",
        moderationState: "published",
        authorship: "not_applicable",
        untrusted: true,
      },
      failureCode: null,
      target: { meshId: "mesh-1", topicId: "topic-1", postId: "post-1" },
    },
  ],
  nextCursor: "opaque-cursor",
  coverage: {
    status: "partial",
    recordedSince: "2026-09-02T18:00:00.000Z",
    message: "Earlier activity was not recorded and is not inferred.",
  },
};

test("dedicated activity client sends bounded cursor requests and accepts the wire type", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify(validPage), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const page = await listAgentActivity("agent-1", {
    after: "opaque-cursor",
    limit: 500,
  });
  assert.equal(page.items[0]?.content?.untrusted, true);
  assert.equal(
    captured?.url,
    "/v1/agents/agent-1/activity?after=opaque-cursor&limit=50",
  );
  assert.equal(captured?.init?.credentials, "include");
  assert.deepEqual(captured?.init?.headers, {
    Accept: "application/json",
    "X-Meshr-Contract-Version": "1",
  });
});

test("dedicated activity client distinguishes unavailable and invalid history", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "activity_ledger_unavailable",
          message: "Ledger store is unavailable.",
        },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  await assert.rejects(
    () => listAgentActivity("agent-1"),
    AgentActivityUnavailableError,
  );

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ...validPage, agentId: "another-agent" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    () => listAgentActivity("agent-1"),
    (error: unknown) =>
      error instanceof AgentActivityApiError &&
      error.code === "invalid_activity_contract",
  );

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        ...validPage,
        agentId: "agent-1",
        items: [{ ...validPage.items[0], target: { meshId: "mesh-1" } }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  await assert.rejects(
    () => listAgentActivity("agent-1"),
    (error: unknown) =>
      error instanceof AgentActivityApiError &&
      error.code === "invalid_activity_contract",
  );
});

test("ledger component contains explicit loading, empty, failure, unavailable, and partial states", () => {
  const source = readFileSync(
    new URL("../src/components/AgentActivityLedger.tsx", import.meta.url),
    "utf8",
  );
  for (const marker of [
    "Loading recorded reads and writes",
    "No recorded activity",
    "Failed",
    "History unavailable",
    "Partial history",
    "Untrusted Meshr content",
    "Earlier activity could not be loaded",
  ]) {
    assert.match(source, new RegExp(marker));
  }
});
