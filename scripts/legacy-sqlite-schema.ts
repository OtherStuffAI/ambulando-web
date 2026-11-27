import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    npub TEXT NOT NULL UNIQUE,
    pubkey TEXT NOT NULL UNIQUE,
    username TEXT UNIQUE COLLATE NOCASE,
    email TEXT,
    display_name TEXT NOT NULL DEFAULT '',
    agent_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    backup_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    method TEXT NOT NULL CHECK (method IN ('nostr','password')),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE auth_challenges (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE cohorts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    tagline TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    highlights TEXT NOT NULL DEFAULT '[]',
    modules TEXT NOT NULL DEFAULT '[]',
    start_date TEXT NOT NULL DEFAULT '',
    end_date TEXT NOT NULL DEFAULT '',
    schedule TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'aud',
    capacity INTEGER NOT NULL DEFAULT 20,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE enrolments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    cohort_id INTEGER NOT NULL REFERENCES cohorts(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
    amount_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'aud',
    stripe_session_id TEXT,
    stripe_payment_intent TEXT,
    reserved_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    paid_at INTEGER,
    UNIQUE (user_id, cohort_id)
  );
  CREATE INDEX idx_enrolments_session ON enrolments(stripe_session_id);
  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  );`,
  // Nostr profile cache + Chief of Staff agent identity. encrypted_agent_nsec is NIP-44 self-encrypted client side; the server cannot read it.
  `ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN agent_npub TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN agent_avatar TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN agent_role TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN encrypted_agent_nsec TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN agent_encryption_scheme TEXT NOT NULL DEFAULT '';`,
];

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  seedIfEmpty(db);
  return db;
}

function seedIfEmpty(db: Database) {
  const seeded = db.query("SELECT value FROM settings WHERE key='seeded'").get();
  const count = (db.query("SELECT COUNT(*) AS n FROM cohorts").get() as { n: number }).n;
  if (seeded || count > 0) return;
  const now = Date.now();
  db.query(
    `INSERT INTO cohorts (slug,title,tagline,description,highlights,modules,start_date,end_date,schedule,location,price_cents,currency,capacity,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "chief-of-staff-foundations",
    "Chief of Staff Foundations",
    "Learn to direct an agent team that works while you walk.",
    "A four-week live cohort for people who want to put AI agents to work without losing their head. You will set up your own Ambulando workspace, name and shape your Chief of Staff agent, and leave with workflows you actually use.\n\nEvery participant receives a fresh Nostr identity, backed up behind their password, so your agents and your data stay yours.",
    JSON.stringify(["Your own Ambulando workspace and Nostr identity", "A named Chief of Staff agent, configured for your work", "Live weekly sessions with recordings", "A small cohort with direct feedback"]),
    JSON.stringify([
      { title: "Week 1 · Direction", summary: "Think out loud, define what matters and brief your first agent." },
      { title: "Week 2 · Delegation", summary: "Tasks, approvals and the review loop that keeps you in control." },
      { title: "Week 3 · Memory", summary: "Documents, channels and the knowledge your team keeps." },
      { title: "Week 4 · Rhythm", summary: "Weekly cadence, exceptions and staying sane as the work scales." },
    ]),
    "2027-02-02", "2027-02-23", "4 weeks · Live Tuesdays", "Online + Ambulando Cohort Workspace",
    49500, "aud", 20, "published", now, now,
  );
  db.query("INSERT OR REPLACE INTO settings (key,value) VALUES ('seeded','1')").run();
}
