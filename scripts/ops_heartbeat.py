"""
Ops heartbeat (launchd com.stackslash.ops-heartbeat, every 5 minutes):
pushes every com.stackslash.* launchd job's state to Supabase
ops_host_status for the /ops page, plus a '_host' row whose updated_at says
this machine is up. Jobs that don't write job_runs (local scripts:
research-update, supabase-backup, reddit-collect, research-publish, ...)
are judged by the page from these rows alone.

Per job: loaded (in `launchctl list`), pid (running now), last exit status,
and last_log_at = newest mtime among ~/Library/Logs/stackslash-<job>/*.
Service-role write over PostgREST (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).

    research/.venv/bin/python scripts/ops_heartbeat.py
"""
import json
import os
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

AGENTS = Path.home() / "Library" / "LaunchAgents"
LOGS = Path.home() / "Library" / "Logs"
# launchd label suffix -> ops_jobs.name where they differ
ALIASES = {"outlier-worker": "realtime-outlier-worker"}


def launchctl():
    out = subprocess.run(["launchctl", "list"], capture_output=True, text=True, check=True).stdout
    state = {}
    for line in out.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) == 3 and parts[2].startswith("com.stackslash."):
            pid, status, label = parts
            state[label] = (int(pid) if pid.strip().isdigit() else None,
                            int(status) if status.strip().lstrip("-").isdigit() else None)
    return state


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None


def main():
    env = Path(__file__).resolve().parent.parent / ".env"
    for line in env.read_text().splitlines() if env.exists() else []:
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))
    base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1/ops_host_status?on_conflict=label"
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    loaded = launchctl()
    now = datetime.now(timezone.utc).isoformat()
    rows = [{"label": "_host", "loaded": True, "pid": os.getpid(), "last_exit": 0, "last_log_at": now, "updated_at": now}]
    for plist in sorted(AGENTS.glob("com.stackslash.*.plist")):
        label = plist.stem
        short = label.removeprefix("com.stackslash.")
        logdir = LOGS / f"stackslash-{short}"
        mtimes = [p.stat().st_mtime for p in logdir.glob("*") if p.is_file()] if logdir.is_dir() else []
        pid, status = loaded.get(label, (None, None))
        rows.append({"label": ALIASES.get(short, short), "loaded": label in loaded, "pid": pid,
                     "last_exit": status, "last_log_at": iso(max(mtimes) if mtimes else None), "updated_at": now})
    req = urllib.request.Request(base, data=json.dumps(rows).encode(), method="POST", headers={
        "apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal"})
    with urllib.request.urlopen(req, timeout=30):
        pass
    print(f"{now}: {len(rows) - 1} launchd jobs reported")


if __name__ == "__main__":
    main()
