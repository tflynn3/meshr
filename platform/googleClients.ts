import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";

export interface EventPlaneConfig {
  projectId: string;
  databaseId: string;
  topologyDatabaseId: string;
  /** Delivery-trace database used only by the audit consumer. */
  auditDatabaseId: string;
  /** Notification outbox database used only by the notification consumer. */
  notificationsDatabaseId: string;
  topicName: string;
  moderationScreeningTopic: string;
  subscriptionName: string;
  subscriptions: {
    topology: string;
    moderation: string;
    moderationScreening: string;
    audit: string;
    notifications: string;
  };
  deadLetterTopic: string;
}

/**
 * Production deliberately keeps authority and topology in separate named
 * Firestore databases. IAM Conditions can scope a grant to a database, but
 * not to a collection or document path; accepting the same ID here would
 * collapse the API/live-gateway isolation boundary.
 */
export function assertSeparatedProductionDatabases(
  databaseId: string,
  topologyDatabaseId: string,
  environment = process.env.MESHR_ENV,
): void {
  if (environment?.trim().toLowerCase() !== "production") return;
  const authority = databaseId.trim();
  const topology = topologyDatabaseId.trim();
  if (!authority || !topology) {
    throw new Error("production Firestore authority and topology database IDs are required");
  }
  if (authority === topology) {
    throw new Error("production Firestore authority and topology databases must be distinct");
  }
}

/**
 * Keep every event-plane trust boundary in a distinct Firestore database in
 * production. Firestore IAM Conditions can scope a grant to a database, but
 * not to a collection or document path. Local emulators intentionally fall
 * back to one database so the all-in-one event-plane fixture stays cheap.
 */
export function assertSeparatedProductionEventPlaneDatabases(
  databaseId: string,
  topologyDatabaseId: string,
  auditDatabaseId: string,
  notificationsDatabaseId: string,
  environment = process.env.MESHR_ENV,
): void {
  if (environment?.trim().toLowerCase() !== "production") return;
  const ids = [
    databaseId.trim(),
    topologyDatabaseId.trim(),
    auditDatabaseId.trim(),
    notificationsDatabaseId.trim(),
  ];
  if (ids.some((id) => !id)) {
    throw new Error("production Firestore event-plane database IDs are required");
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("production Firestore authority, topology, audit, and notification databases must be distinct");
  }
}

export function eventPlaneConfig(): EventPlaneConfig {
  const topology =
    process.env.MESHR_TOPOLOGY_SUBSCRIPTION?.trim() || "topology-materializer";
  const config: EventPlaneConfig = {
    projectId: process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-local",
    databaseId: process.env.MESHR_FIRESTORE_DATABASE?.trim() || "(default)",
    // Topology is a bounded, aggregate-only read model. Production places it
    // in a separate Firestore database so the internet-facing live gateway
    // never receives IAM access to accounts, sessions, posts, or governance
    // records in the authoritative database.
    topologyDatabaseId:
      process.env.MESHR_TOPOLOGY_FIRESTORE_DATABASE?.trim() ||
      process.env.MESHR_FIRESTORE_DATABASE?.trim() ||
      "(default)",
    // Worker-owned delivery traces are isolated from the authority database
    // in production. Keeping the local fallback preserves the single-emulator
    // development workflow while production configuration remains explicit.
    auditDatabaseId:
      process.env.MESHR_EVENT_AUDIT_FIRESTORE_DATABASE?.trim() ||
      process.env.MESHR_FIRESTORE_DATABASE?.trim() ||
      "(default)",
    notificationsDatabaseId:
      process.env.MESHR_NOTIFICATIONS_FIRESTORE_DATABASE?.trim() ||
      process.env.MESHR_FIRESTORE_DATABASE?.trim() ||
      "(default)",
    topicName: process.env.MESHR_EVENTS_TOPIC?.trim() || "mesh-events",
    moderationScreeningTopic:
      process.env.MESHR_MODERATION_SCREENING_TOPIC?.trim() || "moderation-screening",
    subscriptionName: topology,
    subscriptions: {
      topology,
      moderation: process.env.MESHR_MODERATION_SUBSCRIPTION?.trim() || "moderation-worker",
      moderationScreening:
        process.env.MESHR_MODERATION_SCREENING_SUBSCRIPTION?.trim() || "moderation-screening-worker",
      audit: process.env.MESHR_AUDIT_SUBSCRIPTION?.trim() || "audit-worker",
      notifications:
        process.env.MESHR_NOTIFICATIONS_SUBSCRIPTION?.trim() || "notification-worker",
    },
    deadLetterTopic: process.env.MESHR_DEAD_LETTER_TOPIC?.trim() || "mesh-events-dlq",
  };
  assertSeparatedProductionEventPlaneDatabases(
    config.databaseId,
    config.topologyDatabaseId,
    config.auditDatabaseId,
    config.notificationsDatabaseId,
  );
  return config;
}

export function createFirestore(projectId: string, databaseId?: string): Firestore {
  return new Firestore({
    projectId,
    databaseId: databaseId?.trim() || process.env.MESHR_FIRESTORE_DATABASE?.trim() || "(default)",
  });
}

export function createPubSub(projectId: string): PubSub {
  return new PubSub({ projectId });
}
