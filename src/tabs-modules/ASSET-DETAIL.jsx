import React from 'react';
import { ethosFor, ethosColor, ethosNote } from '../services/ethos-intel';
import { fmtUsd, fmtPrice, stageInfo, clsColor, scoreColor, washColor, UNAVAILABLE, isMissing, fmtOr, fmtPct, fmtNum } from '../utils/formatters';
import { scoreSeriesFor } from '../calculations/asset-detail';
// Split out: the charting library is only needed once a token is opened.
import ScoreHistoryChart from '../components/ScoreHistoryChart';

/**
 * Sparkline geometry for the score window.
 *
 * One series, no axes, no legend - the numbers printed beside it are the
 * readout, and this only has to show the SHAPE: whether "55-70 seen" was a
 * drift, a spike or a step. The y-range is the window's own min/max, so the
 * line uses the full height; that exaggerates small moves on purpose, which is
 * what a sparkline is for. The average is a hairline across it, and the last
 * reading gets a dot so "right now" is locatable.
 */
const SPARK_W = 132;
const SPARK_H = 34;
const SPARK_PAD = 4;

function scoreSpark(series, average) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const values = series.map((pt) => pt.v).filter(Number.isFinite);
  if (values.length < 2) return null;

  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // A flat window would divide by zero and also deserves a centred line.
  const span = (hi - lo) || 1;
  const innerW = SPARK_W - SPARK_PAD * 2;
  const innerH = SPARK_H - SPARK_PAD * 2;
  const xAt = (i) => SPARK_PAD + (i / (values.length - 1)) * innerW;
  const yAt = (v) => SPARK_PAD + (1 - (v - lo) / span) * innerH;

  const last = values[values.length - 1];
  return {
    w: SPARK_W, h: SPARK_H,
    points: values.map((v, i) => xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1)).join(' '),
    avgY: Number.isFinite(average) ? yAt(Math.min(hi, Math.max(lo, average))).toFixed(1) : null,
    lastX: xAt(values.length - 1).toFixed(1),
    lastY: yAt(last).toFixed(1),
    lastColor: scoreColor(last),
    title: values.length + ' readings · low ' + lo + ' · high ' + hi + ' · average ' +
      (Number.isFinite(average) ? average : '—'),
  };
}

const EMPTY_DETAIL = {
  sym: '—', name: '—', stage: '—', stageBg: '#1a2440', stageFg: '#a3aed0', cls: '—', clsColor: '#a3aed0', canonical: false,
  score: 0, scoreColor: '#a3aed0', conf: '0.00', raw: 0, penalty: 0,
  price: '$0.00', chg: '0.0%', chgColor: '#a3aed0',
  spark: [], market: [], outcomes: [], subs: [], isStock: false, oracle: [],
  drivers: [], driverMath: '', flags: [], gauge: null, bandNote: '',
  chartNote: '', scoreSource: '', safety: [], safetyNote: '', intelState: 'idle',
  rep: null, repNote: '', repColor: '#3a4568'
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
 * The lit segment is the current stage and the marker sits at the score, so
 * the two can never disagree - the stage is the score, bucketed.
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
 * Every field traces to raw provider data in the raw store (market, intel or
 * ohlcv files), run through src/calculations in this browser. Anything that
 * could not be computed is rendered grey as '—' — this view never fabricates
 * a number to fill a gap.
 */
export function detailVals(app, a, showAdj, extra) {
    if (!a) return EMPTY_DETAIL;
    const { intel = null, bars = null, intelState = 'idle', barsState = 'idle', staleMs = 0 , tokenOutcomes = null } = extra || {};
    const row = a.rawServerRow || {};
    const si = stageInfo(a.stage);

    // ONE score per token. The pipeline computes it once per poll, with
    // whatever intel is cached for this token, and this view renders that
    // result - it never rescores. If it did, the board and this page would be
    // two snapshots of a moving input and would disagree by a few points.
    const scored = row;
    const scoreSource = `${row.scoreBasis === 'intel' ? 'intel' : 'feed'} · ` +
      `${row.componentsPresent ?? '?'} of ${(row.scoreModel || []).length} inputs`;

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

    // Real minute bars from the raw store; no bars means an empty chart, not a fake one.
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
      not_collected: 'The collector has not pulled bars for this pool yet — checking again shortly',
    };
    const chartNote = closes.length > 1
      ? (barsState === 'local_history' ? 'GeckoTerminal bars not collected yet — drawn from our own 15s price samples' : '')
      : (CHART_NOTES[barsState] || 'No price history for this pool');

    // The chart takes the raw bars now. It used to get a pre-scaled column
    // height per close, which is why o/h/l/v were being discarded.
    const chartBars = Array.isArray(bars) ? bars : [];
    const chartHasVolume = chartBars.some((b) => Number.isFinite(b && b.v) && b.v > 0);
    // The old "1M BARS" was wrong twice: it promised OHLC we were not drawing,
    // and "1M" reads as one MILLION on a panel where every other number is
    // suffixed M. The interval is spelled out, and the real span comes from
    // the bars themselves - without it, 60 one-minute candles and 60 fifteen-
    // second samples look identical while covering an hour and a quarter hour.
    const chartSpanMs = chartBars.length > 1
      ? chartBars[chartBars.length - 1].t - chartBars[0].t : 0;
    const chartSpan = chartSpanMs >= 7200000
      ? Math.round(chartSpanMs / 3600000) + ' HRS'
      : chartSpanMs >= 60000
        ? Math.round(chartSpanMs / 60000) + ' MIN'
        : chartSpanMs > 0 ? Math.round(chartSpanMs / 1000) + ' SEC' : '';
    const chartTitle = (barsState === 'local_history'
      ? 'EXECUTION PRICE · 15-SEC SAMPLES'
      : 'EXECUTION PRICE · 1-MIN CANDLES') +
      (chartSpan ? ' · LAST ' + chartSpan : '');

    const holders = intel && intel.holders ? intel.holders : null;
    // One number for top-10 share: whatever the score resolved. Falls back to
    // the raw provider sum only when the score has not run yet.
    const topShare = (scored.facts && scored.facts.topHolderSharePct != null)
      ? scored.facts.topHolderSharePct
      : (holders && holders.topHolderSharePct != null ? holders.topHolderSharePct
        : (holders && holders.jupiterTopHoldersPct != null ? holders.jupiterTopHoldersPct : null));
    const impactPct = intel && intel.impact ? intel.impact.priceImpactPct : null;
    const impactSource = intel && intel.impact ? intel.impact.source : null;
    const netUsd5m = row.flow && row.flow.netUsd != null ? row.flow.netUsd : null;
    const washRisk = row.flow && row.flow.washRisk != null ? row.flow.washRisk / 100 : null;
    const jup = (intel && intel.jupiter) || row.jupiter || null;
    const supply = (intel && intel.supply) || (row.circulatingSupply != null
      ? { circulating: row.circulatingSupply, total: row.totalSupply } : null);
    // Our own verdict, produced once by organicFlowScore() in the pipeline.
    // Jupiter is NOT read here any more: it is the cross-check tile below, so
    // the two are never silently swapped for one another.
    const organic = row.organicFlow || null;
    const organicScore = organic && organic.score !== null ? organic.score
      : (row.flow ? row.flow.organicFlow : null);
    const organicCross = organic && organic.crossCheck ? organic.crossCheck : null;
    const organicShare = row.flow && row.flow.organicSharePct != null ? row.flow.organicSharePct
      : (intel && intel.flow ? intel.flow.organicSharePct24h : null);
    const holderChange1h = holders && holders.changePct1h != null ? holders.changePct1h
      : (jup && jup.stats1h ? jup.stats1h.holderChangePct : null);
    const crossPrice = intel && intel.priceCrossCheck ? intel.priceCrossCheck : null;
    const honeypot = intel && intel.honeypot ? intel.honeypot : null;

    /**
     * Why a tile is empty.
     *
     * A dash on its own is indistinguishable from a bug. The server already
     * reports, per provider, whether it answered and what it said when it did
     * not - "not indexed", "EVM only", an HTTP error - so a blank tile can
     * always name its own cause instead of leaving you to guess.
     */
    const src = (intel && intel.sources) || {};

    /**
     * Providers that cannot serve this chain at all - known from the chain
     * alone, without waiting for the collector.
     *
     * A BNB token used to report "not collected yet" for its Jupiter fields.
     * True of the fetch, but misleading about the wait: Jupiter and RugCheck
     * are Solana-only, so no amount of collecting will ever fill them. The
     * honest answer is available before the question is asked.
     */
    const isSolana = row.chain === 'solana';
    const CHAIN_BLOCKED = {
      jupiterTokens: isSolana ? null : 'Jupiter: Solana only',
      jupiterQuote: isSolana ? null : 'Jupiter: Solana only',
      rugcheck: isSolana ? null : 'RugCheck: Solana only',
      kyberswap: isSolana ? 'KyberSwap: EVM only' : null,
      honeypot: isSolana ? 'honeypot.is: EVM only' : null,
    };

    const providerNote = (key, label) => {
      // Chain coverage is decided before the collector is consulted, so a
      // permanent gap never masquerades as a pending one.
      if (CHAIN_BLOCKED[key]) return CHAIN_BLOCKED[key];
      const status = src[key];
      // No entry at all: intel has not been fetched for this token yet.
      if (status === undefined || status === null) {
        return intelState === 'loading' ? 'loading…'
          : intelState === 'error' ? label + ' unreachable'
          : intelState === 'pending' ? 'not collected yet'
          : 'not fetched yet';
      }
      // 'ok' means the provider answered, so the gap is in its payload, not
      // in reaching it - the caller supplies that more specific reason.
      return status === 'ok' ? null : label + ': ' + status;
    };
    /**
     * First provider that did NOT answer wins; else the caller's fallback.
     *
     * Providers this chain cannot use are considered LAST. Several fields are
     * served by a Solana provider on Solana and an EVM one elsewhere - routed
     * impact is Jupiter or KyberSwap - and naming the blocked one would tell a
     * BNB user that a Jupiter limitation explains a field KyberSwap owns. A
     * chain-blocked reason is only the answer when every candidate is blocked.
     */
    const whyOf = (candidates, fallback) => {
      const usable = candidates.filter(([key]) => !CHAIN_BLOCKED[key]);
      for (const [key, label] of (usable.length ? usable : candidates)) {
        const note = providerNote(key, label);
        if (note) return note;
      }
      return fallback || null;
    };
    /** Anything straight off the trending feed shares one cause. */
    const FEED_GAP = 'not reported by GeckoTerminal or DexScreener';

    const src_ = row.fieldSource || {};
    const tile = (k, value, text, color, why, source) => ({
      k,
      v: isMissing(value) ? '—' : text,
      c: isMissing(value) ? UNAVAILABLE : (color || '#dfe6f6'),
      // A tile always says where it stands: who supplied the number, or why
      // there isn't one. A bare dash is indistinguishable from a bug.
      why: isMissing(value) ? (why || null) : null,
      src: isMissing(value) ? null : (source || null)
    });
    const market = [
      tile('MKT CAP', row.marketCapUsd, fmtOr(row.marketCapUsd, fmtUsd), null, FEED_GAP, src_.marketCapUsd),
      tile('LIQUIDITY', row.liquidityUsd, fmtOr(row.liquidityUsd, fmtUsd), null, FEED_GAP, src_.liquidityUsd),
      tile('VOL 5M', row.volume5mUsd, fmtOr(row.volume5mUsd, fmtUsd), null, FEED_GAP, src_.volume5mUsd),
      tile('VOL 24H', row.volume24hUsd, fmtOr(row.volume24hUsd, fmtUsd), null, FEED_GAP, src_.volume24hUsd),
      tile('BUYERS 5M', row.traders5m && row.traders5m.buyers, fmtNum(row.traders5m && row.traders5m.buyers),
        null, 'GeckoTerminal reports no distinct buyer count for this pool', src_['traders5m.buyers']),
      tile('BUYERS 24H', row.traders24h && row.traders24h.buyers, fmtNum(row.traders24h && row.traders24h.buyers),
        null, 'GeckoTerminal reports no distinct buyer count for this pool', src_['traders24h.buyers']),
      tile('B/S RATIO 24H', row.buySellRatio24h, fmtOr(row.buySellRatio24h, (x) => x.toFixed(2)),
        row.buySellRatio24h >= 1 ? '#4d8dff' : '#ff4fae',
        'needs 24h buy and sell counts; one is missing', src_.buys24h),
      tile('VOL/LIQ 24H', row.volumeToLiquidity24h, fmtOr(row.volumeToLiquidity24h, (x) => x.toFixed(2) + '×'),
        null, 'needs both 24h volume and liquidity; one is missing', 'VibeScreener'),
      tile(impactSource ? 'IMPACT $10K · ' + String(impactSource).toUpperCase() : 'IMPACT $10K',
        impactPct, fmtPct(impactPct, 2), impactPct > 5 ? '#ff4fae' : '#dfe6f6',
        whyOf([['jupiterQuote', 'Jupiter'], ['kyberswap', 'KyberSwap']],
          'no router quoted a $10k trade for this token'),
        impactSource === 'jupiter' ? 'Jupiter routed quote'
          : impactSource === 'kyberswap' ? 'KyberSwap routed quote' : null),
      tile('HOLDERS', holders && holders.count, fmtNum(holders && holders.count), null,
        whyOf([['goplus', 'GoPlus'], ['rugcheck', 'RugCheck'], ['jupiterTokens', 'Jupiter']],
          'no holder count from GoPlus, RugCheck or Jupiter'),
        holders && (holders.goplusCount != null ? 'GoPlus'
          : holders.rugcheckCount != null ? 'RugCheck'
          : holders.jupiterCount != null ? 'Jupiter' : null)),
      // The share the SCORE resolved (wallets module, else GoPlus, else the
      // Jupiter audit). Reading GoPlus alone left this blank on Solana, where
      // GoPlus returns no holders array - while the score was happily using
      // Jupiter's figure a panel away.
      tile('TOP-10 SHARE', topShare, fmtPct(topShare), topShare >= 30 ? '#ff4fae' : '#dfe6f6',
        whyOf([['goplus', 'GoPlus'], ['jupiterTokens', 'Jupiter']],
          'GoPlus returns no holders list on Solana and the Jupiter audit had no figure'),
        (scored.facts && scored.facts.topHolderShareSource) || null),
      tile('NET BUY 5M', netUsd5m, fmtOr(netUsd5m, fmtUsd), netUsd5m >= 0 ? '#4d8dff' : '#ff4fae',
        'no trade sample or Jupiter 5m split for this pool yet',
        row.flow && row.flow.source === 'jupiter' ? 'Jupiter 5m split'
          : row.flow ? 'GeckoTerminal trade sample' : null),
      tile('WASH PROB', washRisk, fmtOr(washRisk, (x) => Math.round(x * 100) + '%'), washColor(washRisk),
        'organic flow not computed yet, so its inverse is unknown',
        'VibeScreener (inverse of organic flow)'),
      tile('POOL AGE', row.poolAgeHours, fmtOr(row.poolAgeHours, (x) => x < 48 ? x.toFixed(1) + 'h' : (x / 24).toFixed(1) + 'd'),
        null, 'neither provider reported a pool creation time', src_.poolCreatedAt),
      // Ours, on every chain, from our own trade sample.
      tile('ORGANIC SCORE', organicScore,
        fmtOr(organicScore, (x) => Math.round(x) + '/100' +
          (organic && organic.basis === 'jupiter' ? ' (Jupiter)' : '')),
        organicScore >= 60 ? '#4d8dff' : organicScore >= 30 ? '#e35ff2' : '#ff4fae',
        'no trade sample for this pool yet, and Jupiter had no organic score',
        organic && organic.basis === 'jupiter' ? 'Jupiter' : 'VibeScreener trade sample'),
      // Jupiter's own read, shown BESIDE ours rather than in place of it. A
      // divergence is the interesting case, so it is coloured, not hidden.
      tile('ORGANIC · JUPITER', organicCross && organicCross.value,
        fmtOr(organicCross && organicCross.value, (x) => Math.round(x) + '/100' +
          (organicCross.delta !== null
            ? ' (' + (organicCross.delta > 0 ? '+' : '') + organicCross.delta + ')' : '')),
        organicCross && organicCross.diverges ? '#e35ff2' : '#8b96b8',
        whyOf([['jupiterTokens', 'Jupiter']], 'Jupiter published no organic score for this token'),
        'Jupiter'),
      // Jupiter-backed tiles (Solana); grey on chains Jupiter does not index.
      tile('ORGANIC VOL 24H', organicShare, fmtPct(organicShare, 0), null,
        whyOf([['jupiterTokens', 'Jupiter']], 'Jupiter reported no organic split for this token'),
        'Jupiter'),
      tile('HOLDERS Δ 1H', holderChange1h, fmtOr(holderChange1h, (x) => (x > 0 ? '+' : '') + x.toFixed(2) + '%'),
        holderChange1h >= 0 ? '#4d8dff' : '#ff4fae',
        whyOf([['jupiterTokens', 'Jupiter']], 'no holder series long enough to measure an hourly change'),
        holders && holders.changePct1h != null ? 'Jupiter' : 'our holder series'),
      tile('CIRC SUPPLY', supply && supply.circulating,
        fmtOr(supply && supply.circulating, (x) => x >= 1e9 ? (x / 1e9).toFixed(2) + 'B' : x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : fmtNum(Math.round(x))),
        null, whyOf([['jupiterTokens', 'Jupiter']], 'Jupiter reported no circulating supply'), 'Jupiter'),
      tile('DEV MIGRATIONS', jup && jup.audit && jup.audit.devMigrations,
        fmtNum(jup && jup.audit && jup.audit.devMigrations),
        jup && jup.audit && jup.audit.devMigrations > 0 ? '#ff4fae' : '#4d8dff',
        whyOf([['jupiterTokens', 'Jupiter']], 'the Jupiter audit reported no dev history'),
        'Jupiter audit'),
      tile('LAUNCHPAD', (jup && jup.launchpad) || row.launchpad, (jup && jup.launchpad) || row.launchpad,
        null, whyOf([['jupiterTokens', 'Jupiter'], ['rugcheck', 'RugCheck']],
          'no provider named a launchpad; it may not be a launchpad token'),
        (jup && jup.launchpad) ? 'Jupiter' : 'RugCheck'),
      tile('PRICE vs LLAMA', crossPrice && crossPrice.deltaPct,
        fmtOr(crossPrice && crossPrice.deltaPct, (x) => (x > 0 ? '+' : '') + x.toFixed(2) + '%'),
        crossPrice && Math.abs(crossPrice.deltaPct) > 3 ? '#ff4fae' : '#dfe6f6',
        whyOf([['defillama', 'DefiLlama']], 'DefiLlama answered but priced nothing for this token'),
        'DefiLlama vs ' + (src_.priceUsd || 'feed')),
      tile('SELL SIMULATION', honeypot && honeypot.isHoneypot !== null ? honeypot.isHoneypot : null,
        honeypot && honeypot.isHoneypot === false ? 'PASSES' : 'HONEYPOT',
        honeypot && honeypot.isHoneypot === false ? '#4d8dff' : '#ff4fae',
        whyOf([['honeypot', 'honeypot.is']],
          'honeypot.is returned no simulation for this token'),
        'honeypot.is')
    ];

    /**
     * What this token DID after we scored it.
     *
     * Was a hard-coded em dash. The measurement existed all along - the
     * Evaluation tab has been computing it board-wide - it was simply never
     * asked for per token.
     *
     * The number is EXCESS return: this token minus the median of the board
     * scored at the same moment. Raw return would mostly report what the whole
     * market did that hour, which is the mistake the Evaluation page was
     * rebuilt to avoid.
     *
     * The old 15M box is gone: observations are sampled every 60s and a pick
     * is matched to a price within a 30-minute tolerance, so a 15-minute
     * horizon is shorter than its own matching window and cannot be measured.
     */
    const outcomeLabel = (ms) => (ms >= 3600000 ? Math.round(ms / 3600000) + 'H' : Math.round(ms / 60000) + 'M');
    const outcomes = (tokenOutcomes && tokenOutcomes.horizons ? tokenOutcomes.horizons : [3600000, 21600000, 86400000])
      .map((h) => {
        const o = tokenOutcomes && tokenOutcomes.byHorizon ? tokenOutcomes.byHorizon[h] : null;
        const k = outcomeLabel(h);
        if (!o) {
          return { k, v: '—', c: UNAVAILABLE,
            why: tokenOutcomes === null ? 'reading the archive…' : 'no outcome data for this token yet' };
        }
        if (!Number.isFinite(o.excessPct)) {
          // Distinguish "not old enough yet" from "we could not price it".
          const why = o.resolved === 0
            ? (o.pending ? 'scored ' + k + ' ago or less — still maturing'
              : 'no price at both ends within the 30 min tolerance')
            : 'resolved, but no board that moment to compare against';
          return { k, v: '—', c: UNAVAILABLE, why };
        }
        const pct = o.excessPct;
        return {
          k,
          v: (pct > 0 ? '+' : '') + pct.toFixed(1) + '%',
          c: pct > 0 ? '#4d8dff' : pct < 0 ? '#f2478f' : '#8b96b8',
          why: 'vs the board median at the same moment · raw ' +
            (o.returnPct > 0 ? '+' : '') + (Number.isFinite(o.returnPct) ? o.returnPct.toFixed(1) : '—') + '%' +
            ' · peak ' + (Number.isFinite(o.mfePct) ? (o.mfePct > 0 ? '+' : '') + o.mfePct.toFixed(1) + '%' : '—') +
            ' · worst ' + (Number.isFinite(o.maePct) ? (o.maePct > 0 ? '+' : '') + o.maePct.toFixed(1) + '%' : '—') +
            ' · from ' + o.resolved + ' scored moment' + (o.resolved === 1 ? '' : 's') +
            (o.rugged ? ' · LIQUIDITY PULLED' : ''),
        };
      });

    const sev = { HIGH: { bg: '#45103a', fg: '#ff4fae' }, MED: { bg: '#33124a', fg: '#e35ff2' }, LOW: { bg: '#1a2440', fg: '#a3aed0' } };
    const zMetrics = (intel && intel.zScores && intel.zScores.metrics) ||
      (row.zScores && row.zScores.metrics) || {};
    /**
     * What moves the score, in points.
     *
     * A component's 0-100 value on its own cannot be compared across rows: 98
     * on a weight of 4 matters less than 60 on a weight of 14. So each input
     * is shown as the POINTS it added or removed against a neutral 50:
     *
     *   points = (value - 50) x weight / weightUsed
     *
     * Those sum exactly to (raw score - 50), which is why the panel can show
     * its own arithmetic at the bottom and have it come out right. Bars
     * diverge from a centre line: right and blue is helping, left and pink is
     * hurting, so the sign is carried by direction as well as by colour.
     */
    const POS = '#4d8dff';
    const NEG = '#f2478f';
    const weightUsed = Number.isFinite(scored.weightCovered) ? scored.weightCovered : 0;

    const contributions = (scored.scoreModel || [])
      .filter((c) => !c.pending && Number.isFinite(c.value))
      .map((c) => {
        const z = zMetrics[Z_METRIC_FOR[c.key]] || null;
        return {
          label: c.label,
          points: weightUsed ? ((c.value - 50) * c.weight) / weightUsed : 0,
          value: c.value,
          weight: c.weight,
          evidence: c.evidence || '',
          // Only three inputs have a baseline; where one exists it is the most
          // interesting number on the row, so it gets a chip of its own.
          chip: z && Number.isFinite(z.multiple) ? z.multiple.toFixed(1) + '× normal' : null,
          z: z && Number.isFinite(z.z) ? z.z.toFixed(2) : null,
        };
      });

    // The penalty is not a component, but it is part of the final number, so
    // the chart would not add up without it.
    if (Number.isFinite(scored.riskPenalty) && scored.riskPenalty > 0) {
      contributions.push({
        label: 'Risk penalty', points: -scored.riskPenalty, value: null, weight: null,
        evidence: (row.riskFlags || []).map((f) => f.detail || f.code).join('; ') || 'risk flags raised',
        chip: null, z: null, isPenalty: true,
      });
    }

    const maxAbs = contributions.reduce((m, d) => Math.max(m, Math.abs(d.points)), 0) || 1;
    const drivers = contributions
      .sort((a, b) => Math.abs(b.points) - Math.abs(a.points))
      .map((d) => {
        const up = d.points >= 0;
        // Half the track per arm, so the centre line is a true zero.
        const pct = (Math.abs(d.points) / maxAbs) * 50;
        return {
          label: d.label,
          pointsLabel: (up ? '+' : '−') + Math.abs(d.points).toFixed(1),
          c: up ? POS : NEG,
          // 4px rounded on the data end only; the end at the centre stays square.
          barStyle: up
            ? 'left:50%;width:' + pct.toFixed(2) + '%;border-radius:0 4px 4px 0'
            : 'right:50%;width:' + pct.toFixed(2) + '%;border-radius:4px 0 0 4px',
          chip: d.chip,
          title: d.evidence + (d.z ? ' · z ' + d.z : '') +
            (d.weight ? ' · weight ' + d.weight : ''),
        };
      });

    // The panel's own arithmetic, so the picture is checkable.
    const driverMath = Number.isFinite(scored.rawScore)
      ? 'neutral 50 → raw ' + scored.rawScore +
        (Number.isFinite(scored.riskPenalty) && scored.riskPenalty > 0
          ? ' − ' + scored.riskPenalty + ' risk' : '') +
        ' = ' + (Number.isFinite(scored.score) ? scored.score : '—')
      : '';

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
    // Ethos reputation of the project's X account. Chain + token, because the
    // collector keys it that way; null until ethos.json has been read once.
    const reputation = ethosFor(
      String(row.chain || a.chain || '').toLowerCase(),
      row.tokenAddress || a.tokenAddress,
    );

    const safetyNote = safety.length ? ''
      : intelState === 'loading' ? 'Loading contract checks…'
      : intelState === 'error' ? 'Contract checks unavailable from GoPlus / RugCheck'
      : intelState === 'pending' ? 'The collector has not reached this token yet — checks appear within minutes'
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

    // PERP LISTING: would this token make a good perp - the hard gates, and
    // the three listing components the score now carries. Read off the row
    // (row.gates, row.facts, row.scoreModel), never re-derived here.
    const compOf = (key) => (row.scoreModel || []).find((c) => c.key === key) || null;
    const compChip = (key) => {
      const c = compOf(key);
      return c && Number.isFinite(c.value) ? { n: c.value, c: barColor(c.value) } : { n: '—', c: UNAVAILABLE };
    };
    const facts = row.facts || {};
    const perp = facts.perp || null;
    const reach = facts.reach || null;
    const gates = row.gates || null;
    const listing = [
      {
        k: 'Perp elsewhere', chip: compChip('whitespace'),
        v: !perp ? 'not checked yet'
          : perp.listedOn.length ? perp.listedOn.map((id) => perp.labels[id] || id).join(', ')
          : perp.checked ? 'none found' : 'venues unreachable',
        c: !perp || (!perp.listedOn.length && !perp.checked) ? UNAVAILABLE : perp.listedOn.length ? '#ff4fae' : '#4d8dff',
        why: perp ? 'Checked ' + perp.checked + ' of ' + perp.total + ' venues by ticker' +
          (perp.unreachable && perp.unreachable.length ? ' (unreachable: ' + perp.unreachable.join(', ') + ')' : '') +
          '. Venues list symbols, not contracts, so a shared ticker reads as listed.' : '',
      },
      {
        k: 'Pool age', chip: compChip('durability'),
        v: Number.isFinite(row.poolAgeHours) ? (row.poolAgeHours / 24).toFixed(1) + ' days' : '—',
        c: Number.isFinite(row.poolAgeHours) ? (row.poolAgeHours >= 24 * 14 ? '#dfe6f6' : '#ff4fae') : UNAVAILABLE,
        why: 'Durability: 14 days = 0, 180 days = 100. Under 14 days the age gate vetoes it.',
      },
      {
        k: 'Contact', chip: compChip('reachability'),
        v: reach ? ([reach.website && 'website', reach.x && 'X', reach.telegram && 'Telegram'].filter(Boolean).join(' · ') || 'none advertised') : '—',
        c: reach && (reach.website || reach.x || reach.telegram) ? '#dfe6f6' : UNAVAILABLE,
        why: 'Reachability: website 30 + X 30 + Telegram 20 + paid promotion 20.',
      },
      {
        k: 'Paid promotion', chip: null,
        v: reach && reach.promotion.length
          ? reach.promotion.map((p) => p.kind.toLowerCase() + (Number.isFinite(p.totalAmount) ? ' ×' + p.totalAmount : '')).join(' + ')
          : 'none',
        c: reach && reach.boosted ? '#ffd60a' : UNAVAILABLE,
        why: 'A DexScreener boost or profile bought - the team is paying to be seen right now.',
      },
    ];
    const listingVerdict = !gates ? null : gates.vetoed
      ? { text: 'VETOED · ' + gates.vetoes.map((g) => g.label.toLowerCase()).join(', '), c: '#ff4fae',
          why: gates.vetoes.map((g) => g.label + ': ' + g.detail).join('\n') + '\nA vetoed token scores 0.' }
      : { text: 'passes every gate' + (gates.unchecked.length ? ' checked so far' : ''), c: '#4d8dff',
          why: gates.unchecked.length ? 'Not checked yet: ' + gates.unchecked.join(', ') : 'All ' + gates.checks.length + ' gates passed.' };

    const finalScore = Number.isFinite(scored.score) ? scored.score
      : (a.score == null ? null : Math.round(a.score));
    return {
      sym: a.sym, name: a.name, stage: si.n, stageBg: si.bg, stageFg: si.fg, cls: a.cls, clsColor: clsColor(a.cls), canonical: a.canonical,
      score: finalScore == null ? '—' : finalScore,
      scoreColor: finalScore == null ? UNAVAILABLE : scoreColor(finalScore),
      // The settled score is the headline; this poll's own number sits beside
      // it, and the drift between them says whether the token is still moving.
      scoreNow: Number.isFinite(scored.scoreNow) ? scored.scoreNow : '—',
      scoreNowColor: Number.isFinite(scored.scoreNow) ? scoreColor(scored.scoreNow) : UNAVAILABLE,
      scoreWindowLabel: Number.isFinite(scored.scoreWindowMs)
        ? Math.round(scored.scoreWindowMs / 60000) + 'M AVG' : 'AVG',
      scoreWindowNote: Number.isFinite(scored.scoreSamples)
        ? 'Mean of ' + scored.scoreSamples + ' readings over the last ' +
          (scored.scoreObservedMs >= 60000
            ? Math.round(scored.scoreObservedMs / 60000) + ' min'
            : Math.round((scored.scoreObservedMs || 0) / 1000) + 's') +
          '. The stage follows this number, not the momentary one.'
        : '',
      scoreSpark: scoreSpark(scoreSeriesFor(row.chain, row.tokenAddress), finalScore),
      scoreRange: Number.isFinite(scored.scoreMin) && scored.scoreMin !== scored.scoreMax
        ? scored.scoreMin + '–' + scored.scoreMax + ' seen' : null,
      scoreDrift: (Number.isFinite(scored.scoreNow) && Number.isFinite(finalScore))
        ? (scored.scoreNow === finalScore ? 'settled'
          : (scored.scoreNow > finalScore ? '+' : '−') + Math.abs(scored.scoreNow - finalScore) + ' vs avg')
        : null,
      scoreDriftColor: (Number.isFinite(scored.scoreNow) && Number.isFinite(finalScore))
        ? (scored.scoreNow >= finalScore ? '#4d8dff' : '#f2478f') : UNAVAILABLE,
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
      spark, chartNote, chartBars, chartHasVolume, chartTitle,
      // What the price & score chart loads for itself.
      chartChain: row.chain || null, chartPool: row.poolAddress || null, chartToken: row.tokenAddress || null,
      market, outcomes, subs, safety, safetyNote,
      listing, listingVerdict,
      // Reputation of the X account this token advertises - a fact about the
      // project's identity, kept beside contract safety because that is where
      // the same question gets asked about the contract.
      rep: reputation,
      repNote: ethosNote(reputation),
      repColor: ethosColor(reputation && reputation.state),
      isStock: !!a.oracle, oracle,
      drivers, driverMath, flags,
      gauge: buildGauge(finalScore, a.stage),
      // WATCH 0 / EMERGING 55 / CONFIRMED 70 / EXCEPTIONAL 85. The stage
      // follows the score immediately, both ways - the badge can never
      // disagree with the number next to it.
      bandNote: finalScore == null
        ? 'Bands 55 / 70 / 85.'
        : 'Bands 55 / 70 / 85. The stage is the final score bucketed, so it moves the moment the ' +
          'score crosses a band in either direction. At ' + finalScore + ' this is ' + si.n + '.'
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
          </>) : (<div style={css("padding-top:4px;font-size:9px;color:#3a4568", { v })}>score unavailable</div>)}</div></div><div style={css("flex:1 1 240px;font-size:10px;color:#8b96b8;line-height:1.5;max-width:420px", { v })}>{v.d.bandNote}</div></div>{/* Price and score on one axis, full width - see ScoreHistoryChart. */}<div style={{ marginBottom: 10 }}>{v.d.chartPool ? <ScoreHistoryChart chain={v.d.chartChain} pool={v.d.chartPool} token={v.d.chartToken} height={380} /> : null}</div><div style={css("display:grid;grid-template-columns:1.5fr 1fr;gap:10px", { v })}><div style={css("display:flex;flex-direction:column;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>MARKET</div><div style={css("display:grid;grid-template-columns:repeat(4,1fr);gap:10px", { v })}>{(v.d.market || []).map((m, i) => (<React.Fragment key={i}>
            <div title={m.why || (m.src ? 'source: ' + m.src : '')}><div style={css("font-size:9px;color:#6b7699;letter-spacing:.6px", { v, m })}>{m.k}</div><div style={css("font-size:13px;font-weight:600;margin-top:2px;color:{{ m.c }}", { v, m })}>{m.v}</div>{m.src && (<div style={css("font-size:8px;color:#4a5578;margin-top:2px;line-height:1.35", { v, m })}>{m.src}</div>)}{m.why && (<div style={css("font-size:8px;color:#5b4468;margin-top:2px;line-height:1.35", { v, m })}>{m.why}</div>)}</div>
          </React.Fragment>))}</div>{v.d.sourceLine && (<div style={css("font-size:8.5px;color:#3a4568;margin-top:9px;padding-top:7px;border-top:1px solid #16223f", { v })}>{v.d.sourceLine}</div>)}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600", { v })}>WHAT MOVES THIS SCORE</div><div style={css("font-size:9px;color:#4a5578", { v })}>points vs a neutral 50</div></div><div style={css("display:flex;gap:8px;align-items:center;margin-bottom:7px;font-size:8.5px;color:#4a5578", { v })}><span style={css("display:inline-block;width:8px;height:8px;border-radius:2px;background:#4d8dff", { v })}></span><span>helping</span><span style={css("display:inline-block;width:8px;height:8px;border-radius:2px;background:#f2478f;margin-left:6px", { v })}></span><span>holding it back</span></div>{(v.d.drivers || []).map((dr, i) => (<React.Fragment key={i}>
            <div title={dr.title} style={css("display:flex;align-items:center;gap:6px;padding:2px 0", { v, dr })}><span style={css("width:104px;flex-shrink:0;font-size:10px;color:#a3aed0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, dr })}>{dr.label}</span><div style={css("flex:1 1 auto;position:relative;height:10px;min-width:48px", { v, dr })}><div style={css("position:absolute;left:50%;top:-1px;bottom:-1px;width:1px;background:#1c2a4d", { v, dr })}></div><div style={css("position:absolute;top:1px;height:8px;background:{{ dr.c }};{{ dr.barStyle }}", { v, dr })}></div></div><span style={css("width:38px;flex-shrink:0;text-align:right;font-size:10px;font-weight:700;color:{{ dr.c }}", { v, dr })}>{dr.pointsLabel}</span>{dr.chip && (<span style={css("flex-shrink:0;font-size:8px;color:#6b7699;white-space:nowrap", { v, dr })}>{dr.chip}</span>)}</div>
          </React.Fragment>))}<div style={css("margin-top:8px;padding-top:7px;border-top:1px solid #16223f;font-size:9px;color:#6b7699", { v })}>{v.d.driverMath}</div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>OUTCOME TRACKING <span style={css("font-weight:400;letter-spacing:0;color:#4a5578", { v })}>· excess vs the board</span></div><div style={css("display:grid;grid-template-columns:repeat(3,1fr);gap:10px", { v })}>{(v.d.outcomes || []).map((o, i) => (<React.Fragment key={i}>
            <div title={o.why || ''} style={css("background:#101c38;border:1px solid #1c2a4d;border-radius:10px;padding:8px 10px;text-align:center", { v, o })}><div style={css("font-size:9px;color:#6b7699;letter-spacing:1px", { v, o })}>{o.k}</div><div style={css("font-size:14px;font-weight:700;margin-top:3px;color:{{ o.c }}", { v, o })}>{o.v}</div>{o.why && (<div style={css("font-size:8px;color:#4a5578;margin-top:3px;line-height:1.3", { v, o })}>{o.why}</div>)}</div>
          </React.Fragment>))}</div></div></div><div style={css("display:flex;flex-direction:column;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>SCORE DECOMPOSITION</div>{(v.d.subs || []).map((s, i) => (<React.Fragment key={i}>
            <div title={s.evidence} style={css("display:flex;align-items:center;gap:6px;padding:2.5px 0", { v, s })}><span title={s.k} style={css("width:104px;flex-shrink:0;font-size:10px;color:{{ s.keyColor }};white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, s })}>{s.k}</span><span style={css("width:24px;flex-shrink:0;font-size:9px;color:#6b7699", { v, s })}>{s.w}</span><div style={css("flex:1 1 auto;min-width:40px;height:7px;background:#16223f;border-radius:1px;overflow:hidden", { v, s })}><div className="score-bar" style={css("height:100%;width:{{ s.pct }};background:{{ s.c }}", { v, s })}></div></div><span style={css("width:24px;flex-shrink:0;text-align:right;font-size:10px;font-weight:600;color:{{ s.labelColor }}", { v, s })}>{s.label}</span></div>
          </React.Fragment>))}<div style={css("display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid #1c2a4d;font-size:10px", { v })}><span style={css("color:#8b96b8", { v })}>RAW <span style={css("color:#ffffff;font-weight:700", { v })}>{v.d.raw}</span></span><span style={css("color:#8b96b8", { v })}>RISK PENALTY <span style={css("color:#ff4fae;font-weight:700", { v })}>−{v.d.penalty}</span></span><span style={css("color:#8b96b8", { v })}>FINAL <span style={css("color:{{ d.scoreColor }};font-weight:700", { v, d: v.d })}>{v.d.score}</span></span></div><div style={css("font-size:9px;color:#6b7699;margin-top:6px", { v })}>source: {v.d.scoreSource} · grey rows are inputs that could not be computed yet</div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>RISK FLAGS</div>{(v.d.flags || []).map((f, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;gap:8px;align-items:baseline;padding:4px 0", { v, f })}><span style={css("font-size:9px;font-weight:700;padding:2px 6px;border-radius:10px;background:{{ f.bg }};color:{{ f.fg }};flex-shrink:0", { v, f })}>{f.sev}</span><span style={css("font-size:11px;color:#c6d1ea", { v, f })}>{f.text}</span></div>
          </React.Fragment>))}{!(v.d.flags || []).length && (<div style={css("font-size:10px;color:#3a4568;padding:4px 0", { v })}>No risk flags raised</div>)}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>CONTRACT SAFETY · GoPlus + RugCheck</div>{(v.d.safety || []).map((sc, i) => (<React.Fragment key={i}>
            <div title={sc.detail} style={css("display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid #16223f", { v, sc })}><span style={css("font-size:11px;font-weight:700;color:{{ sc.c }};flex-shrink:0;width:12px", { v, sc })}>{sc.glyph}</span><span style={css("flex:1;font-size:10.5px;color:#c6d1ea", { v, sc })}>{sc.label}</span><span style={css("font-size:9.5px;color:#6b7699", { v, sc })}>{sc.detail}</span></div>
          </React.Fragment>))}{v.d.safetyNote && (<div style={css("font-size:10px;color:#3a4568;padding:4px 0", { v })}>{v.d.safetyNote}</div>)}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px", { v })}><span style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600", { v })}>PERP LISTING</span>{v.d.listingVerdict && (<span title={v.d.listingVerdict.why} style={css("font-size:9px;font-weight:700;letter-spacing:.4px;color:{{ lv.c }};text-align:right", { v, lv: v.d.listingVerdict })}>{v.d.listingVerdict.text}</span>)}</div>{(v.d.listing || []).map((l, i) => (<React.Fragment key={i}>
            <div title={l.why} style={css("display:flex;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid #16223f", { v, l })}><span style={css("width:92px;flex-shrink:0;font-size:10px;color:#a3aed0", { v, l })}>{l.k}</span><span style={css("flex:1;min-width:0;font-size:10.5px;font-weight:600;color:{{ l.c }};overflow:hidden;text-overflow:ellipsis;white-space:nowrap", { v, l })}>{l.v}</span>{l.chip && (<span style={css("width:26px;flex-shrink:0;text-align:right;font-size:10px;font-weight:700;color:{{ ch.c }}", { v, ch: l.chip })}>{l.chip.n}</span>)}</div>
          </React.Fragment>))}<div style={css("font-size:9px;color:#6b7699;margin-top:6px;line-height:1.45", { v })}>Would this token make a good perp: no perp elsewhere yet, a pool that has lasted, a team you can reach. The numbers are the Whitespace, Durability and Reachability scores.</div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>PROJECT REPUTATION · Ethos</div>{v.d.rep && v.d.rep.linked ? (<>
            <div style={css("display:flex;align-items:baseline;justify-content:space-between;gap:10px", { v })}><a href={v.d.rep.url} target="_blank" rel="noreferrer" style={css("font-size:12px;font-weight:700;color:{{ d.repColor }};text-decoration:none", { v, d: v.d })}>@{v.d.rep.handle}</a><span style={css("font-size:15px;font-weight:700;color:{{ d.repColor }}", { v, d: v.d })}>{v.d.rep.score == null ? '—' : (v.d.rep.score === 0 ? 'unrated' : v.d.rep.score)}</span></div>
            <div style={css("display:flex;justify-content:space-between;margin-top:4px;font-size:9.5px", { v })}><span style={css("color:#6b7699;letter-spacing:.6px", { v })}>{v.d.rep.levelLabel || '—'}{v.d.rep.kind === 'post' ? ' · FROM A POST LINK' : ''}</span><span style={css("color:#6b7699", { v })}>{v.d.rep.delta == null ? '' : (v.d.rep.delta > 0 ? '+' : '') + v.d.rep.delta + ' vs start'}</span></div>
          </>) : null}<div style={css("font-size:10px;color:#3a4568;padding:6px 0 0;line-height:1.5", { v })}>{v.d.repNote}</div></div>{v.d.isStock && (<>
            <div style={css("background:#0a1226;border:1px solid #16406e;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#4fc3f7;font-weight:600;margin-bottom:8px", { v })}>STOCK TOKEN / ORACLE</div><div style={css("display:grid;grid-template-columns:1fr 1fr;gap:8px 14px", { v })}>{(v.d.oracle || []).map((o, i) => (<React.Fragment key={i}>
              <div style={css("display:flex;justify-content:space-between;font-size:10.5px;border-bottom:1px solid #16223f;padding:3px 0", { v, o })}><span style={css("color:#6b7699", { v, o })}>{o.k}</span><span style={css("font-weight:600;color:{{ o.c }}", { v, o })}>{o.v}</span></div>
            </React.Fragment>))}</div></div>
          </>)}</div></div></div>
        </>
}
