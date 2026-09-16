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
  normalizeRow, screenRows, zScoresFrom, bucketBaselines, tradeStatsFrom,
  buildWalletSets, rotationFor, rotationGraph, walletRegistry,
  mentionsFor, mentionBaseline, evaluationFor, evaluationReport,
  providerHealth, summarize,
} from '../calculations/core';
import {
  scoreAsset, deriveIntel, topReasonFor, usdReferenceMedian,
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
  };
  rawCache.set(chainKey, { at: Date.now(), value });
  return value;
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

/**
 * Raw row in, scored row out.
 *
 * This is the single place the app decides what a token is worth. Everything
 * it needs beyond the row - baselines, trade stats, rotation, intel - is
 * passed in as `extras`, so the same function scores a board row and a detail
 * view identically.
 */
function scoreRow(row, { samples, walletSets, intel, reference }) {
  const poolSamples = (samples && samples[row.poolAddress]) || [];
  const fromSamples = zScoresFrom(poolSamples);

  const own = walletSets && walletSets.get(row.poolAddress);
  const tradeStats = own ? own.stats : null;

  // Our own 15s samples are the better baseline; the trade tape is the
  // fallback for pools too new to have accumulated any.
  const zScores = Object.keys(fromSamples.metrics).length
    ? fromSamples
    : (own ? bucketBaselines(own.trades || []) : fromSamples);

  const extras = {
    zScores,
    tradeStats,
    rotation: walletSets ? rotationFor(walletSets, row.poolAddress) : null,
    usdReference: reference || null,
    intel: intel || null,
    jupiter: row.jupiter || null,
  };

  const scored = scoreAsset(row, extras);
  return { scored, extras, zScores };
}

/** Everything the board row needs that is derived from the score. */
function decorate(row, scored, extras) {
  const organic = (scored.scoreModifiers || []).find((m) => m.key === 'organicFlow');
  const organicValue = organic && !organic.pending ? organic.value : null;
  const stats = extras.tradeStats;
  const jup5m = row.jupiter && row.jupiter.stats5m;

  return {
    ...row,
    ...scored,
    topReason: topReasonFor(row, extras),
    zScores: extras.zScores,
    tradeStats: stats,
    rotation: extras.rotation,
    scoreBasis: extras.intel ? 'intel' : 'market',
    volumeBaselineMultiple: extras.zScores.metrics.volume5mUsd
      ? extras.zScores.metrics.volume5mUsd.multiple : null,
    // Wash probability is the inverse of organic flow - a proxy, not a
    // wash-trading model, which is why it is named as a probability and not
    // as a verdict.
    flow: stats ? {
      source: 'geckoterminal',
      netUsd: stats.netUsd, buyUsd: stats.buyUsd, sellUsd: stats.sellUsd,
      distinctWallets: stats.distinctWallets, windowMinutes: stats.windowMinutes,
      organicFlow: organicValue,
      washRisk: organicValue === null ? null : 100 - organicValue,
    } : (jup5m ? {
      source: 'jupiter',
      netUsd: jup5m.netUsd, buyUsd: jup5m.buyUsd, sellUsd: jup5m.sellUsd,
      distinctWallets: jup5m.numTraders, windowMinutes: 5,
      organicSharePct: row.jupiter.stats24h ? row.jupiter.stats24h.organicSharePct : null,
      organicFlow: organicValue,
      washRisk: organicValue === null ? null : 100 - organicValue,
    } : null),
  };
}

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

      return screened.rows.map((row) => {
        const { scored, extras } = scoreRow(row, {
          samples: raw.samples,
          walletSets: raw.walletSets,
          intel: null,
          reference: references.get(row.quoteSymbol) || null,
        });
        const full = decorate(row, scored, extras);
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
 * Asset Detail: fetch this token's raw provider data, derive the facts from
 * it, and rescore with those facts included.
 *
 * The board scores without intel because fetching it for every row would be
 * far too many calls; the detail view has holder, safety and routed-impact
 * inputs the board lacks, so its score is the better one - same model, more
 * of it filled in.
 */
export async function fetchLiveTokenIntel(chain, tokenAddress, poolAddress = '', row = null) {
  try {
    const rawIntel = await fetchJson(
      `${BASE_URL}/api/intel?chain=${chain}&token=${encodeURIComponent(tokenAddress)}`);
    if (!rawIntel || rawIntel.server !== 'ok') return null;

    // Opening a detail view is also the cue to sample this pool's trades, even
    // if the rotation cursor has not reached it.
    if (poolAddress) {
      await quiet(fetchJson(
        `${BASE_URL}/api/trades?chain=${chain}&pool=${encodeURIComponent(poolAddress)}`), null);
      rawCache.delete(chain);
    }

    const intel = deriveIntel(rawIntel, row);
    if (!row) return { ...intel, scored: null };

    const raw = await rawInputsFor(chain);
    const { scored, extras } = scoreRow(row, {
      samples: raw.samples,
      walletSets: raw.walletSets,
      intel,
      reference: await referenceFor(row.quoteSymbol),
    });

    persistDerived();
    return {
      ...intel,
      zScores: extras.zScores,
      tradeStats: extras.tradeStats,
      rotation: extras.rotation,
      usdReference: extras.usdReference,
      scored: { ...scored, scoreBasis: 'intel' },
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

export async function fetchLiveWalletData(chain = 'solana', address = '') {
  try {
    const raw = await rawInputsFor(chain);
    if (!raw.walletSets.size) return null;
    return { server: 'ok', chain, ...walletRegistry(raw.walletSets, address) };
  } catch (e) { return null; }
}

// Mention counts per symbol, kept in memory so a baseline can build up over a
// session. Short-lived by design: the board itself is the long-term record.
const mentionHistory = new Map();

export async function fetchLiveSocialData(chain = 'solana', assets = []) {
  try {
    const data = await fetchJson(`${BASE_URL}/api/social?chain=${chain}`);
    if (!data || data.server !== 'ok') return null;

    const threads = (data.threads && data.threads.rows) || [];
    const promotion = (data.promotion && data.promotion.rows) || [];
    const boosted = new Set(promotion.map((p) => String(p.tokenAddress || '').toLowerCase()));

    const rows = (assets || []).map((a) => {
      const row = a.rawServerRow || {};
      const m = mentionsFor(threads, row.symbol);

      const key = chain + ':' + row.symbol;
      const series = mentionHistory.get(key) || [];
      const last = series[series.length - 1];
      if (m.countable && (!last || Date.now() - last.t > 60000)) {
        series.push({ t: Date.now(), n: m.mentions });
        if (series.length > 120) series.shift();
        mentionHistory.set(key, series);
      }
      const base = mentionBaseline(series, m.mentions);

      return {
        symbol: row.symbol, tokenAddress: row.tokenAddress,
        score: row.score, stage: row.stage,
        countable: m.countable, reason: m.reason || null,
        mentions: m.mentions, replies: m.replies,
        newestMs: m.newestMs || null, excerpt: m.excerpt || null,
        boosted: boosted.has(String(row.tokenAddress || '').toLowerCase()),
        baseline: base.baseline, vsBase: base.vsBase, z: base.z, baselineSamples: base.samples,
      };
    }).sort((x, y) => y.mentions - x.mentions || y.replies - x.replies);

    return {
      server: 'ok',
      chain,
      counts: {
        boosts: promotion.filter((p) => p.kind === 'BOOST').length,
        profiles: promotion.filter((p) => p.kind === 'PROFILE').length,
        matchedOnBoard: rows.filter((r) => r.boosted).length,
      },
      rows: promotion,
      social: {
        source: (data.threads && data.threads.source) || '4chan /biz/ public catalog',
        threadsScanned: threads.length,
        error: (data.threads && data.threads.error) || null,
        countable: rows.filter((r) => r.countable).length,
        withMentions: rows.filter((r) => r.mentions > 0).length,
        rows,
        absent: data.absent,
      },
    };
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
