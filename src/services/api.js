/**
 * VibeScreener API service.
 *
 * Two jobs, in this order:
 *   1. fetch RAW numbers from the data server (which computes nothing)
 *   2. run them through src/calculations to produce everything the UI shows
 *
 * If you are looking for where a score, stage, z-score or risk flag comes
 * from, it is in src/calculations - not here, and not on the server.
 */

import { chainKeys, chainKeyToName } from '../data/chains';
import { payload as catalogPayload } from '../data/catalog';
import {
  normalizeRow, screenRows, zScoresFrom, bucketBaselines,
  buildWalletSets, rotationFor, rotationGraph, tokenWalletIntel,
  mentionsFor, mentionBaseline, evaluationFor, evaluationReport,
  providerHealth, summarize,
} from '../calculations/core';
import {
  evaluateAsset, deriveIntel, usdReferenceMedian,
  SCORE_MODEL, hydrateStages, stageSnapshot,
} from '../calculations/asset-detail';
import {
  recordScore, journalFor, flushJournal, pruneJournal,
  loadStageMemory, saveStageMemory,
} from './score-journal';

// Vercel serves this app as static files with no backend, so API calls need an
// absolute URL to the data server. Override with VITE_API_BASE (e.g.
// http://127.0.0.1:8787 to run against a local server).
const BASE_URL = (import.meta.env.VITE_API_BASE || 'https://vibe-mm-server.onrender.com')
  .replace(/\/+$/, '');

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const quiet = (promise, fallback) => promise.catch(() => fallback);

/* ---------------------------------------------------------- stage memory - */

// Hysteresis needs to know yesterday's stage, so the machine is rehydrated
// once at module load and snapshotted back out as scores are recomputed.
hydrateStages(loadStageMemory());

let lastPersistAt = 0;
function persistDerived() {
  const now = Date.now();
  if (now - lastPersistAt < 30000) return;
  lastPersistAt = now;
  pruneJournal();
  flushJournal();
  saveStageMemory(stageSnapshot());
}

/* --------------------------------------------------------------- caches -- */

/**
 * Per-chain raw inputs that the score needs but that are too expensive to
 * refetch on every poll: the rolling sample series and the trade samples.
 */
const rawCache = new Map();
const RAW_TTL_MS = 20000;

async function rawInputsFor(chainKey) {
  const hit = rawCache.get(chainKey);
  if (hit && Date.now() - hit.at < RAW_TTL_MS) return hit.value;

  const [history, trades] = await Promise.all([
    quiet(fetchJson(`${BASE_URL}/api/history?chain=${chainKey}`), { samples: {} }),
    quiet(fetchJson(`${BASE_URL}/api/trades?chain=${chainKey}`), { pools: [] }),
  ]);
  const value = {
    samples: history.samples || {},
    walletSets: buildWalletSets(trades.pools || []),
    // The raw trades are kept alongside the aggregate, because buildWalletSets
    // reduces each pool to wallet -> usd and drops the buy/sell flag and the
    // timestamps. WALLETS needs those, and this is the one response that
    // already carries every sampled pool.
    tradePools: trades.pools || [],
  };
  rawCache.set(chainKey, { at: Date.now(), value });
  return value;
}

/**
 * Intel cache - the reason a token has ONE score.
 *
 * Intel (contract safety, holders, routed impact) is expensive: roughly seven
 * upstream calls per token, so the board cannot fetch it for every row on
 * every poll. Without a cache the board scored on ~9 of 12 inputs while the
 * detail view scored on 12, and the two disagreed.
 *
 * So intel is cached per token and fed back into board scoring, and a slow
 * background loop fills the gaps. A token's score improves once - when its
 * intel first lands - and is identical everywhere after that.
 *
 * The RAW payload is cached rather than the derived facts, because deriving
 * depends on the row (price cross-check, volume per holder) and the row moves.
 */
const INTEL_TTL_MS = 45 * 60 * 1000;
const intelCache = new Map();

function cachedIntelRaw(chainKey, tokenAddress) {
  const hit = intelCache.get(chainKey + ':' + tokenAddress);
  return hit && Date.now() - hit.at < INTEL_TTL_MS ? hit.raw : null;
}

function putIntelRaw(chainKey, tokenAddress, raw) {
  if (raw) intelCache.set(chainKey + ':' + tokenAddress, { at: Date.now(), raw });
}

/** Intel for a row if we have it, derived against that row's current values. */
function intelFor(chainKey, row) {
  const raw = cachedIntelRaw(chainKey, row.tokenAddress);
  return raw ? deriveIntel(raw, row) : null;
}

// Two tokens per 5s poll fills a 90-row board in about four minutes, then
// costs nothing for the next 45 while the server serves it from its own cache.
const ENRICH_PER_CYCLE = 2;
const enrichInFlight = new Set();

/**
 * Fetches intel for the highest-scoring rows that do not have it yet. Runs in
 * the background - the board never waits on it.
 */
function enrichInBackground(chainKey, rows) {
  const pending = rows
    .filter((r) => r.tokenAddress &&
      !cachedIntelRaw(chainKey, r.tokenAddress) &&
      !enrichInFlight.has(chainKey + ':' + r.tokenAddress))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, ENRICH_PER_CYCLE);

  pending.forEach((row) => {
    const key = chainKey + ':' + row.tokenAddress;
    enrichInFlight.add(key);
    fetchJson(`${BASE_URL}/api/intel?chain=${chainKey}&token=${encodeURIComponent(row.tokenAddress)}`)
      .then((raw) => { if (raw && raw.server === 'ok') putIntelRaw(chainKey, row.tokenAddress, raw); })
      .catch(() => { /* try again on a later cycle */ })
      .finally(() => { enrichInFlight.delete(key); });
  });
}

/** How much of the board is scored on the full input set. */
export function intelCoverage(assets) {
  const rows = assets || [];
  const withIntel = rows.filter((a) => a.scoreBasis === 'intel').length;
  return { total: rows.length, withIntel, pct: rows.length ? Math.round((withIntel / rows.length) * 100) : 0 };
}

/** Reference prices, for the USD-reference component. Cheap and slow-moving. */
const referenceCache = new Map();
async function referenceFor(symbol) {
  if (!symbol) return null;
  const key = String(symbol).toUpperCase();
  const hit = referenceCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  const data = await quiet(fetchJson(`${BASE_URL}/api/reference?symbol=${encodeURIComponent(key)}`), null);
  const value = data && data.quotes && data.quotes.length ? usdReferenceMedian(data) : null;
  referenceCache.set(key, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------ the score -- */

/*
 * There is no scoring in this file.
 *
 * evaluateAsset() in calculations/asset-detail.js is the one place a token is
 * evaluated. This module's job is to fetch raw numbers, hand them to it, and
 * pass the results to the UI.
 */

/* ------------------------------------------------------- the asset model - */

const MEME_LAUNCHPADS = ['pump.fun', 'pumpfun', 'moonshot', 'bags', 'believe', 'boop', 'four.meme', 'sunpump', 'launchlab'];

/** A scored row mapped into the shape the UI components expect. */
export function mapServerRowToAsset(row) {
  const stageMap = { WATCH: 1, EMERGING: 2, CONFIRMED: 3, EXCEPTIONAL: 4 };
  const stage = typeof row.stage === 'number' ? row.stage : (stageMap[row.stage] || 1);

  const chainRaw = String(row.chain || 'solana').toLowerCase();
  const chain = chainKeyToName[chainRaw] || chainRaw.toUpperCase().slice(0, 4);

  // CLASS comes only from signals a provider actually gives us: MEME when a
  // provider names a memecoin launchpad, TOKEN otherwise.
  const launchpad = String(row.launchpad || '').toLowerCase();
  const cls = (launchpad && MEME_LAUNCHPADS.some((l) => launchpad.includes(l))) ? 'MEME' : 'TOKEN';

  const wash = row.flow && row.flow.washRisk != null ? row.flow.washRisk / 100 : null;

  const reasons = (row.scoreModel || [])
    .filter((m) => !m.pending && m.value !== null)
    .slice(0, 4)
    .map((m) => ({
      code: m.key ? m.key.toUpperCase() : 'SIGNAL',
      win: '5M',
      text: m.evidence || `${m.label}: ${m.value}/100`,
      z: (m.value / 10).toFixed(1),
      ratio: (m.value / 20).toFixed(1),
    }));
  if (reasons.length === 0 && row.topReason) {
    reasons.push({ code: 'VOL_ANOM_5M', win: '5M', text: row.topReason, z: '—', ratio: '—' });
  }

  const flags = (row.riskFlags || []).map((f) => ({ sev: f.severity || 'LOW', text: f.detail || f.code }));

  // The server's real 5m-volume history, empty until it has samples. An empty
  // trend beats a made-up rising line.
  const spark = Array.isArray(row.spark) && row.spark.length > 1 ? row.spark : [];

  return {
    id: row.tokenAddress || row.poolAddress || (row.symbol ? row.symbol.toLowerCase() : String(Math.random())),
    sym: row.symbol ? (row.symbol.startsWith('$') ? row.symbol : '$' + row.symbol) : '$TOKEN',
    name: row.name || row.pairName || row.symbol || 'Asset',
    chain,
    cls,
    stage,
    // ?? not ||, so a legitimate 0 survives and null renders as a dash.
    score: row.score ?? null,
    scoreBasis: row.scoreBasis || 'market',
    conf: row.dataQuality ?? null,
    age: row.poolAgeHours != null ? Math.round(row.poolAgeHours * 3600) : null,
    price: row.priceUsd ?? null,
    chg: row.priceChangePct?.m5 != null ? row.priceChangePct.m5 / 100
      : (row.priceChangePct?.h1 != null ? row.priceChangePct.h1 / 100 : null),
    liq: row.liquidityUsd ?? null,
    vol: row.volume24hUsd ?? null,
    adj: row.volume5mUsd ?? null,
    buyers: row.traders5m?.buyers ?? row.txns5m?.buys ?? null,
    nf: row.flow?.netUsd ?? null,
    wash,
    canonical: Boolean(row.crossSource && row.crossSource.sourcesAgreeing > 1),
    reasons,
    flags,
    oracle: null,
    reason: row.topReason || '—',
    spark,
    poolAddress: row.poolAddress,
    tokenAddress: row.tokenAddress,
    rawServerRow: row,
  };
}

/* ------------------------------------------------------------- the board - */

/**
 * The live board: fetch raw rows per chain, normalize, screen, score, and map
 * into the UI's asset model.
 */
export async function fetchLiveMarketData(chains = chainKeys) {
  try {
    const perChain = await Promise.allSettled(chains.map(async (chainKey) => {
      const feed = await fetchJson(`${BASE_URL}/api/market?chain=${chainKey}&feed=trending&limit=20`);
      if (!feed || !Array.isArray(feed.rows) || !feed.rows.length) return [];

      const raw = await rawInputsFor(chainKey);
      const normalized = feed.rows.map((r) => normalizeRow(r, feed.fetchedAt));
      const screened = screenRows(normalized, {});

      // One reference lookup per quote symbol, not per row.
      const quoteSymbols = [...new Set(screened.rows.map((r) => r.quoteSymbol).filter(Boolean))];
      const references = new Map();
      await Promise.all(quoteSymbols.map(async (sym) => {
        references.set(sym, await referenceFor(sym));
      }));

      const scoredRows = screened.rows.map((row) => {
        // One evaluation per token, owned by calculations/asset-detail.js.
        // The board renders what comes back; it decides nothing itself.
        const full = evaluateAsset(row, {
          samples: raw.samples,
          walletSets: raw.walletSets,
          // Whatever intel we already hold for this token, so the table and the
          // detail page are always looking at the same number.
          intel: intelFor(chainKey, row),
          reference: references.get(row.quoteSymbol) || null,
        });
        // Remember what we scored it at, so Evaluation can grade it later.
        recordScore(chainKey, row.tokenAddress, {
          score: full.score, stage: full.stage,
          flags: (full.riskFlags || []).map((f) => f.code),
        });
        // The 5m-volume series doubles as the board's sparkline.
        full.spark = ((raw.samples && raw.samples[row.poolAddress]) || [])
          .slice(-16).map((s) => s.volume5mUsd).filter((v) => Number.isFinite(v));
        return full;
      });

      // Fill in the missing intel for next time. Deliberately not awaited.
      enrichInBackground(chainKey, scoredRows);
      return scoredRows;
    }));

    const allRows = [];
    perChain.forEach((res) => {
      if (res.status === 'fulfilled' && res.value.length) allRows.push(...res.value);
    });

    persistDerived();
    if (allRows.length) return allRows.map(mapServerRowToAsset);
  } catch (e) {
    console.warn('Data server unavailable:', e);
  }
  return null;
}

/** Board-level totals, computed from the same scored rows the table shows. */
export function summarizeAssets(assets) {
  return summarize((assets || []).map((a) => a.rawServerRow).filter(Boolean));
}

/* --------------------------------------------------------------- detail -- */

/**
 * Asset Detail: fetch this token's raw provider data and derive the facts the
 * detail panels show - safety checks, holders, routed impact, cross-price.
 *
 * It deliberately does NOT score. There is exactly one scorer in this app -
 * the pipeline in fetchLiveMarketData - and it runs every poll with whatever
 * intel is cached. If this view scored as well, the two would be snapshots of
 * a moving input taken seconds apart, and the same token would show two
 * different numbers in two places.
 *
 * Instead the intel fetched here lands in the cache, and the next poll (within
 * 5s) folds it into the one score that both views read.
 */
export async function fetchLiveTokenIntel(chain, tokenAddress, poolAddress = '', row = null) {
  try {
    const rawIntel = cachedIntelRaw(chain, tokenAddress) || await fetchJson(
      `${BASE_URL}/api/intel?chain=${chain}&token=${encodeURIComponent(tokenAddress)}`);
    if (!rawIntel || rawIntel.server !== 'ok') return null;
    putIntelRaw(chain, tokenAddress, rawIntel);

    // Opening a detail view is also the cue to sample this pool's trades, even
    // if the rotation cursor has not reached it.
    if (poolAddress) {
      await quiet(fetchJson(
        `${BASE_URL}/api/trades?chain=${chain}&pool=${encodeURIComponent(poolAddress)}`), null);
      rawCache.delete(chain);
    }

    const intel = deriveIntel(rawIntel, row);
    if (!row) return { ...intel, scored: null };

    // Supporting evidence for the detail panels (the z column, rotation text).
    // Not a score - see the note above.
    const raw = await rawInputsFor(chain);
    const poolSamples = (raw.samples && raw.samples[row.poolAddress]) || [];
    const own = raw.walletSets.get(row.poolAddress);
    const fromSamples = zScoresFrom(poolSamples);

    return {
      ...intel,
      zScores: Object.keys(fromSamples.metrics).length
        ? fromSamples
        : (own ? bucketBaselines(own.trades || []) : fromSamples),
      tradeStats: own ? own.stats : null,
      rotation: rotationFor(raw.walletSets, row.poolAddress),
      scored: null,
    };
  } catch (e) {
    return null;
  }
}

export async function fetchLiveOhlcv(chain, poolAddress, timeframe = 'minute', aggregate = 1, limit = 60) {
  try {
    const data = await fetchJson(
      `${BASE_URL}/api/ohlcv?chain=${chain}&pool=${encodeURIComponent(poolAddress)}` +
      `&timeframe=${timeframe}&aggregate=${aggregate}&limit=${limit}`);
    if (data && Array.isArray(data.bars)) {
      return { bars: data.bars, reason: data.reason || null, retryAfterMs: data.retryAfterMs || null };
    }
  } catch (e) { /* fall through */ }
  return { bars: [], reason: 'unreachable', retryAfterMs: null };
}

/* ----------------------------------------------------------- other tabs -- */

export async function fetchLiveRotationData(chain = 'solana') {
  try {
    const raw = await rawInputsFor(chain);
    if (!raw.walletSets.size) return null;
    return { server: 'ok', chain, ...rotationGraph(raw.walletSets) };
  } catch (e) { return null; }
}

/**
 * The wallet read on ONE token.
 *
 * This tab used to fetch `/api/trades?chain=...` with no pool and aggregate
 * every wallet across whichever pools the server's warm loop had happened to
 * sample - so it answered "who is trading on Solana", not "who is trading the
 * token on screen". It ignored the selection entirely.
 *
 * Now the selected pool is sampled explicitly (which also pushes it into the
 * server's trade memory, so the chain-wide set picks it up on the next poll),
 * and three sources are joined:
 *
 *   trades for this pool  -> who is buying and selling it right now
 *   chain-wide trade sets -> which of them also trade other pools
 *   intel (GoPlus)        -> which of them are top holders of it
 */
export async function fetchLiveWalletData(chain = 'solana', asset = null, tracked = []) {
  try {
    const row = (asset && asset.rawServerRow) || null;
    const poolAddress = (asset && asset.poolAddress) || (row && row.poolAddress) || null;
    const tokenAddress = (asset && asset.tokenAddress) || (row && row.tokenAddress) || null;
    if (!poolAddress) return null;

    const symbol = String(
      (row && row.symbol) || (asset && asset.sym) || '',
    ).replace(/^\$/, '');

    // Ask the server to sample THIS pool. GeckoTerminal rate-limits that call
    // often enough that it cannot be the only path to a reading: if it fails,
    // the chain-wide response below may still carry a sample the warm loop
    // took earlier. A slightly old window is worth far more than an empty tab,
    // so the failure is tolerated here and reported as `stale` instead.
    const sampled = await quiet(fetchJson(
      `${BASE_URL}/api/trades?chain=${chain}&pool=${encodeURIComponent(poolAddress)}` +
      (symbol ? `&symbol=${encodeURIComponent(symbol)}` : '')), null);

    // The pool may now be in the server's memory, so the chain-wide set that
    // the cross-pool columns read from should be refetched to include it.
    if (sampled && sampled.server === 'ok') rawCache.delete(chain);
    const raw = await quiet(rawInputsFor(chain), { walletSets: new Map(), tradePools: [] });

    const direct = sampled && sampled.server === 'ok'
      ? (sampled.pools || []).find((p) => p.poolAddress === poolAddress) || null
      : null;
    const remembered = (raw.tradePools || []).find((p) => p.poolAddress === poolAddress) || null;
    const pool = direct || remembered;
    const trades = (pool && pool.trades) || [];
    if (!trades.length) return null;

    // Top holders come from intel, which is already cached per token for the
    // score. Only fetch it if nothing has yet.
    let topHolders = [];
    if (tokenAddress) {
      let rawIntel = cachedIntelRaw(chain, tokenAddress);
      if (!rawIntel) {
        rawIntel = await quiet(fetchJson(
          `${BASE_URL}/api/intel?chain=${chain}&token=${encodeURIComponent(tokenAddress)}`), null);
        if (rawIntel && rawIntel.server === 'ok') putIntelRaw(chain, tokenAddress, rawIntel);
      }
      topHolders = (rawIntel && rawIntel.goplus && rawIntel.goplus.holders) || [];
    }

    return {
      server: 'ok',
      chain,
      symbol: symbol || null,
      tokenAddress,
      sampledAt: (pool && pool.at) || Date.now(),
      stale: !direct,
      holdersAvailable: Boolean(topHolders.length),
      ...tokenWalletIntel({
        trades,
        poolAddress,
        walletSets: raw.walletSets || new Map(),
        topHolders,
        tracked,
      }),
    };
  } catch (e) { return null; }
}

// Mention counts per symbol, kept in memory so a baseline can build up over a
// session. Short-lived by design: the board itself is the long-term record.
const mentionHistory = new Map();

export async function fetchLiveSocialData(chain = 'solana', asset = null) {
  try {
    const data = await fetchJson(`${BASE_URL}/api/social?chain=${chain}`);
    if (!data || data.server !== 'ok') return null;

    const posts = data.posts || [];
    const promotion = (data.promotion && data.promotion.rows) || [];
    const row = (asset && asset.rawServerRow) || {};
    // The board model carries the ticker as `sym`, with a leading $; only the
    // raw server row calls it `symbol`. Reading `asset.symbol` found neither,
    // so any asset without a rawServerRow measured nothing at all.
    const symbol = row.symbol ||
      (asset && asset.sym ? String(asset.sym).replace(/^\$/, '') : null) ||
      null;

    const sources = (data.sources || []).map((x) => ({
      source: x.source,
      label: x.label,
      url: x.url || null,
      ok: x.ok,
      error: x.error,
      posts: x.posts,
    }));

    const base = {
      server: 'ok',
      chain,
      symbol,
      scanned: posts.length,
      sources,
      absent: data.absent,
      counts: {
        boosts: promotion.filter((p) => p.kind === 'BOOST').length,
        profiles: promotion.filter((p) => p.kind === 'PROFILE').length,
      },
    };

    if (!symbol) return Object.assign(base, { mention: null, promo: null, baseline: null });

    const mention = mentionsFor(posts, symbol);

    // The baseline is this browser's own record of how often the token was
    // named on previous refreshes. The server keeps no such history, so a
    // freshly opened tab legitimately has no baseline yet and says so.
    const key = chain + ':' + symbol;
    const series = mentionHistory.get(key) || [];
    const last = series[series.length - 1];
    if (mention.countable && (!last || Date.now() - last.t > 60000)) {
      series.push({ t: Date.now(), n: mention.mentions });
      if (series.length > 120) series.shift();
      mentionHistory.set(key, series);
    }

    const address = String(row.tokenAddress || '').toLowerCase();
    const promo = promotion.find((p) => String(p.tokenAddress || '').toLowerCase() === address) || null;

    return Object.assign(base, {
      tokenAddress: row.tokenAddress || null,
      mention,
      promo,
      boosted: Boolean(promo),
      baseline: mentionBaseline(series, mention.mentions),
    });
  } catch (e) { return null; }
}

/**
 * Evaluation joins two series: the server's raw prices, and this browser's
 * own record of what it scored. Both are needed - the server does not know
 * the scores, and the app does not keep prices for 24 hours.
 */
export async function fetchLiveEvalData(chain = 'solana', horizonMs = 3600000) {
  try {
    const data = await fetchJson(`${BASE_URL}/api/observations?chain=${chain}`);
    if (!data || data.server !== 'ok') return null;
    const observations = data.tokens || {};
    const journal = journalFor(chain);
    return {
      server: 'ok',
      chain,
      ...evaluationFor(observations, journal, horizonMs),
      report: evaluationReport(observations, journal),
    };
  } catch (e) { return null; }
}

export async function fetchLiveSystemData() {
  try {
    const data = await fetchJson(`${BASE_URL}/api/system`);
    if (!data || data.server !== 'ok') return null;
    return { ...data, providers: providerHealth(data.upstream) };
  } catch (e) { return null; }
}

export async function fetchAdminStore({ collection, token, probe } = {}) {
  try {
    const params = new URLSearchParams();
    if (collection) params.set('collection', collection);
    if (token) params.set('token', token);
    if (probe) params.set('probe', '1');
    params.set('limit', '25');
    const data = await fetchJson(`${BASE_URL}/api/admin/store?${params.toString()}`);
    if (data && data.server === 'ok') return data;
  } catch (e) { /* fall through */ }
  return null;
}

/**
 * The field catalogue. It used to be served by the server; the equations live
 * in the app now, so it is built here from the live SCORE_MODEL.
 */
export async function fetchCatalog() {
  return catalogPayload(SCORE_MODEL);
}

export const API_ORIGIN = BASE_URL;
