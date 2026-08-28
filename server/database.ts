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
