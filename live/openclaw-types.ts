import type { ConnectorBinding } from "../connector/types.ts";
import type {
  AuthorBindingEvidence,
  IdentityEvidence,
  PublicBindingEvidence,
} from "./types.ts";

export type OpenClawLivePhase = "root" | "reply";

export interface OpenClawLiveOptions {
  projectRoot: string;
  dryRun: boolean;
  agentIds: [string, string];
  bindingSelectors?: [string, string];
  openClawCommand: string;
  openClawStateDirectory: string;
  openClawConfigPath: string;
  connectorStatePath: string;
  serverUrl?: string;
  model?: string;
  timeoutMs: number;
  versionTimeoutMs: number;
  evidencePath?: string;
}

export interface OpenClawSafeProcessEvidence {
  command: string;
  args: string[];
  startedAt: string;
  elapsedMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutJson: boolean;
  failureKind?: "spawn-error" | "timeout" | "nonzero-exit";
}

export interface OpenClawVersionEvidence {
  installed: boolean;
  version?: string;
  execution: OpenClawSafeProcessEvidence;
}

export interface OpenClawPluginValidationEvidence {
  enabled: true;
  serverUrl: string;
  connectorStatePathMatches: true;
  runtimeFactoryValidated: true;
  pluginEntryPath: string;
  agents: Array<{
    agentId: string;
    effectiveProfile: "full";
    exactMeshrAllowlistValidated: true;
    requiredTools: string[];
    missingTools: [];
  }>;
}

export interface OpenClawInvocationPlan {
  command: string;
  args: string[];
  environmentOverrides: ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"];
  promptSha256: string;
  requiredTools: string[];
  outerTimeoutMs: number;
  openClawTimeoutSeconds: number;
  attempts: 1;
}

export interface OpenClawAgentEvidence {
  role: OpenClawLivePhase;
  openClawAgentId: string;
  binding: PublicBindingEvidence;
  identity: IdentityEvidence;
}

export interface OpenClawTargetEvidence {
  meshId: string;
  topicId: string;
  postId?: string;
}

export interface OpenClawPhaseEvidence {
  phase: OpenClawLivePhase;
  traceId: string;
  marker: string;
  openClawAgentId: string;
  binding: PublicBindingEvidence;
  target: OpenClawTargetEvidence;
  plan: OpenClawInvocationPlan;
  status: "planned" | "passed" | "failed" | "skipped";
  execution?: OpenClawSafeProcessEvidence;
  authorBinding?: AuthorBindingEvidence;
  error?: string;
}

export interface OpenClawLiveEvidence {
  schemaVersion: 1;
  runId: string;
  traceId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  projectRoot: string;
  isolation: {
    openClawCommand: string;
    openClawStateDirectory: string;
    openClawConfigPath: string;
    connectorStatePath: string;
    privateStateValidated: boolean;
  };
  plugin?: OpenClawPluginValidationEvidence;
  version?: OpenClawVersionEvidence;
  agents: OpenClawAgentEvidence[];
  phases: OpenClawPhaseEvidence[];
  outcome: "planned" | "passed" | "failed";
  error?: string;
}

export interface SelectedOpenClawBindings {
  root: ConnectorBinding;
  reply: ConnectorBinding;
}
