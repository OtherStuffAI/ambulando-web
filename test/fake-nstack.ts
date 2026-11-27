import { createHash } from "node:crypto";
import { verifyEvent } from "nostr-tools";
import { nip19, getPublicKey } from "nostr-tools";

/**
 * In-process stand-in for NStack's deployed generic app-signed relational API
 * (tower src/services/app-db.ts). It mirrors the contract the website depends on:
 * NIP-98 verification against the registered app npub, checksummed append-only migrations,
 * unique-index violations => 409 row_conflict, conditional update via `where` => 409,
 * missing row => 404 row_not_found, bigint columns returned as strings, 500-row query cap.
 * It is deliberately strict (unknown tables/columns, NOT NULL without default) so schema drift in
 * the app fails tests. The real service is exercised by test/nstack-real.test.ts when available.
 */
type Col = { name: string; type: string; notNull: boolean; hasDefault: boolean; def?: string };
type Table = { cols: Col[]; unique: string[][]; rows: Map<string, Record<string, any>> };

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const j = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function parseSql(sql: string, tables: Map<string, Table>) {
  for (const stmt of sql.split(";").map((x) => x.trim()).filter(Boolean)) {
    let m = stmt.match(/^CREATE TABLE (\w+) \(([\s\S]*)\)$/i);
    if (m) {
      const cols: Col[] = [];
      for (const line of m[2].split(/,\s*\n/).map((x) => x.trim()).filter(Boolean)) {
        const c = line.match(/^(\w+)\s+(\w+)(.*)$/);
        if (!c) throw new Error(`fake: cannot parse column ${line}`);
        const rest = c[3];
        const def = rest.match(/DEFAULT\s+('(?:[^']|'')*'|\d+)/i)?.[1];
        cols.push({ name: c[1], type: c[2].toLowerCase(), notNull: /NOT NULL/i.test(rest) || /PRIMARY KEY/i.test(rest), hasDefault: !!def, def });
      }
      const t: Table = { cols: [...cols], unique: [["id"]], rows: new Map() };
      tables.set(m[1], t);
      continue;
    }
    m = stmt.match(/^CREATE UNIQUE INDEX \w+ ON (\w+) \(([^)]+)\)$/i);
    if (m) { tables.get(m[1])!.unique.push(m[2].split(",").map((x) => x.trim())); continue; }
    if (/^CREATE INDEX/i.test(stmt)) continue;
    throw new Error(`fake: unsupported migration statement ${stmt.slice(0, 40)}`);
  }
}

const cmp = (type: string, a: any, b: any) => (type === "bigint" ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0);

export class FakeNstack {
  tables = new Map<string, Table>();
  migrations: { version: string; checksum: string }[] = [];
  provisioned = false;
  registered = true;
  calls: { method: string; path: string }[] = [];
  failNext: number | null = null;
  /** Invoked before each row mutation: lets a test interleave a competing request deterministically. */
  beforeMutation?: (what: string) => Promise<void> | void;
  readonly appNpub: string;
  constructor(public ownerNpub: string, appSecret: Uint8Array) { this.appNpub = nip19.npubEncode(getPublicKey(appSecret)); }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const prefix = `/api/v4/workspaces/${encodeURIComponent(this.ownerNpub)}/apps/${encodeURIComponent(this.appNpub)}/db`;
    // Namespace isolation: any other owner/app path is not ours.
    if (!url.pathname.startsWith(prefix + "/") && url.pathname !== prefix) {
      return j({ error: "workspace app not found", code: "app_not_found" }, 404);
    }
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const denied = this.verify(auth, url.toString(), method, raw);
    if (denied) return denied;
    if (!this.registered) return j({ error: "workspace app not found", code: "app_not_found" }, 404);
    if (this.failNext) { const s = this.failNext; this.failNext = null; return j({ error: "boom" }, s); }
    const suffix = url.pathname.slice(prefix.length);
    this.calls.push({ method, path: suffix });
    const body = raw ? JSON.parse(raw) : {};
    if (method === "GET" && suffix === "/descriptor") return this.provisioned ? j({ schema_name: "wapp_fake" }) : j({ error: "app database namespace not provisioned", code: "namespace_not_provisioned" }, 404);
    if (method === "POST" && suffix === "/provision") { this.provisioned = true; return j({ schema_name: "wapp_fake" }, 201); }
    if (method === "GET" && suffix === "/migrations") return j({ migrations: this.migrations });
    if (method === "POST" && suffix === "/migrations") return this.migrate(body);
    const t = suffix.match(/^\/tables\/(\w+)\/(query|rows)(?:\/([^/]+))?$/);
    if (!t) return j({ error: "not found" }, 404);
    if (!this.provisioned) return j({ error: "app database namespace not provisioned", code: "namespace_not_provisioned" }, 404);
    const table = this.tables.get(t[1]);
    if (!table) return j({ error: "table not found", code: "table_not_found" }, 404);
    if (t[2] === "query" && method === "POST") return j({ rows: this.select(table, body) });
    if (t[2] === "rows" && method === "POST" && !t[3]) { await this.beforeMutation?.(`insert:${t[1]}`); return this.insert(table, body); }
    const id = decodeURIComponent(t[3] ?? "");
    if (t[2] === "rows" && method === "PATCH") { await this.beforeMutation?.(`update:${t[1]}`); return this.update(table, id, body); }
    if (t[2] === "rows" && method === "DELETE") { await this.beforeMutation?.(`delete:${t[1]}`); return this.del(table, id); }
    return j({ error: "not found" }, 404);
  };

  private verify(header: string | undefined, url: string, method: string, raw: string | undefined): Response | null {
    if (!header?.startsWith("Nostr ")) return j({ error: "nip98 auth required" }, 401);
    try {
      const ev = JSON.parse(Buffer.from(header.slice(6), "base64").toString("utf8"));
      const tag = (n: string) => ev.tags.find((x: string[]) => x[0] === n)?.[1];
      if (ev.kind !== 27235 || !verifyEvent(ev)) return j({ error: "bad signature" }, 401);
      if (Math.abs(Date.now() / 1000 - ev.created_at) > 60) return j({ error: "stale" }, 401);
      if (tag("u") !== url || tag("method") !== method) return j({ error: "url/method mismatch" }, 401);
      if (raw !== undefined && tag("payload") !== sha(raw)) return j({ error: "payload mismatch" }, 401);
      if (nip19.npubEncode(ev.pubkey) !== this.appNpub) return j({ error: "request must be signed by the registered app npub", code: "app_signer_required" }, 403);
      return null;
    } catch { return j({ error: "invalid auth" }, 401); }
  }

  private migrate(body: any): Response {
    for (const m of body.migrations) {
      if (`sha256:${sha(m.sql)}` !== m.checksum) return j({ error: "migration checksum does not match sql", code: "migration_checksum_invalid" }, 400);
      const existing = this.migrations.find((x) => x.version === m.version);
      if (existing) { if (existing.checksum !== m.checksum) return j({ error: "conflict", code: "migration_checksum_conflict" }, 409); continue; }
      parseSql(m.sql, this.tables);
      this.migrations.push({ version: m.version, checksum: m.checksum });
    }
    return j({ applied: this.migrations });
  }

  private norm(table: Table, row: Record<string, any>) {
    const out: Record<string, any> = {};
    for (const c of table.cols) {
      const v = row[c.name];
      out[c.name] = v === undefined || v === null ? null : c.type === "bigint" ? String(v) : v;
    }
    return out;
  }

  private matches(table: Table, row: Record<string, any>, where: Record<string, any> | undefined) {
    for (const [f, cond] of Object.entries(where ?? {})) {
      const col = table.cols.find((c) => c.name === f);
      if (!col) throw new Error(`fake: unknown column ${f}`);
      const [op, val] = Object.entries(cond as Record<string, any>)[0];
      const v = row[f];
      if (op === "is_null") { if ((v === null || v === undefined) !== !!val) return false; continue; }
      if (v === null || v === undefined) return false; // SQL three-valued logic: comparisons with NULL are never true
      if (op === "in") { if (!(val as any[]).some((x) => cmp(col.type, v, x) === 0)) return false; continue; }
      const c = cmp(col.type, v, val);
      const ok = op === "eq" ? c === 0 : op === "neq" ? c !== 0 : op === "lt" ? c < 0 : op === "lte" ? c <= 0 : op === "gt" ? c > 0 : op === "gte" ? c >= 0 : (() => { throw new Error(`fake: op ${op}`); })();
      if (!ok) return false;
    }
    return true;
  }

  private select(table: Table, q: any) {
    let rows = [...table.rows.values()].filter((r) => this.matches(table, r, q.where));
    const order = q.order?.length ? q.order : [];
    rows.sort((a, b) => {
      for (const o of order) {
        const col = table.cols.find((c) => c.name === o.field);
        if (!col) throw new Error(`fake: unknown column ${o.field}`);
        const d = cmp(col.type, a[o.field], b[o.field]) * (o.dir === "desc" ? -1 : 1);
        if (d) return d;
      }
      return 0;
    });
    const limit = Math.min(Math.max(Number(q.limit ?? 100), 1), 500);
    rows = rows.slice(Number(q.offset ?? 0), Number(q.offset ?? 0) + limit);
    return rows.map((r) => {
      const n = this.norm(table, r);
      return q.select?.length ? Object.fromEntries(q.select.map((f: string) => [f, n[f]])) : n;
    });
  }

  private conflicts(table: Table, row: Record<string, any>, ignoreId?: string) {
    return table.unique.some((cols) => cols.every((c) => row[c] !== null && row[c] !== undefined) &&
      [...table.rows.values()].some((o) => o.id !== ignoreId && cols.every((c) => o[c] === row[c])));
  }

  private checkCols(table: Table, data: Record<string, any>) {
    for (const k of Object.keys(data)) if (!table.cols.some((c) => c.name === k)) throw new Error(`fake: unknown column ${k}`);
  }

  private insert(table: Table, body: any): Response {
    const id = String(body.id ?? crypto.randomUUID());
    const data = { ...(body.data ?? {}), id };
    this.checkCols(table, data);
    const row: Record<string, any> = {};
    for (const c of table.cols) {
      let v = data[c.name];
      if (v === undefined) {
        if (c.hasDefault) v = c.def!.startsWith("'") ? c.def!.slice(1, -1).replace(/''/g, "'") : Number(c.def);
        else if (c.notNull) return j({ error: `null value in column ${c.name}` }, 500);
        else v = null;
      }
      if (v === null && c.notNull) return j({ error: `null value in column ${c.name}` }, 500);
      row[c.name] = v;
    }
    if (this.conflicts(table, row)) return j({ error: "row already exists", code: "row_conflict" }, 409);
    table.rows.set(id, row);
    return j({ row: this.norm(table, row) }, 201);
  }

  private update(table: Table, id: string, body: any): Response {
    const set = body.set ?? {};
    if ("id" in set) return j({ error: "id cannot be changed", code: "bad_set" }, 400);
    this.checkCols(table, set);
    const row = table.rows.get(id);
    const hit = row && this.matches(table, row, body.where);
    if (!hit) return body.where !== undefined ? j({ error: "conditional update did not match", code: "row_conflict" }, 409) : j({ error: "row not found", code: "row_not_found" }, 404);
    const next = { ...row, ...set };
    for (const c of table.cols) if (next[c.name] === null && c.notNull) return j({ error: `null value in column ${c.name}` }, 500);
    if (this.conflicts(table, next, id)) return j({ error: "row already exists", code: "row_conflict" }, 409);
    table.rows.set(id, next);
    return j({ row: this.norm(table, next) });
  }

  private del(table: Table, id: string): Response {
    if (!table.rows.delete(id)) return j({ error: "row not found", code: "row_not_found" }, 404);
    return j({ id, deleted: true });
  }

  /** Test helper: raw rows for a table. */
  rows(table: string) { return [...this.tables.get(table)!.rows.values()]; }
}
