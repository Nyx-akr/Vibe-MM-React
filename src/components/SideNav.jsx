import React from 'react';

/**
 * Vertical tab rail. Moved out of the header so the top bar carries only
 * status, and the tab list has room to breathe.
 */
export default function SideNav({ v }) {
  return (
    <div style={{
      width: 178, flexShrink: 0, background: '#0d1117',
      borderRight: '1px solid #1c2a4d', display: 'flex', flexDirection: 'column',
      padding: '10px 0', gap: 2,
      // Pinned below the 46px top bar; align-self stops the flex row from
      // stretching it full height, which would leave nothing to stick within.
      position: 'sticky', top: 46, alignSelf: 'flex-start',
      height: 'calc(100vh - 46px)', overflowY: 'auto', zIndex: 40
    }}>
      {(v.tabs || []).map((t, i) => (
        <div
          key={i}
          className="h3eb549cf"
          onClick={t.go}
          style={{
            padding: '9px 16px', fontSize: 10.5, fontWeight: 600, letterSpacing: 1,
            cursor: 'pointer', color: t.fg, whiteSpace: 'nowrap',
            borderLeft: `2px solid ${t.line}`,
            background: t.line === 'transparent' ? 'transparent' : 'rgba(227,95,242,0.07)'
          }}
        >
          {t.label}
        </div>
      ))}

      <div style={{ flex: 1 }} />

      <a
        className="h3eb549cf"
        href="Architecture Handoff.dc.html"
        style={{
          padding: '9px 16px', fontSize: 10.5, fontWeight: 600, letterSpacing: 1,
          color: '#8b96b8', textDecoration: 'none', borderLeft: '2px solid transparent'
        }}
      >
        DOCS ↗
      </a>
      <a
        className="h3eb549cf"
        href="/admin"
        style={{
          padding: '9px 16px', fontSize: 10.5, fontWeight: 600, letterSpacing: 1,
          color: '#8b96b8', textDecoration: 'none', borderLeft: '2px solid transparent'
        }}
      >
        ADMIN ↗
      </a>
    </div>
  );
}
