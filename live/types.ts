import type { ConnectorBinding } from "../connector/types.ts";

export const LIVE_RUNTIMES = ["codex", "claude", "ollama"] as const;
export const CODEX_PUBLISH_MODES = ["direct-mcp", "managed"] as const;

export type LiveRuntime = (typeof LIVE_RUNTIMES)[number];
export type LivePhase = "root" | "reply";
export type CodexPublishMode = (typeof CODEX_PUBLISH_MODES)[number];

export interface LiveMatrixOptions {
  projectRoot: string;
  stateDirectory?: string;
  serverUrl?: string;
  runtimes: LiveRuntime[];
  bindings: Partial<Record<LiveRuntime, [string, string]>>;
  dryRun: boolean;
  timeoutMs: number;
  versionTimeoutMs: number;
  evidencePath?: string;
  commands: Record<LiveRuntime, string>;
  models: Partial<Record<LiveRuntime, string>>;
  codexPublishMode: CodexPublishMode;
  ollamaUrl: string;
  claudeBudgetUsd: number;
}

export interface PublicBindingEvidence {
  pairingId: string;
  bindingId?: string;
  agentId?: string;
  serverUrl: string;
  runtime: ConnectorBinding["runtime"];
  label: string;
  externalSubject: string;
  handle: string;
  status: ConnectorBinding["status"];
}

export interface ProcessEvidence {
  kind: "process";
  command: string;
  args: string[];
  startedAt: string;
  elapsedMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  error?: string;
}

export interface HttpEvidence {
  kind: "http";
  url: string;
  startedAt: string;
  elapsedMs: number;
  exitCode: 0 | 1;
  httpStatus?: number;
  timedOut: boolean;
  responseExcerpt?: string;
  error?: string;
}

export type ExecutionEvidence = ProcessEvidence | HttpEvidence;

export interface VersionEvidence {
  installed: boolean;
  version?: string;
  execution: ProcessEvidence;
}

export interface IdentityEvidence {
  binding: PublicBindingEvidence;
  serverAgentId?: string;
  serverHandle?: string;
  matches: boolean;
  error?: string;
}

export interface InvocationPlan {
  kind: "process" | "http";
  command?: string;
  args?: string[];
  url?: string;
  promptSha256: string;
  publisher: "model-via-mcp" | "connector";
  modelMeshrAccess: "invocation-local-mcp" | "none";
}

export interface ManagedContextEvidence {
  source: "connector-binding";
  profileFields: ["name", "handle", "tagline", "interests", "personality"];
  meshId: string;
  topicId: string;
  postsAvailable: number;
  postsIncluded: number;
  postLimit: number;
  maxPostCharacters: number;
  modelMeshrCredentials: false;
  modelMcpConfigured: false;
}

export interface AuthorBindingEvidence {
  postId: string;
  parentPostId: string | null;
  meshId: string;
  topicId: string;
  marker: string;
  expectedAgentId?: string;
  expectedHandle: string;
  observedAgentId: string;
  observedHandle: string;
  agentIdMatches: boolean;
  handleMatches: boolean;
}

export interface PhaseEvidence {
  phase: LivePhase;
  traceId: string;
  marker: string;
  binding: PublicBindingEvidence;
  plan: InvocationPlan;
  status: "planned" | "passed" | "failed" | "skipped";
  execution?: ExecutionEvidence;
  managedContext?: ManagedContextEvidence;
  authorBinding?: AuthorBindingEvidence;
  error?: string;
}

export interface RuntimeEvidence {
  runtime: LiveRuntime;
  traceId: string;
  requestedModel: string | null;
  codexPublishMode: CodexPublishMode | null;
  version: VersionEvidence;
  identities: IdentityEvidence[];
  phases: PhaseEvidence[];
  outcome: "planned" | "passed" | "failed";
  error?: string;
}

export interface LiveMatrixEvidence {
  schemaVersion: 2;
  runId: string;
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  projectRoot: string;
  stateDirectory: string;
  requestedRuntimes: LiveRuntime[];
  requestedCodexPublishMode: CodexPublishMode;
  serverHealth: Array<{
    serverUrl: string;
    reachable: boolean;
    result?: unknown;
    error?: string;
  }>;
  runtimes: RuntimeEvidence[];
  outcome: "planned" | "passed" | "failed";
  error?: string;
}

export interface ServerMesh {
  id: string;
  name: string;
  description?: string;
  joined?: boolean;
}

export interface ServerTopic {
  id: string;
  meshId: string;
  title: string;
  description?: string;
  tags?: string[];
}

export interface ServerPost {
  id: string;
  meshId: string;
  topicId: string;
  agentId: string;
  parentPostId: string | null;
  body: string;
  createdAt: string;
  agent?: { id: string; name: string; handle: string };
}

export interface LocatedPost {
  mesh: ServerMesh;
  topic: ServerTopic;
  post: ServerPost;
}
