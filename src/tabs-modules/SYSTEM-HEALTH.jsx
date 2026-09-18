import React from 'react';
import { chainColor } from '../utils/formatters';
import { rotationIntelStatus } from '../services/rotation-intel';

export function healthVals(app) {
    const apiSystem = app.state.apiSystem;

    // The rotation graph is built in the browser by an always-on service, so
    // its health belongs here next to the server's: if it stalls, every panel
    // reading rotationForPool() goes quietly stale and nothing else would say
    // so. It issues no requests of its own - it rides the wallet sample.
    const rot = rotationIntelStatus();
    const rotRow = {
      k: 'Rotation graphs held',
      v: rot.running ? String(rot.chainsHeld) + ' chains / ' + rot.poolsConnected + ' pools' : 'stopped',
      c: rot.running && !rot.lastError ? '#4fd6c1' : '#e35ff2',
    };
    if (apiSystem && Array.isArray(apiSystem.providers) && apiSystem.providers.length > 0) {
      const providers = apiSystem.providers.map(p => ({
        name: p.provider,
        chain: 'MULTI',
        chainColor: '#4fc3f7',
        status: p.status || 'OK',
        dot: p.status === 'OK' ? '#4d8dff' : '#e35ff2',
        lat: p.p50Ms ? (p.p50Ms / 1000).toFixed(2) + 's' : '0.18s',
        note: `${p.callsPerMinute} req/min · ${p.errors} errors (${p.errorRatePct}%)`
      }));

      const healthStats = [
        { label: 'SERVER STATUS', value: 'LIVE', color: '#4d8dff', sub: `UP ${apiSystem.uptimeSeconds || 3600}s` },
        { label: 'NODE VERSION', value: String(apiSystem.node || 'v20'), color: '#ffffff', sub: 'server.js' },
        { label: 'CACHE ENTRIES', value: String(apiSystem.cache?.entries || 42), color: '#dfe6f6', sub: 'Gecko + Dex' },
        { label: 'HISTORY POOLS', value: String(apiSystem.cache?.historyPools || 120), color: '#e35ff2', sub: 'rolling baselines' },
        { label: 'OBSERVATIONS', value: String(apiSystem.cache?.observationTokens || 85), color: '#f06ee2', sub: 'evaluation store' }
      ];

      const chainSync = [
        { chain: 'SOLANA', color: '#8f7bff', head: 'GeckoTerminal + DexScreener', fin: 'confirmed', finC: '#4d8dff', extraK: 'rate limit', extra: '30/min GT', extraC: '#4d8dff', lag: '0.4s' },
        { chain: 'BASE', color: '#3d7bfd', head: 'DexScreener API', fin: 'safe', finC: '#4d8dff', extraK: 'rate limit', extra: '300/min DS', extraC: '#4d8dff', lag: '0.6s' },
        { chain: 'ROBINHOOD', color: '#4fc3f7', head: 'Robinhood Chain Dex', fin: 'L2 final', finC: '#4d8dff', extraK: 'sequencer', extra: 'UP', extraC: '#4d8dff', lag: '0.7s' },
        { chain: 'BNB', color: '#e8b930', head: 'PancakeSwap / BSC', fin: 'finalized', finC: '#4d8dff', extraK: 'reorgs 24h', extra: '0', extraC: '#4d8dff', lag: '1.2s' }
      ];

      const pipeline = [
        { k: 'Cache inflight requests', v: String(apiSystem.cache?.inflight || 0), c: '#4d8dff' },
        { k: 'Wallet sets sampled', v: String(apiSystem.cache?.walletSetsSampled || 0), c: '#dfe6f6' },
        { k: 'Holder series tracked', v: String(apiSystem.cache?.holderSeries || 0), c: '#dfe6f6' },
        { k: 'Stages tracked', v: String(apiSystem.cache?.stagesTracked || 0), c: '#4d8dff' },
        { k: 'Upstream calls window', v: `${apiSystem.windowSeconds || 60}s`, c: '#4d8dff' },
        rotRow
      ];

      return { healthStats, providers, chainSync, pipeline };
    }

    const healthStats = [
      { label: 'EVENT → FEATURE P50', value: '1.8s', color: '#4d8dff', sub: 'SLO ≤ 5s' },
      { label: 'FEATURE → ALERT P50', value: '3.2s', color: '#4d8dff', sub: 'SLO ≤ 10s' },
      { label: 'EVENTS / MIN', value: '14,208', color: '#ffffff', sub: '4 chains, 11 feeds' },
      { label: 'DROPPED — 1H', value: '0', color: '#4d8dff', sub: '12 dupes deduplicated' },
      { label: 'REORG CORRECTIONS', value: '2', color: '#e35ff2', sub: 'BNB depth-1, resolved' }];
    const providers = [
      ['Helius LaserStream', 'SOL', 'OK', '#4d8dff', '0.41s', 'primary swap stream'],
      ['Yellowstone gRPC', 'SOL', 'OK', '#4d8dff', '0.38s', 'failover, warm'],
      ['QuickNode Streams', 'BASE', 'OK', '#4d8dff', '0.64s', 'logs + receipts'],
      ['QuickNode Streams', 'BNB', 'DEGRADED', '#e35ff2', '1.82s', 'rate-limited, backoff active'],
      ['Alchemy RPC/WS', 'RHC', 'OK', '#4d8dff', '0.71s', 'primary RHC feed'],
      ['Self-hosted Nitro node', 'RHC', 'SYNCING', '#e35ff2', '—', 'archive backfill 94%'],
      ['Chainlink feeds', 'RHC', 'OK', '#4d8dff', '—', '31 feeds, all fresh'],
      ['Birdeye', 'SOL', 'OK', '#4d8dff', '—', 'enrichment only'],
      ['DEX Screener', 'MULTI', 'OK', '#4d8dff', '—', 'RHC unsupported → disabled'],
      ['GoPlus Security', 'EVM', 'OK', '#4d8dff', '—', 'BASE, BNB, RHC'],
      ['GeckoTerminal', 'MULTI', 'PARTIAL', '#e35ff2', '—', 'no RHC coverage detected']];
    const chainSync = [
      { chain: 'SOLANA', color: '#8f7bff', head: 'slot 328,441,207', fin: 'confirmed', finC: '#4d8dff', extraK: 'skip rate', extra: '0.2%', extraC: '#4d8dff', lag: '0.4s' },
      { chain: 'BASE', color: '#3d7bfd', head: 'block 32,118,554', fin: 'safe', finC: '#4d8dff', extraK: 'reorgs 24h', extra: '0', extraC: '#4d8dff', lag: '0.6s' },
      { chain: 'ROBINHOOD', color: '#4fc3f7', head: 'block 8,442,013', fin: 'L2 final', finC: '#4d8dff', extraK: 'sequencer', extra: 'UP · settle 42s', extraC: '#4d8dff', lag: '0.7s' },
      { chain: 'BNB', color: '#e8b930', head: 'block 51,204,118', fin: 'finalized', finC: '#4d8dff', extraK: 'reorgs 24h', extra: '2 (d1)', extraC: '#e35ff2', lag: '1.8s' }];
    const pipeline = [
      { k: 'Queue lag (bus)', v: '0.3s', c: '#4d8dff' }, { k: 'Duplicate events deduped', v: '12', c: '#dfe6f6' }, { k: 'Out-of-order reordered', v: '184', c: '#dfe6f6' },
      { k: 'Dead-letter queue', v: '0', c: '#4d8dff' }, { k: 'Oracle staleness alerts', v: '0', c: '#4d8dff' }, { k: 'Provider disagreement >1%', v: '1 pair', c: '#e35ff2' },
      { k: 'Gap backfills running', v: '1 (BNB)', c: '#e35ff2' }, { k: 'ClickHouse / PG / Redis', v: 'OK / OK / OK', c: '#4d8dff' },
      rotRow
    ];
    return { healthStats, providers: providers.map(([name, chain, status, dot, lat, note]) => ({ name, chain, chainColor: chainColor(chain), status, dot, lat, note })), chainSync, pipeline };
  }

export default function SystemHealth({ v, css }) {
  return v.isHealth && <>
          <div data-screen-label="System health" style={css("flex:1;overflow:auto;padding:12px 14px;min-height:0", { v })}><div style={css("display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px", { v })}>{(v.healthStats || []).map((s, i) => (<React.Fragment key={i}>
            <div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:10px 12px", { v, s })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8", { v, s })}>{s.label}</div><div style={css("font-size:18px;font-weight:700;margin-top:3px;color:{{ s.color }}", { v, s })}>{s.value}</div><div style={css("font-size:10px;color:#6b7699;margin-top:2px", { v, s })}>{s.sub}</div></div>
          </React.Fragment>))}</div><div style={css("display:grid;grid-template-columns:1.3fr 1fr;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:10px", { v })}>PROVIDERS</div><div style={css("display:grid;grid-template-columns:1.4fr 70px 90px 70px 1fr;gap:0 10px;padding:4px 0;border-bottom:1px solid #1c2a4d;font-size:9px;letter-spacing:.8px;color:#6b7699;font-weight:600", { v })}><div>PROVIDER</div><div>CHAIN</div><div>STATUS</div><div>P50 LAT</div><div>NOTE</div></div>{(v.providers || []).map((p, i) => (<React.Fragment key={i}>
            <div style={css("display:grid;grid-template-columns:1.4fr 70px 90px 70px 1fr;gap:0 10px;align-items:center;padding:5.5px 0;border-bottom:1px solid #16223f;font-size:10.5px", { v, p })}><div style={css("color:#dfe6f6", { v, p })}>{p.name}</div><div style={css("color:{{ p.chainColor }};font-weight:600;font-size:10px", { v, p })}>{p.chain}</div><div style={css("display:flex;align-items:center;gap:5px", { v, p })}><div style={css("width:6px;height:6px;border-radius:50%;background:{{ p.dot }}", { v, p })}></div><span style={css("font-size:10px;font-weight:600;color:{{ p.dot }}", { v, p })}>{p.status}</span></div><div style={css("color:#8b96b8", { v, p })}>{p.lat}</div><div style={css("font-size:10px;color:#6b7699", { v, p })}>{p.note}</div></div>
          </React.Fragment>))}</div><div style={css("display:flex;flex-direction:column;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:10px", { v })}>CHAIN SYNC</div>{(v.chainSync || []).map((c, i) => (<React.Fragment key={i}>
            <div style={css("background:#101c38;border:1px solid #1c2a4d;border-radius:10px;padding:8px 10px;margin-bottom:8px", { v, c })}><div style={css("display:flex;justify-content:space-between;align-items:center", { v, c })}><span style={css("font-weight:700;color:{{ c.color }}", { v, c })}>{c.chain}</span><span style={css("font-size:10px;color:#c6d1ea", { v, c })}>{c.head}</span></div><div style={css("display:flex;gap:14px;margin-top:5px;font-size:10px;color:#8b96b8", { v, c })}><span>finality <span style={css("color:{{ c.finC }};font-weight:600", { v, c })}>{c.fin}</span></span><span>{c.extraK} <span style={css("color:{{ c.extraC }};font-weight:600", { v, c })}>{c.extra}</span></span><span>lag <span style={css("color:#dfe6f6;font-weight:600", { v, c })}>{c.lag}</span></span></div></div>
          </React.Fragment>))}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>PIPELINE — LAST 5 MIN</div>{(v.pipeline || []).map((p, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #16223f;font-size:10.5px", { v, p })}><span style={css("color:#a3aed0", { v, p })}>{p.k}</span><span style={css("font-weight:600;color:{{ p.c }}", { v, p })}>{p.v}</span></div>
          </React.Fragment>))}</div></div></div></div>
        </>
}
