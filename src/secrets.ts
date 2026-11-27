import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toBase64, fromBase64 } from "./shared/backup.ts";

/** AES-256-GCM envelope for server-side secrets (Stripe keys) stored in SQLite. */
export class SecretBox {
  private constructor(private key: CryptoKey) {}

  static async create(opts: { secretKey?: string; databasePath: string }): Promise<SecretBox> {
    let raw: Uint8Array<ArrayBuffer>;
    if (opts.secretKey) {
      raw = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opts.secretKey)));
    } else if (opts.databasePath === ":memory:") {
      raw = crypto.getRandomValues(new Uint8Array(32));
    } else {
      const file = join(dirname(opts.databasePath), "secret.key");
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file)) raw = fromBase64(readFileSync(file, "utf8").trim());
      else {
        raw = crypto.getRandomValues(new Uint8Array(32));
        writeFileSync(file, toBase64(raw), { mode: 0o600 });
      }
    }
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
