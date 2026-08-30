import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMeshrServer } from "../server/app.ts";
import { seedLocalDemoData } from "../server/localDemo.ts";
import { connectLocalDemoSessions } from "../scripts/local-demo-host.ts";
import type { Clock } from "../server/types.ts";

class TestClock implements Clock {
  constructor(private value = new Date()) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

test("local demo hosts use strict signed sessions, renewal, and offline presence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-local-demo-host-"));
  // Start the service clock behind wall time so the bridge can exercise the
  // near-expiry renewal branch without a fifteen-minute sleep.
  const clock = new TestClock(new Date(Date.now() - 14 * 60_000));
  const previousStrictSessions = process.env.MESHR_STRICT_SESSIONS;
  process.env.MESHR_STRICT_SESSIONS = "1";
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    seed: true,
    webMcpTransfersSession: true,
  });
  const previousApiUrl = process.env.MESHR_DEMO_API_URL;
  const previousSessionFile = process.env.MESHR_DEMO_SESSION_FILE;
  try {
    const { baseUrl } = await app.listen();
    process.env.MESHR_DEMO_API_URL = baseUrl;
    process.env.MESHR_DEMO_SESSION_FILE = join(directory, "sessions.json");
    const health = await fetch(`${baseUrl}/healthz`).then((response) => response.json());
    assert.equal(health.sessionPolicy, "strict");
    assert.equal(health.runtimeSessionSeconds, 900);
    assert.equal(health.runtimeOfflineSeconds, 90);
    await seedLocalDemoData(app.database.sqlite, clock.now());
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

    clock.advance(14 * 60_000);
    const renewed = await connectLocalDemoSessions();
    assert.deepEqual(renewed.renewed, ["euclid-demo", "bramble-demo", "hearth-demo"]);
    assert.deepEqual(renewed.connected, []);

    clock.advance(91_000);
    const pairingStatus = await fetch(`${baseUrl}/v1/pairings/pair_demo_euclid-demo`, {
      headers: { Authorization: "Pairing meshr-demo-pairing:euclid-demo" },
    }).then((response) => response.json());
    assert.equal(pairingStatus.status, "approved");
  } finally {
    if (previousApiUrl === undefined) delete process.env.MESHR_DEMO_API_URL;
    else process.env.MESHR_DEMO_API_URL = previousApiUrl;
    if (previousSessionFile === undefined) delete process.env.MESHR_DEMO_SESSION_FILE;
    else process.env.MESHR_DEMO_SESSION_FILE = previousSessionFile;
    if (previousStrictSessions === undefined) delete process.env.MESHR_STRICT_SESSIONS;
    else process.env.MESHR_STRICT_SESSIONS = previousStrictSessions;
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local demo host refuses to send credentials to a non-loopback origin", async () => {
  const previousApiUrl = process.env.MESHR_DEMO_API_URL;
  process.env.MESHR_DEMO_API_URL = "https://meshr.social";
  try {
    await assert.rejects(
      connectLocalDemoSessions(),
      /MESHR_DEMO_API_URL must be a loopback HTTP origin/,
    );
  } finally {
    if (previousApiUrl === undefined) delete process.env.MESHR_DEMO_API_URL;
    else process.env.MESHR_DEMO_API_URL = previousApiUrl;
  }
});
