// Nostr profile (kind 0) sync and Chief of Staff agent identity helpers.
// Pure/isomorphic: relays and signers are injected so tests never touch the network.
import * as nip44 from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey, type Event, type EventTemplate } from "nostr-tools/pure";
import { nsecEncode, npubEncode, decode } from "nostr-tools/nip19";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://purplepag.es"];
export const SELF_SCHEME = "nip44_self";

export function parseRelays(v: string | null | undefined): string[] {
  const list = (v ?? "").split(",").map((s) => s.trim()).filter((s) => /^wss?:\/\//.test(s));
  return list.length ? list : DEFAULT_RELAYS;
}

export interface RelayIO {
  query(relays: string[], filter: { kinds: number[]; authors: string[]; limit?: number }): Promise<Event[]>;
  /** Resolves with the number of relays that accepted the event. */
  publish(relays: string[], event: Event): Promise<number>;
}

/** Signer abstraction over NIP-07 extensions and locally unlocked keys. */
export interface UserSigner {
  getPublicKey(): Promise<string>;
  signEvent(t: EventTemplate): Promise<Event>;
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>;
}

export type ProfileMeta = Record<string, unknown>;

export interface RelayProfile { event: Event | null; meta: ProfileMeta }

function parseMeta(content: string): ProfileMeta {
  try {
    const v = JSON.parse(content);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** Latest kind 0 for a pubkey across relays (newest created_at wins; events must belong to the author). */
export async function fetchProfile(io: RelayIO, pubkey: string, relays = DEFAULT_RELAYS): Promise<RelayProfile> {
  let events: Event[] = [];
  try { events = await io.query(relays, { kinds: [0], authors: [pubkey], limit: 10 }); } catch { /* offline relays: treat as no profile */ }
  const mine = events.filter((e) => e.kind === 0 && e.pubkey === pubkey).sort((a, b) => b.created_at - a.created_at);
  const event = mine[0] ?? null;
  return { event, meta: event ? parseMeta(event.content) : {} };
}

export const profileDisplayName = (m: ProfileMeta) => {
  const v = m.display_name || m.displayName || m.name;
  return typeof v === "string" ? v.trim() : "";
};
export const profilePicture = (m: ProfileMeta) => (typeof m.picture === "string" ? m.picture.trim() : "");

/** Merge edits into an existing kind 0 object, preserving every field we do not manage (about, nip05, lud16, banner...). */
export function mergeProfile(existing: ProfileMeta, edits: { displayName?: string; picture?: string; about?: string }): ProfileMeta {
  const out: ProfileMeta = { ...existing };
  if (edits.displayName !== undefined) {
    out.display_name = edits.displayName;
    if (!out.name || typeof out.name !== "string") out.name = edits.displayName;
  }
  if (edits.picture !== undefined) { if (edits.picture) out.picture = edits.picture; else delete out.picture; }
  if (edits.about !== undefined && edits.about) out.about = edits.about;
  return out;
}

/** Fetch the current profile, merge edits and publish a freshly signed kind 0. */
export async function publishProfileUpdate(
  io: RelayIO, signer: Pick<UserSigner, "getPublicKey" | "signEvent">,
  edits: { displayName?: string; picture?: string; about?: string }, relays = DEFAULT_RELAYS, now = () => Math.floor(Date.now() / 1000),
): Promise<{ event: Event; accepted: number; meta: ProfileMeta }> {
  const pubkey = await signer.getPublicKey();
  const { meta: existing } = await fetchProfile(io, pubkey, relays);
  const meta = mergeProfile(existing, edits);
  const event = await signer.signEvent({ kind: 0, created_at: now(), tags: [], content: JSON.stringify(meta) });
  const accepted = await io.publish(relays, event);
  return { event, accepted, meta };
}

// ---------- signers ----------

/** Signer for a locally unlocked secret key; NIP-44 v2 via nostr-tools. */
export function localSigner(sk: Uint8Array): UserSigner {
  const pk = getPublicKey(sk);
  const key = (other: string) => nip44.v2.utils.getConversationKey(sk, other);
  return {
    getPublicKey: async () => pk,
    signEvent: async (t) => finalizeEvent(t, sk),
    nip44Encrypt: async (other, text) => nip44.v2.encrypt(text, key(other)),
    nip44Decrypt: async (other, ct) => nip44.v2.decrypt(ct, key(other)),
  };
}

/** Signer backed by a NIP-07 extension (`window.nostr`). */
export function extensionSigner(nostr: any): UserSigner {
  return {
    getPublicKey: () => nostr.getPublicKey(),
    signEvent: (t) => nostr.signEvent(t),
    nip44Encrypt: async (other, text) => {
      if (!nostr.nip44?.encrypt) throw new Error("Your Nostr extension does not support NIP-44 encryption. Update it, or sign in with your password and unlock your key instead.");
      return nostr.nip44.encrypt(other, text);
    },
    nip44Decrypt: async (other, ct) => {
      if (!nostr.nip44?.decrypt) throw new Error("Your Nostr extension does not support NIP-44 decryption.");
      return nostr.nip44.decrypt(other, ct);
    },
  };
}

// ---------- Chief of Staff agent identity ----------

export interface AgentIdentity { npub: string; pubkey: string; nsec: string; sk: Uint8Array }

export function generateAgentIdentity(): AgentIdentity {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  return { sk, pubkey, npub: npubEncode(pubkey), nsec: nsecEncode(sk) };
}

/** NIP-44 self-encrypt the agent nsec so only the user's own key can read it. */
export async function encryptAgentNsec(user: UserSigner, agentNsec: string): Promise<{ encrypted_agent_nsec: string; agent_encryption_scheme: string }> {
  const me = await user.getPublicKey();
  return { encrypted_agent_nsec: await user.nip44Encrypt(me, agentNsec), agent_encryption_scheme: SELF_SCHEME };
}

export async function decryptAgentNsec(user: UserSigner, ciphertext: string): Promise<string> {
  const nsec = await user.nip44Decrypt(await user.getPublicKey(), ciphertext);
  const d = decode(nsec);
  if (d.type !== "nsec") throw new Error("Decrypted value is not an nsec");
  return nsec;
}

/** Sign and publish the agent's own kind 0 with its freshly generated key. */
export async function publishAgentProfile(
  io: RelayIO, agent: AgentIdentity, p: { name: string; picture?: string; about?: string }, relays = DEFAULT_RELAYS,
  now = () => Math.floor(Date.now() / 1000),
): Promise<{ event: Event; accepted: number }> {
  const meta: ProfileMeta = { name: p.name, display_name: p.name };
  if (p.picture) meta.picture = p.picture;
  if (p.about) meta.about = p.about;
  const event = finalizeEvent({ kind: 0, created_at: now(), tags: [], content: JSON.stringify(meta) }, agent.sk);
  return { event, accepted: await io.publish(relays, event) };
}

// ---------- real relay IO (browser) ----------

export async function poolRelayIO(): Promise<RelayIO> {
  const { SimplePool } = await import("nostr-tools/pool");
  const pool = new SimplePool();
  return {
    query: (relays, filter) => pool.querySync(relays, filter, { maxWait: 4000 }),
    publish: async (relays, event) => {
      const results = await Promise.allSettled(pool.publish(relays, event, { maxWait: 5000 }));
      return results.filter((r) => r.status === "fulfilled").length;
    },
  };
}
