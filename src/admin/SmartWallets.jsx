/**
 * SMART WALLETS - the list the backtest learns (scripts/backtest-early.mjs,
 * published to /raw/smart-wallets.json): wallets whose earlier buys on board
 * tokens were followed by a rise often enough to clear the rule. PHASE & SIGNAL
 * read it (SMART BUYERS / SELLERS 1H), the SMART MONEY engines score on it, and
 * the price chart marks its trades with a gold star.
 *
 * Read-only. Beside each wallet's record, whether it is trading right now: the
 * pools where it appears in the collector's latest trade samples.
 */

import React from 'react';
import { C } from './Explain';
import { readRawQuiet } from '../services/storage/raw-store';
import { chainKeys } from '../data/chains';

const pct = (x) => (Number.isFinite(x) ? Math.round(x * 100) + '%' : '—');
const ago = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return (s / 3600).toFixed(1) + 'h ago';
  return (s / 86400).toFixed(1) + 'd ago';
};
const short = (w) => (w.length > 14 ? w.slice(0, 6) + '…' + w.slice(-6) : w);

const COLS = [
  { key: 'rate', label: 'WIN RATE', tip: 'wins ÷ buys judged' },
  { key: 'wins', label: 'WINS', tip: 'buys followed by a rise' },
  { key: 'buys', label: 'BUYS JUDGED', tip: 'buys whose outcome is known' },
  { key: 'tokens', label: 'TOKENS', tip: 'different tokens it bought' },
  { key: 'live', label: 'LAST SEEN', tip: 'its trades in the collector’s latest trade samples (buys ▲, sells ▼, when)' },
];

export default function SmartWallets() {
  const [file, setFile] = React.useState(null);
  const [live, setLive] = React.useState(new Map());
  const [q, setQ] = React.useState('');
  const [sort, setSort] = React.useState('rate');
  const [limit, setLimit] = React.useState(200);

  React.useEffect(() => {
    let alive = true;
    const load = async () => {
      const f = await readRawQuiet('smart-wallets.json', null);
      // Who is trading now: every chain's latest trade samples, by wallet.
      const byWallet = new Map();
      const files = await Promise.all(chainKeys.map((ch) => readRawQuiet(ch + '/trades.json', null).then((d) => [ch, d])));
      files.forEach(([ch, d]) => {
        // trades.json: pools is a list of { poolAddress, symbol, at, trades }.
        const pools = Array.isArray(d && d.pools) ? d.pools : [];
        pools.forEach((p) => {
          const pool = String(p.poolAddress || '');
          (p.trades || []).forEach((x) => {
            if (!x || !x.wallet) return;
            const w = String(x.wallet).toLowerCase();
            const cur = byWallet.get(w) || { n: 0, last: 0, buys: 0, sells: 0, usd: 0, where: new Set() };
            cur.n += 1; cur.usd += Number(x.usd) || 0;
            if (x.kind === 'buy') cur.buys += 1; else cur.sells += 1;
            cur.last = Math.max(cur.last, x.at || 0);
            cur.where.add((p.symbol || pool.slice(0, 6)) + ' · ' + ch);
            byWallet.set(w, cur);
          });
        });
      });
      if (alive) { setFile(f); setLive(byWallet); }
    };
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const rows = React.useMemo(() => {
    const w = (file && file.wallets) || {};
    return Object.keys(w).map((addr) => {
      const r = w[addr] || {};
      const l = live.get(addr) || null;
      return { addr, buys: r.buys || 0, wins: r.wins || 0, tokens: r.tokens || 0,
        rate: r.buys ? r.wins / r.buys : null, live: l ? l.n : 0, l };
    });
  }, [file, live]);

  const shown = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => !needle || r.addr.indexOf(needle) !== -1)
      .sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || b.buys - a.buys);
  }, [rows, q, sort]);

  const tradingNow = rows.filter((r) => r.live > 0).length;
  const rule = (file && file.rule) || {};

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: C.white, marginBottom: 4 }}>SMART WALLETS</div>
      <div style={{ fontSize: 10.5, color: C.dim, lineHeight: 1.6, marginBottom: 12, maxWidth: 900 }}>
        Wallets whose earlier buys on board tokens were followed by a price rise often enough to count as
        “smart”. The backtest learns the list (<code>npm run backtest</code>) from the archived trades; the app reads
        it for SMART BUYERS / SELLERS, the SMART MONEY engines, and the gold ★ on the price chart.
        {file ? <> Rule: at least {rule.minResolved} buys with a known outcome, on {rule.minTokens}+ tokens,
          won ≥ {pct(rule.minRate)}, buys of ${rule.minBuyUsd}+.</> : null}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        {[
          ['WALLETS', file ? file.count.toLocaleString() : '—'],
          ['IN LATEST SAMPLES', tradingNow.toLocaleString()],
          ['LEARNED', file ? ago(file.generatedAt) : '—'],
        ].map(([k, v]) => (
          <div key={k} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: '8px 12px', minWidth: 120 }}>
            <div style={{ fontSize: 8.5, letterSpacing: 1, color: C.dim, fontWeight: 700 }}>{k}</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: C.white }}>{v}</div>
          </div>
        ))}
        <div style={{ flex: 1 }} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="search an address" spellCheck={false}
          style={{ alignSelf: 'center', width: 260, background: '#0d1730', color: C.text, border: `1px solid ${C.border}`,
            borderRadius: 6, padding: '6px 9px', fontFamily: 'inherit', fontSize: 11, outline: 'none' }} />
      </div>

      {!file ? (
        <div style={{ fontSize: 11, color: C.grey }}>No smart-wallet list yet - run <code>npm run backtest</code>.</div>
      ) : (
        <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '40px 1fr 80px 70px 90px 70px 110px', gap: 8, padding: '8px 12px',
            fontSize: 8.5, letterSpacing: 0.8, fontWeight: 700, color: C.dim, borderBottom: `1px solid ${C.line}` }}>
            <span>#</span><span>WALLET</span>
            {COLS.map((c) => (
              <span key={c.key} title={c.tip + ' - click to sort'} onClick={() => setSort(c.key)}
                style={{ cursor: 'pointer', color: sort === c.key ? C.pink : C.dim, textAlign: 'right' }}>{c.label}{sort === c.key ? ' ▾' : ''}</span>
            ))}
          </div>
          {shown.slice(0, limit).map((r, i) => (
            <div key={r.addr} style={{ display: 'grid', gridTemplateColumns: '40px 1fr 80px 70px 90px 70px 110px', gap: 8,
              padding: '5px 12px', fontSize: 10.5, borderBottom: `1px solid ${C.line}`, alignItems: 'center' }}>
              <span style={{ color: C.faint }}>{i + 1}</span>
              <span title={r.addr + ' - click to copy'} onClick={() => { try { navigator.clipboard.writeText(r.addr); } catch (e) { /* no clipboard */ } }}
                style={{ fontFamily: 'monospace', color: C.text, cursor: 'copy', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ color: '#ffd60a' }}>★ </span>{short(r.addr)}
              </span>
              <span style={{ textAlign: 'right', color: r.rate >= 0.6 ? '#3ddc97' : C.text, fontWeight: 700 }}>{pct(r.rate)}</span>
              <span style={{ textAlign: 'right' }}>{r.wins.toLocaleString()}</span>
              <span style={{ textAlign: 'right' }}>{r.buys.toLocaleString()}</span>
              <span style={{ textAlign: 'right' }}>{r.tokens}</span>
              <span style={{ textAlign: 'right', color: r.live ? '#3ddc97' : C.faint }}
                title={r.l ? r.l.buys + ' buys, ' + r.l.sells + ' sells, last ' + ago(r.l.last) + ' · ' + Array.from(r.l.where).join(', ') : 'not in the latest samples'}>
                {r.live ? r.l.buys + '▲ ' + r.l.sells + '▼ · ' + ago(r.l.last) : '—'}
              </span>
            </div>
          ))}
          {shown.length > limit && (
            <div onClick={() => setLimit((n) => n + 300)} style={{ padding: '8px 12px', fontSize: 10, color: C.pink, cursor: 'pointer' }}>
              show more ({(shown.length - limit).toLocaleString()} left)
            </div>
          )}
        </div>
      )}
      <div style={{ fontSize: 9, color: C.grey, marginTop: 10, lineHeight: 1.6, maxWidth: 900 }}>
        Addresses are stored lower-case (that is how the trade sample is matched), so a Solana address shown here may
        differ in letter case from the explorer’s. Hover LAST SEEN to see which pools a wallet traded in.
      </div>
    </div>
  );
}
