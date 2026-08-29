import { createFirestore, createPubSub, eventPlaneConfig } from "./googleClients.ts";

export async function bootstrapEventPlane(): Promise<void> {
  const config = eventPlaneConfig();
  const firestore = createFirestore(config.projectId, config.databaseId);
  const pubsub = createPubSub(config.projectId);
  const topic = pubsub.topic(config.topicName, { messageOrdering: true });
  const [topicExists] = await topic.exists();
  if (!topicExists) await pubsub.createTopic(config.topicName);
  const deadLetter = pubsub.topic(config.deadLetterTopic);
  const [deadLetterExists] = await deadLetter.exists();
  if (!deadLetterExists) await pubsub.createTopic(config.deadLetterTopic);

  const moderationScreeningTopic = pubsub.topic(config.moderationScreeningTopic, {
    messageOrdering: true,
  });
  const [moderationScreeningTopicExists] = await moderationScreeningTopic.exists();
  if (!moderationScreeningTopicExists) await pubsub.createTopic(config.moderationScreeningTopic);

  for (const [consumer, subscriptionName] of Object.entries(config.subscriptions)) {
    const sourceTopic = consumer === "moderationScreening" ? moderationScreeningTopic : topic;
    const subscription = sourceTopic.subscription(subscriptionName);
    const [subscriptionExists] = await subscription.exists();
    if (!subscriptionExists) {
      await sourceTopic.createSubscription(subscriptionName, {
        enableMessageOrdering: true,
        ackDeadlineSeconds: 30,
        messageRetentionDuration: { seconds: 86_400 },
      });
    }
  }

  await firestore.collection("local_stack").doc("event_plane").set(
    {
      project_id: config.projectId,
      topic: config.topicName,
      moderation_screening_topic: config.moderationScreeningTopic,
      topology_subscription: config.subscriptions.topology,
      subscriptions: config.subscriptions,
      dead_letter_topic: config.deadLetterTopic,
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
