import { createHash } from "node:crypto";
import type {
  LiveMatrixEvidence,
  NativeSessionEvidence,
  RuntimeEvidence,
} from "./types.ts";
import type { OpenClawLiveEvidence } from "./openclaw-types.ts";
import type { EvidenceProvenance } from "./provenance.ts";

export interface LaunchRuntimeLifecycleWitness {
  pairingId: string;
  handle: string;
  sessionId: string;
  hostExitedAt: string;
  onlineVerifiedAt: string;
  offlineObservedAt: string;
  offlineAfterSeconds: number;
}

export interface LaunchRuntimeLifecycle {
  checked: string[];
  nativeHostLifecycle: "actual_session_offline";
  supersession: "signed_predecessor_fenced";
  offlineAfterSeconds: number;
  /** Runtime and source binding prevent a lifecycle file being swapped. */
  runtime?: string;
  sourceSha256?: string;
  witnesses?: LaunchRuntimeLifecycleWitness[];
}

export interface LaunchRuntimeReceipt {
  kind: "launch-runtime-receipt";
  schemaVersion: 1;
  provenance: EvidenceProvenance;
  source: {
    evidenceKind: "live-matrix" | "openclaw-live";
    sha256: string;
    bytes: number;
  };
  origin: string;
  serverHealth: Array<{ serverUrl: string; reachable: boolean; releaseSha: string | null }>;
  runtimes: Array<{
    runtime: string;
    outcome: "passed" | "failed" | "planned";
    version: { installed: boolean; version: string | null };
    identities: Array<{ serverUrl: string; matches: boolean }>;
    validationTarget: {
      meshId: string | null;
      topicId: string | null;
      matches: boolean;
    };
    distinctAuthors: boolean;
    phases: Array<{
      phase: "root" | "reply";
      status: string;
      authorMatches: boolean;
      meshId: string | null;
      topicId: string | null;
      expectedAgentId: string | null;
      observedAgentId: string | null;
      expectedHandle: string | null;
      observedHandle: string | null;
      pairingId: string | null;
      sessionId: string | null;
      hostExitedAt: string | null;
      onlineVerifiedAt: string | null;
      offlineObservedAt: string | null;
      offlineAfterSeconds: number | null;
    }>;
    pluginValidated?: boolean;
  }>;
  outcome: "passed" | "failed" | "planned";
  dryRun: boolean;
  lifecycle?: LaunchRuntimeLifecycle;
}

export interface LaunchRuntimeReceiptBundle {
  kind: "launch-runtime-receipt-bundle";
  schemaVersion: 1;
  receipts: LaunchRuntimeReceipt[];
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Keep diagnostic process output out of the release-facing receipt. */
function versionToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/\b\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match?.[0] ?? null;
}

function phaseReceipt(phase: {
  phase: "root" | "reply";
  status: string;
  binding?: { pairingId?: string };
  nativeSession?: NativeSessionEvidence;
  authorBinding?: {
    meshId?: string;
    topicId?: string;
    expectedAgentId?: string;
    observedAgentId?: string;
    expectedHandle?: string;
    observedHandle?: string;
    agentIdMatches: boolean;
    handleMatches: boolean;
  };
}) {
  const author = phase.authorBinding;
  return {
    phase: phase.phase,
    status: phase.status,
    authorMatches: author?.agentIdMatches === true && author.handleMatches === true,
    meshId: author?.meshId ?? null,
    topicId: author?.topicId ?? null,
    expectedAgentId: author?.expectedAgentId ?? null,
    observedAgentId: author?.observedAgentId ?? null,
    expectedHandle: author?.expectedHandle ?? null,
    observedHandle: author?.observedHandle ?? null,
    pairingId: phase.binding?.pairingId ?? null,
    sessionId: phase.nativeSession?.sessionId ?? null,
    hostExitedAt: phase.nativeSession?.hostExitedAt ?? null,
    onlineVerifiedAt: phase.nativeSession?.onlineVerifiedAt ?? null,
    offlineObservedAt: phase.nativeSession?.offlineObservedAt ?? null,
    offlineAfterSeconds: phase.nativeSession?.offlineAfterSeconds ?? null,
  };
}

function targetReceipt(phases: Array<ReturnType<typeof phaseReceipt>>, configured?: { meshId: string; topicId: string }) {
  const root = phases.find((phase) => phase.phase === "root");
  const reply = phases.find((phase) => phase.phase === "reply");
  const meshId = configured?.meshId ?? root?.meshId ?? null;
  const topicId = configured?.topicId ?? root?.topicId ?? null;
  const matches = Boolean(
    meshId &&
      topicId &&
      meshId !== "mesh-public" &&
      root?.meshId === meshId &&
      root?.topicId === topicId &&
      reply?.meshId === meshId &&
      reply?.topicId === topicId,
  );
  return { meshId, topicId, matches };
}

function distinctAuthors(phases: Array<ReturnType<typeof phaseReceipt>>): boolean {
  const root = phases.find((phase) => phase.phase === "root");
  const reply = phases.find((phase) => phase.phase === "reply");
  return Boolean(
    root?.observedAgentId &&
      reply?.observedAgentId &&
      root.observedAgentId !== reply.observedAgentId,
  );
}

function phaseLifecycleWitness(
  phase: ReturnType<typeof phaseReceipt>,
): LaunchRuntimeLifecycleWitness | undefined {
  if (
    !phase.pairingId ||
    !phase.expectedHandle ||
    !phase.sessionId ||
    !phase.hostExitedAt ||
    !phase.onlineVerifiedAt ||
    !phase.offlineObservedAt ||
    typeof phase.offlineAfterSeconds !== "number"
  ) {
    return undefined;
  }
  return {
    pairingId: phase.pairingId,
    handle: phase.expectedHandle,
    sessionId: phase.sessionId,
    hostExitedAt: phase.hostExitedAt,
    onlineVerifiedAt: phase.onlineVerifiedAt,
    offlineObservedAt: phase.offlineObservedAt,
    offlineAfterSeconds: phase.offlineAfterSeconds,
  };
}

function deriveLifecycleWitnesses(
  value: LiveMatrixEvidence | OpenClawLiveEvidence,
): LaunchRuntimeLifecycleWitness[] {
  const phases = value.schemaVersion === 1 && "kind" in value && value.kind === "openclaw-live"
    ? (value as OpenClawLiveEvidence).phases.map((phase) => phaseReceipt(phase))
    : (value as LiveMatrixEvidence).runtimes.flatMap((runtime) =>
        runtime.phases.map((phase) => phaseReceipt(phase)),
      );
  return phases
    .map(phaseLifecycleWitness)
    .filter((witness): witness is LaunchRuntimeLifecycleWitness => witness !== undefined);
}

function matrixRuntimeReceipt(
  runtime: RuntimeEvidence,
  configuredTarget?: { meshId: string; topicId: string },
) {
  const phases = runtime.phases.map(phaseReceipt);
  return {
    runtime: runtime.runtime,
    outcome: runtime.outcome,
    version: {
      installed: runtime.version.installed,
      version: versionToken(runtime.version.version),
    },
    identities: runtime.identities.map((identity) => ({
      serverUrl: identity.binding.serverUrl,
      matches: identity.matches,
    })),
    validationTarget: targetReceipt(phases, configuredTarget),
    distinctAuthors: distinctAuthors(phases),
    phases,
  };
}

export function createLaunchRuntimeReceipt(input: {
  value: LiveMatrixEvidence | OpenClawLiveEvidence;
  sourceBytes: Uint8Array;
  lifecycle?: LaunchRuntimeLifecycle;
}): LaunchRuntimeReceipt {
  const value = input.value;
  const sourceSha256 = sha256Bytes(input.sourceBytes);
  const isOpenClaw = value.schemaVersion === 1 && "kind" in value && value.kind === "openclaw-live";
  const serverHealth = "serverHealth" in value
    ? value.serverHealth.map((health) => ({
        serverUrl: health.serverUrl,
        reachable: health.reachable,
        releaseSha: health.result && typeof health.result === "object" && !Array.isArray(health.result) &&
            typeof (health.result as Record<string, unknown>).releaseSha === "string"
          ? String((health.result as Record<string, unknown>).releaseSha)
          : null,
      }))
    : [];
  const origin = serverHealth[0]?.serverUrl ?? (isOpenClaw ? (value as OpenClawLiveEvidence).plugin?.serverUrl ?? "" : "");
  const runtimes = isOpenClaw
    ? [{
        runtime: "openclaw",
        outcome: value.outcome,
        version: {
          installed: value.version?.installed === true,
          version: versionToken(value.version?.version),
        },
        identities: value.agents.map((agent) => ({
          serverUrl: agent.binding.serverUrl,
          matches: agent.identity.matches,
        })),
        validationTarget: (() => {
          const phases = value.phases.map((phase) => phaseReceipt({
            ...phase,
            authorBinding: phase.authorBinding,
          }));
          const configured = value.phases.find((phase) => phase.target)?.target;
          return targetReceipt(phases, configured ? { meshId: configured.meshId, topicId: configured.topicId } : undefined);
        })(),
        distinctAuthors: (() => {
          const phases = value.phases.map((phase) => phaseReceipt({
            ...phase,
            authorBinding: phase.authorBinding,
          }));
          return distinctAuthors(phases);
        })(),
        phases: value.phases.map(phaseReceipt),
        pluginValidated: value.plugin?.enabled === true && value.plugin.runtimeFactoryValidated === true,
      }]
    : (value as LiveMatrixEvidence).runtimes.map((runtime) =>
        matrixRuntimeReceipt(runtime, (value as LiveMatrixEvidence).validationTarget),
      );
  const lifecycle = input.lifecycle
    ? {
        ...input.lifecycle,
        runtime:
          input.lifecycle.runtime ??
          (isOpenClaw
            ? "openclaw"
            : (value as LiveMatrixEvidence).runtimes.length === 1
              ? (value as LiveMatrixEvidence).runtimes[0]!.runtime
              : "mixed"),
        sourceSha256: input.lifecycle.sourceSha256 ?? sourceSha256,
        witnesses: input.lifecycle.witnesses ?? deriveLifecycleWitnesses(value),
      }
    : undefined;
  if (lifecycle?.sourceSha256 !== sourceSha256) {
    throw new Error("lifecycle_source_sha_mismatch");
  }
  return {
    kind: "launch-runtime-receipt",
    schemaVersion: 1,
    provenance: value.provenance,
    source: {
      evidenceKind: isOpenClaw ? "openclaw-live" : "live-matrix",
      sha256: sourceSha256,
      bytes: input.sourceBytes.byteLength,
    },
    origin,
    serverHealth,
    runtimes,
    outcome: value.outcome,
    dryRun: value.dryRun,
    ...(lifecycle ? { lifecycle } : {}),
  };
}

export function isLaunchRuntimeReceipt(value: unknown): value is LaunchRuntimeReceipt {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "launch-runtime-receipt";
}

export function isLaunchRuntimeReceiptBundle(value: unknown): value is LaunchRuntimeReceiptBundle {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "launch-runtime-receipt-bundle";
}
