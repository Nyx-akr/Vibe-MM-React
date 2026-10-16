import React from 'react';
import { shortAddress } from '../data/wallet-registry';
import { SHIPPED_WALLETS, normalizeCurated, parseWalletList } from '../data/smart-wallets';
import { walletProfile, topWallets } from '../services/wallet-intel';
import { setInput } from '../services/storage/input-store';
import { saveRegistry } from './WALLETS';
import { fmtUsd } from '../utils/formatters';

/**
 * WALLET TRACKER - follow KOL, smart-money and your own wallets, and get an
 * alarm when one of them trades.
 *
 *   LIBRARY      wallets to pick from: the curated KOL / smart-money list,
 *                and the wallets our own sampler sees trading across several
 *                board tokens (MOST ACTIVE).
 *   MY WALLETS   what you track - picked from the library or typed in - each
 *                with its own alarm: buys, sells, and a minimum size.
 *   ALERT LOG    every trade a tracked wallet made since this page opened,
 *                marked where it rang the alarm.
 *
 * Tracked wallets are the same registry the WALLETS view highlights, so a
 * wallet tracked here lights up there too.
 */

const C = { card: '#0a1226', border: '#1c2a4d', line: '#16223f', dim: '#6b7699', mid: '#8b96b8', text: '#dfe6f6', white: '#ffffff', buy: '#4fd6c1', sell: '#ff4fae', pink: '#e35ff2' };
const CAP = { fontSize: 9, letterSpacing: 1.2, color: C.mid, fontWeight: 700 };

function ago(t) {
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmtUsd(Math.abs(n));

/** One line on what our sampler has seen this wallet do. */
function activityOf(address) {
  const p = walletProfile(address);
  if (!p) return { line: 'not seen on our board yet', seen: false };
  return {
    seen: true,
    line: p.trades + ' trades · ' + p.tokensTouched + ' token' + (p.tokensTouched === 1 ? '' : 's') +
      ' · net ' + signed(p.netUsd) + ' · ' + ago(p.lastSeen),
    netUsd: p.netUsd,
  };
}

/* ---------------------------------------------------------------- values -- */

export function trackerVals(app) {
  const st = app.state;
  if (st.page !== 'tracker') return { isTracker: false };

  const registry = st.registry || [];
  const trackedSet = new Set(registry.map((w) => w.address.toLowerCase()));
  const q = String(st.trackerQ || '').trim().toLowerCase().replace(/^@/, '');
  const match = (w) => !q || [w.name, w.handle, w.address, w.category].some((x) => String(x || '').toLowerCase().includes(q));

  const track = (w, source) => () => {
    if (trackedSet.has(w.address.toLowerCase())) return;
    saveRegistry(app, [{
      address: w.address, label: w.name, category: w.category, source, addedAt: Date.now(),
      alert: { on: true, buy: true, sell: true, minUsd: 0 },
    }, ...registry]);
  };
  const untrack = (address) => () => saveRegistry(app, registry.filter((x) => x.address !== address));

  const curated = normalizeCurated([...SHIPPED_WALLETS, ...(st.curated || [])]);
  const active = topWallets({ limit: 60, minPools: 2 }).map((p) => ({
    address: p.address, name: shortAddress(p.address), category: 'ACTIVE', handle: '', chain: (p.chains || []).join(' ').toUpperCase(),
  }));
  const tab = st.trackerTab === 'active' ? 'active' : 'curated';
  const source = tab === 'active' ? active : curated;

  const library = source.filter(match).slice(0, 200).map((w) => {
    const tracked = trackedSet.has(w.address.toLowerCase());
    return {
      ...w, short: shortAddress(w.address), activity: activityOf(w.address), tracked,
      toggle: tracked ? untrack(registry.find((r) => r.address.toLowerCase() === w.address.toLowerCase()).address) : track(w, tab),
    };
  });

  const patch = (address, fn) => saveRegistry(app, registry.map((w) => (w.address === address ? fn(w) : w)));
  const setAlert = (address, change) => patch(address, (w) => ({ ...w, alert: { ...w.alert, ...change } }));

  const tracked = registry.map((w) => ({
    ...w,
    short: shortAddress(w.address),
    activity: activityOf(w.address),
    sourceLabel: w.source === 'curated' ? (w.category || 'CURATED') : w.source === 'active' ? 'ACTIVE' : 'CUSTOM',
    toggleOn: () => setAlert(w.address, { on: !w.alert.on }),
    toggleBuy: () => setAlert(w.address, { buy: !w.alert.buy }),
    toggleSell: () => setAlert(w.address, { sell: !w.alert.sell }),
    setMin: (e) => setAlert(w.address, { minUsd: Math.max(0, Number(String(e.target.value).replace(/[^0-9.]/g, '')) || 0) }),
    remove: untrack(w.address),
  }));

  const addCustom = () => {
    const address = String(st.walletInput || '').trim();
    if (address.length < 26 || /\s/.test(address)) {
      app.setState({ trackerAddMsg: 'That does not look like a full wallet address.' });
      return;
    }
    if (trackedSet.has(address.toLowerCase())) {
      app.setState({ walletInput: '', walletLabel: '', trackerAddMsg: 'Already tracked.' });
      return;
    }
    saveRegistry(app, [{
      address, label: String(st.walletLabel || '').trim() || 'My wallet', source: 'custom', addedAt: Date.now(),
      alert: { on: true, buy: true, sell: true, minUsd: 0 },
    }, ...registry]);
    app.setState({ walletInput: '', walletLabel: '', trackerAddMsg: '' });
  };

  const runImport = () => {
    const { wallets, skipped, error } = parseWalletList(st.importText);
    if (!wallets.length) {
      app.setState({ importMsg: error || 'Nothing usable found - one wallet per line: address, name, category' });
      return;
    }
    const merged = normalizeCurated([...(st.curated || []), ...wallets]);
    setInput('curatedWallets', merged);
    app.setState({
      curated: merged, importText: '', importOpen: false, trackerTab: 'curated',
      importMsg: wallets.length + ' wallet' + (wallets.length === 1 ? '' : 's') + ' added' + (skipped ? ' · ' + skipped + ' skipped' : ''),
    });
  };

  const prefs = st.trackerPrefs || {};
  const notifyState = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

  return {
    isTracker: true,
    tracker: {
      tab, setTab: (k) => () => app.setState({ trackerTab: k }),
      curatedCount: curated.length, activeCount: active.length,
      q: st.trackerQ || '', onQ: (e) => app.setState({ trackerQ: e.target.value }),
      library,
      tracked,
      alarmedCount: tracked.filter((w) => w.alert.on).length,
      walletInput: st.walletInput || '', walletLabel: st.walletLabel || '',
      onWalletInput: (e) => app.setState({ walletInput: e.target.value, trackerAddMsg: '' }),
      onWalletLabel: (e) => app.setState({ walletLabel: e.target.value }),
      addCustom, addMsg: st.trackerAddMsg || '',
      importOpen: Boolean(st.importOpen), toggleImport: () => app.setState((s) => ({ importOpen: !s.importOpen, importMsg: '' })),
      importText: st.importText || '', onImportText: (e) => app.setState({ importText: e.target.value }),
      runImport, importMsg: st.importMsg || '',
      clearImported: (st.curated || []).length ? () => { setInput('curatedWallets', []); app.setState({ curated: [], importMsg: 'Imported list cleared' }); } : null,
      log: (st.walletLog || []).map((e) => ({ ...e, short: shortAddress(e.address), when: ago(e.at) })),
      clearLog: () => app.setState({ walletLog: [] }),
      soundOn: st.soundOn, toggleSound: () => app.setState((s) => ({ soundOn: !s.soundOn })),
      desktop: Boolean(prefs.desktop) && notifyState === 'granted', notifyState,
      toggleDesktop: async () => {
        if (prefs.desktop) {
          const next = { ...prefs, desktop: false };
          setInput('trackerPrefs', next); app.setState({ trackerPrefs: next });
          return;
        }
        if (notifyState === 'unsupported') return;
        const perm = notifyState === 'granted' ? 'granted' : await Notification.requestPermission();
        const next = { ...prefs, desktop: perm === 'granted' };
        setInput('trackerPrefs', next); app.setState({ trackerPrefs: next });
      },
    },
  };
}

/* ------------------------------------------------------------- component -- */

function Card({ title, right, children, style }) {
  return (
    <div style={{ background: C.card, border: '1px solid ' + C.border, borderRadius: 10, display: 'flex', flexDirection: 'column', minHeight: 0, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', borderBottom: '1px solid ' + C.line, flexShrink: 0 }}>
        <span style={CAP}>{title}</span>
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </div>
  );
}

function Pill({ on, onClick, children, color = '#4d8dff', title }) {
  return (
    <span className="h3eb549cf" onClick={onClick} title={title} style={{
      padding: '3px 9px', borderRadius: 999, fontSize: 9, fontWeight: 700, letterSpacing: 0.5, cursor: 'pointer', whiteSpace: 'nowrap',
      background: on ? color + '22' : 'transparent', color: on ? color : C.dim, border: '1px solid ' + (on ? color : C.border),
    }}>{children}</span>
  );
}

const input = {
  background: '#0d1730', border: '1px solid ' + C.border, borderRadius: 7, color: C.text,
  fontFamily: 'inherit', fontSize: 10.5, padding: '6px 9px', outline: 'none', minWidth: 0,
};

const btn = (primary) => ({
  padding: '6px 13px', borderRadius: 7, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.6, cursor: 'pointer', whiteSpace: 'nowrap',
  background: primary ? '#0e2a5c' : 'transparent', color: primary ? '#6ea0ff' : C.mid, border: '1px solid ' + (primary ? '#4d8dff' : C.border),
});

export default function WalletTracker({ v }) {
  if (!v.isTracker) return false;
  const t = v.tracker;
  return (
    <div data-screen-label="Wallet tracker" style={{ flex: 1, overflow: 'auto', padding: '12px 14px', minHeight: 0 }}>
      {/* What this page is, and the one limit that matters. */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: C.white, letterSpacing: 0.3 }}>WALLET TRACKER</div>
          <div style={{ fontSize: 10, color: C.dim, marginTop: 2, maxWidth: 760, lineHeight: 1.5 }}>
            Follow KOLs, smart money and your own wallets. Alarms fire when a tracked wallet trades a token on our board -
            trades in tokens the sampler does not watch are not seen.
          </div>
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...CAP, fontSize: 8.5 }}>ALARM DELIVERY</span>
          <Pill on>ON SCREEN</Pill>
          <Pill on={t.soundOn} onClick={t.toggleSound} title="Beep on every alarm">SOUND</Pill>
          <Pill on={t.desktop} onClick={t.toggleDesktop}
            title={t.notifyState === 'denied' ? 'Notifications are blocked for this site in your browser settings'
              : t.notifyState === 'unsupported' ? 'This browser has no desktop notifications' : 'Notify even when this tab is in the background'}>
            DESKTOP{t.notifyState === 'denied' ? ' (blocked)' : ''}
          </Pill>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
        {/* ------------------------------------------------ LIBRARY -- */}
        <Card title="WALLET LIBRARY" right={
          <span className="h3eb549cf" onClick={t.toggleImport} style={{ ...btn(t.importOpen), padding: '3px 10px' }}>IMPORT LIST</span>
        }>
          <div style={{ padding: '9px 12px', display: 'flex', gap: 6, alignItems: 'center', borderBottom: '1px solid ' + C.line, flexWrap: 'wrap' }}>
            <Pill on={t.tab === 'curated'} onClick={t.setTab('curated')} color={C.pink}>KOL & SMART MONEY · {t.curatedCount}</Pill>
            <Pill on={t.tab === 'active'} onClick={t.setTab('active')} color={C.pink} title="Wallets our sampler sees trading two or more board tokens">MOST ACTIVE ON OUR BOARD · {t.activeCount}</Pill>
            <span style={{ flex: 1 }} />
            <input value={t.q} onChange={t.onQ} placeholder="Search name, @handle or address" spellCheck={false} style={{ ...input, width: 220 }} />
          </div>

          {t.importOpen && (
            <div style={{ padding: '10px 12px', borderBottom: '1px solid ' + C.line, background: '#0d1730' }}>
              <div style={{ fontSize: 9.5, color: C.mid, marginBottom: 6, lineHeight: 1.5 }}>
                One wallet per line: <span style={{ color: C.text, fontFamily: 'monospace' }}>address, name, category, chain, handle</span> - everything after the address is optional. A JSON array works too. Kept in this browser.
              </div>
              <textarea value={t.importText} onChange={t.onImportText} rows={5} spellCheck={false}
                placeholder={'7xKX…full address…, Some KOL, KOL, SOL, somehandle'}
                style={{ ...input, width: '100%', boxSizing: 'border-box', fontFamily: 'monospace', resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 7, alignItems: 'center' }}>
                <span className="h3eb549cf" onClick={t.runImport} style={btn(true)}>ADD TO LIBRARY</span>
                {t.clearImported && <span className="h3eb549cf" onClick={t.clearImported} style={btn(false)}>CLEAR IMPORTED</span>}
              </div>
            </div>
          )}
          {t.importMsg && <div style={{ padding: '6px 12px', fontSize: 9.5, color: C.buy, borderBottom: '1px solid ' + C.line }}>{t.importMsg}</div>}

          <div style={{ maxHeight: 'calc(100vh - 250px)', overflowY: 'auto' }}>
            {t.library.map((w) => (
              <div key={w.address} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid ' + C.line }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, minWidth: 0 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: C.white, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.name}</span>
                    {w.handle && <a href={'https://x.com/' + w.handle} target="_blank" rel="noreferrer" style={{ fontSize: 9.5, color: '#4d8dff', textDecoration: 'none' }}>@{w.handle}</a>}
                    <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 0.6, padding: '1.5px 6px', borderRadius: 6, background: '#1a2440', color: '#a3aed0', flexShrink: 0 }}>{w.category}</span>
                    {w.chain && <span style={{ fontSize: 8.5, color: C.dim }}>{w.chain}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 2, fontSize: 9, minWidth: 0 }}>
                    <span title={w.address} style={{ fontFamily: 'monospace', color: C.mid }}>{w.short}</span>
                    <span style={{ color: w.activity.seen ? C.dim : '#3a4568', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.activity.line}</span>
                  </div>
                </div>
                <span className="h3eb549cf" onClick={w.toggle} style={{ ...btn(!w.tracked), minWidth: 82, textAlign: 'center' }}>
                  {w.tracked ? 'TRACKING ✓' : '+ TRACK'}
                </span>
              </div>
            ))}
            {!t.library.length && (
              <div style={{ padding: '22px 16px', fontSize: 10.5, color: C.dim, lineHeight: 1.6, textAlign: 'center' }}>
                {t.q ? 'No wallet matches that search.'
                  : t.tab === 'curated'
                    ? 'No KOL or smart-money list loaded yet. Use IMPORT LIST to paste one - every entry should be a verified wallet, since people will act on the label.'
                    : 'Nothing yet - wallets appear here once the sampler has seen them trade two or more board tokens.'}
              </div>
            )}
          </div>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {/* --------------------------------------------- MY WALLETS -- */}
          <Card title="MY TRACKED WALLETS" right={<span style={{ fontSize: 9, color: C.dim }}>{t.tracked.length} tracked · {t.alarmedCount} with alarm</span>}>
            <div style={{ padding: '9px 12px', borderBottom: '1px solid ' + C.line }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={t.walletInput} onChange={t.onWalletInput} placeholder="Paste a wallet address" spellCheck={false} style={{ ...input, flex: 2, fontFamily: 'monospace' }} />
                <input value={t.walletLabel} onChange={t.onWalletLabel} placeholder="Name it" style={{ ...input, flex: 1 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') t.addCustom(); }} />
                <span className="h3eb549cf" onClick={t.addCustom} style={btn(true)}>+ ADD</span>
              </div>
              {t.addMsg && <div style={{ fontSize: 9.5, color: C.sell, marginTop: 5 }}>{t.addMsg}</div>}
            </div>

            {t.tracked.map((w) => (
              <div key={w.address} style={{ padding: '8px 12px', borderBottom: '1px solid ' + C.line, opacity: w.alert.on ? 1 : 0.75 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="h3eb549cf" onClick={w.toggleOn} title={w.alert.on ? 'Alarm on - click to mute' : 'Alarm off - click to turn on'}
                    style={{ cursor: 'pointer', fontSize: 14, lineHeight: 1, color: w.alert.on ? '#ffbe4d' : '#3a4568', flexShrink: 0 }}>{w.alert.on ? '🔔' : '🔕'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: C.white, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.label}</span>
                      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 0.6, color: '#a3aed0' }}>{w.sourceLabel}</span>
                    </div>
                    <div style={{ fontSize: 9, marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span title={w.address} style={{ fontFamily: 'monospace', color: C.mid }}>{w.short}</span>
                      <span style={{ color: w.activity.seen ? C.dim : '#3a4568' }}> · {w.activity.line}</span>
                    </div>
                  </div>
                  <span className="h7f88fc9a" onClick={w.remove} title="Stop tracking" style={{ cursor: 'pointer', color: C.dim, fontSize: 12, padding: '0 3px' }}>✕</span>
                </div>
                {w.alert.on && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, paddingLeft: 22 }}>
                    <span style={{ fontSize: 8.5, color: C.dim, letterSpacing: 0.5 }}>ALERT ON</span>
                    <Pill on={w.alert.buy} onClick={w.toggleBuy} color={C.buy}>BUYS</Pill>
                    <Pill on={w.alert.sell} onClick={w.toggleSell} color={C.sell}>SELLS</Pill>
                    <span style={{ fontSize: 8.5, color: C.dim, marginLeft: 4 }}>OVER $</span>
                    <input value={w.alert.minUsd || ''} onChange={w.setMin} placeholder="0" inputMode="numeric"
                      style={{ ...input, width: 70, padding: '3px 7px', fontSize: 10 }} />
                  </div>
                )}
              </div>
            ))}
            {!t.tracked.length && (
              <div style={{ padding: '18px 14px', fontSize: 10.5, color: C.dim, textAlign: 'center', lineHeight: 1.6 }}>
                Nothing tracked yet. Pick wallets from the library, or paste an address above.
              </div>
            )}
          </Card>

          {/* ---------------------------------------------- ALERT LOG -- */}
          <Card title="ALERT LOG" right={t.log.length ? <span className="h3eb549cf" onClick={t.clearLog} style={{ fontSize: 9, color: C.dim, cursor: 'pointer' }}>clear</span> : <span style={{ fontSize: 9, color: C.dim }}>since this page opened</span>}>
            <div style={{ maxHeight: 320, overflowY: 'auto' }}>
              {t.log.map((e) => (
                <div key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderBottom: '1px solid ' + C.line, fontSize: 10 }}>
                  <span title={e.alarmed ? 'Rang the alarm' : 'Did not pass this wallet’s alarm settings'} style={{ width: 12, flexShrink: 0, color: e.alarmed ? '#ffbe4d' : '#3a4568' }}>{e.alarmed ? '●' : '○'}</span>
                  <span style={{ fontWeight: 700, color: C.white, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>{e.label}</span>
                  <span style={{ fontWeight: 700, color: e.side === 'buy' ? C.buy : C.sell }}>{e.side === 'buy' ? 'BOUGHT' : 'SOLD'}</span>
                  <span style={{ color: C.text, fontWeight: 600 }}>{e.symbol ? '$' + String(e.symbol).replace(/^\$/, '') : shortAddress(e.pool)}</span>
                  <span style={{ color: C.mid }}>{fmtUsd(e.usd)}{e.trades > 1 ? ' · ' + e.trades + ' trades' : ''}</span>
                  <span style={{ flex: 1 }} />
                  <span style={{ color: C.dim, fontSize: 9, flexShrink: 0 }}>{e.when}</span>
                </div>
              ))}
              {!t.log.length && (
                <div style={{ padding: '16px 14px', fontSize: 10, color: C.dim, textAlign: 'center' }}>No trades from tracked wallets yet.</div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
