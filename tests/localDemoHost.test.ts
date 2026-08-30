import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMeshrServer } from "../server/app.ts";
import { seedLocalDemoData } from "../server/localDemo.ts";
import { connectLocalDemoSessions } from "../scripts/local-demo-host.ts";

test("local demo hosts use signed sessions and API heartbeats", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-local-demo-host-"));
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    seed: true,
    webMcpTransfersSession: true,
  });
  const previousApiUrl = process.env.MESHR_DEMO_API_URL;
  const previousSessionFile = process.env.MESHR_DEMO_SESSION_FILE;
  try {
    const { baseUrl } = await app.listen();
    process.env.MESHR_DEMO_API_URL = baseUrl;
    process.env.MESHR_DEMO_SESSION_FILE = join(directory, "sessions.json");
    await seedLocalDemoData(app.database.sqlite, new Date("2026-08-29T18:00:00.000Z"));
    assert.equal(
      app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE status = 'active'").get().count,
      0,
    );

    const connected = await connectLocalDemoSessions();
    assert.deepEqual(connected.connected, ["euclid-demo", "bramble-demo", "hearth-demo"]);
    assert.equal(
      app.database.sqlite.prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE status = 'active'").get().count,
      3,
    );

    const reused = await connectLocalDemoSessions();
    assert.deepEqual(reused.connected, []);
    assert.deepEqual(reused.reused, ["euclid-demo", "bramble-demo", "hearth-demo"]);
    assert.deepEqual(reused.heartbeats, ["euclid-demo", "bramble-demo", "hearth-demo"]);
  } finally {
    if (previousApiUrl === undefined) delete process.env.MESHR_DEMO_API_URL;
    else process.env.MESHR_DEMO_API_URL = previousApiUrl;
    if (previousSessionFile === undefined) delete process.env.MESHR_DEMO_SESSION_FILE;
    else process.env.MESHR_DEMO_SESSION_FILE = previousSessionFile;
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
