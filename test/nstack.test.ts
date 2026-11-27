import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools";
import { generateSecretKey } from "applesauce-core/helpers/keys";
import { nsecEncode } from "applesauce-core/helpers/pointers";
import { createApp } from "../src/app.ts";
import { NstackDb, NstackError } from "../src/nstack.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { signStripePayload } from "../src/stripe.ts";
import { Client, newNstack, setup, signupBody, stripeKeys } from "./helpers.ts";

const sample = { title: "Agent Ops", slug: "agent-ops", tagline: "t", description: "d", startDate: "2027-03-01", endDate: "2027-03-29", priceCents: 10000, currency: "aud", capacity: 2, status: "published" };
async function ready(capacity = 2) {
  const s = await setup();
  expect((await s.admin.put("/api/admin/stripe", stripeKeys)).status).toBe(200);
  const r = await s.admin.post("/api/admin/cohorts", { ...sample, capacity });
  const cohort = ((await r.json()) as any).cohort;
  return { s, cohort };
}
const signup = async (s: Awaited<ReturnType<typeof setup>>, slug: string, id: string) => {
  const c = s.anon();
  const res = await c.post(`/api/courses/${slug}/enrol`, (await signupBody({ identifier: id })).body);
  return { c, res, body: (await res.json()) as any };
};

const appKeyOf = (ns: ReturnType<typeof newNstack>) => ns.appSk;

describe("NStack isolation and authorization", () => {
  test("the app signs every request; a foreign signer, namespace or tampered body is refused", async () => {
    const ns = newNstack();
    await ns.nstack.provision();
    const base = `https://nstack.test/api/v4/workspaces/${ns.owner}/apps/${ns.nstack.appNpub}/db`;
    const signed = (key: Uint8Array, url: string, method: string, body?: string, payloadOverride?: string) => {
      const tags = [["u", url], ["method", method]];
      if (body !== undefined) tags.push(["payload", createHash("sha256").update(payloadOverride ?? body).digest("hex")]);
      const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: "" }, key);
      return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
    };
    const call = (authorization: string | null, url: string, method = "GET", body?: string) =>
      ns.fake.fetch(url, { method, headers: authorization ? { authorization } : {}, body });
    // Unsigned.
    expect((await call(null, `${base}/descriptor`)).status).toBe(401);
    // Signed by an identity that is not the registered app: 403 on this app's own path.
    const stranger = generateSecretKey();
    const r = await call(signed(stranger, `${base}/descriptor`, "GET"), `${base}/descriptor`);
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).code).toBe("app_signer_required");
    // A token minted for one URL cannot be replayed against another.
    const tok = signed(appKeyOf(ns), `${base}/descriptor`, "GET");
    expect((await call(tok, `${base}/migrations`)).status).toBe(401);
    // A token cannot be reused with a different body.
    const body = JSON.stringify({ id: "x", data: { value: "1" } });
    const tok2 = signed(appKeyOf(ns), `${base}/tables/settings/rows`, "POST", body);
    expect((await call(tok2, `${base}/tables/settings/rows`, "POST", JSON.stringify({ id: "y", data: { value: "2" } }))).status).toBe(401);
    expect((await call(tok2, `${base}/tables/settings/rows`, "POST", body)).status).toBe(404); // schema not installed yet: signature itself was fine
    // Other owner / other app paths are different namespaces: not reachable at all.
    expect((await call(signed(appKeyOf(ns), base.replace(ns.owner, "npub1other") + "/descriptor", "GET"), base.replace(ns.owner, "npub1other") + "/descriptor")).status).toBe(404);
    expect((await call(signed(appKeyOf(ns), base.replace(ns.nstack.appNpub, "npub1otherapp") + "/descriptor", "GET"), base.replace(ns.nstack.appNpub, "npub1otherapp") + "/descriptor")).status).toBe(404);
  });

  test("a mismatched configured app npub is rejected at startup", () => {
    expect(() => new NstackDb({ baseUrl: "https://x", ownerNpub: "npub1o", appNpub: "npub1wrong", appSecret: nsecEncode(generateSecretKey()) })).toThrow(/does not match/);
  });

  test("schema install is idempotent and a changed migration is refused (checksummed, append-only)", async () => {
    const { s } = await ready();
    await s.nstack.nstack.migrate(MIGRATIONS);
    expect(s.fake.migrations.length).toBe(1);
    await expect(s.nstack.nstack.migrate([{ ...MIGRATIONS[0], sql: MIGRATIONS[0].sql + "\n-- edited", checksum: MIGRATIONS[0].checksum }])).rejects.toMatchObject({ status: 400 });
  });

  test("NStack outage returns 503 without crashing, and the site recovers", async () => {
    const { s, cohort } = await ready();
    s.fake.failNext = 502;
    const r = await s.anon().get("/api/courses");
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).code).toBe("storage_unavailable");
    expect((await s.anon().get("/api/courses")).status).toBe(200);
    expect((await s.anon().get("/tokens.css")).status).toBe(200); // static assets never touch NStack
    expect(cohort.id).toBeGreaterThan(0);
  });
});

describe("concurrency", () => {
  test("many simultaneous signups for the last seats never oversell", async () => {
    const { s, cohort } = await ready(3);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => signup(s, cohort.slug, `p${i}@example.com`)));
    const ok = results.filter((r) => r.res.status === 200);
    const full = results.filter((r) => r.res.status === 409 && r.body.code === "cohort_full");
    expect(ok.length).toBe(3);
    expect(full.length).toBe(9);
    const held = s.fake.rows("seats").filter((r) => r.state === "held");
    expect(held.length).toBe(3);
    expect(new Set(held.map((r) => r.seat_no)).size).toBe(3);
    // Losers left no orphan accounts (admin + 3).
    expect(s.fake.rows("users").length).toBe(4);
    expect(((await (await s.anon().get(`/api/courses/${cohort.slug}`)).json()) as any).course.seatsLeft).toBe(0);
  });

  test("double-click enrol by one user yields one enrolment and one seat", async () => {
    const { s, cohort } = await ready();
    const { c } = await signup(s, cohort.slug, "dbl@example.com");
    const both = await Promise.all([c.post(`/api/courses/${cohort.slug}/enrol`, {}), c.post(`/api/courses/${cohort.slug}/enrol`, {})]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(s.fake.rows("enrolments").length).toBe(1);
    expect(s.fake.rows("seats").length).toBe(1);
  });

  test("concurrent signups with the same username: exactly one account", async () => {
    const { s, cohort } = await ready(10);
    const rs = await Promise.all(Array.from({ length: 5 }, () => signup(s, cohort.slug, "same@example.com")));
    expect(rs.filter((r) => r.res.status === 200).length).toBe(1);
    expect(rs.filter((r) => r.body.code === "username_taken").length).toBe(4);
    expect(s.fake.rows("users").filter((u) => u.username === "same@example.com").length).toBe(1);
  });

  test("integer ids stay unique under concurrent allocation", async () => {
    const { s } = await ready();
    const ids = await Promise.all(Array.from({ length: 25 }, () => s.app.store.nextId("probe")));
    expect(new Set(ids).size).toBe(25);
    expect(Math.min(...ids)).toBe(1);
    expect(Math.max(...ids)).toBe(25);
  });

  test("a lapsed reservation is taken over by exactly one of two racing claimants", async () => {
    const { s, cohort } = await ready(1);
    const first = await signup(s, cohort.slug, "a@example.com");
    expect(first.res.status).toBe(200);
    for (const r of s.fake.rows("seats")) r.reserved_until = 1;
    for (const r of s.fake.rows("enrolments")) r.reserved_until = 1;
    const racers = await Promise.all([signup(s, cohort.slug, "b@example.com"), signup(s, cohort.slug, "c@example.com")]);
    expect(racers.filter((r) => r.res.status === 200).length).toBe(1);
    expect(racers.filter((r) => r.res.status === 409).length).toBe(1);
    const seats = s.fake.rows("seats");
    expect(seats.length).toBe(1);
  });

  test("webhook retries and browser confirm race: one payment, one paid seat", async () => {
    const { s, cohort } = await ready();
    const { c, body } = await signup(s, cohort.slug, "pay@example.com");
    const sid = body.checkoutUrl.split("/").pop() as string;
    s.stripe.pay(sid);
    const evt = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { ...s.stripe.sessions.get(sid), client_reference_id: String(s.fake.rows("enrolments")[0].id) } } });
    const hdr = signStripePayload(evt, stripeKeys.webhookSecret);
    const hook = () => s.anon().req("POST", "/api/stripe/webhook", evt, { "stripe-signature": hdr });
    const rs = await Promise.all([hook(), hook(), c.get(`/api/enrolments/confirm?session_id=${sid}`), c.get(`/api/enrolments/confirm?session_id=${sid}`)]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const enr = s.fake.rows("enrolments");
    expect(enr.length).toBe(1);
    expect(enr[0].status).toBe("paid");
    expect(s.fake.rows("seats").map((r) => r.state)).toEqual(["paid"]);
    expect(((await (await s.admin.get("/api/admin/cohorts")).json()) as any).cohorts[0].revenueCents).toBe(10000);
  });

  test("a payment that lands after the reservation lapsed is honoured, even past capacity", async () => {
    const { s, cohort } = await ready(1);
    const a = await signup(s, cohort.slug, "late@example.com");
    const sid = a.body.checkoutUrl.split("/").pop() as string;
    for (const r of s.fake.rows("seats")) r.reserved_until = 1;
    for (const r of s.fake.rows("enrolments")) r.reserved_until = 1;
    expect((await signup(s, cohort.slug, "next@example.com")).res.status).toBe(200); // took the lapsed seat
    s.stripe.pay(sid);
    const r = await a.c.get(`/api/enrolments/confirm?session_id=${sid}`);
    expect(((await r.json()) as any).status).toBe("paid");
    const paid = s.fake.rows("seats").filter((x) => x.state === "paid");
    expect(paid.length).toBe(1);
    expect(((await (await s.anon().get(`/api/courses/${cohort.slug}`)).json()) as any).course.seatsLeft).toBe(0);
  });

  test("lowering capacity below held seats fails closed for new claims", async () => {
    const { s, cohort } = await ready(3);
    await signup(s, cohort.slug, "x1@example.com"); await signup(s, cohort.slug, "x2@example.com"); await signup(s, cohort.slug, "x3@example.com");
    // free the first seat then shrink capacity to 2 while seats 2 and 3 are still held
    const seat1 = s.fake.rows("seats").find((r) => r.seat_no === "1" || Number(r.seat_no) === 1)!;
    seat1.reserved_until = 1;
    const put = await s.admin.put(`/api/admin/cohorts/${cohort.id}`, { ...sample, capacity: 2 });
    expect(put.status).toBe(200);
    const late = await signup(s, cohort.slug, "x4@example.com");
    expect(late.res.status).toBe(409);
    expect(late.body.code).toBe("cohort_full");
  });
});

describe("persistence", () => {
  test("data, sessions and sealed Stripe config survive an app restart against the same namespace", async () => {
    const { s, cohort } = await ready();
    const { c } = await signup(s, cohort.slug, "stay@example.com");
    const app2 = await createApp({ nstack: s.nstack.nstack, config: { adminNpubs: [s.adminNpub], secretKey: "test-secret" }, stripeFactory: s.stripe.factory });
    const same = new Client(app2); same.cookie = c.cookie;
    expect(((await (await same.get("/api/me")).json()) as any).user.username).toBe("stay@example.com");
    expect(((await (await same.get("/api/me/enrolments")).json()) as any).enrolments.length).toBe(1);
    // Stripe secret is only readable with the original APP_SECRET_KEY.
    const wrong = await createApp({ nstack: s.nstack.nstack, config: { adminNpubs: [s.adminNpub], secretKey: "other" }, stripeFactory: s.stripe.factory });
    const admin2 = new Client(wrong);
    await admin2.nostrLogin(s.adminSk);
    expect((await admin2.get("/api/admin/stripe")).status).toBe(500);
    expect(NstackError).toBeDefined();
  });
});
