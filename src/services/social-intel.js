/**
 * Continuous social intelligence.
 *
 * WHY THIS EXISTS
 *
 * The SOCIAL SCANNER used to fetch only when you opened it, and only for the
 * token you had selected. Nothing else in the app could ask "is anyone talking
 * about this token", because the answer was computed for one ticker and thrown
 * away on navigation. This service turns that one-shot read into a standing
 * one: it polls in the background, measures EVERY token on the board on every
 * tick - not just the selected one - accumulates a per-token memory that
 * outlives any single sweep, and answers questions synchronously for any
 * module.
 *
 * WHAT "EVERY TOKEN, EVERY 5 SECONDS" CAN AND CANNOT MEAN
 *
 * The corpus is about 1.2MB of posts drawn from five public feeds, and those
 * feeds are cached upstream for 5 minutes (15 for Reddit, which rate-limits
 * hard). Re-downloading it every five seconds would be ~860MB an hour to learn
 * nothing, so the work is split by what is actually expensive:
 *
 *   SAMPLING  (upstream, slow)  each feed refreshes every 5-15 minutes. The
 *                               server stamps the corpus with `corpusAt`.
 *   READING   (cheap)           the poll sends `?since=<corpusAt>`; when the
 *                               corpus has not moved the server omits the
 *                               posts and answers in ~11KB instead of ~1.2MB.
 *   PROCESSING(free, local)     every board symbol is re-measured every tick
 *                               against the corpus already in memory.
 *   MEMORY    (free, local)     each tick's counts are folded into a per-token
 *                               series, so a baseline builds up over time.
 *
 * What this service will never claim is that a post is five seconds old. The
 * corpus carries `corpusAt`; callers that care should read it.
 *
 * WHY THE MEASUREMENT IS CHEAP ENOUGH TO REDO EVERY TICK
 *
 * mentionsFor() indexes the corpus once per corpus change and answers from an
 * inverted index after that - the whole board costs well under a millisecond,
 * against ~24ms for the scan it replaced.
 */

import { mentionsFor, mentionBaseline } from '../calculations/core';

/* -------------------------------------------------------------- storage -- */

const STORAGE_KEY = 'vs_social_memory';

/**
 * Same deal as the wallet memory and the score journal: one interface,
 * localStorage behind it for now. Swap this object to move the memory
 * somewhere shared.
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

export const socialMemoryBackend = {
  name: ACTIVE_BACKEND.name,
  describe: ACTIVE_BACKEND.describe(),
};

/* --------------------------------------------------------------- limits -- */

/** How often the corpus is re-read and the board re-measured. */
const TICK_MS = 5000;
/** Tokens kept in memory. Beyond this the least recently seen are dropped. */
const MAX_TOKENS = 600;
/** A token not seen on the board for this long stops being interesting. */
const TOKEN_TTL_MS = 6 * 3600000;
/** Baseline samples kept per token, and the gap between them. */
const SERIES_MAX = 240;
const SERIES_MIN_GAP_MS = 60000;
/** Persist at most this often; the tick is faster than localStorage wants. */
const PERSIST_EVERY_MS = 30000;
/** Matched posts handed out per token. The rest are counted, not carried. */
const MAX_MATCHED = 40;

/* ---------------------------------------------------------------- state -- */

/** The posts themselves. Replaced wholesale when the server says it moved. */
let corpus = [];
let corpusAt = 0;
let sources = [];
let promotionByChain = new Map();
let absentNote = '';

/** SYMBOL -> the latest full mentionsFor() result. Not persisted. */
const live = new Map();
/** SYMBOL -> accumulated record that outlives any one corpus. Persisted. */
const memory = new Map();

let timer = null;
let running = false;
/**
 * A poll already in flight.
 *
 * The first sweep has to download the whole corpus, which on a cold server
 * takes longer than the tick interval. Without this guard the next tick fires
 * while the first is still downloading, sees corpusAt still unset, and asks
 * for the whole megabyte a second time. Ticks that arrive mid-poll skip the
 * request and just re-measure what is already held.
 */
let polling = false;
let lastPersistAt = 0;
let baseUrl = '';
let chainList = [];
let chainCursor = 0;
let symbolProvider = () => [];

const status = {
  startedAt: null,
  ticks: 0,
  lastTickAt: null,
  lastError: null,
  corpusAt: 0,
  corpusPosts: 0,
  corpusRefreshes: 0,
  lastPolledChain: null,
  symbolsMeasured: 0,
  symbolsWithMentions: 0,
  tokensKnown: 0,
  bytesLastTick: 0,
  pollsSkipped: 0,
  measureMs: 0,
};

const listeners = new Set();

/** Subscribe to "the social memory changed"; returns an unsubscribe function. */
export function onSocialIntel(fn) {
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
  const cutoff = Date.now() - TOKEN_TTL_MS;
  (saved.tokens || []).forEach((t) => {
    if (!t || !t.symbol || (t.lastSeen || 0) < cutoff) return;
    memory.set(t.symbol, {
      ...t,
      series: (t.series || []).slice(-SERIES_MAX),
    });
  });
}

function persist(force = false) {
  const now = Date.now();
  if (!force && now - lastPersistAt < PERSIST_EVERY_MS) return;
  lastPersistAt = now;

  // Keep the tokens worth remembering: recently seen first, then the ones that
  // actually got talked about. A token nobody ever mentioned is the cheapest
  // thing to forget and the least useful to keep.
  const tokens = [...memory.values()]
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0) || (b.peakMentions || 0) - (a.peakMentions || 0))
    .slice(0, MAX_TOKENS);

  ACTIVE_BACKEND.save(STORAGE_KEY, { savedAt: now, tokens });
}

function prune() {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  memory.forEach((t, key) => { if ((t.lastSeen || 0) < cutoff) memory.delete(key); });
  if (memory.size > MAX_TOKENS) {
    const ordered = [...memory.entries()].sort(
      (a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0) || (b[1].peakMentions || 0) - (a[1].peakMentions || 0),
    );
    ordered.slice(MAX_TOKENS).forEach(([key]) => memory.delete(key));
  }
}

/**
 * Folds one measurement into a token's standing record.
 *
 * The series is what makes a baseline possible: one sample a minute, so "12
 * mentions" can eventually be read as "4x its own normal" instead of just a
 * number. Sampling faster would not make the baseline better - the corpus only
 * changes every few minutes - it would just fill the window with duplicates.
 */
function remember(symbol, mention, now) {
  let rec = memory.get(symbol);
  if (!rec) {
    rec = {
      symbol,
      firstSeen: now,
      lastSeen: now,
      series: [],
      peakMentions: 0,
      peakAt: null,
      everMentioned: false,
    };
    memory.set(symbol, rec);
  }

  rec.lastSeen = now;
  rec.countable = mention.countable;
  rec.reason = mention.reason || null;
  rec.mentions = mention.mentions;
  rec.cashtag = mention.cashtag;
  rec.contextual = mention.contextual;
  rec.loose = mention.loose;
  rec.authors = mention.authors;
  rec.anonPosts = mention.anonPosts;
  rec.concentration = mention.concentration;
  rec.bySource = mention.bySource;
  rec.newestPostMs = mention.newestMs;
  rec.excerpt = mention.excerpt;

  if (mention.mentions > 0) {
    rec.everMentioned = true;
    rec.lastMentionedAt = now;
    if (mention.mentions > (rec.peakMentions || 0)) {
      rec.peakMentions = mention.mentions;
      rec.peakAt = now;
    }
  }

  if (mention.countable) {
    const last = rec.series[rec.series.length - 1];
    if (!last || now - last.t >= SERIES_MIN_GAP_MS) {
      rec.series.push({ t: now, n: mention.mentions });
      if (rec.series.length > SERIES_MAX) rec.series.shift();
    }
  }
  return rec;
}

/* ----------------------------------------------------------------- poll -- */

/**
 * One request per tick, for one chain at a time.
 *
 * The corpus is chain-independent - 4chan and Reddit do not know what a chain
 * is - so a single poll updates the posts for every token on every chain. Only
 * the DexScreener promotion rows are per-chain, and those are what the
 * rotation is for: each chain's promotion refreshes every few ticks, which is
 * far more often than the 2-minute cache behind it.
 */
async function poll() {
  const chain = chainList[chainCursor % chainList.length] || 'solana';
  chainCursor = (chainCursor + 1) % Math.max(1, chainList.length);

  const url = baseUrl + '/api/social?chain=' + encodeURIComponent(chain) +
    (corpusAt ? '&since=' + corpusAt : '');
  const response = await fetch(url);
  if (!response.ok) throw new Error('HTTP ' + response.status + ' from /api/social');
  const text = await response.text();
  status.bytesLastTick = text.length;
  const data = JSON.parse(text);
  if (!data || data.server !== 'ok') throw new Error('social endpoint not ok');

  if (Array.isArray(data.posts)) {
    corpus = data.posts;
    status.corpusRefreshes += 1;
  }
  if (data.corpusAt) corpusAt = data.corpusAt;
  if (Array.isArray(data.sources)) sources = data.sources;
  if (data.absent) absentNote = data.absent;
  if (data.promotion && Array.isArray(data.promotion.rows)) {
    promotionByChain.set(chain, data.promotion.rows);
  }
  status.lastPolledChain = chain;
  return chain;
}

/** Re-measures every symbol the board currently holds. */
function measureAll() {
  const started = Date.now();
  const wanted = symbolProvider() || [];
  const now = Date.now();

  const seen = new Set();
  let withMentions = 0;

  for (const entry of wanted) {
    const symbol = String(
      (entry && entry.symbol) || (entry && entry.sym) || entry || '',
    ).replace(/^\$/, '').toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);

    const mention = mentionsFor(corpus, symbol);
    live.set(symbol, mention);
    remember(symbol, mention, now);
    if (mention.mentions > 0) withMentions += 1;
  }

  // A symbol that has left the board keeps its memory but stops claiming a
  // live measurement against a corpus it was never matched to.
  live.forEach((_, key) => { if (!seen.has(key)) live.delete(key); });

  status.symbolsMeasured = seen.size;
  status.symbolsWithMentions = withMentions;
  status.measureMs = Date.now() - started;
}

async function tick() {
  if (!running) return;
  if (!polling) {
    polling = true;
    try {
      await poll();
      status.lastError = null;
    } catch (error) {
      status.lastError = String((error && error.message) || error).slice(0, 160);
    } finally {
      polling = false;
    }
  } else {
    status.pollsSkipped += 1;
  }

  // Measure even when the poll failed: the corpus we already hold is still the
  // best answer available, and the board may have changed under it.
  measureAll();

  prune();
  persist();

  status.ticks += 1;
  status.lastTickAt = Date.now();
  status.corpusAt = corpusAt;
  status.corpusPosts = corpus.length;
  status.tokensKnown = memory.size;

  announce();
}

/* ------------------------------------------------------------ lifecycle -- */

export function startSocialIntel({ baseUrl: baseUrlIn, chains, getSymbols } = {}) {
  if (running) return;
  baseUrl = String(baseUrlIn || '').replace(/\/+$/, '');
  chainList = (chains || []).slice();
  if (typeof getSymbols === 'function') symbolProvider = getSymbols;

  hydrate();
  running = true;
  status.startedAt = Date.now();
  tick();
  timer = setInterval(tick, TICK_MS);
}

export function stopSocialIntel() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  persist(true);
}

/* ---------------------------------------------------------------- reads -- */

function normalize(symbol) {
  return String(symbol || '').replace(/^\$/, '').toUpperCase();
}

/**
 * Everything known about one token's social footprint: the current
 * measurement, the standing record, and the baseline built from it.
 *
 * Synchronous, and safe to call from render - it reads memory, never the
 * network.
 */
export function socialIntelFor(symbol) {
  const key = normalize(symbol);
  if (!key) return null;
  const mention = live.get(key) || null;
  const rec = memory.get(key) || null;
  const series = (rec && rec.series) || [];
  return {
    symbol: key,
    mention,
    memory: rec,
    baseline: mentionBaseline(series, mention ? mention.mentions : 0),
    matched: mention ? mention.matched.slice(0, MAX_MATCHED) : [],
    firstSeen: rec ? rec.firstSeen : null,
    peakMentions: rec ? rec.peakMentions || 0 : 0,
    peakAt: rec ? rec.peakAt : null,
    everMentioned: Boolean(rec && rec.everMentioned),
  };
}

/** The board's social leaders right now, loudest first. */
export function topSocialTokens({ limit = 20, minMentions = 1 } = {}) {
  return [...live.entries()]
    .filter(([, m]) => m && m.mentions >= minMentions)
    .sort((a, b) => b[1].mentions - a[1].mentions || b[1].authors - a[1].authors)
    .slice(0, limit)
    .map(([symbol, m]) => ({
      symbol,
      mentions: m.mentions,
      authors: m.authors,
      concentration: m.concentration,
      bySource: m.bySource,
    }));
}

/** Which feeds answered on the last sweep, with their own links and errors. */
export function socialSources() {
  return sources.slice();
}

/** The DexScreener promotion row for a token, if it paid for one. */
export function socialPromoFor(chain, tokenAddress) {
  const rows = promotionByChain.get(chain) || [];
  const wanted = String(tokenAddress || '').toLowerCase();
  if (!wanted) return null;
  return rows.find((r) => String(r.tokenAddress || '').toLowerCase() === wanted) || null;
}

/** What the feeds cannot cover, in the server's own words. */
export function socialAbsent() {
  return absentNote;
}

export function socialIntelStatus() {
  return {
    ...status,
    running,
    tickMs: TICK_MS,
    backend: socialMemoryBackend.name,
    chains: chainList.slice(),
  };
}

export function clearSocialMemory() {
  memory.clear();
  live.clear();
  ACTIVE_BACKEND.save(STORAGE_KEY, { savedAt: Date.now(), tokens: [] });
  announce();
}
