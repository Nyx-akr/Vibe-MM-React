import React from 'react';
import FlowUsers from '../admin/FlowUsers';
import { useMobile } from '../utils/useMobile';

export default function AppHeader({ v, css }) {
  const mobile = useMobile();
  if (mobile) return <MobileHeader v={v} />;
  return <>
    <div style={css("display:flex;align-items:center;gap:12px;height:46px;padding:0 14px;background:#0a1226;border-bottom:1px solid #1c2a4d;flex-shrink:0;position:sticky;top:0;z-index:50", { v })}>
      <div style={css("display:flex;align-items:center;gap:10px", { v })}>
        <img src="/assets/vibe-logo.png" alt="Vibe" style={css("height:30px;display:block;border-radius:6px", { v })} />
        <div style={css("flex-shrink:0;white-space:nowrap", { v })}><div style={css("font-weight:800;letter-spacing:0.2px;font-size:14px;color:#ffffff", { v })}>Screener</div><div style={css("font-size:8.5px;letter-spacing:1.8px;color:#8b96b8", { v })}>ONCHAIN MARKET MONITOR</div></div>
      </div>
      <div style={css("width:1px;height:24px;background:#1c2a4d", { v })}></div>
      {/* Page navigation - moved up from the old sidebar, which the token
          list now occupies. */}
      <nav style={{ display: 'flex', alignItems: 'stretch', height: '100%', gap: 2, minWidth: 0, flexShrink: 1, overflow: 'hidden' }}>
        {(v.navItems || []).map((t) => (
          <a key={t.label} className="h3eb549cf" href={t.href} onClick={t.go ? (e) => { e.preventDefault(); t.go(); } : undefined}
            style={{
              display: 'flex', alignItems: 'center', padding: '0 8px', textDecoration: 'none', whiteSpace: 'nowrap',
              fontSize: 9.5, fontWeight: 600, letterSpacing: 0.7, cursor: 'pointer',
              color: t.active ? '#e35ff2' : '#8b96b8',
              borderBottom: '2px solid ' + (t.active ? '#e35ff2' : 'transparent'),
              borderTop: '2px solid transparent'
            }}>{t.label}</a>
        ))}
      </nav>
      <div style={css("flex:1", { v })}></div>
      {/* ENGINE: the engine the app runs on, with each engine's grades (it replaced
          the REGIME button, which nothing read). The admin's FLOW picker, engine mode. */}
      <FlowUsers mode="engine" />
      <div style={css("font-size:10px;color:#8b96b8;white-space:nowrap;flex-shrink:0", { v })}>ALERTS <span style={css("color:#ffffff;font-weight:600", { v })}>{v.alertsNow == null ? '—' : v.alertsNow}</span></div>
      <div style={css("font-size:11px;color:#b6c2de;white-space:nowrap;flex-shrink:0", { v })}>{v.clock} UTC</div>
      <div className="h3eb549cf" onClick={v.toggleSound} style={css("padding:3px 10px;border:1px solid #1c2a4d;border-radius:999px;font-size:9px;font-weight:700;letter-spacing:1px;cursor:pointer;color:{{ soundFg }}", { v })}>{v.soundLabel}</div>
      <div style={css("display:flex;align-items:center;gap:5px", { v })}><div style={css("width:7px;height:7px;border-radius:50%;background:{{ liveDotColor }};animation:{{ liveDotAnim }}", { v })}></div><span style={css("font-size:10px;font-weight:700;letter-spacing:1px;color:{{ liveDotColor }}", { v })}>{v.liveLabel}</span></div>
    </div>

  </>;
}

/**
 * The phone top bar: the brand, the live state, and a menu. Everything the
 * desktop bar lays out in a row - the pages, the engine, alerts, the clock,
 * sound - sits in the menu sheet, so the bar stays one clean line.
 */
function MobileHeader({ v }) {
  const [open, setOpen] = React.useState(false);
  const active = (v.navItems || []).find((t) => t.active);
  const go = (t) => (e) => {
    if (t.go) { e.preventDefault(); t.go(); }
    setOpen(false);
  };
  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 52, padding: '0 12px 0 14px',
        paddingTop: 'env(safe-area-inset-top)', boxSizing: 'content-box',
        background: '#0a1226', borderBottom: '1px solid #1c2a4d', flexShrink: 0, position: 'sticky', top: 0, zIndex: 50
      }}>
        <img src="/assets/vibe-logo.png" alt="Vibe" style={{ height: 28, display: 'block', borderRadius: 6 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 15, color: '#ffffff', lineHeight: 1.1 }}>Screener</div>
          <div style={{ fontSize: 9, letterSpacing: 1.2, color: '#8b96b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {active ? active.label : 'ONCHAIN MARKET MONITOR'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: v.liveDotColor, animation: v.liveDotAnim }} />
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: v.liveDotColor, whiteSpace: 'nowrap' }}>{v.liveLabel}</span>
        </div>
        <button type="button" aria-label="Menu" onClick={() => setOpen(true)} style={{
          width: 40, height: 40, borderRadius: 10, border: '1px solid #1c2a4d', background: '#0d1730',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, padding: 0
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dfe6f6" strokeWidth="2.2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
      </div>

      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(3,8,20,.7)' }}>
          <div onClick={(e) => e.stopPropagation()} style={{
            position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(86vw, 320px)', background: '#0a1226',
            borderLeft: '1px solid #2b3a60', display: 'flex', flexDirection: 'column', boxShadow: '-16px 0 40px rgba(0,0,0,.5)',
            paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #16223f' }}>
              <span style={{ fontSize: 10, letterSpacing: 1.4, fontWeight: 800, color: '#8b96b8', flex: 1 }}>MENU</span>
              <button type="button" aria-label="Close menu" onClick={() => setOpen(false)} style={{ background: 'none', border: 'none', color: '#8b96b8', fontSize: 20, cursor: 'pointer', padding: 4, lineHeight: 1 }}>✕</button>
            </div>
            <nav style={{ display: 'flex', flexDirection: 'column', padding: '6px 0', overflowY: 'auto' }}>
              {(v.navItems || []).map((t) => (
                <a key={t.label} href={t.href} onClick={go(t)} style={{
                  display: 'flex', alignItems: 'center', minHeight: 48, padding: '0 18px', textDecoration: 'none',
                  fontSize: 13, fontWeight: 700, letterSpacing: 0.8,
                  color: t.active ? '#e35ff2' : '#dfe6f6',
                  background: t.active ? 'rgba(227,95,242,0.08)' : 'transparent',
                  borderLeft: '3px solid ' + (t.active ? '#e35ff2' : 'transparent')
                }}>{t.label}</a>
              ))}
            </nav>
            <div style={{ marginTop: 'auto', borderTop: '1px solid #16223f', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <FlowUsers mode="engine" />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: '#8b96b8' }}>
                <span>ALERTS <b style={{ color: '#ffffff' }}>{v.alertsNow == null ? '—' : v.alertsNow}</b></span>
                <span style={{ color: '#b6c2de' }}>{v.clock} UTC</span>
                <span style={{ flex: 1 }} />
                <button type="button" onClick={v.toggleSound} style={{
                  padding: '7px 12px', border: '1px solid #1c2a4d', borderRadius: 999, background: 'transparent',
                  fontSize: 10, fontWeight: 700, letterSpacing: 1, cursor: 'pointer', color: v.soundFg, fontFamily: 'inherit'
                }}>{v.soundLabel}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
