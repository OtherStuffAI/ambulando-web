# Ambulando web

The approved Ambulando marketing v7, packaged as a static Nginx website for CapRover. No runtime secrets, database, package installation or build tooling is needed.

## CapRover setup

- Repository: `https://github.com/OtherStuffAI/ambulando-web.git`
- Build branch: `deployed`
- Captain definition: `/captain-definition` at repository root (schema 2).
- Container HTTP port: **80**.
- Enable HTTPS on your chosen domain. No persistent directories are needed; see the app section below for required environment variables.
- Check `/health`, `/`, stylesheet and image loading after deployment.

## Local container

```sh
docker build -t ambulando-web .
docker run --rm -p 8080:80 ambulando-web
```

Open `http://localhost:8080/`. `/health` identifies artifact version v7. Missing paths return 404.

## Review and release

The page, styles, scripts and product assets in `public/` are byte-for-byte identical to the approved private artifact. Private review attachment files are excluded:
https://pale-log-tank.rick.runwingman.com/artifacts/Wingman_Suite/ambulando-marketing/v7/

Preserve that surface for comments and direction. Create new artifact versions for later review rounds, then copy the approved files into `public/` so the website and review version stay aligned. Artifact review controls are added by the Artifact WApp, not shipped with this website.

Develop on `main`, validate and push it, then fast-forward `deployed` from `main` and push `deployed`. Return to `main`. Avoid merge commits, resets, rebases and force pushes in the deployment path.

The hero retains a labelled product-video placeholder until a video URL is supplied. Product screenshots use isolated sample data; the business/time example is illustrative. See `public/source-notes.md` for provenance and claim boundaries.

## Training signup app (Bun + NStack + Applesauce)

All site data (users, sessions, cohorts, enrolments, seats, Stripe events, settings) lives in this site's own **NStack app namespace** (`https://nstack.otherstuff.ai`, generic app-signed relational API). The app owns its schema (`src/schema.ts`, checksummed append-only migrations) and business rules; NStack owns isolation and authority. There is no local database and no durable local file.

- Run: `bun install && bun src/server.ts` (PORT, default 3000). Tests: `bun test ./test`.
- Required env: `NSTACK_APP_NSEC` (the app's signing key; server-side only, never sent to browsers), `APP_SECRET_KEY` (passphrase that seals Stripe secrets at rest in NStack; losing it makes saved Stripe keys unreadable, so back it up), `NSTACK_OWNER_NPUB` (defaults to Pete's npub), `NSTACK_URL` (defaults to `https://nstack.otherstuff.ai`), optional `NSTACK_APP_NPUB` (asserted against the key), `NSTACK_APP_SLUG`.
- Other env: `ADMIN_NPUBS` (comma-separated, defaults to Pete's npub), `NOSTR_RELAYS` (relays the browser uses for kind 0 profile sync), `BASE_URL` (public origin for Stripe return URLs), `PORT`.
- On start the app idempotently provisions its namespace and applies migrations. The app npub must already be registered (enabled) as a workspace app for the owner on NStack.
- Admin: sign in at `/admin` with a NIP-07 extension using an npub in `ADMIN_NPUBS`; set Stripe keys, create cohorts, view signups.
- Stripe webhook (optional, recommended): `POST /api/stripe/webhook` with `checkout.session.completed`. Payments are also confirmed when the buyer returns from Stripe Checkout.

### Correctness under concurrency

NStack's generic API offers single-row operations, so invariants are encoded as unique indexes and compare-and-set updates rather than read-then-write:

- **Capacity**: each seat is a row with id `<cohort>:<n>`; one insert wins a seat, and a lapsed reservation is taken over with a conditional update on its current holder. Concurrent signups can never oversell. A payment that completes after its reservation lapsed is honoured (paid seats may exceed capacity rather than lose a payer's seat).
- **Accounts**: unique indexes on npub, pubkey and lower-cased username decide concurrent signups; a signup that cannot get a seat removes the account it just created.
- **Payments**: settlement is a conditional update (`status != paid`), so webhook retries and the buyer's return race safely; Stripe events are recorded and only skipped once fully processed.
- **Ids**: integer ids come from a compare-and-set counter (gaps possible, no duplicates).

### Moving data from the legacy SQLite database

`scripts/import-sqlite.ts` copies the old database into NStack, preserving every id, session, password hash, encrypted backup and agent ciphertext, re-sealing Stripe secrets under `APP_SECRET_KEY`, and verifying row counts plus a SHA-256 per table by reading everything back. It is repeatable (identical rows are skipped, differing rows stop the run), never modifies the SQLite file, and writes a manifest that `--rollback` uses to delete only the rows that run created.

```sh
bun scripts/import-sqlite.ts --source ./ambulando.sqlite --manifest ./import-manifest.json --source-key-file ./secret.key --dry-run
bun scripts/import-sqlite.ts --source ./ambulando.sqlite --manifest ./import-manifest.json --source-key-file ./secret.key
bun scripts/import-sqlite.ts --rollback ./import-manifest.json
```

### Testing against the real NStack code

`bun test ./test` uses an in-process fake of the NStack contract. `TOWER_SRC=/path/to/tower scripts/real-nstack-test.sh` additionally runs `test/nstack-real.test.ts` against Tower's actual app-db implementation on a throwaway local PostgreSQL (started and removed by the script).
