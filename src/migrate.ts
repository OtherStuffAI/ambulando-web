import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { NstackDb, type Row } from "./nstack.ts";
import { SecretBox } from "./secrets.ts";
import { Store } from "./store.ts";

/**
 * Repeatable import of the legacy SQLite database into the NStack namespace.
 *  - Preserves every id (integers become decimal-string ids), session token hashes, Stripe event ids,
 *    password hashes, encrypted key backups and NIP-44 agent ciphertext byte for byte.
 *  - Idempotent: a row that already exists must be identical, otherwise the import stops (never overwrites).
 *  - Verifies row counts and a canonical SHA-256 per table by reading everything back from NStack.
 *  - Records exactly which ids this run created so `rollback` removes only those. The SQLite source is only read.
 * Stripe secrets are re-sealed from the legacy key to APP_SECRET_KEY because the legacy key file lived in the
 * ephemeral container filesystem.
 */

type Spec = { table: string; source: string; order: string; map: (r: any) => Row; skipExpired?: (r: any, now: number) => boolean };
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

export const TABLES: Spec[] = [
  { table: "users", source: "users", order: "id", map: (r) => ({ id: s(r.id), npub: r.npub, pubkey: r.pubkey, username: r.username ?? null, username_lc: r.username ? String(r.username).toLowerCase() : null, email: r.email ?? null, display_name: r.display_name ?? "", agent_name: r.agent_name ?? "", password_hash: r.password_hash ?? null, backup_json: r.backup_json ?? null, created_at: s(r.created_at), avatar_url: r.avatar_url ?? "", agent_npub: r.agent_npub ?? "", agent_avatar: r.agent_avatar ?? "", agent_role: r.agent_role ?? "", encrypted_agent_nsec: r.encrypted_agent_nsec ?? "", agent_encryption_scheme: r.agent_encryption_scheme ?? "" }) },
  { table: "cohorts", source: "cohorts", order: "id", map: (r) => ({ id: s(r.id), slug: r.slug, title: r.title, tagline: r.tagline, description: r.description, highlights: r.highlights, modules: r.modules, start_date: r.start_date, end_date: r.end_date, schedule: r.schedule, location: r.location, price_cents: s(r.price_cents), currency: r.currency, capacity: s(r.capacity), status: r.status, created_at: s(r.created_at), updated_at: s(r.updated_at) }) },
  { table: "enrolments", source: "enrolments", order: "id", map: (r) => ({ id: s(r.id), user_id: s(r.user_id), cohort_id: s(r.cohort_id), status: r.status, amount_cents: s(r.amount_cents), currency: r.currency, stripe_session_id: r.stripe_session_id ?? null, stripe_payment_intent: r.stripe_payment_intent ?? null, reserved_until: s(r.reserved_until), created_at: s(r.created_at), paid_at: s(r.paid_at) }) },
  { table: "sessions", source: "sessions", order: "token_hash", map: (r) => ({ id: r.token_hash, user_id: s(r.user_id), method: r.method, expires_at: s(r.expires_at), created_at: s(r.created_at) }), skipExpired: (r, now) => r.expires_at <= now },
  { table: "stripe_events", source: "stripe_events", order: "id", map: (r) => ({ id: r.id, received_at: s(r.received_at), state: "done" }) },
];
// settings are handled separately (Stripe secrets are re-sealed); auth_challenges are 5-minute nonces and are not carried over.

export interface Manifest {
  version: 1; sourceSha256: string; startedAt: number; counts: Record<string, number>; checksums: Record<string, string>;
  created: Record<string, string[]>; counters: Record<string, number>; skipped: Record<string, number>;
}

const canon = (rows: Row[], cols: string[]) =>
  createHash("sha256").update(JSON.stringify([...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? null : String(r[c])))))).digest("hex");

const sameRow = (want: Row, have: Row) => Object.keys(want).every((k) => (want[k] === null ? have[k] === null || have[k] === undefined : String(have[k]) === String(want[k])));

export interface ImportOptions { sourceBox?: SecretBox; targetBox?: SecretBox; dryRun?: boolean; now?: number; sourceSha256?: string }

export async function importSqlite(src: Database, store: Store, opts: ImportOptions = {}): Promise<Manifest> {
  const now = opts.now ?? Date.now();
  const db = store.db;
  const m: Manifest = { version: 1, sourceSha256: opts.sourceSha256 ?? "", startedAt: now, counts: {}, checksums: {}, created: {}, counters: {}, skipped: {} };
  const wanted: Record<string, Row[]> = {};

  for (const spec of TABLES) {
    const all = src.query(`SELECT * FROM ${spec.source} ORDER BY ${spec.order}`).all() as any[];
    const keep = all.filter((r) => !spec.skipExpired?.(r, now));
    m.skipped[spec.table] = all.length - keep.length;
    wanted[spec.table] = keep.map(spec.map);
  }

  // settings: copy plain values; re-seal Stripe secrets under the new key.
  const settings: Row[] = [];
  for (const r of src.query("SELECT key, value FROM settings ORDER BY key").all() as { key: string; value: string }[]) {
    let value = r.value;
    if (r.key === "stripe_secret" || r.key === "stripe_webhook") {
      if (!opts.sourceBox || !opts.targetBox) throw new Error(`Cannot carry ${r.key}: provide the legacy key and APP_SECRET_KEY so it can be re-sealed`);
      const plain = await opts.sourceBox.open(r.value); // fails loudly if the legacy key is wrong
      // Re-runs must be identical: keep the ciphertext already stored when it decodes to the same secret.
      const have = (await db.get("settings", r.key))?.value as string | undefined;
      const same = have ? await opts.targetBox.open(have).then((p) => p === plain, () => false) : false;
      value = same ? have! : await opts.targetBox.seal(plain);
    }
    settings.push({ id: r.key, value });
  }
  wanted.settings = settings;

  // seats are derived: legacy rows had no seat table. Paid first, then live reservations, in enrolment order.
  const seats: Row[] = [];
  for (const c of wanted.cohorts) {
    const holders = wanted.enrolments.filter((e) => e.cohort_id === c.id && (e.status === "paid" || (e.status === "pending" && Number(e.reserved_until) > now)))
      .sort((a, b) => (a.status === b.status ? Number(a.id) - Number(b.id) : a.status === "paid" ? -1 : 1));
    holders.forEach((e, i) => seats.push({ id: `${c.id}:${i + 1}`, cohort_id: c.id, seat_no: String(i + 1), holder: e.id, state: e.status === "paid" ? "paid" : "held", reserved_until: e.status === "paid" ? "0" : e.reserved_until }));
  }
  wanted.seats = seats;

  const order = ["users", "cohorts", "enrolments", "seats", "sessions", "stripe_events", "settings"];
  for (const t of order) {
    m.counts[t] = wanted[t].length;
    m.created[t] = [];
    if (opts.dryRun) continue;
    for (const row of wanted[t]) {
      const { id, ...data } = row;
      if (await db.insert(t, id, data)) { m.created[t].push(id); continue; }
      const have = await db.get(t, id);
      if (!have || !sameRow(row, have)) throw new Error(`Import stopped: ${t} ${id} already exists with different content (not overwritten)`);
    }
  }

  // counters continue after the highest imported id (legacy AUTOINCREMENT semantics).
  for (const [name, t] of [["users", "users"], ["cohorts", "cohorts"], ["enrolments", "enrolments"]] as const) {
    const max = Math.max(0, ...wanted[t].map((r) => Number(r.id)));
    m.counters[name] = max + 1;
    if (!opts.dryRun) await store.ensureCounterAtLeast(name, max + 1);
  }

  if (!opts.dryRun) {
    const cols: Record<string, string[]> = {};
    for (const t of order) cols[t] = Object.keys(wanted[t][0] ?? { id: 1 }).filter((c) => c !== "id");
    for (const t of order) {
      const remote = (await db.queryAll(t, { order: [{ field: "id" }] })).filter((r) => wanted[t].some((w) => w.id === r.id));
      const c = ["id", ...cols[t]];
      const a = canon(wanted[t], c), b = canon(remote, c);
      m.checksums[t] = a;
      if (remote.length !== wanted[t].length || a !== b) throw new Error(`Verification failed for ${t}: source ${wanted[t].length} rows ${a.slice(0, 12)} vs NStack ${remote.length} rows ${b.slice(0, 12)}`);
    }
    await db.insert("import_runs", `import-${now}`, { source_sha256: m.sourceSha256, counts: JSON.stringify(m.counts), table_checksums: JSON.stringify(m.checksums), imported_at: now });
  } else {
    for (const t of order) m.checksums[t] = canon(wanted[t], ["id", ...Object.keys(wanted[t][0] ?? {}).filter((c) => c !== "id")]);
  }
  return m;
}

/** Removes only the rows a given import run created (never rows that pre-existed or were written by the live site since). */
export async function rollbackImport(db: NstackDb, m: Manifest): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const t of ["settings", "stripe_events", "sessions", "seats", "enrolments", "cohorts", "users"]) {
    removed[t] = 0;
    for (const id of m.created[t] ?? []) if (await db.delete(t, id)) removed[t]++;
  }
  return removed;
}
