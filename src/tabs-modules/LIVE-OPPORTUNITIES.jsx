import React from 'react';
import TokenRail from '../components/TokenRail';
import AssetBar from '../components/AssetBar';
import ScoreHistoryChart from '../components/ScoreHistoryChart';
import { signalInfo, phaseColor, PHASE_ORDER } from '../utils/formatters';
import { modelEval, engineGrade, engineWindows, engineExitGrade } from '../services/model-eval';
import { PHASE_RULES, ENGINES, TIME_FRAMES, DEFAULT_HOLD_HOURS, TRADE_SIZES, DEFAULT_TRADE_USD } from '../flow/score-flow';
import { phaseRules, activeEngine } from '../flow/params';
import { getSetting, setSetting, clearSetting } from '../admin/box-settings';
import { useMobile } from '../utils/useMobile';

/** True inside the phone layout: windows size to their content instead of the viewport. */
const MobileCtx = React.createContext(false);

/**
 * LIVE OPPORTUNITIES - the dashboard.
 *
 * The token list sits on the left; the token selected there fills four
 * windows on the right, every value read from the model (flow/score-flow.js):
 *
 *   DETAIL         price & EARLY chart · the SIGNAL and its reason · the
 *                  attention-cycle track · warnings
 *   CYCLE          where the price sits in its burst, against the thresholds
 *                  the PHASE is drawn with
 *   TRADE PLAN     entry, target, stop and horizon · how this signal has
 *                  graded · what moves EARLY
 *   SAFETY & FLOW  the safety gates · smart money · flow, impact, organic
 *                  flow and wallet quality · Social, Wallets and Rotation
 *                  one click away
 *
 * Colour carries one meaning everywhere: blue = in / helping / buying, pink =
 * out / holding back / selling, and status colours (green / amber / red) only
 * ever for a verdict, always next to its word. On a desktop the page never
 * scrolls.
 *
 * On a phone (utils/useMobile) it is two screens instead: the token list, and
 * - after a tap - that token's screen, the same four windows stacked full
 * width and scrolling, with a back bar on top. The browser's back button
 * returns to the list.
 */

const C = {
  card: '#0a1226', line: '#16223f', track: '#16223f', mid: '#8b96b8', dim: '#6b7699', faint: '#3a4568',
  text: '#dfe6f6', white: '#ffffff', up: '#4d8dff', down: '#ff4fae',
  good: '#3ddc97', warn: '#ffb454', bad: '#ff4d5e',
};
const CAP = { fontSize: 9, letterSpacing: 1.2, color: C.mid, fontWeight: 700 };
const SMALL_CAP = { fontSize: 7.5, letterSpacing: 0.9, color: C.dim, fontWeight: 700 };

function fmtUsd(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  const s = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : String(Math.round(a));
  return '$' + s;
}

/* ------------------------------------------------------------ primitives -- */

function Win({ title, onOpen, children, style }) {
  const mobile = React.useContext(MobileCtx);
  return (
    <div style={{
      background: C.card, border: '1px solid #1c2a4d', borderRadius: mobile ? 14 : 10,
      display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: mobile ? undefined : 0, overflow: 'hidden', ...style,
      ...(mobile ? { gridColumn: undefined, flexShrink: 0 } : null)
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: mobile ? '10px 12px 10px 14px' : '7px 10px 7px 12px', borderBottom: '1px solid ' + C.line, flexShrink: 0 }}>
        <span style={mobile ? { ...CAP, fontSize: 11 } : CAP}>{title}</span>
        <span style={{ flex: 1 }} />
        <div className="hf6f5791f" onClick={onOpen} title={'Open the full ' + title + ' view'} style={{
          padding: mobile ? '7px 13px' : '3px 10px', borderRadius: 999, border: '1px solid #2b3a60', color: '#b6c2de',
          fontSize: mobile ? 11 : 9, fontWeight: 700, letterSpacing: 0.6, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0
        }}>DETAILS ⤢</div>
      </div>
      {/* On a phone the body text is scaled up a step (zoom) so the 9-10px
          desktop type reads at 11-12px; the chart is kept out of it, since a
          zoomed canvas misplaces its own crosshair. */}
      <div style={mobile
        ? { padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 12 }
        : { flex: 1, minHeight: 0, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

/** Wraps phone-layout text blocks in the type-size step described in Win. */
function Readable({ children, style }) {
  const mobile = React.useContext(MobileCtx);
  if (!mobile) return children;
  return <div style={{ zoom: 1.2, display: 'flex', flexDirection: 'column', gap: 10, ...style }}>{children}</div>;
}

function Note({ children }) {
  return <div style={{ fontSize: 10, color: C.dim, lineHeight: 1.5, overflow: 'hidden' }}>{children}</div>;
}

/** The window's answer: a big value and the word that explains it. */
function Headline({ value, word, color, label, title }) {
  return (
    <div title={title || ''} style={{ flexShrink: 0 }}>
      {label && <div style={SMALL_CAP}>{label}</div>}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        {value != null && <span style={{ fontSize: 26, fontWeight: 800, lineHeight: 1.1, color }}>{value}</span>}
        {word && <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: 0.8, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{word}</span>}
      </div>
    </div>
  );
}

/**
 * A 0..max track split into named zones, with a white marker at the value.
 * The zone the value is in is drawn solid; the rest stay faint, so the eye
 * lands on "where it is" before reading any label.
 */
function Meter({ value, max = 100, zones, height = 8 }) {
  const at = Number.isFinite(value) ? Math.min(Math.max(value / max, 0), 1) * 100 : null;
  let from = 0;
  return (
    <div style={{ flexShrink: 0 }}>
      <div style={{ position: 'relative', height, display: 'flex', gap: 2 }}>
        {zones.map((z, i) => {
          const start = from; from = z.to;
          const inZone = at != null && at >= (start / max) * 100 && (at < (z.to / max) * 100 || i === zones.length - 1);
          return <div key={i} style={{ flex: (z.to - start), background: z.color, opacity: inZone ? 1 : 0.22, borderRadius: i === 0 ? '4px 0 0 4px' : i === zones.length - 1 ? '0 4px 4px 0' : 0 }} />;
        })}
        {at != null && (
          <div style={{ position: 'absolute', top: -3, bottom: -3, width: 3, borderRadius: 2, background: C.white,
            left: 'calc(' + at + '% - 1.5px)', boxShadow: '0 0 0 2px ' + C.card }} />
        )}
      </div>
      <div style={{ display: 'flex', gap: 2, marginTop: 3 }}>
        {zones.map((z, i) => (
          <span key={i} style={{ flex: z.to - (i ? zones[i - 1].to : 0), fontSize: 7.5, letterSpacing: 0.5, color: C.dim, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}>{z.label}</span>
        ))}
      </div>
    </div>
  );
}

/** A verdict: icon + word in a status colour. Never colour alone. */
function Status({ kind, children, title }) {
  const s = { good: [C.good, '✓'], warn: [C.warn, '!'], bad: [C.bad, '✕'], none: [C.dim, '·'] }[kind] || [C.dim, '·'];
  return (
    <span title={title || ''} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 9.5, fontWeight: 600, color: C.text,
      padding: '3px 9px 3px 4px', borderRadius: 999, background: '#101c38', whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden'
    }}>
      <span style={{ width: 14, height: 14, borderRadius: '50%', background: s[0], color: '#081736', fontSize: 9, fontWeight: 900, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s[1]}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{children}</span>
    </span>
  );
}

/** Small horizontal bars of one quantity, one hue - longer is more. */
function Bars({ rows, color = C.up, labelWidth = 70 }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0, overflow: 'hidden' }}>
      {rows.map((r) => (
        <div key={r.key} title={r.title || ''} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: labelWidth, flexShrink: 0, fontSize: 9.5, color: '#a3aed0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
          <div style={{ flex: 1, height: 8, minWidth: 0 }}>
            <div style={{ width: Math.max((r.value / max) * 100, 2) + '%', height: '100%', background: r.color || color, borderRadius: '0 4px 4px 0' }} />
          </div>
          {r.end != null && <span style={{ width: 34, textAlign: 'right', fontSize: 9, color: C.mid, flexShrink: 0 }}>{r.end}</span>}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- DETAIL -- */


/**
 * The attention cycle as five steps, the token's step lit. Reads left to
 * right the way a meme's burst runs: quiet, waking, running, peaking, fading.
 */
function PhaseTrack({ phase }) {
  return (
    <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
      {PHASE_ORDER.map((p) => {
        const on = p === phase;
        return (
          <div key={p} style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
            <div style={{ height: 6, borderRadius: 3, background: on ? phaseColor(p) : C.track, opacity: on ? 1 : 0.7 }} />
            <div style={{ fontSize: 7, letterSpacing: 0.6, fontWeight: 700, marginTop: 3, color: on ? phaseColor(p) : C.faint,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p}</div>
          </div>
        );
      })}
    </div>
  );
}

function DetailWin({ v }) {
  const mobile = React.useContext(MobileCtx);
  const d = v.d || {};
  const sig = signalInfo(d.signal);
  const flags = d.flags || [];
  const sevKind = (sev) => (sev === 'HIGH' ? 'bad' : sev === 'MED' ? 'warn' : 'none');
  return (
    <Win title="DETAIL" onOpen={v.openPopup.detail} style={{ gridColumn: '1 / -1' }}>
      <div style={mobile
        ? { display: 'flex', flexDirection: 'column-reverse', gap: 14 }
        : { flex: 1, minHeight: 0, display: 'flex', gap: 16 }}>
        <div style={mobile ? { height: 360, minWidth: 0 } : { flex: 1.75, minWidth: 0, minHeight: 0 }}>
          {d.chartPool
            ? <ScoreHistoryChart compact chain={d.chartChain} pool={d.chartPool} token={d.chartToken} />
            : <Note>No pool to chart for this token yet.</Note>}
        </div>

        <Readable>
        <div style={mobile
          ? { display: 'flex', flexDirection: 'column', gap: 10 }
          : { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, borderLeft: '1px solid ' + C.line, paddingLeft: 16 }}>
          {/* The model's call (flow/score-flow.js SIGNAL and PHASE). */}
          <Headline label="SIGNAL" value={d.signal || '—'} word={d.phase || 'NO PHASE YET'}
            color={sig.fg} title={(d.signalWhy || sig.text) + (d.phaseWhy ? '\n' + d.phaseWhy : '')} />
          <PhaseTrack phase={d.phase} />
          <div style={{ fontSize: 10, color: C.text, lineHeight: 1.4 }}>
            {d.signalWhy || sig.text}{d.phaseWhy ? <span style={{ color: C.dim }}> · {d.phaseWhy}</span> : null}
          </div>
          <div style={{ display: 'flex', gap: 10, fontSize: 9, color: C.dim, flexWrap: 'wrap' }}>
            <span>EARLY <b style={{ color: C.white }}>{Number.isFinite(d.early) ? d.early : '—'}</b></span>
            <span>smart buyers 1h <b style={{ color: C.white }}>{Number.isFinite(d.smartBuyers) ? d.smartBuyers : '—'}</b></span>
            <span>smart sellers 1h <b style={{ color: C.white }}>{Number.isFinite(d.smartSellers) ? d.smartSellers : '—'}</b></span>
            <span>perp <b style={{ color: C.white }}>{d.shortable === true ? 'listed' : d.shortable === false ? 'none' : '—'}</b></span>
          </div>


          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 'auto' }}>
            {flags.length
              ? flags.slice(0, 2).map((f, i) => <Status key={i} kind={sevKind(f.sev)} title={f.sev + ' · ' + f.text}>{f.text}</Status>)
              : <Status kind="good">No risk flags</Status>}
            {flags.length > 2 && <span style={{ fontSize: 9, color: C.dim, alignSelf: 'center' }}>+{flags.length - 2} more</span>}
          </div>
        </div>
        </Readable>
      </div>
    </Win>
  );
}

/* ----------------------------------------------------------------- CYCLE -- */

/**
 * Where the token sits in its attention burst - the measures PHASE is made
 * of, drawn against the thresholds PHASE uses (the same PARAMETERS boxes).
 */
function CycleWin({ v }) {
  const d = v.d || {};
  const m = d.measures || {};
  const r = phaseRules(PHASE_RULES);
  const up = m.aboveLow6hPct; const off = m.belowHigh6hPct; const range = m.range1hPct;
  const span = Math.max(r.runPct * 1.4, Number.isFinite(up) ? up * 1.1 : 0);
  const zones = [
    { to: r.runningPct, color: phaseColor('WAKING'), label: 'WAKING' },
    { to: r.runPct, color: phaseColor('RUNNING'), label: 'RUNNING' },
    { to: span, color: phaseColor('PEAKING'), label: 'RAN' },
  ];
  const pct = (x, dp = 1) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(dp) + '%' : '—');
  const mult = (x) => (Number.isFinite(x) ? x.toFixed(2) + '×' : '—');
  return (
    <Win title="CYCLE" onOpen={v.openPopup.detail}>
      <Readable>
      {!Number.isFinite(up) ? <Note>Needs an hour of price history to place it on its cycle.</Note> : (<>
        <Headline label="ABOVE ITS 6H LOW" value={pct(up)} word={d.phase || ''} color={phaseColor(d.phase)}
          title={d.phaseWhy || ''} />
        <Meter value={Math.min(up, span)} max={span} zones={zones} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: C.dim }}>
          <span>low</span><span>runs at {pct(r.runningPct, 0)}</span><span>has run at {pct(r.runPct, 0)}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', fontSize: 10 }}>
          <div><div style={SMALL_CAP}>FROM 6H HIGH</div><b style={{ color: Number.isFinite(off) && off <= -r.fadeOffHighPct ? C.bad : C.text }}>{pct(off)}</b></div>
          <div><div style={SMALL_CAP}>LAST HOUR RANGE</div><b style={{ color: Number.isFinite(range) && range < r.quietRangePct ? C.dim : C.text }}>{pct(range, 2).replace('+', '')}</b></div>
          <div><div style={SMALL_CAP}>VOLUME 15M vs 1H</div><b style={{ color: C.text }}>{mult(m.volAccel)}</b></div>
          <div><div style={SMALL_CAP}>BUYERS 1H vs 6H</div><b style={{ color: C.text }}>{mult(m.buyerTrend)}</b></div>
        </div>
        <div style={{ fontSize: 9.5, color: C.dim, lineHeight: 1.4, marginTop: 'auto' }}>{d.phaseWhy || ''}</div>
      </>)}
      </Readable>
    </Win>
  );
}

/* ------------------------------------------------------------ TRADE PLAN -- */

/**
 * The trade the signal is graded on, and how that signal has actually done:
 * the report card (/raw/model-eval.json) for this call, against every token
 * taken the same way.
 */
function PlanWin({ v }) {
  const d = v.d || {};
  const p = d.plan;
  const sig = signalInfo(d.signal);
  const report = modelEval();
  const side = report && report.signalSide ? report.signalSide[d.signal] : null;
  const graded = report && report.signals && d.signal && side ? (report.signals[d.signal] || {})[side] : null;
  const g = graded ? graded.swing || graded.fast : null;
  const base = report && report.everyone && side ? (report.everyone[side].swing || report.everyone[side].fast) : null;
  const px = (n) => (Number.isFinite(n) ? '$' + (n >= 1 ? n.toFixed(4) : n.toPrecision(4)) : '—');
  const pc = (x) => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) + '%' : '—');
  const earlyRows = (d.earlyParts || []).filter((x) => !x.pending && Number.isFinite(x.value))
    .map((x) => ({ key: x.key, label: x.label, value: x.value, end: x.value, color: x.value >= 60 ? C.good : x.value >= 35 ? C.warn : C.bad,
      title: x.label + ' ' + x.value + '/100 · weight ' + x.weight }));
  // THE TIME FRAME: how long the call is held (the DATA FLOW's HORIZON box,
  // flow/score-flow.js tradePlanRules). AUTO is DEFAULT_HOLD_HOURS for every
  // engine. Each chip's number: the active engine's BUY entries held that
  // long, minus every token over the same hours (npm run backtest, holds).
  const engKey = activeEngine();
  const chosen = getSetting('param:plan.horizonHours', { n: null }).n;
  const hours = Number.isFinite(chosen) ? chosen : DEFAULT_HOLD_HOURS;
  const wins = engineWindows(engKey) || {};
  // THE TRADE SIZE: what the plan and EXECUTION COST are figured at (param:plan.tradeUsd).
  const sizeSet = getSetting('param:plan.tradeUsd', { n: null }).n;
  const tradeUsd = Number.isFinite(sizeSet) ? sizeSet : DEFAULT_TRADE_USD;
  const eg = engineGrade(engKey, hours, tradeUsd);
  const xg = d.signal === 'SELL' || d.signal === 'SHORT' ? engineExitGrade(engKey, hours) : null;
  const engLabel = (ENGINES.find((e) => e.key === engKey) || ENGINES[0]).label;
  const usdShort = (n) => '$' + (n >= 1000 ? n / 1000 + 'K' : n);
  const tfChip = (label, h, on, title, settingId = 'param:plan.horizonHours') => (
    <span key={label} title={title} onClick={() => { if (h === null) clearSetting(settingId); else setSetting(settingId, { n: h }); }}
      style={{ cursor: 'pointer', fontSize: 8.5, fontWeight: 700, padding: '2px 6px', borderRadius: 5,
        border: `1px solid ${on ? '#4dd0e1' : '#1c2a4d'}`, background: on ? 'rgba(77,208,225,0.16)' : '#0a1226', color: on ? '#4dd0e1' : C.dim }}>{label}</span>
  );
  return (
    <Win title="TRADE PLAN" onOpen={v.openPopup.detail}>
      <Readable>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <span style={{ ...SMALL_CAP, marginRight: 2 }}>TIME FRAME</span>
        {tfChip('AUTO · ' + DEFAULT_HOLD_HOURS + 'H', null, !Number.isFinite(chosen), 'The same ' + DEFAULT_HOLD_HOURS + 'h window for every engine - it held up best on unseen hours.')}
        {TIME_FRAMES.map((f) => {
          const w = wins[f.hours + 'h'];
          return tfChip(f.hours + 'H', f.hours, chosen === f.hours, (w ? engLabel + ' BUY entries held ' + f.hours + 'h: ' + pc(w.avg) + ' vs every token, ' + Math.round(w.win) + '% won (' + w.n + ')' : 'not graded yet') + ' · target +' + f.targetPct + '% / stop −' + f.stopPct + '%');
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        <span style={{ ...SMALL_CAP, marginRight: 2 }}>TRADE SIZE</span>
        {TRADE_SIZES.map((x) => {
          const g = engineGrade(engKey, hours, x);
          return tfChip(usdShort(x) + (x === DEFAULT_TRADE_USD ? ' (default)' : ''), x === DEFAULT_TRADE_USD && !Number.isFinite(sizeSet) ? null : x, tradeUsd === x,
            (g ? engLabel + ' BUY entries held ' + hours + 'h, after the round trip at ' + usdShort(x) + ': ' + pc(g.avg) + ', ' + Math.round(g.win) + '% won (' + g.n + ')' : 'not graded yet') +
            '. A BUY needs the round trip at or under the cost cap.', 'param:plan.tradeUsd');
        })}
      </div>
      {p ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 10 }}>
          <div><div style={SMALL_CAP}>{p.side}</div><b style={{ color: sig.fg }}>{px(p.entry)}</b></div>
          <div><div style={SMALL_CAP}>TARGET</div><b style={{ color: C.good }}>{px(p.target)}</b></div>
          <div><div style={SMALL_CAP}>STOP</div><b style={{ color: C.bad }}>{px(p.stop)}</b></div>
          <div><div style={SMALL_CAP}>WITHIN</div><b style={{ color: C.text }}>{p.horizonHours}h</b></div>
        </div>
      ) : null}
      {p && Number.isFinite(p.costPct) ? (
        <div style={{ fontSize: 9.5, color: C.mid }} title={'EXECUTION COST on the DATA FLOW: ' + (p.costBasis === 'quote' ? 'from this token\'s real $10K route quote, scaled to the size' : 'from pool depth (no route quote yet), calibrated on real quotes') + ', plus 0.6% fees'}>
          Round trip at {usdShort(p.tradeUsd)}: <b style={{ color: p.costPct <= 1 ? C.good : p.costPct <= 2 ? C.warn : C.bad }}>{p.costPct.toFixed(2)}%</b>
          {' '}({p.costBasis === 'quote' ? 'real quote' : 'depth estimate'}) · the target has to clear this first
        </div>
      ) : null}
      {p ? null : <Note>{d.signal ? d.signal + ' is not a trade: ' + (d.signalWhy || '') : 'No call yet.'}</Note>}
      {d.signal === 'BUY' && eg ? (
        <div title={'BUY entries of ' + engLabel + ' held ' + hours + 'h - see Evaluation'} style={{ fontSize: 9.5, color: C.mid, lineHeight: 1.45 }}>
          <span style={{ color: sig.fg, fontWeight: 800 }}>{engLabel} BUY</span> held {hours}h has graded{' '}
          <b style={{ color: eg.avg > (eg.board ? eg.board.avg : 0) ? C.good : C.bad }}>{pc(eg.avg)}</b>{eg.net ? ' after a ' + usdShort(tradeUsd) + ' round trip' : ''}, {Math.round(eg.win)}% won ({eg.n.toLocaleString()} entries)
          {eg.board ? ' · every token: ' + pc(eg.board.avg) + ', ' + Math.round(eg.board.win) + '%' : ''}
        </div>
      ) : xg ? (
        <div title={engLabel + ' SELL / SHORT calls taken as a short and held ' + hours + 'h - see Evaluation'} style={{ fontSize: 9.5, color: C.mid, lineHeight: 1.45 }}>
          <span style={{ color: sig.fg, fontWeight: 800 }}>{engLabel} {d.signal}</span> as a short held {hours}h has graded{' '}
          <b style={{ color: xg.avg >= 0 ? C.good : C.bad }}>{pc(xg.avg)}</b>, {Math.round(xg.win)}% won ({xg.n.toLocaleString()} calls)
          {Number.isFinite(xg.vsMarket) ? ' · ' + pc(xg.vsMarket) + ' vs every token' : ''}
        </div>
      ) : g ? (
        <div title={'From ' + report.moments.toLocaleString() + ' graded moments - see Evaluation'} style={{ fontSize: 9.5, color: C.mid, lineHeight: 1.45 }}>
          <span style={{ color: sig.fg, fontWeight: 800 }}>{d.signal}</span> has graded{' '}
          <b style={{ color: g.avgPct > (base ? base.avgPct : 0) ? C.good : C.bad }}>{pc(g.avgPct)}</b> over {graded.swing ? '24h' : '6h'},{' '}
          {Math.round(g.winPct)}% won ({g.n.toLocaleString()} calls){base ? ' · every token: ' + pc(base.avgPct) + ', ' + Math.round(base.winPct) + '%' : ''}
        </div>
      ) : <div style={{ fontSize: 9.5, color: C.dim }}>No grading for this call yet - run the backtest (Evaluation).</div>}
      <div style={{ ...SMALL_CAP, marginTop: 2 }}>WHAT MOVES THE ENTRY · EARLY {Number.isFinite(d.early) ? d.early : '—'}</div>
      {earlyRows.length ? <Bars rows={earlyRows} labelWidth={92} /> : <Note>Not enough price history for EARLY yet.</Note>}
      </Readable>
    </Win>
  );
}

/* --------------------------------------------------------- SAFETY & FLOW -- */

/** Can it be traded safely, and who is moving it - the gates and the flow. */
function SafetyWin({ v }) {
  const d = v.d || {};
  const m = d.measures || {};
  const gates = d.gateChecks || [];
  const n = (x, dp = 0) => (Number.isFinite(x) ? x.toFixed(dp) : '—');
  const flow = m.netFlow;
  const more = [['SOCIAL', v.openPopup.social], ['WALLETS', v.openPopup.wallets], ['ROTATION', v.openPopup.rotation]].filter(([, go]) => go);
  return (
    <Win title="SAFETY & FLOW" onOpen={v.openPopup.wallets}>
      <Readable>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {gates.length ? gates.map((g) => (
          <Status key={g.key} kind={g.ok === true ? 'good' : g.ok === false ? 'bad' : 'none'} title={g.detail || ''}>
            {g.label.toLowerCase()}{g.ok === null ? ' · not checked' : ''}
          </Status>
        )) : <Note>Safety not checked yet.</Note>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', fontSize: 10 }}>
        <div><div style={SMALL_CAP}>SMART BUYERS 1H</div><b style={{ color: C.text }}>{n(d.smartBuyers)}</b></div>
        <div><div style={SMALL_CAP}>SMART SELLERS 1H</div><b style={{ color: (d.smartSellers || 0) >= 2 ? C.bad : C.text }}>{n(d.smartSellers)}</b></div>
        <div><div style={SMALL_CAP}>NET FLOW</div><b style={{ color: Number.isFinite(flow) ? (flow >= 0 ? C.up : C.down) : C.dim }}>{Number.isFinite(flow) ? (flow >= 0 ? '+' : '') + (flow * 100).toFixed(0) + '%' : '—'}</b></div>
        <div><div style={SMALL_CAP}>$10K IMPACT</div><b style={{ color: Number.isFinite(d.impactPct) && d.impactPct > 2 ? C.warn : C.text }}>{Number.isFinite(d.impactPct) ? d.impactPct.toFixed(2) + '%' : '—'}</b></div>
        <div><div style={SMALL_CAP}>ORGANIC FLOW</div><b style={{ color: Number.isFinite(d.organicScore) && d.organicScore < 40 ? C.bad : C.text }}>{n(d.organicScore)}</b></div>
        <div><div style={SMALL_CAP}>WALLET QUALITY</div><b style={{ color: C.text }}>{n(d.walletQualityScore)}</b></div>
      </div>
      {more.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 'auto', alignItems: 'center' }}>
          <span style={{ ...SMALL_CAP, marginRight: 2 }}>MORE</span>
          {more.map(([label, go]) => (
            <span key={label} className="hf6f5791f" onClick={go} style={{ padding: '3px 9px', borderRadius: 999, border: '1px solid #2b3a60',
              color: '#b6c2de', fontSize: 9, fontWeight: 700, letterSpacing: 0.5, cursor: 'pointer' }}>{label} ⤢</span>
          ))}
        </div>
      )}
      </Readable>
    </Win>
  );
}

/* ------------------------------------------------------------------ page -- */

/** The phone token screen's top bar: back to the list, the token, its call. */
function MobileTokenBar({ v, onBack }) {
  const d = v.d || {};
  const sig = signalInfo(d.signal);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px 10px 6px', background: '#0a1226',
      borderBottom: '1px solid #1c2a4d', flexShrink: 0
    }}>
      <button type="button" onClick={onBack} aria-label="Back to the token list" style={{
        display: 'flex', alignItems: 'center', gap: 4, height: 40, padding: '0 10px 0 6px', background: 'none',
        border: 'none', color: '#6ea0ff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0
      }}>
        <svg width="10" height="16" viewBox="0 0 10 16"><path d="M8 2L2 8l6 6" fill="none" stroke="#6ea0ff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Tokens
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, fontWeight: 800, color: C.white, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.sym || '—'}</div>
        <div style={{ fontSize: 10.5, color: C.mid, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name || ''}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }} title={d.signalWhy || ''}>
        <div style={{ fontSize: 9, letterSpacing: 1, fontWeight: 700, color: phaseColor(d.phase) }}>{d.phase || 'NO PHASE YET'}</div>
        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: 0.8, color: sig.fg }}>{d.signal || '—'}</div>
      </div>
    </div>
  );
}

/**
 * The phone layout: the list, or one token's screen. Opening a token pushes a
 * history entry, so the system back gesture returns to the list instead of
 * leaving the app.
 */
function MobileLive({ v }) {
  const [view, setView] = React.useState('list');
  const scrollRef = React.useRef(null);
  React.useEffect(() => {
    const onPop = () => setView('list');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const openToken = () => {
    if (view !== 'token') window.history.pushState({ vsToken: true }, '');
    setView('token');
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };
  const back = () => {
    if (window.history.state && window.history.state.vsToken) window.history.back();
    else setView('list');
  };

  if (view === 'list' || !v.hasSelection) {
    return (
      <div data-screen-label="Live opportunities" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <TokenRail v={v} mobile onPick={openToken} />
      </div>
    );
  }
  return (
    <MobileCtx.Provider value>
      <div data-screen-label="Live opportunities" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <MobileTokenBar v={v} onBack={back} />
        <div ref={scrollRef} style={{
          flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
          padding: '12px 12px calc(16px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 12
        }}>
          <DetailWin v={v} />
          <CycleWin v={v} />
          <PlanWin v={v} />
          <SafetyWin v={v} />
        </div>
      </div>
    </MobileCtx.Provider>
  );
}

export default function LiveOpportunities({ v }) {
  const mobile = useMobile();
  if (!v.isLive) return false;
  if (mobile) return <MobileLive v={v} />;
  return (
    <div data-screen-label="Live opportunities" style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      <TokenRail v={v} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {v.hasSelection ? (<>
          <AssetBar v={v} />
          <div style={{
            flex: 1, minHeight: 0, display: 'grid', gap: 10, padding: '10px 14px 12px',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gridTemplateRows: 'minmax(0, 1.3fr) minmax(0, 1fr)'
          }}>
            {/* The call on top; under it the three things a buy or sell rests on.
                Social, wallets and rotation stay one click away (SAFETY & FLOW). */}
            <DetailWin v={v} />
            <CycleWin v={v} />
            <PlanWin v={v} />
            <SafetyWin v={v} />
          </div>
        </>) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: '#6b7699' }}>
            {(v.rows || []).length ? 'Pick a token from the list.' : 'Waiting for the board to load…'}
          </div>
        )}
      </div>
    </div>
  );
}
