import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  classifyDeadLetterSource,
  DEAD_LETTER_TARGETS,
  normalizeSourceSubscription,
  parseModerationScreeningJob,
  parseReplaySelector,
  parseReplaySelectors,
  replayPayload,
} from "../platform/deadLetterReplay.ts";

const production = DEAD_LETTER_TARGETS.production;

function replayCli(environment: Record<string, string>): string {
  const cleanEnvironment = { ...process.env };
  for (const key of Object.keys(cleanEnvironment)) {
    if (key.startsWith("MESHR_REPLAY_") || key.startsWith("MESHR_FIRESTORE_") || key.startsWith("MESHR_AUDIT_") || key === "MESHR_EVENTS_TOPIC" || key === "MESHR_DLQ_SUBSCRIPTION") {
      delete cleanEnvironment[key];
    }
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/replay-dead-letter.ts"],
    {
      cwd: process.cwd(),
      env: { ...cleanEnvironment, ...environment },
      encoding: "utf8",
    },
  );
  return `${result.stdout}${result.stderr}`;
}

test("binds DLQ routes to the source subscription and project", () => {
  assert.equal(
    classifyDeadLetterSource(
      {
        CloudPubSubDeadLetterSourceSubscriptionProject: "demo-project",
        CloudPubSubDeadLetterSourceSubscription: "projects/demo-project/subscriptions/moderation-screening-worker",
      },
      production,
      "demo-project",
    ),
    "moderation-screening",
  );
  assert.equal(
    classifyDeadLetterSource(
      {
        CloudPubSubDeadLetterSourceSubscriptionProject: "demo-project",
        CloudPubSubDeadLetterSourceSubscription: "topology-materializer",
      },
      production,
      "demo-project",
    ),
    "events",
  );
  assert.equal(
    normalizeSourceSubscription(
      "projects/demo-project/subscriptions/topology-materializer",
      "demo-project",
    ),
    "topology-materializer",
  );
  assert.equal(DEAD_LETTER_TARGETS.canary.deadLetterSubscription, "mesh-events-canary-dlq-replay");
  assert.equal(DEAD_LETTER_TARGETS.production.authorityDatabase, "(default)");
  assert.equal(DEAD_LETTER_TARGETS.canary.authorityDatabase, "meshr-canary");
  assert.equal(DEAD_LETTER_TARGETS.canary.eventTopic, "mesh-events-canary");
  assert.equal(DEAD_LETTER_TARGETS.canary.auditDatabase, "meshr-canary-release-audit");
});

test("requires route-qualified replay selectors", () => {
  assert.deepEqual(parseReplaySelector("events:event-1234"), {
    route: "events",
    eventId: "event-1234",
    key: "events:event-1234",
  });
  assert.deepEqual(parseReplaySelectors("events:event-1234, moderation-screening:event-1234"), [
    { route: "events", eventId: "event-1234", key: "events:event-1234" },
    { route: "moderation-screening", eventId: "event-1234", key: "moderation-screening:event-1234" },
  ]);
  assert.throws(
    () => parseReplaySelectors("event-1234"),
    /route-qualified selectors/,
  );
  assert.throws(
    () => parseReplaySelectors("events:"),
    /route-qualified selectors/,
  );
});

test("replay CLI fails closed on cross-environment configuration", () => {
  assert.match(
    replayCli({
      GOOGLE_CLOUD_PROJECT: "demo-project",
      MESHR_REPLAY_SOURCE: "outbox",
      MESHR_REPLAY_ENVIRONMENT: "canary",
      MESHR_FIRESTORE_DATABASE: "meshr",
      MESHR_EVENTS_TOPIC: "mesh-events-canary",
    }),
    /MESHR_FIRESTORE_DATABASE must be meshr-canary/,
  );
  assert.match(
    replayCli({
      GOOGLE_CLOUD_PROJECT: "demo-project",
      MESHR_REPLAY_SOURCE: "dlq",
      MESHR_REPLAY_ENVIRONMENT: "production",
      MESHR_DLQ_SUBSCRIPTION: "mesh-events-canary-dlq-replay",
      MESHR_EVENTS_TOPIC: "mesh-events-canary",
    }),
    /DLQ replay target mismatch/,
  );
  assert.match(
    replayCli({
      GOOGLE_CLOUD_PROJECT: "demo-project",
      MESHR_REPLAY_SOURCE: "outbox",
      MESHR_REPLAY_ENVIRONMENT: "production",
      MESHR_FIRESTORE_DATABASE: "(default)",
      MESHR_EVENTS_TOPIC: "mesh-events",
      MESHR_REPLAY_RESTORE_DATABASE: "meshr-canary",
      MESHR_REPLAY_RESTORE_APPROVAL: "database:meshr-canary",
    }),
    /cannot name a live production or canary authority database/,
  );
  assert.match(
    replayCli({
      GOOGLE_CLOUD_PROJECT: "demo-project",
      MESHR_REPLAY_SOURCE: "outbox",
      MESHR_REPLAY_ENVIRONMENT: "production",
      MESHR_FIRESTORE_DATABASE: "(default)",
      MESHR_EVENTS_TOPIC: "mesh-events",
      MESHR_REPLAY_RESTORE_DATABASE: "meshr-restored-20260829",
    }),
    /MESHR_REPLAY_RESTORE_APPROVAL must exactly equal/,
  );
});

test("replay CLI rejects a checkpoint whose environment tuple changed", () => {
  const directory = mkdtempSync(`${tmpdir()}/meshr-replay-checkpoint-`);
  const checkpoint = `${directory}/checkpoint.json`;
  writeFileSync(checkpoint, JSON.stringify({
    version: 2,
    runId: "replay-reviewed",
    source: "outbox",
    environment: "production",
    authorityDatabase: "(default)",
    restoreDatabase: null,
    eventTopic: "mesh-events",
    auditDatabase: "meshr-release-audit",
    since: "2026-08-29T00:00:00.000Z",
    until: "2026-08-29T01:00:00.000Z",
    cursor: null,
    complete: false,
    updatedAt: "2026-08-29T01:00:00.000Z",
    replayed: 0,
  }));
  try {
    assert.match(
      replayCli({
        GOOGLE_CLOUD_PROJECT: "demo-project",
        MESHR_REPLAY_SOURCE: "outbox",
        MESHR_REPLAY_ENVIRONMENT: "canary",
        MESHR_FIRESTORE_DATABASE: "meshr-canary",
        MESHR_EVENTS_TOPIC: "mesh-events-canary",
        MESHR_REPLAY_CHECKPOINT: checkpoint,
      }),
      /replay checkpoint environment mismatch/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects cross-project and unsupported DLQ sources", () => {
  assert.throws(
    () => classifyDeadLetterSource(
      {
        CloudPubSubDeadLetterSourceSubscriptionProject: "other-project",
        CloudPubSubDeadLetterSourceSubscription: "topology-materializer",
      },
      production,
      "demo-project",
    ),
    /matching .*Project attribute/,
  );
  assert.throws(
    () => classifyDeadLetterSource(
      {
        CloudPubSubDeadLetterSourceSubscriptionProject: "demo-project",
        CloudPubSubDeadLetterSourceSubscription: "unrelated-subscription",
      },
      production,
      "demo-project",
    ),
    /unsupported source subscription/,
  );
});

test("validates and preserves the moderation screening contract", () => {
  const job = parseModerationScreeningJob({
    schema_version: 1,
    event_id: "event-1234",
    mesh_id: null,
    post_id: "post-1234",
  });
  assert.equal(job.mesh_id, null);
  assert.equal(
    replayPayload({ route: "moderation-screening", eventId: job.event_id, screeningJob: job }),
    JSON.stringify(job),
  );
  assert.throws(
    () => parseModerationScreeningJob({ schema_version: 1, event_id: "event-1234", post_id: "post-1234" }),
    /invalid moderation screening job/,
  );
});
