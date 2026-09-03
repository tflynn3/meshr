export const agentSetupRuntimes = [
  "codex",
  "claude",
  "openclaw",
  "mcp",
] as const;

export type AgentSetupRuntime = (typeof agentSetupRuntimes)[number];

const MESHR_MCP_PACKAGE = "@meshr/mcp@0.1.0";
const MESHR_OPENCLAW_PACKAGE = "npm:@meshr/openclaw@0.1.0";

export const agentSetupRuntimeDetails: Record<
  AgentSetupRuntime,
  { label: string; description: string }
> = {
  codex: { label: "Codex", description: "OpenAI Codex" },
  claude: { label: "Claude", description: "Claude Code" },
  openclaw: { label: "OpenClaw", description: "Native plugin" },
  mcp: { label: "Other MCP host", description: "Generic MCP runtime" },
};

export interface AgentSetupCommands {
  bootstrap: string;
  init: string;
  connect: string;
  claim: string;
  sync: string;
  diagnose: string;
  activate?: string;
  openClawInstall?: string;
}

export type BrowserAgentSetupState =
  | { phase: "profile" }
  | { phase: "creating" }
  | { phase: "registering"; agentId: string; handle: string }
  | { phase: "ready"; agentId: string; handle: string }
  | {
      phase: "error";
      point: "identity" | "registration";
      message: string;
      agentId?: string;
      handle?: string;
      revocation?: BrowserRegistrationRevocation;
    };

export type BrowserRegistrationRevocation =
  | "pending"
  | "confirmed"
  | "unconfirmed";

export type BrowserAgentSetupEvent =
  | { type: "submit" }
  | { type: "identity_created"; agentId: string; handle: string }
  | { type: "registration_ready"; agentId: string }
  | {
      type: "failed";
      message: string;
      revocation?: BrowserRegistrationRevocation;
    }
  | { type: "revocation_changed"; status: BrowserRegistrationRevocation }
  | { type: "retry_registration" }
  | { type: "reset" };

export const initialBrowserAgentSetupState: BrowserAgentSetupState = {
  phase: "profile",
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function setupValue(value: string, fallback: string): string {
  return value.trim() || fallback;
}

function bootstrapToken(value: string): string {
  const token = value.trim();
  return /^[a-zA-Z0-9_-]+$/.test(token) ? token : "my-agent";
}

function bootstrapServerFlag(serverUrl: string | undefined): string {
  if (!serverUrl?.trim()) return "";
  try {
    const url = new URL(serverUrl);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    ) {
      return ` --server ${url.origin}`;
    }
  } catch {}
  throw new Error("Agent setup server must be an HTTP(S) origin");
}

export function suggestAgentHandle(name: string): string {
  const handle = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (handle.length >= 2 && /^[a-z]/.test(handle)) return handle;
  return "my-agent";
}

export function nativeSetupMeshrHandle(
  runtime: AgentSetupRuntime,
  identity: string,
): string {
  if (runtime !== "openclaw") return setupValue(identity, "my-agent");
  const safeIdentity = identity.trim().toLowerCase().replaceAll("_", "-");
  return suggestAgentHandle(
    /^[a-z]/.test(safeIdentity) ? safeIdentity : `agent-${safeIdentity}`,
  );
}

export function browserAgentSetupReducer(
  state: BrowserAgentSetupState,
  event: BrowserAgentSetupEvent,
): BrowserAgentSetupState {
  if (event.type === "reset") return initialBrowserAgentSetupState;
  if (event.type === "submit") return { phase: "creating" };
  if (event.type === "identity_created") {
    if (state.phase !== "creating") return state;
    return {
      phase: "registering",
      agentId: event.agentId,
      handle: event.handle,
    };
  }
  if (event.type === "registration_ready") {
    if (state.phase !== "registering" || state.agentId !== event.agentId) {
      return state;
    }
    return { ...state, phase: "ready" };
  }
  if (event.type === "retry_registration") {
    if (
      state.phase !== "error" ||
      state.point !== "registration" ||
      !state.agentId ||
      !state.handle ||
      state.revocation !== "confirmed"
    ) {
      return state;
    }
    return {
      phase: "registering",
      agentId: state.agentId,
      handle: state.handle,
    };
  }
  if (event.type === "revocation_changed") {
    if (state.phase !== "error" || state.point !== "registration") return state;
    return { ...state, revocation: event.status };
  }
  if (event.type === "failed") {
    if (state.phase === "creating") {
      return { phase: "error", point: "identity", message: event.message };
    }
    if (state.phase === "registering") {
      return {
        phase: "error",
        point: "registration",
        message: event.message,
        agentId: state.agentId,
        handle: state.handle,
        revocation: event.revocation ?? "pending",
      };
    }
  }
  return state;
}

export function defaultDefinitionPath(handle: string): string {
  return `.meshr/agents/${setupValue(handle, "my-agent")}.md`;
}

export function buildAgentSetupCommands(input: {
  runtime: AgentSetupRuntime;
  handle: string;
  definitionPath: string;
  openClawAgentId?: string;
  serverUrl?: string;
}): AgentSetupCommands {
  const handle = nativeSetupMeshrHandle(input.runtime, input.handle);
  const bootstrapIdentity =
    input.runtime === "openclaw"
      ? setupValue(input.openClawAgentId ?? "", input.handle)
      : handle;
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
  const mcpCommand = `npx --yes --package ${MESHR_MCP_PACKAGE} meshr-mcp mcp serve --binding ${shellQuote(handle)}`;
  const syncCommand = `npx --yes --package ${MESHR_MCP_PACKAGE} meshr-mcp sync --binding ${shellQuote(handle)}`;
  const serverName = `meshr-${handle.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  const serverUrl = input.serverUrl?.trim();
  const serverFlag = serverUrl ? ` --server ${shellQuote(serverUrl)}` : "";
  const quickServerFlag = bootstrapServerFlag(serverUrl);
  const initCommand = `npx --yes --package ${MESHR_MCP_PACKAGE} meshr-mcp init --handle ${shellQuote(handle)} --definition ${shellQuote(definitionPath)}`;

  const activate =
    input.runtime === "codex"
      ? `codex mcp add ${shellQuote(serverName)} -- ${mcpCommand}`
      : input.runtime === "claude"
        ? `claude mcp add --scope local ${shellQuote(serverName)} -- ${mcpCommand}`
        : input.runtime === "openclaw"
          ? `${syncCommand} && npx --yes --package ${MESHR_MCP_PACKAGE} meshr-mcp openclaw configure --binding ${shellQuote(handle)} --agent-id ${shellQuote(setupValue(input.openClawAgentId ?? "", handle))}`
          : input.runtime === "mcp"
            ? mcpCommand
            : undefined;

  return {
    bootstrap: `npx --yes --package ${MESHR_MCP_PACKAGE} meshr-mcp setup ${input.runtime} ${bootstrapToken(bootstrapIdentity)}${quickServerFlag}`,
    init: initCommand,
    connect: `npx --yes --package ${MESHR_MCP_PACKAGE} meshr-mcp connect --runtime ${input.runtime}${subject}${serverFlag} --definition ${shellQuote(definitionPath)}`,
    claim: `npx --yes --package ${MESHR_MCP_PACKAGE} meshr-mcp claim --binding ${shellQuote(handle)}`,
    sync: syncCommand,
    diagnose: `npx --yes --package ${MESHR_MCP_PACKAGE} meshr-mcp doctor${serverFlag}`,
    activate,
    openClawInstall:
      input.runtime === "openclaw"
        ? `openclaw plugins install ${MESHR_OPENCLAW_PACKAGE} --pin`
        : undefined,
  };
}
