import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { verifyLaunchEvidenceValues } from "../scripts/verify-launch-evidence.ts";
import { createLaunchRuntimeReceipt } from "../live/receipt.ts";
import { captureEvidenceProvenance } from "../live/provenance.ts";
import type { LiveMatrixEvidence } from "../live/types.ts";
import type { OpenClawLiveEvidence } from "../live/openclaw-types.ts";

const sha = "a".repeat(40);
const origin = "https://meshr.social";
const provenance = {
  contractMajor: 1,
  gitSha: sha,
  gitBranch: "release/test",
  workingTreeClean: true,
  environment: "production" as const,
};

function binding(agentId: string, handle: string) {
  return {
    serverUrl: `${origin}/`,
    agentId,
    bindingId: `binding-${agentId}`,
    pairingId: `pairing-${agentId}`,
    runtime: "claude",
    label: handle,
    externalSubject: `claude:${handle}`,
    handle,
    status: "connected",
  };
}

function authorBinding(agentId: string, handle: string, phase: "root" | "reply") {
  return {
    postId: `${phase}-post`,
    parentPostId: phase === "root" ? null : "root-post",
    meshId: "mesh-validation",
    topicId: "topic-discoveries",
    marker: `trace:${phase}]`,
    expectedAgentId: agentId,
    observedAgentId: agentId,
    expectedHandle: handle,
    observedHandle: handle,
    agentIdMatches: true,
    handleMatches: true,
  };
}

function phases(
  rootAgentId: string,
  rootHandle: string,
  replyAgentId = rootAgentId,
  replyHandle = rootHandle,
) {
  return (["root", "reply"] as const).map((phase) => {
    const agentId = phase === "root" ? rootAgentId : replyAgentId;
    const handle = phase === "root" ? rootHandle : replyHandle;
    return {
      phase,
      traceId: `trace-${phase}`,
      marker: `trace:${phase}]`,
      binding: binding(agentId, handle),
      plan: {
        kind: "process",
        command: "claude",
        args: ["--print"],
        promptSha256: sha,
        publisher: "model-via-mcp",
        modelMeshrAccess: "invocation-local-mcp",
      },
      status: "passed",
      authorBinding: authorBinding(agentId, handle, phase),
      nativeSession: {
        sessionId: `session-${agentId}`,
        hostExitedAt: "2026-08-29T00:00:01.000Z",
        onlineVerifiedAt: "2026-08-29T00:00:02.000Z",
        offlineObservedAt: "2026-08-29T00:00:05.000Z",
        offlineAfterSeconds: 4,
      },
    };
  });
}

function matrix() {
  return {
    schemaVersion: 2,
    provenance,
    runId: "matrix-test",
    startedAt: "2026-08-29T00:00:00.000Z",
    finishedAt: "2026-08-29T00:01:00.000Z",
    dryRun: false,
    projectRoot: "/workspace/meshr",
    stateDirectory: "/workspace/state",
    requestedRuntimes: ["claude"],
    requestedCodexPublishMode: "direct-mcp",
    validationTarget: { meshId: "mesh-validation", topicId: "topic-discoveries" },
    serverHealth: [{
      serverUrl: `${origin}/`,
      reachable: true,
      result: { status: "ok", releaseSha: sha },
    }],
    runtimes: [{
      runtime: "claude",
      traceId: "trace-claude",
      requestedModel: null,
      codexPublishMode: null,
      version: {
        installed: true,
        version: "1.0.0",
        execution: { kind: "process", command: "claude", args: [], startedAt: "2026-08-29T00:00:00.000Z", elapsedMs: 1, exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", outputTruncated: false },
      },
      identities: [
        { binding: binding("agent-claude-root", "theorem"), matches: true, serverAgentId: "agent-claude-root", serverHandle: "theorem" },
        { binding: binding("agent-claude-reply", "tangent"), matches: true, serverAgentId: "agent-claude-reply", serverHandle: "tangent" },
      ],
      phases: phases("agent-claude-root", "theorem", "agent-claude-reply", "tangent"),
      outcome: "passed",
    }],
    outcome: "passed",
  };
}

function openclaw() {
  return {
    kind: "openclaw-live",
    schemaVersion: 1,
    provenance,
    runId: "openclaw-test",
    traceId: "trace-openclaw",
    startedAt: "2026-08-29T00:00:00.000Z",
    finishedAt: "2026-08-29T00:01:00.000Z",
    dryRun: false,
    projectRoot: "/workspace/meshr",
    isolation: {
      openClawCommand: "openclaw",
      openClawStateDirectory: "/workspace/openclaw",
      openClawConfigPath: "/workspace/openclaw/config.json",
      connectorStatePath: "/workspace/state.json",
      privateStateValidated: true,
    },
    serverHealth: [{
      serverUrl: `${origin}/`,
      reachable: true,
      result: { status: "ok", releaseSha: sha },
    }],
    plugin: {
      enabled: true,
      serverUrl: `${origin}/`,
      connectorStatePathMatches: true,
      runtimeFactoryValidated: true,
      pluginEntryPath: "/workspace/plugin.js",
      agents: [],
    },
    version: {
      installed: true,
      version: "2026.7.1",
      execution: { command: "openclaw", args: [], startedAt: "2026-08-29T00:00:00.000Z", elapsedMs: 1, exitCode: 0, signal: null, timedOut: false, outputTruncated: false, stdoutBytes: 0, stderrBytes: 0, stdoutSha256: sha, stderrSha256: sha, stdoutJson: true },
    },
    agents: [
      { role: "root", openClawAgentId: "root", binding: binding("agent-openclaw-root", "root"), identity: { binding: binding("agent-openclaw-root", "root"), matches: true } },
      { role: "reply", openClawAgentId: "reply", binding: binding("agent-openclaw-reply", "reply"), identity: { binding: binding("agent-openclaw-reply", "reply"), matches: true } },
    ],
    phases: phases("agent-openclaw-root", "root", "agent-openclaw-reply", "reply").map((phase) => ({
      ...phase,
      openClawAgentId: phase.phase === "root" ? "root" : "reply",
      target: { meshId: "mesh-validation", topicId: "topic-discoveries", ...(phase.phase === "reply" ? { postId: "root-post" } : {}) },
      plan: { ...phase.plan, command: "openclaw", environmentOverrides: ["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"], requiredTools: ["meshr_publish_post"], outerTimeoutMs: 30_000, openClawTimeoutSeconds: 20, attempts: 1 },
    })),
    outcome: "passed",
  };
}

const options = {
  expectedEnvironment: "production" as const,
  expectedGitSha: sha,
  expectedOrigin: origin,
  expectedValidationTarget: { meshId: "mesh-validation", topicId: "topic-discoveries" },
};

const lifecycle = {
  checked: ["theorem", "tangent"],
  nativeHostLifecycle: "actual_session_offline" as const,
  supersession: "signed_predecessor_fenced" as const,
  offlineAfterSeconds: 95,
};

function lifecycleFor(value: unknown) {
  const record = value as { kind?: string; phases?: Array<{ authorBinding?: { expectedHandle?: string } }>; runtimes?: Array<{ phases?: Array<{ authorBinding?: { expectedHandle?: string } }> }> };
  const phases = record.kind === "openclaw-live"
    ? record.phases ?? []
    : (record.runtimes ?? []).flatMap((runtime) => runtime.phases ?? []);
  return {
    ...lifecycle,
    checked: phases.map((phase) => phase.authorBinding?.expectedHandle ?? "").filter(Boolean),
  };
}

function receiptFor(value: unknown) {
  return createLaunchRuntimeReceipt({
    value: value as LiveMatrixEvidence,
    sourceBytes: Buffer.from(JSON.stringify(value)),
    lifecycle: lifecycleFor(value),
  });
}

test("ignores the temporary Google auth credential artifact in release provenance", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "meshr-provenance-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", projectRoot, ...args], { stdio: "ignore" });
  try {
    await writeFile(join(projectRoot, ".gitignore"), "gha-creds-*.json\n", { mode: 0o600 });
    await writeFile(join(projectRoot, "tracked.txt"), "tracked\n", { mode: 0o600 });
    git("init", "-q");
    git("config", "user.email", "meshr-tests@example.test");
    git("config", "user.name", "Meshr tests");
    git("add", ".gitignore", "tracked.txt");
    git("commit", "-q", "-m", "initial");
    await writeFile(join(projectRoot, "gha-creds-meshr.json"), "{\"token\":\"redacted\"}\n", { mode: 0o600 });

    const provenance = await captureEvidenceProvenance(projectRoot, "production");
    assert.equal(provenance.workingTreeClean, true);
    assert.match(provenance.gitSha ?? "", /^[0-9a-f]{40}$/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("requires redacted receipts instead of accepting detailed diagnostics", () => {
  assert.throws(
    () => verifyLaunchEvidenceValues([
      { path: "matrix.json", value: matrix() },
      { path: "openclaw.json", value: openclaw() },
    ], options),
    /receipt_required/,
  );
});

test("rejects wrong release SHA, dirty evidence, local evidence, and loopback origin", () => {
  assert.throws(() => verifyLaunchEvidenceValues([{ path: "matrix", value: receiptFor(matrix()) }], { ...options, expectedGitSha: "b".repeat(40) }), /git_sha_mismatch/);
  assert.throws(() => verifyLaunchEvidenceValues([{ path: "matrix", value: receiptFor({ ...matrix(), provenance: { ...provenance, workingTreeClean: false } }) }], options), /working_tree_must_be_clean/);
  assert.throws(() => verifyLaunchEvidenceValues([{ path: "matrix", value: receiptFor({ ...matrix(), provenance: { ...provenance, environment: "local" } }) }], options), /environment_mismatch/);
  assert.throws(() => verifyLaunchEvidenceValues([{ path: "matrix", value: receiptFor(matrix()) }], { ...options, expectedOrigin: "http://127.0.0.1:8787" }), /origin_must_be_https_origin|origin_must_not_be_loopback/);
});

test("rejects origin drift, dry runs, missing runtimes, and untagged OpenClaw evidence", () => {
  assert.throws(() => verifyLaunchEvidenceValues([{ path: "matrix", value: receiptFor({ ...matrix(), serverHealth: [{ serverUrl: "https://staging.meshr.social/", reachable: true, result: { releaseSha: sha } }] }) }], options), /server_origin_mismatch|receipt_origin_mismatch/);
  assert.throws(() => verifyLaunchEvidenceValues([{ path: "matrix", value: receiptFor({ ...matrix(), dryRun: true }) }], options), /dry_run_not_release_evidence/);
  assert.throws(() => verifyLaunchEvidenceValues([{ path: "matrix", value: receiptFor(matrix()) }], { ...options, requiredRuntimes: ["codex"] }), /required_runtime_missing:codex/);
  const { kind: _kind, ...untagged } = openclaw();
  assert.throws(() => verifyLaunchEvidenceValues([{ path: "openclaw", value: untagged }], { ...options, requiredRuntimes: ["openclaw"] }), /receipt_required/);
});

test("rejects every loopback origin form", () => {
  for (const host of ["127.0.0.2", "foo.localhost", "[::1]"]) {
    assert.throws(
      () => verifyLaunchEvidenceValues([
        { path: "receipt", value: createLaunchRuntimeReceipt({
          value: { ...matrix(), serverHealth: [{ serverUrl: `https://${host}/`, reachable: true, result: { releaseSha: sha } }] } as unknown as LiveMatrixEvidence,
          sourceBytes: Buffer.from("source"),
          lifecycle: lifecycleFor(matrix()),
        }) },
      ], { ...options, requiredRuntimes: ["claude"] }),
      /origin_must_not_be_loopback|origin_must_be_https_origin/,
    );
  }
});

test("accepts redacted runtime receipts and bundles", () => {
  const matrixValue = matrix() as unknown as LiveMatrixEvidence;
  const openclawValue = openclaw() as unknown as OpenClawLiveEvidence;
  const matrixReceipt = createLaunchRuntimeReceipt({
    value: matrixValue,
    sourceBytes: Buffer.from(JSON.stringify(matrixValue)),
    lifecycle: lifecycleFor(matrixValue),
  });
  const openclawReceipt = createLaunchRuntimeReceipt({
    value: openclawValue,
    sourceBytes: Buffer.from(JSON.stringify(openclawValue)),
    lifecycle: lifecycleFor(openclawValue),
  });
  assert.equal("plan" in matrixReceipt, false);
  assert.equal("prompt" in matrixReceipt, false);
  assert.deepEqual(
    verifyLaunchEvidenceValues([{ path: "receipt", value: matrixReceipt }], { ...options, requiredRuntimes: ["claude"] }).runtimeEvidence,
    ["claude"],
  );
  const summary = verifyLaunchEvidenceValues([{
    path: "bundle",
    value: { kind: "launch-runtime-receipt-bundle", schemaVersion: 1, receipts: [matrixReceipt, openclawReceipt] },
  }], options);
  assert.deepEqual(summary.runtimeEvidence.sort(), ["claude", "openclaw"]);
});

test("receipt version fields contain only a bounded version token", () => {
  const value = matrix() as unknown as LiveMatrixEvidence;
  value.runtimes[0]!.version.version = "Claude Code 1.2.3 (build secret-provider-output)";
  const receipt = createLaunchRuntimeReceipt({
    value,
    sourceBytes: Buffer.from("source"),
    lifecycle,
  });
  assert.equal(receipt.runtimes[0]!.version.version, "1.2.3");
  assert.doesNotMatch(JSON.stringify(receipt), /secret-provider-output/);
});

test("rejects tampered receipt source and author gates", () => {
  const receipt = createLaunchRuntimeReceipt({
    value: matrix() as unknown as LiveMatrixEvidence,
    sourceBytes: Buffer.from("source"),
    lifecycle,
  });
  assert.throws(() => verifyLaunchEvidenceValues([{
    path: "receipt",
    value: { ...receipt, source: { ...receipt.source, sha256: "not-a-sha256" } },
  }], { ...options, requiredRuntimes: ["claude"] }), /receipt_source_hash_invalid/);
  assert.throws(() => verifyLaunchEvidenceValues([{
    path: "receipt",
    value: {
      ...receipt,
      runtimes: receipt.runtimes.map((runtime) => ({
        ...runtime,
        phases: runtime.phases.map((phase) => phase.phase === "reply" ? { ...phase, authorMatches: false } : phase),
      })),
    },
  }], { ...options, requiredRuntimes: ["claude"] }), /phase_author_must_pass|reply_must_pass/);
  assert.throws(() => verifyLaunchEvidenceValues([{
    path: "receipt",
    value: { ...receipt, lifecycle: { ...lifecycle, nativeHostLifecycle: "claimed_only" } },
  }], { ...options, requiredRuntimes: ["claude"] }), /native_host_offline_proof_required/);
  assert.throws(() => verifyLaunchEvidenceValues([{
    path: "receipt",
    value: { ...receipt, lifecycle: { ...receipt.lifecycle!, sourceSha256: "b".repeat(64) } },
  }], { ...options, requiredRuntimes: ["claude"] }), /lifecycle_source_sha_mismatch/);
  assert.throws(() => verifyLaunchEvidenceValues([{
    path: "receipt",
    value: {
      ...receipt,
      lifecycle: {
        ...receipt.lifecycle!,
        witnesses: receipt.lifecycle!.witnesses!.map((witness, index) =>
          index === 0
            ? { ...witness, sessionId: receipt.lifecycle!.witnesses![1]!.sessionId }
            : witness,
        ),
      },
    },
  }], { ...options, requiredRuntimes: ["claude"] }), /lifecycle_session_mismatch/);
  assert.throws(() => verifyLaunchEvidenceValues([{
    path: "receipt",
    value: {
      ...receipt,
      lifecycle: { ...receipt.lifecycle!, runtime: "openclaw" },
    },
  }], { ...options, requiredRuntimes: ["claude"] }), /lifecycle_runtime_mismatch/);
  assert.throws(() => verifyLaunchEvidenceValues([{
    path: "receipt",
    value: {
      ...receipt,
      lifecycle: {
        ...receipt.lifecycle!,
        witnesses: receipt.lifecycle!.witnesses!.map((witness) => ({
          ...witness,
          offlineAfterSeconds: witness.offlineAfterSeconds - 2,
        })),
      },
    },
  }], { ...options, requiredRuntimes: ["claude"] }), /offline_duration_mismatch/);
});
