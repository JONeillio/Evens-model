"""Which bookies actually price a typical match? Costs 1 request.

    python -m engine.probe     -> data/probe.json
"""
from __future__ import annotations

import json
from pathlib import Path

from .catalog import MARKET_IDS
from .oddspapi import OddsPapi

ROOT = Path(__file__).resolve().parents[1]
KEY_MARKETS = {"101": "result", "101902": "double chance", "10214": "draw no bet", "108": "over 1.5",
               "1012": "under 3.5", "10284": "team to score", "104": "btts"}


def main():
    snap = json.loads((ROOT / "data" / "snapshot.json").read_text())
    fixtures = sorted(snap["index"].items(), key=lambda kv: (kv[1]["meta"]["tournamentId"] not in (17, 18), kv[1]["meta"]["startTime"]))
    fid = fixtures[0][0]
    api = OddsPapi()
    data = api.get("odds", fixtureId=fid)
    books = (data.get("bookmakerOdds") if isinstance(data, dict) else None) or {}
    summary = {}
    for slug, b in books.items():
        markets = b.get("markets") or {}
        ours = [m for m in markets if m in MARKET_IDS]
        summary[slug] = {"markets": len(markets), "our_markets": len(ours),
                         "has": [name for mid, name in KEY_MARKETS.items() if mid in markets]}
    ranked = dict(sorted(summary.items(), key=lambda kv: -kv[1]["our_markets"]))
    out = {"fixture": fid, "tournament": fixtures[0][1]["meta"]["tournamentId"], "bookmakers": ranked,
           "calls": [c.__dict__ for c in api.calls]}
    (ROOT / "data" / "probe.json").write_text(json.dumps(out, indent=1))
    print(json.dumps({k: v for k, v in list(ranked.items())[:40]}, indent=0)[:4000])


if __name__ == "__main__":
    main()
