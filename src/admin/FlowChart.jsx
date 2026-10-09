import React from 'react';
import ReactDOM from 'react-dom';
import { getSetting, setSetting, clearSetting, subscribeSettings, applyFilter, filterSetting, FILTER_MODES } from './box-settings';
import { activeFlow, activeFlowId, updateFlow, subscribeFlows, DEFAULT_FLOW, flowHistoryVersion, undoFlow, redoFlow } from './flow-store';
import { userWires as applyUserWires } from '../flow/wires';
import { WIRE_TYPES, typeOfValue, showValue, describeValue, coerce } from '../flow/types';
import { boardValues } from '../flow/board-flow';
import { NODE_TYPES } from '../flow/score-flow';
import { buildGraph, collapse, layout, PAGE_TITLES, PAGE_COLORS, KIND_COLORS, STORES, STAGES, CONNECTOR_W, CONNECTOR_H } from './graph';
import { C, WorkedSteps } from './Explain';
import { fieldValues } from './provenance';
import {
  ROOT, ENGINE, loadConfig, saveConfig, emptyConfig, hierarchy, viewGraph, orderPortsLikeInside, portPoint, sketchEdges,
  rowsTop,
} from './engines';

/**
 * The whole system on one canvas: what we fetch, where it lands, which panel
 * reads it, what that panel computes, and what is written back to storage.
 *
 * The mirror answers "where did THIS number come from" one card at a time.
 * That is the right shape when you already know which number you care about
 * and the wrong one for "what does this system actually do" - an answer that
 * only exists as a shape. So the same catalogue is read as a graph instead.
 *
 * It opens with panels collapsed, because a hundred and forty boxes is a
 * hairball and forty-five is a diagram. Collapsing hides no connection: a
 * panel inherits every edge its fields had, so the overview is a true
 * summary rather than a simplified one. Open a panel to see which of its
 * fields the arrow really belonged to.
 */

/**
 * A line is drawn in the colour of the box it LEAVES, not in a colour of
 * its own.
 *
 * Colouring by relationship meant every arrow between two fields was the
 * same blue however far it had travelled, so a line arriving at a panel told
 * you nothing about where it came from until you traced it back. Taking the
 * source box's colour makes that readable at a glance: amber is leaving a
 * provider, teal is leaving a file, and a cross-tab line arrives wearing the
 * colour of the tab that produced it.
 *
 * What stays per-relationship is the DASH, which says what kind of link it
 * is rather than where it started.
 */
const EDGE_STYLE = {
  collect: { dash: null, label: 'collected' },
  'collect-indirect': { dash: '4 3', label: 'collected (file not named)' },
  file: { dash: null, label: 'read from disk' },
  field: { dash: null, label: 'computed from' },
  'store-write': { dash: '5 3', label: 'persisted' },
  'store-read': { dash: '5 3', label: 'restored' },
  origin: { dash: '2 4', label: 'origin' },
  selects: { dash: '2 3', label: 'picks which record is shown' },
  // Not a data flow - it says which box this field belongs to, and only
  // appears while its panel is open.
  contains: { dash: '1 3', label: 'inside this panel' },
  // The user's own line, drawn by dragging from an outlet. A plan, not the
  // code: long dashes in one fixed colour so it is never read as real flow.
  sketch: { dash: '7 4', label: 'your sketch wire — not in the code' },
};

/** Every sketch wire is this colour, whatever box it leaves. */
const SKETCH_COLOR = '#f5f5f5';

/** One arrowhead per colour in use; SVG markers cannot inherit a stroke. */
const markerId = (color) => 'ar' + String(color).replace(/[^a-zA-Z0-9]/g, '');

// Low enough that the opening fit can take in the whole map on a narrow
// window - it was clamping at 0.18, which left a third of it off-screen.
const ZOOM_MIN = 0.07;


const ZOOM_MAX = 2.2;

/** Where an edge leaves and enters, and the curve between the two. */
/**
 * The curve between two POINTS.
 *
 * Points rather than boxes, because an open card does not have one place a
 * line belongs: an arrow into it belongs beside the row naming where it came
 * from, and an arrow out of it beside the row naming where it goes.
 */
function edgePath(p1, p2) {
  const x1 = p1.x;
  const y1 = p1.y;
  const x2 = p2.x;
  const y2 = p2.y;
  const dx = x2 - x1;
  // A backwards edge cannot be a gentle S or it would run through the boxes
  // between the two ends, so it bows out instead and reads as a return path.
  if (dx < 40) {
    const out = Math.max(60, Math.abs(dx) * 0.4);
    const lift = (y2 > y1 ? 1 : -1) * Math.max(40, Math.abs(y2 - y1) * 0.25);
    return `M ${x1} ${y1} C ${x1 + out} ${y1 + lift}, ${x2 - out} ${y2 - lift}, ${x2} ${y2}`;
  }
  const c = Math.min(dx * 0.5, 110);
  return `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2} ${y2}`;
}

// A pipeline step wears its STEP's colour, so inputs, measures, components
// and the score read as four bands rather than one yellow wall.
/**
 * Every group wears ONE colour and one icon: a group is a container, and a
 * colour per group made it look like six different kinds of thing.
 */
export const GROUP_COLOR = '#8fa3ff';

/**
 * WIRE TYPES - every dot is coloured by the STANDARD type its wire carries
 * (flow/types.js): number, bool, text, list, dict. A box's name says what the
 * value means; the dot only says what it is, as in Max/MSP.
 *
 * What a dot EXPECTS is its box's declared type (the engine's NODE_TYPES, or
 * the box type's own); what it is RECEIVING is the type of the value on the
 * wire right now, for the selected token. Hovering shows both.
 */
export const UNIT_COLORS = Object.fromEntries(Object.entries(WIRE_TYPES).map(([k, x]) => [k, x.color]));
export const UNIT_NAMES = Object.fromEntries(Object.entries(WIRE_TYPES).map(([k, x]) => [k, x.name]));
/** The selected token's wire values (score-flow flowValues), set each render. */
let WIRE_VALUES = {};
/** The inputs the user re-fed on the map (flow/wires.js), set by the edits. */
let REROUTE = new Map();
const ITEM_TYPE = { number: 'number' };
/**
 * The value on a box's outgoing wire, raw: the flow's own value where it ran
 * one, and for a DASHBOARD ITEM the value arriving on its wire, converted to
 * what it shows (a number item takes a list as its length).
 */
const wireOf = (n) => {
  const id = n.kind === 'port' ? n.src : n.id;
  if (Object.prototype.hasOwnProperty.call(WIRE_VALUES, id)) return { has: true, x: WIRE_VALUES[id] };
  if (n.page === 'dash' && n.field && n.field.from) {
    const fed = REROUTE.get(n.id) || {};
    const srcs = n.field.from.map((t) => (t.t === 'ref' ? 'f:' + t.page + ':' + t.field
      : t.t === 'api' && t.field ? 'f:pipe:' + t.field : null)).filter(Boolean);
    for (const k of srcs) {
      const src = fed[k] || k;
      if (Object.prototype.hasOwnProperty.call(WIRE_VALUES, src)) {
        const want = ITEM_TYPE[n.field.display] || null;
        return { has: true, x: want ? coerce(WIRE_VALUES[src], want) : WIRE_VALUES[src] };
      }
    }
  }
  return { has: false, x: null };
};
/** The type a box SENDS, declared: the engine's, else its box type's. */
const declaredType = (id, meta) => {
  if (NODE_TYPES[id]) return NODE_TYPES[id];
  const n = meta && meta.kind ? meta : null;
  if (!n) return null;
  if (n.kind === 'file' || n.kind === 'store' || n.kind === 'provider' || n.kind === 'panel') return 'dict';
  const t = typeOf(n);
  if (t === 'service') return 'dict';
  if (t === 'list' || t === 'filter') return 'list';
  if (t === 'condition') return (n.field && n.field.opSpec && n.field.opSpec.sym === 'IF') ? 'number' : 'bool';
  if (t === 'join') return 'bool';
  if (t === 'selector') return 'text';
  return 'number';
};
export function unitOf(val, meta) {
  if (val === null || val === undefined || val === '') return null;
  return declaredType(meta && meta.id, meta) || 'number';
}
export function portType(key, val, meta, carries = true, via = null) {
  const expected = declaredType(key, meta);
  // The value actually on the wire, where the flow computed one.
  const src = via || key;
  const wire = Object.prototype.hasOwnProperty.call(WIRE_VALUES, src) ? WIRE_VALUES[src] : undefined;
  let receiving = wire !== undefined ? typeOfValue(wire) : null;
  if (wire === undefined) {
    // Not an engine box: a whole file / service state is a dict that is
    // there, a value that shows is its declared type.
    if (!carries) receiving = expected || 'dict';
    else if (val !== null && val !== undefined && val !== '') receiving = expected || 'number';
  }
  // A re-fed dot receives the value converted to the type it expects.
  const arrives = via && expected && wire !== undefined ? coerce(wire, expected) : wire;
  const shown = arrives !== undefined && arrives !== null ? showValue(arrives) : (wire !== undefined ? null : val);
  const words = arrives !== undefined && arrives !== null ? describeValue(arrives) : shown;
  return { expected: expected || receiving || null, receiving, val: shown, words };
}
const typeTitle = (label, t, side) => label + '\n' +
  (side === 'in' ? 'expects: ' : 'sends: ') + (t.expected ? UNIT_NAMES[t.expected] : 'unknown yet') + '\n' +
  (side === 'in' ? 'receiving: ' : 'sending now: ') +
  (t.receiving ? UNIT_NAMES[t.receiving] + (t.val !== null && t.val !== undefined ? ' · ' + (t.words || t.val) : '') : 'nothing - missing data') +
  (t.receiving && t.expected && t.receiving !== t.expected ? '\n(a ' + UNIT_NAMES[t.receiving] + ' arrives where a ' + UNIT_NAMES[t.expected] + ' is expected - converted: ' + t.val + ')' : '');
/** Does this port carry ONE value (a field), or a whole file? */
const carriesValue = (p, nodeById) => {
  const src = nodeById && nodeById.get(p.key);
  const f = (src && src.field) || p.field;
  return Boolean(f && f.value);
};
/** An inlet dot: its wire type's colour; a red dashed ring only when a value is due and none arrives. */
function InDot({ label, t }) {
  return (
    <span title={typeTitle(label, t, 'in')} style={{ position: 'absolute', left: -4.5, top: '50%', marginTop: -4,
      width: 8, height: 8, borderRadius: '50%', background: t.receiving ? dotColor(t) : C.bg, cursor: 'help',
      border: t.receiving ? 'none' : `1.5px dashed ${WIRE_BAD}`, boxSizing: 'border-box',
      boxShadow: `0 0 0 2px ${C.bg}` }} />
  );
}
const dotColor = (t) => (t.expected ? UNIT_COLORS[t.expected] : C.dim);
export const WIRE_OK = '#7f8fb8';
export const WIRE_BAD = '#ff4d4d';

/**
 * The STANDARD BOXES a user can add from the right-click menu, by category.
 * `live` ones compute from whatever is wired into them right now; the others
 * can be placed and wired, and compute once the graph runs the score.
 */
export const ADD_CATALOG = [
  { cat: 'DATA', items: [
    { type: 'fetcher', label: 'API fetch' },
    { type: 'extract', label: 'Extract' },
    { type: 'list', label: 'List extractor' },
    { type: 'storage', label: 'Storage' },
    { type: 'service', label: 'Service' },
    { type: 'item', label: 'Dashboard item' },
  ] },
  { cat: 'MATH', items: [
    { type: 'op', op: 'sum', label: 'Add (+)', live: true },
    { type: 'op', op: 'sub', label: 'Subtract (−)', live: true },
    { type: 'op', op: 'mul', label: 'Multiply (×)', live: true },
    { type: 'op', op: 'div', label: 'Divide (÷)', live: true },
    { type: 'op', op: 'min', label: 'Min', live: true },
    { type: 'op', op: 'max', label: 'Max', live: true },
  ] },
  { cat: 'LOGIC', items: [
    { type: 'compare', label: 'Compare (≥)', live: true },
    { type: 'if', label: 'IF / ELSE', live: true },
    { type: 'or', label: 'OR', live: true },
  ] },
  { cat: 'SHAPE', items: [
    { type: 'mean', label: 'Average', live: true },
    { type: 'filter', label: 'Filter' },
    { type: 'selector', label: 'Selector' },
    { type: 'join', label: 'Join' },
    { type: 'curve', label: 'Curve (0-100)', live: true },
  ] },
  { cat: 'GROUP CONNECTORS', items: [
    { type: 'input', label: 'Input', live: true, inGroup: true },
    { type: 'output', label: 'Output', live: true, inGroup: true },
  ] },
  { cat: 'OTHER', items: [
    { type: 'param', label: 'Parameter', live: true },
    { type: 'group', label: 'Group', live: true },
    { type: 'panel', label: 'Panel output' },
  ] },
];
const OP_SYM = { sum: '+', sub: '−', mul: '×', div: '÷', min: 'MIN', max: 'MAX' };

/** A number out of a shown value: "$4.2K" → 4200, "0.91x" → 0.91, "43.2%" → 43.2. */
export function parseNum(val) {
  if (typeof val === 'number') return Number.isFinite(val) ? val : null;
  if (val === null || val === undefined) return null;
  const m = String(val).replace(/,/g, '').match(/-?\d+(\.\d+)?\s*([kKmMbB])?/);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase()] || 1;
  return parseFloat(m[0]) * mult;
}
/** Is a shown value a "yes"? pass / clean / true / open / any positive number. */
const truthy = (val) => {
  if (val === null || val === undefined) return null;
  const s = String(val).trim().toLowerCase();
  if (/^(pass|clean|true|yes|open|no veto)/.test(s)) return true;
  if (/^(veto|fail|false|no|taken)/.test(s)) return false;
  const n = parseNum(val);
  return n === null ? null : n > 0;
};
const fmtNum = (n) => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : null);

/** An aggregate box: one colour wherever it sits, so it reads as its own kind. */
export const AGG_COLOR = '#5eead4';

const nodeColor = (n) => {
  // A group wears the group colour; a boundary port wears its source's.
  if (n.kind === 'engine') return GROUP_COLOR;
  if (n.kind === 'field' && TYPE_COLORS[typeOf(n)]) return TYPE_COLORS[typeOf(n)];
  if (n.kind === 'port') return n.srcNode ? nodeColor(n.srcNode) : '#e7edff';
  if ((n.flat || n.page === 'pipe') && STAGES[n.stage]) return STAGES[n.stage].color;
  return n.kind === 'field' || n.kind === 'panel'
    ? (PAGE_COLORS[n.page] || C.dim)
    : KIND_COLORS[n.kind] || C.dim;
};

/**
 * A field's live value as short box text, or null. Read through the field's
 * own value(v) - the call its card makes - so the box and the card agree.
 */
const boxValue = (n, v) => {
  // A boundary port shows the value of the data it carries in or out.
  if ((n.kind !== 'field' && n.kind !== 'port') || !n.field || !n.field.value) return null;
  // A wire carries a raw value, no units: show that where the flow has one.
  const w = wireOf(n);
  if (w.has) return showValue(w.x);
  let val;
  try { val = n.field.value(v); } catch (e) { return null; }
  if (val === null || val === undefined || val === '') return null;
  const s = typeof val === 'string' ? val : showValue(val);
  if (s === null) return null;
  return s.length > 18 ? s.slice(0, 17) + '…' : s;
};

/**
 * What KIND of box this is, as a drawn icon rather than a colour to look up.
 *
 * Colour alone made the type a legend lookup: orange meant provider, teal
 * meant file, and the eye had to go to the toolbar and back for every box.
 * The icon says it on the box itself - a cloud is an outside API, a page is a
 * file on our server's disk, a cylinder is storage in this browser, a window
 * is a dashboard panel, a sigma is a step of the score calculation. Stroked
 * bold at 14px so it reads at the zoom levels the map is actually used at.
 */
const ICON_PATHS = {
  provider: 'M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.3 9.3 4.6 4.6 0 0 0 7 18.5z',
  file: 'M6.5 3h7.5l4.5 4.5V21h-12z M14 3v4.5h4.5 M9 12.5h6 M9 16h6',
  store: 'M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3z M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6 M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3',
  panel: 'M3 4.5h18v15H3z M3 8.5h18 M6 13h5 M6 16h8',
  field: 'M4 6.5h16v11H4z M8 12h8',
  step: 'M17.5 5H6.5l6 7-6 7h11',
  // Two stacked modules with a link: a box that holds boxes.
  engine: 'M4 4h16v6H4z M4 14h16v6H4z M9 10v4 M15 10v4',
  // Into a bar / out of a bar: data crossing an engine's edge.
  'port-in': 'M3 12h11 M10 8l4 4-4 4 M19 4v16',
  'port-out': 'M5 4v16 M8 12h11 M15 8l4 4-4 4',
  // Bars with a line across them: a collection reduced to one number.
  aggregate: 'M5 20V13 M10 20V8 M15 20V11 M20 20V5 M3 10.5h19',
  // A diamond: a condition with two ways out.
  decision: 'M12 3l9 9-9 9-9-9z M9 12h6',
  // A list with one row ticked: pick one of the inputs.
  selector: 'M4 6h9 M4 12h9 M4 18h9 M15 12l2.5 2.5L22 9',
  // Rows of a table with one column pulled out: a list read from a file.
  list: 'M4 5h16 M4 10h16 M4 15h16 M4 20h10 M17 17l3 3-3 3',
  // A funnel: keep some of a list, drop the rest.
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  // A circle with an operator in it: one arithmetic step.
  operation: 'M12 3a9 9 0 1 0 0.01 0 M8 12h8 M12 8v8',
  // A bending line through a point: a number mapped onto 0-100.
  curve: 'M3 20C9 20 10 4 21 4 M3 20h18 M3 20V3',
  // A slider: a value you tune.
  param: 'M4 8h16 M4 16h16 M9 5v6 M15 13v6',
  // Two rings linked: this token matched against a list.
  join: 'M9 12a5 5 0 1 0 0.01 0 M15 12a5 5 0 1 0 0.01 0',
  // A page with one line pulled out of it.
  extract: 'M5 3h9l4 4v6 M5 3v18h8 M9 12h4 M15 17h6 M18 14l3 3-3 3',
  // A cloud: an API we fetch from.
  fetcher: 'M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.3 9.3 4.6 4.6 0 0 0 7 18.5z',
  // A screen: something the dashboard displays.
  item: 'M3 5h18v11H3z M8 20h8 M12 16v4',
  // A loop: a service that keeps running and keeps what it saw.
  service: 'M20 12a8 8 0 1 1-2.34-5.66 M20 4v4h-4 M12 8v4l3 2',
};
/**
 * What a box IS, read off its spec. One type per box; the type decides its
 * icon, its colour and what its body shows.
 */
export const typeOf = (n) => {
  if (n.kind === 'engine') return 'group';
  if (n.kind === 'port') return 'port';
  // An API we call is the fetcher; the raw file it fills is storage.
  if (n.kind === 'provider') return 'fetcher';
  if (n.kind === 'file') return 'storage';
  if (n.kind === 'store') return 'storage';
  if (n.kind === 'panel') return 'panel';
  const f = n.field || {};
  if (f.display) return 'item';
  if (f.service) return 'service';
  if (f.param) return 'param';
  // One operator: a condition (IF, OR, SWITCH, a gate's check) or an
  // operation (− + × ÷ SUM MIN MEAN COUNT CLAMP...).
  if (f.portSpec) return f.portSpec.side === 'in' ? 'input' : 'output';
  if (f.selector) return 'selector';
  if (f.listSpec) return 'list';
  if (f.opSpec && f.opSpec.filter) return 'filter';
  if (f.opSpec) return f.opSpec.cond ? 'condition' : 'operation';
  if (f.decision) return 'condition';
  if (f.curve) return 'curve';
  if (f.agg) return 'aggregate';
  if (f.join) return 'join';
  if (f.extract) return 'extract';
  return 'math';
};

/** The special types wear their own colour; math keeps its pipeline step's. */
export const TYPE_COLORS = {
  aggregate: '#5eead4', condition: '#fb923c', operation: '#e2e8f0', filter: '#f0abfc', list: '#22d3ee', selector: '#86efac', input: '#e7edff', output: '#e7edff', curve: '#a78bfa',
  param: '#94a3b8', join: '#38bdf8', extract: '#2ec4b6', service: '#fbbf24', item: '#60a5fa',
};

export const TYPE_NAMES = {
  group: 'group', math: 'math', aggregate: 'aggregate', condition: 'condition', operation: 'operation', filter: 'filter', list: 'list extractor', selector: 'selector', input: 'group input', output: 'group output', curve: 'curve',
  param: 'parameter', join: 'join / lookup', extract: 'extract', service: 'service', item: 'dashboard item',
  fetcher: 'API fetch', storage: 'storage', panel: 'panel output', port: 'inlet / outlet',
};

const iconKind = (n) => {
  if (n.kind === 'port') return n.side === 'in' ? 'port-in' : 'port-out';
  const t = typeOf(n);
  if (t === 'math') return 'step';
  if (t === 'group') return 'engine';
  if (t === 'storage') return n.kind === 'file' ? 'file' : 'store';
  if (t === 'condition') return 'decision';
  if (t === 'input') return 'port-in';
  if (t === 'output') return 'port-out';
  return t;
};

function KindGlyph({ kind, color, size }) {
  const s = size || 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" style={{ flexShrink: 0, display: 'block' }}
      fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d={ICON_PATHS[kind] || ICON_PATHS.field} />
    </svg>
  );
}

/**
 * How a box's TITLE looks - shared by the collapsed box and the header of
 * the card it opens into, so opening a box changes its size and nothing
 * else. They used to be styled separately and the title jumped font, size
 * and background on every open.
 */
const BOX_FILL = '22';    // alpha suffix on the box colour, collapsed and open
const BOX_STROKE = 'cc';
const BOX_RADIUS = 6;
/** The box that names the token every per-token card is showing. */
const TOKEN_PICKER_ID = 'f:pipe:THIS TOKEN';
const boxLabelStyle = (n) => ({
  flex: 1, minWidth: 0, fontSize: n.kind === 'file' ? 8.5 : 9.5,
  fontWeight: n.kind === 'panel' ? 700 : 500,
  color: '#e7edff', lineHeight: 1.2,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: n.kind === 'file' ? 'ui-monospace, Menlo, Consolas, monospace' : 'inherit',
});

/** What KIND of box this is, in words - shown when you hover its icon. */
function subOf(n) {
  if (n.kind === 'engine') return n.count + ' boxes inside · double-click to open';
  if (n.kind === 'port') return n.side === 'in' ? 'inlet · comes in from outside this engine' : 'outlet · leaves this engine';
  if (n.kind === 'provider') return 'provider we fetch from';
  if (n.kind === 'file') return 'file in the raw store' + (clockOf(n.path) ? ' · ' + clockOf(n.path) : '');
  if (n.kind === 'store') return (STORES[n.id] || {}).backend || 'browser storage';
  // The double-click hint lives here now: it used to be the box's native
  // tooltip, which popped up over this one.
  if (n.kind === 'panel') return PAGE_TITLES[n.page] + ' · ' + n.count + ' fields · double-click to open';
  if (n.flat && STAGES[n.stage]) return 'step ' + STAGES[n.stage].title;
  return PAGE_TITLES[n.page] + ' · ' + n.group;
}

/**
 * A box's kind icon (cloud, file, store...). Hovering it pops up what kind
 * of box this is - the line that used to sit under every card title, moved
 * here so the card holds values rather than labels about itself.
 *
 * Portalled and fixed, like the (?) popover, so the card's clipping and the
 * map's zoom cannot cut it off or shrink it.
 */
function KindIcon({ node, color, size }) {
  const ref = React.useRef(null);
  const [at, setAt] = React.useState(null);
  const show = () => {
    const r = ref.current && ref.current.getBoundingClientRect();
    if (r) setAt({ x: r.left, y: r.bottom + 5 });
  };
  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={() => setAt(null)}
        style={{ flexShrink: 0, cursor: 'help', display: 'inline-flex' }}
      ><KindGlyph kind={iconKind(node)} color={color} size={size} /></span>
      {at && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', left: at.x, top: at.y, zIndex: 60, pointerEvents: 'none',
          background: '#0a1430f2', border: `1px solid ${color}88`, borderRadius: 5,
          padding: '4px 8px', fontSize: 10, color: C.text, whiteSpace: 'nowrap',
          boxShadow: '0 6px 18px #0009',
        }}>
          <div style={{ fontWeight: 800, letterSpacing: 0.6, color }}>{(TYPE_NAMES[typeOf(node)] || node.kind).toUpperCase()}</div>
          {subOf(node) && <div style={{ color: C.dim, marginTop: 2 }}>{subOf(node)}</div>}
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * Every box is a rectangle.
 *
 * They were flowchart shapes for a while - trapezium for a provider,
 * cylinder for storage, and so on. Removed: with a hundred-odd boxes the
 * silhouettes read as noise rather than as meaning, and the thing that
 * actually distinguishes a box is its COLOUR, which the palette above now
 * makes unambiguous. One shape also means one label inset and one outline
 * path, which is a lot less to keep in step.
 */
function roundedPath(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  return `M ${x + rr} ${y} H ${x + w - rr} Q ${x + w} ${y} ${x + w} ${y + rr}`
    + ` V ${y + h - rr} Q ${x + w} ${y + h} ${x + w - rr} ${y + h}`
    + ` H ${x + rr} Q ${x} ${y + h} ${x} ${y + h - rr}`
    + ` V ${y + rr} Q ${x} ${y} ${x + rr} ${y} Z`;
}

/* ------------------------------------------------------------ toolbar --- */

function Button({ onClick, children, title, active }) {
  return (
    <div onClick={onClick} title={title} style={{
      cursor: 'pointer', fontSize: 9, fontWeight: 700, letterSpacing: 0.6,
      padding: '4px 9px', borderRadius: 7, userSelect: 'none',
      border: `1px solid ${active ? C.blue : C.border}`,
      background: active ? '#0e2a5c' : C.panel, color: active ? '#8ab6ff' : C.dim,
    }}>{children}</div>
  );
}

/** The tab names, short enough to sit in a legend. */
const SHORT_TAB = {
  live: 'LIVE', detail: 'DETAIL', social: 'SOCIAL', wallets: 'WALLETS',
  rotation: 'ROTATION',
};


/**
 * Every colour on the canvas, named.
 *
 * It used to show four swatches while eleven colours were in use, so the
 * seven that mattered most - one per tab - had to be guessed from the boxes
 * themselves. Since a line is drawn in the colour of the box it leaves, an
 * incomplete key makes the arrows unreadable too.
 */

const MONO_STACK = 'ui-monospace, Menlo, Consolas, monospace';
/**
 * How often the collector rewrites each file - the server's own intervals
 * (Vibe-mm-server/server.js), so a file box can say how fresh what it holds is.
 */
const FILE_CLOCK = [
  [/market\.json$/, 'rewritten every 5s'],
  [/history\.json$/, 'a sample per pool every 15s'],
  [/trades\.json$/, 'one pool re-sampled every 3s'],
  [/intel\.json$/, 'one token every 2.5s, each refreshed every 45 min'],
  [/reference\.json$/, 'every 60s'],
  [/ethos\.json$/, 'every 2 min, each handle every 30 min'],
  [/bars15\//, 'one pool every 20s, each every 2h'],
  [/observations/, 'a mark per token every 60s'],
  [/social\.json$/, 'every 30s'],
  [/perps\.json$/, 'every 30 min'],
  [/promotion\.json$/, 'every 2 min'],
];
const clockOf = (path) => (FILE_CLOCK.find(([re]) => re.test(path)) || [null, null])[1];

/* --------------------------------------------------------------- view --- */

/* ------------------------------------------------------------ engines --- */

/**
 * THE CONNECTOR - one design for every input and output on the map: a
 * group's IN / OUT and a user's INPUT / OUTPUT alike. A round node and, beside
 * it, a slim name field. The name is edited in place (Enter or click away);
 * the parent group's dot carries the same name. The round node shows the data
 * arriving on hover. An input also has an outlet dot to drag a wire from.
 */
function ConnectorNode({ n, pos, col, dim, isSel, v, side, label, onRename, onMouseDown, onClick, onDoubleClick,
  onHover, onStartWire, onContextMenu, value }) {
  const [tip, setTip] = React.useState(null);
  const ref = React.useRef(null);
  const show = () => {
    const r = ref.current && ref.current.getBoundingClientRect();
    if (r) setTip({ x: side === 'in' ? r.left : r.right, y: r.top - 6 });
    onHover(true);
  };
  const stop = (e) => e.stopPropagation();
  const knob = (
    <div ref={ref} onMouseEnter={show} onMouseLeave={() => { setTip(null); onHover(false); }}
      style={{
        position: 'relative', width: CONNECTOR_H, height: CONNECTOR_H, flexShrink: 0, boxSizing: 'border-box',
        borderRadius: '50%', background: '#060d22', border: `${isSel ? 2.4 : 1.6}px solid ${col}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: isSel ? `0 0 10px ${col}` : 'none',
      }}>
      <KindGlyph kind={side === 'in' ? 'port-in' : 'port-out'} color={col} size={12} />
      {side === 'in' && <Outlet col={col} onMouseDown={onStartWire} style={{ right: -5 }} />}
    </div>
  );
  const field = (
    <input key={label} defaultValue={label} spellCheck={false} title="rename - the group's dot takes the same name"
      onMouseDown={stop} onClick={stop} onDoubleClick={stop}
      onBlur={(e) => { if (e.target.value.trim() && e.target.value.trim().toUpperCase() !== label) onRename(e.target.value); }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.currentTarget.value = label; e.currentTarget.blur(); } }}
      style={{
        flex: 1, minWidth: 0, height: 20, boxSizing: 'border-box', padding: '0 7px', borderRadius: 10,
        background: 'transparent', border: `1px solid ${col}44`, color: C.white, outline: 'none',
        fontFamily: 'inherit', fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
        textAlign: side === 'in' ? 'left' : 'right',
      }}
      onFocus={(e) => { e.currentTarget.style.borderColor = col; e.currentTarget.style.background = '#0d1730'; }}
      onBlurCapture={(e) => { e.currentTarget.style.borderColor = col + '44'; e.currentTarget.style.background = 'transparent'; }} />
  );
  return (
    <>
      <div data-node-id={n.id} onMouseDown={onMouseDown} onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}
        style={{
          position: 'absolute', left: pos.x, top: pos.y, width: n.w, height: n.h, display: 'flex', alignItems: 'center',
          gap: 6, cursor: 'grab', opacity: dim ? 0.3 : 1, flexDirection: side === 'in' ? 'row' : 'row-reverse',
        }}>
        {knob}
        {field}
      </div>
      {tip && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', left: tip.x, top: tip.y, transform: side === 'in' ? 'translate(0, -100%)' : 'translate(-100%, -100%)',
          zIndex: 60, pointerEvents: 'none', background: '#0a1430f2', border: `1px solid ${col}88`, borderRadius: 6,
          padding: '4px 8px', fontSize: 10, color: C.text, whiteSpace: 'nowrap', boxShadow: '0 6px 18px #0009',
        }}>
          <span style={{ color: C.dim }}>{side === 'in' ? 'IN · ' : 'OUT · '}</span>
          {label}{value !== null && value !== undefined && <b style={{ color: C.white, marginLeft: 6 }}>{value}</b>}
        </div>,
        document.body,
      )}
    </>
  );
}

/** A box's outlet dot, on its right edge: press and drag to draw a sketch wire. */
function Outlet({ col, onMouseDown, style, title, missing }) {
  return (
    <span
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      title={title || 'drag to another box to draw a sketch wire'}
      style={{
        position: 'absolute', right: -5, top: '50%', width: 9, height: 9, marginTop: -4.5,
        borderRadius: '50%', background: C.bg, border: `1.5px ${missing ? 'dashed' : 'solid'} ${missing ? WIRE_BAD : col}`, cursor: 'crosshair',
        boxSizing: 'border-box', ...(style || {}),
      }} />
  );
}

/**
 * An ENGINE: a box of boxes, shown from outside as its ports.
 *
 * Inlets down the left edge, outlets down the right, one row each, named by
 * the data that crosses there - so the wires between engines read as which
 * VALUE goes where, the way a Max/MSP subpatcher reads. Double-click to dive
 * in. Drop a box onto it to move that box inside. Drag from an outlet to draw
 * a sketch wire from that value.
 */
/** A calculation box's width: wider than a group, for its working. */
export const CALC_W = 300;

/**
 * The formula as DATA: each input named by what it is (Volume 5m history,
 * Buyer breadth), never by the file or box it came through - following a
 * wire to its source is what the map is for.
 */
function FormulaText({ tokens }) {
  return (
    <span style={{ lineHeight: 1.7 }}>
      {(tokens || []).map((t, i) => {
        if (!t) return null;
        if (t.t === 'op') return <span key={i} style={{ color: C.dim }}>{' ' + t.s + ' '}</span>;
        if (t.t === 'num') return <span key={i} style={{ color: C.white, fontWeight: 700 }}>{' ' + t.s + ' '}</span>;
        const name = t.t === 'ref' ? t.label || t.field
          : t.t === 'api' ? t.field
            : t.t === 'ext' ? t.field || t.source : null;
        if (!name) return null;
        return (
          <span key={i} style={{
            display: 'inline-block', padding: '0 5px', margin: '0 1px', borderRadius: 4,
            border: `1px solid ${C.teal}55`, background: C.teal + '14', color: C.teal,
            fontSize: 9, lineHeight: '15px', whiteSpace: 'nowrap',
          }}>{name}</span>
        );
      })}
    </span>
  );
}

const capStyle = { fontSize: 7, letterSpacing: 1.1, fontWeight: 700, color: C.grey, marginBottom: 3 };

/**
 * A SERVICE: always on, in the background, and it keeps what it saw. It
 * says how often it runs, what it remembers and what it costs upstream.
 */
/**
 * A DASHBOARD ITEM: what one panel shows, and nothing else - no arithmetic.
 * Its wires come straight from the box whose value it displays.
 */
function ItemBody({ display, col, result }) {
  const shown = result === null || result === undefined || result === '' ? '—' : String(result);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: 0.8, color: col, padding: '1px 6px',
          border: `1px solid ${col}66`, borderRadius: 6 }}>{String(display).toUpperCase()}</span>
        <span style={{ fontSize: 8, color: C.faint }}>shown on the dashboard</span>
      </div>
      <div style={{ fontSize: display === 'number' ? 16 : 10.5, fontWeight: 800, color: C.white,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shown}</div>
    </div>
  );
}

function ServiceBody({ spec, col, result }) {
  const row = (k, x) => (
    <div style={{ display: 'flex', gap: 8, fontSize: 9, lineHeight: '14px' }}>
      <span style={{ width: 44, flexShrink: 0, fontSize: 7.5, fontWeight: 700, letterSpacing: 0.8, color: C.grey }}>{k}</span>
      <span style={{ color: C.text, minWidth: 0 }}>{x}</span>
    </div>
  );
  return (
    <div>
      {row('RUNS', 'every ' + spec.every)}
      {row('KEEPS', spec.keeps)}
      {spec.costs && row('COSTS', spec.costs)}
      <ResultLine name="STATUS" value={result} col={col} />
    </div>
  );
}

function ResultLine({ name, value, col }) {
  if (value === null || value === undefined) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
      <span style={{ fontSize: 7.5, letterSpacing: 1, color: C.grey, fontWeight: 700 }}>{name}</span>
      <span style={{ fontSize: 13, fontWeight: 800, color: col }}>{value}</span>
    </div>
  );
}

/** A DECISION: the condition, which way it went, and why. */
function DecisionBody({ f, v, col, tokens, working, result }) {
  let ok = null;
  try { ok = f.decision.test(v); } catch (e) { ok = null; }
  const lit = ok === null ? { t: 'NOT CHECKED', c: C.grey } : ok ? { t: f.decision.yes, c: '#4ade80' } : { t: f.decision.no, c: '#f87171' };
  return (
    <>
      <div style={capStyle}>CONDITION</div>
      <FormulaText tokens={tokens} />
      <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px dashed ${C.line}` }}>
        <div style={capStyle}>THIS TOKEN</div>
        {working ? <WorkedSteps text={working} accent={col} result={result} /> : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.6, color: lit.c, padding: '2px 8px',
            borderRadius: 999, border: `1px solid ${lit.c}88`, background: lit.c + '18' }}>{lit.t}</span>
        </div>
      </div>
    </>
  );
}

/**
 * ONE OPERATOR. An operation shows its symbol and this token's arithmetic; a
 * condition shows its test and which way it went - the branch taken lit, the
 * other dimmed.
 */
function OpBody({ o, v, col, result }) {
  const call = (fn) => { if (typeof fn !== 'function') return fn; try { return fn(v); } catch (e) { return null; } };
  const c = o.cond;
  const fmt = (x) => (x === null || x === undefined ? '—' : String(x));
  const row = (tag, text, on, tone) => (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '3px 6px', borderRadius: 5, margin: '2px 0',
      background: on ? tone + '1f' : 'transparent', border: `1px solid ${on ? tone + '88' : C.line}`, opacity: on === false ? 0.45 : 1 }}>
      <span style={{ width: 40, flexShrink: 0, fontSize: 8, fontWeight: 800, letterSpacing: 0.8, color: on ? tone : C.grey }}>{tag}</span>
      <span style={{ flex: 1, fontSize: 9.5, fontFamily: MONO_STACK, color: on ? C.white : C.dim }}>{text}</span>
    </div>
  );
  if (c && c.kind === 'IF') {
    const t = call(c.test);
    return (
      <>
        {row('IF', c.when + (t === null ? ' ?' : t ? '  → yes' : '  → no'), t === null ? null : true, t ? '#4ade80' : '#f87171')}
        {row('THEN', fmt(call(c.then)), t === null ? null : t === true, '#4ade80')}
        {row('ELSE', fmt(call(c.else)), t === null ? null : t === false, '#fbbf24')}
        <ResultLine name="RESULT" value={result} col={col} />
      </>
    );
  }
  if (c && c.kind === 'OR') {
    const terms = call(c.terms) || [];
    const any = terms.some((x) => x.ok === true);
    return (
      <>
        <div style={capStyle}>{c.when.toUpperCase()}</div>
        {terms.map((x, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8.5, fontFamily: MONO_STACK,
            color: x.ok ? '#f87171' : C.dim }}>
            <span>{x.label}</span><span>{x.ok === null ? 'not checked' : x.ok ? (c.words ? c.words[0] : 'VETO') : (c.words ? c.words[1] : 'pass')}</span>
          </div>
        ))}
        <div style={{ marginTop: 4, fontSize: 9.5, fontFamily: MONO_STACK, color: any ? '#f87171' : '#4ade80' }}>
          OR → {any ? (c.words ? c.words[0] : 'VETO') : (c.words ? c.words[1] : 'clean')}
        </div>
      </>
    );
  }
  if (c && c.kind === 'SWITCH') {
    const x = call(c.input);
    const hit = Number.isFinite(x) ? c.cases.findIndex((k) => x >= k.min) : -1;
    return (
      <>
        <div style={capStyle}>SWITCH ON {fmt(x)}</div>
        {c.cases.map((k, i) => row(k.when, k.then, hit === -1 ? null : i === hit, '#4ade80'))}
      </>
    );
  }
  // An operation: the symbol, then this token's numbers.
  const expr = call(o.expr);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: o.sym.length > 2 ? 11 : 18, fontWeight: 900, color: col, minWidth: 24, textAlign: 'center' }}>{o.sym}</span>
        <span style={{ flex: 1, fontSize: 9.5, fontFamily: MONO_STACK, color: C.text }}>{expr || 'no value for this token yet'}</span>
      </div>
      <ResultLine name="=" value={result} col={col} />
    </>
  );
}

/** A dotted path out of a record: 'sources.dexscreener.liquidityUsd'. */
const atPath = (obj, path) => String(path).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const brief = (x) => {
  if (x === null || x === undefined) return '—';
  if (typeof x === 'number') return String(Math.round(x * 1000) / 1000);
  if (typeof x === 'string') return x.length > 22 ? x.slice(0, 10) + '…' + x.slice(-6) : x;
  if (Array.isArray(x)) return '[' + x.length + ']';
  return '{…}';
};

/**
 * A LIST EXTRACTOR: a file's list (every trade, every row) read as a list.
 * One row is shown as the TEMPLATE - its fields, the ones picked out of
 * every row lit - and the whole list goes on to a filter, a sum, a count.
 */
function ListBody({ spec, v, col }) {
  let rows = [];
  try { rows = spec.rows(v) || []; } catch (e) { rows = []; }
  const first = rows[0];
  return (
    <>
      <div style={capStyle}>TEMPLATE · ONE OF {rows.length} {String(spec.of).toUpperCase()}</div>
      {first === undefined ? (
        <div style={{ fontSize: 9.5, color: C.grey }}>no rows for this token yet</div>
      ) : (
        <div style={{ fontFamily: MONO_STACK, fontSize: 8.5, lineHeight: 1.55 }}>
          {spec.fields.map((f) => (
            <div key={f} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ color: C.teal }}>{f}</span>
              <span style={{ color: C.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brief(atPath(first, f))}</span>
            </div>
          ))}
          {first && typeof first === 'object' && (
            <div style={{ color: C.grey, marginTop: 2 }}>
              + {Object.keys(first).filter((k) => !k.startsWith('_') && !spec.fields.some((f) => f === k || f.startsWith(k + '.'))).length} other fields not read
            </div>
          )}
        </div>
      )}
      <ResultLine name="LIST" value={rows.length + ' ' + spec.of} col={col} />
    </>
  );
}

/**
 * A SELECTOR: every option it is given, one of them picked. Click a row to
 * pick it; the search narrows a long list. The list scrolls by itself (the
 * map does not zoom under it).
 */
function SelectorBody({ spec, v, col }) {
  const [q, setQ] = React.useState('');
  const listRef = React.useRef(null);
  let options = [];
  try { options = spec.options(v) || []; } catch (e) { options = []; }
  let selected = null;
  try { selected = spec.selected(v); } catch (e) { selected = null; }
  const needle = q.trim().toLowerCase().replace(/^\$/, '');
  const shown = needle
    ? options.filter((o) => String(o.label).toLowerCase().replace(/^\$/, '').includes(needle) || String(o.sub || '').toLowerCase().includes(needle))
    : options;
  // Keep the picked row in view when the box first draws.
  React.useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('[data-picked="1"]');
    if (el && listRef.current) listRef.current.scrollTop = Math.max(0, el.offsetTop - 60);
  }, [selected]);
  const stop = (e) => e.stopPropagation();
  const current = options.find((o) => o.id === selected);
  return (
    <div onMouseDown={stop} onClick={stop} onDoubleClick={stop}>
      <div style={capStyle}>PICK ONE OF {options.length} {String(spec.of).toUpperCase()}</div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search" spellCheck={false}
        style={{ width: '100%', boxSizing: 'border-box', background: '#0d1730', color: C.text, border: `1px solid ${C.border}`,
          borderRadius: 5, padding: '4px 7px', fontFamily: 'inherit', fontSize: 9.5, outline: 'none', marginBottom: 4 }} />
      <div ref={listRef} data-card="1" style={{ maxHeight: 200, overflowY: 'auto', border: `1px solid ${C.line}`, borderRadius: 5 }}>
        {shown.map((o) => {
          const on = o.id === selected;
          return (
            <div key={o.id} data-picked={on ? '1' : '0'} onClick={() => spec.pick(v, o.id)} style={{
              display: 'flex', alignItems: 'baseline', gap: 6, padding: '3px 7px', cursor: 'pointer',
              background: on ? col + '22' : 'transparent', borderLeft: `2px solid ${on ? col : 'transparent'}`,
            }}>
              <span style={{ fontSize: 9.5, fontWeight: 700, color: on ? C.white : C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
              <span style={{ fontSize: 8, color: C.faint, flex: 1 }}>{o.sub}</span>
              <span style={{ fontSize: 9, fontFamily: MONO_STACK, color: o.value === 'VETO' ? '#f87171' : C.dim }}>{o.value}</span>
            </div>
          );
        })}
        {!shown.length && <div style={{ padding: 8, fontSize: 9, color: C.grey }}>no match</div>}
      </div>
      <ResultLine name="SELECTED" value={current ? current.label + ' · ' + current.sub : null} col={col} />
    </div>
  );
}

/**
 * A RULE FILTER: keep the rows that pass each rule, in order. Every rule says
 * how many rows it dropped; a rule with a number (first N) has the standard
 * input on it.
 */
function RuleFilterBody({ o, v, col, result }) {
  const spec = o.filter;
  let rows = [];
  try { rows = spec.rows(v) || []; } catch (e) { rows = []; }
  const start = rows.length;
  const steps = spec.rules.map((rule) => {
    const before = rows.length;
    try { rows = rule.apply(rows, v) || []; } catch (e) { /* keep rows */ }
    return { rule, dropped: before - rows.length };
  });
  return (
    <>
      <div style={capStyle}>KEEP THE {String(spec.of).toUpperCase()} WHERE</div>
      {steps.map(({ rule, dropped }, i) => (
        <div key={i} style={{ margin: '3px 0', padding: '3px 6px', borderRadius: 5, border: `1px solid ${C.line}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 9 }}>
            <span style={{ color: C.text }}>{rule.label}</span>
            <span style={{ color: dropped ? '#f87171' : C.grey, fontFamily: MONO_STACK, flexShrink: 0 }}>−{dropped}</span>
          </div>
          {rule.setting && (
            <div style={{ marginTop: 3 }}>
              <NumberInput id={rule.setting.id} def={rule.setting.def} step={rule.setting.step} min={rule.setting.min} max={rule.setting.max} col={col} compact />
            </div>
          )}
        </div>
      ))}
      <div style={{ fontSize: 9, fontFamily: MONO_STACK, color: C.dim, marginTop: 4 }}>{start} in → {rows.length} kept</div>
      <ResultLine name="KEPT" value={result} col={col} />
    </>
  );
}

/**
 * A FILTER: keep the highest, middle or lowest N of a list. The mode and N
 * are controls on the box - the first box a user can change - and every box
 * after it computes from what is kept. Below: the whole list as bars, the
 * kept ones lit.
 */
function FilterBody({ o, v, col, result }) {
  const spec = o.filter;
  const s = filterSetting(spec.id, spec.defaults);
  let values = [];
  try { values = spec.values(v) || []; } catch (e) { values = []; }
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => b - a);
  const kept = applyFilter(sorted, s);
  const keptSet = new Map();
  kept.forEach((x) => keptSet.set(x, (keptSet.get(x) || 0) + 1));
  const lit = sorted.map((x) => { const c = keptSet.get(x) || 0; if (c) { keptSet.set(x, c - 1); return true; } return false; });
  const isDefault = s.mode === spec.defaults.mode && s.n === spec.defaults.n;
  const stop = (e) => e.stopPropagation();
  const max = sorted.length ? sorted[0] : 1;
  const W = 260;
  const H = 34;
  const bw = sorted.length ? W / sorted.length : W;
  return (
    <div onMouseDown={stop} onClick={stop}>
      <div style={capStyle}>KEEP</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 5 }}>
        {FILTER_MODES.map((m) => (
          <button key={m.id} onClick={() => (m.id === spec.defaults.mode ? clearSetting(spec.id) : setSetting(spec.id, { mode: m.id }))} style={{
            flex: 1, cursor: 'pointer', fontFamily: 'inherit', fontSize: 8.5, fontWeight: 800, letterSpacing: 0.6,
            padding: '4px 0', borderRadius: 5, border: `1px solid ${s.mode === m.id ? col : C.border}`,
            background: s.mode === m.id ? col + '26' : 'transparent', color: s.mode === m.id ? C.white : C.dim,
          }}>{m.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <NumberInput id={spec.id + ':n'} def={spec.defaults.n} step={1} min={1} max={Math.max(sorted.length, 1)} col={col} />
        <span style={{ fontSize: 9, color: C.dim }}>of {sorted.length} {spec.of}</span>
      </div>
      {sorted.length > 0 && (
        <svg width="100%" viewBox={'0 0 ' + W + ' ' + H} preserveAspectRatio="none" style={{ display: 'block', height: H, marginTop: 6 }}>
          {sorted.map((x, i) => {
            const h = Math.max(1, (Math.sqrt(x / max)) * (H - 2));
            return <rect key={i} x={i * bw} y={H - h} width={Math.max(0.6, bw - 0.4)} height={h} fill={lit[i] ? col : C.line} />;
          })}
        </svg>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, fontFamily: MONO_STACK, color: C.faint, marginTop: 2 }}>
        <span>highest</span><span>lowest</span>
      </div>
      {!isDefault && (
        <div style={{ fontSize: 8.5, color: C.amber, marginTop: 4 }}>
          changed from the default ({spec.defaults.mode === 'top' ? 'highest' : spec.defaults.mode} {spec.defaults.n}) - a preview; the score still uses the default
        </div>
      )}
      <ResultLine name="KEPT" value={result} col={col} />
    </div>
  );
}

/** A CURVE: the mapping drawn, with this token's input marked on it. */
function CurveBody({ f, v, col, tokens, result }) {
  const c = f.curve;
  let x = null;
  try { x = c.x(v); } catch (e) { x = null; }
  const W = 260;
  const H = 70;
  const N = 60;
  const toT = (val) => (c.log ? (Math.log10(val) - Math.log10(c.lo)) / (Math.log10(c.hi) - Math.log10(c.lo)) : (val - c.lo) / (c.hi - c.lo));
  const fromT = (t) => (c.log ? Math.pow(10, Math.log10(c.lo) + t * (Math.log10(c.hi) - Math.log10(c.lo))) : c.lo + t * (c.hi - c.lo));
  const yOf = (score) => H - 4 - (Math.max(0, Math.min(100, score)) / 100) * (H - 8);
  const pts = [];
  for (let i = 0; i <= N; i += 1) {
    let y = null;
    try { y = c.f(fromT(i / N)); } catch (e) { y = null; }
    if (Number.isFinite(y)) pts.push([(i / N) * W, yOf(y)]);
  }
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  let fx = null;
  if (Number.isFinite(x) && (!c.log || x > 0)) { try { fx = c.f(x); } catch (e) { fx = null; } }
  const px = Number.isFinite(x) && (!c.log || x > 0) ? Math.max(0, Math.min(1, toT(x))) * W : null;
  return (
    <>
      <div style={capStyle}>CURVE</div>
      <FormulaText tokens={tokens} />
      <svg width="100%" viewBox={'0 0 ' + W + ' ' + H} preserveAspectRatio="none" style={{ display: 'block', height: H, marginTop: 4 }}>
        <line x1={0} x2={W} y1={yOf(50)} y2={yOf(50)} stroke={C.line} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        <path d={path} fill="none" stroke={col} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
        {px !== null && Number.isFinite(fx) && (
          <>
            <line x1={px} x2={px} y1={H} y2={yOf(fx)} stroke={C.white} strokeDasharray="2 2" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
            <circle cx={px} cy={yOf(fx)} r={3.2} fill={C.white} />
          </>
        )}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8.5, fontFamily: MONO_STACK, color: C.faint, marginTop: 2 }}>
        <span>{c.xFmt(c.lo)}</span>
        <span style={{ color: C.text }}>{Number.isFinite(x) ? c.xFmt(x) + ' → ' + (Number.isFinite(fx) ? fx : 'no score') : 'no input yet'}</span>
        <span>{c.xFmt(c.hi)}</span>
      </div>
      <ResultLine name="SCORE" value={result} col={col} />
    </>
  );
}

/** A PARAMETER: the constant itself, and what it tunes. */
function ParamBody({ f, col, result }) {
  const p = f.param;
  const changed = p.list ? p.list.some((x) => getSetting(x.id, { n: x.def }).n !== x.def)
    : getSetting(p.id, { n: p.def }).n !== p.def;
  return (
    <>
      {p.list ? (
        <>
          <div style={capStyle}>WEIGHTS</div>
          {p.list.map((x) => (
            <div key={x.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, margin: '2px 0' }}>
              <span style={{ fontSize: 8.5, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.label}</span>
              <NumberInput id={x.id} def={x.def} step={x.step} min={x.min} max={x.max} col={col} compact />
            </div>
          ))}
          <ResultLine name="TOTAL" value={result} col={col} />
        </>
      ) : (
        <>
          <div style={capStyle}>VALUE</div>
          <NumberInput id={p.id} def={p.def} step={p.step} min={p.min} max={p.max} col={col} />
          <div style={{ fontSize: 8, color: C.faint, marginTop: 3 }}>default {Number(p.def).toLocaleString('en-US')}</div>
        </>
      )}
      {changed && (
        <div style={{ fontSize: 8.5, color: C.amber, marginTop: 4 }}>
          changed - the boxes on the map now use it; the dashboard score still uses the default
        </div>
      )}
      {f.note && <div style={{ fontSize: 8.5, color: C.faint, marginTop: 3 }}>{f.note}</div>}
    </>
  );
}

/**
 * THE number input - one control for every value a user can change: a
 * parameter, a weight, a filter's count. A raw number (the unit is in the
 * box's name), − / + by its step, typed directly, and RESET once it differs
 * from its default.
 */
export function NumberInput({ id, def, step, min, max, col, compact }) {
  const val = getSetting(id, { n: def }).n;
  const clampN = (x) => {
    let n = Number(x);
    if (!Number.isFinite(n)) return val;
    if (Number.isFinite(min)) n = Math.max(min, n);
    if (Number.isFinite(max)) n = Math.min(max, n);
    return Math.round(n * 1e6) / 1e6;
  };
  const set = (x) => { const n = clampN(x); if (n === def) clearSetting(id); else setSetting(id, { n }); };
  const stop = (e) => e.stopPropagation();
  const changed = val !== def;
  const btn = { width: compact ? 18 : 22, height: compact ? 18 : 22, cursor: 'pointer', borderRadius: 5, padding: 0,
    border: `1px solid ${C.border}`, background: 'transparent', color: C.text, fontWeight: 800, fontSize: compact ? 10 : 12 };
  return (
    <span onMouseDown={stop} onClick={stop} onDoubleClick={stop} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button style={btn} onClick={() => set(val - (step || 1))}>−</button>
      <input type="number" value={val} step={step || 1} onChange={(e) => set(e.target.value)}
        style={{ width: compact ? 62 : 104, textAlign: 'right', background: '#0d1730', color: C.white,
          border: `1px solid ${changed ? C.amber : col}`, borderRadius: 5, padding: compact ? '1px 4px' : '3px 6px',
          fontFamily: MONO_STACK, fontSize: compact ? 9.5 : 11, fontWeight: 800, outline: 'none' }} />
      <button style={btn} onClick={() => set(val + (step || 1))}>+</button>
      {changed && (
        <button onClick={() => clearSetting(id)} title={'back to the default, ' + def}
          style={{ cursor: 'pointer', fontSize: 7.5, fontWeight: 800, letterSpacing: 0.5, padding: compact ? '1px 4px' : '3px 6px',
            borderRadius: 5, border: `1px solid ${C.amber}88`, background: 'transparent', color: C.amber }}>RESET</button>
      )}
    </span>
  );
}

/** A JOIN: the key this token is looked up by, the list, what matched. */
function JoinBody({ f, v, col, result }) {
  const j = f.join;
  const call = (fn) => { try { return fn(v); } catch (e) { return null; } };
  const key = call(j.key);
  const against = call(j.against);
  const matches = call(j.matches) || [];
  return (
    <>
      <div style={capStyle}>LOOK UP BY {String(j.by).toUpperCase()}</div>
      <div style={{ fontSize: 10, fontFamily: MONO_STACK, color: C.white }}>{key || '—'}</div>
      <div style={{ ...capStyle, marginTop: 6 }}>IN</div>
      <div style={{ fontSize: 9, color: C.dim }}>{against || 'not loaded yet'}</div>
      <div style={{ ...capStyle, marginTop: 6 }}>MATCHED</div>
      {matches.length
        ? matches.map((m, i) => <div key={i} style={{ fontSize: 9.5, color: col, fontFamily: MONO_STACK }}>{m}</div>)
        : <div style={{ fontSize: 9.5, color: C.grey }}>no match</div>}
      <ResultLine name="RESULT" value={result} col={col} />
    </>
  );
}


/** An EXTRACT: the keys picked out of the file, and the value they give. */
function ExtractBody({ f, col, result }) {
  return (
    <>
      <div style={capStyle}>PICKS FROM {String(f.extract.path).replace(/^\/raw\//, '').toUpperCase()}</div>
      {f.extract.picks.map((k, i) => (
        <div key={i} style={{ fontSize: 8.5, fontFamily: MONO_STACK, color: C.dim, wordBreak: 'break-all' }}>{k}</div>
      ))}
      <ResultLine name="VALUE" value={result} col={col} />
    </>
  );
}

/**
 * What an AGGREGATE box shows instead of a formula: the collection itself, as
 * a little chart, with the reduced value drawn across it - so "the mean of
 * 809 samples" is something you can see, not a number to take on trust.
 */
/** A duration, short: 5h 59m, 14m 30s, 45s. */
const duration = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
};

function AggregateBody({ agg, v, col }) {
  let pts = [];
  let result = null;
  try { pts = agg.points ? agg.points(v) || [] : (agg.series(v) || []).map((x) => ({ x })); } catch (e) { pts = []; }
  try { result = agg.result(v); } catch (e) { result = null; }
  const xs = pts.map((p) => p.x);
  const count = xs.length;
  const covers = pts.length > 1 && Number.isFinite(pts[0].t) ? pts[pts.length - 1].t - pts[0].t : null;
  const win = agg.window ? getSetting(agg.window.id, { n: agg.window.def }).n : null;
  const fmt = agg.fmt || ((n) => String(n));
  const W = 260;
  const H = 46;
  const lo = xs.length ? Math.min(...xs, result ?? Infinity) : 0;
  const hi = xs.length ? Math.max(...xs, result ?? -Infinity) : 1;
  const span = hi - lo || 1;
  const y = (val) => H - 3 - ((val - lo) / span) * (H - 6);
  const step = xs.length > 1 ? W / (xs.length - 1) : 0;
  const line = xs.map((val, i) => (i ? 'L' : 'M') + (i * step).toFixed(1) + ' ' + y(val).toFixed(1)).join(' ');
  const cap = (t) => <div style={{ fontSize: 7, letterSpacing: 1.1, fontWeight: 700, color: C.grey, marginBottom: 3 }}>{t}</div>;
  return (
    <>
      {cap(agg.fn + ' OF ' + count + ' VALUES · ' + agg.what.toUpperCase())}
      {/* The time frame: how often a value arrives, and what span they cover. */}
      <div style={{ fontSize: 9, color: C.dim, marginBottom: 4 }}>
        {agg.every ? 'one every ' + agg.every + ' · ' : ''}
        {covers !== null ? 'covering the last ' + duration(covers) : 'no time span yet'}
      </div>
      {agg.window && (
        <div onMouseDown={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 5 }}>
          <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 0.8, color: C.grey }}>WINDOW (min)</span>
          <NumberInput id={agg.window.id} def={agg.window.def} step={agg.window.step} min={agg.window.min} max={agg.window.max} col={col} compact />
          <span style={{ fontSize: 8, color: C.faint }}>
            {win !== agg.window.def ? (agg.window.live ? 'the score uses this window' : 'preview - the score uses ' + agg.window.def + ' min') : agg.window.note}
          </span>
        </div>
      )}
      {xs.length > 1 ? (
        <svg width="100%" viewBox={'0 0 ' + W + ' ' + H} preserveAspectRatio="none" style={{ display: 'block', height: H }}>
          <path d={line} fill="none" stroke={C.dim} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
          {result !== null && (
            <line x1={0} x2={W} y1={y(result)} y2={y(result)} stroke={col} strokeWidth={1.4}
              strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      ) : (
        <div style={{ fontSize: 9.5, color: C.grey }}>no series for this token yet</div>
      )}
      {xs.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8.5, fontFamily: MONO_STACK, color: C.faint, marginTop: 2 }}>
          <span>min {fmt(Math.min(...xs))}</span>
          <span style={{ color: col }}>- - {agg.fn.toLowerCase()}</span>
          <span>max {fmt(Math.max(...xs))}</span>
        </div>
      )}
    </>
  );
}

/**
 * A CALCULATION box. Always open - no box on the map expands. Top: what
 * comes in (left) and what goes out (right), each named by its data with its
 * value, on the rows the wires attach to. Below: the formula in data names,
 * then this token's numbers worked through to the result.
 */
function CalcBox({ n, pos, col, dim, isSel, isNear, inGroup, onMouseDown, onClick, onHover, onStartWire,
  v, nodeById, onMeasure, alert, onContextMenu }) {
  const ref = React.useRef(null);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const report = () => onMeasure(n.id, el.offsetHeight);
    report();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n.id, onMeasure]);

  const f = n.field || {};
  const type = typeOf(n);
  const live = (x) => {
    if (typeof x !== 'function') return x || null;
    try { return x(v); } catch (e) { return null; }
  };
  const result = boxValue(n, v);
  const working = live(f.equation);
  const tokens = f.calc || f.fetch || [];
  const rows = Math.max(n.inPorts.length, n.outPorts.length, 1);
  const valueOf = (p) => {
    if (p.cut) return null; // its wire is cut: nothing arrives
    // Re-fed: what arrives, converted to the type this dot expects.
    if (p.via && Object.prototype.hasOwnProperty.call(WIRE_VALUES, p.via)) {
      return showValue(coerce(WIRE_VALUES[p.via], declaredType(p.key, (nodeById && nodeById.get(p.key)) || p)));
    }
    const src = nodeById && nodeById.get(p.via || p.key);
    if (src && src.kind === 'field') return boxValue(src, v);
    return p.field ? boxValue({ kind: 'field', field: p.field }, v) : null;
  };
  const port = (p, side) => {
    const val = side === 'out' && p.key === n.id ? result : valueOf(p);
    const unit = unitOf(val, side === 'out' && p.key === n.id ? n : (nodeById && nodeById.get(p.key)) || p);
    return (
      <span title={p.label + (unit ? ' · ' + UNIT_NAMES[unit] : '')} style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0, maxWidth: '100%',
        justifyContent: side === 'in' ? 'flex-start' : 'flex-end' }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, color: C.dim }}>{p.label}</span>
        {val !== null && <span style={{ color: C.white, fontWeight: 700, flexShrink: 0 }}>{val}</span>}
      </span>
    );
  };
  const label = (t) => (
    <div style={{ fontSize: 7, letterSpacing: 1.1, fontWeight: 700, color: C.grey, marginBottom: 2 }}>{t}</div>
  );
  return (
    <div ref={ref} data-node-id={n.id} onMouseDown={onMouseDown} onClick={onClick} onContextMenu={onContextMenu}
      onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}
      style={{
        position: 'absolute', left: pos.x, top: pos.y, width: n.w, boxSizing: 'border-box',
        borderRadius: 8, background: '#0a1430', cursor: 'grab', opacity: dim ? 0.3 : 1,
        border: `${isSel ? 2 : 1.5}px ${inGroup ? 'dashed' : 'solid'} ${inGroup ? '#ffffff' : alert ? WIRE_BAD : col}`,
        boxShadow: isSel ? `0 0 0 1px ${col}, 0 0 20px ${col}99` : (isNear ? `0 0 0 1px ${col}` : '0 6px 18px rgba(0,0,0,.55)'),
      }}>
      <div style={{
        height: ENGINE.HEAD, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
        background: col + '22', borderBottom: `1px solid ${col}44`, borderRadius: '6px 6px 0 0',
      }}>
        <KindIcon node={n} color={col} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5, color: '#e7edff',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span>
        {f.weight && <span title="its weight in the score" style={{ fontSize: 8.5, color: C.faint }}>{f.weight}</span>}
        {alert && (
          <span title={alert.join('\n')} style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: 0.6, color: WIRE_BAD,
            padding: '1px 5px', borderRadius: 6, border: `1px solid ${WIRE_BAD}88`, cursor: 'help' }}>MISSING DATA</span>
        )}
        {f.memory && (
          <span title={'remembers: ' + f.memory} style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: 0.6, color: '#fde68a',
            padding: '1px 5px', borderRadius: 6, border: '1px solid #fde68a66', cursor: 'help' }}>MEMORY</span>
        )}
        <span title={TYPE_NAMES[type]} style={{ fontSize: 7.5, letterSpacing: 0.6, color: col, opacity: 0.8 }}>{TYPE_NAMES[type].toUpperCase()}</span>
        {f.note && <span title={f.note} style={{ fontSize: 9, color: C.amber, cursor: 'help' }}>?</span>}
      </div>
      {/* The ports: the rows the wires land on, at the same height as a group's. */}
      <div style={{ position: 'relative', height: rows * ENGINE.ROW }}>
        {Array.from({ length: rows }).map((_, i) => {
          const pin = n.inPorts[i];
          const pout = n.outPorts[i];
          return (
            <div key={i} style={{
              position: 'absolute', left: 0, right: 0, top: i * ENGINE.ROW, height: ENGINE.ROW,
              display: 'flex', alignItems: 'center', fontSize: 8, fontFamily: MONO_STACK,
            }}>
              <div data-inport={pin ? pin.key : undefined} style={{ position: 'relative', flex: 1, minWidth: 0, paddingLeft: 9, paddingRight: 3 }}>
                {pin && (() => {
                  const t = pin.cut ? { expected: declaredType(pin.key, (nodeById && nodeById.get(pin.key)) || pin), receiving: null, val: null }
                    : portType(pin.key, valueOf(pin), (nodeById && nodeById.get(pin.key)) || pin, carriesValue(pin, nodeById), pin.via);
                  return (
                    <>
                      <InDot label={pin.label} t={t} />
                      {port(pin, 'in')}
                    </>
                  );
                })()}
              </div>
              <div style={{ position: 'relative', flex: 1, minWidth: 0, paddingRight: 9, paddingLeft: 3, textAlign: 'right' }}>
                {pout && (() => {
                  const ov = pout.key === n.id ? result : valueOf(pout);
                  const t = portType(pout.key, ov, pout.key === n.id ? n : (nodeById && nodeById.get(pout.key)) || pout,
                    pout.key === n.id || carriesValue(pout, nodeById));
                  return (
                    <>
                      {port(pout, 'out')}
                      <Outlet col={dotColor(t)} missing={!t.receiving} title={typeTitle(pout.label, t, 'out')}
                        onMouseDown={onStartWire(pout.key)} style={{ right: -5 }} />
                    </>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
      {/* The body: what this TYPE of box does, for this token. */}
      <div style={{ margin: `${ENGINE.PAD}px 8px 8px`, padding: '6px 8px', borderRadius: 6,
        background: '#060d22', border: `1px solid ${C.line}`, fontSize: 9.5 }}>
        {type === 'aggregate' && (
          <>
            <AggregateBody agg={f.agg} v={v} col={col} />
            <ResultLine name={f.agg.fn} value={result} col={col} />
          </>
        )}
        {(type === 'condition' || type === 'operation') && f.opSpec && <OpBody o={f.opSpec} v={v} col={col} result={result} />}
        {type === 'filter' && (f.opSpec.filter.rules
          ? <RuleFilterBody o={f.opSpec} v={v} col={col} result={result} />
          : <FilterBody o={f.opSpec} v={v} col={col} result={result} />)}
        {type === 'list' && <ListBody spec={f.listSpec} v={v} col={col} />}
        {type === 'selector' && <SelectorBody spec={f.selector} v={v} col={col} />}
        {type === 'service' && <ServiceBody spec={f.service} col={col} result={result} />}
        {type === 'item' && <ItemBody display={f.display} col={col} result={result} />}
        {type === 'condition' && !f.opSpec && <DecisionBody f={f} v={v} col={col} tokens={tokens} working={working} result={result} />}
        {type === 'curve' && <CurveBody f={f} v={v} col={col} tokens={tokens} result={result} />}
        {type === 'param' && <ParamBody f={f} col={col} result={result} />}
        {type === 'join' && <JoinBody f={f} v={v} col={col} result={result} />}
        {type === 'extract' && <ExtractBody f={f} col={col} result={result} />}
        {type === 'math' && (
          <>
            {label('FORMULA')}
            <FormulaText tokens={tokens} />
            <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px dashed ${C.line}` }}>
              {label('THIS TOKEN')}
              {working
                ? <WorkedSteps text={working} accent={col} result={result} />
                : <div style={{ fontSize: 9.5, color: C.grey }}>no value for this token yet</div>}
              <ResultLine name="RESULT" value={result} col={col} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/*
 * API BOXES - each one shows how the API is doing and what it last sent.
 * Health is the server's own counters for the API's host (system.json,
 * judged by providerHealth(), as on the SERVER page); the sample is this
 * API's part of the selected token's record in the raw file it fills.
 */
const PROVIDER_HOSTS = {
  geckoterminal: 'api.geckoterminal.com', dexscreener: 'api.dexscreener.com', jupiter: 'lite-api.jup.ag',
  kyberswap: 'aggregator-api.kyberswap.com', goplus: 'api.gopluslabs.io', rugcheck: 'api.rugcheck.xyz',
  honeypot: 'api.honeypot.is', defillama: 'coins.llama.fi', ethos: 'api.ethos.network',
  hyperliquid: 'api.hyperliquid.xyz', binance: 'fapi.binance.com', aster: 'fapi.asterdex.com',
  okx: 'www.okx.com', bybit: 'api.bybit.com', cex: 'api.coingecko.com',
  'binance-spot': 'api.binance.com', coinbase: 'api.coinbase.com', reddit: 'www.reddit.com', '4chan': 'a.4cdn.org',
  mastodon: 'mastodon.social', warpcast: 'api.warpcast.com', bluesky: 'public.api.bsky.app',
};
/** Where an API's answer sits in intel.json's per-token record. */
const INTEL_KEYS = { goplus: 'goplus', rugcheck: 'rugcheck', honeypot: 'honeypot', kyberswap: 'kyberswap',
  defillama: 'defillama', jupiter: 'jupiterQuote' };
/** The venue name a spot price API answers under in reference.json. */
const REFERENCE_VENUES = { 'binance-spot': 'binance', coinbase: 'coinbase', cex: 'coingecko' };
const PERP_VENUES = new Set(['hyperliquid', 'binance', 'aster', 'okx', 'bybit']);
const HEALTH_COLORS = { OK: '#22c55e', DEGRADED: '#f59e0b', 'LAST CALL FAILED': '#f59e0b', DOWN: WIRE_BAD, IDLE: '#64748b' };
/** Fewer calls than this in the window, and its rate is not a verdict. */
const MIN_JUDGED_CALLS = 5;

/*
 * The box's status. The 15-minute rate judges an API only when it made
 * enough calls in that window to mean something: an API polled every 30 min
 * makes one call, and one failed call would read DOWN for a quarter hour.
 * Otherwise it is judged on its LAST call and its long-run error rate.
 */
const boxStatus = (h) => {
  const r = h.recent;
  if (r && r.calls >= MIN_JUDGED_CALLS) return { status: h.status, windowed: true };
  const lastFailed = (h.lastErrorAt || 0) > (h.lastOkAt || 0);
  if (lastFailed) return { status: h.errorRatePct >= 50 ? 'DOWN' : 'LAST CALL FAILED', windowed: false };
  if (!h.lastOkAt) return { status: 'IDLE', windowed: false };
  return { status: h.errorRatePct >= 50 ? 'DEGRADED' : 'OK', windowed: false };
};

const ago = (t) => {
  if (!Number.isFinite(t)) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return Math.round(s / 3600) + 'h ago';
};

function ProviderHealth({ source, v }) {
  const raw = (v && v.pipe && v.pipe.raw) || null;
  const host = PROVIDER_HOSTS[source];
  const h = raw && host ? (raw.health || []).find((p) => p.provider === host) : null;
  // A perp venue also reports its own reachability in perps.json.
  const venue = raw && raw.perps && PERP_VENUES.has(source) ? raw.perps.venues[source] : null;
  const judged = h ? boxStatus(h) : null;
  const status = judged ? judged.status : venue ? (venue.ok ? 'OK' : 'DOWN') : null;
  const sc = HEALTH_COLORS[status] || C.faint;
  // The window's numbers when it has enough calls; the long run otherwise.
  const r = judged && judged.windowed ? h.recent : null;
  const rate = r ? (r.errorRatePct || 0) : h ? h.errorRatePct : 0;
  const lastAt = h ? Math.max(h.lastOkAt || 0, h.lastErrorAt || 0) : 0;
  const spark = (h && h.spark) || [];
  const peak = Math.max(1, ...spark.map((b) => b.calls));
  return (
    <div title={h && h.lastError ? 'last error: ' + h.lastError + ' · ' + ago(h.lastErrorAt) : undefined}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: sc, boxShadow: `0 0 6px ${sc}`, flexShrink: 0 }} />
        <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, color: sc }}>{status || 'NO HEALTH DATA'}</span>
        <span style={{ fontSize: 7.5, color: C.faint, marginLeft: 'auto', whiteSpace: 'nowrap' }}>
          {h ? (status === 'OK' || !h.lastOkAt ? 'last ok ' + ago(h.lastOkAt) : 'last ok ' + ago(h.lastOkAt) + ' · failed ' + ago(h.lastErrorAt)) : venue ? (venue.ok ? venue.markets + ' markets' : venue.error || 'unreachable') : host || ''}
        </span>
      </div>
      {h && (
        <div style={{ display: 'flex', gap: 8, fontSize: 7.5, color: C.dim, whiteSpace: 'nowrap', overflow: 'hidden' }}>
          <span><b style={{ color: C.white }}>{r ? r.callsPerMinute : h.callsPerMinute}</b>/min</span>
          <span><b style={{ color: rate > 0 ? sc : C.white }}>{rate}%</b> errors</span>
          {h.p50Ms !== null && <span>p50 <b style={{ color: C.white }}>{h.p50Ms}</b>ms</span>}
          <span style={{ color: C.faint }}>{r ? r.minutes + ' min' : 'all calls · last ' + (lastAt ? ago(lastAt) : 'never')}</span>
        </div>
      )}
      {spark.length > 0 && (
        // Calls per minute over the last hour; the red part of a bar is errors.
        <div title="calls per minute, last 60 min · red = errors" style={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 14, marginTop: 3 }}>
          {spark.map((b, i) => (
            <div key={i} style={{ flex: 1, height: Math.max(1, (b.calls / peak) * 14), display: 'flex', flexDirection: 'column-reverse',
              background: b.calls ? '#3b5b9a' : '#1a2747' }}>
              {b.errors > 0 && <div style={{ height: (b.errors / Math.max(1, b.calls)) * 100 + '%', background: WIRE_BAD }} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** This API's part of the selected token's record, as key: value lines. */
const providerSample = (source, raw) => {
  if (!raw) return null;
  if (PERP_VENUES.has(source) && raw.perps) {
    const venue = raw.perps.venues[source] || {};
    return { file: 'perps.json', at: raw.perps.writtenAt,
      rec: { ...venue, [raw.perps.symbol + ' listed']: raw.perps.listedOn.indexOf(source) !== -1 } };
  }
  if (source === 'ethos') return raw.ethos ? { file: 'ethos.json', rec: raw.ethos } : null;
  if (REFERENCE_VENUES[source]) {
    const q = raw.reference && (raw.reference.quotes || []).find((x) => x.venue === REFERENCE_VENUES[source]);
    return q ? { file: 'reference.json', rec: { symbol: raw.reference.symbol, ...q } } : null;
  }
  const src = raw.market && raw.market.sources ? raw.market.sources[source] : null;
  if (src) return { file: 'market.json', at: raw.marketFile && Date.parse(raw.marketFile.fetchedAtIso), rec: src };
  const key = INTEL_KEYS[source];
  if (key && raw.intel) {
    const status = (raw.intel.sources || {})[key];
    const rec = raw.intel[key];
    return { file: 'intel.json', rec: rec && typeof rec === 'object' ? { status, ...rec } : { status } };
  }
  return null;
};
const flatten = (o, pre, out) => {
  Object.keys(o || {}).forEach((k) => {
    const x = o[k];
    const key = pre ? pre + '.' + k : k;
    if (x && typeof x === 'object' && !Array.isArray(x)) flatten(x, key, out);
    else out.push([key, Array.isArray(x) ? '[' + x.length + ']' : x]);
  });
  return out;
};
const sampleValue = (x) => {
  if (x === null || x === undefined) return '-';
  if (typeof x === 'number') {
    if (Math.abs(x) >= 1e6) return (x / 1e6).toFixed(2) + 'M';
    if (Math.abs(x) >= 1e4) return Math.round(x).toLocaleString();
    return String(+x.toPrecision(5));
  }
  return String(x);
};
const SAMPLE_LINES = 7;

function ProviderSample({ source, v, col }) {
  const raw = (v && v.pipe && v.pipe.raw) || null;
  const s = providerSample(source, raw);
  const lines = s ? flatten(s.rec, '', []) : [];
  return (
    <div style={{ flex: 1, minHeight: 0, border: `1px solid ${col}44`, borderRadius: 6, background: '#060d22', padding: '5px 7px', overflow: 'hidden' }}>
      <div style={{ ...capStyle, display: 'flex', gap: 6 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {s ? 'SAMPLE · ' + s.file.toUpperCase() + ' · THIS TOKEN' : 'SAMPLE'}
        </span>
        {/* How old the file is: a failed run keeps the last good one. */}
        {s && Number.isFinite(s.at) && <span style={{ color: Date.now() - s.at > 35 * 60000 ? '#f59e0b' : C.faint }}>written {ago(s.at)}</span>}
      </div>
      {!s && <div style={{ fontSize: 8, color: C.faint }}>nothing from this API for the selected token</div>}
      {lines.slice(0, SAMPLE_LINES).map(([k, x]) => (
        <div key={k} style={{ display: 'flex', gap: 6, fontSize: 8, lineHeight: '12px', fontFamily: 'ui-monospace, Menlo, Consolas, monospace' }}>
          <span style={{ color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{k}</span>
          <span style={{ color: C.white, whiteSpace: 'nowrap' }}>{sampleValue(x)}</span>
        </div>
      ))}
      {lines.length > SAMPLE_LINES && <div style={{ fontSize: 7.5, color: C.faint, marginTop: 2 }}>+ {lines.length - SAMPLE_LINES} other fields</div>}
    </div>
  );
}

function EngineBox({ n, pos, col, dim, isSel, isNear, inGroup, onMouseDown, onClick, onDoubleClick,
  onHover, onStartWire, v, nodeById, alert, onContextMenu }) {
  const rows = Math.max(n.inPorts.length, n.outPorts.length, 1);
  const valueOf = (p) => {
    if (p.cut) return null; // its wire is cut: nothing arrives
    // Re-fed: what arrives, converted to the type this dot expects.
    if (p.via && Object.prototype.hasOwnProperty.call(WIRE_VALUES, p.via)) {
      return showValue(coerce(WIRE_VALUES[p.via], declaredType(p.key, (nodeById && nodeById.get(p.key)) || p)));
    }
    const src = nodeById && nodeById.get(p.via || p.key);
    if (src && src.kind === 'field') return boxValue(src, v);
    // A field folded into a closed panel: its value comes with the port.
    return p.field ? boxValue({ kind: 'field', field: p.field }, v) : null;
  };
  const portLabel = (p, side) => {
    const val = valueOf(p);
    const unit = unitOf(val, (nodeById && nodeById.get(p.key)) || p);
    return (
      <span title={p.label + (unit ? ' · ' + UNIT_NAMES[unit] : '')} style={{
        display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0, maxWidth: '100%',
        justifyContent: side === 'in' ? 'flex-start' : 'flex-end',
      }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, color: C.dim }}>
          {p.label}
        </span>
        {val !== null && <span style={{ color: C.white, fontWeight: 700, flexShrink: 0 }}>{val}</span>}
      </span>
    );
  };
  return (
    <div
      data-node-id={n.id}
      data-drop={n.id}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        position: 'absolute', left: pos.x, top: pos.y, width: n.w, height: n.h, boxSizing: 'border-box',
        borderRadius: 8, background: '#0a1430', cursor: 'grab', opacity: dim ? 0.3 : 1,
        border: `${isSel ? 2 : 1.5}px ${inGroup ? 'dashed' : 'solid'} ${inGroup ? '#ffffff' : alert ? WIRE_BAD : col}`,
        boxShadow: isSel ? `0 0 0 1px ${col}, 0 0 20px ${col}99` : (isNear ? `0 0 0 1px ${col}` : '0 6px 18px rgba(0,0,0,.55)'),
      }}
    >
      <div style={{
        height: ENGINE.HEAD, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
        background: col + '26', borderBottom: `1px solid ${col}55`, borderRadius: '6px 6px 0 0',
      }}>
        <KindIcon node={n} color={col} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 9.5, fontWeight: 800, letterSpacing: 0.6, color: '#e7edff',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.label}</span>
        {alert && (
          <span title={alert.join('\n')} style={{ fontSize: 7.5, fontWeight: 800, letterSpacing: 0.6, color: WIRE_BAD,
            padding: '1px 5px', borderRadius: 6, border: `1px solid ${WIRE_BAD}88`, cursor: 'help' }}>MISSING DATA</span>
        )}
      </div>
      {Array.from({ length: rows }).map((_, i) => {
        const pin = n.inPorts[i];
        const pout = n.outPorts[i];
        return (
          <div key={i} style={{
            position: 'absolute', left: 0, right: 0, top: rowsTop(n) + i * ENGINE.ROW, height: ENGINE.ROW,
            display: 'flex', alignItems: 'center', fontSize: 8, fontFamily: MONO_STACK,
          }}>
            <div data-inport={pin ? pin.key : undefined} style={{ position: 'relative', flex: 1, minWidth: 0, paddingLeft: 9, paddingRight: 3 }}>
              {pin && (() => {
                const t = pin.cut ? { expected: declaredType(pin.key, (nodeById && nodeById.get(pin.key)) || pin), receiving: null, val: null }
                  : portType(pin.key, valueOf(pin), (nodeById && nodeById.get(pin.key)) || pin, carriesValue(pin, nodeById), pin.via);
                return (
                  <>
                    <InDot label={pin.label} t={t} />
                    {portLabel(pin, 'in')}
                  </>
                );
              })()}
            </div>
            <div style={{ position: 'relative', flex: 1, minWidth: 0, paddingRight: 9, paddingLeft: 3, textAlign: 'right' }}>
              {pout && (() => {
                const t = portType(pout.key, valueOf(pout), (nodeById && nodeById.get(pout.key)) || pout, carriesValue(pout, nodeById));
                return (
                  <>
                    {portLabel(pout, 'out')}
                    <Outlet col={dotColor(t)} missing={!t.receiving}
                      title={typeTitle(pout.label, t, 'out')} onMouseDown={onStartWire(pout.key)} style={{ right: -5 }} />
                  </>
                );
              })()}
            </div>
          </div>
        );
      })}
      {n.kind === 'provider' && (
        <div onMouseDown={(e) => e.stopPropagation()} style={{
          position: 'absolute', left: 8, right: 8, top: rowsTop(n) + rows * ENGINE.ROW + 4, bottom: 8,
          display: 'flex', flexDirection: 'column', gap: 6, cursor: 'default',
        }}>
          <ProviderHealth source={n.source} v={v} />
          <ProviderSample source={n.source} v={v} col={col} />
        </div>
      )}
      {n.kind === 'engine' && !n.inPorts.length && !n.outPorts.length && (
        <div style={{ position: 'absolute', left: 9, top: ENGINE.HEAD + 2, fontSize: 8, color: C.grey }}>
          {n.count ? 'no wires cross its edge' : 'empty — drop boxes here'}
        </div>
      )}
    </div>
  );
}

export default function FlowChart({ v }) {
  WIRE_VALUES = { ...boardValues(), ...((v && v.pipe && v.pipe.s && v.pipe.s.flowValues) || {}) };
  const wrapRef = React.useRef(null);
  const liveV = React.useRef(v);
  liveV.current = v;

  const [expanded, setExpanded] = React.useState(() => new Set());
  const [hover, setHover] = React.useState(null);
  // The arrow under the pointer, and where on SCREEN the pointer is - the
  // tooltip sits outside the zoom transform so it reads at any zoom.
  const [hoverEdge, setHoverEdge] = React.useState(null);
  const [query, setQuery] = React.useState('');
  // Where the user has dragged each box, relative to where the layout put
  // it. Kept apart from the layout so a rebuild never undoes a drag, and so
  // RESET is one line rather than a re-layout.
  const [moved, setMoved] = React.useState(() => new Map(Object.entries(activeFlow().positions || {})));

  const [view, setView] = React.useState({ k: 0.6, x: 40, y: 20 });
  const [full, setFull] = React.useState(null);

  // The graph is STRUCTURE, not values: which panels exist and what feeds
  // what. That changes when a generated group gains a card, not on every
  // poll - so it is rebuilt on a slow timer rather than on every render, and
  // the drawer reads live values straight off the viewmodel instead.
  const rebuild = React.useCallback(() => setFull(buildGraph(liveV.current)), []);
  React.useEffect(() => {
    rebuild();
    const t = setInterval(rebuild, 10000);
    return () => clearInterval(t);
  }, [rebuild]);

  /* ---- engines: the map as nested subpatchers ------------------------- */

  // The user's layer - their engines, moves, renames and sketch wires - in
  // the ACTIVE FLOW (flow-store.js): saved in a user's file, a preview on
  // DEFAULT. Saved outside the state updater, so the store's listeners never
  // run in the middle of a render.
  const [cfg, setCfgState] = React.useState(loadConfig);
  const cfgRef = React.useRef(cfg);
  const setCfg = React.useCallback((update) => {
    const next = typeof update === 'function' ? update(cfgRef.current) : update;
    cfgRef.current = next;
    setCfgState(next);
    saveConfig(next);
  }, []);

  // Switching flow (the user picker in the header) swaps the whole layer:
  // groups, moves and positions, and starts again from the MAP.
  const [flowId, setFlowId] = React.useState(activeFlowId);
  // Ctrl+Z / Ctrl+Y put back an earlier version of the flow: reload it.
  const historySeen = React.useRef(flowHistoryVersion());
  React.useEffect(() => subscribeFlows(() => {
    if (flowHistoryVersion() !== historySeen.current) {
      historySeen.current = flowHistoryVersion();
      const fresh = loadConfig();
      cfgRef.current = fresh;
      setCfgState(fresh);
      setMoved(new Map(Object.entries(activeFlow().positions || {})));
    }
  }), []);
  React.useEffect(() => {
    const onKey = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const k = String(e.key).toLowerCase();
      if (k === 'z' && !e.shiftKey) { if (undoFlow()) e.preventDefault(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { if (redoFlow()) e.preventDefault(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  React.useEffect(() => subscribeFlows(() => {
    const id = activeFlowId();
    setFlowId((cur) => {
      if (cur === id) return cur;
      const fresh = loadConfig();
      cfgRef.current = fresh;
      setCfgState(fresh);
      setMoved(new Map(Object.entries(activeFlow().positions || {})));
      setPath([ROOT]);
      return id;
    });
  }), []);
  // Boxes dragged by hand are kept in the flow too, once the drag settles.
  const movedLoaded = React.useRef(false);
  React.useEffect(() => {
    if (!movedLoaded.current) { movedLoaded.current = true; return undefined; }
    const t = setTimeout(() => updateFlow({ positions: Object.fromEntries(moved) }), 400);
    return () => clearTimeout(t);
  }, [moved]);
  // Where we are: ROOT, then each engine dived into.
  const [path, setPath] = React.useState([ROOT]);
  // Shift-clicked boxes, waiting to be grouped into an engine.
  const [groupSet, setGroupSet] = React.useState(() => new Set());
  const [groupName, setGroupName] = React.useState('');
  const [rename, setRename] = React.useState('');
  // A sketch wire being drawn, and the sketch wire clicked for deletion.
  const [wireDrag, setWireDrag] = React.useState(null);
  const [pickedWire, setPickedWire] = React.useState(null);

  // The folded graph (panels collapsed) plus the user's sketch wires.
  /*
   * An ADDED box: a standard box the user placed. Its inputs are the wires
   * dragged into it; the live ones (math, logic, average, curve, parameter)
   * compute from the values on those wires, in the order they were wired.
   */
  const userWires = React.useRef({ into: new Map(), nodes: new Map() });
  const inputsOf = (id, v) => (userWires.current.into.get(id) || []).map((src) => {
    const n = userWires.current.nodes.get(src);
    if (!n) return { label: src, val: null };
    let val = null;
    try { val = n.field && n.field.value ? n.field.value(v) : null; } catch (e) { val = null; }
    return { label: n.label, val };
  });
  const makeAdded = (a) => {
    const base = { id: a.id, page: 'user', label: a.label, group: 'user', status: 'live', stage: 3, flat: true, added: true };
    const nums = (v) => inputsOf(a.id, v).map((x) => parseNum(x.val));
    const draft = 'A draft: it can be placed and wired; it computes once the graph runs the score.';
    if (a.type === 'fetcher') return { ...base, kind: 'provider', source: null };
    if (a.type === 'storage') return { ...base, kind: 'store', backend: 'not set', detail: draft };
    if (a.type === 'panel') return { ...base, kind: 'panel', fields: [], count: 0 };
    const field = { label: a.label, status: 'live', note: a.live === false ? draft : null };
    if (a.type === 'input' || a.type === 'output') {
      const side = a.type === 'input' ? 'in' : 'out';
      field.portSpec = { side };
      // What passes through it: whatever is wired in.
      field.value = (v) => { const ins = inputsOf(a.id, v); return ins.length ? ins[0].val : null; };
      return { ...base, kind: 'field', field, uport: side };
    }
    if (a.type === 'op') {
      const sym = OP_SYM[a.op];
      const calc = (v) => {
        const xs = nums(v);
        if (!xs.length || xs.some((x) => x === null)) return null;
        if (a.op === 'sum') return xs.reduce((s, x) => s + x, 0);
        if (a.op === 'sub') return xs.slice(1).reduce((s, x) => s - x, xs[0]);
        if (a.op === 'mul') return xs.reduce((s, x) => s * x, 1);
        if (a.op === 'div') return xs.slice(1).reduce((s, x) => (x ? s / x : null), xs[0]);
        if (a.op === 'min') return Math.min(...xs);
        return Math.max(...xs);
      };
      field.opSpec = { sym, label: a.label,
        expr: (v) => { const ins = inputsOf(a.id, v); return ins.length ? ins.map((x) => x.val === null ? '—' : x.val).join(' ' + sym + ' ') : 'wire inputs into it'; } };
      field.value = (v) => fmtNum(calc(v));
    } else if (a.type === 'compare') {
      const test = (v) => { const xs = nums(v); return xs.length >= 2 && xs[0] !== null && xs[1] !== null ? xs[0] >= xs[1] : null; };
      field.opSpec = { sym: '≥', cond: { kind: 'IF', when: 'first input ≥ second input', test, then: () => 'pass', else: () => 'fail' } };
      field.value = (v) => { const t = test(v); return t === null ? null : t ? 'pass' : 'fail'; };
    } else if (a.type === 'if') {
      const test = (v) => { const ins = inputsOf(a.id, v); return ins.length ? truthy(ins[0].val) : null; };
      const pick = (i) => (v) => { const ins = inputsOf(a.id, v); return ins[i] ? ins[i].val : null; };
      field.opSpec = { sym: 'IF', cond: { kind: 'IF', when: 'the first input is a yes', test, then: pick(1), else: pick(2) } };
      field.value = (v) => { const t = test(v); return t === null ? null : t ? pick(1)(v) : pick(2)(v); };
    } else if (a.type === 'or') {
      const terms = (v) => inputsOf(a.id, v).map((x) => ({ label: x.label, ok: truthy(x.val) }));
      field.opSpec = { sym: 'OR', cond: { kind: 'OR', when: 'any input is a yes', words: ['yes', 'no'], terms } };
      field.value = (v) => { const t = terms(v); return t.length ? (t.some((x) => x.ok) ? 'true' : 'false') : null; };
    } else if (a.type === 'mean') {
      const xs = (v) => nums(v).filter((x) => x !== null);
      field.agg = { fn: 'MEAN', fmt: fmtNum, what: 'every wired input',
        points: (v) => xs(v).map((x) => ({ x })), result: (v) => { const l = xs(v); return l.length ? l.reduce((s, x) => s + x, 0) / l.length : null; } };
      field.value = (v) => fmtNum(field.agg.result(v));
    } else if (a.type === 'curve') {
      field.curve = { f: (x) => Math.round(Math.max(0, Math.min(100, x))), x: (v) => nums(v)[0], lo: 0, hi: 100, log: false, xFmt: (x) => fmtNum(x) };
      field.calc = [];
      field.value = (v) => { const x = nums(v)[0]; return x === null || x === undefined ? null : Math.round(Math.max(0, Math.min(100, x))); };
    } else if (a.type === 'param') {
      const pid = 'param:user:' + a.id;
      field.param = { id: pid, def: 0, step: 1 };
      field.value = () => getSetting(pid, { n: 0 }).n;
    } else if (a.type === 'item') {
      field.display = 'number';
      field.value = (v) => { const ins = inputsOf(a.id, v); return ins.length ? ins[0].val : null; };
    } else if (a.type === 'service') {
      field.service = { every: 'not set', keeps: 'nothing yet' };
      field.value = () => null;
    } else if (a.type === 'extract') {
      field.extract = { path: 'no file chosen yet', picks: [] };
      field.value = () => null;
    } else if (a.type === 'list') {
      field.listSpec = { rows: () => [], fields: [], of: 'rows' };
      field.value = () => null;
    } else if (a.type === 'filter') {
      field.opSpec = { sym: 'FILTER', filter: { rows: () => [], rules: [], of: 'rows' } };
      field.value = () => null;
    } else if (a.type === 'selector') {
      field.selector = { of: 'inputs', options: (v) => inputsOf(a.id, v).map((x, i) => ({ id: String(i), label: x.label, sub: '', value: x.val })),
        selected: () => null, pick: () => {} };
      field.value = () => null;
    } else if (a.type === 'join') {
      field.join = { by: 'key', key: () => null, against: () => null, matches: () => [] };
      field.value = () => null;
    }
    return { ...base, kind: 'field', field };
  };

  /**
   * The graph AFTER the user's edits - boxes deleted, wires cut, boxes
   * copied - and what those edits BREAK: every box downstream of a deleted
   * box or a cut wire has lost data it needs, and is marked so (red), with
   * the reason, so a removal can be troubleshot by looking.
   */
  const edited = React.useMemo(() => {
    if (!full) return null;
    const g = collapse(full, expanded);
    let nodes = g.nodes;
    let edges = g.edges;
    // A copy is the same box under a new id, fed by the same inputs.
    const copies = cfg.copies || [];
    if (copies.length) {
      nodes = nodes.slice();
      edges = edges.slice();
      copies.forEach((c) => {
        const src = g.nodes.find((n) => n.id === c.of);
        if (!src) return;
        nodes.push({ ...src, id: c.id, label: src.label + ' (copy)', copyOf: c.of });
        g.edges.forEach((e) => {
          if (e.to !== c.of) return;
          edges.push({ ...e, id: e.id + '@' + c.id, to: c.id,
            parts: (e.parts || [{ from: e.from, to: e.to }]).map((p) => ({ ...p, to: p.to === c.of ? c.id : p.to })) });
        });
      });
    }
    // Boxes the user ADDED from the right-click menu.
    if ((cfg.added || []).length) {
      nodes = nodes.concat((cfg.added || []).map(makeAdded));
    }
    const deleted = cfg.deleted || {};
    // Wires the user drew into an input dot: reconnect a cut, or feed the
    // dot from another box (flow/wires.js - the app and the engine use it too).
    const H0 = hierarchy(cfg, nodes);
    const inside = (id, target) => id === target || H0.ancestors(id).indexOf(target) !== -1;
    const uw = applyUserWires({ edges, sketch: cfg.sketch, cut: new Set(cfg.cutWires || []), inside });
    REROUTE = uw.reroute;
    const cut = uw.cut;
    const replaced = uw.replaced;
    if (uw.extra.length) edges = edges.concat(uw.extra);
    const labelOf = new Map(nodes.map((n) => [n.id, n.label]));
    const name = (id) => labelOf.get(id) || id;
    const out = new Map();
    edges.forEach((e) => {
      if (e.soft) return;
      // A wire a drawn wire took over carries nothing now.
      if ((e.parts || [{ from: e.from, to: e.to }]).every((p) => replaced.has(p.from + '>' + p.to))) return;
      if (!out.has(e.from)) out.set(e.from, []);
      out.get(e.from).push(e);
    });
    const missing = new Map();
    const queue = [];
    const mark = (id, why) => {
      if (deleted[id]) return;
      if (!missing.has(id)) { missing.set(id, new Set()); queue.push(id); }
      missing.get(id).add(why);
    };
    Object.keys(deleted).forEach((id) => (out.get(id) || []).forEach((e) => mark(e.to, name(id) + ' was deleted')));
    edges.forEach((e) => (e.parts || [{ from: e.from, to: e.to }]).forEach((p) => {
      if (cut.has(p.from + '>' + p.to)) mark(e.to, 'the wire from ' + name(p.from) + ' was cut');
    }));
    while (queue.length) {
      const id = queue.shift();
      (out.get(id) || []).forEach((e) => mark(e.to, name(id) + ' has missing data'));
    }
    const keptEdges = [];
    // A CUT wire is kept, flagged: the dots it ran between belong to the
    // boxes and groups (what they take and give), not to the wire, so they
    // stay - unconnected - and the wire itself is not drawn.
    // Kept in its place in the list, so its dots keep their place too.
    edges.forEach((e) => {
      if (deleted[e.from] || deleted[e.to]) return;
      const parts = e.parts || [{ from: e.from, to: e.to }];
      const off = (p) => cut.has(p.from + '>' + p.to) || replaced.has(p.from + '>' + p.to);
      const keep = parts.filter((p) => !off(p));
      const gone = parts.filter(off);
      if (keep.length) keptEdges.push(keep.length === parts.length ? e : { ...e, parts: keep });
      if (gone.length) keptEdges.push({ ...e, id: e.id + '#cut', parts: gone, cut: true });
    });
    const baseOut = { nodes: nodes.filter((n) => !deleted[n.id]), edges: keptEdges.concat(sketchEdges(cfg)) };
    // What is wired INTO each added box, for its live value.
    const into = new Map();
    baseOut.edges.forEach((x) => { if (x.cut) return; if (!into.has(x.to)) into.set(x.to, []); into.get(x.to).push(x.from); });
    userWires.current = { into, nodes: new Map(baseOut.nodes.map((n) => [n.id, n])) };
    return { base: baseOut, missing };
  }, [full, expanded, cfg]);
  const base = edited ? edited.base : null;
  const missingOf = (id) => (edited && edited.missing.has(id) ? Array.from(edited.missing.get(id)) : null);
  const H = React.useMemo(() => (base ? hierarchy(cfg, base.nodes) : null), [base, cfg]);
  const brokenGroups = React.useMemo(() => {
    const m = new Map();
    if (!edited || !H) return m;
    edited.missing.forEach((why, id) => {
      if (!H.nodeById.has(id)) return;
      H.ancestors(id).forEach((g) => {
        if (!m.has(g)) m.set(g, []);
        if (m.get(g).length < 6) m.get(g).push((H.nodeById.get(id) || {}).label + ': ' + Array.from(why)[0]);
      });
    });
    return m;
  }, [edited, H]);
  // A user flow's file holds the WHOLE arrangement, not only what the user
  // changed: every box with its type and group, the groups, the wires. It is
  // written once, when the flow is first opened - from then on the flow no
  // longer follows the default's rules, it is its own.
  React.useEffect(() => {
    if (!base || !H || flowId === DEFAULT_FLOW) return;
    if (activeFlow().arrangement) return;
    const assign = {};
    base.nodes.forEach((n) => { assign[n.id] = H.parentOf(n.id); });
    H.engines.forEach((e, id) => { assign[id] = H.parentOf(id); });
    const arrangement = {
      savedAt: Date.now(),
      groups: Array.from(H.engines.values()).map((e) => ({ id: e.id, label: e.label, parent: H.parentOf(e.id) })),
      boxes: base.nodes.map((n) => ({ id: n.id, label: n.label, type: typeOf(n), group: H.parentOf(n.id) })),
      wires: base.edges.filter((e) => e.kind !== 'sketch' && !e.cut).map((e) => ({ from: e.from, to: e.to, kind: e.kind })),
    };
    const nextCfg = { ...cfgRef.current, assign: { ...assign, ...cfgRef.current.assign } };
    cfgRef.current = nextCfg;
    setCfgState(nextCfg);
    updateFlow({ arrangement, cfg: nextCfg });
  }, [base, H, flowId]);

  // A level that stopped existing (its engine was ungrouped) falls back up.
  const level = (() => {
    const l = path[path.length - 1];
    return l === ROOT || (H && H.engines.has(l)) ? l : ROOT;
  })();

  // A calculation box is as tall as its working, which only the browser
  // knows: each box reports its height and the layout makes room for it.
  const [measured, setMeasured] = React.useState(() => new Map());
  // A box setting changed (a filter's mode or count): redraw with the new values.
  const [, setSettingsTick] = React.useState(0);
  React.useEffect(() => subscribeSettings(() => setSettingsTick((t) => t + 1)), []);
  const onMeasure = React.useCallback((id, h) => {
    setMeasured((cur) => (Math.abs((cur.get(id) || 0) - h) < 2 ? cur : new Map(cur).set(id, h)));
  }, []);
  const laid = React.useMemo(() => {
    if (!base || !H) return null;
    const sized = (g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.uport ? { ...n, w: CONNECTOR_W, h: CONNECTOR_H }
        : n.ported && n.kind === 'field' ? { ...n, w: CALC_W, h: measured.get(n.id) || n.h + 110 } : n)),
    });
    const lay = (g) => layout(sized(g));
    // Port rows in the order each engine's own inside lists them.
    return orderPortsLikeInside(lay(viewGraph(base, H, level)), base, H, lay);
  }, [base, H, level, measured]);

  const byId = React.useMemo(
    () => new Map((laid ? laid.nodes : []).map((n) => [n.id, n])),
    [laid],
  );
  // Every node BEFORE collapsing, so an arrow's parts can name the fields
  // folded inside a closed panel.
  const fullById = React.useMemo(
    () => new Map((full ? full.nodes : []).map((n) => [n.id, n])),
    [full],
  );

  /* ---- what is lit up ------------------------------------------------- */

  // Only the pointer dims the rest. Dimming around an OPEN box would mean
  // two open boxes each dim the other's neighbours and the map goes dark.
  const focus = hover;
  const related = React.useMemo(() => {
    if (!focus || !laid) return null;
    const near = new Set([focus]);
    laid.edges.forEach((e) => {
      if (e.from === focus) near.add(e.to);
      if (e.to === focus) near.add(e.from);
    });
    return near;
  }, [focus, laid]);

  /**
   * The SELECTED box: set by clicking a box, collapsed or open, and kept until
   * the empty map is clicked. Its own outline glows, its neighbours' outlines
   * light, and every line in or out of it carries a moving data stream - the
   * box's whole wiring readable at once, without hovering anything.
   *
   * Brightens only; nothing is dimmed. Fading the rest of the map was tried
   * for hover and rejected - it answered "what is this wired to" by hiding the
   * diagram instead of pointing at part of it.
   */
  const [selected, setSelected] = React.useState(null);
  const selNear = React.useMemo(() => {
    if (!selected || !laid) return null;
    const near = new Set();
    laid.edges.forEach((e) => {
      if (e.from === selected) near.add(e.to);
      if (e.to === selected) near.add(e.from);
    });
    return near;
  }, [selected, laid]);
  // A drag that panned the map must not also count as a click on it.
  const pannedFar = React.useRef(false);

  const q = query.trim().toLowerCase();
  const matches = React.useMemo(() => {
    if (!q || !laid) return null;
    return new Set(laid.nodes.filter((n) => String(n.label).toLowerCase().indexOf(q) !== -1
      || (n.page && PAGE_TITLES[n.page].toLowerCase().indexOf(q) !== -1)).map((n) => n.id));
  }, [q, laid]);

  /* ---- opening --------------------------------------------------------- */


  /**
   * Where a box sits: the layout, plus wherever the user dragged it.
   *
   * EVERYTHING reads position through here - the shapes, the labels, the
   * arrows and the open cards - which is the whole reason a dragged box
   * keeps its connections. The arrows are not attached to the boxes; they
   * are drawn from the same function the boxes are.
   */
  const posOf = React.useCallback((n) => {
    const m = moved.get(n.id);
    return { x: n.x + (m ? m.dx : 0), y: n.y + (m ? m.dy : 0) };
  }, [moved]);

  /* ---- pan and zoom ---------------------------------------------------- */

  /**
   * Wheel zoom, attached by a CALLBACK REF rather than a mount effect.
   *
   * The canvas does not exist on the first render - the component returns a
   * "building the map" line until the first layout lands - so a mount effect
   * ran against a null ref, bailed, and never ran again because its deps
   * never changed. The listener was simply never attached and the wheel did
   * nothing. A callback ref fires when the ELEMENT appears or goes away,
   * which is the question actually being asked.
   *
   * It must also be non-passive: React's own onWheel is registered passively,
   * so preventDefault() there is ignored and the page scrolls instead.
   */
  const onWheel = React.useCallback((e) => {
    const el = wrapRef.current;
    if (!el) return;
    // Inside an opened box the wheel belongs to that box's own scrollbar.
    if (e.target && e.target.closest && e.target.closest('[data-card]')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    // Scaled by the delta rather than a fixed step per event: a trackpad
    // sends many small deltas and a wheel one large one, and a fixed step
    // makes one of the two unusable. deltaMode 1 is lines, not pixels.
    const step = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.06 : 0.0024));
    setView((cur) => {
      const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur.k * step));
      // Keep the point under the cursor fixed, which is the only zoom that
      // feels like a map rather than a slideshow.
      return { k, x: px - ((px - cur.x) / cur.k) * k, y: py - ((py - cur.y) / cur.k) * k };
    });
  }, []);

  const attachCanvas = React.useCallback((el) => {
    const prev = wrapRef.current;
    if (prev) prev.removeEventListener('wheel', onWheel);
    wrapRef.current = el;
    if (el) el.addEventListener('wheel', onWheel, { passive: false });
  }, [onWheel]);

  const drag = React.useRef(null);
  const nodeDrag = React.useRef(null);
  // A drag that moved should not also count as a click, or letting go of a
  // box would open it every time.
  const draggedFar = React.useRef(false);

  const startNodeDrag = (id) => (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    // preventDefault too: a box drag must never start a text selection.
    e.preventDefault();
    clearSelection();
    const base = moved.get(id) || { dx: 0, dy: 0 };
    nodeDrag.current = { id, sx: e.clientX, sy: e.clientY, base, far: 0 };
  };

  // A selection left over from a card would otherwise stretch across the map
  // as the pointer drags, so a pan or a box drag starts by dropping it.
  const clearSelection = () => {
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount) sel.removeAllRanges();
  };

  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    clearSelection();
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  };

  /** A screen point, in map coordinates. */
  const toMap = (cx, cy) => {
    const el = wrapRef.current;
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
  };

  /**
   * What is under the pointer that a dragged box can be DROPPED into: an
   * engine box, or a breadcrumb level. `elementsFromPoint` sees through the
   * dragged box itself, which is on top of whatever it is being dropped onto.
   */
  const dropTargetAt = (cx, cy, dragId) => {
    const els = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [];
    for (let i = 0; i < els.length; i += 1) {
      const t = els[i].closest && els[i].closest('[data-drop]');
      if (t) {
        const id = t.getAttribute('data-drop');
        if (id && id !== dragId) return id;
      }
    }
    return null;
  };

  /** The box under the pointer, for the end of a sketch wire. */
  const nodeAt = (cx, cy) => {
    const els = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [];
    // A group's inlet row that is a user INPUT takes the wire itself.
    for (let i = 0; i < els.length; i += 1) {
      const r = els[i].closest && els[i].closest('[data-inport]');
      if (r && String(r.getAttribute('data-inport')).indexOf('add:') === 0) return r.getAttribute('data-inport');
    }
    for (let i = 0; i < els.length; i += 1) {
      const t = els[i].closest && els[i].closest('[data-node-id]');
      if (t) return t.getAttribute('data-node-id');
    }
    return null;
  };

  /**
   * The input dot under the pointer: a box's or a group's inlet row, or a
   * group's IN connector seen from inside it. Returns { owner, key }.
   */
  const inportAt = (cx, cy) => {
    const els = document.elementsFromPoint ? document.elementsFromPoint(cx, cy) : [];
    for (let i = 0; i < els.length; i += 1) {
      const r = els[i].closest && els[i].closest('[data-inport]');
      if (r) {
        const key = r.getAttribute('data-inport');
        const owner = r.closest('[data-node-id]');
        if (key && key.indexOf('add:') !== 0 && owner) return { owner: owner.getAttribute('data-node-id'), key };
      }
      const c = els[i].closest && els[i].closest('[data-node-id^="port:in:"]');
      if (c) return { owner: path[path.length - 1], key: c.getAttribute('data-node-id').slice(8) };
    }
    return null;
  };

  /** Move a box or an engine into another engine (or up to a level). */
  const moveInto = (id, target) => {
    if (!H || String(id).indexOf('port:') === 0) return;
    if (H.parentOf(id) === target || !H.canMove(id, target)) return;
    setCfg((cur) => ({ ...cur, assign: { ...cur.assign, [id]: target } }));
    // Its position belonged to the level it just left.
    setMoved((cur) => { const next = new Map(cur); next.delete(id); return next; });
  };

  /** Start drawing a sketch wire from an outlet. `from` is the data's source box. */
  const startWire = (from) => (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const p = toMap(e.clientX, e.clientY);
    setWireDrag({ from, x0: p.x, y0: p.y, x: p.x, y: p.y });
  };

  const onMouseMove = (e) => {
    if (wireDrag) {
      const p = toMap(e.clientX, e.clientY);
      setWireDrag((cur) => (cur ? { ...cur, x: p.x, y: p.y } : cur));
      return;
    }
    const nd = nodeDrag.current;
    if (nd) {
      // Screen pixels divided by the zoom, or a box would run away from the
      // pointer at anything other than 100%.
      const dx = (e.clientX - nd.sx) / view.k;
      const dy = (e.clientY - nd.sy) / view.k;
      nd.far = Math.max(nd.far, Math.abs(e.clientX - nd.sx) + Math.abs(e.clientY - nd.sy));
      setMoved((cur) => {
        const next = new Map(cur);
        next.set(nd.id, { dx: nd.base.dx + dx, dy: nd.base.dy + dy });
        return next;
      });
      return;
    }
    // Read the drag NOW, not inside the updater. React runs the updater at
    // render time; if the mouse went up in between, endDrag has nulled the
    // ref and reading it there threw mid-render and unmounted the whole page.
    const d = drag.current;
    if (!d) return;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) >= 4) pannedFar.current = true;
    const x = d.vx + (e.clientX - d.x);
    const y = d.vy + (e.clientY - d.y);
    setView((cur) => ({ ...cur, x, y }));
  };

  const endDrag = (e) => {
    const at = e && Number.isFinite(e.clientX) && e.type === 'mouseup' ? e : null;
    // A sketch wire ends on whatever box it is let go over.
    if (wireDrag) {
      const dot = at ? inportAt(at.clientX, at.clientY) : null;
      if (dot && dot.owner !== wireDrag.from) {
        // Onto an input dot: that dot is now fed by this box (flow/wires.js).
        const s = { id: Date.now().toString(36), from: wireDrag.from, to: dot.owner, toPort: dot.key };
        setCfg((cur) => ({ ...cur, sketch: (cur.sketch || []).concat([s]) }));
      } else {
        const to = at ? nodeAt(at.clientX, at.clientY) : null;
        // A boundary inlet stands for the box its data comes from.
        const resolved = to && to.indexOf('port:in:') === 0 ? to.slice(8) : to;
        if (resolved && resolved !== wireDrag.from && resolved.indexOf('port:') !== 0) {
          const s = { id: Date.now().toString(36), from: wireDrag.from, to: resolved };
          setCfg((cur) => ({ ...cur, sketch: (cur.sketch || []).concat([s]) }));
        }
      }
      setWireDrag(null);
    }
    const nd = nodeDrag.current;
    if (nd) {
      draggedFar.current = nd.far >= 4;
      // Let go over an engine or a breadcrumb: the box moves in there.
      if (nd.far >= 4 && at) {
        const target = dropTargetAt(at.clientX, at.clientY, nd.id);
        if (target) moveInto(nd.id, target);
      }
    }
    nodeDrag.current = null;
    drag.current = null;
  };


  React.useEffect(() => {
    if (!laid) return;
    const want = (cfg.added || []).filter((a) => Number.isFinite(a.x) && !moved.has(a.id));
    if (!want.length) return;
    setMoved((cur) => {
      const next = new Map(cur);
      want.forEach((a) => {
        const n = laid.nodes.find((x) => x.id === a.id);
        if (n && !next.has(a.id)) next.set(a.id, { dx: a.x - n.x, dy: a.y - n.y });
      });
      return next;
    });
  }, [laid, cfg.added]);

  const fit = React.useCallback(() => {
    const el = wrapRef.current;
    if (!el || !laid) return;
    const r = el.getBoundingClientRect();
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
      Math.min((r.width - 80) / (laid.width || 1), (r.height - 80) / (laid.height || 1))));
    setView({ k, x: 40, y: (r.height - laid.height * k) / 2 });
  }, [laid]);

  // Fit once, when the first layout lands - and only once the canvas has a
  // size. Fitting into a canvas that has not been laid out yet divided by a
  // near-zero width and opened the map at the 7% floor, a smudge in a corner.
  // Holds the LEVEL last fitted, not a flag: a level change and the layout
  // it produces land in the same render, and a flag reset by the level's own
  // effect came too late for this one - climbing back up kept the deeper zoom.
  const fitted = React.useRef(null);
  React.useEffect(() => {
    if (!laid || fitted.current === level) return undefined;
    let raf = 0;
    const tryFit = (left) => {
      const el = wrapRef.current;
      const r = el && el.getBoundingClientRect();
      if (r && r.width > 200 && r.height > 150) { fitted.current = level; fit(); return; }
      if (left > 0) raf = requestAnimationFrame(() => tryFit(left - 1));
    };
    tryFit(120);
    return () => cancelAnimationFrame(raf);
  }, [laid, fit, level]);

  /** Centre one node without changing the zoom - how search and the drawer move. */
  const centreOn = React.useCallback((id) => {
    const el = wrapRef.current;
    const n = byId.get(id);
    if (!el || !n) return;
    const r = el.getBoundingClientRect();
    setView((cur) => ({
      ...cur,
      x: r.width / 2 - (n.x + n.w / 2) * cur.k,
      y: r.height / 2 - (n.y + n.h / 2) * cur.k,
    }));
  }, [byId]);

  /**
   * Open a box: select it, bring it to the middle, and make sure the zoom is
   * high enough to read it. Opening a box at 13% would show a postage stamp
   * of text, so the view meets it halfway.
   */
  const READABLE = 0.85;
  /**
   * Open or close a box, and DO NOT touch the view.
   *
   * It used to centre and zoom on every open. If you had already zoomed in on
   * the box you were about to click, clicking it threw the whole map away
   * from under you - the one place a jump is least wanted, because you were
   * already looking at the right thing.
   */

  /**
   * Go to a box somewhere else on the map: search, and the chips inside an
   * open card. Here the jump IS the point - the target is usually off
   * screen - so this one does centre, and lifts the zoom enough to read it.
   */
  const goTo = (id) => {
    // Inside another engine: dive to the level where it is a box of its own,
    // and finish the jump once that level has been laid out.
    if (!byId.has(id) && H) {
      const chain = H.ancestors(id).slice().reverse();
      if (chain.length && chain[0] === ROOT) {
        pendingGo.current = id;
        setPath(chain);
        return;
      }
    }
    // Engines and boundary ports have no card to open.
    const n = byId.get(id);
    if (n && (n.kind === 'engine' || n.kind === 'port')) {
      setSelected(id);
      requestAnimationFrame(() => centreOn(id));
      return;
    }
    // Going to a box selects it too, so its wiring lights up on arrival.
    setSelected(id);
    setView((cur) => (cur.k >= READABLE ? cur : { ...cur, k: READABLE }));
    // After the zoom has been applied, so the centring maths uses the new k.
    requestAnimationFrame(() => centreOn(id));
  };


  // A search hit inside a closed panel: jump once opening it has put the box
  // into the graph (goTo then dives to whichever engine holds it).
  const pendingFind = React.useRef(null);
  React.useEffect(() => {
    const id = pendingFind.current;
    if (id && base && base.nodes.some((n) => n.id === id)) { pendingFind.current = null; goTo(id); }
  });

  // A jump waiting for its level to be laid out, and the level change itself:
  // a new level starts with nothing open and fits itself to the canvas -
  // unless a jump is about to centre on one box, which then wins.
  const pendingGo = React.useRef(null);
  React.useEffect(() => {
    setHoverEdge(null);
    // A jump about to centre on one box wins over fitting the new level.
    if (pendingGo.current) fitted.current = level;
  }, [level]);
  React.useEffect(() => {
    const id = pendingGo.current;
    if (id && byId.has(id)) { pendingGo.current = null; goTo(id); }
  });

  /** Dive into an engine (double-click), or climb to a level (breadcrumb). */
  const dive = (id) => { setSelected(null); setPath((cur) => cur.concat([id])); };
  const climbTo = (i) => { setSelected(null); setPath((cur) => cur.slice(0, i + 1)); };

  /** GROUP: the shift-selected boxes become one new engine at this level. */
  const groupIntoEngine = () => {
    if (!H || !groupSet.size) return;
    const id = 'eng:u:' + Date.now().toString(36);
    const label = (groupName.trim() || 'ENGINE ' + (Object.keys(cfg.engines).length + 1)).toUpperCase();
    setCfg((cur) => {
      const assign = { ...cur.assign };
      groupSet.forEach((m) => { if (String(m).indexOf('port:') !== 0) assign[m] = id; });
      return { ...cur, engines: { ...cur.engines, [id]: { label, parent: level } }, assign };
    });
    setGroupSet(new Set());
    setGroupName('');
    setSelected(id);
  };

  /** UNGROUP: an engine's contents move up to its parent and the engine goes. */
  const ungroup = (id) => {
    if (!H || !H.engines.has(id)) return;
    const parent = H.parentOf(id);
    const kids = base.nodes.map((n) => n.id).concat(Array.from(H.engines.keys()))
      .filter((x) => x !== id && H.parentOf(x) === id);
    setCfg((cur) => {
      const assign = { ...cur.assign };
      kids.forEach((k) => { assign[k] = parent; });
      delete assign[id];
      const engines = { ...cur.engines };
      const removed = { ...cur.removed };
      if (engines[id]) delete engines[id]; else removed[id] = true;
      const renamed = { ...cur.renamed };
      delete renamed[id];
      return { ...cur, assign, engines, removed, renamed };
    });
    setSelected(null);
  };

  const renameEngine = (id, name) => {
    const label = String(name || '').trim().toUpperCase();
    if (!label) return;
    setCfg((cur) => ({ ...cur, renamed: { ...cur.renamed, [id]: label } }));
    setRename('');
  };

  const deleteWire = (sid) => {
    setCfg((cur) => ({ ...cur, sketch: (cur.sketch || []).filter((s) => s.id !== sid) }));
    setPickedWire(null);
  };

  /* ---- EDITING: delete, copy, cut, paste ------------------------------
     Every edit is part of the flow's config, so on a user's flow it is
     saved and on DEFAULT it is a preview that a refresh undoes. */
  const [clip, setClip] = React.useState(null);
  const [menu, setMenu] = React.useState(null);
  const openMenu = (ev, target) => {
    ev.preventDefault();
    ev.stopPropagation();
    setMenu({ x: ev.clientX, y: ev.clientY, ...target });
  };
  React.useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', onKey); };
  }, [menu]);
  const isCopy = (id) => (cfg.copies || []).some((c) => c.id === id);
  const canEdit = (id) => Boolean(id) && String(id).indexOf('port:') !== 0;
  const deleteBox = (id) => {
    if (!H || !canEdit(id)) return;
    if (String(id).indexOf('add:') === 0) {
      // An added box goes for good, with the wires drawn to and from it.
      setCfg((cur) => ({ ...cur, added: (cur.added || []).filter((a) => a.id !== id),
        sketch: (cur.sketch || []).filter((s) => s.from !== id && s.to !== id) }));
    } else if (isCopy(id)) {
      setCfg((cur) => ({ ...cur, copies: (cur.copies || []).filter((c) => c.id !== id) }));
    } else if (H.engines.has(id)) {
      // A group goes with everything in it, groups inside it included.
      const inside = base.nodes.map((n) => n.id).concat(Array.from(H.engines.keys()))
        .filter((x) => x === id || H.ancestors(x).indexOf(id) !== -1);
      setCfg((cur) => {
        const deleted = { ...(cur.deleted || {}) };
        inside.forEach((x) => { deleted[x] = true; });
        return { ...cur, deleted };
      });
    } else {
      setCfg((cur) => ({ ...cur, deleted: { ...(cur.deleted || {}), [id]: true } }));
    }
    if (selected === id) setSelected(null);
  };
  const cutWire = (e) => {
    if (e.kind === 'sketch') { deleteWire(e.sketchId); return; }
    const keys = (e.parts || [{ from: e.from, to: e.to }]).map((p) => p.from + '>' + p.to);
    setCfg((cur) => ({ ...cur, cutWires: Array.from(new Set((cur.cutWires || []).concat(keys))) }));
  };
  const copyBox = (id) => { if (canEdit(id) && !H.engines.has(id)) setClip({ mode: 'copy', id }); };
  const cutBox = (id) => { if (canEdit(id)) setClip({ mode: 'cut', id }); };
  const paste = () => {
    if (!clip) return;
    if (clip.mode === 'cut') {
      moveInto(clip.id, level);
      setClip(null);
      return;
    }
    const of = ((cfg.copies || []).find((c) => c.id === clip.id) || {}).of || clip.id;
    const id = 'copy:' + Date.now().toString(36) + ':' + of;
    setCfg((cur) => ({ ...cur, copies: (cur.copies || []).concat([{ id, of }]), assign: { ...cur.assign, [id]: level } }));
    setSelected(id);
  };
  const restoreEdits = () => setCfg((cur) => ({ ...cur, deleted: {}, cutWires: [] }));

  /** Rename an added box: a connector's name is also its dot's name on the group. */
  const renameAdded = React.useCallback((id, label) => {
    const clean = String(label || '').trim().toUpperCase();
    if (!clean) return;
    setCfg((cur) => ({ ...cur, added: (cur.added || []).map((a) => (a.id === id ? { ...a, label: clean } : a)) }));
  }, [setCfg]);

  /** Rename a group's IN / OUT connector: a display name over its data key, kept in the flow. */
  const renamePort = (key, label) => {
    const clean = String(label || '').trim().toUpperCase();
    if (!clean) return;
    setCfg((cur) => ({ ...cur, portNames: { ...(cur.portNames || {}), [key]: clean } }));
  };

  /** ADD: a standard box (or an empty group) where the menu was opened. */
  const addBox = (item, at) => {
    if (item.inGroup && level === ROOT) return;
    const p = at ? toMap(at.x, at.y) : null;
    const stamp = Date.now().toString(36);
    if (item.type === 'group') {
      const id = 'eng:u:' + stamp;
      setCfg((cur) => ({ ...cur, engines: { ...cur.engines, [id]: { label: 'NEW GROUP', parent: level } } }));
      return;
    }
    const id = 'add:' + stamp;
    setCfg((cur) => ({
      ...cur,
      added: (cur.added || []).concat([{ id, type: item.type, op: item.op || null, label: item.label.toUpperCase(),
        live: Boolean(item.live), x: p ? p.x : null, y: p ? p.y : null }]),
      assign: { ...cur.assign, [id]: level },
    }));
    setSelected(id);
  };
  const editCount = Object.keys(cfg.deleted || {}).length + (cfg.cutWires || []).length;

  // Keys: Delete removes the selected box (or a picked sketch wire); Ctrl+C /
  // Ctrl+X / Ctrl+V copy, cut and paste it; Escape lets go.
  React.useEffect(() => {
    const onKey = (e) => {
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (pickedWire) deleteWire(pickedWire);
        else if (selected) deleteBox(selected);
      } else if (mod && (e.key === 'c' || e.key === 'C') && selected) copyBox(selected);
      else if (mod && (e.key === 'x' || e.key === 'X') && selected) cutBox(selected);
      else if (mod && (e.key === 'v' || e.key === 'V')) paste();
      else if (e.key === 'Escape') setPickedWire(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const [confirmReset, setConfirmReset] = React.useState(false);
  const cfgTouched = Object.keys(cfg.engines).length + Object.keys(cfg.assign).length +
    Object.keys(cfg.renamed).length + Object.keys(cfg.removed).length + (cfg.sketch || []).length +
    (cfg.copies || []).length > 0;

  const togglePanel = (id) => setExpanded((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });


  if (!laid) {
    return <div style={{ padding: 20, color: C.dim, fontSize: 11 }}>Building the map&hellip;</div>;
  }

  /**
   * A wire is NEUTRAL when data flows and RED when it does not - its data
   * TYPE is on the port dots at either end, never on the line. Solid red: the
   * box it leaves lost its inputs (something upstream was deleted or cut).
   * Dashed red: nothing arrives on it this poll. Hover a red wire for why.
   */
  const wireState = (e) => {
    if (e.kind === 'sketch') return { color: SKETCH_COLOR };
    const parts = e.parts || [];
    const brokenSrc = [e.src, e.from].concat(parts.map((p) => p.from)).find((id) => id && edited && edited.missing.has(id));
    if (brokenSrc) return { color: WIRE_BAD, why: 'disconnected: ' + Array.from(edited.missing.get(brokenSrc))[0] };
    const a = byId.get(e.from);
    if (!a) return { color: WIRE_OK };
    const vv = liveV.current;
    let val = null;
    let hasValue = false;
    if (e.fromPort && e.fromPort !== a.id) {
      const src = H && H.nodeById.get(e.fromPort);
      const p = (a.outPorts || []).find((x) => x.key === e.fromPort);
      const field = (src && src.kind === 'field' && src.field) || (p && p.field) || null;
      if (field && field.value) { hasValue = true; val = boxValue({ kind: 'field', field }, vv); }
    } else if ((a.kind === 'field' || a.kind === 'port') && a.field && a.field.value) {
      hasValue = true;
      val = boxValue(a, vv);
    }
    if (hasValue && val === null) return { color: WIRE_BAD, dash: '4 3', why: 'missing data: nothing arrives on this wire this poll' };
    return { color: WIRE_OK };
  };

  // One line per wire. (Wires used to split per value while a box was open;
  // no box opens now - every box shows its ports - so a wire is drawn whole.)
  // Cut wires keep their dots but are not drawn.
  const drawEdges = laid.edges.filter((e) => !e.cut);

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* ---- toolbar ---------------------------------------------------- */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap',
        borderBottom: `1px solid ${C.border}`, background: C.panel, flexShrink: 0,
      }}>
        {/* Where we are. Each crumb climbs back up, and is also a DROP target:
            let a dragged box go over one and it moves up to that level. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {path.map((id, i) => {
              const here = i === path.length - 1;
              const label = id === ROOT ? 'MAP' : (H && H.engines.has(id) ? H.engines.get(id).label : '?');
              return (
                <React.Fragment key={id + i}>
                  {i > 0 && <span style={{ color: C.grey, fontSize: 10 }}>&rsaquo;</span>}
                  <span data-drop={id}
                    onClick={() => !here && climbTo(i)}
                    title={here ? 'you are here' : 'go up to ' + label + ' (or drop a box here to move it up)'}
                    style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: 0.6, padding: '3px 8px', borderRadius: 999,
                      cursor: here ? 'default' : 'pointer',
                      border: `1px solid ${here ? C.pink : C.border}`,
                      color: here ? C.pink : C.dim, background: here ? 'rgba(227,95,242,0.08)' : 'transparent',
                    }}>{label}</span>
                </React.Fragment>
              );
            })}
          </div>
        {/* Navigation on the left, search pushed to the right. */}
        <div style={{ flex: 1 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (matches && matches.size) goTo(Array.from(matches)[0]);
              else if (q && base && H) {
                // Not at this level: find it inside an engine and dive there.
                const hit = base.nodes.find((n) => String(n.label).toLowerCase().indexOf(q) !== -1);
                const eng = !hit && Array.from(H.engines.values()).find((x) => x.label.toLowerCase().indexOf(q) !== -1);
                // Or inside a CLOSED panel (a score component sits in DEMAND
                // ENGINE etc.): open that panel, then jump once it is drawn.
                const inner = !hit && !eng && full && full.nodes.find((n) => n.kind === 'field' && !n.flat
                  && String(n.label).toLowerCase().indexOf(q) !== -1);
                if (hit) goTo(hit.id);
                else if (eng) goTo(eng.id);
                else if (inner) {
                  pendingFind.current = inner.id;
                  setExpanded((cur) => new Set(cur).add('p:' + inner.page + ':' + inner.group));
                }
              }
            }
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder="find a panel, file or provider"
          spellCheck={false}
          style={{
            background: '#0d1730', border: `1px solid ${q ? C.pink : C.border}`, borderRadius: 999,
            color: C.text, fontFamily: 'inherit', fontSize: 10, padding: '4px 11px', width: 200, outline: 'none',
          }}
        />
        {matches && (
          <span style={{ fontSize: 9, color: C.faint }}>
            {matches.size ? matches.size + ' match' : 'enter: search inside engines'}
          </span>
        )}
      </div>

      {/* ---- canvas ----------------------------------------------------- */}
      <div
        ref={attachCanvas}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onContextMenu={(ev) => openMenu(ev, { kind: 'canvas' })}
        // A click on the EMPTY map clears the selection (boxes and cards stop
        // their own clicks). Nothing else is closed by it.
        onClick={() => {
          if (pannedFar.current) { pannedFar.current = false; return; }
          setSelected(null);
        }}
        onMouseLeave={endDrag}
        style={{
          position: 'relative', flex: 1, overflow: 'hidden', cursor: drag.current ? 'grabbing' : 'grab',
          // A drag here is a pan, never a text selection - without this every
          // box label the pointer crossed lit up blue. Open cards opt back in.
          userSelect: 'none', WebkitUserSelect: 'none',
          background: 'radial-gradient(circle at 30% 20%, #0b1a3a 0%, #060d1f 70%)',
        }}
      >
        {/* Actions on the map - group, rename, ungroup, delete a wire, reset -
            float at its bottom-left, so the header holds only where you are
            and the search. A press here is a click, never the start of a pan. */}
        <div onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', left: 12, bottom: 12, zIndex: 20, display: 'flex',
            alignItems: 'center', gap: 8, flexWrap: 'wrap', maxWidth: 'calc(100% - 24px)',
          }}>
            {/* GROUP: shift-click boxes, name them, make them one engine. */}
            {groupSet.size > 0 && (
              <>
                <input value={groupName} onChange={(e) => setGroupName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') groupIntoEngine(); if (e.key === 'Escape') setGroupSet(new Set()); }}
                  placeholder={'name for ' + groupSet.size + ' boxes'} spellCheck={false}
                  style={{ background: '#0d1730', border: `1px solid ${C.pink}`, borderRadius: 999, color: C.text,
                    fontFamily: 'inherit', fontSize: 10, padding: '4px 10px', width: 150, outline: 'none' }} />
                <Button onClick={groupIntoEngine} active>GROUP {groupSet.size} INTO ENGINE</Button>
                <Button onClick={() => setGroupSet(new Set())}>CLEAR</Button>
              </>
            )}
            {/* The selected engine: open it, rename it, or take it apart. */}
            {selected && H && H.engines.has(selected) && groupSet.size === 0 && (
              <>
                <Button onClick={() => dive(selected)} active>OPEN</Button>
                <input value={rename} onChange={(e) => setRename(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') renameEngine(selected, rename); }}
                  placeholder={'rename ' + H.engines.get(selected).label.toLowerCase()} spellCheck={false}
                  style={{ background: '#0d1730', border: `1px solid ${C.border}`, borderRadius: 999, color: C.text,
                    fontFamily: 'inherit', fontSize: 10, padding: '4px 10px', width: 150, outline: 'none' }} />
                {rename.trim() && <Button onClick={() => renameEngine(selected, rename)}>RENAME</Button>}
                <Button onClick={() => ungroup(selected)} title="move everything inside it up one level and remove the engine">
                  UNGROUP
                </Button>
              </>
            )}
            {pickedWire && (
              <Button onClick={() => deleteWire(pickedWire)} active title="or press Delete">DELETE WIRE</Button>
            )}
            {cfgTouched && (
              <Button onClick={() => {
                if (!confirmReset) { setConfirmReset(true); return; }
                setCfg(emptyConfig()); setPath([ROOT]); setConfirmReset(false);
              }} title="drop your engines, moves, renames and sketch wires">
                {confirmReset ? 'CLICK AGAIN TO RESET' : 'RESET ENGINES'}
              </Button>
            )}
            {moved.size > 0 && (
              <Button onClick={() => setMoved(new Map())} title="put every box back where the layout put it">
                RESET {moved.size} MOVED
              </Button>
            )}
            {editCount > 0 && (
              <Button onClick={restoreEdits} title="bring back every deleted box and cut wire">
                RESTORE {editCount} DELETED
              </Button>
            )}
            {clip && (
              <Button onClick={paste} active title={'paste here (Ctrl+V)'}>
                PASTE {clip.mode === 'cut' ? 'MOVE' : 'COPY'}
              </Button>
            )}
        </div>
        <div style={{
          position: 'absolute', left: 0, top: 0,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transformOrigin: '0 0',
        }}>
          {/* UNDER the cards. Putting it above did make a line reach its dot,
              but every line that merely passes BEHIND a card was then painted
              across its face and the card read as transparent. A card is
              opaque; the line is carried the last few pixels by a nub drawn
              inside it, the same way the row chips have always done it. */}
          <svg
            width={laid.width + 40} height={laid.height + 40}
            style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
          >
            <defs>
              <style>{'@keyframes vsEdgeFlow { to { stroke-dashoffset: -12; } }'}</style>
              {[WIRE_OK, WIRE_BAD, SKETCH_COLOR].map((color) => (
                <marker key={color} id={markerId(color)} viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 1 L 8 4 L 0 7 z" fill={color} />
                </marker>
              ))}
            </defs>
            {drawEdges.map((e) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              const s = EDGE_STYLE[e.kind] || EDGE_STYLE.field;
              // The box it comes OUT of decides the colour - except a sketch
              // wire, which is always the user's own colour.
              const isSketch = e.kind === 'sketch';
              const ws = wireState(e);
              const color = ws.color;
              // From the right edge of one box to the left edge of the next -
              // or, on a box with ports, from / to the ROW of the value carried.
              const pa = posOf(a);
              const pb = posOf(b);
              let p1 = { x: pa.x + a.w, y: pa.y + a.h / 2 };
              let p2 = { x: pb.x, y: pb.y + b.h / 2 };
              if (e.fromPort && (a.kind === 'engine' || (a.ported && !a.uport))) p1 = portPoint(a, pa, 'out', e.fromPort);
              if (e.toPort && (b.kind === 'engine' || (b.ported && !b.uport))) p2 = portPoint(b, pb, 'in', e.toPort);
              // Hovering BRIGHTENS the path it belongs to. It used to fade
              // everything else to near-invisible, which answered the question
              // by hiding the diagram rather than by pointing at part of it.
              const onPath = related && (e.from === focus || e.to === focus);
              const hot = hoverEdge && hoverEdge.id === e.id;
              // A line of the SELECTED box: lit and streaming, like a hovered one.
              const sel = Boolean(selected && (e.from === selected || e.to === selected));
              const picked = isSketch && pickedWire && e.sketchId === pickedWire;
              const lit = hot || sel || picked;
              const d = edgePath(p1, p2);
              const track = (ev) => {
                if (drag.current || nodeDrag.current) return;
                setHoverEdge({ id: e.id, x: ev.clientX, y: ev.clientY });
              };
              return (
                <g key={e.id}>
                  <path
                    d={d}
                    fill="none"
                    stroke={color}
                    strokeWidth={hot ? 2.6 : sel ? 2.2 : onPath ? 1.8 : 1}
                    strokeDasharray={ws.dash || s.dash || undefined}
                    markerEnd={`url(#${markerId(color)})`}
                    opacity={lit || color === WIRE_BAD ? 1 : onPath ? 0.95 : 0.35}
                    style={lit ? { filter: `drop-shadow(0 0 3px ${color})` } : undefined}
                  />
                  {/* Data moving along a hovered or selected line, source to target. */}
                  {ws.why && <title>{ws.why}</title>}
                  {lit && (
                    <path d={d} fill="none" stroke="#ffffff" strokeWidth={1.6}
                      strokeDasharray="2 10" strokeLinecap="round" opacity={0.9}
                      style={{ animation: 'vsEdgeFlow 0.6s linear infinite' }} />
                  )}
                  {/* The hit area: a thin line is a 1px target, so a wide
                      invisible copy takes the pointer. Divided by the zoom so
                      it stays ~10px on screen at any scale. */}
                  <path
                    d={d}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={10 / view.k}
                    pointerEvents="stroke"
                    style={{ cursor: isSketch ? 'pointer' : 'help' }}
                    // A sketch wire is picked by clicking it, then deleted.
                    onClick={isSketch ? (ev) => { ev.stopPropagation(); setPickedWire(e.sketchId); } : undefined}
                    onMouseDown={isSketch ? (ev) => ev.stopPropagation() : undefined}
                    onContextMenu={(ev) => openMenu(ev, { kind: 'wire', edge: e })}
                    onMouseEnter={track}
                    onMouseMove={track}
                    onMouseLeave={() => setHoverEdge((cur) => (cur && cur.id === e.id ? null : cur))}
                  />
                </g>
              );
            })}

            {/* The wire being drawn, from the outlet to the pointer. */}
            {wireDrag && (
              <path d={edgePath({ x: wireDrag.x0, y: wireDrag.y0 }, { x: wireDrag.x, y: wireDrag.y })}
                fill="none" stroke={SKETCH_COLOR} strokeWidth={1.8} strokeDasharray="7 4" opacity={0.95} />
            )}

            {/* The outlines, over the arrows and under the labels. One path
                per box, drawn from posOf like everything else. */}
            <g>
              {laid.nodes.map((n) => {
                // An engine draws its own frame (it has port rows inside it),
                // and so does a closed panel drawn the same way.
                if (n.kind === 'engine' || n.ported || n.kind === 'port') return null;
                if (groupSet.has(n.id)) {
                  const gp = posOf(n);
                  return (
                    <path key={n.id} d={roundedPath(gp.x - 3, gp.y - 3, n.w + 6, n.h + 6, BOX_RADIUS + 2)}
                      fill={nodeColor(n) + BOX_FILL} stroke="#ffffff" strokeWidth={1.6} strokeDasharray="4 3" />
                  );
                }
                const col = nodeColor(n);
                const dim = Boolean(matches && !matches.has(n.id));
                const pos = posOf(n);
                // The selected box glows; the boxes it is wired to get a
                // brighter, thicker outline.
                const isSel = n.id === selected;
                const isNear = Boolean(selNear && selNear.has(n.id));
                return (
                  <path key={n.id} d={roundedPath(pos.x, pos.y, n.w, n.h, BOX_RADIUS)}
                    fill={col + (dim ? '08' : isSel ? '44' : BOX_FILL)}
                    stroke={isSel || isNear ? col : col + (dim ? '33' : BOX_STROKE)}
                    strokeWidth={isSel ? 2.4 : isNear ? 1.8 : 1}
                    style={isSel ? { filter: `drop-shadow(0 0 6px ${col})` } : undefined}
                    opacity={dim ? 0.3 : 1} />
                );
              })}
            </g>
          </svg>

          {laid.nodes.map((n) => {
            const col = nodeColor(n);
            // Only a SEARCH dims boxes - that is what a search is for. Hovering
            // leaves every box exactly as it was.
            const dim = Boolean(matches && !matches.has(n.id));
            const open = n.kind === 'panel' && expanded.has(n.id);
            const pos = posOf(n);
            // Shift-click collects boxes to GROUP; a plain click selects (and
            // opens a box's card - an engine or a port has none).
            const onBoxClick = (e) => {
              e.stopPropagation();
              // Letting go after a drag must not also open the box.
              if (draggedFar.current) { draggedFar.current = false; return; }
              if (e.shiftKey && n.kind !== 'port') {
                setGroupSet((cur) => { const next = new Set(cur); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; });
                return;
              }
              setSelected(n.id);
              setPickedWire(null);
            };
            if (n.uport || n.kind === 'port') {
              const side = n.uport ? n.uport : n.side;
              const key = n.uport ? n.id : n.src;
              let val = null;
              try { val = n.field && n.field.value ? boxValue(n, liveV.current) : null; } catch (err) { val = null; }
              return (
                <ConnectorNode key={n.id} n={n} pos={pos} col={col} dim={dim} isSel={n.id === selected} v={liveV.current}
                  side={side} label={n.label} value={val}
                  onRename={(name) => (n.uport ? renameAdded(n.id, name) : renamePort(key, name))}
                  onMouseDown={startNodeDrag(n.id)} onClick={onBoxClick}
                  onDoubleClick={(e) => { e.stopPropagation(); if (n.kind === 'port') goTo(n.src); }}
                  onHover={(on) => setHover(on ? n.id : null)}
                  onStartWire={startWire(key)}
                  onContextMenu={(ev) => openMenu(ev, { kind: 'box', id: n.id })} />
              );
            }
            if (n.ported && n.kind === 'field') {
              return (
                <CalcBox key={n.id} n={n} pos={pos} col={col} dim={dim}
                  isSel={n.id === selected} isNear={Boolean(selNear && selNear.has(n.id))}
                  inGroup={groupSet.has(n.id)}
                  onMouseDown={startNodeDrag(n.id)} onClick={onBoxClick}
                  onHover={(on) => setHover(on ? n.id : null)}
                  onStartWire={startWire} v={liveV.current} nodeById={H ? H.nodeById : null}
                  onMeasure={onMeasure} alert={missingOf(n.id)}
                  onContextMenu={(ev) => openMenu(ev, { kind: 'box', id: n.id })} />
              );
            }
            if (n.ported) {
              return (
                <EngineBox key={n.id} n={n} pos={pos} col={col} dim={dim}
                  isSel={n.id === selected} isNear={Boolean(selNear && selNear.has(n.id))}
                  inGroup={groupSet.has(n.id)}
                  onMouseDown={startNodeDrag(n.id)} onClick={onBoxClick}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onHover={(on) => setHover(on ? n.id : null)}
                  onStartWire={startWire} v={liveV.current} nodeById={H ? H.nodeById : null}
                  alert={missingOf(n.id)} onContextMenu={(ev) => openMenu(ev, { kind: 'box', id: n.id })} />
              );
            }
            if (n.kind === 'engine') {
              return (
                <EngineBox key={n.id} n={n} pos={pos} col={col} dim={dim}
                  isSel={n.id === selected} isNear={Boolean(selNear && selNear.has(n.id))}
                  inGroup={groupSet.has(n.id)}
                  onMouseDown={startNodeDrag(n.id)} onClick={onBoxClick}
                  onDoubleClick={(e) => { e.stopPropagation(); dive(n.id); }}
                  onHover={(on) => setHover(on ? n.id : null)}
                  onStartWire={startWire} v={liveV.current} nodeById={H ? H.nodeById : null}
                  alert={brokenGroups.get(n.id) || null} onContextMenu={(ev) => openMenu(ev, { kind: 'box', id: n.id })} />
              );
            }
            return (
              <div
                key={n.id}
                data-node-id={n.id}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onMouseDown={startNodeDrag(n.id)}
                onClick={onBoxClick}
                onContextMenu={(ev) => openMenu(ev, { kind: 'box', id: n.id })}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (n.kind === 'panel') togglePanel(n.id);
                  // A boundary port: go to where its data comes from / goes.
                  if (n.kind === 'port') goTo(n.src);
                }}
                style={{
                  // The outline is drawn in the SVG above; this layer is only
                  // the label and the hit area, so it carries no border of
                  // its own - a rectangle would show through every trapezium.
                  position: 'absolute', left: pos.x, top: pos.y,
                  width: n.w, height: n.h,
                  boxSizing: 'border-box', cursor: 'grab',
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '0 8px',
                  opacity: dim ? 0.3 : 1,
                }}
              >
                <KindIcon node={n} color={col} />
                <span style={{ ...boxLabelStyle(n), color: dim ? C.grey : '#e7edff' }}>{n.label}</span>
                {/* The live value, on the box: the map is read as numbers moving
                    left to right, not as names to click one at a time. */}
                {(() => {
                  const val = boxValue(n, liveV.current);
                  return val === null ? null : (
                    <span style={{
                      fontSize: 9.5, fontWeight: 700, color: dim ? C.grey : C.white, flexShrink: 0,
                      maxWidth: '48%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{val}</span>
                  );
                })()}
                {n.kind === 'panel' && (
                  /* How many values LEAVE this box, sitting astride its right
                     edge - half in, half out - so it reads as the box's output
                     rather than as a label inside it. Opaque, because the half
                     hanging over the canvas would otherwise have arrows
                     showing through it. */
                  <span style={{
                    position: 'absolute', right: 0, top: '50%',
                    transform: 'translate(50%, -50%)',
                    fontSize: 8, color: col, flexShrink: 0, padding: '1px 5px', borderRadius: 7,
                    border: `1px solid ${col}88`, background: C.bg,
                    boxShadow: `0 0 0 2px ${C.bg}`,
                  }}>{open ? 'open' : n.count}</span>
                )}
                {n.kind === 'field' && n.status && n.status !== 'live' && (
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: n.status === 'placeholder' ? C.hot : C.amber,
                  }} />
                )}
                {/* The outlet: drag from it to draw a sketch wire. On a panel
                    it sits at the bottom corner, clear of the output count
                    that rides the middle of its right edge. */}
                <Outlet col={col} onMouseDown={startWire(n.kind === 'port' ? n.src : n.id)}
                  style={n.kind === 'panel' ? { top: 'auto', bottom: -4.5, marginTop: 0 } : undefined} />
              </div>
            );
          })}

          {/* Column headers - the step each column IS - and a caption over
              each run of one tab's panels. Both come from the layout, which is
              the one place that knows where a column and a run begin. */}
          {/* Column titles with a subline ("3 · ENGINES / for the selected token")
              are not drawn: the groups and boxes name themselves. Only the
              short IN / OUT over a group's connectors stay. */}
          {(laid.captions || []).filter((c) => !(c.kind === 'stage' && c.sub)).map((c, i) => (c.kind === 'stage' ? (
            <div key={'c' + i} style={{
              position: 'absolute', left: c.x, top: c.y, width: c.w, pointerEvents: 'none',
              borderTop: `2px solid ${c.color}`, paddingTop: 5,
            }}>
              <div style={{ fontSize: 10, letterSpacing: 1.3, fontWeight: 800, color: c.color }}>{c.text}</div>
              <div style={{ fontSize: 8.5, color: C.grey, marginTop: 1 }}>{c.sub}</div>
            </div>
          ) : (
            <div key={'c' + i} style={{
              position: 'absolute', left: c.x, top: c.y, fontSize: 8, letterSpacing: 1.2,
              fontWeight: 700, color: c.color, opacity: 0.8, pointerEvents: 'none',
            }}>{c.text}</div>
          )))}
        </div>
        {menu && (() => {
          const item = (label, run, enabled, key) => (
            <div key={label} onMouseDown={(ev) => { ev.stopPropagation(); if (!enabled) return; run(); setMenu(null); }}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 18, padding: '6px 12px', fontSize: 10.5,
                cursor: enabled ? 'pointer' : 'default', color: enabled ? C.text : C.grey }}
              onMouseEnter={(ev) => { if (enabled) ev.currentTarget.style.background = 'rgba(227,95,242,0.12)'; }}
              onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}>
              <span>{label}</span><span style={{ color: C.faint, fontSize: 9 }}>{key}</span>
            </div>
          );
          const isGroup = menu.kind === 'box' && H && H.engines.has(menu.id);
          const editable = menu.kind === 'box' && canEdit(menu.id);
          return (
            <div onMouseDown={(ev) => ev.stopPropagation()} onContextMenu={(ev) => ev.preventDefault()} style={{
              position: 'fixed', left: menu.x, top: menu.y, zIndex: 300, minWidth: 170, padding: '4px 0',
              background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 14px 40px rgba(0,0,0,0.6)',
            }}>
              {menu.kind === 'box' && (
                <div style={{ padding: '4px 12px 6px', fontSize: 8.5, fontWeight: 700, letterSpacing: 0.8, color: C.dim,
                  borderBottom: `1px solid ${C.line}`, marginBottom: 2, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {((byId.get(menu.id) || {}).label || '').toUpperCase()}
                </div>
              )}
              {menu.kind === 'box' && item(isGroup ? 'Delete group and contents' : 'Delete', () => deleteBox(menu.id), editable, 'Del')}
              {menu.kind === 'box' && item('Copy', () => copyBox(menu.id), editable && !isGroup, 'Ctrl+C')}
              {menu.kind === 'box' && item('Cut', () => cutBox(menu.id), editable, 'Ctrl+X')}
              {item(clip ? 'Paste ' + (clip.mode === 'cut' ? '(move here)' : '(a copy)') : 'Paste', paste, Boolean(clip), 'Ctrl+V')}
              {menu.kind === 'canvas' && (
                <div onMouseEnter={() => setMenu((m) => (m ? { ...m, sub: true } : m))}
                  style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '6px 12px', fontSize: 10.5,
                    cursor: 'pointer', color: C.white, borderTop: `1px solid ${C.line}`, marginTop: 2,
                    background: menu.sub ? 'rgba(227,95,242,0.12)' : 'transparent' }}>
                  <span>Add</span><span style={{ color: C.faint }}>&#9656;</span>
                  {menu.sub && (
                    <div onMouseDown={(ev) => ev.stopPropagation()} style={{
                      position: 'absolute', left: '100%', top: -6, marginLeft: 4, width: 210, padding: '4px 0', maxHeight: 420, overflowY: 'auto',
                      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, boxShadow: '0 14px 40px rgba(0,0,0,0.6)',
                    }}>
                      {ADD_CATALOG.map((group) => (
                        <div key={group.cat}>
                          <div style={{ padding: '6px 12px 3px', fontSize: 8, fontWeight: 800, letterSpacing: 1, color: C.dim }}>{group.cat}</div>
                          {group.items.map((it) => (
                            <div key={it.label}
                              onMouseDown={(ev) => { ev.stopPropagation(); if (it.inGroup && level === ROOT) return; addBox(it, { x: menu.x, y: menu.y }); setMenu(null); }}
                              onMouseEnter={(ev) => { ev.currentTarget.style.background = 'rgba(227,95,242,0.12)'; }}
                              onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
                              style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 12px', fontSize: 10.5, color: C.text, cursor: 'pointer' }}>
                              <span>{it.label}</span>
                              {!it.live && <span style={{ fontSize: 8, color: C.faint }}>draft</span>}
                              {it.inGroup && level === ROOT && <span style={{ fontSize: 8, color: C.faint }}>inside a group</span>}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {menu.kind === 'wire' && item('Delete wire', () => cutWire(menu.edge), true, 'Del')}
            </div>
          );
        })()}
        {hoverEdge && (() => {
          const e = laid.edges.find((x) => x.id === hoverEdge.id);
          if (!e) return null;
          return (
            <EdgeTip edge={e} at={hoverEdge} byId={byId} fullById={fullById} v={liveV.current} />
          );
        })()}
      </div>
    </div>
  );
}

/**
 * What an open panel actually computes: every number in it, its value right
 * now, and the expression behind it.
 *
 * The card used to show only FED BY and FEEDS - what the panel is wired to,
 * never what it does with it. The relations between the numbers live inside
 * these expressions: an operand that names another field IS the link, and
 * clicking it goes there, so the arithmetic and the graph are the same
 * thing seen at two scales.
 *
 * Deliberately NOT anchored: the arrows stay attached to the FED BY and
 * FEEDS rows. A neighbour can appear in both an expression and a list, and
 * two anchors for one line would make where an arrow lands a coin toss.
 */
/** A live value as text, or the element a field's value() already built. */
const tipValue = (val) => {
  if (val === null || val === undefined || val === '') return '—';
  if (typeof val === 'number' || typeof val === 'string' || React.isValidElement(val)) return val;
  try { return JSON.stringify(val).slice(0, 60); } catch (err) { return String(val); }
};

/**
 * What is travelling along one arrow: every field-level link it stands for,
 * with the LIVE value carried. A field's value comes from fieldValues(v) -
 * the same value() call its card makes, so the tooltip cannot disagree with
 * the card. For a file, provider or store end, the carried value is the
 * field at the other end, which is what was read or written.
 */
function EdgeTip({ edge, at, byId, fullById, v }) {
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return null;
  const vals = fieldValues(v);
  const valOf = (n) => (n && n.kind === 'field' ? vals.get(n.page + '|' + n.label) : undefined);
  const parts = edge.parts || [{ from: edge.from, to: edge.to }];
  const rows = parts.map((p) => {
    const src = fullById.get(p.from) || byId.get(p.from);
    const dst = fullById.get(p.to) || byId.get(p.to);
    const carrier = src && src.kind === 'field' ? src : dst;
    return { src, dst, carrier, val: valOf(carrier) };
  });
  const MAX = 12;
  const s = EDGE_STYLE[edge.kind] || EDGE_STYLE.field;
  const color = nodeColor(a);
  // Flip to the other side of the pointer near the right or bottom edge, or
  // the arrows at the far end of the map would show a clipped tooltip.
  const flipX = at.x > window.innerWidth - 400;
  const flipY = at.y > window.innerHeight - 260;
  const place = {
    ...(flipX ? { right: window.innerWidth - at.x + 14 } : { left: at.x + 14 }),
    ...(flipY ? { bottom: window.innerHeight - at.y + 14 } : { top: at.y + 14 }),
  };
  return (
    <div style={{
      position: 'fixed', ...place, zIndex: 50, pointerEvents: 'none',
      maxWidth: 380, background: '#0a1430f2', border: `1px solid ${color}88`, borderRadius: 6,
      padding: '8px 10px', fontSize: 10, color: '#e7edff', boxShadow: '0 6px 20px #0008',
    }}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>
        <span style={{ color }}>{a.label}</span>
        <span style={{ color: C.grey }}> &rarr; </span>
        <span style={{ color: nodeColor(b) }}>{b.label}</span>
      </div>
      <div style={{ fontSize: 8.5, color: C.grey, letterSpacing: 0.8, marginBottom: 6 }}>
        {s.label.toUpperCase()} &middot; {rows.length} {rows.length === 1 ? 'value' : 'values'}
      </div>
      {rows.slice(0, MAX).map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '1.5px 0' }}>
          <span style={{ flex: 1, minWidth: 0, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.src ? r.src.label : '?'}
            {r.dst && r.dst.id !== (r.src && r.src.id) && (
              <span style={{ color: C.grey }}> &rarr; {r.dst.label}</span>
            )}
          </span>
          <span style={{ fontWeight: 700, color: C.white, flexShrink: 0, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.carrier && r.carrier.kind === 'field' ? tipValue(r.val) : ''}
          </span>
        </div>
      ))}
      {rows.length > MAX && (
        <div style={{ color: C.grey, marginTop: 3 }}>+{rows.length - MAX} more</div>
      )}
    </div>
  );
}
