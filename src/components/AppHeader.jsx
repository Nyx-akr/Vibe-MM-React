import React from 'react';
import RegimeSelector from './RegimeSelector';

export default function AppHeader({ v, css }) {
  return <>
    <div style={css("display:flex;align-items:center;gap:16px;height:46px;padding:0 14px;background:#0a1226;border-bottom:1px solid #1c2a4d;flex-shrink:0;position:sticky;top:0;z-index:50", { v })}>
      <div style={css("display:flex;align-items:center;gap:10px", { v })}>
        <img src="/assets/vibe-logo.png" alt="Vibe" style={css("height:30px;display:block;border-radius:6px", { v })} />
        <div style={css("flex-shrink:0;white-space:nowrap", { v })}><div style={css("font-weight:800;letter-spacing:0.2px;font-size:14px;color:#ffffff", { v })}>Screener</div><div style={css("font-size:8.5px;letter-spacing:1.8px;color:#8b96b8", { v })}>ONCHAIN MARKET MONITOR</div></div>
      </div>
      <div style={css("width:1px;height:24px;background:#1c2a4d", { v })}></div>
      <div style={css("flex:1", { v })}></div>
      <RegimeSelector />
      <div style={css("font-size:10px;color:#8b96b8;white-space:nowrap;flex-shrink:0", { v })}>ALERTS 24H <span style={css("color:#ffffff;font-weight:600", { v })}>47</span></div>
      <div style={css("font-size:11px;color:#b6c2de;white-space:nowrap;flex-shrink:0", { v })}>{v.clock} UTC</div>
      <div className="h3eb549cf" onClick={v.toggleSound} style={css("padding:3px 10px;border:1px solid #1c2a4d;border-radius:999px;font-size:9px;font-weight:700;letter-spacing:1px;cursor:pointer;color:{{ soundFg }}", { v })}>{v.soundLabel}</div>
      <div style={css("display:flex;align-items:center;gap:5px", { v })}><div style={css("width:7px;height:7px;border-radius:50%;background:{{ liveDotColor }};animation:{{ liveDotAnim }}", { v })}></div><span style={css("font-size:10px;font-weight:700;letter-spacing:1px;color:{{ liveDotColor }}", { v })}>{v.liveLabel}</span></div>
    </div>

  </>;
}
