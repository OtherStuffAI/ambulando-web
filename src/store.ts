import { NstackDb, type Row, type Where } from "./nstack.ts";
import { num } from "./schema.ts";

export interface User {
  id: number; npub: string; pubkey: string; username: string | null; email: string | null;
  display_name: string; avatar_url: string; agent_name: string;
  agent_npub: string; agent_avatar: string; agent_role: string; encrypted_agent_nsec: string; agent_encryption_scheme: string; password_hash: string | null; backup_json: string | null; created_at: number;
}
export interface Cohort {
  id: number; slug: string; title: string; tagline: string; description: string; highlights: string; modules: string;
  start_date: string; end_date: string; schedule: string; location: string; price_cents: number; currency: string;
  capacity: number; status: string; created_at: number; updated_at: number;
}
export interface Enrolment {
  id: number; user_id: number; cohort_id: number; status: "pending" | "paid" | "failed"; amount_cents: number; currency: string;
  stripe_session_id: string | null; stripe_payment_intent: string | null; reserved_until: number; created_at: number; paid_at: number | null;
}
export type CohortFields = Omit<Cohort, "id" | "created_at" | "updated_at">;
export type NewUser = { npub: string; pubkey: string; username?: string | null; email?: string | null; display_name?: string; agent_name?: string; password_hash?: string | null; backup_json?: string | null };

const MAX_RETRIES = 12;

const toUser = (r: Row): User => ({
  id: num(r.id), npub: r.npub, pubkey: r.pubkey, username: r.username ?? null, email: r.email ?? null,
  display_name: r.display_name ?? "", avatar_url: r.avatar_url ?? "", agent_name: r.agent_name ?? "",
  agent_npub: r.agent_npub ?? "", agent_avatar: r.agent_avatar ?? "", agent_role: r.agent_role ?? "",
  encrypted_agent_nsec: r.encrypted_agent_nsec ?? "", agent_encryption_scheme: r.agent_encryption_scheme ?? "",
  password_hash: r.password_hash ?? null, backup_json: r.backup_json ?? null, created_at: num(r.created_at),
});
const toCohort = (r: Row): Cohort => ({
  id: num(r.id), slug: r.slug, title: r.title, tagline: r.tagline ?? "", description: r.description ?? "", highlights: r.highlights ?? "[]", modules: r.modules ?? "[]",
  start_date: r.start_date ?? "", end_date: r.end_date ?? "", schedule: r.schedule ?? "", location: r.location ?? "", price_cents: num(r.price_cents), currency: r.currency,
  capacity: num(r.capacity), status: r.status, created_at: num(r.created_at), updated_at: num(r.updated_at),
});
const toEnrolment = (r: Row): Enrolment => ({
  id: num(r.id), user_id: num(r.user_id), cohort_id: num(r.cohort_id), status: r.status, amount_cents: num(r.amount_cents), currency: r.currency,
  stripe_session_id: r.stripe_session_id ?? null, stripe_payment_intent: r.stripe_payment_intent ?? null,
  reserved_until: num(r.reserved_until), created_at: num(r.created_at), paid_at: r.paid_at === null || r.paid_at === undefined ? null : num(r.paid_at),
});

const ORDER_ID = { field: "id" };

/**
 * All persistence for the website. NStack is the only durable source of truth: there is no
 * local cache or snapshot. Anything that must hold under concurrency is expressed as a unique
 * index (one row wins the insert) or a conditional update (compare-and-set), never as
 * read-then-write.
 */
export class Store {
  constructor(public db: NstackDb) {}

  // ---------- ids ----------
  /** Monotonic integer ids (legacy ids are integers). Compare-and-set loop, gaps are acceptable. */
  async nextId(name: string): Promise<number> {
    for (let i = 0; i < MAX_RETRIES * 4; i++) {
      const cur = await this.db.get("counters", name);
      if (!cur) {
        if (await this.db.insert("counters", name, { value: 2 })) return 1;
        continue;
      }
      const v = num(cur.value);
      if (await this.db.update("counters", name, { value: v + 1 }, { value: { eq: v } })) return v;
    }
    throw new Error(`Could not allocate id for ${name}`);
  }
  /** Raises a counter to at least `atLeast`; used by the importer. */
  async ensureCounterAtLeast(name: string, atLeast: number) {
    for (let i = 0; i < MAX_RETRIES; i++) {
      const cur = await this.db.get("counters", name);
      if (!cur) { if (await this.db.insert("counters", name, { value: atLeast })) return; continue; }
      if (num(cur.value) >= atLeast) return;
      if (await this.db.update("counters", name, { value: atLeast }, { value: { eq: num(cur.value) } })) return;
    }
    throw new Error(`Could not raise counter ${name}`);
  }

  // ---------- settings ----------
  async getSetting(k: string): Promise<string | null> { return (await this.db.get("settings", k))?.value ?? null; }
  async setSetting(k: string, v: string) {
    if (await this.db.insert("settings", k, { value: v })) return;
    await this.db.update("settings", k, { value: v });
  }
  async delSetting(k: string) { await this.db.delete("settings", k); }

  // ---------- auth challenges ----------
  async createChallenge(nonce: string, expiresAt: number) {
    await this.db.insert("auth_challenges", nonce, { expires_at: expiresAt });
    // Opportunistic bounded cleanup; never blocks login.
    this.db.query("auth_challenges", { where: { expires_at: { lt: Date.now() } }, select: ["id"], limit: 25 })
      .then((rows) => Promise.all(rows.map((r) => this.db.delete("auth_challenges", r.id)))).catch(() => {});
  }
  /** Single use: only the caller whose delete removes the row wins. */
  async consumeChallenge(nonce: string): Promise<boolean> {
    const row = await this.db.get("auth_challenges", nonce);
    if (!row || num(row.expires_at) <= Date.now()) { if (row) await this.db.delete("auth_challenges", nonce); return false; }
    return this.db.delete("auth_challenges", nonce);
  }

  // ---------- users ----------
  async userById(id: number): Promise<User | null> { const r = await this.db.get("users", String(id)); return r ? toUser(r) : null; }
  async userByPubkey(pubkey: string): Promise<User | null> { const r = (await this.db.query("users", { where: { pubkey: { eq: pubkey } }, limit: 1 }))[0]; return r ? toUser(r) : null; }
  async userByUsername(name: string): Promise<User | null> { const r = (await this.db.query("users", { where: { username_lc: { eq: name.toLowerCase() } }, limit: 1 }))[0]; return r ? toUser(r) : null; }
  async usersByIds(ids: number[]): Promise<Map<number, User>> {
    const out = new Map<number, User>();
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 100) {
      for (const r of await this.db.query("users", { where: { id: { in: uniq.slice(i, i + 100).map(String) } }, limit: 100 })) out.set(num(r.id), toUser(r));
    }
    return out;
  }
  /** Unique indexes on npub/pubkey/username decide races; the loser gets `conflict`. */
  async createUser(u: NewUser): Promise<{ user: User } | { conflict: "username" | "npub" }> {
    const id = await this.nextId("users");
    const row = await this.db.insert("users", String(id), {
      npub: u.npub, pubkey: u.pubkey, username: u.username ?? null, username_lc: u.username ? u.username.toLowerCase() : null,
      email: u.email ?? null, display_name: u.display_name ?? "", agent_name: u.agent_name ?? "", password_hash: u.password_hash ?? null,
      backup_json: u.backup_json ?? null, created_at: Date.now(),
    });
    if (row) return { user: toUser(row) };
    if (u.username && await this.userByUsername(u.username)) return { conflict: "username" };
    return { conflict: "npub" };
  }
  async updateUser(id: number, set: Partial<Omit<User, "id">>): Promise<User> {
    const r = await this.db.update("users", String(id), set as Row);
    if (!r) throw new Error("User not found");
    return toUser(r);
  }

  /** Compensation for a signup whose seat could not be reserved. Only used on a row created moments ago. */
  deleteUser(id: number) { return this.db.delete("users", String(id)); }

  // ---------- sessions ----------
  async createSession(tokenHash: string, userId: number, method: "nostr" | "password", expiresAt: number) {
    const now = Date.now();
    await this.db.insert("sessions", tokenHash, { user_id: String(userId), method, expires_at: expiresAt, created_at: now });
    this.db.query("sessions", { where: { expires_at: { lt: now } }, select: ["id"], limit: 25 })
      .then((rows) => Promise.all(rows.map((r) => this.db.delete("sessions", r.id)))).catch(() => {});
  }
  async sessionUser(tokenHash: string): Promise<{ user: User; method: string } | null> {
    const s = await this.db.get("sessions", tokenHash);
    if (!s || num(s.expires_at) <= Date.now()) return null;
    const user = await this.userById(num(s.user_id));
    return user ? { user, method: s.method } : null;
  }
  deleteSession(tokenHash: string) { return this.db.delete("sessions", tokenHash); }

  // ---------- cohorts ----------
  async cohortById(id: number): Promise<Cohort | null> { const r = await this.db.get("cohorts", String(id)); return r ? toCohort(r) : null; }
  async cohortBySlug(slug: string): Promise<Cohort | null> { const r = (await this.db.query("cohorts", { where: { slug: { eq: slug } }, limit: 1 }))[0]; return r ? toCohort(r) : null; }
  async listCohorts(opts: { published?: boolean } = {}): Promise<Cohort[]> {
    const where: Where | undefined = opts.published ? { status: { eq: "published" } } : undefined;
    const rows = (await this.db.queryAll("cohorts", { where, order: [ORDER_ID] })).map(toCohort);
    return opts.published
      ? rows.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id)
      : rows.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  }
  async createCohort(c: CohortFields, atId?: number): Promise<Cohort | null> {
    const id = atId ?? await this.nextId("cohorts");
    const now = Date.now();
    const row = await this.db.insert("cohorts", String(id), { ...c, created_at: now, updated_at: now });
    return row ? toCohort(row) : null;
  }
  async updateCohort(id: number, c: CohortFields): Promise<Cohort | null> {
    const r = await this.db.update("cohorts", String(id), { ...c, updated_at: Date.now() });
    return r ? toCohort(r) : null;
  }

  // ---------- enrolments & seats ----------
  async enrolmentById(id: number): Promise<Enrolment | null> { const r = await this.db.get("enrolments", String(id)); return r ? toEnrolment(r) : null; }
  async enrolmentFor(userId: number, cohortId: number): Promise<Enrolment | null> {
    const r = (await this.db.query("enrolments", { where: { user_id: { eq: String(userId) }, cohort_id: { eq: String(cohortId) } }, limit: 1 }))[0];
    return r ? toEnrolment(r) : null;
  }
  async enrolmentsForUser(userId: number): Promise<Enrolment[]> {
    return (await this.db.queryAll("enrolments", { where: { user_id: { eq: String(userId) } }, order: [{ field: "created_at", dir: "desc" }, ORDER_ID] })).map(toEnrolment);
  }
  async enrolmentsForCohort(cohortId: number): Promise<Enrolment[]> {
    return (await this.db.queryAll("enrolments", { where: { cohort_id: { eq: String(cohortId) } }, order: [{ field: "created_at", dir: "desc" }, ORDER_ID] })).map(toEnrolment);
  }
  async cohortsByIds(ids: number[]): Promise<Map<number, Cohort>> {
    const out = new Map<number, Cohort>();
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 100) {
      for (const r of await this.db.query("cohorts", { where: { id: { in: uniq.slice(i, i + 100).map(String) } }, limit: 100 })) out.set(num(r.id), toCohort(r));
    }
    return out;
  }
  async paidCount(cohortId: number) { return (await this.enrolmentsForCohort(cohortId)).filter((e) => e.status === "paid").length; }
  async revenue(cohortId: number) { return (await this.enrolmentsForCohort(cohortId)).filter((e) => e.status === "paid").reduce((n, e) => n + e.amount_cents, 0); }

  private seatRows(cohortId: number) { return this.db.queryAll("seats", { where: { cohort_id: { eq: String(cohortId) } }, order: [{ field: "seat_no" }, ORDER_ID] }); }
  private static active(r: Row, now: number) { return r.state === "paid" || (r.state === "held" && num(r.reserved_until) > now); }
  /** Seats currently held (paid, or reserved and unexpired). */
  async seatsTaken(cohortId: number): Promise<number> {
    const now = Date.now();
    return (await this.seatRows(cohortId)).filter((r) => Store.active(r, now)).length;
  }
  private async seatOf(enrolmentId: number): Promise<Row | null> {
    return (await this.db.query("seats", { where: { holder: { eq: String(enrolmentId) } }, limit: 1 }))[0] ?? null;
  }

  /**
   * Claims one seat for `enrolmentId`. Seats are rows with a unique id `${cohort}:${n}`, so
   * two concurrent claimants can never both win the same seat; an expired reservation is taken
   * over with a compare-and-set on its current holder. `force` (a late payment that must be
   * honoured) may go past capacity. Returns false when the cohort is full.
   */
  async claimSeat(cohort: Cohort, enrolmentId: number, reservedUntil: number, opts: { state?: "held" | "paid"; force?: boolean } = {}): Promise<boolean> {
    const state = opts.state ?? "held";
    const holder = String(enrolmentId);
    for (let pass = 0; pass < MAX_RETRIES; pass++) {
      const now = Date.now();
      const rows = await this.seatRows(cohort.id);
      const mine = rows.find((r) => r.holder === holder);
      if (mine) {
        if (mine.state === "paid") return true;
        // Compare-and-set on everything we read: a concurrent confirmSeat (-> paid) or takeover must never be undone.
        if (await this.db.update("seats", mine.id, { reserved_until: reservedUntil, state }, { holder: { eq: holder }, state: { eq: mine.state }, reserved_until: { eq: num(mine.reserved_until) } })) return true;
        continue; // changed meanwhile: look again (a paid seat then returns true above)
      }
      const byNo = new Map(rows.map((r) => [num(r.seat_no), r]));
      const limit = opts.force ? Math.max(cohort.capacity, ...rows.map((r) => num(r.seat_no))) + 1 : cohort.capacity;
      let progressed = false;
      for (let n = 1; n <= limit; n++) {
        const row = byNo.get(n);
        const id = `${cohort.id}:${n}`;
        let won = false;
        if (!row) won = !!(await this.db.insert("seats", id, { cohort_id: String(cohort.id), seat_no: n, holder, state, reserved_until: reservedUntil }));
        else if (row.state === "held" && num(row.reserved_until) <= now) {
          won = !!(await this.db.update("seats", id, { holder, state, reserved_until: reservedUntil }, { holder: { eq: row.holder }, state: { eq: "held" }, reserved_until: { eq: num(row.reserved_until) } }));
        } else continue;
        if (!won) { progressed = true; continue; }
        if (opts.force) return true;
        // Capacity may have been lowered below seats already held; fail closed.
        if ((await this.seatsTaken(cohort.id)) <= cohort.capacity) return true;
        await this.db.update("seats", id, { state: "held", reserved_until: 0 }, { holder: { eq: holder } });
        return false;
      }
      if (!progressed) return false;
    }
    return false;
  }
  async releaseSeat(enrolmentId: number) {
    const s = await this.seatOf(enrolmentId);
    if (s && s.state === "held") await this.db.update("seats", s.id, { reserved_until: 0 }, { holder: { eq: String(enrolmentId) }, state: { eq: "held" } });
  }
  async confirmSeat(cohort: Cohort, enrolmentId: number): Promise<void> {
    const s = await this.seatOf(enrolmentId);
    if (s && await this.db.update("seats", s.id, { state: "paid", reserved_until: 0 }, { holder: { eq: String(enrolmentId) } })) return;
    // Reservation lapsed and was reused: the payment is real, so take a seat even past capacity.
    // Failing here is deliberate: the caller leaves the enrolment pending and Stripe's retry (or the buyer's return) repeats this.
    if (!(await this.claimSeat(cohort, enrolmentId, 0, { state: "paid", force: true }))) throw new Error(`Could not record a seat for paid enrolment ${enrolmentId}`);
  }

  /**
   * Reserves a seat and returns the pending enrolment. Safe under concurrent callers:
   * the (user,cohort) unique index admits one enrolment row and seat rows admit one holder.
   */
  async reserve(user: User, cohort: Cohort, reservedUntil: number): Promise<{ enrolment: Enrolment } | { error: "already_enrolled" | "cohort_full" }> {
    for (let i = 0; i < MAX_RETRIES; i++) {
      const existing = await this.enrolmentFor(user.id, cohort.id);
      if (existing?.status === "paid") return { error: "already_enrolled" };
      if (existing) {
        if (!(await this.claimSeat(cohort, existing.id, reservedUntil))) return { error: "cohort_full" };
        const row = await this.db.update("enrolments", String(existing.id), { status: "pending", amount_cents: cohort.price_cents, currency: cohort.currency, reserved_until: reservedUntil }, { status: { neq: "paid" } });
        if (!row) continue; // paid concurrently
        return { enrolment: toEnrolment(row) };
      }
      const id = await this.nextId("enrolments");
      if (!(await this.claimSeat(cohort, id, reservedUntil))) return { error: "cohort_full" };
      const row = await this.db.insert("enrolments", String(id), { user_id: String(user.id), cohort_id: String(cohort.id), status: "pending", amount_cents: cohort.price_cents, currency: cohort.currency, reserved_until: reservedUntil, created_at: Date.now() });
      if (row) return { enrolment: toEnrolment(row) };
      await this.releaseSeat(id); // lost the (user,cohort) race: use the winner's row
    }
    throw new Error("Could not reserve a seat");
  }
  attachCheckout(enrolmentId: number, sessionId: string) {
    return this.db.update("enrolments", String(enrolmentId), { stripe_session_id: sessionId }, { status: { neq: "paid" } });
  }

  /** Idempotent: only the first settlement changes the row. */
  async markPaid(cohort: Cohort, enr: Enrolment, p: { sessionId: string; amount: number | null; paymentIntent: string | null }) {
    if (enr.status === "paid") return;
    await this.confirmSeat(cohort, enr.id);
    const set: Row = { status: "paid", paid_at: Date.now(), stripe_session_id: p.sessionId };
    if (p.amount !== null) set.amount_cents = p.amount;
    if (p.paymentIntent) set.stripe_payment_intent = p.paymentIntent;
    await this.db.update("enrolments", String(enr.id), set, { status: { neq: "paid" } });
  }
  async markFailed(enr: Enrolment, opts: { sessionId?: string } = {}) {
    const where: Where = { status: { eq: "pending" } };
    if (opts.sessionId) where.stripe_session_id = { eq: opts.sessionId };
    if (await this.db.update("enrolments", String(enr.id), { status: "failed" }, where)) await this.releaseSeat(enr.id);
  }

  // ---------- stripe events ----------
  /** Returns true when this event was already fully processed. Unfinished ones are reprocessed (settlement is idempotent). */
  async beginStripeEvent(id: string): Promise<boolean> {
    if (await this.db.insert("stripe_events", id, { received_at: Date.now(), state: "received" })) return false;
    return (await this.db.get("stripe_events", id))?.state === "done";
  }
  finishStripeEvent(id: string) { return this.db.update("stripe_events", id, { state: "done" }); }

  // ---------- seed ----------
  async seedIfEmpty(seed: CohortFields) {
    if (await this.getSetting("seeded")) return;
    if ((await this.db.query("cohorts", { select: ["id"], limit: 1 })).length === 0) await this.createCohort(seed);
    await this.setSetting("seeded", "1");
  }
}
