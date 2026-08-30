#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { estimateCost, summarizeWorkloads, type CostRates, type CostTrafficScenario, type CostWorkload } from "../platform/costModel.ts";
import { parseAllDocuments } from "yaml";

interface CostModelFile {
  modelVersion: number;
  asOf: string;
  region: string;
  currency: string;
  rates: CostRates;
  workloads: CostWorkload[];
  scenarios: CostTrafficScenario[];
  sources: string[];
}

export const COST_MODEL_HELP = `Usage:
  npm run cost:model
  npm --silent run cost:model -- --json

Estimates the checked-in Meshr protected workload and traffic scenarios. The
result is a planning model, not a billing guarantee; refresh infra/cost-model.json
before a protected promotion and compare it with Cloud Billing exports.
`;

export async function readCostModel(path = resolve("infra/cost-model.json")): Promise<CostModelFile> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as CostModelFile;
  if (parsed.modelVersion !== 1 || !parsed.rates || !Array.isArray(parsed.workloads) || !Array.isArray(parsed.scenarios)) {
    throw new Error("cost_model_contract_invalid");
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseCpu(value: unknown): number {
  const text = String(value ?? "").trim();
  if (text.endsWith("m")) return Number(text.slice(0, -1));
  const cores = Number(text);
  return Number.isFinite(cores) ? cores * 1_000 : Number.NaN;
}

function parseMemoryGiB(value: unknown): number {
  const text = String(value ?? "").trim();
  const units: Array<[string, number]> = [["Gi", 1], ["Mi", 1 / 1024], ["Ki", 1 / (1024 ** 2)], ["G", 1 / 1.073741824], ["M", 1 / 1073.741824]];
  for (const [suffix, multiplier] of units) {
    if (text.endsWith(suffix)) return Number(text.slice(0, -suffix.length)) * multiplier;
  }
  const bytes = Number(text);
  return Number.isFinite(bytes) ? bytes / (1024 ** 3) : Number.NaN;
}

interface WorkloadManifest {
  path: string;
  deploymentClass: NonNullable<CostWorkload["deploymentClass"]>;
  namePrefix: string;
}

async function readWorkloadManifest(manifest: WorkloadManifest): Promise<CostWorkload[]> {
  const documents = parseAllDocuments(await readFile(manifest.path, "utf8"));
  const resources = documents.map((document) => asRecord(document.toJS()));
  const hpas = new Map<string, Record<string, unknown>>(
    resources
      .filter((resource) => resource.kind === "HorizontalPodAutoscaler")
      .map((resource) => [String(asRecord(resource.metadata).name), resource]),
  );
  return resources
    .filter((resource) => resource.kind === "Deployment")
    .map((resource) => {
      const metadata = asRecord(resource.metadata);
      const rawName = String(metadata.name ?? "");
      const name = `${manifest.namePrefix}${rawName}`;
      const spec = asRecord(resource.spec);
      const template = asRecord(asRecord(spec.template).spec);
      const containers = Array.isArray(template.containers) ? template.containers : [];
      const container = asRecord(containers[0]);
      const requests = asRecord(asRecord(container.resources).requests);
      const hpa = hpas.get(rawName);
      const hpaSpec = asRecord(hpa?.spec);
      const replicas = Number(spec.replicas ?? 1);
      return {
        name,
        minReplicas: Number(hpaSpec.minReplicas ?? replicas),
        maxReplicas: Number(hpaSpec.maxReplicas ?? replicas),
        cpuMillicores: parseCpu(requests.cpu),
        memoryGiB: parseMemoryGiB(requests.memory),
        deploymentClass: manifest.deploymentClass,
      } satisfies CostWorkload;
    });
}

/** Read one overlay so focused callers can inspect only production. */
export async function readProductionWorkloads(path = resolve("deploy/production/workloads.yaml")): Promise<CostWorkload[]> {
  return readWorkloadManifest({ path, deploymentClass: "production", namePrefix: "" });
}

/**
 * Read every Flux-managed workload that can consume capacity. Canary remains
 * installed for protected promotion, so its requested envelope is billable
 * even when the demo scenario sends no mirrored event-plane traffic.
 */
export async function readProtectedWorkloads(root = resolve(".")): Promise<CostWorkload[]> {
  const manifests: WorkloadManifest[] = [
    { path: resolve(root, "deploy/production/workloads.yaml"), deploymentClass: "production", namePrefix: "production/" },
    { path: resolve(root, "deploy/canary/workloads.yaml"), deploymentClass: "canary", namePrefix: "canary/" },
    { path: resolve(root, "deploy/canary/event-plane.yaml"), deploymentClass: "canary", namePrefix: "canary/" },
    { path: resolve(root, "deploy/metrics-adapter/adapter.yaml"), deploymentClass: "metrics", namePrefix: "metrics/" },
  ];
  const workloads = (await Promise.all(manifests.map(readWorkloadManifest))).flat();
  if (!workloads.length) throw new Error("cost_model_protected_workload_set_empty");
  return workloads;
}

export function assertWorkloadModelMatches(model: CostWorkload[], actual: CostWorkload[]): void {
  const byName = new Map(model.map((workload) => [workload.name, workload]));
  if (byName.size !== model.length || model.length !== actual.length) throw new Error("cost_model_workload_set_invalid");
  for (const workload of actual) {
    const expected = byName.get(workload.name);
    if (!expected || JSON.stringify(expected) !== JSON.stringify(workload)) {
      throw new Error(`cost_model_workload_drift:${workload.name}`);
    }
  }
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function renderCostModel(model: CostModelFile): string {
  const capacity = summarizeWorkloads(model.workloads);
  const lines = [
    `Meshr cost model v${model.modelVersion} (${model.asOf}, ${model.region}, ${model.currency})`,
    `HPA request envelope: ${capacity.minCpuVcpu.toFixed(2)}-${capacity.maxCpuVcpu.toFixed(2)} vCPU, ${capacity.minMemoryGiB.toFixed(2)}-${capacity.maxMemoryGiB.toFixed(2)} GiB`,
    "",
  ];
  for (const scenario of model.scenarios) {
    const estimate = estimateCost({ rates: model.rates, workloads: model.workloads, scenario });
    lines.push(`${scenario.name}: ${formatUsd(estimate.monthlyUsd)}/month`);
    for (const line of estimate.lines) lines.push(`  ${line.name}: ${formatUsd(line.usd)} (${line.assumption})`);
    lines.push(`  traffic: ${estimate.traffic.acceptedPosts.toLocaleString()} posts, ${estimate.traffic.topologyUpdates.toLocaleString()} topology updates, ${estimate.traffic.pubsubGiB.toFixed(2)} GiB Pub/Sub plus ${estimate.traffic.pubsubRetainedGiB.toFixed(2)} GiB retained`);
    lines.push("");
  }
  lines.push("Rates and assumptions are planning inputs; validate with the GCP Pricing Calculator and Cloud Billing exports.");
  return `${lines.join("\n")}\n`;
}

export async function main(values = process.argv.slice(2)): Promise<void> {
  if (values.includes("--help")) {
    process.stdout.write(COST_MODEL_HELP);
    return;
  }
  const model = await readCostModel();
  assertWorkloadModelMatches(model.workloads, await readProtectedWorkloads());
  if (values.includes("--json")) {
    const capacity = summarizeWorkloads(model.workloads);
    process.stdout.write(`${JSON.stringify({
      modelVersion: model.modelVersion,
      asOf: model.asOf,
      region: model.region,
      workloadCapacity: capacity,
      scenarios: model.scenarios.map((scenario) => estimateCost({ rates: model.rates, workloads: model.workloads, scenario })),
      sources: model.sources,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(renderCostModel(model));
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
