import { randomUUID, sign } from "node:crypto";
import { appendFile, chmod, open, readFile, stat, writeFile } from "node:fs/promises";
import { WebSocket } from "ws";
import type {
  HistogramSummary,
  LoadAgentFixture,
  LoadFixture,
  LoadRehearsalEvidence,
  LoadRehearsalOptions,
  LoadViewerFixture,
} from "./types.ts";

const TARGET = {
  agents: 100,
  viewers: 500,
  postRate: 100,
  durationSeconds: 1_800,
} as const;

const RUNTIME_SESSION_SECONDS = 15 * 60;
const HEARTBEAT_SECONDS = 30;
// A 30-minute, 500-viewer run can produce tens of millions of identical
// topology observations. Keep the evidence bounded while still requiring
// every viewer to observe at least one accepted post-driven update.
const MAX_TOPOLOGY_SAMPLES = 250_000;
const MAX_ACCEPTED_POST_INDEX = 50_000;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]!);
}

export function summarizeHistogram(values: number[]): HistogramSummary {
  let maxMs: number | null = null;
  for (const value of values) {
    if (maxMs === null || value > maxMs) maxMs = value;
  }
  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: maxMs === null ? null : Math.round(maxMs),
  };
}

function trim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertLoopbackOrHttps(name: string, value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name}_invalid`);
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`${name}_must_use_https_or_loopback_http`);
  }
  if (parsed.username || parsed.password || parsed.hash) throw new Error(`${name}_invalid`);
  return parsed;
}

function assertLiveUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("live_url_invalid");
  }
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") throw new Error("live_url_must_use_ws");
  if (parsed.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)) {
    throw new Error("live_url_must_use_wss_or_loopback_ws");
  }
  if (parsed.username || parsed.password || parsed.hash) throw new Error("live_url_invalid");
  return parsed;
}

function nonEmpty(name: string, value: unknown): string {
  const normalized = trim(value);
  if (!normalized || normalized.length > 4_096) throw new Error(`${name}_invalid`);
  return normalized;
}

function validateFixture(value: unknown): LoadFixture {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture_invalid");
  const input = value as Record<string, unknown>;
  const baseUrl = nonEmpty("base_url", input.baseUrl);
  assertLoopbackOrHttps("base_url", baseUrl);
  const meshId = nonEmpty("mesh_id", input.meshId);
  const topicId = nonEmpty("topic_id", input.topicId);
  if (!Array.isArray(input.agents)) throw new Error("agents_required");
  if (!Array.isArray(input.viewers)) throw new Error("viewers_required");
  const agents: LoadAgentFixture[] = input.agents.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`agent_${index}_invalid`);
    const agent = raw as Record<string, unknown>;
    const agentId = nonEmpty(`agent_${index}_id`, agent.agentId);
    const token = nonEmpty(`agent_${index}_token`, agent.token);
    if (!/^Bearer\s+/i.test(token)) throw new Error(`agent_${index}_token_must_be_bearer`);
    const renewalFields = ["pairingId", "pairingSecret", "privateKeyPem", "sessionId"] as const;
    const hasRenewalField = renewalFields.some((field) => agent[field] !== undefined);
    if (hasRenewalField && renewalFields.some((field) => agent[field] === undefined)) {
      throw new Error(`agent_${index}_renewal_credentials_incomplete`);
    }
    const tokenExpiresAt = agent.tokenExpiresAt === undefined
      ? undefined
      : nonEmpty(`agent_${index}_token_expires_at`, agent.tokenExpiresAt);
    if (tokenExpiresAt !== undefined && !Number.isFinite(Date.parse(tokenExpiresAt))) {
      throw new Error(`agent_${index}_token_expires_at_invalid`);
    }
    return {
      agentId,
      token,
      ...(agent.pairingId === undefined ? {} : { pairingId: nonEmpty(`agent_${index}_pairing_id`, agent.pairingId) }),
      ...(agent.pairingSecret === undefined ? {} : { pairingSecret: nonEmpty(`agent_${index}_pairing_secret`, agent.pairingSecret) }),
      ...(agent.privateKeyPem === undefined ? {} : { privateKeyPem: nonEmpty(`agent_${index}_private_key_pem`, agent.privateKeyPem) }),
      ...(agent.sessionId === undefined ? {} : { sessionId: nonEmpty(`agent_${index}_session_id`, agent.sessionId) }),
      ...(tokenExpiresAt === undefined ? {} : { tokenExpiresAt }),
      ...(agent.meshId === undefined ? {} : { meshId: nonEmpty(`agent_${index}_mesh_id`, agent.meshId) }),
      ...(agent.topicId === undefined ? {} : { topicId: nonEmpty(`agent_${index}_topic_id`, agent.topicId) }),
    };
  });
  const agentIds = new Set(agents.map((agent) => agent.agentId));
  if (agentIds.size !== agents.length) throw new Error("agent_ids_must_be_unique");
  const viewers: LoadViewerFixture[] = input.viewers.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`viewer_${index}_invalid`);
    const viewer = raw as Record<string, unknown>;
    for (const field of Object.keys(viewer)) {
      if (field !== "cookie" && field !== "authorization") {
        throw new Error(`viewer_${index}_${field}_unsupported`);
      }
    }
    const cookie = nonEmpty(`viewer_${index}_cookie`, viewer.cookie);
    if (!/(^|;\s*)meshr_session=/i.test(cookie)) throw new Error(`viewer_${index}_cookie_missing_meshr_session`);
    return {
      cookie,
      ...(viewer.authorization === undefined ? {} : { authorization: nonEmpty(`viewer_${index}_authorization`, viewer.authorization) }),
    };
  });
  const liveUrl = input.liveUrl === undefined
    ? undefined
    : assertLiveUrl(nonEmpty("live_url", input.liveUrl)).toString();
  return {
    contractVersion: 1,
    baseUrl,
    ...(liveUrl ? { liveUrl } : {}),
    meshId,
    topicId,
    agents,
    viewers,
  };
}

export async function readLoadFixture(path: string): Promise<LoadFixture> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("fixture_must_be_a_file");
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("fixture_permissions_must_be_0600");
  }
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents, "utf8") > 2 * 1024 * 1024) throw new Error("fixture_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("fixture_json_invalid");
  }
  return validateFixture(parsed);
}

function expectedShape(options: LoadRehearsalOptions, fixture: LoadFixture): boolean {
  const agentShape = options.workerRole === "viewer"
    ? fixture.agents.length === 0 && options.totalAgentCount === TARGET.agents
    : fixture.agents.length === TARGET.agents && options.totalAgentCount === TARGET.agents;
  const viewerShape = options.workerRole === "combined"
    ? options.viewerCount === TARGET.viewers
    : options.workerRole === "writer"
      ? options.viewerCount === 0
      : options.viewerCount >= 1 && options.viewerCount <= TARGET.viewers;
  return agentShape &&
    viewerShape &&
    options.totalViewerCount === TARGET.viewers &&
    options.postRate === TARGET.postRate &&
    options.durationSeconds === TARGET.durationSeconds;
}

interface MutableRunState {
  writeLatencies: number[];
  topologyLatencies: number[];
  topologyLatencyObservations: number;
  reconnectLatencies: number[];
  acceptedPostsById: Map<string, { acceptedAt: number; ordinal: number }>;
  eventFeed?: AcceptedEventFeed;
  statusCounts: Record<string, number>;
  writeAttempts: number;
  acceptedPosts: number;
  writeErrors: number;
  sessionHeartbeats: number;
  sessionRenewals: number;
  sessionErrors: number;
  viewerConnectAttempts: number;
  viewerConnections: number;
  viewerInitialConnections: number;
  viewerConnectionErrors: number;
  viewerFrames: number;
  viewerSnapshotReceipts: number;
  viewerTopologyObservations: number;
  viewerPostUpdateReceipts: Set<number>;
  viewerPostUpdateBuckets: Map<number, Set<number>>;
  viewerProcessingErrors: number;
  reconnectAttempts: number;
  reconnects: number;
  viewerReconnectReceipts: Set<number>;
  reconnectErrors: number;
  clockOffsetMs: number | null;
  writePhaseStartedAtMs?: number;
  writePhaseFinishedAtMs?: number;
  stopping: boolean;
}

function newState(): MutableRunState {
  return {
    writeLatencies: [],
    topologyLatencies: [],
    topologyLatencyObservations: 0,
    reconnectLatencies: [],
    acceptedPostsById: new Map(),
    eventFeed: undefined,
    statusCounts: {},
    writeAttempts: 0,
    acceptedPosts: 0,
    writeErrors: 0,
    sessionHeartbeats: 0,
    sessionRenewals: 0,
    sessionErrors: 0,
    viewerConnectAttempts: 0,
    viewerConnections: 0,
    viewerInitialConnections: 0,
    viewerConnectionErrors: 0,
    viewerFrames: 0,
    viewerSnapshotReceipts: 0,
    viewerTopologyObservations: 0,
    viewerPostUpdateReceipts: new Set(),
    viewerPostUpdateBuckets: new Map(),
    viewerProcessingErrors: 0,
    reconnectAttempts: 0,
    reconnects: 0,
    viewerReconnectReceipts: new Set(),
    reconnectErrors: 0,
    clockOffsetMs: null,
    writePhaseStartedAtMs: undefined,
    writePhaseFinishedAtMs: undefined,
    stopping: false,
  };
}

function countStatus(state: MutableRunState, status: number | "network_error"): void {
  const key = String(status);
  state.statusCounts[key] = (state.statusCounts[key] ?? 0) + 1;
}

function recordTopologyLatency(state: MutableRunState, value: number): void {
  state.topologyLatencyObservations += 1;
  if (state.topologyLatencies.length < MAX_TOPOLOGY_SAMPLES) {
    state.topologyLatencies.push(value);
    return;
  }
  // Reservoir sampling keeps the bounded evidence representative across the
  // full rehearsal rather than measuring only the first few minutes.
  const replacement = Math.floor(Math.random() * state.topologyLatencyObservations);
  if (replacement < MAX_TOPOLOGY_SAMPLES) state.topologyLatencies[replacement] = value;
}

interface RuntimeAgent extends LoadAgentFixture {
  currentToken: string;
  currentSessionId?: string;
  currentExpiresAtMs?: number;
}

function renewalReady(agent: LoadAgentFixture): boolean {
  return Boolean(agent.pairingId && agent.pairingSecret && agent.privateKeyPem && agent.sessionId);
}

function responseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

interface AcceptedEvent {
  runId: string;
  postId: string;
  acceptedAt: number;
  ordinal: number;
}

/**
 * A small append-only index shared by a writer and viewer shards. It carries
 * only post ids and timings (never bodies or credentials), so topology
 * snapshots can be correlated across processes without trusting a guessed
 * global "latest write". The file is intentionally mode-0600 and is suitable
 * for a shared ephemeral volume used by a distributed rehearsal.
 */
export class AcceptedEventFeed {
  private offset = 0;
  private pending = "";
  private readonly events = new Map<string, AcceptedEvent>();
  private refreshWork: Promise<void> | undefined;

  private constructor(
    private readonly path: string,
    private readonly writer: boolean,
    private readonly runId: string,
  ) {}

  static async open(path: string, writer: boolean, runId: string): Promise<AcceptedEventFeed> {
    const feed = new AcceptedEventFeed(path, writer, runId);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error("event_feed_must_be_a_file");
      if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
        throw new Error("event_feed_permissions_must_be_0600");
      }
    } catch (error) {
      if (!writer || !(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
      await writeFile(path, "", { mode: 0o600 });
      await chmod(path, 0o600);
    }
    return feed;
  }

  async append(event: Omit<AcceptedEvent, "runId">): Promise<void> {
    if (!this.writer) throw new Error("event_feed_write_not_allowed");
    await appendFile(this.path, `${JSON.stringify({ runId: this.runId, ...event })}\n`, { mode: 0o600 });
  }

  async refresh(): Promise<void> {
    if (this.refreshWork) {
      await this.refreshWork;
      return;
    }
    const work = (async () => {
      const handle = await open(this.path, "r");
      try {
        const metadata = await handle.stat();
        if (metadata.size < this.offset) {
          this.offset = 0;
          this.pending = "";
          this.events.clear();
        }
        if (metadata.size === this.offset) return;
        const buffer = Buffer.alloc(metadata.size - this.offset);
        await handle.read(buffer, 0, buffer.length, this.offset);
        this.offset = metadata.size;
        const lines = `${this.pending}${buffer.toString("utf8")}`.split("\n");
        this.pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          let value: Partial<AcceptedEvent>;
          try {
            value = JSON.parse(line) as Partial<AcceptedEvent>;
          } catch {
            // A nonempty line ending in a newline is complete. Treat malformed
            // JSON as a processing failure instead of silently dropping it;
            // otherwise a corrupt shared feed could still satisfy coverage.
            throw new Error("event_feed_line_invalid_json");
          }
          if (
            value.runId !== this.runId ||
            typeof value.postId !== "string" || !value.postId ||
            typeof value.acceptedAt !== "number" || !Number.isFinite(value.acceptedAt) ||
            typeof value.ordinal !== "number" || !Number.isSafeInteger(value.ordinal)
          ) {
            throw new Error("event_feed_line_invalid_schema");
          }
          this.events.set(value.postId, {
            runId: value.runId,
            postId: value.postId,
            acceptedAt: value.acceptedAt,
            ordinal: value.ordinal,
          });
          while (this.events.size > MAX_ACCEPTED_POST_INDEX) {
            const oldest = this.events.keys().next().value;
            if (typeof oldest !== "string") break;
            this.events.delete(oldest);
          }
        }
      } finally {
        await handle.close();
      }
    })().finally(() => {
      if (this.refreshWork === work) this.refreshWork = undefined;
    });
    this.refreshWork = work;
    await work;
  }

  get(postId: string): AcceptedEvent | undefined {
    return this.events.get(postId);
  }
}

async function jsonRequest(
  url: string,
  options: {
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
  },
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { response, body };
}

async function heartbeatAgent(
  fixture: LoadFixture,
  agent: RuntimeAgent,
  state: MutableRunState,
  options: LoadRehearsalOptions,
): Promise<void> {
  try {
    const { response, body } = await jsonRequest(
      `${fixture.baseUrl.replace(/\/+$/, "")}/v1/agent-sessions/heartbeat`,
      {
        method: "POST",
        headers: {
          authorization: agent.currentToken,
          accept: "application/json",
          "x-meshr-contract-version": "1",
        },
        timeoutMs: options.requestTimeoutMs,
      },
    );
    if (!response.ok) throw new Error(`heartbeat_${response.status}`);
    const record = responseObject(body);
    const expiresAt = typeof record.expiresAt === "string" ? Date.parse(record.expiresAt) : NaN;
    if (Number.isFinite(expiresAt)) agent.currentExpiresAtMs = expiresAt;
    if (typeof record.sessionId === "string" && record.sessionId) agent.currentSessionId = record.sessionId;
    state.sessionHeartbeats += 1;
  } catch {
    state.sessionErrors += 1;
    throw new Error("agent_heartbeat_failed");
  }
}

async function renewAgent(
  fixture: LoadFixture,
  agent: RuntimeAgent,
  state: MutableRunState,
  options: LoadRehearsalOptions,
): Promise<void> {
  if (!renewalReady(agent) || !agent.currentSessionId) {
    state.sessionErrors += 1;
    throw new Error("agent_renewal_credentials_missing");
  }
  const baseUrl = fixture.baseUrl.replace(/\/+$/, "");
  const pairingId = agent.pairingId!;
  const pairingAuthorization = `Pairing ${agent.pairingSecret!}`;
  const challengeResult = await jsonRequest(
    `${baseUrl}/v1/pairings/${encodeURIComponent(pairingId)}/challenges`,
    {
      method: "POST",
      headers: {
        authorization: pairingAuthorization,
        accept: "application/json",
        "content-type": "application/json",
        "x-meshr-contract-version": "1",
      },
      body: { sessionId: agent.currentSessionId },
      timeoutMs: options.requestTimeoutMs,
    },
  );
  if (!challengeResult.response.ok) throw new Error("agent_renewal_challenge_failed");
  const challenge = responseObject(challengeResult.body);
  const challengeId = typeof challenge.challengeId === "string" ? challenge.challengeId : "";
  const message = typeof challenge.message === "string" ? challenge.message : "";
  if (!challengeId || !message) throw new Error("agent_renewal_challenge_invalid");
  const signature = sign(null, Buffer.from(message, "utf8"), agent.privateKeyPem!).toString("base64url");
  const renewalResult = await jsonRequest(`${baseUrl}/v1/agent-sessions/renew`, {
    method: "POST",
    headers: {
      authorization: pairingAuthorization,
      accept: "application/json",
      "content-type": "application/json",
      "x-meshr-contract-version": "1",
    },
    body: {
      pairingId,
      challengeId,
      sessionId: agent.currentSessionId,
      signature,
    },
    timeoutMs: options.requestTimeoutMs,
  });
  if (!renewalResult.response.ok) throw new Error("agent_renewal_failed");
  const renewed = responseObject(renewalResult.body);
  const token = typeof renewed.token === "string" ? renewed.token.trim() : "";
  const sessionId = typeof renewed.sessionId === "string" ? renewed.sessionId.trim() : "";
  const expiresAt = typeof renewed.expiresAt === "string" ? Date.parse(renewed.expiresAt) : NaN;
  if (!token || !sessionId || !Number.isFinite(expiresAt)) throw new Error("agent_renewal_response_invalid");
  agent.currentToken = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  agent.currentSessionId = sessionId;
  agent.currentExpiresAtMs = expiresAt;
  state.sessionRenewals += 1;
}

async function maintainAgentSessions(
  fixture: LoadFixture,
  agents: RuntimeAgent[],
  state: MutableRunState,
  options: LoadRehearsalOptions,
): Promise<void> {
  await Promise.all(agents.map(async (agent) => {
    try {
      await heartbeatAgent(fixture, agent, state, options);
    } catch {
      // A heartbeat failure is recorded above. The signed renewal below may
      // still recover a transient network failure without taking authority
      // back from another host.
    }
    const expiresAt = agent.currentExpiresAtMs ?? 0;
    if (renewalReady(agent) && agent.currentSessionId && (!expiresAt || expiresAt - Date.now() <= 120_000)) {
      try {
        await renewAgent(fixture, agent, state, options);
      } catch {
        state.sessionErrors += 1;
      }
    }
  }));
}

async function postOnce(
  fixture: LoadFixture,
  agent: RuntimeAgent,
  runId: string,
  ordinal: number,
  state: MutableRunState,
  options: LoadRehearsalOptions,
): Promise<void> {
  const started = performance.now();
  state.writeAttempts += 1;
  try {
    const response = await fetch(`${fixture.baseUrl.replace(/\/+$/, "")}/v1/agent/posts`, {
      method: "POST",
      headers: {
        authorization: agent.currentToken,
        "content-type": "application/json",
        "idempotency-key": `load-${runId}-${ordinal}`,
        "x-request-id": `load-${runId}-${ordinal}`,
      },
      body: JSON.stringify({
        meshId: agent.meshId ?? fixture.meshId,
        topicId: agent.topicId ?? fixture.topicId,
        body: `load rehearsal observation ${runId} ${ordinal}`,
      }),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    countStatus(state, response.status);
    const elapsed = performance.now() - started;
    state.writeLatencies.push(elapsed);
    if (response.ok) {
      const bodyText = await response.text();
      if (Buffer.byteLength(bodyText, "utf8") > 64 * 1024) throw new Error("post_response_too_large");
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        throw new Error("post_response_invalid");
      }
      const post = responseObject(responseObject(body).post);
      const postId = trim(post.id);
      if (!postId) throw new Error("post_response_invalid");
      const parsedCreatedAt = Date.parse(trim(post.createdAt));
      const acceptedAt = Number.isFinite(parsedCreatedAt)
        ? parsedCreatedAt
        : Date.now() + (state.clockOffsetMs ?? 0);
      state.acceptedPosts += 1;
      const accepted: AcceptedEvent = { runId, postId, acceptedAt, ordinal };
      state.acceptedPostsById.set(postId, accepted);
      while (state.acceptedPostsById.size > MAX_ACCEPTED_POST_INDEX) {
        const oldest = state.acceptedPostsById.keys().next().value;
        if (typeof oldest !== "string") break;
        state.acceptedPostsById.delete(oldest);
      }
      if (state.eventFeed) {
        await state.eventFeed.append({ postId, acceptedAt, ordinal });
      }
    } else {
      state.writeErrors += 1;
      // Consume and discard the bounded error response so the connection can
      // be reused without retaining provider details in the evidence.
      await response.arrayBuffer();
    }
  } catch {
    countStatus(state, "network_error");
    state.writeErrors += 1;
    state.writeLatencies.push(performance.now() - started);
  }
}

class ViewerClient {
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectProbeTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs = 250;
  private pendingReconnectStartedAtMs: number | undefined;
  private lastCursor: number | undefined;
  private readonly observedAcceptedPostIds = new Set<string>();
  private opened = false;
  private hasSnapshot = false;
  private reconnectProbeScheduled = false;
  private reconnectProbeIssued = false;
  private messageWork: Promise<void> = Promise.resolve();

  constructor(
    private readonly viewerIndex: number,
    private readonly fixture: LoadFixture,
    private readonly viewer: LoadViewerFixture,
    private readonly state: MutableRunState,
    private readonly options: LoadRehearsalOptions,
    private readonly liveUrl: string,
  ) {}

  start(): void {
    void this.connect(false);
  }

  stop(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.reconnectProbeTimer) clearTimeout(this.reconnectProbeTimer);
    this.reconnectTimer = undefined;
    this.reconnectProbeTimer = undefined;
    this.socket?.close(1000, "load rehearsal complete");
    this.socket = undefined;
  }

  private scheduleReconnect(): void {
    if (this.state.stopping || !this.options.reconnect || this.reconnectTimer) return;
    const delay = Math.min(this.options.reconnectMaxDelayMs, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.options.reconnectMaxDelayMs, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(true);
    }, delay + Math.floor(Math.random() * Math.max(1, Math.floor(delay / 2))));
  }

  private async connect(reconnecting: boolean): Promise<void> {
    if (this.state.stopping) return;
    this.state.viewerConnectAttempts += 1;
    if (reconnecting) this.state.reconnectAttempts += 1;
    if (reconnecting && this.pendingReconnectStartedAtMs === undefined) {
      this.pendingReconnectStartedAtMs = Date.now();
    }
    const reconnectStartedAt = this.pendingReconnectStartedAtMs;
    const headers: Record<string, string> = { cookie: this.viewer.cookie };
    if (this.viewer.authorization) headers.authorization = this.viewer.authorization;
    const socket = new WebSocket(this.liveUrl, {
      headers,
      origin: new URL(this.fixture.baseUrl).origin,
      handshakeTimeout: this.options.requestTimeoutMs,
      maxPayload: 1024 * 1024,
    });
    this.socket = socket;
    const context = {
      socket,
      reconnecting,
      receivedSnapshot: false,
      reconnectStartedAt,
      failureRecorded: false,
      harnessClose: false,
    };
    socket.once("open", () => {
      this.state.viewerConnections += 1;
      if (!this.opened) {
        this.opened = true;
        this.state.viewerInitialConnections += 1;
      }
      this.reconnectDelayMs = 250;
    });
    socket.on("message", (raw) => {
      this.messageWork = this.messageWork.then(() => this.handleMessage(raw.toString(), context)).catch(() => {
        // A malformed frame or feed read must not stop subsequent snapshots
        // from being observed by this viewer.
        this.state.viewerProcessingErrors += 1;
      });
    });
    const onFailure = () => {
      if (context.failureRecorded || context.harnessClose) return;
      context.failureRecorded = true;
      this.state.viewerConnectionErrors += 1;
      if (reconnecting) this.state.reconnectErrors += 1;
      this.scheduleReconnect();
    };
    socket.once("error", onFailure);
    socket.once("close", (_code) => {
      if (this.socket === socket) this.socket = undefined;
      // Some gateways report an abnormal close without an `error` event. Count
      // that as one unexpected failure so a flapping deployment cannot qualify
      // merely because the close path was silent. Harness-controlled probes
      // and the final clean close are intentionally excluded.
      if (!this.state.stopping && !context.harnessClose) onFailure();
      if (!this.state.stopping) this.scheduleReconnect();
    });
  }

  private async handleMessage(
    raw: string,
    context: {
      socket: WebSocket;
      reconnecting: boolean;
      receivedSnapshot: boolean;
      reconnectStartedAt?: number;
      failureRecorded: boolean;
      harnessClose: boolean;
    },
  ): Promise<void> {
      this.state.viewerFrames += 1;
      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        this.state.viewerProcessingErrors += 1;
        return;
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return;
      const record = frame as Record<string, unknown>;
      if (record.type !== "topology.snapshot") return;
      if (!context.receivedSnapshot) {
        context.receivedSnapshot = true;
        if (!this.hasSnapshot) {
          this.hasSnapshot = true;
          this.state.viewerSnapshotReceipts += 1;
        }
        if (context.reconnecting) {
          this.state.reconnects += 1;
          this.state.viewerReconnectReceipts.add(this.viewerIndex);
          this.state.reconnectLatencies.push(
            Math.max(0, Date.now() - (context.reconnectStartedAt ?? Date.now())),
          );
          this.pendingReconnectStartedAtMs = undefined;
        }
        if (
          this.options.strictTarget &&
          this.options.reconnect &&
          !this.reconnectProbeIssued &&
          !this.reconnectProbeScheduled
        ) {
          this.reconnectProbeScheduled = true;
          const delay = 1_000 + Math.floor(Math.random() * 500);
          this.reconnectProbeTimer = setTimeout(() => {
            this.reconnectProbeTimer = undefined;
            this.reconnectProbeScheduled = false;
            if (
              this.state.stopping ||
              this.socket !== context.socket ||
              context.socket.readyState !== WebSocket.OPEN
            ) return;
            this.reconnectProbeIssued = true;
            this.pendingReconnectStartedAtMs = Date.now();
            context.harnessClose = true;
            context.socket.close(4000, "load rehearsal reconnect probe");
          }, delay);
        }
      }
      const cursor = Number(record.cursor);
      if (!Number.isSafeInteger(cursor) || (this.lastCursor !== undefined && cursor <= this.lastCursor)) return;
      this.lastCursor = cursor;
      // The gateway intentionally exposes aggregate topology, not post bodies.
      // Correlate the snapshot's latest event id with the accepted POST
      // response rather than pairing a cursor advance with whichever write
      // happened to finish most recently. This keeps the propagation sample
      // honest when writes complete out of order or non-post events interleave.
      const snapshot = responseObject(record.snapshot);
      const latestEventId = trim(snapshot.latest_event_id);
      let accepted = latestEventId ? this.state.acceptedPostsById.get(latestEventId) : undefined;
      if (!accepted && latestEventId && this.state.eventFeed) {
        // The writer may append the feed record just after the API response
        // reaches the gateway. Retry a few bounded reads before declaring the
        // snapshot uncorrelated; this keeps the viewer gate fail-closed while
        // avoiding a permanent miss on a one-shot cursor update.
        for (let attempt = 0; attempt < 4 && !accepted; attempt += 1) {
          await this.state.eventFeed.refresh();
          accepted = this.state.eventFeed.get(latestEventId);
          if (!accepted && attempt < 3) await sleep(25);
        }
      }
      if (accepted && !this.observedAcceptedPostIds.has(latestEventId)) {
        this.observedAcceptedPostIds.add(latestEventId);
        const now = Date.now() + (this.state.clockOffsetMs ?? 0);
        recordTopologyLatency(this.state, Math.max(0, now - accepted.acceptedAt));
        this.state.viewerTopologyObservations += 1;
        this.state.viewerPostUpdateReceipts.add(this.viewerIndex);
        const startedAt = this.state.writePhaseStartedAtMs;
        if (startedAt !== undefined) {
          const elapsedMs = Math.max(0, now - startedAt);
          const bucket = Math.floor(elapsedMs / 60_000);
          const viewerBuckets = this.state.viewerPostUpdateBuckets.get(this.viewerIndex) ?? new Set<number>();
          viewerBuckets.add(bucket);
          this.state.viewerPostUpdateBuckets.set(this.viewerIndex, viewerBuckets);
        }
      }
  }
}

function buildLiveUrl(fixture: LoadFixture): string | undefined {
  if (fixture.liveUrl) {
    const url = new URL(fixture.liveUrl);
    url.searchParams.set("meshId", fixture.meshId);
    url.searchParams.set("contractVersion", "1");
    return url.toString();
  }
  const base = new URL(fixture.baseUrl);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/v1/live";
  base.search = `?meshId=${encodeURIComponent(fixture.meshId)}&contractVersion=1`;
  return base.toString();
}

function gateResult(
  options: LoadRehearsalOptions,
  fixture: LoadFixture,
  state: MutableRunState,
  latencyMs: LoadRehearsalEvidence["latencyMs"],
): LoadRehearsalEvidence["gates"] {
  const targetShapePassed = expectedShape(options, fixture);
  const runDurationSeconds = state.writePhaseStartedAtMs !== undefined && state.writePhaseFinishedAtMs !== undefined
    ? Math.max(0, (state.writePhaseFinishedAtMs - state.writePhaseStartedAtMs) / 1_000)
    : 0;
  const achievedPostRatePerSecond = state.acceptedPosts / Math.max(runDurationSeconds, 0.001);
  const acceptedPostCountTarget = Math.max(1, Math.floor(options.postRate * options.durationSeconds * 0.99));
  const achievedPostRatePassed = options.workerRole === "viewer" || (
    state.acceptedPosts >= acceptedPostCountTarget &&
    achievedPostRatePerSecond >= options.postRate * 0.99
  );
  const durationPassed = runDurationSeconds >= options.durationSeconds * 0.99;
  const viewerCoveragePassed = options.workerRole === "writer" || (
    state.viewerInitialConnections >= options.viewerCount &&
    state.viewerSnapshotReceipts >= options.viewerCount &&
    state.viewerPostUpdateReceipts.size >= options.viewerCount
  );
  const requiredTopologyBuckets = Math.max(1, Math.ceil(options.durationSeconds / 60 * 0.99));
  const topologyTemporalCoveragePassed = options.workerRole === "writer" || !options.strictTarget ||
    Array.from({ length: options.viewerCount }, (_, index) => options.viewerOffset + index)
      .every((viewerIndex) => {
        const buckets = state.viewerPostUpdateBuckets.get(viewerIndex);
        return buckets !== undefined &&
          Array.from({ length: requiredTopologyBuckets }, (_, bucket) => bucket)
            .every((requiredBucket) => buckets.has(requiredBucket));
      });
  const sessionContinuityPassed = options.workerRole === "viewer" || (
    state.sessionErrors === 0 &&
    (options.durationSeconds <= RUNTIME_SESSION_SECONDS || fixture.agents.every(renewalReady))
  );
  const writeP95Below750Ms = options.workerRole === "viewer" ||
    (latencyMs.writes.p95Ms !== null && latencyMs.writes.p95Ms < 750);
  const topologyP95Below2s = options.workerRole === "writer" ||
    (latencyMs.topologyUpdates.p95Ms !== null && latencyMs.topologyUpdates.p95Ms < 2_000);
  const reconnectLatencyWithinTarget = latencyMs.reconnectRecovery.count === 0
    ? options.workerRole === "writer" || !options.strictTarget
    : latencyMs.reconnectRecovery.p95Ms !== null && latencyMs.reconnectRecovery.p95Ms < 5_000;
  const reconnectP95Below5s = reconnectLatencyWithinTarget &&
    (options.workerRole === "writer" || !options.strictTarget || (
      options.reconnect &&
      state.viewerReconnectReceipts.size >= options.viewerCount
    ));
  const writeErrorRateBelow1Percent = options.workerRole === "viewer" ||
    state.writeErrors / Math.max(1, state.writeAttempts) < 0.01;
  // Keep transport failures and frame/feed processing failures separate. A
  // flood of healthy frames must not dilute a connection error rate, and a
  // quiet socket must not hide malformed-frame failures.
  const viewerConnectionErrorRateBelow1Percent = options.workerRole === "writer" ||
    state.viewerConnectionErrors / Math.max(1, state.viewerConnectAttempts) < 0.01;
  const viewerProcessingErrorRateBelow1Percent = options.workerRole === "writer" ||
    state.viewerProcessingErrors / Math.max(1, state.viewerFrames) < 0.01;
  const unexpectedErrorRateBelow1Percent = writeErrorRateBelow1Percent &&
    viewerConnectionErrorRateBelow1Percent && viewerProcessingErrorRateBelow1Percent;
  const clockSkewBelow1s = state.clockOffsetMs !== null && Math.abs(state.clockOffsetMs) <= 1_000;
  return {
    strictTarget: options.strictTarget,
    targetShapePassed,
    achievedPostRatePassed,
    durationPassed,
    viewerCoveragePassed,
    topologyTemporalCoveragePassed,
    sessionContinuityPassed,
    writeP95Below750Ms,
    topologyP95Below2s,
    reconnectP95Below5s,
    unexpectedErrorRateBelow1Percent,
    clockSkewBelow1s,
    // Only a strict combined run can be a launch qualification. Non-strict
    // rehearsals remain useful diagnostics but can never report qualified.
    qualified: options.workerRole === "combined" &&
      options.strictTarget && targetShapePassed &&
      achievedPostRatePassed && durationPassed && viewerCoveragePassed && topologyTemporalCoveragePassed && sessionContinuityPassed &&
      writeP95Below750Ms && topologyP95Below2s && reconnectP95Below5s && unexpectedErrorRateBelow1Percent &&
      clockSkewBelow1s,
  };
}

export async function runLoadRehearsal(
  options: LoadRehearsalOptions,
  fixtureArg?: LoadFixture,
): Promise<LoadRehearsalEvidence> {
  const fixture = fixtureArg ?? await readLoadFixture(options.fixturePath);
  if (options.totalAgentCount < fixture.agents.length) {
    throw new Error("total_agent_count_below_fixture_count");
  }
  if (options.workerRole !== "viewer" && !fixture.agents.length) {
    throw new Error("agents_required_for_writer");
  }
  if (options.workerRole === "viewer" && fixture.agents.length) {
    throw new Error("viewer_fixture_must_not_include_agent_credentials");
  }
  if (options.workerRole === "writer" && fixture.viewers.length) {
    throw new Error("writer_fixture_must_not_include_viewer_credentials");
  }
  if (options.workerRole !== "writer" && !fixture.viewers.length) {
    throw new Error("viewers_required_for_observer");
  }
  if (options.workerRole !== "viewer" && options.postRate > fixture.agents.length) {
    throw new Error("post_rate_exceeds_agent_count; launch quotas allow at most one accepted post per agent per second on average");
  }
  if (options.viewerCount > fixture.viewers.length) throw new Error("viewer_slice_exceeds_fixture");
  if (options.workerRole === "viewer" && !options.eventFeedPath && !options.dryRun) {
    throw new Error("viewer_worker_requires_accepted_event_feed");
  }
  if (options.durationSeconds > RUNTIME_SESSION_SECONDS && options.workerRole !== "viewer" && fixture.agents.some((agent) => !renewalReady(agent))) {
    throw new Error("long_rehearsal_requires_signed_renewal_credentials");
  }
  const liveUrl = buildLiveUrl(fixture);
  if (!liveUrl) throw new Error("live_url_missing");
  assertLiveUrl(liveUrl);
  const state = newState();
  if (!options.dryRun) {
    const healthStartedAtMs = Date.now();
    const health = await fetch(`${fixture.baseUrl.replace(/\/+$/, "")}/healthz`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
    await health.arrayBuffer();
    if (!health.ok) throw new Error("load_target_unhealthy");
    const serverDate = Date.parse(health.headers.get("date") ?? "");
    if (Number.isFinite(serverDate)) {
      state.clockOffsetMs = serverDate - Math.round((healthStartedAtMs + Date.now()) / 2);
    }
  }
  const runId = options.runId ?? randomUUID();
  const started = new Date();
  if (options.eventFeedPath && !options.dryRun) {
    state.eventFeed = await AcceptedEventFeed.open(options.eventFeedPath, options.workerRole !== "viewer", runId);
  }
  const agents: RuntimeAgent[] = fixture.agents.map((agent) => ({
    ...agent,
    currentToken: agent.token,
    ...(agent.sessionId ? { currentSessionId: agent.sessionId } : {}),
    ...(agent.tokenExpiresAt ? { currentExpiresAtMs: Date.parse(agent.tokenExpiresAt) } : {}),
  }));
  const viewers = options.workerRole === "writer"
    ? []
    : fixture.viewers
      .slice(0, options.viewerCount)
      .map((viewer, index) => new ViewerClient(options.viewerOffset + index, fixture, viewer, state, options, liveUrl));
  if (options.dryRun) {
    const latencyMs = {
      writes: summarizeHistogram([]),
      topologyUpdates: summarizeHistogram([]),
      reconnectRecovery: summarizeHistogram([]),
    };
    return {
      contractVersion: 1,
      runId,
      fixturePath: options.fixturePath,
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      target: {
        agentCount: fixture.agents.length,
        totalAgentCount: options.totalAgentCount,
        viewerCount: options.viewerCount,
        viewerOffset: options.viewerOffset,
        totalViewerCount: options.totalViewerCount,
        workerRole: options.workerRole,
        postRatePerSecond: options.postRate,
        durationSeconds: options.durationSeconds,
      },
      observed: {
        writeAttempts: 0,
        acceptedPosts: 0,
        writeErrors: 0,
        achievedPostRatePerSecond: 0,
        runDurationSeconds: 0,
        statusCounts: {},
        sessionHeartbeats: 0,
        sessionRenewals: 0,
        sessionErrors: 0,
        viewerConnectAttempts: 0,
        viewerConnections: 0,
        viewerInitialConnections: 0,
        viewerConnectionErrors: 0,
        viewerFrames: 0,
        viewerSnapshotReceipts: 0,
        viewerTopologyObservations: 0,
        topologyLatencyObservations: 0,
        viewerPostUpdateReceipts: 0,
        viewerPostUpdateBuckets: {},
        viewerProcessingErrors: 0,
        reconnectAttempts: 0,
        reconnects: 0,
        viewerReconnectReceipts: 0,
        reconnectErrors: 0,
        clockOffsetMs: state.clockOffsetMs,
      },
      latencyMs,
      gates: gateResult(options, fixture, state, latencyMs),
      limitations: [
        "dry-run validates only fixture shape and target bounds; no API or live-gateway request was made",
        "Firestore/Pub/Sub usage must be captured from Cloud Monitoring during a non-dry rehearsal",
      ],
    };
  }

  viewers.forEach((viewer) => viewer.start());
  const sessionAgents = options.workerRole === "viewer" ? [] : agents;
  let lifecycleWork: Promise<void> = Promise.resolve();
  const lifecycleTimer = setInterval(() => {
    lifecycleWork = lifecycleWork.then(() => maintainAgentSessions(fixture, sessionAgents, state, options));
  }, HEARTBEAT_SECONDS * 1_000);
  lifecycleTimer.unref();
  const endAt = Date.now() + options.durationSeconds * 1_000;
  const intervalMs = 1_000 / Math.max(1, options.postRate);
  let nextAt = performance.now();
  let ordinal = 0;
  let agentIndex = 0;
  const inflight = new Set<Promise<void>>();
  state.writePhaseStartedAtMs = Date.now() + (state.clockOffsetMs ?? 0);
  try {
    if (options.workerRole === "viewer") {
      // Viewer shards stay connected for the full write window and observe the
      // writer's traffic; they do not hold agent credentials or publish posts.
      await sleep(options.durationSeconds * 1_000);
    } else {
      while (Date.now() < endAt) {
        const waitMs = nextAt - performance.now();
        if (waitMs > 0) await sleep(Math.min(waitMs, 250));
        if (Date.now() >= endAt) break;
        while (inflight.size >= options.maxInflightWrites) {
          await Promise.race(inflight);
        }
        const agent = agents[agentIndex % agents.length]!;
        agentIndex += 1;
        ordinal += 1;
        const request = postOnce(fixture, agent, runId, ordinal, state, options);
        inflight.add(request);
        void request.finally(() => inflight.delete(request));
        nextAt += intervalMs;
        // If the process was paused, avoid issuing a burst that violates the
        // per-agent quota after it wakes up.
        if (nextAt < performance.now() - 1_000) nextAt = performance.now() + intervalMs;
      }
      await Promise.all(inflight);
    }
    state.writePhaseFinishedAtMs = Date.now() + (state.clockOffsetMs ?? 0);
    // Give the topology a bounded catch-up period without extending the write
    // phase. This makes the final propagation histogram useful at short runs.
    await sleep(Math.min(5_000, Math.max(500, options.requestTimeoutMs)));
  } finally {
    clearInterval(lifecycleTimer);
    await lifecycleWork;
    state.stopping = true;
    viewers.forEach((viewer) => viewer.stop());
  }
  const latencyMs = {
    writes: summarizeHistogram(state.writeLatencies),
    topologyUpdates: summarizeHistogram(state.topologyLatencies),
    reconnectRecovery: summarizeHistogram(state.reconnectLatencies),
  };
  const runDurationSeconds = state.writePhaseStartedAtMs !== undefined && state.writePhaseFinishedAtMs !== undefined
    ? Math.max(0, (state.writePhaseFinishedAtMs - state.writePhaseStartedAtMs) / 1_000)
    : 0;
  const finished = new Date();
  return {
    contractVersion: 1,
    runId,
    fixturePath: options.fixturePath,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    target: {
      agentCount: fixture.agents.length,
      totalAgentCount: options.totalAgentCount,
      viewerCount: options.viewerCount,
      viewerOffset: options.viewerOffset,
      totalViewerCount: options.totalViewerCount,
      workerRole: options.workerRole,
      postRatePerSecond: options.postRate,
      durationSeconds: options.durationSeconds,
    },
    observed: {
      writeAttempts: state.writeAttempts,
      acceptedPosts: state.acceptedPosts,
      writeErrors: state.writeErrors,
      achievedPostRatePerSecond: state.acceptedPosts / Math.max(runDurationSeconds, 0.001),
      runDurationSeconds,
      statusCounts: state.statusCounts,
      sessionHeartbeats: state.sessionHeartbeats,
      sessionRenewals: state.sessionRenewals,
      sessionErrors: state.sessionErrors,
      viewerConnectAttempts: state.viewerConnectAttempts,
      viewerConnections: state.viewerConnections,
      viewerInitialConnections: state.viewerInitialConnections,
      viewerConnectionErrors: state.viewerConnectionErrors,
      viewerFrames: state.viewerFrames,
      viewerSnapshotReceipts: state.viewerSnapshotReceipts,
      viewerTopologyObservations: state.viewerTopologyObservations,
      topologyLatencyObservations: state.topologyLatencyObservations,
      viewerPostUpdateReceipts: state.viewerPostUpdateReceipts.size,
      viewerPostUpdateBuckets: Object.fromEntries(
        [...state.viewerPostUpdateBuckets.entries()]
          .sort(([left], [right]) => left - right)
          .map(([viewerIndex, buckets]) => [viewerIndex, [...buckets].sort((left, right) => left - right)]),
      ),
      viewerProcessingErrors: state.viewerProcessingErrors,
      reconnectAttempts: state.reconnectAttempts,
      reconnects: state.reconnects,
      viewerReconnectReceipts: state.viewerReconnectReceipts.size,
      reconnectErrors: state.reconnectErrors,
      clockOffsetMs: state.clockOffsetMs,
    },
    latencyMs,
    gates: gateResult(options, fixture, state, latencyMs),
    limitations: [
      "topology latency is black-box time from an accepted write to the next authenticated cursor advance; it does not expose post bodies",
      "topology latency uses a 250000-value reservoir sample across the full run; viewer coverage still requires every target viewer to observe an accepted post-driven cursor update",
      "strict qualification also requires at least one correlated post-driven update in every minute bucket of the write window and counts frame/feed processing failures separately from write failures",
      "Firestore reads/writes, Pub/Sub delivery, egress, and logging cost must be recorded from Cloud Monitoring and billing exports",
      "the runner never sends client-supplied proxy IP headers; distributed generators with distinct egress addresses may be required for the 500-viewer target",
    ],
  };
}

export async function writeLoadEvidence(
  evidence: LoadRehearsalEvidence,
  destination: string,
): Promise<string> {
  const redacted = JSON.stringify(evidence, null, 2) + "\n";
  await writeFile(destination, redacted, { mode: 0o600 });
  await chmod(destination, 0o600);
  return destination;
}
