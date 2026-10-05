import React from 'react';
import { NODES, COLUMNS, RULES } from './nodes';
import { runFlow, columnsOf, edgesOf, STATE } from './engine';
import { readRaw } from '../services/storage/raw-store';

/**
 * DATA FLOW.
 *
 * Draws the pipeline in ./nodes.js and runs it. Every number in every box was
 * produced by that box's own function, from the boxes feeding it, in the run
 * whose timing is printed at the top. Nothing here reads a value computed
 * elsewhere in the app - that was the point of the rebuild.
 *
 * The layout is deterministic: fixed box size, column by stage, row by
 * declaration order. No measuring pass, so the edges can be drawn in the same
 * render as the boxes, and a node stays where it was yesterday when a new one
 * is added beside it.
 */

const BOX_W = 186;
const BOX_H = 92;
const GAP_X = 62;
const GAP_Y = 16;
const PAD = 16;
const HEAD = 26;

const C = {
  bg: '#070b14',
  box: '#0d1424',
  boxSel: '#111c33',
  line: '#1e2a44',
  edge: '#22304d',
  edgeHot: '#4d8dff',
  text: '#dfe6f6',
  dim: '#6b7699',
  faint: '#3a4568',
  good: '#4d8dff',
  bad: '#ff4fae',
  warn: '#e3a33f',
  score: '#8f7bff',
  head: '#8b96b8',
};

const STATE_COLOR = {
  [STATE.OK]: '#2f6f4f',
  [STATE.EMPTY]: '#3a4568',
  [STATE.ERROR]: '#7a2448',
  [STATE.BLOCKED]: '#4a3a1f',
};

const ROW_COLOR = {
  good: C.good, bad: C.bad, warn: C.warn, score: C.score, dim: C.faint,
};

/** Where every node sits, computed once from the column grouping. */
function layout(nodes) {
  const cols = columnsOf(nodes, COLUMNS);
  const pos = new Map();
  cols.forEach((col, ci) => {
    col.nodes.forEach((node, ri) => {
      pos.set(node.id, {
        x: PAD + ci * (BOX_W + GAP_X),
        y: PAD + HEAD + ri * (BOX_H + GAP_Y),
        col: col.col, ci, ri,
      });
    });
  });
  const width = PAD * 2 + cols.length * (BOX_W + GAP_X) - GAP_X;
  const rows = Math.max(...cols.map((c) => c.nodes.length));
  const height = PAD * 2 + HEAD + rows * (BOX_H + GAP_Y) - GAP_Y;
  return { cols, pos, width, height };
}

/** A curve from the right edge of one box to the left edge of the next. */
function edgePath(a, b) {
  const x1 = a.x + BOX_W;
  const y1 = a.y + BOX_H / 2;
  const x2 = b.x;
  const y2 = b.y + BOX_H / 2;
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export default function FlowView() {
  const [chain, setChain] = React.useState('base');
  const [tokenAddress, setTokenAddress] = React.useState(null);
  const [tokens, setTokens] = React.useState([]);
  const [run, setRun] = React.useState(null);
  const [selected, setSelected] = React.useState(null);
  const [busy, setBusy] = React.useState(false);

  const { cols, pos, width, height } = React.useMemo(() => layout(NODES), []);
  const edges = React.useMemo(() => edgesOf(NODES), []);

  // The token picker reads the same file the flow's first node reads. It is a
  // picker, not a calculation, so it is allowed to look.
  React.useEffect(() => {
    let alive = true;
    readRaw(`${chain}/market.json`).then((m) => {
      if (!alive) return;
      const rows = ((m && m.rows) || []).filter((r) => r.tokenAddress);
      setTokens(rows.map((r) => ({ address: r.tokenAddress, symbol: r.symbol })));
      setTokenAddress((prev) => (rows.some((r) => r.tokenAddress === prev) ? prev
        : (rows[0] ? rows[0].tokenAddress : null)));
    }).catch(() => { if (alive) setTokens([]); });
    return () => { alive = false; };
  }, [chain]);

  const execute = React.useCallback(async () => {
    setBusy(true);
    try {
      setRun(await runFlow(NODES, { chain, tokenAddress, at: Date.now() }));
    } finally {
      setBusy(false);
    }
  }, [chain, tokenAddress]);

  React.useEffect(() => { if (tokenAddress) execute(); }, [execute, tokenAddress]);

  const resultOf = (id) => (run ? run.results.get(id) : null);
  const selNode = selected ? NODES.find((n) => n.id === selected) : null;
  const selRes = selected ? resultOf(selected) : null;

  const lit = React.useMemo(() => {
    if (!selected) return null;
    const up = new Set(); const down = new Set();
    const byId = new Map(NODES.map((n) => [n.id, n]));
    const walkUp = (id) => (byId.get(id)?.deps || []).forEach((d) => {
      if (!up.has(d)) { up.add(d); walkUp(d); }
    });
    const walkDown = (id) => NODES.filter((n) => (n.deps || []).includes(id)).forEach((n) => {
      if (!down.has(n.id)) { down.add(n.id); walkDown(n.id); }
    });
    walkUp(selected); walkDown(selected);
    return { up, down };
  }, [selected]);

  const isLit = (id) => !selected || id === selected || lit.up.has(id) || lit.down.has(id);
  const edgeLit = (e) => !selected
    || ((e.from === selected || lit.up.has(e.from) || lit.down.has(e.from))
      && (e.to === selected || lit.up.has(e.to) || lit.down.has(e.to)));

  const counts = run ? run.counts : {};
  const verdict = resultOf('v.fit');
  const tier = resultOf('v.tier');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>

      {/* controls + the one-line answer the whole graph exists to produce */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '10px 12px', background: C.box, border: `1px solid ${C.line}`,
        borderRadius: 8, marginBottom: 10,
      }}>
        <span style={{ fontSize: 9, letterSpacing: 1.2, color: C.head, fontWeight: 700 }}>TRACE</span>
        <select
          value={chain} onChange={(e) => setChain(e.target.value)}
          style={selectStyle}
        >
          {['solana', 'ethereum', 'base', 'bsc', 'arbitrum', 'polygon', 'avalanche', 'robinhood']
            .map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={tokenAddress || ''} onChange={(e) => setTokenAddress(e.target.value)}
          style={{ ...selectStyle, minWidth: 150 }}
        >
          {tokens.map((t) => <option key={t.address} value={t.address}>{t.symbol}</option>)}
        </select>
        <button onClick={execute} disabled={busy} style={buttonStyle}>
          {busy ? 'running…' : 'run again'}
        </button>

        <div style={{ flex: 1 }} />

        {run && (
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', fontSize: 10, color: C.dim }}>
            <span>{run.ms}ms</span>
            <span style={{ color: C.good }}>{counts.ok || 0} ok</span>
            <span style={{ color: C.faint }}>{counts.empty || 0} empty</span>
            {counts.error ? <span style={{ color: C.bad }}>{counts.error} error</span> : null}
            {counts.blocked ? <span style={{ color: C.warn }}>{counts.blocked} blocked</span> : null}
          </div>
        )}
        {verdict && verdict.value && (
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 8, paddingLeft: 14,
            borderLeft: `1px solid ${C.line}`,
          }}>
            <span style={{ fontSize: 9, color: C.head, letterSpacing: 1 }}>FIT</span>
            <span style={{ fontSize: 20, fontWeight: 800, color: C.score }}>{verdict.value.fit}</span>
            {tier && tier.value && (
              <span style={{
                fontSize: 10, fontWeight: 800, letterSpacing: 1, padding: '2px 8px',
                borderRadius: 999, color: tier.value.tier === 'A' ? C.good : tier.value.tier === 'X' ? C.bad : C.dim,
                border: `1px solid ${tier.value.tier === 'A' ? C.good : tier.value.tier === 'X' ? C.bad : C.line}`,
              }}>{tier.value.tier} · {tier.value.label}</span>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, flex: 1, minHeight: 0 }}>

        {/* the graph */}
        <div style={{
          flex: 1, minWidth: 0, overflow: 'auto', background: C.bg,
          border: `1px solid ${C.line}`, borderRadius: 8,
        }}>
          <div style={{ position: 'relative', width, height }}>

            <svg width={width} height={height} style={{ position: 'absolute', inset: 0 }}>
              {edges.map((e, i) => {
                const a = pos.get(e.from); const b = pos.get(e.to);
                if (!a || !b) return null;
                const from = resultOf(e.from);
                const carrying = from && from.state === STATE.OK;
                const on = edgeLit(e);
                return (
                  <path
                    key={i} d={edgePath(a, b)} fill="none"
                    stroke={on && carrying ? C.edgeHot : C.edge}
                    strokeWidth={on && carrying ? 1.4 : 1}
                    opacity={on ? (carrying ? 0.75 : 0.4) : 0.08}
                  />
                );
              })}
            </svg>

            {cols.map((col) => (
              <div key={col.col} style={{
                position: 'absolute',
                left: pos.get(col.nodes[0].id).x,
                top: PAD, width: BOX_W,
                fontSize: 9, letterSpacing: 1.4, fontWeight: 800, color: C.head,
              }}>{col.col}</div>
            ))}

            {NODES.map((node) => {
              const p = pos.get(node.id);
              const r = resultOf(node.id);
              const on = isLit(node.id);
              const isSel = selected === node.id;
              const rows = r && r.state === STATE.OK && node.show
                ? (() => { try { return node.show(r.value) || []; } catch (e) { return []; } })()
                : [];
              return (
                <div
                  key={node.id}
                  onClick={() => setSelected(isSel ? null : node.id)}
                  style={{
                    position: 'absolute', left: p.x, top: p.y, width: BOX_W, height: BOX_H,
                    background: isSel ? C.boxSel : C.box,
                    border: `1px solid ${isSel ? C.edgeHot : C.line}`,
                    borderLeft: `3px solid ${r ? STATE_COLOR[r.state] : C.line}`,
                    borderRadius: 7, padding: '7px 9px', cursor: 'pointer',
                    opacity: on ? 1 : 0.22, overflow: 'hidden',
                    transition: 'opacity 140ms ease, background 140ms ease',
                  }}
                >
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6,
                  }}>
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {node.title}
                    </span>
                    {r && r.ms > 1 ? <span style={{ fontSize: 8.5, color: C.faint }}>{r.ms}ms</span> : null}
                  </div>

                  {rows.length ? rows.slice(0, 3).map((row, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 3,
                      fontSize: 9.5, lineHeight: 1.35,
                    }}>
                      <span style={{ color: C.dim, whiteSpace: 'nowrap' }}>{row.k}</span>
                      <span style={{
                        color: ROW_COLOR[row.c] || C.text, fontWeight: row.c === 'score' ? 700 : 500,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      }}>{String(row.v)}</span>
                    </div>
                  )) : (
                    <div style={{ marginTop: 6, fontSize: 9.5, color: C.faint }}>
                      {!r ? '—'
                        : r.state === STATE.EMPTY ? 'no value'
                        : r.state === STATE.ERROR ? r.error
                        : r.state === STATE.BLOCKED ? `blocked by ${r.blockedBy[0]}`
                        : '—'}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* what the selected box actually produced */}
        <div style={{
          width: 310, flexShrink: 0, overflow: 'auto', background: C.box,
          border: `1px solid ${C.line}`, borderRadius: 8, padding: 12,
        }}>
          {!selNode ? (
            <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.7 }}>
              <div style={{ fontSize: 9, letterSpacing: 1.2, color: C.head, fontWeight: 700, marginBottom: 8 }}>
                THE PIPELINE
              </div>
              Six stages, left to right. Click a box to see what it returned, what
              fed it, and what it feeds.
              <div style={{ marginTop: 10, color: C.faint }}>
                Every value is computed here, in <code style={{ color: C.dim }}>src/flow/nodes.js</code>,
                from the boxes to its left. Nothing is read from the dashboard.
              </div>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
                <div style={{ color: C.head, marginBottom: 5 }}>Gates in force</div>
                <Line k="tax ceiling" v={`${RULES.gates.maxTaxPct}%`} />
                <Line k="liquidity" v={`$${RULES.gates.minLiquidityUsd.toLocaleString()}`} />
                <Line k="volume 24h" v={`$${RULES.gates.minVolume24hUsd.toLocaleString()}`} />
                <Line k="age" v={`${RULES.gates.minAgeHours / 24} days`} />
                <Line k="major cap" v={`$${RULES.gates.majorMarketCapUsd / 1e9}B`} />
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 9, letterSpacing: 1.2, color: C.head, fontWeight: 700 }}>
                {pos.get(selNode.id).col}
              </div>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.text, margin: '4px 0 6px' }}>
                {selNode.title}
              </div>
              <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.6, marginBottom: 10 }}>
                {selNode.note}
              </div>

              <div style={{ fontSize: 9.5, color: C.faint, marginBottom: 8 }}>
                <code>{selNode.id}</code>
                {selRes ? ` · ${selRes.state} · ${selRes.ms}ms` : ''}
              </div>

              {selNode.deps && selNode.deps.length ? (
                <Block title="FED BY">
                  {selNode.deps.map((d) => {
                    const dn = NODES.find((n) => n.id === d);
                    const dr = resultOf(d);
                    return (
                      <div key={d} onClick={() => setSelected(d)} style={linkRow}>
                        <span style={{ color: dr && dr.state === STATE.OK ? C.good : C.faint }}>●</span>
                        <span style={{ color: C.dim }}>{dn ? dn.title : d}</span>
                      </div>
                    );
                  })}
                </Block>
              ) : <Block title="FED BY"><div style={{ color: C.faint, fontSize: 10 }}>a raw file — nothing upstream</div></Block>}

              <Block title="FEEDS">
                {(() => {
                  const outs = NODES.filter((n) => (n.deps || []).includes(selNode.id));
                  if (!outs.length) return <div style={{ color: C.faint, fontSize: 10 }}>nothing — this is an output</div>;
                  return outs.map((n) => (
                    <div key={n.id} onClick={() => setSelected(n.id)} style={linkRow}>
                      <span style={{ color: C.faint }}>→</span>
                      <span style={{ color: C.dim }}>{n.title}</span>
                    </div>
                  ));
                })()}
              </Block>

              <Block title="RETURNED">
                <pre style={{
                  margin: 0, fontSize: 9.5, lineHeight: 1.5, color: C.text,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto',
                }}>
                  {selRes ? safeJson(selRes.value, selRes) : '—'}
                </pre>
              </Block>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Block({ title, children }) {
  return (
    <div style={{ marginBottom: 12, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
      <div style={{ fontSize: 8.5, letterSpacing: 1.2, color: C.head, fontWeight: 700, marginBottom: 5 }}>{title}</div>
      {children}
    </div>
  );
}

function Line({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, marginTop: 2 }}>
      <span style={{ color: C.faint }}>{k}</span><span style={{ color: C.dim }}>{v}</span>
    </div>
  );
}

const linkRow = {
  display: 'flex', gap: 6, alignItems: 'center', fontSize: 10,
  padding: '2px 0', cursor: 'pointer',
};

const selectStyle = {
  background: '#0a1226', color: C.text, border: `1px solid ${C.line}`,
  borderRadius: 6, padding: '4px 8px', fontSize: 10.5, outline: 'none',
};

const buttonStyle = {
  background: '#0e2a5c', color: '#6ea0ff', border: '1px solid #4d8dff',
  borderRadius: 6, padding: '4px 12px', fontSize: 10.5, cursor: 'pointer',
};

/** Large arrays would bury the panel, so they are summarised rather than dumped. */
function safeJson(value, result) {
  if (value === null || value === undefined) {
    if (result && result.state === STATE.ERROR) return 'error: ' + result.error;
    if (result && result.state === STATE.BLOCKED) return 'blocked by ' + result.blockedBy.join(', ');
    return 'null — this node ran and produced nothing';
  }
  try {
    return JSON.stringify(value, (k, v) => {
      if (Array.isArray(v) && v.length > 6) return `[${v.length} items] ` + JSON.stringify(v.slice(0, 2));
      return v;
    }, 1);
  } catch (e) {
    return String(value);
  }
}
