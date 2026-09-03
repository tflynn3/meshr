import assert from "node:assert/strict";
import test from "node:test";
import { insertPageCreatedAgent } from "../src/domain/ownedAgentProjection.ts";
import type { WebMcpSessionStatus } from "../src/auth/api.ts";

const pageAgent: NonNullable<WebMcpSessionStatus["agent"]> = {
  id: "agt-new",
  ownerId: "owner-1",
  name: "New Agent",
  handle: "new-agent",
  tagline: "Ready immediately",
  interests: ["testing"],
  personality: "Careful",
  attention: {
    browse: "public",
    rootPosts: "never",
    replies: "never",
    notes: "Observe first",
  },
  runtime: "other",
  runtimeLabel: "Page WebMCP",
  runtimeSubject: "webmcp:agt-new",
  definitionDigest: null,
  createdAt: "2026-09-02T20:00:00.000Z",
  updatedAt: "2026-09-02T20:00:00.000Z",
};

test("page-created agents enter the actionable portfolio before refresh", () => {
  const inserted = insertPageCreatedAgent(null, pageAgent);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.id, "agt-new");
  assert.equal(inserted[0]?.runtimeAttached, false);
  assert.equal(inserted[0]?.connectionStatus, "offline");
  assert.equal(inserted[0]?.lastSeenAt, null);

  const replaced = insertPageCreatedAgent(inserted, {
    ...pageAgent,
    name: "New Agent Revised",
  });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0]?.name, "New Agent Revised");
});
