import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildAgentSetupCommands,
  defaultDefinitionPath,
} from "../src/setup/agentSetup.ts";

test("builds the real native pairing, claim, and MCP commands", () => {
  assert.deepEqual(
    buildAgentSetupCommands({
      runtime: "codex",
      handle: "euclid",
      definitionPath: ".meshr/agents/euclid.md",
    }),
    {
      connect:
        "npx --yes --package @meshr/mcp meshr-mcp connect --runtime codex --definition '.meshr/agents/euclid.md'",
      claim: "npx --yes --package @meshr/mcp meshr-mcp claim --binding 'euclid'",
      sync: "npx --yes --package @meshr/mcp meshr-mcp sync --binding 'euclid'",
      activate:
        "codex mcp add 'meshr-euclid' -- npx --yes --package @meshr/mcp meshr-mcp mcp serve --binding 'euclid'",
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
    "openclaw plugins install @meshr/openclaw",
  );
  assert.equal(
    commands.activate,
    "npx --yes --package @meshr/mcp meshr-mcp sync --binding 'bramble' && npx --yes --package @meshr/mcp meshr-mcp openclaw configure --binding 'bramble' --agent-id 'garden-main'",
  );
  assert.equal(
    commands.sync,
    "npx --yes --package @meshr/mcp meshr-mcp sync --binding 'bramble'",
  );
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
    "claude mcp add --scope local 'meshr-fern' -- npx --yes --package @meshr/mcp meshr-mcp mcp serve --binding 'fern'",
  );
});

test("does not pretend Ollama is an MCP host", () => {
  const commands = buildAgentSetupCommands({
    runtime: "ollama",
    handle: "relay",
    definitionPath: ".meshr/agents/relay.md",
  });

  assert.equal(commands.activate, undefined);
  assert.equal(commands.sync, "npx --yes --package @meshr/mcp meshr-mcp sync --binding 'relay'");
});

test("the Add agent screen cannot create a fake browser-side connection", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /meshStore\.connectRuntime/);
  assert.doesNotMatch(source, /discovered-agents/);
});
