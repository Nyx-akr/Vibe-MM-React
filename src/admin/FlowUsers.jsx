/**
 * The header's FLOW picker: DEFAULT (the flow we build together - changes are
 * a preview, never saved) or a named user, whose every change to the map is
 * kept in their own flow file. "+" registers a new user.
 */

import React from 'react';
import { C } from './Explain';
import {
  DEFAULT_FLOW, flowUsers, activeFlowId, setActiveFlow, addUser, subscribeFlows, serverState,
} from './flow-store';

export default function FlowUsers() {
  const [, setTick] = React.useState(0);
  React.useEffect(() => subscribeFlows(() => setTick((t) => t + 1)), []);
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState('');
  const rootRef = React.useRef(null);

  React.useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setAdding(false); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const users = flowUsers();
  const active = activeFlowId();
  const activeName = active === DEFAULT_FLOW ? 'DEFAULT' : ((users.find((u) => u.id === active) || {}).name || active);
  const server = serverState();
  const register = () => {
    if (!name.trim()) return;
    addUser(name);
    setName('');
    setAdding(false);
    setOpen(false);
  };

  const row = (id, label, sub) => {
    const on = id === active;
    return (
      <div key={id} onClick={() => { setActiveFlow(id); setOpen(false); }} style={{
        display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 12px', cursor: 'pointer',
        background: on ? 'rgba(227,95,242,0.1)' : 'transparent', borderLeft: `2px solid ${on ? C.pink : 'transparent'}`,
      }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: on ? C.white : C.text }}>{label}</span>
        <span style={{ fontSize: 9, color: C.faint, flex: 1 }}>{sub}</span>
      </div>
    );
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title="whose DATA FLOW you are looking at" style={{
        display: 'flex', alignItems: 'center', gap: 7, height: 28, padding: '0 10px', borderRadius: 8, cursor: 'pointer',
        background: '#0d1730', border: `1px solid ${open ? C.pink : C.border}`, color: C.text, fontFamily: 'inherit',
      }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={active === DEFAULT_FLOW ? C.dim : C.pink}
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
        </svg>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, color: C.white }}>{activeName}</span>
        {active === DEFAULT_FLOW && <span style={{ fontSize: 8.5, color: C.faint }}>not saved</span>}
        <svg width="9" height="9" viewBox="0 0 10 10" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
          <path d="M1.5 3.5 L5 7 L8.5 3.5" fill="none" stroke={C.dim} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 260, zIndex: 100, background: C.panel,
          border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 18px 48px rgba(0,0,0,0.55)', overflow: 'hidden',
        }}>
          <div style={{ padding: '8px 12px 4px', fontSize: 8.5, fontWeight: 700, letterSpacing: 1, color: C.dim }}>FLOW</div>
          {row(DEFAULT_FLOW, 'DEFAULT', 'ours · changes are not saved')}
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px 4px', borderTop: `1px solid ${C.line}`, marginTop: 4 }}>
            <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 1, color: C.dim, flex: 1 }}>USERS</span>
            <button onClick={() => setAdding((a) => !a)} title="register a new user" style={{
              width: 20, height: 20, borderRadius: 6, cursor: 'pointer', border: `1px solid ${C.pink}`,
              background: adding ? C.pink + '33' : 'transparent', color: C.pink, fontWeight: 800, fontSize: 13, lineHeight: '16px', padding: 0,
            }}>+</button>
          </div>
          {adding && (
            <div style={{ display: 'flex', gap: 6, padding: '4px 12px 8px' }}>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="name"
                onKeyDown={(e) => { if (e.key === 'Enter') register(); if (e.key === 'Escape') setAdding(false); }}
                style={{ flex: 1, minWidth: 0, background: '#0d1730', color: C.text, border: `1px solid ${C.border}`,
                  borderRadius: 6, padding: '5px 8px', fontFamily: 'inherit', fontSize: 11, outline: 'none' }} />
              <button onClick={register} style={{ cursor: 'pointer', borderRadius: 6, border: `1px solid ${C.pink}`,
                background: C.pink + '22', color: C.white, fontSize: 9.5, fontWeight: 800, padding: '0 10px' }}>ADD</button>
            </div>
          )}
          {users.length
            ? users.map((u) => row(u.id, u.name, 'saved'))
            : !adding && <div style={{ padding: '4px 12px 10px', fontSize: 9.5, color: C.grey }}>no users yet - press + to add one</div>}
          <div style={{ padding: '6px 12px 8px', borderTop: `1px solid ${C.line}`, fontSize: 8.5, color: C.faint, lineHeight: 1.5 }}>
            {server === 'ok' ? 'user flows are saved to the server (data/app/flows)'
              : server === 'refused' ? 'the server refused the save (only this machine may write) - kept in this browser'
                : 'server not reachable or not restarted yet - user flows are kept in this browser'}
          </div>
        </div>
      )}
    </div>
  );
}
