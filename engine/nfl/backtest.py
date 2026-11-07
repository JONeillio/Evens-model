"""Walk-forward backtest: every week is projected using only games before it.

    python -m engine.nfl.backtest            -> data/nfl_model/{backtest.json, ratios.json, params.json}

Fits game-script volume on 2023-24, builds the miss table (actual/expected) on 2024,
then scores 2025 as an unseen season. Lines for players don't exist historically, so the
calibration test uses the player's recent average (rounded to .5) as a stand-in line;
team spread/total are scored against the real closing lines.
"""
from __future__ import annotations

import json
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np
import pandas as pd

from .data import CACHE, load
from .model import STATS, Params, fit_volume, p_over, prepare, project_week, ratio_table

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "nfl_model"


def walk(prep, season, weeks, P):
    rows, teams = [], []
    pl = prep["players"]
    for w in weeks:
        players, T = project_week(prep, season, w, P)
        if players.empty:
            continue
        act = pl[(pl["season"] == season) & (pl["week"] == w)][["player_id", "game_id", "receiving_yards", "rushing_yards", "passing_yards", "targets", "carries", "attempts"]]
        m = players.merge(act, on=["player_id", "game_id"], how="inner")  # played (props void if not)
        # Naive baseline: the player's own last-5-game average of the stat.
        hist = pl[pl["t"] < season * 100 + w].sort_values("t")
        last5 = hist.groupby("player_id").tail(5).groupby("player_id")[["receiving_yards", "rushing_yards", "passing_yards"]].mean()
        last5.columns = ["naive_rec_yds", "naive_rush_yds", "naive_pass_yds"]
        m = m.merge(last5, left_on="player_id", right_index=True, how="left")
        m["season"], m["week"] = season, w
        rows.append(m)
        T["season"], T["week"] = season, w
        teams.append(T)
    return pd.concat(rows, ignore_index=True), pd.concat(teams, ignore_index=True)


def score_players(bt: pd.DataFrame, table: dict) -> dict:
    out = {}
    for s, col in STATS.items():
        d = bt[(bt[f"proj_{s}"] > 3) & bt[f"naive_{s}"].notna() & (bt[f"naive_{s}"] > 5)].copy()
        if s == "pass_yds":
            d = d[d["pos"] == "QB"]
        mae_m = float((d[col] - d[f"proj_{s}"]).abs().mean())
        mae_n = float((d[col] - d[f"naive_{s}"]).abs().mean())
        # Stand-in line: recent average rounded to .5 (books set lines near a median).
        d["line"] = np.floor(d[f"naive_{s}"]) + 0.5
        d["p"] = [p_over(table, s, mu, L) for mu, L in zip(d[f"proj_{s}"], d["line"])]
        d = d[d["p"].notna()]
        d["over"] = (d[col] > d["line"]).astype(float)
        p = d["p"].clip(0.02, 0.98)
        ll = float(-(d["over"] * np.log(p) + (1 - d["over"]) * np.log(1 - p)).mean())
        base = d["over"].mean()
        ll0 = float(-(d["over"] * np.log(base) + (1 - d["over"]) * np.log(1 - base)).mean())
        bins = pd.cut(d["p"], [0, .3, .4, .5, .6, .7, 1.0])
        cal = d.groupby(bins, observed=True).agg(n=("over", "size"), said=("p", "mean"), came=("over", "mean")).reset_index(drop=True)
        strong = d[(d["p"] >= 0.62) | (d["p"] <= 0.38)]
        hit = float(np.where(strong["p"] >= 0.5, strong["over"], 1 - strong["over"]).mean()) if len(strong) else None
        out[s] = {"n": int(len(d)), "mae_model": round(mae_m, 2), "mae_naive": round(mae_n, 2),
                  "logloss_model": round(ll, 4), "logloss_flat": round(ll0, 4),
                  "calibration": cal.round(3).to_dict("records"),
                  "strong_calls": int(len(strong)), "strong_hit_rate": round(hit, 3) if hit is not None else None}
    return out


def score_teams(T: pd.DataFrame, prep) -> dict:
    pts = prep["points"][["game_id", "team", "pf"]].rename(columns={"pf": "act"})
    g = T.merge(pts, on=["game_id", "team"], how="inner")
    home = g[g["home"] == 1].merge(g[g["home"] == 0][["game_id", "pts_model", "act"]], on="game_id", suffixes=("", "_away"))
    home = home.dropna(subset=["margin", "total_line", "act", "act_away"])
    act_margin = home["act"] - home["act_away"]
    act_total = home["act"] + home["act_away"]
    m_model = home["pts_model"] - home["pts_model_away"]
    t_model = home["pts_model"] + home["pts_model_away"]
    res = {"games": int(len(home)),
           "margin_mae_model": round(float((act_margin - m_model).abs().mean()), 2),
           "margin_mae_line": round(float((act_margin - home["margin"]).abs().mean()), 2),
           "total_mae_model": round(float((act_total - t_model).abs().mean()), 2),
           "total_mae_line": round(float((act_total - home["total_line"]).abs().mean()), 2)}
    # Does nudging the line towards the model help? (w = share of the gap to move)
    for w in (0.1, 0.2, 0.3):
        mb = home["margin"] + w * (m_model - home["margin"])
        tb = home["total_line"] + w * (t_model - home["total_line"])
        res[f"margin_mae_blend_{w}"] = round(float((act_margin - mb).abs().mean()), 3)
        res[f"total_mae_blend_{w}"] = round(float((act_total - tb).abs().mean()), 3)
    # Against the spread when the model disagrees with the line by 3+ points.
    gap = m_model - home["margin"]
    big = gap.abs() >= 3
    cover = np.sign(act_margin - home["margin"])
    picks = np.sign(gap)
    sel = big & (cover != 0)
    res["ats_disagree_3plus"] = {"n": int(sel.sum()), "hit": round(float((picks[sel] == cover[sel]).mean()), 3) if sel.any() else None}
    return res


def main(offline: bool = False):
    data = load([2023, 2024, 2025, 2026], current=2026, offline=offline)
    prep = prepare(data)
    P = Params()
    P.vol_coef = fit_volume(prep, [2023, 2024], P)
    bt24, _ = walk(prep, 2024, range(4, 23), P)
    table = ratio_table(bt24)
    bt25, T25 = walk(prep, 2025, range(4, 19), P)
    report = {"params": {k: v for k, v in asdict(P).items()}, "players_2025": score_players(bt25, table),
              "teams_2025": score_teams(T25, prep)}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "backtest.json").write_text(json.dumps(report, indent=1, default=float))
    # Live tables use both seasons of misses.
    (OUT / "ratios.json").write_text(json.dumps(ratio_table(pd.concat([bt24, bt25])), separators=(",", ":")))
    (OUT / "params.json").write_text(json.dumps({"vol_coef": fit_volume(prep, [2024, 2025], P)}, indent=1))
    print(json.dumps(report, indent=1, default=float)[:6000])


if __name__ == "__main__":
    main(offline="--offline" in sys.argv)
