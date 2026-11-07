"""Which free data sources can the job reach, and what do they give us? Costs no odds requests
(about 3 of API-Football's 100/day).

    python -m engine.datacheck   -> data/discovery/datacheck.json

Checks, for the Premier League shots-on-target model:
  API-Football   per-match player stats (minutes, shots, shots on target) for this season
  FPL            official Fantasy Premier League API: minutes, starts, expected goals, injury news
  Understat      shot-by-shot data (on target = goal or saved shot)
  football-data  team shots / shots on target / referee per match (already used)
and for the NFL: nflverse files for this season.
Never writes account details (the API-Football status block contains the email).
"""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
UA = {"User-Agent": "evens-model data check (personal, non-commercial)"}


def _try(fn):
    try:
        return fn()
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {str(exc)[:200]}"}


def api_football():
    key = os.environ.get("API_FOOTBALL_KEY")
    if not key:
        return {"ok": False, "error": "no key in this job"}
    h = {"x-apisports-key": key}
    base = "https://v3.football.api-sports.io"
    season = datetime.now(timezone.utc).year if datetime.now(timezone.utc).month >= 7 else datetime.now(timezone.utc).year - 1
    fx = requests.get(f"{base}/fixtures", params={"league": 39, "season": season, "last": 3}, headers=h, timeout=30).json()
    out = {"season": season, "fixtures_errors": fx.get("errors"), "fixtures_results": fx.get("results")}
    resp = fx.get("response") or []
    if resp:
        fid = resp[0]["fixture"]["id"]
        pl = requests.get(f"{base}/fixtures/players", params={"fixture": fid}, headers=h, timeout=30).json()
        out["players_errors"] = pl.get("errors")
        teams = pl.get("response") or []
        sample = []
        for t in teams[:1]:
            for p in (t.get("players") or [])[:3]:
                st = (p.get("statistics") or [{}])[0]
                sample.append({"name": p["player"]["name"], "minutes": st.get("games", {}).get("minutes"),
                               "position": st.get("games", {}).get("position"), "shots": st.get("shots"),
                               "passes_key": (st.get("passes") or {}).get("key")})
        out["players_sample"] = sample
        out["ok"] = bool(sample)
    return out


def fpl():
    b = requests.get("https://fantasy.premierleague.com/api/bootstrap-static/", headers=UA, timeout=30)
    d = b.json()
    el = d["elements"][0]
    fields = sorted(el.keys())
    s = requests.get(f"https://fantasy.premierleague.com/api/element-summary/{el['id']}/", headers=UA, timeout=30).json()
    hist_fields = sorted((s.get("history") or [{}])[0].keys()) if s.get("history") else []
    return {"ok": True, "players": len(d["elements"]),
            "has": {k: k in fields for k in ("chance_of_playing_next_round", "news", "expected_goals", "starts", "minutes", "penalties_order")},
            "per_match_fields": hist_fields}


def understat():
    """Understat now loads its tables in the background (AJAX): try the league data endpoint."""
    out = {}
    h = dict(UA, **{"X-Requested-With": "XMLHttpRequest", "Referer": "https://understat.com/league/EPL"})
    for url in ("https://understat.com/getLeagueData/EPL/2026", "https://understat.com/getLeagueData/EPL/2025"):
        try:
            r = requests.get(url, headers=h, timeout=30)
            j = r.json() if r.text[:1] in "{[" else None
            out[url] = {"status": r.status_code, "json_keys": list(j.keys())[:6] if isinstance(j, dict) else None,
                        "players": len(j.get("players", [])) if isinstance(j, dict) else None,
                        "player_fields": sorted((j.get("players") or [{}])[0].keys())[:25] if isinstance(j, dict) else None}
        except Exception as exc:
            out[url] = {"error": f"{type(exc).__name__}"}
    out["ok"] = any((v or {}).get("players") for v in out.values())
    return out


def football_data():
    r = requests.get("https://www.football-data.co.uk/mmz4281/2627/E0.csv", headers=UA, timeout=30)
    head = r.text.splitlines()[0].split(",") if r.ok else []
    return {"ok": r.ok, "columns_of_interest": [c for c in head if c in ("HS", "AS", "HST", "AST", "Referee", "HC", "AC", "HY", "AY")]}


def nflverse():
    base = "https://github.com/nflverse/nflverse-data/releases/download"
    out = {}
    for rel in ("stats_player/stats_player_week_2026.csv", "injuries/injuries_2026.csv", "snap_counts/snap_counts_2026.csv"):
        r = requests.head(f"{base}/{rel}", allow_redirects=True, timeout=30)
        out[rel] = r.status_code
    return {"ok": all(v == 200 for v in out.values()), "files": out}


def main():
    rep = {"ran_at": datetime.now(timezone.utc).isoformat()}
    for name, fn in (("api_football", api_football), ("fpl", fpl), ("understat", understat),
                     ("football_data", football_data), ("nflverse", nflverse)):
        rep[name] = _try(fn)
    path = ROOT / "data" / "discovery" / "datacheck.json"
    path.write_text(json.dumps(rep, indent=1, default=str))
    print(json.dumps(rep, indent=1, default=str)[:5000])


if __name__ == "__main__":
    main()
