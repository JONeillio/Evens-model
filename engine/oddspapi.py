"""Thin OddsPapi v4 client.

Every billable call costs one request from the monthly free allowance, so this
client keeps a log of each call, respects the per-endpoint cooldowns, and never
writes the API key anywhere.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

import requests

BASE = "https://api.oddspapi.io/v4"
# Documented cooldowns: fixtures 2000 ms, most others 1000 ms. Pad them a little.
COOLDOWN_S = {"fixtures": 2.2}
DEFAULT_COOLDOWN_S = 1.2
UNMETERED = {"account"}


class QuotaExhausted(RuntimeError):
    pass


@dataclass
class CallRecord:
    endpoint: str
    params: dict
    status: int
    seconds: float
    billable: bool
    note: str = ""


@dataclass
class OddsPapi:
    key: str | None = None
    timeout: int = 60
    calls: list[CallRecord] = field(default_factory=list)
    _last_call_at: float = 0.0

    def __post_init__(self):
        self.key = self.key or os.environ.get("ODDSPAPI_KEY")
        if not self.key:
            raise RuntimeError("ODDSPAPI_KEY is not set (add it as a GitHub Actions secret).")

    # -- plumbing ---------------------------------------------------------
    def _wait(self, endpoint: str) -> None:
        gap = COOLDOWN_S.get(endpoint, DEFAULT_COOLDOWN_S)
        elapsed = time.monotonic() - self._last_call_at
        if elapsed < gap:
            time.sleep(gap - elapsed)

    def get(self, endpoint: str, **params):
        self._wait(endpoint)
        clean = {k: v for k, v in params.items() if v is not None}
        started = time.monotonic()
        attempt = 0
        while True:
            attempt += 1
            try:
                resp = requests.get(
                    f"{BASE}/{endpoint}",
                    params={**clean, "apiKey": self.key},
                    timeout=self.timeout,
                )
            except requests.RequestException as exc:  # network blip: one retry
                if attempt < 2:
                    time.sleep(3)
                    continue
                self._record(endpoint, clean, 0, started, f"network error: {type(exc).__name__}")
                raise RuntimeError(f"OddsPapi {endpoint}: network error") from None
            self._last_call_at = time.monotonic()
            if resp.status_code == 429:
                body = _safe_text(resp)
                if "REQUEST_LIMIT_EXCEEDED" in body:
                    self._record(endpoint, clean, 429, started, "quota exhausted")
                    raise QuotaExhausted("OddsPapi monthly request limit reached")
                if attempt < 3:  # cooldown hit: wait and retry
                    time.sleep(2.5 * attempt)
                    continue
            note = "" if resp.ok else _safe_text(resp)[:300]
            self._record(endpoint, clean, resp.status_code, started, note)
            if not resp.ok:
                raise RuntimeError(f"OddsPapi {endpoint} returned {resp.status_code}: {note}")
            return resp.json()

    def _record(self, endpoint, params, status, started, note):
        self.calls.append(
            CallRecord(
                endpoint=endpoint,
                params=params,
                status=status,
                seconds=round(time.monotonic() - started, 2),
                billable=endpoint not in UNMETERED,
                note=note,
            )
        )

    @property
    def billable_calls(self) -> int:
        return sum(1 for c in self.calls if c.billable and c.status != 0)

    # -- endpoints ----------------------------------------------------------
    def account(self):
        return self.get("account")

    def bookmakers(self):
        return self.get("bookmakers")

    def tournaments(self, sport_id: int):
        return self.get("tournaments", sportId=sport_id)

    def markets(self):
        return self.get("markets")

    def participants(self, sport_id: int):
        return self.get("participants", sportId=sport_id)

    def odds_by_tournaments(self, tournament_ids, bookmaker: str | None = None, odds_format="decimal"):
        ids = ",".join(str(i) for i in tournament_ids)
        return self.get("odds-by-tournaments", tournamentIds=ids, bookmaker=bookmaker, oddsFormat=odds_format)

    def fixtures(self, **params):
        return self.get("fixtures", **params)


def _safe_text(resp) -> str:
    try:
        text = resp.text
    except Exception:  # pragma: no cover
        return ""
    key = os.environ.get("ODDSPAPI_KEY")
    return text.replace(key, "***") if key else text
