import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateSecretKey, getPublicKey } from "applesauce-core/helpers/keys";
import { nsecEncode, npubEncode } from "applesauce-core/helpers/pointers";
import { createApp } from "../src/app.ts";
import { NstackDb } from "../src/nstack.ts";
import { Client, MockStripe, signupBody, stripeKeys } from "./helpers.ts";

/**
 * Opt-in contract test against NStack's REAL app-db implementation (tower source) on a disposable PostgreSQL.
 * Set TOWER_SRC to a tower checkout and NSTACK_FIXTURE_DATABASE_URL to a local database whose name contains
 * `ambulando_fixture` (see scripts/real-nstack-test.sh, which provisions and removes a task-owned instance).
 * Skipped otherwise. No production credentials are ever used.
 */
const TOWER = process.env.TOWER_SRC;
const URLENV = process.env.NSTACK_FIXTURE_DATABASE_URL;
const enabled = !!(TOWER && URLENV && /ambulando_fixture/.test(URLENV) && /@(localhost|127\.0\.0\.1)[:/]/.test(URLENV));
const d = enabled ? describe : describe.skip;

d("real NStack app-db contract", () => {
  let sql: any, towerApp: any, ns: NstackDb;
  const owner = npubEncode(getPublicKey(generateSecretKey()));
  const appSk = generateSecretKey();
  const appNpub = npubEncode(getPublicKey(appSk));
  const fetchTower = ((url: any, init: any) => towerApp.request(String(url), init)) as typeof fetch;

  beforeAll(async () => {
    const postgres = (await import(`${TOWER}/node_modules/postgres`)).default;
    const { setDb } = await import(`${TOWER}/src/db.ts`);
    const { splitSqlStatements } = await import(`${TOWER}/src/schema/sql-statements.ts`);
    const { createApp: createTower } = await import(`${TOWER}/src/server.ts`);
    sql = postgres(URLENV!, { onnotice: () => {} });
    setDb(sql);
    for (const stmt of splitSqlStatements(readFileSync(`${TOWER}/src/schema/001_init.sql`, "utf8"))) await sql.unsafe(stmt);
    await sql`INSERT INTO workspace_apps (workspace_owner_npub, app_npub, app_name, created_by_npub) VALUES (${owner}, ${appNpub}, ${"ambulando-web"}, ${owner})`;
    towerApp = createTower({});
    ns = new NstackDb({ baseUrl: "http://localhost", ownerNpub: owner, appSecret: nsecEncode(appSk), fetch: fetchTower });
  });
  afterAll(async () => { if (sql) await sql.end(); });

  async function boot() {
    const adminSk = generateSecretKey();
    const stripe = new MockStripe();
    const app = await createApp({ nstack: ns, config: { adminNpubs: [npubEncode(getPublicKey(adminSk))], secretKey: "k" }, stripeFactory: stripe.factory });
    const admin = new Client(app);
    await admin.nostrLogin(adminSk);
    return { app, admin, stripe };
  }

  test("schema installs idempotently under NStack's migration rules", async () => {
    await boot(); await boot();
    const m = await ns.migrations();
    expect(m.migrations.map((x) => x.version)).toEqual(["0001_initial"]);
  });

  test("full site flow on the real service: stripe config, cohort, signup, payment, restart", async () => {
    const { admin, stripe, app } = await boot();
    expect((await admin.put("/api/admin/stripe", stripeKeys)).status).toBe(200);
    const created = ((await (await admin.post("/api/admin/cohorts", { title: "Real", slug: "real-nstack", priceCents: 5000, currency: "aud", capacity: 2, status: "published" })).json()) as any).cohort;
    const { body } = await signupBody({ identifier: "real@example.com" });
    const u = new Client(app);
    const r = await u.post(`/api/courses/${created.slug}/enrol`, body);
    expect(r.status).toBe(200);
    const sid = ((await r.json()) as any).checkoutUrl.split("/").pop();
    stripe.pay(sid);
    expect(((await (await u.get(`/api/enrolments/confirm?session_id=${sid}`)).json()) as any).status).toBe("paid");
    const app2 = await createApp({ nstack: ns, config: { adminNpubs: [], secretKey: "k" }, stripeFactory: stripe.factory });
    const same = new Client(app2); same.cookie = u.cookie;
    const mine = ((await (await same.get("/api/me/enrolments")).json()) as any).enrolments;
    expect(mine[0]).toMatchObject({ status: "paid", amountCents: 5000 });
  });

  test("no oversell and unique usernames under concurrent requests", async () => {
    const { admin, app } = await boot();
    const c = ((await (await admin.post("/api/admin/cohorts", { title: "Race", slug: "race", priceCents: 0, currency: "aud", capacity: 3, status: "published" })).json()) as any).cohort;
    const rs = await Promise.all(Array.from({ length: 10 }, async (_, i) => new Client(app).post(`/api/courses/${c.slug}/enrol`, (await signupBody({ identifier: `race${i}@example.com` })).body)));
    expect(rs.filter((x) => x.status === 200).length).toBe(3);
    expect(rs.filter((x) => x.status === 409).length).toBe(7);
    const dup = await Promise.all(Array.from({ length: 4 }, async () => new Client(app).post(`/api/courses/${c.slug}/enrol`, (await signupBody({ identifier: "dup@example.com" })).body)));
    expect(dup.filter((x) => x.status === 200).length + dup.filter((x) => x.status === 409).length).toBe(4);
    const users = await sql.unsafe(`SELECT count(*)::int AS n FROM ${(await ns.descriptor()).schema_name}.users WHERE username_lc = 'dup@example.com'`);
    expect(users[0].n).toBeLessThanOrEqual(1);
  });

  test("another app identity can neither read nor write this namespace", async () => {
    const other = new NstackDb({ baseUrl: "http://localhost", ownerNpub: owner, appSecret: nsecEncode(generateSecretKey()), fetch: fetchTower });
    await expect(other.query("users", {})).rejects.toMatchObject({ status: expect.any(Number) });
    const forged = await towerApp.request(`http://localhost/api/v4/workspaces/${owner}/apps/${appNpub}/db/tables/users/query`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(forged.status).toBe(401);
  });
});
