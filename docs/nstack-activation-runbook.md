# NStack activation runbook (ambulando-web)

State of the code: the site stores everything in its own NStack app namespace (see README). Activation is gated on the steps below. **Do not push `deployed` until every gate is closed: replacing the live container discards its ephemeral SQLite.**

## Verified facts

- Canonical host: `https://nstack.otherstuff.ai` (service npub `npub1vf3h0rmlrr0x6pjc68jcrk5p2zsfzl3f9zwcppcdn8386npdlxgqmam99v`, build `1d01c72`). `sb4.otherstuff.studio` reports the same service npub on a newer build; the site targets `nstack.otherstuff.ai`.
- Deployed generic contract (commit `1d01c72`): `/api/v4/workspaces/:owner/apps/:app/db/{descriptor,provision,migrations,tables/:t/query,tables/:t/rows[/:id]}`, app-signed (NIP-98 by the registered app npub). `native-v1` is not deployed there (404) and is not used.
- Live site: CapRover target `secondary` (`captain.b.otherstuff.ai`), app `ambulando-web`, version 4, `hasPersistentData:false`, no volumes. The live build predates this repo's `main`.
- Contract tests: `scripts/real-nstack-test.sh` (Tower's real app-db code + throwaway PostgreSQL) and `bun test ./test`.

## Gates (in order)

1. **Register the app identity** (needs a workspace manager of the owner on NStack; the delegated agent signer is not one and was refused with `403 Not authorized to manage this workspace`):
   `POST /api/v4/workspaces/<owner npub>/apps` with `{"app_npub":"<app npub>","app_name":"ambulando-web","capabilities":["wapp","app-db"],"enabled":true}`.
   The candidate identity's public key is recorded in the private handoff; its private key exists only as a NIP-44 ciphertext addressed to the delegated agent signer.
2. **Provision runtime secrets** through the owner-space protected environment route (`PATCH /api/owners/:owner/apps/:appId/caprover/environment`, `caproverTarget: "secondary"`, values never returned): `NSTACK_APP_NSEC`, `APP_SECRET_KEY`, optionally `NSTACK_OWNER_NPUB`, `ADMIN_NPUBS`, `BASE_URL`. `NSTACK_APP_NSEC` must be decrypted only inside the script that sends it.
3. **Capture the live SQLite before replacing the container.** There is no broker route that reads container files. Unless the old build is first kept running elsewhere, a complete protected export or explicit data-reset authorisation is required. Public readback of the live build showed one seeded cohort and zero enrolments, but users, sessions, Stripe settings and `secret.key` (the only key that opens existing Stripe config) are not visible without admin access to the live site.
4. **Import and verify**: run `scripts/import-sqlite.ts` (dry run, then real) with the captured `ambulando.sqlite` and `secret.key`; keep the manifest and the original files.
5. **Deploy** (`wingman-deploy`: `main` pushed, `deployed` fast-forwarded and pushed, target `secondary` only) and check `/health`, `/courses`, an admin sign-in and a Stripe test-mode checkout.

## Recovery

- NStack data is the source of truth. `--rollback <manifest>` removes only rows an import run created.
- The original SQLite file and its manifest are kept untouched; the import can be re-run.
- To fall back to the previous site build, redeploy CapRover version 4 of `ambulando-web`; it starts with an empty SQLite, so keep the original database file if its data matters.
- Losing `APP_SECRET_KEY` makes saved Stripe keys unreadable (re-enter them in `/admin`). Losing `NSTACK_APP_NSEC` loses write access to the namespace, so keep its custody copy.
