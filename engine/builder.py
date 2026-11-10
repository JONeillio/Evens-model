"""Build near-evens accumulators ("slips").

Rules:
  * every leg comes from a different match
  * every leg is priced at the SAME bookie (you can't split an acca across bookies)
  * all legs kick off within `kickoff_spread_hours` of each other
  * combined odds land inside [target_min, target_max]

Slips are ranked by expected value: product of (price * p_win + p_void) minus 1,
less a small penalty when legs sit outside the short-price sweet spot (Joseph
wants 4-5 legs of about 1/7 to 1/4 each). Legs are independent (different
matches), so that product is exact.
"""
from __future__ import annotations

import hashlib
import heapq
from datetime import datetime, timedelta
from itertools import count
from zoneinfo import ZoneInfo


from .trust import believed

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


def band_fit(price: float, lo: float = 1.14, hi: float = 1.26) -> float:
    """1.0 inside the sweet spot, tapering to 0.3 at lo-0.06 and hi+0.09, 0.1 beyond.
    Mirrored in docs/app.js bandFit()."""
    if lo <= price <= hi:
        return 1.0
    if price < lo:
        edge = lo - 0.06
        return 0.1 if price < edge else 0.3 + 0.7 * (price - edge) / (lo - edge)
    edge = hi + 0.09
    return 0.1 if price > edge else 0.3 + 0.7 * (edge - price) / (edge - hi)


def slip_id(book: str, leg_ids) -> str:
    raw = book + "|" + "|".join(sorted(leg_ids))
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def _eligible(legs, book, cfg, trust=None):
    """(leg, price, believed edge, believed value). The raw edge still gates entry;
    ranking uses the edge after trust (engine/trust.py)."""
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
        value, _ = believed(price, leg["p_win"], leg["p_void"], leg.get("source"), trust)
        out.append((leg, price, value - 1, value))
    return out


def _pool(eligible, size, per_fixture=3, sweet=(1.14, 1.26), penalty=0.03):
    """Best legs by edge (nudged towards the sweet spot), at most `per_fixture`
    per match, `size` in total."""
    eligible = sorted(eligible, key=lambda t: (t[2] - penalty * (1 - band_fit(t[1], *sweet)), t[0]["p_win"]),
                      reverse=True)
    seen: dict[str, int] = {}
    pool = []
    for leg, price, e, value in eligible:
        fid = leg["fixture_id"]
        if seen.get(fid, 0) >= per_fixture:
            continue
        seen[fid] = seen.get(fid, 0) + 1
        pool.append((leg, price, e, value))
        if len(pool) >= size:
            break
    return pool


def search(pool, n_legs_options, target_min, target_max, keep=40, sweet=(1.14, 1.26), penalty=0.03):
    """Depth-first search over leg combinations, pruned on combined odds.
    Ranked by believed EV (after trust) less `penalty` x (1 - average sweet-spot fit).
    Returns (score, tiebreak, combo, odds, hit, raw ev, believed ev)."""
    best: list = []  # min-heap of (ev, tiebreak, combo)
    tie = count()
    # Sort by price so we can stop extending once the odds overshoot the target.
    items = sorted(pool, key=lambda t: t[1])
    n = len(items)
    max_k = max(n_legs_options)
    ks = set(n_legs_options)

    def dfs(start, chosen, fixtures, odds, value, hit, believed_value):
        k = len(chosen)
        if k in ks and target_min <= odds <= target_max:
            ev = value - 1
            ev_trust = believed_value - 1
            fit = sum(band_fit(c[1], *sweet) for c in chosen) / k
            score = ev_trust - penalty * (1 - fit)
            entry = (score, next(tie), list(chosen), odds, hit, ev, ev_trust)
            if len(best) < keep:
                heapq.heappush(best, entry)
            elif score > best[0][0]:
                heapq.heapreplace(best, entry)
        if k == max_k:
            return
        for i in range(start, n):
            leg, price, _, leg_value = items[i]
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
                hit * (leg["p_win"] + leg["p_void"]),
                believed_value * leg_value)
            chosen.pop()
            fixtures.discard(leg["fixture_id"])

    dfs(0, [], set(), 1.0, 1.0, 1.0, 1.0)
    return sorted(best, key=lambda e: e[0], reverse=True)


def build_slips(legs, fixtures_by_id, books, cfg, tz, trust=None):
    spread = timedelta(hours=cfg["kickoff_spread_hours"])
    kickoff = {fid: _ts(fx["kickoff"]) for fid, fx in fixtures_by_id.items()}
    anchors = sorted({kickoff[l["fixture_id"]] for l in legs})
    found: dict[str, dict] = {}

    for anchor in anchors:
        in_window = [l for l in legs if anchor <= kickoff[l["fixture_id"]] <= anchor + spread]
        if len({l["fixture_id"] for l in in_window}) < min(cfg["legs_options"]):
            continue
        sweet = tuple(cfg.get("sweet_spot", (1.14, 1.26)))
        penalty = cfg.get("fit_penalty", 0.03)
        for book in books:
            pool = _pool(_eligible(in_window, book, cfg, trust), cfg["pool_size"], sweet=sweet, penalty=penalty)
            results = search(pool, cfg["legs_options"], cfg["target_min"], cfg["target_max"], sweet=sweet, penalty=penalty)
            if not results and cfg.get("fallback_legs_options"):  # 3 or 6 legs only when 4-5 can't be done
                results = search(pool, cfg["fallback_legs_options"], cfg["target_min"], cfg["target_max"],
                                 sweet=sweet, penalty=penalty)
            for score, _, combo, odds, hit, ev, ev_trust in results:
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
                    "ev_trust": round(ev_trust, 4),
                    "score": round(score, 4),
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
    slips.sort(key=lambda s: (s.get("score", s["ev"]), s["hit_p"]), reverse=True)
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
