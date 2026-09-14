import React from 'react';

export default function AppHeader({ v, css }) {
  return <>
    <div style={css("display:flex;align-items:center;gap:16px;height:46px;padding:0 14px;background:#0a1226;border-bottom:1px solid #1c2a4d;flex-shrink:0", { v })}>
      <div style={css("display:flex;align-items:center;gap:10px", { v })}>
        <img src="/assets/vibe-logo.png" alt="Vibe" style={css("height:30px;display:block;border-radius:6px", { v })} />
        <div style={css("flex-shrink:0;white-space:nowrap", { v })}><div style={css("font-weight:800;letter-spacing:0.2px;font-size:14px;color:#ffffff", { v })}>Screener</div><div style={css("font-size:8.5px;letter-spacing:1.8px;color:#8b96b8", { v })}>ONCHAIN MARKET MONITOR</div></div>
      </div>
      <div style={css("width:1px;height:24px;background:#1c2a4d", { v })}></div>
      <div style={css("display:flex;gap:8px", { v })}>{(v.chains || []).map((c, i) => <React.Fragment key={i}>
        <div style={css("display:flex;align-items:center;gap:5px;padding:3px 8px;background:#101c38;border:1px solid #1c2a4d;border-radius:10px;white-space:nowrap;overflow:hidden", { v, c })}><div style={css("width:6px;height:6px;border-radius:50%;background:{{ c.dot }};flex-shrink:0", { v, c })}></div><span style={css("font-size:10px;font-weight:600;color:#b6c2de", { v, c })}>{c.name}</span><span style={css("font-size:9px;color:#6b7699", { v, c })}>{c.lat}</span></div>
      </React.Fragment>)}</div>
      <div style={css("flex:1", { v })}></div>
      <div style={css("padding:3px 9px;border:1px solid #6f4fd8;color:#b48cff;font-size:10px;font-weight:600;letter-spacing:1px;border-radius:10px;white-space:nowrap;flex-shrink:0", { v })}>REGIME: SELECTIVE ROTATION</div>
      <div style={css("font-size:10px;color:#8b96b8;white-space:nowrap;flex-shrink:0", { v })}>ALERTS 24H <span style={css("color:#ffffff;font-weight:600", { v })}>47</span></div>
      <div style={css("font-size:11px;color:#b6c2de;white-space:nowrap;flex-shrink:0", { v })}>{v.clock} UTC</div>
      <div className="h3eb549cf" onClick={v.toggleSound} style={css("padding:3px 10px;border:1px solid #1c2a4d;border-radius:999px;font-size:9px;font-weight:700;letter-spacing:1px;cursor:pointer;color:{{ soundFg }}", { v })}>{v.soundLabel}</div>
      <div style={css("display:flex;align-items:center;gap:5px", { v })}><div style={css("width:7px;height:7px;border-radius:50%;background:{{ liveDotColor }};animation:{{ liveDotAnim }}", { v })}></div><span style={css("font-size:10px;font-weight:700;letter-spacing:1px;color:{{ liveDotColor }}", { v })}>{v.liveLabel}</span></div>
    </div>
    <div style={css("display:flex;gap:2px;padding:0 14px;background:#0d1117;border-bottom:1px solid #1c2a4d;flex-shrink:0", { v })}>{(v.tabs || []).map((t, i) => <React.Fragment key={i}>
      <div className="h3eb549cf" onClick={t.go} style={css("padding:8px 16px;font-size:11px;font-weight:600;letter-spacing:1.2px;cursor:pointer;color:{{ t.fg }};border-bottom:2px solid {{ t.line }}", { v, t })}>{t.label}</div>
    </React.Fragment>)}<a className="h3eb549cf" href="Architecture Handoff.dc.html" style={css("padding:8px 16px;font-size:11px;font-weight:600;letter-spacing:1.2px;color:#8b96b8;border-bottom:2px solid transparent;text-decoration:none", { v })}>DOCS ↗</a></div>
  </>;
}
