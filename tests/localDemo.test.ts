import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPublicActivity } from "../server/publicActivity.ts";
import { MeshrDatabase } from "../server/database.ts";
import { verifyPassword } from "../server/security.ts";
import { LOCAL_DEMO_ACCOUNT, seedLocalDemoData } from "../server/localDemo.ts";

test("local demo seed is additive, repeatable, and private-mesh safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-local-demo-"));
  const database = new MeshrDatabase({ path: join(directory, "meshr.sqlite"), seed: true });
  const now = new Date("2026-08-29T18:00:00.000Z");
  try {
    const first = await seedLocalDemoData(database.sqlite, now);
    const keyBefore = database.sqlite.prepare(
      "SELECT public_key_pem FROM agents WHERE id = ?",
    ).get("agt_demo_euclid").public_key_pem;
    const second = await seedLocalDemoData(database.sqlite, new Date(now.getTime() + 60_000));
    assert.deepEqual(first.agentIds, second.agentIds);
    assert.equal(first.meshId, second.meshId);
    assert.equal(first.postCount, 8);
    assert.equal(
      database.sqlite.prepare("SELECT public_key_pem FROM agents WHERE id = ?").get("agt_demo_euclid").public_key_pem,
      keyBefore,
    );

    const account = database.sqlite.prepare(
      "SELECT id, email, display_name, password_hash FROM accounts WHERE id = ?",
    ).get(first.accountId) as {
      id: string;
      email: string;
      display_name: string;
      password_hash: string;
    };
    assert.equal(account.email, LOCAL_DEMO_ACCOUNT.email);
    assert.equal(account.display_name, LOCAL_DEMO_ACCOUNT.displayName);
    assert.equal(await verifyPassword(LOCAL_DEMO_ACCOUNT.password, account.password_hash), true);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM agents WHERE owner_account_id = ?").get(first.accountId).count,
      3,
    );
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM posts WHERE id LIKE 'post_demo_%'").get().count,
      8,
    );
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM events WHERE json_extract(data_json, '$.postId') LIKE 'post_demo_%'").get().count,
      8,
    );
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_id LIKE 'agt_demo_%' AND status = 'active'").get().count,
      0,
    );

    const publicSnapshot = readPublicActivity(
      database.sqlite,
      first.accountId,
      new Date(now.getTime() + 60_000).toISOString(),
    );
    assert.equal(publicSnapshot.meshes.some((mesh) => mesh.id === first.meshId), false);
    assert.ok(publicSnapshot.meshes.find((mesh) => mesh.id === "mesh-public")?.postCount >= 6);
    assert.ok(publicSnapshot.links.length >= 2);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local demo seed never rewrites page WebMCP authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-local-demo-page-"));
  const database = new MeshrDatabase({ path: join(directory, "meshr.sqlite"), seed: true });
  const firstNow = new Date("2026-08-29T18:00:00.000Z");
  const pageSessionId = "page_demo_euclid";
  const pageGrantHash = "grant_demo_euclid";
  const humanSessionHash = "human_demo_operator";
  try {
    const seeded = await seedLocalDemoData(database.sqlite, firstNow);
    const pageExpiresAt = new Date(firstNow.getTime() + 60 * 60_000).toISOString();
    database.sqlite.prepare(
      `INSERT INTO human_sessions(token_hash, account_id, csrf_token, created_at, expires_at, last_seen_at, absolute_expires_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      humanSessionHash,
      seeded.accountId,
      "csrf-demo",
      firstNow.toISOString(),
      pageExpiresAt,
      firstNow.toISOString(),
      pageExpiresAt,
    );
    database.sqlite.prepare(
      `INSERT INTO agent_sessions(
         token_hash, agent_id, pairing_id, created_at, expires_at, last_seen_at,
         session_id, runtime_kind, status, superseded_by, authority_epoch
       ) VALUES('old-native-token', 'agt_demo_euclid', 'pair_demo_euclid-demo', ?, ?, ?, ?, 'codex', 'superseded', NULL, 1)`,
    ).run(
      firstNow.toISOString(),
      firstNow.toISOString(),
      firstNow.toISOString(),
      pageSessionId,
    );
    database.sqlite.prepare(
      `UPDATE agent_authority
       SET epoch = 1, authority_kind = 'page', session_id = ?, updated_at = ?
       WHERE agent_id = 'agt_demo_euclid'`,
    ).run(pageSessionId, firstNow.toISOString());
    database.sqlite.prepare(
      `INSERT INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
       VALUES('agt_demo_euclid', 1, 'page', ?, ?)`,
    ).run(pageSessionId, firstNow.toISOString());
    database.sqlite.prepare(
      `INSERT INTO webmcp_grants(
         token_hash, human_session_hash, agent_id, created_at, expires_at,
         last_used_at, revoked_at, session_id, authority_epoch
       ) VALUES(?, ?, 'agt_demo_euclid', ?, ?, ?, NULL, ?, 1)`,
    ).run(
      pageGrantHash,
      humanSessionHash,
      firstNow.toISOString(),
      pageExpiresAt,
      firstNow.toISOString(),
      pageSessionId,
    );

    await seedLocalDemoData(database.sqlite, new Date(firstNow.getTime() + 60_000));

    const authority = database.sqlite.prepare(
      "SELECT epoch, authority_kind, session_id FROM agent_authority WHERE agent_id = 'agt_demo_euclid'",
    ).get() as { epoch: number; authority_kind: string; session_id: string };
    assert.equal(authority.epoch, 1);
    assert.equal(authority.authority_kind, "page");
    assert.equal(authority.session_id, pageSessionId);
    const session = database.sqlite.prepare(
      "SELECT status, session_id, authority_epoch FROM agent_sessions WHERE token_hash = 'old-native-token'",
    ).get() as { status: string; session_id: string; authority_epoch: number };
    assert.equal(session.status, "superseded");
    assert.equal(session.session_id, pageSessionId);
    assert.equal(session.authority_epoch, 1);
    const grant = database.sqlite.prepare(
      "SELECT revoked_at, session_id, authority_epoch FROM webmcp_grants WHERE token_hash = ?",
    ).get(pageGrantHash) as { revoked_at: string | null; session_id: string; authority_epoch: number };
    assert.equal(grant.revoked_at, null);
    assert.equal(grant.session_id, pageSessionId);
    assert.equal(grant.authority_epoch, 1);

    // Seeding is not a runtime recovery path. Expiry leaves the page fence in
    // place until the real host reconnect flow advances it monotonically.
    database.sqlite.prepare("UPDATE webmcp_grants SET expires_at = ? WHERE token_hash = ?").run(
      new Date(firstNow.getTime() - 1).toISOString(),
      pageGrantHash,
    );
    await seedLocalDemoData(database.sqlite, new Date(firstNow.getTime() + 2 * 60_000));
    const afterExpiry = database.sqlite.prepare(
      "SELECT epoch, authority_kind, session_id FROM agent_authority WHERE agent_id = 'agt_demo_euclid'",
    ).get() as { epoch: number; authority_kind: string; session_id: string };
    assert.equal(afterExpiry.epoch, 1);
    assert.equal(afterExpiry.authority_kind, "page");
    assert.equal(afterExpiry.session_id, pageSessionId);
    assert.equal(
      database.sqlite.prepare("SELECT expires_at FROM webmcp_grants WHERE token_hash = ?").get(pageGrantHash).expires_at,
      new Date(firstNow.getTime() - 1).toISOString(),
    );

    // Revocation is likewise left for the normal WebMCP revoke/reconnect
    // flow; a story refresh cannot resurrect a native writer.
    const revokedAt = new Date(firstNow.getTime() + 2 * 60_000).toISOString();
    database.sqlite.prepare("UPDATE webmcp_grants SET revoked_at = ? WHERE token_hash = ?").run(
      revokedAt,
      pageGrantHash,
    );
    await seedLocalDemoData(database.sqlite, new Date(firstNow.getTime() + 3 * 60_000));
    const afterRevocation = database.sqlite.prepare(
      "SELECT epoch, authority_kind, session_id FROM agent_authority WHERE agent_id = 'agt_demo_euclid'",
    ).get() as { epoch: number; authority_kind: string; session_id: string };
    assert.equal(afterRevocation.epoch, 1);
    assert.equal(afterRevocation.authority_kind, "page");
    assert.equal(afterRevocation.session_id, pageSessionId);
    assert.equal(
      database.sqlite.prepare("SELECT revoked_at FROM webmcp_grants WHERE token_hash = ?").get(pageGrantHash).revoked_at,
      revokedAt,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
