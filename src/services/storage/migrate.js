/**
 * One-time move of the old flat localStorage keys into the two stores.
 *
 * Before this, seven keys sat side by side in localStorage with no distinction
 * between "a day of samples" and "what the user picked". Four of them were
 * history and belong in the fast store; three were user input and stay in
 * localStorage, already under the names the input store expects - so those
 * need no move at all, only leaving alone.
 *
 * The history keys ARE removed from localStorage once copied, which is the
 * point: they were the megabyte-scale ones crowding the ~5MB quota that the
 * watchlist also lives in.
 *
 * Runs once. It is safe to call on every boot: after the first pass the old
 * keys are gone, so it finds nothing and returns immediately.
 */

import * as history from './history-store';

/** old localStorage key -> key inside the history store */
const MOVES = {
  vs_score_journal: 'score-journal',
  vs_stage_memory: 'stage-memory',
  vs_wallet_memory: 'wallet-memory',
  vs_social_memory: 'social-memory',
};

const DONE_FLAG = 'vs_storage_migrated_v1';

export async function migrateLegacyStorage() {
  const result = { ran: false, moved: [], skipped: [], failed: [], bytes: 0 };

  let already = null;
  try { already = window.localStorage.getItem(DONE_FLAG); } catch (e) { return result; }
  if (already) return result;

  result.ran = true;

  Object.keys(MOVES).forEach((oldKey) => {
    let text = null;
    try { text = window.localStorage.getItem(oldKey); } catch (e) { /* blocked */ }
    if (text === null) { result.skipped.push(oldKey); return; }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // Unparseable legacy data is dropped rather than carried forward - it
      // could not have been read by the old code either.
      result.failed.push(oldKey);
      try { window.localStorage.removeItem(oldKey); } catch (err) { /* blocked */ }
      return;
    }

    history.put(MOVES[oldKey], parsed);
    result.moved.push(oldKey);
    result.bytes += text.length;
  });

  // Only drop the originals once the copies are actually on disk. Removing
  // them on the optimistic path would lose the data if the write failed.
  await history.flush();

  result.moved.forEach((oldKey) => {
    try { window.localStorage.removeItem(oldKey); } catch (e) { /* blocked */ }
  });
  try { window.localStorage.setItem(DONE_FLAG, String(Date.now())); } catch (e) { /* blocked */ }
  if (result.moved.length) {
    console.log('storage: migrated ' + result.moved.length + ' history keys (' +
      Math.round(result.bytes / 1024) + 'KB) out of localStorage');
  }
  return result;
}
