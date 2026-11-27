import { sha256Hex, type NstackDb } from "./nstack.ts";

/**
 * Relational schema for the app's NStack namespace. Row ids are text; legacy integer ids are
 * kept verbatim as decimal strings so existing ids, cookies and URLs survive the move.
 * Timestamps are epoch milliseconds (bigint, returned as strings by Postgres: see num()).
 * Unique indexes carry every invariant the app relies on (no check-then-insert races).
 * Migrations are append-only and checksummed by NStack; never edit an applied one.
 */
const V1 = `
CREATE TABLE users (
  id text PRIMARY KEY,
  npub text NOT NULL,
  pubkey text NOT NULL,
  username text,
  username_lc text,
  email text,
  display_name text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  password_hash text,
  backup_json text,
  created_at bigint NOT NULL,
  avatar_url text NOT NULL DEFAULT '',
  agent_npub text NOT NULL DEFAULT '',
  agent_avatar text NOT NULL DEFAULT '',
  agent_role text NOT NULL DEFAULT '',
  encrypted_agent_nsec text NOT NULL DEFAULT '',
  agent_encryption_scheme text NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX users_npub_uq ON users (npub);
CREATE UNIQUE INDEX users_pubkey_uq ON users (pubkey);
CREATE UNIQUE INDEX users_username_lc_uq ON users (username_lc);
CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  method text NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE TABLE auth_challenges (
  id text PRIMARY KEY,
  expires_at bigint NOT NULL
);
CREATE INDEX auth_challenges_expires_idx ON auth_challenges (expires_at);
CREATE TABLE settings (
  id text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE counters (
  id text PRIMARY KEY,
  value bigint NOT NULL
);
CREATE TABLE cohorts (
  id text PRIMARY KEY,
  slug text NOT NULL,
  title text NOT NULL,
  tagline text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  highlights text NOT NULL DEFAULT '[]',
  modules text NOT NULL DEFAULT '[]',
  start_date text NOT NULL DEFAULT '',
  end_date text NOT NULL DEFAULT '',
  schedule text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  price_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'aud',
  capacity bigint NOT NULL DEFAULT 20,
  status text NOT NULL DEFAULT 'draft',
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE UNIQUE INDEX cohorts_slug_uq ON cohorts (slug);
CREATE TABLE enrolments (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  cohort_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  amount_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'aud',
  stripe_session_id text,
  stripe_payment_intent text,
  reserved_until bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  paid_at bigint
);
CREATE UNIQUE INDEX enrolments_user_cohort_uq ON enrolments (user_id, cohort_id);
CREATE INDEX enrolments_cohort_idx ON enrolments (cohort_id);
CREATE INDEX enrolments_session_idx ON enrolments (stripe_session_id);
CREATE TABLE seats (
  id text PRIMARY KEY,
  cohort_id text NOT NULL,
  seat_no bigint NOT NULL,
  holder text NOT NULL,
  state text NOT NULL,
  reserved_until bigint NOT NULL DEFAULT 0
);
CREATE INDEX seats_cohort_idx ON seats (cohort_id);
CREATE INDEX seats_holder_idx ON seats (holder);
CREATE TABLE stripe_events (
  id text PRIMARY KEY,
  received_at bigint NOT NULL,
  state text NOT NULL DEFAULT 'received'
);
CREATE TABLE import_runs (
  id text PRIMARY KEY,
  source_sha256 text NOT NULL,
  counts text NOT NULL,
  table_checksums text NOT NULL,
  imported_at bigint NOT NULL
);
`;

export const MIGRATIONS = [{ version: "0001_initial", sql: V1 }].map((m) => ({ ...m, checksum: `sha256:${sha256Hex(m.sql)}` }));

/** Idempotent: NStack records checksums per version and refuses a changed version. */
export async function ensureSchema(db: NstackDb) {
  await db.provision();
  await db.migrate(MIGRATIONS);
}

export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
