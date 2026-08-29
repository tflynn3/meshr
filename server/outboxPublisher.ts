import type { DatabaseSync } from "node:sqlite";
import type { RuntimeKind } from "./types.ts";
import { parseEventEnvelope, type EventEnvelope } from "../platform/eventEnvelope.ts";

interface OutboxRow {
  event_id: string;
  schema_version: number;
  type: string;
  mesh_id: string | null;
  topic_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  runtime_kind: RuntimeKind | null;
  payload_json: string;
  attempts: number;
  created_at: string;
  next_attempt_at: string | null;
}

export interface SqliteOutboxPublisherOptions {
  db: DatabaseSync;
  ingestUrl: string;
  internalToken: string;
  intervalMs?: number;
  batchSize?: number;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

export interface SqliteOutboxPublisher {
  flush(): Promise<void>;
  stop(): void;
}

/**
 * Drains the transactionally-written local outbox into the Firestore-backed
 * ingest service. Social writes never call ingest directly; a failed delivery
 * remains pending and is retried on the next pass.
 */
export function startSqliteOutboxPublisher(
  options: SqliteOutboxPublisherOptions,
): SqliteOutboxPublisher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = Math.max(250, options.intervalMs ?? 1_000);
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 50, 500));
  const now = options.now ?? (() => new Date().toISOString());
  const endpoint = new URL("/v1/events", options.ingestUrl).toString();
  let stopped = false;
  let running = false;

  const mark = (row: OutboxRow, status: "published" | "failed", error?: string): void => {
    const retryDelay = Math.min(60, 2 ** Math.min(row.attempts, 6));
    const nextAttempt =
      status === "failed"
        ? new Date(Date.parse(now()) + retryDelay * 1_000).toISOString()
        : null;
    options.db
      .prepare(
        `UPDATE outbox_events
         SET status = ?, attempts = attempts + 1,
             published_at = CASE WHEN ? = 'published' THEN ? ELSE published_at END,
             last_error = ?, next_attempt_at = ?
         WHERE event_id = ? AND status IN ('pending', 'failed')`,
      )
      .run(
        status,
        status,
        status === "published" ? now() : null,
        error ?? null,
        nextAttempt,
        row.event_id,
      );
  };

  const envelopeFor = (row: OutboxRow): EventEnvelope | null => {
    // Topology Pub/Sub events are scoped to a mesh and agent. Governance and
    // account events remain durable in SQLite/audit but do not enter topology.
    if (!row.mesh_id || !row.agent_id) return null;
    const payload = JSON.parse(row.payload_json) as unknown;
    const objectPayload =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : { value: payload };
    return parseEventEnvelope({
      event_id: row.event_id,
      schema_version: 1,
      mesh_id: row.mesh_id,
      agent_id: row.agent_id,
      session_id: row.session_id,
      runtime_kind: row.runtime_kind,
      type: row.type,
      occurred_at: row.created_at,
      payload: {
        topic_id: row.topic_id,
        ...objectPayload,
      },
    });
  };

  const flush = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const rows = options.db
        .prepare(
          `SELECT event_id, schema_version, type, mesh_id, topic_id, agent_id,
                  session_id, runtime_kind, payload_json, attempts, created_at, next_attempt_at
           FROM outbox_events
           WHERE status IN ('pending', 'failed')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY created_at ASC, event_id ASC LIMIT ?`,
        )
        .all(now(), batchSize) as unknown as OutboxRow[];
      for (const row of rows) {
        if (stopped) break;
        const envelope = envelopeFor(row);
        if (!envelope) {
          mark(row, "published", "non_topology_event");
          continue;
        }
        try {
          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-Meshr-Contract-Version": "1",
              Authorization: `Bearer ${options.internalToken}`,
            },
            body: JSON.stringify(envelope),
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) throw new Error(`ingest returned HTTP ${response.status}`);
          mark(row, "published");
        } catch (error) {
          mark(row, "failed", error instanceof Error ? error.message : String(error));
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void flush(), intervalMs);
  timer.unref();
  return {
    flush,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
