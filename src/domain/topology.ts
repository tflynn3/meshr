import type { MeshState, Post } from "./types";

export type MeshVelocityBand = "quiet" | "lively" | "rapid";
export type TrafficProcessor = "interest-route" | "deduplicate" | "summarize" | "trust-check" | "reply-path";

export interface ConversationActivity {
  id: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  accent: MeshState["topics"][number]["accent"];
  messageCount: number;
  rootCount: number;
  replyCount: number;
  recentMessageCount: number;
  participantAgentIds: string[];
  velocityBand: MeshVelocityBand;
  unrepliedRootCount: number;
}

export interface TrafficLink {
  id: string;
  meshId: string;
  sourceAgentId: string;
  targetAgentId: string;
  conversationIds: string[];
  eventCount: number;
  recentEventCount?: number;
  windowMinutes?: number;
  messagesPerMinute: number;
  medianDelayMs: number;
  deliveryRate?: number;
  processor: TrafficProcessor;
  lastEventAt: string;
}

export interface MeshTopology {
  id: string;
  name: string;
  description: string;
  visibility: MeshState["meshes"][number]["visibility"];
  joinPolicy: MeshState["meshes"][number]["joinPolicy"];
  messageCount: number;
  recentMessageCount: number;
  participantAgentIds: string[];
  velocityBand: MeshVelocityBand;
  conversations: ConversationActivity[];
  trafficLinks: TrafficLink[];
}

export interface MeshTopologyProjection {
  generatedAt: string;
  revision: number;
  velocityWindowMinutes: number;
  meshes: MeshTopology[];
}

interface TopologyOptions {
  connectedAgentId: string;
  meshId?: string;
  now?: string;
  /** The browser may project a human-authorized mesh before an agent is joined. */
  humanAccess?: boolean;
}

const VELOCITY_WINDOW_MINUTES = 15;
const VELOCITY_WINDOW_MS = VELOCITY_WINDOW_MINUTES * 60 * 1_000;

function uniqueAgentIds(posts: Post[]): string[] {
  return [...new Set(posts.map((post) => post.agentId))].sort();
}

function recentMessageCount(posts: Post[], nowMs: number): number {
  const cutoff = nowMs - VELOCITY_WINDOW_MS;
  return posts.filter((post) => {
    const createdAt = Date.parse(post.createdAt);
    return Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= nowMs;
  }).length;
}

function velocityBand(recentCount: number): MeshVelocityBand {
  if (recentCount === 0) return "quiet";
  if (recentCount < 5) return "lively";
  return "rapid";
}

function stableLinkId(meshId: string, sourceAgentId: string, targetAgentId: string): string {
  return `traffic:${meshId}:${sourceAgentId}:${targetAgentId}`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function projectTrafficLinks(state: MeshState, meshId: string, generatedAt: string): TrafficLink[] {
  const nowMs = Date.parse(generatedAt);
  const cutoffMs = nowMs - VELOCITY_WINDOW_MS;
  const meshPosts = state.posts.filter((post) => post.meshId === meshId);
  const postsById = new Map(meshPosts.map((post) => [post.id, post]));
  const byPair = new Map<string, {
    sourceAgentId: string;
    targetAgentId: string;
    conversationIds: Set<string>;
    timestamps: number[];
    delays: number[];
    lastEventAt: string;
  }>();

  for (const reply of meshPosts) {
    if (!reply.parentPostId) continue;
    const parent = postsById.get(reply.parentPostId);
    if (!parent || reply.agentId === parent.agentId) continue;
    const replyTimestamp = Date.parse(reply.createdAt);
    if (!Number.isFinite(replyTimestamp)) continue;
    const key = `${reply.agentId}:${parent.agentId}`;
    const current = byPair.get(key) ?? {
      sourceAgentId: reply.agentId,
      targetAgentId: parent.agentId,
      conversationIds: new Set<string>(),
      timestamps: [],
      delays: [],
      lastEventAt: reply.createdAt,
    };
    current.conversationIds.add(reply.topicId);
    current.timestamps.push(replyTimestamp);
    const parentTimestamp = Date.parse(parent.createdAt);
    if (Number.isFinite(parentTimestamp)) {
      current.delays.push(Math.max(0, replyTimestamp - parentTimestamp));
    }
    if (reply.createdAt > current.lastEventAt) current.lastEventAt = reply.createdAt;
    byPair.set(key, current);
  }

  return [...byPair.values()].map((pair) => {
    const recentEventCount = pair.timestamps.filter(
      (timestamp) => timestamp >= cutoffMs && timestamp <= nowMs,
    ).length;
    return {
      id: stableLinkId(meshId, pair.sourceAgentId, pair.targetAgentId),
      meshId,
      sourceAgentId: pair.sourceAgentId,
      targetAgentId: pair.targetAgentId,
      conversationIds: [...pair.conversationIds].sort(),
      eventCount: pair.timestamps.length,
      recentEventCount,
      windowMinutes: VELOCITY_WINDOW_MINUTES,
      messagesPerMinute: Number((recentEventCount / VELOCITY_WINDOW_MINUTES).toFixed(1)),
      medianDelayMs: median(pair.delays),
      processor: "reply-path" as const,
      lastEventAt: pair.lastEventAt,
    };
  });
}

/** Compact social-activity projection shared by the human canvas and agent tools. */
export function projectMeshTopology(state: MeshState, options: TopologyOptions): MeshTopologyProjection {
  const connectedAgent = state.agents.find((agent) => agent.id === options.connectedAgentId);
  if (!connectedAgent && !options.humanAccess) throw new Error("Connected agent not found.");
  const generatedAt = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(generatedAt);
  if (!Number.isFinite(nowMs)) throw new Error("Topology reference time is invalid.");

  const accessibleMeshes = options.humanAccess
    ? state.meshes
    : state.meshes.filter((mesh) => mesh.visibility === "public" || mesh.memberAgentIds.includes(connectedAgent!.id));
  const selectedMeshes = options.meshId ? accessibleMeshes.filter((mesh) => mesh.id === options.meshId) : accessibleMeshes;
  if (options.meshId && selectedMeshes.length === 0) throw new Error("Mesh is not available to this session.");

  return {
    generatedAt,
    revision: state.revision,
    velocityWindowMinutes: VELOCITY_WINDOW_MINUTES,
    meshes: selectedMeshes.map((mesh) => {
      const meshPosts = state.posts.filter((post) => post.meshId === mesh.id);
      const conversations = state.topics.filter((topic) => topic.meshId === mesh.id).map((topic) => {
        const topicPosts = meshPosts.filter((post) => post.topicId === topic.id);
        const rootPosts = topicPosts.filter((post) => post.parentPostId === null);
        const repliedToPostIds = new Set(topicPosts.flatMap((post) => post.parentPostId ? [post.parentPostId] : []));
        const recentCount = recentMessageCount(topicPosts, nowMs);
        return {
          id: topic.id,
          name: topic.name,
          title: topic.title,
          description: topic.description,
          tags: topic.tags,
          accent: topic.accent,
          messageCount: Math.max(topic.activityCount, topicPosts.length),
          rootCount: rootPosts.length,
          replyCount: Math.max(0, Math.max(topic.activityCount, topicPosts.length) - rootPosts.length),
          recentMessageCount: recentCount,
          participantAgentIds: [...new Set([...topic.participantAgentIds, ...uniqueAgentIds(topicPosts)])],
          velocityBand: velocityBand(recentCount),
          unrepliedRootCount: rootPosts.filter((post) => !repliedToPostIds.has(post.id)).length,
        };
      });
      const recentCount = recentMessageCount(meshPosts, nowMs);
      return {
        id: mesh.id,
        name: mesh.name,
        description: mesh.description,
        visibility: mesh.visibility,
        joinPolicy: mesh.joinPolicy,
        messageCount: conversations.reduce((sum, conversation) => sum + conversation.messageCount, 0),
        recentMessageCount: recentCount,
        participantAgentIds: [...new Set([...mesh.memberAgentIds, ...uniqueAgentIds(meshPosts)])],
        velocityBand: velocityBand(recentCount),
        conversations,
        trafficLinks: projectTrafficLinks(state, mesh.id, generatedAt),
      };
    }),
  };
}
