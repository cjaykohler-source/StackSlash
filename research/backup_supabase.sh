#!/usr/bin/env bash
# Nightly logical backup of the operational Supabase database.
#
# WHY THIS IS NOT OPTIONAL, especially after a downgrade to free tier:
# Pro is currently taking daily backups. Free tier is not. Most of what
# lives in that database cannot be re-fetched from anywhere —
# fire_outcomes (the live realized-outcome record, and the one artifact in
# this project that has never been wrong), trigger_events, dossiers,
# alerts, shadow_positions and job_runs are all accumulated history. Only
# bars_daily / bars_intraday can be rebuilt from Alpaca.
#
# Deliberately NOT written into research/data/ — that directory is the
# disposable analytical warehouse and is documented as not backed up.
# Conflating the two is how a "safe to delete" rule eats something that
# wasn't.
#
# Auth: either
#   supabase link --project-ref wnzxvdfskmivbyqadtll     (prompts for the
#   DB password, stores it in the CLI credential store)   <- preferred
# or put DATABASE_URL in .env and this uses pg_dump directly.
#
# Usage:  research/backup_supabase.sh
# Cron:   see scripts/launchd/ for the pattern used by the other jobs.
set -euo pipefail

# launchd's default PATH lacks /opt/homebrew/bin (supabase CLI) and
# /usr/local/bin (docker, which `supabase db dump` shells out to) — without
# this every nightly run died with "supabase: command not found" (exit 127)
# from 2026-09-21 on.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${STACKSLASH_BACKUP_DIR:-$HOME/StackSlashBackups}"
KEEP=14
PROJECT_REF="wnzxvdfskmivbyqadtll"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/stackslash-$STAMP.sql.gz"
# Dump into a temp name and only rename once it is known good: a failed
# dump must never leave a file matching stackslash-*.sql.gz, or it counts
# toward KEEP and rotates real backups out.
TMP="$BACKUP_DIR/.stackslash-$STAMP.sql.gz.partial"
trap 'rm -f "$TMP"' EXIT

mkdir -p "$BACKUP_DIR"
cd "$REPO"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

echo "=== backing up to $OUT ==="

if [ -n "${DATABASE_URL:-}" ]; then
  echo "using pg_dump via DATABASE_URL"
  # Homebrew's libpq is keg-only, so its pg_dump is not on PATH by default.
  PGDUMP="$(command -v pg_dump || { [ -x /opt/homebrew/opt/libpq/bin/pg_dump ] && echo /opt/homebrew/opt/libpq/bin/pg_dump; } || echo /Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump)"
  "$PGDUMP" --no-owner --no-privileges "$DATABASE_URL" | gzip > "$TMP"
else
  echo "using supabase CLI (run 'supabase link --project-ref $PROJECT_REF' if this fails)"
  # `supabase db dump` runs pg_dump in a container, so Docker Desktop must
  # be up. Start it if it isn't and give it a few minutes.
  if ! docker info >/dev/null 2>&1; then
    echo "docker daemon not running — starting Docker Desktop"
    open -ga Docker
    for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 5; done
    docker info >/dev/null 2>&1 || { echo "!!! docker never came up" >&2; exit 1; }
  fi
  # Roles and data are separate dumps in the CLI; concatenate so the file
  # is a single restorable artifact.
  {
    supabase db dump --project-ref "$PROJECT_REF" --schema public
    # --use-copy: the CLI's default is one INSERT per row, which pg_dump
    # reads through a 100-row cursor — ~5 MB/min on this database, and just
    # as slow to restore. COPY is the same data at bulk speed.
    supabase db dump --project-ref "$PROJECT_REF" --schema public --data-only --use-copy
  } | gzip > "$TMP"
fi

# Fail loudly on an implausibly small dump rather than silently rotating
# a good backup out in favour of an empty one — the same class of silent
# failure that has cost this project four headline numbers.
MIN_BYTES=1000000
ACTUAL="$(stat -f%z "$TMP" 2>/dev/null || stat -c%s "$TMP")"
if [ "$ACTUAL" -lt "$MIN_BYTES" ]; then
  echo "!!! dump is only $ACTUAL bytes — discarding it, older backups untouched" >&2
  exit 1
fi
gzip -t "$TMP"
mv "$TMP" "$OUT"
trap - EXIT
echo "=== wrote $OUT ($(du -h "$OUT" | cut -f1)) ==="

echo "=== pruning to the newest $KEEP ==="
ls -1t "$BACKUP_DIR"/stackslash-*.sql.gz | tail -n +$((KEEP + 1)) | while read -r old; do
  echo "  removing $(basename "$old")"
  rm -f "$old"
done

ls -1t "$BACKUP_DIR"/stackslash-*.sql.gz | head -5
echo "=== done ==="
