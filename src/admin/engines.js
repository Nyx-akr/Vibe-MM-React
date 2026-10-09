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
import { activeFlow, updateFlow } from './flow-store';
import { RAW } from './pipeline';

/**
 * The DATA one link carries, as a port key. A reading out of a raw file is
 * the file plus the reading ('file:/raw/<chain>/market.json#POOL AGE'), so a
 * file sends POOL AGE and LIQUIDITY as two values, not as "market.json"
 * twice; anything else is keyed by the box that produced the value.
 */
export const dataKey = (p) => (isReading(p.label) ? p.from + '#' + p.label : p.from);
// Only a READING names a port (RAW holds the keys it extracts). Some cards
// name a file with a description ("top 30 rows per chain") - that is prose
// about the file, not a value out of it, so those stay keyed by the file.
const isReading = (label) => Boolean(label && RAW[label]);

export const ROOT = 'root';

/**
 * A pipeline step's own name, from graph.js STAGES ('4 · GATES' -> 'GATES'),
 * so an engine named after a step follows the step when it is renamed - the
 * step-3 engine said MEASURES for a while after step 3 had become GATES.
 */
const stepName = (k) => String((STAGES[k] || {}).title || '').replace(/^\s*\d+\s*·\s*/, '');

/**
 * One engine per pipeline step. `of` decides, by rule, which boxes it holds;
 * `parent` nests an engine inside another (default: the MAP itself). The ids
 * are stable (saved configs point at them); labels may follow the steps.
 */
/** The RAW box - the weighted sum of the components. */
const isRaw = (n) => n.id === 'f:pipe:RAW';

export const DEFAULT_ENGINES = [
  { id: 'eng:ingest', label: 'INGEST', sub: 'providers → raw files', color: '#2ec4b6',
    of: (n) => n.kind === 'provider' || n.kind === 'file' },
  // The board and the token picked from it: what every per-token box reads.
  // Inside SCORE DECOMPOSITION: its options carry each token's FINAL score
  // or VETO, so it reads the score it starts.
  { id: 'eng:token', label: 'TOKEN SELECTOR', sub: 'the board → the picked token', color: '#e2e8f0', parent: 'eng:decomp',
    of: (n) => n.page === 'pipe' && n.stage === 1 },
  // The whole score in one engine: the readings and the engines that turn
  // them into components sit in it, and each component group, the gates and
  // the combine step sit in it as groups of their own - so the score reads
  // MAP › SCORE DECOMPOSITION › DEMAND ENGINE, one level deeper per step.
  { id: 'eng:decomp', label: 'SCORE DECOMPOSITION', sub: 'readings → components → gates → score', color: '#f43f5e',
    // RAW too: it is the weighted sum of the components, so it sits beside
    // them and hands its one number into the SCORE group.
    of: (n) => n.page === 'pipe' && ((n.stage >= 2 && n.stage <= 3) || isRaw(n)) },
  // After the engines: the wash gate reads one of their outputs.
  { id: 'eng:measures', label: stepName(4), sub: 'checks a token must pass', color: '#94a3b8', parent: 'eng:decomp',
    of: (n) => n.page === 'pipe' && n.stage === 4 },
  { id: 'eng:score', label: 'SCORE', sub: 'penalty → right now → final → stage', color: '#ffd60a', parent: 'eng:decomp',
    of: (n) => n.page === 'pipe' && n.stage === 5 && !isRaw(n) },
  // The background jobs (wallet intel, rotation, social, evaluation, alerts).
  { id: 'eng:services', label: 'SERVICES', sub: 'always-on jobs that keep memory', color: '#fbbf24',
    of: () => false },
  { id: 'eng:dashboard', label: 'DASHBOARD', sub: 'the panels that show it', color: '#3b82f6',
    of: (n) => n.kind === 'panel' || (n.kind === 'field' && n.page !== 'pipe') },
  // What the dashboard keeps for the next visit: part of the dashboard.
  // Beside the dashboard, not in it: the dashboard holds only its panels.
  { id: 'eng:storage', label: 'BROWSER STORAGE', sub: 'kept for the next visit', color: '#b06bff',
    of: (n) => n.kind === 'store' },
];

/** A component group's engine id. */
const groupId = (group) => 'eng:g:' + group;
/** The group a box's operation graph becomes. */
const opEngineId = (fieldNodeId) => 'eng:o:' + fieldNodeId;

/**
 * The pipeline's component groups as engines, each inside SCORE
 * DECOMPOSITION. A group used to be a PANEL - a third kind of box that
 * expanded in place. As a group it is opened like any other, and inside it
 * every component is a calculation box of its own.
 */
function groupEngines(nodes) {
  const seen = new Map();
  nodes.forEach((n) => {
    // A dashboard TAB: a group inside DASHBOARD holding its panels.
    if (n.dashTab && !seen.has('tab:' + n.dashTab)) {
      seen.set('tab:' + n.dashTab, { id: 'eng:t:' + n.dashTab, label: n.dashTab, parent: 'eng:dashboard',
        sub: 'a frontend tab', color: '#3b82f6' });
    }
    if (!n.calcGroup || seen.has(n.calcGroup)) return;
    seen.set(n.calcGroup, {
      id: groupId(n.calcGroup), label: n.calcGroupLabel || n.calcGroup, parent: n.calcParent || 'eng:decomp',
      sub: n.dashTab ? 'a panel' : 'a group of calculations', color: n.dashTab ? '#3b82f6' : '#f43f5e',
    });
  });
  return Array.from(seen.values());
}

/** A user-made engine's colour - none of the step or tab hues. */
export const USER_ENGINE_COLOR = '#c4b5fd';

/* ------------------------------------------------------------ config -- */


/** The user's layer: their engines, moves, renames, removals and sketch wires. */
export const emptyConfig = () => ({ engines: {}, assign: {}, renamed: {}, removed: {}, sketch: [],
  deleted: {}, cutWires: [], copies: [], added: [], portNames: {} });

/** The user's layer of the ACTIVE flow (flow-store.js). */
export function loadConfig() {
  return Object.assign(emptyConfig(), activeFlow().cfg || {});
}

/** Saved into the active flow: kept in a user's file, a preview on DEFAULT. */
export function saveConfig(cfg) {
  updateFlow({ cfg });
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
  const gone = (id) => cfg.removed[id] || (cfg.deleted || {})[id];
  DEFAULT_ENGINES.forEach((d) => {
    if (gone(d.id)) return;
    engines.set(d.id, { id: d.id, label: cfg.renamed[d.id] || d.label, sub: d.sub, color: d.color, user: false });
  });
  Object.keys(cfg.engines).forEach((id) => {
    if (gone(id)) return;
    const e = cfg.engines[id];
    engines.set(id, { id, label: cfg.renamed[id] || e.label, sub: 'your engine', color: USER_ENGINE_COLOR, user: true });
  });
  // One group per pipeline component group (DEMAND ENGINE, HOLDERS ENGINE...),
  // derived from the boxes, so a group added to the catalogue appears here.
  const groups = groupEngines(nodes);
  groups.forEach((d) => {
    if (gone(d.id)) return;
    engines.set(d.id, { id: d.id, label: cfg.renamed[d.id] || d.label, sub: d.sub, color: d.color, user: false });
  });

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // Where a box would sit with no operation graph: its component group, or
  // its pipeline step's engine.
  const baseParent = (n) => {
    if (n.calcGroup && engines.has(groupId(n.calcGroup))) return groupId(n.calcGroup);
    if (n.home && engines.has(n.home)) return n.home;
    const d = DEFAULT_ENGINES.find((x) => !cfg.removed[x.id] && x.of(n));
    return d ? d.id : ROOT;
  };
  // A box with an operation graph is a GROUP of operator boxes, sitting where
  // the box itself would have sat: FINAL inside SCORE, Net demand inside
  // DEMAND ENGINE. Double-click it to see the operators.
  const opGroups = [];
  nodes.forEach((n) => {
    if (!n.opGroup || n.id !== n.opGroup) return;
    const id = opEngineId(n.opGroup);
    if (gone(id)) return;
    opGroups.push({ id, parent: baseParent(n) });
    engines.set(id, { id, label: cfg.renamed[id] || n.opGroupLabel, sub: 'its operations', color: '#f43f5e', user: false });
  });
  const exists = (id) => id === ROOT || engines.has(id);

  const defaultParent = (id) => {
    if (engines.has(id)) {
      const own = cfg.engines[id];
      if (own) return exists(own.parent) ? own.parent : ROOT;
      const d = DEFAULT_ENGINES.find((x) => x.id === id) || groups.find((x) => x.id === id)
        || opGroups.find((x) => x.id === id);
      return d && d.parent && exists(d.parent) ? d.parent : ROOT;
    }
    const n = nodeById.get(id);
    if (!n) return ROOT;
    if (n.opGroup && exists(opEngineId(n.opGroup))) return opEngineId(n.opGroup);
    if (n.calcGroup && exists(groupId(n.calcGroup))) return groupId(n.calcGroup);
    if (n.home && exists(n.home)) return n.home;
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

  // Names a user gave connectors (a display label on top of the data key).
  return { engines, parentOf, ancestors, canMove, nodeById, portNames: cfg.portNames || {} };
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
/** The room under an API box's rows for its health and its sample. */
export const PROVIDER_BODY = 168;
/** Where a box's port rows start: under its title. */
export const rowsTop = () => ENGINE.HEAD;

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

  // A field folded into a closed panel is not a node of its own, but it is
  // still the value a port carries - found through the panel holding it.
  const foldedField = (id) => {
    const m = /^f:([^:]+):(.*)$/.exec(String(id));
    if (!m) return null;
    const panel = base.nodes.find((n) => n.kind === 'panel' && n.page === m[1]
      && (n.fields || []).some((f) => f.label === m[2]));
    return panel ? panel.fields.find((f) => f.label === m[2]) : null;
  };
  const labelOf = (id) => {
    if (H.portNames && H.portNames[id]) return H.portNames[id];
    const hash = String(id).indexOf('#');
    if (hash !== -1) return String(id).slice(hash + 1);
    if (H.engines.has(id)) return H.engines.get(id).label;
    const n = nodeOf.get(id);
    if (n) return n.label;
    const f = foldedField(id);
    return f ? f.label : String(id);
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
  // The field a port carries, for its live value - a box at this level, or a
  // field folded into a closed panel.
  const fieldOf = (key) => (nodeOf.get(key) || {}).field || foldedField(key) || readingField(key) || null;
  const add = (from, fromPort, to, toPort, e) => {
    const id = from + '|' + (fromPort || '') + '>' + to + '|' + (toPort || '') + ':' + e.kind;
    const hit = edges.get(id);
    if (hit) { hit.parts = hit.parts.concat(e.parts || [{ from: e.from, to: e.to }]); return; }
    edges.set(id, {
      id, from, to, fromPort: fromPort || null, toPort: toPort || null, kind: e.kind,
      parts: (e.parts || [{ from: e.from, to: e.to }]).slice(), src: e.from, sketchId: e.sketchId || null,
    });
  };

  // The data's key is the VALUE it carries, so one value is one port. An
  // arrow out of a closed panel stands for several values (DEMAND ENGINE
  // sends Trade activity, Buyer breadth, ...): split it back into one per
  // value, so a port is named after its data rather than after the panel.
  const carried = [];
  base.edges.forEach((e) => {
    const from = nodeOf.get(e.from);
    const parts = e.parts && e.parts.length ? e.parts : [{ from: e.from, to: e.to }];
    const rolledPanel = from && from.kind === 'panel' && e.rolled;
    const by = new Map();
    parts.forEach((p) => {
      // A closed panel's arrow carries its fields' values; a file's carries
      // its readings; any other box's carries its own value.
      const key = isReading(p.label) ? dataKey(p) : (rolledPanel ? p.from : e.from);
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(p);
    });
    by.forEach((ps, key) => carried.push({ e: { ...e, parts: ps }, key }));
  });

  // A user's INPUT / OUTPUT box is a group's named connector: a wire INTO an
  // input crosses the group's edge under the INPUT's name, and inside the
  // group the box itself is the entry/exit - no extra IN/OUT dot for it.
  const uportOf = (id) => { const n = nodeOf.get(id); return n && n.uport ? n.uport : null; };
  carried.forEach(({ e, key: dataKey0 }) => {
    const key = uportOf(e.to) === 'in' ? e.to : dataKey0;
    const ra = childOf(e.from);
    const rb = childOf(e.to);
    if (!ra && !rb) return;
    if (ra && rb && ra === rb) return; // inside one child engine: its business
    if (!ra && rb === e.to && uportOf(e.to) === 'in') return;
    if (!rb && ra === e.from && uportOf(e.from) === 'out') return;
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

  // Every INPUT / OUTPUT declares its dot on the group it sits in, wired or
  // not - adding one is what gives the group a new connector.
  nodeOf.forEach((n) => {
    if (!n.uport) return;
    const c = childOf(n.id);
    if (!c || c === n.id || !H.engines.has(c) || H.parentOf(n.id) !== c) return;
    port(n.uport === 'in' ? inPorts : outPorts, c, n.id);
  });

  // The engine boxes themselves.
  engineCount.forEach((count, id) => {
    const eng = H.engines.get(id);
    const ins = Array.from((inPorts.get(id) || new Map()).entries()).map(([key, label]) => ({ key, label, field: fieldOf(key) }));
    const outs = Array.from((outPorts.get(id) || new Map()).entries()).map(([key, label]) => ({ key, label, field: fieldOf(key) }));
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
      field: fieldOf(key) });
  });
  boundaryOut.forEach((label, key) => {
    nodes.push({ id: 'port:out:' + key, kind: 'port', side: 'out', label, src: key, srcNode: nodeOf.get(key) || null,
      field: fieldOf(key) });
  });

  portPanels(nodes, edges, labelOf, fieldOf);
  return { nodes, edges: Array.from(edges.values()) };
}

/**
 * A reading out of a raw file, as something with a live value: the value the
 * pipeline extracts for it (RAW[reading].outs), when it extracts ONE.
 */
function readingField(key) {
  const hash = String(key).indexOf('#');
  if (hash === -1) return null;
  const spec = RAW[String(key).slice(hash + 1)];
  if (!spec || !spec.outs || spec.outs.length !== 1) return null;
  return {
    label: String(key).slice(hash + 1),
    value: (v) => spec.outs[0].value(v, v && v.pipe && v.pipe.raw ? v.pipe.raw[spec.from] : null),
  };
}

/**
 * EVERY box draws like an engine: one inlet per value it reads, one
 * outlet per value it hands on, each named after its data and showing it.
 * So does every other box - a calculation step, a raw file (one outlet per
 * reading), a provider, a store - so the whole map reads the same way.
 * A box that only said "DEMAND ENGINE" on its edge could not say WHICH
 * values entered it or left it - the open card was the only place to find
 * out. Its arrows are split the same way, one per value, onto its port rows.
 *
 * An OPEN panel is left alone: its fields are boxes of their own then, and
 * the panel keeps its "contains" lines to them.
 */
const PORTED_KINDS = new Set(['panel', 'field', 'file', 'provider', 'store']);

function portPanels(nodes, edges, labelOf, fieldOf) {
  const panels = new Set(nodes.filter((n) => PORTED_KINDS.has(n.kind)).map((n) => n.id));
  edges.forEach((x) => { if (x.kind === 'contains') { panels.delete(x.from); panels.delete(x.to); } });
  if (!panels.size) return;

  const pIn = new Map();
  const pOut = new Map();
  const addPort = (m, id, key) => {
    if (!m.has(id)) m.set(id, new Map());
    if (!m.get(id).has(key)) m.get(id).set(key, { key, label: labelOf(key), field: fieldOf(key) });
  };
  const next = new Map();
  edges.forEach((x) => {
    const fromP = panels.has(x.from);
    const toP = panels.has(x.to);
    if (!fromP && !toP) { next.set(x.id, x); return; }
    const parts = x.parts && x.parts.length ? x.parts : [{ from: x.from, to: x.to }];
    // The data a wire carries is its SOURCE value; an engine port upstream
    // is already keyed by that same id, so the two ends name one thing.
    const by = new Map();
    parts.forEach((p) => {
      const src = x.fromPort && !fromP ? x.fromPort : dataKey(p);
      if (!by.has(src)) by.set(src, []);
      by.get(src).push(p);
    });
    by.forEach((ps, src) => {
      const fromPort = fromP ? src : x.fromPort || null;
      const toPort = toP ? src : x.toPort || null;
      if (fromP) addPort(pOut, x.from, src);
      if (toP) addPort(pIn, x.to, src);
      const id = x.from + '|' + (fromPort || '') + '>' + x.to + '|' + (toPort || '') + ':' + x.kind;
      const hit = next.get(id);
      if (hit) hit.parts = hit.parts.concat(ps);
      else next.set(id, { ...x, id, parts: ps.slice(), fromPort, toPort });
    });
  });
  edges.clear();
  next.forEach((x, id) => edges.set(id, x));

  nodes.forEach((n, i) => {
    if (!panels.has(n.id)) return;
    // Outlets in the panel's own field order, so they read like its card.
    const order = new Map((n.fields || []).map((f, k) => ['f:' + n.page + ':' + f.label, k]));
    const outs = Array.from((pOut.get(n.id) || new Map()).values())
      .sort((a, b) => (order.has(a.key) ? order.get(a.key) : 99) - (order.has(b.key) ? order.get(b.key) : 99));
    const ins = Array.from((pIn.get(n.id) || new Map()).values());
    // Every calculation has an outlet, wired or not - it is where a new
    // wire is dragged from.
    if (!outs.length && n.kind === 'field') outs.push({ key: n.id, label: n.label, field: n.field });
    const rows = Math.max(ins.length, outs.length, 1);
    nodes[i] = { ...n, ported: true, inPorts: ins, outPorts: outs,
      // An API box carries its health and a sample of what it fetched.
      w: ENGINE.W, h: ENGINE.HEAD + rows * ENGINE.ROW + ENGINE.PAD + (n.kind === 'provider' ? PROVIDER_BODY : 0) };
  });
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
    y: pos.y + rowsTop(n) + i * ENGINE.ROW + ENGINE.ROW / 2,
  };
}

/** Sketch wires as graph edges, so they flow through the same folding. */
export const sketchEdges = (cfg) => (cfg.sketch || []).map((s) => ({
  id: 'sk:' + s.id, from: s.from, to: s.to, kind: 'sketch', parts: [{ from: s.from, to: s.to }], sketchId: s.id,
}));
