import { decodePointer } from "applesauce-core/helpers";
import { parseRelays } from "./shared/nostr-profile.ts";

export const PETE_NPUB = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";

export interface NstackSettings {
  baseUrl: string;
  ownerNpub: string;
  appNpub?: string;
  /** Held in memory only; never logged or sent to browsers. */
  appSecret: string;
  appSlug?: string;
  fetch?: typeof fetch;
  /** Set false to skip provision+migrate at startup (tests that pre-install the schema). */
  ensureSchema?: boolean;
}

export interface Config {
  /** NStack namespace this site stores everything in. */
  nstack?: NstackSettings;
  adminNpubs: string[];
  /** hex pubkeys derived from adminNpubs */
  adminPubkeys: Set<string>;
  publicDir: string;
  /** Passphrase that seals Stripe secrets at rest in NStack. Required: losing it makes saved Stripe keys unreadable. */
  secretKey?: string;
  baseUrl?: string;
  /** Relays the browser uses to read/publish Nostr kind 0 profiles. */
  nostrRelays: string[];
}

export function npubToHex(npub: string): string | null {
  try {
    const d = decodePointer(npub.trim());
    return d.type === "npub" ? (d.data as string) : null;
  } catch {
    return null;
  }
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const adminNpubs = overrides.adminNpubs
    ?? (process.env.ADMIN_NPUBS ?? PETE_NPUB).split(",").map((s) => s.trim()).filter(Boolean);
  const adminPubkeys = new Set(adminNpubs.map(npubToHex).filter((x): x is string => !!x));
  const env = process.env;
  const nstack = overrides.nstack ?? (env.NSTACK_APP_NSEC ? {
    baseUrl: env.NSTACK_URL ?? "https://nstack.otherstuff.ai",
    ownerNpub: env.NSTACK_OWNER_NPUB ?? PETE_NPUB,
    appNpub: env.NSTACK_APP_NPUB || undefined,
    appSecret: env.NSTACK_APP_NSEC,
    appSlug: env.NSTACK_APP_SLUG ?? "ambulando_web",
  } : undefined);
  return {
    nstack,
    adminNpubs,
    adminPubkeys,
    publicDir: overrides.publicDir ?? new URL("../public", import.meta.url).pathname,
    secretKey: overrides.secretKey ?? env.APP_SECRET_KEY,
    baseUrl: overrides.baseUrl ?? env.BASE_URL,
    nostrRelays: overrides.nostrRelays ?? parseRelays(env.NOSTR_RELAYS),
  };
}
