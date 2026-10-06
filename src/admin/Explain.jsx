import React from 'react';
import { SOURCE_BY_ID, fieldValues } from './provenance';
import { API_ORIGIN } from '../services/api';

/**
 * The admin page's one repeated shape: a number exactly as the dashboard
 * draws it, and underneath, how it got there.
 *
 * The value is never recomputed here. Every card is handed the live viewmodel
 * the frontend renders and reads the same property out of it, so a figure on
 * this page and the same figure on the dashboard are the same object - not two
 * derivations that agree today.
 *
 * A derivation is either a FETCH - in which case there is nothing to explain
 * beyond naming the source - or a CALC, written as an expression whose
 * operands are links. An operand that is one of our own fields navigates to
 * its tab and blinks it; an operand that is an outside provider shows its
 * documentation on hover. Prose goes stale; a link you can follow does not.
 */

export const C = {
  bg: '#03060f', panel: '#0a1226', border: '#1c2a4d', line: '#16223f',
  text: '#dfe6f6', dim: '#8b96b8', faint: '#6b7699', grey: '#3a4568',
  blue: '#4d8dff', pink: '#e35ff2', hot: '#ff4fae', white: '#ffffff',
  teal: '#4fd6c1', amber: '#ffbe4d',
};

const MONO = 'ui-monospace, Menlo, Consolas, monospace';

/**
 * The blink a jumped-to field answers with.
 *
 * Three pulses of a white ring, the same "here" signal the dashboard uses when
 * a toast opens its card - white rather than an accent, so it reads as a
 * location and never as a change of state.
 */
const PING_CSS = `
@keyframes vsAdminPing {
  0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); border-color: #1c2a4d; }
  50%      { box-shadow: 0 0 0 3px rgba(255,255,255,.55); border-color: #ffffff; }
}`;

/**
 * How much of the number is real.
 *
 * This is the point of the page. A dashboard draws a hard-coded constant with
 * exactly the same weight as a measured one, and there is no way to tell them
 * apart by looking - so every card states which it is.
 */
const STATUS = {
  live: { fg: C.teal, bg: '#0b2320', label: 'MEASURED' },
  partial: { fg: C.amber, bg: '#2a2010', label: 'FALLS BACK TO A CONSTANT' },
  placeholder: { fg: C.hot, bg: '#2a0f1f', label: 'HARD-CODED' },
  pending: { fg: C.faint, bg: '#141c33', label: 'NOT YET RESOLVED' },
  unmeasured: { fg: C.grey, bg: '#121829', label: 'NO PROVIDER ANSWERED' },
};

const show = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return String(value);
  return value;
};

export function Badge({ status }) {
  const s = STATUS[status] || STATUS.pending;
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, letterSpacing: 0.8, padding: '2.5px 7px',
      borderRadius: 10, background: s.bg, color: s.fg, whiteSpace: 'nowrap',
    }}>{s.label}</span>
  );
}

/* ------------------------------------------------------------ operands -- */

/** The floating card an outside operand shows on hover. Fixed, so nothing clips it. */
function Hover({ at, title, url, lines }) {
  if (!at) return null;
  return (
    <div style={{
      position: 'fixed', top: at.top, left: at.left, zIndex: 80, pointerEvents: 'none',
      maxWidth: 330, background: 'rgba(13,23,48,.98)', border: `1px solid ${C.grey}`,
      borderRadius: 8, padding: '8px 10px', boxShadow: '0 8px 24px rgba(0,0,0,.6)',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: C.white, marginBottom: 3 }}>{title}</div>
      <div style={{ fontSize: 9, color: C.blue, fontFamily: MONO, wordBreak: 'break-all' }}>{url}</div>
      {(lines || []).filter(Boolean).map((l, i) => (
        <div key={i} style={{ fontSize: 9, color: C.dim, marginTop: 4, lineHeight: 1.5 }}>{l}</div>
      ))}
      <div style={{ fontSize: 8.5, color: C.grey, marginTop: 5 }}>click to open in a new tab</div>
    </div>
  );
}

const pill = (fg, bd, bg) => ({
  display: 'inline-flex', alignItems: 'center', gap: 4,
  fontSize: 9.5, fontFamily: MONO, lineHeight: 1.5, padding: '1.5px 7px',
  borderRadius: 6, border: `1px solid ${bd}`, background: bg, color: fg,
  // Wraps rather than running off the edge: on the map an operand sits in a
  // card ~200px wide, and "GeckoTerminal · trending pools per chain" does not fit
  // on one line there. On the wide mirror pages it still sits on one line.
  cursor: 'pointer', whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: '100%',
  minWidth: 0, boxSizing: 'border-box',
});

/** Long values would push the arithmetic off the card; the name still links. */
const shortValue = (val) => {
  const s = typeof val === 'number' ? String(val) : String(val);
  return s.length > 26 ? s.slice(0, 25) + '\u2026' : s;
};

/** One operand of an expression, or one chip in the FEEDS row. */
function Operand({ token, onJump, values, names }) {
  const [at, setAt] = React.useState(null);
  const enter = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    // Below the chip, clamped so a chip at the right edge does not push the
    // card off screen.
    setAt({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 350) });
  };
  const leave = () => setAt(null);

  if (typeof token === 'string') {
    return <span style={{ fontSize: 9.5, color: C.dim }}>{token}</span>;
  }

  if (token.t === 'op') {
    return <span style={{ fontSize: 9.5, fontFamily: MONO, color: C.faint }}>{token.s}</span>;
  }

  if (token.t === 'num') {
    return <span style={{ fontSize: 9.5, fontFamily: MONO, color: C.amber }}>{token.s}</span>;
  }

  // `names`: the formula by NAME only, for a card whose inputs are already on
  // screen with their values - printing "RIGHT NOW = 57" again inside the
  // formula said the same input twice.
  if (token.t === 'ref' && names) {
    return (
      <span
        onClick={(e) => { e.stopPropagation(); if (onJump) onJump(token.page, token.field); }}
        style={{ fontSize: 9.5, fontFamily: MONO, fontWeight: 700, color: '#8ab6ff', cursor: 'pointer' }}
      >{token.label}</span>
    );
  }

  // Ours: navigate to that tab and blink the field.
  if (token.t === 'ref') {
    // Printed with what it says RIGHT NOW, so the expression is arithmetic you
    // can follow rather than a shape you have to go and look up a term at a
    // time. The value is that field’s own value(v) - the same call its card
    // makes - so the two can never disagree.
    const val = values ? values.get(token.page + '|' + token.field) : undefined;
    return (
      <span
        onClick={(e) => { e.stopPropagation(); if (onJump) onJump(token.page, token.field); }}
        title={'go to ' + token.page.toUpperCase() + ' → ' + token.field}
        style={pill('#8ab6ff', '#2a4a86', '#0e2a5c')}
      >
        <span style={{ opacity: 0.65, fontSize: 8.5 }}>&#8623;</span>{token.label}
        {val !== undefined && (
          <span style={{ color: C.white, fontWeight: 700 }}>
            <span style={{ opacity: 0.5, fontWeight: 400 }}> = </span>{shortValue(val)}
          </span>
        )}
      </span>
    );
  }

  // Outside: show the documentation on hover, open it on click.
  if (token.t === 'ext') {
    const src = SOURCE_BY_ID[token.source] || { label: token.source, url: '' };
    return (
      <>
        <span
          onMouseEnter={enter} onMouseLeave={leave}
          onClick={(e) => {
            e.stopPropagation();
            if (src.url) window.open(src.url, '_blank', 'noopener,noreferrer');
          }}
          style={pill(C.amber, '#4a3a16', '#241d0e')}
        >
          <span style={{ opacity: 0.7, fontSize: 8.5 }}>&#8599;</span>
          {src.label}{token.field ? ' · ' + token.field : ''}
        </span>
        <Hover at={at} title={src.label} url={src.url}
          lines={[src.endpoints && src.endpoints.join('  '), src.limit, src.chains]} />
      </>
    );
  }

  // Ours, but a raw-store file rather than a field: the live file on whichever
  // store is in use, so clicking it shows the actual payload behind the number.
  // Per-chain files name <chain>; the link opens Solana's as the example.
  if (token.t === 'api') {
    const url = (API_ORIGIN || '') + token.path.replace('<chain>', 'solana');
    return (
      <>
        <span
          onMouseEnter={enter} onMouseLeave={leave}
          onClick={(e) => { e.stopPropagation(); window.open(url, '_blank', 'noopener,noreferrer'); }}
          style={pill(C.teal, '#1d4a44', '#0b2320')}
        >
          <span style={{ opacity: 0.7, fontSize: 8.5 }}>&#8599;</span>
          {token.path}{token.field ? ' · ' + token.field : ''}
        </span>
        <Hover at={at} title={'raw store'} url={url}
          lines={['Raw file, exactly as the collector wrote it and the app reads it. ' +
            'Per-chain files open the Solana copy.']} />
      </>
    );
  }

  return null;
}

/** An expression: operands laid out inline, wrapping like a sentence. */
export function Expression({ tokens, onJump, v, names }) {
  if (!tokens || !tokens.length) return null;
  const values = fieldValues(v);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 5px' }}>
      {tokens.map((t, i) => <Operand key={i} token={t} onJump={onJump} values={values} names={names} />)}
    </div>
  );
}

/* --------------------------------------------- the worked calculation --- */

/**
 * A step's arithmetic with this token's numbers, laid out as a calculation -
 * one line per step, each continuation starting with its `=` or `→` - rather
 * than as one run-on sentence.
 *
 * The pipeline's equations end with "· score used N", the model's own number
 * as a cross-check. When it agrees with the result it only repeats the output,
 * so it is dropped; when it disagrees it is the one thing worth reading, so it
 * is kept as a warning.
 */
export function WorkedSteps({ text, accent, result }) {
  if (!text) return null;
  let body = String(text);
  let warn = null;
  const check = body.match(/^(.*?)\s*·\s*score used\s+(\S+)\s*$/);
  if (check) {
    body = check[1];
    const tail = body.match(/(?:=|→)\s*([^=→]+?)\s*$/);
    if (tail && String(tail[1]).trim() !== check[2]) warn = 'the score used ' + check[2];
  }
  const pending = /pending - no input yet\s*$/.test(body);
  // Split on the top-level step markers, keeping each marker with what follows.
  let steps = body.split(/\s+(?=[=→]\s)/).map((s) => s.trim()).filter(Boolean);
  // The last step's value IS the card's result, shown right below as its
  // output node - so the calculation stops before it instead of printing the
  // same number twice.
  if (result !== undefined && result !== null && steps.length > 1) {
    const last = steps[steps.length - 1].slice(1).trim();
    if (last === String(result).trim()) steps = steps.slice(0, -1);
  }
  return (
    <div style={{ fontFamily: MONO, fontSize: 10, lineHeight: 1.6, color: C.text }}>
      {steps.map((s, i) => {
        const last = i === steps.length - 1 && steps.length > 1;
        return (
          <div key={i} style={{
            paddingLeft: i ? 10 : 0,
            color: last ? C.white : C.text, fontWeight: last ? 800 : 500,
          }}>
            {i > 0 && <span style={{ color: accent || C.teal, marginRight: 4 }}>{s.charAt(0)}</span>}
            {i > 0 ? s.slice(1).trim() : s}
          </div>
        );
      })}
      {warn && !pending && (
        <div style={{ color: C.hot, fontSize: 9, marginTop: 2 }}>&#9888; {warn} - the working above is out of date</div>
      )}
    </div>
  );
}

/* ---------------------------------------------------- the raw record --- */

/**
 * Where each raw record comes from, for the block's caption. Keys are the
 * `raw.from` names a pipeline field uses and the slots of `v.pipe.raw`.
 */
export const RAW_RECORD = {
  marketFile: '/raw/<chain>/market.json',
  market: '/raw/<chain>/market.json → rows[ this token ]',
  trades: '/raw/<chain>/trades.json → pools[ this pool ]',
  history: '/raw/<chain>/history.json → samples[ this pool ]',
  intel: '/raw/<chain>/intel.json → tokens[ this token ]',
  reference: '/raw/reference.json → symbols[ quote token ]',
  ethos: '/raw/ethos.json → tokens + handles',
  perps: '/raw/perps.json → symbols[ this ticker ] + venues',
  promotion: '/raw/<chain>/promotion.json → rows[ this token ]',
};

/** This field's raw record for the selected token, or null. */
export const rawRecordOf = (field, v) =>
  (field && field.raw && v && v.pipe && v.pipe.raw ? v.pipe.raw[field.raw.from] || null : null);

/** A value as it reads inside the record: quoted strings, short numbers. */
const brief = (val) => {
  if (val === null) return 'null';
  if (val === undefined) return '—';
  if (Array.isArray(val)) return '[' + val.length + ']';
  if (typeof val === 'object') return '{…}';
  if (typeof val === 'string') return '"' + (val.length > 18 ? val.slice(0, 17) + '…' : val) + '"';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return String(val);
    const a = Math.abs(val);
    return a >= 1000 ? String(Math.round(val * 100) / 100) : String(Number(val.toPrecision(5)));
  }
  return String(val);
};

/**
 * The record as lines of a JSON tree, keeping only what the reader needs to
 * see: every key ON a path to an extracted value, the extracted value itself,
 * and a few of its siblings so it is visibly a field of a real record rather
 * than a lone number. An array shows its length and one element - the first,
 * or the newest for a time series - with `[]` in the path standing for "each".
 */
function recordLines(rec, picks, last, plain) {
  // `plain`: the values are already display strings (a step's inputs), not JSON.
  const fmt = (x) => (plain && typeof x === 'string' ? x : brief(x));
  const paths = picks.map((p) => p.path);
  // 'sources.dexscreener.liquidityUsd' -> 'sources.dexscreener';
  // 'trades[].usd' -> 'trades[]'; '[].buys5m' -> '[]'.
  const parentOf = (p) => { const i = p.lastIndexOf('.'); return i > 0 ? p.slice(0, i) : ''; };
  const onPath = (P) => paths.some((p) => p === P || p.startsWith(P + '.') || p.startsWith(P + '[]'));
  const leafParent = (P) => paths.some((p) => parentOf(p) === P);
  const lines = [];
  const walk = (val, P, key, depth) => {
    if (Array.isArray(val)) {
      const at = last ? val.length - 1 : 0;
      lines.push({ depth, key, text: '[ ' + val.length + (val.length ? ' · [' + at + '] shown ]' : ' ]'),
        path: P, pick: paths.includes(P) });
      if (val.length && onPath(P + '[]')) walk(val[at], P + '[]', '[' + at + ']', depth + 1);
      return;
    }
    if (val && typeof val === 'object') {
      if (key !== null) lines.push({ depth, key, text: '', path: P });
      const inner = key !== null ? depth + 1 : depth;
      let extra = 0;
      let hidden = 0;
      const lp = leafParent(P);
      Object.keys(val).forEach((k) => {
        const cp = P ? P + '.' + k : k;
        if (onPath(cp)) walk(val[k], cp, k, inner);
        else if (lp && extra < 4) { extra += 1; lines.push({ depth: inner, key: k, text: fmt(val[k]), path: cp, dim: true }); }
        else hidden += 1;
      });
      // Counted only where siblings are listed: an ancestor's count stacked one
      // '… n more' line per level under the record, which read as noise.
      if (hidden && lp) lines.push({ depth: inner, key: null, text: '… ' + hidden + ' more', dim: true });
      return;
    }
    lines.push({ depth, key, text: fmt(val), path: P, pick: paths.includes(P) });
  };
  walk(rec, '', null, 0);
  return lines;
}

/**
 * One raw record with the keys the app extracts HIGHLIGHTED, each wired by a
 * line to the output it becomes, with that output's value beside its label.
 *
 * The point is data over description: what an input step "is" is a handful of
 * keys out of a real JSON record, so that is what is drawn. An `alt` pick is a
 * fallback (the `else` in the code) and is drawn dashed. Output values are READ
 * from the scored row - the record shows where they came from, never a second
 * computation of them.
 */
export function RawData({ field, v, accent, anchor, outAnchor }) {
  if (!field || !field.raw) return null;
  return (
    <RecordView rec={rawRecordOf(field, v)} spec={field.raw} v={v} accent={accent}
      caption={RAW_RECORD[field.raw.from]} anchor={anchor} outAnchor={outAnchor} />
  );
}

/**
 * The record-and-wires view itself, for any record: a raw one, a file's, a
 * provider's part of one.
 *
 * `anchor` - { id, color } of the map box this record arrives FROM (its raw
 * file). The caption then carries `data-anchor`, so the map's incoming arrow
 * lands on the line naming the file, right above the data it delivered, and a
 * stub carries that arrow in from the card's left edge.
 */
/**
 * `perLine`: the record IS the outputs.
 *
 * A raw file does not compute anything - it holds values, and different boxes
 * read different keys out of it. Drawing that as a list of READER NAMES at the
 * bottom, wired back up the gutter to the keys, said "two fields" and made you
 * trace a wire to find out which. With `perLine` every leaf of the record
 * carries its own output node instead, so the key IS the port and an arrow
 * leaves the line it belongs to.
 *
 * A leaf nothing reads still gets a dot, hollow and dim: the file does hold
 * that value, and the card should not imply it is absent just because no box
 * takes it yet. Only a leaf something reads is given an anchor, so only those
 * grow a real arrow.
 */
export function RecordView({ rec, spec, v, accent, caption, empty, anchor, outAnchor, perLine, waiting }) {
  const wrapRef = React.useRef(null);
  const [geo, setGeo] = React.useState(null);
  const col = accent || C.teal;
  // `outAnchor`: ids of the map boxes this record's ONE output feeds.
  const asOutput = Boolean(outAnchor && outAnchor.length && (spec.outs || []).length === 1);
  const picks = (spec.picks || []);
  const lines = rec ? recordLines(rec, picks, spec.last, spec.plain) : [];
  const drawn = new Set(lines.filter((l) => l.pick).map((l) => l.path));

  /**
   * Which ROW carries each pick's output port.
   *
   * A pick names a leaf like `sources.dexscreener.volumeUsd.h24`, but the
   * record is trimmed - that leaf may be folded into a `volumeUsd: {…}` line,
   * or not drawn at all. A port registered against a path with no row leaves
   * its arrow with nothing to anchor to, and the line then falls back to the
   * middle of the card, which is what made some arrows point at no value.
   *
   * So each pick is hosted by the DEEPEST row that is its own path or an
   * ancestor of it. Every pick gets a real row; a folded branch carries the
   * ports of everything inside it.
   */
  const rowPaths = perLine ? lines.map((l) => l.path).filter(Boolean) : [];
  const hostOf = (path) => {
    if (!perLine) return null;
    let best = null;
    rowPaths.forEach((rp) => {
      if (rp === path || path.startsWith(rp + '.') || path.startsWith(rp + '[')) {
        if (!best || rp.length > best.length) best = rp;
      }
    });
    return best;
  };
  // row path -> the anchor keys it carries
  const portsByRow = {};
  if (perLine) {
    picks.forEach((p) => {
      if (!p.toId) return;
      const host = hostOf(p.path);
      if (!host) return;
      const key = p.path + '>' + p.toId;
      if (!portsByRow[host]) portsByRow[host] = new Set();
      portsByRow[host].add(key);
    });
  }
  const outs = (spec.outs || []).map((o) => {
    let val = null;
    try { val = o.value(v, rec); } catch (e) { val = null; }
    return { ...o, val, from: picks.filter((p) => p.to === o.label && drawn.has(p.path)) };
  });

  // Where each highlighted key and each output row sits, so the wires can be
  // drawn between them. In card-local pixels: the card may be zoomed.
  React.useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const box = wrap.getBoundingClientRect();
    const k = wrap.offsetWidth ? box.width / wrap.offsetWidth : 1;
    const local = (el) => {
      const r = el.getBoundingClientRect();
      return { y: (r.top + r.height / 2 - box.top) / k, x: (r.right - box.left) / k };
    };
    const keyAt = {};
    wrap.querySelectorAll('[data-pick]').forEach((el) => { keyAt[el.getAttribute('data-pick')] = local(el); });
    const outAt = {};
    wrap.querySelectorAll('[data-out]').forEach((el) => { outAt[el.getAttribute('data-out')] = local(el); });
    const w = wrap.offsetWidth;
    const segs = [];
    let lane = 0;
    outs.forEach((o) => {
      o.from.forEach((p) => {
        const a = keyAt[p.path];
        const b = outAt[o.label];
        if (a && b) segs.push({ y0: a.y, y1: b.y, lane: lane % 5, alt: Boolean(p.alt) });
        lane += 1;
      });
    });
    const sig = w + '|' + segs.map((s) => Math.round(s.y0) + ':' + Math.round(s.y1) + ':' + s.lane).join(',');
    if (!geo || geo.sig !== sig) setGeo({ sig, w, h: wrap.offsetHeight, segs });
  });

  if (!rec) {
    return (
      <div style={{ fontSize: 8.5, color: C.grey, fontFamily: MONO }}>
        {empty || ((caption || 'raw record') + ': not in the file for this token yet')}
      </div>
    );
  }

  // No wires to route when each line carries its own port.
  const GUTTER = perLine ? 13 : 22;
  return (
    <div ref={wrapRef} style={{ position: 'relative', paddingRight: GUTTER }}>
      <div
        data-anchor={anchor ? anchor.id : undefined}
        data-side={anchor ? 'in' : undefined}
        style={{
          position: 'relative', fontSize: anchor ? 8.5 : 7.5, fontFamily: MONO, marginBottom: 3,
          wordBreak: 'break-all', color: anchor ? (anchor.color || C.teal) : C.grey,
          fontWeight: anchor ? 700 : 400,
        }}>
        {/* The stub of the incoming arrow, from the card's left edge to here. */}
        {anchor && (
          <span style={{
            // 17px = the card body's padding (9) + the middle block's border
            // and padding (1 + 7): exactly to the card's left edge.
            position: 'absolute', left: -17, top: '50%', width: 15, height: 1,
            background: anchor.color || C.teal, opacity: 0.85,
          }} />
        )}
        {anchor && <span style={{ fontSize: 7, marginRight: 3 }}>&#9654;</span>}
        {caption}
      </div>
      <div style={{
        fontFamily: MONO, fontSize: 8.5, lineHeight: 1.55, background: '#070e22',
        border: `1px solid ${C.line}`, borderRadius: 5, padding: '4px 5px',
        // The shape with no values in it yet: same card, dimmer.
        opacity: waiting ? 0.72 : 1,
      }}>
        {lines.map((l, i) => {
          // A leaf is a line with a key AND a value; an object or array header
          // is a title, and a title is not a port.
          // A row shows a port when it has a key AND either a value of its
          // own or ports folded inside it.
          const isLeaf = perLine && l.key !== null &&
            (l.text !== '' || Boolean(l.path && portsByRow[l.path]));
          // One anchor per KEY→READER link, not per reader. Several keys of
          // this record feed the same box; anchoring them all on that box's
          // id made them fight over one anchor point and only the last won,
          // which is why the lines appeared to leave from nowhere in
          // particular. The key names the link, so each line leaves its key.
          //
          // A row that folds a branch away carries the ports of what is inside
          // it, so no arrow is left without a row to land on.
          const readers = perLine && l.path && portsByRow[l.path]
            ? Array.from(portsByRow[l.path]) : [];
          return (
            <div key={i} data-pick={l.pick ? l.path : undefined} style={{
              position: isLeaf ? 'relative' : undefined,
              paddingLeft: l.depth * 8, paddingRight: isLeaf ? 10 : 0,
              whiteSpace: 'nowrap', overflow: isLeaf ? 'visible' : 'hidden', textOverflow: 'ellipsis',
              background: l.pick ? col + '2e' : 'transparent', borderRadius: 3,
              color: l.dim ? C.grey : C.dim, fontWeight: l.pick ? 700 : 400,
            }}>
              {l.key !== null && <span style={{ color: l.pick ? col : (l.dim ? C.grey : '#8ab6ff') }}>{l.key}</span>}
              {l.key !== null && <span style={{ color: C.grey }}>: </span>}
              <span style={{ color: l.pick ? C.white : undefined }}>{l.text}</span>
              {isLeaf && (
                <span
                  data-anchor={readers.length ? readers.join(',') : undefined}
                  data-side={readers.length ? 'out' : undefined}
                  title={readers.length ? 'read by ' + picks.filter((p) => p.path === l.path).map((p) => p.to).join(', ')
                    : 'in the file, read by nothing yet'}
                  style={{
                    position: 'absolute', right: -6, top: '50%',
                    transform: 'translate(50%, -50%)',
                    width: 7, height: 7, borderRadius: '50%', boxSizing: 'border-box',
                    background: readers.length ? col : 'transparent',
                    border: '1px solid ' + (readers.length ? col : C.grey),
                    boxShadow: readers.length ? '0 0 0 2px #070e22' : undefined,
                  }}>
                  {/* The arrow stops at the card's edge, because the card is
                      opaque and the arrow layer is beneath it. This carries
                      the line the rest of the way in, so it arrives AT the
                      dot: the record's gutter (13) plus the card body's
                      padding (9), less the dot's own radius. */}
                  {readers.length ? (
                    <span style={{
                      position: 'absolute', left: '100%', top: '50%',
                      width: 19, height: 1.5, marginTop: -0.75,
                      background: col, opacity: 0.85,
                    }} />
                  ) : null}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 6, display: perLine ? 'none' : 'flex', flexDirection: 'column', gap: 3 }}>
        {outs.map((o) => (
          <div key={o.label} data-out={o.label}
            // The single output row IS the card's output node when asked to be:
            // every outgoing map arrow leaves from it.
            data-anchor={asOutput ? outAnchor.join(',') : undefined}
            data-side={asOutput ? 'out' : undefined}
            style={{
              position: 'relative',
              display: 'flex', alignItems: 'baseline', gap: 6, padding: '2px 6px', borderRadius: 5,
              border: `1px solid ${col}${asOutput ? 'aa' : '55'}`, background: col + (asOutput ? '22' : '14'),
            }}>
            <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: col, flex: 1, minWidth: 0 }}>{o.label}</span>
            <span style={{ fontSize: asOutput ? 12 : 10, fontWeight: 800, color: C.white, whiteSpace: 'nowrap' }}>
              {o.val === null || o.val === undefined || o.val === '' ? '—' : String(o.val)}
            </span>
            {/* Out to the card edge: this view's gutter (22) + the middle
                block's padding and border (8) + the body's padding (9). */}
            {asOutput && (
              <span style={{
                position: 'absolute', left: '100%', top: '50%', width: 39, height: 1.5,
                background: col, opacity: 0.8,
              }} />
            )}
          </div>
        ))}
      </div>
      {/* The wires: out of a highlighted key, down the right gutter, into the
          output it becomes. One lane per wire so they do not sit on each other. */}
      {geo && !perLine && (
        <svg width={geo.w} height={geo.h} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none', overflow: 'visible' }}>
          {geo.segs.map((s, i) => {
            const x0 = geo.w - GUTTER;
            const lx = geo.w - GUTTER + 5 + s.lane * 3.4;
            return (
              <g key={i}>
                <path d={`M ${x0} ${s.y0} H ${lx} V ${s.y1} H ${x0 + 2}`} fill="none" stroke={col}
                  strokeWidth={1.2} opacity={0.85} strokeDasharray={s.alt ? '3 2' : undefined} />
                {/* No arrowhead into an output node: the wire joins its line out. */}
                {!asOutput && <path d={`M ${x0 + 2} ${s.y1} l 4 -2.6 v 5.2 z`} fill={col} />}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- card --- */

/** One labelled line of the lineage block. */
function Line({ k, children, mono, color }) {
  if (children === null || children === undefined || children === '' ||
    (Array.isArray(children) && !children.length)) return null;
  return (
    <div style={{ display: 'flex', gap: 8, padding: '2.5px 0', alignItems: 'baseline' }}>
      <div style={{
        width: 58, flexShrink: 0, fontSize: 8, letterSpacing: 0.9, fontWeight: 700,
        color: C.grey, textTransform: 'uppercase',
      }}>{k}</div>
      <div style={{
        flex: 1, minWidth: 0, fontSize: 9.5, lineHeight: 1.55, color: color || C.dim,
        fontFamily: mono ? MONO : 'inherit',
      }}>{children}</div>
    </div>
  );
}

/**
 * The card, in three bands:
 *
 *   1. what it is    - the caption, the plain-words line, the value. This is
 *                      the dashboard's own tile, plus the sentence the
 *                      dashboard has no room for.
 *   2. the working   - a tinted block holding the expression or the source.
 *                      Tinted rather than another flat row, because it is the
 *                      one part you are meant to read left-to-right.
 *   3. the wiring    - what reads it next, the caveat, and the file.
 */
/**
 * `bare` drops every sentence ABOUT the number - evidence, freshness, note,
 * where, the plain-words gloss - and keeps the value and its arithmetic.
 * DATA FLOW passes it and shows those words behind a (?) beside the title,
 * so an open box holds numbers and working rather than prose.
 */
export function FieldCard({ field, value, onJump, pinged, id, v, bare }) {
  const status = field.status || 'live';
  const direct = Boolean(field.fetch) && !field.calc;
  // `equation` and `evidence` may be functions of the viewmodel: the score
  // pipeline prints its arithmetic with this token's live numbers plugged in.
  const live = (x) => {
    if (typeof x !== 'function') return x;
    try { return x(v); } catch (e) { return null; }
  };
  const equation = live(field.equation);
  const evidence = live(field.evidence);
  const worked = typeof field.equation === 'function';
  const shows = field.shows
    ? (Array.isArray(field.shows) ? field.shows : [field.shows])
    : null;

  return (
    <div id={id} style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
      padding: '10px 12px 9px', display: 'flex', flexDirection: 'column',
      // Three pulses, then it settles back to the resting border.
      animation: pinged ? 'vsAdminPing .62s ease-in-out 3' : 'none',
      scrollMarginTop: 70,
    }}>
      {/* --- 1. what it is --------------------------------------------- */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 9, letterSpacing: 1.2, color: C.dim, fontWeight: 600, flex: 1 }}>
          {field.label}
          {field.sublabel && (
            <span style={{ color: C.grey, letterSpacing: 0.4 }}> &middot; {field.sublabel}</span>
          )}
        </div>
        {field.weight && <span style={{ fontSize: 9, color: C.faint }}>{field.weight}</span>}
        <Badge status={status} />
      </div>

      <div style={{
        fontSize: 17, fontWeight: 700, marginTop: 3, lineHeight: 1.25,
        color: status === 'placeholder' ? C.hot : status === 'live' ? C.white : C.dim,
        wordBreak: 'break-word',
      }}>{show(value)}</div>

      {/* --- 2. the working -------------------------------------------- */}
      <div style={{
        marginTop: 9, padding: '7px 9px', borderRadius: 8,
        background: '#0d1730', border: `1px solid ${C.line}`,
      }}>
        <div style={{
          fontSize: 7.5, letterSpacing: 1, fontWeight: 700, color: C.grey,
          marginBottom: 5, textTransform: 'uppercase',
        }}>
          {/* A fetched value has no working to show - naming the source IS the
              explanation, and saying so is more honest than dressing it up as
              a formula. */}
          {direct ? 'fetched direct · nothing computed' : 'computed'}
        </div>
        <Expression tokens={direct ? field.fetch : field.calc} onJump={onJump} v={v} />
        {field.via && (
          <div style={{ marginTop: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 7.5, letterSpacing: 1, fontWeight: 700, color: C.grey }}>VIA</span>
            <Expression tokens={[field.via]} onJump={onJump} v={v} />
          </div>
        )}
        {/* The selected token's raw record, extracted keys wired to outputs. */}
        {field.raw && (
          <div style={{ marginTop: 7, maxWidth: 420 }}>
            <RawData field={field} v={v} accent={C.teal} />
          </div>
        )}
        {/* This token's calculation, as steps. Not for a raw-record step: its
            record already shows every value the sentence would repeat. */}
        {equation && !(field.raw && rawRecordOf(field, v)) && (
          <div style={{
            marginTop: 6, paddingTop: 5, borderTop: `1px solid ${C.line}`,
            fontSize: 9, fontFamily: MONO, color: worked ? C.text : C.faint, lineHeight: 1.5,
          }}>
            {worked && (
              <div style={{
                fontFamily: 'inherit', fontSize: 7.5, letterSpacing: 1, fontWeight: 700,
                color: C.grey, marginBottom: 3,
              }}>CALCULATION, THIS TOKEN</div>
            )}
            {worked
              ? <WorkedSteps text={equation} accent={C.teal}
                result={typeof value === 'string' || typeof value === 'number' ? String(value) : null} />
              : equation}
          </div>
        )}
      </div>

      {/* --- 3. the wiring --------------------------------------------- */}
      <div style={{ marginTop: 7 }}>
        {!bare && evidence && (
          <div style={{
            fontSize: 9.5, color: C.text, lineHeight: 1.5, marginBottom: 5,
            paddingLeft: 8, borderLeft: `2px solid ${C.teal}55`,
          }}>{evidence}</div>
        )}
        {!bare && field.freshness && <Line k="fresh">{field.freshness}</Line>}
        {/* Not on the map: there the FEEDS rows are the drawn arrows, and a
            card's own "used by" list is the reverse claim that drifts. */}
        {!bare && field.feeds && field.feeds.length > 0 && (
          <div style={{ display: 'flex', gap: 8, padding: '2.5px 0', alignItems: 'baseline' }}>
            <div style={{
              width: 58, flexShrink: 0, fontSize: 8, letterSpacing: 0.9, fontWeight: 700,
              color: C.grey,
            }}>&rarr; USED BY</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Expression tokens={field.feeds} onJump={onJump} v={v} />
            </div>
          </div>
        )}
        {!bare && field.note && (
          <div style={{
            marginTop: 5, padding: '5px 8px', borderRadius: 6,
            background: status === 'placeholder' ? '#1e0c15' : '#0d1730',
            borderLeft: `2px solid ${status === 'placeholder' ? C.hot : C.grey}`,
            fontSize: 9.5, lineHeight: 1.55,
            color: status === 'placeholder' ? '#ff9ac8' : C.faint,
          }}>{field.note}</div>
        )}
        {!bare && (
          <div style={{
            marginTop: 6, fontSize: 8.5, fontFamily: MONO, color: C.grey,
            wordBreak: 'break-all',
          }}>{field.where}</div>
        )}

        {/* The plain-words description, demoted.

            It used to open the card and it dominated it. What the page is FOR
            is the flow and the arithmetic; the sentence explaining the number
            in words is a footnote to those, not the headline. Small, dim, and
            last - still there when you need it, never in the way. */}
        {!bare && shows && (
          <div style={{
            marginTop: 7, paddingTop: 6, borderTop: `1px solid ${C.line}`,
            fontSize: 8.5, lineHeight: 1.5, color: C.grey,
          }}>
            {shows.length === 1 ? shows[0] : shows.map((s, i) => (
              <div key={i} style={{ margin: '0 0 2px' }}>&bull; {s}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- group --- */

/**
 * A titled band of cards, matching the dashboard's own panel chrome.
 *
 * A group IS one panel of the dashboard, so its `shows` block describes that
 * panel as a whole - the controls, the verdict, the numbers, the chart - which
 * is the thing no individual card can say.
 */
export function Group({ group, children, right }) {
  const shows = group.shows || null;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <div style={{ fontSize: 9, letterSpacing: 1.3, color: C.pink, fontWeight: 700 }}>
          {group.group}
        </div>
        {right}
      </div>

      {group.note && (
        <div style={{ fontSize: 9.5, color: C.faint, lineHeight: 1.6, marginBottom: 9, maxWidth: 1040 }}>
          {group.note}
        </div>
      )}

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 10,
      }}>{children}</div>

      {/* What the panel shows, in words - LAST and small.

          It used to open the panel and take the eye first. The page is for the
          flow and the arithmetic; the description is the gloss on those, so it
          sits under them where it can be read when wanted and ignored when
          not. */}
      {shows && (
        <div style={{
          marginTop: 10, paddingTop: 7, borderTop: `1px solid ${C.line}`, maxWidth: 1040,
        }}>
          <div style={{
            fontSize: 7.5, letterSpacing: 1.1, fontWeight: 700, color: C.grey, marginBottom: 4,
          }}>WHAT THIS PANEL SHOWS</div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 8.5, lineHeight: 1.55 }}>
            {shows.map((item, i) => (
              <li key={i} style={{ margin: '0 0 3px', display: 'flex', gap: 6 }}>
                <span style={{ color: C.grey, flexShrink: 0 }}>&bull;</span>
                <div style={{ flex: 1, minWidth: 0, color: C.grey }}>
                  {typeof item === 'string' ? item : item.t}
                  {typeof item !== 'string' && item.sub && item.sub.length > 0 && (
                    <ul style={{ listStyle: 'none', margin: '2px 0 4px', padding: '0 0 0 10px' }}>
                      {item.sub.map((sub, j) => (
                        <li key={j} style={{ margin: '0 0 2px' }}>&ndash; {sub}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Shown where a tab has nothing to describe yet. */
export function Empty({ children }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
      padding: '14px 16px', fontSize: 11, color: C.dim, lineHeight: 1.6,
    }}>{children}</div>
  );
}

/** The blink keyframes, mounted once by the admin shell. */
export function ExplainStyles() {
  return <style>{PING_CSS}</style>;
}
