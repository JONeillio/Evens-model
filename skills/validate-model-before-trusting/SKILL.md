---
name: validate-model-before-trusting
description: Test a predictive model honestly before showing its numbers — walk-forward backtest, compare against the market, calibrate, shrink over-confidence. Use when building any projection or probability model for the UI.
---

# Validate first, then show

Lessons from the Evens NFL player model and the football goals model.

## Method
1. **Stats first, prices later.** Project what will happen from data alone, then compare with market prices. This keeps the model from just echoing the bookie.
2. **Tune on one season, confirm on an unseen one** (tuned on 2024, tested on 2025). Report the typical miss next to a naive baseline (e.g. the player's recent average), not in isolation.
3. **Walk-forward**: only use information that existed at the time. Store the table of real misses (actual ÷ expected) and price any line from that spread.
4. **Test one change at a time** and keep the result. Heavier opponent weighting tested *worse*, so it was reverted; last-3-games momentum helped rushing only, so it's used for rushing only.
5. **Look for bugs when output is systematically off.** A share-shrinkage bug had receivers/RBs projected ~45% low; it only showed up by comparing with real averages.
6. **Check calibration**: do 70% calls land ~70%? Evens' calls were well calibrated 20–60% and over-confident above 65%, so those get pulled 15% toward 50% (`CAL_SHRINK`).

## Compare with the market
- A sharp bookmaker's line (Pinnacle) is the exam. If the model can't beat it, price from it. The team spread/total model missed results by 10.3 points vs the line's 9.9, and covered only 48% when it disagreed by 3+ points, so spread and total stay priced off Pinnacle (margin removed).
- Remove the margin properly (power method de-vig) before treating a price as a probability.
- **Anchor to the market, let the model earn weight**: 75% market / 25% model where a sharp line exists, 50/50 on a UK-book average, model alone otherwise.
- If model and market disagree by more than ~45%, skip the item — it's usually news the model doesn't have.

## Be honest in the UI and docs
- Free historical odds for the more obscure markets don't exist, so profit can only be tested going forward: keep a live record and calibration table and show it.
- State plainly where there's likely no edge (margins compound across legs; fat prop margins).
- Surface "thin pickings" rather than forcing a pick when nothing meets the minimum edge.
- Keep legs independent (one per match) when you multiply probabilities.
