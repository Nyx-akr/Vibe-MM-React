/**
 * The admin header's token picker: every token on the board, grouped by
 * chain, with search.
 *
 * It replaced a native <select> that listed only the first 60 of the board's
 * rows - on a board of 120+ the rest could not be picked at all. This lists
 * every row, so any token the board scored can be traced on the map.
 */

import React from 'react';
import { C } from './Explain';
import { chains as CHAINS, chainColors } from '../data/chains';
import { STAGES } from '../calculations/asset-detail.js';

const ORDER = CHAINS.map((c) => c.name);
const LABEL = Object.fromEntries(CHAINS.map((c) => [c.name, c.label]));
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

/** The stage a score sits in, for the score's colour - the board's own bands. */
const STAGE_COLOR = { EXCEPTIONAL: '#ffd60a', CONFIRMED: C.pink, EMERGING: C.blue, WATCH: C.dim };
const stageOf = (score) => (STAGES.find((s) => score >= s.min) || STAGES[STAGES.length - 1]).name;

const isVetoed = (a) => Boolean(a && a.rawServerRow && a.rawServerRow.vetoed);

function Score({ a }) {
  if (isVetoed(a)) {
    return (
      <span title={(a.rawServerRow.gates.vetoes || []).map((g) => g.label).join(', ')}
        style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, color: C.hot,
          border: `1px solid ${C.hot}55`, borderRadius: 4, padding: '1px 5px' }}>VETO</span>
    );
  }
  if (a.score == null) return <span style={{ color: C.grey, fontFamily: MONO, fontSize: 11 }}>–</span>;
  const s = Math.round(a.score);
  return <span style={{ color: STAGE_COLOR[stageOf(s)] || C.dim, fontFamily: MONO, fontSize: 11, fontWeight: 700 }}>{s}</span>;
}

function ChainDot({ chain, size = 7 }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', flexShrink: 0,
    background: chainColors[chain] || C.dim, display: 'inline-block' }} />;
}

export default function TokenPicker({ assets, selectedId, onPick }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [chain, setChain] = React.useState('ALL');
  const [cursor, setCursor] = React.useState(0);
  const rootRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);

  const list = assets || [];
  const selected = list.find((a) => a.id === selectedId) || null;

  // Close on a click anywhere else.
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  React.useEffect(() => {
    if (open) { setCursor(0); setTimeout(() => inputRef.current && inputRef.current.focus(), 0); }
    else setQuery('');
  }, [open]);

  const counts = React.useMemo(() => {
    const n = {};
    list.forEach((a) => { n[a.chain] = (n[a.chain] || 0) + 1; });
    return n;
  }, [list]);
  const chainsHere = ORDER.filter((c) => counts[c]).concat(Object.keys(counts).filter((c) => !ORDER.includes(c)));

  // Chain sections in the board's chain order, each sorted by score.
  const sections = React.useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    const hit = (a) => !q || String(a.sym).toLowerCase().replace(/^\$/, '').includes(q)
      || String(a.name || '').toLowerCase().includes(q)
      || String(a.tokenAddress || '').toLowerCase() === q;
    const rank = (a) => (isVetoed(a) ? -1 : a.score == null ? -2 : a.score);
    return chainsHere
      .filter((c) => chain === 'ALL' || c === chain)
      .map((c) => ({ chain: c, rows: list.filter((a) => a.chain === c && hit(a)).sort((x, y) => rank(y) - rank(x)) }))
      .filter((s) => s.rows.length);
  }, [list, query, chain, chainsHere.join()]);
  const flat = sections.flatMap((s) => s.rows);

  React.useEffect(() => { setCursor(0); }, [query, chain]);
  // Keep the keyboard cursor in view.
  React.useEffect(() => {
    const el = listRef.current && listRef.current.querySelector('[data-cursor="1"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const pick = (a) => { if (a) onPick(a.id); setOpen(false); };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(flat[cursor]); }
    else if (e.key === 'Escape') setOpen(false);
  };

  const Tab = ({ id, label, n }) => {
    const on = chain === id;
    return (
      <button onClick={() => setChain(id)} style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontFamily: 'inherit',
        fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: '4px 8px', borderRadius: 6,
        border: `1px solid ${on ? C.pink : C.border}`, background: on ? 'rgba(227,95,242,0.1)' : 'transparent',
        color: on ? C.white : C.dim, whiteSpace: 'nowrap',
      }}>
        {id !== 'ALL' && <ChainDot chain={id} size={6} />}
        {label}
        <span style={{ color: on ? C.pink : C.faint, fontWeight: 600 }}>{n}</span>
      </button>
    );
  };

  let i = -1;
  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      {/* The trigger: the token every scoped page is describing. */}
      <button onClick={() => setOpen((o) => !o)} title="pick the token the map and the pipeline describe"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, height: 28, padding: '0 10px 0 9px',
          background: '#0d1730', border: `1px solid ${open ? C.pink : C.border}`, borderRadius: 8,
          color: C.text, fontFamily: 'inherit', cursor: 'pointer', minWidth: 190,
        }}>
        {selected ? (
          <>
            <ChainDot chain={selected.chain} />
            <span style={{ fontSize: 11, fontWeight: 700, color: C.white, maxWidth: 110, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.sym}</span>
            <span style={{ fontSize: 9, color: C.faint, fontWeight: 600 }}>{selected.chain}</span>
            <span style={{ flex: 1 }} />
            <Score a={selected} />
          </>
        ) : (
          <span style={{ fontSize: 10, color: C.faint, flex: 1, textAlign: 'left' }}>
            {list.length ? 'pick a token' : 'waiting for the first poll'}
          </span>
        )}
        <svg width="9" height="9" viewBox="0 0 10 10" style={{ marginLeft: 2, flexShrink: 0,
          transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>
          <path d="M1.5 3.5 L5 7 L8.5 3.5" fill="none" stroke={C.dim} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 360, zIndex: 100,
          background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10,
          boxShadow: '0 18px 48px rgba(0,0,0,0.55)', overflow: 'hidden',
        }}>
          <div style={{ padding: 10, borderBottom: `1px solid ${C.line}` }}>
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey}
              placeholder={'search ' + list.length + ' tokens by symbol, name or address'} spellCheck={false}
              style={{
                width: '100%', boxSizing: 'border-box', background: '#0d1730', color: C.text,
                border: `1px solid ${C.border}`, borderRadius: 7, padding: '7px 10px',
                fontFamily: 'inherit', fontSize: 11, outline: 'none',
              }} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
              <Tab id="ALL" label="ALL" n={list.length} />
              {chainsHere.map((c) => <Tab key={c} id={c} label={c} n={counts[c]} />)}
            </div>
          </div>

          <div ref={listRef} style={{ maxHeight: 380, overflowY: 'auto', padding: '4px 0 6px' }}>
            {!flat.length && (
              <div style={{ padding: '18px 12px', fontSize: 10.5, color: C.faint, textAlign: 'center' }}>
                no token matches “{query}”
              </div>
            )}
            {sections.map((s) => (
              <div key={s.chain}>
                <div style={{
                  position: 'sticky', top: 0, background: C.panel, zIndex: 1,
                  display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px 4px',
                  fontSize: 9, fontWeight: 700, letterSpacing: 0.8, color: C.dim,
                }}>
                  <ChainDot chain={s.chain} size={6} />
                  {(LABEL[s.chain] || s.chain).toUpperCase()}
                  <span style={{ color: C.faint, fontWeight: 600 }}>{s.rows.length}</span>
                  <span style={{ flex: 1, height: 1, background: C.line, marginLeft: 4 }} />
                </div>
                {s.rows.map((a) => {
                  i += 1;
                  const here = i === cursor;
                  const on = a.id === selectedId;
                  const idx = i;
                  return (
                    <div key={a.id} data-cursor={here ? '1' : '0'}
                      onMouseEnter={() => setCursor(idx)} onClick={() => pick(a)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', cursor: 'pointer',
                        background: here ? 'rgba(77,141,255,0.09)' : 'transparent',
                        borderLeft: `2px solid ${on ? C.pink : 'transparent'}`,
                      }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: on ? C.pink : C.white, minWidth: 0,
                        maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.sym}</span>
                      <span style={{ fontSize: 10, color: C.faint, flex: 1, minWidth: 0, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                      <Score a={a} />
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12, padding: '6px 12px', borderTop: `1px solid ${C.line}`,
            fontSize: 8.5, color: C.faint }}>
            <span>↑ ↓ move</span><span>enter pick</span><span>esc close</span>
            <span style={{ flex: 1 }} />
            <span>sorted by score</span>
          </div>
        </div>
      )}
    </div>
  );
}
