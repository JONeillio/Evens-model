/* Evens Bandit: a pub fruit machine for near-evens football accumulators.
   Data: data/latest.json (fixtures, legs, published slips, and leg pools per
   kick-off window and bookie) + data/history.json (the model's record)
   + data/live.json (scores during and after matches, every ~10 minutes).
   Your slip, bets and settings live on this phone only (localStorage). */
"use strict";

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TZ = "Europe/London";
const ZONE = [1.9, 2.3];
const MAX_LEGS = 6, MIN_LEGS = 2;
const pct = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const signedPct = (x, d = 1) => (x == null ? "–" : Math.abs(x) < 0.5 / 10 ** (d + 2) ? `${(0).toFixed(d)}%` : `${x > 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const money = (x) => (x == null ? "–" : `${x < 0 ? "−" : ""}£${Math.abs(x).toFixed(2)}`);
const signedMoney = (x) => (x == null ? "–" : `${x < 0 ? "−" : "+"}£${Math.abs(x).toFixed(2)}`);
const poundTick = (t) => `${t < 0 ? "−" : ""}£${Math.abs(Math.round(t))}`;
const edgeTag = (e) => `<span class="edge ${e >= -0.0005 ? "pos" : "neg"}">${signedPct(e)}</span>`;
const fmtTime = (iso, withDay = true) => new Intl.DateTimeFormat("en-GB", withDay
  ? { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ }
  : { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(new Date(iso));
// Days in UK time (round 3): "Today", "Tomorrow", else "Mon 9 Nov".
const dayKey = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const dayOffset = (iso) => Math.round((Date.parse(dayKey(iso)) - Date.parse(dayKey(new Date().toISOString()))) / 86400000);
const dayLong = (iso) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ }).format(new Date(iso));
const dayShort = (iso) => new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: TZ }).format(new Date(iso));
const dayWord = (iso) => { const d = dayOffset(iso); return d === 0 ? "Today" : d === 1 ? "Tomorrow" : dayLong(iso); };

// Fractional odds (display only: every sum uses the decimal price).
// UK ladder of the fractional part; Evens = 1/1.
const LADDER = ["1/50","1/33","1/25","1/20","1/16","1/14","1/12","1/10","1/9","1/8","2/15","1/7","2/13","1/6","2/11","1/5","2/9","1/4","2/7","3/10","1/3","4/11","2/5","4/9","1/2","8/15","4/7","8/13","4/6","8/11","4/5","5/6","10/11","1/1","11/10","6/5","5/4","11/8","7/5","6/4","8/5","13/8","7/4","15/8","2/1","9/4","5/2","11/4","3/1","10/3","7/2","4/1","9/2","5/1"]
  .map((f) => { const [a, b] = f.split("/").map(Number); return { f: f === "1/1" ? "Evens" : f, d: 1 + a / b }; });
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function toFraction(price) {
  if (price == null || !isFinite(price)) return "–";
  let near = LADDER[0];
  for (const x of LADDER) if (Math.abs(x.d - price) < Math.abs(near.d - price)) near = x;
  if (Math.abs(near.d - price) <= 0.005) return near.f;
  const hund = Math.round((price - 1) * 100), g = gcd(hund, 100);
  if (hund > 0 && 100 / g <= 20) return `${hund / g}/${100 / g}`;
  return `≈${near.f}`;
}
function odds(dec) {
  if (dec == null) return "–";
  return prefs.odds_format === "decimal" ? dec.toFixed(2) : toFraction(dec);
}
// Odds as HTML: the ≈ is kept visible but quieter.
const oddsH = (dec) => { const t = odds(dec); return t.startsWith("≈") ? `<span class="approx">≈</span>${esc(t.slice(1))}` : esc(t); };
const zoneLabel = () => (prefs.odds_format === "decimal" ? "Evens zone 1.90–2.30" : "9/10 – 13/10 · around evens");

// ---------- storage (this phone only) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("evens." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evens." + k, JSON.stringify(v)); } catch { /* storage unavailable: keep in memory */ } },
};
const DEFAULTS = { monthlyLimit: 100, myBooks: null, minP: 0.68, maxLeg: 1.45 };
let settings = Object.assign({}, DEFAULTS, store.get("settings", {}));
// Round 2 preferences live in evens.prefs.
// comps: which competitions go on the reels ([] = all). fav_book: your main bookie (null = any).
const PREF_DEFAULTS = { odds_format: "fraction", sound: true, vibration: true, min_edge: 0.01, legs_per_slip: "mix", sweet_spot: [1.14, 1.26], comps: [], fav_book: null, day_range: "7" };
let prefs = Object.assign({}, PREF_DEFAULTS, store.get("prefs", {}));
const savePrefs = () => store.set("prefs", prefs);
let bets = store.get("bets", []);
let slip = store.get("slip", null); // shared by the machine and Build a bet
const saveSettings = () => store.set("settings", settings);
const saveBets = () => store.set("bets", bets);
const saveSlip = () => store.set("slip", slip);

// ---------- data ----------
let PROJ = null, DATA = null, HIST = null, LIVE = null, FIX = {}, LEGS = {}, BOOKS = {}, BOOKCHECK = {}, SLIP_BOOKS = [], WINDOWS = [];
const EXCHANGES = ["betfair-ex", "matchbook"];
const myBooks = () => { const m = (settings.myBooks || SLIP_BOOKS).filter((b) => SLIP_BOOKS.includes(b)); return m.length ? m : SLIP_BOOKS; };
const bookName = (b) => BOOKS[b] || b;

async function loadJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function load() {
  try {
    [DATA, HIST, LIVE, PROJ] = await Promise.all([loadJSON("data/latest.json"), loadJSON("data/history.json").catch(() => null),
      loadJSON("data/live.json").catch(() => null), loadJSON("data/projections.json").catch(() => null)]);
  } catch {
    $("#machineWhere").textContent = "Couldn't load the odds. Check your signal and reopen.";
    return;
  }
  FIX = Object.fromEntries(DATA.fixtures.map((f) => [f.id, f]));
  LEGS = Object.fromEntries(DATA.legs.map((l) => [l.id, l]));
  BOOKS = Object.fromEntries(DATA.books.map((b) => [b.slug, b.name]));
  BOOKCHECK = Object.fromEntries(DATA.books.map((b) => [b.slug, !!b.check]));
  SLIP_BOOKS = DATA.books.filter((b) => b.slips !== false && !EXCHANGES.includes(b.slug)).map((b) => b.slug);
  WINDOWS = (DATA.windows || []).slice().sort((a, b) => a.start_utc.localeCompare(b.start_utc));
  $("#oddsStamp").textContent = `Odds checked ${fmtTime(DATA.odds_taken_at)}`;
  autoSettleBets();
  liveSettleBets();
  ensureSlip();
  route();
}

// ---------- live scores ----------
// The scores job updates data/live.json every ~10 minutes while matches are on.
// While the app is open we re-check it every 90 seconds (a tiny static file).
async function refreshLive() {
  if (document.hidden || !DATA) return;
  const fresh = await loadJSON("data/live.json").catch(() => null);
  if (!fresh || fresh.updated_at === LIVE?.updated_at) return;
  LIVE = fresh;
  const won = liveSettleBets();
  const page = location.hash.slice(1) || "home";
  if (page === "winnings") renderBets();
  if ((page === "home" || page === "") && !spinning) {
    renderMachine();
    if (watchingId && won.includes(watchingId)) jackpot();
  }
}
setInterval(refreshLive, 90 * 1000);
document.addEventListener("visibilitychange", refreshLive);

// One leg against the current score. Mirrors engine/catalog.py outcome().
function settleKey(key, hg, ag) {
  const p = key.split(":"), g = { 1: hg, 2: ag }, o = { 1: ag, 2: hg };
  const res = hg > ag ? "1" : ag > hg ? "2" : "X";
  // NFL / NBA (points, overtime included). Mirrors engine/catalog.py outcome().
  if (p[0].includes("-")) {
    const k = p[0].split("-")[1];
    if (k === "ml") return hg === ag ? "void" : g[p[1]] > o[p[1]] ? "won" : "lost";
    if (k === "sp") return g[p[1]] - o[p[1]] + +p[2] > 0 ? "won" : "lost";
    if (k === "tot") { const over = hg + ag > +p[1]; return (p[2] === "over" ? over : !over) ? "won" : "lost"; }
    return null;
  }
  switch (p[0]) {
    case "1x2": return res === p[1] ? "won" : "lost";
    case "dc": return p[1].includes(res) ? "won" : "lost";
    case "dnb": return hg === ag ? "void" : g[p[1]] > o[p[1]] ? "won" : "lost";
    case "ou": { const over = hg + ag > +p[1]; return (p[2] === "over" ? over : !over) ? "won" : "lost"; }
    case "tt": return g[p[1]] > +p[2] ? "won" : "lost";
    case "ts": return g[p[1]] > 0 ? "won" : "lost";
    case "btts": { const both = hg > 0 && ag > 0; return (p[1] === "yes" ? both : !both) ? "won" : "lost"; }
    case "ah": return g[p[1]] - o[p[1]] + +p[2] > 0 ? "won" : "lost";
    default: return null;
  }
}
// st: won / lost / void (decided), ahead / behind / level (in play), wait, off (postponed etc.)
function legNow(legId) {
  const done = HIST?.leg_results?.[legId];
  if (done) return { st: done };
  const [fid, ...rest] = String(legId).split("|");
  const key = rest.join("|");
  const sc = LIVE?.fixtures?.[fid];
  if (!sc || sc.s === "NS") return { st: "wait", sc };
  if (["PST", "ABD", "CANC"].includes(sc.s)) return { st: "off", sc };
  if (sc.h == null || sc.a == null) return { st: "wait", sc };
  const res = settleKey(key, sc.h, sc.a);
  if (sc.s === "FT") return { st: res, sc };
  // In play, some legs are already decided whatever happens next.
  const p = key.split(":"), tot = sc.h + sc.a, g = { 1: sc.h, 2: sc.a };
  if ((p[0] === "ou" || p[0].endsWith("-tot")) && tot > +p[1]) return { st: p[2] === "over" ? "won" : "lost", sc };
  if ((p[0] === "tt" && g[p[1]] > +p[2]) || (p[0] === "ts" && g[p[1]] > 0)) return { st: "won", sc };
  if (p[0] === "btts" && sc.h > 0 && sc.a > 0) return { st: p[1] === "yes" ? "won" : "lost", sc };
  return { st: res === "won" ? "ahead" : res === "void" ? "level" : "behind", sc };
}
const OFF_TEXT = { PST: "Postponed", ABD: "Abandoned", CANC: "Called off" };
function legChip(legId, kickoff) {
  const { st, sc } = legNow(legId);
  const score = sc && sc.h != null ? `${sc.h}–${sc.a}` : "";
  const clock = !sc ? "" : sc.s === "HT" ? "HT" : sc.s === "FT" ? "FT" : sc.min ? `${sc.min}′` : "";
  const txt = {
    won: `✓ Landed ${score}`, lost: `✗ Gone ${score}`, void: `Void ${score}`,
    ahead: `▲ On track ${score} ${clock}`, behind: `▼ Behind ${score} ${clock}`, level: `● Level ${score} ${clock}`,
    off: OFF_TEXT[sc?.s] || "Off", wait: kickoff ? `Kicks off ${fmtTime(kickoff)}` : "Not started",
  }[st] || "";
  return `<span class="ls ${st}">${esc(txt.trim())}</span>`;
}
function betProgress(b) {
  const states = (b.legIds || []).map((id) => legNow(id).st);
  const n = (k) => states.filter((s) => k.includes(s)).length;
  return { states, landed: n(["won"]), gone: n(["lost"]), live: n(["ahead", "behind", "level"]), waiting: n(["wait", "off"]), voids: n(["void"]) };
}

// Settle placed bets from the scores, unless you've set the result yourself.
function liveSettleBets() {
  if (!LIVE) return [];
  let changed = false;
  const newlyWon = [];
  bets.forEach((b) => {
    if (b.status !== "pending" || b.manual || !b.legIds?.length) return;
    const pr = betProgress(b);
    let status = null;
    if (pr.gone) status = "lost";
    else if (pr.landed + pr.voids === pr.states.length) status = pr.landed ? "won" : "void";
    if (!status) return;
    // Void legs come out of the odds you got (assumes the bookie's leg price was about ours).
    let o = b.odds;
    b.legIds.forEach((id, i) => { if (pr.states[i] === "void" && b.legs[i]?.price) o /= b.legs[i].price; });
    b.status = status;
    b.returns = status === "won" ? b.stake * Math.max(1, o) : status === "void" ? b.stake : 0;
    b.settledAt = new Date().toISOString(); b.settledBy = "scores"; changed = true;
    if (status === "won") newlyWon.push(b.id);
  });
  if (changed) saveBets();
  return newlyWon;
}

// On the machine: an LED ticker of how your placed bets are doing right now.
function renderLiveStrip() {
  const el = $("#liveStrip");
  if (!el) return;
  const today = new Date().toISOString().slice(0, 10);
  const active = bets.filter((b) => b.status === "pending" && b.legIds?.length && (b.legs || []).some((l) => (l.kickoff || "").slice(0, 10) <= today));
  if (!active.length || !LIVE) { el.hidden = true; return; }
  const short = (fid, i, b) => {
    const f = FIX[fid];
    if (f) return `${f.home_short || f.home.slice(0, 3).toUpperCase()} v ${f.away_short || f.away.slice(0, 3).toUpperCase()}`;
    return (b.legs[i]?.match || "").split(" v ").map((t) => t.slice(0, 3).toUpperCase()).join(" v ");
  };
  const items = active.slice(0, 3).map((b) => {
    const pr = betProgress(b);
    const head = `${b.bookName.toUpperCase()} ${b.legIds.length}-FOLD: ✓${pr.landed} IN${pr.gone ? ` ✗${pr.gone} OUT` : ""}${pr.live ? ` ▶${pr.live} PLAYING` : ""}${pr.waiting ? ` ·${pr.waiting} TO GO` : ""}`;
    const scores = b.legIds.map((id, i) => {
      const { st, sc } = legNow(id);
      if (!sc || sc.h == null || st === "wait") return null;
      const mark = { won: "✓", lost: "✗", ahead: "▲", behind: "▼", level: "●", void: "–" }[st] || "";
      const clock = sc.s === "HT" ? "HT" : sc.s === "FT" ? "FT" : sc.min ? `${sc.min}′` : "";
      return `${mark} ${short(id.split("|")[0], i, b)} ${sc.h}–${sc.a} ${clock}`.trim();
    }).filter(Boolean);
    return [head, ...scores].join("   ");
  });
  const text = items.join("   ★   ");
  el.setAttribute("aria-label", `Your bets live. ${text}. Open Winnings for the scores.`);
  el.innerHTML = `<span class="lt-head"><span>Your bets</span><span class="lt-live">● Live</span></span>
    <span class="lt-window" aria-hidden="true"><span class="lt-text">${esc(text)}</span></span>`;
  el.hidden = false;
  el.classList.add("scrolling"); // measure on one line
  requestAnimationFrame(() => {
    const win = el.querySelector(".lt-window"), t = el.querySelector(".lt-text");
    const scroll = t.scrollWidth > win.clientWidth && !reducedMotion();
    el.classList.toggle("scrolling", scroll);
    if (scroll) { t.textContent = `${text}   ★   ${text}   ★   `; t.style.setProperty("--lt-dur", `${Math.max(8, text.length / 6)}s`); }
  });
}

// ---------- pools ----------
const windowById = (id) => WINDOWS.find((w) => w.id === id);
function rawPool(windowId, bookie) {
  const w = windowById(windowId);
  return w ? (w.bookies.find((b) => b.bookie === bookie) || null) : null;
}
// ---------- game select: which competitions go on the reels ----------
// Grouped by OddsPapi tournament id (config/settings.json leagues).
const COMPS = [
  { id: "prem", name: "Prem", long: "Premier League", ids: [17] },
  { id: "nfl", name: "NFL", long: "NFL", ids: [31] },
  { id: "efl", name: "EFL", long: "EFL", ids: [18, 24, 25] },
  { id: "nba", name: "NBA", long: "NBA", ids: [132] },
  { id: "cups", name: "Cups", long: "cup", ids: [19, 21, 347] },
  { id: "scot", name: "Scotland", long: "Scottish", ids: [36, 206, 207, 209] },
  { id: "euro", name: "Euro nights", long: "European", ids: [7, 679, 34480] },
  { id: "abroad", name: "Abroad", long: "overseas league", ids: [35, 8, 23, 34, 37, 238, 38, 52, 185, 44, 54, 53, 182] },
  { id: "other", name: "Others", long: "other", ids: [] },
];
const compOf = (fid) => { const lid = FIX[fid]?.league_id; return (COMPS.find((c) => c.ids.includes(lid)) || COMPS[COMPS.length - 1]).id; };
const inComps = (fid) => !prefs.comps?.length || prefs.comps.includes(compOf(fid));
const scopeName = () => (prefs.comps || []).map((c) => COMPS.find((x) => x.id === c)?.name).filter(Boolean).join(" + ");
const legOk = (l) => l.fair_p >= settings.minP && l.price <= settings.maxLeg;

// The pool with your filters applied (used for spins and adding legs).
function pool(windowId, bookie) {
  const p = rawPool(windowId, bookie);
  if (!p) return [];
  return p.fixtures.filter((f) => inComps(f.fixture_id)).map((f) => Object.assign({}, f, {
    legs: f.legs.filter(legOk),
  })).filter((f) => f.legs.length);
}
// Matches with usable legs in the chosen day range, per competition group (your bookies only).
function compCounts() {
  const seen = {};
  for (const w of upcoming()) for (const b of w.bookies) {
    if (!myBooks().includes(b.bookie)) continue;
    for (const f of b.fixtures) if (f.legs.some(legOk)) (seen[compOf(f.fixture_id)] ||= new Set()).add(f.fixture_id);
  }
  return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.size]));
}
function findLeg(windowId, bookie, legId) {
  const p = rawPool(windowId, bookie);
  if (!p) return null;
  for (const fx of p.fixtures) for (const leg of fx.legs) if (leg.leg_id === legId) return { fx, leg };
  return null;
}
const upcomingAll = () => WINDOWS.filter((w) => Date.parse(w.start_utc) > Date.now() + 2 * 60 * 1000);
// Day range (round 3): Today · Tomorrow · Next 7 days · Next 14 days. Sets the scope with the league chips.
const RANGES = [["today", "Today"], ["tomorrow", "Tomorrow"], ["7", "Next 7 days"], ["14", "Next 14 days"]];
function inRange(iso, r = prefs.day_range) {
  const d = dayOffset(iso);
  return r === "today" ? d === 0 : r === "tomorrow" ? d === 1 : r === "14" ? d < 14 : d < 7;
}
const upcoming = () => upcomingAll().filter((w) => inRange(w.start_utc));
// Only offer ranges the data covers: a range is off if it adds no kick-offs.
function rangeAvailable(r) {
  const ws = upcomingAll().filter((w) => booksFor(w).length);
  if (r === "today") return ws.some((w) => dayOffset(w.start_utc) === 0);
  if (r === "tomorrow") return ws.some((w) => dayOffset(w.start_utc) === 1);
  if (r === "7") return ws.some((w) => dayOffset(w.start_utc) < 7);
  return ws.some((w) => dayOffset(w.start_utc) >= 7 && dayOffset(w.start_utc) < 14);
}
const rangeName = (r = prefs.day_range) => (RANGES.find((x) => x[0] === r) || RANGES[2])[1];
const booksFor = (w) => w.bookies.map((b) => b.bookie).filter((b) => myBooks().includes(b));

// ---------- the shared slip ----------
function resolve(s = slip) {
  if (!s) return [];
  return s.legs.map((l) => Object.assign({ held: !!l.held }, findLeg(s.window_id, s.bookie, l.leg_id) || {})).filter((x) => x.leg);
}
function numbers(s = slip) {
  const rs = resolve(s);
  let o = 1, v = 1, h = 1;
  rs.forEach(({ leg }) => { o *= leg.price; v *= leg.price * leg.fair_p + (leg.p_void || 0); h *= leg.fair_p + (leg.p_void || 0); });
  return { legs: rs, odds: o, ev: v - 1, chance: h, ret: (s?.stake || 10) * o };
}

// ---------- slip shape: 4–5 short legs (round 2, item 0) ----------
// Legs inside the sweet spot (1/7 to 1/4 by default) fit best; a 1.40 leg is only
// used when nothing else works. Mirrors engine/builder.py band_fit().
function bandFit(price) {
  const [lo, hi] = prefs.sweet_spot || PREF_DEFAULTS.sweet_spot;
  if (price >= lo && price <= hi) return 1;
  if (price < lo) { const e = lo - 0.06; return price < e ? 0.1 : 0.3 + (0.7 * (price - e)) / (lo - e); }
  const e = hi + 0.09; return price > e ? 0.1 : 0.3 + (0.7 * (e - price)) / (e - hi);
}
const legWeight = (leg) => Math.max(leg.edge, 0.001) * bandFit(leg.price);
const sizeOptions = () => (prefs.legs_per_slip === 4 ? [4] : prefs.legs_per_slip === 5 ? [5] : [4, 5]);
const FIT_PENALTY = 0.03;

/* Every combination of legs from unused matches (plus the held legs) that lands
   in the evens zone with `sizes` legs in total. Returns [{picks, ev, odds, fit, score}]. */
function searchCombos(windowId, bookie, heldLegs, sizes, nodeCap = 120000) {
  const heldR = heldLegs.map((l) => findLeg(windowId, bookie, l.leg_id)).filter(Boolean);
  const heldFx = new Set(heldLegs.map((l) => l.fixture_id));
  let o0 = 1, v0 = 1, f0 = 0;
  heldR.forEach(({ leg }) => { o0 *= leg.price; v0 *= leg.price * leg.fair_p + (leg.p_void || 0); f0 += bandFit(leg.price); });
  const ks = new Set(sizes.map((n) => n - heldR.length).filter((k) => k >= 0));
  if (!ks.size) return [];
  const maxK = Math.max(...ks);
  const perFx = {}, items = [];
  pool(windowId, bookie).filter((f) => !heldFx.has(f.fixture_id)).forEach((fx) => fx.legs.forEach((leg) => items.push({ fx, leg, w: legWeight(leg) })));
  items.sort((a, b) => b.w - a.w || b.leg.edge - a.leg.edge);
  const top = items.filter((it) => (perFx[it.fx.fixture_id] = (perFx[it.fx.fixture_id] || 0) + 1) <= 3).slice(0, 28)
    .sort((a, b) => a.leg.price - b.leg.price);
  const found = [], chosen = [], used = new Set();
  let nodes = 0;
  (function dfs(start, o, v, f) {
    if (++nodes > nodeCap) return;
    const k = chosen.length;
    if (ks.has(k) && o >= ZONE[0] && o <= ZONE[1]) {
      const fit = (f0 + f) / (k + heldR.length), ev = v - 1;
      found.push({ picks: chosen.slice(), ev, odds: o, fit, score: ev - FIT_PENALTY * (1 - fit) });
    }
    if (k === maxK) return;
    for (let i = start; i < top.length; i++) {
      const it = top[i], no = o * it.leg.price;
      if (no > ZONE[1]) break;
      if (used.has(it.fx.fixture_id)) continue;
      chosen.push(it); used.add(it.fx.fixture_id);
      dfs(i + 1, no, v * (it.leg.price * it.leg.fair_p + (it.leg.p_void || 0)), f + bandFit(it.leg.price));
      chosen.pop(); used.delete(it.fx.fixture_id);
    }
  })(0, o0, v0, 0);
  return found;
}
function combosWithFallback(windowId, bookie, held) {
  let found = searchCombos(windowId, bookie, held, sizeOptions());
  if (!found.length) found = searchCombos(windowId, bookie, held, [3, 6]); // only when 4–5 can't be done
  return found;
}
function applyCombo(choice, held) {
  const legs = held.map((l) => Object.assign({}, l)).concat(choice.picks.map((p) => ({ fixture_id: p.fx.fixture_id, leg_id: p.leg.leg_id, held: false })));
  slip.legs = legs;
  sortSlip();
  saveSlip();
}

// The best-scoring slip for a window: highest edge among 4–5 short legs (item 8).
function bestSlipFor(w, favOnly = false) {
  let best = null;
  const fav = prefs.fav_book;
  const books = favOnly && fav ? booksFor(w).filter((b) => b === fav) : booksFor(w);
  for (const bk of books) {
    const found = combosWithFallback(w.id, bk, []);
    for (const c of found) {
      const meets = c.ev >= prefs.min_edge;
      const rank = (meets ? 1 : 0) * 10 + c.score;
      if (!best || rank > best.rank) best = { rank, bookie: bk, combo: c, meets };
    }
  }
  return best;
}

function ensureSlip() {
  const valid = slip && windowById(slip.window_id) && Date.parse(windowById(slip.window_id).start_utc) > Date.now()
    && myBooks().includes(slip.bookie) && resolve().length >= MIN_LEGS;
  if (valid) {
    slip.legs = slip.legs.filter((l) => findLeg(slip.window_id, slip.bookie, l.leg_id));
    saveSlip();
    return;
  }
  if (rebuildSlip()) return;
  const w = upcoming().find((x) => booksFor(x).length);
  if (!w) { slip = null; saveSlip(); return; }
  slip = { window_id: w.id, bookie: booksFor(w)[0], stake: slip?.stake || 10, legs: [] };
  fillTo(4); sortSlip(); saveSlip();
}

/* A fresh slip for the current filters: the next kick-off where your main bookie
   can make one, else the next kick-off where any of your bookies can. */
function pickFresh() {
  const passes = prefs.fav_book ? [true, false] : [false];
  for (const favOnly of passes) for (const w of upcoming()) {
    if (!booksFor(w).length) continue;
    const best = bestSlipFor(w, favOnly);
    if (best) return { w, best };
  }
  return null;
}
let fallbackNote = null; // shown once on the machine when your bookie couldn't make a slip
function rebuildSlip() {
  const found = pickFresh();
  if (!found) return false;
  const fav = prefs.fav_book;
  fallbackNote = fav && found.best.bookie !== fav && myBooks().includes(fav)
    ? `${bookName(fav)} hasn't priced enough matches to make a slip near evens, so this one's at ${bookName(found.best.bookie)}.` : null;
  slip = { window_id: found.w.id, bookie: found.best.bookie, stake: slip?.stake || 10, legs: [] };
  applyCombo(found.best.combo, []);
  recordScope();
  return true;
}

// The slip remembers the scope it was built in, so the machine and Build a bet agree.
function recordScope() { if (slip) { slip.league = (prefs.comps || []).slice(); slip.day_range = prefs.day_range; saveSlip(); } }
function sortSlip() {
  const ko = (l) => findLeg(slip.window_id, slip.bookie, l.leg_id)?.fx.kickoff_utc || "";
  slip.legs.sort((a, b) => ko(a).localeCompare(ko(b)));
}

// Best-weighted leg from a match not already used (for "+ Add a leg" and topping up).
function bestFreeLeg() {
  const used = new Set(slip.legs.map((l) => l.fixture_id));
  let best = null;
  for (const fx of pool(slip.window_id, slip.bookie)) {
    if (used.has(fx.fixture_id)) continue;
    for (const leg of fx.legs) {
      const w = legWeight(leg);
      if (!best || w > best.w || (w === best.w && leg.fair_p > best.leg.fair_p)) best = { fx, leg, w };
    }
  }
  return best;
}
function fillTo(n) {
  while (slip.legs.length < n) {
    const b = bestFreeLeg();
    if (!b) break;
    slip.legs.push({ fixture_id: b.fx.fixture_id, leg_id: b.leg.leg_id, held: false });
  }
}

/* Pull: re-spin the reels that aren't held. Finds every 4–5-leg combination in the
   evens zone with edge at or above your minimum, then picks one at random, weighted
   towards higher edge and towards legs in the sweet spot. If nothing meets the
   minimum edge, takes the best available and says so ("Thin pickings"). */
function spin() {
  const held = slip.legs.filter((l) => l.held);
  if (held.length >= Math.max(...sizeOptions(), 6)) return { ok: false, why: "Every reel is held · release one" };
  const found = combosWithFallback(slip.window_id, slip.bookie, held);
  if (!found.length) return { ok: false, why: "Nothing fits with those holds · release one" };
  const current = slip.legs.filter((l) => !l.held).map((l) => l.leg_id).sort().join("|");
  const key = (c) => c.picks.map((p) => p.leg.leg_id).sort().join("|");
  let pickFrom = found.filter((c) => c.ev >= prefs.min_edge);
  let thin = null;
  if (!pickFrom.length) {
    const best = found.slice().sort((a, b) => b.score - a.score)[0];
    thin = best.ev;
    pickFrom = [best];
  } else {
    pickFrom = pickFrom.sort((a, b) => b.score - a.score).slice(0, 60);
    if (pickFrom.length > 1) pickFrom = pickFrom.filter((c) => key(c) !== current);
  }
  // Weight: edge (exp) times each leg's sweet-spot fit.
  const weights = pickFrom.map((c) => Math.exp(30 * c.ev) * c.picks.reduce((m, p) => m * bandFit(p.leg.price), 1));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0), choice = pickFrom[0];
  for (let i = 0; i < pickFrom.length; i++) { r -= weights[i]; if (r <= 0) { choice = pickFrom[i]; break; } }
  const same = key(choice) === current;
  applyCombo(choice, held);
  return { ok: true, same, thin };
}

// ---------- router ----------
const PAGES = ["home", "table", "play", "build", "winnings", "payout"];
function route() {
  const page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
  PAGES.forEach((p) => ($("#" + p).hidden = p !== page));
  if (!DATA) return;
  roomTransition(page);
  ({ home: renderMachine, table: renderTable, play: renderPlay, build: renderBuild, winnings: renderBets, payout: renderRecord })[page]();
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);

// ---------- sound and haptics (round 2, item 5) ----------
// Synthesised with the Web Audio API: no files, works offline. Android plays it
// on the media volume, so the speaker button in the marquee is the mute.
// iPhones play Web Audio on the ringer channel by default, so the silent switch mutes it:
// audioSession "playback" (iOS 17+) and a silent <audio> blip (older iOS) move it to media.
const Sound = (() => {
  let ctx, blip;
  const on = () => prefs.sound !== false;
  const ac = () => {
    if (!ctx) {
      try { if ("audioSession" in navigator) navigator.audioSession.type = "playback"; } catch { /* not allowed */ }
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return ctx;
  };
  function tone(freq, start, dur, type = "square", vol = 0.15) {
    try {
      const c = ac();
      if (c.state !== "running") c.resume?.();
      const t = c.currentTime + start;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch { /* no audio on this device */ }
  }
  return {
    unlock() {
      if (!on() || !(window.AudioContext || window.webkitAudioContext)) return;
      try {
        if (!blip && !("audioSession" in navigator)) {
          // A few samples of silence: playing an <audio> element in a tap puts older iOS on the media channel.
          blip = new Audio("data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA");
          blip.play?.().catch(() => {});
        }
        ac().resume?.();
      } catch { /* no audio on this device */ }
    },
    running() { return ctx?.state === "running"; },
    lever() { if (on()) { tone(220, 0, 0.08, "sawtooth"); tone(110, 0.06, 0.14, "sawtooth"); } },
    spin() { if (on()) for (let i = 0; i < 14; i++) tone(600 + (i % 2) * 200, i * 0.06, 0.04, "square", 0.05); },
    stop() { if (on()) tone(1800, 0, 0.03, "square", 0.08); },
    hold() { if (on()) tone(880, 0, 0.06, "triangle", 0.1); },
    nudge() { if (on()) { tone(660, 0, 0.04, "square", 0.08); tone(990, 0.04, 0.05, "square", 0.08); } },
    jackpot() { if (on()) [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.14, "square", 0.12)); },
    placed() { if (on()) [784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.12, "triangle", 0.12)); },
  };
})();
// A touch pointerdown doesn't count as a user gesture for audio; pointerup and click do.
// Keep trying until the context runs, and wake it again when the app comes back to the front.
const unlockAudio = () => {
  Sound.unlock();
  setTimeout(() => { if (Sound.running()) ["pointerup", "click", "touchend"].forEach((e) => document.removeEventListener(e, unlockAudio, true)); }, 0);
};
["pointerup", "click", "touchend"].forEach((e) => document.addEventListener(e, unlockAudio, true));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !Sound.running()) ["pointerup", "click", "touchend"].forEach((e) => document.addEventListener(e, unlockAudio, true));
});
const buzz = (ms) => { if (prefs.vibration !== false && navigator.vibrate) try { navigator.vibrate(ms); } catch { /* not allowed */ } };
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function renderSoundBtn() {
  const b = $("#soundBtn"), on = prefs.sound !== false;
  b.setAttribute("aria-pressed", on);
  b.setAttribute("aria-label", on ? "Sound on. Tap to mute" : "Sound off. Tap to turn on");
  b.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>${on
    ? `<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`
    : `<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`}</svg>`;
}
$("#soundBtn").addEventListener("click", () => { prefs.sound = prefs.sound === false; savePrefs(); renderSoundBtn(); Sound.unlock(); Sound.hold(); });
renderSoundBtn();

// ---------- live sweat mode (item 11) ----------
// While a placed slip's games are on, the reels show its legs live. Tap
// "Spin a new slip" to go back to the machine; "Watch your bet live" returns.
let watchingId = null;            // the bet shown on the reels
const sweatOptOut = new Set();    // bets you've switched away from this session
function sweatCandidate() {
  if (!LIVE) return null;
  const started = (b) => (b.legs || []).some((l) => l.kickoff && Date.parse(l.kickoff) <= Date.now())
    || (b.legIds || []).some((id) => !["wait"].includes(legNow(id).st));
  const kept = watchingId && bets.find((b) => b.id === watchingId);
  if (kept && !sweatOptOut.has(kept.id) && (kept.status === "pending" || Date.now() - Date.parse(kept.settledAt || 0) < 3 * 3600e3)) return kept;
  return bets.find((b) => b.status === "pending" && b.legIds?.length && started(b)) || null;
}
const sweatBet = () => { const b = sweatCandidate(); return b && !sweatOptOut.has(b.id) ? b : null; };
function sweatReel(b, i) {
  const id = b.legIds[i], l = b.legs[i] || {};
  const fid = id.split("|")[0], f = FIX[fid];
  const codes = f ? `${code({ ...f }, "home")} v ${code({ ...f }, "away")}` : (l.match || "").split(" v ").map((x) => x.replace(/^(AFC|FC)\s+/i, "").slice(0, 3).toUpperCase()).join(" v ");
  const { st, sc } = legNow(id);
  const started = sc && sc.h != null && st !== "wait";
  const clock = !sc ? "" : sc.s === "HT" ? "HT" : sc.s === "FT" ? "FT" : sc.min ? `${sc.min}′` : sc.s === "LIVE" ? "Live" : "";
  const cls = st === "won" ? "in" : st === "lost" ? "out" : st === "void" ? "void" : ["ahead", "behind", "level"].includes(st) ? "live" : st === "off" ? "void" : "wait";
  const badge = { in: "✓ IN", out: "✗ OUT", void: st === "off" ? OFF_TEXT[sc?.s] || "Off" : "– VOID", wait: l.kickoff ? fmtTime(l.kickoff, false) : "Soon",
    live: st === "ahead" ? "▲ ON TRACK" : st === "behind" ? "▼ NEEDS IT" : "● LEVEL" }[cls];
  const label = l.label || "";
  const short = f ? shortLabel({ ...f, kickoff_utc: f.kickoff }, label) : label;
  return `<div class="reel sweat ${cls}" data-i="${i}"><div class="face">
    <span class="fxl"><span>${esc(codes)}</span><span>${esc(started ? clock : l.kickoff ? fmtTime(l.kickoff, false) : "")}</span></span>
    <span class="lbl" data-short="${esc(short)}"><span class="t">${esc(label)}</span></span>
    ${started ? `<span class="sw-score num">${sc.h}–${sc.a}</span>` : ""}
    <span class="sw-badge">${esc(badge)}</span></div></div>`;
}
function renderSweat(b) {
  const pr = betProgress(b), n = b.legIds.length;
  const cab = $("#cabinet");
  cab.classList.add("sweating");
  const title = $("#marqueeTitle");
  title.textContent = b.status === "won" ? "Paid out!" : b.status === "lost" || pr.gone ? "Bust" : `${pr.landed} of ${n} in`;
  const when = LIVE?.updated_at ? fmtTime(LIVE.updated_at, false) : "";
  $("#machineWhere").textContent = `Your ${b.bookName} ${n}-fold · scores ${when}`;
  const reels = $("#reels");
  reels.style.setProperty("--n", n); reels.classList.toggle("many", n > 4);
  reels.innerHTML = b.legIds.map((_, i) => sweatReel(b, i)).join("");
  fitLabels(reels);
  $("#holds").innerHTML = ""; $("#nudges").innerHTML = "";
  $("#mOdds").innerHTML = oddsH(b.odds);
  const toGo = pr.live + pr.waiting;
  const ret = b.status === "won" ? `Returned £${(b.returns ?? 0).toFixed(2)}` : b.status === "lost" || pr.gone ? `£${b.stake.toFixed(2)} gone` : `£${b.stake.toFixed(2)} returns £${(b.stake * b.odds).toFixed(2)}`;
  $("#mStats").innerHTML = `${esc(ret)}<br>${b.status !== "pending" || pr.gone ? "Settled from the scores" : `${toGo} to go · ${pr.landed} in`}`;
  clearStatus();
  $("#ticket").hidden = true;
  $("#watchBtn").hidden = true;
}
function leaveSweat() {
  $("#cabinet").classList.remove("sweating");
  $("#marqueeTitle").textContent = "Evens jackpot";
}
$("#unsweatBtn").addEventListener("click", () => {
  if (watchingId) sweatOptOut.add(watchingId);
  watchingId = null; leaveSweat(); renderMachine({ print: true });
});
$("#watchBtn").addEventListener("click", () => {
  const b = sweatCandidate();
  if (!b) return;
  sweatOptOut.delete(b.id); watchingId = b.id; renderMachine(); window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---------- the machine ----------
document.querySelectorAll("[data-bulbs]").forEach((el) => {
  const n = +el.dataset.bulbs, off = +(el.dataset.offset || 0);
  el.innerHTML = Array.from({ length: n }, (_, i) => `<span class="bulb${(i + off) % 2 ? " alt" : ""}"></span>`).join("");
});

function marqueeTime() {
  const legs = numbers().legs;
  const first = legs.map((r) => r.fx.kickoff_utc).sort()[0] || windowById(slip.window_id)?.start_utc;
  if (!first) return "";
  const mins = (Date.parse(first) - Date.now()) / 60000;
  const t = `${dayWord(first)} ${fmtTime(first, false)}`;
  return mins <= 180 ? `${t} · ${countdown(first).replace("kicks off ", "")}` : t;
}
const slipSpansDays = () => new Set(numbers().legs.map((r) => dayKey(r.fx.kickoff_utc))).size > 1;
function countdown(iso) {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (mins <= 0) return "kicking off now";
  const h = Math.floor(mins / 60), m = mins % 60;
  return `kicks off in ${h ? `${h}h ` : ""}${m}m`;
}

// Three-letter codes come from the morning job; derive them if missing.
const code = (fx, side) => fx[`${side}_short`] || String(fx[side] || "").replace(/^(AFC|FC|1\.?\s*FC)\s+/i, "").slice(0, 3).toUpperCase();
const fixtureLine = (fx) => `${code(fx, "home")} v ${code(fx, "away")} · ${fmtTime(fx.kickoff_utc, false)}`;
const shortLabel = (fx, label) => label.split(fx.home).join(code(fx, "home")).split(fx.away).join(code(fx, "away"));

function reelFace({ fx, leg }, spans = slipSpansDays()) {
  const when = spans ? `${dayShort(fx.kickoff_utc).toUpperCase()} ${fmtTime(fx.kickoff_utc, false)}` : fmtTime(fx.kickoff_utc, false);
  return `<div class="face"><span class="fxl" aria-label="${esc(`${fx.home} v ${fx.away}, ${dayWord(fx.kickoff_utc)} ${fmtTime(fx.kickoff_utc, false)}`)}"><span>${esc(code(fx, "home"))} v ${esc(code(fx, "away"))}</span><span>${esc(when)}</span></span><span class="lbl" data-short="${esc(leg.short || shortLabel(fx, leg.label))}"><span class="t">${esc(leg.label)}</span></span><span class="px num">${oddsH(leg.price)}</span></div>`;
}
// Shrink a reel label in steps (to 12px), up to 3 lines, never clipped sideways;
// if it still won't fit, swap team names for their codes ("SAM to score").
function fitLabels(root = document) {
  root.querySelectorAll(".reel .lbl").forEach((el) => {
    const t = el.querySelector(".t");
    if (!t) return;
    const max = parseFloat(getComputedStyle(el).getPropertyValue("--lbl-max")) || 14;
    const fits = () => t.scrollWidth <= el.clientWidth + 1 && t.offsetHeight <= Math.ceil(parseFloat(getComputedStyle(t).lineHeight) * 3) + 1;
    const tryAll = () => { for (let size = max; size >= 12; size--) { t.style.fontSize = `${size}px`; if (fits()) return true; } return false; };
    if (tryAll()) return;
    if (el.dataset.short && t.textContent !== el.dataset.short) { t.textContent = el.dataset.short; tryAll(); }
  });
}

let spinning = false, nudgesLeft = 3;
function renderMachine(opts = {}) {
  const where = $("#machineWhere");
  const ticket = $("#ticket");
  const sb = !spinning && sweatBet();
  if (sb) {
    watchingId = sb.id;
    renderSweat(sb);
    renderLiveStrip(); renderFooter();
    return;
  }
  leaveSweat();
  renderGameSelect(); renderBookPill();
  if (fallbackNote && !spinning) { const n = fallbackNote; fallbackNote = null; setTimeout(() => flashStatus(n), 0); }
  const cand = sweatCandidate();
  const wb = $("#watchBtn");
  wb.hidden = !cand;
  if (cand) { const pr = betProgress(cand); wb.textContent = `▶ Watch your ${cand.bookName} bet live · ${pr.landed} of ${cand.legIds.length} in`; }
  if (!slip) {
    where.textContent = `No kick-offs with prices · ${rangeName().toLowerCase()} ▾`;
    $("#reels").innerHTML = ""; $("#holds").innerHTML = ""; $("#nudges").innerHTML = "";
    $("#mOdds").textContent = "–"; $("#mStats").textContent = "";
    ticket.innerHTML = ""; ticket.hidden = true;
  } else {
    where.textContent = marqueeTime();
    where.setAttribute("aria-label", `Kick-off ${marqueeTime()}. Tap to change the day, kick-off or bookie`);
    const nums = numbers();
    const n = nums.legs.length;
    const reels = $("#reels"), holds = $("#holds"), nudges = $("#nudges");
    [reels, holds, nudges].forEach((el) => el.style.setProperty("--n", n));
    reels.classList.toggle("many", n > 4);
    if (!opts.keepReels) {
      reels.innerHTML = nums.legs.map((r, i) => `<div class="reel${r.held ? " held" : ""}" data-i="${i}">${reelFace(r)}${r.held ? `<span class="lock" aria-hidden="true"></span>` : ""}</div>`).join("");
      fitLabels(reels);
    }
    holds.innerHTML = nums.legs.map(({ held }, i) => `<button class="hold-btn" data-i="${i}" aria-pressed="${held}" aria-label="Hold reel ${i + 1}">${held ? "Held" : "Hold"}</button>`).join("");
    holds.querySelectorAll(".hold-btn").forEach((b) => b.addEventListener("click", () => {
      if (spinning) return;
      const l = slip.legs[+b.dataset.i]; l.held = !l.held; saveSlip(); Sound.hold(); buzz(10); renderMachine();
    }));
    nudges.innerHTML = nums.legs.map(({ held, fx }, i) => {
      const choices = rawPool(slip.window_id, slip.bookie)?.fixtures.find((f) => f.fixture_id === fx.fixture_id)?.legs.length || 0;
      const off = held || !nudgesLeft || choices < 2 ? "disabled" : "";
      return `<div class="nudge-pair"><button class="nudge" data-i="${i}" data-d="-1" aria-label="Nudge reel ${i + 1} to the previous market" ${off}>‹</button><button class="nudge" data-i="${i}" data-d="1" aria-label="Nudge reel ${i + 1} to the next market" ${off}>›</button></div>`;
    }).join("");
    nudges.querySelectorAll(".nudge").forEach((b) => b.addEventListener("click", () => nudge(+b.dataset.i, +b.dataset.d)));
    $("#nudgeCount").textContent = nudgesLeft;

    $("#mOdds").innerHTML = oddsH(nums.odds);
    if (!statusTimer) $("#mStats").innerHTML = fairLine(nums).replace(" · ", "<br>");
    renderTicket(opts.print);
  }
  renderLiveStrip(); renderFooter();
}
// The fair-price line is the machine's only status slot (round 3: no extra rows).
// Messages and the "Released 2 holds · not NFL  UNDO" pill swap in, then it goes back.
let statusTimer = null;
function flashStatus(text, opts = {}) {
  const el = $("#mStats");
  clearTimeout(statusTimer);
  el.classList.add("status-pill");
  el.classList.toggle("info", !opts.undo);
  el.innerHTML = `<span class="sp-text">${esc(text)}</span>${opts.undo ? '<button class="sp-undo" type="button">Undo</button>' : ""}`;
  if (opts.undo) el.querySelector(".sp-undo").addEventListener("click", () => { clearStatus(); opts.undo(); }, { once: true });
  statusTimer = setTimeout(clearStatus, opts.ms || 7000);
}
function clearStatus() {
  clearTimeout(statusTimer); statusTimer = null;
  const el = $("#mStats");
  el.classList.remove("status-pill", "info");
  el.innerHTML = slip ? fairLine(numbers()).replace(" · ", "<br>") : "";
}
function renderFooter() {
  const st = betStats();
  $("#doorWins").textContent = st.settled.length ? `My bets · ${signedMoney(st.pl)}` : "My bets";
  const led = $("#led");
  led.textContent = `£${String(Math.round(st.monthStaked)).padStart(3, "0")} / £${settings.monthlyLimit}`;
  led.classList.toggle("over", st.monthStaked > settings.monthlyLimit);
}
// Edge in plain English (item 8): what it should pay vs what you're getting.
function fairLine(nums) {
  if (!nums.legs.length) return "";
  // Decimals here even in fraction mode: fractions round away the difference.
  return `Fair price ${(1 / nums.chance).toFixed(2)} · you're getting ${nums.odds.toFixed(2)} (${signedPct(nums.ev)})`;
}

// ---------- the printed ticket (item 1) ----------
// The ticket is the source of truth: Copy sends exactly what it shows.
let ticketState = { copied: false };
function ticketRows() {
  return numbers().legs.map(({ fx, leg }) => ({ time: fmtTime(fx.kickoff_utc, false), day: dayKey(fx.kickoff_utc), ko: fx.kickoff_utc,
    match: `${fx.home} v ${fx.away}`, league: fx.league || "", label: leg.label, price: leg.price }));
}
// "TOMORROW · SUN 8 NOV" once, then a second header only for a leg on another day.
const dayHeader = (iso) => { const w = dayWord(iso), l = dayLong(iso); return (w === l ? l : `${w} · ${l}`).toUpperCase(); };
function renderTicket(print) {
  const t = $("#ticket");
  const nums = numbers();
  t.hidden = !nums.legs.length;
  let lastDay = null;
  t.innerHTML = `${ticketRows().map((r) => {
      const head = r.day !== lastDay ? `<div class="tk-day">${esc(dayHeader(r.ko))}</div>` : "";
      lastDay = r.day;
      return `${head}<div class="tk-row"><span class="tk-fx">${esc(r.time)} · ${esc(r.match)}${r.league ? ` · ${esc(r.league)}` : ""}</span>
      <span class="tk-leg"><span>${esc(r.label)}</span><b class="num">${oddsH(r.price)}</b></span></div>`;
    }).join("")}
    ${BOOKCHECK[slip.bookie] ? `<div class="tk-check">${esc(bookName(slip.bookie))}'s prices reach us on a delay. Check each one in the ${esc(bookName(slip.bookie))} app before you place it.</div>` : ""}
    <div class="tk-foot num"><b>${oddsH(nums.odds)}</b><span>real chance ${pct(nums.chance)}</span><span>£${slip.stake} pays £${nums.ret.toFixed(2)}</span></div>
    <div class="tk-actions">
      <button class="tk-btn" id="tkCopy">${ticketState.copied ? "Copied ✓" : `Copy to ${esc(bookName(slip.bookie))}`}</button>
      <button class="tk-btn" id="tkShare">Share</button>
      ${ticketState.copied ? `<button class="tk-btn placed" id="tkPlaced">Placed it</button>` : ""}
    </div>`;
  $("#tkCopy").addEventListener("click", async () => { await copyText(ticketText()); ticketState.copied = true; buzz(10); renderTicket(); });
  $("#tkShare").addEventListener("click", shareTicket);
  $("#tkPlaced")?.addEventListener("click", () => openPlaceSheet(currentSlipAsBet(), { onSaved: fileTicket }));
  if (print && !reducedMotion()) {
    t.classList.remove("printing"); void t.offsetWidth;
    t.style.setProperty("--tk-h", `${t.scrollHeight}px`);
    t.classList.add("printing");
    setTimeout(() => t.classList.remove("printing"), 700);
  }
}
function ticketText() {
  const nums = numbers();
  let lastDay = null;
  const rows = ticketRows().map((r) => {
    const head = r.day !== lastDay ? `${dayHeader(r.ko)}\n` : "";
    lastDay = r.day;
    return `${head}${r.time} · ${r.match}${r.league ? ` · ${r.league}` : ""}\n${r.label}  ${odds(r.price)}`;
  });
  return `${bookName(slip.bookie)} · ${nums.legs.length}-fold\n\n${rows.join("\n\n")}\n\n`
    + `Combined odds ${odds(nums.odds)}${prefs.odds_format === "decimal" ? "" : ` (${nums.odds.toFixed(2)})`} · real chance ${pct(nums.chance)} · £${slip.stake} pays £${nums.ret.toFixed(2)}`;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* nothing else to try */ }
    ta.remove();
  }
}

// Share (item 10): draw the ticket on a canvas, text only, and hand it to WhatsApp etc.
async function shareTicket() {
  const nums = numbers(), rows = ticketRows();
  try { await Promise.all(["400 26px Bungee", "600 20px 'Barlow Condensed'", "700 20px 'Barlow Condensed'"].map((f) => document.fonts.load(f))); } catch { /* fallback fonts */ }
  const S = 2, Wd = 400, rowH = 52, Hd = 118 + rows.length * rowH + 44;
  const c = document.createElement("canvas"); c.width = Wd * S; c.height = Hd * S;
  const g = c.getContext("2d"); g.scale(S, S);
  g.fillStyle = "#5C0F1B"; g.fillRect(0, 0, Wd, Hd);
  g.fillStyle = "#FFD23F"; g.font = "400 28px Bungee, sans-serif"; g.textAlign = "center"; g.fillText("EVENS JACKPOT", Wd / 2, 44);
  g.fillStyle = "#F2C9A8"; g.font = "600 17px 'Barlow Condensed', sans-serif";
  g.fillText(`${bookName(slip.bookie)} · ${rows.length} legs · ${windowById(slip.window_id).label}`, Wd / 2, 70);
  const top = 86;
  g.fillStyle = "#FFF6E0"; g.fillRect(16, top, Wd - 32, Hd - top - 24);
  for (let x = 16; x < Wd - 16; x += 12) { g.beginPath(); g.moveTo(x, Hd - 24); g.lineTo(x + 6, Hd - 16); g.lineTo(x + 12, Hd - 24); g.fill(); }
  g.textAlign = "left";
  rows.forEach((r, i) => {
    const y = top + 26 + i * rowH;
    g.fillStyle = "#7A3A2A"; g.font = "600 14px 'Barlow Condensed', sans-serif";
    g.fillText(`${r.time} · ${r.match}${r.league ? ` · ${r.league}` : ""}`.slice(0, 60), 30, y);
    g.fillStyle = "#2B0A10"; g.font = "700 19px 'Barlow Condensed', sans-serif";
    g.fillText(r.label.slice(0, 40), 30, y + 22);
    g.textAlign = "right"; g.fillText(odds(r.price), Wd - 30, y + 22); g.textAlign = "left";
  });
  const fy = top + 26 + rows.length * rowH;
  g.strokeStyle = "#5C0F1B"; g.lineWidth = 2; g.beginPath(); g.moveTo(30, fy - 12); g.lineTo(Wd - 30, fy - 12); g.stroke();
  g.fillStyle = "#5C0F1B"; g.font = "400 22px Bungee, sans-serif"; g.fillText(odds(nums.odds), 30, fy + 14);
  g.textAlign = "right"; g.font = "700 17px 'Barlow Condensed', sans-serif"; g.fillStyle = "#2B0A10";
  g.fillText(`real chance ${pct(nums.chance)} · £${slip.stake} pays £${nums.ret.toFixed(2)}`, Wd - 30, fy + 12);
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  const file = new File([blob], "evens-slip.png", { type: "image/png" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text: ticketText() }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "evens-slip.png"; a.click();
}

// "Placed it" (item 7): stamp the ticket, tear it off into the Winnings door.
function fileTicket() {
  const t = $("#ticket");
  const now = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(new Date());
  Sound.placed(); buzz(30);
  ticketState.copied = false;
  if (reducedMotion()) { renderMachine({ print: true }); return; }
  const rect = t.getBoundingClientRect(), door = $("#winsDoor").getBoundingClientRect();
  const ghost = t.cloneNode(true);
  ghost.removeAttribute("id"); ghost.classList.add("ghost");
  ghost.querySelector(".tk-actions")?.remove();
  ghost.insertAdjacentHTML("beforeend", `<span class="stamp">Placed ${esc(now)}</span>`);
  Object.assign(ghost.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, margin: 0, zIndex: 20 });
  document.body.appendChild(ghost);
  t.style.visibility = "hidden";
  setTimeout(() => {
    const dx = door.left + door.width / 2 - (rect.left + rect.width / 2), dy = door.top + door.height / 2 - (rect.top + rect.height / 2);
    ghost.style.transition = "transform .5s ease-in, opacity .5s ease-in";
    ghost.style.transform = `translate(${dx}px, ${dy}px) scale(.18) rotate(-6deg)`;
    ghost.style.opacity = ".2";
  }, 450);
  setTimeout(() => {
    ghost.remove();
    t.style.visibility = "";
    const d = $("#winsDoor"); d.classList.remove("bounce"); void d.offsetWidth; d.classList.add("bounce");
    renderMachine({ print: true });
  }, 1000);
}

// ---------- the lever (item 4) ----------
(function lever() {
  const track = $("#lever"), knob = $("#leverKnob");
  let startY = null, travel = 0, dy = 0, moved = false;
  const set = (y) => { track.style.setProperty("--pull", y); };
  const springBack = () => {
    track.classList.add("spring"); set(0);
    setTimeout(() => track.classList.remove("spring"), 320);
  };
  knob.addEventListener("pointerdown", (e) => {
    if (spinning) return;
    startY = e.clientY; dy = 0; moved = false;
    travel = track.clientHeight - knob.offsetHeight - 8;
    knob.setPointerCapture(e.pointerId);
    track.classList.remove("spring");
    e.preventDefault();
  });
  knob.addEventListener("pointermove", (e) => {
    if (startY == null) return;
    dy = Math.max(0, Math.min(travel, e.clientY - startY));
    if (dy > 4) moved = true;
    set(dy / travel);
  });
  const release = () => {
    if (startY == null) return;
    const frac = travel ? dy / travel : 0;
    startY = null;
    springBack();
    if (!moved || frac >= 0.7) pull();
  };
  knob.addEventListener("pointerup", release);
  knob.addEventListener("pointercancel", () => { startY = null; springBack(); });
  track.addEventListener("click", (e) => { if (e.target === track || e.target.classList.contains("lever-slot")) pull(); });
  track.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pull(); } });
})();
function leverDrop() {
  const track = $("#lever");
  if (reducedMotion()) return;
  track.classList.remove("spring"); track.classList.add("drop"); track.style.setProperty("--pull", 1);
  setTimeout(() => { track.classList.remove("drop"); track.classList.add("spring"); track.style.setProperty("--pull", 0); setTimeout(() => track.classList.remove("spring"), 320); }, 160);
}

// ---------- pull: staggered stops, sound, jackpot (item 5) ----------
function pull() {
  if (spinning || !slip || $("#cabinet").classList.contains("sweating")) return;
  Sound.unlock();
  clearStatus();
  const res = spin();
  Sound.lever(); buzz(30);
  if ($("#leverKnob") && !document.querySelector(".lever-track.spring")) leverDrop();
  if (!res.ok) {
    flashStatus(res.why);
    document.querySelectorAll("#reels .reel").forEach((r, i) => { if (!slip.legs[i]?.held) { r.classList.remove("fail"); void r.offsetWidth; r.classList.add("fail"); } });
    return;
  }
  playSpin(res);
  if (res.thin != null) flashStatus(`Thin pickings · best edge ${signedPct(res.thin)}`);
  else if (res.same) flashStatus("Same again · the only slip that fits");
}
// The reel animation for a slip that's already been chosen (Pull, game select, bookie change).
function playSpin(res = { ok: true }) {
  nudgesLeft = 3;
  ticketState.copied = false;
  spinning = true;
  $("#pullBtn").disabled = true; $("#pullBtn").textContent = "Spinning…";
  renderMachine({ print: false });
  const reduced = reducedMotion();
  const legs = numbers().legs;
  const prices = pool(slip.window_id, slip.bookie).flatMap((f) => f.legs.map((l) => odds(l.price))).slice(0, 8);
  const reelEls = [...document.querySelectorAll("#reels .reel")];
  const spinners = reelEls.filter((_, i) => !legs[i].held);
  spinners.forEach((r) => { r.innerHTML = `<div class="strip-spin num">${prices.concat(prices).map((p) => `<span>${esc(p)}</span>`).join("")}</div>`; });
  if (!reduced) Sound.spin();
  const first = reduced ? 120 : 600, step = reduced ? 0 : 250;
  spinners.forEach((r, j) => setTimeout(() => {
    const i = +r.dataset.i;
    r.innerHTML = reelFace(legs[i]);
    fitLabels(r);
    if (!reduced) { r.classList.remove("stop"); void r.offsetWidth; r.classList.add("stop"); }
    Sound.stop(); buzz(12);
  }, first + j * step));
  setTimeout(() => {
    spinning = false;
    $("#pullBtn").disabled = false; $("#pullBtn").textContent = "Pull for new slips";
    renderMachine({ print: true, keepReels: true });
    const nums = numbers();
    if (res.thin == null && nums.odds >= ZONE[0] && nums.odds <= ZONE[1] && nums.ev >= prefs.min_edge) jackpot();
  }, first + Math.max(0, spinners.length - 1) * step + 200);
}
function jackpot() {
  Sound.jackpot();
  const cab = $("#cabinet"), banner = $("#evensBanner");
  if (reducedMotion()) { banner.classList.add("show-static"); setTimeout(() => banner.classList.remove("show-static"), 1200); return; }
  cab.classList.remove("jackpot"); banner.classList.remove("stamp-in"); void cab.offsetWidth;
  cab.classList.add("jackpot"); banner.classList.add("stamp-in");
  setTimeout(() => { cab.classList.remove("jackpot"); banner.classList.remove("stamp-in"); }, 2500);
}

// ---------- nudges (item 6) ----------
// Cosmetic fruit-machine flavour: 3 per pull. Build a bet still has unlimited swaps.
function nudge(i, dir) {
  if ($("#cabinet").classList.contains("sweating")) return;
  const l = slip?.legs[i];
  if (spinning || !l || l.held || nudgesLeft <= 0) return;
  const fx = rawPool(slip.window_id, slip.bookie)?.fixtures.find((f) => f.fixture_id === l.fixture_id);
  if (!fx || fx.legs.length < 2) return;
  const was = numbers();
  const wasJackpot = was.odds >= ZONE[0] && was.odds <= ZONE[1] && was.ev >= prefs.min_edge;
  const list = fx.legs.slice().sort((a, c) => a.price - c.price);
  const at = list.findIndex((x) => x.leg_id === l.leg_id);
  l.leg_id = list[(at + dir + list.length) % list.length].leg_id;
  nudgesLeft--; ticketState.copied = false; saveSlip();
  Sound.nudge(); buzz(12);
  renderMachine({ print: true });
  const r = document.querySelector(`#reels .reel[data-i="${i}"]`);
  if (r && !reducedMotion()) { r.classList.remove("nudged"); void r.offsetWidth; r.classList.add("nudged"); r.dataset.dir = dir; }
  const now = numbers();
  if (!wasJackpot && now.odds >= ZONE[0] && now.odds <= ZONE[1] && now.ev >= prefs.min_edge) jackpot();
  if (!nudgesLeft) flashStatus("Out of nudges · pull to refill");
}
// Swipe up or down on a reel to nudge it.
(function swipes() {
  let y0 = null, idx = null;
  $("#reels").addEventListener("pointerdown", (e) => { const r = e.target.closest(".reel"); if (r) { y0 = e.clientY; idx = +r.dataset.i; } });
  $("#reels").addEventListener("pointerup", (e) => {
    if (y0 == null) return;
    const d = e.clientY - y0; y0 = null;
    if (Math.abs(d) > 28) nudge(idx, d < 0 ? 1 : -1);
  });
})();

// Long-press the big odds to flip fractions and decimals (item 2).
(function oddsFlip() {
  let timer = null;
  const el = $("#mOdds");
  el.addEventListener("pointerdown", () => { timer = setTimeout(() => { prefs.odds_format = prefs.odds_format === "decimal" ? "fraction" : "decimal"; savePrefs(); buzz(15); route(); }, 550); });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => el.addEventListener(ev, () => clearTimeout(timer)));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
})();

$("#pullBtn").addEventListener("click", pull);
$("#machineWhere").addEventListener("click", () => slip && openWhereSheet());
$("#bookPill").addEventListener("click", () => slip && openWhereSheet());
setInterval(() => { if (!$("#home").hidden && slip && !spinning && !$("#cabinet").classList.contains("sweating")) $("#machineWhere").textContent = marqueeTime(); }, 30000);

// ---------- round 3: the filters set the scope, holds live inside it ----------
// Scope = league chips + day range + kick-off + bookie. On any change: held legs still in
// scope stay held, the rest are released and their reels re-spin; Undo puts it all back.
const snapshotScope = () => ({ comps: (prefs.comps || []).slice(), day_range: prefs.day_range, slip: slip && JSON.parse(JSON.stringify(slip)) });
function restoreScope(snap) {
  prefs.comps = snap.comps; prefs.day_range = snap.day_range; savePrefs();
  slip = snap.slip; saveSlip();
  ticketState.copied = false;
  renderMachine({ print: true });
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function rescope(snap, why) {
  const undo = () => restoreScope(snap);
  const released = slip.legs.filter((l) => l.held && !inComps(l.fixture_id));
  released.forEach((l) => { l.held = false; });
  const w = windowById(slip.window_id);
  let ok = false;
  if (w && inRange(w.start_utc) && booksFor(w).includes(slip.bookie)) ok = spin().ok;
  if (!ok && !slip.legs.some((l) => l.held)) ok = rebuildSlip();
  if (!ok) {
    slip = snap.slip; prefs.comps = snap.comps; prefs.day_range = snap.day_range; savePrefs(); saveSlip();
    const n = Object.values(compCounts()).reduce((a, b) => a + b, 0);
    renderMachine();
    flashStatus(slip.legs.some((l) => l.held) ? "Nothing there fits your holds · release one" : `Not enough matches priced there (${n})`);
    return false;
  }
  sortSlip(); recordScope(); saveSlip();
  playSpin();
  if (released.length) flashStatus(`Released ${plural(released.length, "hold")} · ${why}`, { undo });
  return true;
}

// ---------- game select (competitions) and bookie pill ----------
function renderGameSelect() {
  const el = $("#gameSelect");
  if (!DATA) { el.innerHTML = ""; return; }
  const counts = compCounts();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const sel = prefs.comps || [];
  const chips = [{ id: "all", name: "All", n: total }]
    .concat(COMPS.map((c) => ({ id: c.id, name: c.name, n: counts[c.id] || 0 })))
    .filter((c) => c.id !== "other" || c.n || sel.includes("other"));
  el.innerHTML = chips.map((c) => {
    const on = c.id === "all" ? !sel.length : sel.includes(c.id);
    return `<button class="game-chip" data-comp="${c.id}" aria-pressed="${on}"${c.n || on ? "" : ' aria-disabled="true"'}>${esc(c.name)}<small class="num">${c.n}</small></button>`;
  }).join("");
}
function renderBookPill() {
  const b = $("#bookPill");
  b.hidden = !slip;
  if (!slip) return;
  const fav = prefs.fav_book === slip.bookie;
  b.innerHTML = `${fav ? '<span class="star" aria-hidden="true">★</span>' : ""}${esc(bookName(slip.bookie))}`;
  b.setAttribute("aria-label", `Bookie: ${bookName(slip.bookie)}${fav ? " (your bookie)" : ""}. Tap to change`);
}
$("#gameSelect").addEventListener("click", (e) => {
  const b = e.target.closest("[data-comp]");
  if (!b || spinning || !DATA) return;
  const id = b.dataset.comp;
  const name = COMPS.find((c) => c.id === id)?.long;
  if (b.getAttribute("aria-disabled") === "true") {
    flashStatus(`No ${name} prices · ${rangeName().toLowerCase()}`);
    buzz(10);
    return;
  }
  const cur = prefs.comps || [];
  // First tap focuses on one competition; more taps add or remove; All clears.
  const next = id === "all" ? [] : !cur.length ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id);
  const snap = snapshotScope();
  prefs.comps = next; savePrefs();
  Sound.unlock(); Sound.hold(); buzz(10);
  renderGameSelect();
  if (!slip || $("#cabinet").classList.contains("sweating")) return;
  rescope(snap, next.length ? `not ${scopeName()}` : "");
});
window.addEventListener("resize", () => fitLabels($("#reels")));

// ---------- Build a bet ----------
let copied = false;
function renderBuild() {
  if (!slip) {
    $("#buildLegs").innerHTML = `<div class="empty">No kick-offs with prices in the next two days. Check back after the morning refresh.</div>`;
    return;
  }
  const w = windowById(slip.window_id);
  $("#buildWhere").innerHTML = `<span>${esc(bookName(slip.bookie))}</span><small>${esc(dayWord(w.start_utc))} ${esc(fmtTime(w.start_utc, false))}</small>`;
  const nums = numbers();
  const n = nums.legs.length;
  $("#buildLegs").innerHTML = nums.legs.map(({ fx, leg, held }, i) => {
    const choices = (rawPool(slip.window_id, slip.bookie).fixtures.find((f) => f.fixture_id === fx.fixture_id)?.legs || []).length;
    return `<div class="bleg${held ? " held" : ""}" data-i="${i}">
      <button class="hold-btn" data-act="hold" aria-pressed="${held}" aria-label="Hold this leg">${held ? "Held" : "Hold"}</button>
      <div class="info"><span class="match">${esc(fx.home)} v ${esc(fx.away)} · ${esc(dayWord(fx.kickoff_utc))} ${esc(fmtTime(fx.kickoff_utc, false))}</span>
        <span class="sel">${esc(leg.label)}</span>
        <span class="meta num">${oddsH(leg.price)} · ${pct(leg.fair_p)} chance · edge ${edgeTag(leg.edge)}${bandFit(leg.price) < 1 ? ` · <span class="offspot">outside sweet spot</span>` : ""}</span></div>
      <button class="ibtn" data-act="prev" aria-label="Previous market for this match" ${choices < 2 ? "disabled" : ""}><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4 L6 10 L12 16" fill="none" stroke="#5C0F1B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="ibtn" data-act="next" aria-label="Next market for this match" ${choices < 2 ? "disabled" : ""}><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4 L14 10 L8 16" fill="none" stroke="#5C0F1B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="ibtn x" data-act="remove" aria-label="Remove this leg" ${n <= MIN_LEGS || held ? "disabled" : ""}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 L13 13 M13 3 L3 13" stroke="#8C1D2C" stroke-width="2.5" stroke-linecap="round"/></svg></button>
    </div>`;
  }).join("");
  $("#buildLegs").querySelectorAll(".bleg").forEach((row) => row.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const i = +row.dataset.i, l = slip.legs[i];
    if (b.dataset.act === "hold") { l.held = !l.held; Sound.hold(); }
    if (b.dataset.act === "remove" && slip.legs.length > MIN_LEGS && !l.held) slip.legs.splice(i, 1);
    if (b.dataset.act === "prev" || b.dataset.act === "next") {
      const fx = rawPool(slip.window_id, slip.bookie).fixtures.find((f) => f.fixture_id === l.fixture_id);
      const list = fx.legs.slice().sort((a, c) => a.price - c.price);
      const at = list.findIndex((x) => x.leg_id === l.leg_id);
      l.leg_id = list[(at + (b.dataset.act === "next" ? 1 : -1) + list.length) % list.length].leg_id;
    }
    copied = false; saveSlip(); renderBuild();
  })));

  const full = n >= MAX_LEGS, free = bestFreeLeg();
  const add = $("#addLeg");
  add.disabled = full || !free;
  add.textContent = full ? "Six legs is the max" : free ? "+ Add a leg from another match" : "No other matches in this window";

  $("#needle").style.left = `${Math.max(0, Math.min(100, ((nums.odds - 1.5) / 1.5) * 100))}%`;
  $("#bOdds").innerHTML = oddsH(nums.odds);
  $("#meterScale").innerHTML = `<span>${esc(odds(1.5))}</span><span>${esc(zoneLabel())}</span><span>${esc(odds(3))}</span>`;
  $("#bFair").innerHTML = fairLine(nums);
  const st = $("#bStatus");
  if (nums.odds < ZONE[0]) { st.textContent = "A bit short — add a leg"; st.style.color = "var(--jackpot)"; }
  else if (nums.odds > ZONE[1]) { st.textContent = "Getting long — drop one"; st.style.color = "var(--bad-on-dark)"; }
  else { st.textContent = "✓ Bang on evens"; st.style.color = "var(--good-on-dark)"; }
  $("#bChance").textContent = `Real chance ${pct(nums.chance)}`;
  $("#bEdge").innerHTML = `Edge ${edgeTag(nums.ev)}`;
  $("#stake").textContent = `£${slip.stake}`;
  $("#bReturns").textContent = `Returns £${nums.ret.toFixed(2)}`;
  $("#copyBtn").textContent = copied ? "Copied" : `Copy to ${bookName(slip.bookie)}`;
  $("#placedBtn").hidden = !copied;
  renderPool();
}

function renderPool() {
  const inSlip = Object.fromEntries(slip.legs.map((l) => [l.fixture_id, l.leg_id]));
  const p = pool(slip.window_id, slip.bookie);
  $("#pool").innerHTML = p.map((fx) => `<div class="pool-match"><div class="pm-head"><span>${esc(fx.home)} v ${esc(fx.away)}</span><small>${esc(fmtTime(fx.kickoff_utc, false))} ${esc(fx.league)}</small></div>
    ${fx.legs.map((l) => `<button class="pool-leg${inSlip[fx.fixture_id] === l.leg_id ? " in" : ""}" data-fx="${esc(fx.fixture_id)}" data-leg="${esc(l.leg_id)}">
      <span>${esc(l.label)}<br><small class="num">real chance ${pct(l.fair_p)}${bandFit(l.price) === 1 ? " · sweet spot" : ""}</small></span><span class="p num">${oddsH(l.price)}</span>${edgeTag(l.edge)}</button>`).join("")}</div>`).join("")
    || `<p class="hint">No legs match your filters. Loosen them in Settings.</p>`;
  $("#pool").querySelectorAll(".pool-leg").forEach((b) => b.addEventListener("click", () => {
    const at = slip.legs.findIndex((l) => l.fixture_id === b.dataset.fx);
    if (at >= 0) slip.legs[at].leg_id = b.dataset.leg;
    else if (slip.legs.length < MAX_LEGS) slip.legs.push({ fixture_id: b.dataset.fx, leg_id: b.dataset.leg, held: false });
    else return;
    sortSlip(); copied = false; saveSlip(); renderBuild();
  }));
}

$("#addLeg").addEventListener("click", () => {
  const b = bestFreeLeg();
  if (!b || slip.legs.length >= MAX_LEGS) return;
  slip.legs.push({ fixture_id: b.fx.fixture_id, leg_id: b.leg.leg_id, held: false });
  sortSlip(); copied = false; saveSlip(); renderBuild();
});
$("#stakeDown").addEventListener("click", () => { slip.stake = Math.max(5, slip.stake - 5); saveSlip(); renderBuild(); });
$("#stakeUp").addEventListener("click", () => { slip.stake = Math.min(20, slip.stake + 5); saveSlip(); renderBuild(); });
$("#buildWhere").addEventListener("click", () => slip && openWhereSheet());

$("#copyBtn").addEventListener("click", async () => {
  await copyText(ticketText());
  copied = true; renderBuild();
});
$("#placedBtn").addEventListener("click", () => openPlaceSheet(currentSlipAsBet()));

function currentSlipAsBet() {
  const nums = numbers();
  return { book: slip.bookie, label: windowById(slip.window_id).label, start: slip.window_id, odds: nums.odds,
    hit_p: nums.chance, ev: nums.ev, stake: slip.stake,
    legIds: nums.legs.map(({ leg }) => leg.leg_id),
    legs: nums.legs.map(({ fx, leg }) => ({ label: leg.label, match: `${fx.home} v ${fx.away}`, kickoff: fx.kickoff_utc, price: leg.price, p_win: leg.fair_p })) };
}

// ---------- choose window and bookie ----------
function openWhereSheet() {
  let wid = slip.window_id, bk = slip.bookie, range = prefs.day_range;
  const draw = (s) => {
    const inR = (w) => inRange(w.start_utc, range) && booksFor(w).length;
    const wins = upcomingAll().filter(inR);
    if (!wins.some((x) => x.id === wid)) wid = wins[0]?.id || wid;
    const w = windowById(wid);
    const fav = prefs.fav_book;
    const books = booksFor(w).slice().sort((a, b) => (b === fav) - (a === fav));
    if (!books.includes(bk)) bk = books[0];
    const favMissing = fav && !books.includes(fav);
    // Kick-offs grouped under day headers.
    let lastDay = null;
    const kicks = wins.map((x) => {
      const head = dayKey(x.start_utc) !== lastDay ? `<div class="day-head">${esc(dayHeader(x.start_utc))}</div>` : "";
      lastDay = dayKey(x.start_utc);
      return `${head}<button class="chip" data-w="${x.id}" aria-pressed="${x.id === wid}">${esc(fmtTime(x.start_utc, false))}</button>`;
    }).join("");
    s.innerHTML = `<h3 id="sheetTitle">When, and which bookie?</h3>
      <div class="seg" role="group" aria-label="Day range">${RANGES.map(([r, label]) => {
        const ok = rangeAvailable(r);
        return `<button class="seg-btn" data-r="${r}" aria-pressed="${r === range}"${ok ? "" : ' aria-disabled="true" title="No odds that far out yet"'}>${esc(label)}</button>`;
      }).join("")}</div>
      ${rangeAvailable("14") ? "" : '<p class="hint seg-note">Next 14 days: no odds that far out yet.</p>'}
      <div class="field"><span class="lbl">Kick-off</span><div class="chips day-chips">${kicks || '<span class="hint">No kick-offs with prices in this range.</span>'}</div></div>
      <div class="field"><span class="lbl">Bookie</span><div class="chips">${books.map((b) => `<button class="chip" data-b="${b}" aria-pressed="${b === bk}">${b === fav ? "★ " : ""}${esc(bookName(b))} <small>${pool(wid, b).length}</small></button>`).join("")}</div>
        <button class="star-btn" id="wStar" aria-pressed="${fav === bk}">${fav === bk ? `★ ${esc(bookName(bk))} is your bookie` : `☆ Make ${esc(bookName(bk))} my bookie`}</button></div>
      <p class="hint">The number is how many matches that bookie has priced at this kick-off${prefs.comps?.length ? ` (${esc(scopeName())} only)` : ""}. Your bookie is the one the machine loads first, whenever it has prices.${favMissing ? ` ${esc(bookName(fav))} hasn't priced this kick-off.` : ""}</p>
      ${bk && pool(wid, bk).length < 3 ? `<div class="notice">${esc(bookName(bk))} has only priced ${pool(wid, bk).length} ${pool(wid, bk).length === 1 ? "match" : "matches"} here, so the reels can't get near evens with it.</div>` : ""}
      <div class="sheet-actions"><button class="cbtn plain" id="wCancel">Cancel</button><button class="cbtn yellow" id="wGo"${wins.length ? "" : " disabled"}>Load the reels</button></div>`;
    s.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => {
      if (b.getAttribute("aria-disabled") === "true") return;
      range = b.dataset.r; draw(s);
    }));
    s.querySelectorAll("[data-w]").forEach((b) => b.addEventListener("click", () => { wid = b.dataset.w; draw(s); }));
    s.querySelectorAll("[data-b]").forEach((b) => b.addEventListener("click", () => { bk = b.dataset.b; draw(s); }));
    s.querySelector("#wStar").addEventListener("click", () => {
      prefs.fav_book = prefs.fav_book === bk ? null : bk; savePrefs(); buzz(10); draw(s);
    });
    s.querySelector("#wCancel").addEventListener("click", () => { closeSheet(); route(); });
    s.querySelector("#wGo").addEventListener("click", () => {
      const snap = snapshotScope();
      const rangeChanged = range !== prefs.day_range;
      prefs.day_range = range; savePrefs();
      const res = changeWhere(wid, bk);
      closeSheet(); route();
      if (!res.changed) { if (rangeChanged) renderMachine(); return; }
      if (!$("#home").hidden && !$("#cabinet").classList.contains("sweating")) {
        playSpin();
        const o = numbers().odds;
        const why = bk !== snap.slip.bookie ? `not at ${bookName(bk)}` : "other kick-off";
        if (res.released) flashStatus(`Released ${plural(res.released, "hold")} · ${why}`, { undo: () => restoreScope(snap) });
        else if (o < ZONE[0] || o > ZONE[1]) flashStatus(`${bookName(bk)} can't reach evens here`);
      }
    });
  };
  openSheet("", draw);
}
function changeWhere(wid, bk) {
  if (wid === slip.window_id && bk === slip.bookie) return { changed: false, released: 0 };
  const n = Math.max(4, Math.min(slip.legs.length, MAX_LEGS));
  const held = slip.legs.filter((l) => l.held);
  const keep = held.filter((l) => findLeg(wid, bk, l.leg_id) && inComps(l.fixture_id));
  const kept = keep.length;
  slip = { window_id: wid, bookie: bk, stake: slip.stake, legs: keep };
  fillTo(Math.max(n, MIN_LEGS));
  if (slip.legs.length >= MIN_LEGS) spin();
  sortSlip(); copied = false; recordScope(); saveSlip();
  return { changed: true, released: held.length - kept };
}

// ---------- Play (today's slips) ----------
let playWindow = null;
function mergeTwins(slips) {
  const out = [], seen = new Map();
  for (const s of slips) {
    const key = s.legs.map((id) => id + "@" + s.prices[id]).sort().join("|");
    if (seen.has(key)) { seen.get(key).alsoAt.push(s.book); continue; }
    const c = Object.assign({}, s, { alsoAt: [] }); seen.set(key, c); out.push(c);
  }
  return out;
}
function renderPlay() {
  const mine = new Set(myBooks());
  const fav = prefs.fav_book;
  const slips = mergeTwins(DATA.slips.filter((s) => Date.parse(s.start) > Date.now() && mine.has(s.book)
      && s.legs.every((id) => inComps(LEGS[id]?.fixture_id)))
    .sort((a, b) => (b.book === fav) - (a.book === fav) || b.ev - a.ev))
    .filter((s, i, arr) => arr.filter((x) => x.start === s.start).indexOf(s) < 3);
  const starts = [...new Set(slips.map((s) => s.start))].sort();
  if (!starts.includes(playWindow)) playWindow = starts[0] || null;
  $("#windows").innerHTML = starts.map((st) => `<button class="chip num" data-start="${st}" aria-pressed="${st === playWindow}">${esc(fmtTime(st))}</button>`).join("");
  $("#windows").querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { playWindow = c.dataset.start; renderPlay(); }));
  const picked = (prefs.comps || []).map((c) => COMPS.find((x) => x.id === c)?.name).filter(Boolean);
  $("#playNotes").innerHTML = (picked.length ? `<div class="notice">Showing ${esc(picked.join(" + "))} only. Change it with the game buttons on the machine.</div>` : "")
    + (DATA.notes || []).filter((n) => !/^Refreshed/.test(n)).map((n) => `<div class="notice">${esc(n)}</div>`).join("");
  const shown = slips.filter((s) => s.start === playWindow);
  $("#slips").innerHTML = shown.length ? shown.map(slipCard).join("") +
    `<p class="hint">Real chance and edge use Pinnacle's prices with the margin taken out. Edge is the expected gain or loss per £1 over many bets.</p>`
    : `<div class="empty">No slips near evens for the coming kick-offs. Pull the lever or open Build a bet.</div>`;
  $("#slips").querySelectorAll("[data-slip]").forEach((card) => {
    const s = shown.find((x) => x.id === card.dataset.slip);
    card.querySelector('[data-act="load"]').addEventListener("click", () => { loadPublished(s); location.hash = "#home"; });
    card.querySelector('[data-act="edit"]').addEventListener("click", () => { loadPublished(s); location.hash = "#build"; });
  });
}
function loadPublished(s) {
  slip = { window_id: s.start, bookie: s.book, stake: slip?.stake || 10,
    legs: s.legs.map((id) => ({ fixture_id: LEGS[id]?.fixture_id || id.split("|")[0], leg_id: id, held: false })) };
  sortSlip(); copied = false; saveSlip();
}
function slipCard(s) {
  const rows = s.legs.map((id) => {
    const l = LEGS[id], f = FIX[l.fixture_id];
    return `<div class="cleg"><span class="sel">${esc(l.label)}</span><span class="p num">${oddsH(s.prices[id])}<small>${pct(l.p_win)} likely</small></span>
      <span class="m">${esc(f.home)} v ${esc(f.away)}, ${esc(fmtTime(f.kickoff, false))} ${esc(f.league)}</span></div>`;
  }).join("");
  return `<article class="card" data-slip="${esc(s.id)}">
    <div class="card-head"><b>${esc(bookName(s.book))}</b><span>${esc(s.label)}, ${s.n_legs} legs</span></div>
    ${s.alsoAt.length ? `<div class="also">Same prices at ${s.alsoAt.map((b) => esc(bookName(b))).join(", ")}</div>` : ""}
    ${rows}
    <div class="card-foot">
      <div><b class="num">${oddsH(s.odds)}</b><span>Combined odds</span></div>
      <div><b class="num">${pct(s.hit_p)}</b><span>Real chance it lands</span></div>
      <div><b class="num">£${(10 * s.odds).toFixed(2)}</b><span>£10 returns</span></div>
      <div><b>${edgeTag(s.ev)}</b><span>Edge</span></div>
    </div>
    <div class="card-actions"><button class="cbtn yellow" data-act="load">Load into the machine</button><button class="cbtn cyan" data-act="edit">Edit this slip</button></div>
  </article>`;
}

// ---------- sheets ----------
function openSheet(html, mount) {
  $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false;
  mount && mount($("#sheetBody"));
  $("#sheetBody").querySelector("input, button")?.focus();
}
function closeSheet() { $("#sheet").hidden = true; $("#sheetBody").innerHTML = ""; }
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

// ---------- Winnings (my bets) ----------
function openPlaceSheet(b, opts = {}) {
  openSheet(`<h3 id="sheetTitle">Log this bet</h3>
    <p class="hint">${esc(bookName(b.book))}, ${b.legs.length} legs, ${esc(b.label)}</p>
    <div class="field"><label for="pStake">Stake (£)</label><input id="pStake" type="number" inputmode="decimal" min="0.1" step="0.5" value="${b.stake}"></div>
    <div class="field"><label for="pOdds">Odds you got (decimal${prefs.odds_format === "decimal" ? "" : `, about ${esc(odds(b.odds))}`})</label><input id="pOdds" type="number" inputmode="decimal" min="1.01" step="0.01" value="${b.odds.toFixed(2)}"></div>
    <div class="err" id="pErr"></div>
    <div class="sheet-actions"><button class="cbtn plain" id="pCancel">Cancel</button><button class="cbtn green" id="pSave">Save bet</button></div>`, (s) => {
    s.querySelector("#pCancel").addEventListener("click", closeSheet);
    s.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => (s.querySelector("#pErr").textContent = "")));
    s.querySelector("#pSave").addEventListener("click", () => {
      const stake = parseFloat(s.querySelector("#pStake").value), o = parseFloat(s.querySelector("#pOdds").value);
      if (!(stake > 0)) { s.querySelector("#pErr").textContent = "Enter a stake above £0."; return; }
      if (!(o >= 1.01)) { s.querySelector("#pErr").textContent = "Enter the odds as a decimal, for example 2.05."; return; }
      bets.unshift({ id: `${Date.now()}`, placedAt: new Date().toISOString(), book: b.book, bookName: bookName(b.book), label: b.label, start: b.start,
        stake, odds: o, hit_p: b.hit_p, ev: b.ev, legIds: b.legIds, legs: b.legs, status: "pending", returns: null });
      saveBets(); closeSheet(); copied = false;
      if (opts.onSaved) opts.onSaved();
      else { Sound.placed(); location.hash = "#winnings"; }
    });
  });
}

function autoSettleBets() {
  if (!HIST) return;
  const key = (book, ids) => book + "|" + ids.slice().sort().join("|");
  const byKey = Object.fromEntries((HIST.slips || []).map((s) => [key(s.book, s.legs.map((l) => l.id)), s]));
  let changed = false;
  bets.forEach((b) => {
    const h = b.legIds && byKey[key(b.book, b.legIds)];
    if (b.status === "pending" && h && (h.status === "won" || h.status === "lost")) {
      b.status = h.status; b.returns = h.status === "won" ? b.stake * b.odds : 0; b.settledAt = new Date().toISOString(); changed = true;
    }
  });
  if (changed) saveBets();
}

function betStats() {
  const settled = bets.filter((b) => b.status !== "pending").slice().sort((a, c) => a.placedAt.localeCompare(c.placedAt));
  let pl = 0, peak = 0, dd = 0, staked = 0, won = 0;
  const series = [];
  settled.forEach((b) => {
    const profit = b.status === "void" ? 0 : (b.returns ?? 0) - b.stake;
    if (b.status !== "void") staked += b.stake;
    if (b.status === "won") won++;
    pl += profit; peak = Math.max(peak, pl); dd = Math.min(dd, pl - peak);
    series.push({ x: series.length + 1, y: pl, label: `${b.label}: ${signedMoney(profit)}` });
  });
  const month = new Date().toISOString().slice(0, 7);
  const monthStaked = bets.filter((b) => b.placedAt.slice(0, 7) === month).reduce((s, b) => s + b.stake, 0);
  return { settled, pl, staked, won, roi: staked ? pl / staked : null, dd, series, monthStaked };
}

function renderBets() {
  const st = betStats();
  const pending = bets.filter((b) => b.status === "pending");
  const over = st.monthStaked > settings.monthlyLimit;
  const sim = simulate();
  $("#betsBody").innerHTML = `
    <div class="tiles">
      <div class="tile"><b class="num">${signedMoney(st.pl)}</b><span>Profit so far</span></div>
      <div class="tile"><b class="num">${st.roi == null ? "–" : signedPct(st.roi)}</b><span>Return on stakes</span></div>
      <div class="tile"><b class="num">${st.won} of ${st.settled.filter((b) => b.status !== "void").length}</b><span>Slips won</span></div>
      <div class="tile"><b class="num">${money(-st.dd)}</b><span>Biggest dip from a high</span></div>
    </div>
    <div class="notice">This month <b class="num">${money(st.monthStaked)}</b> staked of your <b class="num">${money(settings.monthlyLimit)}</b> limit.
      <div class="progress ${over ? "over" : ""}"><div style="width:${Math.min(100, (st.monthStaked / settings.monthlyLimit) * 100)}%"></div></div>
      ${over ? `<div class="err">You're over your monthly limit.</div>` : ""}</div>
    ${st.series.length >= 2 ? `<h3 class="sec">Profit over time</h3><div class="chart" id="plChart"></div>` : ""}
    <h3 class="sec">Next 50 slips</h3>
    <p class="hint">${esc(sim.basis)}</p>
    <div class="chart" id="simChart"></div>
    <div class="legend"><span><i style="background:rgba(255,210,63,.12)"></i>8 in 10 runs</span><span><i style="background:rgba(255,210,63,.24)"></i>Middle half</span><span><i style="background:var(--jackpot);height:3px"></i>Typical</span></div>
    <p class="hint num">At £10 a slip you'd be ahead after 50 in ${pct(sim.pAhead)} of runs. Typical result ${signedMoney(sim.median)}; a bad run (1 in 10) ${signedMoney(sim.p10)}.</p>
    <h3 class="sec">Waiting on results</h3>
    ${pending.length && LIVE ? `<p class="hint">${esc(liveNote())}</p>` : ""}
    ${pending.length ? pending.map(betCard).join("") : `<p class="hint">Copy a slip in Build a bet, then tap "Placed it" to log it here.</p>`}
    ${st.settled.length ? `<h3 class="sec">Settled</h3>${bets.filter((b) => b.status !== "pending").slice(0, 30).map(betCard).join("")}` : ""}
    <h3 class="sec">Backup</h3>
    <p class="hint">Your bets live on this phone only. Save a copy now and then.</p>
    <div class="card-actions" style="padding:0"><button class="cbtn plain" id="exportBets">Save a copy</button><label class="cbtn plain" style="display:inline-grid;place-items:center">Restore a copy<input id="importBets" type="file" accept="application/json" hidden></label></div>`;
  if (st.series.length >= 2) lineChart($("#plChart"), st.series);
  fanChart($("#simChart"), sim.bands);
  $("#betsBody").querySelectorAll("[data-bet]").forEach((card) => {
    const b = bets.find((x) => x.id === card.dataset.bet);
    card.querySelectorAll("[data-set]").forEach((btn) => btn.addEventListener("click", () => {
      const s = btn.dataset.set;
      if (s === "delete") bets = bets.filter((x) => x !== b);
      else { b.status = s; b.returns = s === "won" ? b.stake * b.odds : s === "void" ? b.stake : 0; b.settledAt = new Date().toISOString(); b.manual = true; b.settledBy = "you"; }
      saveBets(); renderBets();
    }));
  });
  $("#exportBets").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ bets, settings }, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `evens-bets-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  });
  $("#importBets").addEventListener("change", async (e) => {
    try {
      const obj = JSON.parse(await e.target.files[0].text());
      if (!Array.isArray(obj.bets)) throw new Error();
      bets = obj.bets; if (obj.settings) settings = Object.assign({}, DEFAULTS, obj.settings);
      saveBets(); saveSettings(); route();
    } catch { alert("That file isn't an Evens backup."); }
  });
}

function liveNote() {
  const f = LIVE.feeds || {};
  const quick = f.api_football?.ok;
  const when = LIVE.updated_at ? fmtTime(LIVE.updated_at, false) : "";
  return `Scores checked ${when}${quick === false ? " (a few minutes behind for now)" : ""}. They update about every 10 minutes while matches are on.`;
}

function betCard(b) {
  const settled = b.status !== "pending";
  const profit = b.status === "void" ? 0 : (b.returns ?? 0) - b.stake;
  const tag = { won: `Won ${signedMoney(profit)}`, lost: `Lost ${signedMoney(profit)}`, void: "Void", pending: "Waiting" }[b.status];
  return `<div class="card bet" data-bet="${esc(b.id)}">
    <div class="bet-top"><div><b>${esc(b.bookName)}</b> <span class="sub">${esc(b.label)}</span></div><span class="status ${b.status}">${esc(tag)}</span></div>
    <div class="sub num">£${b.stake.toFixed(2)} at ${odds(b.odds)}, real chance ${pct(b.hit_p)}</div>
    ${b.legs.map((l, i) => `<div class="sub bet-leg"><span>${esc(l.label)} <span class="num">${odds(l.price)}</span>, ${esc(l.match)}</span>${b.legIds?.[i] && LIVE ? legChip(b.legIds[i], l.kickoff) : ""}</div>`).join("")}
    ${settled && b.settledBy === "scores" ? `<div class="sub">Settled from the scores. Tap Undo if your bookie disagrees.</div>` : ""}
    <div class="card-actions" style="padding:8px 0 0">${settled ? `<button class="cbtn plain" data-set="pending">Undo result</button>` :
      `<button class="cbtn green" data-set="won">Won</button><button class="cbtn red" data-set="lost">Lost</button><button class="cbtn plain" data-set="void">Void</button>`}
      <button class="cbtn plain" data-set="delete">Delete</button></div>
  </div>`;
}

// Monte Carlo: 50 slips, from your bets (5+) or today's suggestions.
function simulate() {
  const N = 50, RUNS = 2000;
  let src = bets.filter((b) => b.hit_p && b.odds).map((b) => ({ p: b.hit_p, o: b.odds }));
  let basis = "Based on the bets you've logged, assuming the model's chances are right.";
  if (src.length < 5) {
    src = (DATA?.slips || []).map((s) => ({ p: s.hit_p, o: s.odds }));
    basis = "Based on today's suggested slips, assuming the model's chances are right. Real results swing a lot.";
  }
  if (!src.length) src = [{ p: 0.47, o: 2.05 }];
  const paths = Array.from({ length: N + 1 }, () => new Float64Array(RUNS));
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let r = 0; r < RUNS; r++) {
    let pl = 0;
    for (let i = 1; i <= N; i++) {
      const s = src[Math.floor(rand() * src.length)];
      pl += rand() < s.p ? 10 * (s.o - 1) : -10;
      paths[i][r] = pl;
    }
  }
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const bands = paths.map((col, i) => { const a = Array.from(col).sort((x, y) => x - y); return { x: i, p10: q(a, 0.1), p25: q(a, 0.25), p50: q(a, 0.5), p75: q(a, 0.75), p90: q(a, 0.9) }; })
    .filter((b) => b.x % 5 === 0);
  const last = Array.from(paths[N]).sort((x, y) => x - y);
  return { bands, basis, pAhead: last.filter((v) => v > 0).length / RUNS, median: q(last, 0.5), p10: q(last, 0.1) };
}

// ---------- Payout table (the model's record) ----------
function renderRecord() {
  if (!HIST || !HIST.summary) { $("#recordBody").innerHTML = `<div class="empty">The payout table fills in as matches finish. Check back after the weekend.</div>`; return; }
  const s = HIST.summary;
  const cal = Object.values(HIST.calibration || {}).map((v) => ({ said: v.p_sum / v.n, came: v.wins / v.n, n: v.n })).filter((b) => b.n > 0).sort((a, c) => a.said - c.said);
  const list = [...(HIST.slips || []).filter((x) => x.status === "pending").slice(0, 5), ...(HIST.slips || []).filter((x) => x.status !== "pending").slice(0, 25)];
  $("#recordBody").innerHTML = `
    <div class="tiles">
      <div class="tile"><b class="num">${s.won} of ${s.won + s.lost}</b><span>Slips won (expected ${s.expected_wins})</span></div>
      <div class="tile"><b class="num">${signedMoney(s.profit_per_10)}</b><span>Profit at £10 a slip</span></div>
      <div class="tile"><b class="num">${s.roi == null ? "–" : signedPct(s.roi)}</b><span>Return on stakes</span></div>
      <div class="tile"><b class="num">${s.pending}</b><span>Waiting on results</span></div>
    </div>
    <h3 class="sec">Does it know what it's saying?</h3>
    <p class="hint">Each dot is a group of legs. Across: how likely the model said they were. Up: how often they came in. On the dashed line means honest chances.</p>
    ${cal.length ? `<div class="chart" id="calChart"></div>` : `<p class="hint">Needs a weekend of results first.</p>`}
    <h3 class="sec">Recent slips</h3>
    ${list.map(recordCard).join("") || `<p class="hint">None yet.</p>`}`;
  if (cal.length) calibrationChart($("#calChart"), cal);
}
function recordCard(h) {
  const mark = (r) => (r === "won" ? "✓" : r === "lost" ? "✕" : r === "void" ? "–" : "·");
  const tag = { won: `Won ${signedMoney(h.profit_per_10)}`, lost: "Lost −£10.00", pending: "Waiting", void: "Void", unsettled: "No result" }[h.status] || h.status;
  return `<div class="card bet"><div class="bet-top"><div><b>${esc(bookName(h.book))}</b> <span class="sub">${esc(h.label)}, ${odds(h.odds)}</span></div><span class="status ${h.status}">${esc(tag)}</span></div>
    ${h.legs.map((l) => `<div class="sub">${mark(l.result)} ${esc(l.label)} <span class="num">${odds(l.price)}</span>, ${esc(l.match)}${l.score ? ` <b class="num">${esc(l.score)}</b>` : ""}</div>`).join("")}</div>`;
}

// ---------- charts (plain SVG) ----------
const W = 340, H = 170, PAD = { l: 44, r: 10, t: 10, b: 22 };
const scale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
const ticks = (lo, hi, n = 4) => Array.from({ length: n + 1 }, (_, i) => lo + (i * (hi - lo)) / n);
function addHover(el, svg, xs, tipFor) {
  const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; el.appendChild(tip);
  const cross = svg.querySelector(".cross");
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    let i = 0; xs.forEach((v, k) => { if (Math.abs(v - x) < Math.abs(xs[i] - x)) i = k; });
    const t = tipFor(i);
    if (cross) { cross.setAttribute("x1", xs[i]); cross.setAttribute("x2", xs[i]); cross.style.display = ""; }
    tip.innerHTML = t.html; tip.hidden = false;
    tip.style.left = `${Math.max(60, Math.min(rect.width - 60, (xs[i] / W) * rect.width))}px`;
    tip.style.top = `${(t.y / H) * rect.height + 10}px`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; if (cross) cross.style.display = "none"; });
}
function lineChart(el, pts) {
  const ys = pts.map((p) => p.y).concat(0), lo = Math.min(...ys), hi = Math.max(...ys);
  const x = scale(pts[0].x, pts[pts.length - 1].x, PAD.l, W - PAD.r), y = scale(lo, hi, H - PAD.b, PAD.t);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running profit after each settled bet">
    ${ticks(lo, hi).map((t) => `<text class="tick" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${poundTick(t)}</text>`).join("")}
    <line class="zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}"/>
    <path class="ln" d="${pts.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join("")}"/>
    <line class="cross" y1="${PAD.t}" y2="${H - PAD.b}" style="display:none"/>
    <text class="tick" x="${W - PAD.r}" y="${H - 4}" text-anchor="end">Bets settled</text></svg>`;
  addHover(el, el.querySelector("svg"), pts.map((p) => x(p.x)), (i) => ({ html: `Bet ${pts[i].x}: ${esc(signedMoney(pts[i].y))} total<br>${esc(pts[i].label)}`, y: y(pts[i].y) }));
}
function fanChart(el, bands) {
  const lo = Math.min(...bands.map((b) => b.p10), 0), hi = Math.max(...bands.map((b) => b.p90), 0);
  const x = scale(0, bands[bands.length - 1].x, PAD.l, W - PAD.r), y = scale(lo, hi, H - PAD.b, PAD.t);
  const area = (a, b) => bands.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p[a])}`).join("") + bands.slice().reverse().map((p) => `L${x(p.x)},${y(p[b])}`).join("") + "Z";
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Range of possible profit over the next 50 slips">
    ${ticks(lo, hi).map((t) => `<text class="tick" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${poundTick(t)}</text>`).join("")}
    <path class="band1" d="${area("p90", "p10")}"/><path class="band2" d="${area("p75", "p25")}"/>
    <line class="zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}"/>
    <path class="ln" d="${bands.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.p50)}`).join("")}"/>
    <line class="cross" y1="${PAD.t}" y2="${H - PAD.b}" style="display:none"/>
    <text class="tick" x="${W - PAD.r}" y="${H - 4}" text-anchor="end">Slips from now</text></svg>`;
  addHover(el, el.querySelector("svg"), bands.map((b) => x(b.x)), (i) => {
    const b = bands[i];
    return { html: `After ${b.x} slips<br>Typical ${esc(signedMoney(b.p50))}<br>8 in 10: ${esc(signedMoney(b.p10))} to ${esc(signedMoney(b.p90))}`, y: y(b.p50) };
  });
}
function calibrationChart(el, bins) {
  const lo = 0.5, hi = 1, x = scale(lo, hi, PAD.l, W - PAD.r), y = scale(lo, hi, H - PAD.b, PAD.t);
  const maxN = Math.max(...bins.map((b) => b.n));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted chance against how often legs came in">
    ${[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => `<text class="tick" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)}%</text><text class="tick" x="${x(t)}" y="${H - 6}" text-anchor="middle">${Math.round(t * 100)}%</text>`).join("")}
    <line class="ref" x1="${x(lo)}" y1="${y(lo)}" x2="${x(hi)}" y2="${y(hi)}"/>
    ${bins.map((b) => `<circle class="dot" cx="${x(b.said)}" cy="${y(Math.max(lo, b.came))}" r="${(5 + 7 * Math.sqrt(b.n / maxN)).toFixed(1)}"/>`).join("")}</svg>`;
  addHover(el, el.querySelector("svg"), bins.map((b) => x(b.said)), (i) => ({ html: `Said ${pct(bins[i].said)}, came in ${pct(bins[i].came)}<br>${bins[i].n} legs`, y: y(Math.max(lo, bins[i].came)) }));
}

// ---------- settings ----------
const SWEET_SPOTS = [
  { id: "short", range: [1.1, 1.2], label: "1/10 – 1/5" },
  { id: "default", range: [1.14, 1.26], label: "1/7 – 1/4" },
  { id: "long", range: [1.2, 1.33], label: "1/5 – 1/3" },
];
$("#settingsBtn").addEventListener("click", () => {
  const draft = Object.assign({}, settings, { myBooks: myBooks().slice() });
  const p = JSON.parse(JSON.stringify(prefs));
  const chipRow = (name, opts, cur) => `<div class="chips">${opts.map(([v, txt]) => `<button class="chip" data-${name}="${v}" aria-pressed="${String(v) === String(cur)}">${txt}</button>`).join("")}</div>`;
  openSheet("", (s) => {
    const spot = SWEET_SPOTS.find((x) => x.range[0] === p.sweet_spot[0] && x.range[1] === p.sweet_spot[1])?.id || "default";
    s.innerHTML = `<h3 id="sheetTitle">Settings</h3>
      <div class="field"><span class="lbl">Show odds as</span>${chipRow("fmt", [["fraction", "Fractions (6/5)"], ["decimal", "Decimal (2.20)"]], p.odds_format)}
        <p class="hint">Or hold the big odds number on the machine to flip.</p></div>
      <div class="field"><span class="lbl">Legs per slip</span>${chipRow("legs", [["mix", "4 or 5"], [4, "4"], [5, "5"]], p.legs_per_slip)}</div>
      <div class="field"><span class="lbl">Leg price sweet spot</span>${chipRow("spot", SWEET_SPOTS.map((x) => [x.id, x.label]), spot)}
        <p class="hint">A slip around evens lands about half the time however many legs it has. Short legs make each one safer and the sweat more fun, but don't lower the overall risk. Bookie margin adds up with every leg, so the edge filter matters.</p></div>
      <div class="field"><label for="sEdge">Lowest edge a spin can land on <output id="oEdge">${signedPct(p.min_edge)}</output></label><input id="sEdge" type="range" min="-0.05" max="0.05" step="0.005" value="${p.min_edge}"></div>
      <div class="field"><label for="sMinP">Each leg at least this likely <output id="oMinP">${pct(draft.minP)}</output></label><input id="sMinP" type="range" min="0.6" max="0.95" step="0.01" value="${draft.minP}"></div>
      <div class="field"><label for="sMax">Highest price per leg <output id="oMax">${esc(odds(draft.maxLeg))}</output></label><input id="sMax" type="range" min="1.1" max="1.5" step="0.01" value="${draft.maxLeg}"></div>
      <div class="field"><span class="lbl">Sound</span>${chipRow("snd", [["on", "On"], ["off", "Off"]], p.sound === false ? "off" : "on")}</div>
      <div class="field"><span class="lbl">Vibration</span>${chipRow("vib", [["on", "On"], ["off", "Off"]], p.vibration === false ? "off" : "on")}</div>
      <div class="field"><span class="lbl">Your bookie (the machine loads it first)</span>${chipRow("fav", [["", "Any"]].concat(SLIP_BOOKS.map((b) => [b, esc(bookName(b))])), p.fav_book || "")}</div>
      <div class="field"><span class="lbl">Bookies you have accounts with</span><div class="chips">
        ${SLIP_BOOKS.map((b) => `<button class="chip" data-mybook="${b}" aria-pressed="${draft.myBooks.includes(b)}">${esc(bookName(b))}</button>`).join("")}</div>
        <p class="hint">Sky Bet and William Hill aren't in the odds feed, so they can't be shown.</p></div>
      <div class="field"><label for="sLimit">Monthly limit (£)</label><input id="sLimit" type="number" inputmode="decimal" min="1" step="5" value="${draft.monthlyLimit}"></div>
      <div class="err" id="sErr"></div>
      <div class="sheet-actions"><button class="cbtn plain" id="sCancel">Cancel</button><button class="cbtn yellow" id="sSave">Save settings</button></div>
      <p class="hint" style="margin-top:16px">Odds refresh every morning at about 07:15${DATA?.budget?.remaining_after != null ? `; ${DATA.budget.remaining_after} free requests left this month` : ""}. Scores update about every 10 minutes while matches are on.</p>`;
    const group = (name, apply) => s.querySelectorAll(`[data-${name}]`).forEach((b) => b.addEventListener("click", () => {
      apply(b.dataset[name]);
      s.querySelectorAll(`[data-${name}]`).forEach((x) => x.setAttribute("aria-pressed", x === b));
    }));
    group("fmt", (v) => { p.odds_format = v; });
    group("legs", (v) => { p.legs_per_slip = v === "mix" ? "mix" : +v; });
    group("spot", (v) => { p.sweet_spot = SWEET_SPOTS.find((x) => x.id === v).range.slice(); });
    group("snd", (v) => { p.sound = v === "on"; });
    group("vib", (v) => { p.vibration = v === "on"; });
    group("fav", (v) => { p.fav_book = v || null; });
    s.querySelectorAll("[data-mybook]").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.mybook, set = new Set(draft.myBooks);
      set.has(v) ? set.delete(v) : set.add(v);
      if (!set.size) set.add(v);
      draft.myBooks = [...set];
      s.querySelectorAll("[data-mybook]").forEach((x) => x.setAttribute("aria-pressed", set.has(x.dataset.mybook)));
    }));
    s.querySelector("#sEdge").addEventListener("input", (e) => { p.min_edge = +e.target.value; s.querySelector("#oEdge").textContent = signedPct(p.min_edge); });
    s.querySelector("#sMinP").addEventListener("input", (e) => { draft.minP = +e.target.value; s.querySelector("#oMinP").textContent = pct(draft.minP); });
    s.querySelector("#sMax").addEventListener("input", (e) => { draft.maxLeg = +e.target.value; s.querySelector("#oMax").textContent = odds(draft.maxLeg); });
    s.querySelector("#sCancel").addEventListener("click", closeSheet);
    s.querySelector("#sSave").addEventListener("click", () => {
      const lim = parseFloat(s.querySelector("#sLimit").value);
      if (!(lim > 0)) { s.querySelector("#sErr").textContent = "Enter a monthly limit above £0."; return; }
      draft.monthlyLimit = lim;
      const shapeChanged = p.legs_per_slip !== prefs.legs_per_slip || p.sweet_spot.join() !== prefs.sweet_spot.join() || p.min_edge !== prefs.min_edge;
      const favChanged = p.fav_book && p.fav_book !== prefs.fav_book;
      if (p.fav_book && !draft.myBooks.includes(p.fav_book)) draft.myBooks.push(p.fav_book);
      settings = draft; saveSettings();
      prefs = p; savePrefs(); renderSoundBtn();
      closeSheet();
      if (favChanged && slip && rebuildSlip()) { /* reels now show your bookie */ }
      else if (shapeChanged && slip && windowById(slip.window_id)) {
        slip.legs = slip.legs.filter((l) => l.held);
        if (!spin().ok) { fillTo(4); sortSlip(); saveSlip(); }
      }
      ensureSlip();
      route();
    });
  });
});


// =====================================================================================
// The card table (second room): NFL player props, Texas Hold'em style.
// The board = the best player lines in your deck. Your hole cards = players you star.
// The dealer lays out ready-made hands near evens (Best value / Safest / Fewest cards),
// built around your hole cards. Tap one to put it on the felt; Hit, swap or fold cards.
// No bust: over 13/10 just says fold one. Cards come from the NFL player engine.
// =====================================================================================
let table = Object.assign({ book: null, games: [], hand: [], hole: [], folded: [], slot: null, open: null, active: null, copied: false }, store.get("table", {}));
delete table.stood;
const saveTable = () => store.set("table", table);
const T_MAX = 2.6, T_CONF = { "sharp+model": 1, "market+model": 0.8, model: 0.55 };
const STAT_NAME = { rec_yds: "receiving", rush_yds: "rushing", pass_yds: "passing" };
// Team colours for the deck badges (codes in team colours; no logos).
const NFL_COL = { ARI: ["#97233F", "#FFB612"], ATL: ["#A71930", "#000"], BAL: ["#241773", "#9E7C0C"], BUF: ["#00338D", "#C60C30"], CAR: ["#0085CA", "#101820"],
  CHI: ["#0B162A", "#C83803"], CIN: ["#FB4F14", "#000"], CLE: ["#311D00", "#FF3C00"], DAL: ["#003594", "#869397"], DEN: ["#FB4F14", "#002244"],
  DET: ["#0076B6", "#B0B7BC"], GB: ["#203731", "#FFB612"], HOU: ["#03202F", "#A71930"], IND: ["#002C5F", "#A2AAAD"], JAX: ["#006778", "#D7A22A"],
  KC: ["#E31837", "#FFB81C"], LV: ["#000", "#A5ACAF"], LAC: ["#0080C6", "#FFC20E"], LAR: ["#003594", "#FFA300"], LA: ["#003594", "#FFA300"],
  MIA: ["#008E97", "#FC4C02"], MIN: ["#4F2683", "#FFC62F"], NE: ["#002244", "#C60C30"], NO: ["#101820", "#D3BC8D"], NYG: ["#0B2265", "#A71930"],
  NYJ: ["#125740", "#FFF"], PHI: ["#004C54", "#A5ACAF"], PIT: ["#101820", "#FFB612"], SF: ["#AA0000", "#B3995D"], SEA: ["#002244", "#69BE28"],
  TB: ["#D50A0A", "#34302B"], TEN: ["#0C2340", "#4B92DB"], WAS: ["#5A1414", "#FFB612"] };
const badge = (c) => { const [a, b] = NFL_COL[c] || ["#333", "#999"]; return `<span class="tbadge" style="--a:${a};--b:${b}">${esc(c)}</span>`; };

const propLegs = () => (DATA?.legs || []).filter((l) => l.key.startsWith("nfl-prop") && FIX[l.fixture_id] && Date.parse(FIX[l.fixture_id].kickoff) > Date.now());
function projFor(leg) {
  const [, stat] = leg.key.split(":");
  return (PROJ?.nfl || []).find((p) => p.fixture_id === leg.fixture_id && p.player === leg.player && p.stat === stat);
}
function tableBooks() {
  const n = {};
  propLegs().forEach((l) => Object.keys(l.prices).forEach((b) => { if (myBooks().includes(b)) n[b] = (n[b] || 0) + 1; }));
  return Object.keys(n).sort((a, b) => (b === prefs.fav_book) - (a === prefs.fav_book) || n[b] - n[a]).map((b) => ({ b, n: n[b] }));
}
function card(leg, book = table.book) {
  const price = leg?.prices?.[book];
  if (!price) return null;
  const [, stat, , line, side] = leg.key.split(":");
  const pr = projFor(leg);
  const c = { id: leg.id, fid: leg.fixture_id, leg, book, price, p: leg.p_win, edge: price * leg.p_win - 1, stat, line: +line, side,
    player: leg.player, team: pr?.team || "", expected: pr?.expected, range: pr?.range, why: leg.why || pr?.why || "",
    statLine: leg.label.slice(leg.player.length + 1), conf: T_CONF[leg.source] || 0.5 };
  c.score = Math.exp(25 * c.edge) * c.conf * bandFit(c.price);
  return c;
}
const inDeck = (fid) => !(table.games || []).length || table.games.includes(fid);
const usable = (c) => c && c.price >= 1.03 && c.price <= 1.6 && c.p >= 0.55;
// Every usable card in the deck at one bookie, grouped by match, best first. fids limits it to some matches.
function deckCards(book = table.book, fids = null) {
  const by = {};
  propLegs().forEach((l) => {
    if (!inDeck(l.fixture_id) || (fids && !fids.has(l.fixture_id))) return;
    const c = card(l, book); if (usable(c)) (by[c.fid] ||= []).push(c);
  });
  Object.values(by).forEach((a) => a.sort((x, y) => y.score - x.score));
  return by;
}
const handCards = () => table.hand.map((id) => LEGS[id] && card(LEGS[id])).filter(Boolean);
function comboNums(cs) {
  let o = 1, h = 1;
  cs.forEach((c) => { o *= c.price; h *= c.p; });
  return { cards: cs, odds: cs.length ? o : 1, chance: cs.length ? h : 0, ev: cs.length ? o * h - 1 : 0, conf: cs.reduce((m, c) => m + c.conf, 0) / (cs.length || 1) };
}
const tState = (o, n) => (!n ? "empty" : o > ZONE[1] ? "over" : o >= ZONE[0] ? "evens" : "short");

// ---------- kick-off slots (round 4): games within 30 minutes of the one before share a slot ----------
function tableSlots() {
  const games = [...new Set(propLegs().map((l) => l.fixture_id))].filter(inDeck).map((id) => FIX[id]).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const slots = [];
  games.forEach((f) => {
    const last = slots[slots.length - 1];
    if (last && Date.parse(f.kickoff) - Date.parse(last.games[last.games.length - 1].kickoff) <= 30 * 60e3) last.games.push(f);
    else slots.push({ key: f.kickoff, games: [f] });
  });
  let dealtN = 0;
  slots.forEach((s) => {
    const a = s.games[0].kickoff, z = s.games[s.games.length - 1].kickoff;
    const t = fmtTime(a, false) + (fmtTime(z, false) !== fmtTime(a, false) ? `–${fmtTime(z, false)}` : "");
    s.fids = new Set(s.games.map((g) => g.id));
    s.when = `${dayOffset(a) === 0 ? "" : `${dayWord(a)} `}${t}`;
    s.dealable = s.games.length >= 2;
    s.title = s.dealable ? ["Early doors", "Late games", "Night games"][Math.min(dealtN++, 2)] : "";
    s.sub = `${s.when} · ${plural(s.games.length, "game")}`;
  });
  return slots;
}
const slotOf = (fid) => tableSlots().find((s) => s.fids.has(fid));
const slotName = (s) => (s ? s.title.toLowerCase() : "deck");

// The dealer: every 2–5 card combination near evens (one card per match) in one slot at one bookie,
// around any ☆ "always include" players in that slot.
function searchHands(book, fids) {
  const by = deckCards(book, fids);
  const hole = table.hole.map((id) => LEGS[id]).filter((l) => l && fids.has(l.fixture_id)).map((l) => card(l, book));
  if (hole.some((c) => !c)) return [];
  const seen = new Set(), holeCs = hole.filter((c) => !seen.has(c.fid) && seen.add(c.fid));
  const holeFx = new Set(holeCs.map((c) => c.fid));
  const base = comboNums(holeCs).odds;
  if (base > ZONE[1]) return [];
  const fxs = Object.keys(by).filter((f) => !holeFx.has(f)).sort((a, b) => by[b][0].score - by[a][0].score).slice(0, 12);
  const found = [];
  let nodes = 0;
  const dfs = (i, picks, odds) => {
    if (++nodes > 60000) return;
    const n = picks.length + holeCs.length;
    if (n >= 2 && odds >= ZONE[0] && odds <= ZONE[1]) found.push(picks.slice());
    if (n >= 5) return;
    for (let j = i; j < fxs.length; j++) for (const c of by[fxs[j]].slice(0, 4)) {
      const o = odds * c.price;
      if (o > ZONE[1]) continue;
      picks.push(c); dfs(j + 1, picks, o); picks.pop();
    }
  };
  dfs(0, [], base);
  return found.map((p) => Object.assign(comboNums(holeCs.concat(p)), { book }));
}
function dealerRows() {
  const slots = tableSlots();
  const books = tableBooks().map((x) => x.b);
  const rows = [], skipped = [];
  const make = (s) => {
    const all = [], perBook = {};
    books.forEach((b) => { const hs = searchHands(b, s.fids); all.push(...hs); if (hs.length) perBook[b] = Math.max(...hs.map((h) => h.ev)); });
    if (!all.length) return null;
    const key = (h) => `${h.book}|${h.cards.map((c) => c.id).sort().join("|")}`;
    const taken = new Set(), hands = [];
    const pick = (sorter) => all.slice().sort(sorter).find((h) => !taken.has(key(h)));
    const add = (name, tag, h) => { if (h) { taken.add(key(h)); hands.push(Object.assign({ name, tag }, h)); } };
    add("Best value", "The biggest edge for the real chance", pick((a, b) => (b.ev + 0.02 * b.conf) - (a.ev + 0.02 * a.conf)));
    add("Safest", "The best chance of landing", pick((a, b) => b.chance - a.chance));
    const few = pick((a, b) => a.cards.length - b.cards.length || b.ev - a.ev);
    if (few && few.cards.length < Math.min(...hands.map((h) => h.cards.length))) add("Fewest cards", "Fewest players to sweat on", few);
    return Object.assign({}, s, { hands, perBook });
  };
  slots.forEach((s) => { if (!s.dealable) { skipped.push(s); return; } const r = make(s); if (r) rows.push(r); });
  // No slot has two games (a Thursday, say): deal across the whole deck instead.
  if (!rows.length && slots.length > 1) {
    const all = { key: "all", games: slots.flatMap((s) => s.games), title: "Across the day", dealable: true };
    all.fids = new Set(all.games.map((g) => g.id));
    all.sub = `mixed kick-offs · ${plural(all.games.length, "game")}`;
    const r = make(all); if (r) { rows.push(r); skipped.length = 0; }
  }
  return { rows, skipped };
}

function ensureTableBook() {
  const books = tableBooks().map((x) => x.b);
  if (!books.includes(table.book)) table.book = books.includes(prefs.fav_book) ? prefs.fav_book : books[0] || null;
  const ok = (id) => LEGS[id] && card(LEGS[id]) && Date.parse(FIX[LEGS[id].fixture_id]?.kickoff) > Date.now();
  table.hand = table.hand.filter(ok);
  table.hole = table.hole.filter((id) => LEGS[id] && Date.parse(FIX[LEGS[id].fixture_id]?.kickoff) > Date.now());
  table.folded ||= [];
}
let dealt = null; // the dealer's rows as last shown (so tapping a hand uses exactly what you saw)
let sayMsg = null; // what the dealer just said about your last move (until the next one)

// The why-line, split into labelled rows (round 4).
function whyRows(why) {
  const segs = String(why || "").split(" · ").filter(Boolean);
  const rows = [];
  const share = segs.find((s) => /% of (targets|carries|attempts)/.test(s));
  const vol = segs.find((s) => s.startsWith("~") || /per attempt/.test(s));
  if (share || vol) rows.push(["Role", [share, vol && vol.replace(/^~/, "about ")].filter(Boolean).join(" · ")]);
  segs.forEach((s) => {
    const m = s.match(/^([A-Z]{2,3}) allow (\d+)% (more|less) than average/);
    if (m) rows.push(["Defence", +m[2] <= 2 ? `${m[1]} about average` : `${m[1]} give up ${m[2]}% ${m[3]} than average`]);
  });
  segs.forEach((s) => { const m = s.match(/^(hot|cold) (last .*)$/); if (m) rows.push(["Form", `${m[1] === "hot" ? "Hot" : "Cold"}, ${m[2]}`]); });
  segs.forEach((s) => { if (s === "home" || s === "away") rows.push(["Venue", s === "home" ? "Home" : "Away"]); });
  const news = segs.filter((s) => /questionable|first game back|doubtful/i.test(s));
  if (news.length) rows.push(["News", news.map((s) => s[0].toUpperCase() + s.slice(1)).join("; "), true]);
  const known = new Set([share, vol, ...news]);
  segs.forEach((s) => { if (!known.has(s) && !/ allow |^(hot|cold) |^(home|away)$/.test(s)) rows.push(["Note", s]); });
  return rows;
}
const whyHTML = (why) => `<dl class="why">${whyRows(why).map(([k, v, warn]) => `<dt>${esc(k)}</dt><dd${warn ? ' class="warn"' : ""}>${warn ? '<b aria-hidden="true">!</b> ' : ""}${esc(v)}</dd>`).join("")}</dl>`;

function renderTable(opts = {}) {
  ensureTableBook();
  startLamp();
  const games = [...new Set(propLegs().map((l) => l.fixture_id))].map((id) => FIX[id]).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const nDeck = (table.games || []).filter((g) => games.some((f) => f.id === g)).length;
  $("#tDeckLabel").textContent = !games.length ? "No games" : nDeck ? `Deck: ${plural(nDeck, "game")}` : `Deck: all ${games.length} games`;
  const bp = $("#tBook");
  bp.hidden = !table.book;
  bp.innerHTML = table.book ? `${prefs.fav_book === table.book ? '<span class="star" aria-hidden="true">★</span>' : ""}${esc(bookName(table.book))}` : "";
  const first = games[0]?.kickoff;
  $("#tSub").textContent = games.length ? `${dayOffset(first) === 0 ? "Today" : dayLong(first)} · ${plural(games.length, "game")} · ${plural(tableBooks().length, "bookie")} checked` : "";

  // The dealer's hands, one row per kick-off slot.
  dealt = games.length ? dealerRows() : { rows: [], skipped: [] };
  $("#tBubble").innerHTML = bubbleHTML();
  $("#tHands").innerHTML = dealt.rows.map((r, ri) => `<div class="slot-row">
      <div class="slot-head"><b>${esc(r.title)}</b><span class="num">${esc(r.sub)}</span></div>
      <div class="hands" role="list" aria-label="${esc(`${r.title}, ${r.sub}`)}">${r.hands.map((h, i) => {
        const on = table.active === `${r.key}|${h.name}`;
        return `<button class="dhand${on ? " on" : ""}" role="listitem" data-r="${ri}" data-h="${i}" aria-pressed="${on}">
          <span class="dh-top"><span class="dh-name">${esc(h.name)}</span><span class="dh-book">${esc(bookName(h.book))}</span></span>
          <span class="dh-tag">${esc(h.tag)}</span>
          <span class="dh-cards">${h.cards.map((c) => `<span class="mini">${esc(`${c.player[0]}. ${(c.player.split(" ").slice(1).join(" ") || c.player).slice(0, 10)}`)}<b>${esc(c.side === "over" ? `${Math.round(c.line + 0.5)}+` : `u${c.line}`)}</b><i>${esc(c.stat === "pass_yds" ? "pass" : c.stat === "rush_yds" ? "rush" : "rec")}</i></span>`).join("")}</span>
          <span class="dh-nums num"><span><small>pays</small><b>${oddsH(h.odds)}</b></span><span><small>lands</small>${pct(h.chance)}</span><span><small>edge</small>${edgeTag(h.ev)}</span></span>
          <span class="dh-go">${on ? "On the felt ✓" : "Lay it down ›"}</span>
        </button>`;
      }).join("")}</div></div>`).join("")
    + (dealt.skipped.length ? `<p class="slot-skip">Not dealt: the ${esc(listWords(dealt.skipped.map((s) => s.when.replace(/^(Today|Tomorrow) /, (m) => m.toLowerCase()))))} ${dealt.skipped.length === 1 ? "game. That's one game" : "games. They're one game each"}, and a hand needs cards from different games.</p>` : "")
    + (!dealt.rows.length && games.length ? `<p class="slot-skip">Nothing near evens in this deck. Widen the deck, or unstar a player.</p>` : "");
  $("#tHands").querySelectorAll(".dhand").forEach((b) => b.addEventListener("click", () => layHand(dealt.rows[+b.dataset.r], dealt.rows[+b.dataset.r].hands[+b.dataset.h])));

  // The board: best cards in the deck at the hand's bookie (one per player and stat), ☆ = always include.
  const by = deckCards();
  const seen = new Set();
  const board = Object.values(by).flat().sort((a, b) => b.score - a.score)
    .filter((c) => { const k = `${c.player}|${c.stat}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 12);
  const inHand = new Set(table.hand), hole = new Set(table.hole);
  $("#tBoardN").textContent = `${board.length} cards${table.hole.length ? ` · ${table.hole.length} always in` : ""}`;
  $("#tBoard").innerHTML = board.length ? board.map((c) => `<div class="bcard${hole.has(c.id) ? " hole" : ""}${inHand.has(c.id) ? " used" : ""}" role="listitem" data-id="${esc(c.id)}">
      <button class="b-star" data-star="${esc(c.id)}" aria-pressed="${hole.has(c.id)}" aria-label="Always include ${esc(c.player)}">${hole.has(c.id) ? "★" : "☆"}</button>
      <span class="b-name">${esc(c.player.split(" ").slice(1).join(" ") || c.player)} <small>${esc(c.team)}</small></span>
      <span class="b-stat">${esc(c.statLine.replace("receiving", "rec").replace("rushing", "rush").replace("passing", "pass"))}</span>
      <span class="b-px num">${oddsH(c.price)}</span><span class="b-edge num">${pct(c.p)} · ${edgeTag(c.edge)}</span>
    </div>`).join("") : `<div class="t-empty">No cards in this deck.</div>`;
  $("#tBoard").querySelectorAll(".bcard").forEach((el) => el.addEventListener("click", (e) => {
    const id = el.dataset.id;
    if (e.target.closest("[data-star]")) {
      table.hole = hole.has(id) ? table.hole.filter((x) => x !== id) : table.hole.filter((x) => LEGS[x]?.fixture_id !== LEGS[id].fixture_id).concat(id);
      saveTable(); Sound.hold(); buzz(10); renderTable(); return;
    }
    placeCard(id);
  }));

  // Your hand.
  const nums = comboNums(handCards());
  const st = tState(nums.odds, nums.cards.length);
  const slot = table.slot && dealt.rows.find((r) => r.key === table.slot);
  $("#tHandSub").textContent = nums.cards.length ? `${bookName(table.book)}${slot ? ` · ${slot.title.toLowerCase()}` : ""}` : "";
  $("#tHand").innerHTML = nums.cards.length ? nums.cards.map((c, i) => cardHTML(c, i)).join("")
    : `<div class="t-empty">Tap one of the dealer's hands to lay it on the felt.</div>`;
  $("#tHand").querySelectorAll(".pcard").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".c-main").addEventListener("click", () => { table.open = table.open === id ? null : id; saveTable(); renderTable(); });
    el.querySelector(".c-fold").addEventListener("click", () => foldCard(id));
  });
  if (!reducedMotion()) {
    const els = [...$("#tHand").querySelectorAll(".pcard")];
    const dealtIds = opts.dealAll ? els : els.filter((el) => (opts.dealt || []).includes(el.dataset.id));
    dealtIds.forEach((el, k) => { el.style.animationDelay = `${k * 0.12}s`; el.classList.add("deal-in"); });
  }
  // Meter: Short / Evens / Over, words and a symbol, never colour alone.
  const pos = (o) => `${Math.max(0, Math.min(100, ((o - 1) / (T_MAX - 1)) * 100))}%`;
  $("#tMark").hidden = !nums.cards.length;
  $("#tMark").style.left = pos(nums.odds);
  $("#tMark").className = `t-mark ${st}`;
  $("#tScale").innerHTML = `<span>Short</span><span class="z">Evens ${esc(prefs.odds_format === "decimal" ? "1.90–2.30" : "9/10–13/10")}</span><span>Over</span>`;
  $("#tOdds").innerHTML = nums.cards.length ? oddsH(nums.odds) : "";
  $("#tStatus").textContent = { empty: "", short: "Short · hit for a card", evens: "✓ Evens", over: "Over · fold one" }[st];
  $("#tStatus").className = st;
  $("#tFacts").innerHTML = nums.cards.length ? `real chance ${pct(nums.chance)} · edge ${edgeTag(nums.ev)} · £10 pays £${(10 * nums.odds).toFixed(2)}` : "";
  // Actions.
  const a = $("#tActions");
  const hitOk = st !== "evens" && st !== "over" && !!nextCard(false);
  a.innerHTML = `<button class="cbtn yellow" id="tHit"${hitOk ? "" : " disabled"}>Hit</button>`
    + (nums.cards.length ? `<button class="cbtn plain" id="tCopy">${table.copied ? "Copied ✓" : `Copy to ${esc(bookName(table.book))}`}</button>` : "")
    + (table.copied ? `<button class="cbtn green" id="tPlaced">Placed it</button>` : "")
    + (nums.cards.length ? `<button class="cbtn red" id="tClear" aria-label="Clear the hand">Clear</button>` : "");
  $("#tHit").addEventListener("click", tableHit);
  $("#tCopy")?.addEventListener("click", async () => { await copyText(tableText()); table.copied = true; saveTable(); buzz(10); renderTable(); });
  $("#tPlaced")?.addEventListener("click", () => openPlaceSheet(tableAsBet(), { onSaved: () => { resetHand(); Sound.placed(); location.hash = "#winnings"; } }));
  $("#tClear")?.addEventListener("click", () => { resetHand(); sayMsg = null; Sound.lever(); renderTable(); });
  renderPlayers();
}
function resetHand() { table.hand = []; table.active = null; table.slot = null; table.folded = []; table.open = null; table.copied = false; saveTable(); }
const listWords = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// ---------- what the dealer says (round 4): four tips that explain the game, then what just happened ----------
let tipAt = -1;
function tips() {
  const out = [
    "Here's the game. I deal hands of two to five player bets that together pay about evens. Every card has to land for the hand to pay.",
    "Lay a hand on the felt, then fold any card you don't trust. I'll deal the best replacement from the same kick-off.",
  ];
  // The bookie comparison, from the first slot dealt.
  const r = dealt?.rows?.[0];
  if (r && Object.keys(r.perBook).length > 1) {
    const ranked = Object.entries(r.perBook).sort((a, b) => b[1] - a[1]);
    const [best, bestEv] = ranked[0];
    const fav = prefs.fav_book && r.perBook[prefs.fav_book] != null ? prefs.fav_book : null;
    const where = `the ${r.when} games`;
    if (fav && fav !== best) out.push(`I check every bookie. For ${where} ${bookName(fav)}'s best hand is ${signedPct(r.perBook[fav])} and ${bookName(best)}'s is ${signedPct(bestEv)}, so I'm dealing from ${bookName(best)}.`);
    else if (fav) out.push(`I check every bookie. ${bookName(fav)} has the best prices for ${where} today: ${signedPct(bestEv)}.`);
    else { const [worst, worstEv] = ranked[ranked.length - 1]; out.push(`I check every bookie. For ${where} ${bookName(best)}'s best hand is ${signedPct(bestEv)} and ${bookName(worst)}'s is ${signedPct(worstEv)}.`); }
  }
  const settled = DATA?.track?.settled ?? 0;
  out.push(`Edge is the price against our fair price. It's an estimate${settled < 50 ? `, and our record is only ${plural(settled, "bet")} old, so keep stakes small` : ""}.`);
  return out;
}
function stateLine() {
  if (sayMsg) return sayMsg;
  if (!dealt.rows.length) return dealt.skipped.length ? "Each kick-off has only one game today, so I can't make a hand. A hand needs cards from different games." : "No NFL player prices yet. They come with the morning odds.";
  const n = comboNums(handCards()), st = tState(n.odds, n.cards.length);
  if (st === "empty") return `I've dealt hands for ${listWords(dealt.rows.map((r) => r.title.toLowerCase()))}. Tap one to lay it on the felt. Tap me to learn the game.`;
  if (st === "short") return "You're short of evens. Hit and I'll deal a card.";
  if (st === "over") return "That's over evens. Fold a card and I'll find a shorter one.";
  return n.ev >= 0 ? "That's evens, and the price beats our fair price. Copy it to the bookie when you're ready." : "That's evens, but the price is below our fair price. Fold the weakest card and I'll find better.";
}
function bubbleHTML() {
  if (tipAt < 0) return `<span>${esc(stateLine())}</span><span class="b-hint">Tap for tips ›</span>`;
  const t = tips();
  tipAt = Math.min(tipAt, t.length - 1);
  return `<span>${esc(t[tipAt])}</span><span class="b-dots" aria-hidden="true">${t.map((_, i) => `<i${i === tipAt ? ' class="on"' : ""}></i>`).join("")}</span><span class="b-hint">${tipAt < t.length - 1 ? "Tap for more ›" : "Tap to finish"}</span>`;
}
function nextTip() {
  const n = tips().length;
  tipAt = tipAt < 0 ? 0 : tipAt + 1 >= n ? -1 : tipAt + 1;
  if (tipAt === 0) sayMsg = null;
  Sound.hold();
  const b = $("#tBubble"); b.innerHTML = bubbleHTML(); b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
}
$("#dealer").addEventListener("click", nextTip);
$("#tBubble").addEventListener("click", nextTip);
$("#tBubble").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nextTip(); } });

function cardHTML(c, i) {
  const fx = FIX[c.fid];
  const open = table.open === c.id;
  const mine = table.hole.includes(c.id);
  return `<div class="pcard${open ? " open" : ""}${mine ? " hole" : ""}" data-id="${esc(c.id)}" style="--i:${i}">
    <div class="c-row">
      <button class="c-main" aria-expanded="${open}" aria-label="${esc(`${c.player} ${c.statLine}, ${odds(c.price)}. ${open ? "Hide" : "Show"} why`)}">
        <span class="c-name">${mine ? '<span class="c-mine" aria-label="always included">★</span> ' : ""}${esc(c.player)} <small>${esc(c.team)}</small></span>
        <span class="c-stat">${esc(c.statLine)}</span>
        <span class="c-fx num">${esc(code(fx, "away"))} @ ${esc(code(fx, "home"))} · ${esc(dayOffset(fx.kickoff) === 0 ? "" : `${dayShort(fx.kickoff)} `)}${esc(fmtTime(fx.kickoff, false))}</span>
      </button>
      <div class="c-side"><b class="c-px num">${oddsH(c.price)}</b><button class="c-fold" aria-label="Fold ${esc(c.player)}">Fold</button></div>
    </div>
    <div class="c-more">
      <div class="c-tiles num">
        <span><small>We expect</small><b>${c.expected != null ? `${Math.round(c.expected)} yds` : "–"}</b>${c.range?.[0] != null ? `<i>range ${c.range[0]}–${c.range[1]}</i>` : ""}</span>
        <span><small>Real chance</small><b>${pct(c.p)}</b></span>
        <span><small>Edge</small><b>${edgeTag(c.edge)}</b></span>
      </div>
      ${whyHTML(c.why)}
      <p class="c-src">${c.leg.source === "sharp+model" ? "Fair price anchored to Pinnacle." : c.leg.source === "model" ? "Our model only: no bookie line to anchor it, so trust the edge less." : "No Pinnacle price: fair price from UK bookies and our model, so trust the edge less."}</p>
    </div>
  </div>`;
}
function layHand(r, h) {
  tipAt = -1;
  table.book = h.book; table.hand = h.cards.map((c) => c.id); table.active = `${r.key}|${h.name}`; table.slot = r.key;
  table.folded = []; table.open = null; table.copied = false; saveTable();
  sayMsg = `${h.name} for ${r.title.toLowerCase()} is on the felt: ${plural(h.cards.length, "card")} at ${bookName(h.book)}. Tap a card to see why, or fold it.`;
  dealerDeal(); Sound.unlock(); Sound.stop(); buzz(12);
  renderTable({ dealAll: true });
}
// Put a card in the hand (replacing any card from the same match).
function placeCard(id) {
  tipAt = -1;
  const fid = LEGS[id].fixture_id;
  table.hand = table.hand.filter((x) => LEGS[x]?.fixture_id !== fid).concat(id);
  const s = slotOf(fid);
  if (table.slot && s?.key !== table.slot) table.slot = null;
  table.active = null; table.copied = false; saveTable();
  const c = card(LEGS[id]);
  sayMsg = c ? `Added ${c.player}, ${c.statLine}.` : null;
  dealerDeal(); Sound.unlock(); Sound.stop(); buzz(12);
  renderTable({ dealt: [id] });
  $("#tHand").scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
}
// The dealer's next card: same bookie, same kick-off slot as the hand, a match not already in it,
// no folded player, keeping you at or under 13/10. Prefers one that lands you in the evens zone.
function nextCard(random = false) {
  const hand = handCards();
  const used = new Set(hand.map((c) => c.fid));
  const o = comboNums(hand).odds;
  const slot = table.slot && tableSlots().find((s) => s.key === table.slot);
  const folded = new Set(table.folded || []);
  const cands = Object.values(deckCards(table.book, slot ? slot.fids : null)).flat()
    .filter((c) => !used.has(c.fid) && !folded.has(c.player) && o * c.price <= ZONE[1]);
  if (!cands.length) return null;
  const zone = cands.filter((c) => o * c.price >= ZONE[0]);
  const pool = (zone.length ? zone : cands).sort((a, b) => b.score - a.score);
  return random ? pool[Math.floor(Math.random() * Math.min(pool.length, 3))] : pool[0];
}
function foldCard(id) {
  tipAt = -1;
  const out = card(LEGS[id]);
  table.hand = table.hand.filter((x) => x !== id);
  table.folded = [...new Set([...(table.folded || []), out?.player].filter(Boolean))];
  table.active = null; table.open = null; table.copied = false;
  const next = table.hand.length ? nextCard(false) : null;
  if (next) {
    table.hand.push(next.id);
    const n = comboNums(handCards());
    sayMsg = `Folded ${out.player}. Dealt ${next.player}, ${next.statLine}, from ${code(FIX[next.fid], "away")} @ ${code(FIX[next.fid], "home")}. Edge is now ${signedPct(n.ev)}.`;
    dealerDeal(); Sound.stop(); buzz(12);
  } else {
    sayMsg = table.hand.length ? `Folded ${out.player}. Nothing else in this kick-off keeps you under 13/10, so you're short.` : `Folded ${out.player}. Lay another hand down when you're ready.`;
    Sound.nudge(); buzz(10);
  }
  saveTable();
  renderTable({ dealt: next ? [next.id] : [] });
}
function tableHit() {
  tipAt = -1;
  const c = nextCard(true);
  if (!c) return;
  table.hand.push(c.id); table.active = null; table.copied = false; saveTable();
  sayMsg = `Dealt ${c.player}, ${c.statLine}, from ${code(FIX[c.fid], "away")} @ ${code(FIX[c.fid], "home")}.`;
  dealerDeal(); Sound.unlock(); Sound.stop(); buzz(12);
  renderTable({ dealt: [c.id] });
  if (tState(comboNums(handCards()).odds, 1) === "evens") Sound.nudge();
}
function flashTable(t) { sayMsg = t; tipAt = -1; const b = $("#tBubble"); b.innerHTML = bubbleHTML(); b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); }
function tableText() {
  const n = comboNums(handCards());
  return `${bookName(table.book)} · NFL ${n.cards.length}-fold\n\n` + n.cards.map((c) => {
    const fx = FIX[c.fid];
    return `${dayWord(fx.kickoff)} ${fmtTime(fx.kickoff, false)} · ${fx.away} @ ${fx.home}\n${c.player} ${c.statLine}  ${odds(c.price)}`;
  }).join("\n\n") + `\n\nCombined ${odds(n.odds)} · real chance ${pct(n.chance)} · £10 pays £${(10 * n.odds).toFixed(2)}`;
}
function tableAsBet() {
  const n = comboNums(handCards());
  const first = n.cards.map((c) => FIX[c.fid].kickoff).sort()[0];
  return { book: table.book, label: `Card table · NFL · ${dayWord(first)} ${fmtTime(first, false)}`, start: first, odds: n.odds,
    hit_p: n.chance, ev: n.ev, stake: 10, legIds: n.cards.map((c) => c.id),
    legs: n.cards.map((c) => ({ label: `${c.player} ${c.statLine}`, match: `${FIX[c.fid].away} @ ${FIX[c.fid].home}`, kickoff: FIX[c.fid].kickoff, price: c.price, p_win: c.p })) };
}
// Who's going to do what: projections per game in the deck, every line tappable.
function renderPlayers() {
  const games = [...new Set((PROJ?.nfl || []).map((p) => p.fixture_id))].filter((id) => FIX[id] && Date.parse(FIX[id].kickoff) > Date.now() && inDeck(id))
    .map((id) => FIX[id]).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  $("#tPlayersHint").textContent = `Our expected yards, with the 10–90% range and why. Tap a price to put that card in your hand${table.book ? ` (${bookName(table.book)} prices)` : ""}. Fair chances lean on Pinnacle where it prices the player.`;
  const byPlayer = {};
  propLegs().forEach((l) => { const c = card(l); if (c) (byPlayer[`${l.fixture_id}|${l.player}|${c.stat}`] ||= []).push(c); });
  const inHand = new Set(table.hand);
  $("#tPlayers").innerHTML = games.map((f, gi) => {
    const rows = (PROJ.nfl || []).filter((p) => p.fixture_id === f.id && p.source !== "skip" && p.expected >= 15)
      .sort((a, b) => a.stat.localeCompare(b.stat) || b.expected - a.expected);
    return `<details class="pgame"${gi === 0 ? " open" : ""}><summary><span class="pg-teams">${badge(code(f, "away"))}<b>${esc(f.away)} @ ${esc(f.home)}</b>${badge(code(f, "home"))}</span><span>${esc(dayWord(f.kickoff))} ${esc(fmtTime(f.kickoff, false))}</span></summary>
      ${["pass_yds", "rec_yds", "rush_yds"].map((st) => {
        const rs = rows.filter((r) => r.stat === st);
        if (!rs.length) return "";
        return `<div class="pstat">${esc(STAT_NAME[st])} yards</div>` + rs.map((r) => {
          const cs = (byPlayer[`${f.id}|${r.player}|${st}`] || []).sort((a, b) => a.line - b.line || a.side.localeCompare(b.side));
          return `<div class="prow"><div class="p-who"><b>${esc(r.player)}</b> <small>${esc(r.team)}</small><span class="p-exp num">${Math.round(r.expected)} <small>(${r.range?.[0] ?? "–"}–${r.range?.[1] ?? "–"})</small></span></div>
            ${whyHTML(r.why)}${r.source === "model" ? `<div class="p-why">Our model only</div>` : ""}
            ${cs.length ? `<div class="p-lines">${cs.map((c) => `<button class="pline${c.edge >= 0 ? " pos" : ""}${inHand.has(c.id) ? " in" : ""}" data-id="${esc(c.id)}"><span>${esc(c.side === "over" ? `${Math.round(c.line + 0.5)}+` : `u${c.line}`)}</span><b class="num">${oddsH(c.price)}</b><small class="num">${pct(c.p)} · ${c.edge >= 0 ? "+" : "−"}${Math.abs(c.edge * 100).toFixed(1)}%</small></button>`).join("")}</div>` : ""}
          </div>`;
        }).join("");
      }).join("")}</details>`;
  }).join("") || `<div class="t-empty">Projections arrive with the morning run.</div>`;
  $("#tPlayers").querySelectorAll(".pline").forEach((b) => b.addEventListener("click", () => placeCard(b.dataset.id)));
}

// ---------- the deck selector: matchups grouped by kick-off, team badges ----------
$("#tDeck").addEventListener("click", () => {
  const games = [...new Set(propLegs().map((l) => l.fixture_id))].map((id) => FIX[id]).sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  let sel = new Set(table.games || []);
  openSheet("", (s) => {
    const draw = () => {
      const slots = {};
      games.forEach((f) => (slots[`${dayWord(f.kickoff)} ${fmtTime(f.kickoff, false)}`] ||= []).push(f));
      s.innerHTML = `<h3 id="sheetTitle">Pick your deck</h3>
        <p class="hint">Tap games to deal from. Tap a kick-off to take the whole slot. None picked = every game.</p>
        <div class="deck-all"><button class="chip" id="dAll" aria-pressed="${!sel.size}">All ${games.length} games</button></div>
        ${Object.entries(slots).map(([slot, fs]) => `<div class="dslot"><button class="dslot-head" data-slot="${esc(slot)}" aria-pressed="${fs.every((f) => sel.has(f.id))}">${esc(slot)} <small>${plural(fs.length, "game")}</small></button>
          <div class="dgrid">${fs.map((f) => `<button class="dgame" data-g="${f.id}" aria-pressed="${sel.has(f.id)}">${badge(code(f, "away"))}<span class="at">@</span>${badge(code(f, "home"))}</button>`).join("")}</div></div>`).join("")}
        <div class="sheet-actions"><button class="cbtn yellow" id="dDone">Deal from this deck</button></div>`;
      s.querySelector("#dAll").addEventListener("click", () => { sel = new Set(); draw(); });
      s.querySelectorAll("[data-g]").forEach((b) => b.addEventListener("click", () => { const g = b.dataset.g; sel.has(g) ? sel.delete(g) : sel.add(g); buzz(8); draw(); }));
      s.querySelectorAll("[data-slot]").forEach((b) => b.addEventListener("click", () => {
        const fs = slots[b.dataset.slot], on = fs.every((f) => sel.has(f.id));
        fs.forEach((f) => (on ? sel.delete(f.id) : sel.add(f.id))); buzz(8); draw();
      }));
      s.querySelector("#dDone").addEventListener("click", () => {
        table.games = [...sel]; table.active = null; saveTable(); closeSheet(); Sound.lever(); dealerDeal(); renderTable();
      });
    };
    draw();
  });
});
// The table's bookie (its own choice; cards re-price, ones it doesn't price drop out).
$("#tBook").addEventListener("click", () => {
  openSheet("", (s) => {
    const draw = () => {
      s.innerHTML = `<h3 id="sheetTitle">Deal from which bookie?</h3>
        <div class="chips">${tableBooks().map(({ b, n }) => `<button class="chip" data-tb="${b}" aria-pressed="${b === table.book}">${b === prefs.fav_book ? "★ " : ""}${esc(bookName(b))} <small>${n}</small></button>`).join("")}</div>
        <p class="hint">The number is how many NFL player lines that bookie prices. Cards it doesn't price drop out of your hand.${BOOKCHECK[table.book] ? ` ${esc(bookName(table.book))}'s prices reach us on a delay: check them in its app before you place.` : ""}</p>
        <div class="sheet-actions"><button class="cbtn yellow" id="tbDone">Done</button></div>`;
      s.querySelectorAll("[data-tb]").forEach((x) => x.addEventListener("click", () => { table.book = x.dataset.tb; table.copied = false; saveTable(); draw(); }));
      s.querySelector("#tbDone").addEventListener("click", () => { closeSheet(); renderTable(); });
    };
    draw();
  });
});

// ---------- the dealer: an original pixel-art croupier (green visor, moustache, bow tie, sleeve garters) ----------
const DEALER_PAL = { o: "#1C1208", v: "#3FA36B", V: "#2B7A4E", L: "#8FE0B0", h: "#4A2C14", s: "#F0C29A", S: "#D9A27A", e: "#FFFFFF", p: "#1C1208",
  m: "#A0522D", w: "#F7F3E8", W: "#D8D2C0", b: "#D23A2A", k: "#2B1D14", K: "#4A3426", g: "#D23A2A", y: "#E0A93B", c: "#FFF8E7", r: "#A3172A" };
const DEALER_IDLE = [
  "........................",
  "........oooooooo........",
  ".......oLLvvvvvvo.......",
  "......ovvvvvvvvvvo......",
  "....ooVVVVVVVVVVVVoo....",
  ".....ohhhhhhhhhhhho.....",
  ".....ohssssssssssho.....",
  ".....ossepssssepsso.....",
  ".....osssssSSsssssso....",
  ".....ossssmmmmsssso.....",
  "......oSssssssssSo......",
  ".......ooSssssSoo.......",
  ".....oowwwbbbbwwwoo.....",
  "....okwwwwbbbbwwwwko....",
  "...okkkwwwwbbwwwwkkko...",
  "..okkkkkwwwwwwwwkkkkko..",
  ".owokkkkkwwwwwwkkkkkowo.",
  ".ogokkkkkkywwykkkkkkogo.",
  ".owokkkkkkkwwkkkkkkkowo.",
  ".osokkkkkkywwykkkkkkoso.",
  "..o.okkkkkkkkkkkkkko.o..",
  "....oKKKKKKKKKKKKKKo....",
  "....oooooooooooooooo....",
  "........................",
];
const DEALER_DEAL = [
  "........................",
  "........oooooooo........",
  ".......oLLvvvvvvo.......",
  "......ovvvvvvvvvvo......",
  "....ooVVVVVVVVVVVVoo....",
  ".....ohhhhhhhhhhhho.....",
  ".....ohssssssssssho.....",
  ".....ossepssssepsso.....",
  ".....osssssSSsssssso....",
  ".....ossssmmmmsssso.....",
  "......oSssssssssSo......",
  ".......ooSssssSoo.......",
  ".....oowwwbbbbwwwoo.....",
  "....okwwwwbbbbwwwwko....",
  "...okkkwwwwbbwwwwkkko.cc",
  "..okkkkkwwwwwwwwkkkkkocr",
  ".owokkkkkwwwwwwkkkkkwwsr",
  ".ogokkkkkkywwykkkkkko...",
  ".owokkkkkkkwwkkkkkkko...",
  ".osokkkkkkywwykkkkkko...",
  "..o.okkkkkkkkkkkkkko.o..",
  "....oKKKKKKKKKKKKKKo....",
  "....oooooooooooooooo....",
  "........................",
];
const sprite = (rows) => `<svg viewBox="0 0 24 24" width="72" height="72" shape-rendering="crispEdges">${rows.map((r, y) => [...r].map((ch, x) => DEALER_PAL[ch] ? `<rect x="${x}" y="${y}" width="1" height="1" fill="${DEALER_PAL[ch]}"/>` : "").join("")).join("")}</svg>`;
const DEALER_SVG = { idle: sprite(DEALER_IDLE), deal: sprite(DEALER_DEAL) };
function dealerDeal() {
  const d = $("#dealer");
  d.innerHTML = DEALER_SVG.deal;
  d.classList.remove("dealing"); void d.offsetWidth; d.classList.add("dealing");
  clearTimeout(dealerDeal.t);
  dealerDeal.t = setTimeout(() => { d.innerHTML = DEALER_SVG.idle; d.classList.remove("dealing"); }, 450);
  lampVel += (Math.random() - 0.5) * 0.6; // a little breeze off the dealer's hand
}

// ---------- the lamp: hangs from the top, sways, swings when you tilt the phone ----------
let lampOn = false, lampAngle = 0, lampVel = 0, lampTarget = 0;
function startLamp() {
  if (!$("#dealer").innerHTML) $("#dealer").innerHTML = DEALER_SVG.idle;
  if (lampOn || reducedMotion()) return;
  lampOn = true;
  window.addEventListener("deviceorientation", (e) => { if (e.gamma != null) lampTarget = Math.max(-24, Math.min(24, -e.gamma * 0.7)); });
  const lamp = $("#lamp");
  let t0 = performance.now();
  const step = (t) => {
    if ($("#table").hidden) { lampOn = false; return; }
    const idle = Math.sin((t - t0) / 1400) * 2.2;           // a gentle sway on its own
    const force = (lampTarget + idle - lampAngle) * 0.012;  // spring towards where gravity pulls it
    lampVel = (lampVel + force) * 0.96;                      // damping
    lampAngle += lampVel;
    lamp.style.setProperty("--swing", `${lampAngle.toFixed(2)}deg`);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- switching rooms: tap Slots | Table, or swipe sideways from the middle ----------
let lastRoom = null;
function roomTransition(page) {
  const rooms = ["home", "table"];
  if (rooms.includes(page) && rooms.includes(lastRoom) && page !== lastRoom && !reducedMotion()) {
    const el = $("#" + page);
    el.classList.remove("enter-left", "enter-right"); void el.offsetWidth;
    el.classList.add(page === "table" ? "enter-right" : "enter-left");
    setTimeout(() => el.classList.remove("enter-left", "enter-right"), 600);
    Sound.hold(); buzz(12);
  }
  document.body.classList.toggle("on-felt", page === "table");
  lastRoom = page;
}
(function roomSwipe() {
  let x0 = null, y0 = null, locked = false;
  ["home", "table"].forEach((id) => {
    const el = $("#" + id);
    el.addEventListener("pointerdown", (e) => {
      // Not from the screen edges (Android's back gesture), not on the lever or reels.
      if (e.clientX < 24 || e.clientX > innerWidth - 24 || e.target.closest(".lever-track, #reels, .game-select, .p-lines, .hands, .board, summary, input")) { x0 = null; return; }
      x0 = e.clientX; y0 = e.clientY; locked = false;
    });
    el.addEventListener("pointermove", (e) => {
      if (x0 == null || locked) return;
      const dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) > 10 && Math.abs(dx) > 1.4 * Math.abs(dy)) locked = true;
    });
    el.addEventListener("pointerup", (e) => {
      if (x0 == null) return;
      const dx = e.clientX - x0;
      if (locked && Math.abs(dx) >= 70) {
        if (id === "home" && dx < 0) location.hash = "#table";
        if (id === "table" && dx > 0) location.hash = "#home";
      }
      x0 = null; locked = false;
    });
  });
})();

// ---------- start ----------
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
load();
