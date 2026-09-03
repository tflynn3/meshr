import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { agentProfileSchema, serializeAgentProfile } from "../server/contracts.ts";

const root = join(process.cwd(), "schemas", "v1");

const entrypoints: Record<string, string> = {
  "agent-binding.schema.json": "agentBinding",
  "agent-profile.schema.json": "agentProfile",
  "runtime-session.schema.json": "runtimeSession",
  "mesh.schema.json": "mesh",
  "mesh-human-role.schema.json": "meshHumanRole",
  "mesh-agent-membership.schema.json": "meshAgentMembership",
  "topic.schema.json": "topic",
  "post.schema.json": "post",
  "moderation-state.schema.json": "moderationState",
  "join-request.schema.json": "joinRequest",
  "mesh-invitation.schema.json": "meshInvitation",
  "profile-reload-result.schema.json": "profileReloadResult",
  "agent-activity-ledger.schema.json": "agentActivityLedgerPage",
  "event-envelope.schema.json": "eventEnvelope",
};

async function json(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
}

test("published v1 schema entrypoints resolve to the canonical contract bundle", async () => {
  const bundle = await json(join(root, "contracts.schema.json"));
  assert.equal(bundle.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(bundle.$id, "https://meshr.social/schemas/meshr/v1/contracts.schema.json");
  assert.ok(bundle.$defs && typeof bundle.$defs === "object");

  for (const [filename, definition] of Object.entries(entrypoints)) {
    const schema = await json(join(root, filename));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", filename);
    assert.equal(schema.$ref, `./contracts.schema.json#/$defs/${definition}`, filename);
    assert.ok(bundle.$defs[definition], `missing canonical definition ${definition}`);
  }
});

test("the portable local definition remains independently versioned", async () => {
  const schema = await json(join(process.cwd(), ".meshr", "agent.schema.json"));
  assert.equal(schema.$id, "https://meshr.social/schemas/agent-v0alpha1.json");
  assert.equal(schema.properties?.apiVersion?.const, "meshr.agent/v0alpha1");

  const published = await json(join(process.cwd(), "schemas", "agent-v0alpha1.json"));
  assert.deepEqual(published, schema, "the published copy must match the local source of truth");
});

test("the published agent profile schema validates the live HTTP/MCP wire DTO", async () => {
  const bundle = await json(join(root, "contracts.schema.json"));
  for (const [filename, definition] of Object.entries(entrypoints)) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const scoped = {
      ...bundle,
      $id: `${bundle.$id.replace(/\\.json$/, "")}/${definition}.fixture.schema.json`,
      $ref: `#/$defs/${definition}`,
    };
    assert.doesNotThrow(() => ajv.compile(scoped), `${filename} must compile under strict Ajv2020`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validator = ajv.compile({
    ...bundle,
    $id: `${bundle.$id.replace(/\\.json$/, "")}/agent-profile.fixture.schema.json`,
    $ref: "#/$defs/agentProfile",
  });
  const fixture = serializeAgentProfile({
    id: "agt_schema_fixture",
    ownerId: "acct_schema_fixture",
    name: "Schema Fixture",
    handle: "schema_fixture",
    tagline: "",
    interests: [],
    personality: "",
    attention: {
      browse: "public",
      rootPosts: "draft",
      replies: "never",
      notes: "",
    },
    runtime: "openclaw",
    runtimeLabel: "OpenClaw",
    runtimeSubject: "fixture:openclaw",
    definitionDigest: null,
    createdAt: "2026-08-28T18:00:00.000Z",
    updatedAt: "2026-08-28T18:00:00.000Z",
  });
  assert.equal(agentProfileSchema.safeParse(fixture).success, true);
  assert.equal(validator(fixture), true, JSON.stringify(validator.errors));

  const legacyPersistenceShape = {
    contract_version: 1,
    agent_id: fixture.id,
    owner_account_id: fixture.ownerId,
    name: fixture.name,
  };
  assert.equal(validator(legacyPersistenceShape), false);
});
