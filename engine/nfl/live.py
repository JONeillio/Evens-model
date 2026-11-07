"""This week's NFL projections, lined up with the player-yards prices.

Called by engine/run.py after the odds are in:

  1. Match each OddsPapi NFL fixture to its nflverse game (team codes + date).
  2. Project every likely player from stats only (engine/nfl/model.py), after removing
     players listed Out or Doubtful and sharing their targets and carries among teammates.
  3. For each player and stat, anchor the projection to the market's main line:
       Pinnacle's line (margin removed) where it exists, weight 75% market / 25% model;
       otherwise the UK bookies' two-way average, 50 / 50;
       otherwise the model alone (marked 'model').
     The anchored centre plus the model's own spread of misses prices every line any
     bookie offers, including the short alternative lines (over 19.5 at 1/7).
  4. Skip players where model and market disagree badly: usually news we don't have.

Outputs legs in the same shape as engine/legs.build_legs, plus a projections list
(who's going to do what) for the app.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from ..fair import fair_probs
from .data import load
from .model import Params, p_over, prepare, project_week, quantiles

ROOT = Path(__file__).resolve().parents[2]
MODEL_DIR = ROOT / "data" / "nfl_model"
LABEL = {"rec_yds": "receiving yds", "rush_yds": "rushing yds", "pass_yds": "passing yds"}
SHORT = {"rec_yds": "rec yds", "rush_yds": "rush yds", "pass_yds": "pass yds"}
CAL_SHRINK = 0.85        # backtest: slightly overconfident above ~65%, so pull towards 50%
W_SHARP, W_CONS = 0.75, 0.5
MAX_GAP = 0.45           # skip if model and market centres differ by more than 45%

NFL_ABBR = {
    "arizona cardinals": "ARI", "atlanta falcons": "ATL", "baltimore ravens": "BAL", "buffalo bills": "BUF",
    "carolina panthers": "CAR", "chicago bears": "CHI", "cincinnati bengals": "CIN", "cleveland browns": "CLE",
    "dallas cowboys": "DAL", "denver broncos": "DEN", "detroit lions": "DET", "green bay packers": "GB",
    "houston texans": "HOU", "indianapolis colts": "IND", "jacksonville jaguars": "JAX", "kansas city chiefs": "KC",
    "las vegas raiders": "LV", "los angeles chargers": "LAC", "los angeles rams": "LA", "miami dolphins": "MIA",
    "minnesota vikings": "MIN", "new england patriots": "NE", "new orleans saints": "NO", "new york giants": "NYG",
    "new york jets": "NYJ", "philadelphia eagles": "PHI", "pittsburgh steelers": "PIT", "san francisco 49ers": "SF",
    "seattle seahawks": "SEA", "tampa bay buccaneers": "TB", "tennessee titans": "TEN", "washington commanders": "WAS",
}


def norm_name(n: str | None) -> str:
    """'Pitts, Kyle' / 'Kyle Pitts Jr.' -> 'kyle pitts'."""
    n = (n or "").strip()
    if "," in n:
        last, first = n.split(",", 1)
        n = f"{first} {last}"
    n = re.sub(r"[^a-z ]", "", n.lower().replace("-", " "))
    return " ".join(w for w in n.split() if w not in {"jr", "sr", "ii", "iii", "iv", "v"})


def _abbr(name: str) -> str | None:
    return NFL_ABBR.get(re.sub(r"\s+", " ", (name or "").lower()).strip())


def match_games(fixtures: list[dict], games: pd.DataFrame) -> dict:
    """OddsPapi fixture id -> nflverse game row (dict)."""
    out = {}
    g = games.copy()
    g["day"] = pd.to_datetime(g["gameday"])
    for fx in fixtures:
        h, a = _abbr(fx["home"]), _abbr(fx["away"])
        if not h or not a:
            continue
        ko = pd.Timestamp(fx["kickoff"]).tz_localize(None)
        near = (g["day"] - ko.normalize()).abs() <= pd.Timedelta(days=1)
        cand, flip = g[(g["home_team"] == h) & (g["away_team"] == a) & near], False
        if cand.empty:  # neutral-site games can list either side as home
            cand, flip = g[(g["home_team"] == a) & (g["away_team"] == h) & near], True
        if not cand.empty:
            out[fx["id"]] = dict(cand.iloc[0].to_dict(), flip=flip)
    return out


def _centre_from_line(table, stat, line, p_target):
    """The expected value whose modelled P(over line) equals the market's fair chance."""
    lo, hi = 1.0, 4 * max(line, 25.0)
    if p_over(table, stat, hi, line) is None:
        return None
    for _ in range(40):
        mid = (lo + hi) / 2
        p = p_over(table, stat, mid, line)
        if p is None:
            lo = mid
            continue
        if p < p_target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _p(table, stat, mu, line):
    p = p_over(table, stat, mu, line)
    return None if p is None else 0.5 + CAL_SHRINK * (p - 0.5)


def build(index: dict, fixtures: dict, settings: dict, now: datetime, offline: bool = False):
    """Returns (legs, projections, fixture_map) for the NFL fixtures in `fixtures`."""
    nfl = [fx for fx in fixtures.values() if fx.get("league_id") == 31]
    if not nfl:
        return [], [], {}
    table = json.loads((MODEL_DIR / "ratios.json").read_text())
    P = Params()
    P.vol_coef = json.loads((MODEL_DIR / "params.json").read_text())["vol_coef"]
    season = now.year if now.month >= 3 else now.year - 1
    data = load([season - 1, season], current=season, offline=offline)
    prep = prepare(data)
    gmap = match_games(nfl, prep["games"])
    if not gmap:
        return [], [], {}
    week = int(pd.Series([g["week"] for g in gmap.values()]).mode()[0])
    games = pd.DataFrame([{"game_id": g["game_id"], "home_team": g["home_team"], "away_team": g["away_team"],
                           "spread_line": g.get("spread_line"), "total_line": g.get("total_line")} for g in gmap.values()]).drop_duplicates("game_id")

    inj = data.get("injuries", pd.DataFrame())
    out_ids = set()
    if not inj.empty:
        cur = inj[(inj["season"] == season) & (inj["week"] == week)]
        out_ids = set(cur[cur["report_status"].isin(["Out", "Doubtful"])]["gsis_id"])
    players, T = project_week(prep, season, week, P, games=games, out_ids=out_ids)
    fid_of_game = {g["game_id"]: fid for fid, g in gmap.items()}
    players["fid"] = players["game_id"].map(fid_of_game)

    legs, projections = [], []
    cfg = settings["legs"]
    for fid, fx in ((f["id"], f) for f in nfl if f["id"] in gmap):
        props = (index.get(fid) or {}).get("props") or {}
        roster = players[players["fid"] == fid]
        by_name = {norm_name(r["name"]): r for _, r in roster.iterrows()}
        # offers[(player_id, stat)][line][book] = {"over": p, "under": p}
        offers: dict = {}
        for book, rows in props.items():
            for r in rows:
                pl = by_name.get(norm_name(r["name"]))
                if pl is None:
                    continue
                offers.setdefault((pl["player_id"], r["stat"]), {}).setdefault(r["line"], {})[book] = r
        for _, pl in roster.iterrows():
            for stat in ("rec_yds", "rush_yds", "pass_yds"):
                mu_model = float(pl[f"proj_{stat}"])
                if mu_model < 8:
                    continue
                off = offers.get((pl["player_id"], stat), {})
                mu, source, anchor = _anchor(table, stat, mu_model, off)
                if mu is None:
                    continue
                q = quantiles(table, stat, mu) or [None, mu, None]
                why = _why(pl, stat)
                projections.append({"fixture_id": fid, "player": pl["name"], "team": pl["team"], "pos": pl["pos"],
                                    "stat": stat, "model": round(mu_model, 1), "expected": round(mu, 1),
                                    "range": [round(q[0], 0) if q[0] is not None else None, round(q[2], 0) if q[2] is not None else None],
                                    "median": round(q[1], 1), "source": source, "anchor": anchor, "why": why})
                if source == "skip":
                    continue
                legs.extend(_legs_for(fid, fx, pl, stat, mu, source, off, table, cfg, why, mu_model))
    fmap = {fid: {"game_id": g["game_id"], "season": int(g["season"]), "week": int(g["week"]), "flip": bool(g["flip"])} for fid, g in gmap.items()}
    return legs, projections, fmap


def _anchor(table, stat, mu_model, off):
    """Centre of the distribution after listening to the market's main line."""
    pin, cons = [], []
    for line, books in off.items():
        if "pinnacle" in books and "over" in books["pinnacle"] and "under" in books["pinnacle"]:
            f = fair_probs([books["pinnacle"]["over"], books["pinnacle"]["under"]], "power")
            if f:
                pin.append((line, f[0]))
        for b, r in books.items():
            if b != "pinnacle" and "over" in r and "under" in r:
                f = fair_probs([r["over"], r["under"]], "power")
                if f and 0.3 <= f[0] <= 0.7:  # main lines only: alt lines are one-sided and skewed
                    cons.append((line, f[0]))
    if pin:
        w, pts, source = W_SHARP, pin, "sharp+model"
    elif cons:
        w, pts, source = W_CONS, cons, "market+model"
    else:
        return mu_model, "model", None
    centres = [c for c in (_centre_from_line(table, stat, L, p) for L, p in pts) if c]
    if not centres:
        return mu_model, "model", None
    mu_mkt = float(np.median(centres))
    if abs(mu_mkt - mu_model) / max(mu_mkt, 1) > MAX_GAP:
        return mu_mkt, "skip", round(mu_mkt, 1)
    return w * mu_mkt + (1 - w) * mu_model, source, round(mu_mkt, 1)


def _why(pl, stat) -> str:
    opp = {"rec_yds": pl["opp_rec"], "rush_yds": pl["opp_rush"], "pass_yds": pl["opp_pass"]}[stat]
    vs = f"{pl['opp']} allow {abs(opp - 1) * 100:.0f}% {'more' if opp >= 1 else 'less'} than average"
    vs += " · home" if pl.get("home") == 1 else " · away"
    form = pl.get(f"mom_{stat}", 1.0)
    if abs(form - 1) >= 0.05:
        vs += f" · {'hot' if form > 1 else 'cold'} last 3 ({(form - 1) * 100:+.0f}%)"
    if pl.get("qb_factor", 1.0) < 0.97:
        vs += " · backup QB"
    if stat == "rec_yds":
        return f"{pl['tgt_share'] * 100:.0f}% of targets · ~{pl['proj_targets_p']:.1f} targets · {vs}"
    if stat == "rush_yds":
        return f"{pl['car_share'] * 100:.0f}% of carries · ~{pl['proj_carries_p']:.1f} carries · {vs}"
    return f"{pl['ypa']:.1f} yds per attempt · {vs}"


def _legs_for(fid, fx, pl, stat, mu, source, off, table, cfg, why, mu_model):
    out = []
    surname = pl["name"].split(" ", 1)[-1] if " " in pl["name"] else pl["name"]
    for line, books in off.items():
        p_ov = _p(table, stat, mu, line)
        if p_ov is None:
            continue
        for side, p in (("over", p_ov), ("under", 1 - p_ov)):
            prices = {b: round(r[side], 3) for b, r in books.items() if side in r and b != "pinnacle"}
            if not prices or p < cfg["min_fair_prob"]:
                continue
            best_book = max(prices, key=prices.get)
            best = prices[best_book]
            if not (cfg["min_price"] <= best <= cfg["max_price"]):
                continue
            key = f"nfl-prop:{stat}:{pl['player_id']}:{line:g}:{side}"
            label = (f"{pl['name']} {int(line + 0.5)}+ {LABEL[stat]}" if side == "over"
                     else f"{pl['name']} under {line:g} {LABEL[stat]}")
            edges = {b: round(pr * p - 1, 4) for b, pr in prices.items()}
            pin = books.get("pinnacle", {}).get(side)
            out.append({
                "id": f"{fid}|{key}", "fixture_id": fid, "key": key, "label": label,
                "short": (f"{surname} {int(line + 0.5)}+ {SHORT[stat]}" if side == "over" else f"{surname} u{line:g} {SHORT[stat]}"),
                "market": "Player yards", "p_win": round(p, 4), "p_void": 0.0,
                "fair_price": round(1 / p, 3), "source": source, "sharp_price": round(pin, 3) if pin else None,
                "prices": prices, "edges": edges, "best_book": best_book, "best_price": best, "best_edge": edges[best_book],
                "model_p": round(_p(table, stat, mu_model, line) or 0, 4), "why": why, "player": pl["name"],
            })
    return out


# ---------- settlement (nflverse publishes final scores and player stats the next morning) ----------
def results_and_props(fixture_map: dict, offline: bool = False):
    """({fid: (home pts, away pts)}, {fid|nfl-prop:stat:player_id: value or None for did-not-play})."""
    if not fixture_map:
        return {}, {}
    seasons = sorted({v["season"] for v in fixture_map.values()})
    data = load(seasons, current=max(seasons), offline=offline)
    g = data["games"].set_index("game_id")
    p = data["players"]
    scores, values = {}, {}
    col = {"rec_yds": "receiving_yards", "rush_yds": "rushing_yards", "pass_yds": "passing_yards"}
    for fid, m in fixture_map.items():
        if m["game_id"] not in g.index:
            continue
        row = g.loc[m["game_id"]]
        if pd.isna(row.get("home_score")):
            continue
        hs, as_ = int(row["home_score"]), int(row["away_score"])
        scores[fid] = (as_, hs) if m.get("flip") else (hs, as_)  # in the odds feed's home/away order
        played = p[p["game_id"] == m["game_id"]].set_index("player_id")
        for pid, r in played.iterrows():
            for stat, c in col.items():
                values[f"{fid}|nfl-prop:{stat}:{pid}"] = float(r[c]) if pd.notna(r[c]) else 0.0
    return scores, values
