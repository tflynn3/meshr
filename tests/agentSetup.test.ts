import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  browserAgentSetupReducer,
  buildAgentSetupCommands,
  defaultDefinitionPath,
  initialBrowserAgentSetupState,
  nativeSetupMeshrHandle,
  suggestAgentHandle,
} from "../src/setup/agentSetup.ts";
import {
  connectorSetupHandle,
  starterDefinitionSource,
} from "../connector/cli.ts";

test("builds the real native pairing, claim, and MCP commands", () => {
  assert.deepEqual(
    buildAgentSetupCommands({
      runtime: "codex",
      handle: "euclid",
      definitionPath: ".meshr/agents/euclid.md",
    }),
    {
      bootstrap:
        "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp setup codex euclid",
      init:
        "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp init --handle 'euclid' --definition '.meshr/agents/euclid.md'",
      connect:
        "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp connect --runtime codex --definition '.meshr/agents/euclid.md'",
      claim: "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp claim --binding 'euclid'",
      sync: "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp sync --binding 'euclid'",
      diagnose:
        "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp doctor",
      activate:
        "codex mcp add 'meshr-euclid' -- npx --yes --package @meshr/mcp@0.1.1 meshr-mcp mcp serve --binding 'euclid'",
      openClawInstall: undefined,
    },
  );
});

test("binds OpenClaw setup to the host-trusted agent ID", () => {
  const commands = buildAgentSetupCommands({
    runtime: "openclaw",
    handle: "bramble",
    definitionPath: ".meshr/agents/bramble.md",
    openClawAgentId: "garden-main",
  });

  assert.match(commands.connect, /--runtime openclaw/);
  assert.match(commands.connect, /--subject 'openclaw:garden-main'/);
  assert.equal(
    commands.openClawInstall,
    "openclaw plugins install npm:@meshr/openclaw@0.1.1 --pin",
  );
  assert.equal(
    commands.activate,
    "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp sync --binding 'bramble' && npx --yes --package @meshr/mcp@0.1.1 meshr-mcp openclaw configure --binding 'bramble' --agent-id 'garden-main'",
  );
  assert.equal(
    commands.sync,
    "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp sync --binding 'bramble'",
  );
});

test("offers a neutral MCP runtime for hosts without a first-class adapter", () => {
  const commands = buildAgentSetupCommands({
    runtime: "mcp",
    handle: "orchard",
    definitionPath: ".meshr/agents/orchard.md",
  });
  assert.match(commands.connect, /--runtime mcp/);
  assert.equal(
    commands.activate,
    "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp mcp serve --binding 'orchard'",
  );
  assert.equal(commands.openClawInstall, undefined);
});

test("quotes local definition paths and keeps filename defaults predictable", () => {
  assert.equal(defaultDefinitionPath("fern"), ".meshr/agents/fern.md");
  const commands = buildAgentSetupCommands({
    runtime: "claude",
    handle: "fern",
    definitionPath: "/tmp/Fern's profile.md",
  });
  assert.match(commands.connect, /'\/tmp\/Fern'\"'\"'s profile\.md'/);
  assert.equal(
    commands.activate,
    "claude mcp add --scope local 'meshr-fern' -- npx --yes --package @meshr/mcp@0.1.1 meshr-mcp mcp serve --binding 'fern'",
  );
});

test("includes the same-origin server in browser-generated setup commands", () => {
  const commands = buildAgentSetupCommands({
    runtime: "codex",
    handle: "euclid",
    definitionPath: ".meshr/agents/euclid.md",
    serverUrl: "https://meshr.social/",
  });
  assert.match(commands.connect, /--server 'https:\/\/meshr\.social\/'/);
  assert.equal(
    commands.bootstrap,
    "npx --yes --package @meshr/mcp@0.1.1 meshr-mcp setup codex euclid --server https://meshr.social",
  );
  assert.match(commands.diagnose, /--server 'https:\/\/meshr\.social\/'/);
});

test("refuses unsafe or ambiguous servers in the copyable bootstrap command", () => {
  for (const serverUrl of [
    "javascript:alert(1)",
    "https://owner:secret@meshr.social/",
    "https://meshr.social/connect?next=setup",
  ]) {
    assert.throws(
      () =>
        buildAgentSetupCommands({
          runtime: "codex",
          handle: "euclid",
          definitionPath: ".meshr/agents/euclid.md",
          serverUrl,
        }),
      /must be an HTTP\(S\) origin/,
    );
  }
});

test("derives a safe handle while keeping customization optional", () => {
  assert.equal(suggestAgentHandle("Garden Researcher"), "garden-researcher");
  assert.equal(suggestAgentHandle("  🌿 Field Notes  "), "field-notes");
  assert.equal(suggestAgentHandle("7"), "my-agent");
  assert.equal(suggestAgentHandle("A very long agent name that should be bounded cleanly"), "a-very-long-agent-name-that-shou");
  assert.equal(nativeSetupMeshrHandle("openclaw", "garden_main"), "garden-main");
  assert.equal(nativeSetupMeshrHandle("openclaw", "7-garden"), "agent-7-garden");
  assert.equal(nativeSetupMeshrHandle("openclaw", "a"), "my-agent");
  for (const identity of ["garden_main", "7-garden", "a", "garden-main"]) {
    assert.equal(
      connectorSetupHandle("openclaw", identity),
      nativeSetupMeshrHandle("openclaw", identity),
    );
  }
});

test("keeps the exact OpenClaw host identity out of the public handle mapping", () => {
  const commands = buildAgentSetupCommands({
    runtime: "openclaw",
    handle: "garden-main",
    definitionPath: ".meshr/agents/garden-main.md",
    openClawAgentId: "garden_main",
  });
  assert.match(commands.bootstrap, /setup openclaw garden_main/);
  assert.match(commands.connect, /--subject 'openclaw:garden_main'/);
  assert.match(commands.connect, /garden-main\.md/);
});

test("browser setup cannot report success before the exact identity tool set is registered", () => {
  const creating = browserAgentSetupReducer(initialBrowserAgentSetupState, {
    type: "submit",
  });
  const registering = browserAgentSetupReducer(creating, {
    type: "identity_created",
    agentId: "agt_garden",
    handle: "garden",
  });
  assert.equal(registering.phase, "registering");
  assert.deepEqual(
    browserAgentSetupReducer(registering, {
      type: "registration_ready",
      agentId: "agt_stale",
    }),
    registering,
  );
  assert.deepEqual(
    browserAgentSetupReducer(registering, {
      type: "registration_ready",
      agentId: "agt_garden",
    }),
    { phase: "ready", agentId: "agt_garden", handle: "garden" },
  );
});

test("registration failure preserves the durable identity for grant-only retry", () => {
  const registering = {
    phase: "registering" as const,
    agentId: "agt_garden",
    handle: "garden",
  };
  const failed = browserAgentSetupReducer(registering, {
    type: "failed",
    message: "Host rejected one tool.",
  });
  assert.deepEqual(failed, {
    phase: "error",
    point: "registration",
    message: "Host rejected one tool.",
    agentId: "agt_garden",
    handle: "garden",
    revocation: "pending",
  });
  assert.deepEqual(
    browserAgentSetupReducer(failed, { type: "retry_registration" }),
    failed,
    "registration cannot restart while grant revocation is unconfirmed",
  );
  const unconfirmed = browserAgentSetupReducer(failed, {
    type: "revocation_changed",
    status: "unconfirmed",
  });
  assert.deepEqual(
    unconfirmed,
    { ...failed, revocation: "unconfirmed" },
  );
  const confirmed = browserAgentSetupReducer(unconfirmed, {
    type: "revocation_changed",
    status: "confirmed",
  });
  assert.deepEqual(
    browserAgentSetupReducer(confirmed, { type: "retry_registration" }),
    registering,
  );
});

test("user-facing package bootstrap commands are release-pinned", () => {
  for (const path of ["../README.md", "../integrations/openclaw/README.md"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /--package @meshr\/mcp(?:\s|$)/);
    assert.match(source, /--package @meshr\/mcp@0\.1\.1/);
  }
  const openClawReadme = readFileSync(
    new URL("../integrations/openclaw/README.md", import.meta.url),
    "utf8",
  );
  assert.match(
    openClawReadme,
    /openclaw plugins install npm:@meshr\/openclaw@0\.1\.1 --pin/,
  );
});

test("offers native hosts, a generic MCP host, and a safe starter definition", () => {
  const source = starterDefinitionSource({ handle: "relay", name: "Relay" });
  assert.doesNotMatch(source, /autonomous/);
  assert.match(source, /handle: relay/);
  assert.match(source, /rootPosts: draft/);
});

test("the Add agent screen creates server authority without a fake runtime", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /createBrowserAgentWithWebMcp/);
  assert.doesNotMatch(source, /meshStore\.connectRuntime/);
  assert.doesNotMatch(source, /discovered-agents/);
  assert.match(source, /This confirms access,[\s\S]*not that a model is currently running/);
  assert.match(source, /Advanced: manual steps and diagnostics/);
  assert.doesNotMatch(source, /revoked automatically|Page access was not kept/);
  const connectorSource = readFileSync(
    new URL("../connector/cli.ts", import.meta.url),
    "utf8",
  );
  assert.match(connectorSource, /args\.command === "setup"/);
  assert.match(connectorSource, /Waiting for approval; this terminal will continue automatically/);
});
