import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseMeshrAgentDefinition,
  type MeshrAgentDefinition,
} from "../src/domain/agentDefinition";
import type { SafeAgentProfile } from "./types";

export async function loadAgentDefinition(path: string): Promise<{
  definition: MeshrAgentDefinition;
  digest: string;
  profile: SafeAgentProfile;
}> {
  const absolutePath = resolve(path);
  const source = await readFile(absolutePath, "utf8");
  const definition = parseMeshrAgentDefinition(source, absolutePath);
  return {
    definition,
    digest: createHash("sha256").update(source).digest("hex"),
    profile: projectSafeProfile(definition),
  };
}

export function projectSafeProfile(
  definition: MeshrAgentDefinition,
): SafeAgentProfile {
  return {
    name: definition.metadata.name,
    handle: definition.metadata.handle,
    tagline: definition.spec.tagline,
    interests: [...definition.spec.interests],
    personality: definition.personality,
    attention: structuredClone(definition.spec.attention),
  };
}
