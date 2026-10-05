import React from 'react';
import {
  createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType, CrosshairMode, LineStyle,
} from 'lightweight-charts';

/**
 * The execution price chart.
 *
 * Replaces a strip of coloured columns that plotted only the CLOSE of each
 * bar, min-max stretched to fill its box. That encoding had three faults: a
 * column implies a zero baseline but these floated, autoscaling made a 0.3%
 * range and a 300% range look identical, and four of the five OHLCV fields
 * were thrown away.
 *
 * This draws the candles we were already paying for, with volume beneath and
 * real price and time axes, so a level can actually be read off it.
 *
 * `lines` overlays our own scores on the same time axis, on a LEFT scale
 * pinned to 0-100 - so a score line keeps its meaning whatever the price does,
 * and "score rose, then price rose" can be read straight off the chart. A
 * legend follows the crosshair with every visible value at that moment.
 *
 * Themed to the dashboard rather than to the library's defaults - the palette
 * below is the app's own, and `up` / `down` are the validated diverging pair
 * used by the score contribution chart.
 */

/* ------------------------------------------------------------- palette -- */

const T = {
  surface: '#0a1226',
  grid: '#141f3b',
  border: '#1c2a4d',
  text: '#6b7699',
  crosshair: '#4a5578',
  // #ff4fae is the app's usual "down" pink, but it sits outside the readable
  // lightness band on this near-black surface; #f2478f is the validated step
  // and is what the score contribution bars use.
  up: '#4d8dff',
  down: '#f2478f',
  upFill: 'rgba(77, 141, 255, 0.28)',
  downFill: 'rgba(242, 71, 143, 0.28)',
};

/**
 * Bars arrive newest-last with epoch-ms stamps; the library wants seconds and
 * a strictly ascending, de-duplicated series or it throws.
 */
function toSeries(bars) {
  const rows = (Array.isArray(bars) ? bars : [])
    .filter((b) => b && Number.isFinite(b.t) && Number.isFinite(b.c))
    .map((b) => ({
      time: Math.floor(b.t / 1000),
      // The local-sample fallback has no real OHLC - every field is the spot
      // price - which draws as a doji. That is honest: we did not observe a
      // high or a low, only a price.
      open: Number.isFinite(b.o) ? b.o : b.c,
      high: Number.isFinite(b.h) ? b.h : b.c,
      low: Number.isFinite(b.l) ? b.l : b.c,
      close: b.c,
      volume: Number.isFinite(b.v) ? b.v : null,
    }))
    .sort((a, b) => a.time - b.time);
  return dedupe(rows);
}

function dedupe(rows) {
  const out = [];
  rows.forEach((r) => {
    const last = out[out.length - 1];
    if (last && last.time === r.time) out[out.length - 1] = r;
    else out.push(r);
  });
  return out;
}

/** A score line's points: seconds, ascending, one per time, gaps left as gaps. */
function toLine(points) {
  return dedupe((points || [])
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v))
    .map((p) => ({ time: Math.floor(p.t / 1000), value: p.v }))
    .sort((a, b) => a.time - b.time));
}

/** Enough precision for a sub-cent memecoin without trailing noise on a major. */
function priceFormat(rows) {
  const last = rows.length ? rows[rows.length - 1].close : 1;
  const decimals = last >= 100 ? 2 : last >= 1 ? 4 : last >= 0.01 ? 6 : 9;
  return { type: 'price', precision: decimals, minMove: Number((10 ** -decimals).toFixed(decimals)) };
}

function fmtPrice(p) {
  if (!Number.isFinite(p)) return '—';
  return p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p >= 0.01 ? p.toFixed(6) : p.toPrecision(4);
}

export default function PriceChart({ bars, note, height = 240, hasVolume = true, lines = [], fitKey }) {
  const boxRef = React.useRef(null);
  const chartRef = React.useRef(null);
  const candleRef = React.useRef(null);
  const volumeRef = React.useRef(null);
  const lineRefs = React.useRef(new Map());
  const legendRef = React.useRef(null);
  const linesRef = React.useRef(lines);
  const fittedRef = React.useRef(null);
  linesRef.current = lines;

  const rows = React.useMemo(() => toSeries(bars), [bars]);

  // Build once; data and size are pushed in by the effects below, so a poll
  // never tears the chart down and rebuilds it.
  React.useEffect(() => {
    if (!boxRef.current) return undefined;

    const chart = createChart(boxRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: T.surface },
        textColor: T.text,
        fontSize: 9,
        fontFamily: 'Poppins, sans-serif',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: T.grid, style: LineStyle.Solid },
        horzLines: { color: T.grid, style: LineStyle.Solid },
      },
      rightPriceScale: { borderColor: T.border, scaleMargins: { top: 0.08, bottom: hasVolume ? 0.26 : 0.08 } },
      leftPriceScale: { borderColor: T.border, visible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: T.border, timeVisible: true, secondsVisible: false },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: T.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: T.border },
        horzLine: { color: T.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: T.border },
      },
      handleScale: { axisPressedMouseMove: false },
      autoSize: false,
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: T.upFill,
      downColor: T.downFill,
      wickUpColor: T.up,
      wickDownColor: T.down,
      borderUpColor: T.up,
      borderDownColor: T.down,
      borderVisible: true,
    });

    let volume = null;
    if (hasVolume) {
      volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: 'vol',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      // Pinned to the bottom quarter so it reads as a footer, not a second plot.
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    }

    // The legend is written straight to the DOM: the crosshair moves at mouse
    // rate, and a React re-render per pixel would be the whole page.
    chart.subscribeCrosshairMove((param) => {
      const el = legendRef.current;
      if (!el) return;
      if (!param || !param.time || !param.seriesData) { el.style.display = 'none'; return; }
      const parts = [];
      const bar = param.seriesData.get(candles);
      if (bar) {
        const up = bar.close >= bar.open;
        parts.push('<span style="color:' + (up ? T.up : T.down) + '">O ' + fmtPrice(bar.open) + ' H ' + fmtPrice(bar.high) +
          ' L ' + fmtPrice(bar.low) + ' C ' + fmtPrice(bar.close) + '</span>');
      }
      linesRef.current.forEach((l) => {
        const series = lineRefs.current.get(l.key);
        const point = series && param.seriesData.get(series);
        if (point && Number.isFinite(point.value)) {
          parts.push('<span style="color:' + l.color + '">' + l.label + ' <b>' + Math.round(point.value) + '</b></span>');
        }
      });
      const d = new Date(param.time * 1000);
      const p = (n) => String(n).padStart(2, '0');
      el.innerHTML = '<span style="color:#8b96b8">' + p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + ' ' +
        p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC</span>' + parts.join('');
      el.style.display = parts.length ? 'flex' : 'none';
    });

    chartRef.current = chart;
    // A fresh chart has never been fitted, whatever the last one was.
    fittedRef.current = null;
    candleRef.current = candles;
    volumeRef.current = volume;
    const lineMap = lineRefs.current;

    const box = boxRef.current;
    const resize = () => {
      if (!box || !chartRef.current) return;
      chartRef.current.applyOptions({ width: box.clientWidth, height: box.clientHeight });
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    if (observer) observer.observe(box);
    else window.addEventListener('resize', resize);

    return () => {
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', resize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      lineMap.clear();
    };
  }, [hasVolume]);

  // Data only - setData on the existing series, so the view is not rebuilt.
  React.useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    candles.applyOptions({ priceFormat: priceFormat(rows) });
    candles.setData(rows.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));

    if (volumeRef.current) {
      const withVolume = rows.filter((r) => Number.isFinite(r.volume));
      volumeRef.current.setData(withVolume.map((r) => ({
        time: r.time,
        value: r.volume,
        color: r.close >= r.open ? T.upFill : T.downFill,
      })));
    }
  }, [rows, hasVolume]);

  // Score lines: add, update or drop series to match the visible set.
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = lineRefs.current;
    const wanted = new Set(lines.map((l) => l.key));
    map.forEach((series, key) => {
      if (!wanted.has(key)) { chart.removeSeries(series); map.delete(key); }
    });
    lines.forEach((l) => {
      let series = map.get(l.key);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          priceScaleId: 'left',
          color: l.color,
          lineWidth: l.width || 1,
          lineStyle: l.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerRadius: 3,
          title: '',
          priceFormat: { type: 'price', precision: 0, minMove: 1 },
          // A score is 0-100 wherever it sits; never let the scale zoom in
          // on a flat line and make 60 -> 62 look like a leap.
          autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
        });
        map.set(l.key, series);
      }
      series.setData(toLine(l.points));
    });
    chart.applyOptions({ leftPriceScale: { visible: lines.length > 0 } });
  }, [lines, hasVolume]);

  // Fit only when what is being looked at changes (range, token) - not on
  // every poll, or a zoom the user made would snap back every few seconds.
  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !rows.length) return;
    const key = fitKey || 'default';
    if (fittedRef.current === key) return;
    fittedRef.current = key;
    chart.timeScale().fitContent();
  }, [rows, fitKey, hasVolume]);

  const empty = rows.length < 2;

  return (
    <div style={{ position: 'relative', height, width: '100%' }}>
      <div ref={boxRef} style={{ position: 'absolute', inset: 0, opacity: empty ? 0 : 1 }} />
      <div ref={legendRef} style={{
        position: 'absolute', left: 8, top: 6, display: 'none', flexWrap: 'wrap', gap: '2px 10px',
        fontSize: 9.5, pointerEvents: 'none', maxWidth: '85%', zIndex: 3,
        background: 'rgba(10,18,38,0.82)', padding: '3px 6px', borderRadius: 4,
      }} />
      {empty && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontSize: 10, color: '#3a4568', textAlign: 'center', padding: '0 16px',
        }}>
          {note || 'No price history for this pool'}
        </div>
      )}
      {!empty && note && (
        <div style={{
          position: 'absolute', left: 8, bottom: 6, fontSize: 8.5, color: '#4a5578',
          pointerEvents: 'none', maxWidth: '70%',
        }}>
          {note}
        </div>
      )}
    </div>
  );
}
