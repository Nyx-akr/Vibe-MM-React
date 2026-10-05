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
      <div style={{ textAlign: 'right' }} title={d.scoreWindowNote || ''}>
        <div style={{ fontSize: 8.5, color: '#8b96b8', letterSpacing: 1 }}>SCORE · {d.scoreWindowLabel}</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: d.scoreColor }}>{d.score}</div>
        {d.scoreRange && (
          <div style={{ fontSize: 8, color: '#4a5578', marginTop: 1 }}>{d.scoreRange}</div>
        )}
      </div>
      {d.scoreSpark && (
        <div style={{ alignSelf: 'center' }} title={d.scoreSpark.title}>
          <svg width={d.scoreSpark.w} height={d.scoreSpark.h} style={{ display: 'block', overflow: 'visible' }}>
            {/* the average, as a hairline one shade off the surface */}
            {d.scoreSpark.avgY && (
              <line x1="0" y1={d.scoreSpark.avgY} x2={d.scoreSpark.w} y2={d.scoreSpark.avgY}
                stroke="#2b3a60" strokeWidth="1" />
            )}
            <polyline points={d.scoreSpark.points} fill="none" stroke="#4d8dff"
              strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {/* where the score is right now */}
            <circle cx={d.scoreSpark.lastX} cy={d.scoreSpark.lastY} r="3"
              fill={d.scoreSpark.lastColor} stroke="#0a1226" strokeWidth="2" />
          </svg>
        </div>
      )}
      <div style={{ textAlign: 'right' }} title="This poll on its own, before averaging">
        <div style={{ fontSize: 8.5, color: '#8b96b8', letterSpacing: 1 }}>RIGHT NOW</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: d.scoreNowColor }}>{d.scoreNow}</div>
        {d.scoreDrift && (
          <div style={{ fontSize: 8, color: d.scoreDriftColor, marginTop: 1 }}>{d.scoreDrift}</div>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 8.5, color: '#8b96b8', letterSpacing: 1 }}>CONFIDENCE</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: '#dfe6f6' }}>{d.conf}</div>
      </div>
      </div>
    </div>
  );
}
