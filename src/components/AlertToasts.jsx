import React from 'react';

/**
 * The three most recent ALERT CARDS, mirrored bottom-right.
 *
 * These are not timed notifications - nothing expires on its own. A card sits
 * here until you close it, and closing one pulls the next-newest up from the
 * backlog, so the stack is always showing the three latest alerts you have not
 * yet acknowledged. Missing an alert because you looked away is the one thing
 * this must never do.
 *
 * Every value on a toast comes from the card it mirrors - the class accent
 * included, so OPPORTUNITY reads blue, RISK red and RESOLUTION white without
 * this file knowing those classes exist.
 */
export default function AlertToasts({ v, css }) {
  const toasts = v.toasts || [];
  if (!toasts.length) return null;

  return (
    <div style={{
      position: 'fixed', right: 18, bottom: 18, zIndex: 60,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8,
      pointerEvents: 'none'
    }}>
      {/* Sits above the stack so it never moves when a card is dismissed. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, pointerEvents: 'auto' }}>
        {v.toastBacklog > 0 && (
          <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: '#6b7699' }}>
            +{v.toastBacklog} MORE
          </span>
        )}
        <span
          className="h3eb549cf"
          onClick={v.closeAllToasts}
          style={{
            cursor: 'pointer', fontSize: 8.5, fontWeight: 700, letterSpacing: 0.8,
            color: '#8b96b8', background: 'rgba(13,23,48,.97)',
            border: '1px solid #1c2a4d', borderRadius: 999, padding: '4px 10px'
          }}
        >
          CLOSE ALL ✕
        </span>
      </div>

      {/* column-reverse keeps the newest alert nearest the corner; older ones
          ride up above it as the stack fills. */}
      <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 10, pointerEvents: 'none' }}>
      {toasts.map((t) => (
        <div
          key={t.key}
          style={{
            width: 340, display: 'flex', pointerEvents: 'auto',
            background: 'rgba(13,23,48,.97)', border: `1px solid ${t.accent}`,
            borderRadius: 14, overflow: 'hidden',
            boxShadow: '0 12px 40px rgba(0,0,0,.55)',
            animation: t.fresh ? 'vsFlash 1s ease-out' : 'none'
          }}
        >
          {/* the same 3px class stripe the cards on the ALERT CARDS page carry */}
          <div style={{ width: 3, background: t.accent, flexShrink: 0 }} />

          <div style={{ padding: '12px 14px', flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{
                fontSize: 8, fontWeight: 800, letterSpacing: 0.9, padding: '3px 8px',
                borderRadius: 999, border: `1px solid ${t.accent}`, color: t.accent, flexShrink: 0
              }}>
                {t.label}
              </span>
              <span style={{
                fontSize: 11, fontWeight: 800, color: '#ffffff', flex: 1, minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>
                {t.title}
              </span>
              <span
                className="h3eb549cf"
                onClick={t.dismiss}
                style={{ cursor: 'pointer', color: '#6b7699', fontSize: 12, padding: '0 4px', flexShrink: 0 }}
              >
                ✕
              </span>
            </div>

            <div style={{ fontSize: 11, color: '#c6d1ea', lineHeight: 1.5 }}>{t.body}</div>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              marginTop: 8, paddingTop: 7, borderTop: '1px solid #1c2a4d'
            }}>
              <span style={{
                fontSize: 8.5, color: '#6b7699', flex: 1, minWidth: 0,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}>
                {t.meta}
              </span>
              <span
                className="h3eb549cf"
                onClick={t.open}
                style={{
                  cursor: 'pointer', fontSize: 8.5, fontWeight: 700,
                  letterSpacing: 0.6, color: t.accent, flexShrink: 0
                }}
              >
                OPEN CARD →
              </span>
            </div>
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}
