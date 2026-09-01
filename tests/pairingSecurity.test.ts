import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMeshrServer } from "../server/app.ts";
import { MeshrDatabase } from "../server/database.ts";
import type {
  MeshrRepository,
  RepositoryPairingInput,
} from "../server/repository.ts";
import { SqliteMeshrRepository } from "../server/sqliteRepository.ts";
import type { Clock } from "../server/types.ts";

class FixedClock implements Clock {
  constructor(private readonly value: Date) {}

  now(): Date {
    return new Date(this.value);
  }
}

async function requestJson(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    authorization?: string;
    clientIp?: string;
  } = {},
): Promise<{ response: Response; json: any }> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.authorization)
    headers.set("Authorization", options.authorization);
  if (options.clientIp) headers.set("CF-Connecting-IP", options.clientIp);
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { response, json: await response.json() };
}

test("pairing status is pair-limited before another durable read", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-pairing-status-"));
  const clock = new FixedClock(new Date("2026-08-27T18:00:00.000Z"));
  const secret = "pairing-status-secret";
  let reads = 0;
  const pairing = (pairingId: string): RepositoryPairingInput => ({
    pairingId,
    code: "PAIR-TEST",
    secretHash: createHash("sha256").update(secret).digest("hex"),
    runtime: "openclaw",
    runtimeLabel: "Rate-limit fixture",
    externalSubject: "fixture:pairing-status",
    publicKeyPem: "fixture-key",
    requestedProfile: null,
    definitionDigest: null,
    status: "pending",
    ownerAccountId: null,
    agentId: null,
    createdAt: "2026-08-27T18:00:00.000Z",
    expiresAt: "2026-08-27T19:00:00.000Z",
    approvedAt: null,
    claimedAt: null,
  });
  const repository = {
    findPairing: async (pairingId: string) => {
      reads += 1;
      return pairing(pairingId);
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });

  try {
    const { baseUrl } = await app.listen();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const status = await requestJson(baseUrl, "/v1/pairings/pair-rate", {
        authorization: `Pairing ${secret}`,
      });
      assert.equal(status.response.status, 200);
    }
    assert.equal(reads, 12);
    const limited = await requestJson(baseUrl, "/v1/pairings/pair-rate", {
      authorization: `Pairing ${secret}`,
    });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.json.error.code, "pairing_status_rate_limited");
    assert.equal(reads, 12, "the rejected poll must not reach the durable store");
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("social session verification is source-limited before invoking the verifier", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-social-session-"));
  const clock = new FixedClock(new Date("2026-08-27T18:00:00.000Z"));
  let verifications = 0;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    identityVerifier: async () => {
      verifications += 1;
      throw new Error("fixture invalid token");
    },
  });

  try {
    const { baseUrl } = await app.listen();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rejected = await requestJson(baseUrl, "/v1/sessions/social", {
        method: "POST",
        body: { provider: "google", idToken: "syntactically-valid-fixture" },
      });
      assert.equal(rejected.response.status, 401);
    }
    assert.equal(verifications, 10);
    const limited = await requestJson(baseUrl, "/v1/sessions/social", {
      method: "POST",
      body: { provider: "google", idToken: "syntactically-valid-fixture" },
    });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.json.error.code, "social_session_rate_limited");
    assert.equal(
      verifications,
      10,
      "the rejected sign-in must not invoke certificate or signature verification",
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime renewal is source-limited before arbitrary pairing reads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-session-renew-"));
  const clock = new FixedClock(new Date("2026-08-27T18:00:00.000Z"));
  let pairingReads = 0;
  const repository = {
    findPairing: async () => {
      pairingReads += 1;
      return null;
    },
  } as unknown as MeshrRepository;
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    repository,
  });

  try {
    const { baseUrl } = await app.listen();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const rejected = await requestJson(baseUrl, "/v1/agent-sessions/renew", {
        method: "POST",
        authorization: "Pairing invalid-secret",
        body: {
          pairingId: `pair-renew-${attempt}`,
          challengeId: "challenge-fixture",
          sessionId: "session-fixture",
          signature: "signature-fixture",
        },
      });
      assert.equal(rejected.response.status, 401);
    }
    assert.equal(pairingReads, 30);
    const limited = await requestJson(baseUrl, "/v1/agent-sessions/renew", {
      method: "POST",
      authorization: "Pairing invalid-secret",
      body: {
        pairingId: "pair-renew-limited",
        challengeId: "challenge-fixture",
        sessionId: "session-fixture",
        signature: "signature-fixture",
      },
    });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.json.error.code, "session_rate_limited");
    assert.equal(
      pairingReads,
      30,
      "the rejected renewal must not query the durable pairing store",
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pairing lookup is source-limited before auth and account-limited after auth", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-pairing-lookup-"));
  const clock = new FixedClock(new Date("2026-08-27T18:00:00.000Z"));
  const app = createMeshrServer({
    dbPath: join(directory, "meshr.db"),
    clock,
    trustCloudflareConnectingIp: true,
  });

  try {
    const { baseUrl } = await app.listen();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const rejected = await requestJson(
        baseUrl,
        "/v1/pairings/lookup?code=ZZZZ-ZZZZ",
        { clientIp: "198.51.100.10" },
      );
      assert.equal(rejected.response.status, 401);
    }
    const sourceLimited = await requestJson(
      baseUrl,
      "/v1/pairings/lookup?code=ZZZZ-ZZZZ",
      { clientIp: "198.51.100.10" },
    );
    assert.equal(sourceLimited.response.status, 429);
    assert.equal(
      sourceLimited.json.error.code,
      "pairing_lookup_rate_limited",
    );

    const registration = await fetch(`${baseUrl}/v1/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "pairing-lookup@example.test",
        password: "a sufficiently long passphrase",
        displayName: "Pairing Lookup",
      }),
    });
    assert.equal(registration.status, 201);
    const cookie = registration.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const missing = await requestJson(
        baseUrl,
        "/v1/pairings/lookup?code=YYYY-YYYY",
        { cookie, clientIp: `203.0.113.${attempt + 1}` },
      );
      assert.equal(missing.response.status, 404);
    }
    const accountLimited = await requestJson(
      baseUrl,
      "/v1/pairings/lookup?code=YYYY-YYYY",
      { cookie, clientIp: "203.0.113.100" },
    );
    assert.equal(accountLimited.response.status, 429);
    assert.equal(
      accountLimited.json.error.code,
      "pairing_lookup_rate_limited",
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite pairing expiry is a pending-only compare-and-set", async () => {
  const clock = new FixedClock(new Date("2026-08-27T18:00:00.000Z"));
  const database = new MeshrDatabase({ path: ":memory:", clock, seed: false });
  const repository = new SqliteMeshrRepository(database, clock);
  const fixture = (
    pairingId: string,
    status: RepositoryPairingInput["status"],
    expiresAt: string,
  ): RepositoryPairingInput => ({
    pairingId,
    code: pairingId.toUpperCase(),
    secretHash: "fixture-hash",
    runtime: "local",
    runtimeLabel: "CAS fixture",
    externalSubject: `fixture:${pairingId}`,
    publicKeyPem: "fixture-key",
    requestedProfile: null,
    definitionDigest: null,
    status,
    ownerAccountId: null,
    agentId: null,
    createdAt: "2026-08-27T17:00:00.000Z",
    expiresAt,
    approvedAt: status === "approved" ? "2026-08-27T17:30:00.000Z" : null,
    claimedAt: null,
  });

  try {
    await repository.createPairing(
      fixture("pair-expired", "pending", "2026-08-27T17:59:00.000Z"),
    );
    await repository.createPairing(
      fixture("pair-approved", "approved", "2026-08-27T17:59:00.000Z"),
    );
    await repository.createPairing(
      fixture("pair-future", "pending", "2026-08-27T18:01:00.000Z"),
    );

    assert.equal(
      (await repository.expirePairingIfPending(
        "pair-expired",
        clock.now().toISOString(),
      ))?.status,
      "expired",
    );
    assert.equal(
      (await repository.expirePairingIfPending(
        "pair-approved",
        clock.now().toISOString(),
      ))?.status,
      "approved",
      "a stale expiry must not overwrite concurrent approval",
    );
    assert.equal(
      (await repository.expirePairingIfPending(
        "pair-future",
        clock.now().toISOString(),
      ))?.status,
      "pending",
    );
  } finally {
    database.close();
  }
});
