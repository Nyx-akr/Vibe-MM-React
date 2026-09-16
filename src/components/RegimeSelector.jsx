import React from 'react';

/**
 * Regime picker in the top bar.
 *
 * Display only: picking a regime changes the label and nothing else. Nothing
 * in the app computes or consumes a regime yet, and the badge it replaces was
 * a hardcoded string that read "SELECTIVE ROTATION" on every chain at every
 * hour. The dropdown at least makes the vocabulary visible and says outright
 * that it is not wired up.
 */
const REGIMES = [
  { id: 'RISK-ON EXPANSION', note: 'broad rally, most tokens up, liquidity rising' },
  { id: 'BROAD ROTATION', note: 'cohorts swapping leadership, wide participation' },
  { id: 'SELECTIVE ROTATION', note: 'flat overall, narrow breadth, few winners' },
  { id: 'MAJORS-LED', note: 'bid concentrated in majors, alts bleeding' },
  { id: 'RISK-OFF', note: 'broad bleed, capital retreating to stables' },
  { id: 'CAPITULATION', note: 'forced selling, liquidity vanishing' },
  { id: 'CHOP / RANGEBOUND', note: 'low dispersion, low volume against baseline' },
  { id: 'LAUNCH MANIA', note: 'new-pool rate spiking, memecoin share climbing' },
  { id: 'LIQUIDITY DRAIN', note: 'pool liquidity falling across chains' }
];

export default function RegimeSelector() {
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState('SELECTIVE ROTATION');
  const ref = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          padding: '3px 9px', border: '1px solid #6f4fd8', color: '#b48cff',
          fontSize: 10, fontWeight: 600, letterSpacing: 1, borderRadius: 10,
          whiteSpace: 'nowrap', cursor: 'pointer', userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 6,
          background: open ? 'rgba(111,79,216,0.18)' : 'transparent',
          transition: 'background 160ms ease'
        }}
      >
        REGIME: {selected}
        <span style={{
          fontSize: 8, display: 'inline-block',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform 200ms ease'
        }}>▼</span>
      </div>

      <div style={{
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, width: 300,
        background: '#0d1730', border: '1px solid #6f4fd8', borderRadius: 10,
        boxShadow: '0 12px 34px rgba(0,0,0,.55)', overflow: 'hidden', zIndex: 60,
        // The animation: height and fade together, so it unrolls rather than
        // appearing all at once.
        maxHeight: open ? 420 : 0,
        opacity: open ? 1 : 0,
        transform: open ? 'translateY(0)' : 'translateY(-8px)',
        pointerEvents: open ? 'auto' : 'none',
        transition: 'max-height 260ms cubic-bezier(.4,0,.2,1), opacity 180ms ease, transform 220ms cubic-bezier(.4,0,.2,1)'
      }}>
        {REGIMES.map((r) => {
          const active = r.id === selected;
          return (
            <div
              key={r.id}
              onClick={() => { setSelected(r.id); setOpen(false); }}
              className="h3eb549cf"
              style={{
                padding: '8px 12px', cursor: 'pointer',
                borderBottom: '1px solid #16223f',
                borderLeft: `2px solid ${active ? '#b48cff' : 'transparent'}`,
                background: active ? 'rgba(111,79,216,0.14)' : 'transparent'
              }}
            >
              <div style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0.8,
                color: active ? '#b48cff' : '#dfe6f6'
              }}>{r.id}</div>
              <div style={{ fontSize: 9, color: '#6b7699', marginTop: 2 }}>{r.note}</div>
            </div>
          );
        })}
        <div style={{ padding: '7px 12px', fontSize: 8.5, color: '#3a4568', lineHeight: 1.5 }}>
          Display only — nothing measures the regime yet. Picking one changes
          this label and nothing else.
        </div>
      </div>
    </div>
  );
}
