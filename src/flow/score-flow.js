/**
 * THE MODEL, EXECUTABLE.
 *
 * Every node here IS a box on the DATA FLOW map: same id (f:pipe:<label>),
 * and its `deps` are the boxes the map wires into it. Running the nodes in
 * order, for one token, is computing that token's call - so the map is not a
 * drawing of the model, it is the model. Nothing else in the app computes a
 * score, a phase or a signal; every panel reads what this file produced.
 *
 * WHAT IT ANSWERS. Low caps and memes get one burst of attention, and the
 * price peak IS that burst. So the model places each token on its attention
 * cycle and makes a call:
 *
 *   SAFETY      can it be sold, is the tax sane, is there depth to get out
 *   EARLY       a 0-100 entry score: has it started to move without having
 *               run yet (seven inputs on band curves, weighted)
 *   PHASE       QUIET · WAKING · RUNNING · PEAKING · FADING
 *   SIGNAL      BUY · SELL · SHORT · AVOID · WATCH
 *   TRADE PLAN  the entry, target and stop the signal is graded on
 *
 * WHY THIS AND NOT THE OLD FIFTEEN-INPUT SCORE. Graded against what prices
 * did next (scripts/backtest-early.mjs, Oct 10-13 2026, ~21,000 moments):
 * the old score's top picks were no better than the board over 24h, and
 * several of its inputs pointed the wrong way (buyer breadth, cross-venue,
 * whitespace, reachability). BUY here averaged +3.0% over 24h with 53% wins
 * against +0.0% / 43% for every token; SELL avoided a -3.1% average. That is
 * three days in a mostly falling market - the grading runs again on every
 * backtest, against this very file.
 *
 * WIRES CARRY STANDARD TYPES (flow/types.js): number, bool, text, list, dict.
 * Anything a panel needs beyond the value (an evidence line, a reason) is the
 * node's NOTE - `out(value, note)` - read only for display.
 *
 * The map's edits are obeyed: a box deleted or a wire cut makes that box, and
 * everything downstream, produce nothing; a wire drawn into a dot re-feeds it.
 * The map plugs those edits in through connectFlow() (flow/runtime.js), which
 * is also why this file runs unchanged in Node for the backtest.
 */

import {
  toNumber, to100, multipleScore, logScore,
  walletQualityScore, organicFlowScore,
} from '../calculations/core.js';
import { weightOf, safetyRules, phaseRules, planSetting, engineRules, activeEngine } from './params.js';
import { typeOfValue, coerce } from './types.js';

const fin = Number.isFinite;
const P = (label) => 'f:pipe:' + label;
const num = (x) => (fin(x) ? x : null);
const MIN = 60000;
const HOUR = 60 * MIN;

/* ========================================================== the model === */

/** EARLY's inputs and default weights; each weight is a WEIGHT box on the map. */
export const EARLY_MODEL = Object.freeze([
  { key: 'earlyRoom', label: 'Room to run', weight: 30 },
  { key: 'earlyWaking', label: 'Waking tape', weight: 15 },
  { key: 'earlySeasoning', label: 'Seasoning', weight: 15 },
  { key: 'earlyHolding', label: 'Holding highs', weight: 6 },
  { key: 'earlyInterest', label: 'Fresh interest', weight: 6 },
  { key: 'earlyHolders', label: 'Holder base', weight: 5 },
  { key: 'earlyRepeat', label: 'Repeat buyers', weight: 3 },
]);
/** Fewer inputs than this resolved is no EARLY at all - too little to call an entry on. */
export const EARLY_MIN_PARTS = 4;

/**
 * The curves. A band is [x, points] corners joined by straight lines, flat
 * beyond its ends. The archive's trades that paid sat BETWEEN a dead tape and
 * one that had already run, so the price inputs are bands, not "more is
 * better". Round numbers: shapes the data pointed at, not fitted values.
 */
export const EARLY_CURVES = Object.freeze({
  room: [[0, 40], [0.007, 100], [0.04, 100], [0.15, 0]],     // above the 6h low
  holding: [[0, 60], [0.015, 100], [0.075, 100], [0.25, 0]], // below the 6h high
  waking: [[0, 0], [0.01, 100], [0.035, 100], [0.12, 0]],    // last hour's range
  repeatLo: 1.0, repeatHi: 2.0,                              // buys per buyer
  holdersLo: 100, holdersHi: 20000,                          // holders, log
  ageLoHours: 6, ageHiHours: 720,                            // pool age, log
});

/**
 * The safety gates' threshold: MIN LIQUIDITY ($). SELLABLE and TAX IN RANGE
 * are the contract checks' own verdicts (calculations/asset-detail.js deriveIntel).
 */
export const SAFETY_RULES = Object.freeze({ minLiquidity: 20000 });

export const PHASES = Object.freeze(['QUIET', 'WAKING', 'RUNNING', 'PEAKING', 'FADING']);
export const SIGNALS = Object.freeze(['BUY', 'SELL', 'SHORT', 'AVOID', 'WATCH']);

/**
 * PHASE & SIGNAL thresholds, each a PARAMETERS box. buyMinEarly: inside
 * WAKING, EARLY changed little until the top; >= 85 kept 53% wins and +3.1%
 * over 24h while showing BUY on 16% of moments instead of 26%.
 */
export const PHASE_RULES = Object.freeze({
  runPct: 30, fadeOffHighPct: 10, runningPct: 5, quietRangePct: 1,
  smartExitSellers: 2, buyMinEarly: 85,
  // THE HOLD RULE. A call is not dropped the moment its input dips under the
  // line it crossed: BUY holds while the token is still WAKING, safe, and
  // EARLY stays at or over buyHoldEarly; SELL / SHORT hold while it is still
  // RUNNING (it pulled back under RAN but has not fallen back to WAKING).
  // Without it a token on the line flipped BUY / WATCH every few minutes.
  // A BUY also holds through a QUIET spell (the tape paused, nothing broke)
  // for up to buyQuietHoldMin after its last real BUY: most BUYs that ended
  // in the archive ended exactly that way.
  buyHoldEarly: 80, buyQuietHoldMin: 60, holdMemoryMin: 20,
});

/**
 * The TRADE PLAN's 24h frame (the backtest's SWING trade): take profit at
 * targetPct, stop at stopPct, close after horizonHours.
 */
export const PLAN_RULES = Object.freeze({ targetPct: 20, stopPct: 15, horizonHours: 24 });
/**
 * TIME FRAMES - how long a call is held. Each frame sizes its own target and
 * stop: a 1h trade does not get a 20% target. The holding-window grading
 * (npm run backtest, holds) showed the window matters more than the engine:
 * the wallet engines' entries paid over 2-6h and gave it back by 12h, the
 * flow and volume engines kept paying to 12-24h, and shorts paid up to 12h.
 */
export const TIME_FRAMES = Object.freeze([
  { hours: 1, targetPct: 4, stopPct: 3 },
  { hours: 2, targetPct: 6, stopPct: 4 },
  { hours: 6, targetPct: 10, stopPct: 7 },
  { hours: 12, targetPct: 15, stopPct: 10 },
  { hours: 24, targetPct: 20, stopPct: 15 },
]);
/**
 * AUTO's window, the same for every engine. Windows picked per engine did not
 * hold up on hours they were not picked on (walk-forward, 2026-10-14): a plain
 * 6h hold beat them for most engines, and every engine paid at 6h. Re-check
 * 24h once a week of history has resolved.
 */
export const DEFAULT_HOLD_HOURS = 6;
/** TRADE SIZES ($) the plan is costed at, and the default. */
export const TRADE_SIZES = Object.freeze([250, 500, 1000, 5000, 10000]);
export const DEFAULT_TRADE_USD = 1000;
/** A BUY needs a round trip at or under this (%) at the trade size. */
export const DEFAULT_MAX_COST_PCT = 2;
const frameFor = (h) => TIME_FRAMES.reduce((best, f) => (Math.abs(f.hours - h) < Math.abs(best.hours - h) ? f : best), TIME_FRAMES[TIME_FRAMES.length - 1]);

/** Piecewise-linear through `points` ([[x, y], ...], x ascending). */
export function band(x, points) {
  if (!fin(x) || !points || !points.length) return null;
  if (x <= points[0][0]) return Math.round(points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (x <= x1) {
      const [x0, y0] = points[i - 1];
      return Math.round(y0 + ((x - x0) / (x1 - x0)) * (y1 - y0));
    }
  }
  return Math.round(points[points.length - 1][1]);
}

/* ------------------------------------------------- measure arithmetic -- */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ratio = (a, b) => (fin(a) && fin(b) && b > 0 ? a / b : null);

/**
 * The price and tape measures, from one pool's sample series (history.json:
 * { t, priceUsd, volume5mUsd, buys5m, buyers5m, liquidityUsd }), as of `now`
 * - only samples at or before it, so a backtest stays point-in-time. Each is
 * null unless its window is covered: a 6-hour low from 20 minutes of samples
 * is not a 6-hour low.
 */
function measuresOf(samples, now) {
  const all = (samples || []).filter((s) => s && fin(s.t) && s.t <= now);
  const o = { aboveLow6h: null, belowHigh6h: null, range1h: null, buysPerBuyer: null, volAccel: null, buyerTrend: null };
  if (all.length < 2) return o;
  const last = all[all.length - 1];
  const within = (ms) => all.filter((s) => s.t > now - ms);
  const prices = (list) => list.map((s) => s.priceUsd).filter((p) => fin(p) && p > 0);
  const p0 = fin(last.priceUsd) && last.priceUsd > 0 ? last.priceUsd : null;
  const w6 = within(6 * HOUR); const p6 = prices(w6);
  if (p0 && p6.length >= 10 && last.t - w6[0].t >= HOUR) {
    o.aboveLow6h = p0 / Math.min(...p6) - 1;
    o.belowHigh6h = p0 / Math.max(...p6) - 1;
  }
  const w1 = within(HOUR); const p1 = prices(w1);
  if (p1.length >= 10 && last.t - w1[0].t >= 30 * MIN) {
    const lo = Math.min(...p1);
    o.range1h = (Math.max(...p1) - lo) / lo;
  }
  const w15 = within(15 * MIN);
  o.buysPerBuyer = ratio(mean(w15.map((s) => s.buys5m).filter(fin)), mean(w15.map((s) => s.buyers5m).filter((x) => fin(x) && x > 0)));
  const vol = (list) => mean(list.map((s) => s.volume5mUsd).filter(fin));
  const byr = (list) => mean(list.map((s) => s.buyers5m).filter(fin));
  if (w1.length >= 10 && last.t - w1[0].t >= 30 * MIN) o.volAccel = ratio(vol(w15), vol(w1));
  if (w6.length >= 20 && last.t - w6[0].t >= 2 * HOUR) o.buyerTrend = ratio(byr(w1), byr(w6));
  return o;
}

/**
 * Smart wallets in this pool's tape over the last hour (or the part of it the
 * tape covers, down to a quarter): distinct buyers and sellers on the learned
 * list (/raw/smart-wallets.json). Null when it cannot say.
 */
function smartFlowOf(trades, smartSet, now) {
  if (!smartSet || !Array.isArray(trades) || !trades.length) return { buyers: null, sellers: null };
  const oldest = trades.reduce((m, x) => (fin(x.at) && x.at < m ? x.at : m), Infinity);
  if (!(oldest <= now - HOUR * 0.25)) return { buyers: null, sellers: null };
  const b = new Set(); const s = new Set();
  trades.forEach((x) => {
    if (!x || !fin(x.at) || x.at <= now - HOUR || x.at > now) return;
    const w = String(x.wallet).toLowerCase();
    if (!smartSet.has(w)) return;
    if (x.kind === 'buy') b.add(w); else if (x.kind === 'sell') s.add(w);
  });
  return { buyers: b.size, sellers: s.size };
}

/* =========================================================== the nodes === */

const NODES = [];
/** A value on the wire, and a note beside it for the panels. */
const out = (value, note) => ({ __out: true, value, note });
/** node(label, wire type, inputs, run). run(inputs, ctx, notes) returns the value or out(value, note). */
const node = (label, type, deps, run) => NODES.push({ id: P(label), label, type, deps: deps.map(P), run });
const get = (inp, label) => inp[P(label)];

// --- EXTRACT: readings picked out of the token's raw files ------------------
const row = (ctx) => ctx.row || {};
node('PRICE', 'number', [], (i, c) => num(row(c).priceUsd));
node('LIQUIDITY', 'number', [], (i, c) => num(row(c).liquidityUsd));
node('PRICE, 2 SOURCES', 'dict', [], (i, c) => row(c).crossSource || null);
node('POOL AGE', 'number', [], (i, c) => num(row(c).poolAgeHours));
node('VOLUME / LIQUIDITY', 'number', [], (i, c) => num(row(c).volumeToLiquidity24h));
node('JUPITER STATS', 'dict', [], (i, c) => c.jupiter || row(c).jupiter || null);
node('POOL SAMPLES', 'list', [], (i, c) => c.samples || []);
node('TRADE SAMPLE', 'dict', [], (i, c) => c.own || null);
node('$10K ROUTE QUOTE', 'dict', [], (i, c) => (c.intel && c.intel.impact) || null);
node('HOLDERS', 'dict', [], (i, c) => (c.intel && c.intel.holders) || null);
node('TOP HOLDERS SHARE', 'number', [], (i, c) => (c.intel && c.intel.holders ? num(c.intel.holders.topHolderSharePct) : null));
node('CONTRACT CHECKS', 'dict', [], (i, c) => (c.intel && c.intel.contractSafety) || null);
node('LP / CREATOR / INSIDERS', 'dict', [], (i, c) => (c.intel && c.intel.contractSafety) || null);
node('PERP VENUES', 'dict', [], (i, c) => (c.listing && c.listing.perp) || null);
node('ETHOS (PROJECT X)', 'dict', [], (i, c) => c.ethos || null);
node('SMART LIST', 'number', [], (i, c) => (c.smartWallets ? c.smartWallets.size : null));

// --- MEASURES ----------------------------------------------------------------
const measures = (c) => { if (!c.memo.m) c.memo.m = measuresOf(c.samples || [], c.now); return c.memo.m; };
const pct = (x) => (fin(x) ? x * 100 : null);   // full precision on the wire; the map rounds for display
node('ABOVE 6H LOW', 'number', ['POOL SAMPLES'], (i, c) => pct(measures(c).aboveLow6h));
node('BELOW 6H HIGH', 'number', ['POOL SAMPLES'], (i, c) => pct(measures(c).belowHigh6h));
node('RANGE 1H', 'number', ['POOL SAMPLES'], (i, c) => pct(measures(c).range1h));
node('BUYS PER BUYER', 'number', ['POOL SAMPLES'], (i, c) => num(measures(c).buysPerBuyer));
node('VOLUME 15M vs 1H', 'number', ['POOL SAMPLES'], (i, c) => num(measures(c).volAccel));
node('BUYERS 1H vs 6H', 'number', ['POOL SAMPLES'], (i, c) => num(measures(c).buyerTrend));
// A live token with 0 holders is a provider that failed to count (RugCheck
// answers 0), not a fact - so only a positive count is taken.
node('HOLDER COUNT', 'number', ['HOLDERS', 'JUPITER STATS'], (i) => {
  const pos = (x) => { const n = Number(x); return fin(n) && n > 0 ? n : null; };
  const h = get(i, 'HOLDERS') || {}; const jup = get(i, 'JUPITER STATS');
  if (pos(h.count)) return out(pos(h.count), 'intel holder count');
  if (pos(h.jupiterCount)) return out(pos(h.jupiterCount), 'intel Jupiter count');
  if (jup && pos(jup.holderCount)) return out(pos(jup.holderCount), 'Jupiter holderCount');
  return null;
});
node('NET FLOW RATIO', 'number', ['TRADE SAMPLE'], (i) => {
  const o = get(i, 'TRADE SAMPLE'); const s = o && o.stats;
  return s && s.netRatio !== null && s.netRatio !== undefined ? out(s.netRatio, s) : null;
});
node('TOP-5 WALLET SHARE', 'number', ['TRADE SAMPLE'], (i) => {
  const o = get(i, 'TRADE SAMPLE');
  return o && o.stats ? num(o.stats.top5SharePct) : null;
});
node('PRICE IMPACT $10K', 'number', ['$10K ROUTE QUOTE'], (i) => {
  const q = get(i, '$10K ROUTE QUOTE');
  return q && fin(q.priceImpactPct) ? out(q.priceImpactPct, { tradeUsd: q.tradeUsd }) : null;
});
/**
 * EXECUTION COST - what a round trip (in and out) costs at the chosen trade
 * size, in %. From the token's real $10K route quote when we have one (impact
 * scales with size), else from pool depth: on a constant-product pool a buy of
 * S moves the price by about S / (liquidity / 2); real quotes came in at about
 * half that under $2M liquidity (routes split across pools) and matched it
 * above (113 tokens, 2026-10-14). Plus swap fees both ways.
 */
export const EXECUTION = Object.freeze({ feeRoundTripPct: 0.6, thinCalibration: 0.55, deepFromUsd: 2e6, quoteUsd: 10000 });
export function roundTripCostPct(liquidityUsd, tradeUsd, quoteImpactPct) {
  if (!fin(tradeUsd) || tradeUsd <= 0) return null;
  let oneWay = null;
  if (fin(quoteImpactPct) && quoteImpactPct >= 0) oneWay = quoteImpactPct * (tradeUsd / EXECUTION.quoteUsd);
  else if (fin(liquidityUsd) && liquidityUsd > 0) {
    const k = liquidityUsd < EXECUTION.deepFromUsd ? EXECUTION.thinCalibration : 1;
    oneWay = 100 * k * tradeUsd / (liquidityUsd / 2);
  }
  return oneWay === null ? null : 2 * oneWay + EXECUTION.feeRoundTripPct;
}
node('EXECUTION COST', 'number', ['LIQUIDITY', 'PRICE IMPACT $10K'], (i) => {
  const size = tradePlanRules().tradeUsd;
  const q = get(i, 'PRICE IMPACT $10K'); const liq = get(i, 'LIQUIDITY');
  const x = roundTripCostPct(liq, size, q);
  return x === null ? null : out(x, { tradeUsd: size, basis: fin(q) ? 'quote' : 'depth estimate' });
});
node('WALLET SAMPLE', 'dict', ['TRADE SAMPLE'], (i, c) => c.walletIntel || null);
node('SURVIVAL', 'number', ['POOL AGE'], (i) => { const h = get(i, 'POOL AGE'); return fin(h) ? h / 24 : null; });
node('PROJECT REPUTATION', 'number', ['ETHOS (PROJECT X)'], (i) => {
  const e = get(i, 'ETHOS (PROJECT X)');
  return e ? out(num(e.score), e) : null;
});
const smart = (c) => { if (!c.memo.smart) c.memo.smart = smartFlowOf(c.own ? c.own.trades : null, c.smartWallets, c.now); return c.memo.smart; };
node('SMART BUYERS 1H', 'number', ['TRADE SAMPLE', 'SMART LIST'], (i, c) => num(smart(c).buyers));
node('SMART SELLERS 1H', 'number', ['TRADE SAMPLE', 'SMART LIST'], (i, c) => num(smart(c).sellers));
node('PERP LISTED', 'bool', ['PERP VENUES'], (i) => {
  const perp = get(i, 'PERP VENUES');
  if (perp && perp.listedOn.length) return out(true, perp.listedOn.map((k) => perp.labels[k] || k).join(', '));
  if (perp && perp.checked > 0) return out(false, 'no perp on the ' + perp.checked + ' venues that answered');
  return null;
});

// --- WALLETS & FLOW: read for the panels, not inputs to the call -------------
node('Wallet quality', 'number', ['TOP HOLDERS SHARE', 'WALLET SAMPLE', 'LP / CREATOR / INSIDERS', 'JUPITER STATS'], (i) => {
  const providerTop = get(i, 'TOP HOLDERS SHARE'); const wallet = get(i, 'WALLET SAMPLE');
  const cs = get(i, 'LP / CREATOR / INSIDERS') || {}; const jup = get(i, 'JUPITER STATS');
  const jupTop = jup && jup.audit ? toNumber(jup.audit.topHoldersPercentage) : null;
  const walletTop = wallet && wallet.holderSharePct !== null && wallet.holderSharePct !== undefined ? wallet.holderSharePct : null;
  const topHolderSharePct = walletTop !== null ? walletTop : (providerTop !== null ? providerTop : jupTop);
  const holderSource = walletTop !== null ? 'GoPlus, pool excluded'
    : (providerTop !== null ? 'GoPlus' : (jupTop !== null ? 'Jupiter audit' : null));
  const quality = walletQualityScore(wallet, {
    topHolderSharePct, holderSource,
    insidersDetected: cs.insidersDetected, creatorOtherTokens: cs.creatorOtherTokens, lpLockedPct: cs.lpLockedPct,
  });
  const facts = { topHolderSharePct, topHolderShareSource: holderSource };
  // An unmeasured quality still carries its parts, for the WALLETS panel.
  if (quality.score === null) return out(null, { facts, detail: quality });
  return out(quality.score, { facts, detail: quality, text: quality.note });
});
node('Organic flow', 'number', ['WALLET SAMPLE', 'JUPITER STATS'], (i) => {
  const wallet = get(i, 'WALLET SAMPLE'); const jup = get(i, 'JUPITER STATS');
  const organic = organicFlowScore(wallet, {
    jupiterScore: jup ? jup.organicScore : null, jupiterLabel: jup ? jup.organicScoreLabel : null,
    sampledAt: wallet ? wallet.sampledAt : null,
  });
  if (organic.score === null) return out(null, { detail: organic });
  return out(organic.score, { basis: organic.basis, detail: organic, evidence: organic.note });
});
node('Contract safety', 'number', ['CONTRACT CHECKS'], (i) => {
  const cs = get(i, 'CONTRACT CHECKS');
  if (!cs || !cs.available) return null;
  const passed = (cs.checks || []).filter((x) => x.ok).length;
  const total = (cs.checks || []).length || 1;
  return out(Math.round((passed / total) * 100), passed + '/' + total + ' checks pass' +
    (cs.rugcheckRisks && cs.rugcheckRisks.length ? ', ' + cs.rugcheckRisks.length + ' RugCheck risks' : ''));
});

// --- SAFETY: hard pass/fail, a bool each (1 = pass), then VETO LOG ------------
// A gate fails only on EVIDENCE. Missing data is "not checked", never a veto -
// otherwise every token the intel collector has not reached would be vetoed
// for being new rather than for being bad.
const checkOf = (cs, re) => {
  if (!cs || !cs.available) return null;
  const x = (cs.checks || []).find((k) => re.test(k.label || ''));
  return x ? { ok: Boolean(x.ok), detail: x.detail || x.label } : null;
};
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
export const GATES = Object.freeze([
  { key: 'sellable', label: 'SELLABLE', deps: ['CONTRACT CHECKS'],
    test: (i) => checkOf(get(i, 'CONTRACT CHECKS'), /honeypot|sell/i) },
  { key: 'tax', label: 'TAX IN RANGE', deps: ['CONTRACT CHECKS'],
    test: (i) => checkOf(get(i, 'CONTRACT CHECKS'), /tax/i) },
  { key: 'liquidity', label: 'LIQUIDITY FLOOR', deps: ['LIQUIDITY'],
    test: (i) => {
      const liq = get(i, 'LIQUIDITY'); const floor = safetyRules(SAFETY_RULES).minLiquidity;
      return fin(liq) ? { ok: liq >= floor, detail: usd(liq) + ' ≥ ' + usd(floor) + ' ? ' + (liq >= floor ? 'yes' : 'no') } : null;
    } },
]);
GATES.forEach((g) => node(g.label, 'bool', g.deps, (i) => {
  let r = null;
  try { r = g.test(i); } catch (e) { r = null; }
  return r ? out(Boolean(r.ok), r.detail) : out(null, 'not checked yet');
}));
node('VETO LOG', 'bool', GATES.map((g) => g.label), (i, c, note) => {
  const checks = GATES.map((g) => {
    const ok = get(i, g.label);
    return { key: g.key, label: g.label, ok: ok === null || ok === undefined ? null : ok, detail: note(g.label) || 'not checked yet' };
  });
  const vetoes = checks.filter((x) => x.ok === false);
  return out(vetoes.length > 0, { checks, vetoed: vetoes.length > 0, vetoes, unchecked: checks.filter((x) => x.ok === null).map((x) => x.label) });
});

// --- WARNINGS: what to know before acting. They inform; they do not score. ---
node('RISK FLAGS', 'list', ['POOL AGE', 'PRICE, 2 SOURCES', 'LIQUIDITY', 'VOLUME / LIQUIDITY', 'TOP-5 WALLET SHARE',
  'Contract safety', 'Organic flow', 'PROJECT REPUTATION'], (i, c, note) => {
  const flags = [];
  // `penalty` is the flag's severity in points - the alerts weigh risk by it.
  const add = (severity, code, detail, penalty) => flags.push({ severity, code, detail, penalty });
  const age = get(i, 'POOL AGE');
  if (fin(age)) {
    if (age < 2) add('HIGH', 'NEW_POOL', 'Pool is under 2 hours old', 4);
    else if (age < 24) add('MED', 'NEW_POOL', 'Pool is under 24 hours old', 2);
  }
  const cs = get(i, 'PRICE, 2 SOURCES');
  if (!cs || cs.sourcesAgreeing < 2) add('MED', 'SINGLE_SOURCE', 'Only one provider priced this pool', 3);
  const liq = get(i, 'LIQUIDITY');
  if (fin(liq) && liq < 50000) add('HIGH', 'THIN_LIQUIDITY', 'Liquidity under $50K', 4);
  const turnover = get(i, 'VOLUME / LIQUIDITY');
  if (fin(turnover) && turnover > 20) add('MED', 'EXTREME_TURNOVER', '24h volume is ' + turnover.toFixed(0) + 'x liquidity', 3);
  const top5 = get(i, 'TOP-5 WALLET SHARE');
  if (fin(top5) && top5 > 70) add('HIGH', 'VOLUME_CONCENTRATED', 'Top 5 wallets are ' + top5 + '% of traded volume', 4);
  const safety = get(i, 'Contract safety');
  if (fin(safety) && safety < 100) add(safety < 70 ? 'HIGH' : 'MED', 'CONTRACT_CHECKS', note('Contract safety'), safety < 70 ? 6 : 3);
  const ethos = note('PROJECT REPUTATION');
  if (ethos && ethos.linked && ethos.isProject && ethos.state === 'flagged') {
    add(ethos.score < 1000 ? 'MED' : 'LOW', 'ETHOS_REPUTATION', '@' + ethos.handle + ' scores ' + ethos.score +
      ' on Ethos (' + ethos.level + '), ' + Math.abs(ethos.delta) + ' below the starting score', 0);
  }
  const organic = get(i, 'Organic flow'); const on = note('Organic flow') || {};
  if (fin(organic) && organic < 40) {
    const borrowed = on.basis === 'jupiter';
    add(borrowed ? 'LOW' : 'MED', 'LOW_ORGANIC_FLOW', on.evidence, borrowed ? 2 : 3);
  }
  const cross = on.detail && on.detail.crossCheck;
  if (cross && cross.diverges) {
    add('LOW', 'ORGANIC_DISAGREEMENT', 'Our sample reads ' + organic + ', Jupiter reads ' + cross.value +
      ' (' + (cross.delta > 0 ? '+' : '') + cross.delta + ')', 0);
  }
  return out(flags.map((f) => f.code), flags);
});

// --- EARLY: the entry score -------------------------------------------------
const EARLY_INPUT = {
  earlyRoom: ['ABOVE 6H LOW'], earlyHolding: ['BELOW 6H HIGH'], earlyWaking: ['RANGE 1H'],
  earlySeasoning: ['POOL AGE'], earlyHolders: ['HOLDER COUNT'],
  earlyInterest: ['VOLUME 15M vs 1H', 'BUYERS 1H vs 6H'], earlyRepeat: ['BUYS PER BUYER'],
};
const EARLY_RUN = {
  earlyRoom: (i) => { const x = get(i, 'ABOVE 6H LOW'); return fin(x) ? band(Math.max(0, x) / 100, EARLY_CURVES.room) : null; },
  earlyHolding: (i) => { const x = get(i, 'BELOW 6H HIGH'); return fin(x) ? band(Math.abs(Math.min(0, x)) / 100, EARLY_CURVES.holding) : null; },
  earlyWaking: (i) => { const x = get(i, 'RANGE 1H'); return fin(x) ? band(x / 100, EARLY_CURVES.waking) : null; },
  earlySeasoning: (i) => { const h = get(i, 'POOL AGE'); return fin(h) && h > 0 ? logScore(Math.max(h, 1), EARLY_CURVES.ageLoHours, EARLY_CURVES.ageHiHours) : null; },
  earlyHolders: (i) => logScore(get(i, 'HOLDER COUNT'), EARLY_CURVES.holdersLo, EARLY_CURVES.holdersHi),
  earlyInterest: (i) => {
    const a = multipleScore(get(i, 'VOLUME 15M vs 1H')); const t = multipleScore(get(i, 'BUYERS 1H vs 6H'));
    return a !== null && t !== null ? Math.round((a + t) / 2) : (a !== null ? a : t);
  },
  earlyRepeat: (i) => { const b = get(i, 'BUYS PER BUYER'); return fin(b) ? to100((b - EARLY_CURVES.repeatLo) / (EARLY_CURVES.repeatHi - EARLY_CURVES.repeatLo)) : null; },
};
EARLY_MODEL.forEach((m) => node(m.label, 'number', EARLY_INPUT[m.key], (i) => EARLY_RUN[m.key](i)));
node('EARLY RAW', 'number', EARLY_MODEL.map((m) => m.label), (i) => {
  let weighted = 0; let used = 0; let present = 0;
  const breakdown = EARLY_MODEL.map((m) => {
    const value = get(i, m.label); const weight = weightOf(m); const ok = fin(value);
    if (ok) { weighted += value * weight; used += weight; present += 1; }
    return { key: m.key, label: m.label, weight, value: ok ? value : null, pending: !ok };
  });
  if (present < EARLY_MIN_PARTS || !used) return out(null, { used, present, breakdown });
  // WHAT MOVES EARLY: each input's pull on it, in points. They sum to EARLY RAW − 50.
  breakdown.forEach((b) => { b.points = b.pending ? null : ((b.value - 50) * b.weight) / used; });
  return out(Math.round(weighted / used), { used, present, breakdown });
});
node('EARLY SCORE', 'number', ['EARLY RAW', 'VETO LOG'], (i) => {
  const raw = get(i, 'EARLY RAW'); const vetoed = get(i, 'VETO LOG');
  if (!fin(raw)) return null;
  return vetoed === true ? 0 : raw;
});

// --- PHASE & SIGNAL ------------------------------------------------------------
node('PHASE', 'text', ['ABOVE 6H LOW', 'BELOW 6H HIGH', 'RANGE 1H', 'SMART SELLERS 1H'], (i) => {
  const r = phaseRules(PHASE_RULES);
  const up = get(i, 'ABOVE 6H LOW'); const off = get(i, 'BELOW 6H HIGH'); const range = get(i, 'RANGE 1H');
  const sellers = fin(get(i, 'SMART SELLERS 1H')) ? get(i, 'SMART SELLERS 1H') : 0;
  if (!fin(up) || !fin(off)) return out(null, 'needs an hour of price history');
  if (up >= r.runPct) {
    return off <= -r.fadeOffHighPct
      ? out('FADING', 'up ' + up.toFixed(0) + '% on its 6h low but already ' + Math.abs(off).toFixed(0) + '% off the high')
      : out('PEAKING', 'up ' + up.toFixed(0) + '% on its 6h low and ' + Math.abs(off).toFixed(1) + '% from the high');
  }
  if (up >= r.runningPct && sellers >= r.smartExitSellers) return out('PEAKING', sellers + ' smart wallets selling after a ' + up.toFixed(0) + '% move');
  if (up >= r.runningPct) return out('RUNNING', 'up ' + up.toFixed(0) + '% on its 6h low - the move is under way');
  if (fin(range) && range < r.quietRangePct) return out('QUIET', 'last hour moved ' + range.toFixed(2) + '% - nothing is trading');
  return out('WAKING', 'moving, but only ' + up.toFixed(1) + '% off its 6h low');
});
// --- ENGINES: six ways to call an entry ---------------------------------------
// Every engine scores the token 0-100 its own way and turns that into a call.
// They share the attention cycle: PEAKING is SELL (SHORT when a perp lists
// it), FADING is AVOID, whichever engine is asking - getting out at the peak
// is not a matter of taste. What differs is the ENTRY: which evidence says
// "buy now", and how strong it must be. The active profile (top right of the
// admin map) picks the engine whose call becomes SIGNAL; every engine is
// computed on every token, so the backtest and the trail grade all six.

/**
 * ROTATION: capital moving between tokens. A wallet that sold another token in
 * the last ROTATION_WINDOW and bought this one in the last hour rotated IN; a
 * wallet that sold this one and bought another rotated OUT. Read from every
 * pool's sampled tape (walletSets), indexed by wallet once per tape.
 */
const ROTATION_WINDOW = 2 * HOUR;
const tapeIndexes = new WeakMap();
function walletTapeOf(walletSets) {
  if (!walletSets || typeof walletSets.forEach !== 'function') return null;
  if (tapeIndexes.has(walletSets)) return tapeIndexes.get(walletSets);
  const byWallet = new Map();
  walletSets.forEach((set, pool) => ((set && set.trades) || []).forEach((x) => {
    if (!x || !x.wallet || !fin(x.at)) return;
    const w = String(x.wallet).toLowerCase();
    if (!byWallet.has(w)) byWallet.set(w, []);
    byWallet.get(w).push({ pool, kind: x.kind, usd: x.usd, at: x.at });
  }));
  const tape = { size: byWallet.size, tradesOf: (w) => byWallet.get(w) || [] };
  tapeIndexes.set(walletSets, tape);
  return tape;
}
function rotationOf(own, tape, pool, now) {
  const trades = own && own.trades;
  if (!tape || !Array.isArray(trades) || !trades.length) return null;
  const oldest = trades.reduce((m, x) => (fin(x.at) && x.at < m ? x.at : m), Infinity);
  if (!(oldest <= now - HOUR * 0.25)) return null;
  const inW = new Map(); const outW = new Map();
  trades.forEach((x) => {
    if (!x || !fin(x.at) || x.at <= now - HOUR || x.at > now || !x.wallet) return;
    const w = String(x.wallet).toLowerCase();
    const other = (kind) => tape.tradesOf(w).some((y) => y.pool !== pool && y.kind === kind && y.at > now - ROTATION_WINDOW && y.at <= now);
    const usdOf = fin(Number(x.usd)) ? Number(x.usd) : 0;
    if (x.kind === 'buy' && other('sell')) inW.set(w, (inW.get(w) || 0) + usdOf);
    else if (x.kind === 'sell' && other('buy')) outW.set(w, (outW.get(w) || 0) + usdOf);
  });
  const sum = (m) => Array.from(m.values()).reduce((a, b) => a + b, 0);
  return { inWallets: inW.size, outWallets: outW.size, inUsd: sum(inW), outUsd: sum(outW) };
}
node('WALLET TAPE', 'number', [], (i, c) => (c.walletTape ? c.walletTape.size : null));
const rotation = (c) => {
  if (!('rot' in c.memo)) c.memo.rot = rotationOf(c.own, c.walletTape, row(c).poolAddress, c.now);
  return c.memo.rot;
};
node('ROTATING IN 1H', 'number', ['TRADE SAMPLE', 'WALLET TAPE'], (i, c) => { const r = rotation(c); return r ? out(r.inWallets, r) : null; });
node('ROTATING OUT 1H', 'number', ['TRADE SAMPLE', 'WALLET TAPE'], (i, c) => { const r = rotation(c); return r ? num(r.outWallets) : null; });
node('ROTATION NET USD', 'number', ['TRADE SAMPLE', 'WALLET TAPE'], (i, c) => { const r = rotation(c); return r ? r.inUsd - r.outUsd : null; });

/**
 * MARKET ROTATION - the MARKET ROTATION tab's read of this pool: over the last
 * 2h, for every wallet active here and in another pool, net buying here
 * against net selling there is capital ARRIVING, the reverse capital LEAVING
 * (min of the two sides, as rotationGraph). On its own it did not predict
 * (archive, 2026-10-14); as a veto it did - rotation-engine BUYs while capital
 * was leaving lost -1.1% vs the market over 6h.
 */
const MARKET_WINDOW = 2 * HOUR;
function marketRotationOf(own, tape, pool, now) {
  const trades = own && own.trades;
  if (!tape || !Array.isArray(trades)) return null;
  const here = new Map();
  let n = 0;
  trades.forEach((x) => {
    if (!x || !fin(x.at) || x.at <= now - MARKET_WINDOW || x.at > now || !x.wallet) return;
    const w = String(x.wallet).toLowerCase(); const u = fin(Number(x.usd)) ? Number(x.usd) : 0;
    here.set(w, (here.get(w) || 0) + (x.kind === 'buy' ? u : -u)); n += 1;
  });
  if (n < 3) return null;
  let inUsd = 0; let outUsd = 0; const pools = new Set();
  here.forEach((netHere, w) => {
    const there = new Map();
    tape.tradesOf(w).forEach((y) => {
      if (y.pool === pool || !fin(y.at) || y.at <= now - MARKET_WINDOW || y.at > now) return;
      const u = fin(Number(y.usd)) ? Number(y.usd) : 0;
      there.set(y.pool, (there.get(y.pool) || 0) + (y.kind === 'buy' ? u : -u));
    });
    there.forEach((netThere, p) => {
      pools.add(p);
      if (netHere > 0 && netThere < 0) inUsd += Math.min(netHere, -netThere);
      else if (netHere < 0 && netThere > 0) outUsd += Math.min(-netHere, netThere);
    });
  });
  return { inUsd, outUsd, net: inUsd - outUsd, connected: pools.size };
}
const market = (c) => {
  if (!('mkt' in c.memo)) c.memo.mkt = marketRotationOf(c.own, c.walletTape, row(c).poolAddress, c.now);
  return c.memo.mkt;
};
node('MARKET NET FLOW 2H', 'number', ['TRADE SAMPLE', 'WALLET TAPE'], (i, c) => {
  const m = market(c);
  return m ? out(m.net, usd(m.inUsd) + ' arrived from, ' + usd(m.outUsd) + ' left for ' + m.connected + ' other pool' + (m.connected === 1 ? '' : 's')) : null;
});
node('CONNECTED POOLS 2H', 'number', ['TRADE SAMPLE', 'WALLET TAPE'], (i, c) => { const m = market(c); return m ? m.connected : null; });

/**
 * The engines, in the order the profile list shows them. `buy` / `hold` are
 * each engine's lines on its own score (ENGINE_RULES); CYCLE's are PHASE_RULES'
 * buyMinEarly / buyHoldEarly, so CYCLE is the model as it was before engines.
 */
export const ENGINES = Object.freeze([
  { key: 'cycle', label: 'CYCLE', score: 'EARLY SCORE', call: 'CYCLE CALL',
    blurb: 'Attention cycle: buys a WAKING token with room to run (EARLY).',
    chain: ['POOL SAMPLES · POOL AGE · HOLDERS', '7 EARLY INPUTS', 'EARLY RAW', 'EARLY SCORE', 'CYCLE CALL'] },
  { key: 'momentum', label: 'MOMENTUM', score: 'MOMENTUM SCORE', call: 'MOMENTUM CALL',
    blurb: 'Volume: buys when the last 15 min trade well above the hour and buyers grow.',
    chain: ['POOL SAMPLES', 'VOLUME 15M vs 1H · BUYERS 1H vs 6H', 'MOMENTUM SCORE', 'MOMENTUM CALL'] },
  { key: 'smart', label: 'SMART MONEY', score: 'SMART SCORE', call: 'SMART CALL',
    blurb: 'Learned smart wallets buying, net of the ones selling.',
    chain: ['TRADE SAMPLE · SMART LIST', 'SMART BUYERS / SELLERS 1H', 'SMART SCORE', 'SMART CALL'] },
  { key: 'flow', label: 'ORDER FLOW', score: 'ORDER FLOW SCORE', call: 'ORDER FLOW CALL',
    blurb: 'Net buying in the tape, discounted for wash and inorganic flow.',
    chain: ['TRADE SAMPLE · WALLET SAMPLE · JUPITER', 'NET FLOW · BUYS PER BUYER · ORGANIC', 'ORDER FLOW SCORE', 'ORDER FLOW CALL'] },
  { key: 'rotation', label: 'ROTATION', score: 'ROTATION SCORE', call: 'ROTATION CALL',
    blurb: 'Wallet rotation: wallets selling other tokens to buy this one.',
    chain: ['EVERY POOL\'S TRADES', 'WALLET TAPE', 'ROTATING IN / OUT · NET USD', 'ROTATION SCORE', 'ROTATION CALL'] },
  { key: 'blend', label: 'BLEND', score: 'BLEND SCORE', call: 'BLEND CALL',
    blurb: 'Votes: a BUY when two or more engines clear their own BUY line.',
    chain: ['FIVE ENGINE SCORES', 'VOTES OVER EACH BUY LINE', 'BLEND SCORE', 'BLEND CALL'] },
  // Built on the evaluation (npm run backtest): ROTATION paid best; a BUY
  // another engine agreed with paid, one on its own did not; and ROTATION's
  // entries paid on $200k-1M pools, not on the thinnest or the deepest.
  { key: 'rotconf', label: 'ROTATION+', score: 'ROTATION+ SCORE', call: 'ROTATION+ CALL',
    blurb: 'Rotation, confirmed: ROTATION over its line and at least one other engine over its own.',
    chain: ['ROTATION SCORE', 'ANY OTHER ENGINE OVER ITS LINE', 'ROTATION+ SCORE', 'ROTATION+ CALL'] },
  { key: 'consensus', label: 'CONSENSUS', score: 'CONSENSUS SCORE', call: 'CONSENSUS CALL',
    blurb: 'Two of the three best engines (ROTATION, SMART MONEY, MOMENTUM) over their own lines.',
    chain: ['ROTATION · SMART · MOMENTUM SCORES', 'TWO OF THREE OVER THEIR LINES', 'CONSENSUS SCORE', 'CONSENSUS CALL'] },
  { key: 'rotliq', label: 'ROTATION MID-LIQ', score: 'ROTATION MID-LIQ SCORE', call: 'ROTATION MID-LIQ CALL',
    blurb: 'Rotation, only on pools with mid liquidity (the band where it paid).',
    chain: ['ROTATION SCORE · LIQUIDITY', 'LIQUIDITY BAND', 'ROTATION MID-LIQ SCORE', 'ROTATION MID-LIQ CALL'] },
  { key: 'smartrot', label: 'SMART ROTATION', score: 'SMART ROTATION SCORE', call: 'SMART ROTATION CALL',
    blurb: 'Rotation with at least one learned smart wallet among this hour\'s buyers.',
    chain: ['ROTATION SCORE · SMART BUYERS 1H', 'BOTH PRESENT', 'SMART ROTATION SCORE', 'SMART ROTATION CALL'] },
  { key: 'quality', label: 'QUALITY ROTATION', score: 'QUALITY ROTATION SCORE', call: 'QUALITY ROTATION CALL',
    blurb: 'All three findings at once: rotation, confirmed by another engine, on a mid-liquidity pool.',
    chain: ['ROTATION+ SCORE · LIQUIDITY', 'LIQUIDITY BAND', 'QUALITY ROTATION SCORE', 'QUALITY ROTATION CALL'] },
  { key: 'tide', label: 'TIDE', score: 'TIDE SCORE', call: 'TIDE CALL',
    blurb: 'Rotation with the market tide: wallets rotating in, smart wallets or volume agreeing, and capital not leaving the pool for other pools.',
    chain: ['ROTATION · SMART · MOMENTUM SCORES · MARKET NET FLOW', 'AGREE + NOT LEAVING', 'TIDE SCORE', 'TIDE CALL'] },
]);
/** The engines that read the market directly; the rest combine their scores. */
const BASE = ['cycle', 'momentum', 'smart', 'flow', 'rotation'];
export const ENGINE_KEYS = ENGINES.map((e) => e.key);
// DEFAULT runs QUALITY ROTATION: the best engine after execution cost on hours
// it was not tuned on (npm run backtest, 2026-10-14). flow/params.js
// activeEngine falls back to the same key.
export const DEFAULT_ENGINE = 'quality';
/** Each engine's BUY and HOLD lines on its own 0-100 score, and how far up a RUNNING token may be bought. */
export const ENGINE_RULES = Object.freeze({
  momentumBuy: 60, momentumHold: 45,
  // SMART and ROTATION: the lines the walk-forward chose on TRAIN hours
  // (npm run backtest, walkForward), both ahead of the board on TEST hours.
  smartBuy: 70, smartHold: 40,
  flowBuy: 60, flowHold: 40,
  rotationBuy: 80, rotationHold: 60,
  blendBuy: 100, blendHold: 50,
  rotconfBuy: 80, rotconfHold: 60,
  consensusBuy: 100, consensusHold: 50,
  rotliqBuy: 80, rotliqHold: 60,
  smartrotBuy: 80, smartrotHold: 60,
  qualityBuy: 80, qualityHold: 60,
  tideBuy: 80, tideHold: 60,
  // TIDE does not buy while this much (net $, 2h) is leaving the pool.
  rotVetoUsd: 200,
  // The liquidity band ROTATION MID-LIQ and QUALITY ROTATION buy in ($).
  liqLow: 200000, liqHigh: 1000000,
  lateUpPct: 12,
});
const linesOf = (key) => {
  if (key === 'cycle') { const r = phaseRules(PHASE_RULES); return { buy: r.buyMinEarly, hold: r.buyHoldEarly }; }
  const e = engineRules(ENGINE_RULES);
  return { buy: e[key + 'Buy'], hold: e[key + 'Hold'] };
};
const clamp100 = (x) => Math.max(0, Math.min(100, Math.round(x)));

node('MOMENTUM SCORE', 'number', ['VOLUME 15M vs 1H', 'BUYERS 1H vs 6H'], (i) => {
  const va = get(i, 'VOLUME 15M vs 1H'); const bt = get(i, 'BUYERS 1H vs 6H');
  if (!fin(va)) return null;
  const v = band(va, [[1, 0], [2.5, 100]]); const b = fin(bt) ? band(bt, [[1, 0], [2, 100]]) : null;
  const s = b === null ? v : 0.6 * v + 0.4 * b;
  return out(clamp100(s), 'volume ' + va.toFixed(2) + '× the hour' + (fin(bt) ? ', buyers ' + bt.toFixed(2) + '× the 6h' : ''));
});
node('SMART SCORE', 'number', ['SMART BUYERS 1H', 'SMART SELLERS 1H'], (i) => {
  const b = get(i, 'SMART BUYERS 1H'); const s = get(i, 'SMART SELLERS 1H');
  if (!fin(b)) return null;
  return out(clamp100(30 * b - 30 * (fin(s) ? s : 0)), b + ' smart buying, ' + (fin(s) ? s : 0) + ' selling');
});
node('ORDER FLOW SCORE', 'number', ['NET FLOW RATIO', 'BUYS PER BUYER', 'Organic flow'], (i) => {
  const nf = get(i, 'NET FLOW RATIO'); const bpb = get(i, 'BUYS PER BUYER'); const org = get(i, 'Organic flow');
  if (!fin(nf)) return null;
  let s = band(nf, [[0, 0], [0.5, 100]]); const why = ['net flow ' + nf.toFixed(2)];
  if (fin(bpb) && bpb > 4) { s *= 0.5; why.push(bpb.toFixed(1) + ' buys per buyer (wash) ×0.5'); }
  if (fin(org) && org < 40) { s *= 0.5; why.push('organic ' + org + ' ×0.5'); }
  return out(clamp100(s), why.join(', '));
});
node('ROTATION SCORE', 'number', ['ROTATING IN 1H', 'ROTATING OUT 1H', 'ROTATION NET USD'], (i) => {
  const a = get(i, 'ROTATING IN 1H'); const o = get(i, 'ROTATING OUT 1H'); const usdNet = get(i, 'ROTATION NET USD');
  if (!fin(a)) return null;
  let s = band(a - (fin(o) ? o : 0), [[0, 0], [4, 100]]);
  if (fin(usdNet) && usdNet < 0) s *= 0.5;
  return out(clamp100(s), a + ' wallets rotated in, ' + (fin(o) ? o : 0) + ' out' + (fin(usdNet) ? ', net ' + usd(usdNet) : ''));
});
const baseEngines = () => ENGINES.filter((e) => BASE.indexOf(e.key) !== -1);
const over = (i, key) => { const e = ENGINES.find((x) => x.key === key); const v = get(i, e.score); return fin(v) && v >= linesOf(key).buy; };
node('BLEND SCORE', 'number', ENGINES.filter((e) => BASE.indexOf(e.key) !== -1).map((e) => e.score), (i) => {
  const voters = baseEngines();
  const present = voters.filter((e) => fin(get(i, e.score)));
  if (present.length < 2) return null;
  const yes = present.filter((e) => get(i, e.score) >= linesOf(e.key).buy);
  return out(clamp100(50 * yes.length), yes.length ? yes.map((e) => e.label).join(' + ') + ' vote BUY' : 'no engine votes BUY');
});
node('ROTATION+ SCORE', 'number', ENGINES.filter((e) => BASE.indexOf(e.key) !== -1).map((e) => e.score), (i) => {
  const rot = get(i, 'ROTATION SCORE');
  if (!fin(rot)) return null;
  const others = baseEngines().filter((e) => e.key !== 'rotation' && over(i, e.key)).map((e) => e.label);
  return out(others.length ? rot : clamp100(rot / 2), others.length ? 'rotation ' + rot + ', confirmed by ' + others.join(' + ') : 'rotation ' + rot + ', no other engine agrees (halved)');
});
node('CONSENSUS SCORE', 'number', ['ROTATION SCORE', 'SMART SCORE', 'MOMENTUM SCORE'], (i) => {
  const three = ['rotation', 'smart', 'momentum'];
  if (!three.some((k) => fin(get(i, ENGINES.find((e) => e.key === k).score)))) return null;
  const yes = three.filter((k) => over(i, k));
  return out(clamp100(50 * yes.length), yes.length ? yes.join(' + ') + ' over their lines' : 'none of the three over its line');
});
const inBand = (liq) => { const r = engineRules(ENGINE_RULES); return fin(liq) && liq >= r.liqLow && liq <= r.liqHigh; };
node('ROTATION MID-LIQ SCORE', 'number', ['ROTATION SCORE', 'LIQUIDITY'], (i) => {
  const rot = get(i, 'ROTATION SCORE'); const liq = get(i, 'LIQUIDITY');
  if (!fin(rot)) return null;
  return out(inBand(liq) ? rot : 0, inBand(liq) ? 'rotation ' + rot + ' on ' + usd(liq) + ' liquidity' : 'liquidity ' + (fin(liq) ? usd(liq) : '?') + ' outside the band');
});
node('SMART ROTATION SCORE', 'number', ['ROTATION SCORE', 'SMART BUYERS 1H'], (i) => {
  const rot = get(i, 'ROTATION SCORE'); const sb = get(i, 'SMART BUYERS 1H');
  if (!fin(rot) || !fin(sb)) return null;
  return out(sb >= 1 ? rot : 0, sb >= 1 ? 'rotation ' + rot + ' with ' + sb + ' smart buyer' + (sb > 1 ? 's' : '') : 'no smart wallet among the buyers');
});
node('QUALITY ROTATION SCORE', 'number', ['ROTATION+ SCORE', 'LIQUIDITY'], (i, c, note) => {
  const rp = get(i, 'ROTATION+ SCORE'); const liq = get(i, 'LIQUIDITY');
  if (!fin(rp)) return null;
  return out(inBand(liq) ? rp : 0, inBand(liq) ? (note('ROTATION+ SCORE') || '') + ', on ' + usd(liq) : 'liquidity ' + (fin(liq) ? usd(liq) : '?') + ' outside the band');
});
node('TIDE SCORE', 'number', ['ROTATION SCORE', 'SMART SCORE', 'MOMENTUM SCORE', 'MARKET NET FLOW 2H'], (i) => {
  const rot = get(i, 'ROTATION SCORE'); const net = get(i, 'MARKET NET FLOW 2H');
  if (!fin(rot)) return null;
  const r = engineRules(ENGINE_RULES);
  if (fin(net) && net < -r.rotVetoUsd) return out(0, usd(-net) + ' net leaving the pool - against the tide');
  const conf = ['smart', 'momentum'].filter((k) => over(i, k)).map((k) => ENGINES.find((e) => e.key === k).label);
  if (conf.length) return out(rot, 'rotation ' + rot + ' with ' + conf.join(' + ') + (fin(net) ? ', market flow ' + (net >= 0 ? '+' : '−') + usd(Math.abs(net)) : ''));
  return out(clamp100(rot / 2), 'rotation ' + rot + ', neither smart wallets nor volume agree (halved)');
});

/**
 * The last call per engine per token, for the hold rule - the one memory in
 * the flow. Forgotten after holdMemoryMin without a fresh call (the token left
 * the board, or the app was closed), and whenever time runs backwards (a
 * backtest replaying a second pool of the same token).
 */
const lastCall = new Map();
export function resetSignalMemory() { lastCall.clear(); }
/** CYCLE buys only WAKING; the others also an early RUNNING (under lateUpPct). */
const inZone = (key, phase, up) => phase === 'WAKING'
  || (key !== 'cycle' && phase === 'RUNNING' && fin(up) && up < engineRules(ENGINE_RULES).lateUpPct);
/** Market rotation (MARKET NET FLOW 2H) is TIDE's alone: no other engine reads it. */
const ROTATION_FAMILY = ['tide'];
/**
 * Why a BUY cannot be taken, or null: the pool cannot absorb the trade size
 * (EXECUTION COST over the cap), or - for TIDE only - capital is net leaving
 * the pool (MARKET NET FLOW 2H under the veto).
 */
function buyBlock(e, i) {
  const cost = get(i, 'EXECUTION COST'); const plan = tradePlanRules();
  if (fin(cost) && cost > plan.maxCostPct) return 'too thin for $' + plan.tradeUsd.toLocaleString('en-US') + ': a round trip costs ' + cost.toFixed(1) + '% (cap ' + plan.maxCostPct + '%)';
  const net = get(i, 'MARKET NET FLOW 2H');
  if (ROTATION_FAMILY.indexOf(e.key) !== -1 && fin(net) && net < -engineRules(ENGINE_RULES).rotVetoUsd) return usd(-net) + ' net leaving the pool for other pools (2h)';
  return null;
}
function engineCall(e, i, c) {
  const r = phaseRules(PHASE_RULES); const L = linesOf(e.key);
  const phase = get(i, 'PHASE'); const score = get(i, e.score); const up = get(i, 'ABOVE 6H LOW');
  const vetoed = get(i, 'VETO LOG') === true; const perp = get(i, 'PERP LISTED'); const sb = get(i, 'SMART BUYERS 1H');
  const name = e.key === 'cycle' ? 'EARLY' : e.label;
  let call;
  if (!phase) call = { s: null, why: 'no phase yet' };
  else if (phase === 'PEAKING') call = perp === true ? { s: 'SHORT', why: 'peaking, and a perp venue lists it' } : { s: 'SELL', why: 'peaking - take profit, do not chase' };
  else if (phase === 'FADING') call = { s: 'AVOID', why: 'the burst is over' };
  else if (inZone(e.key, phase, up)) {
    const where = phase.toLowerCase();
    if (vetoed) call = { s: 'WATCH', why: where + ', but a safety gate failed' };
    else if (!fin(score)) call = { s: 'WATCH', why: where + ', no ' + name + ' score yet' };
    else if (score < L.buy) call = { s: 'WATCH', why: where + ', ' + name + ' ' + score + ' under ' + L.buy };
    else if (buyBlock(e, i)) call = { s: 'WATCH', why: where + ', ' + name + ' ' + score + ' - but ' + buyBlock(e, i) };
    else call = { s: 'BUY', why: where + ', ' + name + ' ' + score + (fin(sb) && sb > 0 ? ', ' + sb + ' smart wallet' + (sb > 1 ? 's' : '') + ' buying' : '') };
  } else call = { s: 'WATCH', why: phase === 'RUNNING' ? 'running - late to buy, early to sell' : 'quiet' };
  // The hold rule (PHASE_RULES): keep the previous call through a dip under its line.
  const key = e.key + '|' + row(c).chain + ':' + (row(c).tokenAddress || row(c).poolAddress);
  const prev = lastCall.get(key);
  const fresh = prev && c.now >= prev.t && c.now - prev.t <= r.holdMemoryMin * 60000;
  let held = false;
  if (fresh && call.s === 'WATCH') {
    if (prev.s === 'BUY' && buyBlock(e, i)) {
      // A gate that closes ends the BUY: nothing is held through it.
    } else if (prev.s === 'BUY' && inZone(e.key, phase, up) && !vetoed && fin(score) && score >= L.hold) {
      call = { s: 'BUY', why: 'holding BUY - still ' + phase.toLowerCase() + ', ' + name + ' ' + score + ' (holds while ≥ ' + L.hold + ')' }; held = true;
    } else if (prev.s === 'BUY' && phase === 'QUIET' && !vetoed && c.now - prev.since <= r.buyQuietHoldMin * 60000) {
      call = { s: 'BUY', why: 'holding BUY - the tape paused, nothing broke (up to ' + r.buyQuietHoldMin + ' min)' }; held = true;
    } else if ((prev.s === 'SELL' || prev.s === 'SHORT') && phase === 'RUNNING') {
      call = { s: prev.s, why: 'holding ' + prev.s + ' - pulled back under the run line but not back to waking' }; held = true;
    }
  }
  // `since` is the last time the call was made on its own merits, not held.
  if (call.s && row(c).chain) lastCall.set(key, { s: call.s, t: c.now, since: held && prev.s === call.s ? prev.since : c.now });
  return out(call.s, call.why);
}
ENGINES.forEach((e) => node(e.call, 'text',
  ['PHASE', e.score, 'ABOVE 6H LOW', 'VETO LOG', 'PERP LISTED', 'SMART BUYERS 1H', 'EXECUTION COST', 'MARKET NET FLOW 2H'], (i, c) => engineCall(e, i, c)));

// SIGNAL: the active profile's engine's call - what the main page shows.
node('SIGNAL', 'text', ENGINES.map((e) => e.call), (i, c, note) => {
  const e = ENGINES.find((x) => x.key === activeEngine()) || ENGINES[0];
  const s = get(i, e.call);
  return s ? out(s, (e.key === 'cycle' ? '' : e.label + ': ') + (note(e.call) || '')) : out(null, note(e.call) || null);
});

// --- TRADE PLAN: the trade the signal is graded on ---------------------------
node('TRADE PLAN', 'dict', ['SIGNAL', 'PRICE', 'EXECUTION COST'], (i, c, note) => {
  const signal = get(i, 'SIGNAL'); const price = get(i, 'PRICE'); const cost = get(i, 'EXECUTION COST');
  if (!fin(price) || !signal || signal === 'WATCH' || signal === 'AVOID') return null;
  const r = tradePlanRules();
  const long = signal === 'BUY';
  return {
    side: long ? 'LONG' : (signal === 'SHORT' ? 'SHORT' : 'EXIT'),
    entry: price,
    target: price * (long ? 1 + r.targetPct / 100 : 1 - r.targetPct / 100),
    stop: price * (long ? 1 - r.stopPct / 100 : 1 + r.stopPct / 100),
    targetPct: r.targetPct, stopPct: r.stopPct, horizonHours: r.horizonHours, frame: r.source,
    tradeUsd: r.tradeUsd, costPct: fin(cost) ? cost : null, costBasis: (note('EXECUTION COST') || {}).basis || null,
  };
});

/**
 * The plan in force: the TIME FRAME the flow sets (param:plan.horizonHours),
 * else AUTO (DEFAULT_HOLD_HOURS); target and stop from that frame unless set
 * on their boxes.
 */
export function tradePlanRules() {
  const set = planSetting('horizonHours');
  const horizonHours = fin(set) && set > 0 ? set : DEFAULT_HOLD_HOURS;
  const f = frameFor(horizonHours);
  const t = planSetting('targetPct'); const st = planSetting('stopPct');
  const size = planSetting('tradeUsd'); const cap = planSetting('maxCostPct');
  return {
    tradeUsd: fin(size) && size > 0 ? size : DEFAULT_TRADE_USD,
    maxCostPct: fin(cap) && cap > 0 ? cap : DEFAULT_MAX_COST_PCT,
    horizonHours, targetPct: fin(t) ? t : f.targetPct, stopPct: fin(st) ? st : f.stopPct,
    source: fin(set) && set > 0 ? 'chosen' : 'auto',
  };
}

export const SCORE_NODES = NODES;
/** Each box's declared wire type, by id (the board's are merged in by the map). */
export const NODE_TYPES = Object.fromEntries(NODES.map((n) => [n.id, n.type]));

/* ----------------------------------------------------------- the runner -- */

/**
 * The map's edits, plugged in by flow/runtime.js. Without them (the backtest,
 * a test) the flow runs as drawn by default: nothing cut, nothing re-fed.
 */
let edits = { missingIds: () => new Set(), reroutes: () => new Map(), boardValues: () => ({}) };
export function connectFlow(next) { edits = { ...edits, ...next }; }

/**
 * Runs the flow for one token. Returns { values, notes }: every box's value
 * on its wire (null = nothing: no data, or cut on the map) and its note.
 * A value that is not its box's declared type is a bug in the box and is
 * dropped, so a wire never carries anything but its standard type.
 */
export function runScoreFlow(ctx) {
  const missing = edits.missingIds();
  const rr = edits.reroutes();
  const bv = edits.boardValues();
  const values = {};
  const notes = {};
  const c = { ...ctx, memo: {}, now: ctx.now || Date.now() };
  NODES.forEach((n) => {
    if (missing.has(n.id)) { values[n.id] = null; return; }
    const inputs = {};
    // An input the user re-fed on the map reads the box that feeds it now,
    // converted to the type its dot expects.
    const fed = rr.get(n.id) || {};
    const srcOf = (d) => fed[d] || d;
    n.deps.forEach((d) => {
      const s = srcOf(d);
      const x = s in values ? values[s] : (s in bv ? bv[s] : null);
      inputs[d] = s === d ? x : coerce(x, NODE_TYPES[d]);
    });
    const note = (label) => notes[srcOf(P(label))];
    let res = null;
    try { res = n.run(inputs, c, note); } catch (e) { res = null; }
    let value = res && res.__out ? res.value : res;
    if (res && res.__out) notes[n.id] = res.note;
    if (value === undefined) value = null;
    if (value !== null && typeOfValue(value) !== n.type) value = null;
    values[n.id] = value;
  });
  return { values, notes };
}

/**
 * The model's result for one token, in the shape every tab reads. `score` is
 * EARLY (the entry score; 0 when a safety gate failed), `signal` and `phase`
 * the call. A box the map has cut leaves its part of the result empty.
 */
export function flowScore(row, extras) {
  const x = extras || {};
  const { values: v, notes } = runScoreFlow({
    row, samples: x.samples, own: x.own, intel: x.intel, walletIntel: x.walletIntel, jupiter: x.jupiter,
    ethos: x.ethos, listing: x.listing, smartWallets: x.smartWallets, now: x.now,
    walletTape: x.walletTape || walletTapeOf(x.walletSets),
  });
  const val = (label) => v[P(label)];
  const nt = (label) => notes[P(label)];
  const earlyNote = nt('EARLY RAW') || {};
  const gates = (val('VETO LOG') !== null && nt('VETO LOG')) || { checks: [], vetoed: false, vetoes: [], unchecked: [] };
  const organicNote = nt('Organic flow') || {};
  const quality = nt('Wallet quality') || {};
  const breakdown = earlyNote.breakdown
    || EARLY_MODEL.map((m) => ({ key: m.key, label: m.label, weight: weightOf(m), value: null, pending: true }));
  return {
    signal: val('SIGNAL'), signalWhy: nt('SIGNAL') || null,
    // The active engine, and every engine's own score and call.
    engine: activeEngine(),
    engines: Object.fromEntries(ENGINES.map((e) => [e.key, { label: e.label, score: val(e.score), signal: val(e.call), why: nt(e.call) || null }])),
    rotation: nt('ROTATING IN 1H') || null,
    phase: val('PHASE'), phaseWhy: nt('PHASE') || null,
    score: val('EARLY SCORE'),
    rawScore: val('EARLY RAW'),
    scoreModel: breakdown,
    inputsPresent: earlyNote.present || 0,
    gates,
    vetoed: gates.vetoed,
    riskFlags: val('RISK FLAGS') !== null ? nt('RISK FLAGS') || [] : [],
    plan: val('TRADE PLAN'),
    smart: { buyers: val('SMART BUYERS 1H'), sellers: val('SMART SELLERS 1H') },
    shortable: val('PERP LISTED'),
    measures: {
      aboveLow6hPct: val('ABOVE 6H LOW'), belowHigh6hPct: val('BELOW 6H HIGH'), range1hPct: val('RANGE 1H'),
      buysPerBuyer: val('BUYS PER BUYER'), volAccel: val('VOLUME 15M vs 1H'), buyerTrend: val('BUYERS 1H vs 6H'),
      holders: val('HOLDER COUNT'), priceImpactPct: val('PRICE IMPACT $10K'), netFlow: val('NET FLOW RATIO'),
    },
    walletQuality: quality.detail || null,
    organicFlow: organicNote.detail || null,
    contractSafety: val('Contract safety'),
    facts: { ...(quality.facts || {}) },
    // Every box's value on its wire, for the map to show what the flow computed.
    flowValues: v,
  };
}
