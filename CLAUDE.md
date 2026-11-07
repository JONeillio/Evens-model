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
- `docs/`: static PWA on GitHub Pages (`index.html`, `app.css` tokens in `:root`, `app.js`). Reads `docs/data/latest.json` and `history.json`.
- `config/settings.json`: leagues (with priority tiers), UK bookies, slip rules, budget weights.
- `data/`: state, snapshot, run log, reference caches (participants, markets, tournaments).

## Facts learned from the live API (Nov 2026)
- Sky Bet and William Hill are not in OddsPapi data. `odds-by-tournaments` for bet365 returns very thin markets; use per-match `/odds` for UK books.
- 4xx responses still count against the quota.
- Market IDs: 101 1X2, 101902 double chance, 10214 DNB, 106/108/1010/1012/1014 totals 0.5–4.5, 10224/10240 team over 0.5, 10284/10286 team to score, 104 BTTS, AH market 1084 = home +1.5, 1060 outcome 1061 = away +1.5.

## Working rules
- Test before pushing: `python -m pytest -q tests`; offline run with `tests/make_mock.py` + `engine.run --mock` (writes to /tmp).
- Live runs cost requests. Trigger with `gh workflow run refresh.yml -R JONeillio/evens-model` only when needed; `-f task=probe` costs 1.
- A separate design session may produce a Design System for the app; apply it via the CSS tokens in `docs/app.css`.
