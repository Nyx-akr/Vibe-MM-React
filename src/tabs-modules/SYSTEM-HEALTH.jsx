import React from 'react';
import { chainColor } from '../utils/formatters';
import { chainKeyToName } from '../data/chains';
import { rotationIntelStatus } from '../services/rotation-intel';
import { walletIntelStatus } from '../services/wallet-intel';
import { socialIntelStatus } from '../services/social-intel';
import { storageStats } from '../services/storage/history-store';
import { rawStoreStats } from '../services/storage/raw-store';
import { systemHealth, ago, bytes } from '../calculations/system-health';

/**
 * SYSTEM HEALTH - is the app doing its job right now?
 *
 * Read top to bottom, it narrows: one verdict, then the seven parts of the
 * system that verdict is made of, then the detail behind each. Every colour
 * is a judgement made in calculations/system-health.js, and every non-green
 * one carries its reason - hover a tile for its problems.
 */

/* ------------------------------------------------------------- palette --- */

const C = {
  card: '#0a1226', inner: '#0d1730', border: '#1c2a4d', line: '#16223f',
  text: '#dfe6f6', mid: '#a3aed0', dim: '#6b7699', faint: '#4a5570',
};

const LEVEL = {
  ok: { color: '#3ddc97', label: 'OK' },
  warn: { color: '#ffb454', label: 'DEGRADED' },
  down: { color: '#ff4d5e', label: 'DOWN' },
  unknown: { color: '#4a5570', label: 'IDLE' },
};
const lv = (l) => LEVEL[l] || LEVEL.unknown;

const cap = { fontSize: 9, letterSpacing: 1.2, color: '#8b96b8', fontWeight: 600 };

function Card({ title, right, children, style }) {
  return (
    <div style={Object.assign({ background: C.card, border: '1px solid ' + C.border, borderRadius: 10, padding: 12, minWidth: 0 }, style)}>
      {title && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10, gap: 8 }}>
          <span style={cap}>{title}</span>
          {right && <span style={{ fontSize: 9.5, color: C.dim, whiteSpace: 'nowrap' }}>{right}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

function Dot({ level, size = 7, glow }) {
  const color = lv(level).color;
  return <span style={{ display: 'inline-block', flex: '0 0 auto', width: size, height: size, borderRadius: '50%',
    background: color, boxShadow: glow ? '0 0 0 3px ' + color + '26, 0 0 10px ' + color + '80' : 'none' }} />;
}

/* ------------------------------------------------------------- verdict --- */

function Verdict({ h }) {
  const color = lv(h.level).color;
  const shown = h.issues.slice(0, 6);
  return (
    <div style={{ background: 'linear-gradient(90deg, ' + color + '1f, ' + C.card + ' 55%)',
      border: '1px solid ' + color + '55', borderRadius: 10, padding: '14px 16px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Dot level={h.level} size={14} glow />
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 700, color, letterSpacing: 0.3 }}>{h.title}</div>
          <div style={{ fontSize: 11, color: C.mid, marginTop: 2 }}>{h.summary}</div>
        </div>
        <div style={{ display: 'flex', gap: 18 }}>
          {['down', 'warn', 'ok'].map((l) => {
            const n = h.parts.filter((p) => p.level === l).length;
            return (
              <div key={l} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: n ? lv(l).color : C.faint }}>{n}</div>
                <div style={{ fontSize: 8.5, letterSpacing: 1, color: C.dim }}>{l === 'ok' ? 'HEALTHY' : lv(l).label}</div>
              </div>
            );
          })}
        </div>
      </div>
      {shown.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid ' + C.line,
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '5px 20px' }}>
          {shown.map((i, k) => (
            <div key={k} style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: 10.5, minWidth: 0 }}>
              <span style={{ position: 'relative', top: -1 }}><Dot level={i.level} size={6} /></span>
              <span style={{ color: C.dim, whiteSpace: 'nowrap', fontSize: 9.5 }}>{i.part}</span>
              <span style={{ color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.text}>{i.text}</span>
            </div>
          ))}
          {h.issues.length > shown.length && (
            <div style={{ fontSize: 10, color: C.dim }}>+{h.issues.length - shown.length} more — see the sections below</div>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- tiles --- */

function PartTiles({ parts }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: 10, marginBottom: 10 }}>
      {parts.map((p) => {
        const color = lv(p.level).color;
        return (
          <div key={p.key} title={p.problems && p.problems.length ? p.problems.join('\n') : 'No problems'}
            style={{ background: C.card, border: '1px solid ' + C.border, borderTop: '3px solid ' + color,
              borderRadius: 10, padding: '10px 12px', minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={cap}>{p.label.toUpperCase()}</span>
              <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.8, color }}>{p.level === 'ok' ? 'OK' : lv(p.level).label}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.headline}</div>
            <div style={{ fontSize: 9.5, color: C.dim, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.sub || ' '}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- sources --- */

/** Calls per minute over the last hour; the red cap is the failed share. */
function Spark({ spark }) {
  if (!spark) return <span style={{ fontSize: 9, color: C.faint }}>no timeline on this server</span>;
  const max = Math.max(1, ...spark.map((b) => b.calls));
  const w = 60;
  return (
    <svg viewBox={'0 0 ' + w + ' 16'} preserveAspectRatio="none" style={{ width: '100%', height: 16, display: 'block' }}>
      {spark.map((b, i) => {
        if (!b.calls) return <rect key={i} x={i + 0.15} y={15.2} width={0.7} height={0.8} fill={C.line} />;
        const h = Math.max(1.5, (b.calls / max) * 16);
        const eh = (b.errors / b.calls) * h;
        return (
          <g key={i}>
            <rect x={i + 0.15} y={16 - h} width={0.7} height={h - eh} fill="#3ddc97" opacity={0.75} />
            {eh > 0 && <rect x={i + 0.15} y={16 - eh} width={0.7} height={eh} fill="#ff4d5e" />}
          </g>
        );
      })}
    </svg>
  );
}

function SuccessBar({ pct, level }) {
  if (pct == null) return <span style={{ color: C.faint, fontSize: 10 }}>—</span>;
  const color = lv(level).color;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, height: 4, background: '#1a2440', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: Math.max(2, pct) + '%', height: '100%', background: color }} />
      </div>
      <span style={{ fontSize: 10, color: level === 'ok' ? C.mid : color, fontWeight: 600, width: 32, textAlign: 'right' }}>
        {pct >= 99.95 ? '100' : pct >= 10 ? Math.round(pct) : pct.toFixed(1)}%
      </span>
    </div>
  );
}

const SRC_COLS = '10px minmax(80px,1fr) minmax(70px,1.2fr) 92px 52px 48px';

function Sources({ groups }) {
  const windowText = groups[0] && groups[0].rows[0] && groups[0].rows[0].window === 'lifetime'
    ? 'since server start' : 'status over last 15 min · bars: last 60 min';
  return (
    <Card title="DATA SOURCES" right={windowText}>
      <div style={{ display: 'grid', gridTemplateColumns: SRC_COLS, gap: '0 10px', fontSize: 8.5, letterSpacing: 0.8,
        color: C.faint, fontWeight: 600, paddingBottom: 5, borderBottom: '1px solid ' + C.border }}>
        <span /><span>SOURCE</span><span>CALLS / MIN · LAST HOUR</span><span>SUCCESS</span>
        <span style={{ textAlign: 'right' }}>REQ/MIN</span><span style={{ textAlign: 'right' }}>P50</span>
      </div>
      {groups.map((g) => (
        <div key={g.key}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 0 3px' }}>
            <Dot level={g.level} size={5} />
            <span style={{ fontSize: 9, letterSpacing: 1, color: C.mid, fontWeight: 700 }}>{g.label.toUpperCase()}</span>
            {g.critical && <span style={{ fontSize: 8, color: '#4d8dff', border: '1px solid #24406f', borderRadius: 3, padding: '0 4px' }}>CRITICAL</span>}
            <span style={{ fontSize: 9, color: C.faint }}>{g.what}</span>
          </div>
          {g.rows.map((r) => (
            <div key={r.host} style={{ borderBottom: '1px solid ' + C.line, padding: '5px 0' }}
              title={r.host + '\nlifetime: ' + (r.lifetime.calls || 0).toLocaleString('en-US') + ' calls, ' +
                (r.lifetime.errors || 0).toLocaleString('en-US') + ' errors (' + r.lifetime.errorRatePct + '%)' +
                (r.lastError ? '\nlast error: ' + r.lastError + (r.lastErrorAt ? ' (' + ago(Date.now() - r.lastErrorAt) + ' ago)' : '') : '') +
                (r.p95Ms != null ? '\np95 ' + (r.p95Ms / 1000).toFixed(2) + 's' : '')}>
              <div style={{ display: 'grid', gridTemplateColumns: SRC_COLS, gap: '0 10px', alignItems: 'center', fontSize: 10.5 }}>
                <Dot level={r.level} size={6} />
                <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
                <Spark spark={r.spark} />
                <SuccessBar pct={r.successPct} level={r.level} />
                <span style={{ textAlign: 'right', color: C.mid }}>{r.callsPerMinute != null ? r.callsPerMinute : '—'}</span>
                <span style={{ textAlign: 'right', color: r.p50Ms > 1000 ? '#ffb454' : C.mid }}>
                  {r.p50Ms != null ? (r.p50Ms / 1000).toFixed(2) + 's' : '—'}
                </span>
              </div>
              {r.why && (
                <div style={{ fontSize: 9.5, color: lv(r.level).color, margin: '2px 0 0 20px' }}>{r.why}</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

/* -------------------------------------------------------------- chains --- */

function Chains({ rows }) {
  return (
    <Card title="CHAINS" right="market board, per chain">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))', gap: 8 }}>
        {rows.map((c) => {
          const name = chainKeyToName[c.key] || c.key.toUpperCase();
          return (
            <div key={c.key} title={c.why || 'Fresh'} style={{ background: C.inner, border: '1px solid ' + C.border,
              borderLeft: '3px solid ' + lv(c.level).color, borderRadius: 8, padding: '7px 9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700, fontSize: 11, color: chainColor(name) }}>{name}</span>
                <span style={{ fontSize: 9.5, color: c.level === 'ok' ? C.mid : lv(c.level).color }}>{ago(c.ageMs)}</span>
              </div>
              <div style={{ fontSize: 9.5, color: C.dim, marginTop: 3 }}>
                {c.rows} pools · {c.ms != null ? c.ms + 'ms' : '—'}
              </div>
            </div>
          );
        })}
        {!rows.length && <span style={{ fontSize: 10.5, color: C.dim }}>No chain has reported yet.</span>}
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- jobs --- */

function Jobs({ rows }) {
  return (
    <Card title="BACKGROUND JOBS" right="server collectors">
      {rows.map((j) => (
        <div key={j.key} title={j.what + (j.error ? '\nerror: ' + j.error : '') + '\n' + (j.runs || 0).toLocaleString('en-US') + ' runs, ' + (j.failures || 0) + ' failed'}
          style={{ display: 'grid', gridTemplateColumns: '10px 1fr 64px 64px 44px', gap: 8, alignItems: 'center',
            padding: '4px 0', borderBottom: '1px solid ' + C.line, fontSize: 10.5 }}>
          <Dot level={j.level} size={6} />
          <span style={{ color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{j.label}</span>
          <span style={{ color: C.faint, fontSize: 9.5 }}>{j.intervalMs ? 'every ' + ago(j.intervalMs) : ''}</span>
          <span style={{ color: j.level === 'ok' ? C.mid : lv(j.level).color, fontSize: 10 }}>{ago(j.ageMs)} ago</span>
          <span style={{ textAlign: 'right', fontSize: 9.5, color: j.failures ? '#ffb454' : C.faint }}>
            {j.failures ? j.failures + ' ✕' : '✓'}
          </span>
        </div>
      ))}
      {!rows.length && <span style={{ fontSize: 10.5, color: C.dim }}>No collector has reported yet.</span>}
    </Card>
  );
}

/* ------------------------------------------------------------- browser --- */

function Browser({ services }) {
  return (
    <Card title="THIS BROWSER" right="services running in the app">
      {services.map((s) => (
        <div key={s.key} title={s.error || ''} style={{ display: 'grid', gridTemplateColumns: '10px 1fr auto', gap: 8,
          alignItems: 'center', padding: '4px 0', borderBottom: '1px solid ' + C.line, fontSize: 10.5 }}>
          <Dot level={s.level} size={6} />
          <span style={{ color: C.text }}>{s.label}</span>
          <span style={{ fontSize: 9.5, color: s.error ? lv(s.level).color : C.dim }}>{s.error || s.detail}</span>
        </div>
      ))}
    </Card>
  );
}

/* ------------------------------------------------------------- storage --- */

const STORAGE_STATE = {
  healthy: { color: '#3ddc97', label: 'Recorded' },
  partial: { color: '#ffb454', label: 'Thin' },
  lost: { color: '#ff4d5e', label: 'Lost' },
  none: { color: '#2b3450', label: 'Before archive' },
};

function shortWhen(t, spanMs) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return spanMs > 36 * 3600000
    ? p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1)
    : p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

/**
 * What the archive did and did not record, as time. A percentage cannot tell
 * one long outage from forty blips; the strip shows the shape of the loss.
 * Grey is before the archive's first record - absence of history, not loss.
 */
function StorageStrip({ title, data }) {
  if (!data || !data.ok) {
    return <div style={{ fontSize: 10.5, color: C.dim, marginBottom: 10 }}>{title}: no archive on this server.</div>;
  }
  const cells = data.cells || [];
  const span = data.until - data.since;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 9.5, color: C.mid }}>{title}</span>
        <span style={{ fontSize: 9.5, color: data.recorded >= 0.95 ? '#3ddc97' : data.recorded >= 0.8 ? '#ffb454' : '#ff4d5e', fontWeight: 600 }}>
          {data.recorded == null ? '—' : Math.round(data.recorded * 100) + '% recorded'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 1, height: 18, borderRadius: 3, overflow: 'hidden', background: '#070c1a' }}>
        {cells.map((c, i) => (
          <div key={i} title={shortWhen(c.t, span) + ' — ' + (STORAGE_STATE[c.state] || {}).label +
            (c.samples ? ' (' + c.samples.toLocaleString('en-US') + ' samples)' : '')}
            style={{ flex: '1 1 0', minWidth: 0, background: (STORAGE_STATE[c.state] || STORAGE_STATE.none).color,
              opacity: c.state === 'none' ? 0.45 : 1 }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8.5, color: C.faint, marginTop: 2 }}>
        <span>{shortWhen(data.since, span)}</span><span>{shortWhen(data.since + span / 2, span)}</span><span>now</span>
      </div>
    </div>
  );
}

function Recording({ timeline }) {
  const day = timeline && timeline.day;
  return (
    <Card title="HISTORY RECORDING" right={day ? Math.round(day.bucketMs / 60000) + ' min per block (24h)' : ''}>
      {!timeline ? <div style={{ fontSize: 10.5, color: C.dim }}>Reading the archive…</div> : (
        <>
          <StorageStrip title="Last 24 hours" data={day} />
          <StorageStrip title="Last 7 days" data={timeline.week} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {Object.keys(STORAGE_STATE).map((k) => (
              <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, color: C.dim }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: STORAGE_STATE[k].color, opacity: k === 'none' ? 0.45 : 1 }} />
                {STORAGE_STATE[k].label}
                {day && day.tally && day.tally[k] != null && <span style={{ color: C.faint }}>{day.tally[k]}</span>}
              </span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------- resources --- */

function Stat({ k, v, sub, color }) {
  return (
    <div style={{ background: C.inner, border: '1px solid ' + C.border, borderRadius: 8, padding: '7px 9px', minWidth: 0 }}>
      <div style={{ fontSize: 8.5, letterSpacing: 0.9, color: C.dim }}>{k}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: color || C.text, marginTop: 2, whiteSpace: 'nowrap' }}>{v}</div>
      {sub && <div style={{ fontSize: 9, color: C.faint, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  );
}

function Resources({ r, stuck }) {
  if (!r) return <Card title="SERVER"><div style={{ fontSize: 10.5, color: C.dim }}>No report from the collector.</div></Card>;
  const n = (x) => (x == null ? '—' : x.toLocaleString('en-US'));
  const days = (r.archiveDays || []).slice().reverse();
  const maxDay = Math.max(1, ...days.map((d) => d.bytes));
  return (
    <Card title="SERVER & ARCHIVE" right={'node ' + (r.node || '—')}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 8 }}>
        <Stat k="UPTIME" v={ago((r.uptimeSeconds || 0) * 1000)} />
        <Stat k="MEMORY" v={n(r.rssMb) + ' MB'} sub={'heap ' + n(r.heapMb) + ' MB'} color={r.rssMb > 1500 ? '#ffb454' : C.text} />
        <Stat k="POOLS TRACKED" v={n(r.historyPools)} sub={n(r.holderSeries) + ' holder series'} />
        <Stat k="WALLET SETS" v={n(r.walletSets)} sub={n(r.observationTokens) + ' tokens scored'} />
        <Stat k="ARCHIVE" v={bytes(r.archiveBytes)} sub={n(r.archiveRecords) + ' records'} />
        <Stat k="QUEUED WRITES" v={n(r.pending ? (r.pending.pools || 0) + (r.pending.holders || 0) + (r.pending.observations || 0) : null)}
          sub={r.writeLatencyMs != null ? 'flush ~' + r.writeLatencyMs + 'ms' : ''} />
      </div>
      {days.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 9, color: C.dim, marginBottom: 4 }}>ARCHIVE PER DAY</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 40 }}>
            {days.map((d) => (
              <div key={d.day} title={d.day + ' — ' + bytes(d.bytes)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <div style={{ width: '100%', height: Math.max(2, (d.bytes / maxDay) * 30), background: '#4d8dff', opacity: 0.8, borderRadius: 2 }} />
                <span style={{ fontSize: 8, color: C.faint }}>{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {stuck.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 9, color: '#ffb454', marginBottom: 4 }}>FILES NOT UPDATING</div>
          {stuck.slice(0, 5).map((f) => (
            <div key={f.rel} title={f.error || ''} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, padding: '2px 0', color: C.mid }}>
              <span>{f.rel}</span>
              <span style={{ color: '#ffb454' }}>{f.lastOkAgeMs != null ? ago(f.lastOkAgeMs) + ' old' : 'never written'}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- vals --- */

export function healthVals(app) {
  const health = systemHealth({
    system: app.state.apiSystem,
    browser: {
      wallet: walletIntelStatus(),
      social: socialIntelStatus(),
      rotation: rotationIntelStatus(),
      storage: storageStats(),
      reads: rawStoreStats(),
    },
    timeline: app.state.storageTimeline,
    // Before the first read lands, "no report" means "not asked yet", not "down".
    waiting: !app.state.apiSystem && !app.state.serverError,
  });
  return { health, storageTimeline: app.state.storageTimeline };
}

export default function SystemHealth({ v }) {
  if (!v.isHealth) return null;
  const h = v.health;
  return (
    <div data-screen-label="System health" style={{ flex: 1, overflow: 'auto', padding: '12px 14px', minHeight: 0 }}>
      <Verdict h={h} />
      <PartTiles parts={h.parts} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 10, marginBottom: 10, alignItems: 'start' }}>
        {h.sources.length > 0
          ? <Sources groups={h.sources} />
          : <Card title="DATA SOURCES"><div style={{ fontSize: 10.5, color: C.dim }}>
              {v.health.resources ? 'No upstream calls recorded yet.' : 'Waiting for the collector’s report…'}</div></Card>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
          <Chains rows={h.chains} />
          <Jobs rows={h.jobs} />
          <Browser services={h.browser} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 10, alignItems: 'start' }}>
        <Recording timeline={v.storageTimeline} />
        <Resources r={h.resources} stuck={h.stuckFiles} />
      </div>
    </div>
  );
}
