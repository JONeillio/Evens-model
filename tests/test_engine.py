import math
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from engine import builder, fair, settle
from engine.catalog import LEG_DEFS, outcome, prob_from_matrix, label
from engine.goals_model import fit
from engine.legs import build_legs, sharp_probabilities
from engine.names import best_match
from engine.parse import add_payload


# ---------- fair prices ----------
@pytest.mark.parametrize("method", ["multiplicative", "power", "shin"])
def test_devig_sums_to_one(method):
    probs = fair.fair_probs([1.30, 5.5, 11.0], method)
    assert math.isclose(sum(probs), 1.0, abs_tol=1e-9)
    assert probs[0] > probs[1] > probs[2]


def test_power_shades_longshots_more():
    prices = [1.30, 5.5, 11.0]
    mult = fair.devig_multiplicative(prices)
    power = fair.devig_power(prices)
    assert power[0] > mult[0] and power[2] < mult[2]


def test_edge():
    assert math.isclose(fair.edge(2.0, 0.5), 0.0)
    assert fair.edge(2.1, 0.5) > 0


# ---------- catalogue / settlement ----------
@pytest.mark.parametrize("key,score,expected", [
    ("1x2:1", (2, 1), "won"), ("1x2:1", (1, 1), "lost"), ("1x2:X", (0, 0), "won"),
    ("dc:1X", (1, 1), "won"), ("dc:2X", (2, 0), "lost"), ("dc:12", (0, 0), "lost"),
    ("dnb:1", (1, 1), "void"), ("dnb:2", (0, 1), "won"),
    ("ou:1.5:over", (1, 1), "won"), ("ou:1.5:over", (1, 0), "lost"), ("ou:3.5:under", (2, 1), "won"),
    ("tt:1:0.5:over", (1, 0), "won"), ("ts:2:yes", (1, 0), "lost"),
    ("btts:no", (2, 0), "won"), ("btts:no", (1, 1), "lost"),
    ("ah:2:+1.5", (2, 1), "won"), ("ah:2:+1.5", (3, 1), "lost"), ("ah:1:+1.5", (0, 1), "won"),
])
def test_outcome(key, score, expected):
    assert outcome(key, *score) == expected


def test_prob_from_matrix_consistent():
    m = np.full((3, 3), 1 / 9)
    w, v = prob_from_matrix("1x2:1", m)
    assert math.isclose(w, 3 / 9)
    w, v = prob_from_matrix("dnb:1", m)
    assert math.isclose(w, 3 / 9) and math.isclose(v, 3 / 9)


def test_labels():
    assert label("dc:1X", "Leeds", "Hull") == "Leeds or draw"
    assert label("ou:1.5:over", "A", "B") == "Over 1.5 goals"


# ---------- names ----------
@pytest.mark.parametrize("name,expected", [
    ("Manchester United", "Man United"), ("Nottingham Forest", "Nott'm Forest"),
    ("Sheffield Wednesday", "Sheffield Weds"), ("Wolverhampton Wanderers", "Wolves"),
    ("Brighton & Hove Albion", "Brighton"), ("Queens Park Rangers", "QPR"),
    ("Heart of Midlothian", "Hearts"), ("Atletico Madrid", "Ath Madrid"),
    ("Borussia Monchengladbach", "M'gladbach"), ("Paris Saint-Germain", "Paris SG"),
    ("Tottenham Hotspur", "Tottenham"), ("Ipswich Town", "Ipswich"),
])
def test_name_matching(name, expected):
    candidates = ["Man United", "Man City", "Nott'm Forest", "Sheffield Weds", "Sheffield United", "Wolves",
                  "Brighton", "QPR", "Hearts", "Hibernian", "Ath Madrid", "Ath Bilbao", "Real Madrid",
                  "M'gladbach", "Dortmund", "Paris SG", "Tottenham", "Ipswich", "Notts County"]
    assert best_match(name, candidates) == expected


def test_name_no_false_match():
    assert best_match("Real Oviedo", ["Man United", "Arsenal", "Chelsea"]) is None


# ---------- goals model ----------
def test_model_recovers_strength_order():
    rng = np.random.default_rng(1)
    teams = [f"T{i}" for i in range(10)]
    strength = np.linspace(-0.5, 0.5, 10)
    rows, start = [], datetime(2025, 8, 1)
    for d in range(6):
        for i, h in enumerate(teams):
            for j, a in enumerate(teams):
                if i == j:
                    continue
                lam = math.exp(0.1 + strength[i] - strength[j] * 0.8 + 0.25)
                mu = math.exp(0.1 + strength[j] - strength[i] * 0.8)
                rows.append({"date": pd.Timestamp(start + timedelta(days=d * 30 + i)),
                             "home": h, "away": a, "hg": rng.poisson(lam), "ag": rng.poisson(mu)})
    ratings = fit(pd.DataFrame(rows), datetime(2026, 2, 1), half_life_days=365)
    assert ratings is not None
    assert ratings.attack[ratings.index("T9")] > ratings.attack[ratings.index("T0")]
    m = ratings.score_matrix("T9", "T0")
    assert math.isclose(m.sum(), 1.0, abs_tol=1e-9)
    assert prob_from_matrix("1x2:1", m)[0] > 0.6


# ---------- parse + legs ----------
def _payload(book, prices_by_market, fid="F1", start="2026-11-07T15:00:00.000Z"):
    markets = {mid: {"marketActive": True,
                     "outcomes": {oid: {"players": {"0": {"active": True, "price": p}}} for oid, p in outs.items()}}
               for mid, outs in prices_by_market.items()}
    return [{"fixtureId": fid, "tournamentId": 17, "startTime": start, "participant1Id": 1, "participant2Id": 2,
             "statusId": 0, "bookmakerOdds": {book: {"bookmakerIsActive": True, "markets": markets}}}]


def test_legs_from_sharp_and_soft():
    idx = {}
    add_payload(idx, _payload("pinnacle", {"101": {"101": 1.40, "102": 4.8, "103": 8.0},
                                            "108": {"108": 1.25, "109": 4.0}}))
    add_payload(idx, _payload("bet365", {"101": {"101": 1.44, "102": 4.5, "103": 7.5},
                                          "101902": {"101902": 1.10, "101903": 1.25, "101904": 2.8},
                                          "108": {"108": 1.22, "109": 3.75}}))
    fx = {"id": "F1", "home": "Home FC", "away": "Away FC"}
    settings = {"devig_method": "power", "legs": {"min_price": 1.02, "max_price": 1.6, "min_fair_prob": 0.55,
                                                  "markets": ["win", "double_chance", "over_1_5"]}}
    legs = {l["key"]: l for l in build_legs(fx, idx["F1"]["books"], "pinnacle", ["bet365"], settings)}
    assert "1x2:1" in legs and legs["1x2:1"]["source"] == "sharp"
    assert legs["dc:1X"]["source"] == "sharp-derived"
    assert legs["1x2:1"]["best_edge"] > 0          # 1.44 vs fair ~1.41
    assert legs["ou:1.5:over"]["best_edge"] < 0    # 1.22 vs fair ~1.27


def test_dnb_is_unconditional():
    sharp = {"101": {"101": 1.80, "102": 3.6, "103": 4.6}, "10214": {"10214": 1.30, "10215": 3.6}}
    out = sharp_probabilities(sharp, "power")
    pw, pv, src, _ = out["dnb:1"]
    assert 0.2 < pv < 0.35 and pw + pv < 1


# ---------- builder ----------
def _leg(fid, key, price, p, ko):
    return {"id": f"{fid}|{key}", "fixture_id": fid, "key": key, "p_win": p, "p_void": 0.0,
            "prices": {"bet365": price, "skybet": price - 0.01}, "source": "sharp", "model_p": None}


def test_builder_constraints():
    ko = "2026-11-07T15:00:00Z"
    fixtures = {f"F{i}": {"id": f"F{i}", "kickoff": ko} for i in range(8)}
    fixtures["F7"]["kickoff"] = "2026-11-07T20:00:00Z"
    legs = []
    for i in range(8):
        legs.append(_leg(f"F{i}", "dc:1X", 1.16, 0.87, ko))
        legs.append(_leg(f"F{i}", "ou:0.5:over", 1.08, 0.93, ko))
    cfg = {"legs_options": [4, 5], "target_min": 1.85, "target_max": 2.3, "kickoff_spread_hours": 2.5,
           "leg_min_price": 1.04, "leg_max_price": 1.45, "leg_min_fair_prob": 0.68, "leg_min_edge": -0.05,
           "slip_min_ev": -0.2, "pool_size": 26, "top_per_window": 3}
    slips = builder.build_slips(legs, fixtures, ["bet365", "skybet"], cfg, "Europe/London")
    assert slips
    for s in slips:
        fids = [l.split("|")[0] for l in s["legs"]]
        assert len(fids) == len(set(fids))                 # one leg per match
        assert cfg["target_min"] <= s["odds"] <= cfg["target_max"]
        assert "F7" not in fids                            # 20:00 is outside the 15:00 window
        assert s["n_legs"] in (4, 5)


# ---------- budget ----------
def test_budget_allowance_and_choice():
    from engine.budget import allowance, choose
    cfg = {"reserve": 15, "max_calls_per_run": 16,
           "weekday_weights": {"Mon": 0.5, "Tue": 1, "Wed": 1, "Thu": 0.5, "Fri": 1, "Sat": 3, "Sun": 1.5}}
    sat = allowance({"remaining": 240}, datetime(2026, 11, 7, tzinfo=timezone.utc), cfg)
    mon = allowance({"remaining": 240}, datetime(2026, 11, 9, tzinfo=timezone.utc), cfg)
    assert sat["allowance"] > mon["allowance"] >= 3
    assert allowance({"remaining": 16}, datetime(2026, 11, 9, tzinfo=timezone.utc), cfg)["allowance"] <= 1
    assert choose(15, 6, ["bet365", "skybet"]) == (["bet365", "skybet"], 5)
    assert choose(4, 6, ["bet365", "skybet"]) == (["bet365"], 2)
    assert choose(1, 6, ["bet365"]) == ([], 0)


# ---------- settlement ----------
class FakeFD:
    def __init__(self, scores):
        self.scores = scores

    def find_result(self, div, home, away, kickoff):
        return self.scores.get((home, away))


def test_publish_and_settle():
    now = datetime(2026, 11, 7, 8, tzinfo=timezone.utc)
    fixtures = {f"F{i}": {"id": f"F{i}", "home": f"H{i}", "away": f"A{i}", "league": "L", "kickoff": "2026-11-07T15:00:00Z",
                          "fd": {"div": "E0", "home": f"H{i}", "away": f"A{i}"}} for i in range(4)}
    legs = {f"F{i}|1x2:1": {"id": f"F{i}|1x2:1", "fixture_id": f"F{i}", "key": "1x2:1", "label": "x",
                             "best_price": 1.2, "p_win": 0.8, "p_void": 0.0} for i in range(4)}
    slip = {"id": "s1", "start": "2026-11-07T15:00:00Z", "label": "Sat 15:00", "book": "bet365", "odds": 2.07,
            "hit_p": 0.41, "ev": -0.15, "legs": list(legs), "prices": {k: 1.2 for k in legs}}
    hist = settle.empty_history()
    settle.publish(hist, [slip], legs, fixtures, now)
    assert hist["slips"][0]["status"] == "pending"
    later = now + timedelta(days=1)
    settle.settle(hist, FakeFD({(f"H{i}", f"A{i}"): (2, 0) for i in range(4)}), later)
    assert hist["slips"][0]["status"] == "won"
    assert math.isclose(hist["slips"][0]["profit_per_10"], round(10 * (1.2 ** 4 - 1), 2))
