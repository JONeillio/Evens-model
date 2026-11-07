# Evens

A free phone app that suggests near-evens football accumulators: 4–5 short-priced legs from different matches, all kicking off around the same time and all at one bookie, multiplying to about 2.0.

**Open the app:** https://joneillio.github.io/Evens-model/ (in Chrome on your phone, menu, then **Add to home screen**).

## How it works

Every morning at about 07:15 a GitHub job (free) runs `engine/`:

1. **Fixtures:** lists the next 48 hours of fixtures across about 28 leagues and cups (1 request).
2. **Fair prices:** pulls Pinnacle's prices for every league with games (1 request per 5 leagues) and removes the margin. Pinnacle is the sharpest bookmaker, so these are the best guide to real chances.
3. **Shortlist and UK prices:** picks the matches with the most short-priced legs, grouped by kick-off time, and pulls every UK bookie's prices for them (1 request per match).
4. **Second opinion:** a goals model (Dixon-Coles) built from two seasons of results on football-data.co.uk.
5. **Slips:** builds near-evens slips per bookie and ranks them by edge (expected gain or loss per £1).
6. **Track record:** publishes the model's top slip per kick-off time and settles it from the results.

The results land in `docs/data/`, and the app in `docs/` reads them.

## The app

| Tab | What it does |
|---|---|
| Today | Best slips for each kick-off time at your bookies |
| Build | Change the number of legs, odds range, minimum chance and edge, kick-off spread, bookies and markets; slips update instantly |
| Legs | Every candidate leg with fair price, each bookie's price and edge; lock or remove legs for the builder |
| My bets | Log bets, settle them, see profit and loss, monthly limit and a 50-slip simulation. Stored on your phone only (back it up) |
| Record | The model's own slips, settled, plus a calibration chart (does "85%" really happen 85% of the time?) |

## Costs and limits

Everything is free: GitHub (public repo, Actions, Pages), OddsPapi's free plan (250 requests/month), and football-data.co.uk.

The budget guard in `engine/budget.py` spends most requests on Saturdays and checks what's left before every run. Sky Bet and William Hill aren't in OddsPapi's data.

## Run by hand

Go to GitHub, open **Actions**, choose **Refresh odds and slips**, then tap **Run workflow**. Each manual run uses about 10 requests.

## Settings

`config/settings.json` holds leagues and their priority tiers, bookies, slip rules and the budget.

## Developing

```
pip install -r requirements.txt pytest
python -m pytest -q tests
python tests/make_mock.py /tmp/mock && python -m engine.run --mock /tmp/mock --now 2026-11-07T08:00:00Z
```

Mock runs write to `/tmp/evens_mock_out`, never into the repo.

This is an independent tool, not betting advice. Bookies' margins mean most accumulators lose over time; the app shows that honestly. Set a limit you're happy to lose.
