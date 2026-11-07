"""Generate realistic fake OddsPapi payloads for offline testing.

Each fixture gets 'true' expected goals; Pinnacle prices carry a ~2.5% margin,
UK bookies ~6% plus noise (so a few legs come out above fair, as in real life).

    python tests/make_mock.py OUT_DIR --now 2026-11-07T08:00:00Z
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from scipy.stats import poisson

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.catalog import LEG_DEFS, prob_from_matrix  # noqa: E402

LEAGUES = [17, 18, 24, 25, 36, 35, 8, 23, 34, 37]
SLOTS = [(12, 30), (15, 0), (15, 0), (15, 0), (17, 30), (19, 45)]


def matrix(lam, mu, n=10):
    g = np.arange(n + 1)
    m = np.outer(poisson.pmf(g, lam), poisson.pmf(g, mu))
    return m / m.sum()


def make(out: Path, now: datetime, n_fixtures=60, seed=7):
    rng = random.Random(seed)
    parts = json.loads((Path(__file__).resolve().parents[1] / "data/ref/participants_10.json").read_text())
    ids = sorted(parts, key=int)[:4000]
    books = {"pinnacle": 0.025, "bet365": 0.06, "skybet": 0.065, "williamhill": 0.07}
    payloads = {b: [] for b in books}
    day = (now + timedelta(days=0)).date()
    for i in range(n_fixtures):
        h, m_ = SLOTS[i % len(SLOTS)]
        ko = datetime(day.year, day.month, day.day, h, m_, tzinfo=timezone.utc)
        if ko < now + timedelta(minutes=30):
            ko += timedelta(days=1)
        lam, mu = rng.uniform(0.7, 2.6), rng.uniform(0.5, 1.8)
        mat = matrix(lam, mu)
        true = {d.key: prob_from_matrix(d.key, mat) for d in LEG_DEFS}
        p1, p2 = rng.sample(ids, 2)
        fixture = {"fixtureId": f"idMOCK{i:04d}", "participant1Id": int(p1), "participant2Id": int(p2),
                   "sportId": 10, "tournamentId": LEAGUES[i % len(LEAGUES)], "seasonId": 1, "statusId": 0,
                   "hasOdds": True, "startTime": ko.isoformat().replace("+00:00", ".000Z"),
                   "trueStartTime": None, "trueEndTime": None, "updatedAt": now.isoformat()}
        for book, margin in books.items():
            markets = {}
            by_market = {}
            for d in LEG_DEFS:
                by_market.setdefault(d.market_id, (d.siblings, {}))[1][d.outcome_id] = true[d.key]
            for mid, (siblings, known) in by_market.items():
                if book != "pinnacle" and rng.random() < 0.1:
                    continue  # bookies don't price everything
                probs = {}
                for oid in siblings:
                    if oid in known:
                        pw, pv = known[oid]
                        probs[oid] = pw / (1 - pv) if pv else pw  # DNB priced conditional on no draw
                if len(probs) < len(siblings):  # two-way market: the missing side is the complement
                    missing = [o for o in siblings if o not in probs]
                    probs[missing[0]] = max(0.01, 1 - sum(probs.values()))
                mk = markets.setdefault(mid, {"bookmakerMarketId": "x", "marketActive": True, "outcomes": {}})
                for oid, p in probs.items():
                    noise = rng.gauss(0, 0.025) if book != "pinnacle" else rng.gauss(0, 0.006)
                    price = max(1.01, round(1 / (p * (1 + margin)) * (1 + noise), 2))
                    mk["outcomes"][oid] = {"players": {"0": {"active": True, "price": price,
                                                             "bookmakerOutcomeId": "x", "limit": 1000}}}
            fx = dict(fixture)
            fx["bookmakerOdds"] = {book: {"bookmakerIsActive": True, "suspended": False, "markets": markets}}
            payloads[book].append(fx)
    out.mkdir(parents=True, exist_ok=True)
    for b, p in payloads.items():
        (out / f"{b}.json").write_text(json.dumps(p))
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--now", default="2026-11-07T08:00:00Z")
    a = ap.parse_args()
    make(a.out, datetime.fromisoformat(a.now.replace("Z", "+00:00")))
    print("mock payloads written to", a.out)
