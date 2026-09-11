#!/usr/bin/env bash
# One-shot setup of the local research warehouse on the worker host.
#
# Everything in this project runs on the worker host. This script is the
# whole bootstrap: report the machine's actual capacity, build the Python
# environment, and load bars_daily + symbols out of Supabase into DuckDB.
#
# Read-only against Supabase. It creates nothing there and deletes
# nothing anywhere. Safe to re-run; the loader replaces its tables.
#
# Usage:  ./research/setup_worker_host.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

echo "=============================================="
echo " machine"
echo "=============================================="
hostname
echo "user: $(whoami)"
echo "repo: $REPO"
df -h . | tail -1 | awk '{print "disk: "$4" available of "$2" ("$5" used)"}'
if sysctl -n hw.memsize >/dev/null 2>&1; then
  sysctl -n hw.memsize | awk '{printf "ram:  %.0f GB\n", $1/1073741824}'
  sysctl -n machdep.cpu.brand_string 2>/dev/null | sed 's/^/cpu:  /'
fi
python3 -V | sed 's/^/py:   /'

echo
echo "=============================================="
echo " python environment"
echo "=============================================="
if [ ! -x research/.venv/bin/python ]; then
  python3 -m venv research/.venv
  echo "created research/.venv"
else
  echo "research/.venv already exists"
fi
research/.venv/bin/pip install -q --upgrade pip
research/.venv/bin/pip install -q duckdb pyarrow requests
research/.venv/bin/python -c "import duckdb, pyarrow; print(f'duckdb {duckdb.__version__} | pyarrow {pyarrow.__version__}')"

if [ ! -f .env ]; then
  echo
  echo "!!! no .env in $REPO — the loader needs SUPABASE_SERVICE_ROLE_KEY." >&2
  exit 1
fi

echo
echo "=============================================="
echo " loading warehouse (about 4 minutes)"
echo "=============================================="
research/.venv/bin/python research/load_from_supabase.py

echo
echo "=============================================="
echo " next"
echo "=============================================="
echo "  supabase link --project-ref wnzxvdfskmivbyqadtll   # prompts for the DB password"
echo "  research/backup_supabase.sh                        # first operational backup"
