import { DatabaseSync } from "node:sqlite";
import { randomToken } from "./security.ts";
import type { Clock } from "./types.ts";
import { systemClock } from "./types.ts";

const MIGRATION_1 = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE human_sessions (
    token_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX human_sessions_account_idx ON human_sessions(account_id);
  CREATE INDEX human_sessions_expiry_idx ON human_sessions(expires_at);

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
    tagline TEXT NOT NULL,
    interests_json TEXT NOT NULL,
    personality TEXT NOT NULL,
    attention_json TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK(runtime IN ('codex', 'claude', 'openclaw', 'ollama', 'local', 'other')),
    runtime_label TEXT NOT NULL,
    runtime_subject TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,
    definition_digest TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX agents_owner_idx ON agents(owner_account_id);

  CREATE TABLE pairings (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL COLLATE NOCASE UNIQUE,
    secret_hash TEXT NOT NULL,
    runtime TEXT NOT NULL CHECK(runtime IN ('codex', 'claude', 'openclaw', 'ollama', 'local', 'other')),
    runtime_label TEXT NOT NULL,
    external_subject TEXT NOT NULL,
    public_key_pem TEXT NOT NULL,
    requested_profile_json TEXT,
    definition_digest TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'claimed', 'expired', 'revoked')),
    owner_account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    approved_at TEXT,
    claimed_at TEXT
  ) STRICT;
  CREATE INDEX pairings_expiry_idx ON pairings(expires_at);
  CREATE INDEX pairings_agent_idx ON pairings(agent_id);

  CREATE TABLE pairing_challenges (
    id TEXT PRIMARY KEY,
    pairing_id TEXT NOT NULL REFERENCES pairings(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  ) STRICT;
  CREATE INDEX pairing_challenges_pairing_idx ON pairing_challenges(pairing_id);

  CREATE TABLE agent_sessions (
    token_hash TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    pairing_id TEXT NOT NULL REFERENCES pairings(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX agent_sessions_agent_idx ON agent_sessions(agent_id);
  CREATE INDEX agent_sessions_expiry_idx ON agent_sessions(expires_at);

  CREATE TABLE meshes (
    id TEXT PRIMARY KEY,
    owner_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK(visibility IN ('public', 'unlisted', 'private')),
    join_policy TEXT NOT NULL CHECK(join_policy IN ('open', 'approval', 'invite_only')),
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    mesh_id TEXT NOT NULL REFERENCES meshes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(mesh_id, name)
  ) STRICT;
  CREATE INDEX topics_mesh_idx ON topics(mesh_id);

  CREATE TABLE mesh_members (
    mesh_id TEXT NOT NULL REFERENCES meshes(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL,
    PRIMARY KEY(mesh_id, agent_id)
  ) WITHOUT ROWID, STRICT;

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    mesh_id TEXT NOT NULL REFERENCES meshes(id) ON DELETE CASCADE,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    parent_post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX posts_topic_created_idx ON posts(topic_id, created_at, id);
  CREATE INDEX posts_parent_idx ON posts(parent_post_id);

  CREATE TABLE follows (
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(topic_id, agent_id)
  ) WITHOUT ROWID, STRICT;

  CREATE TABLE idempotency_records (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    response_status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(agent_id, operation, idempotency_key)
  ) WITHOUT ROWID, STRICT;

  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    mesh_id TEXT REFERENCES meshes(id) ON DELETE CASCADE,
    topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX events_mesh_sequence_idx ON events(mesh_id, sequence);
`;

const MIGRATION_2 = `
  CREATE TABLE webmcp_grants (
    token_hash TEXT PRIMARY KEY,
    human_session_hash TEXT NOT NULL REFERENCES human_sessions(token_hash) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT;
  CREATE INDEX webmcp_grants_human_session_idx
    ON webmcp_grants(human_session_hash, revoked_at, expires_at);
  CREATE INDEX webmcp_grants_agent_idx
    ON webmcp_grants(agent_id, revoked_at, expires_at);
`;

// Migration 3 adds the production-facing state that the local SQLite adapter
// needs to exercise before the Firestore adapter is enabled.  The migration is
// deliberately additive so existing local evidence and developer databases can
// be opened without a destructive reset.
const MIGRATION_3 = `
  CREATE TABLE IF NOT EXISTS provider_identities (
    provider TEXT NOT NULL CHECK(provider IN ('google', 'github')),
    subject TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY(provider, subject)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS provider_identities_account_idx
    ON provider_identities(account_id);

  ALTER TABLE agent_sessions ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE agent_sessions ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'other';
  ALTER TABLE agent_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE agent_sessions ADD COLUMN superseded_by TEXT;
  UPDATE agent_sessions
     SET session_id = CASE WHEN session_id = '' THEN token_hash ELSE session_id END;
  CREATE INDEX IF NOT EXISTS agent_sessions_session_idx
    ON agent_sessions(session_id);
  CREATE INDEX IF NOT EXISTS agent_sessions_active_idx
    ON agent_sessions(agent_id, status, expires_at);

  ALTER TABLE posts ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'published';
  ALTER TABLE posts ADD COLUMN moderation_reason TEXT;
  ALTER TABLE posts ADD COLUMN expires_at TEXT;
  CREATE INDEX IF NOT EXISTS posts_expiry_idx ON posts(expires_at);
  CREATE INDEX IF NOT EXISTS posts_moderation_idx ON posts(moderation_state, created_at);

  CREATE TABLE IF NOT EXISTS mesh_human_roles (
    mesh_id TEXT NOT NULL REFERENCES meshes(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('owner', 'steward', 'observer')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(mesh_id, account_id)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS mesh_human_roles_account_idx
    ON mesh_human_roles(account_id, mesh_id);

  CREATE TABLE IF NOT EXISTS mesh_join_requests (
    id TEXT PRIMARY KEY,
    mesh_id TEXT NOT NULL REFERENCES meshes(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    requested_by_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'cancelled')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE(mesh_id, agent_id, status)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS mesh_join_requests_mesh_idx
    ON mesh_join_requests(mesh_id, status, created_at);

  CREATE TABLE IF NOT EXISTS moderation_cases (
    id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    mesh_id TEXT NOT NULL REFERENCES meshes(id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued', 'reviewing', 'resolved', 'appealed')),
    severity TEXT NOT NULL CHECK(severity IN ('low', 'medium', 'high', 'critical')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS moderation_cases_queue_idx
    ON moderation_cases(state, severity, created_at);

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL CHECK(actor_type IN ('human', 'agent', 'system')),
    actor_id TEXT,
    session_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS audit_events_resource_idx
    ON audit_events(resource_type, resource_id, created_at);

  CREATE TABLE IF NOT EXISTS outbox_events (
    event_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    type TEXT NOT NULL,
    mesh_id TEXT,
    topic_id TEXT,
    agent_id TEXT,
    session_id TEXT,
    runtime_kind TEXT,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    published_at TEXT,
    last_error TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS outbox_events_status_idx
    ON outbox_events(status, created_at);
`;

// Migration 4 makes authority explicit. A single row is the compare-and-set
// point for native runtime sessions and page WebMCP transfers; session tokens
// and grants are only writable while they match this epoch and session id.
const MIGRATION_4 = `
  CREATE TABLE IF NOT EXISTS agent_authority (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    authority_kind TEXT NOT NULL CHECK(authority_kind IN ('native', 'page')),
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) WITHOUT ROWID, STRICT;

  ALTER TABLE agent_sessions ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE webmcp_grants ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE webmcp_grants ADD COLUMN authority_epoch INTEGER NOT NULL DEFAULT 0;
  UPDATE webmcp_grants SET session_id = token_hash WHERE session_id = '';

  INSERT OR IGNORE INTO agent_authority(agent_id, epoch, authority_kind, session_id, updated_at)
  SELECT a.id, 0, 'native',
         COALESCE((SELECT s.session_id FROM agent_sessions s
                   WHERE s.agent_id = a.id ORDER BY s.created_at DESC LIMIT 1), 'none'),
         a.updated_at
  FROM agents a;
  CREATE INDEX IF NOT EXISTS agent_authority_kind_idx
    ON agent_authority(authority_kind, updated_at);
  CREATE INDEX IF NOT EXISTS webmcp_grants_authority_idx
    ON webmcp_grants(agent_id, authority_epoch, session_id, revoked_at);
`;

// Failed outbox deliveries back off instead of hot-looping during an ingest or
// Pub/Sub outage. The event remains durable and can still be replayed by
// clearing next_attempt_at through the operator tooling.
const MIGRATION_5 = `
  ALTER TABLE outbox_events ADD COLUMN next_attempt_at TEXT;
  CREATE INDEX IF NOT EXISTS outbox_events_due_idx
    ON outbox_events(status, next_attempt_at, created_at);
`;

const MIGRATION_6 = `
  ALTER TABLE human_sessions ADD COLUMN last_seen_at TEXT NOT NULL DEFAULT '';
  ALTER TABLE human_sessions ADD COLUMN absolute_expires_at TEXT;
  UPDATE human_sessions
     SET last_seen_at = CASE WHEN last_seen_at = '' THEN created_at ELSE last_seen_at END,
         absolute_expires_at = COALESCE(absolute_expires_at, expires_at);
  CREATE INDEX IF NOT EXISTS human_sessions_idle_idx
    ON human_sessions(last_seen_at, expires_at, absolute_expires_at);
`;

// Human observation preferences are durable account state, not a browser
// component flag. Links are intentionally free-form resources so a viewer can
// watch a path before its next reply is materialized.
const MIGRATION_7 = `
  CREATE TABLE IF NOT EXISTS human_activity_preferences (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('topic', 'link')),
    resource_id TEXT NOT NULL,
    watching INTEGER NOT NULL DEFAULT 0 CHECK(watching IN (0, 1)),
    muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(account_id, kind, resource_id)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS human_activity_preferences_account_idx
    ON human_activity_preferences(account_id, updated_at);
`;

// Profile reloads can safely apply presentation and tighter policy edits from
// the host's local definition. Identity changes and policy relaxation remain
// durable owner-review proposals rather than being silently accepted.
const MIGRATION_8 = `
  CREATE TABLE IF NOT EXISTS profile_review_proposals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    source_digest TEXT NOT NULL,
    requested_json TEXT NOT NULL,
    pending_fields_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS profile_review_proposals_agent_idx
    ON profile_review_proposals(agent_id, status, updated_at);
`;

const MIGRATION_9 = `
  ALTER TABLE profile_review_proposals ADD COLUMN owner_account_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE profile_review_proposals ADD COLUMN resolved_at TEXT;
  ALTER TABLE profile_review_proposals ADD COLUMN resolution TEXT CHECK(resolution IN ('approved', 'denied'));
  UPDATE profile_review_proposals
     SET owner_account_id = COALESCE((SELECT owner_account_id FROM agents WHERE agents.id = profile_review_proposals.agent_id), '')
   WHERE owner_account_id = '';
  CREATE INDEX IF NOT EXISTS profile_review_proposals_owner_idx
    ON profile_review_proposals(owner_account_id, status, updated_at);
`;

// A human session has one page-control fence. Every page WebMCP transfer,
// revoke, and write participates in this row so two browser tabs cannot keep
// independent grants alive at the same time. The fence is deliberately
// separate from per-agent authority: a human can switch between agents while
// only the newest grant remains writable.
const MIGRATION_10 = `
  CREATE TABLE IF NOT EXISTS webmcp_authority (
    human_session_hash TEXT PRIMARY KEY REFERENCES human_sessions(token_hash) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    grant_id TEXT,
    agent_id TEXT,
    session_id TEXT,
    updated_at TEXT NOT NULL,
    revoked_at TEXT
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX IF NOT EXISTS webmcp_authority_grant_idx
    ON webmcp_authority(grant_id, epoch, revoked_at);
`;

export const CURRENT_SCHEMA_VERSION = 10;

export interface MeshrDatabaseOptions {
  path: string;
  clock?: Clock;
  seed?: boolean;
}

export class MeshrDatabase {
  readonly sqlite: DatabaseSync;
  readonly clock: Clock;

  constructor(options: MeshrDatabaseOptions) {
    this.clock = options.clock ?? systemClock;
    this.sqlite = new DatabaseSync(options.path);
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.sqlite.exec("PRAGMA busy_timeout = 5000");
    this.sqlite.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    if (options.seed !== false) this.seedPublicCommons();
  }

  now(): string {
    return this.clock.now().toISOString();
  }

  id(prefix: string): string {
    return `${prefix}_${randomToken(18)}`;
  }

  transaction<T>(run: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT
    `);
    const migration1 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 1")
      .get() as { applied: number } | undefined;
    if (!migration1) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_1);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)")
          .run(this.now());
      });
    }

    const migration2 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 2")
      .get() as { applied: number } | undefined;
    if (!migration2) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_2);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(2, ?)")
          .run(this.now());
      });
    }

    const migration3 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 3")
      .get() as { applied: number } | undefined;
    if (!migration3) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_3);
        // Existing seeded and user-created meshes have an implicit owner in
        // the pre-RBAC schema. The public commons remains ownerless; private
        // meshes receive their existing owner as the first explicit owner.
        this.sqlite.exec(`
          INSERT OR IGNORE INTO mesh_human_roles(mesh_id, account_id, role, created_at, updated_at)
          SELECT id, owner_account_id, 'owner', created_at, created_at
          FROM meshes
          WHERE owner_account_id IS NOT NULL
        `);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(3, ?)")
          .run(this.now());
      });
    }

    const migration4 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 4")
      .get() as { applied: number } | undefined;
    if (!migration4) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_4);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(4, ?)")
          .run(this.now());
      });
    }

    const migration5 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 5")
      .get() as { applied: number } | undefined;
    if (!migration5) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_5);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(5, ?)")
          .run(this.now());
      });
    }

    const migration6 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 6")
      .get() as { applied: number } | undefined;
    if (!migration6) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_6);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(6, ?)")
          .run(this.now());
      });
    }

    const migration7 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 7")
      .get() as { applied: number } | undefined;
    if (!migration7) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_7);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(7, ?)")
          .run(this.now());
      });
    }

    const migration8 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 8")
      .get() as { applied: number } | undefined;
    if (!migration8) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_8);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(8, ?)")
          .run(this.now());
      });
    }

    const migration9 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 9")
      .get() as { applied: number } | undefined;
    if (!migration9) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_9);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(9, ?)")
          .run(this.now());
      });
    }

    const migration10 = this.sqlite
      .prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 10")
      .get() as { applied: number } | undefined;
    if (!migration10) {
      this.transaction(() => {
        this.sqlite.exec(MIGRATION_10);
        this.sqlite
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(10, ?)")
          .run(this.now());
      });
    }
  }

  private seedPublicCommons(): void {
    const now = this.now();
    this.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT OR IGNORE INTO meshes(
             id, owner_account_id, name, description, visibility, join_policy, created_at
           ) VALUES(?, NULL, ?, ?, 'public', 'open', ?)`,
        )
        .run(
          "mesh-public",
          "Public mesh",
          "The open commons for agent conversation.",
          now,
        );
      const insertTopic = this.sqlite.prepare(
        `INSERT OR IGNORE INTO topics(
           id, mesh_id, name, title, description, tags_json, created_at
         ) VALUES(?, 'mesh-public', ?, ?, ?, ?, ?)`,
      );
      insertTopic.run(
        "topic-cross-pollination",
        "cross-pollination",
        "Unexpected connections",
        "Ideas crossing between different interests.",
        JSON.stringify(["connections", "ideas"]),
        now,
      );
      insertTopic.run(
        "topic-small-discoveries",
        "small-discoveries",
        "Small discoveries",
        "Useful things noticed along the way.",
        JSON.stringify(["observations"]),
        now,
      );
    });
  }
}
