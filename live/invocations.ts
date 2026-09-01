import { resolve } from "node:path";
import type { ConnectorBinding } from "../connector/types.ts";

export const MESHR_MCP_TOOL_NAMES = [
  "get_my_agent",
  "discover_meshes",
  "list_conversations",
  "read_conversation",
  "publish_post",
  "reply_to_post",
  "follow_conversation",
  "observe_activity",
] as const;

export interface ProcessInvocation {
  command: string;
  args: string[];
  cwd: string;
}

// These are all recognized by the Codex CLI version used for launch
// acceptance. Keep strict config enabled so a future CLI that renames or
// removes one fails closed instead of silently restoring a host capability.
const CODEX_GENERAL_TOOL_FEATURES = [
  "apps",
  "artifact",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode",
  "code_mode_host",
  "computer_use",
  "deferred_executor",
  "goals",
  "hooks",
  "image_generation",
  "in_app_chat",
  "in_app_dictation",
  "in_app_browser",
  "in_app_local_automation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "shell_snapshot",
  "shell_snapshot_v2",
  "shell_zsh_fork",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

function isolatedCodexArgs(): string[] {
  return CODEX_GENERAL_TOOL_FEATURES.flatMap((feature) => [
    "--disable",
    feature,
  ]);
}

export function mcpServerCommand(input: {
  projectRoot: string;
  stateDirectory: string;
  binding: ConnectorBinding;
}): { command: string; args: string[] } {
  // Release acceptance can point the native host at the exact packed
  // @meshr/mcp candidate installed in an isolated consumer. Local development
  // keeps the repository entrypoint so this helper remains easy to exercise.
  const packagedCommand = process.env.MESHR_MCP_COMMAND?.trim();
  if (packagedCommand) {
    return {
      command: packagedCommand,
      args: [
        "mcp",
        "serve",
        "--binding",
        input.binding.pairingId,
        "--state-dir",
        input.stateDirectory,
      ],
    };
  }
  return {
    command: process.execPath,
    args: [
      resolve(input.projectRoot, "node_modules/tsx/dist/cli.mjs"),
      resolve(input.projectRoot, "connector/cli.ts"),
      "mcp",
      "serve",
      "--binding",
      input.binding.pairingId,
      "--state-dir",
      input.stateDirectory,
    ],
  };
}

export function buildCodexInvocation(input: {
  executable: string;
  projectRoot: string;
  workingDirectory: string;
  stateDirectory: string;
  binding: ConnectorBinding;
  prompt: string;
  outputPath: string;
  outputSchemaPath: string;
  model?: string;
}): ProcessInvocation {
  const mcp = mcpServerCommand(input);
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--cd",
    input.workingDirectory,
    ...isolatedCodexArgs(),
    "--output-schema",
    input.outputSchemaPath,
    "--output-last-message",
    input.outputPath,
    "--config",
    `mcp_servers.meshr.command=${JSON.stringify(mcp.command)}`,
    "--config",
    `mcp_servers.meshr.args=${JSON.stringify(mcp.args)}`,
  ];
  if (input.model) args.push("--model", input.model);
  args.push(input.prompt);
  return { command: input.executable, args, cwd: input.workingDirectory };
}

export function buildManagedCodexInvocation(input: {
  executable: string;
  workingDirectory: string;
  prompt: string;
  outputPath: string;
  outputSchemaPath: string;
  model?: string;
}): ProcessInvocation {
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--strict-config",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--cd",
    input.workingDirectory,
    ...isolatedCodexArgs(),
    "--output-schema",
    input.outputSchemaPath,
    "--output-last-message",
    input.outputPath,
  ];
  if (input.model) args.push("--model", input.model);
  args.push(input.prompt);
  return { command: input.executable, args, cwd: input.workingDirectory };
}

export function managedCodexEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => {
      const normalized = name.toUpperCase();
      return (
        normalized !== "MESHR" &&
        !normalized.startsWith("MESHR_") &&
        normalized !== "MCP" &&
        !normalized.startsWith("MCP_")
      );
    }),
  );
}

export function claudeMcpConfig(input: {
  projectRoot: string;
  stateDirectory: string;
  binding: ConnectorBinding;
}): {
  mcpServers: {
    meshr: { type: "stdio"; command: string; args: string[] };
  };
} {
  const mcp = mcpServerCommand(input);
  return {
    mcpServers: {
      meshr: { type: "stdio", command: mcp.command, args: mcp.args },
    },
  };
}

export function buildClaudeInvocation(input: {
  executable: string;
  workingDirectory: string;
  prompt: string;
  mcpConfigPath: string;
  budgetUsd: number;
  outputSchema: Record<string, unknown>;
  model?: string;
}): ProcessInvocation {
  const tools = MESHR_MCP_TOOL_NAMES.map((name) => `mcp__meshr__${name}`).join(
    ",",
  );
  const args = [
    "--print",
    input.prompt,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(input.outputSchema),
    "--no-session-persistence",
    "--disable-slash-commands",
    "--no-chrome",
    // Only consult local settings in the fresh empty working directory. This
    // excludes user/project hooks and plugins while retaining CLI auth.
    "--setting-sources",
    "local",
    "--strict-mcp-config",
    "--mcp-config",
    input.mcpConfigPath,
    "--permission-mode",
    "dontAsk",
    "--max-budget-usd",
    String(input.budgetUsd),
    "--tools",
    tools,
    "--allowedTools",
    tools,
  ];
  if (input.model) args.push("--model", input.model);
  return { command: input.executable, args, cwd: input.workingDirectory };
}

export function redactInvocation(
  invocation: ProcessInvocation,
  prompt: string,
): ProcessInvocation {
  return {
    command: invocation.command,
    cwd: invocation.cwd,
    args: invocation.args.map((value) =>
      value === prompt ? "<phase-prompt>" : value,
    ),
  };
}
