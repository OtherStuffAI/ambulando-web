# NStack activation runbook (ambulando-web)

State of the code: the site stores everything in its own NStack app namespace (see README). Activation is gated on the steps below. **Do not push `deployed` until every gate is closed: replacing the live container discards its ephemeral SQLite.**

## Verified facts

- Canonical host: `https://nstack.otherstuff.ai` (service npub `npub1vf3h0rmlrr0x6pjc68jcrk5p2zsfzl3f9zwcppcdn8386npdlxgqmam99v`, build `1d01c72`). `sb4.otherstuff.studio` reports the same service npub on a newer build; the site targets `nstack.otherstuff.ai`.
- Deployed generic contract (commit `1d01c72`): `/api/v4/workspaces/:owner/apps/:app/db/{descriptor,provision,migrations,tables/:t/query,tables/:t/rows[/:id]}`, app-signed (NIP-98 by the registered app npub). `native-v1` is not deployed there (404) and is not used.
- Live site: CapRover target `secondary` (`captain.b.otherstuff.ai`), app `ambulando-web`, version 4, `hasPersistentData:false`, no volumes. The live build predates this repo's `main`.
- Contract tests: `scripts/real-nstack-test.sh` (Tower's real app-db code + throwaway PostgreSQL) and `bun test ./test`.

## Gates (in order)

1. **Resolve the namespace owner and register the existing app identity.** Read the intended workspace from live `/api/v4/flightdeck-pg/workspaces`; use its explicit `workspace_owner_npub`, not its workspace UUID or `workspace_service_npub`. Encrypted-record workspace discovery may return no rows even when typed workspace membership exists. A workspace manager can register directly; an agent can use an active owner-approved `namespace.manage` grant for that exact agent/app (production permission UI supports this). The agent still signs as itself.
   - Check delegated authority/readback with `GET /api/v4/workspaces/<owner npub>/apps?app_npub=<app npub>`. A successful empty list establishes authorized access before registration; it does not establish registration.
   - Register with `POST /api/v4/workspaces/<owner npub>/apps` and `{"app_npub":"<existing app npub>","app_name":"ambulando-web","capabilities":["wapp","app-db"],"enabled":true}`. Read back the exact app, capabilities, enabled state and creator.
   - Decrypt only the existing application's protected custody ciphertext in-process. Use that app signer to provision and install `src/schema.ts`, verify the migration checksum, and exercise insert/read through a fresh client/delete. A new client proves server-backed persistence, not service-restart durability. Keep run-specific identities and results in the ignored handoff.
2. **Capture the live SQLite and encryption key before any runtime mutation.** There is no current broker route that reads container files. Public cohort/enrolment counts do not capture users, sessions, Stripe settings or `secret.key`. Capture a consistent complete SQLite backup (including WAL state through SQLite backup tooling), the original `secret.key`, hashes and per-table counts into protected storage; retain originals. Do not replace/restart the container, change environment, mount over its data directory or replicate its image as a substitute for capturing its writable filesystem. A protected export capability or separately reviewed host-side capture is required when the running build has no export route.
3. **Provision runtime secrets after capture** through the owner-space protected environment route (`PATCH /api/owners/:owner/apps/:appId/caprover/environment`). Resolve the local app actually linked to `ambulando-web`; do not assume the main checkout's local app owns the deployment. Supply exact `caproverName: "ambulando-web"`, `caproverTarget: "secondary"`, `expectedServerUrl`, `expectedDomain`, and `envVars`. Values are never returned. Set `NSTACK_APP_NSEC`, `APP_SECRET_KEY`, optionally `NSTACK_OWNER_NPUB`, `ADMIN_NPUBS`, `BASE_URL`; decrypt `NSTACK_APP_NSEC` only inside the sending process. Treat environment updates as possible container replacement, even without a code deployment.
4. **Import and verify**: run `scripts/import-sqlite.ts` (dry run, then real) with the captured `ambulando.sqlite` and `secret.key`; keep the manifest and the original files.
5. **Deploy** (`wingman-deploy`: `main` pushed, `deployed` fast-forwarded and pushed, target `secondary` only) and check `/health`, `/courses`, an admin sign-in and a Stripe test-mode checkout.

## Recovery

- NStack data is the source of truth. `--rollback <manifest>` removes only rows an import run created.
- The original SQLite file and its manifest are kept untouched; the import can be re-run.
- To fall back to the previous site build, redeploy CapRover version 4 of `ambulando-web`; it starts with an empty SQLite, so keep the original database file if its data matters.
- Losing `APP_SECRET_KEY` makes saved Stripe keys unreadable (re-enter them in `/admin`). Losing `NSTACK_APP_NSEC` loses write access to the namespace, so keep its custody copy.
