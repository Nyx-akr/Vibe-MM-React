import React from 'react';
import ReactDOM from 'react-dom';
import { buildGraph, collapse, layout, PAGE_TITLES, PAGE_COLORS, KIND_COLORS, STORES, STAGES } from './graph';
import { C, Expression, Badge, RawData, rawRecordOf, RecordView, RAW_RECORD, WorkedSteps } from './Explain';
import { showsForPanel, showsForField } from './shows';
import { SOURCE_BY_ID, fieldValues, MAP_ONLY_PAGES } from './provenance';
import { API_ORIGIN } from '../services/api';

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
  // Not a data flow - it says which box this field belongs to, and only
  // appears while its panel is open.
  contains: { dash: '1 3', label: 'inside this panel' },
};

/** One arrowhead per colour in use; SVG markers cannot inherit a stroke. */
const markerId = (color) => 'ar' + String(color).replace(/[^a-zA-Z0-9]/g, '');

// Low enough that FIT can actually fit the whole map on a narrow window - it
// was clamping at 0.18, which silently left a third of the diagram off-screen
// and made the button look broken.
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
const nodeColor = (n) => {
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
  if (n.kind !== 'field' || !n.field || !n.field.value) return null;
  let val;
  try { val = n.field.value(v); } catch (e) { return null; }
  if (val === null || val === undefined || val === '') return null;
  if (typeof val !== 'string' && typeof val !== 'number') return null;
  const s = String(val);
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
};
const iconKind = (n) => (n.kind === 'field' && n.flat ? 'step' : n.kind);

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
const boxLabelStyle = (n) => ({
  flex: 1, minWidth: 0, fontSize: n.kind === 'file' ? 8.5 : 9.5,
  fontWeight: n.kind === 'panel' ? 700 : 500,
  color: '#e7edff', lineHeight: 1.2,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: n.kind === 'file' ? 'ui-monospace, Menlo, Consolas, monospace' : 'inherit',
});

/** What KIND of box this is, in words - shown when you hover its icon. */
function subOf(n) {
  if (n.kind === 'provider') return 'provider we fetch from';
  if (n.kind === 'file') return 'file in the raw store';
  if (n.kind === 'store') return (STORES[n.id] || {}).backend || 'browser storage';
  // The double-click hint lives here now: it used to be the box's native
  // tooltip, which popped up over this one.
  if (n.kind === 'panel') return PAGE_TITLES[n.page] + ' · ' + n.count + ' fields · double-click to open';
  if (n.flat && STAGES[n.stage]) return 'score pipeline · ' + STAGES[n.stage].title;
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
        }}>{subOf(node)}</div>,
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



/**
 * Eases a map of numbers toward its target, frame by frame.
 *
 * In JS rather than in CSS because an SVG path's `d` cannot be transitioned:
 * a CSS glide would move the boxes and snap the arrows, leaving every line
 * detached from its box for the length of the animation. Driving both from
 * one number per frame keeps them together.
 */
function useTween(target) {
  const [value, setValue] = React.useState(() => new Map());
  const ref = React.useRef(new Map());
  React.useEffect(() => {
    const from = new Map(ref.current);
    const reduce = typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dur = reduce ? 0 : GROW_MS;
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    let raf = 0;
    const start = performance.now();
    const tick = (now) => {
      const t = dur ? Math.min(1, (now - start) / dur) : 1;
      const e = ease(t);
      const next = new Map();
      target.forEach((to, id) => {
        const f = from.get(id) || 0;
        next.set(id, f + (to - f) * e);
      });
      ref.current = next;
      setValue(next);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return value;
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

function Swatch({ color, label }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 8.5, color: C.dim }}>
      <span style={{
        width: 9, height: 9, borderRadius: 2, flexShrink: 0,
        border: `1px solid ${color}`, background: color + '33',
      }} />
      {label}
    </span>
  );
}

/**
 * Every colour on the canvas, named.
 *
 * It used to show four swatches while eleven colours were in use, so the
 * seven that mattered most - one per tab - had to be guessed from the boxes
 * themselves. Since a line is drawn in the colour of the box it leaves, an
 * incomplete key makes the arrows unreadable too.
 */
function Legend() {
  return (
    <div style={{
      width: '100%', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
      paddingTop: 2,
    }}>
      {/* The box TYPES, by the icon each box carries. */}
      {[
        ['provider', KIND_COLORS.provider, 'provider API'],
        ['file', KIND_COLORS.file, 'server file'],
        ['store', KIND_COLORS.store, 'browser storage'],
        ['step', '#e7edff', 'calculation step'],
        ['panel', '#e7edff', 'dashboard panel'],
      ].map(([kind, color, label]) => (
        <span key={kind} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 8.5, color: C.dim }}>
          <KindGlyph kind={kind} color={color} size={12} />{label}
        </span>
      ))}
      <span style={{ width: 1, height: 11, background: C.border }} />
      <span style={{ fontSize: 8.5, color: C.grey }}>pipeline:</span>
      <Swatch color={STAGES[2].color} label="inputs" />
      <Swatch color={STAGES[3].color} label="measures" />
      <Swatch color={STAGES[4].color} label="components" />
      <Swatch color={STAGES[5].color} label="score" />
      <span style={{ width: 1, height: 11, background: C.border }} />
      <span style={{ fontSize: 8.5, color: C.grey }}>shown on:</span>
      {Object.keys(SHORT_TAB).map((page) => (
        <Swatch key={page} color={PAGE_COLORS[page]} label={SHORT_TAB[page]} />
      ))}
      <span style={{ width: 1, height: 11, background: C.border }} />
      <span style={{ fontSize: 8.5, color: C.grey }}>
        a line takes the colour of the box it leaves &middot; dashed = storage
      </span>
    </div>
  );
}

/* --------------------------------------------------------- opened box --- */

/**
 * An opened box grows DOWNWARD AND UPWARD ONLY - it keeps the width of the
 * box it came from.
 *
 * Growing sideways made a card straddle three columns, so opening one had to
 * shove its neighbours left and right as well as up and down and the diagram
 * lost its column structure for as long as the card was open. Keeping the
 * width means an open card lives inside its own column: the column simply
 * gets taller, and nothing outside it has to move at all.
 */
// The CAP, not the size: an open card is as tall as what it holds, and only
// scrolls past this. A fixed height left a provider with one row of wiring
// as a tall empty slab.
export const CARD_H = 520;

/**
 * An open card is this wide - the reading width of the SCORE PIPELINE tab -
 * so a raw record, its highlighted keys and the wires to their outputs read the
 * same on the map as there. A box only 200px wide made all of it a squint.
 * It grows to the RIGHT and covers what is beside it; nothing moves.
 */
export const CARD_W = 400;

/** Long enough to read as the box stretching rather than as a cut. */
const GROW_MS = 700;

/**
 * The selected box, opened in place.
 *
 * It used to be a panel pinned to the right edge, which put the detail as
 * far from the thing it described as the window allows - you read a name on
 * the left and its working on the right, with the whole diagram in between.
 * Growing the box itself keeps the two together and keeps the arrows into
 * and out of it visible around the edges, so the context does not vanish
 * the moment you ask for the detail.
 *
 * It lives INSIDE the zoom transform, so it pans and scales with the map.
 * That is why selecting also lifts the zoom to a readable level: a box
 * opened at 13% would be a postage stamp.
 */
/**
 * The (?) in front of a card title, holding every sentence ABOUT the box.
 *
 * The box itself is kept for wiring, values and arithmetic; the prose that
 * used to fill it lives here. Hover shows it, a click pins it (so a link in it
 * can be reached), a second click or the x unpins.
 *
 * Rendered through a PORTAL into <body>: the card clips its overflow and sits
 * inside the zoom transform, so a popover drawn inside it would be cut off and
 * shrink with the map. Fixed to the icon's screen rectangle instead.
 */
function Info({ children, accent }) {
  const ref = React.useRef(null);
  const [hovered, setHovered] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  const leave = React.useRef(null);
  const open = hovered || pinned;
  const enter = () => { clearTimeout(leave.current); setHovered(true); };
  // A short grace period, so the pointer can cross from the icon into the
  // popover without it closing in between.
  const exit = () => { leave.current = setTimeout(() => setHovered(false), 160); };
  React.useEffect(() => () => clearTimeout(leave.current), []);

  let place = null;
  if (open && ref.current) {
    const r = ref.current.getBoundingClientRect();
    const W = 320;
    const left = Math.max(8, Math.min(window.innerWidth - W - 8, r.left));
    const below = r.bottom + 6;
    place = below > window.innerHeight - 200
      ? { left, bottom: window.innerHeight - r.top + 6, width: W }
      : { left, top: below, width: W };
  }

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={enter}
        onMouseLeave={exit}
        // Not a drag of the card, and not the canvas either.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); setPinned((p) => !p); }}
        title=""
        style={{
          width: 14, height: 14, borderRadius: '50%', flexShrink: 0, marginTop: 1,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 700, cursor: 'pointer', userSelect: 'none',
          color: pinned ? '#0a1430' : accent, background: pinned ? accent : 'transparent',
          border: `1px solid ${accent}`,
        }}>?</span>
      {place && ReactDOM.createPortal(
        <div
          onMouseEnter={enter}
          onMouseLeave={exit}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', ...place, zIndex: 60, maxHeight: '60vh', overflow: 'auto',
            background: '#0a1430f7', border: `1px solid ${accent}88`, borderRadius: 8,
            padding: '9px 11px', fontSize: 10, lineHeight: 1.6, color: C.text,
            boxShadow: '0 10px 30px #000a',
          }}>
          {pinned && (
            <div onClick={() => setPinned(false)} title="close" style={{
              float: 'right', cursor: 'pointer', color: C.faint, fontSize: 13, lineHeight: 1, marginLeft: 8,
            }}>&times;</div>
          )}
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

const MONO_STACK = 'ui-monospace, Menlo, Consolas, monospace';

/** A link that opens in a new tab - inside the popover, so it needs a pin. */
function OutLink({ url, mono }) {
  return (
    <div onClick={() => window.open(url, '_blank', 'noopener,noreferrer')} style={{
      marginTop: 8, cursor: 'pointer', fontSize: 9.5, color: C.blue, wordBreak: 'break-all',
      fontFamily: mono ? MONO_STACK : 'inherit',
    }}>{url} ↗</div>
  );
}

/** The plain-words `shows` list, flattened for the popover. */
function ShowsList({ shows, accent }) {
  const list = Array.isArray(shows) ? shows : [shows];
  return (
    <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
      {list.map((item, i) => (
        <li key={i} style={{ margin: '0 0 4px', display: 'flex', gap: 6 }}>
          <span style={{ color: accent, opacity: 0.7 }}>&bull;</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span>{typeof item === 'string' ? item : item.t}</span>
            {typeof item !== 'string' && item.sub && (
              <ul style={{ listStyle: 'none', margin: '3px 0 4px', padding: '0 0 0 10px' }}>
                {item.sub.map((s, j) => (
                  <li key={j} style={{ color: C.dim, margin: '0 0 2px' }}>&ndash; {s}</li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Which box is selected, and its neighbours - read by every open card. */
const SelCtx = React.createContext({ selected: null, near: null });

function CardShell({ node, at, grow, onDragStart, onAnchors, title, accent, onClose, info, children }) {
  const sel = React.useContext(SelCtx);
  const isSel = sel.selected === node.id;
  const isNear = Boolean(sel.near && sel.near.has(node.id));
  // Height is interpolated from the box's own height to the open one, so the
  // first frame IS the box and the last is the card. Width never changes.
  const g = grow === undefined ? 1 : grow;
  // The content's own height, measured below. The body is flex:1 and would
  // report the card's height back, so it is the INNER wrapper that is read.
  const headRef = React.useRef(null);
  const innerRef = React.useRef(null);
  const [natural, setNatural] = React.useState(CARD_H);
  React.useLayoutEffect(() => {
    if (!headRef.current || !innerRef.current) return;
    // + body padding (9 + 9, or 9 + 22 with a (?)) + border (2 x 1).
    const want = headRef.current.offsetHeight + innerRef.current.offsetHeight + (info ? 33 : 20);
    const next = Math.min(CARD_H, Math.max(node.h, want));
    if (Math.abs(next - natural) > 1) setNatural(next);
  });
  const h = node.h + (natural - node.h) * g;
  const w = node.w + (Math.max(node.w, CARD_W) - node.w) * g;
  const left = at.x;
  const top = at.y + node.h / 2 - h / 2;

  /**
   * Where each neighbour row sits, in the map's own coordinates, so the
   * arrows can be drawn to it.
   *
   * Measured from the DOM rather than calculated: the rows are laid out by
   * flow, they move as the card grows, and the body scrolls. Measured with
   * bounding boxes, divided back out of the zoom: `offsetTop` broke twice -
   * once when the (?) button came after the body (so "the last child" was no
   * longer the scrolling one), and again when the flow rows became positioned
   * boxes (so offsetTop was relative to the row block, not the card). A
   * screen-space measurement includes the scroll and any nesting for free.
   *
   * A row scrolled out of sight is clamped to the card's edge, so its arrow
   * still points at the card instead of wandering off above it.
   */
  const rootRef = React.useRef(null);
  const lastSig = React.useRef('');
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !onAnchors) return;
    const rootBox = root.getBoundingClientRect();
    // Screen pixels per map pixel: the card lives inside the zoom transform.
    const k = root.offsetHeight ? rootBox.height / root.offsetHeight : 1;
    const out = [];
    root.querySelectorAll('[data-anchor]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const mid = (r.top + r.height / 2 - rootBox.top) / (k || 1);
      const side = el.getAttribute('data-side');
      // One element can anchor SEVERAL neighbours (comma-separated): a step's
      // single result is where every one of its outgoing arrows leaves from.
      String(el.getAttribute('data-anchor')).split(',').filter(Boolean).forEach((id) => {
        out.push({
          id, side,
          y: top + Math.max(8, Math.min(h - 8, mid)),
          edgeX: side === 'in' ? left : left + w,
        });
      });
    });
    // Only report a real change, or setting state from a layout effect would
    // render, measure, and report for ever.
    const sig = out.map((a) => a.id + a.side + Math.round(a.y)).join('|');
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    onAnchors(node.id, out);
  });

  return (
    <div
      ref={rootRef}
      data-card="1"
      // The canvas pans on mousedown and zooms on wheel. Inside the box both
      // are wrong: a drag is a text selection and a wheel is a scroll.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        // Grown from the box's own centre, so it reads as that box opening
        // rather than as a dialogue that happened to appear nearby.
        left,
        // Centred on where the box was, so it opens evenly up and down.
        top,
        width: w, height: h, overflow: 'hidden', zIndex: 40,
        display: 'flex', flexDirection: 'column', cursor: 'default',
        // The canvas turns selection off for panning; a card's numbers and
        // formulas are worth copying, so it turns it back on.
        userSelect: 'text', WebkitUserSelect: 'text',
        background: 'rgba(8,14,32,.985)', borderRadius: BOX_RADIUS,
        // Selected: a solid glowing border. A neighbour of the selected box:
        // its border at full colour. Neither changes the card's size.
        border: `1px solid ${isSel || isNear ? accent : accent + BOX_STROKE}`,
        boxShadow: isSel
          ? `0 0 0 2px ${accent}, 0 0 22px ${accent}88, 0 18px 50px rgba(0,0,0,.7)`
          : (isNear ? `0 0 0 1px ${accent}, 0 18px 50px rgba(0,0,0,.7)`
            : '0 18px 50px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.05)'),
      }}
    >
      {/* The header IS the collapsed box: same height, padding, fill, icon
          and title style, so opening only adds the body beneath it. Height
          minus the card's 1px top border (the bottom border is inside it). */}
      <div
        ref={headRef}
        onMouseDown={onDragStart}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
          height: node.h - 1, boxSizing: 'border-box',
          borderBottom: `1px solid ${accent}44`, flexShrink: 0, cursor: 'grab',
          background: accent + BOX_FILL,
        }}>
        <KindIcon node={node} color={accent} />
        <span style={boxLabelStyle(node)}>{title}</span>
        <div onClick={onClose} title="close" style={{
          cursor: 'pointer', color: C.faint, fontSize: 13, lineHeight: 1, padding: '0 1px', flexShrink: 0,
        }}>&times;</div>
      </div>
      {/* Room at the bottom for the (?) when there is one, so it never sits
          on top of the last row. */}
      <div style={{ flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto', padding: info ? '9px 9px 22px' : 9 }}>
        {/* flow-root, or the first section's top margin collapses out of
            the wrapper and the measured height comes up short. */}
        <div ref={innerRef} style={{ display: 'flow-root' }}>{children}</div>
      </div>
      {info && (
        <div style={{ position: 'absolute', right: 8, bottom: 6 }}>
          {/* Always orange, whatever the box's colour - it is the one
              control on every card, so it should be found at a glance. */}
          <Info accent={KIND_COLORS.provider}>{info}</Info>
        </div>
      )}
    </div>
  );
}

/**
 * The neighbours of an open box, ONE PER ROW.
 *
 * They used to wrap as a bag of chips. One per row is what lets each arrow
 * land on the row that names it: every neighbour then has a y of its own,
 * and the line can arrive beside the name of where it came from instead of
 * at the middle of the box with eleven others.
 *
 * `side` decides which way the row faces - inputs sit against the left edge
 * where their arrows arrive, outputs against the right where theirs leave -
 * and the nub carries the line the last few pixels through the card's
 * padding, which the arrow itself cannot do: the card is opaque and painted
 * over the SVG the arrows live in.
 */
function Neighbours({ title, list, onPick, side, accent }) {
  if (!list.length) return null;
  const inbound = side === 'in';
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{
        fontSize: 8, letterSpacing: 1, fontWeight: 700, color: C.grey, marginBottom: 5,
        textAlign: inbound ? 'left' : 'right',
      }}>{title}</div>
      {list.map((n) => {
        const col = nodeColor(n);
        // The nub is the stub of the LINE, so it wears the line’s colour: a
        // line is drawn in the colour of the box it leaves, which for an input
        // is the neighbour and for an output is this box.
        const lineCol = inbound ? col : (accent || col);
        const nub = (
          <span style={{
            width: 9, height: 1, background: lineCol, flexShrink: 0, opacity: 0.85,
            marginLeft: inbound ? -9 : 0, marginRight: inbound ? 0 : -9,
          }} />
        );
        return (
          <div key={n.id + ':' + side} style={{
            display: 'flex', alignItems: 'center', margin: '0 0 3px',
            justifyContent: inbound ? 'flex-start' : 'flex-end',
          }}>
            {inbound && nub}
            <span
              data-anchor={n.id}
              data-side={side}
              onClick={() => onPick(n.id)}
              style={{
                cursor: 'pointer', fontSize: 9, padding: '2px 7px', borderRadius: 6,
                border: `1px solid ${col}55`, background: col + '14', color: col,
                maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>{n.label}</span>
            {!inbound && nub}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------- the box as a flow --- */

/**
 * An open box drawn as the flow it is: what comes IN, what happens to it,
 * what goes OUT - top to bottom, with arrows.
 *
 *     IN    [neighbour] ──── what it carries ─┐
 *           [neighbour] ──── what it carries ─┤
 *                                             ▼
 *     ┌ COMPUTED / FETCHED / ON DISK ──────────┐
 *     │ the formula, with this token's numbers │
 *     └──────────────────────────────────────── ┘
 *     ▼ = result
 *     ├───▶ [reader]  how it uses it
 *     └───▶ [reader]
 *
 * The question "where does the calculation go when there is one between the
 * input and the output" answers itself in this shape: in the MIDDLE, where
 * the data actually passes through it. A plain fetch puts its source order
 * there instead; a file puts itself there.
 *
 * Inputs stay against the LEFT edge and outputs against the RIGHT, because
 * that is where the map's own arrows arrive and leave: the chips still carry
 * `data-anchor`, so an outside line lands on the row naming its neighbour.
 * The rows sit at the top and the bottom of a content-sized card, so the
 * anchoring survives - the old FED-BY-first rule existed because a fixed-
 * height card hid the rows below the fold.
 */
function FlowRows({ side, rows, accent, onPick, title }) {
  if (!rows.length) return null;
  const inbound = side === 'in';
  return (
    <div style={{ position: 'relative', marginTop: inbound ? 4 : 0 }}>
      <div style={{
        fontSize: 7.5, letterSpacing: 1.1, fontWeight: 800, color: C.grey, marginBottom: 4,
        textAlign: inbound ? 'left' : 'right',
      }}>{title}</div>
      {/* Outputs leave along a bus on the left. Inputs have none: they are a
          plain list on the left, straight above the box they feed - a bus and
          a down-arrow there only drew a second path to the same place. */}
      {!inbound && (
        <div style={{
          position: 'absolute', top: 15, bottom: 9, width: 1.5,
          left: 3, background: accent, opacity: 0.6,
        }} />
      )}
      {rows.map((r) => {
        const col = nodeColor(r.node);
        // The nub carries the MAP's arrow through the card padding to the
        // chip, in that line's colour: an input's line is its source's colour,
        // an output's line is this box's.
        const nub = (
          <span style={{
            width: 9, height: 1, background: inbound ? col : accent, flexShrink: 0, opacity: 0.85,
            marginLeft: inbound ? -9 : 0, marginRight: inbound ? 0 : -9,
          }} />
        );
        const chip = (
          <span
            data-anchor={r.node.id}
            data-side={side}
            onClick={() => onPick(r.node.id)}
            title={r.node.label}
            style={{
              cursor: 'pointer', fontSize: 9, padding: '2px 6px', borderRadius: 6, flexShrink: 1,
              border: `1px solid ${col}55`, background: col + '14', color: col, minWidth: 0,
              maxWidth: '62%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{r.node.label}</span>
        );
        // What travels along this arrow, written ON the arrow.
        const carried = r.carries ? (
          <span style={{
            fontSize: 8.5, fontWeight: 700, color: C.white, flexShrink: 0, maxWidth: 92,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 3px',
          }} title={r.carries}>{r.carries}</span>
        ) : null;
        const line = <span style={{ flex: 1, minWidth: 6, height: 1, background: accent, opacity: 0.45 }} />;
        return inbound ? (
          <div key={r.node.id} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 3px' }}>
            {nub}{chip}{carried}
          </div>
        ) : (
          <div key={r.node.id} style={{ display: 'flex', alignItems: 'center', margin: '0 0 3px', paddingLeft: 4 }}>
            <span style={{ width: 4, height: 1, background: accent, opacity: 0.6, flexShrink: 0 }} />
            {carried}{line}
            <span style={{ fontSize: 7, color: accent, opacity: 0.8, marginRight: 2, flexShrink: 0 }}>&#9654;</span>
            {chip}{nub}
          </div>
        );
      })}
    </div>
  );
}

/** A down arrow between two parts of the flow, optionally carrying a value. */
function FlowDown({ align, accent, label, outIds }) {
  // As the box's OUTPUT node: the result carries every outgoing arrow, with a
  // line from it to the card's right edge where those arrows leave.
  const isOut = Boolean(outIds && outIds.length);
  // The output node sits on the RIGHT, beside the edge its arrows leave from,
  // with a short connecting line to that edge.
  if (isOut) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, margin: '3px 0 1px' }}>
        <span
          data-anchor={outIds.join(',')}
          data-side="out"
          style={{
            fontSize: 12, fontWeight: 800, color: C.white, padding: '1px 7px', borderRadius: 6,
            background: accent + '22', border: `1px solid ${accent}66`, flexShrink: 0,
          }}>{label}</span>
        {/* Through the body padding (9px) to the card edge. */}
        <span style={{ width: 16, height: 1.5, background: accent, opacity: 0.8, marginLeft: -5, marginRight: -9, flexShrink: 0 }} />
      </div>
    );
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5, margin: '1px 0',
      justifyContent: align === 'right' ? 'flex-end' : 'flex-start',
    }}>
      {align !== 'right' && <span style={{ fontSize: 9, color: accent, lineHeight: 1 }}>&#9660;</span>}
      {label !== null && label !== undefined && label !== '' && (
        <span style={{
          fontSize: 12, fontWeight: 800, color: C.white, padding: '1px 7px', borderRadius: 6,
          background: accent + '22', border: `1px solid ${accent}66`, flexShrink: 0,
        }}>{label}</span>
      )}
      {align === 'right' && <span style={{ fontSize: 9, color: accent, lineHeight: 1 }}>&#9660;</span>}
    </div>
  );
}

/** The middle of the flow: what happens to the data. */
function Machine({ title, accent, right, children }) {
  return (
    <div style={{
      border: `1px solid ${accent}66`, borderRadius: 6, background: accent + '0d',
      padding: '5px 7px 6px', margin: '2px 0',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 7.5, letterSpacing: 1.1, fontWeight: 800, color: accent, flex: 1 }}>{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

/**
 * `single`: the box has ONE output value (a pipeline step, a field). Then
 * there is no list of readers - the result is the output node and every
 * outgoing arrow leaves from it; who reads it is what the arrows show. A file,
 * provider or panel hands DIFFERENT data to each neighbour, so it keeps its
 * per-neighbour rows, each saying what that neighbour takes.
 */
function FlowBody({ ins, outs, accent, onPick, inTitle, outTitle, machine, result, single }) {
  const asOutput = single && result;
  return (
    <div>
      <FlowRows side="in" rows={ins} accent={accent} onPick={onPick} title={inTitle || 'IN'} />
      {machine}
      {asOutput ? (
        <FlowDown align="left" accent={accent} label={result} outIds={outs.map((r) => r.node.id)} />
      ) : (
        <>
          {(machine || result) && outs.length > 0 && <FlowDown align="left" accent={accent} label={result} />}
          {!machine && !outs.length && result && <FlowDown align="left" accent={accent} label={result} />}
          <FlowRows side="out" rows={outs} accent={accent} onPick={onPick} title={outTitle || 'OUT'} />
        </>
      )}
    </div>
  );
}

/* -------------------------------------- what travels along each arrow --- */

const flowShort = (val) => {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val !== 'string' && typeof val !== 'number') return null;
  const s = String(val);
  return s.length > 16 ? s.slice(0, 15) + '…' : s;
};

/** Every operand token a card names as an input. */
const inTokens = (field) => [].concat(field.calc || [], field.fetch || [], field.via ? [field.via] : [])
  .filter((t) => t && typeof t === 'object' && t.t && t.t !== 'op' && t.t !== 'num');

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
];
const clockOf = (path) => (FILE_CLOCK.find(([re]) => re.test(path)) || [null, null])[1];

/** A raw file, to the slot of `v.pipe.raw` holding this token's record in it. */
const FILE_SLOT = [
  [/market\.json$/, 'market'], [/trades\.json$/, 'trades'], [/history\.json$/, 'history'],
  [/intel\.json$/, 'intel'], [/reference\.json$/, 'reference'], [/ethos\.json$/, 'ethos'],
];
const slotOfPath = (path) => (FILE_SLOT.find(([re]) => re.test(path)) || [null, null])[1];

/**
 * Where each provider's answer sits inside this token's records: GoPlus is
 * `intel.goplus`, DexScreener is `market.sources.dexscreener`, and so on - the
 * keys the collector files each provider's payload under.
 */
const PROVIDER_PARTS = {
  dexscreener: [['market', 'sources.dexscreener']],
  geckoterminal: [['market', 'sources.geckoterminal'], ['trades', 'trades'], ['history', '[]']],
  jupiter: [['market', 'sources.jupiter'], ['intel', 'jupiterQuote'], ['intel', 'jupiterToken']],
  kyberswap: [['intel', 'kyberQuote']],
  goplus: [['intel', 'goplus']],
  rugcheck: [['intel', 'rugcheck']],
  honeypot: [['intel', 'honeypot']],
  cex: [['reference', 'quotes']],
  ethos: [['ethos', 'token'], ['ethos', 'profile']],
};

/**
 * Every key the pipeline reads out of one record (optionally only under one
 * prefix), wired to the step that reads it, valued with that step's value.
 * The union of the input steps' own `raw.picks`, so a file box and a provider
 * box can never claim a key no step reads.
 */
function recordReaders(allFields, slot, prefix) {
  const under = (p) => !prefix || p === prefix || p.startsWith(prefix + '.') || p.startsWith(prefix + '[');
  const picks = [];
  const outs = [];
  (allFields || []).forEach((fn) => {
    const r = fn.field && fn.field.raw;
    if (!r || r.from !== slot) return;
    const ps = (r.picks || []).filter((p) => under(p.path));
    if (!ps.length) return;
    ps.forEach((p) => picks.push({ path: p.path, to: fn.label, alt: p.alt }));
    outs.push({ label: fn.label, value: (vv) => (fn.field.value ? fn.field.value(vv) : null) });
  });
  return { picks, outs, last: slot === 'history' };
}

/* --------------------------------------------------------------- view --- */

export default function FlowChart({ v, onJumpToMirror }) {
  const wrapRef = React.useRef(null);
  const liveV = React.useRef(v);
  liveV.current = v;

  const [expanded, setExpanded] = React.useState(() => new Set());
  // A SET, not one id. Comparing two panels means having both open, and the
  // push below is what makes that readable rather than a pile.
  const [cards, setCards] = React.useState(() => new Set());
  const [hover, setHover] = React.useState(null);
  // The arrow under the pointer, and where on SCREEN the pointer is - the
  // tooltip sits outside the zoom transform so it reads at any zoom.
  const [hoverEdge, setHoverEdge] = React.useState(null);
  const [query, setQuery] = React.useState('');
  // Where the user has dragged each box, relative to where the layout put
  // it. Kept apart from the layout so a rebuild never undoes a drag, and so
  // RESET is one line rather than a re-layout.
  const [moved, setMoved] = React.useState(() => new Map());
  // Where each open card's neighbour rows are, reported by the card itself
  // after it has laid itself out. Keyed by the card, then by neighbour+side.
  const [anchors, setAnchors] = React.useState(() => new Map());
  const reportAnchors = React.useCallback((id, list) => {
    setAnchors((cur) => {
      const next = new Map(cur);
      const m = new Map();
      list.forEach((a) => m.set(a.id + ':' + a.side, a));
      next.set(id, m);
      return next;
    });
  }, []);

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

  const laid = React.useMemo(
    () => (full ? layout(collapse(full, expanded)) : null),
    [full, expanded],
  );

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
  // Every field, folded or not: a file box reads them to say which provider
  // fields land in it and which fields are read out of it.
  const allFields = React.useMemo(
    () => (full ? full.nodes.filter((n) => n.kind === 'field') : []),
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
   * How far open each card is, 0 to 1.
   *
   * Opening a box used to shove the rest of its column out of the way to
   * make room. It no longer does: the map is a map, and a box that moves
   * because something ELSE was opened is a box you then have to find again.
   * An open card simply covers what is behind it and everything else stays
   * exactly where it was - including anywhere the user dragged it to.
   */
  const growTargets = React.useMemo(() => {
    const m = new Map();
    if (laid) laid.nodes.forEach((n) => m.set(n.id, cards.has(n.id) ? 1 : 0));
    return m;
  }, [laid, cards]);

  const grow = useTween(growTargets);
  const growOf = React.useCallback((id) => grow.get(id) || 0, [grow]);

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

  const onMouseMove = (e) => {
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

  const endDrag = () => {
    if (nodeDrag.current) draggedFar.current = nodeDrag.current.far >= 4;
    nodeDrag.current = null;
    drag.current = null;
  };

  /**
   * The buttons zoom about the middle of the canvas, the way the wheel zooms
   * about the pointer. Scaling `k` on its own leaves x and y where they were,
   * so every click walked the diagram further off the screen.
   */
  const zoomBy = React.useCallback((factor) => setView((cur) => {
    const el = wrapRef.current;
    const r = el ? el.getBoundingClientRect() : { width: 900, height: 600 };
    const px = r.width / 2;
    const py = r.height / 2;
    const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, cur.k * factor));
    return { k, x: px - ((px - cur.x) / cur.k) * k, y: py - ((py - cur.y) / cur.k) * k };
  }), []);

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
  const fitted = React.useRef(false);
  React.useEffect(() => {
    if (!laid || fitted.current) return undefined;
    let raf = 0;
    const tryFit = (left) => {
      const el = wrapRef.current;
      const r = el && el.getBoundingClientRect();
      if (r && r.width > 200 && r.height > 150) { fitted.current = true; fit(); return; }
      if (left > 0) raf = requestAnimationFrame(() => tryFit(left - 1));
    };
    tryFit(120);
    return () => cancelAnimationFrame(raf);
  }, [laid, fit]);

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
  const pick = (id) => setCards((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  /**
   * Go to a box somewhere else on the map: search, and the chips inside an
   * open card. Here the jump IS the point - the target is usually off
   * screen - so this one does centre, and lifts the zoom enough to read it.
   */
  const goTo = (id) => {
    setCards((cur) => (cur.has(id) ? cur : new Set(cur).add(id)));
    // Going to a box selects it too, so its wiring lights up on arrival.
    setSelected(id);
    setView((cur) => (cur.k >= READABLE ? cur : { ...cur, k: READABLE }));
    // After the zoom has been applied, so the centring maths uses the new k.
    requestAnimationFrame(() => centreOn(id));
  };


  const togglePanel = (id) => setExpanded((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const allPanels = React.useMemo(
    () => (full ? full.nodes.filter((n) => n.kind === 'panel').map((n) => n.id) : []),
    [full],
  );

  if (!laid) {
    return <div style={{ padding: 20, color: C.dim, fontSize: 11 }}>Building the map&hellip;</div>;
  }

  // Includes the ones on their way shut, or closing would be a cut rather
  // than the reverse of opening.
  const openCards = laid.nodes.filter((n) => cards.has(n.id) || growOf(n.id) > 0.01);
  const edgesOf = (id) => laid.edges.filter((e) => e.from === id || e.to === id);

  /** The row inside an open card that this edge belongs to, if there is one. */
  const anchorFor = (cardId, otherId, side) => {
    const m = anchors.get(cardId);
    return (m && m.get(otherId + ':' + side)) || null;
  };

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* ---- toolbar ---------------------------------------------------- */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', flexWrap: 'wrap',
        borderBottom: `1px solid ${C.border}`, background: C.panel, flexShrink: 0,
      }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: C.pink }}>DATA FLOW</div>
        <span style={{ fontSize: 9, color: C.grey }}>
          {laid.nodes.length} boxes &middot; {laid.edges.length} arrows
        </span>
        {cards.size > 0 && (
          <Button onClick={() => setCards(new Set())} title="close every open box">
            CLOSE {cards.size} OPEN
          </Button>
        )}
        {moved.size > 0 && (
          <Button onClick={() => setMoved(new Map())} title="put every box back where the layout put it">
            RESET {moved.size} MOVED
          </Button>
        )}
        <div style={{ width: 1, height: 16, background: C.border }} />
        <Button onClick={() => zoomBy(1.25)} title="zoom in">+</Button>
        <Button onClick={() => zoomBy(1 / 1.25)} title="zoom out">&minus;</Button>
        <Button onClick={fit} title="fit the whole map">FIT</Button>
        <span title="scroll to zoom, drag to pan"
          style={{ fontSize: 8.5, color: C.grey, width: 34 }}>{Math.round(view.k * 100)}%</span>
        <div style={{ width: 1, height: 16, background: C.border }} />
        <Button onClick={() => setExpanded(new Set(allPanels))} active={expanded.size === allPanels.length && allPanels.length > 0}>
          EXPAND ALL
        </Button>
        <Button onClick={() => setExpanded(new Set())} active={expanded.size === 0}>COLLAPSE ALL</Button>
        <div style={{ width: 1, height: 16, background: C.border }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches && matches.size) goTo(Array.from(matches)[0]);
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder="find a panel, file or provider"
          spellCheck={false}
          style={{
            background: '#0d1730', border: `1px solid ${q ? C.pink : C.border}`, borderRadius: 999,
            color: C.text, fontFamily: 'inherit', fontSize: 10, padding: '4px 11px', width: 200, outline: 'none',
          }}
        />
        {matches && <span style={{ fontSize: 9, color: C.faint }}>{matches.size} match</span>}
        <div style={{ flex: 1 }} />
        <Legend />
      </div>

      {/* ---- canvas ----------------------------------------------------- */}
      <div
        ref={attachCanvas}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
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
        <div style={{
          position: 'absolute', left: 0, top: 0,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`,
          transformOrigin: '0 0',
        }}>
          <svg
            width={laid.width + 40} height={laid.height + 40}
            style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
          >
            <defs>
              <style>{'@keyframes vsEdgeFlow { to { stroke-dashoffset: -12; } }'}</style>
              {Array.from(new Set(laid.edges.map((e) => {
                const a = byId.get(e.from);
                return a ? nodeColor(a) : C.dim;
              }))).map((color) => (
                <marker key={color} id={markerId(color)} viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                  <path d="M 0 1 L 8 4 L 0 7 z" fill={color} />
                </marker>
              ))}
            </defs>
            {laid.edges.map((e) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              const s = EDGE_STYLE[e.kind] || EDGE_STYLE.field;
              // The box it comes OUT of decides the colour.
              const color = nodeColor(a);
              // When either end is open, the line goes to the ROW that names
              // the other end rather than to the middle of the box.
              const pa = posOf(a);
              const pb = posOf(b);
              const outA = anchorFor(a.id, b.id, 'out');
              const inB = anchorFor(b.id, a.id, 'in');
              // Eased from the box’s own centre to its row as the card opens,
              // rather than switched over at the end: a gate made every arrow
              // jump at once the moment the growth finished.
              const ga = growOf(a.id);
              const gb = growOf(b.id);
              // An open card is wider than its box: leave from the card's edge.
              const ca = { x: pa.x + a.w + (Math.max(a.w, CARD_W) - a.w) * ga, y: pa.y + a.h / 2 };
              const cb = { x: pb.x, y: pb.y + b.h / 2 };
              const p1 = outA
                ? { x: ca.x + (outA.edgeX - ca.x) * ga, y: ca.y + (outA.y - ca.y) * ga }
                : ca;
              const p2 = inB
                ? { x: cb.x + (inB.edgeX - cb.x) * gb, y: cb.y + (inB.y - cb.y) * gb }
                : cb;
              // Hovering BRIGHTENS the path it belongs to. It used to fade
              // everything else to near-invisible, which answered the question
              // by hiding the diagram rather than by pointing at part of it.
              const onPath = related && (e.from === focus || e.to === focus);
              const hot = hoverEdge && hoverEdge.id === e.id;
              // A line of the SELECTED box: lit and streaming, like a hovered one.
              const sel = Boolean(selected && (e.from === selected || e.to === selected));
              const lit = hot || sel;
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
                    strokeDasharray={s.dash || undefined}
                    markerEnd={`url(#${markerId(color)})`}
                    opacity={lit ? 1 : onPath ? 0.95 : 0.35}
                    style={lit ? { filter: `drop-shadow(0 0 3px ${color})` } : undefined}
                  />
                  {/* Data moving along a hovered or selected line, source to target. */}
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
                    style={{ cursor: 'help' }}
                    onMouseEnter={track}
                    onMouseMove={track}
                    onMouseLeave={() => setHoverEdge((cur) => (cur && cur.id === e.id ? null : cur))}
                  />
                </g>
              );
            })}

            {/* The outlines, over the arrows and under the labels. One path
                per box, drawn from posOf like everything else. */}
            <g>
              {laid.nodes.map((n) => {
                if (cards.has(n.id) || growOf(n.id) > 0.01) return null;
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
            // The opened box replaces its own collapsed one rather than
            // sitting on top of it, or the title would show through twice.
            if (cards.has(n.id) || growOf(n.id) > 0.01) return null;
            const col = nodeColor(n);
            // Only a SEARCH dims boxes - that is what a search is for. Hovering
            // leaves every box exactly as it was.
            const dim = Boolean(matches && !matches.has(n.id));
            const open = n.kind === 'panel' && expanded.has(n.id);
            const pos = posOf(n);
            return (
              <div
                key={n.id}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onMouseDown={startNodeDrag(n.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  // Letting go after a drag must not also open the box.
                  if (draggedFar.current) { draggedFar.current = false; return; }
                  pick(n.id);
                  setSelected(n.id);
                }}
                onDoubleClick={(e) => { e.stopPropagation(); if (n.kind === 'panel') togglePanel(n.id); }}
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
                  <span style={{
                    fontSize: 8, color: col, flexShrink: 0, padding: '1px 5px', borderRadius: 7,
                    border: `1px solid ${col}44`,
                  }}>{open ? 'open' : n.count}</span>
                )}
                {n.kind === 'field' && n.status && n.status !== 'live' && (
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: n.status === 'placeholder' ? C.hot : C.amber,
                  }} />
                )}
              </div>
            );
          })}

          {/* Column headers - the step each column IS - and a caption over
              each run of one tab's panels. Both come from the layout, which is
              the one place that knows where a column and a run begin. */}
          {(laid.captions || []).map((c, i) => (c.kind === 'stage' ? (
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
          {/* The opened box sits in the same coordinate space as the node it
              grew from, so panning and zooming carry it along. */}
          <SelCtx.Provider value={{ selected, near: selNear }}>
            {openCards.map((node) => (
              // Capture phase: the card stops its own clicks from reaching the
              // map, so selecting it has to happen on the way IN.
              <div key={node.id} style={{ display: 'contents' }}
                onClickCapture={() => setSelected(node.id)}>
                <NodeCard
                  node={node}
                  at={posOf(node)}
                  grow={growOf(node.id)}
                  onDragStart={startNodeDrag(node.id)}
                  onAnchors={reportAnchors}
                  edges={edgesOf(node.id)}
                  byId={byId}
                  allFields={allFields}
                  v={liveV.current}
                  onClose={() => {
                    setCards((cur) => { const next = new Set(cur); next.delete(node.id); return next; });
                  }}
                  onPick={goTo}
                  isOpen={expanded.has(node.id)}
                  onJumpToMirror={onJumpToMirror}
                />
              </div>
            ))}
          </SelCtx.Provider>
        </div>
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

function Working({ fields, v, onPick, page, bare, names, accent }) {
  if (!fields || !fields.length) return null;
  const jump = (p, label) => onPick('f:' + p + ':' + label);
  return (
    <div style={{ marginTop: bare ? 0 : 12 }}>
      {/* Inside a flow's middle block the block itself is the heading. */}
      {!bare && (
        <div style={{
          fontSize: 8, letterSpacing: 1, fontWeight: 700, color: C.grey, marginBottom: 6,
        }}>WHAT IT COMPUTES</div>
      )}
      {fields.map((f, i) => {
        let value;
        try { value = f.value ? f.value(v) : undefined; } catch (e) { value = undefined; }
        const direct = Boolean(f.fetch) && !f.calc;
        const worked = typeof f.equation === 'function';
        let eq = null;
        if (worked) { try { eq = f.equation(v); } catch (e) { eq = null; } }
        return (
          <div key={f.label + i} style={{
            marginBottom: 7, paddingBottom: 6,
            borderBottom: i === fields.length - 1 ? 'none' : `1px solid ${C.line}`,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span
                onClick={() => jump(page, f.label)}
                title="open this number on the map"
                style={{
                  cursor: 'pointer', fontSize: 9, letterSpacing: 0.6, fontWeight: 700,
                  color: C.dim, flex: 1, minWidth: 0,
                }}>{f.label}</span>
              {f.weight && <span style={{ fontSize: 8.5, color: C.faint }}>{f.weight}</span>}
              <span style={{ fontSize: 11, fontWeight: 800, color: C.white }}>
                {value === null || value === undefined || value === '' ? '\u2014' : String(value)}
              </span>
            </div>
            <div style={{ marginTop: 3 }}>
              {/* A computing panel (SCORE DECOMPOSITION): each component by its
                  formula, by NAME - the inputs and their values are the panel's
                  input rows - then this token's calculation, stopping short of
                  the value already printed beside the label. */}
              {!worked && (
                <div style={{
                  fontSize: 7.5, letterSpacing: 0.8, fontWeight: 700, color: C.grey, marginBottom: 2,
                }}>{direct ? 'FETCHED DIRECT' : 'COMPUTED'}</div>
              )}
              <Expression tokens={direct ? f.fetch : f.calc} onJump={jump} v={v} names={Boolean(names)} />
              {worked && eq && (
                <div style={{ marginTop: 4 }}>
                  <WorkedSteps text={eq} accent={accent}
                    result={typeof value === 'string' || typeof value === 'number' ? String(value) : null} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------- opened box --- */

function NodeCard({ node, at, grow, onDragStart, onAnchors, edges, byId, allFields, v, onClose, onPick, isOpen, onJumpToMirror }) {
  const upstream = edges.filter((e) => e.to === node.id).map((e) => byId.get(e.from)).filter(Boolean);
  const downstream = edges.filter((e) => e.from === node.id).map((e) => byId.get(e.to)).filter(Boolean);
  const accent = nodeColor(node);
  const vals = fieldValues(v);
  const valOf = (n) => (n && n.kind === 'field' ? flowShort(vals.get(n.page + '|' + n.label)) : null);
  const edgeTo = (from, to) => edges.find((e) => e.from === from && e.to === to);
  // A folded panel stands for several fields: name the one an arrow is for,
  // or how many it carries.
  const partLabel = (id) => String(id).split(':').slice(2).join(':');
  const partsSummary = (e, pick) => {
    const parts = (e && e.parts) || [];
    if (!parts.length) return null;
    // A generated card can be built before its label exists; it names nothing.
    const names = Array.from(new Set(parts.map((p) => partLabel(pick(p)))))
      .filter((s) => s && s !== 'undefined' && s !== 'null');
    if (!names.length) return null;
    return names.length === 1 ? names[0] : names.length + ' fields';
  };
  const jump = (page, label) => {
    const id = 'f:' + page + ':' + label;
    if (byId.has(id)) onPick(id);
    else if (onJumpToMirror) onJumpToMirror(page, label);
  };
  const tabLink = onJumpToMirror && (node.kind === 'field' || node.kind === 'panel') ? (
    <div onClick={() => onJumpToMirror(node.page, node.label)} style={{
      marginTop: 10, cursor: 'pointer', fontSize: 9.5, color: C.blue,
    }}>open on the {MAP_ONLY_PAGES.has(node.page) ? 'SCORE PIPELINE' : PAGE_TITLES[node.page]} tab &rarr;</div>
  ) : null;

  /** How a downstream box uses this one: a ref's own caption beyond the label (" ×13"), or the field it lands in. */
  const outRow = (d) => {
    if (d.kind === 'store') return { node: d, carries: 'saved' };
    if (d.kind === 'panel') return { node: d, carries: partsSummary(edgeTo(node.id, d.id), (p) => p.to) };
    if (d.kind === 'field' && d.field) {
      const t = inTokens(d.field).find((x) => x.t === 'ref' && x.page === node.page && x.field === node.label);
      const extra = t && t.label && t.label !== t.field ? t.label.replace(node.label, '').trim() : '';
      return { node: d, carries: extra || null };
    }
    return { node: d, carries: null };
  };

  /* ---- a field: in, the working, out ----------------------------------- */
  if (node.kind === 'field') {
    const card = node.field.shows
      ? node.field
      : { ...node.field, shows: showsForField(node.page, node.label) };
    let value;
    try { value = node.field.value ? node.field.value(v) : undefined; } catch (e) { value = undefined; }
    const f = card;
    const placeholder = f.status === 'placeholder';
    const live = (x) => {
      if (typeof x !== 'function') return x;
      try { return x(v); } catch (e) { return null; }
    };
    const evidence = live(f.evidence);
    const equation = live(f.equation);
    const info = (evidence || f.freshness || f.note || f.where || f.shows) ? (
      <>
        {f.shows && <ShowsList shows={f.shows} accent={accent} />}
        {evidence && <div style={{ marginTop: 6 }}>{evidence}</div>}
        {f.freshness && <div style={{ marginTop: 6, color: C.dim }}>fresh: {f.freshness}</div>}
        {f.note && (
          <div style={{
            marginTop: 6, paddingLeft: 7, borderLeft: `2px solid ${placeholder ? C.hot : C.grey}`,
            color: placeholder ? '#ff9ac8' : C.faint,
          }}>{f.note}</div>
        )}
        {f.where && (
          <div style={{ marginTop: 6, fontSize: 9, fontFamily: MONO_STACK, color: C.grey, wordBreak: 'break-all' }}>
            {f.where}
          </div>
        )}
      </>
    ) : null;

    const toks = inTokens(f);
    const ins = upstream.map((u) => {
      let carries = null;
      if (u.kind === 'field') carries = valOf(u);
      else if (u.kind === 'provider') {
        carries = toks.filter((t) => t.t === 'ext' && t.source === u.source).map((t) => t.field).filter(Boolean).join(' · ') || null;
      } else if (u.kind === 'file') {
        const t = toks.find((x) => x.t === 'api' && x.path === u.path);
        carries = (t && t.field) || 'read';
      } else if (u.kind === 'panel') carries = partsSummary(edgeTo(u.id, node.id), (p) => p.from);
      else if (u.kind === 'store') carries = 'restored';
      return { node: u, carries };
    });

    const direct = Boolean(f.fetch) && !f.calc;
    // The same card as the SCORE PIPELINE tab's: the formula, then the DATA -
    // an input step's raw record or a calculation's inputs, highlighted keys
    // wired to what they become - then this token's arithmetic.
    const raw = f.raw && rawRecordOf(f, v);
    // Inputs are near-white; a near-white highlight on a near-white key reads
    // as nothing, so the data view takes the file teal instead.
    const dataCol = accent === '#e2e8f0' ? C.teal : accent;
    // With the record on screen, the FILE is named once - on the caption right
    // above the data it delivered - and the map's arrow from that file lands
    // there. It used to be named three times: a FROM row, a VIA chip, and the
    // caption.
    const fileIn = raw ? upstream.find((u) => u.kind === 'file') || null : null;
    const anchor = fileIn ? { id: fileIn.id, color: nodeColor(fileIn) } : null;
    const flowIns = fileIn ? ins.filter((r) => r.node.id !== fileIn.id) : ins;
    // A record with ONE output is its own output node: the extracted value IS
    // the step's result, so it carries the outgoing arrows itself rather than
    // being printed a second time as "= value" below it.
    const singleOut = Boolean(raw && f.raw.outs && f.raw.outs.length === 1);
    // The result as the output node prints it, so the calculation can stop
    // short of repeating it.
    const shownValue = value === null || value === undefined || value === '' ? null
      : (typeof value === 'string' || typeof value === 'number' ? String(value) : null);
    const machine = (
      <Machine accent={accent}
        title={raw ? 'RAW RECORD \u2192 EXTRACTED' : (direct ? 'FETCHED \u00b7 first source that answers' : 'COMPUTED')}
        right={<>
          {f.weight && <span style={{ fontSize: 8.5, color: C.faint }}>{f.weight}</span>}
          <Badge status={f.status || 'live'} />
        </>}>
        {raw ? (
          <RawData field={f} v={v} accent={dataCol} anchor={anchor}
            outAnchor={singleOut ? downstream.map((d) => d.id) : null} />
        ) : (
          <>
            {/* The formula by NAME: each input's value is on its IN row already. */}
            <div style={{ fontSize: 7, letterSpacing: 1, fontWeight: 700, color: C.grey, marginBottom: 3 }}>FORMULA</div>
            <Expression tokens={direct ? f.fetch : f.calc} onJump={jump} v={v} names />
            {f.via && (
              <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ fontSize: 7.5, letterSpacing: 1, fontWeight: 700, color: C.grey }}>VIA</span>
                <Expression tokens={[f.via]} onJump={jump} v={v} />
              </div>
            )}
            {equation && (
              <div style={{ marginTop: 7, paddingTop: 5, borderTop: `1px solid ${accent}33` }}>
                <div style={{ fontSize: 7, letterSpacing: 1, fontWeight: 700, color: C.grey, marginBottom: 3 }}>
                  CALCULATION, THIS TOKEN
                </div>
                {typeof f.equation === 'function'
                  ? <WorkedSteps text={equation} accent={dataCol} result={shownValue} />
                  : <div style={{ fontSize: 9, fontFamily: MONO_STACK, color: C.faint }}>{equation}</div>}
              </div>
            )}
          </>
        )}
      </Machine>
    );

    const shown = value === null || value === undefined || value === '' ? '\u2014'
      : (typeof value === 'string' || typeof value === 'number' ? String(value) : '\u2014');
    return (
      <CardShell node={node} at={at} grow={grow} onDragStart={onDragStart} onAnchors={onAnchors}
        title={node.label} accent={accent} onClose={onClose} info={info}>
        <FlowBody ins={flowIns} outs={singleOut ? [] : downstream.map(outRow)} accent={accent} onPick={onPick}
          inTitle={direct ? 'FROM' : 'INPUTS'} machine={machine}
          result={singleOut ? null : '= ' + shown} single />
        {tabLink}
      </CardShell>
    );
  }

  /* ---- a panel: what it shows, and what is inside it ------------------ */
  if (node.kind === 'panel') {
    const shows = node.shows || showsForPanel(node.page, node.group);
    const inner = Array.from(byId.values())
      .filter((n) => n.kind === 'field' && n.page === node.page && n.group === node.group);
    const ins = upstream.map((u) => ({
      node: u,
      carries: u.kind === 'field' ? valOf(u) : partsSummary(edgeTo(u.id, node.id), (p) => p.to),
    }));
    // A pipeline panel COMPUTES its fields (SCORE DECOMPOSITION computes the
    // components); a dashboard panel only SHOWS what the pipeline computed.
    const computes = node.page === 'pipe';
    const dataCol = accent === '#e2e8f0' ? C.teal : accent;
    const machine = node.fields && node.fields.length ? (
      <Machine accent={accent}
        title={(computes ? 'COMPUTES · ' : 'SHOWS · ') + node.fields.length + (computes ? ' COMPONENTS' : ' FIELDS')}>
        <Working fields={node.fields} v={v} onPick={onPick} page={node.page} bare
          names={computes && ins.length > 0} accent={dataCol} />
      </Machine>
    ) : null;
    return (
      <CardShell node={node} at={at} grow={grow} onDragStart={onDragStart} onAnchors={onAnchors}
        title={node.label} accent={accent} onClose={onClose}
        info={shows ? <ShowsList shows={shows} accent={accent} /> : null}>
        <FlowBody ins={ins} outs={downstream.map(outRow)} accent={accent} onPick={onPick}
          inTitle="READS" outTitle="USED BY" machine={machine} />
        {isOpen && <Neighbours accent={accent} title="FIELDS" side="out" list={inner} onPick={onPick} />}
        {tabLink}
      </CardShell>
    );
  }

  /**
   * The fields each provider writes into each file, read off the cards that
   * name both - a card that says `ext(goplus, holder_count)` via `intel.json`
   * is the evidence that GoPlus's holder_count lands in that file.
   */
  const writes = (source, path) => {
    const out = new Set();
    (allFields || []).forEach((fn) => {
      const t = inTokens(fn.field || {});
      if (!t.some((x) => x.t === 'api' && x.path === path)) return;
      t.forEach((x) => { if (x.t === 'ext' && x.source === source && x.field) out.add(x.field); });
    });
    const list = Array.from(out);
    if (!list.length) return null;
    // Joined with a dot, not a comma: some field names carry commas of their own.
    return list.length > 2 ? list.slice(0, 2).join(' · ') + ' +' + (list.length - 2) : list.join(' · ');
  };

  /* ---- a provider ----------------------------------------------------- */
  if (node.kind === 'provider') {
    const src = SOURCE_BY_ID[node.source] || {};
    const info = (
      <>
        {src.provides && <div>{src.provides}</div>}
        {src.role && <div style={{ color: C.faint, marginTop: 6 }}>{src.role}</div>}
        <div style={{ marginTop: 8, fontSize: 9, color: C.dim, lineHeight: 1.7 }}>
          {src.chains && <div>chains: {src.chains}</div>}
          {src.limit && <div>rate limit: {src.limit}</div>}
          {(src.endpoints || []).map((e) => (
            <div key={e} style={{ fontFamily: MONO_STACK, color: C.faint }}>{e}</div>
          ))}
        </div>
        {src.url && <OutLink url={src.url} />}
      </>
    );
    const outs = downstream.map((d) => ({
      node: d,
      carries: d.kind === 'file' ? writes(node.source, d.path) : null,
    }));
    // What this provider answered for THIS token: its own part of the token's
    // records, each key the pipeline reads wired to the step reading it.
    const parts = (PROVIDER_PARTS[node.source] || []).map(([slot, prefix]) => ({
      slot, prefix,
      rec: v && v.pipe && v.pipe.raw ? v.pipe.raw[slot] : null,
      readers: recordReaders(allFields, slot, prefix),
    })).filter((p) => p.readers.picks.length);
    const providerMachine = parts.length ? (
      <Machine accent={accent} title="ITS ANSWER FOR THIS TOKEN → READ BY">
        {parts.map((p, i) => (
          <div key={p.slot + p.prefix} style={{ marginTop: i ? 8 : 0 }}>
            <RecordView rec={p.rec} spec={p.readers} v={v} accent={accent}
              caption={RAW_RECORD[p.slot] + ' · ' + p.prefix} />
          </div>
        ))}
      </Machine>
    ) : null;
    return (
      <CardShell node={node} at={at} grow={grow} onDragStart={onDragStart} onAnchors={onAnchors} title={node.label} accent={accent} onClose={onClose} info={info}>
        <FlowBody ins={[]} outs={outs} accent={accent} onPick={onPick} outTitle="WRITTEN INTO"
          machine={providerMachine} />
      </CardShell>
    );
  }

  /* ---- a file in the raw store ---------------------------------------- */
  if (node.kind === 'file') {
    const url = API_ORIGIN + node.path.replace('<chain>', 'solana').replace('<pool>', '<pool>');
    const info = (
      <>
        <div>
          Written by the server&rsquo;s collectors on their own clock and read by the app. The
          server never answers a request from the app and nothing the app computes is ever
          written back here.
        </div>
        {node.path.indexOf('<') === -1 && <OutLink url={url} mono />}
      </>
    );
    const ins = upstream.map((u) => ({
      node: u,
      carries: u.kind === 'provider' ? writes(u.source, node.path) : null,
    }));
    const outs = downstream.map((d) => {
      if (d.kind === 'field' && d.field) {
        const t = inTokens(d.field).find((x) => x.t === 'api' && x.path === node.path);
        return { node: d, carries: (t && t.field) || null };
      }
      if (d.kind === 'panel') return { node: d, carries: partsSummary(edgeTo(node.id, d.id), (p) => p.to) };
      return { node: d, carries: null };
    });
    const clock = clockOf(node.path);
    // This token's record in the file, every key the pipeline reads out of it
    // highlighted and wired to the step that reads it.
    const slot = slotOfPath(node.path);
    const readers = slot ? recordReaders(allFields, slot, null) : null;
    const rec = slot && v && v.pipe && v.pipe.raw ? v.pipe.raw[slot] : null;
    const machine = (
      <Machine accent={accent} title={readers && readers.picks.length ? 'THIS TOKEN IN THE FILE → READ BY' : 'ON THE SERVER’S DISK'}>
        {clock && <div style={{ fontSize: 8.5, color: C.dim, marginBottom: 4 }}>written {clock}</div>}
        {readers && readers.picks.length ? (
          <RecordView rec={rec} spec={readers} v={v} accent={accent} caption={RAW_RECORD[slot]} />
        ) : (
          <div style={{ fontSize: 9, fontFamily: MONO_STACK, color: C.text, wordBreak: 'break-all' }}>{node.path}</div>
        )}
      </Machine>
    );
    return (
      <CardShell node={node} at={at} grow={grow} onDragStart={onDragStart} onAnchors={onAnchors} title={node.label} accent={accent} onClose={onClose} info={info}>
        <FlowBody ins={ins} outs={outs} accent={accent} onPick={onPick}
          inTitle="COLLECTED FROM" outTitle="READ BY" machine={machine} />
      </CardShell>
    );
  }

  /* ---- browser storage ------------------------------------------------ */
  const spec = STORES[node.id] || {};
  return (
    <CardShell node={node} at={at} grow={grow} onDragStart={onDragStart} onAnchors={onAnchors} title={node.label} accent={accent} onClose={onClose}
      info={spec.detail ? <div>{spec.detail}</div> : null}>
      <FlowBody
        ins={upstream.map((u) => ({ node: u, carries: valOf(u) }))}
        outs={downstream.map((d) => ({ node: d, carries: 'restored' }))}
        accent={accent} onPick={onPick} inTitle="WRITTEN BY" outTitle="READ BACK BY"
        machine={<Machine accent={accent} title={(spec.backend || 'browser storage').toUpperCase()} />} />
    </CardShell>
  );
}
