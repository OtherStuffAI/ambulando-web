import { generateSecretKey, getPublicKey } from "applesauce-core/helpers/keys";
import { npubEncode, nsecEncode } from "applesauce-core/helpers/pointers";
import { PrivateKeySigner } from "applesauce-signers";
import { createApp, AUTH_KIND } from "../src/app.ts";
import { NstackDb } from "../src/nstack.ts";
import { FakeNstack } from "./fake-nstack.ts";
import { encryptNsec } from "../src/shared/backup.ts";
import type { CheckoutParams, CheckoutSession, StripeClient } from "../src/stripe.ts";

export class MockStripe {
  sessions = new Map<string, CheckoutSession & { params: CheckoutParams }>();
  keyOk = true;
  created = 0;
  factoryKeys: string[] = [];
  factory = (key: string): StripeClient => {
    this.factoryKeys.push(key);
    return {
      createCheckoutSession: async (p) => {
        const id = `cs_test_${++this.created}`;
        const s = { id, url: `https://checkout.stripe.test/${id}`, status: "open", payment_status: "unpaid", client_reference_id: String(p.enrolmentId), amount_total: p.amountCents, payment_intent: null, params: p };
        this.sessions.set(id, s);
        return s;
      },
      retrieveCheckoutSession: async (id) => {
        const s = this.sessions.get(id);
        if (!s) throw new Error("No such session");
        return s;
      },
      checkKey: async () => (this.keyOk ? { ok: true } : { ok: false, error: "Invalid API Key provided" }),
    };
  };
  pay(id: string) {
    const s = this.sessions.get(id)!;
    s.status = "complete"; s.payment_status = "paid"; s.payment_intent = `pi_${id}`;
  }
  expire(id: string) { this.sessions.get(id)!.status = "expired"; }
}

export class Client {
  cookie = "";
  constructor(public app: Awaited<ReturnType<typeof createApp>>) {}
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const headers: Record<string, string> = body !== undefined ? { "content-type": "application/json", ...extra } : { ...extra };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.fetch(new Request("http://localhost:3000" + path, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }));
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
    return res;
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown = {}) => this.req("POST", p, b);
  put = (p: string, b: unknown) => this.req("PUT", p, b);
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);

  async nostrLogin(sk: Uint8Array) {
    const { challenge } = await (await this.get("/api/auth/challenge")).json() as any;
    const event = await new PrivateKeySigner(sk).signEvent({ kind: AUTH_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["challenge", challenge]], content: "Sign in to Ambulando" });
    return { res: await this.post("/api/auth/nostr", { event }), event, challenge };
  }
}

export function newNstack(owner = npubEncode(getPublicKey(generateSecretKey()))) {
  const appSk = generateSecretKey();
  const fake = new FakeNstack(owner, appSk);
  const nstack = new NstackDb({ baseUrl: "https://nstack.test", ownerNpub: owner, appSecret: nsecEncode(appSk), fetch: fake.fetch as typeof fetch });
  return { fake, nstack, owner, appSk };
}

export async function setup(opts: { stripeFactory?: (k: string) => StripeClient; shared?: ReturnType<typeof newNstack> } = {}) {
  const adminSk = generateSecretKey();
  const adminNpub = npubEncode(getPublicKey(adminSk));
  const stripe = new MockStripe();
  const ns = opts.shared ?? newNstack();
  const app = await createApp({ nstack: ns.nstack, config: { adminNpubs: [adminNpub], secretKey: "test-secret" }, stripeFactory: opts.stripeFactory ?? stripe.factory });
  const admin = new Client(app);
  await admin.nostrLogin(adminSk);
  return { app, stripe, admin, adminSk, adminNpub, fake: ns.fake, nstack: ns, anon: () => new Client(app) };
}

export async function signupBody(overrides: Record<string, unknown> = {}, password = "correct horse") {
  const sk = generateSecretKey();
  const npub = npubEncode(getPublicKey(sk));
  const nsec = nsecEncode(sk);
  const backup = await encryptNsec(npub, nsec, password, 100_000);
  return { body: { displayName: "Sam Walker", identifier: "sam@example.com", password, passwordConfirm: password, agentName: "Atlas", backup, ...overrides }, npub, nsec };
}

export const stripeKeys = { publishableKey: "pk_test_abcdefgh12345678", secretKey: "sk_test_SECRETSECRET9876", webhookSecret: "whsec_abcdefgh12345678" };
