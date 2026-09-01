import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  collectFirestoreReadinessSnapshot,
  compareFirestoreReadiness,
  extractFirestoreReadinessManifest,
  type FirestoreReadinessManifest,
  type FirestoreReadinessSnapshot,
} from "../scripts/check-firestore-readiness.ts";

const root = new URL("../", import.meta.url);
const source = readFileSync(new URL("infra/opentofu/main.tf", root), "utf8");
const project = "meshr-readiness-test";
const locationId = "us-central1";

const resourceName = (
  database: string,
  collectionGroup: string,
  suffix: string,
): string =>
  `projects/${project}/databases/${database}/collectionGroups/${collectionGroup}/${suffix}`;

const readySnapshot = (
  manifest: FirestoreReadinessManifest,
): FirestoreReadinessSnapshot => ({
  databases: Object.fromEntries(
    manifest.databases.map((expectedDatabase) => [
      expectedDatabase.name,
      {
        database: {
          name: `projects/${project}/databases/${expectedDatabase.name}`,
          locationId: expectedDatabase.locationId,
          type: expectedDatabase.type,
          pointInTimeRecoveryEnablement:
            expectedDatabase.pointInTimeRecoveryEnablement,
          deleteProtectionState: expectedDatabase.deleteProtectionState,
        },
        backupSchedules: manifest.backupSchedules
          .filter((schedule) => schedule.database === expectedDatabase.name)
          .map((schedule, position) => ({
            name: `projects/${project}/databases/${expectedDatabase.name}/backupSchedules/schedule-${position}`,
            retention: schedule.retention,
            dailyRecurrence: {},
          })),
        indexes: manifest.indexes
          .filter((index) => index.database === expectedDatabase.name)
          .map((index, position) => ({
            name: resourceName(
              expectedDatabase.name,
              index.collectionGroup,
              `indexes/index-${position}`,
            ),
            queryScope: index.queryScope,
            state: "READY",
            fields: index.fields,
          })),
        ttls: manifest.ttls
          .filter((ttl) => ttl.database === expectedDatabase.name)
          .map((ttl) => ({
            name: resourceName(
              expectedDatabase.name,
              ttl.collectionGroup,
              `fields/${ttl.fieldPath}`,
            ),
            ttlConfig: { state: "ACTIVE" },
          })),
      },
    ]),
  ),
});

test("readiness manifest covers every OpenTofu Firestore database, index, and TTL", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  assert.equal(manifest.databases.length, 12);
  assert.equal(manifest.backupSchedules.length, 6);
  assert.equal(manifest.indexes.length, 78);
  assert.equal(manifest.ttls.length, 62);
  assert.ok(
    manifest.databases.every((database) => database.locationId === locationId),
  );
  assert.ok(
    manifest.databases.every(
      (database) =>
        database.deleteProtectionState === "DELETE_PROTECTION_ENABLED",
    ),
  );
  assert.equal(
    manifest.databases.filter(
      (database) =>
        database.pointInTimeRecoveryEnablement ===
        "POINT_IN_TIME_RECOVERY_ENABLED",
    ).length,
    8,
  );
  assert.ok(
    manifest.backupSchedules.every(
      (schedule) =>
        schedule.recurrence === "DAILY" && schedule.retention === "3024000s",
    ),
  );
  assert.deepEqual(
    manifest.indexes
      .filter((index) => index.database === "meshr-canary-moderation")
      .map((index) => index.collectionGroup),
    ["moderation_inbox"],
  );
  assert.deepEqual(
    manifest.ttls
      .filter((ttl) => ttl.database === "meshr-canary-moderation")
      .map((ttl) => `${ttl.collectionGroup}.${ttl.fieldPath}`)
      .sort(),
    [
      "moderation_dlq.retention_at",
      "moderation_inbox.retention_at",
      "processed_events.retention_at",
    ],
  );
  assert.ok(
    manifest.indexes.every(
      (index) => index.fields.at(-1)?.fieldPath === "__name__",
    ),
    "the managed API materializes __name__ as the final composite-index field",
  );
});

test("production qualifier has only Firestore control-plane read permissions", () => {
  const role = source.match(
    /resource "google_project_iam_custom_role" "ci_deploy_firestore_readiness" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(role, "Firestore readiness custom role must exist");
  assert.deepEqual(
    [...role.matchAll(/"(datastore\.[^"]+)"/g)].map((match) => match[1]),
    [
      "datastore.backupSchedules.list",
      "datastore.databases.getMetadata",
      "datastore.indexes.get",
      "datastore.indexes.list",
    ],
  );
  assert.doesNotMatch(role, /datastore\.entities|\.create|\.delete|\.update/);
  assert.match(
    source,
    /resource "google_project_iam_member" "ci_deploy_firestore_readiness"[\s\S]*?role\s+= google_project_iam_custom_role\.ci_deploy_firestore_readiness\.name[\s\S]*?member\s+= "serviceAccount:\$\{google_service_account\.ci_deploy\.email\}"/,
  );
});

test("exact managed Firestore inventory passes only when every resource is ready", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const result = compareFirestoreReadiness(
    manifest,
    readySnapshot(manifest),
    project,
  );
  assert.deepEqual(result, {
    databaseCount: 12,
    protectedDatabaseCount: 12,
    pitrEnabledDatabaseCount: 8,
    readyBackupScheduleCount: 6,
    readyIndexCount: 78,
    activeTtlCount: 62,
    issues: [],
  });
});

test("managed Firestore inventory rejects a database in the wrong location", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const snapshot = readySnapshot(manifest);
  const settings = snapshot.databases["(default)"]!.database as Record<
    string,
    unknown
  >;
  settings.locationId = "us-east1";

  assert.match(
    compareFirestoreReadiness(manifest, snapshot, project).issues.join("\n"),
    /database \(default\) is in us-east1, not us-central1/,
  );
});

test("managed Firestore inventory rejects PITR drift", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const snapshot = readySnapshot(manifest);
  const settings = snapshot.databases["(default)"]!.database as Record<
    string,
    unknown
  >;
  settings.pointInTimeRecoveryEnablement = "POINT_IN_TIME_RECOVERY_DISABLED";

  assert.match(
    compareFirestoreReadiness(manifest, snapshot, project).issues.join("\n"),
    /database \(default\) PITR is POINT_IN_TIME_RECOVERY_DISABLED, not POINT_IN_TIME_RECOVERY_ENABLED/,
  );
});

test("managed Firestore inventory rejects delete-protection drift", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const snapshot = readySnapshot(manifest);
  const settings = snapshot.databases["(default)"]!.database as Record<
    string,
    unknown
  >;
  settings.deleteProtectionState = "DELETE_PROTECTION_DISABLED";

  assert.match(
    compareFirestoreReadiness(manifest, snapshot, project).issues.join("\n"),
    /database \(default\) delete protection is DELETE_PROTECTION_DISABLED, not DELETE_PROTECTION_ENABLED/,
  );
});

test("managed Firestore inventory rejects missing or drifted backup schedules", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const missingSnapshot = readySnapshot(manifest);
  missingSnapshot.databases["(default)"]!.backupSchedules = [];
  assert.match(
    compareFirestoreReadiness(manifest, missingSnapshot, project).issues.join(
      "\n",
    ),
    /missing daily backup schedule for \(default\) with retention 3024000s/,
  );

  const driftedSnapshot = readySnapshot(manifest);
  const schedules = driftedSnapshot.databases["(default)"]!
    .backupSchedules as Array<Record<string, unknown>>;
  schedules[0]!.retention = "604800s";
  const issues = compareFirestoreReadiness(
    manifest,
    driftedSnapshot,
    project,
  ).issues.join("\n");
  assert.match(
    issues,
    /missing daily backup schedule for \(default\) with retention 3024000s/,
  );
  assert.match(
    issues,
    /unexpected daily backup schedule for \(default\) with retention 604800s/,
  );
});

test("managed Firestore inventory fails closed on absent and ambiguous settings", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const absentSnapshot = readySnapshot(manifest);
  const absentSettings = absentSnapshot.databases["(default)"]!
    .database as Record<string, unknown>;
  delete absentSettings.locationId;
  assert.match(
    compareFirestoreReadiness(manifest, absentSnapshot, project).issues.join(
      "\n",
    ),
    /incomplete database settings for \(default\)/,
  );

  const ambiguousSnapshot = readySnapshot(manifest);
  const ambiguousSettings = ambiguousSnapshot.databases["(default)"]!
    .database as Record<string, unknown>;
  ambiguousSettings.location_id = "us-east1";
  assert.match(
    compareFirestoreReadiness(manifest, ambiguousSnapshot, project).issues.join(
      "\n",
    ),
    /ambiguous locationId values/,
  );
});

test("managed Firestore inventory fails closed on missing snapshots and empty manifests", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const snapshot = readySnapshot(manifest);
  delete snapshot.databases["meshr-audit"];
  const result = compareFirestoreReadiness(manifest, snapshot, project);
  assert.match(
    result.issues.join("\n"),
    /missing gcloud snapshot for database meshr-audit/,
  );

  assert.throws(
    () =>
      compareFirestoreReadiness(
        { databases: [], backupSchedules: [], indexes: [], ttls: [] },
        { databases: {} },
        project,
      ),
    /must contain databases, backup schedules, indexes, and TTLs/,
  );
});

test("managed Firestore inventory ignores unrelated pre-existing databases", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const snapshot = readySnapshot(manifest);
  snapshot.databases["unrelated-existing-db"] = {
    database: { malformed: true },
    backupSchedules: "not-managed",
    indexes: "not-managed",
    ttls: "not-managed",
  };

  assert.deepEqual(
    compareFirestoreReadiness(manifest, snapshot, project).issues,
    [],
  );
});

test("managed Firestore inventory reports missing, unready, inactive, and extra resources", () => {
  const manifest = extractFirestoreReadinessManifest(source, locationId);
  const snapshot = readySnapshot(manifest);
  const defaultSnapshot = snapshot.databases["(default)"]!;
  const indexes = defaultSnapshot.indexes as Array<Record<string, unknown>>;
  const ttls = defaultSnapshot.ttls as Array<Record<string, unknown>>;
  indexes.shift();
  indexes[0] = { ...indexes[0], state: "CREATING" };
  indexes.push({
    name: resourceName("(default)", "unexpected", "indexes/extra"),
    queryScope: "COLLECTION",
    state: "READY",
    fields: [
      { fieldPath: "first", order: "ASCENDING" },
      { fieldPath: "__name__", order: "ASCENDING" },
    ],
  });
  ttls[0] = {
    ...ttls[0],
    ttlConfig: { state: "CREATING" },
  };

  const issues = compareFirestoreReadiness(
    manifest,
    snapshot,
    project,
  ).issues.join("\n");
  assert.match(issues, /missing composite index/);
  assert.match(issues, /is CREATING, not READY/);
  assert.match(issues, /unexpected composite index/);
  assert.match(issues, /TTL policy .* is CREATING, not ACTIVE/);
});

test("gcloud collection requests every declared database using safe JSON projections", () => {
  const manifest: FirestoreReadinessManifest = {
    databases: ["(default)", "meshr-audit"].map((name) => ({
      resource: name === "(default)" ? "default" : "audit",
      name,
      locationId,
      type: "FIRESTORE_NATIVE" as const,
      pointInTimeRecoveryEnablement: "POINT_IN_TIME_RECOVERY_ENABLED" as const,
      deleteProtectionState: "DELETE_PROTECTION_ENABLED" as const,
    })),
    backupSchedules: [
      {
        resource: "daily",
        database: "(default)",
        retention: "3024000s",
        recurrence: "DAILY",
      },
    ],
    indexes: [
      {
        resource: "example",
        database: "(default)",
        collectionGroup: "examples",
        queryScope: "COLLECTION",
        fields: [
          { fieldPath: "created_at", order: "ASCENDING" },
          { fieldPath: "__name__", order: "ASCENDING" },
        ],
      },
    ],
    ttls: [
      {
        resource: "example",
        database: "meshr-audit",
        collectionGroup: "events",
        fieldPath: "retention_at",
      },
    ],
  };
  const calls: string[][] = [];
  const snapshot = collectFirestoreReadinessSnapshot(
    manifest,
    project,
    (args) => {
      calls.push(args);
      return "[]";
    },
  );
  assert.deepEqual(Object.keys(snapshot.databases), [
    "(default)",
    "meshr-audit",
  ]);
  assert.equal(calls.length, 8);
  assert.ok(calls.every((call) => call.includes(`--project=${project}`)));
  assert.ok(calls.some((call) => call.includes("--database=(default)")));
  assert.ok(calls.some((call) => call.includes("--database=meshr-audit")));
  assert.ok(
    calls.some((call) =>
      call.includes("--format=json(name,queryScope,state,fields)"),
    ),
  );
  assert.ok(
    calls.some((call) => call.includes("--format=json(name,ttlConfig.state)")),
  );
  assert.ok(
    calls.some((call) =>
      call.includes(
        "--format=json(name,locationId,type,pointInTimeRecoveryEnablement,deleteProtectionState)",
      ),
    ),
  );
  assert.ok(
    calls.some((call) =>
      call.includes(
        "--format=json(name,retention,dailyRecurrence,weeklyRecurrence)",
      ),
    ),
  );
});
