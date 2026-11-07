"""Turn bookmaker prices into fair probabilities by removing the margin."""
from __future__ import annotations

import math


def implied(prices):
    return [1.0 / p for p in prices]


def overround(prices) -> float:
    """Booksum minus one, e.g. 0.05 means a 5% margin."""
    return sum(implied(prices)) - 1.0


def devig_multiplicative(prices):
    imp = implied(prices)
    total = sum(imp)
    return [x / total for x in imp]


def devig_power(prices, tol=1e-10, max_iter=100):
    """Find k so that sum(implied_i ** k) == 1.

    Shades longshots more than favourites, which matches the
    favourite-longshot bias seen in real betting markets.
    """
    imp = implied(prices)
    if abs(sum(imp) - 1.0) < 1e-12:
        return imp
    lo, hi = 0.5, 3.0
    for _ in range(max_iter):
        k = (lo + hi) / 2
        s = sum(x ** k for x in imp)
        if abs(s - 1.0) < tol:
            break
        if s > 1.0:
            lo = k
        else:
            hi = k
    probs = [x ** k for x in imp]
    total = sum(probs)
    return [p / total for p in probs]


def _shin_probs(imp, booksum, z):
    return [
        (math.sqrt(z * z + 4 * (1 - z) * (x * x) / booksum) - z) / (2 * (1 - z))
        for x in imp
    ]


def devig_shin(prices, tol=1e-12, max_iter=200):
    """Shin (1993): models the margin as the bookie's protection against insiders.

    Solve for the insider share z so the probabilities sum to one (bisection;
    the sum falls as z rises).
    """
    imp = implied(prices)
    booksum = sum(imp)
    if booksum <= 1.0:
        return [x / booksum for x in imp]
    lo, hi = 0.0, 0.4
    for _ in range(max_iter):
        z = (lo + hi) / 2
        s = sum(_shin_probs(imp, booksum, z))
        if abs(s - 1.0) < tol:
            break
        if s > 1.0:
            lo = z
        else:
            hi = z
    probs = _shin_probs(imp, booksum, z)
    total = sum(probs)
    return [p / total for p in probs]


METHODS = {
    "multiplicative": devig_multiplicative,
    "power": devig_power,
    "shin": devig_shin,
}


def fair_probs(prices, method: str = "power"):
    if not prices or any((p is None or p <= 1.0) for p in prices):
        return None
    return METHODS[method](list(prices))


def edge(price: float, fair_p: float) -> float:
    """Expected profit per £1 staked: +0.03 means +3%."""
    return price * fair_p - 1.0
