import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { estimateCost, summarizeWorkloads, type CostModelInput } from "../platform/costModel.ts";
import { assertWorkloadModelMatches, readProtectedWorkloads } from "../scripts/cost-model.ts";

interface CostModelFixture {
  rates: CostModelInput["rates"];
  workloads: CostModelInput["workloads"];
  scenarios: CostModelInput["scenario"][];
}

async function fixture(): Promise<CostModelFixture> {
  return JSON.parse(await readFile(new URL("../infra/cost-model.json", import.meta.url), "utf8")) as CostModelFixture;
}

test("cost model mirrors the production HPA request envelope", async () => {
  const model = await fixture();
  assertWorkloadModelMatches(model.workloads, await readProtectedWorkloads());
  const capacity = summarizeWorkloads(model.workloads);
  assert.ok(Math.abs(capacity.minCpuVcpu - 3.58) < 1e-9);
  assert.ok(Math.abs(capacity.maxCpuVcpu - 5.18) < 1e-9);
  assert.equal(capacity.minMemoryGiB, 4.015625);
  assert.equal(capacity.maxMemoryGiB, 6.015625);
});

test("cost model makes the low-volume envelope and qualification stress explicit", async () => {
  const model = await fixture();
  const estimates = model.scenarios.map((scenario) => estimateCost({
    rates: model.rates,
    workloads: model.workloads,
    scenario,
  }));
  const demo = estimates.find((estimate) => estimate.scenario === "demo-day");
  const qualification = estimates.find((estimate) => estimate.scenario === "launch-qualification");
  assert.ok(demo);
  assert.ok(qualification);
  assert.equal(demo.monthlyUsd, 233.89);
  assert.equal(qualification.monthlyUsd, 24318.07);
  assert.ok(qualification.monthlyUsd > demo.monthlyUsd);
  assert.equal(qualification.traffic.acceptedPosts, 267_840_000);
  assert.equal(qualification.traffic.topologyUpdates, 133_920_000_000);
  assert.equal(model.scenarios.find((scenario) => scenario.name === "demo-day")?.eventPlaneCopies, 1);
  assert.equal(model.scenarios.find((scenario) => scenario.name === "launch-qualification")?.eventPlaneCopies, 1);
  assert.ok(qualification.traffic.pubsubRetainedGiB > demo.traffic.pubsubRetainedGiB);
});

test("cost model rejects invalid HPA envelopes", () => {
  assert.throws(() => summarizeWorkloads([{
    name: "invalid",
    minReplicas: 2,
    maxReplicas: 1,
    cpuMillicores: 100,
    memoryGiB: 0.1,
  }]), /max_replicas_below_min_replicas/);
});

test("cost model applies the first-five forwarding-rule tier", async () => {
  const model = await fixture();
  const estimateForRules = (rules: number) => estimateCost({
    rates: model.rates,
    workloads: [],
    scenario: {
      ...model.scenarios[0],
      name: `rules-${rules}`,
      activeHoursPerMonth: 1,
      acceptedPostsPerSecond: 0,
      onlineAgents: 0,
      viewers: 0,
      loadBalancerForwardingRules: rules,
    },
  }).lines.find((line) => line.name === "Global load balancer")?.usd;
  const zero = estimateForRules(0);
  const one = estimateForRules(1);
  const five = estimateForRules(5);
  const six = estimateForRules(6);
  assert.equal(zero, 0);
  assert.equal(one, five);
  assert.ok(Math.abs(six! - (one! + model.rates.loadBalancerAdditionalForwardingRuleUsdPerHour * model.rates.hoursPerMonth)) < 1e-9);
  assert.throws(() => estimateForRules(1.5), /load_balancer_forwarding_rules_must_be_an_integer/);
});
