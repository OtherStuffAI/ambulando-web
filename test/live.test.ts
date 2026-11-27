import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";

// Real HTTP over an ephemeral port (started and stopped inside the test) with a file-backed DB.
test("live HTTP smoke: file DB, real server, key file, restart persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ambulando-"));
  const dbPath = join(dir, "data", "a.sqlite");
  try {
    let app = await createApp({ config: { databasePath: dbPath, adminNpubs: [] } });
    let server = Bun.serve({ port: 0, fetch: app.fetch });
    const base = `http://localhost:${server.port}`;
    for (const p of ["/health", "/", "/courses", "/courses/chief-of-staff-foundations", "/login", "/account", "/admin", "/_app/client.js", "/_app/app.css", "/tokens.css"]) {
      const r = await fetch(base + p);
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    server.stop(true);
    app.db.close();
    expect(existsSync(join(dir, "data", "secret.key"))).toBe(true);
    // Reopen: migrations are idempotent, seed not duplicated.
    app = await createApp({ config: { databasePath: dbPath, adminNpubs: [] } });
    expect((app.db.query("SELECT COUNT(*) n FROM cohorts").get() as any).n).toBe(1);
    app.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
