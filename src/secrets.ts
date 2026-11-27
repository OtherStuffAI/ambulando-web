import { toBase64, fromBase64 } from "./shared/backup.ts";

/**
 * AES-256-GCM envelope for server-side secrets (Stripe keys) stored in NStack.
 * The key comes from APP_SECRET_KEY (SHA-256 of the passphrase). It is never written to disk:
 * the container filesystem is ephemeral, and a key file would be lost with it.
 */
export class SecretBox {
  private constructor(private key: CryptoKey) {}

  static async create(opts: { secretKey?: string }): Promise<SecretBox> {
    if (!opts.secretKey) throw new Error("APP_SECRET_KEY is required: it seals Stripe secrets stored in NStack");
    const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opts.secretKey)));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return new SecretBox(key);
  }

  async seal(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, new TextEncoder().encode(plain)));
    return `${toBase64(iv)}.${toBase64(ct)}`;
  }

  async open(sealed: string): Promise<string> {
    const [iv, ct] = sealed.split(".");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, this.key, fromBase64(ct));
    return new TextDecoder().decode(pt);
  }
}
