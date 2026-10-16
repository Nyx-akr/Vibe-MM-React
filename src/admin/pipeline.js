/**
 * The score pipeline, one box per step, for ONE token.
 *
 * This is how the FRONTEND turns raw files into a score, in the order it does
 * it (services/api.js fetchLiveMarketData -> calculations/asset-detail.js
 * evaluateAsset):
 *
 *   1 TOKEN LIST    market.json, top 20 rows per chain -> normalizeRow -> screenRows
 *   2 READINGS      what is derived from the raw files: baselines, net ratio, impact, growth
 *   3 ENGINES       the 0-100 components and two modifiers (computeComponents)
 *   4 GATES         hard pass/fail on the row and the engines' output (gates.js)
 *   5 COMBINE       raw, flags, penalty, right now, final, stage (scoreAsset)
 *
 * Every value is READ, never recomputed: `v.pipe.s` is the token's scored row
 * exactly as the board holds it (asset.rawServerRow), `v.pipe.intel` the same
 * intel the detail page loaded. The `equation` lines print the arithmetic with
 * the live operands plugged in; where they show an intermediate term they call
 * the model's own curve functions from core.js, so the working cannot follow
 * a different curve than the score did - and the model's own result is printed
 * beside it, so a disagreement would be visible rather than hidden.
 *
 * Registered onto PAGES as the `pipe` page: the mirror renders it as the SCORE
 * PIPELINE tab and DATA FLOW lays its groups out as the pipeline's columns.
 */

import { PAGES, op, num, ref, ext, api } from './provenance';
import { SHOWN_PAGES } from './pipeline-shown';
import { REGIMES, REGIME_SETTING, REGIME_DEFAULT } from '../data/regimes';
import { boardValues } from '../flow/board-flow';
import { showsForPanel } from './shows';
import { multipleScore, logScore, to100, Z_MIN_SAMPLES, normalizeRow, isMajorToken } from '../calculations/core.js';
import {
  GATES, SAFETY_RULES, EARLY_MODEL, EARLY_CURVES, EARLY_MIN_PARTS, band, PHASE_RULES,
  ENGINES, ENGINE_RULES, tradePlanRules,
} from '../flow/score-flow.js';
import { activeEngine } from '../flow/params.js';
import { storeOrigin } from '../services/storage/raw-store';
import { getSetting, setSetting, applyFilter, filterSetting } from './box-settings';
import { measuredBadge, outcomeBadge, engineBadge } from '../services/model-eval';
import { smartWalletMeta } from '../services/smart-money';

/* ------------------------------------------------------------ readers -- */

const P = (v) => (v && v.pipe) || {};
const S = (v) => P(v).s || null;
const IN = (v) => P(v).intel || null;
const Z = (v) => ((S(v) || {}).zScores || {}).metrics || {};
const TS = (v) => (S(v) || {}).tradeStats || null;
const fin = Number.isFinite;

/*
 * RAW MODE. A box SENDS a raw value of a standard type (flow/types.js) - the
 * number, not "$44.9K" or "157 wallets". The formatters below write text for
 * a box's arithmetic line, and inside a box's value (rawCall) they return the
 * number itself, so every box's value is raw without rewriting each one.
 */
let RAW_MODE = 0;
const rawCall = (fn, v) => { RAW_MODE += 1; try { return fn(v); } finally { RAW_MODE -= 1; } };
const rnd = (n, dp = 2) => (fin(n) ? (RAW_MODE ? Math.round(n * 10 ** dp) / 10 ** dp : String(Math.round(n * 10 ** dp) / 10 ** dp)) : null);
const pct = (n, dp = 2) => (fin(n) ? (RAW_MODE ? rnd(n, dp) : rnd(n, dp) + '%') : null);
const signed = (n, dp = 1) => (fin(n) ? (RAW_MODE ? rnd(n, dp) : (n > 0 ? '+' : '') + rnd(n, dp)) : null);
const usd = (n) => {
  if (!fin(n)) return null;
  if (RAW_MODE) return n;
  const a = Math.abs(n);
  const s = n < 0 ? '-$' : '$';
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
  if (a >= 1) return s + a.toFixed(2);
  return s + a.toPrecision(4);
};
const count = (n) => (fin(n) ? (RAW_MODE ? Math.round(n) : Math.round(n).toLocaleString()) : null);
/** A value as it goes on the wire: a leftover "157 wallets" is its number. */
const toRaw = (x) => {
  if (typeof x !== 'string') return x === undefined ? null : x;
  const s = x.trim();
  if (!s || s === '—') return null;
  if (/^[+-]?[\d.,]+(\s*[a-z%×]+)?$/i.test(s)) {
    const n = parseFloat(s.replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return s;
};

const comp = (v, key) => ((S(v) || {}).scoreModel || []).find((c) => c.key === key) || null;
/** The two verdicts kept beside the call for the panels: organic flow and contract safety. */
const modOf = (v, key) => {
  const s = S(v);
  if (!s) return null;
  const x = key === 'organicFlow' ? (s.organicFlow ? s.organicFlow.score : null)
    : key === 'contractSafety' ? s.contractSafety : null;
  return { key, value: fin(x) ? x : null, pending: !fin(x),
    evidence: key === 'organicFlow' && s.organicFlow ? s.organicFlow.note : null };
};
const valueOf = (c) => (c && !c.pending && fin(c.value) ? c.value : null);
/** The number the model actually used, beside the working - a cross-check. */
const said = (c) => (valueOf(c) === null ? 'pending - no input yet' : '· model used ' + c.value);

const minutes = (ms) => (fin(ms) ? Math.round(ms / 60000) + ' min' : null);
const windowMin = (id, def) => getSetting(id, { n: def }).n;

/* -------------------------------------------------------------- gates -- */

/**
 * The PARAMETERS: every number the model is tuned by, as a raw number with
 * its unit in its name. A user changes one with the standard number input on
 * its box (box-settings.js); the flow reads it (flow/params.js).
 */
export const PARAMS = {
  minLiquidity: { label: 'MIN LIQUIDITY ($)', def: SAFETY_RULES.minLiquidity, step: 5000, min: 0,
    note: 'The LIQUIDITY FLOOR gate: under this depth a position cannot be exited cleanly.' },
};
export const paramId = (key) => 'param:' + key;
export const paramValue = (key) => getSetting(paramId(key), { n: PARAMS[key].def }).n;
/** An input's weight: its EARLY_MODEL weight unless the user changed it. */
export const weightId = (key) => 'param:weight:' + key;
/** An input's WEIGHT parameter box. */
export const weightLabel = (c) => 'WEIGHT · ' + c.label;
const weightNow = (c) => getSetting(weightId(c.key), { n: c.weight }).n;

/**
 * The gates are READ from the model, never recomputed: the flow judges them
 * (flow/score-flow.js GATES) and keeps the verdict on the row (`row.gates`),
 * so a gate box can only ever say what the model acted on. A test is
 * {ok, detail}: ok true = pass, false = FAIL, null = not checked yet.
 */
const GATE_TESTS = Object.fromEntries(GATES.map((g) => [g.label, (v) => {
  const c = (((S(v) || {}).gates || {}).checks || []).find((x) => x.label === g.label);
  return c && c.ok !== null ? { ok: c.ok, detail: c.detail + (c.ok ? ' → pass' : ' → FAIL') } : null;
}]));
const gateOf = (v, label) => (S(v) && GATE_TESTS[label] ? GATE_TESTS[label](v) : null);
const verdict = (r) => (r ? (r.ok ? 'pass' : 'FAIL') : null);

/* ------------------------------------------------------------- shared -- */

const WHERE_API = 'services/api.js fetchLiveMarketData()';
const WHERE_NORM = 'calculations/core.js normalizeRow()';
const WHERE_MODEL = 'flow/score-flow.js';

/**
 * multipleScore's arithmetic for one multiple. A multiple of 0 (nothing in
 * this 5-minute window) has no logarithm, so multipleScore gives no value and
 * the component is left out of the average - said in words, not as "→ null".
 */
const multipleMath = (m) => {
  if (!fin(m)) return null;
  if (m <= 0) return m + 'x: nothing in this 5-minute window, no log to take → left out of the average';
  return '0.5 + 0.3 × log10(' + m + ') → ' + multipleScore(m);
};

/**
 * A weighted mean of parts, as the arithmetic it is:
 *   [ (80 × 35) + (90 × 30) ] ÷ [ 35 + 30 ] = 5500 ÷ 65 = 84.6 × 0.75 = 63
 * Parts with no value are left out of BOTH sums, exactly as the model does.
 * `mods` are the verdict's own modifiers ({label, effect} with effect -25 =
 * × 0.75), applied in order.
 */
const weightedMath = (parts, mods) => {
  const used = (parts || []).filter((p) => fin(p.value));
  if (!used.length) return null;
  const sum = used.reduce((a, p) => a + p.value * p.weight, 0);
  const w = used.reduce((a, p) => a + p.weight, 0);
  let out = '[ ' + used.map((p) => '(' + p.value + ' × ' + p.weight + ')').join(' + ') + ' ]' +
    ' ÷ [ ' + used.map((p) => p.weight).join(' + ') + ' ] = ' + Math.round(sum) + ' ÷ ' + w +
    ' = ' + rnd(sum / w, 1);
  let x = sum / w;
  (mods || []).forEach((m) => {
    const f = 1 + m.effect / 100;
    x = Math.min(100, x * f);
    out += ' × ' + rnd(f, 2) + ' (' + m.label + ') = ' + rnd(x, 1);
  });
  // The model rounds to whole points, so the working does too - ending on the
  // same number the score used.
  out += ' → ' + Math.round(Math.max(0, Math.min(100, x)));
  // Named FIRST, so the calculation still ends on its result.
  const missing = (parts || []).filter((p) => !fin(p.value)).map((p) => p.label);
  return (missing.length ? '(not measured: ' + missing.join(', ') + ') ' : '') + out;
};

/* ============================================================== pages === */

PAGES.pipe = {
  title: 'MODEL',
  blurb: 'How the app turns raw files into one token’s call, step by step, with that ' +
    'token’s live numbers. Every 5s poll: read the files, normalise and screen the rows, ' +
    'measure where the price sits in its own range, score EARLY from seven inputs, check ' +
    'the three safety gates, place the token on its attention cycle and make the call.',
  groups: [
    {
      group: 'TOKEN LIST', stage: 1, flat: true,
      fields: [
        {
          label: 'TOKEN LIST', status: 'live',
          value: (v) => { const n = (P(v).assets || []).length; return n ? n + ' tokens' : null; },
          calc: [ext('geckoterminal', 'trending pools per chain'), op('+'),
            ext('dexscreener', 'pair data per token'), op('+'), ext('jupiter', 'token stats (Solana)'),
            op('→ server every 5s →'), api('/raw/<chain>/market.json', 'top 30 rows per chain'),
            op('→ app reads the top 20 → normalizeRow() → screenRows()')],
          equation: (v) => {
            const by = {};
            (P(v).assets || []).forEach((a) => { by[a.chain] = (by[a.chain] || 0) + 1; });
            const parts = Object.keys(by).map((k) => k + ' ' + by[k]);
            return parts.length ? parts.join(' · ') : null;
          },
          note: 'screenRows() drops stablecoins, wrapped natives and anything over a $1B market ' +
            'cap, and keeps only the deepest pool when one token trends in several.',
          where: WHERE_API + ' → ' + WHERE_NORM + ' → core.js screenRows()',
        },
        {
          label: 'THIS TOKEN', status: 'live',
          value: (v) => { const s = S(v); return s ? (s.symbol || '?') + ' · ' + s.chain : null; },
          calc: [op('the row picked from'), ref('pipe', 'TOKEN LIST'),
            op('- every box to the right is this token. Each option is tagged with'),
            { ...ref('pipe', 'VETO LOG', 'UNSAFE when a gate failed'), soft: true }, op('else its'), { ...ref('pipe', 'SIGNAL', 'call'), soft: true }],
          // A SELECTOR: every token on the list is an option, and picking one
          // here picks it for the whole admin - the same as the header picker.
          selector: {
            of: 'tokens',
            options: (v) => (P(v).assets || []).map((a) => ({
              id: a.id, label: a.sym, sub: a.chain,
              value: a.rawServerRow && a.rawServerRow.vetoed ? 'UNSAFE' : (a.signal || '—'),
            })),
            selected: (v) => P(v).selectedId || null,
            pick: (v, id) => { if (P(v).pick) P(v).pick(id); },
          },
          equation: (v) => {
            const s = S(v);
            if (!s) return null;
            return 'pool ' + String(s.poolAddress || '').slice(0, 10) + '… · scored on ' +
              (s.scoreBasis === 'intel' ? 'full intel' : 'market data only (intel not fetched yet)');
          },
          where: 'admin header token picker; the board selection on the dashboard',
        },
      ],
    },
    {
      group: 'MEASURES', stage: 2, flat: true,
      fields: [
        {
          label: 'NET FLOW RATIO', status: 'live',
          value: (v) => rnd((TS(v) || {}).netRatio, 3),
          calc: [op('( buy USD − sell USD ) ÷ ( buy USD + sell USD ) over'), api('/raw/<chain>/trades.json', 'TRADE SAMPLE')],
          equation: (v) => {
            const t = TS(v); if (!t || t.netRatio === null) return null;
            return '( ' + usd(t.buyUsd) + ' − ' + usd(t.sellUsd) + ' ) ÷ ' + usd(t.buyUsd + t.sellUsd) + ' = ' + t.netRatio;
          },
          where: 'core.js tradeStatsFrom()',
        },
        {
          label: 'TOP-5 WALLET SHARE', status: 'live',
          value: (v) => pct((TS(v) || {}).top5SharePct, 1),
          calc: [op('USD of the 5 biggest wallets ÷ all USD in'), api('/raw/<chain>/trades.json', 'TRADE SAMPLE')],
          where: 'core.js tradeStatsFrom()',
        },
        {
          label: 'PRICE IMPACT $10K', status: 'live',
          value: (v) => pct(((IN(v) || {}).impact || {}).priceImpactPct, 3),
          calc: [api('/raw/<chain>/intel.json', '$10K ROUTE QUOTE'), op('→ Jupiter priceImpactPct × 100, or KyberSwap ( USD in − USD out ) ÷ USD in × 100')],
          where: 'deriveIntel(), impact',
        },
        {
          label: 'WALLET SAMPLE', status: 'live',
          value: (v) => { const o = (S(v) || {}).organicFlow; return o && fin(o.walletsSeen) ? o.walletsSeen + ' wallets' : null; },
          calc: [api('/raw/<chain>/trades.json', 'TRADE SAMPLE'), op('→ background wallet service: who traded once, who churned, who entered together')],
          equation: (v) => {
            const q = (S(v) || {}).walletQuality;
            return q && q.note ? q.note : null;
          },
          note: 'The wallet service re-reads the trade samples the server already holds; it ' +
            'makes no upstream calls. Under 12 wallets a behavioural read is not trusted.',
          where: 'services/wallet-intel.js walletIntelForPool()',
        },
      ],
    },
    {
      group: 'CONTEXT', stage: 3,
      note: 'What the panels show about the token beside the call: who holds it, how long it has lasted, who is behind it. Not inputs to the call.',
      fields: [
        {
          label: 'Wallet quality', status: 'live',
          value: (v) => { const q = (S(v) || {}).walletQuality; return q && fin(q.score) ? q.score : null; },
          calc: [api('/raw/<chain>/intel.json', 'TOP HOLDERS SHARE'), ref('pipe', 'WALLET SAMPLE'),
            api('/raw/<chain>/intel.json', 'LP / CREATOR / INSIDERS'), api('/raw/<chain>/market.json', 'JUPITER STATS'),
            op('→ holder spread 35, crowd independence 30, volume spread 20, position intent 15, then the adjustments')],
          equation: (v) => { const q = (S(v) || {}).walletQuality; return q ? weightedMath(q.parts, q.modifiers) : null; },
          note: 'The WALLETS panel reads this verdict. It is not an input to EARLY or the signal.',
          where: 'calculations/core.js walletQualityScore()',
        },
        {
          label: 'SURVIVAL', status: 'live',
          value: (v) => {
            const h = (S(v) || {}).poolAgeHours;
            return fin(h) ? (h / 24).toFixed(1) + ' days' : null;
          },
          // Only the pool's age reaches the score (Durability's curve). The
          // spec's 30-day liquidity trend and drawdown need longer samples.
          calc: [api('/raw/<chain>/market.json', 'POOL AGE'), op('hours ÷ 24 → days')],
          equation: (v) => {
            const h = (S(v) || {}).poolAgeHours;
            if (!fin(h)) return null;
            const lane = h < 24 * 14 ? 'inside the 14-day new-launch window' : 'past the 14-day window';
            return Math.round(h) + ' hours old - ' + lane;
          },
          note: 'The 14-day line is what the listing spec uses to split a new launch from an ' +
            'established token: under it the AGE FLOOR gate vetoes the token.',
          where: WHERE_NORM,
        },
        {
          label: 'PROJECT REPUTATION', status: 'partial',
          value: (v) => (v && v.ethosLabel) || null,
          calc: [api('/raw/ethos.json', 'ETHOS (PROJECT X)'),
            op('- a score of 0 means Ethos has no record, which is NOT a bad reputation and is left out')],
          equation: (v) => {
            const e = v && v.ethos;
            if (!e || !e.linked) return 'this token advertises no X account';
            if (e.score === 0) return 'no Ethos record for @' + e.handle + ' - no score, not a bad one';
            return '@' + e.handle + ' = ' + e.score + ' (' + (e.level || '?') + '), ' +
              (e.delta > 0 ? '+' : '') + e.delta + ' against the 1200 start';
          },
          note: 'Not in the score. It raises a flag when a project account sits below the Ethos ' +
            'starting score, and nothing more, until it is shown to predict something.',
          where: 'services/ethos-intel.js ethosFor()',
        },
      ],
    },
    {
      group: 'WASH & ORGANIC', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'Does the volume belong to different people. Read for the panels and the warnings - not an input to the call.',
      fields: [
        {
          label: 'Organic flow', status: 'live',
          value: (v) => valueOf(modOf(v, 'organicFlow')),
          calc: [op('[ ( crowd spread'), op('×'), num(30), op(') + ( volume spread'), op('×'), num(25),
            op(') + ( churn-free'), op('×'), num(25), op(') + ( entry independence'), op('×'), num(20),
            op(') ] ÷ [ the weights of the parts that have a value ], each part from'), ref('pipe', 'WALLET SAMPLE'),
            op('; with no sample of our own, Jupiter’s organicScore from'), api('/raw/<chain>/market.json', 'JUPITER STATS')],
          equation: (v) => {
            const o = (S(v) || {}).organicFlow; if (!o) return null;
            // The Jupiter cross-check first, so the calculation ends on our result.
            const cross = o.crossCheck ? '(Jupiter says ' + o.crossCheck.value + ') ' : '';
            if (o.basis === 'jupiter') return 'no sample of our own → Jupiter organicScore = ' + o.score + '   ' + said(modOf(v, 'organicFlow'));
            const body = weightedMath(o.parts, null);
            return body ? cross + body + '   ' + said(modOf(v, 'organicFlow')) : null;
          },
          evidence: (v) => (modOf(v, 'organicFlow') || {}).evidence || '',
          note: 'Below 40 it raises the LOW_ORGANIC_FLOW warning.',
          where: 'calculations/core.js organicFlowScore()',
        },
      ],
    },
    {
      group: 'CONTRACT SAFETY', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'What the contract itself allows: the input the SELLABLE and TAX IN RANGE gates read.',
      fields: [
        {
          label: 'Contract safety', status: 'live',
          value: (v) => valueOf(modOf(v, 'contractSafety')),
          calc: [api('/raw/<chain>/intel.json', 'CONTRACT CHECKS'), op('passed ÷ total × 100')],
          equation: (v) => {
            const cs = (IN(v) || {}).contractSafety; if (!cs || !cs.available) return null;
            const n = (cs.checks || []).length;
            return (n - cs.failedCount) + ' ÷ ' + n + ' → ' + Math.round(((n - cs.failedCount) / (n || 1)) * 100) +
              '   ' + said(modOf(v, 'contractSafety'));
          },
          note: 'Under 100 it raises the CONTRACT_CHECKS warning.',
          where: 'flow/score-flow.js Contract safety',
        },
      ],
    },
    {
      group: 'GATES', stage: 4, flat: true,
      note: 'Safety only: can it be sold, is the tax sane, is there depth to get out. A gate fails only on evidence; a failure blocks BUY and sets EARLY to 0.',
      fields: [
        {
          label: 'SELLABLE', status: 'live',
          value: (v) => verdict(gateOf(v, 'SELLABLE')),
          calc: [api('/raw/<chain>/intel.json', 'CONTRACT CHECKS'), op('- a simulated buy AND sell must both succeed')],
          equation: (v) => {
            const cs = (IN(v) || {}).contractSafety;
            if (!cs || !cs.available) return 'not checked yet - the intel collector has not reached this token';
            const hit = (cs.checks || []).find((c) => /honeypot|sell/i.test(c.label || ''));
            return hit ? hit.label + ': ' + (hit.detail || (hit.ok ? 'ok' : 'failed')) : 'no sell simulation for this chain';
          },
          note: 'The one gate nothing can outweigh. A token that cannot be sold is not a trade at any score.',
          where: 'calculations/asset-detail.js deriveIntel()',
        },
        {
          label: 'TAX IN RANGE', status: 'live',
          value: (v) => verdict(gateOf(v, 'TAX IN RANGE')),
          calc: [api('/raw/<chain>/intel.json', 'CONTRACT CHECKS'), op('- the contract check’s own tax verdict (buy and sell tax each at or under 5%)')],
          equation: (v) => {
            const cs = (IN(v) || {}).contractSafety;
            if (!cs || !cs.available) return 'not checked yet';
            const hit = (cs.checks || []).find((c) => /tax/i.test(c.label || ''));
            return hit ? (hit.detail || hit.label) : 'no tax reading for this chain';
          },
          where: 'calculations/asset-detail.js deriveIntel()',
        },
        {
          label: 'LIQUIDITY FLOOR', status: 'live',
          value: (v) => verdict(gateOf(v, 'LIQUIDITY FLOOR')),
          calc: [api('/raw/<chain>/market.json', 'LIQUIDITY'), op('at or over'), ref('pipe', PARAMS.minLiquidity.label)],
          equation: (v) => { const r = gateOf(v, 'LIQUIDITY FLOOR'); return r ? r.detail : (S(v) ? 'no liquidity reported - not checked' : null); },
          note: 'The pool a perp is priced against. Too shallow and one trader moves the index.',
          where: 'calculations/gates.js evaluateGates()',
        },
        {
          label: 'VETO LOG', status: 'live',
          // From the gates as the MAP judges them (current parameters), so a
          // changed threshold reaches the log; at the defaults this is the
          // score's own verdict.
          value: (v) => {
            if (!S(v)) return null;
            const failed = Object.keys(GATE_TESTS).filter((k) => { const r = gateOf(v, k); return r && !r.ok; });
            return failed.length ? 'VETO · ' + failed.length + ' failed' : 'clean';
          },
          calc: Object.keys(GATE_TESTS).reduce((a, k, i) => a.concat(i ? [op('+'), ref('pipe', k)] : [ref('pipe', k)]), []),
          equation: (v) => {
            if (!S(v)) return null;
            const rows = Object.keys(GATE_TESTS).map((k) => [k, gateOf(v, k)]);
            const failed = rows.filter(([, r]) => r && !r.ok);
            const unknown = rows.filter(([, r]) => !r).map(([k]) => k);
            const tail = unknown.length ? '   (not checked yet: ' + unknown.join(', ') + ')' : '';
            return (failed.length ? failed.map(([k, r]) => k + ': ' + r.detail).join('   ')
              : 'every gate this token could be checked against passed') + tail;
          },
          note: 'The gates output. One failed gate vetoes the token: RIGHT NOW and FINAL become 0. ' +
            'Each veto is logged with its reason, so the log is a reject list you can read.',
          where: 'calculations/gates.js evaluateGates() → asset-detail.js scoreAsset()',
        },
      ],
    },
    {
      group: 'WARNINGS', stage: 5, flat: true,
      fields: [
        {
          label: 'RISK FLAGS', status: 'live',
          value: (v) => { const s = S(v); return s ? (s.riskFlags || []).length + ' raised' : null; },
          calc: [op('rules on'), api('/raw/<chain>/market.json', 'POOL AGE'), api('/raw/<chain>/market.json', 'PRICE, 2 SOURCES'), api('/raw/<chain>/market.json', 'LIQUIDITY'),
            api('/raw/<chain>/market.json', 'VOLUME / LIQUIDITY'), ref('pipe', 'TOP-5 WALLET SHARE'), ref('pipe', 'Contract safety'),
            ref('pipe', 'Organic flow'), ref('pipe', 'PROJECT REPUTATION')],
          equation: (v) => {
            const s = S(v); if (!s) return null;
            const f = s.riskFlags || [];
            return f.length ? f.map((x) => x.code + ' −' + x.penalty).join(' · ') : 'none triggered';
          },
          note: 'Warnings, not a score: pool under 2h / 24h · one price source · liquidity under $50K · ' +
            '24h volume over 20x liquidity · top-5 wallets over 70% of volume · contract checks under 100 · ' +
            'organic flow under 40 · Ethos below its start · our organic read and Jupiter’s disagreeing.',
          where: 'flow/score-flow.js RISK FLAGS',
        },
      ],
    },
  ],
};

/* ===================================================== raw records === */

/**
 * For each input step: which raw record it reads, which KEYS of it the app
 * extracts, and what each key becomes. Drawn as the record itself with those
 * keys highlighted and wired to their outputs (Explain.jsx RawData).
 *
 * `path` is a key path into the record; `[]` means "each element" and shows
 * one. `alt` marks a fallback - the `else` in normalizeRow / deriveIntel.
 * `outs` values are READ from the scored row or the intel, never recomputed
 * from the record: the record shows where a number came from, the row is the
 * number the score used. Paths that a record does not have (an EVM-only key on
 * a Solana token) are simply not drawn.
 */
const DS = 'sources.dexscreener.';
const GT = 'sources.geckoterminal.';
const JUP = 'sources.jupiter.';

/**
 * THE RELAYS THAT WERE REMOVED, AND WHO ACTUALLY READS THEM.
 *
 * There used to be a column of "token input" boxes: one per reading, whose
 * only job was to take a value out of a file and hand it on unchanged. Each
 * of them said exactly what an arrow from the file to the box that uses the
 * number says, so they were relays rather than steps, and every box on the
 * map should be a thing it can be read AS - an API we fetch from, a file on
 * disk, a calculation, or a panel that shows a result.
 *
 * Their port declarations did not go with them: RAW still holds which keys of
 * which file are read, and this says which box reads each one. Together they
 * are what puts a port on the right line of a raw-store card and points it at
 * the right place.
 */
export const RELAY_CONSUMERS = {
  'LIQUIDITY': ['LIQUIDITY FLOOR', 'RISK FLAGS'],
  'PRICE, 2 SOURCES': ['RISK FLAGS'],
  'PRICE': ['TRADE PLAN'],
  'SMART LIST': ['SMART BUYERS 1H', 'SMART SELLERS 1H'],
  'PERP VENUES': ['PERP LISTED'],
  'BUYERS 24H': [],
  'POOL AGE': ['SURVIVAL', 'RISK FLAGS', 'Seasoning'],
  'VOLUME / LIQUIDITY': ['RISK FLAGS'],
  'JUPITER STATS': ['Wallet quality', 'Organic flow', 'HOLDER COUNT'],
  'POOL SAMPLES': ['ABOVE 6H LOW', 'BELOW 6H HIGH', 'RANGE 1H', 'BUYS PER BUYER', 'VOLUME 15M vs 1H', 'BUYERS 1H vs 6H'],
  'VOLUME 5M HISTORY': [],
  'VOLUME 5M NOW': [],
  'TRADE SAMPLE': ['NET FLOW RATIO', 'TOP-5 WALLET SHARE', 'WALLET SAMPLE', 'SMART BUYERS 1H', 'SMART SELLERS 1H'],
  '$10K ROUTE QUOTE': ['PRICE IMPACT $10K'],
  'HOLDERS': ['HOLDER COUNT'],
  'TOP HOLDERS SHARE': ['Wallet quality'],
  'CONTRACT CHECKS': ['SELLABLE', 'TAX IN RANGE', 'Contract safety'],
  'LP / CREATOR / INSIDERS': ['Wallet quality'],
  'ETHOS (PROJECT X)': ['PROJECT REPUTATION'],
};

export const RAW = {
  'TOKEN LIST': {
    from: 'marketFile',
    picks: [{ path: 'rows', to: 'ROWS ON THIS CHAIN' }, { path: 'feed', to: 'ROWS ON THIS CHAIN' }],
    outs: [
      { label: 'ROWS ON THIS CHAIN', value: (v, r) => (r && r.rows ? r.rows.length + ' → top 20 read' : null) },
      { label: 'BOARD, ALL CHAINS', value: (v) => { const n = (P(v).assets || []).length; return n ? n + ' after screening' : null; } },
    ],
  },
  'THIS TOKEN': {
    from: 'market',
    picks: [{ path: 'symbol', to: 'TOKEN' }, { path: 'chain', to: 'TOKEN' },
      { path: 'tokenAddress', to: 'ADDRESSES' }, { path: 'poolAddress', to: 'ADDRESSES' }, { path: 'quoteSymbol', to: 'QUOTE' }],
    outs: [
      { label: 'TOKEN', value: (v) => { const s = S(v); return s ? s.symbol + ' · ' + s.chain : null; } },
      { label: 'ADDRESSES', value: () => 'token + pool' },
      { label: 'QUOTE', value: (v) => (S(v) || {}).quoteSymbol || null },
    ],
  },
  LIQUIDITY: {
    from: 'market',
    picks: [{ path: DS + 'liquidityUsd', to: 'LIQUIDITY' }, { path: GT + 'liquidityUsd', to: 'LIQUIDITY', alt: true }],
    outs: [{ label: 'LIQUIDITY', value: (v) => usd((S(v) || {}).liquidityUsd) }],
  },
  'BUYERS 24H': {
    from: 'market',
    picks: [{ path: GT + 'transactions.h24.buyers', to: 'BUYERS 24H' }],
    outs: [{ label: 'BUYERS 24H', value: (v) => count(((S(v) || {}).traders24h || {}).buyers) }],
  },
  'PRICE, 2 SOURCES': {
    from: 'market',
    picks: [{ path: DS + 'priceUsd', to: 'PRICE (shown)' }, { path: GT + 'priceUsd', to: 'PRICE (shown)', alt: true },
      { path: DS + 'priceUsd', to: 'GAP BETWEEN THEM' }, { path: GT + 'priceUsd', to: 'GAP BETWEEN THEM' }],
    outs: [
      { label: 'PRICE (shown)', value: (v) => usd((S(v) || {}).priceUsd) },
      { label: 'GAP BETWEEN THEM', value: (v) => pct(((S(v) || {}).crossSource || {}).priceDeltaPct) },
    ],
  },
  // The price the TRADE PLAN enters at: DexScreener's, else GeckoTerminal's.
  PRICE: {
    from: 'market',
    picks: [{ path: DS + 'priceUsd', to: 'PRICE' }, { path: GT + 'priceUsd', to: 'PRICE', alt: true }],
    outs: [{ label: 'PRICE', value: (v) => usd((S(v) || {}).priceUsd) }],
  },
  // The learned smart wallets (scripts/backtest-early.mjs --wallets).
  'SMART LIST': {
    from: 'smart',
    picks: [{ path: 'wallets', to: 'SMART LIST' }],
    outs: [{ label: 'SMART LIST', value: () => { const m = smartWalletMeta(); return m ? m.count + ' wallets' : null; } }],
  },
  VENUES: {
    from: 'market',
    picks: [{ path: DS + 'pairsListed', to: 'VENUES' }],
    outs: [{ label: 'VENUES', value: (v) => count((((S(v) || {}).sources || {}).dexscreener || {}).pairs) }],
  },
  'POOL AGE': {
    from: 'market',
    picks: [{ path: GT + 'poolCreatedAt', to: 'AGE' }, { path: DS + 'pairCreatedAt', to: 'AGE', alt: true }],
    outs: [{ label: 'AGE', value: (v) => { const h = (S(v) || {}).poolAgeHours; return fin(h) ? rnd(h, 1) + 'h' : null; } }],
  },
  'VOLUME / LIQUIDITY': {
    from: 'market',
    picks: [{ path: DS + 'volumeUsd.h24', to: 'TURNOVER' }, { path: DS + 'liquidityUsd', to: 'TURNOVER' }],
    outs: [{ label: 'TURNOVER', value: (v) => { const x = (S(v) || {}).volumeToLiquidity24h; return fin(x) ? rnd(x, 1) + 'x' : null; } }],
  },
  'JUPITER STATS': {
    from: 'market',
    picks: [{ path: JUP + 'organicScore', to: 'ORGANIC (cross-check)' }, { path: JUP + 'holderCount', to: 'HOLDERS (fallback)' },
      { path: JUP + 'stats1h.holderChangePct', to: 'HOLDERS 1H %' },
      { path: JUP + 'stats1h.buyVolumeUsd', to: 'NET 1H' }, { path: JUP + 'stats1h.sellVolumeUsd', to: 'NET 1H' }],
    outs: [
      { label: 'ORGANIC (cross-check)', value: (v) => rnd(((S(v) || {}).jupiter || {}).organicScore, 1) },
      { label: 'HOLDERS (fallback)', value: (v) => count(((S(v) || {}).jupiter || {}).holderCount) },
      { label: 'HOLDERS 1H %', value: (v) => pct((((S(v) || {}).jupiter || {}).stats1h || {}).holderChangePct, 3) },
      { label: 'NET 1H', value: (v) => usd((((S(v) || {}).jupiter || {}).stats1h || {}).netUsd) },
    ],
  },
  'POOL SAMPLES': {
    from: 'history', last: true,
    picks: [{ path: '[].volume5mUsd', to: 'VOLUME 5M now' }, { path: '[].buys5m', to: 'BUYS 5M now' },
      { path: '[].buyers5m', to: 'BUYERS 5M now' }, { path: '[].t', to: 'SAMPLES' }],
    outs: [
      { label: 'SAMPLES', value: (v, r) => (Array.isArray(r) ? r.length + ' × 15s' : null) },
      { label: 'VOLUME 5M now', value: (v) => usd((Z(v).volume5mUsd || {}).value) },
      { label: 'BUYS 5M now', value: (v) => count((Z(v).buys5m || {}).value) },
      { label: 'BUYERS 5M now', value: (v) => count((Z(v).buyers5m || {}).value) },
    ],
  },
  // One reading per series a measure divides, so the measure's input is named
  // by its data (VOLUME 5M HISTORY) rather than by the file (POOL SAMPLES).
  ...Object.fromEntries([
    ['VOLUME 5M HISTORY', 'volume5mUsd', usd],
  ].map(([reading, metric, fmt]) => [reading, {
    from: 'history', last: true,
    picks: [{ path: '[].' + metric, to: reading }],
    outs: [{ label: reading, value: (v) => { const m = Z(v)[metric]; return m ? m.samples + ' samples' : null; } }],
  }])),
  // ...and the newest sample of each, which is what a measure compares.
  ...Object.fromEntries([
    ['VOLUME 5M NOW', 'volume5mUsd', usd],
  ].map(([reading, metric, fmt]) => [reading, {
    from: 'history', last: true,
    picks: [{ path: '[].' + metric, to: reading }],
    outs: [{ label: reading, value: (v) => { const m = Z(v)[metric]; return m ? fmt(m.value) : null; } }],
  }])),
  'TRADE SAMPLE': {
    from: 'trades',
    picks: [{ path: 'trades', to: 'TRADES' }, { path: 'trades[].wallet', to: 'WALLETS' },
      { path: 'trades[].kind', to: 'BUY USD' }, { path: 'trades[].usd', to: 'BUY USD' },
      { path: 'trades[].kind', to: 'SELL USD' }, { path: 'trades[].usd', to: 'SELL USD' },
      { path: 'trades[].at', to: 'WINDOW' }],
    outs: [
      { label: 'TRADES', value: (v) => count((TS(v) || {}).trades) },
      { label: 'WALLETS', value: (v) => count((TS(v) || {}).distinctWallets) },
      { label: 'BUY USD', value: (v) => usd((TS(v) || {}).buyUsd) },
      { label: 'SELL USD', value: (v) => usd((TS(v) || {}).sellUsd) },
      { label: 'WINDOW', value: (v) => { const m = (TS(v) || {}).windowMinutes; return fin(m) ? rnd(m, 1) + ' min' : null; } },
    ],
  },
  '$10K ROUTE QUOTE': {
    from: 'intel',
    picks: [{ path: 'jupiterQuote.priceImpactPctRaw', to: 'IMPACT ON $10K' }, { path: 'jupiterQuote.routes', to: 'ROUTES' },
      { path: 'kyberQuote.amountInUsd', to: 'IMPACT ON $10K', alt: true }, { path: 'kyberQuote.amountOutUsd', to: 'IMPACT ON $10K', alt: true },
      { path: 'kyberQuote.routes', to: 'ROUTES', alt: true }],
    outs: [
      { label: 'IMPACT ON $10K', value: (v) => pct(((IN(v) || {}).impact || {}).priceImpactPct, 3) },
      { label: 'ROUTES', value: (v) => count(((IN(v) || {}).impact || {}).routes) },
    ],
  },
  HOLDERS: {
    from: 'intel',
    picks: [{ path: 'goplus.holder_count', to: 'HOLDERS' }, { path: 'rugcheck.totalHolders', to: 'HOLDERS', alt: true },
      { path: 'jupiterToken.holderCount', to: 'HOLDERS', alt: true },
      { path: 'holderSeries', to: 'SERIES' }, { path: 'holderSeries[].count', to: 'SERIES' }],
    outs: [
      { label: 'HOLDERS', value: (v) => count(((IN(v) || {}).holders || {}).count) },
      { label: 'SERIES', value: (v) => { const g = (((IN(v) || {}).holders) || {}).growth; return g ? g.samples + ' points' : null; } },
    ],
  },
  'TOP HOLDERS SHARE': {
    from: 'intel',
    picks: [{ path: 'goplus.holders', to: 'TOP HOLDERS %' }, { path: 'goplus.holders[].percent', to: 'TOP HOLDERS %' },
      { path: 'jupiterToken.audit.topHoldersPercentage', to: 'TOP HOLDERS %', alt: true }],
    outs: [{ label: 'TOP HOLDERS %', value: (v) => pct(((S(v) || {}).facts || {}).topHolderSharePct) }],
  },
  'CONTRACT CHECKS': {
    from: 'intel',
    // Solana keys first, then EVM; whichever the record has is what is drawn.
    picks: ['mintable.status', 'freezable.status', 'closable.status', 'balance_mutable_authority.status',
      'transfer_hook_upgradable.status', 'transfer_fee', 'is_honeypot', 'is_open_source', 'can_take_back_ownership',
      'hidden_owner', 'transfer_pausable', 'is_mintable', 'buy_tax', 'sell_tax']
      .map((k) => ({ path: 'goplus.' + k, to: 'CHECKS PASSED' }))
      .concat([{ path: 'honeypot.isHoneypot', to: 'CHECKS PASSED' }]),
    outs: [{ label: 'CHECKS PASSED', value: (v) => { const cs = (IN(v) || {}).contractSafety; if (!cs || !cs.available) return null; const n = (cs.checks || []).length; return (n - cs.failedCount) + ' / ' + n; } }],
  },
  'LP / CREATOR / INSIDERS': {
    from: 'intel',
    picks: [{ path: 'rugcheck.markets[].lpLockedPct', to: 'LP LOCKED' }, { path: 'rugcheck.creatorTokenCount', to: 'CREATOR TOKENS' },
      { path: 'rugcheck.graphInsidersDetected', to: 'INSIDERS' }],
    outs: [
      { label: 'LP LOCKED', value: (v) => pct(((IN(v) || {}).contractSafety || {}).lpLockedPct, 1) },
      { label: 'CREATOR TOKENS', value: (v) => { const x = ((IN(v) || {}).contractSafety || {}).creatorOtherTokens; return x == null ? null : x; } },
      { label: 'INSIDERS', value: (v) => { const x = ((IN(v) || {}).contractSafety || {}).insidersDetected; return x == null ? null : (x ? 'detected' : 'none'); } },
    ],
  },
  'PERP VENUES': {
    from: 'perps',
    picks: [{ path: 'listedOn', to: 'LISTED ON' }, { path: 'checked', to: 'VENUES ANSWERED' }, { path: 'total', to: 'VENUES ANSWERED' }],
    outs: [
      { label: 'LISTED ON', value: (v) => { const p = (P(v).raw || {}).perps; return p ? (p.listedOn.join(', ') || 'none') : null; } },
      { label: 'VENUES ANSWERED', value: (v) => { const p = (P(v).raw || {}).perps; return p ? p.checked + ' / ' + p.total : null; } },
    ],
  },
  FDV: {
    from: 'market',
    picks: [{ path: DS + 'fdvUsd', to: 'FDV' }, { path: GT + 'fdvUsd', to: 'FDV', alt: true }],
    outs: [{ label: 'FDV', value: (v) => {
      const s = (((P(v).raw || {}).market || {}).sources) || {};
      const x = (s.dexscreener || {}).fdvUsd ?? (s.geckoterminal || {}).fdvUsd;
      return fin(x) ? usd(x) : null;
    } }],
  },
  'BUY/SELL 24H': {
    from: 'market',
    picks: [{ path: GT + 'transactions.h24.buys', to: 'BUYS ÷ SELLS' }, { path: GT + 'transactions.h24.sells', to: 'BUYS ÷ SELLS' }],
    outs: [{ label: 'BUYS ÷ SELLS', value: (v) => rnd((S(v) || {}).buySellRatio24h, 2) }],
  },
  'VOLUME 24H': {
    from: 'market',
    picks: [{ path: DS + 'volumeUsd.h24', to: 'VOLUME 24H' }, { path: GT + 'volumeUsd.h24', to: 'VOLUME 24H', alt: true }],
    outs: [{ label: 'VOLUME 24H', value: (v) => usd((S(v) || {}).volume24hUsd) }],
  },
  'MARKET CAP': {
    from: 'market',
    picks: [{ path: DS + 'marketCapUsd', to: 'MARKET CAP' }, { path: GT + 'marketCapUsd', to: 'MARKET CAP', alt: true }],
    outs: [{ label: 'MARKET CAP', value: (v) => { const x = (S(v) || {}).marketCapUsd; return fin(x) ? usd(x) : null; } }],
  },
  'PRICE CHANGE 5M': {
    from: 'market',
    picks: [{ path: DS + 'priceChangePct.m5', to: 'DELTA 5M' }, { path: GT + 'priceChangePct.m5', to: 'DELTA 5M', alt: true }],
    outs: [{ label: 'DELTA 5M', value: (v) => {
      const s = (((P(v).raw || {}).market || {}).sources) || {};
      const x = ((s.dexscreener || {}).priceChangePct || {}).m5 ?? ((s.geckoterminal || {}).priceChangePct || {}).m5;
      return fin(x) ? signed(x, 2) + '%' : null;
    } }],
  },
  'ETHOS (PROJECT X)': {
    from: 'ethos',
    picks: [{ path: 'token.handle', to: 'ACCOUNT' }, { path: 'token.kind', to: 'ACCOUNT' },
      { path: 'profile.score', to: 'SCORE' }, { path: 'profile.level', to: 'SCORE' }],
    outs: [
      { label: 'ACCOUNT', value: (v) => { const e = (P(v).raw || {}).ethos; return e && e.token ? '@' + e.token.handle + ' · ' + e.token.kind : null; } },
      { label: 'SCORE', value: (v) => (v && v.ethosLabel) || null },
    ],
  },
};
PAGES.pipe.groups.forEach((g) => (g.fields || []).forEach((f) => { if (RAW[f.label]) f.raw = RAW[f.label]; }));

/* ========================================================= box types === */

/*
 * Every pipeline box is ONE type, read off its spec by FlowChart.jsx:
 *   math      - inputs → a formula → one result (the default)
 *   aggregate - `agg`      a series reduced to one value (mean)
 *   decision  - `decision` a condition: pass / fail, and the branch taken
 *   curve     - `curve`    a raw number mapped onto 0-100, the curve drawn
 *   (a weighted average is not a type: it is a GROUP of × / SUM / ÷ - weightedOps)
 *   param     - `param`    a constant the model is tuned by
 *   join      - `join`     this token matched against a list, by a key
 *   extract   - `extract`  one value picked out of a raw file
 * and `memory` marks a box that keeps state between polls.
 */
const fieldBy = (label) => {
  for (const g of PAGES.pipe.groups) {
    const f = (g.fields || []).find((x) => x.label === label);
    if (f) return f;
  }
  return null;
};
const tag = (label, extra) => { const f = fieldBy(label); if (f) Object.assign(f, extra); };

// Decisions: the gates, the veto log, and FINAL's veto switch.
Object.keys(GATE_TESTS).forEach((label) => tag(label, {
  decision: { test: (v) => { const r = gateOf(v, label); return r ? r.ok : null; }, yes: 'PASS', no: 'VETO' },
}));
tag('VETO LOG', { decision: { test: (v) => { const g = (S(v) || {}).gates; return g ? !g.vetoed : null; }, yes: 'CLEAN', no: 'VETO' } });


// Joins: this token looked up in a list.

// Operation graphs: a box whose formula has more than one step is a GROUP of
// operator boxes (graph.js expands `ops`, engines.js makes the group). Each
// operator shows its own arithmetic with this token's numbers; the LAST one is
// the box's result and reads the score's own number, so the group can never
// end on a different value than the one the app used.
//   node(id, symbol, label, inputs, expr(v), value(v), extra)
//   inputs: ref()/api() tokens from outside, '@id' for another operator here.
const n0 = (x) => (fin(x) ? x : null);
const show = (x, dp = 2) => (fin(x) ? String(rnd(x, dp)) : '—');
/** What a FILTER box sends: the rows (or values) it kept, as a list. */
const filterRows = (f, v) => {
  if (f.rules) return f.rules.reduce((rows, r) => r.apply(rows, v), (f.rows(v) || []).slice());
  if (f.values) return applyFilter(f.values(v) || [], filterSetting(f.id, f.defaults));
  return null;
};
const node = (id, sym, label, inp, expr, value, extra) => {
  const x = extra || {};
  let raw = null;
  if (x.raw) raw = x.raw;
  else if (x.filter) raw = (v) => filterRows(x.filter, v);
  else if (value) raw = (v) => toRaw(rawCall(value, v));
  return { id, sym, label, in: inp, expr, ...x, value: raw };
};
const ifNode = (id, label, inp, when, test, thenV, elseV, extra) => node(id, 'IF', label, inp,
  null, (v) => { const t = test(v); return t === null ? null : (t ? thenV(v) : elseV(v)); },
  { cond: { kind: 'IF', when, test, then: thenV, else: elseV }, ...(extra || {}) });
const opsOf = (label, nodes) => {
  const f = fieldBy(label);
  if (f) f.ops = { nodes, out: nodes[nodes.length - 1].id };
};
const clampPct = (x) => (fin(x) ? to100(x) : null);
/** Every chain's market rows, each tagged with its chain and trending position. */
const marketRowsOf = (v) => marketRows((P(v).raw || {}).marketAll);
/** This pool's trade sample, as the list of trades. */
const tradesOf = (v) => { const p = (P(v).raw || {}).trades; return (p && p.trades) || []; };

// ---- TOKEN LIST: a list, filtered, then counted ------------------------------
{
  const FIRST_ID = 'f:pipe:TOKEN LIST\u00a7first:n';
  const firstN = () => getSetting(FIRST_ID, { n: 20 }).n;
  const rowsAll = (v) => marketRowsOf(v);
  const firstRows = (v) => rowsAll(v).filter((r) => r._rank < firstN());
  const normalized = (v) => firstRows(v).map((r) => ({ ...normalizeRow(r, r._fetchedAt), chain: r.chain }));
  const screenRules = [
    { label: 'not a stablecoin, wrapped native or major (cap over $1B)',
      apply: (rows) => rows.filter((r) => !isMajorToken(r)) },
    { label: 'one pool per token - the deepest is kept',
      apply: (rows) => {
        const best = new Map();
        rows.forEach((r) => {
          const k = r.chain + ':' + (r.tokenAddress || r.poolAddress);
          const b = best.get(k);
          if (!b || (Number(r.liquidityUsd) || 0) > (Number(b.liquidityUsd) || 0)) best.set(k, r);
        });
        return rows.filter((r) => best.get(r.chain + ':' + (r.tokenAddress || r.poolAddress)) === r);
      } },
  ];
  const screened = (v) => screenRules.reduce((rows, rule) => rule.apply(rows, v), normalized(v));
  const byChain = (rows) => {
    const m = {};
    rows.forEach((r) => { m[r.chain] = (m[r.chain] || 0) + 1; });
    return m;
  };
  opsOf('TOKEN LIST', [
    node('first', 'FILTER', 'FIRST N PER CHAIN', [api('/raw/<chain>/market.json', 'MARKET ROWS')], null,
      (v) => { const n = firstRows(v).length; return n ? n + ' rows' : null; },
      { filter: { rows: rowsAll, of: 'rows', rules: [{
        label: 'its trending position on its chain is under N', setting: { id: FIRST_ID, def: 20, step: 1, min: 1, max: 30 },
        apply: (rows) => rows.filter((r) => r._rank < firstN()),
      }] } }),
    node('screen', 'FILTER', 'SCREEN', ['@first'], null,
      (v) => { const n = screened(v).length; return n ? n + ' tokens' : null; },
      { filter: { rows: normalized, of: 'rows', rules: screenRules } }),
    node('count', 'COUNT BY', 'TOKEN LIST', ['@screen'],
      (v) => { const m = byChain(screened(v)); const ks = Object.keys(m); return ks.length ? ks.map((k) => k + ' ' + m[k]).join(' · ') : null; },
      null, { note: 'The board: every token that passed, counted per chain.',
        raw: (v) => { const m = byChain(screened(v)); return Object.keys(m).length ? m : null; } }),
  ]);
}

// ---- SCORE ------------------------------------------------------------------

// ---- READINGS ---------------------------------------------------------------
[['VOLUME 5M', 'volume5mUsd', usd], ['BUYS 5M', 'buys5m', count], ['BUYERS 5M', 'buyers5m', count]].forEach(([name, metric, fmt]) => {
  opsOf(name + ' vs BASELINE', [
    node('div', '÷', name + ' vs BASELINE', [api('/raw/<chain>/history.json', name + ' NOW'), ref('pipe', name + ' MEAN')],
      (v) => { const m = Z(v)[metric]; const mean = baselineMean(v, metric, name); return m && fin(mean) ? fmt(m.value) + ' ÷ ' + fmt(mean) : null; }, null),
  ]);
  // With the MEAN's window changed, the multiple is the map's preview.
  const f = fieldBy(name + ' vs BASELINE');
  if (f) {
    const scoreValue = f.value;
    f.value = (v) => {
      if (!baselineChanged(name)) return scoreValue(v);
      const m = Z(v)[metric]; const mean = baselineMean(v, metric, name);
      return m && fin(mean) && mean > 0 ? rnd(m.value / mean, 2) + 'x' : null;
    };
  }
});
opsOf('NET FLOW RATIO', [
  node('buys', 'FILTER', 'BUYS', [api('/raw/<chain>/trades.json', 'TRADE SAMPLE')], null,
    (v) => { const n = tradesOf(v).filter((t) => t.kind === 'buy').length; return n ? n + ' trades' : null; },
    { filter: { rows: tradesOf, rules: [{ label: 'kind = buy', apply: (rows) => rows.filter((t) => t.kind === 'buy') }], of: 'trades' } }),
  node('sells', 'FILTER', 'SELLS', [api('/raw/<chain>/trades.json', 'TRADE SAMPLE')], null,
    (v) => { const n = tradesOf(v).filter((t) => t.kind !== 'buy').length; return n ? n + ' trades' : null; },
    { filter: { rows: tradesOf, rules: [{ label: 'kind = sell', apply: (rows) => rows.filter((t) => t.kind !== 'buy') }], of: 'trades' } }),
  node('buy', 'SUM', 'BUY USD', ['@buys'],
    (v) => { const n = tradesOf(v).filter((t) => t.kind === 'buy').length; return n ? 'Σ usd of ' + n + ' buys' : null; },
    (v) => usd((TS(v) || {}).buyUsd)),
  node('sell', 'SUM', 'SELL USD', ['@sells'],
    (v) => { const n = tradesOf(v).filter((t) => t.kind !== 'buy').length; return n ? 'Σ usd of ' + n + ' sells' : null; },
    (v) => usd((TS(v) || {}).sellUsd)),
  node('sub', '−', 'BUY − SELL', ['@buy', '@sell'],
    (v) => { const t = TS(v); return t ? usd(t.buyUsd) + ' − ' + usd(t.sellUsd) : null; },
    (v) => { const t = TS(v); return t ? usd(t.buyUsd - t.sellUsd) : null; }),
  node('add', '+', 'BUY + SELL', ['@buy', '@sell'],
    (v) => { const t = TS(v); return t ? usd(t.buyUsd) + ' + ' + usd(t.sellUsd) : null; },
    (v) => { const t = TS(v); return t ? usd(t.buyUsd + t.sellUsd) : null; }),
  node('div', '÷', 'NET FLOW RATIO', ['@sub', '@add'],
    (v) => { const t = TS(v); return t ? usd(t.buyUsd - t.sellUsd) + ' ÷ ' + usd(t.buyUsd + t.sellUsd) : null; }, null),
]);

// ---- COMPONENTS -------------------------------------------------------------
opsOf('Contract safety', [
  node('count', 'COUNT', 'CHECKS PASSED', [api('/raw/<chain>/intel.json', 'CONTRACT CHECKS')],
    (v) => { const cs = (IN(v) || {}).contractSafety; return cs && cs.available ? 'checks that passed, of ' + (cs.checks || []).length : null; },
    (v) => { const cs = (IN(v) || {}).contractSafety; return cs && cs.available ? (cs.checks || []).length - cs.failedCount : null; }),
  node('div', '÷', 'SHARE', ['@count'],
    (v) => { const cs = (IN(v) || {}).contractSafety; if (!cs || !cs.available) return null; const n = (cs.checks || []).length; return (n - cs.failedCount) + ' ÷ ' + n; },
    (v) => { const cs = (IN(v) || {}).contractSafety; if (!cs || !cs.available) return null; const n = (cs.checks || []).length; return rnd((n - cs.failedCount) / (n || 1), 3); }),
  node('mul', '×', 'Contract safety', ['@div'],
    (v) => { const cs = (IN(v) || {}).contractSafety; if (!cs || !cs.available) return null; const n = (cs.checks || []).length; return rnd((n - cs.failedCount) / (n || 1), 3) + ' × 100'; }, null),
]);
// TOP-5 WALLET SHARE: the first chain that is COMPUTED on the map rather
// than read off the row - its FILTER box is a setting the user can change
// (highest / middle / lowest, how many), and everything after it follows.
// At the default (highest 5) it is the number the score used.
{
  const FILTER_ID = 'f:pipe:TOP-5 WALLET SHARE\u00a7filter';
  const FILTER_DEFAULT = { mode: 'top', n: 5 };
  const perWallet = (v) => {
    const pool = (P(v).raw || {}).trades;
    const m = new Map();
    ((pool && pool.trades) || []).forEach((t) => { if (fin(t.usd)) m.set(t.wallet, (m.get(t.wallet) || 0) + t.usd); });
    return Array.from(m.values());
  };
  const setting = () => filterSetting(FILTER_ID, FILTER_DEFAULT);
  const isDefault = () => { const s = setting(); return s.mode === FILTER_DEFAULT.mode && s.n === FILTER_DEFAULT.n; };
  const kept = (v) => applyFilter(perWallet(v), setting());
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const modeName = (s) => (s.mode === 'bottom' ? 'lowest ' : s.mode === 'mid' ? 'middle ' : 'highest ') + s.n;
  opsOf('TOP-5 WALLET SHARE', [
    node('wallets', 'SUM BY', 'USD PER WALLET', [api('/raw/<chain>/trades.json', 'TRADE SAMPLE')],
      (v) => { const pool = (P(v).raw || {}).trades; const n = ((pool && pool.trades) || []).length; return n ? n + ' trades, summed per wallet' : null; },
      null, { raw: (v) => { const xs = perWallet(v); return xs.length ? xs : null; } }),
    node('filter', 'FILTER', 'BIGGEST WALLETS', ['@wallets'], null,
      (v) => { const xs = kept(v); return xs.length ? modeName(setting()) + ' · ' + usd(sum(xs)) : null; },
      { filter: { id: FILTER_ID, defaults: FILTER_DEFAULT, values: perWallet, fmt: usd, of: 'wallets by USD traded' } }),
    node('sumKept', 'SUM', 'KEPT USD', ['@filter'],
      (v) => { const xs = kept(v); return xs.length ? xs.map((x) => usd(x)).join(' + ') : null; },
      (v) => { const xs = kept(v); return xs.length ? usd(sum(xs)) : null; }),
    node('sumAll', 'SUM', 'ALL USD', ['@wallets'],
      (v) => { const xs = perWallet(v); return xs.length ? 'every wallet’s USD, ' + xs.length + ' wallets' : null; },
      (v) => { const xs = perWallet(v); return xs.length ? usd(sum(xs)) : null; }),
    node('div', '÷', 'SHARE', ['@sumKept', '@sumAll'],
      (v) => { const a = sum(kept(v)); const b = sum(perWallet(v)); return b ? usd(a) + ' ÷ ' + usd(b) : null; },
      (v) => { const a = sum(kept(v)); const b = sum(perWallet(v)); return b ? rnd(a / b, 4) : null; }),
    node('pct', '×', 'TOP-5 WALLET SHARE', ['@div'],
      (v) => {
        const a = sum(kept(v)); const b = sum(perWallet(v)); if (!b) return null;
        return rnd(a / b, 4) + ' × 100' + (isDefault() ? '' : '   (the score uses the highest 5: ' + pct((TS(v) || {}).top5SharePct, 1) + ')');
      }, null),
  ]);
  // The group's result follows the filter: at the default it is the score's
  // own number, changed it is the preview the user asked for.
  const f = fieldBy('TOP-5 WALLET SHARE');
  if (f) {
    const scoreValue = f.value;
    f.value = (v) => {
      if (isDefault()) return scoreValue(v);
      const b = sum(perWallet(v));
      return b ? pct((sum(kept(v)) / b) * 100, 1) : null;
    };
  }
}

// PRICE IMPACT $10K: Jupiter's quote if it answered, else KyberSwap's, both
// as "what a $10k buy costs, in percent" (asset-detail.js deriveIntel()).
{
  const rawIntel = (v) => (P(v).raw || {}).intel || {};
  const jupiter = (v) => { const q = rawIntel(v).jupiterQuote; return q && fin(q.priceImpactPctRaw) ? q.priceImpactPctRaw : null; };
  const kyber = (v) => { const q = rawIntel(v).kyberQuote; return q && fin(q.amountInUsd) && fin(q.amountOutUsd) && q.amountInUsd ? q : null; };
  opsOf('PRICE IMPACT $10K', [
    node('jmul', '×', 'JUPITER × 100', [api('/raw/<chain>/intel.json', '$10K ROUTE QUOTE')],
      (v) => { const j = jupiter(v); return j === null ? 'Jupiter did not quote' : rnd(j, 6) + ' × 100'; },
      (v) => { const j = jupiter(v); return j === null ? null : rnd(j * 100, 4); }),
    node('ksub', '−', 'USD IN − USD OUT', [api('/raw/<chain>/intel.json', '$10K ROUTE QUOTE')],
      (v) => { const k = kyber(v); return k ? usd(k.amountInUsd) + ' − ' + usd(k.amountOutUsd) : 'KyberSwap did not quote'; },
      (v) => { const k = kyber(v); return k ? rnd(k.amountInUsd - k.amountOutUsd, 2) : null; }),
    node('kdiv', '÷', '÷ USD IN', ['@ksub', api('/raw/<chain>/intel.json', '$10K ROUTE QUOTE')],
      (v) => { const k = kyber(v); return k ? rnd(k.amountInUsd - k.amountOutUsd, 2) + ' ÷ ' + usd(k.amountInUsd) : null; },
      (v) => { const k = kyber(v); return k ? rnd((k.amountInUsd - k.amountOutUsd) / k.amountInUsd, 6) : null; }),
    node('kmul', '×', 'KYBERSWAP × 100', ['@kdiv'],
      (v) => { const k = kyber(v); return k ? rnd((k.amountInUsd - k.amountOutUsd) / k.amountInUsd, 6) + ' × 100' : null; },
      (v) => { const k = kyber(v); return k ? rnd(((k.amountInUsd - k.amountOutUsd) / k.amountInUsd) * 100, 4) : null; }),
    ifNode('if', 'PRICE IMPACT $10K', ['@jmul', '@kmul'], 'Jupiter quoted the route',
      (v) => (P(v).raw ? jupiter(v) !== null : null),
      (v) => rnd(jupiter(v) * 100, 4),
      (v) => { const k = kyber(v); return k ? rnd(((k.amountInUsd - k.amountOutUsd) / k.amountInUsd) * 100, 4) : null; }),
  ]);
}


// RISK FLAGS: one IF per rule of asset-detail.js assessRisk(), each giving its
// penalty or 0; the box counts the raised ones. Each IF is judged by whether
// the app raised that flag, so the group cannot disagree with the score.
{
  const flag = (v, code) => { const s = S(v); return s ? (s.riskFlags || []).find((f) => f.code === code) || false : null; };
  const raised = (code) => (v) => { const f = flag(v, code); return f === null ? null : Boolean(f); };
  const penalty = (code) => (v) => { const f = flag(v, code); return f ? f.penalty : 0; };
  const rule = (id, label, inp, when, code) => ifNode(id, label, inp, when, raised(code), penalty(code), () => 0,
    { note: 'raises ' + code });
  opsOf('RISK FLAGS', [
    rule('age', 'NEW POOL', [api('/raw/<chain>/market.json', 'POOL AGE')], 'pool under 2h → 4, under 24h → 2', 'NEW_POOL'),
    rule('src', 'SINGLE SOURCE', [api('/raw/<chain>/market.json', 'PRICE, 2 SOURCES')], 'fewer than 2 price sources agree → 3', 'SINGLE_SOURCE'),
    rule('liq', 'THIN LIQUIDITY', [api('/raw/<chain>/market.json', 'LIQUIDITY')], 'liquidity under $50K → 4', 'THIN_LIQUIDITY'),
    rule('turn', 'EXTREME TURNOVER', [api('/raw/<chain>/market.json', 'VOLUME / LIQUIDITY')], '24h volume over 20x liquidity → 3', 'EXTREME_TURNOVER'),
    rule('conc', 'VOLUME CONCENTRATED', [ref('pipe', 'TOP-5 WALLET SHARE')], 'top-5 wallets over 70% → 4', 'VOLUME_CONCENTRATED'),
    rule('safe', 'CONTRACT CHECKS', [ref('pipe', 'Contract safety')], 'under 100 → 3, under 70 → 6', 'CONTRACT_CHECKS'),
    rule('org', 'LOW ORGANIC FLOW', [ref('pipe', 'Organic flow')], 'under 40 → 3 (Jupiter only → 2)', 'LOW_ORGANIC_FLOW'),
    rule('dis', 'ORGANIC DISAGREEMENT', [ref('pipe', 'Organic flow'), api('/raw/<chain>/market.json', 'JUPITER STATS')], 'ours and Jupiter’s disagree → 0', 'ORGANIC_DISAGREEMENT'),
    rule('eth', 'ETHOS REPUTATION', [ref('pipe', 'PROJECT REPUTATION')], 'project account below the 1200 start → 0', 'ETHOS_REPUTATION'),
    node('count', 'COUNT', 'RISK FLAGS', ['@age', '@src', '@liq', '@turn', '@conc', '@safe', '@org', '@dis', '@eth'],
      (v) => { const s = S(v); if (!s) return null; const f = s.riskFlags || []; return f.length ? f.map((x) => x.code + ' ' + x.penalty).join(' · ') : 'none raised'; },
      null),
  ]);
}

// SURVIVAL and PROJECT REPUTATION are ONE operator each.
tag('SURVIVAL', { opSpec: node('div', '÷', 'SURVIVAL', [api('/raw/<chain>/market.json', 'POOL AGE')],
  (v) => { const h = (S(v) || {}).poolAgeHours; return fin(h) ? rnd(h, 1) + ' h ÷ 24' : null; }, null) });
tag('PROJECT REPUTATION', { opSpec: ifNode('if', 'PROJECT REPUTATION', [api('/raw/ethos.json', 'ETHOS (PROJECT X)')],
  'Ethos has a record (score above 0)',
  (v) => { const e = v && v.ethos; if (!e) return null; return Boolean(e.linked && e.score > 0); },
  (v) => v.ethos.score, () => 'left out (no record is not a bad one)') });


// WEIGHTED AVERAGES - RAW, Wallet quality, Organic flow - are not a box type
// of their own: they are standard operations, so each is a GROUP of them.
// One × per part (its value × its weight), a SUM of the products, a SUM of
// the weights of the parts that HAVE a value, and a ÷. A part with no value
// is left out of both sums - which is what stops a missing input dragging
// the average down.
const weightedOps = (label, defs, partsOf, opts) => {
  const o = opts || {};
  const partOf = (v, d) => {
    let ps = [];
    try { ps = partsOf(v) || []; } catch (e) { ps = []; }
    const p = ps.find((x) => String(x.label).toLowerCase() === String(d.label).toLowerCase());
    return p && fin(p.value) ? { value: p.value, weight: fin(p.weight) ? p.weight : d.weight } : null;
  };
  const used = (v) => defs.map((d) => partOf(v, d)).filter(Boolean);
  const total = (v) => used(v).reduce((s, x) => s + x.value * x.weight, 0);
  const weights = (v) => used(v).reduce((s, x) => s + x.weight, 0);
  const mids = defs.map((d, i) => '@m' + i);
  const nodes = defs.map((d, i) => node('m' + i, '×', d.label + ' × weight', [d.from].concat(d.weightFrom ? [d.weightFrom] : []),
    (v) => { const x = partOf(v, d); return x ? x.value + ' × ' + x.weight : 'no value - left out of both sums'; },
    (v) => { const x = partOf(v, d); return x ? rnd(x.value * x.weight, 1) : null; }));
  nodes.push(node('sum', 'SUM', 'WEIGHTED SUM', mids,
    (v) => { const u = used(v); return u.length ? u.map((x) => rnd(x.value * x.weight, 1)).join(' + ') : null; },
    (v) => (used(v).length ? rnd(total(v), 1) : null)));
  nodes.push(node('weights', 'SUM', 'WEIGHTS USED', mids,
    (v) => { const u = used(v); return u.length ? u.map((x) => x.weight).join(' + ') + (u.length < defs.length ? '   (' + (defs.length - u.length) + ' left out)' : '') : null; },
    (v) => (used(v).length ? weights(v) : null)));
  nodes.push(node('div', '÷', o.after ? 'WEIGHTED MEAN' : label, ['@sum', '@weights'],
    (v) => (used(v).length ? rnd(total(v), 1) + ' ÷ ' + weights(v) : null),
    o.after ? (v) => (used(v).length ? rnd(total(v) / weights(v), 1) : null) : null));
  (o.after || []).forEach((n) => nodes.push(n));
  opsOf(label, nodes);
  return { total, weights, used };
};


// Wallet quality: four parts, then the adjustments (insiders, a serial
// creator, locked liquidity) multiply the mean.
{
  const q = (v) => ((S(v) || {}).walletQuality) || {};
  weightedOps('Wallet quality', [
    { label: 'Holder spread', weight: 35, from: api('/raw/<chain>/intel.json', 'TOP HOLDERS SHARE') },
    { label: 'Crowd independence', weight: 30, from: ref('pipe', 'WALLET SAMPLE') },
    { label: 'Volume spread', weight: 20, from: ref('pipe', 'WALLET SAMPLE') },
    { label: 'Position intent', weight: 15, from: ref('pipe', 'WALLET SAMPLE') },
  ], (v) => q(v).parts || [], {
    after: [node('adj', '×', 'Wallet quality', ['@div', api('/raw/<chain>/intel.json', 'LP / CREATOR / INSIDERS'),
      api('/raw/<chain>/market.json', 'JUPITER STATS')],
      (v) => {
        const mods = q(v).modifiers || [];
        if (!mods.length) return 'no adjustment (× 1)';
        return mods.map((m) => '× ' + rnd(1 + m.effect / 100, 2) + ' (' + m.label + ')').join(' ');
      }, null, { note: 'Insiders × 0.75 · a creator with 20+ tokens × 0.8 · LP over 90% locked × 1.15, then capped at 100.' })],
  });
}

// Organic flow: four parts from our own wallet sample - and when there is no
// sample of our own, Jupiter's organicScore instead.
{
  const o = (v) => ((S(v) || {}).organicFlow) || {};
  weightedOps('Organic flow', [
    { label: 'Crowd spread', weight: 30, from: ref('pipe', 'WALLET SAMPLE') },
    { label: 'Volume spread', weight: 25, from: ref('pipe', 'WALLET SAMPLE') },
    { label: 'Churn-free', weight: 25, from: ref('pipe', 'WALLET SAMPLE') },
    { label: 'Entry independence', weight: 20, from: ref('pipe', 'WALLET SAMPLE') },
  ], (v) => o(v).parts || [], {
    after: [ifNode('if', 'Organic flow', ['@div', api('/raw/<chain>/market.json', 'JUPITER STATS')],
      'we have a wallet sample of our own',
      (v) => (S(v) ? o(v).basis !== 'jupiter' : null),
      (v) => valueOf(modOf(v, 'organicFlow')),
      (v) => valueOf(modOf(v, 'organicFlow')),
      { note: 'ELSE: Jupiter’s organicScore, a borrowed number we cannot break down.' })],
  });
}

// VETO LOG is one operator: an OR over the gates.
tag('VETO LOG', { opSpec: { sym: 'OR', label: 'VETO LOG', cond: {
  kind: 'OR', when: 'any gate says VETO',
  terms: (v) => Object.keys(GATE_TESTS).map((k) => { const g = gateOf(v, k); return { label: k, ok: g ? !g.ok : null }; }),
} } });

// Memory: boxes that keep state between polls.
tag('WALLET SAMPLE', { memory: 'the wallet service keeps each pool’s sample between polls',
  service: { every: '5s', keeps: 'each pool’s wallet sample between polls', costs: 'nothing - it re-reads the trade samples' } });

// Parameters: the constants the model is tuned by, as boxes of their own.
const param = (key) => {
  const p = PARAMS[key];
  return {
    label: p.label, status: 'live', calc: [], note: p.note,
    param: { id: paramId(key), def: p.def, step: p.step, min: p.min, max: p.max },
    value: () => paramValue(key),
    where: 'flow/score-flow.js SAFETY_RULES',
  };
};
PAGES.pipe.groups.splice(PAGES.pipe.groups.findIndex((g) => g.stage === 3), 0, {
  group: 'PARAMETERS', stage: 3,
  note: 'Every number the model is tuned by, in one place.',
  fields: [...Object.keys(PARAMS).map(param)],
})


/* ================================================================ EARLY === */

/*
 * EARLY - the early-entry score, beside the board's (calculations/early.js).
 * Its own column of boxes at every stage: MEASURES read from the pool's
 * sample history, the ENGINE's seven band-curve inputs, its WEIGHT and floor
 * parameters, and the SCORE - a safety-only veto and a weighted mean. The
 * same boxes run in flow/score-flow.js, so cutting a wire here changes EARLY
 * exactly as it would the board's score. It is recorded every minute and
 * graded in Evaluation; it does not rank the board.
 */
// The model's result carries EARLY at the top level (flow/score-flow.js flowScore).
const E = (v) => { const s = S(v); return s ? { score: s.score, raw: s.rawScore, vetoed: s.vetoed, breakdown: s.scoreModel, measures: s.measures } : null; };
const EM = (v) => (E(v) || {}).measures || {};
const ePart = (v, key) => ((E(v) || {}).breakdown || []).find((p) => p.key === key) || null;
const WHERE_EARLY = 'flow/score-flow.js';
const earlyWeightNow = (c) => getSetting(weightId(c.key), { n: c.weight }).n;
const bandText = (pts, unit) => pts.map(([x, y]) => rnd(x * 100, 1) + unit + ' → ' + y).join(', ');
const pctBox = (key) => (v) => { const x = EM(v)[key]; return fin(x) ? pct(x, 2) : null; };
const xBox = (key) => (v) => { const x = EM(v)[key]; return fin(x) ? rnd(x, 2) + 'x' : null; };

const EARLY_MEASURE_FIELDS = [
  { label: 'ABOVE 6H LOW', value: pctBox('aboveLow6hPct'),
    calc: [api('/raw/<chain>/history.json', 'POOL SAMPLES'), op('( price now ÷ lowest price of the last 6h − 1 ) × 100')],
    note: 'Needs an hour of samples. How much of a move has already happened.' },
  { label: 'BELOW 6H HIGH', value: pctBox('belowHigh6hPct'),
    calc: [api('/raw/<chain>/history.json', 'POOL SAMPLES'), op('( price now ÷ highest price of the last 6h − 1 ) × 100')],
    note: 'Needs an hour of samples. 0 = at the high.' },
  { label: 'RANGE 1H', value: pctBox('range1hPct'),
    calc: [api('/raw/<chain>/history.json', 'POOL SAMPLES'), op('( highest − lowest ) ÷ lowest × 100, over the last hour')],
    note: 'Needs 30 minutes of samples. 0 = nothing is trading.' },
  { label: 'BUYS PER BUYER', value: xBox('buysPerBuyer'),
    calc: [api('/raw/<chain>/history.json', 'POOL SAMPLES'), op('mean buys 5m ÷ mean buyers 5m, last 15 minutes')] },
  { label: 'VOLUME 15M vs 1H', value: xBox('volAccel'),
    calc: [api('/raw/<chain>/history.json', 'POOL SAMPLES'), op('mean volume 5m over 15 minutes ÷ over the last hour')] },
  { label: 'BUYERS 1H vs 6H', value: xBox('buyerTrend'),
    calc: [api('/raw/<chain>/history.json', 'POOL SAMPLES'), op('mean buyers 5m over 1 hour ÷ over 6 hours')],
    note: 'Needs 2 hours of samples.' },
  { label: 'HOLDER COUNT', value: (v) => { const x = EM(v).holders; return fin(x) ? count(x) : null; },
    calc: [api('/raw/<chain>/intel.json', 'HOLDERS'), op('count, else'), api('/raw/<chain>/market.json', 'JUPITER STATS'), op('holderCount')] },
].map((f) => ({ status: 'live', where: WHERE_EARLY + ' earlyMeasures()', ...f }));

const EARLY_INPUT_SPEC = {
  earlyRoom: { from: 'ABOVE 6H LOW', unit: '%', curve: 'room',
    how: 'a little above the low scores full; at the low, less (still falling?); far above it the move has been had' },
  earlyHolding: { from: 'BELOW 6H HIGH', unit: '%', curve: 'holding',
    how: 'a few percent under the high scores full; deep under it the run is over' },
  earlyWaking: { from: 'RANGE 1H', unit: '%', curve: 'waking',
    how: 'a tape that has started to move scores full; flat is nothing happening, wild is a coin flip' },
  earlySeasoning: { from: 'POOL AGE', raw: true,
    how: 'log curve: ' + EARLY_CURVES.ageLoHours + 'h → 0, ' + EARLY_CURVES.ageHiHours / 24 + ' days → 100' },
  earlyHolders: { from: 'HOLDER COUNT',
    how: 'log curve: ' + EARLY_CURVES.holdersLo + ' → 0, ' + EARLY_CURVES.holdersHi.toLocaleString() + ' → 100' },
  earlyInterest: { from: ['VOLUME 15M vs 1H', 'BUYERS 1H vs 6H'],
    how: 'mean of multipleScore(each) = 100 × clamp( 0.5 + 0.3 × log10 multiple )' },
  earlyRepeat: { from: 'BUYS PER BUYER',
    how: EARLY_CURVES.repeatLo + ' buy each → 0, ' + EARLY_CURVES.repeatHi + ' each → 100' },
};
const EARLY_ENGINE_FIELDS = EARLY_MODEL.map((c) => {
  const spec = EARLY_INPUT_SPEC[c.key];
  const froms = [].concat(spec.from).map((l) => (spec.raw ? api('/raw/<chain>/market.json', l) : ref('pipe', l)));
  const shape = spec.curve ? 'band: ' + bandText(EARLY_CURVES[spec.curve], spec.unit) : spec.how;
  return {
    label: c.label, status: 'live',
    weight: c.weight + '%',
    value: (v) => valueOf(ePart(v, c.key)),
    calc: froms.concat([op('→ ' + shape)]),
    equation: (v) => {
      const part = ePart(v, c.key);
      if (!S(v)) return null;
      if (!part || part.pending) return 'no value - its measure needs more sample history';
      const inputs = [].concat(spec.from).map((l) => {
        if (l === 'POOL AGE') { const h = (S(v) || {}).poolAgeHours; return fin(h) ? Math.round(h) + 'h old' : null; }
        const f = EARLY_MEASURE_FIELDS.find((x) => x.label === l);
        return f ? l + ' ' + f.value(v) : null;
      }).filter(Boolean);
      return inputs.join(', ') + ' → ' + part.value;
    },
    note: spec.how.charAt(0).toUpperCase() + spec.how.slice(1) + '.',
    measured: () => measuredBadge(c.label),
    where: WHERE_EARLY + ' earlyParts()',
  };
});

const EARLY_SCORE_FIELDS = [
  {
    label: 'EARLY RAW', status: 'live',
    value: (v) => { const e = E(v); return e && fin(e.raw) ? e.raw : null; },
    calc: [op('[')]
      .concat(...EARLY_MODEL.map((c, i) => [op((i ? '+ ' : '') + '('), ref('pipe', c.label), op('×'), num(c.weight), op(')')]))
      .concat([op('] ÷ [ the weights of the inputs that have a value ] - nothing under ' + EARLY_MIN_PARTS + ' inputs')]),
    equation: (v) => {
      const e = E(v); if (!e) return null;
      const used = (e.breakdown || []).filter((p) => !p.pending && fin(p.value));
      if (used.length < EARLY_MIN_PARTS) return used.length + ' of ' + EARLY_MODEL.length + ' inputs - too few to call an entry';
      const sum = used.reduce((a, p) => a + p.value * p.weight, 0);
      const w = used.reduce((a, p) => a + p.weight, 0);
      return '[ ' + used.map((p) => '(' + p.value + ' × ' + p.weight + ')').join(' + ') + ' ] ÷ [ ' +
        used.map((p) => p.weight).join(' + ') + ' ] = ' + Math.round(sum) + ' ÷ ' + w + ' = ' + e.raw;
    },
    where: WHERE_EARLY + ' earlyScore()',
  },
  {
    label: 'EARLY SCORE', status: 'live',
    value: (v) => { const e = E(v); return e && fin(e.score) ? e.score : null; },
    calc: [op('if'), ref('pipe', 'VETO LOG'), op('has a failed safety gate → 0, else'), ref('pipe', 'EARLY RAW')],
    equation: (v) => { const e = E(v); if (!e || !fin(e.score)) return null; return e.vetoed ? 'a safety gate failed → 0' : 'safe → ' + e.score; },
    note: 'The model’s entry score: has it started to move without having run yet. It ranks the board ' +
      'inside each signal and decides when a WAKING token is a BUY.',
    measured: () => measuredBadge('EARLY SCORE'),
    where: 'flow/score-flow.js EARLY SCORE',
  },
];

{
  const groups = PAGES.pipe.groups;
  const after = (name) => groups.findIndex((g) => g.group === name) + 1;
  groups.splice(after('MEASURES'), 0, {
    group: 'EARLY MEASURES', stage: 2, flat: true,
    note: 'What EARLY reads: where the price sits in its own recent range, how lively the tape is, who is buying.',
    fields: EARLY_MEASURE_FIELDS,
  });
  groups.splice(after('CONTEXT'), 0, {
    group: 'CYCLE ENGINE', stage: 3, parent: 'eng:engines', engine: 'cycle',
    note: 'Will a buy now pay over the next 6-24 hours? Bands, not "more is better": the archive ' +
      'showed the trades that paid sat between a dead tape and one that had already run.',
    fields: EARLY_ENGINE_FIELDS.concat(EARLY_SCORE_FIELDS),
  });
  const params = groups.find((g) => g.group === 'PARAMETERS');
  if (params) {
    EARLY_MODEL.forEach((c) => params.fields.push({
      label: weightLabel(c), status: 'live', calc: [],
      note: c.label + '’s weight in EARLY RAW.',
      param: { id: weightId(c.key), def: c.weight, step: 1, min: 0 },
      value: () => earlyWeightNow(c),
      where: WHERE_EARLY + ' EARLY_MODEL',
    }));
  }
}

// Who reads the raw readings EARLY uses (see RELAY_CONSUMERS above).

// EARLY RAW is a weighted mean like RAW: × per input, two SUMs, a ÷.
{
  const er = weightedOps('EARLY RAW',
    EARLY_MODEL.map((c) => ({ label: c.label, weight: c.weight, from: ref('pipe', c.label), weightFrom: ref('pipe', weightLabel(c)) })),
    (v) => ((E(v) || {}).breakdown || []).map((p) => ({ label: p.label, value: p.pending ? null : p.value, weight: earlyWeightNow(p) })));
  const f = fieldBy('EARLY RAW');
  if (f) {
    const scoreValue = f.value;
    f.value = (v) => {
      if (!EARLY_MODEL.some((c) => earlyWeightNow(c) !== c.weight)) return scoreValue(v);
      return er.used(v).length >= EARLY_MIN_PARTS ? Math.round(er.total(v) / er.weights(v)) : null;
    };
  }
}
tag('EARLY SCORE', { decision: { test: (v) => { const e = E(v); return e && fin(e.score) ? !e.vetoed : null; }, yes: 'SAFE → EARLY RAW', no: 'UNSAFE → 0' } });
// The band curves, with this token's point on them.
[['Room to run', 'room', 'aboveLow6hPct', 0, 20, (x) => x], ['Holding highs', 'holding', 'belowHigh6hPct', 0, 30, (x) => Math.abs(Math.min(0, x))],
  ['Waking tape', 'waking', 'range1hPct', 0, 15, (x) => x]].forEach(([label, curve, key, lo, hi, xf]) => tag(label, { curve: {
  f: (x) => band(x / 100, EARLY_CURVES[curve]),
  x: (v) => { const m = EM(v)[key]; return fin(m) ? xf(m) : null; },
  lo, hi, log: false, xFmt: (n) => rnd(n, 1) + '%',
} }));
tag('Seasoning', { curve: {
  f: (h) => logScore(Math.max(h, 1), EARLY_CURVES.ageLoHours, EARLY_CURVES.ageHiHours),
  x: (v) => (S(v) || {}).poolAgeHours, lo: 1, hi: 2000, log: true, xFmt: (h) => rnd(h / 24, 1) + 'd',
} });


/* ======================================================= PHASE & SIGNAL === */

/*
 * Where the token is in its attention cycle, and what the main page tells
 * you to do about it (calculations/phase.js). Memes get one burst of
 * attention and the price peak is that burst - so the phase decides between
 * buying before it and getting out at it. The board's score is still
 * computed above; the main page shows this instead.
 */
// The call, from the model's result (flow/score-flow.js flowScore).
const SG = (v) => {
  const s = S(v);
  if (!s) return null;
  const smart = s.smart || {};
  return { signal: s.signal, why: s.signalWhy, phase: s.phase, phaseWhy: s.phaseWhy,
    smartBuyers: smart.buyers, smartSellers: smart.sellers, shortable: s.shortable, plan: s.plan };
};
export const PLAN_PARAMS = {
  targetPct: { label: 'TARGET (%)', note: 'Take profit this far in the trade’s favour.' },
  stopPct: { label: 'STOP (%)', note: 'Cut the trade this far against it.' },
  tradeUsd: { label: 'TRADE SIZE ($)', note: 'The size every trade plan and EXECUTION COST is figured at. The TRADE SIZE chips in the main page’s TRADE PLAN panel set this box.' },
  maxCostPct: { label: 'MAX ROUND-TRIP COST (%)', note: 'A BUY needs a round trip (in and out) at or under this at the trade size - the pool must be able to take the trade.' },
  horizonHours: { label: 'HORIZON (h)', note: 'THE TIME FRAME: how long a call is held. Unset is AUTO, 6h for every engine (it held up best on unseen hours); or 1, 2, 6, 12 or 24, and target and stop size to it. The TIME FRAME chips in the main page’s TRADE PLAN panel set this box.' },
};
export const PHASE_PARAMS = {
  runPct: { label: 'RAN (% over 6h low)', note: 'At or over this the token has run: PEAKING, or FADING once off the high.' },
  fadeOffHighPct: { label: 'FADED (% under 6h high)', note: 'After a run, this far under the high the burst is over: FADING.' },
  runningPct: { label: 'RUNNING (% over 6h low)', note: 'At or over this (and under RAN) the move is under way.' },
  quietRangePct: { label: 'QUIET (1h range %)', note: 'A last-hour range under this is a flat tape: QUIET.' },
  smartExitSellers: { label: 'SMART EXIT (sellers)', note: 'This many smart wallets selling after a move counts as PEAKING.' },
  buyMinEarly: { label: 'BUY needs EARLY ≥', note: 'A WAKING token is a BUY only with at least this EARLY score.' },
  buyHoldEarly: { label: 'BUY holds while EARLY ≥', note: 'The hold rule: a BUY stays a BUY while still WAKING, safe, and EARLY at or over this - so a token on the BUY line does not flicker.' },
  buyQuietHoldMin: { label: 'BUY holds through QUIET (min)', note: 'The hold rule: a BUY also holds through a QUIET spell for this long after its last real BUY - the tape paused, nothing broke.' },
  holdMemoryMin: { label: 'HOLD MEMORY (min)', note: 'The previous call is forgotten after this long without a fresh one.' },
};
const phaseParamId = (key) => 'param:phase.' + key;
const phaseParamNow = (key) => getSetting(phaseParamId(key), { n: PHASE_RULES[key] }).n;

const SMART_FIELDS = [
  { label: 'SMART BUYERS 1H', value: (v) => { const x = (SG(v) || {}).smartBuyers; return fin(x) ? x : null; },
    calc: [api('/raw/<chain>/trades.json', 'TRADE SAMPLE'), op('distinct buyers in the last hour that are on'), api('/raw/smart-wallets.json', 'SMART LIST')],
    note: 'Nothing when the sample does not reach back an hour. On its own a smart buy did not predict a rise - they buy what is already moving.' },
  { label: 'SMART SELLERS 1H', value: (v) => { const x = (SG(v) || {}).smartSellers; return fin(x) ? x : null; },
    calc: [api('/raw/<chain>/trades.json', 'TRADE SAMPLE'), op('distinct sellers in the last hour that are on'), api('/raw/smart-wallets.json', 'SMART LIST')],
    note: 'Smart wallets taking profit after a move is an exit sign.' },
  { label: 'PERP LISTED', value: (v) => { const x = (SG(v) || {}).shortable; return x === true ? 'yes' : x === false ? 'no' : null; },
    calc: [api('/raw/perps.json', 'PERP VENUES'), op('lists this ticker on any venue')],
    note: 'Matched by ticker, not contract - a shared ticker can match the wrong asset. Decides SELL vs SHORT.' },
].map((f) => ({ status: 'live', where: 'flow/score-flow.js SMART BUYERS / SELLERS', ...f }));

const SIGNAL_FIELDS = [
  {
    label: 'PHASE', status: 'live',
    value: (v) => (SG(v) || {}).phase || null,
    calc: [ref('pipe', 'ABOVE 6H LOW'), ref('pipe', 'BELOW 6H HIGH'), ref('pipe', 'RANGE 1H'), ref('pipe', 'SMART SELLERS 1H'),
      op('→ QUIET · WAKING · RUNNING · PEAKING · FADING, by'), ref('pipe', PHASE_PARAMS.runPct.label),
      ref('pipe', PHASE_PARAMS.fadeOffHighPct.label), ref('pipe', PHASE_PARAMS.runningPct.label),
      ref('pipe', PHASE_PARAMS.quietRangePct.label), ref('pipe', PHASE_PARAMS.smartExitSellers.label)],
    equation: (v) => { const s = SG(v); return s ? (s.phase || 'none') + ' - ' + (s.phaseWhy || '') : null; },
    note: 'ran ≥ RAN: FADING if ≥ FADED under the high, else PEAKING · smart exit after a move: PEAKING · ' +
      '≥ RUNNING: RUNNING · range under QUIET: QUIET · else WAKING.',
    measured: (v) => outcomeBadge('phases', (SG(v) || {}).phase),
    where: 'flow/score-flow.js PHASE',
  },
  {
    label: 'SIGNAL', status: 'live',
    value: (v) => (SG(v) || {}).signal || null,
    calc: [ref('pipe', 'PHASE'), ref('pipe', 'EARLY SCORE'), ref('pipe', 'VETO LOG'), ref('pipe', 'PERP LISTED'),
      ref('pipe', 'SMART BUYERS 1H'), op('→ BUY · SELL · SHORT · AVOID · WATCH, with'), ref('pipe', PHASE_PARAMS.buyMinEarly.label)],
    equation: (v) => { const s = SG(v); return s ? (s.signal || 'none') + ' - ' + (s.why || '') : null; },
    note: 'WAKING + EARLY ≥ the BUY bar + every safety gate passed → BUY · PEAKING → SHORT when a perp lists it, else SELL · ' +
      'FADING → AVOID · anything else → WATCH. HOLD: a BUY stays while still WAKING and EARLY ≥ the hold line, or for a while through a QUIET pause; SELL / SHORT stay while still RUNNING. This is what the main page shows.',
    measured: (v) => outcomeBadge('signals', (SG(v) || {}).signal),
    memory: 'remembers each token’s last call, for the hold rule',
    where: 'flow/score-flow.js SIGNAL',
  },
  {
    label: 'TRADE PLAN', status: 'live',
    value: (v) => { const p = (SG(v) || {}).plan; return p ? p.side + ' ' + p.targetPct + '/' + p.stopPct : null; },
    calc: [ref('pipe', 'SIGNAL'), api('/raw/<chain>/market.json', 'PRICE, 2 SOURCES'), ref('pipe', 'EXECUTION COST'), op('→ entry; target and stop at'),
      ref('pipe', PLAN_PARAMS.targetPct.label), ref('pipe', PLAN_PARAMS.stopPct.label), op('within'), ref('pipe', PLAN_PARAMS.horizonHours.label)],
    equation: (v) => {
      const p = (SG(v) || {}).plan;
      if (!p) return S(v) ? 'no trade: the call is ' + ((SG(v) || {}).signal || 'none') : null;
      const fmt = (n) => (n >= 1 ? n.toFixed(4) : n.toPrecision(4));
      return p.side + ' at ' + fmt(p.entry) + ' · target ' + fmt(p.target) + ' · stop ' + fmt(p.stop) + ' · ' + p.horizonHours + 'h';
    },
    note: 'The trade the signal is graded on in Evaluation: BUY is a long, SELL an exit, SHORT a short.',
    where: 'flow/score-flow.js TRADE PLAN',
  },
];

{
  const groups = PAGES.pipe.groups;
  const after = (name) => groups.findIndex((g) => g.group === name) + 1;
  groups.splice(after('EARLY MEASURES'), 0, {
    group: 'SMART MONEY', stage: 2, flat: true,
    note: 'Who is trading it: learned smart wallets, and whether it can be shorted anywhere.',
    fields: SMART_FIELDS,
  });
  groups.splice(after('WARNINGS'), 0, {
    group: 'PHASE & SIGNAL', stage: 5, flat: true,
    note: 'Where it is in its attention cycle, and the call: buy before the peak, get out at it.',
    fields: SIGNAL_FIELDS,
  });
  const params = groups.find((g) => g.group === 'PARAMETERS');
  if (params) Object.keys(PLAN_PARAMS).forEach((key) => params.fields.push({
    label: PLAN_PARAMS[key].label, status: 'live', calc: [], note: PLAN_PARAMS[key].note,
    // Unset, each shows what the plan uses now: the engine's window and that frame's sizes.
    param: { id: 'param:plan.' + key, def: tradePlanRules()[key], step: key === 'tradeUsd' ? 250 : key === 'maxCostPct' ? 0.25 : 1, min: key === 'maxCostPct' ? 0.25 : 1 },
    value: () => tradePlanRules()[key],
    where: 'flow/score-flow.js tradePlanRules, TIME_FRAMES',
  }));
  if (params) Object.keys(PHASE_PARAMS).forEach((key) => params.fields.push({
    label: PHASE_PARAMS[key].label, status: 'live', calc: [], note: PHASE_PARAMS[key].note,
    param: { id: phaseParamId(key), def: PHASE_RULES[key], step: key === 'smartExitSellers' ? 1 : (key === 'quietRangePct' ? 0.25 : 1), min: 0 },
    value: () => phaseParamNow(key),
    where: 'flow/score-flow.js PHASE_RULES',
  }));
}
tag('PERP LISTED', { decision: { test: (v) => { const x = (SG(v) || {}).shortable; return x === true ? true : x === false ? false : null; }, yes: 'LISTED', no: 'NONE' } });

/*
 * ENGINES - six ways to call an entry (flow/score-flow.js ENGINES). Each is a
 * group in ENGINES on the map: its own score and its own call. They share
 * PHASE for the exits (PEAKING → SELL / SHORT, FADING → AVOID) and differ on
 * what says "buy now". The active profile (the FLOW picker, top right) picks
 * the engine whose call is SIGNAL: SIGNAL is wired to that engine alone, so
 * each profile's map is its own flow. Every engine still runs on every token,
 * so the backtest and the trail grade all six side by side.
 */
const EN = (v) => (S(v) || {}).engines || {};
const engineOf = (key) => ENGINES.find((e) => e.key === key);
const engineParamId = (key) => 'param:engine.' + key;
const engineParamNow = (key) => getSetting(engineParamId(key), { n: ENGINE_RULES[key] }).n;
const lineLabel = (key, which) => engineOf(key).label + (which === 'Buy' ? ' BUY ≥' : ' HOLDS ≥');
const callField = (e, lines) => ({
  label: e.call, status: 'live',
  value: (v) => (EN(v)[e.key] || {}).signal || null,
  calc: [ref('pipe', 'PHASE'), ref('pipe', e.score), ref('pipe', 'ABOVE 6H LOW'), ref('pipe', 'VETO LOG'), ref('pipe', 'PERP LISTED'),
    ref('pipe', 'EXECUTION COST'), ref('pipe', 'MAX ROUND-TRIP COST (%)')]
    .concat(ROTATION_FAMILY_KEYS.indexOf(e.key) !== -1 ? [ref('pipe', 'MARKET NET FLOW 2H'), ref('pipe', 'ROTATION VETO ($ leaving)')] : [])
    .concat([op('→ BUY · SELL · SHORT · AVOID · WATCH, by')]).concat(lines.map((l) => ref('pipe', l))),
  equation: (v) => { const x = EN(v)[e.key]; return x ? (x.signal || 'none') + ' - ' + (x.why || '') : null; },
  note: (e.key === 'cycle' ? 'WAKING' : 'WAKING, or RUNNING under the late-entry cap,') + ' + score ≥ its BUY line + safe + the pool can take the trade (EXECUTION COST ≤ the cap)' +
    (ROTATION_FAMILY_KEYS.indexOf(e.key) !== -1 ? ' + capital not leaving the pool (MARKET NET FLOW 2H over the veto)' : '') + ' → BUY; ' +
    'holds while the score stays ≥ its HOLD line. PEAKING → SELL / SHORT, FADING → AVOID, as every engine.',
  measured: () => engineBadge(e.key),
  memory: 'remembers this engine’s last call per token, for the hold rule',
  where: 'flow/score-flow.js ' + e.call,
});
const engineLines = (key) => [lineLabel(key, 'Buy'), lineLabel(key, 'Hold'), 'LATE ENTRY CAP (% over 6h low)'];
const scoreField = (label, calc, note, key) => ({
  label, status: 'live', value: (v) => { const x = (EN(v)[key] || {}).score; return fin(x) ? x : null; },
  calc, note, where: 'flow/score-flow.js ' + label,
});
/** Market rotation is TIDE's alone (score-flow.js ROTATION_FAMILY). */
const ROTATION_FAMILY_KEYS = ['tide'];
/** The engines that read the market directly; the rest combine their scores. */
const BASE_KEYS = ['cycle', 'momentum', 'smart', 'flow', 'rotation'];
const ENGINE_GROUPS = [
  { key: 'momentum', fields: [
    scoreField('MOMENTUM SCORE', [ref('pipe', 'VOLUME 15M vs 1H'), op('on 1× → 0 … 2.5× → 100, × 0.6 +'), ref('pipe', 'BUYERS 1H vs 6H'), op('on 1× → 0 … 2× → 100, × 0.4')],
      'Volume coming in: the last 15 minutes against the hour, and buyers this hour against the 6h.', 'momentum')] },
  { key: 'smart', fields: [
    scoreField('SMART SCORE', [ref('pipe', 'SMART BUYERS 1H'), op('× 30 −'), ref('pipe', 'SMART SELLERS 1H'), op('× 30, 0-100')],
      'Learned smart wallets buying it this hour, net of the ones selling.', 'smart')] },
  { key: 'flow', fields: [
    scoreField('ORDER FLOW SCORE', [ref('pipe', 'NET FLOW RATIO'), op('on 0 → 0 … 0.5 → 100; × 0.5 when'), ref('pipe', 'BUYS PER BUYER'),
      op('> 4 (wash); × 0.5 when'), ref('pipe', 'Organic flow'), op('< 40')],
      'Net buying in the sampled tape, discounted when it looks washed or inorganic.', 'flow')] },
  { key: 'rotation', fields: [
    { label: 'WALLET TAPE', status: 'live', value: () => null,
      calc: [api('/raw/<chain>/trades.json', 'TRADE SAMPLE'), op('every pool’s sampled trades, indexed by wallet')],
      note: 'Wallets seen in any pool’s tape on this chain - what ROTATION looks each buyer up in.', where: 'flow/score-flow.js WALLET TAPE' },
    { label: 'ROTATING IN 1H', status: 'live', value: () => null,
      calc: [ref('pipe', 'TRADE SAMPLE'), ref('pipe', 'WALLET TAPE'), op('buyers this hour who sold another token in the last 2h')],
      note: 'Capital arriving from other tokens.', where: 'flow/score-flow.js ROTATING IN 1H' },
    { label: 'ROTATING OUT 1H', status: 'live', value: () => null,
      calc: [ref('pipe', 'TRADE SAMPLE'), ref('pipe', 'WALLET TAPE'), op('sellers this hour who bought another token in the last 2h')],
      note: 'Capital leaving for other tokens.', where: 'flow/score-flow.js ROTATING OUT 1H' },
    { label: 'ROTATION NET USD', status: 'live', value: () => null,
      calc: [ref('pipe', 'TRADE SAMPLE'), ref('pipe', 'WALLET TAPE'), op('$ rotated in − $ rotated out')],
      note: 'Which way the money moved.', where: 'flow/score-flow.js ROTATION NET USD' },
    scoreField('ROTATION SCORE', [ref('pipe', 'ROTATING IN 1H'), op('−'), ref('pipe', 'ROTATING OUT 1H'), op('on 0 → 0 … 4 → 100; × 0.5 when'), ref('pipe', 'ROTATION NET USD'), op('< 0')],
      'More wallets rotating in than out, with the money behind them.', 'rotation')] },
  { key: 'blend', fields: [
    scoreField('BLEND SCORE', ENGINES.filter((e) => BASE_KEYS.indexOf(e.key) !== -1).map((e) => ref('pipe', e.score)).concat([op('→ 50 per engine over its own BUY line')]),
      'Agreement: each engine whose score clears its own BUY line is a vote.', 'blend')] },
  { key: 'rotconf', fields: [
    scoreField('ROTATION+ SCORE', ENGINES.filter((e) => BASE_KEYS.indexOf(e.key) !== -1).map((e) => ref('pipe', e.score)).concat([op('→ ROTATION SCORE when another engine is over its BUY line, else half')]),
      'Rotation that another engine agrees with: in the archive a confirmed BUY paid, a lone one did not.', 'rotconf')] },
  { key: 'consensus', fields: [
    scoreField('CONSENSUS SCORE', [ref('pipe', 'ROTATION SCORE'), ref('pipe', 'SMART SCORE'), ref('pipe', 'MOMENTUM SCORE'), op('→ 50 per engine over its own BUY line')],
      'Two of the three engines that graded best.', 'consensus')] },
  { key: 'rotliq', fields: [
    scoreField('ROTATION MID-LIQ SCORE', [ref('pipe', 'ROTATION SCORE'), ref('pipe', 'LIQUIDITY'), op('inside'), ref('pipe', 'LIQUIDITY BAND LOW ($)'), op('-'), ref('pipe', 'LIQUIDITY BAND HIGH ($)'), op('→ ROTATION SCORE, else 0')],
      'Rotation on the pools where it paid: neither the thinnest nor the deepest.', 'rotliq')] },
  { key: 'smartrot', fields: [
    scoreField('SMART ROTATION SCORE', [ref('pipe', 'ROTATION SCORE'), ref('pipe', 'SMART BUYERS 1H'), op('≥ 1 → ROTATION SCORE, else 0')],
      'Rotation with a learned smart wallet among the buyers.', 'smartrot')] },
  { key: 'tide', fields: [
    scoreField('TIDE SCORE', [ref('pipe', 'ROTATION SCORE'), ref('pipe', 'SMART SCORE'), ref('pipe', 'MOMENTUM SCORE'), ref('pipe', 'MARKET NET FLOW 2H'),
      op('→ ROTATION SCORE when SMART MONEY or MOMENTUM is over its line and capital is not leaving; half without agreement; 0 against the tide')],
      'Rotation with the market tide: the best-testing market-rotation engine (rotation + smart or volume agreeing + no capital leaving).', 'tide')] },
  { key: 'quality', fields: [
    scoreField('QUALITY ROTATION SCORE', [ref('pipe', 'ROTATION+ SCORE'), ref('pipe', 'LIQUIDITY'), op('inside the liquidity band → ROTATION+ SCORE, else 0')],
      'Every finding at once: rotation, confirmed, on a mid-liquidity pool.', 'quality')] },
];
{
  const groups = PAGES.pipe.groups;
  const cycle = groups.find((g) => g.group === 'CYCLE ENGINE');
  if (cycle) cycle.fields.push(callField(engineOf('cycle'), [PHASE_PARAMS.buyMinEarly.label, PHASE_PARAMS.buyHoldEarly.label]));
  let at = groups.findIndex((g) => g.group === 'CYCLE ENGINE') + 1;
  ENGINE_GROUPS.forEach((g) => {
    const e = engineOf(g.key);
    groups.splice(at, 0, { group: e.label + ' ENGINE', stage: 3, parent: 'eng:engines', engine: e.key, note: e.blurb,
      fields: g.fields.concat([callField(e, engineLines(e.key))]) });
    at += 1;
  });
  // Each profile shows which engine it runs: the group's name says so.
  groups.forEach((g) => {
    if (!g.engine) return;
    const name = g.group;
    Object.defineProperty(g, 'label', { configurable: true, enumerable: true,
      get: () => (activeEngine() === g.engine ? '★ ' + name + ' · ACTIVE' : name) });
  });

  // The engines' lines, as PARAMETERS boxes.
  const params = groups.find((g) => g.group === 'PARAMETERS');
  if (params) {
    ENGINES.filter((e) => e.key !== 'cycle').forEach((e) => ['Buy', 'Hold'].forEach((which) => {
      const key = e.key + which;
      params.fields.push({
        label: lineLabel(e.key, which), status: 'live', calc: [],
        note: which === 'Buy' ? e.label + ' calls BUY at or over this score.' : 'A ' + e.label + ' BUY holds while its score stays at or over this.',
        param: { id: engineParamId(key), def: ENGINE_RULES[key], step: 5, min: 0 },
        value: () => engineParamNow(key), where: 'flow/score-flow.js ENGINE_RULES',
      });
    }));
    [['liqLow', 'LIQUIDITY BAND LOW ($)', 'ROTATION MID-LIQ and QUALITY ROTATION buy only at or over this liquidity.'],
      ['liqHigh', 'LIQUIDITY BAND HIGH ($)', 'and at or under this.']].forEach(([key, label, note]) => params.fields.push({
      label, status: 'live', calc: [], note,
      param: { id: engineParamId(key), def: ENGINE_RULES[key], step: 50000, min: 0 },
      value: () => engineParamNow(key), where: 'flow/score-flow.js ENGINE_RULES',
    }));
    params.fields.push({
      label: 'ROTATION VETO ($ leaving)', status: 'live', calc: [],
      note: 'TIDE does not BUY while more than this has net left the pool for other pools over 2h (MARKET NET FLOW 2H). No other engine reads market rotation.',
      param: { id: engineParamId('rotVetoUsd'), def: ENGINE_RULES.rotVetoUsd, step: 50, min: 0 },
      value: () => engineParamNow('rotVetoUsd'), where: 'flow/score-flow.js ENGINE_RULES',
    });
    params.fields.push({
      label: 'LATE ENTRY CAP (% over 6h low)', status: 'live', calc: [],
      note: 'Every engine but CYCLE may also buy a RUNNING token, while it is up less than this on its 6h low.',
      param: { id: engineParamId('lateUpPct'), def: ENGINE_RULES.lateUpPct, step: 1, min: 0 },
      value: () => engineParamNow('lateUpPct'), where: 'flow/score-flow.js ENGINE_RULES',
    });
  }

  // MARKET ROTATION: the MARKET ROTATION tab's read of this pool, as measures.
  groups.splice(groups.findIndex((g) => g.group === 'SMART MONEY') + 1, 0, {
    group: 'MARKET ROTATION', stage: 2, flat: true,
    note: 'Capital moving between pools through shared wallets (the MARKET ROTATION tab), for this pool.',
    fields: [
      { label: 'MARKET NET FLOW 2H', status: 'live', value: () => null,
        calc: [ref('pipe', 'TRADE SAMPLE'), ref('pipe', 'WALLET TAPE'), op('per wallet here and in another pool: net buying here vs selling there arrives, the reverse leaves (min of the two) → arrived − left')],
        note: 'Read by TIDE only. On its own it did not predict; as a veto it did - rotation BUYs while capital was leaving lost money.',
        where: 'flow/score-flow.js MARKET NET FLOW 2H' },
      { label: 'CONNECTED POOLS 2H', status: 'live', value: () => null,
        calc: [ref('pipe', 'TRADE SAMPLE'), ref('pipe', 'WALLET TAPE'), op('other pools sharing a wallet with this one')],
        note: 'How tied into the market’s wallet network the pool is.', where: 'flow/score-flow.js CONNECTED POOLS 2H' },
    ],
  });
  // EXECUTION COST: the pool's depth against the trade size, a gate on every BUY.
  groups.splice(groups.findIndex((g) => g.group === 'GATES') + 1, 0, {
    group: 'EXECUTION', stage: 4, flat: true,
    note: 'What getting in and out costs at the trade size.',
    fields: [{
      label: 'EXECUTION COST', status: 'live', value: () => null,
      calc: [ref('pipe', 'LIQUIDITY'), ref('pipe', 'PRICE IMPACT $10K'), ref('pipe', 'TRADE SIZE ($)'),
        op('→ 2 × one-way impact (the $10K quote scaled to size, else ~0.55 × size ÷ half the liquidity under $2M) + 0.6% fees')],
      note: 'The round trip in %. Calibrated on real $10K route quotes: about half a constant-product estimate under $2M liquidity, the same above.',
      where: 'flow/score-flow.js EXECUTION COST, roundTripCostPct',
    }],
  });

  // SIGNAL reads the active profile's engine - and only it.
  const sig = SIGNAL_FIELDS.find((f) => f.label === 'SIGNAL');
  if (sig) {
    Object.defineProperty(sig, 'calc', { configurable: true, enumerable: true, get: () => {
      const e = engineOf(activeEngine()) || ENGINES[0];
      return [ref('pipe', e.call), op('- the call of ' + e.label + ', the engine this profile runs')];
    } });
    sig.equation = (v) => { const s = SG(v); return s ? (s.signal || 'none') + ' - ' + (s.why || '') : null; };
    sig.note = 'The active profile’s engine’s call (FLOW picker, top right; ENGINE on the main page): DEFAULT runs QUALITY ROTATION. This is what the main page, the alerts and the trail show.';
  }
}

/*
 * SOURCE STORAGE - the core record: every source the collector reads keeps
 * its own history (the collector's lib/token-history.js), one store per
 * source: data/history/<day>/<source>/<chain>/<subject>.jsonl. Its boxes sit
 * in SOURCES, each fed by its own provider (graph.js SOURCE_STORES). It is
 * what the engines are graded against: the backtest replays every engine
 * over it and the price that followed each call.
 */
/**
 * SOURCE STORAGE - every source's own store (the collector's
 * lib/token-history.js): /history/<source>/<chain>/<subject>, one line per
 * answer. Each is filled by its one provider, so on the map every source
 * feeds a store of its own beside the combined files the app reads.
 */
export const SOURCE_STORES = [
  { source: 'geckoterminal', path: '/history/geckoterminal/<chain>/<token>', from: 'geckoterminal', what: 'pool fields, per token, a minute apart' },
  { source: 'geckoterminal-trades', path: '/history/geckoterminal-trades/<chain>/<pool>', from: 'geckoterminal', what: 'each pool’s trade sample, every trade' },
  { source: 'dexscreener', path: '/history/dexscreener/<chain>/<token>', from: 'dexscreener', what: 'pair fields, per token, a minute apart' },
  { source: 'dexscreener-promotion', path: '/history/dexscreener-promotion/<chain>/boosts', from: 'dexscreener', what: 'paid boosts, per chain' },
  { source: 'jupiter', path: '/history/jupiter/<chain>/<token>', from: 'jupiter', what: 'token stats, per token, a minute apart' },
  { source: 'jupiter-quote', path: '/history/jupiter-quote/<chain>/<token>', from: 'jupiter', what: 'the $10K route quote, per token' },
  { source: 'goplus', path: '/history/goplus/<chain>/<token>', from: 'goplus', what: 'contract audit and holders, per token' },
  { source: 'rugcheck', path: '/history/rugcheck/<chain>/<token>', from: 'rugcheck', what: 'risk report and holders, per token' },
  { source: 'honeypot', path: '/history/honeypot/<chain>/<token>', from: 'honeypot', what: 'sell simulation and tax, per token' },
  { source: 'kyberswap', path: '/history/kyberswap/<chain>/<token>', from: 'kyberswap', what: 'the $10K route quote on EVM, per token' },
  { source: 'defillama', path: '/history/defillama/<chain>/<token>', from: 'defillama', what: 'price, per token' },
  { source: 'ethos', path: '/history/ethos/all/<handle>', from: 'ethos', what: 'project reputation, per X handle' },
  ...['hyperliquid', 'binance', 'aster', 'okx', 'bybit'].map((v) => ({ source: 'perps-' + v, path: '/history/perps-' + v + '/all/listings', from: v, what: 'listed perp symbols' })),
  { source: 'cex-binance', path: '/history/cex-binance/all/<symbol>', from: 'binance-spot', what: 'quote-token price' },
  { source: 'cex-coinbase', path: '/history/cex-coinbase/all/<symbol>', from: 'coinbase', what: 'quote-token price' },
  { source: 'cex-coingecko', path: '/history/cex-coingecko/all/<symbol>', from: 'cex', what: 'quote-token price' },
  ...[['reddit', 'reddit'], ['4chan', '4chan'], ['mastodon', 'mastodon'], ['farcaster', 'warpcast'], ['bluesky', 'bluesky']]
    .map(([n, from]) => ({ source: 'social-' + n, path: '/history/social-' + n + '/all/posts', from, what: 'new posts' })),
];
let storeHealth = { at: 0, data: null };
const historyHealth = () => {
  if (Date.now() - storeHealth.at > 60000) {
    storeHealth = { at: Date.now(), data: storeHealth.data };
    let o = null;
    try { o = storeOrigin(); } catch (e) { o = null; }
    if (o && typeof fetch === 'function') {
      fetch(o + '/history').then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) storeHealth = { at: Date.now(), data: d }; }).catch(() => {});
    }
  }
  return storeHealth.data;
};
const historyCache = new Map();   // source|chain|token -> { at, lines, last }
const historyOf = (src, v) => {
  const s = S(v);
  if (!s || !s.chain || !s.tokenAddress) return null;
  const k = src + '|' + s.chain + '|' + s.tokenAddress;
  const hit = historyCache.get(k);
  if (!hit || Date.now() - hit.at > 60000) {
    historyCache.set(k, { at: Date.now(), lines: hit ? hit.lines : null, last: hit ? hit.last : null });
    let o = null;
    try { o = storeOrigin(); } catch (e) { o = null; }
    if (o && typeof fetch === 'function') {
      fetch(o + '/history/' + src + '/' + s.chain + '/' + encodeURIComponent(s.tokenAddress) + '?days=1')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (d) historyCache.set(k, { at: Date.now(), lines: d.lines, last: (d.history || []).slice(-1)[0] || null }); })
        .catch(() => {});
    }
  }
  return historyCache.get(k);
};
const storeLabel = (st) => st.source.toUpperCase() + ' STORE';
PAGES.pipe.groups.push({
  group: 'SOURCE STORAGE', stage: 1, into: 'eng:history',
  note: 'Every source in a store of its own, one line per answer - what the engines are graded on.',
  fields: SOURCE_STORES.map((st) => {
    const perToken = /<token>$/.test(st.path);
    return {
      label: storeLabel(st), status: 'live',
      value: (v) => {
        if (perToken) { const x = historyOf(st.source, v); if (x && fin(x.lines)) return x.lines; }
        const h = historyHealth();
        return h && h.subjectsToday && fin(h.subjectsToday[st.source]) ? h.subjectsToday[st.source] : null;
      },
      calc: [api(st.path)],
      equation: (v) => {
        const h = historyHealth(); const n = h && h.subjectsToday ? h.subjectsToday[st.source] : null;
        const x = perToken ? historyOf(st.source, v) : null;
        const f = x && x.last && x.last.f ? x.last.f : null;
        return (fin(n) ? n + ' subjects stored today' : 'nothing stored yet today') +
          (x && fin(x.lines) ? ' · ' + x.lines + ' lines for this token' + (f ? ', ' + Object.keys(f).length + ' fields a line' : '') : '');
      },
      note: st.what + '. Kept 30 days (TOKEN_HISTORY_KEEP_DAYS).',
      where: 'Vibe-mm-server lib/token-history.js',
    };
  }),
});
PAGES.pipe.groups.push({
  group: 'GRADING', stage: 5, into: 'eng:services',
  fields: [{
    label: 'ENGINE GRADING', status: 'live',
    value: () => {
      const parts = ENGINES.map((e) => { const b = engineBadge(e.key); return b ? e.label + ' ' + b.text.replace(/^entries /, '') : null; }).filter(Boolean);
      return parts.length ? parts.join(' · ') : null;
    },
    calc: SOURCE_STORES.filter((st) => /^(geckoterminal|dexscreener|jupiter|geckoterminal-trades)$/.test(st.source)).map((st) => ref('pipe', storeLabel(st)))
      .concat(ENGINES.map((e) => ref('pipe', e.call)))
      .concat([op('→ every engine’s BUY entries, BUY states and exits, against the price that followed')]),
    service: { every: 'npm run backtest', keeps: 'raw/model-eval.json engines, and a dated copy in data/eval' },
    note: 'Every engine replayed point-in-time over the stored history, graded on the trade that followed. The FLOW picker shows each engine’s line.',
    where: 'scripts/backtest-early.mjs engines',
  }],
});

// LIST EXTRACTORS: a reading that is a whole LIST (every trade, every sample,
// every row) is extracted as a list: one row shown as the template, the
// fields picked out of each row highlighted, the list handed on - to a
// FILTER, a SUM, an AGGREGATE.
const asList = (key, rows, fields, of) => { if (RAW[key]) RAW[key].list = { rows, fields, of }; };
asList('TRADE SAMPLE', (rec) => (rec && rec.trades) || [], ['wallet', 'kind', 'usd', 'at'], 'trades');
asList('POOL SAMPLES', (rec) => (Array.isArray(rec) ? rec : []), ['t', 'volume5mUsd', 'buys5m', 'buyers5m'], 'samples');
[['VOLUME 5M HISTORY', 'volume5mUsd']].forEach(([k, m]) =>
  asList(k, (rec) => (Array.isArray(rec) ? rec.slice(0, -1) : []), ['t', m], 'samples'));
asList('USD REFERENCE', (rec) => (rec && rec.quotes) || [], ['venue', 'price'], 'venue quotes');
// Every chain's market rows: the board's raw list.
const MARKET_FIELDS = ['chain', 'symbol', 'tokenAddress', 'poolAddress', 'quoteSymbol', 'links',
  'sources.dexscreener.priceUsd', 'sources.dexscreener.liquidityUsd', 'sources.dexscreener.marketCapUsd',
  'sources.dexscreener.volumeUsd', 'sources.dexscreener.pairCreatedAt',
  'sources.geckoterminal.priceUsd', 'sources.geckoterminal.liquidityUsd', 'sources.geckoterminal.volumeUsd',
  'sources.geckoterminal.transactions', 'sources.geckoterminal.poolCreatedAt'];
const marketRows = (all) => Object.keys(all || {}).reduce((out, ch) => out.concat(
  (all[ch].rows || []).map((r, i) => ({ ...r, chain: r.chain || ch, _rank: i, _fetchedAt: all[ch].fetchedAt }))), []);
RAW['MARKET ROWS'] = {
  from: 'marketAll', picks: MARKET_FIELDS.map((f) => ({ path: 'rows[].' + f, to: 'MARKET ROWS' })),
  outs: [{ label: 'MARKET ROWS', value: (v) => { const rows = marketRows((P(v).raw || {}).marketAll); return rows.length ? rows : null; } }],
  list: { rows: (rec) => marketRows(rec), fields: MARKET_FIELDS, of: 'rows, every chain' },
};

// Extractors: one box per value picked out of a raw file. Every box that
// reads a file reading reads it from here (graph.js), so the file → value
// step is a box you can see rather than a label on a wire.
export const SLOT_PATH = {
  marketFile: '/raw/<chain>/market.json', market: '/raw/<chain>/market.json',
  trades: '/raw/<chain>/trades.json', history: '/raw/<chain>/history.json',
  intel: '/raw/<chain>/intel.json', reference: '/raw/reference.json', ethos: '/raw/ethos.json',
  marketAll: '/raw/<chain>/market.json',
  perps: '/raw/perps.json', promotion: '/raw/<chain>/promotion.json',
  smart: '/raw/smart-wallets.json',
};
{
  const taken = new Set();
  PAGES.pipe.groups.forEach((g) => (g.fields || []).forEach((f) => taken.add(f.label)));
  const extractors = Object.keys(RAW).filter((k) => !taken.has(k) && SLOT_PATH[RAW[k].from]).map((k) => {
    const spec = RAW[k];
    const rec = (v) => ((P(v).raw || {})[spec.from]) || null;
    return {
      label: k, status: 'live', raw: spec,
      value: (v) => {
        for (const o of (spec.outs || [])) {
          let x = null;
          try { x = o.value(v, rec(v)); } catch (e) { x = null; }
          if (x !== null && x !== undefined && x !== '') return x;
        }
        return null;
      },
      calc: [api(SLOT_PATH[spec.from], k)],
      extract: { path: SLOT_PATH[spec.from], picks: (spec.picks || []).map((x) => x.path) },
      listSpec: spec.list ? { rows: (v) => spec.list.rows(rec(v), v) || [], fields: spec.list.fields, of: spec.list.of } : null,
      where: 'admin/pipeline.js RAW["' + k + '"]',
    };
  });
  PAGES.pipe.groups.splice(1, 0, // No group of their own: the extractors sit straight in INGEST, beside the
  // files they read.
  { group: 'EXTRACT', stage: 2, into: 'eng:ingest', fields: extractors });
}

/*
 * BOARD STATS and SERVICES - the calculations the dashboard used to do on
 * its own. A dashboard item only displays (dashboard-items.js); a count, an
 * average, a pick or a background job is a box here, so the wire into the
 * item is "this value, shown there".
 */
{
  // The value a frontend card shows today (pipeline-shown.js), so the box
  // reads the same number the dashboard does.
  const tileOf = (list, label) => {
    const t = (list || []).find((x) => x && (x.label === label || String(x.label).indexOf(label + ' ') === 0));
    return t ? t.value : null;
  };
  const shownVal = (page, label) => (v) => {
    for (const g of ((SHOWN_PAGES[page] || {}).groups || [])) {
      const f = (g.fields || []).find((x) => x.label === label);
      if (f && f.value) { try { return f.value(v); } catch (e) { return null; } }
    }
    return null;
  };
  const assets = (v) => P(v).assets || [];
  const alertCount = (v) => (Array.isArray(v.alertColumns)
    ? v.alertColumns.reduce((a, c) => a + ((c.cards || c.items || []).length), 0) : null);
  const organicRows = (v) => assets(v).map((a) => (a.rawServerRow || {}).organicFlow).filter((o) => o && o.score !== null);
  const ours = (v) => organicRows(v).filter((o) => o.basis === 'sample');
  const w = (o) => Math.max(o.coverage, 25);
  const signalCounts = (v) => {
    const m = {};
    assets(v).forEach((a) => { const k = a.signal || 'NONE'; m[k] = (m[k] || 0) + 1; });
    return m;
  };
  const pickRows = (v) => assets(v).filter((a) => a.signal === 'BUY' && (a.wash ?? 0) < 0.15 && a.score != null);
  const model = (v) => ((S(v) || {}).scoreModel || []).filter((c) => !c.pending);
  const used = (v) => model(v).reduce((s, c) => s + c.weight, 0);
  const points = (v, c) => (used(v) ? rnd(((c.value - 50) * c.weight) / used(v), 1) : null);

  PAGES.pipe.groups.push({
    group: 'BOARD STATS', stage: 5, parent: 'eng:score',
    note: 'Board-wide numbers the dashboard shows, built from standard boxes.',
    fields: [
      { label: 'TOKENS TRACKED', status: 'live', value: shownVal('live', 'TOKENS TRACKED'),
        calc: [ref('pipe', 'TOKEN LIST')], where: 'flow/board-flow.js TOKENS TRACKED' },
      { label: 'BOARD COUNTS', status: 'live', value: () => null,
        calc: [ref('pipe', 'TOKEN LIST'), ref('pipe', 'SIGNAL')].concat(ENGINES.map((e) => ref('pipe', e.call))),
        note: 'The filter chips: tokens per chain and type, and per chain each signal and each engine\u2019s BUY.',
        where: 'flow/board-flow.js BOARD COUNTS' },
      { label: 'AVG ORGANIC SCORE', status: 'live', value: shownVal('live', 'AVG ORGANIC SCORE'),
        calc: [ref('pipe', 'Organic flow')], where: 'flow/board-flow.js AVG ORGANIC SCORE' },
      { label: 'ORGANIC GRADES', status: 'live', value: () => null,
        calc: [ref('pipe', 'Organic flow'), ref('pipe', 'TOKEN LIST')],
        note: 'How the sampled tokens fall across weak (< 45), fair and strong (70+).',
        where: 'flow/board-flow.js ORGANIC GRADES' },
      { label: 'DAILY PICK', status: 'live',
        value: (v) => (v.chepePickSym && v.chepePickSym !== '—' ? v.chepePickSym + ' · ' + v.chepePickScore : null),
        calc: [ref('pipe', 'TOKEN LIST'), ref('pipe', 'SIGNAL')], where: 'flow/board-flow.js DAILY PICK' },
      { label: 'SIGNAL COUNTS', status: 'live',
        value: (v) => { const m = signalCounts(v); const ks = Object.keys(m); return ks.length ? ks.map((k) => k + ' ' + m[k]).join(' · ') : null; },
        calc: [ref('pipe', 'SIGNAL')], where: 'flow/board-flow.js SIGNAL COUNTS' },
      { label: 'MARKET REGIME', status: 'live',
        value: () => getSetting(REGIME_SETTING, { id: REGIME_DEFAULT }).id,
        calc: [],
        note: 'Your pick: nothing measures the regime yet. The header shows this box.',
        selector: {
          of: 'regimes',
          options: () => REGIMES.map((r) => ({ id: r.id, label: r.id, sub: r.note })),
          selected: () => getSetting(REGIME_SETTING, { id: REGIME_DEFAULT }).id,
          pick: (v, id) => setSetting(REGIME_SETTING, { id }),
        },
        where: 'components/RegimeSelector.jsx' },
      { label: 'ALERTS NOW', status: 'live', value: (v) => alertCount(v),
        calc: [ref('pipe', 'ALERT ENGINE')],
        note: 'The alert cards on the board right now. The app keeps no 24h log, so there is no honest 24h count.',
        where: 'flow/board-flow.js ALERTS NOW' },
      { label: 'WHAT MOVES EARLY', status: 'live',
        value: (v) => { const m = model(v); return m.length ? m.length + ' inputs' : null; },
        calc: [ref('pipe', 'EARLY RAW')], where: 'flow/score-flow.js EARLY RAW (points per input)' },
    ],
  });
  opsOf('SIGNAL COUNTS', [
    node('by', 'COUNT BY', 'SIGNAL COUNTS', [ref('pipe', 'SIGNAL')],
      (v) => (assets(v).length ? 'tokens on the board, counted per signal' : null), null),
  ]);
  opsOf('ALERTS NOW', [
    node('count', 'COUNT', 'ALERTS NOW', [ref('pipe', 'ALERT ENGINE')],
      (v) => { const n = alertCount(v); return n === null ? null : 'alert cards on the board: ' + n; }, null),
  ]);
  opsOf('TOKENS TRACKED', [
    node('count', 'COUNT', 'TOKENS TRACKED', [ref('pipe', 'TOKEN LIST')],
      (v) => (assets(v).length ? 'tokens on the board after screening' : null), null),
  ]);
  opsOf('AVG ORGANIC SCORE', [
    node('ours', 'FILTER', 'OUR OWN SAMPLE', [ref('pipe', 'Organic flow')], null,
      (v) => { const n = ours(v).length; return n ? n + ' tokens' : null; },
      { filter: { rows: organicRows, of: 'organic reads', rules: [{ label: 'basis = our own wallet sample (not Jupiter)', apply: (rows) => rows.filter((o) => o.basis === 'sample') }] } }),
    node('sum', 'SUM', 'SCORE × COVERAGE', ['@ours'],
      (v) => { const o = ours(v); return o.length ? 'Σ score × max(coverage, 25) over ' + o.length : null; },
      (v) => { const o = ours(v); return o.length ? Math.round(o.reduce((s, x) => s + x.score * w(x), 0)) : null; }),
    node('weights', 'SUM', 'COVERAGE', ['@ours'],
      (v) => { const o = ours(v); return o.length ? 'Σ max(coverage, 25)' : null; },
      (v) => { const o = ours(v); return o.length ? o.reduce((s, x) => s + w(x), 0) : null; }),
    node('div', '÷', 'AVG ORGANIC SCORE', ['@sum', '@weights'],
      (v) => { const o = ours(v); if (!o.length) return null; return Math.round(o.reduce((s, x) => s + x.score * w(x), 0)) + ' ÷ ' + o.reduce((s, x) => s + w(x), 0); }, null),
  ]);
  opsOf('DAILY PICK', [
    node('cands', 'FILTER', 'CANDIDATES', [ref('pipe', 'TOKEN LIST'), ref('pipe', 'SIGNAL'), ref('pipe', 'Organic flow')], null,
      (v) => { const n = pickRows(v).length; return n ? n + ' tokens' : null; },
      { filter: { rows: assets, of: 'tokens', rules: [
        { label: 'wash under 0.15', apply: (rows) => rows.filter((a) => (a.wash ?? 0) < 0.15) },
        { label: 'signal BUY', apply: (rows) => rows.filter((a) => a.signal === 'BUY') },
        { label: 'has a score', apply: (rows) => rows.filter((a) => a.score != null) },
      ] } }),
    node('pick', 'PICK', 'DAILY PICK', ['@cands'],
      (v) => { const n = pickRows(v).length; return n ? 'one of ' + n + ', fixed for the day (hash of the date)' : null; }, null),
  ]);
  opsOf('WHAT MOVES EARLY', EARLY_MODEL.map((c, i) => node('c' + i, '×', c.label + ' POINTS',
    [ref('pipe', c.label), ref('pipe', weightLabel(c))],
    (v) => { const m = model(v).find((x) => x.key === c.key); return m ? '(' + m.value + ' − 50) × ' + m.weight + ' ÷ ' + used(v) : 'no value'; },
    (v) => { const m = model(v).find((x) => x.key === c.key); return m ? points(v, m) : null; }))
    .concat([node('sum', 'SUM', 'WHAT MOVES EARLY', EARLY_MODEL.map((c, i) => '@c' + i),
      (v) => { const m = model(v); return m.length ? 'Σ points = EARLY RAW − 50 = ' + rnd(m.reduce((s, c) => s + ((c.value - 50) * c.weight) / used(v), 0), 1) : null; }, null)]));

  PAGES.pipe.groups.push({
    group: 'SOCIAL STATS', stage: 5, parent: 'eng:decomp',
    note: 'This token\u2019s social numbers, from the social service.',
    fields: [
      { label: 'MENTIONS', status: 'live', value: (v) => tileOf(v.socialStats, 'MENTIONS'),
        calc: [ref('pipe', 'SOCIAL BASELINE')],
        extract: { path: 'SOCIAL BASELINE', picks: ['mentions'] }, where: 'flow/board-flow.js MENTIONS' },
      { label: 'UNIQUE AUTHORS', status: 'live', value: (v) => tileOf(v.socialStats, 'UNIQUE AUTHORS'),
        calc: [ref('pipe', 'SOCIAL BASELINE')],
        extract: { path: 'SOCIAL BASELINE', picks: ['uniqueAuthors'] }, where: 'flow/board-flow.js UNIQUE AUTHORS' },
      { label: 'MENTIONS PER AUTHOR', status: 'live', value: (v) => tileOf(v.socialStats, 'PER AUTHOR'),
        calc: [ref('pipe', 'MENTIONS'), ref('pipe', 'UNIQUE AUTHORS')], where: 'flow/board-flow.js MENTIONS PER AUTHOR' },
      { label: 'VS SOCIAL BASELINE', status: 'live', value: (v) => tileOf(v.socialStats, 'VS BASELINE'),
        calc: [ref('pipe', 'MENTIONS'), ref('pipe', 'SOCIAL BASELINE')], where: 'flow/board-flow.js VS SOCIAL BASELINE (mentionBaseline)' },
    ],
  });
  tag('MENTIONS PER AUTHOR', { opSpec: node('div', '÷', 'MENTIONS PER AUTHOR', [ref('pipe', 'MENTIONS'), ref('pipe', 'UNIQUE AUTHORS')],
    (v) => { const m = tileOf(v.socialStats, 'MENTIONS'); const u = tileOf(v.socialStats, 'UNIQUE AUTHORS'); return m != null && u != null ? m + ' ÷ ' + u : null; }, null) });
  tag('VS SOCIAL BASELINE', { opSpec: node('div', '÷', 'VS SOCIAL BASELINE', [ref('pipe', 'MENTIONS'), ref('pipe', 'SOCIAL BASELINE')],
    () => 'mentions now ÷ this token\u2019s own mean', null) });

  // The background jobs, as SERVICE boxes. They sit in SERVICES on the map.
  PAGES.pipe.groups.push({
    group: 'SERVICES', stage: 4, into: 'eng:services',
    fields: [
      { label: 'WALLET INTEL', status: 'live', value: (v) => v.intelLine,
        calc: [api('/raw/<chain>/trades.json', 'TRADE SAMPLE')],
        service: { every: '5s', keeps: 'pools watched, wallets in memory, clusters logged (IndexedDB)', costs: 'nothing - it re-reads the samples the server holds' },
        where: 'services/wallet-intel.js' },
      { label: 'ROTATION SERVICE', status: 'live', value: (v) => v.rotService,
        calc: [ref('pipe', 'WALLET INTEL')],
        service: { every: 'each wallet sample', keeps: 'chains held and pools connected', costs: 'nothing - it rides the wallet sample' },
        where: 'services/rotation-intel.js (the graphs) → flow/board-flow.js ROTATION SERVICE' },
      { label: 'SOCIAL BASELINE', status: 'live', value: (v) => v.socialBaselineNote,
        calc: [api('/raw/social.json')],
        service: { every: '1 min', keeps: 'each token’s mention history, kept with the tab closed (IndexedDB)' },
        where: 'services/social-intel.js' },
      { label: 'TOP 20 HIT RATE', status: 'live', value: shownVal('live', 'TOP 20 HIT RATE'),
        calc: [api('/raw/<chain>/observations-48h.json')],
        service: { every: 'a few minutes', keeps: 'nothing - it re-reads the journal of calls' },
        where: 'App.jsx refreshPrecision() (the read) → flow/board-flow.js TOP 20 HIT RATE (precisionAtK)' },
      { label: 'FORWARD RETURNS', status: 'live', value: shownVal('detail', 'FORWARD RETURNS'),
        calc: [api('/raw/<chain>/observations.json'), api('/raw/<chain>/observations-48h.json')],
        service: { every: 'on opening a token', keeps: 'nothing - it re-reads the score journal' },
        where: 'services/api.js fetchTokenOutcomes()' },
      { label: 'SCORE EVALUATION', status: 'live',
        value: (v) => (v.outcome ? (v.outcome.ready ? (v.outcome.verdict || 'ready') : v.outcome.note) : null),
        calc: [api('/raw/<chain>/observations-48h.json')],
        service: { every: 'on opening EVALUATION', keeps: 'nothing - it re-reads the score journal' },
        where: 'services/api.js evaluation' },
      { label: 'SYSTEM HEALTH', status: 'live',
        value: (v) => (v.health ? v.health.title + (v.health.summary ? ' · ' + v.health.summary : '') : null),
        calc: [api('/raw/system.json'), ref('pipe', 'WALLET INTEL'), ref('pipe', 'ROTATION SERVICE'), ref('pipe', 'SOCIAL BASELINE')],
        service: { every: '15s (the server rewrites system.json)', keeps: 'nothing - each provider judged on its last 15 minutes' },
        where: 'calculations/core.js providerHealth() → flow/board-flow.js SYSTEM HEALTH' },
      { label: 'ALERT ENGINE', status: 'live',
        value: (v) => (Array.isArray(v.alertColumns)
          ? v.alertColumns.map((c) => (c.title || c.label || c.name) + ' ' + ((c.cards || c.items || []).length)).join(' · ') : null),
        calc: [ref('pipe', 'TOKEN LIST'), ref('pipe', 'SIGNAL'), ref('pipe', 'PHASE'), ref('pipe', 'EARLY SCORE'), ref('pipe', 'EARLY RAW'),
          ref('pipe', 'ABOVE 6H LOW'), ref('pipe', 'SMART SELLERS 1H'), ref('pipe', 'RISK FLAGS')],
        service: { every: 'each poll', keeps: 'which alerts already fired' },
        where: 'flow/board-flow.js ALERT ENGINE' },
    ],
  });

  // The selected token's own reads, as boxes: who is in its trade sample, and
  // where its crowd is going (flow/board-flow.js). WALLETS and ROTATION show these.
  const tok = ref('pipe', 'THIS TOKEN');
  const tw = ref('pipe', 'TOKEN WALLETS');
  const box = (label, calc, note) => ({ label, status: 'live', value: () => null, calc, note, where: 'flow/board-flow.js ' + label });
  PAGES.pipe.groups.push({
    group: 'WALLET READ', stage: 5, parent: 'eng:decomp',
    note: 'This token\u2019s trade sample, read behaviourally. The WALLETS tab shows these.',
    fields: [
      box('TOKEN WALLETS', [tok, ref('pipe', 'WALLET INTEL'), api('/raw/<chain>/trades.json', 'TRADE SAMPLE')],
        'The on-demand read of this pool, else the wallet service\u2019s.'),
      box('WALLET COVERAGE', [ref('pipe', 'TOKEN LIST'), ref('pipe', 'WALLET INTEL')], 'Board pools with a trade sample so far.'),
      box('ACTIVE WALLETS', [tw], 'Wallets in the sampled window.'),
      box('WALLET NET FLOW', [tw], 'Buys minus sells, USD, over the window.'),
      box('BUYER WALLETS', [tw], 'Distinct wallets that bought.'),
      box('SELLER WALLETS', [tw], 'Distinct wallets that sold.'),
      box('TOP WALLET SHARE', [tw], 'The largest wallet\u2019s share of window volume, %.'),
      box('CO-ENTRY WALLETS', [tw], 'Wallets that entered in a co-ordinated burst.'),
      box('WALLET GROUPS', [tw], 'Traders per tag: accumulating, exiting, churn, rotating, co-entry...'),
      box('WALLET RANKS', [tw], 'Traders ranked by turnover (bubble area) and by |net| (arrows).'),
      box('WALLET HISTORY', [tw, ref('pipe', 'WALLET INTEL')], 'What the service has seen each trader do on other tokens.'),
      box('TRACKED HERE', [tw], 'Your tracked wallets, and which of them are in this window.'),
      box('CLUSTERS ELSEWHERE', [tok, ref('pipe', 'WALLET INTEL')], 'Co-entry clusters on other tokens, medium confidence and up.'),
    ],
  });
  PAGES.pipe.groups.push({
    group: 'ROTATION READ', stage: 5, parent: 'eng:decomp',
    note: 'Capital moving between sampled pools. ROTATION and MARKET ROTATION show these.',
    fields: [
      box('TOKEN ROTATION', [tok, ref('pipe', 'ROTATION SERVICE')], 'This pool\u2019s inflow, outflow and peers, each direction largest first.'),
      box('CHAIN ROTATION', [tok, ref('pipe', 'ROTATION SERVICE')], 'This token\u2019s chain: its graph and every pool ranked by net rotation.'),
      box('MARKET ROTATION', [ref('pipe', 'ROTATION SERVICE')], 'Every chain\u2019s directed flows, net gainers and losers, the totals.'),
    ],
  });
}

/*
 * Step 6 - SHOWN ON THE DASHBOARD - is the token tabs' own panels, kept under
 * their tab keys (see pipeline-shown.js). Registered here so that loading the
 * pipeline loads the whole of it.
 */
// Every box of the flow sends a RAW value (see RAW MODE above): the top-level
// boxes too, not only the operators inside groups.
// Where the flow computed the box (score flow per token, board flow per
// poll), the box's value IS that wire value - one value, one place.
PAGES.pipe.groups.forEach((g) => (g.fields || []).forEach((f) => {
  if (!f.value || f.__raw) return;
  const id = 'f:pipe:' + f.label;
  const shown = f.value;
  f.value = (v) => {
    const flow = (S(v) || {}).flowValues || {};
    if (id in flow) return flow[id];
    const board = boardValues();
    if (id in board) return board[id];
    return f.selector ? shown(v) : toRaw(rawCall(shown, v));
  };
  f.__raw = true;
}));

Object.assign(PAGES, SHOWN_PAGES);


