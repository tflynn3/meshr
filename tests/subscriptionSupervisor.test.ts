import assert from "node:assert/strict";
import test from "node:test";
import {
  SubscriptionSupervisor,
  type ManagedSubscription,
} from "../platform/subscriptionSupervisor.ts";

type TestMessage = { id: string };

class FakeSubscription implements ManagedSubscription<TestMessage> {
  isOpen = false;
  closeCount = 0;
  private readonly listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: "message" | "error" | "close", listener: (...args: any[]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    if (event === "message") this.isOpen = true;
    return this;
  }

  removeListener(event: "message" | "error" | "close", listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: "message" | "error" | "close", value?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      if (event === "message") listener(value as TestMessage);
      else if (event === "error") listener(value);
      else listener();
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.isOpen = false;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("reopens a terminally closed subscriber and reports readiness honestly", async () => {
  const subscriptions: FakeSubscription[] = [];
  const messages: TestMessage[] = [];
  const states: string[] = [];
  const supervisor = new SubscriptionSupervisor<TestMessage>({
    name: "topology-materializer",
    create: () => {
      const subscription = new FakeSubscription();
      subscriptions.push(subscription);
      return subscription;
    },
    onMessage: (message) => messages.push(message),
    onStateChange: (state) => states.push(state.status),
    reconnectBaseMs: 2,
    reconnectMaxMs: 10,
    random: () => 0.5,
  });

  supervisor.start();
  assert.equal(subscriptions.length, 1);
  assert.equal(supervisor.isReady, true);
  assert.equal(supervisor.status, "ready");

  subscriptions[0]!.emit("close");
  assert.equal(supervisor.isReady, false);
  assert.equal(supervisor.status, "reconnecting");
  assert.equal(subscriptions[0]!.closeCount, 0, "a terminal close is already closed");

  await wait(8);
  assert.equal(subscriptions.length, 2);
  assert.equal(supervisor.isReady, true);
  assert.equal(supervisor.status, "ready");
  subscriptions[1]!.emit("message", { id: "event-1" });
  assert.deepEqual(messages, [{ id: "event-1" }]);
  assert.deepEqual(states.slice(0, 4), ["starting", "ready", "reconnecting", "starting"]);

  await supervisor.stop();
  assert.equal(supervisor.isReady, false);
  assert.equal(supervisor.status, "stopped");
  assert.equal(subscriptions[1]!.closeCount, 1);
});

test("replaces a subscriber after an error and ignores stale terminal events", async () => {
  const subscriptions: FakeSubscription[] = [];
  let errors = 0;
  const supervisor = new SubscriptionSupervisor<TestMessage>({
    name: "audit-worker",
    create: () => {
      const subscription = new FakeSubscription();
      subscriptions.push(subscription);
      return subscription;
    },
    onMessage: () => undefined,
    onError: () => {
      errors += 1;
    },
    reconnectBaseMs: 2,
    reconnectMaxMs: 10,
    random: () => 0,
  });

  supervisor.start();
  subscriptions[0]!.emit("error", new Error("permission restored"));
  assert.equal(supervisor.isReady, false);
  assert.equal(subscriptions[0]!.closeCount, 1);
  await wait(8);
  assert.equal(subscriptions.length, 2);
  assert.equal(supervisor.isReady, true);

  // The old object can still emit a late close from its stream teardown. It
  // must not take the replacement back out of service or schedule a second
  // replacement.
  subscriptions[0]!.emit("close");
  await wait(4);
  assert.equal(subscriptions.length, 2);
  assert.equal(supervisor.isReady, true);
  assert.equal(errors, 1);
  await supervisor.stop();
});
