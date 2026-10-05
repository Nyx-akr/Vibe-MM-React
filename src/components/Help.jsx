import React, { useEffect, useRef, useState } from 'react';

/**
 * A small circled "?" that opens a plain-language explanation on click.
 *
 * The popover is position:fixed, measured from the icon, so it is never
 * clipped by a scrolling panel or an overflow:hidden bar around it. Only one
 * is open at a time: opening one tells the others to close.
 */
const OPEN_EVENT = 'vs-help-open';
let seq = 0;

const WIDTH = 270;

export default function Help({ title, text, children }) {
  const [id] = useState(() => (seq += 1));
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const pop = useRef(null);

  useEffect(() => {
    if (!pos) return undefined;
    const close = () => setPos(null);
    const onOther = (e) => { if (e.detail !== id) close(); };
    const onDown = (e) => {
      if (btn.current && btn.current.contains(e.target)) return;
      if (pop.current && pop.current.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener(OPEN_EVENT, onOther);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // A fixed popover would float away from its icon on scroll.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener(OPEN_EVENT, onOther);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos, id]);

  const toggle = (e) => {
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const r = btn.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left - 12, window.innerWidth - WIDTH - 8));
    // Open below unless that would run off the bottom of the window.
    const below = r.bottom + 180 < window.innerHeight;
    setPos(below ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 });
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }));
  };

  return (
    <>
      <span
        ref={btn}
        role="button"
        tabIndex={0}
        aria-label={'What is ' + (title || 'this') + '?'}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(e); } }}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 11, height: 11, borderRadius: '50%', flex: 'none',
          border: '1px solid ' + (pos ? '#6ea0ff' : '#3a4568'),
          color: pos ? '#ffffff' : '#8b96b8', background: pos ? '#2b6bff' : 'transparent',
          fontSize: 8, fontWeight: 700, lineHeight: 1, letterSpacing: 0,
          cursor: 'pointer', userSelect: 'none', verticalAlign: 'middle',
          margin: '0 0 1px 4px', fontFamily: 'inherit',
        }}
      >?</span>
      {pos && (
        <div
          ref={pop}
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed', zIndex: 1000, width: WIDTH, boxSizing: 'border-box', ...pos,
            background: '#0d1730', border: '1px solid #2b3d6b', borderRadius: 8,
            padding: '9px 11px', boxShadow: '0 8px 24px rgba(0,0,0,.5)',
            fontSize: 11, lineHeight: 1.45, color: '#c6d1ea', letterSpacing: 0,
            fontWeight: 400, textAlign: 'left', whiteSpace: 'normal', textTransform: 'none',
          }}
        >
          {title && <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: '#ffffff', marginBottom: 4 }}>{title}</div>}
          {text}
          {children}
        </div>
      )}
    </>
  );
}
