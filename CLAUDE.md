# Evens: notes for Claude sessions

Owner: Joseph (manages everything from his phone via the Claude app). Plain English, UK betting terms, decimal odds by default.

## Layout
- `engine/`: Python, run daily by `.github/workflows/refresh.yml`
  - `oddspapi.py` API client. NEVER write the raw `/account` payload anywhere: it contains the API key and email, and this repo is public.
  - `budget.py` free plan is 250 requests/month. Costs: fixtures list 1; Pinnacle `odds-by-tournaments` 1 per 5 tournaments (hard API limit) and exactly one bookmaker per call; per-match `/odds` 1 each (returns all bookies).
  - `catalog.py` leg keys, OddsPapi market/outcome IDs, settlement rules
  - `legs.py` fair probabilities (Pinnacle de-vig: power method) and per-bookie edges
  - `goals_model.py` Dixon-Coles on football-data.co.uk; `names.py` team-name matching
  - `builder.py` slips: one bookie, different matches, kick-off window, odds band
  - `settle.py` track record + calibration; `run.py` orchestrates
  - `scores.py` live scores + 90-minute results, run every 10 min (11:00–23:59 UTC) by `.github/workflows/scores.yml`. Calls nothing unless a tracked fixture is live or awaiting a result. Feeds: API-Football (secret `API_FOOTBALL_KEY`, 100/day, `/status` free; free plan may refuse the current season, in which case it stops for the day and notes it in `live.json` `feeds`) and football-data.org (secret `FOOTBALL_DATA_API`, 10/min, 12 big competitions, slightly delayed). NEVER write the API-Football `/status` account block (it has the email). Writes `docs/data/live.json` and `data/scores_state.json`, and re-settles `history.json`; the morning run also settles from `scores_state.json` before falling back to football-data.co.uk.
- `docs/`: static PWA on GitHub Pages (`index.html`, `app.css` tokens in `:root`, `app.js`). Reads `docs/data/latest.json`, `history.json` and `live.json` (re-checked every 90s while open).
  - Round 2 (7 Nov 2026, project doc `claude/evens-bandit-handoff.md` items 0–10) is built: 4–5 short legs (sweet spot 1.14–1.26, `bandFit` in app.js mirrors `builder.band_fit`), fixture line + label fitting on reels, printed ticket (Copy/Share/Placed it), fractional odds by default (`toFraction`, ≈ when not an exact ladder price), Held state, draggable lever, staggered stops + Web Audio sound + jackpot, nudges (3 per pull), fair-price line, min edge +1% with "Thin pickings", shorter doors. Prefs in localStorage `evens.prefs` `{odds_format, sound, vibration, min_edge, legs_per_slip, sweet_spot}`. Item 11 (live sweat mode) is built too: while a placed bet's games are on, the machine (`.cabinet.sweating`) shows its legs live (pulsing = in play, ✓ IN, ✗ OUT), the marquee reads "N OF M IN", and "Spin a new slip" / "Watch your bet live" switch between the two; a watched bet that pays out fires the jackpot.
  - Round 3 (7 Nov 2026, design chat): **game select** chip row under the marquee (All · Prem · EFL · Cups · Scotland · Euro nights · Abroad · Others; `COMPS` in app.js groups OddsPapi tournament ids). First tap focuses one competition, further taps add/remove, All clears. Stored in `evens.prefs.comps`; filters `pool()` (so spins, Build a bet and Today's slips). Changing it rebuilds the slip (`rebuildSlip` → `pickFresh`) and plays the reel animation (`playSpin`, split out of `pull`). **Bookie pill** next to the kick-off line opens the where sheet; "☆ Make X my bookie" sets `evens.prefs.fav_book` (also in Settings). The machine loads your bookie first and falls back with a one-off note when it can't make a slip. NFL/other sports not built: needs a budget decision from Joseph (same OddsPapi plan, 250 requests/month).
  - Bet365 coverage is thin in OddsPapi: on 7 Nov 2026 it priced 2 of 22 matches (goals markets only), so it usually can't make a slip.
  - Look: **The Bandit** (pub fruit machine), chosen 7 Nov 2026. Spec: project doc `claude/evens-bandit-handoff.md`; designs on the canvas artifact (TheBandit.dc.html, BuildABet.dc.html). Fonts self-hosted in `docs/fonts/` (Bungee, Barlow Condensed, Share Tech Mono; OFL).
  - Pages are hash routes: `#home` (the machine), `#play` (today's slips), `#build` (Build a bet), `#winnings` (my bets), `#payout` (the model's record). No tab bar.
  - Shared slip state in localStorage `evens.slip`: `{window_id, bookie, stake, legs: [{fixture_id, leg_id, held}]}`, written by both the machine and Build a bet.
  - Reels spin on the phone from `latest.json` `windows[]` leg pools (built by `engine/pools.py`): evens zone 1.90–2.30, one leg per match, one bookie, weighted towards higher edge.
  - Winnings shows each placed leg's live state (✓ landed / ✗ gone / ▲ on track / ▼ behind) and settles placed bets from the scores unless Joseph set the result himself (`bet.manual`). A "Your bets live" LED ticker sits below the doors on the machine.
- `config/settings.json`: leagues (with priority tiers), UK bookies, slip rules, budget weights.
- `data/`: state, snapshot, run log, reference caches (participants, markets, tournaments).

## Facts learned from the live API (Nov 2026)
- Sky Bet and William Hill are not in OddsPapi data. `odds-by-tournaments` for bet365 returns very thin markets; use per-match `/odds` for UK books.
- 4xx responses still count against the quota.
- Market IDs: 101 1X2, 101902 double chance, 10214 DNB, 106/108/1010/1012/1014 totals 0.5–4.5, 10224/10240 team over 0.5, 10284/10286 team to score, 104 BTTS, AH market 1084 = home +1.5, 1060 outcome 1061 = away +1.5.

## Working rules
- Test before pushing: `python -m pytest -q tests`; offline run with `tests/make_mock.py` + `engine.run --mock` (writes to /tmp).
- Scores check by hand: `gh workflow run scores.yml -R JONeillio/evens-model` (calls both feeds once). Offline: `python -m engine.scores --mock DIR --root OUT --now ...` (see `tests/test_scores.py`).
- Live runs cost requests. Trigger with `gh workflow run refresh.yml -R JONeillio/evens-model` only when needed; `-f task=probe` costs 1.
- Rebuild on GitHub with no odds requests (e.g. after engine changes): `gh api -X POST repos/JONeillio/evens-model/actions/workflows/refresh.yml/dispatches -f ref=main -f 'inputs[task]=rebuild'`. (`gh workflow run` fails here: no GraphQL.)
- Rebuild the app's data offline with no API calls: copy `data/snapshot.json` to `OUT/data/` and run `python -m engine.run --reuse-snapshot --out OUT`.
- Joseph asked to be consulted before switching odds provider.
- Bump `VERSION` in `docs/sw.js` whenever app files change so phones pick up the update.
