/* The Telly (round 5, 10 Nov 2026): the pub TV in the corner, showing teletext.
   A third room beside the slots and the card table, built for a glance:
     P302 What's on   every kick-off session coming up, the best slip any of your bookies
                      can make for it, and a plain verdict. Tap one to load it on the machine.
     P303 Your bets   placed bets as they stand: scores, chance now, a fair cash-out.
     P304 The form    is it luck, did the claimed edge turn up, which prices to trust,
                      which bookie is best today.
   Uses the same data and maths as the rest of the app (app.js); nothing here is fetched. */
"use strict";

let ttPage = 302;
let ttCache = null;
const TT_PAGES = { 302: "What's on", 303: "Your bets", 304: "The form" };
const up = (s) => esc(String(s).toUpperCase());
const ttBar = (frac, cls = "") => `<span class="tt-bar ${cls}" aria-hidden="true"><i style="width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%"></i></span>`;

// ---------- P302: what's on ----------
// Kick-off windows overlap (each takes 2.5 hours of matches), so they're grouped into
// sessions: a new one starts when a kick-off falls outside the first window's span.
function tellySessions() {
  const spread = (DATA.defaults?.kickoff_spread_hours || 2.5) * 3600e3;
  const groups = [];
  for (const w of upcoming().filter((x) => booksFor(x).length)) {
    const cur = groups[groups.length - 1];
    if (cur && Date.parse(w.start_utc) - Date.parse(cur.start_utc) <= spread) continue;
    groups.push(w);
  }
  return groups.slice(0, 8).map((w) => {
    const fids = new Set();
    w.bookies.forEach((b) => myBooks().includes(b.bookie) && b.fixtures.forEach((f) => inComps(f.fixture_id) && fids.add(f.fixture_id)));
    const comps = [...new Set([...fids].map(compOf))].map((c) => COMPS.find((x) => x.id === c)?.name).filter(Boolean);
    const best = bestSlipFor(w);
    let chance = null, pin = 0, span = null;
    if (best) {
      chance = best.combo.picks.reduce((m, p) => m * (p.leg.fair_p + (p.leg.p_void || 0)), 1);
      pin = best.combo.picks.filter((p) => PINNACLE_BACKED.includes(p.leg.fair_source)).length;
      const kos = best.combo.picks.map((p) => p.fx.kickoff_utc).sort();
      span = [kos[0], kos[kos.length - 1]];
    }
    return { w, games: fids.size, comps, best, chance, pin, span };
  }).filter((s) => s.games);
}
// One word on a slip, from its edge after trust. Symbol and word, never colour alone.
function verdict(ev) {
  if (ev >= 0.01) return { cls: "g", mark: "★", word: "Worth a spin" };
  if (ev >= -0.01) return { cls: "c", mark: "●", word: "Fair game" };
  if (ev >= -0.03) return { cls: "y", mark: "▼", word: "Thin" };
  return { cls: "r", mark: "✗", word: "Swerve" };
}
function tellyData() {
  const key = [DATA.generated_at, JSON.stringify(prefs), JSON.stringify(settings), Math.floor(Date.now() / 120000)].join("|");
  if (ttCache?.key === key) return ttCache;
  const sessions = tellySessions();
  let tableRows = [];
  try { ensureTableBook(); tableRows = dealerRows().rows; } catch { /* no player lines today */ }
  ttCache = { key, sessions, tableRows };
  return ttCache;
}
function page302() {
  const { sessions, tableRows } = tellyData();
  const good = sessions.filter((s) => s.best && s.best.combo.ev >= 0.01).length;
  const made = sessions.filter((s) => s.best).length;
  const live = sweatCandidate();
  let liveRow = "";
  if (live) {
    const pr = betProgress(live), now = betNow(live);
    liveRow = `<button class="tt-item tt-live" data-go="303"><span class="tt-l"><span class="flash">▶ Your bet is live</span><span>${pr.landed} of ${live.legIds.length} in</span></span>
      <span class="tt-l"><span>${now.started && !now.dead ? `Chance now ${now.approx ? "about " : ""}${pct(now.chance)}` : esc(live.bookName)}</span><span class="c">P303 ›</span></span></button>`;
  }
  const headline = !sessions.length ? "Nothing priced yet"
    : good ? `${good} of ${plural(sessions.length, "session")} worth a spin`
    : made ? "Nothing beats the bookie right now" : "No slip near evens";
  const sub = !sessions.length ? `No kick-offs with prices, ${rangeName().toLowerCase()}. Odds refresh about 07:15.`
    : good ? "The rest are for fun, or a swerve."
    : made ? "Every slip is priced below fair. Play small for fun, or swerve." : "The pools can't make evens with your filters.";
  let lastDay = null;
  const rows = sessions.map((s, i) => {
    const day = dayKey(s.w.start_utc);
    const head = day !== lastDay ? `<div class="tt-day">${up(dayWord(s.w.start_utc))}${dayWord(s.w.start_utc) === dayLong(s.w.start_utc) ? "" : ` <span>${up(dayLong(s.w.start_utc))}</span>`}</div>` : "";
    lastDay = day;
    const t = fmtTime(s.w.start_utc, false);
    if (!s.best) {
      return `${head}<div class="tt-item off"><span class="tt-l"><b class="y">${t}</b><span class="c">${plural(s.games, "game")}</span><span class="w comps">${up(s.comps.join(" · "))}</span></span>
        <span class="tt-l dim">No slip near evens here</span></div>`;
    }
    const v = verdict(s.best.combo.ev), n = s.best.combo.picks.length;
    const end = fmtTime(s.span[1], false);
    return `${head}<button class="tt-item" data-session="${i}" aria-label="${esc(`${dayWord(s.w.start_utc)} ${t}: ${v.word}. ${bookName(s.best.bookie)}, ${n} legs at ${odds(s.best.combo.odds)}. Load it on the machine`)}">
      <span class="tt-l"><b class="y">${t}${end !== t ? `<small>–${end}</small>` : ""}</b><span class="c">${plural(s.games, "game")}</span><span class="w comps">${up(s.comps.join(" · "))}</span></span>
      <span class="tt-l"><span class="${v.cls}">${v.mark} ${up(v.word)}</span><b class="w">${up(odds(s.best.combo.odds))}</b></span>
      <span class="tt-l dim"><span class="lab">${up(bookName(s.best.bookie))} · ${n} legs</span><span>lands ${pct(s.chance)} · edge ${signedPct(s.best.combo.ev)} ›</span></span></button>`;
  }).join("");
  const table = tableRows.length ? `<div class="tt-day m">The card table <span>NFL players</span></div>` + tableRows.map((r) => {
    const h = r.hands[0], v = verdict(h.ev);
    return `<button class="tt-item" data-room="table"><span class="tt-l"><b class="y">${up(r.title)}</b><span class="c">${up(r.sub)}</span></span>
      <span class="tt-l"><span class="${v.cls}">${v.mark} ${up(v.word)}</span><b class="w">${up(odds(h.odds))}</b></span>
      <span class="tt-l dim"><span class="lab">${up(bookName(h.book))} · ${h.cards.length} cards</span><span>lands ${pct(h.chance)} · edge ${signedPct(h.ev)} ›</span></span></button>`;
  }).join("") : "";
  const picked = scopeName();
  const st = betStats();
  return `<h2 class="tt-title"><span>What's on</span></h2>
    ${liveRow}
    <p class="tt-head ${good ? "g" : "y"}">${up(headline)}</p>
    <p class="tt-sub">${esc(sub)}</p>
    ${picked ? `<p class="tt-sub c">Showing ${esc(picked)} only (the game buttons on the slots).</p>` : ""}
    ${rows}${table}
    <div class="tt-foot"><span>Odds checked ${up(fmtTime(DATA.odds_taken_at))}</span><span>Month ${poundTick(st.monthStaked)} of ${poundTick(settings.monthlyLimit)}${st.settled.length ? ` · ${signedMoney(st.pl)}` : ""}</span></div>
    <p class="tt-note">Edge is after trust: a big claimed edge is only part believed. Why: P304.</p>`;
}
function tellyLoad(i) {
  const s = ttCache?.sessions[i];
  if (!s?.best) return;
  const c = sweatCandidate();
  if (c) sweatOptOut.add(c.id);
  watchingId = null;
  slip = { window_id: s.w.id, bookie: s.best.bookie, stake: slip?.stake || 10, legs: [] };
  applyCombo(s.best.combo, []);
  recordScope(); ticketState.copied = false; copied = false;
  Sound.unlock(); Sound.stop(); buzz(12);
  location.hash = "#home";
}

// ---------- P303: your bets, as they stand ----------
function betBlock(b) {
  const pr = betProgress(b), now = betNow(b), n = b.legIds.length;
  const legs = b.legIds.map((id, i) => {
    const l = b.legs[i] || {}, { st, sc } = legNow(id), f = FIX[id.split("|")[0]];
    const mark = { won: "✓", lost: "✗", ahead: "▲", behind: "▼", level: "●", void: "–", off: "–", wait: "·" }[st] || "·";
    const cls = { won: "g", lost: "r", ahead: "g", behind: "y", level: "c" }[st] || "w";
    const who = f ? `${code(f, "home")} v ${code(f, "away")}` : (l.match || "").split(/ v | @ /).map((x) => x.slice(0, 3)).join(" v ");
    const right = sc && sc.h != null && st !== "wait" ? `${sc.h}–${sc.a} ${sc.s === "HT" ? "HT" : sc.s === "FT" ? "FT" : sc.min ? `${sc.min}′` : ""}` : l.kickoff ? fmtTime(l.kickoff, false) : "";
    // In play: this leg's own chance now, so "on track" at 3–1 with half an hour left reads as the sweat it is.
    const inPlay = ["ahead", "behind", "level"].includes(st) ? legChanceNow(id, l.p_win ?? 0.8) : null;
    return `<div class="tt-l leg"><span class="${cls}">${mark}</span><span class="c who">${up(who)}</span><span class="w lab">${up(l.label || "")}</span><span class="y">${up(right)}</span>${inPlay && !inPlay.approx ? `<span class="${cls} pc">${pct(inPlay.p)}</span>` : ""}</div>`;
  }).join("");
  const dead = now.dead || pr.gone;
  const state = dead ? `<div class="tt-l"><span class="r">✗ Gone · ${money(b.stake)} lost</span></div>`
    : !now.started ? `<div class="tt-l dim"><span>Not started · real chance ${pct(b.hit_p)}</span></div>`
    : `<div class="tt-l"><span class="${now.chance >= now.was ? "g" : "y"}">Chance now ${now.approx ? "about " : ""}${pct(now.chance)}</span>${ttBar(now.chance, now.chance >= now.was ? "g" : "y")}<span class="dim">was ${pct(now.was)}</span></div>
       <div class="tt-l"><span class="w">Fair cash-out</span><b class="w">${money(now.value)}</b></div>`;
  return `<div class="tt-bet"><div class="tt-l"><b class="y">${up(b.bookName)} ${n}-FOLD</b><span class="c">${pr.landed} of ${n} in</span></div>${legs}${state}
    <div class="tt-l dim"><span>${money(b.stake)} at ${up(odds(b.odds))}</span><span>pays ${money(b.stake * b.odds)}</span></div></div>`;
}
function page303() {
  const pending = bets.filter((b) => b.status === "pending" && b.legIds?.length);
  const done = bets.filter((b) => b.status !== "pending").slice(0, 6);
  const st = betStats();
  const anyLive = pending.some((b) => betNow(b).started);
  return `<h2 class="tt-title"><span>Your bets</span></h2>
    ${pending.length ? pending.slice(0, 4).map(betBlock).join("") : `<p class="tt-head y">No bets on</p><p class="tt-sub">Pull the lever, copy a slip to your bookie, then tap "Placed it". It shows here with live scores.</p>`}
    ${anyLive ? `<p class="tt-note">A fair cash-out is what the bet is worth right now. If your bookie offers less, the gap is their cut. Scores ${LIVE?.updated_at ? `checked ${fmtTime(LIVE.updated_at, false)}` : "update about every 10 minutes"}.</p>` : ""}
    ${done.length ? `<div class="tt-day">Latest results</div>${done.map((b) => {
      const profit = b.status === "void" ? 0 : (b.returns ?? 0) - b.stake;
      return `<div class="tt-l res"><span class="${b.status === "won" ? "g" : b.status === "lost" ? "r" : "w"}">${b.status === "won" ? "✓ Won" : b.status === "lost" ? "✗ Lost" : "– Void"}</span><span class="w lab">${up(b.bookName)} · ${up(b.label)}</span><span class="${profit >= 0 ? "g" : "r"}">${signedMoney(profit)}</span></div>`;
    }).join("")}` : ""}
    <div class="tt-foot"><span>${st.settled.length ? `${st.won} of ${st.settled.filter((b) => b.status !== "void").length} won · ${signedMoney(st.pl)}` : "Nothing settled yet"}</span><span>Month ${poundTick(st.monthStaked)} of ${poundTick(settings.monthlyLimit)}</span></div>`;
}

// ---------- P304: the form ----------
const EDGE_BANDS = [["big", "Over +5%"], ["some", "+1% to +5%"], ["flat", "−3% to +1%"], ["poor", "Under −3%"]];
const SOURCE_NAMES = { sharp: "Pinnacle", "sharp-derived": "Pinnacle, derived", "sharp+model": "Pinnacle + model", consensus: "UK bookies' average", "market+model": "UK avg + model", model: "Our model alone", unknown: "Not recorded" };
const MARKET_NAMES = { ou: "Goals over/under", ts: "Team to score", tt: "Team goals", ah: "Handicap", dnb: "Draw no bet", "1x2": "Match result", dc: "Double chance", btts: "Both to score",
  "nfl-sp": "NFL spread", "nfl-tot": "NFL total", "nfl-ml": "NFL winner", "nba-sp": "NBA spread", "nba-tot": "NBA total", "nba-ml": "NBA winner", rec_yds: "Receiving yards", rush_yds: "Rushing yards", pass_yds: "Passing yards" };
// Wins against what the prices said to expect. With few bets nearly everything is luck.
function luck(won, expected, variance, n) {
  if (!n) return null;
  const z = variance > 0 ? (won - expected) / Math.sqrt(variance) : 0;
  const word = z >= 1 ? ["g", "▲", "Running hot"] : z <= -1 ? ["y", "▼", "Running cold"] : ["c", "●", "About right"];
  return { z, cls: word[0], mark: word[1], word: word[2] };
}
function page304() {
  // 1. Your own bets.
  const mine = bets.filter((b) => (b.status === "won" || b.status === "lost") && b.hit_p);
  const mWon = mine.filter((b) => b.status === "won").length;
  const mExp = mine.reduce((s, b) => s + b.hit_p, 0), mVar = mine.reduce((s, b) => s + b.hit_p * (1 - b.hit_p), 0);
  const ml = luck(mWon, mExp, mVar, mine.length);
  // 2. The model's published slips.
  const hs = HIST?.summary, hn = hs ? hs.won + hs.lost : 0;
  const hl = hs ? luck(hs.won, hs.expected_wins, hn * 0.25, hn) : null;
  const luckRow = (title, won, n, exp, l) => `<div class="tt-l luck"><b class="w">${up(title)}</b><span class="y">${won} of ${n} won</span></div>
    <div class="tt-l"><span class="${l.cls}">${l.mark} ${up(l.word)}</span>${ttBar(0.5 + Math.max(-0.5, Math.min(0.5, l.z / 4)), `${l.cls} mid`)}<span class="dim">prices said ${exp.toFixed(1)}</span></div>`;
  const ev = HIST?.evidence || {};
  const edgeRows = EDGE_BANDS.filter(([k]) => ev.edge?.[k]?.n).map(([k, name]) => {
    const b = ev.edge[k], got = b.return_sum / b.n;
    return `<div class="tt-l tab"><span class="w">${up(name)}</span><span class="c">${b.n}</span><span class="y">${signedPct(b.claimed_sum / b.n)}</span><span class="${got >= 0 ? "g" : "r"}">${signedPct(got)}</span></div>`;
  }).join("");
  const saidCame = (group, names) => Object.entries(ev[group] || {}).filter(([, b]) => b.n >= 5).sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([k, b]) => {
    const said = b.p_sum / b.n, came = b.wins / b.n;
    return `<div class="tt-l tab"><span class="w">${up(names[k] || k)}</span><span class="c">${b.n}</span><span class="y">${pct(said)}</span><span class="${came >= said - 0.02 ? "g" : "r"}">${pct(came)}</span></div>`;
  }).join("");
  // Which of your bookies has the best price most often, today.
  const tally = {};
  for (const l of DATA.legs || []) {
    const ps = myBooks().filter((b) => l.prices?.[b]);
    if (ps.length < 2) continue;
    const top = Math.max(...ps.map((b) => l.prices[b]));
    ps.forEach((b) => { const t = (tally[b] ||= { n: 0, best: 0, edge: 0 }); t.n++; if (l.prices[b] >= top - 1e-9) t.best++; t.edge += l.prices[b] * l.p_win + (l.p_void || 0) - 1; });
  }
  const league = Object.entries(tally).filter(([, t]) => t.n >= 10).sort((a, b) => b[1].edge / b[1].n - a[1].edge / a[1].n);
  const leagueRows = league.map(([b, t], i) => `<div class="tt-l tab"><span class="w">${i + 1} ${up(bookName(b))}</span><span class="c">${t.n}</span><span class="y">${pct(t.best / t.n)}</span><span class="${t.edge / t.n >= 0 ? "g" : "r"}">${signedPct(t.edge / t.n)}</span></div>`).join("");
  const src = saidCame("source", SOURCE_NAMES), mk = saidCame("market", MARKET_NAMES);
  return `<h2 class="tt-title"><span>The form</span></h2>
    <div class="tt-day">Luck or judgement</div>
    ${ml ? luckRow("Your bets", mWon, mine.length, mExp, ml) : `<p class="tt-sub">Log a few bets with "Placed it" and this shows whether you're running hot or cold.</p>`}
    ${hl ? luckRow("The model's slips", hs.won, hn, hs.expected_wins, hl) : ""}
    <p class="tt-note">Around evens, it takes about 100 bets before a run means more than luck.</p>
    <div class="tt-day">Did the edge show up?</div>
    ${edgeRows ? `<div class="tt-l tab th"><span>Edge we claimed</span><span>Legs</span><span>Claimed</span><span>Got</span></div>${edgeRows}
      <p class="tt-note">Every leg we priced, grouped by the edge the model claimed at the best price on offer. "Got" is the return per £1. This is why the app only part-believes a big edge.</p>`
      : `<p class="tt-sub">Fills in as results arrive.</p>`}
    ${src ? `<div class="tt-day">Whose prices to trust</div><div class="tt-l tab th"><span>Fair price from</span><span>Legs</span><span>Said</span><span>Came</span></div>${src}` : ""}
    ${mk ? `<div class="tt-day">By market</div><div class="tt-l tab th"><span>Market</span><span>Legs</span><span>Said</span><span>Came</span></div>${mk}` : ""}
    ${leagueRows ? `<div class="tt-day">Bookie league <span>today</span></div><div class="tt-l tab th"><span>Bookie</span><span>Legs</span><span>Best on</span><span>Avg edge</span></div>${leagueRows}
      <p class="tt-note">"Best on" is how often it has the top price of your bookies. Average edge is before trust; under zero is the bookie's margin.</p>` : ""}
    <div class="tt-foot"><span>${HIST?.generated_at ? `Record to ${up(fmtTime(HIST.generated_at))}` : ""}</span><span>More: Payout table</span></div>`;
}

// ---------- the screen ----------
function ttClockText() {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ }).format(new Date()).replace(",", "");
}
function renderTelly() {
  if (!TT_PAGES[ttPage]) ttPage = 302;
  $("#ttPage").textContent = `P${ttPage}`;
  $("#ttClock").textContent = ttClockText();
  const body = $("#ttBody");
  body.innerHTML = ({ 302: page302, 303: page303, 304: page304 })[ttPage]();
  document.querySelectorAll("#telly .fx[data-tt]").forEach((b) => b.setAttribute("aria-pressed", +b.dataset.tt === ttPage));
}
function tellyGo(n) {
  ttPage = n;
  Sound.unlock(); Sound.stop(); buzz(8);
  const scr = $("#ttScreen");
  renderTelly();
  if (!reducedMotion()) { scr.classList.remove("retune"); void scr.offsetWidth; scr.classList.add("retune"); }
  $("#telly").scrollIntoView({ block: "start" });
}
$("#ttBody").addEventListener("click", (e) => {
  const it = e.target.closest("[data-session], [data-go], [data-room]");
  if (!it) return;
  if (it.dataset.session != null) tellyLoad(+it.dataset.session);
  else if (it.dataset.go) tellyGo(+it.dataset.go);
  else location.hash = "#" + it.dataset.room;
});
document.querySelectorAll("#telly .fx").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.tt) tellyGo(+b.dataset.tt);
  else location.hash = b.dataset.href;
}));
setInterval(() => { if (!document.hidden && !$("#telly").hidden) $("#ttClock").textContent = ttClockText(); }, 1000);
