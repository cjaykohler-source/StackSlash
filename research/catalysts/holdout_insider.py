"""
The one-shot 2022+ test of size-conditioned insider buying, pre-registered in
docs/insider-2022-prereg.md (README item 43 follow-up). Same machinery and
decision rules as holdout_2022.py (copied, which stays the record of item 37);
only the rule set, the document and the output name differ. With one primary
rule, Holm across the family is just its own p.

    research/.venv/bin/python research/catalysts/holdout_insider.py --run --approved-commit <sha>
    research/.venv/bin/python research/catalysts/holdout_insider.py --evaluate <run_ts> [<run_ts_band5>]
"""
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CAT = HERE.parent / "data" / "catalysts"
PY = sys.executable
PREREG = REPO / "docs" / "insider-2022-prereg.md"
FROZEN = [HERE / "harness.py", Path(__file__).resolve(), PREREG]

# type -> discovery direction ("below_null" = avoid rule, "above_null" = positive rule)
PRIMARY = {
    "f4_buy_mcap_0.1pct": "above_null",
}
SECONDARY = {
    "f4_buy_mcap_0.5pct": "above_null",
    "f4_buy": "above_null",
}
ALPHA = 0.05
H = 20
REPS = 5000
SEED = 7
BANDS = {"primary": ["--max-price", "15"], "band5": ["--max-price", "5"]}


def git(*a):
    return subprocess.run(["git", *a], cwd=REPO, capture_output=True, text=True, check=True).stdout.strip()


def check_frozen(sha):
    if subprocess.run(["git", "merge-base", "--is-ancestor", sha, "HEAD"], cwd=REPO).returncode != 0:
        raise SystemExit(f"HEAD does not contain the approved commit {sha}")
    changed = git("diff", "--name-only", sha, "HEAD", "--", *[str(p.relative_to(REPO)) for p in FROZEN])
    dirty = git("status", "--porcelain", "--", *[str(p.relative_to(REPO)) for p in FROZEN])
    if changed or dirty:
        raise SystemExit(f"pre-registered files changed since {sha}:\n{changed}\n{dirty}")


def holm(ps):
    """Holm step-down adjusted p-values, same order as `ps`."""
    order = sorted(range(len(ps)), key=lambda i: ps[i])
    adj, running = [0.0] * len(ps), 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (len(ps) - rank) * ps[i]))
        adj[i] = running
    return adj


def rows_of(run_ts):
    d = json.loads((CAT / "runs" / f"{run_ts}.json").read_text())
    return d, {(r["type"], r["period"], r["h"]): r for r in d["results"]}


def clear_of_null(r, direction):
    return (r["ci_lo"] > r["null_med"]) if direction == "above_null" else (r["ci_hi"] < r["null_med"])


def evaluate(run_ts, run_ts5=None):
    d, R = rows_of(run_ts)
    R5 = rows_of(run_ts5)[1] if run_ts5 else {}
    out = [f"# 2022+ insider-buying holdout — run {run_ts}" + (f" (+ $0.10-$5 run {run_ts5})" if run_ts5 else ""), ""]
    fam = [t for t in PRIMARY if (t, "2022+", H) in R]
    missing = [t for t in PRIMARY if t not in fam]
    ps = []
    for t in fam:
        r = R[(t, "2022+", H)]
        ps.append(float(r["p_lo"] if PRIMARY[t] == "below_null" else r["p_hi"]))
    adj = dict(zip(fam, holm(ps)))
    hdr = "| rule | n | gap 2016-21 | gap 2022+ | 90% CI vs null | one-sided p | Holm p | verdict | $0.10-$5 2022+ gap | net 20d vs universe |"
    out += ["## Primary (Holm across %d rules, alpha %.2f)" % (len(fam), ALPHA), "", hdr, "|" + "---|" * 10]
    for t in fam:
        r, r0, direction = R[(t, "2022+", H)], R.get((t, "2016-21", H)), PRIMARY[t]
        gap = r["mean_x"] - r["null_med"]
        same = (gap > 0) == (direction == "above_null")
        p1 = float(r["p_lo"] if direction == "below_null" else r["p_hi"])
        passed = same and adj[t] <= ALPHA and clear_of_null(r, direction)
        b5 = R5.get((t, "2022+", H))
        inband = bool(b5) and ((b5["mean_x"] - b5["null_med"] > 0) == (direction == "above_null")) and clear_of_null(b5, direction)
        verdict = ("VALIDATED FOR USE" if passed and inband else "PASS, not in the traded band" if passed and b5
                   else "PASS, in-band check not computable (< 200 events)" if passed else "FAIL")
        money = f"{r['mean_net'] * 100:+.2f}% vs {r['base_net'] * 100:+.2f}%" if direction == "above_null" else "—"
        out.append(f"| {t} | {r['n']:,} | {((r0['mean_x'] - r0['null_med']) * 100) if r0 else float('nan'):+.2f}% | {gap * 100:+.2f}% | "
                   f"[{r['ci_lo'] * 100:.2f}, {r['ci_hi'] * 100:.2f}] vs {r['null_med'] * 100:.2f}% | {p1:.4f} | {adj[t]:.4f} | **{verdict}** | "
                   f"{((b5['mean_x'] - b5['null_med']) * 100) if b5 else float('nan'):+.2f}% | {money} |")
    if missing:
        out += ["", f"Not computed (fewer than the harness's minimum events in 2022+): {', '.join(missing)} — counted as FAIL."]
    out += ["", "## Secondary (reported only, never PASS)", "", "| rule | n | gap 2016-21 | gap 2022+ | 90% CI vs null | one-sided p |", "|---|---|---|---|---|---|"]
    for t, direction in SECONDARY.items():
        r, r0 = R.get((t, "2022+", H)), R.get((t, "2016-21", H))
        if not r:
            out.append(f"| {t} | — | | not computed | | |")
            continue
        p1 = float(r["p_lo"] if direction == "below_null" else r["p_hi"])
        out.append(f"| {t} | {r['n']:,} | {((r0['mean_x'] - r0['null_med']) * 100) if r0 else float('nan'):+.2f}% | "
                   f"{(r['mean_x'] - r['null_med']) * 100:+.2f}% | [{r['ci_lo'] * 100:.2f}, {r['ci_hi'] * 100:.2f}] vs {r['null_med'] * 100:.2f}% | {p1:.4f} |")
    text = "\n".join(out)
    (CAT / "runs" / f"holdout_insider_{run_ts}.md").write_text(text + "\n")
    print(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--approved-commit")
    ap.add_argument("--evaluate", nargs="+", metavar="RUN_TS")
    a = ap.parse_args()
    if a.evaluate:
        return evaluate(*a.evaluate)
    if not (a.run and a.approved_commit):
        raise SystemExit("usage: --run --approved-commit <sha>   or   --evaluate <run_ts> [<run_ts_band5>]")
    check_frozen(a.approved_commit)
    stamp = hashlib.sha256(b"".join(p.read_bytes() for p in FROZEN)).hexdigest()[:12]
    print(f"pre-registration frozen at {a.approved_commit} (content hash {stamp}); running the 2022+ holdout once")
    types = ",".join([*PRIMARY, *SECONDARY])
    run_ids = {}
    for band, extra in BANDS.items():
        before = {p.name for p in (CAT / "runs").glob("*.json")}
        subprocess.run([PY, "-u", str(HERE / "harness.py"), "--types", types, "--holdout", "--reps", str(REPS),
                        "--seed", str(SEED), *extra], check=True)
        new = sorted({p.name for p in (CAT / "runs").glob("*.json")} - before)
        run_ids[band] = new[-1].removesuffix(".json")
    evaluate(run_ids["primary"], run_ids["band5"])


if __name__ == "__main__":
    main()
