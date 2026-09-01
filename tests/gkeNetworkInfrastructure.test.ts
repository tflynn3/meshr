import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const tofu = readFileSync(new URL("infra/opentofu/main.tf", root), "utf8");
const variables = readFileSync(
  new URL("infra/opentofu/variables.tf", root),
  "utf8",
);

const resource = (type: string, name: string): string => {
  const body = tofu.match(
    new RegExp(`resource "${type}" "${name}" \\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  assert.ok(body, `missing ${type}.${name}`);
  return body;
};

const resourceNames = (type: string): string[] =>
  [...tofu.matchAll(new RegExp(`resource "${type}" "([^"]+)" \\{`, "g"))].map(
    (match) => match[1],
  );

test("production foundation cannot declare or select the project default VPC", () => {
  assert.deepEqual(resourceNames("google_compute_network"), ["gke"]);
  assert.deepEqual(resourceNames("google_compute_subnetwork"), ["gke"]);
  assert.doesNotMatch(
    tofu,
    /\b(?:network|subnetwork)\s*=\s*"(?:[^"/]+\/)*default"/,
  );

  const network = resource("google_compute_network", "gke");
  assert.match(network, /name\s*=\s*"\$\{local\.name\}-gke"/);
  assert.match(network, /auto_create_subnetworks\s*=\s*false/);
});

test("durable project guardrails precede APIs that can create defaults", () => {
  const guardrails = tofu.match(
    /project_default_guardrails\s*=\s*toset\(\[([\s\S]*?)\]\)/,
  )?.[1];
  assert.ok(guardrails, "missing project default-resource guardrails");
  assert.deepEqual(
    [...guardrails.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    [
      "compute.skipDefaultNetworkCreation",
      "iam.automaticIamGrantsForDefaultServiceAccounts",
      "iam.managed.preventPrivilegedBasicRolesForDefaultServiceAccounts",
    ],
  );

  const orgPolicyService = resource(
    "google_project_service",
    "organization_policy",
  );
  assert.match(
    orgPolicyService,
    /count\s*=\s*var\.organization_policy_guardrails_enabled\s*\?\s*1\s*:\s*0/,
  );
  assert.match(orgPolicyService, /service\s*=\s*"orgpolicy\.googleapis\.com"/);
  assert.match(orgPolicyService, /disable_on_destroy\s*=\s*false/);

  const policy = resource(
    "google_org_policy_policy",
    "project_default_guardrails",
  );
  assert.match(
    policy,
    /for_each\s*=\s*var\.organization_policy_guardrails_enabled\s*\?\s*local\.project_default_guardrails\s*:\s*toset\(\[\]\)/,
  );
  assert.match(policy, /policies\/\$\{each\.value\}/);
  assert.match(policy, /enforce\s*=\s*"TRUE"/);
  assert.match(policy, /prevent_destroy\s*=\s*true/);
  assert.match(
    policy,
    /depends_on\s*=\s*\[google_project_service\.organization_policy\]/,
  );

  const required = resource("google_project_service", "required");
  assert.match(
    required,
    /google_org_policy_policy\.project_default_guardrails/,
  );
  assert.match(
    required,
    /google_org_policy_policy\.cloud_run_disable_inlined_source/,
  );
  assert.match(
    required,
    /google_org_policy_policy\.cloud_run_require_invoker_iam/,
  );
  assert.match(required, /terraform_data\.organization_policy_guardrails_mode/);
  assert.doesNotMatch(
    tofu.match(/services\s*=\s*toset\(\[([\s\S]*?)\]\)/)?.[1] ?? "",
    /orgpolicy\.googleapis\.com/,
  );

  const network = resource("google_compute_network", "gke");
  assert.match(
    network,
    /depends_on\s*=\s*\[google_project_service\.required\]/,
  );
});

test("GKE control plane is private-only from the first apply", () => {
  const cluster = resource("google_container_cluster", "autopilot");
  assert.match(cluster, /enable_private_nodes\s*=\s*true/);
  assert.match(cluster, /enable_private_endpoint\s*=\s*true/);
  assert.match(cluster, /fleet\s*\{\s*project\s*=\s*var\.project_id/);
  assert.match(
    cluster,
    /master_authorized_networks_config\s*\{\s*gcp_public_cidrs_access_enabled\s*=\s*false\s*\}/,
  );
  assert.doesNotMatch(cluster, /dynamic "cidr_blocks"|cidr_blocks\s*\{/);
  assert.doesNotMatch(variables, /gke_control_plane_authorized_cidrs/);
  assert.doesNotMatch(
    readFileSync(new URL("infra/opentofu/outputs.tf", root), "utf8"),
    /gke_control_plane_access_mode|gke_control_plane_authorized_cidrs/,
  );
});

test("production GKE uses a dedicated custom VPC and private-node subnet", () => {
  const network = resource("google_compute_network", "gke");
  const subnet = resource("google_compute_subnetwork", "gke");
  const cluster = resource("google_container_cluster", "autopilot");

  assert.match(network, /auto_create_subnetworks\s*=\s*false/);
  assert.match(subnet, /network\s*=\s*google_compute_network\.gke\.id/);
  assert.match(subnet, /private_ip_google_access\s*=\s*true/);
  assert.equal((subnet.match(/secondary_ip_range\s*\{/g) ?? []).length, 2);
  assert.match(cluster, /network\s*=\s*google_compute_network\.gke\.id/);
  assert.match(cluster, /subnetwork\s*=\s*google_compute_subnetwork\.gke\.id/);
  assert.match(cluster, /networking_mode\s*=\s*"VPC_NATIVE"/);
  assert.match(cluster, /ip_allocation_policy\s*\{/);
  assert.match(cluster, /enable_private_nodes\s*=\s*true/);
  assert.match(
    cluster,
    /master_ipv4_cidr_block\s*=\s*local\.gke_network\.control_plane/,
  );
  assert.match(cluster, /gcp_public_cidrs_access_enabled\s*=\s*false/);
  assert.match(
    cluster,
    /service_account\s*=\s*google_service_account\.gke_nodes\.email/,
  );
  assert.doesNotMatch(tofu, /role\s*=\s*"roles\/(?:owner|editor)"/);
});

test("private GKE egress uses one explicit logged Cloud NAT", () => {
  const address = resource("google_compute_address", "gke_nat");
  const router = resource("google_compute_router", "gke");
  const nat = resource("google_compute_router_nat", "gke");

  assert.match(address, /address_type\s*=\s*"EXTERNAL"/);
  assert.match(router, /network\s*=\s*google_compute_network\.gke\.id/);
  assert.match(nat, /nat_ip_allocate_option\s*=\s*"MANUAL_ONLY"/);
  assert.match(
    nat,
    /nat_ips\s*=\s*\[google_compute_address\.gke_nat\.self_link\]/,
  );
  assert.match(
    nat,
    /source_subnetwork_ip_ranges_to_nat\s*=\s*"LIST_OF_SUBNETWORKS"/,
  );
  assert.match(nat, /name\s*=\s*google_compute_subnetwork\.gke\.id/);
  assert.match(nat, /source_ip_ranges_to_nat\s*=\s*\["ALL_IP_RANGES"\]/);
  assert.match(nat, /log_config\s*\{/);
});
