import React from 'react';
import { stageInfo } from '../utils/formatters';
import { OUTCOME_HORIZONS } from '../services/api';
import Help from '../components/Help';

/**
 * EVALUATION - does a higher score lead to a better outcome?
 *
 * The page reads top to bottom in the order a user asks:
 *
 *   header      the question, and the two controls that apply to ALL of it
 *   answer      verdict + three numbers + is the edge steady (IC per moment)
 *   trust       how much data the answer stands on
 *   evidence    every group, every metric, one table
 *   reality     what it looked like in price, and which warnings preceded losses
 *
 * Every figure is one scoreOutcomes() report (calculations/core.js): the app
 * store's score journal joined to the collector's raw price files. There is
 * no fallback branch - with no data the page says it is measuring, it never
 * draws a demo number.
 */

const POS = '#4d8dff';
const NEG = '#ff4fae';
const WARN = '#ffc65e';
const DIM = '#3a4568';
const MUTED = '#8b96b8';
const STAGE_NUM = { EXCEPTIONAL: 4, CONFIRMED: 3, EMERGING: 2, WATCH: 1 };

const hLabel = (ms) => Math.round(ms / 3600000) + 'H';
const hWords = (ms) => { const h = Math.round(ms / 3600000); return h + (h === 1 ? ' hour' : ' hours'); };
const signed = (v, dp = 1) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(dp) + '%');
const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
const tone = (v) => (v == null ? DIM : v > 0 ? POS : v < 0 ? NEG : MUTED);
const utc = (t) => new Date(t).toISOString().slice(11, 16);

const VERDICTS = {
  EDGE: { text: 'EDGE', fg: '#0a1226', bg: POS },
  'NO CLEAR EDGE': { text: 'NO CLEAR EDGE', fg: '#0a1226', bg: WARN },
  INVERTED: { text: 'INVERTED', fg: '#0a1226', bg: NEG },
  COLLECTING: { text: 'COLLECTING', fg: '#a3aed0', bg: '#16223f' },
};

/**
 * What each label means, in plain words, for the "?" buttons. Keyed by the
 * label as drawn, so a renamed label needs its entry renamed.
 */
const HELP = {
  // header
  'TIME WINDOW': 'How long we wait after a score before checking the price: 1 hour, 6 hours or 24 hours. It changes every number on this page. Greyed-out options do not have enough checked predictions yet.',
  'GROUP BY': 'RANK groups tokens by where they stood on the board at that moment (top 20%, next 20%…) — it tests whether the ORDER is right. SCORE groups them by the score itself (the stage bands) — it tests whether a high number means something on its own.',

  // answer
  'THE ANSWER': 'Did tokens the app scored higher actually do better than tokens it scored lower? This is the main test of whether the score is useful.',
  VERDICT: 'EDGE — higher scores really did better. NO CLEAR EDGE — no reliable difference yet. INVERTED — lower scores did better, so the score points the wrong way at this time window. COLLECTING — not enough checked predictions to judge yet.',
  'RANK IC': 'A number from −1 to +1 for how well the score order matched the price-change order. +1 = perfect, 0 = no link, −1 = exactly backwards. For a screener, anything steadily above +0.03 is useful.',
  'TOP − BOTTOM': 'How much better the top 20% of tokens did than the bottom 20%, after removing the market’s overall move. Positive = the top of the board beat the bottom.',
  ORDERED: 'Going down the five groups from top 20% to bottom 20%, how many steps went the right way (each group did better than the one below it). 4 / 4 is a perfect staircase.',
  'EACH MOMENT': 'The Rank IC measured separately at each 15-minute moment, oldest on the left. Blue bars above the line = the ordering worked at that moment; pink below = it was backwards. Mostly blue means the edge is steady, not one lucky burst.',

  // trust
  'HOW MUCH DATA': 'How many predictions the answer stands on. The more pink (resolved), the more you can trust the verdict.',
  PREDICTIONS: 'Every score the app saved is a prediction. We keep one per token per 15 minutes, so a token watched for an hour counts about 4 times, not 60. Each prediction is in one of three groups — together they add up to the total.',
  resolved: 'Enough time has passed and we have the price at the moment of the score and at the end. We know how it turned out. Only these count towards the verdict and the tables.',
  maturing: 'The score is newer than the time window you picked, so it is too early to tell. We wait — it is never counted as a loss.',
  'in a price gap': 'Enough time has passed, but the server was not recording prices at the start or the end (for example, it was switched off). We cannot know the result, so it is left out rather than guessed.',
  'READY TO JUDGE': 'The verdict needs at least 30 checked predictions spread over at least 4 separate 15-minute moments. Fewer than that and one lucky burst could decide it, so the page says COLLECTING instead.',
  'TOKENS SCORED': 'How many different tokens the app has saved a score for, and how many of them the server also has prices for — a score can only be checked if we know the price.',

  // evidence
  'HOW EACH GROUP DID': 'Every group of predictions, from the highest ranked to the lowest. If the score works, the bars should step down from right (better than the board) to left (worse). Faded rows have fewer than 10 predictions and are not used in the comparisons.',
  'RANK IN MOMENT': 'Where the token stood on the board when it was scored — top 20%, 20–40% and so on — compared only with the other tokens scored at the same moment.',
  'SCORE BAND': 'The score range (and stage) the token had when it was scored.',
  'vs BOARD': 'The bar shows how the group did compared with the whole board at the same moment. Right of the middle line = did better than the market; left = did worse.',
  EXCESS: 'The typical return minus what the whole board did at the same time. If everything went up 10% and this group went up 13%, excess is +3%. It shows skill, not luck with the market.',
  BEAT: 'The share of predictions in this group that did better than the board’s typical token at the same moment. Above 50% is good.',
  RAW: 'The typical plain price change, market included — what you would have seen in your wallet.',
  WIN: 'The share of predictions in this group whose price was simply higher at the end, market included.',
  BEST: 'The typical best point reached during the window, compared with the price at the score. How much you could have made if you sold at the top.',
  WORST: 'The typical worst point reached during the window. How far it dipped before the end — the pain you would have sat through.',
  RUG: 'The share of predictions in this group whose pool lost more than 80% of its liquidity by the end — usually a rug pull.',
  'AVG SCORE': 'The average score of the predictions in this group.',
  N: 'How many checked predictions are in this group. Groups with fewer than 10 are shown faded and are not used in the comparisons.',

  // reality
  'IN PRICE': 'What all checked predictions looked like in plain price terms, market included, over the time window you picked.',
  'MEDIAN RETURN': 'The typical price change of all checked predictions — half did better, half did worse.',
  'WENT UP': 'The share of checked predictions whose price was higher at the end than at the score.',
  'BEST POINT': 'The typical best price reached during the window, compared with the price at the score.',
  'WORST POINT': 'The typical lowest price reached during the window, compared with the price at the score.',
  'RUG RATE': 'How often a token lost more than 80% of its liquidity (the money in its trading pool) by the end of the window. That usually means the pool was pulled. Lower is better.',
  'WARNING FLAGS': 'The warning flags the app attached to a token when it scored it, and how often each one showed up on predictions that then did WORSE than the board compared with ones that did BETTER. A flag that shows up far more on losers is a warning worth weighting more heavily.',
  LOSERS: 'The share of predictions that did worse than the board which carried this flag.',
  WINNERS: 'The share of predictions that did better than the board which carried this flag.',
  'LOSS RATE': 'Of all checked predictions carrying this flag, the share that did worse than the board. Above 50% means the flag leans towards losses.',
};

const q = (key, title) => (HELP[key] ? <Help title={title || key.toUpperCase()} text={HELP[key]} /> : null);

/* ================================================================ model == */

export function evalVals(app) {
  const st = app.state;
  const outcomes = st.apiEval && st.apiEval.outcomes;
  if (!outcomes) {
    return { outcome: { ready: false, note: 'Joining the score journal to the price record…' } };
  }

  const byH = outcomes.byHorizon || {};
  // Default to the longest horizon that has reached a verdict; a user pick wins.
  const auto = OUTCOME_HORIZONS.slice().reverse().find((h) => byH[h] && byH[h].verdict !== 'COLLECTING') ||
    OUTCOME_HORIZONS[0];
  const horizon = byH[st.evalHorizon] ? st.evalHorizon : auto;
  const view = st.evalView === 'SCORE' ? 'SCORE' : 'RANK';
  const r = byH[horizon];
  const H = hLabel(horizon);
  const t = r.thresholds;
  const s = outcomes.sources || {};

  const horizons = OUTCOME_HORIZONS.map((h) => ({
    label: hLabel(h),
    active: h === horizon,
    // Greyed when there is nothing to say yet, but still clickable: the page
    // then explains exactly what is missing.
    ready: !!(byH[h] && byH[h].verdict !== 'COLLECTING'),
    pick: () => app.setState({ evalHorizon: h }),
  }));
  const views = ['RANK', 'SCORE'].map((k) => ({
    label: k, active: k === view, ready: true,
    pick: () => app.setState({ evalView: k }),
  }));

  /* ---- the answer ---- */
  const top = r.byRank[0];
  const bottom = r.byRank[r.byRank.length - 1];
  let sentence;
  if (r.verdict === 'COLLECTING') {
    sentence = 'Not enough checked predictions to judge the ' + H + ' window yet — see “How much data”.';
  } else if (r.verdict === 'EDGE') {
    sentence = 'Higher-ranked tokens did better. Over ' + hWords(horizon) + ' the top 20% beat the board by ' +
      signed(top.medianExcessPct) + ', the bottom 20% by ' + signed(bottom.medianExcessPct) + '.';
  } else if (r.verdict === 'INVERTED') {
    sentence = 'Lower-ranked tokens did better over ' + hWords(horizon) +
      ' — the score is pointing the wrong way at this time window.';
  } else {
    sentence = 'The score is not yet separating winners from losers over ' + hWords(horizon) + '.';
  }

  const ic = r.ic.mean;
  const metrics = [
    {
      label: 'RANK IC',
      value: ic == null ? '—' : (ic > 0 ? '+' : '') + ic.toFixed(2),
      color: ic == null ? DIM : ic > 0.03 ? POS : ic < -0.03 ? NEG : MUTED,
      sub: r.ic.moments ? 'positive in ' + pct(r.ic.positiveShare) + ' of moments' : 'no moments yet',
    },
    {
      label: 'TOP − BOTTOM',
      value: signed(r.spreadPct),
      color: tone(r.spreadPct),
      sub: 'top 20% vs bottom 20%',
    },
    {
      label: 'ORDERED',
      value: r.monotonic.steps ? r.monotonic.ordered + ' / ' + r.monotonic.steps : '—',
      color: !r.monotonic.steps ? DIM : r.monotonic.ordered === r.monotonic.steps ? POS
        : r.monotonic.ordered * 2 >= r.monotonic.steps ? MUTED : NEG,
      sub: 'steps going the right way',
    },
  ];

  // IC per moment. The newest 96 (a day of 15-min moments) is plenty to see
  // whether the edge is steady, and keeps each bar wide enough to hover.
  const series = (r.icSeries || []).slice(-96);
  const icBars = series.map((p) => ({
    key: p.t,
    h: Math.min(50, Math.abs(p.ic) * 50) + '%',
    top: p.ic >= 0 ? (50 - Math.min(50, Math.abs(p.ic) * 50)) + '%' : '50%',
    color: p.ic >= 0 ? POS : NEG,
    title: utc(p.t) + ' UTC · IC ' + (p.ic > 0 ? '+' : '') + p.ic.toFixed(2) + ' · ' + p.n + ' tokens',
  }));

  /* ---- trust ---- */
  const total = r.picks + r.pending + r.unresolved;
  const segments = [
    { key: 'resolved', label: 'resolved', n: r.picks, color: '#e35ff2' },
    { key: 'maturing', label: 'maturing', n: r.pending, color: POS },
    { key: 'gap', label: 'in a price gap', n: r.unresolved, color: WARN },
  ].map((p) => Object.assign(p, {
    w: total ? (p.n / total) * 100 + '%' : '0%',
    share: total ? Math.round((p.n / total) * 100) + '%' : '—',
  }));
  const checks = [
    { label: r.picks + ' / ' + t.minPicks + ' resolved predictions', ok: r.picks >= t.minPicks },
    { label: r.ic.moments + ' / ' + t.minMoments + ' separate moments', ok: r.ic.moments >= t.minMoments },
  ];

  /* ---- evidence ---- */
  const groups = view === 'RANK' ? r.byRank : r.byScore;
  const scale = Math.max(1, ...groups.map((g) => Math.abs(g.medianExcessPct || 0)));
  const rows = groups.map((g) => {
    const thin = g.n < t.minGroup;
    const x = g.medianExcessPct;
    const w = x == null ? 0 : Math.min(50, (Math.abs(x) / scale) * 50);
    const si = view === 'SCORE' ? stageInfo(STAGE_NUM[g.key]) : null;
    return {
      key: g.key,
      label: g.label,
      badge: si ? { text: si.n, bg: si.bg, fg: si.fg } : null,
      barLeft: (x != null && x < 0 ? 50 - w : 50) + '%',
      barW: w + '%',
      barColor: thin ? DIM : tone(x),
      excess: signed(x),
      excessColor: thin ? DIM : tone(x),
      beat: pct(g.hitRate),
      beatColor: thin || g.hitRate == null ? DIM : g.hitRate >= 0.5 ? POS : NEG,
      raw: signed(g.medianRetPct),
      win: pct(g.winRate),
      best: signed(g.medianMfePct),
      worst: signed(g.medianMaePct),
      rug: pct(g.rugRate),
      rugColor: g.rugRate > 0.03 ? NEG : MUTED,
      avg: g.avgScore == null ? '—' : String(Math.round(g.avgScore)),
      n: String(g.n),
      opacity: thin ? '0.5' : '1',
    };
  });

  /* ---- reality ---- */
  const b = r.board;
  const reality = [
    { label: 'MEDIAN RETURN', value: signed(b.medianRetPct), color: tone(b.medianRetPct) },
    { label: 'WENT UP', value: pct(b.winRate), color: b.winRate == null ? DIM : b.winRate >= 0.5 ? POS : NEG },
    { label: 'BEST POINT', value: signed(b.medianMfePct), color: tone(b.medianMfePct) },
    { label: 'WORST POINT', value: signed(b.medianMaePct), color: tone(b.medianMaePct) },
    { label: 'RUG RATE', value: b.rugRate == null ? '—' : (b.rugRate * 100).toFixed(1) + '%',
      color: b.rugRate == null ? DIM : b.rugRate > 0.03 ? NEG : POS },
  ];

  const flagMax = Math.max(0.01, ...(r.flags || []).map((f) => Math.max(f.lossShare, f.winShare)));
  const flags = (r.flags || []).slice(0, 7).map((f) => ({
    key: f.code,
    name: f.code.replace(/_/g, ' '),
    loss: pct(f.lossShare),
    win: pct(f.winShare),
    lossW: (f.lossShare / flagMax) * 100 + '%',
    winW: (f.winShare / flagMax) * 100 + '%',
    rate: pct(f.lossRate),
    rateColor: f.lossRate > 0.55 ? NEG : f.lossRate < 0.45 ? POS : MUTED,
    picks: String(f.picks),
  }));

  return {
    outcome: {
      ready: true,
      // The admin mirror reads these rather than recomputing anything.
      report: r, sources: s, at: outcomes.at, horizonLabel: H, view,
      horizons, views,
      verdict: VERDICTS[r.verdict] || VERDICTS.COLLECTING,
      sentence, metrics, icBars,
      icRange: series.length ? utc(series[0].t) + ' → ' + utc(series[series.length - 1].t) + ' UTC' : '',
      total, segments, checks,
      tokens: { scored: s.journalTokens ?? 0, priced: s.priceTokens ?? 0 },
      firstCol: view === 'RANK' ? 'RANK IN MOMENT' : 'SCORE BAND',
      rows, reality, flags,
      flagNote: r.losers + ' did worse than the board, ' + r.winners + ' did better',
      minFlag: t.minFlag,
      foot: r.picks + ' predictions checked over ' + hWords(horizon) + ' · ' + r.moments + ' moments',
    },
  };
}

/* ================================================================= view == */

const CARD = 'background:#0a1226;border:1px solid #1c2a4d;border-radius:12px;padding:14px 16px;min-width:0';
const TITLE = 'font-size:9.5px;letter-spacing:1.3px;color:#8b96b8;font-weight:700;display:flex;align-items:center';
const ROWLINE = 'border-bottom:1px solid #16223f';
const TABLE = 'display:grid;grid-template-columns:150px minmax(140px,1fr) 64px 50px 60px 46px 60px 60px 46px 58px 40px;gap:0 10px;align-items:center';
const FLAGS = 'display:grid;grid-template-columns:minmax(100px,1.2fr) minmax(80px,1fr) 58px 64px 70px 30px;gap:0 8px;align-items:center';

function Segmented({ label, items, css, v }) {
  return (
    <div style={css('display:flex;align-items:center;gap:8px', { v })}>
      <span style={css(TITLE, { v })}>{label}{q(label)}</span>
      <div style={css('display:flex;background:#0d1730;border:1px solid #1c2a4d;border-radius:999px;padding:2px', { v })}>
        {items.map((it) => (
          <span
            key={it.label}
            onClick={it.pick}
            title={it.ready ? '' : 'not enough checked predictions at this window yet'}
            style={css('font-size:10px;font-weight:700;letter-spacing:.6px;padding:4px 12px;border-radius:999px;cursor:pointer;user-select:none;background:{{ x.bg }};color:{{ x.fg }}', {
              v, x: it.active ? { bg: '#2b6bff', fg: '#ffffff' } : { bg: 'transparent', fg: it.ready ? '#a3aed0' : '#4a5578' },
            })}
          >{it.label}</span>
        ))}
      </div>
    </div>
  );
}

function Header({ o, css, v }) {
  return (
    <div style={css('display:flex;align-items:flex-end;justify-content:space-between;gap:12px 24px;flex-wrap:wrap;margin-bottom:12px', { v })}>
      <div>
        <div style={css('font-size:9.5px;letter-spacing:1.4px;color:#6b7699;font-weight:700', { v })}>EVALUATION</div>
        <div style={css('font-size:17px;font-weight:700;color:#ffffff;margin-top:3px', { v })}>Does a higher score lead to a better outcome?</div>
      </div>
      {o.ready && <div style={css('display:flex;align-items:center;gap:18px;flex-wrap:wrap', { v })}>
        <Segmented label="TIME WINDOW" items={o.horizons} css={css} v={v} />
        <Segmented label="GROUP BY" items={o.views} css={css} v={v} />
      </div>}
    </div>
  );
}

function Answer({ o, css, v }) {
  return (
    <div style={css(CARD + ';flex:1;display:flex;flex-direction:column;gap:14px', { v })}>
      <div style={css(TITLE, { v })}>THE ANSWER{q('THE ANSWER')}</div>
      <div style={css('display:flex;align-items:center;gap:14px;flex-wrap:wrap', { v })}>
        <span style={css('display:flex;align-items:center', { v })}>
          <span style={css('font-size:13px;font-weight:800;letter-spacing:1px;padding:6px 12px;border-radius:8px;background:{{ b.bg }};color:{{ b.fg }}', { v, b: o.verdict })}>{o.verdict.text}</span>
          {q('VERDICT')}
        </span>
        <span style={css('flex:1;min-width:220px;font-size:13px;line-height:1.45;color:#dfe6f6', { v })}>{o.sentence}</span>
      </div>
      <div style={css('display:grid;grid-template-columns:repeat(3,1fr);gap:8px', { v })}>
        {o.metrics.map((m) => (
          <div key={m.label} style={css('background:#0d1730;border:1px solid #16223f;border-radius:10px;padding:9px 11px', { v })}>
            <div style={css(TITLE + ';font-size:8.5px', { v })}>{m.label}{q(m.label)}</div>
            <div style={css('font-size:20px;font-weight:700;color:{{ m.color }};margin-top:3px', { v, m })}>{m.value}</div>
            <div style={css('font-size:9.5px;color:#6b7699;margin-top:1px', { v })}>{m.sub}</div>
          </div>
        ))}
      </div>
      <div>
        <div style={css('display:flex;justify-content:space-between;align-items:center;margin-bottom:6px', { v })}>
          <span style={css(TITLE + ';font-size:8.5px', { v })}>RANK IC · EACH 15-MIN MOMENT{q('EACH MOMENT', 'RANK IC · EACH MOMENT')}</span>
          <span style={css('font-size:9.5px;color:#6b7699', { v })}>{o.icRange}</span>
        </div>
        {o.icBars.length ? (
          <div style={css('position:relative;height:46px;display:flex;gap:2px;background:#0d1730;border-radius:6px;padding:0 4px', { v })}>
            <div style={css('position:absolute;left:0;right:0;top:50%;height:1px;background:#2a3a63', { v })}></div>
            {o.icBars.map((bar) => (
              <div key={bar.key} title={bar.title} style={css('flex:1;max-width:26px;position:relative;height:100%', { v })}>
                <div style={css('position:absolute;left:0;right:0;top:{{ b.top }};height:{{ b.h }};min-height:1px;background:{{ b.color }};border-radius:1px', { v, b: bar })}></div>
              </div>
            ))}
          </div>
        ) : <div style={css('font-size:10.5px;color:#6b7699;padding:8px 0', { v })}>No moment has had 8 or more checked tokens yet.</div>}
      </div>
    </div>
  );
}

function Trust({ o, css, v }) {
  return (
    <div style={css(CARD + ';flex:1;display:flex;flex-direction:column;gap:12px', { v })}>
      <div style={css(TITLE, { v })}>HOW MUCH DATA{q('HOW MUCH DATA')}</div>
      <div>
        <div style={css('display:flex;align-items:baseline;gap:8px', { v })}>
          <span style={css('font-size:24px;font-weight:700;color:#ffffff', { v })}>{o.total}</span>
          <span style={css(TITLE + ';font-size:9px', { v })}>PREDICTIONS{q('PREDICTIONS')}</span>
        </div>
        <div style={css('display:flex;height:12px;border-radius:4px;overflow:hidden;background:#16223f;gap:2px;margin-top:8px', { v })}>
          {o.segments.filter((p) => p.n > 0).map((p) => (
            <div key={p.key} title={p.n + ' ' + p.label + ' (' + p.share + ')'} style={css('width:{{ p.w }};min-width:3px;background:{{ p.color }}', { v, p })}></div>
          ))}
        </div>
        <div style={css('display:flex;flex-direction:column;gap:5px;margin-top:9px', { v })}>
          {o.segments.map((p) => (
            <div key={p.key} style={css('display:flex;align-items:center;gap:7px;font-size:11px;color:#a3aed0', { v })}>
              <span style={css('width:8px;height:8px;border-radius:2px;background:{{ p.color }};flex:none', { v, p })}></span>
              <span style={css('display:flex;align-items:center', { v })}>{p.label}{q(p.label)}</span>
              <span style={css('flex:1;border-bottom:1px dotted #1c2a4d;margin:0 4px', { v })}></span>
              <b style={css('color:#dfe6f6', { v })}>{p.n}</b>
              <span style={css('width:34px;text-align:right;color:#6b7699', { v })}>{p.share}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={css('border-top:1px solid #16223f;padding-top:10px', { v })}>
        <div style={css(TITLE + ';font-size:8.5px;margin-bottom:6px', { v })}>READY TO JUDGE{q('READY TO JUDGE')}</div>
        {o.checks.map((c) => (
          <div key={c.label} style={css('display:flex;align-items:center;gap:7px;font-size:11px;color:{{ x.fg }};padding:2px 0', { v, x: { fg: c.ok ? '#c6d1ea' : '#8b96b8' } })}>
            <span style={css('width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;background:{{ x.bg }};color:#0a1226', { v, x: { bg: c.ok ? POS : '#2a3a63' } })}>{c.ok ? '✓' : ''}</span>
            {c.label}
          </div>
        ))}
      </div>
      <div style={css('border-top:1px solid #16223f;padding-top:10px;display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#a3aed0', { v })}>
        <span style={css(TITLE + ';font-size:8.5px', { v })}>TOKENS SCORED{q('TOKENS SCORED')}</span>
        <span><b style={css('color:#dfe6f6', { v })}>{o.tokens.scored}</b> <span style={css('color:#6b7699', { v })}>· {o.tokens.priced} with prices</span></span>
      </div>
    </div>
  );
}

function Evidence({ o, css, v }) {
  const head = (key, title, align) => (
    <div style={css('display:flex;align-items:center;white-space:nowrap;justify-content:{{ a }}', { v, a: align || 'flex-end' })}>{title || key}{q(key, title)}</div>
  );
  return (
    <div style={css(CARD, { v })}>
      <div style={css('display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap', { v })}>
        <div style={css(TITLE, { v })}>HOW EACH GROUP DID{q('HOW EACH GROUP DID')}</div>
        <div style={css('font-size:10px;color:#6b7699', { v })}>{o.foot}</div>
      </div>
      <div style={css('overflow-x:auto', { v })}>
        <div style={css('min-width:820px', { v })}>
          <div style={css(TABLE + ';' + ROWLINE + ';padding:0 0 7px;font-size:8.5px;letter-spacing:.8px;color:#6b7699;font-weight:700', { v })}>
            {head(o.firstCol, null, 'flex-start')}
            <div style={css('display:flex;align-items:center;justify-content:space-between', { v })}>
              <span>◀ WORSE</span><span style={css('display:flex;align-items:center', { v })}>vs BOARD{q('vs BOARD', 'THE BAR')}</span><span>BETTER ▶</span>
            </div>
            {head('EXCESS')}{head('BEAT')}{head('RAW')}{head('WIN')}{head('BEST')}{head('WORST')}{head('RUG')}{head('AVG SCORE', 'SCORE')}{head('N')}
          </div>
          {o.rows.map((r) => (
            <div key={r.key} style={css(TABLE + ';' + ROWLINE + ';padding:9px 0;font-size:11.5px;opacity:{{ r.opacity }}', { v, r })}>
              <div>{r.badge
                ? <span style={css('font-size:9.5px;font-weight:700;padding:3px 8px;border-radius:10px;white-space:nowrap;background:{{ b.bg }};color:{{ b.fg }}', { v, b: r.badge })}>{r.badge.text} · {r.label}</span>
                : <span style={css('color:#dfe6f6;font-weight:600', { v })}>{r.label}</span>}</div>
              <div style={css('height:14px;background:#101a33;border-radius:3px;position:relative', { v })}>
                <div style={css('position:absolute;top:0;bottom:0;left:{{ r.barLeft }};width:{{ r.barW }};background:{{ r.barColor }};border-radius:3px', { v, r })}></div>
                <div style={css('position:absolute;top:-3px;bottom:-3px;left:50%;width:1px;background:#3a4568', { v })}></div>
              </div>
              <div style={css('text-align:right;font-weight:700;color:{{ r.excessColor }}', { v, r })}>{r.excess}</div>
              <div style={css('text-align:right;color:{{ r.beatColor }}', { v, r })}>{r.beat}</div>
              <div style={css('text-align:right;color:#a3aed0', { v })}>{r.raw}</div>
              <div style={css('text-align:right;color:#a3aed0', { v })}>{r.win}</div>
              <div style={css('text-align:right;color:#a3aed0', { v })}>{r.best}</div>
              <div style={css('text-align:right;color:#a3aed0', { v })}>{r.worst}</div>
              <div style={css('text-align:right;color:{{ r.rugColor }}', { v, r })}>{r.rug}</div>
              <div style={css('text-align:right;color:#8b96b8', { v })}>{r.avg}</div>
              <div style={css('text-align:right;color:#6b7699', { v })}>{r.n}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Reality({ o, css, v }) {
  return (
    <div style={css(CARD, { v })}>
      <div style={css(TITLE + ';margin-bottom:12px', { v })}>IN PRICE{q('IN PRICE')}</div>
      {o.reality.map((m) => (
        <div key={m.label} style={css('display:flex;align-items:center;justify-content:space-between;padding:8px 0;' + ROWLINE, { v })}>
          <span style={css(TITLE + ';font-size:9px', { v })}>{m.label}{q(m.label)}</span>
          <span style={css('font-size:15px;font-weight:700;color:{{ m.color }}', { v, m })}>{m.value}</span>
        </div>
      ))}
    </div>
  );
}

function Flags({ o, css, v }) {
  return (
    <div style={css(CARD, { v })}>
      <div style={css('display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap', { v })}>
        <div style={css(TITLE, { v })}>WARNING FLAGS{q('WARNING FLAGS')}</div>
        <div style={css('font-size:10px;color:#6b7699', { v })}>{o.flagNote}</div>
      </div>
      {!o.flags.length
        ? <div style={css('font-size:11px;color:#6b7699;padding:6px 0', { v })}>No flag has appeared on {o.minFlag} or more checked predictions yet.</div>
        : <div style={css('overflow-x:auto', { v })}><div style={css('min-width:440px', { v })}>
          <div style={css(FLAGS + ';' + ROWLINE + ';padding:0 0 7px;font-size:8.5px;letter-spacing:.8px;color:#6b7699;font-weight:700', { v })}>
            <div>FLAG</div>
            <div></div>
            <div style={css('display:flex;align-items:center;justify-content:flex-end;white-space:nowrap;color:' + NEG, { v })}>LOSERS{q('LOSERS')}</div>
            <div style={css('display:flex;align-items:center;justify-content:flex-end;white-space:nowrap;color:' + POS, { v })}>WINNERS{q('WINNERS')}</div>
            <div style={css('display:flex;align-items:center;justify-content:flex-end;white-space:nowrap', { v })}>LOSS RATE{q('LOSS RATE')}</div>
            <div style={css('text-align:right', { v })}>N</div>
          </div>
          {o.flags.map((f) => (
            <div key={f.key} style={css(FLAGS + ';' + ROWLINE + ';padding:7px 0;font-size:11px', { v })}>
              <div style={css('color:#dfe6f6;text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', { v })} title={f.name}>{f.name.toLowerCase()}</div>
              <div style={css('display:flex;flex-direction:column;gap:2px', { v })}>
                <div style={css('height:5px;border-radius:2px;background:' + NEG + ';width:{{ f.lossW }}', { v, f })}></div>
                <div style={css('height:5px;border-radius:2px;background:' + POS + ';width:{{ f.winW }}', { v, f })}></div>
              </div>
              <div style={css('text-align:right;color:' + NEG, { v })}>{f.loss}</div>
              <div style={css('text-align:right;color:' + POS, { v })}>{f.win}</div>
              <div style={css('text-align:right;font-weight:700;color:{{ f.rateColor }}', { v, f })}>{f.rate}</div>
              <div style={css('text-align:right;color:#6b7699', { v })}>{f.picks}</div>
            </div>
          ))}
        </div></div>}
    </div>
  );
}

export default function Evaluation({ v, css }) {
  if (!v.isEval) return null;
  const o = v.outcome || {};
  return (
    <div data-screen-label="Evaluation" style={css('flex:1;overflow:auto;padding:14px 16px;min-height:0', { v })}>
      <Header o={o} css={css} v={v} />
      {!o.ready ? (
        <div style={css(CARD + ';font-size:12px;color:#6b7699;padding:28px 16px;text-align:center', { v })}>{o.note}</div>
      ) : (
        <div style={css('display:flex;flex-direction:column;gap:12px', { v })}>
          <div style={css('display:flex;flex-wrap:wrap;gap:12px;align-items:stretch', { v })}>
            <div style={css('flex:2 1 520px;min-width:0;display:flex;flex-direction:column', { v })}><Answer o={o} css={css} v={v} /></div>
            <div style={css('flex:1 1 280px;min-width:0;display:flex;flex-direction:column', { v })}><Trust o={o} css={css} v={v} /></div>
          </div>
          <Evidence o={o} css={css} v={v} />
          <div style={css('display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px', { v })}>
            <Reality o={o} css={css} v={v} />
            <Flags o={o} css={css} v={v} />
          </div>
        </div>
      )}
    </div>
  );
}
