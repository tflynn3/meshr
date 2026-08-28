import type { PublicActivitySnapshot } from "../auth/api";
import { createDefaultMeshRolePolicy } from "./types";
import type { Agent, AgentColor, MeshState, RuntimeBinding } from "./types";
import type { TrafficLink } from "./topology";

const colors: AgentColor[] = ["violet", "green", "blue", "coral", "yellow"];

function colorFor(value: string): AgentColor {
  const index = [...value].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return colors[index % colors.length] ?? "green";
}

function toAgent(
  agent: PublicActivitySnapshot["agents"][number],
  currentOwnerId: string,
): Agent {
  const interests = agent.interests.length ? agent.interests : ["Curiosity"];
  return {
    id: agent.id,
    ownerId: agent.ownedByYou ? currentOwnerId : `public-owner:${agent.id}`,
    name: agent.name,
    handle: agent.handle,
    initials: agent.name
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase(),
    color: colorFor(agent.handle),
    tagline: agent.tagline,
    interests,
    reads: [`Conversations about ${interests.slice(0, 2).join(" and ")}`],
    shares: ["Connections and observations"],
    attention: {
      browse: "public",
      rootPosts: "draft",
      replies: "draft",
      notes: interests.join(", "),
    },
    personality: "",
    definitionPath: `synced://${agent.handle}`,
  };
}

function toRuntimeBinding(
  agent: PublicActivitySnapshot["agents"][number],
): RuntimeBinding {
  return {
    id: `public-activity:${agent.id}`,
    agentId: agent.id,
    runtime: agent.runtime === "ollama" ? "local" : agent.runtime,
    label: agent.runtimeLabel,
    status: agent.connectionStatus,
    lastSeenAt: agent.lastSeenAt ?? agent.lastPostAt ?? "",
  };
}

export interface AppliedPublicActivity {
  state: MeshState;
  trafficLinks: TrafficLink[];
}

/** Overlay server-owned activity without disturbing unrelated local fixtures. */
export function applyPublicActivitySnapshot(
  baseState: MeshState,
  snapshot: PublicActivitySnapshot,
  currentOwnerId: string,
): AppliedPublicActivity {
  const serverMeshIds = new Set(snapshot.meshes.map((mesh) => mesh.id));
  const serverAgentIds = new Set(snapshot.agents.map((agent) => agent.id));
  const existingMeshes = new Map(baseState.meshes.map((mesh) => [mesh.id, mesh]));

  const serverMeshes = snapshot.meshes.map((mesh) => {
    const existing = existingMeshes.get(mesh.id);
    return {
      id: mesh.id,
      ownerId: existing?.ownerId ?? "server-public",
      name: mesh.name,
      description: mesh.description,
      visibility: mesh.visibility,
      joinPolicy: mesh.joinPolicy,
      memberAgentIds: mesh.memberAgentIds,
      humanRoleAssignments:
        existing?.humanRoleAssignments ?? [{ ownerId: currentOwnerId, role: "observer" as const }],
      rolePolicy: existing?.rolePolicy ?? createDefaultMeshRolePolicy(),
      accent: existing?.accent ?? ("green" as const),
    };
  });

  const serverTopics = snapshot.meshes.flatMap((mesh) =>
    mesh.topics.map((topic, index) => ({
      id: topic.id,
      meshId: mesh.id,
      name: topic.name,
      title: topic.title,
      description: topic.description,
      tags: topic.tags,
      activityCount: topic.postCount,
      recentActivityCount: topic.recentPostCount,
      participantAgentIds: topic.participantAgentIds,
      lastActivityAt: topic.lastActivityAt ?? undefined,
      accent: (["green", "violet", "coral", "yellow", "blue"] as const)[index % 5]!,
    })),
  );

  const trafficLinks = snapshot.links.map((link) => ({
    id: link.id,
    meshId: link.meshId,
    sourceAgentId: link.sourceAgentId,
    targetAgentId: link.targetAgentId,
    conversationIds: link.topicIds,
    eventCount: link.eventCount,
    recentEventCount: link.recentEventCount,
    windowMinutes: snapshot.windowMinutes,
    messagesPerMinute: link.messagesPerMinute,
    medianDelayMs: link.medianReplyDelayMs,
    processor: "reply-path" as const,
    lastEventAt: link.lastEventAt,
  }));

  const serverMeshesById = new Map(serverMeshes.map((mesh) => [mesh.id, mesh]));
  const mergedMeshes = baseState.meshes.map(
    (mesh) => serverMeshesById.get(mesh.id) ?? mesh,
  );
  for (const mesh of serverMeshes) {
    if (!existingMeshes.has(mesh.id)) mergedMeshes.push(mesh);
  }

  return {
    state: {
      ...baseState,
      agents: [
        ...baseState.agents.filter((agent) => !serverAgentIds.has(agent.id)),
        ...snapshot.agents.map((agent) => toAgent(agent, currentOwnerId)),
      ],
      runtimeBindings: [
        ...baseState.runtimeBindings.filter(
          (binding) => !serverAgentIds.has(binding.agentId),
        ),
        ...snapshot.agents.map(toRuntimeBinding),
      ],
      meshes: mergedMeshes,
      topics: [
        ...baseState.topics.filter((topic) => !serverMeshIds.has(topic.meshId)),
        ...serverTopics,
      ],
      posts: baseState.posts.filter((post) => !serverMeshIds.has(post.meshId)),
      revision: baseState.revision + 1,
    },
    trafficLinks,
  };
}
