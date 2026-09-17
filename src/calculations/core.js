/**
 * Shared calculations: everything the dashboard derives, except the Asset
 * Detail score model (which lives in ./asset-detail.js).
 *
 * The server sends raw provider numbers and nothing else. Every ratio, age,
 * delta, baseline, z-score and aggregate in the app is computed here, from
 * those numbers, in the browser.
 *
 * Layout of this file:
 *   1. math          - the primitives every other section uses
 *   2. normalize     - provider payloads to one flat row
 *   3. screening     - which rows are worth showing at all
 *   4. baselines     - z-scores from the server's rolling raw samples
 *   5. trades        - wallet-level aggregates from sampled trades
 *   6. rotation      - shared wallets between pools          (ROTATION tab)
 *   7. wallets       - the wallet registry                   (WALLETS tab)
 *   8. social        - board mentions and baselines          (SOCIAL SCANNER)
 *   9. evaluation    - forward returns and calibration       (EVALUATION tab)
 *  10. system health - provider latency percentiles          (SYSTEM HEALTH)
 *  11. summarize     - board-level totals                    (LIVE OPPS header)
 */

/* ========================================================== 1. math ====== */

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A 0-1 fraction as a 0-100 integer. */
export const to100 = (v) => Math.round(clamp01(v) * 100);

/**
 * Scores a multiple of baseline. 1x lands at 50, 10x at 80, 0.1x at 20 - a
 * log curve, so a 20x spike does not swamp everything else in the model.
 */
export const multipleScore = (multiple) =>
  Number.isFinite(multiple) && multiple > 0 ? to100(0.5 + 0.3 * Math.log10(multiple)) : null;

/** Scores an absolute value on a log scale between lo and hi. */
export const logScore = (value, lo, hi) =>
  Number.isFinite(value) && value > 0
    ? to100((Math.log10(Math.max(value, 1)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)))
    : null;

export function percentDelta(from, to) {
  if (from === null || to === null || !from) return null;
  return ((to - from) / from) * 100;
}

export function statsFor(values) {
  const clean = values.filter((v) => Number.isFinite(v));
  if (!clean.length) return null;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((a, b) => a + (b - mean) * (b - mean), 0) / clean.length;
  return { mean, stdev: Math.sqrt(variance), n: clean.length };
}

export function median(values) {
  if (!values || !values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const round = (v, dp) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

/* ===================================================== 2. normalize ====== */

/**
 * One provider window (buy/sell/organic volume) to the derived splits.
 *
 * The server forwards Jupiter's raw volumes; the net, the ratio and the
 * organic share are worked out here.
 */
function jupiterWindow(win) {
  if (!win) return null;
  const buy = win.buyVolumeUsd;
  const sell = win.sellVolumeUsd;
  const total = (buy || 0) + (sell || 0);
  const organic = (win.buyOrganicVolumeUsd || 0) + (win.sellOrganicVolumeUsd || 0);
  return {
    ...win,
    buyUsd: buy,
    sellUsd: sell,
    netUsd: buy !== null && sell !== null ? round(buy - sell, 2) : null,
    netRatio: total ? round((buy - sell) / total, 3) : null,
    organicUsd: organic || null,
    organicSharePct: total ? round((organic / total) * 100, 1) : null,
  };
}

export function normalizeJupiterToken(jup) {
  if (!jup) return null;
  return {
    ...jup,
    stats5m: jupiterWindow(jup.stats5m),
    stats1h: jupiterWindow(jup.stats1h),
    stats6h: jupiterWindow(jup.stats6h),
    stats24h: jupiterWindow(jup.stats24h),
  };
}

/**
 * Collapses the server's side-by-side provider values into one row.
 *
 * DexScreener wins where both answered, because it re-prices on every request
 * while the GeckoTerminal pool list is cached for minutes. GeckoTerminal is
 * the only source for distinct buyer/seller counts, so those come from it
 * alone. Where a provider said nothing, the other one is used rather than
 * letting a null erase a real number.
 */
export function normalizeRow(raw, fetchedAt = Date.now()) {
  const gt = (raw.sources && raw.sources.geckoterminal) || {};
  const ds = (raw.sources && raw.sources.dexscreener) || null;
  const jup = normalizeJupiterToken((raw.sources && raw.sources.jupiter) || null);

  const pick = (a, b) => (a === null || a === undefined ? (b === undefined ? null : b) : a);
  const dsVol = (ds && ds.volumeUsd) || {};
  const gtVol = gt.volumeUsd || {};
  const dsChg = (ds && ds.priceChangePct) || {};
  const gtChg = gt.priceChangePct || {};
  const gtTx = gt.transactions || {};
  const dsTx = (ds && ds.transactions) || {};

  const priceUsd = pick(ds && ds.priceUsd, gt.priceUsd);
  const liquidityUsd = pick(ds && ds.liquidityUsd, gt.liquidityUsd);
  const volume24hUsd = pick(dsVol.h24, gtVol.h24);

  const buys24h = pick(gtTx.h24 && gtTx.h24.buys, dsTx.h24 && dsTx.h24.buys);
  const sells24h = pick(gtTx.h24 && gtTx.h24.sells, dsTx.h24 && dsTx.h24.sells);

  const createdAt = pick(gt.poolCreatedAt, ds && ds.pairCreatedAt);

  // Two providers priced it, so "confirmed by more than one source" is a fact
  // the app can check rather than a claim the server makes.
  const agreeing = [];
  if (gt.priceUsd !== null && gt.priceUsd !== undefined) agreeing.push('geckoterminal');
  if (ds && ds.priceUsd !== null && ds.priceUsd !== undefined) agreeing.push('dexscreener');

  return {
    chain: raw.chain,
    tokenAddress: raw.tokenAddress,
    poolAddress: raw.poolAddress,
    symbol: raw.symbol,
    name: raw.name,
    pairName: raw.pairName,
    quoteSymbol: raw.quoteSymbol,
    imageUrl: raw.imageUrl,
    dexId: raw.dexId,
    links: raw.links,

    priceUsd,
    priceSource: ds && ds.priceUsd !== null ? 'dexscreener'
      : (gt.priceUsd !== null ? 'geckoterminal' : null),
    quoteTokenPriceUsd: gt.quoteTokenPriceUsd ?? null,
    liquidityUsd,
    volume24hUsd,
    volume1hUsd: pick(dsVol.h1, gtVol.h1),
    volume5mUsd: pick(dsVol.m5, gtVol.m5),
    marketCapUsd: pick(ds && ds.marketCapUsd, gt.marketCapUsd),
    fdvUsd: pick(ds && ds.fdvUsd, gt.fdvUsd),

    priceChangePct: {
      m5: pick(dsChg.m5, gtChg.m5),
      m15: gtChg.m15 ?? null,
      h1: pick(dsChg.h1, gtChg.h1),
      h6: pick(dsChg.h6, gtChg.h6),
      h24: pick(dsChg.h24, gtChg.h24),
    },

    txns24h: { buys: buys24h, sells: sells24h },
    txns5m: {
      buys: pick(gtTx.m5 && gtTx.m5.buys, dsTx.m5 && dsTx.m5.buys),
      sells: pick(gtTx.m5 && gtTx.m5.sells, dsTx.m5 && dsTx.m5.sells),
    },
    // Distinct wallets, not transaction counts. GeckoTerminal alone reports these.
    traders5m: { buyers: (gtTx.m5 && gtTx.m5.buyers) ?? null, sellers: (gtTx.m5 && gtTx.m5.sellers) ?? null },
    traders24h: { buyers: (gtTx.h24 && gtTx.h24.buyers) ?? null, sellers: (gtTx.h24 && gtTx.h24.sellers) ?? null },

    buySellRatio24h: buys24h !== null && sells24h ? buys24h / sells24h : null,
    volumeToLiquidity24h: volume24hUsd !== null && liquidityUsd ? volume24hUsd / liquidityUsd : null,

    poolCreatedAt: createdAt,
    poolAgeHours: createdAt ? (fetchedAt - createdAt) / 3600000 : null,

    launchpad: (jup && jup.launchpad) || null,
    circulatingSupply: jup ? jup.circSupply : null,
    totalSupply: jup ? jup.totalSupply : null,
    jupiter: jup,

    sources: {
      geckoterminal: { priceUsd: gt.priceUsd ?? null, liquidityUsd: gt.liquidityUsd ?? null, volume24hUsd: gtVol.h24 ?? null },
      dexscreener: ds
        ? { priceUsd: ds.priceUsd, liquidityUsd: ds.liquidityUsd, volume24hUsd: dsVol.h24, pairs: ds.pairsListed }
        : { priceUsd: null, liquidityUsd: null, volume24hUsd: null, pairs: 0 },
    },
    crossSource: {
      sourcesAgreeing: agreeing.length,
      sources: agreeing,
      priceDeltaPct: percentDelta(gt.priceUsd ?? null, (ds && ds.priceUsd) ?? null),
    },
  };
}

/* ====================================================== 3. screening ===== */

/**
 * Screening is for emerging tokens, so blue chips, stablecoins and wrapped
 * natives are excluded. They dominate trending pools by volume without ever
 * being the kind of asset this dashboard exists to surface.
 */
const STABLE_SYMBOLS = new Set([
  'USDC', 'USDT', 'DAI', 'USDG', 'USDE', 'USDS', 'USDD', 'USD1', 'USDBC', 'USDY',
  'FDUSD', 'TUSD', 'PYUSD', 'FRAX', 'LUSD', 'SUSD', 'BUSD', 'EURC', 'GUSD', 'CRVUSD',
]);
const WRAPPED_OR_MAJOR_SYMBOLS = new Set([
  'ETH', 'WETH', 'BTC', 'WBTC', 'CBBTC', 'TBTC', 'LBTC',
  'SOL', 'WSOL', 'BNB', 'WBNB', 'AVAX', 'WAVAX', 'MATIC', 'WMATIC', 'POL', 'WPOL',
  'HYPE', 'WHYPE', 'STETH', 'WSTETH', 'WEETH', 'RETH', 'EZETH', 'RSETH',
  'SAVAX', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'LINK',
]);

export const MAJOR_MARKET_CAP_USD = 1e9;

/**
 * Bridged assets carry a chain suffix - BTC.b and WETH.e on Avalanche, USDC.e
 * on several L2s - so the suffix is stripped before matching.
 */
export function normalizeSymbol(raw) {
  let symbol = String(raw || '').toUpperCase().trim();
  if (symbol.charAt(0) === '$') symbol = symbol.slice(1);
  const dot = symbol.lastIndexOf('.');
  if (dot > 0 && symbol.length - dot <= 3) symbol = symbol.slice(0, dot);
  return symbol;
}

export function isMajorToken(row, options) {
  const ceiling = (options && options.maxMarketCapUsd) || MAJOR_MARKET_CAP_USD;
  const symbol = normalizeSymbol(row && row.symbol);
  if (STABLE_SYMBOLS.has(symbol) || WRAPPED_OR_MAJOR_SYMBOLS.has(symbol)) return true;
  const cap = toNumber(row && row.marketCapUsd);
  return cap !== null && cap > ceiling;
}

/**
 * Trending pools list the same token under several pools. Keeps the deepest
 * pool per token and reports what it dropped.
 */
export function screenRows(rows, options) {
  const opts = options || {};
  const excluded = { majors: 0, duplicates: 0 };
  const byToken = new Map();
  const kept = [];

  rows.forEach((row) => {
    if (!opts.includeMajors && isMajorToken(row, opts)) { excluded.majors += 1; return; }
    const key = row.tokenAddress || row.poolAddress;
    if (!key) { kept.push(row); return; }
    const seen = byToken.get(key);
    if (!seen) { byToken.set(key, row); kept.push(row); return; }
    excluded.duplicates += 1;
    if ((toNumber(row.liquidityUsd) || 0) > (toNumber(seen.liquidityUsd) || 0)) {
      kept[kept.indexOf(seen)] = row;
      byToken.set(key, row);
    }
  });

  return { rows: kept, excluded };
}

/* ====================================================== 4. baselines ===== */

export const Z_MIN_SAMPLES = 8;

const HISTORY_METRICS = Object.freeze({
  volume5mUsd: 'VOL_ANOM_5M',
  buys5m: 'TRADE_ACTIVITY_5M',
  buyers5m: 'BUYER_BREADTH_5M',
  liquidityUsd: 'LIQ_GROWTH',
});

/**
 * How unusual the newest reading is, against this pool's own recent history.
 *
 * This is the calculation the whole screener turns on. Nobody publishes "is
 * this volume unusual for THIS token" - it only exists because the server has
 * been sampling the pool every 15 seconds, and it is computed here from those
 * raw samples.
 */
export function zScoresFrom(samples) {
  const list = Array.isArray(samples) ? samples : [];
  const out = {
    samples: list.length,
    windowMs: list.length > 1 ? list[list.length - 1].t - list[0].t : 0,
    metrics: {},
  };
  if (list.length < Z_MIN_SAMPLES) return out;

  Object.keys(HISTORY_METRICS).forEach((metric) => {
    const history = list.slice(0, -1).map((s) => s[metric]);
    const current = list[list.length - 1][metric];
    const stats = statsFor(history);
    if (!stats || !Number.isFinite(current)) return;
    out.metrics[metric] = {
      code: HISTORY_METRICS[metric],
      value: current,
      mean: round(stats.mean, 3),
      stdev: round(stats.stdev, 3),
      z: stats.stdev > 0 ? round((current - stats.mean) / stats.stdev, 2) : null,
      multiple: stats.mean > 0 ? round(current / stats.mean, 2) : null,
      samples: stats.n,
    };
  });
  return out;
}

/**
 * A second baseline, from the trade tape rather than from our samples: the
 * trades are bucketed into 5-minute windows and the newest bucket compared to
 * the ones before it. Useful when a pool is new enough to have no sample
 * history yet but has plenty of trades.
 */
export function bucketBaselines(trades) {
  if (!trades || trades.length < 20) return { samples: 0, metrics: {} };
  const withTime = trades.filter((t) => t.at).sort((a, b) => a.at - b.at);
  if (withTime.length < 20) return { samples: 0, metrics: {} };

  const bucketMs = 5 * 60 * 1000;
  const start = withTime[0].at;
  const buckets = new Map();
  withTime.forEach((t) => {
    const idx = Math.floor((t.at - start) / bucketMs);
    let b = buckets.get(idx);
    if (!b) { b = { volume: 0, buys: 0, buyers: new Set() }; buckets.set(idx, b); }
    b.volume += t.usd;
    if (t.kind === 'buy') { b.buys += 1; b.buyers.add(t.wallet); }
  });
  const ordered = [...buckets.keys()].sort((a, b) => a - b).map((k) => buckets.get(k));
  if (ordered.length < 3) return { samples: ordered.length, metrics: {} };

  const build = (code, values) => {
    const current = values[values.length - 1];
    const history = values.slice(0, -1);
    const stats = statsFor(history);
    if (!stats) return null;
    return {
      code,
      value: current,
      mean: round(stats.mean, 3),
      stdev: round(stats.stdev, 3),
      z: stats.stdev > 0 ? round((current - stats.mean) / stats.stdev, 2) : null,
      multiple: stats.mean > 0 ? round(current / stats.mean, 2) : null,
      samples: stats.n,
    };
  };

  const metrics = {};
  const vol = build('VOL_ANOM_5M', ordered.map((b) => b.volume));
  const buys = build('TRADE_ACTIVITY_5M', ordered.map((b) => b.buys));
  const buyers = build('BUYER_BREADTH_5M', ordered.map((b) => b.buyers.size));
  if (vol) metrics.volume5mUsd = vol;
  if (buys) metrics.buys5m = buys;
  if (buyers) metrics.buyers5m = buyers;

  return {
    samples: ordered.length,
    windowMs: withTime[withTime.length - 1].at - start,
    source: 'pool trades bucketed into 5m windows',
    metrics,
  };
}

/* ========================================================= 5. trades ===== */

/**
 * Who traded, how much, and how concentrated it was.
 *
 * one-and-done wallets, top-5 share and trades-per-wallet are the three
 * signals that separate a crowd from a handful of bots cycling volume.
 */
export function tradeStatsFrom(trades) {
  if (!trades || !trades.length) return null;
  const wallets = new Map();
  let buyUsd = 0;
  let sellUsd = 0;
  const buyers = new Set();
  const sellers = new Set();

  trades.forEach((t) => {
    if (t.kind === 'buy') { buyUsd += t.usd; buyers.add(t.wallet); }
    else { sellUsd += t.usd; sellers.add(t.wallet); }
    const w = wallets.get(t.wallet) || { trades: 0, usd: 0 };
    w.trades += 1;
    w.usd += t.usd;
    wallets.set(t.wallet, w);
  });

  const ranked = Array.from(wallets.values()).sort((a, b) => b.usd - a.usd);
  const totalUsd = buyUsd + sellUsd;
  const times = trades.map((t) => t.at).filter(Boolean);
  const oneAndDone = ranked.filter((w) => w.trades === 1).length;

  return {
    trades: trades.length,
    distinctWallets: wallets.size,
    tradesPerWallet: wallets.size ? round(trades.length / wallets.size, 2) : null,
    oneAndDonePct: wallets.size ? round((oneAndDone / wallets.size) * 100, 1) : null,
    topWalletSharePct: totalUsd ? round((ranked[0].usd / totalUsd) * 100, 1) : null,
    top5SharePct: totalUsd
      ? round((ranked.slice(0, 5).reduce((s, w) => s + w.usd, 0) / totalUsd) * 100, 1) : null,
    buyUsd: Math.round(buyUsd),
    sellUsd: Math.round(sellUsd),
    netUsd: Math.round(buyUsd - sellUsd),
    netRatio: totalUsd ? round((buyUsd - sellUsd) / totalUsd, 3) : null,
    buyerWallets: buyers.size,
    sellerWallets: sellers.size,
    windowMinutes: times.length > 1
      ? round((Math.max(...times) - Math.min(...times)) / 60000, 1) : null,
  };
}

/** pool address -> Map(wallet -> usd), from the server's trade samples. */
export function buildWalletSets(tradePools) {
  const sets = new Map();
  (tradePools || []).forEach((entry) => {
    const perWallet = new Map();
    (entry.trades || []).forEach((t) => {
      perWallet.set(t.wallet, (perWallet.get(t.wallet) || 0) + t.usd);
    });
    sets.set(entry.poolAddress, {
      at: entry.at,
      symbol: entry.symbol,
      wallets: perWallet,
      stats: tradeStatsFrom(entry.trades || []),
    });
  });
  return sets;
}

/* ======================================================= 6. rotation ===== */

/**
 * How much of this pool's crowd also trades other pools we are watching.
 *
 * The one signal here nobody else publishes: the same wallets showing up in
 * two pools means capital is rotating between them, not that two unrelated
 * tokens both happen to be busy.
 */
export function rotationFor(walletSets, poolAddress) {
  const own = walletSets.get(poolAddress);
  if (!own || !own.wallets.size) return null;

  const peers = [];
  const sharedWallets = new Set();
  let sharedUsd = 0;

  walletSets.forEach((entry, key) => {
    if (key === poolAddress) return;
    let count = 0;
    let usd = 0;
    own.wallets.forEach((ownUsd, wallet) => {
      if (entry.wallets.has(wallet)) {
        count += 1;
        usd += ownUsd + entry.wallets.get(wallet);
        sharedWallets.add(wallet);
      }
    });
    if (count) peers.push({ symbol: entry.symbol, sharedWallets: count, combinedUsd: Math.round(usd) });
  });

  peers.sort((a, b) => b.combinedUsd - a.combinedUsd);
  own.wallets.forEach((usd, wallet) => { if (sharedWallets.has(wallet)) sharedUsd += usd; });
  const totalUsd = Array.from(own.wallets.values()).reduce((a, b) => a + b, 0);

  return {
    poolsCompared: walletSets.size - 1,
    sharedWalletCount: sharedWallets.size,
    sharedWalletPct: own.wallets.size ? round((sharedWallets.size / own.wallets.size) * 100, 1) : null,
    sharedUsdPct: totalUsd ? round((sharedUsd / totalUsd) * 100, 1) : null,
    peers: peers.slice(0, 5),
  };
}

/** The whole graph: every pool pair that shares wallets. */
export function rotationGraph(walletSets) {
  const pools = [...walletSets.entries()];
  const edges = [];
  for (let i = 0; i < pools.length; i++) {
    for (let k = i + 1; k < pools.length; k++) {
      const [keyA, a] = pools[i];
      const [keyB, b] = pools[k];
      let shared = 0;
      let usd = 0;
      a.wallets.forEach((usdA, wallet) => {
        if (b.wallets.has(wallet)) { shared += 1; usd += usdA + b.wallets.get(wallet); }
      });
      if (shared) {
        edges.push({
          from: a.symbol || keyA.slice(0, 8),
          to: b.symbol || keyB.slice(0, 8),
          sharedWallets: shared,
          combinedUsd: Math.round(usd),
        });
      }
    }
  }
  edges.sort((x, y) => y.combinedUsd - x.combinedUsd);

  const nodes = pools.map(([, entry]) => {
    const touching = edges.filter((e) => e.from === entry.symbol || e.to === entry.symbol);
    return {
      symbol: entry.symbol,
      wallets: entry.wallets.size,
      connections: touching.length,
      sharedUsd: touching.reduce((s, e) => s + e.combinedUsd, 0),
      sampledAt: entry.at,
    };
  }).sort((a, b) => b.sharedUsd - a.sharedUsd);

  return { poolsSampled: pools.length, nodes, edges: edges.slice(0, 40) };
}

/* ======================================================== 7. wallets ===== */

/**
 * Who is trading ONE token, and what they are actually doing.
 *
 * Everything here is derived from a real sample of that pool's trades - the
 * wallet that signed, whether it bought or sold, how much in USD, and when.
 * That sample is a WINDOW, not history: sometimes ten minutes, sometimes a
 * day, depending on how busy the pool is. Every number below describes that
 * window and nothing outside it, which is why `window` is returned first and
 * the tab prints it above everything else.
 *
 * The tags are deliberately conservative. An earlier version of this tab
 * called any wallet that touched three pools a BUNDLER, which on a sample of
 * six pools meant "traded a bit" - it labelled almost every active wallet.
 * A tag here has to be earned by a pattern unlikely to happen by accident;
 * where the sample cannot support a claim, no tag is applied.
 */

/** Wallets whose first trade lands within this window may be one entry. */
const COENTRY_WINDOW_MS = 2000;
/** Co-entry sizes must be this alike (coefficient of variation) to count. */
const COENTRY_MAX_CV = 0.25;
/** Below this many wallets a co-entry burst is not worth reporting. */
const COENTRY_MIN_WALLETS = 4;
/**
 * Entries smaller than this are not reported at all.
 *
 * An audit against live trades found a "cluster" of four $3 buys spread over
 * three seconds. At dust sizes the size test means nothing - a handful of
 * near-equal tiny trades is what a busy pool looks like anyway - and nobody
 * funds a wallet set to move twelve dollars. Ignoring dust removes that whole
 * class of false positive without touching real clusters.
 */
const COENTRY_MIN_ENTRY_USD = 25;
/** Sizes this alike are a machine: the same number, to the cent. */
const COENTRY_HIGH_CV = 0.02;
const COENTRY_MEDIUM_CV = 0.10;
/** A group leaving inside this window has exited together, not coincidentally. */
const COEXIT_WINDOW_MS = 15000;
/** A round trip this balanced, over this many trades, reads as churn. */
const WASH_MAX_NET_SHARE = 0.15;
const WASH_MIN_TRADES = 4;

/** Mean and coefficient of variation - how alike a set of trade sizes is. */
function dispersion(values) {
  if (!values.length) return { mean: null, cv: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (!mean) return { mean: 0, cv: null };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, cv: Math.sqrt(variance) / Math.abs(mean) };
}

/**
 * Bursts of wallets making their FIRST trade at the same moment, for the same
 * amount. Two tests have to pass together, because either alone is noise:
 *
 *   1. more wallets arrive in the window than the pool's own arrival rate
 *      explains (Poisson mean + 3 sigma), so a busy pool is held to a higher
 *      bar than a quiet one;
 *   2. their entry sizes are near-identical, which is the part that random
 *      retail arrivals do not do.
 *
 * On a live sample this cut 13 "clusters" covering 135 of 170 wallets down to
 * one of seven, and reports nothing at all on established pairs.
 */
function coEntryClusters(wallets, spanMs, allTrades) {
  if (wallets.length < COENTRY_MIN_WALLETS || spanMs <= 0) return [];
  const expected = (wallets.length / spanMs) * COENTRY_WINDOW_MS;
  const threshold = Math.max(
    COENTRY_MIN_WALLETS,
    Math.ceil(expected + 3 * Math.sqrt(expected)),
  );

  const byFirst = [...wallets].sort((a, b) => a.firstAt - b.firstAt);
  const clusters = [];
  for (let i = 0; i < byFirst.length; i++) {
    const group = [byFirst[i]];
    for (let j = i + 1; j < byFirst.length &&
      byFirst[j].firstAt - byFirst[i].firstAt <= COENTRY_WINDOW_MS; j++) {
      group.push(byFirst[j]);
    }
    if (group.length < threshold) continue;
    const spread = dispersion(group.map((w) => w.firstUsd));
    if (spread.cv === null || spread.cv > COENTRY_MAX_CV) continue;
    if (spread.mean < COENTRY_MIN_ENTRY_USD) continue;

    // Did the same group also leave together? An entry burst is suggestive;
    // a matched exit burst is the part that is hard to explain as coincidence,
    // and on live data it is what separates a funded wallet set from a crowd
    // reacting to the same signal.
    const members = new Set(group.map((w) => w.address));
    const exits = allTrades
      .filter((t) => t.kind === 'sell' && members.has(t.wallet))
      .sort((a, b) => a.at - b.at);
    let exit = null;
    for (let k = 0; k + 1 < exits.length; k++) {
      const burst = exits.filter((t) => t.at - exits[k].at <= COEXIT_WINDOW_MS);
      const distinct = new Set(burst.map((t) => t.wallet)).size;
      if (distinct >= Math.max(3, Math.ceil(group.length * 0.6)) &&
        (!exit || distinct > exit.wallets)) {
        exit = {
          wallets: distinct,
          at: burst[0].at,
          spanMs: burst[burst.length - 1].at - burst[0].at,
          afterMs: burst[0].at - group[0].firstAt,
          usd: Math.round(burst.reduce((s, t) => s + t.usd, 0)),
        };
      }
    }

    clusters.push({
      wallets: group.length,
      at: group[0].firstAt,
      spanMs: group[group.length - 1].firstAt - group[0].firstAt,
      avgEntryUsd: Math.round(spread.mean),
      sizeSpreadPct: round(spread.cv * 100, 1),
      grossUsd: Math.round(group.reduce((s, w) => s + w.grossUsd, 0)),
      // Graded rather than asserted. Identical-to-the-cent sizes are a machine;
      // "roughly similar" is a hint, and the panel should not present the two
      // as if they carried the same weight.
      confidence: spread.cv <= COENTRY_HIGH_CV && exit ? 'high'
        : spread.cv <= COENTRY_HIGH_CV || (spread.cv <= COENTRY_MEDIUM_CV && exit) ? 'medium'
          : 'low',
      exit,
      members: group.map((w) => w.address),
    });
    i += group.length - 1;
  }
  return clusters;
}

/**
 * One token's wallet picture.
 *
 * @param trades      raw trades for THIS pool: { wallet, kind, usd, at }
 * @param poolAddress the pool they came from
 * @param walletSets  every sampled pool on the chain, for cross-pool overlap
 * @param topHolders  GoPlus's top-holder list, if the provider answered
 * @param tracked     addresses the user is following
 */
export function tokenWalletIntel({
  trades = [], poolAddress = null, walletSets = new Map(),
  topHolders = [], tracked = [],
} = {}) {
  const clean = (trades || []).filter((t) => t && t.wallet && Number.isFinite(t.usd));
  const trackedSet = new Set((tracked || []).map((a) => String(a).toLowerCase()));

  // Addresses that are infrastructure, not participants. The pool itself shows
  // up in GoPlus's holder list on every token; counting it as a whale would
  // overstate concentration on literally every row.
  const infrastructure = new Set(
    [poolAddress, ...walletSets.keys()].filter(Boolean).map((a) => String(a).toLowerCase()),
  );

  const byWallet = new Map();
  clean.forEach((t) => {
    const w = byWallet.get(t.wallet) || {
      address: t.wallet, trades: 0, buys: 0, sells: 0,
      buyUsd: 0, sellUsd: 0, firstAt: t.at, lastAt: t.at, firstUsd: t.usd, sizes: [],
    };
    w.trades += 1;
    if (t.kind === 'sell') { w.sells += 1; w.sellUsd += t.usd; }
    else { w.buys += 1; w.buyUsd += t.usd; }
    if (t.at && t.at < w.firstAt) { w.firstAt = t.at; w.firstUsd = t.usd; }
    if (t.at && t.at > w.lastAt) w.lastAt = t.at;
    w.sizes.push(t.usd);
    byWallet.set(t.wallet, w);
  });

  const times = clean.map((t) => t.at).filter(Boolean);
  const from = times.length ? Math.min(...times) : null;
  const to = times.length ? Math.max(...times) : null;
  const spanMs = from && to ? to - from : 0;

  const base = [...byWallet.values()].map((w) => ({
    ...w,
    grossUsd: w.buyUsd + w.sellUsd,
    netUsd: w.buyUsd - w.sellUsd,
  }));

  const clusters = coEntryClusters(base, spanMs, clean);
  const clustered = new Map();
  clusters.forEach((c, i) => c.members.forEach((a) => clustered.set(a, i)));

  // Supply share, by owner address.
  const holderPct = new Map();
  (topHolders || []).forEach((h) => {
    const address = h && (h.account || h.address);
    if (!address) return;
    const pct = toNumber(h.percent);
    holderPct.set(String(address).toLowerCase(),
      Number.isFinite(pct) ? round(pct * 100, 4) : null);
  });

  // Which other sampled pools each wallet also trades.
  const alsoIn = new Map();
  walletSets.forEach((entry, key) => {
    if (key === poolAddress) return;
    entry.wallets.forEach((usd, address) => {
      if (!byWallet.has(address)) return;
      const list = alsoIn.get(address) || [];
      list.push({ symbol: entry.symbol || String(key).slice(0, 6), usd: Math.round(usd) });
      alsoIn.set(address, list);
    });
  });

  const rows = base.map((w) => {
    const key = w.address.toLowerCase();
    const netShare = w.grossUsd ? w.netUsd / w.grossUsd : 0;
    const roundTrip = w.buys > 0 && w.sells > 0;
    const peers = (alsoIn.get(w.address) || []).sort((a, b) => b.usd - a.usd);
    const supplyPct = holderPct.has(key) ? holderPct.get(key) : null;
    const clusterIndex = clustered.has(w.address) ? clustered.get(w.address) : null;
    const isPool = infrastructure.has(key);

    const tags = [];
    if (isPool) tags.push('POOL');
    if (trackedSet.has(key)) tags.push('TRACKED');
    if (supplyPct !== null && !isPool) tags.push('HOLDER');
    if (clusterIndex !== null) tags.push('CO-ENTRY');
    if (roundTrip && w.trades >= WASH_MIN_TRADES &&
      Math.abs(netShare) < WASH_MAX_NET_SHARE) tags.push('CHURN');
    else if (roundTrip) tags.push('ROUND-TRIP');
    else if (w.sells && !w.buys) tags.push('EXITING');
    else if (w.buys && !w.sells) tags.push(w.trades > 1 ? 'ACCUMULATING' : 'FIRST BUY');
    if (peers.length) tags.push('ROTATING');

    const spread = dispersion(w.sizes);

    return {
      address: w.address,
      trades: w.trades,
      buys: w.buys,
      sells: w.sells,
      buyUsd: Math.round(w.buyUsd),
      sellUsd: Math.round(w.sellUsd),
      grossUsd: Math.round(w.grossUsd),
      netUsd: Math.round(w.netUsd),
      netSharePct: w.grossUsd ? round(netShare * 100, 1) : null,
      firstAt: w.firstAt,
      lastAt: w.lastAt,
      activeMs: w.lastAt - w.firstAt,
      avgTradeUsd: Math.round(w.grossUsd / w.trades),
      sizeSpreadPct: spread.cv === null ? null : round(spread.cv * 100, 1),
      supplyPct,
      isPool,
      isTracked: trackedSet.has(key),
      clusterIndex,
      alsoIn: peers.slice(0, 4),
      poolsTouched: peers.length + 1,
      tags,
    };
  }).sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd) || b.grossUsd - a.grossUsd);

  // The top-holder list in its own right: who holds, and are they active here.
  const active = new Map(rows.map((r) => [r.address.toLowerCase(), r]));
  const holders = (topHolders || []).map((h) => {
    const address = h && (h.account || h.address);
    if (!address) return null;
    const key = String(address).toLowerCase();
    const pct = toNumber(h.percent);
    const hit = active.get(key) || null;
    return {
      address,
      supplyPct: Number.isFinite(pct) ? round(pct * 100, 4) : null,
      locked: Boolean(h.is_locked),
      tag: h.tag || null,
      isPool: infrastructure.has(key),
      isTracked: trackedSet.has(key),
      tradingNow: Boolean(hit),
      netUsd: hit ? hit.netUsd : null,
      trades: hit ? hit.trades : null,
    };
  }).filter(Boolean).sort((a, b) => (b.supplyPct || 0) - (a.supplyPct || 0));

  const real = rows.filter((r) => !r.isPool);
  const buyers = new Set();
  const sellers = new Set();
  clean.forEach((t) => (t.kind === 'sell' ? sellers : buyers).add(t.wallet));
  const buyUsd = real.reduce((s, r) => s + r.buyUsd, 0);
  const sellUsd = real.reduce((s, r) => s + r.sellUsd, 0);
  const grossUsd = buyUsd + sellUsd;

  return {
    poolAddress,
    window: {
      trades: clean.length,
      wallets: real.length,
      from,
      to,
      spanMinutes: spanMs ? round(spanMs / 60000, 1) : null,
    },
    flow: {
      buyUsd: Math.round(buyUsd),
      sellUsd: Math.round(sellUsd),
      netUsd: Math.round(buyUsd - sellUsd),
      grossUsd: Math.round(grossUsd),
      buyerWallets: buyers.size,
      sellerWallets: sellers.size,
      buySharePct: grossUsd ? round((buyUsd / grossUsd) * 100, 1) : null,
      topWalletSharePct: grossUsd && real.length
        ? round((real[0].grossUsd / grossUsd) * 100, 1) : null,
      onceOnlyPct: real.length
        ? round((real.filter((r) => r.trades === 1).length / real.length) * 100, 1) : null,
    },
    counts: {
      accumulating: real.filter((r) => r.tags.includes('ACCUMULATING')).length,
      exiting: real.filter((r) => r.tags.includes('EXITING')).length,
      churn: real.filter((r) => r.tags.includes('CHURN')).length,
      coEntry: real.filter((r) => r.clusterIndex !== null).length,
      rotating: real.filter((r) => r.alsoIn.length).length,
      holders: real.filter((r) => r.supplyPct !== null).length,
      tracked: real.filter((r) => r.isTracked).length,
    },
    clusters,
    holders,
    rows,
    poolsCompared: Math.max(0, walletSets.size - 1),
  };
}

/* ========================================================= 8. social ===== */

/**
 * Tickers that are also ordinary words, market slang or major assets. A bare
 * match on these says nothing, so they are never counted from bare text.
 */
const SOCIAL_STOPWORDS = new Set([
  'THE', 'AND', 'FOR', 'ALL', 'NEW', 'TOP', 'BUY', 'SELL', 'USD', 'USDC', 'USDT',
  'SOL', 'ETH', 'BTC', 'WIF', 'CAT', 'DOG', 'PUMP', 'MOON', 'BULL', 'BEAR',
]);

/**
 * Words that make a bare ticker match credible.
 *
 * Matching a board symbol as a plain word is how the scanner used to count
 * "PAID" every time somebody said they got paid, and "USELESS" every time
 * somebody called a coin useless. A bare hit is therefore only counted when
 * the same post also reads like it is talking about a traded asset. Cashtag
 * hits ($SYM) need no such test - nobody writes $PAID by accident.
 */
const CRYPTO_CONTEXT = new RegExp([
  'coin', 'token', 'ticker', 'mcap', 'market\\s?cap', 'liquidity', 'holder',
  'airdrop', 'presale', 'listing', 'dex', 'swap', 'wallet', 'contract',
  'solana', 'ethereum', 'bnb', 'memecoin', 'shitcoin', 'degen', 'moonshot',
  'bagholder', 'rug\\s?pull', 'pump', 'dump', 'ath\\b', 'chart',
].join('|'), 'i');

/**
 * Counts how often one symbol is named across every social feed.
 *
 * Two tiers, kept apart on purpose:
 *   cashtag    - "$SYM", unambiguous
 *   contextual - bare "SYM" in a post that also talks about trading
 * and a third, `loose`, which is every other bare hit. Loose hits are
 * reported but never counted, because that is the number that used to make an
 * English word look like a trending ticker.
 *
 * Unique authors is a real count of distinct accounts, not a guess: 4chan is
 * anonymous and contributes none, which is why anonPosts is reported beside it.
 */
export function mentionsFor(posts, symbol) {
  const clean = String(symbol || '').replace(/[^A-Za-z0-9]/g, '');
  const empty = {
    countable: false, mentions: 0, cashtag: 0, contextual: 0, loose: 0,
    authors: 0, anonPosts: 0, concentration: null, replies: 0, reactions: 0,
    bySource: {}, matched: [], newestMs: null, excerpt: null,
  };
  if (clean.length < 3 || SOCIAL_STOPWORDS.has(clean.toUpperCase())) {
    return Object.assign({}, empty, { reason: 'symbol too generic to match safely' });
  }

  const cashRe = new RegExp('\\$' + clean + '\\b', 'i');
  // Bare hits are matched case-SENSITIVELY against the upper-case ticker.
  // "PAID" is a ticker; "paid" is a person describing their salary. Case is
  // the cheapest discriminator there is, and it removes most of the English-
  // word false positives on its own; CRYPTO_CONTEXT then has to agree too.
  const bareRe = new RegExp('(?:^|[^A-Za-z0-9$])' + clean.toUpperCase() + '(?![A-Za-z0-9])');

  const matched = [];
  let cashtag = 0; let contextual = 0; let loose = 0;

  for (const p of posts || []) {
    const text = p.text || '';
    const isCash = cashRe.test(text);
    const isBare = !isCash && bareRe.test(text);
    if (!isCash && !isBare) continue;

    if (isCash) { cashtag += 1; }
    else if (CRYPTO_CONTEXT.test(text)) { contextual += 1; }
    else { loose += 1; continue; }

    matched.push({
      source: p.source, id: p.id, author: p.author || null,
      time: p.time || null, replies: p.replies || 0, reactions: p.reactions || 0,
      cashtag: isCash, text: text.slice(0, 400),
    });
  }

  matched.sort((a, b) => (b.time || 0) - (a.time || 0));

  const bySource = {};
  for (const m of matched) bySource[m.source] = (bySource[m.source] || 0) + 1;

  const authorKeys = new Set(matched.filter((m) => m.author).map((m) => m.source + ':' + m.author));
  const anonPosts = matched.filter((m) => !m.author).length;
  const mentions = cashtag + contextual;

  return {
    countable: true,
    mentions: mentions,
    cashtag: cashtag,
    contextual: contextual,
    loose: loose,
    authors: authorKeys.size,
    anonPosts: anonPosts,
    // How many mentions each identifiable account is responsible for. High
    // concentration is the social twin of volume from few wallets. Anonymous
    // posts cannot be attributed, so they are excluded from the ratio.
    concentration: authorKeys.size > 0
      ? round((mentions - anonPosts) / authorKeys.size, 2)
      : null,
    replies: matched.reduce((sum, m) => sum + m.replies, 0),
    reactions: matched.reduce((sum, m) => sum + m.reactions, 0),
    bySource: bySource,
    matched: matched,
    newestMs: matched.length ? matched[0].time : null,
    excerpt: matched.length ? matched[0].text.slice(0, 160) : null,
    reason: null,
  };
}

/** Mention counts against this symbol's own recent mention history. */
export function mentionBaseline(series, current) {
  const list = series || [];
  if (list.length < 4) return { baseline: null, vsBase: null, z: null, samples: list.length };
  const stats = statsFor(list.slice(0, -1).map((s) => s.n));
  if (!stats) return { baseline: null, vsBase: null, z: null, samples: 0 };
  return {
    baseline: round(stats.mean, 2),
    vsBase: stats.mean > 0 ? round(current / stats.mean, 2) : null,
    z: stats.stdev > 0 ? round((current - stats.mean) / stats.stdev, 2) : null,
    samples: stats.n,
  };
}

/* ===================================================== 9. evaluation ===== */

/**
 * Did the score mean anything?
 *
 * The server keeps raw price/liquidity snapshots per token; the app keeps its
 * own journal of what it scored and when. Joining the two by timestamp is what
 * turns "this looked good" into "this was right N% of the time".
 *
 * `observations` is { tokenAddress: [{ t, price, liquidity, symbol }] }
 * `journal`      is { tokenAddress: [{ t, score, stage, flags }] }
 */
export function evaluationFor(observations, journal, horizonMs) {
  const buckets = {};
  const now = Date.now();
  let matured = 0;
  let pending = 0;

  Object.keys(observations || {}).forEach((token) => {
    const series = observations[token] || [];
    const marks = (journal && journal[token]) || [];
    if (!series.length || !marks.length) return;
    const latest = series[series.length - 1];

    marks.forEach((mark) => {
      const age = now - mark.t;
      if (age < horizonMs) { pending += 1; return; }
      // The price at the moment we scored it, and at the horizon.
      const at = series.find((s) => s.t >= mark.t);
      const target = series.find((s) => s.t >= mark.t + horizonMs);
      if (!at || !target || !at.price) return;
      matured += 1;

      const ret = ((target.price - at.price) / at.price) * 100;
      const forward = series.filter((s) => s.t >= mark.t && s.t <= mark.t + horizonMs);
      const mfe = forward.length
        ? ((Math.max(...forward.map((s) => s.price)) - at.price) / at.price) * 100 : null;
      const liquidityDrop = at.liquidity && latest.liquidity
        ? (latest.liquidity - at.liquidity) / at.liquidity : null;

      const bucket = buckets[mark.stage] ||
        (buckets[mark.stage] = { stage: mark.stage, alerts: 0, returns: [], mfes: [], rugs: 0 });
      bucket.alerts += 1;
      bucket.returns.push(ret);
      if (mfe !== null) bucket.mfes.push(mfe);
      if (liquidityDrop !== null && liquidityDrop < -0.8) bucket.rugs += 1;
    });
  });

  const order = ['EXCEPTIONAL', 'CONFIRMED', 'EMERGING', 'WATCH'];
  const rows = order.filter((s) => buckets[s]).map((s) => {
    const b = buckets[s];
    const wins = b.returns.filter((r) => r > 0).length;
    return {
      stage: s,
      alerts: b.alerts,
      precision: b.alerts ? round(wins / b.alerts, 2) : null,
      medianReturnPct: round(median(b.returns), 2),
      medianMfePct: b.mfes.length ? round(median(b.mfes), 2) : null,
      rugRate: b.alerts ? round(b.rugs / b.alerts, 2) : null,
    };
  });

  const allTimes = Object.keys(observations || {})
    .map((k) => (observations[k][0] || {}).t).filter(Boolean);

  return {
    horizonMs,
    maturedObservations: matured,
    pendingObservations: pending,
    tokensTracked: Object.keys(observations || {}).length,
    oldestObservationMs: allTimes.length ? now - Math.min(...allTimes) : 0,
    rows,
  };
}

/** Is a score of 80 actually better than a score of 60? */
export function evaluationReport(observations, journal) {
  const h1 = evaluationFor(observations, journal, 3600000);
  const h24 = evaluationFor(observations, journal, 86400000);
  const byStage = {};
  h1.rows.forEach((r) => { byStage[r.stage] = { ...r, medianReturn1hPct: r.medianReturnPct }; });
  h24.rows.forEach((r) => {
    byStage[r.stage] = { stage: r.stage, ...(byStage[r.stage] || {}),
      medianReturn24hPct: r.medianReturnPct, alerts24h: r.alerts };
  });

  const calibration = [[0, 55], [55, 70], [70, 85], [85, 101]]
    .map(([lo, hi]) => ({ band: lo + '-' + (hi - 1), lo, hi, n: 0, returns: [] }));
  const causeCounts = {};
  const now = Date.now();

  Object.keys(observations || {}).forEach((token) => {
    const series = observations[token] || [];
    const marks = (journal && journal[token]) || [];
    marks.forEach((mark) => {
      if (now - mark.t < 3600000) return;
      const at = series.find((s) => s.t >= mark.t);
      const target = series.find((s) => s.t >= mark.t + 3600000);
      if (!at || !target || !at.price) return;
      const ret = ((target.price - at.price) / at.price) * 100;
      const bucket = calibration.find((b) => mark.score >= b.lo && mark.score < b.hi);
      if (bucket) { bucket.n += 1; bucket.returns.push(ret); }
      if (ret < 0 && Array.isArray(mark.flags)) {
        mark.flags.forEach((code) => { causeCounts[code] = (causeCounts[code] || 0) + 1; });
      }
    });
  });

  return {
    stages: Object.keys(byStage).map((s) => byStage[s]),
    horizons: { short: h1, long: h24 },
    calibration: calibration.map((b) => ({
      band: b.band,
      observations: b.n,
      medianReturnPct: b.returns.length ? round(median(b.returns), 2) : null,
      winRate: b.returns.length
        ? round(b.returns.filter((r) => r > 0).length / b.returns.length, 2) : null,
    })),
    falsePositiveCauses: Object.keys(causeCounts)
      .map((code) => ({ code, count: causeCounts[code] }))
      .sort((a, b) => b.count - a.count).slice(0, 6),
  };
}

/* ================================================== 10. system health ==== */

/** Provider percentiles from the server's raw latency samples. */
export function providerHealth(upstream) {
  if (!upstream) return [];
  const minutes = Math.max((Date.now() - upstream.since) / 60000, 1 / 60);
  return (upstream.providers || []).map((p) => {
    const samples = (p.latencySamplesMs || []).slice().sort((a, b) => a - b);
    const errorRate = p.calls ? p.errors / p.calls : 0;
    return {
      provider: p.provider,
      calls: p.calls,
      callsPerMinute: round(p.calls / minutes, 1),
      errors: p.errors,
      errorRatePct: round(errorRate * 100, 1),
      lastError: p.lastError,
      p50Ms: samples.length ? samples[samples.length >> 1] : null,
      p95Ms: samples.length ? samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] : null,
      status: errorRate > 0.25 ? 'DEGRADED' : errorRate > 0 ? 'PARTIAL' : 'OK',
    };
  }).sort((a, b) => b.calls - a.calls);
}

/* ====================================================== 11. summarize ==== */

/** Board-level totals for the header strip. Scored rows in, one object out. */
export function summarize(rows) {
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const column = (key) => rows.map((row) => row[key]).filter((v) => typeof v === 'number');
  const changes = rows
    .map((row) => row.priceChangePct && row.priceChangePct.h24)
    .filter((v) => typeof v === 'number');

  return {
    poolsTracked: rows.length,
    totalLiquidityUsd: sum(column('liquidityUsd')) || null,
    totalVolume24hUsd: sum(column('volume24hUsd')) || null,
    avgPriceChange24hPct: changes.length ? sum(changes) / changes.length : null,
    medianPriceChange24hPct: median(changes),
    advancing24h: changes.filter((v) => v > 0).length,
    declining24h: changes.filter((v) => v < 0).length,
    multiSourceConfirmed: rows.filter((r) => r.crossSource && r.crossSource.sourcesAgreeing > 1).length,
    activeAlerts: rows.filter((r) => r.score >= 55).length,
    confirmedPlus: rows.filter((r) => r.stage === 'CONFIRMED' || r.stage === 'EXCEPTIONAL').length,
    exceptional: rows.filter((r) => r.stage === 'EXCEPTIONAL').length,
    avgOrganicFlow: (() => {
      const vals = rows.map((r) => r.flow && r.flow.organicFlow).filter((v) => Number.isFinite(v));
      return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    })(),
    avgDataQuality: (() => {
      const vals = rows.map((r) => r.dataQuality).filter((v) => Number.isFinite(v));
      return vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length, 2) : null;
    })(),
    topScore: rows.length ? Math.max(...rows.map((r) => r.score || 0)) : null,
    avgScore: rows.length ? Math.round(sum(rows.map((r) => r.score || 0)) / rows.length) : null,
  };
}
