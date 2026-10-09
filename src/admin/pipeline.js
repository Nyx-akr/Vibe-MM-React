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
import { TOTAL_WEIGHT, SCORE_MODEL, STAGES, scoreSeriesFor } from '../calculations/asset-detail.js';
import { GATES, GATE_RULES } from '../calculations/gates.js';
import { getSetting, setSetting, applyFilter, filterSetting } from './box-settings';

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
const modOf = (v, key) => ((S(v) || {}).scoreModifiers || []).find((c) => c.key === key) || null;
const valueOf = (c) => (c && !c.pending && fin(c.value) ? c.value : null);
const weightOf = (key) => (SCORE_MODEL.find((c) => c.key === key) || {}).weight;
/**
 * The number the score actually used, beside the working - a cross-check: if
 * the arithmetic and this ever differ, the working is out of date.
 */
const said = (c) => (valueOf(c) === null ? 'pending - no input yet' : '· score used ' + c.value);

const minutes = (ms) => (fin(ms) ? Math.round(ms / 60000) + ' min' : null);
/** This token's RIGHT NOW readings still inside the 15-minute window. */
const recentScores = (v) => recentScorePoints(v).map((p) => p.x);

/*
 * MEAN WINDOWS - how far back a mean box averages, a setting on the box.
 * The default is what the score uses (all the server keeps for the 5m
 * baselines - 6 hours of 15s samples; the full 15 minutes for the settled
 * score), so a changed window is a preview and the default is the score.
 */
const windowMin = (id, def) => getSetting(id, { n: def }).n;
const lastMinutes = (points, minutes) => {
  if (!points.length) return points;
  const end = points[points.length - 1].t;
  return points.filter((p) => p.t >= end - minutes * 60000);
};
const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The 5m baselines: every 15s sample but the newest, as {t, x}. */
export const BASELINE_WINDOW = { def: 360, min: 2, max: 360, step: 15 };
const baselineWindowId = (name) => 'f:pipe:' + name + ' MEAN:window';
const baselinePoints = (v, metric, name) => {
  const h = (P(v).raw || {}).history;
  const pts = Array.isArray(h) ? h.slice(0, -1).map((s) => ({ t: s.t, x: s[metric] })).filter((p) => fin(p.x) && fin(p.t)) : [];
  return lastMinutes(pts, windowMin(baselineWindowId(name), BASELINE_WINDOW.def));
};
const baselineChanged = (name) => windowMin(baselineWindowId(name), BASELINE_WINDOW.def) !== BASELINE_WINDOW.def;
/** The mean the baseline divides by: the score's own at the default window, the map's otherwise. */
const baselineMean = (v, metric, name) => {
  if (!baselineChanged(name)) { const m = Z(v)[metric]; return m ? m.mean : null; }
  return meanOf(baselinePoints(v, metric, name).map((p) => p.x));
};

/** The settled score's readings: RIGHT NOW over its window (15 min by default), as {t, x}. */
export const SCORE_MEAN_WINDOW = { def: 15, min: 1, max: 15, step: 1 };
const SCORE_MEAN_ID = 'f:pipe:RIGHT NOW, 15 MIN MEAN:window';
const recentScorePoints = (v) => {
  const s = S(v);
  if (!s) return [];
  const pts = scoreSeriesFor(s.chain, s.tokenAddress, 400).map((m) => ({ t: m.t, x: m.v })).filter((p) => fin(p.x));
  return lastMinutes(pts, windowMin(SCORE_MEAN_ID, SCORE_MEAN_WINDOW.def));
};

/* -------------------------------------------------------------- gates -- */

/**
 * The gates are READ from the score, never recomputed: scoreAsset() runs
 * calculations/gates.js and keeps its verdict on the row (`row.gates`), so a
 * gate box can only ever say what the score acted on. A test is {ok, detail}:
 * ok true = pass, false = VETO, null (no answer) = not checked yet.
 */
const G = GATE_RULES;
const WASH_FLOOR = GATE_RULES.minOrganicFlow;

/**
 * The PARAMETERS: every number the model is tuned by, as a raw number with
 * its unit in its name, and a default that is the app's own choice. A user
 * changes one with the standard number input on its box (box-settings.js);
 * the gates on the map then judge with the new value.
 */
export const PARAMS = {
  minAgeDays: { label: 'MIN POOL AGE (days)', def: G.minAgeHours / 24, step: 1, min: 0,
    note: 'Younger pools are vetoed by the AGE FLOOR gate.' },
  minLiquidity: { label: 'MIN LIQUIDITY ($)', def: G.minLiquidityUsd, step: 5000, min: 0,
    note: 'The LIQUIDITY FLOOR gate.' },
  minVolume24h: { label: 'MIN VOLUME 24H ($)', def: G.minVolume24hUsd, step: 5000, min: 0,
    note: 'The VOLUME FLOOR gate.' },
  maxTax: { label: 'MAX TAX (%)', def: G.maxTaxPct, step: 0.5, min: 0, max: 100,
    note: 'Buy and sell tax each at or under this.' },
  majorCap: { label: 'MAJOR CAP ($)', def: G.majorMarketCapUsd, step: 100000000, min: 0,
    note: 'At or over this market cap a token is a major, not a candidate.' },
  minOrganic: { label: 'MIN ORGANIC FLOW (0-100)', def: G.minOrganicFlow, step: 1, min: 0, max: 100,
    note: 'Under this the volume is wash-flagged.' },
};
export const paramId = (key) => 'param:' + key;
export const paramValue = (key) => getSetting(paramId(key), { n: PARAMS[key].def }).n;
const paramChanged = (key) => paramValue(key) !== PARAMS[key].def;
/** A component's weight: its SCORE_MODEL weight unless the user changed it. */
export const weightId = (key) => 'param:weight:' + key;
/** A component's WEIGHT parameter box. */
export const weightLabel = (c) => 'WEIGHT · ' + c.label;
const weightNow = (c) => getSetting(weightId(c.key), { n: c.weight }).n;

/**
 * The gates on the map. Those with a threshold are judged HERE, with the
 * current parameter - at the defaults they agree with the score's own
 * verdict (row.gates); with a parameter changed they are a preview of it.
 * The rest (a contract check, the ticker screen) are read from the row.
 */
const cmp = (got, sym, want, show) => {
  if (!fin(got)) return null;
  const ok = sym === '≥' ? got >= want : sym === '≤' ? got <= want : got < want;
  return { ok, detail: show(got) + ' ' + sym + ' ' + show(want) + ' ? ' + (ok ? 'yes → pass' : 'no → VETO') };
};
const num0 = (n) => (fin(n) ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—');
const taxOf = (v) => {
  const gp = ((P(v).raw || {}).intel || {}).goplus;
  if (!gp) return null;
  const b = Number(gp.buy_tax);
  const s = Number(gp.sell_tax);
  return fin(b) || fin(s) ? Math.max(fin(b) ? b : 0, fin(s) ? s : 0) * 100 : null;
};
const LOCAL_GATES = {
  'AGE FLOOR': (v) => cmp(fin((S(v) || {}).poolAgeHours) ? S(v).poolAgeHours / 24 : null, '≥', paramValue('minAgeDays'), num0),
  'LIQUIDITY FLOOR': (v) => cmp((S(v) || {}).liquidityUsd, '≥', paramValue('minLiquidity'), num0),
  'VOLUME FLOOR': (v) => cmp((S(v) || {}).volume24hUsd, '≥', paramValue('minVolume24h'), num0),
  'NOT A MAJOR': (v) => cmp((S(v) || {}).marketCapUsd, '<', paramValue('majorCap'), num0),
  'NOT WASH-FLAGGED': (v) => cmp(valueOf(modOf(v, 'organicFlow')), '≥', paramValue('minOrganic'), num0),
  // Only when MAX TAX was changed: the default verdict is the contract check's own.
  'TAX IN RANGE': (v) => (paramChanged('maxTax') ? cmp(taxOf(v), '≤', paramValue('maxTax'), num0) : undefined),
};
const GATE_TESTS = Object.fromEntries(GATES.map((g) => [g.label, (v) => {
  if (LOCAL_GATES[g.label]) {
    const r = LOCAL_GATES[g.label](v);
    if (r !== undefined) return r;
  }
  const c = (((S(v) || {}).gates || {}).checks || []).find((x) => x.label === g.label);
  return c && c.ok !== null ? { ok: c.ok, detail: c.detail + (c.ok ? ' → pass' : ' → VETO') } : null;
}]));
const gateOf = (v, label) => (S(v) && GATE_TESTS[label] ? GATE_TESTS[label](v) : null);
const verdict = (r) => (r ? (r.ok ? 'pass' : 'VETO') : null);

/* ------------------------------------------------------------- shared -- */

const WHERE_API = 'services/api.js fetchLiveMarketData()';
const WHERE_NORM = 'calculations/core.js normalizeRow()';
const WHERE_MODEL = 'calculations/asset-detail.js computeComponents()';

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

/** A component's card. `math(v)` prints its arithmetic with live numbers. */
const component = (key, calc, math, extra) => ({
  label: (SCORE_MODEL.find((c) => c.key === key) || {}).label,
  status: 'live',
  weight: weightOf(key) + '%',
  value: (v) => valueOf(comp(v, key)),
  calc,
  equation: (v) => {
    const c = comp(v, key);
    if (!S(v)) return null;
    let body = null;
    try { body = math(v, c); } catch (e) { body = null; }
    // A pending component whose working already says why needs no "pending" tag.
    if (body && valueOf(c) === null) return body;
    return (body ? body + '   ' : '') + said(c);
  },
  evidence: (v) => (comp(v, key) || {}).evidence || '',
  where: WHERE_MODEL,
  ...(extra || {}),
});

/* ============================================================== pages === */

PAGES.pipe = {
  title: 'SCORE',
  blurb: 'How the app turns raw files into one token’s score, step by step, with that ' +
    'token’s live numbers. Every 5s poll: read the files, normalise and screen the rows, ' +
    'derive the measures, score twelve components, subtract the risk penalty, average over ' +
    '15 minutes.',
  groups: [

    /* ---------------------------------------------------- 1 TOKEN LIST -- */
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
            { ...ref('pipe', 'VETO LOG', 'VETO when a gate failed'), soft: true }, op('else its'), { ...ref('pipe', 'FINAL', 'score'), soft: true }],
          // A SELECTOR: every token on the list is an option, and picking one
          // here picks it for the whole admin - the same as the header picker.
          selector: {
            of: 'tokens',
            options: (v) => (P(v).assets || []).map((a) => ({
              id: a.id, label: a.sym, sub: a.chain,
              value: a.rawServerRow && a.rawServerRow.vetoed ? 'VETO' : (a.score == null ? '—' : Math.round(a.score)),
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

    /* -------------------------------------------------- 2 TOKEN INPUTS -- */


    /* ------------------------------------------------------ 3 MEASURES -- */
    {
      group: 'MEASURES', stage: 2, flat: true,
      fields: [
        // Each 5-minute measure is two boxes: an AGGREGATE that reduces the
        // pool's sample history to its mean, and a MATH box that divides the
        // latest sample by it. The mean used to hide inside the division.
        ...[
          ['VOLUME 5M', 'volume5mUsd', usd],
          ['BUYS 5M', 'buys5m', count],
          ['BUYERS 5M', 'buyers5m', count],
        ].map(([name, metric, fmt]) => ({
          label: name + ' MEAN', status: 'live',
          value: (v) => { const x = baselineMean(v, metric, name); return fin(x) ? fmt(x) : null; },
          calc: [api('/raw/<chain>/history.json', name + ' HISTORY')],
          agg: {
            fn: 'MEAN', fmt,
            what: 'every sample but the latest',
            every: '15s',
            window: { id: baselineWindowId(name), ...BASELINE_WINDOW,
              note: 'the server keeps up to 6 h of samples per pool' },
            // The pool's own samples, as the score read them: all but the newest.
            points: (v) => baselinePoints(v, metric, name),
            result: (v) => baselineMean(v, metric, name),
          },
          note: 'The baseline the latest sample is judged against. Needs ' + Z_MIN_SAMPLES + ' samples (one every 15s).',
          where: 'calculations/core.js zScoresFrom() → statsFor()',
        })),
        ...[
          ['VOLUME 5M vs BASELINE', 'volume5mUsd', usd, 'VOLUME 5M'],
          ['BUYS 5M vs BASELINE', 'buys5m', count, 'BUYS 5M'],
          ['BUYERS 5M vs BASELINE', 'buyers5m', count, 'BUYERS 5M'],
        ].map(([label, metric, fmt, name]) => ({
          label, status: 'live',
          value: (v) => { const m = Z(v)[metric]; return m && fin(m.multiple) ? m.multiple + 'x' : null; },
          calc: [api('/raw/<chain>/history.json', name + ' NOW'), op('÷'), ref('pipe', name + ' MEAN')],
          equation: (v) => {
            const m = Z(v)[metric];
            const z = (S(v) || {}).zScores;
            if (!m) return z ? 'no baseline yet: ' + (z.samples || 0) + ' of ' + Z_MIN_SAMPLES + ' samples' : null;
            return fmt(m.value) + ' ÷ ' + fmt(m.mean) + ' = ' + (fin(m.multiple) ? m.multiple + 'x' : '—');
          },
          where: 'calculations/core.js zScoresFrom() (bucketBaselines() for a pool with no samples)',
        })),
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
          label: 'HOLDER GROWTH RATE', status: 'live',
          value: (v) => { const g = (((IN(v) || {}).holders) || {}).growth; return g && fin(g.perHour) ? signed(g.perHour) + '/h' : null; },
          calc: [op('( last − first ) count ÷ hours, over the series in'), api('/raw/<chain>/intel.json', 'HOLDERS')],
          equation: (v) => {
            const h = (IN(v) || {}).holders; const g = h && h.growth; if (!g || !fin(g.perHour)) return null;
            const rate = h.count ? (g.perHour / h.count) * 100 : null;
            return signed(g.changed, 0) + ' holders in ' + minutes(g.windowMs) + ' = ' + signed(g.perHour) + '/h' +
              (fin(rate) ? ' = ' + signed(rate, 4) + '% of ' + count(h.count) + ' per hour' : '');
          },
          where: 'asset-detail.js holderGrowthFrom()',
        },
        {
          label: 'SHARED WALLETS', status: 'live',
          value: (v) => pct(((S(v) || {}).rotation || {}).sharedWalletPct, 1),
          calc: [op('wallets of'), api('/raw/<chain>/trades.json', 'TRADE SAMPLE'), op('also in another sampled pool ÷ all its wallets')],
          equation: (v) => {
            const r = (S(v) || {}).rotation; if (!r) return null;
            const top = r.peers && r.peers[0];
            return r.sharedWalletCount + ' wallets shared across ' + r.poolsCompared + ' pools' +
              (top ? ' · most with ' + (top.symbol || '?') + ' (' + top.sharedWallets + ')' : '');
          },
          where: 'core.js rotationFor()',
        },
        {
          label: 'QUOTE DEVIATION', status: 'live',
          value: (v) => {
            const s = S(v); const r = s && s.usdReference;
            if (!r || !r.median || !fin(s.quoteTokenPriceUsd)) return null;
            return pct(Math.abs(s.quoteTokenPriceUsd - r.median) / r.median * 100, 3);
          },
          calc: [op('|'), api('/raw/<chain>/market.json', 'QUOTE TOKEN PRICE'), op('−'), api('/raw/reference.json', 'USD REFERENCE'), op('| ÷ median × 100')],
          where: 'computeComponents(), usdReference',
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

    /* ------------------------------------------------------- 3 ENGINES -- */
    /*
     * The components, one box each, under the column header "3 · ENGINES". This group IS the DETAIL tab's decomposition panel (its
     * bars draw these values), so there is no second copy of it in step 6.
     * Folding them into one panel box was tried and reverted on request: one
     * box per component keeps each one's inputs and output on the map itself.
     */
        {
      group: 'DEMAND ENGINE', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'Is anyone actually trading it right now, and is the buying wide enough to be more than one wallet. Four readings against this pool’s own baseline.',
      fields: [
        component('volumeAnomaly',
          [op('multipleScore('), ref('pipe', 'VOLUME 5M vs BASELINE'), op(') = 100 × clamp( 0.5 + 0.3 × log10 multiple )')],
          (v) => multipleMath((Z(v).volume5mUsd || {}).multiple)),
        component('tradeActivity',
          [op('multipleScore('), ref('pipe', 'BUYS 5M vs BASELINE'), op(')')],
          (v) => multipleMath((Z(v).buys5m || {}).multiple)),
        component('buyerBreadth',
          [op('½ × multipleScore('), ref('pipe', 'BUYERS 5M vs BASELINE'), op(') + ½ × logScore('),
            api('/raw/<chain>/market.json', 'BUYERS 24H'), op(', 10, 3000 )')],
          (v) => {
            const m = (Z(v).buyers5m || {}).multiple;
            const a = fin(m) ? multipleScore(m) : null;
            const b = logScore(((S(v) || {}).traders24h || {}).buyers, 10, 3000);
            if (a !== null && b !== null) return '½ × ' + a + ' + ½ × ' + b + ' → ' + Math.round(a * 0.5 + b * 0.5);
            return a !== null ? 'anomaly only: ' + a : (b !== null ? 'absolute only: ' + b : null);
          }),
        component('netDemand',
          [op('100 × clamp( 0.5 +'), ref('pipe', 'NET FLOW RATIO'), op('÷ 2 ) ; with no trade sample: 100 × clamp( 0.5 + net ratio of'),
            api('/raw/<chain>/market.json', 'JUPITER STATS'), op('÷ 2 ) ; with neither: 100 × clamp( ('), api('/raw/<chain>/market.json', 'BUY/SELL 24H'), op('− 0.5 ) ÷ 1.5 )')],
          (v) => {
            const t = TS(v);
            if (t && t.netRatio !== null) return 'our sample: 0.5 + ' + t.netRatio + ' ÷ 2 → ' + to100(0.5 + t.netRatio / 2);
            const j = (S(v) || {}).jupiter;
            const w = j && (j.stats1h || j.stats5m || j.stats24h);
            if (w && w.netRatio !== null && w.netRatio !== undefined) return 'Jupiter: 0.5 + ' + rnd(w.netRatio, 3) + ' ÷ 2 → ' + to100(0.5 + w.netRatio / 2);
            const r = (S(v) || {}).buySellRatio24h;
            return fin(r) ? 'counts only: ( ' + rnd(r, 2) + ' − 0.5 ) ÷ 1.5 → ' + to100((r - 0.5) / 1.5) : null;
          }),
      ],
    },
    {
      group: 'EXECUTION ENGINE', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'Could a position be taken at all — pool depth blended with what $10k actually costs to route.',
      fields: [
        component('liquidity',
          [op('½ × logScore('), api('/raw/<chain>/market.json', 'LIQUIDITY'), op(', $10K, $1M ) + ½ × 100 × clamp( 1 −'),
            ref('pipe', 'PRICE IMPACT $10K'), op('÷ 2.5 )')],
          (v) => {
            const d = logScore((S(v) || {}).liquidityUsd, 10000, 1000000);
            const ip = ((IN(v) || {}).impact || {}).priceImpactPct;
            const i = fin(ip) ? to100(1 - ip / 2.5) : null;
            if (d !== null && i !== null) return '½ × ' + d + ' (depth) + ½ × ' + i + ' (impact) → ' + Math.round(d * 0.5 + i * 0.5);
            return d !== null ? 'depth only: ' + d : (i !== null ? 'impact only: ' + i : null);
          }),
      ],
    },
    {
      group: 'CONFIRMATION ENGINE', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'Do independent sources agree on the price. Disagreement is the first sign of a bad read, so this engine is a check on the others rather than a signal of its own.',
      fields: [
        component('priceConfirmation',
          [op('100 × clamp( 1 − |'), api('/raw/<chain>/market.json', 'PRICE, 2 SOURCES'), op('| ÷ 5 ) ; if only one source priced it: 40')],
          (v) => {
            const x = (S(v) || {}).crossSource; if (!x) return null;
            if (fin(x.priceDeltaPct)) return '1 − ' + rnd(Math.abs(x.priceDeltaPct), 3) + ' ÷ 5 → ' + to100(1 - Math.abs(x.priceDeltaPct) / 5);
            return x.sourcesAgreeing < 2 ? 'one source → 40' : null;
          }),
        component('crossVenue',
          [op('logScore('), api('/raw/<chain>/market.json', 'VENUES'), op(', 1, 20 ) × ( 1 if both price sources answered, else 0.6 ) - from'),
            api('/raw/<chain>/market.json', 'PRICE, 2 SOURCES')],
          (v) => {
            const s = S(v); const n = ((s && s.sources) || {}).dexscreener ? s.sources.dexscreener.pairs : null;
            if (!fin(n)) return null;
            const agree = s.crossSource ? s.crossSource.sourcesAgreeing : 1;
            const l = logScore(n, 1, 20);
            return 'logScore(' + n + ') = ' + l + ' × ' + (agree > 1 ? 1 : 0.6) + ' → ' + to100((l / 100) * (agree > 1 ? 1 : 0.6));
          }),
        component('usdReference',
          [op('100 × clamp( 1 −'), ref('pipe', 'QUOTE DEVIATION'), op('÷ 2 )')],
          (v) => {
            const s = S(v); const r = s && s.usdReference;
            if (!r || !r.median || !fin(s.quoteTokenPriceUsd)) return null;
            const dev = Math.abs(s.quoteTokenPriceUsd - r.median) / r.median * 100;
            return '1 − ' + rnd(dev, 3) + ' ÷ 2 → ' + to100(1 - dev / 2);
          }),
      ],
    },
    {
      group: 'HOLDERS ENGINE', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'Who holds it and whether that base is growing. Concentration caps the score however well the token trades.',
      fields: [
        component('holderGrowth',
          [op('100 × clamp( 0.5 + 5 ×'), ref('pipe', 'HOLDER GROWTH RATE'), op('÷'), api('/raw/<chain>/intel.json', 'HOLDERS'),
            op('× 100 ) ; with no holder series: 100 × clamp( 0.5 + 1h holder % of'), api('/raw/<chain>/market.json', 'JUPITER STATS'), op('÷ 4 )')],
          (v) => {
            const h = (IN(v) || {}).holders; const g = h && h.growth;
            if (g && fin(g.perHour)) {
              const rate = h.count ? (g.perHour / h.count) * 100 : 0;
              return '0.5 + ' + rnd(rate, 4) + ' × 5 → ' + to100(0.5 + rate * 5);
            }
            const p = (((S(v) || {}).jupiter || {}).stats1h || {}).holderChangePct;
            return fin(p) ? 'Jupiter: 0.5 + ' + rnd(p, 2) + ' ÷ 4 → ' + to100(0.5 + p / 4) : null;
          }),
        component('walletQuality',
          [op('[ ( holder spread'), op('×'), num(35), op(') + ( crowd independence'), op('×'), num(30),
            op(') + ( volume spread'), op('×'), num(20), op(') + ( position intent'), op('×'), num(15),
            op(') ] ÷ [ the weights of the parts that have a value ], where holder spread = 1 −'),
            api('/raw/<chain>/intel.json', 'TOP HOLDERS SHARE'), op('÷ 60 and the other three come from'), ref('pipe', 'WALLET SAMPLE'),
            op('; then × 0.75 if insiders, × 0.8 if the creator launched 20+ tokens, × 1.15 if LP over 90% locked, from'),
            api('/raw/<chain>/intel.json', 'LP / CREATOR / INSIDERS')],
          (v) => {
            const q = (S(v) || {}).walletQuality; if (!q) return null;
            return weightedMath(q.parts, q.modifiers);
          },
          { where: 'calculations/core.js walletQualityScore() - the wallets module owns this number' }),
      ],
    },
    {
      group: 'ROTATION ENGINE', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'Where this pool’s capital came from — wallets shared with other pools, from the trade sample the wallet service already holds.',
      fields: [
        component('capitalRotation',
          [op('100 × clamp('), ref('pipe', 'SHARED WALLETS'), op('÷ 25 )')],
          (v) => { const p = ((S(v) || {}).rotation || {}).sharedWalletPct; return fin(p) ? rnd(p, 1) + ' ÷ 25 → ' + to100(p / 25) : null; }),
      ],
    },
    {
      group: 'COVERAGE ENGINE', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'How much of the model was measurable at all. It is a component in its own right, so a score built on half the inputs cannot look like one built on all of them.',
      fields: [
        component('dataQuality',
          [op('how many of the other'), num(SCORE_MODEL.length - 1),
            op('components resolved:'),
            ...SCORE_MODEL.filter((c) => c.key !== 'dataQuality').map((c) => ref('pipe', c.label)),
            op('÷'), num(SCORE_MODEL.length - 1), op('× 100')],
          (v) => {
            const list = ((S(v) || {}).scoreModel || []).filter((c) => c.key !== 'dataQuality');
            const got = list.filter((c) => !c.pending).length;
            return got + ' of ' + list.length + ' resolved' +
              (got < list.length ? ' - missing: ' + list.filter((c) => c.pending).map((c) => c.label).join(', ') : '');
          }),
      ],
    },
    {
      group: 'WASH & ORGANIC', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'Does the volume belong to different people. This does not ADD to the score - it multiplies the weighted mean, because wash-traded volume should scale the whole verdict down rather than cost it one term.',
      fields: [
        {
          label: 'Organic flow', status: 'live', weight: 'modifier',
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
          note: 'Not in the weighted average. Below 40 it raises LOW_ORGANIC_FLOW, which costs 3 ' +
            'points (2 when the number is Jupiter’s).',
          where: 'calculations/core.js organicFlowScore()',
        },
      ],
    },
    {
      group: 'CONTRACT SAFETY', stage: 3,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'What the contract itself allows. Also a multiplier, and the input the SELLABLE and TAX gates read before anything is scored at all.',
      fields: [
        {
          label: 'Contract safety', status: 'live', weight: 'modifier',
          value: (v) => valueOf(modOf(v, 'contractSafety')),
          calc: [api('/raw/<chain>/intel.json', 'CONTRACT CHECKS'), op('passed ÷ total × 100')],
          equation: (v) => {
            const cs = (IN(v) || {}).contractSafety; if (!cs || !cs.available) return null;
            const n = (cs.checks || []).length;
            return (n - cs.failedCount) + ' ÷ ' + n + ' → ' + Math.round(((n - cs.failedCount) / (n || 1)) * 100) +
              '   ' + said(modOf(v, 'contractSafety'));
          },
          note: 'Not in the weighted average. Under 100 it raises CONTRACT_CHECKS: 3 points, or 6 under 70.',
          where: 'asset-detail.js computeModifiers()',
        },
      ],
    },
    {
      group: 'WHITESPACE', stage: 3,
      note: 'Is the perp still up for grabs. A token another venue already lists has a perp, so ' +
        'there is nothing for Vibe to offer it.',
      fields: [
        {
          label: 'NO PERP ELSEWHERE', status: 'live',
          value: (v) => {
            const p = (P(v).raw || {}).perps;
            if (!p || !S(v)) return null;
            if (p.listedOn.length) return 'taken · ' + p.listedOn.length + ' venue' + (p.listedOn.length > 1 ? 's' : '');
            return p.checked ? 'open · ' + p.checked + '/' + p.total + ' checked' : 'unknown';
          },
          fetch: [ext('hyperliquid', 'perp markets'), ext('binance', 'USD-M perps'), ext('aster', 'perps'),
            ext('okx', 'swaps'), ext('bybit', 'linear perps')],
          calc: [api('/raw/perps.json', 'PERP VENUES'), op('symbols[ ticker ] - empty = whitespace, any venue = taken')],
          equation: (v) => {
            const p = (P(v).raw || {}).perps;
            if (!S(v)) return null;
            if (!p) return 'perps.json not written yet';
            const down = Object.keys(p.venues).filter((k) => !p.venues[k].ok).map((k) => p.venues[k].label);
            const ask = p.symbol + ' on ' + p.checked + ' of ' + p.total + ' venues';
            if (p.listedOn.length) {
              return ask + ' → listed on ' + p.listedOn.map((k) => (p.venues[k] || {}).label || k).join(', ') + ' → whitespace 0';
            }
            if (!p.checked) return 'no venue answered (' + down.join(', ') + ') - unknown, not open';
            return ask + ' → none list it → open' + (down.length ? '   (unreachable: ' + down.join(', ') + ')' : '');
          },
          note: 'Matched by TICKER - venues list symbols, not contracts - so a memecoin sharing a ticker ' +
            'with a listed coin shows as taken. A strong hint, not proof. An unreachable venue counts as ' +
            'unknown, never as "no perp there".',
          where: 'admin/AdminPanel.jsx loadRawBundle() perps; server lib/perps.js',
        },
        component('whitespace',
          [ref('pipe', 'NO PERP ELSEWHERE'), op('- no venue lists it →'), num(100), op(', any venue lists it →'), num(0),
            op(', no venue answered → left out')],
          (v) => {
            const p = ((S(v) || {}).facts || {}).perp;
            if (!p) return 'perps.json not read yet → left out of the average';
            if (p.listedOn.length) return p.listedOn.map((k) => p.labels[k] || k).join(', ') + ' list ' + p.symbol + ' → 0';
            if (!p.checked) return 'no venue answered → left out of the average';
            return 'none of the ' + p.checked + ' venues that answered list ' + p.symbol + ' → 100';
          }),
      ],
    },
    {
      group: 'REACHABILITY & INTENT', stage: 3,
      note: 'Is there a project behind the token, and is it spending on being found. Ethos ' +
        'reputation is shown but not scored (0 means no record, not a bad one).',
      fields: [
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
        {
          label: 'CONTACTABLE', status: 'live',
          value: (v) => {
            const l = (S(v) || {}).links || {};
            const n = ((l.socials || []).length) + ((l.websites || []).length);
            return n ? n + ' links' : null;
          },
          calc: [api('/raw/<chain>/market.json', 'LINKS'), op('count of socials + websites')],
          equation: (v) => {
            const l = (S(v) || {}).links || {};
            const kinds = (l.socials || []).map((x) => x.type).join(', ');
            return (kinds || 'no socials') + ' - ' + ((l.websites || []).length) + ' website(s)';
          },
          note: 'A project with no way to reach it cannot be pitched, however well it trades.',
          where: WHERE_NORM,
        },
        {
          label: 'BOOSTED', status: 'live',
          value: (v) => {
            const pr = (P(v).raw || {}).promotion;
            if (!pr || !S(v)) return null;
            const boost = pr.rows.some((r) => r.kind === 'BOOST');
            const profile = pr.rows.some((r) => r.kind === 'PROFILE');
            if (!boost && !profile) return 'not paying';
            return [boost ? 'boost' : null, profile ? 'profile' : null].filter(Boolean).join(' + ');
          },
          fetch: [ext('dexscreener', 'token-boosts/top, token-profiles/latest')],
          calc: [api('/raw/<chain>/promotion.json', 'PROMOTION'), op('rows[ this token ] - a BOOST or PROFILE row = paying for attention')],
          equation: (v) => {
            const pr = (P(v).raw || {}).promotion;
            if (!S(v)) return null;
            if (!pr) return 'promotion.json not written yet';
            if (!pr.rows.length) return 'not among the ' + pr.feedRows + ' boosted / profiled tokens on this chain';
            return pr.rows.map((r) => r.kind + (fin(r.totalAmount) ? ' ×' + r.totalAmount : '')).join(' + ');
          },
          note: 'DexScreener boosts and profiles are paid. A team that bought one is spending on growth ' +
            'right now - the warmest moment to pitch, and the first daily trigger in the listing spec. The ' +
            'feed is DexScreener\'s top list, so "not paying" can also mean "paid less than the top".',
          where: 'admin/AdminPanel.jsx loadRawBundle() promotion; server lib/providers.js fetchPromotion()',
        },
        component('reachability',
          [ref('pipe', 'CONTACTABLE'), op('website'), num(30), op('+ X'), num(30), op('+ Telegram'), num(20),
            op('+'), ref('pipe', 'BOOSTED'), num(20)],
          (v) => {
            const r = ((S(v) || {}).facts || {}).reach;
            if (!r) return null;
            const parts = [['website', 30], ['x', 30], ['telegram', 20], ['boosted', 20]]
              .map(([k, w]) => '(' + k + ' ' + (r[k] ? w : 0) + ')');
            return parts.join(' + ') + ' = ' + [['website', 30], ['x', 30], ['telegram', 20], ['boosted', 20]]
              .reduce((a, [k, w]) => a + (r[k] ? w : 0), 0);
          }),
      ],
    },
    {
      group: 'DURABILITY', stage: 3,
      note: 'Has it held together over time rather than in the last five minutes. Pool age only ' +
        'for now - the spec also asks for the 30-day liquidity trend and drawdown, which our ' +
        'samples are too short to give.',
      fields: [
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
        component('durability',
          [ref('pipe', 'SURVIVAL'), op('on a log curve: 14 days →'), num(0), op(', 180 days →'), num(100)],
          (v) => {
            const h = (S(v) || {}).poolAgeHours;
            if (!fin(h)) return null;
            const d = Math.max(h / 24, 1);
            return '( log10(' + rnd(d, 1) + ') − log10(14) ) ÷ ( log10(180) − log10(14) ) × 100 → ' + logScore(d, 14, 180);
          }),
      ],
    },

    /* --------------------------------------------------------- 4 GATES -- */
    //
    // Hard pass/fail, judged AFTER the engines - the wash gate reads Organic
    // flow, which an engine produces - and BEFORE the score is combined. A
    // failed gate sends RIGHT NOW and FINAL to 0, and the reason is what the
    // veto log lists. Gates answer 'should this count at all'; engines answer
    // 'how well does it score'. Keeping them apart is what stops a honeypot
    // from being rescued by good volume.
    //
    // A gate may only fail on EVIDENCE. Missing data is 'not checked', never a
    // failure - otherwise every token the intel collector has not reached yet
    // would be vetoed for being new rather than for being bad.
    {
      group: 'GATES', stage: 4, flat: true,
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
          calc: [api('/raw/<chain>/intel.json', 'CONTRACT CHECKS'), op('- buy, sell and transfer tax each at or under'), ref('pipe', PARAMS.maxTax.label)],
          equation: (v) => {
            const cs = (IN(v) || {}).contractSafety;
            if (!cs || !cs.available) return 'not checked yet';
            const hit = (cs.checks || []).find((c) => /tax/i.test(c.label || ''));
            return hit ? (hit.detail || hit.label) : 'no tax reading for this chain';
          },
          where: 'calculations/asset-detail.js deriveIntel()',
        },
        {
          label: 'NOT A MAJOR', status: 'live',
          value: (v) => verdict(gateOf(v, 'NOT A MAJOR')),
          calc: [api('/raw/<chain>/market.json', 'MARKET CAP'),
            op('under'), ref('pipe', PARAMS.majorCap.label), op('- the cap band, applied as a gate rather than a weight')],
          equation: (v) => {
            const mc = (S(v) || {}).marketCapUsd;
            return fin(mc) ? usd(mc) + ' against the $1B ceiling' : null;
          },
          note: 'Already applied upstream: a token that fails this never reaches the board, so every ' +
            'row you can select here passed it. It is drawn so the rule is visible rather than implied.',
          where: 'calculations/core.js screenRows()',
        },
        {
          label: 'REAL TICKER', status: 'live',
          value: (v) => (S(v) ? 'pass' : null),
          calc: [op('not a stablecoin, wrapped native or stock-ticker impersonation -'),
            ref('pipe', 'TOKEN LIST'), op('is screened before it is scored')],
          equation: (v) => {
            const s = S(v);
            return s ? (s.symbol || '?') + ' is not on the stable / wrapped / major list' : null;
          },
          where: 'calculations/core.js screenRows()',
        },
        // The three floors that separate a market from a listing: old enough
        // to be past the rug window, deep enough to price a perp against, and
        // traded enough that anyone would use one.
        {
          label: 'AGE FLOOR', status: 'live',
          value: (v) => verdict(gateOf(v, 'AGE FLOOR')),
          calc: [api('/raw/<chain>/market.json', 'POOL AGE'), op('at or over'), ref('pipe', PARAMS.minAgeDays.label)],
          equation: (v) => { const r = gateOf(v, 'AGE FLOOR'); return r ? r.detail : (S(v) ? 'no pool creation time - not checked' : null); },
          note: 'Most rugs happen in the first week. Under 14 days a token belongs to the new-launch ' +
            'lane, which has its own gates - until that lane exists, it is vetoed: score 0.',
          where: 'calculations/gates.js evaluateGates()',
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
          label: 'VOLUME FLOOR', status: 'live',
          value: (v) => verdict(gateOf(v, 'VOLUME FLOOR')),
          calc: [api('/raw/<chain>/market.json', 'VOLUME 24H'), op('at or over'), ref('pipe', PARAMS.minVolume24h.label)],
          equation: (v) => { const r = gateOf(v, 'VOLUME FLOOR'); return r ? r.detail : (S(v) ? 'no 24h volume reported - not checked' : null); },
          note: 'The spec asks for the 7-day MEDIAN of daily volume. The files hold only the last 24h, ' +
            'so one hot day can pass a token that is quiet the other six.',
          where: 'calculations/gates.js evaluateGates()',
        },
        {
          label: 'NOT WASH-FLAGGED', status: 'live',
          value: (v) => verdict(gateOf(v, 'NOT WASH-FLAGGED')),
          calc: [ref('pipe', 'Organic flow'), op('at or over'), ref('pipe', PARAMS.minOrganic.label)],
          equation: (v) => { const r = gateOf(v, 'NOT WASH-FLAGGED'); return r ? r.detail : (S(v) ? 'no trade sample for this pool yet - not checked' : null); },
          note: 'Under 40 the volume is mostly the same wallets trading with themselves, and a perp ' +
            'on fake volume has no real traders. A veto: the score goes to 0.',
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
    /* ----------------------------------------------------------- 5 SCORE -- */
    {
      group: 'SCORE', stage: 5, flat: true,
      fields: [
        {
          label: 'RAW', status: 'live',
          value: (v) => { const s = S(v); return s && fin(s.rawScore) ? s.rawScore : null; },
          // Written as the arithmetic: each component times its WEIGHT, summed,
          // divided by the sum of the weights. Printing "Volume anomaly ×13" as
          // a label read as a different term rather than as "× its weight 13".
          calc: [op('[')]
            .concat(...SCORE_MODEL.map((c, i) => [
              op((i ? '+ ' : '') + '('), ref('pipe', c.label), op('×'), num(c.weight), op(')'),
            ]))
            .concat([op('] ÷ [ the weights of the components that have a value ], each weight a WEIGHT parameter')]),
          equation: (v) => {
            const s = S(v); if (!s) return null;
            const used = (s.scoreModel || []).filter((c) => !c.pending && fin(c.value));
            const sum = used.reduce((a, c) => a + c.value * c.weight, 0);
            const w = used.reduce((a, c) => a + c.weight, 0);
            return '[ ' + used.map((c) => '(' + c.value + ' × ' + c.weight + ')').join(' + ') + ' ]' +
              ' ÷ [ ' + used.map((c) => c.weight).join(' + ') + ' ]' +
              ' = ' + Math.round(sum) + ' ÷ ' + w + ' = ' + s.rawScore;
          },
          note: 'Dividing by the weights that RESOLVED, not by ' + TOTAL_WEIGHT + ', is what stops a ' +
            'missing provider from dragging the score down.',
          where: 'calculations/asset-detail.js scoreAsset()',
        },
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
          note: 'Pool under 2h −4 (under 24h −2) · one price source −3 · liquidity under ' +
            '$50K −4 · 24h volume over 20x liquidity −3 · top-5 wallets over 70% of volume −4 · ' +
            'contract checks under 100 −3 (under 70 −6) · organic flow under 40 −3 (−2 Jupiter) · ' +
            'Ethos below the 1200 start and organic disagreement are raised for 0.',
          where: 'calculations/asset-detail.js assessRisk()',
        },
        {
          label: 'RISK PENALTY', status: 'live',
          value: (v) => { const s = S(v); return s && fin(s.riskPenalty) ? s.riskPenalty : null; },
          calc: [op('min('), num(15), op(', Σ penalties of'), ref('pipe', 'RISK FLAGS'), op(')')],
          equation: (v) => {
            const s = S(v); if (!s) return null;
            const sum = (s.riskFlags || []).reduce((a, f) => a + (f.penalty || 0), 0);
            return 'min( 15, ' + sum + ' ) = ' + s.riskPenalty;
          },
          where: 'assessRisk()',
        },
        {
          label: 'RIGHT NOW', status: 'live',
          value: (v) => { const s = S(v); return s && fin(s.scoreNow) ? s.scoreNow : null; },
          calc: [op('if'), ref('pipe', 'VETO LOG'), op('has a veto → 0, else clamp('), ref('pipe', 'RAW'),
            op('−'), ref('pipe', 'RISK PENALTY'), op(', 0, 100 )')],
          equation: (v) => {
            const s = S(v); if (!s) return null;
            if (s.vetoed) return 'vetoed (' + s.gates.vetoes.map((c) => c.label).join(', ') + ') → 0';
            return s.rawScore + ' − ' + s.riskPenalty + ' = ' + s.scoreNow;
          },
          where: 'scoreAsset()',
        },
        {
          label: 'RIGHT NOW, 15 MIN MEAN', status: 'live',
          value: (v) => { const xs = recentScores(v); return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null; },
          calc: [ref('pipe', 'RIGHT NOW')],
          agg: {
            fn: 'MEAN', fmt: (n) => String(Math.round(n)),
            what: 'every RIGHT NOW reading',
            every: 'poll (~5s)',
            window: { id: SCORE_MEAN_ID, ...SCORE_MEAN_WINDOW, live: true, note: 'the app keeps 15 min of readings' },
            points: (v) => recentScorePoints(v),
            result: (v) => meanOf(recentScores(v)),
          },
          note: 'The momentary score moves every poll because its biggest inputs are 5-minute ' +
            'windows; averaging over 15 minutes is what stops the board reshuffling.',
          where: 'asset-detail.js settledScore()',
        },
        {
          label: 'FINAL', status: 'live',
          value: (v) => { const s = S(v); return s && fin(s.score) ? s.score : null; },
          calc: [op('if'), ref('pipe', 'VETO LOG'), op('has a veto → 0, else'), ref('pipe', 'RIGHT NOW, 15 MIN MEAN')],
          equation: (v) => {
            const s = S(v); if (!s) return null;
            if (s.vetoed) return 'vetoed → 0';
            return 'no veto → ' + s.score;
          },
          note: 'The headline everywhere. A vetoed token is 0 at once, rather than being averaged ' +
            'down over 15 minutes.',
          where: 'asset-detail.js scoreAsset()',
        },
        {
          label: 'STAGE', status: 'live',
          value: (v) => (S(v) || {}).stage || null,
          calc: [op('if'), ref('pipe', 'FINAL'), op('≥ 85 → EXCEPTIONAL ; ≥ 70 → CONFIRMED ; ≥ 55 → EMERGING ; otherwise WATCH')],
          equation: (v) => {
            const s = S(v); if (!s) return null;
            const next = STAGES.slice().reverse().find((x) => x.min > s.score);
            return s.score + ' → ' + s.stage + (next ? ' · ' + (next.min - s.score) + ' to ' + next.name : '');
          },
          where: 'asset-detail.js stageFor()',
        },
        {
          label: 'COVERAGE', status: 'live',
          value: (v) => { const s = S(v); return s && fin(s.weightCovered) ? s.weightCovered + ' / ' + TOTAL_WEIGHT : null; },
          calc: [op('Σ weight of the components that resolved ÷'), num(TOTAL_WEIGHT),
            op('- the same resolved/pending set'), ref('pipe', 'Data quality'),
            op('counts, weighted instead of counted')],
          equation: (v) => { const s = S(v); return s ? s.componentsPresent + ' of ' + (s.scoreModel || []).length + ' components = ' + s.dataQuality : null; },
          note: 'The board’s CONF column.',
          where: 'scoreAsset(), dataQuality',
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
  'LIQUIDITY': ['Liquidity / executability', 'RISK FLAGS', 'LIQUIDITY FLOOR'],
  'VOLUME 24H': ['VOLUME FLOOR'],
  'PERP VENUES': ['NO PERP ELSEWHERE'],
  'PROMOTION': ['BOOSTED'],
  'BUYERS 24H': ['Buyer breadth'],
  'BUY/SELL 24H': ['Net demand'],
  'PRICE, 2 SOURCES': ['Price confirmation', 'Cross-venue confirm', 'RISK FLAGS'],
  'VENUES': ['Cross-venue confirm'],
  'QUOTE TOKEN PRICE': ['QUOTE DEVIATION'],
  'POOL AGE': ['SURVIVAL', 'RISK FLAGS', 'AGE FLOOR'],
  'VOLUME / LIQUIDITY': ['RISK FLAGS'],
  'JUPITER STATS': ['Net demand', 'Holder growth', 'Organic flow'],
  'POOL SAMPLES': [],
  'VOLUME 5M HISTORY': ['VOLUME 5M MEAN'],
  'BUYS 5M HISTORY': ['BUYS 5M MEAN'],
  'BUYERS 5M HISTORY': ['BUYERS 5M MEAN'],
  'VOLUME 5M NOW': ['VOLUME 5M vs BASELINE'],
  'BUYS 5M NOW': ['BUYS 5M vs BASELINE'],
  'BUYERS 5M NOW': ['BUYERS 5M vs BASELINE'],
  'TRADE SAMPLE': ['NET FLOW RATIO', 'TOP-5 WALLET SHARE', 'SHARED WALLETS', 'WALLET SAMPLE'],
  '$10K ROUTE QUOTE': ['PRICE IMPACT $10K'],
  'HOLDERS': ['HOLDER GROWTH RATE', 'Holder growth'],
  'TOP HOLDERS SHARE': ['Wallet quality'],
  'CONTRACT CHECKS': ['SELLABLE', 'TAX IN RANGE', 'Contract safety'],
  'LP / CREATOR / INSIDERS': ['Wallet quality'],
  'USD REFERENCE': ['QUOTE DEVIATION'],
  'ETHOS (PROJECT X)': ['PROJECT REPUTATION'],
  'LINKS': ['CONTACTABLE'],
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
  'BUY/SELL 24H': {
    from: 'market',
    picks: [{ path: GT + 'transactions.h24.buys', to: 'BUYS ÷ SELLS' }, { path: GT + 'transactions.h24.sells', to: 'BUYS ÷ SELLS' }],
    outs: [{ label: 'BUYS ÷ SELLS', value: (v) => rnd((S(v) || {}).buySellRatio24h, 2) }],
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
  VENUES: {
    from: 'market',
    picks: [{ path: DS + 'pairsListed', to: 'VENUES' }],
    outs: [{ label: 'VENUES', value: (v) => count((((S(v) || {}).sources || {}).dexscreener || {}).pairs) }],
  },
  'QUOTE TOKEN PRICE': {
    from: 'market',
    picks: [{ path: GT + 'quoteTokenPriceUsd', to: 'QUOTE PRICE' }, { path: 'quoteSymbol', to: 'QUOTE PRICE' }],
    outs: [{ label: 'QUOTE PRICE', value: (v) => { const s = S(v); return s && fin(s.quoteTokenPriceUsd) ? '$' + s.quoteTokenPriceUsd.toFixed(4) : null; } }],
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
    ['BUYS 5M HISTORY', 'buys5m', count],
    ['BUYERS 5M HISTORY', 'buyers5m', count],
  ].map(([reading, metric, fmt]) => [reading, {
    from: 'history', last: true,
    picks: [{ path: '[].' + metric, to: reading }],
    outs: [{ label: reading, value: (v) => { const m = Z(v)[metric]; return m ? m.samples + ' samples' : null; } }],
  }])),
  // ...and the newest sample of each, which is what a measure compares.
  ...Object.fromEntries([
    ['VOLUME 5M NOW', 'volume5mUsd', usd],
    ['BUYS 5M NOW', 'buys5m', count],
    ['BUYERS 5M NOW', 'buyers5m', count],
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
  'USD REFERENCE': {
    from: 'reference',
    picks: [{ path: 'quotes', to: 'MEDIAN' }, { path: 'quotes[].price', to: 'MEDIAN' }],
    outs: [{ label: 'MEDIAN', value: (v) => { const r = (S(v) || {}).usdReference; return r && fin(r.median) ? '$' + r.median.toFixed(4) : null; } }],
  },
  'VOLUME 24H': {
    from: 'market',
    picks: [{ path: DS + 'volumeUsd.h24', to: 'VOLUME 24H' }, { path: GT + 'volumeUsd.h24', to: 'VOLUME 24H', alt: true }],
    outs: [{ label: 'VOLUME 24H', value: (v) => usd((S(v) || {}).volume24hUsd) }],
  },
  'PERP VENUES': {
    from: 'perps',
    picks: [{ path: 'listedOn', to: 'LISTED ON' }, { path: 'checked', to: 'VENUES ANSWERED' }, { path: 'total', to: 'VENUES ANSWERED' }],
    outs: [
      { label: 'LISTED ON', value: (v) => { const p = (P(v).raw || {}).perps; return p ? (p.listedOn.join(', ') || 'none') : null; } },
      { label: 'VENUES ANSWERED', value: (v) => { const p = (P(v).raw || {}).perps; return p ? p.checked + ' / ' + p.total : null; } },
    ],
  },
  'PROMOTION': {
    from: 'promotion',
    picks: [{ path: 'rows[].kind', to: 'PAID FOR' }, { path: 'rows[].totalAmount', to: 'PAID FOR' }],
    outs: [{ label: 'PAID FOR', value: (v) => { const pr = (P(v).raw || {}).promotion; return pr ? (pr.rows.map((r) => r.kind).join(' + ') || 'nothing') : null; } }],
  },
  'MARKET CAP': {
    from: 'market',
    picks: [{ path: DS + 'marketCapUsd', to: 'MARKET CAP' }, { path: GT + 'marketCapUsd', to: 'MARKET CAP', alt: true }],
    outs: [{ label: 'MARKET CAP', value: (v) => { const x = (S(v) || {}).marketCapUsd; return fin(x) ? usd(x) : null; } }],
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
  'PRICE CHANGE 5M': {
    from: 'market',
    picks: [{ path: DS + 'priceChangePct.m5', to: 'DELTA 5M' }, { path: GT + 'priceChangePct.m5', to: 'DELTA 5M', alt: true }],
    outs: [{ label: 'DELTA 5M', value: (v) => {
      const s = (((P(v).raw || {}).market || {}).sources) || {};
      const x = ((s.dexscreener || {}).priceChangePct || {}).m5 ?? ((s.geckoterminal || {}).priceChangePct || {}).m5;
      return fin(x) ? signed(x, 2) + '%' : null;
    } }],
  },
  LINKS: {
    from: 'market',
    picks: [{ path: 'links.socials', to: 'LINKS' }, { path: 'links.websites', to: 'LINKS' }],
    outs: [{ label: 'LINKS', value: (v) => {
      const l = (S(v) || {}).links; if (!l) return null;
      return ((l.socials || []).length) + ' socials · ' + ((l.websites || []).length) + ' websites';
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
tag('FINAL', { decision: { test: (v) => (S(v) ? !S(v).vetoed : null), yes: 'NO VETO → the mean', no: 'VETO → 0' } });

// Curves: a raw number turned into 0-100, with this token's point on it.
const multipleCurve = (metric) => ({
  f: multipleScore, x: (v) => (Z(v)[metric] || {}).multiple, lo: 0.05, hi: 50, log: true, xFmt: (n) => rnd(n, 2) + 'x',
});
tag('Volume anomaly', { curve: multipleCurve('volume5mUsd') });
tag('Trade activity', { curve: multipleCurve('buys5m') });
tag('Durability', { curve: {
  f: (d) => logScore(Math.max(d, 1), 14, 180), x: (v) => { const h = (S(v) || {}).poolAgeHours; return fin(h) ? h / 24 : null; },
  lo: 1, hi: 400, log: true, xFmt: (d) => rnd(d, 1) + 'd',
} });
tag('Price confirmation', { curve: {
  f: (d) => to100(1 - Math.abs(d) / 5), x: (v) => ((S(v) || {}).crossSource || {}).priceDeltaPct,
  lo: -6, hi: 6, log: false, xFmt: (d) => rnd(d, 2) + '%',
} });

// Joins: this token looked up in a list.
tag('NO PERP ELSEWHERE', { join: {
  key: (v) => { const p = (P(v).raw || {}).perps; return p ? p.symbol : null; }, by: 'ticker',
  against: (v) => { const p = (P(v).raw || {}).perps; return p ? 'perp markets on ' + p.checked + ' of ' + p.total + ' venues' : null; },
  matches: (v) => { const p = (P(v).raw || {}).perps; return p ? p.listedOn.map((k) => (p.venues[k] || {}).label || k) : []; },
} });
tag('BOOSTED', { join: {
  key: (v) => { const s = S(v); return s ? String(s.tokenAddress || '').slice(0, 6) + '…' + String(s.tokenAddress || '').slice(-4) : null; }, by: 'address',
  against: (v) => { const pr = (P(v).raw || {}).promotion; return pr ? pr.feedRows + ' boosted / profiled tokens on this chain' : null; },
  matches: (v) => { const pr = (P(v).raw || {}).promotion; return pr ? pr.rows.map((r) => r.kind + (fin(r.totalAmount) ? ' ×' + r.totalAmount : '')) : []; },
} });

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
    { label: 'not a stablecoin, wrapped native or major (cap under MAJOR CAP)',
      apply: (rows) => rows.filter((r) => !isMajorToken(r, { maxMarketCapUsd: paramValue('majorCap') })) },
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
    node('screen', 'FILTER', 'SCREEN', ['@first', ref('pipe', PARAMS.majorCap.label)], null,
      (v) => { const n = screened(v).length; return n ? n + ' tokens' : null; },
      { filter: { rows: normalized, of: 'rows', rules: screenRules } }),
    node('count', 'COUNT BY', 'TOKEN LIST', ['@screen'],
      (v) => { const m = byChain(screened(v)); const ks = Object.keys(m); return ks.length ? ks.map((k) => k + ' ' + m[k]).join(' · ') : null; },
      null, { note: 'The board: every token that passed, counted per chain.',
        raw: (v) => { const m = byChain(screened(v)); return Object.keys(m).length ? m : null; } }),
  ]);
}

// ---- SCORE ------------------------------------------------------------------
opsOf('RISK PENALTY', [
  node('sum', 'SUM', 'PENALTIES SUM', [ref('pipe', 'RISK FLAGS')],
    (v) => { const f = (S(v) || {}).riskFlags || []; return f.length ? f.map((x) => x.penalty || 0).join(' + ') : 'no flags'; },
    (v) => { const s = S(v); return s ? (s.riskFlags || []).reduce((a, x) => a + (x.penalty || 0), 0) : null; }),
  node('min', 'MIN', 'RISK PENALTY', ['@sum'],
    (v) => { const s = S(v); if (!s) return null; const sum = (s.riskFlags || []).reduce((a, x) => a + (x.penalty || 0), 0); return 'min( ' + sum + ', 15 )'; },
    null, { note: 'Capped at 15, so a pile-up of related flags cannot sink a token on its own.' }),
]);
opsOf('RIGHT NOW', [
  node('sub', '−', 'RAW − PENALTY', [ref('pipe', 'RAW'), ref('pipe', 'RISK PENALTY')],
    (v) => { const s = S(v); return s ? s.rawScore + ' − ' + s.riskPenalty : null; },
    (v) => { const s = S(v); return s ? s.rawScore - s.riskPenalty : null; }),
  node('clamp', 'CLAMP', 'CLAMP 0–100', ['@sub'],
    (v) => { const s = S(v); return s ? 'clamp( ' + (s.rawScore - s.riskPenalty) + ', 0, 100 )' : null; },
    (v) => { const s = S(v); return s ? Math.max(0, Math.min(100, s.rawScore - s.riskPenalty)) : null; }),
  ifNode('if', 'RIGHT NOW', [ref('pipe', 'VETO LOG'), '@clamp'], 'VETO LOG has a veto',
    (v) => (S(v) ? Boolean(S(v).vetoed) : null), () => 0,
    (v) => { const s = S(v); return s ? Math.max(0, Math.min(100, s.rawScore - s.riskPenalty)) : null; }),
]);
opsOf('FINAL', [
  ifNode('if', 'FINAL', [ref('pipe', 'VETO LOG'), ref('pipe', 'RIGHT NOW, 15 MIN MEAN')], 'VETO LOG has a veto',
    (v) => (S(v) ? Boolean(S(v).vetoed) : null), () => 0,
    (v) => { const xs = recentScores(v); return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null; },
    { note: 'A vetoed token is 0 at once, rather than averaged down over 15 minutes.' }),
]);
opsOf('STAGE', [
  node('sw', 'SWITCH', 'STAGE', [ref('pipe', 'FINAL')], null, null, { cond: {
    kind: 'SWITCH', input: (v) => (S(v) ? S(v).score : null),
    cases: STAGES.map((st) => ({ when: st.min ? '≥ ' + st.min : 'otherwise', then: st.name, min: st.min })),
  } }),
]);
opsOf('COVERAGE', [
  node('sum', 'SUM', 'WEIGHT RESOLVED', SCORE_MODEL.map((c) => ref('pipe', c.label)).concat(SCORE_MODEL.map((c) => ref('pipe', weightLabel(c)))),
    (v) => { const m = ((S(v) || {}).scoreModel || []).filter((c) => !c.pending); return m.map((c) => c.weight).join(' + ') || null; },
    (v) => { const s = S(v); return s ? s.weightCovered : null; }),
  node('div', '÷', 'COVERAGE', ['@sum'],
    (v) => { const s = S(v); return s ? s.weightCovered + ' ÷ ' + TOTAL_WEIGHT : null; }, null),
]);

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
opsOf('HOLDER GROWTH RATE', [
  node('sub', '−', 'LAST − FIRST', [api('/raw/<chain>/intel.json', 'HOLDERS')],
    (v) => { const g = (((IN(v) || {}).holders) || {}).growth; return g ? 'holders now − holders ' + minutes(g.windowMs) + ' ago' : null; },
    (v) => { const g = (((IN(v) || {}).holders) || {}).growth; return g && fin(g.changed) ? signed(g.changed, 0) : null; }),
  node('div', '÷', 'HOLDER GROWTH RATE', ['@sub'],
    (v) => { const g = (((IN(v) || {}).holders) || {}).growth; return g && fin(g.changed) ? signed(g.changed, 0) + ' ÷ ' + rnd(g.windowMs / 3600000, 2) + ' h' : null; }, null),
]);
opsOf('QUOTE DEVIATION', [
  node('sub', '−', 'QUOTE − REFERENCE', [api('/raw/<chain>/market.json', 'QUOTE TOKEN PRICE'), api('/raw/reference.json', 'USD REFERENCE')],
    (v) => { const s = S(v); const r = s && s.usdReference; return r && fin(s.quoteTokenPriceUsd) ? usd(s.quoteTokenPriceUsd) + ' − ' + usd(r.median) : null; },
    (v) => { const s = S(v); const r = s && s.usdReference; return r && fin(s.quoteTokenPriceUsd) ? rnd(s.quoteTokenPriceUsd - r.median, 4) : null; }),
  node('abs', '|x|', 'DISTANCE', ['@sub'],
    (v) => { const s = S(v); const r = s && s.usdReference; return r && fin(s.quoteTokenPriceUsd) ? '| ' + rnd(s.quoteTokenPriceUsd - r.median, 4) + ' |' : null; },
    (v) => { const s = S(v); const r = s && s.usdReference; return r && fin(s.quoteTokenPriceUsd) ? rnd(Math.abs(s.quoteTokenPriceUsd - r.median), 4) : null; }),
  node('div', '÷', '÷ REFERENCE', ['@abs', api('/raw/reference.json', 'USD REFERENCE')],
    (v) => { const s = S(v); const r = s && s.usdReference; return r && fin(s.quoteTokenPriceUsd) ? rnd(Math.abs(s.quoteTokenPriceUsd - r.median), 4) + ' ÷ ' + usd(r.median) : null; },
    (v) => { const s = S(v); const r = s && s.usdReference; return r && fin(s.quoteTokenPriceUsd) ? rnd(Math.abs(s.quoteTokenPriceUsd - r.median) / r.median, 6) : null; }),
  node('mul', '×', 'QUOTE DEVIATION', ['@div'],
    (v) => { const s = S(v); const r = s && s.usdReference; return r && fin(s.quoteTokenPriceUsd) ? rnd(Math.abs(s.quoteTokenPriceUsd - r.median) / r.median, 6) + ' × 100' : null; }, null),
]);

// ---- COMPONENTS -------------------------------------------------------------
opsOf('Buyer breadth', [
  node('a', 'CURVE', 'ANOMALY SCORE', [ref('pipe', 'BUYERS 5M vs BASELINE')],
    (v) => { const m = (Z(v).buyers5m || {}).multiple; return fin(m) ? 'multipleScore( ' + m + 'x )' : null; },
    (v) => { const m = (Z(v).buyers5m || {}).multiple; return fin(m) ? multipleScore(m) : null; }),
  node('b', 'CURVE', 'ABSOLUTE SCORE', [api('/raw/<chain>/market.json', 'BUYERS 24H')],
    (v) => { const b = ((S(v) || {}).traders24h || {}).buyers; return fin(b) ? 'logScore( ' + b + ', 10, 3000 )' : null; },
    (v) => logScore(((S(v) || {}).traders24h || {}).buyers, 10, 3000)),
  node('mean', 'MEAN', 'Buyer breadth', ['@a', '@b'],
    (v) => {
      const m = (Z(v).buyers5m || {}).multiple; const a = fin(m) ? multipleScore(m) : null;
      const b = logScore(((S(v) || {}).traders24h || {}).buyers, 10, 3000);
      if (a !== null && b !== null) return '½ × ' + a + ' + ½ × ' + b;
      return a !== null ? 'only the anomaly: ' + a : (b !== null ? 'only the absolute: ' + b : null);
    }, null),
]);
opsOf('Net demand', [
  node('div', '÷', 'NET RATIO ÷ 2', [ref('pipe', 'NET FLOW RATIO')],
    (v) => { const t = TS(v); return t && fin(t.netRatio) ? t.netRatio + ' ÷ 2' : null; },
    (v) => { const t = TS(v); return t && fin(t.netRatio) ? rnd(t.netRatio / 2, 4) : null; }),
  node('add', '+', '+ 0.5', ['@div'],
    (v) => { const t = TS(v); return t && fin(t.netRatio) ? rnd(t.netRatio / 2, 4) + ' + 0.5' : null; },
    (v) => { const t = TS(v); return t && fin(t.netRatio) ? rnd(0.5 + t.netRatio / 2, 4) : null; }),
  node('clamp', 'CLAMP', 'TO 0–100', ['@add'],
    (v) => { const t = TS(v); return t && fin(t.netRatio) ? '100 × clamp( ' + rnd(0.5 + t.netRatio / 2, 4) + ', 0, 1 )' : null; },
    (v) => { const t = TS(v); return t && fin(t.netRatio) ? clampPct(0.5 + t.netRatio / 2) : null; }),
  ifNode('if', 'Net demand', ['@clamp', api('/raw/<chain>/market.json', 'JUPITER STATS'), api('/raw/<chain>/market.json', 'BUY/SELL 24H')],
    'we have a trade sample',
    (v) => (S(v) ? Boolean(TS(v) && fin(TS(v).netRatio)) : null),
    (v) => clampPct(0.5 + TS(v).netRatio / 2),
    (v) => valueOf(comp(v, 'netDemand')),
    { note: 'Without a trade sample of our own: Jupiter’s net ratio, else the 24h buy/sell counts.' }),
]);
opsOf('Liquidity / executability', [
  node('depth', 'CURVE', 'DEPTH SCORE', [api('/raw/<chain>/market.json', 'LIQUIDITY')],
    (v) => { const l = (S(v) || {}).liquidityUsd; return fin(l) ? 'logScore( ' + usd(l) + ', $10K, $1M )' : null; },
    (v) => logScore((S(v) || {}).liquidityUsd, 10000, 1000000)),
  node('idiv', '÷', 'IMPACT ÷ 2.5', [ref('pipe', 'PRICE IMPACT $10K')],
    (v) => { const ip = ((IN(v) || {}).impact || {}).priceImpactPct; return fin(ip) ? rnd(ip, 3) + ' ÷ 2.5' : null; },
    (v) => { const ip = ((IN(v) || {}).impact || {}).priceImpactPct; return fin(ip) ? rnd(ip / 2.5, 4) : null; }),
  node('isub', '−', '1 − x', ['@idiv'],
    (v) => { const ip = ((IN(v) || {}).impact || {}).priceImpactPct; return fin(ip) ? '1 − ' + rnd(ip / 2.5, 4) : null; },
    (v) => { const ip = ((IN(v) || {}).impact || {}).priceImpactPct; return fin(ip) ? rnd(1 - ip / 2.5, 4) : null; }),
  node('iclamp', 'CLAMP', 'IMPACT SCORE', ['@isub'],
    (v) => { const ip = ((IN(v) || {}).impact || {}).priceImpactPct; return fin(ip) ? '100 × clamp( ' + rnd(1 - ip / 2.5, 4) + ', 0, 1 )' : null; },
    (v) => { const ip = ((IN(v) || {}).impact || {}).priceImpactPct; return fin(ip) ? clampPct(1 - ip / 2.5) : null; }),
  node('mean', 'MEAN', 'Liquidity / executability', ['@depth', '@iclamp'],
    (v) => {
      const d = logScore((S(v) || {}).liquidityUsd, 10000, 1000000);
      const ip = ((IN(v) || {}).impact || {}).priceImpactPct; const i = fin(ip) ? clampPct(1 - ip / 2.5) : null;
      if (d !== null && i !== null) return '½ × ' + d + ' + ½ × ' + i;
      return d !== null ? 'only the depth: ' + d : (i !== null ? 'only the impact: ' + i : null);
    }, null),
]);
opsOf('Cross-venue confirm', [
  node('curve', 'CURVE', 'VENUES SCORE', [api('/raw/<chain>/market.json', 'VENUES')],
    (v) => { const s = S(v); const n = s && s.sources && s.sources.dexscreener ? s.sources.dexscreener.pairs : null; return fin(n) ? 'logScore( ' + n + ', 1, 20 )' : null; },
    (v) => { const s = S(v); const n = s && s.sources && s.sources.dexscreener ? s.sources.dexscreener.pairs : null; return fin(n) ? logScore(n, 1, 20) : null; }),
  ifNode('factor', 'SOURCES FACTOR', [api('/raw/<chain>/market.json', 'PRICE, 2 SOURCES')], 'both price sources answered',
    (v) => (S(v) ? ((S(v).crossSource || {}).sourcesAgreeing || 1) > 1 : null), () => 1, () => 0.6),
  node('mul', '×', 'Cross-venue confirm', ['@curve', '@factor'],
    (v) => {
      const s = S(v); const n = s && s.sources && s.sources.dexscreener ? s.sources.dexscreener.pairs : null;
      if (!fin(n)) return null;
      return logScore(n, 1, 20) + ' × ' + (((s.crossSource || {}).sourcesAgreeing || 1) > 1 ? 1 : 0.6);
    }, null),
]);
opsOf('USD reference', [
  node('div', '÷', 'DEVIATION ÷ 2', [ref('pipe', 'QUOTE DEVIATION')],
    (v) => { const s = S(v); const r = s && s.usdReference; if (!r || !r.median || !fin(s.quoteTokenPriceUsd)) return null; return rnd(Math.abs(s.quoteTokenPriceUsd - r.median) / r.median * 100, 3) + ' ÷ 2'; },
    (v) => { const s = S(v); const r = s && s.usdReference; if (!r || !r.median || !fin(s.quoteTokenPriceUsd)) return null; return rnd(Math.abs(s.quoteTokenPriceUsd - r.median) / r.median * 50, 4); }),
  node('sub', '−', '1 − x', ['@div'],
    (v) => { const s = S(v); const r = s && s.usdReference; if (!r || !r.median || !fin(s.quoteTokenPriceUsd)) return null; return '1 − ' + rnd(Math.abs(s.quoteTokenPriceUsd - r.median) / r.median * 50, 4); },
    (v) => { const s = S(v); const r = s && s.usdReference; if (!r || !r.median || !fin(s.quoteTokenPriceUsd)) return null; return rnd(1 - Math.abs(s.quoteTokenPriceUsd - r.median) / r.median * 50, 4); }),
  node('clamp', 'CLAMP', 'USD reference', ['@sub'],
    (v) => { const s = S(v); const r = s && s.usdReference; if (!r || !r.median || !fin(s.quoteTokenPriceUsd)) return null; return '100 × clamp( ' + rnd(1 - Math.abs(s.quoteTokenPriceUsd - r.median) / r.median * 50, 4) + ', 0, 1 )'; }, null),
]);
opsOf('Holder growth', [
  node('div', '÷', 'RATE % / HOUR', [ref('pipe', 'HOLDER GROWTH RATE'), api('/raw/<chain>/intel.json', 'HOLDERS')],
    (v) => { const h = (IN(v) || {}).holders; const g = h && h.growth; return g && fin(g.perHour) && h.count ? signed(g.perHour) + ' ÷ ' + count(h.count) + ' × 100' : null; },
    (v) => { const h = (IN(v) || {}).holders; const g = h && h.growth; return g && fin(g.perHour) && h.count ? rnd((g.perHour / h.count) * 100, 4) : null; }),
  node('mul', '×', '× 5', ['@div'],
    (v) => { const h = (IN(v) || {}).holders; const g = h && h.growth; return g && fin(g.perHour) && h.count ? rnd((g.perHour / h.count) * 100, 4) + ' × 5' : null; },
    (v) => { const h = (IN(v) || {}).holders; const g = h && h.growth; return g && fin(g.perHour) && h.count ? rnd((g.perHour / h.count) * 500, 4) : null; }),
  node('add', '+', '+ 0.5', ['@mul'],
    (v) => { const h = (IN(v) || {}).holders; const g = h && h.growth; return g && fin(g.perHour) && h.count ? '0.5 + ' + rnd((g.perHour / h.count) * 500, 4) : null; },
    (v) => { const h = (IN(v) || {}).holders; const g = h && h.growth; return g && fin(g.perHour) && h.count ? rnd(0.5 + (g.perHour / h.count) * 500, 4) : null; }),
  ifNode('if', 'Holder growth', ['@add', api('/raw/<chain>/market.json', 'JUPITER STATS')], 'we have a holder series',
    (v) => (S(v) ? Boolean(((((IN(v) || {}).holders) || {}).growth || {}).perHour !== undefined) : null),
    (v) => valueOf(comp(v, 'holderGrowth')), (v) => valueOf(comp(v, 'holderGrowth')),
    { note: 'THEN: 100 × clamp( the + 0.5 result ). ELSE: Jupiter’s 1h holder change, 100 × clamp( 0.5 + % ÷ 4 ).' }),
]);
opsOf('Capital rotation', [
  node('div', '÷', 'SHARED ÷ 25', [ref('pipe', 'SHARED WALLETS')],
    (v) => { const p = ((S(v) || {}).rotation || {}).sharedWalletPct; return fin(p) ? rnd(p, 1) + ' ÷ 25' : null; },
    (v) => { const p = ((S(v) || {}).rotation || {}).sharedWalletPct; return fin(p) ? rnd(p / 25, 4) : null; }),
  node('clamp', 'CLAMP', 'Capital rotation', ['@div'],
    (v) => { const p = ((S(v) || {}).rotation || {}).sharedWalletPct; return fin(p) ? '100 × clamp( ' + rnd(p / 25, 4) + ', 0, 1 )' : null; }, null),
]);
opsOf('Data quality', [
  node('count', 'COUNT', 'RESOLVED', SCORE_MODEL.filter((c) => c.key !== 'dataQuality').map((c) => ref('pipe', c.label)),
    (v) => { const l = ((S(v) || {}).scoreModel || []).filter((c) => c.key !== 'dataQuality'); return l.length ? 'components with a value, of ' + l.length : null; },
    (v) => { const l = ((S(v) || {}).scoreModel || []).filter((c) => c.key !== 'dataQuality'); return l.length ? l.filter((c) => !c.pending).length : null; }),
  node('div', '÷', 'SHARE', ['@count'],
    (v) => { const l = ((S(v) || {}).scoreModel || []).filter((c) => c.key !== 'dataQuality'); return l.length ? l.filter((c) => !c.pending).length + ' ÷ ' + l.length : null; },
    (v) => { const l = ((S(v) || {}).scoreModel || []).filter((c) => c.key !== 'dataQuality'); return l.length ? rnd(l.filter((c) => !c.pending).length / l.length, 3) : null; }),
  node('mul', '×', 'Data quality', ['@div'],
    (v) => { const l = ((S(v) || {}).scoreModel || []).filter((c) => c.key !== 'dataQuality'); return l.length ? rnd(l.filter((c) => !c.pending).length / l.length, 3) + ' × 100' : null; }, null),
]);
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
opsOf('Whitespace', [
  ifNode('listed', 'LISTED ELSEWHERE?', [ref('pipe', 'NO PERP ELSEWHERE')], 'a venue lists the ticker',
    (v) => { const p = ((S(v) || {}).facts || {}).perp; return p ? p.listedOn.length > 0 : null; }, () => 0,
    (v) => { const p = ((S(v) || {}).facts || {}).perp; return p && p.checked ? 100 : null; }),
  ifNode('if', 'Whitespace', ['@listed'], 'at least one venue answered',
    (v) => { const p = ((S(v) || {}).facts || {}).perp; return p ? p.checked > 0 : null; },
    (v) => valueOf(comp(v, 'whitespace')), () => null,
    { note: 'With no venue answering, the component is left out of the score rather than called open.' }),
]);
{
  const r = (v) => ((S(v) || {}).facts || {}).reach || null;
  const term = (id, label, key, w, from) => ifNode(id, label, [ref('pipe', from)], 'has ' + key,
    (v) => (r(v) ? Boolean(r(v)[key]) : null), () => w, () => 0);
  opsOf('Reachability', [
    term('site', 'WEBSITE', 'website', 30, 'CONTACTABLE'),
    term('x', 'X ACCOUNT', 'x', 30, 'CONTACTABLE'),
    term('tg', 'TELEGRAM', 'telegram', 20, 'CONTACTABLE'),
    term('paid', 'PAID PROMOTION', 'boosted', 20, 'BOOSTED'),
    node('sum', 'SUM', 'Reachability', ['@site', '@x', '@tg', '@paid'],
      (v) => { const x = r(v); return x ? [x.website ? 30 : 0, x.x ? 30 : 0, x.telegram ? 20 : 0, x.boosted ? 20 : 0].join(' + ') : null; }, null),
  ]);
}
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

// SHARED WALLETS: this sample's wallets also seen in another sampled pool,
// as a share of all its wallets (core.js rotationFor()).
{
  const rot = (v) => (S(v) || {}).rotation || null;
  const own = (v) => {
    const r = rot(v);
    if (r && fin(r.sharedWalletPct) && r.sharedWalletPct > 0) return Math.round((r.sharedWalletCount * 100) / r.sharedWalletPct);
    return new Set(tradesOf(v).map((t) => t.wallet)).size || null;
  };
  opsOf('SHARED WALLETS', [
    node('own', 'COUNT', 'WALLETS IN SAMPLE', [api('/raw/<chain>/trades.json', 'TRADE SAMPLE')],
      (v) => (own(v) ? 'distinct wallets in this pool’s sample' : null), (v) => own(v)),
    node('shared', 'COUNT', 'ALSO IN ANOTHER POOL', [api('/raw/<chain>/trades.json', 'TRADE SAMPLE')],
      (v) => { const r = rot(v); return r ? 'wallets also seen in ' + r.poolsCompared + ' other sampled pools' : null; },
      (v) => { const r = rot(v); return r ? r.sharedWalletCount : null; }),
    node('div', '÷', 'SHARE', ['@shared', '@own'],
      (v) => { const r = rot(v); const o = own(v); return r && o ? r.sharedWalletCount + ' ÷ ' + o : null; },
      (v) => { const r = rot(v); const o = own(v); return r && o ? rnd(r.sharedWalletCount / o, 4) : null; }),
    node('mul', '×', 'SHARED WALLETS', ['@div'],
      (v) => { const r = rot(v); const o = own(v); return r && o ? rnd(r.sharedWalletCount / o, 4) + ' × 100' : null; }, null),
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

// CONTACTABLE: the links extracted, counted.
opsOf('CONTACTABLE', [
  node('soc', 'COUNT', 'SOCIALS', [api('/raw/<chain>/market.json', 'LINKS')],
    (v) => { const l = (S(v) || {}).links; return l ? ((l.socials || []).map((x) => x.type).join(', ') || 'none') : null; },
    (v) => { const l = (S(v) || {}).links; return l ? (l.socials || []).length : null; }),
  node('web', 'COUNT', 'WEBSITES', [api('/raw/<chain>/market.json', 'LINKS')],
    (v) => { const l = (S(v) || {}).links; return l ? (l.websites || []).length + ' website(s)' : null; },
    (v) => { const l = (S(v) || {}).links; return l ? (l.websites || []).length : null; }),
  node('sum', '+', 'CONTACTABLE', ['@soc', '@web'],
    (v) => { const l = (S(v) || {}).links; return l ? (l.socials || []).length + ' + ' + (l.websites || []).length : null; }, null),
]);

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

// RAW: every component × its weight (the weights are the WEIGHT · <component>
// parameters, so changing one changes this group's arithmetic).
{
  const raw = weightedOps('RAW',
    SCORE_MODEL.map((c) => ({ label: c.label, weight: c.weight, from: ref('pipe', c.label), weightFrom: ref('pipe', weightLabel(c)) })),
    (v) => ((S(v) || {}).scoreModel || []).map((c) => ({ label: c.label, value: c.pending ? null : c.value, weight: weightNow(c) })));
  const f = fieldBy('RAW');
  if (f) {
    const scoreValue = f.value;
    // At the default weights: the score's own RAW. With a weight changed:
    // the map's arithmetic, a preview of what RAW would be.
    f.value = (v) => {
      if (!SCORE_MODEL.some((c) => weightNow(c) !== c.weight)) return scoreValue(v);
      return raw.used(v).length ? Math.round(raw.total(v) / raw.weights(v)) : null;
    };
  }
}

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
tag('RIGHT NOW, 15 MIN MEAN', { memory: 'keeps every RIGHT NOW reading for 15 minutes' });
tag('STAGE', { memory: 'remembers when the stage last changed' });
tag('WALLET SAMPLE', { memory: 'the wallet service keeps each pool’s sample between polls',
  service: { every: '5s', keeps: 'each pool’s wallet sample between polls', costs: 'nothing - it re-reads the trade samples' } });
tag('HOLDER GROWTH RATE', { memory: 'built from the holder counts collected over time' });

// Parameters: the constants the model is tuned by, as boxes of their own.
const param = (key) => {
  const p = PARAMS[key];
  return {
    label: p.label, status: 'live', calc: [], note: p.note,
    param: { id: paramId(key), def: p.def, step: p.step, min: p.min, max: p.max },
    value: () => paramValue(key),
    where: 'calculations/gates.js GATE_RULES',
  };
};
PAGES.pipe.groups.splice(PAGES.pipe.groups.findIndex((g) => g.group === 'DEMAND ENGINE'), 0, {
  group: 'PARAMETERS', stage: 3,
  note: 'Every number the model is tuned by, in one place.',
  fields: [
    ...Object.keys(PARAMS).map(param),
    // One parameter per component weight: a parameter is ONE number.
    ...SCORE_MODEL.map((c) => ({
      label: weightLabel(c), status: 'live', calc: [],
      note: c.label + '’s weight in RAW. Change it to see what RAW would be.',
      param: { id: weightId(c.key), def: c.weight, step: 1, min: 0 },
      value: () => weightNow(c),
      where: 'calculations/asset-detail.js SCORE_MODEL',
    })),
  ],
});

// LIST EXTRACTORS: a reading that is a whole LIST (every trade, every sample,
// every row) is extracted as a list: one row shown as the template, the
// fields picked out of each row highlighted, the list handed on - to a
// FILTER, a SUM, an AGGREGATE.
const asList = (key, rows, fields, of) => { if (RAW[key]) RAW[key].list = { rows, fields, of }; };
asList('TRADE SAMPLE', (rec) => (rec && rec.trades) || [], ['wallet', 'kind', 'usd', 'at'], 'trades');
asList('POOL SAMPLES', (rec) => (Array.isArray(rec) ? rec : []), ['t', 'volume5mUsd', 'buys5m', 'buyers5m'], 'samples');
[['VOLUME 5M HISTORY', 'volume5mUsd'], ['BUYS 5M HISTORY', 'buys5m'], ['BUYERS 5M HISTORY', 'buyers5m']].forEach(([k, m]) =>
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
  const STAGE_NAMES = ['', 'EMERGING', 'CONFIRMED', 'EXCEPTIONAL', 'VETOED'];
  const stageCounts = (v) => {
    const m = {};
    assets(v).forEach((a) => { const k = STAGE_NAMES[a.stage] || String(a.stage); m[k] = (m[k] || 0) + 1; });
    return m;
  };
  const pickRows = (v) => assets(v).filter((a) => (a.wash ?? 0) < 0.15 && a.stage >= 2 && a.score != null);
  const model = (v) => ((S(v) || {}).scoreModel || []).filter((c) => !c.pending);
  const used = (v) => model(v).reduce((s, c) => s + c.weight, 0);
  const points = (v, c) => (used(v) ? rnd(((c.value - 50) * c.weight) / used(v), 1) : null);

  PAGES.pipe.groups.push({
    group: 'BOARD STATS', stage: 5, parent: 'eng:decomp',
    note: 'Board-wide numbers the dashboard shows, built from standard boxes.',
    fields: [
      { label: 'TOKENS TRACKED', status: 'live', value: shownVal('live', 'TOKENS TRACKED'),
        calc: [ref('pipe', 'TOKEN LIST')], where: 'App.jsx renderVals()' },
      { label: 'AVG ORGANIC SCORE', status: 'live', value: shownVal('live', 'AVG ORGANIC SCORE'),
        calc: [ref('pipe', 'Organic flow')], where: 'App.jsx renderVals(), organicReads' },
      { label: 'DAILY PICK', status: 'live',
        value: (v) => (v.chepePickSym && v.chepePickSym !== '—' ? v.chepePickSym + ' · ' + v.chepePickScore : null),
        calc: [ref('pipe', 'TOKEN LIST')], where: 'App.jsx chepePickVals()' },
      { label: 'STAGE COUNTS', status: 'live',
        value: (v) => { const m = stageCounts(v); const ks = Object.keys(m); return ks.length ? ks.map((k) => k + ' ' + m[k]).join(' · ') : null; },
        calc: [ref('pipe', 'STAGE')], where: 'App.jsx renderVals(), stageCounts' },
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
        where: 'ALERT-CARDS.jsx alertsVals()' },
      { label: 'WHAT MOVES THIS SCORE', status: 'live',
        value: (v) => { const m = model(v); return m.length ? m.length + ' components' : null; },
        calc: [ref('pipe', 'RAW')], where: 'asset-detail.js drivers' },
    ],
  });
  opsOf('STAGE COUNTS', [
    node('by', 'COUNT BY', 'STAGE COUNTS', [ref('pipe', 'STAGE')],
      (v) => (assets(v).length ? 'tokens on the board, counted per stage' : null), null),
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
    node('cands', 'FILTER', 'CANDIDATES', [ref('pipe', 'TOKEN LIST'), ref('pipe', 'FINAL'), ref('pipe', 'Organic flow')], null,
      (v) => { const n = pickRows(v).length; return n ? n + ' tokens' : null; },
      { filter: { rows: assets, of: 'tokens', rules: [
        { label: 'wash under 0.15', apply: (rows) => rows.filter((a) => (a.wash ?? 0) < 0.15) },
        { label: 'stage CONFIRMED or higher', apply: (rows) => rows.filter((a) => a.stage >= 2) },
        { label: 'has a score', apply: (rows) => rows.filter((a) => a.score != null) },
      ] } }),
    node('pick', 'PICK', 'DAILY PICK', ['@cands'],
      (v) => { const n = pickRows(v).length; return n ? 'one of ' + n + ', fixed for the day (hash of the date)' : null; }, null),
  ]);
  opsOf('WHAT MOVES THIS SCORE', SCORE_MODEL.map((c, i) => node('c' + i, '×', c.label + ' POINTS',
    [ref('pipe', c.label), ref('pipe', weightLabel(c))],
    (v) => { const m = model(v).find((x) => x.key === c.key); return m ? '(' + m.value + ' − 50) × ' + m.weight + ' ÷ ' + used(v) : 'no value'; },
    (v) => { const m = model(v).find((x) => x.key === c.key); return m ? points(v, m) : null; }))
    .concat([node('sum', 'SUM', 'WHAT MOVES THIS SCORE', SCORE_MODEL.map((c, i) => '@c' + i),
      (v) => { const m = model(v); return m.length ? 'Σ points = RAW − 50 = ' + rnd(m.reduce((s, c) => s + ((c.value - 50) * c.weight) / used(v), 0), 1) : null; }, null)]));

  PAGES.pipe.groups.push({
    group: 'SOCIAL STATS', stage: 5, parent: 'eng:decomp',
    note: 'This token\u2019s social numbers, from the social service.',
    fields: [
      { label: 'MENTIONS', status: 'live', value: (v) => tileOf(v.socialStats, 'MENTIONS'),
        calc: [ref('pipe', 'SOCIAL BASELINE')],
        extract: { path: 'SOCIAL BASELINE', picks: ['mentions'] }, where: 'services/social-intel.js' },
      { label: 'UNIQUE AUTHORS', status: 'live', value: (v) => tileOf(v.socialStats, 'UNIQUE AUTHORS'),
        calc: [ref('pipe', 'SOCIAL BASELINE')],
        extract: { path: 'SOCIAL BASELINE', picks: ['uniqueAuthors'] }, where: 'services/social-intel.js' },
      { label: 'MENTIONS PER AUTHOR', status: 'live', value: (v) => tileOf(v.socialStats, 'PER AUTHOR'),
        calc: [ref('pipe', 'MENTIONS'), ref('pipe', 'UNIQUE AUTHORS')], where: 'SOCIAL-SCANNER.jsx' },
      { label: 'VS SOCIAL BASELINE', status: 'live', value: (v) => tileOf(v.socialStats, 'VS BASELINE'),
        calc: [ref('pipe', 'MENTIONS'), ref('pipe', 'SOCIAL BASELINE')], where: 'services/social-intel.js' },
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
        where: 'services/rotation-intel.js' },
      { label: 'SOCIAL BASELINE', status: 'live', value: (v) => v.socialBaselineNote,
        calc: [api('/raw/social.json')],
        service: { every: '1 min', keeps: 'each token’s mention history, kept with the tab closed (IndexedDB)' },
        where: 'services/social-intel.js' },
      { label: 'TOP 20 HIT RATE', status: 'live', value: shownVal('live', 'TOP 20 HIT RATE'),
        calc: [api('/raw/<chain>/observations-48h.json')],
        service: { every: 'a few minutes', keeps: 'nothing - it re-reads the score journal' },
        where: 'App.jsx refreshPrecision()' },
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
        calc: [api('/raw/system.json')],
        service: { every: '15s (the server rewrites system.json)', keeps: 'nothing - each provider judged on its last 15 minutes' },
        where: 'calculations/core.js providerHealth(), calculations/system-health.js' },
      { label: 'ALERT ENGINE', status: 'live',
        value: (v) => (Array.isArray(v.alertColumns)
          ? v.alertColumns.map((c) => (c.title || c.label || c.name) + ' ' + ((c.cards || c.items || []).length)).join(' · ') : null),
        calc: [ref('pipe', 'FINAL'), ref('pipe', 'STAGE'), ref('pipe', 'RISK FLAGS')],
        service: { every: 'each poll', keeps: 'which alerts already fired' },
        where: 'calculations/alert-schema.js' },
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


