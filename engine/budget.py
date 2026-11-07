"""Keep OddsPapi usage inside the free monthly allowance.

Each odds pull is one request per bookie (per chunk of leagues). Before every
run we check how many requests are left this month and how many scheduled runs
remain, then decide how many bookies we can afford this time.
"""
from __future__ import annotations

import calendar
import math
from datetime import datetime

# Average scheduled runs per day (daily morning run plus a Saturday top-up).
RUNS_PER_DAY = 8 / 7


def usage_from_account(account: dict | None, fallback_limit: int) -> dict:
    sub = ((account or {}).get("subscriptions") or [{}])[0]
    limit = sub.get("request_limit") or fallback_limit
    used = sub.get("request_count") or 0
    return {"plan": sub.get("plan"), "limit": int(limit), "used": int(used), "remaining": int(limit) - int(used)}


def plan_run(usage: dict, now: datetime, n_tournaments: int, soft_books: list[str], cfg: dict,
             manual: bool = False) -> dict:
    chunks = max(1, math.ceil(n_tournaments / cfg["max_tournaments_per_call"]))
    days_in_month = calendar.monthrange(now.year, now.month)[1]
    days_left = days_in_month - now.day + 1
    runs_left = max(1.0, days_left * RUNS_PER_DAY)
    spendable = usage["remaining"] - cfg["reserve"]
    fair_share = spendable / runs_left
    # A manual refresh may spend up to two scheduled runs' worth.
    allowance = min(cfg["max_calls_per_run"], math.floor(fair_share * (2 if manual else 1)))
    allowance = min(allowance, spendable)

    books_affordable = allowance // chunks - 1  # minus the sharp book
    books = soft_books[: max(0, books_affordable)]
    fetch = books_affordable >= 1
    return {
        "fetch": fetch,
        "books": books,
        "chunks": chunks,
        "planned_calls": (1 + len(books)) * chunks if fetch else 0,
        "allowance": allowance,
        "remaining": usage["remaining"],
        "runs_left": round(runs_left, 1),
        "reason": "ok" if fetch else "saving requests for the rest of the month",
    }
