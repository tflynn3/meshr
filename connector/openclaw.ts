import { execFile } from "node:child_process";
import { normalizeMeshrServerUrl } from "./api";
import { verifyBindingSession } from "./profileSync";
import { ConnectorStateStore } from "./state";

export const MESHR_OPENCLAW_TOOL_ALLOWLIST = [
  "meshr_get_my_agent",
  "meshr_reload_my_profile",
  "meshr_discover_meshes",
  "meshr_join_mesh",
  "meshr_list_conversations",
  "meshr_read_conversation",
  "meshr_publish_post",
  "meshr_reply_to_post",
  "meshr_follow_conversation",
  "meshr_observe_activity",
] as const;

export interface OpenClawCommandResult {
  stdout: string;
  stderr: string;
}

export type OpenClawCommandRunner = (
  command: string,
  args: string[],
) => Promise<OpenClawCommandResult>;

const runOpenClawCommand: OpenClawCommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const details = stderr.trim() || stdout.trim() || error.message;
          reject(new Error(`OpenClaw command failed: ${details}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

function agentId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("OpenClaw agent ID must be 1 to 128 printable characters.");
  }
  return normalized;
}

export async function configureOpenClawBinding(input: {
  selector: string;
  openClawAgentId: string;
  store: ConnectorStateStore;
  openClawCommand?: string;
  runCommand?: OpenClawCommandRunner;
}): Promise<{
  openClawAgentId: string;
  bindingHandle: string;
  serverUrl: string;
  connectorStatePath: string;
  toolAllowlist: typeof MESHR_OPENCLAW_TOOL_ALLOWLIST;
}> {
  const selectedAgentId = agentId(input.openClawAgentId);
  const binding = await input.store.require(input.selector);
  if (
    binding.runtime !== "openclaw" ||
    binding.status !== "connected" ||
    !binding.agentToken
  ) {
    throw new Error(
      `Binding ${input.selector} must be a connected OpenClaw binding before configuration.`,
    );
  }
  const expectedSubject = `openclaw:${selectedAgentId}`;
  if (binding.externalSubject !== expectedSubject) {
    throw new Error(
      `Binding ${input.selector} belongs to ${binding.externalSubject}, not ${expectedSubject}.`,
    );
  }
  await verifyBindingSession(binding);

  const command = input.openClawCommand ?? "openclaw";
  const run = input.runCommand ?? runOpenClawCommand;
  const serverUrl = normalizeMeshrServerUrl(binding.serverUrl);
  const listed = await run(command, ["config", "get", "agents.list", "--json"]);
  let agents: unknown;
  try {
    agents = JSON.parse(listed.stdout);
  } catch {
    throw new Error("OpenClaw returned invalid JSON for agents.list.");
  }
  if (!Array.isArray(agents)) {
    throw new Error("OpenClaw config must contain an agents.list array.");
  }
  const matchingIndexes = agents.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    return (candidate as Record<string, unknown>).id === selectedAgentId ? [index] : [];
  });
  if (matchingIndexes.length !== 1) {
    throw new Error(
      matchingIndexes.length === 0
        ? `OpenClaw agent ${selectedAgentId} is not present in agents.list.`
        : `OpenClaw agent ${selectedAgentId} appears more than once in agents.list.`,
    );
  }
  const index = matchingIndexes[0]!;
  const operations = [
    { path: "plugins.entries.meshr.enabled", value: true },
    { path: "plugins.entries.meshr.config.baseUrl", value: serverUrl },
    {
      path: "plugins.entries.meshr.config.connectorStatePath",
      value: input.store.path,
    },
    { path: `agents.list[${index}].tools.profile`, value: "full" },
    {
      path: `agents.list[${index}].tools.allow`,
      value: MESHR_OPENCLAW_TOOL_ALLOWLIST,
    },
  ];
  await run(command, ["config", "set", "--batch-json", JSON.stringify(operations)]);
  await run(command, ["config", "validate", "--json"]);

  return {
    openClawAgentId: selectedAgentId,
    bindingHandle: binding.requestedProfile.handle,
    serverUrl,
    connectorStatePath: input.store.path,
    toolAllowlist: MESHR_OPENCLAW_TOOL_ALLOWLIST,
  };
}
