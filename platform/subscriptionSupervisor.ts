/**
 * Keeps a Pub/Sub pull subscriber attached to its event stream.
 *
 * The Node Pub/Sub client retries ordinary stream failures, but a terminal
 * subscriber close (for example a repaired IAM or control-plane failure) does
 * not recreate the message listener. This supervisor owns that lifecycle so a
 * worker can recover without a pod restart while keeping readiness honest.
 */

export interface ManagedSubscription<Message> {
  readonly isOpen: boolean;
  on(event: "message", listener: (message: Message) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  removeListener(event: "message", listener: (message: Message) => void): this;
  removeListener(event: "error", listener: (error: unknown) => void): this;
  removeListener(event: "close", listener: () => void): this;
  close(): Promise<void>;
}

export type SubscriptionSupervisorStatus =
  | "stopped"
  | "starting"
  | "ready"
  | "reconnecting";

export interface SubscriptionSupervisorState {
  status: SubscriptionSupervisorStatus;
  reconnectAttempt: number;
}

export interface SubscriptionSupervisorOptions<Message> {
  name: string;
  create: () => ManagedSubscription<Message>;
  onMessage: (message: Message) => void;
  onError?: (error: unknown) => void;
  onStateChange?: (state: SubscriptionSupervisorState) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  openPollMs?: number;
  random?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

type Timer = ReturnType<typeof globalThis.setTimeout>;

interface SubscriptionHandlers<Message> {
  message: (message: Message) => void;
  error: (error: unknown) => void;
  close: () => void;
}

const unref = (timer: Timer): void => {
  if (typeof timer === "object" && timer !== null && "unref" in timer &&
      typeof timer.unref === "function") {
    timer.unref();
  }
};

export class SubscriptionSupervisor<Message> {
  private readonly name: string;
  private readonly create: () => ManagedSubscription<Message>;
  private readonly onMessage: (message: Message) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly onStateChange?: (state: SubscriptionSupervisorState) => void;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly openPollMs: number;
  private readonly random: () => number;
  private readonly scheduleTimeout: typeof globalThis.setTimeout;
  private readonly cancelTimeout: typeof globalThis.clearTimeout;

  private current: ManagedSubscription<Message> | undefined;
  private handlers: SubscriptionHandlers<Message> | undefined;
  private reconnectTimer: Timer | undefined;
  private openTimer: Timer | undefined;
  private generation = 0;
  private reconnectAttempt = 0;
  private started = false;
  private statusValue: SubscriptionSupervisorStatus = "stopped";

  constructor(options: SubscriptionSupervisorOptions<Message>) {
    this.name = options.name;
    this.create = options.create;
    this.onMessage = options.onMessage;
    this.onError = options.onError;
    this.onStateChange = options.onStateChange;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 250;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 10_000;
    this.openPollMs = options.openPollMs ?? 100;
    this.random = options.random ?? Math.random;
    this.scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    if (!Number.isFinite(this.reconnectBaseMs) || this.reconnectBaseMs <= 0) {
      throw new Error("reconnectBaseMs must be positive");
    }
    if (!Number.isFinite(this.reconnectMaxMs) || this.reconnectMaxMs < this.reconnectBaseMs) {
      throw new Error("reconnectMaxMs must be at least reconnectBaseMs");
    }
    if (!Number.isFinite(this.openPollMs) || this.openPollMs <= 0) {
      throw new Error("openPollMs must be positive");
    }
  }

  get status(): SubscriptionSupervisorStatus {
    if (this.statusValue === "ready" && !this.current?.isOpen) return "reconnecting";
    return this.statusValue;
  }

  get isReady(): boolean {
    return this.statusValue === "ready" && this.current?.isOpen === true;
  }

  get attempt(): number {
    return this.reconnectAttempt;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.statusValue = "starting";
    this.emitState();
    this.attach();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.statusValue = "stopped";
    this.emitState();
    this.clearReconnectTimer();
    this.clearOpenTimer();
    const current = this.current;
    this.current = undefined;
    this.generation += 1;
    if (!current) return;
    this.detach(current);
    try {
      await current.close();
    } catch (error) {
      this.onError?.(error);
    }
  }

  private emitState(): void {
    this.onStateChange?.({
      status: this.status,
      reconnectAttempt: this.reconnectAttempt,
    });
  }

  private attach(): void {
    if (!this.started) return;
    this.clearOpenTimer();
    const generation = ++this.generation;
    let subscription: ManagedSubscription<Message>;
    try {
      subscription = this.create();
    } catch (error) {
      this.handleFailure(generation, undefined, error, false);
      return;
    }
    this.current = subscription;
    const handlers: SubscriptionHandlers<Message> = {
      message: (message) => this.onMessage(message),
      error: (error) => this.handleFailure(generation, subscription, error, true),
      close: () => this.handleFailure(
        generation,
        subscription,
        new Error("subscription closed"),
        false,
      ),
    };
    this.handlers = handlers;
    try {
      // Attach terminal handlers before the message listener. Pub/Sub opens
      // the pull stream as soon as the first message listener is added.
      subscription.on("error", handlers.error);
      subscription.on("close", handlers.close);
      subscription.on("message", handlers.message);
    } catch (error) {
      // A client-version or configuration error while attaching listeners is
      // recoverable in the same way as a terminal stream error. Retire this
      // object and let the bounded reconnect path try a fresh subscriber.
      this.handleFailure(generation, subscription, error, true);
      return;
    }
    if (subscription.isOpen) {
      this.reconnectAttempt = 0;
      this.statusValue = "ready";
      this.emitState();
    } else {
      this.statusValue = "starting";
      this.emitState();
      this.pollForOpen(generation, subscription);
    }
  }

  private pollForOpen(
    generation: number,
    subscription: ManagedSubscription<Message>,
  ): void {
    if (!this.started || generation !== this.generation || this.current !== subscription) return;
    if (subscription.isOpen) {
      this.reconnectAttempt = 0;
      this.statusValue = "ready";
      this.emitState();
      return;
    }
    this.openTimer = this.scheduleTimeout(() => {
      this.openTimer = undefined;
      this.pollForOpen(generation, subscription);
    }, this.openPollMs);
    unref(this.openTimer);
  }

  private handleFailure(
    generation: number,
    subscription: ManagedSubscription<Message> | undefined,
    error: unknown,
    closeSubscription: boolean,
  ): void {
    if (!this.started || generation !== this.generation ||
        (subscription && this.current !== subscription)) return;
    this.onError?.(error);
    this.statusValue = "reconnecting";
    this.emitState();
    this.clearOpenTimer();
    if (subscription && this.current === subscription) {
      this.current = undefined;
      this.detach(subscription);
      if (closeSubscription) {
        void subscription.close().catch((closeError: unknown) => this.onError?.(closeError));
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== undefined) return;
    const exponent = Math.min(this.reconnectAttempt, 6);
    const base = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** exponent);
    const jitter = 0.75 + Math.min(1, Math.max(0, this.random())) * 0.5;
    const delay = Math.max(1, Math.round(Math.min(this.reconnectMaxMs, base * jitter)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.scheduleTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.started) return;
      this.statusValue = "starting";
      this.emitState();
      this.attach();
    }, delay);
    unref(this.reconnectTimer);
  }

  private detach(subscription: ManagedSubscription<Message>): void {
    const handlers = this.handlers;
    if (!handlers) return;
    subscription.removeListener("message", handlers.message);
    subscription.removeListener("error", handlers.error);
    subscription.removeListener("close", handlers.close);
    this.handlers = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return;
    this.cancelTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearOpenTimer(): void {
    if (this.openTimer === undefined) return;
    this.cancelTimeout(this.openTimer);
    this.openTimer = undefined;
  }
}
