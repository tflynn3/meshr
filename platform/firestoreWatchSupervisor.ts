/**
 * Keeps a Firestore `onSnapshot` listener attached to its query.
 *
 * Firestore retries ordinary stream failures, but a terminal listener error
 * (for example a repaired IAM or control-plane failure) does not recreate the
 * callback. This supervisor owns that lifecycle so a projection can recover
 * without a pod restart while keeping readiness honest. Every callback is
 * fenced by a generation, which prevents a late event from a retired listener
 * from dirtying the replacement.
 */

export type FirestoreWatchStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "reconnecting";

export interface FirestoreWatchState {
  name: string;
  status: FirestoreWatchStatus;
  reconnectAttempt: number;
}

export interface FirestoreWatchSupervisorOptions<Snapshot> {
  name: string;
  create: (
    onSnapshot: (snapshot: Snapshot) => void,
    onError: (error: unknown) => void,
  ) => () => void;
  onSnapshot: (snapshot: Snapshot) => void;
  onError?: (error: unknown) => void;
  onStateChange?: (state: FirestoreWatchState) => void;
  shouldReconnect?: () => boolean;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  random?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

// Keep the server-side replacement inside the live client's reconnect budget:
// the browser backs off up to 3.2 seconds, leaving room for a fresh listener,
// authorization, and the WebSocket handshake before the five-second gate.
export const FIRESTORE_WATCH_RECONNECT_BASE_MS = 250;
export const FIRESTORE_WATCH_RECONNECT_MAX_MS = 750;

type Timer = ReturnType<typeof globalThis.setTimeout>;
type Unsubscribe = () => void;

interface ActiveWatch {
  generation: number;
  active: boolean;
  unsubscribe?: Unsubscribe;
}

const unref = (timer: Timer): void => {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
};

export class FirestoreWatchSupervisor<Snapshot> {
  private readonly name: string;
  private readonly create: FirestoreWatchSupervisorOptions<Snapshot>["create"];
  private readonly onSnapshot: (snapshot: Snapshot) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly onStateChange?: (state: FirestoreWatchState) => void;
  private readonly shouldReconnect: () => boolean;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly random: () => number;
  private readonly scheduleTimeout: typeof globalThis.setTimeout;
  private readonly cancelTimeout: typeof globalThis.clearTimeout;

  private current: ActiveWatch | undefined;
  private reconnectTimer: Timer | undefined;
  private generation = 0;
  private reconnectAttempt = 0;
  private started = false;
  private ready = false;
  private statusValue: FirestoreWatchStatus = "stopped";

  constructor(options: FirestoreWatchSupervisorOptions<Snapshot>) {
    this.name = options.name;
    this.create = options.create;
    this.onSnapshot = options.onSnapshot;
    this.onError = options.onError;
    this.onStateChange = options.onStateChange;
    this.shouldReconnect = options.shouldReconnect ?? (() => true);
    this.reconnectBaseMs = options.reconnectBaseMs ?? FIRESTORE_WATCH_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? FIRESTORE_WATCH_RECONNECT_MAX_MS;
    this.random = options.random ?? Math.random;
    this.scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    if (!Number.isFinite(this.reconnectBaseMs) || this.reconnectBaseMs <= 0) {
      throw new Error("reconnectBaseMs must be positive");
    }
    if (!Number.isFinite(this.reconnectMaxMs) || this.reconnectMaxMs < this.reconnectBaseMs) {
      throw new Error("reconnectMaxMs must be at least reconnectBaseMs");
    }
  }

  get status(): FirestoreWatchStatus {
    return this.statusValue;
  }

  get isReady(): boolean {
    return this.ready && this.statusValue === "ready" && this.current?.active === true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.ready = false;
    this.reconnectAttempt = 0;
    this.statusValue = "starting";
    this.emitState();
    this.attach();
  }

  stop(): void {
    this.started = false;
    this.ready = false;
    this.statusValue = "stopped";
    this.emitState();
    this.clearReconnectTimer();
    const current = this.current;
    this.current = undefined;
    this.generation += 1;
    if (!current) return;
    current.active = false;
    this.unsubscribe(current);
  }

  private emitState(): void {
    this.onStateChange?.({
      name: this.name,
      status: this.status,
      reconnectAttempt: this.reconnectAttempt,
    });
  }

  private attach(): void {
    if (!this.started) return;
    const generation = ++this.generation;
    const current: ActiveWatch = { generation, active: true };
    this.current = current;
    try {
      const unsubscribe = this.create(
        (snapshot) => this.handleSnapshot(generation, current, snapshot),
        (error) => this.handleFailure(generation, current, error),
      );
      // A listener can report a synchronous terminal error while it is being
      // created. Retire that object before accepting its unsubscribe handle.
      if (!current.active || !this.started || this.current !== current) {
        try {
          unsubscribe();
        } catch (error) {
          this.onError?.(error);
        }
        return;
      }
      current.unsubscribe = unsubscribe;
    } catch (error) {
      this.handleFailure(generation, current, error);
    }
  }

  private handleSnapshot(
    generation: number,
    current: ActiveWatch,
    snapshot: Snapshot,
  ): void {
    if (!this.isCurrent(generation, current)) return;
    if (!this.ready) {
      this.ready = true;
      this.reconnectAttempt = 0;
      this.statusValue = "ready";
      this.emitState();
    }
    this.onSnapshot(snapshot);
  }

  private handleFailure(
    generation: number,
    current: ActiveWatch,
    error: unknown,
  ): void {
    if (!this.isCurrent(generation, current)) return;
    current.active = false;
    this.current = undefined;
    this.ready = false;
    this.statusValue = "reconnecting";
    this.emitState();
    this.unsubscribe(current);
    this.onError?.(error);
    this.scheduleReconnect();
  }

  private isCurrent(generation: number, current: ActiveWatch): boolean {
    return this.started && current.active && generation === this.generation && this.current === current;
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== undefined) return;
    if (!this.shouldReconnect()) {
      this.stop();
      return;
    }
    const exponent = Math.min(this.reconnectAttempt, 6);
    const base = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** exponent);
    const jitter = 0.75 + Math.min(1, Math.max(0, this.random())) * 0.5;
    const delay = Math.max(1, Math.round(Math.min(this.reconnectMaxMs, base * jitter)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.started) return;
      if (!this.shouldReconnect()) {
        this.stop();
        return;
      }
      this.statusValue = "starting";
      this.emitState();
      this.attach();
    }, delay);
    unref(this.reconnectTimer);
  }

  private unsubscribe(current: ActiveWatch): void {
    const unsubscribe = current.unsubscribe;
    current.unsubscribe = undefined;
    if (!unsubscribe) return;
    try {
      unsubscribe();
    } catch (error) {
      this.onError?.(error);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    this.cancelTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }
}
