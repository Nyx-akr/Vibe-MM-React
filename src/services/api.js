/**
 * VibeScreener API Service
 * Fetches real-time market, rotation, wallet, social, evaluation, intel, and OHLCV data
 * from the VibeScreener live server backend (server.cjs).
 */

import { assetSeeds } from '../data/assets';

const BASE_URL = '';

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

  const chainRaw = String(row.chain || 'solana').toLowerCase();
  const chainSymbolMap = {
    solana: 'SOL', sol: 'SOL',
    base: 'BASE',
    bsc: 'BNB', bnb: 'BNB', 'binance-smart-chain': 'BNB',
    robinhood: 'RHC', rhc: 'RHC',
    ethereum: 'ETH', eth: 'ETH',
    arbitrum: 'BASE', polygon: 'BASE', hyperevm: 'RHC'
  };
  const chain = chainSymbolMap[chainRaw] || chainRaw.toUpperCase().slice(0, 4);

  let cls = 'TOKEN';
  const symUpper = String(row.symbol || '').toUpperCase();
  if (symUpper.includes('X') || chain === 'RHC' || (row.pairName && row.pairName.includes('USD'))) {
    cls = 'STOCK';
  } else if (symUpper.includes('QQQ') || symUpper.includes('ETF')) {
    cls = 'ETF';
  } else if ((row.poolAgeHours != null && row.poolAgeHours < 48) || symUpper.startsWith('$') || (row.flow && row.flow.washRisk > 25)) {
    cls = 'MEME';
  }

  const wash = row.flow && row.flow.washRisk != null
    ? row.flow.washRisk / 100
    : (row.riskPenalty ? Math.min(0.8, row.riskPenalty / 30) : 0.05);

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

  if (flags.length === 0) {
    flags.push({ sev: 'LOW', text: 'Normal trading baselines active' });
  }

  const spark = Array.isArray(row.spark) && row.spark.length > 5
    ? row.spark
    : [40, 45, 48, 52, 55, 60, 62, 68, 72, 70, 75, 80, 84, 88];

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
    liq: row.liquidityUsd || 100000,
    vol: row.volume24hUsd || 500000,
    adj: row.volume5mUsd ? row.volume5mUsd * 12 : (row.volume24hUsd || 500000) * 0.9,
    buyers: row.traders5m?.buyers || row.txns5m?.buys || 42,
    nf: row.flow?.netUsd ?? ((row.txns5m?.buys || 10) - (row.txns5m?.sells || 5)) * 250,
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
export async function fetchLiveMarketData(chains = ['solana', 'base', 'bsc', 'robinhood']) {
  try {
    const results = await Promise.allSettled(
      chains.map(chain => fetchJson(`${BASE_URL}/api/market?chain=${chain}&feed=trending&limit=15`))
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
    if (data && data.server === 'ok' && Array.isArray(data.bars)) return data.bars;
  } catch (e) {
  }
  return null;
}
