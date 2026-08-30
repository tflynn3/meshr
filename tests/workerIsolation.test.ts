import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
const deployment = (source: string, name: string): string => source
  .split("\n---")
  .find((document) => document.includes("kind: Deployment") && document.includes(`\n  name: ${name}\n`)) ?? "";

test("OpenTofu keeps delivery workers out of the authority Firestore grant", () => {
  const tofu = read("infra/opentofu/main.tf");
  const ingest = read("platform/ingest.ts");
  const authorityGrant = tofu.match(
    /resource "google_project_iam_member" "worker_firestore" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(authorityGrant, "authority worker grant must remain explicit");
  assert.match(authorityGrant, /key != "audit_worker"/);
  assert.match(authorityGrant, /key != "notification_worker"/);

  assert.match(tofu, /resource "google_project_iam_member" "audit_worker_firestore"/);
  assert.match(tofu, /resource "google_project_iam_member" "notification_worker_firestore"/);
  assert.match(tofu, /resource "google_project_iam_member" "canary_audit_worker_firestore"/);
  assert.match(tofu, /resource "google_project_iam_member" "canary_notification_worker_firestore"/);
  assert.match(tofu, /name\s+=\s+"meshr-audit"/);
  assert.match(tofu, /name\s+=\s+"meshr-notifications"/);
  assert.match(tofu, /name\s+=\s+"meshr-canary-audit"/);
  assert.match(tofu, /name\s+=\s+"meshr-canary-notifications"/);
  assert.match(tofu, /database\s+=\s+google_firestore_database\.audit\.name/);
  assert.match(tofu, /database\s+=\s+google_firestore_database\.notifications\.name/);
  assert.doesNotMatch(tofu, /resource "google_project_iam_member" "ingest_firestore"/);
  assert.doesNotMatch(tofu, /resource "google_project_iam_member" "ingest_canary_firestore"/);
  assert.match(tofu, /resource "google_secret_manager_secret_iam_member" "api_internal_token"/);
  assert.match(tofu, /resource "google_secret_manager_secret_iam_member" "api_canary_internal_token"/);
  assert.doesNotMatch(ingest, /createFirestore/);
  assert.match(ingest, /internal\/v1\/outbox\/claim/);
  assert.match(ingest, /internal\/v1\/outbox\/complete/);
});

test("production manifests make dedicated worker databases explicit", () => {
  const production = read("deploy/production/workloads.yaml");
  const canary = read("deploy/canary/event-plane.yaml");
  const productionNetworkPolicy = read("deploy/production/networkpolicy.yaml");
  const canaryNetworkPolicy = read("deploy/canary/networkpolicy.yaml");
  const productionConfig = read("deploy/production/config.yaml");
  const canaryConfig = read("deploy/canary/config.yaml");
  const productionValues = read("deploy/production/flux/runtime-values.example.yaml");
  const canaryValues = read("deploy/production/flux/canary-runtime-values.example.yaml");

  for (const source of [production, canary, productionConfig, canaryConfig]) {
    assert.match(source, /MESHR_EVENT_AUDIT_FIRESTORE_DATABASE/);
    assert.match(source, /MESHR_NOTIFICATIONS_FIRESTORE_DATABASE/);
  }
  assert.match(productionValues, /MESHR_EVENT_AUDIT_FIRESTORE_DATABASE:\s+meshr-audit/);
  assert.match(productionValues, /MESHR_NOTIFICATIONS_FIRESTORE_DATABASE:\s+meshr-notifications/);
  assert.match(canaryValues, /MESHR_EVENT_AUDIT_FIRESTORE_DATABASE:\s+meshr-canary-audit/);
  assert.match(canaryValues, /MESHR_NOTIFICATIONS_FIRESTORE_DATABASE:\s+meshr-canary-notifications/);
});

test("screening workers use the token-authenticated moderation authority route", () => {
  const materializer = read("platform/materializer.ts");
  const production = read("deploy/production/workloads.yaml");
  const canary = read("deploy/canary/event-plane.yaml");
  const canaryWorkloads = read("deploy/canary/workloads.yaml");
  const productionNetworkPolicy = read("deploy/production/networkpolicy.yaml");
  const canaryNetworkPolicy = read("deploy/canary/networkpolicy.yaml");
  const tofu = read("infra/opentofu/main.tf");
  const productionConfig = read("deploy/production/config.yaml");
  const canaryConfig = read("deploy/canary/config.yaml");

  assert.match(materializer, /MESHR_MODERATION_AUTHORITY_URL/);
  assert.match(materializer, /internal\/v1\/moderation\/candidate/);
  assert.match(materializer, /internal\/v1\/moderation\/decision/);
  assert.match(materializer, /moderationAuthorityApiEnabled/);
  for (const source of [production, canary]) {
    assert.match(source, /MESHR_MODERATION_AUTHORITY_URL/);
    assert.match(source, /MESHR_MODERATION_AUTHORITY_TOKEN_FILE/);
    assert.match(source, /secretProviderClass: meshr-moderation-authority-secrets/);
  }
  assert.match(production, /serviceAccountName: meshr-moderation-screening-worker/);
  assert.match(canary, /serviceAccountName: meshr-moderation-screening-worker-canary/);
  assert.match(productionNetworkPolicy, /app\.kubernetes\.io\/name: moderation-screening-worker/);
  assert.match(canaryNetworkPolicy, /app\.kubernetes\.io\/name: moderation-screening-worker-canary/);
  assert.match(materializer, /MESHR_MODERATION_AUTHORITY_TOKEN/);
  assert.match(materializer, /checkModerationAuthorityReadiness/);
  assert.match(tofu, /google_firestore_database\.moderation\.name/);
  assert.match(tofu, /google_firestore_database\.canary_moderation\.name/);
  assert.match(tofu, /moderation_screening_worker_firestore/);
  assert.match(tofu, /moderation_screening_authority_token/);
  assert.match(tofu, /key != "moderation_screening_worker"/);
  assert.match(productionConfig, /MESHR_MODERATION_AUTHORITY_URL: http:\/\/api\.meshr\.svc\.cluster\.local:8787/);
  assert.match(canaryConfig, /MESHR_MODERATION_AUTHORITY_URL: http:\/\/api-canary\.meshr-canary\.svc\.cluster\.local:8787/);
  assert.match(productionConfig, /MESHR_MODERATION_FIRESTORE_DATABASE/);
  assert.match(canaryConfig, /MESHR_MODERATION_FIRESTORE_DATABASE/);

  const productionApi = deployment(production, "api");
  const productionIngest = deployment(production, "ingest");
  const productionLive = deployment(production, "live-gateway");
  const productionIntake = deployment(production, "moderation-worker");
  const productionScreening = deployment(production, "moderation-screening-worker");
  const canaryApi = deployment(canaryWorkloads, "api-canary");
  const canaryLive = deployment(canaryWorkloads, "live-gateway-canary");
  const canaryIntake = deployment(canary, "moderation-worker-canary");
  const canaryScreening = deployment(canary, "moderation-screening-worker-canary");
  for (const source of [productionApi, productionScreening, canaryApi, canaryScreening]) {
    assert.ok(source, "the API and screening deployments must be present");
    assert.match(source, /MESHR_MODERATION_AUTHORITY_TOKEN_FILE/);
  }
  for (const source of [productionApi, canaryApi]) assert.match(source, /MESHR_INTERNAL_TOKEN_FILE/);
  for (const source of [productionScreening, canaryScreening]) assert.doesNotMatch(source, /MESHR_INTERNAL_TOKEN_FILE/);
  for (const source of [productionLive, canaryLive, productionIntake, canaryIntake]) {
    assert.ok(source, "the live and intake deployments must be present");
    assert.doesNotMatch(source, /MESHR_MODERATION_AUTHORITY_TOKEN_FILE/);
  }
  assert.match(productionIngest, /MESHR_INTERNAL_TOKEN_FILE/);
  assert.doesNotMatch(productionIngest, /MESHR_FIRESTORE_DATABASE/);
  assert.doesNotMatch(productionIngest, /MESHR_TOPOLOGY_FIRESTORE_DATABASE/);
  assert.doesNotMatch(productionLive, /meshr-event-secrets/);
  assert.doesNotMatch(canaryLive, /meshr-event-secrets-canary/);
});

test("outbox failure telemetry matches the ingest publisher contract", () => {
  const ingest = read("platform/ingest.ts");
  const tofu = read("infra/opentofu/main.tf");
  const metric = tofu.match(
    /resource "google_logging_metric" "outbox_failure_count" \{([\s\S]*?)\n\}/,
  )?.[1];

  assert.ok(metric, "the outbox failure metric must remain explicit");
  assert.match(ingest, /event: "outbox_batch_completed"/);
  assert.match(ingest, /event: "outbox_sweep_failed"/);
  assert.match(ingest, /function reportSweepFailure\(/);
  assert.match(ingest, /function startSweep\(/);
  assert.doesNotMatch(ingest, /sweep\(\)\.catch\(\(\) => undefined\)/);
  assert.match(metric, /jsonPayload\.event=\\"outbox_batch_completed\\"/);
  assert.match(metric, /jsonPayload\.failed>0/);
  assert.match(metric, /jsonPayload\.event=\\"outbox_sweep_failed\\"/);
  assert.doesNotMatch(metric, /outbox_batch_publish_failed|outbox_async_publish_failed/);
});
