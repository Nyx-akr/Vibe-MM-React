/**
 * Continuous rotation intelligence.
 *
 * WHY THIS EXISTS
 *
 * The ROTATION tab used to fetch only when you opened it: you clicked, watched
 * a blank panel, and waited a poll cycle for the first graph to arrive. Worse,
 * the result was thrown away on navigation, so nothing else in the app could
 * ask "is capital leaving this token for another one" - the one question the
 * graph exists to answer, and the one most useful OUTSIDE the tab that draws it.
 *
 * This service turns that one-shot read into a standing one. The graph is
 * rebuilt every tick for every chain, held in memory, and answered
 * synchronously. Opening the tab is now a render, not a fetch.
 *
 * ZERO EXTRA REQUESTS
 *
 * This service does not poll. wallet-intel already reads /api/trades once per
 * chain per tick - every pool the server holds, in one response - and already
 * reduces it to the cross-pool wallet set that rotationGraph() takes as input.
 * So rotation subscribes to that same read via onSampledPools() instead of
 * issuing its own. Two consequences worth keeping:
 *
 *   - adding this service cost nothing upstream, which matters because
 *     GeckoTerminal rate-limits hard and the server already takes 429s;
 *   - ROTATION and WALLETS can never disagree, because they are describing
 *     the same read of the same moment rather than two independent fetches.
 *
 * WHAT IS REMEMBERED BETWEEN TICKS
 *
 * The graph itself is a snapshot of the current window and is replaced whole.
 * What accumulates is the thin part worth keeping: when a pool was first seen
 * rotating, the largest rotation it has shown, and how many ticks it has been
 * connected. That is enough to say "this is new" or "this has been running for
 * an hour" without pretending to hold a trade-level history the samples do not
 * support.
 *
 * WHAT THIS SERVICE WILL NOT CLAIM
 *
 * That the graph is five seconds old. The tick is PROCESSING, not SAMPLING:
 * the server refreshes any given pool's trades on a slower rotation, so each
 * chain carries the sample stamps it was actually built from, and callers that
 * care should read them. Same rule as wallet-intel, for the same reason.
 */

import { rotationGraph } from '../calculations/core';
import { onSampledPools } from './wallet-intel';

/* --------------------------------------------------------------- limits -- */

/** A chain not refreshed for this long is dropped rather than shown stale. */
const CHAIN_TTL_MS = 10 * 60000;
/** Per-pool history entries kept. Beyond this the least recent are dropped. */
const MAX_TRACKED_POOLS = 600;
/** A pool not seen rotating for this long stops being interesting. */
const POOL_TTL_MS = 3 * 3600000;

/* ---------------------------------------------------------------- state -- */

/** chainKey -> { chain, graph, at, stale, poolsSeen } */
const byChain = new Map();

/**
 * poolAddress -> the thin cross-tick memory.
 * { poolAddress, chain, symbol, firstRotatingAt, lastRotatingAt, ticks,
 *   peakRotatedUsd, peakNetUsd, lastNetUsd, lastRotatedUsd, lastConnections }
 */
const byPool = new Map();

let unsubscribe = null;
let running = false;

const status = {
  startedAt: null,
  ticks: 0,
  lastTickAt: null,
  chainsHeld: 0,
  poolsConnected: 0,
  lastError: null,
};

const listeners = new Set();

/** Subscribe to "the rotation picture changed"; returns an unsubscribe fn. */
export function onRotationIntel(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  listeners.forEach((fn) => {
    try { fn(); } catch (e) { /* a bad listener must not stop the loop */ }
  });
}

/* ---------------------------------------------------------------- ingest -- */

function prune() {
  const chainCutoff = Date.now() - CHAIN_TTL_MS;
  byChain.forEach((entry, key) => { if (entry.at < chainCutoff) byChain.delete(key); });

  const poolCutoff = Date.now() - POOL_TTL_MS;
  byPool.forEach((rec, key) => { if (rec.lastRotatingAt < poolCutoff) byPool.delete(key); });
  if (byPool.size > MAX_TRACKED_POOLS) {
    [...byPool.entries()]
      .sort((a, b) => b[1].lastRotatingAt - a[1].lastRotatingAt)
      .slice(MAX_TRACKED_POOLS)
      .forEach(([key]) => byPool.delete(key));
  }
}

/**
 * Folds one chain's freshly built graph into memory.
 *
 * The graph replaces the previous one outright - it describes a window, and
 * merging two windows would invent a third that was never measured. Only the
 * per-pool superlatives accumulate.
 */
function ingest({ chain, walletSets, stale, at }) {
  try {
    const graph = rotationGraph(walletSets);
    byChain.set(chain, { chain, graph, at: at || Date.now(), stale: Boolean(stale) });

    const now = Date.now();
    (graph.nodes || []).forEach((n) => {
      if (!n.connections) return;
      const prev = byPool.get(n.poolAddress);
      const rec = prev || {
        poolAddress: n.poolAddress,
        chain,
        firstRotatingAt: n.rotatedUsd > 0 ? now : null,
        ticks: 0,
        peakRotatedUsd: 0,
        peakNetUsd: 0,
      };
      rec.chain = chain;
      rec.symbol = n.symbol;
      rec.ticks += 1;
      rec.lastRotatingAt = now;
      rec.lastRotatedUsd = n.rotatedUsd;
      rec.lastNetUsd = n.netRotationUsd;
      rec.lastConnections = n.connections;
      if (n.rotatedUsd > 0 && !rec.firstRotatingAt) rec.firstRotatingAt = now;
      if (n.rotatedUsd > rec.peakRotatedUsd) rec.peakRotatedUsd = n.rotatedUsd;
      if (Math.abs(n.netRotationUsd) > Math.abs(rec.peakNetUsd)) {
        rec.peakNetUsd = n.netRotationUsd;
      }
      byPool.set(n.poolAddress, rec);
    });

    status.ticks += 1;
    status.lastTickAt = Date.now();
    status.chainsHeld = byChain.size;
    status.poolsConnected = byPool.size;
    status.lastError = null;
  } catch (e) {
    status.lastError = (e && e.message) || 'rotation graph failed';
  }

  prune();
  announce();
}

/* ------------------------------------------------------------- lifecycle -- */

/**
 * Starts the service. Safe to call twice; the second call is ignored.
 *
 * Takes no baseUrl or chain list because it does not fetch: it attaches to
 * whatever wallet-intel is already polling, so the two can never cover
 * different chains.
 */
export function startRotationIntel() {
  if (running) return;
  running = true;
  status.startedAt = Date.now();
  unsubscribe = onSampledPools(ingest);
}

export function stopRotationIntel() {
  running = false;
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
}

/* ----------------------------------------------------------------- reads -- */

/** The whole graph for one chain, or null if it has not been built yet. */
export function rotationGraphFor(chainKey) {
  const entry = chainKey ? byChain.get(chainKey) : null;
  return entry ? { ...entry.graph, chain: entry.chain, builtAt: entry.at, stale: entry.stale } : null;
}

/** Every chain currently held, busiest first. */
export function rotationChains() {
  return [...byChain.values()]
    .map((e) => ({
      chain: e.chain,
      builtAt: e.at,
      poolsSampled: e.graph.poolsSampled,
      pairsConnected: e.graph.pairsConnected,
      rotatedUsd: e.graph.rotatedUsd,
      sharedWalletCount: e.graph.sharedWalletCount,
    }))
    .sort((a, b) => b.rotatedUsd - a.rotatedUsd);
}

/**
 * The chain with the most rotation right now.
 *
 * Used when the board filter is ALL: rotation is measured within one chain, so
 * "all chains" has no single graph to show, and picking the busiest is more
 * useful than defaulting to Solana and calling it the answer.
 */
export function busiestRotationChain() {
  const ranked = rotationChains();
  return ranked.length ? ranked[0].chain : null;
}

/**
 * What rotation says about ONE pool, for any panel that is already showing
 * that token - ASSET DETAIL, WALLETS, LIVE OPPORTUNITIES.
 *
 * Returns null when the pool is not in a graph yet, which is the honest answer
 * before the sampling rotation has reached it.
 */
export function rotationForPool(poolAddress) {
  if (!poolAddress) return null;

  let found = null;
  let chain = null;
  let builtAt = null;
  byChain.forEach((entry) => {
    if (found) return;
    const hit = (entry.graph.nodes || []).find((n) => n.poolAddress === poolAddress);
    if (hit) { found = hit; chain = entry.chain; builtAt = entry.at; }
  });
  if (!found) return null;

  const entry = byChain.get(chain);
  const peers = (entry.graph.edges || [])
    .filter((e) => e.fromPool === poolAddress || e.toPool === poolAddress)
    .map((e) => {
      const outbound = e.sourcePool === poolAddress;
      return {
        symbol: outbound ? e.target : e.source,
        poolAddress: outbound ? e.targetPool : e.sourcePool,
        direction: outbound ? 'out' : 'in',
        rotatedUsd: e.rotatedUsd,
        sharedWallets: e.sharedWallets,
        overlapPct: e.overlapPct,
      };
    })
    .sort((a, b) => b.rotatedUsd - a.rotatedUsd);

  const memory = byPool.get(poolAddress) || null;

  return {
    chain,
    builtAt,
    symbol: found.symbol,
    poolAddress,
    connections: found.connections,
    wallets: found.wallets,
    rotatedUsd: found.rotatedUsd,
    inUsd: found.inUsd,
    outUsd: found.outUsd,
    netRotationUsd: found.netRotationUsd,
    sampledAt: found.sampledAt,
    poolsCompared: Math.max(0, entry.graph.poolsSampled - 1),
    peers: peers.slice(0, 5),
    // Cross-tick context: null until the service has watched it for a while.
    firstRotatingAt: memory && memory.firstRotatingAt,
    peakRotatedUsd: memory && memory.peakRotatedUsd,
    ticksObserved: memory && memory.ticks,
  };
}

/** Pools ranked by how much capital they have pulled in, across every chain. */
export function rotationLeaders({ limit = 20, chain = null } = {}) {
  return [...byPool.values()]
    .filter((r) => (chain ? r.chain === chain : true))
    .sort((a, b) => (b.lastNetUsd || 0) - (a.lastNetUsd || 0))
    .slice(0, limit);
}

/** For SYSTEM HEALTH and the admin panel. */
export function rotationIntelStatus() {
  return {
    ...status,
    running,
    // Summed across every chain held, at read time. Kept out of the tick
    // counters deliberately: those are per-chain, and a per-chain figure under
    // an app-wide name is how a status panel starts reporting one eighth of
    // the truth.
    rotatedUsdHeld: [...byChain.values()].reduce((s, e) => s + (e.graph.rotatedUsd || 0), 0),
    // Named so nobody reads the tick rate as a sampling rate.
    note: 'processes every held pool each tick; sampling is the server’s job',
  };
}
