/**
 * The model's report card: /raw/model-eval.json.
 *
 * Written by scripts/backtest-early.mjs from the server's archive - every
 * score the app recorded, and EARLY recomputed point-in-time, each judged as
 * the trade it would have been (take profit or stop out). This module only
 * reads it, caches it, and answers "how has this box done" for the DATA FLOW
 * and the Evaluation tab. Nothing here grades anything itself.
 *
 * Synchronous reads, lazy refresh: a reader gets whatever is cached and the
 * next fetch is kicked off when the copy is older than a minute. A missing
 * file is a normal state (the script has not been run) and reads as null.
 */

import { readRaw } from './storage/raw-store';


const REFRESH_MS = 60000;
let report = null;
let fetchedAt = 0;
let loading = null;

export function loadModelEval() {
  if (loading) return loading;
  loading = readRaw('model-eval.json')
    .then((r) => { report = r && r.scores ? r : null; fetchedAt = report ? Date.now() : Date.now() - REFRESH_MS + 5000; return report; })
    // A failed read (the page still finding the server) retries in 5s, not 60s.
    .catch(() => { fetchedAt = Date.now() - REFRESH_MS + 5000; return report; })
    .finally(() => { loading = null; });
  return loading;
}

/** The cached report (or null), refreshing it in the background when stale. */
export function modelEval() {
  if (Date.now() - fetchedAt > REFRESH_MS) loadModelEval();
  return report;
}

/** Boxes whose report is a whole score rather than an input. */
const SCORE_BOX = { 'EARLY SCORE': 'EARLY' };

/** The report's entry for a box label: { fast: {ic, t}, swing: {ic, t} } or null. */
export function measuredFor(label) {
  const r = modelEval();
  if (!r) return null;
  if (SCORE_BOX[label]) {
    const s = r.scores[SCORE_BOX[label]];
    return s && s.all ? { fast: s.all.fast, swing: s.all.swing } : null;
  }
  const inputs = r.inputs || {};
  return inputs[label] || null;
}

const sign = (x) => (x >= 0 ? '+' : '') + x.toFixed(2);

/**
 * How a signal (or a phase) has traded, as the trade it asks for: BUY as a
 * long, SELL and SHORT as a short. `kind` is 'signals' or 'phases'. Against
 * everyone's same trade, so "+3.4%" reads as better or worse than average.
 */
export function outcomeBadge(kind, name) {
  const r = modelEval();
  if (!r || !r[kind] || !name || !r[kind][name]) return null;
  const side = (r.signalSide && r.signalSide[name]) || (kind === 'phases' ? 'long' : 'long');
  const g = r[kind][name][side] || {};
  const base = (r.everyone && r.everyone[side]) || {};
  const s = g.swing || g.fast; const b = base.swing || base.fast;
  if (!s) return null;
  const hor = g.swing ? 'SWING 24h' : 'FAST 6h';
  const pc = (x) => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
  return {
    text: name + ' ' + pc(s.avgPct),
    tone: b && Number.isFinite(b.avgPct) ? (s.avgPct > b.avgPct + 0.5 ? 'good' : s.avgPct < b.avgPct - 0.5 ? 'bad' : 'flat') : 'flat',
    title: name + ' graded as a ' + side.toUpperCase() + ' (' + hor + '): ' + pc(s.avgPct) + ' average, ' +
      Math.round(s.winPct) + '% won, over ' + s.n.toLocaleString() + ' moments.' +
      (b ? '\nEvery token taken the same way: ' + pc(b.avgPct) + ', ' + Math.round(b.winPct) + '% won.' : '') +
      (g.fast && g.swing ? '\nFAST 6h: ' + pc(g.fast.avgPct) + ', ' + Math.round(g.fast.winPct) + '% won.' : '') +
      '\nFrom ' + r.moments.toLocaleString() + ' moments - see Evaluation.',
  };
}

/**
 * The badge a DATA FLOW box shows: how its value has related to the trade
 * that followed. `tone` is good / bad / flat by the stronger of the two
 * horizons, and only when it is beyond noise (|t| >= 2).
 */
export function measuredBadge(label) {
  const m = measuredFor(label);
  if (!m || !m.fast || !Number.isFinite(m.fast.ic)) return null;
  const pick = [m.fast, m.swing].filter((x) => x && Number.isFinite(x.ic) && Number.isFinite(x.t));
  const strong = pick.filter((x) => Math.abs(x.t) >= 2);
  const lead = strong.sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic))[0];
  const tone = !lead ? 'flat' : (lead.ic > 0 ? 'good' : 'bad');
  const swing = m.swing && Number.isFinite(m.swing.ic) ? sign(m.swing.ic) : 'n/a';
  const r = modelEval();
  return {
    text: sign(m.fast.ic) + ' / ' + swing,
    tone,
    title: 'Measured against the trade that followed (rank IC, per hour, averaged).\n' +
      'FAST ' + (r ? r.trades.fast.label : '') + ': ' + sign(m.fast.ic) + ' (t ' + m.fast.t + ')\n' +
      'SWING ' + (r ? r.trades.swing.label : '') + ': ' + swing + (m.swing && Number.isFinite(m.swing.t) ? ' (t ' + m.swing.t + ')' : '') + '\n' +
      'Above 0 = a higher value here meant a better trade. |t| under 2 is noise.' +
      (r ? '\nFrom ' + r.moments.toLocaleString() + ' moments, ' + new Date(r.window.from).toISOString().slice(0, 10) +
        ' → ' + new Date(r.window.to).toISOString().slice(0, 10) + '.' : ''),
  };
}

/**
 * How one engine's BUY entries did in the last backtest (raw/model-eval.json
 * engines), as the profile list shows it: "entries +0.6% · 43% won", against
 * the board's same trade.
 */
export function engineBadge(key) {
  const r = modelEval();
  const g = r && r.engines && r.engines[key];
  if (!g || !g.entries || !g.entries.all) return null;
  const s = g.entries.all.swing || g.entries.all.fast;
  if (!s) return null;
  const pc = (x) => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
  const t = g.entries.test && (g.entries.test.swing || g.entries.test.fast);
  return {
    text: 'entries ' + pc(s.avgPct) + ' · ' + Math.round(s.winPct) + '% won',
    title: g.label + ': ' + s.n + ' BUY entries graded, ' + pc(s.avgPct) + ' average, ' + Math.round(s.winPct) + '% won' +
      (t ? '\nlast 40% of the hours: ' + pc(t.avgPct) + ', ' + Math.round(t.winPct) + '% won' : '') +
      '\nBUY on ' + g.buyShare + '% of moments.',
  };
}

/**
 * One engine's grades as numbers, for the profile list: its BUY entries over
 * every hour, the walk-forward result on hours its BUY line was not tuned on,
 * and the same trade taken on every token, to read them against.
 */
export function engineGrade(key, windowHours, tradeUsd) {
  const r = modelEval();
  // With a window: the engine's BUY entries held that long (holds report) -
  // raw win share and average, and against the market on the TEST hours.
  // With a trade size too: the same, NET of a round trip at that size.
  const hold = windowHours && r && r.holds && r.holds.engines && r.holds.engines[key];
  if (hold && tradeUsd) {
    const w = hold[windowHours + 'h'];
    const n = w && w.buyNet && w.buyNet[tradeUsd];
    if (n) {
      const t = w.buyNetTest && w.buyNetTest[tradeUsd];
      return {
        win: n.winPct, avg: n.avgPct, n: n.n, net: true, tradeUsd,
        median: n.medianPct, avgWin: n.avgWinPct, avgLoss: n.avgLossPct,
        test: t ? { win: t.winPct, avg: t.avgPct, n: t.n, line: null, vsMarket: false } : null,
        board: null, horizon: windowHours + 'h',
      };
    }
  }
  if (hold) {
    const w = hold[windowHours + 'h'];
    if (!w || !w.buy) return null;
    const base = r.holds.board && r.holds.board[windowHours + 'h'];
    return {
      win: w.buy.winPct, avg: w.buy.avgPct, n: w.buy.n,
      vsMarket: w.buyVsMarket ? w.buyVsMarket.avgPct : null,
      test: w.buyTest ? { win: w.buyTest.winPct, avg: w.buyTest.avgPct, n: w.buyTest.n, line: null, vsMarket: true } : null,
      board: base ? { win: base.winPct, avg: base.avgPct } : null,
      horizon: windowHours + 'h',
    };
  }
  const g = r && r.engines && r.engines[key];
  if (!g || !g.entries || !g.entries.all) return null;
  const s = g.entries.all.swing || g.entries.all.fast;
  if (!s) return null;
  const wf = r.walkForward && r.walkForward[key];
  const t = wf && wf.test && (wf.test.swing || wf.test.fast);
  const base = (r.everyone && r.everyone.long && (r.everyone.long.swing || r.everyone.long.fast)) || null;
  return {
    win: s.winPct, avg: s.avgPct, n: s.n,
    test: t ? { win: t.winPct, avg: t.avgPct, n: t.n, line: wf.line } : null,
    board: base ? { win: base.winPct, avg: base.avgPct } : null,
    horizon: g.entries.all.swing ? '24h' : '6h',
  };
}

/** Each window's result for one engine's BUY entries, vs the market: { '1h': {avg, win, n, test}, ... }. */
export function engineWindows(key) {
  const r = modelEval();
  const h = r && r.holds && r.holds.engines && r.holds.engines[key];
  if (!h) return null;
  const out = {};
  Object.keys(h).forEach((w) => {
    const x = h[w].buyVsMarket; const t = h[w].buyTest;
    out[w] = x ? { avg: x.avgPct, win: x.winPct, n: x.n, test: t ? t.avgPct : null, testN: t ? t.n : 0 } : null;
  });
  return out;
}

/**
 * How one engine's SELL / SHORT calls did as a short, held for a window
 * (holds report): raw win share and average, and against every token.
 */
export function engineExitGrade(key, windowHours) {
  const r = modelEval();
  const h = r && r.holds && r.holds.engines && r.holds.engines[key];
  const w = h && h[windowHours + 'h'];
  if (!w || !w.exit) return null;
  return { win: w.exit.winPct, avg: w.exit.avgPct, n: w.exit.n, vsMarket: w.exitVsMarket ? w.exitVsMarket.avgPct : null };
}
