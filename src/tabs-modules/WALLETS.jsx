import React from 'react';
import { chainColor } from '../utils/formatters';

export function walletsVals(app) {
    const st = app.state;
    const apiWallets = st.apiWallets;
    const tagStyle = (t) => ({ BUNDLER: { bg: '#45103a', fg: '#ff4fae' }, 'LIQ WASHER': { bg: '#45103a', fg: '#ff4fae' }, 'WASH TRADER': { bg: '#33124a', fg: '#e35ff2' }, TRACKED: { bg: '#0e2a5c', fg: '#4d8dff' } }[t] || { bg: '#1a2440', fg: '#a3aed0' });

    let sourceRegistry = st.registry;
    if (apiWallets && Array.isArray(apiWallets.rows) && apiWallets.rows.length > 0) {
      const liveRows = apiWallets.rows.map(w => ({
        addr: w.address.length > 12 ? w.address.slice(0, 4) + '…' + w.address.slice(-4) : w.address,
        chain: (w.symbols && w.symbols[0]) ? w.symbols[0].slice(0, 3).toUpperCase() : 'SOL',
        label: (w.label || 'TRACKED') + ' (' + (w.symbols && w.symbols.length ? w.symbols.join(', ') : 'Multi-token') + ')',
        tag: w.poolsTouched >= 3 ? 'BUNDLER' : w.poolsTouched >= 2 ? 'WASH TRADER' : 'TRACKED',
        auto: true,
        first: 'auto-sampled live',
        hits: w.poolsTouched || 1,
        note: `$${(w.volumeUsd / 1e3).toFixed(1)}K volume across ${w.poolsTouched} pools`
      }));
      const userAdded = st.registry.filter(w => !w.auto);
      sourceRegistry = [...userAdded, ...liveRows];
    }

    const registry = sourceRegistry.map((w, i) => ({
      ...w, ...tagStyle(w.tag),
      srcLabel: w.auto ? 'AUTO' : 'MANUAL', srcC: w.auto ? '#f06ee2' : '#4d8dff',
      hitsTxt: w.hits ? w.hits + ' incidents' : '—',
      chainColor: chainColor(w.chain),
      remove: () => saveRegistry(app, st.registry.filter((_, j) => j !== i))
    }));
    const flaggedCount = sourceRegistry.filter(w => w.auto).length;
    return {
      registry, walletInput: st.walletInput, walletLabel: st.walletLabel,
      onWalletInput: (e) => app.setState({ walletInput: e.target.value }),
      onWalletLabel: (e) => app.setState({ walletLabel: e.target.value }),
      addWallet: () => {
        const a = st.walletInput.trim(); if (!a) return;
        saveRegistry(app, [{ addr: a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a, chain: a.startsWith('0x') ? 'EVM' : 'SOL', label: st.walletLabel.trim() || 'Tracked wallet', tag: 'TRACKED', auto: false, first: 'added just now', hits: 0, note: 'Manually tracked — activity will appear in the event tape and wallet-flow features.' }, ...st.registry]);
        app.setState({ walletInput: '', walletLabel: '' });
      },
      walletStats: [
        { label: 'REGISTRY SIZE', value: String(sourceRegistry.length), color: '#ffffff' },
        { label: 'AUTO-FLAGGED', value: String(flaggedCount), color: '#ff4fae' },
        { label: 'MANUALLY TRACKED', value: String(sourceRegistry.length - flaggedCount), color: '#4d8dff' },
        { label: 'POOLS SAMPLED', value: String(apiWallets?.poolsSampled || 12), color: '#f06ee2' },
        { label: 'WALLETS SEEN', value: String(apiWallets?.walletsSeen || 312), color: '#ff4fae' }]
    };
  }

export function saveRegistry(app, reg) {
  app.setState({ registry: reg });
  try { localStorage.setItem('vs_wallet_registry', JSON.stringify(reg)); } catch (e) { }
}

export default function Wallets({ v, css }) {
  return v.isWallets && <>
          <div data-screen-label="Wallet registry" style={css("flex:1;overflow:auto;padding:12px 14px;min-height:0", { v })}><div style={css("display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px", { v })}>{(v.walletStats || []).map((s, i) => (<React.Fragment key={i}>
            <div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:10px 12px", { v, s })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8", { v, s })}>{s.label}</div><div style={css("font-size:18px;font-weight:700;margin-top:3px;color:{{ s.color }}", { v, s })}>{s.value}</div></div>
          </React.Fragment>))}</div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px;margin-bottom:10px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>ADD WALLET TO TRACK</div><div style={css("display:flex;gap:8px;flex-wrap:wrap", { v })}><input value={v.walletInput} onChange={v.onWalletInput} placeholder="Wallet address (Solana or 0x\u2026)" style={css("flex:2;min-width:220px;background:#0d1730;border:1px solid #1c2a4d;border-radius:999px;padding:7px 14px;color:#ffffff;font-size:11px;font-family:inherit;outline:none", { v })} /><input value={v.walletLabel} onChange={v.onWalletLabel} placeholder="Label (optional)" style={css("flex:1;min-width:140px;background:#0d1730;border:1px solid #1c2a4d;border-radius:999px;padding:7px 14px;color:#ffffff;font-size:11px;font-family:inherit;outline:none", { v })} /><div onClick={v.addWallet} style={css("padding:7px 20px;border-radius:999px;background:linear-gradient(135deg,#2b6bff,#e35ff2);color:#ffffff;font-size:10.5px;font-weight:700;cursor:pointer", { v })}>+ TRACK</div></div><div style={css("font-size:9.5px;color:#6b7699;margin-top:7px", { v })}>Tracked wallets surface in the event tape, wallet-flow features, and alert reasons. Saved locally — survives reload.</div></div><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:8px", { v })}>WALLET REGISTRY — BAD-ACTOR MEMORY + TRACKED WALLETS</div><div style={css("display:grid;grid-template-columns:120px 52px 1fr 96px 62px 80px 1.6fr 30px;gap:0 10px;padding:4px 0;border-bottom:1px solid #1c2a4d;font-size:9px;letter-spacing:.8px;color:#6b7699;font-weight:600", { v })}><div>ADDRESS</div><div>CHAIN</div><div>LABEL</div><div>TAG</div><div>SOURCE</div><div>INCIDENTS</div><div>NOTE</div><div></div></div>{(v.registry || []).map((w, i) => (<React.Fragment key={i}>
            <div style={css("display:grid;grid-template-columns:120px 52px 1fr 96px 62px 80px 1.6fr 30px;gap:0 10px;align-items:center;padding:7px 0;border-bottom:1px solid #16223f;font-size:10.5px", { v, w })}><div style={css("font-weight:700;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, w })}>{w.addr}</div><div style={css("font-weight:600;font-size:10px;color:{{ w.chainColor }}", { v, w })}>{w.chain}</div><div style={css("color:#c6d1ea;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, w })}>{w.label}</div><div><span style={css("font-size:8.5px;font-weight:800;padding:2.5px 8px;border-radius:999px;background:{{ w.bg }};color:{{ w.fg }};white-space:nowrap", { v, w })}>{w.tag}</span></div><div style={css("font-size:9px;font-weight:700;color:{{ w.srcC }}", { v, w })}>{w.srcLabel}</div><div style={css("color:#8b96b8", { v, w })}>{w.hitsTxt}</div><div style={css("font-size:10px;color:#8b96b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, w })}>{w.note}</div><div className="h7f88fc9a" onClick={w.remove} style={css("cursor:pointer;color:#6b7699;text-align:center", { v, w })}>✕</div></div>
          </React.Fragment>))}<div style={css("font-size:9.5px;color:#6b7699;margin-top:10px;line-height:1.6", { v })}>Wallets in bundle clusters or liquidity-wash cycles are added automatically and stay flagged permanently — their future buys are excluded from organic volume and buyer breadth on every token, and their appearance on a new launch raises its wash probability immediately. Repeat offenders escalate: 2+ incidents marks every launch they touch.</div></div></div>
        </>
}
