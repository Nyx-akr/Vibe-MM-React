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
    {
      group: 'TOKEN INPUTS', stage: 2, flat: true,
      fields: [
        // --- market.json: GeckoTerminal + DexScreener, normalised -------------
        {
          label: 'LIQUIDITY', status: 'live',
          value: (v) => usd((S(v) || {}).liquidityUsd),
          fetch: [ext('dexscreener', 'liquidity.usd'), op('else'), ext('geckoterminal', 'reserve_in_usd')],
          via: api('/raw/<chain>/market.json'),
          equation: (v) => {
            const s = S(v); if (!s) return null;
            const src = s.sources || {};
            return 'DexScreener ' + (usd((src.dexscreener || {}).liquidityUsd) || '—') +
              ' · GeckoTerminal ' + (usd((src.geckoterminal || {}).liquidityUsd) || '—');
          },
          where: WHERE_NORM,
        },
        {
          label: 'BUYERS 24H', status: 'live',
          value: (v) => count(((S(v) || {}).traders24h || {}).buyers),
          fetch: [ext('geckoterminal', 'transactions.h24.buyers (distinct wallets)')],
          via: api('/raw/<chain>/market.json'),
          where: WHERE_NORM,
        },
        {
          label: 'BUY/SELL 24H', status: 'live',
          value: (v) => rnd((S(v) || {}).buySellRatio24h, 2),
          fetch: [ext('geckoterminal', 'transactions.h24 buys / sells'), op('else'), ext('dexscreener', 'txns.h24')],
          via: api('/raw/<chain>/market.json'),
          equation: (v) => {
            const t = (S(v) || {}).txns24h; if (!t || !fin(t.buys) || !t.sells) return null;
            return count(t.buys) + ' buys ÷ ' + count(t.sells) + ' sells = ' + rnd(t.buys / t.sells, 2);
          },
          where: WHERE_NORM,
        },
        {
          label: 'PRICE, 2 SOURCES', status: 'live',
          value: (v) => { const x = (S(v) || {}).crossSource; return x && fin(x.priceDeltaPct) ? pct(x.priceDeltaPct) + ' apart' : (x ? x.sourcesAgreeing + ' source' : null); },
          fetch: [ext('dexscreener', 'priceUsd'), op('vs'), ext('geckoterminal', 'base_token_price_usd')],
          via: api('/raw/<chain>/market.json'),
          equation: (v) => {
            const s = S(v); if (!s) return null;
            const ds = (s.sources && s.sources.dexscreener || {}).priceUsd;
            const gt = (s.sources && s.sources.geckoterminal || {}).priceUsd;
            if (!fin(ds) || !fin(gt)) return 'only ' + ((s.crossSource || {}).sourcesAgreeing || 0) + ' of 2 sources priced it';
            return '( DexScreener ' + usd(ds) + ' − GeckoTerminal ' + usd(gt) + ' ) ÷ ' + usd(gt) +
              ' = ' + pct((s.crossSource || {}).priceDeltaPct);
          },
          where: WHERE_NORM + ', crossSource',
        },
        {
          label: 'VENUES', status: 'live',
          value: (v) => count((((S(v) || {}).sources || {}).dexscreener || {}).pairs),
          fetch: [ext('dexscreener', 'pairs listed for this token')],
          via: api('/raw/<chain>/market.json'),
          where: WHERE_NORM,
        },
        {
          label: 'QUOTE TOKEN PRICE', status: 'live',
          value: (v) => { const s = S(v); return s && fin(s.quoteTokenPriceUsd) ? (s.quoteSymbol || '') + ' $' + s.quoteTokenPriceUsd.toFixed(4) : null; },
          fetch: [ext('geckoterminal', 'quote_token_price_usd')],
          via: api('/raw/<chain>/market.json'),
          where: WHERE_NORM,
        },
        {
          label: 'POOL AGE', status: 'live',
          value: (v) => { const h = (S(v) || {}).poolAgeHours; return fin(h) ? (h < 48 ? rnd(h, 1) + 'h' : rnd(h / 24, 1) + 'd') : null; },
          fetch: [ext('geckoterminal', 'pool_created_at'), op('else'), ext('dexscreener', 'pairCreatedAt')],
          via: api('/raw/<chain>/market.json'),
          where: WHERE_NORM,
        },
        {
          label: 'VOLUME / LIQUIDITY', status: 'live',
          value: (v) => { const x = (S(v) || {}).volumeToLiquidity24h; return fin(x) ? rnd(x, 1) + 'x' : null; },
          fetch: [ext('dexscreener', 'volume.h24'), op('else'), ext('geckoterminal', 'volume_usd.h24'), op('÷ liquidity')],
          via: api('/raw/<chain>/market.json'),
          equation: (v) => {
            const s = S(v); if (!s || !fin(s.volume24hUsd) || !s.liquidityUsd) return null;
            return usd(s.volume24hUsd) + ' 24h volume ÷ ' + usd(s.liquidityUsd) + ' = ' + rnd(s.volumeToLiquidity24h, 1) + 'x';
          },
          where: WHERE_NORM,
        },
        {
          label: 'JUPITER STATS', status: 'live',
          value: (v) => { const j = (S(v) || {}).jupiter; return j && fin(j.organicScore) ? 'organic ' + rnd(j.organicScore, 0) : (j ? 'present' : null); },
          fetch: [ext('jupiter', 'tokens v2: stats 5m/1h/24h, organicScore, holderCount')],
          via: api('/raw/<chain>/market.json'),
          equation: (v) => {
            const s = S(v); if (!s) return null;
            const j = s.jupiter;
            if (!j) return 'Solana only - none for ' + s.chain;
            const h1 = j.stats1h || {};
            return 'holders 1h ' + (signed(h1.holderChangePct, 2) || '—') + '% · net 1h ' +
              (usd(h1.netUsd) || '—') + ' · organic ' + (rnd(j.organicScore, 1) || '—');
          },
          where: 'core.js normalizeJupiterToken()',
        },
        // --- history.json: our own 15s samples of the same pool --------------
        {
          label: 'POOL SAMPLES', status: 'live',
          value: (v) => { const z = (S(v) || {}).zScores; return z && fin(z.samples) ? z.samples + ' samples' : null; },
          fetch: [ext('geckoterminal', 'm5 volume, buys, buyers - re-read every 15s'), op('+'), ext('dexscreener', 'm5 volume')],
          via: api('/raw/<chain>/history.json', 'samples per pool'),
          equation: (v) => {
            const z = (S(v) || {}).zScores; if (!z) return null;
            return z.samples + ' samples over ' + (minutes(z.windowMs) || '0 min') +
              (z.source ? ' (fallback: ' + z.source + ')' : '') +
              (z.samples < Z_MIN_SAMPLES ? ' - a baseline needs ' + Z_MIN_SAMPLES : '');
          },
          where: 'server memory.samplesFor() → ' + WHERE_API + ' rawInputsFor()',
        },
        // --- trades.json: one trade sample per pool ---------------------------
        {
          label: 'TRADE SAMPLE', status: 'live',
          value: (v) => { const t = TS(v); return t ? count(t.trades) + ' trades' : null; },
          fetch: [ext('geckoterminal', 'pools/{pool}/trades')],
          via: api('/raw/<chain>/trades.json'),
          equation: (v) => {
            const t = TS(v); if (!t) return 'no trade sample for this pool yet';
            return count(t.trades) + ' trades by ' + count(t.distinctWallets) + ' wallets over ' +
              (rnd(t.windowMinutes, 1) || '?') + ' min · buys ' + usd(t.buyUsd) + ' · sells ' + usd(t.sellUsd);
          },
          where: 'core.js buildWalletSets() + tradeStatsFrom()',
        },
        // --- intel.json: contract, holders, routed impact ---------------------
        {
          label: '$10K ROUTE QUOTE', status: 'live',
          value: (v) => { const i = (IN(v) || {}).impact; return i ? (i.source || 'no router') : null; },
          fetch: [ext('jupiter', 'quote for $10k (Solana)'), op('else'), ext('kyberswap', 'route for $10k (EVM)')],
          via: api('/raw/<chain>/intel.json'),
          equation: (v) => {
            const i = (IN(v) || {}).impact; if (!i) return null;
            if (!i.source) return i.note || 'no keyless router for this chain';
            return usd(i.tradeUsd) + ' via ' + i.source + (fin(i.routes) ? ', ' + i.routes + ' routes' : '') +
              (fin(i.gasUsd) ? ', gas ' + usd(i.gasUsd) : '');
          },
          where: 'calculations/asset-detail.js deriveIntel(), impact',
        },
        {
          label: 'HOLDERS', status: 'live',
          value: (v) => count(((IN(v) || {}).holders || {}).count),
          fetch: [ext('goplus', 'holder_count'), op('else'), ext('rugcheck', 'totalHolders'), op('else'), ext('jupiter', 'holderCount')],
          via: api('/raw/<chain>/intel.json', 'count + holder series'),
          equation: (v) => {
            const h = (IN(v) || {}).holders; if (!h) return null;
            return 'GoPlus ' + (count(h.goplusCount) || '—') + ' · RugCheck ' + (count(h.rugcheckCount) || '—') +
              ' · Jupiter ' + (count(h.jupiterCount) || '—') + ' · series ' + ((h.growth || {}).samples || 0) + ' points';
          },
          where: 'deriveIntel(), holders',
        },
        {
          label: 'TOP HOLDERS SHARE', status: 'live',
          value: (v) => pct(((S(v) || {}).facts || {}).topHolderSharePct),
          fetch: [ext('goplus', 'holders[].percent, pool excluded'), op('else'), ext('jupiter', 'audit.topHoldersPercentage')],
          via: api('/raw/<chain>/intel.json'),
          equation: (v) => { const f = (S(v) || {}).facts; return f && f.topHolderShareSource ? 'source: ' + f.topHolderShareSource : null; },
          where: 'computeComponents(), facts.topHolderSharePct',
        },
        {
          label: 'CONTRACT CHECKS', status: 'live',
          value: (v) => { const cs = (IN(v) || {}).contractSafety; if (!cs || !cs.available) return null; const n = (cs.checks || []).length; return (n - cs.failedCount) + '/' + n + ' pass'; },
          fetch: [ext('goplus', 'token_security'), op('+'), ext('rugcheck', 'report'), op('+'), ext('honeypot', 'buy/sell simulation')],
          via: api('/raw/<chain>/intel.json'),
          equation: (v) => {
            const cs = (IN(v) || {}).contractSafety; if (!cs || !cs.available) return null;
            const failed = (cs.checks || []).filter((c) => !c.ok);
            return failed.length ? 'failed: ' + failed.map((c) => c.label).join(', ') : 'every check passes';
          },
          where: 'deriveIntel() goPlusChecks() + honeypot checks',
        },
        {
          label: 'LP / CREATOR / INSIDERS', status: 'live',
          value: (v) => { const cs = (IN(v) || {}).contractSafety; return cs && fin(cs.lpLockedPct) ? 'LP ' + rnd(cs.lpLockedPct, 0) + '% locked' : (cs ? 'no LP data' : null); },
          fetch: [ext('rugcheck', 'markets[].lpLockedPct, creator tokens, insider graph')],
          via: api('/raw/<chain>/intel.json'),
          equation: (v) => {
            const cs = (IN(v) || {}).contractSafety; if (!cs) return null;
            return 'creator other tokens ' + (cs.creatorOtherTokens ?? '—') + ' · insiders ' +
              (cs.insidersDetected == null ? '—' : cs.insidersDetected ? 'detected' : 'none');
          },
          where: 'deriveIntel(), contractSafety',
        },
        // --- reference.json / ethos.json -------------------------------------
        {
          label: 'USD REFERENCE', status: 'live',
          value: (v) => { const r = (S(v) || {}).usdReference; return r && fin(r.median) ? r.symbol + ' $' + r.median.toFixed(4) : null; },
          fetch: [ext('cex', 'spot price of the quote token')],
          via: api('/raw/reference.json'),
          equation: (v) => {
            const r = (S(v) || {}).usdReference; if (!r) return 'no reference quotes for this quote token';
            return 'median of ' + (r.quotes || []).length + ' venues: ' +
              (r.quotes || []).map((q) => (q.venue || q.source || '?') + ' ' + (fin(q.price) ? q.price.toFixed(4) : '—')).join(', ');
          },
          where: 'asset-detail.js usdReferenceMedian()',
        },
        {
          label: 'ETHOS (PROJECT X)', status: 'live',
          value: (v) => (v && v.ethosLabel) || null,
          fetch: [ext('ethos', 'score of the X account the token lists')],
          via: api('/raw/ethos.json'),
          where: 'services/ethos-intel.js ethosFor()',
        },
      ],
    },

    /* ------------------------------------------------------ 3 MEASURES -- */
    {
      group: 'MEASURES', stage: 3, flat: true,
      fields: [
        ...[
          ['VOLUME 5M vs BASELINE', 'volume5mUsd', usd],
          ['BUYS 5M vs BASELINE', 'buys5m', count],
          ['BUYERS 5M vs BASELINE', 'buyers5m', count],
        ].map(([label, metric, fmt]) => ({
          label, status: 'live',
          value: (v) => { const m = Z(v)[metric]; return m && fin(m.multiple) ? m.multiple + 'x' : null; },
          calc: [op('latest ' + metric + ' ÷ mean of the earlier'), ref('pipe', 'POOL SAMPLES')],
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
          calc: [op('( buy USD − sell USD ) ÷ ( buy USD + sell USD ) over'), ref('pipe', 'TRADE SAMPLE')],
          equation: (v) => {
            const t = TS(v); if (!t || t.netRatio === null) return null;
            return '( ' + usd(t.buyUsd) + ' − ' + usd(t.sellUsd) + ' ) ÷ ' + usd(t.buyUsd + t.sellUsd) + ' = ' + t.netRatio;
          },
          where: 'core.js tradeStatsFrom()',
        },
        {
          label: 'TOP-5 WALLET SHARE', status: 'live',
          value: (v) => pct((TS(v) || {}).top5SharePct, 1),
          calc: [op('USD of the 5 biggest wallets ÷ all USD in'), ref('pipe', 'TRADE SAMPLE')],
          where: 'core.js tradeStatsFrom()',
        },
        {
          label: 'PRICE IMPACT $10K', status: 'live',
          value: (v) => pct(((IN(v) || {}).impact || {}).priceImpactPct, 3),
          calc: [ref('pipe', '$10K ROUTE QUOTE'), op('→ Jupiter priceImpactPct × 100, or KyberSwap ( USD in − USD out ) ÷ USD in × 100')],
          where: 'deriveIntel(), impact',
        },
        {
          label: 'HOLDER GROWTH RATE', status: 'live',
          value: (v) => { const g = (((IN(v) || {}).holders) || {}).growth; return g && fin(g.perHour) ? signed(g.perHour) + '/h' : null; },
          calc: [op('( last − first ) count ÷ hours, over the series in'), ref('pipe', 'HOLDERS')],
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
          calc: [op('wallets of'), ref('pipe', 'TRADE SAMPLE'), op('also in another sampled pool ÷ all its wallets')],
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
          calc: [op('|'), ref('pipe', 'QUOTE TOKEN PRICE'), op('−'), ref('pipe', 'USD REFERENCE'), op('| ÷ median × 100')],
          where: 'computeComponents(), usdReference',
        },
        {
          label: 'WALLET SAMPLE', status: 'live',
          value: (v) => { const o = (S(v) || {}).organicFlow; return o && fin(o.walletsSeen) ? o.walletsSeen + ' wallets' : null; },
          calc: [ref('pipe', 'TRADE SAMPLE'), op('→ background wallet service: who traded once, who churned, who entered together')],
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

    /* ------------------------------------------- 4 SCORE DECOMPOSITION -- */
    /*
     * The components, one box each, under the column header "4 · SCORE
     * DECOMPOSITION". This group IS the DETAIL tab's decomposition panel (its
     * bars draw these values), so there is no second copy of it in step 6.
     * Folding them into one panel box was tried and reverted on request: one
     * box per component keeps each one's inputs and output on the map itself.
     */
    {
      group: 'SCORE DECOMPOSITION', stage: 4, flat: true,
      shows: showsForPanel('detail', 'SCORE DECOMPOSITION'),
      fields: [
        component('volumeAnomaly',
          [op('multipleScore('), ref('pipe', 'VOLUME 5M vs BASELINE'), op(') = 100 × clamp( 0.5 + 0.3 × log10 multiple )')],
          (v) => multipleMath((Z(v).volume5mUsd || {}).multiple)),
        component('tradeActivity',
          [op('multipleScore('), ref('pipe', 'BUYS 5M vs BASELINE'), op(')')],
          (v) => multipleMath((Z(v).buys5m || {}).multiple)),
        component('buyerBreadth',
          [op('½ × multipleScore('), ref('pipe', 'BUYERS 5M vs BASELINE'), op(') + ½ × logScore('),
            ref('pipe', 'BUYERS 24H'), op(', 10, 3000 )')],
          (v) => {
            const m = (Z(v).buyers5m || {}).multiple;
            const a = fin(m) ? multipleScore(m) : null;
            const b = logScore(((S(v) || {}).traders24h || {}).buyers, 10, 3000);
            if (a !== null && b !== null) return '½ × ' + a + ' + ½ × ' + b + ' → ' + Math.round(a * 0.5 + b * 0.5);
            return a !== null ? 'anomaly only: ' + a : (b !== null ? 'absolute only: ' + b : null);
          }),
        component('netDemand',
          [op('100 × clamp( 0.5 +'), ref('pipe', 'NET FLOW RATIO'), op('÷ 2 ) ; with no trade sample: 100 × clamp( 0.5 + net ratio of'),
            ref('pipe', 'JUPITER STATS'), op('÷ 2 ) ; with neither: 100 × clamp( ('), ref('pipe', 'BUY/SELL 24H'), op('− 0.5 ) ÷ 1.5 )')],
          (v) => {
            const t = TS(v);
            if (t && t.netRatio !== null) return 'our sample: 0.5 + ' + t.netRatio + ' ÷ 2 → ' + to100(0.5 + t.netRatio / 2);
            const j = (S(v) || {}).jupiter;
            const w = j && (j.stats1h || j.stats5m || j.stats24h);
            if (w && w.netRatio !== null && w.netRatio !== undefined) return 'Jupiter: 0.5 + ' + rnd(w.netRatio, 3) + ' ÷ 2 → ' + to100(0.5 + w.netRatio / 2);
            const r = (S(v) || {}).buySellRatio24h;
            return fin(r) ? 'counts only: ( ' + rnd(r, 2) + ' − 0.5 ) ÷ 1.5 → ' + to100((r - 0.5) / 1.5) : null;
          }),
        component('liquidity',
          [op('½ × logScore('), ref('pipe', 'LIQUIDITY'), op(', $10K, $1M ) + ½ × 100 × clamp( 1 −'),
            ref('pipe', 'PRICE IMPACT $10K'), op('÷ 2.5 )')],
          (v) => {
            const d = logScore((S(v) || {}).liquidityUsd, 10000, 1000000);
            const ip = ((IN(v) || {}).impact || {}).priceImpactPct;
            const i = fin(ip) ? to100(1 - ip / 2.5) : null;
            if (d !== null && i !== null) return '½ × ' + d + ' (depth) + ½ × ' + i + ' (impact) → ' + Math.round(d * 0.5 + i * 0.5);
            return d !== null ? 'depth only: ' + d : (i !== null ? 'impact only: ' + i : null);
          }),
        component('priceConfirmation',
          [op('100 × clamp( 1 − |'), ref('pipe', 'PRICE, 2 SOURCES'), op('| ÷ 5 ) ; if only one source priced it: 40')],
          (v) => {
            const x = (S(v) || {}).crossSource; if (!x) return null;
            if (fin(x.priceDeltaPct)) return '1 − ' + rnd(Math.abs(x.priceDeltaPct), 3) + ' ÷ 5 → ' + to100(1 - Math.abs(x.priceDeltaPct) / 5);
            return x.sourcesAgreeing < 2 ? 'one source → 40' : null;
          }),
        component('holderGrowth',
          [op('100 × clamp( 0.5 + 5 ×'), ref('pipe', 'HOLDER GROWTH RATE'), op('÷'), ref('pipe', 'HOLDERS'),
            op('× 100 ) ; with no holder series: 100 × clamp( 0.5 + 1h holder % of'), ref('pipe', 'JUPITER STATS'), op('÷ 4 )')],
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
            ref('pipe', 'TOP HOLDERS SHARE'), op('÷ 60 and the other three come from'), ref('pipe', 'WALLET SAMPLE'),
            op('; then × 0.75 if insiders, × 0.8 if the creator launched 20+ tokens, × 1.15 if LP over 90% locked, from'),
            ref('pipe', 'LP / CREATOR / INSIDERS')],
          (v) => {
            const q = (S(v) || {}).walletQuality; if (!q) return null;
            return weightedMath(q.parts, q.modifiers);
          },
          { where: 'calculations/core.js walletQualityScore() - the wallets module owns this number' }),
        component('capitalRotation',
          [op('100 × clamp('), ref('pipe', 'SHARED WALLETS'), op('÷ 25 )')],
          (v) => { const p = ((S(v) || {}).rotation || {}).sharedWalletPct; return fin(p) ? rnd(p, 1) + ' ÷ 25 → ' + to100(p / 25) : null; }),
        component('crossVenue',
          [op('logScore('), ref('pipe', 'VENUES'), op(', 1, 20 ) × ( 1 if both price sources answered, else 0.6 ) - from'),
            ref('pipe', 'PRICE, 2 SOURCES')],
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
        component('dataQuality',
          [op('components above that resolved ÷'), num(SCORE_MODEL.length - 1), op('× 100')],
          (v) => {
            const list = ((S(v) || {}).scoreModel || []).filter((c) => c.key !== 'dataQuality');
            const got = list.filter((c) => !c.pending).length;
            return got + ' of ' + list.length + ' resolved' +
              (got < list.length ? ' - missing: ' + list.filter((c) => c.pending).map((c) => c.label).join(', ') : '');
          }),
        {
          label: 'Organic flow', status: 'live', weight: 'modifier',
          value: (v) => valueOf(modOf(v, 'organicFlow')),
          calc: [op('[ ( crowd spread'), op('×'), num(30), op(') + ( volume spread'), op('×'), num(25),
            op(') + ( churn-free'), op('×'), num(25), op(') + ( entry independence'), op('×'), num(20),
            op(') ] ÷ [ the weights of the parts that have a value ], each part from'), ref('pipe', 'WALLET SAMPLE'),
            op('; with no sample of our own, Jupiter’s organicScore from'), ref('pipe', 'JUPITER STATS')],
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
        {
          label: 'Contract safety', status: 'live', weight: 'modifier',
          value: (v) => valueOf(modOf(v, 'contractSafety')),
          calc: [ref('pipe', 'CONTRACT CHECKS'), op('passed ÷ total × 100')],
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
          calc: [op('rules on'), ref('pipe', 'POOL AGE'), ref('pipe', 'PRICE, 2 SOURCES'), ref('pipe', 'LIQUIDITY'),
            ref('pipe', 'VOLUME / LIQUIDITY'), ref('pipe', 'TOP-5 WALLET SHARE'), ref('pipe', 'Contract safety'),
            ref('pipe', 'Organic flow'), ref('pipe', 'ETHOS (PROJECT X)')],
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
          calc: [op('clamp('), ref('pipe', 'RAW'), op('−'), ref('pipe', 'RISK PENALTY'), op(', 0, 100 )')],
          equation: (v) => { const s = S(v); return s ? s.rawScore + ' − ' + s.riskPenalty + ' = ' + s.scoreNow : null; },
          where: 'scoreAsset()',
        },
        {
          label: 'FINAL', status: 'live',
          value: (v) => { const s = S(v); return s && fin(s.score) ? s.score : null; },
          calc: [op('mean of every'), ref('pipe', 'RIGHT NOW'), op('reading over the last'), num(15), op('minutes')],
          equation: (v) => {
            const s = S(v); if (!s) return null;
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
          calc: [op('Σ weights that resolved ÷'), num(TOTAL_WEIGHT)],
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
const RAW = {
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
