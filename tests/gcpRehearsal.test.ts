import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import YAML from "yaml";

const repositoryRoot = resolve(import.meta.dirname, "..");
const rehearsalRoot = resolve(repositoryRoot, "deploy/rehearsal");
const manifestNames = [
  "namespace.yaml",
  "serviceaccounts.yaml",
  "config.yaml",
  "bootstrap.yaml",
  "workloads.yaml",
];

type Manifest = {
  apiVersion?: string;
  kind?: string;
  metadata?: { name?: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: Record<string, any>;
  data?: Record<string, string>;
  automountServiceAccountToken?: boolean;
};

const manifests = manifestNames.flatMap((name) =>
  YAML.parseAllDocuments(readFileSync(resolve(rehearsalRoot, name), "utf8"))
    .map((document) => document.toJSON() as Manifest)
    .filter((document) => document && document.kind)
);

function resources(kind: string): Manifest[] {
  return manifests.filter((manifest) => manifest.kind === kind);
}

test("GCP rehearsal overlay is private, bounded, and production-shaped", () => {
  const namespaces = resources("Namespace");
  assert.equal(namespaces.length, 1);
  assert.equal(namespaces[0]?.metadata?.name, "meshr-rehearsal");
  assert.equal(namespaces[0]?.metadata?.labels?.["meshr.social/environment"], "rehearsal");
  assert.equal(namespaces[0]?.metadata?.labels?.["pod-security.kubernetes.io/enforce"], "restricted");

  const deployments = resources("Deployment");
  assert.deepEqual(
    deployments.map((deployment) => deployment.metadata?.name).sort(),
    ["api", "ingest", "live-gateway", "topology-materializer", "web"],
  );
  for (const deployment of deployments) {
    assert.equal(deployment.spec?.replicas, 1, `${deployment.metadata?.name} must stay single-replica`);
    const containers = deployment.spec?.template?.spec?.containers as Array<Record<string, any>>;
    assert.equal(containers.length, 1);
    const container = containers[0]!;
    assert.match(container.image as string, /^\$\{(?:API|WEB|EVENT_PLANE)_IMAGE\}$/);
    assert.ok(container.resources?.requests?.cpu, `${deployment.metadata?.name} has no CPU request`);
    assert.ok(container.resources?.requests?.memory, `${deployment.metadata?.name} has no memory request`);
    assert.ok(container.resources?.limits?.cpu, `${deployment.metadata?.name} has no CPU limit`);
    assert.ok(container.resources?.limits?.memory, `${deployment.metadata?.name} has no memory limit`);
  }

  const services = resources("Service");
  assert.equal(services.length, 5);
  for (const service of services) {
    assert.equal(service.spec?.type, "ClusterIP");
    assert.equal(service.spec?.externalIPs, undefined);
    assert.equal(service.spec?.loadBalancerIP, undefined);
    for (const port of (service.spec?.ports ?? []) as Array<Record<string, unknown>>) {
      assert.equal(port.nodePort, undefined);
    }
  }
  assert.deepEqual(
    manifests.filter((manifest) => ["Ingress", "Gateway", "HTTPRoute"].includes(manifest.kind ?? "")),
    [],
  );
  assert.equal(resources("Secret").length, 0, "runtime Secret must be created ephemerally by the script");
});

test("GCP rehearsal uses Workload Identity and distinct managed Firestore databases", () => {
  const accounts = new Map(
    resources("ServiceAccount").map((account) => [account.metadata?.name, account]),
  );
  for (const [name, variable] of [
    ["meshr-api", "MESHR_REHEARSAL_API_GSA"],
    ["meshr-bootstrap", "MESHR_REHEARSAL_BOOTSTRAP_GSA"],
    ["meshr-ingest", "MESHR_REHEARSAL_INGEST_GSA"],
    ["meshr-topology-materializer", "MESHR_REHEARSAL_TOPOLOGY_GSA"],
    ["meshr-live-gateway", "MESHR_REHEARSAL_LIVE_GSA"],
  ] as const) {
    assert.equal(
      accounts.get(name)?.metadata?.annotations?.["iam.gke.io/gcp-service-account"],
      `\${${variable}}`,
    );
  }
  assert.equal(accounts.get("meshr-web")?.automountServiceAccountToken, false);

  const config = resources("ConfigMap").find((manifest) => manifest.metadata?.name === "meshr-runtime");
  assert.ok(config?.data);
  assert.equal(config.data.MESHR_ENV, "production");
  assert.equal(config.data.MESHR_STORAGE, "firestore");
  assert.equal(config.data.MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID, "pending");
  assert.equal(
    config.data.MESHR_FORCE_PROJECTION_BOOTSTRAP_SCAN,
    "0",
    "routine rehearsals must reuse the existing attested projection generation",
  );
  assert.equal(config.data.MESHR_EVENTS_TOPIC, "${MESHR_REHEARSAL_EVENTS_TOPIC}");
  assert.equal(config.data.MESHR_TOPOLOGY_SUBSCRIPTION, "${MESHR_REHEARSAL_TOPOLOGY_SUBSCRIPTION}");
  const databaseValues = [
    config.data.MESHR_FIRESTORE_DATABASE,
    config.data.MESHR_TOPOLOGY_FIRESTORE_DATABASE,
    config.data.MESHR_EVENT_AUDIT_FIRESTORE_DATABASE,
    config.data.MESHR_NOTIFICATIONS_FIRESTORE_DATABASE,
    config.data.MESHR_MODERATION_FIRESTORE_DATABASE,
  ];
  assert.equal(new Set(databaseValues).size, 5);

  const bootstrap = resources("Job").find(
    (manifest) => manifest.metadata?.name === "production-store-bootstrap",
  );
  assert.ok(bootstrap);
  assert.deepEqual(bootstrap.spec?.template?.spec?.containers?.[0]?.args, ["production-bootstrap"]);
  assert.equal(bootstrap.spec?.template?.spec?.serviceAccountName, "meshr-bootstrap");

  const terraform = readFileSync(resolve(repositoryRoot, "infra/rehearsal/main.tf"), "utf8");
  assert.match(
    terraform,
    /posts_expiry_pending\s*=\s*\{[\s\S]*?collection\s*=\s*"posts"[\s\S]*?field_path\s*=\s*"expiry_pending"[\s\S]*?field_path\s*=\s*"expires_at"/,
    "the rehearsal must provision the post-retention index exercised by the API sweep",
  );
});

test("GCP rehearsal lifecycle script has safe syntax and the complete teardown gate", () => {
  const scriptPath = resolve(repositoryRoot, "scripts/gcp-rehearsal.sh");
  const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);

  const script = readFileSync(scriptPath, "utf8");
  for (const command of [
    "create-cluster",
    "deploy",
    "smoke",
    "restart-smoke",
    "status",
    "destroy-cluster",
  ]) {
    assert.match(script, new RegExp(`${command.replace("-", "\\-")}\\)`));
  }
  assert.match(script, /API_IMAGE must be supplied as an immutable image digest|API_IMAGE WEB_IMAGE EVENT_PLANE_IMAGE/);
  assert.match(script, /\.resourceLabels\.environment == "rehearsal"/);
  assert.match(script, /\.resourceLabels\.lifecycle == "ephemeral"/);
  assert.doesNotMatch(script, /add-iam-policy-binding|bind_workload_identity/);
  assert.match(script, /assert_rehearsal_cluster "\$\(cluster_json\)"[\s\S]*container clusters delete/);
  assert.match(script, /MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID/);
  assert.match(script, /rollout restart deployment\/topology-materializer/);
});

test("GCP rehearsal retries a transient bootstrap log-agent failure", () => {
  const scriptPath = resolve(repositoryRoot, "scripts/gcp-rehearsal.sh");
  const fixtureRoot = mkdtempSync(join(tmpdir(), "meshr-rehearsal-bootstrap-logs-"));
  const attemptFile = resolve(fixtureRoot, "attempts");
  const command = String.raw`
    source "$MESHR_REHEARSAL_SCRIPT"
    k() {
      local attempt
      attempt="$(cat "$MESHR_REHEARSAL_ATTEMPT_FILE" 2>/dev/null || printf '0')"
      attempt="$((attempt + 1))"
      printf '%s' "$attempt" > "$MESHR_REHEARSAL_ATTEMPT_FILE"
      if [[ "$attempt" -eq 1 ]]; then
        echo 'Error from server: No agent available' >&2
        return 1
      fi
      printf '%s\n' '{"event":"stores.initialized","authorityBootstrapId":"generation-1","projectionBootstrapId":"generation-1"}'
    }
    read_bootstrap_logs
  `;

  try {
    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        MESHR_REHEARSAL_ATTEMPT_FILE: attemptFile,
        MESHR_REHEARSAL_SCRIPT: scriptPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /bootstrap logs are temporarily unavailable; retrying \(1\/30\)/);
    assert.match(result.stdout, /"event":"stores\.initialized"/);
    assert.equal(readFileSync(attemptFile, "utf8"), "2");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("GCP rehearsal teardown distinguishes a missing cluster from discovery failure", () => {
  const scriptPath = resolve(repositoryRoot, "scripts/gcp-rehearsal.sh");
  const fakeBin = mkdtempSync(join(tmpdir(), "meshr-rehearsal-gcloud-"));
  const fakeGcloud = resolve(fakeBin, "gcloud");
  writeFileSync(
    fakeGcloud,
    '#!/usr/bin/env bash\nprintf "%s\\n" "${FAKE_GCLOUD_ERROR}" >&2\nexit 1\n',
  );
  chmodSync(fakeGcloud, 0o755);

  const runDestroy = (error: string) =>
    spawnSync("bash", [scriptPath, "destroy-cluster"], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GCLOUD_ERROR: error,
        GCP_PROJECT_ID: "example-rehearsal-project",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });

  try {
    const unauthorized = runDestroy(
      "ERROR: (gcloud.container.clusters.describe) ResponseError: code=403, message=Permission denied",
    );
    assert.notEqual(unauthorized.status, 0);
    assert.match(unauthorized.stderr, /unable to determine GKE rehearsal cluster presence/);
    assert.doesNotMatch(unauthorized.stdout, /already absent/);

    const absent = runDestroy(
      "ERROR: (gcloud.container.clusters.describe) ResponseError: code=404, message=Not found",
    );
    assert.equal(absent.status, 0, absent.stderr);
    assert.match(absent.stdout, /already absent/);
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("GCP rehearsal trust pins a configurable workflow to immutable GitHub IDs", () => {
  const terraform = readFileSync(resolve(repositoryRoot, "infra/rehearsal/main.tf"), "utf8");
  const variables = readFileSync(resolve(repositoryRoot, "infra/rehearsal/variables.tf"), "utf8");
  assert.match(
    terraform,
    /repo:\$\{local\.github_repository_owner\}@\$\{var\.github_repository_owner_id\}\/\$\{local\.github_repository_name\}@\$\{var\.github_repository_id\}/,
  );
  assert.match(
    terraform,
    /assertion\.sub == '\$\{local\.github_immutable_subject_prefix\}:environment:gcp-rehearsal'/,
  );
  assert.match(terraform, /"attribute\.repository_visibility"\s*=\s*"assertion\.repository_visibility"/);
  assert.match(terraform, /assertion\.repository_visibility == 'private'/);
  assert.doesNotMatch(
    terraform,
    /assertion\.sub == 'repo:\$\{local\.github_repository\}:environment:gcp-rehearsal'/,
  );
  assert.match(terraform, /resource "google_service_account_iam_member" "workload_identity"/);
  assert.match(
    terraform,
    /serviceAccount:\$\{var\.project_id\}\.svc\.id\.goog\[\$\{local\.kubernetes_namespace\}\/\$\{each\.value\.kubernetes_service_account\}\]/,
  );
  assert.doesNotMatch(terraform, /iam\.serviceAccounts\.setIamPolicy|workload_identity_binder/);
  assert.match(terraform, /resource "terraform_data" "private_github_authority_guard"/);
  assert.match(terraform, /var\.github_repository_id != "1348689949"/);
  assert.match(terraform, /lower\(var\.github_repository\) != "tflynn3\/meshr"/);
  assert.match(
    terraform,
    /\$\{var\.github_repository\}\/\$\{var\.github_workflow_path\}@refs\/heads\/main/,
  );
  for (const variable of [
    "github_repository",
    "github_repository_id",
    "github_repository_owner_id",
    "github_workflow_path",
  ]) {
    const body = variables.match(
      new RegExp(`variable "${variable}" \\{([\\s\\S]*?)\\n\\}`),
    )?.[1];
    assert.ok(body, `missing ${variable}`);
    assert.doesNotMatch(body, /\bdefault\s*=/, `${variable} must be an explicit private-ops input`);
  }
  assert.match(terraform, /assertion\.workflow_ref == '\$\{local\.github_workflow_ref\}'/);
  assert.doesNotMatch(terraform, /workflow_ref\.startsWith|feat\/copyable-agent-setup/);
  assert.doesNotMatch(terraform, /assertion\.event_name == 'push'/);
});

test("GCP rehearsal topology identity can inspect its subscription for readiness", () => {
  const terraform = readFileSync(resolve(repositoryRoot, "infra/rehearsal/main.tf"), "utf8");
  assert.match(
    terraform,
    /resource "google_pubsub_subscription_iam_member" "topology_viewer"[\s\S]*role\s*=\s*"roles\/pubsub\.viewer"[\s\S]*google_service_account\.workload\["topology"\]\.email/,
  );
});

test("stack smoke keeps same-origin defaults and accepts four component URLs", () => {
  const smoke = readFileSync(resolve(repositoryRoot, "scripts/smoke-local-stack.ts"), "utf8");
  assert.match(smoke, /MESHR_LOCAL_URL/);
  for (const component of ["API", "WEB", "INGEST", "LIVE"]) {
    assert.match(smoke, new RegExp(`MESHR_LOCAL_${component}_URL`));
  }
  assert.match(smoke, /`\$\{sameOriginBaseUrl\}\/__local\/ingest`/);
  assert.match(smoke, /new WebSocket\(url, \{ origin: webOrigin \}\)/);
});
