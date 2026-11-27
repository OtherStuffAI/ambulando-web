// Password-protected nsec backup using WebCrypto (PBKDF2-SHA256 -> AES-256-GCM).
// Runs in the browser (and in Bun for tests). The server only ever stores the opaque bundle.

export interface BackupBundle {
  npub: string;
  encrypted_nsec: string; // base64 ciphertext
  kdf_salt: string; // base64
  kdf_params: { name: "PBKDF2"; hash: "SHA-256"; iterations: number };
  cipher_iv: string; // base64
}

export const DEFAULT_ITERATIONS = 310_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptNsec(
  npub: string,
  nsec: string,
  password: string,
  iterations = DEFAULT_ITERATIONS,
): Promise<BackupBundle> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, iterations);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(nsec)));
  return {
    npub,
    encrypted_nsec: toBase64(ct),
    kdf_salt: toBase64(salt),
    kdf_params: { name: "PBKDF2", hash: "SHA-256", iterations },
    cipher_iv: toBase64(iv),
  };
}

/** Throws if the password is wrong (AES-GCM authentication failure). */
export async function decryptNsec(bundle: BackupBundle, password: string): Promise<string> {
  const key = await deriveKey(password, fromBase64(bundle.kdf_salt), bundle.kdf_params.iterations);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(bundle.cipher_iv) }, key, fromBase64(bundle.encrypted_nsec));
  return dec.decode(pt);
}
