"""Keep OddsPapi usage inside the free monthly allowance (250 requests).

Costs per run:
  1 request   to list the next 48 hours of fixtures (tells us which leagues play)
  1 request   per bookie per 5 leagues (OddsPapi's limit per odds request)

Saturdays get the biggest share of the month's requests, quiet weekdays the
least, and every run checks how many requests are actually left first.
"""
from __future__ import annotations

import calendar
import math
from datetime import date, datetime, timedelta

DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def usage_from_account(account: dict | None, fallback_limit: int) -> dict:
    sub = ((account or {}).get("subscriptions") or [{}])[0]
    limit = sub.get("request_limit") or fallback_limit
    used = sub.get("request_count") or 0
    return {"plan": sub.get("plan"), "limit": int(limit), "used": int(used), "remaining": int(limit) - int(used)}


def remaining_weight(today: date, weights: dict) -> float:
    last = calendar.monthrange(today.year, today.month)[1]
    total, d = 0.0, today
    while d.month == today.month and d.day <= last:
        total += weights.get(DAY_NAMES[d.weekday()], 1)
        d += timedelta(days=1)
    return total


def fetch_days(cfg: dict) -> list[str]:
    """The weekdays a morning run asks for new prices (weight above zero). The app uses
    this to say when odds are next due on a quiet day."""
    weights = cfg.get("weekday_weights", {})
    return [d for d in DAY_NAMES if weights.get(d, 1) > 0]


def allowance(usage: dict, now: datetime, cfg: dict, manual: bool = False) -> dict:
    weights = cfg.get("weekday_weights", {})
    today_w = weights.get(DAY_NAMES[now.weekday()], 1)
    spendable = usage["remaining"] - cfg["reserve"]
    share = spendable * today_w / max(today_w, remaining_weight(now.date(), weights), 1e-9)
    if manual:  # an extra, by-hand refresh: allow up to half a normal day's share
        share = max(share * 0.5, 4)
    allow = int(min(cfg["max_calls_per_run"], math.floor(share), max(0, spendable)))
    return {"allowance": allow, "remaining": usage["remaining"], "share": round(share, 1), "weekday_weight": today_w}


def choose(allow_after_fixtures: int, n_chunks: int, soft_books: list[str], min_chunks: int = 3):
    """Cover the top leagues (first `min_chunks` groups of 5) with every bookie if we
    can; otherwise drop bookies before dropping leagues. Returns (books, chunks)."""
    if n_chunks <= 0:
        return [], 0
    target = min(n_chunks, min_chunks)
    for n_soft in range(len(soft_books), 0, -1):
        chunks = min(n_chunks, allow_after_fixtures // (1 + n_soft))
        if chunks >= target:
            return soft_books[:n_soft], chunks
    chunks = min(n_chunks, allow_after_fixtures // 2)
    return (soft_books[:1], chunks) if chunks >= 1 else ([], 0)
