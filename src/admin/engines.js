/**
 * ENGINES - the map as nested subpatchers, the way Max/MSP or cranq.io do it.
 *
 * An engine is a box that holds other boxes (and other engines). From outside
 * it shows only its PORTS: an inlet for each piece of data that comes in from
 * outside it, an outlet for each piece of data that leaves it. Double-click
 * dives in: the canvas shows the engine's own boxes, with its inlets as a
 * column on the left edge and its outlets as a column on the right.
 *
 * Nothing about the wiring is declared here. Ports are DERIVED from the real
 * edges crossing an engine's boundary, so an engine can never claim an input
 * the code does not read. A port is keyed by the SOURCE of the data - the box
 * the value comes from - so one value feeding three boxes inside an engine is
 * one inlet, and one result read by five boxes outside is one outlet.
 *
 * Membership has two layers:
 *   - DEFAULT_ENGINES, one per pipeline step, assign boxes by rule, so a box
 *     that appears later (a generated card) lands in the right engine.
 *   - the user's config, from drag-and-drop and GROUP / UNGROUP / RENAME,
 *     kept in this browser's localStorage. It overrides the rules per box.
 *
 * Sketch wires - the user's own lines, drawn by dragging from an outlet - are
 * in the same config. They are a planning layer: they never touch the score,
 * and they are drawn dashed and named as the user's so the map cannot be
 * mistaken for the code.
 */

import { STAGES } from './graph';

export const ROOT = 'root';

/**
 * A pipeline step's own name, from graph.js STAGES ('3 · GATES' -> 'GATES'),
 * so an engine named after a step follows the step when it is renamed - the
 * step-3 engine said MEASURES for a while after step 3 had become GATES.
 */
const stepName = (k) => String((STAGES[k] || {}).title || '').replace(/^\s*\d+\s*·\s*/, '');

/**
 * One engine per pipeline step. `of` decides, by rule, which boxes it holds.
 * The ids are stable (saved configs point at them); labels may follow the steps.
 */
export const DEFAULT_ENGINES = [
  { id: 'eng:ingest', label: 'INGEST', sub: 'providers → raw files', color: '#2ec4b6',
    of: (n) => n.kind === 'provider' || n.kind === 'file' },
  { id: 'eng:inputs', label: stepName(1) + ' & ' + stepName(2), sub: 'the board, and this token’s readings', color: '#e2e8f0',
    of: (n) => n.page === 'pipe' && (n.stage === 1 || n.stage === 2) },
  { id: 'eng:measures', label: stepName(3), sub: 'checks a token must pass', color: '#94a3b8',
    of: (n) => n.page === 'pipe' && n.stage === 3 },
  { id: 'eng:decomp', label: 'SCORE DECOMPOSITION', sub: 'the 14 components', color: '#f43f5e',
    of: (n) => n.page === 'pipe' && n.stage === 4 },
  { id: 'eng:score', label: 'SCORE', sub: 'raw → penalty → final → stage', color: '#ffd60a',
    of: (n) => n.page === 'pipe' && n.stage === 5 },
  { id: 'eng:dashboard', label: 'DASHBOARD', sub: 'the panels that show it', color: '#3b82f6',
    of: (n) => n.kind === 'panel' || (n.kind === 'field' && n.page !== 'pipe') },
  { id: 'eng:storage', label: 'BROWSER STORAGE', sub: 'kept for the next visit', color: '#b06bff',
    of: (n) => n.kind === 'store' },
];

/** A user-made engine's colour - none of the step or tab hues. */
export const USER_ENGINE_COLOR = '#c4b5fd';

/* ------------------------------------------------------------ config -- */

const KEY = 'vs.admin.engines.v1';

/** The user's layer: their engines, moves, renames, removals and sketch wires. */
export const emptyConfig = () => ({ engines: {}, assign: {}, renamed: {}, removed: {}, sketch: [] });

export function loadConfig() {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return emptyConfig();
    return Object.assign(emptyConfig(), JSON.parse(raw));
  } catch (e) {
    return emptyConfig();
  }
}

export function saveConfig(cfg) {
  try { window.localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) { /* private window */ }
}

/* --------------------------------------------------------- hierarchy -- */

/**
 * Who contains whom, for this graph and this config.
 *
 * Returns `parentOf(id)` for boxes and engines alike, the engine table, and
 * `ancestors(id)` (nearest first, ending at ROOT). A config entry pointing
 * at an engine that no longer exists is ignored rather than trusted, and a
 * move that would put an engine inside itself is refused (`canMove`).
 */
export function hierarchy(cfg, nodes) {
  const engines = new Map();
  DEFAULT_ENGINES.forEach((d) => {
    if (cfg.removed[d.id]) return;
    engines.set(d.id, { id: d.id, label: cfg.renamed[d.id] || d.label, sub: d.sub, color: d.color, user: false });
  });
  Object.keys(cfg.engines).forEach((id) => {
    const e = cfg.engines[id];
    engines.set(id, { id, label: cfg.renamed[id] || e.label, sub: 'your engine', color: USER_ENGINE_COLOR, user: true });
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const exists = (id) => id === ROOT || engines.has(id);

  const defaultParent = (id) => {
    if (engines.has(id)) {
      const own = cfg.engines[id];
      return own && exists(own.parent) ? own.parent : ROOT;
    }
    const n = nodeById.get(id);
    if (!n) return ROOT;
    const d = DEFAULT_ENGINES.find((x) => !cfg.removed[x.id] && x.of(n));
    return d ? d.id : ROOT;
  };

  const parentOf = (id) => {
    const a = cfg.assign[id];
    if (a && exists(a) && a !== id) return a;
    return defaultParent(id);
  };

  const ancestors = (id) => {
    const out = [];
    const seen = new Set([id]);
    let p = parentOf(id);
    while (p && !seen.has(p)) {
      out.push(p);
      if (p === ROOT) break;
      seen.add(p);
      p = parentOf(p);
    }
    if (out[out.length - 1] !== ROOT) out.push(ROOT);
    return out;
  };

  /** Moving `id` into `target` must not put an engine inside itself. */
  const canMove = (id, target) => {
    if (id === target) return false;
    if (target === ROOT) return true;
    if (!engines.has(target)) return false;
    return ancestors(target).indexOf(id) === -1;
  };

  return { engines, parentOf, ancestors, canMove, nodeById };
}

/* --------------------------------------------------------- the view --- */

/** Mirrors graph.js blockOf, for placing an engine where its contents live. */
const blockOfBase = (n) => {
  if (n.kind === 'provider') return 0;
  if (n.kind === 'file') return 1;
  if (n.kind === 'store') return 8;
  if (n.flat || (n.page === 'pipe' && n.stage)) return 1 + (n.stage || 1);
  return 7;
};

export const ENGINE = { W: 236, HEAD: 30, ROW: 16, PAD: 6 };

/**
 * What one level shows: its own boxes, its child engines (with ports), and -
 * inside an engine - its boundary inlets and outlets.
 *
 * `base` is the folded graph (panels collapsed) plus any sketch wires.
 */
export function viewGraph(base, H, level) {
  const nodes = [];
  const nodeOf = H.nodeById;
  const childCache = new Map();

  /** The box or engine standing for `id` at this level; null when outside it. */
  const childOf = (id) => {
    if (childCache.has(id)) return childCache.get(id);
    let res = null;
    if (H.parentOf(id) === level) res = id;
    else {
      const chain = H.ancestors(id);
      for (let i = 0; i < chain.length; i += 1) {
        if (chain[i] === level) { res = i === 0 ? id : chain[i - 1]; break; }
      }
    }
    // An engine or box only counts if it actually exists.
    if (res && res !== id && !H.engines.has(res)) res = null;
    childCache.set(id, res);
    return res;
  };

  const labelOf = (id) => {
    if (H.engines.has(id)) return H.engines.get(id).label;
    const n = nodeOf.get(id);
    return n ? n.label : String(id);
  };

  // Boxes directly at this level, and the engines that hold the rest.
  const engineCount = new Map();
  const engineBlock = new Map();
  base.nodes.forEach((n) => {
    const c = childOf(n.id);
    if (!c) return;
    if (c === n.id) { nodes.push(n); return; }
    engineCount.set(c, (engineCount.get(c) || 0) + 1);
    const b = blockOfBase(n);
    engineBlock.set(c, Math.min(engineBlock.has(c) ? engineBlock.get(c) : 99, b));
  });

  // Edges, re-pointed at what this level shows.
  const edges = new Map();
  const inPorts = new Map();   // engine id -> Map(key -> label)
  const outPorts = new Map();
  const boundaryIn = new Map(); // src id -> label
  const boundaryOut = new Map();
  const port = (map, eng, key) => {
    if (!map.has(eng)) map.set(eng, new Map());
    map.get(eng).set(key, labelOf(key));
  };
  const add = (from, fromPort, to, toPort, e) => {
    const id = from + '|' + (fromPort || '') + '>' + to + '|' + (toPort || '') + ':' + e.kind;
    const hit = edges.get(id);
    if (hit) { hit.parts = hit.parts.concat(e.parts || [{ from: e.from, to: e.to }]); return; }
    edges.set(id, {
      id, from, to, fromPort: fromPort || null, toPort: toPort || null, kind: e.kind,
      parts: (e.parts || [{ from: e.from, to: e.to }]).slice(), src: e.from, sketchId: e.sketchId || null,
    });
  };

  base.edges.forEach((e) => {
    const ra = childOf(e.from);
    const rb = childOf(e.to);
    if (!ra && !rb) return;
    if (ra && rb && ra === rb) return; // inside one child engine: its business
    // The data's key is its SOURCE box, so one value is one port.
    const key = e.from;
    const fromIsEngine = ra && H.engines.has(ra) && ra !== e.from;
    const toIsEngine = rb && H.engines.has(rb) && rb !== e.to;
    if (!ra) {
      boundaryIn.set(key, labelOf(key));
      if (toIsEngine) port(inPorts, rb, key);
      add('port:in:' + key, null, rb, toIsEngine ? key : null, e);
      return;
    }
    if (!rb) {
      boundaryOut.set(key, labelOf(key));
      if (fromIsEngine) port(outPorts, ra, key);
      add(ra, fromIsEngine ? key : null, 'port:out:' + key, null, e);
      return;
    }
    if (fromIsEngine) port(outPorts, ra, key);
    if (toIsEngine) port(inPorts, rb, key);
    add(ra, fromIsEngine ? key : null, rb, toIsEngine ? key : null, e);
  });

  // The engine boxes themselves.
  engineCount.forEach((count, id) => {
    const eng = H.engines.get(id);
    const ins = Array.from((inPorts.get(id) || new Map()).entries()).map(([key, label]) => ({ key, label }));
    const outs = Array.from((outPorts.get(id) || new Map()).entries()).map(([key, label]) => ({ key, label }));
    const rows = Math.max(ins.length, outs.length, 1);
    nodes.push({
      id, kind: 'engine', label: eng.label, sub: eng.sub, color: eng.color, user: eng.user,
      count, block: engineBlock.has(id) ? engineBlock.get(id) : 7, inPorts: ins, outPorts: outs,
      w: ENGINE.W, h: ENGINE.HEAD + rows * ENGINE.ROW + ENGINE.PAD,
    });
  });
  // Engines that hold only other EMPTY engines, or nothing yet, still show.
  H.engines.forEach((eng, id) => {
    if (engineCount.has(id) || H.parentOf(id) !== level) return;
    nodes.push({
      id, kind: 'engine', label: eng.label, sub: eng.sub, color: eng.color, user: eng.user,
      count: 0, block: 7, inPorts: [], outPorts: [],
      w: ENGINE.W, h: ENGINE.HEAD + ENGINE.ROW + ENGINE.PAD,
    });
  });

  // Boundary ports, inside an engine.
  boundaryIn.forEach((label, key) => {
    nodes.push({ id: 'port:in:' + key, kind: 'port', side: 'in', label, src: key, srcNode: nodeOf.get(key) || null,
      field: (nodeOf.get(key) || {}).field || null });
  });
  boundaryOut.forEach((label, key) => {
    nodes.push({ id: 'port:out:' + key, kind: 'port', side: 'out', label, src: key, srcNode: nodeOf.get(key) || null,
      field: (nodeOf.get(key) || {}).field || null });
  });

  return { nodes, edges: Array.from(edges.values()) };
}

/**
 * Order each engine's ports by where the boxes they connect to sit, so the
 * wires into an engine do not cross each other on the way in.
 */
export function orderPorts(laid) {
  const yOf = new Map(laid.nodes.map((n) => [n.id, n.y + n.h / 2]));
  laid.nodes.forEach((n) => {
    if (n.kind !== 'engine') return;
    const near = (key, side) => {
      const ys = laid.edges
        .filter((e) => (side === 'in' ? e.to === n.id && e.toPort === key : e.from === n.id && e.fromPort === key))
        .map((e) => yOf.get(side === 'in' ? e.from : e.to))
        .filter((y) => y !== undefined);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
    };
    n.inPorts = n.inPorts.slice().sort((a, b) => near(a.key, 'in') - near(b.key, 'in'));
    n.outPorts = n.outPorts.slice().sort((a, b) => near(a.key, 'out') - near(b.key, 'out'));
  });
  return laid;
}

/**
 * Give every engine box the SAME port order its own inside shows.
 *
 * Each level sorts its own ports to keep its wires from crossing, so an
 * engine seen from outside and the same engine opened listed one set of ports
 * in two different orders - the outlet that was third on MAP was first inside.
 * The inside is the one the user reads port by port, so it is the source of
 * truth: each child engine's inside is laid out (the same `layout` the canvas
 * uses), its INLETS and OUTLETS columns read top to bottom, and the box's rows
 * are put in that order. Ports the inside does not show (it always does, by
 * construction) keep their place at the end.
 */
export function orderPortsLikeInside(laid, base, H, layoutFn) {
  laid.nodes.forEach((n) => {
    if (n.kind !== 'engine') return;
    const inner = layoutFn(viewGraph(base, H, n.id));
    const column = (side) => inner.nodes
      .filter((x) => x.kind === 'port' && x.side === side)
      .sort((a, b) => a.y - b.y)
      .map((x) => x.src);
    const rank = (list) => {
      const m = new Map(list.map((k, i) => [k, i]));
      return (p) => (m.has(p.key) ? m.get(p.key) : 1e6);
    };
    const ri = rank(column('in'));
    const ro = rank(column('out'));
    n.inPorts = n.inPorts.slice().sort((a, b) => ri(a) - ri(b));
    n.outPorts = n.outPorts.slice().sort((a, b) => ro(a) - ro(b));
  });
  return laid;
}

/** Where a port sits on its engine box, in map coordinates. */
export function portPoint(n, pos, side, key) {
  const list = side === 'in' ? n.inPorts : n.outPorts;
  const i = Math.max(0, list.findIndex((p) => p.key === key));
  return {
    x: side === 'in' ? pos.x : pos.x + n.w,
    y: pos.y + ENGINE.HEAD + i * ENGINE.ROW + ENGINE.ROW / 2,
  };
}

/** Sketch wires as graph edges, so they flow through the same folding. */
export const sketchEdges = (cfg) => (cfg.sketch || []).map((s) => ({
  id: 'sk:' + s.id, from: s.from, to: s.to, kind: 'sketch', parts: [{ from: s.from, to: s.to }], sketchId: s.id,
}));
