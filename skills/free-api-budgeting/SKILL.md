---
name: free-api-budgeting
description: Stay inside free-tier API quotas (e.g. 250 requests/month) — a call logger, pre-flight quota check, weekday-weighted daily allowance, and rules for what to drop first. Use before integrating any metered or rate-limited API.
---

# Rationing a free API plan

Learned on OddsPapi (250 requests/month), API-Football (100/day) and football-data.org (10/min). The same patterns apply to any metered API (eBird, weather, maps, etc.). Verify each API's real costs with a probe before designing around it.

## Before writing code
1. **Probe cheaply.** Add a `probe` task that spends 1–9 requests to learn what the API really returns (which providers, which markets/fields, how thin the data is). Save the output in `data/discovery/` and read it before designing.
2. **Write the cost table down** in `CLAUDE.md` / `budget.py` docstring: what each endpoint costs and any hard limits (e.g. "1 request per 5 tournaments", "exactly one bookmaker per call"). Assumptions here are where budgets blow up.
3. **Check what counts.** In OddsPapi, 4xx responses still consume quota. Don't retry blindly.
4. **Learn what is NOT available** and record it (e.g. Sky Bet and William Hill absent; Bet365 very thin on bulk endpoints, use per-item calls). Don't rediscover this each session.

## The client
- Wrap the API in one thin client that **logs every call** (`endpoint, params, status, seconds, billable`), enforces the documented **cooldown between calls** (pad it ~10%), retries a network blip once, and raises a distinct `QuotaExhausted` on the quota error.
- Mark unmetered endpoints (e.g. `account`) so they don't count.
- Never log the key; never persist account payloads.

## The allowance (`budget.py` pattern)
- Read the real remaining quota from the API at the start of each run (don't trust your own counter).
- `spendable = remaining − reserve`.
- Weight days of the week (heavier on days that matter, e.g. Saturday) and give today `spendable × today_weight / remaining_weight_this_month`.
- Cap by `max_calls_per_run`. Manual runs get half a normal day's share (minimum a few calls), or an explicit `--calls N` override.
- When short: **drop breadth before depth** — fewer bookies/sources before fewer top-priority competitions. Core groups are fetched first, leftover allowance goes to the long tail by priority.

## Make every request count
- Prefer bulk endpoints (many items per request) over per-item calls; use per-item calls only where bulk is thin.
- Keep a snapshot so re-computation costs 0 requests.
- Polling: check local state first, call nothing unless something is due. A live-scores job that runs every 10 minutes but only calls when a tracked fixture is in play costs almost nothing.
- Check cheap free endpoints (e.g. `/status`) once a day, not per run.
- Stop asking a feed that has refused you (plan/season limit) until tomorrow.

## Decisions to take to the owner, not make silently
- Switching or adding a data provider, or spending beyond the plan. (Joseph asked to be consulted first.)
