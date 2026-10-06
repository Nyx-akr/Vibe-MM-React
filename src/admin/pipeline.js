/**
 * The score pipeline, one box per step, for ONE token.
 *
 * This is how the FRONTEND turns raw files into a score, in the order it does
 * it (services/api.js fetchLiveMarketData -> calculations/asset-detail.js
 * evaluateAsset):
 *
 *   1 TOKEN LIST    market.json, top 20 rows per chain -> normalizeRow -> screenRows
 *   2 TOKEN INPUTS  the raw readings for the picked token, as the files hold them
 *   3 MEASURES      what is derived from them: baselines, net ratio, impact, growth
 *   4 COMPONENTS    the twelve 0-100 inputs and two modifiers (computeComponents)
 *   5 SCORE         raw, flags, penalty, right now, final, stage (scoreAsset)
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
import { showsForPanel } from './shows';
import { multipleScore, logScore, to100, Z_MIN_SAMPLES } from '../calculations/core.js';
import { TOTAL_WEIGHT, SCORE_MODEL, STAGES } from '../calculations/asset-detail.js';
import { GATES, GATE_RULES } from '../calculations/gates.js';

/* ------------------------------------------------------------ readers -- */

const P = (v) => (v && v.pipe) || {};
const S = (v) => P(v).s || null;
const IN = (v) => P(v).intel || null;
const Z = (v) => ((S(v) || {}).zScores || {}).metrics || {};
const TS = (v) => (S(v) || {}).tradeStats || null;
const fin = Number.isFinite;

const rnd = (n, dp = 2) => (fin(n) ? String(Math.round(n * 10 ** dp) / 10 ** dp) : null);
const pct = (n, dp = 2) => (fin(n) ? rnd(n, dp) + '%' : null);
const signed = (n, dp = 1) => (fin(n) ? (n > 0 ? '+' : '') + rnd(n, dp) : null);
const usd = (n) => {
  if (!fin(n)) return null;
  const a = Math.abs(n);
  const s = n < 0 ? '-$' : '$';
  if (a >= 1e9) return s + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'K';
  if (a >= 1) return s + a.toFixed(2);
  return s + a.toPrecision(4);
};
const count = (n) => (fin(n) ? Math.round(n).toLocaleString() : null);

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

/* -------------------------------------------------------------- gates -- */

/**
 * The gates are READ from the score, never recomputed: scoreAsset() runs
 * calculations/gates.js and keeps its verdict on the row (`row.gates`), so a
 * gate box can only ever say what the score acted on. A test is {ok, detail}:
 * ok true = pass, false = VETO, null (no answer) = not checked yet.
 */
const G = GATE_RULES;
const WASH_FLOOR = GATE_RULES.minOrganicFlow;
const GATE_TESTS = Object.fromEntries(GATES.map((g) => [g.label, (v) => {
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
  title: 'SCORE PIPELINE',
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
            op('- every box to the right is this token')],
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
        ...[
          ['VOLUME 5M vs BASELINE', 'volume5mUsd', usd],
          ['BUYS 5M vs BASELINE', 'buys5m', count],
          ['BUYERS 5M vs BASELINE', 'buyers5m', count],
        ].map(([label, metric, fmt]) => ({
          label, status: 'live',
          value: (v) => { const m = Z(v)[metric]; return m && fin(m.multiple) ? m.multiple + 'x' : null; },
          calc: [op('latest ' + metric + ' ÷ mean of the earlier'), api('/raw/<chain>/history.json', 'POOL SAMPLES')],
          equation: (v) => {
            const m = Z(v)[metric];
            const z = (S(v) || {}).zScores;
            if (!m) return z ? 'no baseline yet: ' + (z.samples || 0) + ' of ' + Z_MIN_SAMPLES + ' samples' : null;
            return fmt(m.value) + ' now ÷ ' + fmt(m.mean) + ' mean of ' + m.samples + ' = ' +
              (fin(m.multiple) ? m.multiple + 'x' : '—') + (fin(m.z) ? ' · z ' + m.z : '');
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

    /* --------------------------------------------------------- 3 GATES -- */
    //
    // Hard pass/fail, run BEFORE any engine. A failed gate ends the token's
    // run: nothing downstream is scored, and the reason is what the veto log
    // lists. Gates answer 'should this be scored at all'; engines answer 'how
    // well does it score'. Keeping them apart is what stops a honeypot from
    // being rescued by good volume.
    //
    // A gate may only fail on EVIDENCE. Missing data is 'not checked', never a
    // failure - otherwise every token the intel collector has not reached yet
    // would be vetoed for being new rather than for being bad.
    {
      group: 'GATES', stage: 3, flat: true,
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
          calc: [api('/raw/<chain>/intel.json', 'CONTRACT CHECKS'), op('- buy, sell and transfer tax each at or under'), num('5%')],
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
          calc: [ext('dexscreener', 'marketCapUsd'), op('else'), ext('geckoterminal', 'marketCapUsd'),
            op('under'), num('$1B'), op('- the cap band, applied as a gate rather than a weight')],
          via: api('/raw/<chain>/market.json'),
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
          calc: [api('/raw/<chain>/market.json', 'POOL AGE'), op('at or over'), num(G.minAgeHours / 24 + ' days')],
          equation: (v) => { const r = gateOf(v, 'AGE FLOOR'); return r ? r.detail : (S(v) ? 'no pool creation time - not checked' : null); },
          note: 'Most rugs happen in the first week. Under 14 days a token belongs to the new-launch ' +
            'lane, which has its own gates - until that lane exists, it is vetoed: score 0.',
          where: 'calculations/gates.js evaluateGates()',
        },
        {
          label: 'LIQUIDITY FLOOR', status: 'live',
          value: (v) => verdict(gateOf(v, 'LIQUIDITY FLOOR')),
          calc: [api('/raw/<chain>/market.json', 'LIQUIDITY'), op('at or over'), num(usd(G.minLiquidityUsd))],
          equation: (v) => { const r = gateOf(v, 'LIQUIDITY FLOOR'); return r ? r.detail : (S(v) ? 'no liquidity reported - not checked' : null); },
          note: 'The pool a perp is priced against. Too shallow and one trader moves the index.',
          where: 'calculations/gates.js evaluateGates()',
        },
        {
          label: 'VOLUME FLOOR', status: 'live',
          value: (v) => verdict(gateOf(v, 'VOLUME FLOOR')),
          calc: [api('/raw/<chain>/market.json', 'VOLUME 24H'), op('at or over'), num(usd(G.minVolume24hUsd))],
          equation: (v) => { const r = gateOf(v, 'VOLUME FLOOR'); return r ? r.detail : (S(v) ? 'no 24h volume reported - not checked' : null); },
          note: 'The spec asks for the 7-day MEDIAN of daily volume. The files hold only the last 24h, ' +
            'so one hot day can pass a token that is quiet the other six.',
          where: 'calculations/gates.js evaluateGates()',
        },
        {
          label: 'NOT WASH-FLAGGED', status: 'live',
          value: (v) => verdict(gateOf(v, 'NOT WASH-FLAGGED')),
          calc: [ref('pipe', 'Organic flow'), op('at or over'), num(WASH_FLOOR)],
          equation: (v) => { const r = gateOf(v, 'NOT WASH-FLAGGED'); return r ? r.detail : (S(v) ? 'no trade sample for this pool yet - not checked' : null); },
          note: 'Under 40 the volume is mostly the same wallets trading with themselves, and a perp ' +
            'on fake volume has no real traders. A veto: the score goes to 0.',
          where: 'calculations/gates.js evaluateGates()',
        },
        {
          label: 'VETO LOG', status: 'live',
          value: (v) => {
            const g = (S(v) || {}).gates;
            if (!g) return null;
            return g.vetoed ? 'VETO · ' + g.vetoes.length + ' failed' : 'clean';
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
    /* ------------------------------------------------------- 4 ENGINES -- */
    /*
     * The components, one box each, under the column header "4 · SCORE
     * DECOMPOSITION". This group IS the DETAIL tab's decomposition panel (its
     * bars draw these values), so there is no second copy of it in step 6.
     * Folding them into one panel box was tried and reverted on request: one
     * box per component keeps each one's inputs and output on the map itself.
     */
        {
      group: 'DEMAND ENGINE', stage: 4,
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
      group: 'EXECUTION ENGINE', stage: 4,
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
      group: 'CONFIRMATION ENGINE', stage: 4,
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
      group: 'HOLDERS ENGINE', stage: 4,
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
      group: 'ROTATION ENGINE', stage: 4,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      note: 'Where this pool’s capital came from — wallets shared with other pools, from the trade sample the wallet service already holds.',
      fields: [
        component('capitalRotation',
          [op('100 × clamp('), ref('pipe', 'SHARED WALLETS'), op('÷ 25 )')],
          (v) => { const p = ((S(v) || {}).rotation || {}).sharedWalletPct; return fin(p) ? rnd(p, 1) + ' ÷ 25 → ' + to100(p / 25) : null; }),
      ],
    },
    {
      group: 'COVERAGE ENGINE', stage: 4,
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
      group: 'WASH & ORGANIC', stage: 4,
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
      group: 'CONTRACT SAFETY', stage: 4,
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
      group: 'WHITESPACE', stage: 4,
      note: 'Is the perp still up for grabs. A token another venue already lists has a perp, so ' +
        'there is nothing for Vibe to offer it. Measured and shown, carrying no weight yet.',
      fields: [
        {
          label: 'NO PERP ELSEWHERE', status: 'partial',
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
      ],
    },
    {
      group: 'REACHABILITY & INTENT', stage: 4,
      note: 'Is there a project behind the token, and is it spending on being found. Measured ' +
        'today and shown here, but carrying no weight in the score yet - which is why its boxes ' +
        'say so rather than quietly contributing nothing.',
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
          label: 'CONTACTABLE', status: 'partial',
          value: (v) => {
            const l = (S(v) || {}).links || {};
            const n = ((l.socials || []).length) + ((l.websites || []).length);
            return n ? n + ' links' : null;
          },
          fetch: [ext('dexscreener', 'links.socials, links.websites')],
          via: api('/raw/<chain>/market.json'),
          equation: (v) => {
            const l = (S(v) || {}).links || {};
            const kinds = (l.socials || []).map((x) => x.type).join(', ');
            return (kinds || 'no socials') + ' - ' + ((l.websites || []).length) + ' website(s)';
          },
          note: 'A project with no way to reach it cannot be pitched, however well it trades.',
          where: WHERE_NORM,
        },
        {
          label: 'BOOSTED', status: 'partial',
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
      ],
    },
    {
      group: 'DURABILITY', stage: 4,
      note: 'Has it held together over time rather than in the last five minutes. Built from the ' +
        'only history we own - our own samples - so it is thin for a pool we met recently, and ' +
        'carries no weight in the score yet.',
      fields: [
        {
          label: 'SURVIVAL', status: 'partial',
          value: (v) => {
            const h = (S(v) || {}).poolAgeHours;
            return fin(h) ? (h / 24).toFixed(1) + ' days' : null;
          },
          calc: [api('/raw/<chain>/market.json', 'POOL AGE'), op('past the first-week rug window, with'),
            api('/raw/<chain>/history.json', 'POOL SAMPLES'), op('still holding and'), ref('pipe', 'HOLDER GROWTH RATE'), op('positive')],
          equation: (v) => {
            const h = (S(v) || {}).poolAgeHours;
            if (!fin(h)) return null;
            const lane = h < 24 * 14 ? 'inside the 14-day new-launch window' : 'past the 14-day window';
            return Math.round(h) + ' hours old - ' + lane;
          },
          note: 'The 14-day line is what the listing spec uses to split a new launch from an ' +
            'established token. Nothing branches on it yet; the box is where that decision will live.',
          where: WHERE_NORM,
        },
      ],
    },,

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
            .concat([op('] ÷ [ the weights of the components that have a value ]')]),
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
            ref('pipe', 'Organic flow'), api('/raw/ethos.json', 'ETHOS (PROJECT X)')],
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
          label: 'FINAL', status: 'live',
          value: (v) => { const s = S(v); return s && fin(s.score) ? s.score : null; },
          calc: [op('if'), ref('pipe', 'VETO LOG'), op('has a veto → 0, else mean of every'), ref('pipe', 'RIGHT NOW'),
            op('reading over the last'), num(15), op('minutes')],
          equation: (v) => {
            const s = S(v); if (!s) return null;
            if (s.vetoed) return 'vetoed → 0, at once rather than averaged down over 15 minutes';
            return 'mean of ' + s.scoreSamples + ' readings over ' + (minutes(s.scoreObservedMs) || '0 min') +
              ' (range ' + s.scoreMin + '–' + s.scoreMax + ') = ' + s.score;
          },
          note: 'The headline everywhere. The momentary score moves every poll because its biggest ' +
            'inputs are 5-minute windows; averaging over 15 minutes is what stops the board reshuffling.',
          where: 'asset-detail.js settledScore()',
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
  'POOL SAMPLES': ['SURVIVAL'],
  'TRADE SAMPLE': ['NET FLOW RATIO', 'TOP-5 WALLET SHARE', 'SHARED WALLETS', 'WALLET SAMPLE'],
  '$10K ROUTE QUOTE': ['PRICE IMPACT $10K'],
  'HOLDERS': ['HOLDER GROWTH RATE', 'Holder growth'],
  'TOP HOLDERS SHARE': ['Wallet quality'],
  'CONTRACT CHECKS': ['SELLABLE', 'TAX IN RANGE', 'Contract safety'],
  'LP / CREATOR / INSIDERS': ['Wallet quality'],
  'USD REFERENCE': ['QUOTE DEVIATION'],
  'ETHOS (PROJECT X)': ['PROJECT REPUTATION', 'RISK FLAGS'],
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

/*
 * Step 6 - SHOWN ON THE DASHBOARD - is the token tabs' own panels, kept under
 * their tab keys (see pipeline-shown.js). Registered here so that loading the
 * pipeline loads the whole of it.
 */
Object.assign(PAGES, SHOWN_PAGES);

/** Step 6's tabs, in rail order, for the SCORE PIPELINE tab to list. */
export const SHOWN_ORDER = Object.keys(SHOWN_PAGES);

export const PIPE_PAGE = PAGES.pipe;
