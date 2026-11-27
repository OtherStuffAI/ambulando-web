export interface PageCtx { user: { npub: string; displayName: string; agentName: string; username: string | null; isAdmin: boolean } | null; adminNpubs: string[] }
export interface CohortV {
  id: number; slug: string; title: string; tagline: string; description: string; highlights: string[]; modules: { title: string; summary: string }[];
  startDate: string; endDate: string; schedule: string; location: string; priceCents: number; currency: string; capacity: number; status: string; enrolled: number; seatsLeft: number;
}

export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function money(cents: number, currency: string) {
  if (cents === 0) return "Free";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}
export function fmtDate(d: string) {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function renderPage(title: string, page: string, body: string, ctx: PageCtx) {
  const u = ctx.user;
  const nav = [
    `<a href="/"${page === "home" ? ' aria-current="page"' : ""}>Home</a>`,
    `<a href="/courses"${page === "courses" || page === "course" ? ' aria-current="page"' : ""}>Courses</a>`,
    u ? `<a href="/account"${page === "account" ? ' aria-current="page"' : ""}>Account</a>` : `<a href="/login"${page === "login" ? ' aria-current="page"' : ""}>Sign in</a>`,
    u ? "" : `<a class="nav-cta" href="/courses">Join a cohort</a>`,
    u?.isAdmin ? `<a href="/admin"${page === "admin" ? ' aria-current="page"' : ""}>Admin</a>` : "",
    u ? `<button class="link-btn" data-logout type="button">Sign out</button>` : "",
  ].join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Ambulando</title><meta name="description" content="Ambulando training cohorts: put AI agents to work and stay sane.">
<meta name="theme-color" content="#000000"><meta property="og:title" content="${esc(title)} · Ambulando"><meta property="og:image" content="/assets/brand/passage-social.png">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/passage-32.png"><link rel="icon" type="image/png" sizes="16x16" href="/assets/brand/passage-16.png"><link rel="apple-touch-icon" sizes="180x180" href="/assets/brand/passage-180.png"><link rel="icon" type="image/png" sizes="192x192" href="/assets/brand/passage-192.png">
<link rel="stylesheet" href="/_app/app.css"><script type="module" src="/_app/client.js"></script></head>
<body data-page="${esc(page)}"><a class="skip" href="#main">Skip to content</a>
<header class="site"><div class="wrap bar"><a class="brand" href="/"><img src="/assets/brand/passage-app.png" width="40" height="40" alt=""><span>Ambulando</span></a><nav aria-label="Main">${nav}</nav></div></header>
<main id="main">${body}</main>
<footer class="site"><div class="wrap"><span>Ambulando · Work with AI, Stay Sane.</span><span class="foot-links"><a href="/courses">Courses</a><a href="/login">Sign in</a><span>Powered by NStack</span></span></div></footer>
</body></html>`;
}

function badges(c: CohortV) {
  const bits = [c.schedule, c.location, c.startDate ? `Starts ${fmtDate(c.startDate)}` : ""].filter(Boolean);
  return bits.map((b) => `<span class="badge">${esc(b)}</span>`).join("");
}

function seatsLabel(c: CohortV) {
  if (c.seatsLeft <= 0) return `<span class="pill pill-out">Cohort full</span>`;
  if (c.seatsLeft <= 5) return `<span class="pill pill-warn">${c.seatsLeft} seat${c.seatsLeft === 1 ? "" : "s"} left</span>`;
  return `<span class="pill">${c.seatsLeft} of ${c.capacity} seats open</span>`;
}

export function homePage() {
  const shot = (f: string, t: string, d: string, alt: string, wide = false) => `<figure class="shot${wide ? " wide" : ""}"><img src="/assets/${f}" alt="${esc(alt)}" loading="lazy"><figcaption><b>${esc(t)}</b>${esc(d)}</figcaption></figure>`;
  return `<section class="home-hero"><div class="wrap"><div class="hero-mark"><img src="/assets/brand/passage-app.png" width="40" height="40" alt=""><span>Solvitur Ambulando</span></div>
<h1>Work with AI. <em>Stay sane.</em></h1><p class="lead">Think out loud with your agents. Ambulando turns the conversation into tasks, documents and tools in one shared workspace that keeps you grounded as it grows.</p>
<div class="cta-row"><a class="btn btn-primary btn-lg" href="/courses">Join a cohort <span class="arr" aria-hidden="true">→</span></a><a class="btn btn-outline btn-lg" href="/login">Sign in</a></div></div></section>
<div class="strip"><div class="wrap"><span>Your direction</span><span>Your agents</span><span>Your data</span><span>Powered by NStack</span></div></div>
<section class="wrap section" id="product"><div class="sec-head"><p class="eyebrow">A home for the work</p><h2>Mostly, you just talk.</h2><p>Start with a conversation in a channel. Your agent tracks the work through tasks, updates and documents.</p></div>
<div class="shots">${shot("workspace-thread.png", "Conversation", "Talk the brief through with your agent, share a voice note and agree the next step.", "Ambulando conversation thread with human and agent dialogue", true)}${shot("workspace-tasks.png", "Task board", "See what is moving, what needs review and what comes next.", "Ambulando task board grouped by state")}${shot("workspace-task-detail.png", "Task review", "Inspect progress comments and follow the linked document.", "Ambulando task review with progress comments")}${shot("workspace-document.png", "Documents", "Review imagery, tables and human and agent feedback side by side.", "Ambulando document review", true)}</div>
<p class="muted small" style="margin-top:16px">Real Ambulando interface with isolated sample workspace data.</p></section>
<section class="wrap section"><div class="sec-head"><p class="eyebrow">Why Ambulando</p><h2>More capability.<br><em>More breathing room.</em></h2></div>
<div class="bento"><div class="card span4 tint"><span class="num">01</span><h3>Stay in the loop, keep your head clear</h3><p>One useful agent becomes several. Projects multiply. Ambulando gives that activity a structure you can come back to, rather than another stream to remember.</p></div>
<div class="card"><span class="num">02</span><h3>Multiplayer</h3><p>Many people, many agents, your rules. Access matches each role.</p></div>
<div class="card"><span class="num">03</span><h3>Shared context</h3><p>Organise around the work, with the brief and files next to the thread.</p></div>
<div class="card"><span class="num">04</span><h3>Clear responsibility</h3><p>Designer, research agent, coding agent. The owner is always visible.</p></div>
<div class="card"><span class="num">05</span><h3>Keep options open</h3><p>Workflows and knowledge live outside any one agent session.</p></div>
<div class="card span3"><span class="num">06</span><h3>NStack: unruggable infrastructure</h3><p>Nostr Stack connects people, agents, apps and data. Let your agents build and keep the foundation yours.</p></div>
<div class="card span3"><span class="num">07</span><h3>Wingman runs your agents</h3><p>Run your own Wingman or use a hosted option, connected to the workspace and infrastructure you choose.</p></div></div></section>
<section class="wrap section"><div class="sec-head"><p class="eyebrow">Before you step in</p><h2>A few useful answers.</h2></div>
<details><summary>How do Ambulando, NStack and Wingman fit together?</summary><p>Ambulando is the human workspace. NStack is the shared infrastructure for data, files, knowledge and access. Wingman runs agents and workflows that connect to both.</p></details>
<details><summary>How do I learn to work this way?</summary><p>Join a live cohort. Small groups, hands-on, and you leave with your own Chief of Staff agent.</p></details></section>
<section class="wrap section"><div class="final"><p class="eyebrow">Solvitur Ambulando</p><h2>Find the next step.<br><em>Take it together.</em></h2><p>Start with a conversation. Build a way of working that stays yours.</p><div class="cta-row"><a class="btn btn-primary btn-lg" href="/courses">See courses <span class="arr" aria-hidden="true">→</span></a><a class="btn btn-outline btn-lg" href="/login">Sign in</a></div></div></section>`;
}

export function catalogPage(courses: CohortV[]) {
  const cards = courses.map((c) => `<article class="card course-card"><div class="card-top"><p class="eyebrow">Cohort${c.startDate ? " · " + esc(fmtDate(c.startDate)) : ""}</p><h2><a href="/courses/${esc(c.slug)}">${esc(c.title)}</a></h2><p class="lead">${esc(c.tagline)}</p><div class="badges">${badges(c)}</div></div>
<div class="card-foot"><div><span class="price">${esc(money(c.priceCents, c.currency))}</span> ${c.priceCents ? `<span class="muted small">${esc(c.currency.toUpperCase())}</span>` : ""}</div>${seatsLabel(c)}<a class="btn btn-primary" href="/courses/${esc(c.slug)}">View course</a></div></article>`).join("");
  return `<section class="hero hero-sm"><div class="wrap"><p class="eyebrow">Training</p><h1>Learn to work with <em>your agents.</em></h1><p class="lead">Small live cohorts for people who want AI doing real work, with their head still on straight.</p></div></section>
<section class="wrap section"><div class="grid">${cards || `<div class="empty card"><h2>No cohorts open right now</h2><p class="muted">New cohorts are announced here. Check back soon.</p></div>`}</div></section>`;
}

export function coursePage(c: CohortV) {
  const modules = c.modules.length ? `<section class="block"><h2>Curriculum</h2><ol class="modules">${c.modules.map((m) => `<li><strong>${esc(m.title)}</strong>${m.summary ? `<p>${esc(m.summary)}</p>` : ""}</li>`).join("")}</ol></section>` : "";
  const highlights = c.highlights.length ? `<section class="block"><h2>What you get</h2><ul class="ticks">${c.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></section>` : "";
  const paras = c.description.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("");
  const full = c.seatsLeft <= 0;
  const archived = c.status === "archived";
  const cta = archived ? `<span class="btn btn-disabled" aria-disabled="true">Enrolment closed</span>`
    : full ? `<span class="btn btn-disabled" aria-disabled="true">Cohort full</span>`
    : `<a class="btn btn-primary btn-block" href="/courses/${esc(c.slug)}/enrol">Enrol now</a>`;
  return `<section class="hero"><div class="wrap"><p class="eyebrow"><a href="/courses">← All courses</a></p><h1>${esc(c.title)}</h1><p class="lead">${esc(c.tagline)}</p><div class="badges">${badges(c)}</div></div></section>
<section class="wrap detail"><div class="detail-main"><section class="block prose"><h2>About this cohort</h2>${paras}</section>${highlights}${modules}</div>
<aside class="card buy"><p class="eyebrow">Enrol</p><div class="price big">${esc(money(c.priceCents, c.currency))}</div><p class="muted small">${c.priceCents ? esc(c.currency.toUpperCase()) + " · one-off card payment" : ""}</p>
<dl class="facts">${c.startDate ? `<dt>Starts</dt><dd>${esc(fmtDate(c.startDate))}</dd>` : ""}${c.endDate ? `<dt>Ends</dt><dd>${esc(fmtDate(c.endDate))}</dd>` : ""}${c.schedule ? `<dt>Schedule</dt><dd>${esc(c.schedule)}</dd>` : ""}${c.location ? `<dt>Format</dt><dd>${esc(c.location)}</dd>` : ""}<dt>Seats</dt><dd>${c.enrolled} enrolled · ${c.seatsLeft} open</dd></dl>
${cta}
<p class="muted small">You'll get a fresh Nostr identity and name your Chief of Staff agent.</p></aside></section>`;
}

export function enrolPage(c: CohortV, user: PageCtx["user"], stripeReady: boolean) {
  const warn = !stripeReady && c.priceCents > 0 ? `<div class="notice notice-warn" role="alert"><strong>Payments aren't set up yet.</strong> The administrator needs to add Stripe keys in <a href="/admin">/admin</a> before you can pay.</div>` : "";
  const summary = `<aside class="card"><p class="eyebrow">Your cohort</p><h2>${esc(c.title)}</h2><p class="muted">${esc(c.tagline)}</p><div class="badges">${badges(c)}</div><div class="price big">${esc(money(c.priceCents, c.currency))}</div>${seatsLabel(c)}</aside>`;
  const agent = `<label>Name your Chief of Staff agent<input name="agentName" required maxlength="60" placeholder="e.g. Atlas" value="${esc(user?.agentName ?? "")}" autocomplete="off"></label><p class="hint">Your agent's name. You can change it any time in your account.</p>`;
  const form = user
    ? `<form id="enrol-form" class="card form" data-slug="${esc(c.slug)}" data-mode="member"><h2>Confirm your enrolment</h2><p>Signed in as <strong>${esc(user.displayName || user.username || user.npub.slice(0, 16) + "…")}</strong>.</p>${agent}<div class="form-error" role="alert" hidden></div><button class="btn btn-primary btn-block" type="submit">${c.priceCents ? "Continue to card payment" : "Confirm enrolment"}</button></form>`
    : `<form id="enrol-form" class="card form" data-slug="${esc(c.slug)}" data-mode="new"><h2>Create your account</h2>
<label>Your name<input name="displayName" required maxlength="80" autocomplete="name"></label>
<label>Username or email<input name="identifier" required maxlength="120" autocomplete="username"></label>
<div class="row"><label>Password<input name="password" type="password" required minlength="8" autocomplete="new-password"></label><label>Confirm password<input name="passwordConfirm" type="password" required minlength="8" autocomplete="new-password"></label></div>
${agent}
<p class="hint">We create a new Nostr key for you in your browser. Its private key (nsec) is encrypted with your password before it is backed up to us. <a href="/login">Already have an account? Sign in.</a></p>
<div class="form-error" role="alert" hidden></div><button class="btn btn-primary btn-block" type="submit">${c.priceCents ? "Continue to card payment" : "Create account & enrol"}</button></form>`;
  return `<section class="wrap section narrow-grid"><div><p class="eyebrow"><a href="/courses/${esc(c.slug)}">← Course details</a></p><h1>Enrol</h1>${warn}${form}</div>${summary}</section>`;
}

export function completePage(c: CohortV, sessionId: string | null) {
  return `<section class="wrap section narrow"><div class="card form" id="complete" data-slug="${esc(c.slug)}" data-session="${esc(sessionId ?? "")}"><p class="eyebrow">Enrolment</p><h1>Confirming your payment…</h1><p class="muted">One moment while we check with Stripe.</p></div></section>`;
}

export function loginPage() {
  return `<section class="wrap section narrow"><div class="card form"><img class="signin-mark" src="/assets/brand/passage-app.png" width="64" height="64" alt=""><p class="eyebrow">Welcome back</p><h1>Sign in</h1>
<form id="login-form" class="form-inner"><label>Username or email<input name="identifier" required autocomplete="username"></label><label>Password<input name="password" type="password" required autocomplete="current-password"></label><div class="form-error" role="alert" hidden></div><button class="btn btn-primary btn-block" type="submit">Sign in</button></form>
<div class="divider"><span>or</span></div><button class="btn btn-outline btn-block" type="button" data-nostr-login>Sign in with Nostr extension</button><div class="form-error" id="nostr-error" role="alert" hidden></div>
<p class="muted small">New here? <a href="/courses">Browse courses</a> and enrol to create your account.</p></div></section>`;
}

export function accountPage(user: PageCtx["user"]) {
  if (!user) return `<section class="wrap section narrow"><div class="card form"><h1>Your account</h1><p>Sign in to see your courses, your npub and your Chief of Staff agent.</p><a class="btn btn-primary" href="/login">Sign in</a></div></section>`;
  return `<section class="wrap section"><p class="eyebrow">Your account</p><h1>Hello${user.displayName ? ", " + esc(user.displayName) : ""}</h1>
<div class="two">
<div class="card form"><h2>Profile & agent</h2><form id="profile-form" class="form-inner"><label>Display name<input name="displayName" maxlength="80" value="${esc(user.displayName)}"></label><label>Chief of Staff agent name<input name="agentName" required maxlength="60" value="${esc(user.agentName)}" placeholder="e.g. Atlas"></label><div class="form-error" role="alert" hidden></div><div class="form-ok" role="status" hidden></div><button class="btn btn-primary" type="submit">Save</button></form></div>
<div class="card form"><h2>Your Nostr identity</h2><p class="muted small">Public key</p><div class="mono copyrow"><code id="npub">${esc(user.npub)}</code><button class="btn btn-outline btn-sm" type="button" data-copy="${esc(user.npub)}">Copy</button></div>
<div id="backup-box" hidden><p class="muted small">Your private key is backed up here, encrypted with your password. Unlock it to view or copy it.</p><form id="unlock-form" class="form-inner"><label>Password<input name="password" type="password" autocomplete="current-password" required></label><div class="form-error" role="alert" hidden></div><button class="btn btn-outline" type="submit">Unlock private key</button></form><div id="nsec-out" hidden><p class="muted small">Private key (nsec) — keep it secret</p><div class="mono copyrow"><code id="nsec"></code><button class="btn btn-outline btn-sm" id="copy-nsec" type="button">Copy</button></div></div></div></div></div>
<div class="card" style="margin-top:24px"><h2>Your courses</h2><div id="my-courses" class="muted">Loading…</div></div></section>`;
}

export function adminPage(user: PageCtx["user"]) {
  if (!user?.isAdmin) return `<section class="wrap section narrow"><div class="card form"><p class="eyebrow">Admin</p><h1>Admin sign in</h1><p>Sign in with your Nostr key to continue.${user ? " You are signed in, but not as an admin npub." : ""}</p><button class="btn btn-primary" type="button" data-nostr-login>Sign in with Nostr extension</button><div class="form-error" id="nostr-error" role="alert" hidden></div></div></section>`;
  return `<section class="wrap section"><div class="admin-head"><div><p class="eyebrow">Admin</p><h1>Training admin</h1></div><div class="tabs" role="tablist"><button class="tab" data-tab="cohorts" role="tab">Cohorts</button><button class="tab" data-tab="stripe" role="tab">Stripe settings</button></div></div><div id="admin-root" aria-live="polite">Loading…</div></section>`;
}

export function notFoundPage() {
  return `<section class="wrap section narrow"><div class="card form"><h1>Not found</h1><p class="muted">We couldn't find that page.</p><a class="btn btn-primary" href="/courses">See courses</a></div></section>`;
}
