import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";

export interface EventPlaneConfig {
  projectId: string;
  topicName: string;
  subscriptionName: string;
  subscriptions: {
    topology: string;
    moderation: string;
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
    topicName: process.env.MESHR_EVENTS_TOPIC?.trim() || "mesh-events",
    subscriptionName: topology,
    subscriptions: {
      topology,
      moderation: process.env.MESHR_MODERATION_SUBSCRIPTION?.trim() || "moderation-worker",
      audit: process.env.MESHR_AUDIT_SUBSCRIPTION?.trim() || "audit-worker",
      notifications:
        process.env.MESHR_NOTIFICATIONS_SUBSCRIPTION?.trim() || "notification-worker",
    },
    deadLetterTopic: process.env.MESHR_DEAD_LETTER_TOPIC?.trim() || "mesh-events-dlq",
  };
}

export function createFirestore(projectId: string): Firestore {
  return new Firestore({ projectId });
}

export function createPubSub(projectId: string): PubSub {
  return new PubSub({ projectId });
}
