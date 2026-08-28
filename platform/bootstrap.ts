import { createFirestore, createPubSub, eventPlaneConfig } from "./googleClients.ts";

export async function bootstrapEventPlane(): Promise<void> {
  const config = eventPlaneConfig();
  const firestore = createFirestore(config.projectId);
  const pubsub = createPubSub(config.projectId);
  const topic = pubsub.topic(config.topicName, { messageOrdering: true });
  const [topicExists] = await topic.exists();
  if (!topicExists) await pubsub.createTopic(config.topicName);

  const subscription = topic.subscription(config.subscriptionName);
  const [subscriptionExists] = await subscription.exists();
  if (!subscriptionExists) {
    await topic.createSubscription(config.subscriptionName, {
      enableMessageOrdering: true,
      ackDeadlineSeconds: 30,
      messageRetentionDuration: { seconds: 86_400 },
    });
  }

  await firestore.collection("local_stack").doc("event_plane").set(
    {
      project_id: config.projectId,
      topic: config.topicName,
      topology_subscription: config.subscriptionName,
      ready: true,
      updated_at: new Date().toISOString(),
    },
    { merge: true },
  );

  await Promise.all([pubsub.close(), firestore.terminate()]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bootstrapEventPlane().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
