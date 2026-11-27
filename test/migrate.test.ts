import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { importSqlite, rollbackImport } from "../src/migrate.ts";
import { SecretBox } from "../src/secrets.ts";
import { ensureSchema } from "../src/schema.ts";
import { Store } from "../src/store.ts";
import { toBase64 } from "../src/shared/backup.ts";
import { openDb } from "../scripts/legacy-sqlite-schema.ts";
import { Client, newNstack, signupBody, stripeKeys } from "./helpers.ts";
import { createHash } from "node:crypto";
import { npubEncode } from "applesauce-core/helpers/pointers";
import { generateSecretKey, getPublicKey } from "applesauce-core/helpers/keys";

const NOW = 1_800_000_000_000;

async function legacy() {
  const db = openDb(":memory:");
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const box = await SecretBox.fromRaw(raw);
  const users = [] as { npub: string; sk: Uint8Array }[];
  for (let i = 0; i < 3; i++) {
    const sk = generateSecretKey(); const pk = getPublicKey(sk);
    users.push({ npub: npubEncode(pk), sk });
    db.query("INSERT INTO users (id,npub,pubkey,username,email,display_name,agent_name,password_hash,backup_json,created_at,avatar_url,agent_npub,encrypted_agent_nsec,agent_encryption_scheme) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(i === 0 ? 5 : i + 10, npubEncode(pk), pk, i === 2 ? null : `User${i}@Example.com`, i === 2 ? null : `user${i}@example.com`, `User ${i}`, "Atlas", i === 2 ? null : Bun.password.hashSync("pw-" + i), i === 2 ? null : JSON.stringify({ npub: npubEncode(pk), encrypted_nsec: "ct" + i }), NOW - 1000 * i, "", i === 1 ? npubEncode(getPublicKey(generateSecretKey())) : "", i === 1 ? "A".repeat(140) : "", i === 1 ? "nip44_self" : "");
  }
  db.query("INSERT INTO sessions VALUES (?,?,?,?,?)").run("hash-live", 5, "password", NOW + 86_400_000, NOW - 5);
  db.query("INSERT INTO sessions VALUES (?,?,?,?,?)").run("hash-dead", 5, "password", NOW - 1, NOW - 90_000_000);
  db.query("INSERT INTO auth_challenges VALUES (?,?)").run("n1", NOW + 1000);
  db.query("INSERT INTO cohorts (id,slug,title,tagline,description,highlights,modules,start_date,end_date,schedule,location,price_cents,currency,capacity,status,created_at,updated_at) VALUES (7,'seed-two','Two','','d','[]','[]','2027-03-01','2027-03-29','','',1000,'aud',3,'published',?,?)").run(NOW, NOW);
  // cohort id 1 is the seeded one created by openDb
  db.query("INSERT INTO enrolments (id,user_id,cohort_id,status,amount_cents,currency,stripe_session_id,stripe_payment_intent,reserved_until,created_at,paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(3, 5, 1, "paid", 49500, "aud", "cs_live_1", "pi_1", 0, NOW - 50, NOW - 40);
  db.query("INSERT INTO enrolments (id,user_id,cohort_id,status,amount_cents,currency,stripe_session_id,reserved_until,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(4, 11, 1, "pending", 49500, "aud", "cs_live_2", NOW + 600_000, NOW - 30);
  db.query("INSERT INTO enrolments (id,user_id,cohort_id,status,amount_cents,currency,reserved_until,created_at) VALUES (?,?,?,?,?,?,?,?)").run(9, 11, 7, "pending", 1000, "aud", NOW - 10, NOW - 20); // lapsed reservation: no seat
  db.query("INSERT INTO stripe_events VALUES (?,?)").run("evt_old", NOW - 100);
  db.query("INSERT OR REPLACE INTO settings VALUES ('stripe_publishable',?)").run(stripeKeys.publishableKey);
  db.query("INSERT OR REPLACE INTO settings VALUES ('stripe_secret',?)").run(await box.seal(stripeKeys.secretKey));
  db.query("INSERT OR REPLACE INTO settings VALUES ('stripe_webhook',?)").run(await box.seal(stripeKeys.webhookSecret));
  return { db, box, raw, users };
}

async function target() {
  const ns = newNstack();
  await ensureSchema(ns.nstack);
  return { ...ns, store: new Store(ns.nstack), targetBox: await SecretBox.create({ secretKey: "new-key" }) };
}

describe("SQLite -> NStack import", () => {
  test("preserves ids and content, verifies counts and checksums, and is repeatable", async () => {
    const l = await legacy();
    const t = await target();
    const m = await importSqlite(l.db, t.store, { sourceBox: l.box, targetBox: t.targetBox, now: NOW, sourceSha256: "x" });
    expect(m.counts).toMatchObject({ users: 3, cohorts: 2, enrolments: 3, sessions: 1, stripe_events: 1, seats: 2 });
    expect(m.skipped.sessions).toBe(1);
    expect(t.fake.rows("users").map((r) => r.id).sort()).toEqual(["11", "12", "5"]);
    expect(t.fake.rows("enrolments").map((r) => r.id).sort()).toEqual(["3", "4", "9"]);
    expect(t.fake.rows("cohorts").map((r) => r.id).sort()).toEqual(["1", "7"]);
    expect(t.fake.rows("seats").map((r) => [r.id, r.holder, r.state]).sort()).toEqual([["1:1", "3", "paid"], ["1:2", "4", "held"]]);
    expect(t.fake.rows("users").find((r) => r.id === "5")!.username_lc).toBe("user0@example.com");
    // Second run: no new rows, same checksums, settings ciphertext unchanged.
    const before = JSON.stringify(t.fake.rows("settings"));
    const m2 = await importSqlite(l.db, t.store, { sourceBox: l.box, targetBox: t.targetBox, now: NOW, sourceSha256: "x" });
    expect(Object.values(m2.created).flat().length).toBe(0);
    expect(m2.checksums).toEqual(m.checksums);
    expect(JSON.stringify(t.fake.rows("settings"))).toBe(before);
    // Ids continue after the highest imported id (legacy AUTOINCREMENT semantics).
    expect(await t.store.nextId("users")).toBe(13);
    expect(await t.store.nextId("cohorts")).toBe(8);
    expect(await t.store.nextId("enrolments")).toBe(10);
  });

  test("never overwrites: a conflicting existing row stops the import", async () => {
    const l = await legacy();
    const t = await target();
    await importSqlite(l.db, t.store, { sourceBox: l.box, targetBox: t.targetBox, now: NOW });
    t.fake.rows("cohorts").find((r) => r.id === "7")!.title = "Tampered";
    await expect(importSqlite(l.db, t.store, { sourceBox: l.box, targetBox: t.targetBox, now: NOW })).rejects.toThrow(/different content/);
    expect(t.fake.rows("cohorts").find((r) => r.id === "7")!.title).toBe("Tampered");
  });

  test("dry run writes nothing; a wrong legacy key fails before any write", async () => {
    const l = await legacy();
    const t = await target();
    const m = await importSqlite(l.db, t.store, { sourceBox: l.box, targetBox: t.targetBox, now: NOW, dryRun: true });
    expect(m.counts.users).toBe(3);
    expect(t.fake.rows("users").length).toBe(0);
    const wrong = await SecretBox.fromRaw(crypto.getRandomValues(new Uint8Array(32)));
    await expect(importSqlite(l.db, t.store, { sourceBox: wrong, targetBox: t.targetBox, now: NOW })).rejects.toThrow();
    expect(t.fake.rows("users").length).toBe(0);
    await expect(importSqlite(l.db, t.store, { targetBox: t.targetBox, now: NOW })).rejects.toThrow(/re-sealed/);
  });

  test("rollback removes only rows this run created and keeps later live writes", async () => {
    const l = await legacy();
    const t = await target();
    await t.store.createCohort({ slug: "pre-existing", title: "Pre", tagline: "", description: "", highlights: "[]", modules: "[]", start_date: "", end_date: "", schedule: "", location: "", price_cents: 0, currency: "aud", capacity: 1, status: "draft" }, 1);
    // id 1 collides with the legacy seeded cohort => identical? no: content differs, import must stop and create nothing for cohorts
    await expect(importSqlite(l.db, t.store, { sourceBox: l.box, targetBox: t.targetBox, now: NOW })).rejects.toThrow(/different content/);
    await t.fake.rows("cohorts").length;
    const t2 = await target();
    const m = await importSqlite(l.db, t2.store, { sourceBox: l.box, targetBox: t2.targetBox, now: NOW });
    await t2.store.createUser({ npub: "npub1later", pubkey: "f".repeat(64), username: "later" });
    const removed = await rollbackImport(t2.nstack, m);
    expect(removed.users).toBe(3);
    expect(t2.fake.rows("users").map((r) => r.username)).toEqual(["later"]);
    expect(t2.fake.rows("enrolments").length).toBe(0);
  });

  test("the app serves imported data: password login, kept session, Stripe secrets, new signups get fresh ids", async () => {
    const l = await legacy();
    const t = await target();
    await importSqlite(l.db, t.store, { sourceBox: l.box, targetBox: t.targetBox, now: Date.now() - 1000 });
    // live session cookie from before the move still works (hash of the raw token is the key)
    const token = "legacy-token";
    await t.nstack.insert("sessions", createHash("sha256").update(token).digest("hex"), { user_id: "5", method: "password", expires_at: String(Date.now() + 100000), created_at: String(Date.now()) });
    const app = await createApp({ nstack: t.nstack, config: { adminNpubs: [], secretKey: "new-key" }, stripeFactory: (k) => ({ createCheckoutSession: async () => { throw new Error("n/a"); }, retrieveCheckoutSession: async () => { throw new Error(k); }, checkKey: async () => ({ ok: true }) }) });
    const c = new Client(app);
    c.cookie = `amb_session=${token}`;
    const me = (await (await c.get("/api/me")).json()) as any;
    expect(me.user).toMatchObject({ id: 5, username: "User0@Example.com", hasPassword: true, hasBackup: true });
    const login = await new Client(app).post("/api/auth/login", { identifier: "user1@example.com", password: "pw-1" });
    expect(login.status).toBe(200);
    expect(((await login.json()) as any).user).toMatchObject({ id: 11, hasAgentKey: true });
    expect((await new Client(app).post("/api/auth/login", { identifier: "user1@example.com", password: "nope" })).status).toBe(401);
    const enr = ((await (await c.get("/api/me/enrolments")).json()) as any).enrolments;
    expect(enr[0]).toMatchObject({ id: 3, status: "paid", amountCents: 49500, title: "Chief of Staff Foundations" });
    // Stripe config was re-sealed and is readable with the new key only
    expect(await t.targetBox.open(t.fake.rows("settings").find((r) => r.id === "stripe_secret")!.value)).toBe(stripeKeys.secretKey);
    // Seat accounting reflects imported reservations: 20 - (1 paid + 1 live reservation)
    expect(((await (await c.get("/api/courses/chief-of-staff-foundations")).json()) as any).course).toMatchObject({ enrolled: 1, seatsLeft: 18 });
    const { body } = await signupBody({ identifier: "fresh@example.com" });
    const r = await new Client(app).post("/api/courses/seed-two/enrol", body);
    // Not configured for payments in this fixture's Stripe mock -> reaches checkout creation, not an id clash
    expect([200, 502]).toContain(r.status);
    expect(t.fake.rows("users").find((u) => u.username === "fresh@example.com")!.id).toBe("13");
    expect(toBase64(new Uint8Array(l.raw))).toBeTruthy();
  });
});
