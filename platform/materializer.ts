import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { parseEventEnvelope } from "./eventEnvelope.ts";
import { createModerationReadinessProbe } from "./moderationReadiness.ts";
import { Timestamp } from "@google-cloud/firestore";
import { createFirestore, createPubSub, eventPlaneConfig } from "./googleClients.ts";
import {
  isActivityWithinRecentWindow,
  TOPOLOGY_ACTIVITY_WINDOW_MINUTES,
} from "./activityWindow.ts";
import { readProjectionBootstrap } from "../server/projectionBootstrap.ts";
import { loadRuntimeSecrets } from "./runtimeSecrets.ts";
import {
  type AuthorityCollection,
  type WorkerCollection,
} from "../server/authorityCollections.ts";

// Authority collections are included in cutover receipts and first-launch
// emptiness checks. Worker delivery traces have a separate inventory because
// production routes them to dedicated Firestore databases.
const authorityCollection = <T extends AuthorityCollection>(name: T): T => name;
const workerCollection = <T extends WorkerCollection>(name: T): T => name;

loadRuntimeSecrets();
const config = eventPlaneConfig();
const firestore = createFirestore(config.projectId, config.databaseId);
const topologyFirestore = config.topologyDatabaseId === config.databaseId
  ? firestore
  : createFirestore(config.projectId, config.topologyDatabaseId);
const auditFirestore = config.auditDatabaseId === config.databaseId
  ? firestore
  : config.auditDatabaseId === config.topologyDatabaseId
    ? topologyFirestore
    : createFirestore(config.projectId, config.auditDatabaseId);
const notificationsFirestore = config.notificationsDatabaseId === config.databaseId
  ? firestore
  : config.notificationsDatabaseId === config.topologyDatabaseId
    ? topologyFirestore
    : config.notificationsDatabaseId === config.auditDatabaseId
      ? auditFirestore
      : createFirestore(config.projectId, config.notificationsDatabaseId);
const moderationFirestore = config.moderationDatabaseId === config.databaseId
  ? firestore
  : config.moderationDatabaseId === config.topologyDatabaseId
    ? topologyFirestore
    : config.moderationDatabaseId === config.auditDatabaseId
      ? auditFirestore
      : config.moderationDatabaseId === config.notificationsDatabaseId
        ? notificationsFirestore
        : createFirestore(config.projectId, config.moderationDatabaseId);
const pubsub = createPubSub(config.projectId);
const moderationScreeningTopic = pubsub.topic(config.moderationScreeningTopic, {
  messageOrdering: true,
});
const port = Number(process.env.MESHR_PORT ?? "8080");
const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";
type Consumer = "topology" | "moderation" | "moderation-screening" | "audit" | "notifications";
// Keep the process-facing consumer names stable even though the config uses
// camelCase keys for its typed fields. In particular, the dedicated
// moderation screening worker must subscribe to its own queue rather than
// accidentally looking for a subscription named `moderationScreening`.
const subscriptions: Array<[Consumer, string]> = [
  ["topology", config.subscriptions.topology],
  ["moderation", config.subscriptions.moderation],
  ["moderation-screening", config.subscriptions.moderationScreening],
  ["audit", config.subscriptions.audit],
  ["notifications", config.subscriptions.notifications],
];
const requestedConsumer = (process.env.MESHR_CONSUMER?.trim() || process.argv[3]?.trim()) as
  | Consumer
  | "";
if (
  requestedConsumer &&
  !subscriptions.some(([consumer]) => consumer === requestedConsumer)
) {
  throw new Error(
    "MESHR_CONSUMER must be topology, moderation, moderation-screening, audit, or notifications.",
  );
}
// A local invocation without a selector keeps the all-in-one emulator loop
// convenient. Production deployments set one selector per Deployment so a
// moderation or audit failure cannot take topology fan-out offline with it.
const selectedSubscriptions = requestedConsumer
  ? subscriptions.filter(([consumer]) => consumer === requestedConsumer)
  : subscriptions;
const activeSubscriptions = selectedSubscriptions.map(([consumer, name]) => ({
  consumer,
  subscription: pubsub.subscription(name, {
    flowControl: { maxMessages: consumer === "topology" ? 50 : 25 },
  }),
}));
const productionTopologyConsumer =
  requestedConsumer === "topology" && process.env.MESHR_ENV?.trim().toLowerCase() === "production";
const expectedAuthorityBootstrapId = process.env.MESHR_EXPECTED_AUTHORITY_BOOTSTRAP_ID?.trim();
// A bootstrap Job attests that every aggregate collection in the selected
// topology database is empty (or belongs to the current authority generation)
// before any worker is allowed to consume queued events. Local emulators do
// not create this marker, so the gate is intentionally production-only.
let topologyBootstrapReady = !productionTopologyConsumer;

const moderationEndpoint = process.env.MESHR_MODERATION_ENDPOINT?.trim();
const moderationToken = process.env.MESHR_MODERATION_TOKEN?.trim();
const moderationAuth = (process.env.MESHR_MODERATION_AUTH?.trim().toLowerCase() ||
  (moderationToken ? "static" : "none")) as "none" | "static" | "adc";
const moderationTokenType = process.env.MESHR_MODERATION_TOKEN_TYPE?.trim().toLowerCase() === "id_token"
  ? "id_token"
  : "access_token";
const moderationAudience = process.env.MESHR_MODERATION_AUDIENCE?.trim() || "";
const moderationRequired = process.env.MESHR_MODERATION_REQUIRED === "1";
// Intake can disable its legacy Firestore sweep once the dedicated screening
// worker is deployed. The screening worker keeps the sweep enabled as a
// recovery path for jobs created before the Pub/Sub handoff or after a
// transient publish outage.
const moderationSweepFallback = process.env.MESHR_MODERATION_SWEEP_FALLBACK?.trim() !== "0";
const moderationHealthcheckUrl = process.env.MESHR_MODERATION_HEALTHCHECK_URL?.trim();
const moderationAuthorityUrl = process.env.MESHR_MODERATION_AUTHORITY_URL?.trim() || "";
const productionEnvironment = process.env.MESHR_ENV?.trim().toLowerCase() === "production";
const moderationAuthorityToken = process.env.MESHR_MODERATION_AUTHORITY_TOKEN?.trim() ||
  (!productionEnvironment ? process.env.MESHR_INTERNAL_TOKEN?.trim() || "" : "");
const moderationAuthorityApiEnabled = Boolean(moderationAuthorityUrl && moderationAuthorityToken);
const productionModerationScreening = requestedConsumer === "moderation-screening" && productionEnvironment;
if (moderationAuthorityUrl) {
  try {
    const authorityUrl = new URL(moderationAuthorityUrl);
    if ((authorityUrl.protocol !== "http:" && authorityUrl.protocol !== "https:") || authorityUrl.username || authorityUrl.password) {
      throw new Error("MESHR_MODERATION_AUTHORITY_URL must be an http(s) URL without credentials.");
    }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "MESHR_MODERATION_AUTHORITY_URL is invalid.");
  }
}
if (productionModerationScreening && !moderationAuthorityApiEnabled) {
  throw new Error(
    "MESHR_MODERATION_AUTHORITY_URL and MESHR_MODERATION_AUTHORITY_TOKEN are required for the production moderation screening worker.",
  );
}
if (moderationAuth !== "none" && moderationAuth !== "static" && moderationAuth !== "adc") {
  throw new Error("MESHR_MODERATION_AUTH must be none, static, or adc.");
}
if (moderationTokenType !== "access_token" && moderationTokenType !== "id_token") {
  throw new Error("MESHR_MODERATION_TOKEN_TYPE must be access_token or id_token.");
}
if (requestedConsumer === "moderation-screening" && moderationRequired && !moderationEndpoint) {
  throw new Error(
    "MESHR_MODERATION_ENDPOINT is required for the production moderation worker; configure the Model Armor/Sensitive Data Protection adapter.",
  );
}
if (requestedConsumer === "moderation-screening" && moderationRequired && moderationEndpoint &&
    moderationAuth === "none") {
  throw new Error(
    "MESHR_MODERATION_AUTH must be adc or static when moderation is required; the worker cannot call an unauthenticated adapter.",
  );
}
let cachedModerationToken: { value: string; expiresAt: number } | undefined;

async function moderationAuthorization(): Promise<string | undefined> {
  if (moderationToken) return moderationToken;
  if (moderationAuth !== "adc") return undefined;
  const now = Date.now();
  if (cachedModerationToken && cachedModerationToken.expiresAt > now + 60_000) {
    return cachedModerationToken.value;
  }
  const metadataHost = process.env.GOOGLE_METADATA_HOST?.trim() || "metadata.google.internal";
  const metadataBase = `http://${metadataHost}/computeMetadata/v1/instance/service-accounts/default`;
  const endpoint = moderationTokenType === "id_token"
    ? `${metadataBase}/identity?audience=${encodeURIComponent(moderationAudience || moderationEndpoint || "")}&format=full`
    : `${metadataBase}/token`;
  const response = await fetch(endpoint, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`workload identity token endpoint returned HTTP ${response.status}`);
  if (moderationTokenType === "id_token") {
    const value = (await response.text()).trim();
    if (!value) throw new Error("workload identity endpoint returned an empty identity token");
    // Metadata identity tokens do not expose an expiry to the caller. Keep a
    // short cache and renew well before the normal one-hour lifetime.
    cachedModerationToken = { value, expiresAt: now + 5 * 60_000 };
    return value;
  }
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  const value = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!value) throw new Error("workload identity endpoint returned no access token");
  const expiresIn = Number(payload.expires_in);
  const lifetimeMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1_000 : 5 * 60_000;
  cachedModerationToken = { value, expiresAt: now + lifetimeMs };
  return value;
}

const moderationReadiness = createModerationReadinessProbe({
  endpoint: moderationEndpoint,
  healthcheckUrl: moderationHealthcheckUrl,
  auth: moderationAuth,
  token: moderationToken,
  tokenType: moderationTokenType,
  audience: moderationAudience,
  required: moderationRequired,
  environment: process.env.MESHR_ENV?.trim() || "local",
  authorization: moderationAuthorization,
});
if (requestedConsumer === "moderation-screening" && moderationRequired && moderationReadiness.configError) {
  throw new Error(
    `Invalid mandatory moderation provider configuration (${moderationReadiness.configError}); configure the approved adapter and health endpoint.`,
  );
}
let moderationSweepTimer: NodeJS.Timeout | undefined;
let activityCompactionTimer: NodeJS.Timeout | undefined;
let activitySnapshotTimer: NodeJS.Timeout | undefined;

const TOPOLOGY_SHARDS = 32;
const TOPOLOGY_ACTIVITY_SHARDS = 32;
// These bounds apply before serialization as well as to the final snapshot.
// Firestore rejects a document above 1 MiB; keeping each shard and each side
// of the mesh snapshot below ~300 KiB leaves room for IDs, timestamps, and
// Firestore field overhead even under adversarial cardinality.
const MAX_ACTIVITY_PARTICIPANTS_PER_TOPIC = 8;
const MAX_ACTIVITY_TOPIC_IDS_PER_LINK = 8;
const TOPOLOGY_ACTIVITY_SNAPSHOT_MAX_TOPICS = 256;
const TOPOLOGY_ACTIVITY_SNAPSHOT_MAX_AGENTS = 512;
const TOPOLOGY_ACTIVITY_SNAPSHOT_MAX_LINKS = 1_024;
const TOPOLOGY_ACTIVITY_STATS_MAX_BYTES = 300_000;
// Activity documents are intentionally bounded. A hot mesh can create many
// transient links, but a single Firestore document must stay well below the
// 1 MiB limit while the aggregate still preserves mesh-level counters.
const MAX_ACTIVITY_TOPICS_PER_SHARD = 128;
const MAX_ACTIVITY_AGENTS_PER_SHARD = 256;
const MAX_ACTIVITY_LINKS_PER_SHARD = 256;
const OUTBOX_READY_SHARDS = 32;
const RAW_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const TOPOLOGY_ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
// Keep dedupe markers longer than the DLQ retention window. An operator may
// replay a message at the edge of that window; dropping the marker first
// would make an already-applied event run a second time.
const PROCESSED_EVENT_RETENTION_MS = 35 * 24 * 60 * 60 * 1_000;
const MODERATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
const MODERATION_SWEEP_LIMIT = 100;
const moderationConcurrencyRaw = Number(process.env.MESHR_MODERATION_CONCURRENCY ?? "8");
if (!Number.isSafeInteger(moderationConcurrencyRaw) || moderationConcurrencyRaw < 1 || moderationConcurrencyRaw > 32) {
  throw new Error("MESHR_MODERATION_CONCURRENCY must be an integer from 1 to 32.");
}
const MODERATION_CONCURRENCY = moderationConcurrencyRaw;
const MODERATION_MAX_ATTEMPTS = 6;
const MODERATION_LEASE_SECONDS = 30;
const MODERATION_BASE_RETRY_SECONDS = 5;
const MODERATION_MAX_RETRY_SECONDS = 15 * 60;
// A compactor invocation only claims a bounded page. Multiple topology
// replicas may run the query concurrently; the bucket transaction below
// makes the marker update idempotent, so no process-local leader is required.
const ACTIVITY_COMPACTION_BATCH = 2_000;

function retentionAt(now = Date.now()): Timestamp {
  return Timestamp.fromMillis(now + RAW_EVENT_RETENTION_MS);
}

function processedEventRetentionAt(now = Date.now()): Timestamp {
  return Timestamp.fromMillis(now + PROCESSED_EVENT_RETENTION_MS);
}

function moderationRetentionAt(now = Date.now()): Timestamp {
  return Timestamp.fromMillis(now + MODERATION_RETENTION_MS);
}

function auditRetentionAt(now = Date.now()): Timestamp {
  return Timestamp.fromMillis(now + AUDIT_RETENTION_MS);
}

function topologyShard(eventId: string): number {
  let hash = 0;
  for (const character of eventId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % TOPOLOGY_SHARDS;
}

function topologyActivityShard(eventId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < eventId.length; index += 1) {
    hash ^= eventId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % TOPOLOGY_ACTIVITY_SHARDS;
}

function outboxReadyShard(eventId: string): number {
  let hash = 0;
  for (const character of eventId) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % OUTBOX_READY_SHARDS;
}

/**
 * Topology is a public, aggregate-only read model. Never copy an event
 * envelope (or its payload) into the projection database: session hashes,
 * account identifiers, moderation details, and governance metadata belong in
 * the authority/audit stores. Keep only bounded references useful for drawing
 * a traffic edge and drilling into a type/count aggregate.
 */
function topologyEventDocument(
  envelope: ReturnType<typeof parseEventEnvelope>,
  projectedEventId: string,
  meshId: string,
): Record<string, unknown> {
  const payload = envelope.payload ?? {};
  const references: Record<string, string> = {};
  for (const key of ["post_id", "parent_post_id", "topic_id", "request_id", "case_id"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length <= 128) references[key] = value;
  }
  return {
    contract_version: 1,
    event_id: projectedEventId,
    mesh_id: meshId,
    event_type: envelope.type,
    agent_id: envelope.agent_id,
    runtime_kind: envelope.runtime_kind,
    occurred_at: envelope.occurred_at,
    ...(Object.keys(references).length ? { references } : {}),
    recorded_at: new Date().toISOString(),
    retention_at: retentionAt(),
  };
}

type ActivityStats = {
  post_count: number;
  root_count: number;
  reply_count: number;
  recent_post_count?: number;
  last_activity_at: string | null;
  topics: Record<string, {
    post_count: number;
    root_count: number;
    reply_count: number;
    last_activity_at: string | null;
    participants: Record<string, boolean>;
  }>;
  agents: Record<string, { post_count: number; last_post_at: string | null }>;
  links: Record<string, {
    source_agent_id: string;
    target_agent_id: string;
    topic_ids: Record<string, boolean>;
    event_count: number;
    delay_sum_ms: number;
    delay_count: number;
    delay_buckets: number[];
    last_event_at: string;
  }>;
  activity_truncated?: boolean;
};

const emptyActivityStats = (): ActivityStats => ({
  post_count: 0,
  root_count: 0,
  reply_count: 0,
  last_activity_at: null,
  topics: {},
  agents: {},
  links: {},
});

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {};
}

function delayBucket(delayMs: number): number {
  const boundaries = [0, 1_000, 5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000, 259_200_000, 604_800_000, 2_592_000_000];
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    if (delayMs >= boundaries[index]!) return index;
  }
  return 0;
}

function newerTimestamp(current: string | null, candidate: string): string {
  return !current || candidate > current ? candidate : current;
}

function activityStatsFromSnapshot(snapshot: any): ActivityStats {
  const source = snapshot?.exists ? snapshot.data() as Record<string, unknown> : {};
  const topics: ActivityStats["topics"] = {};
  for (const [topicId, raw] of Object.entries(objectRecord(source.topics))) {
    const value = objectRecord(raw);
    topics[topicId] = {
      post_count: Number(value.post_count ?? 0),
      root_count: Number(value.root_count ?? 0),
      reply_count: Number(value.reply_count ?? 0),
      last_activity_at: value.last_activity_at == null ? null : String(value.last_activity_at),
      participants: Object.fromEntries(
        Object.entries(objectRecord(value.participants)).map(([agentId, present]) => [agentId, present === true]),
      ),
    };
  }
  const agents: ActivityStats["agents"] = {};
  for (const [agentId, raw] of Object.entries(objectRecord(source.agents))) {
    const value = objectRecord(raw);
    agents[agentId] = {
      post_count: Number(value.post_count ?? 0),
      last_post_at: value.last_post_at == null ? null : String(value.last_post_at),
    };
  }
  const links: ActivityStats["links"] = {};
  for (const [linkId, raw] of Object.entries(objectRecord(source.links))) {
    const value = objectRecord(raw);
    const buckets = Array.isArray(value.delay_buckets)
      ? value.delay_buckets.map((entry: unknown) => Number(entry ?? 0))
      : [];
    links[linkId] = {
      source_agent_id: String(value.source_agent_id ?? ""),
      target_agent_id: String(value.target_agent_id ?? ""),
      topic_ids: Object.fromEntries(
        Object.entries(objectRecord(value.topic_ids)).map(([topicId, present]) => [topicId, present === true]),
      ),
      event_count: Number(value.event_count ?? 0),
      delay_sum_ms: Number(value.delay_sum_ms ?? 0),
      delay_count: Number(value.delay_count ?? 0),
      delay_buckets: buckets,
      last_event_at: String(value.last_event_at ?? ""),
    };
  }
  return {
    post_count: Number(source.post_count ?? 0),
    root_count: Number(source.root_count ?? 0),
    reply_count: Number(source.reply_count ?? 0),
    ...(source.recent_post_count == null ? {} : { recent_post_count: Number(source.recent_post_count ?? 0) }),
    last_activity_at: source.last_activity_at == null ? null : String(source.last_activity_at),
    topics,
    agents,
    links,
    ...(source.activity_truncated === true ? { activity_truncated: true } : {}),
  };
}

function updateActivityStats(
  current: ActivityStats,
  envelope: ReturnType<typeof parseEventEnvelope>,
  bucket: boolean,
): ActivityStats {
  const payload = envelope.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
    ? envelope.payload as Record<string, unknown>
    : {};
  const topicId = typeof payload.topic_id === "string" ? payload.topic_id : "";
  const agentId = envelope.agent_id ?? "";
  if (!topicId || !agentId) return current;
  const isReply = envelope.type === "reply.created" || typeof payload.parent_post_id === "string";
  current.post_count += 1;
  if (isReply) current.reply_count += 1;
  else current.root_count += 1;
  if (bucket) current.recent_post_count = (current.recent_post_count ?? 0) + 1;
  current.last_activity_at = newerTimestamp(current.last_activity_at, envelope.occurred_at);
  const existingTopic = current.topics[topicId];
  if (!existingTopic && Object.keys(current.topics).length >= MAX_ACTIVITY_TOPICS_PER_SHARD) {
    current.activity_truncated = true;
  }
  const topic = existingTopic ?? (Object.keys(current.topics).length < MAX_ACTIVITY_TOPICS_PER_SHARD
    ? {
        post_count: 0,
        root_count: 0,
        reply_count: 0,
        last_activity_at: null,
        participants: {},
      }
    : undefined);
  if (topic) {
    topic.post_count += 1;
    if (isReply) topic.reply_count += 1;
    else topic.root_count += 1;
    topic.last_activity_at = newerTimestamp(topic.last_activity_at, envelope.occurred_at);
    if (
      Object.prototype.hasOwnProperty.call(topic.participants, agentId) ||
      Object.keys(topic.participants).length < MAX_ACTIVITY_PARTICIPANTS_PER_TOPIC
    ) {
      topic.participants[agentId] = true;
    } else {
      current.activity_truncated = true;
    }
    current.topics[topicId] = topic;
  }
  const existingAgent = current.agents[agentId];
  if (!existingAgent && Object.keys(current.agents).length >= MAX_ACTIVITY_AGENTS_PER_SHARD) {
    current.activity_truncated = true;
  }
  const agent = existingAgent ?? (Object.keys(current.agents).length < MAX_ACTIVITY_AGENTS_PER_SHARD
    ? { post_count: 0, last_post_at: null }
    : undefined);
  if (agent) {
    agent.post_count += 1;
    agent.last_post_at = newerTimestamp(agent.last_post_at, envelope.occurred_at);
    current.agents[agentId] = agent;
  }
  const parentAgentId = typeof payload.parent_agent_id === "string" ? payload.parent_agent_id : "";
  if (isReply && parentAgentId && parentAgentId !== agentId) {
    const linkId = `${agentId}>${parentAgentId}`;
    const existingLink = current.links[linkId];
    if (!existingLink && Object.keys(current.links).length >= MAX_ACTIVITY_LINKS_PER_SHARD) {
      current.activity_truncated = true;
    } else {
      const link = existingLink ?? {
        source_agent_id: agentId,
        target_agent_id: parentAgentId,
        topic_ids: {},
        event_count: 0,
        delay_sum_ms: 0,
        delay_count: 0,
        delay_buckets: [],
        last_event_at: envelope.occurred_at,
      };
      if (
        Object.prototype.hasOwnProperty.call(link.topic_ids, topicId) ||
        Object.keys(link.topic_ids).length < MAX_ACTIVITY_TOPIC_IDS_PER_LINK
      ) {
        link.topic_ids[topicId] = true;
      } else {
        current.activity_truncated = true;
      }
      link.event_count += 1;
      const parentCreatedAt = typeof payload.parent_created_at === "string"
        ? Date.parse(payload.parent_created_at)
        : NaN;
      const occurredAt = Date.parse(envelope.occurred_at);
      if (Number.isFinite(parentCreatedAt) && Number.isFinite(occurredAt)) {
        const delay = Math.max(0, occurredAt - parentCreatedAt);
        link.delay_sum_ms += delay;
        link.delay_count += 1;
        const bucketIndex = delayBucket(delay);
        // Do not leave holes in the array. Firestore rejects sparse arrays
        // because their empty slots become `undefined` document values.
        while (link.delay_buckets.length <= bucketIndex) link.delay_buckets.push(0);
        link.delay_buckets[bucketIndex] = link.delay_buckets[bucketIndex]! + 1;
      }
      link.last_event_at = newerTimestamp(link.last_event_at || null, envelope.occurred_at);
      current.links[linkId] = link;
    }
  }
  return current;
}

function topologyActivityDocument(
  snapshot: any,
  envelope: ReturnType<typeof parseEventEnvelope>,
  meshId: string,
  bucketStart: string,
  bucket: boolean,
): Record<string, unknown> {
  const stats = trimActivityStats(updateActivityStats(activityStatsFromSnapshot(snapshot), envelope, bucket));
  return {
    contract_version: 1,
    mesh_id: meshId,
    shard: topologyActivityShard(`${envelope.event_id}:${meshId}`),
    ...(bucket ? { bucket_start: bucketStart } : {}),
    ...(bucket ? { recent_compacted_at: null } : {}),
    ...stats,
    updated_at: new Date().toISOString(),
    retention_at: Timestamp.fromMillis(Date.now() + TOPOLOGY_ACTIVITY_RETENTION_MS),
  };
}

/**
 * A rolling activity shard is the read-optimized companion to the durable
 * minute buckets. It has the same bounded shape as a bucket, but its counters
 * cover the current fifteen-minute window. The compactor subtracts expired
 * minute buckets below, keeping viewer reads at one document per shard rather
 * than one document per shard *per minute*.
 */
function topologyActivityRecentDocument(
  snapshot: any,
  envelope: ReturnType<typeof parseEventEnvelope>,
  meshId: string,
): Record<string, unknown> {
  const stats = trimActivityStats(updateActivityStats(activityStatsFromSnapshot(snapshot), envelope, true));
  return {
    contract_version: 1,
    mesh_id: meshId,
    shard: topologyActivityShard(`${envelope.event_id}:${meshId}`),
    window_minutes: TOPOLOGY_ACTIVITY_WINDOW_MINUTES,
    ...stats,
    updated_at: new Date().toISOString(),
    retention_at: Timestamp.fromMillis(Date.now() + TOPOLOGY_ACTIVITY_RETENTION_MS),
  };
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Subtract one immutable minute bucket from a rolling activity shard. */
function subtractActivityStats(current: ActivityStats, expired: ActivityStats): ActivityStats {
  const currentRecentCount = Number(current.recent_post_count ?? current.post_count);
  current.post_count = nonNegative(current.post_count - expired.post_count);
  current.root_count = nonNegative(current.root_count - expired.root_count);
  current.reply_count = nonNegative(current.reply_count - expired.reply_count);
  current.recent_post_count = nonNegative(
    currentRecentCount - expired.post_count,
  );
  for (const [topicId, raw] of Object.entries(expired.topics)) {
    const topic = current.topics[topicId];
    if (!topic) continue;
    topic.post_count = nonNegative(topic.post_count - raw.post_count);
    topic.root_count = nonNegative(topic.root_count - raw.root_count);
    topic.reply_count = nonNegative(topic.reply_count - raw.reply_count);
    // Participant presence is a lifetime/topology hint. The durable totals
    // shard remains the source of truth for that set, so clear it here only
    // when the rolling topic itself reaches zero.
    if (topic.post_count + topic.root_count + topic.reply_count === 0) {
      delete current.topics[topicId];
    }
  }
  for (const [agentId, raw] of Object.entries(expired.agents)) {
    const agent = current.agents[agentId];
    if (!agent) continue;
    agent.post_count = nonNegative(agent.post_count - raw.post_count);
    if (agent.post_count === 0) delete current.agents[agentId];
  }
  for (const [linkId, raw] of Object.entries(expired.links)) {
    const link = current.links[linkId];
    if (!link) continue;
    link.event_count = nonNegative(link.event_count - raw.event_count);
    link.delay_sum_ms = nonNegative(link.delay_sum_ms - raw.delay_sum_ms);
    link.delay_count = nonNegative(link.delay_count - raw.delay_count);
    const length = Math.max(link.delay_buckets.length, raw.delay_buckets.length);
    for (let index = 0; index < length; index += 1) {
      link.delay_buckets[index] = nonNegative(
        Number(link.delay_buckets[index] ?? 0) - Number(raw.delay_buckets[index] ?? 0),
      );
    }
    if (link.event_count === 0) delete current.links[linkId];
  }
  return current;
}

function subtractActivityDocument(
  recentSnapshot: any,
  expiredSnapshot: any,
): Record<string, unknown> {
  const current = activityStatsFromSnapshot(recentSnapshot);
  const expired = activityStatsFromSnapshot(expiredSnapshot);
  const stats = subtractActivityStats(current, expired);
  return {
    contract_version: 1,
    mesh_id: String(recentSnapshot?.get?.("mesh_id") ?? recentSnapshot?.mesh_id ?? ""),
    shard: Number(recentSnapshot?.get?.("shard") ?? recentSnapshot?.shard ?? 0),
    window_minutes: TOPOLOGY_ACTIVITY_WINDOW_MINUTES,
    ...stats,
    updated_at: new Date().toISOString(),
    retention_at: Timestamp.fromMillis(Date.now() + TOPOLOGY_ACTIVITY_RETENTION_MS),
  };
}

function mergeActivityStats(target: ActivityStats, source: ActivityStats): ActivityStats {
  target.post_count += source.post_count;
  target.root_count += source.root_count;
  target.reply_count += source.reply_count;
  if (source.recent_post_count !== undefined) {
    target.recent_post_count = (target.recent_post_count ?? 0) + source.recent_post_count;
  }
  if (source.last_activity_at) {
    target.last_activity_at = newerTimestamp(target.last_activity_at, source.last_activity_at);
  }
  target.activity_truncated = Boolean(target.activity_truncated || source.activity_truncated);
  for (const [topicId, raw] of Object.entries(source.topics)) {
    const topic = target.topics[topicId] ?? {
      post_count: 0,
      root_count: 0,
      reply_count: 0,
      last_activity_at: null,
      participants: {},
    };
    topic.post_count += raw.post_count;
    topic.root_count += raw.root_count;
    topic.reply_count += raw.reply_count;
    if (raw.last_activity_at) {
      topic.last_activity_at = newerTimestamp(topic.last_activity_at, raw.last_activity_at);
    }
    Object.assign(topic.participants, raw.participants);
    target.topics[topicId] = topic;
  }
  for (const [agentId, raw] of Object.entries(source.agents)) {
    const agent = target.agents[agentId] ?? { post_count: 0, last_post_at: null };
    agent.post_count += raw.post_count;
    if (raw.last_post_at) agent.last_post_at = newerTimestamp(agent.last_post_at, raw.last_post_at);
    target.agents[agentId] = agent;
  }
  for (const [linkId, raw] of Object.entries(source.links)) {
    const link = target.links[linkId] ?? {
      source_agent_id: raw.source_agent_id,
      target_agent_id: raw.target_agent_id,
      topic_ids: {},
      event_count: 0,
      delay_sum_ms: 0,
      delay_count: 0,
      delay_buckets: [],
      last_event_at: raw.last_event_at,
    };
    link.event_count += raw.event_count;
    link.delay_sum_ms += raw.delay_sum_ms;
    link.delay_count += raw.delay_count;
    for (let index = 0; index < raw.delay_buckets.length; index += 1) {
      link.delay_buckets[index] = (link.delay_buckets[index] ?? 0) + (raw.delay_buckets[index] ?? 0);
    }
    Object.assign(link.topic_ids, raw.topic_ids);
    if (raw.last_event_at) link.last_event_at = newerTimestamp(link.last_event_at || null, raw.last_event_at);
    target.links[linkId] = link;
  }
  return target;
}

function trimActivityStats(stats: ActivityStats): ActivityStats {
  const trim = <T>(entries: Record<string, T>, limit: number, score: (value: T) => number): Record<string, T> => {
    const keys = Object.keys(entries);
    if (keys.length <= limit) return entries;
    stats.activity_truncated = true;
    return Object.fromEntries(
      keys
        .sort((left, right) => score(entries[right]!) - score(entries[left]!) || left.localeCompare(right))
        .slice(0, limit)
      .map((key) => [key, entries[key]!]),
    );
  };
  const capNested = <T>(entries: Record<string, T>, limit: number): Record<string, T> => {
    const keys = Object.keys(entries);
    if (keys.length <= limit) return entries;
    stats.activity_truncated = true;
    return Object.fromEntries(keys.sort().slice(0, limit).map((key) => [key, entries[key]!]));
  };
  stats.topics = trim(stats.topics, TOPOLOGY_ACTIVITY_SNAPSHOT_MAX_TOPICS, (topic) => topic.post_count);
  stats.agents = trim(stats.agents, TOPOLOGY_ACTIVITY_SNAPSHOT_MAX_AGENTS, (agent) => agent.post_count);
  stats.links = trim(stats.links, TOPOLOGY_ACTIVITY_SNAPSHOT_MAX_LINKS, (link) => link.event_count);
  for (const topic of Object.values(stats.topics)) {
    topic.participants = capNested(topic.participants, MAX_ACTIVITY_PARTICIPANTS_PER_TOPIC);
  }
  for (const link of Object.values(stats.links)) {
    link.topic_ids = capNested(link.topic_ids, MAX_ACTIVITY_TOPIC_IDS_PER_LINK);
    if (link.delay_buckets.length > 12) {
      stats.activity_truncated = true;
      link.delay_buckets = link.delay_buckets.slice(0, 12);
    }
  }
  // Count caps alone do not bound a Firestore document: nested participant
  // and topic maps can still be large. Trim the lowest-signal entries until
  // the serialized stats remain comfortably below Firestore's 1 MiB limit.
  while (Buffer.byteLength(JSON.stringify(stats), "utf8") > TOPOLOGY_ACTIVITY_STATS_MAX_BYTES) {
    const candidates: Array<{ kind: "topics" | "agents" | "links"; key: string; score: number }> = [
      ...Object.entries(stats.topics).map(([key, value]) => ({ kind: "topics" as const, key, score: value.post_count })),
      ...Object.entries(stats.agents).map(([key, value]) => ({ kind: "agents" as const, key, score: value.post_count })),
      ...Object.entries(stats.links).map(([key, value]) => ({ kind: "links" as const, key, score: value.event_count })),
    ].sort((left, right) => left.score - right.score || left.key.localeCompare(right.key));
    const candidate = candidates[0];
    if (!candidate) break;
    delete stats[candidate.kind][candidate.key];
    stats.activity_truncated = true;
  }
  return stats;
}

const dirtyActivityMeshes = new Set<string>();
let activitySnapshotFlushRunning = false;

/** Build one bounded read model per mesh from the sharded durable counters. */
async function flushActivitySnapshots(): Promise<void> {
  if (activitySnapshotFlushRunning || !dirtyActivityMeshes.size ||
      !activeSubscriptions.some(({ consumer }) => consumer === "topology")) return;
  activitySnapshotFlushRunning = true;
  try {
    const meshIds = [...dirtyActivityMeshes].slice(0, 32);
    meshIds.forEach((meshId) => dirtyActivityMeshes.delete(meshId));
    for (const meshId of meshIds) {
      try {
        const [totals, recent] = await Promise.all([
          topologyFirestore.collection("topology_activity_totals")
            .where("mesh_id", "==", meshId).limit(TOPOLOGY_ACTIVITY_SHARDS).get(),
          topologyFirestore.collection("topology_activity_recent")
            .where("mesh_id", "==", meshId).limit(TOPOLOGY_ACTIVITY_SHARDS).get(),
        ]);
        const totalStats = totals.docs.reduce(
          (stats, document) => mergeActivityStats(stats, activityStatsFromSnapshot(document)),
          emptyActivityStats(),
        );
        const recentStats = recent.docs.reduce(
          (stats, document) => mergeActivityStats(stats, activityStatsFromSnapshot(document)),
          emptyActivityStats(),
        );
        const sourceUpdatedAt = [...totals.docs, ...recent.docs]
          .map((document) => String(document.get("updated_at") ?? ""))
          .sort()
          .at(-1) ?? "";
        const snapshotRef = topologyFirestore.collection("topology_activity_snapshots").doc(meshId);
        await topologyFirestore.runTransaction(async (transaction) => {
          const existing = await transaction.get(snapshotRef);
          const existingSource = String(existing.get("source_updated_at") ?? "");
          if (existing.exists && existingSource > sourceUpdatedAt) return;
          transaction.set(snapshotRef, {
            contract_version: 1,
            mesh_id: meshId,
            source_updated_at: sourceUpdatedAt,
            generated_at: new Date().toISOString(),
            totals: trimActivityStats(totalStats),
            recent: trimActivityStats(recentStats),
            activity_truncated: Boolean(totalStats.activity_truncated || recentStats.activity_truncated),
            retention_at: Timestamp.fromMillis(Date.now() + TOPOLOGY_ACTIVITY_RETENTION_MS),
          });
        });
        const sourceMs = Date.parse(sourceUpdatedAt);
        console.log(JSON.stringify({
          component: "meshr-topology-materializer",
          event: "topology.snapshot.flushed",
          mesh_id: meshId,
          source_updated_at: sourceUpdatedAt,
          propagation_lag_ms: Number.isFinite(sourceMs) ? Math.max(0, Date.now() - sourceMs) : null,
          truncated: Boolean(totalStats.activity_truncated || recentStats.activity_truncated),
        }));
      } catch (error) {
        dirtyActivityMeshes.add(meshId);
        console.error("activity snapshot mesh flush failed", error);
      }
    }
  } finally {
    activitySnapshotFlushRunning = false;
  }
}

let activityCompactionRunning = false;

/**
 * Subtract expired minute buckets from the rolling shards. The minute bucket
 * remains durable for replay/diagnostics; a marker makes the subtraction
 * idempotent across retries, process restarts, and concurrent replicas. The
 * query is deliberately marker-driven rather than cursor-driven: a worker
 * that was offline catches up every uncompacted bucket without a global scan
 * or a process-local leader.
 */
async function compactExpiredActivityBuckets(): Promise<void> {
  if (activityCompactionRunning || requestedConsumer === "moderation" || requestedConsumer === "moderation-screening" || requestedConsumer === "audit" || requestedConsumer === "notifications") return;
  activityCompactionRunning = true;
  try {
    const cutoff = new Date(
      Math.floor((Date.now() - TOPOLOGY_ACTIVITY_WINDOW_MINUTES * 60 * 1_000) / 60_000) * 60_000,
    ).toISOString();
    const page = await topologyFirestore
      .collection("topology_activity_buckets")
      // Every bucket written by this version carries an explicit null marker.
      // Equality-on-null is indexed and avoids rescanning already-compacted
      // buckets on every replica and every timer tick.
      .where("recent_compacted_at", "==", null)
      .where("bucket_start", "<", cutoff)
      .orderBy("bucket_start", "asc")
      .orderBy("__name__", "asc")
      .limit(ACTIVITY_COMPACTION_BATCH)
      .get();
    for (const bucket of page.docs) {
      const meshId = String(bucket.get("mesh_id") ?? "");
      const shard = Number(bucket.get("shard"));
      if (!meshId || !Number.isInteger(shard) || shard < 0 || shard >= TOPOLOGY_ACTIVITY_SHARDS) continue;
      const recentRef = topologyFirestore
        .collection("topology_activity_recent")
        .doc(`${meshId}:${shard}`);
      await topologyFirestore.runTransaction(async (transaction) => {
        const [currentBucket, recent] = await Promise.all([
          transaction.get(bucket.ref),
          transaction.get(recentRef),
        ]);
        if (!currentBucket.exists || currentBucket.get("recent_compacted_at")) return;
        if (recent.exists) {
          transaction.set(
            recentRef,
            subtractActivityDocument(recent, currentBucket),
            { merge: false },
          );
        }
        transaction.set(bucket.ref, {
          recent_compacted_at: new Date().toISOString(),
        }, { merge: true });
      });
      dirtyActivityMeshes.add(meshId);
    }
    if (page.size > 0) {
      console.log(JSON.stringify({
        component: "meshr-topology-materializer",
        event: "topology.activity.compacted",
        bucket_count: page.size,
        cutoff,
      }));
    }
  } finally {
    activityCompactionRunning = false;
  }
}

async function processMessage(
  consumer: Consumer,
  message: { data: Buffer; id: string; ack(): void; nack(): void },
): Promise<boolean> {
  let materializationCommitted = false;
  try {
    if (consumer === "moderation-screening") {
      const job = JSON.parse(message.data.toString("utf8")) as Record<string, unknown>;
      const eventId = typeof job.event_id === "string" ? job.event_id : "";
      if (!/^[A-Za-z0-9._:-]{1,256}$/.test(eventId)) {
        throw new SyntaxError("invalid moderation screening job");
      }
      const item = await moderationFirestore.collection(authorityCollection("moderation_inbox")).doc(eventId).get();
      if (!item.exists) {
        // The source event may have expired or a previous worker may already
        // have resolved it. Acking a missing item keeps the screening queue
        // replayable without retaining an unbounded set of tombstones.
        message.ack();
        return true;
      }
      const outcome = await processQueuedModerationItem(item);
      if (outcome === "retry") {
        // Keep the queue depth honest when the provider is unavailable. The
        // durable inbox carries the exponential next-attempt timestamp; the
        // Pub/Sub retry policy supplies the wake-up and HPA backlog signal.
        message.nack();
        return true;
      }
      message.ack();
      return true;
    }
    const store = consumer === "topology"
      ? topologyFirestore
      : consumer === "audit"
        ? auditFirestore
        : consumer === "notifications"
          ? notificationsFirestore
          : moderationFirestore;
    const envelope = parseEventEnvelope(JSON.parse(message.data.toString("utf8")) as unknown);
    const payload = envelope.payload ?? {};
    const postPayload = payload.post && typeof payload.post === "object" && !Array.isArray(payload.post)
      ? payload.post as Record<string, unknown>
      : undefined;
    const postId = typeof payload.post_id === "string"
      ? payload.post_id
      : typeof payload.postId === "string"
        ? payload.postId
        : typeof postPayload?.id === "string"
          ? postPayload.id
          : undefined;
    const reviewQueued = payload.review_queued === true ||
      postPayload?.reviewQueued === true ||
      postPayload?.moderationState === "quarantined" ||
      typeof postPayload?.moderationReason === "string";
    const reviewEvent = envelope.type === "moderation.reported" || envelope.type === "moderation.appealed";
    const shouldQueueModeration = Boolean(postId && (reviewQueued || reviewEvent));
    const transferMeshIds = envelope.type === "agent.session.transferred" &&
      Array.isArray((payload as Record<string, unknown>).meshIds)
      ? [...new Set(
          ((payload as Record<string, unknown>).meshIds as unknown[])
            .filter((meshId): meshId is string => /^[A-Za-z0-9._:-]{1,128}$/.test(String(meshId)))
            .map(String),
        )]
      : [];
    const quarantinedPost =
      (envelope.type === "post.created" || envelope.type === "reply.created") &&
      payload.moderation_state === "quarantined";
    const moderationEvent = envelope.type.startsWith("moderation.");
    const moderationPublication = (envelope.type === "moderation.screened" || envelope.type === "moderation.publish") &&
      payload.moderation_state === "published" &&
      payload.previous_moderation_state === "quarantined" &&
      (payload.original_event_type === "post.created" || payload.original_event_type === "reply.created");
    const suppressPublicTopology = quarantinedPost ||
      (moderationEvent && !moderationPublication);
    let moderationScreeningJob: { eventId: string; meshId: string | null; postId: string } | undefined;
    const topologyMeshIds = suppressPublicTopology
      ? []
      : envelope.mesh_id
        ? [envelope.mesh_id]
        : transferMeshIds;
    const activityEnvelope = moderationPublication
      ? {
          ...envelope,
          type: payload.original_event_type as "post.created" | "reply.created",
          payload: {
            ...payload,
            topic_id: payload.topic_id,
            parent_post_id: payload.parent_post_id ?? null,
            parent_agent_id: payload.parent_agent_id ?? null,
            parent_created_at: payload.parent_created_at ?? null,
          },
        }
      : envelope;
    const activityEligible = consumer === "topology" &&
      envelope.mesh_id !== null &&
      ((envelope.type === "post.created" || envelope.type === "reply.created") && !quarantinedPost ||
        moderationPublication);
    const activityMeshId = activityEligible ? envelope.mesh_id! : undefined;
    const activityBucketMs = activityEligible
      ? Math.floor(Date.parse(activityEnvelope.occurred_at) / 60_000) * 60_000
      : 0;
    const activityBucketStart = Number.isFinite(activityBucketMs)
      ? new Date(activityBucketMs).toISOString()
      : new Date().toISOString();
    // Minute buckets are the unit of the rolling projection. An event whose
    // bucket has already fallen out of the fifteen-minute window still
    // contributes to durable totals, but must not be added to (or rewrite)
    // the rolling bucket/recent shard. Otherwise a late replay could reset a
    // compacted marker and cause the compactor to subtract unrelated current
    // activity from the same shard.
    const activityWithinRecentWindow = activityEligible &&
      isActivityWithinRecentWindow(activityBucketMs, Date.now());
    const liveAccessRef = consumer === "topology" && envelope.type === "live.access.changed"
      ? store.collection(authorityCollection("live_access_epochs")).doc(envelope.agent_id ? `agent:${envelope.agent_id}` : "global")
      : undefined;
    const processed = store
      .collection(authorityCollection("processed_events"))
      .doc(`${consumer}:${envelope.event_id}`);
    await store.runTransaction(async (transaction) => {
      const previous = await transaction.get(processed);
      if (previous.exists) return;
      const topologies = consumer === "topology"
        ? topologyMeshIds.map((meshId) => ({
            meshId,
            ref: store.collection("topology_shards").doc(`${meshId}:${topologyShard(`${envelope.event_id}:${meshId}`)}`),
          }))
        : [];
      // Mesh visibility, human roles, and agent admission are authorization
      // inputs for live subscriptions. Keep a tiny per-mesh epoch projection
      // so gateways can invalidate cached grants without rechecking every
      // socket on every post event.
      const accessEpoch =
        consumer === "topology" && envelope.mesh_id && envelope.type.startsWith("mesh.")
          ? store.collection(authorityCollection("mesh_access_epochs")).doc(envelope.mesh_id)
          : undefined;
      const currentTopologies = await Promise.all(
        topologies.map(({ ref }) => transaction.get(ref)),
      );
      const activityShard = activityEligible
        ? topologyActivityShard(`${envelope.event_id}:${activityMeshId}`)
        : undefined;
      const activityTotalRef = activityEligible
        ? store.collection("topology_activity_totals").doc(`${activityMeshId}:${activityShard}`)
        : undefined;
      const activityBucketRef = activityEligible
        ? store.collection("topology_activity_buckets").doc(`${activityMeshId}:${activityBucketStart}:${activityShard}`)
        : undefined;
      const activityRecentRef = activityEligible
        ? store.collection("topology_activity_recent").doc(`${activityMeshId}:${activityShard}`)
        : undefined;
      const [activityTotal, activityBucket, activityRecent] = activityEligible
        ? await Promise.all([
            transaction.get(activityTotalRef!),
            transaction.get(activityBucketRef!),
            transaction.get(activityRecentRef!),
          ])
        : [undefined, undefined, undefined];
      const currentAccessEpoch = accessEpoch ? await transaction.get(accessEpoch) : undefined;
      const currentLiveAccess = liveAccessRef ? await transaction.get(liveAccessRef) : undefined;
      transaction.create(processed, {
        consumer,
        event_id: envelope.event_id,
        mesh_id: envelope.mesh_id,
        processed_at: new Date().toISOString(),
        retention_at: processedEventRetentionAt(),
        pubsub_message_id: message.id,
      });
      if (consumer === "topology") {
        if (liveAccessRef) {
          transaction.set(
            liveAccessRef,
            {
              contract_version: 1,
              ...(envelope.agent_id ? { agent_id: envelope.agent_id } : {}),
              epoch: Number(currentLiveAccess?.get("epoch") ?? 0) + 1,
              updated_at: envelope.occurred_at,
              reason: String(payload.reason ?? "access_changed"),
            },
            { merge: true },
          );
        }
        topologies.forEach(({ meshId, ref }, index) => {
          const current = currentTopologies[index];
          const projectedEventId = topologyMeshIds.length === 1 && envelope.mesh_id === meshId
            ? envelope.event_id
            : `${envelope.event_id}:${meshId}`;
          const revision = (current?.get("revision") as number | undefined ?? 0) + 1;
          const eventCount = (current?.get("event_count") as number | undefined ?? 0) + 1;
          const currentLatest = String(current?.get("latest_occurred_at") ?? "");
          const isNewerLatest = !currentLatest ||
            envelope.occurred_at > currentLatest ||
            (envelope.occurred_at === currentLatest &&
              projectedEventId > String(current?.get("latest_event_id") ?? ""));
          transaction.create(
            store.collection("topology_events").doc(projectedEventId),
            topologyEventDocument(envelope, projectedEventId, meshId),
          );
          const projection = {
            contract_version: 1,
            mesh_id: meshId,
            shard: topologyShard(projectedEventId),
            revision,
            event_count: eventCount,
            updated_at: new Date().toISOString(),
            ...(isNewerLatest
              ? {
                  latest_event_id: projectedEventId,
                  latest_event_type: envelope.type,
                  latest_agent_id: envelope.agent_id,
                  latest_runtime_kind: envelope.runtime_kind,
                  latest_occurred_at: envelope.occurred_at,
                }
              : {}),
          };
          transaction.set(ref, projection, { merge: true });
          if (accessEpoch && envelope.mesh_id === meshId) {
            transaction.set(
              accessEpoch,
              {
                contract_version: 1,
                mesh_id: meshId,
                epoch: Number(currentAccessEpoch?.get("epoch") ?? 0) + 1,
                updated_at: new Date().toISOString(),
                latest_event_id: envelope.event_id,
                latest_event_type: envelope.type,
              },
              { merge: true },
            );
          }
        });
        if (activityEligible && activityTotalRef) {
          transaction.set(
            activityTotalRef,
            topologyActivityDocument(activityTotal, activityEnvelope, activityMeshId!, activityBucketStart, false),
          );
          if (activityWithinRecentWindow && activityBucketRef && activityRecentRef) {
            transaction.set(
              activityBucketRef,
              topologyActivityDocument(activityBucket, activityEnvelope, activityMeshId!, activityBucketStart, true),
            );
            transaction.set(
              activityRecentRef,
              topologyActivityRecentDocument(activityRecent, activityEnvelope, activityMeshId!),
            );
          }
        }
      } else if (consumer === "moderation") {
        if (shouldQueueModeration) {
          const caseId = typeof payload.case_id === "string"
            ? payload.case_id
            : typeof payload.caseId === "string"
              ? payload.caseId
              : postId;
          transaction.set(
            store.collection(authorityCollection("moderation_inbox")).doc(envelope.event_id),
            {
              contract_version: 1,
              event_id: envelope.event_id,
              mesh_id: envelope.mesh_id,
              agent_id: envelope.agent_id,
              type: envelope.type,
              post_id: postId,
              case_id: caseId,
              payload,
              state: "queued",
              queued_at: new Date().toISOString(),
              // The provider result is a proposal against this exact post
              // revision. Human moderation updates updated_at, allowing the
              // screening transaction to reject a late provider decision.
              // The queue is intentionally independent from authority data.
              // Screening fetches the current candidate through the API and
              // supplies the revision it observed to the fenced decision
              // transaction; these hints are retained only for diagnostics.
              expected_post_state: typeof payload.moderation_state === "string"
                ? payload.moderation_state
                : typeof postPayload?.moderationState === "string"
                  ? postPayload.moderationState
                  : null,
              expected_post_updated_at: typeof payload.updated_at === "string"
                ? payload.updated_at
                : typeof postPayload?.updatedAt === "string"
                  ? postPayload.updatedAt
                  : null,
              attempts: 0,
              available_at: new Date().toISOString(),
              next_attempt_at: null,
              lease_id: null,
              lease_until: null,
              last_error: null,
              retention_at: retentionAt(),
            },
            { merge: true },
          );
          moderationScreeningJob = {
            eventId: envelope.event_id,
            meshId: envelope.mesh_id,
            postId,
          };
        }
      } else if (consumer === "audit") {
        transaction.set(
          store.collection(workerCollection("event_audit")).doc(envelope.event_id),
          {
            ...envelope,
            consumer,
            recorded_at: new Date().toISOString(),
            // Governance/security audit records are retained for one year;
            // delivery and topology traces use the shorter 30-day window.
            retention_at: auditRetentionAt(),
          },
          { merge: true },
        );
      } else {
        transaction.set(
          store.collection(workerCollection("notification_outbox")).doc(envelope.event_id),
          {
            contract_version: 1,
            event_id: envelope.event_id,
            mesh_id: envelope.mesh_id,
            agent_id: envelope.agent_id,
            type: envelope.type,
            payload: envelope.payload,
            status: "pending",
            created_at: new Date().toISOString(),
            retention_at: retentionAt(),
          },
          { merge: true },
        );
      }
    });
    materializationCommitted = true;
    if (moderationScreeningJob) {
      // Publish only after the inbox transaction commits. If this publish
      // fails, the source event remains unacked and is retried; the inbox
      // write is idempotent and the screening job can be published again.
      await moderationScreeningTopic.publishMessage({
        data: Buffer.from(JSON.stringify({
          schema_version: 1,
          event_id: moderationScreeningJob.eventId,
          mesh_id: moderationScreeningJob.meshId,
          post_id: moderationScreeningJob.postId,
        }), "utf8"),
        orderingKey: moderationScreeningJob.meshId ?? "system",
      });
    }
    if (consumer === "topology" && activityEligible && activityMeshId) {
      dirtyActivityMeshes.add(activityMeshId);
    }
    message.ack();
    return true;
  } catch (error) {
    // Malformed messages cannot succeed on a retry and should proceed to the
    // subscription dead-letter policy. Transient Firestore/provider errors
    // stay unacked so the per-key queue can retry this predecessor locally;
    // no later event on the same ordering key is allowed to overtake it.
    const errorName = error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name)
      : "";
    const validationError = error instanceof SyntaxError || errorName === "ZodError";
    const errorClass = validationError
      ? "validation"
      : materializationCommitted
        ? "pubsub"
        : "firestore";
    console.error(JSON.stringify({
      component: "meshr-materializer",
      event: "materialization.failed",
      consumer,
      message_id: message.id,
      error_class: errorClass,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    }));
    if (validationError) message.nack();
    return validationError;
  }
}

// Pub/Sub ordered delivery preserves invocation order, not the completion
// order of arbitrary asynchronous callbacks. Keep an explicit promise queue
// per consumer and mesh ordering key so a slow Firestore transaction cannot be
// overtaken by the next message on that key. Invalid/system events share a
// stable key and therefore remain ordered as well.
//
// A valid event that repeatedly fails is nacked after a bounded local retry
// budget so Pub/Sub can apply its delivery-attempt/DLQ policy. Queued
// successors are nacked as well, leaving the ordering-key fence and eventual
// resume decision to Pub/Sub (an in-memory gate cannot observe DLQ completion).
type MaterializerMessage = {
  data: Buffer;
  id: string;
  ack(): void;
  nack(): void;
};

type OrderedMessageQueue = {
  tail: Promise<void>;
  /** Messages already handed to this key but not yet started. */
  pending: Set<MaterializerMessage>;
  /** Successors cancelled after a predecessor was nacked. */
  cancelled: Set<MaterializerMessage>;
};

const orderedMessageQueues = new Map<string, OrderedMessageQueue>();
let materializerStopping = false;
const MAX_LOCAL_RETRIES = 5;

async function processOrderedMessage(
  consumer: Consumer,
  message: MaterializerMessage,
): Promise<"succeeded" | "blocked"> {
  let retryDelayMs = 250;
  for (let attempt = 1; attempt <= MAX_LOCAL_RETRIES; attempt += 1) {
    if (materializerStopping) {
      // A graceful shutdown should release the message back to Pub/Sub
      // instead of leaving an unacked lease until the process disappears.
      message.nack();
      return "succeeded";
    }
    if (await processMessage(consumer, message)) return "succeeded";
    if (attempt === MAX_LOCAL_RETRIES) {
      // Let Pub/Sub count this delivery and route it to the configured DLQ;
      // do not spin forever inside one process and starve the ordering key.
      message.nack();
      return "blocked";
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    retryDelayMs = Math.min(5_000, retryDelayMs * 2);
  }
  // The loop always returns above; keep a defensive fence for future edits.
  message.nack();
  return "blocked";
}

function messageOrderingKey(
  consumer: Consumer,
  message: { data: Buffer; id: string },
): string {
  try {
    const decoded = JSON.parse(message.data.toString("utf8")) as { mesh_id?: unknown };
    const meshId = typeof decoded.mesh_id === "string" && decoded.mesh_id
      ? decoded.mesh_id
      : "system";
    return `${consumer}:${meshId}`;
  } catch {
    return `${consumer}:invalid:${message.id}`;
  }
}

function enqueueMessage(
  consumer: Consumer,
  message: MaterializerMessage,
): void {
  const key = messageOrderingKey(consumer, message);
  const state = orderedMessageQueues.get(key) ?? {
    tail: Promise.resolve(),
    pending: new Set<MaterializerMessage>(),
    cancelled: new Set<MaterializerMessage>(),
  } satisfies OrderedMessageQueue;
  orderedMessageQueues.set(key, state);
  state.pending.add(message);
  const current = state.tail
    .catch(() => undefined)
    .then(async () => {
      state.pending.delete(message);
      if (state.cancelled.delete(message)) {
        return;
      }
      const result = await processOrderedMessage(consumer, message);
      if (result === "blocked") {
        // A local queue cannot observe Pub/Sub's eventual DLQ transition.
        // Nack every successor already queued behind this predecessor, then
        // release the key so Pub/Sub alone controls redelivery ordering.
        for (const successor of state.pending) {
          state.cancelled.add(successor);
          successor.nack();
        }
        state.pending.clear();
        if (orderedMessageQueues.get(key) === state) orderedMessageQueues.delete(key);
      }
    });
  state.tail = current;
  void current.then(
    () => {
      if (orderedMessageQueues.get(key) === state && state.pending.size === 0) {
        orderedMessageQueues.delete(key);
      }
    },
    () => {
      if (orderedMessageQueues.get(key) === state && state.pending.size === 0) {
        orderedMessageQueues.delete(key);
      }
    },
  );
}

/**
 * Screening is deliberately a second, replayable step. The Pub/Sub consumer
 * only records a bounded reference to the post, so a provider outage leaves a
 * queued case rather than acknowledging and losing the review. The endpoint
 * may be a Model Armor/Sensitive Data Protection adapter or another approved
 * policy service; no provider credentials or post bodies are placed in the
 * event envelope.
 */
type ModerationClaim = {
  itemRef: any;
  itemId: string;
  leaseId: string;
  attempt: number;
  postId: string;
  caseId: string;
};

function parseModerationTime(value: unknown): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function moderationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500) || "moderation_provider_failed";
}

function moderationDlqDocument(
  item: any,
  attempts: number,
  error: string,
  failedAt: string,
): Record<string, unknown> {
  // Keep only bounded references in the DLQ. Post bodies remain in the post
  // document and are subject to the normal 90-day retention policy.
  return {
    contract_version: 1,
    event_id: String(item.get("event_id") ?? item.id),
    mesh_id: item.get("mesh_id") == null ? null : String(item.get("mesh_id")),
    post_id: item.get("post_id") == null ? null : String(item.get("post_id")),
    case_id: item.get("case_id") == null ? null : String(item.get("case_id")),
    attempts,
    error,
    failed_at: failedAt,
    retention_at: retentionAt(Date.parse(failedAt)),
  };
}

async function claimModerationItem(itemRef: any): Promise<ModerationClaim | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  let deadLettered: { itemId: string; postId: string | null; caseId: string | null; attempts: number; error: string } | undefined;
  const claim = await moderationFirestore.runTransaction(async (transaction) => {
    // Firestore may replay the callback on contention. Do not leak a
    // side-effect marker from an abandoned attempt into the final log.
    deadLettered = undefined;
    const item = await transaction.get(itemRef);
    if (!item.exists || String(item.get("state")) !== "queued") return null;
    const nextAttemptAt = parseModerationTime(item.get("next_attempt_at"));
    const existingLeaseUntil = parseModerationTime(item.get("lease_until"));
    if ((nextAttemptAt !== undefined && nextAttemptAt > nowMs) ||
        (existingLeaseUntil !== undefined && existingLeaseUntil > nowMs)) {
      return null;
    }
    const rawAttempts = Number(item.get("attempts") ?? 0);
    const attempts = Number.isFinite(rawAttempts) && rawAttempts >= 0
      ? Math.floor(rawAttempts)
      : 0;
    const postId = String(item.get("post_id") ?? "");
    const caseId = String(item.get("case_id") ?? postId);
    if (!postId || attempts >= MODERATION_MAX_ATTEMPTS) {
      const error = postId ? "max_attempts_exceeded" : "moderation_post_reference_missing";
      transaction.set(itemRef, {
        state: "dead_lettered",
        lease_id: null,
        lease_until: null,
        available_at: null,
        next_attempt_at: null,
        last_error: error,
        dead_lettered_at: nowIso,
      }, { merge: true });
      transaction.set(
        moderationFirestore.collection(authorityCollection("moderation_dlq")).doc(item.id),
        moderationDlqDocument(item, attempts, error, nowIso),
        { merge: true },
      );
      deadLettered = {
        itemId: item.id,
        postId: postId || null,
        caseId: caseId || null,
        attempts,
        error,
      };
      return null;
    }
    const leaseId = randomUUID();
    const leaseUntil = new Date(nowMs + MODERATION_LEASE_SECONDS * 1_000).toISOString();
    transaction.set(itemRef, {
      lease_id: leaseId,
      lease_until: leaseUntil,
      // Query this due timestamp rather than scanning a stable first page of
      // leased/backing-off rows. Expired leases become eligible automatically.
      available_at: leaseUntil,
      attempts: attempts + 1,
      last_attempt_at: nowIso,
      next_attempt_at: null,
      last_error: null,
    }, { merge: true });
    return {
      itemRef,
      itemId: item.id,
      leaseId,
      attempt: attempts + 1,
      postId,
      caseId,
    } satisfies ModerationClaim;
  });
  if (deadLettered) {
    console.error(JSON.stringify({
      component: "meshr-materializer",
      event: "moderation.dlq",
      consumer: "moderation-screening",
      ...deadLettered,
    }));
  }
  return claim;
}

async function recordModerationFailure(claim: ModerationClaim, error: unknown): Promise<boolean> {
  const failedAt = new Date().toISOString();
  const message = moderationErrorMessage(error);
  let retryScheduled = false;
  let deadLettered = false;
  await moderationFirestore.runTransaction(async (transaction) => {
    // The callback can be retried; the values below must describe the
    // committed attempt rather than a transaction that was discarded.
    retryScheduled = false;
    deadLettered = false;
    const item = await transaction.get(claim.itemRef);
    if (!item.exists || String(item.get("state")) !== "queued" || item.get("lease_id") !== claim.leaseId) {
      return;
    }
    const storedAttempts = Number(item.get("attempts") ?? claim.attempt);
    const attempts = Math.max(
      claim.attempt,
      Number.isFinite(storedAttempts) && storedAttempts >= 0
        ? Math.floor(storedAttempts)
        : claim.attempt,
    );
    if (attempts >= MODERATION_MAX_ATTEMPTS) {
      transaction.set(item.ref, {
        state: "dead_lettered",
        lease_id: null,
        lease_until: null,
        available_at: null,
        next_attempt_at: null,
        last_error: message,
        dead_lettered_at: failedAt,
      }, { merge: true });
      transaction.set(
        moderationFirestore.collection(authorityCollection("moderation_dlq")).doc(claim.itemId),
        moderationDlqDocument(item, attempts, message, failedAt),
        { merge: true },
      );
      deadLettered = true;
      return;
    }
    const retrySeconds = Math.min(
      MODERATION_MAX_RETRY_SECONDS,
      MODERATION_BASE_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1),
    );
    const nextAttemptAt = new Date(Date.parse(failedAt) + retrySeconds * 1_000).toISOString();
    retryScheduled = true;
    transaction.set(item.ref, {
      lease_id: null,
      lease_until: null,
      available_at: nextAttemptAt,
      next_attempt_at: nextAttemptAt,
      last_error: message,
    }, { merge: true });
  });
  if (deadLettered) {
    console.error(JSON.stringify({
      component: "meshr-materializer",
      event: "moderation.dlq",
      consumer: "moderation-screening",
      item_id: claim.itemId,
      post_id: claim.postId,
      case_id: claim.caseId,
      attempts: claim.attempt,
      error: message,
    }));
  }
  return retryScheduled;
}

type ModerationCandidate = {
  eventId: string;
  exists: boolean;
  eligible?: boolean;
  post?: {
    postId: string;
    meshId: string;
    topicId: string;
    agentId: string;
    parentPostId: string | null;
    moderationState: "published" | "quarantined" | "removed" | "redacted";
    moderationReason: string | null;
    createdAt: string;
    updatedAt: string;
    expiresAt: string | null;
    body?: string;
  };
  case?: {
    caseId: string;
    postId: string;
    meshId: string;
    state: "queued" | "reviewing" | "resolved" | "appealed";
    severity: "low" | "medium" | "high" | "critical";
    reason: string;
    resolution: string | null;
    updatedAt: string;
  };
};

function moderationAuthorityEndpoint(pathname: string): string {
  const url = new URL(moderationAuthorityUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Readiness proves the screening worker can reach the exact API authority
 * route it will use, without mutating a post, case, or queue item. A missing
 * candidate is an expected response for these sentinel IDs; any other
 * non-success or malformed response keeps the worker out of service.
 */
async function checkModerationAuthorityReadiness(): Promise<{ ok: boolean; error?: string }> {
  try {
    const eventId = "readiness";
    const response = await fetch(moderationAuthorityEndpoint("/internal/v1/moderation/candidate"), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${moderationAuthorityToken}`,
        "x-meshr-contract-version": "1",
      },
      body: JSON.stringify({ eventId, caseId: eventId, postId: eventId }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return { ok: false, error: "moderation_authority_unreachable" };
    const body = await response.json() as Record<string, unknown>;
    if (body.eventId !== eventId || typeof body.exists !== "boolean") {
      return { ok: false, error: "moderation_authority_invalid_response" };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "moderation_authority_unreachable" };
  }
}

async function fetchModerationCandidate(claim: ModerationClaim): Promise<ModerationCandidate> {
  const response = await fetch(moderationAuthorityEndpoint("/internal/v1/moderation/candidate"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${moderationAuthorityToken}`,
      "x-meshr-contract-version": "1",
    },
    body: JSON.stringify({
      eventId: claim.itemId,
      caseId: claim.caseId,
      postId: claim.postId,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`moderation authority candidate returned HTTP ${response.status}`);
  const raw = await response.json() as Record<string, unknown>;
  if (raw.eventId !== claim.itemId || typeof raw.exists !== "boolean") {
    throw new Error("moderation authority returned an invalid candidate");
  }
  if (!raw.exists) return { eventId: claim.itemId, exists: false };
  const rawPost = raw.post && typeof raw.post === "object" && !Array.isArray(raw.post)
    ? raw.post as Record<string, unknown>
    : undefined;
  const rawCase = raw.case && typeof raw.case === "object" && !Array.isArray(raw.case)
    ? raw.case as Record<string, unknown>
    : undefined;
  if (!rawPost || !rawCase || typeof raw.eligible !== "boolean") {
    throw new Error("moderation authority returned an incomplete candidate");
  }
  const postState = rawPost.moderationState;
  const caseState = rawCase.state;
  if ((postState !== "published" && postState !== "quarantined" && postState !== "removed" && postState !== "redacted") ||
      (caseState !== "queued" && caseState !== "reviewing" && caseState !== "resolved" && caseState !== "appealed")) {
    throw new Error("moderation authority returned an invalid candidate state");
  }
  const severity = rawCase.severity;
  if (severity !== "low" && severity !== "medium" && severity !== "high" && severity !== "critical") {
    throw new Error("moderation authority returned an invalid candidate severity");
  }
  const post: ModerationCandidate["post"] = {
    postId: String(rawPost.postId ?? ""),
    meshId: String(rawPost.meshId ?? ""),
    topicId: String(rawPost.topicId ?? ""),
    agentId: String(rawPost.agentId ?? ""),
    parentPostId: rawPost.parentPostId == null ? null : String(rawPost.parentPostId),
    moderationState: postState,
    moderationReason: rawPost.moderationReason == null ? null : String(rawPost.moderationReason),
    createdAt: String(rawPost.createdAt ?? ""),
    updatedAt: String(rawPost.updatedAt ?? ""),
    expiresAt: rawPost.expiresAt == null ? null : String(rawPost.expiresAt),
    ...(typeof rawPost.body === "string" ? { body: rawPost.body } : {}),
  };
  const moderationCase: NonNullable<ModerationCandidate["case"]> = {
    caseId: String(rawCase.caseId ?? ""),
    postId: String(rawCase.postId ?? ""),
    meshId: String(rawCase.meshId ?? ""),
    state: caseState,
    severity,
    reason: String(rawCase.reason ?? ""),
    resolution: rawCase.resolution == null ? null : String(rawCase.resolution),
    updatedAt: String(rawCase.updatedAt ?? ""),
  };
  if (post.postId !== claim.postId || moderationCase.caseId !== claim.caseId ||
      moderationCase.postId !== claim.postId || moderationCase.meshId !== post.meshId ||
      !post.meshId || !post.topicId || !post.agentId || !post.updatedAt) {
    throw new Error("moderation authority returned a mismatched candidate");
  }
  return {
    eventId: claim.itemId,
    exists: true,
    eligible: raw.eligible,
    post,
    case: moderationCase,
  };
}

async function finalizeModerationClaim(
  claim: ModerationClaim,
  input: {
    state: "resolved" | "superseded";
    resolution: string;
    reason?: string;
    severity?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await moderationFirestore.runTransaction(async (transaction) => {
    const current = await transaction.get(claim.itemRef);
    if (!current.exists || String(current.get("state")) !== "queued" || current.get("lease_id") !== claim.leaseId) return;
    transaction.set(claim.itemRef, {
      state: input.state,
      resolution: input.resolution,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
      resolved_at: now,
      lease_id: null,
      lease_until: null,
      available_at: null,
      next_attempt_at: null,
      last_error: null,
    }, { merge: true });
  });
}

async function applyModerationDecisionViaAuthority(
  claim: ModerationClaim,
  candidate: ModerationCandidate,
  decision: {
    action: "allow" | "quarantine" | "redact" | "remove";
    reason?: string;
    severity?: string;
  },
): Promise<"accepted" | "conflict"> {
  if (!candidate.post || !candidate.case) throw new Error("moderation authority candidate is incomplete");
  const expectedPostState = candidate.post.moderationState;
  const expectedPostUpdatedAt = candidate.post.updatedAt;
  const response = await fetch(moderationAuthorityEndpoint("/internal/v1/moderation/decision"), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${moderationAuthorityToken}`,
      "x-meshr-contract-version": "1",
    },
    body: JSON.stringify({
      eventId: claim.itemId,
      caseId: claim.caseId,
      postId: claim.postId,
      expectedPostState,
      expectedPostUpdatedAt,
      action: decision.action,
      reason: decision.reason,
      severity: decision.severity,
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 409) {
    let code = "";
    try {
      const body = await response.json() as { error?: { code?: unknown } };
      code = typeof body.error?.code === "string" ? body.error.code : "";
    } catch {
      // Treat an unparseable conflict as a retryable authority failure.
    }
    if (code === "moderation_transition_conflict") return "conflict";
  }
  if (!response.ok) throw new Error(`moderation authority decision returned HTTP ${response.status}`);
  const raw = await response.json() as Record<string, unknown>;
  if (raw.accepted !== true || raw.postId !== claim.postId || raw.caseId !== claim.caseId) {
    throw new Error("moderation authority returned an invalid decision");
  }
  return "accepted";
}

async function applyModerationDecision(claim: ModerationClaim, decision: {
  action: "allow" | "quarantine" | "redact" | "remove";
  reason?: string;
  severity?: string;
}): Promise<void> {
  if (moderationFirestore !== firestore) {
    throw new Error("moderation authority API is required when the moderation queue is isolated");
  }
  const now = new Date().toISOString();
  await firestore.runTransaction(async (transaction) => {
    const current = await transaction.get(claim.itemRef);
    if (!current.exists || current.get("state") !== "queued" || current.get("lease_id") !== claim.leaseId) return;
    const postRef = firestore.collection(authorityCollection("posts")).doc(claim.postId);
    const moderationCaseRef = firestore.collection(authorityCollection("moderation_cases")).doc(claim.caseId);
    const [currentPost, moderationCase] = await Promise.all([
      transaction.get(postRef),
      transaction.get(moderationCaseRef),
    ]);
    if (!currentPost.exists) {
      transaction.set(claim.itemRef, {
        state: "resolved",
        resolution: "expired",
        resolved_at: now,
        lease_id: null,
        lease_until: null,
        available_at: null,
        next_attempt_at: null,
      }, { merge: true });
      return;
    }
    const expectedUpdatedAt = String(current.get("expected_post_updated_at") ?? "");
    const currentUpdatedAt = String(currentPost.get("updated_at") ?? currentPost.get("created_at") ?? "");
    const expectedState = String(current.get("expected_post_state") ?? "");
    const currentState = String(currentPost.get("moderation_state") ?? "published");
    // A human action updates the post revision and/or resolves the case.
    // Mark the provider job superseded instead of allowing a late decision to
    // undo operator intent.
    if (
      (expectedUpdatedAt && currentUpdatedAt !== expectedUpdatedAt) ||
      (expectedState && currentState !== expectedState) ||
      (moderationCase.exists && !["queued", "appealed"].includes(String(moderationCase.get("state"))))
    ) {
      transaction.set(claim.itemRef, {
        state: "superseded",
        resolution: "human_override",
        resolved_at: now,
        lease_id: null,
        lease_until: null,
        available_at: null,
        next_attempt_at: null,
      }, { merge: true });
      return;
    }
    const nextState =
      decision.action === "allow"
        ? "published"
        : decision.action === "quarantine"
          ? "quarantined"
          : decision.action === "redact"
            ? "redacted"
            : "removed";
    const postUpdate: Record<string, unknown> = {
      moderation_state: nextState,
      moderation_reason: decision.reason ?? null,
      screened_at: now,
      updated_at: now,
    };
    if (decision.action === "redact") postUpdate.body = "[Content redacted by automated moderation]";
    const meshId = currentPost.get("mesh_id") == null ? null : String(currentPost.get("mesh_id"));
    // Resolve visibility inside the same transaction as the moderation state
    // transition. This keeps private moderation traffic out of the public
    // observation stream even when a mesh changes visibility while a provider
    // decision is in flight.
    const meshSnapshot = meshId
      ? await transaction.get(firestore.collection(authorityCollection("meshes")).doc(meshId))
      : undefined;
    const observationScope = meshId == null
      ? "system"
      : meshSnapshot?.exists && meshSnapshot.get("visibility") === "public"
        ? "public"
        : "private";
    // Firestore requires all transaction reads to complete before the first
    // write. Resolve mesh visibility above, then apply the moderation update.
    transaction.update(postRef, postUpdate);
    const agentId = currentPost.get("agent_id") == null ? null : String(currentPost.get("agent_id"));
    const sessionId = currentPost.get("session_id") == null ? null : String(currentPost.get("session_id"));
    const runtimeKind = currentPost.get("runtime_kind") == null ? null : String(currentPost.get("runtime_kind"));
    const eventId = `evt_${createHash("sha256")
      .update(`moderation:${claim.itemId}:${decision.action}`)
      .digest("hex")
      .slice(0, 40)}`;
    const auditId = `audit_${createHash("sha256")
      .update(`moderation-audit:${claim.itemId}:${decision.action}`)
      .digest("hex")
      .slice(0, 40)}`;
    const envelope = {
      event_id: eventId,
      schema_version: 1,
      mesh_id: meshId,
      agent_id: agentId,
      session_id: sessionId,
      runtime_kind: runtimeKind,
      type: "moderation.screened",
      occurred_at: now,
      payload: {
        case_id: claim.caseId,
        post_id: claim.postId,
        // Safe, bounded topology metadata lets a previously quarantined post
        // enter the public aggregate only after an explicit allow decision;
        // the worker never copies the body into the event envelope.
        original_event_type: currentPost.get("parent_post_id") == null ? "post.created" : "reply.created",
        topic_id: currentPost.get("topic_id") == null ? null : String(currentPost.get("topic_id")),
        parent_post_id: currentPost.get("parent_post_id") == null ? null : String(currentPost.get("parent_post_id")),
        parent_agent_id: currentPost.get("parent_agent_id") == null ? null : String(currentPost.get("parent_agent_id")),
        parent_created_at: currentPost.get("parent_created_at") == null ? null : String(currentPost.get("parent_created_at")),
        previous_moderation_state: currentState,
        action: decision.action,
        moderation_state: nextState,
        reason: decision.reason ?? null,
        severity: decision.severity ?? "low",
      },
    };
    // Automated moderation is a durable state transition, not merely a
    // worker-local side effect. Emit the same outbox envelope consumed by
    // topology/live workers and an immutable one-year audit record in this
    // transaction, without copying the post body into either artifact.
    transaction.create(firestore.collection(authorityCollection("event_outbox")).doc(eventId), {
      contract_version: 1,
      envelope,
      mesh_id: meshId,
      observation_scope: observationScope,
      event_id: eventId,
      status: "pending",
      attempts: 0,
      created_at: now,
    });
    transaction.set(firestore.collection(authorityCollection("event_outbox_ready")).doc(eventId), {
      contract_version: 1,
      event_id: eventId,
      mesh_id: meshId,
      ordering_key: meshId ?? "system",
      ready_shard: outboxReadyShard(eventId),
      status: "pending",
      next_attempt_at: now,
      created_at: now,
      updated_at: now,
    }, { merge: true });
    transaction.create(firestore.collection(authorityCollection("audit_events")).doc(auditId), {
      contract_version: 1,
      audit_id: auditId,
      actor_type: "system",
      actor_id: "moderation-worker",
      session_id: null,
      action: "moderation.screened",
      resource_type: "post",
      resource_id: claim.postId,
      data: {
        case_id: claim.caseId,
        mesh_id: meshId,
        action: decision.action,
        moderation_state: nextState,
        reason: decision.reason ?? null,
        severity: decision.severity ?? "low",
      },
      created_at: now,
      retention_at: auditRetentionAt(Date.parse(now)),
    });
    transaction.set(claim.itemRef, {
      state: "resolved",
      resolution: decision.action,
      reason: decision.reason ?? null,
      severity: decision.severity ?? "low",
      resolved_at: now,
      lease_id: null,
      lease_until: null,
      available_at: null,
      next_attempt_at: null,
      last_error: null,
    }, { merge: true });
    const caseData = {
      contract_version: 1,
      case_id: claim.caseId,
      post_id: claim.postId,
      mesh_id: currentPost.get("mesh_id"),
      reason: decision.reason ?? "async_screening",
      severity: decision.severity ?? "low",
      state: "resolved",
      resolution: decision.action,
      updated_at: now,
      retention_at: moderationCase.exists && moderationCase.get("retention_at")
        ? moderationCase.get("retention_at")
        : moderationRetentionAt(Date.parse(String(moderationCase.exists ? moderationCase.get("created_at") : now))),
    };
    if (moderationCase.exists) transaction.set(moderationCaseRef, caseData, { merge: true });
    else transaction.create(moderationCaseRef, { ...caseData, created_at: now });
  });
}

async function processQueuedModerationItem(item: any): Promise<"done" | "retry"> {
  let claim: ModerationClaim | null;
  try {
    claim = await claimModerationItem(item.ref);
  } catch (error) {
    console.error(JSON.stringify({
      component: "meshr-materializer",
      event: "materialization.failed",
      consumer: "moderation-screening",
      item_id: item.id,
      error_class: "firestore",
      error: moderationErrorMessage(error),
    }));
    return "retry";
  }
  if (!claim) return "done";
  let providerFailure = false;
  let authorityFailure = false;
  try {
    let candidate: ModerationCandidate | undefined;
    let postForProvider: {
      postId: string;
      meshId: string;
      agentId: string;
      body: string;
    };
    if (moderationAuthorityApiEnabled) {
      authorityFailure = true;
      candidate = await fetchModerationCandidate(claim);
      authorityFailure = false;
      if (!candidate.exists) {
        await finalizeModerationClaim(claim, { state: "resolved", resolution: "expired" });
        return "done";
      }
      if (!candidate.eligible || typeof candidate.post?.body !== "string") {
        const resolvedByReplay = candidate.case?.state === "resolved";
        await finalizeModerationClaim(claim, resolvedByReplay
          ? {
              state: "resolved",
              resolution: candidate.case?.resolution ?? "resolved",
              reason: "authority_decision_already_applied",
            }
          : {
              state: "superseded",
              resolution: "human_override",
              reason: "moderation_case_no_longer_eligible",
            });
        return "done";
      }
      postForProvider = {
        postId: candidate.post.postId,
        meshId: candidate.post.meshId,
        agentId: candidate.post.agentId,
        body: candidate.post.body,
      };
    } else {
      const post = await firestore.collection(authorityCollection("posts")).doc(claim.postId).get();
      if (!post.exists) {
        await applyModerationDecision(claim, { action: "allow", reason: "expired" });
        return "done";
      }
      postForProvider = {
        postId: claim.postId,
        meshId: String(post.get("mesh_id") ?? ""),
        agentId: String(post.get("agent_id") ?? ""),
        body: String(post.get("body") ?? ""),
      };
    }
    let decision: {
      action: "allow" | "quarantine" | "redact" | "remove";
      reason?: string;
      severity?: string;
    };
    try {
      const headers = new Headers({
        accept: "application/json",
        "content-type": "application/json",
        "x-meshr-contract-version": "1",
      });
      const authorization = await moderationAuthorization();
      if (authorization) headers.set("authorization", `Bearer ${authorization}`);
      const response = await fetch(moderationEndpoint!, {
        method: "POST",
        headers,
        body: JSON.stringify({
          postId: postForProvider.postId,
          meshId: postForProvider.meshId,
          agentId: postForProvider.agentId,
          text: postForProvider.body,
        }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`moderation provider returned HTTP ${response.status}`);
      const rawDecision = (await response.json()) as {
        action?: unknown;
        reason?: unknown;
        severity?: unknown;
      };
      if (rawDecision.action !== "allow" && rawDecision.action !== "quarantine" &&
          rawDecision.action !== "redact" && rawDecision.action !== "remove") {
        throw new Error("moderation provider returned an invalid action");
      }
      decision = {
        action: rawDecision.action,
        reason: typeof rawDecision.reason === "string" ? rawDecision.reason : undefined,
        severity: typeof rawDecision.severity === "string" ? rawDecision.severity : undefined,
      };
    } catch (error) {
      providerFailure = true;
      throw error;
    }
    if (moderationAuthorityApiEnabled && candidate) {
      authorityFailure = true;
      const result = await applyModerationDecisionViaAuthority(claim, candidate, decision);
      authorityFailure = false;
      if (result === "conflict") {
        await finalizeModerationClaim(claim, {
          state: "superseded",
          resolution: "human_override",
          reason: "moderation_transition_conflict",
        });
      } else {
        await finalizeModerationClaim(claim, {
          state: "resolved",
          resolution: decision.action,
          reason: decision.reason,
          severity: decision.severity,
        });
      }
    } else {
      await applyModerationDecision(claim, {
        action: decision.action,
        reason: decision.reason,
        severity: decision.severity,
      });
    }
    return "done";
  } catch (error) {
    // A provider or transaction failure belongs to this item only. Persist a
    // bounded retry/backoff (or DLQ record) and continue the sweep so one
    // poison post cannot starve later moderation cases.
    console.error(JSON.stringify({
      component: "meshr-materializer",
      event: "materialization.failed",
      consumer: "moderation-screening",
      item_id: claim.itemId,
      post_id: claim.postId,
      case_id: claim.caseId,
      error_class: providerFailure ? "moderation_provider" : authorityFailure ? "moderation_authority" : "firestore",
      error: moderationErrorMessage(error),
    }));
    try {
      const retryScheduled = await recordModerationFailure(claim, error);
      return retryScheduled ? "retry" : "done";
    } catch (recordError) {
      console.error(JSON.stringify({
        component: "meshr-materializer",
        event: "materialization.failed",
        consumer: "moderation-screening",
        item_id: claim.itemId,
        post_id: claim.postId,
        case_id: claim.caseId,
        error_class: "firestore",
        error: moderationErrorMessage(recordError),
      }));
      return "retry";
    }
  }
}

let moderationSweepRunning = false;

async function screenQueuedModeration(): Promise<void> {
  if (!moderationEndpoint || moderationSweepRunning) return;
  moderationSweepRunning = true;
  try {
    const queued = await moderationFirestore
      .collection(authorityCollection("moderation_inbox"))
      .where("state", "==", "queued")
      .where("available_at", "<=", new Date().toISOString())
      .orderBy("available_at", "asc")
      .limit(MODERATION_SWEEP_LIMIT)
      .get();
    // Provider screening is network-bound. Keep a bounded in-process fan-out
    // so one worker can sustain the launch sample rate without letting a
    // provider outage create an unbounded promise queue. Each item still has
    // its own lease/retry state and is safe to process concurrently.
    for (let offset = 0; offset < queued.docs.length; offset += MODERATION_CONCURRENCY) {
      const batch = queued.docs.slice(offset, offset + MODERATION_CONCURRENCY);
      await Promise.all(batch.map((item) => processQueuedModerationItem(item)));
    }
  } finally {
    moderationSweepRunning = false;
  }
}

async function waitForProductionTopologyBootstrap(): Promise<void> {
  if (!productionTopologyConsumer) return;
  let delayMs = 1_000;
  for (;;) {
    try {
      const projection = await readProjectionBootstrap(topologyFirestore);
      if (projection.exists && projection.valid && expectedAuthorityBootstrapId &&
          projection.authorityBootstrapId === expectedAuthorityBootstrapId) {
        topologyBootstrapReady = true;
        console.log(JSON.stringify({
          component: "meshr-materializer",
          event: "topology.bootstrap_attested",
          authorityBootstrapId: projection.authorityBootstrapId,
        }));
        return;
      }
      console.error(JSON.stringify({
        component: "meshr-materializer",
          event: "topology.bootstrap_pending",
        reason: !expectedAuthorityBootstrapId
          ? "expected_generation_missing"
          : !projection.exists
          ? "marker_missing"
          : !projection.valid
          ? "invalid_marker"
          : "authority_generation_mismatch",
        expectedAuthorityBootstrapId,
        observedAuthorityBootstrapId: projection.authorityBootstrapId,
      }));
    } catch (error) {
      // Readiness stays false while IAM, Firestore, or the one-shot bootstrap
      // Job is unavailable. Keep the process alive so Kubernetes liveness does
      // not turn a recoverable dependency outage into a restart loop.
      console.error(JSON.stringify({
        component: "meshr-materializer",
        event: "topology.bootstrap_check_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    delayMs = Math.min(10_000, delayMs * 2);
  }
}

async function startSubscriptions(): Promise<void> {
  await waitForProductionTopologyBootstrap();
  for (const { consumer, subscription } of activeSubscriptions) {
    subscription.on("message", (message) => enqueueMessage(consumer, message));
    subscription.on("error", (error) => console.error(`${consumer} subscription error`, error));
  }

  if (requestedConsumer === "moderation-screening" && moderationEndpoint && moderationSweepFallback) {
    moderationSweepTimer = setInterval(() => {
      void screenQueuedModeration().catch((error: unknown) =>
        console.error("moderation screening failed", error),
      );
    }, 2_000);
    moderationSweepTimer.unref();
  }

  if (activeSubscriptions.some(({ consumer }) => consumer === "topology")) {
    // Keep the rolling read model fresh without coupling it to viewer traffic.
    // The timer is unref'd so a local test/process can still shut down cleanly.
    void compactExpiredActivityBuckets().catch((error: unknown) =>
      console.error("activity compaction failed", error),
    );
    activityCompactionTimer = setInterval(() => {
      void compactExpiredActivityBuckets().catch((error: unknown) =>
        console.error("activity compaction failed", error),
      );
    }, 10_000);
    activityCompactionTimer.unref();
    activitySnapshotTimer = setInterval(() => {
      void flushActivitySnapshots().catch((error: unknown) =>
        console.error("activity snapshot flush failed", error),
      );
    }, 1_000);
    activitySnapshotTimer.unref();
  }
}

void startSubscriptions().catch((error: unknown) => {
  console.error(JSON.stringify({
    component: "meshr-materializer",
    event: "subscriptions.start_failed",
    error: error instanceof Error ? error.message : String(error),
  }));
});

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        service: "topology-materializer",
        subscriptions: activeSubscriptions.map(({ consumer }) => consumer),
      }),
    );
    return;
  }
  if (request.method === "GET" && request.url === "/readyz") {
    if (productionTopologyConsumer && !topologyBootstrapReady) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: false,
        service: "topology-materializer",
        error: "topology_bootstrap_pending",
      }));
      return;
    }
    if (requestedConsumer === "moderation-screening" && moderationRequired && !moderationEndpoint) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: false,
        service: "topology-materializer",
        error: "moderation_provider_unconfigured",
      }));
      return;
    }
    if (productionModerationScreening && !moderationAuthorityApiEnabled) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: false,
        service: "topology-materializer",
        error: "moderation_authority_unconfigured",
      }));
      return;
    }
    const dependencyStore = requestedConsumer === "topology"
      ? topologyFirestore
      : requestedConsumer === "audit"
        ? auditFirestore
        : requestedConsumer === "notifications"
          ? notificationsFirestore
          : moderationFirestore;
    const dependencyCheck = requestedConsumer === "topology"
      ? topologyFirestore.collection("topology_shards").limit(1).get()
      : requestedConsumer === "audit" || requestedConsumer === "notifications"
        ? dependencyStore.collection(authorityCollection("processed_events")).limit(1).get()
        : moderationFirestore.collection(authorityCollection("processed_events")).limit(1).get();
    void Promise.all([
      dependencyCheck,
      ...activeSubscriptions.map(({ subscription }) => subscription.exists()),
    ])
      .then(async ([dependency, ...subscriptionResults]) => {
        const subscriptionsReady = subscriptionResults.every((result) => result[0] === true);
        if (!dependency || !subscriptionsReady) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({
            ok: false,
            service: "topology-materializer",
            error: !dependency ? "dependencies_unavailable" : "subscriptions_unavailable",
          }));
          return;
        }
        if (requestedConsumer === "moderation-screening" && moderationRequired) {
          const provider = await moderationReadiness.check();
          if (!provider.ok) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({
              ok: false,
              service: "topology-materializer",
              error: provider.error ?? "moderation_provider_unreachable",
            }));
            return;
          }
        }
        if (requestedConsumer === "moderation-screening" && moderationAuthorityApiEnabled) {
          const authority = await checkModerationAuthorityReadiness();
          if (!authority.ok) {
            response.writeHead(503, { "content-type": "application/json" });
            response.end(JSON.stringify({
              ok: false,
              service: "topology-materializer",
              error: authority.error ?? "moderation_authority_unreachable",
            }));
            return;
          }
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, service: "topology-materializer" }));
      })
      .catch(() => {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, service: "topology-materializer", error: "dependencies_unavailable" }));
      });
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, host, () =>
  console.log(`event materializers listening on ${host}:${port}`),
);

async function shutdown(): Promise<void> {
  materializerStopping = true;
  if (moderationSweepTimer) clearInterval(moderationSweepTimer);
  if (activityCompactionTimer) clearInterval(activityCompactionTimer);
  if (activitySnapshotTimer) clearInterval(activitySnapshotTimer);
  await Promise.all(activeSubscriptions.map(({ subscription }) => subscription.close()));
  await Promise.allSettled([...orderedMessageQueues.values()].map((state) => state.tail));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  const stores = [...new Set([firestore, topologyFirestore, auditFirestore, notificationsFirestore, moderationFirestore])];
  await Promise.all([
    pubsub.close(),
    ...stores.map((store) => store.terminate()),
  ]);
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
