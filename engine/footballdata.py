"""Free results history from football-data.co.uk (used for the goals model and
for settling the model's own slips)."""
from __future__ import annotations

import io
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import requests

URL = "https://www.football-data.co.uk/mmz4281/{season}/{div}.csv"


def season_code(d: date) -> str:
    start = d.year if d.month >= 7 else d.year - 1
    return f"{start % 100:02d}{(start + 1) % 100:02d}"


def previous_season_code(code: str) -> str:
    start = int(code[:2])
    prev = (start - 1) % 100
    return f"{prev:02d}{start:02d}"


def _parse(text: str) -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(text), on_bad_lines="skip")
    df = df.rename(columns=lambda c: str(c).strip().lstrip("﻿"))
    need = {"Date", "HomeTeam", "AwayTeam"}
    if not need.issubset(df.columns):
        return pd.DataFrame(columns=["date", "home", "away", "hg", "ag"])
    out = pd.DataFrame({
        "date": pd.to_datetime(df["Date"], dayfirst=True, errors="coerce"),
        "home": df["HomeTeam"].astype(str).str.strip(),
        "away": df["AwayTeam"].astype(str).str.strip(),
        "hg": pd.to_numeric(df.get("FTHG"), errors="coerce"),
        "ag": pd.to_numeric(df.get("FTAG"), errors="coerce"),
    })
    return out.dropna(subset=["date"])


class FootballData:
    """Downloads and caches league CSVs for one engine run."""

    def __init__(self, cache_dir: Path, offline: bool = False):
        self.cache_dir = Path(cache_dir)
        self.offline = offline
        self._mem: dict[tuple[str, str], pd.DataFrame] = {}
        self.errors: list[str] = []

    def league(self, div: str, season: str) -> pd.DataFrame:
        key = (div, season)
        if key in self._mem:
            return self._mem[key]
        path = self.cache_dir / f"{season}_{div}.csv"
        text = None
        if not self.offline:
            try:
                r = requests.get(URL.format(season=season, div=div), timeout=30,
                                 headers={"User-Agent": "evens-builder/1.0"})
                if r.ok and "HomeTeam" in r.text[:500]:
                    text = r.content.decode("latin-1")
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(text, encoding="utf-8")
                else:
                    self.errors.append(f"{div} {season}: HTTP {r.status_code}")
            except requests.RequestException as exc:
                self.errors.append(f"{div} {season}: {type(exc).__name__}")
        if text is None and path.exists():
            text = path.read_text(encoding="utf-8")
        df = _parse(text) if text else pd.DataFrame(columns=["date", "home", "away", "hg", "ag"])
        self._mem[key] = df
        return df

    def results(self, div: str, today: date, seasons_back: int = 2) -> pd.DataFrame:
        code = season_code(today)
        frames = []
        for _ in range(max(1, seasons_back)):
            frames.append(self.league(div, code))
            code = previous_season_code(code)
        frames = [f for f in frames if len(f)]
        if not frames:
            return pd.DataFrame(columns=["date", "home", "away", "hg", "ag"])
        df = pd.concat(frames, ignore_index=True)
        return df.sort_values("date").reset_index(drop=True)

    def current_teams(self, div: str, today: date) -> list[str]:
        df = self.league(div, season_code(today))
        if df.empty:  # early season: fall back to last season's teams
            df = self.league(div, previous_season_code(season_code(today)))
        return sorted(set(df["home"]).union(df["away"]))

    def find_result(self, div: str, home: str, away: str, kickoff: datetime):
        """Full-time score for a fixture, or None if not published yet."""
        day = kickoff.date()
        df = self.league(div, season_code(day))
        if df.empty:
            return None
        played = df.dropna(subset=["hg", "ag"])
        window = played[(played["date"].dt.date >= day.fromordinal(day.toordinal() - 1))
                        & (played["date"].dt.date <= day.fromordinal(day.toordinal() + 1))]
        hit = window[(window["home"] == home) & (window["away"] == away)]
        if hit.empty:
            return None
        row = hit.iloc[0]
        return int(row["hg"]), int(row["ag"])
