import React from 'react';
import { UNAVAILABLE, fmtUsd } from '../utils/formatters';
import { explorerAddressUrl } from '../data/chains';
import { shortAddress, normalizeRegistry } from '../data/wallet-registry';
import {
  walletIntelForPool, walletProfile, walletIntelStatus, recentClusters,
} from '../services/wallet-intel';

/**
 * The wallet read on ONE token.
 *
 * What this tab used to do: aggregate every wallet the server had sampled
 * anywhere on a chain, print the token's ticker in a column headed CHAIN, and
 * call anything that had touched three pools a BUNDLER. It never looked at the
 * selected token at all.
 *
 * What it does now: take the selected token's pool, read a real sample of its
 * trades, and say who is in it - who is accumulating, who is leaving, who is
 * churning, who arrived in a co-ordinated burst, who also trades other pools
 * we are watching, and which of them hold enough supply to matter.
 *
 * Two rules the old version broke, kept here deliberately:
 *   - every number describes the sampled WINDOW, which is printed above them;
 *   - nothing is invented. A field the providers did not answer is a grey dash,
 *     never a placeholder that reads like a measurement.
 */

/* ---------------------------------------------------------------- tags --- */

/**
 * Each tag names a pattern that was actually measured, and each is earned:
 * CO-ENTRY and CHURN in particular are deliberately hard to trigger, because
 * a label that fires on most wallets tells you nothing. See tokenWalletIntel()
 * in src/calculations/core.js for the tests behind them.
 */
const TAG_STYLE = {
  'CO-ENTRY': { bg: '#45103a', fg: '#ff4fae', tip: 'First trade landed in the same 2s as several other wallets, for near-identical size' },
  CHURN: { bg: '#33124a', fg: '#e35ff2', tip: 'Bought and sold repeatedly and ended near flat - volume without a position' },
  EXITING: { bg: '#3a1533', fg: '#ff8fa3', tip: 'Only sold in this window' },
  ACCUMULATING: { bg: '#0d2f3a', fg: '#4fd6c1', tip: 'Only bought, more than once' },
  'FIRST BUY': { bg: '#12253f', fg: '#7fb0ff', tip: 'One buy, no sells - first appearance in this window' },
  'ROUND-TRIP': { bg: '#2a2360', fg: '#a89bff', tip: 'Bought and sold, but ended meaningfully up or down' },
  ROTATING: { bg: '#0e2a5c', fg: '#4d8dff', tip: 'Also trades other pools we are sampling' },
  HOLDER: { bg: '#3d2a08', fg: '#ffbe4d', tip: 'Also appears in the token top-holder list' },
  TRACKED: { bg: '#123a2a', fg: '#4fe08f', tip: 'On your tracked list' },
  POOL: { bg: '#1a2440', fg: '#6b7699', tip: 'The pool or another sampled pool - infrastructure, not a trader' },
};
const tagStyle = (t) => TAG_STYLE[t] || { bg: '#1a2440', fg: '#a3aed0', tip: '' };

/** The chips above the table, in the order they are worth reaching for. */
const FILTERS = [
  { key: 'ALL', label: 'ALL' },
  { key: 'ACCUMULATING', label: 'ACCUMULATING' },
  { key: 'EXITING', label: 'EXITING' },
  { key: 'CO-ENTRY', label: 'CO-ENTRY' },
  { key: 'CHURN', label: 'CHURN' },
  { key: 'ROTATING', label: 'ROTATING' },
  { key: 'HOLDER', label: 'HOLDERS' },
  { key: 'TRACKED', label: 'TRACKED' },
];

/* ----------------------------------------------------------- formatting -- */

const ago = (ms) => {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return Math.round(s) + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return (s / 3600).toFixed(1) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};

const dur = (ms) => {
  const s = (ms || 0) / 1000;
  if (s < 90) return Math.round(s) + 's';
  if (s < 3600) return Math.round(s / 60) + 'm';
  return (s / 3600).toFixed(1) + 'h';
};

/** "12m ago · 50s active", or just the age for a wallet that traded once. */
const seenLine = (lastAt, activeMs) =>
  ago(lastAt) + (activeMs >= 1000 ? ' · ' + dur(activeMs) + ' active' : ' · one trade');

const signed = (v) => (v > 0 ? '+' : '') + fmtUsd(v);
const netColor = (v) => (v > 0 ? '#4fd6c1' : v < 0 ? '#ff8fa3' : '#8b96b8');

/**
 * Supply share, with enough precision to stay a measurement.
 *
 * A top holder of a 1bn-supply token can hold a real position and still round
 * to "0.00%", which reads as nothing rather than as a small number, so the
 * decimals follow the magnitude.
 */
const pctOfSupply = (v) => {
  if (v === null || v === undefined) return '—';
  if (v === 0) return '0%';
  if (v >= 1) return v.toFixed(2) + '%';
  if (v >= 0.01) return v.toFixed(3) + '%';
  return v.toPrecision(2) + '%';
};

/* --------------------------------------------------------------- values -- */

export function walletsVals(app, sel) {
  const st = app.state;
  const api = st.apiWallets;

  const tracked = (st.registry || []).map((w) => ({
    ...w,
    short: shortAddress(w.address),
    remove: () => saveRegistry(app, st.registry.filter((x) => x.address !== w.address)),
  }));

  const addWallet = () => {
    const address = String(st.walletInput || '').trim();
    if (!address) return;
    if (st.registry.some((w) => w.address.toLowerCase() === address.toLowerCase())) {
      app.setState({ walletInput: '', walletLabel: '' });
      return;
    }
    saveRegistry(app, [
      { address, label: String(st.walletLabel || '').trim() || 'Tracked wallet', addedAt: Date.now() },
      ...st.registry,
    ]);
    app.setState({ walletInput: '', walletLabel: '' });
  };

  const shell = {
    walletInput: st.walletInput,
    walletLabel: st.walletLabel,
    onWalletInput: (e) => app.setState({ walletInput: e.target.value }),
    onWalletLabel: (e) => app.setState({ walletLabel: e.target.value }),
    addWallet,
    trackedList: tracked,
    trackedCount: tracked.length,
  };

  if (!sel) return { ...shell, walletsReady: false, walletsNotice: null };

  const ticker = String((sel.sym || '')).replace(/^\$/, '').toUpperCase();

  // Two sources for the same token, preferred in this order:
  //
  //   1. the on-demand read, which forced a fresh sample of THIS pool and is
  //      the only one that carries the holder list;
  //   2. the background service, which has been processing every held pool all
  //      along - so switching token usually paints immediately instead of
  //      sitting on "sampling..." until the next poll returns.
  //
  // A payload for the previously selected token is neither: showing it under
  // this token's name would caption the wrong data.
  const onDemand = api && api.server === 'ok' &&
    (!sel.tokenAddress || !api.tokenAddress || api.tokenAddress === sel.tokenAddress)
    ? api : null;
  const fromStore = walletIntelForPool(sel.poolAddress);
  const source = onDemand || fromStore;

  if (!source || !source.rows || !source.rows.length) {
    return {
      ...shell,
      walletsReady: false,
      walletsToken: ticker,
      walletsNotice: st.serverError
        ? 'The data server is unreachable, so no trades could be sampled. Nothing is shown rather than simulated.'
        : 'Sampling this pool’s trades… the background service has not reached this pool yet.',
    };
  }

  const chainKey = (sel.rawServerRow && sel.rawServerRow.chain) || source.chain;
  const w = source.window;
  const flow = source.flow;
  const counts = source.counts;
  const filter = st.walletFilter || 'ALL';

  // The pool contract trades against everybody, so it is excluded from the
  // behavioural table; it stays visible in the holder panel, labelled.
  const visible = source.rows.filter((r) => !r.isPool)
    .filter((r) => (filter === 'ALL' ? true : r.tags.includes(filter)));

  // Bars are scaled to the biggest wallet on screen, so the column stays
  // readable whether the top wallet moved $200 or $200k.
  const peak = visible.reduce((m, r) => Math.max(m, Math.abs(r.netUsd)), 0) || 1;

  const walletRows = visible.slice(0, 80).map((r) => {
    const url = explorerAddressUrl(chainKey, r.address);
    // Halved, because the bar grows out of the centre line: the biggest wallet
    // should fill its own half of the track, not the whole width of it.
    const share = Math.min(50, (Math.abs(r.netUsd) / peak) * 50);
    return {
      key: r.address,
      address: r.address,
      short: shortAddress(r.address),
      url,
      openExplorer: url ? () => window.open(url, '_blank', 'noopener,noreferrer') : null,
      copy: () => { try { navigator.clipboard.writeText(r.address); } catch (e) { /* no clipboard */ } },
      net: signed(r.netUsd),
      netC: netColor(r.netUsd),
      // Zero-centred: buying pushes right, selling pushes left.
      barW: share.toFixed(1) + '%',
      barSide: r.netUsd >= 0 ? 'left:50%' : 'right:50%',
      barC: r.netUsd >= 0 ? '#4fd6c1' : '#ff8fa3',
      bought: r.buyUsd ? fmtUsd(r.buyUsd) : '—',
      boughtC: r.buyUsd ? '#c6d1ea' : UNAVAILABLE,
      sold: r.sellUsd ? fmtUsd(r.sellUsd) : '—',
      soldC: r.sellUsd ? '#c6d1ea' : UNAVAILABLE,
      trades: r.buys + '/' + r.sells,
      seen: seenLine(r.lastAt, r.activeMs),
      supply: pctOfSupply(r.supplyPct),
      supplyC: r.supplyPct === null ? UNAVAILABLE : '#ffbe4d',
      alsoIn: r.alsoIn.map((p) => p.symbol).join(' · ') || '—',
      alsoInC: r.alsoIn.length ? '#4d8dff' : UNAVAILABLE,
      tags: r.tags.filter((t) => t !== 'POOL').map((t) => ({ t, ...tagStyle(t) })),
      // What the background service has learned about this wallet everywhere
      // else, over every sample since it started - not just in this window.
      history: (() => {
        const p = walletProfile(r.address);
        if (!p || (p.tokensTouched <= 1 && !p.clusterHits)) return null;
        const parts = [];
        if (p.tokensTouched > 1) parts.push(p.tokensTouched + ' tokens seen');
        if (p.clusterHits) parts.push(p.clusterHits + '× co-entry');
        return parts.join(' · ');
      })(),
    };
  });

  const stat = (label, value, color, note) => ({
    label, value: value === null || value === undefined ? '—' : value,
    color: value === null || value === undefined ? UNAVAILABLE : color, note: note || '',
  });

  const holderPanel = source.holders.map((h) => {
    const url = explorerAddressUrl(chainKey, h.address);
    return {
      key: h.address,
      short: shortAddress(h.address),
      url,
      openExplorer: url ? () => window.open(url, '_blank', 'noopener,noreferrer') : null,
      pct: pctOfSupply(h.supplyPct),
      pctC: h.supplyPct === null ? UNAVAILABLE : (h.isPool ? '#6b7699' : '#ffbe4d'),
      // Scaled against the largest holder, not against 100%, or every bar on a
      // well-distributed token would be an invisible sliver.
      barW: Math.min(100, ((h.supplyPct || 0) / (source.holders[0].supplyPct || 1)) * 100).toFixed(1) + '%',
      barC: h.isPool ? '#2b3a5c' : '#ffbe4d',
      role: h.isPool ? 'LP / POOL' : (h.tag || (h.locked ? 'LOCKED' : 'WALLET')),
      roleC: h.isPool ? '#6b7699' : (h.locked ? '#4fd6c1' : '#8b96b8'),
      activeNow: h.tradingNow,
      activeTxt: h.tradingNow ? signed(h.netUsd) + ' in window' : 'dormant in window',
      activeC: h.tradingNow ? netColor(h.netUsd) : UNAVAILABLE,
      isTracked: h.isTracked,
    };
  });

  const CONF = {
    high: { fg: '#ff4fae', bd: '#45103a', bg: '#150a18', label: 'HIGH CONFIDENCE' },
    medium: { fg: '#e35ff2', bd: '#33124a', bg: '#130a1a', label: 'MEDIUM' },
    low: { fg: '#a89bff', bd: '#2a2360', bg: '#0d0b1c', label: 'LOW' },
  };
  const clusterPanel = source.clusters.map((c, i) => {
    const conf = CONF[c.confidence] || CONF.low;
    return {
      key: i,
      ...conf,
      title: c.wallets + ' wallets entered together',
      when: ago(c.at),
      detail: 'within ' + dur(c.spanMs) + ' · ' + fmtUsd(c.avgEntryUsd) +
        ' each ±' + c.sizeSpreadPct + '%',
      // The exit is the part that is hard to explain away, so it gets its own
      // line rather than being folded into the summary.
      exit: c.exit
        ? c.exit.wallets + ' of them sold together ' + dur(c.exit.afterMs) + ' later'
        : null,
      gross: fmtUsd(c.grossUsd),
    };
  });

  // Which of the user's tracked wallets turned up in THIS token.
  const seenHere = new Set(source.rows.map((r) => r.address.toLowerCase()));
  const trackedHere = tracked.map((t) => {
    const hit = source.rows.find((r) => r.address.toLowerCase() === t.address.toLowerCase());
    return {
      ...t,
      here: seenHere.has(t.address.toLowerCase()),
      detail: hit ? signed(hit.netUsd) + ' · ' + hit.buys + ' buys / ' + hit.sells + ' sells' : 'not in this window',
      detailC: hit ? netColor(hit.netUsd) : UNAVAILABLE,
    };
  });

  return {
    ...shell,
    walletsReady: true,
    walletsNotice: null,
    walletsToken: ticker,
    trackedList: trackedHere,

    windowLine: w.trades + ' trades · ' + w.wallets + ' wallets · ' +
      (w.spanMinutes === null ? 'unknown span' : 'last ' + dur(w.spanMinutes * 60000)) +
      ' · sampled ' + ago(source.sampledAt),
    windowPool: shortAddress(source.poolAddress),

    walletStats: [
      stat('ACTIVE WALLETS', w.wallets, '#ffffff',
        flow.onceOnlyPct === null ? '' : flow.onceOnlyPct + '% traded once'),
      stat('NET FLOW', flow.netUsd === null ? null : signed(flow.netUsd), netColor(flow.netUsd),
        flow.buySharePct === null ? '' : flow.buySharePct + '% of volume was buys'),
      stat('BUYERS / SELLERS', flow.buyerWallets + ' / ' + flow.sellerWallets, '#4d8dff',
        'distinct wallets each side'),
      stat('TOP WALLET SHARE', flow.topWalletSharePct === null ? null : flow.topWalletSharePct + '%',
        flow.topWalletSharePct >= 25 ? '#ff4fae' : '#c6d1ea', 'of window volume'),
      stat('CO-ENTRY WALLETS', counts.coEntry, counts.coEntry ? '#ff4fae' : '#4fd6c1',
        source.clusters.length + (source.clusters.length === 1 ? ' burst' : ' bursts')),
    ],

    walletFilters: FILTERS.map((f) => {
      const n = f.key === 'ALL'
        ? source.rows.filter((r) => !r.isPool).length
        : source.rows.filter((r) => !r.isPool && r.tags.includes(f.key)).length;
      return {
        ...f, count: n, active: (st.walletFilter || 'ALL') === f.key,
        pick: () => app.setState({ walletFilter: f.key }),
      };
    }),

    walletRows,
    walletRowsShown: walletRows.length,
    walletRowsTotal: visible.length,
    holderPanel,
    holdersNote: source.holdersAvailable
      ? 'Top holders by share of supply, from GoPlus. The pool contract itself is labelled rather than counted as a whale.'
      : 'No provider returned a holder list for this token.',
    clusterPanel,
    clustersNote: source.clusters.length
      ? 'Wallets whose first trade landed together, for near-identical size, more often than this pool’s own arrival rate explains.'
      : 'No co-ordinated entry in this window. Wallets arrived at the rate and in the sizes you would expect from unrelated traders.',
    rotationNote: source.poolsCompared
      ? 'Cross-pool overlap is measured against ' + source.poolsCompared + ' other pools sampled on ' + source.chain + '.'
      : 'No other pools sampled on this chain yet, so cross-pool overlap cannot be measured.',

    // The background service, made visible. It runs whether or not this tab is
    // open, so the user should be able to see that it is working and how far
    // its coverage currently reaches.
    intelLine: (() => {
      const s = walletIntelStatus();
      if (!s.running) return 'Background wallet service is not running.';
      return s.poolsHeld + ' pools watched · ' + s.walletsKnown.toLocaleString() +
        ' wallets in memory · ' + s.clusters + ' clusters logged · refreshed ' +
        ago(s.lastTickAt);
    })(),
    intelLive: walletIntelStatus().running && !walletIntelStatus().lastError,
    // Clusters found on OTHER tokens while this tab was closed.
    elsewhereClusters: recentClusters({ limit: 6, minConfidence: 'medium' })
      .filter((c) => c.poolAddress !== sel.poolAddress)
      .map((c) => ({
        key: c.id,
        sym: c.symbol ? '$' + c.symbol : c.poolAddress.slice(0, 6),
        text: c.wallets + ' wallets · ' + fmtUsd(c.avgEntryUsd) + ' each',
        when: ago(c.at),
        fg: c.confidence === 'high' ? '#ff4fae' : '#e35ff2',
      })),
  };
}

export function saveRegistry(app, reg) {
  const clean = normalizeRegistry(reg);
  app.setState({ registry: clean });
  try { localStorage.setItem('vs_wallet_registry', JSON.stringify(clean)); } catch (e) { }
}

/* ------------------------------------------------------------ component -- */

const CARD = 'background:#0a1226;border:1px solid #1c2a4d;border-radius:10px';
const CAP = 'font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600';

function Tag({ t, css }) {
  return (
    <span
      title={t.tip}
      style={css('font-size:8px;font-weight:800;padding:2px 6px;border-radius:999px;background:{{ t.bg }};color:{{ t.fg }};white-space:nowrap;letter-spacing:.4px', { t })}
    >{t.t}</span>
  );
}

export default function Wallets({ v, css }) {
  if (!v.isWallets) return false;

  if (!v.walletsReady) {
    return (
      <div data-screen-label="Wallet registry" style={css('flex:1;overflow:auto;padding:12px 14px;min-height:0', { v })}>
        <div style={css(CARD + ';padding:22px', { v })}>
          <div style={css(CAP + ';margin-bottom:8px', { v })}>
            WALLETS{v.walletsToken ? ' — $' + v.walletsToken : ''}
          </div>
          <div style={css('font-size:11px;color:#c6d1ea;line-height:1.6', { v })}>{v.walletsNotice}</div>
        </div>
      </div>
    );
  }

  return (
    <div data-screen-label="Wallet registry" style={css('flex:1;overflow:auto;padding:12px 14px;min-height:0', { v })}>

      {/* The window every number below is measured over. */}
      <div style={css('display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px', { v })}>
        <div style={css('font-size:13px;font-weight:800;color:#ffffff;letter-spacing:.3px', { v })}>
          WHO IS TRADING ${v.walletsToken}
        </div>
        <div style={css('font-size:9.5px;color:#6b7699;background:#0d1730;border:1px solid #1c2a4d;border-radius:999px;padding:3px 10px', { v })}>
          {v.windowLine}
        </div>
        <div style={css('font-size:9.5px;color:#4d8dff;font-family:monospace', { v })}>pool {v.windowPool}</div>
      </div>

      {/* The always-on service behind the tab. */}
      <div style={css('display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:9px;color:#6b7699', { v })}>
        <span style={css('width:6px;height:6px;border-radius:50%;background:' + (v.intelLive ? '#4fd6c1' : '#6b7699') + ';display:inline-block;flex:0 0 auto', { v })} />
        <span style={css('letter-spacing:.5px', { v })}>WALLET MEMORY — {v.intelLine}</span>
      </div>

      <div style={css('display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px', { v })}>
        {v.walletStats.map((s, i) => (
          <div key={i} style={css(CARD + ';padding:10px 12px', { v, s })}>
            <div style={css(CAP, { v, s })}>{s.label}</div>
            <div style={css('font-size:18px;font-weight:700;margin-top:3px;color:{{ s.color }}', { v, s })}>{s.value}</div>
            <div style={css('font-size:8.5px;color:#6b7699;margin-top:2px', { v, s })}>{s.note}</div>
          </div>
        ))}
      </div>

      <div style={css('display:grid;grid-template-columns:1.85fr 1fr;gap:10px;align-items:start', { v })}>

        {/* ---------------------------------------------- behaviour table */}
        <div style={css(CARD + ';padding:12px;min-width:0', { v })}>
          <div style={css('display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px', { v })}>
            {v.walletFilters.map((f) => (
              <div
                key={f.key} onClick={f.pick}
                style={css('cursor:pointer;font-size:9px;font-weight:700;letter-spacing:.6px;padding:4px 10px;border-radius:999px;border:1px solid ' +
                  (f.active ? '#4d8dff' : '#1c2a4d') + ';background:' + (f.active ? '#0e2a5c' : '#0d1730') +
                  ';color:' + (f.active ? '#6ea0ff' : '#6b7699'), { v, f })}
              >{f.label}<span style={css('opacity:.65;margin-left:5px', { v, f })}>{f.count}</span></div>
            ))}
          </div>

          <div style={css('display:grid;grid-template-columns:118px 1.25fr 74px 74px 56px 62px 1fr;gap:0 9px;padding:0 0 5px;border-bottom:1px solid #1c2a4d;' + CAP + ';letter-spacing:.8px;color:#6b7699', { v })}>
            <div>WALLET</div><div>NET FLOW IN WINDOW</div><div>BOUGHT</div><div>SOLD</div>
            <div>B/S</div><div>SUPPLY</div><div>ALSO TRADING</div>
          </div>

          {v.walletRows.map((w) => (
            <div key={w.key} className="h7f88fc9a" style={css('display:grid;grid-template-columns:118px 1.25fr 74px 74px 56px 62px 1fr;gap:0 9px;align-items:center;padding:7px 0;border-bottom:1px solid #16223f;font-size:10.5px', { v, w })}>

              <div style={css('min-width:0', { v, w })}>
                <div
                  onClick={w.openExplorer} title={w.address}
                  style={css('font-family:monospace;font-weight:700;color:' + (w.url ? '#ffffff' : '#c6d1ea') + ';cursor:' + (w.url ? 'pointer' : 'default') + ';white-space:nowrap', { v, w })}
                >{w.short}</div>
                <div onClick={w.copy} style={css('font-size:8px;color:#3a4568;cursor:pointer;margin-top:1px', { v, w })}>copy</div>
              </div>

              {/* Zero-centred flow bar: right of the line is net buying. */}
              <div style={css('min-width:0', { v, w })}>
                <div style={css('position:relative;height:9px;background:#0d1730;border-radius:3px;overflow:hidden', { v, w })}>
                  <div style={css('position:absolute;top:0;bottom:0;left:50%;width:1px;background:#2b3a5c', { v, w })} />
                  <div style={css('position:absolute;top:1px;bottom:1px;' + w.barSide + ';width:{{ w.barW }};background:{{ w.barC }};border-radius:2px', { v, w })} />
                </div>
                <div style={css('display:flex;gap:6px;align-items:center;margin-top:3px;flex-wrap:wrap', { v, w })}>
                  <span style={css('font-weight:700;color:{{ w.netC }};font-size:10px', { v, w })}>{w.net}</span>
                  {w.tags.map((t) => <Tag key={t.t} t={t} css={css} />)}
                </div>
              </div>

              <div style={css('color:{{ w.boughtC }}', { v, w })}>{w.bought}</div>
              <div style={css('color:{{ w.soldC }}', { v, w })}>{w.sold}</div>
              <div style={css('color:#8b96b8;font-size:10px', { v, w })}>{w.trades}</div>
              <div style={css('color:{{ w.supplyC }};font-size:10px', { v, w })}>{w.supply}</div>
              <div style={css('min-width:0', { v, w })}>
                <div style={css('color:{{ w.alsoInC }};font-size:9.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, w })}>{w.alsoIn}</div>
                <div style={css('font-size:8px;color:#3a4568', { v, w })}>{w.seen}</div>
                {w.history && <div style={css('font-size:8px;color:#8f7bff', { v, w })}>{w.history}</div>}
              </div>
            </div>
          ))}

          <div style={css('font-size:9px;color:#6b7699;margin-top:9px;line-height:1.6', { v })}>
            Showing {v.walletRowsShown} of {v.walletRowsTotal} matching wallets, biggest absolute flow first. {v.rotationNote}
          </div>
        </div>

        {/* --------------------------------------------------- side panels */}
        <div style={css('display:flex;flex-direction:column;gap:10px;min-width:0', { v })}>

          <div style={css(CARD + ';padding:12px', { v })}>
            <div style={css(CAP + ';margin-bottom:8px', { v })}>TOP HOLDERS OF ${v.walletsToken}</div>
            {v.holderPanel.map((h) => (
              <div key={h.key} style={css('padding:6px 0;border-bottom:1px solid #16223f', { v, h })}>
                <div style={css('display:flex;justify-content:space-between;align-items:center;gap:6px', { v, h })}>
                  <span onClick={h.openExplorer} style={css('font-family:monospace;font-size:10px;color:#c6d1ea;cursor:pointer', { v, h })}>{h.short}</span>
                  <span style={css('font-size:10.5px;font-weight:700;color:{{ h.pctC }}', { v, h })}>{h.pct}</span>
                </div>
                <div style={css('height:5px;background:#0d1730;border-radius:3px;margin:4px 0 3px;overflow:hidden', { v, h })}>
                  <div style={css('height:100%;width:{{ h.barW }};background:{{ h.barC }}', { v, h })} />
                </div>
                <div style={css('display:flex;justify-content:space-between;gap:6px', { v, h })}>
                  <span style={css('font-size:8.5px;color:{{ h.roleC }};letter-spacing:.5px', { v, h })}>{h.role}</span>
                  <span style={css('font-size:8.5px;color:{{ h.activeC }}', { v, h })}>{h.activeTxt}</span>
                </div>
              </div>
            ))}
            <div style={css('font-size:9px;color:#6b7699;margin-top:8px;line-height:1.6', { v })}>{v.holdersNote}</div>
          </div>

          <div style={css(CARD + ';padding:12px', { v })}>
            <div style={css(CAP + ';margin-bottom:8px', { v })}>CO-ORDINATED ENTRY</div>
            {v.clusterPanel.map((c) => (
              <div key={c.key} style={css('padding:7px 9px;border:1px solid {{ c.bd }};background:{{ c.bg }};border-radius:8px;margin-bottom:6px', { v, c })}>
                <div style={css('display:flex;justify-content:space-between;gap:6px;align-items:center', { v, c })}>
                  <span style={css('font-size:10.5px;font-weight:700;color:{{ c.fg }}', { v, c })}>{c.title}</span>
                  <span style={css('font-size:9px;color:#8b96b8', { v, c })}>{c.when}</span>
                </div>
                <div style={css('font-size:8px;font-weight:800;letter-spacing:.5px;color:{{ c.fg }};opacity:.8;margin-top:2px', { v, c })}>{c.label}</div>
                <div style={css('font-size:9px;color:#8b96b8;margin-top:3px', { v, c })}>{c.detail}</div>
                {c.exit && <div style={css('font-size:9px;color:{{ c.fg }};margin-top:1px', { v, c })}>{c.exit}</div>}
                <div style={css('font-size:9px;color:#6b7699;margin-top:1px', { v, c })}>{c.gross} traded by the group</div>
              </div>
            ))}
            <div style={css('font-size:9px;color:#6b7699;line-height:1.6', { v })}>{v.clustersNote}</div>

            {/* Found on other tokens by the background service, whether or not
                this tab was open at the time. */}
            {v.elsewhereClusters.length > 0 && <>
              <div style={css('font-size:8.5px;letter-spacing:.8px;color:#6b7699;font-weight:600;margin:10px 0 5px;padding-top:8px;border-top:1px solid #16223f', { v })}>SEEN ON OTHER TOKENS</div>
              {v.elsewhereClusters.map((e) => (
                <div key={e.key} style={css('display:flex;justify-content:space-between;gap:6px;padding:3px 0;font-size:9px', { v, e })}>
                  <span style={css('font-weight:700;color:{{ e.fg }}', { v, e })}>{e.sym}</span>
                  <span style={css('color:#8b96b8;flex:1;text-align:left;padding-left:6px', { v, e })}>{e.text}</span>
                  <span style={css('color:#6b7699', { v, e })}>{e.when}</span>
                </div>
              ))}
            </>}
          </div>

          <div style={css(CARD + ';padding:12px', { v })}>
            <div style={css(CAP + ';margin-bottom:8px', { v })}>YOUR TRACKED WALLETS</div>
            <div style={css('display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px', { v })}>
              <input
                value={v.walletInput} onChange={v.onWalletInput}
                placeholder="Wallet address"
                style={css('flex:2;min-width:130px;background:#0d1730;border:1px solid #1c2a4d;border-radius:999px;padding:6px 12px;color:#ffffff;font-size:10px;font-family:monospace;outline:none', { v })}
              />
              <input
                value={v.walletLabel} onChange={v.onWalletLabel}
                placeholder="Label"
                style={css('flex:1;min-width:70px;background:#0d1730;border:1px solid #1c2a4d;border-radius:999px;padding:6px 12px;color:#ffffff;font-size:10px;font-family:inherit;outline:none', { v })}
              />
              <div onClick={v.addWallet} style={css('padding:6px 14px;border-radius:999px;background:linear-gradient(135deg,#2b6bff,#e35ff2);color:#ffffff;font-size:10px;font-weight:700;cursor:pointer', { v })}>TRACK</div>
            </div>
            {v.trackedList.map((t) => (
              <div key={t.address} style={css('display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #16223f', { v, t })}>
                <div style={css('min-width:0', { v, t })}>
                  <div style={css('font-family:monospace;font-size:10px;color:' + (t.here ? '#4fe08f' : '#8b96b8'), { v, t })}>{t.short}</div>
                  <div style={css('font-size:8.5px;color:#6b7699;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, t })}>{t.label}</div>
                </div>
                <div style={css('text-align:right', { v, t })}>
                  <div style={css('font-size:9px;color:{{ t.detailC }}', { v, t })}>{t.detail}</div>
                </div>
                <div className="h7f88fc9a" onClick={t.remove} style={css('cursor:pointer;color:#6b7699;font-size:11px', { v, t })}>&#10005;</div>
              </div>
            ))}
            <div style={css('font-size:9px;color:#6b7699;margin-top:8px;line-height:1.6', { v })}>
              {v.trackedCount
                ? 'Tracked wallets are matched against every token you open, and light up green when they appear in its trade window.'
                : 'Paste a full wallet address to follow it. It is matched against the trades of every token you open, and saved in this browser.'}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
