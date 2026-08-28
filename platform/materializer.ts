import { createServer } from "node:http";
import { parseEventEnvelope } from "./eventEnvelope.ts";
import { createFirestore, createPubSub, eventPlaneConfig } from "./googleClients.ts";

const config = eventPlaneConfig();
const firestore = createFirestore(config.projectId);
const pubsub = createPubSub(config.projectId);
const subscription = pubsub.subscription(config.subscriptionName, {
  flowControl: { maxMessages: 50 },
});
const port = Number(process.env.MESHR_PORT ?? "8080");
const host = process.env.MESHR_HOST?.trim() || "0.0.0.0";

subscription.on("message", async (message) => {
  try {
    const envelope = parseEventEnvelope(JSON.parse(message.data.toString("utf8")) as unknown);
    const processed = firestore.collection("processed_events").doc(envelope.event_id);
    const topology = firestore.collection("topology_snapshots").doc(envelope.mesh_id);
    await firestore.runTransaction(async (transaction) => {
      const previous = await transaction.get(processed);
      if (previous.exists) return;
      const current = await transaction.get(topology);
      const revision = (current.get("revision") as number | undefined ?? 0) + 1;
      const eventCount = (current.get("event_count") as number | undefined ?? 0) + 1;
      transaction.create(processed, {
        mesh_id: envelope.mesh_id,
        processed_at: new Date().toISOString(),
        pubsub_message_id: message.id,
      });
      transaction.set(
        topology,
        {
          mesh_id: envelope.mesh_id,
          revision,
          event_count: eventCount,
          latest_event_id: envelope.event_id,
          latest_event_type: envelope.type,
          latest_agent_id: envelope.agent_id,
          latest_occurred_at: envelope.occurred_at,
          updated_at: new Date().toISOString(),
        },
        { merge: true },
      );
    });
    message.ack();
  } catch (error) {
    console.error("materialization failed", error);
    message.nack();
  }
});

subscription.on("error", (error) => console.error("subscription error", error));

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "topology-materializer" }));
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, host, () => console.log(`topology materializer listening on ${host}:${port}`));

async function shutdown(): Promise<void> {
  await subscription.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await Promise.all([pubsub.close(), firestore.terminate()]);
}

process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
