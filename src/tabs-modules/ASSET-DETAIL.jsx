import React from 'react';
import { fmtUsd, fmtPrice, stageInfo, clsColor, scoreColor, washColor } from '../utils/formatters';

export function detailVals(app, a, showAdj) {
    if (!a) {
      return {
        sym: '—', name: '—', stage: '—', stageBg: '#1a2440', stageFg: '#a3aed0', cls: '—', clsColor: '#a3aed0', canonical: false,
        score: 0, scoreColor: '#a3aed0', conf: '0.00', raw: 0, penalty: 0,
        price: '$0.00', chg: '0.0%', chgColor: '#a3aed0',
        spark: [], market: [], outcomes: [], subs: [], isStock: false, oracle: [],
        reasons: [], flags: [], stages: [], hysteresis: ''
      };
    }
    const si = stageInfo(a.stage); const raw = Math.round(a.score + (a.wash * 30 + (a.flags.some(f => f.sev === 'HIGH') ? 6 : 2)));
    const subNames = [['Volume anomaly', '13%'], ['Trade activity', '8%'], ['Buyer breadth', '12%'], ['Net demand', '10%'], ['Liquidity / executability', '14%'], ['Price confirmation', '8%'], ['Holder growth', '7%'], ['Wallet quality', '8%'], ['Capital rotation', '8%'], ['Cross-venue confirm', '4%'], ['Oracle confirmation', '3%'], ['Data quality', '5%'], ['Organic probability', '—'], ['Contract safety', '—']];
    const r = app.srand(app.h(a.id + 's'));
    const subs = subNames.map(([k, w], i) => {
      let v = Math.max(15, Math.min(98, Math.round(a.score + (r() - 0.5) * 30)));
      if (k === 'Oracle confirmation') v = a.cls === 'STOCK' || a.cls === 'ETF' ? 95 : 0;
      if (k === 'Organic probability') v = Math.round((1 - a.wash) * 100);
      if (k === 'Contract safety') v = a.canonical ? 96 : Math.max(30, 90 - Math.round(a.wash * 80));
      return { k, w, v, pct: v + '%', c: v >= 75 ? '#4d8dff' : v >= 50 ? '#e35ff2' : v > 0 ? '#ff4fae' : '#223052' };
    });
    const spMax = Math.max(...a.spark), spMin = Math.min(...a.spark);
    const spark = a.spark.map((v, i) => ({ h: Math.round(8 + (v - spMin) / (spMax - spMin + 0.01) * 92) + '%', c: i === a.spark.length - 1 ? '#e35ff2' : v >= (a.spark[i - 1] ?? v) ? '#2f66d0' : '#8a2f7c' }));
    const market = [
      { k: 'MKT CAP', v: fmtUsd(a.liq * (a.cls === 'STOCK' || a.cls === 'ETF' ? 900 : 14)), c: '#dfe6f6' }, { k: 'LIQUIDITY', v: fmtUsd(a.liq), c: '#dfe6f6' },
      { k: showAdj ? 'VOL 5M ADJ' : 'VOL 5M RAW', v: fmtUsd(showAdj ? a.adj : a.vol), c: '#dfe6f6' }, { k: 'NET BUY 5M', v: fmtUsd(a.nf), c: a.nf >= 0 ? '#4d8dff' : '#ff4fae' },
      { k: 'BUYERS 5M', v: String(a.buyers), c: '#dfe6f6' }, { k: 'WASH PROB', v: Math.round(a.wash * 100) + '%', c: washColor(a.wash) },
      { k: 'IMPACT $10K', v: (a.liq > 1e6 ? '0.1' : a.liq > 3e5 ? '0.9' : a.liq > 1e5 ? '2.4' : '8.1') + '%', c: a.liq > 1e5 ? '#dfe6f6' : '#ff4fae' }, { k: 'ORGANIC PROB', v: (1 - a.wash).toFixed(2), c: '#dfe6f6' }];
    const outcomes = [{ k: '15M', v: '+3.1%', c: '#4d8dff' }, { k: '1H', v: 'PENDING', c: '#6b7699' }, { k: '4H', v: 'PENDING', c: '#6b7699' }, { k: '12H', v: 'PENDING', c: '#6b7699' }, { k: '24H', v: 'PENDING', c: '#6b7699' }];
    const sev = { HIGH: { bg: '#45103a', fg: '#ff4fae' }, MED: { bg: '#33124a', fg: '#e35ff2' }, LOW: { bg: '#1a2440', fg: '#a3aed0' } };
    const oracle = a.oracle ? [{ k: 'Underlying', v: a.tick, c: '#4fc3f7' }, { k: 'Feed', v: a.oracle.feed, c: '#dfe6f6' }, { k: 'Freshness', v: a.oracle.fresh, c: '#4d8dff' }, { k: 'Exec↔oracle dev', v: a.oracle.dev, c: '#4d8dff' }, { k: 'Sequencer', v: a.oracle.seq, c: '#4d8dff' }, { k: 'UI multiplier', v: a.oracle.mult, c: '#dfe6f6' }, { k: 'Pending mult', v: a.oracle.pend, c: '#6b7699' }, { k: 'Ref session', v: a.oracle.session, c: '#4d8dff' }, { k: 'Corp action', v: a.oracle.corp, c: '#6b7699' }, { k: 'Contract', v: 'CANONICAL', c: '#4d8dff' }] : [];
    return {
      sym: a.sym, name: a.name, stage: si.n, stageBg: si.bg, stageFg: si.fg, cls: a.cls, clsColor: clsColor(a.cls), canonical: a.canonical,
      score: Math.round(a.score), scoreColor: scoreColor(a.score), conf: a.conf.toFixed(2), raw: raw, penalty: raw - Math.round(a.score),
      price: fmtPrice(a.price), chg: (a.chg >= 0 ? '+' : '') + (a.chg * 100).toFixed(1) + '%', chgColor: a.chg >= 0 ? '#4d8dff' : '#ff4fae',
      spark, market, outcomes, subs, isStock: !!a.oracle, oracle, ...bubbleVals(app, a),
      reasons: a.reasons.map(x => ({ code: x.code, win: x.win, text: x.text, z: x.z, ratio: x.ratio })),
      flags: a.flags.map(f => ({ sev: f.sev, bg: sev[f.sev].bg, fg: sev[f.sev].fg, text: f.text })),
      stages: ['WATCH', 'EMERGING', 'CONFIRMED', 'EXCEPTIONAL'].map((n, i) => {
        const idx = i + 1, s2 = stageInfo(idx), on = a.stage >= idx;
        return { n, bg: on ? s2.bg : 'transparent', fg: on ? s2.fg : '#3a4568', bd: on ? s2.fg : '#1c2a4d', t: on ? ['14:07', '14:19', '14:26', '14:31'][i] : '—', hasNext: i < 3, lineC: a.stage > idx ? '#e35ff2' : '#1c2a4d' };
      }),
      hysteresis: 'Hysteresis band ±3 pts — entered ' + si.n + ' at ' + [0, 55, 68, 80, 90][a.stage] + ', demotes below ' + ([0, 55, 68, 80, 90][a.stage] - 3) + '. Stage never flips on 1–2 pt score noise.'
    };
  }

export function bubbleVals(app, a) {
    if (!a.bundle) return { hasBubbles: false, bubbles: [], bundleStats: [], bubbleLinks: [] };
    const r = app.srand(app.h(a.id + 'bub'));
    const bubbles = []; const cx = 50, cy = 50;
    // cluster of bundled wallets around funder + independent holders
    bubbles.push({ x: '30%', y: '42%', s: '26px', c: '#ff4fae', op: '1', label: 'FUNDER' });
    for (let i = 0; i < a.bundle.sameBlock; i++) {
      const ang = r() * 6.28, d = 12 + r() * 14;
      bubbles.push({ x: (30 + Math.cos(ang) * d) + '%', y: (42 + Math.sin(ang) * d * 0.8) + '%', s: (8 + r() * 8) + 'px', c: '#ff4fae', op: '0.75', label: '' });
    }
    for (let i = 0; i < 16; i++) { bubbles.push({ x: (58 + r() * 36) + '%', y: (12 + r() * 76) + '%', s: (6 + r() * 13) + 'px', c: '#4d8dff', op: '0.65', label: '' }); }
    bubbles.push({ x: '72%', y: '30%', s: '22px', c: '#8fd3ff', op: '0.9', label: 'POOL' });
    const b = a.bundle;
    return {
      hasBubbles: true, bubbles,
      bundleStats: [
        { k: 'Bundle probability', v: b.prob.toFixed(2), c: b.prob >= 0.5 ? '#ff4fae' : '#e35ff2' },
        { k: 'Same-block launch buyers', v: b.sameBlock + ' of ' + b.launchBuyers, c: '#ff4fae' },
        { k: 'Common funding source', v: b.funder, c: '#ffffff' },
        { k: 'Cluster supply share', v: b.supplyPct + '%', c: b.supplyPct >= 30 ? '#ff4fae' : '#e35ff2' },
        { k: 'Liquidity wash cycles', v: b.liqCycles + '× (' + fmtUsd(b.liqCycleUsd) + ' each)', c: '#ff4fae' }]
    };
  }

export default function AssetDetail({ v, css }) {
  return v.isDetail && <>
          <div data-screen-label="Asset detail" style={css("flex:1;overflow:auto;padding:12px 14px;min-height:0", { v })}><div style={css("display:flex;align-items:center;gap:14px;margin-bottom:12px", { v })}><div className="h9e06f470" onClick={v.goLive} style={css("cursor:pointer;color:#8b96b8;font-size:11px", { v })}>← FEED</div><div style={css("font-size:20px;font-weight:700;color:#ffffff", { v })}>{v.d.sym}</div><div style={css("color:#8b96b8", { v })}>{v.d.name}</div><span style={css("font-size:9px;font-weight:700;letter-spacing:.6px;padding:3px 8px;border-radius:10px;background:{{ d.stageBg }};color:{{ d.stageFg }}", { v })}>{v.d.stage}</span><span style={css("font-size:9px;padding:2px 6px;border:1px solid {{ d.clsColor }};color:{{ d.clsColor }};border-radius:10px", { v })}>{v.d.cls}</span>{v.d.canonical && (<>
            <span style={css("font-size:9px;padding:2px 6px;background:#0e2a5c;color:#4d8dff;border-radius:10px;font-weight:700", { v })}>✓ CANONICAL CONTRACT</span>
          </>)}<div style={css("flex:1", { v })}></div><div style={css("text-align:right", { v })}><div style={css("font-size:9px;color:#8b96b8;letter-spacing:1px", { v })}>FINAL SCORE</div><div style={css("font-size:24px;font-weight:700;color:{{ d.scoreColor }}", { v })}>{v.d.score}</div></div><div style={css("text-align:right", { v })}><div style={css("font-size:9px;color:#8b96b8;letter-spacing:1px", { v })}>CONFIDENCE</div><div style={css("font-size:24px;font-weight:700;color:#dfe6f6", { v })}>{v.d.conf}</div></div></div><div style={css("display:flex;align-items:center;background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px 16px;margin-bottom:12px", { v })}>{(v.d.stages || []).map((sg, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;align-items:center", { v, sg })}><div style={css("display:flex;flex-direction:column;align-items:center;gap:4px", { v, sg })}><span style={css("font-size:9px;font-weight:800;letter-spacing:.6px;padding:4px 12px;border-radius:999px;background:{{ sg.bg }};color:{{ sg.fg }};border:1px solid {{ sg.bd }}", { v, sg })}>{sg.n}</span><span style={css("font-size:9px;color:#6b7699", { v, sg })}>{sg.t}</span></div>{sg.hasNext && (<>
              <div style={css("width:54px;height:2px;background:{{ sg.lineC }};margin:0 6px 16px", { v, sg })}></div>
            </>)}</div>
          </React.Fragment>))}<div style={css("flex:1", { v })}></div><div style={css("font-size:10px;color:#8b96b8;text-align:right;line-height:1.5;max-width:380px", { v })}>{v.d.hysteresis}</div></div><div style={css("display:grid;grid-template-columns:1.5fr 1fr;gap:10px", { v })}><div style={css("display:flex;flex-direction:column;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("display:flex;justify-content:space-between;margin-bottom:8px", { v })}><span style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600", { v })}>EXECUTION PRICE — 1M BARS</span><span style={css("font-size:10px;color:#8b96b8", { v })}>{v.d.price} <span style={css("color:{{ d.chgColor }}", { v })}>{v.d.chg} 5M</span></span></div><div style={css("display:flex;align-items:flex-end;gap:2px;height:110px", { v })}>{(v.d.spark || []).map((b, i) => (<React.Fragment key={i}>
            <div style={css("flex:1;background:{{ b.c }};height:{{ b.h }};border-radius:1px 1px 0 0", { v, b })}></div>
          </React.Fragment>))}</div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>MARKET</div><div style={css("display:grid;grid-template-columns:repeat(4,1fr);gap:10px", { v })}>{(v.d.market || []).map((m, i) => (<React.Fragment key={i}>
            <div><div style={css("font-size:9px;color:#6b7699;letter-spacing:.6px", { v, m })}>{m.k}</div><div style={css("font-size:13px;font-weight:600;margin-top:2px;color:{{ m.c }}", { v, m })}>{m.v}</div></div>
          </React.Fragment>))}</div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>TRIGGER REASONS</div>{(v.d.reasons || []).map((rr, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;gap:12px;align-items:baseline;padding:5px 0;border-bottom:1px solid #16223f", { v, rr })}><span style={css("width:190px;font-size:10px;font-weight:700;color:#e35ff2;flex-shrink:0", { v, rr })}>{rr.code}</span><span style={css("width:46px;color:#8b96b8;font-size:10px", { v, rr })}>{rr.win}</span><span style={css("flex:1;font-size:11px;color:#c6d1ea", { v, rr })}>{rr.text}</span><span style={css("font-size:10px;color:#8b96b8", { v, rr })}>z <span style={css("color:#ffffff;font-weight:600", { v, rr })}>{rr.z}</span></span><span style={css("font-size:10px;color:#8b96b8", { v, rr })}>×<span style={css("color:#ffffff;font-weight:600", { v, rr })}>{rr.ratio}</span></span></div>
          </React.Fragment>))}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>OUTCOME TRACKING</div><div style={css("display:grid;grid-template-columns:repeat(5,1fr);gap:10px", { v })}>{(v.d.outcomes || []).map((o, i) => (<React.Fragment key={i}>
            <div style={css("background:#101c38;border:1px solid #1c2a4d;border-radius:10px;padding:8px 10px;text-align:center", { v, o })}><div style={css("font-size:9px;color:#6b7699;letter-spacing:1px", { v, o })}>{o.k}</div><div style={css("font-size:14px;font-weight:700;margin-top:3px;color:{{ o.c }}", { v, o })}>{o.v}</div></div>
          </React.Fragment>))}</div></div></div><div style={css("display:flex;flex-direction:column;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>SCORE DECOMPOSITION</div>{(v.d.subs || []).map((s, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;align-items:center;gap:8px;padding:2.5px 0", { v, s })}><span style={css("width:150px;font-size:10px;color:#a3aed0;flex-shrink:0", { v, s })}>{s.k}</span><span style={css("width:30px;font-size:9px;color:#6b7699", { v, s })}>{s.w}</span><div style={css("flex:1;height:7px;background:#16223f;border-radius:1px;overflow:hidden", { v, s })}><div style={css("height:100%;width:{{ s.pct }};background:{{ s.c }}", { v, s })}></div></div><span style={css("width:26px;text-align:right;font-size:10px;font-weight:600;color:#dfe6f6", { v, s })}>{s.v}</span></div>
          </React.Fragment>))}<div style={css("display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid #1c2a4d;font-size:10px", { v })}><span style={css("color:#8b96b8", { v })}>RAW <span style={css("color:#ffffff;font-weight:700", { v })}>{v.d.raw}</span></span><span style={css("color:#8b96b8", { v })}>RISK PENALTY <span style={css("color:#ff4fae;font-weight:700", { v })}>−{v.d.penalty}</span></span><span style={css("color:#8b96b8", { v })}>FINAL <span style={css("color:{{ d.scoreColor }};font-weight:700", { v })}>{v.d.score}</span></span></div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>RISK FLAGS</div>{(v.d.flags || []).map((f, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;gap:8px;align-items:baseline;padding:4px 0", { v, f })}><span style={css("font-size:9px;font-weight:700;padding:2px 6px;border-radius:10px;background:{{ f.bg }};color:{{ f.fg }};flex-shrink:0", { v, f })}>{f.sev}</span><span style={css("font-size:11px;color:#c6d1ea", { v, f })}>{f.text}</span></div>
          </React.Fragment>))}</div>{v.d.hasBubbles && (<>
            <div style={css("background:#0a1226;border:1px solid #45103a;border-radius:10px;padding:12px", { v })}><div style={css("display:flex;justify-content:space-between;align-items:center;margin-bottom:8px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#ff4fae;font-weight:700", { v })}>BUNDLE MAP — WALLET CLUSTERS · via Bubblemaps</div><a href="https://bubblemaps.io" target="_blank" style={css("font-size:9px;color:#6b7699", { v })}>open in Bubblemaps ↗</a></div><div style={css("position:relative;height:190px;background:#0d1730;border:1px solid #16223f;border-radius:10px;overflow:hidden", { v })}>{(v.d.bubbles || []).map((b, i) => (<React.Fragment key={i}>
              <div style={css("position:absolute;left:{{ b.x }};top:{{ b.y }};width:{{ b.s }};height:{{ b.s }};border-radius:50%;background:{{ b.c }};opacity:{{ b.op }};transform:translate(-50%,-50%)", { v, b })}></div>
            </React.Fragment>))}<div style={css("position:absolute;left:30%;top:16%;transform:translateX(-50%);font-size:8px;font-weight:800;letter-spacing:.6px;color:#ff4fae", { v })}>BUNDLED CLUSTER</div><div style={css("position:absolute;left:76%;top:78%;transform:translateX(-50%);font-size:8px;font-weight:800;letter-spacing:.6px;color:#4d8dff", { v })}>INDEPENDENT HOLDERS</div></div><div style={css("margin-top:9px", { v })}>{(v.d.bundleStats || []).map((bs, i) => (<React.Fragment key={i}>
              <div style={css("display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid #16223f;font-size:10.5px", { v, bs })}><span style={css("color:#8b96b8", { v, bs })}>{bs.k}</span><span style={css("font-weight:700;color:{{ bs.c }};flex-shrink:0", { v, bs })}>{bs.v}</span></div>
            </React.Fragment>))}</div><div style={css("font-size:9.5px;color:#6b7699;margin-top:8px;line-height:1.55", { v })}>Red bubbles share a funding source and bought within the launch block window. Cluster supply share and liquidity in/out cycling both feed the wash-probability penalty above.</div></div>
          </>)}{v.d.isStock && (<>
            <div style={css("background:#0a1226;border:1px solid #16406e;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#4fc3f7;font-weight:600;margin-bottom:8px", { v })}>STOCK TOKEN / ORACLE</div><div style={css("display:grid;grid-template-columns:1fr 1fr;gap:8px 14px", { v })}>{(v.d.oracle || []).map((o, i) => (<React.Fragment key={i}>
              <div style={css("display:flex;justify-content:space-between;font-size:10.5px;border-bottom:1px solid #16223f;padding:3px 0", { v, o })}><span style={css("color:#6b7699", { v, o })}>{o.k}</span><span style={css("font-weight:600;color:{{ o.c }}", { v, o })}>{o.v}</span></div>
            </React.Fragment>))}</div></div>
          </>)}</div></div></div>
        </>
}
