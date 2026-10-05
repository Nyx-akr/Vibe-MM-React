import React from 'react';
import { fmtUsd, chainColor } from '../utils/formatters';
import { chainKeyToName } from '../data/chains';
import {
  rotationChains, rotationGraphFor, rotationIntelStatus,
} from '../services/rotation-intel';

/**
 * Where capital is rotating across every chain we watch, as ribbons.
 *
 * WHY RIBBONS HERE, WHEN ROTATION DROPPED THEM
 *
 * The per-token ROTATION tab tried a sankey and went back to bars, for two
 * reasons (see egoBars() in ROTATION.jsx): a ribbon floor to fit its label
 * destroyed the width encoding, and a hub node implied conservation that
 * rotation does not have. This chart is laid out so neither applies:
 *
 *   - LABELS LIVE ON THE NODES, NOT THE RIBBONS. Nodes are separated by a
 *     fixed gap tall enough for a label, so a ribbon can be exactly as thick
 *     as its dollars say - a $58 flow next to a $5.9K one is drawn 100x
 *     thinner, not floored to legibility. The only floor is a 1px hairline so
 *     a real flow never disappears entirely.
 *   - NO HUB. It is bipartite: pools capital LEFT on the left, pools it
 *     ARRIVED at on the right. A pool can sit in both columns, and nothing
 *     says its two sides must balance.
 *
 * Every ribbon is one DIRECTED flow: an edge's dominant share drawn source to
 * target, and its counter share (if any) drawn back the other way as its own
 * ribbon. Nothing is netted, so no ribbon carries dollars that did not move
 * that way.
 *
 * WHAT IT DOES NOT CLAIM
 *
 * That this is the market. It is rotation among the pools the sampler has
 * reached, per chain, so every total is a floor. Rotation is measured within
 * one chain and ribbons never cross chains. All chains share ONE scale, so a
 * thin chain is drawn thin rather than stretched to fill its box.
 */

/* --------------------------------------------------------------- style --- */

const CARD = 'background:#0a1226;border:1px solid #1c2a4d;border-radius:10px';
const CAP = 'font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600';

const OUT = '#ff4fae';
const IN = '#4d8dff';
const NEUTRAL = '#6b7699';

/* ------------------------------------------------------------- layout --- */

/** Flows drawn per chain. The rest are counted in the caption, never hidden silently. */
const FLOWS_PER_CHAIN = 10;
/** Height the busiest chain's column is scaled to; every chain shares that scale. */
const TARGET_H = 280;
/** Space between nodes - it is what carries each label, so ribbons need no floor. */
const GAP = 16;
/** Chains below either line are drawn, but marked as a thin read. */
const THIN_POOLS = 5;
const THIN_PATHS = 3;

const W = 1000;
const NODE_W = 9;
const LEFT_X = 170;
const RIGHT_X = W - 170 - NODE_W;
const PAD = 10;

/* ---------------------------------------------------------- formatting --- */

const tick = (s) => '$' + String(s).replace(/^\$/, '').toUpperCase();
const poolLabel = (a) => {
  const s = String(a || '');
  return s.length > 10 ? 'pool ' + s.slice(0, 4) + '…' + s.slice(-4) : 'pool ' + (s || '?');
};
const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtUsd(Math.abs(v));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

const ago = (ms) => {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return (s / 3600).toFixed(1) + 'h ago';
};

const span = (fromMs, toMs) => {
  if (!fromMs || !toMs || toMs <= fromMs) return null;
  const m = (toMs - fromMs) / 60000;
  if (m < 90) return Math.round(m) + 'm';
  if (m < 1440) return (m / 60).toFixed(1) + 'h';
  return Math.round(m / 1440) + 'd';
};

/* -------------------------------------------------------------- flows --- */

/**
 * One chain's graph as directed flows, labelled.
 *
 * Tickers that repeat within the chain get their address tail, for the same
 * reason the ROTATION tab does it: "$STONK -> $STONK" is two pools, not one.
 */
function chainFlows(graph) {
  const tickerCount = new Map();
  const symbolOf = new Map();
  (graph.nodes || []).forEach((n) => {
    symbolOf.set(n.poolAddress, n.symbol);
    if (!n.symbol) return;
    const k = tick(n.symbol);
    tickerCount.set(k, (tickerCount.get(k) || 0) + 1);
  });
  const labelFor = (pool) => {
    const symbol = symbolOf.get(pool);
    if (!symbol) return poolLabel(pool);
    const base = tick(symbol);
    return (tickerCount.get(base) || 0) < 2 ? base : base + '·' + String(pool).slice(-4);
  };

  const flows = [];
  (graph.edges || []).forEach((e) => {
    if (e.dominantUsd > 0) {
      flows.push({ from: e.sourcePool, to: e.targetPool, usd: e.dominantUsd, wallets: e.sharedWallets });
    }
    if (e.counterUsd > 0) {
      flows.push({ from: e.targetPool, to: e.sourcePool, usd: e.counterUsd, wallets: e.sharedWallets });
    }
  });
  flows.sort((a, b) => b.usd - a.usd);
  return { flows, labelFor };
}

/**
 * Places nodes and ribbons for one chain at a given px-per-dollar.
 *
 * Sources are ordered by outflow and targets by inflow, largest on top; each
 * node's ribbons are stacked in the order of the node at their other end, so
 * ribbons cross as little as the ordering allows.
 */
function layoutChain(drawn, labelFor, scale) {
  const sumBy = (key) => {
    const m = new Map();
    drawn.forEach((f) => m.set(f[key], (m.get(f[key]) || 0) + f.usd));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const srcs = sumBy('from');
  const tgts = sumBy('to');

  const colH = (list) => list.reduce((s, [, usd]) => s + usd * scale, 0) + Math.max(0, list.length - 1) * GAP;
  const hL = colH(srcs);
  const hR = colH(tgts);
  const inner = Math.max(hL, hR, GAP);

  const place = (list, colHeight, side) => {
    let y = PAD + (inner - colHeight) / 2;
    return list.map(([pool, usd]) => {
      const h = usd * scale;
      const node = { pool, usd, side, y, h, label: labelFor(pool), cursor: y };
      y += h + GAP;
      return node;
    });
  };
  const left = place(srcs, hL, 'out');
  const right = place(tgts, hR, 'in');
  const leftAt = new Map(left.map((n) => [n.pool, n]));
  const rightAt = new Map(right.map((n) => [n.pool, n]));

  // Stack at the source in target order, and at the target in source order.
  const bySrc = drawn.slice().sort((a, b) =>
    (leftAt.get(a.from).y - leftAt.get(b.from).y) || (rightAt.get(a.to).y - rightAt.get(b.to).y));
  const ribbons = new Map();
  bySrc.forEach((f) => {
    const s = leftAt.get(f.from);
    const t = f.usd * scale;
    ribbons.set(f, { y0: s.cursor, t });
    s.cursor += t;
  });
  drawn.slice()
    .sort((a, b) => (rightAt.get(a.to).y - rightAt.get(b.to).y) || (leftAt.get(a.from).y - leftAt.get(b.from).y))
    .forEach((f) => {
      const n = rightAt.get(f.to);
      const r = ribbons.get(f);
      r.y1 = n.cursor;
      n.cursor += r.t;
    });

  const x0 = LEFT_X + NODE_W;
  const x1 = RIGHT_X;
  const mx = (x0 + x1) / 2;
  const paths = drawn.map((f, i) => {
    const r = ribbons.get(f);
    // A 1px hairline so a real flow never vanishes; otherwise exact.
    const t = Math.max(r.t, 1);
    const a = r.y0 + (r.t - t) / 2;
    const b = r.y1 + (r.t - t) / 2;
    return {
      key: f.from + '>' + f.to + ':' + i,
      from: f.from,
      to: f.to,
      d: 'M' + x0 + ',' + a +
        ' C' + mx + ',' + a + ' ' + mx + ',' + b + ' ' + x1 + ',' + b +
        ' L' + x1 + ',' + (b + t) +
        ' C' + mx + ',' + (b + t) + ' ' + mx + ',' + (a + t) + ' ' + x0 + ',' + (a + t) + ' Z',
      tip: plural(f.wallets, 'shared wallet') + ' · ' + fmtUsd(f.usd) + ' left ' +
        labelFor(f.from) + ' for ' + labelFor(f.to),
    };
  });

  return { left, right, paths, height: inner + PAD * 2 };
}

/* ============================================================== values === */

export function marketRotationVals(app) {
  if (app.state.page !== 'market') return { isMarket: false };

  const svc = rotationIntelStatus();
  const assets = app.assets || [];
  const openFor = (poolAddress) => {
    const hit = assets.find((a) => a.poolAddress === poolAddress);
    return hit ? () => app.setState({ page: 'rotation', selectedId: hit.id }) : null;
  };

  const held = rotationChains()
    .map((c) => ({ ...c, graph: rotationGraphFor(c.chain) }))
    .filter((c) => c.graph);

  const built = held.map((c) => {
    const { flows, labelFor } = chainFlows(c.graph);
    const drawn = flows.slice(0, FLOWS_PER_CHAIN);
    return { ...c, flows, drawn, labelFor };
  });
  const rotating = built.filter((c) => c.drawn.length);
  const quiet = built.filter((c) => !c.drawn.length);

  // One scale for every chain, set by the busiest column anywhere.
  const colUsd = (drawn, key) => {
    const m = new Map();
    drawn.forEach((f) => m.set(f[key], (m.get(f[key]) || 0) + f.usd));
    return [...m.values()].reduce((s, x) => s + x, 0);
  };
  const maxCol = Math.max(1, ...rotating.map((c) => Math.max(colUsd(c.drawn, 'from'), colUsd(c.drawn, 'to'))));
  const scale = TARGET_H / maxCol;

  const chains = rotating.map((c) => {
    const g = c.graph;
    const name = chainKeyToName[c.chain] || c.chain.toUpperCase();
    const drawnUsd = c.drawn.reduce((s, f) => s + f.usd, 0);
    const windowSpan = span(g.firstTradeAt, g.lastTradeAt);
    const thin = g.poolsSampled < THIN_POOLS || (g.pathsRotating || 0) < THIN_PATHS;
    const lay = layoutChain(c.drawn, c.labelFor, scale);
    const node = (n) => ({
      ...n,
      open: openFor(n.pool),
      val: fmtUsd(n.usd),
      tip: n.label + (n.side === 'out' ? ' lost ' : ' gained ') + fmtUsd(n.usd) + ' across the flows drawn here',
    });
    return {
      key: c.chain,
      name,
      color: chainColor(name),
      thin,
      window: [
        plural(g.poolsSampled, 'pool') + ' sampled',
        plural(g.sharedWalletCount, 'shared wallet'),
        windowSpan ? 'over ' + windowSpan : null,
        'built ' + ago(g.builtAt),
      ].filter(Boolean).join(' · '),
      rotated: fmtUsd(g.rotatedUsd),
      // Both in dollars, both over directed flows, so the two can sit together.
      drawnNote: c.drawn.length < c.flows.length
        ? 'the ' + c.drawn.length + ' largest of ' + c.flows.length + ' flows · ' + fmtUsd(drawnUsd) + ' of ' + fmtUsd(g.rotatedUsd)
        : plural(c.drawn.length, 'flow') + ' · all of ' + fmtUsd(g.rotatedUsd),
      height: lay.height,
      left: lay.left.map(node),
      right: lay.right.map(node),
      paths: lay.paths,
    };
  });

  // Net winners and losers, from the same graphs the ribbons came from, so the
  // list and the chart describe one moment rather than two.
  const nodes = held.flatMap((c) => {
    const { labelFor } = chainFlows(c.graph);
    return (c.graph.nodes || [])
      .filter((n) => n.rotatedUsd > 0 && n.netRotationUsd !== 0)
      .map((n) => {
        const name = chainKeyToName[c.chain] || c.chain.toUpperCase();
        return {
          key: c.chain + ':' + n.poolAddress,
          label: labelFor(n.poolAddress),
          chain: name,
          chainColor: chainColor(name),
          net: n.netRotationUsd,
          val: signed(n.netRotationUsd),
          open: openFor(n.poolAddress),
          tip: 'took in ' + fmtUsd(n.inUsd) + ', gave up ' + fmtUsd(n.outUsd) + ' on ' + c.chain,
        };
      });
  });
  const gainers = nodes.filter((n) => n.net > 0).sort((a, b) => b.net - a.net).slice(0, 6);
  const losers = nodes.filter((n) => n.net < 0).sort((a, b) => a.net - b.net).slice(0, 6);

  const poolsSampled = held.reduce((s, c) => s + (c.graph.poolsSampled || 0), 0);
  const rotatedUsd = held.reduce((s, c) => s + (c.graph.rotatedUsd || 0), 0);
  const parallelUsd = held.reduce((s, c) => s + (c.graph.parallelUsd || 0), 0);

  return {
    isMarket: true,
    mrService: !svc.running
      ? 'Background rotation service is not running.'
      : plural(svc.chainsHeld, 'chain') + ' watched · rebuilt ' + ago(svc.lastTickAt) + ' · rides the wallet sample',
    mrServiceLive: svc.running && !svc.lastError,
    mrNotice: app.state.serverError
      ? 'The raw store is unreachable, so no trade samples could be read.'
      : !held.length
        ? 'No chain has been sampled yet. The rotation graph is built from the wallet sampler’s first pass, which lands within a few seconds of the collector running.'
        : !rotating.length
          ? 'Every sampled chain is quiet: shared wallets exist, but none sold one pool and bought another in this window.'
          : '',
    mrStats: [
      {
        label: 'MEASURED ROTATION', value: fmtUsd(rotatedUsd), color: IN,
        note: 'across ' + plural(rotating.length, 'chain'),
        tip: 'Sum of each chain’s rotation among its sampled pools. A floor: only sampled pools can take part, and nothing crosses chains.',
      },
      {
        label: 'POOLS SAMPLED', value: String(poolsSampled), color: '#4fc3f7',
        note: 'on ' + plural(held.length, 'chain'),
        tip: 'Pools the sampler has reached. This is the coverage every other number on the page rests on.',
      },
      {
        label: 'PARALLEL — EXCLUDED', value: fmtUsd(parallelUsd), color: NEUTRAL,
        note: 'bought both, or sold both',
        tip: 'Shared wallets moving the same way in two pools. Holding two positions is not capital moving between them.',
      },
    ],
    mrChains: chains,
    mrQuiet: quiet.length
      ? 'No directed rotation on ' + quiet.map((c) => c.chain + ' (' + plural(c.graph.poolsSampled, 'pool') + ')').join(', ')
      : '',
    mrGainers: gainers,
    mrLosers: losers,
  };
}

/* ============================================================== render === */

function ChainRibbons({ c, css, v }) {
  const [hot, setHot] = React.useState(null);
  const lit = (p) => !hot || p.from === hot || p.to === hot;

  const label = (n, i) => {
    const onLeft = n.side === 'out';
    const cy = n.y + n.h / 2;
    const x = onLeft ? LEFT_X - 8 : RIGHT_X + NODE_W + 8;
    const dim = hot && hot !== n.pool;
    return (
      <g
        key={n.side + i}
        onMouseEnter={() => setHot(n.pool)}
        onMouseLeave={() => setHot(null)}
        onClick={n.open || undefined}
        style={{ cursor: n.open ? 'pointer' : 'default', opacity: dim ? 0.35 : 1 }}
      >
        <title>{n.tip}{n.open ? ' — click to open its ROTATION' : ''}</title>
        <rect x={onLeft ? LEFT_X : RIGHT_X} y={n.y} width={NODE_W} height={Math.max(n.h, 1)}
          fill={onLeft ? OUT : IN} rx={1.5} />
        {/* A wider invisible target, so a hairline node is still hoverable. */}
        <rect x={onLeft ? 0 : RIGHT_X} y={cy - GAP / 2} width={LEFT_X + NODE_W} height={GAP} fill="transparent" />
        <text x={x} y={cy} dy="0.35em" textAnchor={onLeft ? 'end' : 'start'}
          fontSize="11" fontWeight="700" fill="#dfe6f6">
          {onLeft ? (
            <><tspan fill={OUT} fontWeight="600" fontSize="10">{n.val}</tspan>{'  ' + n.label}</>
          ) : (
            <>{n.label + '  '}<tspan fill={IN} fontWeight="600" fontSize="10">{n.val}</tspan></>
          )}
        </text>
      </g>
    );
  };

  const gradId = 'mr-grad-' + c.key;
  return (
    <div style={css(CARD + ';padding:12px 14px;margin-bottom:10px', { v })}>
      <div style={css('display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px', { v })}>
        <span style={css('font-size:12px;font-weight:800;letter-spacing:.8px;color:' + c.color, { v })}>{c.name}</span>
        <span style={css('font-size:13px;font-weight:700;color:' + IN, { v })}>{c.rotated}</span>
        <span style={css('font-size:8.5px;color:#4a5578', { v })}>{c.window}</span>
        {c.thin && (
          <span title="Too few sampled pools or rotating paths for this to say much about the chain. Drawn anyway, because it is a real measurement."
            style={css('font-size:8px;letter-spacing:.8px;color:#ffb020;border:1px solid rgba(255,176,32,.4);border-radius:999px;padding:1px 7px', { v })}>
            THIN SAMPLE
          </span>
        )}
        <span style={css('margin-left:auto;font-size:8.5px;color:#4a5578;letter-spacing:.4px', { v })}>{c.drawnNote}</span>
      </div>
      <div style={css('display:flex;font-size:8px;color:#4a5578;letter-spacing:.8px;margin-bottom:2px', { v })}>
        <div style={css('flex:1', { v })}>LEFT</div>
        <div style={css('flex:1;text-align:right', { v })}>ARRIVED AT</div>
      </div>
      <svg viewBox={'0 0 ' + W + ' ' + c.height} width="100%" style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id={gradId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor={OUT} />
            <stop offset="100%" stopColor={IN} />
          </linearGradient>
        </defs>
        {c.paths.map((p) => (
          <path key={p.key} d={p.d} fill={'url(#' + gradId + ')'}
            opacity={lit(p) ? (hot ? 0.85 : 0.5) : 0.07}
            style={{ transition: 'opacity .15s' }}
            onMouseEnter={() => setHot(p.from)} onMouseLeave={() => setHot(null)}>
            <title>{p.tip}</title>
          </path>
        ))}
        {c.left.map(label)}
        {c.right.map(label)}
      </svg>
    </div>
  );
}

function NetList({ title, rows, color, css, v }) {
  return (
    <div style={css(CARD + ';padding:12px 14px;flex:1;min-width:240px', { v })}>
      <div style={css(CAP + ';margin-bottom:7px', { v })}>{title}</div>
      {!rows.length && <div style={css('font-size:9.5px;color:#4a5578', { v })}>none in this window</div>}
      {rows.map((r) => (
        <div key={r.key} onClick={r.open || undefined} title={r.tip}
          style={css('display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid #16223f' +
            (r.open ? ';cursor:pointer' : ''), { v })}>
          <span style={css('font-size:10.5px;font-weight:700;color:#dfe6f6;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', { v })}>{r.label}</span>
          <span style={css('font-size:8.5px;font-weight:700;letter-spacing:.6px;color:' + r.chainColor, { v })}>{r.chain}</span>
          <span style={css('width:70px;text-align:right;font-size:10.5px;font-weight:700;color:' + color, { v })}>{r.val}</span>
        </div>
      ))}
    </div>
  );
}

export default function MarketRotation({ v, css }) {
  if (!v.isMarket) return false;

  return (
    <div data-screen-label="Market Rotation" style={css('flex:1;overflow:auto;padding:12px 14px;min-height:0', { v })}>
      <div style={css('font-size:13px;font-weight:800;color:#ffffff;letter-spacing:.3px;margin-bottom:6px', { v })}>
        WHERE CAPITAL IS ROTATING
      </div>

      <div style={css('display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:9px;color:#6b7699', { v })}>
        <span style={css('width:6px;height:6px;border-radius:50%;display:inline-block;background:' +
          (v.mrServiceLive ? '#4fd6c1' : NEUTRAL), { v })} />
        <span style={css('letter-spacing:.5px', { v })}>ROTATION MEMORY — {v.mrService}</span>
      </div>

      <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:10px', { v })}>
        {v.mrStats.map((s, i) => (
          <div key={i} title={s.tip} style={css(CARD + ';padding:10px 12px', { v })}>
            <div style={css(CAP, { v })}>{s.label}</div>
            <div style={css('font-size:19px;font-weight:700;margin-top:3px;color:' + s.color, { v })}>{s.value}</div>
            <div style={css('font-size:8.5px;color:#6b7699;margin-top:2px', { v })}>{s.note}</div>
          </div>
        ))}
      </div>

      {v.mrNotice ? (
        <div style={css(CARD + ';padding:16px 18px;margin-bottom:10px', { v })}>
          <div style={css('font-size:11px;color:#c6d1ea;line-height:1.6;max-width:760px', { v })}>{v.mrNotice}</div>
        </div>
      ) : (
        <>
          {v.mrChains.map((c) => <ChainRibbons key={c.key} c={c} css={css} v={v} />)}
          <div style={css('display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px', { v })}>
            <NetList title="NET GAINERS" rows={v.mrGainers} color={IN} css={css} v={v} />
            <NetList title="NET LOSERS" rows={v.mrLosers} color={OUT} css={css} v={v} />
          </div>
        </>
      )}

      {v.mrQuiet && (
        <div style={css('font-size:9px;color:#4a5578;margin-bottom:10px', { v })}>{v.mrQuiet}.</div>
      )}

      <div style={css('padding:10px 12px;background:#0d1730;border:1px solid #16223f;border-radius:8px;font-size:9.5px;color:#6b7699;line-height:1.65;max-width:1040px', { v })}>
        <span style={css('color:#8b96b8;font-weight:700', { v })}>How to read this. </span>
        Each ribbon is money that left the pool on the left and arrived at the pool on the right,
        credited only for wallets that were net sellers of one and net buyers of the other. Ribbon
        thickness is dollars, on one scale shared by every chain, with no minimum beyond a hairline —
        a thin chain is drawn thin. A pool can appear on both sides, and its two sides need not
        balance. Rotation is measured within one chain, never across chains, and only among pools
        the sampler has reached, so every figure is a floor. Hover a pool to isolate its flows; click
        one on the board to open its ROTATION tab.
      </div>
    </div>
  );
}
