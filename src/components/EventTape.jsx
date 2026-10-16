import React from 'react';

/**
 * The raw-ingestion tape and Chepe's veto log.
 *
 * Both used to sit under the feed table. They describe the pipeline, not a
 * token, so they now live at the foot of HEALTH and the dashboard keeps its
 * room for the selected token.
 */
export default function EventTape({ v }) {
  return (
    <div style={{ display: 'flex', gap: 10, height: 170, margin: '0 14px 12px', flexShrink: 0 }}>
      <div style={{ flex: 1, background: '#0a1226', border: '1px solid #1c2a4d', borderRadius: 10, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: '6px 12px', borderBottom: '1px solid #1c2a4d', fontSize: 9, letterSpacing: 1.2, color: '#8b96b8', fontWeight: 600 }}>EVENT TAPE — RAW INGESTION (LAYER A)</div>
        <div style={{ flex: 1, overflow: 'hidden', padding: '4px 12px' }}>
          {(v.tape || []).map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, padding: '2.5px 0', fontSize: 10.5, animation: e.anim }}>
              <span style={{ color: '#6b7699' }}>{e.ts}</span>
              <span style={{ width: 74, fontWeight: 700, color: e.kindColor }}>{e.kind}</span>
              <span style={{ width: 52, color: e.chainColor }}>{e.chain}</span>
              <span style={{ color: '#c6d1ea' }}>{e.text}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ width: 300, background: '#0a1226', border: '1px solid #1c2a4d', borderRadius: 10, display: 'flex', flexShrink: 0, overflow: 'hidden' }}>
        <div style={{ flex: 1, padding: '10px 4px 10px 14px', minWidth: 0 }}>
          <div style={{ fontSize: 9, letterSpacing: 1.2, color: '#f06ee2', fontWeight: 700, marginBottom: 6 }}>CHEPE'S VETO LOG</div>
          {(v.chepeStats || []).map((cs, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0', fontSize: 9.5 }}>
              <span style={{ color: '#8b96b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cs.k}</span>
              <span style={{ fontWeight: 700, color: '#ffffff', flexShrink: 0 }}>{cs.v}</span>
            </div>
          ))}
        </div>
        <img src="/assets/chepe.png" alt="Chepe" style={{ width: 96, height: '100%', objectFit: 'cover', objectPosition: 'center bottom', flexShrink: 0 }} />
      </div>
    </div>
  );
}
