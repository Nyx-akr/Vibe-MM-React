/**
 * THE FLOW DECIDES WHAT THE APP SHOWS.
 *
 * The DATA FLOW map is the app's wiring, not a picture of it: a box deleted
 * or a wire cut on the map (in the active flow) cuts the data off downstream,
 * exactly as the map draws it in red - and a DASHBOARD ITEM that no longer
 * receives its data shows nothing in the app. Cut FINAL from the board's
 * SCORE and the score disappears from the board and the navbar.
 *
 * This is the same propagation FlowChart.jsx draws (its `edited` memo): from
 * every deleted box and every cut wire, everything downstream is missing.
 */

import { buildGraph } from '../admin/graph.js';
import { activeFlow } from '../admin/flow-store';
import { hierarchy } from '../admin/engines.js';
import { userWires } from './wires';
import { coerce } from './types';
import { boardValues } from './board-flow';

let cache = { key: null, missing: new Set(), cut: new Set(), reroute: new Map() };

/**
 * Every box the active flow cuts off: the boxes deleted on the map, and all
 * that the map marks red downstream of a deleted box or a cut wire.
 */
export function missingIds() {
  let doc = null;
  try { doc = activeFlow(); } catch (e) { return cache.missing; }
  const cfg = doc.cfg || {};
  const deleted = cfg.deleted || {};
  const drawn = (cfg.sketch || []).filter((s) => s.toPort);
  const key = doc.id + ':' + JSON.stringify(deleted) + ':' + (cfg.cutWires || []).join('|') + ':' + JSON.stringify(drawn);
  if (cache.key === key) return cache.missing;

  const missing = new Set();
  let reroute = new Map();
  if (Object.keys(deleted).length || (cfg.cutWires || []).length || drawn.length) {
    let g = null;
    try { g = buildGraph(); } catch (e) { g = null; }
    if (g) {
      // The wires the user drew into dots (flow/wires.js), as on the map.
      const H = hierarchy(cfg, g.nodes);
      const inside = (id, target) => id === target || H.ancestors(id).indexOf(target) !== -1;
      const uw = userWires({ edges: g.edges, sketch: cfg.sketch, cut: new Set(cfg.cutWires || []), inside });
      const cutWires = uw.cut;
      reroute = uw.reroute;
      const edges = g.edges.filter((e) => !uw.replaced.has(e.from + '>' + e.to)).concat(uw.extra);
      const out = new Map();
      edges.forEach((e) => { if (e.soft) return; if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push(e); });
      const queue = [];
      const mark = (id) => { if (!missing.has(id)) { missing.add(id); queue.push(id); } };
      Object.keys(deleted).forEach(mark);
      edges.forEach((e) => { if (cutWires.has(e.from + '>' + e.to)) mark(e.to); });
      while (queue.length) (out.get(queue.shift()) || []).forEach((e) => mark(e.to));
    }
  }
  const cut = new Set(Array.from(missing).filter((id) => String(id).indexOf('f:dash:') === 0));
  cache = { key, missing, cut, reroute };
  return missing;
}

/** Inputs the user re-fed on the map: box id → { input id: new source id }. */
export function reroutes() {
  missingIds();
  return cache.reroute;
}

/** The DASHBOARD ITEM ids (f:dash:…) that are cut off in the active flow. */
export function cutItems() {
  missingIds();
  return cache.cut;
}

const item = (tab, panel, label) => 'f:dash:' + tab + ' › ' + panel + ' › ' + label;
const isCut = (tab, panel, label) => cutItems().has(item(tab, panel, label));

/*
 * Which asset field each board item delivers. A cut item empties its field
 * on every token, which every view of it then shows as '—'.
 */
const BOARD_FIELDS = [
  ['SCORE', ['score']], ['CONF', ['conf']], ['PRICE', ['price']], ['DELTA 5M', ['chg']],
  ['LIQUIDITY', ['liq']], ['VOL 5M', ['vol', 'adj']], ['WASH', ['wash']], ['BUYERS', ['buyers']],
  ['AGE', ['age']],
];

/** A box's value as a plain number or word, for a field the board shows. */
const plain = (x) => {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number' || typeof x === 'string') return x;
  for (const k of ['value', 'raw', 'average', 'stage']) if (x[k] !== undefined && x[k] !== null && typeof x[k] !== 'object') return x[k];
  return null;
};

/** The tokens as the flow delivers them: cut items emptied, re-fed items re-fed. */
export function gateAssets(assets) {
  const cut = cutItems();
  const rr = reroutes();
  const off = BOARD_FIELDS.filter(([label]) => isCut('LIVE OPPORTUNITIES', 'BOARD', label)).flatMap(([, keys]) => keys);
  // A board item fed on the map from another box shows that box's value.
  const fed = [];
  BOARD_FIELDS.forEach(([label, keys]) => {
    const m = rr.get(item('LIVE OPPORTUNITIES', 'BOARD', label));
    if (!m) return;
    const src = Object.values(m)[0];
    if (src && !isCut('LIVE OPPORTUNITIES', 'BOARD', label)) fed.push([keys, src]);
  });
  if (!off.length && !fed.length) return assets;
  return (assets || []).map((a) => {
    const next = { ...a };
    off.forEach((k) => { next[k] = null; });
    const fv = (a.rawServerRow || {}).flowValues || {};
    const bv = boardValues();
    // What arrives on the wire, converted the standard way to the number the
    // board shows (a list arrives as its length - TOKEN LIST → 124).
    fed.forEach(([keys, src]) => keys.forEach((k) => {
      const x = src in fv ? fv[src] : (src in bv ? bv[src] : null);
      next[k] = coerce(x, 'number');
    }));
    return next;
  });
}

/** The header tiles as the flow delivers them. */
export function gateStats(stats) {
  if (!cutItems().size) return stats;
  return (stats || []).map((s) => {
    const label = String(s.label || '');
    const name = label.indexOf('TOP 20 HIT RATE') === 0 ? 'TOP 20 HIT RATE' : label;
    return isCut('LIVE OPPORTUNITIES', 'HEADER STATS', name) ? { ...s, value: '—', sub: 'cut off on the DATA FLOW' } : s;
  });
}

/** The token detail's score numbers as the flow delivers them. */
export function gateDetail(d) {
  if (!d || !cutItems().size) return d;
  const next = { ...d };
  if (isCut('TOKEN DETAIL', 'SCORE DECOMPOSITION', 'FINAL') || isCut('TOKEN DETAIL', 'SCORE', 'SCORE GAUGE')) next.score = '—';
  if (isCut('TOKEN DETAIL', 'SCORE DECOMPOSITION', 'RAW')) next.raw = '—';
  if (isCut('TOKEN DETAIL', 'SCORE DECOMPOSITION', 'RISK PENALTY')) next.penalty = '—';
  return next;
}
