import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string): string =>
  readFileSync(new URL(path, root), "utf8");

const ttlFields = [
  {
    resource: "human_session_absolute_expiry_ttl",
    collection: "human_sessions",
    field: "absolute_expires_at_ttl",
    canary: "human_session_expiry",
  },
  {
    resource: "webmcp_grant_expiry_ttl",
    collection: "webmcp_grants",
    field: "expires_at_ttl",
    canary: "webmcp_grant_expiry",
  },
  {
    resource: "webmcp_authority_expiry_ttl",
    collection: "webmcp_authority",
    field: "expires_at_ttl",
    canary: "webmcp_fence_expiry",
  },
  {
    resource: "inactive_runtime_session_expiry_ttl",
    collection: "runtime_sessions",
    field: "inactive_expires_at_ttl",
    canary: "runtime_session_expiry",
  },
  {
    resource: "revoked_agent_binding_expiry_ttl",
    collection: "agent_bindings",
    field: "revoked_at_ttl",
    canary: "revoked_binding_expiry",
  },
] as const;

test("native authority TTL markers are configured for production and canary Firestore", () => {
  const tofu = read("infra/opentofu/main.tf");
  const repository = read("server/firestoreRepository.ts");
  const canary = tofu.match(
    /canary_firestore_ttl_fields\s*=\s*\{([\s\S]*?)\n\s*\}/,
  )?.[1];
  assert.ok(canary, "expected the canary TTL field map");

  for (const expected of ttlFields) {
    const block = tofu.match(
      new RegExp(
        `resource\\s+"google_firestore_field"\\s+"${expected.resource}"\\s*\\{([\\s\\S]*?)\\n\\}`,
      ),
    )?.[1];
    assert.ok(block, `missing default TTL resource ${expected.resource}`);
    assert.match(block, /database\s*=\s*google_firestore_database\.default\.name/);
    assert.match(
      block,
      new RegExp(`collection\\s*=\\s*"${expected.collection}"`),
    );
    assert.match(block, new RegExp(`field\\s*=\\s*"${expected.field}"`));
    assert.match(block, /ttl_config\s*\{\s*\}/);
    assert.match(
      canary,
      new RegExp(
        `${expected.canary}\\s*=\\s*\\{\\s*collection\\s*=\\s*"${expected.collection}",\\s*field\\s*=\\s*"${expected.field}"\\s*\\}`,
      ),
    );
    assert.match(
      repository,
      new RegExp(`${expected.field.replaceAll("_", "_")}\\s*:`),
      `repository never writes ${expected.collection}.${expected.field}`,
    );
  }

  assert.match(
    repository,
    /inactive_expires_at_ttl:\s*null,[\s\S]*?status:\s*"active"/,
    "active runtime sessions must remain available for guarded offline renewal",
  );
  assert.match(
    repository,
    /REVOKED_BINDING_RETENTION_SECONDS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60/,
    "revoked bindings should retain only a short troubleshooting window",
  );
});

test("canary moderation indexes and TTL policies target the moderation database", () => {
  const tofu = read("infra/opentofu/main.tf");
  const authorityIndexes = tofu.match(
    /canary_firestore_indexes\s*=\s*\{([\s\S]*?)\n\s*\}\n\s*canary_moderation_firestore_indexes/,
  )?.[1];
  const moderationIndexes = tofu.match(
    /canary_moderation_firestore_indexes\s*=\s*\{([\s\S]*?)\n\s*\}\n\s*canary_firestore_ttl_fields/,
  )?.[1];
  const authorityTtl = tofu.match(
    /canary_firestore_ttl_fields\s*=\s*\{([\s\S]*?)\n\s*\}\n\s*canary_moderation_firestore_ttl_fields/,
  )?.[1];
  const moderationTtl = tofu.match(
    /canary_moderation_firestore_ttl_fields\s*=\s*\{([\s\S]*?)\n\s*\}\n\s*# Cloudflare/,
  )?.[1];

  assert.ok(authorityIndexes);
  assert.ok(moderationIndexes);
  assert.ok(authorityTtl);
  assert.ok(moderationTtl);
  assert.doesNotMatch(authorityIndexes, /moderation_inbox_due/);
  assert.match(moderationIndexes, /moderation_inbox_due/);
  assert.doesNotMatch(authorityTtl, /moderation_inbox|moderation_dlq/);
  assert.match(moderationTtl, /processed_events/);
  assert.match(moderationTtl, /moderation_inbox/);
  assert.match(moderationTtl, /moderation_dlq/);

  const indexResource = tofu.match(
    /resource "google_firestore_index" "canary_moderation" \{([\s\S]*?)\n\}/,
  )?.[1];
  const ttlResource = tofu.match(
    /resource "google_firestore_field" "canary_moderation_ttl" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(indexResource);
  assert.ok(ttlResource);
  assert.match(
    indexResource,
    /database\s*=\s*google_firestore_database\.canary_moderation\.name/,
  );
  assert.match(
    ttlResource,
    /database\s*=\s*google_firestore_database\.canary_moderation\.name/,
  );
});
