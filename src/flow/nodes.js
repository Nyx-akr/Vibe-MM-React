/**
 * The pipeline: raw files in, one Listing Fit score out.
 *
 * This file is the whole calculation. Nothing here reads a score from
 * anywhere else, and nothing outside computes a number this file then
 * displays. If a value appears on the DATA FLOW page, a function below
 * produced it from the values of the boxes feeding it.
 *
 * SIX STAGES, LEFT TO RIGHT
 *
 *   SOURCES     the raw files, exactly as the collector wrote them
 *   NORMALISE   one token's readings, pulled out of those files
 *   GATES       hard pass/fail - a veto here ends the token's run
 *   MEASURES    the derived quantities, each 0-100
 *   PILLARS     the six weighted pillars
 *   VERDICT     fit, penalty, final score, tier, expected fees, triggers
 *
 * WHY PILLARS AND NOT THE OLD TWELVE COMPONENTS
 *
 * The twelve-component model answers "is this token moving right now", which
 * is a trader's question. The pillars answer "is this a project worth putting
 * a perp on", which is the qualifying question, and they are what the listing
 * spec defines. The two are not in competition: demand and momentum are built
 * from the same measurements the old components used, and the honest
 * difference is that supply fit, whitespace and reachability did not exist
 * before and are three of the six pillars here.
 *
 * ON MISSING DATA
 *
 * Every measure returns null rather than a default when its inputs are
 * absent, and the pillar weighting renormalises over the measures that are
 * actually present - so a token with no trade sample is scored on what IS
 * known about it, not punished for a collector that has not reached it yet.
 * `coverage` reports how much of the model was available, and the page shows
 * it beside the score, because a 72 from three pillars is not a 72 from six.
 */

import { readRaw } from '../services/storage/raw-store';
import { GATE_RULES } from '../calculations/gates.js';

/* ------------------------------------------------------------- helpers -- */

const num = (v) => (Number.isFinite(v) ? v : null);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const to100 = (v) => Math.round(clamp01(v) * 100);
const firstOf = (...vals) => { for (const v of vals) if (Number.isFinite(v)) return v; return null; };

/** Maps a value through a floor and a ceiling onto 0-100, log-scaled. */
function logScore(value, floor, ceiling) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const lo = Math.log10(floor);
  const hi = Math.log10(ceiling);
  return to100((Math.log10(value) - lo) / (hi - lo));
}

/** A band score: 100 inside [lo, hi], falling off outside it. */
function bandScore(value, lo, hi, falloff) {
  if (!Number.isFinite(value)) return null;
  if (value >= lo && value <= hi) return 100;
  const distance = value < lo ? lo - value : value - hi;
  return to100(1 - distance / falloff);
}

/** Median of a numeric array, ignoring holes. */
function median(list) {
  const xs = (list || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Reads one raw file, turning "not written yet" into null rather than a throw. */
const source = (rel) => async (_inputs, ctx) => {
  const path = typeof rel === 'function' ? rel(ctx) : rel;
  return readRaw(path);
};

/* ------------------------------------------------------- the thresholds -- */

/**
 * Every number the model can be argued with, in one place.
 *
 * These are starting values from the listing spec, not findings. They are
 * here rather than inline so that tuning the engine is editing a table, and
 * so the page can print the threshold next to the value it judged.
 */
export const RULES = {
  // One table for both: the board's gates and this flow's (calculations/gates.js).
  gates: GATE_RULES,
  supplySweetSpot: { lo: 5, hi: 40, falloff: 30 },
  pillars: {
    demand: 25, supply: 20, whitespace: 15, durability: 15, momentum: 15, reach: 10,
  },
  capBand: [
    { max: 250e3, mult: 0.5, label: 'under $250k' },
    { max: 1e6, mult: 0.8, label: '$250k-$1M' },
    { max: 150e6, mult: 1.0, label: '$1M-$150M' },
    { max: 500e6, mult: 0.8, label: '$150M-$500M' },
    { max: Infinity, mult: 0.5, label: 'over $500M' },
  ],
  tiers: [
    { min: 70, tier: 'A', label: 'APPROACH', needsWhitespace: true },
    { min: 50, tier: 'B', label: 'NURTURE', needsWhitespace: false },
    { min: 0, tier: 'C', label: 'IGNORE', needsWhitespace: false },
  ],
  ev: { perpToSpot: 0.3, feePct: 0.0006, vibeShare: 0.8 },
  newLaunchHours: 24 * 14,
};

export const COLUMNS = ['SOURCES', 'NORMALISE', 'GATES', 'MEASURES', 'PILLARS', 'VERDICT'];

/* ------------------------------------------------------------- SOURCES -- */

const SOURCES = [
  {
    id: 'src.market', col: 'SOURCES', title: 'market.json',
    note: 'Trending pools for the chain, each provider answering separately.',
    deps: [], run: source((ctx) => `${ctx.chain}/market.json`),
    show: (v) => [{ k: 'rows', v: (v.rows || []).length }],
  },
  {
    id: 'src.intel', col: 'SOURCES', title: 'intel.json',
    note: 'GoPlus, RugCheck, honeypot.is, Kyber, DefiLlama, per token.',
    deps: [], run: source((ctx) => `${ctx.chain}/intel.json`),
    show: (v) => [{ k: 'tokens', v: Object.keys(v.tokens || {}).length }],
  },
  {
    id: 'src.trades', col: 'SOURCES', title: 'trades.json',
    note: 'Wallet-level trade samples per pool.',
    deps: [], run: source((ctx) => `${ctx.chain}/trades.json`),
    show: (v) => [{ k: 'pools', v: Object.keys(v.pools || {}).length }],
  },
  {
    id: 'src.observations', col: 'SOURCES', title: 'observations.json',
    note: 'Price and liquidity every 60s - the durability window.',
    deps: [], run: source((ctx) => `${ctx.chain}/observations.json`),
    show: (v) => [{ k: 'series', v: Object.keys(v.tokens || {}).length }],
  },
  {
    id: 'src.promotion', col: 'SOURCES', title: 'promotion.json',
    note: 'DexScreener boosts and paid profiles - who is buying attention.',
    deps: [], run: source((ctx) => `${ctx.chain}/promotion.json`),
    show: (v) => [{ k: 'rows', v: (v.rows || []).length }],
  },
  {
    id: 'src.ethos', col: 'SOURCES', title: 'ethos.json',
    note: 'Reputation of the X account each token advertises.',
    deps: [], run: source('ethos.json'),
    show: (v) => [{ k: 'handles', v: Object.keys(v.handles || {}).length }],
  },
  {
    id: 'src.perps', col: 'SOURCES', title: 'perps.json',
    note: 'Symbols already trading as futures on Hyperliquid, Binance, Aster.',
    deps: [], run: source('perps.json'),
    show: (v) => [
      { k: 'symbols', v: v.symbolCount },
      { k: 'venues', v: `${v.venuesReachable}/${v.venuesTotal}` },
    ],
  },
];

/* ----------------------------------------------------------- NORMALISE -- */

/** The token's row out of the chain's feed. Everything downstream hangs off this. */
function rowFor(market, ctx) {
  const rows = (market && market.rows) || [];
  if (!rows.length) return null;
  if (ctx.tokenAddress) {
    const hit = rows.find((r) => r.tokenAddress === ctx.tokenAddress);
    if (hit) return hit;
  }
  return rows[0];
}

const NORMALISE = [
  {
    id: 'norm.identity', col: 'NORMALISE', title: 'Identity',
    note: 'Who this is: symbol, address, pool age, the accounts it advertises.',
    deps: ['src.market'],
    run: ({ 'src.market': market }, ctx) => {
      const row = rowFor(market, ctx);
      if (!row) return null;
      const gt = (row.sources && row.sources.geckoterminal) || {};
      const ds = (row.sources && row.sources.dexscreener) || {};
      const createdAt = firstOf(gt.poolCreatedAt, ds.pairCreatedAt);
      const socials = (row.links && row.links.socials) || [];
      const x = socials.find((s) => /twitter|x\.com/i.test(String(s.type || '') + String(s.url || '')));
      const jup = (row.sources && row.sources.jupiter) || {};
      return {
        symbol: String(row.symbol || '').replace(/^\$/, ''),
        name: row.name || null,
        chain: row.chain || ctx.chain,
        tokenAddress: row.tokenAddress,
        poolAddress: row.poolAddress,
        ageHours: createdAt ? (Date.now() - createdAt) / 3600000 : null,
        xUrl: (x && x.url) || jup.twitter || null,
        websites: ((row.links && row.links.websites) || []).length,
        socials: socials.length,
        launchpad: jup.launchpad || null,
      };
    },
    show: (v) => [
      { k: 'symbol', v: v.symbol },
      { k: 'age', v: v.ageHours == null ? '—' : `${(v.ageHours / 24).toFixed(1)}d` },
      { k: 'links', v: `${v.socials} social / ${v.websites} site` },
    ],
  },
  {
    id: 'norm.market', col: 'NORMALISE', title: 'Market',
    note: 'Price, depth, turnover. DexScreener preferred, GeckoTerminal behind it.',
    deps: ['src.market'],
    run: ({ 'src.market': market }, ctx) => {
      const row = rowFor(market, ctx);
      if (!row) return null;
      const gt = (row.sources && row.sources.geckoterminal) || {};
      const ds = (row.sources && row.sources.dexscreener) || {};
      const vol = (o) => (o && o.volumeUsd) || {};
      const tx = (o) => (o && o.transactions) || {};
      const h24 = firstOf(vol(ds).h24, vol(gt).h24);
      const m5 = firstOf(vol(ds).m5, vol(gt).m5);
      const txM5 = tx(gt).m5 || tx(ds).m5 || {};
      return {
        priceUsd: firstOf(ds.priceUsd, gt.priceUsd),
        liquidityUsd: firstOf(ds.liquidityUsd, gt.liquidityUsd),
        marketCapUsd: firstOf(ds.marketCapUsd, gt.marketCapUsd),
        fdvUsd: firstOf(ds.fdvUsd, gt.fdvUsd),
        volume24hUsd: h24,
        volume5mUsd: m5,
        buys5m: num(txM5.buys),
        sells5m: num(txM5.sells),
        buyers5m: num(txM5.buyers),
        changeH24Pct: firstOf((ds.priceChangePct || {}).h24, (gt.priceChangePct || {}).h24),
        sourcesAgreeing: [ds.priceUsd, gt.priceUsd].filter(Number.isFinite).length,
      };
    },
    show: (v) => [
      { k: 'liquidity', v: v.liquidityUsd == null ? '—' : `$${Math.round(v.liquidityUsd).toLocaleString()}` },
      { k: 'vol 24h', v: v.volume24hUsd == null ? '—' : `$${Math.round(v.volume24hUsd).toLocaleString()}` },
      { k: 'mcap', v: v.marketCapUsd == null ? '—' : `$${Math.round(v.marketCapUsd).toLocaleString()}` },
    ],
  },
  {
    id: 'norm.safety', col: 'NORMALISE', title: 'Contract & holders',
    note: 'GoPlus and honeypot.is, plus the holder series the collector keeps.',
    deps: ['src.intel', 'norm.identity'],
    run: ({ 'src.intel': intel, 'norm.identity': id }) => {
      if (!id) return null;
      const payload = ((intel && intel.tokens) || {})[id.tokenAddress];
      if (!payload) return null;
      const gp = payload.goplus || {};
      const hp = payload.honeypot || {};
      const pct = (v) => { const n = Number(v); return Number.isFinite(n) ? n * 100 : null; };
      const holders = Array.isArray(gp.holders) ? gp.holders : [];
      const topShare = holders.length
        ? holders.slice(0, 10).reduce((sum, h) => sum + (Number(h.percent) || 0), 0) * 100
        : null;
      const series = payload.holderSeries || [];
      return {
        isHoneypot: hp.isHoneypot === true || gp.is_honeypot === '1',
        buyTaxPct: firstOf(hp.buyTaxPct, pct(gp.buy_tax)),
        sellTaxPct: firstOf(hp.sellTaxPct, pct(gp.sell_tax)),
        transferTaxPct: num(hp.transferTaxPct),
        openSource: gp.is_open_source === '1' ? true : gp.is_open_source === '0' ? false : null,
        isProxy: gp.is_proxy === '1',
        mintable: gp.is_mintable === '1',
        creatorRugged: gp.honeypot_with_same_creator === '1',
        creatorPercent: pct(gp.creator_percent),
        holderCount: num(Number(gp.holder_count)),
        top10SharePct: topShare,
        holderSeries: series,
        checked: Boolean(Object.keys(gp).length || Object.keys(hp).length),
      };
    },
    show: (v) => [
      { k: 'honeypot', v: v.isHoneypot ? 'YES' : 'no', c: v.isHoneypot ? 'bad' : 'good' },
      { k: 'tax b/s', v: `${v.buyTaxPct ?? '—'} / ${v.sellTaxPct ?? '—'}%` },
      { k: 'top-10', v: v.top10SharePct == null ? '—' : `${v.top10SharePct.toFixed(1)}%` },
    ],
  },
  {
    id: 'norm.flow', col: 'NORMALISE', title: 'Trade flow',
    note: 'The wallet-level sample for this pool: who bought, who sold, how concentrated.',
    deps: ['src.trades', 'norm.identity'],
    run: ({ 'src.trades': trades, 'norm.identity': id }) => {
      if (!id || !id.poolAddress) return null;
      const entry = ((trades && trades.pools) || {})[id.poolAddress];
      const list = Array.isArray(entry) ? entry : (entry && entry.trades) || [];
      if (!list.length) return null;
      let buyUsd = 0; let sellUsd = 0;
      const perWallet = new Map();
      for (const t of list) {
        const usd = Number(t.usd) || 0;
        if (t.kind === 'sell') sellUsd += usd; else buyUsd += usd;
        perWallet.set(t.wallet, (perWallet.get(t.wallet) || 0) + usd);
      }
      const totals = [...perWallet.values()].sort((a, b) => b - a);
      const total = totals.reduce((s, x) => s + x, 0);
      const top5 = totals.slice(0, 5).reduce((s, x) => s + x, 0);
      return {
        trades: list.length,
        wallets: perWallet.size,
        buyUsd, sellUsd,
        netUsd: buyUsd - sellUsd,
        top5SharePct: total > 0 ? (top5 / total) * 100 : null,
      };
    },
    show: (v) => [
      { k: 'wallets', v: v.wallets },
      { k: 'net', v: `$${Math.round(v.netUsd).toLocaleString()}`, c: v.netUsd >= 0 ? 'good' : 'bad' },
      { k: 'top-5', v: v.top5SharePct == null ? '—' : `${v.top5SharePct.toFixed(0)}%` },
    ],
  },
  {
    id: 'norm.history', col: 'NORMALISE', title: 'History',
    note: 'The 60s observation series: where liquidity and price have been.',
    deps: ['src.observations', 'norm.identity'],
    run: ({ 'src.observations': obs, 'norm.identity': id }) => {
      if (!id) return null;
      const byToken = (obs && obs.tokens) || {};
      const series = byToken[id.tokenAddress] || byToken[id.poolAddress] || null;
      if (!Array.isArray(series) || series.length < 2) return null;
      const prices = series.map((s) => Number(s.price)).filter(Number.isFinite);
      const liqs = series.map((s) => Number(s.liquidity)).filter(Number.isFinite);
      const half = Math.max(1, Math.floor(liqs.length / 2));
      const liqEarly = median(liqs.slice(0, half));
      const liqLate = median(liqs.slice(-half));
      const peak = Math.max(...prices);
      const last = prices[prices.length - 1];
      return {
        samples: series.length,
        spanHours: (series[series.length - 1].t - series[0].t) / 3600000,
        liquidityTrendPct: liqEarly ? ((liqLate - liqEarly) / liqEarly) * 100 : null,
        drawdownPct: peak > 0 ? ((peak - last) / peak) * 100 : null,
        priceLast: last,
      };
    },
    show: (v) => [
      { k: 'samples', v: v.samples },
      { k: 'span', v: `${v.spanHours.toFixed(1)}h` },
      { k: 'liq trend', v: v.liquidityTrendPct == null ? '—' : `${v.liquidityTrendPct > 0 ? '+' : ''}${v.liquidityTrendPct.toFixed(1)}%`,
        c: (v.liquidityTrendPct || 0) >= 0 ? 'good' : 'bad' },
    ],
  },
  {
    id: 'norm.attention', col: 'NORMALISE', title: 'Attention & identity',
    note: 'Ethos reputation of the project account, and whether it is paying to be seen.',
    deps: ['src.ethos', 'src.promotion', 'norm.identity'],
    run: ({ 'src.ethos': ethos, 'src.promotion': promo, 'norm.identity': id }, ctx) => {
      if (!id) return null;
      const link = (((ethos && ethos.tokens) || {})[ctx.chain] || {})[id.tokenAddress] || null;
      const held = link ? ((ethos.handles || {})[link.handle] || null) : null;
      const rows = (promo && promo.rows) || [];
      const boosted = rows.filter((r) =>
        String(r.tokenAddress || '').toLowerCase() === String(id.tokenAddress || '').toLowerCase());
      return {
        handle: link ? link.handle : null,
        handleKind: link ? link.kind : null,
        ethosScore: held ? held.score : null,
        ethosLevel: held ? held.level : null,
        boosts: boosted.filter((b) => b.kind === 'BOOST').length,
        profiles: boosted.filter((b) => b.kind === 'PROFILE').length,
        boostAmount: boosted.reduce((s, b) => s + (Number(b.totalAmount) || 0), 0),
      };
    },
    show: (v) => [
      { k: 'account', v: v.handle ? `@${v.handle}` : 'none' },
      { k: 'ethos', v: v.ethosScore == null ? '—' : (v.ethosScore === 0 ? 'no record' : v.ethosScore) },
      { k: 'paid promo', v: v.boosts + v.profiles ? `${v.boosts + v.profiles}` : 'no' },
    ],
  },
];

/* --------------------------------------------------------------- GATES -- */

/** A gate result. `pass: null` means the gate could not be evaluated. */
const gate = (pass, detail, threshold) => ({ pass, detail, threshold });

const GATES = [
  {
    id: 'gate.honeypot', col: 'GATES', title: 'Sellable',
    note: 'A token that cannot be sold fails before anything else is worth asking.',
    deps: ['norm.safety'],
    run: ({ 'norm.safety': s }) => {
      if (!s || !s.checked) return gate(null, 'contract not checked yet', 'not a honeypot');
      return gate(!s.isHoneypot, s.isHoneypot ? 'honeypot: sells blocked' : 'buys and sells both simulate', 'not a honeypot');
    },
    show: (v) => [{ k: v.pass === null ? 'unknown' : v.pass ? 'PASS' : 'VETO', v: v.detail, c: v.pass === false ? 'bad' : v.pass ? 'good' : 'dim' }],
  },
  {
    id: 'gate.tax', col: 'GATES', title: 'Taxes',
    note: 'Buy, sell and transfer tax each within the ceiling.',
    deps: ['norm.safety'],
    run: ({ 'norm.safety': s }) => {
      const max = RULES.gates.maxTaxPct;
      if (!s || !s.checked) return gate(null, 'contract not checked yet', `<= ${max}%`);
      const worst = Math.max(s.buyTaxPct || 0, s.sellTaxPct || 0, s.transferTaxPct || 0);
      return gate(worst <= max, `worst leg ${worst.toFixed(1)}%`, `<= ${max}%`);
    },
    show: (v) => [{ k: v.pass === null ? 'unknown' : v.pass ? 'PASS' : 'VETO', v: v.detail, c: v.pass === false ? 'bad' : v.pass ? 'good' : 'dim' }],
  },
  {
    id: 'gate.floors', col: 'GATES', title: 'Age / liquidity / volume',
    note: 'The three floors that separate a market from a listing.',
    deps: ['norm.identity', 'norm.market'],
    run: ({ 'norm.identity': id, 'norm.market': m }) => {
      if (!id || !m) return gate(null, 'no market row', 'three floors');
      const g = RULES.gates;
      const checks = [
        { name: 'age', ok: id.ageHours != null && id.ageHours >= g.minAgeHours,
          got: id.ageHours == null ? '—' : `${(id.ageHours / 24).toFixed(1)}d`, want: `${g.minAgeHours / 24}d` },
        { name: 'liquidity', ok: (m.liquidityUsd || 0) >= g.minLiquidityUsd,
          got: `$${Math.round(m.liquidityUsd || 0).toLocaleString()}`, want: `$${g.minLiquidityUsd.toLocaleString()}` },
        { name: 'volume 24h', ok: (m.volume24hUsd || 0) >= g.minVolume24hUsd,
          got: `$${Math.round(m.volume24hUsd || 0).toLocaleString()}`, want: `$${g.minVolume24hUsd.toLocaleString()}` },
      ];
      const failed = checks.filter((c) => !c.ok);
      return Object.assign(
        gate(!failed.length, failed.length ? `${failed.map((f) => f.name).join(', ')} below floor` : 'all three floors cleared', 'three floors'),
        { checks },
      );
    },
    show: (v) => (v.checks || []).map((c) => ({ k: c.name, v: `${c.got} / ${c.want}`, c: c.ok ? 'good' : 'bad' })),
  },
  {
    id: 'gate.major', col: 'GATES', title: 'Not a major',
    note: 'Market-cap ceiling. The weaker of the two majors tests - see the perp gate.',
    deps: ['norm.market'],
    run: ({ 'norm.market': m }) => {
      const cap = RULES.gates.majorMarketCapUsd;
      if (!m || m.marketCapUsd == null) return gate(true, 'no market cap reported - not excluded on this test', `< $${cap / 1e9}B`);
      return gate(m.marketCapUsd < cap, `$${Math.round(m.marketCapUsd).toLocaleString()}`, `< $${cap / 1e9}B`);
    },
    show: (v) => [{ k: v.pass ? 'PASS' : 'VETO', v: v.detail, c: v.pass ? 'good' : 'bad' }],
  },
  {
    id: 'gate.perp', col: 'GATES', title: 'No perp elsewhere',
    note: 'A venue that already lists a perp has judged this token established. ' +
      'Sharper than market cap: nine sub-$1B tokens on the board were caught here and nowhere else.',
    deps: ['norm.identity', 'src.perps'],
    run: ({ 'norm.identity': id, 'src.perps': perps }) => {
      if (!id) return gate(null, 'no token', 'no perp listed');
      if (!perps) return gate(null, 'perps.json not written yet', 'no perp listed');
      const symbol = String(id.symbol || '').toUpperCase();
      const venues = (perps.symbols || {})[symbol] || [];
      return Object.assign(
        gate(!venues.length,
          venues.length ? `already on ${venues.join(', ')}` : `checked ${perps.venuesReachable} venues, none list it`,
          'no perp listed'),
        { venues, checked: perps.venuesReachable, total: perps.venuesTotal },
      );
    },
    show: (v) => [
      { k: v.pass === null ? 'unknown' : v.pass ? 'PASS' : 'VETO', v: v.detail, c: v.pass === false ? 'bad' : v.pass ? 'good' : 'dim' },
      { k: 'venues', v: v.checked == null ? '—' : `${v.checked}/${v.total} reachable` },
    ],
  },
  {
    id: 'gate.verdict', col: 'GATES', title: 'Verdict',
    note: 'Every gate together. A veto ends the run - the pillars are still ' +
      'computed, but the tier is X and the reason is recorded.',
    deps: ['gate.honeypot', 'gate.tax', 'gate.floors', 'gate.major', 'gate.perp'],
    run: (inputs) => {
      const named = {
        'sellable': inputs['gate.honeypot'],
        'taxes': inputs['gate.tax'],
        'floors': inputs['gate.floors'],
        'not a major': inputs['gate.major'],
        'no perp elsewhere': inputs['gate.perp'],
      };
      const vetoes = [];
      const unknown = [];
      for (const [name, g] of Object.entries(named)) {
        if (!g) { unknown.push(name); continue; }
        if (g.pass === false) vetoes.push({ name, detail: g.detail });
        else if (g.pass === null) unknown.push(name);
      }
      return {
        passed: vetoes.length === 0,
        vetoes,
        unknown,
        evaluated: Object.keys(named).length - unknown.length,
        total: Object.keys(named).length,
      };
    },
    show: (v) => [
      { k: v.passed ? 'QUALIFIES' : 'VETOED', v: v.passed ? `${v.evaluated}/${v.total} gates evaluated` : v.vetoes.map((x) => x.name).join(', '),
        c: v.passed ? 'good' : 'bad' },
      ...(v.unknown.length ? [{ k: 'unknown', v: v.unknown.join(', '), c: 'dim' }] : []),
    ],
  },
];

/* ------------------------------------------------------------ MEASURES -- */

const MEASURES = [
  {
    id: 'm.demand', col: 'MEASURES', title: 'Trader demand',
    note: 'Turnover against depth, plus how many distinct buyers show up.',
    deps: ['norm.market', 'norm.flow'],
    run: ({ 'norm.market': m, 'norm.flow': f }) => {
      if (!m) return null;
      const turnover = m.liquidityUsd > 0 && m.volume24hUsd != null
        ? m.volume24hUsd / m.liquidityUsd : null;
      const parts = [];
      const turnoverScore = turnover == null ? null : logScore(turnover, 0.05, 20);
      if (turnoverScore != null) parts.push({ k: 'turnover', s: turnoverScore, d: `${turnover.toFixed(2)}x depth` });
      const volScore = logScore(m.volume24hUsd, 25e3, 50e6);
      if (volScore != null) parts.push({ k: 'volume', s: volScore, d: `$${Math.round(m.volume24hUsd).toLocaleString()}` });
      const buyerScore = m.buyers5m == null ? null : logScore(m.buyers5m, 2, 400);
      if (buyerScore != null) parts.push({ k: 'buyers 5m', s: buyerScore, d: `${m.buyers5m}` });
      const walletScore = f && f.wallets ? logScore(f.wallets, 5, 500) : null;
      if (walletScore != null) parts.push({ k: 'wallets', s: walletScore, d: `${f.wallets}` });
      if (!parts.length) return null;
      return { score: Math.round(parts.reduce((s, p) => s + p.s, 0) / parts.length), parts };
    },
    show: (v) => [{ k: 'score', v: v.score, c: 'score' }, ...v.parts.map((p) => ({ k: p.k, v: p.d }))],
  },
  {
    id: 'm.supply', col: 'MEASURES', title: 'Supply fit',
    note: 'Is there idle supply to deposit? Too little and there is nothing to ' +
      'put in the vault; too much and the chart is one wallet away from ruin.',
    deps: ['norm.safety'],
    run: ({ 'norm.safety': s }) => {
      if (!s || s.top10SharePct == null) return null;
      const { lo, hi, falloff } = RULES.supplySweetSpot;
      const score = bandScore(s.top10SharePct, lo, hi, falloff);
      return {
        score,
        topShare: s.top10SharePct,
        creatorPct: s.creatorPercent,
        window: `${lo}-${hi}%`,
      };
    },
    show: (v) => [
      { k: 'score', v: v.score, c: 'score' },
      { k: 'top-10', v: `${v.topShare.toFixed(1)}%` },
      { k: 'sweet spot', v: v.window },
    ],
  },
  {
    id: 'm.whitespace', col: 'MEASURES', title: 'Whitespace',
    note: 'The opportunity itself: nobody else offers a perp on this.',
    deps: ['gate.perp'],
    run: ({ 'gate.perp': g }) => {
      if (!g || g.pass === null) return null;
      // Full marks only when every venue was actually reachable. Two of five
      // refuse from this network, so an unchecked venue is uncertainty and is
      // priced as such rather than counted as a clear field.
      const coverage = g.total ? g.checked / g.total : 0;
      return {
        score: g.pass ? to100(0.6 + 0.4 * coverage) : 0,
        venues: g.venues || [],
        coverage: Math.round(coverage * 100),
      };
    },
    show: (v) => [
      { k: 'score', v: v.score, c: 'score' },
      { k: v.venues.length ? 'listed on' : 'clear', v: v.venues.length ? v.venues.join(', ') : `${v.coverage}% of venues checked` },
    ],
  },
  {
    id: 'm.durability', col: 'MEASURES', title: 'Durability',
    note: 'Has it survived, and is the liquidity still there.',
    deps: ['norm.identity', 'norm.history'],
    run: ({ 'norm.identity': id, 'norm.history': h }) => {
      const parts = [];
      if (id && id.ageHours != null) {
        parts.push({ k: 'age', s: logScore(id.ageHours, 24, 24 * 365), d: `${(id.ageHours / 24).toFixed(1)}d` });
      }
      if (h && h.liquidityTrendPct != null) {
        parts.push({ k: 'liq trend', s: to100(clamp01(0.5 + h.liquidityTrendPct / 40)), d: `${h.liquidityTrendPct.toFixed(1)}%` });
      }
      if (h && h.drawdownPct != null) {
        parts.push({ k: 'drawdown', s: to100(1 - clamp01(h.drawdownPct / 80)), d: `${h.drawdownPct.toFixed(1)}%` });
      }
      const usable = parts.filter((p) => Number.isFinite(p.s));
      if (!usable.length) return null;
      return { score: Math.round(usable.reduce((s, p) => s + p.s, 0) / usable.length), parts: usable };
    },
    show: (v) => [{ k: 'score', v: v.score, c: 'score' }, ...v.parts.map((p) => ({ k: p.k, v: p.d }))],
  },
  {
    id: 'm.momentum', col: 'MEASURES', title: 'Momentum',
    note: 'Is interest building right now: holders, flow direction, 24h move.',
    deps: ['norm.safety', 'norm.flow', 'norm.market'],
    run: ({ 'norm.safety': s, 'norm.flow': f, 'norm.market': m }) => {
      const parts = [];
      const series = (s && s.holderSeries) || [];
      if (series.length >= 2) {
        const first = Number(series[0].count);
        const last = Number(series[series.length - 1].count);
        if (Number.isFinite(first) && first > 0 && Number.isFinite(last)) {
          const growth = ((last - first) / first) * 100;
          parts.push({ k: 'holders', s: to100(clamp01(0.5 + growth / 30)), d: `${growth > 0 ? '+' : ''}${growth.toFixed(1)}%` });
        }
      }
      if (f && (f.buyUsd + f.sellUsd) > 0) {
        const share = f.buyUsd / (f.buyUsd + f.sellUsd);
        parts.push({ k: 'buy share', s: to100(share), d: `${(share * 100).toFixed(0)}%` });
      }
      if (m && m.changeH24Pct != null) {
        parts.push({ k: '24h', s: to100(clamp01(0.5 + m.changeH24Pct / 60)), d: `${m.changeH24Pct.toFixed(1)}%` });
      }
      if (!parts.length) return null;
      return { score: Math.round(parts.reduce((a, p) => a + p.s, 0) / parts.length), parts };
    },
    show: (v) => [{ k: 'score', v: v.score, c: 'score' }, ...v.parts.map((p) => ({ k: p.k, v: p.d }))],
  },
  {
    id: 'm.reach', col: 'MEASURES', title: 'Reachability & intent',
    note: 'Can we contact them, and are they already spending on growth.',
    deps: ['norm.attention', 'norm.identity'],
    run: ({ 'norm.attention': a, 'norm.identity': id }) => {
      if (!a && !id) return null;
      const parts = [];
      const hasX = Boolean(a && a.handle);
      parts.push({ k: 'X account', s: hasX ? 100 : 0, d: hasX ? `@${a.handle}` : 'none' });
      parts.push({ k: 'website', s: id && id.websites ? 100 : 0, d: id && id.websites ? 'yes' : 'no' });
      if (a && a.ethosScore != null) {
        // 0 means Ethos has no record, which is most projects - scored as
        // neutral-unknown, never as a bad reputation.
        const s = a.ethosScore === 0 ? 50 : to100(clamp01((a.ethosScore - 800) / 900));
        parts.push({ k: 'reputation', s, d: a.ethosScore === 0 ? 'no record' : `${a.ethosScore} ${a.ethosLevel}` });
      }
      if (a) {
        const paid = a.boosts + a.profiles;
        parts.push({ k: 'paid promo', s: paid ? 100 : 30, d: paid ? `${paid}` : 'none' });
      }
      return { score: Math.round(parts.reduce((s, p) => s + p.s, 0) / parts.length), parts };
    },
    show: (v) => [{ k: 'score', v: v.score, c: 'score' }, ...v.parts.map((p) => ({ k: p.k, v: p.d }))],
  },
];

/* ------------------------------------------------------------- PILLARS -- */

/** A pillar is a measure with a weight; kept separate so the weight is visible. */
function pillar(id, title, from, weight, note) {
  return {
    id, col: 'PILLARS', title, note, deps: [from],
    run: (inputs) => {
      const m = inputs[from];
      if (!m || !Number.isFinite(m.score)) return null;
      return { score: m.score, weight, contribution: (m.score * weight) / 100 };
    },
    show: (v) => [
      { k: 'score', v: v.score, c: 'score' },
      { k: 'weight', v: `${v.weight}%` },
      { k: 'adds', v: v.contribution.toFixed(1) },
    ],
  };
}

const PILLARS = [
  pillar('p.demand', 'Trader demand', 'm.demand', RULES.pillars.demand,
    'A perp needs someone on both sides. This is the heaviest pillar.'),
  pillar('p.supply', 'Supply fit', 'm.supply', RULES.pillars.supply,
    'Idle supply to deposit into the vault.'),
  pillar('p.whitespace', 'Whitespace', 'm.whitespace', RULES.pillars.whitespace,
    'Zero when a competitor already lists it.'),
  pillar('p.durability', 'Durability', 'm.durability', RULES.pillars.durability,
    'Past the rug window, liquidity holding.'),
  pillar('p.momentum', 'Momentum', 'm.momentum', RULES.pillars.momentum,
    'Interest building rather than fading.'),
  pillar('p.reach', 'Reachability', 'm.reach', RULES.pillars.reach,
    'A team we can actually talk to.'),
];

/* ------------------------------------------------------------- VERDICT -- */

const VERDICT = [
  {
    id: 'v.fit', col: 'VERDICT', title: 'Listing Fit',
    note: 'The weighted pillars, renormalised over the ones that could be measured, ' +
      'then multiplied by the market-cap band.',
    deps: [...PILLARS.map((p) => p.id), 'norm.market'],
    run: (inputs) => {
      const present = PILLARS.map((p) => ({ id: p.id, v: inputs[p.id] })).filter((x) => x.v);
      if (!present.length) return null;
      const weightUsed = present.reduce((s, x) => s + x.v.weight, 0);
      const weighted = present.reduce((s, x) => s + x.v.score * x.v.weight, 0);
      const base = Math.round(weighted / weightUsed);

      const cap = (inputs['norm.market'] || {}).marketCapUsd;
      const band = RULES.capBand.find((b) => (cap == null ? false : cap < b.max))
        || { mult: 1.0, label: 'no cap reported' };
      const fit = Math.max(0, Math.min(100, Math.round(base * band.mult)));
      return {
        fit, base, band: band.label, mult: band.mult,
        coverage: Math.round((weightUsed / 100) * 100),
        measured: present.length, total: PILLARS.length,
      };
    },
    show: (v) => [
      { k: 'fit', v: v.fit, c: 'score' },
      { k: 'band', v: `${v.band} x${v.mult}` },
      { k: 'coverage', v: `${v.measured}/${v.total} pillars, ${v.coverage}% weight` },
    ],
  },
  {
    id: 'v.tier', col: 'VERDICT', title: 'Tier',
    note: 'Fit becomes an action. A gate veto is tier X whatever the score.',
    deps: ['v.fit', 'gate.verdict', 'p.whitespace'],
    run: ({ 'v.fit': fit, 'gate.verdict': gates, 'p.whitespace': ws }) => {
      if (!fit) return null;
      if (gates && !gates.passed) {
        return { tier: 'X', label: 'VETOED', why: gates.vetoes.map((v) => v.name).join(', ') };
      }
      for (const rule of RULES.tiers) {
        if (fit.fit >= rule.min) {
          if (rule.needsWhitespace && (!ws || ws.score === 0)) {
            return { tier: 'B', label: 'NURTURE', why: 'fit is A-grade but a competitor already lists a perp' };
          }
          return { tier: rule.tier, label: rule.label, why: `fit ${fit.fit} >= ${rule.min}` };
        }
      }
      return { tier: 'C', label: 'IGNORE', why: 'below every threshold' };
    },
    show: (v) => [{ k: v.tier, v: v.label, c: v.tier === 'A' ? 'good' : v.tier === 'X' ? 'bad' : 'dim' }, { k: 'why', v: v.why }],
  },
  {
    id: 'v.ev', col: 'VERDICT', title: 'Expected fees / day',
    note: 'Spot volume x perp-to-spot ratio x fee x our share. Two of those four ' +
      'are guesses until real listings replace them, so this is a magnitude, not a figure.',
    deps: ['norm.market'],
    run: ({ 'norm.market': m }) => {
      if (!m || m.volume24hUsd == null) return null;
      const { perpToSpot, feePct, vibeShare } = RULES.ev;
      const perpVol = m.volume24hUsd * perpToSpot;
      const usd = perpVol * feePct * vibeShare;
      return { usd, perpVol, assumed: { perpToSpot, feePct, vibeShare } };
    },
    show: (v) => [
      { k: 'est fees', v: `$${v.usd < 10 ? v.usd.toFixed(2) : Math.round(v.usd).toLocaleString()}/day`, c: 'score' },
      { k: 'assumes', v: `perp = ${v.assumed.perpToSpot}x spot` },
    ],
  },
  {
    id: 'v.triggers', col: 'VERDICT', title: 'Triggers',
    note: 'What would put this token at the top of today list, regardless of tier.',
    deps: ['norm.attention', 'norm.history', 'm.momentum', 'gate.perp', 'norm.market'],
    run: ({ 'norm.attention': a, 'norm.history': h, 'm.momentum': mo, 'gate.perp': perp, 'norm.market': m }) => {
      const fired = [];
      if (a && (a.boosts || a.profiles)) fired.push({ sign: '+', text: 'paying for DexScreener promotion' });
      if (m && m.liquidityUsd > 0 && m.volume24hUsd / m.liquidityUsd > 3) {
        fired.push({ sign: '+', text: `turnover ${(m.volume24hUsd / m.liquidityUsd).toFixed(1)}x depth` });
      }
      const holders = (mo && mo.parts.find((p) => p.k === 'holders')) || null;
      if (holders && parseFloat(holders.d) >= 15) fired.push({ sign: '+', text: `holders ${holders.d}` });
      if (h && h.liquidityTrendPct != null && h.liquidityTrendPct < -20) {
        fired.push({ sign: '-', text: `liquidity ${h.liquidityTrendPct.toFixed(0)}%` });
      }
      if (perp && perp.pass === false) {
        fired.push({ sign: '-', text: `competitor perp on ${(perp.venues || []).join(', ')}` });
      }
      return { fired, count: fired.length };
    },
    show: (v) => (v.fired.length
      ? v.fired.map((f) => ({ k: f.sign, v: f.text, c: f.sign === '+' ? 'good' : 'bad' }))
      : [{ k: '—', v: 'nothing firing', c: 'dim' }]),
  },
  {
    id: 'v.lane', col: 'VERDICT', title: 'Lane',
    note: 'A token under 14 days old is judged on different gates, so it gets its ' +
      'own lane instead of being hidden by the age floor.',
    deps: ['norm.identity', 'gate.floors'],
    run: ({ 'norm.identity': id, 'gate.floors': floors }) => {
      if (!id) return null;
      if (id.ageHours == null) return { lane: 'UNKNOWN', why: 'no pool creation time' };
      if (id.ageHours < RULES.newLaunchHours) {
        return {
          lane: 'NEW LAUNCH',
          why: `${(id.ageHours / 24).toFixed(1)}d old - judged on safety and growth, not on the age floor`,
          ageFloorWaived: Boolean(floors && !floors.pass),
        };
      }
      return { lane: 'MAIN', why: `${(id.ageHours / 24).toFixed(1)}d old` };
    },
    show: (v) => [{ k: v.lane, v: v.why, c: v.lane === 'NEW LAUNCH' ? 'warn' : 'dim' }],
  },
];

export const NODES = [...SOURCES, ...NORMALISE, ...GATES, ...MEASURES, ...PILLARS, ...VERDICT];

export default NODES;
