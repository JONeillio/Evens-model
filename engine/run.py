"""Daily engine run.

    python -m engine.run                 # live: pull odds, price legs, build slips
    python -m engine.run --manual        # same, allowed to spend a little more budget
    python -m engine.run --mock DIR --now 2026-11-07T08:00:00Z   # offline test run

Writes:
    docs/data/latest.json    what the app shows (fixtures, legs, slips)
    docs/data/history.json   the model's track record and calibration
    data/snapshot.json       compact odds snapshot (reused if a run skips fetching)
    data/history_state.json  full history including legs awaiting results
    data/state.json          housekeeping (reference refresh dates)
    data/run_log.json        what happened on the last run
"""
from __future__ import annotations

import argparse
import json
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import budget, builder, settle
from .catalog import prob_from_matrix, LEG_DEFS
from .footballdata import FootballData
from .goals_model import fit
from .legs import build_legs, ALIAS_OF
from .names import Participants, best_match
from .parse import add_payload

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
DOCS_DATA = ROOT / "docs" / "data"


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, obj, compact=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":")) if compact else \
        json.dumps(obj, ensure_ascii=False, indent=1)
    path.write_text(text)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def days_since(stamp: str | None, now: datetime) -> float:
    if not stamp:
        return 1e9
    return (now - parse_ts(stamp)).total_seconds() / 86400


class Run:
    def __init__(self, settings: dict, now: datetime, mock_dir: Path | None = None, manual: bool = False,
                 out_dir: Path | None = None):
        global DATA, DOCS_DATA
        if out_dir:  # test runs write somewhere harmless
            DATA, DOCS_DATA = out_dir / "data", out_dir / "docs" / "data"
        self.s = settings
        self.now = now
        self.mock_dir = mock_dir
        self.manual = manual
        self.log = {"started_at": iso(now), "mode": "mock" if mock_dir else ("manual" if manual else "scheduled"),
                    "errors": [], "notes": []}
        self.state = load_json(DATA / "state.json", {})
        self.api = None
        self.fixture_names = {}

    # -- odds -----------------------------------------------------------------
    def fetch_odds(self):
        soft = self.s["soft_books"]
        tier = {l["id"]: l.get("tier", 9) for l in self.s["leagues"]}
        self.fixture_names = {}
        if self.mock_dir:
            index = {}
            for book in [self.s["sharp_book"]] + soft:
                p = self.mock_dir / f"{book}.json"
                if p.exists():
                    add_payload(index, json.loads(p.read_text()))
            self.log["plan"] = {"fetch": True, "books": soft, "mock": True}
            return index, soft, True

        from .oddspapi import OddsPapi, QuotaExhausted
        self.api = OddsPapi()
        account = None
        try:
            account = self.api.account()
        except Exception as exc:
            self.log["errors"].append(f"account check failed: {exc}")
        cfg = self.s["budget"]
        usage = budget.usage_from_account(account, cfg["monthly_limit_fallback"])
        plan = budget.allowance(usage, self.now, cfg, manual=self.manual)
        self.log["usage_before"] = usage
        self.log["plan"] = plan
        if plan["allowance"] < 3:  # need fixtures + Pinnacle + one bookie
            plan["fetch"] = False
            plan["reason"] = "saving requests for the rest of the month"
            self.log["notes"].append("Saving requests for the rest of the month; showing the last odds.")
            return None, [], False

        # 1 request: which of our leagues play in the next ~2 days?
        start = self.now.strftime("%Y-%m-%dT%H:%M:%SZ")
        end = (self.now + timedelta(hours=min(47, self.s["horizon_hours"]))).strftime("%Y-%m-%dT%H:%M:%SZ")
        try:
            fx_list = self.api.fixtures(sportId=self.s["sport_id"], **{"from": start, "to": end})
        except Exception as exc:
            self.log["errors"].append(f"fixtures: {exc}")
            fx_list = []
        counts = {}
        for f in fx_list if isinstance(fx_list, list) else []:
            tid = f.get("tournamentId")
            if tid in tier and f.get("statusId") in (0, None):
                counts[tid] = counts.get(tid, 0) + 1
                self.fixture_names[f.get("fixtureId")] = (f.get("participant1Name"), f.get("participant2Name"))
        if not fx_list:  # fixtures call failed: fall back to tier 1 leagues
            counts = {l["id"]: 1 for l in self.s["leagues"] if l.get("tier") == 1}
        active = sorted(counts, key=lambda t: (tier[t], -counts[t]))
        per_call = cfg["max_tournaments_per_call"]
        chunks = [active[i:i + per_call] for i in range(0, len(active), per_call)]
        books, n_chunks = budget.choose(plan["allowance"] - 1, len(chunks), soft)
        plan.update({"fetch": bool(books), "books": books, "leagues_with_games": len(active),
                     "chunks_needed": len(chunks), "chunks_fetched": n_chunks,
                     "planned_calls": 1 + n_chunks * (1 + len(books))})
        skipped = [t for c in chunks[n_chunks:] for t in c]
        if skipped:
            names = {l["id"]: l["name"] for l in self.s["leagues"]}
            self.log["notes"].append("Skipped to save requests: " + ", ".join(names[t] for t in skipped))
        if not books:
            self.log["notes"].append("No leagues in our list play in the next 2 days.")
            return {}, [], True

        index: dict = {}
        books_ok = []
        for book in [self.s["sharp_book"]] + books:
            ok = True
            for ids in chunks[:n_chunks]:
                try:
                    payload = self.api.odds_by_tournaments(ids, bookmaker=book)
                    n = add_payload(index, payload)
                    self.log.setdefault("prices_added", {})[book] = self.log.get("prices_added", {}).get(book, 0) + n
                except QuotaExhausted as exc:
                    self.log["errors"].append(str(exc))
                    return index, books_ok, True
                except Exception as exc:
                    self.log["errors"].append(f"{book} {ids}: {str(exc)[:300]}")
                    ok = False
            if ok and book != self.s["sharp_book"]:
                books_ok.append(book)
        return index, books_ok, True

    # -- reference data -----------------------------------------------------------
    def participants(self, index) -> Participants:
        parts = Participants(load_json(ROOT / "data" / "ref" / "participants_10.json", {}))
        ids = set()
        for e in index.values():
            ids.update([e["meta"].get("participant1Id"), e["meta"].get("participant2Id")])
        missing = [i for i in parts.missing(i for i in ids if i is not None)]
        if getattr(self, "fixture_names", None):
            have = set()
            for fid, (h, a) in self.fixture_names.items():
                e = index.get(fid)
                if e and h and a:
                    have.update([str(e["meta"].get("participant1Id")), str(e["meta"].get("participant2Id"))])
            missing = [i for i in missing if i not in have]
        refresh_days = self.s["budget"]["participants_refresh_days"]
        stale = days_since(self.state.get("participants_at"), self.now) >= 1
        if self.api and missing and (stale or days_since(self.state.get("participants_at"), self.now) >= refresh_days):
            try:
                fresh = self.api.participants(self.s["sport_id"])
                if isinstance(fresh, dict) and fresh:
                    save_json(ROOT / "data" / "ref" / "participants_10.json", fresh, compact=True)
                    parts = Participants(fresh)
                    self.state["participants_at"] = iso(self.now)
                    self.log["notes"].append(f"Refreshed team names ({len(missing)} were unknown).")
            except Exception as exc:
                self.log["errors"].append(f"participants refresh: {exc}")
        return parts

    # -- main -----------------------------------------------------------------
    def execute(self):
        s = self.s
        index, books, fetched = self.fetch_odds()
        if not fetched:
            snap = load_json(DATA / "snapshot.json", None)
            if not snap:
                raise RuntimeError("No odds this run and no previous snapshot to reuse.")
            index, books = snap["index"], snap["books"]
            self.log["notes"].append(f"Reused odds snapshot from {snap['taken_at']}.")
            odds_time = snap["taken_at"]
        else:
            odds_time = iso(self.now)

        parts = self.participants(index)
        league_by_id = {l["id"]: l for l in s["leagues"]}
        horizon_end = self.now + timedelta(hours=s["horizon_hours"])
        soon = self.now + timedelta(minutes=10)

        fixtures = {}
        for fid, e in index.items():
            m = e["meta"]
            if m.get("statusId") not in (0, None) or not m.get("startTime"):
                continue
            ko = parse_ts(m["startTime"])
            if not (soon <= ko <= horizon_end):
                continue
            lg = league_by_id.get(m.get("tournamentId"))
            if not lg:
                continue
            fn = self.fixture_names.get(fid, (None, None))
            home = fn[0] or parts.name(m.get("participant1Id")) or f"Team {m.get('participant1Id')}"
            away = fn[1] or parts.name(m.get("participant2Id")) or f"Team {m.get('participant2Id')}"
            fixtures[fid] = {"id": fid, "league_id": lg["id"], "league": lg["name"], "country": lg["country"],
                             "home": home, "away": away, "kickoff": iso(ko), "fd": None, "model": None}

        # Goals model and football-data name matching.
        fd = FootballData(DATA / "cache" / "fd", offline=bool(self.mock_dir))
        if self.mock_dir and (self.mock_dir / "fd").exists():
            fd.cache_dir = self.mock_dir / "fd"
        model_probs = self.run_model(fixtures, fd)

        legs = []
        for fid, fx in fixtures.items():
            legs.extend(build_legs(fx, index[fid]["books"], s["sharp_book"], books, s, model_probs.get(fid)))
        legs_by_id = {l["id"]: l for l in legs}

        t0 = time.monotonic()
        slips = builder.build_slips(legs, fixtures, books, s["slips"], s["timezone"])
        self.log["builder_seconds"] = round(time.monotonic() - t0, 2)

        # Track record
        hist = load_json(DATA / "history_state.json", settle.empty_history())
        settle.publish(hist, slips, legs_by_id, fixtures, self.now)
        settle.track_legs(hist, legs, fixtures, self.now)
        try:
            settle.settle(hist, fd, self.now)
        except Exception as exc:
            self.log["errors"].append(f"settlement: {exc}")
        hist["slips"] = hist["slips"][-400:]
        save_json(DATA / "history_state.json", hist)
        public_hist = {
            "generated_at": iso(self.now),
            "summary": settle.summary(hist),
            "calibration": hist.get("calibration", {}),
            "slips": list(reversed(hist["slips"][-150:])),
        }
        save_json(DOCS_DATA / "history.json", public_hist, compact=True)

        # Snapshot for reuse (only fixtures we care about)
        if fetched:
            snap_index = {fid: index[fid] for fid in fixtures}
            save_json(DATA / "snapshot.json", {"taken_at": odds_time, "books": books, "index": snap_index}, compact=True)

        book_names = s.get("book_names", {})
        latest = {
            "generated_at": iso(self.now),
            "odds_taken_at": odds_time,
            "timezone": s["timezone"],
            "books": [{"slug": b, "name": book_names.get(b, b)} for b in books],
            "sharp_book": s["sharp_book"],
            "defaults": s["slips"],
            "fixtures": sorted(fixtures.values(), key=lambda f: (f["kickoff"], f["league"])),
            "legs": sorted(legs, key=lambda l: (fixtures[l["fixture_id"]]["kickoff"], -l["best_edge"])),
            "slips": slips,
            "budget": {k: self.log.get("plan", {}).get(k) for k in ("remaining", "planned_calls", "leagues_with_games", "chunks_fetched", "chunks_needed")},
            "notes": self.log["notes"],
            "track": settle.summary(hist),
        }
        if self.api:
            latest["budget"]["used_this_run"] = self.api.billable_calls
            latest["budget"]["remaining_after"] = (self.log.get("usage_before", {}).get("remaining") or 0) - self.api.billable_calls
        save_json(DOCS_DATA / "latest.json", latest, compact=True)

        self.state["last_run_at"] = iso(self.now)
        save_json(DATA / "state.json", self.state)
        self.log.update({
            "fixtures": len(fixtures), "legs": len(legs), "slips": len(slips), "books": books,
            "model_fixtures": sum(1 for f in fixtures.values() if f["model"]),
            "fd_errors": fd.errors[:20],
            "calls": [c.__dict__ for c in self.api.calls] if self.api else [],
            "finished_at": iso(datetime.now(timezone.utc)),
        })
        return latest

    def run_model(self, fixtures, fd: FootballData) -> dict:
        cfg = self.s["model"]
        out = {}
        if not cfg.get("enabled"):
            return out
        league_by_id = {l["id"]: l for l in self.s["leagues"]}
        ratings_cache = {}
        today = self.now.date()
        for fid, fx in fixtures.items():
            div = league_by_id[fx["league_id"]].get("fd")
            if not div:
                continue
            try:
                if div not in ratings_cache:
                    res = fd.results(div, today, cfg["seasons_back"])
                    ratings_cache[div] = (fit(res, today, cfg["half_life_days"]) if len(res) else None,
                                          fd.current_teams(div, today))
                ratings, teams = ratings_cache[div]
            except Exception as exc:
                self.log["errors"].append(f"model {div}: {exc}")
                ratings_cache[div] = (None, [])
                continue
            fh, fa = best_match(fx["home"], teams), best_match(fx["away"], teams)
            if fh and fa:
                fx["fd"] = {"div": div, "home": fh, "away": fa}
            if not ratings or not (fh and fa):
                continue
            if min(ratings.matches_per_team.get(fh, 0), ratings.matches_per_team.get(fa, 0)) < cfg["min_team_matches"]:
                continue
            m = ratings.score_matrix(fh, fa)
            if m is None:
                continue
            lam, mu = ratings.expected_goals(fh, fa)
            fx["model"] = {"xg_home": round(lam, 2), "xg_away": round(mu, 2)}
            probs = {}
            for d in LEG_DEFS:
                key = ALIAS_OF.get(d.key, d.key)
                probs[key] = prob_from_matrix(key, m)
            out[fid] = probs
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock", type=Path)
    ap.add_argument("--now")
    ap.add_argument("--manual", action="store_true")
    ap.add_argument("--out", type=Path, help="write outputs here instead of the repo (for tests)")
    args = ap.parse_args()
    settings = load_json(ROOT / "config" / "settings.json", None)
    now = parse_ts(args.now) if args.now else datetime.now(timezone.utc).replace(microsecond=0)
    out = args.out or (Path("/tmp/evens_mock_out") if args.mock else None)
    run = Run(settings, now, mock_dir=args.mock, manual=args.manual, out_dir=out)
    try:
        latest = run.execute()
        print(f"OK: {len(latest['fixtures'])} fixtures, {len(latest['legs'])} legs, {len(latest['slips'])} slips; "
              f"books={latest['books']}")
    except Exception as exc:
        run.log["errors"].append(f"FATAL: {exc}")
        run.log["traceback"] = traceback.format_exc()[-3000:]
        raise
    finally:
        if run.api:
            run.log.setdefault("calls", [c.__dict__ for c in run.api.calls])
        save_json((args.out or (Path("/tmp/evens_mock_out") if args.mock else ROOT) ) / "data" / "run_log.json", run.log)
        print(json.dumps({k: v for k, v in run.log.items() if k not in ("calls", "traceback")}, indent=1, default=str)[:3000])


if __name__ == "__main__":
    main()
