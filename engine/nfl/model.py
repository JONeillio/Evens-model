"""NFL player and team projections, built from stats only (no odds).

Every player stat is split the same way:

    expected stat = team volume x player share x efficiency x opponent factor

  team volume  team pass attempts / carries this game: the team's own recent rate, what the
               opponent's defence usually faces, and game script (favourites run, underdogs throw),
               from a small regression fitted on past seasons.
  share        target share, carry share, QB share of attempts: recent games weighted more.
  efficiency   yards per target / carry / attempt, shrunk to the position average when the
               sample is small.
  opponent     what this defence allows to that position (yards per target to WRs, TEs, RBs;
               yards per carry; yards per attempt), shrunk to league average.

The spread of outcomes around the expected value comes from an empirical table of
actual / expected ratios measured in a walk-forward backtest, so P(over a line) is calibrated
on real misses, not a textbook distribution.

Team points (for spread and total) use recent points scored and allowed, adjusted for
opponent and home field.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

POS_GROUP = {"WR": "WR", "TE": "TE", "RB": "RB", "FB": "RB", "QB": "QB"}


@dataclass
class Params:
    hl_team: float = 6.0        # half-life in games for team volume and defence
    hl_share: float = 3.0       # player roles change fast
    hl_eff: float = 8.0         # efficiency is noisy: longer memory
    prior_season_weight: float = 0.5
    k_ypt: float = 30.0         # targets of evidence before trusting a player's yards/target
    k_ypc: float = 50.0
    k_ypa: float = 150.0
    k_def_rec: float = 90.0     # targets faced before trusting a defence's yards/target allowed
    k_def_rush: float = 150.0
    k_def_pass: float = 250.0
    k_share: float = 1.0        # games of evidence for a share (shrinks rookies/new roles towards 0)
    # How hard the opponent's defence counts (1 = as measured, 1.5 = 50% stronger), per stat.
    opp_power: dict = field(default_factory=lambda: {"rec_yds": 0.75, "rush_yds": 1.0, "pass_yds": 0.75})
    # Momentum: weight on last-3-games form vs his longer baseline (0 = off), per stat.
    mom_gamma: dict = field(default_factory=lambda: {"rec_yds": 0.0, "rush_yds": 0.25, "pass_yds": 0.0})
    hl_def: float = 3.0         # half-life (games) for defences: shorter = recent defensive form counts more
    mom_k: dict = field(default_factory=lambda: {"rec_yds": 15.0, "rush_yds": 15.0, "pass_yds": 60.0})
    home_mult: dict = field(default_factory=lambda: {"rec_yds": 1.01, "rush_yds": 1.0, "pass_yds": 1.03})
    home_points: float = 1.2
    pts_shrink: float = 0.55    # how much of a team's above/below-average points to believe
    vol_coef: dict = field(default_factory=dict)  # fitted volume regressions


def _tkey(df):
    return df["season"] * 100 + df["week"]


def _weights(df: pd.DataFrame, key, hl: float, season: int, pw: float) -> pd.Series:
    """Exponential recency weight by game order within key (most recent = 1)."""
    order = df.sort_values("t", ascending=False)
    r = order.groupby(key, sort=False).cumcount()
    w = 0.5 ** (r / hl) * np.where(order["season"] < season, pw, 1.0)
    return pd.Series(w, index=order.index).reindex(df.index)


def prepare(data: dict) -> dict:
    """Tidy the raw nflverse frames once."""
    p = data["players"].copy()
    p = p[p["season_type"].isin(["REG", "POST"])]
    p["t"] = _tkey(p)
    p["pos"] = p["position"].map(POS_GROUP)
    for c in ("targets", "receptions", "receiving_yards", "carries", "rushing_yards", "attempts", "completions", "passing_yards"):
        p[c] = p[c].fillna(0)
    tm = data["teams"].copy()
    tm = tm[tm["season_type"].isin(["REG", "POST"])]
    tm["t"] = _tkey(tm)
    g = data["games"].copy()
    g["t"] = _tkey(g)
    # Team points per game from the schedule.
    sides = []
    for side, opp in (("home", "away"), ("away", "home")):
        x = g[["game_id", "season", "week", "t", f"{side}_team", f"{opp}_team", f"{side}_score", f"{opp}_score"]].copy()
        x.columns = ["game_id", "season", "week", "t", "team", "opp", "pf", "pa"]
        x["home"] = 1 if side == "home" else 0
        sides.append(x)
    pts = pd.concat(sides, ignore_index=True)
    tm = tm.merge(pts[["game_id", "team", "pf", "pa", "home"]], on=["game_id", "team"], how="left")
    # Team totals joined to each player-game, for shares.
    p = p.merge(tm[["game_id", "team", "attempts", "carries", "targets"]].rename(
        columns={"attempts": "team_att", "carries": "team_car", "targets": "team_tgt"}), on=["game_id", "team"], how="left")
    return {"players": p, "teams": tm, "games": g, "points": pts}


# ---------- building blocks ----------
def _team_tables(tm: pd.DataFrame, season: int, P: Params):
    h = tm.copy()
    h["w"] = _weights(h, "team", P.hl_team, season, P.prior_season_weight)
    h["w_def"] = _weights(h, "opponent_team", P.hl_team, season, P.prior_season_weight)

    def wavg(df, key, w, cols):
        g = df.assign(**{c: df[c] * df[w] for c in cols}).groupby(key)
        s = g[cols].sum()
        return s.div(g[w].sum(), axis=0)

    off = wavg(h, "team", "w", ["attempts", "carries", "targets", "pf", "pa"])
    # What each defence faces: the opponents' offensive numbers in games against it.
    dfn = wavg(h, "opponent_team", "w_def", ["attempts", "carries", "pf"])
    dfn.columns = ["att_faced", "car_faced", "pts_allowed"]
    recent = h[h["season"] == h["season"].max()]
    league = {"attempts": recent["attempts"].mean(), "carries": recent["carries"].mean(),
              "targets": recent["targets"].mean(), "pf": recent["pf"].mean()}
    return off, dfn, league


def _defence_by_pos(p: pd.DataFrame, season: int, P: Params):
    """Yards per target allowed to each position, yards per carry and per pass attempt allowed."""
    h = p.copy()
    h["w"] = _weights(h.drop_duplicates(["game_id", "team"]).pipe(lambda d: d), "opponent_team", P.hl_team, season, P.prior_season_weight)
    # weight per defence-game, then broadcast to its player rows
    dg = p.drop_duplicates(["game_id", "opponent_team"])[["game_id", "opponent_team", "t", "season"]].copy()
    dg["w"] = _weights(dg, "opponent_team", P.hl_def, season, P.prior_season_weight)
    h = p.merge(dg[["game_id", "opponent_team", "w"]], on=["game_id", "opponent_team"], how="left")

    rec = h[h["pos"].isin(["WR", "TE", "RB"])]
    g = rec.assign(y=rec["receiving_yards"] * rec["w"], n=rec["targets"] * rec["w"]).groupby(["opponent_team", "pos"])[["y", "n"]].sum()
    lg = rec.groupby("pos").apply(lambda d: d["receiving_yards"].sum() / max(d["targets"].sum(), 1))
    rec_f = ((g["y"] + P.k_def_rec * g.index.get_level_values("pos").map(lg).values) / (g["n"] + P.k_def_rec)) \
        / g.index.get_level_values("pos").map(lg).values

    ru = h.assign(y=h["rushing_yards"] * h["w"], n=h["carries"] * h["w"]).groupby("opponent_team")[["y", "n"]].sum()
    lg_ypc = h["rushing_yards"].sum() / max(h["carries"].sum(), 1)
    rush_f = ((ru["y"] + P.k_def_rush * lg_ypc) / (ru["n"] + P.k_def_rush)) / lg_ypc

    qb = h[h["pos"] == "QB"]
    pa = qb.assign(y=qb["passing_yards"] * qb["w"], n=qb["attempts"] * qb["w"]).groupby("opponent_team")[["y", "n"]].sum()
    lg_ypa = qb["passing_yards"].sum() / max(qb["attempts"].sum(), 1)
    pass_f = ((pa["y"] + P.k_def_pass * lg_ypa) / (pa["n"] + P.k_def_pass)) / lg_ypa
    return rec_f, rush_f, pass_f, lg, lg_ypc, lg_ypa


def _player_tables(p: pd.DataFrame, season: int, P: Params, lg_ypt, lg_ypc, lg_ypa):
    h = p.copy()
    h["ws"] = _weights(h, "player_id", P.hl_share, season, P.prior_season_weight)
    h["we"] = _weights(h, "player_id", P.hl_eff, season, P.prior_season_weight)
    agg = h.assign(
        tgt=h["targets"] * h["ws"], tt=h["team_tgt"] * h["ws"],
        car=h["carries"] * h["ws"], tc=h["team_car"] * h["ws"],
        att=h["attempts"] * h["ws"], ta=h["team_att"] * h["ws"],
        ry=h["receiving_yards"] * h["we"], rt=h["targets"] * h["we"],
        uy=h["rushing_yards"] * h["we"], uc=h["carries"] * h["we"],
        py=h["passing_yards"] * h["we"], pa=h["attempts"] * h["we"],
    ).groupby("player_id").agg(
        name=("player_display_name", "last"), pos=("pos", "last"), team=("team", lambda s: s.iloc[-1]),
        tgt=("tgt", "sum"), tt=("tt", "sum"), car=("car", "sum"), tc=("tc", "sum"), att=("att", "sum"), ta=("ta", "sum"),
        ws=("ws", "sum"), ry=("ry", "sum"), rt=("rt", "sum"), uy=("uy", "sum"), uc=("uc", "sum"), py=("py", "sum"), pa=("pa", "sum"),
        last_t=("t", "max"), games=("t", "count"),
    )
    # Shrink shares only for players with few games (rookies, new roles), not everyone.
    shrink_share = agg["games"] / (agg["games"] + P.k_share)
    last3 = h.sort_values("t").groupby("player_id").tail(3).groupby("player_id")[["receiving_yards", "rushing_yards", "passing_yards"]].mean()
    long = h.assign(a=h["receiving_yards"] * h["we"], b=h["rushing_yards"] * h["we"], c=h["passing_yards"] * h["we"]).groupby("player_id")[["a", "b", "c", "we"]].sum()
    for stat, col, lc in (("rec_yds", "receiving_yards", "a"), ("rush_yds", "rushing_yards", "b"), ("pass_yds", "passing_yards", "c")):
        k = P.mom_k[stat]
        base = long[lc] / long["we"].replace(0, np.nan)
        agg[f"mom_{stat}"] = (((last3[col] + k) / (base + k)) ** P.mom_gamma[stat]).reindex(agg.index).fillna(1.0).clip(0.6, 1.6)
    agg["tgt_share"] = (agg["tgt"] / agg["tt"].replace(0, np.nan)).fillna(0) * shrink_share
    agg["car_share"] = (agg["car"] / agg["tc"].replace(0, np.nan)).fillna(0) * shrink_share
    agg["att_share"] = (agg["att"] / agg["ta"].replace(0, np.nan)).fillna(0)
    prior_ypt = agg["pos"].map(lg_ypt).fillna(7.0)
    agg["ypt"] = (agg["ry"] + P.k_ypt * prior_ypt) / (agg["rt"] + P.k_ypt)
    prior_ypc = np.where(agg["pos"] == "QB", lg_ypc * 1.15, lg_ypc)
    agg["ypc"] = (agg["uy"] + P.k_ypc * prior_ypc) / (agg["uc"] + P.k_ypc)
    agg["ypa"] = (agg["py"] + P.k_ypa * lg_ypa) / (agg["pa"] + P.k_ypa)
    return agg


def fit_volume(prep: dict, seasons: list[int], P: Params) -> dict:
    """Fit attempts and carries on [team rate, defence faced, expected margin, team total]
    using walk-forward features from the given seasons (weeks 3+)."""
    tm, g = prep["teams"], prep["games"]
    rows = []
    for s in seasons:
        for w in range(3, 23):
            hist = tm[tm["t"] < s * 100 + w]
            tgt = tm[(tm["season"] == s) & (tm["week"] == w)]
            if tgt.empty or hist.empty:
                continue
            off, dfn, league = _team_tables(hist, s, P)
            x = tgt.merge(off, left_on="team", right_index=True, suffixes=("", "_avg")) \
                   .merge(dfn, left_on="opponent_team", right_index=True)
            x = _attach_lines(x, g)
            rows.append(x)
    X = pd.concat(rows, ignore_index=True).dropna(subset=["margin", "team_total"])
    coef = {}
    for y, own, faced in (("attempts", "attempts_avg", "att_faced"), ("carries", "carries_avg", "car_faced")):
        A = np.column_stack([np.ones(len(X)), X[own], X[faced], X["margin"], X["team_total"]])
        b, *_ = np.linalg.lstsq(A, X[y].values, rcond=None)
        coef[y] = b.tolist()
    return coef


def _attach_lines(x: pd.DataFrame, g: pd.DataFrame) -> pd.DataFrame:
    """Expected margin and team total for each team-game from the closing (or current) line.
    nflverse spread_line is from the home side: positive = home favoured."""
    gg = g[["game_id", "home_team", "spread_line", "total_line"]]
    x = x.merge(gg, on="game_id", how="left")
    home = x["team"] == x["home_team"]
    x["margin"] = np.where(home, x["spread_line"], -x["spread_line"])
    x["team_total"] = x["total_line"] / 2 + x["margin"] / 2
    return x.drop(columns=["home_team"])


def project_week(prep: dict, season: int, week: int, P: Params, games: pd.DataFrame | None = None,
                 lines: pd.DataFrame | None = None, out_ids=frozenset()) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Projections for every player likely to play in (season, week), using only earlier games.

    games: the fixtures to project (game_id, home_team, away_team); defaults to the schedule.
    lines: optional override of spread_line/total_line per game_id (e.g. Pinnacle's, live).
    Returns (players, teams)."""
    t0 = season * 100 + week
    p_hist = prep["players"][prep["players"]["t"] < t0]
    tm_hist = prep["teams"][prep["teams"]["t"] < t0]
    sched = prep["games"]
    fx = games if games is not None else sched[(sched["season"] == season) & (sched["week"] == week)]
    fx = fx[["game_id", "home_team", "away_team", "spread_line", "total_line"]].copy()
    if lines is not None:
        fx = fx.drop(columns=["spread_line", "total_line"]).merge(lines, on="game_id", how="left")

    off, dfn, league = _team_tables(tm_hist, season, P)
    rec_f, rush_f, pass_f, lg_ypt, lg_ypc, lg_ypa = _defence_by_pos(p_hist, season, P)
    pl = _player_tables(p_hist, season, P, lg_ypt, lg_ypc, lg_ypa)

    # ---- team side ----
    teams = []
    for _, r in fx.iterrows():
        for team, opp, home in ((r.home_team, r.away_team, 1), (r.away_team, r.home_team, 0)):
            teams.append({"game_id": r.game_id, "team": team, "opp": opp, "home": home,
                          "margin": (r.spread_line if home else -r.spread_line) if pd.notna(r.spread_line) else np.nan,
                          "total_line": r.total_line})
    T = pd.DataFrame(teams)
    T = T.merge(off, left_on="team", right_index=True, how="left").merge(dfn, left_on="opp", right_index=True, how="left")
    T["team_total"] = T["total_line"] / 2 + T["margin"] / 2
    # Points model (independent of the line): own scoring vs opponent's points allowed.
    lp = league["pf"]
    T["pts_model"] = lp + P.pts_shrink * ((T["pf"] - lp) + (T["pts_allowed"] - lp)) + np.where(T["home"] == 1, P.home_points / 2, -P.home_points / 2)
    # Volume: fitted regression (falls back to the team's own rate if no line).
    for y, own, faced in (("attempts", "attempts", "att_faced"), ("carries", "carries", "car_faced")):
        b = P.vol_coef.get(y)
        if b:
            m = T["margin"].fillna(0)
            tt = T["team_total"].fillna(T["pts_model"])
            T[f"proj_{y}"] = b[0] + b[1] * T[own] + b[2] * T[faced] + b[3] * m + b[4] * tt
        else:
            T[f"proj_{y}"] = (T[own] + T[faced]) / 2
    T["proj_targets"] = T["proj_attempts"] * (league["targets"] / league["attempts"])

    # ---- player side: who's in each team's recent rotation ----
    recent_cut = sorted(tm_hist["t"].unique())[-6:] if len(tm_hist) else []
    in_rotation = pl["last_t"].isin(recent_cut)
    # QBs who've played for the team this season stay available (a backup who last played
    # in week 2 can still start in week 9).
    this_season_qb = (pl["pos"] == "QB") & (pl["last_t"] >= season * 100)
    active = pl[(in_rotation | this_season_qb) & pl["team"].isin(T["team"])].reset_index()
    active["recent"] = active["last_t"].isin(recent_cut)
    # Each team's usual starter (before injuries), to spot a backup taking over.
    usual_qb = active[(active["pos"] == "QB") & active["last_t"].isin(recent_cut)].sort_values(
        ["team", "att_share", "last_t"], ascending=[True, False, False]).groupby("team").head(1).set_index("team")["ypa"]
    if out_ids:
        # Injured players' targets and carries go to teammates (70% of it: the rest is spread
        # thinly across depth players we don't project).
        gone = active[active["player_id"].isin(out_ids)]
        active = active[~active["player_id"].isin(out_ids)].copy()
        for col in ("tgt_share", "car_share"):
            vac = gone.groupby("team")[col].sum()
            rem = active.groupby("team")[col].transform("sum").replace(0, np.nan)
            active[col] = active[col] * (1 + 0.7 * active["team"].map(vac).fillna(0) / rem).fillna(1)
    active = active.merge(T[["game_id", "team", "opp", "home", "proj_attempts", "proj_carries", "proj_targets"]], left_on="team", right_on="team")
    active["opp_rec"] = [rec_f.get((o, pz), 1.0) for o, pz in zip(active["opp"], active["pos"])]
    active["opp_rush"] = active["opp"].map(rush_f).fillna(1.0)
    active["opp_pass"] = active["opp"].map(pass_f).fillna(1.0)
    hm = {st: np.where(active["home"] == 1, P.home_mult[st], 1 / P.home_mult[st]) for st in P.home_mult}
    active["proj_rec_yds"] = (active["proj_targets"] * active["tgt_share"] * active["ypt"] * active["opp_rec"] ** P.opp_power["rec_yds"]
                              * active["mom_rec_yds"] * hm["rec_yds"])
    active["proj_rush_yds"] = (active["proj_carries"] * active["car_share"] * active["ypc"] * active["opp_rush"] ** P.opp_power["rush_yds"]
                               * active["mom_rush_yds"] * hm["rush_yds"])
    # Pass yards: only the team's most likely starter (highest recent share of attempts).
    # Recent QBs first; one who last played weeks ago only if the team has no recent QB available.
    qb = active[active["pos"] == "QB"].sort_values(["team", "recent", "att_share", "last_t"], ascending=[True, False, False, False])
    first = qb.groupby("team").head(1)
    starters = set(first["player_id"])
    # Backup starting: receivers lose yards in line with the drop in yards per attempt.
    qb_factor = (first.set_index("team")["ypa"] / usual_qb.reindex(first["team"]).values).clip(0.75, 1.0).fillna(1.0)
    active["qb_factor"] = active["team"].map(qb_factor).fillna(1.0)
    active["proj_rec_yds"] = active["proj_rec_yds"] * active["qb_factor"]
    # A backup stepping in gets the starter's workload, not his own small share.
    active.loc[active["player_id"].isin(starters), "att_share"] = active.loc[active["player_id"].isin(starters), "att_share"].clip(lower=0.95)
    active["proj_pass_yds"] = np.where(active["player_id"].isin(starters),
                                       active["proj_attempts"] * active["att_share"].clip(upper=1.0) * active["ypa"] * active["opp_pass"] ** P.opp_power["pass_yds"]
                                       * active["mom_pass_yds"] * hm["pass_yds"], 0.0)
    active["proj_targets_p"] = active["proj_targets"] * active["tgt_share"]
    active["proj_carries_p"] = active["proj_carries"] * active["car_share"]
    keep = ["game_id", "team", "opp", "home", "name", "pos", "qb_factor", "mom_rec_yds", "mom_rush_yds", "mom_pass_yds", "tgt_share", "car_share", "att_share", "ypt", "ypc", "ypa",
            "opp_rec", "opp_rush", "opp_pass", "proj_targets_p", "proj_carries_p", "proj_rec_yds", "proj_rush_yds", "proj_pass_yds"]
    players = active[["player_id"] + keep]
    return players, T


# ---------- distributions ----------
STATS = {"rec_yds": "receiving_yards", "rush_yds": "rushing_yards", "pass_yds": "passing_yards"}
BUCKETS = {"rec_yds": [0, 15, 30, 50, 75, 1e9], "rush_yds": [0, 15, 30, 50, 75, 1e9], "pass_yds": [0, 175, 215, 250, 1e9]}


def ratio_table(bt: pd.DataFrame) -> dict:
    """Empirical actual/expected ratios per stat and projection bucket (from a backtest)."""
    out = {}
    for s, col in STATS.items():
        d = bt[(bt[f"proj_{s}"] > 3) & bt[col].notna()]
        edges = BUCKETS[s]
        out[s] = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            x = d[(d[f"proj_{s}"] >= lo) & (d[f"proj_{s}"] < hi)]
            out[s].append({"lo": lo, "hi": hi, "z": np.sort((x[col] / x[f"proj_{s}"]).values).round(4).tolist()})
    return out


def _bucket(table: dict, stat: str, mu: float):
    """The miss pattern for this size of projection; if that band is thin (big projections are
    rare), the nearest band with enough games."""
    bands = table[stat]
    i = next((k for k, b in enumerate(bands) if b["lo"] <= mu < b["hi"]), len(bands) - 1)
    for j in sorted(range(len(bands)), key=lambda k: abs(k - i)):
        if len(bands[j]["z"]) >= 40:
            return np.asarray(bands[j]["z"])
    return None


def p_over(table: dict, stat: str, mu: float, line: float) -> float | None:
    if mu is None or not np.isfinite(mu) or mu <= 3:
        return None
    z = _bucket(table, stat, mu)
    return None if z is None else float((z * mu > line).mean())


def quantiles(table: dict, stat: str, mu: float, qs=(0.1, 0.5, 0.9)):
    z = _bucket(table, stat, mu) if mu and mu > 3 else None
    return None if z is None else [float(np.quantile(z, q) * mu) for q in qs]
