"""Candidate leg pools for the phone: per kick-off window, per bookie, per match.

The machine's reels re-spin on the phone with no network call, so the app needs
every usable leg, not just finished slips:

  windows[]: {id, label, start_utc, end_utc,
    bookies[]: {bookie,
      fixtures[]: {fixture_id, home, away, league, kickoff_utc,
        legs[]: {leg_id, label, market_type, price, fair_p, p_void, edge, fair_source}}}}

A window starts at a kick-off time and takes every match kicking off within
`kickoff_spread_hours` of it (so legs settle around the same time).
"""
from __future__ import annotations

from datetime import datetime, timedelta

from .builder import window_label


def _ts(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _iso(dt: datetime) -> str:
    return dt.isoformat().replace("+00:00", "Z")


def build_pools(legs, fixtures_by_id, books, settings) -> list[dict]:
    cfg = settings["pools"]
    tz = settings["timezone"]
    spread = timedelta(hours=settings["slips"]["kickoff_spread_hours"])
    by_fixture: dict[str, list] = {}
    for leg in legs:
        by_fixture.setdefault(leg["fixture_id"], []).append(leg)
    kickoff = {fid: _ts(fixtures_by_id[fid]["kickoff"]) for fid in by_fixture}
    windows = []
    for anchor in sorted(set(kickoff.values())):
        fids = sorted((f for f, k in kickoff.items() if anchor <= k <= anchor + spread),
                      key=lambda f: (kickoff[f], fixtures_by_id[f]["home"]))
        bookies = []
        for book in books:
            fx_out = []
            for fid in fids:
                fx = fixtures_by_id[fid]
                pool = []
                for leg in by_fixture[fid]:
                    price = leg["prices"].get(book)
                    if price is None or not (cfg["min_price"] <= price <= cfg["max_price"]):
                        continue
                    if leg["p_win"] < cfg["min_fair_prob"]:
                        continue
                    pool.append({
                        "leg_id": leg["id"],
                        "label": leg["label"],
                        "market_type": leg["market"],
                        "price": price,
                        "fair_p": leg["p_win"],
                        "p_void": leg["p_void"],
                        "edge": round(price * leg["p_win"] + leg["p_void"] - 1, 4),
                        "fair_source": leg["source"],
                    })
                if pool:
                    pool.sort(key=lambda l: (-l["edge"], l["price"]))
                    fx_out.append({"fixture_id": fid, "home": fx["home"], "away": fx["away"],
                                   "league": fx["league"], "kickoff_utc": fx["kickoff"], "legs": pool})
            if len(fx_out) >= cfg["min_fixtures"]:
                bookies.append({"bookie": book, "fixtures": fx_out})
        if bookies:
            last = max(kickoff[f] for f in fids)
            windows.append({"id": _iso(anchor), "label": window_label(anchor, anchor, tz),
                            "start_utc": _iso(anchor), "end_utc": _iso(last), "bookies": bookies})
    return windows
