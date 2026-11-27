import { describe, expect, test } from "bun:test";
import { generateSecretKey } from "applesauce-core/helpers/keys";
import { PrivateKeySigner } from "applesauce-signers";
import { AUTH_KIND, createApp } from "../src/app.ts";
import { PETE_NPUB, loadConfig, npubToHex } from "../src/config.ts";
import { decryptNsec } from "../src/shared/backup.ts";
import { signStripePayload } from "../src/stripe.ts";
import { Client, setup, signupBody, stripeKeys } from "./helpers.ts";

const sample = { title: "Agent Ops", slug: "agent-ops", tagline: "Run agents", description: "Para one.\n\nPara two.", highlights: "A\nB", modules: "Week 1 — Basics\nWeek 2", startDate: "2027-03-01", endDate: "2027-03-29", schedule: "4 weeks · Live Tuesdays", location: "Online", priceCents: 10000, currency: "aud", capacity: 2, status: "published" };

async function withCohort(s: Awaited<ReturnType<typeof setup>>, over: Record<string, unknown> = {}) {
  const r = await s.admin.post("/api/admin/cohorts", { ...sample, ...over });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).cohort;
}
async function configureStripe(s: Awaited<ReturnType<typeof setup>>) {
  expect((await s.admin.put("/api/admin/stripe", stripeKeys)).status).toBe(200);
}

describe("health, static and pages", () => {
  test("health endpoint", async () => {
    const { anon } = await setup();
    const r = await anon().get("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok", app: "ambulando-web", artifactVersion: "v7" });
  });
  test("preserved marketing page, assets and nav links", async () => {
    const { anon } = await setup();
    const r = await anon().get("/");
    const html = await r.text();
    expect(r.status).toBe(200);
    expect(html).toContain("Solvitur Ambulando");
    expect(html).toContain('href="/courses"');
    expect((await anon().get("/tokens.css")).status).toBe(200);
    expect((await anon().get("/assets/workspace-document.png")).headers.get("content-type")).toBe("image/png");
    expect((await anon().get("/../package.json")).status).toBe(404);
    expect((await anon().get("/%2e%2e/package.json")).status).toBe(404);
  });
  test("app pages respond and client bundle builds", async () => {
    const { anon } = await setup();
    for (const p of ["/courses", "/courses/chief-of-staff-foundations", "/courses/chief-of-staff-foundations/enrol", "/login", "/account", "/admin"]) {
      const r = await anon().get(p);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
    }
    expect((await anon().get("/courses/nope")).status).toBe(404);
    const js = await anon().get("/_app/client.js");
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(10_000);
    expect((await anon().get("/_app/app.css")).status).toBe(200);
  });
  test("seeded sample course is published on empty DB", async () => {
    const { anon } = await setup();
    const html = await (await anon().get("/courses")).text();
    expect(html).toContain("Chief of Staff Foundations");
  });
});

describe("admin auth", () => {
  test("default admin is Pete's npub", () => {
    delete process.env.ADMIN_NPUBS;
    expect(loadConfig().adminNpubs).toEqual([PETE_NPUB]);
    expect(loadConfig().adminPubkeys.has(npubToHex(PETE_NPUB)!)).toBe(true);
  });
  test("valid signed challenge from admin npub gives admin session", async () => {
    const s = await setup();
    const me = (await (await s.admin.get("/api/me")).json()) as any;
    expect(me.user.isAdmin).toBe(true);
    expect(me.user.npub).toBe(s.adminNpub);
    expect((await s.admin.get("/api/admin/cohorts")).status).toBe(200);
    expect(await (await s.admin.get("/admin")).text()).toContain("Training admin");
  });
  test("non-admin npub can sign in but is rejected from admin routes", async () => {
    const s = await setup();
    const c = s.anon();
    const { res } = await c.nostrLogin(generateSecretKey());
    expect(res.status).toBe(200);
    expect(((await (await c.get("/api/me")).json()) as any).user.isAdmin).toBe(false);
    expect((await c.get("/api/admin/cohorts")).status).toBe(403);
    expect((await c.get("/api/admin/stripe")).status).toBe(403);
    expect((await s.anon().get("/api/admin/cohorts")).status).toBe(401);
    expect(await (await c.get("/admin")).text()).not.toContain("Training admin");
  });
  test("challenge is single-use, signature must be valid, kind must match", async () => {
    const s = await setup();
    const c = s.anon();
    const sk = generateSecretKey();
    const { event } = await c.nostrLogin(sk);
    expect((await c.post("/api/auth/nostr", { event })).status).toBe(401); // replay
    const { challenge } = (await (await c.get("/api/auth/challenge")).json()) as any;
    const signer = new PrivateKeySigner(sk);
    const good = await signer.signEvent({ kind: AUTH_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["challenge", challenge]], content: "" });
    expect((await c.post("/api/auth/nostr", { event: { ...good, content: "tampered" } })).status).toBe(401);
    const wrongKind = await signer.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [["challenge", challenge]], content: "" });
    expect((await c.post("/api/auth/nostr", { event: wrongKind })).status).toBe(400);
    const stale = await signer.signEvent({ kind: AUTH_KIND, created_at: Math.floor(Date.now() / 1000) - 3600, tags: [["challenge", challenge]], content: "" });
    expect((await c.post("/api/auth/nostr", { event: stale })).status).toBe(401);
    const unknown = await signer.signEvent({ kind: AUTH_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["challenge", "deadbeef"]], content: "" });
    expect((await c.post("/api/auth/nostr", { event: unknown })).status).toBe(401);
    expect((await c.post("/api/auth/nostr", { event: good })).status).toBe(200);
  });
  test("cross-origin mutation blocked and JSON required", async () => {
    const s = await setup();
    expect((await s.admin.req("POST", "/api/admin/cohorts", sample, { origin: "https://evil.example" })).status).toBe(403);
    expect((await s.admin.req("POST", "/api/admin/cohorts", "title=x", { "content-type": "text/plain" })).status).toBe(415);
  });
});

describe("stripe settings", () => {
  test("saves keys, reads back masked, never leaks secrets", async () => {
    const s = await setup();
    const r = await s.admin.put("/api/admin/stripe", stripeKeys);
    expect(r.status).toBe(200);
    const text = await (await s.admin.get("/api/admin/stripe")).text();
    const j = JSON.parse(text);
    expect(j.stripe).toMatchObject({ configured: true, mode: "test", publishableKey: stripeKeys.publishableKey, secretKeyHint: "sk_test_••••9876", webhookSecretConfigured: true });
    expect(text).not.toContain("SECRETSECRET");
    expect(text).not.toContain(stripeKeys.webhookSecret);
    // Stored encrypted at rest
    const raw = JSON.stringify(s.app.db.query("SELECT * FROM settings").all());
    expect(raw).not.toContain("SECRETSECRET");
  });
  test("validates formats, mode mismatch; blank secret keeps existing", async () => {
    const s = await setup();
    expect((await s.admin.put("/api/admin/stripe", { secretKey: "nope" })).status).toBe(400);
    expect((await s.admin.put("/api/admin/stripe", { publishableKey: "pk_test_abcdefgh12345678", secretKey: "sk_live_abcdefgh12345678" })).status).toBe(400);
    await configureStripe(s);
    expect((await s.admin.put("/api/admin/stripe", { publishableKey: "pk_test_zzzzzzzz99999999", secretKey: "" })).status).toBe(200);
    const j = (await (await s.admin.get("/api/admin/stripe")).json()) as any;
    expect(j.stripe.secretKeyHint).toBe("sk_test_••••9876");
    expect(j.stripe.publishableKey).toBe("pk_test_zzzzzzzz99999999");
  });
  test("test connection reports ok and failure without crashing", async () => {
    const s = await setup();
    expect((await s.admin.post("/api/admin/stripe/test")).status).toBe(400);
    await configureStripe(s);
    expect(((await (await s.admin.post("/api/admin/stripe/test")).json()) as any).ok).toBe(true);
    s.stripe.keyOk = false;
    const r = (await (await s.admin.post("/api/admin/stripe/test")).json()) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Invalid API Key");
  });
});

describe("cohorts", () => {
  test("create, list, update, publish/unpublish", async () => {
    const s = await setup();
    const c = await withCohort(s, { status: "draft", slug: "", title: "My New Cohort!" });
    expect(c.slug).toBe("my-new-cohort");
    expect(c.highlights).toEqual(["A", "B"]);
    expect(c.modules).toEqual([{ title: "Week 1", summary: "Basics" }, { title: "Week 2", summary: "" }]);
    const anon = s.anon();
    expect((await anon.get("/courses/my-new-cohort")).status).toBe(404);
    expect(((await (await anon.get("/api/courses")).json()) as any).courses.map((x: any) => x.slug)).not.toContain("my-new-cohort");
    const u = await s.admin.put(`/api/admin/cohorts/${c.id}`, { status: "published", priceDollars: 123.45, tagline: "New tag" });
    expect(((await u.json()) as any).cohort).toMatchObject({ status: "published", priceCents: 12345, tagline: "New tag", title: "My New Cohort!" });
    expect((await anon.get("/courses/my-new-cohort")).status).toBe(200);
    const list = ((await (await s.admin.get("/api/admin/cohorts")).json()) as any).cohorts;
    expect(list.length).toBe(2); // seeded sample + new
    await s.admin.put(`/api/admin/cohorts/${c.id}`, { status: "draft" });
    expect((await anon.get("/courses/my-new-cohort")).status).toBe(404);
  });
  test("validation and slug uniqueness", async () => {
    const s = await setup();
    await withCohort(s);
    expect((await s.admin.post("/api/admin/cohorts", sample)).status).toBe(409);
    expect((await s.admin.post("/api/admin/cohorts", { ...sample, slug: "x", title: "" })).status).toBe(400);
    expect((await s.admin.post("/api/admin/cohorts", { ...sample, slug: "y", capacity: 0 })).status).toBe(400);
    expect((await s.admin.post("/api/admin/cohorts", { ...sample, slug: "y", currency: "xyz" })).status).toBe(400);
    expect((await s.admin.post("/api/admin/cohorts", { ...sample, slug: "y", startDate: "2027-05-01", endDate: "2027-04-01" })).status).toBe(400);
    expect((await s.admin.post("/api/admin/cohorts", { ...sample, slug: "Bad Slug" })).status).toBe(400);
  });
  test("html in cohort content is escaped on public pages", async () => {
    const s = await setup();
    await withCohort(s, { slug: "xss", title: "<script>alert(1)</script>" });
    const html = await (await s.anon().get("/courses/xss")).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("signup, backup and login", () => {
  test("not configured: clear message and no account created", async () => {
    const s = await setup();
    const c = await withCohort(s);
    const { body } = await signupBody();
    const r = await s.anon().post(`/api/courses/${c.slug}/enrol`, body);
    expect(r.status).toBe(503);
    expect(((await r.json()) as any).code).toBe("stripe_not_configured");
    expect((s.app.db.query("SELECT COUNT(*) n FROM users").get() as any).n).toBe(1); // admin only
    expect(await (await s.anon().get(`/courses/${c.slug}/enrol`)).text()).toContain("Payments aren't set up yet");
  });
  test("signup creates account + encrypted backup + checkout; login restores nsec", async () => {
    const s = await setup();
    await configureStripe(s);
    const c = await withCohort(s);
    const { body, npub, nsec } = await signupBody();
    const user = s.anon();
    const r = await user.post(`/api/courses/${c.slug}/enrol`, body);
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.checkoutUrl).toStartWith("https://checkout.stripe.test/");
    expect(j.user.npub).toBe(npub);
    expect(s.stripe.factoryKeys.at(-1)).toBe(stripeKeys.secretKey);
    const params = s.stripe.sessions.get("cs_test_1")!.params;
    expect(params).toMatchObject({ amountCents: 10000, currency: "aud", customerEmail: "sam@example.com" });
    expect(params.successUrl).toContain("{CHECKOUT_SESSION_ID}");
    // DB holds the bundle and a hash, never plaintext nsec/password
    const row = s.app.db.query("SELECT * FROM users WHERE npub=?").get(npub) as any;
    expect(JSON.stringify(row)).not.toContain(nsec);
    expect(row.password_hash).not.toContain("correct horse");
    expect(await Bun.password.verify("correct horse", row.password_hash)).toBe(true);
    // fresh browser logs in with username + password and restores key
    const other = s.anon();
    const lr = await other.post("/api/auth/login", { identifier: "SAM@example.com", password: "correct horse" });
    expect(lr.status).toBe(200);
    const lj = (await lr.json()) as any;
    expect(lj.user.agentName).toBe("Atlas");
    expect(await decryptNsec(lj.backup, "correct horse")).toBe(nsec);
    await expect(decryptNsec(lj.backup, "wrong password")).rejects.toThrow();
    expect(((await (await other.get("/api/me/backup")).json()) as any).backup.npub).toBe(npub);
    // wrong password / unknown user
    expect((await s.anon().post("/api/auth/login", { identifier: "sam@example.com", password: "nope" })).status).toBe(401);
    expect((await s.anon().post("/api/auth/login", { identifier: "ghost", password: "x" })).status).toBe(401);
    // Password sessions never grant admin
    expect(((await (await other.get("/api/me")).json()) as any).user.isAdmin).toBe(false);
  });
  test("input validation and duplicate usernames", async () => {
    const s = await setup();
    await configureStripe(s);
    const c = await withCohort(s);
    const p = `/api/courses/${c.slug}/enrol`;
    expect((await s.anon().post(p, (await signupBody({ password: "short", passwordConfirm: "short" }, "short")).body)).status).toBe(400);
    expect((await s.anon().post(p, (await signupBody({ passwordConfirm: "different" })).body)).status).toBe(400);
    expect((await s.anon().post(p, (await signupBody({ agentName: "  " })).body)).status).toBe(400);
    const bad = await signupBody();
    expect((await s.anon().post(p, { ...bad.body, backup: { ...(bad.body.backup as any), npub: "npub1invalid" } })).status).toBe(400);
    expect((await s.anon().post(p, (await signupBody()).body)).status).toBe(200);
    const dup = await s.anon().post(p, (await signupBody({ identifier: "SAM@example.com" })).body);
    expect(dup.status).toBe(409);
  });
  test("logout clears session", async () => {
    const s = await setup();
    await s.admin.post("/api/auth/logout");
    expect((await s.admin.get("/api/admin/cohorts")).status).toBe(401);
  });
});

describe("payments", () => {
  async function enrolled() {
    const s = await setup();
    await configureStripe(s);
    const c = await withCohort(s);
    const user = s.anon();
    const { body, npub } = await signupBody();
    const r = (await (await user.post(`/api/courses/${c.slug}/enrol`, body)).json()) as any;
    return { s, c, user, npub, sessionId: r.checkoutUrl.split("/").pop() as string };
  }
  test("confirm is idempotent and counts once", async () => {
    const { s, c, user, sessionId } = await enrolled();
    let j = (await (await user.get(`/api/enrolments/confirm?session_id=${sessionId}`)).json()) as any;
    expect(j.status).toBe("pending");
    s.stripe.pay(sessionId);
    for (let i = 0; i < 3; i++) {
      j = (await (await user.get(`/api/enrolments/confirm?session_id=${sessionId}`)).json()) as any;
      expect(j.status).toBe("paid");
    }
    const sg = (await (await s.admin.get(`/api/admin/cohorts/${c.id}/signups`)).json()) as any;
    expect(sg.stats).toMatchObject({ seatsFilled: 1, capacity: 2, revenueCents: 10000 });
    expect(sg.signups.length).toBe(1);
    const again = await user.post(`/api/courses/${c.slug}/enrol`, { agentName: "Atlas" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).code).toBe("already_enrolled");
  });
  test("cannot confirm another user's session", async () => {
    const { s, sessionId } = await enrolled();
    s.stripe.pay(sessionId);
    const other = s.anon();
    await other.nostrLogin(generateSecretKey());
    expect((await other.get(`/api/enrolments/confirm?session_id=${sessionId}`)).status).toBe(404);
  });
  test("capacity: pending reservations hold seats, expired sessions free them", async () => {
    const { s, c } = await enrolled(); // 1 pending of 2
    expect((await s.anon().post(`/api/courses/${c.slug}/enrol`, (await signupBody({ identifier: "b@example.com" })).body)).status).toBe(200); // seat 2
    const full = await s.anon().post(`/api/courses/${c.slug}/enrol`, (await signupBody({ identifier: "c@example.com" })).body);
    expect(full.status).toBe(409);
    expect(((await full.json()) as any).code).toBe("cohort_full");
    expect((s.app.db.query("SELECT COUNT(*) n FROM users WHERE username='c@example.com'").get() as any).n).toBe(0);
    expect(await (await s.anon().get(`/courses/${c.slug}`)).text()).toContain("Cohort full");
    // reservation lapses
    s.app.db.query("UPDATE enrolments SET reserved_until=1 WHERE status='pending'").run();
    expect((await s.anon().post(`/api/courses/${c.slug}/enrol`, (await signupBody({ identifier: "c@example.com" })).body)).status).toBe(200);
  });
  test("expired checkout marks failed; retry creates a new session without duplicating enrolment", async () => {
    const { s, c, user, sessionId } = await enrolled();
    s.stripe.expire(sessionId);
    expect(((await (await user.get(`/api/enrolments/confirm?session_id=${sessionId}`)).json()) as any).status).toBe("failed");
    const retry = (await (await user.post(`/api/courses/${c.slug}/enrol`, { agentName: "Atlas" })).json()) as any;
    expect(retry.checkoutUrl).toContain("cs_test_2");
    expect((s.app.db.query("SELECT COUNT(*) n FROM enrolments").get() as any).n).toBe(1);
    s.stripe.pay("cs_test_2");
    expect(((await (await user.get("/api/enrolments/confirm?session_id=cs_test_2")).json()) as any).status).toBe("paid");
  });
  test("webhook: signature verified, idempotent by event id", async () => {
    const { s, c, sessionId } = await enrolled();
    s.stripe.pay(sessionId);
    const sess = s.stripe.sessions.get(sessionId)!;
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: { id: sessionId, client_reference_id: sess.client_reference_id, payment_status: "paid", status: "complete", amount_total: 10000, payment_intent: "pi_1" } } });
    const hook = (p: string, sig: string | null) => s.anon().req("POST", "/api/stripe/webhook", p, { "content-type": "application/json", ...(sig ? { "stripe-signature": sig } : {}) });
    expect((await hook(payload, null)).status).toBe(400);
    expect((await hook(payload, signStripePayload(payload, "whsec_wrongwrongwrong"))).status).toBe(400);
    const sig = signStripePayload(payload, stripeKeys.webhookSecret);
    expect((await hook(payload, sig)).status).toBe(200);
    const dup = (await (await hook(payload, sig)).json()) as any;
    expect(dup.duplicate).toBe(true);
    const sg = (await (await s.admin.get(`/api/admin/cohorts/${c.id}/signups`)).json()) as any;
    expect(sg.stats.seatsFilled).toBe(1);
    expect(sg.signups[0].status).toBe("paid");
  });
  test("free cohort enrols immediately without Stripe", async () => {
    const s = await setup();
    const c = await withCohort(s, { priceCents: 0, slug: "free" });
    const r = (await (await s.anon().post(`/api/courses/${c.slug}/enrol`, (await signupBody()).body)).json()) as any;
    expect(r.status).toBe("paid");
  });
  test("stripe failure leaves account usable and reports error", async () => {
    const s = await setup();
    await configureStripe(s);
    const c = await withCohort(s);
    const orig = s.stripe.factory;
    const failing = (k: string) => ({ ...orig(k), createCheckoutSession: async () => { throw new Error("boom"); } });
    const app2 = await createApp({ db: s.app.db, config: { databasePath: ":memory:", adminNpubs: [], secretKey: "test-secret" }, stripeFactory: failing });
    const r = await new Client(app2).post(`/api/courses/${c.slug}/enrol`, (await signupBody()).body);
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).code).toBe("stripe_error");
  });
});

describe("chief of staff agent + account + admin signups", () => {
  test("agent name set at signup, editable, validated, persisted", async () => {
    const s = await setup();
    await configureStripe(s);
    const c = await withCohort(s);
    const user = s.anon();
    await user.post(`/api/courses/${c.slug}/enrol`, (await signupBody({ agentName: "Atlas" })).body);
    expect(((await (await user.get("/api/me")).json()) as any).user.agentName).toBe("Atlas");
    const up = await user.patch("/api/me", { agentName: "Juno", displayName: "Sam W" });
    expect(((await up.json()) as any).user).toMatchObject({ agentName: "Juno", displayName: "Sam W" });
    expect((await user.patch("/api/me", { agentName: "" })).status).toBe(400);
    expect((await user.patch("/api/me", { agentName: "x".repeat(61) })).status).toBe(400);
    const fresh = s.anon();
    await fresh.post("/api/auth/login", { identifier: "sam@example.com", password: "correct horse" });
    expect(((await (await fresh.get("/api/me")).json()) as any).user.agentName).toBe("Juno");
    expect((await s.anon().patch("/api/me", { agentName: "x" })).status).toBe(401);
    const acct = await (await user.get("/account")).text();
    expect(acct).toContain('value="Juno"');
  });
  test("admin sees signups with all fields; account lists enrolments", async () => {
    const s = await setup();
    await configureStripe(s);
    const c = await withCohort(s);
    const a = await signupBody({ identifier: "a@example.com", displayName: "Alice", agentName: "Ada" });
    const b = await signupBody({ identifier: "b@example.com", displayName: "Bob", agentName: "Bix" });
    const ua = s.anon(), ub = s.anon();
    const ra = (await (await ua.post(`/api/courses/${c.slug}/enrol`, a.body)).json()) as any;
    await ub.post(`/api/courses/${c.slug}/enrol`, b.body);
    s.stripe.pay(ra.checkoutUrl.split("/").pop());
    await ua.get(`/api/enrolments/confirm?session_id=${ra.checkoutUrl.split("/").pop()}`);
    const sg = (await (await s.admin.get(`/api/admin/cohorts/${c.id}/signups`)).json()) as any;
    expect(sg.stats).toMatchObject({ seatsFilled: 1, capacity: 2, revenueCents: 10000, currency: "aud" });
    const byName = Object.fromEntries(sg.signups.map((x: any) => [x.name, x]));
    expect(byName.Alice).toMatchObject({ username: "a@example.com", npub: a.npub, agentName: "Ada", status: "paid", amountCents: 10000 });
    expect(byName.Bob).toMatchObject({ npub: b.npub, agentName: "Bix", status: "pending", amountCents: 0 });
    expect(byName.Alice.signedUpAt).toBeGreaterThan(0);
    expect((await ua.get(`/api/admin/cohorts/${c.id}/signups`)).status).toBe(403);
    expect((await s.admin.get("/api/admin/cohorts/9999/signups")).status).toBe(404);
    const mine = ((await (await ua.get("/api/me/enrolments")).json()) as any).enrolments;
    expect(mine[0]).toMatchObject({ slug: c.slug, status: "paid" });
  });
});
