import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  assert.match(script, /roles\/iam\.workloadIdentityUser/);
  for (const ksa of [
    "meshr-api",
    "meshr-bootstrap",
    "meshr-ingest",
    "meshr-topology-materializer",
    "meshr-live-gateway",
  ]) {
    assert.match(script, new RegExp(`\\|${ksa}`));
  }
  assert.match(script, /create_cluster\(\)[\s\S]*bind_workload_identity[\s\S]*Meshr Autopilot rehearsal cluster is ready/);
  assert.match(script, /deploy\(\)[\s\S]*set_render_values\s+bind_workload_identity/);
  assert.match(script, /assert_rehearsal_cluster "\$\(cluster_json\)"[\s\S]*container clusters delete/);
  assert.match(script, /MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID/);
  assert.match(script, /rollout restart deployment\/topology-materializer/);
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
