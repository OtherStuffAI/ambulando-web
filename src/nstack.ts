import { createHash } from "node:crypto";
import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";

/**
 * Client for NStack's generic app-signed relational namespace
 * (`/api/v4/workspaces/:owner/apps/:app/db/...`). NStack owns isolation and authority;
 * this app owns its schema and business rules. Every request is NIP-98 signed by the
 * registered app identity, which only the server process holds. Browsers never see it.
 */

export class NstackError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

export type Scalar = string | number | boolean | null;
export type Row = Record<string, any>;
export type WhereOp = { eq: Scalar } | { neq: Scalar } | { lt: Scalar } | { lte: Scalar } | { gt: Scalar } | { gte: Scalar } | { in: Scalar[] } | { is_null: boolean };
export type Where = Record<string, WhereOp>;

export interface NstackConfig {
  baseUrl: string;
  ownerNpub: string;
  /** Optional: when given it must match the signing key. */
  appNpub?: string;
  /** App signing key as nsec1… or 64-hex. Held in memory only. */
  appSecret: string;
  appSlug?: string;
  fetch?: typeof fetch;
}

export function decodeSecret(value: string): Uint8Array {
  const raw = value.trim();
  if (raw.startsWith("nsec1")) {
    const d = nip19.decode(raw);
    if (d.type !== "nsec") throw new Error("NSTACK_APP_NSEC is not a valid nsec");
    return d.data;
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Uint8Array.from(Buffer.from(raw, "hex"));
  throw new Error("NSTACK_APP_NSEC must be nsec1… or 64 hex characters");
}

export const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export class NstackDb {
  readonly appNpub: string;
  private key: Uint8Array;
  private base: string;
  private doFetch: typeof fetch;
  private root: string;

  constructor(private cfg: NstackConfig) {
    this.key = decodeSecret(cfg.appSecret);
    this.appNpub = nip19.npubEncode(getPublicKey(this.key));
    if (cfg.appNpub && this.appNpub !== cfg.appNpub) throw new Error("NSTACK_APP_NPUB does not match the app signing key");
    this.base = cfg.baseUrl.replace(/\/+$/, "");
    this.doFetch = cfg.fetch ?? fetch;
    this.root = `/api/v4/workspaces/${encodeURIComponent(cfg.ownerNpub)}/apps/${encodeURIComponent(this.appNpub)}/db`;
  }

  private authorization(url: string, method: string, rawBody?: string): string {
    const tags = [["u", url], ["method", method]];
    if (rawBody !== undefined) tags.push(["payload", sha256Hex(rawBody)]);
    const ev = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: "" }, this.key);
    return `Nostr ${Buffer.from(JSON.stringify(ev), "utf8").toString("base64")}`;
  }

  async call<T = any>(method: string, suffix: string, body?: unknown): Promise<T> {
    const url = `${this.base}${this.root}${suffix}`;
    const raw = body === undefined ? undefined : JSON.stringify(body);
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers: { authorization: this.authorization(url, method, raw), ...(raw !== undefined ? { "content-type": "application/json" } : {}) },
        body: raw,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e: any) {
      throw new NstackError(503, `NStack unreachable: ${e?.message ?? e}`, "nstack_unreachable");
    }
    const text = await res.text();
    let payload: any = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) throw new NstackError(res.status, payload?.error ?? (text.slice(0, 200) || res.statusText), payload?.code);
    return payload as T;
  }

  descriptor() { return this.call("GET", "/descriptor"); }
  provision() { return this.call("POST", "/provision", { app_slug: this.cfg.appSlug ?? "ambulando_web" }); }
  migrations() { return this.call<{ migrations: { version: string; checksum: string }[] }>("GET", "/migrations"); }
  migrate(migrations: { version: string; checksum: string; sql: string }[]) { return this.call("POST", "/migrations", { migrations }); }

  async query(table: string, q: { where?: Where; order?: { field: string; dir?: "asc" | "desc" }[]; limit?: number; offset?: number; select?: string[] } = {}): Promise<Row[]> {
    const r = await this.call<{ rows: Row[] }>("POST", `/tables/${table}/query`, { limit: 500, ...q });
    return r.rows;
  }

  /** Reads every page. Callers must supply a stable order. */
  async queryAll(table: string, q: { where?: Where; order: { field: string; dir?: "asc" | "desc" }[]; select?: string[] }): Promise<Row[]> {
    const out: Row[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.query(table, { ...q, limit: 500, offset });
      out.push(...page);
      if (page.length < 500) return out;
    }
  }

  async get(table: string, id: string): Promise<Row | null> {
    const rows = await this.query(table, { where: { id: { eq: id } }, limit: 1 });
    return rows[0] ?? null;
  }

  /** Inserts a row. Returns null when the id (or any unique index) already exists. */
  async insert(table: string, id: string, data: Row): Promise<Row | null> {
    try {
      const r = await this.call<{ row: Row }>("POST", `/tables/${table}/rows`, { id, data });
      return r.row;
    } catch (e) {
      if (e instanceof NstackError && e.code === "row_conflict") return null;
      throw e;
    }
  }

  /**
   * Atomic update. With `where`, the update only applies when the predicate still holds
   * (compare-and-set); returns null when it did not match or the row is missing.
   */
  async update(table: string, id: string, set: Row, where?: Where): Promise<Row | null> {
    try {
      const r = await this.call<{ row: Row | null }>("PATCH", `/tables/${table}/rows/${encodeURIComponent(id)}`, where ? { set, where } : { set });
      return r.row;
    } catch (e) {
      if (e instanceof NstackError && (e.code === "row_conflict" || e.code === "row_not_found")) return null;
      throw e;
    }
  }

  /** Deletes a row; true when it existed. */
  async delete(table: string, id: string): Promise<boolean> {
    try {
      await this.call("DELETE", `/tables/${table}/rows/${encodeURIComponent(id)}`);
      return true;
    } catch (e) {
      if (e instanceof NstackError && e.code === "row_not_found") return false;
      throw e;
    }
  }
}
