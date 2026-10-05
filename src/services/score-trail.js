/**
 * The score trail: what we scored every token at, component by component,
 * for the last two weeks - so a score can be laid over what the price then
 * did, and the model judged against the real world.
 *
 * WHY NOT the score journal. The journal keeps only the headline score for
 * 50h, inside history-store, which hydrates EVERYTHING into RAM at boot and
 * rewrites whole blobs. A week of 14 components for every board token is tens
 * of MB - fine on disk, wrong in RAM. So the trail has its own IndexedDB
 * database, is never hydrated, and is read one token at a time, on demand.
 *
 * SHAPE. One record per token per UTC hour:
 *
 *   key    "<chain>:<token>:<hourStartMs>"     (13-digit ms, so keys sort by time)
 *   value  { k: [component keys], r: 1|5, m: [[t, avg, now, c0..cN], ...] }
 *
 * `k` travels with the data so a later change to the model cannot misread an
 * old mark. Marks are one a minute; hours older than a day are thinned to one
 * per 5 minutes (r: 5) - the headline is a 15-minute mean, so that loses no
 * shape - and hours older than KEEP_MS are deleted.
 *
 * Like the journal, this is the app store: nothing here ever reaches the
 * server. And like the journal, it only fills while the app is open - hours
 * nobody had it open have no marks.
 */

import { storeOrigin } from './storage/raw-store';

const DB_NAME = 'vibescreener-trails';
const STORE = 'trail';
const HOUR_MS = 3600000;
const MARK_GAP_MS = 60000;
const FLUSH_MS = 60000;
const THIN_AFTER_MS = 24 * HOUR_MS;
const THIN_TO_MS = 5 * 60000;
export const TRAIL_KEEP_MS = 14 * 24 * HOUR_MS;
const SWEEP_MS = HOUR_MS;

let db = null;
let opening = null;
let lastError = null;
const pending = new Map();   // "<chain>:<token>" -> { keys, marks: [] }
const lastMarkAt = new Map(); // "<chain>:<token>" -> t
let flushTimer = null;
let lastSweepAt = 0;
const stats = { marks: 0, flushes: 0, written: 0, thinned: 0, deleted: 0 };

function open() {
  if (db) return Promise.resolve(db);
  if (opening) return opening;
  opening = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { lastError = 'no IndexedDB'; resolve(null); return; }
    let request;
    try { request = indexedDB.open(DB_NAME, 1); } catch (e) { lastError = e.message; resolve(null); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => { db = request.result; resolve(db); };
    request.onerror = () => { lastError = String(request.error); resolve(null); };
    request.onblocked = () => { lastError = 'blocked by another tab'; resolve(null); };
  });
  return opening;
}

const hourOf = (t) => Math.floor(t / HOUR_MS) * HOUR_MS;
const recordKey = (id, hour) => id + ':' + String(hour).padStart(13, '0');
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);

/**
 * Remembers one scored row. Called for every token on every poll; keeps at
 * most one mark a minute per token and writes in batches.
 */
export function recordTrail(chainKey, tokenAddress, full) {
  if (!tokenAddress || !full || !Number.isFinite(full.score)) return;
  const id = chainKey + ':' + tokenAddress;
  const now = Date.now();
  if (now - (lastMarkAt.get(id) || 0) < MARK_GAP_MS) return;
  lastMarkAt.set(id, now);

  const parts = [...(full.scoreModel || []), ...(full.scoreModifiers || [])];
  const keys = parts.map((p) => p.key);
  const mark = [now, round1(full.score), round1(full.scoreNow), ...parts.map((p) => (p.pending ? null : round1(p.value)))];
  const entry = pending.get(id) || { keys, marks: [] };
  entry.keys = keys;
  entry.marks.push(mark);
  pending.set(id, entry);
  stats.marks += 1;
  if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; flushTrail(); }, FLUSH_MS);
}

/* ------------------------------------------------ the shared third store -- */

/**
 * Publishing: the same marks, posted to the server's app store so they outlive
 * this browser and every viewer sees them.
 *
 * Deliberately best-effort. The browser's own IndexedDB stays the source of
 * truth for this tab, so a refused or failed post costs nothing and is never
 * retried into a backlog - the next minute's batch carries on. The server
 * accepts writes from this machine only; a viewer's post is refused with a
 * 403, which is why the failure path here is silent rather than loud.
 */
const publishStats = { posts: 0, marks: 0, refused: 0, failed: 0, lastAt: null, lastError: null };

async function publishTrail(byChain) {
  const origin = storeOrigin();
  if (!origin) return;
  for (const [chain, payload] of byChain) {
    if (!payload.keys.length) continue;
    try {
      const res = await fetch(origin + '/app/trail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain, keys: payload.keys, tokens: payload.tokens }),
      });
      if (res.status === 403) { publishStats.refused += 1; continue; }
      if (!res.ok) { publishStats.failed += 1; continue; }
      const out = await res.json().catch(() => null);
      publishStats.posts += 1;
      publishStats.marks += (out && out.accepted) || 0;
      publishStats.lastAt = Date.now();
      publishStats.lastError = null;
    } catch (e) {
      publishStats.failed += 1;
      publishStats.lastError = e && e.message ? e.message : String(e);
    }
  }
}

/** Groups a flush batch by chain, in the shape the server's store accepts. */
function batchByChain(batch) {
  const byChain = new Map();
  batch.forEach(([id, entry]) => {
    const chain = id.slice(0, id.indexOf(':'));
    const token = id.slice(id.indexOf(':') + 1);
    if (!byChain.has(chain)) byChain.set(chain, { keys: entry.keys, tokens: {} });
    const bucket = byChain.get(chain);
    bucket.keys = entry.keys;
    bucket.tokens[token] = entry.marks;
  });
  return byChain;
}

/**
 * One token's marks from the shared store, for the hours the chart asks about.
 * Returns [] when the store has nothing - a viewer whose owner never ran the
 * server simply sees their own browser's trail.
 */
export async function readGlobalTrail(chainKey, tokenAddress, sinceMs) {
  const origin = storeOrigin();
  if (!origin) return { keys: [], marks: [] };
  const hours = [];
  for (let h = hourOf(sinceMs); h <= hourOf(Date.now()); h += HOUR_MS) hours.push(h);
  // A long range is a lot of hour files; they are small and ETagged, so this
  // is mostly 304s after the first read.
  const files = await Promise.all(hours.map((h) => fetch(origin + '/app/' + chainKey + '/trail/' + h + '.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)));

  const out = [];
  let keys = null;
  files.forEach((file) => {
    if (!file || !file.tokens) return;
    const marks = file.tokens[tokenAddress];
    if (!Array.isArray(marks)) return;
    keys = file.keys || keys;
    marks.forEach((m) => out.push(toMark(file.keys || [], m)));
  });
  return { keys: keys || [], marks: out };
}

export const trailPublishStats = () => Object.assign({}, publishStats);

function readRecords(store, keys) {
  return Promise.all(keys.map((key) => new Promise((resolve) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  })));
}

/** Appends the pending marks to their hour records. Safe to call any time. */
export async function flushTrail() {
  if (!pending.size) return 0;
  const database = await open();
  if (!database) return 0;
  const batch = [...pending.entries()];
  pending.clear();

  // Publish before the local write: the same batch, to the shared store. Not
  // awaited - a slow or absent server must never delay the local flush.
  publishTrail(batchByChain(batch));

  // Group every pending mark by the hour record it lands in.
  const byRecord = new Map();
  batch.forEach(([id, entry]) => {
    entry.marks.forEach((m) => {
      const key = recordKey(id, hourOf(m[0]));
      if (!byRecord.has(key)) byRecord.set(key, { keys: entry.keys, marks: [] });
      byRecord.get(key).marks.push(m);
    });
  });

  try {
    await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const keys = [...byRecord.keys()];
      readRecords(store, keys).then((existing) => {
        keys.forEach((key, i) => {
          const add = byRecord.get(key);
          const prior = existing[i];
          // A model change mid-hour starts the hour over rather than mixing layouts.
          const sameLayout = prior && prior.k && prior.k.join() === add.keys.join();
          const marks = (sameLayout ? prior.m : []).concat(add.marks);
          store.put({ k: add.keys, r: 1, m: marks }, key);
        });
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('aborted'));
    });
    stats.flushes += 1;
    stats.written += byRecord.size;
    lastError = null;
  } catch (e) {
    lastError = e && e.message ? e.message : String(e);
    // Put the marks back so a transient failure loses nothing.
    batch.forEach(([id, entry]) => {
      const cur = pending.get(id);
      pending.set(id, cur ? { keys: entry.keys, marks: entry.marks.concat(cur.marks) } : entry);
    });
  }
  if (Date.now() - lastSweepAt > SWEEP_MS) sweep();
  return byRecord.size;
}

/** Thins hours older than a day to 5-minute marks and deletes hours past retention. */
async function sweep() {
  lastSweepAt = Date.now();
  const database = await open();
  if (!database) return;
  const thinBefore = Date.now() - THIN_AFTER_MS;
  const dropBefore = Date.now() - TRAIL_KEEP_MS;
  await new Promise((resolve) => {
    const tx = database.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      const hour = Number(String(cursor.key).slice(-13));
      const value = cursor.value;
      if (hour + HOUR_MS < dropBefore) { cursor.delete(); stats.deleted += 1; }
      else if (hour + HOUR_MS < thinBefore && value && value.r === 1) {
        const kept = [];
        let slot = -1;
        // Newest mark per 5-minute slot: a mark that was observed, never an average.
        for (let i = value.m.length - 1; i >= 0; i -= 1) {
          const s = Math.floor(value.m[i][0] / THIN_TO_MS);
          if (s !== slot) { kept.unshift(value.m[i]); slot = s; }
        }
        cursor.update({ k: value.k, r: 5, m: kept });
        stats.thinned += 1;
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/**
 * One token's trail since `sinceMs`, oldest first:
 *   { keys: [...], marks: [{ t, avg, now, c: { key: value } }] }
 * Includes marks not yet flushed, so the chart reaches the last poll.
 */
export async function readTrail(chainKey, tokenAddress, sinceMs) {
  const id = chainKey + ':' + tokenAddress;
  const out = [];
  let keys = null;
  const database = await open();
  if (database) {
    const range = IDBKeyRange.bound(recordKey(id, hourOf(sinceMs)), recordKey(id, 9999999999999));
    const records = await new Promise((resolve) => {
      const req = database.transaction(STORE, 'readonly').objectStore(STORE).getAll(range);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    records.forEach((rec) => {
      keys = rec.k;
      rec.m.forEach((m) => out.push(toMark(rec.k, m)));
    });
  }
  const unsaved = pending.get(id);
  if (unsaved) { keys = unsaved.keys; unsaved.marks.forEach((m) => out.push(toMark(unsaved.keys, m))); }

  // The shared store fills the hours this browser was not open for - which,
  // for a viewer over the tunnel, is all of them. Merged on timestamp so a
  // mark this browser already has is not drawn twice.
  const global = await readGlobalTrail(chainKey, tokenAddress, sinceMs).catch(() => ({ keys: [], marks: [] }));
  if (global.marks.length) {
    const seen = new Set(out.map((m) => m.t));
    global.marks.forEach((m) => { if (!seen.has(m.t)) out.push(m); });
    keys = keys && keys.length ? keys : global.keys;
  }

  return { keys: keys || [], marks: out.filter((m) => m.t >= sinceMs).sort((a, b) => a.t - b.t) };
}

function toMark(keys, m) {
  const c = {};
  keys.forEach((k, i) => { c[k] = m[3 + i]; });
  return { t: m[0], avg: m[1], now: m[2], c };
}

export function trailStats() {
  return Object.assign({ backend: db ? 'indexeddb' : 'unopened', pendingTokens: pending.size, error: lastError }, stats);
}
