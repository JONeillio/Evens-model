"""Merge odds-by-tournaments payloads (one per bookmaker) into a single index:

  {fixtureId: {"meta": {...}, "books": {slug: {marketId: {outcomeId: price}}}}}

Only live, active prices are kept.
"""
from __future__ import annotations

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


def add_payload(index: dict, payload, wanted_markets=None, books=None) -> int:
    """Fold one payload into the index (optionally only some bookies). Returns prices added."""
    wanted = set(wanted_markets or MARKET_IDS)
    keep = set(books) if books else None
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
                if market.get("marketActive") is False:
                    continue
                prices = {}
                for oid, outcome in (market.get("outcomes") or {}).items():
                    player = ((outcome or {}).get("players") or {}).get("0") or {}
                    price = player.get("price")
                    if player.get("active") is False or not isinstance(price, (int, float)) or price <= 1.0:
                        continue
                    prices[str(oid)] = float(price)
                if prices:
                    store[str(mid)] = prices
                    added += len(prices)
    return added
