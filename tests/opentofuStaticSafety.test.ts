import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string): string =>
  readFileSync(new URL(path, root), "utf8");

test("literal GCP service-account IDs satisfy provider constraints", () => {
  const tofu = read("infra/opentofu/main.tf");
  const accountIds = [...tofu.matchAll(/account_id\s*=\s*"([^"]+)"/g)].map(
    ([, accountId]) => accountId!,
  );
  assert.ok(accountIds.length > 0);
  for (const accountId of accountIds) {
    assert.match(accountId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/);
    assert.ok(
      accountId.length >= 6 && accountId.length <= 30,
      `${accountId} must be between 6 and 30 characters`,
    );
  }
});

test("Pub/Sub dead-letter grants use import-stable subscription keys", () => {
  const tofu = read("infra/opentofu/main.tf");

  assert.doesNotMatch(
    tofu,
    /for_each\s*=\s*google_pubsub_subscription\./,
    "resource-derived collections cannot be enumerated during state-free import",
  );

  const subscriptions = new Map([
    ["workers", "name     = each.value"],
    ["canary_workers", 'name     = "${each.value}-canary"'],
  ]);
  for (const [name, expectedName] of subscriptions) {
    const subscription = tofu.match(
      new RegExp(
        `resource "google_pubsub_subscription" "${name}" \\{([\\s\\S]*?)\\n\\}`,
      ),
    )?.[1];
    assert.ok(subscription, `missing Pub/Sub subscription set ${name}`);
    assert.ok(subscription.includes("for_each = local.event_subscriptions"));
    assert.ok(subscription.includes(expectedName));
  }

  const expectedBindings = new Map([
    [
      "dead_letter_service_agent",
      [
        "local.event_subscriptions",
        "google_pubsub_subscription.workers[each.key].name",
      ],
    ],
    [
      "dead_letter_canary_service_agent",
      [
        "local.event_subscriptions",
        "google_pubsub_subscription.canary_workers[each.key].name",
      ],
    ],
  ]);

  for (const [name, [forEach, subscription]] of expectedBindings) {
    const binding = tofu.match(
      new RegExp(
        `resource "google_pubsub_subscription_iam_member" "${name}" \\{([\\s\\S]*?)\\n\\}`,
      ),
    )?.[1];
    assert.ok(binding, `missing Pub/Sub dead-letter binding ${name}`);
    assert.ok(binding.includes(`for_each     = ${forEach}`));
    assert.ok(binding.includes(`subscription = ${subscription}`));
  }
});

test("Artifact Registry tags and CI access are repository-scoped and immutable", () => {
  const tofu = read("infra/opentofu/main.tf");
  const repository = tofu.match(
    /resource "google_artifact_registry_repository" "images" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(repository, "missing Meshr image repository");
  assert.match(repository, /repository_id\s*=\s*local\.name/);
  assert.match(repository, /format\s*=\s*"DOCKER"/);
  assert.match(
    repository,
    /docker_config\s*\{\s*immutable_tags\s*=\s*true\s*\}/,
  );

  const expectedBindings = new Map([
    [
      "ci_artifact_registry",
      [
        "roles/artifactregistry.writer",
        "serviceAccount:${google_service_account.ci.email}",
      ],
    ],
    [
      "production_plan_artifact_reader",
      [
        "roles/artifactregistry.reader",
        "serviceAccount:${var.production_plan_service_account_email}",
      ],
    ],
    [
      "ci_deploy_artifact_reader",
      [
        "roles/artifactregistry.reader",
        "serviceAccount:${google_service_account.ci_deploy.email}",
      ],
    ],
    [
      "ci_canary_deploy_artifact_reader",
      [
        "roles/artifactregistry.reader",
        "serviceAccount:${google_service_account.ci_canary_deploy[0].email}",
      ],
    ],
  ]);
  for (const [name, [role, member]] of expectedBindings) {
    const binding = tofu.match(
      new RegExp(
        `resource "google_artifact_registry_repository_iam_member" "${name}" \\{([\\s\\S]*?)\\n\\}`,
      ),
    )?.[1];
    assert.ok(binding, `missing repository binding ${name}`);
    assert.match(
      binding,
      /location\s*=\s*google_artifact_registry_repository\.images\.location/,
    );
    assert.match(
      binding,
      /repository\s*=\s*google_artifact_registry_repository\.images\.name/,
    );
    assert.ok(binding.includes(`role       = "${role}"`));
    assert.ok(binding.includes(`member     = "${member}"`));
  }

  const projectBindings = [
    ...tofu.matchAll(
      /resource "google_project_iam_member" "[^"]+" \{([\s\S]*?)\n\}/g,
    ),
  ].map((match) => match[1]!);
  assert.equal(
    projectBindings.filter((binding) =>
      /roles\/artifactregistry\.(?:reader|writer)/.test(binding),
    ).length,
    0,
    "Artifact Registry read/write roles must not be project-scoped",
  );
});

test("credential-free plans cannot configure or trust a Cloudflare edge", () => {
  const tofu = read("infra/opentofu/main.tf");
  const outputs = read("infra/opentofu/outputs.tf");
  const versions = read("infra/opentofu/versions.tf");
  const variables = read("infra/opentofu/variables.tf");
  const canaryServiceAccounts = read("deploy/canary/serviceaccounts.yaml");

  assert.match(
    versions,
    /api_token\s*=\s*local\.cloudflare_enabled\s*\?\s*var\.cloudflare_api_token\s*:\s*"0{40}"/,
  );
  assert.match(
    variables,
    /condition\s*=\s*var\.cloudflare_origin_secret\s*==\s*null\s*\?\s*true\s*:/,
  );
  assert.match(canaryServiceAccounts, /meshr-mod-screening-canary@/);
  assert.doesNotMatch(
    canaryServiceAccounts,
    /meshr-moderation-screening-canary@/,
  );

  for (const resource of [
    'google_certificate_manager_dns_authorization" "meshr',
    'google_certificate_manager_dns_authorization" "staging',
    'google_certificate_manager_certificate" "meshr',
    'google_certificate_manager_certificate_map" "meshr',
    'google_certificate_manager_certificate_map_entry" "root',
    'google_certificate_manager_certificate_map_entry" "staging',
    'google_compute_global_address" "gateway',
    'google_compute_global_address" "staging_gateway',
  ]) {
    const body = tofu.match(
      new RegExp(`resource \"${resource}\" \\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    assert.ok(body, `missing ${resource}`);
    assert.match(
      body,
      /count\s*=\s*local\.cloudflare_enabled\s*\?\s*1\s*:\s*0/,
    );
  }
  assert.match(
    outputs,
    /try\(google_certificate_manager_certificate_map\.meshr\[0\]\.name, null\)/,
  );
  assert.match(
    outputs,
    /try\(google_compute_global_address\.gateway\[0\]\.address, null\)/,
  );
  assert.match(
    outputs,
    /try\(google_compute_global_address\.staging_gateway\[0\]\.address, null\)/,
  );
  assert.match(
    tofu,
    /value\s*=\s*google_compute_global_address\.gateway\[0\]\.address/,
  );
  assert.match(
    tofu,
    /value\s*=\s*google_compute_global_address\.staging_gateway\[0\]\.address/,
  );
});

test("private moderation adapter mode is explicit, authenticated, and non-public", () => {
  const tofu = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");

  const mode = variables.match(
    /variable "private_moderation_adapter_mode" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(mode, "missing explicit private moderation adapter mode");
  assert.match(mode, /type\s*=\s*bool/);
  assert.match(mode, /default\s*=\s*false/);

  const edgeToggle = tofu.match(/cloudflare_enabled\s*=\s*([^\n]+)/)?.[1];
  assert.ok(edgeToggle, "missing Cloudflare edge toggle");
  assert.doesNotMatch(edgeToggle, /private_moderation_adapter_mode/);

  const guard = tofu.match(
    /resource "terraform_data" "private_moderation_adapter_guard" \{([\s\S]*?)\n\}\n\nresource "terraform_data" "cloudflare_guard"/,
  )?.[1];
  assert.ok(guard, "missing private moderation adapter guard");
  assert.match(guard, /!var\.launch_mode/);
  assert.match(guard, /!var\.manage_production_dns_records/);
  assert.match(guard, /!var\.manage_staging_dns_records/);
  for (const forbiddenInput of [
    "cloudflare_api_token",
    "cloudflare_origin_secret",
    "google_oauth_client_id",
    "google_oauth_client_secret",
    "github_oauth_client_id",
    "github_oauth_client_secret",
  ]) {
    assert.match(guard, new RegExp(`var\\.${forbiddenInput} == null`));
  }
  assert.match(
    guard,
    /\$\{var\.region\}-docker\.pkg\.dev\/\$\{var\.project_id\}\/\$\{local\.name\}\/moderation-adapter@sha256:/,
  );
  assert.match(guard, /var\.moderation_adapter_canary_image == null/);
});

test("organization policy guardrails default on and no-org mode cannot launch", () => {
  const tofu = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");
  const outputs = read("infra/opentofu/outputs.tf");

  const mode = variables.match(
    /variable "organization_policy_guardrails_enabled" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(mode, "missing Organization Policy guardrail mode");
  assert.match(mode, /type\s*=\s*bool/);
  assert.match(mode, /default\s*=\s*true/);
  assert.match(mode, /non-public qualification/);

  const guard = tofu.match(
    /resource "terraform_data" "organization_policy_guardrails_mode" \{([\s\S]*?)\n\}\n\n# The production adapter/,
  )?.[1];
  assert.ok(guard, "missing Organization Policy mode guard");
  assert.match(guard, /var\.organization_policy_guardrails_enabled\s*\|\|/);
  assert.match(guard, /!var\.launch_mode/);
  assert.match(guard, /!var\.manage_production_dns_records/);
  assert.match(guard, /!var\.manage_staging_dns_records/);

  const organizationPolicyService = tofu.match(
    /resource "google_project_service" "organization_policy" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(organizationPolicyService, "missing Organization Policy service");
  assert.match(
    organizationPolicyService,
    /count\s*=\s*var\.organization_policy_guardrails_enabled\s*\?\s*1\s*:\s*0/,
  );

  const defaultPolicies = tofu.match(
    /resource "google_org_policy_policy" "project_default_guardrails" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(defaultPolicies, "missing project default guardrails");
  assert.match(
    defaultPolicies,
    /for_each\s*=\s*var\.organization_policy_guardrails_enabled\s*\?\s*local\.project_default_guardrails\s*:\s*toset\(\[\]\)/,
  );

  for (const name of [
    "cloud_run_require_invoker_iam",
    "cloud_run_disable_inlined_source",
  ]) {
    const policy = tofu.match(
      new RegExp(
        `resource "google_org_policy_policy" "${name}" \\{([\\s\\S]*?)\\n\\}`,
      ),
    )?.[1];
    assert.ok(policy, `missing conditional ${name} policy`);
    assert.match(
      policy,
      /count\s*=\s*var\.organization_policy_guardrails_enabled\s*\?\s*1\s*:\s*0/,
    );
  }

  assert.match(
    outputs,
    /output "organization_policy_guardrails_enforced" \{[\s\S]*?var\.organization_policy_guardrails_enabled/,
  );
});

test("production deployment identity cannot alias the public build repository", () => {
  const tofu = read("infra/opentofu/main.tf");
  const guard = tofu.match(
    /resource "terraform_data" "production_deploy_repository_separation_guard" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(guard, "missing production repository separation guard");
  assert.match(
    guard,
    /github_production_deploy_identity\.repository\) != trimspace\(local\.github_build_identity\.repository\)/,
  );
  assert.match(
    guard,
    /github_production_deploy_identity\.repository_id\) != trimspace\(local\.github_build_identity\.repository_id\)/,
  );
});

test("moderation screening remains in the selected regional data boundary", () => {
  const tofu = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");
  const dlpLocation = variables.match(
    /variable "moderation_dlp_location" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(dlpLocation, "missing moderation DLP location input");
  assert.match(dlpLocation, /default\s*=\s*"us-central1"/);

  const guard = tofu.match(
    /resource "terraform_data" "moderation_data_residency_guard" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(guard, "missing moderation regional-processing guard");
  assert.match(
    guard,
    /var\.moderation_adapter_image != null \|\| var\.moderation_adapter_canary_image != null/,
  );
  assert.match(
    guard,
    /trimspace\(var\.moderation_dlp_location\) == var\.region/,
  );
  assert.equal(
    [
      ...tofu.matchAll(
        /name\s*=\s*"MESHR_DLP_LOCATION"\s*value\s*=\s*var\.moderation_dlp_location/g,
      ),
    ].length,
    2,
  );
});

test("Model Armor policy is stack-owned, explicit, retained, and privacy preserving", () => {
  const tofu = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");
  const outputs = read("infra/opentofu/outputs.tf");

  const policy = tofu.match(
    /model_armor_policy\s*=\s*\{([\s\S]*?)\n  \}\n  event_subscriptions/,
  )?.[1];
  assert.ok(policy, "missing reviewable Model Armor policy");
  assert.match(policy, /meshr_policy_schema_version\s*=\s*"v1"/);
  assert.doesNotMatch(policy, /detector_model_version|filter_version_selector/);
  assert.doesNotMatch(tofu, /live detector selector\s+and resolved version/);
  assert.doesNotMatch(
    read("infra/opentofu/README.md"),
    /filter selector\/resolved version/,
  );
  assert.match(policy, /enforcement_type\s*=\s*"INSPECT_AND_BLOCK"/);
  assert.match(policy, /ignore_partial_invocation_failures\s*=\s*false/);
  assert.match(policy, /log_template_operations\s*=\s*true/);
  assert.match(policy, /log_sanitize_operations\s*=\s*false/);
  assert.match(policy, /multi_language_detection\s*=\s*true/);
  assert.match(policy, /malicious_uri_filter_enforcement\s*=\s*"ENABLED"/);
  assert.match(
    policy,
    /pi_and_jailbreak_filter\s*=\s*\{[\s\S]*?filter_enforcement\s*=\s*"ENABLED"[\s\S]*?confidence_level\s*=\s*"MEDIUM_AND_ABOVE"/,
  );
  for (const category of [
    "DANGEROUS",
    "HARASSMENT",
    "HATE_SPEECH",
    "SEXUALLY_EXPLICIT",
  ]) {
    assert.match(policy, new RegExp(`${category}\\s*=\\s*"MEDIUM_AND_ABOVE"`));
  }
  assert.match(policy, /sdp_filter_enforcement\s*=\s*"ENABLED"/);

  const template = tofu.match(
    /resource "google_model_armor_template" "moderation" \{([\s\S]*?)\n\}\n\n# Screening/,
  )?.[1];
  assert.ok(template, "missing stack-owned Model Armor template");
  assert.match(template, /project\s*=\s*var\.project_id/);
  assert.match(template, /location\s*=\s*var\.region/);
  assert.match(template, /template_id\s*=\s*"meshr-moderation"/);
  assert.match(
    template,
    /meshr_policy_schema\s*=\s*local\.model_armor_policy\.meshr_policy_schema_version/,
  );
  assert.match(template, /malicious_uri_filter_settings/);
  assert.match(template, /pi_and_jailbreak_filter_settings/);
  assert.match(template, /rai_settings/);
  assert.match(template, /sdp_settings\s*\{\s*basic_config/);
  assert.match(
    template,
    /enforcement_type\s*=\s*local\.model_armor_policy\.enforcement_type/,
  );
  assert.match(
    template,
    /ignore_partial_invocation_failures\s*=\s*local\.model_armor_policy\.ignore_partial_invocation_failures/,
  );
  assert.match(
    template,
    /log_sanitize_operations\s*=\s*local\.model_armor_policy\.log_sanitize_operations/,
  );
  assert.match(
    template,
    /enable_multi_language_detection\s*=\s*local\.model_armor_policy\.multi_language_detection/,
  );
  assert.match(template, /lifecycle\s*\{\s*prevent_destroy\s*=\s*true/);

  assert.equal(
    [
      ...tofu.matchAll(
        /name\s*=\s*"MESHR_MODEL_ARMOR_TEMPLATE"\s*value\s*=\s*google_model_armor_template\.moderation\.name/g,
      ),
    ].length,
    2,
  );
  assert.doesNotMatch(variables, /variable "moderation_model_armor_template"/);
  assert.match(
    outputs,
    /output "moderation_model_armor_template" \{[\s\S]*?google_model_armor_template\.moderation\.name/,
  );
  assert.match(
    outputs,
    /output "moderation_model_armor_policy_sha256" \{[\s\S]*?sha256\(jsonencode\(local\.model_armor_policy\)\)/,
  );
});

test("moderation adapters have an explicit cost bound and no anonymous invoker", () => {
  const tofu = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");
  const outputs = read("infra/opentofu/outputs.tf");
  const production = tofu.match(
    /resource "google_cloud_run_v2_service" "moderation_adapter" \{([\s\S]*?)\n\}\n\nresource "google_cloud_run_v2_service" "moderation_adapter_canary"/,
  )?.[1];
  const canary = tofu.match(
    /resource "google_cloud_run_v2_service" "moderation_adapter_canary" \{([\s\S]*?)\n\}\n\n# GitHub Actions/,
  )?.[1];
  assert.ok(production, "missing production moderation adapter service");
  assert.ok(canary, "missing canary moderation adapter service");

  for (const service of [production, canary]) {
    assert.match(service, /min_instance_count\s*=\s*0/);
    assert.match(service, /max_instance_count\s*=\s*3/);
    assert.match(service, /cpu\s*=\s*"1"/);
    assert.match(service, /memory\s*=\s*"512Mi"/);
    assert.match(service, /invoker_iam_disabled\s*=\s*false/);
  }
  assert.match(production, /ignore_changes\s*=\s*all/);
  assert.match(production, /prevent_destroy\s*=\s*true/);
  assert.match(production, /private_moderation_adapter_mode/);
  assert.match(
    production,
    /revision\s*=\s*local\.moderation_adapter_revision_name/,
  );
  assert.match(
    production,
    /traffic\s*\{[\s\S]*?type\s*=\s*"TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"[\s\S]*?revision\s*=\s*local\.moderation_adapter_revision_name[\s\S]*?percent\s*=\s*100[\s\S]*?tag\s*=\s*local\.moderation_adapter_revision_tag/,
  );
  assert.match(canary, /ignore_changes\s*=\s*all/);
  assert.match(canary, /prevent_destroy\s*=\s*true/);
  assert.match(
    tofu,
    /moderation_adapter_revision_tag\s*=.*substr\(var\.moderation_adapter_source_sha, 0, 20\)/,
  );
  assert.match(
    tofu,
    /moderation_adapter_canary_revision_tag\s*=.*substr\(var\.moderation_adapter_canary_source_sha, 0, 14\)/,
  );
  assert.match(
    canary,
    /revision\s*=\s*local\.moderation_adapter_canary_revision_name/,
  );
  assert.match(
    canary,
    /traffic\s*\{[\s\S]*?revision\s*=\s*local\.moderation_adapter_canary_revision_name[\s\S]*?percent\s*=\s*100[\s\S]*?tag\s*=\s*local\.moderation_adapter_canary_revision_tag/,
  );
  assert.doesNotMatch(tofu, /allUsers|allAuthenticatedUsers/);
  assert.doesNotMatch(tofu, /MESHR_RELEASE_SHA|moderation_adapter_release_sha/);
  assert.doesNotMatch(variables, /moderation_adapter_release_sha/);

  const productionSource = variables.match(
    /variable "moderation_adapter_source_sha" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(productionSource, "missing production image source witness input");
  assert.match(productionSource, /nullable\s*=\s*true/);
  assert.match(productionSource, /default\s*=\s*null/);
  assert.match(productionSource, /\^\[a-f0-9\]\{40\}\$/);

  const canaryReleaseGuard = tofu.match(
    /resource "terraform_data" "moderation_adapter_release_identity_guard" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(canaryReleaseGuard, "missing canary digest/source pair guard");
  assert.match(
    canaryReleaseGuard,
    /\(var\.moderation_adapter_image == null\) ==\s*\(var\.moderation_adapter_source_sha == null\)/,
  );
  assert.match(
    canaryReleaseGuard,
    /\(var\.moderation_adapter_canary_image == null\) ==\s*\(var\.moderation_adapter_canary_source_sha == null\)/,
  );
  assert.match(
    outputs,
    /output "moderation_adapter_initial_revision" \{[\s\S]*?local\.moderation_adapter_revision_name/,
  );
  assert.match(
    outputs,
    /output "moderation_adapter_initial_revision_tag" \{[\s\S]*?local\.moderation_adapter_revision_tag/,
  );

  const invokerPolicy = tofu.match(
    /resource "google_org_policy_policy" "cloud_run_require_invoker_iam" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(invokerPolicy, "missing Cloud Run Invoker IAM policy guard");
  assert.match(
    invokerPolicy,
    /count\s*=\s*var\.organization_policy_guardrails_enabled\s*\?\s*1\s*:\s*0/,
  );
  assert.match(invokerPolicy, /policies\/run\.managed\.requireInvokerIam/);
  assert.match(invokerPolicy, /enforce\s*=\s*"TRUE"/);
  assert.match(invokerPolicy, /prevent_destroy\s*=\s*true/);

  const inlineSourcePolicy = tofu.match(
    /resource "google_org_policy_policy" "cloud_run_disable_inlined_source" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(inlineSourcePolicy, "missing Cloud Run inline-source policy guard");
  assert.match(
    inlineSourcePolicy,
    /count\s*=\s*var\.organization_policy_guardrails_enabled\s*\?\s*1\s*:\s*0/,
  );
  assert.match(
    inlineSourcePolicy,
    /policies\/run\.managed\.disableInlinedSource/,
  );
  assert.match(inlineSourcePolicy, /enforce\s*=\s*"TRUE"/);
  assert.match(inlineSourcePolicy, /prevent_destroy\s*=\s*true/);
});

test("production moderation promotion authority is external and exactly scoped", () => {
  const tofu = read("infra/opentofu/main.tf");
  const variables = read("infra/opentofu/variables.tf");
  const outputs = read("infra/opentofu/outputs.tf");

  const promotionVariable = variables.match(
    /variable "production_moderation_promotion_service_account_email" \{([\s\S]*?)\n\}\n\nvariable/,
  )?.[1];
  assert.ok(promotionVariable, "missing exact private promotion GSA input");
  assert.match(promotionVariable, /type\s*=\s*string/);
  assert.match(promotionVariable, /nullable\s*=\s*false/);
  assert.doesNotMatch(promotionVariable, /\bdefault\s*=/);
  assert.match(
    promotionVariable,
    /production_moderation_promotion_service_account_email == trimspace\(var\.production_moderation_promotion_service_account_email\)/,
  );
  assert.ok(promotionVariable.includes("\\\\.iam\\\\.gserviceaccount\\\\.com"));

  const guard = tofu.match(
    /resource "terraform_data" "production_moderation_promotion_identity_guard" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(guard, "missing promotion/qualifier/runtime separation guard");
  assert.match(
    guard,
    /"meshr-ci-promote@\$\{var\.project_id\}\.iam\.gserviceaccount\.com"/,
  );
  assert.match(guard, /google_service_account\.ci_deploy\.email/);
  assert.match(guard, /google_service_account\.moderation_adapter\.email/);

  const customRole = tofu.match(
    /resource "google_project_iam_custom_role" "production_moderation_promotion_service" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(customRole, "missing minimal production service-update role");
  const permissionList = customRole.match(
    /permissions\s*=\s*\[([\s\S]*?)\]/,
  )?.[1];
  assert.ok(permissionList, "missing custom-role permission list");
  assert.deepEqual(
    [...permissionList.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ["run.services.get", "run.services.update"],
  );
  for (const forbidden of [
    "create",
    "delete",
    "setIamPolicy",
    "ssh",
    "instances",
    "jobs",
    "executions",
    "operations",
    "revisions",
  ]) {
    assert.doesNotMatch(permissionList, new RegExp(forbidden, "i"));
  }

  const updater = tofu.match(
    /resource "google_cloud_run_v2_service_iam_member" "production_moderation_promotion_service_updater" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(updater, "missing service-scoped production update grant");
  assert.match(
    updater,
    /name\s*=\s*google_cloud_run_v2_service\.moderation_adapter\[0\]\.name/,
  );
  assert.match(
    updater,
    /role\s*=\s*google_project_iam_custom_role\.production_moderation_promotion_service\.name/,
  );
  assert.doesNotMatch(updater, /roles\/run\.developer/);
  assert.match(
    updater,
    /member\s*=\s*"serviceAccount:\$\{var\.production_moderation_promotion_service_account_email\}"/,
  );

  const actAs = tofu.match(
    /resource "google_service_account_iam_member" "production_moderation_promotion_act_as" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(actAs, "missing runtime-identity act-as grant");
  assert.match(
    actAs,
    /service_account_id\s*=\s*google_service_account\.moderation_adapter\.name/,
  );
  assert.match(actAs, /role\s*=\s*"roles\/iam\.serviceAccountUser"/);
  assert.match(
    actAs,
    /member\s*=\s*"serviceAccount:\$\{var\.production_moderation_promotion_service_account_email\}"/,
  );

  const artifactReader = tofu.match(
    /resource "google_artifact_registry_repository_iam_member" "production_moderation_promotion_artifact_reader" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(artifactReader, "missing repository-scoped image-read grant");
  assert.match(
    artifactReader,
    /count\s*=\s*var\.moderation_adapter_image == null \? 0 : 1/,
  );
  assert.match(
    artifactReader,
    /repository\s*=\s*google_artifact_registry_repository\.images\.name/,
  );
  assert.match(artifactReader, /role\s*=\s*"roles\/artifactregistry\.reader"/);
  assert.match(
    artifactReader,
    /member\s*=\s*"serviceAccount:\$\{var\.production_moderation_promotion_service_account_email\}"/,
  );

  const projectBindings = [
    ...tofu.matchAll(
      /resource "google_project_iam_member" "[^"]+" \{([\s\S]*?)\n\}/g,
    ),
  ].map((match) => match[1]!);
  assert.equal(
    projectBindings.filter((body) =>
      body.includes("production_moderation_promotion_service_account_email"),
    ).length,
    0,
    "promotion GSA must not receive a project-scoped role",
  );
  assert.equal(
    [
      ...tofu.matchAll(
        /member\s*=\s*"serviceAccount:\$\{var\.production_moderation_promotion_service_account_email\}"/g,
      ),
    ].length,
    3,
    "promotion GSA must receive only service update, repository read, and runtime act-as bindings",
  );

  assert.match(
    outputs,
    /output "moderation_adapter_service_name" \{[\s\S]*?google_cloud_run_v2_service\.moderation_adapter\[0\]\.name/,
  );
  assert.match(
    outputs,
    /output "moderation_adapter_service_account" \{[\s\S]*?google_service_account\.moderation_adapter\.email/,
  );
  assert.match(
    outputs,
    /output "production_moderation_promotion_service_account" \{[\s\S]*?var\.production_moderation_promotion_service_account_email/,
  );
  assert.match(
    outputs,
    /output "production_moderation_promotion_service_role" \{[\s\S]*?google_project_iam_custom_role\.production_moderation_promotion_service\.name/,
  );

  const runbook = read("infra/opentofu/README.md");
  assert.match(runbook, /allowMissing=false/);
  assert.match(runbook, /current etag|just-read service etag/);
  assert.match(runbook, /re-authenticate as the qualifier/);
  assert.match(runbook, /org\.opencontainers\.image\.revision/);
  assert.match(runbook, /MESHR_MODERATION_RELEASE_SHA=/);
});

test("canary Cloud Run promotion uses exact methods and separate readback", () => {
  const tofu = read("infra/opentofu/main.tf");
  const iamMatrix = read("docs/IAM_MATRIX.md");

  const customRole = tofu.match(
    /resource "google_project_iam_custom_role" "canary_moderation_promotion_service" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(customRole, "missing minimal canary service-update role");
  const permissions = customRole.match(/permissions\s*=\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(permissions, "missing canary custom-role permissions");
  assert.deepEqual(
    [...permissions.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    ["run.services.get", "run.services.update"],
  );

  const updater = tofu.match(
    /resource "google_cloud_run_v2_service_iam_member" "ci_canary_deploy_moderation_adapter_updater" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(updater, "missing service-scoped canary updater");
  assert.match(
    updater,
    /name\s*=\s*google_cloud_run_v2_service\.moderation_adapter_canary\[0\]\.name/,
  );
  assert.match(
    updater,
    /role\s*=\s*google_project_iam_custom_role\.canary_moderation_promotion_service\[0\]\.name/,
  );
  assert.doesNotMatch(tofu, /roles\/run\.developer/);

  const actAs = tofu.match(
    /resource "google_service_account_iam_member" "ci_canary_deploy_moderation_adapter_act_as" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(actAs, "missing exact canary runtime actAs grant");
  assert.match(
    actAs,
    /service_account_id\s*=\s*google_service_account\.moderation_adapter_canary\.name/,
  );
  assert.match(actAs, /role\s*=\s*"roles\/iam\.serviceAccountUser"/);
  assert.doesNotMatch(
    tofu,
    /resource "google_project_iam_member" "ci_canary_deploy_cloud_run_viewer"/,
  );
  assert.match(iamMatrix, /limits resource and method, not PATCH fields/);
  assert.match(iamMatrix, /separately federated read-only qualifier/);
});

test("public build receipt is exact-SHA-bound and carries no deploy authority", () => {
  const ci = read(".github/workflows/ci.yml");
  const runbook = read("infra/opentofu/README.md");

  assert.equal(
    [
      ...ci.matchAll(
        /--certificate-github-workflow-sha='\$\{\{ github\.sha \}\}'/g,
      ),
    ].length,
    1,
  );
  assert.equal(
    [...ci.matchAll(/--certificate-github-workflow-trigger='push'/g)].length,
    1,
  );
  assert.match(
    ci,
    /--certificate-identity='https:\/\/github\.com\/tflynn3\/meshr\/\.github\/workflows\/ci\.yml@refs\/heads\/main'/,
  );
  assert.match(ci, /bash scripts\/verify-moderation-adapter-image\.sh/);
  assert.match(
    ci,
    /"moderationAdapter\|moderation-adapter\|deploy\/images\/moderation-adapter\.Dockerfile\|\$MODERATION_ADAPTER_DIGEST"/,
  );
  assert.match(
    ci,
    /imageEvidence:\$evidence\[0\][\s\S]*moderationAdapter:\s*\$evidence\[0\]\.moderationAdapter/,
  );
  assert.match(
    ci,
    /\.moderationAdapter == \.build\.imageEvidence\.moderationAdapter/,
  );
  assert.match(ci, /\.schemaVersion == 1 and \.source\.sha == \$sha/);
  assert.match(ci, /\.moderationAdapter\.sourceSha == \$sha/);
  assert.match(
    ci,
    /if: vars\.MESHR_MANAGED_BUILD_ENABLED == 'true' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.doesNotMatch(ci, /github\.run_attempt\s*==\s*1/);
  assert.match(
    ci,
    /printf '%s' "\$GITHUB_RUN_ATTEMPT" \| grep -Eq '\^\[1-9\]\[0-9\]\*\$'/,
  );
  assert.match(
    ci,
    /jq -e --arg sha "\$GITHUB_SHA" --arg runAttempt "\$GITHUB_RUN_ATTEMPT"[\s\S]*\.build\.runAttempt == \$runAttempt/,
  );
  assert.doesNotMatch(
    ci,
    /GCP_(?:CANARY|PRODUCTION)_DEPLOY|MESHR_CANARY_URL|release-transaction\.sh/,
  );
  assert.doesNotMatch(
    ci,
    /gcloud\s+run\s+(?:deploy|services\s+(?:update|replace))|kubectl\s+(?:apply|create|delete|patch|replace|rollout|set)\b/,
  );
  assert.match(runbook, /--certificate-github-workflow-sha="\$MAIN_SHA"/);
  assert.match(runbook, /--certificate-github-workflow-trigger='push'/);
});

test("CI validates the production provider lock with the planning Terraform version", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(
    ci,
    /hashicorp\/setup-terraform@[a-f0-9]{40}[\s\S]*?terraform_version: 1\.16\.0[\s\S]*?terraform_wrapper: false/,
  );
  assert.match(
    ci,
    /terraform -chdir=infra\/opentofu init -backend=false -input=false -lockfile=readonly/,
  );
});

test("public build fails closed unless the exact release tag set is empty", () => {
  const ci = read(".github/workflows/ci.yml");
  const preflight = ci.match(
    /- name: Require an immutable empty release tag set([\s\S]*?)(?=\n      - name: Login to Artifact Registry for API build)/,
  )?.[1];
  assert.ok(preflight, "missing immutable release tag preflight");
  assert.match(preflight, /Authorization: Bearer \$GCP_ACCESS_TOKEN/);
  assert.match(
    preflight,
    /artifactregistry\.googleapis\.com\/v1\/projects\/\$GCP_PROJECT_ID\/locations\/us-central1\/repositories\/meshr/,
  );
  assert.match(preflight, /\.format == "DOCKER"/);
  assert.match(preflight, /\.dockerConfig\.immutableTags == true/);
  assert.match(
    preflight,
    /for image in api event-plane moderation-adapter web/,
  );
  assert.match(
    preflight,
    /case "\$manifest_status" in[\s\S]*404\) ;;[\s\S]*200\)[\s\S]*exit 1[\s\S]*\*\)[\s\S]*exit 1/,
  );
  assert.ok(
    ci.indexOf("Require an immutable empty release tag set") <
      ci.indexOf("Build and push API image"),
    "release tag preflight must run before any build or push",
  );
});

test("public build installs exact checksummed cloud and signing tools before auth", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.doesNotMatch(ci, /google-github-actions\/setup-gcloud/);
  assert.doesNotMatch(ci, /sigstore\/cosign-installer/);
  assert.match(ci, /GCLOUD_VERSION: 582\.0\.0/);
  assert.match(
    ci,
    /GCLOUD_SHA256: e917ca3a21bc9d5ae13759d11a581a6a948a5170f257f2640a25e7c44cf6a8a5/,
  );
  assert.match(
    ci,
    /storage\.googleapis\.com\/cloud-sdk-release\/google-cloud-cli-\$GCLOUD_VERSION-linux-x86_64\.tar\.gz/,
  );
  assert.match(ci, /COSIGN_VERSION: v3\.1\.3/);
  assert.match(
    ci,
    /COSIGN_SHA256: 4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71/,
  );
  assert.match(
    ci,
    /github\.com\/sigstore\/cosign\/releases\/download\/\$COSIGN_VERSION\/cosign-linux-amd64/,
  );
  assert.equal([...ci.matchAll(/sha256sum --check --strict -/g)].length, 2);
  const firstAuth = ci.indexOf(
    "Refresh GCP credentials before API image build",
  );
  assert.ok(firstAuth > 0, "missing first GCP authentication step");
  assert.ok(
    ci.indexOf("Install the exact checksummed gcloud CLI") < firstAuth &&
      ci.indexOf("Install the exact checksummed Cosign CLI") < firstAuth,
    "downloaded build tools must be verified before cloud authentication",
  );
});
