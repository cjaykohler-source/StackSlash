"""
Index of the minute warehouse: which parquet files hold a given symbol-day.

research/data/minute holds ~740k small files. research/data/minute_log.duckdb
already records, per load unit, its month (monthly backfill units) or day
(nightly update units), the symbols it covers, and the file it wrote. This
flattens that into (symbol, month, day, file) and caches it as
research/data/charter/minute_index.parquet, rebuilt when the load log changes.
A symbol-day lookup then opens one or two files instead of scanning 740k.
"""
import shutil
import tempfile
import threading
import time
from pathlib import Path

import duckdb


class MinuteIndex:
    def __init__(self, data: Path):
        self.log = data / "minute_log.duckdb"
        self.cache = data / "charter" / "minute_index.parquet"
        self.lock = threading.Lock()
        self.con = duckdb.connect()
        self.size = 0
        self._load()

    def _stale(self):
        return not self.cache.exists() or self.cache.stat().st_mtime < self.log.stat().st_mtime

    def _rebuild(self):
        self.cache.parent.mkdir(parents=True, exist_ok=True)
        # the loader may hold the log open; read a copy so we never block or lock it
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "log.duckdb"
            shutil.copy2(self.log, copy)
            wal = self.log.with_suffix(".duckdb.wal")
            if wal.exists():
                shutil.copy2(wal, Path(tmp) / "log.duckdb.wal")
            c = duckdb.connect(str(copy), read_only=True)
            c.execute(f"""
              copy (
                select trim(unnest(string_split(u.symbols, ','))) symbol, u.month, u.day, l.file
                from minute_units u join minute_load_log l using (unit_id)
                where l.file is not null and l.bars > 0
              ) to '{self.cache}' (format parquet)
            """)
            c.close()

    def _load(self):
        with self.lock:
            if self._stale():
                t0 = time.time()
                self._rebuild()
                print(f"minute index rebuilt in {time.time() - t0:.0f}s", flush=True)
            self.con.execute(f"create or replace table idx as select * from '{self.cache}' order by symbol")
            self.size = self.con.execute("select count(*) from idx").fetchone()[0]
            self.loaded_at = time.time()

    def files(self, symbol, day):
        if time.time() - self.loaded_at > 3600 and self._stale():
            self._load()
        month = day.replace(day=1)
        with self.lock:
            rows = self.con.execute(
                "select distinct file from idx where symbol = ? and (day = ? or (day is null and month = ?))",
                [symbol, day, month]).fetchall()
        return [r[0] for r in rows if Path(r[0]).exists()]
