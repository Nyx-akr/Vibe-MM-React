/**
 * THE BOARD FLOW - the DATA FLOW's board-wide boxes, run once per poll over
 * every token (the score flow runs per token; these read the whole board).
 *
 * Same ids as their boxes on the map (BOARD STATS, the ALERT ENGINE service,
 * MARKET REGIME), standard wire types (flow/types.js), and the map's edits
 * obeyed: a box deleted or cut off produces nothing. The header reads these
 * values, so its numbers are the flow's.
 */

import { missingIds } from './runtime.js';
import { getSetting } from '../admin/box-settings';
import { REGIME_SETTING, REGIME_DEFAULT } from '../data/regimes';
import { walletIntelStatus } from '../services/wallet-intel';
import { rotationIntelStatus } from '../services/rotation-intel';
import { socialIntelStatus } from '../services/social-intel';
import { coerce } from './types';

const B = (label) => 'f:pipe:' + label;
const STAGE_NAMES = ['', 'EMERGING', 'CONFIRMED', 'EXCEPTIONAL', 'VETOED'];

/** Each board box's wire type. */
export const BOARD_TYPES = {
  [B('TOKEN LIST')]: 'list',
  [B('TOKENS TRACKED')]: 'number',
  [B('STAGE COUNTS')]: 'dict',
  [B('AVG ORGANIC SCORE')]: 'number',
  [B('DAILY PICK')]: 'text',
  [B('ALERT ENGINE')]: 'dict',
  [B('ALERTS NOW')]: 'number',
  [B('MARKET REGIME')]: 'text',
  // The services: each a dict of its own state.
  [B('WALLET INTEL')]: 'dict',
  [B('ROTATION SERVICE')]: 'dict',
  [B('SOCIAL BASELINE')]: 'dict',
  [B('SYSTEM HEALTH')]: 'dict',
  [B('SCORE EVALUATION')]: 'dict',
  [B('FORWARD RETURNS')]: 'dict',
  [B('TOP 20 HIT RATE')]: 'number',
  // The selected token's social numbers and the selector itself.
  [B('MENTIONS')]: 'number',
  [B('UNIQUE AUTHORS')]: 'number',
  [B('MENTIONS PER AUTHOR')]: 'number',
  [B('VS SOCIAL BASELINE')]: 'number',
  [B('THIS TOKEN')]: 'text',
};

let current = {};
/** The last poll's board values, by box id. */
export const boardValues = () => current;

/**
 * assets   the scored tokens (ungated)
 * extra    what the app's own tabs produced: { alertColumns, dailyPick,
 *          health, precision, outcomes, evalOutcome, socialStats, selected }
 */
export function runBoardFlow(assets, extra = {}) {
  const missing = missingIds();
  const vals = {};
  const set = (label, fn) => {
    const id = B(label);
    if (missing.has(id)) { vals[id] = null; return; }
    let x = null;
    try { x = fn(); } catch (e) { x = null; }
    vals[id] = x === undefined ? null : x;
  };
  const list = assets || [];
  set('TOKEN LIST', () => list.map((a) => a.sym));
  // A COUNT of the list on its wire.
  set('TOKENS TRACKED', () => (Array.isArray(vals[B('TOKEN LIST')]) ? vals[B('TOKEN LIST')].length : null));
  set('STAGE COUNTS', () => {
    const m = {};
    list.forEach((a) => { const k = STAGE_NAMES[a.stage] || String(a.stage); m[k] = (m[k] || 0) + 1; });
    return m;
  });
  // Our own organic score only, each token weighted by how much of it resolved.
  set('AVG ORGANIC SCORE', () => {
    const ours = list.map((a) => (a.rawServerRow || {}).organicFlow)
      .filter((o) => o && o.score !== null && o.basis === 'sample');
    if (!ours.length) return null;
    const w = (o) => Math.max(o.coverage, 25);
    return Math.round(ours.reduce((s, o) => s + o.score * w(o), 0) / ours.reduce((s, o) => s + w(o), 0));
  });
  set('DAILY PICK', () => (extra.dailyPick && extra.dailyPick !== '—' ? extra.dailyPick : null));
  set('ALERT ENGINE', () => {
    if (!Array.isArray(extra.alertColumns)) return null;
    const m = {};
    extra.alertColumns.forEach((c) => { m[c.title || c.label || c.name] = (c.cards || c.items || []).length; });
    return m;
  });
  set('ALERTS NOW', () => {
    const d = vals[B('ALERT ENGINE')];
    return d ? Object.values(d).reduce((a, b) => a + b, 0) : null;
  });
  set('MARKET REGIME', () => getSetting(REGIME_SETTING, { id: REGIME_DEFAULT }).id);

  // The services' state, as dicts.
  const dict = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
  set('WALLET INTEL', () => dict(walletIntelStatus()));
  set('ROTATION SERVICE', () => dict(rotationIntelStatus()));
  set('SOCIAL BASELINE', () => dict(socialIntelStatus()));
  set('SYSTEM HEALTH', () => dict(extra.health));
  set('SCORE EVALUATION', () => dict(extra.evalOutcome));
  set('FORWARD RETURNS', () => dict(extra.outcomes));
  // A share 0-1, not "43%".
  set('TOP 20 HIT RATE', () => {
    const p = extra.precision;
    const x = p && (p.precision ?? p.value);
    return Number.isFinite(x) ? x : null;
  });

  // The selected token's social numbers, raw.
  const tile = (label) => {
    const t = (extra.socialStats || []).find((x) => x && (x.label === label || String(x.label).indexOf(label + ' ') === 0));
    return t ? coerce(t.value, 'number') : null;
  };
  set('MENTIONS', () => tile('MENTIONS'));
  set('UNIQUE AUTHORS', () => tile('UNIQUE AUTHORS'));
  set('MENTIONS PER AUTHOR', () => {
    const m = vals[B('MENTIONS')]; const u = vals[B('UNIQUE AUTHORS')];
    return Number.isFinite(m) && Number.isFinite(u) && u > 0 ? Math.round((m / u) * 100) / 100 : null;
  });
  set('VS SOCIAL BASELINE', () => tile('VS BASELINE'));
  set('THIS TOKEN', () => (extra.selected ? extra.selected : null));
  current = vals;
  return vals;
}
