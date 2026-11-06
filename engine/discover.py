"""One-off discovery run: learn the real shape of OddsPapi data.

Writes small JSON summaries to data/discovery/ and reference caches to data/ref/.
Costs roughly 7 requests.  Run with:  python -m engine.discover
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .oddspapi import OddsPapi

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "discovery"
REF = ROOT / "data" / "ref"


def dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False, default=str))


def usage_only(account: dict) -> dict:
    """Never store the raw account payload: it contains the API key and email."""
    sub = (account or {}).get("subscriptions", [{}])[0]
    return {k: sub.get(k) for k in ("plan", "request_limit", "request_count")}


def summarise_odds(payload) -> dict:
    fixtures = payload if isinstance(payload, list) else payload.get("data", payload)
    if not isinstance(fixtures, list):
        return {"unexpected_type": type(payload).__name__, "keys": list(payload)[:30] if isinstance(payload, dict) else None}
    books, markets, starts = Counter(), Counter(), []
    for fx in fixtures:
        starts.append(fx.get("startTime"))
        for slug, book in (fx.get("bookmakerOdds") or {}).items():
            books[slug] += 1
            for mid in (book.get("markets") or {}):
                markets[mid] += 1
    starts = sorted(s for s in starts if s)
    return {
        "fixtures": len(fixtures),
        "fixture_keys": sorted(fixtures[0].keys()) if fixtures else [],
        "start_min": starts[0] if starts else None,
        "start_max": starts[-1] if starts else None,
        "bookmakers": books.most_common(),
        "market_ids": markets.most_common(60),
    }


def main() -> None:
    api = OddsPapi()
    report = {"ran_at": datetime.now(timezone.utc).isoformat(), "steps": {}}

    def step(name, fn):
        try:
            result = fn()
            report["steps"][name] = "ok"
            return result
        except Exception as exc:  # keep going: we want as much shape info as possible
            report["steps"][name] = f"error: {exc}"
            return None

    acct = step("account", api.account)
    if acct is not None:
        report["account_before"] = usage_only(acct)

    books = step("bookmakers", api.bookmakers)
    if books is not None:
        dump(REF / "bookmakers.json", books)

    tours = step("tournaments", lambda: api.tournaments(10))
    if tours is not None:
        dump(REF / "tournaments_10.json", tours)

    markets = step("markets", api.markets)
    if markets is not None:
        rows = markets if isinstance(markets, list) else markets.get("data", [])
        soccer = [m for m in rows if isinstance(m, dict) and m.get("sportId") == 10]
        dump(REF / "markets_10.json", soccer)
        report["markets_total"] = len(rows)
        report["markets_soccer"] = len(soccer)

    parts = step("participants", lambda: api.participants(10))
    if parts is not None:
        dump(REF / "participants_10.json", parts)
        report["participants_type"] = type(parts).__name__
        report["participants_count"] = len(parts)

    pin = step("odds_pinnacle", lambda: api.odds_by_tournaments([17, 18], bookmaker="pinnacle"))
    if pin is not None:
        report["odds_pinnacle"] = summarise_odds(pin)
        fixtures = pin if isinstance(pin, list) else []
        dump(OUT / "odds_pinnacle_sample.json", fixtures[:2])

    allb = step("odds_no_bookmaker", lambda: api.odds_by_tournaments([17]))
    if allb is not None:
        report["odds_no_bookmaker"] = summarise_odds(allb)
        fixtures = allb if isinstance(allb, list) else []
        dump(OUT / "odds_no_bookmaker_sample.json", fixtures[:1])

    acct2 = step("account_after", api.account)
    if acct2 is not None:
        report["account_after"] = usage_only(acct2)

    report["calls"] = [c.__dict__ for c in api.calls]
    dump(OUT / "report.json", report)
    print(json.dumps({k: v for k, v in report.items() if k != "calls"}, indent=1, default=str)[:4000])


if __name__ == "__main__":
    main()
