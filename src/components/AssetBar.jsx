import React from 'react';

/**
 * The selected token's identity, pinned above every tab except the feed.
 *
 * Rotation, Wallets, Social and the rest all report on one asset, so the bar
 * follows you between them - otherwise a tab full of numbers gives no clue
 * which token it describes.
 */
export default function AssetBar({ v }) {
  const d = v.d || {};
  const pill = (bg, fg, border) => ({
    fontSize: 9, fontWeight: 700, letterSpacing: 0.6, padding: '3px 8px',
    borderRadius: 10, background: bg, color: fg,
    border: border ? `1px solid ${border}` : 'none', whiteSpace: 'nowrap'
  });

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '9px 14px', background: '#0a1226',
      borderBottom: '1px solid #1c2a4d', flexShrink: 0
    }}>
      {/* identity may wrap; the score pair never splits off on its own */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff' }}>{d.sym}</div>
      <div style={{ color: '#8b96b8', fontSize: 11 }}>{d.name}</div>

      <span style={pill(d.stageBg, d.stageFg)}>{d.stage}</span>
      <span style={pill('transparent', d.clsColor, d.clsColor)}>{d.cls}</span>
      {d.canonical && <span style={pill('#0e2a5c', '#4d8dff')}>✓ CANONICAL CONTRACT</span>}
      {d.staleNote && <span style={pill('#1a2440', '#8b96b8')}>{d.staleNote}</span>}
      </div>

      <div style={{ display: 'flex', gap: 20, flexShrink: 0 }}>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 8.5, color: '#8b96b8', letterSpacing: 1 }}>FINAL SCORE</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: d.scoreColor }}>{d.score}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 8.5, color: '#8b96b8', letterSpacing: 1 }}>CONFIDENCE</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#dfe6f6' }}>{d.conf}</div>
      </div>
      </div>
    </div>
  );
}
