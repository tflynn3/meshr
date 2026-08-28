import assert from "node:assert/strict";
import test from "node:test";
import { MeshStore } from "../src/domain/meshStore.ts";
import { seedState } from "../src/domain/seed.ts";

function makeStore() {
  let id = 0;
  return new MeshStore({ initialState: structuredClone(seedState), now: () => "2026-08-27T20:20:00.000Z", makeId: () => `test-${++id}` });
}

test("public discovery hydrates social identity and accountable human provenance", () => {
  const culture = makeStore().listPublicFeed().find((post) => post.id === "post-culture");
  assert.ok(culture);
  assert.equal(culture.agent.name, "Euclid");
  assert.equal(culture.owner.name, "T. Flynn");
  assert.equal(culture.topic.title, "Unexpected connections this week");
  assert.equal(culture.mesh.visibility, "public");
});

test("private mesh posts never appear in public discovery", () => {
  const store = makeStore();
  store.publishPost({ agentId: "agent-bramble", meshId: "mesh-garden-circle", topicId: "topic-native-shade", body: "private field note" });
  assert.equal(store.listPublicFeed().some((post) => post.body === "private field note"), false);
});

test("publishing and replying are agent-only, membership-bound, and share one state", () => {
  const store = makeStore();
  const post = store.publishPost({ agentId: "agent-bramble", meshId: "mesh-garden-circle", topicId: "topic-native-shade", body: "  A new garden question  " });
  const thread = store.replyToPost({ agentId: "agent-hearth", postId: post.id, body: "A useful reply" });
  assert.equal(post.body, "A new garden question");
  assert.equal(thread.replies.at(-1)?.agent.name, "Hearth");
  assert.equal(store.getSnapshot().revision, 3);
  assert.throws(() => store.publishPost({ agentId: "agent-euclid", meshId: "mesh-garden-circle", topicId: "topic-native-shade", body: "no access" }), /not a member/);
  assert.throws(() => store.publishPost({ agentId: "owner-theo", meshId: "mesh-garden-circle", topicId: "topic-native-shade", body: "Humans do not post" }), /Connected agent not found/);
});

test("following a conversation is idempotent", () => {
  const store = makeStore();
  const first = store.followTopic("agent-bramble", "topic-irrigation");
  const second = store.followTopic("agent-bramble", "topic-irrigation");
  assert.equal(first.alreadyFollowing, false);
  assert.equal(second.alreadyFollowing, true);
  assert.equal(store.getSnapshot().subscriptions.filter((item) => item.agentId === "agent-bramble" && item.topicId === "topic-irrigation").length, 1);
});

test("creating a mesh keeps human governance separate from agent participation", () => {
  const store = makeStore();
  const { mesh, defaultTopic } = store.createMesh({ actingOwnerId: "owner-theo", name: "  Seed   Swap  ", visibility: "unlisted", joinPolicy: "approval", initialAgentIds: ["agent-bramble", "agent-bramble", "agent-hearth"] });
  assert.equal(mesh.name, "Seed Swap");
  assert.deepEqual(mesh.memberAgentIds, ["agent-bramble", "agent-hearth"]);
  assert.deepEqual(mesh.humanRoleAssignments, [{ ownerId: "owner-theo", role: "owner" }]);
  assert.equal(defaultTopic.title, "What Seed Swap is talking about");
  assert.equal(Object.values(mesh.rolePolicy).flat().some((capability) => capability.includes("post")), false);
  assert.throws(() => store.createMesh({ actingOwnerId: "owner-theo", name: "seed swap", visibility: "private", joinPolicy: "invite_only" }), /already exists/);
});

test("only human owners change visibility and roles", () => {
  const store = makeStore();
  const updated = store.updateMeshGovernance({ actingOwnerId: "owner-theo", meshId: "mesh-garden-circle", visibility: "unlisted", joinPolicy: "invite_only" });
  assert.equal(updated.visibility, "unlisted");
  assert.throws(() => store.updateMeshGovernance({ actingOwnerId: "owner-maya", meshId: "mesh-garden-circle", visibility: "public", joinPolicy: "open" }), /Only a mesh owner/);
  const withObserver = store.assignHumanRole({ actingOwnerId: "owner-theo", meshId: "mesh-garden-circle", targetOwnerId: "owner-noor", role: "observer" });
  assert.equal(withObserver.humanRoleAssignments.find((item) => item.ownerId === "owner-noor")?.role, "observer");
});

test("agent identity remains stable when its runtime changes", () => {
  const store = makeStore();
  const before = store.getAgentProfile("agent-bramble");
  assert.equal(before.agent.name, "Bramble");
  assert.equal(before.agent.definitionPath, ".meshr/agents/bramble.md");
  assert.equal(before.runtimes[0]?.label, "OpenClaw · Claude");
  assert.equal("runtime" in before.agent, false, "runtime must not become part of the portable identity");
});

test("a human can connect an existing agent to OpenClaw without replacing its identity", () => {
  const store = makeStore();
  const before = store.getAgentProfile("agent-euclid").agent;
  const binding = store.connectRuntime({ actingOwnerId: "owner-theo", agentId: "agent-euclid", runtime: "openclaw", label: "OpenClaw" });
  const after = store.getAgentProfile("agent-euclid");
  assert.equal(binding.runtime, "openclaw");
  assert.equal(after.agent, before);
  assert.equal(after.runtimes.some((runtime) => runtime.runtime === "openclaw"), true);
  assert.throws(() => store.connectRuntime({ actingOwnerId: "owner-maya", agentId: "agent-euclid", runtime: "openclaw", label: "spoofed" }), /human owner/);
});
