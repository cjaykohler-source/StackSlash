"""
Walk-forward test of the breakout feature table (breakout_features_v2.py):
which factors separate a breakout's prior close from matched non-breakout
stock-days, learned on earlier years and scored on the next, repeated
through today. Pure numpy (the research venv has no sklearn/scipy).

FOLDS    train on every anchor year < Y, test on year Y, Y = --first..last.

1. FACTOR SCREEN (the reverse-engineering view)
   Per feature, AUC of breakout vs control (0.5 = coin flip; below 0.5 =
   lower values go with breakouts). A factor is STABLE when it separates in
   training (|AUC-0.5| >= --min-edge) and points the same way, with at
   least half that edge, in the test year -- in >= --min-folds folds.
   Reported with train AUC, mean test AUC, and fold agreement.

2. COMBINED MODEL
   L2-regularized logistic regression on every numeric feature
   (standardized on the training years; NaN -> training median plus a
   missing-indicator for columns with gaps). Per test year:
     AUC         breakout vs control over the whole year
     top-1 rate  within each group (1 breakout + its ~5 controls), how often
                 the breakout gets the highest score; chance = 1/(group size)
   Plus the features with the largest weights in the latest fold.

CAVEAT: controls are matched ~5:1, not the real ~1-in-200 daily base rate,
so AUC / top-1 measure ranking, not a tradable hit rate. That needs a
population pass after this.

    research/.venv/bin/python research/breakout_walkforward.py \\
        research/data/study_outputs/breakout_features_v2_TIMESTAMP.parquet
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "data" / "study_outputs"
NON_FEATURES = {"rid", "group_id", "label", "event_gain_pct", "symbol", "anchor_date", "cik", "shares_raw", "shares_1y_raw"}


def auc(score, y):
    """Rank-based AUC (Mann-Whitney), ties averaged; NaN scores dropped."""
    ok = ~np.isnan(score)
    s, y = score[ok], y[ok]
    n1, n0 = y.sum(), (1 - y).sum()
    if n1 < 10 or n0 < 10:
        return np.nan
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s))
    sorted_s = s[order]
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return (ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def logistic(X, y, l2, iters=400, lr=0.5):
    """Batch gradient descent, class-balanced, L2 on weights (not the intercept)."""
    n, k = X.shape
    w, b = np.zeros(k), 0.0
    wt = np.where(y == 1, 0.5 / y.mean(), 0.5 / (1 - y.mean()))
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ w + b)))
        g = (p - y) * wt
        w -= lr * (X.T @ g / n + l2 * w)
        b -= lr * g.mean()
    return w, b


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("table")
    ap.add_argument("--first", type=int, default=2020)
    ap.add_argument("--min-edge", type=float, default=0.05)
    ap.add_argument("--min-folds", type=int, default=5)
    ap.add_argument("--l2", type=float, default=0.05)
    args = ap.parse_args()

    con = duckdb.connect()
    cols = con.execute(f"describe select * from '{args.table}'").fetchall()
    num_types = ("DOUBLE", "FLOAT", "INTEGER", "BIGINT", "HUGEINT", "SMALLINT", "BOOLEAN", "DECIMAL")
    feats = [c for c, t, *_ in cols if c not in NON_FEATURES and any(t.startswith(x) for x in num_types)]
    sel = ", ".join(f'cast("{c}" as double) as "{c}"' for c in feats)
    d = con.execute(f"select label, group_id, extract(year from anchor_date)::int yr, {sel} from '{args.table}'").fetchnumpy()
    y = np.asarray(d["label"], float)
    grp = np.asarray(d["group_id"])
    yr = np.asarray(d["yr"])
    X = np.column_stack([np.asarray(d[c], float) for c in feats])
    # drop constant / near-empty columns
    keep = [j for j in range(X.shape[1]) if np.isfinite(X[:, j]).sum() > 200 and np.nanstd(X[:, j]) > 0]
    X, feats = X[:, keep], [feats[j] for j in keep]
    last = int(yr.max())
    folds = list(range(args.first, last + 1))
    print(f"{len(y):,} rows ({int(y.sum()):,} breakouts), {len(feats)} features, folds {folds[0]}-{folds[-1]}", flush=True)

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    # ---- 1. factor screen ----
    tr_auc = np.full((len(folds), len(feats)), np.nan)
    te_auc = np.full((len(folds), len(feats)), np.nan)
    for fi, Y in enumerate(folds):
        tr, te = yr < Y, yr == Y
        for j in range(len(feats)):
            tr_auc[fi, j] = auc(X[tr, j], y[tr])
            te_auc[fi, j] = auc(X[te, j], y[te])
    edge_tr = tr_auc - 0.5
    edge_te = te_auc - 0.5
    agree = (np.abs(edge_tr) >= args.min_edge) & (np.sign(edge_te) == np.sign(edge_tr)) & (np.abs(edge_te) >= args.min_edge / 2)
    n_agree = np.nansum(agree, axis=0)
    full_auc = np.array([auc(X[:, j], y) for j in range(len(feats))])
    order = np.argsort(-np.abs(np.nan_to_num(full_auc - 0.5)))
    out(f"\n=== 1. Factor screen: stable = separates in training (|AUC-0.5| >= {args.min_edge}) and holds the same "
        f"direction in the test year, in >= {args.min_folds} of {len(folds)} folds ===")
    out(f"  {'feature':<34}{'all-yrs AUC':>12}{'mean test AUC':>15}{'folds held':>12}  direction")
    shown = 0
    for j in order:
        if n_agree[j] >= args.min_folds:
            direction = "higher -> breakout" if full_auc[j] > 0.5 else "lower -> breakout"
            out(f"  {feats[j]:<34}{full_auc[j]:>12.3f}{np.nanmean(te_auc[:, j]):>15.3f}{int(n_agree[j]):>8}/{len(folds)}  {direction}")
            shown += 1
    if not shown:
        out("  none")
    out(f"\n  (strongest factors overall, for reference, stable or not)")
    for j in order[:15]:
        out(f"  {feats[j]:<34}{full_auc[j]:>12.3f}{np.nanmean(te_auc[:, j]):>15.3f}{int(n_agree[j]):>8}/{len(folds)}")

    # ---- 2. combined model ----
    out("\n=== 2. Combined model (L2 logistic, walk-forward) ===")
    out(f"  {'test year':<10}{'breakouts':>10}{'rows':>8}{'AUC':>8}{'top-1 rate':>12}{'chance':>9}")
    weights_last = None
    all_auc = []
    for Y in folds:
        tr, te = yr < Y, yr == Y
        if y[te].sum() < 10:
            continue
        Xtr, Xte = X[tr], X[te]
        med = np.nanmedian(Xtr, axis=0)
        med = np.where(np.isnan(med), 0, med)
        miss_cols = [j for j in range(X.shape[1]) if np.isnan(Xtr[:, j]).mean() > 0.02]

        def prep(M):
            miss = np.isnan(M[:, miss_cols]).astype(float)
            M = np.where(np.isnan(M), med, M)
            return np.column_stack([M, miss])

        Ptr, Pte = prep(Xtr), prep(Xte)
        lo, hi = np.percentile(Ptr, [1, 99], axis=0)
        Ptr, Pte = np.clip(Ptr, lo, hi), np.clip(Pte, lo, hi)
        mu, sd = Ptr.mean(0), Ptr.std(0)
        sd[sd == 0] = 1
        Ptr, Pte = (Ptr - mu) / sd, (Pte - mu) / sd
        w, b = logistic(Ptr, y[tr], args.l2)
        score = Pte @ w + b
        a = auc(score, y[te])
        all_auc.append(a)
        g = grp[te]
        hits, chance = [], []
        for gid in np.unique(g):
            m = g == gid
            if y[te][m].sum() == 1 and m.sum() > 1:
                hits.append(float(y[te][m][np.argmax(score[m])] == 1))
                chance.append(1 / m.sum())
        out(f"  {Y:<10}{int(y[te].sum()):>10}{int(te.sum()):>8}{a:>8.3f}{np.mean(hits):>11.1%}{np.mean(chance):>9.1%}")
        names = feats + [f"missing:{feats[j]}" for j in miss_cols]
        weights_last = sorted(zip(names, w), key=lambda t: -abs(t[1]))[:20]
    out(f"  mean test AUC {np.nanmean(all_auc):.3f}")
    if weights_last:
        out(f"\n  largest standardized weights, latest fold (positive = pushes toward breakout):")
        for nme, wv in weights_last:
            out(f"    {nme:<40}{wv:+.3f}")

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"breakout_walkforward_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
