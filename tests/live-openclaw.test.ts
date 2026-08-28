import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConnectorBinding, ConnectorState } from "../connector/types.ts";
import {
  runOpenClawLive,
  selectOpenClawBindings,
  writeOpenClawEvidence,
  type OpenClawLiveDependencies,
} from "../live/openclaw-live.ts";
import { parseOpenClawLiveOptions } from "../live/openclaw-options.ts";
import type { OpenClawLiveOptions } from "../live/openclaw-types.ts";
import type { ProcessEvidence } from "../live/types.ts";

const PLANTED_SECRET = "meshr-super-secret-token-value";
const MESHR_TOOLS = [
  "meshr_get_my_agent",
  "meshr_discover_meshes",
  "meshr_list_conversations",
  "meshr_read_conversation",
  "meshr_publish_post",
  "meshr_reply_to_post",
  "meshr_follow_conversation",
  "meshr_observe_activity",
];

function binding(input: {
  openClawAgentId: string;
  meshrAgentId: string;
  handle: string;
  pairingId: string;
  token?: string;
  serverUrl?: string;
}): ConnectorBinding {
  const now = new Date().toISOString();
  return {
    pairingId: input.pairingId,
    bindingId: `binding-${input.pairingId}`,
    agentId: input.meshrAgentId,
    serverUrl: input.serverUrl ?? "http://127.0.0.1:8787",
    runtime: "openclaw",
    label: input.openClawAgentId,
    externalSubject: `openclaw:${input.openClawAgentId}`,
    definitionPath: `/definitions/${input.openClawAgentId}.md`,
    definitionDigest: `digest-${input.openClawAgentId}`,
    requestedProfile: {
      name: input.openClawAgentId,
      handle: input.handle,
      tagline: "A test profile",
      interests: ["math"],
      personality: "Careful and curious.",
      attention: {
        browse: "public",
        rootPosts: "autonomous",
        replies: "autonomous",
        notes: "Follow useful math connections.",
      },
    },
    publicKeyPem: "public-key",
    privateKeyPem: "private-key-secret",
    pairingSecret: "pairing-secret",
    pairingCode: "PAIR-CODE",
    pairingExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "connected",
    agentToken: input.token ?? PLANTED_SECRET,
    agentTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}

interface Fixture {
  directory: string;
  stateDirectory: string;
  configPath: string;
  connectorStatePath: string;
  options: OpenClawLiveOptions;
  bindings: [ConnectorBinding, ConnectorBinding];
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "meshr-openclaw-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const stateDirectory = join(directory, "openclaw-state");
  const connectorDirectory = join(directory, "connector");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(connectorDirectory, { mode: 0o700 });
  const configPath = join(stateDirectory, "openclaw.json");
  const connectorStatePath = join(connectorDirectory, "state.json");
  const bindings: [ConnectorBinding, ConnectorBinding] = [
    binding({
      openClawAgentId: "moss",
      meshrAgentId: "agent-moss",
      handle: "moss",
      pairingId: "pair-moss",
    }),
    binding({
      openClawAgentId: "kepler",
      meshrAgentId: "agent-kepler",
      handle: "kepler",
      pairingId: "pair-kepler",
      token: "second-secret-token",
    }),
  ];
  await writeFile(
    connectorStatePath,
    `${JSON.stringify({ version: 1, bindings }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        agents: {
          list: [
            {
              id: "moss",
              tools: {
                profile: "full",
                allow: MESHR_TOOLS,
              },
            },
            {
              id: "kepler",
              tools: {
                profile: "full",
                allow: MESHR_TOOLS,
              },
            },
          ],
        },
        plugins: {
          load: {
            paths: [join(process.cwd(), "integrations", "openclaw")],
          },
          entries: {
            meshr: {
              enabled: true,
              config: {
                baseUrl: "http://127.0.0.1:8787",
                connectorStatePath,
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  await chmod(connectorStatePath, 0o600);
  return {
    directory,
    stateDirectory,
    configPath,
    connectorStatePath,
    bindings,
    options: {
      projectRoot: directory,
      dryRun: false,
      agentIds: ["moss", "kepler"],
      bindingSelectors: ["moss", "kepler"],
      openClawCommand: "/isolated/bin/openclaw",
      openClawStateDirectory: stateDirectory,
      openClawConfigPath: configPath,
      connectorStatePath,
      serverUrl: "http://127.0.0.1:8787",
      model: "ollama/fixture",
      timeoutMs: 20_000,
      versionTimeoutMs: 2_000,
    },
  };
}

function processResult(input: {
  command: string;
  args: string[];
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  error?: string;
}): ProcessEvidence {
  return {
    kind: "process",
    command: input.command,
    args: input.args,
    startedAt: "2026-08-27T00:00:00.000Z",
    elapsedMs: 4,
    exitCode: input.exitCode ?? 0,
    signal: null,
    timedOut: input.timedOut ?? false,
    stdout: input.stdout ?? "{}",
    stderr: input.stderr ?? "",
    outputTruncated: false,
    ...(input.error ? { error: input.error } : {}),
  };
}

function identity(binding: ConnectorBinding) {
  return {
    binding: {
      pairingId: binding.pairingId,
      bindingId: binding.bindingId,
      agentId: binding.agentId,
      serverUrl: binding.serverUrl,
      runtime: binding.runtime,
      label: binding.label,
      externalSubject: binding.externalSubject,
      handle: binding.requestedProfile.handle,
      status: binding.status,
    },
    serverAgentId: binding.agentId,
    serverHandle: binding.requestedProfile.handle,
    matches: true,
  };
}

function sharedConversationDependencies(): Pick<
  OpenClawLiveDependencies,
  "discoverContext" | "readTargetContext"
> {
  const topic = {
    id: "topic-cross-pollination",
    meshId: "mesh-public",
    title: "Cross-pollination",
  };
  return {
    discoverContext: async () => ({
      profile: { interests: ["math"] },
      mesh: { id: "mesh-public", name: "Public" },
      topic,
      posts: [],
    }),
    readTargetContext: async () => ({
      profile: { interests: ["gardening"] },
      topic,
      posts: [],
    }),
  };
}

test("parses isolated paths, agent IDs, selectors, and bounds", () => {
  const options = parseOpenClawLiveOptions(
    [
      "--dry-run",
      "--agents",
      "moss,kepler",
      "--bindings=moss-handle,kepler-handle",
      "--openclaw-command",
      "./runtime/openclaw",
      "--openclaw-state-dir",
      "./state",
      "--openclaw-config",
      "./state/config.json",
      "--connector-state",
      "./connector/state.json",
      "--timeout-ms",
      "30000",
    ],
    "/workspace",
  );
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.agentIds, ["moss", "kepler"]);
  assert.deepEqual(options.bindingSelectors, ["moss-handle", "kepler-handle"]);
  assert.equal(options.openClawStateDirectory, "/workspace/state");
  assert.equal(options.connectorStatePath, "/workspace/connector/state.json");
  assert.equal(options.timeoutMs, 30_000);
  assert.throws(
    () => parseOpenClawLiveOptions(["--agents", "moss,moss"], "/workspace"),
    /two distinct values/,
  );
});

test("selects exact openclaw subjects and rejects selector spoofing", () => {
  const moss = binding({
    openClawAgentId: "moss",
    meshrAgentId: "agent-moss",
    handle: "moss-handle",
    pairingId: "pair-moss",
  });
  const wrongSubject = {
    ...moss,
    pairingId: "pair-wrong",
    externalSubject: "openclaw:other",
  };
  const kepler = binding({
    openClawAgentId: "kepler",
    meshrAgentId: "agent-kepler",
    handle: "kepler-handle",
    pairingId: "pair-kepler",
  });
  const state: ConnectorState = {
    version: 1,
    bindings: [wrongSubject, moss, kepler],
  };
  const selected = selectOpenClawBindings({
    state,
    agentIds: ["moss", "kepler"],
    bindingSelectors: ["moss-handle", "kepler-handle"],
  });
  assert.equal(selected.root.pairingId, "pair-moss");
  assert.equal(selected.reply.pairingId, "pair-kepler");
  assert.throws(
    () =>
      selectOpenClawBindings({
        state,
        agentIds: ["moss", "kepler"],
        bindingSelectors: ["pair-wrong", "kepler-handle"],
      }),
    /found 0/,
  );
});

test("runs one root and one reply process and emits secret-free mode-0600 evidence", async (t) => {
  const setup = await fixture(t);
  const calls: Array<{
    args: string[];
    env?: NodeJS.ProcessEnv;
    prompt?: string;
  }> = [];
  let located = 0;
  const dependencies: Partial<OpenClawLiveDependencies> = {
    ...sharedConversationDependencies(),
    uuid: (() => {
      const values = ["run-fixed", "trace-fixed"];
      return () => values.shift() ?? "extra";
    })(),
    runProcess: async (input) => {
      const promptIndex = input.args.indexOf("--message-file");
      calls.push({
        args: [...input.args],
        env: input.env,
        ...(promptIndex >= 0
          ? { prompt: await readFile(input.args[promptIndex + 1]!, "utf8") }
          : {}),
      });
      if (input.args[0] === "--version") {
        return processResult({
          command: input.command,
          args: input.args,
          stdout: "OpenClaw 2026.7.1 (fixture)",
        });
      }
      return processResult({
        command: input.command,
        args: input.args,
        stdout: JSON.stringify({ ok: true, internal: PLANTED_SECRET }),
        stderr: `diagnostic ${PLANTED_SECRET}`,
      });
    },
    verifyIdentity: async (candidate) => identity(candidate),
    locateMarkedPost: async (input) => {
      const candidate = located++ === 0 ? setup.bindings[0] : setup.bindings[1];
      return {
        mesh: { id: "mesh-public", name: "Public" },
        topic: {
          id: "topic-cross-pollination",
          meshId: "mesh-public",
          title: "Cross-pollination",
        },
        post: {
          id: located === 1 ? "post-root" : "post-reply",
          meshId: "mesh-public",
          topicId: "topic-cross-pollination",
          agentId: candidate.agentId!,
          parentPostId: located === 1 ? null : "post-root",
          body: input.marker,
          createdAt: "2026-08-27T00:00:00.000Z",
          agent: {
            id: candidate.agentId!,
            name: candidate.requestedProfile.name,
            handle: candidate.requestedProfile.handle,
          },
        },
      };
    },
  };
  const evidence = await runOpenClawLive(setup.options, dependencies);
  assert.equal(evidence.outcome, "passed");
  assert.equal(calls.length, 3, "version plus exactly two model processes");
  for (const [index, agentId] of ["moss", "kepler"].entries()) {
    const call = calls[index + 1]!;
    assert.deepEqual(call.args.slice(0, 5), [
      "agent",
      "--local",
      "--agent",
      agentId,
      "--json",
    ]);
    assert.equal(call.args.includes("--timeout"), true);
    assert.equal(call.env?.OPENCLAW_STATE_DIR, setup.stateDirectory);
    assert.equal(call.env?.OPENCLAW_CONFIG_PATH, setup.configPath);
  }
  assert.match(calls[1]!.prompt ?? "", /meshr_publish_post exactly once/);
  assert.match(calls[1]!.prompt ?? "", /mesh-public/);
  assert.match(calls[1]!.prompt ?? "", /topic-cross-pollination/);
  assert.doesNotMatch(calls[1]!.prompt ?? "", /meshr_discover_meshes/);
  assert.match(calls[2]!.prompt ?? "", /meshr_reply_to_post exactly once/);
  assert.match(calls[2]!.prompt ?? "", /post-root/);
  assert.doesNotMatch(calls[2]!.prompt ?? "", /meshr_read_conversation/);
  assert.deepEqual(evidence.phases[0]!.target, {
    meshId: "mesh-public",
    topicId: "topic-cross-pollination",
  });
  assert.deepEqual(evidence.phases[1]!.target, {
    meshId: "mesh-public",
    topicId: "topic-cross-pollination",
    postId: "post-root",
  });
  assert.notEqual(evidence.phases[0]!.marker, evidence.phases[1]!.marker);
  assert.equal(evidence.phases[0]!.authorBinding?.agentIdMatches, true);
  assert.equal(evidence.phases[1]!.authorBinding?.handleMatches, true);
  assert.equal(
    evidence.phases.every((phase) => phase.plan.attempts === 1),
    true,
  );
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(PLANTED_SECRET), false);
  assert.equal(serialized.includes("second-secret-token"), false);
  assert.equal(serialized.includes("private-key-secret"), false);
  assert.equal(serialized.includes("pairing-secret"), false);
  assert.equal(serialized.includes("root-prompt.txt"), false);

  const evidencePath = join(setup.directory, "evidence", "openclaw.json");
  await writeOpenClawEvidence(evidence, evidencePath);
  const metadata = await stat(evidencePath);
  if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
  const written = await readFile(evidencePath, "utf8");
  assert.equal(written.includes(PLANTED_SECRET), false);
});

test("never retries a failed root and skips the reply", async (t) => {
  const setup = await fixture(t);
  let processCalls = 0;
  let locateCalls = 0;
  const evidence = await runOpenClawLive(setup.options, {
    ...sharedConversationDependencies(),
    uuid: () => `fixed-${processCalls}`,
    runProcess: async (input) => {
      processCalls += 1;
      if (input.args[0] === "--version") {
        return processResult({
          command: input.command,
          args: input.args,
          stdout: "OpenClaw 2026.7.1",
        });
      }
      return processResult({
        command: input.command,
        args: input.args,
        exitCode: 1,
        stdout: JSON.stringify({ error: PLANTED_SECRET }),
      });
    },
    verifyIdentity: async (candidate) => identity(candidate),
    locateMarkedPost: async () => {
      locateCalls += 1;
      throw new Error("should not locate");
    },
  });
  assert.equal(processCalls, 2, "version plus one root attempt");
  assert.equal(locateCalls, 0);
  assert.equal(evidence.outcome, "failed");
  assert.deepEqual(
    evidence.phases.map((phase) => phase.status),
    ["failed", "skipped"],
  );
  assert.equal(JSON.stringify(evidence).includes(PLANTED_SECRET), false);
});

test("fails closed before any process when plugin connector state differs", async (t) => {
  const setup = await fixture(t);
  const otherState = join(setup.directory, "other-state.json");
  await writeFile(otherState, '{"version":1,"bindings":[]}\n', { mode: 0o600 });
  const config = JSON.parse(await readFile(setup.configPath, "utf8"));
  config.plugins.entries.meshr.config.connectorStatePath = otherState;
  await writeFile(setup.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  let processCalls = 0;
  const evidence = await runOpenClawLive(setup.options, {
    runProcess: async (input) => {
      processCalls += 1;
      return processResult({ command: input.command, args: input.args });
    },
  });
  assert.equal(processCalls, 0);
  assert.equal(evidence.outcome, "failed");
  assert.match(evidence.error ?? "", /does not use the supplied connector state/);
});

test("fails closed before any process when a restrictive profile filters Meshr tools", async (t) => {
  const setup = await fixture(t);
  const config = JSON.parse(await readFile(setup.configPath, "utf8"));
  config.agents.list.find((agent: { id: string }) => agent.id === "moss").tools.profile =
    "coding";
  await writeFile(setup.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  let processCalls = 0;
  const evidence = await runOpenClawLive(setup.options, {
    runProcess: async (input) => {
      processCalls += 1;
      return processResult({ command: input.command, args: input.args });
    },
  });
  assert.equal(processCalls, 0);
  assert.equal(evidence.outcome, "failed");
  assert.match(evidence.error ?? "", /effective tools\.profile full/);
});

test("fails closed before any process when the Meshr-only allowlist has extras", async (t) => {
  const setup = await fixture(t);
  const config = JSON.parse(await readFile(setup.configPath, "utf8"));
  config.agents.list
    .find((agent: { id: string }) => agent.id === "kepler")
    .tools.allow.push("exec");
  await writeFile(setup.configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  let processCalls = 0;
  const evidence = await runOpenClawLive(setup.options, {
    runProcess: async (input) => {
      processCalls += 1;
      return processResult({ command: input.command, args: input.args });
    },
  });
  assert.equal(processCalls, 0);
  assert.equal(evidence.outcome, "failed");
  assert.match(evidence.error ?? "", /unexpected: exec/);
});

test("dry-run preflights a shared conversation without starting an agent turn", async (t) => {
  const setup = await fixture(t);
  setup.options.dryRun = true;
  let processCalls = 0;
  let discoveryCalls = 0;
  let targetReadCalls = 0;
  const shared = sharedConversationDependencies();
  const evidence = await runOpenClawLive(setup.options, {
    runProcess: async (input) => {
      processCalls += 1;
      return processResult({
        command: input.command,
        args: input.args,
        stdout: "OpenClaw 2026.7.1",
      });
    },
    verifyIdentity: async (candidate) => identity(candidate),
    discoverContext: async (...args) => {
      discoveryCalls += 1;
      return shared.discoverContext(...args);
    },
    readTargetContext: async (...args) => {
      targetReadCalls += 1;
      return shared.readTargetContext(...args);
    },
    locateMarkedPost: async () => {
      throw new Error("dry-run must not locate posts");
    },
  });
  assert.equal(processCalls, 1, "only the version process runs");
  assert.equal(discoveryCalls, 1);
  assert.equal(targetReadCalls, 1);
  assert.equal(evidence.outcome, "planned");
  assert.deepEqual(
    evidence.phases.map((phase) => phase.plan.requiredTools),
    [["meshr_publish_post"], ["meshr_reply_to_post"]],
  );
  assert.equal(evidence.phases[0]!.target.meshId, "mesh-public");
  assert.equal(evidence.phases[1]!.target.postId, "<verified-root-post-id>");
});
