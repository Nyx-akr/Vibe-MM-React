/**
 * Ethos reputation of the X account a token advertises.
 *
 * Reads the collector's `ethos.json` and answers one question per token: does
 * the account this project points at have a reputation, and is it good or bad?
 *
 * Why the account and not the wallet: Ethos scores EVM addresses and rejects
 * Solana ones outright, so an address-based read would blank our largest
 * chain. Handles have no such limit - measured on a live board, 89 of 91
 * tokens with an X link came back scored, across all eight chains.
 *
 * THE ONE THING TO GET RIGHT: an identity Ethos has never seen scores 0, not a
 * neutral default. Rendering that as "untrusted" would libel every project
 * that never joined Ethos - which is most of them. `unrated` is therefore a
 * state of its own here, distinct from a measured low score, and the panels
 * grey it rather than colouring it.
 *
 *   0        no record at all            -> unrated, grey
 *   < 1200   held against the account    -> flagged
 *   1200     exists, nothing either way  -> neutral
 *   > 1200   earned                      -> credited
 *
 * Nothing in this file is computed from anything but the raw file; the score
 * itself is Ethos's and is never recombined or averaged into ours.
 */

import { readRaw } from './storage/raw-store';

/** The score an identity starts at once it exists on Ethos. */
export const ETHOS_START = 1200;

const POLL_MS = 120000;

let data = null;
let lastReadAt = 0;
let lastError = null;
let timer = null;

const status = {
  polls: 0,
  errors: 0,
  handles: 0,
  tokens: 0,
  lastPolledAt: null,
  lastError: null,
};

async function poll() {
  try {
    const next = await readRaw('ethos.json');
    if (next) {
      data = next;
      lastReadAt = Date.now();
      status.handles = Object.keys(next.handles || {}).length;
      status.tokens = Object.values(next.tokens || {})
        .reduce((sum, perChain) => sum + Object.keys(perChain || {}).length, 0);
    }
    status.polls += 1;
    status.lastPolledAt = Date.now();
    lastError = null;
    status.lastError = null;
  } catch (error) {
    status.errors += 1;
    lastError = error.message;
    status.lastError = error.message;
  }
}

export function startEthosIntel() {
  if (timer) return;
  poll();
  timer = setInterval(poll, POLL_MS);
}

export function stopEthosIntel() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * Reputation for one token, or null when the collector has not written the
 * file yet. A token with no X link at all returns `{ linked: false }` - which
 * is itself worth showing, since advertising no account is a fact about the
 * project.
 */
export function ethosFor(chainKey, tokenAddress) {
  if (!data || !tokenAddress) return null;
  const perChain = (data.tokens || {})[chainKey] || {};
  const link = perChain[tokenAddress];
  if (!link) return { linked: false, handle: null, state: 'none' };

  const held = (data.handles || {})[link.handle] || null;
  const score = held && Number.isFinite(held.score) ? held.score : null;

  // 'post' handles come from a /status/ link, which names whoever wrote that
  // post - often not the project. Collected and shown, never presented as the
  // project's own account.
  const isProject = link.kind === 'profile';

  let state = 'unrated';
  if (score === null) state = 'pending';
  else if (score === 0) state = 'unrated';
  else if (score < ETHOS_START) state = 'flagged';
  else if (score > ETHOS_START) state = 'credited';
  else state = 'neutral';

  return {
    linked: true,
    isProject,
    kind: link.kind,
    handle: link.handle,
    url: link.url,
    from: link.from,
    symbol: link.symbol || null,
    score,
    level: held ? held.level : null,
    // Ethos labels a score of 0 "untrusted", which is its word for an identity
    // it has no record of. Printed as-is next to the score it reads as a
    // verdict on a project that simply never joined Ethos, so the label is
    // replaced for that one case. Every other level is Ethos's own word.
    levelLabel: score === 0 ? 'NO RECORD'
      : score === null ? 'PENDING'
      : String(held.level || '').toUpperCase(),
    at: held ? held.at : null,
    state,
    // How far from the starting score, which is the only part that carries
    // information. A raw 1185 looks like a number; -15 reads as "barely".
    delta: score === null || score === 0 ? null : score - ETHOS_START,
  };
}

/** Colour for a state, shared by every panel so one meaning has one colour. */
export function ethosColor(state) {
  if (state === 'flagged') return '#ff4fae';
  if (state === 'credited') return '#4d8dff';
  if (state === 'neutral') return '#8b96b8';
  return '#3a4568';
}

/** One short line a panel can print without restating the scale. */
export function ethosNote(rep) {
  if (!rep) return 'Ethos has not been collected yet.';
  if (!rep.linked) return 'This token advertises no X account.';
  if (rep.state === 'pending') return 'Not scored yet - the next Ethos pass will cover it.';
  if (rep.state === 'unrated') return 'No Ethos record for @' + rep.handle + '. Not a bad score - no score.';
  if (!rep.isProject) {
    return '@' + rep.handle + ' wrote the post this token links to; it is not necessarily the project.';
  }
  if (rep.state === 'flagged') {
    return '@' + rep.handle + ' is ' + rep.delta + ' below the Ethos starting score - reviews held against it.';
  }
  if (rep.state === 'credited') {
    return '@' + rep.handle + ' is +' + rep.delta + ' above the starting score, earned through vouches and reviews.';
  }
  return '@' + rep.handle + ' exists on Ethos with nothing recorded either way.';
}

/** Everything the board currently holds, for the scanner's own table. */
export function ethosBoard(chainKey) {
  if (!data) return [];
  const perChain = (data.tokens || {})[chainKey] || {};
  return Object.keys(perChain).map((tokenAddress) => {
    const rep = ethosFor(chainKey, tokenAddress);
    return Object.assign({ tokenAddress }, rep);
  }).filter((r) => r && r.linked);
}

/** The scale, as the collector wrote it - for the admin page to print. */
export const ethosScale = () => (data && data.scale) || null;

export function ethosStatus() {
  return Object.assign({}, status, {
    writtenAt: data ? data.writtenAt : null,
    ageMs: data && data.writtenAt ? Date.now() - data.writtenAt : null,
    lastReadAt,
    lastError,
    refreshMs: data ? data.refreshMs : null,
    api: data ? data.api : null,
  });
}
