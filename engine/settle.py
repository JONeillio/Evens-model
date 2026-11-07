"""Track record: publish the model's top slip for each kick-off time, then settle
it from football-data.co.uk results so you can see whether the model works.

Also keeps a calibration table: when the model said a leg was 85% likely, how
often did it actually come in?
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .catalog import outcome

CAL_BINS = [0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.0001]


def _ts(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def _bin(p: float) -> str:
    for lo, hi in zip(CAL_BINS, CAL_BINS[1:]):
        if lo <= p < hi:
            return f"{lo:.2f}"
    return f"{CAL_BINS[0]:.2f}"


def empty_history() -> dict:
    return {"slips": [], "calibration": {}, "legs_pending": {}}


def leg_snapshot(leg, fixture, price=None):
    return {
        "id": leg["id"],
        "key": leg["key"],
        "label": leg["label"],
        "match": f"{fixture['home']} v {fixture['away']}",
        "league": fixture["league"],
        "kickoff": fixture["kickoff"],
        "price": price if price is not None else leg["best_price"],
        "p_win": leg["p_win"],
        "p_void": leg["p_void"],
        "fd": fixture.get("fd"),
        "result": None,
        "score": None,
    }


def publish(history: dict, slips, legs_by_id, fixtures_by_id, now: datetime):
    """Record the top slip per start time; replace it until the first kick-off."""
    best_per_start = {}
    for s in slips:
        cur = best_per_start.get(s["start"])
        if cur is None or s["ev"] > cur["ev"]:
            best_per_start[s["start"]] = s
    existing = {h["key"]: i for i, h in enumerate(history["slips"])}
    for start, s in best_per_start.items():
        if _ts(start) <= now:
            continue
        key = f"{start}"
        record = {
            "key": key,
            "slip_id": s["id"],
            "published_at": now.isoformat().replace("+00:00", "Z"),
            "label": s["label"],
            "start": s["start"],
            "book": s["book"],
            "odds": s["odds"],
            "hit_p": s["hit_p"],
            "ev": s["ev"],
            "legs": [leg_snapshot(legs_by_id[lid], fixtures_by_id[legs_by_id[lid]["fixture_id"]], s["prices"][lid])
                     for lid in s["legs"]],
            "status": "pending",
            "settled_odds": None,
            "profit_per_10": None,
        }
        if key in existing:
            old = history["slips"][existing[key]]
            if old["status"] == "pending" and _ts(old["start"]) > now:
                history["slips"][existing[key]] = record
        else:
            history["slips"].append(record)


def track_legs(history: dict, legs, fixtures_by_id, now: datetime):
    """Remember every candidate leg (latest price before kick-off) for calibration."""
    pending = history.setdefault("legs_pending", {})
    for leg in legs:
        fx = fixtures_by_id[leg["fixture_id"]]
        if _ts(fx["kickoff"]) <= now:
            continue
        pending[leg["id"]] = leg_snapshot(leg, fx)


def _prop_result(leg, results, prop_values):
    """Player-yards legs: compare the player's stat with the line once his game is final.
    No stat line for him in a final game = he didn't play = void (how the bookies settle it)."""
    fid = leg["id"].split("|")[0]
    if fid not in results:
        return None
    _, stat, pid, line, side = leg["key"].split(":")
    v = (prop_values or {}).get(f"{fid}|nfl-prop:{stat}:{pid}")
    if v is None:
        return "void"
    over = v > float(line)
    return "won" if (over if side == "over" else not over) else "lost"


def settle(history: dict, fd, now: datetime, give_up_days: int = 10, results: dict | None = None,
           prop_values: dict | None = None):
    """Settle pending slips and legs whose matches have results published.

    `results` maps fixture id -> (home goals, away goals) after 90 minutes, from
    the live-scores feeds (engine/scores.py). It settles the same evening and
    covers cups too. football-data.co.uk (`fd`) is the fallback.
    """
    cache = {}
    results = results or {}

    def result_for(leg):
        fid = leg["id"].split("|")[0]
        if fid in results:
            return tuple(results[fid])
        fd_ref = leg.get("fd")
        if not fd_ref or fd is None:
            return None
        k = (fd_ref["div"], fd_ref["home"], fd_ref["away"], leg["kickoff"][:10])
        if k not in cache:
            cache[k] = fd.find_result(fd_ref["div"], fd_ref["home"], fd_ref["away"], _ts(leg["kickoff"]))
        return cache[k]

    for slip in history["slips"]:
        if slip["status"] != "pending":
            continue
        if _ts(slip["start"]) > now - timedelta(hours=2):
            continue
        for leg in slip["legs"]:
            if leg["result"]:
                continue
            if leg["key"].startswith("nfl-prop"):
                leg["result"] = _prop_result(leg, results, prop_values)
                continue
            score = result_for(leg)
            if score:
                leg["result"] = outcome(leg["key"], *score)
                leg["score"] = f"{score[0]}-{score[1]}"
        results = [l["result"] for l in slip["legs"]]
        if "lost" in results:
            slip["status"] = "lost"
            slip["settled_odds"] = 0
            slip["profit_per_10"] = -10.0
        elif all(r in ("won", "void") for r in results):
            odds = 1.0
            for l in slip["legs"]:
                if l["result"] == "won":
                    odds *= l["price"]
            slip["status"] = "won" if odds > 1.0 else "void"
            slip["settled_odds"] = round(odds, 3)
            slip["profit_per_10"] = round(10 * (odds - 1), 2)
        elif _ts(slip["start"]) < now - timedelta(days=give_up_days):
            slip["status"] = "unsettled"

    cal = history.setdefault("calibration", {})
    pending = history.setdefault("legs_pending", {})
    for lid in list(pending):
        leg = pending[lid]
        if _ts(leg["kickoff"]) > now - timedelta(hours=2):
            continue
        if leg["key"].startswith("nfl-prop"):
            res = _prop_result(leg, results, prop_values)
            score = (0, 0) if res else None
        else:
            score = result_for(leg)
            res = outcome(leg["key"], *score) if score else None
        if score:
            if res != "void":
                b = cal.setdefault(_bin(leg["p_win"]), {"n": 0, "wins": 0, "p_sum": 0.0, "price_sum": 0.0})
                b["n"] += 1
                b["wins"] += 1 if res == "won" else 0
                b["p_sum"] = round(b["p_sum"] + leg["p_win"], 4)
                b["price_sum"] = round(b["price_sum"] + leg["price"], 3)
            # Per-leg results for the app (player-prop hands on the card table settle from these).
            if leg["key"].startswith("nfl-"):
                history.setdefault("leg_results", {})[lid] = {"r": res, "k": leg["kickoff"]}
            del pending[lid]
        elif _ts(leg["kickoff"]) < now - timedelta(days=give_up_days):
            del pending[lid]
    prune_leg_results(history, now)


def prune_leg_results(history: dict, now: datetime, days: int = 21) -> None:
    lr = history.get("leg_results", {})
    for k in [k for k, v in lr.items() if _ts(v["k"]) < now - timedelta(days=days)]:
        del lr[k]


def public_history(history: dict, generated_at: str) -> dict:
    """What the app reads (docs/data/history.json)."""
    return {
        "generated_at": generated_at,
        "summary": summary(history),
        "calibration": history.get("calibration", {}),
        "slips": list(reversed(history["slips"][-150:])),
        "leg_results": {k: v["r"] for k, v in history.get("leg_results", {}).items()},
    }


def summary(history: dict) -> dict:
    settled = [s for s in history["slips"] if s["status"] in ("won", "lost", "void")]
    won = sum(1 for s in settled if s["status"] == "won")
    profit = sum(s["profit_per_10"] or 0 for s in settled)
    staked = 10 * len([s for s in settled if s["status"] != "void"])
    exp_hits = sum(s["hit_p"] for s in settled if s["status"] != "void")
    return {
        "published": len(history["slips"]),
        "settled": len(settled),
        "won": won,
        "lost": sum(1 for s in settled if s["status"] == "lost"),
        "pending": sum(1 for s in history["slips"] if s["status"] == "pending"),
        "expected_wins": round(exp_hits, 2),
        "profit_per_10": round(profit, 2),
        "roi": round(profit / staked, 4) if staked else None,
    }
