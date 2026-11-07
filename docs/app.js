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
const PREF_DEFAULTS = { odds_format: "fraction", sound: true, vibration: true, min_edge: 0.01, legs_per_slip: "mix", sweet_spot: [1.14, 1.26], comps: [], fav_book: null };
let prefs = Object.assign({}, PREF_DEFAULTS, store.get("prefs", {}));
const savePrefs = () => store.set("prefs", prefs);
let bets = store.get("bets", []);
let slip = store.get("slip", null); // shared by the machine and Build a bet
const saveSettings = () => store.set("settings", settings);
const saveBets = () => store.set("bets", bets);
const saveSlip = () => store.set("slip", slip);

// ---------- data ----------
let DATA = null, HIST = null, LIVE = null, FIX = {}, LEGS = {}, BOOKS = {}, SLIP_BOOKS = [], WINDOWS = [];
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
    [DATA, HIST, LIVE] = await Promise.all([loadJSON("data/latest.json"), loadJSON("data/history.json").catch(() => null),
      loadJSON("data/live.json").catch(() => null)]);
  } catch {
    $("#machineWhere").textContent = "Couldn't load the odds. Check your signal and reopen.";
    return;
  }
  FIX = Object.fromEntries(DATA.fixtures.map((f) => [f.id, f]));
  LEGS = Object.fromEntries(DATA.legs.map((l) => [l.id, l]));
  BOOKS = Object.fromEntries(DATA.books.map((b) => [b.slug, b.name]));
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
  if (p[0] === "ou" && tot > +p[1]) return { st: p[2] === "over" ? "won" : "lost", sc };
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
  { id: "efl", name: "EFL", long: "EFL", ids: [18, 24, 25] },
  { id: "cups", name: "Cups", long: "cup", ids: [19, 21, 347] },
  { id: "scot", name: "Scotland", long: "Scottish", ids: [36, 206, 207, 209] },
  { id: "euro", name: "Euro nights", long: "European", ids: [7, 679, 34480] },
  { id: "abroad", name: "Abroad", long: "overseas league", ids: [35, 8, 23, 34, 37, 238, 38, 52, 185, 44, 54, 53, 182] },
  { id: "other", name: "Others", long: "other", ids: [] },
];
const compOf = (fid) => { const lid = FIX[fid]?.league_id; return (COMPS.find((c) => c.ids.includes(lid)) || COMPS[COMPS.length - 1]).id; };
const inComps = (fid) => !prefs.comps?.length || prefs.comps.includes(compOf(fid));
const legOk = (l) => l.fair_p >= settings.minP && l.price <= settings.maxLeg;

// The pool with your filters applied (used for spins and adding legs).
function pool(windowId, bookie) {
  const p = rawPool(windowId, bookie);
  if (!p) return [];
  return p.fixtures.filter((f) => inComps(f.fixture_id)).map((f) => Object.assign({}, f, {
    legs: f.legs.filter(legOk),
  })).filter((f) => f.legs.length);
}
// Matches with usable legs in the next two days, per competition group (your bookies only).
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
const upcoming = () => WINDOWS.filter((w) => Date.parse(w.start_utc) > Date.now() + 2 * 60 * 1000);
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
  return true;
}

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
  if (held.length >= Math.max(...sizeOptions(), 6)) return { ok: false, why: "Every reel is held. Release one to spin it." };
  const found = combosWithFallback(slip.window_id, slip.bookie, held);
  if (!found.length) return { ok: false, why: "Nothing fits the evens zone with those reels. Release a hold, change the bookie, or loosen Settings." };
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
const PAGES = ["home", "play", "build", "winnings", "payout"];
function route() {
  const page = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
  PAGES.forEach((p) => ($("#" + p).hidden = p !== page));
  if (!DATA) return;
  ({ home: renderMachine, play: renderPlay, build: renderBuild, winnings: renderBets, payout: renderRecord })[page]();
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", route);

// ---------- sound and haptics (round 2, item 5) ----------
// Synthesised with the Web Audio API: no files, works offline. Android plays it
// on the media volume, so the speaker button in the marquee is the mute.
const Sound = (() => {
  let ctx;
  const on = () => prefs.sound !== false;
  const ac = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());
  function tone(freq, start, dur, type = "square", vol = 0.15) {
    try {
      const c = ac(), t = c.currentTime + start;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch { /* no audio on this device */ }
  }
  return {
    unlock() { if (on() && (window.AudioContext || window.webkitAudioContext)) ac().resume?.(); },
    lever() { if (on()) { tone(220, 0, 0.08, "sawtooth"); tone(110, 0.06, 0.14, "sawtooth"); } },
    spin() { if (on()) for (let i = 0; i < 14; i++) tone(600 + (i % 2) * 200, i * 0.06, 0.04, "square", 0.05); },
    stop() { if (on()) tone(1800, 0, 0.03, "square", 0.08); },
    hold() { if (on()) tone(880, 0, 0.06, "triangle", 0.1); },
    nudge() { if (on()) { tone(660, 0, 0.04, "square", 0.08); tone(990, 0.04, 0.05, "square", 0.08); } },
    jackpot() { if (on()) [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, i * 0.11, 0.14, "square", 0.12)); },
    placed() { if (on()) [784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.12, "triangle", 0.12)); },
  };
})();
document.addEventListener("pointerdown", () => Sound.unlock(), { once: true });
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
  $("#mMsg").textContent = "";
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

function reelFace({ fx, leg }) {
  return `<div class="face"><span class="fxl" aria-label="${esc(`${fx.home} v ${fx.away}, ${fmtTime(fx.kickoff_utc, false)}`)}"><span>${esc(code(fx, "home"))} v ${esc(code(fx, "away"))}</span><span>${esc(fmtTime(fx.kickoff_utc, false))}</span></span><span class="lbl" data-short="${esc(shortLabel(fx, leg.label))}"><span class="t">${esc(leg.label)}</span></span><span class="px num">${oddsH(leg.price)}</span></div>`;
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
  if (fallbackNote && !spinning) { $("#mMsg").textContent = fallbackNote; fallbackNote = null; }
  const cand = sweatCandidate();
  const wb = $("#watchBtn");
  wb.hidden = !cand;
  if (cand) { const pr = betProgress(cand); wb.textContent = `▶ Watch your ${cand.bookName} bet live · ${pr.landed} of ${cand.legIds.length} in`; }
  if (!slip) {
    where.textContent = "No kick-offs with prices in the next two days";
    $("#reels").innerHTML = ""; $("#holds").innerHTML = ""; $("#nudges").innerHTML = "";
    $("#mOdds").textContent = "–"; $("#mStats").textContent = "";
    ticket.innerHTML = ""; ticket.hidden = true;
  } else {
    const w = windowById(slip.window_id);
    where.textContent = `${w.label} · ${countdown(w.start_utc)}`;
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
    $("#mStats").innerHTML = fairLine(nums).replace(" · ", "<br>");
    renderTicket(opts.print);
  }
  renderLiveStrip(); renderFooter();
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
  return numbers().legs.map(({ fx, leg }) => ({ time: fmtTime(fx.kickoff_utc, false), match: `${fx.home} v ${fx.away}`, league: fx.league || "", label: leg.label, price: leg.price }));
}
function renderTicket(print) {
  const t = $("#ticket");
  const nums = numbers();
  t.hidden = !nums.legs.length;
  t.innerHTML = `${ticketRows().map((r) => `<div class="tk-row"><span class="tk-fx">${esc(r.time)} · ${esc(r.match)}${r.league ? ` · ${esc(r.league)}` : ""}</span>
      <span class="tk-leg"><span>${esc(r.label)}</span><b class="num">${oddsH(r.price)}</b></span></div>`).join("")}
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
  const rows = ticketRows().map((r) => `${r.time} · ${r.match}${r.league ? ` · ${r.league}` : ""}\n${r.label}  ${odds(r.price)}`);
  return `${bookName(slip.bookie)} · ${nums.legs.length}-fold · ${windowById(slip.window_id).label}\n\n${rows.join("\n\n")}\n\n`
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
  const msg = $("#mMsg");
  msg.textContent = "";
  const res = spin();
  Sound.lever(); buzz(30);
  if ($("#leverKnob") && !document.querySelector(".lever-track.spring")) leverDrop();
  if (!res.ok) {
    msg.textContent = res.why;
    document.querySelectorAll("#reels .reel").forEach((r, i) => { if (!slip.legs[i]?.held) { r.classList.remove("fail"); void r.offsetWidth; r.classList.add("fail"); } });
    return;
  }
  if (res.thin != null) msg.textContent = `Thin pickings — best edge is ${signedPct(res.thin)}`;
  else if (res.same) msg.textContent = "Same again: that's the only slip in the evens zone with those holds. Release a reel or change the bookie.";
  playSpin(res);
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
  if (!nudgesLeft) $("#mMsg").textContent = "Out of nudges. Pull to refill, or edit the slip in Build a bet.";
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
setInterval(() => { if (!$("#home").hidden && slip && !spinning && !$("#cabinet").classList.contains("sweating")) { const w = windowById(slip.window_id); if (w) $("#machineWhere").textContent = `${w.label} · ${countdown(w.start_utc)}`; } }, 30000);

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
  const id = b.dataset.comp, msg = $("#mMsg");
  const name = COMPS.find((c) => c.id === id)?.long;
  if (b.getAttribute("aria-disabled") === "true") {
    msg.textContent = `No ${name} matches have prices in the next two days.`;
    buzz(10);
    return;
  }
  const cur = prefs.comps || [];
  // First tap focuses on one competition; more taps add or remove; All clears.
  const next = id === "all" ? [] : !cur.length ? [id] : cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id);
  prefs.comps = next; savePrefs();
  Sound.unlock(); Sound.hold(); buzz(10);
  msg.textContent = "";
  renderGameSelect();
  if (!slip || $("#cabinet").classList.contains("sweating")) return;
  if (rebuildSlip()) { sortSlip(); saveSlip(); playSpin(); return; }
  const counts = compCounts();
  const n = next.length ? next.reduce((a, c) => a + (counts[c] || 0), 0) : Object.values(counts).reduce((a, b) => a + b, 0);
  msg.textContent = n < 3
    ? `Only ${n} ${n === 1 ? "match has" : "matches have"} prices there in the next two days — not enough for a slip. Tap another to add it.`
    : "Those matches don't kick off close enough together for a slip near evens. Tap another to add it.";
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
  $("#buildWhere").innerHTML = `<span>${esc(bookName(slip.bookie))}</span><small>${esc(w.label)}</small>`;
  const nums = numbers();
  const n = nums.legs.length;
  $("#buildLegs").innerHTML = nums.legs.map(({ fx, leg, held }, i) => {
    const choices = (rawPool(slip.window_id, slip.bookie).fixtures.find((f) => f.fixture_id === fx.fixture_id)?.legs || []).length;
    return `<div class="bleg${held ? " held" : ""}" data-i="${i}">
      <button class="hold-btn" data-act="hold" aria-pressed="${held}" aria-label="Hold this leg">${held ? "Held" : "Hold"}</button>
      <div class="info"><span class="match">${esc(fx.home)} v ${esc(fx.away)} · ${esc(fmtTime(fx.kickoff_utc, false))}</span>
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
  let wid = slip.window_id, bk = slip.bookie;
  const draw = (s) => {
    const w = windowById(wid);
    const fav = prefs.fav_book;
    const books = booksFor(w).slice().sort((a, b) => (b === fav) - (a === fav));
    if (!books.includes(bk)) bk = books[0];
    const favMissing = fav && !books.includes(fav);
    s.innerHTML = `<h3 id="sheetTitle">Which kick-off and bookie?</h3>
      <div class="field"><span class="lbl">Kick-off</span><div class="chips">${upcoming().filter((x) => booksFor(x).length).map((x) => `<button class="chip" data-w="${x.id}" aria-pressed="${x.id === wid}">${esc(x.label)}</button>`).join("")}</div></div>
      <div class="field"><span class="lbl">Bookie</span><div class="chips">${books.map((b) => `<button class="chip" data-b="${b}" aria-pressed="${b === bk}">${b === fav ? "★ " : ""}${esc(bookName(b))} <small>${pool(wid, b).length}</small></button>`).join("")}</div>
        <button class="star-btn" id="wStar" aria-pressed="${fav === bk}">${fav === bk ? `★ ${esc(bookName(bk))} is your bookie` : `☆ Make ${esc(bookName(bk))} my bookie`}</button></div>
      <p class="hint">The number is how many matches that bookie has priced at this kick-off${prefs.comps?.length ? " (in the competitions you picked)" : ""}. Your bookie is the one the machine loads first, whenever it has prices.${favMissing ? ` ${esc(bookName(fav))} hasn't priced this kick-off.` : ""}</p>
      ${pool(wid, bk).length < 3 ? `<div class="notice">${esc(bookName(bk))} has only priced ${pool(wid, bk).length} ${pool(wid, bk).length === 1 ? "match" : "matches"} here, so the reels can't get near evens with it.</div>` : ""}
      <div class="sheet-actions"><button class="cbtn plain" id="wCancel">Cancel</button><button class="cbtn yellow" id="wGo">Load the reels</button></div>`;
    s.querySelectorAll("[data-w]").forEach((b) => b.addEventListener("click", () => { wid = b.dataset.w; draw(s); }));
    s.querySelectorAll("[data-b]").forEach((b) => b.addEventListener("click", () => { bk = b.dataset.b; draw(s); }));
    s.querySelector("#wStar").addEventListener("click", () => {
      prefs.fav_book = prefs.fav_book === bk ? null : bk; savePrefs(); buzz(10); draw(s);
    });
    s.querySelector("#wCancel").addEventListener("click", () => { closeSheet(); route(); });
    s.querySelector("#wGo").addEventListener("click", () => {
      const changed = changeWhere(wid, bk);
      closeSheet(); route();
      if (changed && !$("#home").hidden && !$("#cabinet").classList.contains("sweating")) {
        playSpin();
        const o = numbers().odds;
        if (o < ZONE[0] || o > ZONE[1]) $("#mMsg").textContent = `${bookName(bk)} hasn't priced enough matches here to reach evens. Try another bookie or kick-off.`;
      }
    });
  };
  openSheet("", draw);
}
function changeWhere(wid, bk) {
  if (wid === slip.window_id && bk === slip.bookie) return false;
  const n = Math.max(4, Math.min(slip.legs.length, MAX_LEGS));
  const keep = slip.legs.filter((l) => l.held && findLeg(wid, bk, l.leg_id));
  slip = { window_id: wid, bookie: bk, stake: slip.stake, legs: keep };
  fillTo(n);
  if (slip.legs.length >= MIN_LEGS) spin();
  sortSlip(); copied = false; saveSlip();
  return true;
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

// ---------- start ----------
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
load();
