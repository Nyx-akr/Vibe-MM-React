import React from 'react';
import './App.css';
import LiveOpportunities from './tabs-modules/LIVE-OPPORTUNITIES';
import AssetDetail from './tabs-modules/ASSET-DETAIL';
import Rotation from './tabs-modules/ROTATION';
import Wallets from './tabs-modules/WALLETS';
import SocialScanner from './tabs-modules/SOCIAL-SCANNER';
import AlertCards from './tabs-modules/ALERT-CARDS';
import Evaluation from './tabs-modules/EVALUATION';
import SystemHealth from './tabs-modules/SYSTEM-HEALTH';
import { detailVals } from './tabs-modules/ASSET-DETAIL';
import { rotationVals } from './tabs-modules/ROTATION';
import { walletsVals } from './tabs-modules/WALLETS';
import { socialVals } from './tabs-modules/SOCIAL-SCANNER';
import { alertsVals } from './tabs-modules/ALERT-CARDS';
import { evalVals } from './tabs-modules/EVALUATION';
import { healthVals } from './tabs-modules/SYSTEM-HEALTH';
import { assetSeeds } from './data/assets';
import { css } from './utils/css';
import { fmtUsd, fmtAge, fmtPrice, stageInfo, chainColor, clsColor, scoreColor, washColor } from './utils/formatters';
import { chains as chainList, chainKeys, chainNameToKey } from './data/chains';
import { defaultWalletRegistry } from './data/wallet-registry';
import { nextTape } from './services/live-feed';
import {
  fetchLiveMarketData,
  fetchLiveRotationData,
  fetchLiveWalletData,
  fetchLiveSocialData,
  fetchLiveEvalData,
  fetchLiveSystemData,
  fetchLiveTokenIntel,
  fetchLiveOhlcv
} from './services/api';
import AppHeader from './components/AppHeader';
class App extends React.Component {
  constructor(props) {
    super(props); this.state = { page: 'live', sortKey: 'score', sortDir: -1, selectedId: null, clock: '', tick: 0, tape: [], flashId: null, expandedId: null, viewF: 'ALL', chainF: 'ALL', classF: 'ALL', watch: {}, soundOn: false, toast: null, serverError: false, intel: null, intelState: 'idle', bars: null, barsState: 'idle' };
    try { const w = JSON.parse(localStorage.getItem('vs_watchlist') || 'null'); if (w) this.state.watch = w; } catch (e) { }
    this.assets = []; this.tapeSeq = 0;
    this.state.walletInput = ''; this.state.walletLabel = '';
    let saved = null; try { saved = JSON.parse(localStorage.getItem('vs_wallet_registry') || 'null'); } catch (e) { }
    this.state.registry = saved || defaultWalletRegistry;
  }
  h(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; } return h; }
  srand(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  seedAssets() {
    const clone = (value) => value === null || typeof value !== 'object'
      ? value
      : Array.isArray(value)
        ? value.map(clone)
        : Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, clone(nestedValue)]));
    const mk = (o) => {
      const r = this.srand(this.h(o.id));
      o.spark = []; let v = 50; for (let i = 0; i < 44; i++) { v = Math.max(8, Math.min(100, v + (r() - 0.44) * 14)); o.spark.push(v); }
      return o;
    };
    return assetSeeds.map(seed => mk(clone(seed)));
  }

  async syncLiveData() {
    try {
      const liveAssets = await fetchLiveMarketData(chainKeys);
      if (liveAssets && liveAssets.length > 0) {
        this.assets = liveAssets;

        const chain = this.state.chainF !== 'ALL' ? (chainNameToKey[this.state.chainF] || 'solana') : 'solana';

        if (this.state.page === 'rotation') {
          const rotationData = await fetchLiveRotationData(chain);
          if (rotationData) this.setState({ apiRotation: rotationData });
        } else if (this.state.page === 'wallets') {
          const walletData = await fetchLiveWalletData(chain);
          if (walletData) this.setState({ apiWallets: walletData });
        } else if (this.state.page === 'social') {
          const socialData = await fetchLiveSocialData(chain);
          if (socialData) this.setState({ apiSocial: socialData });
        } else if (this.state.page === 'eval') {
          const evalData = await fetchLiveEvalData(chain);
          if (evalData) this.setState({ apiEval: evalData });
        } else if (this.state.page === 'health') {
          const systemData = await fetchLiveSystemData();
          if (systemData) this.setState({ apiSystem: systemData });
        }

        this.setState({ serverError: false });
      } else {
        this.assets = [];
        this.setState({
          serverError: true,
          apiRotation: null,
          apiWallets: null,
          apiSocial: null,
          apiEval: null,
          apiSystem: null
        });
      }
    } catch (e) {
      this.assets = [];
      this.setState({
        serverError: true,
        apiRotation: null,
        apiWallets: null,
        apiSocial: null,
        apiEval: null,
        apiSystem: null
      });
    }
  }

  componentDidMount() {
    const clockFn = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); this.setState({ clock: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) }); };
    clockFn(); this.clockTimer = setInterval(clockFn, 1000);
    this.simTimer = setInterval(() => this.simTick(), 2400 / Math.max(1, this.props.simSpeed ?? 2));
    this.syncLiveData();
    this.apiTimer = setInterval(() => this.syncLiveData(), 5000);
    for (let i = 0; i < 7; i++) this.pushTape(false);
  }
  componentDidUpdate() {
    if (this.state.page !== 'detail') { this.detailKey = null; return; }
    this.loadDetailData(this.assets.find(a => a.id === this.state.selectedId) || this.assets[0]);
  }

  /**
   * Loads the per-token extras the feed does not carry: contract safety, holder
   * counts and routed price impact (/api/intel) plus real minute bars
   * (/api/ohlcv). Fetched once per token and re-fetched when the selection
   * changes; a failure is recorded so the view can grey the fields out.
   */
  async loadDetailData(a) {
    const row = a && a.rawServerRow;
    if (!row || !row.tokenAddress) return;
    const key = row.chain + ':' + row.tokenAddress + ':' + row.poolAddress;
    if (this.detailKey === key) return;
    this.detailKey = key;
    this.setState({ intel: null, intelState: 'loading', bars: null, barsState: 'loading' });
    const [intel, bars] = await Promise.all([
      fetchLiveTokenIntel(row.chain, row.tokenAddress, row.poolAddress || ''),
      fetchLiveOhlcv(row.chain, row.poolAddress, 'minute', 1, 60)
    ]);
    if (this.detailKey !== key) return;
    const barList = (bars && bars.bars) || [];
    const hasBars = barList.length > 1;
    this.setState({
      intel, intelState: intel ? 'ready' : 'error',
      bars: hasBars ? barList : null,
      barsState: hasBars
        ? (bars.reason === 'local_history' ? 'local_history' : 'ready')
        : ((bars && bars.reason) || 'error')
    });
    // A rate-limited chart is temporary - retry once the GT budget refills.
    if (!hasBars && bars && bars.reason === 'rate_limited') {
      const retryKey = this.detailKey;
      setTimeout(() => {
        if (this.detailKey === retryKey) { this.detailKey = null; this.componentDidUpdate(); }
      }, bars.retryAfterMs || 20000);
    }
  }

  toggleWatch(id) {
    this.setState(s => {
      const watch = { ...s.watch };
      if (watch[id]) delete watch[id]; else watch[id] = true;
      try { localStorage.setItem('vs_watchlist', JSON.stringify(watch)); } catch (e) { }
      return { watch };
    });
  }

  componentWillUnmount() {
    clearInterval(this.clockTimer);
    clearInterval(this.simTimer);
    clearInterval(this.apiTimer);
    clearTimeout(this.toastTimer);
  }
  beep() { try { const ctx = this.audioCtx || (this.audioCtx = new (window.AudioContext || window.webkitAudioContext)()); const o = ctx.createOscillator(), g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.setValueAtTime(0.08, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35); o.start(); o.stop(ctx.currentTime + 0.36); } catch (e) { } }
  simTick() {
    if (this.props.liveFeed === false || this.state.serverError || !this.assets.length) return;
    const r = Math.random;
    // Asset values are NOT touched here. They come from /api/market every 5s and
    // drifting them locally would mean showing numbers no server ever reported.
    this.pushTape(true);
    const flash = r() < 0.3 ? this.assets[Math.floor(r() * this.assets.length)].id : null;
    this.setState(s => ({ tick: s.tick + 1, flashId: flash }));
    if (!this.state.toast && r() < 0.05) {
      const hot = this.assets.filter(x => x.score >= 84); if (hot.length) {
        const a = hot[Math.floor(r() * hot.length)];
        this.setState({ toast: { title: (a.score >= 90 ? 'EXCEPTIONAL' : 'CONFIRMED') + ' — ' + a.sym + ' / ' + a.chain, body: 'Score ' + Math.round(a.score) + ', conf ' + a.conf.toFixed(2) + '. ' + a.reason + '.' } });
        if (this.state.soundOn) this.beep();
        this.toastTimer = setTimeout(() => this.setState({ toast: null }), 7000);
      }
    }
  }
  pushTape(update) {
    const tape = nextTape(this.state.tape, this.tapeSeq++, update, (nextState) => this.setState(nextState));
    if (!update) this.state.tape = tape;
  }
  renderVals() {
    const st = this.state, showAdj = this.props.showAdjusted !== false, live = this.props.liveFeed !== false;
    const nav = (p) => () => this.setState({ page: p });
    const tabs = [['live', 'LIVE OPPORTUNITIES'], ['detail', 'ASSET DETAIL'], ['rotation', 'ROTATION'], ['wallets', 'WALLETS'], ['social', 'SOCIAL SCANNER'], ['alerts', 'ALERT CARDS'], ['eval', 'EVALUATION'], ['health', 'SYSTEM HEALTH']].map(([k, label]) => ({ label, go: nav(k), fg: st.page === k ? '#e35ff2' : '#8b96b8', line: st.page === k ? '#e35ff2' : 'transparent' }));
    const chip = (label, active, go) => ({ label, go, bg: active ? '#33124a' : '#0a1226', fg: active ? '#f06ee2' : '#8b96b8', bd: active ? '#f06ee2' : '#1c2a4d' });
    const views = [['ALL', 'All'], ['WATCHLIST', '★ Watchlist'], ['CONFIRMED', 'Confirmed+'], ['STOCK', 'Stock tokens'], ['EXPERIMENTAL', 'Experimental']].map(([k, label]) => chip(label, st.viewF === k, () => this.setState({ viewF: k })));
    // The table's chain chips are the only chain selector; the old navbar
    // pills duplicated this and carried invented latency figures.
    const chainFilters = ['ALL'].concat(chainList.map((c) => c.name))
      .map(k => chip(k, st.chainF === k, () => this.setState({ chainF: k })));
    const classFilters = ['ALL', 'MEME', 'TOKEN', 'STOCK', 'ETF'].map(k => chip(k, st.classF === k, () => this.setState({ classF: k })));
    const cols = [[null, ''], ['stage', 'STAGE'], ['score', 'SCORE'], ['conf', 'CONF'], ['sym', 'ASSET'], ['chain', 'CHAIN'], ['cls', 'CLASS'], ['age', 'AGE'], ['price', 'PRICE'], ['chg', 'Δ5M'], ['liq', 'LIQ'], [showAdj ? 'adj' : 'vol', showAdj ? 'VOL 5M' : 'VOL 24H'], ['buyers', 'BUYERS 5M'], ['nf', 'NET FLOW'], ['wash', 'WASH'], [null, 'TREND'], [null, 'TOP REASON']];
    const headers = cols.map(([k, label]) => ({
      label, arrow: st.sortKey === k ? (st.sortDir < 0 ? ' ▼' : ' ▲') : '', fg: st.sortKey === k ? '#e35ff2' : '#6b7699',
      sort: k ? () => this.setState(s => ({ sortKey: k, sortDir: s.sortKey === k ? -s.sortDir : -1 })) : () => { }
    }));
    const filtered = this.assets.filter(a => {
      if (st.chainF !== 'ALL' && a.chain !== st.chainF) return false;
      if (st.classF !== 'ALL' && a.cls !== st.classF) return false;
      if (st.viewF === 'WATCHLIST' && !st.watch[a.id]) return false;
      if (st.viewF === 'CONFIRMED' && a.stage < 3) return false;
      if (st.viewF === 'STOCK' && a.cls !== 'STOCK' && a.cls !== 'ETF') return false;
      if (st.viewF === 'EXPERIMENTAL' && a.liq >= 60000) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => { const k = st.sortKey; const av = a[k], bv = b[k]; if (typeof av === 'string') return String(av).localeCompare(String(bv)) * st.sortDir; return (av - bv) * st.sortDir; });
    const sevMap = { HIGH: { bg: '#45103a', fg: '#ff4fae' }, MED: { bg: '#33124a', fg: '#e35ff2' }, LOW: { bg: '#1a2440', fg: '#a3aed0' } };
    const rows = sorted.map(a => {
      const si = stageInfo(a.stage);
      const tr = a.spark.slice(-14); const tMax = Math.max(...tr), tMin = Math.min(...tr);
      const spMax = Math.max(...a.spark), spMin = Math.min(...a.spark);
      return {
        // Clicking anywhere on the row opens this token in the Asset Detail tab.
        open: () => this.setState({ page: 'detail', selectedId: a.id }),
        goDetail: () => this.setState({ page: 'detail', selectedId: a.id }),
        star: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.toggleWatch(a.id); },
        starGlyph: st.watch[a.id] ? '★' : '☆', starColor: st.watch[a.id] ? '#f06ee2' : '#3a4568',
        isBundle: !!a.bundle,
        expanded: st.expandedId === a.id,
        trend: tr.map(v => ({ h: Math.round(15 + (v - tMin) / (tMax - tMin + 0.01) * 85) + '%', c: v >= tr[0] ? '#4d8dff' : '#ff4fae' })),
        peekSpark: a.spark.map((v, i) => ({ h: Math.round(8 + (v - spMin) / (spMax - spMin + 0.01) * 92) + '%', c: i === a.spark.length - 1 ? '#e35ff2' : v >= (a.spark[i - 1] ?? v) ? '#2f66d0' : '#8a2f7c' })),
        peekReasons: a.reasons.slice(0, 3).map(x => ({ code: x.code, text: x.text, z: x.z })),
        peekFlags: a.flags.slice(0, 2).map(f => ({ sev: f.sev, bg: sevMap[f.sev].bg, fg: sevMap[f.sev].fg, text: f.text })),
        anim: st.flashId === a.id ? 'vsFlash 1.2s ease-out' : 'none',
        stage: si.n, stageBg: si.bg, stageFg: si.fg, score: Math.round(a.score), scoreColor: scoreColor(a.score), conf: a.conf.toFixed(2),
        sym: a.sym, name: a.name, chain: a.chain, chainColor: chainColor(a.chain), cls: a.cls, clsColor: clsColor(a.cls),
        age: fmtAge(a.age), price: fmtPrice(a.price), chg: (a.chg >= 0 ? '+' : '') + (a.chg * 100).toFixed(1) + '%', chgColor: a.chg >= 0 ? '#4d8dff' : '#ff4fae',
        liq: a.liq == null ? '—' : fmtUsd(a.liq),
        vol: (showAdj ? a.adj : a.vol) == null ? '—' : fmtUsd(showAdj ? a.adj : a.vol), volTag: '',
        buyers: a.buyers == null ? '—' : a.buyers,
        netflow: a.nf == null ? '—' : fmtUsd(a.nf), nfColor: a.nf == null ? '#3a4568' : a.nf >= 0 ? '#4d8dff' : '#ff4fae',
        wash: a.wash == null ? '—' : Math.round(a.wash * 100) + '%', washColor: a.wash == null ? '#3a4568' : washColor(a.wash), reason: a.reason
      };
    });
    const bundled = this.assets.filter(a => a.bundle);
    // The feed reorders every 5s and a token can drop out of it. Keep showing
    // the token the user opened (with a staleness note) instead of silently
    // swapping the detail view to a different asset.
    let sel = this.assets.find(a => a.id === st.selectedId);
    if (sel) { this.lastSelected = sel; this.lastSelectedAt = Date.now(); }
    else if (st.selectedId && this.lastSelected && this.lastSelected.id === st.selectedId) sel = this.lastSelected;
    else sel = this.assets[0];
    const staleMs = sel && this.lastSelected === sel && !this.assets.includes(sel) ? Date.now() - this.lastSelectedAt : 0;
    const d = detailVals(this, sel, showAdj, {
      intel: st.intel, bars: st.bars, intelState: st.intelState, barsState: st.barsState, staleMs
    });
    const counts = [0, 0, 0, 0, 0]; this.assets.forEach(a => counts[a.stage]++);
    const stats = [{ label: 'ACTIVE ALERTS', value: String(this.assets.length), color: '#ffffff' }, { label: 'CONFIRMED+', value: String(counts[3] + counts[4]), color: '#4d8dff' }, { label: 'EXCEPTIONAL', value: String(counts[4]), color: '#f06ee2' }, { label: 'AVG ORGANIC PROB', value: '0.81', color: '#dfe6f6' }, { label: 'PRECISION@20 · 24H', value: '0.62', color: '#e35ff2' }];
    const tape = st.tape.map((e, i) => ({ ...e, kindColor: e.kc, chainColor: chainColor(e.chain), anim: i === 0 ? 'vsFlash 1s ease-out' : 'none' }));
    return {
      clock: st.clock, tabs,
      liveDotColor: st.serverError ? '#ff4fae' : (live ? '#4d8dff' : '#e35ff2'),
      liveDotAnim: st.serverError ? 'none' : (live ? 'vsBlink 1.4s infinite' : 'none'),
      liveLabel: st.serverError ? 'SERVER OFFLINE' : (live ? 'LIVE' : 'PAUSED'),
      serverError: st.serverError,
      isLive: st.page === 'live', isDetail: st.page === 'detail', isRotation: st.page === 'rotation', isEval: st.page === 'eval', isHealth: st.page === 'health',
      goLive: nav('live'), stats, headers, rows, tape, d, rowCount: rows.length,
      views, chainFilters, classFilters,
      isAlerts: st.page === 'alerts', isSocial: st.page === 'social', isWallets: st.page === 'wallets',
      toggleSound: () => this.setState(s => ({ soundOn: !s.soundOn })),
      soundLabel: st.soundOn ? 'SOUND ON' : 'SOUND OFF', soundFg: st.soundOn ? '#f06ee2' : '#6b7699',
      toastVisible: !!st.toast, toastTitle: st.toast ? st.toast.title : '', toastBody: st.toast ? st.toast.body : '',
      dismissToast: () => this.setState({ toast: null }),
      chepeStats: [{ k: 'Hard vetoes today', v: '14' }, { k: 'Honeypots blocked', v: '6' }, { k: 'Fake stock tokens', v: '2' }, { k: 'Wash clusters flagged', v: '5' }],
      chepeLast: 'Last veto — $SAFEGEM2 (BNB): honeypot, sell path reverts. Chepe says no.',
      ...this.chepePickVals(),
      ...walletsVals(this), ...socialVals(this), ...alertsVals(this), ...rotationVals(this), ...evalVals(this), ...healthVals(this)
    };
  }



  chepePickVals() {
    const day = new Date().toISOString().slice(0, 10);
    const cands = this.assets.filter(a => (a.wash ?? 0) < 0.15 && a.stage >= 2);
    if (!cands.length) {
      return {
        chepePickSym: '—', chepePickChain: '—', chepePickChainColor: '#a3aed0',
        chepePickScore: '0', chepePickQuip: 'Server offline', openChepePick: () => {}
      };
    }
    const a = cands[this.h('chepe' + day) % cands.length];
    const quips = ['Clean wash score, real buyers. Chepe approves.', 'Breadth is growing and the LPs are staying. Good dog energy.', 'Oracle fresh, contract canonical. Chepe sniffed it thoroughly.', 'Liquidity keeps arriving and nobody is rugging. Rare.'];
    return {
      chepePickSym: a.sym, chepePickChain: a.chain, chepePickChainColor: chainColor(a.chain),
      chepePickScore: String(Math.round(a.score)),
      chepePickQuip: quips[this.h(a.id + day) % quips.length],
      openChepePick: () => this.setState({ page: 'detail', selectedId: a.id })
    };
  }


  render() {
    const v = this.renderVals(); return (
      <>
        <div style={css("font-family:'Poppins',sans-serif;font-size:12px;background:linear-gradient(180deg,#03060f 0%,#081736 55%,#0c2b63 140%);min-height:100vh;display:flex;flex-direction:column", { v })}>
          <AppHeader v={v} css={css} />
          {v.serverError ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', textAlign: 'center' }}>
              <div style={{ background: '#0a1226', border: '1px solid #ff4fae', borderRadius: '16px', padding: '36px 48px', maxWidth: '520px', boxShadow: '0 10px 30px rgba(255, 79, 174, 0.15)' }}>
                <div style={{ fontSize: '10px', fontWeight: '800', letterSpacing: '1.5px', color: '#ff4fae', textTransform: 'uppercase', marginBottom: '8px' }}>
                  CONNECTION ERROR
                </div>
                <div style={{ fontSize: '20px', fontWeight: '800', color: '#ffffff', marginBottom: '12px' }}>
                  ( server not working )
                </div>
                <div style={{ fontSize: '11px', color: '#8b96b8', lineHeight: '1.6', marginBottom: '20px' }}>
                  The VibeScreener market data server is offline or unreachable. All live assets, feeds, and analytics across all tabs have been hidden.
                </div>
                <div style={{ background: '#0d1730', border: '1px solid #1c2a4d', borderRadius: '8px', padding: '10px 14px', fontSize: '10px', color: '#c6d1ea', fontFamily: 'monospace', textAlign: 'left', marginBottom: '16px' }}>
                  $ npm run server
                </div>
                <div style={{ fontSize: '9.5px', color: '#6b7699' }}>
                  Start the server at <span style={{ color: '#4fc3f7' }}>https://vibe-mm-server.onrender.com/</span> to resume live streaming. Retrying automatically every 5s...
                </div>
              </div>
            </div>
          ) : (
            <>
              <LiveOpportunities v={v} css={css} />
              <AlertCards v={v} css={css} />
              <AssetDetail v={v} css={css} />
              <Rotation v={v} css={css} />
              <Wallets v={v} css={css} />
              <SocialScanner v={v} css={css} />
              <Evaluation v={v} css={css} />
              <SystemHealth v={v} css={css} />
            </>
          )}
          {v.toastVisible && (!v.serverError) && (<>
            <div style={css("position:fixed;right:18px;bottom:18px;z-index:60;width:340px;background:rgba(13,23,48,.97);border:1px solid #f06ee2;border-radius:14px;padding:12px 14px;box-shadow:0 12px 40px rgba(0,0,0,.55);animation:vsFlash 1s ease-out", { v })}><div style={css("display:flex;justify-content:space-between;align-items:center;margin-bottom:5px", { v })}><span style={css("font-size:9px;font-weight:800;letter-spacing:1px;color:#f06ee2", { v })}>{v.toastTitle}</span><span className="h3eb549cf" onClick={v.dismissToast} style={css("cursor:pointer;color:#6b7699;font-size:12px;padding:0 4px", { v })}>✕</span></div><div style={css("font-size:11px;color:#c6d1ea;line-height:1.5", { v })}>{v.toastBody}</div></div>
          </>)}
        </div>
      </>
    );
  }

}

App.defaultProps = { liveFeed: true, simSpeed: 2, showAdjusted: true };
export default App;
