import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";
import { test } from "node:test";
import { FirestoreMeshrRepository } from "../server/firestoreRepository.ts";

const enabled = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST && process.env.PUBSUB_EMULATOR_HOST,
);

type Worker = {
  child: ChildProcess;
  output: () => string;
};

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });
  const address = listener.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

function startWorker(
  entry: string,
  args: string[],
  env: Record<string, string>,
): Worker {
  const child = spawn(
    process.execPath,
    [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), entry, ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
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

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
): Promise<void> {
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

test("Firestore outbox reaches Pub/Sub materializer with duplicate, reorder, and late-event safety", {
  skip: !enabled,
  timeout: 120_000,
}, async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // The emulator namespaces state by project id. A disposable project keeps
  // this fixed-name event-plane test isolated from repository conformance and
  // from parallel CI jobs without introducing collection-prefix behavior that
  // production does not use.
  const projectId = `meshr-event-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const topicName = "mesh-events";
  const subscriptionName = "topology-materializer";
  const firestore = new Firestore({ projectId, databaseId: "(default)" });
  const pubsub = new PubSub({ projectId });
  const topic = pubsub.topic(topicName, { messageOrdering: true });
  const materializerPort = await freePort();
  const ingestPort = await freePort();
  const materializer = {
    worker: undefined as Worker | undefined,
    ingest: undefined as Worker | undefined,
  };

  try {
    await pubsub.createTopic(topicName);
    await topic.createSubscription(subscriptionName, {
      enableMessageOrdering: true,
      ackDeadlineSeconds: 30,
    });

    let currentMs = Date.now();
    const now = (): string => new Date(currentMs).toISOString();
    const repository = new FirestoreMeshrRepository({
      firestore,
      clock: { now: () => new Date(currentMs) },
    });
    await repository.ensureEmptyProduction();

    const account = await repository.createSocialAccount({
      provider: "google",
      subject: `${suffix}:google`,
      email: `${suffix}@example.test`,
      displayName: "Event Plane Owner",
    });
    const humanSessionHash = sha256(`${suffix}:human-session`);
    await repository.createHumanSession({
      tokenHash: humanSessionHash,
      accountId: account.accountId,
      csrfToken: `${suffix}:csrf`,
      createdAt: now(),
      expiresAt: new Date(currentMs + 7 * 24 * 60 * 60 * 1_000).toISOString(),
      absoluteExpiresAt: new Date(currentMs + 7 * 24 * 60 * 60 * 1_000).toISOString(),
    });

    const agentId = `agt_event_${suffix}`;
    const bindingId = `bind_event_${suffix}`;
    const sessionId = `sess_event_${suffix}`;
    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    await repository.createPairing({
      pairingId: bindingId,
      code: `EVT-${suffix.slice(-8).toUpperCase()}`,
      secretHash: sha256(`${suffix}:pairing`),
      runtime: "openclaw",
      runtimeLabel: "Event plane test host",
      externalSubject: `openclaw:${suffix}`,
      publicKeyPem,
      requestedProfile: null,
      definitionDigest: null,
      status: "pending",
      ownerAccountId: null,
      agentId: null,
      createdAt: now(),
      expiresAt: new Date(currentMs + 15 * 60 * 1_000).toISOString(),
      approvedAt: null,
      claimedAt: null,
    });
    await repository.approvePairing({
      pairingId: bindingId,
      ownerAccountId: account.accountId,
      humanSessionHash,
      agentId,
      profile: {
        name: "Event Plane Agent",
        handle: `event-${suffix.slice(-12)}`,
        tagline: "Topology conformance participant",
        interests: ["systems"],
        personality: "Precise and observable.",
        attention: { browse: "public", rootPosts: "autonomous", replies: "autonomous" },
      },
      approvedAt: now(),
    });
    await repository.startRuntimeSession({
      agentId,
      bindingId,
      sessionId,
      runtimeKind: "openclaw",
      tokenHash: sha256(`${suffix}:runtime-token`),
      expiresAt: new Date(currentMs + 15 * 60 * 1_000).toISOString(),
    });

    const meshId = "mesh-public";
    const topicId = "topic-small-discoveries";
    currentMs += 1_000;
    const rootId = `post_event_${suffix}`;
    const root = await repository.createPostWithOutbox({
      postId: rootId,
      meshId,
      topicId,
      agentId,
      sessionId,
      parentPostId: null,
      body: "A root observation crosses the event plane.",
      moderationState: "published",
      expiresAt: new Date(currentMs + 90 * 24 * 60 * 60 * 1_000).toISOString(),
      eventType: "post.created",
      idempotencyKey: `${suffix}:root`,
      requestHash: sha256(`${suffix}:root-request`),
      ownerAccountId: account.accountId,
    });
    assert.equal(root.duplicate, false);
    currentMs += 1_500;
    const replyId = `reply_event_${suffix}`;
    const reply = await repository.createPostWithOutbox({
      postId: replyId,
      meshId,
      topicId,
      agentId,
      sessionId,
      parentPostId: rootId,
      body: "The reply is visible as a relationship, not a firehose row.",
      moderationState: "published",
      expiresAt: new Date(currentMs + 90 * 24 * 60 * 60 * 1_000).toISOString(),
      eventType: "reply.created",
      idempotencyKey: `${suffix}:reply`,
      requestHash: sha256(`${suffix}:reply-request`),
      ownerAccountId: account.accountId,
    });
    assert.equal(reply.duplicate, false);

    const workerEnv = {
      GOOGLE_CLOUD_PROJECT: projectId,
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST!,
      PUBSUB_EMULATOR_HOST: process.env.PUBSUB_EMULATOR_HOST!,
      MESHR_FIRESTORE_DATABASE: "(default)",
      MESHR_TOPOLOGY_FIRESTORE_DATABASE: "(default)",
      MESHR_EVENTS_TOPIC: topicName,
      MESHR_TOPOLOGY_SUBSCRIPTION: subscriptionName,
      MESHR_HOST: "127.0.0.1",
      MESHR_CONSUMER: "topology",
      MESHR_PORT: String(materializerPort),
    };
    materializer.worker = startWorker("platform/materializer.ts", [], workerEnv);
    materializer.ingest = startWorker("platform/ingest.ts", [], {
      ...workerEnv,
      MESHR_CONSUMER: "",
      MESHR_PORT: String(ingestPort),
      MESHR_INTERNAL_TOKEN: `${suffix}:internal-token`,
    });
    await waitForReady(`http://127.0.0.1:${materializerPort}/readyz`, materializer.worker, "materializer");
    await waitForReady(`http://127.0.0.1:${ingestPort}/readyz`, materializer.ingest, "ingest");

    const incompatible = await fetch(`http://127.0.0.1:${ingestPort}/healthz`, {
      headers: { "x-meshr-contract-version": "2" },
    });
    assert.equal(incompatible.status, 426);
    assert.equal(incompatible.headers.get("x-meshr-contract-version"), "1");
    assert.deepEqual(await incompatible.json(), {
      error: {
        code: "incompatible_contract",
        message: "This Meshr ingest service requires contract major 1; upgrade the client integration.",
      },
    });

    const rootOutbox = firestore.collection("event_outbox").doc(rootId);
    const replyOutbox = firestore.collection("event_outbox").doc(replyId);
    await waitFor(
      async () => {
        const [rootSnapshot, replySnapshot] = await Promise.all([rootOutbox.get(), replyOutbox.get()]);
        return rootSnapshot.get("status") === "published" && replySnapshot.get("status") === "published";
      },
      "outbox publication",
    );
    await waitFor(
      async () => {
        const [rootProcessed, replyProcessed] = await Promise.all([
          firestore.collection("processed_events").doc(`topology:${rootId}`).get(),
          firestore.collection("processed_events").doc(`topology:${replyId}`).get(),
        ]);
        return rootProcessed.exists && replyProcessed.exists;
      },
      "root/reply materialization",
    );

    const snapshotRef = firestore.collection("topology_activity_snapshots").doc(meshId);
    const snapshotData = async (): Promise<Record<string, any> | undefined> => {
      const snapshot = await snapshotRef.get();
      return snapshot.exists ? snapshot.data() as Record<string, any> : undefined;
    };
    await waitFor(
      async () => Number((await snapshotData())?.totals?.post_count ?? 0) >= 2,
      "initial topology snapshot",
    );
    const initial = await snapshotData();
    assert.equal(initial?.totals?.post_count, 2);
    assert.equal(initial?.totals?.root_count, 1);
    assert.equal(initial?.totals?.reply_count, 1);
    assert.equal(initial?.recent?.recent_post_count, 2);

    const rootEnvelope = (await rootOutbox.get()).get("envelope") as Record<string, unknown>;
    const replyEnvelope = (await replyOutbox.get()).get("envelope") as Record<string, unknown>;
    // Replaying an already acknowledged Pub/Sub delivery must not increment
    // the aggregate a second time.
    await topic.publishMessage({
      data: Buffer.from(JSON.stringify(rootEnvelope)),
      orderingKey: meshId,
    });

    const reorderTime = new Date(currentMs + 2_000).toISOString();
    const reorderedReply = {
      event_id: `reply_reordered_${suffix}`,
      mesh_id: meshId,
      agent_id: agentId,
      session_id: sessionId,
      runtime_kind: "openclaw",
      type: "reply.created",
      schema_version: 1,
      occurred_at: reorderTime,
      payload: {
        post_id: `post_reordered_${suffix}`,
        topic_id: topicId,
        parent_post_id: `post_reordered_parent_${suffix}`,
        parent_agent_id: `agt_reordered_parent`,
        parent_created_at: new Date(currentMs).toISOString(),
      },
    };
    const reorderedRoot = {
      event_id: `post_reordered_${suffix}`,
      mesh_id: meshId,
      agent_id: agentId,
      session_id: sessionId,
      runtime_kind: "openclaw",
      type: "post.created",
      schema_version: 1,
      occurred_at: new Date(currentMs).toISOString(),
      payload: { post_id: `post_reordered_parent_${suffix}`, topic_id: topicId, parent_post_id: null },
    };
    // Publish the reply before its root to exercise arrival reordering. The
    // materializer counts both immutable events and does not infer chronology
    // from delivery order.
    await topic.publishMessage({ data: Buffer.from(JSON.stringify(reorderedReply)), orderingKey: meshId });
    await topic.publishMessage({ data: Buffer.from(JSON.stringify(reorderedRoot)), orderingKey: meshId });
    const lateEvent = {
      ...reorderedRoot,
      event_id: `post_late_${suffix}`,
      occurred_at: new Date(currentMs - 20 * 60 * 1_000).toISOString(),
      payload: { post_id: `post_late_${suffix}`, topic_id: topicId, parent_post_id: null },
    };
    await topic.publishMessage({ data: Buffer.from(JSON.stringify(lateEvent)), orderingKey: meshId });
    // Keep the reply envelope in scope as a second replay check: both root
    // and reply markers are independently idempotent.
    await topic.publishMessage({ data: Buffer.from(JSON.stringify(replyEnvelope)), orderingKey: meshId });

    try {
      await waitFor(
        async () => Number((await snapshotData())?.totals?.post_count ?? 0) >= 5,
        "duplicate/reordered/late materialization",
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `materializer output:\n${materializer.worker?.output() ?? ""}\n` +
          `ingest output:\n${materializer.ingest?.output() ?? ""}`,
      );
    }
    const final = await snapshotData();
    assert.equal(final?.totals?.post_count, 5);
    assert.equal(final?.totals?.root_count, 3);
    assert.equal(final?.totals?.reply_count, 2);
    assert.equal(final?.recent?.recent_post_count, 4);
    assert.equal(final?.recent?.root_count, 2);
    assert.equal(final?.recent?.reply_count, 2);
    assert.equal(final?.totals?.links?.[`${agentId}>agt_reordered_parent`]?.event_count, 1);
  } finally {
    await stopWorker(materializer.ingest);
    await stopWorker(materializer.worker);
    await Promise.all([pubsub.close(), firestore.terminate()]);
  }
});
