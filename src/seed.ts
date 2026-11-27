import type { CohortFields } from "./store.ts";

/** First cohort, inserted once into an empty namespace. */
export const SEED_COHORT: CohortFields = {
  slug: "chief-of-staff-foundations",
  title: "Chief of Staff Foundations",
  tagline: "Learn to direct an agent team that works while you walk.",
  description: "A four-week live cohort for people who want to put AI agents to work without losing their head. You will set up your own Ambulando workspace, name and shape your Chief of Staff agent, and leave with workflows you actually use.\n\nEvery participant receives a fresh Nostr identity, backed up behind their password, so your agents and your data stay yours.",
  highlights: JSON.stringify(["Your own Ambulando workspace and Nostr identity", "A named Chief of Staff agent, configured for your work", "Live weekly sessions with recordings", "A small cohort with direct feedback"]),
  modules: JSON.stringify([
    { title: "Week 1 · Direction", summary: "Think out loud, define what matters and brief your first agent." },
    { title: "Week 2 · Delegation", summary: "Tasks, approvals and the review loop that keeps you in control." },
    { title: "Week 3 · Memory", summary: "Documents, channels and the knowledge your team keeps." },
    { title: "Week 4 · Rhythm", summary: "Weekly cadence, exceptions and staying sane as the work scales." },
  ]),
  start_date: "2027-02-02", end_date: "2027-02-23", schedule: "4 weeks · Live Tuesdays", location: "Online + Ambulando Cohort Workspace",
  price_cents: 49500, currency: "aud", capacity: 20, status: "published",
};
