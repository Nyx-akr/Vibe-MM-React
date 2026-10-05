/**
 * The OPS half of the admin page: the server process, storage, and the
 * source/equation catalogue.
 *
 * It has its own polling because it mostly describes the SERVER rather than the
 * dashboard. STORAGE is the exception and deliberately so: storage has three
 * halves and two of them live in this browser, so that tab reads the app's own
 * hydrated stores. AdminPanel extends App, so those are the same objects the
 * dashboard uses - never a second copy that could disagree.
 */
import React from 'react';
import {
  fetchAdminStore, fetchCatalog, API_ORIGIN, API_BASES,
  initApiBase, setApiTarget, apiTarget, probeLocalApi,
} from '../services/api';
// The STORAGE tab is the one section here that is NOT server-only: storage has
// three halves and two of them live in this browser. AdminPanel extends App, so
// these read the same hydrated objects the dashboard uses - not a second copy.
import {
  storageStats, breakdown as historyBreakdown, deepCounts, storageHealth,
} from '../services/storage/history-store';
import {
  inputStats, inputBreakdown, inputHealth,
} from '../services/storage/input-store';
import { rawStoreStats } from '../services/storage/raw-store';

const C = {
  bg: '#03060f', panel: '#0a1226', border: '#1c2a4d', line: '#16223f',
  text: '#dfe6f6', dim: '#8b96b8', faint: '#6b7699', grey: '#3a4568',
  blue: '#4d8dff', pink: '#e35ff2', hot: '#ff4fae', white: '#ffffff'
};

const ms = (v) => (v == null ? '—' : v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms');
const ago = (t) => {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  return (s / 3600).toFixed(1) + 'h ago';
};
const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
/** Byte counts, which the disk archive reports and the old cloud store never did. */
const mb = (v) => {
  if (v == null) return '—';
  if (v < 1024) return v + 'B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + 'KB';
  if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + 'MB';
  return (v / (1024 * 1024 * 1024)).toFixed(2) + 'GB';
};
const secs = (v) => (Number.isFinite(v) ? Math.round(v / 1000) + 's' : '—');
const dur = (v) => {
  if (v == null) return '—';
  const m = Math.round(v / 60000);
  return m >= 60 ? (m / 60).toFixed(1) + 'h' : m + 'min';
};

/**
 * One store's verdict: a colour, a sentence, and the reasons behind it.
 *
 * The reasons are the point. A bare "DEGRADED" tells you to go digging, which
 * is exactly the work a health panel is supposed to save - so every problem
 * that lowered the grade is printed underneath it.
 */
const HEALTH_COLOR = { ok: '#3ddc97', degraded: '#ffb454', failed: '#ff4fae' };
const HEALTH_LABEL = { ok: 'HEALTHY', degraded: 'DEGRADED', failed: 'FAILED' };

/** Plain English for the `kind` field in the archive log. */
const KIND_MEANING = {
  pool: 'raw 15s pool samples, every provider side by side',
  observation: 'raw 60s price and liquidity snapshots',
  holders: 'holder counts over time',
  'app:journal': 'scores this app computed — the server cannot',
  _probe: 'admin latency test rows',
};

/** Plain English for the keys in the browser history store. */
const HISTORY_MEANING = {
  'wallet-memory': 'wallets seen trading, and their co-entry clusters',
  'social-memory': 'per-token mention counts and their baselines',
  'score-journal': 'what we scored each token, when — joined to prices in EVALUATION',
  'stage-memory': 'when each token entered its current stage',
};

function Health({ name, where, health, bytes, note }) {
  const level = (health && health.level) || 'failed';
  const color = HEALTH_COLOR[level] || C.hot;
  const problems = (health && health.problems) || [];
  return (
    <div style={{
      flex: '1 1 0', minWidth: 210, background: '#070c1a',
      border: `1px solid ${C.border}`, borderLeft: `3px solid ${color}`,
      borderRadius: 8, padding: '10px 12px',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: C.white, letterSpacing: 0.5 }}>{name}</span>
        <span style={{ fontSize: 8.5, fontWeight: 700, color, letterSpacing: 0.8 }}>{HEALTH_LABEL[level]}</span>
      </div>
      <div style={{ fontSize: 9, color: C.faint, marginTop: 2 }}>{where}</div>
      {bytes != null && (
        <div style={{ fontSize: 19, fontWeight: 700, color: C.text, marginTop: 6 }}>{mb(bytes)}</div>
      )}
      {note && <div style={{ fontSize: 9, color: C.grey, marginTop: 2 }}>{note}</div>}
      <div style={{ fontSize: 9.5, color: C.dim, marginTop: 7 }}>
        {(health && health.summary) || 'No verdict.'}
      </div>
      {problems.map((p, i) => (
        <div key={i} style={{ fontSize: 9, color: color, marginTop: 4, lineHeight: 1.45 }}>• {p}</div>
      ))}
    </div>
  );
}

function Section({ title, right, children }) {
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <div style={{ fontSize: 9, letterSpacing: 1.2, color: C.dim, fontWeight: 600 }}>{title}</div>
        {right && <div style={{ fontSize: 10, color: C.faint }}>{right}</div>}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, color, sub }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: C.faint, letterSpacing: 0.6 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3, color: color || C.text }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: C.grey, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

const Grid = ({ cols, children }) => (
  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: 12 }}>{children}</div>
);

function Table({ head, rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
        <thead>
          <tr>{head.map((h, i) => (
            <th key={i} style={{ textAlign: 'left', padding: '5px 8px', color: C.faint, fontSize: 9,
              letterSpacing: 0.8, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((cell, j) => (
              <td key={j} style={{ padding: '5px 8px', borderBottom: `1px solid ${C.line}`, color: C.text,
                verticalAlign: 'top' }}>{cell}</td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default class AdminOps extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(window.location.search);
    this.state = {
      data: null, catalog: null, error: null, loading: true,
      collection: 'poolHistory', probe: null, scan: null,
      token: params.get('token') || '', tab: props.initialTab || 'server',
      // Which server this page is reading, and whether the local one is up.
      // The panel used to import API_ORIGIN and never call initApiBase(), so
      // it always read the deployed server even with a local one running and
      // the dashboard beside it reading from that local one.
      target: apiTarget(), localUp: null
    };
  }

  async componentDidMount() {
    // Settle on a server BEFORE the first request, exactly as App does.
    await initApiBase();
    this.setState({ target: apiTarget(), localUp: await probeLocalApi() });
    this.load();
    this.timer = setInterval(() => this.load(), 15000);
  }

  /** Pin this page - and the dashboard - to one server, or hand it to the probe. */
  pickServer = async (next) => {
    if (next === this.state.target) return;
    this.setState({ loading: true, error: null, data: null, probe: null });
    await setApiTarget(next);
    this.setState({ target: apiTarget(), localUp: await probeLocalApi() }, () => this.load());
  };
  componentWillUnmount() { clearInterval(this.timer); }

  // The rail in the admin shell picks the section, so the prop is the tab.
  componentDidUpdate(prev) {
    if (prev.initialTab !== this.props.initialTab && this.props.initialTab) {
      this.setState({ tab: this.props.initialTab });
    }
  }

  async load() {
    const { collection } = this.state;
    const [data, catalog] = await Promise.all([
      fetchAdminStore({ collection }),
      this.state.catalog ? Promise.resolve(this.state.catalog) : fetchCatalog()
    ]);
    this.setState({
      data, catalog, loading: false,
      // The collector takes both on its own slow clock and writes the latest;
      // the last one seen is kept so a missed read does not blank the table.
      probe: (data && data.probe) || this.state.probe,
      scan: (data && data.scan) || this.state.scan,
      error: data ? null : 'Could not read system.json from the raw store'
    });
  }


  render() {
    const { data, catalog, loading, error, probe, collection, tab } = this.state;
    const store = data && data.store;
    const mem = data && data.memory;
    // Every block below is optional: a server that predates it should leave
    // a dash on the page, not a white screen.
    const smp = (data && data.sampling) || {};
    const wlat = (store && store.writeLatency) || {};
    const rlat = (store && store.readLatency) || {};
    const queued = (store && store.pending) || {};

    // The browser half of storage. These are read fresh on every render, which
    // the 15s poll drives - they are live objects, not a snapshot taken once.
    // AdminPanel extends App, so they are the SAME memories the dashboard uses.
    const hist = storageStats();
    const histRows = historyBreakdown();
    const deep = deepCounts();
    const histHealth = storageHealth();
    const inputs = inputStats();
    const inputRows = inputBreakdown();
    const inHealth = inputHealth();
    const reads = rawStoreStats();
    const writes = (data && data.raw) || {};
    const ran = (data && data.collectors) || {};
    const scan = (data && data.scan) || this.state.scan;
    const use = (store && store.usage) || {};

    // The raw store is healthy when the collector is writing it and this page
    // can read it. system.json itself is rewritten every 15s, so its age says
    // whether the collector is alive at all.
    const rawAge = data && Number.isFinite(data.writtenAgeMs) ? data.writtenAgeMs : null;
    const rawHealth = !data
      ? { level: 'failed', summary: 'Raw store unreadable.', problems: [reads.lastError || 'system.json could not be read.'] }
      : rawAge !== null && rawAge > 60000
        ? { level: 'degraded', summary: 'Collector has stopped writing.',
            problems: ['system.json is ' + Math.round(rawAge / 1000) + 's old; it is rewritten every 15s.'] }
        : writes.errors
          ? { level: 'degraded', summary: 'Some writes failed.', problems: [num(writes.errors) + ' failed write(s); last: ' + (writes.lastError || 'unknown')] }
          : { level: 'ok', summary: 'Collector writing; this page reading.', problems: [] };

    return (
      <div style={{ color: C.text }}>

        {/* The shell owns the header and the rail; this is the section title only. */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.white }}>
            {tab === 'storage' ? 'STORAGE' : tab === 'sources' ? 'SOURCES & EQUATIONS' : 'SERVER PROCESS'}
          </div>
          <span style={{ fontSize: 9, padding: '3px 9px', borderRadius: 10,
            background: error ? '#45103a' : '#0e2a5c', color: error ? C.hot : C.blue }}>
            {loading ? 'LOADING' : error ? 'SERVER UNREACHABLE' : 'LIVE · 15s refresh'}
          </span>
          <div style={{ fontSize: 10.5, color: C.dim }}>
            {tab === 'storage'
              ? 'Where every number lives: one archive on the server, two stores in this browser.'
              : 'This section describes the SERVER, not the dashboard — nothing here is a number the frontend also renders.'}
          </div>
        </div>

        {error && (
          <Section title="CONNECTION">
            <div style={{ color: C.hot, fontSize: 12 }}>
              {error} at <span style={{ color: C.blue }}>{API_ORIGIN}</span>.{' '}
              {this.state.target === 'local'
                ? 'Nothing is answering on that port - start the local server, or switch to DEPLOYED.'
                : 'If the Render instance was asleep it may take 30-60s to wake. A local server is ' +
                  (this.state.localUp ? 'up - switch to LOCAL.' : 'not running.')}
            </div>
          </Section>
        )}

        {/* ---------------------------------------------------- SERVER */}
        {tab === 'server' && data && (
          <>
            <Section title="PROCESS" right={`node ${mem.node}`}>
              <Grid cols={6}>
                <Stat label="UPTIME" value={dur(mem.uptimeSeconds * 1000)} sub="since last restart" />
                <Stat label="HEAP USED" value={mem.heapUsedMb + ' MB'} />
                <Stat label="RSS" value={mem.rssMb + ' MB'} />
                <Stat label="CACHE ENTRIES" value={num(mem.cacheEntries)} sub="upstream responses" />
                <Stat label="IN FLIGHT" value={num(mem.inflight)} />
                <Stat label="PERSISTENCE" value={store.persistent ? 'LOCAL DISK' : 'RAM ONLY'}
                  color={store.persistent ? C.blue : C.hot}
                  sub={store.dir ? 'JSONL + snapshot' : 'archive unavailable'} />
              </Grid>
            </Section>

            <Section title="SERIES HELD IN MEMORY">
              <Grid cols={5}>
                <Stat label="POOL HISTORIES" value={num(mem.historyPools)} sub={`${num(smp.historyMaxSamples)} samples max`} />
                <Stat label="OBSERVATIONS" value={num(mem.observationTokens)} sub={`${num(smp.observationMax)} max per token`} />
                <Stat label="STAGES TRACKED" value={num(mem.stagesTracked)} />
                <Stat label="HOLDER SERIES" value={num(mem.holderSeries)} />
                <Stat label="WALLET SETS" value={num(mem.walletSetsSampled)} sub="capital rotation" />
              </Grid>
              <div style={{ fontSize: 9.5, color: C.grey, marginTop: 10, lineHeight: 1.6 }}>
                Pool samples every {secs(smp.historyGapMs)}, pruned past {dur(smp.historyMaxAgeMs)} ·
                observations every {secs(smp.observationGapMs)} ·
                rotation samples {num(smp.tradesPerCycle)} of {num(smp.rotationPools)} pools every {secs(smp.rotationRefreshMs)}
              </div>
            </Section>

            {data.warm && (
              <Section title="CHAIN REFRESH · WARM LOOP"
                right={`${data.warm.chains.length} chains, one every ${Math.round(data.warm.intervalMs / 1000)}s · full cycle ${Math.round(data.warm.fullCycleMs / 1000)}s`}>
                <Table
                  head={['CHAIN', 'ROWS', 'TOOK', 'LIST', 'LAST REFRESH', 'ERROR']}
                  rows={data.warm.chains.map((c) => {
                    const w = data.warm.state[c];
                    if (!w) return [<span style={{ color: C.dim }}>{c}</span>, '—', '—',
                      <span style={{ color: C.grey }}>not warmed yet</span>, '—', '—'];
                    return [
                      <span style={{ color: C.white, fontWeight: 600 }}>{c}</span>,
                      <span style={{ color: w.rows ? C.text : C.hot }}>{num(w.rows)}</span>,
                      ms(w.ms),
                      <span style={{ color: w.stale ? C.pink : C.blue }}>{w.stale ? 'stale' : 'fresh'}</span>,
                      ago(w.at),
                      <span style={{ color: w.error ? C.hot : C.grey, fontSize: 9.5 }}>{w.error || '—'}</span>
                    ];
                  })}
                />
                <div style={{ fontSize: 9.5, color: C.grey, marginTop: 9 }}>
                  One chain at a time, so eight chains never hit GeckoTerminal at once. This also keeps
                  samples accruing when nobody has the dashboard open.
                </div>
              </Section>
            )}

            <Section title="UPSTREAM PROVIDERS"
              right={`${num(data.upstream && data.upstream.total)} calls over ${dur((data.upstreamWindowSeconds || 0) * 1000)}`}>
              <Table
                head={['PROVIDER', 'CALLS', 'PER MIN', 'MEDIAN', 'P95', 'ERRORS', 'LAST ERROR']}
                rows={(data.providers || []).map((p) => {
                  // GeckoTerminal's keyless tier is the binding constraint at
                  // ~30 calls a minute, so its rate is the one worth colouring.
                  const hot = p.provider.indexOf('geckoterminal') !== -1 && p.callsPerMinute > 25;
                  return [
                    <span style={{ color: C.text }}>{p.provider}</span>,
                    num(p.calls),
                    <span style={{ color: hot ? C.hot : C.text }}>{p.callsPerMinute}</span>,
                    ms(p.p50Ms),
                    ms(p.p95Ms),
                    <span style={{ color: p.errors ? C.hot : C.grey }}>{p.errors || 0} ({p.errorRatePct}%)</span>,
                    <span style={{ color: C.grey, fontSize: 9.5 }}>{p.lastError || '—'}</span>
                  ];
                })}
              />
              <div style={{ fontSize: 9.5, color: C.grey, marginTop: 9 }}>
                The server reports call counts and raw latency samples only. The per-minute rate,
                the median and the p95 are computed here by providerHealth() in
                calculations/core.js — the same function the dashboard's SYSTEM HEALTH tab reads,
                so the two pages cannot disagree about a provider.
              </div>
            </Section>
          </>
        )}

        {/* --------------------------------------------------- STORAGE */}
        {tab === 'storage' && data && (
          <>
            <Section title="STORAGE HEALTH" right={
              <span style={{ color: C.faint }}>three stores · no cloud account</span>
            }>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Health
                  name="ARCHIVE" where="server · local disk"
                  bytes={store.usage && store.usage.ok ? store.usage.bytes : null}
                  note={store.usage && store.usage.ok
                    ? `${num(store.usage.files)} day file${store.usage.files === 1 ? '' : 's'} + ${mb(store.usage.snapshotBytes)} snapshot`
                    : 'nothing on disk'}
                  health={store.health} />
                <Health
                  name="HISTORY" where="this browser · IndexedDB"
                  bytes={hist.approxBytes}
                  note={`${num(hist.keys)} memories · ${num(deep.journalMarks)} score marks`}
                  health={histHealth} />
                <Health
                  name="USER INPUTS" where="this browser · localStorage"
                  bytes={inputs.approxBytes}
                  note={`${num(inputs.stored)} of ${num(inputs.inputs)} set`}
                  health={inHealth} />
                <Health
                  name="RAW STORE" where="collector → files → this page"
                  bytes={writes.bytes || null}
                  note={`${num(writes.writes)} writes · ${num(reads.reads)} reads here`}
                  health={rawHealth} />
              </div>
              <div style={{ fontSize: 9.5, color: C.grey, marginTop: 10, lineHeight: 1.5 }}>
                Two stores, split by who writes them. The collector writes raw provider data — the archive
                and the RAW STORE files — and this app only reads it. Everything the app computes (scores,
                stages, the score journal) lives in the browser's history store and never goes to the server;
                the input store holds what you picked.
              </div>
            </Section>

            <Section title="WHAT IS STORED · ARCHIVE" right={
              <span style={{ color: C.faint }}>
                collector scans hourly{ran.scan && ran.scan.at ? ' · last ' + ago(ran.scan.at) : ''}
              </span>
            }>
              {scan && scan.ok ? (
                <>
                  <Grid cols={5}>
                    <Stat label="RECORDS" value={num(scan.records)} />
                    <Stat label="ON DISK" value={mb(scan.bytes)} />
                    <Stat label="COVERS" value={dur(scan.spanMs)}
                      sub={scan.oldestAt ? 'oldest ' + ago(scan.oldestAt) : '—'} />
                    <Stat label="DAY FILES" value={num(scan.days)} />
                    <Stat label="UNREADABLE LINES" value={num(scan.torn)}
                      color={scan.torn ? C.hot : '#3ddc97'}
                      sub={scan.torn ? 'lost to a crash mid-write' : 'none — every line parsed'} />
                  </Grid>
                  <div style={{ marginTop: 12 }}>
                    <Table
                      head={['KIND', 'WHAT IT IS', 'RECORDS', 'SIZE', 'OLDEST', 'NEWEST']}
                      rows={Object.keys(scan.kinds).sort((a, b) => scan.kinds[b].bytes - scan.kinds[a].bytes)
                        .map((k) => [
                          <span style={{ color: C.white, fontWeight: 600 }}>{k}</span>,
                          <span style={{ color: C.dim }}>{KIND_MEANING[k] || 'app-computed rows'}</span>,
                          num(scan.kinds[k].records),
                          mb(scan.kinds[k].bytes),
                          ago(scan.kinds[k].firstAt),
                          ago(scan.kinds[k].lastAt),
                        ])}
                    />
                  </div>
                  <div style={{ fontSize: 9.5, color: C.grey, marginTop: 8 }}>
                    Read in {ms(scan.scannedInMs)}. Rows prefixed <code>app:</code> were computed in the
                    browser and pushed here — the server stores them but derives nothing from them.
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: C.grey, lineHeight: 1.6 }}>
                  {scan && scan.error ? <span style={{ color: C.hot }}>{scan.error}</span> : (
                    <>Counting what is in the archive means reading every day file, so it is not part of the
                    15s poll. This process has written{' '}
                    <span style={{ color: C.text }}>{num(store.writes)}</span> records
                    ({mb(store.bytesWritten)}) since it started
                    {store.health && store.health.writtenByKind
                      ? ' — ' + Object.keys(store.health.writtenByKind)
                        .map((k) => `${k} ${num(store.health.writtenByKind[k].records)}`).join(', ')
                      : ''}.</>
                  )}
                </div>
              )}
            </Section>

            <Section title="RETENTION · DAY FILES" right={
              use.rawDays != null
                ? <span style={{ color: C.faint }}>
                    {use.rawDays} days raw, then {Math.round((use.rollupMs || 60000) / 1000)}s rollup
                  </span>
                : null
            }>
              {use.days && use.days.length ? (
                <>
                  <Table
                    head={['DAY', 'RESOLUTION', 'SIZE', 'LAST WRITTEN']}
                    rows={use.days.map((d) => [
                      <span style={{ color: C.white, fontWeight: 600 }}>{d.day}</span>,
                      d.compacted
                        ? <span style={{ color: '#4d8dff' }}>
                            {Math.round((d.resolution || 60000) / 1000)}s rollup
                          </span>
                        : <span style={{ color: '#3ddc97' }}>15s raw</span>,
                      mb(d.bytes),
                      ago(d.modifiedAt),
                    ])}
                  />
                  <div style={{ fontSize: 9.5, color: C.grey, marginTop: 8, lineHeight: 1.5 }}>
                    Days older than {use.rawDays} are rolled up to one sample per minute and the raw file is
                    dropped — the rollup keeps the LAST reading in each minute rather than an average, so every
                    retained number is one that was actually observed. Compaction writes the new file and
                    fsyncs it before removing the old one, so an interruption leaves one or the other, never
                    neither.
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: C.grey }}>No day files yet.</div>
              )}
            </Section>

            <Section title="WHAT IS STORED · THIS BROWSER" right={
              <span style={{ color: C.faint }}>{hist.where} · {inputs.where}</span>
            }>
              <div style={{ fontSize: 9, color: C.faint, letterSpacing: 0.6, marginBottom: 6 }}>
                HISTORY STORE · the working day
              </div>
              {histRows.length ? (
                <Table
                  head={['MEMORY', 'WHAT IT HOLDS', 'ENTRIES', 'SIZE', 'SAVED', 'STATE']}
                  rows={histRows.map((r) => [
                    <span style={{ color: C.white, fontWeight: 600 }}>{r.key}</span>,
                    <span style={{ color: C.dim }}>{HISTORY_MEANING[r.key] || '—'}</span>,
                    num(r.entries),
                    mb(r.bytes),
                    r.savedAt ? ago(r.savedAt) : '—',
                    r.pending
                      ? <span style={{ color: '#ffb454' }}>writing…</span>
                      : <span style={{ color: '#3ddc97' }}>saved</span>,
                  ])}
                />
              ) : (
                <div style={{ fontSize: 11, color: C.grey }}>
                  Nothing stored yet — the intel services fill this within a minute of the page opening.
                </div>
              )}

              <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
                <Grid cols={6}>
                  <Stat label="SCORE MARKS" value={num(deep.journalMarks)}
                    sub={`over ${num(deep.journalTokens)} tokens`} />
                  <Stat label="WALLETS" value={num(deep.wallets)} sub={`${num(deep.clusters)} clusters`} />
                  <Stat label="SOCIAL TOKENS" value={num(deep.socialTokens)}
                    sub={`${num(deep.socialSamples)} baseline samples`} />
                  <Stat label="TOTAL" value={mb(hist.approxBytes)} sub={`${num(hist.keys)} keys`} />
                  <Stat label="WRITES" value={num(hist.writes)} sub="this page" />
                  <Stat label="PENDING" value={num(hist.pendingWrite)}
                    color={hist.pendingWrite ? '#ffb454' : C.text} sub="debounced 2s" />
                </Grid>
              </div>

              <div style={{ fontSize: 9, color: C.faint, letterSpacing: 0.6, margin: '14px 0 6px' }}>
                INPUT STORE · what you chose
              </div>
              <Table
                head={['INPUT', 'KEY', 'ENTRIES', 'SIZE', 'STATE']}
                rows={inputRows.map((r) => [
                  <span style={{ color: C.white, fontWeight: 600 }}>{r.name}</span>,
                  <span style={{ fontSize: 9.5, color: C.dim }}>{r.key}</span>,
                  r.entries == null ? '—' : num(r.entries),
                  r.stored ? mb(r.bytes) : '—',
                  !r.stored
                    ? <span style={{ color: C.grey }}>not set · using default</span>
                    : r.valid === false
                      ? <span style={{ color: C.hot }}>malformed · default in use</span>
                      : <span style={{ color: '#3ddc97' }}>saved</span>,
                ])}
              />
            </Section>

            <Section title="RAW STORE · COLLECTOR → FILES → THIS PAGE" right={
              <span style={{ color: C.faint }}>{reads.base}</span>
            }>
              <Grid cols={6}>
                <Stat label="FILES WRITTEN" value={num(writes.writes)} sub={mb(writes.bytes) + ' this process'} />
                <Stat label="LAST WRITE" value={ago(writes.lastWriteAt)}
                  color={rawAge !== null && rawAge > 60000 ? C.hot : C.text} />
                <Stat label="WRITE ERRORS" value={num(writes.errors)} color={writes.errors ? C.hot : C.text}
                  sub={writes.lastError || 'none'} />
                <Stat label="READS HERE" value={num(reads.reads)} sub={mb(reads.bytes) + ' parsed'} />
                <Stat label="UNCHANGED" value={num(reads.unchanged)} sub="304 — not re-parsed" />
                <Stat label="READ ERRORS" value={num(reads.errors)} color={reads.errors ? '#ffb454' : C.text}
                  sub={reads.lastError || (reads.missing ? num(reads.missing) + ' not written yet' : 'none')} />
              </Grid>
              <div style={{ fontSize: 9.5, color: C.grey, marginTop: 10, lineHeight: 1.5 }}>
                The collector fetches every provider on its own clock and writes whole files atomically, so
                this page always reads a complete file. Nothing on this page — or anywhere in the app — asks
                the server to fetch, sample or compute anything, and nothing the app computes is sent back.
              </div>
            </Section>

            <Section title="DISK READ / WRITE TIME" right={
              <span style={{ color: C.faint }}>
                collector tests every 5 min{ran.probe && ran.probe.at ? ' · last ' + ago(ran.probe.at) : ''}
              </span>
            }>
              <Grid cols={4}>
                <Stat label="WRITE · LAST" value={ms(wlat.last)}
                  sub={`avg ${ms(wlat.avg)} · ${wlat.samples || 0} samples`} />
                <Stat label="WRITE · RANGE" value={`${ms(wlat.min)} – ${ms(wlat.max)}`} />
                <Stat label="READ · LAST" value={ms(rlat.last)}
                  sub={`avg ${ms(rlat.avg)} · ${rlat.samples || 0} samples`} />
                <Stat label="READ · RANGE" value={`${ms(rlat.min)} – ${ms(rlat.max)}`} />
              </Grid>
              {probe && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
                  <Grid cols={4}>
                    <Stat label="PROBE WRITE" value={ms(probe.writeMs)} color={C.pink}
                      sub="append + fsync" />
                    <Stat label="PROBE READ" value={ms(probe.readMs)} color={C.pink} sub="read back" />
                    <Stat label="ROUND TRIP" value={ms(probe.roundTripMs)} color={C.pink} />
                    <Stat label="VERIFIED" value={probe.verified ? 'YES' : 'NO'} color={probe.verified ? C.blue : C.hot}
                      sub={probe.error || 'wrote then read back the same value'} />
                  </Grid>
                </div>
              )}
            </Section>

            <Section title="WRITE ACTIVITY">
              <Grid cols={6}>
                <Stat label="RECORDS WRITTEN" value={num(store.writes)} sub="this process" />
                <Stat label="SERIES RESTORED" value={num(store.reads)} sub="on boot" />
                <Stat label="ERRORS" value={num(store.errors)} color={store.errors ? C.hot : C.text}
                  sub={store.lastError || 'none'} />
                <Stat label="LAST FLUSH" value={ago(store.lastFlushAt)}
                  sub={`${store.lastFlushDocs || 0} records in ${ms(store.lastFlushMs)}`} />
                <Stat label="FLUSH EVERY" value={dur(store.flushIntervalMs)}
                  sub={`observations ${dur(store.observationFlushIntervalMs)}`} />
                <Stat label="BOOT RESTORE" value={ms(store.lastLoadMs)} sub={ago(store.loadedAt)} />
              </Grid>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
                <div style={{ fontSize: 9, color: C.faint, marginBottom: 6 }}>QUEUED FOR NEXT FLUSH</div>
                <Grid cols={4}>
                  <Stat label="POOLS" value={num(queued.pools)} />
                  <Stat label="OBSERVATIONS" value={num(queued.observations)} />
                  {/* Stages are derived, so the server holds none to flush. */}
                  <Stat label="STAGES" value={num(queued.stages)} sub="derived in the app" />
                  <Stat label="HOLDERS" value={num(queued.holders)} />
                </Grid>
              </div>
              <div style={{ fontSize: 9.5, color: C.grey, marginTop: 10 }}>
                {store.usage && store.usage.ok ? (
                  <>Archive holds {mb(store.usage.bytes)} across {num(store.usage.files)} day
                  file{store.usage.files === 1 ? '' : 's'}, plus a {mb(store.usage.snapshotBytes)} snapshot.
                  Writes are local appends, so the limit is disk, not a quota: {mb(store.bytesWritten)} written
                  this process. <span style={{ color: C.faint }}>{store.dir}</span></>
                ) : 'This server is not archiving to disk, so nothing survives a restart.'}
              </div>
            </Section>

            <Section title="STORED DOCUMENTS" right={
              <span>
                {['poolHistory', 'observations', 'stages', 'holders'].map((c) => (
                  <span key={c} onClick={() => this.setState({ collection: c }, () => this.load())}
                    style={{ cursor: 'pointer', marginLeft: 10, color: collection === c ? C.pink : C.faint }}>{c}</span>
                ))}
              </span>
            }>
              {data.inspect && data.inspect.documents.length ? (
                <>
                  <div style={{ fontSize: 9.5, color: C.grey, marginBottom: 8 }}>
                    {data.inspect.count} shown{data.inspect.hasMore ? ' (more exist)' : ''} · fetched in {ms(data.inspect.fetchedInMs)}
                  </div>
                  <Table
                    head={['DOCUMENT', 'SYMBOL', 'CHAIN', 'ENTRIES', 'SPAN', 'PAYLOAD', 'UPDATED']}
                    rows={data.inspect.documents.map((d) => [
                      <span style={{ fontSize: 9.5, color: C.dim }}>{d.id.slice(0, 34)}…</span>,
                      <span style={{ color: C.white, fontWeight: 600 }}>{d.symbol || d.stage || '—'}</span>,
                      d.chain || '—',
                      num(d.sampleCount),
                      d.firstSampleAt && d.lastSampleAt ? dur(d.lastSampleAt - d.firstSampleAt) : '—',
                      d.payloadBytes ? (d.payloadBytes / 1024).toFixed(1) + ' KB' : '—',
                      ago(d.updatedAt)
                    ])}
                  />
                </>
              ) : (
                <div style={{ fontSize: 11, color: C.grey }}>
                  {store.persistent ? (data.inspectError || 'No records of this kind yet.')
                    : 'Persistence is off — this server is not archiving to disk, so nothing survives a restart.'}
                </div>
              )}
            </Section>
          </>
        )}

        {/* --------------------------------------------------- SOURCES */}
        {tab === 'sources' && catalog && (
          <>
            <Section title="DATA SOURCES" right={`${catalog.sources.length} providers, all keyless`}>
              <Table
                head={['SOURCE', 'CHAINS', 'RATE LIMIT', 'ROLE', 'PROVIDES']}
                rows={catalog.sources.map((s) => [
                  <span style={{ color: C.white, fontWeight: 600 }}>{s.label}</span>,
                  <span style={{ color: s.chains ? C.pink : C.grey }}>{s.chains || 'all'}</span>,
                  <span style={{ color: C.dim, fontSize: 9.5 }}>{s.limit || '—'}</span>,
                  <span style={{ color: s.role ? C.blue : C.grey, fontSize: 9.5 }}>{s.role || '—'}</span>,
                  <span style={{ color: C.dim, fontSize: 9.5 }}>{s.provides}</span>
                ])}
              />
            </Section>

            {catalog.pipeline && (
              <Section title="PIPELINE" right={`${catalog.pipeline.length} stages`}>
                <Table
                  head={['STAGE', 'WHAT HAPPENS', 'CADENCE']}
                  rows={catalog.pipeline.map((p) => [
                    <span style={{ color: C.white, fontWeight: 600, whiteSpace: 'nowrap' }}>{p.stage}</span>,
                    <span style={{ color: C.dim, fontSize: 9.5 }}>{p.detail}</span>,
                    <span style={{ color: C.blue, fontSize: 9.5 }}>{p.cadence}</span>
                  ])}
                />
              </Section>
            )}

            {catalog.panels.map((panel) => (
              <Section key={panel.panel} title={panel.panel} right={`${panel.fields.length} fields`}>
                <Table
                  head={['FIELD', 'WEIGHT', 'SOURCE', 'FRESHNESS', 'HOW IT IS CALCULATED']}
                  rows={panel.fields.map((f) => [
                    <span style={{ color: f.source === 'none yet' ? C.grey : C.white, fontWeight: 600 }}>{f.field}</span>,
                    <span style={{ color: C.faint }}>{f.weight ? f.weight + '%' : (f.modifier ? 'mod' : '—')}</span>,
                    <span style={{ color: f.source === 'none yet' ? C.hot : C.blue, fontSize: 9.5 }}>{f.source}</span>,
                    <span style={{ color: C.dim, fontSize: 9.5 }}>{f.freshness}</span>,
                    <span style={{ color: C.dim, fontSize: 9.5, fontFamily: 'monospace' }}>{f.formula}</span>
                  ])}
                />
              </Section>
            ))}
          </>
        )}

        <div style={{ fontSize: 9, color: C.grey, textAlign: 'center', marginTop: 20 }}>
          Read-only. Equations are served by the server from catalog.js, so this page cannot drift from the code.
        </div>
      </div>
    );
  }
}
