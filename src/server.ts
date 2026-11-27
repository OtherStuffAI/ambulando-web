import { createApp } from "./app.ts";

const app = await createApp();
const port = Number(process.env.PORT ?? 3000);
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`Ambulando web listening on http://localhost:${server.port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { server.stop(); app.db.close(); process.exit(0); });
}
