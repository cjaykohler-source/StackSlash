"""Shared helpers for the host's local Python data syncs (service-role REST)."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent


def load_env() -> dict:
    env = {}
    for line in (REPO / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Rest:
    def __init__(self, env: dict):
        base = env.get("SUPABASE_URL") or env["VITE_SUPABASE_URL"]
        key = env["SUPABASE_SERVICE_ROLE_KEY"]
        self.base = base.rstrip("/") + "/rest/v1"
        self.s = requests.Session()
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"})

    def active_symbols(self) -> list[dict]:
        """Every active symbol, paginated with an explicit order (PostgREST skips rows without one)."""
        out, offset = [], 0
        while True:
            r = self.s.get(
                f"{self.base}/symbols",
                params={"select": "id,ticker", "active": "eq.true", "order": "id.asc"},
                headers={"Range": f"{offset}-{offset + 999}"},
            )
            r.raise_for_status()
            rows = r.json()
            out += rows
            if len(rows) < 1000:
                return out
            offset += 1000

    def upsert(self, table: str, rows: list[dict], on_conflict: str):
        for i in range(0, len(rows), 500):
            r = self.s.post(
                f"{self.base}/{table}",
                params={"on_conflict": on_conflict},
                json=rows[i:i + 500],
                headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
            )
            r.raise_for_status()

    def job_start(self, name: str) -> int:
        r = self.s.post(f"{self.base}/job_runs", json={"job_name": name, "status": "running"},
                        headers={"Prefer": "return=representation"})
        r.raise_for_status()
        return r.json()[0]["id"]

    def job_end(self, job_id: int, status: str, rows: int | None, error: str | None = None):
        self.s.patch(f"{self.base}/job_runs", params={"id": f"eq.{job_id}"},
                     json={"status": status, "rows_processed": rows, "error": error,
                           "finished_at": now_iso()}).raise_for_status()

    def run(self, name: str, fn):
        """Run fn() -> rows written inside a job_runs row; failures are recorded, then re-raised."""
        job_id = self.job_start(name)
        try:
            n = fn()
        except BaseException as e:
            self.job_end(job_id, "failed", None, repr(e)[:1000])
            raise
        self.job_end(job_id, "ok", n)
        return n
