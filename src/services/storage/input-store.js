/**
 * The input store: everything the USER chose.
 *
 * Watchlist, wallet registry, which server to talk to - and whatever gets
 * added next. These are small, they are read during render, and losing one is
 * an annoyance rather than a gap in the record. localStorage is the right tool
 * for exactly that: synchronous, so a render can read it without an await, and
 * a few KB is nowhere near the quota.
 *
 * This is deliberately NOT the same store as the history (see
 * ./history-store.js). Keeping them apart means a corrupt or oversized history
 * can never cost the user their watchlist, the two can be cleared
 * independently, and an export of "my settings" does not drag a day of samples
 * along with it.
 *
 * TO ADD A NEW INPUT: add one line to INPUTS. That is the whole step - it
 * gains persistence, a default, validation on read, and a place in export().
 */

const PREFIX = 'vs_';

/**
 * Every persisted user input, with the default used when nothing is stored
 * and the shape check applied on read. The check is what stops a hand-edited
 * or half-migrated value from reaching render code as the wrong type.
 */
const INPUTS = {
  watchlist:     { key: 'vs_watchlist',       fallback: () => ({}), valid: (v) => v && typeof v === 'object' && !Array.isArray(v) },
  walletRegistry:{ key: 'vs_wallet_registry', fallback: () => null, valid: (v) => Array.isArray(v) },
  // RETIRED 2026-10-08 with the AUTO / LOCAL / DEPLOYED switch. Kept only so
  // services/api.js can clear a value an old browser still holds.
  apiTarget:     { key: 'vs_api_target',      fallback: () => null, valid: (v) => v === 'local' || v === 'remote' },
  // The board's chain chips: { SOL: true, ETH: true, ... }. Absent means ALL.
  chainSelection:{ key: 'vs_chain_selection', fallback: () => null, valid: (v) => v && typeof v === 'object' && !Array.isArray(v) },
  // The STAGES bar: { '1': true, ... } for WATCH..EXCEPTIONAL. Absent means all.
  stageSelection:{ key: 'vs_stage_selection', fallback: () => null, valid: (v) => v && typeof v === 'object' && !Array.isArray(v) },
};

let lastError = null;

function raw(key) {
  try {
    return window.localStorage.getItem(key);
  } catch (e) {
    // Private windows and blocked site data both throw here.
    lastError = e.message;
    return null;
  }
}

/**
 * Reads one input. Returns the default when it is missing, unparseable, or
 * fails its shape check - never a half-valid value.
 */
export function getInput(name) {
  const spec = INPUTS[name];
  if (!spec) throw new Error('unknown input: ' + name);
  const text = raw(spec.key);
  if (text === null) return spec.fallback();
  // apiTarget is stored as a bare string, not JSON, because the admin panel
  // and api.js have always written it that way.
  if (name === 'apiTarget') return spec.valid(text) ? text : spec.fallback();
  try {
    const parsed = JSON.parse(text);
    return spec.valid(parsed) ? parsed : spec.fallback();
  } catch (e) {
    return spec.fallback();
  }
}

export function setInput(name, value) {
  const spec = INPUTS[name];
  if (!spec) throw new Error('unknown input: ' + name);
  try {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(spec.key);
      return true;
    }
    window.localStorage.setItem(spec.key, name === 'apiTarget' ? String(value) : JSON.stringify(value));
    return true;
  } catch (e) {
    lastError = e.message;
    return false;
  }
}

export function removeInput(name) { return setInput(name, null); }

/** Everything at once, for an export or a settings panel. */
export function exportInputs() {
  const out = {};
  Object.keys(INPUTS).forEach((name) => { out[name] = getInput(name); });
  return out;
}

export function inputNames() { return Object.keys(INPUTS); }

/** Per-input detail for the admin panel's storage view. */
export function inputBreakdown() {
  return Object.keys(INPUTS).map((name) => {
    const spec = INPUTS[name];
    const text = raw(spec.key);
    const value = getInput(name);
    let entries = null;
    if (Array.isArray(value)) entries = value.length;
    else if (value && typeof value === 'object') entries = Object.keys(value).length;
    return {
      name: name,
      key: spec.key,
      stored: text !== null,
      bytes: text === null ? 0 : text.length,
      entries: entries,
      // A stored value that fails its own check means something wrote a shape
      // we would now reject - worth seeing rather than silently defaulting.
      valid: text === null ? null : isValid(name, text),
    };
  });
}

function isValid(name, text) {
  const spec = INPUTS[name];
  if (name === 'apiTarget') return spec.valid(text);
  try { return spec.valid(JSON.parse(text)); } catch (e) { return false; }
}

/** Mirrors history-store's storageHealth() so both halves grade the same. */
export function inputHealth() {
  const problems = [];
  let level = 'ok';

  try {
    const probe = '__vs_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
  } catch (e) {
    return {
      level: 'failed',
      summary: 'localStorage is blocked - your choices will not survive a reload.',
      problems: [e.message],
    };
  }

  inputBreakdown().forEach((row) => {
    if (row.stored && row.valid === false) {
      level = 'degraded';
      problems.push(row.key + ' holds a value that fails its shape check; the default is being used.');
    }
  });

  if (lastError) {
    level = level === 'ok' ? 'degraded' : level;
    problems.push('Last error: ' + lastError);
  }

  return {
    level,
    summary: level === 'ok' ? 'Saving to localStorage.' : 'Saving, but something stored is malformed.',
    problems,
  };
}

export function inputStats() {
  let bytes = 0;
  let stored = 0;
  Object.keys(INPUTS).forEach((name) => {
    const text = raw(INPUTS[name].key);
    if (text === null) return;
    stored += 1;
    bytes += text.length;
  });
  return {
    backend: 'localStorage',
    where: 'this browser',
    inputs: Object.keys(INPUTS).length,
    stored: stored,
    approxBytes: bytes,
    error: lastError,
  };
}
