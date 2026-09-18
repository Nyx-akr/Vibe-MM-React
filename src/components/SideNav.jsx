import React from 'react';

/**
 * Vertical tab rail. Moved out of the header so the top bar carries only
 * status, and the tab list has room to breathe.
 *
 * One flat list, no group headers. DETAIL, SOCIAL and WALLETS are indented
 * under LIVE OPPORTUNITIES because that is where their token gets picked; the
 * indent carries that relationship on its own.
 *
 * Those three go dim when nothing is selected - they lead to the "pick an
 * asset" prompt until one is.
 */
export default function SideNav({ v }) {
  // The rail scrolls, so a tooltip parented inside it would be clipped at the
  // right edge. Position:fixed off the hovered row's own rect escapes that.
  const [hint, setHint] = React.useState(null);
  const showHint = (t) => (e) => {
    if (!t.hint) return;
    const r = e.currentTarget.getBoundingClientRect();
    setHint({ text: t.hint, top: r.top + r.height / 2, left: r.right + 8 });
  };

  const link = {
    padding: '9px 16px', fontSize: 10.5, fontWeight: 600, letterSpacing: 1,
    color: '#8b96b8', textDecoration: 'none', borderLeft: '2px solid transparent'
  };

  return (
    <div style={{
      width: 190, flexShrink: 0, background: '#0d1117',
      borderRight: '1px solid #1c2a4d', display: 'flex', flexDirection: 'column',
      padding: '4px 0 10px', gap: 1,
      // Pinned below the 46px top bar; align-self stops the flex row from
      // stretching it full height, which would leave nothing to stick within.
      position: 'sticky', top: 46, alignSelf: 'flex-start',
      height: 'calc(100vh - 46px)', overflowY: 'auto', zIndex: 40
    }}>
      <div style={{ height: 8 }} />

      {(v.navItems || []).map((t, i) => (
        <div
          key={i}
          // No hover-brighten on a tab that will not open.
          className={t.disabled ? undefined : 'h3eb549cf'}
          onClick={t.go}
          onMouseEnter={showHint(t)}
          onMouseLeave={() => setHint(null)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: `9px 12px 9px ${t.indent}px`,
            fontSize: 10.5, fontWeight: 600, letterSpacing: 1,
            cursor: t.disabled ? 'not-allowed' : 'pointer',
            color: t.fg, whiteSpace: 'nowrap',
            borderLeft: `2px solid ${t.line}`, background: t.bg
          }}
        >
          {t.child && (
            <span style={{ color: t.tickC, fontSize: 9, flexShrink: 0, lineHeight: 1 }}>└</span>
          )}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.label}</span>
        </div>
      ))}

      {hint && (
        <div style={{
          position: 'fixed', top: hint.top, left: hint.left, transform: 'translateY(-50%)',
          zIndex: 70, pointerEvents: 'none',
          background: 'rgba(13,23,48,.98)', border: '1px solid #3a4568',
          borderRadius: 8, padding: '6px 10px',
          fontSize: 9.5, fontWeight: 600, letterSpacing: 0.3, color: '#dfe6f6',
          whiteSpace: 'nowrap', boxShadow: '0 8px 24px rgba(0,0,0,.5)'
        }}>
          {hint.text}
        </div>
      )}

      <div style={{ flex: 1 }} />

      <a className="h3eb549cf" href="Architecture Handoff.dc.html" style={link}>DOCS ↗</a>
      <a className="h3eb549cf" href="/admin" style={link}>ADMIN ↗</a>
    </div>
  );
}
