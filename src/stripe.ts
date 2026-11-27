import { createHmac, timingSafeEqual } from "node:crypto";

export interface CheckoutParams {
  enrolmentId: number;
  cohortTitle: string;
  amountCents: number;
  currency: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface CheckoutSession {
  id: string;
  url?: string | null;
  status?: string | null; // open | complete | expired
  payment_status?: string | null; // paid | unpaid | no_payment_required
  payment_intent?: string | null;
  client_reference_id?: string | null;
  amount_total?: number | null;
}

export interface StripeClient {
  createCheckoutSession(p: CheckoutParams): Promise<CheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSession>;
  /** Cheap authenticated call used to validate the secret key. */
  checkKey(): Promise<{ ok: boolean; error?: string }>;
}

export type StripeFactory = (secretKey: string) => StripeClient;

function form(obj: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) p.set(k, String(v));
  return p.toString();
}

export const realStripe: StripeFactory = (secretKey) => {
  const call = async (method: string, path: string, body?: string, idem?: string) => {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idem ? { "Idempotency-Key": idem } : {}),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? `Stripe error ${res.status}`);
    return json;
  };
  return {
    createCheckoutSession: (p) =>
      call(
        "POST",
        "/checkout/sessions",
        form({
          mode: "payment",
          "payment_method_types[0]": "card",
          "line_items[0][quantity]": 1,
          "line_items[0][price_data][currency]": p.currency,
          "line_items[0][price_data][unit_amount]": p.amountCents,
          "line_items[0][price_data][product_data][name]": p.cohortTitle,
          client_reference_id: String(p.enrolmentId),
          customer_email: p.customerEmail,
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
          expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
          "metadata[enrolment_id]": String(p.enrolmentId),
        }),
        p.idempotencyKey,
      ),
    retrieveCheckoutSession: (id) => call("GET", `/checkout/sessions/${encodeURIComponent(id)}`),
    checkKey: async () => {
      try {
        await call("GET", "/balance");
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? "request failed" };
      }
    },
  };
};

/** Verify a Stripe-Signature header (t=...,v1=...) over the raw body. */
export function verifyStripeSignature(payload: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const candidates = header.split(",").filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  return candidates.some((c) => c.length === expected.length && timingSafeEqual(Buffer.from(c), Buffer.from(expected)));
}

export function signStripePayload(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
}
