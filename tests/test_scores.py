import json
from datetime import datetime, timezone

from engine import scores, settle


def af_match(fid, home, away, ko, short, gh, ga, ft=None, elapsed=None):
    return {"fixture": {"id": fid, "date": ko, "status": {"short": short, "elapsed": elapsed}},
            "teams": {"home": {"name": home}, "away": {"name": away}},
            "goals": {"home": gh, "away": ga},
            "score": {"fulltime": {"home": ft[0], "away": ft[1]} if ft else {"home": None, "away": None}}}


def fdo_match(mid, home, away, ko, status, h, a, regular=None):
    sc = {"fullTime": {"home": h, "away": a}}
    if regular:
        sc["regularTime"] = {"home": regular[0], "away": regular[1]}
    return {"id": mid, "utcDate": ko, "status": status, "homeTeam": {"name": home}, "awayTeam": {"name": away}, "score": sc}


def test_parse_api_football_uses_90_minute_score():
    got = scores.parse_api_football({"response": [
        af_match(1, "Leeds", "Hull City", "2026-11-07T15:00:00+00:00", "AET", 2, 1, ft=(1, 1)),
        af_match(2, "Hearts", "Celtic", "2026-11-07T15:00:00+00:00", "2H", 1, 0, elapsed=63),
    ]})
    assert got[0]["s"] == "FT" and (got[0]["h"], got[0]["a"]) == (1, 1)
    assert got[1]["s"] == "LIVE" and got[1]["min"] == 63 and (got[1]["h"], got[1]["a"]) == (1, 0)


def test_parse_football_data_regular_time():
    got = scores.parse_football_data({"matches": [
        fdo_match(9, "Arsenal FC", "Chelsea FC", "2026-11-07T17:30:00Z", "FINISHED", 3, 2, regular=(2, 2)),
        fdo_match(10, "Leeds United FC", "Burnley FC", "2026-11-07T15:00:00Z", "PAUSED", 0, 1),
    ]})
    assert got[0]["s"] == "FT" and (got[0]["h"], got[0]["a"]) == (2, 2)
    assert got[1]["s"] == "HT" and (got[1]["h"], got[1]["a"]) == (0, 1)


def test_match_fixture_by_names_and_time():
    fx = {"home": "Bristol City", "away": "Norwich City", "kickoff": "2026-11-07T12:30:00Z"}
    matches = [
        {"feed_id": "a", "home": "Bristol Rovers", "away": "Norwich", "kickoff": "2026-11-07T12:30:00+00:00"},
        {"feed_id": "b", "home": "Bristol City FC", "away": "Norwich City FC", "kickoff": "2026-11-07T12:30:00Z"},
        {"feed_id": "c", "home": "Bristol City", "away": "Norwich City", "kickoff": "2026-11-08T12:30:00Z"},
    ]
    assert scores.match_fixture(fx, matches)["feed_id"] == "b"
    assert scores.match_fixture(fx, matches, known_id="c")["feed_id"] == "c"


def test_run_end_to_end(tmp_path):
    root, mock = tmp_path / "repo", tmp_path / "mock"
    (root / "docs" / "data").mkdir(parents=True)
    (root / "data").mkdir()
    mock.mkdir()
    latest = {"fixtures": [
        {"id": "F1", "home": "Bristol City", "away": "Norwich City", "league": "Championship", "kickoff": "2026-11-07T12:30:00Z"},
        {"id": "F2", "home": "Hearts", "away": "Celtic", "league": "Premiership", "kickoff": "2026-11-07T15:00:00Z"},
        {"id": "F3", "home": "Leeds", "away": "Burnley", "league": "Premier League", "kickoff": "2026-11-08T14:00:00Z"},
    ]}
    (root / "docs" / "data" / "latest.json").write_text(json.dumps(latest))
    (mock / "af_fixtures.json").write_text(json.dumps({"response": [
        af_match(11, "Bristol City", "Norwich", "2026-11-07T12:30:00+00:00", "FT", 2, 0, ft=(2, 0)),
        af_match(12, "Heart Of Midlothian", "Celtic", "2026-11-07T15:00:00+00:00", "2H", 0, 0, elapsed=70),
    ]}))
    (mock / "af_status.json").write_text(json.dumps({"response": {"account": {"email": "secret@example.com"},
                                                                    "subscription": {"plan": "Free"},
                                                                    "requests": {"current": 3, "limit_day": 100}}}))
    hist = settle.empty_history()
    hist["slips"].append({"key": "k", "status": "pending", "start": "2026-11-07T12:30:00Z", "book": "bet365", "hit_p": 0.77,
                          "legs": [{"id": "F1|1x2:1", "key": "1x2:1", "price": 1.3, "fd": None, "result": None, "score": None}]})
    (root / "data" / "history_state.json").write_text(json.dumps(hist))

    now = datetime(2026, 11, 7, 16, 10, tzinfo=timezone.utc)
    log = scores.run(now, root, mock)
    assert log["called"] and log["changed"] == 2
    live = json.loads((root / "docs" / "data" / "live.json").read_text())
    assert live["fixtures"]["F1"]["s"] == "FT" and live["fixtures"]["F1"]["h"] == 2
    assert live["fixtures"]["F2"]["s"] == "LIVE" and live["fixtures"]["F2"]["min"] == 70
    assert "F3" not in live["fixtures"]
    text = (root / "data" / "scores_state.json").read_text() + json.dumps(live)
    assert "secret@example.com" not in text
    h = json.loads((root / "docs" / "data" / "history.json").read_text())
    assert h["slips"][0]["status"] == "won"

    # Nothing live and nothing waiting: no calls.
    quiet = datetime(2026, 11, 8, 9, 0, tzinfo=timezone.utc)
    (root / "docs" / "data" / "latest.json").write_text(json.dumps({"fixtures": []}))
    state = json.loads((root / "data" / "scores_state.json").read_text())
    state["scores"]["F2"] = {"s": "FT", "h": 0, "a": 0}
    (root / "data" / "scores_state.json").write_text(json.dumps(state))
    assert scores.run(quiet, root, mock)["called"] is False


def test_blocked_plan_stops_for_the_day(tmp_path):
    state = {}
    feeds = scores.Feeds(state, datetime(2026, 11, 7, 15, tzinfo=timezone.utc), mock_dir=tmp_path)
    (tmp_path / "af_fixtures.json").write_text(json.dumps({"errors": {"plan": "Free plans do not have access to this season"}}))
    assert feeds.api_football("2026-11-07") is None
    assert state["budget"]["af_blocked"]
    assert feeds.api_football("2026-11-07") is None
    assert state["budget"]["api_football"] == 1
