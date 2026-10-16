import React from 'react';
import { fetchChartHistory, CHART_RANGES } from '../services/api';
import { EARLY_MODEL } from '../flow/score-flow';

const PriceChart = React.lazy(() => import('./PriceChart'));

/**
 * Price and score on one time axis.
 *
 * Candles are the raw store's bars (minute bars for 1H/6H, the collector's
 * 15-minute bars for 24H/7D). The lines are our own scores from the score
 * trail - the settled average, this poll's number, and any of the components
 * behind it - on a fixed 0-100 scale on the left. The point is to look back
 * and ask whether what we scored came before what the price did.
 *
 * Scores only exist for hours the app was open; bars exist for the whole
 * range. So the lines can start later, or have holes, where the candles do
 * not - the caption says how much of the range the trail covers.
 */

// The trail's two headline columns (services/score-trail.js): EARLY as the
// model scored it, and EARLY RAW - the same before the safety gates.
const AVG = { key: '__avg', label: 'EARLY', color: '#f06ee2', width: 2 };
const NOW = { key: '__now', label: 'EARLY before safety', color: '#c9a2ff', width: 1, dashed: true };

// Fourteen components need fourteen hues that stay apart on a near-black
// surface. Grouped loosely: flow (blues), market (greens), holders/wallets
// (ambers), confirmation (teals), quality (greys/violets).
const PALETTE = {
  earlyRoom: '#3ddc97', earlyWaking: '#4d8dff', earlySeasoning: '#ffb454', earlyHolding: '#ff8a5c',
  earlyInterest: '#4fc3f7', earlyHolders: '#b38bff', earlyRepeat: '#a3aed0',
};

const COMPONENTS = EARLY_MODEL.map((c) => ({
  key: c.key, label: c.label, color: PALETTE[c.key] || '#a3aed0', weight: c.weight,
}));

const PREF_KEY = 'vs_chart_prefs';
function loadPrefs() {
  try { return JSON.parse(window.localStorage.getItem(PREF_KEY)) || null; } catch (e) { return null; }
}
function savePrefs(p) {
  try { window.localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch (e) { /* a convenience only */ }
}

const REFRESH_MS = 30000;

const NOTES = {
  not_collected: 'No price recorded for this pool yet — the collector is fetching its candles now',
  local_history: 'Drawn from our own recorded prices (every minute since the token reached our board) until GeckoTerminal candles arrive',
};

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 90) return m + 'm';
  const h = Math.round(m / 60);
  return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
}

/**
 * `compact` is the dashboard window: no card of its own (the window is the
 * card), the chart fills whatever height the window leaves it, and the line
 * toggles shrink to one tight block under it.
 *
 * `touch` (with compact) is the phone layout: a fixed-height plot with the
 * toggles flowing below it at finger size, instead of sharing one height.
 */
export default function ScoreHistoryChart({ chain, pool, token, height = 360, compact = false, touch = false }) {
  const saved = React.useMemo(loadPrefs, []);
  const [range, setRange] = React.useState((saved && saved.range) || '6H');
  const [shown, setShown] = React.useState(() => new Set((saved && saved.shown) || [AVG.key]));
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => { savePrefs({ range, shown: [...shown] }); }, [range, shown]);

  React.useEffect(() => {
    if (!chain || !pool) return undefined;
    let alive = true;
    let timer = null;
    const load = () => {
      fetchChartHistory(chain, pool, token, range).then((d) => {
        if (!alive) return;
        setData(d);
        setLoading(false);
        timer = setTimeout(load, REFRESH_MS);
      }).catch(() => { if (alive) { setLoading(false); timer = setTimeout(load, REFRESH_MS); } });
    };
    setLoading(true);
    setData(null);
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [chain, pool, token, range]);

  const marks = React.useMemo(() => (data && data.trail && data.trail.marks) || [], [data]);
  const bars = React.useMemo(() => (data && data.bars) || [], [data]);
  const hasVolume = React.useMemo(() => bars.some((b) => Number.isFinite(b && b.v) && b.v > 0), [bars]);
  // The chart spaces points by INDEX, not by time: every distinct timestamp
  // gets one slot. Minute score marks between 15-minute candles would each
  // take a candle's width and stretch the axis. So marks are snapped onto the
  // candle grid - one value per candle, the last score seen inside it (an
  // observed value, never an average).
  const bucketMs = data && data.interval === '15-MIN' ? 900000 : 60000;
  const lines = React.useMemo(() => {
    const snap = (get) => {
      const byBucket = new Map();
      marks.forEach((m) => {
        const v = get(m);
        if (v != null && Number.isFinite(v)) byBucket.set(Math.floor(m.t / bucketMs) * bucketMs, v);
      });
      return [...byBucket.entries()].map(([t, v]) => ({ t, v }));
    };
    const out = [];
    if (shown.has(AVG.key)) out.push({ ...AVG, points: snap((m) => m.avg) });
    if (shown.has(NOW.key)) out.push({ ...NOW, points: snap((m) => m.now) });
    COMPONENTS.forEach((c) => {
      if (shown.has(c.key)) out.push({ ...c, points: snap((m) => m.c[c.key]) });
    });
    return out;
  }, [marks, shown, bucketMs]);

  const toggle = (key) => setShown((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const setAll = (on) => setShown(on ? new Set([AVG.key, ...COMPONENTS.map((c) => c.key)]) : new Set([AVG.key]));

  // How much of the range the trail covers, so a line starting half way
  // across reads as "we were not watching", not "the score was flat".
  const rangeMs = CHART_RANGES[range].ms;
  const trailSpan = marks.length > 1 ? marks[marks.length - 1].t - marks[0].t : 0;
  // Avg score reaches back through the score journal (50h); components only
  // exist since the trail started recording them, so they can start later.
  const firstComponent = marks.find((m) => !m.fromJournal);
  const coverage = !marks.length
    ? 'no scores recorded for this token in range yet — they fill while the app is open'
    : (trailSpan >= rangeMs * 0.9 ? 'EARLY covers the full range'
      : 'EARLY from the last ' + ago(Date.now() - marks[0].t)) +
      (firstComponent && firstComponent.t - marks[0].t > 5 * 60000
        ? ' · components from the last ' + ago(Date.now() - firstComponent.t) + ' (not saved before)'
        : '') +
      ' · gaps = app closed';
  const title = 'PRICE & EARLY · ' + ((data && data.interval) || '') + ' CANDLES';
  // What each chip reads right now: the latest mark's value.
  const latest = marks[marks.length - 1] || null;
  const valueOf = (key) => {
    if (!latest) return null;
    if (key === AVG.key) return latest.avg;
    if (key === NOW.key) return latest.now;
    return latest.c[key];
  };

  const chip = (item) => {
    const on = shown.has(item.key);
    const v = valueOf(item.key);
    return (
      <button key={item.key} type="button" onClick={() => toggle(item.key)}
        title={on ? 'Hide ' + item.label : 'Show ' + item.label}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          padding: touch ? '6px 10px' : compact ? '1.5px 6px' : '3px 8px', borderRadius: 999, fontSize: touch ? 11.5 : compact ? 8.5 : 9.5, fontFamily: 'inherit',
          border: '1px solid ' + (on ? item.color : '#1c2a4d'),
          background: on ? item.color + '1f' : 'transparent',
          color: on ? '#dfe6f6' : '#6b7699',
        }}>
        <span style={{ width: 10, height: item.width === 2 ? 3 : 2, background: item.color, opacity: on ? 1 : 0.5,
          borderRadius: 1 }} />
        {item.label}
        {item.weight ? <span style={{ color: '#4a5570' }}>{item.weight}%</span> : null}
        <b style={{ color: on ? item.color : '#4a5570', minWidth: 14, textAlign: 'right' }}>
          {v == null ? '—' : Math.round(v)}
        </b>
      </button>
    );
  };

  return (
    <div style={compact
      ? (touch ? { display: 'flex', flexDirection: 'column' } : { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 })
      : { background: '#0a1226', border: '1px solid #1c2a4d', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: compact ? 6 : 8, flexShrink: 0 }}>
        <span style={{ fontSize: touch ? 11 : 9, letterSpacing: 1.2, color: '#8b96b8', fontWeight: 600 }}>{title}</span>
        <div style={{ display: 'flex', gap: touch ? 6 : 4 }}>
          {Object.keys(CHART_RANGES).map((r) => (
            <button key={r} type="button" onClick={() => setRange(r)} style={{
              padding: touch ? '8px 14px' : '3px 10px', borderRadius: touch ? 8 : 6, fontSize: touch ? 12.5 : 10, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
              border: '1px solid ' + (r === range ? '#4d8dff' : '#1c2a4d'),
              background: r === range ? '#0e2a5c' : 'transparent', color: r === range ? '#dfe6f6' : '#6b7699',
            }}>{r}</button>
          ))}
        </div>
      </div>

      <div style={touch ? { height: 260 } : compact ? { flex: 1, minHeight: 0 } : undefined}>
      <React.Suspense fallback={<div style={{ height: compact ? '100%' : height, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: '#3a4568' }}>Loading chart…</div>}>
        <PriceChart
          bars={bars}
          lines={lines}
          height={compact ? '100%' : height}
          hasVolume={hasVolume}
          fitKey={chain + ':' + pool + ':' + range}
          note={loading ? 'Loading ' + range + ' history…' : bars.length > 1 ? (NOTES[data && data.reason] || '') : (NOTES[data && data.reason] || 'No price history for this pool in range')}
        />
      </React.Suspense>
      </div>

      {/* The dashboard keeps the same toggles, just tighter, under the chart. */}
      {compact && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: touch ? 6 : 3, marginTop: touch ? 12 : 6, flexShrink: 0 }}>
          {chip(AVG)}
          {chip(NOW)}
          {COMPONENTS.map(chip)}
          <button type="button" onClick={() => setAll(true)} style={{ ...linkBtn, fontSize: touch ? 12 : 8.5, marginLeft: 4, padding: touch ? '6px 4px' : 0 }}>all</button>
          <button type="button" onClick={() => setAll(false)} style={{ ...linkBtn, fontSize: touch ? 12 : 8.5, padding: touch ? '6px 4px' : 0 }}>EARLY only</button>
        </div>
      )}

      {!compact && (<>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, margin: '10px 0 6px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9.5, color: '#6b7699' }}>
          Left axis: EARLY 0–100 · right axis: price · {coverage}
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" onClick={() => setAll(true)} style={linkBtn}>show all</button>
          <button type="button" onClick={() => setAll(false)} style={linkBtn}>EARLY only</button>
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {chip(AVG)}
        {chip(NOW)}
        {COMPONENTS.map(chip)}
      </div>
      </>)}
    </div>
  );
}

const linkBtn = {
  background: 'none', border: 'none', color: '#4d8dff', fontSize: 9.5, cursor: 'pointer', padding: 0, fontFamily: 'inherit',
};
