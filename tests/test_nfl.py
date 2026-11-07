import json
from pathlib import Path

from engine.nfl.live import norm_name, _abbr
from engine.nfl.model import p_over
from engine.settle import _prop_result

ROOT = Path(__file__).resolve().parents[1]


def test_names_and_teams():
    assert norm_name("Pitts, Kyle") == "kyle pitts"
    assert norm_name("Michael Penix Jr.") == "michael penix"
    assert _abbr("Los Angeles Rams") == "LA" and _abbr("Kansas City Chiefs") == "KC"


def test_p_over_rises_with_projection():
    table = json.loads((ROOT / "data" / "nfl_model" / "ratios.json").read_text())
    ps = [p_over(table, "rec_yds", mu, 39.5) for mu in (20, 40, 60, 90)]
    assert all(a < b for a, b in zip(ps, ps[1:]))
    assert p_over(table, "rush_yds", 120, 49.5) is not None  # thin top band falls back


def test_prop_settlement():
    leg = {"id": "F1|nfl-prop:rec_yds:00-1:29.5:over", "key": "nfl-prop:rec_yds:00-1:29.5:over"}
    assert _prop_result(leg, {}, {}) is None                          # game not final
    assert _prop_result(leg, {"F1": (20, 17)}, {"F1|nfl-prop:rec_yds:00-1": 31.0}) == "won"
    assert _prop_result(leg, {"F1": (20, 17)}, {"F1|nfl-prop:rec_yds:00-1": 12.0}) == "lost"
    assert _prop_result(leg, {"F1": (20, 17)}, {}) == "void"          # didn't play


def test_line_calibration_is_gentle_and_monotonic():
    from engine.nfl.live import _calibrate
    ps = [0.1, 0.3, 0.5, 0.7, 0.9, 0.97]
    out = [_calibrate("rec_yds", p) for p in ps]
    assert all(a < b for a, b in zip(out, out[1:]))
    assert all(abs(a - b) < 0.03 for a, b in zip(ps, out))  # tested: the raw model was already honest
