/**
 * The score journal.
 *
 * The raw store holds provider data only; scores are computed in the app and
 * NEVER leave it. So the app keeps its own record of what it scored, when, and
 * with which flags - in the app store (IndexedDB), not on the server. The
 * Evaluation tab and PRECISION@20 join this journal to the raw price series by
 * timestamp to measure whether a score meant anything.
 *
 * Because it is the only record, it holds enough for the longest measurement:
 * a 24h horizon over a 24h window needs marks up to ~48h old. Recent marks are
 * kept every minute; older ones are thinned to the newest per 15-minute slice,
 * which is the one mark per slice precisionAtK() reads. Measured on 50h of
 * synthetic marks: precision identical at every horizon, with only the single
 * slice straddling the moving window edge able to lose a pick (~0.1% of
 * picks) - for ~5x fewer marks, a few MB of store instead of tens.
 *
 * STORAGE IS DELIBERATELY BEHIND ONE INTERFACE.
 *
 *   load()          -> the whole journal object, or null
 *   save(data)      -> persist it
 *   clear()         -> drop it
 *   describe()      -> a label for the UI, so the user can see where it lives
 */

import * as historyStore from './storage/history-store';

const STORAGE_KEY = 'score-journal';
const STAGE_KEY = 'stage-memory';
const SCORE_WINDOW_KEY = 'score-window';

/* ------------------------------------------------------------- backends -- */

/**
 * The fast history store (IndexedDB), hydrated into RAM at boot so these
 * reads stay synchronous - see storage/history-store.js.
 *
 * This replaces the raw localStorage backend the journal shipped with.
 */
const historyBackend = {
  name: 'history-store',
  describe: () => historyStore.describe(),
  load(key) { return historyStore.get(key); },
  save(key, data) { return historyStore.put(key, data); },
  clear(key) { historyStore.remove(key); },
};

const ACTIVE_BACKEND = historyBackend;

export const journalBackend = {
  name: ACTIVE_BACKEND.name,
  get describe() { return ACTIVE_BACKEND.describe(); },
};

/* -------------------------------------------------------------- journal -- */

// One mark per token per interval. 60s matches the server's observation
// cadence, so a mark can always find a price near it.
const MARK_GAP_MS = 60000;
// A 24h horizon over a 24h window reaches marks ~48h old; 50h leaves slack.
const MARK_MAX_AGE_MS = 50 * 3600000;
// Marks younger than this are kept at full 60s resolution - the Evaluation
// tab's 1h horizon reads them. Older ones are thinned to one per slice.
const MARK_FINE_MS = 6 * 3600000;
// Must match precisionAtK's sliceMs: it keeps the newest mark per token per
// slice, so keeping exactly that mark preserves its picks (bar the one slice
// cut by the window edge).
const MARK_SLICE_MS = 900000;
// 6h at 60s plus 44h at one per 15 min is ~540; the cap is only a backstop.
const MARK_MAX = 1000;

// Deliberately NOT loaded at module scope. The store behind it is hydrated
// asynchronously at boot, and an import-time read would run before that and
// see nothing - silently starting every session with an empty journal.
let journal = {};
let dirty = false;

/**
 * Pulls the journal out of the hydrated store. Call once, after
 * historyStore.hydrate() resolves and before anything records a score.
 */
export function hydrateJournal() {
  journal = ACTIVE_BACKEND.load(STORAGE_KEY) || {};
  dirty = false;
  return { tokens: Object.keys(journal).length };
}

/**
 * Records what we scored a token at. Keyed by chain and token so it lines up
 * with the server's observation series without any extra bookkeeping.
 */
export function recordScore(chainKey, tokenAddress, { score, stage, flags }) {
  if (!tokenAddress || !Number.isFinite(score)) return;
  const key = chainKey + ':' + tokenAddress;
  const series = journal[key] || [];
  const now = Date.now();
  const last = series[series.length - 1];
  if (last && now - last.t < MARK_GAP_MS) return;

  const mark = { t: now, score, stage, flags: flags || [] };
  series.push(mark);
  if (series.length > MARK_MAX) series.shift();
  journal[key] = series;
  dirty = true;
}

/** The journal for one chain, shaped like the server's observations. */
export function journalFor(chainKey) {
  const out = {};
  Object.keys(journal).forEach((key) => {
    if (!key.startsWith(chainKey + ':')) return;
    out[key.slice(chainKey.length + 1)] = journal[key];
  });
  return out;
}

/**
 * Keeps, of marks older than MARK_FINE_MS, only the newest in each slice.
 * `series` is oldest first.
 */
function thin(series, fineFrom) {
  const out = [];
  for (let i = 0; i < series.length; i += 1) {
    const m = series[i];
    const next = series[i + 1];
    if (m.t >= fineFrom || !next ||
      Math.floor(next.t / MARK_SLICE_MS) !== Math.floor(m.t / MARK_SLICE_MS)) out.push(m);
  }
  return out;
}

/** Drops marks older than the longest horizon we measure, and thins the old end. */
export function pruneJournal() {
  const now = Date.now();
  const cutoff = now - MARK_MAX_AGE_MS;
  const fineFrom = now - MARK_FINE_MS;
  let removed = 0;
  Object.keys(journal).forEach((key) => {
    const kept = thin(journal[key].filter((m) => m.t >= cutoff), fineFrom);
    removed += journal[key].length - kept.length;
    if (kept.length) journal[key] = kept;
    else delete journal[key];
  });
  if (removed) dirty = true;
  return removed;
}

/** Writes only when something changed, so this is cheap to call on a timer. */
export function flushJournal() {
  if (!dirty) return false;
  const ok = ACTIVE_BACKEND.save(STORAGE_KEY, journal);
  if (ok) dirty = false;
  return ok;
}

export function journalStats() {
  const tokens = Object.keys(journal);
  const marks = tokens.reduce((sum, k) => sum + journal[k].length, 0);
  const times = tokens.flatMap((k) => (journal[k][0] ? [journal[k][0].t] : []));
  return {
    backend: ACTIVE_BACKEND.name,
    where: ACTIVE_BACKEND.describe(),
    tokens: tokens.length,
    marks,
    oldestMs: times.length ? Date.now() - Math.min(...times) : 0,
    pendingWrite: dirty,
  };
}

export function clearJournal() {
  journal = {};
  dirty = false;
  ACTIVE_BACKEND.clear(STORAGE_KEY);
}

/* ------------------------------------------------------- stage memory --- */

/**
 * The stage machine's memory rides in the same storage. The stage itself is
 * recomputed from the score every poll, so this is only about keeping "since
 * when" and the recent transitions across a reload.
 */
export function loadStageMemory() {
  return ACTIVE_BACKEND.load(STAGE_KEY) || null;
}

export function saveStageMemory(snapshot) {
  return ACTIVE_BACKEND.save(STAGE_KEY, snapshot);
}

/**
 * The rolling score window, for the same reason as the stage: without it a
 * reload resets every token's average to its momentary value and the board
 * jitters again until the window refills.
 */
export function loadScoreWindow() {
  return ACTIVE_BACKEND.load(SCORE_WINDOW_KEY) || null;
}

export function saveScoreWindow(snapshot) {
  return ACTIVE_BACKEND.save(SCORE_WINDOW_KEY, snapshot);
}
