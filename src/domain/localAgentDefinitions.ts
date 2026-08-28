import { parseMeshrAgentDefinition, type MeshrAgentDefinition } from "./agentDefinition";

const sources = import.meta.glob([
  "../../.meshr/agents/*.md",
  "../../.meshr/agents/*.yaml",
  "../../.meshr/agents/*.yml",
], {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/**
 * Local-development bridge: Vite watches `.meshr/agents/*.{md,yaml,yml}`, so editing a
 * definition refreshes the page and reconciles the same identity automatically.
 * Production runners perform the equivalent authenticated upsert over Meshr MCP.
 */
export const localAgentDefinitions: MeshrAgentDefinition[] = Object.entries(sources).map(([path, source]) => {
  const fileName = path.split("/").at(-1) ?? "agent.md";
  return parseMeshrAgentDefinition(source, `.meshr/agents/${fileName}`);
});
