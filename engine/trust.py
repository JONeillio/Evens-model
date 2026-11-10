"""How much of a claimed edge to believe.

A leg's "edge" is our fair chance times the bookie's price, minus 1. The first
weekend's results (7-9 Nov 2026, 2,148 settled legs) showed claimed edges above
zero did not turn up at face value: 22 legs claiming +13% on average returned
about +2%, and 42 claiming +1% to +5% returned about -5%. A big claimed edge is
more often a stale price or news we don't have than a gift.

So before ranking or showing a slip, a positive edge is shrunk:
  believed = trust(source) x (edge up to `soft_cap` + `beyond_cap` x the rest)
Edges at or below zero are left alone (a bad price is never flattered).
`trust` depends on where the fair chance came from: Pinnacle with the margin
taken out is the most reliable, our own model alone the least.

The app mirrors this in docs/app.js (believed()); the numbers live in
config/settings.json `trust` and are published in latest.json so the two agree.
"""
from __future__ import annotations

DEFAULT = {
    "sharp": 0.8, "sharp-derived": 0.7, "sharp+model": 0.5, "consensus": 0.4,
    "market+model": 0.4, "model": 0.25, "other": 0.4,
    "soft_cap": 0.03, "beyond_cap": 0.25,
}


def believed_edge(edge: float, source: str | None, cfg: dict | None = None) -> float:
    cfg = {**DEFAULT, **(cfg or {})}
    if edge <= 0:
        return edge
    t = cfg.get(source or "other", cfg["other"])
    cap = cfg["soft_cap"]
    return t * (min(edge, cap) + cfg["beyond_cap"] * max(0.0, edge - cap))


def believed(price: float, p_win: float, p_void: float, source: str | None, cfg: dict | None = None):
    """(value, p_win) after trust: value = price x p_win + p_void, the leg's factor in a slip's EV."""
    value = price * p_win + p_void
    eh = believed_edge(value - 1, source, cfg)
    return 1 + eh, p_win - (value - 1 - eh) / price
