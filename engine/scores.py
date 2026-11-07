"""Live scores and full-time results, so placed slips can be tracked during the
matches and settled the same evening.

    python -m engine.scores              # live: called every 10 minutes by scores.yml
    python -m engine.scores --mock DIR --now 2026-11-07T16:00:00Z   # offline test

Two free feeds (keys are GitHub secrets; never write them anywhere):
  API-Football (API_FOOTBALL_KEY)     every league and cup, scores within a minute.
      Free plan: 100 requests a day. /status is free. One /fixtures?date= call
      returns every match in the world that day. The free plan may be limited to
      past seasons; if it refuses the current one we stop asking for the day and
      say so in live.json.
  football-data.org (FOOTBALL_DATA_API)  12 big competitions (Premier League,
      Championship, top European leagues, Champions League). Free plan: 10
      requests a minute, no daily cap, scores a little delayed.

Bets settle on the 90-minute score, so extra time and penalties are ignored.

Writes:
  docs/data/live.json       what the app reads: status and score per fixture id
  data/scores_state.json    tracked fixtures, feed match ids, results, budget
  docs/data/history.json    re-settled track record (when a result lands)
"""
from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from . import settle
from .names import best_match

ROOT = Path(__file__).resolve().parents[1]

AF_DIRECT = ("https://v3.football.api-sports.io", "x-apisports-key", None)
AF_RAPID = ("https://api-football-v1.p.rapidapi.com/v3", "x-rapidapi-key", "api-football-v1.p.rapidapi.com")
FDO_URL = "https://api.football-data.org/v4"

AF_DAILY_CAP = 90          # of 100, leaving room for a manual look
LIVE_BEFORE = timedelta(minutes=10)
LIVE_AFTER = timedelta(hours=2, minutes=45)   # kick-off to final whistle, with stoppages and delays
RESULT_GIVE_UP = timedelta(days=2)
SLOW_POLL = timedelta(minutes=55)             # when only waiting on late results
KEEP = timedelta(days=4)
MATCH_WINDOW = timedelta(minutes=90)          # kick-off times can differ a little between feeds

# Our status codes: NS not started, LIVE, HT, FT, PST postponed, ABD abandoned, CANC cancelled
AF_STATUS = {"TBD": "NS", "NS": "NS", "1H": "LIVE", "2H": "LIVE", "LIVE": "LIVE", "INT": "LIVE", "HT": "HT",
             "ET": "FT", "BT": "FT", "P": "FT", "FT": "FT", "AET": "FT", "PEN": "FT",
             "PST": "PST", "SUSP": "ABD", "ABD": "ABD", "CANC": "CANC", "AWD": "ABD", "WO": "ABD"}
FDO_STATUS = {"SCHEDULED": "NS", "TIMED": "NS", "IN_PLAY": "LIVE", "PAUSED": "HT", "FINISHED": "FT",
              "AWARDED": "ABD", "POSTPONED": "PST", "SUSPENDED": "ABD", "CANCELLED": "CANC"}


def load_json(path: Path, default):
    try:
        return json.loads(Path(path).read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, obj, compact=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) if compact
                    else json.dumps(obj, ensure_ascii=False, indent=1))


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def final_results(state: dict) -> dict:
    """fixture id -> (home goals, away goals) at 90 minutes, for settlement."""
    out = {}
    for fid, sc in (state or {}).get("scores", {}).items():
        if sc.get("s") == "FT" and sc.get("h") is not None and sc.get("a") is not None:
            out[fid] = (int(sc["h"]), int(sc["a"]))
    return out


# ---------- feeds: each returns a list of plain matches ----------
# {"feed_id", "home", "away", "kickoff", "s", "min", "h", "a"}

def _num(x):
    return None if x is None else int(x)


def parse_api_football(payload: dict) -> list[dict]:
    out = []
    for m in payload.get("response") or []:
        fx, teams, goals, score = m.get("fixture", {}), m.get("teams", {}), m.get("goals", {}), m.get("score", {})
        st = AF_STATUS.get((fx.get("status") or {}).get("short"), "NS")
        h, a = _num(goals.get("home")), _num(goals.get("away"))
        ft = score.get("fulltime") or {}
        if st == "FT" and ft.get("home") is not None:  # 90-minute score, before extra time
            h, a = _num(ft["home"]), _num(ft["away"])
        out.append({"feed_id": str(fx.get("id")), "home": (teams.get("home") or {}).get("name", ""),
                    "away": (teams.get("away") or {}).get("name", ""), "kickoff": fx.get("date"),
                    "s": st, "min": (fx.get("status") or {}).get("elapsed"), "h": h, "a": a})
    return out


def parse_football_data(payload: dict) -> list[dict]:
    out = []
    for m in payload.get("matches") or []:
        st = FDO_STATUS.get(m.get("status"), "NS")
        score = m.get("score") or {}
        sc = score.get("regularTime") or score.get("fullTime") or {}
        if st != "FT":
            sc = score.get("fullTime") or {}
        out.append({"feed_id": str(m.get("id")),
                    "home": (m.get("homeTeam") or {}).get("name") or (m.get("homeTeam") or {}).get("shortName") or "",
                    "away": (m.get("awayTeam") or {}).get("name") or (m.get("awayTeam") or {}).get("shortName") or "",
                    "kickoff": m.get("utcDate"), "s": st, "min": m.get("minute"),
                    "h": _num(sc.get("home")), "a": _num(sc.get("away"))})
    return out


class Feeds:
    """HTTP for both feeds. Records what happened (never the keys, never account details)."""

    def __init__(self, state: dict, now: datetime, mock_dir: Path | None = None):
        self.state, self.now, self.mock_dir = state, now, mock_dir
        self.af_key = os.environ.get("API_FOOTBALL_KEY", "").strip()
        self.fdo_key = os.environ.get("FOOTBALL_DATA_API", "").strip()
        self.calls: list[dict] = []
        self.today = now.date().isoformat()
        b = state.setdefault("budget", {})
        if b.get("date") != self.today:
            state["budget"] = {"date": self.today, "api_football": 0, "af_blocked": None}
        self.feeds = state.setdefault("feeds", {})

    def _mock(self, name):
        p = self.mock_dir / name
        return load_json(p, None) if p.exists() else None

    # -- API-Football --
    def _af_get(self, path, params):
        if self.mock_dir:
            return 200, self._mock(f"af_{path.strip('/').replace('/', '_')}.json") or {"response": []}
        mode = AF_RAPID if self.state.get("af_mode") == "rapid" else AF_DIRECT
        base, header, host = mode
        headers = {header: self.af_key}
        if host:
            headers["x-rapidapi-host"] = host
        r = requests.get(base + path, params=params, headers=headers, timeout=30)
        try:
            body = r.json()
        except ValueError:
            body = {}
        return r.status_code, body

    @staticmethod
    def _af_error(body) -> str:
        errs = body.get("errors") if isinstance(body, dict) else None
        if isinstance(errs, dict):
            return "; ".join(f"{k}: {v}" for k, v in errs.items())[:300]
        if isinstance(errs, list) and errs:
            return "; ".join(map(str, errs))[:300]
        if isinstance(body, dict) and body.get("message"):
            return str(body["message"])[:300]
        return ""

    def af_status(self) -> dict:
        """Free call: plan and today's usage. Keeps only those numbers."""
        if not self.af_key and not self.mock_dir:
            return {"ok": False, "note": "No API_FOOTBALL_KEY secret"}
        code, body = self._af_get("/status", {})
        err = self._af_error(body)
        if err and "key" in err.lower() and self.state.get("af_mode") != "rapid" and not self.mock_dir:
            self.state["af_mode"] = "rapid"  # key may be a RapidAPI one
            code, body = self._af_get("/status", {})
            err = self._af_error(body)
            if err:
                self.state["af_mode"] = "direct"
        self.calls.append({"feed": "api_football", "endpoint": "status", "status": code, "error": err})
        resp = body.get("response") if isinstance(body, dict) else None
        if err or not isinstance(resp, dict):
            return {"ok": False, "note": err or f"HTTP {code}"}
        req = resp.get("requests") or {}
        sub = resp.get("subscription") or {}
        return {"ok": True, "plan": sub.get("plan"), "used_today": req.get("current"), "limit_day": req.get("limit_day")}

    def api_football(self, day: str) -> list[dict] | None:
        b = self.state["budget"]
        if (not self.af_key and not self.mock_dir) or b.get("af_blocked") or b["api_football"] >= AF_DAILY_CAP:
            return None
        code, body = self._af_get("/fixtures", {"date": day})
        b["api_football"] += 1
        err = self._af_error(body)
        self.calls.append({"feed": "api_football", "endpoint": "fixtures", "date": day, "status": code,
                           "error": err, "results": len(body.get("response") or []) if isinstance(body, dict) else 0})
        if err or code != 200:
            # A plan or season refusal won't change today: stop spending requests on it.
            b["af_blocked"] = err or f"HTTP {code}"
            self.feeds["api_football"] = {"ok": False, "note": b["af_blocked"], "at": iso(self.now)}
            return None
        self.feeds["api_football"] = {"ok": True, "note": "", "at": iso(self.now)}
        return parse_api_football(body)

    # -- football-data.org --
    def football_data(self, date_from: str, date_to: str) -> list[dict] | None:
        if not self.fdo_key and not self.mock_dir:
            self.feeds["football_data"] = {"ok": False, "note": "No FOOTBALL_DATA_API secret", "at": iso(self.now)}
            return None
        if self.mock_dir:
            code, body = 200, self._mock("fdo_matches.json") or {"matches": []}
        else:
            r = requests.get(f"{FDO_URL}/matches", params={"dateFrom": date_from, "dateTo": date_to},
                             headers={"X-Auth-Token": self.fdo_key}, timeout=30)
            code = r.status_code
            try:
                body = r.json()
            except ValueError:
                body = {}
        err = "" if code == 200 else str((body or {}).get("message") or f"HTTP {code}")[:300]
        self.calls.append({"feed": "football_data", "endpoint": "matches", "from": date_from, "to": date_to,
                           "status": code, "error": err, "results": len((body or {}).get("matches") or [])})
        self.feeds["football_data"] = {"ok": not err, "note": err, "at": iso(self.now)}
        return None if err else parse_football_data(body)


# ---------- matching our fixtures to feed matches ----------

def match_fixture(fx: dict, matches: list[dict], known_id: str | None = None) -> dict | None:
    if known_id:
        for m in matches:
            if m["feed_id"] == known_id:
                return m
    ko = ts(fx["kickoff"])
    near = [m for m in matches if m.get("kickoff") and abs(ts(m["kickoff"]) - ko) <= MATCH_WINDOW]
    if not near:
        return None
    home = best_match(fx["home"], sorted({m["home"] for m in near}))
    if home:
        for m in near:
            if m["home"] == home and best_match(fx["away"], [m["away"]], cutoff=0.6):
                return m
    away = best_match(fx["away"], sorted({m["away"] for m in near}))
    if away:
        for m in near:
            if m["away"] == away and best_match(fx["home"], [m["home"]], cutoff=0.6):
                return m
    return None


# ---------- one run ----------

def track(state: dict, latest: dict, now: datetime):
    """Add today's fixtures from latest.json; forget old ones."""
    fx_state = state.setdefault("fixtures", {})
    for f in (latest or {}).get("fixtures", []):
        cur = fx_state.setdefault(f["id"], {})
        cur.update({"home": f["home"], "away": f["away"], "league": f.get("league"),
                    "country": f.get("country"), "kickoff": f["kickoff"]})
    for fid in list(fx_state):
        if ts(fx_state[fid]["kickoff"]) < now - KEEP:
            fx_state.pop(fid)
            state.get("scores", {}).pop(fid, None)


def needs(state: dict, now: datetime) -> tuple[list[str], bool]:
    """Fixtures that want a score now, and whether any is live (poll every run)."""
    scores = state.setdefault("scores", {})
    want, live = [], False
    for fid, fx in state.get("fixtures", {}).items():
        ko = ts(fx["kickoff"])
        if ko - LIVE_BEFORE > now or ko < now - RESULT_GIVE_UP:
            continue
        if scores.get(fid, {}).get("s") in ("FT", "CANC", "ABD"):
            continue
        want.append(fid)
        if ko <= now + LIVE_BEFORE and now <= ko + LIVE_AFTER:
            live = True
    return want, live


def run(now: datetime, root: Path = ROOT, mock_dir: Path | None = None, force: bool = False) -> dict:
    data, docs_data = root / "data", root / "docs" / "data"
    state = load_json(data / "scores_state.json", {})
    latest = load_json(docs_data / "latest.json", {})
    track(state, latest, now)
    want, live = needs(state, now)
    log = {"at": iso(now), "want": len(want), "live": live, "called": False, "calls": [], "changed": 0}

    last = state.get("last_called_at")
    due = live or (want and (not last or now - ts(last) >= SLOW_POLL))
    if not (due or force):
        save_json(data / "scores_state.json", state)
        return log

    feeds = Feeds(state, now, mock_dir)
    log["called"] = True
    state["last_called_at"] = iso(now)
    if state.get("af_status_date") != feeds.today or force:
        st = feeds.af_status()
        state["af_status"] = st
        state["af_status_date"] = feeds.today
        if st.get("ok"):
            # Trust the feed's own count when it's higher than ours.
            used = st.get("used_today") or 0
            state["budget"]["api_football"] = max(state["budget"]["api_football"], int(used))

    fixtures = state["fixtures"]
    days = sorted({fixtures[f]["kickoff"][:10] for f in want}) or [feeds.today]
    af, fdo = [], []
    for d in days[-2:]:
        got = feeds.api_football(d)
        if got:
            af.extend(got)
    day_after = (ts(days[-1] + "T00:00:00Z") + timedelta(days=1)).date().isoformat()
    got = feeds.football_data(days[0], day_after)
    if got:
        fdo = got

    scores = state.setdefault("scores", {})
    links = state.setdefault("links", {})
    targets = list(want)
    if force:  # manual check: also try to match everything kicking off on the days fetched
        targets += [f for f in fixtures if f not in want and fixtures[f]["kickoff"][:10] in days[-2:]]
    cover = {"checked": len(targets), "api_football": 0, "football_data": 0, "unmatched": []}
    for fid in targets:
        fx = fixtures[fid]
        link = links.setdefault(fid, {})
        best = None
        for src, matches in (("af", af), ("fd", fdo)):
            if not matches:
                continue
            m = match_fixture(fx, matches, link.get(src))
            if not m:
                continue
            link[src] = m["feed_id"]
            cover["api_football" if src == "af" else "football_data"] += 1
            # API-Football is quicker; football-data.org fills gaps and confirms finals.
            if best is None or (best["s"] not in ("FT",) and m["s"] == "FT" and m["h"] is not None):
                best = dict(m, src=src)
        if not best:
            cover["unmatched"].append(f'{fx["home"]} v {fx["away"]} ({fx.get("league")})')
        if not best or best["s"] == "NS" and fid not in scores:
            continue
        new = {"s": best["s"], "min": best.get("min"), "h": best["h"], "a": best["a"], "src": best["src"]}
        old = scores.get(fid, {})
        if any(old.get(k) != new[k] for k in ("s", "min", "h", "a")):
            new["at"] = iso(now)
            scores[fid] = new
            log["changed"] += 1
    log["calls"] = feeds.calls
    log["coverage"] = cover

    # Re-settle the model's record when a full-time result is new.
    results = final_results(state)
    if log["changed"] and results:
        hist_path = data / "history_state.json"
        hist = load_json(hist_path, None)
        if hist:
            before = json.dumps(hist, sort_keys=True)
            settle.settle(hist, None, now, results=results)
            if json.dumps(hist, sort_keys=True) != before:
                save_json(hist_path, hist)
                save_json(docs_data / "history.json", settle.public_history(hist, iso(now)), compact=True)
                log["history_updated"] = True

    live_doc = {
        "updated_at": iso(now),
        "feeds": {
            "api_football": state.get("feeds", {}).get("api_football") or {"ok": None, "note": "Not called yet"},
            "football_data": state.get("feeds", {}).get("football_data") or {"ok": None, "note": "Not called yet"},
            "api_football_plan": {k: (state.get("af_status") or {}).get(k) for k in ("ok", "plan", "limit_day", "note")},
            "api_football_used_today": state["budget"]["api_football"],
        },
        "fixtures": {fid: sc for fid, sc in scores.items() if fid in fixtures},
    }
    save_json(docs_data / "live.json", live_doc, compact=True)
    state["last_log"] = log
    save_json(data / "scores_state.json", state)
    return log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--now")
    ap.add_argument("--mock", type=Path, help="read feed responses from this folder instead of the internet")
    ap.add_argument("--root", type=Path, default=ROOT, help="repo root to read and write (for tests)")
    ap.add_argument("--force", action="store_true", help="call the feeds even if nothing is live (manual check)")
    args = ap.parse_args()
    now = ts(args.now) if args.now else datetime.now(timezone.utc).replace(microsecond=0)
    log = run(now, args.root, args.mock, args.force)
    print(json.dumps(log, indent=1, default=str)[:4000])


if __name__ == "__main__":
    main()
