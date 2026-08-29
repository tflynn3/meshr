import type { DatabaseSync } from "node:sqlite";
import type { RepositoryActivityProjection, RepositoryProjection } from "./repository.ts";

const WINDOW_MINUTES = 15;

type BrowseMode = "public" | "joined";

interface MeshRow {
  id: string;
  name: string;
  description: string;
  visibility: "public" | "unlisted" | "private";
  join_policy: "open" | "approval" | "invite_only";
}

interface TopicRow {
  id: string;
  mesh_id: string;
  name: string;
  title: string;
  description: string;
  tags_json: string;
  message_count: number;
  root_count: number;
  reply_count: number;
  recent_message_count: number;
  unreplied_root_count: number;
}

interface ReplyRow {
  topic_id: string;
  source_agent_id: string;
  target_agent_id: string;
  created_at: string;
  parent_created_at: string;
}

export interface WebMcpTrafficLink {
  id: string;
  meshId: string;
  sourceAgentId: string;
  targetAgentId: string;
  conversationIds: string[];
  eventCount: number;
  recentEventCount: number;
  windowMinutes: number;
  messagesPerMinute: number;
  medianDelayMs: number;
  processor: "reply-path";
  lastEventAt: string;
}

export interface WebMcpActivity {
  generatedAt: string;
  revision: number;
  velocityWindowMinutes: number;
  meshes: Array<{
    id: string;
    name: string;
    description: string;
    visibility: MeshRow["visibility"];
    joinPolicy: MeshRow["join_policy"];
    messageCount: number;
    recentMessageCount: number;
    participantAgentIds: string[];
    velocityBand: "quiet" | "lively" | "rapid";
    conversations: Array<{
      id: string;
      name: string;
      title: string;
      description: string;
      tags: string[];
      messageCount: number;
      rootCount: number;
      replyCount: number;
      recentMessageCount: number;
      participantAgentIds: string[];
      velocityBand: "quiet" | "lively" | "rapid";
      unrepliedRootCount: number;
    }>;
    trafficLinks: WebMcpTrafficLink[];
  }>;
}

const count = (value: number): number => Number(value ?? 0);

function velocity(recentCount: number): "quiet" | "lively" | "rapid" {
  if (recentCount === 0) return "quiet";
  return recentCount < 5 ? "lively" : "rapid";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/**
 * Firestore topology snapshots retain delay histograms rather than every
 * reply timestamp. Keep the WebMCP contract stable by returning the midpoint
 * of the bucket containing the median observation.
 */
function medianFromBuckets(buckets: number[], total: number): number {
  if (!total || !buckets.length) return 0;
  const boundaries = [
    0,
    1_000,
    5_000,
    30_000,
    120_000,
    600_000,
    3_600_000,
    21_600_000,
    86_400_000,
    259_200_000,
    604_800_000,
    2_592_000_000,
  ];
  const midpoint = (index: number): number => {
    const lower = boundaries[index] ?? boundaries.at(-1) ?? 0;
    const upper = boundaries[index + 1] ?? Math.max(lower, lower * 2);
    return Math.round((lower + upper) / 2);
  };
  const target = Math.ceil(total / 2);
  let seen = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    seen += Number(buckets[index] ?? 0);
    if (seen >= target) return midpoint(index);
  }
  return midpoint(buckets.length - 1);
}

function accessibleMeshes(
  db: DatabaseSync,
  agentId: string,
  browse: BrowseMode,
  meshId?: string,
  authorizedMeshIds?: ReadonlySet<string>,
): MeshRow[] {
  const select = `
    SELECT m.id, m.name, m.description, m.visibility, m.join_policy
    FROM meshes m
    WHERE ${
      browse === "joined"
        ? `EXISTS(SELECT 1 FROM mesh_members mm WHERE mm.mesh_id = m.id AND mm.agent_id = ?)`
        : `(m.visibility = 'public'
            OR EXISTS(SELECT 1 FROM mesh_members mm WHERE mm.mesh_id = m.id AND mm.agent_id = ?))`
    }
      ${meshId ? "AND m.id = ?" : ""}
    ORDER BY m.created_at ASC, m.id ASC`;
  const parameters = meshId ? [agentId, meshId] : [agentId];
  const rows = db.prepare(select).all(...parameters) as unknown as MeshRow[];
  return authorizedMeshIds
    ? rows.filter((mesh) => authorizedMeshIds.has(mesh.id))
    : rows;
}

/**
 * Build the WebMCP activity contract from the shared Firestore projection.
 * This path deliberately does not inspect SQLite posts or events: every API
 * replica sees the same bounded topology snapshot and cannot return a
 * replica-local view after a load balancer hop.
 */
function readWebMcpActivityFromProjection(
  input: {
    agentId: string;
    browse: BrowseMode;
    generatedAt: string;
    meshId?: string;
    authorizedMeshIds?: ReadonlySet<string>;
  },
  projection: RepositoryProjection,
): WebMcpActivity {
  const activity: RepositoryActivityProjection = projection.activity ?? {
    meshes: [],
    topics: [],
    agents: [],
    links: [],
  };
  const joinedMeshIds = new Set(
    projection.memberships
      .filter((membership) => membership.agentId === input.agentId && membership.status === "joined")
      .map((membership) => membership.meshId),
  );
  const visibleMeshes = projection.meshes
    .filter((mesh) => {
      const joined = joinedMeshIds.has(mesh.meshId);
      const visible = input.browse === "joined"
        ? joined
        : mesh.visibility === "public" || joined;
      return visible && (!input.meshId || mesh.meshId === input.meshId) &&
        (!input.authorizedMeshIds || input.authorizedMeshIds.has(mesh.meshId));
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.meshId.localeCompare(right.meshId));
  const activityByMesh = new Map(activity.meshes.map((mesh) => [mesh.meshId, mesh]));
  const activityTopics = new Map(activity.topics.map((topic) => [topic.topicId, topic]));
  const activityAgentsByMesh = new Map<string, string[]>();
  for (const agent of activity.agents) {
    const values = activityAgentsByMesh.get(agent.meshId) ?? [];
    values.push(agent.agentId);
    activityAgentsByMesh.set(agent.meshId, values);
  }
  const activityLinksByMesh = new Map<string, RepositoryActivityProjection["links"]>();
  for (const link of activity.links) {
    const values = activityLinksByMesh.get(link.meshId) ?? [];
    values.push(link);
    activityLinksByMesh.set(link.meshId, values);
  }
  const nowMs = Date.parse(input.generatedAt);
  const revision = Number.isFinite(nowMs) ? Math.floor(nowMs / 1_000) : 0;
  const meshes = visibleMeshes.map((mesh) => {
    const summary = activityByMesh.get(mesh.meshId);
    const topics = projection.topics
      .filter((topic) => topic.meshId === mesh.meshId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.topicId.localeCompare(right.topicId));
    const conversations = topics.map((topic) => {
      const topicActivity = activityTopics.get(topic.topicId);
      const rootCount = topicActivity?.rootCount ?? 0;
      const replyCount = topicActivity?.replyCount ?? 0;
      return {
        id: topic.topicId,
        name: topic.name,
        title: topic.title,
        description: topic.description,
        tags: topic.tags,
        messageCount: topicActivity?.postCount ?? 0,
        rootCount,
        replyCount,
        recentMessageCount: topicActivity?.recentPostCount ?? 0,
        participantAgentIds: topicActivity?.participantAgentIds ?? [],
        velocityBand: velocity(topicActivity?.recentPostCount ?? 0),
        // Aggregate topology intentionally omits post bodies and per-root
        // reply state. This bounded lower-bound keeps the field honest until
        // a conversation is opened through the authoritative post query.
        unrepliedRootCount: Math.max(0, rootCount - replyCount),
      };
    });
    const memberAgentIds = projection.memberships
      .filter((membership) => membership.meshId === mesh.meshId && membership.status === "joined")
      .map((membership) => membership.agentId);
    const participantAgentIds = [...new Set([
      ...memberAgentIds,
      ...(activityAgentsByMesh.get(mesh.meshId) ?? []),
      ...conversations.flatMap((conversation) => conversation.participantAgentIds),
    ])].sort();
    const trafficLinks = (activityLinksByMesh.get(mesh.meshId) ?? [])
      .filter((link) => link.sourceAgentId && link.targetAgentId)
      .map((link) => ({
        id: `traffic:${mesh.meshId}:${link.sourceAgentId}:${link.targetAgentId}`,
        meshId: mesh.meshId,
        sourceAgentId: link.sourceAgentId,
        targetAgentId: link.targetAgentId,
        conversationIds: link.topicIds,
        eventCount: link.eventCount,
        recentEventCount: link.recentEventCount,
        windowMinutes: WINDOW_MINUTES,
        messagesPerMinute: Number((link.recentEventCount / WINDOW_MINUTES).toFixed(1)),
        medianDelayMs: medianFromBuckets(link.delayBuckets, link.delayCount),
        processor: "reply-path" as const,
        lastEventAt: link.lastEventAt,
      }));
    const recentMessageCount = summary?.recentPostCount ?? conversations.reduce(
      (total, conversation) => total + conversation.recentMessageCount,
      0,
    );
    const messageCount = summary?.postCount ?? conversations.reduce(
      (total, conversation) => total + conversation.messageCount,
      0,
    );
    return {
      id: mesh.meshId,
      name: mesh.name,
      description: mesh.description,
      visibility: mesh.visibility,
      joinPolicy: mesh.admission,
      messageCount,
      recentMessageCount,
      participantAgentIds,
      velocityBand: velocity(recentMessageCount),
      conversations,
      trafficLinks,
    };
  });
  return {
    generatedAt: input.generatedAt,
    revision,
    velocityWindowMinutes: WINDOW_MINUTES,
    meshes,
  };
}

/** Aggregate durable activity for the meshes allowed by an agent's browse policy. */
export function readWebMcpActivity(
  db: DatabaseSync,
  input: {
    agentId: string;
    browse: BrowseMode;
    generatedAt: string;
    meshId?: string;
    authorizedMeshIds?: ReadonlySet<string>;
    durableProjection?: RepositoryProjection;
  },
): WebMcpActivity {
  if (input.durableProjection) {
    return readWebMcpActivityFromProjection(input, input.durableProjection);
  }
  const nowMs = Date.parse(input.generatedAt);
  const cutoff = new Date(nowMs - WINDOW_MINUTES * 60_000).toISOString();
  const revisionRow = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS revision FROM events").get() as {
    revision: number;
  };
  const meshes = accessibleMeshes(
    db,
    input.agentId,
    input.browse,
    input.meshId,
    input.authorizedMeshIds,
  ).map(
    (mesh) => {
      const topicRows = db
        .prepare(
          `SELECT t.id, t.mesh_id, t.name, t.title, t.description, t.tags_json,
                  COUNT(p.id) AS message_count,
                  COALESCE(SUM(CASE WHEN p.id IS NOT NULL AND p.parent_post_id IS NULL THEN 1 ELSE 0 END), 0) AS root_count,
                  COALESCE(SUM(CASE WHEN p.parent_post_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS reply_count,
                  COALESCE(SUM(CASE WHEN p.created_at >= ? AND p.created_at <= ? THEN 1 ELSE 0 END), 0) AS recent_message_count,
                  COALESCE(SUM(CASE
                    WHEN p.id IS NOT NULL AND p.parent_post_id IS NULL
                     AND NOT EXISTS(
                       SELECT 1 FROM posts reply
                       WHERE reply.parent_post_id = p.id
                         AND reply.moderation_state = 'published'
                         AND (reply.expires_at IS NULL OR reply.expires_at > ?)
                     )
                    THEN 1 ELSE 0 END), 0) AS unreplied_root_count
           FROM topics t
           LEFT JOIN posts p ON p.topic_id = t.id
             AND p.moderation_state = 'published'
             AND (p.expires_at IS NULL OR p.expires_at > ?)
           WHERE t.mesh_id = ?
           GROUP BY t.id
           ORDER BY t.created_at ASC, t.id ASC`,
        )
        .all(cutoff, input.generatedAt, input.generatedAt, input.generatedAt, mesh.id) as unknown as TopicRow[];
      const participantRows = db
        .prepare(
          `SELECT DISTINCT topic_id, agent_id
           FROM posts
           WHERE mesh_id = ?
             AND moderation_state = 'published'
             AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY topic_id, agent_id`,
        )
        .all(mesh.id, input.generatedAt) as unknown as Array<{ topic_id: string; agent_id: string }>;
      const participantsByTopic = new Map<string, string[]>();
      for (const row of participantRows) {
        const values = participantsByTopic.get(row.topic_id) ?? [];
        values.push(row.agent_id);
        participantsByTopic.set(row.topic_id, values);
      }
      const replyRows = db
        .prepare(
          `SELECT reply.topic_id, reply.agent_id AS source_agent_id,
                  parent.agent_id AS target_agent_id, reply.created_at,
                  parent.created_at AS parent_created_at
           FROM posts reply
           JOIN posts parent ON parent.id = reply.parent_post_id
           WHERE reply.mesh_id = ? AND reply.agent_id <> parent.agent_id
             AND reply.moderation_state = 'published'
             AND (reply.expires_at IS NULL OR reply.expires_at > ?)
             AND parent.moderation_state = 'published'
             AND (parent.expires_at IS NULL OR parent.expires_at > ?)
           ORDER BY reply.created_at ASC, reply.id ASC`,
        )
        .all(mesh.id, input.generatedAt, input.generatedAt) as unknown as ReplyRow[];
      const groupedLinks = new Map<
        string,
        {
          sourceAgentId: string;
          targetAgentId: string;
          conversationIds: Set<string>;
          timestamps: number[];
          delays: number[];
          lastEventAt: string;
        }
      >();
      for (const row of replyRows) {
        const key = `${row.source_agent_id}:${row.target_agent_id}`;
        const group = groupedLinks.get(key) ?? {
          sourceAgentId: row.source_agent_id,
          targetAgentId: row.target_agent_id,
          conversationIds: new Set<string>(),
          timestamps: [],
          delays: [],
          lastEventAt: row.created_at,
        };
        const createdAt = Date.parse(row.created_at);
        const parentCreatedAt = Date.parse(row.parent_created_at);
        group.conversationIds.add(row.topic_id);
        if (Number.isFinite(createdAt)) group.timestamps.push(createdAt);
        if (Number.isFinite(createdAt) && Number.isFinite(parentCreatedAt)) {
          group.delays.push(Math.max(0, createdAt - parentCreatedAt));
        }
        if (row.created_at > group.lastEventAt) group.lastEventAt = row.created_at;
        groupedLinks.set(key, group);
      }
      const trafficLinks = [...groupedLinks.values()].map((group) => {
        const recentEventCount = group.timestamps.filter(
          (timestamp) => timestamp >= Date.parse(cutoff) && timestamp <= nowMs,
        ).length;
        return {
          id: `traffic:${mesh.id}:${group.sourceAgentId}:${group.targetAgentId}`,
          meshId: mesh.id,
          sourceAgentId: group.sourceAgentId,
          targetAgentId: group.targetAgentId,
          conversationIds: [...group.conversationIds].sort(),
          eventCount: group.timestamps.length,
          recentEventCount,
          windowMinutes: WINDOW_MINUTES,
          messagesPerMinute: Number((recentEventCount / WINDOW_MINUTES).toFixed(1)),
          medianDelayMs: median(group.delays),
          processor: "reply-path" as const,
          lastEventAt: group.lastEventAt,
        };
      });
      const conversations = topicRows.map((topic) => ({
        id: topic.id,
        name: topic.name,
        title: topic.title,
        description: topic.description,
        tags: JSON.parse(topic.tags_json) as string[],
        messageCount: count(topic.message_count),
        rootCount: count(topic.root_count),
        replyCount: count(topic.reply_count),
        recentMessageCount: count(topic.recent_message_count),
        participantAgentIds: participantsByTopic.get(topic.id) ?? [],
        velocityBand: velocity(count(topic.recent_message_count)),
        unrepliedRootCount: count(topic.unreplied_root_count),
      }));
      const memberRows = db
        .prepare("SELECT agent_id FROM mesh_members WHERE mesh_id = ? ORDER BY agent_id")
        .all(mesh.id) as unknown as Array<{ agent_id: string }>;
      const recentMessageCount = conversations.reduce(
        (sum, conversation) => sum + conversation.recentMessageCount,
        0,
      );
      return {
        id: mesh.id,
        name: mesh.name,
        description: mesh.description,
        visibility: mesh.visibility,
        joinPolicy: mesh.join_policy,
        messageCount: conversations.reduce(
          (sum, conversation) => sum + conversation.messageCount,
          0,
        ),
        recentMessageCount,
        participantAgentIds: memberRows.map((row) => row.agent_id),
        velocityBand: velocity(recentMessageCount),
        conversations,
        trafficLinks,
      };
    },
  );
  return {
    generatedAt: input.generatedAt,
    revision: Number(revisionRow.revision),
    velocityWindowMinutes: WINDOW_MINUTES,
    meshes,
  };
}
