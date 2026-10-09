/**
 * WIRES A USER DRAWS INTO AN INPUT DOT.
 *
 * Dropping a wire from box X onto an input dot K (of a box, or of a group)
 * means: "K, here, is now fed by X". Whatever X carries - a number, a word,
 * a list - goes in; the dot's colour says what it expects, it does not lock.
 *
 *   X is K's own source (FINAL dropped back on the FINAL dot): the wire
 *     that was cut there is connected again.
 *   X is any other box: every box behind that dot reads X instead of K.
 *
 * One rule, used by the map (FlowChart's edits), by the app's cut-off check
 * and by the engine (flow/runtime.js), so all three agree on what is wired.
 */

import { dataKey } from '../admin/engines.js';

const partsOf = (e) => (e.parts && e.parts.length ? e.parts : [{ from: e.from, to: e.to }]);

/**
 * edges   the graph's edges (before the user's edits)
 * sketch  cfg.sketch - the wires the user drew
 * cut     Set of cut part keys ('from>to'), a copy this may change
 * inside  (nodeId, targetId) => true when the node is the target or sits in it
 * Returns { cut, replaced, extra, reroute }. `replaced` are the wires a drawn
 * wire took over: gone, but NOT broken - the box behind them is fed. `extra`
 * are the new wires; `reroute` maps a box id to { K: X } for its re-fed inputs.
 */
export function userWires({ edges, sketch, cut, inside }) {
  const extra = [];
  const replaced = new Set();
  const reroute = new Map();
  (sketch || []).forEach((s) => {
    if (!s.toPort) return;
    const K = s.toPort;
    const X = s.from;
    let matched = false;
    edges.forEach((e) => partsOf(e).forEach((p) => {
      if (p.from !== K && dataKey(p) !== K) return;
      if (!inside(p.to, s.to)) return;
      matched = true;
      const key = p.from + '>' + p.to;
      if (X === K || X === p.from) { cut.delete(key); return; }
      cut.delete(key);
      replaced.add(key);
      extra.push({
        id: 'uw:' + s.id + ':' + p.to, from: X, to: p.to, kind: 'field', userWire: s.id,
        parts: [{ from: X, to: p.to, portKey: K }],
      });
      if (!reroute.has(p.to)) reroute.set(p.to, {});
      reroute.get(p.to)[K] = X;
    }));
    // A dot nothing fed before: the wire simply feeds that box.
    if (!matched && s.to && String(s.to).indexOf('eng:') !== 0) {
      extra.push({ id: 'uw:' + s.id, from: X, to: s.to, kind: 'field', userWire: s.id,
        parts: [{ from: X, to: s.to, portKey: K }] });
      if (!reroute.has(s.to)) reroute.set(s.to, {});
      reroute.get(s.to)[K] = X;
    }
  });
  return { cut, replaced, extra, reroute };
}
