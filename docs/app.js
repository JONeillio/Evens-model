/* Evens Bandit: a pub fruit machine for near-evens football accumulators.
   Data: data/latest.json (fixtures, legs, published slips, and leg pools per
   kick-off window and bookie) + data/history.json (the model's record).
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

const FRACS = ["1/100","1/50","1/33","1/25","1/20","1/16","1/14","1/12","1/10","1/9","1/8","2/15","1/7","2/13","1/6","2/11","1/5","2/9","1/4","2/7","3/10","1/3","4/11","2/5","4/9","1/2","8/15","4/7","8/13","4/6","8/11","4/5","5/6","10/11","1/1","21/20","11/10","6/5","5/4","11/8","6/4","13/8","7/4","15/8","2/1","9/4","5/2","11/4","3/1","10/3","7/2","4/1"]
  .map((f) => { const [a, b] = f.split("/").map(Number); return { f, d: 1 + a / b }; });
function odds(dec) {
  if (dec == null) return "–";
  if (settings.oddsFormat !== "fraction") return dec.toFixed(2);
  let best = FRACS[0];
  for (const x of FRACS) if (Math.abs(x.d - dec) < Math.abs(best.d - dec)) best = x;
  return best.f === "1/1" ? "Evens" : best.f;
}

// ---------- storage (this phone only) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("evens." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("evens." + k, JSON.stringify(v)); } catch { /* storage unavailable: keep in memory */ } },
};
const DEFAULTS = { oddsFormat: "decimal", monthlyLimit: 100, myBooks: null, minP: 0.68, maxLeg: 1.45, minEdge: -0.06 };
let settings = Object.assign({}, DEFAULTS, store.get("settings", {}));
let bets = store.get("bets", []);
let slip = store.get("slip", null); // shared by the machine and Build a bet
const saveSettings = () => store.set("settings", settings);
const saveBets = () => store.set("bets", bets);
const saveSlip = () => store.set("slip", slip);

// ---------- data ----------
let DATA = null, HIST = null, FIX = {}, LEGS = {}, BOOKS = {}, SLIP_BOOKS = [], WINDOWS = [];
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
    [DATA, HIST] = await Promise.all([loadJSON("data/latest.json"), loadJSON("data/history.json").catch(() => null)]);
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
  ensureSlip();
  route();
}

// ---------- pools ----------
const windowById = (id) => WINDOWS.find((w) => w.id === id);
function rawPool(windowId, bookie) {
  const w = windowById(windowId);
  return w ? (w.bookies.find((b) => b.bookie === bookie) || null) : null;
}
// The pool with your filters applied (used for spins and adding legs).
function pool(windowId, bookie) {
  const p = rawPool(windowId, bookie);
  if (!p) return [];
  return p.fixtures.map((f) => Object.assign({}, f, {
    legs: f.legs.filter((l) => l.fair_p >= settings.minP && l.price <= settings.maxLeg),
  })).filter((f) => f.legs.length);
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

function ensureSlip() {
  const valid = slip && windowById(slip.window_id) && Date.parse(windowById(slip.window_id).start_utc) > Date.now()
    && myBooks().includes(slip.bookie) && resolve().length >= MIN_LEGS;
  if (valid) {
    slip.legs = slip.legs.filter((l) => findLeg(slip.window_id, slip.bookie, l.leg_id));
    saveSlip();
    return;
  }
  const w = upcoming().find((x) => booksFor(x).length);
  if (!w) { slip = null; saveSlip(); return; }
  // Start from the model's best published slip for this window at your bookies.
  const best = DATA.slips.filter((s) => s.start === w.id && myBooks().includes(s.book)).sort((a, b) => b.ev - a.ev)[0];
  if (best && best.legs.every((id) => findLeg(w.id, best.book, id))) {
    slip = { window_id: w.id, bookie: best.book, stake: slip?.stake || 10,
      legs: best.legs.map((id) => ({ fixture_id: LEGS[id]?.fixture_id || id.split("|")[0], leg_id: id, held: false })) };
  } else {
    const bk = booksFor(w).sort((a, b) => pool(w.id, b).length - pool(w.id, a).length)[0];
    slip = { window_id: w.id, bookie: bk, stake: slip?.stake || 10, legs: [] };
    fillTo(4);
  }
  sortSlip();
  saveSlip();
}

function sortSlip() {
  const ko = (l) => findLeg(slip.window_id, slip.bookie, l.leg_id)?.fx.kickoff_utc || "";
  slip.legs.sort((a, b) => ko(a).localeCompare(ko(b)));
}

// Best leg from a match not already used (for "+ Add a leg" and topping up).
function bestFreeLeg() {
  const used = new Set(slip.legs.map((l) => l.fixture_id));
  let best = null;
  for (const fx of pool(slip.window_id, slip.bookie)) {
    if (used.has(fx.fixture_id)) continue;
    const leg = fx.legs[0]; // pools arrive sorted by edge
    if (!best || leg.edge > best.leg.edge || (leg.edge === best.leg.edge && leg.fair_p > best.leg.fair_p)) best = { fx, leg };
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

/* Re-spin the reels that aren't held. Searches every combination of legs from
   unused matches that lands the slip in the evens zone with edge at or above your
   minimum, then picks one at random, weighted towards higher edge. */
function spin() {
  const n = slip.legs.length;
  const held = slip.legs.filter((l) => l.held);
  const k = n - held.length;
  if (k === 0) return { ok: false, why: "Every reel is held. Release one to spin it." };
  const heldR = held.map((l) => findLeg(slip.window_id, slip.bookie, l.leg_id)).filter(Boolean);
  const heldFx = new Set(held.map((l) => l.fixture_id));
  let o0 = 1, v0 = 1;
  heldR.forEach(({ leg }) => { o0 *= leg.price; v0 *= leg.price * leg.fair_p + (leg.p_void || 0); });

  const perFx = {};
  const items = [];
  pool(slip.window_id, slip.bookie).filter((f) => !heldFx.has(f.fixture_id)).forEach((fx) => fx.legs.forEach((leg) => items.push({ fx, leg })));
  items.sort((a, b) => b.leg.edge - a.leg.edge);
  const top = items.filter((it) => (perFx[it.fx.fixture_id] = (perFx[it.fx.fixture_id] || 0) + 1) <= 3).slice(0, 30)
    .sort((a, b) => a.leg.price - b.leg.price);

  const found = [];
  let nodes = 0;
  const chosen = [], used = new Set();
  (function dfs(start, o, v) {
    if (++nodes > 150000) return;
    if (chosen.length === k) {
      if (o >= ZONE[0] && o <= ZONE[1] && v - 1 >= settings.minEdge) found.push({ picks: chosen.slice(), ev: v - 1 });
      return;
    }
    for (let i = start; i < top.length; i++) {
      const it = top[i], no = o * it.leg.price;
      if (no > ZONE[1]) break;
      if (used.has(it.fx.fixture_id)) continue;
      chosen.push(it); used.add(it.fx.fixture_id);
      dfs(i + 1, no, v * (it.leg.price * it.leg.fair_p + (it.leg.p_void || 0)));
      chosen.pop(); used.delete(it.fx.fixture_id);
    }
  })(0, o0, v0);

  if (!found.length) return { ok: false, why: "Nothing fits the evens zone with those reels. Release a hold, change the bookie, or loosen Settings." };
  const current = slip.legs.filter((l) => !l.held).map((l) => l.leg_id).sort().join("|");
  let pickFrom = found.sort((a, b) => b.ev - a.ev).slice(0, 60);
  if (pickFrom.length > 1) pickFrom = pickFrom.filter((c) => c.picks.map((p) => p.leg.leg_id).sort().join("|") !== current);
  const weights = pickFrom.map((c) => Math.exp(30 * c.ev));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0), choice = pickFrom[0];
  for (let i = 0; i < pickFrom.length; i++) { r -= weights[i]; if (r <= 0) { choice = pickFrom[i]; break; } }
  const same = choice.picks.map((p) => p.leg.leg_id).sort().join("|") === current;
  const fresh = choice.picks.slice().sort((a, b) => a.fx.kickoff_utc.localeCompare(b.fx.kickoff_utc));
  let j = 0;
  slip.legs = slip.legs.map((l) => (l.held ? l : { fixture_id: fresh[j].fx.fixture_id, leg_id: fresh[j++].leg.leg_id, held: false }));
  saveSlip();
  return { ok: true, same };
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

let spinning = false;
function renderMachine() {
  const where = $("#machineWhere");
  if (!slip) {
    where.textContent = "No kick-offs with prices in the next two days";
    $("#reels").innerHTML = ""; $("#holds").innerHTML = "";
    $("#mOdds").textContent = "–"; $("#mStats").textContent = "";
  } else {
    const w = windowById(slip.window_id);
    where.textContent = `${w.label} · ${bookName(slip.bookie)} · ${countdown(w.start_utc)}`;
    const nums = numbers();
    const n = nums.legs.length;
    const reels = $("#reels"), holds = $("#holds");
    reels.style.setProperty("--n", n); holds.style.setProperty("--n", n);
    reels.classList.toggle("many", n > 4);
    reels.innerHTML = nums.legs.map(({ leg, held }, i) => `<div class="reel${held ? " held" : ""}" data-i="${i}">
      <div class="face"><span class="lbl">${esc(leg.label)}</span><span class="px num">${odds(leg.price)}</span></div></div>`).join("");
    holds.innerHTML = nums.legs.map(({ held }, i) => `<button class="hold-btn" data-i="${i}" aria-pressed="${held}" aria-label="Hold reel ${i + 1}">${held ? "Held" : "Hold"}</button>`).join("");
    holds.querySelectorAll(".hold-btn").forEach((b) => b.addEventListener("click", () => {
      const l = slip.legs[+b.dataset.i]; l.held = !l.held; saveSlip(); renderMachine();
    }));
    $("#mOdds").textContent = odds(nums.odds);
    $("#mStats").innerHTML = `Real chance ${pct(nums.chance)} · edge ${edgeTag(nums.ev)}<br>£${slip.stake} pays £${nums.ret.toFixed(2)}`;
  }
  const st = betStats();
  $("#doorWins").textContent = st.settled.length ? `My bets · ${signedMoney(st.pl)}` : "My bets";
  const led = $("#led");
  led.textContent = `£${String(Math.round(st.monthStaked)).padStart(3, "0")} / £${settings.monthlyLimit}`;
  led.classList.toggle("over", st.monthStaked > settings.monthlyLimit);
}

function pull() {
  if (spinning || !slip) return;
  const msg = $("#mMsg");
  msg.textContent = "";
  const before = slip.legs.map((l) => l.leg_id);
  const res = spin();
  const lever = $("#leverSvg");
  lever.classList.add("pulled");
  if (!res.ok) {
    msg.textContent = res.why;
    document.querySelectorAll("#reels .reel").forEach((r, i) => { if (!slip.legs[i].held) { r.classList.remove("fail"); void r.offsetWidth; r.classList.add("fail"); } });
    setTimeout(() => lever.classList.remove("pulled"), 300);
    return;
  }
  if (res.same) msg.textContent = "Same again: that's the only slip in the evens zone with those holds. Release a reel or change the bookie.";
  spinning = true;
  $("#pullBtn").disabled = true; $("#pullBtn").textContent = "Spinning…";
  const prices = pool(slip.window_id, slip.bookie).flatMap((f) => f.legs.map((l) => odds(l.price))).slice(0, 8);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelectorAll("#reels .reel").forEach((r, i) => {
    if (slip.legs[i].held || before[i] === undefined) return;
    const col = prices.concat(prices).map((p) => `<span>${esc(p)}</span>`).join("");
    r.innerHTML = `<div class="strip-spin num">${col}</div>`;
  });
  setTimeout(() => {
    spinning = false;
    lever.classList.remove("pulled");
    $("#pullBtn").disabled = false; $("#pullBtn").textContent = "Pull for new slips";
    renderMachine();
  }, reduced ? 150 : 900);
}
$("#pullBtn").addEventListener("click", pull);
$("#lever").addEventListener("click", pull);
$("#machineWhere").addEventListener("click", () => slip && openWhereSheet());
setInterval(() => { if (!$("#home").hidden && slip && !spinning) renderMachine(); }, 30000);

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
        <span class="meta num">${odds(leg.price)} · ${pct(leg.fair_p)} chance · edge ${edgeTag(leg.edge)}</span></div>
      <button class="ibtn" data-act="prev" aria-label="Previous market for this match" ${choices < 2 ? "disabled" : ""}><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4 L6 10 L12 16" fill="none" stroke="#5C0F1B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="ibtn" data-act="next" aria-label="Next market for this match" ${choices < 2 ? "disabled" : ""}><svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4 L14 10 L8 16" fill="none" stroke="#5C0F1B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <button class="ibtn x" data-act="remove" aria-label="Remove this leg" ${n <= MIN_LEGS || held ? "disabled" : ""}><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 L13 13 M13 3 L3 13" stroke="#8C1D2C" stroke-width="2.5" stroke-linecap="round"/></svg></button>
    </div>`;
  }).join("");
  $("#buildLegs").querySelectorAll(".bleg").forEach((row) => row.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    const i = +row.dataset.i, l = slip.legs[i];
    if (b.dataset.act === "hold") l.held = !l.held;
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
  $("#bOdds").textContent = odds(nums.odds);
  const st = $("#bStatus");
  if (nums.odds < ZONE[0]) { st.textContent = "A bit short — add a leg"; st.style.color = "var(--jackpot)"; }
  else if (nums.odds > ZONE[1]) { st.textContent = "Getting long — drop one"; st.style.color = "var(--bad-on-dark)"; }
  else { st.textContent = "Bang on evens"; st.style.color = "var(--good-on-dark)"; }
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
      <span>${esc(l.label)}<br><small class="num">real chance ${pct(l.fair_p)}</small></span><span class="p num">${odds(l.price)}</span>${edgeTag(l.edge)}</button>`).join("")}</div>`).join("")
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

function slipText() {
  const nums = numbers();
  const lines = nums.legs.map(({ fx, leg }, i) => `${i + 1}. ${fx.home} v ${fx.away} (${fmtTime(fx.kickoff_utc, false)}): ${leg.label} @ ${leg.price.toFixed(2)}`);
  return `${bookName(slip.bookie)}: ${nums.legs.length}-fold, ${windowById(slip.window_id).label}\n${lines.join("\n")}\nCombined odds ${nums.odds.toFixed(2)}. Stake £${slip.stake}, returns £${nums.ret.toFixed(2)}.`;
}
$("#copyBtn").addEventListener("click", async () => {
  const text = slipText();
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { /* nothing else to try */ }
    ta.remove();
  }
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
    const books = booksFor(w);
    if (!books.includes(bk)) bk = books[0];
    s.innerHTML = `<h3 id="sheetTitle">Which kick-off and bookie?</h3>
      <div class="field"><span class="lbl">Kick-off</span><div class="chips">${upcoming().filter((x) => booksFor(x).length).map((x) => `<button class="chip" data-w="${x.id}" aria-pressed="${x.id === wid}">${esc(x.label)}</button>`).join("")}</div></div>
      <div class="field"><span class="lbl">Bookie</span><div class="chips">${books.map((b) => `<button class="chip" data-b="${b}" aria-pressed="${b === bk}">${esc(bookName(b))} <small>${pool(wid, b).length}</small></button>`).join("")}</div></div>
      <p class="hint">The number is how many matches that bookie has priced in this window.</p>
      <div class="sheet-actions"><button class="cbtn plain" id="wCancel">Cancel</button><button class="cbtn yellow" id="wGo">Load the reels</button></div>`;
    s.querySelectorAll("[data-w]").forEach((b) => b.addEventListener("click", () => { wid = b.dataset.w; draw(s); }));
    s.querySelectorAll("[data-b]").forEach((b) => b.addEventListener("click", () => { bk = b.dataset.b; draw(s); }));
    s.querySelector("#wCancel").addEventListener("click", closeSheet);
    s.querySelector("#wGo").addEventListener("click", () => { changeWhere(wid, bk); closeSheet(); route(); });
  };
  openSheet("", draw);
}
function changeWhere(wid, bk) {
  if (wid === slip.window_id && bk === slip.bookie) return;
  const n = Math.max(4, Math.min(slip.legs.length, MAX_LEGS));
  const keep = slip.legs.filter((l) => l.held && findLeg(wid, bk, l.leg_id));
  slip = { window_id: wid, bookie: bk, stake: slip.stake, legs: keep };
  fillTo(n);
  if (slip.legs.length >= MIN_LEGS) spin();
  sortSlip(); copied = false; saveSlip();
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
  const slips = mergeTwins(DATA.slips.filter((s) => Date.parse(s.start) > Date.now() && mine.has(s.book)).sort((a, b) => b.ev - a.ev))
    .filter((s, i, arr) => arr.filter((x) => x.start === s.start).indexOf(s) < 3);
  const starts = [...new Set(slips.map((s) => s.start))].sort();
  if (!starts.includes(playWindow)) playWindow = starts[0] || null;
  $("#windows").innerHTML = starts.map((st) => `<button class="chip num" data-start="${st}" aria-pressed="${st === playWindow}">${esc(fmtTime(st))}</button>`).join("");
  $("#windows").querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { playWindow = c.dataset.start; renderPlay(); }));
  $("#playNotes").innerHTML = (DATA.notes || []).filter((n) => !/^Refreshed/.test(n)).map((n) => `<div class="notice">${esc(n)}</div>`).join("");
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
    return `<div class="cleg"><span class="sel">${esc(l.label)}</span><span class="p num">${odds(s.prices[id])}<small>${pct(l.p_win)} likely</small></span>
      <span class="m">${esc(f.home)} v ${esc(f.away)}, ${esc(fmtTime(f.kickoff, false))} ${esc(f.league)}</span></div>`;
  }).join("");
  return `<article class="card" data-slip="${esc(s.id)}">
    <div class="card-head"><b>${esc(bookName(s.book))}</b><span>${esc(s.label)}, ${s.n_legs} legs</span></div>
    ${s.alsoAt.length ? `<div class="also">Same prices at ${s.alsoAt.map((b) => esc(bookName(b))).join(", ")}</div>` : ""}
    ${rows}
    <div class="card-foot">
      <div><b class="num">${odds(s.odds)}</b><span>Combined odds</span></div>
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
function openPlaceSheet(b) {
  openSheet(`<h3 id="sheetTitle">Log this bet</h3>
    <p class="hint">${esc(bookName(b.book))}, ${b.legs.length} legs, ${esc(b.label)}</p>
    <div class="field"><label for="pStake">Stake (£)</label><input id="pStake" type="number" inputmode="decimal" min="0.1" step="0.5" value="${b.stake}"></div>
    <div class="field"><label for="pOdds">Odds you got (decimal)</label><input id="pOdds" type="number" inputmode="decimal" min="1.01" step="0.01" value="${b.odds.toFixed(2)}"></div>
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
      location.hash = "#winnings";
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
      bets = obj.bets; if (obj.settings) settings = Object.assign({}, DEFAULTS, obj.settings);
      saveBets(); saveSettings(); route();
    } catch { alert("That file isn't an Evens backup."); }
  });
}

function betCard(b) {
  const settled = b.status !== "pending";
  const profit = b.status === "void" ? 0 : (b.returns ?? 0) - b.stake;
  const tag = { won: `Won ${signedMoney(profit)}`, lost: `Lost ${signedMoney(profit)}`, void: "Void", pending: "Waiting" }[b.status];
  return `<div class="card bet" data-bet="${esc(b.id)}">
    <div class="bet-top"><div><b>${esc(b.bookName)}</b> <span class="sub">${esc(b.label)}</span></div><span class="status ${b.status}">${esc(tag)}</span></div>
    <div class="sub num">£${b.stake.toFixed(2)} at ${odds(b.odds)}, real chance ${pct(b.hit_p)}</div>
    ${b.legs.map((l) => `<div class="sub">${esc(l.label)} <span class="num">${odds(l.price)}</span>, ${esc(l.match)}</div>`).join("")}
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
$("#settingsBtn").addEventListener("click", () => {
  const draft = Object.assign({}, settings, { myBooks: myBooks().slice() });
  openSheet("", (s) => {
    s.innerHTML = `<h3 id="sheetTitle">Settings</h3>
      <div class="field"><span class="lbl">Bookies you have accounts with</span><div class="chips">
        ${SLIP_BOOKS.map((b) => `<button class="chip" data-mybook="${b}" aria-pressed="${draft.myBooks.includes(b)}">${esc(bookName(b))}</button>`).join("")}</div>
        <p class="hint">Sky Bet and William Hill aren't in the odds feed, so they can't be shown.</p></div>
      <div class="field"><label for="sMinP">Each leg at least this likely <output id="oMinP">${pct(draft.minP)}</output></label><input id="sMinP" type="range" min="0.6" max="0.95" step="0.01" value="${draft.minP}"></div>
      <div class="field"><label for="sMax">Highest price per leg <output id="oMax">${draft.maxLeg.toFixed(2)}</output></label><input id="sMax" type="range" min="1.1" max="1.5" step="0.01" value="${draft.maxLeg}"></div>
      <div class="field"><label for="sEdge">Lowest edge a spin can land on <output id="oEdge">${signedPct(draft.minEdge)}</output></label><input id="sEdge" type="range" min="-0.15" max="0.05" step="0.005" value="${draft.minEdge}"></div>
      <div class="field"><span class="lbl">Show odds as</span><div class="chips">
        <button class="chip" data-fmt="decimal" aria-pressed="${draft.oddsFormat !== "fraction"}">Decimal (2.10)</button>
        <button class="chip" data-fmt="fraction" aria-pressed="${draft.oddsFormat === "fraction"}">Fractions (11/10)</button></div></div>
      <div class="field"><label for="sLimit">Monthly limit (£)</label><input id="sLimit" type="number" inputmode="decimal" min="1" step="5" value="${draft.monthlyLimit}"></div>
      <div class="err" id="sErr"></div>
      <div class="sheet-actions"><button class="cbtn plain" id="sCancel">Cancel</button><button class="cbtn yellow" id="sSave">Save settings</button></div>
      <p class="hint" style="margin-top:16px">Odds refresh every morning at about 07:15${DATA?.budget?.remaining_after != null ? `; ${DATA.budget.remaining_after} free requests left this month` : ""}.</p>`;
    s.querySelectorAll("[data-mybook]").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.mybook, set = new Set(draft.myBooks);
      set.has(v) ? set.delete(v) : set.add(v);
      if (!set.size) set.add(v);
      draft.myBooks = [...set];
      s.querySelectorAll("[data-mybook]").forEach((x) => x.setAttribute("aria-pressed", set.has(x.dataset.mybook)));
    }));
    s.querySelectorAll("[data-fmt]").forEach((b) => b.addEventListener("click", () => {
      draft.oddsFormat = b.dataset.fmt;
      s.querySelectorAll("[data-fmt]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.fmt === draft.oddsFormat));
    }));
    const slide = (id, key, out, fmt) => s.querySelector(id).addEventListener("input", (e) => { draft[key] = +e.target.value; s.querySelector(out).textContent = fmt(draft[key]); });
    slide("#sMinP", "minP", "#oMinP", pct);
    slide("#sMax", "maxLeg", "#oMax", (v) => v.toFixed(2));
    slide("#sEdge", "minEdge", "#oEdge", (v) => signedPct(v));
    s.querySelector("#sCancel").addEventListener("click", closeSheet);
    s.querySelector("#sSave").addEventListener("click", () => {
      const lim = parseFloat(s.querySelector("#sLimit").value);
      if (!(lim > 0)) { s.querySelector("#sErr").textContent = "Enter a monthly limit above £0."; return; }
      draft.monthlyLimit = lim;
      settings = draft; saveSettings(); closeSheet(); ensureSlip(); route();
    });
  });
});

// ---------- start ----------
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
load();
