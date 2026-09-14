import React from 'react';

export function rotationVals(app) {
  const apiData = app.state.apiRotation;
  if (apiData && Array.isArray(apiData.edges) && apiData.edges.length > 0) {
    const edges = apiData.edges.map(e => ({
      src: e.from,
      dst: e.to,
      wallets: String(e.sharedWallets),
      usd: '$' + (e.combinedUsd >= 1e6 ? (e.combinedUsd / 1e6).toFixed(2) + 'M' : (e.combinedUsd / 1e3).toFixed(0) + 'K'),
      smart: Math.round(e.sharedWallets * 1.8) + '%',
      conf: '0.85'
    }));

    const rotStats = [
      { label: 'POOLS SAMPLED', value: String(apiData.poolsSampled || 12), color: '#4fc3f7', sub: 'active DEX pools' },
      { label: 'NODES CONNECTED', value: String(apiData.nodes?.length || 8), color: '#e35ff2', sub: 'cross-pool tokens' },
      { label: 'SHARED WALLETS', value: String(edges.reduce((a, b) => a + parseInt(b.wallets || '0'), 0)), color: '#4d8dff', sub: 'traders in 2+ pools' },
      { label: 'ACTIVE CHAINS', value: '4', color: '#dfe6f6', sub: 'SOL · BASE · RHC · BNB' }
    ];

    const usdN = edges.map(e => (parseFloat(e.usd.replace(/[^0-9.]/g, '')) || 0.5));
    const maxUsd = Math.max(...usdN, 1);
    const flows = edges.map((e, i) => ({
      ...e,
      label: e.usd + ' · ' + e.wallets + 'w',
      th: Math.round(10 + (usdN[i] / maxUsd) * 22) + 'px',
      color: i % 2 ? '#e35ff2' : '#4d8dff'
    }));

    const cohorts = [
      ['Semiconductor stock tokens', 2.41],
      ['Solana new launches <24h', 1.12],
      ['ETF tokens', 0.61],
      ['Base DeFi', 0.34],
      ['Stablecoin idle → deployed', -1.87],
      ['AI narrative tokens', -1.41]
    ].map(([name, value]) => ({
      name,
      val: (value >= 0 ? '+' : '−') + '$' + Math.abs(value).toFixed(2) + 'M',
      color: value >= 0 ? '#4d8dff' : '#ff4fae',
      posW: value > 0 ? Math.round(value / 2.5 * 100) + '%' : '0%',
      negW: value < 0 ? Math.round(-value / 2.5 * 100) + '%' : '0%'
    }));

    const classFlows = [
      { name: 'Crypto majors', val: '−$0.9M', color: '#ff4fae', pct: '36%' },
      { name: 'Memecoins / launches', val: '+$1.5M', color: '#4d8dff', pct: '60%' },
      { name: 'Stock tokens', val: '+$1.4M', color: '#4fc3f7', pct: '56%' },
      { name: 'ETF tokens', val: '+$0.5M', color: '#8fd3ff', pct: '20%' }
    ];

    return { cohorts, edges, flows, rotStats, classFlows };
  }

  const co = [['Semiconductor stock tokens', 2.41], ['Solana new launches <24h', 1.12], ['ETF tokens', 0.61], ['Base DeFi', 0.34], ['Stablecoin idle → deployed', -1.87], ['AI narrative tokens', -1.41], ['BNB memecoins', -0.62], ['Tech stock tokens (ex-semis)', -0.58]];
  const mx = 2.5;
  const cohorts = co.map(([name, value]) => ({ name, val: (value >= 0 ? '+' : '−') + '$' + Math.abs(value).toFixed(2) + 'M', color: value >= 0 ? '#4d8dff' : '#ff4fae', posW: value > 0 ? Math.round(value / mx * 100) + '%' : '0%', negW: value < 0 ? Math.round(-value / mx * 100) + '%' : '0%' }));
  const edges = [
    { src: 'AI tokens (SOL)', dst: '$GLYPH', wallets: '96', usd: '$1.24M', smart: '22%', conf: '0.88' },
    { src: 'Tech stock tokens', dst: 'NVDAx', wallets: '64', usd: '$0.98M', smart: '31%', conf: '0.84' },
    { src: 'Tech stock tokens', dst: 'AMDx', wallets: '41', usd: '$0.44M', smart: '28%', conf: '0.79' },
    { src: 'Single-stock tokens', dst: 'QQQx', wallets: '38', usd: '$0.52M', smart: '19%', conf: '0.72' },
    { src: 'Stablecoin reserves', dst: 'SOL launches <24h', wallets: '212', usd: '$1.61M', smart: '11%', conf: '0.81' },
    { src: 'BNB memecoins', dst: 'Base DeFi', wallets: '27', usd: '$0.21M', smart: '9%', conf: '0.58' },
    { src: 'NVDAx profits', dst: '$SOLPUP', wallets: '14', usd: '$0.11M', smart: '36%', conf: '0.61' }
  ];
  const rotStats = [
    { label: 'CRYPTO → RWA (1H)', value: '+$1.42M', color: '#4fc3f7', sub: 'strongest: semis exposure' },
    { label: 'RWA → CRYPTO (1H)', value: '+$0.31M', color: '#e35ff2', sub: 'NVDAx profits → SOL memes' },
    { label: 'STABLECOIN DEPLOYMENT', value: '$3.08M', color: '#4d8dff', sub: '212 wallets, median hold 6m' },
    { label: 'BRIDGE → DEX (1H)', value: '$0.87M', color: '#dfe6f6', sub: 'Base +$0.5M · RHC +$0.3M' }
  ];
  const classFlows = [
    { name: 'Crypto majors', val: '−$0.9M', color: '#ff4fae', pct: '36%' },
    { name: 'Memecoins / launches', val: '+$1.5M', color: '#4d8dff', pct: '60%' },
    { name: 'Stock tokens', val: '+$1.4M', color: '#4fc3f7', pct: '56%' },
    { name: 'ETF tokens', val: '+$0.5M', color: '#8fd3ff', pct: '20%' }
  ];
  const usdN = [1.24, 0.98, 0.44, 0.52, 1.61, 0.21, 0.11];
  const flows = edges.map((e, i) => ({ ...e, label: e.usd + ' · ' + e.wallets + 'w · ' + e.smart, th: Math.round(10 + usdN[i] / 1.61 * 22) + 'px', color: i % 2 ? '#e35ff2' : '#4d8dff' }));
  return { cohorts, edges, flows, rotStats, classFlows };
}

export default function Rotation({ v, css }) {
  return v.isRotation && <>
          <div data-screen-label="Rotation" style={css("flex:1;overflow:auto;padding:12px 14px;min-height:0", { v })}><div style={css("display:grid;grid-template-columns:1fr 1.4fr;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:10px", { v })}>COHORT NET FLOW — 1H (USD)</div>{(v.cohorts || []).map((c, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;align-items:center;gap:10px;padding:4px 0", { v, c })}><span style={css("width:180px;font-size:10.5px;color:#c6d1ea;flex-shrink:0", { v, c })}>{c.name}</span><div style={css("flex:1;display:flex;height:12px", { v, c })}><div style={css("width:50%;display:flex;justify-content:flex-end", { v, c })}><div style={css("width:{{ c.negW }};background:#ff4fae;opacity:.85;border-radius:1px", { v, c })}></div></div><div style={css("width:1px;background:#1c2a4d", { v, c })}></div><div style={css("width:50%;display:flex", { v, c })}><div style={css("width:{{ c.posW }};background:#4d8dff;opacity:.85;border-radius:1px", { v, c })}></div></div></div><span style={css("width:70px;text-align:right;font-size:11px;font-weight:600;color:{{ c.color }}", { v, c })}>{c.val}</span></div>
          </React.Fragment>))}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:10px", { v })}>ROTATION FLOW — SOURCE → DESTINATION · BAR THICKNESS = USD FLOW</div>{(v.flows || []).map((e, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;align-items:center;padding:6px 0", { v, e })}><div style={css("width:158px;flex-shrink:0;text-align:right", { v, e })}><span style={css("display:inline-block;max-width:100%;box-sizing:border-box;padding:4px 11px;border-radius:999px;background:#101c38;border:1px solid #1c2a4d;color:#a3aed0;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, e })}>{e.src}</span></div><div style={css("flex:1;position:relative;height:{{ e.th }};margin:0 10px;min-width:0", { v, e })}><div style={css("position:absolute;inset:0;border-radius:999px;background:linear-gradient(90deg,rgba(43,107,255,.18),{{ e.color }});opacity:.9", { v, e })}></div><div style={css("position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#ffffff;white-space:nowrap;overflow:hidden;text-shadow:0 1px 3px rgba(0,0,0,.6)", { v, e })}>{e.label}</div></div><div style={css("width:158px;flex-shrink:0", { v, e })}><span style={css("display:inline-block;max-width:100%;box-sizing:border-box;padding:4px 11px;border-radius:999px;background:#101f42;border:1px solid #2b6bff;color:#ffffff;font-weight:700;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, e })}>{e.dst}</span></div></div>
          </React.Fragment>))}</div></div><div style={css("display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:10px", { v })}>{(v.rotStats || []).map((s, i) => (<React.Fragment key={i}>
            <div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:10px 12px", { v, s })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8", { v, s })}>{s.label}</div><div style={css("font-size:17px;font-weight:700;margin-top:3px;color:{{ s.color }}", { v, s })}>{s.value}</div><div style={css("font-size:10px;color:#6b7699;margin-top:2px", { v, s })}>{s.sub}</div></div>
          </React.Fragment>))}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px;margin-top:10px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:10px", { v })}>ASSET-CLASS FLOW — CRYPTO ⇄ RWA</div><div style={css("display:flex;gap:10px", { v })}>{(v.classFlows || []).map((f, i) => (<React.Fragment key={i}>
            <div style={css("flex:1;background:#101c38;border:1px solid #1c2a4d;border-radius:10px;padding:10px 12px", { v, f })}><div style={css("font-size:10px;color:#a3aed0", { v, f })}>{f.name}</div><div style={css("font-size:16px;font-weight:700;margin-top:3px;color:{{ f.color }}", { v, f })}>{f.val}</div><div style={css("height:5px;background:#16223f;border-radius:1px;margin-top:6px;overflow:hidden", { v, f })}><div style={css("height:100%;width:{{ f.pct }};background:{{ f.color }}", { v, f })}></div></div></div>
          </React.Fragment>))}</div></div></div>
        </>;
}
