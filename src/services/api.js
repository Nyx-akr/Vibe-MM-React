/**
 * VibeScreener API Service
 * Fetches real-time market, rotation, wallet, social, evaluation, intel, and OHLCV data
 * from the VibeScreener live server backend (the Vibe-mm-server repo, deployed
 * to Render).
 */

import { assetSeeds } from '../data/assets';
import { chainKeys, chainKeyToName } from '../data/chains';

// Vercel serves this app as static files with no backend, and Vite strips the
// dev-server proxy out of production builds, so API calls need an absolute URL
// to the VibeScreener server on Render. Override at build time with
// VITE_API_BASE (e.g. http://127.0.0.1:8787 to run against a local server).
const BASE_URL = (import.meta.env.VITE_API_BASE || 'https://vibe-mm-server.onrender.com')
  .replace(/\/+$/, '');

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/**
 * Maps a raw backend market row into the frontend Asset model schema.
 */
export function mapServerRowToAsset(row) {
  const stageMap = { WATCH: 1, EMERGING: 2, CONFIRMED: 3, EXCEPTIONAL: 4 };
  const stage = typeof row.stage === 'number' ? row.stage : (stageMap[row.stage] || 1);

  // One mapping, from data/chains.js. The old inline map folded arbitrum and
  // polygon into BASE, so those tokens were mislabelled in the table.
  const chainRaw = String(row.chain || 'solana').toLowerCase();
  const chain = chainKeyToName[chainRaw] || chainRaw.toUpperCase().slice(0, 4);

  let cls = 'TOKEN';
  const symUpper = String(row.symbol || '').toUpperCase();
  if (symUpper.includes('X') || chain === 'RHC' || (row.pairName && row.pairName.includes('USD'))) {
    cls = 'STOCK';
  } else if (symUpper.includes('QQQ') || symUpper.includes('ETF')) {
    cls = 'ETF';
  } else if ((row.poolAgeHours != null && row.poolAgeHours < 48) || symUpper.startsWith('$') || (row.flow && row.flow.washRisk > 25)) {
    cls = 'MEME';
  }

  // Null when the server ran no wash analysis. The old fallback derived a
  // percentage from the risk penalty, which reported a wash probability
  // nobody had measured.
  const wash = row.flow && row.flow.washRisk != null ? row.flow.washRisk / 100 : null;

  const reasons = (row.scoreModel || [])
    .filter(m => !m.pending && m.value !== null)
    .slice(0, 4)
    .map(m => ({
      code: m.key ? m.key.toUpperCase() : 'SIGNAL',
      win: '5M',
      text: m.evidence || `${m.label}: ${m.value}/100`,
      z: (m.value / 10).toFixed(1),
      ratio: (m.value / 20).toFixed(1)
    }));

  if (reasons.length === 0 && row.topReason) {
    reasons.push({ code: 'VOL_ANOM_5M', win: '5M', text: row.topReason, z: '4.2', ratio: '3.1' });
  }

  const flags = (row.riskFlags || []).map(f => ({
    sev: f.severity || 'LOW',
    text: f.detail || f.code
  }));

  // row.spark is the server's real 5m-volume history. Empty until it has
  // collected samples — an empty trend beats a made-up rising line.
  const spark = Array.isArray(row.spark) && row.spark.length > 1 ? row.spark : [];

  const oracle = (cls === 'STOCK' || cls === 'ETF') ? {
    feed: row.tokenAddress ? row.tokenAddress.slice(0, 6) + '…' + row.tokenAddress.slice(-4) : '0x8c2f…a41e',
    fresh: '4s',
    dev: row.crossSource && row.crossSource.priceDeltaPct != null ? Math.abs(row.crossSource.priceDeltaPct).toFixed(2) + '%' : '0.42%',
    seq: 'UP',
    mult: '1.0000',
    pend: '—',
    session: 'OPEN',
    corp: 'NONE'
  } : null;

  return {
    id: row.tokenAddress || row.poolAddress || (row.symbol ? row.symbol.toLowerCase() : String(Math.random())),
    sym: row.symbol ? (row.symbol.startsWith('$') ? row.symbol : '$' + row.symbol) : '$TOKEN',
    name: row.name || row.pairName || row.symbol || 'Asset',
    chain,
    cls,
    stage,
    score: row.score || 60,
    conf: row.dataQuality || 0.82,
    age: Math.round((row.poolAgeHours || 12) * 3600),
    price: row.priceUsd || 0.001,
    chg: row.priceChangePct && row.priceChangePct.m5 != null
      ? row.priceChangePct.m5 / 100
      : (row.priceChangePct && row.priceChangePct.h1 != null ? row.priceChangePct.h1 / 100 : 0.02),
    liq: row.liquidityUsd ?? null,
    vol: row.volume24hUsd ?? null,
    // Real 5m volume. Previously this was volume5mUsd × 12 — an hourly
    // extrapolation shown under a "5M" label.
    adj: row.volume5mUsd ?? null,
    buyers: row.traders5m?.buyers ?? row.txns5m?.buys ?? null,
    // Only DexScreener's USD-split flow can give this; null when absent.
    nf: row.flow?.netUsd ?? null,
    wash,
    canonical: Boolean(row.crossSource && row.crossSource.sourcesAgreeing > 1),
    reasons,
    flags,
    oracle,
    reason: row.topReason || 'Active volume + buyer growth',
    spark,
    poolAddress: row.poolAddress,
    tokenAddress: row.tokenAddress,
    rawServerRow: row
  };
}

/**
 * Fetches live market rows across active chains from backend.
 */
export async function fetchLiveMarketData(chains = chainKeys) {
  try {
    const results = await Promise.allSettled(
      // 20 is GeckoTerminal's page size, so this costs no extra upstream call.
      chains.map(chain => fetchJson(`${BASE_URL}/api/market?chain=${chain}&feed=trending&limit=20`))
    );

    const allRows = [];
    results.forEach(res => {
      if (res.status === 'fulfilled' && res.value && Array.isArray(res.value.rows) && res.value.rows.length > 0) {
        allRows.push(...res.value.rows);
      }
    });

    if (allRows.length > 0) {
      return allRows.map(mapServerRowToAsset);
    }
  } catch (e) {
    console.warn('Backend API unavailable, using local mock data engine:', e);
  }

  return null;
}

/**
 * Fetches live capital rotation data.
 */
export async function fetchLiveRotationData(chain = 'solana') {
  try {
    const data = await fetchJson(`${BASE_URL}/api/rotation?chain=${chain}`);
    if (data && data.server === 'ok') return data;
  } catch (e) {
    // Return null if server is down, fallback used
  }
  return null;
}

/**
 * Fetches live wallet registry data.
 */
export async function fetchLiveWalletData(chain = 'solana', address = '') {
  try {
    const url = `${BASE_URL}/api/wallets?chain=${chain}` + (address ? `&address=${encodeURIComponent(address)}` : '');
    const data = await fetchJson(url);
    if (data && data.server === 'ok') return data;
  } catch (e) {
  }
  return null;
}

/**
 * Fetches live social scanner chatter & mentions data.
 */
export async function fetchLiveSocialData(chain = 'solana') {
  try {
    const data = await fetchJson(`${BASE_URL}/api/social?chain=${chain}`);
    if (data && data.server === 'ok') return data;
  } catch (e) {
  }
  return null;
}

/**
 * Fetches live evaluation statistics and reports.
 */
export async function fetchLiveEvalData(chain = 'solana', horizonMs = 3600000) {
  try {
    const data = await fetchJson(`${BASE_URL}/api/evaluation?chain=${chain}&horizonMs=${horizonMs}`);
    if (data && data.server === 'ok') return data;
  } catch (e) {
  }
  return null;
}

/**
 * Fetches live system health and provider latency telemetry.
 */
export async function fetchLiveSystemData() {
  try {
    const data = await fetchJson(`${BASE_URL}/api/system`);
    if (data && data.server === 'ok') return data;
  } catch (e) {
  }
  return null;
}

/**
 * Fetches token intel (contract safety, holders, routed price impact) for Asset Detail.
 */
export async function fetchLiveTokenIntel(chain, tokenAddress, poolAddress = '') {
  try {
    const data = await fetchJson(`${BASE_URL}/api/intel?chain=${chain}&token=${encodeURIComponent(tokenAddress)}&pool=${encodeURIComponent(poolAddress)}`);
    if (data && data.server === 'ok') return data;
  } catch (e) {
  }
  return null;
}

/**
 * Fetches real OHLCV chart bars for an asset pool.
 */
export async function fetchLiveOhlcv(chain, poolAddress, timeframe = 'minute', aggregate = 1, limit = 60) {
  try {
    const data = await fetchJson(`${BASE_URL}/api/ohlcv?chain=${chain}&pool=${encodeURIComponent(poolAddress)}&timeframe=${timeframe}&aggregate=${aggregate}&limit=${limit}`);
    if (data && Array.isArray(data.bars)) {
      return { bars: data.bars, reason: data.reason || null, retryAfterMs: data.retryAfterMs || null };
    }
  } catch (e) {
  }
  return { bars: [], reason: 'unreachable', retryAfterMs: null };
}

/**
 * Admin telemetry: server process stats, Firestore latency and stored
 * document metadata. `probe` runs a live write+read round trip.
 */
export async function fetchAdminStore({ collection, token, probe } = {}) {
  try {
    const params = new URLSearchParams();
    if (collection) params.set('collection', collection);
    if (token) params.set('token', token);
    if (probe) params.set('probe', '1');
    params.set('limit', '25');
    const data = await fetchJson(`${BASE_URL}/api/admin/store?${params.toString()}`);
    if (data && data.server === 'ok') return data;
  } catch (e) {
  }
  return null;
}

/** The server's own catalogue of field sources and equations. */
export async function fetchCatalog() {
  try {
    const data = await fetchJson(`${BASE_URL}/api/catalog`);
    if (data && data.server === 'ok') return data;
  } catch (e) {
  }
  return null;
}

/** Where the data is coming from, for status and admin display. */
export const API_ORIGIN = BASE_URL;
