import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { decodePointer, npubEncode, verifyEvent } from "applesauce-core/helpers";
import { type Config, loadConfig, npubToHex } from "./config.ts";
import { openDb } from "./db.ts";
import { SecretBox } from "./secrets.ts";
import { realStripe, verifyStripeSignature, type StripeClient, type StripeFactory, type CheckoutSession } from "./stripe.ts";
import type { BackupBundle } from "./shared/backup.ts";
import { renderPage } from "./views.ts";
import { clientBundle, APP_CSS } from "./assets.ts";

export const AUTH_KIND = 22242;
const SESSION_TTL_MS = 14 * 24 * 3600_000;
const RESERVATION_MS = 32 * 60_000;
const CURRENCIES = ["aud", "usd", "eur", "gbp", "nzd", "cad"];

export interface AppOptions {
  config?: Partial<Config>;
  stripeFactory?: StripeFactory;
  db?: Database;
}

export interface User {
  id: number; npub: string; pubkey: string; username: string | null; email: string | null;
  display_name: string; avatar_url: string; agent_name: string;
  agent_npub: string; agent_avatar: string; agent_role: string; encrypted_agent_nsec: string; agent_encryption_scheme: string; password_hash: string | null; backup_json: string | null; created_at: number;
}
interface Cohort {
  id: number; slug: string; title: string; tagline: string; description: string; highlights: string; modules: string;
  start_date: string; end_date: string; schedule: string; location: string; price_cents: number; currency: string;
  capacity: number; status: string; created_at: number; updated_at: number;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".md": "text/markdown; charset=utf-8",
  ".json": "application/json", ".ico": "image/x-icon", ".mp4": "video/mp4",
};

export function maskKey(key: string | null): string | null {
  if (!key) return null;
  const m = key.match(/^([a-z]+_(?:test|live)_)/);
  return `${m ? m[1] : key.slice(0, 3)}••••${key.slice(-4)}`;
}

export async function createApp(opts: AppOptions = {}) {
  const config = loadConfig(opts.config);
  const db = opts.db ?? openDb(config.databasePath);
  const box = await SecretBox.create({ secretKey: config.secretKey, databasePath: config.databasePath });
  const stripeFactory = opts.stripeFactory ?? realStripe;
  const loginAttempts = new Map<string, { n: number; reset: number }>();

  // ---------- settings ----------
  const getSetting = (k: string) => (db.query("SELECT value FROM settings WHERE key=?").get(k) as { value: string } | null)?.value ?? null;
  const setSetting = (k: string, v: string) => db.query("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run(k, v);
  const delSetting = (k: string) => db.query("DELETE FROM settings WHERE key=?").run(k);
  const getSecret = async (k: string) => { const v = getSetting(k); return v ? box.open(v) : null; };

  async function stripeSettings() {
    const sk = await getSecret("stripe_secret");
    const wh = await getSecret("stripe_webhook");
    const pk = getSetting("stripe_publishable");
    return { sk, wh, pk };
  }
  async function stripeView() {
    const { sk, wh, pk } = await stripeSettings();
    return {
      configured: !!(sk && pk),
      mode: sk ? (sk.includes("_live_") ? "live" : "test") : null,
      publishableKey: pk,
      secretKeyHint: maskKey(sk),
      secretKeyConfigured: !!sk,
      webhookSecretConfigured: !!wh,
      webhookSecretHint: wh ? `whsec_••••${wh.slice(-4)}` : null,
    };
  }
  async function stripeClient(): Promise<StripeClient | null> {
    const { sk } = await stripeSettings();
    return sk ? stripeFactory(sk) : null;
  }

  // ---------- sessions / auth ----------
  const cookieName = "amb_session";
  function readCookie(req: Request, name: string) {
    const c = req.headers.get("cookie") ?? "";
    for (const part of c.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === name) return decodeURIComponent(v.join("="));
    }
    return null;
  }
  function sessionCookie(req: Request, token: string | null) {
    const secure = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
    const base = `${cookieName}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
    return token ? `${base}; Max-Age=${SESSION_TTL_MS / 1000}` : `${base}; Max-Age=0`;
  }
  function createSession(userId: number, method: "nostr" | "password") {
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    db.query("INSERT INTO sessions (token_hash,user_id,method,expires_at,created_at) VALUES (?,?,?,?,?)").run(sha(token), userId, method, now + SESSION_TTL_MS, now);
    db.query("DELETE FROM sessions WHERE expires_at < ?").run(now);
    return token;
  }
  function currentSession(req: Request): { user: User; method: string; isAdmin: boolean } | null {
    const token = readCookie(req, cookieName);
    if (!token) return null;
    const row = db.query(
      "SELECT u.*, s.method AS _method FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
    ).get(sha(token), Date.now()) as (User & { _method: string }) | null;
    if (!row) return null;
    const { _method, ...user } = row;
    return { user, method: _method, isAdmin: _method === "nostr" && config.adminPubkeys.has(user.pubkey) };
  }
  const requireUser = (req: Request) => currentSession(req) ?? (() => { throw new HttpError(401, "Sign in required", "unauthenticated"); })();
  const requireAdmin = (req: Request) => {
    const s = requireUser(req);
    if (!s.isAdmin) throw new HttpError(403, "Admin access required", "forbidden");
    return s;
  };

  function userView(u: User, isAdmin = false) {
    return { id: u.id, npub: u.npub, username: u.username, email: u.email, displayName: u.display_name, avatarUrl: u.avatar_url, agentName: u.agent_name, agentNpub: u.agent_npub, agentAvatar: u.agent_avatar, agentRole: u.agent_role, hasAgentKey: !!u.encrypted_agent_nsec, hasPassword: !!u.password_hash, hasBackup: !!u.backup_json, isAdmin };
  }

  // ---------- cohorts ----------
  function seatsTaken(cohortId: number, exceptEnrolmentId = 0) {
    const r = db.query(
      "SELECT COUNT(*) AS n FROM enrolments WHERE cohort_id=? AND id!=? AND (status='paid' OR (status='pending' AND reserved_until>?))",
    ).get(cohortId, exceptEnrolmentId, Date.now()) as { n: number };
    return r.n;
  }
  function paidCount(cohortId: number) {
    return (db.query("SELECT COUNT(*) AS n FROM enrolments WHERE cohort_id=? AND status='paid'").get(cohortId) as { n: number }).n;
  }
  function cohortView(c: Cohort) {
    const taken = seatsTaken(c.id);
    return {
      id: c.id, slug: c.slug, title: c.title, tagline: c.tagline, description: c.description,
      highlights: JSON.parse(c.highlights) as string[], modules: JSON.parse(c.modules) as { title: string; summary: string }[],
      startDate: c.start_date, endDate: c.end_date, schedule: c.schedule, location: c.location,
      priceCents: c.price_cents, currency: c.currency, capacity: c.capacity, status: c.status,
      enrolled: paidCount(c.id), seatsLeft: Math.max(0, c.capacity - taken),
    };
  }
  const cohortBySlug = (slug: string) => db.query("SELECT * FROM cohorts WHERE slug=?").get(slug) as Cohort | null;
  const cohortById = (id: number) => db.query("SELECT * FROM cohorts WHERE id=?").get(id) as Cohort | null;

  function parseCohort(body: any, existing?: Cohort) {
    const str = (k: string, max: number, fallback = "") => {
      const v = body[k] === undefined ? fallback : String(body[k] ?? "").trim();
      if (v.length > max) throw new HttpError(400, `${k} is too long`);
      return v;
    };
    const title = str("title", 160, existing?.title);
    if (!title) throw new HttpError(400, "Title is required");
    const slug = str("slug", 80, existing?.slug) || title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError(400, "Slug must be lowercase letters, numbers and hyphens");
    const date = (k: string, fb: string) => {
      const v = str(k, 10, fb);
      if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${k} must be YYYY-MM-DD`);
      return v;
    };
    const startDate = date("startDate", existing?.start_date ?? ""), endDate = date("endDate", existing?.end_date ?? "");
    if (startDate && endDate && endDate < startDate) throw new HttpError(400, "End date must be after start date");
    const price = body.priceCents !== undefined ? body.priceCents : body.priceDollars !== undefined ? Math.round(Number(body.priceDollars) * 100) : existing?.price_cents ?? 0;
    if (!Number.isInteger(price) || price < 0 || price > 100_000_00) throw new HttpError(400, "Price is invalid");
    const currency = str("currency", 3, existing?.currency ?? "aud").toLowerCase();
    if (!CURRENCIES.includes(currency)) throw new HttpError(400, `Currency must be one of ${CURRENCIES.join(", ")}`);
    const capacity = body.capacity !== undefined ? Number(body.capacity) : existing?.capacity ?? 20;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10_000) throw new HttpError(400, "Capacity must be a whole number of at least 1");
    const status = str("status", 20, existing?.status ?? "draft");
    if (!["draft", "published", "archived"].includes(status)) throw new HttpError(400, "Status must be draft, published or archived");
    const list = (v: unknown, fb: string) => {
      if (v === undefined) return fb;
      const arr = (Array.isArray(v) ? v : String(v).split("\n")).map((x) => String(x).trim()).filter(Boolean);
      return JSON.stringify(arr.slice(0, 40));
    };
    let modules = existing?.modules ?? "[]";
    if (body.modules !== undefined) {
      const arr = Array.isArray(body.modules) ? body.modules : String(body.modules).split("\n").map((l) => l.trim()).filter(Boolean);
      modules = JSON.stringify(arr.slice(0, 40).map((m: any) => {
        if (typeof m === "string") { const [t, ...rest] = m.split(/\s+[—–-]\s+/); return { title: t.trim(), summary: rest.join(" — ").trim() }; }
        return { title: String(m.title ?? "").trim(), summary: String(m.summary ?? "").trim() };
      }).filter((m: any) => m.title));
    }
    return {
      slug, title, tagline: str("tagline", 240, existing?.tagline), description: str("description", 10_000, existing?.description),
      highlights: list(body.highlights, existing?.highlights ?? "[]"), modules, start_date: startDate, end_date: endDate,
      schedule: str("schedule", 160, existing?.schedule), location: str("location", 160, existing?.location),
      price_cents: price, currency, capacity, status,
    };
  }

  // ---------- enrolment settlement ----------
  function settle(enrolmentId: number, s: CheckoutSession): "paid" | "failed" | "pending" {
    const paid = s.payment_status === "paid" || s.payment_status === "no_payment_required";
    if (paid) {
      // Idempotent: only the first settlement changes the row.
      db.query(
        "UPDATE enrolments SET status='paid', paid_at=?, amount_cents=COALESCE(?,amount_cents), stripe_payment_intent=COALESCE(?,stripe_payment_intent), stripe_session_id=? WHERE id=? AND status!='paid'",
      ).run(Date.now(), s.amount_total ?? null, s.payment_intent ?? null, s.id, enrolmentId);
      return "paid";
    }
    if (s.status === "expired") {
      db.query("UPDATE enrolments SET status='failed' WHERE id=? AND status='pending' AND stripe_session_id=?").run(enrolmentId, s.id);
      return "failed";
    }
    return "pending";
  }

  // ---------- validation ----------
  function validateBackup(b: any, expectedNpub: string): BackupBundle {
    const s = (v: unknown, max = 2000) => typeof v === "string" && v.length > 0 && v.length <= max;
    if (!b || b.npub !== expectedNpub || !s(b.encrypted_nsec) || !s(b.kdf_salt, 100) || !s(b.cipher_iv, 100)
      || b.kdf_params?.name !== "PBKDF2" || b.kdf_params?.hash !== "SHA-256" || !(b.kdf_params?.iterations >= 100_000 && b.kdf_params.iterations <= 5_000_000)) {
      throw new HttpError(400, "Invalid encrypted key backup");
    }
    return { npub: b.npub, encrypted_nsec: b.encrypted_nsec, kdf_salt: b.kdf_salt, cipher_iv: b.cipher_iv, kdf_params: { name: "PBKDF2", hash: "SHA-256", iterations: b.kdf_params.iterations } };
  }
  const cleanName = (v: unknown, label: string, max = 80, required = false) => {
    const s = String(v ?? "").trim();
    if (required && !s) throw new HttpError(400, `${label} is required`);
    if (s.length > max) throw new HttpError(400, `${label} must be ${max} characters or fewer`);
    return s;
  };
  const cleanImage = (v: unknown, label: string) => {
    const s = String(v ?? "").trim();
    if (!s) return "";
    if (/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s)) {
      if (s.length > 120_000) throw new HttpError(400, `${label} image is too large (max ~90KB)`);
      return s;
    }
    if (s.length > 500) throw new HttpError(400, `${label} URL is too long`);
    let u: URL;
    try { u = new URL(s); } catch { throw new HttpError(400, `${label} must be an https image URL or an uploaded image`); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, `${label} must be an https image URL or an uploaded image`);
    return s;
  };
  /** Structural check of a NIP-44 v2 payload (base64, version byte 2, >= 99 bytes). The server cannot and does not decrypt it. */
  const isNip44Payload = (v: unknown) => {
    if (typeof v !== "string" || v.length < 132 || v.length > 4096 || !/^[A-Za-z0-9+/]+=*$/.test(v)) return false;
    const bytes = Buffer.from(v, "base64");
    return bytes.length >= 99 && bytes[0] === 2;
  };

  // ---------- API ----------
  async function body(req: Request): Promise<any> {
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) throw new HttpError(415, "JSON body required");
    try { return await req.json(); } catch { throw new HttpError(400, "Invalid JSON"); }
  }
  const origin = (req: Request) => config.baseUrl ?? new URL(req.url).origin;

  async function api(req: Request, url: URL): Promise<Response> {
    const path = url.pathname;
    const m = req.method;

    // CSRF defence: state-changing calls must be same-origin JSON (webhook is signature-authenticated).
    if (m !== "GET" && m !== "HEAD" && path !== "/api/stripe/webhook") {
      const o = req.headers.get("origin");
      if (o && new URL(o).host !== (req.headers.get("x-forwarded-host") ?? url.host)) throw new HttpError(403, "Cross-origin request blocked");
    }

    if (path === "/api/auth/challenge" && m === "GET") {
      const nonce = randomBytes(16).toString("hex");
      db.query("DELETE FROM auth_challenges WHERE expires_at<?").run(Date.now());
      db.query("INSERT INTO auth_challenges (nonce,expires_at) VALUES (?,?)").run(nonce, Date.now() + 5 * 60_000);
      return json({ challenge: nonce, kind: AUTH_KIND });
    }

    if (path === "/api/auth/nostr" && m === "POST") {
      const { event } = await body(req);
      if (!event || typeof event !== "object" || event.kind !== AUTH_KIND || !Array.isArray(event.tags)) throw new HttpError(400, "Invalid auth event");
      let valid = false;
      try { valid = verifyEvent(event); } catch { /* invalid */ }
      if (!valid) throw new HttpError(401, "Signature verification failed");
      if (Math.abs(Date.now() / 1000 - event.created_at) > 300) throw new HttpError(401, "Auth event is too old");
      const nonce = event.tags.find((t: string[]) => t[0] === "challenge")?.[1];
      if (!nonce) throw new HttpError(401, "Missing challenge");
      // Single-use: the delete must remove exactly one unexpired row.
      const del = db.query("DELETE FROM auth_challenges WHERE nonce=? AND expires_at>?").run(nonce, Date.now());
      if (del.changes !== 1) throw new HttpError(401, "Challenge expired or already used");
      const pubkey: string = event.pubkey;
      const npub = npubEncode(pubkey);
      let user = db.query("SELECT * FROM users WHERE pubkey=?").get(pubkey) as User | null;
      if (!user) {
        db.query("INSERT INTO users (npub,pubkey,created_at) VALUES (?,?,?)").run(npub, pubkey, Date.now());
        user = db.query("SELECT * FROM users WHERE pubkey=?").get(pubkey) as User;
      }
      const token = createSession(user.id, "nostr");
      return json({ user: userView(user, config.adminPubkeys.has(pubkey)) }, 200, { "set-cookie": sessionCookie(req, token) });
    }

    if (path === "/api/auth/login" && m === "POST") {
      const b = await body(req);
      const id = String(b.identifier ?? "").trim().toLowerCase();
      const password = String(b.password ?? "");
      const key = id || "-";
      const att = loginAttempts.get(key);
      if (att && att.reset > Date.now() && att.n >= 10) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
      const user = db.query("SELECT * FROM users WHERE username=? COLLATE NOCASE").get(id) as User | null;
      const ok = !!user?.password_hash && await Bun.password.verify(password, user.password_hash);
      if (!ok) {
        const cur = att && att.reset > Date.now() ? att : { n: 0, reset: Date.now() + 10 * 60_000 };
        cur.n++; loginAttempts.set(key, cur);
        throw new HttpError(401, "Incorrect username or password");
      }
      loginAttempts.delete(key);
      const token = createSession(user!.id, "password");
      return json({ user: userView(user!), backup: user!.backup_json ? JSON.parse(user!.backup_json) : null }, 200, { "set-cookie": sessionCookie(req, token) });
    }

    if (path === "/api/auth/logout" && m === "POST") {
      const token = readCookie(req, cookieName);
      if (token) db.query("DELETE FROM sessions WHERE token_hash=?").run(sha(token));
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(req, null) });
    }

    if (path === "/api/me") {
      if (m === "GET") {
        const s = currentSession(req);
        return json({ user: s ? userView(s.user, s.isAdmin) : null });
      }
      if (m === "PATCH") {
        const s = requireUser(req);
        const b = await body(req);
        const displayName = b.displayName !== undefined ? cleanName(b.displayName, "Display name") : s.user.display_name;
        const agentName = b.agentName !== undefined ? cleanName(b.agentName, "Chief of Staff name", 60, true) : s.user.agent_name;
        const avatarUrl = b.avatarUrl !== undefined ? cleanImage(b.avatarUrl, "Avatar") : s.user.avatar_url;
        db.query("UPDATE users SET display_name=?, agent_name=?, avatar_url=? WHERE id=?").run(displayName, agentName, avatarUrl, s.user.id);
        const u = db.query("SELECT * FROM users WHERE id=?").get(s.user.id) as User;
        return json({ user: userView(u, s.isAdmin) });
      }
    }

    if (path === "/api/account/chief-of-staff") {
      const s = requireUser(req);
      const agentView = (u: User) => ({
        agent_name: u.agent_name, agent_avatar: u.agent_avatar, agent_role: u.agent_role, agent_npub: u.agent_npub,
        encrypted_agent_nsec: u.encrypted_agent_nsec, agent_encryption_scheme: u.agent_encryption_scheme,
      });
      if (m === "GET") return json({ chiefOfStaff: agentView(s.user) });
      if (m === "POST" || m === "PUT") {
        const b = await body(req);
        const name = cleanName(b.agent_name, "Chief of Staff name", 60, true);
        const role = cleanName(b.agent_role, "Role", 200);
        const avatar = cleanImage(b.agent_avatar, "Chief of Staff avatar");
        const hasKey = b.agent_npub !== undefined || b.encrypted_agent_nsec !== undefined;
        let npub = s.user.agent_npub, enc = s.user.encrypted_agent_nsec, scheme = s.user.agent_encryption_scheme;
        if (hasKey) {
          let ok = false;
          try { const d = decodePointer(String(b.agent_npub ?? "")); ok = d.type === "npub"; } catch { /* invalid */ }
          if (!ok) throw new HttpError(400, "Invalid agent npub");
          if (b.agent_npub === s.user.npub) throw new HttpError(400, "The agent needs its own key, separate from yours");
          if (b.agent_encryption_scheme !== "nip44_self") throw new HttpError(400, "Unsupported encryption scheme");
          if (!isNip44Payload(b.encrypted_agent_nsec)) throw new HttpError(400, "encrypted_agent_nsec must be a NIP-44 encrypted payload. Plaintext keys are never accepted.");
          npub = b.agent_npub; enc = b.encrypted_agent_nsec; scheme = b.agent_encryption_scheme;
        }
        db.query("UPDATE users SET agent_name=?, agent_role=?, agent_avatar=?, agent_npub=?, encrypted_agent_nsec=?, agent_encryption_scheme=? WHERE id=?")
          .run(name, role, avatar, npub, enc, scheme, s.user.id);
        const u = db.query("SELECT * FROM users WHERE id=?").get(s.user.id) as User;
        return json({ chiefOfStaff: agentView(u), user: userView(u, s.isAdmin) });
      }
    }

    if (path === "/api/me/backup" && m === "GET") {
      const s = requireUser(req);
      return json({ backup: s.user.backup_json ? JSON.parse(s.user.backup_json) : null });
    }

    if (path === "/api/me/enrolments" && m === "GET") {
      const s = requireUser(req);
      return json({ enrolments: myEnrolments(s.user.id) });
    }

    if (path === "/api/courses" && m === "GET") {
      const rows = db.query("SELECT * FROM cohorts WHERE status='published' ORDER BY start_date, id").all() as Cohort[];
      return json({ courses: rows.map(cohortView) });
    }
    let mm = path.match(/^\/api\/courses\/([a-z0-9-]+)$/);
    if (mm && m === "GET") {
      const c = cohortBySlug(mm[1]);
      if (!c || c.status === "draft") throw new HttpError(404, "Course not found");
      return json({ course: cohortView(c) });
    }

    mm = path.match(/^\/api\/courses\/([a-z0-9-]+)\/enrol$/);
    if (mm && m === "POST") return enrol(req, mm[1]);

    if (path === "/api/enrolments/confirm" && m === "GET") {
      const s = requireUser(req);
      const sid = url.searchParams.get("session_id") ?? "";
      if (!/^cs_[A-Za-z0-9_]+$/.test(sid)) throw new HttpError(400, "Invalid session id");
      const stripe = await stripeClient();
      if (!stripe) throw new HttpError(503, "Stripe is not configured", "stripe_not_configured");
      const cs = await stripe.retrieveCheckoutSession(sid).catch((e) => { throw new HttpError(502, `Stripe error: ${e.message}`); });
      const enr = db.query("SELECT * FROM enrolments WHERE id=? AND user_id=?").get(Number(cs.client_reference_id), s.user.id) as any;
      if (!enr) throw new HttpError(404, "Enrolment not found");
      const status = settle(enr.id, cs);
      return json({ status, enrolment: myEnrolments(s.user.id).find((e) => e.id === enr.id), user: userView(s.user, s.isAdmin) });
    }

    if (path === "/api/stripe/webhook" && m === "POST") {
      const { wh } = await stripeSettings();
      const raw = await req.text();
      if (!wh) throw new HttpError(400, "Webhook secret not configured");
      if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), wh)) throw new HttpError(400, "Invalid signature");
      const ev = JSON.parse(raw);
      const first = db.query("INSERT OR IGNORE INTO stripe_events (id,received_at) VALUES (?,?)").run(ev.id, Date.now()).changes === 1;
      if (!first) return json({ received: true, duplicate: true });
      const obj = ev.data?.object;
      if (/^checkout\.session\.(completed|async_payment_succeeded|async_payment_failed|expired)$/.test(ev.type) && obj?.client_reference_id) {
        const enrId = Number(obj.client_reference_id);
        if (ev.type === "checkout.session.async_payment_failed") {
          db.query("UPDATE enrolments SET status='failed' WHERE id=? AND status='pending'").run(enrId);
        } else settle(enrId, obj);
      }
      return json({ received: true });
    }

    if (path.startsWith("/api/admin/")) return admin(req, url);

    throw new HttpError(404, "Not found");
  }

  function myEnrolments(userId: number) {
    const rows = db.query(
      `SELECT e.id, e.status, e.amount_cents, e.currency, e.created_at, e.paid_at, c.title, c.slug, c.start_date, c.schedule, c.location
       FROM enrolments e JOIN cohorts c ON c.id=e.cohort_id WHERE e.user_id=? ORDER BY e.created_at DESC`,
    ).all(userId) as any[];
    return rows.map((r) => ({ id: r.id, status: r.status, amountCents: r.amount_cents, currency: r.currency, createdAt: r.created_at, paidAt: r.paid_at, title: r.title, slug: r.slug, startDate: r.start_date, schedule: r.schedule, location: r.location }));
  }

  async function enrol(req: Request, slug: string): Promise<Response> {
    const b = await body(req);
    const cohort = cohortBySlug(slug);
    if (!cohort || cohort.status !== "published") throw new HttpError(404, "Course not found");
    const stripe = await stripeClient();
    if (cohort.price_cents > 0 && !stripe) {
      throw new HttpError(503, "Payments are not set up yet. The administrator needs to add Stripe keys in /admin.", "stripe_not_configured");
    }

    let session = currentSession(req);
    let user!: User;
    let newToken: string | null = null;
    let enrolmentId = 0;

    const prepare = db.transaction(() => {
      if (session) {
        user = session.user;
        if (b.agentName !== undefined) {
          const agentName = cleanName(b.agentName, "Chief of Staff name", 60, true);
          db.query("UPDATE users SET agent_name=? WHERE id=?").run(agentName, user.id);
        } else if (!user.agent_name) throw new HttpError(400, "Chief of Staff name is required");
      } else {
        const displayName = cleanName(b.displayName, "Name", 80, true);
        const identifier = cleanName(b.identifier, "Username or email", 120, true).toLowerCase();
        if (!/^[a-z0-9._@+-]{3,120}$/.test(identifier)) throw new HttpError(400, "Username may only use letters, numbers and . _ @ + -");
        const password = String(b.password ?? "");
        if (password.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
        if (password.length > 200) throw new HttpError(400, "Password is too long");
        if (b.passwordConfirm !== undefined && b.passwordConfirm !== password) throw new HttpError(400, "Passwords do not match");
        const agentName = cleanName(b.agentName, "Chief of Staff name", 60, true);
        const npub = String(b.backup?.npub ?? "");
        const pubkey = npubToHex(npub);
        if (!pubkey) throw new HttpError(400, "A valid npub is required");
        const backup = validateBackup(b.backup, npub);
        if (db.query("SELECT 1 FROM users WHERE username=? COLLATE NOCASE").get(identifier)) throw new HttpError(409, "That username is already taken. Sign in instead.", "username_taken");
        if (db.query("SELECT 1 FROM users WHERE pubkey=?").get(pubkey)) throw new HttpError(409, "That key already has an account. Sign in instead.", "npub_taken");
        // Hash outside is async; set a placeholder replaced below (kept inside txn via sync hash).
        const hash = Bun.password.hashSync(password);
        const email = identifier.includes("@") ? identifier : null;
        db.query("INSERT INTO users (npub,pubkey,username,email,display_name,agent_name,password_hash,backup_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(npub, pubkey, identifier, email, displayName, agentName, hash, JSON.stringify(backup), Date.now());
        user = db.query("SELECT * FROM users WHERE pubkey=?").get(pubkey) as User;
      }
      const existing = db.query("SELECT * FROM enrolments WHERE user_id=? AND cohort_id=?").get(user.id, cohort.id) as any;
      if (existing?.status === "paid") throw new HttpError(409, "You are already enrolled in this cohort.", "already_enrolled");
      if (seatsTaken(cohort.id, existing?.id ?? 0) >= cohort.capacity) throw new HttpError(409, "This cohort is full.", "cohort_full");
      const now = Date.now();
      if (existing) {
        db.query("UPDATE enrolments SET status='pending', amount_cents=?, currency=?, reserved_until=? WHERE id=?").run(cohort.price_cents, cohort.currency, now + RESERVATION_MS, existing.id);
        enrolmentId = existing.id;
      } else {
        enrolmentId = Number(db.query("INSERT INTO enrolments (user_id,cohort_id,status,amount_cents,currency,reserved_until,created_at) VALUES (?,?,'pending',?,?,?,?)")
          .run(user.id, cohort.id, cohort.price_cents, cohort.currency, now + RESERVATION_MS, now).lastInsertRowid);
      }
    });
    prepare();
    if (!session) newToken = createSession(user!.id, "password");
    const headers: Record<string, string> = newToken ? { "set-cookie": sessionCookie(req, newToken) } : {};
    const u = db.query("SELECT * FROM users WHERE id=?").get(user!.id) as User;

    if (cohort.price_cents === 0) {
      settle(enrolmentId, { id: `free_${enrolmentId}`, payment_status: "no_payment_required", amount_total: 0 });
      return json({ status: "paid", user: userView(u), redirect: `/courses/${slug}/enrol/complete` }, 200, headers);
    }
    try {
      const cs = await stripe!.createCheckoutSession({
        enrolmentId, cohortTitle: cohort.title, amountCents: cohort.price_cents, currency: cohort.currency,
        customerEmail: u.email ?? undefined, idempotencyKey: randomUUID(),
        successUrl: `${origin(req)}/courses/${slug}/enrol/complete?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${origin(req)}/courses/${slug}/enrol?cancelled=1`,
      });
      db.query("UPDATE enrolments SET stripe_session_id=? WHERE id=? AND status!='paid'").run(cs.id, enrolmentId);
      return json({ status: "pending", checkoutUrl: cs.url, user: userView(u) }, 200, headers);
    } catch (e: any) {
      return json({ error: `Could not start payment: ${e.message}`, code: "stripe_error", user: userView(u) }, 502, headers);
    }
  }

  async function admin(req: Request, url: URL): Promise<Response> {
    requireAdmin(req);
    const path = url.pathname, m = req.method;

    if (path === "/api/admin/stripe") {
      if (m === "GET") return json({ stripe: await stripeView(), webhookUrl: `${origin(req)}/api/stripe/webhook` });
      if (m === "PUT") {
        const b = await body(req);
        const pk = b.publishableKey !== undefined ? String(b.publishableKey).trim() : undefined;
        const sk = b.secretKey ? String(b.secretKey).trim() : undefined;
        const wh = b.webhookSecret ? String(b.webhookSecret).trim() : undefined;
        if (pk !== undefined && pk !== "" && !/^pk_(test|live)_[A-Za-z0-9]{8,}$/.test(pk)) throw new HttpError(400, "Publishable key must look like pk_test_… or pk_live_…");
        if (sk && !/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/.test(sk)) throw new HttpError(400, "Secret key must look like sk_test_… or sk_live_…");
        if (wh && !/^whsec_[A-Za-z0-9+/=_-]{8,}$/.test(wh)) throw new HttpError(400, "Webhook secret must look like whsec_…");
        const finalPk = pk ?? getSetting("stripe_publishable");
        const finalSk = sk ?? await getSecret("stripe_secret");
        if (finalPk && finalSk && finalPk.split("_")[1] !== finalSk.split("_")[1]) throw new HttpError(400, "Publishable and secret keys must both be test or both be live");
        if (pk) setSetting("stripe_publishable", pk);
        if (sk) setSetting("stripe_secret", await box.seal(sk));
        if (wh) setSetting("stripe_webhook", await box.seal(wh));
        if (b.clearWebhookSecret === true) delSetting("stripe_webhook");
        return json({ stripe: await stripeView() });
      }
    }
    if (path === "/api/admin/stripe/test" && m === "POST") {
      const stripe = await stripeClient();
      if (!stripe) throw new HttpError(400, "No Stripe secret key saved yet");
      try {
        const r = await stripe.checkKey();
        return json({ ok: r.ok, error: r.error ?? null, mode: (await stripeView()).mode });
      } catch (e: any) {
        return json({ ok: false, error: e?.message ?? "Could not reach Stripe", mode: (await stripeView()).mode });
      }
    }

    if (path === "/api/admin/cohorts") {
      if (m === "GET") {
        const rows = db.query("SELECT * FROM cohorts ORDER BY created_at DESC, id DESC").all() as Cohort[];
        return json({ cohorts: rows.map((c) => ({ ...cohortView(c), revenueCents: revenue(c.id) })) });
      }
      if (m === "POST") {
        const c = parseCohort(await body(req));
        if (cohortBySlug(c.slug)) throw new HttpError(409, "A cohort with that slug already exists");
        const now = Date.now();
        const id = Number(db.query(
          `INSERT INTO cohorts (slug,title,tagline,description,highlights,modules,start_date,end_date,schedule,location,price_cents,currency,capacity,status,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(c.slug, c.title, c.tagline, c.description, c.highlights, c.modules, c.start_date, c.end_date, c.schedule, c.location, c.price_cents, c.currency, c.capacity, c.status, now, now).lastInsertRowid);
        return json({ cohort: cohortView(cohortById(id)!) }, 201);
      }
    }
    let mm = path.match(/^\/api\/admin\/cohorts\/(\d+)$/);
    if (mm) {
      const cur = cohortById(Number(mm[1]));
      if (!cur) throw new HttpError(404, "Cohort not found");
      if (m === "GET") return json({ cohort: cohortView(cur) });
      if (m === "PUT" || m === "PATCH") {
        const c = parseCohort(await body(req), cur);
        const clash = cohortBySlug(c.slug);
        if (clash && clash.id !== cur.id) throw new HttpError(409, "A cohort with that slug already exists");
        if (c.capacity < paidCount(cur.id)) throw new HttpError(400, "Capacity cannot be lower than the seats already paid for");
        db.query(
          `UPDATE cohorts SET slug=?,title=?,tagline=?,description=?,highlights=?,modules=?,start_date=?,end_date=?,schedule=?,location=?,price_cents=?,currency=?,capacity=?,status=?,updated_at=? WHERE id=?`,
        ).run(c.slug, c.title, c.tagline, c.description, c.highlights, c.modules, c.start_date, c.end_date, c.schedule, c.location, c.price_cents, c.currency, c.capacity, c.status, Date.now(), cur.id);
        return json({ cohort: cohortView(cohortById(cur.id)!) });
      }
    }
    mm = path.match(/^\/api\/admin\/cohorts\/(\d+)\/signups$/);
    if (mm && m === "GET") {
      const cur = cohortById(Number(mm[1]));
      if (!cur) throw new HttpError(404, "Cohort not found");
      const rows = db.query(
        `SELECT e.id, e.status, e.amount_cents, e.currency, e.created_at, e.paid_at, u.display_name, u.username, u.email, u.npub, u.agent_name, u.agent_npub
         FROM enrolments e JOIN users u ON u.id=e.user_id WHERE e.cohort_id=? ORDER BY e.created_at DESC`,
      ).all(cur.id) as any[];
      return json({
        cohort: cohortView(cur),
        stats: { seatsFilled: paidCount(cur.id), capacity: cur.capacity, revenueCents: revenue(cur.id), currency: cur.currency },
        signups: rows.map((r) => ({
          id: r.id, name: r.display_name, username: r.username, email: r.email, npub: r.npub, agentName: r.agent_name, agentNpub: r.agent_npub,
          status: r.status, amountCents: r.status === "paid" ? r.amount_cents : 0, currency: r.currency, signedUpAt: r.created_at, paidAt: r.paid_at,
        })),
      });
    }
    throw new HttpError(404, "Not found");
  }
  const revenue = (cohortId: number) =>
    (db.query("SELECT COALESCE(SUM(amount_cents),0) AS n FROM enrolments WHERE cohort_id=? AND status='paid'").get(cohortId) as { n: number }).n;

  // ---------- pages & static ----------
  async function pages(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const s = currentSession(req);
    const ctx = { user: s ? userView(s.user, s.isAdmin) : null, adminNpubs: config.adminNpubs, relays: config.nostrRelays };
    const html = (status: number, title: string, page: string, bodyHtml: string) =>
      new Response(renderPage(title, page, bodyHtml, ctx), { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    const { homePage, catalogPage, coursePage, enrolPage, completePage, loginPage, accountPage, adminPage, notFoundPage } = await import("./views.ts");

    if (path === "/") return html(200, "Work with AI, Stay Sane", "home", homePage());
    if (path === "/courses") {
      const rows = db.query("SELECT * FROM cohorts WHERE status='published' ORDER BY start_date, id").all() as Cohort[];
      return html(200, "Courses", "courses", catalogPage(rows.map(cohortView)));
    }
    let mm = path.match(/^\/courses\/([a-z0-9-]+)$/);
    if (mm) {
      const c = cohortBySlug(mm[1]);
      if (!c || c.status === "draft") return html(404, "Not found", "404", notFoundPage());
      return html(200, c.title, "course", coursePage(cohortView(c)));
    }
    mm = path.match(/^\/courses\/([a-z0-9-]+)\/enrol(\/complete)?$/);
    if (mm) {
      const c = cohortBySlug(mm[1]);
      if (!c || c.status !== "published") return html(404, "Not found", "404", notFoundPage());
      return mm[2]
        ? html(200, `Welcome to ${c.title}`, "complete", completePage(cohortView(c), url.searchParams.get("session_id")))
        : html(200, `Enrol · ${c.title}`, "enrol", enrolPage(cohortView(c), ctx.user, await stripeView().then((v) => v.configured)));
    }
    if (path === "/login") return html(200, "Sign in", "login", loginPage());
    if (path === "/account") return html(200, "Your account", "account", accountPage(ctx.user));
    if (path === "/admin") return html(200, "Admin", "admin", adminPage(ctx.user));
    return null;
  }

  async function staticFile(url: URL): Promise<Response> {
    const p = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    if (p.includes("..") || p.split("/").some((seg) => seg.startsWith(".") && seg !== "")) return new Response("Not found", { status: 404 });
    const file = Bun.file(config.publicDir + p);
    if (await file.exists() && !(await Bun.file(config.publicDir + p + "/index.html").exists())) {
      const ext = p.slice(p.lastIndexOf("."));
      return new Response(file, { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "x-content-type-options": "nosniff" } });
    }
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
  }

  async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") {
        return json({ status: "ok", app: "ambulando-web", artifactVersion: "v7" });
      }
      if (url.pathname === "/_app/app.css") return new Response(APP_CSS, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } });
      if (url.pathname === "/_app/client.js") return new Response(await clientBundle(), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
      if (url.pathname.startsWith("/api/")) return await api(req, url);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const page = await pages(req, url);
      if (page) return page;
      return await staticFile(url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error("Unhandled error", e);
      return json({ error: "Internal server error" }, 500);
    }
  }

  return { fetch, db, config };
}
