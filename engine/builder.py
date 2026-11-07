"""Build near-evens accumulators ("slips").

Rules:
  * every leg comes from a different match
  * every leg is priced at the SAME bookie (you can't split an acca across bookies)
  * all legs kick off within `kickoff_spread_hours` of each other
  * combined odds land inside [target_min, target_max]

Slips are ranked by expected value: product of (price * p_win + p_void) minus 1.
Legs are independent (different matches), so that product is exact.
"""
from __future__ import annotations

import hashlib
import heapq
from datetime import datetime, timedelta
from itertools import count
from zoneinfo import ZoneInfo


def _ts(iso: str) -> datetime:
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def window_label(start: datetime, end: datetime, tz: str) -> str:
    a, b = start.astimezone(ZoneInfo(tz)), end.astimezone(ZoneInfo(tz))
    day = a.strftime("%a")
    if a == b:
        return f"{day} {a:%H:%M}"
    if a.date() == b.date():
        return f"{day} {a:%H:%M}–{b:%H:%M}"
    return f"{day} {a:%H:%M} – {b:%a %H:%M}"


def slip_id(book: str, leg_ids) -> str:
    raw = book + "|" + "|".join(sorted(leg_ids))
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _eligible(legs, book, cfg):
    out = []
    for leg in legs:
        price = leg["prices"].get(book)
        if price is None:
            continue
        if not (cfg["leg_min_price"] <= price <= cfg["leg_max_price"]):
            continue
        if leg["p_win"] < cfg["leg_min_fair_prob"]:
            continue
        e = price * leg["p_win"] + leg["p_void"] - 1
        if e < cfg["leg_min_edge"]:
            continue
        out.append((leg, price, e))
    return out


def _pool(eligible, size, per_fixture=3):
    """Best legs by edge, at most `per_fixture` per match, `size` in total."""
    eligible = sorted(eligible, key=lambda t: (t[2], t[0]["p_win"]), reverse=True)
    seen: dict[str, int] = {}
    pool = []
    for leg, price, e in eligible:
        fid = leg["fixture_id"]
        if seen.get(fid, 0) >= per_fixture:
            continue
        seen[fid] = seen.get(fid, 0) + 1
        pool.append((leg, price, e))
        if len(pool) >= size:
            break
    return pool


def search(pool, n_legs_options, target_min, target_max, keep=40):
    """Depth-first search over leg combinations, pruned on combined odds."""
    best: list = []  # min-heap of (ev, tiebreak, combo)
    tie = count()
    # Sort by price so we can stop extending once the odds overshoot the target.
    items = sorted(pool, key=lambda t: t[1])
    n = len(items)
    max_k = max(n_legs_options)
    ks = set(n_legs_options)

    def dfs(start, chosen, fixtures, odds, value, hit):
        k = len(chosen)
        if k in ks and target_min <= odds <= target_max:
            ev = value - 1
            entry = (ev, next(tie), list(chosen), odds, hit)
            if len(best) < keep:
                heapq.heappush(best, entry)
            elif ev > best[0][0]:
                heapq.heapreplace(best, entry)
        if k == max_k:
            return
        for i in range(start, n):
            leg, price, _ = items[i]
            new_odds = odds * price
            if new_odds > target_max:
                break  # later items are pricier, so they overshoot too
            if leg["fixture_id"] in fixtures:
                continue
            chosen.append(items[i])
            fixtures.add(leg["fixture_id"])
            dfs(i + 1, chosen, fixtures,
                new_odds,
                value * (price * leg["p_win"] + leg["p_void"]),
                hit * (leg["p_win"] + leg["p_void"]))
            chosen.pop()
            fixtures.discard(leg["fixture_id"])

    dfs(0, [], set(), 1.0, 1.0, 1.0)
    return sorted(best, key=lambda e: e[0], reverse=True)


def build_slips(legs, fixtures_by_id, books, cfg, tz):
    spread = timedelta(hours=cfg["kickoff_spread_hours"])
    kickoff = {fid: _ts(fx["kickoff"]) for fid, fx in fixtures_by_id.items()}
    anchors = sorted({kickoff[l["fixture_id"]] for l in legs})
    found: dict[str, dict] = {}

    for anchor in anchors:
        in_window = [l for l in legs if anchor <= kickoff[l["fixture_id"]] <= anchor + spread]
        if len({l["fixture_id"] for l in in_window}) < min(cfg["legs_options"]):
            continue
        for book in books:
            pool = _pool(_eligible(in_window, book, cfg), cfg["pool_size"])
            for ev, _, combo, odds, hit in search(pool, cfg["legs_options"], cfg["target_min"], cfg["target_max"]):
                if ev < cfg["slip_min_ev"]:
                    continue
                leg_ids = [c[0]["id"] for c in combo]
                sid = slip_id(book, leg_ids)
                if sid in found:
                    continue
                times = sorted(kickoff[c[0]["fixture_id"]] for c in combo)
                found[sid] = {
                    "id": sid,
                    "book": book,
                    "legs": leg_ids,
                    "prices": {c[0]["id"]: c[1] for c in combo},
                    "odds": round(odds, 3),
                    "hit_p": round(hit, 4),
                    "ev": round(ev, 4),
                    "n_legs": len(combo),
                    "start": times[0].isoformat().replace("+00:00", "Z"),
                    "end": times[-1].isoformat().replace("+00:00", "Z"),
                    "label": window_label(times[0], times[-1], tz),
                    "sources": sorted({c[0]["source"] for c in combo}),
                    "model_backed": sum(1 for c in combo if c[0].get("model_p") is not None
                                        and c[0]["model_p"] >= c[0]["p_win"] - 0.04),
                }
    return select(list(found.values()), cfg["top_per_window"])


def select(slips, top_per_group):
    """Keep the best few slips per (start time, bookie), avoiding near-duplicates."""
    slips.sort(key=lambda s: (s["ev"], s["hit_p"]), reverse=True)
    chosen, per_group = [], {}
    for s in slips:
        group = (s["start"], s["book"])
        if per_group.get(group, 0) >= top_per_group:
            continue
        fx = {lid.split("|")[0] for lid in s["legs"]}
        if any((c["start"], c["book"]) == group and
               len(fx & {l.split("|")[0] for l in c["legs"]}) / len(fx | {l.split("|")[0] for l in c["legs"]}) > 0.5
               for c in chosen):
            continue
        chosen.append(s)
        per_group[group] = per_group.get(group, 0) + 1
    chosen.sort(key=lambda s: (s["start"], -s["ev"]))
    return chosen
