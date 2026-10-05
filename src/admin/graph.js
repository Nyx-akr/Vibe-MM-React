/**
 * The whole system as one directed graph: providers, files, stores, fields.
 *
 * NOTHING IS DECLARED TWICE. The graph is derived from provenance.js - the
 * same catalogue the mirror renders - by reading the operand tokens that are
 * already there. A `ref` is an edge between two fields, an `ext` is an edge
 * from a provider, an `api` is an edge from a file in the raw store. Add a
 * card to provenance.js and it appears here; change where a number comes from
 * and the arrow moves. A hand-maintained diagram would be wrong within a week.
 *
 * The one thing tokens cannot express is browser storage, because no card
 * says "and this is persisted". That is STORE_LINKS below, which is the only
 * hand-written part of the graph and is kept small and checkable.
 *
 * LAYOUT is a plain left-to-right layered DAG: providers, then the files they
 * are written to, then fields in dependency order. Cycles exist (a field can
 * both feed and be fed by the same neighbour across tabs), so back edges are
 * found by DFS and dropped for layering only - they are still drawn.
 */

import { PAGES, SOURCE_BY_ID } from './provenance';
// Registers PAGES.pipe - the score pipeline - before anything walks PAGES.
import './pipeline';

/* ------------------------------------------------------------- stores --- */

/**
 * The three browser stores, as the storage architecture defines them.
 *
 * `disk` is not here: the raw files ARE nodes already, built from the `api`
 * tokens, because the app names them on every card that reads one.
 */
export const STORES = {
  'idb:score-journal': {
    label: 'score-journal', backend: 'IndexedDB · app store',
    detail: 'One mark per token per 60s: what it scored, its stage, its flags. ' +
      'Thinned to one per 15 min past 6h, kept ~50h. This is the PREDICTION half of ' +
      'every evaluation - the archive on disk holds the rest.',
  },
  'idb:stage-memory': {
    label: 'stage-memory', backend: 'IndexedDB · app store',
    detail: 'Each token’s last stage, so hysteresis survives a reload and a score ' +
      'hovering on a band edge does not flicker between two badges.',
  },
  'idb:score-window': {
    label: 'score-window', backend: 'IndexedDB · app store',
    detail: 'The rolling 15-minute window the settled score is averaged over. Without ' +
      'it the board would rank on the instantaneous score and reshuffle every poll.',
  },
  'idb:wallet-memory': {
    label: 'wallet-memory', backend: 'IndexedDB · app store',
    detail: 'Every wallet the background service has seen, across every sampled pool, ' +
      'plus the co-entry clusters it logged. Megabyte-scale, which is why it is not in ' +
      'localStorage.',
  },
  'idb:wallet-snapshots': {
    label: 'wallet-snapshots', backend: 'IndexedDB · app store',
    detail: 'Per-pool snapshots behind the bubble map, so reopening a token paints ' +
      'immediately instead of waiting for the next sample.',
  },
  'idb:social-memory': {
    label: 'social-memory', backend: 'IndexedDB · app store',
    detail: 'Mention counts per ticker, one sample a minute, kept with the tab closed. ' +
      'This is what makes a baseline possible at all.',
  },
  'idb:trails': {
    label: 'score trails', backend: 'IndexedDB · own database',
    detail: 'A fortnight of price and per-component scores per token, for the detail ' +
      'chart. Its own database because it is tens of MB - fine on disk, wrong in the ' +
      'app store’s hydrate-everything-at-boot shape.',
  },
  'ls:inputs': {
    label: 'user inputs', backend: 'localStorage',
    detail: 'Watchlist, wallet registry, chain and stage selection. Small, read during ' +
      'render, and losing one is an annoyance rather than a gap in the record - which is ' +
      'exactly what localStorage is for. Deliberately NOT the same store as the history, ' +
      'so a corrupt history can never cost the user their watchlist.',
  },
  'ls:api-target': {
    label: 'server target', backend: 'localStorage',
    detail: 'AUTO / LOCAL / DEPLOYED. Decides which origin every file below is read ' +
      'from, so it sits upstream of the entire raw store rather than beside it.',
  },
};

/**
 * Which fields touch which store. The only hand-written edges in the graph.
 *
 * `w` is written by that field’s pass, `r` is read by it. Each one is a claim
 * about the code that can be checked in one grep, which is why they are listed
 * rather than inferred.
 */
export const STORE_LINKS = [
  // services/api.js fetchLiveMarketData(): recordScore() and recordTrail() run
  // on every evaluated row, with the settled score, stage and flags.
  { store: 'idb:score-journal', page: 'pipe', field: 'FINAL', dir: 'w' },
  { store: 'idb:trails', page: 'pipe', field: 'FINAL', dir: 'w' },
  // persistDerived(): saveStageMemory() / saveScoreWindow().
  { store: 'idb:stage-memory', page: 'pipe', field: 'STAGE', dir: 'w' },
  { store: 'idb:score-window', page: 'pipe', field: 'FINAL', dir: 'w' },
  { store: 'idb:wallet-memory', page: 'wallets', field: 'WALLET INTEL', dir: 'w' },
  { store: 'idb:wallet-snapshots', page: 'wallets', field: 'WALLET INTEL', dir: 'w' },
  { store: 'idb:social-memory', page: 'social', field: 'BASELINE', dir: 'w' },
];

/* -------------------------------------------------------------- pages --- */

export const PAGE_TITLES = {
  pipe: 'SCORE PIPELINE',
  live: 'LIVE OPPORTUNITIES', detail: 'ASSET DETAIL', social: 'SOCIAL SCANNER',
  wallets: 'WALLETS', rotation: 'ROTATION', market: 'MARKET ROTATION', alerts: 'ALERT CARDS',
  eval: 'EVALUATION', health: 'SYSTEM HEALTH',
};

/** One hue per tab, so a cross-tab arrow is readable as one at a glance. */
/**
 * Eleven colours that have to be told apart at a glance, so they are spread
 * around the wheel rather than picked to look nice together.
 *
 * The old set had FOUR exact collisions - provider and ROTATION were the same
 * amber, file and WALLETS the same teal, store and EVALUATION the same
 * violet, panel and HEALTH the same grey - which made the one thing the
 * colour is for, saying where a line came from, impossible to read.
 *
 * Order round the wheel: orange, yellow, lime, green, teal, cyan, blue,
 * violet, magenta, crimson, and a neutral slate that belongs to no hue.
 */
export const PAGE_COLORS = {
  live: '#3b82f6',      // blue
  detail: '#ff5ce0',    // magenta
  social: '#22d3ee',    // cyan
  wallets: '#4ade80',   // green
  rotation: '#a3e635',  // lime
  alerts: '#f43f5e',    // crimson
  eval: '#ffd60a',      // yellow
  health: '#94a3b8',    // slate
  // Near-white rather than a twelfth hue: eleven are already spread round the
  // wheel and a twelfth would have to sit within ~15 degrees of one of them.
  // No hue at all cannot be confused with any of them.
  market: '#e2e8f0',
  pipe: '#ffd60a',
};

/**
 * The pipeline's own columns, left to right, and a colour per step.
 *
 * The four hues are the ones the excluded tabs freed up (MARKET near-white,
 * HEALTH slate, ALERTS crimson, EVALUATION yellow), so none of them collides
 * with a tab or a kind still on the map. Brightest at the end: the score is
 * the number the whole map is for.
 */
export const STAGES = {
  1: { title: '1 · TOKEN LIST', color: '#e2e8f0' },
  2: { title: '2 · TOKEN INPUTS', color: '#e2e8f0' },
  3: { title: '3 · MEASURES', color: '#94a3b8' },
  4: { title: '4 · SCORE DECOMPOSITION', color: '#f43f5e' },
  5: { title: '5 · SCORE', color: '#ffd60a' },
};

export const KIND_COLORS = {
  provider: '#ff7a1c',  // deep orange
  file: '#2ec4b6',      // teal
  store: '#b06bff',     // violet
  panel: '#94a3b8',     // only the legend swatch; real panels take their tab
};

/* ------------------------------------------------------- graph building -- */

const fieldId = (page, label) => 'f:' + page + ':' + label;
const panelId = (page, group) => 'p:' + page + ':' + group;
const fileId = (path) => 'file:' + path;
const extId = (source) => 'ext:' + source;

/** Every token in a card that could be an edge, in one flat list. */
function tokensOf(field) {
  const out = [];
  const push = (list, dir) => (list || []).forEach((t) => {
    if (t && typeof t === 'object' && t.t && t.t !== 'op' && t.t !== 'num') out.push({ t, dir });
  });
  // Only where a value says it COMES FROM. `feeds` is the reverse claim -
  // "and this is used by..." - written on the producer, and it drifts: the
  // board's LIQUIDITY still claimed to feed the score long after the score
  // read the pipeline's own reading. An arrow is drawn by its consumer naming
  // its input, so there is one source of truth per line.
  push(field.calc, 'in');
  push(field.fetch, 'in');
  if (field.via) push([field.via], 'in');
  return out;
}

/**
 * Tabs left OFF the map. It is about how a token is fetched, scored and shown;
 * these four are board-wide reports built on top of that, and drawing them
 * roughly doubled the boxes without saying anything about one token's score.
 * Their mirror tabs are unchanged.
 */
export const EXCLUDED_PAGES = new Set(['market', 'alerts', 'eval', 'health']);

/**
 * Walks provenance.js and returns every node and edge in the system.
 *
 * `v` is the live viewmodel, so the groups that generate their cards from data
 * - the score components, the provider rows, the rank bands - contribute their
 * real current nodes rather than a guess at how many there might be.
 */
export function buildGraph(v) {
  const nodes = new Map();
  const edges = [];
  // `seq` is catalogue order: the starting order of a column before the
  // crossing passes, and their tie-break, so the layout is stable poll to poll.
  let seq = 0;
  const add = (node) => { if (!nodes.has(node.id)) nodes.set(node.id, { ...node, seq: seq++ }); return nodes.get(node.id); };
  const link = (from, to, kind, label) => {
    if (!from || !to || from === to) return;
    edges.push({ id: from + '>' + to + ':' + kind, from, to, kind, label });
  };

  Object.keys(PAGES).forEach((page) => {
    if (EXCLUDED_PAGES.has(page)) return;
    const spec = PAGES[page];
    (spec.groups || []).forEach((group) => {
      let fields = [];
      try {
        fields = group.from ? (group.from(v) || []) : (group.fields || []);
      } catch (e) {
        // A generator that throws on an empty viewmodel must not take the
        // whole map down with it - the rest of the system is still describable.
        fields = [];
      }
      if (!fields.length) return;

      // A FLAT group (the score pipeline) has no panel box: each of its
      // fields is one step of the calculation, and folding twelve components
      // into one box is exactly what hid how the score is made.
      if (!group.flat) {
        add({
          id: panelId(page, group.group), kind: 'panel', page,
          label: group.group, group: group.group, count: fields.length,
          // A pipeline panel (SCORE DECOMPOSITION) sits in its step's column.
          stage: group.stage || null, shows: group.shows || null,
          // The cards themselves, so an open panel can show what it COMPUTES
          // and not only what it is wired to. Without this the panel would
          // have to be expanded on the map before its arithmetic was visible
          // anywhere, which is the one thing the box is for.
          fields,
        });
      }

      fields.forEach((field) => {
        const fid = fieldId(page, field.label);
        add({
          id: fid, kind: 'field', page, group: group.group,
          label: field.label, status: field.status || 'live', field,
          stage: group.stage || null, flat: Boolean(group.flat),
        });

        const toks = tokensOf(field);
        // Every provider reaches the app THROUGH the raw store - the server
        // writes files and the app reads them, never the provider directly.
        // So when a card names both, the arrow goes provider -> file -> field
        // rather than jumping the layer that actually carries the data.
        const files = toks.filter((x) => x.t.t === 'api' && x.dir === 'in').map((x) => x.t.path);

        toks.forEach(({ t, dir }) => {
          if (t.t === 'ref') {
            const other = fieldId(t.page, t.field);
            if (dir === 'in') link(other, fid, 'field');
            else link(fid, other, 'field');
            return;
          }
          if (t.t === 'api') {
            add({ id: fileId(t.path), kind: 'file', label: t.path, path: t.path });
            // Only ever INTO the app. A card that names a file under `feeds`
            // means the same value is also recorded there - by the server's
            // collector, from the same upstream - not that the app wrote it.
            // Drawing that as an arrow out of the app would contradict the
            // one rule the whole storage split rests on.
            if (dir === 'in') link(fileId(t.path), fid, 'file');
            return;
          }
          if (t.t === 'ext') {
            const src = SOURCE_BY_ID[t.source] || { label: t.source };
            add({ id: extId(t.source), kind: 'provider', label: src.label, source: t.source });
            if (files.length) {
              files.forEach((p) => link(extId(t.source), fileId(p), 'collect'));
            } else {
              // No file named on this card. The data still arrives through the
              // raw store, so the edge is drawn dashed rather than pretending
              // the browser called the provider.
              link(extId(t.source), fid, 'collect-indirect');
            }
          }
        });
      });
    });
  });

  // The browser stores the score writes to and reads back. The server-target
  // setting is no longer drawn: it fanned one line into every file, which said
  // "the origin is configurable" ten times over the part of the map that
  // matters most. Its card still lives on the SERVER page.
  STORE_LINKS.forEach((l) => {
    const target = fieldId(l.page, l.field);
    if (!nodes.has(target)) return; // that card is not on screen right now
    const spec = STORES[l.store];
    add({ id: l.store, kind: 'store', label: spec.label, backend: spec.backend, detail: spec.detail });
    if (l.dir === 'w') link(target, l.store, 'store-write');
    else link(l.store, target, 'store-read');
  });

  // Dedupe: two cards naming the same pair produce the same arrow.
  const seen = new Set();
  const unique = edges.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));

  return { nodes: Array.from(nodes.values()), edges: unique };
}

/* -------------------------------------------------------- collapsing ---- */

/**
 * Folds the fields of collapsed panels into their panel node.
 *
 * Collapsed is the default: ~45 boxes is a diagram, ~140 is a hairball. The
 * panel keeps every edge its fields had, which is what makes the overview
 * truthful rather than a simplification - no connection disappears, several
 * just arrive at the same box.
 */
export function collapse(graph, expandedPanels) {
  const open = expandedPanels || new Set();
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const substitute = new Map();

  // A flat field (a pipeline step) is never folded: it has no panel to fold into.
  graph.nodes.forEach((n) => {
    if (n.kind !== 'field') return;
    const pid = panelId(n.page, n.group);
    substitute.set(n.id, n.flat || open.has(pid) ? n.id : pid);
  });

  const keep = graph.nodes.filter((n) => {
    if (n.kind === 'field') return n.flat || open.has(panelId(n.page, n.group));
    if (n.kind === 'panel') return true;
    return true;
  });

  const seen = new Map();
  const edges = [];
  graph.edges.forEach((e) => {
    const from = substitute.get(e.from) || e.from;
    const to = substitute.get(e.to) || e.to;
    if (from === to) return;
    if (!byId.has(from) && !substitute.has(e.from)) return;
    const id = from + '>' + to + ':' + e.kind;
    // Every field-level edge an arrow stands for is kept on it as `parts`,
    // so hovering a panel-to-panel line can say WHICH values travel along
    // it rather than only that something does.
    const part = { from: e.from, to: e.to };
    if (seen.has(id)) { seen.get(id).parts.push(part); return; }
    const edge = { id, from, to, kind: e.kind, rolled: from !== e.from || to !== e.to, parts: [part] };
    seen.set(id, edge);
    edges.push(edge);
  });

  // An OPEN panel keeps its box and gains an arrow to each of its own
  // fields. Dropping the box instead would leave the fields unlabelled and
  // take away the only handle for closing that panel again; leaving it with
  // no edges at all would float an orphan beside the flow. As a container it
  // does both jobs: it names the group and it sits one column upstream of
  // the fields it holds.
  graph.nodes.forEach((n) => {
    if (n.kind !== 'field') return;
    const pid = panelId(n.page, n.group);
    if (!open.has(pid)) return;
    const id = pid + '>' + n.id + ':contains';
    if (seen.has(id)) return;
    const edge = { id, from: pid, to: n.id, kind: 'contains', parts: [{ from: n.id, to: n.id }] };
    seen.set(id, edge);
    edges.push(edge);
  });

  const present = new Set(keep.map((n) => n.id));
  return { nodes: keep, edges: edges.filter((e) => present.has(e.from) && present.has(e.to)) };
}

/* ------------------------------------------------------------ layout ---- */

export const SIZES = {
  provider: { w: 160, h: 30 }, file: { w: 210, h: 30 }, store: { w: 170, h: 34 },
  panel: { w: 200, h: 42 }, field: { w: 186, h: 34 },
  // A pipeline step carries its live value on the box, so it is wider.
  step: { w: 230, h: 34 },
};

export const sizeOf = (n) => (n.kind === 'field' && n.flat ? SIZES.step : SIZES[n.kind]);

const COL_GAP = 110;
const ROW_GAP = 14;
/** Room above the columns for their headers. */
const HEADER = 56;
/** Room above a run of one tab's panels for that tab's caption. */
const RUN_GAP = 26;

/** The column a display box starts at: after the five pipeline steps. */
const DISPLAY_COL = 7;

/** Edges that close a cycle, found by DFS. Dropped for layering, still drawn. */
function backEdges(nodes, edges) {
  const out = new Map();
  nodes.forEach((n) => out.set(n.id, []));
  edges.forEach((e) => { if (out.has(e.from)) out.get(e.from).push(e); });

  const state = new Map(); // 0 unvisited, 1 on stack, 2 done
  const back = new Set();
  const visit = (id) => {
    state.set(id, 1);
    (out.get(id) || []).forEach((e) => {
      const s = state.get(e.to) || 0;
      if (s === 1) back.add(e.id);
      else if (s === 0) visit(e.to);
    });
    state.set(id, 2);
  };
  nodes.forEach((n) => { if (!state.get(n.id)) visit(n.id); });
  return back;
}

/**
 * The map as a PIPELINE: fixed columns in the order the data actually moves.
 *
 *   0 SOURCES         the providers the server calls
 *   1 RAW STORE       the files it writes and the app reads
 *   2-6 PIPELINE      token list, inputs, measures, components, score
 *   7+ SHOWN ON       the dashboard panels that display the result
 *   last BROWSER      what the app saves for next time
 *
 * It used to be a longest-path layering, which put a box wherever its deepest
 * input happened to land: a panel reading one provider sat among the measures,
 * and the score's own steps were scattered over four columns. Here the column
 * IS the step, so reading left to right is reading the calculation in order.
 * Only the display panels are layered among themselves (the board's STAGE
 * reads the board's SCORE), and only within their own block of columns.
 *
 * Within a column, a few barycentre passes order boxes beside what they are
 * wired to, which is what removes most crossings. Display panels stay grouped
 * by tab, each run captioned with the tab's name.
 */
export function layout(graph) {
  const { nodes, edges } = graph;
  const back = backEdges(nodes, edges);
  const forward = edges.filter((e) => !back.has(e.id));

  const incoming = new Map(nodes.map((n) => [n.id, []]));
  const outgoing = new Map(nodes.map((n) => [n.id, []]));
  forward.forEach((e) => {
    if (incoming.has(e.to)) incoming.get(e.to).push(e.from);
    if (outgoing.has(e.from)) outgoing.get(e.from).push(e.to);
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // The BLOCK a box belongs to: one per pipeline step, plus sources, files,
  // display panels and stores.
  const blockOf = (n) => {
    if (n.kind === 'provider') return 0;
    if (n.kind === 'file') return 1;
    if (n.kind === 'store') return 8;
    // A pipeline step, or a pipeline PANEL and its fields: its step's column.
    if (n.flat || (n.page === 'pipe' && n.stage)) return 1 + (n.stage || 1);
    return DISPLAY_COL;
  };

  // Inside a block, a box that reads another box of the SAME block moves one
  // sub-column right of it. That is what lays SCORE out as the chain it is -
  // RAW -> RIGHT NOW -> FINAL -> STAGE - instead of one column whose arrows
  // double back on themselves.
  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    nodes.forEach((n) => {
      const b = blockOf(n);
      let want = 0;
      (incoming.get(n.id) || []).forEach((p) => {
        const pn = byId.get(p);
        if (pn && blockOf(pn) === b) want = Math.max(want, depth.get(p) + 1);
      });
      // Display panels are capped at three sub-columns: deeper reads exist
      // (a board total over a board column over the score) but past that the
      // block only gets wider without getting clearer.
      want = Math.min(want, b === DISPLAY_COL ? 2 : 5);
      if (want !== depth.get(n.id)) { depth.set(n.id, want); moved = true; }
    });
    if (!moved) break;
  }

  // A sortable column key: block, then sub-column.
  const colOf = (n) => blockOf(n) * 10 + (depth.get(n.id) || 0);
  const isFirstOfBlock = (k) => k % 10 === 0;
  const STORE_COL = 80;

  const columns = new Map();
  nodes.forEach((n) => {
    const c = colOf(n);
    if (!columns.has(c)) columns.set(c, []);
    columns.get(c).push(n);
  });

  const pageOrder = Object.keys(PAGE_TITLES);
  const pageIdx = (n) => (n.page ? pageOrder.indexOf(n.page) : -1);
  const grouped = (k) => Math.floor(k / 10) === DISPLAY_COL;
  columns.forEach((list, k) => {
    list.sort((a, b) => (grouped(k) ? pageIdx(a) - pageIdx(b) : 0) || a.seq - b.seq);
  });

  const order = new Map();
  const reindex = () => columns.forEach((list) => list.forEach((n, i) => order.set(n.id, i)));
  reindex();

  const sweep = (useIncoming) => {
    const keys = Array.from(columns.keys()).sort((a, b) => (useIncoming ? a - b : b - a));
    keys.forEach((k) => {
      const list = columns.get(k);
      const bary = new Map();
      list.forEach((n) => {
        const near = (useIncoming ? incoming.get(n.id) : outgoing.get(n.id)) || [];
        // Only neighbours in OTHER columns say where a box should sit.
        const vals = near.filter((id) => byId.has(id) && colOf(byId.get(id)) !== k)
          .map((id) => order.get(id)).filter((x) => x !== undefined);
        bary.set(n.id, vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : order.get(n.id));
      });
      list.sort((a, b) => (grouped(k) ? pageIdx(a) - pageIdx(b) : 0)
        || (bary.get(a.id) - bary.get(b.id)) || a.seq - b.seq);
      reindex();
    });
  };
  sweep(true); sweep(false); sweep(true);

  // Place. Columns are as wide as their widest box.
  const keys = Array.from(columns.keys()).sort((a, b) => a - b);
  const colX = new Map();
  const colW = new Map();
  let x = 0;
  keys.forEach((k) => {
    const w = Math.max(...columns.get(k).map((n) => sizeOf(n).w));
    colX.set(k, x);
    colW.set(k, w);
    x += w + COL_GAP;
  });

  // Heights first, so every column can be centred on the tallest.
  const runs = new Map(); // column -> [{ page, startIdx }]
  const colHeight = new Map();
  keys.forEach((k) => {
    const list = columns.get(k);
    let h = 0;
    let lastPage = null;
    list.forEach((n, i) => {
      if (grouped(k) && n.page !== lastPage) {
        h += RUN_GAP;
        if (!runs.has(k)) runs.set(k, []);
        runs.get(k).push({ page: n.page, index: i });
        lastPage = n.page;
      }
      h += sizeOf(n).h + (i < list.length - 1 ? ROW_GAP : 0);
    });
    colHeight.set(k, h);
  });
  const tallest = Math.max(1, ...Array.from(colHeight.values()));

  const placed = [];
  const captions = [];
  keys.forEach((k) => {
    const list = columns.get(k);
    let y = HEADER + (tallest - colHeight.get(k)) / 2;
    let lastPage = null;
    list.forEach((n) => {
      if (grouped(k) && n.page !== lastPage) {
        y += RUN_GAP;
        captions.push({
          kind: 'tab', x: colX.get(k), y: y - 16,
          text: PAGE_TITLES[n.page] || n.page, color: PAGE_COLORS[n.page],
        });
        lastPage = n.page;
      }
      const s = sizeOf(n);
      placed.push({ ...n, x: colX.get(k), y, w: s.w, h: s.h, layer: k });
      y += s.h + ROW_GAP;
    });
  });

  // One header per BLOCK, spanning all of its sub-columns.
  const head = (b) => {
    if (b === 0) return { text: 'SOURCES', sub: 'what the server fetches', color: KIND_COLORS.provider };
    if (b === 1) return { text: 'RAW STORE', sub: 'files the app reads every 5s', color: KIND_COLORS.file };
    if (b >= 2 && b <= 6) {
      const st = STAGES[b - 1];
      return { text: st.title, sub: b === 2 ? 'what gets scored' : 'for the selected token', color: st.color };
    }
    if (b === DISPLAY_COL) return { text: '6 · SHOWN ON THE DASHBOARD', sub: 'the panels that display it', color: '#e7edff' };
    if (b === STORE_COL / 10) return { text: 'SAVED IN THE BROWSER', sub: 'kept for the next visit', color: KIND_COLORS.store };
    return null;
  };
  keys.filter(isFirstOfBlock).forEach((k) => {
    const b = k / 10;
    const h = head(b);
    if (!h) return;
    const inBlock = keys.filter((c) => Math.floor(c / 10) === b);
    const last = inBlock[inBlock.length - 1];
    captions.push({ kind: 'stage', x: colX.get(k), y: 8, w: colX.get(last) + colW.get(last) - colX.get(k), ...h });
  });

  return {
    nodes: placed, edges: graph.edges, back, captions,
    width: Math.max(x - COL_GAP, 1), height: HEADER + tallest,
  };
}
