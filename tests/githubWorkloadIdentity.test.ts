import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string): string =>
  readFileSync(new URL(path, root), "utf8");
const variableBlock = (source: string, name: string): string => {
  const start = source.indexOf(`variable "${name}"`);
  assert.notEqual(start, -1, `missing Terraform variable ${name}`);
  const next = source.indexOf('\nvariable "', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
};

test("production Workload Identity separates build, canary, and private qualification identities", () => {
  const terraform = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");

  assert.match(variables, /variable "github_repository_id"/);
  assert.match(variables, /variable "github_repository_owner_id"/);
  assert.match(
    variables,
    /github_repository_id must contain only decimal digits/,
  );
  assert.match(
    variables,
    /github_repository_owner_id must contain only decimal digits/,
  );
  assert.doesNotMatch(
    variableBlock(variables, "github_repository_id"),
    /\bdefault\s*=/,
  );
  assert.doesNotMatch(
    variableBlock(variables, "github_repository_owner_id"),
    /\bdefault\s*=/,
  );
  const canaryIdentity = variableBlock(variables, "github_deploy_identity");
  const productionIdentity = variableBlock(
    variables,
    "github_production_deploy_identity",
  );
  assert.match(canaryIdentity, /default\s*=\s*null/);
  assert.match(canaryIdentity, /nullable\s*=\s*true/);
  assert.match(canaryIdentity, /var\.github_deploy_identity == null \? true/);
  assert.doesNotMatch(canaryIdentity, /workflow_path\s*=\s*optional/);
  assert.ok(canaryIdentity.includes('can(regex("^\\\\.github/workflows/'));
  assert.match(canaryIdentity, /!strcontains\([^,]+, "\.\."\)/);
  assert.doesNotMatch(productionIdentity, /\bdefault\s*=/);
  assert.match(productionIdentity, /nullable\s*=\s*false/);
  assert.match(
    productionIdentity,
    /\^\[A-Za-z0-9_\.\-\]\+\/\[A-Za-z0-9_\.\-\]\+\$/,
  );
  assert.ok(productionIdentity.includes('can(regex("^\\\\.github/workflows/'));
  assert.match(productionIdentity, /!strcontains\([^,]+, "\.\."\)/);
  assert.doesNotMatch(
    productionIdentity,
    /repository_(?:owner_)?id\s*=\s*"[0-9]+"/,
  );
  assert.doesNotMatch(
    productionIdentity,
    /tflynn3|meshr-ops|qualify-production/,
  );
  assert.match(
    terraform,
    /github_canary_deploy_identity\s*=\s*var\.github_deploy_identity/,
  );
  assert.match(
    terraform,
    /github_production_deploy_identity\s*=\s*var\.github_production_deploy_identity/,
  );

  assert.match(
    terraform,
    /"attribute\.build_repository_id"\s*=\s*"assertion\.repository_id"/,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_id == '\$\{local\.github_build_identity\.repository_id\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_visibility == 'public'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [...terraform.matchAll(/assertion\.event_name == 'push'/g)].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_owner_id == '\$\{local\.github_build_identity\.repository_owner_id\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_id == '\$\{try\(local\.github_canary_deploy_identity\.repository_id, ""\)\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_owner_id == '\$\{try\(local\.github_canary_deploy_identity\.repository_owner_id, ""\)\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_id == '\$\{local\.github_production_deploy_identity\.repository_id\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.repository_owner_id == '\$\{local\.github_production_deploy_identity\.repository_owner_id\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [...terraform.matchAll(/assertion\.repository_visibility == 'private'/g)]
      .length,
    2,
  );
  assert.equal(
    [...terraform.matchAll(/assertion\.event_name == 'workflow_dispatch'/g)]
      .length,
    2,
  );
  const canaryProvider = terraform.match(
    /resource "google_iam_workload_identity_pool_provider" "github_actions_canary_deploy" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(canaryProvider, "missing private canary WIF provider");
  assert.match(canaryProvider, /assertion\.repository_visibility == 'private'/);
  assert.match(canaryProvider, /assertion\.environment == 'canary'/);
  assert.match(canaryProvider, /assertion\.ref == 'refs\/heads\/main'/);
  assert.match(canaryProvider, /assertion\.event_name == 'workflow_dispatch'/);
  assert.match(
    canaryProvider,
    /assertion\.workflow_ref == '\$\{local\.github_canary_deploy_workflow_ref\}'/,
  );
  assert.match(canaryProvider, /count\s*=\s*local\.canary_promotion_enabled \? 1 : 0/);
  assert.match(
    terraform,
    /assertion\.workflow_ref == '\$\{local\.github_build_workflow_ref\}'/,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.workflow_ref == '\$\{local\.github_canary_deploy_workflow_ref\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /assertion\.workflow_ref == '\$\{local\.github_production_deploy_workflow_ref\}'/g,
      ),
    ].length,
    1,
  );

  assert.match(
    terraform,
    /attribute\.build_repository_id\/\$\{local\.github_build_identity\.repository_id\}/,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /attribute\.release\/\$\{try\(local\.github_canary_deploy_identity\.repository_id, ""\)\}:canary/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /attribute\.release\/\$\{local\.github_production_deploy_identity\.repository_id\}:production/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /"attribute\.release"\s*=\s*"assertion\.repository_id \+ ':' \+ assertion\.environment"/g,
      ),
    ].length,
    2,
  );

  assert.doesNotMatch(terraform, /assertion\.repository ==/);
  assert.doesNotMatch(terraform, /"attribute\.repository"\s*=/);
  assert.doesNotMatch(terraform, /"attribute\.repository_id"\s*=/);

  const canarySeparationGuard = terraform.match(
    /resource "terraform_data" "canary_deploy_repository_separation_guard" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(canarySeparationGuard, "missing private canary repository guard");
  assert.match(
    canarySeparationGuard,
    /count\s*=\s*local\.canary_promotion_enabled \? 1 : 0/,
  );
  assert.match(
    canarySeparationGuard,
    /condition\s*=\s*var\.github_deploy_identity != null/,
  );
  assert.match(
    canarySeparationGuard,
    /github_canary_deploy_identity\.repository\), ""\) != trimspace\(local\.github_build_identity\.repository\)/,
  );
  assert.match(
    canarySeparationGuard,
    /github_canary_deploy_identity\.repository_id\), ""\) != trimspace\(local\.github_build_identity\.repository_id\)/,
  );

  for (const resourceName of [
    "github_actions_canary_deploy",
    "ci_canary_deploy",
    "ci_canary_deploy_workload_identity",
    "ci_canary_deploy_audit_writer",
    "ci_canary_deploy_cluster_viewer",
    "ci_canary_deploy_artifact_reader",
    "canary_moderation_promotion_service",
  ]) {
    const resource = terraform.match(
      new RegExp(`resource "[^"]+" "${resourceName}" \\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    assert.ok(resource, `missing conditional canary resource ${resourceName}`);
    assert.match(
      resource,
      /count\s*=\s*local\.canary_promotion_enabled \? 1 : 0/,
    );
  }
});

test("production plan and moderation promotion federation remain private-owned", () => {
  const terraform = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");
  const planIdentity = variableBlock(
    variables,
    "production_plan_service_account_email",
  );
  const promotionIdentity = variableBlock(
    variables,
    "production_moderation_promotion_service_account_email",
  );

  assert.doesNotMatch(planIdentity, /\bdefault\s*=/);
  assert.match(planIdentity, /nullable\s*=\s*false/);
  assert.doesNotMatch(promotionIdentity, /\bdefault\s*=/);
  assert.match(promotionIdentity, /nullable\s*=\s*false/);
  assert.doesNotMatch(
    terraform,
    /resource "google_service_account" "[^"]*promotion[^"]*"/,
  );
  assert.doesNotMatch(
    terraform,
    /resource "google_iam_workload_identity_pool_provider" "[^"]*promotion[^"]*"/,
  );
  assert.doesNotMatch(
    terraform,
    /resource "google_service_account" "[^"]*plan[^"]*"/,
  );
  assert.doesNotMatch(
    terraform,
    /resource "google_iam_workload_identity_pool_provider" "[^"]*plan[^"]*"/,
  );
  assert.equal(
    [
      ...terraform.matchAll(
        /resource "google_iam_workload_identity_pool_provider"/g,
      ),
    ].length,
    3,
    "public stack must not add a production-promotion WIF provider",
  );
  assert.doesNotMatch(
    terraform,
    /roles\/iam\.workloadIdentityUser[\s\S]{0,500}production_moderation_promotion_service_account_email/,
  );
  assert.doesNotMatch(
    terraform,
    /roles\/iam\.workloadIdentityUser[\s\S]{0,500}production_plan_service_account_email/,
  );

  const planGuard = terraform.match(
    /resource "terraform_data" "production_plan_identity_guard" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(planGuard, "missing exact production plan identity guard");
  assert.match(
    planGuard,
    /production_plan_service_account_email == "meshr-prod-plan@\$\{var\.project_id\}\.iam\.gserviceaccount\.com"/,
  );
  assert.match(planGuard, /google_service_account\.ci_deploy\.email/);
  assert.match(
    planGuard,
    /production_moderation_promotion_service_account_email/,
  );
  assert.match(planGuard, /google_service_account\.moderation_adapter\.email/);
});
