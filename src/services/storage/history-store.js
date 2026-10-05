/**
 * The fast store: one day of history, in IndexedDB.
 *
 * WHY NOT localStorage, which is what every one of these memories used before.
 * localStorage is synchronous and capped around 5MB per origin. The wallet
 * memory (4000 wallets, 200 clusters) and the social memory (600 tokens x 240
 * samples) are each megabyte-scale, and the services re-JSON.stringify the
 * WHOLE blob on a timer. That is a main-thread stall on every persist, and the
 * cap is close enough that a busy session can start silently failing to save -
 * localStorage throws on quota and the old code swallowed it and returned
 * false. IndexedDB is async, structured, and measured in hundreds of MB.
 *
 * SHAPE: hydrate once, read synchronously, write through.
 *
 * The services that use this already keep everything in RAM and only persist
 * periodically - they were built against a synchronous backend and read at
 * module load. So this store hydrates the whole thing into a Map ONCE at boot
 * (before the pollers start), serves `get` from that Map synchronously, and
 * pushes writes to IndexedDB in the background. Call sites keep their shape;
 * only the boot sequence gained an await.
 *
 * Everything here degrades rather than throws. A private window, blocked site
 * data or a browser without IndexedDB falls back to localStorage, and if that
 * fails too the store runs RAM-only for the session and says so in describe().
 */

const DB_NAME = 'vibescreener';
const DB_VERSION = 1;
const STORE = 'history';

/** How long writes are coalesced. The tick is far faster than disk wants. */
const WRITE_DEBOUNCE_MS = 2000;

let db = null;
let mode = 'idle';          // idle | indexeddb | localstorage | memory
let lastError = null;

const cache = new Map();    // key -> value, the synchronous read path
const dirty = new Set();
let writeTimer = null;
let writes = 0;
let hydrated = false;

/* ------------------------------------------------------------ indexeddb -- */

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e);
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB open failed'));
    // Another tab holding an older version blocks the upgrade forever, which
    // would hang boot; treat it as unavailable and fall back instead.
    request.onblocked = () => reject(new Error('indexedDB blocked by another tab'));
  });
}

function idbReadAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const out = new Map();
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) { resolve(out); return; }
      out.set(cursor.key, cursor.value);
      cursor.continue();
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
}

function idbWrite(entries) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    entries.forEach(([key, value]) => {
      if (value === undefined) store.delete(key);
      else store.put(value, key);
    });
    tx.oncomplete = () => resolve(entries.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('write aborted'));
  });
}

/* ----------------------------------------------------------- fallbacks --- */

const LS_PREFIX = 'vs_hist_';

function lsReadAll() {
  const out = new Map();
  try {
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(LS_PREFIX)) continue;
      try {
        out.set(key.slice(LS_PREFIX.length), JSON.parse(window.localStorage.getItem(key)));
      } catch (e) { /* a corrupt entry is dropped, not fatal */ }
    }
  } catch (e) { /* blocked site data */ }
  return out;
}

function lsWrite(entries) {
  entries.forEach(([key, value]) => {
    try {
      if (value === undefined) window.localStorage.removeItem(LS_PREFIX + key);
      else window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
    } catch (e) { lastError = e.message; }
  });
  return Promise.resolve(entries.length);
}

/* ---------------------------------------------------------------- api --- */

/**
 * Loads everything into RAM. Must be awaited before any service that reads
 * this store starts polling, or the first tick sees an empty memory and
 * rebuilds history that was already on disk.
 */
export async function hydrate() {
  if (hydrated) return { mode, keys: cache.size };
  try {
    db = await openDb();
    const loaded = await idbReadAll();
    loaded.forEach((value, key) => cache.set(key, value));
    mode = 'indexeddb';
    // A previous load may have fallen back to localStorage and written there.
    // Leaving those behind would split the memory across two backends that
    // then diverge, so they are pulled in and removed. Anything IndexedDB
    // already holds wins, because it is the backend we are now on.
    reclaimFallback();
  } catch (error) {
    lastError = error.message;
    const loaded = lsReadAll();
    loaded.forEach((value, key) => cache.set(key, value));
    mode = canUseLocalStorage() ? 'localstorage' : 'memory';
  }
  hydrated = true;
  return { mode, keys: cache.size, error: lastError };
}

function canUseLocalStorage() {
  try {
    const probe = '__vs_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch (e) {
    return false;
  }
}

/** Moves any localStorage-fallback entries into IndexedDB and clears them. */
function reclaimFallback() {
  const stranded = lsReadAll();
  if (!stranded.size) return;
  let moved = 0;
  stranded.forEach((value, key) => {
    if (!cache.has(key)) { cache.set(key, value); dirty.add(key); moved += 1; }
    try { window.localStorage.removeItem(LS_PREFIX + key); } catch (e) { /* blocked */ }
  });
  if (moved) {
    schedule();
    console.log('storage: reclaimed ' + moved + ' key(s) from the localStorage fallback');
  }
}

/** Synchronous, from the hydrated cache. */
export function get(key) {
  const value = cache.get(key);
  return value === undefined ? null : value;
}

/** Updates RAM immediately; disk catches up on the debounce. */
export function put(key, value) {
  cache.set(key, value);
  dirty.add(key);
  schedule();
  return true;
}

export function remove(key) {
  cache.delete(key);
  dirty.add(key);
  schedule();
}

function schedule() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; flush(); }, WRITE_DEBOUNCE_MS);
}

/** Writes everything dirty. Safe to call at any time; no-op when clean. */
export function flush() {
  if (!dirty.size) return Promise.resolve(0);
  const entries = Array.from(dirty).map((key) => [key, cache.get(key)]);
  dirty.clear();
  const write = mode === 'indexeddb' ? idbWrite(entries) : lsWrite(entries);
  return write
    .then((n) => { writes += n; return n; })
    .catch((error) => {
      lastError = error.message;
      // Put them back so the next flush retries rather than losing the write.
      entries.forEach(([key]) => dirty.add(key));
      return 0;
    });
}

export function storageStats() {
  let bytes = 0;
  cache.forEach((value) => {
    try { bytes += JSON.stringify(value).length; } catch (e) { /* cyclic */ }
  });
  return {
    backend: mode,
    where: describe(),
    keys: cache.size,
    approxBytes: bytes,
    pendingWrite: dirty.size,
    writes: writes,
    error: lastError,
  };
}

export function describe() {
  if (mode === 'indexeddb') return 'this browser (IndexedDB)';
  if (mode === 'localstorage') return 'this browser (localStorage fallback)';
  if (mode === 'memory') return 'memory only - nothing is being saved';
  return 'not yet opened';
}

export function keys() { return Array.from(cache.keys()); }

/**
 * What each key actually holds, for the admin panel's storage view.
 *
 * `entries` is a per-key count of the thing that key is a memory OF - tokens
 * for the journal, wallets for the wallet memory - rather than a generic
 * object key count, because "4000" means something and "2" does not.
 */
export function breakdown() {
  const rows = [];
  cache.forEach((value, key) => {
    let bytes = 0;
    try { bytes = JSON.stringify(value).length; } catch (e) { /* cyclic */ }
    rows.push({
      key: key,
      bytes: bytes,
      entries: countEntries(key, value),
      savedAt: (value && value.savedAt) || null,
      pending: dirty.has(key),
    });
  });
  return rows.sort((a, b) => b.bytes - a.bytes);
}

/** Each memory stores a different shape, so the count is per key. */
function countEntries(key, value) {
  if (!value || typeof value !== 'object') return null;
  if (key === 'wallet-memory') {
    return (value.wallets || []).length;
  }
  if (key === 'social-memory') {
    return (value.tokens || []).length;
  }
  if (key === 'score-journal') {
    // One property per chain:token, each an array of marks.
    return Object.keys(value).length;
  }
  if (key === 'stage-memory') {
    return Object.keys(value).length;
  }
  return Array.isArray(value) ? value.length : Object.keys(value).length;
}

/** Marks in the journal / clusters in the wallet memory - the deep counts. */
export function deepCounts() {
  const journal = cache.get('score-journal');
  const wallet = cache.get('wallet-memory');
  const social = cache.get('social-memory');
  let marks = 0;
  if (journal && typeof journal === 'object') {
    Object.keys(journal).forEach((k) => {
      if (Array.isArray(journal[k])) marks += journal[k].length;
    });
  }
  let samples = 0;
  if (social && Array.isArray(social.tokens)) {
    social.tokens.forEach((t) => { samples += (t && t.series ? t.series.length : 0); });
  }
  return {
    journalTokens: journal ? Object.keys(journal).length : 0,
    journalMarks: marks,
    wallets: wallet && wallet.wallets ? wallet.wallets.length : 0,
    clusters: wallet && wallet.clusters ? wallet.clusters.length : 0,
    socialTokens: social && social.tokens ? social.tokens.length : 0,
    socialSamples: samples,
  };
}

/**
 * Is the browser side actually saving? Mirrors the server's store.health()
 * so the panel can grade both halves the same way.
 */
export function storageHealth() {
  const problems = [];
  let level = 'ok';

  if (mode === 'memory') {
    return {
      level: 'failed',
      summary: 'Nothing is being saved - this session only.',
      problems: [lastError || 'no IndexedDB and no localStorage'],
    };
  }
  if (mode === 'localstorage') {
    level = 'degraded';
    problems.push('IndexedDB unavailable, using the localStorage fallback: ' +
      (lastError || 'unknown reason') + '. The ~5MB quota applies and large memories may fail to save.');
  }
  if (mode === 'idle') {
    return { level: 'failed', summary: 'Store never opened.', problems: ['hydrate() has not run'] };
  }
  if (lastError && mode === 'indexeddb') {
    level = level === 'ok' ? 'degraded' : level;
    problems.push('Last error: ' + lastError);
  }
  if (dirty.size > 0) {
    problems.push(dirty.size + ' key(s) waiting to be written (normal between flushes).');
  }

  return {
    level,
    summary: level === 'ok'
      ? 'Saving to IndexedDB.'
      : level === 'degraded' ? 'Saving, but not on the intended backend.' : 'Not saving.',
    problems,
  };
}

/** Drops everything. Used by the admin panel's reset. */
export function clearAll() {
  const all = Array.from(cache.keys());
  cache.clear();
  all.forEach((key) => dirty.add(key));
  return flush();
}
