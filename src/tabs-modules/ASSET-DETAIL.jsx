import React from 'react';
import { fmtUsd, fmtPrice, stageInfo, clsColor, scoreColor, washColor, UNAVAILABLE, isMissing, fmtOr, fmtPct, fmtNum } from '../utils/formatters';

const EMPTY_DETAIL = {
  sym: '—', name: '—', stage: '—', stageBg: '#1a2440', stageFg: '#a3aed0', cls: '—', clsColor: '#a3aed0', canonical: false,
  score: 0, scoreColor: '#a3aed0', conf: '0.00', raw: 0, penalty: 0,
  price: '$0.00', chg: '0.0%', chgColor: '#a3aed0',
  spark: [], market: [], outcomes: [], subs: [], isStock: false, oracle: [],
  reasons: [], flags: [], gauge: null, hysteresis: '',
  chartNote: '', scoreSource: '', safety: [], safetyNote: '', intelState: 'idle'
};

/** Bar colour for a live component score; grey when the input is pending. */
const barColor = (v) => isMissing(v) ? UNAVAILABLE : v >= 75 ? '#4d8dff' : v >= 50 ? '#e35ff2' : v > 0 ? '#ff4fae' : '#223052';

/** z-score metric backing each score component, for the trigger-reason table. */
const Z_METRIC_FOR = { volumeAnomaly: 'volume5mUsd', tradeActivity: 'buys5m', buyerBreadth: 'buyers5m' };

/**
 * Stage gauge.
 *
 * The stage is nothing but the score bucketed at 55 / 70 / 85, so the
 * gauge shows that relationship directly instead of the old three-timestamp
 * timeline.
 *
 * Segments are drawn equal-width, not proportional to their band: WATCH covers
 * 55 of the 100 points and the other three 15 each, which at true scale leaves
 * no room to write EXCEPTIONAL. The marker is placed piecewise instead - one
 * quarter of the bar per band, linear inside it - and the band edges are
 * printed above the joins so the scale is still readable.
 *
 * The lit segment is the current stage; the marker sits at the score. When
 * the hysteresis is holding a demotion the two disagree, and the gap between
 * them is exactly that hold.
 */
const GAUGE_BANDS = [
  { n: 'WATCH', min: 0, max: 55 },
  { n: 'EMERGING', min: 55, max: 70 },
  { n: 'CONFIRMED', min: 70, max: 85 },
  { n: 'EXCEPTIONAL', min: 85, max: 100 }
];

function buildGauge(score, stageIdx) {
  const live = Number.isFinite(score);
  const segs = GAUGE_BANDS.map((b, i) => {
    const info = stageInfo(i + 1);
    const on = stageIdx === i + 1;
    return {
      n: b.n,
      // Opaque fills only. A translucent tint over this near-black card reads
      // darker than its inactive neighbours, the opposite of lit.
      bg: on ? info.bg : '#0c142c',
      fg: on ? info.fg : '#3f4a68',
      bd: on ? info.fg : 'transparent',
      sep: i > 0 ? '#1c2a4d' : 'transparent',
      edge: i < 3 ? String(b.max) : '',
      at: ((i + 1) * 25) + '%'
    };
  });
  const scoreIdx = live
    ? Math.max(0, GAUGE_BANDS.findIndex((b, i) => score >= b.min && (i === 3 || score < b.max)))
    : 0;
  const band = GAUGE_BANDS[scoreIdx];
  const within = Math.min(1, Math.max(0, (score - band.min) / (band.max - band.min)));
  return {
    segs, live,
    // Held off the very ends so the triangle never hangs past the rounded edge.
    left: Math.min(98.2, Math.max(1.8, (scoreIdx + within) * 25)).toFixed(2) + '%',
    fg: stageInfo(scoreIdx + 1).fg,
    value: live ? String(Math.round(score)) : '—'
  };
}

/**
 * Builds the Asset Detail view model.
 *
 * Every field traces to raw provider data from /api/market, /api/intel or
 * /api/ohlcv, run through src/calculations in this browser. Anything that
 * could not be computed is rendered grey as '—' — this view never fabricates
 * a number to fill a gap.
 */
export function detailVals(app, a, showAdj, extra) {
    if (!a) return EMPTY_DETAIL;
    const { intel = null, bars = null, intelState = 'idle', barsState = 'idle', staleMs = 0 } = extra || {};
    const row = a.rawServerRow || {};
    const si = stageInfo(a.stage);

    // /api/intel rescores with holder, safety and routed-impact inputs the feed
    // lacks, so prefer it when loaded; otherwise fall back to the feed's own.
    const scored = (intel && intel.scored) || row;
    const usingIntel = Boolean(intel && intel.scored);
    const scoreSource = usingIntel
      ? `intel · ${scored.componentsPresent ?? '?'} of ${(scored.scoreModel || []).length} inputs`
      : `feed · ${row.componentsPresent ?? '?'} of ${(row.scoreModel || []).length} inputs`;

    const modifiers = scored.scoreModifiers || [];
    const subs = [
      ...(scored.scoreModel || []).map((c) => ({
        k: c.label, w: c.weight + '%', v: c.pending ? null : c.value, evidence: c.evidence || ''
      })),
      ...modifiers.map((m) => ({ k: m.label, w: '—', v: m.pending ? null : m.value, evidence: m.evidence || '' }))
    ].map((s) => ({
      ...s,
      pending: isMissing(s.v),
      pct: isMissing(s.v) ? '0%' : s.v + '%',
      label: isMissing(s.v) ? '—' : String(s.v),
      c: barColor(s.v),
      labelColor: isMissing(s.v) ? UNAVAILABLE : '#dfe6f6',
      keyColor: isMissing(s.v) ? UNAVAILABLE : '#a3aed0'
    }));

    // Real minute bars from /api/ohlcv; no bars means an empty chart, not a fake one.
    const closes = Array.isArray(bars) ? bars.map((b) => b.c).filter(Number.isFinite) : [];
    const spMax = Math.max(...closes), spMin = Math.min(...closes);
    const spark = closes.length > 1 ? closes.map((v, i) => ({
      h: Math.round(8 + (v - spMin) / (spMax - spMin || 1) * 92) + '%',
      c: i === closes.length - 1 ? '#e35ff2' : v >= (closes[i - 1] ?? v) ? '#2f66d0' : '#8a2f7c'
    })) : [];
    const CHART_NOTES = {
      loading: 'Loading price history…',
      rate_limited: 'GeckoTerminal rate limit hit — retrying shortly, nothing drawn',
      empty: 'GeckoTerminal has no bars for this pool yet',
      unreachable: 'Chart service unreachable — nothing drawn',
      upstream_error: 'Price history unavailable upstream — nothing drawn',
    };
    const chartNote = closes.length > 1
      ? (barsState === 'local_history' ? 'GeckoTerminal unavailable — drawn from our own 15s price samples' : '')
      : (CHART_NOTES[barsState] || 'No price history for this pool');

    const holders = intel && intel.holders ? intel.holders : null;
    const impactPct = intel && intel.impact ? intel.impact.priceImpactPct : null;
    const impactSource = intel && intel.impact ? intel.impact.source : null;
    const netUsd5m = row.flow && row.flow.netUsd != null ? row.flow.netUsd : null;
    const washRisk = row.flow && row.flow.washRisk != null ? row.flow.washRisk / 100 : null;
    const jup = (intel && intel.jupiter) || row.jupiter || null;
    const supply = (intel && intel.supply) || (row.circulatingSupply != null
      ? { circulating: row.circulatingSupply, total: row.totalSupply } : null);
    const organicScore = jup ? jup.organicScore : (row.flow ? row.flow.organicFlow : null);
    const organicShare = row.flow && row.flow.organicSharePct != null ? row.flow.organicSharePct
      : (intel && intel.flow ? intel.flow.organicSharePct24h : null);
    const holderChange1h = holders && holders.changePct1h != null ? holders.changePct1h
      : (jup && jup.stats1h ? jup.stats1h.holderChangePct : null);
    const crossPrice = intel && intel.priceCrossCheck ? intel.priceCrossCheck : null;
    const honeypot = intel && intel.honeypot ? intel.honeypot : null;

    const tile = (k, value, text, color) => ({
      k, v: isMissing(value) ? '—' : text,
      c: isMissing(value) ? UNAVAILABLE : (color || '#dfe6f6')
    });
    const market = [
      tile('MKT CAP', row.marketCapUsd, fmtOr(row.marketCapUsd, fmtUsd)),
      tile('LIQUIDITY', row.liquidityUsd, fmtOr(row.liquidityUsd, fmtUsd)),
      tile('VOL 5M', row.volume5mUsd, fmtOr(row.volume5mUsd, fmtUsd)),
      tile('VOL 24H', row.volume24hUsd, fmtOr(row.volume24hUsd, fmtUsd)),
      tile('BUYERS 5M', row.traders5m && row.traders5m.buyers, fmtNum(row.traders5m && row.traders5m.buyers)),
      tile('BUYERS 24H', row.traders24h && row.traders24h.buyers, fmtNum(row.traders24h && row.traders24h.buyers)),
      tile('B/S RATIO 24H', row.buySellRatio24h, fmtOr(row.buySellRatio24h, (x) => x.toFixed(2)),
        row.buySellRatio24h >= 1 ? '#4d8dff' : '#ff4fae'),
      tile('VOL/LIQ 24H', row.volumeToLiquidity24h, fmtOr(row.volumeToLiquidity24h, (x) => x.toFixed(2) + '×')),
      tile(impactSource ? 'IMPACT $10K · ' + String(impactSource).toUpperCase() : 'IMPACT $10K',
        impactPct, fmtPct(impactPct, 2), impactPct > 5 ? '#ff4fae' : '#dfe6f6'),
      tile('HOLDERS', holders && holders.count, fmtNum(holders && holders.count)),
      tile('TOP-10 SHARE', holders && holders.topHolderSharePct, fmtPct(holders && holders.topHolderSharePct),
        holders && holders.topHolderSharePct >= 30 ? '#ff4fae' : '#dfe6f6'),
      tile('NET BUY 5M', netUsd5m, fmtOr(netUsd5m, fmtUsd), netUsd5m >= 0 ? '#4d8dff' : '#ff4fae'),
      tile('WASH PROB', washRisk, fmtOr(washRisk, (x) => Math.round(x * 100) + '%'), washColor(washRisk)),
      tile('POOL AGE', row.poolAgeHours, fmtOr(row.poolAgeHours, (x) => x < 48 ? x.toFixed(1) + 'h' : (x / 24).toFixed(1) + 'd')),
      // Jupiter-backed tiles (Solana); grey on chains Jupiter does not index.
      tile('ORGANIC SCORE', organicScore, fmtOr(organicScore, (x) => Math.round(x) + '/100'),
        organicScore >= 60 ? '#4d8dff' : organicScore >= 30 ? '#e35ff2' : '#ff4fae'),
      tile('ORGANIC VOL 24H', organicShare, fmtPct(organicShare, 0)),
      tile('HOLDERS Δ 1H', holderChange1h, fmtOr(holderChange1h, (x) => (x > 0 ? '+' : '') + x.toFixed(2) + '%'),
        holderChange1h >= 0 ? '#4d8dff' : '#ff4fae'),
      tile('CIRC SUPPLY', supply && supply.circulating,
        fmtOr(supply && supply.circulating, (x) => x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : fmtNum(Math.round(x)))),
      tile('DEV MIGRATIONS', jup && jup.audit && jup.audit.devMigrations,
        fmtNum(jup && jup.audit && jup.audit.devMigrations),
        jup && jup.audit && jup.audit.devMigrations > 0 ? '#ff4fae' : '#4d8dff'),
      tile('LAUNCHPAD', (jup && jup.launchpad) || row.launchpad, (jup && jup.launchpad) || row.launchpad),
      tile('PRICE vs LLAMA', crossPrice && crossPrice.deltaPct,
        fmtOr(crossPrice && crossPrice.deltaPct, (x) => (x > 0 ? '+' : '') + x.toFixed(2) + '%'),
        crossPrice && Math.abs(crossPrice.deltaPct) > 3 ? '#ff4fae' : '#dfe6f6'),
      tile('SELL SIMULATION', honeypot && honeypot.isHoneypot !== null ? honeypot.isHoneypot : null,
        honeypot && honeypot.isHoneypot === false ? 'PASSES' : 'HONEYPOT',
        honeypot && honeypot.isHoneypot === false ? '#4d8dff' : '#ff4fae')
    ];

    // Forward returns are not wired into this panel yet, so every horizon
    // stays pending. The Evaluation tab measures them from the score journal.
    const outcomes = ['15M', '1H', '4H', '12H', '24H'].map((k) => ({ k, v: '—', c: UNAVAILABLE }));

    const sev = { HIGH: { bg: '#45103a', fg: '#ff4fae' }, MED: { bg: '#33124a', fg: '#e35ff2' }, LOW: { bg: '#1a2440', fg: '#a3aed0' } };
    const zMetrics = (intel && intel.zScores && intel.zScores.metrics) || {};
    const reasons = (scored.scoreModel || [])
      .filter((c) => !c.pending && c.evidence)
      .map((c) => {
        const z = zMetrics[Z_METRIC_FOR[c.key]] || null;
        return {
          code: (c.key || 'signal').replace(/([A-Z])/g, '_$1').toUpperCase(),
          win: z ? '5M' : '24H', text: c.evidence,
          z: z && Number.isFinite(z.z) ? z.z.toFixed(2) : '—',
          ratio: z && Number.isFinite(z.multiple) ? z.multiple.toFixed(2) : '—',
          zColor: z ? '#ffffff' : UNAVAILABLE
        };
      });

    const flags = (row.riskFlags || []).map((f) => ({
      sev: f.severity || 'LOW', bg: sev[f.severity || 'LOW'].bg, fg: sev[f.severity || 'LOW'].fg,
      text: f.detail || f.code
    }));

    const safetyChecks = intel && intel.contractSafety && intel.contractSafety.available
      ? (intel.contractSafety.checks || []) : [];
    const safety = safetyChecks.map((c) => ({
      label: c.label, ok: c.ok, detail: c.detail || '',
      glyph: c.ok ? '✓' : '✕', c: c.ok ? '#4d8dff' : '#ff4fae'
    }));
    const safetyNote = safety.length ? ''
      : intelState === 'loading' ? 'Loading contract checks…'
      : intelState === 'error' ? 'Contract checks unavailable from GoPlus / RugCheck'
      : 'No contract data for this chain';

    const oracle = a.oracle ? [
      { k: 'Feed', v: a.oracle.feed, c: '#dfe6f6' },
      { k: 'Exec↔source dev', v: a.oracle.dev, c: '#4d8dff' },
      { k: 'Sources agreeing', v: row.crossSource ? String(row.crossSource.sourcesAgreeing) : '—', c: row.crossSource ? '#4d8dff' : UNAVAILABLE },
      { k: 'Freshness', v: '—', c: UNAVAILABLE },
      { k: 'Sequencer', v: '—', c: UNAVAILABLE },
      { k: 'UI multiplier', v: '—', c: UNAVAILABLE },
      { k: 'Pending mult', v: '—', c: UNAVAILABLE },
      { k: 'Ref session', v: '—', c: UNAVAILABLE },
      { k: 'Corp action', v: '—', c: UNAVAILABLE }
    ] : [];

    const finalScore = Number.isFinite(scored.score) ? scored.score
      : (a.score == null ? null : Math.round(a.score));
    return {
      sym: a.sym, name: a.name, stage: si.n, stageBg: si.bg, stageFg: si.fg, cls: a.cls, clsColor: clsColor(a.cls), canonical: a.canonical,
      score: finalScore == null ? '—' : finalScore,
      scoreColor: finalScore == null ? UNAVAILABLE : scoreColor(finalScore),
      conf: isMissing(row.dataQuality) ? '—' : row.dataQuality.toFixed(2),
      raw: Number.isFinite(scored.rawScore) ? scored.rawScore : '—',
      penalty: Number.isFinite(scored.riskPenalty) ? scored.riskPenalty : '—',
      scoreSource, intelState,
      price: fmtOr(row.priceUsd, fmtPrice),
      chg: isMissing(a.chg) ? '—' : (a.chg >= 0 ? '+' : '') + (a.chg * 100).toFixed(1) + '%',
      chgColor: isMissing(a.chg) ? UNAVAILABLE : a.chg >= 0 ? '#4d8dff' : '#ff4fae',
      sourceLine: intel && intel.sources
        ? 'providers: ' + Object.entries(intel.sources)
          .map(([k, v]) => k + (v === 'ok' ? ' ✓' : ' —')).join('  ')
        : '',
      staleNote: staleMs > 10000
        ? 'Not in the current feed — values frozen from ' + Math.round(staleMs / 1000) + 's ago'
        : '',
      spark, chartNote, market, outcomes, subs, safety, safetyNote,
      isStock: !!a.oracle, oracle, ...bubbleVals(app, a),
      reasons, flags,
      gauge: buildGauge(finalScore, a.stage),
      // Server bands: WATCH 0 / EMERGING 55 / CONFIRMED 70 / EXCEPTIONAL 85.
      // Promotion is immediate; only demotion is buffered by the hysteresis.
      hysteresis: Number.isFinite(row.stageHysteresis)
        ? 'Bands 55 / 70 / 85. Promotes as soon as the score clears a band; holds ' + si.n +
          ' until the score drops ' + row.stageHysteresis + ' pts below it, so the stage never flips on 1–2 pt noise.'
        : 'Stage hysteresis unavailable.'
    };
  }

export function bubbleVals(app, a) {
    if (!a.bundle) return { hasBubbles: false, bubbles: [], bundleStats: [], bubbleLinks: [] };
    const r = app.srand(app.h(a.id + 'bub'));
    const bubbles = []; const cx = 50, cy = 50;
    // cluster of bundled wallets around funder + independent holders
    bubbles.push({ x: '30%', y: '42%', s: '26px', c: '#ff4fae', op: '1', label: 'FUNDER' });
    for (let i = 0; i < a.bundle.sameBlock; i++) {
      const ang = r() * 6.28, d = 12 + r() * 14;
      bubbles.push({ x: (30 + Math.cos(ang) * d) + '%', y: (42 + Math.sin(ang) * d * 0.8) + '%', s: (8 + r() * 8) + 'px', c: '#ff4fae', op: '0.75', label: '' });
    }
    for (let i = 0; i < 16; i++) { bubbles.push({ x: (58 + r() * 36) + '%', y: (12 + r() * 76) + '%', s: (6 + r() * 13) + 'px', c: '#4d8dff', op: '0.65', label: '' }); }
    bubbles.push({ x: '72%', y: '30%', s: '22px', c: '#8fd3ff', op: '0.9', label: 'POOL' });
    const b = a.bundle;
    return {
      hasBubbles: true, bubbles,
      bundleStats: [
        { k: 'Bundle probability', v: b.prob.toFixed(2), c: b.prob >= 0.5 ? '#ff4fae' : '#e35ff2' },
        { k: 'Same-block launch buyers', v: b.sameBlock + ' of ' + b.launchBuyers, c: '#ff4fae' },
        { k: 'Common funding source', v: b.funder, c: '#ffffff' },
        { k: 'Cluster supply share', v: b.supplyPct + '%', c: b.supplyPct >= 30 ? '#ff4fae' : '#e35ff2' },
        { k: 'Liquidity wash cycles', v: b.liqCycles + '× (' + fmtUsd(b.liqCycleUsd) + ' each)', c: '#ff4fae' }]
    };
  }

export default function AssetDetail({ v, css }) {
  return v.isDetail && <>
          <div data-screen-label="Asset detail" style={css("flex:1;overflow:auto;padding:12px 14px;min-height:0", { v })}><div style={css("display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:10px 16px 6px;margin-bottom:12px", { v })}><div style={css("flex:1 1 340px;min-width:288px;max-width:640px", { v })}><div style={css("position:relative;height:12px", { v })}>{((v.d.gauge && v.d.gauge.segs) || []).map((sg, i) => sg.edge ? (<React.Fragment key={i}>
            <div style={css("position:absolute;bottom:0;left:{{ sg.at }};transform:translateX(-50%);font-size:8.5px;color:#39436a", { v, sg })}>{sg.edge}</div>
          </React.Fragment>) : null)}</div><div style={css("display:flex;border:1px solid #1c2a4d;border-radius:7px;overflow:hidden", { v })}>{((v.d.gauge && v.d.gauge.segs) || []).map((sg, i) => (<React.Fragment key={i}>
            <div style={css("flex:1 1 0;min-width:0;text-align:center;padding:6px 2px 4px;font-size:8.5px;font-weight:800;letter-spacing:.2px;background:{{ sg.bg }};color:{{ sg.fg }};border-left:1px solid {{ sg.sep }};border-bottom:2px solid {{ sg.bd }}", { v, sg })}>{sg.n}</div>
          </React.Fragment>))}</div><div style={css("position:relative;height:20px", { v })}>{v.d.gauge && v.d.gauge.live ? (<>
            <div style={css("position:absolute;top:-4px;left:{{ d.gauge.left }};transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;transition:left 420ms cubic-bezier(.4,0,.2,1)", { v, d: v.d })}><div style={css("width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:6px solid {{ d.gauge.fg }}", { v, d: v.d })}></div><div style={css("font-size:10px;font-weight:700;line-height:1.3;color:{{ d.gauge.fg }}", { v, d: v.d })}>{v.d.gauge.value}</div></div>
          </>) : (<div style={css("padding-top:4px;font-size:9px;color:#3a4568", { v })}>score unavailable</div>)}</div></div><div style={css("flex:1 1 240px;font-size:10px;color:#8b96b8;line-height:1.5;max-width:420px", { v })}>{v.d.hysteresis}</div></div><div style={css("display:grid;grid-template-columns:1.5fr 1fr;gap:10px", { v })}><div style={css("display:flex;flex-direction:column;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("display:flex;justify-content:space-between;margin-bottom:8px", { v })}><span style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600", { v })}>EXECUTION PRICE — 1M BARS</span><span style={css("font-size:10px;color:#8b96b8", { v })}>{v.d.price} <span style={css("color:{{ d.chgColor }}", { v, d: v.d })}>{v.d.chg} 5M</span></span></div><div style={css("display:flex;align-items:flex-end;gap:2px;height:110px", { v })}>{(v.d.spark || []).map((b, i) => (<React.Fragment key={i}>
            <div style={css("flex:1;background:{{ b.c }};height:{{ b.h }};border-radius:1px 1px 0 0", { v, b })}></div>
          </React.Fragment>))}{v.d.chartNote && (<div style={css("flex:1;display:flex;align-items:center;justify-content:center;font-size:10px;color:#3a4568", { v })}>{v.d.chartNote}</div>)}</div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>MARKET</div><div style={css("display:grid;grid-template-columns:repeat(4,1fr);gap:10px", { v })}>{(v.d.market || []).map((m, i) => (<React.Fragment key={i}>
            <div><div style={css("font-size:9px;color:#6b7699;letter-spacing:.6px", { v, m })}>{m.k}</div><div style={css("font-size:13px;font-weight:600;margin-top:2px;color:{{ m.c }}", { v, m })}>{m.v}</div></div>
          </React.Fragment>))}</div>{v.d.sourceLine && (<div style={css("font-size:8.5px;color:#3a4568;margin-top:9px;padding-top:7px;border-top:1px solid #16223f", { v })}>{v.d.sourceLine}</div>)}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>TRIGGER REASONS</div>{(v.d.reasons || []).map((rr, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;gap:12px;align-items:baseline;padding:5px 0;border-bottom:1px solid #16223f", { v, rr })}><span style={css("width:190px;font-size:10px;font-weight:700;color:#e35ff2;flex-shrink:0", { v, rr })}>{rr.code}</span><span style={css("width:46px;color:#8b96b8;font-size:10px", { v, rr })}>{rr.win}</span><span style={css("flex:1;font-size:11px;color:#c6d1ea", { v, rr })}>{rr.text}</span><span style={css("font-size:10px;color:#8b96b8", { v, rr })}>z <span style={css("color:{{ rr.zColor }};font-weight:600", { v, rr })}>{rr.z}</span></span><span style={css("font-size:10px;color:#8b96b8", { v, rr })}>×<span style={css("color:{{ rr.zColor }};font-weight:600", { v, rr })}>{rr.ratio}</span></span></div>
          </React.Fragment>))}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>OUTCOME TRACKING</div><div style={css("display:grid;grid-template-columns:repeat(5,1fr);gap:10px", { v })}>{(v.d.outcomes || []).map((o, i) => (<React.Fragment key={i}>
            <div style={css("background:#101c38;border:1px solid #1c2a4d;border-radius:10px;padding:8px 10px;text-align:center", { v, o })}><div style={css("font-size:9px;color:#6b7699;letter-spacing:1px", { v, o })}>{o.k}</div><div style={css("font-size:14px;font-weight:700;margin-top:3px;color:{{ o.c }}", { v, o })}>{o.v}</div></div>
          </React.Fragment>))}</div></div></div><div style={css("display:flex;flex-direction:column;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>SCORE DECOMPOSITION</div>{(v.d.subs || []).map((s, i) => (<React.Fragment key={i}>
            <div title={s.evidence} style={css("display:flex;align-items:center;gap:8px;padding:2.5px 0", { v, s })}><span style={css("width:150px;font-size:10px;color:{{ s.keyColor }};flex-shrink:0", { v, s })}>{s.k}</span><span style={css("width:30px;font-size:9px;color:#6b7699", { v, s })}>{s.w}</span><div style={css("flex:1;height:7px;background:#16223f;border-radius:1px;overflow:hidden", { v, s })}><div style={css("height:100%;width:{{ s.pct }};background:{{ s.c }}", { v, s })}></div></div><span style={css("width:26px;text-align:right;font-size:10px;font-weight:600;color:{{ s.labelColor }}", { v, s })}>{s.label}</span></div>
          </React.Fragment>))}<div style={css("display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid #1c2a4d;font-size:10px", { v })}><span style={css("color:#8b96b8", { v })}>RAW <span style={css("color:#ffffff;font-weight:700", { v })}>{v.d.raw}</span></span><span style={css("color:#8b96b8", { v })}>RISK PENALTY <span style={css("color:#ff4fae;font-weight:700", { v })}>−{v.d.penalty}</span></span><span style={css("color:#8b96b8", { v })}>FINAL <span style={css("color:{{ d.scoreColor }};font-weight:700", { v, d: v.d })}>{v.d.score}</span></span></div><div style={css("font-size:9px;color:#6b7699;margin-top:6px", { v })}>source: {v.d.scoreSource} · grey rows are inputs that could not be computed yet</div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>RISK FLAGS</div>{(v.d.flags || []).map((f, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;gap:8px;align-items:baseline;padding:4px 0", { v, f })}><span style={css("font-size:9px;font-weight:700;padding:2px 6px;border-radius:10px;background:{{ f.bg }};color:{{ f.fg }};flex-shrink:0", { v, f })}>{f.sev}</span><span style={css("font-size:11px;color:#c6d1ea", { v, f })}>{f.text}</span></div>
          </React.Fragment>))}{!(v.d.flags || []).length && (<div style={css("font-size:10px;color:#3a4568;padding:4px 0", { v })}>No risk flags raised</div>)}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>CONTRACT SAFETY · GoPlus + RugCheck</div>{(v.d.safety || []).map((sc, i) => (<React.Fragment key={i}>
            <div title={sc.detail} style={css("display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid #16223f", { v, sc })}><span style={css("font-size:11px;font-weight:700;color:{{ sc.c }};flex-shrink:0;width:12px", { v, sc })}>{sc.glyph}</span><span style={css("flex:1;font-size:10.5px;color:#c6d1ea", { v, sc })}>{sc.label}</span><span style={css("font-size:9.5px;color:#6b7699", { v, sc })}>{sc.detail}</span></div>
          </React.Fragment>))}{v.d.safetyNote && (<div style={css("font-size:10px;color:#3a4568;padding:4px 0", { v })}>{v.d.safetyNote}</div>)}</div>{v.d.hasBubbles && (<>
            <div style={css("background:#0a1226;border:1px solid #45103a;border-radius:10px;padding:12px", { v })}><div style={css("display:flex;justify-content:space-between;align-items:center;margin-bottom:8px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#ff4fae;font-weight:700", { v })}>BUNDLE MAP — WALLET CLUSTERS · via Bubblemaps</div><a href="https://bubblemaps.io" target="_blank" style={css("font-size:9px;color:#6b7699", { v })}>open in Bubblemaps ↗</a></div><div style={css("position:relative;height:190px;background:#0d1730;border:1px solid #16223f;border-radius:10px;overflow:hidden", { v })}>{(v.d.bubbles || []).map((b, i) => (<React.Fragment key={i}>
              <div style={css("position:absolute;left:{{ b.x }};top:{{ b.y }};width:{{ b.s }};height:{{ b.s }};border-radius:50%;background:{{ b.c }};opacity:{{ b.op }};transform:translate(-50%,-50%)", { v, b })}></div>
            </React.Fragment>))}<div style={css("position:absolute;left:30%;top:16%;transform:translateX(-50%);font-size:8px;font-weight:800;letter-spacing:.6px;color:#ff4fae", { v })}>BUNDLED CLUSTER</div><div style={css("position:absolute;left:76%;top:78%;transform:translateX(-50%);font-size:8px;font-weight:800;letter-spacing:.6px;color:#4d8dff", { v })}>INDEPENDENT HOLDERS</div></div><div style={css("margin-top:9px", { v })}>{(v.d.bundleStats || []).map((bs, i) => (<React.Fragment key={i}>
              <div style={css("display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid #16223f;font-size:10.5px", { v, bs })}><span style={css("color:#8b96b8", { v, bs })}>{bs.k}</span><span style={css("font-weight:700;color:{{ bs.c }};flex-shrink:0", { v, bs })}>{bs.v}</span></div>
            </React.Fragment>))}</div><div style={css("font-size:9.5px;color:#6b7699;margin-top:8px;line-height:1.55", { v })}>Red bubbles share a funding source and bought within the launch block window. Cluster supply share and liquidity in/out cycling both feed the wash-probability penalty above.</div></div>
          </>)}{v.d.isStock && (<>
            <div style={css("background:#0a1226;border:1px solid #16406e;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#4fc3f7;font-weight:600;margin-bottom:8px", { v })}>STOCK TOKEN / ORACLE</div><div style={css("display:grid;grid-template-columns:1fr 1fr;gap:8px 14px", { v })}>{(v.d.oracle || []).map((o, i) => (<React.Fragment key={i}>
              <div style={css("display:flex;justify-content:space-between;font-size:10.5px;border-bottom:1px solid #16223f;padding:3px 0", { v, o })}><span style={css("color:#6b7699", { v, o })}>{o.k}</span><span style={css("font-weight:600;color:{{ o.c }}", { v, o })}>{o.v}</span></div>
            </React.Fragment>))}</div></div>
          </>)}</div></div></div>
        </>
}
