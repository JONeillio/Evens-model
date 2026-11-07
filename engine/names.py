"""Team names: OddsPapi participant IDs to names, and matching those names to
football-data.co.uk's spellings (\"Nottingham Forest\" vs \"Nott'm Forest\")."""
from __future__ import annotations

import difflib
import re
import unicodedata

# Abbreviations football-data.co.uk uses, expanded to full words.
TOKEN_EXPAND = {
    "man": "manchester", "utd": "united", "nottm": "nottingham", "weds": "wednesday",
    "ath": "athletic", "sp": "sporting", "ein": "eintracht", "mgladbach": "monchengladbach",
    "gladbach": "monchengladbach", "st": "saint", "inter": "internazionale", "psg": "paris",
    "qpr": "queens park rangers", "mk": "milton keynes", "wolves": "wolverhampton",
    "spurs": "tottenham", "brighton": "brighton", "bham": "birmingham", "cambridge": "cambridge",
    "dundee": "dundee", "inverness": "inverness", "fc": "", "afc": "", "cf": "", "sc": "",
    "ac": "", "as": "", "ssc": "", "us": "", "cd": "", "ud": "", "rc": "", "sd": "",
    "rcd": "", "vfb": "", "vfl": "", "tsg": "", "sv": "", "bv": "", "fsv": "", "1": "",
    "04": "", "05": "", "1899": "", "1846": "", "1860": "", "club": "", "calcio": "",
    "de": "", "del": "", "la": "", "and": "", "hove": "", "albion": "", "the": "",
    "olympique": "", "stade": "", "real": "real", "atletico": "athletic", "atlético": "athletic",
    "bilbao": "bilbao", "hotspur": "", "town": "", "city": "city", "county": "county",
}
# Whole-name aliases where token rules are not enough.
ALIASES = {
    "heart of midlothian": "hearts", "hearts": "hearts",
    "paris saint germain": "paris sg", "paris sg": "paris sg",
    "internazionale": "inter", "inter milan": "inter",
    "west bromwich albion": "west brom", "west brom": "west brom",
    "sheffield wednesday": "sheffield weds",
    "athletic club": "ath bilbao", "athletic bilbao": "ath bilbao",
    "atletico madrid": "ath madrid", "atlético madrid": "ath madrid",
    "real betis": "betis", "rayo vallecano": "vallecano", "celta vigo": "celta",
    "real sociedad": "sociedad", "deportivo alaves": "alaves", "espanyol": "espanol",
    "bayern munchen": "bayern munich", "fc bayern munchen": "bayern munich",
    "borussia dortmund": "dortmund", "bayer leverkusen": "leverkusen",
    "rb leipzig": "rb leipzig", "eintracht frankfurt": "ein frankfurt",
    "borussia monchengladbach": "m'gladbach", "1 fc koln": "fc koln", "koln": "fc koln",
    "olympique marseille": "marseille", "olympique lyonnais": "lyon",
    "saint etienne": "st etienne", "sporting cp": "sp lisbon", "sporting lisbon": "sp lisbon",
    "sc braga": "sp braga", "vitoria guimaraes": "guimaraes", "fc porto": "porto",
    "psv": "psv eindhoven", "az": "az alkmaar", "milton keynes dons": "milton keynes dons",
}


def normalise(name: str) -> str:
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ").replace("'", "").replace(".", " ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def tokens(name: str) -> list[str]:
    out = []
    for t in normalise(name).split():
        t = TOKEN_EXPAND.get(t, t)
        if t:
            out.extend(t.split())
    return out


def canonical(name: str) -> str:
    n = normalise(name)
    if n in ALIASES:
        n = normalise(ALIASES[n])
    return " ".join(tokens(n))


def best_match(name: str, candidates: list[str], cutoff: float = 0.72) -> str | None:
    """Pick the candidate (a football-data team name) that best matches `name`."""
    if not candidates:
        return None
    target = canonical(name)
    canon = {c: canonical(c) for c in candidates}
    for c, cn in canon.items():  # exact canonical hit
        if cn == target:
            return c
    tset = set(target.split())
    best, best_score = None, 0.0
    for c, cn in canon.items():
        cset = set(cn.split())
        overlap = len(tset & cset) / max(1, min(len(tset), len(cset)))
        ratio = difflib.SequenceMatcher(None, target, cn).ratio()
        score = max(ratio, 0.55 * ratio + 0.45 * overlap)
        if score > best_score:
            best, best_score = c, score
    return best if best_score >= cutoff else None


class Participants:
    def __init__(self, mapping: dict):
        self.map = {str(k): v for k, v in (mapping or {}).items()}

    def name(self, pid) -> str | None:
        return self.map.get(str(pid))

    def missing(self, ids) -> list[str]:
        return [str(i) for i in ids if str(i) not in self.map]
