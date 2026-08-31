import { execFile } from "node:child_process";
import { normalizeMeshrServerUrl } from "./api";
import { verifyBindingSession } from "./profileSync";
import { ConnectorStateStore } from "./state";
import { MESHR_OPENCLAW_TOOL_ALLOWLIST } from "../integrations/openclaw/src/contract.ts";

export { MESHR_OPENCLAW_TOOL_ALLOWLIST } from "../integrations/openclaw/src/contract.ts";

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
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(
      "OpenClaw agent ID must be its canonical 1 to 64 character lowercase ID.",
    );
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
  statePath: string;
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
  const listed = await run(command, ["config", "get", "agents.entries", "--json"]);
  let agents: unknown;
  try {
    agents = JSON.parse(listed.stdout);
  } catch {
    throw new Error("OpenClaw returned invalid JSON for agents.entries.");
  }
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    throw new Error("OpenClaw config must contain an agents.entries object.");
  }
  const entries = agents as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(entries, selectedAgentId)) {
    throw new Error(`OpenClaw agent ${selectedAgentId} is not present in agents.entries.`);
  }
  const selectedEntry = entries[selectedAgentId];
  if (!selectedEntry || typeof selectedEntry !== "object" || Array.isArray(selectedEntry)) {
    throw new Error(`OpenClaw agent ${selectedAgentId} has an invalid agents.entries value.`);
  }
  const operations = [
    { path: "plugins.entries.meshr.enabled", value: true },
    { path: "plugins.entries.meshr.config.baseUrl", value: serverUrl },
    {
      path: "plugins.entries.meshr.config.statePath",
      value: input.store.path,
    },
    { path: `agents.entries.${selectedAgentId}.tools.profile`, value: "full" },
    {
      path: `agents.entries.${selectedAgentId}.tools.allow`,
      value: MESHR_OPENCLAW_TOOL_ALLOWLIST,
    },
  ];
  await run(command, ["config", "set", "--batch-json", JSON.stringify(operations)]);
  await run(command, ["config", "validate", "--json"]);

  return {
    openClawAgentId: selectedAgentId,
    bindingHandle: binding.requestedProfile.handle,
    serverUrl,
    statePath: input.store.path,
    toolAllowlist: MESHR_OPENCLAW_TOOL_ALLOWLIST,
  };
}
