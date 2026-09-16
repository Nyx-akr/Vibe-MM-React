/**
 * The score journal.
 *
 * The server stores raw prices; it cannot store scores any more, because it
 * does not compute them. So the app keeps its own record of what it scored,
 * when, and with which flags. The Evaluation tab joins this journal to the
 * server's raw price series by timestamp to measure whether a score meant
 * anything.
 *
 * STORAGE IS DELIBERATELY BEHIND ONE INTERFACE.
 *
 * Right now it writes to localStorage, which means the journal is per-browser:
 * it survives reloads but not a different machine, and it is not shared with
 * anyone else. That is a stopgap. To move to a file on a laptop, or a cloud
 * store, implement the same four methods and swap ACTIVE_BACKEND - nothing
 * else in the app needs to change.
 *
 *   load()          -> the whole journal object, or null
 *   save(data)      -> persist it
 *   clear()         -> drop it
 *   describe()      -> a label for the UI, so the user can see where it lives
 */

const STORAGE_KEY = 'vs_score_journal';
const STAGE_KEY = 'vs_stage_memory';

/* ------------------------------------------------------------- backends -- */

/** Per-browser, no setup, lost if site data is cleared. */
const localStorageBackend = {
  name: 'localStorage',
  describe: () => 'this browser only',
  load(key) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      // Private windows and blocked site data both throw here.
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
  clear(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* nothing to do */ }
  },
};

/**
 * The next step: a journal the server holds, so every device sees the same
 * history. Needs a write endpoint on the server, which today is read-only by
 * design - so this is left unimplemented rather than half-wired.
 *
 * To switch: implement these against the endpoint and set ACTIVE_BACKEND.
 */
// const remoteBackend = {
//   name: 'remote',
//   describe: () => 'shared server store',
//   async load(key) { ... },
//   async save(key, data) { ... },
//   async clear(key) { ... },
// };

const ACTIVE_BACKEND = localStorageBackend;

export const journalBackend = {
  name: ACTIVE_BACKEND.name,
  describe: ACTIVE_BACKEND.describe(),
};

/* -------------------------------------------------------------- journal -- */

// One mark per token per interval. 60s matches the server's observation
// cadence, so a mark can always find a price near it.
const MARK_GAP_MS = 60000;
// ~25h of marks per token at 60s, which is what a 24h horizon needs.
const MARK_MAX = 1500;
const MARK_MAX_AGE_MS = 26 * 3600000;

let journal = ACTIVE_BACKEND.load(STORAGE_KEY) || {};
let dirty = false;

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

  series.push({ t: now, score, stage, flags: flags || [] });
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

/** Drops marks older than the longest horizon we measure. */
export function pruneJournal() {
  const cutoff = Date.now() - MARK_MAX_AGE_MS;
  let removed = 0;
  Object.keys(journal).forEach((key) => {
    const kept = journal[key].filter((m) => m.t >= cutoff);
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
 * The stage machine's memory rides in the same storage. Without it, every
 * reload would reset hysteresis and stages would flicker for the first few
 * minutes of each session.
 */
export function loadStageMemory() {
  return ACTIVE_BACKEND.load(STAGE_KEY) || null;
}

export function saveStageMemory(snapshot) {
  return ACTIVE_BACKEND.save(STAGE_KEY, snapshot);
}
