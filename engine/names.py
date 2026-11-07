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


# ---------- three-letter codes for the reels ("SAM v RIZ") ----------
SHORT_CODES = {
    "manchester united": "MUN", "manchester city": "MCI", "plymouth argyle": "PLY",
    "west bromwich albion": "WBA", "west brom": "WBA", "west ham united": "WHU", "west ham": "WHU",
    "nottingham forest": "NFO", "newcastle united": "NEW", "tottenham hotspur": "TOT", "tottenham": "TOT",
    "wolverhampton wanderers": "WOL", "wolves": "WOL", "crystal palace": "CRY", "aston villa": "AVL",
    "sheffield united": "SHU", "sheffield wednesday": "SHW", "queens park rangers": "QPR", "qpr": "QPR",
    "milton keynes dons": "MKD", "mk dons": "MKD", "brighton and hove albion": "BHA", "brighton": "BHA",
    "afc bournemouth": "BOU", "bournemouth": "BOU", "leicester city": "LEI", "leeds united": "LEE",
    "bristol city": "BRC", "bristol rovers": "BRR", "cardiff city": "CAR", "swansea city": "SWA",
    "stoke city": "STK", "hull city": "HUL", "norwich city": "NOR", "coventry city": "COV",
    "derby county": "DER", "preston north end": "PNE", "blackburn rovers": "BLB", "blackpool": "BLP",
    "oxford united": "OXF", "cambridge united": "CAM", "peterborough united": "PET", "port vale": "PVA",
    "notts county": "NCO", "stockport county": "STO", "wycombe wanderers": "WYC", "bolton wanderers": "BOL",
    "heart of midlothian": "HEA", "hearts": "HEA", "hibernian": "HIB", "celtic": "CEL", "rangers": "RAN",
    "dundee united": "DUU", "dundee": "DUN", "st mirren": "STM", "st johnstone": "STJ",
    "real madrid": "RMA", "atletico madrid": "ATM", "real sociedad": "RSO", "real betis": "BET",
    "athletic club": "ATH", "athletic bilbao": "ATH", "barcelona": "BAR", "paris saint germain": "PSG",
    "paris sg": "PSG", "bayern munchen": "BAY", "bayern munich": "BAY", "borussia dortmund": "BVB",
    "borussia monchengladbach": "BMG", "bayer leverkusen": "B04", "rb leipzig": "RBL", "ac milan": "MIL",
    "inter": "INT", "internazionale": "INT", "inter milan": "INT", "as roma": "ROM", "ss lazio": "LAZ",
    "sporting cp": "SCP", "fc porto": "POR", "benfica": "BEN", "psv eindhoven": "PSV", "psv": "PSV",
    "az alkmaar": "AZ", "az": "AZ", "ajax": "AJA", "feyenoord": "FEY",
}
_SKIP = {"fc", "afc", "cf", "sc", "ac", "as", "ssc", "cd", "ud", "rc", "sd", "rcd", "vfb", "vfl", "tsg", "sv",
         "bv", "fsv", "1", "club", "the", "de", "real", "sporting", "athletic", "atletico", "olympique", "stade"}


def short_code(name: str) -> str:
    n = normalise(name)
    n_plain = re.sub(r"\b(fc|afc|cf)\b", "", n).strip()
    for key in (n, n_plain):
        if key in SHORT_CODES:
            return SHORT_CODES[key]
    words = [w for w in n.split() if w not in _SKIP] or n.split() or ["???"]
    return re.sub(r"[^A-Z0-9]", "", words[0].upper())[:3] or "???"


def assign_short_codes(fixtures: dict):
    """Set home_short / away_short on each fixture; clashing codes on the same
    day (Bristol City and Bristol Rovers) get first letter + next word."""
    by_day: dict[str, dict[str, set]] = {}
    names = {}
    for fx in fixtures.values():
        for side in ("home", "away"):
            names[fx[side]] = short_code(fx[side])
            by_day.setdefault(fx["kickoff"][:10], {}).setdefault(names[fx[side]], set()).add(fx[side])
    for fx in fixtures.values():
        for side in ("home", "away"):
            code = names[fx[side]]
            if len(by_day[fx["kickoff"][:10]][code]) > 1 and normalise(fx[side]) not in SHORT_CODES:
                words = [w for w in normalise(fx[side]).split() if w not in _SKIP]
                if len(words) >= 2:
                    code = (words[0][0] + words[1][:2]).upper()
                elif words and len(words[0]) > 3:  # Barnet / Barnsley -> BAT / BAY
                    code = (words[0][:2] + words[0][-1]).upper()
            fx[f"{side}_short"] = code
