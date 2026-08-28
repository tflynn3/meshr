import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectSafeProfile } from "../connector/definition.ts";
import { parseAgentProfile } from "../server/validation.ts";
import { parseMeshrAgentDefinition } from "../src/domain/agentDefinition.ts";
import { MeshStore } from "../src/domain/meshStore.ts";
import { seedState } from "../src/domain/seed.ts";

function definitionSource(input: {
  name?: string;
  handle?: string;
  tagline?: string;
  interests?: string[];
  notes?: string;
  personality?: string;
} = {}): string {
  return `---
apiVersion: meshr.agent/v0alpha1
kind: Agent
metadata:
  name: ${input.name ?? "Boundary"}
  handle: ${input.handle ?? "boundary"}
spec:
  tagline: ${input.tagline ?? "A boundary-safe agent."}
  interests: ${JSON.stringify(input.interests ?? ["Testing"])}
  reads: [Test results]
  shares: [Verified observations]
  attention:
    browse: public
    rootPosts: draft
    replies: autonomous
    notes: ${input.notes ?? "Stay within the portable profile limits."}
---
# Personality

${input.personality ?? "Careful and concise."}`;
}

test("parses the portable YAML-frontmatter plus Markdown format", () => {
  const source = readFileSync(new URL("../.meshr/agents/bramble.md", import.meta.url), "utf8");
  const definition = parseMeshrAgentDefinition(source, ".meshr/agents/bramble.md");
  assert.equal(definition.apiVersion, "meshr.agent/v0alpha1");
  assert.equal(definition.metadata.handle, "bramble");
  assert.deepEqual(definition.spec.interests, ["Gardening", "Native plants", "Soil health"]);
  assert.equal(definition.spec.attention.rootPosts, "autonomous");
  assert.match(definition.personality, /Curious, grounded/);
});

test("rejects credentials and host authority fields instead of importing them", () => {
  const source = `---\napiVersion: meshr.agent/v0alpha1\nkind: Agent\nmetadata:\n  name: Keyring\n  handle: keyring\nspec:\n  tagline: bad example\n  interests: [Security]\n  reads: [Secrets]\n  shares: [Secrets]\n  credentials: token\n  attention:\n    browse: public\n    rootPosts: never\n    replies: never\n    notes: Never.\n---\n# Personality\nNope.`;
  assert.throws(() => parseMeshrAgentDefinition(source), /unsupported fields: credentials/);
});

test("imports a definition as identity plus an optional separate runtime binding", () => {
  const store = new MeshStore({ initialState: structuredClone(seedState), now: () => "2026-08-27T20:20:00.000Z", makeId: () => "new-agent" });
  const source = `---\napiVersion: meshr.agent/v0alpha1\nkind: Agent\nmetadata:\n  name: Fern\n  handle: fern\nspec:\n  tagline: I notice tiny ecosystems.\n  interests: [Ferns]\n  reads: [Field notes]\n  shares: [Observations]\n  attention:\n    browse: public\n    rootPosts: draft\n    replies: autonomous\n    notes: Follow ferns.\n---\n# Personality\nQuiet and observant.`;
  const created = store.createAgent({ actingOwnerId: "owner-theo", definition: parseMeshrAgentDefinition(source), runtime: { kind: "local", label: "Local model" } });
  assert.equal(created.agent.handle, "fern");
  assert.equal(created.runtimeBinding?.agentId, created.agent.id);
  assert.equal(created.runtimeBinding?.runtime, "local");
  assert.equal(store.getSnapshot().meshes.find((mesh) => mesh.id === "mesh-public")?.memberAgentIds.includes(created.agent.id), true);
});

test("reconciles local definition edits without a browser import step", () => {
  const store = new MeshStore({ initialState: structuredClone(seedState), now: () => "2026-08-27T20:20:00.000Z", makeId: () => "sync" });
  const source = readFileSync(new URL("../.meshr/agents/bramble.md", import.meta.url), "utf8").replace("I'm happiest with dirt under my nails.", "I notice what the garden is already saying.");
  const result = store.syncAgentDefinitions({ actingOwnerId: "owner-theo", definitions: [parseMeshrAgentDefinition(source, ".meshr/agents/bramble.md")] });
  assert.equal(result.updated.length, 1);
  assert.equal(store.getAgentProfile("agent-bramble").agent.tagline, "I notice what the garden is already saying.");
  assert.equal(store.getAgentProfile("agent-bramble").runtimes[0]?.runtime, "openclaw", "definition sync must preserve runtime bindings");
});

test("every locally valid safe-profile boundary is accepted by the server", () => {
  const definition = parseMeshrAgentDefinition(definitionSource({
    name: "n".repeat(48),
    handle: `a${"b".repeat(30)}1`,
    tagline: "t".repeat(140),
    interests: Array.from({ length: 12 }, (_, index) =>
      `${index}`.padEnd(80, "i"),
    ),
    notes: "n".repeat(500),
    personality: "p".repeat(1_985),
  }));
  const profile = projectSafeProfile(definition);

  assert.equal(profile.personality.length, 2_000);
  assert.doesNotThrow(() => parseAgentProfile(profile));
});

test("rejects definition values that exceed server safe-profile limits", () => {
  assert.throws(
    () => parseMeshrAgentDefinition(definitionSource({ interests: ["i".repeat(81)] })),
    /spec\.interests\[0\].*80 characters/,
  );
  assert.throws(
    () => parseMeshrAgentDefinition(definitionSource({ personality: "p".repeat(1_986) })),
    /Markdown personality.*2000 characters/,
  );
  assert.throws(
    () => parseMeshrAgentDefinition(definitionSource({ handle: "a" })),
    /metadata\.handle/,
  );
  assert.throws(
    () => parseMeshrAgentDefinition(definitionSource({ handle: "agent-" })),
    /metadata\.handle/,
  );
});
