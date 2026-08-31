import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRESTORE_WATCH_RECONNECT_MAX_MS,
  FirestoreWatchSupervisor,
  type FirestoreWatchState,
} from "../platform/firestoreWatchSupervisor.ts";

type TestSnapshot = { revision: number };

class FakeWatch {
  private readonly onSnapshot: (snapshot: TestSnapshot) => void;
  private readonly onError: (error: unknown) => void;
  unsubscribeCount = 0;

  constructor(
    onSnapshot: (snapshot: TestSnapshot) => void,
    onError: (error: unknown) => void,
  ) {
    this.onSnapshot = onSnapshot;
    this.onError = onError;
  }

  emitSnapshot(snapshot: TestSnapshot): void {
    this.onSnapshot(snapshot);
  }

  emitError(error: unknown): void {
    this.onError(error);
  }

  unsubscribe(): void {
    this.unsubscribeCount += 1;
  }
}

interface FakeTimer {
  callback: () => void;
  cancelled: boolean;
  unref(): void;
}

class FakeScheduler {
  private readonly timers: FakeTimer[] = [];
  readonly delays: number[] = [];

  readonly setTimeout = ((callback: (...args: any[]) => void, delay = 0) => {
    const timer: FakeTimer = {
      callback: () => callback(),
      cancelled: false,
      unref: () => undefined,
    };
    this.delays.push(delay);
    this.timers.push(timer);
    return timer as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;

  readonly clearTimeout = ((timer: ReturnType<typeof globalThis.setTimeout>) => {
    (timer as unknown as FakeTimer).cancelled = true;
  }) as typeof globalThis.clearTimeout;

  get pending(): number {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }

  runNext(): void {
    const timer = this.timers.shift();
    if (!timer) throw new Error("no scheduled timer");
    if (timer.cancelled) {
      this.runNext();
      return;
    }
    timer.callback();
  }
}

test("replaces a terminal Firestore watch after recovery and fences stale callbacks", () => {
  const watches: FakeWatch[] = [];
  const snapshots: TestSnapshot[] = [];
  const errors: unknown[] = [];
  const states: FirestoreWatchState[] = [];
  const scheduler = new FakeScheduler();
  const supervisor = new FirestoreWatchSupervisor<TestSnapshot>({
    name: "topology:math",
    create: (onSnapshot, onError) => {
      const watch = new FakeWatch(onSnapshot, onError);
      watches.push(watch);
      return () => watch.unsubscribe();
    },
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onError: (error) => errors.push(error),
    onStateChange: (state) => states.push(state),
    reconnectBaseMs: 2,
    reconnectMaxMs: 10,
    random: () => 0,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });

  supervisor.start();
  assert.equal(supervisor.status, "starting");
  assert.equal(supervisor.isReady, false);
  assert.equal(watches.length, 1);

  watches[0]!.emitSnapshot({ revision: 1 });
  assert.equal(supervisor.status, "ready");
  assert.equal(supervisor.isReady, true);
  assert.deepEqual(snapshots, [{ revision: 1 }]);

  const terminalError = new Error("permission restored");
  watches[0]!.emitError(terminalError);
  assert.equal(supervisor.status, "reconnecting");
  assert.equal(supervisor.isReady, false);
  assert.equal(watches[0]!.unsubscribeCount, 1);
  assert.deepEqual(errors, [terminalError]);

  assert.equal(scheduler.pending, 1);
  assert.deepEqual(scheduler.delays, [2]);
  scheduler.runNext();
  assert.equal(watches.length, 2);
  assert.equal(supervisor.status, "starting");
  assert.equal(supervisor.isReady, false);

  // A recovery listener is not ready until its first snapshot. A stale event
  // from the retired listener must not make it ready or mutate projection data.
  watches[0]!.emitSnapshot({ revision: 99 });
  assert.equal(supervisor.isReady, false);
  assert.deepEqual(snapshots, [{ revision: 1 }]);

  watches[1]!.emitSnapshot({ revision: 2 });
  assert.equal(supervisor.status, "ready");
  assert.equal(supervisor.isReady, true);
  assert.deepEqual(snapshots, [{ revision: 1 }, { revision: 2 }]);

  // A late terminal callback from the old stream is ignored as well.
  watches[0]!.emitError(new Error("late old error"));
  assert.equal(watches.length, 2);
  assert.equal(supervisor.isReady, true);
  assert.equal(errors.length, 1);

  supervisor.stop();
  assert.equal(supervisor.status, "stopped");
  assert.equal(supervisor.isReady, false);
  assert.equal(watches[1]!.unsubscribeCount, 1);
  assert.deepEqual(states.map((state) => state.status), [
    "starting",
    "ready",
    "reconnecting",
    "starting",
    "ready",
    "stopped",
  ]);
});

test("stops instead of reconnecting when the watch owner no longer needs it", () => {
  const watches: FakeWatch[] = [];
  let shouldReconnect = true;
  const scheduler = new FakeScheduler();
  const supervisor = new FirestoreWatchSupervisor<TestSnapshot>({
    name: "topology:temporary",
    create: (onSnapshot, onError) => {
      const watch = new FakeWatch(onSnapshot, onError);
      watches.push(watch);
      return () => watch.unsubscribe();
    },
    onSnapshot: () => undefined,
    shouldReconnect: () => shouldReconnect,
    reconnectBaseMs: 2,
    reconnectMaxMs: 10,
    random: () => 0,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });

  supervisor.start();
  watches[0]!.emitSnapshot({ revision: 1 });
  shouldReconnect = false;
  watches[0]!.emitError(new Error("no subscribers"));
  assert.equal(supervisor.status, "stopped");
  assert.equal(supervisor.isReady, false);
  assert.equal(watches.length, 1);
  assert.equal(watches[0]!.unsubscribeCount, 1);
  assert.equal(scheduler.pending, 0);
});

test("keeps the default watch retry delay inside the live reconnect budget", () => {
  const watches: FakeWatch[] = [];
  const scheduler = new FakeScheduler();
  const supervisor = new FirestoreWatchSupervisor<TestSnapshot>({
    name: "live-access",
    create: (onSnapshot, onError) => {
      const watch = new FakeWatch(onSnapshot, onError);
      watches.push(watch);
      return () => watch.unsubscribe();
    },
    onSnapshot: () => undefined,
    random: () => 1,
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
  });

  supervisor.start();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    watches[attempt]!.emitError(new Error("temporary Firestore outage"));
    scheduler.runNext();
  }

  assert.equal(watches.length, 9);
  assert.ok(scheduler.delays.every((delay) => delay <= FIRESTORE_WATCH_RECONNECT_MAX_MS));
  assert.equal(Math.max(...scheduler.delays), FIRESTORE_WATCH_RECONNECT_MAX_MS);
  supervisor.stop();
});
