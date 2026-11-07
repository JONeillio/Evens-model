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
from zoneinfo import ZoneInfo

from . import budget, builder, settle
from .pools import build_pools
from .catalog import prob_from_matrix, LEG_DEFS
from .footballdata import FootballData
from .goals_model import fit
from .legs import build_legs, ALIAS_OF
from .names import Participants, assign_short_codes, best_match
from .parse import add_payload, add_props
from .scores import final_results

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
                 out_dir: Path | None = None, calls: int | None = None):
        global DATA, DOCS_DATA
        if out_dir:  # test runs write somewhere harmless
            DATA, DOCS_DATA = out_dir / "data", out_dir / "docs" / "data"
        self.s = settings
        self.now = now
        self.mock_dir = mock_dir
        self.manual = manual
        self.calls_override = calls  # a by-hand run that's allowed to spend exactly this many requests
        self.log = {"started_at": iso(now), "mode": "mock" if mock_dir else ("manual" if manual else "scheduled"),
                    "errors": [], "notes": []}
        self.state = load_json(DATA / "state.json", {})
        self.api = None
        self.fixture_names = {}
        self.priced = set()

    # -- odds -----------------------------------------------------------------
    def fetch_odds(self):
        uk = self.s["uk_books"]
        sharp = self.s["sharp_book"]
        tier = {l["id"]: l.get("tier", 9) for l in self.s["leagues"]}
        self.fixture_names = {}
        if self.mock_dir:
            index = {}
            for p in sorted(self.mock_dir.glob("*.json")):
                add_payload(index, json.loads(p.read_text()), books=[sharp] + uk)
            self.log["plan"] = {"fetch": True, "mock": True}
            return index, self._books_present(index), True

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
        if self.calls_override:
            spendable = max(0, usage["remaining"] - cfg["reserve"])
            plan["allowance"] = min(int(self.calls_override), spendable)
            plan["override"] = int(self.calls_override)
        allow = plan["allowance"]
        if allow < 4:  # fixtures + Pinnacle + at least two matches
            plan["fetch"] = False
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
        if not fx_list:
            counts = {l["id"]: 1 for l in self.s["leagues"] if l.get("tier") == 1}
        # Core competitions (Prem, NFL, Championship, NBA, FA Cup): one request per bookie
        # covers every game in up to 5 competitions, so do these first.
        core_ids = self.fetch_core(index := {}, counts, allow, sharp)
        active = sorted((t for t in counts if t not in core_ids), key=lambda t: (tier[t], -counts[t]))
        per_call = cfg["max_tournaments_per_call"]
        chunks = [active[i:i + per_call] for i in range(0, len(active), per_call)]
        if not chunks and not index:
            self.log["notes"].append("None of our leagues play in the next few days.")
            return {}, [], True

        # Pinnacle for every league with games (1 request per 5 leagues), keeping room for match calls.
        n_chunks = max(0, min(len(chunks), allow - self.api.billable_calls - cfg["min_match_calls"]))
        for ids in chunks[:n_chunks]:
            try:
                add_payload(index, self.api.odds_by_tournaments(ids, bookmaker=sharp), books=[sharp])
            except QuotaExhausted as exc:
                self.log["errors"].append(str(exc))
                return index, [], True
            except Exception as exc:
                self.log["errors"].append(f"pinnacle {ids}: {str(exc)[:300]}")
        skipped = [t for c in chunks[n_chunks:] for t in c]
        if skipped:
            names = {l["id"]: l["name"] for l in self.s["leagues"]}
            self.log["notes"].append("Not covered today (saving requests): " + ", ".join(names[t] for t in skipped))

        # Every UK bookie for the matches most likely to give short-priced legs (1 request each).
        match_calls = max(0, allow - self.api.billable_calls)
        picks = self.shortlist(index, match_calls, skip_tournaments=set(core_ids))
        for fid in picks:
            try:
                res = self.api.get("odds", fixtureId=fid)
                add_payload(index, res, books=[sharp] + uk, **self.lenient())
                add_props(index, res, books=[sharp] + uk, now=self.now)
            except QuotaExhausted as exc:
                self.log["errors"].append(str(exc))
                break
            except Exception as exc:
                self.log["errors"].append(f"match {fid}: {str(exc)[:200]}")
        plan.update({"fetch": True, "leagues_with_games": len(active), "chunks_needed": len(chunks),
                     "chunks_fetched": n_chunks, "matches_priced": len(picks),
                     "planned_calls": self.api.billable_calls})
        self.priced = set(picks)
        return index, self._books_present(index), True

    def lenient(self) -> dict:
        return {"lenient": self.s.get("lenient_books", []), "now": self.now, "max_age_h": self.s.get("lenient_max_age_hours", 18)}

    def fetch_core(self, index: dict, counts: dict, allow: int, sharp: str) -> list[int]:
        """Prices for the core groups due today: one request per bookie per 5 competitions.
        Football competitions are skipped when they have no games in the horizon."""
        from .budget import DAY_NAMES
        from .oddspapi import QuotaExhausted
        core = self.s.get("core") or {}
        sport_of = {l["id"]: l.get("sport", 10) for l in self.s["leagues"]}
        day = DAY_NAMES[self.now.astimezone(ZoneInfo(self.s["timezone"])).weekday()]
        ids: list[int] = []
        for g in core.get("groups", []):
            if day not in g.get("days", DAY_NAMES):
                continue
            for t in g["tournaments"]:
                if sport_of.get(t, 10) == 10 and counts and t not in counts:
                    continue
                if t not in ids:
                    ids.append(t)
        books = [sharp] + [b for b in core.get("books", []) if b != sharp]
        if not ids or not books:
            return []
        # Keep 1 request spare for the fixtures list already spent, and fit the budget.
        room = max(0, allow - self.api.billable_calls)
        chunks = [ids[i:i + 5] for i in range(0, len(ids), 5)]
        while chunks and len(chunks) * len(books) > room:
            if len(books) > 3:
                books.pop()  # drop the last bookie before dropping competitions
            else:
                chunks.pop()
        mixed = len({sport_of.get(t, 10) for t in ids}) > 1
        done: list[int] = []
        for chunk in chunks:
            groups = [chunk]
            for bk in books:
                for g in list(groups):
                    try:
                        res = self.api.odds_by_tournaments(g, bookmaker=bk)
                        add_payload(index, res, books=[bk], **self.lenient())
                        add_props(index, res, books=[bk], now=self.now)
                    except QuotaExhausted as exc:
                        self.log["errors"].append(str(exc))
                        return done
                    except Exception as exc:
                        msg = str(exc)
                        if mixed and len(groups) == 1 and " 400" in msg:
                            # This API won't mix sports in one request: split by sport from now on.
                            by_sport: dict = {}
                            for t in chunk:
                                by_sport.setdefault(sport_of.get(t, 10), []).append(t)
                            groups = list(by_sport.values())
                            self.log["notes"].append("Core: split by sport (mixed request refused).")
                            for g2 in groups:
                                try:
                                    res = self.api.odds_by_tournaments(g2, bookmaker=bk)
                                    add_payload(index, res, books=[bk], **self.lenient())
                                    add_props(index, res, books=[bk], now=self.now)
                                except Exception as exc2:
                                    self.log["errors"].append(f"core {bk} {g2}: {str(exc2)[:200]}")
                            break
                        if "404" not in msg:  # 404 = that bookie has no games there: normal
                            self.log["errors"].append(f"core {bk} {g}: {msg[:200]}")
            done.extend(chunk)
        names = {l["id"]: l["name"] for l in self.s["leagues"]}
        self.log["core"] = {"competitions": [names.get(t, t) for t in done], "books": books}
        return done

    def _books_present(self, index) -> list[str]:
        present = set()
        for e in index.values():
            present.update(b for b, m in e["books"].items() if m)
        return [b for b in self.s["uk_books"] if b in present]

    def shortlist(self, index, budget_calls: int, skip_tournaments=frozenset()) -> list[str]:
        """Pick the matches worth a full-price request: lots of short-priced legs,
        clustered around the same kick-off times so slips can form."""
        from .legs import sharp_probabilities
        cfg = self.s["shortlist"]
        spread = timedelta(hours=self.s["slips"]["kickoff_spread_hours"])
        soon, horizon = self.now + timedelta(minutes=30), self.now + timedelta(hours=self.s["horizon_hours"])
        scored = []
        for fid, e in index.items():
            m = e["meta"]
            if not m.get("startTime") or m.get("statusId") not in (0, None):
                continue
            if m.get("tournamentId") in skip_tournaments:
                continue  # already priced by the core calls
            ko = parse_ts(m["startTime"])
            if not (soon <= ko <= horizon):
                continue
            probs = sharp_probabilities(e["books"].get(self.s["sharp_book"], {}), self.s.get("devig_method", "power"))
            good = [p for p, *_ in probs.values() if cfg["min_fair_prob"] <= p <= 1 / 1.03 and 1 / p <= cfg["max_fair_price"]]
            if good:
                scored.append((fid, ko, min(len(good), 8)))
        picks: list[str] = []
        # Joseph's must-haves first: every match in the priority leagues (Prem, then Championship),
        # soonest first, as long as it has at least one short-priced leg.
        tid_of = {fid: index[fid]["meta"].get("tournamentId") for fid, _, _ in scored}
        for tier in self.s.get("priority", []):
            ids = set(tier.get("leagues", []))
            for fid, ko, _ in sorted((x for x in scored if tid_of[x[0]] in ids), key=lambda x: x[1]):
                if len(picks) >= budget_calls:
                    break
                if fid not in picks:
                    picks.append(fid)
        self.log["priority_picks"] = len(picks)
        remaining = {fid: (ko, sc) for fid, ko, sc in scored if fid not in picks}
        while remaining and len(picks) < budget_calls:
            # The kick-off window with the most promising matches still unpicked.
            best_anchor, best_set = None, []
            for anchor in sorted({ko for ko, _ in remaining.values()}):
                group = sorted((f for f, (ko, _) in remaining.items() if anchor <= ko <= anchor + spread),
                               key=lambda f: -remaining[f][1])
                if len(group) > len(best_set) or (len(group) == len(best_set) and best_anchor and anchor < best_anchor):
                    best_anchor, best_set = anchor, group
            take = best_set[: min(cfg["per_window"], budget_calls - len(picks))]
            if len(take) < 3 and picks:  # too few to form a slip on their own
                break
            picks.extend(take)
            for f in take:
                remaining.pop(f, None)
            for f in best_set[len(take):]:
                remaining.pop(f, None)  # rest of this window: next time
        return picks

    # -- reference data -----------------------------------------------------------
    def participants(self, index) -> Participants:
        """Team names: one cached file per sport (data/ref/participants_<sport>.json)."""
        sport_of = {l["id"]: l.get("sport", 10) for l in self.s["leagues"]}
        by_sport: dict[int, set] = {}
        for e in index.values():
            sp = sport_of.get(e["meta"].get("tournamentId"), 10)
            by_sport.setdefault(sp, set()).update(i for i in (e["meta"].get("participant1Id"), e["meta"].get("participant2Id")) if i is not None)
        mapping: dict = {}
        refresh_days = self.s["budget"]["participants_refresh_days"]
        for sp in sorted(set(by_sport) | {10}):
            path = ROOT / "data" / "ref" / f"participants_{sp}.json"
            parts = Participants(load_json(path, {}))
            missing = parts.missing(by_sport.get(sp, ()))
            if sp == 10 and getattr(self, "fixture_names", None):
                have = set()
                for fid, (h, a) in self.fixture_names.items():
                    e = index.get(fid)
                    if e and h and a:
                        have.update([str(e["meta"].get("participant1Id")), str(e["meta"].get("participant2Id"))])
                missing = [i for i in missing if i not in have]
            stamp_key = "participants_at" if sp == 10 else f"participants_{sp}_at"
            age = days_since(self.state.get(stamp_key), self.now)
            if self.api and missing and (age >= 1 or not parts.map):
                try:
                    fresh = self.api.participants(sp)
                    if isinstance(fresh, dict) and fresh:
                        save_json(path, fresh, compact=True)
                        parts = Participants(fresh)
                        self.state[stamp_key] = iso(self.now)
                        self.log["notes"].append(f"Refreshed team names for sport {sp} ({len(missing)} were unknown).")
                except Exception as exc:
                    self.log["errors"].append(f"participants refresh {sp}: {exc}")
            mapping.update(parts.map)
        return Participants(mapping)

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
            if not any(e["books"].get(b) for b in books):
                continue  # no UK prices for this match
            fn = self.fixture_names.get(fid, (None, None))
            home = fn[0] or parts.name(m.get("participant1Id")) or f"Team {m.get('participant1Id')}"
            away = fn[1] or parts.name(m.get("participant2Id")) or f"Team {m.get('participant2Id')}"
            fixtures[fid] = {"id": fid, "league_id": lg["id"], "league": lg["name"], "country": lg["country"],
                             "home": home, "away": away, "kickoff": iso(ko), "fd": None, "model": None}

        assign_short_codes(fixtures)

        # Goals model and football-data name matching.
        fd = FootballData(DATA / "cache" / "fd", offline=bool(self.mock_dir))
        if self.mock_dir and (self.mock_dir / "fd").exists():
            fd.cache_dir = self.mock_dir / "fd"
        model_probs = self.run_model(fixtures, fd)

        legs = []
        for fid, fx in fixtures.items():
            legs.extend(build_legs(fx, index[fid]["books"], s["sharp_book"], books, s, model_probs.get(fid)))
        # NFL player yards: stats-first projections lined up with the prop prices (engine/nfl).
        fmap_path = DATA / "nfl_fixture_map.json" if DATA != ROOT / "data" else ROOT / "data" / "nfl_model" / "fixture_map.json"
        nfl_proj, nfl_map = [], load_json(fmap_path, {}) or load_json(ROOT / "data" / "nfl_model" / "fixture_map.json", {})
        try:
            from .nfl import live as nfl_live
            nl, nfl_proj, fmap = nfl_live.build(index, fixtures, s, self.now, offline=bool(self.mock_dir))
            legs.extend(nl)
            if fmap and not self.mock_dir:
                nfl_map.update({k: dict(v, seen=iso(self.now)) for k, v in fmap.items()})
                cutoff = iso(self.now - timedelta(days=21))
                nfl_map = {k: v for k, v in nfl_map.items() if v.get("seen", "") >= cutoff}
                save_json(fmap_path, nfl_map)
            self.log["nfl"] = {"prop_legs": len(nl), "projections": len(nfl_proj)}
        except Exception as exc:
            self.log["errors"].append(f"nfl model: {str(exc)[:300]}")
        legs_by_id = {l["id"]: l for l in legs}

        t0 = time.monotonic()
        slip_books = [b for b in books if b not in s.get("not_for_slips", [])]
        slips = builder.build_slips(legs, fixtures, slip_books, s["slips"], s["timezone"])
        self.log["builder_seconds"] = round(time.monotonic() - t0, 2)

        # Track record
        hist = load_json(DATA / "history_state.json", settle.empty_history())
        settle.publish(hist, slips, legs_by_id, fixtures, self.now)
        settle.track_legs(hist, legs, fixtures, self.now)
        results = final_results(load_json(DATA / "scores_state.json", {}))
        prop_values = {}
        try:
            from .nfl import live as nfl_live
            nfl_scores, prop_values = nfl_live.results_and_props(nfl_map, offline=bool(self.mock_dir))
            results = {**nfl_scores, **results}
        except Exception as exc:
            self.log["errors"].append(f"nfl settle: {str(exc)[:200]}")
        try:
            settle.settle(hist, fd, self.now, results=results, prop_values=prop_values)
        except Exception as exc:
            self.log["errors"].append(f"settlement: {exc}")
        hist["slips"] = hist["slips"][-400:]
        save_json(DATA / "history_state.json", hist)
        save_json(DOCS_DATA / "history.json", settle.public_history(hist, iso(self.now)), compact=True)

        # Snapshot for reuse (only fixtures we care about)
        if fetched:
            snap_index = {fid: index[fid] for fid in fixtures}
            save_json(DATA / "snapshot.json", {"taken_at": odds_time, "books": books, "index": snap_index}, compact=True)

        book_names = s.get("book_names", {})
        latest = {
            "generated_at": iso(self.now),
            "odds_taken_at": odds_time,
            "timezone": s["timezone"],
            "books": [{"slug": b, "name": book_names.get(b, b), "slips": b not in s.get("not_for_slips", []),
                       **({"check": True} if b in s.get("lenient_books", []) else {})} for b in books],
            "sharp_book": s["sharp_book"],
            "defaults": s["slips"],
            "fixtures": sorted(fixtures.values(), key=lambda f: (f["kickoff"], f["league"])),
            "legs": sorted(legs, key=lambda l: (fixtures[l["fixture_id"]]["kickoff"], -l["best_edge"])),
            "slips": slips,
            "windows": build_pools(legs, fixtures, slip_books, s),
            "budget": {k: self.log.get("plan", {}).get(k) for k in ("remaining", "planned_calls", "leagues_with_games", "chunks_fetched", "chunks_needed")},
            "notes": self.log["notes"],
            "track": settle.summary(hist),
        }
        if self.api:
            latest["budget"]["used_this_run"] = self.api.billable_calls
            latest["budget"]["remaining_after"] = (self.log.get("usage_before", {}).get("remaining") or 0) - self.api.billable_calls
        save_json(DOCS_DATA / "latest.json", latest, compact=True)
        save_json(DOCS_DATA / "projections.json", {"generated_at": iso(self.now), "nfl": nfl_proj}, compact=True)

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
    ap.add_argument("--calls", type=int, help="by-hand run: spend up to this many requests (still keeps the reserve)")
    ap.add_argument("--out", type=Path, help="write outputs here instead of the repo (for tests)")
    ap.add_argument("--reuse-snapshot", action="store_true", help="no API calls: rebuild from data/snapshot.json")
    args = ap.parse_args()
    settings = load_json(ROOT / "config" / "settings.json", None)
    now = parse_ts(args.now) if args.now else datetime.now(timezone.utc).replace(microsecond=0)
    out = args.out or (Path("/tmp/evens_mock_out") if args.mock else None)
    run = Run(settings, now, mock_dir=args.mock, manual=args.manual, out_dir=out, calls=args.calls)
    if args.reuse_snapshot:
        run.fetch_odds = lambda: (None, [], False)
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
