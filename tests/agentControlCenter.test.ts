import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDetailSearch,
  agentPortfolioSearch,
  deriveAgentControlCenter,
  readAgentDetailRoute,
} from "../src/domain/agentControlCenter.ts";
import type { Agent, Mesh, RuntimeBinding, Topic } from "../src/domain/types.ts";

const agent: Agent = {
  id: "agent-aster", ownerId: "owner-1", name: "Aster", handle: "aster", initials: "AS", color: "green",
  tagline: "Connects ideas", interests: ["Math"], reads: ["Notes"], shares: ["Links"],
  attention: { browse: "public", rootPosts: "draft", replies: "draft", notes: "Careful" },
  personality: "Curious", definitionPath: "synced://aster",
};
const mesh: Mesh = {
  id: "mesh-1", ownerId: "owner-1", name: "Commons", description: "", visibility: "public", joinPolicy: "open",
  memberAgentIds: [agent.id], humanRoleAssignments: [], rolePolicy: { owner: [], steward: [], observer: [] }, accent: "green",
};
const topic: Topic = {
  id: "topic-1", meshId: mesh.id, name: "ideas", title: "Ideas", description: "", tags: [], activityCount: 2,
  participantAgentIds: [agent.id], accent: "green",
};
const connectedRuntime: RuntimeBinding = {
  id: "runtime-1", agentId: agent.id, runtime: "openclaw", label: "OpenClaw", status: "connected", lastSeenAt: "2026-09-02T12:00:00.000Z",
};

test("agent detail routes preserve unrelated query state and are reversible", () => {
  assert.deepEqual(readAgentDetailRoute("?mesh=commons&agent=agent-aster"), { kind: "agent", agentId: "agent-aster" });
  assert.equal(agentDetailSearch("agent-aster", "?mesh=commons"), "?mesh=commons&agent=agent-aster");
  assert.equal(agentPortfolioSearch("?mesh=commons&agent=agent-aster"), "?mesh=commons");
  assert.deepEqual(readAgentDetailRoute("?mesh=commons"), { kind: "agents" });
});

test("page control is the single controller lifecycle even when a native binding remains visible", () => {
  const model = deriveAgentControlCenter({
    agent, runtime: connectedRuntime, meshes: [mesh], topics: [topic], posts: [], links: [],
    webMcp: { enabled: true, agentId: agent.id, expiresAt: "2026-09-02T13:00:00.000Z", status: "ready" },
  });
  assert.equal(model.lifecycle.state, "page_active");
  assert.equal(model.lifecycle.primaryAction, "disable_webmcp");
  assert.equal(model.memberships.length, 1);
  assert.equal(model.participatedTopics.length, 1);
});

test("an identity without a controller asks only for page control and does not invent activity", () => {
  const model = deriveAgentControlCenter({
    agent, runtime: undefined, meshes: [], topics: [], posts: [], links: [],
    webMcp: { enabled: false, agentId: null, expiresAt: null, status: "disabled" },
  });
  assert.equal(model.lifecycle.state, "needs_setup");
  assert.equal(model.lifecycle.primaryAction, "enable_webmcp");
  assert.equal(model.observedPosts.length, 0);
});
