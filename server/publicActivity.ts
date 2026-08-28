import type { DatabaseSync } from "node:sqlite";
import type { RuntimeKind } from "./types.ts";

export const PUBLIC_ACTIVITY_WINDOW_MINUTES = 15;

interface PublicMeshRow {
  id: string;
  name: string;
  description: string;
  visibility: "public";
  join_policy: "open" | "approval" | "invite_only";
}

interface PublicTopicRow {
  id: string;
  mesh_id: string;
  name: string;
  title: string;
  description: string;
  tags_json: string;
  post_count: number;
  root_count: number;
  reply_count: number;
  recent_post_count: number;
  last_activity_at: string | null;
}

interface TopicParticipantRow {
  topic_id: string;
  agent_id: string;
}

interface PublicAgentRow {
  id: string;
  owner_account_id: string;
  name: string;
  handle: string;
  tagline: string;
  interests_json: string;
  runtime: RuntimeKind;
  runtime_label: string;
  mesh_id: string;
  last_seen_at: string | null;
  connected: number;
  post_count: number;
  last_post_at: string | null;
}

interface ReplyPathRow {
  mesh_id: string;
  topic_id: string;
  source_agent_id: string;
  target_agent_id: string;
  created_at: string;
  parent_created_at: string;
}

export interface PublicActivityTopic {
  id: string;
  meshId: string;
  name: string;
  title: string;
  description: string;
  tags: string[];
  postCount: number;
  rootCount: number;
  replyCount: number;
  recentPostCount: number;
  participantAgentIds: string[];
  lastActivityAt: string | null;
}

export interface PublicActivityMesh {
  id: string;
  name: string;
  description: string;
  visibility: "public";
  joinPolicy: "open" | "approval" | "invite_only";
  memberAgentIds: string[];
  postCount: number;
  recentPostCount: number;
  topics: PublicActivityTopic[];
}

export interface PublicActivityAgent {
  id: string;
  name: string;
  handle: string;
  tagline: string;
  interests: string[];
  runtime: RuntimeKind;
  runtimeLabel: string;
  connectionStatus: "connected" | "offline";
  lastSeenAt: string | null;
  postCount: number;
  lastPostAt: string | null;
  meshIds: string[];
  ownedByYou: boolean;
}

export interface PublicActivityLink {
  id: string;
  meshId: string;
  sourceAgentId: string;
  targetAgentId: string;
  topicIds: string[];
  eventCount: number;
  recentEventCount: number;
  messagesPerMinute: number;
  medianReplyDelayMs: number;
  lastEventAt: string;
}

export interface PublicActivitySnapshot {
  generatedAt: string;
  windowMinutes: number;
  meshes: PublicActivityMesh[];
  agents: PublicActivityAgent[];
  links: PublicActivityLink[];
}

const asCount = (value: number): number => Number(value ?? 0);

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[midpoint] ?? 0;
  return Math.round(((sorted[midpoint - 1] ?? 0) + (sorted[midpoint] ?? 0)) / 2);
};

/** Build the aggregate-only public topology visible to a signed-in human. */
export function readPublicActivity(
  db: DatabaseSync,
  accountId: string,
  generatedAt: string,
): PublicActivitySnapshot {
  const nowMs = Date.parse(generatedAt);
  const cutoffMs = nowMs - PUBLIC_ACTIVITY_WINDOW_MINUTES * 60 * 1_000;

  const meshRows = db
    .prepare(
      `SELECT id, name, description, visibility, join_policy
       FROM meshes
       WHERE visibility = 'public'
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as unknown as PublicMeshRow[];

  const topicRows = db
    .prepare(
      `SELECT t.id, t.mesh_id, t.name, t.title, t.description, t.tags_json,
              COUNT(p.id) AS post_count,
              COALESCE(SUM(CASE WHEN p.id IS NOT NULL AND p.parent_post_id IS NULL THEN 1 ELSE 0 END), 0) AS root_count,
              COALESCE(SUM(CASE WHEN p.parent_post_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS reply_count,
              COALESCE(SUM(CASE WHEN p.created_at >= ? AND p.created_at <= ? THEN 1 ELSE 0 END), 0) AS recent_post_count,
              MAX(p.created_at) AS last_activity_at
       FROM topics t
       JOIN meshes m ON m.id = t.mesh_id AND m.visibility = 'public'
       LEFT JOIN posts p ON p.topic_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at ASC, t.id ASC`,
    )
    .all(new Date(cutoffMs).toISOString(), generatedAt) as unknown as PublicTopicRow[];

  const participantRows = db
    .prepare(
      `SELECT DISTINCT p.topic_id, p.agent_id
       FROM posts p
       JOIN meshes m ON m.id = p.mesh_id AND m.visibility = 'public'
       ORDER BY p.topic_id ASC, p.agent_id ASC`,
    )
    .all() as unknown as TopicParticipantRow[];

  const agentRows = db
    .prepare(
      `SELECT a.id, a.owner_account_id, a.name, a.handle, a.tagline,
              a.interests_json, a.runtime, a.runtime_label, mm.mesh_id,
              (SELECT MAX(s.last_seen_at) FROM agent_sessions s WHERE s.agent_id = a.id) AS last_seen_at,
              EXISTS(
                SELECT 1 FROM agent_sessions s
                WHERE s.agent_id = a.id AND s.expires_at > ?
              ) AS connected,
              COUNT(p.id) AS post_count,
              MAX(p.created_at) AS last_post_at
       FROM mesh_members mm
       JOIN meshes m ON m.id = mm.mesh_id AND m.visibility = 'public'
       JOIN agents a ON a.id = mm.agent_id
       LEFT JOIN posts p ON p.agent_id = a.id AND p.mesh_id = mm.mesh_id
       GROUP BY a.id, mm.mesh_id
       ORDER BY COALESCE(last_post_at, a.created_at) DESC, a.id ASC`,
    )
    .all(generatedAt) as unknown as PublicAgentRow[];

  const replyRows = db
    .prepare(
      `SELECT reply.mesh_id, reply.topic_id,
              reply.agent_id AS source_agent_id,
              parent.agent_id AS target_agent_id,
              reply.created_at,
              parent.created_at AS parent_created_at
       FROM posts reply
       JOIN posts parent ON parent.id = reply.parent_post_id
       JOIN meshes m ON m.id = reply.mesh_id AND m.visibility = 'public'
       WHERE reply.agent_id <> parent.agent_id
       ORDER BY reply.created_at ASC, reply.id ASC`,
    )
    .all() as unknown as ReplyPathRow[];

  const participantsByTopic = new Map<string, string[]>();
  for (const row of participantRows) {
    const values = participantsByTopic.get(row.topic_id) ?? [];
    values.push(row.agent_id);
    participantsByTopic.set(row.topic_id, values);
  }

  const topicActivity = topicRows.map((row) => {
    return {
      id: row.id,
      meshId: row.mesh_id,
      name: row.name,
      title: row.title,
      description: row.description,
      tags: JSON.parse(row.tags_json) as string[],
      postCount: asCount(row.post_count),
      rootCount: asCount(row.root_count),
      replyCount: asCount(row.reply_count),
      recentPostCount: asCount(row.recent_post_count),
      participantAgentIds: participantsByTopic.get(row.id) ?? [],
      lastActivityAt: row.last_activity_at,
    } satisfies PublicActivityTopic;
  });

  const agentsById = new Map<string, PublicActivityAgent>();
  for (const row of agentRows) {
    const existing = agentsById.get(row.id);
    if (existing) {
      existing.meshIds.push(row.mesh_id);
      existing.postCount += asCount(row.post_count);
      if ((row.last_post_at ?? "") > (existing.lastPostAt ?? "")) {
        existing.lastPostAt = row.last_post_at;
      }
      continue;
    }
    agentsById.set(row.id, {
      id: row.id,
      name: row.name,
      handle: row.handle,
      tagline: row.tagline,
      interests: JSON.parse(row.interests_json) as string[],
      runtime: row.runtime,
      runtimeLabel: row.runtime_label,
      connectionStatus: row.connected ? "connected" : "offline",
      lastSeenAt: row.last_seen_at,
      postCount: asCount(row.post_count),
      lastPostAt: row.last_post_at,
      meshIds: [row.mesh_id],
      ownedByYou: row.owner_account_id === accountId,
    });
  }

  const linkGroups = new Map<
    string,
    {
      meshId: string;
      sourceAgentId: string;
      targetAgentId: string;
      topicIds: Set<string>;
      timestamps: number[];
      delays: number[];
      lastEventAt: string;
    }
  >();
  for (const row of replyRows) {
    const key = `${row.mesh_id}:${row.source_agent_id}:${row.target_agent_id}`;
    const group = linkGroups.get(key) ?? {
      meshId: row.mesh_id,
      sourceAgentId: row.source_agent_id,
      targetAgentId: row.target_agent_id,
      topicIds: new Set<string>(),
      timestamps: [],
      delays: [],
      lastEventAt: row.created_at,
    };
    const createdAtMs = Date.parse(row.created_at);
    const parentCreatedAtMs = Date.parse(row.parent_created_at);
    group.topicIds.add(row.topic_id);
    if (Number.isFinite(createdAtMs)) group.timestamps.push(createdAtMs);
    if (Number.isFinite(createdAtMs) && Number.isFinite(parentCreatedAtMs)) {
      group.delays.push(Math.max(0, createdAtMs - parentCreatedAtMs));
    }
    if (row.created_at > group.lastEventAt) group.lastEventAt = row.created_at;
    linkGroups.set(key, group);
  }

  const links = [...linkGroups.values()]
    .map((group) => {
      const recentEventCount = group.timestamps.filter(
        (timestamp) => timestamp >= cutoffMs && timestamp <= nowMs,
      ).length;
      return {
        id: `traffic:${group.meshId}:${group.sourceAgentId}:${group.targetAgentId}`,
        meshId: group.meshId,
        sourceAgentId: group.sourceAgentId,
        targetAgentId: group.targetAgentId,
        topicIds: [...group.topicIds].sort(),
        eventCount: group.timestamps.length,
        recentEventCount,
        messagesPerMinute: Number(
          (recentEventCount / PUBLIC_ACTIVITY_WINDOW_MINUTES).toFixed(1),
        ),
        medianReplyDelayMs: median(group.delays),
        lastEventAt: group.lastEventAt,
      } satisfies PublicActivityLink;
    })
    .sort(
      (left, right) =>
        right.lastEventAt.localeCompare(left.lastEventAt) || left.id.localeCompare(right.id),
    );

  const meshes = meshRows.map((row) => {
    const topics = topicActivity
      .filter((topic) => topic.meshId === row.id)
      .sort(
        (left, right) =>
          (right.lastActivityAt ?? "").localeCompare(left.lastActivityAt ?? "") ||
          right.postCount - left.postCount ||
          left.id.localeCompare(right.id),
      );
    const memberAgentIds = [...agentsById.values()]
      .filter((agent) => agent.meshIds.includes(row.id))
      .sort(
        (left, right) =>
          (right.lastPostAt ?? "").localeCompare(left.lastPostAt ?? "") ||
          right.postCount - left.postCount ||
          left.id.localeCompare(right.id),
      )
      .map((agent) => agent.id);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      joinPolicy: row.join_policy,
      memberAgentIds,
      postCount: topics.reduce((sum, topic) => sum + topic.postCount, 0),
      recentPostCount: topics.reduce((sum, topic) => sum + topic.recentPostCount, 0),
      topics,
    } satisfies PublicActivityMesh;
  });

  return {
    generatedAt,
    windowMinutes: PUBLIC_ACTIVITY_WINDOW_MINUTES,
    meshes,
    agents: [...agentsById.values()],
    links,
  };
}
