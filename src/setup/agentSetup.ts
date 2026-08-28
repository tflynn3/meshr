export const agentSetupRuntimes = [
  "codex",
  "claude",
  "openclaw",
  "ollama",
] as const;

export type AgentSetupRuntime = (typeof agentSetupRuntimes)[number];

export const agentSetupRuntimeDetails: Record<
  AgentSetupRuntime,
  { label: string; description: string }
> = {
  codex: { label: "Codex", description: "OpenAI Codex" },
  claude: { label: "Claude", description: "Claude Code" },
  openclaw: { label: "OpenClaw", description: "Native plugin" },
  ollama: { label: "Local", description: "Ollama" },
};

export interface AgentSetupCommands {
  connect: string;
  claim: string;
  sync: string;
  activate?: string;
  openClawInstall?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function setupValue(value: string, fallback: string): string {
  return value.trim() || fallback;
}

export function defaultDefinitionPath(handle: string): string {
  return `.meshr/agents/${setupValue(handle, "my-agent")}.md`;
}

export function buildAgentSetupCommands(input: {
  runtime: AgentSetupRuntime;
  handle: string;
  definitionPath: string;
  openClawAgentId?: string;
}): AgentSetupCommands {
  const handle = setupValue(input.handle, "my-agent");
  const definitionPath = setupValue(
    input.definitionPath,
    defaultDefinitionPath(handle),
  );
  const subject =
    input.runtime === "openclaw"
      ? ` --subject ${shellQuote(
          `openclaw:${setupValue(input.openClawAgentId ?? "", handle)}`,
        )}`
      : "";
  const mcpCommand = `npx --yes --package @meshr/mcp meshr-mcp mcp serve --binding ${shellQuote(handle)}`;
  const syncCommand = `npx --yes --package @meshr/mcp meshr-mcp sync --binding ${shellQuote(handle)}`;
  const serverName = `meshr-${handle.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;

  const activate =
    input.runtime === "codex"
      ? `codex mcp add ${shellQuote(serverName)} -- ${mcpCommand}`
      : input.runtime === "claude"
        ? `claude mcp add --scope local ${shellQuote(serverName)} -- ${mcpCommand}`
        : input.runtime === "openclaw"
          ? `${syncCommand} && npx --yes --package @meshr/mcp meshr-mcp openclaw configure --binding ${shellQuote(handle)} --agent-id ${shellQuote(setupValue(input.openClawAgentId ?? "", handle))}`
          : undefined;

  return {
    connect: `npx --yes --package @meshr/mcp meshr-mcp connect --runtime ${input.runtime}${subject} --definition ${shellQuote(definitionPath)}`,
    claim: `npx --yes --package @meshr/mcp meshr-mcp claim --binding ${shellQuote(handle)}`,
    sync: syncCommand,
    activate,
    openClawInstall:
      input.runtime === "openclaw"
        ? "openclaw plugins install @meshr/openclaw"
        : undefined,
  };
}
