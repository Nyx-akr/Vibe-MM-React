import React from 'react';
import AssetBar from './AssetBar';
import { useMobile } from '../utils/useMobile';

/**
 * The full view behind a dashboard window's DETAILS button.
 *
 * Each window has its own popup: DETAIL opens the whole Asset Detail view,
 * SOCIAL the whole Social Scanner, and so on. The view inside is the same
 * component the old tab rendered - it is handed a `v` where only its own
 * is* flag is on, so it draws exactly what the tab used to.
 *
 * Esc or the backdrop closes it. The token list's arrow keys still work
 * underneath, so the popup follows the selection.
 */
export default function TabPopup({ v, title, onClose, children }) {
  // On a phone the popup is the whole screen, with a large close target.
  const mobile = useMobile();
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(3,8,20,.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: mobile ? 0 : '3vh 3vw'
    }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title} style={{
        width: '100%', maxWidth: 1400, height: '100%', background: '#081736',
        border: mobile ? 'none' : '1px solid #2b3a60', borderRadius: mobile ? 0 : 14, boxShadow: '0 24px 64px rgba(0,0,0,.6)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        paddingTop: mobile ? 'env(safe-area-inset-top)' : 0, paddingBottom: mobile ? 'env(safe-area-inset-bottom)' : 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: mobile ? '6px 6px 6px 16px' : '8px 12px 8px 16px', background: '#0a1226', borderBottom: '1px solid #1c2a4d', flexShrink: 0 }}>
          <span style={{ fontSize: mobile ? 12 : 10, letterSpacing: 1.4, fontWeight: 800, color: '#e35ff2' }}>{title}</span>
          <span style={{ flex: 1 }} />
          {!mobile && <span style={{ fontSize: 9, color: '#4a5578' }}>Esc to close · ↑↓ change token</span>}
          <div className="h3eb549cf" onClick={onClose} title="Close" style={{ cursor: 'pointer', color: '#8b96b8', fontSize: mobile ? 20 : 14, lineHeight: 1, padding: mobile ? '10px 14px' : '2px 6px' }}>✕</div>
        </div>
        <AssetBar v={v} />
        {/* The full views are desktop layouts; on a phone they scroll sideways
            rather than crush. */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowX: mobile ? 'auto' : undefined }}>
          {children}
        </div>
      </div>
    </div>
  );
}
