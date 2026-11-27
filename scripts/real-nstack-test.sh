#!/bin/sh
# Runs test/nstack-real.test.ts against NStack's real app-db code (a tower checkout) on a throwaway PostgreSQL.
# Usage: TOWER_SRC=/path/to/tower scripts/real-nstack-test.sh
# Starts a task-owned PostgreSQL 16 on a random localhost port and removes it (data dir included) on exit.
set -eu
: "${TOWER_SRC:?set TOWER_SRC to a tower checkout}"
PGBIN="${PGBIN:-/opt/homebrew/opt/postgresql@16/bin}"
DIR="$(mktemp -d /tmp/ambulando-pgfix.XXXXXX)"
PORT="$(python3 -I -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
cleanup() { "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT INT TERM
"$PGBIN/initdb" -D "$DIR/data" -A trust -U fixture >/dev/null
"$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/pg.log" -w start >/dev/null
"$PGBIN/createdb" -h 127.0.0.1 -p "$PORT" -U fixture ambulando_fixture
# Tower refuses to load config without these; fixture-only placeholders, none are real credentials.
FIXTURE_NPUB="$(bun -e 'import {getPublicKey,nip19} from "nostr-tools";console.log(nip19.npubEncode(getPublicKey(new Uint8Array(32).fill(72))))')"
export SUPERBASED_DIRECT_HTTPS_URL=https://fixture.invalid ADMIN_NPUB="$FIXTURE_NPUB" FLIGHT_DECK_PG_APP_NPUB="$FIXTURE_NPUB"
export STORAGE_S3_ACCESS_KEY=fixture STORAGE_S3_SECRET_KEY=fixture STORAGE_S3_ENDPOINT=http://127.0.0.1:1 STORAGE_S3_ENDPOINT_PUBLIC=http://127.0.0.1:1 STORAGE_S3_BUCKET=fixture
NSTACK_FIXTURE_DATABASE_URL="postgres://fixture@127.0.0.1:$PORT/ambulando_fixture" \
  DB_HOST=127.0.0.1 DB_PORT="$PORT" DB_USER=fixture DB_PASSWORD=fixture DB_NAME=ambulando_fixture \
  bun test ./test/nstack-real.test.ts
