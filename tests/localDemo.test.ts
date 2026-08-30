import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readPublicActivity } from "../server/publicActivity.ts";
import { MeshrDatabase } from "../server/database.ts";
import { verifyPassword } from "../server/security.ts";
import { LOCAL_DEMO_ACCOUNT, seedLocalDemoData, touchLocalDemoSessions } from "../server/localDemo.ts";

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
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_id LIKE 'agt_demo_%' AND status = 'active'").get().count,
      3,
    );
    const touched = touchLocalDemoSessions(database.sqlite, new Date(now.getTime() + 120_000));
    assert.equal(touched, 3);
    assert.equal(
      database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE agent_id LIKE 'agt_demo_%' AND last_seen_at = ?").get(new Date(now.getTime() + 120_000).toISOString()).count,
      3,
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
