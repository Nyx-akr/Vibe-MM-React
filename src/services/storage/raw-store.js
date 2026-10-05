/**
 * Reads the raw store - the files the server's collectors write.
 *
 * This is the app's ONLY way to data. The server never answers the app and the
 * app never asks it for anything: collectors fetch from providers on their own
 * clock and write plain JSON files (see Vibe-mm-server/lib/raw-store.js), and
 * this module reads those files. Everything derived - scores, stages, wallet
 * and social reads, evaluation - is recomputed here from what was written.
 *
 * What the app computes stays in the app store (./history-store.js); nothing
 * computed ever goes back to the server.
 *
 * Reads are cheap to repeat. Each file carries an ETag; an unchanged file comes
 * back as a revalidated copy with the same ETag, and the parsed value from last
 * time is returned without parsing a byte - which is what lets the 5s board
 * poll and the megabyte social corpus share one simple read path.
 *
 * Imports nothing from the app, so any module can use it without a cycle.
 */

let base = '';

/** Points reads at a store origin. `origin` is the server's origin; files are under /raw. */
export function setRawOrigin(origin) {
  base = String(origin || '').replace(/\/+$/, '') + '/raw';
  cache.clear();
}

/** The URL of one raw file, for anything that wants to link to it. */
export const rawUrl = (rel) => base + '/' + String(rel || '').replace(/^\/+/, '');

/**
 * The store's origin without the /raw suffix, for the sibling APP store at
 * /app. Lives here because this module already owns "which server are we
 * talking to" and imports nothing from the app, so the trail can read it
 * without a cycle.
 */
export const storeOrigin = () => base.replace(/\/raw$/, '');

const cache = new Map();
const inflight = new Map();

const stats = {
  reads: 0, unchanged: 0, missing: 0, errors: 0, bytes: 0,
  lastError: null, lastReadAt: null,
};

/**
 * One raw file, parsed. Null when the collector has not written it yet.
 *
 * `maxAgeMs` skips the network entirely when the copy in hand is younger than
 * that - for files that change on a slow clock and are read on a fast one.
 * Throws when the store cannot be reached, so a caller can tell "no store"
 * from "not written yet".
 */
export async function readRaw(rel, { maxAgeMs = 0 } = {}) {
  const hit = cache.get(rel);
  if (hit && maxAgeMs && Date.now() - hit.at < maxAgeMs) return hit.value;
  if (inflight.has(rel)) return inflight.get(rel);

  const promise = (async () => {
    stats.reads += 1;
    let res;
    try {
      res = await fetch(rawUrl(rel), { headers: { Accept: 'application/json' }, cache: 'no-cache' });
    } catch (error) {
      stats.errors += 1;
      stats.lastError = error.message;
      throw error;
    }
    stats.lastReadAt = Date.now();
    if (res.status === 404) {
      stats.missing += 1;
      cache.set(rel, { etag: null, value: null, at: Date.now() });
      return null;
    }
    if (!res.ok) {
      stats.errors += 1;
      stats.lastError = 'HTTP ' + res.status + ' reading ' + rel;
      throw new Error(stats.lastError);
    }
    const etag = res.headers.get('ETag');
    if (hit && hit.value && etag && etag === hit.etag) {
      // Same file as last time: keep the parsed object, skip the body.
      stats.unchanged += 1;
      if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
      hit.at = Date.now();
      return hit.value;
    }
    const text = await res.text();
    stats.bytes += text.length;
    const value = JSON.parse(text);
    cache.set(rel, { etag, value, at: Date.now() });
    return value;
  })();

  inflight.set(rel, promise);
  try { return await promise; } finally { inflight.delete(rel); }
}

/** readRaw that answers `fallback` instead of throwing. */
export async function readRawQuiet(rel, fallback = null, options) {
  try {
    const value = await readRaw(rel, options);
    return value === null ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

/** How old a file's contents are, from the stamp the collector put on it. */
export function ageOf(file, now = Date.now()) {
  return file && Number.isFinite(file.writtenAt) ? Math.max(0, now - file.writtenAt) : null;
}

/** Is a store answering at this origin? Checks for OUR manifest, not just a 200. */
export async function probeRawStore(origin, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(String(origin || '').replace(/\/+$/, '') + '/raw/manifest.json', {
      signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-cache',
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body && body.service === 'vibescreener-raw-store');
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function rawStoreStats() {
  return Object.assign({ base, files: cache.size }, stats);
}
