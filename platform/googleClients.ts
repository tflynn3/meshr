import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";

export interface EventPlaneConfig {
  projectId: string;
  databaseId: string;
  topologyDatabaseId: string;
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

export function eventPlaneConfig(): EventPlaneConfig {
  const topology =
    process.env.MESHR_TOPOLOGY_SUBSCRIPTION?.trim() || "topology-materializer";
  return {
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
