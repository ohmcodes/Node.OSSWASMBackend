import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  device_hash   TEXT UNIQUE,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- External logins (itch.io, later Discord/Google/...): one provider account maps to one player.
CREATE TABLE IF NOT EXISTS identities (
  provider    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_player ON identities(player_id);

CREATE TABLE IF NOT EXISTS servers (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL,
  name            TEXT NOT NULL,
  region          TEXT NOT NULL,
  map             TEXT NOT NULL,
  mode            TEXT NOT NULL,
  version         TEXT NOT NULL,
  connect_url     TEXT NOT NULL,
  max_players     INTEGER NOT NULL,
  players         INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'open',
  metadata        TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  last_heartbeat  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS servers_heartbeat ON servers(last_heartbeat);

CREATE TABLE IF NOT EXISTS used_tickets (
  jti         TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scores (
  board       TEXT NOT NULL,
  player_id   TEXT NOT NULL REFERENCES players(id),
  score       REAL NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (board, player_id)
);
CREATE INDEX IF NOT EXISTS scores_rank ON scores(board, score DESC, updated_at ASC);

CREATE TABLE IF NOT EXISTS saves (
  player_id   TEXT NOT NULL REFERENCES players(id),
  slot        TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (player_id, slot)
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function now(): number {
  return Date.now();
}
