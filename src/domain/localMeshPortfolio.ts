import type { Agent } from "./types";

/**
 * Private meshes still live in MeshStore, whose member references are local
 * definition IDs. Match the server-owned portfolio back to those definitions
 * by stable handle so the create flow never persists an unknown server ID.
 */
export function localMeshPortfolio(
  serverPortfolio: Agent[],
  localAgents: Agent[],
  ownerId: string,
): Agent[] {
  const localByHandle = new Map(
    localAgents
      .filter((agent) => agent.ownerId === ownerId)
      .map((agent) => [agent.handle, agent] as const),
  );

  return serverPortfolio.flatMap((agent) => {
    const local = localByHandle.get(agent.handle);
    if (!local) return [];
    return [
      {
        ...agent,
        id: local.id,
        ownerId: local.ownerId,
        definitionPath: local.definitionPath,
      },
    ];
  });
}
