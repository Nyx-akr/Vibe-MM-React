import React from 'react';

/**
 * The wallet bubble map: pan, zoom, and hover detail.
 *
 * WHY THIS IS ITS OWN COMPONENT WITH ITS OWN STATE
 *
 * Hover and view state used to live in the app's state, which meant every
 * mouse move re-ran walletsVals - and with it the whole circle packing - for
 * the entire dashboard. Packing ninety bubbles costs single-digit milliseconds,
 * which is nothing once every five seconds and far too much sixty times a
 * second while dragging. Everything that changes at pointer speed is local
 * here; the data still arrives as props on the poll.
 *
 * ZOOM IS THE viewBox, NOT A TRANSFORM
 *
 * Scaling a <g> would scale the stroke widths with it, so the ring that means
 * "this wallet rotates" would thicken as you zoom in and stop meaning a fixed
 * thing. Moving the viewBox instead keeps every stroke at its authored width
 * at any magnification, which is what a map wants: the symbols stay constant
 * and only the extent changes.
 */

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 12;
const WHEEL_STEP = 1.18;

/** "x y w h" to numbers, tolerating whatever the caller wrote. */
function parseView(view) {
  const p = String(view || '').trim().split(/\s+/).map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
    return { x: 0, y: 0, w: 100, h: 100 };
  }
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

export default function WalletBubbleMap({
  bubbles = [], groups = [], arrows = [], pool = null, scale = null,
  homeView = '0 0 100 100', label = 'Wallet bubble map',
}) {
  const home = React.useMemo(() => parseView(homeView), [homeView]);
  const svgRef = React.useRef(null);
  const [view, setView] = React.useState(home);
  const [hoverId, setHoverId] = React.useState(null);
  const [dragging, setDragging] = React.useState(false);
  const drag = React.useRef(null);
  // The user's own framing is theirs to keep. Snapping back to a refitted
  // home every poll would yank the view out from under anyone reading it, so
  // the reset is deliberate and the home box is only adopted while untouched.
  const [touched, setTouched] = React.useState(false);

  React.useEffect(() => {
    if (!touched) setView(home);
  }, [home, touched]);

  const zoom = home.w / view.w;

  /** Pointer position in SVG user units. */
  const toSvg = (clientX, clientY) => {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: view.x + ((clientX - rect.left) / rect.width) * view.w,
      y: view.y + ((clientY - rect.top) / rect.height) * view.h,
    };
  };

  const zoomBy = (factor, anchor) => {
    setTouched(true);
    setView((v) => {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (home.w / v.w) * factor));
      const w = home.w / next;
      const h = home.h / next;
      // Keep whatever is under the cursor under the cursor.
      const ax = anchor ? (anchor.x - v.x) / v.w : 0.5;
      const ay = anchor ? (anchor.y - v.y) / v.h : 0.5;
      const px = anchor ? anchor.x : v.x + v.w / 2;
      const py = anchor ? anchor.y : v.y + v.h / 2;
      return { x: px - ax * w, y: py - ay * h, w, h };
    });
  };

  /**
   * Wheel zoom, bound by hand because React's onWheel is passive.
   *
   * React attaches wheel listeners passively, so preventDefault() inside one
   * is refused - the console fills with "Unable to preventDefault inside
   * passive event listener" and the page scrolls away underneath while the
   * map zooms. Binding it directly with { passive: false } is the only way to
   * hold the page still.
   */
  React.useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const handler = (e) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP, toSvg(e.clientX, e.clientY));
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  });

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    drag.current = {
      startX: e.clientX, startY: e.clientY,
      originX: view.x, originY: view.y,
      // Screen pixels to user units, fixed at grab time so the content tracks
      // the cursor exactly rather than accelerating as the view changes.
      scaleX: view.w / rect.width, scaleY: view.h / rect.height,
      moved: false,
    };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (!d.moved) return;
    setTouched(true);
    setView((v) => ({ ...v, x: d.originX - dx * d.scaleX, y: d.originY - dy * d.scaleY }));
  };

  const endDrag = (e) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (e && e.currentTarget.hasPointerCapture && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    return d && d.moved;
  };

  const reset = () => { setTouched(false); setView(home); };

  const hovered = hoverId ? bubbles.find((b) => b.key === hoverId) : null;
  const detail = hovered ? hovered.detail : null;

  const btn = {
    width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#0d1730', border: '1px solid #1c2a4d', borderRadius: 6,
    color: '#8b96b8', fontSize: 12, fontWeight: 700, cursor: 'pointer', userSelect: 'none',
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={svgRef}
        viewBox={view.x + ' ' + view.y + ' ' + view.w + ' ' + view.h}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => { if (drag.current) endDrag(); setHoverId(null); }}
        onDoubleClick={reset}
        style={{
          width: '100%', height: 'auto', maxHeight: '58vh', display: 'block',
          touchAction: 'none', cursor: dragging ? 'grabbing' : 'grab',
        }}
        role="img" aria-label={label}
      >
        <defs>
          {/* One marker per direction. A single marker cannot carry two
              colours, and the arrowhead must match the line it ends. */}
          <marker id="vs-flow-buy" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#4fd6c1" />
          </marker>
          <marker id="vs-flow-sell" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 1 L 10 5 L 0 9 z" fill="#ff8fa3" />
          </marker>
        </defs>

        {/* Trade flow against the pool, under the bubbles. */}
        {arrows.map((a) => (
          <line
            key={a.key} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2}
            stroke={a.color} strokeWidth={a.width} strokeOpacity={a.opacity}
            markerEnd={'url(#' + (a.buying ? 'vs-flow-buy' : 'vs-flow-sell') + ')'}
          />
        ))}

        {/* Co-entry groups: an enclosing ring, never spokes to a centre that
            holds no wallet. Drawn under the bubbles so it frames them. */}
        {groups.map((g) => (
          <g key={g.key} pointerEvents="none">
            <circle
              cx={g.cx} cy={g.cy} r={g.r}
              fill={g.color} fillOpacity="0.07"
              stroke={g.color} strokeWidth="1" strokeOpacity="0.55"
              strokeDasharray={g.dash === '0' ? undefined : g.dash}
            />
            <text
              x={g.cx} y={Number(g.cy) - Number(g.r) - 4} textAnchor="middle"
              fontSize="7" fontWeight="700" fill={g.color} fillOpacity="0.9"
              style={{ fontFamily: 'inherit', letterSpacing: '.3px' }}
            >{g.label}</text>
          </g>
        ))}

        {pool && (
          <g pointerEvents="none">
            <circle cx={pool.x} cy={pool.y} r={pool.r}
              fill="#0a1226" stroke="#2b3a5c" strokeWidth="1.5" />
            <text x={pool.x} y={pool.y - 1} textAnchor="middle"
              fontSize="9" fontWeight="800" fill="#c6d1ea"
              style={{ fontFamily: 'inherit' }}>{pool.label}</text>
            <text x={pool.x} y={pool.y + 9} textAnchor="middle"
              fontSize="7.5" fontWeight="700" fill={pool.netC}
              style={{ fontFamily: 'inherit' }}>{pool.net}</text>
          </g>
        )}
        {bubbles.map((b) => {
          const on = b.key === hoverId;
          return (
            <g
              key={b.key}
              onPointerEnter={() => { if (!drag.current) setHoverId(b.key); }}
              onPointerLeave={() => setHoverId((id) => (id === b.key ? null : id))}
              // A drag that happened to start on a bubble is a pan, not a click.
              onClick={() => { if (!dragging && b.open) b.open(); }}
              style={{ cursor: dragging ? 'grabbing' : 'pointer' }}
            >
              <circle
                cx={b.cx} cy={b.cy} r={b.rr}
                fill={b.fill} fillOpacity={on ? 0.95 : 0.7}
                stroke={b.ringW === '0' ? b.edge : b.ringC}
                strokeWidth={b.ringW === '0' ? 1 : b.ringW}
                strokeOpacity={on ? 1 : 0.85}
              />
              {b.tracked && (
                <circle
                  cx={b.cx} cy={b.cy} r={Number(b.rr) + 3}
                  fill="none" stroke="#4fe08f" strokeWidth="1.2" strokeOpacity="0.9"
                />
              )}
              {/* Labels ride on the bubble itself, so the wallets that matter
                  are readable without hovering each one to find out. */}
              {b.name && (
                <text
                  x={b.cx} y={b.nameSub ? Number(b.cy) - 1 : Number(b.cy) + 3}
                  textAnchor="middle" pointerEvents="none"
                  fontSize="7.5" fontWeight="700" fill="#ffffff" fillOpacity="0.92"
                  style={{ fontFamily: 'ui-monospace, monospace' }}
                >{b.name}</text>
              )}
              {b.nameSub && (
                <text
                  x={b.cx} y={Number(b.cy) + 8} textAnchor="middle" pointerEvents="none"
                  fontSize="7" fontWeight="700" fill="#ffffff" fillOpacity="0.7"
                  style={{ fontFamily: 'inherit' }}
                >{b.nameSub}</text>
              )}
            </g>
          );
        })}
      </svg>

      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 3 }}>
        <div style={btn} onClick={() => zoomBy(WHEEL_STEP)} title="Zoom in">+</div>
        <div style={btn} onClick={() => zoomBy(1 / WHEEL_STEP)} title="Zoom out">&minus;</div>
        <div
          style={{ ...btn, width: 'auto', padding: '0 8px', fontSize: 8.5, fontWeight: 800,
            letterSpacing: '.6px',
            color: touched ? '#6ea0ff' : '#3a4568', borderColor: touched ? '#4d8dff' : '#1c2a4d' }}
          onClick={reset} title="Reset view (or double-click the map)"
        >FIT</div>
      </div>

      {/* What a bubble of a given size is worth.
          Nested and bottom-aligned, which is the standard for a proportional
          symbol key: it reads as one scale rather than three, and takes a
          third of the room. Side by side at true size, the largest swatch was
          as big as a real whale bubble and could be mistaken for data. */}
      {scale && scale.length > 0 && (() => {
        const big = Math.max(...scale.map((s) => Number(s.r)));
        const k = Math.min(1, 26 / big);
        const w = big * k * 2 + 62;
        const h = big * k * 2 + 12;
        return (
          <svg
            width={w} height={h} pointerEvents="none"
            style={{ position: 'absolute', bottom: 8, left: 10, opacity: 0.75 }}
          >
            {scale.map((s) => {
              const r = Number(s.r) * k;
              const cx = big * k + 1;
              const cy = h - 6 - r;
              return (
                <g key={s.label}>
                  <circle cx={cx} cy={cy} r={r} fill="none" stroke="#6b7699" strokeWidth="0.9" />
                  <line x1={cx} y1={cy - r} x2={cx + big * k + 6} y2={cy - r}
                    stroke="#3a4568" strokeWidth="0.6" strokeDasharray="2 2" />
                  <text x={cx + big * k + 9} y={cy - r + 2.5}
                    fontSize="7.5" fill="#8b96b8" style={{ fontFamily: 'inherit' }}>{s.label}</text>
                </g>
              );
            })}
            <text x="0" y="7" fontSize="7" fontWeight="700" fill="#3a4568"
              style={{ fontFamily: 'inherit', letterSpacing: '.8px' }}>TURNOVER</text>
          </svg>
        );
      })()}

      <div style={{ position: 'absolute', bottom: 8, right: 8, fontSize: 8.5, color: '#3a4568' }}>
        {zoom > 1.05 ? zoom.toFixed(1) + '× · drag to pan' : 'scroll to zoom · drag to pan'}
      </div>

      {detail && !dragging && (
        <div style={{
          position: 'absolute', top: 6, left: 6, background: '#0d1730',
          border: '1px solid #2b3a5c', borderRadius: 8, padding: '9px 11px',
          pointerEvents: 'none', minWidth: 190, boxShadow: '0 6px 18px rgba(0,0,0,.45)',
        }}>
          <div style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: '#ffffff' }}>{detail.short}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '5px 0 6px' }}>
            {detail.tags.map((t) => (
              <span key={t.t} title={t.tip} style={{
                fontSize: 8, fontWeight: 800, padding: '2px 6px', borderRadius: 999,
                background: t.bg, color: t.fg, whiteSpace: 'nowrap', letterSpacing: '.4px',
              }}>{t.t}</span>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '2px 12px', fontSize: 10 }}>
            <span style={{ color: '#6b7699' }}>turnover</span>
            <span style={{ color: '#ffffff', fontWeight: 700, textAlign: 'right' }}>{detail.turnover}</span>
            <span style={{ color: '#6b7699' }}>net</span>
            <span style={{ color: detail.netC, fontWeight: 700, textAlign: 'right' }}>{detail.net}</span>
            <span style={{ color: '#6b7699' }}>bought / sold</span>
            <span style={{ color: '#c6d1ea', textAlign: 'right' }}>{detail.bought} / {detail.sold}</span>
            <span style={{ color: '#6b7699' }}>trades</span>
            <span style={{ color: '#c6d1ea', textAlign: 'right' }}>{detail.trades}</span>
            <span style={{ color: '#6b7699' }}>supply</span>
            <span style={{ color: '#ffbe4d', textAlign: 'right' }}>{detail.supply}</span>
          </div>
          <div style={{ fontSize: 9, color: '#4d8dff', marginTop: 5 }}>also trading: {detail.alsoIn}</div>
          <div style={{ fontSize: 8.5, color: '#3a4568', marginTop: 2 }}>{detail.seen}</div>
        </div>
      )}
    </div>
  );
}
