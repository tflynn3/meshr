import { Firestore } from "@google-cloud/firestore";
import { PubSub } from "@google-cloud/pubsub";

export interface EventPlaneConfig {
  projectId: string;
  topicName: string;
  subscriptionName: string;
}

export function eventPlaneConfig(): EventPlaneConfig {
  return {
    projectId: process.env.GOOGLE_CLOUD_PROJECT?.trim() || "meshr-local",
    topicName: process.env.MESHR_EVENTS_TOPIC?.trim() || "mesh-events",
    subscriptionName:
      process.env.MESHR_TOPOLOGY_SUBSCRIPTION?.trim() || "topology-materializer",
  };
}

export function createFirestore(projectId: string): Firestore {
  return new Firestore({ projectId });
}

export function createPubSub(projectId: string): PubSub {
  return new PubSub({ projectId });
}
