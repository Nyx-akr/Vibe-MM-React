import React from 'react';
import { fetchAdminStore, fetchCatalog, API_ORIGIN } from '../services/api';

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
const dur = (v) => {
  if (v == null) return '—';
  const m = Math.round(v / 60000);
  return m >= 60 ? (m / 60).toFixed(1) + 'h' : m + 'min';
};

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

export default class AdminPanel extends React.Component {
  constructor(props) {
    super(props);
    const params = new URLSearchParams(window.location.search);
    this.state = {
      data: null, catalog: null, error: null, loading: true,
      collection: 'poolHistory', probing: false, probe: null,
      token: params.get('token') || '', tab: 'server'
    };
  }

  componentDidMount() {
    this.load();
    this.timer = setInterval(() => this.load(), 15000);
  }
  componentWillUnmount() { clearInterval(this.timer); }

  async load(withProbe) {
    const { collection, token } = this.state;
    const [data, catalog] = await Promise.all([
      fetchAdminStore({ collection, token, probe: withProbe }),
      this.state.catalog ? Promise.resolve(this.state.catalog) : fetchCatalog()
    ]);
    this.setState({
      data, catalog, loading: false, probing: false,
      probe: (data && data.probe) || this.state.probe,
      error: data ? null : 'Could not reach the server'
    });
  }

  runProbe = () => { this.setState({ probing: true }, () => this.load(true)); };

  render() {
    const { data, catalog, loading, error, probe, collection, tab } = this.state;
    const store = data && data.store;
    const mem = data && data.memory;

    return (
      <div style={{ fontFamily: "'Poppins', sans-serif", background: `linear-gradient(180deg,${C.bg} 0%,#081736 55%,#0c2b63 140%)`,
        minHeight: '100vh', color: C.text, padding: '16px 18px 40px' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.white }}>VibeScreener <span style={{ color: C.pink }}>Admin</span></div>
          <div style={{ fontSize: 10, color: C.dim }}>{API_ORIGIN}</div>
          <div style={{ flex: 1 }} />
          <a href="/" style={{ fontSize: 11, color: C.dim, textDecoration: 'none' }}>← dashboard</a>
          <span style={{ fontSize: 9, padding: '3px 9px', borderRadius: 10,
            background: error ? '#45103a' : '#0e2a5c', color: error ? C.hot : C.blue }}>
            {loading ? 'LOADING' : error ? 'SERVER UNREACHABLE' : 'LIVE · 15s refresh'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {[['server', 'SERVER'], ['firebase', 'FIREBASE'], ['sources', 'SOURCES & EQUATIONS']].map(([k, label]) => (
            <div key={k} onClick={() => this.setState({ tab: k })}
              style={{ cursor: 'pointer', fontSize: 10, fontWeight: 600, letterSpacing: 0.8, padding: '5px 14px',
                borderRadius: 999, border: `1px solid ${tab === k ? C.pink : C.border}`,
                background: tab === k ? '#33124a' : C.panel, color: tab === k ? '#f06ee2' : C.dim }}>{label}</div>
          ))}
        </div>

        {error && (
          <Section title="CONNECTION">
            <div style={{ color: C.hot, fontSize: 12 }}>{error}. If the Render instance was asleep it may take 30–60s to wake.</div>
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
                <Stat label="PERSISTENCE" value={store.persistent ? 'FIRESTORE' : 'RAM ONLY'}
                  color={store.persistent ? C.blue : C.hot} sub={store.projectId || 'no credentials set'} />
              </Grid>
            </Section>

            <Section title="SERIES HELD IN MEMORY">
              <Grid cols={5}>
                <Stat label="POOL HISTORIES" value={num(mem.historyPools)} sub={`${data.sampling.historyMaxSamples} samples max`} />
                <Stat label="OBSERVATIONS" value={num(mem.observationTokens)} sub={`${data.sampling.observationMax} max per token`} />
                <Stat label="STAGES TRACKED" value={num(mem.stagesTracked)} />
                <Stat label="HOLDER SERIES" value={num(mem.holderSeries)} />
                <Stat label="WALLET SETS" value={num(mem.walletSetsSampled)} sub="capital rotation" />
              </Grid>
              <div style={{ fontSize: 9.5, color: C.grey, marginTop: 10, lineHeight: 1.6 }}>
                Pool samples every {data.sampling.historyGapMs / 1000}s, pruned past {dur(data.sampling.historyMaxAgeMs)} ·
                observations every {data.sampling.observationGapMs / 1000}s ·
                rotation samples 1 of {data.sampling.rotationPools} pools every {data.sampling.rotationRefreshMs / 1000}s
              </div>
            </Section>

            <Section title="UPSTREAM PROVIDERS" right={`${num(data.upstream.total)} calls over ${dur(data.upstream.windowSeconds * 1000)}`}>
              <Table
                head={['PROVIDER', 'CALLS', 'PER MIN', 'MEDIAN', 'ERRORS', 'LAST ERROR']}
                rows={Object.keys(data.upstream.byHost).sort((a, b) => data.upstream.byHost[b] - data.upstream.byHost[a]).map((host) => {
                  const lat = data.upstream.latency[host] || {};
                  const rate = data.upstream.perMinute[host];
                  const hot = host.indexOf('geckoterminal') !== -1 && rate > 25;
                  return [
                    <span style={{ color: C.text }}>{host}</span>,
                    num(data.upstream.byHost[host]),
                    <span style={{ color: hot ? C.hot : C.text }}>{rate}</span>,
                    ms(lat.medianMs),
                    <span style={{ color: lat.errors ? C.hot : C.grey }}>{lat.errors || 0}</span>,
                    <span style={{ color: C.grey, fontSize: 9.5 }}>{lat.lastError || '—'}</span>
                  ];
                })}
              />
            </Section>
          </>
        )}

        {/* -------------------------------------------------- FIREBASE */}
        {tab === 'firebase' && data && (
          <>
            <Section title="FIRESTORE READ / WRITE TIME" right={
              <span onClick={this.runProbe} style={{ cursor: 'pointer', color: C.pink, fontWeight: 600 }}>
                {this.state.probing ? 'testing…' : 'run live test ▸'}
              </span>
            }>
              <Grid cols={4}>
                <Stat label="WRITE · LAST" value={ms(store.writeLatency.last)}
                  sub={`avg ${ms(store.writeLatency.avg)} · ${store.writeLatency.samples} samples`} />
                <Stat label="WRITE · RANGE" value={`${ms(store.writeLatency.min)} – ${ms(store.writeLatency.max)}`} />
                <Stat label="READ · LAST" value={ms(store.readLatency.last)}
                  sub={`avg ${ms(store.readLatency.avg)} · ${store.readLatency.samples} samples`} />
                <Stat label="READ · RANGE" value={`${ms(store.readLatency.min)} – ${ms(store.readLatency.max)}`} />
              </Grid>
              {probe && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
                  <Grid cols={4}>
                    <Stat label="PROBE WRITE" value={ms(probe.writeMs)} color={C.pink} />
                    <Stat label="PROBE READ" value={ms(probe.readMs)} color={C.pink} />
                    <Stat label="ROUND TRIP" value={ms(probe.roundTripMs)} color={C.pink} />
                    <Stat label="VERIFIED" value={probe.verified ? 'YES' : 'NO'} color={probe.verified ? C.blue : C.hot}
                      sub={probe.error || 'wrote then read back the same value'} />
                  </Grid>
                </div>
              )}
            </Section>

            <Section title="WRITE ACTIVITY">
              <Grid cols={6}>
                <Stat label="DOCS WRITTEN" value={num(store.writes)} sub="this process" />
                <Stat label="DOCS READ" value={num(store.reads)} sub="on boot" />
                <Stat label="ERRORS" value={num(store.errors)} color={store.errors ? C.hot : C.text}
                  sub={store.lastError || 'none'} />
                <Stat label="LAST FLUSH" value={ago(store.lastFlushAt)}
                  sub={`${store.lastFlushDocs || 0} docs in ${ms(store.lastFlushMs)}`} />
                <Stat label="FLUSH EVERY" value={dur(store.flushIntervalMs)}
                  sub={`observations ${dur(store.observationFlushIntervalMs)}`} />
                <Stat label="BOOT RESTORE" value={ms(store.lastLoadMs)} sub={ago(store.loadedAt)} />
              </Grid>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.line}` }}>
                <div style={{ fontSize: 9, color: C.faint, marginBottom: 6 }}>QUEUED FOR NEXT FLUSH</div>
                <Grid cols={4}>
                  <Stat label="POOLS" value={num(store.pending.pools)} />
                  <Stat label="OBSERVATIONS" value={num(store.pending.observations)} />
                  <Stat label="STAGES" value={num(store.pending.stages)} />
                  <Stat label="HOLDERS" value={num(store.pending.holders)} />
                </Grid>
              </div>
              <div style={{ fontSize: 9.5, color: C.grey, marginTop: 10 }}>
                Estimated ~{Math.round((mem.historyPools * (86400000 / store.flushIntervalMs)) +
                  (mem.observationTokens * (86400000 / store.observationFlushIntervalMs)))} writes/day
                against Firestore's free 20,000/day.
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
                  {store.persistent ? (data.inspectError || 'No documents in this collection yet.')
                    : 'Persistence is off — set FIREBASE_SERVICE_ACCOUNT on the server.'}
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
                head={['SOURCE', 'CHAINS', 'RATE LIMIT', 'PROVIDES']}
                rows={catalog.sources.map((s) => [
                  <span style={{ color: C.white, fontWeight: 600 }}>{s.label}</span>,
                  <span style={{ color: s.chains ? C.pink : C.grey }}>{s.chains || 'all'}</span>,
                  <span style={{ color: C.dim, fontSize: 9.5 }}>{s.limit || '—'}</span>,
                  <span style={{ color: C.dim, fontSize: 9.5 }}>{s.provides}</span>
                ])}
              />
            </Section>

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
