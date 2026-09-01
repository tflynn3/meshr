import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { MeshrApi } from "../connector/api.ts";
import { ConnectorStateStore } from "../connector/state.ts";
import type { ConnectorBinding } from "../connector/types.ts";
import { captureEvidenceProvenance } from "./provenance.ts";
import {
  buildClaudeInvocation,
  buildCodexInvocation,
  buildManagedCodexInvocation,
  claudeMcpConfig,
  managedCodexEnvironment,
  redactInvocation,
  type ProcessInvocation,
} from "./invocations.ts";
import {
  managedReplyPrompt,
  managedRootPrompt,
  parseManagedBody,
} from "./managed.ts";
import { invokeOllama } from "./ollama.ts";
import { readVersion, runProcess } from "./process.ts";
import { observeNativeSessionOffline } from "./session-lifecycle.ts";
import {
  ollamaReplyPrompt,
  ollamaRootPrompt,
  promptDigest,
  replyPrompt,
  rootPrompt,
  traceMarker,
} from "./prompts.ts";
import {
  authorBindingEvidence,
  configuredReleaseValidationTarget,
  discoverContext,
  locateMarkedPost,
  publicBinding,
  publishReply,
  publishRoot,
  readTargetContext,
  selectRuntimeBindings,
  verifyIdentity,
} from "./server.ts";
import type {
  InvocationPlan,
  LiveMatrixEvidence,
  LiveMatrixOptions,
  LivePhase,
  LiveRuntime,
  PhaseEvidence,
  RuntimeEvidence,
  VersionEvidence,
} from "./types.ts";

interface PreparedInvocation {
  invocation: ProcessInvocation;
  plan: InvocationPlan;
}

interface PreparedManagedInvocation extends PreparedInvocation {
  outputPath: string;
}

interface SelectedRuntime {
  bindings?: [ConnectorBinding, ConnectorBinding];
  error?: string;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function phaseOutputSchema(
  traceId: string,
  phase: LivePhase,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      traceId: { type: "string", enum: [traceId] },
      action: {
        type: "string",
        enum: [phase === "root" ? "root_published" : "reply_published"],
      },
    },
    required: ["traceId", "action"],
  };
}

export function managedBodyOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      body: { type: "string", minLength: 1, maxLength: 500 },
    },
    required: ["body"],
  };
}

async function prepareIsolatedInvocation(input: {
  temporaryDirectory: string;
  runtime: "codex" | "claude";
  phase: LivePhase;
  outputSchema: Record<string, unknown>;
}): Promise<{ workingDirectory: string; outputSchemaPath: string }> {
  // Keep both the subprocess cwd and Codex's declared workspace empty. The
  // schema lives beside it so the model cannot inspect it through workspace
  // file tools even if a future host regresses its tool filtering.
  const workingDirectory = await mkdtemp(
    join(
      input.temporaryDirectory,
      `${phaseShellName(input.runtime, input.phase)}-workspace-`,
    ),
  );
  const outputSchemaPath = join(
    input.temporaryDirectory,
    `${phaseShellName(input.runtime, input.phase)}-output.schema.json`,
  );
  await writeFile(
    outputSchemaPath,
    `${JSON.stringify(input.outputSchema, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { workingDirectory, outputSchemaPath };
}

function phaseShellName(runtime: LiveRuntime, phase: LivePhase): string {
  return `${runtime}-${phase}`;
}

async function prepareProcessInvocation(input: {
  runtime: "codex" | "claude";
  traceId: string;
  binding: ConnectorBinding;
  prompt: string;
  options: LiveMatrixOptions;
  stateDirectory: string;
  temporaryDirectory: string;
  phase: LivePhase;
}): Promise<PreparedInvocation> {
  const outputSchema = phaseOutputSchema(input.traceId, input.phase);
  const isolation = await prepareIsolatedInvocation({
    temporaryDirectory: input.temporaryDirectory,
    runtime: input.runtime,
    phase: input.phase,
    outputSchema,
  });
  let invocation: ProcessInvocation;
  if (input.runtime === "codex") {
    invocation = buildCodexInvocation({
      executable: input.options.commands.codex,
      projectRoot: input.options.projectRoot,
      workingDirectory: isolation.workingDirectory,
      stateDirectory: input.stateDirectory,
      binding: input.binding,
      prompt: input.prompt,
      outputPath: join(
        input.temporaryDirectory,
        `${phaseShellName(input.runtime, input.phase)}-last-message.json`,
      ),
      outputSchemaPath: isolation.outputSchemaPath,
      model: input.options.models.codex,
    });
  } else {
    const configPath = join(
      input.temporaryDirectory,
      `${phaseShellName(input.runtime, input.phase)}-mcp.json`,
    );
    await writeFile(
      configPath,
      `${JSON.stringify(
        claudeMcpConfig({
          projectRoot: input.options.projectRoot,
          stateDirectory: input.stateDirectory,
          binding: input.binding,
        }),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    invocation = buildClaudeInvocation({
      executable: input.options.commands.claude,
      workingDirectory: isolation.workingDirectory,
      prompt: input.prompt,
      mcpConfigPath: configPath,
      budgetUsd: input.options.claudeBudgetUsd,
      outputSchema,
      model: input.options.models.claude,
    });
  }
  const redacted = redactInvocation(invocation, input.prompt);
  return {
    invocation,
    plan: {
      kind: "process",
      command: redacted.command,
      args: redacted.args,
      promptSha256: promptDigest(input.prompt),
      publisher: "model-via-mcp",
      modelMeshrAccess: "invocation-local-mcp",
    },
  };
}

async function prepareManagedCodexInvocation(input: {
  prompt: string;
  options: LiveMatrixOptions;
  temporaryDirectory: string;
  phase: LivePhase;
}): Promise<PreparedManagedInvocation> {
  const isolation = await prepareIsolatedInvocation({
    temporaryDirectory: input.temporaryDirectory,
    runtime: "codex",
    phase: input.phase,
    outputSchema: managedBodyOutputSchema(),
  });
  const outputPath = join(
    input.temporaryDirectory,
    `${phaseShellName("codex", input.phase)}-managed-last-message.json`,
  );
  const invocation = buildManagedCodexInvocation({
    executable: input.options.commands.codex,
    workingDirectory: isolation.workingDirectory,
    prompt: input.prompt,
    outputPath,
    outputSchemaPath: isolation.outputSchemaPath,
    model: input.options.models.codex,
  });
  const redacted = redactInvocation(invocation, input.prompt);
  return {
    invocation,
    outputPath,
    plan: {
      kind: "process",
      command: redacted.command,
      args: redacted.args,
      promptSha256: promptDigest(input.prompt),
      publisher: "connector",
      modelMeshrAccess: "none",
    },
  };
}

async function readManagedCodexBody(
  outputPath: string,
  marker: string,
): Promise<string> {
  const metadata = await stat(outputPath);
  if (metadata.size > 16_000) {
    throw new Error("Managed Codex last-message file exceeded 16000 bytes.");
  }
  return parseManagedBody(await readFile(outputPath, "utf8"), marker);
}

function ollamaPlan(
  options: LiveMatrixOptions,
  prompt: string,
): InvocationPlan {
  return {
    kind: "http",
    url: `${options.ollamaUrl.replace(/\/$/, "")}/api/generate`,
    promptSha256: promptDigest(prompt),
    publisher: "connector",
    modelMeshrAccess: "none",
  };
}

function emptyPhase(input: {
  phase: LivePhase;
  traceId: string;
  binding: ConnectorBinding;
  plan: InvocationPlan;
  status: PhaseEvidence["status"];
  error?: string;
}): PhaseEvidence {
  return {
    phase: input.phase,
    traceId: input.traceId,
    marker: traceMarker(input.traceId, input.phase),
    binding: publicBinding(input.binding),
    plan: input.plan,
    status: input.status,
    ...(input.error ? { error: input.error } : {}),
  };
}

async function reloadActiveBinding(
  stateDirectory: string,
  binding: ConnectorBinding,
): Promise<ConnectorBinding> {
  const current = await new ConnectorStateStore(stateDirectory).require(
    binding.pairingId,
  );
  if (current.status !== "connected" || !current.agentToken || !current.sessionId) {
    throw new Error(
      `Native host did not leave an active session for binding ${binding.pairingId}.`,
    );
  }
  return current;
}

async function plannedPhases(input: {
  runtime: LiveRuntime;
  traceId: string;
  bindings: [ConnectorBinding, ConnectorBinding];
  options: LiveMatrixOptions;
  stateDirectory: string;
  temporaryDirectory: string;
  status: "planned" | "skipped";
  error?: string;
}): Promise<PhaseEvidence[]> {
  if (
    input.runtime === "codex" &&
    input.options.codexPublishMode === "managed"
  ) {
    const profile = {
      name: "<connected-agent-name>",
      handle: "<connected-agent-handle>",
      tagline: "<connected-agent-tagline>",
      interests: ["<connected-agent-interest>"],
      personality: "<connected-agent-personality>",
    };
    const mesh = {
      id: "<discovered-mesh-id>",
      name: "<discovered-mesh-name>",
    };
    const topic = {
      id: "<discovered-topic-id>",
      meshId: mesh.id,
      title: "<discovered-conversation-title>",
    };
    const rootPromptPlan = managedRootPrompt({
      traceId: input.traceId,
      profile,
      mesh,
      topic,
      recentPosts: [],
    });
    const replyPromptPlan = managedReplyPrompt({
      traceId: input.traceId,
      profile,
      mesh,
      topic,
      rootPost: {
        id: "<verified-root-post-id>",
        meshId: mesh.id,
        topicId: topic.id,
        agentId: "<verified-root-agent-id>",
        parentPostId: null,
        body: traceMarker(input.traceId, "root"),
        createdAt: "<root-created-at>",
      },
      recentPosts: [],
    });
    const rootInvocation = await prepareManagedCodexInvocation({
      prompt: rootPromptPlan.prompt,
      options: input.options,
      temporaryDirectory: input.temporaryDirectory,
      phase: "root",
    });
    const replyInvocation = await prepareManagedCodexInvocation({
      prompt: replyPromptPlan.prompt,
      options: input.options,
      temporaryDirectory: input.temporaryDirectory,
      phase: "reply",
    });
    return [
      emptyPhase({
        phase: "root",
        traceId: input.traceId,
        binding: input.bindings[0],
        plan: rootInvocation.plan,
        status: input.status,
        error: input.error,
      }),
      emptyPhase({
        phase: "reply",
        traceId: input.traceId,
        binding: input.bindings[1],
        plan: replyInvocation.plan,
        status: input.status,
        error: input.error,
      }),
    ];
  }
  const root = rootPrompt(input.traceId);
  const reply = replyPrompt(input.traceId, {
    meshId: "<discovered-mesh-id>",
    topicId: "<discovered-topic-id>",
    postId: "<verified-root-post-id>",
  });
  if (input.runtime === "ollama") {
    return [
      emptyPhase({
        phase: "root",
        traceId: input.traceId,
        binding: input.bindings[0],
        plan: ollamaPlan(input.options, root),
        status: input.status,
        error: input.error,
      }),
      emptyPhase({
        phase: "reply",
        traceId: input.traceId,
        binding: input.bindings[1],
        plan: ollamaPlan(input.options, reply),
        status: input.status,
        error: input.error,
      }),
    ];
  }
  const rootInvocation = await prepareProcessInvocation({
    runtime: input.runtime,
    traceId: input.traceId,
    binding: input.bindings[0],
    prompt: root,
    options: input.options,
    stateDirectory: input.stateDirectory,
    temporaryDirectory: input.temporaryDirectory,
    phase: "root",
  });
  const replyInvocation = await prepareProcessInvocation({
    runtime: input.runtime,
    traceId: input.traceId,
    binding: input.bindings[1],
    prompt: reply,
    options: input.options,
    stateDirectory: input.stateDirectory,
    temporaryDirectory: input.temporaryDirectory,
    phase: "reply",
  });
  return [
    emptyPhase({
      phase: "root",
      traceId: input.traceId,
      binding: input.bindings[0],
      plan: rootInvocation.plan,
      status: input.status,
      error: input.error,
    }),
    emptyPhase({
      phase: "reply",
      traceId: input.traceId,
      binding: input.bindings[1],
      plan: replyInvocation.plan,
      status: input.status,
      error: input.error,
    }),
  ];
}

async function runManagedCodexRuntime(input: {
  traceId: string;
  bindings: [ConnectorBinding, ConnectorBinding];
  options: LiveMatrixOptions;
  stateDirectory: string;
  temporaryDirectory: string;
}): Promise<PhaseEvidence[]> {
  const phases: PhaseEvidence[] = [];
  let rootLocated: Awaited<ReturnType<typeof locateMarkedPost>> | undefined;
  let rootPhase: PhaseEvidence | undefined;
  try {
    const context = await discoverContext(
      input.bindings[0],
      input.options.timeoutMs,
    );
    const managedPrompt = managedRootPrompt({
      traceId: input.traceId,
      profile: context.profile,
      mesh: context.mesh,
      topic: context.topic,
      recentPosts: context.posts,
    });
    const prepared = await prepareManagedCodexInvocation({
      prompt: managedPrompt.prompt,
      options: input.options,
      temporaryDirectory: input.temporaryDirectory,
      phase: "root",
    });
    rootPhase = emptyPhase({
      phase: "root",
      traceId: input.traceId,
      binding: input.bindings[0],
      plan: prepared.plan,
      status: "failed",
    });
    rootPhase.managedContext = managedPrompt.contextEvidence;
    rootPhase.execution = await runProcess({
      ...prepared.invocation,
      timeoutMs: input.options.timeoutMs,
      env: managedCodexEnvironment(process.env),
    });
    rootPhase.execution.args = prepared.plan.args ?? [];
    if (
      rootPhase.execution.exitCode !== 0 ||
      rootPhase.execution.timedOut ||
      rootPhase.execution.error
    ) {
      throw new Error(
        rootPhase.execution.error ??
          `Codex exited ${rootPhase.execution.exitCode ?? "without a code"}${rootPhase.execution.timedOut ? " after timeout" : ""}.`,
      );
    }
    const body = await readManagedCodexBody(
      prepared.outputPath,
      rootPhase.marker,
    );
    await publishRoot({
      binding: input.bindings[0],
      meshId: context.mesh.id,
      topicId: context.topic.id,
      body,
      idempotencyKey: `${input.traceId}:root`,
      timeoutMs: input.options.timeoutMs,
    });
    rootLocated = await locateMarkedPost({
      binding: input.bindings[0],
      marker: rootPhase.marker,
      timeoutMs: input.options.timeoutMs,
      parentPostId: null,
      targetMeshId: context.mesh.id,
      targetTopicId: context.topic.id,
    });
    rootPhase.authorBinding = authorBindingEvidence(
      input.bindings[0],
      rootPhase.marker,
      rootLocated,
    );
    if (
      !rootPhase.authorBinding.agentIdMatches ||
      !rootPhase.authorBinding.handleMatches
    ) {
      throw new Error(
        "Managed root post author does not match the first connector binding.",
      );
    }
    rootPhase.status = "passed";
    phases.push(rootPhase);
  } catch (error) {
    const planned = await plannedPhases({
      ...input,
      runtime: "codex",
      status: "skipped",
      error: "Managed root phase failed; reply was not attempted.",
    });
    if (rootPhase) {
      rootPhase.status = "failed";
      rootPhase.error = errorText(error);
      phases.push(rootPhase);
    } else {
      planned[0]!.status = "failed";
      planned[0]!.error = errorText(error);
      phases.push(planned[0]!);
    }
    phases.push(planned[1]!);
    return phases;
  }

  let replyPhase: PhaseEvidence | undefined;
  try {
    const context = await readTargetContext({
      binding: input.bindings[1],
      meshId: rootLocated!.post.meshId,
      topicId: rootLocated!.post.topicId,
      timeoutMs: input.options.timeoutMs,
    });
    const observedRoot = context.posts.find(
      (post) => post.id === rootLocated!.post.id,
    );
    if (!observedRoot) {
      throw new Error(
        "Second managed Codex agent did not observe the root post.",
      );
    }
    const managedPrompt = managedReplyPrompt({
      traceId: input.traceId,
      profile: context.profile,
      mesh: rootLocated!.mesh,
      topic: context.topic,
      rootPost: observedRoot,
      recentPosts: context.posts,
    });
    const prepared = await prepareManagedCodexInvocation({
      prompt: managedPrompt.prompt,
      options: input.options,
      temporaryDirectory: input.temporaryDirectory,
      phase: "reply",
    });
    replyPhase = emptyPhase({
      phase: "reply",
      traceId: input.traceId,
      binding: input.bindings[1],
      plan: prepared.plan,
      status: "failed",
    });
    replyPhase.managedContext = managedPrompt.contextEvidence;
    replyPhase.execution = await runProcess({
      ...prepared.invocation,
      timeoutMs: input.options.timeoutMs,
      env: managedCodexEnvironment(process.env),
    });
    replyPhase.execution.args = prepared.plan.args ?? [];
    if (
      replyPhase.execution.exitCode !== 0 ||
      replyPhase.execution.timedOut ||
      replyPhase.execution.error
    ) {
      throw new Error(
        replyPhase.execution.error ??
          `Codex exited ${replyPhase.execution.exitCode ?? "without a code"}${replyPhase.execution.timedOut ? " after timeout" : ""}.`,
      );
    }
    const body = await readManagedCodexBody(
      prepared.outputPath,
      replyPhase.marker,
    );
    await publishReply({
      binding: input.bindings[1],
      postId: rootLocated!.post.id,
      body,
      idempotencyKey: `${input.traceId}:reply`,
      timeoutMs: input.options.timeoutMs,
    });
    const located = await locateMarkedPost({
      binding: input.bindings[1],
      marker: replyPhase.marker,
      timeoutMs: input.options.timeoutMs,
      parentPostId: rootLocated!.post.id,
      targetMeshId: rootLocated!.post.meshId,
      targetTopicId: rootLocated!.post.topicId,
    });
    replyPhase.authorBinding = authorBindingEvidence(
      input.bindings[1],
      replyPhase.marker,
      located,
    );
    if (
      !replyPhase.authorBinding.agentIdMatches ||
      !replyPhase.authorBinding.handleMatches
    ) {
      throw new Error(
        "Managed reply author does not match the second connector binding.",
      );
    }
    replyPhase.status = "passed";
    phases.push(replyPhase);
  } catch (error) {
    if (replyPhase) {
      replyPhase.status = "failed";
      replyPhase.error = errorText(error);
      phases.push(replyPhase);
    } else {
      const planned = await plannedPhases({
        ...input,
        runtime: "codex",
        status: "skipped",
        error: errorText(error),
      });
      planned[1]!.status = "failed";
      phases.push(planned[1]!);
    }
  }
  return phases;
}

async function runCliRuntime(input: {
  runtime: "codex" | "claude";
  traceId: string;
  bindings: [ConnectorBinding, ConnectorBinding];
  options: LiveMatrixOptions;
  stateDirectory: string;
  temporaryDirectory: string;
  observeNativeSessions: boolean;
}): Promise<PhaseEvidence[]> {
  const phases: PhaseEvidence[] = [];
  // A release acceptance run supplies an exact private validation target. Do
  // the discovery while the harness still owns the preflight session, then
  // pin both the native prompt and the post locator to those IDs. The native
  // host receives no MESHR_* environment variables, so it cannot silently
  // fall back to the public commons if its model follows a heuristic.
  let rootTarget: { meshId: string; topicId: string } | undefined;
  const configuredTarget = configuredReleaseValidationTarget();
  if (configuredTarget.meshId && configuredTarget.topicId) {
    const context = await discoverContext(
      input.bindings[0],
      input.options.timeoutMs,
    );
    rootTarget = { meshId: context.mesh.id, topicId: context.topic.id };
    if (
      rootTarget.meshId !== configuredTarget.meshId ||
      rootTarget.topicId !== configuredTarget.topicId
    ) {
      throw new Error(
        "Release validation discovery did not resolve the configured private mesh and topic.",
      );
    }
    // Fail before starting the first native host if the reply identity cannot
    // read the same private conversation.
    await readTargetContext({
      binding: input.bindings[1],
      meshId: rootTarget.meshId,
      topicId: rootTarget.topicId,
      timeoutMs: input.options.timeoutMs,
    });
  }
  const rootText = rootPrompt(input.traceId, rootTarget);
  const preparedRoot = await prepareProcessInvocation({
    runtime: input.runtime,
    traceId: input.traceId,
    binding: input.bindings[0],
    prompt: rootText,
    options: input.options,
    stateDirectory: input.stateDirectory,
    temporaryDirectory: input.temporaryDirectory,
    phase: "root",
  });
  const rootPhase = emptyPhase({
    phase: "root",
    traceId: input.traceId,
    binding: input.bindings[0],
    plan: preparedRoot.plan,
    status: "failed",
  });
  rootPhase.execution = await runProcess({
    ...preparedRoot.invocation,
    timeoutMs: input.options.timeoutMs,
  });
  const rootHostExitedAt = new Date().toISOString();
  if (
    rootPhase.execution.exitCode !== 0 ||
    rootPhase.execution.timedOut ||
    rootPhase.execution.error
  ) {
    rootPhase.error =
      rootPhase.execution.error ??
      `Runtime exited ${rootPhase.execution.exitCode ?? "without a code"}${rootPhase.execution.timedOut ? " after timeout" : ""}.`;
    phases.push(rootPhase);
    const skipped = await plannedPhases({
      ...input,
      status: "skipped",
      error: "Root phase failed; reply was not attempted.",
    });
    phases.push(skipped[1]!);
    return phases;
  }
  let located: Awaited<ReturnType<typeof locateMarkedPost>>;
  try {
    // The native MCP server deliberately starts a fresh signed session and
    // atomically supersedes the preflight token. Re-read the private state
    // written by that host before using the harness for readback; otherwise a
    // successful post would be invisible behind the old session fence.
    const activeRootBinding = await reloadActiveBinding(
      input.stateDirectory,
      input.bindings[0],
    );
    rootPhase.binding = publicBinding(activeRootBinding);
    const rootReadback = input.observeNativeSessions
      ? await observeNativeSessionOffline(
          activeRootBinding,
          () =>
            locateMarkedPost({
              binding: activeRootBinding,
              marker: rootPhase.marker,
              timeoutMs: input.options.timeoutMs,
              parentPostId: null,
              targetMeshId: rootTarget?.meshId,
              targetTopicId: rootTarget?.topicId,
            }),
          { hostExitedAt: rootHostExitedAt },
        )
      : undefined;
    located =
      rootReadback?.value ??
      (await locateMarkedPost({
        binding: activeRootBinding,
        marker: rootPhase.marker,
        timeoutMs: input.options.timeoutMs,
        parentPostId: null,
        targetMeshId: rootTarget?.meshId,
        targetTopicId: rootTarget?.topicId,
      }));
    rootPhase.authorBinding = authorBindingEvidence(
      activeRootBinding,
      rootPhase.marker,
      located,
    );
    if (
      !rootPhase.authorBinding.agentIdMatches ||
      !rootPhase.authorBinding.handleMatches
    ) {
      throw new Error(
        "Root post author does not match the first connector binding.",
      );
    }
    rootPhase.nativeSession = {
      sessionId: activeRootBinding.sessionId!,
      onlineVerifiedAt: new Date().toISOString(),
      ...(rootReadback?.observation ?? {}),
    };
    rootPhase.status = "passed";
  } catch (error) {
    rootPhase.error = errorText(error);
    phases.push(rootPhase);
    const skipped = await plannedPhases({
      ...input,
      status: "skipped",
      error: "Root verification failed; reply was not attempted.",
    });
    phases.push(skipped[1]!);
    return phases;
  }
  phases.push(rootPhase);

  const replyText = replyPrompt(input.traceId, {
    meshId: located.post.meshId,
    topicId: located.post.topicId,
    postId: located.post.id,
  });
  const preparedReply = await prepareProcessInvocation({
    runtime: input.runtime,
    traceId: input.traceId,
    binding: input.bindings[1],
    prompt: replyText,
    options: input.options,
    stateDirectory: input.stateDirectory,
    temporaryDirectory: input.temporaryDirectory,
    phase: "reply",
  });
  const replyPhase = emptyPhase({
    phase: "reply",
    traceId: input.traceId,
    binding: input.bindings[1],
    plan: preparedReply.plan,
    status: "failed",
  });
  replyPhase.execution = await runProcess({
    ...preparedReply.invocation,
    timeoutMs: input.options.timeoutMs,
  });
  const replyHostExitedAt = new Date().toISOString();
  if (
    replyPhase.execution.exitCode !== 0 ||
    replyPhase.execution.timedOut ||
    replyPhase.execution.error
  ) {
    replyPhase.error =
      replyPhase.execution.error ??
      `Runtime exited ${replyPhase.execution.exitCode ?? "without a code"}${replyPhase.execution.timedOut ? " after timeout" : ""}.`;
    phases.push(replyPhase);
    return phases;
  }
  try {
    const activeReplyBinding = await reloadActiveBinding(
      input.stateDirectory,
      input.bindings[1],
    );
    replyPhase.binding = publicBinding(activeReplyBinding);
    const replyReadback = input.observeNativeSessions
      ? await observeNativeSessionOffline(
          activeReplyBinding,
          () =>
            locateMarkedPost({
              binding: activeReplyBinding,
              marker: replyPhase.marker,
              timeoutMs: input.options.timeoutMs,
              parentPostId: located.post.id,
              targetMeshId: located.post.meshId,
              targetTopicId: located.post.topicId,
            }),
          { hostExitedAt: replyHostExitedAt },
        )
      : undefined;
    const replyLocated =
      replyReadback?.value ??
      (await locateMarkedPost({
        binding: activeReplyBinding,
        marker: replyPhase.marker,
        timeoutMs: input.options.timeoutMs,
        parentPostId: located.post.id,
        targetMeshId: located.post.meshId,
        targetTopicId: located.post.topicId,
      }));
    replyPhase.authorBinding = authorBindingEvidence(
      activeReplyBinding,
      replyPhase.marker,
      replyLocated,
    );
    if (
      !replyPhase.authorBinding.agentIdMatches ||
      !replyPhase.authorBinding.handleMatches
    ) {
      throw new Error(
        "Reply author does not match the second connector binding.",
      );
    }
    replyPhase.nativeSession = {
      sessionId: activeReplyBinding.sessionId!,
      onlineVerifiedAt: new Date().toISOString(),
      ...(replyReadback?.observation ?? {}),
    };
    replyPhase.status = "passed";
  } catch (error) {
    replyPhase.error = errorText(error);
  }
  phases.push(replyPhase);
  return phases;
}

async function runOllamaRuntime(input: {
  traceId: string;
  bindings: [ConnectorBinding, ConnectorBinding];
  options: LiveMatrixOptions;
}): Promise<PhaseEvidence[]> {
  const phases: PhaseEvidence[] = [];
  const model = input.options.models.ollama!;
  let rootLocated: Awaited<ReturnType<typeof locateMarkedPost>> | undefined;
  let rootPhase: PhaseEvidence | undefined;
  try {
    const context = await discoverContext(
      input.bindings[0],
      input.options.timeoutMs,
    );
    const prompt = ollamaRootPrompt({
      traceId: input.traceId,
      profile: context.profile,
      topic: context.topic,
      recentPosts: context.posts,
    });
    rootPhase = emptyPhase({
      phase: "root",
      traceId: input.traceId,
      binding: input.bindings[0],
      plan: ollamaPlan(input.options, prompt),
      status: "failed",
    });
    const result = await invokeOllama({
      baseUrl: input.options.ollamaUrl,
      model,
      prompt,
      marker: rootPhase.marker,
      timeoutMs: input.options.timeoutMs,
    });
    rootPhase.execution = result.execution;
    if (!result.body)
      throw new Error(
        result.execution.error ?? "Ollama produced no root post.",
      );
    await publishRoot({
      binding: input.bindings[0],
      meshId: context.mesh.id,
      topicId: context.topic.id,
      body: result.body,
      idempotencyKey: `${input.traceId}:root`,
      timeoutMs: input.options.timeoutMs,
    });
    rootLocated = await locateMarkedPost({
      binding: input.bindings[0],
      marker: rootPhase.marker,
      timeoutMs: input.options.timeoutMs,
      parentPostId: null,
      targetMeshId: context.mesh.id,
      targetTopicId: context.topic.id,
    });
    rootPhase.authorBinding = authorBindingEvidence(
      input.bindings[0],
      rootPhase.marker,
      rootLocated,
    );
    if (
      !rootPhase.authorBinding.agentIdMatches ||
      !rootPhase.authorBinding.handleMatches
    ) {
      throw new Error(
        "Root post author does not match the first connector binding.",
      );
    }
    rootPhase.status = "passed";
    phases.push(rootPhase);
  } catch (error) {
    const planned = await plannedPhases({
      runtime: "ollama",
      traceId: input.traceId,
      bindings: input.bindings,
      options: input.options,
      stateDirectory: "",
      temporaryDirectory: "",
      status: "skipped",
      error: "Root phase failed; reply was not attempted.",
    });
    if (rootPhase) {
      rootPhase.status = "failed";
      rootPhase.error = errorText(error);
      phases.push(rootPhase);
    } else {
      planned[0]!.status = "failed";
      planned[0]!.error = errorText(error);
      phases.push(planned[0]!);
    }
    phases.push(planned[1]!);
    return phases;
  }

  let replyPhase: PhaseEvidence | undefined;
  try {
    const context = await readTargetContext({
      binding: input.bindings[1],
      meshId: rootLocated!.post.meshId,
      topicId: rootLocated!.post.topicId,
      timeoutMs: input.options.timeoutMs,
    });
    const observedRoot = context.posts.find(
      (post) => post.id === rootLocated!.post.id,
    );
    if (!observedRoot)
      throw new Error("Second Ollama agent did not observe the root post.");
    const prompt = ollamaReplyPrompt({
      traceId: input.traceId,
      profile: context.profile,
      topic: context.topic,
      rootPost: observedRoot,
      recentPosts: context.posts,
    });
    replyPhase = emptyPhase({
      phase: "reply",
      traceId: input.traceId,
      binding: input.bindings[1],
      plan: ollamaPlan(input.options, prompt),
      status: "failed",
    });
    const result = await invokeOllama({
      baseUrl: input.options.ollamaUrl,
      model,
      prompt,
      marker: replyPhase.marker,
      timeoutMs: input.options.timeoutMs,
    });
    replyPhase.execution = result.execution;
    if (!result.body)
      throw new Error(result.execution.error ?? "Ollama produced no reply.");
    await publishReply({
      binding: input.bindings[1],
      postId: rootLocated!.post.id,
      body: result.body,
      idempotencyKey: `${input.traceId}:reply`,
      timeoutMs: input.options.timeoutMs,
    });
    const located = await locateMarkedPost({
      binding: input.bindings[1],
      marker: replyPhase.marker,
      timeoutMs: input.options.timeoutMs,
      parentPostId: rootLocated!.post.id,
      targetMeshId: rootLocated!.post.meshId,
      targetTopicId: rootLocated!.post.topicId,
    });
    replyPhase.authorBinding = authorBindingEvidence(
      input.bindings[1],
      replyPhase.marker,
      located,
    );
    if (
      !replyPhase.authorBinding.agentIdMatches ||
      !replyPhase.authorBinding.handleMatches
    ) {
      throw new Error(
        "Reply author does not match the second connector binding.",
      );
    }
    replyPhase.status = "passed";
    phases.push(replyPhase);
  } catch (error) {
    if (replyPhase) {
      replyPhase.status = "failed";
      replyPhase.error = errorText(error);
      phases.push(replyPhase);
    } else {
      const prompt = replyPrompt(input.traceId, {
        meshId: rootLocated!.post.meshId,
        topicId: rootLocated!.post.topicId,
        postId: rootLocated!.post.id,
      });
      phases.push(
        emptyPhase({
          phase: "reply",
          traceId: input.traceId,
          binding: input.bindings[1],
          plan: ollamaPlan(input.options, prompt),
          status: "failed",
          error: errorText(error),
        }),
      );
    }
  }
  return phases;
}

async function runRuntime(input: {
  runtime: LiveRuntime;
  selected: SelectedRuntime;
  version: VersionEvidence;
  options: LiveMatrixOptions;
  stateDirectory: string;
  temporaryDirectory: string;
  observeNativeSessions: boolean;
}): Promise<RuntimeEvidence> {
  const traceId = `${input.runtime}-${randomUUID()}`;
  const codexPublishMode =
    input.runtime === "codex" ? input.options.codexPublishMode : null;
  if (!input.selected.bindings) {
    return {
      runtime: input.runtime,
      traceId,
      requestedModel: input.options.models[input.runtime] ?? null,
      codexPublishMode,
      version: input.version,
      identities: [],
      phases: [],
      outcome: "failed",
      error: input.selected.error ?? "Bindings unavailable.",
    };
  }
  const identities = await Promise.all(
    input.selected.bindings.map((binding) =>
      verifyIdentity(binding, input.options.timeoutMs),
    ),
  );
  const prerequisites: string[] = [];
  if (!input.version.installed)
    prerequisites.push(`${input.runtime} executable is unavailable.`);
  if (identities.some((identity) => !identity.matches)) {
    prerequisites.push(
      "One or more server identities do not match connector state.",
    );
  }
  if (input.runtime === "ollama" && !input.options.models.ollama) {
    prerequisites.push("--ollama-model is required for Ollama.");
  }
  if (prerequisites.length) {
    return {
      runtime: input.runtime,
      traceId,
      requestedModel: input.options.models[input.runtime] ?? null,
      codexPublishMode,
      version: input.version,
      identities,
      phases: await plannedPhases({
        runtime: input.runtime,
        traceId,
        bindings: input.selected.bindings,
        options: input.options,
        stateDirectory: input.stateDirectory,
        temporaryDirectory: input.temporaryDirectory,
        status: "skipped",
        error: prerequisites.join(" "),
      }),
      outcome: "failed",
      error: prerequisites.join(" "),
    };
  }
  if (input.options.dryRun) {
    return {
      runtime: input.runtime,
      traceId,
      requestedModel: input.options.models[input.runtime] ?? null,
      codexPublishMode,
      version: input.version,
      identities,
      phases: await plannedPhases({
        runtime: input.runtime,
        traceId,
        bindings: input.selected.bindings,
        options: input.options,
        stateDirectory: input.stateDirectory,
        temporaryDirectory: input.temporaryDirectory,
        status: "planned",
      }),
      outcome: "planned",
    };
  }
  const phases =
    input.runtime === "ollama"
      ? await runOllamaRuntime({
          traceId,
          bindings: input.selected.bindings,
          options: input.options,
        })
      : input.runtime === "codex" &&
          input.options.codexPublishMode === "managed"
        ? await runManagedCodexRuntime({
            traceId,
            bindings: input.selected.bindings,
            options: input.options,
            stateDirectory: input.stateDirectory,
            temporaryDirectory: input.temporaryDirectory,
          })
        : await runCliRuntime({
            runtime: input.runtime,
            traceId,
            bindings: input.selected.bindings,
            options: input.options,
            stateDirectory: input.stateDirectory,
            temporaryDirectory: input.temporaryDirectory,
            observeNativeSessions: input.observeNativeSessions,
          });
  const passed =
    phases.length === 2 && phases.every((phase) => phase.status === "passed");
  return {
    runtime: input.runtime,
    traceId,
    requestedModel: input.options.models[input.runtime] ?? null,
    codexPublishMode,
    version: input.version,
    identities,
    phases,
    outcome: passed ? "passed" : "failed",
    ...(!passed
      ? { error: "One or more live phases failed. No retry was attempted." }
      : {}),
  };
}

async function checkHealth(
  serverUrl: string,
  timeoutMs: number,
): Promise<LiveMatrixEvidence["serverHealth"][number]> {
  try {
    return {
      serverUrl,
      reachable: true,
      result: await new MeshrApi(serverUrl).health(
        AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
      ),
    };
  } catch (error) {
    return { serverUrl, reachable: false, error: errorText(error) };
  }
}

export async function runLiveMatrix(
  options: LiveMatrixOptions,
): Promise<LiveMatrixEvidence> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const provenance = await captureEvidenceProvenance(options.projectRoot);
  const configuredTarget = configuredReleaseValidationTarget();
  const validationTarget = configuredTarget.meshId && configuredTarget.topicId
    ? { meshId: configuredTarget.meshId, topicId: configuredTarget.topicId }
    : undefined;
  const store = new ConnectorStateStore(options.stateDirectory);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "meshr-live-matrix-"),
  );
  try {
    const state = await store.load();
    const selected = new Map<LiveRuntime, SelectedRuntime>();
    for (const runtime of options.runtimes) {
      try {
        selected.set(runtime, {
          bindings: selectRuntimeBindings({
            state,
            runtime,
            selectors: options.bindings[runtime],
            serverUrl: options.serverUrl,
          }),
        });
      } catch (error) {
        selected.set(runtime, { error: errorText(error) });
      }
    }
    const serverUrls = [
      ...new Set(
        [...selected.values()].flatMap((item) =>
          item.bindings ? [item.bindings[0].serverUrl] : [],
        ),
      ),
    ];
    const serverHealth = await Promise.all(
      serverUrls.map((url) => checkHealth(url, options.timeoutMs)),
    );
    const runtimes: RuntimeEvidence[] = [];
    for (const runtime of options.runtimes) {
      const version = await readVersion({
        command: options.commands[runtime],
        cwd: options.projectRoot,
        timeoutMs: options.versionTimeoutMs,
      });
      runtimes.push(
        await runRuntime({
          runtime,
          selected: selected.get(runtime) ?? {
            error: "Runtime selection missing.",
          },
          version,
          options,
          stateDirectory: store.directory,
          temporaryDirectory,
          observeNativeSessions: provenance.environment !== "local",
        }),
      );
    }
    const anyFailure =
      serverHealth.some((health) => !health.reachable) ||
      runtimes.some((runtime) => runtime.outcome === "failed");
    return {
      schemaVersion: 2,
      provenance,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun: options.dryRun,
      projectRoot: options.projectRoot,
      stateDirectory: store.directory,
      requestedRuntimes: options.runtimes,
      requestedCodexPublishMode: options.codexPublishMode,
      ...(validationTarget ? { validationTarget } : {}),
      serverHealth,
      runtimes,
      outcome: anyFailure ? "failed" : options.dryRun ? "planned" : "passed",
    };
  } catch (error) {
    return {
      schemaVersion: 2,
      provenance,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun: options.dryRun,
      projectRoot: options.projectRoot,
      stateDirectory: store.directory,
      requestedRuntimes: options.runtimes,
      requestedCodexPublishMode: options.codexPublishMode,
      ...(validationTarget ? { validationTarget } : {}),
      serverHealth: [],
      runtimes: [],
      outcome: "failed",
      error: errorText(error),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function defaultEvidencePath(
  projectRoot: string,
  evidence: LiveMatrixEvidence,
): string {
  const timestamp = evidence.startedAt.replace(/[:.]/g, "-");
  return join(
    projectRoot,
    "live",
    "evidence",
    `${timestamp}-${evidence.runId}.json`,
  );
}

export async function writeEvidence(
  evidence: LiveMatrixEvidence,
  path = defaultEvidencePath(evidence.projectRoot, evidence),
): Promise<string> {
  const absolute = resolve(path);
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${basename(absolute)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, absolute);
  return absolute;
}
