import React from 'react';
import { fmtUsd } from '../utils/formatters';
import { chainNameToKey } from '../data/chains';
import {
  rotationForPool, rotationGraphFor, rotationIntelStatus,
} from '../services/rotation-intel';

/**
 * Where THIS token's crowd is going.
 *
 * SCOPE, AND WHY IT CHANGED
 *
 * This tab drew the whole chain's rotation graph for a while. The graph is
 * honest arithmetic, but as a headline it does not survive partial coverage:
 * it is built from whichever pools the server's sampler happened to reach, so
 * "$34K rotated on solana" reads as a statement about the chain while actually
 * describing an arbitrary handful of pools. The true chain figure is unknowable
 * and the number shown has no stable relationship to it.
 *
 * The per-token read does survive. "Of the wallets that sold $CATE, 14 bought
 * $STONK" is true whether we sampled five pools or five hundred - it is a lower
 * bound over the pools we watch, not a claim about a total. So the selected
 * token is the headline, and the chain picture moved below it as context.
 *
 * WHAT IS DRAWN
 *
 * One row per counterparty, diverging about a centre axis that is the token:
 * pools its capital went TO grow left, pools it came FROM grow right, on one
 * shared scale. Above them, a balance strip restating the ARRIVED and LEFT
 * tiles. See egoBars() for why this replaced a ribbon diagram.
 *
 * Underneath, the chain's net position - which doubles as the fallback when
 * this token has not been sampled yet, because "not sampled" plus a live view
 * of what IS moving beats an empty page.
 *
 * RULES KEPT
 *   - every number describes the sampled WINDOW, which is printed above them;
 *   - nothing is invented. A pool the provider never named is shown as its
 *     address, not dressed up as a ticker;
 *   - same-direction overlap is NOT rotation. It is excluded and labelled;
 *   - an empty result is a result, and says which kind of empty it is.
 */

/* --------------------------------------------------------------- style --- */

const CARD = 'background:#0a1226;border:1px solid #1c2a4d;border-radius:10px';
const CAP = 'font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600';

const OUT = '#ff4fae';      // capital leaving this token
const IN = '#4d8dff';       // capital arriving at this token
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
/* ------------------------------------------------------ ego-bar layout --- */

/**
 * One row per counterparty, diverging about the token.
 *
 * WHY NOT A RIBBON DIAGRAM
 *
 * This was a sankey, with the token as a bar in the middle and a ribbon per
 * peer. Two things were wrong with it, one fatal:
 *
 *   1. A ribbon has to be thick enough to carry its own label and be worth
 *      clicking, so it needs a minimum thickness - and that floor destroys the
 *      encoding. On a real $STONK read, $58 was drawn 10.6x too thick and $113
 *      5.8x, so $924 rendered only 1.4x thicker than $113 despite being 8.2x
 *      the value. The caption promised "both sides share one scale" and five
 *      of twelve ribbons did not.
 *   2. A sankey implies conservation - what flows in flows out through the
 *      node. Rotation has no such constraint ($4.2K in against $10.9K out is
 *      ordinary), so the centre bar drew a vessel that does not exist.
 *
 * A bar fixes both. The label sits OUTSIDE the bar, so row height can stay
 * readable while bar length stays honest all the way down to a dollar; and
 * nothing about two opposed bars implies they must balance.
 *
 * It also shares its grammar with the chain-context chart further down the
 * page, so the two read as one system rather than two chart idioms.
 */

/** Bars shorter than this would vanish, so they are drawn as a visible stub. */
const HAIRLINE = '1.5px';

function egoBars(inPeers, outPeers, totals, labelFor, openFor) {
  // The balance strip restates the ARRIVED and LEFT tiles, so it has to use
  // THEIR numbers. Summing the drawn peers instead put "$11.8K out / $3.9K in"
  // directly under tiles reading "$11.1K / $4.6K" - two different measures
  // (all edges vs the drawn slice, gross flow vs both-way rotation) sitting on
  // one card looking like they ought to agree.
  const totalIn = totals.inUsd;
  const totalOut = totals.outUsd;
  const both = totalIn + totalOut;

  // One scale across both directions, anchored on the largest single path, so
  // an inflow and an outflow of equal size are drawn equally long.
  const maxAbs = Math.max(...[...inPeers, ...outPeers].map((p) => p.rotatedUsd), 1);

  const row = (p, outbound) => {
    const twoWay = p.directionality != null && p.directionality < 0.7;
    // A true percentage - no floor. A $58 path next to a $5.9K one is
    // supposed to look like nothing, because it is nothing.
    const share = (p.rotatedUsd / maxAbs) * 100;
    return {
      key: p.poolAddress,
      label: labelFor(p.symbol, p.poolAddress),
      val: (outbound ? '−' : '+') + fmtUsd(p.rotatedUsd),
      colour: outbound ? OUT : IN,
      outbound,
      twoWay,
      // Width lives on the half it grows into; the other half stays empty.
      w: share < 0.4 ? HAIRLINE : share.toFixed(2) + '%',
      meta: p.sharedWallets + 'w · ' + p.overlapPct + '%',
      open: openFor(p.poolAddress),
      tip: p.sharedWallets + ' wallet' + (p.sharedWallets === 1 ? '' : 's') +
        ' trade both pools (' + p.overlapPct + '% of the smaller crowd). ' +
        fmtUsd(p.rotatedUsd) + ' rotated' +
        (twoWay
          ? ', in both directions — churn between the two rather than a one-way move.'
          : ', almost all of it ' + (outbound ? 'outward.' : 'inward.')) +
        (p.parallelUsd ? ' A further ' + fmtUsd(p.parallelUsd) + ' was same-direction and is excluded.' : ''),
    };
  };

  // Arrivals first, largest first; then departures, largest first. Reading
  // order therefore goes "what is coming in" then "what is going out", and
  // the biggest number in each direction leads its group.
  const rows = [
    ...inPeers.slice().sort((a, b) => b.rotatedUsd - a.rotatedUsd).map((p) => row(p, false)),
    ...outPeers.slice().sort((a, b) => b.rotatedUsd - a.rotatedUsd).map((p) => row(p, true)),
  ];
  // Where the list turns from arrivals to departures, for the rule between them.
  const turn = inPeers.length && outPeers.length ? inPeers.length : -1;

  return {
    rows,
    turn,
    balance: {
      outW: both ? ((totalOut / both) * 100).toFixed(2) + '%' : '0%',
      inW: both ? ((totalIn / both) * 100).toFixed(2) + '%' : '0%',
      outLabel: totalOut ? fmtUsd(totalOut) + ' out' : '',
      inLabel: totalIn ? fmtUsd(totalIn) + ' in' : '',
      showOut: both ? (totalOut / both) > 0.14 : false,
      showIn: both ? (totalIn / both) > 0.14 : false,
    },
  };
}

/* ============================================================== values === */

export function rotationVals(app, sel) {
  const st = app.state;
  const svc = rotationIntelStatus();

  // The background service, made visible. It runs whether or not this tab is
  // open, which is what lets the tab render instead of fetch.
  const rotService = !svc.running
    ? 'Background rotation service is not running.'
    : svc.chainsHeld + ' chain' + (svc.chainsHeld === 1 ? '' : 's') + ' watched · ' +
      svc.poolsConnected + ' pools in memory · rebuilt ' + ago(svc.lastTickAt) +
      ' · no extra requests (rides the wallet sample)';
  const rotServiceLive = svc.running && !svc.lastError;

  const shell = { rotService, rotServiceLive };

  // App gates this tab behind a selection, so this is a guard, not a screen.
  if (!sel) return { ...shell, rotReady: false, rotNotice: 'Pick a token from Live Opportunities.' };

  const ticker = tick(sel.sym || '?');
  const chainKey = (sel.rawServerRow && sel.rawServerRow.chain) ||
    chainNameToKey[sel.chain] || null;

  const token = rotationForPool(sel.poolAddress);
  const chainGraph = chainKey ? rotationGraphFor(chainKey) : null;

  const assets = app.assets || [];
  const openFor = (poolAddress) => {
    const hit = assets.find((a) => a.poolAddress === poolAddress);
    return hit && hit.id !== sel.id
      ? () => app.setState({ page: 'rotation', selectedId: hit.id })
      : null;
  };

  // Two sampled pools can carry the same ticker, and printing both as "$STONK"
  // turns a real measurement into "$STONK -> $STONK". The graph is keyed by
  // pool address, so only the LABEL is ambiguous: when a ticker is not unique,
  // every pool wearing it gets its address tail appended.
  const tickerCount = new Map();
  ((chainGraph && chainGraph.nodes) || []).forEach((n) => {
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

  /* ------------------------------------------------------ chain context -- */

  let rotChainStats = [];
  let rotChainNet = [];
  let rotChainWindow = '';

  if (chainGraph && chainGraph.poolsSampled) {
    const windowSpan = span(chainGraph.firstTradeAt, chainGraph.lastTradeAt);
    rotChainWindow = [
      chainGraph.poolsSampled + ' pools sampled',
      chainGraph.sharedWalletCount + ' shared wallets',
      windowSpan ? 'over ' + windowSpan : null,
    ].filter(Boolean).join(' · ');

    rotChainStats = [
      {
        label: 'CHAIN ROTATED', value: fmtUsd(chainGraph.rotatedUsd), color: IN,
        note: 'across ' + (chainGraph.pathsRotating || 0) + ' paths',
        tip: 'Total rotation among the pools sampled on this chain. It is a floor, not a chain total: only sampled pools can take part.',
      },
      {
        label: 'PARALLEL — EXCLUDED', value: fmtUsd(chainGraph.parallelUsd), color: NEUTRAL,
        note: 'bought both, or sold both',
        tip: 'Shared wallets that bought both pools, or sold both. Two positions at once is not capital moving between them, so it is excluded.',
      },
    ];

    const involved = (chainGraph.nodes || []).filter((n) => n.rotatedUsd > 0);
    const maxNet = Math.max(...involved.map((n) => Math.abs(n.netRotationUsd)), 1);
    rotChainNet = involved
      .slice()
      .sort((a, b) => b.netRotationUsd - a.netRotationUsd)
      .map((n) => ({
        key: n.poolAddress,
        sym: labelFor(n.symbol, n.poolAddress),
        val: signed(n.netRotationUsd),
        isSelf: n.poolAddress === sel.poolAddress,
        color: n.netRotationUsd > 0 ? IN : n.netRotationUsd < 0 ? OUT : NEUTRAL,
        posW: n.netRotationUsd > 0 ? pct(n.netRotationUsd, maxNet) + '%' : '0%',
        negW: n.netRotationUsd < 0 ? pct(-n.netRotationUsd, maxNet) + '%' : '0%',
        open: openFor(n.poolAddress),
        tip: labelFor(n.symbol, n.poolAddress) + ' took in ' + fmtUsd(n.inUsd) +
          ' and gave up ' + fmtUsd(n.outUsd) + ' across ' + n.connections +
          ' connected pool' + (n.connections === 1 ? '' : 's') + '.',
      }));
  }

  const context = {
    ...shell,
    rotReady: true,
    rotToken: ticker,
    rotChain: chainKey || '',
    rotChainStats,
    rotChainNet,
    rotChainWindow,
  };

  /* ------------------------------------------- this token, not yet known -- */

  if (!token) {
    return {
      ...context,
      rotHasToken: false,
      rotTokenNotice: st.serverError
        ? 'The data server is unreachable, so no trades could be sampled. Nothing is shown rather than simulated.'
        : chainGraph && chainGraph.poolsSampled
          ? 'The background sampler has not reached ' + ticker + '’s pool yet, so there is no wallet overlap to measure for it. ' +
            'It samples a couple of pools per chain per cycle, so coverage arrives in order, not all at once. What is moving on this chain meanwhile:'
          : 'No pools have been sampled on ' + (chainKey || 'this chain') + ' yet, so there is nothing to compare ' + ticker + ' against.',
    };
  }

  /* -------------------------------------------------------- this token --- */

  // Drawn lists are capped per direction; the COUNTS below come from the
  // service's pre-slice totals. Counting the drawn list instead is how the
  // tiles once read "LEFT $930" beside "0 destinations" - the one outbound
  // peer had been ranked out of a combined top-12 by a wall of inbound ones.
  const inPeers = token.inPeers || [];
  const outPeers = token.outPeers || [];
  const inCount = token.inCount || 0;
  const outCount = token.outCount || 0;
  const hidden = (inCount - inPeers.length) + (outCount - outPeers.length);

  const windowSpan = span(token.firstTradeAt, token.lastTradeAt);
  const rotWindow = [
    token.trades ? token.trades.toLocaleString('en-US') + ' trades' : null,
    token.wallets.toLocaleString('en-US') + ' wallets',
    'vs ' + token.poolsCompared + ' other sampled pool' + (token.poolsCompared === 1 ? '' : 's'),
    windowSpan ? 'over ' + windowSpan : null,
  ].filter(Boolean).join(' · ');

  const rotStats = [
    {
      label: 'NET ROTATION', value: signed(token.netRotationUsd),
      color: token.netRotationUsd > 0 ? IN : token.netRotationUsd < 0 ? OUT : NEUTRAL,
      note: token.netRotationUsd > 0 ? 'the crowd is arriving' : token.netRotationUsd < 0 ? 'the crowd is leaving' : 'balanced',
      tip: 'Capital arriving from other sampled pools minus capital leaving for them, in this window.',
    },
    {
      label: 'ARRIVED', value: fmtUsd(token.inUsd), color: IN,
      note: 'from ' + (token.receivedFrom || 0) + ' pool' + (token.receivedFrom === 1 ? '' : 's'),
      tip: 'Wallets that were net sellers of another sampled pool and net buyers here. Credited as min(amount out, amount in), so the same dollars are never counted twice.',
    },
    {
      label: 'LEFT', value: fmtUsd(token.outUsd), color: OUT,
      note: 'to ' + (token.sentTo || 0) + ' pool' + (token.sentTo === 1 ? '' : 's'),
      tip: 'Wallets that were net sellers here and net buyers of another sampled pool. This counts every pool that received something, including ones the diagram files on the arriving side because more came back the other way. A small figure is normal for a token being accumulated.',
    },
    {
      label: 'CONNECTED POOLS', value: String(token.connections),
      color: token.connections ? '#4fc3f7' : NEUTRAL,
      note: 'of ' + token.poolsCompared + ' compared',
      tip: 'Sampled pools sharing at least one wallet with this one. Coverage is the sampler’s reach, not the whole chain.',
    },
  ];

  // Three different kinds of nothing, and they do not mean the same thing:
  // no overlap at all, overlap without direction, and a real path. Collapsing
  // the first two into one sentence had the lead claiming shared wallets on a
  // token whose own CONNECTED POOLS tile said zero.
  const biggest = (token.peers || [])[0];
  const rotLead = !token.connections
    ? 'No wallet that traded ' + ticker + ' in this window also turns up in any of the ' +
      token.poolsCompared + ' other sampled pool' + (token.poolsCompared === 1 ? '' : 's') +
      '. Its crowd is its own — which is a result, not a gap.'
    : !biggest
    ? ticker + ' shares wallets with ' + token.connections + ' other sampled pool' +
      (token.connections === 1 ? '' : 's') + ', but none of those wallets sold one side and bought ' +
      'the other. That is parallel positioning, not rotation.'
    : biggest.direction === 'out'
      ? biggest.sharedWallets + ' wallet' + (biggest.sharedWallets === 1 ? '' : 's') + ' moved ' +
        fmtUsd(biggest.rotatedUsd) + ' out of ' + ticker + ' and into ' +
        labelFor(biggest.symbol, biggest.poolAddress) + ' — the strongest path in this window.'
      : biggest.sharedWallets + ' wallet' + (biggest.sharedWallets === 1 ? '' : 's') + ' moved ' +
        fmtUsd(biggest.rotatedUsd) + ' out of ' + labelFor(biggest.symbol, biggest.poolAddress) +
        ' and into ' + ticker + ' — the strongest path in this window.';

  const rotFlow = (inPeers.length || outPeers.length)
    ? egoBars(inPeers, outPeers, { inUsd: token.inUsd, outUsd: token.outUsd }, labelFor, openFor)
    : null;


  return {
    ...context,
    rotHasToken: true,
    rotWindow,
    rotSampled: 'sampled ' + ago(token.sampledAt),
    rotLead,
    rotStats,
    rotFlow,
    rotInEmpty: inCount === 0 ? 'nothing arrived from another sampled pool' : '',
    rotOutEmpty: outCount === 0 ? 'nothing left for another sampled pool' : '',
    // Drawing a subset is fine; drawing a subset silently is not.
    rotTruncated: hidden > 0
      ? 'showing the ' + inPeers.length + ' largest of ' + inCount + ' sources and the ' +
        outPeers.length + ' largest of ' + outCount + ' destinations'
      : '',
    // The empty card names which of the two empties this is, for the same
    // reason the lead does.
    rotEmptyTitle: token.connections
      ? 'NO DIRECTED ROTATION IN THIS WINDOW'
      : 'NO SHARED WALLETS IN THIS WINDOW',
    rotEmptyBody: token.connections
      ? ticker + ' shares wallets with ' + token.connections + ' other sampled pool' +
        (token.connections === 1 ? '' : 's') + ', but none of those wallets sold one side and ' +
        'bought the other. That is parallel positioning, not rotation, so nothing is drawn.'
      : 'Not one of ' + ticker + '’s ' + token.wallets.toLocaleString('en-US') +
        ' sampled wallets appears in any of the ' + token.poolsCompared + ' other pools sampled on ' +
        (chainKey || 'this chain') + '. There is no overlap to give a direction to.',
    rotFirstSeen: token.firstRotatingAt
      ? 'first seen rotating ' + ago(token.firstRotatingAt) + ' · peak ' + fmtUsd(token.peakRotatedUsd)
      : '',
  };
}

/* ============================================================== render === */

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

/** The chain picture: context when the token is known, fallback when it is not. */
function ChainContext({ v, css }) {
  if (!v.rotChainNet.length) return false;
  return (
    <div style={css(CARD + ';padding:12px;margin-top:10px', { v })}>
      <div style={css('display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:9px', { v })}>
        <div style={css(CAP, { v })}>
          MEANWHILE ON {String(v.rotChain || 'this chain').toUpperCase()}
        </div>
        <div style={css('font-size:8.5px;color:#4a5578', { v })}>{v.rotChainWindow}</div>
      </div>

      <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:9px;margin-bottom:11px', { v })}>
        {v.rotChainStats.map((s, i) => (
          <div key={i} title={s.tip} style={css('background:#101c38;border:1px solid #1c2a4d;border-radius:8px;padding:8px 11px', { v, s })}>
            <div style={css(CAP, { v, s })}>{s.label}</div>
            <div style={css('font-size:15px;font-weight:700;margin-top:2px;color:{{ s.color }}', { v, s })}>{s.value}</div>
            <div style={css('font-size:8.5px;color:#6b7699;margin-top:1px', { v, s })}>{s.note}</div>
          </div>
        ))}
      </div>

      <div style={css('display:flex;font-size:8px;color:#4a5578;letter-spacing:.8px;margin:0 0 4px;padding:0 78px 0 116px', { v })}>
        <div style={css('flex:1;text-align:left', { v })}>LOST</div>
        <div style={css('width:1px', { v })} />
        <div style={css('flex:1;text-align:right', { v })}>GAINED</div>
      </div>

      {v.rotChainNet.map((c) => (
        <div
          key={c.key} onClick={c.open} title={c.tip}
          style={css('display:flex;align-items:center;gap:9px;padding:4px 0;border-bottom:1px solid #16223f' +
            (c.open ? ';cursor:pointer' : '') +
            (c.isSelf ? ';background:rgba(227,95,242,0.06)' : ''), { v, c })}
        >
          <span style={css('width:107px;font-size:10.5px;font-weight:' + (c.isSelf ? '800' : '600') +
            ';color:' + (c.isSelf ? '#ffffff' : '#c6d1ea') +
            ';flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:' +
            (c.isSelf ? '4px' : '0'), { v, c })}>{c.sym}</span>
          <div style={css('flex:1;display:flex;height:11px;min-width:0', { v, c })}>
            <div style={css('width:50%;display:flex;justify-content:flex-end', { v, c })}>
              <div style={css('width:{{ c.negW }};background:linear-gradient(90deg,rgba(255,79,174,.35),' + OUT + ');border-radius:2px 0 0 2px', { v, c })} />
            </div>
            <div style={css('width:1px;background:#2a3a5f', { v, c })} />
            <div style={css('width:50%;display:flex', { v, c })}>
              <div style={css('width:{{ c.posW }};background:linear-gradient(90deg,' + IN + ',rgba(77,141,255,.35));border-radius:0 2px 2px 0', { v, c })} />
            </div>
          </div>
          <span style={css('width:69px;text-align:right;font-size:10.5px;font-weight:700;color:{{ c.color }};flex-shrink:0', { v, c })}>{c.val}</span>
        </div>
      ))}
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
        </div>
      </div>
    );
  }

  const f = v.rotFlow;

  return (
    <div data-screen-label="Rotation" style={css('flex:1;overflow:auto;padding:12px 14px;min-height:0', { v })}>

      <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px', { v })}>
        <div style={css('font-size:13px;font-weight:800;color:#ffffff;letter-spacing:.3px', { v })}>
          WHERE {v.rotToken}’S CROWD IS GOING
        </div>
        {v.rotHasToken && (
          <div
            title="Every figure below is measured over the trades actually sampled from this pool and the others it is compared against. It is a window, not history."
            style={css('font-size:9.5px;color:#6b7699;background:#0d1730;border:1px solid #1c2a4d;border-radius:999px;padding:3px 10px', { v })}
          >{v.rotWindow}</div>
        )}
        {v.rotChain && (
          <div style={css('font-size:9.5px;color:#4d8dff;font-family:monospace', { v })}>{v.rotChain}</div>
        )}
        {v.rotHasToken && (
          <div style={css('font-size:9px;color:#4a5578', { v })}>{v.rotSampled}</div>
        )}
      </div>

      <ServiceLine v={v} css={css} />

      {!v.rotHasToken ? (
        <>
          <div style={css(CARD + ';padding:16px 18px', { v })}>
            <div style={css(CAP + ';margin-bottom:7px', { v })}>{v.rotToken} NOT SAMPLED YET</div>
            <div style={css('font-size:11px;color:#c6d1ea;line-height:1.6;max-width:760px', { v })}>
              {v.rotTokenNotice}
            </div>
          </div>
          <ChainContext v={v} css={css} />
        </>
      ) : (
        <>
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

          {f ? (
            <div style={css(CARD + ';padding:12px 14px', { v })}>
              <div style={css('display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap', { v })}>
                <div style={css(CAP, { v })}>ROTATION PATHS</div>
                <div style={css('font-size:8.5px;color:#4a5578;letter-spacing:.5px', { v })}>
                  {v.rotTruncated || 'bar length = rotated USD · one scale, both directions'}
                </div>
              </div>

              {/* The gestalt first: how the two directions weigh against
                  each other, before any per-peer detail. */}
              <div style={css('display:flex;height:9px;border-radius:5px;overflow:hidden;background:#16223f;margin:9px 0 3px', { v })}>
                <div title={f.balance.outLabel} style={css('width:{{ f.balance.outW }};background:linear-gradient(90deg,rgba(255,79,174,.55),' + OUT + ')', { v, f })} />
                <div title={f.balance.inLabel} style={css('width:{{ f.balance.inW }};background:linear-gradient(90deg,' + IN + ',rgba(77,141,255,.55))', { v, f })} />
              </div>
              <div style={css('display:flex;justify-content:space-between;font-size:8.5px;font-weight:700;letter-spacing:.6px;margin-bottom:9px', { v })}>
                <span style={css('color:' + OUT, { v })}>{f.balance.showOut ? f.balance.outLabel : ''}</span>
                <span style={css('color:' + IN, { v })}>{f.balance.showIn ? f.balance.inLabel : ''}</span>
              </div>

              <div style={css('display:flex;font-size:8px;color:#4a5578;letter-spacing:.8px;margin-bottom:3px;padding:0 82px 0 132px', { v })}>
                <div style={css('flex:1;text-align:left', { v })}>LEFT FOR</div>
                <div style={css('width:1px', { v })} />
                <div style={css('flex:1;text-align:right', { v })}>ARRIVED FROM</div>
              </div>

              {f.rows.map((r, i) => (
                <React.Fragment key={r.key}>
                  {i === f.turn && (
                    <div style={css('height:1px;background:#22304f;margin:4px 0', { v })} />
                  )}
                  <div
                    onClick={r.open} title={r.tip}
                    style={css('display:flex;align-items:center;gap:9px;padding:4px 0;border-bottom:1px solid #16223f' +
                      (r.open ? ';cursor:pointer' : ''), { v, r })}
                  >
                    <span style={css('width:123px;flex-shrink:0;font-size:10.5px;font-weight:700;color:#dfe6f6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, r })}>
                      {r.label}{r.twoWay ? ' ⇄' : ''}
                    </span>
                    <div style={css('flex:1;display:flex;height:12px;min-width:0', { v, r })}>
                      <div style={css('width:50%;display:flex;justify-content:flex-end', { v, r })}>
                        {r.outbound && (
                          <div style={css('width:{{ r.w }};background:linear-gradient(90deg,rgba(255,79,174,.3),' + OUT + ');border-radius:2px 0 0 2px', { v, r })} />
                        )}
                      </div>
                      <div style={css('width:1px;background:#2a3a5f', { v, r })} />
                      <div style={css('width:50%;display:flex', { v, r })}>
                        {!r.outbound && (
                          <div style={css('width:{{ r.w }};background:linear-gradient(90deg,' + IN + ',rgba(77,141,255,.3));border-radius:0 2px 2px 0', { v, r })} />
                        )}
                      </div>
                    </div>
                    <span style={css('width:66px;flex-shrink:0;text-align:right;font-size:10.5px;font-weight:700;color:{{ r.colour }}', { v, r })}>{r.val}</span>
                    <span style={css('width:62px;flex-shrink:0;text-align:right;font-size:8px;color:#4a5578', { v, r })}>{r.meta}</span>
                  </div>
                </React.Fragment>
              ))}

              {(v.rotInEmpty || v.rotOutEmpty) && (
                <div style={css('font-size:9px;color:#4a5578;margin-top:7px', { v })}>
                  {v.rotInEmpty || v.rotOutEmpty}
                </div>
              )}

              {v.rotFirstSeen && (
                <div style={css('font-size:8.5px;color:#4a5578;margin-top:6px', { v })}>{v.rotFirstSeen}</div>
              )}
            </div>
          ) : (
            <div style={css(CARD + ';padding:16px 18px', { v })}>
              <div style={css(CAP + ';margin-bottom:7px', { v })}>{v.rotEmptyTitle}</div>
              <div style={css('font-size:11px;color:#8b96b8;line-height:1.6;max-width:700px', { v })}>
                {v.rotEmptyBody}
              </div>
            </div>
          )}

          <ChainContext v={v} css={css} />
        </>
      )}

      <div style={css('margin-top:10px;padding:10px 12px;background:#0d1730;border:1px solid #16223f;border-radius:8px;font-size:9.5px;color:#6b7699;line-height:1.65;max-width:1040px', { v })}>
        <span style={css('color:#8b96b8;font-weight:700', { v })}>How this is measured. </span>
        A wallet counts as rotation only when it is a net seller of one pool and a net buyer of the
        other; the amount credited is the smaller of the two sides, so the same dollars are never
        counted twice. Wallets that bought both, or sold both, are parallel positioning and are
        excluded. Everything here is a floor, not a total: {v.rotToken} is compared only against the
        pools the sampler has already reached on {v.rotChain || 'this chain'}, within the window
        printed above. Rotation is measured within one chain and is never cross-chain.
      </div>
    </div>
  );
}
