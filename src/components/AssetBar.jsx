import React from 'react';
import { signalInfo, phaseColor } from '../utils/formatters';

/**
 * The selected token's identity: its name and its call (signal and phase).
 * Shown above the dashboard windows and at the top of each DETAILS popup.
 */
export default function AssetBar({ v }) {
  const d = v.d || {};
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '9px 14px', background: '#0a1226',
      borderBottom: '1px solid #1c2a4d', flexShrink: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff' }}>{d.sym}</div>
        <div style={{ color: '#8b96b8', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</div>
      </div>
      <div title={(d.signalWhy || '') + (d.phaseWhy ? '\n' + d.phaseWhy : '')} style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 8.5, color: phaseColor(d.phase), letterSpacing: 1 }}>{d.phase || 'NO PHASE YET'}</div>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.8, color: signalInfo(d.signal).fg }}>{d.signal || '—'}</div>
      </div>
    </div>
  );
}
