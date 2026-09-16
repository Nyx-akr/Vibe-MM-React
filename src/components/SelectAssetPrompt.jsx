import React from 'react';

/**
 * Shown on the tabs that describe one token when nothing has been selected.
 *
 * These tabs used to fall back to `assets[0]`, so opening Asset Detail cold
 * showed whichever token happened to top the feed as though the user had
 * chosen it.
 */
export default function SelectAssetPrompt({ v }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 20px' }}>
      <div style={{
        background: '#0a1226', border: '1px solid #1c2a4d', borderRadius: 16,
        padding: '34px 44px', maxWidth: 460, textAlign: 'center'
      }}>
        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: '#6b7699', marginBottom: 10 }}>
          {v.selectionTabLabel}
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#ffffff', marginBottom: 10 }}>
          Select an asset first
        </div>
        <div style={{ fontSize: 11, color: '#8b96b8', lineHeight: 1.6, marginBottom: 20 }}>
          This tab reports on one token. Pick a row in Live Opportunities and it
          will open here with its own data.
        </div>
        <div
          className="h3eb549cf"
          onClick={v.goLive}
          style={{
            display: 'inline-block', padding: '7px 20px', borderRadius: 999,
            background: 'linear-gradient(135deg,#2b6bff,#e35ff2)', color: '#ffffff',
            fontSize: 11, fontWeight: 700, cursor: 'pointer'
          }}
        >
          ← BROWSE LIVE OPPORTUNITIES
        </div>
      </div>
    </div>
  );
}
