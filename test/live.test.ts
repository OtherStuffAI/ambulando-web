import { expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { newNstack } from "./helpers.ts";

// Real HTTP over an ephemeral port with the signed NStack client. The namespace (fake NStack) outlives the app.
test("live HTTP smoke: real server, restart persistence, idempotent schema install", async () => {
  const ns = newNstack();
  let app = await createApp({ nstack: ns.nstack, config: { adminNpubs: [], secretKey: "k" } });
  let server = Bun.serve({ port: 0, fetch: app.fetch });
  const base = `http://localhost:${server.port}`;
  for (const p of ["/health", "/", "/courses", "/courses/chief-of-staff-foundations", "/login", "/account", "/admin", "/_app/client.js", "/_app/app.css", "/tokens.css"]) {
    const r = await fetch(base + p);
    expect(r.status).toBe(200);
    await r.arrayBuffer();
  }
  server.stop(true);
  // Restart against the same namespace: migrations are idempotent, the seed is not duplicated.
  app = await createApp({ nstack: ns.nstack, config: { adminNpubs: [], secretKey: "k" } });
  expect(ns.fake.rows("cohorts").length).toBe(1);
  expect(ns.fake.migrations.length).toBe(1);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  expect((await fetch(`http://localhost:${server.port}/api/courses`)).status).toBe(200);
  server.stop(true);
});
