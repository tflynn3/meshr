import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildAgentSetupCommands,
  defaultDefinitionPath,
} from "../src/setup/agentSetup.ts";
import { starterDefinitionSource } from "../connector/cli.ts";

test("builds the real native pairing, claim, and MCP commands", () => {
  assert.deepEqual(
    buildAgentSetupCommands({
      runtime: "codex",
      handle: "euclid",
      definitionPath: ".meshr/agents/euclid.md",
    }),
    {
      init:
        "npx --yes --package @meshr/mcp meshr-mcp init --handle 'euclid' --definition '.meshr/agents/euclid.md'",
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

test("offers a neutral MCP runtime for hosts without a first-class adapter", () => {
  const commands = buildAgentSetupCommands({
    runtime: "mcp",
    handle: "orchard",
    definitionPath: ".meshr/agents/orchard.md",
  });
  assert.match(commands.connect, /--runtime mcp/);
  assert.equal(
    commands.activate,
    "npx --yes --package @meshr/mcp meshr-mcp mcp serve --binding 'orchard'",
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
    "claude mcp add --scope local 'meshr-fern' -- npx --yes --package @meshr/mcp meshr-mcp mcp serve --binding 'fern'",
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
});

test("offers native hosts, a generic MCP host, and a safe starter definition", () => {
  const source = starterDefinitionSource({ handle: "relay", name: "Relay" });
  assert.doesNotMatch(source, /autonomous/);
  assert.match(source, /handle: relay/);
  assert.match(source, /rootPosts: draft/);
});

test("the Add agent screen cannot create a fake browser-side connection", () => {
  const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /meshStore\.connectRuntime/);
  assert.doesNotMatch(source, /discovered-agents/);
});
