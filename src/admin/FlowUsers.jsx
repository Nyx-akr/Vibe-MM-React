/**
 * The header's FLOW picker: DEFAULT (the flow we build together - changes are
 * a preview, never saved), one ENGINE profile per engine (flow-store.js
 * ENGINE_PROFILES - each runs the app on that engine's call, and its changes
 * are saved), or a named user, whose every change to the map is kept in their
 * own flow file. "+" registers a new user.
 */

import React from 'react';
import { C } from './Explain';
import {
  DEFAULT_FLOW, flowUsers, activeFlowId, setActiveFlow, addUser, subscribeFlows, serverState, engineProfiles,
} from './flow-store';
import { engineGrade, loadModelEval } from '../services/model-eval';
import { DEFAULT_HOLD_HOURS, DEFAULT_TRADE_USD } from '../flow/score-flow';
import { getSetting } from './box-settings';

/**
 * mode 'engine' is the main page's ENGINE picker (it replaced the REGIME
 * button): DEFAULT and the engines with their grades, no users, no server line.
 */
export default function FlowUsers({ mode } = {}) {
  const engineMode = mode === 'engine';
  const [, setTick] = React.useState(0);
  React.useEffect(() => subscribeFlows(() => setTick((t) => t + 1)), []);
  const [open, setOpen] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState('');
  const rootRef = React.useRef(null);

  // The engines' grades (raw/model-eval.json), fetched when the list opens.
  React.useEffect(() => {
    if (open) loadModelEval().then(() => setTick((t) => t + 1)).catch(() => {});
  }, [open]);
  React.useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setAdding(false); } };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const users = flowUsers();
  const profiles = engineProfiles();
  const active = activeFlowId();
  // On the main page DEFAULT is named by the engine it runs.
  const activeName = active === DEFAULT_FLOW ? (engineMode ? 'QUALITY ROTATION' : 'DEFAULT')
    : ((profiles.find((p) => p.id === active) || users.find((u) => u.id === active) || {}).name || active);
  // How each engine's BUY entries did in the last backtest (raw/model-eval.json engines).
  // Graded at the TIME FRAME in force: the chosen one, else each engine's own window.
  const chosenHours = getSetting('param:plan.horizonHours', { n: null }).n;
  const windowOf = () => (Number.isFinite(chosenHours) ? chosenHours : DEFAULT_HOLD_HOURS);
  // ...and NET of a round trip at the TRADE SIZE in force.
  const sizeSet = getSetting('param:plan.tradeUsd', { n: null }).n;
  const tradeUsd = Number.isFinite(sizeSet) ? sizeSet : DEFAULT_TRADE_USD;
  const gradeOf = (key) => { try { return engineGrade(key, windowOf(key), tradeUsd); } catch (e) { return null; } };
  // The best engine, by what the list shows: the highest share of BUY entries
  // that won (then the higher average), among engines with at least 100
  // graded entries that also made money on hours their line was not tuned on
  // (at least 30 trades there) - so a lucky streak on a handful cannot win it.
  const bestKey = (() => {
    let best = null;
    profiles.forEach((p) => {
      const g = gradeOf(p.engine);
      if (!g || g.n < 100 || !g.test || g.test.n < 30 || g.test.avg <= 0) return;
      if (!best || g.win > best.win || (g.win === best.win && g.avg > best.avg)) best = { key: p.engine, win: g.win, avg: g.avg };
    });
    return best ? best.key : null;
  })();
  const GOOD = '#3ddc97'; const BAD = '#ff4fae'; const FLAT = '#ffb454';
  const pc = (x) => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
  const gradeView = (key) => {
    const g = gradeOf(key);
    if (!g) return <span style={{ fontSize: 9, color: C.faint }}>not graded yet</span>;
    const vs = g.board ? g.win - g.board.win : 0;
    // Net of cost there is no every-token baseline: green when it makes money after cost.
    const col = g.net ? (g.avg > 0 ? GOOD : g.avg > -0.5 ? FLAT : BAD) : vs >= 3 ? GOOD : vs <= -1 ? BAD : FLAT;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        title={'BUY entries over every hour, as a ' + g.horizon + ' trade: ' + Math.round(g.win) + '% won, ' + pc(g.avg) + ' average, ' + g.n + ' trades.' +
          (g.board ? '\nEvery token, same trade: ' + Math.round(g.board.win) + '% won, ' + pc(g.board.avg) + '.' : '') +
          (g.test ? '\nOn hours its BUY line was not tuned on (line ' + g.test.line + '): ' + Math.round(g.test.win) + '% won, ' + pc(g.test.avg) + ', ' + g.test.n + ' trades.' : '') + (Number.isFinite(g.median) ? '\nMedian trade ' + pc(g.median) + '; average win ' + pc(g.avgWin) + ', average loss ' + pc(g.avgLoss) + ' - few big winners can lift the average while most trades lose.' : '')}>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 9, color: g.avg >= 0 ? GOOD : BAD, fontWeight: 700 }}>{pc(g.avg)} avg</div>
          {Number.isFinite(g.median) && <div style={{ fontSize: 8, color: g.median >= 0 ? GOOD : BAD }}>median {pc(g.median)}</div>}
          {Number.isFinite(g.avgWin) && Number.isFinite(g.avgLoss) && <div style={{ fontSize: 7.5, color: C.faint }}>win {pc(g.avgWin)} · loss {pc(g.avgLoss)}</div>}
          {g.test && <div style={{ fontSize: 8, color: g.test.n < 30 ? C.faint : g.test.avg >= 0 ? GOOD : BAD }}>{g.test.vsMarket ? 'unseen vs mkt ' : 'unseen '}{pc(g.test.avg)} · {g.test.n}{g.test.n < 30 ? ' (too few)' : ''}</div>}
        </div>
        <div style={{ minWidth: 46, textAlign: 'right' }}>
          <div style={{ fontSize: 16, fontWeight: 800, lineHeight: 1, color: col }}>{Math.round(g.win)}%</div>
          <div style={{ position: 'relative', height: 4, borderRadius: 2, background: '#1c2a4d', marginTop: 3 }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: Math.max(0, Math.min(100, g.win)) + '%', background: col, borderRadius: 2 }} />
            {g.board && <div style={{ position: 'absolute', top: -2, bottom: -2, width: 1, left: Math.min(100, g.board.win) + '%', background: C.white }} />}
          </div>
          <div style={{ fontSize: 7.5, color: C.faint, marginTop: 2 }}>won{g.net ? ' net' : ''} · {g.horizon} · n {g.n}</div>
        </div>
      </div>
    );
  };
  const server = serverState();
  const register = () => {
    if (!name.trim()) return;
    addUser(name);
    setName('');
    setAdding(false);
    setOpen(false);
  };

  const row = (id, label, sub, detail, chain, grade, best) => {
    const on = id === active;
    return (
      <div key={id} onClick={() => { setActiveFlow(id); setOpen(false); }} style={{
        padding: '7px 12px', cursor: 'pointer',
        background: on ? 'rgba(227,95,242,0.1)' : 'transparent', borderLeft: `2px solid ${on ? C.pink : 'transparent'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: on ? C.white : C.text }}>{label}</span>
            {best && <span style={{ marginLeft: 6, fontSize: 8, fontWeight: 800, color: '#0a1226', background: GOOD, borderRadius: 3, padding: '1px 4px' }}>★ BEST</span>}
            {sub && <span style={{ marginLeft: 6, fontSize: 9, color: C.faint }}>{sub}</span>}
          </div>
          {grade}
        </div>
        {detail && <div style={{ fontSize: 9, color: C.grey, lineHeight: 1.4, marginTop: 2 }}>{detail}</div>}
        {chain && (
          <div style={{ fontSize: 8, color: on ? C.text : C.faint, lineHeight: 1.5, marginTop: 2 }}>
            {chain.concat(['SIGNAL']).join(' → ')}
          </div>
        )}
      </div>
    );
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button onClick={() => setOpen((o) => !o)} title={engineMode ? 'the engine the app runs on - pick another' : 'whose DATA FLOW you are looking at'} style={{
        display: 'flex', alignItems: 'center', gap: 7, height: 28, padding: '0 10px', borderRadius: engineMode ? 999 : 8, cursor: 'pointer',
        background: '#0d1730', border: `1px solid ${open ? C.pink : C.border}`, color: C.text, fontFamily: 'inherit',
      }}>
        {engineMode && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: C.dim }}>ENGINE:</span>}
        {!engineMode && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={active === DEFAULT_FLOW ? C.dim : C.pink}
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
        </svg>}
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.5, color: C.white }}>{activeName}</span>
        {active === DEFAULT_FLOW && !engineMode && <span style={{ fontSize: 8.5, color: C.faint }}>not saved</span>}
        <svg width="9" height="9" viewBox="0 0 10 10" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>
          <path d="M1.5 3.5 L5 7 L8.5 3.5" fill="none" stroke={C.dim} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 380, zIndex: 100, maxHeight: '80vh', overflowY: 'auto', background: C.panel,
          border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
        }}>
          <div style={{ padding: '8px 12px 4px', fontSize: 8.5, fontWeight: 700, letterSpacing: 1, color: C.dim }}>{engineMode ? 'ENGINE' : 'FLOW'}</div>
          {row(DEFAULT_FLOW, 'DEFAULT', engineMode ? 'runs QUALITY ROTATION' : 'ours · QUALITY ROTATION engine · changes are not saved')}
          <div style={{ padding: '8px 12px 4px', borderTop: `1px solid ${C.line}`, marginTop: 4, fontSize: 8.5, fontWeight: 700, letterSpacing: 1, color: C.dim }}>
            ENGINES <span style={{ fontWeight: 400, letterSpacing: 0, color: C.faint }}>· each runs the app on its own call</span>
            <div style={{ fontWeight: 400, letterSpacing: 0, color: C.faint, marginTop: 3, fontSize: 8 }}>
              big number = share of BUY entries that won AFTER the round-trip cost of a ${tradeUsd.toLocaleString('en-US')} trade, held {windowOf()}h ({Number.isFinite(chosenHours) ? 'chosen' : 'auto'}) · avg = average return after cost (a few big winners lift it - see median) · unseen = the same on the last 40% of hours · ★ BEST = highest win share that also paid on unseen hours · set size and time frame in TRADE PLAN
            </div>
          </div>
          {profiles.map((p) => row(p.id, p.name, null, p.blurb, p.chain, gradeView(p.engine), p.engine === bestKey))}
          {!engineMode && <>
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
                : server === 'unknown' ? 'checking the server…'
                : 'server not reachable or not restarted yet - user flows are kept in this browser'}
          </div>
          </>}
        </div>
      )}
    </div>
  );
}
