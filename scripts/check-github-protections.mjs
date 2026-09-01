#!/usr/bin/env node

/**
 * Read-only release preflight for the GitHub controls that make production
 * promotion an explicit protected action. It intentionally exits non-zero
 * until the repository has been bootstrapped; it never mutates GitHub state.
 *
 * Run with a user/admin-authenticated `gh` session:
 *   npm run check:github-protections
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repository = process.env.MESHR_GITHUB_REPOSITORY || process.env.GITHUB_REPOSITORY;
const branch = process.env.MESHR_GITHUB_BRANCH || "main";
// The workflow preflight can verify repository metadata before it mints any
// release credentials. Deployment jobs run the full check with the configured
// App IDs/slugs and protected environment inputs.
const metadataOnly = process.env.MESHR_GITHUB_PREFLIGHT_METADATA_ONLY === "1";

// Build credentials are intentionally repository-scoped because the build job
// does not select an environment. Deployment credentials and runtime values
// must stay environment-scoped so canary and production cannot accidentally
// consume one another's authority.
const requiredRepositorySecrets = [
  "GCP_BUILD_WORKLOAD_IDENTITY_PROVIDER",
  "MESHR_PREFLIGHT_APP_PRIVATE_KEY",
];
const requiredRepositoryVariables = [
  "GCP_PROJECT_ID",
  "GCP_BUILD_SERVICE_ACCOUNT",
  "MESHR_PREFLIGHT_APP_ID",
  "MESHR_PREFLIGHT_APP_CLIENT_ID",
  "MESHR_PREFLIGHT_APP_SLUG",
];
const requiredEnvironmentInputs = {
  canary: {
    secrets: [
      "GCP_CANARY_DEPLOY_WORKLOAD_IDENTITY_PROVIDER",
      "MESHR_CANARY_RELEASE_APP_PRIVATE_KEY",
    ],
    variables: [
      "GCP_CANARY_DEPLOY_SERVICE_ACCOUNT",
      "GKE_CLUSTER",
      "GKE_LOCATION",
      "MESHR_CANARY_URL",
      "MESHR_MODERATION_AUDIENCE",
      "MESHR_COST_PROTECTION_MODE",
      "MESHR_CANARY_RELEASE_APP_ID",
      "MESHR_CANARY_RELEASE_APP_CLIENT_ID",
      "MESHR_CANARY_RELEASE_APP_SLUG",
    ],
  },
  production: {
    secrets: [
      "GCP_DEPLOY_WORKLOAD_IDENTITY_PROVIDER",
      "MESHR_PRODUCTION_RELEASE_APP_PRIVATE_KEY",
    ],
    variables: [
      "GCP_DEPLOY_SERVICE_ACCOUNT",
      "GKE_CLUSTER",
      "GKE_LOCATION",
      "MESHR_PRODUCTION_URL",
      "MESHR_MODERATION_AUDIENCE",
      "MESHR_COST_PROTECTION_MODE",
      "MESHR_PRODUCTION_RELEASE_APP_ID",
      "MESHR_PRODUCTION_RELEASE_APP_CLIENT_ID",
      "MESHR_PRODUCTION_RELEASE_APP_SLUG",
    ],
  },
};

const releaseAppInputs = {
  canary: {
    id: "MESHR_CANARY_RELEASE_APP_ID",
    slug: "MESHR_CANARY_RELEASE_APP_SLUG",
  },
  production: {
    id: "MESHR_PRODUCTION_RELEASE_APP_ID",
    slug: "MESHR_PRODUCTION_RELEASE_APP_SLUG",
  },
};

function fail(message) {
  throw new Error(message);
}

function readBypassActors(ruleset, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(ruleset, "bypass_actors")) {
    if (options.allowUnreadable) return { actors: [], readable: false };
    fail(options.errorMessage || "GitHub ruleset bypass actors are not readable.");
  }
  return {
    actors: Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [],
    readable: true,
  };
}

/** Match GitHub's ref-name glob syntax for the small set used by release rules. */
function matchesRefPattern(value, target, kind) {
  if (typeof value !== "string") return false;
  const prefix = `refs/${kind}/`;
  const pattern = value.replace(new RegExp(`^${prefix}`), "");
  if (pattern === "~ALL") return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(target);
}

/** A ruleset can include a ref and then exclude it; exclusion wins. */
function appliesToRef(ruleset, target, kind) {
  const conditions = ruleset?.conditions?.ref_name;
  const includes = Array.isArray(conditions?.include) ? conditions.include : [];
  const excludes = Array.isArray(conditions?.exclude) ? conditions.exclude : [];
  return includes.some((value) => matchesRefPattern(value, target, kind)) &&
    !excludes.some((value) => matchesRefPattern(value, target, kind));
}

/**
 * Release tags are a namespace, not a single sample ref. Require the exact
 * `v*` include so a narrowly-scoped ruleset cannot make one test tag look
 * protected while another release tag remains mutable. Exclusions are not
 * allowed for the release namespace.
 */
function isNamespaceWideReleaseTagRule(ruleset) {
  const conditions = ruleset?.conditions?.ref_name;
  const includes = Array.isArray(conditions?.include) ? conditions.include : [];
  const excludes = Array.isArray(conditions?.exclude) ? conditions.exclude : [];
  const hasNamespaceInclude = includes.some((value) =>
    typeof value === "string" && value.replace(/^refs\/tags\//, "") === "v*",
  );
  return hasNamespaceInclude && excludes.length === 0;
}

function ghApi(path) {
  try {
    const output = execFileSync("gh", ["api", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim() || "request failed";
    return { __error: `${path}: ${stderr}` };
  }
}

function names(path, key) {
  const payload = ghApi(path);
  if (payload.__error) fail(payload.__error);
  return new Set(
    Array.isArray(payload[key])
      ? payload[key].map((item) => item?.name).filter((name) => typeof name === "string")
      : [],
  );
}

function assertEnvironment(repo, name, requireReviewers, options = {}) {
  const environment = ghApi(`repos/${repo}/environments/${encodeURIComponent(name)}`);
  if (environment.__error) fail(`GitHub environment ${name} is missing or unreadable: ${environment.__error}`);
  const rules = Array.isArray(environment.protection_rules) ? environment.protection_rules : [];
  if (requireReviewers && !rules.some((rule) => rule?.type === "required_reviewers")) {
    fail(`GitHub environment ${name} must require at least one reviewer before promotion.`);
  }
  const deploymentPolicy = environment.deployment_branch_policy;
  const protectedBranches = deploymentPolicy?.protected_branches === true;
  const customBranchPolicies = deploymentPolicy?.custom_branch_policies === true;
  if (!deploymentPolicy || (!protectedBranches && !customBranchPolicies)) {
    fail(`GitHub environment ${name} must restrict deployments to protected or explicitly selected refs.`);
  }
  let branchPolicies = [];
  if (options.requireReleaseRefs) {
    if (!customBranchPolicies || protectedBranches) {
      fail(`GitHub environment ${name} must use custom deployment branch/tag policies for main and v* refs.`);
    }
    const payload = ghApi(
      `repos/${repo}/environments/${encodeURIComponent(name)}/deployment-branch-policies?per_page=100`,
    );
    if (payload.__error) fail(`GitHub environment ${name} deployment policies are missing or unreadable: ${payload.__error}`);
    branchPolicies = Array.isArray(payload) ? payload : payload?.branch_policies;
    if (!Array.isArray(branchPolicies)) {
      fail(`GitHub environment ${name} returned an invalid deployment policy list.`);
    }
    const hasMain = branchPolicies.some((policy) =>
      String(policy?.type ?? "").toLowerCase() === "branch" && String(policy?.name ?? "") === "main",
    );
    const hasReleaseTags = branchPolicies.some((policy) =>
      String(policy?.type ?? "").toLowerCase() === "tag" && String(policy?.name ?? "") === "v*",
    );
    if (!hasMain || !hasReleaseTags) {
      fail(`GitHub environment ${name} must allow only the protected main branch and v* release tags (add both custom policies).`);
    }
    const broadPolicies = branchPolicies.filter((policy) =>
      ["*", "**", "~ALL"].includes(String(policy?.name ?? "")),
    );
    if (broadPolicies.length) {
      fail(`GitHub environment ${name} must not include a catch-all deployment policy.`);
    }
  }
  return {
    name,
    requiredReviewers: rules.some((rule) => rule?.type === "required_reviewers"),
    protectedBranches,
    customBranchPolicies,
    ...(options.requireReleaseRefs ? { branchPolicies } : {}),
  };
}

function assertBranchProtection(repo, targetBranch, { requireVerify }) {
  const protection = ghApi(
    `repos/${repo}/branches/${encodeURIComponent(targetBranch)}/protection`,
  );
  if (protection.__error) {
    fail(`Branch ${targetBranch} is not protected or is unreadable: ${protection.__error}`);
  }
  const reviews = protection.required_pull_request_reviews;
  if (!reviews || Number(reviews.required_approving_review_count ?? 0) < 1) {
    fail(`Branch ${targetBranch} must require at least one approving pull-request review.`);
  }
  if (protection.enforce_admins?.enabled !== true) {
    fail(`Branch ${targetBranch} must enforce protection for administrators.`);
  }
  if (protection.allow_force_pushes?.enabled === true) {
    fail(`Branch ${targetBranch} must reject force-pushes.`);
  }
  if (protection.allow_deletions?.enabled === true) {
    fail(`Branch ${targetBranch} must reject deletion.`);
  }
  const contexts = protection.required_status_checks?.contexts ?? [];
  if (requireVerify &&
      (!Array.isArray(contexts) || !contexts.some((context) => /(?:^|\/)verify$/i.test(context)))) {
    fail(`Branch ${targetBranch} must require the Meshr CI verify status check.`);
  }
  return {
    branch: targetBranch,
    approvingReviews: reviews.required_approving_review_count,
    statusChecks: Array.isArray(contexts) ? contexts : [],
    forcePushes: protection.allow_force_pushes?.enabled === true,
    deletions: protection.allow_deletions?.enabled === true,
  };
}

function assertReleaseRuleset(repo, targetBranch, expectedAppId, options = {}) {
  const summaries = ghApi(`repos/${repo}/rulesets?includes_parents=true&per_page=100`);
  if (summaries.__error) fail(`Cannot inspect GitHub rulesets: ${summaries.__error}`);
  if (!Array.isArray(summaries)) fail(`GitHub returned an invalid ruleset list for ${repo}.`);
  const candidates = summaries.filter((summary) =>
    summary?.enforcement === "active" && summary?.target === "branch",
  );
  const matching = [];
  for (const summary of candidates) {
    if (!Number.isInteger(Number(summary.id))) continue;
    const detail = ghApi(`repos/${repo}/rulesets/${summary.id}`);
    if (detail.__error) fail(`Cannot inspect GitHub ruleset ${summary.id}: ${detail.__error}`);
    if (appliesToRef(detail, targetBranch, "heads")) matching.push(detail);
  }
  let expected = expectedAppId == null ? null : Number(expectedAppId);
  if (expectedAppId != null && (!Number.isInteger(expected) || expected <= 0)) {
    fail(`${targetBranch} release App ID must be a positive integer (set ${releaseAppInputs[targetBranch].id} when running this check).`);
  }
  const exact = matching.filter((ruleset) => {
    const includes = ruleset?.conditions?.ref_name?.include ?? [];
    const excludes = ruleset?.conditions?.ref_name?.exclude ?? [];
    return includes.some((value) => value === targetBranch || value === `refs/heads/${targetBranch}`) &&
      !excludes.some((value) => matchesRefPattern(value, targetBranch, "heads"));
  });
  if (exact.length !== 1) {
    fail(`Branch ${targetBranch} must have exactly one active branch ruleset scoped to refs/heads/${targetBranch}; found ${exact.length}.`);
  }
  let bypassActorsReadable = true;
  for (const candidate of matching) {
    const rules = Array.isArray(candidate.rules) ? candidate.rules : [];
    if (!rules.some((rule) => rule?.type === "pull_request")) {
      fail(`Every active ruleset applying to ${targetBranch} must require pull requests.`);
    }
    if (!rules.some((rule) => rule?.type === "deletion")) {
      fail(`Every active ruleset applying to ${targetBranch} must reject branch deletion.`);
    }
    if (!rules.some((rule) => rule?.type === "non_fast_forward")) {
      fail(`Every active ruleset applying to ${targetBranch} must reject force-pushes.`);
    }
    // The release App is part of the promotion trust boundary. Full/admin
    // checks fail closed when bypass actors are hidden. The automated
    // read-only metadata check records that limitation explicitly and leaves
    // bypass verification to the documented administrator bootstrap check.
    const bypass = readBypassActors(candidate, {
      allowUnreadable: options.allowUnreadableBypassActors,
      errorMessage: `Every ruleset applying to ${targetBranch} must expose bypass actors to the release preflight identity.`,
    });
    if (!bypass.readable) {
      bypassActorsReadable = false;
      continue;
    }
    const bypassActors = bypass.actors;
    const integrationActors = bypassActors.filter((actor) =>
      (actor?.actor_type === "Integration" || Number(actor?.actor_type) === 1) &&
      actor?.bypass_mode === "always",
    );
    if (expected == null) {
      if (integrationActors.length !== 1 || !Number.isInteger(Number(integrationActors[0]?.actor_id))) {
        fail(`Every active ruleset applying to ${targetBranch} must have exactly one always-bypass release App integration.`);
      }
      expected = Number(integrationActors[0].actor_id);
    }
    const expectedActors = integrationActors.filter((actor) => Number(actor?.actor_id) === expected);
    if (expectedActors.length !== 1) {
      fail(`Every active ruleset applying to ${targetBranch} must grant direct bypass exactly once to integration App ${expected}.`);
    }
    const unexpectedActors = bypassActors.filter((actor) =>
      !(Number(actor?.actor_id) === expected &&
        (actor?.actor_type === "Integration" || Number(actor?.actor_type) === 1) &&
        actor?.bypass_mode === "always"),
    );
    if (unexpectedActors.length) {
      fail(`Every ruleset applying to ${targetBranch} must have the release App as its sole bypass actor.`);
    }
  }
  return {
    branch: targetBranch,
    rulesetIds: matching.map((candidate) => candidate.id),
    bypassAppId: bypassActorsReadable ? expected : null,
    bypassMode: "always",
    bypassActorsReadable,
  };
}

function assertDistinctReleaseApps() {
  const canaryId = Number(process.env[releaseAppInputs.canary.id]);
  const productionId = Number(process.env[releaseAppInputs.production.id]);
  assertDistinctReleaseAppIds(canaryId, productionId);
  for (const target of Object.keys(releaseAppInputs)) {
    const slug = process.env[releaseAppInputs[target].slug];
    if (!slug || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
      fail(`Set ${releaseAppInputs[target].slug} to the immutable GitHub App slug used for ${target} promotion.`);
    }
  }
  return { canaryId, productionId };
}

function assertDistinctReleaseAppIds(canaryId, productionId) {
  if (!Number.isInteger(canaryId) || !Number.isInteger(productionId) || canaryId <= 0 || productionId <= 0) {
    fail("Canary and production release App IDs must both be positive integers.");
  }
  if (canaryId === productionId) {
    fail("Canary and production release Apps must be distinct integrations.");
  }
  return { canaryId, productionId };
}

function assertReleaseTagRuleset(repo, options = {}) {
  const summaries = ghApi(`repos/${repo}/rulesets?includes_parents=true&per_page=100`);
  if (summaries.__error) fail(`Cannot inspect GitHub tag rulesets: ${summaries.__error}`);
  if (!Array.isArray(summaries)) fail(`GitHub returned an invalid ruleset list for ${repo}.`);
  const matching = [];
  let bypassActorsReadable = true;
  for (const summary of summaries) {
    if (summary?.enforcement !== "active" || summary?.target !== "tag" || !Number.isInteger(Number(summary.id))) continue;
    const detail = ghApi(`repos/${repo}/rulesets/${summary.id}`);
    if (detail.__error) fail(`Cannot inspect GitHub tag ruleset ${summary.id}: ${detail.__error}`);
    const coversReleaseTags = isNamespaceWideReleaseTagRule(detail);
    if (!coversReleaseTags) continue;
    const rules = Array.isArray(detail.rules) ? detail.rules : [];
    const hasNoDeletion = rules.some((rule) => rule?.type === "deletion");
    const hasNoRewrite = rules.some((rule) => rule?.type === "non_fast_forward");
    if (!hasNoDeletion || !hasNoRewrite) {
      fail("The v* tag ruleset must reject deletion and non-fast-forward updates.");
    }
    const bypass = readBypassActors(detail, {
      allowUnreadable: options.allowUnreadableBypassActors,
      errorMessage: "The immutable v* tag ruleset must expose bypass actors to the release preflight identity.",
    });
    if (!bypass.readable) {
      bypassActorsReadable = false;
      const includes = detail?.conditions?.ref_name?.include ?? [];
      matching.push({ rulesetId: detail.id, pattern: includes });
      continue;
    }
    const bypassActors = bypass.actors;
    if (bypassActors.length) {
      fail("The immutable v* tag ruleset must not grant bypass actors.");
    }
    const includes = detail?.conditions?.ref_name?.include ?? [];
    matching.push({ rulesetId: detail.id, pattern: includes });
  }
  if (matching.length !== 1) {
    fail(`Exactly one active tag ruleset must protect immutable v* release tags; found ${matching.length}.`);
  }
  return { ...matching[0], bypassActorsReadable };
}

function main() {
  if (!repository) fail("Set MESHR_GITHUB_REPOSITORY or run inside a GitHub checkout.");

  // The release refs are part of the trust boundary. The workflow may update
  // them through an explicitly bypass-enabled release identity, but ordinary
  // pushes, force-pushes, and deletion must remain blocked.
  // Keep classic branch protection on the source branch so CI cannot mint
  // artifacts from an unreviewed commit. Release refs use repository rulesets
  // instead: unlike classic protection, rulesets can name GitHub App
  // integrations as direct-push bypass actors on a personal repository.
  const branchProtection = [assertBranchProtection(repository, branch, { requireVerify: true })];
  const canary = assertEnvironment(repository, "canary", false);
  const production = assertEnvironment(repository, "production", true);
  const npm = assertEnvironment(repository, "npm", true, { requireReleaseRefs: true });
  if (!canary.protectedBranches) {
    fail("The canary environment must restrict deployments to protected branches.");
  }
  if (!production.protectedBranches) {
    fail("The production environment must restrict deployments to protected branches.");
  }

  const releaseApps = metadataOnly ? null : assertDistinctReleaseApps();
  const releaseRulesets = [
    assertReleaseRuleset(repository, "canary", releaseApps?.canaryId, {
      allowUnreadableBypassActors: metadataOnly,
    }),
    assertReleaseRuleset(repository, "production", releaseApps?.productionId, {
      allowUnreadableBypassActors: metadataOnly,
    }),
  ];
  if (metadataOnly && releaseRulesets.every((ruleset) => ruleset.bypassActorsReadable)) {
    // Metadata mode still proves the canary and production release Apps are
    // distinct. It only skips checking protected secret/variable names.
    assertDistinctReleaseAppIds(
      Number(releaseRulesets[0]?.bypassAppId),
      Number(releaseRulesets[1]?.bypassAppId),
    );
  }
  const releaseTagRuleset = assertReleaseTagRuleset(repository, {
    allowUnreadableBypassActors: metadataOnly,
  });

  // The automated metadata preflight runs with a dedicated read-only GitHub
  // App. Environment-scoped credential names are checked by the protected
  // deployment jobs themselves; keeping those checks out of this job avoids
  // granting a repository token access to secret values before promotion.
  if (metadataOnly) {
    console.log(JSON.stringify({
      repository,
      branchProtection,
      environments: [canary, production, npm],
      releaseRulesets,
      releaseTagRuleset,
      requiresAdminBypassVerification: [
        ...releaseRulesets,
        releaseTagRuleset,
      ].some((ruleset) => !ruleset.bypassActorsReadable),
      metadataOnly: true,
    }, null, 2));
    return;
  }

  const repositorySecrets = names(`repos/${repository}/actions/secrets?per_page=100`, "secrets");
  const repositoryVariables = names(`repos/${repository}/actions/variables?per_page=100`, "variables");
  const missingSecrets = requiredRepositorySecrets.filter((name) => !repositorySecrets.has(name));
  const missingVariables = requiredRepositoryVariables.filter((name) => !repositoryVariables.has(name));
  const missingEnvironmentInputs = [];
  for (const [environment, requirements] of Object.entries(requiredEnvironmentInputs)) {
    const scopedSecrets = names(
      `repos/${repository}/environments/${encodeURIComponent(environment)}/secrets?per_page=100`,
      "secrets",
    );
    const scopedVariables = names(
      `repos/${repository}/environments/${encodeURIComponent(environment)}/variables?per_page=100`,
      "variables",
    );
    const missingScopedSecrets = requirements.secrets.filter((name) => !scopedSecrets.has(name));
    const missingScopedVariables = requirements.variables.filter((name) => !scopedVariables.has(name));
    if (missingScopedSecrets.length) {
      missingEnvironmentInputs.push(`${environment} secrets: ${missingScopedSecrets.join(", ")}`);
    }
    if (missingScopedVariables.length) {
      missingEnvironmentInputs.push(`${environment} variables: ${missingScopedVariables.join(", ")}`);
    }
  }
  if (missingSecrets.length || missingVariables.length || missingEnvironmentInputs.length) {
    const missing = [
      ...(missingSecrets.length ? [`repository secrets: ${missingSecrets.join(", ")}`] : []),
      ...(missingVariables.length ? [`repository variables: ${missingVariables.join(", ")}`] : []),
      ...missingEnvironmentInputs,
    ];
    fail(`Missing protected GitHub Actions inputs (${missing.join("; ")}).`);
  }

  console.log(JSON.stringify({
    repository,
    branchProtection,
    environments: [canary, production, npm],
    releaseRulesets,
    releaseTagRuleset,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`[meshr] GitHub release preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export {
  appliesToRef,
  assertDistinctReleaseAppIds,
  isNamespaceWideReleaseTagRule,
  matchesRefPattern,
  readBypassActors,
};
