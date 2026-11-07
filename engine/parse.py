"""Merge odds-by-tournaments payloads (one per bookmaker) into a single index:

  {fixtureId: {"meta": {...}, "books": {slug: {marketId: {outcomeId: price}}}}}

Only live, active prices are kept.
"""
from __future__ import annotations

from datetime import datetime

from .catalog import MARKET_IDS

META_KEYS = ("fixtureId", "tournamentId", "startTime", "participant1Id", "participant2Id", "statusId", "seasonId")


def _fixtures(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict) and payload.get("fixtureId"):
        return [payload]  # single-fixture /odds response
    if isinstance(payload, dict):
        for k in ("data", "fixtures", "results"):
            if isinstance(payload.get(k), list):
                return payload[k]
    return []


def _recent(stamp, now, max_age_h) -> bool:
    if not stamp or now is None:
        return now is None
    try:
        t = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except ValueError:
        return False
    return (now - t).total_seconds() <= max_age_h * 3600


def add_payload(index: dict, payload, wanted_markets=None, books=None, lenient=(), now=None, max_age_h=18) -> int:
    """Fold one payload into the index (optionally only some bookies). Returns prices added.

    `lenient` bookies (Bet365, William Hill): the feed flags their match markets as not
    active even when the prices are current, so keep those prices if they changed in the
    last `max_age_h` hours."""
    wanted = set(wanted_markets or MARKET_IDS)
    keep = set(books) if books else None
    lenient = set(lenient or ())
    added = 0
    for fx in _fixtures(payload):
        fid = fx.get("fixtureId")
        if not fid:
            continue
        entry = index.setdefault(fid, {"meta": {k: fx.get(k) for k in META_KEYS}, "books": {}})
        for slug, book in (fx.get("bookmakerOdds") or {}).items():
            if keep is not None and slug not in keep:
                continue
            if not isinstance(book, dict) or book.get("bookmakerIsActive") is False or book.get("suspended"):
                continue
            store = entry["books"].setdefault(slug, {})
            for mid, market in (book.get("markets") or {}).items():
                if str(mid) not in wanted or not isinstance(market, dict):
                    continue
                soft = market.get("marketActive") is False
                if soft and slug not in lenient:
                    continue
                prices = {}
                for oid, outcome in (market.get("outcomes") or {}).items():
                    player = ((outcome or {}).get("players") or {}).get("0") or {}
                    price = player.get("price")
                    if player.get("active") is False or not isinstance(price, (int, float)) or price <= 1.0:
                        continue
                    if soft and not _recent(player.get("changedAt") or player.get("bookmakerChangedAt"), now, max_age_h):
                        continue
                    prices[str(oid)] = float(price)
                if prices:
                    store[str(mid)] = prices
                    added += len(prices)
    return added


# ---------- player props (NFL for now) ----------
# marketType -> our stat name. Prices are kept per bookie per player per line.
PROP_TYPES = {"playertotals-receivingyards": "rec_yds", "playertotals-rushyards": "rush_yds",
              "playertotals-passyards": "pass_yds"}
_PROP_DEFS = None


def prop_defs() -> dict:
    """marketId -> (stat, line, over outcome id, under outcome id), from data/ref/markets_<sport>.json."""
    global _PROP_DEFS
    if _PROP_DEFS is None:
        import json
        from pathlib import Path
        _PROP_DEFS = {}
        for sid in (14,):
            path = Path(__file__).resolve().parents[1] / "data" / "ref" / f"markets_{sid}.json"
            if not path.exists():
                continue
            for m in json.loads(path.read_text()):
                stat = PROP_TYPES.get(m.get("marketType"))
                if not stat or m.get("period") != "result":
                    continue
                outs = {o.get("outcomeName"): str(o.get("outcomeId")) for o in m.get("outcomes", [])}
                if "Over" in outs and "Under" in outs:
                    _PROP_DEFS[str(m["marketId"])] = (stat, float(m.get("handicap") or 0), outs["Over"], outs["Under"])
    return _PROP_DEFS


def add_props(index: dict, payload, books=None, now=None, max_age_h=96) -> int:
    """Player over/under prices into index[fid]["props"][book] = [{pid, name, stat, line, over, under}].
    Player-level 'active' flags are unreliable in this feed, so recency decides instead."""
    defs = prop_defs()
    keep = set(books) if books else None
    added = 0
    for fx in _fixtures(payload):
        fid = fx.get("fixtureId")
        if not fid:
            continue
        for slug, book in (fx.get("bookmakerOdds") or {}).items():
            if keep is not None and slug not in keep:
                continue
            if not isinstance(book, dict):
                continue
            rows = {}
            for mid, market in (book.get("markets") or {}).items():
                d = defs.get(str(mid))
                if not d or not isinstance(market, dict):
                    continue
                stat, line, o_over, o_under = d
                for side, oid in (("over", o_over), ("under", o_under)):
                    for pid, pl in (((market.get("outcomes") or {}).get(oid) or {}).get("players") or {}).items():
                        price = (pl or {}).get("price")
                        if not isinstance(price, (int, float)) or price <= 1.0:
                            continue
                        if not _recent(pl.get("changedAt") or pl.get("bookmakerChangedAt"), now, max_age_h):
                            continue
                        r = rows.setdefault((pid, stat, line), {"pid": pid, "name": pl.get("playerName"), "stat": stat, "line": line})
                        r[side] = float(price)
            if rows:
                entry = index.setdefault(fid, {"meta": {k: fx.get(k) for k in META_KEYS}, "books": {}})
                store = entry.setdefault("props", {}).setdefault(slug, [])
                store.extend(rows.values())
                added += len(rows)
    return added
