import { generateSecretKey, getPublicKey } from "applesauce-core/helpers/keys";
import { npubEncode, nsecEncode } from "applesauce-core/helpers/pointers";
import { ExtensionSigner } from "applesauce-signers";
import { decryptNsec, encryptNsec } from "../shared/backup.ts";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (cents: number, cur: string) => new Intl.NumberFormat("en-AU", { style: "currency", currency: cur.toUpperCase() }).format(cents / 100);
const when = (ms: number) => new Date(ms).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });

async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { data, status: res.status });
  return data as T;
}

function showError(form: ParentNode, msg: string | null, sel = ".form-error") {
  const el = $(sel, form);
  if (!el) return;
  el.textContent = msg ?? "";
  el.hidden = !msg;
}
const formData = (f: HTMLFormElement) => Object.fromEntries(new FormData(f).entries()) as Record<string, string>;

async function withBusy(btn: HTMLButtonElement | null, fn: () => Promise<void>) {
  if (btn) btn.disabled = true;
  try { await fn(); } finally { if (btn) btn.disabled = false; }
}

// ---------- Nostr login (NIP-07 via Applesauce ExtensionSigner) ----------
async function nostrLogin(errorEl: HTMLElement | null) {
  const fail = (m: string) => { if (errorEl) { errorEl.textContent = m; errorEl.hidden = false; } };
  if (!(window as any).nostr) return fail("No Nostr browser extension (NIP-07) found. Install one such as Alby or nos2x and try again.");
  try {
    const { challenge, kind } = await api("/api/auth/challenge");
    const signer = new ExtensionSigner();
    const event = await signer.signEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags: [["challenge", challenge]], content: "Sign in to Ambulando" });
    await api("/api/auth/nostr", { method: "POST", body: { event } });
    location.href = document.body.dataset.page === "admin" ? "/admin" : "/account";
  } catch (e: any) { fail(e.message || "Nostr sign-in failed"); }
}
document.querySelectorAll<HTMLButtonElement>("[data-nostr-login]").forEach((b) =>
  b.addEventListener("click", () => nostrLogin($("#nostr-error"))));
document.querySelectorAll("[data-logout]").forEach((b) => b.addEventListener("click", async () => { await api("/api/auth/logout", { method: "POST", body: {} }); location.href = "/"; }));
document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-copy]");
  if (t) { navigator.clipboard?.writeText(t.dataset.copy!); const old = t.textContent; t.textContent = "Copied"; setTimeout(() => (t.textContent = old), 1200); }
});

// ---------- Login ----------
const loginForm = $<HTMLFormElement>("#login-form");
loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(loginForm, null);
  await withBusy($("button[type=submit]", loginForm), async () => {
    try {
      const d = formData(loginForm);
      const r = await api("/api/auth/login", { method: "POST", body: { identifier: d.identifier, password: d.password } });
      // Restore: decrypt the backed-up nsec locally to confirm it matches the account npub.
      if (r.backup) {
        try { await decryptNsec(r.backup, d.password); } catch { /* shown on account page */ }
      }
      location.href = "/account";
    } catch (err: any) { showError(loginForm, err.message); }
  });
});

// ---------- Enrol ----------
const enrolForm = $<HTMLFormElement>("#enrol-form");
enrolForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  showError(enrolForm, null);
  await withBusy($("button[type=submit]", enrolForm), async () => {
    try {
      const d = formData(enrolForm);
      const slug = enrolForm.dataset.slug!;
      let body: Record<string, unknown>;
      if (enrolForm.dataset.mode === "member") body = { agentName: d.agentName };
      else {
        if (d.password !== d.passwordConfirm) throw new Error("Passwords do not match");
        const sk = generateSecretKey();
        const npub = npubEncode(getPublicKey(sk));
        const backup = await encryptNsec(npub, nsecEncode(sk), d.password);
        body = { displayName: d.displayName, identifier: d.identifier, password: d.password, passwordConfirm: d.passwordConfirm, agentName: d.agentName, backup };
      }
      const r = await api(`/api/courses/${slug}/enrol`, { method: "POST", body });
      if (r.checkoutUrl) location.href = r.checkoutUrl;
      else location.href = r.redirect ?? `/courses/${slug}/enrol/complete`;
    } catch (err: any) {
      showError(enrolForm, err.message);
      // The account may exist even if payment couldn't start; send them to retry as a member.
      if (err.data?.code === "stripe_error") showError(enrolForm, `${err.message}. Your account was created — reload this page to try again.`);
    }
  });
});

// ---------- Enrolment complete ----------
const complete = $("#complete");
if (complete) {
  (async () => {
    const sid = complete.dataset.session;
    try {
      const r = sid ? await api(`/api/enrolments/confirm?session_id=${encodeURIComponent(sid)}`) : { status: "paid", user: (await api("/api/me")).user };
      const u = r.user;
      if (r.status === "paid") {
        complete.innerHTML = `<p class="eyebrow">You're in</p><h1>Welcome aboard${u?.displayName ? ", " + esc(u.displayName) : ""}.</h1>
<p class="muted">Payment received. Your seat is confirmed.</p>
<p class="muted small">Your npub</p><div class="mono copyrow"><code>${esc(u?.npub)}</code><button class="btn btn-outline btn-sm" type="button" data-copy="${esc(u?.npub)}">Copy</button></div>
<p class="muted small">Your Chief of Staff agent</p><p><strong>${esc(u?.agentName)}</strong></p>
<a class="btn btn-primary" href="/account">Go to your account</a>`;
      } else if (r.status === "failed") {
        complete.innerHTML = `<h1>Payment didn't complete</h1><p class="muted">The checkout session expired. No charge was made.</p><a class="btn btn-primary" href="/courses/${complete.dataset.slug}/enrol">Try again</a>`;
      } else {
        complete.innerHTML = `<h1>Payment pending</h1><p class="muted">We haven't received confirmation yet. Refresh in a moment, or check your account.</p><a class="btn btn-outline" href="/account">Go to your account</a>`;
      }
    } catch (err: any) {
      complete.innerHTML = `<h1>We couldn't confirm that</h1><p class="form-error">${esc(err.message)}</p><a class="btn btn-outline" href="/account">Go to your account</a>`;
    }
  })();
}

// ---------- Account ----------
const profile = $<HTMLFormElement>("#profile-form");
if (profile) {
  profile.addEventListener("submit", async (e) => {
    e.preventDefault();
    showError(profile, null); showError(profile, null, ".form-ok");
    await withBusy($("button[type=submit]", profile), async () => {
      try { await api("/api/me", { method: "PATCH", body: formData(profile) }); showError(profile, "Saved", ".form-ok"); }
      catch (err: any) { showError(profile, err.message); }
    });
  });
  (async () => {
    const box = $("#my-courses")!;
    const { enrolments } = await api("/api/me/enrolments");
    box.innerHTML = enrolments.length
      ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Starts</th><th>Status</th><th>Paid</th></tr></thead><tbody>${enrolments.map((x: any) =>
        `<tr><td><a href="/courses/${esc(x.slug)}">${esc(x.title)}</a><div class="muted small">${esc(x.schedule)}</div></td><td>${esc(x.startDate)}</td><td><span class="status status-${esc(x.status)}">${esc(x.status)}</span></td><td>${x.status === "paid" ? money(x.amountCents, x.currency) : "—"}</td></tr>`).join("")}</tbody></table></div>`
      : `You haven't enrolled yet. <a href="/courses">Browse courses</a>.`;
    const { backup } = await api("/api/me/backup");
    if (backup) {
      $("#backup-box")!.hidden = false;
      const unlock = $<HTMLFormElement>("#unlock-form")!;
      unlock.addEventListener("submit", async (e) => {
        e.preventDefault();
        showError(unlock, null);
        try {
          const nsec = await decryptNsec(backup, formData(unlock).password);
          $("#nsec")!.textContent = nsec;
          $("#nsec-out")!.hidden = false;
          $("#copy-nsec")!.onclick = () => navigator.clipboard?.writeText(nsec);
        } catch { showError(unlock, "Wrong password, or the backup could not be decrypted."); }
      });
    }
  })();
}

// ---------- Admin ----------
const adminRoot = $("#admin-root");
if (adminRoot) initAdmin(adminRoot);

function initAdmin(root: HTMLElement) {
  const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
  const select = (name: string) => {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
    if (name === "stripe") stripeView(); else cohortList();
  };
  tabs.forEach((t) => t.addEventListener("click", () => select(t.dataset.tab!)));
  select("cohorts");

  async function cohortList() {
    const { cohorts } = await api("/api/admin/cohorts");
    root.innerHTML = `<div class="toolbar"><h2>Cohorts</h2><button class="btn btn-primary" id="new-cohort">+ Create cohort</button></div>
${cohorts.length ? `<div class="table-wrap"><table><thead><tr><th>Cohort</th><th>Status</th><th>Starts</th><th>Price</th><th>Seats</th><th>Revenue</th><th></th></tr></thead><tbody>${cohorts.map((c: any) =>
      `<tr><td><strong>${esc(c.title)}</strong><div class="muted small">/courses/${esc(c.slug)}</div></td><td><span class="status status-${esc(c.status)}">${esc(c.status)}</span></td><td>${esc(c.startDate)}</td><td>${money(c.priceCents, c.currency)}</td><td>${c.enrolled} / ${c.capacity}</td><td>${money(c.revenueCents, c.currency)}</td><td><button class="btn btn-outline btn-sm" data-signups="${c.id}">Signups</button> <button class="btn btn-outline btn-sm" data-edit="${c.id}">Edit</button></td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card"><h3>No cohorts yet</h3><p class="muted">Create your first training cohort.</p></div>`}`;
    $("#new-cohort")!.onclick = () => cohortForm();
    root.querySelectorAll<HTMLElement>("[data-edit]").forEach((b) => (b.onclick = () => cohortForm(cohorts.find((c: any) => c.id == b.dataset.edit))));
    root.querySelectorAll<HTMLElement>("[data-signups]").forEach((b) => (b.onclick = () => signups(Number(b.dataset.signups))));
  }

  function cohortForm(c?: any) {
    const v = (k: string, d = "") => esc(c?.[k] ?? d);
    root.innerHTML = `<div class="toolbar"><h2>${c ? "Edit cohort" : "Create cohort"}</h2><button class="btn btn-outline" id="back">← Back</button></div>
<form id="cohort-form" class="card form"><div class="cols cols-2"><label>Title<input name="title" required value="${v("title")}"></label><label>Slug<input name="slug" placeholder="auto from title" value="${v("slug")}"></label></div>
<label>Tagline<input name="tagline" value="${v("tagline")}"></label>
<label>Description<textarea name="description" rows="6">${v("description")}</textarea></label>
<div class="cols cols-2"><label>Highlights (one per line)<textarea name="highlights">${esc((c?.highlights ?? []).join("\n"))}</textarea></label><label>Curriculum modules (one per line: Title — summary)<textarea name="modules">${esc((c?.modules ?? []).map((m: any) => m.summary ? `${m.title} — ${m.summary}` : m.title).join("\n"))}</textarea></label></div>
<div class="cols"><label>Start date<input type="date" name="startDate" value="${v("startDate")}"></label><label>End date<input type="date" name="endDate" value="${v("endDate")}"></label><label>Status<select name="status">${["draft", "published", "archived"].map((s) => `<option ${c?.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label></div>
<div class="cols cols-2"><label>Schedule / cadence<input name="schedule" placeholder="4 weeks · Live Tuesdays" value="${v("schedule")}"></label><label>Location / format<input name="location" placeholder="Online + Ambulando Cohort Workspace" value="${v("location")}"></label></div>
<div class="cols"><label>Price<input type="number" step="0.01" min="0" name="priceDollars" required value="${c ? (c.priceCents / 100).toFixed(2) : "495.00"}"></label><label>Currency<select name="currency">${["aud", "usd", "eur", "gbp", "nzd", "cad"].map((s) => `<option value="${s}" ${(c?.currency ?? "aud") === s ? "selected" : ""}>${s.toUpperCase()}</option>`).join("")}</select></label><label>Capacity (seats)<input type="number" min="1" name="capacity" required value="${v("capacity", "20")}"></label></div>
${c ? `<p class="muted small">${c.enrolled} seat(s) paid so far.</p>` : ""}
<div class="form-error" role="alert" hidden></div><div class="form-ok" role="status" hidden></div><div><button class="btn btn-primary" type="submit">${c ? "Save changes" : "Create cohort"}</button></div></form>`;
    $("#back")!.onclick = cohortList;
    const f = $<HTMLFormElement>("#cohort-form")!;
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); showError(f, null);
      await withBusy($("button[type=submit]", f), async () => {
        try {
          const d = formData(f);
          const body = { ...d, priceDollars: Number(d.priceDollars), capacity: Number(d.capacity), priceCents: Math.round(Number(d.priceDollars) * 100) };
          await api(c ? `/api/admin/cohorts/${c.id}` : "/api/admin/cohorts", { method: c ? "PUT" : "POST", body });
          cohortList();
        } catch (err: any) { showError(f, err.message); }
      });
    });
  }

  async function signups(id: number) {
    const r = await api(`/api/admin/cohorts/${id}/signups`);
    const { cohort, stats } = r;
    root.innerHTML = `<div class="toolbar"><div><h2>${esc(cohort.title)}</h2><span class="status status-${esc(cohort.status)}">${esc(cohort.status)}</span></div><button class="btn btn-outline" id="back">← Back</button></div>
<div class="stats"><div class="stat"><b>${stats.seatsFilled} / ${stats.capacity}</b><span>Seats filled</span></div><div class="stat"><b>${money(stats.revenueCents, stats.currency)}</b><span>Revenue</span></div><div class="stat"><b>${r.signups.length}</b><span>Total signups (all statuses)</span></div></div>
${r.signups.length ? `<div class="table-wrap"><table><thead><tr><th>Participant</th><th>Username / email</th><th>npub</th><th>Chief of Staff agent</th><th>Payment</th><th>Paid</th><th>Signed up</th></tr></thead><tbody>${r.signups.map((s: any) =>
      `<tr><td>${esc(s.name)}</td><td>${esc(s.username ?? s.email ?? "—")}</td><td><code>${esc(s.npub.slice(0, 14))}…${esc(s.npub.slice(-6))}</code> <button class="btn btn-outline btn-sm" data-copy="${esc(s.npub)}">Copy</button></td><td>${esc(s.agentName || "—")}</td><td><span class="status status-${esc(s.status)}">${esc(s.status)}</span></td><td>${s.status === "paid" ? money(s.amountCents, s.currency) : "—"}</td><td>${when(s.signedUpAt)}</td></tr>`).join("")}</tbody></table></div>`
      : `<div class="card"><p class="muted">No signups yet.</p></div>`}`;
    $("#back")!.onclick = cohortList;
  }

  async function stripeView() {
    const { stripe: s, webhookUrl } = await api("/api/admin/stripe");
    root.innerHTML = `<div class="toolbar"><h2>Stripe settings</h2><span class="status ${s.configured ? "status-paid" : "status-pending"}">${s.configured ? `Configured · ${s.mode} mode` : "Not configured"}</span></div>
<form id="stripe-form" class="card form" style="max-width:720px" autocomplete="off">
<label>Publishable key<input name="publishableKey" placeholder="pk_test_…" value="${esc(s.publishableKey ?? "")}"></label>
<label>Secret key ${s.secretKeyHint ? `<span class="muted small">Saved: ${esc(s.secretKeyHint)} — leave blank to keep</span>` : ""}<input name="secretKey" type="password" placeholder="${s.secretKeyHint ? esc(s.secretKeyHint) : "sk_test_…"}" autocomplete="new-password"></label>
<label>Webhook signing secret (optional) ${s.webhookSecretHint ? `<span class="muted small">Saved: ${esc(s.webhookSecretHint)} — leave blank to keep</span>` : ""}<input name="webhookSecret" type="password" placeholder="${s.webhookSecretHint ? esc(s.webhookSecretHint) : "whsec_…"}" autocomplete="new-password"></label>
<p class="hint">Webhook endpoint: <code>${esc(webhookUrl)}</code> (event: <code>checkout.session.completed</code>). Payments are confirmed on return from Stripe even without the webhook. The secret key is stored encrypted and never shown again.</p>
<div class="form-error" role="alert" hidden></div><div class="form-ok" role="status" hidden></div>
<div style="display:flex;gap:12px"><button class="btn btn-primary" type="submit">Save</button><button class="btn btn-outline" type="button" id="test-stripe" ${s.secretKeyConfigured ? "" : "disabled"}>Test connection</button></div></form>`;
    const f = $<HTMLFormElement>("#stripe-form")!;
    f.addEventListener("submit", async (e) => {
      e.preventDefault(); showError(f, null); showError(f, null, ".form-ok");
      await withBusy($("button[type=submit]", f), async () => {
        try { await api("/api/admin/stripe", { method: "PUT", body: formData(f) }); await stripeView(); const ok = $(".form-ok")!; ok.textContent = "Saved"; ok.hidden = false; }
        catch (err: any) { showError(f, err.message); }
      });
    });
    $("#test-stripe")!.onclick = async () => {
      showError(f, null); showError(f, null, ".form-ok");
      try {
        const r = await api("/api/admin/stripe/test", { method: "POST", body: {} });
        if (r.ok) showError(f, `Connected to Stripe (${r.mode} mode).`, ".form-ok"); else showError(f, `Stripe check failed: ${r.error}`);
      } catch (err: any) { showError(f, err.message); }
    };
  }
}
