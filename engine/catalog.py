"""Which OddsPapi markets we use, how to label them, and how each leg settles.

Leg keys are short strings shared by the engine, the app and the history file:
  1x2:1  1x2:X  1x2:2          match result
  dc:1X  dc:12  dc:2X          double chance
  dnb:1  dnb:2                 draw no bet (void on a draw)
  ou:1.5:over  ou:3.5:under    total goals
  tt:1:0.5:over                team total goals (team 1 = home)
  ts:1:yes                     team to score
  btts:no                      both teams to score
  ah:2:+1.5                    Asian handicap +1.5 for a team
Market and outcome IDs come from data/ref/markets_10.json (OddsPapi soccer).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LegDef:
    key: str
    family: str          # settings name used to switch market types on/off
    market_id: str       # OddsPapi market whose prices we read
    outcome_id: str
    siblings: tuple      # every outcome id in that market (for removing the margin)


def _defs() -> list[LegDef]:
    d: list[LegDef] = []

    def add(key, family, market, outcome, siblings):
        d.append(LegDef(key, family, str(market), str(outcome), tuple(str(s) for s in siblings)))

    # Match result
    for sel, oid in (("1", 101), ("X", 102), ("2", 103)):
        add(f"1x2:{sel}", "win", 101, oid, (101, 102, 103))
    # Double chance
    for sel, oid in (("1X", 101902), ("12", 101903), ("2X", 101904)):
        add(f"dc:{sel}", "double_chance", 101902, oid, (101902, 101903, 101904))
    # Draw no bet
    for sel, oid in (("1", 10214), ("2", 10215)):
        add(f"dnb:{sel}", "draw_no_bet", 10214, oid, (10214, 10215))
    # Total goals: market id -> (over outcome, under outcome)
    totals = {0.5: (106, 107), 1.5: (108, 109), 2.5: (1010, 1011), 3.5: (1012, 1013), 4.5: (1014, 1015)}
    for line, (o, u) in totals.items():
        add(f"ou:{line}:over", f"over_{str(line).replace('.', '_')}", o, o, (o, u))
        add(f"ou:{line}:under", f"under_{str(line).replace('.', '_')}", o, u, (o, u))
    # Team totals 0.5 and 1.5
    team_totals = {
        (1, 0.5): (10224, 10225), (1, 1.5): (10226, 10227),
        (2, 0.5): (10240, 10241), (2, 1.5): (10242, 10243),
    }
    for (team, line), (o, u) in team_totals.items():
        fam = "team_over_0_5" if line == 0.5 else "team_over_1_5"
        add(f"tt:{team}:{line}:over", fam, o, o, (o, u))
    # Team to score
    add("ts:1:yes", "team_to_score", 10284, 10284, (10284, 10285))
    add("ts:2:yes", "team_to_score", 10286, 10286, (10286, 10287))
    # Both teams to score
    add("btts:yes", "btts_yes", 104, 104, (104, 105))
    add("btts:no", "btts_no", 104, 105, (104, 105))
    # Asian handicap +1.5 (market 1084 = home +1.5; market 1060 = home -1.5, so its outcome 2 = away +1.5)
    add("ah:1:+1.5", "ah_plus_1_5", 1084, 1084, (1084, 1085))
    add("ah:2:+1.5", "ah_plus_1_5", 1060, 1061, (1060, 1061))
    return d


LEG_DEFS = _defs()
LEGS_BY_KEY = {d.key: d for d in LEG_DEFS}
MARKET_IDS = sorted({d.market_id for d in LEG_DEFS})

# Two different markets that settle identically: let one stand in for the other.
EQUIVALENT = {"ts:1:yes": "tt:1:0.5:over", "tt:1:0.5:over": "ts:1:yes",
              "ts:2:yes": "tt:2:0.5:over", "tt:2:0.5:over": "ts:2:yes"}


def label(key: str, home: str, away: str) -> str:
    parts = key.split(":")
    kind = parts[0]
    team = {"1": home, "2": away}
    if kind == "1x2":
        return "Draw" if parts[1] == "X" else f"{team[parts[1]]} to win"
    if kind == "dc":
        return {"1X": f"{home} or draw", "2X": f"{away} or draw", "12": "Either team to win"}[parts[1]]
    if kind == "dnb":
        return f"{team[parts[1]]} (draw no bet)"
    if kind == "ou":
        return f"{parts[2].title()} {parts[1]} goals"
    if kind == "tt":
        return f"{team[parts[1]]} over {parts[2]} goals"
    if kind == "ts":
        return f"{team[parts[1]]} to score"
    if kind == "btts":
        return "Both teams to score" if parts[1] == "yes" else "Not both teams to score"
    if kind == "ah":
        return f"{team[parts[1]]} {parts[2]} (handicap)"
    return key


def short_market(key: str) -> str:
    kind = key.split(":")[0]
    return {"1x2": "Result", "dc": "Double chance", "dnb": "Draw no bet", "ou": "Goals",
            "tt": "Team goals", "ts": "Team to score", "btts": "BTTS", "ah": "Handicap"}.get(kind, kind)


def outcome(key: str, hg: int, ag: int) -> str:
    """Settle one leg from a full-time score: 'won', 'lost' or 'void'."""
    p = key.split(":")
    kind = p[0]
    goals = {"1": hg, "2": ag}
    other = {"1": ag, "2": hg}
    if kind == "1x2":
        res = "1" if hg > ag else "2" if ag > hg else "X"
        return "won" if res == p[1] else "lost"
    if kind == "dc":
        res = "1" if hg > ag else "2" if ag > hg else "X"
        return "won" if res in p[1] else "lost"
    if kind == "dnb":
        if hg == ag:
            return "void"
        return "won" if goals[p[1]] > other[p[1]] else "lost"
    if kind == "ou":
        total, line = hg + ag, float(p[1])
        over = total > line
        return "won" if (over if p[2] == "over" else not over) else "lost"
    if kind == "tt":
        return "won" if goals[p[1]] > float(p[2]) else "lost"
    if kind == "ts":
        return "won" if goals[p[1]] > 0 else "lost"
    if kind == "btts":
        both = hg > 0 and ag > 0
        return "won" if (both if p[1] == "yes" else not both) else "lost"
    if kind == "ah":
        line = float(p[2])
        margin = goals[p[1]] - other[p[1]] + line
        return "won" if margin > 0 else "lost"  # half-goal lines never push
    raise ValueError(f"unknown leg key {key}")


def prob_from_matrix(key: str, matrix) -> tuple[float, float]:
    """(p_win, p_void) for a leg, given a scoreline probability matrix M[home][away]."""
    win = void = 0.0
    n = len(matrix)
    for h in range(n):
        row = matrix[h]
        for a in range(len(row)):
            p = row[a]
            if p <= 0:
                continue
            res = outcome(key, h, a)
            if res == "won":
                win += p
            elif res == "void":
                void += p
    return win, void
