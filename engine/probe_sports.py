"""Discovery for more sports and cheaper bookie calls. Costs about 9 OddsPapi requests
(plus a few of API-Sports' 100/day if API_FOOTBALL_KEY is set).

    python -m engine.probe_sports   -> data/discovery/sports_report.json, data/ref/{tournaments,markets}_<sport>.json

Answers:
  1. Sport ids, and tournament ids for the NFL, NBA and MLB.
  2. Market ids for American football, basketball and baseball (moneyline, spread, totals).
  3. What Pinnacle and the UK bookies price for an NFL game.
  4. Whether odds-by-tournaments with one UK bookie gives the same depth as a per-match call
     (if so, a handful of calls can cover a whole league at that bookie).
"""
from __future__ import annotations

import json
import os
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import requests

from .discover import dump, summarise_odds, usage_only
from .oddspapi import OddsPapi

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "discovery"
REF = ROOT / "data" / "ref"



def rows(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        return payload.get("data") or list(payload.values())
    return []


def book_depth(payload) -> dict:
    """Markets per bookie per fixture, averaged."""
    per, n = Counter(), Counter()
    for fx in rows(payload):
        for slug, b in (fx.get("bookmakerOdds") or {}).items():
            per[slug] += len(b.get("markets") or {})
            n[slug] += 1
    return {slug: {"fixtures": n[slug], "avg_markets": round(per[slug] / n[slug], 1)} for slug in n}


def main() -> None:
    api = OddsPapi()
    rep: dict = {"ran_at": datetime.now(timezone.utc).isoformat(), "steps": {}}

    def step(name, fn):
        try:
            out = fn()
            rep["steps"][name] = "ok"
            return out
        except Exception as exc:
            rep["steps"][name] = f"error: {str(exc)[:300]}"
            return None

    acct = step("account", api.account)
    rep["account_before"] = usage_only(acct) if acct else None

    sports = rows(step("sports", lambda: api.get("sports")) or [])
    rep["sports"] = [{k: s.get(k) for k in ("sportId", "slug", "sportName", "sportSlug", "name")} for s in sports if isinstance(s, dict)]
    ids = {}
    for s in sports:
        if not isinstance(s, dict):
            continue
        name = " ".join(str(s.get(k) or "") for k in ("sportName", "name", "slug", "sportSlug")).lower()
        if "american" in name and "football" in name:
            ids.setdefault("NFL", s.get("sportId"))
        elif "basketball" in name and "3x3" not in name:
            ids.setdefault("NBA", s.get("sportId"))
        elif "baseball" in name:
            ids.setdefault("MLB", s.get("sportId"))
    rep["sport_ids"] = ids

    found = {}
    for label, sid in ids.items():
        tours = rows(step(f"tournaments_{label}", lambda sid=sid: api.tournaments(sid)) or [])
        dump(REF / f"tournaments_{sid}.json", tours)
        # The main league: the tournament with the most upcoming fixtures whose name matches.
        names = {"NFL": ("nfl",), "NBA": ("nba",), "MLB": ("mlb",)}[label]
        cand = [t for t in tours if any(nm == (t.get("tournamentName") or "").lower() or nm in (t.get("tournamentSlug") or "").lower().split("-") for nm in names)]
        cand.sort(key=lambda t: -((t.get("futureFixtures") or 0) + (t.get("upcomingFixtures") or 0)))
        rep[f"{label}_candidates"] = cand[:5]
        if cand:
            found[label] = cand[0]["tournamentId"]
    rep["tournament_ids"] = found

    mk = rows(step("markets", api.markets) or [])
    for label, sid in ids.items():
        mine = [m for m in mk if isinstance(m, dict) and m.get("sportId") == sid]
        dump(REF / f"markets_{sid}.json", mine)
        rep[f"markets_{label}"] = len(mine)

    nfl = found.get("NFL")
    if nfl:
        pin = step("nfl_pinnacle", lambda: api.odds_by_tournaments([nfl], bookmaker="pinnacle"))
        if pin is not None:
            rep["nfl_pinnacle"] = summarise_odds(pin)
            dump(OUT / "nfl_pinnacle_sample.json", rows(pin)[:1])
            first = sorted(rows(pin), key=lambda f: f.get("startTime") or "")
            if first:
                fid = first[0].get("fixtureId")
                one = step("nfl_match_all_books", lambda: api.get("odds", fixtureId=fid))
                if one is not None:
                    rep["nfl_match_books"] = book_depth([one])
                    dump(OUT / "nfl_match_sample.json", one)
        b365 = step("nfl_bet365_tournament", lambda: api.odds_by_tournaments([nfl], bookmaker="bet365"))
        if b365 is not None:
            rep["nfl_bet365_tournament"] = book_depth(b365)

    nba = found.get("NBA")
    if nba:
        pin = step("nba_pinnacle", lambda: api.odds_by_tournaments([nba], bookmaker="pinnacle"))
        if pin is not None:
            rep["nba_pinnacle"] = summarise_odds(pin)
            dump(OUT / "nba_pinnacle_sample.json", rows(pin)[:1])

    # Football: is one bookie for a whole league as deep as a per-match call?
    for bk in ("unibet", "paddypower"):
        res = step(f"football_{bk}_tournament", lambda bk=bk: api.odds_by_tournaments([17, 18, 19], bookmaker=bk))
        if res is not None:
            rep[f"football_{bk}_tournament"] = book_depth(res)
    snap = json.loads((ROOT / "data" / "snapshot.json").read_text())
    per_match = Counter(), Counter()
    for e in snap["index"].values():
        for slug, m in e["books"].items():
            if m:
                per_match[0][slug] += len(m)
                per_match[1][slug] += 1
    rep["football_per_match_depth_in_snapshot"] = {s: round(per_match[0][s] / per_match[1][s], 1) for s in per_match[1]}

    acct2 = step("account_after", api.account)
    rep["account_after"] = usage_only(acct2) if acct2 else None
    rep["oddspapi_calls"] = [c.__dict__ for c in api.calls]

    # API-Sports (same key as API-Football): do the NFL/NBA APIs serve this season on the free plan?
    key = os.environ.get("API_FOOTBALL_KEY")
    if key:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        checks = {
            "nfl_status": ("https://v1.american-football.api-sports.io/status", {}),
            "nfl_games_today": ("https://v1.american-football.api-sports.io/games", {"date": today}),
            "nba_games_today": ("https://v2.nba.api-sports.io/games", {"date": today}),
        }
        sports_rep = {}
        for name, (url, params) in checks.items():
            try:
                r = requests.get(url, params=params, headers={"x-apisports-key": key}, timeout=30)
                body = r.json()
                resp = body.get("response")
                sports_rep[name] = {"status": r.status_code, "errors": body.get("errors"), "results": body.get("results"),
                                    "sample": (resp[:1] if isinstance(resp, list) else None) if name != "nfl_status" else None}
                if name == "nfl_status" and isinstance(resp, dict):  # never store the account block (email)
                    sports_rep[name]["requests"] = resp.get("requests")
                    sports_rep[name]["plan"] = (resp.get("subscription") or {}).get("plan")
            except Exception as exc:
                sports_rep[name] = {"error": type(exc).__name__}
        rep["api_sports"] = sports_rep

    dump(OUT / "sports_report.json", rep)
    print(json.dumps({k: v for k, v in rep.items() if k not in ("oddspapi_calls",)}, indent=1, default=str)[:6000])


if __name__ == "__main__":
    main()
