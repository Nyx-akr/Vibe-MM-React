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

function normalizeJupiter(jup) {
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
  const jup = normalizeJupiter((raw.sources && raw.sources.jupiter) || null);

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

/** Every wallet seen across the sampled pools, ranked by how many it touched. */
export function walletRegistry(walletSets, filterAddress) {
  const wallets = new Map();
  walletSets.forEach((entry, pool) => {
    entry.wallets.forEach((usd, address) => {
      const w = wallets.get(address) ||
        { address, usd: 0, pools: new Set(), symbols: new Set() };
      w.usd += usd;
      w.pools.add(pool);
      if (entry.symbol) w.symbols.add(entry.symbol);
      wallets.set(address, w);
    });
  });

  let list = [...wallets.values()].map((w) => ({
    address: w.address,
    volumeUsd: Math.round(w.usd),
    poolsTouched: w.pools.size,
    symbols: [...w.symbols],
    label: w.pools.size >= 3 ? 'MULTI-POOL' : w.pools.size === 2 ? 'CROSS-POOL' : 'SINGLE-POOL',
  }));

  if (filterAddress) {
    const needle = String(filterAddress).toLowerCase();
    list = list.filter((w) => w.address.toLowerCase() === needle);
  }
  list.sort((a, b) => b.poolsTouched - a.poolsTouched || b.volumeUsd - a.volumeUsd);

  return {
    poolsSampled: walletSets.size,
    walletsSeen: wallets.size,
    multiPool: list.filter((w) => w.poolsTouched > 1).length,
    rows: list.slice(0, 60),
  };
}

/* ========================================================= 8. social ===== */

const SOCIAL_STOPWORDS = new Set([
  'THE', 'AND', 'FOR', 'ALL', 'NEW', 'TOP', 'BUY', 'SELL', 'USD', 'USDC', 'USDT',
  'SOL', 'ETH', 'BTC', 'WIF', 'CAT', 'DOG', 'PUMP', 'MOON', 'BULL', 'BEAR',
]);

/**
 * Counts board mentions of one symbol.
 *
 * Short or generic tickers are refused rather than counted: matching "CAT"
 * against a message board produces a number, just not a meaningful one.
 */
export function mentionsFor(threads, symbol) {
  const clean = String(symbol || '').replace(/[^A-Za-z0-9]/g, '');
  if (clean.length < 3 || SOCIAL_STOPWORDS.has(clean.toUpperCase())) {
    return { countable: false, mentions: 0, threads: 0, replies: 0, reason: 'symbol too generic to match safely' };
  }
  const re = new RegExp('(\\$' + clean + '\\b)|(\\b' + clean + '\\b)', 'i');
  const hits = (threads || []).filter((t) => re.test(t.text));
  const newest = hits.slice().sort((x, y) => y.time - x.time)[0];
  return {
    countable: true,
    excerpt: newest ? newest.text.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
    mentions: hits.length,
    threads: hits.length,
    replies: hits.reduce((s, t) => s + t.replies, 0),
    newestMs: hits.length ? Math.max(...hits.map((t) => t.time)) : null,
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
