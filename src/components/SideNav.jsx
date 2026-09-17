import React from 'react';

/**
 * Vertical tab rail. Moved out of the header so the top bar carries only
 * status, and the tab list has room to breathe.
 *
 * Grouped, not flat: MARKET holds the feed plus everything that reports on a
 * token, SYSTEM holds the app-wide surfaces (alerts, evaluation, health) that
 * describe the screener itself rather than any one asset. Within MARKET, the
 * asset-scoped tabs are indented under ASSET DETAIL, and go dim when nothing
 * is selected - they lead to the "pick an asset" prompt until one is.
 */
export default function SideNav({ v }) {
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
      {(v.navGroups || []).map((g, gi) => (
        <React.Fragment key={gi}>
          <div style={{
            fontSize: 8.5, fontWeight: 700, letterSpacing: 1.6, color: '#4e5a7d',
            padding: gi === 0 ? '12px 16px 6px' : '20px 16px 6px'
          }}>
            {g.title}
          </div>

          {(g.items || []).map((t, i) => (
            <div
              key={i}
              className="h3eb549cf"
              onClick={t.go}
              style={{
                display: 'flex', alignItems: 'center', gap: 7,
                padding: `9px 12px 9px ${t.indent}px`,
                fontSize: 10.5, fontWeight: 600, letterSpacing: 1,
                cursor: 'pointer', color: t.fg, whiteSpace: 'nowrap',
                borderLeft: `2px solid ${t.line}`, background: t.bg
              }}
            >
              {t.child && (
                <span style={{ color: t.tickC, fontSize: 9, flexShrink: 0, lineHeight: 1 }}>└</span>
              )}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.label}</span>
            </div>
          ))}
        </React.Fragment>
      ))}

      <div style={{ flex: 1 }} />

      <a className="h3eb549cf" href="Architecture Handoff.dc.html" style={link}>DOCS ↗</a>
      <a className="h3eb549cf" href="/admin" style={link}>ADMIN ↗</a>
    </div>
  );
}
