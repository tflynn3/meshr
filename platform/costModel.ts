/**
 * A deliberately boring, auditable cost model for the launch shape.
 *
 * The model is not a billing promise. It turns the workload requests and the
 * traffic assumptions checked into the repository into a repeatable estimate
 * so a launch review can compare a canary measurement with the same inputs.
 * Rates are supplied by the checked-in model data and should be refreshed
 * before a real promotion.
 */

export interface CostWorkload {
  name: string;
  minReplicas: number;
  maxReplicas: number;
  cpuMillicores: number;
  memoryGiB: number;
  /** Deployment class used to audit the protected workload envelope. */
  deploymentClass?: "production" | "canary" | "metrics";
}

export interface CostRates {
  hoursPerMonth: number;
  gkeCpuUsdPerVcpuHour: number;
  gkeMemoryUsdPerGiBHour: number;
  gkeClusterUsdPerHour: number;
  gkeMonthlyFreeCreditUsd: number;
  loadBalancerForwardingRulesUsdPerHour: number;
  loadBalancerAdditionalForwardingRuleUsdPerHour: number;
  loadBalancerDataUsdPerGiB: number;
  cloudArmorPolicyUsdPerHour: number;
  cloudArmorRuleUsdPerHour: number;
  cloudArmorRequestsUsdPerMillion: number;
  firestoreReadUsdPer100k: number;
  firestoreWriteUsdPer100k: number;
  firestoreDeleteUsdPer100k: number;
  firestoreTtlDeleteUsdPer100k: number;
  firestoreStorageUsdPerGiBMonth: number;
  firestorePitrUsdPerGiBMonth: number;
  firestoreBackupUsdPerGiBMonth: number;
  pubsubUsdPerGiB: number;
  pubsubRetentionUsdPerGiBMonth: number;
  loggingUsdPerGiB: number;
  internetEgressUsdPerGiB: number;
}

export interface CostTrafficScenario {
  name: string;
  activeHoursPerMonth: number;
  acceptedPostsPerSecond: number;
  onlineAgents: number;
  viewers: number;
  eventBytes: number;
  topologyUpdateBytes: number;
  topologyUpdatesPerPostPerViewer: number;
  firestoreReadsPerViewerPerMinute: number;
  firestoreReadsPerPost: number;
  firestoreWritesPerPost: number;
  firestoreHeartbeatReadsPerAgentPerMinute: number;
  firestoreHeartbeatWritesPerAgentPerMinute: number;
  firestoreDeletesPerPost: number;
  firestoreTtlDeletesPerPost: number;
  pubsubSubscriptions: number;
  pubsubRetainedSubscriptions: number;
  pubsubRetentionDays: number;
  /** Number of event-plane copies for each accepted authority write. */
  eventPlaneCopies?: number;
  logBytesPerPost: number;
  storedGiB: number;
  pitrGiB: number;
  backupGiB: number;
  loadBalancerForwardingRules: number;
  cloudArmorRequestsPerSecond: number;
  cloudArmorPolicies: number;
  cloudArmorRules: number;
}

export interface CostEstimateLine {
  name: string;
  usd: number;
  assumption: string;
}

export interface CostEstimate {
  scenario: string;
  monthlyUsd: number;
  lines: CostEstimateLine[];
  traffic: {
    acceptedPosts: number;
    topologyUpdates: number;
    pubsubGiB: number;
    pubsubRetainedGiB: number;
    loadBalancerGiB: number;
    logGiB: number;
  };
  requests: {
    cpuVcpu: number;
    memoryGiB: number;
    firestoreReads: number;
    firestoreWrites: number;
    firestoreDeletes: number;
    firestoreTtlDeletes: number;
    cloudArmorRequests: number;
  };
}

export interface CostModelInput {
  rates: CostRates;
  workloads: CostWorkload[];
  scenario: CostTrafficScenario;
}

export interface WorkloadCapacity {
  minCpuVcpu: number;
  maxCpuVcpu: number;
  minMemoryGiB: number;
  maxMemoryGiB: number;
}

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}_must_be_non_negative`);
  return value;
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function summarizeWorkloads(workloads: CostWorkload[]): WorkloadCapacity {
  const capacity = workloads.reduce<WorkloadCapacity>(
    (total, workload) => {
      finiteNonNegative(workload.minReplicas, `${workload.name}_min_replicas`);
      finiteNonNegative(workload.maxReplicas, `${workload.name}_max_replicas`);
      finiteNonNegative(workload.cpuMillicores, `${workload.name}_cpu_millicores`);
      finiteNonNegative(workload.memoryGiB, `${workload.name}_memory_gib`);
      if (workload.maxReplicas < workload.minReplicas) {
        throw new Error(`${workload.name}_max_replicas_below_min_replicas`);
      }
      return {
        minCpuVcpu: total.minCpuVcpu + (workload.minReplicas * workload.cpuMillicores) / 1_000,
        maxCpuVcpu: total.maxCpuVcpu + (workload.maxReplicas * workload.cpuMillicores) / 1_000,
        minMemoryGiB: total.minMemoryGiB + workload.minReplicas * workload.memoryGiB,
        maxMemoryGiB: total.maxMemoryGiB + workload.maxReplicas * workload.memoryGiB,
      };
    },
    { minCpuVcpu: 0, maxCpuVcpu: 0, minMemoryGiB: 0, maxMemoryGiB: 0 },
  );
  return capacity;
}

/** Estimate one steady-state month (or a bounded active-hour window). */
export function estimateCost(input: CostModelInput): CostEstimate {
  const { rates, scenario } = input;
  // The canary Kustomization remains installed so protected promotion can
  // validate a real edge. Its capacity is therefore always part of the
  // steady-state envelope; eventPlaneCopies only controls mirrored event
  // traffic, not the authoritative write or viewer fan-out counts.
  const capacity = summarizeWorkloads(input.workloads);
  const activeHours = finiteNonNegative(scenario.activeHoursPerMonth, "active_hours_per_month");
  const onlineAgents = finiteNonNegative(scenario.onlineAgents, "online_agents");
  const viewers = finiteNonNegative(scenario.viewers, "viewers");
  const posts = finiteNonNegative(scenario.acceptedPostsPerSecond, "accepted_posts_per_second") * activeHours * 3_600;
  const topologyUpdates = posts * viewers *
    finiteNonNegative(scenario.topologyUpdatesPerPostPerViewer, "topology_updates_per_post_per_viewer");
  const heartbeatMinutes = activeHours * 60;
  const firestoreReads = viewers * heartbeatMinutes *
    finiteNonNegative(scenario.firestoreReadsPerViewerPerMinute, "firestore_reads_per_viewer_per_minute") +
    posts * finiteNonNegative(scenario.firestoreReadsPerPost, "firestore_reads_per_post") +
    onlineAgents * heartbeatMinutes * finiteNonNegative(
      scenario.firestoreHeartbeatReadsPerAgentPerMinute,
      "firestore_heartbeat_reads_per_agent_per_minute",
    );
  const firestoreWrites = posts * finiteNonNegative(scenario.firestoreWritesPerPost, "firestore_writes_per_post") +
    onlineAgents * heartbeatMinutes * finiteNonNegative(
      scenario.firestoreHeartbeatWritesPerAgentPerMinute,
      "firestore_heartbeat_writes_per_agent_per_minute",
    );
  const firestoreDeletes = posts * finiteNonNegative(scenario.firestoreDeletesPerPost, "firestore_deletes_per_post");
  const firestoreTtlDeletes = posts * finiteNonNegative(scenario.firestoreTtlDeletesPerPost, "firestore_ttl_deletes_per_post");
  // acceptedPostsPerSecond is the authoritative write rate. A protected
  // canary may receive a mirrored event-plane copy, but it does not create a
  // second Firestore write, topology fan-out, or browser request.
  const eventPlaneCopies = finiteNonNegative(scenario.eventPlaneCopies ?? 1, "event_plane_copies");
  if (!Number.isInteger(eventPlaneCopies) || eventPlaneCopies < 1) {
    throw new Error("event_plane_copies_must_be_a_positive_integer");
  }
  const pubsubGiB = posts * finiteNonNegative(scenario.eventBytes, "event_bytes") *
    (1 + finiteNonNegative(scenario.pubsubSubscriptions, "pubsub_subscriptions")) * eventPlaneCopies / (1024 ** 3);
  const retentionWindowFraction = Math.min(1, finiteNonNegative(scenario.pubsubRetentionDays, "pubsub_retention_days") * 24 /
    Math.max(activeHours, 1));
  const pubsubRetainedGiB = posts * finiteNonNegative(scenario.eventBytes, "event_bytes") *
    finiteNonNegative(scenario.pubsubRetainedSubscriptions, "pubsub_retained_subscriptions") * eventPlaneCopies *
    retentionWindowFraction / (1024 ** 3);
  const topologyGiB = topologyUpdates * finiteNonNegative(scenario.topologyUpdateBytes, "topology_update_bytes") / (1024 ** 3);
  const loadBalancerGiB = topologyGiB + posts * finiteNonNegative(scenario.eventBytes, "event_bytes") / (1024 ** 3);
  const logGiB = posts * finiteNonNegative(scenario.logBytesPerPost, "log_bytes_per_post") / (1024 ** 3);
  const cloudArmorRequests = finiteNonNegative(scenario.cloudArmorRequestsPerSecond, "cloud_armor_requests_per_second") * activeHours * 3_600;

  const gkeCompute = (capacity.maxCpuVcpu * rates.gkeCpuUsdPerVcpuHour +
    capacity.maxMemoryGiB * rates.gkeMemoryUsdPerGiBHour) * rates.hoursPerMonth;
  const gkeCluster = Math.max(0, rates.gkeClusterUsdPerHour * rates.hoursPerMonth - rates.gkeMonthlyFreeCreditUsd);
  const forwardingRules = finiteNonNegative(scenario.loadBalancerForwardingRules, "load_balancer_forwarding_rules");
  if (!Number.isInteger(forwardingRules)) {
    throw new Error("load_balancer_forwarding_rules_must_be_an_integer");
  }
  // Global forwarding rules share the first-five project-level tier; rules
  // after the first five have their own per-rule hourly rate.
  const forwardingRuleGroups = forwardingRules > 0 ? 1 : 0;
  const additionalForwardingRules = Math.max(0, forwardingRules - 5);
  const loadBalancer = forwardingRuleGroups * rates.loadBalancerForwardingRulesUsdPerHour * rates.hoursPerMonth +
    additionalForwardingRules * rates.loadBalancerAdditionalForwardingRuleUsdPerHour * rates.hoursPerMonth +
    loadBalancerGiB * rates.loadBalancerDataUsdPerGiB;
  const cloudArmor = scenario.cloudArmorPolicies * rates.cloudArmorPolicyUsdPerHour * rates.hoursPerMonth +
    scenario.cloudArmorRules * rates.cloudArmorRuleUsdPerHour * rates.hoursPerMonth +
    (cloudArmorRequests / 1_000_000) * rates.cloudArmorRequestsUsdPerMillion;
  const firestore = firestoreReads / 100_000 * rates.firestoreReadUsdPer100k +
    firestoreWrites / 100_000 * rates.firestoreWriteUsdPer100k +
    firestoreDeletes / 100_000 * rates.firestoreDeleteUsdPer100k +
    firestoreTtlDeletes / 100_000 * rates.firestoreTtlDeleteUsdPer100k +
    scenario.storedGiB * rates.firestoreStorageUsdPerGiBMonth +
    scenario.pitrGiB * rates.firestorePitrUsdPerGiBMonth +
    scenario.backupGiB * rates.firestoreBackupUsdPerGiBMonth;
  const pubsub = pubsubGiB * rates.pubsubUsdPerGiB + pubsubRetainedGiB * rates.pubsubRetentionUsdPerGiBMonth;
  const logging = logGiB * rates.loggingUsdPerGiB;
  const egress = topologyGiB * rates.internetEgressUsdPerGiB;
  const lines: CostEstimateLine[] = [
    { name: "GKE Autopilot pods", usd: gkeCompute, assumption: `${capacity.maxCpuVcpu.toFixed(2)} vCPU and ${capacity.maxMemoryGiB.toFixed(2)} GiB at HPA max` },
    { name: "GKE cluster management", usd: gkeCluster, assumption: `${rates.hoursPerMonth} hours less $${rates.gkeMonthlyFreeCreditUsd.toFixed(2)} credit` },
    { name: "Global load balancer", usd: loadBalancer, assumption: `${forwardingRules} forwarding rules (${forwardingRuleGroups} first-five billing group, ${additionalForwardingRules} additional) and ${loadBalancerGiB.toFixed(2)} GiB processed` },
    { name: "Cloud Armor Standard", usd: cloudArmor, assumption: `${scenario.cloudArmorPolicies} policy, ${scenario.cloudArmorRules} rules, ${cloudArmorRequests.toFixed(0)} requests` },
    { name: "Firestore", usd: firestore, assumption: `${onlineAgents} online agents and ${firestoreReads.toFixed(0)} reads, ${firestoreWrites.toFixed(0)} writes, ${firestoreTtlDeletes.toFixed(0)} TTL deletes` },
    { name: "Pub/Sub", usd: pubsub, assumption: `${pubsubGiB.toFixed(2)} GiB of publish/delivery traffic plus ${pubsubRetainedGiB.toFixed(2)} GiB retained across ${scenario.pubsubRetainedSubscriptions} subscriptions (${eventPlaneCopies} event-plane copy${eventPlaneCopies === 1 ? "" : "ies"})` },
    { name: "Cloud Logging", usd: logging, assumption: `${logGiB.toFixed(2)} GiB of structured logs` },
    { name: "Internet egress", usd: egress, assumption: `${topologyGiB.toFixed(2)} GiB of topology fan-out` },
  ];
  return {
    scenario: scenario.name,
    monthlyUsd: roundUsd(lines.reduce((sum, line) => sum + line.usd, 0)),
    lines: lines.map((line) => ({ ...line, usd: roundUsd(line.usd) })),
    traffic: {
      acceptedPosts: Math.round(posts),
      topologyUpdates: Math.round(topologyUpdates),
      pubsubGiB,
      pubsubRetainedGiB,
      loadBalancerGiB,
      logGiB,
    },
    requests: {
      cpuVcpu: capacity.maxCpuVcpu,
      memoryGiB: capacity.maxMemoryGiB,
      firestoreReads,
      firestoreWrites,
      firestoreDeletes,
      firestoreTtlDeletes,
      cloudArmorRequests,
    },
  };
}
