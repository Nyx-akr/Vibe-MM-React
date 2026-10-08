/**
 * VibeScreener data service.
 *
 * Two jobs, in this order:
 *   1. read RAW provider data out of the raw store - files the server's
 *      collectors write (storage/raw-store.js). Nothing here calls the server:
 *      it has no API, and nothing the app does can make it fetch or compute.
 *   2. run those raw numbers through src/calculations to produce everything
 *      the UI shows.
 *
 * What the app computes - scores, stages, the score journal - stays in the app
 * store (storage/history-store.js). None of it is written back to the server.
 *
 * If you are looking for where a score, stage, z-score or risk flag comes
 * from, it is in src/calculations - not here, and not on the server.
 */

import { chainKeys, chainKeyToName } from '../data/chains';
import { getInput, setInput } from './storage/input-store';
import { readRaw, readRawQuiet, setRawOrigin, probeRawStore, ageOf } from './storage/raw-store';
import { payload as catalogPayload } from '../data/catalog';
import {
  normalizeRow, screenRows, zScoresFrom, bucketBaselines,
  buildWalletSets, rotationFor, rotationGraph, tokenWalletIntel,
  scoreOutcomes, median,
  providerHealth, summarize,
} from '../calculations/core';
import {
  evaluateAsset, deriveIntel, usdReferenceMedian,
  SCORE_MODEL, hydrateStages, stageSnapshot,
  hydrateScoreHistory, scoreHistorySnapshot,
} from '../calculations/asset-detail';
import {
  recordScore, journalFor, flushJournal, pruneJournal,
  loadStageMemory, saveStageMemory, loadScoreWindow, saveScoreWindow,
} from './score-journal';
import { walletIntelForPool } from './wallet-intel';
import { ethosFor } from './ethos-intel';
import { sharedOrigin } from './shared-origin';
import { recordTrail, flushTrail, readTrail } from './score-trail';

// Where the raw store is served. Vercel serves this app as static files, so a
// deployed build needs an absolute origin. Override with VITE_API_BASE.
const REMOTE_BASE = (import.meta.env.VITE_API_BASE || 'https://vibe-mm-server.onrender.com')
  .replace(/\/+$/, '');
const LOCAL_BASE = (import.meta.env.VITE_LOCAL_API_BASE || 'http://localhost:8787')
  .replace(/\/+$/, '');

// Live binding: importers see the value initApiBase() settles on.
let BASE_URL = REMOTE_BASE;
export let API_ORIGIN = REMOTE_BASE;
setRawOrigin(REMOTE_BASE);

/** Both stores this app can read from, for anything that offers the choice. */
export const API_BASES = { local: LOCAL_BASE, remote: REMOTE_BASE };

/*
 * Which store to read from, as a preference rather than a fact:
 *
 *   'auto'   - probe in dev, deployed in production (the behaviour below)
 *   'local'  - pinned to LOCAL_BASE by a human, in any build
 *   'remote' - pinned to REMOTE_BASE by a human, in any build
 *
 * The admin panel's switch writes this, and it survives a reload.
 */
let target = readTarget();

function readTarget() {
  const saved = getInput('apiTarget');
  return saved === 'local' || saved === 'remote' ? saved : 'auto';
}

function apply(base) {
  BASE_URL = base;
  API_ORIGIN = base;
  setRawOrigin(base);
  return base;
}

/**
 * Is OUR raw store being served on LOCAL_BASE right now?
 *
 * A 200 is not enough - Vite answers any path with index.html. Only our own
 * manifest counts.
 *
 * Never asked on a shared link: there localhost is the VISITOR'S machine, so
 * the answer means nothing, and the attempt makes Chrome ask them to let
 * marketmonitor.site "access other apps and services on this device".
 */
export async function probeLocalApi() {
  if (sharedOrigin()) return false;
  return probeRawStore(LOCAL_BASE);
}

/**
 * Settle on a store. Call once, before the first read; safe to call again.
 *
 * A pinned target wins outright. Otherwise, in DEV ONLY, prefer a local store
 * when one is being served. Auto-probing is not done in production: on Vercel
 * the probe would run on the VISITOR'S machine, where localhost is their
 * computer, never the collector.
 */
export async function initApiBase() {
  if (target === 'local') return apply(LOCAL_BASE);
  if (target === 'remote') return apply(REMOTE_BASE);

  // Someone else's view of a shared link: the collector serves the app, so the
  // store is the origin this page came from. Probed, not assumed - an app
  // served from anywhere that is not also the collector falls through to the
  // usual choice rather than reading /raw off a host that has none. The probe
  // gets far longer than the localhost one: through a tunnel the first fetch
  // pays a TLS handshake and a round trip abroad, and ngrok's free tier
  // regularly passes 1.5s on a cold page load.
  const shared = sharedOrigin();
  if (shared && await probeRawStore(shared, 10000)) return apply(shared);

  if (!import.meta.env.DEV) return apply(REMOTE_BASE);
  return apply((await probeLocalApi()) ? LOCAL_BASE : REMOTE_BASE);
}

/** Pin the app to one store, or hand it back to the probe with 'auto'. */
export async function setApiTarget(next) {
  target = next === 'local' || next === 'remote' ? next : 'auto';
  // 'auto' is the absence of a preference, so it is stored as nothing.
  setInput('apiTarget', target === 'auto' ? null : target);
  return initApiBase();
}

/** The preference, which is not the same question as which base is in force. */
export const apiTarget = () => target;

/** Which store the app settled on, for anything that wants to say so. */
export const usingLocalApi = () => BASE_URL === LOCAL_BASE;

/* ---------------------------------------------------------- stage memory - */

/**
 * Puts the stage machine's memory and the rolling score window back.
 *
 * Both live in the history store, which hydrates ASYNCHRONOUSLY. This used to
 * run at module load - before hydration - so it always read nothing, and the
 * first save then overwrote the stored window with an empty one: every reload
 * threw away the settled averages and the board re-settled from scratch for
 * 15 minutes. It must run after historyStore.hydrate() and before the first
 * score is computed; App does exactly that.
 */
export function restoreDerived() {
  hydrateStages(loadStageMemory());
  hydrateScoreHistory(loadScoreWindow());
  restored = true;
}
let restored = false;

let lastPersistAt = 0;
function persistDerived() {
  // Saving before the restore would write an empty window over the real one.
  if (!restored) return;
  const now = Date.now();
  if (now - lastPersistAt < 30000) return;
  lastPersistAt = now;
  pruneJournal();
  flushJournal();
  flushTrail();
  saveStageMemory(stageSnapshot());
  saveScoreWindow(scoreHistorySnapshot());
}

/* ------------------------------------------------------------ raw inputs -- */

/**
 * Per-chain raw inputs the score needs beyond the feed: the rolling sample
 * series and the trade samples.
 *
 * Reading the files is cheap (an unchanged file is not even parsed), but
 * reducing trades into wallet sets is not, so the reduction is kept until
 * either file actually changes.
 */
const rawCache = new Map();

async function rawInputsFor(chainKey) {
  const [history, trades] = await Promise.all([
    readRawQuiet(chainKey + '/history.json', { samples: {} }),
    readRawQuiet(chainKey + '/trades.json', { pools: [] }),
  ]);
  const hit = rawCache.get(chainKey);
  if (hit && hit.history === history && hit.trades === trades) return hit.value;
  const value = {
    samples: history.samples || {},
    walletSets: buildWalletSets(trades.pools || []),
    // The raw trades are kept alongside the aggregate, because buildWalletSets
    // reduces each pool to wallet -> usd and drops the buy/sell flag and the
    // timestamps. WALLETS needs those.
    tradePools: trades.pools || [],
    tradesWrittenAt: trades.writtenAt || null,
  };
  rawCache.set(chainKey, { history, trades, value });
  return value;
}

/**
 * Intel - the reason a token has ONE score.
 *
 * Contract safety, holders and routed impact are ~7 provider calls per token.
 * The collector pre-fetches them for every board token on a slow rotation and
 * writes them to <chain>/intel.json; the board and the detail view both read
 * that one file, so they always score on the same inputs. A token's score
 * improves once - when its intel first lands - and is identical everywhere
 * after that.
 *
 * The RAW payload is stored rather than derived facts, because deriving depends
 * on the row (price cross-check, volume per holder) and the row moves.
 */
async function intelTokensFor(chainKey) {
  const file = await readRawQuiet(chainKey + '/intel.json', null);
  return (file && file.tokens) || {};
}

/** Intel for a row if the collector has reached it, derived against that row. */
function intelFor(intelTokens, row) {
  const raw = row.tokenAddress && intelTokens[row.tokenAddress];
  return raw ? deriveIntel(raw, row) : null;
}

/** How much of the board is scored on the full input set. */
export function intelCoverage(assets) {
  const rows = assets || [];
  const withIntel = rows.filter((a) => a.scoreBasis === 'intel').length;
  return { total: rows.length, withIntel, pct: rows.length ? Math.round((withIntel / rows.length) * 100) : 0 };
}

/** Reference quotes, for the USD-reference component. Slow-moving. */
async function referencesFor() {
  const file = await readRawQuiet('reference.json', null, { maxAgeMs: 30000 });
  return (file && file.symbols) || {};
}

function referenceFor(symbols, symbol) {
  if (!symbol) return null;
  const key = String(symbol).toUpperCase();
  const data = symbols[key];
  return data && data.quotes && data.quotes.length
    ? usdReferenceMedian(Object.assign({ symbol: key }, data))
    : null;
}

/**
 * Perp venue listings (one file for every chain) and DexScreener's paid boosts
 * and profiles (one per chain), for the listing components. Both move slowly:
 * venues every 30 min, promotion every 2 min.
 */
async function perpsFile() {
  return readRawQuiet('perps.json', null, { maxAgeMs: 60000 });
}

async function promotionFor(chainKey) {
  const file = await readRawQuiet(chainKey + '/promotion.json', null, { maxAgeMs: 30000 });
  const by = new Map();
  ((file && file.rows) || []).forEach((r) => {
    const key = String(r.tokenAddress || '').toLowerCase();
    if (!by.has(key)) by.set(key, []);
    by.get(key).push({ kind: r.kind, totalAmount: r.totalAmount ?? null });
  });
  return by;
}

/** This row's listing inputs: which venues list its ticker, and its paid promotion. */
function listingFor(perps, promotion, row) {
  let perp = null;
  if (perps && perps.venues) {
    const labels = {};
    Object.keys(perps.venues).forEach((k) => { labels[k] = perps.venues[k].label || k; });
    const symbol = String(row.symbol || '').toUpperCase();
    perp = {
      symbol,
      listedOn: (perps.symbols || {})[symbol] || [],
      checked: perps.venuesReachable || 0,
      total: perps.venuesTotal || 0,
      labels,
      unreachable: Object.keys(perps.venues).filter((k) => !perps.venues[k].ok).map((k) => labels[k]),
    };
  }
  return { perp, promotion: promotion.get(String(row.tokenAddress || '').toLowerCase()) || [] };
}

/* ------------------------------------------------------------ the score -- */

/*
 * There is no scoring in this file.
 *
 * evaluateAsset() in calculations/asset-detail.js is the one place a token is
 * evaluated. This module's job is to read raw numbers, hand them to it, and
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
    // The wallets module's verdict, carried through as computed. The WALLETS
    // tab renders this rather than recomputing, which is what guarantees the
    // number it shows is the number the score used.
    walletQuality: row.walletQuality || null,
    // Same deal for organic flow: the verdict travels with the row, so the
    // board tile, the detail tiles and the risk flag are all reading one
    // object rather than three re-derivations of it.
    organicFlow: row.organicFlow || null,
    rawServerRow: row,
  };
}

/* ------------------------------------------------------------- the board - */

/** Rows the board shows per chain. The collector writes a few more. */
const BOARD_ROWS = 20;

/**
 * How fresh the files behind the last board read were. The collector writes
 * market.json every few seconds, so an old file means it has stopped - which
 * the UI must say, rather than showing old prices as if they were live.
 */
let freshness = { newestWrittenAt: null, oldestWrittenAt: null, chains: 0, readAt: null };
export const storeFreshness = () => freshness;

/**
 * A token the scorer threw on. Logged once per token and message, so a bad row
 * is visible in the console without repeating every 5s poll.
 */
const scoreErrorsSeen = new Set();
function reportScoreError(chainKey, row, error) {
  const key = chainKey + ':' + (row && row.tokenAddress) + ':' + (error && error.message);
  if (scoreErrorsSeen.has(key)) return;
  scoreErrorsSeen.add(key);
  console.error('score failed for ' + chainKey + ' ' + ((row && row.symbol) || '?') +
    ' - row skipped, chain kept:', error);
}

/**
 * The live board: read raw rows per chain, normalize, screen, score, and map
 * into the UI's asset model.
 */
export async function fetchLiveMarketData(chains = chainKeys) {
  try {
    const [references, perps] = await Promise.all([referencesFor(), perpsFile()]);
    const stamps = [];
    const perChain = await Promise.allSettled(chains.map(async (chainKey) => {
      const feed = await readRaw(chainKey + '/market.json');
      if (!feed || !Array.isArray(feed.rows) || !feed.rows.length) return [];
      if (Number.isFinite(feed.writtenAt)) stamps.push(feed.writtenAt);

      const [raw, intelTokens, promotion] = await Promise.all([
        rawInputsFor(chainKey), intelTokensFor(chainKey), promotionFor(chainKey)]);
      const normalized = feed.rows.slice(0, BOARD_ROWS).map((r) => normalizeRow(r, feed.fetchedAt));
      const screened = screenRows(normalized, {});

      const scoredRows = screened.rows.map((row) => {
        // One token that the scorer cannot handle must cost that token, not
        // its chain: a throw here used to reject the whole chain's batch, and
        // seven chains vanished from the board over one null holder count.
        try { return scoreRow(row); } catch (error) {
          reportScoreError(chainKey, row, error);
          return null;
        }
      }).filter(Boolean);
      return scoredRows;

      function scoreRow(row) {
        // One evaluation per token, owned by calculations/asset-detail.js.
        // The board renders what comes back; it decides nothing itself.
        const full = evaluateAsset(row, {
          samples: raw.samples,
          walletSets: raw.walletSets,
          // The same intel file the detail page reads, so the table and the
          // detail page are always looking at the same number.
          intel: intelFor(intelTokens, row),
          reference: referenceFor(references, row.quoteSymbol),
          // The behavioural wallet read, from the background service that is
          // already analysing every sampled pool - taken from its store rather
          // than recomputed, so the score and the WALLETS tab describe the
          // same sample. Null for a pool the rotation has not reached yet.
          walletIntel: walletIntelForPool(row.poolAddress),
          // Reputation of the X account this token advertises. It raises a
          // flag and never a penalty - see assessRisk() - so the score stays
          // the one number it already was.
          ethos: ethosFor(chainKey, row.tokenAddress),
          // Perp venues and paid promotion, for the listing components.
          listing: listingFor(perps, promotion, row),
        });
        // Remember what we scored it at, so Evaluation can grade it later.
        // This lives in the app store only - it never goes to the server.
        recordScore(chainKey, row.tokenAddress, {
          score: full.score, stage: full.stage,
          flags: (full.riskFlags || []).map((f) => f.code),
        });
        // And every component beside it, for the price chart's score overlay
        // and for judging the model later. Its own store - see score-trail.js.
        recordTrail(chainKey, row.tokenAddress, full);
        // The 5m-volume series doubles as the board's sparkline.
        full.spark = ((raw.samples && raw.samples[row.poolAddress]) || [])
          .slice(-16).map((s) => s.volume5mUsd).filter((v) => Number.isFinite(v));
        return full;
      }
    }));

    const allRows = [];
    perChain.forEach((res) => {
      if (res.status === 'fulfilled' && res.value.length) allRows.push(...res.value);
    });
    freshness = {
      newestWrittenAt: stamps.length ? Math.max(...stamps) : null,
      oldestWrittenAt: stamps.length ? Math.min(...stamps) : null,
      chains: stamps.length,
      readAt: Date.now(),
    };

    persistDerived();
    if (allRows.length) return allRows.map(mapServerRowToAsset);
  } catch (e) {
    console.warn('Raw store unavailable:', e);
  }
  return null;
}

/** Board-level totals, computed from the same scored rows the table shows. */
export function summarizeAssets(assets) {
  return summarize((assets || []).map((a) => a.rawServerRow).filter(Boolean));
}

/* --------------------------------------------------------------- detail -- */

/**
 * Asset Detail: this token's raw provider payload, and the facts the detail
 * panels derive from it - safety checks, holders, routed impact, cross-price.
 *
 * It deliberately does NOT score. There is exactly one scorer in this app - the
 * pipeline in fetchLiveMarketData - and it reads the same intel file, so both
 * views always show the same number.
 *
 * Null means the collector has not reached this token yet; it pre-fetches
 * every board token, so that is a matter of minutes.
 */
export async function fetchLiveTokenIntel(chain, tokenAddress, poolAddress = '', row = null) {
  try {
    const rawIntel = (await intelTokensFor(chain))[tokenAddress];
    if (!rawIntel) return null;

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

/**
 * One-minute bars built from the collector's own 15s price samples. Every
 * value is a price that was actually read - first, highest, lowest and last in
 * that minute - never an interpolation.
 */
function barsFromSamples(samples, afterT) {
  const byMinute = new Map();
  (samples || []).forEach((s) => {
    if (!s || !Number.isFinite(s.priceUsd) || !Number.isFinite(s.t) || s.t < afterT) return;
    const minute = Math.floor(s.t / 60000) * 60000;
    const bar = byMinute.get(minute);
    if (!bar) {
      byMinute.set(minute, { t: minute, o: s.priceUsd, h: s.priceUsd, l: s.priceUsd, c: s.priceUsd,
        v: Number.isFinite(s.volume5mUsd) ? s.volume5mUsd : null });
    } else {
      bar.h = Math.max(bar.h, s.priceUsd);
      bar.l = Math.min(bar.l, s.priceUsd);
      bar.c = s.priceUsd;
      if (Number.isFinite(s.volume5mUsd)) bar.v = s.volume5mUsd;
    }
  });
  return Array.from(byMinute.values()).sort((a, b) => a.t - b.t);
}

/**
 * Minute bars for one pool.
 *
 * The collector pulls GeckoTerminal bars for every board pool on a rotation,
 * so the stored set can be several minutes old. The minutes since its last bar
 * are filled from the 15s samples - so the chart always reaches now - and a
 * pool with no stored bars at all is drawn from samples alone.
 */
export async function fetchLiveOhlcv(chain, poolAddress, timeframe = 'minute', aggregate = 1, limit = 60) {
  try {
    const [file, raw] = await Promise.all([
      readRawQuiet(chain + '/ohlcv.json', null),
      rawInputsFor(chain),
    ]);
    const stored = (file && file.pools && file.pools[poolAddress]) || null;
    const storedBars = (stored && Array.isArray(stored.bars)) ? stored.bars : [];
    const samples = (raw.samples && raw.samples[poolAddress]) || [];
    const lastStored = storedBars.length ? storedBars[storedBars.length - 1].t : 0;
    const tail = barsFromSamples(samples, lastStored ? lastStored + 60000 : 0);
    const bars = storedBars.concat(tail).slice(-limit);

    if (storedBars.length > 1) {
      return { bars, reason: null, retryAfterMs: null, collectedAt: stored.at || null };
    }
    if (bars.length > 1) {
      return { bars, reason: 'local_history', retryAfterMs: null, collectedAt: null };
    }
    return {
      bars: [],
      reason: (stored && stored.reason) || 'not_collected',
      // The collector revisits the pool on its own rotation; look again soon.
      retryAfterMs: 20000,
      collectedAt: (stored && stored.at) || null,
    };
  } catch (e) { /* fall through */ }
  return { bars: [], reason: 'unreachable', retryAfterMs: 20000 };
}

/**
 * The chart's time ranges. Short ranges are minute bars (stored GeckoTerminal
 * bars, then our own 15s samples up to now); long ones are the collector's
 * 15-minute bars, kept for weeks in <chain>/bars15/<pool>.json.
 */
export const CHART_RANGES = {
  '1H': { ms: 3600000, source: 'minute' },
  '6H': { ms: 6 * 3600000, source: 'minute' },
  '24H': { ms: 24 * 3600000, source: 'bars15' },
  '7D': { ms: 7 * 24 * 3600000, source: 'bars15' },
};

/** Minute bars rolled up to 15 minutes, for the stretch after the last stored 15m bar. */
function rollup15(bars) {
  const out = new Map();
  bars.forEach((b) => {
    const t = Math.floor(b.t / 900000) * 900000;
    const r = out.get(t);
    if (!r) out.set(t, { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { r.h = Math.max(r.h, b.h); r.l = Math.min(r.l, b.l); r.c = b.c; if (Number.isFinite(b.v)) r.v = b.v; }
  });
  return [...out.values()].sort((a, b) => a.t - b.t);
}

/**
 * Price bars plus our score trail for one token over one range - what the
 * detail chart overlays. `interval` is the bar width, so the caption can say
 * what a candle is.
 */
export async function fetchChartHistory(chain, poolAddress, tokenAddress, rangeKey) {
  const range = CHART_RANGES[rangeKey] || CHART_RANGES['6H'];
  const since = Date.now() - range.ms;
  const trailP = tokenAddress
    ? readTrail(chain, tokenAddress, since).catch(() => ({ keys: [], marks: [] }))
    : Promise.resolve({ keys: [], marks: [] });

  let bars = [];
  let interval = '1-MIN';
  let reason = null;
  let firstBarAt = null;
  if (range.source === 'minute') {
    // Our 15s samples reach back 6h; GeckoTerminal's stored minute bars cover
    // the last hour or so. Real candles win wherever both exist.
    const [file, raw] = await Promise.all([
      readRawQuiet(chain + '/ohlcv.json', null),
      rawInputsFor(chain),
    ]);
    const stored = (file && file.pools && file.pools[poolAddress] && file.pools[poolAddress].bars) || [];
    const byT = new Map(barsFromSamples((raw.samples && raw.samples[poolAddress]) || [], since)
      .map((b) => [b.t, b]));
    stored.forEach((b) => { if (Number.isFinite(b.t)) byT.set(b.t, b); });
    bars = [...byT.values()].filter((b) => b.t >= since).sort((a, b) => a.t - b.t);
    reason = stored.length > 1 ? null : (bars.length > 1 ? 'local_history' : 'not_collected');
  } else {
    interval = '15-MIN';
    const [file, raw] = await Promise.all([
      readRawQuiet(chain + '/bars15/' + poolAddress + '.json', null),
      rawInputsFor(chain),
    ]);
    const stored = (file && Array.isArray(file.bars)) ? file.bars : [];
    firstBarAt = file ? file.firstBarAt : null;
    const lastT = stored.length ? stored[stored.length - 1].t : 0;
    // The collector refreshes a pool every 2h; the gap since is our own samples.
    const tail = rollup15(barsFromSamples((raw.samples && raw.samples[poolAddress]) || [],
      lastT ? lastT + 900000 : 0));
    bars = stored.concat(tail).filter((b) => b.t >= since);
    reason = stored.length ? null : (bars.length > 1 ? 'local_history' : 'not_collected');
  }
  const trail = await trailP;

  // The trail only started recording components on 2026-09-30, but the score
  // journal has kept the average score for 50h all along. Where the trail has
  // nothing yet, the journal's marks fill the Avg score line (components stay
  // empty there - they were never saved before the trail existed).
  if (tokenAddress) {
    const journalMarks = (journalFor(chain)[tokenAddress] || []).filter((m) => m.t >= since);
    const trailFrom = trail.marks.length ? trail.marks[0].t : Infinity;
    const older = journalMarks
      .filter((m) => m.t < trailFrom - 60000 && Number.isFinite(m.score))
      .map((m) => ({ t: m.t, avg: Math.round(m.score * 10) / 10, now: null, c: {}, fromJournal: true }));
    if (older.length) trail.marks = older.concat(trail.marks);
  }
  return { range: rangeKey, since, interval, bars, reason, firstBarAt, trail };
}

/* ----------------------------------------------------------- other tabs -- */

export async function fetchLiveRotationData(chain = 'solana') {
  try {
    const raw = await rawInputsFor(chain);
    if (!raw.walletSets.size) return null;
    return { server: 'ok', chain, ...rotationGraph(raw.walletSets) };
  } catch (e) { return null; }
}

/** A trade sample older than this is flagged, so the tab does not pass it off as now. */
const TRADES_STALE_MS = 10 * 60000;

/**
 * The wallet read on ONE token. Three sources, all from the raw store:
 *
 *   trades for this pool  -> who is buying and selling it
 *   chain-wide trade sets -> which of them also trade other pools
 *   intel (GoPlus)        -> which of them are top holders of it
 *
 * The collector samples every board pool on a rotation, so a freshly listed
 * pool may take a lap to appear; `stale` says when the sample is old.
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

    const raw = await rawInputsFor(chain);
    const pool = (raw.tradePools || []).find((p) => p.poolAddress === poolAddress) || null;
    const trades = (pool && pool.trades) || [];
    if (!trades.length) return null;

    const rawIntel = tokenAddress ? (await intelTokensFor(chain))[tokenAddress] : null;
    const topHolders = (rawIntel && rawIntel.goplus && rawIntel.goplus.holders) || [];
    const sampledAt = (pool && pool.at) || null;

    return {
      server: 'ok',
      chain,
      symbol: symbol || null,
      tokenAddress,
      sampledAt: sampledAt || Date.now(),
      stale: !sampledAt || Date.now() - sampledAt > TRADES_STALE_MS,
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

/**
 * What the archive recorded, per bucket. The collector measures it from the
 * log files - only that process can see them - and writes coverage.json; what
 * it MEANS for a score is decided in the app (precisionAtK, PRECISION@20).
 */
async function coverageFile() {
  return readRawQuiet('coverage.json', null, { maxAgeMs: 30000 });
}

export async function fetchCoverage({ chain } = {}) {
  const file = await coverageFile();
  const entry = file && file.byChain && chain ? file.byChain[chain] : null;
  return entry ? Object.assign({ server: 'ok', now: file.now }, entry) : null;
}

/** The day or week strip for SYSTEM HEALTH; whichever the window names. */
export async function fetchStorageTimeline({ windowMs = 86400000 } = {}) {
  const file = await coverageFile();
  if (!file) return null;
  const strip = windowMs > 86400000 ? file.week : file.day;
  return strip && strip.ok !== false
    ? Object.assign({ server: 'ok', ok: true, now: file.now }, strip)
    : null;
}

/**
 * The prices side of the 24h Precision@20 tile: 48h of observations, so the
 * oldest mark in the window still has a forward price to resolve against.
 *
 * The marks side is the app store's own journal (see App.refreshPrecision).
 * The server holds none - scores never leave the app - so a window this
 * browser was not open for has no marks, and the tile's coverage says so.
 */
export async function fetchPrecisionInputs({ chain, windowMs = 86400000, horizonMs = 86400000, k = 20 } = {}) {
  try {
    const [obs, coverage] = await Promise.all([
      readRawQuiet(chain + '/observations-48h.json', null, { maxAgeMs: 60000 }),
      fetchCoverage({ chain }),
    ]);
    if (!obs) return null;
    return {
      chain,
      observations: obs.tokens || {},
      source: obs.source || 'memory',
      writtenAt: obs.writtenAt || null,
      coverage,
      windowMs, horizonMs, k,
    };
  } catch (e) { return null; }
}

/**
 * The two price files the collector already writes, merged per token: the hot
 * window (60s, ~25h per token, straight from RAM) and the 48h file (read back
 * out of the on-disk archive). Either can hold samples the other lacks - the
 * archive lags RAM by a flush, RAM forgets what is older than its cap - so the
 * union is the most complete record of what prices actually did.
 */
export function mergeObservations(...sources) {
  const out = {};
  sources.forEach((tokens) => {
    Object.keys(tokens || {}).forEach((token) => {
      const rows = tokens[token];
      if (!Array.isArray(rows) || !rows.length) return;
      (out[token] || (out[token] = [])).push(...rows);
    });
  });
  Object.keys(out).forEach((token) => {
    const seen = new Set();
    out[token] = out[token]
      .filter((r) => r && Number.isFinite(r.t) && !seen.has(r.t) && seen.add(r.t))
      .sort((a, b) => a.t - b.t);
  });
  return out;
}

// The horizons the outcome report is measured at. Each needs a mark and a
// price one horizon apart, so the longer ones fill in as uptime accumulates.
export const OUTCOME_HORIZONS = [3600000, 6 * 3600000, 24 * 3600000];
// Resolving every pick is tens of thousands of lookups and the answer moves on
// the scale of the 15-minute slice, so the 5s poll reuses it for a minute.
const OUTCOME_TTL_MS = 60000;
let outcomeCache = null;

/**
 * OUTCOME TRACKING on the Asset Detail page: what this one token actually did
 * after we scored it.
 *
 * Runs the SAME scoreOutcomes() the Evaluation tab runs and keeps only this
 * token's rows. Re-deriving forward returns here would mean a second copy of
 * the maturity, tolerance and excess rules, and they would drift.
 *
 * EXCESS, not raw return, is the headline: memecoins move together, so "it
 * went up 12%" mostly measures the day. Excess is the return minus the median
 * of the board scored at the same moment - what the pick was worth over simply
 * being in the market.
 */
export async function fetchTokenOutcomes(chain = 'solana', tokenAddress = '') {
  if (!tokenAddress) return null;
  try {
    const [data, deep] = await Promise.all([
      readRaw(chain + '/observations.json'),
      readRawQuiet(chain + '/observations-48h.json', null, { maxAgeMs: 60000 }),
    ]);
    if (!data) return null;
    const merged = mergeObservations(deep && deep.tokens, data.tokens || {});
    const journal = journalFor(chain);

    const byHorizon = {};
    OUTCOME_HORIZONS.forEach((h) => {
      const report = scoreOutcomes(merged, journal, { horizonMs: h, keepPicksFor: tokenAddress });
      const rows = report.pickRows || [];
      // Several marks can have matured for one horizon; the median is the
      // steady read, and one lucky entry should not speak for the token.
      const excesses = rows.map((r) => r.excess).filter(Number.isFinite);
      const rets = rows.map((r) => r.ret).filter(Number.isFinite);
      byHorizon[h] = {
        horizonMs: h,
        resolved: rows.length,
        withBoard: excesses.length,
        excessPct: excesses.length ? median(excesses) : null,
        returnPct: rets.length ? median(rets) : null,
        mfePct: rows.length ? median(rows.map((r) => r.mfe).filter(Number.isFinite)) : null,
        maePct: rows.length ? median(rows.map((r) => r.mae).filter(Number.isFinite)) : null,
        rugged: rows.some((r) => r.rug),
        // Why there is no number, in the words the board report already uses.
        pending: report.pending,
        unresolved: report.unresolved,
      };
    });
    return { chain, tokenAddress, at: Date.now(), byHorizon, horizons: OUTCOME_HORIZONS };
  } catch (e) {
    return null;
  }
}

export async function fetchLiveEvalData(chain = 'solana') {
  try {
    const [data, deep] = await Promise.all([
      readRaw(chain + '/observations.json'),
      readRawQuiet(chain + '/observations-48h.json', null, { maxAgeMs: 60000 }),
    ]);
    if (!data) return null;
    const observations = data.tokens || {};
    const journal = journalFor(chain);

    let outcomes = outcomeCache && outcomeCache.chain === chain &&
      Date.now() - outcomeCache.at < OUTCOME_TTL_MS ? outcomeCache.value : null;
    if (!outcomes) {
      const merged = mergeObservations(deep && deep.tokens, observations);
      const byHorizon = {};
      OUTCOME_HORIZONS.forEach((h) => { byHorizon[h] = scoreOutcomes(merged, journal, { horizonMs: h }); });
      outcomes = {
        at: Date.now(), byHorizon,
        sources: {
          journalTokens: Object.keys(journal).length,
          journalMarks: Object.keys(journal).reduce((n, k) => n + journal[k].length, 0),
          priceTokens: Object.keys(merged).length,
          priceSamples: Object.keys(merged).reduce((n, k) => n + merged[k].length, 0),
          deepFile: !!deep,
        },
      };
      outcomeCache = { chain, at: outcomes.at, value: outcomes };
    }
    return {
      server: 'ok',
      chain,
      outcomes,
    };
  } catch (e) { return null; }
}

export async function fetchLiveSystemData() {
  try {
    const data = await readRaw('system.json');
    if (!data) return null;
    return { ...data, server: 'ok', writtenAgeMs: ageOf(data), providers: providerHealth(data.upstream) };
  } catch (e) { return null; }
}

/**
 * The admin payload, derived.
 *
 * The server reports raw counters and latency SAMPLES - it computes no
 * rates, no percentiles and no verdicts, exactly like every other endpoint.
 * So the per-minute rate, the median, and 'has this chain missed its turn'
 * are worked out here, from the same providerHealth() the SYSTEM HEALTH tab
 * reads. Two pages, one derivation.
 */
function deriveAdmin(data) {
  const now = data.now || Date.now();
  const upstream = data.upstream || null;

  const warm = data.warm ? Object.assign({}, data.warm, {
    state: Object.fromEntries(Object.entries(data.warm.state || {}).map(([chain, w]) => [
      chain,
      // Half a cycle of grace on top of the full round: a chain last
      // refreshed longer ago than that has missed its turn, which is the
      // thing worth seeing - an empty panel downstream has no other cause
      // that says so.
      Object.assign({}, w, { stale: !w.at || (now - w.at) > data.warm.fullCycleMs * 1.5 }),
    ])),
  }) : null;

  return Object.assign({}, data, {
    warm,
    providers: providerHealth(upstream),
    upstreamWindowSeconds: upstream && upstream.since
      ? Math.max(1, Math.round((now - upstream.since) / 1000)) : null,
  });
}

/**
 * The admin payload: the collector's system.json, derived.
 *
 * The probe, the full-log scan and the collection listings used to run when
 * the panel asked. Nothing asks the server anything now, so the collector runs
 * them on its own slow clocks (probe and listings every 5 min, scan hourly)
 * and writes the latest of each; `at` inside each says how old it is.
 */
export async function fetchAdminStore({ collection } = {}) {
  try {
    const data = await readRaw('system.json');
    if (!data) return null;
    const inspect = (data.inspect && collection && data.inspect[collection]) || null;
    return deriveAdmin(Object.assign({}, data, {
      server: 'ok',
      writtenAgeMs: ageOf(data),
      collection: collection || null,
      inspect: inspect && inspect.documents ? inspect : null,
      inspectError: (inspect && inspect.error) || null,
    }));
  } catch (e) { /* fall through */ }
  return null;
}

/**
 * The field catalogue. The equations live in the app, so it is built here
 * from the live SCORE_MODEL.
 */
export async function fetchCatalog() {
  return catalogPayload(SCORE_MODEL);
}

// API_ORIGIN is declared and kept current next to BASE_URL, above.
