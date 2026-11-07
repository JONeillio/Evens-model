"""Candidate legs: every short-priced selection with a fair probability and the
price at each UK bookie.

Fair probability comes from, in order of trust:
  sharp          Pinnacle's own price for that market, margin removed
  sharp-derived  worked out from Pinnacle's match-result prices (double chance, draw no bet)
  model          the goals model, when Pinnacle doesn't price the market
  consensus      the average of the UK bookies' prices with their margins removed
"""
from __future__ import annotations

from statistics import mean

from .catalog import LEG_DEFS, LEGS_BY_KEY, label, short_market
from .fair import fair_probs

# Team over 0.5 goals settles exactly like team to score: treat them as one leg.
ALIAS_OF = {"tt:1:0.5:over": "ts:1:yes", "tt:2:0.5:over": "ts:2:yes"}
FAMILY_OF = {d.key: d.family for d in LEG_DEFS}
FAMILY_OF["ts:1:yes"] = FAMILY_OF["ts:2:yes"] = "team_to_score"


def _market_fair(book_markets: dict, leg_def, method: str):
    """Fair probabilities for every outcome in a leg's market, or None."""
    prices = book_markets.get(leg_def.market_id) or {}
    if not all(s in prices for s in leg_def.siblings):
        return None
    probs = fair_probs([prices[s] for s in leg_def.siblings], method)
    if probs is None:
        return None
    return dict(zip(leg_def.siblings, probs))


def sharp_probabilities(sharp_markets: dict, method: str) -> dict:
    """{leg_key: (p_win, p_void, source, sharp_price)} from Pinnacle."""
    out = {}
    for d in LEG_DEFS:
        fair = _market_fair(sharp_markets, d, method)
        if fair is None:
            continue
        price = sharp_markets[d.market_id].get(d.outcome_id)
        out[d.key] = (fair[d.outcome_id], 0.0, "sharp", price)

    # Use the match-result market to fill in, or correct, the related markets.
    if all(k in out for k in ("1x2:1", "1x2:X", "1x2:2")):
        p1, px, p2 = out["1x2:1"][0], out["1x2:X"][0], out["1x2:2"][0]
        derived = {
            "dc:1X": (p1 + px, 0.0), "dc:2X": (p2 + px, 0.0), "dc:12": (p1 + p2, 0.0),
            "dnb:1": (p1, px), "dnb:2": (p2, px),
        }
        for key, (pw, pv) in derived.items():
            if key in out and key.startswith("dnb"):
                # DNB market fair price is conditional on no draw; express it unconditionally.
                out[key] = (out[key][0] * (1 - px), px, "sharp", out[key][3])
            elif key not in out:
                out[key] = (pw, pv, "sharp-derived", None)
    for alias, canon in ALIAS_OF.items():
        if alias in out and canon not in out:
            out[canon] = out[alias]
    return out


def consensus_probability(books: dict, soft_books, key: str, method: str):
    d = LEGS_BY_KEY[key]
    vals = []
    for slug in soft_books:
        fair = _market_fair(books.get(slug, {}), d, method)
        if fair:
            vals.append(fair[d.outcome_id])
    return mean(vals) if vals else None


def leg_price(book_markets: dict, key: str):
    """Best price a bookie offers for a leg (checking the alias market too)."""
    keys = [key] + [a for a, c in ALIAS_OF.items() if c == key]
    best = None
    for k in keys:
        d = LEGS_BY_KEY.get(k)
        if d is None:
            continue
        p = (book_markets.get(d.market_id) or {}).get(d.outcome_id)
        if p and (best is None or p > best):
            best = p
    return best


def edge(price, p_win, p_void=0.0):
    return price * p_win + p_void - 1.0


def fair_price(p_win, p_void=0.0):
    return (1.0 - p_void) / p_win if p_win > 0 else None


def build_legs(fixture, books: dict, sharp_book: str, soft_books, settings: dict, model_probs=None):
    """All candidate legs for one fixture."""
    method = settings.get("devig_method", "power")
    leg_cfg = settings["legs"]
    families = set(leg_cfg["markets"])
    sharp = sharp_probabilities(books.get(sharp_book, {}), method)
    keys = {d.key for d in LEG_DEFS if d.key not in ALIAS_OF}
    legs = []
    for key in sorted(keys):
        if FAMILY_OF.get(key) not in families:
            continue
        prices = {}
        for slug in soft_books:
            p = leg_price(books.get(slug, {}), key)
            if p:
                prices[slug] = round(p, 3)
        if not prices:
            continue
        best_book = max(prices, key=prices.get)
        best = prices[best_book]
        if not (leg_cfg["min_price"] <= best <= leg_cfg["max_price"]):
            continue

        model_p = None
        if model_probs and key in model_probs:
            model_p = model_probs[key][0]

        if key in sharp:
            p_win, p_void, source, sharp_price = sharp[key]
        elif model_probs and key in model_probs:
            p_win, p_void = model_probs[key]
            source, sharp_price = "model", None
        else:
            c = consensus_probability(books, soft_books, key, method)
            if c is None:
                continue
            p_win, p_void, source, sharp_price = c, (0.26 * (1 - c) if key.startswith("dnb") else 0.0), "consensus", None
        if p_win < leg_cfg["min_fair_prob"]:
            continue

        edges = {b: round(edge(p, p_win, p_void), 4) for b, p in prices.items()}
        legs.append({
            "id": f"{fixture['id']}|{key}",
            "fixture_id": fixture["id"],
            "key": key,
            "label": label(key, fixture["home"], fixture["away"]),
            "market": short_market(key),
            "p_win": round(p_win, 4),
            "p_void": round(p_void, 4),
            "fair_price": round(fair_price(p_win, p_void), 3),
            "source": source,
            "sharp_price": round(sharp_price, 3) if sharp_price else None,
            "prices": prices,
            "edges": edges,
            "best_book": best_book,
            "best_price": best,
            "best_edge": edges[best_book],
            "model_p": round(model_p, 4) if model_p is not None else None,
        })
    return legs
