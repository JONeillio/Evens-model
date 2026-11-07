"""nflverse data (free, public, updated nightly in season). Downloaded by the morning job and
cached under data/cache/nfl (not committed)."""
from __future__ import annotations

import time
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "data" / "cache" / "nfl"
BASE = "https://github.com/nflverse/nflverse-data/releases/download"
FILES = {
    "players": "stats_player/stats_player_week_{season}.csv",
    "teams": "stats_team/stats_team_week_{season}.csv",
    "snaps": "snap_counts/snap_counts_{season}.csv",
    "injuries": "injuries/injuries_{season}.csv",
}
GAMES = "schedules/games.csv"


def _fetch(rel: str, max_age_h: float, cache: Path) -> Path:
    path = cache / Path(rel).name
    if path.exists() and time.time() - path.stat().st_mtime < max_age_h * 3600:
        return path
    cache.mkdir(parents=True, exist_ok=True)
    r = requests.get(f"{BASE}/{rel}", timeout=120)
    r.raise_for_status()
    path.write_bytes(r.content)
    return path


def load(seasons: list[int], current: int, cache: Path = CACHE, offline: bool = False) -> dict:
    """Frames for the given seasons. Past seasons are cached for 30 days, the current one for 6 hours."""
    out = {}
    for kind, pat in FILES.items():
        frames = []
        for s in seasons:
            rel = pat.format(season=s)
            try:
                p = cache / Path(rel).name if offline else _fetch(rel, 6 if s == current else 720, cache)
                if p.exists():
                    frames.append(pd.read_csv(p, low_memory=False))
            except requests.HTTPError:
                continue  # e.g. injuries before the season starts
        out[kind] = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    gp = cache / "games.csv" if offline else _fetch(GAMES, 6, cache)
    out["games"] = pd.read_csv(gp, low_memory=False)
    return out
