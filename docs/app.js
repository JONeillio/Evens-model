/* Evens: phone app for near-evens football accumulators.
   Reads data/latest.json + data/history.json (written by the daily GitHub job).
   Your own bets and settings stay on this phone (localStorage), with export/import. */
"use strict";

// ---------- small helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TZ = "Europe/London";
const REPO_ACTIONS = "https://github.com/JONeillio/Evens-model/actions/workflows/refresh.yml";
const pct = (x, d = 0) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const signedPct = (x, d = 1) => (x == null ? "–" : Math.abs(x) < 0.5 / 10 ** (d + 2) ? `${(0).toFixed(d)}%` : `${x > 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(d)}%`);
const poundTick = (t) => `${t < 0 ? "−" : ""}£${Math.abs(Math.round(t))}`;
const money = (x) => (x == null ? "–" : `${x < 0 ? "−" : ""}£${Math.abs(x).toFixed(2)}`);
const signedMoney = (x) => (x == null ? "–" : `${x >= 0 ? "+" : "−"}£${Math.abs(x).toFixed(2)}`);
const fmtTime = (iso, withDay = true) => new Intl.DateTimeFormat("en-GB", withDay
  ? { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ }
  : { hour: "2-digit", minute: "2-digit", timeZone: TZ }).format(new Date(iso));
const dayKey = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(iso));

const FRACS = ["1/100","1/50","1/33","1/25","1/20","1/16","1/14","1/12","1/10","1/9","1/8","2/15","1/7","2/13","1/6","2/11","1/5","2/9","1/4","2/7","3/10","1/3","4/11","2/5","4/9","1/2","8/15","4/7","8/13","4/6","8/11","4/5","5/6","10/11","1/1","21/20","11/10","6/5","5/4","11/8","6/4","13/8","7/4","15/8","2/1","9/4","5/2","11/4","3/1","10/3","7/2","4/1","9/2","5/1","11/2","6/1","13/2","7/1","15/2","8/1","9/1","10/1"]
  .map((f) => { const [a, b] = f.split("/").map(Number); return { f, d: 1 + a / b }; });
function odds(dec) {
  if (dec == null) return "–";
  if (settings.oddsFormat !== "fraction") return dec.toFixed(2);
  let best = FRACS[0];
  for (const x of FRACS) if (Math.abs(x.d - dec) < Math.abs(best.d - dec)) best = x;
  return best.f === "1/1" ? "Evens" : best.f;
}
const edgeTag = (e) => `<span class="edge ${e >= -0.0005 ? "pos" : "neg"}">${signedPct(e)} edge</span>`;

// ---------- storage (this phone only) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("evens." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evens." + k, JSON.stringify(v)); } catch { /* private mode: keep in memory */ } },
};
const DEFAULT_SETTINGS = { oddsFormat: "decimal", stake: 10, bankroll: 200, monthlyLimit: 100, builder: null, myBooks: null };
let settings = Object.assign({}, DEFAULT_SETTINGS, store.get("settings", {}));
let bets = store.get("bets", []);
const saveSettings = () => store.set("settings", settings);
const saveBets = () => store.set("bets", bets);

// ---------- data ----------
let DATA = null, HIST = null, FIX = {}, LEGS = {}, BOOKS = {}, SLIP_BOOKS = [];
const myBooks = () => { const m = (settings.myBooks || SLIP_BOOKS).filter((b) => SLIP_BOOKS.includes(b)); return m.length ? m : SLIP_BOOKS; };
let todayWindow = null;
let marks = {}; // legId -> "locked" | "out" (builder)

async function loadJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

async function load() {
  try {
    [DATA, HIST] = await Promise.all([loadJSON("data/latest.json"), loadJSON("data/history.json").catch(() => null)]);
  } catch (e) {
    $("#stamp").textContent = "Couldn't load odds. Check your connection and reopen.";
    $("#slips").innerHTML = `<div class="empty">No odds yet. The first refresh runs each morning at about 07:15.</div>`;
    return;
  }
  FIX = Object.fromEntries(DATA.fixtures.map((f) => [f.id, f]));
  LEGS = Object.fromEntries(DATA.legs.map((l) => [l.id, l]));
  BOOKS = Object.fromEntries(DATA.books.map((b) => [b.slug, b.name]));
  const EXCHANGES = ["betfair-ex", "matchbook"];
  SLIP_BOOKS = DATA.books.filter((b) => b.slips !== false && !EXCHANGES.includes(b.slug)).map((b) => b.slug);
  const saved = store.get("marks", { at: null, marks: {} });
  marks = saved.at === DATA.generated_at ? saved.marks : {};
  const when = new Date(DATA.odds_taken_at);
  const age = (Date.now() - when) / 36e5;
  $("#stamp").textContent = `Odds checked ${fmtTime(DATA.odds_taken_at)}${age > 20 ? " (old)" : ""}`;
  autoSettleBets();
  renderAll();
}

function renderAll() {
  renderToday();
  renderBuilderControls();
  renderBuilt();
  renderLegs();
  renderBets();
  renderRecord();
}

// ---------- tabs ----------
document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(tab) {
  document.querySelectorAll("main > section").forEach((s) => (s.hidden = s.id !== tab));
  document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false"));
  window.scrollTo({ top: 0 });
  if (tab === "build") renderBuilt();
}

// ---------- slip card ----------
function slipCard(slip, { place = true, tweak = true } = {}) {
  const legs = slip.legs.map((id) => LEGS[id]).filter(Boolean);
  const rows = legs.map((l) => {
    const f = FIX[l.fixture_id];
    const price = slip.prices[l.id];
    return `<div class="leg">
      <div class="leg-sel">${esc(l.label)}</div>
      <div class="leg-price num">${odds(price)}<small>${pct(l.p_win)} likely</small></div>
      <div class="leg-match">${esc(f.home)} v ${esc(f.away)} · ${esc(fmtTime(f.kickoff, false))} ${esc(f.league)}</div>
    </div>`;
  }).join("");
  return `<article class="slip" data-slip="${esc(slip.id)}">
    <div class="slip-head"><span class="slip-book">${esc(BOOKS[slip.book] || slip.book)}</span><span class="slip-when">${esc(slip.label)}, ${slip.n_legs} legs</span></div>
    ${slip.alsoAt && slip.alsoAt.length ? `<div class="slip-when" style="padding:0 14px 8px">Same prices at ${slip.alsoAt.map((b) => esc(BOOKS[b] || b)).join(", ")}</div>` : ""}
    ${rows}
    <div class="slip-foot">
      <div class="stat"><b class="num">${odds(slip.odds)}</b><span>Combined odds</span></div>
      <div class="stat"><b class="num">${pct(slip.hit_p)}</b><span>Real chance it lands</span></div>
      <div class="stat"><b class="num">${money(settings.stake * slip.odds)}</b><span>£${settings.stake} returns</span></div>
      <div class="stat"><b>${edgeTag(slip.ev)}</b><span>${slip.ev >= 0 ? "Priced better than fair" : "Priced worse than fair"}</span></div>
    </div>
    <div class="slip-actions">
      ${place ? `<button class="btn primary" data-act="place">Placed it</button>` : ""}
      ${tweak ? `<button class="btn" data-act="tweak">Tweak in builder</button>` : ""}
    </div>
  </article>`;
}

// Sister bookies (e.g. Unibet, BetMGM, BetUK) often post identical prices: show one card.
function mergeTwins(slips) {
  const out = [], seen = new Map();
  for (const s of slips) {
    const key = s.legs.map((id) => id + "@" + s.prices[id]).sort().join("|");
    if (seen.has(key)) { seen.get(key).alsoAt.push(s.book); continue; }
    const copy = Object.assign({}, s, { alsoAt: [] });
    seen.set(key, copy); out.push(copy);
  }
  return out;
}

function wireSlips(container, slips) {
  container.querySelectorAll("[data-slip]").forEach((card) => {
    const slip = slips.find((s) => s.id === card.dataset.slip);
    card.querySelector('[data-act="place"]')?.addEventListener("click", () => openPlaceSheet(slip));
    card.querySelector('[data-act="tweak"]')?.addEventListener("click", () => {
      marks = {};
      slip.legs.forEach((id) => (marks[id] = "locked"));
      saveMarks();
      const b = builderState();
      b.books = [slip.book];
      b.start = "all";
      settings.builder = b; saveSettings();
      renderBuilderControls();
      showTab("build");
    });
  });
}

// ---------- Today ----------
function renderToday() {
  const now = Date.now();
  const mine = new Set(myBooks());
  const slips = mergeTwins(DATA.slips.filter((s) => Date.parse(s.start) > now && mine.has(s.book)).sort((a, c) => c.ev - a.ev))
    .filter((s, i, arr) => arr.filter((x) => x.start === s.start).indexOf(s) < 3);
  const starts = [...new Set(slips.map((s) => s.start))].sort();
  if (!todayWindow || !starts.includes(todayWindow)) todayWindow = starts[0] || null;
  const today = dayKey(new Date().toISOString());
  $("#windows").innerHTML = starts.map((st) => {
    const n = slips.filter((s) => s.start === st).length;
    const lbl = dayKey(st) === today ? fmtTime(st, false) : fmtTime(st);
    return `<button class="chip num" aria-pressed="${st === todayWindow}" data-start="${st}">${esc(lbl)}<small>${n}</small></button>`;
  }).join("");
  $("#windows").querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { todayWindow = c.dataset.start; renderToday(); }));

  const notes = (DATA.notes || []).filter((n) => !/^Refreshed/.test(n));
  $("#todayNotes").innerHTML = notes.map((n) => `<div class="notice">${esc(n)}</div>`).join("");

  const shown = slips.filter((s) => s.start === todayWindow);
  if (!shown.length) {
    $("#slips").innerHTML = `<div class="empty">No slips near evens for the coming kick-offs.<br>Open the builder to loosen the filters.</div>`;
    return;
  }
  $("#slips").innerHTML = shown.map((s) => slipCard(s)).join("") +
    `<p class="hint">Real chance and edge use Pinnacle's prices with the margin taken out. Edge is the expected gain or loss per £1 over many bets.</p>`;
  wireSlips($("#slips"), shown);
}

// ---------- Builder ----------
const MARKETS = ["Result", "Double chance", "Draw no bet", "Goals", "Team to score", "Team goals", "BTTS", "Handicap"];
function builderState() {
  const d = DATA.defaults;
  const def = { legs: d.legs_options, tmin: d.target_min, tmax: d.target_max, minEdge: d.leg_min_edge, minP: d.leg_min_fair_prob,
    maxLeg: d.leg_max_price, spread: d.kickoff_spread_hours, books: myBooks(), markets: MARKETS.slice(), start: "all" };
  const b = Object.assign(def, settings.builder || {});
  b.books = b.books.filter((x) => SLIP_BOOKS.includes(x));
  if (!b.books.length) b.books = myBooks();
  return b;
}
function saveMarks() { store.set("marks", { at: DATA.generated_at, marks }); }

function renderBuilderControls() {
  const b = builderState();
  const starts = [...new Set(DATA.legs.map((l) => FIX[l.fixture_id].kickoff))].filter((k) => Date.parse(k) > Date.now()).sort();
  $("#controls").innerHTML = `
    <div class="ctl"><div class="lbl">Number of legs</div>
      <div class="chips">${[3, 4, 5, 6].map((n) => `<button class="chip" data-legs="${n}" aria-pressed="${b.legs.includes(n)}">${n}</button>`).join("")}</div></div>
    <div class="ctl"><div class="lbl">Combined odds between</div>
      <div class="pair"><input id="tmin" type="number" inputmode="decimal" step="0.05" min="1.2" value="${b.tmin}" aria-label="Lowest combined odds"><span>and</span>
      <input id="tmax" type="number" inputmode="decimal" step="0.05" min="1.3" value="${b.tmax}" aria-label="Highest combined odds"></div>
      <div class="err" id="tErr"></div></div>
    <div class="ctl"><div class="ctl-row"><label for="minP">Each leg at least this likely</label><output id="minPo">${pct(b.minP)}</output></div>
      <input id="minP" type="range" min="0.5" max="0.97" step="0.01" value="${b.minP}"></div>
    <div class="ctl"><div class="ctl-row"><label for="minEdge">Each leg's edge at least</label><output id="minEdgeo">${signedPct(b.minEdge)}</output></div>
      <input id="minEdge" type="range" min="-0.1" max="0.05" step="0.005" value="${b.minEdge}"></div>
    <div class="ctl"><div class="ctl-row"><label for="maxLeg">Highest price per leg</label><output id="maxLego">${odds(b.maxLeg)}</output></div>
      <input id="maxLeg" type="range" min="1.1" max="2" step="0.01" value="${b.maxLeg}"></div>
    <div class="ctl"><div class="ctl-row"><label for="spread">Kick-offs within</label><output id="spreado">${b.spread} hours</output></div>
      <input id="spread" type="range" min="0" max="8" step="0.5" value="${b.spread}"></div>
    <div class="ctl"><div class="lbl">First kick-off</div>
      <div class="chips"><button class="chip" data-start="all" aria-pressed="${b.start === "all"}">Any</button>${starts.map((s) => `<button class="chip num" data-start="${s}" aria-pressed="${b.start === s}">${esc(fmtTime(s))}</button>`).join("")}</div></div>
    <div class="ctl"><div class="lbl">Bookies</div>
      <div class="chips">${myBooks().map((x) => `<button class="chip" data-book="${x}" aria-pressed="${b.books.includes(x)}">${esc(BOOKS[x])}</button>`).join("")}</div>
      <p class="hint" style="margin:6px 0 0">Change which bookies you use in Settings.</p></div>
    <div class="ctl"><div class="lbl">Markets</div>
      <div class="chips">${MARKETS.map((m) => `<button class="chip" data-market="${esc(m)}" aria-pressed="${b.markets.includes(m)}">${esc(m)}</button>`).join("")}</div></div>
    <div class="ctl"><button class="btn small" id="resetBuilder">Reset to defaults</button></div>`;

  const update = (fn) => { const s = builderState(); fn(s); settings.builder = s; saveSettings(); renderBuilt(); };
  const c = $("#controls");
  c.querySelectorAll("[data-legs]").forEach((el) => el.addEventListener("click", () => update((s) => {
    const n = +el.dataset.legs;
    s.legs = s.legs.includes(n) ? s.legs.filter((x) => x !== n) : [...s.legs, n].sort();
    if (!s.legs.length) s.legs = [n];
    c.querySelectorAll("[data-legs]").forEach((x) => x.setAttribute("aria-pressed", s.legs.includes(+x.dataset.legs)));
  })));
  const toggleSet = (attr, key) => c.querySelectorAll(`[data-${attr}]`).forEach((el) => el.addEventListener("click", () => update((s) => {
    const v = el.dataset[attr];
    s[key] = s[key].includes(v) ? s[key].filter((x) => x !== v) : [...s[key], v];
    if (!s[key].length) s[key] = [v];
    c.querySelectorAll(`[data-${attr}]`).forEach((x) => x.setAttribute("aria-pressed", s[key].includes(x.dataset[attr])));
  })));
  toggleSet("book", "books");
  toggleSet("market", "markets");
  c.querySelectorAll("[data-start]").forEach((el) => el.addEventListener("click", () => update((s) => {
    s.start = el.dataset.start;
    c.querySelectorAll("[data-start]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.start === s.start));
  })));
  const slider = (id, key, show) => $("#" + id).addEventListener("input", (e) => update((s) => { s[key] = +e.target.value; $("#" + id + "o").textContent = show(s[key]); }));
  slider("minP", "minP", (v) => pct(v));
  slider("minEdge", "minEdge", (v) => signedPct(v));
  slider("maxLeg", "maxLeg", (v) => odds(v));
  slider("spread", "spread", (v) => `${v} hours`);
  ["tmin", "tmax"].forEach((id) => $("#" + id).addEventListener("input", () => {
    const lo = parseFloat($("#tmin").value), hi = parseFloat($("#tmax").value);
    if (!(lo >= 1.1) || !(hi > lo)) { $("#tErr").textContent = "Enter a lowest figure above 1.1 and a highest figure above it."; return; }
    $("#tErr").textContent = "";
    update((s) => { s.tmin = lo; s.tmax = hi; });
  }));
  $("#resetBuilder").addEventListener("click", () => { settings.builder = null; marks = {}; saveMarks(); saveSettings(); renderBuilderControls(); renderBuilt(); renderLegs(); });
}

function buildSlips(b) {
  const t0 = performance.now();
  const ko = (l) => Date.parse(FIX[l.fixture_id].kickoff);
  const now = Date.now();
  const markets = new Set(b.markets);
  const locked = Object.keys(marks).filter((id) => marks[id] === "locked" && LEGS[id]).map((id) => LEGS[id]);
  const legs = DATA.legs.filter((l) => marks[l.id] !== "out" && ko(l) > now && (markets.has(l.market) || marks[l.id] === "locked"));
  let anchors = [...new Set(legs.map(ko))].sort((a, c) => a - c);
  if (b.start !== "all") anchors = anchors.filter((a) => a === Date.parse(b.start));
  const spreadMs = b.spread * 36e5;
  const ks = new Set(b.legs), maxK = Math.max(...b.legs);
  const found = new Map();
  let explored = 0;

  for (const anchor of anchors) {
    const inWin = legs.filter((l) => ko(l) >= anchor && ko(l) <= anchor + spreadMs);
    if (locked.some((l) => !inWin.includes(l))) continue;
    for (const book of b.books) {
      if (locked.some((l) => l.prices[book] == null)) continue;
      const lockedFx = new Set(locked.map((l) => l.fixture_id));
      let elig = inWin.filter((l) => marks[l.id] !== "locked" && !lockedFx.has(l.fixture_id)).map((l) => {
        const p = l.prices[book];
        if (p == null || p > b.maxLeg || p < 1.01 || l.p_win < b.minP) return null;
        const e = p * l.p_win + l.p_void - 1;
        return e < b.minEdge ? null : { l, p, e };
      }).filter(Boolean).sort((x, y) => y.e - x.e || y.l.p_win - x.l.p_win);
      const perFx = {}, pool = [];
      for (const it of elig) {
        if ((perFx[it.l.fixture_id] = (perFx[it.l.fixture_id] || 0) + 1) > 3) continue;
        pool.push(it);
        if (pool.length >= 24) break;
      }
      pool.sort((x, y) => x.p - y.p);
      let odds0 = 1, val0 = 1, hit0 = 1;
      for (const l of locked) { const p = l.prices[book]; odds0 *= p; val0 *= p * l.p_win + l.p_void; hit0 *= l.p_win + l.p_void; }
      const chosen = [], used = new Set(lockedFx);
      const dfs = (start, o, v, h) => {
        explored++;
        const k = locked.length + chosen.length;
        if (ks.has(k) && o >= b.tmin && o <= b.tmax) {
          const ids = [...locked.map((l) => l.id), ...chosen.map((c) => c.l.id)];
          const key = book + "|" + [...ids].sort().join("|");
          if (!found.has(key)) {
            const prices = {};
            locked.forEach((l) => (prices[l.id] = l.prices[book]));
            chosen.forEach((c) => (prices[c.l.id] = c.p));
            const times = ids.map((id) => ko(LEGS[id])).sort((a, c) => a - c);
            found.set(key, { id: key, book, legs: ids, prices, odds: o, hit_p: h, ev: v - 1, n_legs: ids.length,
              start: new Date(times[0]).toISOString(), label: times[0] === times[times.length - 1] ? fmtTime(times[0]) : `${fmtTime(times[0])}–${fmtTime(times[times.length - 1], false)}` });
          }
        }
        if (k >= maxK || explored > 400000) return;
        for (let i = start; i < pool.length; i++) {
          const it = pool[i];
          const no = o * it.p;
          if (no > b.tmax) break;
          if (used.has(it.l.fixture_id)) continue;
          chosen.push(it); used.add(it.l.fixture_id);
          dfs(i + 1, no, v * (it.p * it.l.p_win + it.l.p_void), h * (it.l.p_win + it.l.p_void));
          chosen.pop(); used.delete(it.l.fixture_id);
        }
      };
      dfs(0, odds0, val0, hit0);
    }
  }
  // best first, then drop near-duplicates
  const all = [...found.values()].sort((x, y) => y.ev - x.ev || y.hit_p - x.hit_p);
  const out = [];
  for (const s of all) {
    const fx = new Set(s.legs.map((id) => LEGS[id].fixture_id));
    const dup = out.some((o) => { const f2 = new Set(o.legs.map((id) => LEGS[id].fixture_id)); let inter = 0; fx.forEach((x) => f2.has(x) && inter++); return inter / new Set([...fx, ...f2]).size > 0.6; });
    if (!dup) out.push(s);
    if (out.length >= 8) break;
  }
  return { slips: out, explored, ms: Math.round(performance.now() - t0), total: found.size };
}

function renderBuilt() {
  if (!DATA) return;
  const b = builderState();
  const lockedN = Object.values(marks).filter((m) => m === "locked").length;
  const outN = Object.values(marks).filter((m) => m === "out").length;
  $("#lockSummary").innerHTML = lockedN || outN
    ? `<div class="notice">${lockedN ? `${lockedN} leg${lockedN > 1 ? "s" : ""} locked in. ` : ""}${outN ? `${outN} removed. ` : ""}<button class="toggle-more" id="clearMarks">Clear</button></div>` : "";
  $("#clearMarks")?.addEventListener("click", () => { marks = {}; saveMarks(); renderBuilt(); renderLegs(); });
  const r = buildSlips(b);
  r.slips = mergeTwins(r.slips);
  const head = `<p class="hint num">${r.total} slips fit. Showing the best ${r.slips.length}.</p>`;
  $("#builtSlips").innerHTML = r.slips.length ? head + r.slips.map((s) => slipCard(s, { tweak: false })).join("")
    : `<div class="empty">Nothing fits these settings. Try widening the odds range, allowing more legs, or lowering the leg chance.</div>`;
  wireSlips($("#builtSlips"), r.slips);
}

// ---------- Legs ----------
function renderLegs() {
  if (!DATA) return;
  const q = ($("#legSearch").value || "").trim().toLowerCase();
  const byFx = {};
  DATA.legs.forEach((l) => (byFx[l.fixture_id] = byFx[l.fixture_id] || []).push(l));
  const fixtures = DATA.fixtures.filter((f) => byFx[f.id] && Date.parse(f.kickoff) > Date.now())
    .filter((f) => !q || `${f.home} ${f.away} ${f.league} ${f.country}`.toLowerCase().includes(q));
  if (!fixtures.length) { $("#legList").innerHTML = `<div class="empty">No matches found.</div>`; return; }
  $("#legList").innerHTML = fixtures.slice(0, 120).map((f) => {
    const xg = f.model ? `Model's expected goals ${f.model.xg_home} v ${f.model.xg_away}` : "";
    const mine = myBooks();
    const best = (l) => { let bk = null; mine.forEach((x) => { if (l.prices[x] != null && (bk == null || l.prices[x] > l.prices[bk])) bk = x; }); return bk; };
    const rows = byFx[f.id].filter((l) => best(l)).sort((a, c) => c.edges[best(c)] - a.edges[best(a)]).map((l) => {
      const bk = best(l);
      const state = marks[l.id] || "none";
      const icon = state === "locked" ? "✓" : state === "out" ? "✕" : "+";
      const lockLabel = state === "locked" ? "Locked in builder. Tap to remove." : state === "out" ? "Removed from builder. Tap to reset." : "Tap to lock into builder.";
      const prices = Object.entries(l.prices).sort((a, c) => c[1] - a[1]).map(([b2, p]) => `<span>${esc(BOOKS[b2] || b2)} <b class="num">${odds(p)}</b> ${signedPct(l.edges[b2])}</span>`).join("");
      const model = l.model_p != null ? `, model ${pct(l.model_p)}` : "";
      return `<div class="leg-row" data-leg="${esc(l.id)}">
        <div><div class="lbl">${esc(l.label)}</div><div class="sub num">Fair ${odds(l.fair_price)} (${pct(l.p_win)}${model})</div></div>
        <div class="px num">${odds(l.prices[bk])}<div class="sub">${esc(BOOKS[bk])}</div><div>${edgeTag(l.edges[bk])}</div></div>
        <button class="lock" data-state="${state}" aria-label="${lockLabel}">${icon}</button>
        <div class="prices" hidden>${prices}<span>Source: ${esc(l.source)}</span></div>
      </div>`;
    }).join("");
    return `<div class="match"><div class="match-head"><div><div class="teams">${esc(f.home)} v ${esc(f.away)}</div>
      <div class="meta">${esc(f.league)}, ${esc(f.country)}${xg ? ". " + esc(xg) : ""}</div></div>
      <div class="meta num">${esc(fmtTime(f.kickoff))}</div></div>${rows}</div>`;
  }).join("");
  $("#legList").querySelectorAll(".leg-row").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".lock")) return;
      const p = row.querySelector(".prices"); p.hidden = !p.hidden;
    });
    row.querySelector(".lock").addEventListener("click", () => {
      const id = row.dataset.leg;
      marks[id] = marks[id] === "locked" ? "out" : marks[id] === "out" ? undefined : "locked";
      if (!marks[id]) delete marks[id];
      saveMarks(); renderLegs(); renderBuilt();
    });
  });
}
$("#legSearch").addEventListener("input", () => renderLegs());

// ---------- Bets ----------
function openSheet(html, mount) {
  $("#sheetBody").innerHTML = html;
  $("#sheet").hidden = false;
  mount && mount($("#sheetBody"));
  $("#sheetBody").querySelector("input, button")?.focus();
}
function closeSheet() { $("#sheet").hidden = true; $("#sheetBody").innerHTML = ""; }
$("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#sheet").hidden) closeSheet(); });

function slipSnapshot(slip) {
  return slip.legs.map((id) => { const l = LEGS[id], f = FIX[l.fixture_id];
    return { label: l.label, match: `${f.home} v ${f.away}`, kickoff: f.kickoff, price: slip.prices[id], p_win: l.p_win }; });
}

function openPlaceSheet(slip) {
  openSheet(`<h3 id="sheetTitle">Log this bet</h3>
    <p class="hint">${esc(BOOKS[slip.book] || slip.book)}, ${slip.n_legs} legs, ${esc(slip.label)}</p>
    <div class="field"><label for="pStake">Stake (£)</label><input id="pStake" type="number" inputmode="decimal" min="0.1" step="0.5" value="${settings.stake}"></div>
    <div class="field"><label for="pOdds">Odds you got (decimal)</label><input id="pOdds" type="number" inputmode="decimal" min="1.01" step="0.01" value="${slip.odds.toFixed(2)}"></div>
    <div class="err" id="pErr"></div>
    <div class="sheet-actions"><button class="btn" id="pCancel">Cancel</button><button class="btn primary" id="pSave">Save bet</button></div>`, (s) => {
    s.querySelector("#pCancel").addEventListener("click", closeSheet);
    s.querySelectorAll("input").forEach((i) => i.addEventListener("input", () => (s.querySelector("#pErr").textContent = "")));
    s.querySelector("#pSave").addEventListener("click", () => {
      const stake = parseFloat(s.querySelector("#pStake").value), o = parseFloat(s.querySelector("#pOdds").value);
      if (!(stake > 0)) { s.querySelector("#pErr").textContent = "Enter a stake above £0."; return; }
      if (!(o >= 1.01)) { s.querySelector("#pErr").textContent = "Enter the odds as a decimal, e.g. 2.05."; return; }
      bets.unshift({ id: `${Date.now()}`, slipId: slip.id, placedAt: new Date().toISOString(), book: slip.book, bookName: BOOKS[slip.book] || slip.book,
        label: slip.label, start: slip.start, stake, odds: o, hit_p: slip.hit_p, ev: slip.ev, legs: slipSnapshot(slip), status: "pending", returns: null });
      saveBets(); closeSheet(); renderBets();
      const btn = document.querySelector(`[data-slip="${CSS.escape(slip.id)}"] [data-act="place"]`);
      if (btn) { btn.textContent = "Saved to My bets"; btn.disabled = true; }
    });
  });
}

function autoSettleBets() {
  if (!HIST) return;
  const byId = Object.fromEntries((HIST.slips || []).map((s) => [s.slip_id, s]));
  let changed = false;
  bets.forEach((b) => {
    const h = byId[b.slipId];
    if (b.status === "pending" && h && (h.status === "won" || h.status === "lost")) {
      b.status = h.status; b.returns = h.status === "won" ? b.stake * b.odds : 0; b.settledAt = new Date().toISOString(); b.auto = true; changed = true;
    }
  });
  if (changed) saveBets();
}

function betStats() {
  const settled = bets.filter((b) => b.status !== "pending").slice().sort((a, c) => a.placedAt.localeCompare(c.placedAt));
  let pl = 0, peak = 0, dd = 0, run = 0, worstRun = 0, staked = 0, won = 0;
  const series = [];
  settled.forEach((b) => {
    const profit = b.status === "void" ? 0 : (b.returns ?? 0) - b.stake;
    if (b.status !== "void") staked += b.stake;
    if (b.status === "won") { won++; run = 0; } else if (b.status === "lost") { run++; worstRun = Math.max(worstRun, run); }
    pl += profit; peak = Math.max(peak, pl); dd = Math.min(dd, pl - peak);
    series.push({ x: series.length + 1, y: pl, label: `${b.label}: ${signedMoney(profit)}` });
  });
  const month = new Date().toISOString().slice(0, 7);
  const monthStaked = bets.filter((b) => b.placedAt.slice(0, 7) === month).reduce((s, b) => s + b.stake, 0);
  return { settled, pl, staked, won, roi: staked ? pl / staked : null, dd, worstRun, series, monthStaked };
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
    <div class="notice">This month: <b class="num">${money(st.monthStaked)}</b> staked of your <b class="num">${money(settings.monthlyLimit)}</b> limit.
      <div class="progress ${over ? "over" : ""}"><div style="width:${Math.min(100, (st.monthStaked / settings.monthlyLimit) * 100)}%"></div></div>
      ${over ? `<div class="err">You're over your monthly limit.</div>` : ""}</div>
    ${st.series.length >= 2 ? `<h2>Profit over time</h2><div class="chart" id="plChart"></div>` : ""}
    <h2>Next 50 slips</h2>
    <p class="hint">${esc(sim.basis)}</p>
    <div class="chart" id="simChart"></div>
    <div class="legend"><span><i style="background:var(--chart-softer)"></i>8 in 10 runs</span><span><i style="background:var(--chart-soft)"></i>Middle half</span><span><i style="background:var(--chart);height:3px"></i>Typical</span></div>
    <p class="hint num">At £${settings.stake} a slip you'd be ahead after 50 in ${pct(sim.pAhead)} of runs. Typical result ${signedMoney(sim.median)}; a bad run (1 in 10) ${signedMoney(sim.p10)}.</p>
    <h2>Waiting on results</h2>
    ${pending.length ? pending.map(betCard).join("") : `<p class="hint">Tap "Placed it" on a slip to log it here.</p>`}
    ${st.settled.length ? `<h2>Settled</h2>${bets.filter((b) => b.status !== "pending").slice(0, 30).map(betCard).join("")}` : ""}
    <h2>Backup</h2>
    <p class="hint">Your bets live on this phone only. Save a copy now and then.</p>
    <div class="slip-actions" style="padding:0"><button class="btn" id="exportBets">Save a copy</button><label class="btn" style="display:inline-grid;place-items:center">Restore a copy<input id="importBets" type="file" accept="application/json" hidden></label></div>`;
  if (st.series.length >= 2) lineChart($("#plChart"), st.series, { money: true });
  fanChart($("#simChart"), sim.bands);
  $("#betsBody").querySelectorAll("[data-bet]").forEach((card) => {
    const b = bets.find((x) => x.id === card.dataset.bet);
    card.querySelectorAll("[data-set]").forEach((btn) => btn.addEventListener("click", () => {
      const s = btn.dataset.set;
      if (s === "delete") { bets = bets.filter((x) => x !== b); }
      else { b.status = s; b.returns = s === "won" ? b.stake * b.odds : s === "void" ? b.stake : 0; b.settledAt = new Date().toISOString(); }
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
      bets = obj.bets; if (obj.settings) settings = Object.assign({}, DEFAULT_SETTINGS, obj.settings);
      saveBets(); saveSettings(); renderAll();
    } catch { alert("That file isn't an Evens backup."); }
  });
}

function betCard(b) {
  const legs = b.legs.map((l) => `<div class="sub">${esc(l.label)} <span class="num">${odds(l.price)}</span>, ${esc(l.match)}</div>`).join("");
  const settled = b.status !== "pending";
  const profit = b.status === "void" ? 0 : (b.returns ?? 0) - b.stake;
  return `<div class="bet" data-bet="${esc(b.id)}">
    <div class="bet-top"><div><b>${esc(b.bookName)}</b> <span class="sub">${esc(b.label)}</span></div>
      <span class="status ${b.status}">${settled ? `${b.status === "won" ? "Won" : b.status === "lost" ? "Lost" : "Void"} ${b.status !== "void" ? signedMoney(profit) : ""}` : "Pending"}</span></div>
    <div class="sub num">£${b.stake.toFixed(2)} at ${odds(b.odds)}, real chance ${pct(b.hit_p)}</div>
    ${legs}
    <div class="bet-actions">${settled ? `<button class="btn small" data-set="pending">Undo result</button>` :
      `<button class="btn small good" data-set="won">Won</button><button class="btn small bad" data-set="lost">Lost</button><button class="btn small" data-set="void">Void</button>`}
      <button class="btn small" data-set="delete">Delete</button></div>
  </div>`;
}

// Monte Carlo: 50 slips, using your bets (if you have 5+) or today's suggestions.
function simulate() {
  const N = 50, RUNS = 2000;
  let pool = bets.filter((b) => b.hit_p && b.odds).map((b) => ({ p: b.hit_p, o: b.odds }));
  let basis = "Based on the bets you've logged, assuming the model's chances are right.";
  if (pool.length < 5) {
    pool = (DATA?.slips || []).map((s) => ({ p: s.hit_p, o: s.odds }));
    basis = "Based on today's suggested slips, assuming the model's chances are right. Real results swing a lot.";
  }
  if (!pool.length) pool = [{ p: 0.47, o: 2.05 }];
  const stake = settings.stake;
  const paths = Array.from({ length: N + 1 }, () => new Float64Array(RUNS));
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let r = 0; r < RUNS; r++) {
    let pl = 0;
    for (let i = 1; i <= N; i++) {
      const s = pool[Math.floor(rand() * pool.length)];
      pl += rand() < s.p ? stake * (s.o - 1) : -stake;
      paths[i][r] = pl;
    }
  }
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  const bands = paths.map((col, i) => { const a = Array.from(col).sort((x, y) => x - y); return { x: i, p10: q(a, 0.1), p25: q(a, 0.25), p50: q(a, 0.5), p75: q(a, 0.75), p90: q(a, 0.9) }; })
    .filter((b) => b.x % 5 === 0);
  const last = Array.from(paths[N]).sort((x, y) => x - y);
  return { bands, basis, pAhead: last.filter((v) => v > 0).length / RUNS, median: q(last, 0.5), p10: q(last, 0.1) };
}

// ---------- Record ----------
function renderRecord() {
  if (!HIST || !HIST.summary) { $("#recordBody").innerHTML = `<div class="empty">The record fills in as matches finish. Check back after the weekend.</div>`; return; }
  const s = HIST.summary;
  const cal = Object.entries(HIST.calibration || {}).map(([bin, v]) => ({ said: v.p_sum / v.n, came: v.wins / v.n, n: v.n, bin: +bin })).filter((b) => b.n > 0).sort((a, c) => a.said - c.said);
  const settledSlips = (HIST.slips || []).filter((x) => x.status !== "pending").slice(0, 25);
  const pendingSlips = (HIST.slips || []).filter((x) => x.status === "pending");
  $("#recordBody").innerHTML = `
    <div class="tiles">
      <div class="tile"><b class="num">${s.won} of ${s.won + s.lost}</b><span>Slips won (expected ${s.expected_wins})</span></div>
      <div class="tile"><b class="num">${signedMoney(s.profit_per_10)}</b><span>Profit at £10 a slip</span></div>
      <div class="tile"><b class="num">${s.roi == null ? "–" : signedPct(s.roi)}</b><span>Return on stakes</span></div>
      <div class="tile"><b class="num">${s.pending}</b><span>Waiting on results</span></div>
    </div>
    <h2>Does it know what it's saying?</h2>
    <p class="hint">Each dot is a group of legs. Across: how likely the model said they were. Up: how often they actually came in. On the dashed line means honest chances.</p>
    ${cal.length ? `<div class="chart" id="calChart"></div>` : `<p class="hint">Needs a weekend of results first.</p>`}
    <h2>Recent slips</h2>
    ${[...pendingSlips.slice(0, 5), ...settledSlips].map(recordCard).join("") || `<p class="hint">None yet.</p>`}`;
  if (cal.length) calibrationChart($("#calChart"), cal);
}
function recordCard(h) {
  const mark = (r) => (r === "won" ? "✓" : r === "lost" ? "✕" : r === "void" ? "–" : "·");
  return `<div class="bet"><div class="bet-top"><div><b>${esc(BOOKS[h.book] || h.book)}</b> <span class="sub">${esc(h.label)}, ${odds(h.odds)}</span></div>
    <span class="status ${h.status}">${h.status === "pending" ? "Pending" : h.status === "won" ? `Won ${signedMoney(h.profit_per_10)}` : h.status === "lost" ? "Lost −£10.00" : esc(h.status)}</span></div>
    ${h.legs.map((l) => `<div class="sub leg-result">${mark(l.result)} ${esc(l.label)} <span class="num">${odds(l.price)}</span>, ${esc(l.match)}${l.score ? ` <b class="num">${esc(l.score)}</b>` : ""}</div>`).join("")}</div>`;
}

// ---------- charts (plain SVG) ----------
const W = 340, H = 170, PAD = { l: 44, r: 10, t: 10, b: 22 };
function scale(d0, d1, r0, r1) { return (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0); }
function ticks(lo, hi, n = 4) { const step = (hi - lo) / n; return Array.from({ length: n + 1 }, (_, i) => lo + i * step); }

function addHover(el, svg, xs, tipFor) {
  const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; el.appendChild(tip);
  const cross = svg.querySelector(".cross");
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    let i = 0; xs.forEach((v, k) => { if (Math.abs(v - x) < Math.abs(xs[i] - x)) i = k; });
    const t = tipFor(i);
    cross?.setAttribute("x1", xs[i]); cross?.setAttribute("x2", xs[i]); if (cross) cross.style.display = "";
    tip.innerHTML = t.html; tip.hidden = false;
    tip.style.left = `${Math.max(60, Math.min(rect.width - 60, (xs[i] / W) * rect.width))}px`;
    tip.style.top = `${(t.y / H) * rect.height + 10}px`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerdown", move);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; if (cross) cross.style.display = "none"; });
}

function lineChart(el, pts, { money: isMoney } = {}) {
  const ys = pts.map((p) => p.y).concat(0);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const x = scale(pts[0].x, pts[pts.length - 1].x, PAD.l, W - PAD.r), y = scale(lo, hi, H - PAD.b, PAD.t);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative profit after each settled bet">
    ${ticks(lo, hi).map((t) => `<text class="tick num" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${isMoney ? poundTick(t) : t.toFixed(1)}</text>`).join("")}
    <line class="zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}"/>
    <path class="ln" d="${d}"/><line class="cross" y1="${PAD.t}" y2="${H - PAD.b}" style="display:none"/>
    <text class="tick" x="${W - PAD.r}" y="${H - 4}" text-anchor="end">Bets settled</text></svg>`;
  addHover(el, el.querySelector("svg"), pts.map((p) => x(p.x)), (i) => ({ html: `Bet ${pts[i].x}: ${esc(signedMoney(pts[i].y))} total<br>${esc(pts[i].label)}`, y: y(pts[i].y) }));
}

function fanChart(el, bands) {
  const lo = Math.min(...bands.map((b) => b.p10), 0), hi = Math.max(...bands.map((b) => b.p90), 0);
  const x = scale(0, bands[bands.length - 1].x, PAD.l, W - PAD.r), y = scale(lo, hi, H - PAD.b, PAD.t);
  const area = (a, b) => bands.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p[a])}`).join("") + bands.slice().reverse().map((p) => `L${x(p.x)},${y(p[b])}`).join("") + "Z";
  const mid = bands.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.p50)}`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Range of possible profit over the next 50 slips">
    ${ticks(lo, hi).map((t) => `<text class="tick num" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${poundTick(t)}</text>`).join("")}
    <path class="band1" d="${area("p90", "p10")}"/><path class="band2" d="${area("p75", "p25")}"/>
    <line class="zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(0)}" y2="${y(0)}"/>
    <path class="ln" d="${mid}"/><line class="cross" y1="${PAD.t}" y2="${H - PAD.b}" style="display:none"/>
    <text class="tick" x="${W - PAD.r}" y="${H - 4}" text-anchor="end">Slips from now</text></svg>`;
  addHover(el, el.querySelector("svg"), bands.map((b) => x(b.x)), (i) => {
    const b = bands[i];
    return { html: `After ${b.x} slips<br>Typical ${esc(signedMoney(b.p50))}<br>8 in 10: ${esc(signedMoney(b.p10))} to ${esc(signedMoney(b.p90))}`, y: y(b.p50) };
  });
}

function calibrationChart(el, bins) {
  const lo = 0.5, hi = 1;
  const x = scale(lo, hi, PAD.l, W - PAD.r), y = scale(lo, hi, H - PAD.b, PAD.t);
  const maxN = Math.max(...bins.map((b) => b.n));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Predicted chance against actual win rate">
    ${[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((t) => `<text class="tick num" x="${PAD.l - 6}" y="${y(t) + 4}" text-anchor="end">${Math.round(t * 100)}%</text><text class="tick num" x="${x(t)}" y="${H - 6}" text-anchor="middle">${Math.round(t * 100)}%</text>`).join("")}
    <line class="ref" x1="${x(lo)}" y1="${y(lo)}" x2="${x(hi)}" y2="${y(hi)}"/>
    ${bins.map((b) => `<circle class="dot" cx="${x(b.said)}" cy="${y(Math.max(lo, b.came))}" r="${(5 + 7 * Math.sqrt(b.n / maxN)).toFixed(1)}"/>`).join("")}</svg>`;
  addHover(el, el.querySelector("svg"), bins.map((b) => x(b.said)), (i) => ({ html: `Said ${pct(bins[i].said)}, came in ${pct(bins[i].came)}<br>${bins[i].n} legs`, y: y(Math.max(lo, bins[i].came)) }));
}

// ---------- settings ----------
$("#settingsBtn").addEventListener("click", () => {
  openSheet(`<h3 id="sheetTitle">Settings</h3>
    <div class="field"><label>Show odds as</label><div class="chips">
      <button class="chip" data-fmt="decimal" aria-pressed="${settings.oddsFormat !== "fraction"}">Decimal (2.10)</button>
      <button class="chip" data-fmt="fraction" aria-pressed="${settings.oddsFormat === "fraction"}">Fractions (11/10)</button></div></div>
    <div class="field"><label for="sStake">Usual stake (£)</label><input id="sStake" type="number" inputmode="decimal" min="1" step="1" value="${settings.stake}"></div>
    <div class="field"><label for="sLimit">Monthly limit (£)</label><input id="sLimit" type="number" inputmode="decimal" min="1" step="5" value="${settings.monthlyLimit}"></div>
    <div class="err" id="sErr"></div>
    <div class="field"><label>Bookies you have accounts with</label><div class="chips">
      ${SLIP_BOOKS.map((b) => `<button class="chip" data-mybook="${b}" aria-pressed="${myBooks().includes(b)}">${esc(BOOKS[b])}</button>`).join("")}</div>
      <p class="hint">Sky Bet and William Hill aren't in the odds feed, so they can't be shown.</p></div>
    <div class="sheet-actions"><button class="btn primary" id="sSave">Save settings</button></div>
    <h3 style="margin-top:20px">Fresh odds</h3>
    <p class="hint">Odds refresh every morning at about 07:15. To refresh now, open GitHub and tap "Run workflow". Each refresh uses some of the month's 250 free requests${DATA?.budget?.remaining_after != null ? ` (${DATA.budget.remaining_after} left)` : ""}.</p>
    <a class="btn" style="display:inline-grid;place-items:center;text-decoration:none" href="${REPO_ACTIONS}" target="_blank" rel="noopener">Open refresh page</a>
    <h3 style="margin-top:20px">How the numbers work</h3>
    <p class="hint">Fair price: Pinnacle's odds with their margin removed. Pinnacle's prices are the sharpest in the market, so they're the best guide to the real chance.
    Edge: how much the UK bookie's price beats (green) or falls short of (red) fair. A slip's edge multiplies across its legs.
    Model: a goals model built from two seasons of results, shown as a second opinion.</p>`, (s) => {
    s.querySelectorAll("[data-fmt]").forEach((b) => b.addEventListener("click", () => {
      settings.oddsFormat = b.dataset.fmt; saveSettings();
      s.querySelectorAll("[data-fmt]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.fmt === settings.oddsFormat));
      renderAll();
    }));
    s.querySelectorAll("[data-mybook]").forEach((b) => b.addEventListener("click", () => {
      const cur = new Set(myBooks()); const v = b.dataset.mybook;
      cur.has(v) ? cur.delete(v) : cur.add(v);
      if (!cur.size) cur.add(v);
      settings.myBooks = [...cur]; settings.builder = null; saveSettings();
      s.querySelectorAll("[data-mybook]").forEach((x) => x.setAttribute("aria-pressed", cur.has(x.dataset.mybook)));
      renderAll();
    }));
    s.querySelector("#sSave").addEventListener("click", () => {
      const stake = parseFloat(s.querySelector("#sStake").value), lim = parseFloat(s.querySelector("#sLimit").value);
      if (!(stake > 0) || !(lim > 0)) { s.querySelector("#sErr").textContent = "Enter amounts above £0."; return; }
      settings.stake = stake; settings.monthlyLimit = lim; saveSettings(); closeSheet(); renderAll();
    });
  });
});

// ---------- start ----------
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
load();
