import type { DatabaseSync } from "node:sqlite";
import type {
  RepositoryActivityProjection,
  RepositoryProjection,
} from "./repository.ts";

const WINDOW_MINUTES = 15;

/**
 * The activity catalog is injected into an agent's model context. Keep both
 * its cardinality and final serialized size bounded even when public meshes
 * contain attacker-authored metadata. A caller can request one mesh for a
 * narrower follow-up view.
 */
export const WEBMCP_ACTIVITY_LIMITS = Object.freeze({
  responseBytes: 256 * 1_024,
  meshes: 12,
  conversationsPerMesh: 12,
  participantsPerConversation: 12,
  participantsPerMesh: 24,
  trafficLinksPerMesh: 12,
  conversationsPerTrafficLink: 12,
});

const MAX_REPLY_ROWS_PER_MESH = 1_500;
const MAX_IDENTIFIER_CHARACTERS = 128;
const MAX_MESH_NAME_CHARACTERS = 80;
const MAX_TOPIC_NAME_CHARACTERS = 64;
const MAX_TOPIC_TITLE_CHARACTERS = 100;
const MAX_DESCRIPTION_CHARACTERS = 500;
const MAX_TAG_CHARACTERS = 32;
const MAX_TAGS_PER_CONVERSATION = 12;

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
  limits: typeof WEBMCP_ACTIVITY_LIMITS;
  truncated: {
    responseBytes: boolean;
    meshes: boolean;
    conversations: boolean;
    participants: boolean;
    trafficLinks: boolean;
    metadata: boolean;
  };
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

type ActivityTruncation = WebMcpActivity["truncated"];

function newTruncation(): ActivityTruncation {
  return {
    responseBytes: false,
    meshes: false,
    conversations: false,
    participants: false,
    trafficLinks: false,
    metadata: false,
  };
}

function boundedText(
  value: string,
  maximum: number,
  truncated: ActivityTruncation,
): string {
  if (value.length <= maximum) return value;
  truncated.metadata = true;
  return value.slice(0, maximum);
}

function boundedIdentifiers(
  values: readonly string[],
  maximum: number,
  truncated: ActivityTruncation,
  category: "participants" | "trafficLinks",
): string[] {
  const unique = new Set<string>();
  for (const rawValue of values) {
    const value = boundedText(rawValue, MAX_IDENTIFIER_CHARACTERS, truncated);
    if (unique.has(value)) continue;
    if (unique.size >= maximum + 1) {
      truncated[category] = true;
      break;
    }
    unique.add(value);
  }
  if (unique.size > maximum) truncated[category] = true;
  return [...unique].sort().slice(0, maximum);
}

function boundedTags(
  values: readonly string[],
  truncated: ActivityTruncation,
): string[] {
  if (values.length > MAX_TAGS_PER_CONVERSATION) truncated.metadata = true;
  return values
    .slice(0, MAX_TAGS_PER_CONVERSATION)
    .map((tag) => boundedText(tag, MAX_TAG_CHARACTERS, truncated));
}

function parseTags(value: string, truncated: ActivityTruncation): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((tag) => typeof tag === "string")
    ) {
      return boundedTags(parsed, truncated);
    }
  } catch {
    // Invalid legacy metadata is omitted rather than breaking the whole tool.
  }
  truncated.metadata = true;
  return [];
}

function retainSmallest<T>(
  values: T[],
  value: T,
  maximum: number,
  compare: (left: T, right: T) => number,
): boolean {
  values.push(value);
  values.sort(compare);
  if (values.length <= maximum) return false;
  values.pop();
  return true;
}

function finalizeActivity(activity: WebMcpActivity): WebMcpActivity {
  const serializedBytes = (): number =>
    Buffer.byteLength(JSON.stringify(activity));
  if (serializedBytes() <= WEBMCP_ACTIVITY_LIMITS.responseBytes)
    return activity;

  activity.truncated.responseBytes = true;
  // Structural limits above already make each mesh small. If unusually long
  // valid identifiers still exhaust the byte budget, remove complete trailing
  // meshes so the catalog remains valid JSON with a deterministic prefix.
  while (
    activity.meshes.length > 0 &&
    serializedBytes() > WEBMCP_ACTIVITY_LIMITS.responseBytes
  ) {
    activity.meshes.pop();
    activity.truncated.meshes = true;
  }
  return activity;
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
    0, 1_000, 5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000,
    86_400_000, 259_200_000, 604_800_000, 2_592_000_000,
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
  const authorized = authorizedMeshIds
    ? [...authorizedMeshIds].sort()
    : undefined;
  if (authorized?.length === 0) return [];
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
      ${authorized ? `AND m.id IN (${authorized.map(() => "?").join(", ")})` : ""}
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT ?`;
  const parameters: Array<string | number> = [
    agentId,
    ...(meshId ? [meshId] : []),
    ...(authorized ?? []),
    meshId ? 1 : WEBMCP_ACTIVITY_LIMITS.meshes + 1,
  ];
  const rows = db.prepare(select).all(...parameters) as unknown as MeshRow[];
  return rows;
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
  const truncated = newTruncation();
  if (projection.publicMeshesTruncated) truncated.meshes = true;
  const activity: RepositoryActivityProjection = projection.activity ?? {
    meshes: [],
    topics: [],
    agents: [],
    links: [],
  };
  if (activity.truncated) {
    truncated.conversations = true;
    truncated.participants = true;
    truncated.trafficLinks = true;
  }
  const joinedMeshIds = new Set(
    projection.memberships
      .filter(
        (membership) =>
          membership.agentId === input.agentId &&
          membership.status === "joined",
      )
      .map((membership) => membership.meshId),
  );
  const visibleMeshCandidates = projection.meshes
    .filter((mesh) => {
      const joined = joinedMeshIds.has(mesh.meshId);
      const visible =
        input.browse === "joined"
          ? joined
          : mesh.visibility === "public" || joined;
      return (
        visible &&
        (!input.meshId || mesh.meshId === input.meshId) &&
        (!input.authorizedMeshIds || input.authorizedMeshIds.has(mesh.meshId))
      );
    })
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.meshId.localeCompare(right.meshId),
    );
  if (visibleMeshCandidates.length > WEBMCP_ACTIVITY_LIMITS.meshes) {
    truncated.meshes = true;
  }
  const visibleMeshes = visibleMeshCandidates.slice(
    0,
    WEBMCP_ACTIVITY_LIMITS.meshes,
  );
  const visibleMeshIds = new Set(visibleMeshes.map((mesh) => mesh.meshId));
  const activityByMesh = new Map(
    activity.meshes
      .filter((mesh) => visibleMeshIds.has(mesh.meshId))
      .map((mesh) => [mesh.meshId, mesh]),
  );
  const topicsByMesh = new Map<string, RepositoryProjection["topics"]>();
  for (const topic of projection.topics) {
    if (!visibleMeshIds.has(topic.meshId)) continue;
    const topics = topicsByMesh.get(topic.meshId) ?? [];
    if (
      retainSmallest(
        topics,
        topic,
        WEBMCP_ACTIVITY_LIMITS.conversationsPerMesh,
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.topicId.localeCompare(right.topicId),
      )
    ) {
      truncated.conversations = true;
    }
    topicsByMesh.set(topic.meshId, topics);
  }
  const visibleTopicIds = new Set(
    [...topicsByMesh.values()].flatMap((topics) =>
      topics.map((topic) => topic.topicId),
    ),
  );
  const activityTopics = new Map(
    activity.topics
      .filter((topic) => visibleTopicIds.has(topic.topicId))
      .map((topic) => [topic.topicId, topic]),
  );
  const activityAgentsByMesh = new Map<string, string[]>();
  for (const agent of activity.agents) {
    if (!visibleMeshIds.has(agent.meshId)) continue;
    const values = activityAgentsByMesh.get(agent.meshId) ?? [];
    if (
      retainSmallest(
        values,
        agent.agentId,
        WEBMCP_ACTIVITY_LIMITS.participantsPerMesh,
        (left, right) => left.localeCompare(right),
      )
    ) {
      truncated.participants = true;
    }
    activityAgentsByMesh.set(agent.meshId, values);
  }
  const activityLinksByMesh = new Map<
    string,
    RepositoryActivityProjection["links"]
  >();
  for (const link of activity.links) {
    if (!visibleMeshIds.has(link.meshId)) continue;
    const values = activityLinksByMesh.get(link.meshId) ?? [];
    if (
      retainSmallest(
        values,
        link,
        WEBMCP_ACTIVITY_LIMITS.trafficLinksPerMesh,
        (left, right) =>
          left.sourceAgentId.localeCompare(right.sourceAgentId) ||
          left.targetAgentId.localeCompare(right.targetAgentId),
      )
    ) {
      truncated.trafficLinks = true;
    }
    activityLinksByMesh.set(link.meshId, values);
  }
  const memberAgentsByMesh = new Map<string, string[]>();
  for (const membership of projection.memberships) {
    if (
      !visibleMeshIds.has(membership.meshId) ||
      membership.status !== "joined"
    )
      continue;
    const values = memberAgentsByMesh.get(membership.meshId) ?? [];
    if (
      retainSmallest(
        values,
        membership.agentId,
        WEBMCP_ACTIVITY_LIMITS.participantsPerMesh,
        (left, right) => left.localeCompare(right),
      )
    ) {
      truncated.participants = true;
    }
    memberAgentsByMesh.set(membership.meshId, values);
  }
  const nowMs = Date.parse(input.generatedAt);
  const revision = Number.isFinite(nowMs) ? Math.floor(nowMs / 1_000) : 0;
  const meshes = visibleMeshes.map((mesh) => {
    const summary = activityByMesh.get(mesh.meshId);
    const topics = topicsByMesh.get(mesh.meshId) ?? [];
    const conversations = topics.map((topic) => {
      const topicActivity = activityTopics.get(topic.topicId);
      const rootCount = topicActivity?.rootCount ?? 0;
      const replyCount = topicActivity?.replyCount ?? 0;
      const tags = boundedTags(topic.tags, truncated);
      return {
        id: boundedText(topic.topicId, MAX_IDENTIFIER_CHARACTERS, truncated),
        name: boundedText(topic.name, MAX_TOPIC_NAME_CHARACTERS, truncated),
        title: boundedText(topic.title, MAX_TOPIC_TITLE_CHARACTERS, truncated),
        description: boundedText(
          topic.description,
          MAX_DESCRIPTION_CHARACTERS,
          truncated,
        ),
        tags,
        messageCount: topicActivity?.postCount ?? 0,
        rootCount,
        replyCount,
        recentMessageCount: topicActivity?.recentPostCount ?? 0,
        participantAgentIds: boundedIdentifiers(
          topicActivity?.participantAgentIds ?? [],
          WEBMCP_ACTIVITY_LIMITS.participantsPerConversation,
          truncated,
          "participants",
        ),
        velocityBand: velocity(topicActivity?.recentPostCount ?? 0),
        // Aggregate topology intentionally omits post bodies and per-root
        // reply state. This bounded lower-bound keeps the field honest until
        // a conversation is opened through the authoritative post query.
        unrepliedRootCount: Math.max(0, rootCount - replyCount),
      };
    });
    const participantAgentIds = boundedIdentifiers(
      [
        ...(memberAgentsByMesh.get(mesh.meshId) ?? []),
        ...(activityAgentsByMesh.get(mesh.meshId) ?? []),
        ...conversations.flatMap(
          (conversation) => conversation.participantAgentIds,
        ),
      ],
      WEBMCP_ACTIVITY_LIMITS.participantsPerMesh,
      truncated,
      "participants",
    );
    const linkCandidates = (activityLinksByMesh.get(mesh.meshId) ?? [])
      .filter((link) => link.sourceAgentId && link.targetAgentId)
      .sort(
        (left, right) =>
          left.sourceAgentId.localeCompare(right.sourceAgentId) ||
          left.targetAgentId.localeCompare(right.targetAgentId),
      );
    if (linkCandidates.length > WEBMCP_ACTIVITY_LIMITS.trafficLinksPerMesh) {
      truncated.trafficLinks = true;
    }
    const trafficLinks = linkCandidates
      .slice(0, WEBMCP_ACTIVITY_LIMITS.trafficLinksPerMesh)
      .map((link) => {
        const meshId = boundedText(
          mesh.meshId,
          MAX_IDENTIFIER_CHARACTERS,
          truncated,
        );
        const sourceAgentId = boundedText(
          link.sourceAgentId,
          MAX_IDENTIFIER_CHARACTERS,
          truncated,
        );
        const targetAgentId = boundedText(
          link.targetAgentId,
          MAX_IDENTIFIER_CHARACTERS,
          truncated,
        );
        return {
          id: boundedText(
            `traffic:${meshId}:${sourceAgentId}:${targetAgentId}`,
            MAX_IDENTIFIER_CHARACTERS * 3 + 10,
            truncated,
          ),
          meshId,
          sourceAgentId,
          targetAgentId,
          conversationIds: boundedIdentifiers(
            link.topicIds,
            WEBMCP_ACTIVITY_LIMITS.conversationsPerTrafficLink,
            truncated,
            "trafficLinks",
          ),
          eventCount: link.eventCount,
          recentEventCount: link.recentEventCount,
          windowMinutes: WINDOW_MINUTES,
          messagesPerMinute: Number(
            (link.recentEventCount / WINDOW_MINUTES).toFixed(1),
          ),
          medianDelayMs: medianFromBuckets(link.delayBuckets, link.delayCount),
          processor: "reply-path" as const,
          lastEventAt: boundedText(link.lastEventAt, 64, truncated),
        };
      });
    const recentMessageCount =
      summary?.recentPostCount ??
      conversations.reduce(
        (total, conversation) => total + conversation.recentMessageCount,
        0,
      );
    const messageCount =
      summary?.postCount ??
      conversations.reduce(
        (total, conversation) => total + conversation.messageCount,
        0,
      );
    return {
      id: boundedText(mesh.meshId, MAX_IDENTIFIER_CHARACTERS, truncated),
      name: boundedText(mesh.name, MAX_MESH_NAME_CHARACTERS, truncated),
      description: boundedText(
        mesh.description,
        MAX_DESCRIPTION_CHARACTERS,
        truncated,
      ),
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
  return finalizeActivity({
    generatedAt: boundedText(input.generatedAt, 64, truncated),
    revision,
    velocityWindowMinutes: WINDOW_MINUTES,
    limits: WEBMCP_ACTIVITY_LIMITS,
    truncated,
    meshes,
  });
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
  const revisionRow = db
    .prepare("SELECT COALESCE(MAX(sequence), 0) AS revision FROM events")
    .get() as {
    revision: number;
  };
  const truncated = newTruncation();
  const meshCandidates = accessibleMeshes(
    db,
    input.agentId,
    input.browse,
    input.meshId,
    input.authorizedMeshIds,
  );
  if (meshCandidates.length > WEBMCP_ACTIVITY_LIMITS.meshes)
    truncated.meshes = true;
  const meshes = meshCandidates
    .slice(0, WEBMCP_ACTIVITY_LIMITS.meshes)
    .map((mesh) => {
      const topicRows = db
        .prepare(
          `WITH selected_topics AS (
             SELECT id, mesh_id, name, title, description, tags_json, created_at
             FROM topics
             WHERE mesh_id = ?
             ORDER BY created_at ASC, id ASC
             LIMIT ?
           )
           SELECT t.id, t.mesh_id, t.name, t.title, t.description, t.tags_json,
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
           FROM selected_topics t
           LEFT JOIN posts p ON p.topic_id = t.id
             AND p.moderation_state = 'published'
             AND (p.expires_at IS NULL OR p.expires_at > ?)
           GROUP BY t.id
           ORDER BY t.created_at ASC, t.id ASC`,
        )
        .all(
          mesh.id,
          WEBMCP_ACTIVITY_LIMITS.conversationsPerMesh + 1,
          cutoff,
          input.generatedAt,
          input.generatedAt,
          input.generatedAt,
        ) as unknown as TopicRow[];
      if (topicRows.length > WEBMCP_ACTIVITY_LIMITS.conversationsPerMesh) {
        truncated.conversations = true;
        topicRows.length = WEBMCP_ACTIVITY_LIMITS.conversationsPerMesh;
      }
      const topicIds = topicRows.map((topic) => topic.id);
      const participantRows =
        topicIds.length === 0
          ? []
          : (db
              .prepare(
                `WITH topic_participants AS (
               SELECT DISTINCT topic_id, agent_id
               FROM posts
               WHERE topic_id IN (${topicIds.map(() => "?").join(", ")})
                 AND moderation_state = 'published'
                 AND (expires_at IS NULL OR expires_at > ?)
             ), ranked AS (
               SELECT topic_id, agent_id,
                      ROW_NUMBER() OVER (PARTITION BY topic_id ORDER BY agent_id) AS position
               FROM topic_participants
             )
             SELECT topic_id, agent_id
             FROM ranked
             WHERE position <= ?
             ORDER BY topic_id, agent_id`,
              )
              .all(
                ...topicIds,
                input.generatedAt,
                WEBMCP_ACTIVITY_LIMITS.participantsPerConversation + 1,
              ) as unknown as Array<{ topic_id: string; agent_id: string }>);
      const participantsByTopic = new Map<string, string[]>();
      for (const row of participantRows) {
        const values = participantsByTopic.get(row.topic_id) ?? [];
        values.push(row.agent_id);
        participantsByTopic.set(row.topic_id, values);
      }
      const replyCandidates =
        topicIds.length === 0
          ? []
          : (db
              .prepare(
                `SELECT reply.topic_id, reply.agent_id AS source_agent_id,
                  parent.agent_id AS target_agent_id, reply.created_at,
                  parent.created_at AS parent_created_at
           FROM posts reply
           JOIN posts parent ON parent.id = reply.parent_post_id
           WHERE reply.topic_id IN (${topicIds.map(() => "?").join(", ")})
             AND reply.agent_id <> parent.agent_id
             AND reply.moderation_state = 'published'
             AND (reply.expires_at IS NULL OR reply.expires_at > ?)
             AND parent.moderation_state = 'published'
             AND (parent.expires_at IS NULL OR parent.expires_at > ?)
           ORDER BY reply.created_at DESC, reply.id DESC
           LIMIT ?`,
              )
              .all(
                ...topicIds,
                input.generatedAt,
                input.generatedAt,
                MAX_REPLY_ROWS_PER_MESH + 1,
              ) as unknown as ReplyRow[]);
      if (replyCandidates.length > MAX_REPLY_ROWS_PER_MESH)
        truncated.trafficLinks = true;
      const replyRows = replyCandidates.slice(0, MAX_REPLY_ROWS_PER_MESH);
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
        if (row.created_at > group.lastEventAt)
          group.lastEventAt = row.created_at;
        groupedLinks.set(key, group);
      }
      const linkCandidates = [...groupedLinks.values()].sort(
        (left, right) =>
          left.sourceAgentId.localeCompare(right.sourceAgentId) ||
          left.targetAgentId.localeCompare(right.targetAgentId),
      );
      if (linkCandidates.length > WEBMCP_ACTIVITY_LIMITS.trafficLinksPerMesh) {
        truncated.trafficLinks = true;
      }
      const trafficLinks = linkCandidates
        .slice(0, WEBMCP_ACTIVITY_LIMITS.trafficLinksPerMesh)
        .map((group) => {
          const recentEventCount = group.timestamps.filter(
            (timestamp) =>
              timestamp >= Date.parse(cutoff) && timestamp <= nowMs,
          ).length;
          const meshId = boundedText(
            mesh.id,
            MAX_IDENTIFIER_CHARACTERS,
            truncated,
          );
          const sourceAgentId = boundedText(
            group.sourceAgentId,
            MAX_IDENTIFIER_CHARACTERS,
            truncated,
          );
          const targetAgentId = boundedText(
            group.targetAgentId,
            MAX_IDENTIFIER_CHARACTERS,
            truncated,
          );
          return {
            id: boundedText(
              `traffic:${meshId}:${sourceAgentId}:${targetAgentId}`,
              MAX_IDENTIFIER_CHARACTERS * 3 + 10,
              truncated,
            ),
            meshId,
            sourceAgentId,
            targetAgentId,
            conversationIds: boundedIdentifiers(
              [...group.conversationIds],
              WEBMCP_ACTIVITY_LIMITS.conversationsPerTrafficLink,
              truncated,
              "trafficLinks",
            ),
            eventCount: group.timestamps.length,
            recentEventCount,
            windowMinutes: WINDOW_MINUTES,
            messagesPerMinute: Number(
              (recentEventCount / WINDOW_MINUTES).toFixed(1),
            ),
            medianDelayMs: median(group.delays),
            processor: "reply-path" as const,
            lastEventAt: boundedText(group.lastEventAt, 64, truncated),
          };
        });
      const conversations = topicRows.map((topic) => ({
        id: boundedText(topic.id, MAX_IDENTIFIER_CHARACTERS, truncated),
        name: boundedText(topic.name, MAX_TOPIC_NAME_CHARACTERS, truncated),
        title: boundedText(topic.title, MAX_TOPIC_TITLE_CHARACTERS, truncated),
        description: boundedText(
          topic.description,
          MAX_DESCRIPTION_CHARACTERS,
          truncated,
        ),
        tags: parseTags(topic.tags_json, truncated),
        messageCount: count(topic.message_count),
        rootCount: count(topic.root_count),
        replyCount: count(topic.reply_count),
        recentMessageCount: count(topic.recent_message_count),
        participantAgentIds: boundedIdentifiers(
          participantsByTopic.get(topic.id) ?? [],
          WEBMCP_ACTIVITY_LIMITS.participantsPerConversation,
          truncated,
          "participants",
        ),
        velocityBand: velocity(count(topic.recent_message_count)),
        unrepliedRootCount: count(topic.unreplied_root_count),
      }));
      const memberRows = db
        .prepare(
          "SELECT agent_id FROM mesh_members WHERE mesh_id = ? ORDER BY agent_id LIMIT ?",
        )
        .all(
          mesh.id,
          WEBMCP_ACTIVITY_LIMITS.participantsPerMesh + 1,
        ) as unknown as Array<{ agent_id: string }>;
      const recentMessageCount = conversations.reduce(
        (sum, conversation) => sum + conversation.recentMessageCount,
        0,
      );
      return {
        id: boundedText(mesh.id, MAX_IDENTIFIER_CHARACTERS, truncated),
        name: boundedText(mesh.name, MAX_MESH_NAME_CHARACTERS, truncated),
        description: boundedText(
          mesh.description,
          MAX_DESCRIPTION_CHARACTERS,
          truncated,
        ),
        visibility: mesh.visibility,
        joinPolicy: mesh.join_policy,
        messageCount: conversations.reduce(
          (sum, conversation) => sum + conversation.messageCount,
          0,
        ),
        recentMessageCount,
        participantAgentIds: boundedIdentifiers(
          memberRows.map((row) => row.agent_id),
          WEBMCP_ACTIVITY_LIMITS.participantsPerMesh,
          truncated,
          "participants",
        ),
        velocityBand: velocity(recentMessageCount),
        conversations,
        trafficLinks,
      };
    });
  return finalizeActivity({
    generatedAt: boundedText(input.generatedAt, 64, truncated),
    revision: Number(revisionRow.revision),
    velocityWindowMinutes: WINDOW_MINUTES,
    limits: WEBMCP_ACTIVITY_LIMITS,
    truncated,
    meshes,
  });
}
