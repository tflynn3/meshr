import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { test } from "node:test";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";

const enabled = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST && process.env.PUBSUB_EMULATOR_HOST,
);

type Worker = { child: ChildProcess; output: () => string };

async function freePort(): Promise<number> {
  const listener = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function startWorker(entry: string, env: Record<string, string>): Worker {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), entry],
    { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-16_000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { child, output: () => output };
}

async function stopWorker(worker: Worker | undefined): Promise<void> {
  if (!worker || worker.child.exitCode !== null) return;
  worker.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      worker.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    worker.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForReady(url: string, worker: Worker, label: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (worker.child.exitCode !== null) {
      throw new Error(`${label} exited before readiness (${worker.child.exitCode})\n${worker.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not become ready: ${lastError}\n${worker.output()}`);
}

async function waitFor(check: () => Promise<boolean>, label: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ""}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("moderation worker readiness and provider decisions are durable and replayable", {
  skip: !enabled,
  timeout: 120_000,
}, async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const projectId = `meshr-moderation-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const topicName = "mesh-events";
  const subscriptionName = "moderation-worker";
  const firestore = new Firestore({ projectId, databaseId: "(default)" });
  const pubsub = new PubSub({ projectId });
  const providerPort = await freePort();
  const workerPort = await freePort();
  const ingestPort = await freePort();
  let provider: Server | undefined;
  let moderation: Worker | undefined;
  let ingest: Worker | undefined;
  let screenCalls = 0;
  let healthCalls = 0;
  let authorizationHeader = "";

  const now = new Date().toISOString();
  const repository = new FirestoreMeshrRepository({ firestore });
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const accountSessionHash = sha256(`${suffix}:human`);
  const pairingId = `binding_${suffix}`;
  const agentId = `agent_${suffix}`;
  const sessionId = `session_${suffix}`;
  const postId = `post_${suffix}`;

  try {
    await pubsub.createTopic(topicName);
    await pubsub.topic(topicName).createSubscription(subscriptionName, {
      enableMessageOrdering: true,
      ackDeadlineSeconds: 30,
    });
    await repository.ensureEmptyProduction();
    const account = await repository.createSocialAccount({
      provider: "google",
      subject: `${suffix}:google`,
      email: `${suffix}@example.test`,
      displayName: "Moderation Owner",
    });
    await repository.createHumanSession({
      tokenHash: accountSessionHash,
      accountId: account.accountId,
      csrfToken: `${suffix}:csrf`,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      absoluteExpiresAt: new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    });
    await repository.createPairing({
      pairingId,
      code: `MOD-${suffix.slice(-8).toUpperCase()}`,
      secretHash: sha256(`${suffix}:pairing`),
      runtime: "openclaw",
      runtimeLabel: "Moderation test host",
      externalSubject: `openclaw:${suffix}`,
      publicKeyPem,
      requestedProfile: null,
      definitionDigest: null,
      status: "pending",
      ownerAccountId: null,
      agentId: null,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 15 * 60 * 1_000).toISOString(),
      approvedAt: null,
      claimedAt: null,
    });
    await repository.approvePairing({
      pairingId,
      ownerAccountId: account.accountId,
      humanSessionHash: accountSessionHash,
      agentId,
      profile: {
        name: "Moderation Agent",
        handle: `moderation-${suffix.slice(-12)}`,
        tagline: "Provider readiness participant",
        interests: ["safety"],
        personality: "Careful and bounded.",
        attention: { browse: "public", rootPosts: "autonomous", replies: "autonomous" },
      },
      approvedAt: now,
    });
    await repository.startRuntimeSession({
      agentId,
      bindingId: pairingId,
      sessionId,
      runtimeKind: "openclaw",
      tokenHash: sha256(`${suffix}:runtime`),
      expiresAt: new Date(Date.parse(now) + 15 * 60 * 1_000).toISOString(),
    });

    provider = createHttpServer((request, response) => {
      authorizationHeader = request.headers.authorization ?? "";
      if (request.method === "GET" && request.url === "/healthz") {
        healthCalls += 1;
        response.writeHead(204).end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/screen") {
        response.writeHead(404).end();
        return;
      }
      screenCalls += 1;
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ action: "allow", reason: "provider_test_allow", severity: "low" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      provider!.once("error", reject);
      provider!.listen(providerPort, "127.0.0.1", () => resolve());
    });

    const commonEnv = {
      GOOGLE_CLOUD_PROJECT: projectId,
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST!,
      PUBSUB_EMULATOR_HOST: process.env.PUBSUB_EMULATOR_HOST!,
      MESHR_FIRESTORE_DATABASE: "(default)",
      MESHR_TOPOLOGY_FIRESTORE_DATABASE: "(default)",
      MESHR_EVENTS_TOPIC: topicName,
      MESHR_MODERATION_SUBSCRIPTION: subscriptionName,
      MESHR_HOST: "127.0.0.1",
    };
    moderation = startWorker("platform/materializer.ts", {
      ...commonEnv,
      MESHR_CONSUMER: "moderation",
      MESHR_PORT: String(workerPort),
      MESHR_ENV: "local",
      MESHR_MODERATION_REQUIRED: "1",
      MESHR_MODERATION_AUTH: "static",
      MESHR_MODERATION_TOKEN: "provider-token",
      MESHR_MODERATION_ENDPOINT: `http://127.0.0.1:${providerPort}/screen`,
      MESHR_MODERATION_HEALTHCHECK_URL: `http://127.0.0.1:${providerPort}/healthz`,
    });
    await waitForReady(`http://127.0.0.1:${workerPort}/readyz`, moderation, "moderation worker");
    assert.ok(healthCalls >= 1);

    ingest = startWorker("platform/ingest.ts", {
      ...commonEnv,
      MESHR_CONSUMER: "",
      MESHR_PORT: String(ingestPort),
      MESHR_INTERNAL_TOKEN: `${suffix}:internal-token`,
    });
    await waitForReady(`http://127.0.0.1:${ingestPort}/readyz`, ingest, "ingest worker");

    const write = await repository.createPostWithOutbox({
      postId,
      meshId: "mesh-public",
      topicId: "topic-small-discoveries",
      agentId,
      sessionId,
      parentPostId: null,
      body: "A provider-screened observation.",
      moderationState: "quarantined",
      moderationReason: "new_identity",
      moderationSeverity: "high",
      expiresAt: new Date(Date.parse(now) + 90 * 24 * 60 * 60 * 1_000).toISOString(),
      eventType: "post.created",
      idempotencyKey: `${suffix}:post`,
      requestHash: sha256(`${suffix}:post-request`),
      ownerAccountId: account.accountId,
    });
    assert.equal(write.duplicate, false);
    const postRef = firestore.collection("posts").doc(postId);
    const moderationRef = firestore.collection("moderation_inbox").doc(postId);
    await waitFor(async () => (await firestore.collection("event_outbox").doc(postId).get()).get("status") === "published", "outbox publication");
    await waitFor(async () => (await moderationRef.get()).get("state") === "resolved", "moderation resolution");
    const post = await postRef.get();
    assert.equal(post.get("moderation_state"), "published");
    assert.equal(screenCalls, 1);
    assert.equal(authorizationHeader, "Bearer provider-token");
    assert.equal((await moderationRef.get()).get("resolution"), "allow");
    const screenedEvents = await firestore
      .collection("event_outbox")
      .where("envelope.type", "==", "moderation.screened")
      .limit(10)
      .get();
    assert.equal(screenedEvents.size, 1);
    assert.equal(screenedEvents.docs[0]?.get("observation_scope"), "public");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nmoderation output:\n${moderation?.output() ?? ""}\ningest output:\n${ingest?.output() ?? ""}`);
  } finally {
    await stopWorker(ingest);
    await stopWorker(moderation);
    await new Promise<void>((resolve) => provider?.close(() => resolve()) ?? resolve());
    await Promise.all([pubsub.close(), firestore.terminate()]);
  }
});
