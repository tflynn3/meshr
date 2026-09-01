import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseAllDocuments, parse as parseYaml, stringify } from "yaml";

const root = new URL("../", import.meta.url);
const read = (path: string): string =>
  readFileSync(new URL(path, root), "utf8");

const tofu = read("infra/opentofu/main.tf");
const variables = read("infra/opentofu/variables.tf");
const outputs = read("infra/opentofu/outputs.tf");
const rbac = read("deploy/production-qualification/connect-gateway-rbac.yaml");
const flux = read("deploy/production-qualification/flux.yaml");
const fluxBootstrap = read(
  "deploy/production-qualification/flux-bootstrap.yaml",
);
const admissionContract = read(
  "deploy/production-qualification/admission-contract.json",
);
const fluxContract = read(
  "deploy/production-qualification/verify-flux-contract.sh",
);
const gkeAutopilotContract = read(
  "deploy/production-qualification/gke-autopilot-contract.jq",
);
const releaseTransaction = read(
  "deploy/production-qualification/release-transaction.sh",
);
const fluxControllerRbac = read(
  "deploy/production-qualification/flux-controller-rbac.yaml",
);
const fluxRenderer = read("scripts/render-minimal-flux.mjs");
const qualificationReadme = read("deploy/production-qualification/README.md");
const qualificationKustomization = read(
  "deploy/production-qualification/kustomization.yaml",
);
const imageInputs = read("deploy/production/flux/image-digests.example.yaml");
const runtimeInputs = read(
  "deploy/production/flux/runtime-values.example.yaml",
);
const metricsAdapter = read("deploy/metrics-adapter/adapter.yaml");

test("production GKE registers a same-project fleet membership with Connect APIs", () => {
  for (const service of [
    "connectgateway.googleapis.com",
    "gkeconnect.googleapis.com",
    "gkehub.googleapis.com",
  ]) {
    assert.match(tofu, new RegExp(`"${service.replaceAll(".", "\\.")}"`));
  }

  const cluster = tofu.match(
    /resource "google_container_cluster" "autopilot" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(cluster, "missing production Autopilot cluster");
  assert.match(cluster, /fleet\s*\{\s*project\s*=\s*var\.project_id\s*\}/);
  assert.match(outputs, /output "fleet_membership"/);
  assert.match(outputs, /\.fleet\[0\]\.membership_id/);
  assert.match(outputs, /\.fleet\[0\]\.membership_location/);
});

test("operator docs pin the exact global or regional Connect Gateway server", () => {
  assert.match(
    qualificationReadme,
    /PROJECT_NUMBER="\$\(gcloud projects describe "\$PROJECT_ID"/,
  );
  assert.match(
    qualificationReadme,
    /\/v1\/projects\/\$\{PROJECT_NUMBER\}\/locations\/\$\{MEMBERSHIP_LOCATION\}\/gkeMemberships\/\$\{MEMBERSHIP_ID\}/,
  );
  assert.match(
    qualificationReadme,
    /https:\/\/connectgateway\.googleapis\.com\$\{GATEWAY_PATH\}/,
  );
  assert.match(
    qualificationReadme,
    /https:\/\/\$\{MEMBERSHIP_LOCATION\}-connectgateway\.googleapis\.com\$\{GATEWAY_PATH\}/,
  );
});

test("Connect Gateway transport is granted only to the exact production deploy GSA", () => {
  const variable = variables.match(
    /variable "connect_gateway_deploy_service_account_email" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(variable, "missing explicit Connect Gateway identity variable");
  assert.doesNotMatch(variable, /default\s*=/);
  assert.match(variable, /gserviceaccount/);

  const binding = tofu.match(
    /resource "google_project_iam_member" "ci_deploy_connect_gateway" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(binding, "missing Connect Gateway IAM binding");
  assert.match(binding, /"roles\/gkehub\.gatewayAdmin"/);
  assert.match(binding, /"roles\/gkehub\.viewer"/);
  assert.match(
    binding,
    /member\s*=\s*"serviceAccount:\$\{var\.connect_gateway_deploy_service_account_email\}"/,
  );
  assert.match(
    binding,
    /connect_gateway_deploy_service_account_email\s*==\s*google_service_account\.ci_deploy\.email/,
  );
  assert.doesNotMatch(binding, /roles\/(?:owner|editor|container\.admin)/);

  const computeViewer = tofu.match(
    /resource "google_project_iam_member" "ci_deploy_compute_viewer" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(computeViewer, "missing read-only production edge inventory grant");
  assert.match(computeViewer, /role\s*=\s*"roles\/compute\.viewer"/);
  assert.match(
    computeViewer,
    /member\s*=\s*"serviceAccount:\$\{google_service_account\.ci_deploy\.email\}"/,
  );
  assert.doesNotMatch(computeViewer, /roles\/(?:owner|editor|compute\.admin)/);
});

test("production trust readback is exact and non-mutating", () => {
  const role = tofu.match(
    /resource "google_project_iam_custom_role" "ci_deploy_project_iam_readback" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(role, "missing production project IAM readback custom role");
  assert.match(role, /project\s*=\s*var\.project_id/);
  assert.match(role, /role_id\s*=\s*"meshrProjectIamReadback"/);

  const permissionList = role.match(/permissions\s*=\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(permissionList, "missing project IAM readback permission list");
  const permissions = [...permissionList.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(permissions, [
    "artifactregistry.repositories.getIamPolicy",
    "iam.roles.get",
    "iam.serviceAccountKeys.list",
    "iam.serviceAccounts.getIamPolicy",
    "iam.serviceAccounts.list",
    "iam.workloadIdentityPoolProviders.get",
    "iam.workloadIdentityPoolProviders.list",
    "resourcemanager.projects.get",
    "resourcemanager.projects.getIamPolicy",
  ]);
  assert.doesNotMatch(
    role,
    /(?:setIamPolicy|"iam\.serviceAccounts\.get"|\.(?:create|delete|update)\b)/,
  );
  assert.doesNotMatch(role, /roles\/(?:viewer|owner|editor)/);
  assert.doesNotMatch(tofu, /role\s*=\s*"roles\/viewer"/);

  const binding = tofu.match(
    /resource "google_project_iam_member" "ci_deploy_project_iam_readback" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(binding, "missing production project IAM readback binding");
  assert.match(binding, /project\s*=\s*var\.project_id/);
  assert.match(
    binding,
    /role\s*=\s*google_project_iam_custom_role\.ci_deploy_project_iam_readback\.name/,
  );
  assert.match(
    binding,
    /member\s*=\s*"serviceAccount:\$\{google_service_account\.ci_deploy\.email\}"/,
  );
  assert.doesNotMatch(
    binding,
    /ci_canary_deploy|google_service_account\.ci\.email/,
  );
});

test("production Model Armor readback is exact and cannot sanitize or mutate", () => {
  const role = tofu.match(
    /resource "google_project_iam_custom_role" "ci_deploy_model_armor_readiness" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(role, "missing production Model Armor readiness custom role");
  assert.match(role, /project\s*=\s*var\.project_id/);
  assert.match(role, /role_id\s*=\s*"meshrModelArmorReadiness"/);

  const permissionList = role.match(/permissions\s*=\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(permissionList, "missing Model Armor readiness permission list");
  const permissions = [...permissionList.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(permissions, ["modelarmor.templates.get"]);
  assert.doesNotMatch(
    role,
    /(?:useToSanitize|\.list|\.(?:create|delete|update)\b)/,
  );

  const binding = tofu.match(
    /resource "google_project_iam_member" "ci_deploy_model_armor_readiness" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(binding, "missing production Model Armor readiness binding");
  assert.match(
    binding,
    /role\s*=\s*google_project_iam_custom_role\.ci_deploy_model_armor_readiness\.name/,
  );
  assert.match(
    binding,
    /member\s*=\s*"serviceAccount:\$\{google_service_account\.ci_deploy\.email\}"/,
  );
});

test("production qualification has no dormant promotion authority", () => {
  const resourceBlocks = [
    ...tofu.matchAll(/resource "([^"]+)" "([^"]+)" \{([\s\S]*?)\n\}/g),
  ];
  const qualificationBindings = resourceBlocks
    .filter(
      (match) =>
        match[2].startsWith("ci_deploy") ||
        match[3].includes("google_service_account.ci_deploy"),
    )
    .map((match) => match[0])
    .join("\n");

  assert.doesNotMatch(
    qualificationBindings,
    /roles\/(?:datastore\.user|run\.developer|iam\.serviceAccountUser)/,
  );
  assert.doesNotMatch(tofu, /"ci_deploy_audit_writer"/);
  assert.doesNotMatch(tofu, /"ci_deploy_moderation_adapter_developer"/);
  assert.doesNotMatch(tofu, /"ci_deploy_moderation_adapter_act_as"/);

  const runViewer = tofu.match(
    /resource "google_project_iam_member" "ci_deploy_cloud_run_viewer" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(runViewer, "missing read-only Cloud Run qualification grant");
  assert.match(runViewer, /role\s*=\s*"roles\/run\.viewer"/);

  const adapterInvoker = tofu.match(
    /resource "google_cloud_run_v2_service_iam_member" "ci_deploy_moderation_adapter_invoker" \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(adapterInvoker, "missing authenticated adapter health grant");
  assert.match(adapterInvoker, /role\s*=\s*"roles\/run\.invoker"/);

  const provider = tofu.match(
    /resource "google_iam_workload_identity_pool_provider" "github_actions_deploy" \{([\s\S]*?)\n\}\n\nresource "google_service_account" "ci"/,
  )?.[1];
  assert.ok(provider, "missing production qualification WIF provider");
  assert.match(provider, /assertion\.repository_visibility == 'private'/);
  assert.match(provider, /assertion\.event_name == 'workflow_dispatch'/);
  assert.match(provider, /assertion\.ref == 'refs\/heads\/main'/);
  assert.match(
    provider,
    /assertion\.workflow_ref == '\$\{local\.github_production_deploy_workflow_ref\}'/,
  );
});

test("qualification Gateway RBAC is exact-subject and namespace scoped", () => {
  const resources = parseAllDocuments(rbac).map((document) => document.toJS());
  const roles = resources.filter((document) => document.kind === "Role");
  const roleBindings = resources.filter(
    (document) => document.kind === "RoleBinding",
  );
  const clusterRoles = resources.filter(
    (document) => document.kind === "ClusterRole",
  );
  const clusterRoleBindings = resources.filter(
    (document) => document.kind === "ClusterRoleBinding",
  );
  assert.equal(roles.length, 2);
  assert.equal(roleBindings.length, 2);
  assert.equal(clusterRoles.length, 1);
  assert.equal(clusterRoleBindings.length, 1);
  assert.doesNotMatch(rbac, /cluster-admin/);
  assert.doesNotMatch(rbac, /(?:apiGroups|resources|verbs):\s*\[[^\]]*\*/);
  assert.doesNotMatch(rbac, /\bsecrets\b/);
  assert.doesNotMatch(rbac, /resources:\s*\[[^\]]*pods\/(?:exec|attach)/);

  const fluxRole = roles.find(
    (role) => role.metadata.namespace === "flux-system",
  );
  assert.ok(fluxRole, "missing flux-system qualification Role");
  const sourceRule = fluxRole.rules.find((rule: { resources: string[] }) =>
    rule.resources.includes("gitrepositories"),
  );
  assert.equal(sourceRule.resourceNames, undefined);
  assert.deepEqual(sourceRule.verbs, ["get", "list", "create"]);
  const configMapRule = fluxRole.rules.find((rule: { resources: string[] }) =>
    rule.resources.includes("configmaps"),
  );
  assert.equal(configMapRule.resourceNames, undefined);
  assert.deepEqual(configMapRule.verbs, ["get", "list", "create"]);
  const quotaRule = fluxRole.rules.find((rule: { resources: string[] }) =>
    rule.resources.includes("resourcequotas"),
  );
  assert.deepEqual(quotaRule.resourceNames, [
    "meshr-production-qualification-releases",
  ]);
  assert.deepEqual(quotaRule.verbs, ["get"]);
  const kustomizationRule = fluxRole.rules.find(
    (rule: { resources: string[] }) =>
      rule.resources.includes("kustomizations"),
  );
  assert.deepEqual(kustomizationRule.resourceNames, [
    "meshr-production-qualification",
  ]);
  assert.deepEqual(kustomizationRule.verbs, ["get", "patch"]);
  assert.ok(
    fluxRole.rules.every((rule: { verbs: string[] }) =>
      rule.verbs.every((verb) => !["delete", "update"].includes(verb)),
    ),
    "qualification authority cannot update or delete retained releases",
  );
  const controllerInventoryRule = fluxRole.rules.find(
    (rule: { resources: string[] }) => rule.resources.includes("deployments"),
  );
  assert.deepEqual(controllerInventoryRule.resourceNames, [
    "source-controller",
    "kustomize-controller",
  ]);
  assert.deepEqual(controllerInventoryRule.verbs, ["get"]);
  const controllerServiceRule = fluxRole.rules.find(
    (rule: { resources: string[] }) => rule.resources.includes("services"),
  );
  assert.deepEqual(controllerServiceRule.resourceNames, ["source-controller"]);
  assert.deepEqual(controllerServiceRule.verbs, ["get"]);
  assert.ok(
    fluxRole.rules.every(
      (rule: { resources: string[] }) =>
        !rule.resources.includes("deployments/scale"),
    ),
  );

  const [schemaRole] = clusterRoles;
  assert.equal(
    schemaRole.metadata.name,
    "meshr-production-qualification-flux-schema",
  );
  assert.deepEqual(schemaRole.rules, [
    {
      apiGroups: ["apiextensions.k8s.io"],
      resources: ["customresourcedefinitions"],
      resourceNames: [
        "gitrepositories.source.toolkit.fluxcd.io",
        "kustomizations.kustomize.toolkit.fluxcd.io",
      ],
      verbs: ["get"],
    },
    {
      apiGroups: ["admissionregistration.k8s.io"],
      resources: [
        "validatingadmissionpolicies",
        "validatingadmissionpolicybindings",
      ],
      resourceNames: [
        "meshr-production-qualification-source.meshr.social",
        "meshr-production-qualification-inputs.meshr.social",
        "meshr-production-qualification-reconciliation.meshr.social",
        "meshr-production-qualification-private-services.meshr.social",
      ],
      verbs: ["get"],
    },
  ]);
  const [schemaBinding] = clusterRoleBindings;
  assert.equal(
    schemaBinding.metadata.name,
    "meshr-production-qualification-flux-schema",
  );
  assert.deepEqual(schemaBinding.subjects, [
    {
      kind: "User",
      name: "${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL}",
    },
  ]);
  assert.deepEqual(schemaBinding.roleRef, {
    apiGroup: "rbac.authorization.k8s.io",
    kind: "ClusterRole",
    name: "meshr-production-qualification-flux-schema",
  });

  const observerRole = roles.find(
    (role) => role.metadata.namespace === "meshr",
  );
  assert.ok(observerRole, "missing meshr qualification observer Role");
  assert.ok(
    observerRole.rules.every(
      (rule: { resources: string[] }) => !rule.resources.includes("configmaps"),
    ),
    "observer does not need namespace-wide ConfigMap discovery",
  );
  const ingressInventory = observerRole.rules.find(
    (rule: { apiGroups: string[] }) =>
      rule.apiGroups.includes("networking.k8s.io"),
  );
  assert.ok(ingressInventory.resources.includes("ingresses"));
  assert.deepEqual(ingressInventory.verbs, ["get", "list", "watch"]);
  const gatewayInventory = observerRole.rules.find(
    (rule: { apiGroups: string[] }) =>
      rule.apiGroups.includes("gateway.networking.k8s.io"),
  );
  assert.deepEqual(gatewayInventory.resources, ["gateways", "httproutes"]);
  assert.deepEqual(gatewayInventory.verbs, ["get", "list", "watch"]);
  const gkePolicyInventory = observerRole.rules.find(
    (rule: { apiGroups: string[] }) =>
      rule.apiGroups.includes("networking.gke.io"),
  );
  assert.deepEqual(gkePolicyInventory.resources, [
    "gcpbackendpolicies",
    "healthcheckpolicies",
  ]);
  assert.deepEqual(gkePolicyInventory.verbs, ["get", "list", "watch"]);
  assert.ok(
    observerRole.rules
      .filter((rule: { resources: string[] }) =>
        rule.resources.some((resource) =>
          [
            "ingresses",
            "gateways",
            "httproutes",
            "gcpbackendpolicies",
            "healthcheckpolicies",
          ].includes(resource),
        ),
      )
      .every((rule: { verbs: string[] }) =>
        rule.verbs.every((verb) => ["get", "list", "watch"].includes(verb)),
      ),
    "no-edge inventory must never gain write verbs",
  );
  for (const roleBinding of roleBindings) {
    assert.deepEqual(roleBinding.subjects, [
      {
        kind: "User",
        name: "${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL}",
      },
    ]);
    assert.equal(roleBinding.roleRef.kind, "Role");
  }
});

test("qualification Flux pins protected main and uses a restricted reconciler", () => {
  const resources = parseAllDocuments(flux).map((document) => document.toJS());
  assert.equal(resources.length, 2);

  const sources = resources.filter(
    (resource) => resource.kind === "GitRepository",
  );
  assert.equal(sources.length, 1, "expected one qualification source");
  const [source] = sources;
  assert.equal(source.apiVersion, "source.toolkit.fluxcd.io/v1");
  assert.deepEqual(source.metadata, {
    name: "meshr-pq-source-${MESHR_PRODUCTION_QUALIFICATION_SHA}",
    namespace: "flux-system",
  });
  assert.equal(source.spec.interval, "24h");
  assert.equal(source.spec.timeout, "5m");
  assert.equal(source.spec.url, "https://github.com/tflynn3/meshr.git");
  assert.equal(source.spec.provider, "generic");
  assert.equal(source.spec.suspend, false);
  assert.equal(source.spec.recurseSubmodules, false);
  assert.deepEqual(source.spec.ref, {
    branch: "main",
    commit: "${MESHR_PRODUCTION_QUALIFICATION_SHA}",
  });

  const reconcilers = resources.filter(
    (resource) => resource.kind === "Kustomization",
  );
  assert.equal(reconcilers.length, 1);
  const [reconciler] = reconcilers;
  assert.ok(reconciler, "missing qualification Flux Kustomization");
  assert.equal(reconciler.apiVersion, "kustomize.toolkit.fluxcd.io/v1");
  assert.deepEqual(reconciler.metadata, {
    name: "meshr-production-qualification",
    namespace: "flux-system",
    annotations: {
      "meshr.social/active-release-id":
        "${MESHR_PRODUCTION_QUALIFICATION_RELEASE_ID}",
      "meshr.social/previous-release-id":
        "${MESHR_PRODUCTION_QUALIFICATION_RELEASE_ID}",
      "meshr.social/transition-kind": "bootstrap",
    },
  });
  assert.equal(reconciler.spec.interval, "1m");
  assert.equal(reconciler.spec.path, "./deploy/production-qualification");
  assert.equal(reconciler.spec.targetNamespace, "meshr");
  assert.equal(reconciler.spec.force, false);
  assert.equal(reconciler.spec.suspend, false);
  assert.equal("serviceAccountName" in reconciler.spec, false);
  assert.deepEqual(reconciler.spec.sourceRef, {
    kind: "GitRepository",
    name: "meshr-pq-source-${MESHR_PRODUCTION_QUALIFICATION_SHA}",
  });
  assert.deepEqual(reconciler.spec.postBuild.substituteFrom, [
    {
      kind: "ConfigMap",
      name: "meshr-pq-images-${MESHR_PRODUCTION_QUALIFICATION_SHA}",
      optional: false,
    },
    {
      kind: "ConfigMap",
      name: "meshr-r-${MESHR_PRODUCTION_QUALIFICATION_RELEASE_ID}",
      optional: false,
    },
  ]);
  assert.deepEqual(reconciler.spec.postBuild.substitute, {
    MESHR_YAML_QUOTE: '"',
  });
  assert.equal(reconciler.spec.postBuild.substituteStrategy, "WithVariables");

  const applicationOverlay = parseYaml(qualificationKustomization);
  assert.ok(
    applicationOverlay.resources.every(
      (resource: string) => !resource.endsWith("/namespace.yaml"),
    ),
    "private bootstrap, not Flux, must own the meshr Namespace",
  );
  assert.ok(
    applicationOverlay.resources.every(
      (resource: string) =>
        !resource.endsWith("/flux.yaml") && resource !== "flux.yaml",
    ),
    "bootstrap Flux resources must not reconcile themselves as workload input",
  );
  assert.doesNotMatch(flux, /metrics-adapter/);
  for (const healthCheck of [
    "production-store-bootstrap",
    "api",
    "live-gateway",
    "web",
    "ingest",
    "topology-materializer",
    "moderation-worker",
    "moderation-screening-worker",
    "audit-worker",
    "notification-worker",
  ])
    assert.ok(
      reconciler.spec.healthChecks.some(
        (entry: { name: string }) => entry.name === healthCheck,
      ),
      `missing ${healthCheck} readiness gate`,
    );
  assert.match(
    releaseTransaction,
    /\.status\.artifact\.revision == \("main@sha1:" \+ \$sha\)/,
  );
  assert.match(
    releaseTransaction,
    /\.status\.lastAppliedRevision == \("main@sha1:" \+ \$sha\)/,
  );
  assert.match(
    releaseTransaction,
    /\.status\.observedGeneration == \$generation/,
  );
  assert.match(releaseTransaction, /\.type == "Ready" and \.status == "True"/);
});

test("metrics adapter is direct operator bootstrap and not CI-mutable Flux input", () => {
  assert.match(metricsAdapter, /\$\{METRICS_ADAPTER_GSA\}/);
  assert.match(
    qualificationReadme,
    /envsubst[^`]*deploy\/metrics-adapter\/adapter\.yaml[^`]*kubectl apply/s,
  );
  assert.doesNotMatch(
    flux,
    /meshr-metrics-adapter-values|deploy\/metrics-adapter/,
  );
  assert.doesNotMatch(rbac, /meshr-metrics-adapter-values/);
});

test("metrics adapter RBAC cannot collide with GKE-managed external metric access", () => {
  const resources = parseAllDocuments(metricsAdapter).map((document) =>
    document.toJS(),
  );
  const roleName = "meshr-external-metrics-reader";
  const roles = resources.filter(
    (resource) =>
      resource.kind === "ClusterRole" && resource.metadata.name === roleName,
  );
  const bindings = resources.filter(
    (resource) =>
      resource.kind === "ClusterRoleBinding" &&
      resource.metadata.name === roleName,
  );

  assert.equal(roles.length, 1, "expected one Meshr-owned external metrics role");
  assert.equal(
    bindings.length,
    1,
    "expected one Meshr-owned external metrics binding",
  );
  const [role] = roles;
  const [binding] = bindings;
  assert.deepEqual(role.rules, [
    {
      apiGroups: ["external.metrics.k8s.io"],
      resources: [
        "pubsub.googleapis.com|subscription|num_undelivered_messages",
      ],
      verbs: ["list", "get", "watch"],
    },
  ]);
  assert.deepEqual(binding.roleRef, {
    apiGroup: "rbac.authorization.k8s.io",
    kind: "ClusterRole",
    name: roleName,
  });
  assert.deepEqual(binding.subjects, [
    {
      kind: "ServiceAccount",
      name: "horizontal-pod-autoscaler",
      namespace: "kube-system",
    },
  ]);
  assert.equal(
    resources.some(
      (resource) => resource.metadata?.name === "external-metrics-reader",
    ),
    false,
    "Meshr manifests must not own GKE's external-metrics-reader objects",
  );
});

test("restricted Flux controller can reconcile only overlay resource kinds", () => {
  const resources = parseAllDocuments(fluxBootstrap).map((document) =>
    document.toJS(),
  );
  assert.equal(
    resources.some((resource) => resource.kind === "ServiceAccount"),
    false,
    "bootstrap must not create an impersonation target",
  );

  const role = resources.find((resource) => resource.kind === "Role");
  assert.equal(role.metadata.namespace, "meshr");
  const allowedResources = role.rules
    .flatMap((rule: { resources: string[] }) => rule.resources)
    .sort();
  assert.deepEqual(allowedResources, [
    "configmaps",
    "deployments",
    "horizontalpodautoscalers",
    "jobs",
    "networkpolicies",
    "poddisruptionbudgets",
    "secretproviderclasses",
    "serviceaccounts",
    "services",
  ]);
  for (const rule of role.rules) {
    assert.deepEqual(rule.verbs, [
      "get",
      "list",
      "watch",
      "create",
      "update",
      "patch",
      "delete",
    ]);
  }
  assert.doesNotMatch(fluxBootstrap, /resources:\s*\[[^\]]*\*/);
  assert.doesNotMatch(
    fluxBootstrap,
    /resources:\s*\[[^\]]*(?:secrets|roles|rolebindings|namespaces|clusterroles)/,
  );
  const roleBinding = resources.find(
    (resource) => resource.kind === "RoleBinding",
  );
  assert.deepEqual(roleBinding.subjects, [
    {
      kind: "ServiceAccount",
      name: "kustomize-controller",
      namespace: "flux-system",
    },
  ]);
  assert.doesNotMatch(fluxBootstrap, /serviceaccounts\/token/);
});

test("minimal Flux renderer strips broad controllers and pins the exact two images", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "meshr-flux-render-"));
  const fixturePath = join(temporaryDirectory, "install.yaml");
  const crdNames = [
    "buckets.source.toolkit.fluxcd.io",
    "externalartifacts.source.toolkit.fluxcd.io",
    "gitrepositories.source.toolkit.fluxcd.io",
    "helmcharts.source.toolkit.fluxcd.io",
    "helmrepositories.source.toolkit.fluxcd.io",
    "kustomizations.kustomize.toolkit.fluxcd.io",
    "ocirepositories.source.toolkit.fluxcd.io",
  ];
  const namespaced = [
    ["ResourceQuota", "critical-pods"],
    ["ServiceAccount", "kustomize-controller"],
    ["ServiceAccount", "source-controller"],
    ["Service", "source-controller"],
    ["NetworkPolicy", "allow-egress"],
  ].map(([kind, name]) => ({
    apiVersion: "v1",
    kind,
    metadata: { name, namespace: "flux-system" },
  }));
  const deployment = (name: string, image: string) => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, namespace: "flux-system" },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "manager",
              image,
              args: [
                "--events-addr=http://notification-controller.flux-system.svc.cluster.local./",
                "--watch-all-namespaces",
                "--enable-leader-election",
              ],
            },
          ],
        },
      },
    },
  });
  const fixture = [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: "flux-system" } },
    ...crdNames.map((name) => ({
      apiVersion: "apiextensions.k8s.io/v1",
      kind: "CustomResourceDefinition",
      metadata: { name },
    })),
    ...namespaced,
    deployment("source-controller", "ghcr.io/fluxcd/source-controller:v1.9.5"),
    deployment(
      "kustomize-controller",
      "ghcr.io/fluxcd/kustomize-controller:v1.9.5",
    ),
    {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name: "cluster-reconciler" },
      roleRef: { name: "cluster-admin" },
    },
    deployment("notification-controller", "unreviewed:latest"),
  ];

  try {
    writeFileSync(
      fixturePath,
      fixture.map((resource) => stringify(resource)).join("---\n"),
    );
    const rendered = execFileSync(
      process.execPath,
      ["scripts/render-minimal-flux.mjs", fixturePath],
      { cwd: new URL("../", import.meta.url), encoding: "utf8" },
    );
    const resources = parseAllDocuments(rendered).map((document) =>
      document.toJS(),
    );
    const deployments = resources.filter(
      (resource) => resource.kind === "Deployment",
    );
    assert.deepEqual(
      deployments.map((resource) => resource.metadata.name).sort(),
      ["kustomize-controller", "source-controller"],
    );
    assert.ok(
      resources.every(
        (resource) =>
          resource.kind !== "ClusterRole" &&
          resource.kind !== "ClusterRoleBinding",
      ),
    );
    for (const controller of deployments) {
      const container = controller.spec.template.spec.containers[0];
      assert.match(container.image, /@sha256:[a-f0-9]{64}$/);
      assert.deepEqual(container.resources, {
        limits: {
          cpu: "500m",
          memory: "1Gi",
          "ephemeral-storage": "1Gi",
        },
        requests: {
          cpu: "500m",
          memory: "1Gi",
          "ephemeral-storage": "1Gi",
        },
      });
      assert.ok(container.args.includes("--watch-all-namespaces=false"));
      assert.ok(
        container.args.every(
          (argument: string) => !argument.startsWith("--events-addr="),
        ),
      );
    }
    const kustomize = deployments.find(
      (resource) => resource.metadata.name === "kustomize-controller",
    );
    assert.ok(
      kustomize.spec.template.spec.containers[0].args.includes(
        "--no-cross-namespace-refs=true",
      ),
    );
    assert.ok(
      kustomize.spec.template.spec.containers[0].args.includes(
        "--feature-gates=DisableConfigWatchers=true",
      ),
    );
    assert.ok(
      kustomize.spec.template.spec.containers[0].args.includes(
        "--no-remote-bases=true",
      ),
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("GKE Autopilot Flux pod defaults normalize only the exact safe injection", () => {
  const moduleDirectory = fileURLToPath(
    new URL("../deploy/production-qualification/", import.meta.url),
  );
  const normalize = (template: Record<string, unknown>) =>
    JSON.parse(
      execFileSync(
        "jq",
        [
          "-L",
          moduleDirectory,
          "-cS",
          'include "gke-autopilot-contract"; meshr_normalize_flux_pod_template',
        ],
        { input: JSON.stringify(template), encoding: "utf8" },
      ),
    );
  const canonical = {
    metadata: { labels: { app: "source-controller" } },
    spec: {
      serviceAccountName: "source-controller",
      securityContext: { fsGroup: 1337 },
      containers: [{ name: "manager", image: "example.invalid/controller" }],
    },
  };
  const exactSeccomp = {
    seccompProfile: { type: "RuntimeDefault" },
  };
  const exactToleration = {
    effect: "NoSchedule",
    key: "kubernetes.io/arch",
    operator: "Equal",
    value: "amd64",
  };
  const injected = structuredClone(canonical);
  Object.assign(injected.spec, {
    securityContext: { ...canonical.spec.securityContext, ...exactSeccomp },
    tolerations: [exactToleration],
  });

  assert.deepEqual(normalize(injected), normalize(canonical));

  const adversarial = [
    {
      securityContext: {
        ...canonical.spec.securityContext,
        seccompProfile: { type: "Unconfined" },
      },
      tolerations: [exactToleration],
    },
    {
      securityContext: {
        ...canonical.spec.securityContext,
        seccompProfile: {
          type: "RuntimeDefault",
          localhostProfile: "attacker/profile.json",
        },
      },
      tolerations: [exactToleration],
    },
    {
      securityContext: {
        ...canonical.spec.securityContext,
        ...exactSeccomp,
        runAsUser: 0,
      },
      tolerations: [exactToleration],
    },
    {
      securityContext: { ...canonical.spec.securityContext, ...exactSeccomp },
      tolerations: [exactToleration, { operator: "Exists" }],
    },
    {
      securityContext: { ...canonical.spec.securityContext, ...exactSeccomp },
      tolerations: [
        { ...exactToleration, operator: "Exists", value: undefined },
      ],
    },
    {
      securityContext: { ...canonical.spec.securityContext, ...exactSeccomp },
      tolerations: [{ ...exactToleration, effect: "NoExecute" }],
    },
  ].map((mutation) => {
    const template = structuredClone(canonical);
    Object.assign(template.spec, mutation);
    return template;
  });
  for (const template of adversarial) {
    assert.notDeepEqual(normalize(template), normalize(canonical));
  }
});

test("GKE admission defaults normalize only the exact managed namespace exclusion", () => {
  const moduleDirectory = fileURLToPath(
    new URL("../deploy/production-qualification/", import.meta.url),
  );
  const normalize = (spec: Record<string, unknown>) =>
    JSON.parse(
      execFileSync(
        "jq",
        [
          "-L",
          moduleDirectory,
          "-cS",
          'include "gke-autopilot-contract"; meshr_normalize_admission_spec',
        ],
        { input: JSON.stringify(spec), encoding: "utf8" },
      ),
    );
  const excludedNamespaces = [
    "kube-system",
    "gke-gmp-system",
    "gke-managed-cim",
    "gke-managed-volumepopulator",
    "gke-managed-checkpointing",
    "gke-managed-parallelstorecsi",
    "gke-managed-lustrecsi",
    "gke-managed-otel",
    "gke-managed-mldiagnostics",
    "gke-managed-networking-dra-driver",
    "gke-managed-pod-snapshots",
  ];
  const exactSelector = {
    matchExpressions: [
      {
        key: "kubernetes.io/metadata.name",
        operator: "NotIn",
        values: excludedNamespaces,
      },
    ],
  };
  const canonical = {
    failurePolicy: "Fail",
    matchConstraints: {
      resourceRules: [
        {
          apiGroups: [""],
          apiVersions: ["v1"],
          operations: ["CREATE"],
          resources: ["configmaps"],
          scope: "Namespaced",
        },
      ],
    },
  };
  const injected = structuredClone(canonical);
  Object.assign(injected.matchConstraints, {
    namespaceSelector: exactSelector,
  });

  assert.equal(excludedNamespaces.includes("flux-system"), false);
  assert.equal(excludedNamespaces.includes("meshr"), false);
  assert.deepEqual(normalize(injected), normalize(canonical));

  const adversarialSelectors = [
    {
      matchExpressions: [
        { ...exactSelector.matchExpressions[0], values: excludedNamespaces.slice(1) },
      ],
    },
    {
      matchExpressions: [
        {
          ...exactSelector.matchExpressions[0],
          values: [...excludedNamespaces, "flux-system"],
        },
      ],
    },
    {
      matchExpressions: [
        {
          ...exactSelector.matchExpressions[0],
          values: [...excludedNamespaces, "meshr"],
        },
      ],
    },
    {
      matchExpressions: [
        { ...exactSelector.matchExpressions[0], operator: "Exists" },
      ],
    },
    {
      matchExpressions: [
        ...exactSelector.matchExpressions,
        { key: "meshr.social/bypass", operator: "DoesNotExist" },
      ],
    },
    {
      ...exactSelector,
      matchLabels: { "meshr.social/bypass": "true" },
    },
  ];
  for (const namespaceSelector of adversarialSelectors) {
    const policy = structuredClone(canonical);
    Object.assign(policy.matchConstraints, { namespaceSelector });
    assert.notDeepEqual(normalize(policy), normalize(canonical));
  }
});

test("Flux controller RBAC is namespaced and cannot mint or read credentials", () => {
  const resources = parseAllDocuments(fluxControllerRbac).map((document) =>
    document.toJS(),
  );
  assert.equal(resources.length, 4);
  assert.ok(
    resources.every(
      (resource) => resource.metadata.namespace === "flux-system",
    ),
  );
  assert.ok(
    resources.every(
      (resource) => resource.kind === "Role" || resource.kind === "RoleBinding",
    ),
  );
  assert.doesNotMatch(
    fluxControllerRbac,
    /cluster-admin|serviceaccounts\/token|\bsecrets\b/,
  );
  assert.doesNotMatch(fluxControllerRbac, /resources:\s*\[[^\]]*\*/);
  assert.doesNotMatch(fluxControllerRbac, /verbs:\s*\[[^\]]*\*/);
  for (const binding of resources.filter(
    (resource) => resource.kind === "RoleBinding",
  )) {
    assert.equal(binding.roleRef.kind, "Role");
    assert.deepEqual(binding.subjects, [
      {
        kind: "ServiceAccount",
        name: binding.metadata.name,
        namespace: "flux-system",
      },
    ]);
  }
  assert.match(fluxRenderer, /cluster-scoped controller RBAC is forbidden/);
  assert.match(fluxContract, /verification_mode="\$\{1:-operator\}"/);
  assert.match(
    fluxContract,
    /test "\$verification_mode" = operator \|\| exit 0/,
  );
  for (const exactObject of [
    "role.rbac.authorization.k8s.io/source-controller",
    "rolebinding.rbac.authorization.k8s.io/source-controller",
    "role.rbac.authorization.k8s.io/kustomize-controller",
    "rolebinding.rbac.authorization.k8s.io/kustomize-controller",
    "meshr-production-qualification-reconciler",
  ]) {
    assert.ok(
      fluxContract.includes(exactObject),
      `missing live RBAC check for ${exactObject}`,
    );
  }
  assert.match(
    fluxContract,
    /pod_template_contract_sha\(\)[\s\S]*\.spec\.template[\s\S]*\.containers \|= map/,
  );
  assert.equal(
    fluxContract.match(/include "gke-autopilot-contract"/g)?.length,
    2,
  );
  for (const deploymentInvariant of [
    ".spec.replicas == 1",
    "(.spec.paused // false) == false",
    ".spec.progressDeadlineSeconds == 600",
    ".spec.revisionHistoryLimit == 10",
    "del(.serviceAccount)",
    'strip_default("schedulerName"; "default-scheduler")',
    'strip_default("apiVersion"; "v1")',
    'strip_default("divisor"; "0")',
    'strip_default("scheme"; "HTTP")',
  ]) {
    assert.ok(
      fluxContract.includes(deploymentInvariant),
      `missing normalized Deployment contract ${deploymentInvariant}`,
    );
  }
  assert.doesNotMatch(
    fluxContract,
    /del\([\s\S]{0,200}\.(affinity|nodeSelector|tolerations|topologySpreadConstraints)/,
  );
  assert.match(fluxContract, /source_service_contract_sha\(\)/);
  assert.match(
    fluxContract,
    /\.spec\.selector == \{app: "source-controller"\}[\s\S]*name: "http", port: 80, protocol: "TCP", targetPort: "http"/,
  );
  assert.match(
    fluxContract,
    /kubectl\.kubernetes\.io\/last-applied-configuration[\s\S]*fromjson/,
  );
  for (const signedContractDigest of [
    "719f952c1353c1f1f491b67f069ffb737ae2353a560e997d2f04db97437acdc0",
    "ee3c79522cc9d04b7ac05569b749f4174d37363a200a7b6170c08f9ed87560d9",
    "0b6cd626606449dbfea09c15163d02313117dbc35566215fc53b9e1919983493",
  ]) {
    assert.ok(
      fluxContract.includes(signedContractDigest),
      `missing signed Flux runtime contract ${signedContractDigest}`,
    );
  }
  assert.match(
    fluxContract,
    /rolebindings\.rbac\.authorization\.k8s\.io[\s\\]*--all-namespaces/,
  );
  assert.match(
    fluxContract,
    /clusterrolebindings\.rbac\.authorization\.k8s\.io[\s\S]*length == 0/,
  );
  for (const effectiveDenial of [
    "assert_cannot",
    '--as="$principal"',
    "secrets",
    "--subresource=token",
    "impersonate",
    "bind",
    "escalate",
    "customresourcedefinitions.apiextensions.k8s.io",
    "validatingadmissionpolicies.admissionregistration.k8s.io",
    "namespaces",
    "namespace_names",
  ]) {
    assert.ok(
      fluxContract.includes(effectiveDenial),
      `missing effective controller denial for ${effectiveDenial}`,
    );
  }
  assert.match(
    fluxContract,
    /test "\$controller" = source-controller[\s\S]*for verb in create delete; do[\s\S]*gitrepositories\.source\.toolkit\.fluxcd\.io/,
  );
  assert.match(
    fluxContract,
    /for verb in create delete; do[\s\S]*kustomizations\.kustomize\.toolkit\.fluxcd\.io/,
  );
  assert.match(releaseTransaction, /verify-flux-contract\.sh gateway/);
  const hostedMutationGate = releaseTransaction.slice(
    releaseTransaction.indexOf('cd "$repository_root"'),
  );
  assert.ok(
    hostedMutationGate.indexOf("verify-flux-contract.sh gateway") <
      hostedMutationGate.indexOf('apply_switch "'),
    "the hosted verifier must run before rollback or promotion mutation",
  );
  assert.match(fluxContract, /verify_admission_contract\(\)/);
  assert.match(
    fluxContract,
    /--arg deploy_gsa "\$CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL"[\s\S]*admission-contract\.json/,
  );
  assert.doesNotMatch(
    fluxContract,
    /node --input-type|from "yaml"|command -v envsubst/,
  );
  assert.match(
    fluxContract,
    /\(\$actual \| normalized_spec\) == \(\$contract \| normalized_spec\)/,
  );
  for (const admissionDefault of [
    '.matchConstraints.matchPolicy //= "Equivalent"',
    ".matchConstraints.namespaceSelector //= {}",
    ".matchConstraints.objectSelector //= {}",
    '.matchResources.matchPolicy //= "Equivalent"',
    ".matchResources.namespaceSelector //= {}",
    ".matchResources.objectSelector //= {}",
  ]) {
    assert.ok(
      `${fluxContract}\n${gkeAutopilotContract}`.includes(admissionDefault),
      `missing admission API default normalization ${admissionDefault}`,
    );
  }
  assert.match(fluxContract, /metadata\.deletionTimestamp \/\/ null/);
  assert.match(
    fluxContract,
    /status\.observedGeneration ==[\s\S]*metadata\.generation[\s\S]*expressionWarnings/,
  );
  for (const admissionResource of [
    "validatingadmissionpolicies.admissionregistration.k8s.io",
    "validatingadmissionpolicybindings.admissionregistration.k8s.io",
  ]) {
    assert.ok(
      fluxContract.includes(admissionResource),
      `missing live ${admissionResource} contract read`,
    );
  }
  assert.match(
    qualificationReadme,
    /verify-flux-contract\.sh operator[\s\S]*verify-flux-contract\.sh gateway/,
  );
  assert.match(
    qualificationReadme,
    /admission-contract\.json[\s\S]*gke-autopilot-contract\.jq[\s\S]*verify-flux-contract\.sh[\s\S]*all\s+three files[\s\S]*approved digests/,
  );
  assert.match(
    qualificationReadme,
    /release-transaction\.sh initialize[\s\S]*rendered_gateway_rbac=/,
  );
  assert.match(
    qualificationReadme,
    /hosted_denial_log=[\s\S]*meshr-production-qualification-inputs\.meshr\.social/,
  );
  assert.match(releaseTransaction, /export_admission_anchors\(\)/);
  assert.match(
    releaseTransaction,
    /CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL:\?set the exact hosted deploy GSA/,
  );
  assert.match(
    releaseTransaction,
    /export_admission_anchors "\$runtime_inputs"[\s\S]*verify-flux-contract\.sh gateway/,
  );
});

test("checked-in admission contract exactly matches bootstrap policies", () => {
  const policyNames = new Set([
    "meshr-production-qualification-source.meshr.social",
    "meshr-production-qualification-inputs.meshr.social",
    "meshr-production-qualification-reconciliation.meshr.social",
    "meshr-production-qualification-private-services.meshr.social",
  ]);
  const expected = parseAllDocuments(fluxBootstrap)
    .map((document) => {
      assert.equal(document.errors.length, 0);
      return document.toJS();
    })
    .filter(
      (resource) =>
        [
          "ValidatingAdmissionPolicy",
          "ValidatingAdmissionPolicyBinding",
        ].includes(resource?.kind) && policyNames.has(resource?.metadata?.name),
    )
    .map((resource) => ({
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      metadata: { name: resource.metadata.name },
      spec: resource.spec,
    }));
  assert.equal(expected.length, policyNames.size * 2);
  assert.deepEqual(JSON.parse(admissionContract), expected);
});

test("documented authorization checks distinguish denial from transport failure", () => {
  const helpers = [
    ...qualificationReadme.matchAll(
      /(assert_documented_can_i\(\) \{[\s\S]*?\n\})/g,
    ),
  ].map((match) => match[1]);
  assert.equal(helpers.length, 2, "each independent shell block needs a helper");
  assert.doesNotMatch(
    qualificationReadme,
    /auth can-i[\s\S]{0,160}\| grep -Fx (?:yes|no)/,
  );
  for (const helper of helpers) {
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
${helper}
kubectl() {
  printf '%s\\n' "$KUBECTL_DECISION"
  return "$KUBECTL_STATUS"
}
KUBECTL_DECISION=yes KUBECTL_STATUS=0 assert_documented_can_i yes get pods
KUBECTL_DECISION=no KUBECTL_STATUS=1 assert_documented_can_i no get secrets
if KUBECTL_DECISION=no KUBECTL_STATUS=0 assert_documented_can_i no get secrets; then exit 91; fi
if KUBECTL_DECISION=yes KUBECTL_STATUS=1 assert_documented_can_i yes get pods; then exit 92; fi
if KUBECTL_DECISION= KUBECTL_STATUS=2 assert_documented_can_i no get secrets; then exit 93; fi
if KUBECTL_DECISION=no KUBECTL_STATUS=1 assert_documented_can_i yes get pods; then exit 94; fi`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  }
});

test("controller authorization denials accept kubectl's negative exit status", () => {
  const assertCannot = fluxContract.match(
    /(assert_cannot\(\) \{[\s\S]*?\n\})\n\nnamespace_inventory=/,
  )?.[1];
  assert.ok(assertCannot);
  execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
${assertCannot}
kubectl() {
  printf '%s\\n' "$KUBECTL_DECISION"
  return "$KUBECTL_STATUS"
}
KUBECTL_DECISION=no KUBECTL_STATUS=1 assert_cannot principal get secrets
if KUBECTL_DECISION=yes KUBECTL_STATUS=0 assert_cannot principal get secrets; then
  exit 91
fi
if KUBECTL_DECISION= KUBECTL_STATUS=2 assert_cannot principal get secrets; then
  exit 92
fi`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
});

test("source admission policy fails closed over every mutable source input", () => {
  const resources = parseAllDocuments(fluxBootstrap).map((document) =>
    document.toJS(),
  );
  const policy = resources.find(
    (resource) =>
      resource.kind === "ValidatingAdmissionPolicy" &&
      resource.metadata.name ===
        "meshr-production-qualification-source.meshr.social",
  );
  const binding = resources.find(
    (resource) =>
      resource.kind === "ValidatingAdmissionPolicyBinding" &&
      resource.metadata.name ===
        "meshr-production-qualification-source.meshr.social",
  );
  assert.equal(policy.spec.failurePolicy, "Fail");
  assert.deepEqual(policy.spec.matchConstraints.resourceRules, [
    {
      apiGroups: ["source.toolkit.fluxcd.io"],
      apiVersions: ["v1"],
      operations: ["CREATE", "UPDATE"],
      resources: ["gitrepositories"],
      scope: "Namespaced",
    },
  ]);
  assert.match(
    policy.spec.matchConditions[0].expression,
    /CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL.*meshr-pq-source-/s,
  );
  const expressions = policy.spec.validations
    .map((validation: { expression: string }) => validation.expression)
    .join("\n");
  for (const invariant of [
    "https://github.com/tflynn3/meshr.git",
    "object.spec.interval == '24h'",
    "object.spec.timeout == '5m'",
    "object.spec.provider == 'generic'",
    "object.spec.suspend == false",
    "object.spec.recurseSubmodules == false",
    "object.spec.ref.branch == 'main'",
    "^[0-9a-f]{40}$",
    "object.metadata.name.endsWith(object.spec.ref.commit)",
  ]) {
    assert.ok(expressions.includes(invariant), `missing ${invariant}`);
  }
  for (const forbidden of [
    "tag",
    "semver",
    "name",
    "secretRef",
    "proxySecretRef",
    "verify",
    "include",
    "sparseCheckout",
    "serviceAccountName",
    "ignore",
  ]) {
    assert.ok(
      expressions.includes(`!has(object.spec.${forbidden}`) ||
        expressions.includes(`!has(object.spec.ref.${forbidden}`),
      `admission policy does not reject ${forbidden}`,
    );
  }
  for (const metadataField of [
    "annotations",
    "labels",
    "ownerReferences",
    "finalizers",
  ]) {
    assert.ok(
      expressions.includes(`object.metadata.${metadataField}`),
      `source policy does not pin metadata.${metadataField}`,
    );
  }
  assert.match(
    expressions,
    /system:serviceaccount:flux-system:source-controller/,
  );
  assert.match(expressions, /object\.spec == oldObject\.spec/);
  assert.match(expressions, /request\.operation == 'CREATE'/);
  assert.equal(
    binding.spec.policyName,
    "meshr-production-qualification-source.meshr.social",
  );
  assert.deepEqual(binding.spec.validationActions, ["Deny"]);
  assert.deepEqual(binding.spec.matchResources.namespaceSelector.matchLabels, {
    "kubernetes.io/metadata.name": "flux-system",
  });

  const canonical = {
    interval: "24h",
    timeout: "5m",
    url: "https://github.com/tflynn3/meshr.git",
    provider: "generic",
    suspend: false,
    recurseSubmodules: false,
    ref: { branch: "main", commit: "0123456789abcdef0123456789abcdef01234567" },
  };
  const isCanonical = (spec: Record<string, unknown>): boolean => {
    const ref = spec.ref as Record<string, unknown> | undefined;
    return (
      spec.interval === "24h" &&
      spec.timeout === "5m" &&
      spec.url === "https://github.com/tflynn3/meshr.git" &&
      spec.provider === "generic" &&
      spec.suspend === false &&
      spec.recurseSubmodules === false &&
      Object.keys(spec).sort().join(",") ===
        "interval,provider,recurseSubmodules,ref,suspend,timeout,url" &&
      ref?.branch === "main" &&
      typeof ref.commit === "string" &&
      /^[0-9a-f]{40}$/.test(ref.commit) &&
      Object.keys(ref).sort().join(",") === "branch,commit"
    );
  };
  assert.equal(isCanonical(canonical), true);
  const denied = [
    { ...canonical, url: "https://attacker.invalid/repo.git" },
    { ...canonical, interval: "1m" },
    { ...canonical, interval: "1ms" },
    { ...canonical, timeout: "60s" },
    { ...canonical, timeout: "10m" },
    { ...canonical, provider: "github" },
    { ...canonical, suspend: true },
    { ...canonical, recurseSubmodules: true },
    { ...canonical, ref: { ...canonical.ref, branch: "production" } },
    { ...canonical, ref: { ...canonical.ref, commit: "abc" } },
    {
      ...canonical,
      ref: { ...canonical.ref, commit: canonical.ref.commit.toUpperCase() },
    },
    { ...canonical, ref: { ...canonical.ref, tag: "latest" } },
    { ...canonical, ref: { ...canonical.ref, semver: ">=1.0.0" } },
    { ...canonical, ref: { ...canonical.ref, name: "refs/heads/main" } },
    { ...canonical, include: [] },
    { ...canonical, secretRef: { name: "credentials" } },
    { ...canonical, proxySecretRef: { name: "proxy" } },
    { ...canonical, verify: { secretRef: { name: "keys" } } },
    { ...canonical, sparseCheckout: ["deploy"] },
    { ...canonical, serviceAccountName: "source-reader" },
    { ...canonical, ignore: "*" },
  ];
  for (const candidate of denied) assert.equal(isCanonical(candidate), false);

  assert.equal(
    resources.some(
      (resource) =>
        resource.metadata?.name ===
        "meshr-production-qualification-source-fence.meshr.social",
    ),
    false,
  );
});

test("qualification substitution inputs are admission-gated and injection-safe", () => {
  const resources = parseAllDocuments(fluxBootstrap).map((document) =>
    document.toJS(),
  );
  const name = "meshr-production-qualification-inputs.meshr.social";
  const policy = resources.find(
    (resource) =>
      resource.kind === "ValidatingAdmissionPolicy" &&
      resource.metadata.name === name,
  );
  const binding = resources.find(
    (resource) =>
      resource.kind === "ValidatingAdmissionPolicyBinding" &&
      resource.metadata.name === name,
  );
  assert.ok(policy, "missing qualification input admission policy");
  assert.equal(policy.spec.failurePolicy, "Fail");
  assert.equal(policy.spec.paramKind, undefined);
  assert.deepEqual(policy.spec.matchConstraints.resourceRules, [
    {
      apiGroups: [""],
      apiVersions: ["v1"],
      operations: ["CREATE", "UPDATE"],
      resources: ["configmaps"],
      scope: "Namespaced",
    },
  ]);
  assert.match(
    policy.spec.matchConditions[0].expression,
    /CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL.*meshr-pq-images-.*meshr-r-/s,
  );
  const expressions = policy.spec.validations
    .map((validation: { expression: string }) => validation.expression)
    .join("\n");
  assert.match(
    expressions,
    /has\(object\.immutable\).*object\.immutable == true/s,
  );
  assert.match(expressions, /request\.operation == 'CREATE'/);
  assert.match(expressions, /!object\.data\[key\]\.contains\('\\n'\)/);
  assert.match(expressions, /!object\.data\[key\]\.contains\('\\r'\)/);
  assert.match(expressions, /object\.data\.size\(\) == 4/);
  assert.match(expressions, /object\.data\.size\(\) == 20/);
  for (const image of ["api", "event-plane", "moderation-adapter", "web"]) {
    assert.ok(
      expressions.includes(`/meshr/${image}@sha256:[a-f0-9]{64}`),
      `missing immutable ${image} image contract`,
    );
  }
  assert.match(
    expressions,
    /docker\[\.\]pkg\[\.\]dev\/\$\{GCP_PROJECT_ID\}\/meshr/,
  );
  assert.match(
    expressions,
    /object\.data\.GCP_PROJECT_ID == '\$\{GCP_PROJECT_ID\}'/,
  );
  for (const databaseKey of [
    "MESHR_FIRESTORE_DATABASE",
    "MESHR_TOPOLOGY_FIRESTORE_DATABASE",
    "MESHR_EVENT_AUDIT_FIRESTORE_DATABASE",
    "MESHR_NOTIFICATIONS_FIRESTORE_DATABASE",
    "MESHR_MODERATION_FIRESTORE_DATABASE",
  ]) {
    assert.ok(
      expressions.includes(
        `object.data.${databaseKey} == '\${${databaseKey}}'`,
      ),
      `${databaseKey} must equal its operator-injected anchor`,
    );
  }
  assert.match(
    expressions,
    /MESHR_MODERATION_REVISION_TAG\.matches\('\^r-\[a-f0-9\]\{20\}\$'\)/,
  );
  assert.match(expressions, /MESHR_MODERATION_RELEASE_SHA\.startsWith/);
  assert.match(
    expressions,
    /MESHR_MODERATION_RELEASE_SHA == object\.data\.MESHR_RELEASE_SHA/,
  );
  assert.match(expressions, /MESHR_MODERATION_REVISION_TAG \+ '---'/);
  assert.match(expressions, /split\('https:\/\/'\)\[1\] \+ '\/screen'/);
  assert.match(expressions, /split\('https:\/\/'\)\[1\] \+ '\/health'/);
  assert.match(
    expressions,
    /object\.data\.MESHR_MODERATION_AUDIENCE == '\$\{MESHR_MODERATION_AUDIENCE\}'/,
  );
  assert.match(
    expressions,
    /MESHR_RELEASE_SHA\.matches\('\^\[a-f0-9\]\{40\}\$'\)/,
  );
  assert.match(
    expressions,
    /object\.metadata\.name\.split\('-'\)\[3\] == object\.data\.MESHR_RELEASE_SHA/,
  );
  assert.match(expressions, /split\('-'\)\[2\] == 'b'/);
  assert.match(expressions, /split\('-'\)\[2\] == 'r'/);
  for (const metadataField of [
    "annotations",
    "labels",
    "ownerReferences",
    "finalizers",
  ]) {
    assert.ok(expressions.includes(`object.metadata.${metadataField}`));
  }
  assert.equal(binding.spec.paramRef, undefined);
  assert.deepEqual(binding.spec.validationActions, ["Deny"]);
});

test("qualification admission forbids public Service edges and bounds retained inputs", () => {
  const resources = parseAllDocuments(fluxBootstrap).map((document) =>
    document.toJS(),
  );
  const name = "meshr-production-qualification-private-services.meshr.social";
  const policy = resources.find(
    (resource) =>
      resource.kind === "ValidatingAdmissionPolicy" &&
      resource.metadata.name === name,
  );
  const binding = resources.find(
    (resource) =>
      resource.kind === "ValidatingAdmissionPolicyBinding" &&
      resource.metadata.name === name,
  );
  assert.ok(policy, "missing private-Service admission policy");
  assert.equal(policy.spec.failurePolicy, "Fail");
  assert.deepEqual(policy.spec.matchConstraints.resourceRules, [
    {
      apiGroups: [""],
      apiVersions: ["v1"],
      operations: ["CREATE", "UPDATE"],
      resources: ["services"],
      scope: "Namespaced",
    },
  ]);
  const expression = policy.spec.validations[0].expression;
  for (const invariant of [
    "object.spec.type == 'ClusterIP'",
    "object.spec.externalIPs.size() == 0",
    "!has(object.spec.externalName)",
    "!has(object.spec.loadBalancerClass)",
    "object.spec.allocateLoadBalancerNodePorts == false",
    "!has(port.nodePort)",
  ])
    assert.ok(expression.includes(invariant), `missing ${invariant}`);
  assert.deepEqual(binding.spec.matchResources.namespaceSelector.matchLabels, {
    "kubernetes.io/metadata.name": "meshr",
  });

  const quota = resources.find(
    (resource) =>
      resource.kind === "ResourceQuota" &&
      resource.metadata.name === "meshr-production-qualification-releases",
  );
  assert.deepEqual(quota.spec.hard, {
    "count/configmaps": "${MESHR_RELEASE_CONFIGMAP_QUOTA}",
    "count/gitrepositories.source.toolkit.fluxcd.io":
      "${MESHR_RELEASE_SOURCE_QUOTA}",
    "count/kustomizations.kustomize.toolkit.fluxcd.io": "1",
  });
  assert.match(releaseTransaction, /\.metadata\.name == "kube-root-ca\.crt"/);
  assert.match(releaseTransaction, /capacity is exhausted/);
  assert.match(releaseTransaction, /source_limit=.*count\/gitrepositories/s);
  assert.match(releaseTransaction, /configmap_limit=.*count\/configmaps/s);
  assert.match(releaseTransaction, /-le "\$source_limit"/);
  assert.match(releaseTransaction, /-le "\$configmap_limit"/);
  assert.match(releaseTransaction, /tonumber <= 64/);
  assert.match(releaseTransaction, /tonumber <= 192/);
  assert.match(
    releaseTransaction,
    /\$quota\.status\.hard == \$quota\.spec\.hard/,
  );
  assert.match(releaseTransaction, /\$quota\.status\.used\[\$key\]/);
  assert.match(
    qualificationReadme,
    /\$quota\.status\.hard == \$quota\.spec\.hard/,
  );
  assert.match(qualificationReadme, /\$quota\.status\.used\[\$key\]/);
  assert.match(qualificationReadme, /MESHR_RELEASE_SOURCE_QUOTA/);
  assert.match(qualificationReadme, /MESHR_RELEASE_CONFIGMAP_QUOTA/);
  assert.match(releaseTransaction, /\^\[1-9\]\[0-9\]\{0,2\}\$/);
  assert.match(qualificationReadme, /validate_quota_integer/);
  assert.match(qualificationReadme, /MESHR_RELEASE_SOURCE_QUOTA <= 64/);
  assert.match(qualificationReadme, /MESHR_RELEASE_CONFIGMAP_QUOTA <= 192/);
  assert.match(
    qualificationReadme,
    /source quota is a canonical decimal integer from 1 through 64[\s\S]*ConfigMap quota from 1 through 192/,
  );
  assert.doesNotMatch(releaseTransaction, /\^\[1-9\]\[0-9\]\{0,8\}\$/);
});

test("release transaction validates state before staging immutable inputs", () => {
  const main = releaseTransaction.slice(
    releaseTransaction.indexOf(
      'target_release_id="$(runtime_release_id "$target_sha" "$runtime_inputs")"',
    ),
  );
  const initialize = main.slice(
    main.indexOf('if test "$mode" = initialize; then'),
    main.indexOf('if test "$mode" = bootstrap; then'),
  );
  const bootstrap = main.slice(
    main.indexOf('if test "$mode" = bootstrap; then'),
    main.indexOf('test "$target_release_phase" = r ||'),
  );
  const promote = main.slice(
    main.indexOf('test "$target_release_phase" = r ||'),
  );
  assert.ok(
    initialize.indexOf("existing qualification reconciliation") <
      initialize.indexOf("stage_release"),
  );
  assert.doesNotMatch(initialize, /verify_bootstrap_pointer/);
  assert.equal(initialize.match(/verify_initialization_pointer/g)?.length, 3);
  assert.ok(
    bootstrap.indexOf("verify_bootstrap_pointer") <
      bootstrap.indexOf("stage_release"),
  );
  assert.ok(
    promote.indexOf("normal promotion must preserve") <
      promote.indexOf("stage_release"),
  );
  assert.ok(
    promote.indexOf(
      'verify_kustomization_shape "$current_object" "$current_id" false',
    ) < promote.indexOf('if test "$current_id" = "$target_release_id"; then'),
  );
  assert.ok(
    promote.indexOf('if test "$current_id" = "$target_release_id"; then') <
      promote.indexOf("resume_active_promotion"),
  );
  assert.ok(
    promote.indexOf("distinct protected public commit SHA") <
      promote.lastIndexOf("stage_release"),
  );
  assert.match(
    initialize,
    /adopted exact initialization after an ambiguous create response/,
  );
  assert.match(releaseTransaction, /initialize RELEASE_SHA/);
  assert.match(
    releaseTransaction,
    /bootstrap ID[\s\S]*private operator rebootstrap is required/,
  );
});

test("release transaction derives admission anchors and requires the deploy GSA", () => {
  const exportFunction = releaseTransaction.match(
    /(export_admission_anchors\(\) \{[\s\S]*?\n\})\n\nrelease_phase\(\)/,
  )?.[1];
  assert.ok(exportFunction);
  const directory = mkdtempSync(join(tmpdir(), "meshr-admission-anchors-"));
  const runtimePath = join(directory, "runtime.json");
  writeFileSync(
    runtimePath,
    JSON.stringify({
      GCP_PROJECT_ID: "meshr-test-12345",
      MESHR_FIRESTORE_DATABASE: "meshr-authority",
      MESHR_TOPOLOGY_FIRESTORE_DATABASE: "meshr-topology",
      MESHR_EVENT_AUDIT_FIRESTORE_DATABASE: "meshr-audit",
      MESHR_NOTIFICATIONS_FIRESTORE_DATABASE: "meshr-notifications",
      MESHR_MODERATION_FIRESTORE_DATABASE: "meshr-moderation",
      MESHR_MODERATION_AUDIENCE: "https://moderation.example.test",
    }),
  );
  const command = `set -euo pipefail
${exportFunction}
export_admission_anchors "$1"
test "$GCP_PROJECT_ID" = meshr-test-12345
test "$MESHR_MODERATION_AUDIENCE" = https://moderation.example.test`;
  try {
    execFileSync("bash", ["-c", command, "bash", runtimePath], {
      env: {
        ...process.env,
        CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL:
          "meshr-ci-deploy@meshr-test-12345.iam.gserviceaccount.com",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    assert.throws(() =>
      execFileSync("bash", ["-c", command, "bash", runtimePath], {
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key !== "CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL",
          ),
        ),
        stdio: ["ignore", "ignore", "pipe"],
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release transaction accepts only the release-tagged Cloud Run adapter origin", () => {
  const directory = mkdtempSync(join(tmpdir(), "meshr-tagged-adapter-"));
  const releaseSha = "a".repeat(40);
  const revisionTag = `r-${releaseSha.slice(0, 20)}`;
  const stableOrigin =
    "https://meshr-moderation-adapter-123456789012.us-central1.run.app";
  const taggedOrigin = `https://${revisionTag}---${stableOrigin.slice("https://".length)}`;
  const imagePath = join(directory, "images.json");
  const runtimePath = join(directory, "runtime.json");
  const images = {
    API_IMAGE: `us-central1-docker.pkg.dev/meshr-test-12345/meshr/api@sha256:${"1".repeat(64)}`,
    EVENT_PLANE_IMAGE: `us-central1-docker.pkg.dev/meshr-test-12345/meshr/event-plane@sha256:${"2".repeat(64)}`,
    MODERATION_ADAPTER_IMAGE: `us-central1-docker.pkg.dev/meshr-test-12345/meshr/moderation-adapter@sha256:${"3".repeat(64)}`,
    WEB_IMAGE: `us-central1-docker.pkg.dev/meshr-test-12345/meshr/web@sha256:${"4".repeat(64)}`,
  };
  const runtime: Record<string, string> = {
    GCP_PROJECT_ID: "meshr-test-12345",
    MESHR_COST_PROTECTION_MODE: "normal",
    MESHR_CUTOVER_VALIDATION_AGENT_ID: "validation-agent",
    MESHR_CUTOVER_VALIDATION_BINDING_ID: "validation-binding",
    MESHR_CUTOVER_VALIDATION_MESH_ID: "validation-mesh",
    MESHR_CUTOVER_VALIDATION_SESSION_ID: "validation-session",
    MESHR_DATABASE_CUTOVER_MODE: "off",
    MESHR_EVENT_AUDIT_FIRESTORE_DATABASE: "meshr-audit",
    MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID: "authority-bootstrap-1",
    MESHR_FIRESTORE_DATABASE: "(default)",
    MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN: "0",
    MESHR_MODERATION_AUDIENCE: stableOrigin,
    MESHR_MODERATION_ENDPOINT: `${taggedOrigin}/screen`,
    MESHR_MODERATION_FIRESTORE_DATABASE: "meshr-moderation",
    MESHR_MODERATION_HEALTHCHECK_URL: `${taggedOrigin}/health`,
    MESHR_MODERATION_RELEASE_SHA: releaseSha,
    MESHR_MODERATION_REVISION_TAG: revisionTag,
    MESHR_NOTIFICATIONS_FIRESTORE_DATABASE: "meshr-notifications",
    MESHR_RELEASE_SHA: releaseSha,
    MESHR_TOPOLOGY_FIRESTORE_DATABASE: "meshr-projections",
  };
  const validate = (candidate: Record<string, string>) => {
    writeFileSync(runtimePath, JSON.stringify(candidate));
    return spawnSync(
      "bash",
      [
        join(
          fileURLToPath(root),
          "deploy/production-qualification/release-transaction.sh",
        ),
        "validate",
        releaseSha,
        imagePath,
        runtimePath,
      ],
      { encoding: "utf8" },
    );
  };
  writeFileSync(imagePath, JSON.stringify(images));
  try {
    assert.equal(validate(runtime).status, 0);
    const boundaryStableOrigin = stableOrigin.replace("https://", "https://x");
    const boundaryTaggedOrigin = taggedOrigin.replace("---", "---x");
    assert.equal(
      validate({
        ...runtime,
        MESHR_MODERATION_AUDIENCE: boundaryStableOrigin,
        MESHR_MODERATION_ENDPOINT: `${boundaryTaggedOrigin}/screen`,
        MESHR_MODERATION_HEALTHCHECK_URL: `${boundaryTaggedOrigin}/health`,
      }).status,
      0,
    );
    const rejected: Record<string, string>[] = [
      {
        ...runtime,
        MESHR_MODERATION_ENDPOINT: `${stableOrigin}/screen`,
        MESHR_MODERATION_HEALTHCHECK_URL: `${stableOrigin}/health`,
      },
      {
        ...runtime,
        MESHR_MODERATION_ENDPOINT: `https://r-${"b".repeat(20)}---${stableOrigin.slice("https://".length)}/screen`,
        MESHR_MODERATION_HEALTHCHECK_URL: `https://r-${"b".repeat(20)}---${stableOrigin.slice("https://".length)}/health`,
      },
      {
        ...runtime,
        MESHR_MODERATION_ENDPOINT: `${taggedOrigin.replace("meshr-moderation-adapter", "foreign-adapter")}/screen`,
        MESHR_MODERATION_HEALTHCHECK_URL: `${taggedOrigin.replace("meshr-moderation-adapter", "foreign-adapter")}/health`,
      },
      {
        ...runtime,
        MESHR_MODERATION_ENDPOINT: `${taggedOrigin}/screen?next=1`,
      },
      {
        ...runtime,
        MESHR_MODERATION_ENDPOINT:
          taggedOrigin.replace("https://", "https://user@") + "/screen",
      },
      {
        ...runtime,
        MESHR_MODERATION_ENDPOINT: `${taggedOrigin}:8443/screen`,
        MESHR_MODERATION_HEALTHCHECK_URL: `${taggedOrigin}:8443/health`,
      },
      { ...runtime, MESHR_MODERATION_AUDIENCE: `${stableOrigin}/` },
      { ...runtime, MESHR_MODERATION_AUDIENCE: `${stableOrigin}?alias=1` },
      {
        ...runtime,
        MESHR_MODERATION_AUDIENCE: stableOrigin.replace(
          "https://",
          "https://user@",
        ),
      },
      { ...runtime, MESHR_MODERATION_AUDIENCE: `${stableOrigin}:8443` },
      {
        ...runtime,
        MESHR_MODERATION_AUDIENCE: `https://${revisionTag}---${stableOrigin.slice("https://".length)}`,
      },
      {
        ...runtime,
        MESHR_MODERATION_AUDIENCE: stableOrigin.replace(
          "https://",
          "https://xx",
        ),
        MESHR_MODERATION_ENDPOINT: `${taggedOrigin.replace("---", "---xx")}/screen`,
        MESHR_MODERATION_HEALTHCHECK_URL: `${taggedOrigin.replace("---", "---xx")}/health`,
      },
      { ...runtime, MESHR_MODERATION_REVISION_TAG: `r-${"b".repeat(20)}` },
      { ...runtime, EXTRA_RUNTIME_KEY: "forbidden" },
    ];
    const missingTag = { ...runtime };
    delete missingTag.MESHR_MODERATION_REVISION_TAG;
    rejected.push(missingTag);
    for (const candidate of rejected)
      assert.notEqual(validate(candidate).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initialization adopts only the exact expected bootstrap pointer", () => {
  const initializationVerifier = releaseTransaction.match(
    /(verify_initialization_pointer\(\) \{[\s\S]*?\n\})\n\nquota_preflight\(\)/,
  )?.[1];
  assert.ok(initializationVerifier);

  const directory = mkdtempSync(join(tmpdir(), "meshr-initial-pointer-"));
  const bootstrapId = `b-${"0".repeat(40)}-${"a".repeat(12)}`;
  const readyId = `r-${"0".repeat(40)}-${"b".repeat(12)}`;
  const exactPath = join(directory, "exact.json");
  const partialPath = join(directory, "partial.json");
  writeFileSync(
    exactPath,
    JSON.stringify({
      metadata: {
        annotations: {
          "meshr.social/active-release-id": bootstrapId,
          "meshr.social/previous-release-id": bootstrapId,
          "meshr.social/transition-kind": "bootstrap",
        },
      },
    }),
  );
  writeFileSync(
    partialPath,
    JSON.stringify({
      metadata: {
        annotations: {
          "meshr.social/active-release-id": readyId,
          "meshr.social/previous-release-id": bootstrapId,
          "meshr.social/transition-kind": "bootstrap",
        },
      },
    }),
  );
  try {
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
verify_kustomization_shape() { return 0; }
${initializationVerifier}
verify_initialization_pointer "$1" "$3"
if verify_initialization_pointer "$2" "$3"; then exit 90; fi`,
        "bash",
        exactPath,
        partialPath,
        bootstrapId,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rollback markers reject every runtime variant of the failed commit", () => {
  const failedTargetGuard = releaseTransaction.match(
    /(verify_forward_target_not_failed\(\) \{[\s\S]*?\n\})\n\nruntime_release_id\(\)/,
  )?.[1];
  assert.ok(failedTargetGuard);
  const failedSha = "b".repeat(40);
  const laterSha = "c".repeat(40);
  const failedId = `r-${failedSha}-${"1".repeat(12)}`;
  const failedRuntimeVariantId = `r-${failedSha}-${"2".repeat(12)}`;
  const laterId = `r-${laterSha}-${"3".repeat(12)}`;
  execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
release_sha() { printf '%s\n' "$1" | cut -d- -f2; }
${failedTargetGuard}
if verify_forward_target_not_failed rollback "$2" "$1"; then exit 90; fi
verify_forward_target_not_failed rollback "$3" "$1"
verify_forward_target_not_failed forward "$2" "$1"`,
      "bash",
      failedId,
      failedRuntimeVariantId,
      laterId,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
});

test("promotion retry after process loss resumes the active CAS and rolls back on failure", () => {
  const resumeFunction = releaseTransaction.match(
    /(resume_active_promotion\(\) \{[\s\S]*?\n\})\n\nautomatic_rollback\(\)/,
  )?.[1];
  const rollbackFunction = releaseTransaction.match(
    /(automatic_rollback\(\) \{[\s\S]*?\n\})\n\nfinish\(\)/,
  )?.[1];
  assert.ok(resumeFunction);
  assert.ok(rollbackFunction);

  const directory = mkdtempSync(join(tmpdir(), "meshr-resume-after-cas-"));
  const previousSha = "a".repeat(40);
  const targetSha = "b".repeat(40);
  const previousId = "r-" + previousSha + "-" + "1".repeat(12);
  const targetId = "r-" + targetSha + "-" + "2".repeat(12);
  const currentPath = join(directory, "current.json");
  const rollbackPath = join(directory, "rollback.json");
  const runtimePath = join(directory, "runtime.json");
  writeFileSync(
    currentPath,
    JSON.stringify({
      metadata: {
        annotations: {
          "meshr.social/active-release-id": targetId,
          "meshr.social/previous-release-id": previousId,
          "meshr.social/transition-kind": "forward",
        },
      },
      spec: { release: targetId },
    }),
  );
  writeFileSync(
    rollbackPath,
    JSON.stringify({
      metadata: {
        annotations: {
          "meshr.social/active-release-id": previousId,
          "meshr.social/previous-release-id": targetId,
          "meshr.social/transition-kind": "rollback",
        },
      },
      spec: { release: previousId },
    }),
  );
  writeFileSync(
    runtimePath,
    JSON.stringify({
      MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID: "authority-bootstrap-1",
    }),
  );
  try {
    const output = execFileSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          'release_phase() { printf "%s\\n" "$1" | cut -d- -f1; }',
          'release_sha() { printf "%s\\n" "$1" | cut -d- -f2; }',
          'verify_kustomization_shape() { test "$3" != true; }',
          "kustomization_is_ready_for_release() { return 1; }",
          'verify_release_by_id() { test "$1" = "$previous_id"; }',
          "api_get() {",
          '  if test "$1" = configmap; then',
          '    printf \'{"data":{"MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID":"authority-bootstrap-1"}}\\n\' >"$3"',
          "  else",
          '    cp "$current_state" "$3"',
          "  fi",
          "}",
          "render_kustomization() {",
          '  jq -n --arg release "$2" \'{metadata:{annotations:{"meshr.social/active-release-id":$release,"meshr.social/previous-release-id":$release,"meshr.social/transition-kind":"bootstrap"}},spec:{release:$release}}\' >"$3"',
          "}",
          "stage_release() {",
          '  test "$1" = "$target_sha"',
          '  staged_release_id="$target_release_id"',
          "}",
          "wait_for_source() { return 0; }",
          'wait_for_kustomization() { test "$1" != "$target_release_id"; }',
          "apply_switch() {",
          '  test "$3" = "$previous_id"',
          '  test "$4" = "$target_release_id"',
          '  test "$5" = rollback',
          '  cp "$rollback_fixture" "$current_state"',
          "}",
          resumeFunction,
          rollbackFunction,
          'temporary_directory="$1"',
          'current_state="$2"',
          'rollback_fixture="$3"',
          'target_sha="$4"',
          'runtime_inputs="$5"',
          'target_release_id="$6"',
          'previous_id="$7"',
          "image_inputs=/unused/images.json",
          "transaction_armed=false",
          "transaction_complete=false",
          "transaction_target_id=",
          "transaction_previous_id=",
          "transaction_previous_object=",
          "transaction_target_object=",
          "staged_release_id=",
          "transaction_succeeded_during_recovery=false",
          "switch_skipped_ready=false",
          "namespace=flux-system",
          "kustomization_name=meshr-production-qualification",
          'if resume_active_promotion "$current_state" "$target_release_id" "$target_sha" "$image_inputs" "$runtime_inputs"; then exit 90; fi',
          'test "$transaction_armed" = true',
          'test "$transaction_complete" = false',
          "automatic_rollback 2>/dev/null",
          'jq -e --arg active "$previous_id" --arg previous "$target_release_id" \'.metadata.annotations["meshr.social/active-release-id"] == $active and .metadata.annotations["meshr.social/previous-release-id"] == $previous and .metadata.annotations["meshr.social/transition-kind"] == "rollback"\' "$current_state"',
        ].join("\n"),
        "bash",
        directory,
        currentPath,
        rollbackPath,
        targetSha,
        runtimePath,
        targetId,
        previousId,
      ],
      { encoding: "utf8" },
    );
    assert.match(output, /true/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("automatic rollback preserves a target that becomes Ready during CAS recovery", () => {
  const readinessFunction = releaseTransaction.match(
    /(kustomization_is_ready_for_release\(\) \{[\s\S]*?\n\})\n\nwait_for_kustomization\(\)/,
  )?.[1];
  const patchFunction = releaseTransaction.match(
    /(make_switch_patch\(\) \{[\s\S]*?\n\})\n\napply_switch\(\)/,
  )?.[1];
  const switchFunction = releaseTransaction.match(
    /(apply_switch\(\) \{[\s\S]*?\n\})\n\nverify_release_by_id\(\)/,
  )?.[1];
  const rollbackFunction = releaseTransaction.match(
    /(automatic_rollback\(\) \{[\s\S]*?\n\})\n\nfinish\(\)/,
  )?.[1];
  assert.ok(readinessFunction);
  assert.ok(patchFunction);
  assert.ok(switchFunction);
  assert.ok(rollbackFunction);

  const directory = mkdtempSync(join(tmpdir(), "meshr-ready-during-rollback-"));
  const previousSha = "a".repeat(40);
  const targetSha = "b".repeat(40);
  const previousId = `r-${previousSha}-${"1".repeat(12)}`;
  const targetId = `r-${targetSha}-${"2".repeat(12)}`;
  const currentPath = join(directory, "current.json");
  const readyPath = join(directory, "ready.json");
  const previousPath = join(directory, "previous.json");
  const rollbackTargetPath = join(directory, "rollback-target.json");
  const patchCountPath = join(directory, "patch-count");
  const makeTarget = (ready: boolean) => ({
    metadata: {
      resourceVersion: ready ? "2" : "1",
      generation: 7,
      annotations: {
        "meshr.social/active-release-id": targetId,
        "meshr.social/previous-release-id": previousId,
        "meshr.social/transition-kind": "forward",
      },
    },
    spec: { release: targetId },
    status: {
      observedGeneration: ready ? 7 : 6,
      lastAppliedRevision: ready
        ? `main@sha1:${targetSha}`
        : `main@sha1:${previousSha}`,
      conditions: [
        {
          type: "Ready",
          status: ready ? "True" : "False",
          observedGeneration: ready ? 7 : 6,
        },
      ],
    },
  });
  writeFileSync(currentPath, JSON.stringify(makeTarget(false)));
  writeFileSync(readyPath, JSON.stringify(makeTarget(true)));
  writeFileSync(
    previousPath,
    JSON.stringify({
      metadata: {
        resourceVersion: "0",
        generation: 6,
        annotations: {
          "meshr.social/active-release-id": previousId,
          "meshr.social/previous-release-id": `r-${"c".repeat(40)}-${"3".repeat(12)}`,
          "meshr.social/transition-kind": "forward",
        },
      },
      spec: { release: previousId },
    }),
  );
  writeFileSync(
    rollbackTargetPath,
    JSON.stringify({ spec: { release: previousId } }),
  );
  writeFileSync(patchCountPath, "0\n");

  try {
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
release_phase() { printf 'r\\n'; }
release_sha() { printf '%s\\n' "$(printf '%s' "$1" | cut -d- -f2)"; }
verify_release_by_id() { test "$1" = "$transaction_previous_id"; }
verify_kustomization_shape() {
  test "$2" = "$transaction_target_id" && test "$3" = false && test "$4" = forward
}
api_get() { cp "$current_state" "$3"; }
render_kustomization() { cp "$rollback_fixture" "$3"; }
wait_for_kustomization() { return 0; }
kubectl() {
  count="$(cat "$patch_count")"
  count=$((count + 1))
  printf '%s\\n' "$count" >"$patch_count"
  cp "$ready_fixture" "$current_state"
  return 1
}
${readinessFunction}
${patchFunction}
${switchFunction}
${rollbackFunction}
temporary_directory="$1"
current_state="$2"
ready_fixture="$3"
rollback_fixture="$4"
patch_count="$5"
transaction_previous_object="$6"
transaction_target_object="$2"
transaction_previous_id="$7"
transaction_target_id="$8"
transaction_complete=false
transaction_succeeded_during_recovery=false
switch_skipped_ready=false
namespace=flux-system
kustomization_name=meshr-production-qualification
automatic_rollback
test "$switch_skipped_ready" = true
test "$transaction_succeeded_during_recovery" = true
test "$transaction_complete" = true
test "$(cat "$patch_count")" -eq 1
jq -e --arg active "$transaction_target_id" '
  .metadata.annotations["meshr.social/active-release-id"] == $active and
  .metadata.annotations["meshr.social/transition-kind"] == "forward"
' "$current_state" >/dev/null`,
        "bash",
        directory,
        currentPath,
        readyPath,
        rollbackTargetPath,
        patchCountPath,
        previousPath,
        previousId,
        targetId,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancellation forces rollback of a Ready target and preserves signal status", () => {
  const rollbackFunction = releaseTransaction.match(
    /(automatic_rollback\(\) \{[\s\S]*?\n\})\n\nfinish\(\)/,
  )?.[1];
  const finishFunction = releaseTransaction.match(
    /(finish\(\) \{[\s\S]*?\n\})\n\ncancel_transaction\(\)/,
  )?.[1];
  const cancelFunction = releaseTransaction.match(
    /(cancel_transaction\(\) \{[\s\S]*?\n\})\n\ntrap finish/,
  )?.[1];
  assert.ok(rollbackFunction);
  assert.ok(finishFunction);
  assert.ok(cancelFunction);
  assert.match(releaseTransaction, /trap 'cancel_transaction 130' INT/);
  assert.match(releaseTransaction, /trap 'cancel_transaction 143' TERM/);

  const parentDirectory = mkdtempSync(join(tmpdir(), "meshr-cancel-rollback-"));
  const previousSha = "a".repeat(40);
  const targetSha = "b".repeat(40);
  const previousId = `r-${previousSha}-${"1".repeat(12)}`;
  const targetId = `r-${targetSha}-${"2".repeat(12)}`;
  try {
    for (const signalStatus of [130, 143]) {
      const directory = mkdtempSync(join(parentDirectory, "transaction-"));
      const currentPath = join(directory, "current.json");
      const previousPath = join(directory, "previous.json");
      const markerPath = `${directory}.forced-${signalStatus}`;
      writeFileSync(
        currentPath,
        JSON.stringify({
          metadata: {
            annotations: {
              "meshr.social/active-release-id": targetId,
              "meshr.social/previous-release-id": previousId,
              "meshr.social/transition-kind": "forward",
            },
          },
          spec: { release: targetId },
        }),
      );
      writeFileSync(
        previousPath,
        JSON.stringify({
          metadata: {
            annotations: {
              "meshr.social/active-release-id": previousId,
              "meshr.social/previous-release-id": previousId,
              "meshr.social/transition-kind": "forward",
            },
          },
          spec: { release: previousId },
        }),
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail
release_phase() { printf 'r\n'; }
release_sha() { printf '%s\n' "$1" | cut -d- -f2; }
verify_release_by_id() { test "$1" = "$transaction_previous_id"; }
api_get() { cp "$current_state" "$3"; }
verify_kustomization_shape() { return 0; }
kustomization_is_ready_for_release() { return 0; }
render_kustomization() { printf '{}\n' >"$3"; }
apply_switch() {
  test "$3" = "$transaction_previous_id"
  test "$4" = "$transaction_target_id"
  test "$5" = rollback
  test -z "\${6:-}"
  printf 'forced rollback\n' >"$marker"
}
wait_for_kustomization() {
  test "$1" = "$transaction_previous_id" && test "$2" = rollback
}
${rollbackFunction}
${finishFunction}
${cancelFunction}
temporary_directory="$1"
current_state="$2"
transaction_previous_object="$3"
transaction_target_object="$2"
transaction_previous_id="$4"
transaction_target_id="$5"
transaction_armed=true
transaction_complete=false
transaction_succeeded_during_recovery=false
transaction_cancelled=false
transaction_cancel_status=
switch_skipped_ready=false
namespace=flux-system
kustomization_name=meshr-production-qualification
marker="$6"
trap finish EXIT
cancel_transaction "$7"`,
          "bash",
          directory,
          currentPath,
          previousPath,
          previousId,
          targetId,
          markerPath,
          String(signalStatus),
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, signalStatus);
      assert.equal(readFileSync(markerPath, "utf8"), "forced rollback\n");
    }
  } finally {
    rmSync(parentDirectory, { recursive: true, force: true });
  }
});

test("release tuple rendering is exact without envsubst", () => {
  const kustomizationRenderer = releaseTransaction.match(
    /(render_kustomization\(\) \{[\s\S]*?\n\})\n\nmake_release_objects\(\)/,
  )?.[1];
  assert.ok(kustomizationRenderer);
  assert.doesNotMatch(releaseTransaction, /\benvsubst\b/);
  const directory = mkdtempSync(join(tmpdir(), "meshr-awk-renderer-"));
  const outputPath = join(directory, "rendered.yaml");
  const targetSha = "a".repeat(40);
  const targetId = `r-${targetSha}-${"b".repeat(12)}`;
  try {
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
kubectl() {
  test "$1" = create && test "$2" = --dry-run=client
  test "$3" = -o && test "$4" = json && test "$5" = -f
  command cat "$6"
}
${kustomizationRenderer}
temporary_directory="$1"
script_directory="$2"
render_kustomization "$3" "$4" "$5"`,
        "bash",
        directory,
        fileURLToPath(
          new URL("../deploy/production-qualification/", import.meta.url),
        ),
        targetSha,
        targetId,
        outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const rendered = parseYaml(readFileSync(outputPath, "utf8"));
    assert.equal(
      rendered.metadata.annotations["meshr.social/active-release-id"],
      targetId,
    );
    assert.equal(
      rendered.metadata.annotations["meshr.social/previous-release-id"],
      targetId,
    );
    assert.equal(rendered.spec.sourceRef.name, `meshr-pq-source-${targetSha}`);
    assert.equal(
      rendered.spec.postBuild.substituteFrom[0].name,
      `meshr-pq-images-${targetSha}`,
    );
    assert.equal(
      rendered.spec.postBuild.substituteFrom[1].name,
      `meshr-r-${targetId}`,
    );
    assert.doesNotMatch(readFileSync(outputPath, "utf8"), /\$\{/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release transaction cannot mask verifier or rollback failures", () => {
  const automaticRollback = releaseTransaction.match(
    /(automatic_rollback\(\) \{[\s\S]*?\n\})\n\nfinish\(\)/,
  )?.[1];
  const kustomizationRenderer = releaseTransaction.match(
    /(render_kustomization\(\) \{[\s\S]*?\n\})\n\nmake_release_objects\(\)/,
  )?.[1];
  const releaseObjectRenderer = releaseTransaction.match(
    /(make_release_objects\(\) \{[\s\S]*?\n\})\n\nverify_source_object\(\)/,
  )?.[1];
  const bootstrapVerifier = releaseTransaction.match(
    /(verify_bootstrap_pointer\(\) \{[\s\S]*?\n\})\n\nverify_initialization_pointer\(\)/,
  )?.[1];
  assert.ok(automaticRollback);
  assert.ok(kustomizationRenderer);
  assert.ok(releaseObjectRenderer);
  assert.ok(bootstrapVerifier);

  const kustomizationDirectory = mkdtempSync(
    join(tmpdir(), "meshr-kustomization-renderer-"),
  );
  try {
    writeFileSync(
      join(kustomizationDirectory, "flux.yaml"),
      "apiVersion: v1\nkind: ConfigMap\n---\napiVersion: kustomize.toolkit.fluxcd.io/v1\nkind: Kustomization\nmetadata:\n  name: test\n",
    );
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
grep_calls=0
grep() {
  grep_calls=$((grep_calls + 1))
  if test "$grep_calls" -le 2; then return 0; fi
  return 2
}
kubectl() { printf '{}\\n'; }
${kustomizationRenderer}
temporary_directory="$1"
script_directory="$1"
if render_kustomization "$2" "$3" "$4"; then exit 92; fi`,
        "bash",
        kustomizationDirectory,
        "0".repeat(40),
        `r-${"0".repeat(40)}-${"a".repeat(12)}`,
        join(kustomizationDirectory, "rendered.json"),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } finally {
    rmSync(kustomizationDirectory, { recursive: true, force: true });
  }

  const rendererDirectory = mkdtempSync(
    join(tmpdir(), "meshr-release-renderer-"),
  );
  try {
    const imagesPath = join(rendererDirectory, "images.json");
    const runtimePath = join(rendererDirectory, "runtime.json");
    const sourcePath = join(rendererDirectory, "source.json");
    const imageOutputPath = join(rendererDirectory, "images-output.json");
    const runtimeOutputPath = join(rendererDirectory, "runtime-output.json");
    writeFileSync(imagesPath, "{}\n");
    writeFileSync(runtimePath, "{}\n");
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
${releaseObjectRenderer}
make_release_objects "$1" "$2" "$3" "$4" "$5" "$6" "$7"`,
        "bash",
        "0".repeat(40),
        `r-${"0".repeat(40)}-${"a".repeat(12)}`,
        imagesPath,
        runtimePath,
        sourcePath,
        imageOutputPath,
        runtimeOutputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const renderedSource = JSON.parse(readFileSync(sourcePath, "utf8"));
    assert.equal(renderedSource.spec.interval, "24h");
    assert.equal(renderedSource.spec.timeout, "5m");
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
jq_calls=0
jq() {
  jq_calls=$((jq_calls + 1))
  if test "$jq_calls" -eq 1; then return 1; fi
  command jq "$@"
}
${releaseObjectRenderer}
if make_release_objects "$1" "$2" "$3" "$4" "$5" "$6" "$7"; then
  exit 90
fi`,
        "bash",
        "0".repeat(40),
        `r-${"0".repeat(40)}-${"a".repeat(12)}`,
        imagesPath,
        runtimePath,
        sourcePath,
        imageOutputPath,
        runtimeOutputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } finally {
    rmSync(rendererDirectory, { recursive: true, force: true });
  }

  const rollbackOutput = execFileSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
release_phase() { printf 'r\\n'; }
verify_release_by_id() { return 1; }
api_get() { return 0; }
wait_for_kustomization() { return 0; }
render_kustomization() { return 0; }
apply_switch() { return 0; }
${automaticRollback}
temporary_directory=/tmp
transaction_previous_id=r-${"0".repeat(40)}-${"a".repeat(12)}
transaction_target_id=r-${"f".repeat(40)}-${"b".repeat(12)}
transaction_previous_object=/tmp/unused
transaction_target_object=/tmp/unused
if automatic_rollback; then exit 88; fi`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.doesNotMatch(rollbackOutput, /restored qualification release pointer/);

  const directory = mkdtempSync(join(tmpdir(), "meshr-bootstrap-verifier-"));
  try {
    const bootstrapId = `b-${"0".repeat(40)}-${"a".repeat(12)}`;
    const objectPath = join(directory, "kustomization.json");
    writeFileSync(
      objectPath,
      JSON.stringify({
        metadata: {
          annotations: {
            "meshr.social/active-release-id": bootstrapId,
            "meshr.social/previous-release-id": bootstrapId,
            "meshr.social/transition-kind": "bootstrap",
          },
        },
      }),
    );
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
release_sha() { printf '${"0".repeat(40)}\\n'; }
verify_kustomization_shape() { return 1; }
${bootstrapVerifier}
if verify_bootstrap_pointer "$1" "$2"; then exit 89; fi`,
        "bash",
        objectPath,
        bootstrapId,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("initialization refuses unknown retained inventory without cleanup", () => {
  const quotaPreflight = releaseTransaction.match(
    /(quota_preflight\(\) \{[\s\S]*?\n\})\n\ncreate_or_verify_source\(\)/,
  )?.[1];
  assert.ok(quotaPreflight);
  assert.doesNotMatch(releaseTransaction, /\bdelete\b/);

  const directory = mkdtempSync(join(tmpdir(), "meshr-quota-inventory-"));
  const targetSha = "0".repeat(40);
  const targetReleaseId = `b-${targetSha}-${"a".repeat(12)}`;
  const runInventory = (
    name: string,
    sourceNames: string[],
    configMapNames: string[],
    kustomizationCount: number,
    expectedToPass = false,
    authoritativeQuota = true,
    sourceLimit = "17",
    configMapLimit = "43",
  ): void => {
    const hard = {
      "count/configmaps": configMapLimit,
      "count/gitrepositories.source.toolkit.fluxcd.io": sourceLimit,
      "count/kustomizations.kustomize.toolkit.fluxcd.io": "1",
    };
    const quotaPath = join(directory, `${name}-quota.json`);
    const sourcesPath = join(directory, `${name}-sources.json`);
    const configMapsPath = join(directory, `${name}-configmaps.json`);
    writeFileSync(
      quotaPath,
      JSON.stringify({
        spec: { hard },
        status: {
          hard: authoritativeQuota ? hard : {},
          used: authoritativeQuota
            ? {
                "count/configmaps": String(configMapNames.length),
                "count/gitrepositories.source.toolkit.fluxcd.io": String(
                  sourceNames.length,
                ),
                "count/kustomizations.kustomize.toolkit.fluxcd.io":
                  String(kustomizationCount),
              }
            : {},
        },
      }),
    );
    writeFileSync(
      sourcesPath,
      JSON.stringify({
        items: sourceNames.map((itemName) => ({
          metadata: { name: itemName },
        })),
      }),
    );
    writeFileSync(
      configMapsPath,
      JSON.stringify({
        items: configMapNames.map((itemName) => ({
          metadata: { name: itemName },
        })),
      }),
    );
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
quota_fixture="$3"
sources_fixture="$4"
configmaps_fixture="$5"
api_get() {
  if test "$1" = resourcequota; then
    command cp "$quota_fixture" "$3"
    return
  fi
  return 1
}
kubectl() {
  case "$*" in
    *"get gitrepositories.source.toolkit.fluxcd.io"*)
      command cat "$sources_fixture"
      ;;
    *"get configmaps"*)
      command cat "$configmaps_fixture"
      ;;
    *) return 97 ;;
  esac
}
${quotaPreflight}
temporary_directory="$6"
namespace=flux-system
quota_name=meshr-production-qualification-releases
kustomization_name=meshr-production-qualification
wait_attempts=1
${
  expectedToPass
    ? 'quota_preflight "$1" "$2"'
    : 'if quota_preflight "$1" "$2"; then exit 91; fi'
}`,
        "bash",
        targetSha,
        targetReleaseId,
        quotaPath,
        sourcesPath,
        configMapsPath,
        directory,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  };

  try {
    runInventory("canonical", [], ["kube-root-ca.crt"], 0, true);
    runInventory(
      "bounded-maxima",
      [],
      ["kube-root-ca.crt"],
      0,
      true,
      true,
      "64",
      "192",
    );
    runInventory(
      "source-too-large",
      [],
      ["kube-root-ca.crt"],
      0,
      false,
      true,
      "65",
      "192",
    );
    runInventory(
      "configmap-too-large",
      [],
      ["kube-root-ca.crt"],
      0,
      false,
      true,
      "64",
      "193",
    );
    runInventory(
      "limit-1000",
      [],
      ["kube-root-ca.crt"],
      0,
      false,
      true,
      "1000",
    );
    runInventory("limit-1k", [], ["kube-root-ca.crt"], 0, false, true, "1k");
    runInventory("quota-not-ready", [], ["kube-root-ca.crt"], 0, false, false);
    runInventory("source", ["legacy-source"], ["kube-root-ca.crt"], 0);
    runInventory("configmap", [], ["kube-root-ca.crt", "legacy-config"], 0);
    runInventory("kustomization", [], ["kube-root-ca.crt"], 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("release verification rejects terminating immutable objects", () => {
  const sourceVerifier = releaseTransaction.match(
    /(verify_source_object\(\) \{[\s\S]*?\n\})\n\nverify_configmap_object\(\)/,
  )?.[1];
  const configMapVerifier = releaseTransaction.match(
    /(verify_configmap_object\(\) \{[\s\S]*?\n\})\n\nverify_bootstrap_pointer\(\)/,
  )?.[1];
  const kustomizationVerifier = releaseTransaction.match(
    /(verify_kustomization_shape\(\) \{[\s\S]*?\n\})\n\nwait_for_kustomization\(\)/,
  )?.[1];
  assert.ok(sourceVerifier);
  assert.ok(configMapVerifier);
  assert.ok(kustomizationVerifier);

  const directory = mkdtempSync(join(tmpdir(), "meshr-terminating-release-"));
  const sha = "0".repeat(40);
  const releaseId = `r-${sha}-${"a".repeat(12)}`;
  const deletionTimestamp = "2026-08-31T20:00:00Z";
  const sourceExpected = {
    apiVersion: "source.toolkit.fluxcd.io/v1",
    kind: "GitRepository",
    metadata: { name: `meshr-pq-source-${sha}`, namespace: "flux-system" },
    spec: { ref: { branch: "main", commit: sha } },
  };
  const configMapExpected = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: `meshr-r-${releaseId}`, namespace: "flux-system" },
    immutable: true,
    data: { MESHR_RELEASE_SHA: sha },
  };
  const kustomizationExpected = { spec: {} };
  const kustomizationActual = {
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    kind: "Kustomization",
    metadata: {
      name: "meshr-production-qualification",
      namespace: "flux-system",
      deletionTimestamp,
      annotations: {
        "meshr.social/active-release-id": releaseId,
        "meshr.social/previous-release-id": releaseId,
        "meshr.social/transition-kind": "bootstrap",
      },
    },
    spec: {},
  };
  const fixtures = [
    sourceExpected,
    {
      ...sourceExpected,
      metadata: { ...sourceExpected.metadata, deletionTimestamp },
    },
    configMapExpected,
    {
      ...configMapExpected,
      metadata: { ...configMapExpected.metadata, deletionTimestamp },
    },
    kustomizationExpected,
    kustomizationActual,
  ].map((fixture, index) => {
    const path = join(directory, `${index}.json`);
    writeFileSync(path, JSON.stringify(fixture));
    return path;
  });

  try {
    execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
kustomization_expected="$5"
sha="$8"
release_id="$9"
${sourceVerifier}
${configMapVerifier}
${kustomizationVerifier}
release_sha() { printf '%s\\n' "$sha"; }
render_kustomization() { command cp "$kustomization_expected" "$3"; }
temporary_directory="$7"
if verify_source_object "$2" "$1"; then exit 93; fi
if verify_configmap_object "$4" "$3"; then exit 94; fi
if verify_kustomization_shape "$6" "$release_id" false; then exit 95; fi`,
        "bash",
        fixtures[0],
        fixtures[1],
        fixtures[2],
        fixtures[3],
        fixtures[4],
        fixtures[5],
        directory,
        sha,
        releaseId,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("qualification reconciliation atomically switches immutable release tuples", () => {
  const resources = parseAllDocuments(fluxBootstrap).map((document) =>
    document.toJS(),
  );
  const name = "meshr-production-qualification-reconciliation.meshr.social";
  const policy = resources.find(
    (resource) =>
      resource.kind === "ValidatingAdmissionPolicy" &&
      resource.metadata.name === name,
  );
  const binding = resources.find(
    (resource) =>
      resource.kind === "ValidatingAdmissionPolicyBinding" &&
      resource.metadata.name === name,
  );
  assert.ok(policy, "missing qualification reconciliation admission policy");
  assert.ok(binding, "missing qualification reconciliation policy binding");
  assert.equal(policy.spec.failurePolicy, "Fail");
  assert.deepEqual(policy.spec.matchConstraints.resourceRules, [
    {
      apiGroups: ["kustomize.toolkit.fluxcd.io"],
      apiVersions: ["v1"],
      operations: ["CREATE", "UPDATE"],
      resources: ["kustomizations"],
      scope: "Namespaced",
    },
  ]);
  assert.match(
    policy.spec.matchConditions[0].expression,
    /namespace == 'flux-system'.*name == 'meshr-production-qualification'/s,
  );
  const expressions = policy.spec.validations
    .map((validation: { expression: string }) => validation.expression)
    .join("\n");
  for (const invariant of [
    "object.spec.interval == '1m'",
    "object.spec.path == './deploy/production-qualification'",
    "object.spec.targetNamespace == 'meshr'",
    "object.spec.prune == true",
    "object.spec.force == false",
    "!has(object.spec.serviceAccountName)",
    "has(object.spec.suspend)",
    "object.spec.suspend == false",
    "object.spec.wait == false",
    "object.spec.timeout == '15m'",
    "object.spec.sourceRef.kind == 'GitRepository'",
    "^meshr-pq-source-[a-f0-9]{40}$",
    "^meshr-pq-images-[a-f0-9]{40}$",
    "^meshr-r-[br]-[a-f0-9]{40}-[a-f0-9]{12}$",
    "object.spec.sourceRef.name.split('-')[3]",
    "object.spec.postBuild.substitute.MESHR_YAML_QUOTE == '\"'",
    "object.spec.postBuild.substituteStrategy == 'WithVariables'",
    "object.spec.postBuild.substituteFrom.size() == 2",
    "object.spec == oldObject.spec",
    "oldObject.status.observedGeneration == oldObject.metadata.generation",
    "oldObject.status.conditions.exists(condition",
    "oldObject.status.lastAppliedRevision",
    "meshr.social/transition-kind",
    "system:serviceaccount:flux-system:kustomize-controller",
    "${CONNECT_GATEWAY_DEPLOY_SERVICE_ACCOUNT_EMAIL}",
  ]) {
    assert.ok(expressions.includes(invariant), `missing ${invariant}`);
  }
  for (const healthCheck of [
    "production-store-bootstrap",
    "api",
    "live-gateway",
    "web",
    "ingest",
    "topology-materializer",
    "moderation-worker",
    "moderation-screening-worker",
    "audit-worker",
    "notification-worker",
  ]) {
    assert.ok(expressions.includes(healthCheck), `missing ${healthCheck}`);
  }
  for (const forbidden of [
    "buildMetadata",
    "commonMetadata",
    "components",
    "decryption",
    "deletionPolicy",
    "dependsOn",
    "healthCheckExprs",
    "ignore",
    "ignoreMissingComponents",
    "images",
    "kubeConfig",
    "namePrefix",
    "nameSuffix",
    "patches",
    "retryInterval",
  ]) {
    assert.ok(
      expressions.includes(`!has(object.spec.${forbidden})`),
      `admission policy does not reject ${forbidden}`,
    );
  }
  for (const metadataField of [
    "annotations",
    "labels",
    "ownerReferences",
    "finalizers",
  ])
    assert.ok(expressions.includes(`object.metadata.${metadataField}`));
  assert.equal(binding.spec.policyName, name);
  assert.deepEqual(binding.spec.validationActions, ["Deny"]);
  assert.deepEqual(binding.spec.matchResources.namespaceSelector.matchLabels, {
    "kubernetes.io/metadata.name": "flux-system",
  });

  const parsed = parseAllDocuments(flux)
    .map((document) => document.toJS())
    .find((resource) => resource.kind === "Kustomization");
  const controller = "system:serviceaccount:flux-system:kustomize-controller";
  const deployer = "meshr-ci-deploy@example.iam.gserviceaccount.com";
  const currentSha = "0".repeat(40);
  const nextSha = "f".repeat(40);
  const bootstrapId = `b-${currentSha}-${"a".repeat(12)}`;
  const currentId = `r-${currentSha}-${"b".repeat(12)}`;
  const repairedId = `r-${currentSha}-${"c".repeat(12)}`;
  const nextId = `r-${nextSha}-${"d".repeat(12)}`;
  const releasePattern = /^[br]-[a-f0-9]{40}-[a-f0-9]{12}$/;
  const makeObject = (
    activeId: string,
    previousId: string,
    ready: boolean,
    transitionKind: "bootstrap" | "forward" | "rollback" = "forward",
  ): Record<string, any> => {
    const sha = activeId.split("-")[1]!;
    const spec = JSON.parse(JSON.stringify(parsed.spec));
    spec.sourceRef.name = `meshr-pq-source-${sha}`;
    spec.postBuild.substituteFrom[0].name = `meshr-pq-images-${sha}`;
    spec.postBuild.substituteFrom[1].name = `meshr-r-${activeId}`;
    return {
      metadata: {
        name: "meshr-production-qualification",
        namespace: "flux-system",
        generation: 7,
        annotations: {
          "meshr.social/active-release-id": activeId,
          "meshr.social/previous-release-id": previousId,
          "meshr.social/transition-kind": transitionKind,
        },
      },
      spec,
      status: {
        observedGeneration: ready ? 7 : 6,
        lastAppliedRevision: ready
          ? `main@sha1:${sha}`
          : `main@sha1:${"e".repeat(40)}`,
        conditions: [
          {
            type: "Ready",
            status: ready ? "True" : "False",
            observedGeneration: ready ? 7 : 6,
          },
        ],
      },
    };
  };
  const metadataIsCanonical = (metadata: Record<string, any>): boolean => {
    const annotations = metadata.annotations;
    return (
      metadata.name === "meshr-production-qualification" &&
      metadata.namespace === "flux-system" &&
      annotations !== undefined &&
      Object.keys(annotations).sort().join(",") ===
        "meshr.social/active-release-id,meshr.social/previous-release-id,meshr.social/transition-kind" &&
      releasePattern.test(annotations["meshr.social/active-release-id"]) &&
      releasePattern.test(annotations["meshr.social/previous-release-id"]) &&
      ["bootstrap", "forward", "rollback"].includes(
        annotations["meshr.social/transition-kind"],
      ) &&
      metadata.labels === undefined &&
      metadata.ownerReferences === undefined &&
      (metadata.finalizers === undefined ||
        isDeepStrictEqual(metadata.finalizers, ["finalizers.fluxcd.io"]))
    );
  };
  const specIsCanonical = (
    spec: Record<string, any>,
    metadata: Record<string, any>,
  ): boolean => {
    const candidate = JSON.parse(JSON.stringify(spec));
    const sourceName = candidate.sourceRef?.name;
    const imageName = candidate.postBuild?.substituteFrom?.[0]?.name;
    const runtimeName = candidate.postBuild?.substituteFrom?.[1]?.name;
    const activeId = metadata.annotations?.["meshr.social/active-release-id"];
    if (
      typeof sourceName !== "string" ||
      typeof imageName !== "string" ||
      typeof runtimeName !== "string" ||
      typeof activeId !== "string" ||
      !/^meshr-pq-source-[a-f0-9]{40}$/.test(sourceName) ||
      !/^meshr-pq-images-[a-f0-9]{40}$/.test(imageName) ||
      !/^meshr-r-[br]-[a-f0-9]{40}-[a-f0-9]{12}$/.test(runtimeName)
    )
      return false;
    const sha = sourceName.slice("meshr-pq-source-".length);
    if (
      !imageName.endsWith(sha) ||
      runtimeName !== `meshr-r-${activeId}` ||
      activeId.split("-")[1] !== sha
    )
      return false;
    candidate.sourceRef.name = parsed.spec.sourceRef.name;
    candidate.postBuild.substituteFrom[0].name =
      parsed.spec.postBuild.substituteFrom[0].name;
    candidate.postBuild.substituteFrom[1].name =
      parsed.spec.postBuild.substituteFrom[1].name;
    return isDeepStrictEqual(candidate, parsed.spec);
  };
  const admitted = (
    oldObject: Record<string, any>,
    object: Record<string, any>,
    username: string,
  ): boolean => {
    if (
      !specIsCanonical(object.spec, object.metadata) ||
      !metadataIsCanonical(object.metadata)
    )
      return false;
    const oldActive =
      oldObject.metadata.annotations["meshr.social/active-release-id"];
    const oldPrevious =
      oldObject.metadata.annotations["meshr.social/previous-release-id"];
    const active =
      object.metadata.annotations["meshr.social/active-release-id"];
    const previous =
      object.metadata.annotations["meshr.social/previous-release-id"];
    const oldTransition =
      oldObject.metadata.annotations["meshr.social/transition-kind"];
    const transition =
      object.metadata.annotations["meshr.social/transition-kind"];
    if (username === controller)
      return (
        isDeepStrictEqual(object.spec, oldObject.spec) &&
        isDeepStrictEqual(
          object.metadata.annotations,
          oldObject.metadata.annotations,
        )
      );
    if (username !== deployer || active === oldActive) return false;
    const oldSha = oldActive.split("-")[1];
    const activeSha = active.split("-")[1];
    const oldReady =
      oldObject.status?.observedGeneration === oldObject.metadata.generation &&
      oldObject.status?.lastAppliedRevision === `main@sha1:${oldSha}` &&
      oldObject.status?.conditions?.some(
        (condition: Record<string, any>) =>
          condition.type === "Ready" &&
          condition.status === "True" &&
          condition.observedGeneration === oldObject.metadata.generation,
      );
    return (
      (active === oldPrevious &&
        active.startsWith("r-") &&
        previous === oldActive &&
        oldTransition === "forward" &&
        transition === "rollback") ||
      (activeSha !== oldSha &&
        oldActive.startsWith("r-") &&
        active.startsWith("r-") &&
        oldReady &&
        previous === oldActive &&
        transition === "forward" &&
        (oldTransition !== "rollback" ||
          activeSha !== oldPrevious.split("-")[1])) ||
      (activeSha === oldSha &&
        oldActive.startsWith("b-") &&
        active.startsWith("r-") &&
        previous === oldPrevious &&
        oldTransition === "bootstrap" &&
        transition === "bootstrap")
    );
  };
  const base = makeObject(currentId, bootstrapId, true, "bootstrap");
  const suspended = { ...base, spec: { ...base.spec, suspend: true } };
  assert.equal(admitted(base, suspended, deployer), false);
  assert.equal(admitted(base, base, deployer), false);
  assert.equal(
    admitted(
      base,
      { ...base, spec: { ...base.spec, interval: "1ms" } },
      deployer,
    ),
    false,
  );
  assert.equal(
    admitted(
      base,
      {
        ...base,
        spec: { ...base.spec, serviceAccountName: "kustomize-controller" },
      },
      deployer,
    ),
    false,
  );
  const next = makeObject(nextId, currentId, false, "forward");
  assert.equal(admitted(base, next, deployer), true);
  const readyRetry = makeObject(repairedId, bootstrapId, false, "bootstrap");
  assert.equal(admitted(base, readyRetry, deployer), false);
  const failedBase = makeObject(currentId, bootstrapId, false, "bootstrap");
  assert.equal(admitted(failedBase, readyRetry, deployer), false);
  assert.equal(
    admitted(failedBase, next, deployer),
    false,
    "a failed forward release must not discard the last-known-good rollback tuple",
  );
  const rollback = makeObject(currentId, nextId, false, "rollback");
  assert.equal(admitted(next, rollback, deployer), true);
  const readyRollback = makeObject(currentId, nextId, true, "rollback");
  assert.equal(
    admitted(
      readyRollback,
      makeObject(nextId, currentId, false, "forward"),
      deployer,
    ),
    false,
    "a rollback state must not toggle back to its recorded failed release",
  );
  const failedRuntimeVariantId = `r-${nextSha}-${"9".repeat(12)}`;
  assert.equal(
    admitted(
      readyRollback,
      makeObject(failedRuntimeVariantId, currentId, false, "forward"),
      deployer,
    ),
    false,
    "a different runtime hash must not bypass the failed commit marker",
  );
  const laterSha = "1".repeat(40);
  const laterId = `r-${laterSha}-${"e".repeat(12)}`;
  assert.equal(
    admitted(
      rollback,
      makeObject(laterId, currentId, false, "forward"),
      deployer,
    ),
    false,
    "a forward release still requires the rollback target to become Ready",
  );
  assert.equal(
    admitted(
      readyRollback,
      makeObject(laterId, currentId, false, "forward"),
      deployer,
    ),
    true,
  );
  const wrongRevision = makeObject(currentId, bootstrapId, true, "bootstrap");
  wrongRevision.status.lastAppliedRevision = `main@sha1:${nextSha}`;
  assert.equal(admitted(wrongRevision, next, deployer), false);
  const missingRevision = makeObject(currentId, bootstrapId, true, "bootstrap");
  delete missingRevision.status.lastAppliedRevision;
  assert.equal(admitted(missingRevision, next, deployer), false);
  assert.equal(
    admitted(next, makeObject(bootstrapId, nextId, false), deployer),
    false,
  );
  assert.equal(
    admitted(
      base,
      {
        ...next,
        spec: {
          ...next.spec,
          postBuild: {
            ...next.spec.postBuild,
            substituteFrom: [
              base.spec.postBuild.substituteFrom[0],
              next.spec.postBuild.substituteFrom[1],
            ],
          },
        },
      },
      deployer,
    ),
    false,
  );
  assert.equal(
    admitted(
      base,
      { ...base, spec: { ...base.spec, retryInterval: "1ms" } },
      deployer,
    ),
    false,
  );
  assert.equal(
    admitted(
      base,
      {
        ...suspended,
        metadata: { ...base.metadata, annotations: { pwn: "1" } },
      },
      deployer,
    ),
    false,
  );
  const finalized = {
    ...base,
    metadata: { ...base.metadata, finalizers: ["finalizers.fluxcd.io"] },
  };
  assert.equal(admitted(base, finalized, controller), true);
  assert.equal(admitted(base, finalized, deployer), false);

  assert.equal(
    resources.some(
      (resource) =>
        resource.metadata?.name ===
        "meshr-production-qualification-controller-scale.meshr.social",
    ),
    false,
  );
  assert.doesNotMatch(fluxBootstrap, /deployments\/scale|params\./);
  assert.doesNotMatch(rbac, /deployments\/scale/);
  assert.match(
    releaseTransaction,
    /\{op: "test", path: "\/metadata\/resourceVersion"/,
  );
  assert.match(
    releaseTransaction,
    /\{op: "test", path: "\/spec"[\s\S]*\{op: "replace", path: "\/spec"/,
  );
  assert.match(
    releaseTransaction,
    /\{op: "test", path: "\/metadata\/annotations\/meshr\.social~1transition-kind"/,
  );
  assert.match(releaseTransaction, /meshr-pq-source-\$\{target_sha\}/);
  assert.match(releaseTransaction, /meshr-pq-images-\$\{target_sha\}/);
  assert.match(releaseTransaction, /meshr-r-\$\{target_release_id\}/);
  assert.match(releaseTransaction, /immutable: true/);
  assert.match(
    releaseTransaction,
    /rollback EXPECTED_ACTIVE_RELEASE_ID EXPECTED_PREVIOUS_RELEASE_ID/,
  );
  assert.match(
    releaseTransaction,
    /normal promotion must preserve the active attested authority bootstrap ID/,
  );
  assert.match(qualificationReadme, /rollback/i);
  assert.doesNotMatch(
    qualificationReadme,
    /set_controller_scale|kustomize-controller\/scale|spec\.suspend[^=]*=/,
  );
  assert.match(
    qualificationReadme,
    /releases\/download\/v2\.9\.5\/install\.yaml/,
  );
  assert.match(
    qualificationReadme,
    /cc3dcd743af16215838b6937e1fce83745bf24c0dcc6c59737c59df15429caaf/,
  );
  assert.match(
    qualificationReadme,
    /ghcr\.io\/fluxcd\/source-controller@sha256:6f20d232d596a758c923d2861f23511718fc303b8a2e36a1434a7c736b9f4268/,
  );
  assert.match(
    qualificationReadme,
    /ghcr\.io\/fluxcd\/kustomize-controller@sha256:a3a955eb2bc432c2eaa94d2d3714e3beae7fdf17586fd23aadf71ab597ac3339/,
  );
  assert.match(
    qualificationReadme,
    /fluxcd\/gha-workflows\/.github\/workflows\/controller-release\.yaml@refs\/tags\/v0\.11\.0/,
  );
  assert.equal(
    qualificationReadme.match(
      /bash deploy\/production-qualification\/verify-flux-contract\.sh/g,
    )?.length,
    2,
  );
  assert.doesNotMatch(qualificationReadme, /create serviceaccounts\/token/);
  assert.doesNotMatch(qualificationReadme, /--resource-name/);
  assert.match(qualificationReadme, /--as-group=system:masters/);
  assert.match(qualificationReadme, /create --dry-run=server/g);
  assert.match(qualificationReadme, /for attempt in 1 2 3/);
  assert.match(
    qualificationReadme,
    /gitrepository\.source\.toolkit\.fluxcd\.io\/meshr-pq-source-/,
  );
  for (const policyName of [
    "meshr-production-qualification-source.meshr.social",
    "meshr-production-qualification-inputs.meshr.social",
    "meshr-production-qualification-private-services.meshr.social",
    "meshr-production-qualification-reconciliation.meshr.social",
  ]) {
    assert.ok(
      qualificationReadme.includes(policyName),
      `missing operator admission probe for ${policyName}`,
    );
  }
  assert.match(
    qualificationReadme,
    /cross-SHA[\s\S]*old Kustomization[\s\S]*Ready=True[\s\S]*current metadata generation/,
  );
  assert.match(
    qualificationReadme,
    /runner is lost after the CAS[\s\S]*rerun the[\s\S]*same `promote` command[\s\S]*arms that[\s\S]*previous release for rollback/,
  );
  for (const crdName of [
    "gitrepositories.source.toolkit.fluxcd.io",
    "kustomizations.kustomize.toolkit.fluxcd.io",
  ]) {
    assert.match(
      qualificationReadme,
      new RegExp(
        `customresourcedefinitions\\.apiextensions\\.k8s\\.io/${crdName.replaceAll(".", "\\.")}`,
      ),
    );
  }
  assert.equal(
    qualificationReadme.match(/create serviceaccounts --subresource=token/g)
      ?.length,
    2,
  );
  for (const digest of [
    "4d69eeaf45eb532d73caeeeab7dc84c087f7f2bc0284fd1614834d6fbc35a2ce",
    "742bfae846f62747bba32bea88e266497aa573fed51ee28ab3bae66afbca8797",
  ]) {
    assert.ok(fluxContract.includes(digest), `missing CRD contract ${digest}`);
  }
  assert.match(
    fluxContract,
    /conversion:[\s\S]*preserveUnknownFields:[\s\S]*versions:[\s\S]*schema/,
  );
  assert.match(
    qualificationReadme,
    /Type-checking alone does not detect a new or changed nested CRD field/,
  );

  const bashBlocks = [
    ...qualificationReadme.matchAll(/```bash\n([\s\S]*?)\n```/g),
  ];
  assert.ok(bashBlocks.length > 0);
  for (const [, block] of bashBlocks) {
    assert.ok(
      block!.startsWith("set -euo pipefail\n"),
      "every executable runbook block must fail closed",
    );
  }
});

test("qualification ConfigMap names and keys match production inputs", () => {
  const configMapKeys = (source: string): string[] =>
    Object.keys(parseYaml(source).data).sort();

  assert.deepEqual(configMapKeys(imageInputs), [
    "API_IMAGE",
    "EVENT_PLANE_IMAGE",
    "MODERATION_ADAPTER_IMAGE",
    "WEB_IMAGE",
  ]);
  assert.deepEqual(
    configMapKeys(runtimeInputs),
    [
      "GCP_PROJECT_ID",
      "MESHR_COST_PROTECTION_MODE",
      "MESHR_CUTOVER_VALIDATION_AGENT_ID",
      "MESHR_CUTOVER_VALIDATION_BINDING_ID",
      "MESHR_CUTOVER_VALIDATION_MESH_ID",
      "MESHR_CUTOVER_VALIDATION_SESSION_ID",
      "MESHR_DATABASE_CUTOVER_MODE",
      "MESHR_EVENT_AUDIT_FIRESTORE_DATABASE",
      "MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID",
      "MESHR_FIRESTORE_DATABASE",
      "MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN",
      "MESHR_MODERATION_AUDIENCE",
      "MESHR_MODERATION_ENDPOINT",
      "MESHR_MODERATION_FIRESTORE_DATABASE",
      "MESHR_MODERATION_HEALTHCHECK_URL",
      "MESHR_MODERATION_RELEASE_SHA",
      "MESHR_MODERATION_REVISION_TAG",
      "MESHR_NOTIFICATIONS_FIRESTORE_DATABASE",
      "MESHR_RELEASE_SHA",
      "MESHR_TOPOLOGY_FIRESTORE_DATABASE",
    ].sort(),
  );
});

test("Flux quote sentinels keep every deployment overlay scalar a string", () => {
  const repoRoot = fileURLToPath(root);
  const assertStringScalars = (
    overlay: "production" | "canary" | "production-qualification",
  ) => {
    const arguments_ = ["kustomize", join(repoRoot, "deploy", overlay)];
    if (overlay === "production-qualification")
      arguments_.push("--load-restrictor=LoadRestrictionsNone");
    const rendered = execFileSync("kubectl", arguments_, { encoding: "utf8" });
    assert.match(rendered, /\$\{MESHR_YAML_QUOTE\}/);
    const substituted = rendered.replace(
      /\$\{([A-Z_][A-Z0-9_]*)\}/g,
      (_placeholder, name: string) =>
        name === "MESHR_YAML_QUOTE" ? '"' : "1.1",
    );
    assert.doesNotMatch(substituted, /\$\{/);

    for (const version of ["1.1", "1.2"] as const) {
      const documents = parseAllDocuments(substituted, { version });
      for (const document of documents) {
        assert.equal(document.errors.length, 0);
        const resource = document.toJS();
        if (resource?.kind === "ConfigMap")
          for (const value of Object.values(resource.data ?? {}))
            assert.equal(typeof value, "string");

        const visit = (value: unknown, key?: string): void => {
          if (key === "image" || key === "value" || key === "resourceName") {
            if (value !== undefined && typeof value !== "object")
              assert.equal(typeof value, "string", `${overlay} ${key}`);
          }
          if (Array.isArray(value)) {
            for (const item of value) visit(item);
          } else if (value && typeof value === "object") {
            for (const [childKey, child] of Object.entries(value))
              visit(child, childKey);
          }
        };
        visit(resource);
      }
    }
  };

  assertStringScalars("production");
  assertStringScalars("canary");
  assertStringScalars("production-qualification");
  for (const manifest of [
    read("deploy/production/flux/kustomization.yaml"),
    read("deploy/production/flux/canary-kustomization.yaml"),
  ]) {
    assert.deepEqual(parseYaml(manifest).spec.postBuild.substitute, {
      MESHR_YAML_QUOTE: '"',
    });
  }
});
