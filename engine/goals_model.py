"""Dixon-Coles goals model: a second opinion on the market.

Each team gets an attack and a defence rating, fitted to recent results with
older games counting less (half-life in days). A small correction (rho) fixes
the classic Poisson under-count of 0-0, 1-0, 0-1 and 1-1.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.optimize import minimize
from scipy.stats import poisson

MAX_GOALS = 10


@dataclass
class TeamRatings:
    teams: list[str]
    attack: np.ndarray
    defence: np.ndarray
    home_adv: float
    rho: float
    matches_per_team: dict[str, int]

    def index(self, team: str) -> int | None:
        try:
            return self.teams.index(team)
        except ValueError:
            return None

    def expected_goals(self, home: str, away: str):
        i, j = self.index(home), self.index(away)
        if i is None or j is None:
            return None
        lam = math.exp(self.attack[i] + self.defence[j] + self.home_adv)
        mu = math.exp(self.attack[j] + self.defence[i])
        return lam, mu

    def score_matrix(self, home: str, away: str):
        xg = self.expected_goals(home, away)
        if xg is None:
            return None
        lam, mu = xg
        g = np.arange(MAX_GOALS + 1)
        m = np.outer(poisson.pmf(g, lam), poisson.pmf(g, mu))
        m[0, 0] *= 1 - lam * mu * self.rho
        m[0, 1] *= 1 + lam * self.rho
        m[1, 0] *= 1 + mu * self.rho
        m[1, 1] *= 1 - self.rho
        m = np.clip(m, 0, None)
        return m / m.sum()


def _tau(hg, ag, lam, mu, rho):
    t = np.ones_like(lam)
    t = np.where((hg == 0) & (ag == 0), 1 - lam * mu * rho, t)
    t = np.where((hg == 0) & (ag == 1), 1 + lam * rho, t)
    t = np.where((hg == 1) & (ag == 0), 1 + mu * rho, t)
    t = np.where((hg == 1) & (ag == 1), 1 - rho, t)
    return np.clip(t, 1e-10, None)


def fit(results: pd.DataFrame, today, half_life_days: float = 180.0) -> TeamRatings | None:
    df = results.dropna(subset=["hg", "ag"]).copy()
    df = df[df["date"] <= pd.Timestamp(today)]
    if len(df) < 40:
        return None
    teams = sorted(set(df["home"]).union(df["away"]))
    idx = {t: k for k, t in enumerate(teams)}
    n = len(teams)
    hi = df["home"].map(idx).to_numpy()
    ai = df["away"].map(idx).to_numpy()
    hg = df["hg"].to_numpy(dtype=float)
    ag = df["ag"].to_numpy(dtype=float)
    age = (pd.Timestamp(today) - df["date"]).dt.days.to_numpy(dtype=float)
    w = np.exp(-math.log(2) / half_life_days * age)

    lg_h = np.array([math.lgamma(x + 1) for x in hg])
    lg_a = np.array([math.lgamma(x + 1) for x in ag])

    def unpack(x):
        att = x[:n] - x[:n].mean()   # attack ratings sum to zero
        dfn = x[n:2 * n]
        return att, dfn, x[2 * n], x[2 * n + 1]

    def nll(x):
        att, dfn, home, rho = unpack(x)
        lam = np.exp(att[hi] + dfn[ai] + home)
        mu = np.exp(att[ai] + dfn[hi])
        ll = (hg * np.log(lam) - lam - lg_h) + (ag * np.log(mu) - mu - lg_a)
        ll += np.log(_tau(hg, ag, lam, mu, rho))
        return -np.sum(w * ll) + 1e-3 * np.sum(x[:2 * n] ** 2)  # light ridge for stability

    x0 = np.concatenate([np.zeros(n), np.zeros(n), [0.25, -0.05]])
    bounds = [(-3, 3)] * (2 * n) + [(-1, 1), (-0.3, 0.3)]
    res = minimize(nll, x0, method="L-BFGS-B", bounds=bounds, options={"maxiter": 400})
    att, dfn, home, rho = unpack(res.x)
    counts = pd.concat([df["home"], df["away"]]).value_counts().to_dict()
    return TeamRatings(teams, att, dfn, float(home), float(rho), {t: int(counts.get(t, 0)) for t in teams})
