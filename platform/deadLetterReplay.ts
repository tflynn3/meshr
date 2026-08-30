import type { EventEnvelope } from "./eventEnvelope.ts";

export type ReplayEnvironment = "production" | "canary";
export type ReplayRoute = "events" | "moderation-screening";

export interface DeadLetterTarget {
  deadLetterSubscription: string;
  /** The authoritative Firestore database for an outbox replay in this environment. */
  authorityDatabase: string;
  eventTopic: string;
  screeningTopic: string;
  screeningSubscription: string;
  eventSourceSubscriptions: readonly string[];
  auditDatabase: string;
}

export const DEAD_LETTER_TARGETS: Record<ReplayEnvironment, DeadLetterTarget> = {
  production: {
    deadLetterSubscription: "mesh-events-dlq-replay",
    authorityDatabase: "(default)",
    eventTopic: "mesh-events",
    screeningTopic: "moderation-screening",
    screeningSubscription: "moderation-screening-worker",
    eventSourceSubscriptions: [
      "topology-materializer",
      "moderation-worker",
      "audit-worker",
      "notification-worker",
    ],
    auditDatabase: "meshr-release-audit",
  },
  canary: {
    deadLetterSubscription: "mesh-events-canary-dlq-replay",
    authorityDatabase: "meshr-canary",
    eventTopic: "mesh-events-canary",
    screeningTopic: "moderation-screening-canary",
    screeningSubscription: "moderation-screening-worker-canary",
    eventSourceSubscriptions: [
      "topology-materializer-canary",
      "moderation-worker-canary",
      "audit-worker-canary",
      "notification-worker-canary",
    ],
    auditDatabase: "meshr-canary-release-audit",
  },
};

export interface ModerationScreeningJob {
  schema_version: 1;
  event_id: string;
  mesh_id: string | null;
  post_id: string;
}

const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export interface ReplaySelector {
  route: ReplayRoute;
  eventId: string;
  key: string;
}

/**
 * A reviewed replay selector must identify both the event contract and its ID.
 * Screening jobs intentionally reuse an event ID, so an ID by itself is not a
 * sufficient authorization for an apply run.
 */
export function parseReplaySelector(value: string): ReplaySelector {
  const trimmed = value.trim();
  const separator = trimmed.indexOf(":");
  const route = separator >= 0 ? trimmed.slice(0, separator) : "";
  const eventId = separator >= 0 ? trimmed.slice(separator + 1) : "";
  if (
    (route !== "events" && route !== "moderation-screening") ||
    !identifierPattern.test(eventId) ||
    eventId.includes(",")
  ) {
    throw new Error(
      `MESHR_REPLAY_EVENT_IDS must use route-qualified selectors (events:event_id or moderation-screening:event_id); received ${trimmed || "an empty selector"}.`,
    );
  }
  return { route, eventId, key: `${route}:${eventId}` };
}

export function parseReplaySelectors(raw: string): ReplaySelector[] {
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return values.map(parseReplaySelector);
}

/**
 * Pub/Sub normally supplies a short subscription ID. Accept its documented
 * fully-qualified form as well, but never accept an arbitrary project or path.
 */
export function normalizeSourceSubscription(value: unknown, projectId: string): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === trimmed.replace(/[^\x20-\x7E]/g, "")) {
    if (identifierPattern.test(trimmed)) return trimmed;
    const match = trimmed.match(/^projects\/([^/]+)\/subscriptions\/([A-Za-z0-9._:-]{1,128})$/);
    if (match?.[1] === projectId) return match[2];
  }
  return null;
}

export function classifyDeadLetterSource(
  attributes: Record<string, string> | undefined,
  target: DeadLetterTarget,
  projectId: string,
): ReplayRoute {
  const sourceProject = attributes?.CloudPubSubDeadLetterSourceSubscriptionProject;
  if (sourceProject !== projectId) {
    throw new Error(
      "DLQ message is missing a matching CloudPubSubDeadLetterSourceSubscriptionProject attribute.",
    );
  }
  const sourceSubscription = normalizeSourceSubscription(
    attributes?.CloudPubSubDeadLetterSourceSubscription,
    projectId,
  );
  if (!sourceSubscription) {
    throw new Error(
      "DLQ message is missing a valid CloudPubSubDeadLetterSourceSubscription attribute.",
    );
  }
  if (sourceSubscription === target.screeningSubscription) return "moderation-screening";
  if (target.eventSourceSubscriptions.includes(sourceSubscription)) return "events";
  throw new Error(`DLQ message came from an unsupported source subscription: ${sourceSubscription}`);
}

export function parseModerationScreeningJob(input: unknown): ModerationScreeningJob {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SyntaxError("invalid moderation screening job");
  }
  const value = input as Record<string, unknown>;
  const eventId = typeof value.event_id === "string" ? value.event_id : "";
  const postId = typeof value.post_id === "string" ? value.post_id : "";
  const meshId = value.mesh_id === null || typeof value.mesh_id === "string" ? value.mesh_id : undefined;
  if (
    value.schema_version !== 1 ||
    !identifierPattern.test(eventId) ||
    !identifierPattern.test(postId) ||
    (meshId !== null && (typeof meshId !== "string" || !identifierPattern.test(meshId)))
  ) {
    throw new SyntaxError("invalid moderation screening job");
  }
  return {
    schema_version: 1,
    event_id: eventId,
    mesh_id: meshId as string | null,
    post_id: postId,
  };
}

export interface ReplayableMessage {
  route: ReplayRoute;
  eventId: string;
  envelope?: EventEnvelope;
  screeningJob?: ModerationScreeningJob;
}

export function replayPayload(message: ReplayableMessage): string {
  if (message.route === "events" && message.envelope) return JSON.stringify(message.envelope);
  if (message.route === "moderation-screening" && message.screeningJob) {
    return JSON.stringify(message.screeningJob);
  }
  throw new Error("replay message has no payload for its route");
}
