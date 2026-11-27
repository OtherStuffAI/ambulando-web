import { decodePointer } from "applesauce-core/helpers";

export const PETE_NPUB = "npub1jss47s4fvv6usl7tn6yp5zamv2u60923ncgfea0e6thkza5p7c3q0afmzy";

export interface Config {
  databasePath: string;
  adminNpubs: string[];
  /** hex pubkeys derived from adminNpubs */
  adminPubkeys: Set<string>;
  publicDir: string;
  /** Optional passphrase for encrypting secrets at rest; otherwise a key file next to the DB is used. */
  secretKey?: string;
  baseUrl?: string;
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
  return {
    databasePath: overrides.databasePath ?? process.env.DATABASE_PATH ?? "./data/ambulando.sqlite",
    adminNpubs,
    adminPubkeys,
    publicDir: overrides.publicDir ?? new URL("../public", import.meta.url).pathname,
    secretKey: overrides.secretKey ?? process.env.APP_SECRET_KEY,
    baseUrl: overrides.baseUrl ?? process.env.BASE_URL,
  };
}
