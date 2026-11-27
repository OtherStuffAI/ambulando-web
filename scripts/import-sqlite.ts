#!/usr/bin/env bun
/**
 * Import the legacy SQLite database into the NStack namespace.
 *
 *   bun scripts/import-sqlite.ts --source ./ambulando.sqlite --manifest ./import-manifest.json \
 *       [--source-key-file ./secret.key | --source-secret-passphrase-env LEGACY_APP_SECRET_KEY] [--dry-run]
 *   bun scripts/import-sqlite.ts --rollback ./import-manifest.json
 *
 * Environment (same as the server): NSTACK_URL, NSTACK_OWNER_NPUB, NSTACK_APP_NSEC, APP_SECRET_KEY.
 * The SQLite file is opened read-only and is never modified. Secrets are never printed.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { importSqlite, rollbackImport, type Manifest } from "../src/migrate.ts";
import { NstackDb } from "../src/nstack.ts";
import { ensureSchema } from "../src/schema.ts";
import { SecretBox } from "../src/secrets.ts";
import { fromBase64 } from "../src/shared/backup.ts";
import { Store } from "../src/store.ts";

const arg = (n: string) => { const i = Bun.argv.indexOf(n); return i > 0 ? Bun.argv[i + 1] : undefined; };
const flag = (n: string) => Bun.argv.includes(n);

const config = loadConfig();
if (!config.nstack) throw new Error("Set NSTACK_URL, NSTACK_OWNER_NPUB and NSTACK_APP_NSEC");
const db = new NstackDb(config.nstack);

const rollbackFile = arg("--rollback");
if (rollbackFile) {
  const m = JSON.parse(readFileSync(rollbackFile, "utf8")) as Manifest;
  console.log("removed", await rollbackImport(db, m));
  process.exit(0);
}

const source = arg("--source");
if (!source || !existsSync(source)) throw new Error("--source <sqlite file> is required");
const manifestPath = arg("--manifest");
if (!manifestPath) throw new Error("--manifest <output json> is required");

const src = new Database(source, { readonly: true });
const sourceSha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
let sourceBox: SecretBox | undefined;
const keyFile = arg("--source-key-file");
const passEnv = arg("--source-secret-passphrase-env");
if (keyFile) sourceBox = await SecretBox.fromRaw(fromBase64(readFileSync(keyFile, "utf8").trim()));
else if (passEnv) sourceBox = await SecretBox.create({ secretKey: process.env[passEnv] });
const targetBox = await SecretBox.create({ secretKey: config.secretKey });

await ensureSchema(db);
const manifest = await importSqlite(src, new Store(db), { sourceBox, targetBox, dryRun: flag("--dry-run"), sourceSha256 });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
console.log(flag("--dry-run") ? "DRY RUN" : "IMPORTED AND VERIFIED", JSON.stringify({ counts: manifest.counts, skipped: manifest.skipped, counters: manifest.counters, checksums: manifest.checksums }, null, 2));
