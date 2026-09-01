import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runRestartHook,
  verifyMultiReplica,
} from "../scripts/verify-multi-replica.ts";

interface FleetOptions {
  partitionIdempotency?: boolean;
  partitionQuota?: boolean;
  sameInstance?: boolean;
  initialReleaseShaA?: string;
  initialReleaseShaB?: string;
  finalReleaseShaA?: string;
  finalReleaseShaB?: string;
  finalInstanceFingerprintA?: string;
  finalInstanceFingerprintB?: string;
  healthStatus?: string;
  contractVersion?: string;
}

const EXPECTED_RELEASE_SHA = "1".repeat(40);
const STALE_RELEASE_SHA = "2".repeat(40);

interface CapturedRequest {
  replica: "a" | "b";
  method: string;
  path: string;
  host: string;
  origin: string;
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "x-meshr-contract-version": "1",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function startFleet(options: FleetOptions = {}): Promise<{
  podAUrl: string;
  podBUrl: string;
  captured: CapturedRequest[];
  close(): Promise<void>;
}> {
  const captured: CapturedRequest[] = [];
  const sharedIdempotency = new Map<string, { input: string; body: unknown }>();
  const sharedQuota = { accepted: 0 };
  let revoked = false;
  let currentTagline = "A disposable multi-replica verification identity.";
  const instanceFingerprints = {
    a: "a".repeat(32),
    b: options.sameInstance ? "a".repeat(32) : "b".repeat(32),
  };
  const healthRequests = { a: 0, b: 0 };

  const startReplica = async (replica: "a" | "b") => {
    const localIdempotency = options.partitionIdempotency ? new Map<string, { input: string; body: unknown }>() : sharedIdempotency;
    const localQuota = options.partitionQuota ? { accepted: 0 } : sharedQuota;
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://test.invalid").pathname;
      const method = request.method ?? "GET";
      captured.push({
        replica,
        method,
        path,
        host: String(request.headers.host ?? ""),
        origin: String(request.headers.origin ?? ""),
      });
      const authorizedAgent = request.headers.authorization === "Bearer agent-secret-token" && !revoked;
      if (method === "GET" && path === "/healthz") {
        healthRequests[replica] += 1;
        const initialReleaseSha = replica === "a"
          ? (options.initialReleaseShaA ?? EXPECTED_RELEASE_SHA)
          : (options.initialReleaseShaB ?? EXPECTED_RELEASE_SHA);
        const finalReleaseSha = replica === "a"
          ? (options.finalReleaseShaA ?? initialReleaseSha)
          : (options.finalReleaseShaB ?? initialReleaseSha);
        const finalInstanceFingerprint = replica === "a"
          ? (options.finalInstanceFingerprintA ?? instanceFingerprints[replica])
          : (options.finalInstanceFingerprintB ?? instanceFingerprints[replica]);
        return sendJson(response, 200, {
          status: options.healthStatus ?? "ok",
          instanceFingerprint: healthRequests[replica] > 1
            ? finalInstanceFingerprint
            : instanceFingerprints[replica],
          releaseSha: healthRequests[replica] > 1 ? finalReleaseSha : initialReleaseSha,
        }, {
          "x-meshr-contract-version": options.contractVersion ?? "1",
        });
      }
      if (method === "POST" && path === "/v1/auth/state") {
        return sendJson(response, 201, { state: "oauth-state" }, {
          "set-cookie": "meshr_oauth_state=oauth-state; Path=/; Secure; HttpOnly",
        });
      }
      if (method === "POST" && path === "/v1/sessions/social") {
        const body = await requestBody(request);
        if (body.idToken !== "id-token-secret" || body.state !== "oauth-state") {
          return sendJson(response, 401, { error: { code: "invalid_identity_token" } });
        }
        return sendJson(response, 201, { csrfToken: "csrf-secret" }, {
          "set-cookie": [
            "meshr_session=human-cookie-secret; Path=/; Secure; HttpOnly",
            "meshr_oauth_state=; Path=/; Max-Age=0; Secure; HttpOnly",
          ],
        });
      }
      if (method === "GET" && path === "/v1/me") {
        return request.headers.cookie?.includes("meshr_session=human-cookie-secret")
          ? sendJson(response, 200, { user: { id: "human-id" }, csrfToken: "csrf-secret" })
          : sendJson(response, 401, { error: { code: "authentication_required" } });
      }
      if (method === "POST" && path === "/v1/pairings") {
        return sendJson(response, 201, { pairingId: "pairing-id", pairingSecret: "pairing-secret" });
      }
      if (method === "POST" && path === "/v1/pairings/pairing-id/approve") {
        return sendJson(response, 200, { agent: { id: "agent-id", handle: "multi-replica-check" }, pairing: { status: "approved" } });
      }
      if (method === "POST" && path === "/v1/pairings/pairing-id/challenges") {
        return sendJson(response, 201, { challengeId: "challenge-id", message: "sign-this-message" });
      }
      if (method === "POST" && path === "/v1/agent-sessions") {
        return sendJson(response, 201, {
          agent: { id: "agent-id", handle: "multi-replica-check" },
          sessionId: "session-id",
          token: "agent-secret-token",
        });
      }
      if (path === "/v1/agent/profile" && !authorizedAgent) {
        return sendJson(response, 401, { error: { code: "agent_authentication_failed" } });
      }
      if (method === "GET" && path === "/v1/agent/profile") {
        return sendJson(response, 200, { agent: { id: "agent-id", handle: "multi-replica-check", tagline: currentTagline } });
      }
      if (method === "POST" && path === "/v1/agent-sessions/heartbeat") {
        return authorizedAgent
          ? sendJson(response, 200, { sessionId: "session-id", status: "online" })
          : sendJson(response, 401, { error: { code: "agent_authentication_failed" } });
      }
      if (method === "PUT" && path === "/v1/agent/profile") {
        const body = await requestBody(request);
        const input = JSON.stringify(body);
        const key = String(request.headers["idempotency-key"] ?? "");
        const prior = localIdempotency.get(key);
        if (prior && prior.input !== input) {
          return sendJson(response, 409, { error: { code: "idempotency_conflict" } });
        }
        if (prior) return sendJson(response, 200, prior.body);
        currentTagline = String((body.profile as Record<string, unknown> | undefined)?.tagline ?? "");
        const result = { agent: { id: "agent-id", handle: "multi-replica-check", tagline: currentTagline } };
        localIdempotency.set(key, { input, body: result });
        return sendJson(response, 200, result);
      }
      if (method === "GET" && path === "/v1/agent/meshes") {
        return sendJson(response, 200, {
          meshes: [{ id: "mesh-private-validation", visibility: "private", joinPolicy: "open", joined: true }],
        });
      }
      if (method === "POST" && path === "/v1/agent/meshes/mesh-private-validation/join") {
        return sendJson(response, 200, { status: "joined" });
      }
      if (method === "POST" && path === "/v1/agent/posts") {
        await requestBody(request);
        if (!authorizedAgent) return sendJson(response, 401, { error: { code: "agent_authentication_failed" } });
        if (localQuota.accepted >= 10) {
          return sendJson(response, 429, { error: { code: "agent_rate_limited" } }, { "retry-after": "1" });
        }
        localQuota.accepted += 1;
        return sendJson(response, 201, { post: { id: `post-${replica}-${localQuota.accepted}` } });
      }
      if (method === "DELETE" && path === "/v1/agents/agent-id/binding") {
        revoked = true;
        return sendJson(response, 200, {
          agentId: "agent-id",
          revoked: true,
          revokedPairings: 1,
          revokedSessions: 1,
          revokedPageGrants: 0,
        });
      }
      if (method === "DELETE" && path === "/v1/session") return sendJson(response, 200, { loggedOut: true });
      return sendJson(response, 404, { error: { code: "not_found" } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    };
  };

  const [podA, podB] = await Promise.all([startReplica("a"), startReplica("b")]);
  return {
    podAUrl: podA.url,
    podBUrl: podB.url,
    captured,
    close: async () => { await Promise.all([podA.close(), podB.close()]); },
  };
}

test("production-shaped API pods bind their instance identity to metadata.uid", async () => {
  for (const path of [
    "../deploy/production/workloads.yaml",
    "../deploy/canary/workloads.yaml",
  ]) {
    const workloads = await readFile(new URL(path, import.meta.url), "utf8");
    const apiDeployment = workloads.split("\n---\n", 1)[0] ?? "";
    assert.match(
      apiDeployment,
      /- name: MESHR_POD_UID\s+valueFrom:\s+fieldRef: \{\s*fieldPath: metadata\.uid\s*\}/,
      `${path} must source the API instance identity from the Downward API`,
    );
    assert.doesNotMatch(apiDeployment, /- name: MESHR_POD_UID\s+value:/);
  }
});

test("multi-replica verification defaults to a network-free non-passing dry run", async () => {
  let requests = 0;
  const evidence = await verifyMultiReplica(
    [
      "--pod-a-url", "http://127.0.0.1:18081",
      "--pod-b-url", "http://127.0.0.1:18082",
      "--origin", "https://staging.meshr.example",
      "--logical-host", "staging.meshr.example",
      "--mesh-id", "mesh-private-validation",
      "--topic-id", "topic-validation",
      "--agent-handle", "multi-replica-check",
      "--run-id", "run-dry-0001",
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
    ],
    {
      fetch: async () => {
        requests += 1;
        throw new Error("dry run attempted a network request");
      },
    },
  );

  assert.equal(requests, 0);
  assert.deepEqual(
    {
      ok: evidence.ok,
      executed: evidence.executed,
      mode: evidence.mode,
    },
    { ok: false, executed: false, mode: "dry-run" },
  );
  assert.equal(evidence.checks.length > 0, true);
  assert.equal(evidence.configuration.expectedReleaseSha, EXPECTED_RELEASE_SHA);
});

test("multi-replica verification requires one exact lowercase deployed release SHA", async () => {
  const base = [
    "--pod-a-url", "http://127.0.0.1:18081",
    "--pod-b-url", "http://127.0.0.1:18082",
    "--origin", "https://staging.meshr.example",
    "--logical-host", "staging.meshr.example",
    "--mesh-id", "mesh-private-validation",
    "--topic-id", "topic-validation",
    "--agent-handle", "multi-replica-check",
    "--run-id", "run-dry-0002",
  ];

  await assert.rejects(verifyMultiReplica(base), /--expected-release-sha is required/);
  for (const malformed of [
    "1".repeat(39),
    "1".repeat(41),
    "A".repeat(40),
    "g".repeat(40),
    "release-" + "1".repeat(40),
    ` ${EXPECTED_RELEASE_SHA}`,
    `${EXPECTED_RELEASE_SHA} `,
  ]) {
    await assert.rejects(
      verifyMultiReplica([...base, "--expected-release-sha", malformed]),
      /must be exactly 40 lowercase hexadecimal characters/,
    );
  }

  const loopbackOrigin = [...base];
  loopbackOrigin[loopbackOrigin.indexOf("--origin") + 1] = "https://127.0.0.1";
  loopbackOrigin[loopbackOrigin.indexOf("--logical-host") + 1] = "127.0.0.1";
  await assert.rejects(
    verifyMultiReplica([
      ...loopbackOrigin,
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
    ]),
    /--origin must be a non-loopback HTTPS origin/,
  );

  await assert.rejects(
    verifyMultiReplica([
      ...base,
      "--expected-release-sha",
      EXPECTED_RELEASE_SHA,
      "--unexpected-option",
    ]),
    /Unknown option --unexpected-option/,
  );
  await assert.rejects(
    verifyMultiReplica([
      ...base,
      "--expected-release-sha",
      EXPECTED_RELEASE_SHA,
      "--expected-release-sha",
      EXPECTED_RELEASE_SHA,
    ]),
    /--expected-release-sha may be supplied only once/,
  );
  const nonCanonicalOrigin = [...base];
  nonCanonicalOrigin[nonCanonicalOrigin.indexOf("--origin") + 1] =
    "https://staging.meshr.example/";
  await assert.rejects(
    verifyMultiReplica([
      ...nonCanonicalOrigin,
      "--expected-release-sha",
      EXPECTED_RELEASE_SHA,
    ]),
    /--origin must be a non-loopback HTTPS origin/,
  );
});

test(
  "timed-out restart hooks terminate descendants before rejecting",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "meshr-restart-hook-timeout-test-"));
    const hook = join(directory, "restart-hook.sh");
    const marker = join(directory, "orphan-survived");
    await writeFile(
      hook,
      `#!/bin/sh\n(node -e 'setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe"), 300); setInterval(() => {}, 1000)') &\nwhile true; do sleep 1; done\n`,
      { mode: 0o700 },
    );
    await chmod(hook, 0o700);
    t.after(() => rm(directory, { recursive: true, force: true }));

    await assert.rejects(
      runRestartHook(hook, 75, { PATH: process.env.PATH }),
      /exceeded its bounded timeout/,
    );
    await assert.rejects(readFile(marker), /ENOENT/);
  },
);

test(
  "completed restart hooks cannot leave disruption helpers running",
  { skip: process.platform === "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "meshr-restart-hook-exit-test-"));
    const hook = join(directory, "restart-hook.sh");
    const marker = join(directory, "orphan-survived");
    await writeFile(
      hook,
      `#!/bin/sh\n(node -e 'setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe"), 300); setInterval(() => {}, 1000)') &\nexit 0\n`,
      { mode: 0o700 },
    );
    await chmod(hook, 0o700);
    t.after(() => rm(directory, { recursive: true, force: true }));

    assert.equal(
      (await runRestartHook(hook, 2_000, { PATH: process.env.PATH })).exitCode,
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await assert.rejects(readFile(marker), /ENOENT/);
  },
);

test("multi-replica verification crosses replicas, fences races and writes secret-free evidence", async (t) => {
  const fleet = await startFleet({ finalInstanceFingerprintA: "c".repeat(32) });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-test-"));
  const output = join(directory, "evidence.json");
  const hook = join(directory, "restart-hook.sh");
  await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(hook, 0o700);
  const priorToken = process.env.MESHR_MULTI_REPLICA_ID_TOKEN;
  process.env.MESHR_MULTI_REPLICA_ID_TOKEN = "id-token-secret";
  t.after(() => {
    if (priorToken === undefined) delete process.env.MESHR_MULTI_REPLICA_ID_TOKEN;
    else process.env.MESHR_MULTI_REPLICA_ID_TOKEN = priorToken;
  });
  let hookRuns = 0;

  const evidence = await verifyMultiReplica(
    [
      "--execute",
      "--pod-a-url", fleet.podAUrl,
      "--pod-b-url", fleet.podBUrl,
      "--origin", "https://meshr.example.test",
      "--logical-host", "meshr.example.test",
      "--mesh-id", "mesh-private-validation",
      "--topic-id", "topic-validation",
      "--agent-handle", "multi-replica-check",
      "--run-id", "run-live-0001",
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
      "--social-provider", "google",
      "--output", output,
      "--restart-hook", hook,
    ],
    {
      sleep: async () => undefined,
      runHook: async (_path, _timeout, environment) => {
        hookRuns += 1;
        assert.equal(environment.MESHR_MULTI_REPLICA_ID_TOKEN, undefined);
        assert.equal(environment.MESHR_MULTI_REPLICA_HOOK_TARGET, "a");
        return { exitCode: 0, durationMs: 12 };
      },
    },
  );

  assert.equal(evidence.ok, true);
  assert.equal(evidence.executed, true);
  assert.equal(evidence.mode, "live");
  assert.equal(hookRuns, 1);
  assert.equal(evidence.results?.quota.totalSubmitted, 12);
  assert.deepEqual(evidence.results?.connectivity.instanceFingerprints, {
    a: "a".repeat(32),
    b: "b".repeat(32),
  });
  assert.deepEqual(evidence.results?.connectivity.finalInstanceFingerprints, {
    a: "c".repeat(32),
    b: "b".repeat(32),
  });
  assert.equal(evidence.configuration.expectedReleaseSha, EXPECTED_RELEASE_SHA);
  assert.deepEqual(evidence.results?.connectivity.observedReleaseShas, {
    initial: { a: EXPECTED_RELEASE_SHA, b: EXPECTED_RELEASE_SHA },
    final: { a: EXPECTED_RELEASE_SHA, b: EXPECTED_RELEASE_SHA },
  });
  assert.equal(evidence.results?.quota.accepted, 10);
  assert.equal(evidence.results?.quota.agentLimited, 2);
  assert.equal(evidence.results?.idempotency.conflictStatuses.sort().join(","), "200,409");
  assert.equal(evidence.results?.revocation.retryStatus, 401);
  assert.equal(fleet.captured.some((request) => request.replica === "a" && request.path === "/v1/agent-sessions"), true);
  assert.equal(fleet.captured.some((request) => request.replica === "b" && request.path === "/v1/agent/profile"), true);
  assert.equal(fleet.captured.some((request) => request.replica === "b" && request.path === "/v1/agents/agent-id/binding"), true);
  assert.equal(fleet.captured.every((request) => request.host === "meshr.example.test"), true);
  assert.equal(fleet.captured.every((request) => request.origin === "https://meshr.example.test"), true);

  const serialized = await readFile(output, "utf8");
  for (const secret of ["id-token-secret", "human-cookie-secret", "csrf-secret", "pairing-secret", "agent-secret-token", "sign-this-message"]) {
    assert.equal(serialized.includes(secret), false, `evidence leaked ${secret}`);
  }
  if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
});

test("multi-replica verification rejects two connection URLs for one pod instance", async (t) => {
  const fleet = await startFleet({ sameInstance: true });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-identity-test-"));
  const output = join(directory, "evidence.json");
  const environmentName = "MESHR_TEST_MULTI_REPLICA_IDENTITY_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => { delete process.env[environmentName]; });

  await assert.rejects(
    verifyMultiReplica(
      [
        "--execute",
        "--pod-a-url", fleet.podAUrl,
        "--pod-b-url", fleet.podBUrl,
        "--origin", "https://meshr.example.test",
        "--logical-host", "meshr.example.test",
        "--mesh-id", "mesh-private-validation",
        "--topic-id", "topic-validation",
        "--agent-handle", "multi-replica-check",
        "--run-id", "run-same-pod-identity",
        "--expected-release-sha", EXPECTED_RELEASE_SHA,
        "--id-token-env", environmentName,
        "--output", output,
      ],
      { sleep: async () => undefined },
    ),
    /resolved to the same Kubernetes pod instance/,
  );

  const evidence = JSON.parse(await readFile(output, "utf8")) as Record<string, any>;
  assert.equal(evidence.ok, false);
  assert.equal(evidence.failure.stage, "replica connectivity");
  assert.deepEqual(evidence.results.connectivity.instanceFingerprints, {
    a: "a".repeat(32),
    b: "a".repeat(32),
  });
});

test("multi-replica verification requires the Meshr health contract", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-health-contract-test-"));
  const environmentName = "MESHR_TEST_MULTI_REPLICA_HEALTH_CONTRACT_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => {
    delete process.env[environmentName];
    return rm(directory, { recursive: true, force: true });
  });
  for (const [index, scenario] of [
    { contractVersion: "2", expected: /omitted the expected Meshr contract response header/ },
    { healthStatus: "degraded", expected: /did not report Meshr API health/ },
  ].entries()) {
    const fleet = await startFleet(scenario);
    try {
      const output = join(directory, `evidence-${index}.json`);
      await assert.rejects(
        verifyMultiReplica([
          "--execute",
          "--pod-a-url", fleet.podAUrl,
          "--pod-b-url", fleet.podBUrl,
          "--origin", "https://meshr.example.test",
          "--logical-host", "meshr.example.test",
          "--mesh-id", "mesh-private-validation",
          "--topic-id", "topic-validation",
          "--agent-handle", "multi-replica-check",
          "--run-id", `run-health-contract-${index}`,
          "--expected-release-sha", EXPECTED_RELEASE_SHA,
          "--id-token-env", environmentName,
          "--output", output,
        ]),
        scenario.expected,
      );
      assert.equal(fleet.captured.every(({ path }) => path === "/healthz"), true);
    } finally {
      await fleet.close();
    }
  }
});

test("multi-replica verification rejects a replica-local idempotency ledger", async (t) => {
  const fleet = await startFleet({ partitionIdempotency: true });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-idempotency-test-"));
  const output = join(directory, "evidence.json");
  const environmentName = "MESHR_TEST_MULTI_REPLICA_IDEMPOTENCY_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => { delete process.env[environmentName]; });

  await assert.rejects(
    verifyMultiReplica(
      [
        "--execute",
        "--pod-a-url", fleet.podAUrl,
        "--pod-b-url", fleet.podBUrl,
        "--origin", "https://meshr.example.test",
        "--logical-host", "meshr.example.test",
        "--mesh-id", "mesh-private-validation",
        "--topic-id", "topic-validation",
        "--agent-handle", "multi-replica-check",
        "--run-id", "run-partitioned-idempotency",
        "--expected-release-sha", EXPECTED_RELEASE_SHA,
        "--id-token-env", environmentName,
        "--output", output,
      ],
      { sleep: async () => undefined },
    ),
    /exactly one success and one typed conflict/,
  );

  const evidence = JSON.parse(await readFile(output, "utf8")) as Record<string, any>;
  assert.equal(evidence.ok, false);
  assert.equal(evidence.failure.stage, "cross-replica idempotency races");
  assert.deepEqual(evidence.results.idempotency.conflictStatuses, [200, 200]);
  assert.equal(evidence.results.failureCleanup.revocationStatus, 200);
  assert.equal(JSON.stringify(evidence).includes("id-token-secret"), false);
});

test("multi-replica verification rejects replica-local quota buckets", async (t) => {
  const fleet = await startFleet({ partitionQuota: true });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-quota-test-"));
  const output = join(directory, "evidence.json");
  const environmentName = "MESHR_TEST_MULTI_REPLICA_QUOTA_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => { delete process.env[environmentName]; });

  await assert.rejects(
    verifyMultiReplica(
      [
        "--execute",
        "--pod-a-url", fleet.podAUrl,
        "--pod-b-url", fleet.podBUrl,
        "--origin", "https://meshr.example.test",
        "--logical-host", "meshr.example.test",
        "--mesh-id", "mesh-private-validation",
        "--topic-id", "topic-validation",
        "--agent-handle", "multi-replica-check",
        "--run-id", "run-partitioned-quota",
        "--expected-release-sha", EXPECTED_RELEASE_SHA,
        "--id-token-env", environmentName,
        "--output", output,
      ],
      { sleep: async () => undefined },
    ),
    /did not enforce the shared 10-write agent capacity/,
  );

  const evidence = JSON.parse(await readFile(output, "utf8")) as Record<string, any>;
  assert.equal(evidence.ok, false);
  assert.equal(evidence.failure.stage, "split aggregate quota burst");
  assert.equal(evidence.results.quota.accepted, 12);
  assert.equal(evidence.results.quota.agentLimited, 0);
  assert.equal(evidence.results.failureCleanup.revocationStatus, 200);
});

test("multi-replica verification rejects stale deployed revisions before mutation and binds failure evidence", async (t) => {
  const fleet = await startFleet({
    initialReleaseShaA: STALE_RELEASE_SHA,
    initialReleaseShaB: STALE_RELEASE_SHA,
  });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-stale-sha-test-"));
  const output = join(directory, "evidence.json");
  const environmentName = "MESHR_TEST_MULTI_REPLICA_STALE_SHA_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => { delete process.env[environmentName]; });

  await assert.rejects(
    verifyMultiReplica([
      "--execute",
      "--pod-a-url", fleet.podAUrl,
      "--pod-b-url", fleet.podBUrl,
      "--origin", "https://meshr.example.test",
      "--logical-host", "meshr.example.test",
      "--mesh-id", "mesh-private-validation",
      "--topic-id", "topic-validation",
      "--agent-handle", "multi-replica-check",
      "--run-id", "run-stale-release-sha",
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
      "--id-token-env", environmentName,
      "--output", output,
    ]),
    /reported stale release SHA .* during the initial provenance check/,
  );

  assert.equal(fleet.captured.every(({ path }) => path === "/healthz"), true);
  const evidence = JSON.parse(await readFile(output, "utf8")) as Record<string, any>;
  assert.equal(evidence.configuration.expectedReleaseSha, EXPECTED_RELEASE_SHA);
  assert.deepEqual(evidence.results.connectivity.observedReleaseShas.initial, {
    a: STALE_RELEASE_SHA,
    b: STALE_RELEASE_SHA,
  });
  assert.equal(evidence.failure.stage, "replica connectivity");
});

test("multi-replica verification rejects mixed deployed revisions before mutation", async (t) => {
  const fleet = await startFleet({ initialReleaseShaB: STALE_RELEASE_SHA });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-mixed-sha-test-"));
  const output = join(directory, "evidence.json");
  const environmentName = "MESHR_TEST_MULTI_REPLICA_MIXED_SHA_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => { delete process.env[environmentName]; });

  await assert.rejects(
    verifyMultiReplica([
      "--execute",
      "--pod-a-url", fleet.podAUrl,
      "--pod-b-url", fleet.podBUrl,
      "--origin", "https://meshr.example.test",
      "--logical-host", "meshr.example.test",
      "--mesh-id", "mesh-private-validation",
      "--topic-id", "topic-validation",
      "--agent-handle", "multi-replica-check",
      "--run-id", "run-mixed-release-sha",
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
      "--id-token-env", environmentName,
      "--output", output,
    ]),
    /reported mixed release SHAs during the initial provenance check/,
  );

  assert.equal(fleet.captured.every(({ path }) => path === "/healthz"), true);
  const evidence = JSON.parse(await readFile(output, "utf8")) as Record<string, any>;
  assert.deepEqual(evidence.results.connectivity.observedReleaseShas.initial, {
    a: EXPECTED_RELEASE_SHA,
    b: STALE_RELEASE_SHA,
  });
});

test("multi-replica verification rejects a mixed revision introduced during the live flow", async (t) => {
  const fleet = await startFleet({ finalReleaseShaB: STALE_RELEASE_SHA });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-final-sha-test-"));
  const output = join(directory, "evidence.json");
  const environmentName = "MESHR_TEST_MULTI_REPLICA_FINAL_SHA_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => { delete process.env[environmentName]; });

  await assert.rejects(
    verifyMultiReplica([
      "--execute",
      "--pod-a-url", fleet.podAUrl,
      "--pod-b-url", fleet.podBUrl,
      "--origin", "https://meshr.example.test",
      "--logical-host", "meshr.example.test",
      "--mesh-id", "mesh-private-validation",
      "--topic-id", "topic-validation",
      "--agent-handle", "multi-replica-check",
      "--run-id", "run-final-release-sha",
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
      "--id-token-env", environmentName,
      "--output", output,
    ], { sleep: async () => undefined }),
    /reported mixed release SHAs during the final provenance check/,
  );

  const evidence = JSON.parse(await readFile(output, "utf8")) as Record<string, any>;
  assert.equal(evidence.failure.stage, "final release provenance");
  assert.deepEqual(evidence.results.connectivity.observedReleaseShas, {
    initial: { a: EXPECTED_RELEASE_SHA, b: EXPECTED_RELEASE_SHA },
    final: { a: EXPECTED_RELEASE_SHA, b: STALE_RELEASE_SHA },
  });
});

test("multi-replica verification rejects final connections that converge on one pod", async (t) => {
  const fleet = await startFleet({ finalInstanceFingerprintB: "a".repeat(32) });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-final-instance-test-"));
  const output = join(directory, "evidence.json");
  const environmentName = "MESHR_TEST_MULTI_REPLICA_FINAL_INSTANCE_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => { delete process.env[environmentName]; });

  await assert.rejects(
    verifyMultiReplica([
      "--execute",
      "--pod-a-url", fleet.podAUrl,
      "--pod-b-url", fleet.podBUrl,
      "--origin", "https://meshr.example.test",
      "--logical-host", "meshr.example.test",
      "--mesh-id", "mesh-private-validation",
      "--topic-id", "topic-validation",
      "--agent-handle", "multi-replica-check",
      "--run-id", "run-final-pod-identity",
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
      "--id-token-env", environmentName,
      "--output", output,
    ], { sleep: async () => undefined }),
    /resolved to the same Kubernetes pod instance during the final provenance check/,
  );

  const evidence = JSON.parse(await readFile(output, "utf8")) as Record<string, any>;
  assert.equal(evidence.failure.stage, "final release provenance");
  assert.deepEqual(evidence.results.connectivity.finalInstanceFingerprints, {
    a: "a".repeat(32),
    b: "a".repeat(32),
  });
});

test("multi-replica verification rejects an unplanned pod rebind", async (t) => {
  const fleet = await startFleet({ finalInstanceFingerprintA: "c".repeat(32) });
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-rebind-test-"));
  const output = join(directory, "evidence.json");
  const environmentName = "MESHR_TEST_MULTI_REPLICA_REBIND_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => {
    delete process.env[environmentName];
    return rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    verifyMultiReplica([
      "--execute",
      "--pod-a-url", fleet.podAUrl,
      "--pod-b-url", fleet.podBUrl,
      "--origin", "https://meshr.example.test",
      "--logical-host", "meshr.example.test",
      "--mesh-id", "mesh-private-validation",
      "--topic-id", "topic-validation",
      "--agent-handle", "multi-replica-check",
      "--run-id", "run-unplanned-rebind",
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
      "--id-token-env", environmentName,
      "--output", output,
    ], { sleep: async () => undefined }),
    /connection was rebound during a run without a restart hook/,
  );
});

test("multi-replica verification rejects a no-op restart hook", async (t) => {
  const fleet = await startFleet();
  t.after(() => fleet.close());
  const directory = await mkdtemp(join(tmpdir(), "meshr-multi-replica-noop-hook-test-"));
  const output = join(directory, "evidence.json");
  const hook = join(directory, "restart-hook.sh");
  await writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(hook, 0o700);
  const environmentName = "MESHR_TEST_MULTI_REPLICA_NOOP_HOOK_TOKEN";
  process.env[environmentName] = "id-token-secret";
  t.after(() => {
    delete process.env[environmentName];
    return rm(directory, { recursive: true, force: true });
  });

  await assert.rejects(
    verifyMultiReplica([
      "--execute",
      "--pod-a-url", fleet.podAUrl,
      "--pod-b-url", fleet.podBUrl,
      "--origin", "https://meshr.example.test",
      "--logical-host", "meshr.example.test",
      "--mesh-id", "mesh-private-validation",
      "--topic-id", "topic-validation",
      "--agent-handle", "multi-replica-check",
      "--run-id", "run-noop-restart-hook",
      "--expected-release-sha", EXPECTED_RELEASE_SHA,
      "--id-token-env", environmentName,
      "--output", output,
      "--restart-hook", hook,
    ], {
      sleep: async () => undefined,
      runHook: async () => ({ exitCode: 0, durationMs: 1 }),
    }),
    /restart hook did not replace replica A/,
  );
});
