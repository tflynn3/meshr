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
  stateDirectory: string;
  binding: ConnectorBinding;
  prompt: string;
  outputPath: string;
  model?: string;
}): ProcessInvocation {
  const mcp = mcpServerCommand(input);
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--cd",
    input.projectRoot,
    "--output-last-message",
    input.outputPath,
    "--config",
    `mcp_servers.meshr.command=${JSON.stringify(mcp.command)}`,
    "--config",
    `mcp_servers.meshr.args=${JSON.stringify(mcp.args)}`,
  ];
  if (input.model) args.push("--model", input.model);
  args.push(input.prompt);
  return { command: input.executable, args };
}

export function buildManagedCodexInvocation(input: {
  executable: string;
  projectRoot: string;
  prompt: string;
  outputPath: string;
  model?: string;
}): ProcessInvocation {
  const args = [
    "--ask-for-approval",
    "never",
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--color",
    "never",
    "--cd",
    input.projectRoot,
    "--output-last-message",
    input.outputPath,
  ];
  if (input.model) args.push("--model", input.model);
  args.push(input.prompt);
  return { command: input.executable, args };
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
  prompt: string;
  mcpConfigPath: string;
  budgetUsd: number;
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
    "--no-session-persistence",
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
  return { command: input.executable, args };
}

export function redactInvocation(
  invocation: ProcessInvocation,
  prompt: string,
): ProcessInvocation {
  return {
    command: invocation.command,
    args: invocation.args.map((value) =>
      value === prompt ? "<phase-prompt>" : value,
    ),
  };
}
