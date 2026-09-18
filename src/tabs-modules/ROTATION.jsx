import React from 'react';
import { fmtUsd } from '../utils/formatters';
import { chainNameToKey } from '../data/chains';
import {
  rotationGraphFor, busiestRotationChain, rotationIntelStatus,
} from '../services/rotation-intel';

/**
 * Where the crowd is moving its money.
 *
 * What this tab used to do: print eight hardcoded cohorts ("Semiconductor
 * stock tokens +$2.41M"), a hardcoded CRYPTO <-> RWA panel, a "smart money %"
 * that was shared wallets times 1.8, and a confidence of 0.85 on every row.
 * When the server was unreachable it silently swapped in a whole fake scene -
 * NVDAx, $GLYPH, $SOLPUP - with nothing on screen to say so.
 *
 * What it does now: ONE measurement, drawn rather than tabulated. The
 * measurement is wallet overlap with a direction: two pools that share wallets
 * are connected, and if those wallets are net sellers of one and net buyers of
 * the other, capital rotated. rotationGraph() in src/calculations/core.js says
 * how much and which way - see its comment for the min(|out|, in) attribution.
 *
 * The page reads top to bottom as one argument: the finding in a sentence, the
 * flow as a ribbon diagram, then who gained and who lost. Numbers are captions
 * on shapes, not a table to be scanned.
 *
 * Four rules kept deliberately, all four broken by the old version:
 *   - every number describes the sampled WINDOW, which is printed above them;
 *   - nothing is invented. No cohort, class or confidence, because none of them
 *     is measured. A pool the provider never named is shown as its address,
 *     not dressed up as a ticker;
 *   - same-direction overlap is NOT called rotation. It is counted separately
 *     and labelled, because it is the obvious false positive;
 *   - an empty result is a result, and says so.
 */

/* --------------------------------------------------------------- style --- */

const CARD = 'background:#0a1226;border:1px solid #1c2a4d;border-radius:10px';
const CAP = 'font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600';

const OUT = '#ff4fae';   // capital leaving
const IN = '#4d8dff';    // capital arriving
const NEUTRAL = '#6b7699';

/* ---------------------------------------------------------- formatting --- */

const tick = (s) => '$' + String(s).replace(/^\$/, '').toUpperCase();

// A pool the provider never gave a symbol. Shown as what it is - an address -
// because an address prefix sitting in a ticker slot reads as a ticker: the
// old fallback turned pool Q2sPHPdU... into "$Q2SPHPDU", set it next to $SOL,
// and invented a token that does not exist.
const poolLabel = (a) => {
  const s = String(a || '');
  return s.length > 10 ? 'pool ' + s.slice(0, 4) + '…' + s.slice(-4) : 'pool ' + (s || '?');
};

const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmtUsd(Math.abs(v));

const ago = (ms) => {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return (s / 3600).toFixed(1) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};

const span = (fromMs, toMs) => {
  if (!fromMs || !toMs || toMs <= fromMs) return null;
  const m = (toMs - fromMs) / 60000;
  if (m < 90) return Math.round(m) + 'm';
  if (m < 1440) return (m / 60).toFixed(1) + 'h';
  return Math.round(m / 1440) + 'd';
};

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

/* ------------------------------------------------------- flow geometry --- */

/**
 * A two-column ribbon diagram. Left column is the pools capital left, right
 * column the pools it arrived in. A pool that both gained and lost appears on
 * both sides - that is not a bug, it is what a hub looks like, and merging the
 * two sides would hide it.
 *
 * Only the ribbons are SVG, on a 0-100 x-axis stretched to whatever width the
 * pane gives it. Every label and bar is HTML at a real pixel size, because
 * SVG text inside a scaled viewBox shrinks with the container and this tab is
 * read at half a screen width. Y is in pixels in both, so the two line up.
 *
 * Laid out here rather than in the renderer so the JSX stays declarative.
 */
const BODY_H = 340;
const GAP = 10;
const MIN_H = 16;     // enough for one line of label
const LABEL_H = 16;   // when a node is at least this tall, its USD fits too

function buildFlow(shown, labelFor) {
  const total = shown.reduce((s, e) => s + e.rotatedUsd, 0) || 1;

  const column = (keyOf, labelOf) => {
    const byKey = new Map();
    shown.forEach((e) => {
      const k = keyOf(e);
      if (!byKey.has(k)) byKey.set(k, { key: k, label: labelOf(e), total: 0, edges: [] });
      const node = byKey.get(k);
      node.total += e.rotatedUsd;
      node.edges.push(e);
    });
    const list = [...byKey.values()].sort((a, b) => b.total - a.total);

    // Heights are proportional, but every node still has to carry a label, so
    // each gets MIN_H and the column is rescaled if that overflows.
    const gaps = GAP * Math.max(0, list.length - 1);
    const base = Math.max(40, BODY_H - gaps);
    let heights = list.map((n) => Math.max(MIN_H, (n.total / total) * base));
    const sum = heights.reduce((a, b) => a + b, 0);
    if (sum + gaps > BODY_H) {
      const k = (BODY_H - gaps) / sum;
      heights = heights.map((h) => h * k);
    }
    const used = heights.reduce((a, b) => a + b, 0) + gaps;
    let y = Math.max(0, (BODY_H - used) / 2);
    return list.map((n, i) => {
      const node = { ...n, y, h: heights[i] };
      y += heights[i] + GAP;
      return node;
    });
  };

  const left = column((e) => e.sourcePool, (e) => labelFor(e.source, e.sourcePool));
  const right = column((e) => e.targetPool, (e) => labelFor(e.target, e.targetPool));

  // Each node's bar is divided between its own edges, largest first, so
  // ribbons leave and arrive in a consistent order and cross as little as
  // possible.
  const slices = new Map();
  const cut = (nodes, side) => nodes.forEach((n) => {
    let off = 0;
    n.edges.slice().sort((a, b) => b.rotatedUsd - a.rotatedUsd).forEach((e) => {
      const h = n.total ? n.h * (e.rotatedUsd / n.total) : 0;
      const key = e.sourcePool + '>' + e.targetPool;
      const cur = slices.get(key) || {};
      cur[side + '0'] = n.y + off;
      cur[side + '1'] = n.y + off + h;
      slices.set(key, cur);
      off += h;
    });
  });
  cut(left, 'l');
  cut(right, 'r');

  const maxUsd = Math.max(...shown.map((e) => e.rotatedUsd), 1);
  const ribbons = shown.map((e) => {
    const s = slices.get(e.sourcePool + '>' + e.targetPool) || {};
    return {
      slice: s,
      key: e.sourcePool + '>' + e.targetPool,
      // Opacity carries magnitude a second time, so the eye ranks the ribbons
      // even where two of them are a similar thickness.
      op: (0.32 + 0.53 * (e.rotatedUsd / maxUsd)).toFixed(2),
      d: 'M0 ' + s.l0 +
         ' C50 ' + s.l0 + ',50 ' + s.r0 + ',100 ' + s.r0 +
         ' L100 ' + s.r1 +
         ' C50 ' + s.r1 + ',50 ' + s.l1 + ',0 ' + s.l1 + ' Z',
      label: fmtUsd(e.rotatedUsd),
      tip: labelFor(e.source, e.sourcePool) + ' → ' + labelFor(e.target, e.targetPool) + ': ' +
        fmtUsd(e.dominantUsd) + ' moved across ' + e.sharedWallets + ' shared wallet' +
        (e.sharedWallets === 1 ? '' : 's') + ' (' + e.overlapPct + '% of the smaller crowd)' +
        (e.counterUsd ? ', ' + fmtUsd(e.counterUsd) + ' came back the other way' : ', nothing came back') +
        (e.parallelUsd ? '. A further ' + fmtUsd(e.parallelUsd) + ' was same-direction and is excluded.' : '.'),
    };
  });

  // Where a caption sits ON its own ribbon. Both the x and the y come from
  // the same point of the same cubic, so the label cannot drift off the
  // shape: LANES are curve parameters, not screen positions.
  //
  // Ribbons are handed lanes in vertical order, so two that run close
  // together are pushed to different thirds of the span rather than
  // printing their values one on top of the other.
  const LANES = [0.5, 0.31, 0.69];
  const curveX = (t) => {
    const u = 1 - t;
    return 150 * t * u * u + 150 * t * t * u + 100 * t * t * t;
  };
  const curveY = (a, b, t) => {
    const u = 1 - t;
    return a * (u * u * u + 3 * t * u * u) + b * (3 * t * t * u + t * t * t);
  };
  ribbons
    .slice()
    .sort((a, b) => (a.slice.l0 + a.slice.r0) - (b.slice.l0 + b.slice.r0))
    .forEach((r, i) => {
      const t = LANES[i % LANES.length];
      const sl = r.slice;
      const top = curveY(sl.l0, sl.r0, t);
      const bottom = curveY(sl.l1, sl.r1, t);
      r.lx = curveX(t).toFixed(2) + '%';
      r.ly = (top + bottom) / 2;
      // A value printed on a ribbon thinner than its own text is noise.
      r.show = bottom - top >= 15;
      delete r.slice;
    });

  const face = (nodes) => nodes.map((n) => ({
    key: n.key,
    top: n.y,
    h: n.h,
    label: n.label,
    value: fmtUsd(n.total),
    roomy: n.h >= LABEL_H * 2,
    tip: n.label + ' · ' + fmtUsd(n.total) + ' across ' + n.edges.length +
      ' path' + (n.edges.length === 1 ? '' : 's'),
  }));

  return { h: BODY_H, ribbons, left: face(left), right: face(right) };
}

/* ============================================================== values === */

export function rotationVals(app) {
  const st = app.state;

  // The graph is READ, not fetched. rotation-intel keeps one per chain built
  // and current in the background, so opening this tab is a render.
  //
  // Rotation is measured WITHIN a chain, so "ALL" has no single graph to
  // show. Falling back to the busiest chain beats defaulting to Solana and
  // presenting that as the whole answer - and the chain is named in the
  // header either way, so the reader is never guessing which one this is.
  const picked = st.chainF !== 'ALL' ? (chainNameToKey[st.chainF] || null) : busiestRotationChain();
  const api = picked ? rotationGraphFor(picked) : null;
  const svc = rotationIntelStatus();

  // The background service, made visible. It runs whether or not this tab is
  // open, so the user should be able to see that it is working.
  const rotService = !svc.running
    ? 'Background rotation service is not running.'
    : svc.chainsHeld + ' chain' + (svc.chainsHeld === 1 ? '' : 's') + ' watched · ' +
      svc.poolsConnected + ' pools in memory · rebuilt ' + ago(svc.lastTickAt) +
      ' · no extra requests (rides the wallet sample)';
  const rotServiceLive = svc.running && !svc.lastError;

  // Nothing built yet is not the same as nothing found, and neither is an
  // unreachable server. All three used to render the same fake scene.
  if (!api || !api.poolsSampled) {
    return {
      rotReady: false,
      rotService,
      rotServiceLive,
      rotNotice: st.serverError
        ? 'The data server is unreachable, so no pool trades could be sampled. Nothing is shown rather than simulated.'
        : (st.chainF !== 'ALL' && !picked
          ? 'No chain key for the current board filter, so there is no graph to read.'
          : 'Building the first graph… the background service reads the server’s held trade samples every few seconds, and rotation needs at least two pools with overlapping wallets before there is anything to measure.'),
    };
  }

  const assets = app.assets || [];
  const openFor = (poolAddress) => {
    const hit = assets.find((a) => a.poolAddress === poolAddress);
    return hit ? () => app.setState({ page: 'detail', selectedId: hit.id }) : null;
  };

  const edges = api.edges || [];
  const nodes = api.nodes || [];
  const moving = edges.filter((e) => e.rotatedUsd > 0);

  // Two sampled pools can carry the same ticker, and printing both as "$STONK"
  // turns a real measurement into "$STONK -> $STONK". The graph is keyed by
  // pool address, so only the LABEL is ambiguous: when a ticker is not unique,
  // every pool wearing it gets its address tail appended.
  const tickerCount = new Map();
  nodes.forEach((n) => {
    if (!n.symbol) return;
    const k = tick(n.symbol);
    tickerCount.set(k, (tickerCount.get(k) || 0) + 1);
  });
  const labelFor = (symbol, poolAddress) => {
    if (!symbol) return poolLabel(poolAddress);
    const base = tick(symbol);
    if ((tickerCount.get(base) || 0) < 2) return base;
    return base + '·' + String(poolAddress || '').slice(-4);
  };

  /* ------------------------------------------------------------- window -- */

  const windowSpan = span(api.firstTradeAt, api.lastTradeAt);
  const rotWindow = [
    api.poolsSampled + ' pools',
    api.tradesSampled.toLocaleString('en-US') + ' trades',
    api.distinctWallets.toLocaleString('en-US') + ' wallets',
    windowSpan ? 'over ' + windowSpan : null,
  ].filter(Boolean).join(' · ');

  const rotSampled = api.newestSampleAt
    ? 'newest sample ' + ago(api.newestSampleAt) + ' · oldest ' + ago(api.oldestSampleAt)
    : 'sample times unavailable';

  /* -------------------------------------------------------------- stats -- */

  // pathsRotating covers every edge; moving[] is only the display slice, so
  // using it here would pair a full-set total with a partial-set count.
  const rotatingPaths = api.pathsRotating != null ? api.pathsRotating : moving.length;
  const density = pct(api.pairsConnected, api.pairsPossible);
  const rotStats = [
    {
      label: 'ROTATED', value: fmtUsd(api.rotatedUsd), color: IN,
      note: 'across ' + rotatingPaths + ' directed path' + (rotatingPaths === 1 ? '' : 's'),
      tip: 'Capital that left one sampled pool and arrived in another, attributed per wallet as min(amount out, amount in) so the same dollars are never counted twice.',
    },
    {
      label: 'SHARED WALLETS', value: api.sharedWalletCount.toLocaleString('en-US'),
      color: api.sharedWalletCount ? '#e35ff2' : NEUTRAL,
      note: 'of ' + api.distinctWallets.toLocaleString('en-US') + ' traders, in 2+ pools',
      tip: 'Wallets appearing in more than one sampled pool. This is the raw overlap, before any direction test.',
    },
    {
      label: 'CONNECTED', value: density + '%',
      color: density >= 30 ? '#4fc3f7' : '#dfe6f6',
      note: api.pairsConnected + ' of ' + api.pairsPossible + ' pool pairs',
      tip: 'How joined-up the board is. Every pool pair sharing at least one wallet counts as connected.',
    },
    {
      label: 'PARALLEL — EXCLUDED', value: fmtUsd(api.parallelUsd), color: NEUTRAL,
      note: 'bought both, or sold both',
      tip: 'Shared wallets that bought both pools, or sold both. That is two positions at once, not capital moving between them, so it is excluded from the rotation total and shown here instead.',
    },
  ];

  const shell = {
    rotReady: true, rotWindow, rotSampled, rotChain: api.chain || '', rotStats,
    rotService, rotServiceLive,
    // Flagged only when the board filter is ALL and the chain was chosen here.
    rotAutoChain: st.chainF === 'ALL',
  };

  /* -------------------------------------- nothing overlapping is a result - */

  if (!moving.length) {
    return {
      ...shell,
      rotEmpty: true,
      rotLead: api.pairsConnected
        ? 'These pools share ' + api.sharedWalletCount + ' wallet' + (api.sharedWalletCount === 1 ? '' : 's') +
          ', but none of them sold one side and bought the other. The overlap is parallel positioning, not rotation.'
        : 'No wallet appears in two sampled pools in this window. There is no rotation to measure — which is a result, not a gap.',
      rotFlow: null,
      rotDirection: [],
      rotHubs: [],
    };
  }

  /* --------------------------------------------------------- flow ribbon - */

  // Eight is what stays legible at this height; the rest is still counted in
  // the ROTATED total, and the caption says so.
  const shown = moving.slice(0, 8);
  const rotFlow = buildFlow(shown, labelFor);
  const rotFlowNote = shown.length < rotatingPaths
    ? 'the ' + shown.length + ' largest of ' + rotatingPaths + ' paths'
    : 'all ' + shown.length + ' path' + (shown.length === 1 ? '' : 's');

  /* ---------------------------------------------------------- direction -- */

  const involved = nodes.filter((n) => n.rotatedUsd > 0);
  const maxNet = Math.max(...involved.map((n) => Math.abs(n.netRotationUsd)), 1);
  const rotDirection = involved
    .slice()
    .sort((a, b) => b.netRotationUsd - a.netRotationUsd)
    .map((n) => ({
      key: n.poolAddress,
      sym: labelFor(n.symbol, n.poolAddress),
      val: signed(n.netRotationUsd),
      color: n.netRotationUsd > 0 ? IN : n.netRotationUsd < 0 ? OUT : NEUTRAL,
      posW: n.netRotationUsd > 0 ? pct(n.netRotationUsd, maxNet) + '%' : '0%',
      negW: n.netRotationUsd < 0 ? pct(-n.netRotationUsd, maxNet) + '%' : '0%',
      open: openFor(n.poolAddress),
      tip: labelFor(n.symbol, n.poolAddress) + ' took in ' + fmtUsd(n.inUsd) + ' and gave up ' +
        fmtUsd(n.outUsd) + ' across ' + n.connections + ' connected pool' +
        (n.connections === 1 ? '' : 's') + ' in this window.',
    }));

  /* --------------------------------------------------------------- hubs -- */

  const rotHubs = nodes
    .filter((n) => n.connections > 0)
    .slice(0, 12)
    .map((n) => {
      const both = n.inUsd + n.outUsd;
      return {
        key: n.poolAddress,
        sym: labelFor(n.symbol, n.poolAddress),
        net: signed(n.netRotationUsd),
        netColor: n.netRotationUsd > 0 ? IN : n.netRotationUsd < 0 ? OUT : NEUTRAL,
        inW: pct(n.inUsd, both) + '%',
        outW: pct(n.outUsd, both) + '%',
        inUsd: fmtUsd(n.inUsd),
        outUsd: fmtUsd(n.outUsd),
        foot: n.connections + ' link' + (n.connections === 1 ? '' : 's') + ' · ' +
          n.wallets.toLocaleString('en-US') + ' wallets · ' + ago(n.sampledAt),
        open: openFor(n.poolAddress),
        tip: fmtUsd(n.inUsd) + ' in, ' + fmtUsd(n.outUsd) + ' out, over ' +
          n.trades.toLocaleString('en-US') + ' sampled trades.',
      };
    });

  /* --------------------------------------------------------------- lead -- */

  const top = moving[0];
  const rotLead = top.directionality != null && top.directionality < 0.7
    ? top.sharedWallets + ' wallets are cycling ' + fmtUsd(top.rotatedUsd) + ' between ' +
      labelFor(top.source, top.sourcePool) + ' and ' + labelFor(top.target, top.targetPool) +
      ' in both directions — churn between two pools, not a move into one.'
    : top.sharedWallets + ' wallet' + (top.sharedWallets === 1 ? '' : 's') + ' moved ' +
      fmtUsd(top.dominantUsd) + ' out of ' + labelFor(top.source, top.sourcePool) +
      ' and into ' + labelFor(top.target, top.targetPool) +
      ' — the strongest path in this window.';

  return { ...shell, rotEmpty: false, rotLead, rotFlow, rotFlowNote, rotDirection, rotHubs };
}

/* ============================================================== render === */

/** One side of the ribbon diagram: a rail of bars plus a gutter of labels. */
function FlowSide({ nodes, side, colour, css }) {
  const isLeft = side === 'left';
  return (
    <>
      {isLeft && (
        <div style={css('position:relative;width:118px;flex:0 0 auto', {})}>
          {nodes.map((n) => (
            <div key={n.key} title={n.tip} style={{
              position: 'absolute', top: n.top + n.h / 2, right: 10,
              transform: 'translateY(-50%)', textAlign: 'right', lineHeight: 1.25,
            }}>
              <div style={css('font-size:10.5px;font-weight:700;color:#dfe6f6;white-space:nowrap', { n })}>{n.label}</div>
              {n.roomy && <div style={css('font-size:9px;color:#6b7699', { n })}>{n.value}</div>}
            </div>
          ))}
        </div>
      )}

      <div style={css('position:relative;width:9px;flex:0 0 auto', {})}>
        {nodes.map((n) => (
          <div key={n.key} title={n.tip} style={{
            position: 'absolute', top: n.top, height: n.h, left: 0, right: 0,
            background: colour, borderRadius: 3,
          }} />
        ))}
      </div>

      {!isLeft && (
        <div style={css('position:relative;width:118px;flex:0 0 auto', {})}>
          {nodes.map((n) => (
            <div key={n.key} title={n.tip} style={{
              position: 'absolute', top: n.top + n.h / 2, left: 10,
              transform: 'translateY(-50%)', lineHeight: 1.25,
            }}>
              <div style={css('font-size:10.5px;font-weight:700;color:#ffffff;white-space:nowrap', { n })}>{n.label}</div>
              {n.roomy && <div style={css('font-size:9px;color:#6b7699', { n })}>{n.value}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** The always-on service behind the tab, made visible. */
function ServiceLine({ v, css }) {
  return (
    <div style={css('display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:9px;color:#6b7699', { v })}>
      <span style={css('width:6px;height:6px;border-radius:50%;background:' +
        (v.rotServiceLive ? '#4fd6c1' : '#6b7699') + ';display:inline-block;flex:0 0 auto', { v })} />
      <span style={css('letter-spacing:.5px', { v })}>ROTATION MEMORY — {v.rotService}</span>
    </div>
  );
}

export default function Rotation({ v, css }) {
  if (!v.isRotation) return false;

  if (!v.rotReady) {
    return (
      <div data-screen-label="Rotation" style={css('flex:1;overflow:auto;padding:12px 14px;min-height:0', { v })}>
        <div style={css(CARD + ';padding:22px', { v })}>
          <div style={css(CAP + ';margin-bottom:8px', { v })}>ROTATION</div>
          <div style={css('font-size:11px;color:#c6d1ea;line-height:1.6;max-width:640px', { v })}>{v.rotNotice}</div>
          <div style={css('margin-top:12px', { v })}><ServiceLine v={v} css={css} /></div>
        </div>
      </div>
    );
  }

  const f = v.rotFlow;

  return (
    <div data-screen-label="Rotation" style={css('flex:1;overflow:auto;padding:12px 14px;min-height:0', { v })}>

      {/* The window every number below is measured over. */}
      <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px', { v })}>
        <div style={css('font-size:13px;font-weight:800;color:#ffffff;letter-spacing:.3px', { v })}>
          WHERE THE CROWD IS MOVING
        </div>
        <div
          title="Rotation is measured over the trades actually sampled from these pools. It is a window, not history, and nothing outside it is described."
          style={css('font-size:9.5px;color:#6b7699;background:#0d1730;border:1px solid #1c2a4d;border-radius:999px;padding:3px 10px', { v })}
        >{v.rotWindow}</div>
        {v.rotChain && (
          <div style={css('font-size:9.5px;color:#4d8dff;font-family:monospace', { v })}>{v.rotChain}</div>
        )}
        <div style={css('font-size:9px;color:#4a5578', { v })}>{v.rotSampled}</div>
        {v.rotAutoChain && (
          <div
            title="The board filter is ALL, but rotation is measured within one chain. This is the chain with the most rotation right now."
            style={css('font-size:8.5px;color:#4a5578;border:1px solid #1c2a4d;border-radius:999px;padding:2px 8px', { v })}
          >busiest chain</div>
        )}
      </div>

      <ServiceLine v={v} css={css} />

      {/* The finding, in one sentence, before any shape or number. */}
      <div style={css('font-size:12.5px;color:#dfe6f6;line-height:1.5;margin-bottom:11px;max-width:960px', { v })}>
        {v.rotLead}
      </div>

      <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:10px', { v })}>
        {v.rotStats.map((s, i) => (
          <div key={i} title={s.tip} style={css(CARD + ';padding:10px 12px', { v, s })}>
            <div style={css(CAP, { v, s })}>{s.label}</div>
            <div style={css('font-size:19px;font-weight:700;margin-top:3px;color:{{ s.color }}', { v, s })}>{s.value}</div>
            <div style={css('font-size:8.5px;color:#6b7699;margin-top:2px', { v, s })}>{s.note}</div>
          </div>
        ))}
      </div>

      {v.rotEmpty ? (
        <div style={css(CARD + ';padding:18px', { v })}>
          <div style={css(CAP + ';margin-bottom:7px', { v })}>NO DIRECTED ROTATION IN THIS WINDOW</div>
          <div style={css('font-size:11px;color:#8b96b8;line-height:1.6;max-width:680px', { v })}>
            A shared wallet only counts as rotation if it was a net seller of one pool and a net
            buyer of the other. Nothing here met that test, so nothing is drawn.
          </div>
        </div>
      ) : (
        <>
          {/* ---------------------------------------------- the flow itself */}
          <div style={css(CARD + ';padding:12px 14px', { v })}>
            <div style={css('display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap', { v })}>
              <div style={css(CAP, { v })}>ROTATION FLOW</div>
              <div style={css('font-size:8.5px;color:#4a5578;letter-spacing:.5px', { v })}>
                ribbon width = rotated USD · {v.rotFlowNote}
              </div>
            </div>
            <div style={css('display:flex;justify-content:space-between;font-size:8.5px;letter-spacing:1.1px;font-weight:700;margin:6px 0 4px', { v })}>
              <span style={css('color:' + OUT, { v })}>SOLD OUT OF</span>
              <span style={css('color:' + IN, { v })}>BOUGHT INTO</span>
            </div>

            <div style={{ display: 'flex', alignItems: 'stretch', height: f.h }}>
              <FlowSide nodes={f.left} side="left" colour={OUT} css={css} />

              <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
                <svg
                  viewBox={'0 0 100 ' + f.h}
                  preserveAspectRatio="none"
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
                  role="img"
                  aria-label="Capital rotating from the pools on the left into the pools on the right"
                >
                  <defs>
                    <linearGradient id="rotRibbon" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor={OUT} />
                      <stop offset="100%" stopColor={IN} />
                    </linearGradient>
                  </defs>
                  {f.ribbons.map((r) => (
                    <path key={r.key} d={r.d} fill="url(#rotRibbon)" opacity={r.op}>
                      <title>{r.tip}</title>
                    </path>
                  ))}
                </svg>

                {/* Values ride on the ribbons, in HTML so they never stretch. */}
                {f.ribbons.filter((r) => r.show).map((r) => (
                  <div key={r.key + ':t'} title={r.tip} style={{
                    position: 'absolute', top: r.ly, left: r.lx,
                    transform: 'translate(-50%,-50%)', pointerEvents: 'none',
                    fontSize: 10, fontWeight: 800, color: '#ffffff',
                    textShadow: '0 1px 4px rgba(3,8,20,.95)', whiteSpace: 'nowrap',
                  }}>{r.label}</div>
                ))}
              </div>

              <FlowSide nodes={f.right} side="right" colour={IN} css={css} />
            </div>
          </div>

          {/* ------------------------------------------- who gained, who lost */}
          <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:10px;margin-top:10px;align-items:start', { v })}>

            <div style={css(CARD + ';padding:12px;min-width:0', { v })}>
              <div style={css(CAP, { v })}>NET POSITION</div>
              <div style={css('display:flex;font-size:8px;color:#4a5578;letter-spacing:.8px;margin:7px 0 5px;padding:0 81px 0 112px', { v })}>
                <div style={css('flex:1;text-align:left', { v })}>LOST</div>
                <div style={css('width:1px', { v })} />
                <div style={css('flex:1;text-align:right', { v })}>GAINED</div>
              </div>
              {v.rotDirection.map((c) => (
                <div
                  key={c.key} onClick={c.open} title={c.tip}
                  style={css('display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px solid #16223f' +
                    (c.open ? ';cursor:pointer' : ''), { v, c })}
                >
                  <span style={css('width:103px;font-size:10.5px;font-weight:600;color:#dfe6f6;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, c })}>{c.sym}</span>
                  <div style={css('flex:1;display:flex;height:13px;min-width:0', { v, c })}>
                    <div style={css('width:50%;display:flex;justify-content:flex-end', { v, c })}>
                      <div style={css('width:{{ c.negW }};background:linear-gradient(90deg,rgba(255,79,174,.35),' + OUT + ');border-radius:2px 0 0 2px', { v, c })} />
                    </div>
                    <div style={css('width:1px;background:#2a3a5f', { v, c })} />
                    <div style={css('width:50%;display:flex', { v, c })}>
                      <div style={css('width:{{ c.posW }};background:linear-gradient(90deg,' + IN + ',rgba(77,141,255,.35));border-radius:0 2px 2px 0', { v, c })} />
                    </div>
                  </div>
                  <span style={css('width:72px;text-align:right;font-size:11px;font-weight:700;color:{{ c.color }};flex-shrink:0', { v, c })}>{c.val}</span>
                </div>
              ))}
            </div>

            {/* Cards, not a nine-column table: the shape of in-versus-out is
                the thing worth seeing, and the exact figures are on hover. */}
            <div style={css(CARD + ';padding:12px;min-width:0', { v })}>
              <div style={css(CAP + ';margin-bottom:9px', { v })}>CROSS-POOL HUBS</div>
              <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(152px,1fr));gap:8px', { v })}>
                {v.rotHubs.map((h) => (
                  <div
                    key={h.key} onClick={h.open} title={h.tip}
                    style={css('background:#101c38;border:1px solid #1c2a4d;border-radius:8px;padding:9px 10px;min-width:0' +
                      (h.open ? ';cursor:pointer' : ''), { v, h })}
                  >
                    <div style={css('display:flex;align-items:baseline;justify-content:space-between;gap:6px', { v, h })}>
                      <span style={css('font-size:11px;font-weight:700;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, h })}>{h.sym}</span>
                      <span style={css('font-size:12px;font-weight:700;color:{{ h.netColor }};flex-shrink:0', { v, h })}>{h.net}</span>
                    </div>
                    <div style={css('display:flex;height:6px;border-radius:3px;overflow:hidden;background:#16223f;margin-top:7px', { v, h })}>
                      <div style={css('width:{{ h.outW }};background:' + OUT, { v, h })} />
                      <div style={css('width:{{ h.inW }};background:' + IN, { v, h })} />
                    </div>
                    <div style={css('display:flex;justify-content:space-between;font-size:8.5px;margin-top:4px', { v, h })}>
                      <span style={css('color:' + OUT, { v, h })}>{h.outUsd} out</span>
                      <span style={css('color:' + IN, { v, h })}>{h.inUsd} in</span>
                    </div>
                    <div style={css('font-size:8px;color:#4a5578;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, h })}>{h.foot}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* What the tab is claiming, and what it is not. */}
      <div style={css('margin-top:10px;padding:10px 12px;background:#0d1730;border:1px solid #16223f;border-radius:8px;font-size:9.5px;color:#6b7699;line-height:1.65;max-width:1040px', { v })}>
        <span style={css('color:#8b96b8;font-weight:700', { v })}>How this is measured. </span>
        A wallet in two sampled pools counts as rotation only when it is a net seller of one and a
        net buyer of the other; the amount credited is the smaller of the two sides, so the same
        dollars are never counted twice. Shared wallets that bought both, or sold both, are parallel
        positioning and are excluded. A pool the provider never named is shown as its address rather
        than as a ticker. Everything above covers only the trades sampled from these pools on
        {' ' + (v.rotChain || 'this chain')}, within the window printed at the top. It is not
        cross-chain, and it is not a rolling hour.
      </div>
    </div>
  );
}
