/**
 * Continuous wallet intelligence.
 *
 * WHY THIS EXISTS
 *
 * The WALLETS tab used to fetch only when you opened it, and only for the
 * token you had selected. Nothing else in the app could ask "what do we know
 * about this wallet", because the answer was thrown away the moment you
 * navigated. This service turns that one-shot read into a standing one: it
 * polls in the background, processes every pool the server has sampled - not
 * just the selected one - folds the results into a memory that outlives any
 * single sample, and answers questions synchronously for any module.
 *
 * WHAT "EVERY TOKEN, EVERY 5 SECONDS" CAN AND CANNOT MEAN
 *
 * Trades come from GeckoTerminal, which rate-limits hard: the server already
 * takes 429s on Render's shared outbound IPs. Pulling fresh trades for every
 * token on the board every five seconds would be a few hundred upstream calls
 * a minute and would simply be refused.
 *
 * So the work is split by what is actually expensive:
 *
 *   SAMPLING  (upstream, slow)  the server's warm loop refreshes pools on a
 *                               rotation. A given pool's trades are re-read
 *                               every few minutes, not every five seconds.
 *   READING   (cheap)           /api/trades?chain=X returns every pool the
 *                               server currently holds, in one response, from
 *                               memory. One request per chain per tick.
 *   PROCESSING(free, local)     every held pool is re-analysed on every tick.
 *   MEMORY    (free, local)     what each tick learns is accumulated, so the
 *                               picture keeps deepening between samples.
 *
 * The result: coverage grows as the rotation sweeps, and every module sees the
 * same, always-current picture without any of them issuing a fetch. What this
 * service will never claim is that a pool's trades are five seconds old - each
 * pool carries `sampledAt`, and callers that care should read it.
 *
 * DOUBLE COUNTING
 *
 * Consecutive samples of one pool overlap heavily (the provider returns the
 * last ~300 trades each time). Cumulative totals therefore fold in trades by
 * identity, not by arrival: a pool is only reprocessed when its sample stamp
 * moves, and each trade is counted once per (pool, wallet, timestamp, size).
 */

import { buildWalletSets, tokenWalletIntel } from '../calculations/core';

/* -------------------------------------------------------------- storage -- */

const STORAGE_KEY = 'vs_wallet_memory';

/**
 * Same deal as the score journal: one interface, localStorage behind it for
 * now. Swap this object to move the memory somewhere shared.
 */
const localStorageBackend = {
  name: 'localStorage',
  describe: () => 'this browser only',
  load(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },
  save(key, data) {
    try {
      window.localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      return false;
    }
  },
};

const ACTIVE_BACKEND = localStorageBackend;

export const walletMemoryBackend = {
  name: ACTIVE_BACKEND.name,
  describe: ACTIVE_BACKEND.describe(),
};

/* --------------------------------------------------------------- limits -- */

/** How often the held samples are re-read and re-processed. */
const TICK_MS = 5000;
/** Wallets kept in memory. Beyond this the least useful are dropped. */
const MAX_WALLETS = 4000;
/** A wallet not seen for this long stops being interesting. */
const WALLET_TTL_MS = 6 * 3600000;
/** Clusters kept for the cross-token view. */
const MAX_CLUSTERS = 200;
const CLUSTER_TTL_MS = 3 * 3600000;
/** Trade keys remembered per pool, to keep overlapping samples from stacking. */
const SEEN_PER_POOL = 1200;
/** Persist at most this often; the tick is faster than localStorage wants. */
const PERSIST_EVERY_MS = 30000;

/* ---------------------------------------------------------------- state -- */

/** poolAddress -> the latest full tokenWalletIntel() result. */
const byPool = new Map();
/** lower-cased address -> accumulated cross-token record. */
const byWallet = new Map();
/** Co-entry clusters seen across every pool, newest first. */
let clusterLog = [];
/** poolAddress -> { sampledAt, seen:Set(tradeKey) } */
const poolCursors = new Map();

let timer = null;
let running = false;
let lastPersistAt = 0;
let baseUrl = '';
let chainList = [];
const status = {
  startedAt: null,
  ticks: 0,
  lastTickAt: null,
  lastError: null,
  poolsHeld: 0,
  chainsPolled: 0,
  walletsKnown: 0,
  newTradesLastTick: 0,
};

const listeners = new Set();

/**
 * Modules that derive their OWN picture from the same sampled trades.
 *
 * This is a seam, not a second poller. /api/trades already returns every
 * pool the server holds in one response, and this loop already reduces it to
 * the per-chain wallet set. A module that needs the same input subscribes
 * here rather than issuing its own request - so adding one costs no extra
 * upstream calls and cannot drift out of step with what WALLETS is showing.
 */
const sampleConsumers = new Set();

/**
 * Receive every chain's sampled pools as this loop reads them.
 *
 * The callback gets { chain, pools, walletSets, stale, at }. Returns an
 * unsubscribe function.
 */
export function onSampledPools(fn) {
  sampleConsumers.add(fn);
  return () => sampleConsumers.delete(fn);
}

/** Subscribe to "the memory changed"; returns an unsubscribe function. */
export function onWalletIntel(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  listeners.forEach((fn) => {
    try { fn(); } catch (e) { /* a bad listener must not stop the loop */ }
  });
}

/* --------------------------------------------------------------- memory -- */

function hydrate() {
  const saved = ACTIVE_BACKEND.load(STORAGE_KEY);
  if (!saved || typeof saved !== 'object') return;
  const cutoff = Date.now() - WALLET_TTL_MS;
  (saved.wallets || []).forEach((w) => {
    if (!w || !w.address || (w.lastSeen || 0) < cutoff) return;
    byWallet.set(w.address.toLowerCase(), {
      ...w,
      // Maps and Sets do not survive JSON, so they are stored as arrays.
      pools: new Map((w.pools || []).map((p) => [p.poolAddress, p])),
      chains: new Set(w.chains || []),
    });
  });
  clusterLog = (saved.clusters || []).filter((c) => c && c.at > Date.now() - CLUSTER_TTL_MS);
}

function persist(force = false) {
  const now = Date.now();
  if (!force && now - lastPersistAt < PERSIST_EVERY_MS) return;
  lastPersistAt = now;

  // Keep the most active wallets, not merely the most recent: a whale seen
  // twice matters more than a dust wallet seen twenty times.
  const wallets = [...byWallet.values()]
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || b.grossUsd - a.grossUsd)
    .slice(0, MAX_WALLETS)
    .map((w) => ({ ...w, pools: [...w.pools.values()], chains: [...w.chains] }));

  ACTIVE_BACKEND.save(STORAGE_KEY, { savedAt: now, wallets, clusters: clusterLog });
}

function prune() {
  const cutoff = Date.now() - WALLET_TTL_MS;
  byWallet.forEach((w, key) => { if ((w.lastSeen || 0) < cutoff) byWallet.delete(key); });
  if (byWallet.size > MAX_WALLETS) {
    const ordered = [...byWallet.entries()]
      .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0) || b[1].grossUsd - a[1].grossUsd);
    ordered.slice(MAX_WALLETS).forEach(([key]) => byWallet.delete(key));
  }
  clusterLog = clusterLog
    .filter((c) => c.at > Date.now() - CLUSTER_TTL_MS)
    .slice(0, MAX_CLUSTERS);
}

/** Identity of one trade, so an overlapping sample does not count it twice. */
const tradeKey = (t) => t.wallet + '|' + t.at + '|' + Math.round(t.usd * 100) + '|' + t.kind;

/**
 * Folds one pool's NEW trades into the per-wallet memory.
 *
 * Only trades this pool has not already contributed are counted, so the
 * cumulative figures mean "everything we have ever seen this wallet do in this
 * pool", not "whatever happened to be in the last few samples".
 */
function rememberTrades(chain, pool, trades) {
  let cursor = poolCursors.get(pool.poolAddress);
  if (!cursor) {
    cursor = { sampledAt: 0, seen: new Set() };
    poolCursors.set(pool.poolAddress, cursor);
  }

  let fresh = 0;
  const now = Date.now();
  trades.forEach((t) => {
    const key = tradeKey(t);
    if (cursor.seen.has(key)) return;
    cursor.seen.add(key);
    fresh += 1;

    const id = t.wallet.toLowerCase();
    const w = byWallet.get(id) || {
      address: t.wallet,
      firstSeen: t.at || now,
      lastSeen: t.at || now,
      trades: 0,
      buyUsd: 0,
      sellUsd: 0,
      grossUsd: 0,
      netUsd: 0,
      clusterHits: 0,
      pools: new Map(),
      chains: new Set(),
    };

    w.trades += 1;
    if (t.kind === 'sell') w.sellUsd += t.usd; else w.buyUsd += t.usd;
    w.grossUsd = Math.round(w.buyUsd + w.sellUsd);
    w.netUsd = Math.round(w.buyUsd - w.sellUsd);
    if (t.at) {
      if (t.at < w.firstSeen) w.firstSeen = t.at;
      if (t.at > w.lastSeen) w.lastSeen = t.at;
    }
    w.chains.add(chain);

    const p = w.pools.get(pool.poolAddress) || {
      poolAddress: pool.poolAddress, symbol: pool.symbol || null, chain,
      trades: 0, netUsd: 0, grossUsd: 0, lastAt: 0,
    };
    p.trades += 1;
    p.netUsd = Math.round(p.netUsd + (t.kind === 'sell' ? -t.usd : t.usd));
    p.grossUsd = Math.round(p.grossUsd + t.usd);
    p.lastAt = Math.max(p.lastAt, t.at || 0);
    if (!p.symbol && pool.symbol) p.symbol = pool.symbol;
    w.pools.set(pool.poolAddress, p);

    byWallet.set(id, w);
  });

  // The key set is bounded: it only has to cover the overlap between two
  // consecutive samples, which is at most one provider page.
  if (cursor.seen.size > SEEN_PER_POOL) {
    cursor.seen = new Set([...cursor.seen].slice(-SEEN_PER_POOL));
  }
  cursor.sampledAt = pool.at || now;
  return fresh;
}

/** Adds this pool's clusters to the cross-token log, without duplicating them. */
function rememberClusters(chain, pool, clusters) {
  clusters.forEach((c) => {
    const id = pool.poolAddress + ':' + c.at + ':' + c.wallets;
    if (clusterLog.some((x) => x.id === id)) return;
    clusterLog.unshift({
      id,
      chain,
      symbol: pool.symbol || null,
      poolAddress: pool.poolAddress,
      at: c.at,
      wallets: c.wallets,
      avgEntryUsd: c.avgEntryUsd,
      sizeSpreadPct: c.sizeSpreadPct,
      grossUsd: c.grossUsd,
      confidence: c.confidence,
      exit: c.exit,
      members: c.members,
    });
    c.members.forEach((m) => {
      const w = byWallet.get(String(m).toLowerCase());
      if (w) w.clusterHits = (w.clusterHits || 0) + 1;
    });
  });
}

/* ----------------------------------------------------------------- loop -- */

async function pollChain(chain) {
  const res = await fetch(`${baseUrl}/api/trades?chain=${chain}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.server !== 'ok') return { pools: 0, fresh: 0 };

  const pools = (data.pools || []).filter((p) => (p.trades || []).length);
  if (!pools.length) return { pools: 0, fresh: 0 };

  // Built once per chain: every pool's intel is measured against the same
  // cross-pool set, which is what makes "also trading" comparable between them.
  const walletSets = buildWalletSets(pools);
  let fresh = 0;

  pools.forEach((pool) => {
    const cursor = poolCursors.get(pool.poolAddress);
    const sampleMoved = !cursor || cursor.sampledAt !== (pool.at || 0);

    // Re-derive on every tick regardless: the cross-pool set may have changed
    // even when this pool's own sample has not, and callers read this object
    // directly. Only the MEMORY fold is gated on a new sample.
    const intel = tokenWalletIntel({
      trades: pool.trades,
      poolAddress: pool.poolAddress,
      walletSets,
      tracked: trackedProvider(),
    });
    byPool.set(pool.poolAddress, {
      ...intel,
      chain,
      symbol: pool.symbol || null,
      sampledAt: pool.at || null,
      stale: Boolean(data.stale),
    });

    if (sampleMoved) {
      fresh += rememberTrades(chain, pool, pool.trades);
      rememberClusters(chain, pool, intel.clusters);
    }
  });

  // Hand the same sample to anything else deriving from it, before this
  // function returns, so every module is describing one read of one moment.
  const handoff = { chain, pools, walletSets, stale: Boolean(data.stale), at: Date.now() };
  sampleConsumers.forEach((fn) => {
    try { fn(handoff); } catch (e) { /* a bad consumer must not stop the loop */ }
  });

  return { pools: pools.length, fresh };
}

/** Supplied by the app so cluster/tag output can mark the user's wallets. */
let trackedProvider = () => [];

async function tick() {
  if (!running) return;
  const results = await Promise.allSettled(chainList.map(pollChain));

  let pools = 0;
  let fresh = 0;
  let polled = 0;
  let error = null;
  results.forEach((r) => {
    if (r.status === 'fulfilled') { pools += r.value.pools; fresh += r.value.fresh; polled += 1; }
    else error = r.reason && r.reason.message;
  });

  prune();
  persist();

  status.ticks += 1;
  status.lastTickAt = Date.now();
  status.poolsHeld = byPool.size;
  status.chainsPolled = polled;
  status.walletsKnown = byWallet.size;
  status.newTradesLastTick = fresh;
  status.lastError = polled ? null : error;

  announce();
}

/**
 * Starts the background loop. Safe to call twice; the second call is ignored.
 *
 * @param baseUrlIn   the data server origin
 * @param chains      chain keys to keep watch on
 * @param getTracked  returns the user's tracked addresses
 */
export function startWalletIntel({ baseUrl: baseUrlIn, chains, getTracked } = {}) {
  if (running) return;
  baseUrl = String(baseUrlIn || '').replace(/\/+$/, '');
  chainList = (chains || []).slice();
  if (typeof getTracked === 'function') trackedProvider = getTracked;

  hydrate();
  running = true;
  status.startedAt = Date.now();
  tick();
  timer = setInterval(tick, TICK_MS);
}

export function stopWalletIntel() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  persist(true);
}

/* ---------------------------------------------------------------- reads -- */

/** The latest full picture for one pool, or null if it has not been sampled. */
export function walletIntelForPool(poolAddress) {
  return poolAddress ? byPool.get(poolAddress) || null : null;
}

/** Every pool currently held, newest sample first. */
export function pooledWalletIntel() {
  return [...byPool.values()].sort((a, b) => (b.sampledAt || 0) - (a.sampledAt || 0));
}

/**
 * Everything the memory holds about one wallet, across every token and every
 * sample since the service started - not just the pool on screen.
 */
export function walletProfile(address) {
  if (!address) return null;
  const w = byWallet.get(String(address).toLowerCase());
  if (!w) return null;
  const pools = [...w.pools.values()].sort((a, b) => b.grossUsd - a.grossUsd);
  return {
    address: w.address,
    firstSeen: w.firstSeen,
    lastSeen: w.lastSeen,
    trades: w.trades,
    buyUsd: Math.round(w.buyUsd),
    sellUsd: Math.round(w.sellUsd),
    grossUsd: w.grossUsd,
    netUsd: w.netUsd,
    clusterHits: w.clusterHits || 0,
    tokensTouched: pools.length,
    chains: [...w.chains],
    pools,
  };
}

/** Wallets ranked by how much they have moved across everything we watch. */
export function topWallets({ limit = 50, chain = null, minPools = 1 } = {}) {
  return [...byWallet.values()]
    .filter((w) => (!chain || w.chains.has(chain)) && w.pools.size >= minPools)
    .sort((a, b) => b.grossUsd - a.grossUsd)
    .slice(0, limit)
    .map((w) => walletProfile(w.address));
}

/** Wallets seen in more than one token - real rotation, across time. */
export function rotatingWallets({ limit = 50, chain = null } = {}) {
  return topWallets({ limit, chain, minPools: 2 });
}

/** Co-entry clusters across every token, newest first. */
export function recentClusters({ limit = 40, minConfidence = null, chain = null } = {}) {
  const rank = { low: 0, medium: 1, high: 2 };
  return clusterLog
    .filter((c) => (!chain || c.chain === chain) &&
      (!minConfidence || rank[c.confidence] >= rank[minConfidence]))
    .slice(0, limit);
}

/** Is this address one we have seen misbehaving anywhere? */
export function walletFlags(address) {
  const p = walletProfile(address);
  if (!p) return null;
  return {
    known: true,
    clusterHits: p.clusterHits,
    tokensTouched: p.tokensTouched,
    rotating: p.tokensTouched > 1,
    netUsd: p.netUsd,
  };
}

/** Health and coverage, for SYSTEM HEALTH or a status line. */
export function walletIntelStatus() {
  return {
    ...status,
    running,
    clusters: clusterLog.length,
    backend: walletMemoryBackend.describe,
    intervalMs: TICK_MS,
  };
}

/** Drops the accumulated memory. Exposed for the admin panel. */
export function clearWalletMemory() {
  byWallet.clear();
  byPool.clear();
  poolCursors.clear();
  clusterLog = [];
  persist(true);
  announce();
}
