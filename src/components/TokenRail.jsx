import React from 'react';
import Help from './Help';

/**
 * The token list, down the left of the dashboard.
 *
 * It replaces the feed table. Each row is one line - symbol, stage, 5m move
 * and score - because the rest of what the table carried now lives in the
 * windows beside it for whichever token is selected. Screening still works:
 * search, the watchlist, a sort, and the chain / stage / type filters behind
 * FILTERS.
 *
 * The list scrolls on its own; the page around it does not.
 */
export default function TokenRail({ v, mobile = false, onPick }) {
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const listRef = React.useRef(null);

  // Arrow keys move the selection (see App), so keep the selected row in view.
  const selIndex = (v.rows || []).findIndex((r) => r.selected);
  React.useEffect(() => {
    const box = listRef.current;
    const el = box && selIndex >= 0 ? box.children[selIndex] : null;
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [selIndex]);

  const board = (v.stats || [])[0] || {};
  const market = (v.stats || []).slice(1);
  const filterRows = board.rows || [];
  const activeFilters = filterRows.filter((r) => r.reset).length;

  return (
    <div style={{
      width: mobile ? '100%' : 248, flex: mobile ? 1 : undefined, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0,
      background: '#0d1117', borderRight: mobile ? 'none' : '1px solid #1c2a4d', position: 'relative'
    }}>
      {/* Board-wide figures: what used to be the stat tiles over the table. */}
      <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid #16223f' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 9, letterSpacing: 1.2, color: '#8b96b8', fontWeight: 700 }}>TOKENS</span>
          <span style={{ fontSize: 10, color: '#6b7699' }}>
            <span style={{ color: '#ffffff', fontWeight: 700 }}>{v.rowCount}</span> shown · {board.value || '—'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {market.map((s, i) => (
            <div key={i} title={s.sub || ''} style={{ flex: 1, minWidth: 0, background: '#0a1226', border: '1px solid #1c2a4d', borderRadius: 8, padding: '5px 8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 7.5, letterSpacing: 0.8, color: '#6b7699', whiteSpace: 'nowrap', overflow: 'hidden' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</span>
                {s.help && <Help title={s.help.title} text={s.help.text} />}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 1 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: s.color }}>{s.value}</span>
                {s.verdict && <span style={{ fontSize: 8.5, fontWeight: 600, color: s.color }}>{s.verdict}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Search, then the controls that narrow and order the list. */}
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6, borderBottom: '1px solid #16223f' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6, background: '#0a1226',
          border: '1px solid ' + (v.hasSearch ? '#f06ee2' : '#1c2a4d'), borderRadius: 999, padding: '4px 10px'
        }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={v.hasSearch ? '#f06ee2' : '#6b7699'} strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4.3-4.3" /></svg>
          <input value={v.searchQ} onChange={v.onSearch} placeholder="Search symbol or name" spellCheck={false}
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: '#dfe6f6', fontFamily: 'inherit', fontSize: mobile ? 16 : 10, padding: mobile ? '4px 0' : '1px 0' }} />
          {v.hasSearch && <span className="h3eb549cf" onClick={v.clearSearch} style={{ cursor: 'pointer', color: '#6b7699', fontSize: 11, lineHeight: 1 }}>✕</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {(v.views || []).map((c, i) => (
            <div key={i} className="h3eb549cf" onClick={c.go} style={{ padding: mobile ? '7px 12px' : '3px 9px', borderRadius: 999, fontSize: mobile ? 12 : 9.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', background: c.bg, color: c.fg, border: '1px solid ' + c.bd }}>{c.label}</div>
          ))}
          <div className="h3eb549cf" onClick={() => setFiltersOpen((o) => !o)} style={{
            padding: mobile ? '7px 12px' : '3px 9px', borderRadius: 999, fontSize: mobile ? 12 : 9.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
            background: filtersOpen || activeFilters ? '#0e2a5c' : '#0a1226',
            color: filtersOpen || activeFilters ? '#6ea0ff' : '#8b96b8',
            border: '1px solid ' + (filtersOpen || activeFilters ? '#4d8dff' : '#1c2a4d')
          }}>FILTERS{activeFilters ? ' · ' + activeFilters : ''} ▾</div>
          <div style={{ flex: 1 }} />
          <select value={v.sortKey} onChange={(e) => v.setSort(e.target.value)} title="Sort the list"
            style={{ background: '#0a1226', color: '#b6c2de', border: '1px solid #1c2a4d', borderRadius: mobile ? 999 : 6, fontSize: mobile ? 16 : 9.5, fontFamily: 'inherit', padding: mobile ? '5px 10px' : '2px 4px', outline: 'none', cursor: 'pointer' }}>
            {(v.sortOptions || []).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {/* Chain / stage / type, the rows of the old TOKENS TRACKED tile. */}
      {filtersOpen && mobile && <div onClick={() => setFiltersOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 59, background: 'rgba(3,8,20,.6)' }} />}
      {filtersOpen && (
        <div style={mobile ? {
          position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 60, maxHeight: '75vh', overflowY: 'auto',
          background: '#0d1730', borderTop: '1px solid #3a4568', borderRadius: '16px 16px 0 0',
          padding: '14px 16px calc(18px + env(safe-area-inset-bottom))', boxShadow: '0 -12px 32px rgba(0,0,0,.55)'
        } : {
          position: 'absolute', top: 128, left: 'calc(100% + 6px)', width: 360, zIndex: 60,
          background: 'rgba(13,23,48,.98)', border: '1px solid #3a4568', borderRadius: 10,
          padding: '10px 12px 12px', boxShadow: '0 12px 32px rgba(0,0,0,.55)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
            <span style={{ fontSize: 9, letterSpacing: 1.2, color: '#8b96b8', fontWeight: 700 }}>FILTERS</span>
            <span className="h3eb549cf" onClick={() => setFiltersOpen(false)} style={{ cursor: 'pointer', color: '#6b7699', fontSize: 12 }}>✕</span>
          </div>
          {filterRows.map((row, ri) => (
            <div key={ri} style={{ marginTop: 9 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 8.5, letterSpacing: 1, color: '#6b7699', fontWeight: 600, marginBottom: 5 }}>
                {row.name}{row.help && <Help title={row.help.title} text={row.help.text} />}
                <span style={{ flex: 1 }} />
                {row.reset && <span className="h3eb549cf" onClick={row.reset} style={{ fontSize: 9, color: '#8b96b8', cursor: 'pointer', letterSpacing: 0 }}>show all ✕</span>}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {row.chips.map((c, j) => (
                  <div key={j} className="h3eb549cf" onClick={c.go} style={{
                    padding: mobile ? '7px 12px' : '2px 8px', borderRadius: 999, fontSize: mobile ? 12 : 9.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                    background: c.bg, color: c.fg, border: '1px solid ' + c.bd, opacity: c.dim ? 0.6 : 1
                  }}>{c.label} <span style={{ opacity: 0.75, fontWeight: 500 }}>{c.count}</span></div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {/* The feed can list one token twice (two pools), so the id alone is not unique. */}
        {(v.rows || []).map((r, i) => (
          <div key={r.id + '|' + i} className="vs-rail-row" onClick={() => { r.pick(); if (onPick) onPick(r); }} style={{
            display: 'flex', alignItems: 'center', gap: mobile ? 10 : 7, padding: mobile ? '11px 14px 11px 12px' : '6px 12px 6px 10px', cursor: 'pointer',
            borderBottom: '1px solid #121c33', borderLeft: '2px solid ' + (r.selected ? '#e35ff2' : 'transparent'),
            animation: r.anim,
            ...(r.selected ? { background: 'rgba(227,95,242,0.10)' } : null)
          }}>
            <span className="h7a920191" onClick={r.star} style={{ fontSize: mobile ? 18 : 12, lineHeight: 1, cursor: 'pointer', color: r.starColor, flexShrink: 0, padding: mobile ? '4px 2px' : 0 }}>{r.starGlyph}</span>
            <span title={r.phase ? 'phase ' + r.phase : 'no phase yet'} style={{ width: 7, height: 7, borderRadius: '50%', background: r.phaseFg, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: mobile ? 15 : 11.5, fontWeight: 700, color: '#ffffff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sym}</div>
              <div style={{ fontSize: mobile ? 10 : 8, fontWeight: 700, color: r.chainColor, letterSpacing: 0.4, marginTop: mobile ? 2 : 0 }}>{r.chain}
                {r.phase && <span style={{ color: r.phaseFg, marginLeft: 5 }}>{r.phase}</span>}</div>
            </div>
            <span style={{ fontSize: mobile ? 12.5 : 9.5, fontWeight: 600, color: r.chgColor, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{r.chg}</span>
            {/* The call, where the score used to be (calculations/phase.js). */}
            <span title={r.signalTitle}
              style={{ minWidth: mobile ? 62 : 46, textAlign: 'center', fontSize: mobile ? 11.5 : 9.5, fontWeight: 800, letterSpacing: 0.6, color: r.signalFg,
                background: r.signalBg, border: '1px solid ' + r.signalFg + '55', borderRadius: mobile ? 8 : 6, padding: mobile ? '6px 8px' : '2px 5px', flexShrink: 0 }}>
              {r.signal}
            </span>
            {mobile && <svg width="8" height="12" viewBox="0 0 8 12" style={{ flexShrink: 0 }}><path d="M1.5 1l5 5-5 5" fill="none" stroke="#3a4568" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </div>
        ))}
        {!(v.rows || []).length && (
          <div style={{ padding: '18px 12px', fontSize: 10, color: '#4a5473', textAlign: 'center' }}>No tokens match.</div>
        )}
      </div>

      {/* Chepe's daily pick. The veto log moved to HEALTH. */}
      <div className="h1813ba3e" onClick={() => { v.openChepePick(); if (onPick) onPick(null); }} style={{
        margin: mobile ? '10px 12px calc(10px + env(safe-area-inset-bottom))' : 10, padding: '7px 10px', borderRadius: 10, cursor: 'pointer', flexShrink: 0,
        background: 'linear-gradient(135deg,rgba(43,107,255,.18),rgba(227,95,242,.18))', border: '1px solid #e35ff2',
        display: 'flex', alignItems: 'center', gap: 8
      }}>
        <img src="/assets/chepe.png" alt="Chepe" style={{ width: 34, height: 34, borderRadius: 8, objectFit: 'cover', objectPosition: 'center top', flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: 0.5, color: '#f06ee2' }}>DAILY PICK</span>
            <span style={{ fontWeight: 800, color: '#ffffff', fontSize: 11 }}>{v.chepePickSym}</span>
            <span style={{ fontSize: 9, color: '#8b96b8' }}>· {v.chepePickScore}</span>
          </div>
          <div style={{ fontSize: 8.5, color: '#a3aed0', fontStyle: 'italic', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>"{v.chepePickQuip}"</div>
        </div>
      </div>
    </div>
  );
}
