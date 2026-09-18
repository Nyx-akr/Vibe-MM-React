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
import { css } from './utils/css';
import { fmtUsd, fmtAge, fmtPrice, stageInfo, chainColor, clsColor, scoreColor, washColor } from './utils/formatters';
import { chains as chainList, chainKeys, chainNameToKey } from './data/chains';
import { defaultWalletRegistry, normalizeRegistry } from './data/wallet-registry';
import { nextTape } from './services/live-feed';
import {
  fetchLiveMarketData,
  fetchLiveWalletData,
  fetchLiveEvalData,
  fetchLiveSystemData,
  fetchLiveTokenIntel,
  fetchLiveOhlcv,
  API_ORIGIN
} from './services/api';
import {
  startWalletIntel, stopWalletIntel, onWalletIntel, walletIntelStatus,
} from './services/wallet-intel';
import {
  startSocialIntel, stopSocialIntel, onSocialIntel,
} from './services/social-intel';
import {
  startRotationIntel, stopRotationIntel, onRotationIntel,
} from './services/rotation-intel';
import AppHeader from './components/AppHeader';
import SelectAssetPrompt from './components/SelectAssetPrompt';
import SideNav from './components/SideNav';
import AlertToasts from './components/AlertToasts';
import AssetBar from './components/AssetBar';
/** The one selected-state palette shared by every filter chip. */
// Opaque, not translucent. A semi-transparent fill composites over the page's
// near-black gradient and lands DARKER than the unselected #0a1226, which made
// a selected chip look unselected. #0e2a5c is the blue-active fill already used
// elsewhere in the app.
const CHIP_ACTIVE_BG = '#0e2a5c';
const CHIP_ACTIVE_BD = '#4d8dff';
const CHIP_ACTIVE_FG = '#6ea0ff';

/** Tabs that describe a single token, and cannot render without one. */
/** Alerts on screen at once, and how many wait behind them to backfill. */
const TOAST_VISIBLE = 3;
const TOAST_BACKLOG = 12;
/** How long the opened card keeps blinking before it settles. */
const ALERT_PING_MS = 1800;
/** How long the feed table keeps blinking after a disabled tab is clicked. */
const TABLE_PING_MS = 1900;

const SELECTION_TABS = { detail: 'ASSET DETAIL', wallets: 'WALLETS', social: 'SOCIAL SCANNER' };

class App extends React.Component {
  constructor(props) {
    super(props); this.state = { page: 'live', sortKey: 'score', sortDir: -1, selectedId: null, clock: '', tick: 0, tape: [], flashId: null, expandedId: null, viewF: 'ALL', chainF: 'ALL', classF: 'ALL', searchQ: '', watch: {}, soundOn: false, toasts: [], alertPing: null, tablePing: false, serverError: false, intel: null, intelState: 'idle', bars: null, barsState: 'idle' };
    try { const w = JSON.parse(localStorage.getItem('vs_watchlist') || 'null'); if (w) this.state.watch = w; } catch (e) { }
    this.assets = []; this.tapeSeq = 0;
    this.state.walletInput = ''; this.state.walletLabel = '';
    this.state.walletFilter = 'ALL';
    let saved = null; try { saved = JSON.parse(localStorage.getItem('vs_wallet_registry') || 'null'); } catch (e) { }
    this.state.registry = normalizeRegistry(saved || defaultWalletRegistry);
  }

  /** Full addresses the user is tracking, for the wallet join. */
  trackedAddresses() { return (this.state.registry || []).map((w) => w.address).filter(Boolean); }

  /**
   * The token the user has open, including one that has since dropped out of
   * the trending feed.
   *
   * renderVals keeps showing such a token from `lastSelected` rather than
   * swapping the view to something else. The fetch side has to agree with it:
   * reading only `this.assets` left the asset-scoped tabs captioned with a
   * token they would then never fetch data for.
   */
  selectedAsset() {
    const found = this.assets.find((a) => a.id === this.state.selectedId);
    if (found) return found;
    return this.state.selectedId && this.lastSelected &&
      this.lastSelected.id === this.state.selectedId ? this.lastSelected : null;
  }
  h(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; } return h; }
  srand(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

  async syncLiveData() {
    try {
      const liveAssets = await fetchLiveMarketData(chainKeys);
      if (liveAssets && liveAssets.length > 0) {
        this.assets = liveAssets;

        const chain = this.state.chainF !== 'ALL' ? (chainNameToKey[this.state.chainF] || 'solana') : 'solana';

        if (this.state.page === 'wallets') {
          // Wallets reads ONE pool's trades, so it follows the selection, not
          // the chain filter - and it follows the selected token's own chain,
          // which is not necessarily the one the filter is pointing at.
          const selected = this.selectedAsset();
          const walletChain = (selected && selected.rawServerRow && selected.rawServerRow.chain) ||
            chain;
          const walletData = selected
            ? await fetchLiveWalletData(walletChain, selected, this.trackedAddresses())
            : null;
          this.setState({ apiWallets: walletData });
        } else if (this.state.page === 'eval') {
          const evalData = await fetchLiveEvalData(chain);
          if (evalData) this.setState({ apiEval: evalData });
        } else if (this.state.page === 'health') {
          const systemData = await fetchLiveSystemData();
          if (systemData) this.setState({ apiSystem: systemData });
        }

        this.setState({ serverError: false });
        this.syncAlertToasts();
      } else {
        this.assets = [];
        this.setState({
          serverError: true,
          apiWallets: null,
          apiEval: null,
          apiSystem: null
        });
      }
    } catch (e) {
      this.assets = [];
      this.setState({
        serverError: true,
        apiWallets: null,
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

    // Wallet intelligence runs whether or not the WALLETS tab is open, so
    // every module can ask about a wallet at any time and the memory keeps
    // building across tokens instead of restarting on each visit.
    startWalletIntel({
      baseUrl: API_ORIGIN,
      chains: chainKeys,
      getTracked: () => this.trackedAddresses(),
    });
    // Re-render on new wallet findings; the tick is throttled, not per-trade.
    this.offWalletIntel = onWalletIntel(() => {
      if (this.state.page === 'wallets') this.setState({ walletIntelAt: Date.now() });
    });

    // Social intelligence runs on the same terms: every token on the board is
    // measured every tick whether or not the SOCIAL SCANNER is open, so the
    // mention history keeps building instead of restarting on each visit and
    // any module can ask about a ticker at any time.
    startSocialIntel({
      baseUrl: API_ORIGIN,
      chains: chainKeys,
      getSymbols: () => this.assets.map((a) => ({
        symbol: (a.rawServerRow && a.rawServerRow.symbol) || a.sym,
      })),
    });
    this.offSocialIntel = onSocialIntel(() => {
      if (this.state.page === 'social') this.setState({ socialIntelAt: Date.now() });
    });

    // Rotation runs on the same terms, and costs nothing extra: it attaches
    // to the trade samples wallet intelligence is already reading, so the
    // graph for every chain is standing ready before the tab is opened and
    // any module can ask what a pool is rotating into.
    startRotationIntel();
    this.offRotationIntel = onRotationIntel(() => {
      if (this.state.page === 'rotation') this.setState({ rotationIntelAt: Date.now() });
    });

    for (let i = 0; i < 7; i++) this.pushTape(false);
  }
  componentDidUpdate() {
    if (this.state.page !== 'detail') { this.detailKey = null; return; }
    this.loadDetailData(this.assets.find(a => a.id === this.state.selectedId));
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
      fetchLiveTokenIntel(row.chain, row.tokenAddress, row.poolAddress || '', row),
      fetchLiveOhlcv(row.chain, row.poolAddress, 'minute', 1, 60)
    ]);
    if (this.detailKey !== key) return;

    // No score is folded back here any more. Fetching intel caches it, and the
    // next feed poll - at most 5s away - is what recomputes the one score both
    // this page and the table read. Writing a second score in here is exactly
    // what used to make the two disagree.

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

  /**
   * Answer to clicking a tab that needs a token when none is picked. Pointing
   * at the table is no use from another tab, so this goes to the feed first and
   * then blinks the table there - the instruction and the thing it refers to
   * end up on screen together.
   */
  promptSelectAsset() {
    clearTimeout(this.tablePingTimer);
    // Restart the animation even if it is already running.
    this.setState({ page: 'live', tablePing: false }, () => {
      this.setState({ tablePing: true });
      this.tablePingTimer = setTimeout(() => this.setState({ tablePing: false }), TABLE_PING_MS);
    });
  }

  componentWillUnmount() {
    clearInterval(this.clockTimer);
    clearInterval(this.simTimer);
    clearInterval(this.apiTimer);
    clearTimeout(this.pingTimer);
    clearTimeout(this.tablePingTimer);
    if (this.offWalletIntel) this.offWalletIntel();
    stopWalletIntel();
    if (this.offSocialIntel) this.offSocialIntel();
    stopSocialIntel();
    if (this.offRotationIntel) this.offRotationIntel();
    stopRotationIntel();
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
  }

  /**
   * Mirrors the ALERT CARDS page into the toast stack.
   *
   * Runs on every data sync rather than on a timer or a dice roll: a card that
   * appears on the page has to appear here too, or the popup is lying about
   * what the bot would have sent. Each alert is raised exactly once - `seen`
   * is keyed by class and alert id, so a card still standing on the next sync
   * does not re-announce itself.
   *
   * The backlog runs deeper than the three on screen so that dismissing one
   * promotes the next-newest instead of leaving a gap.
   *
   * The first sync only primes `seen`. Whatever was already standing when the
   * page loaded is history, not news - popping a stack of it on every refresh
   * would train you to dismiss the stack without reading it, which is exactly
   * how a real alert gets missed. Notifications start at the first CHANGE.
   */
  syncAlertToasts() {
    const columns = alertsVals(this).alertColumns || [];
    const cards = columns.reduce((all, col) => all.concat(col.cards || []), []);
    const seen = this.alertSeen || (this.alertSeen = {});
    const priming = !this.alertPrimed;
    this.alertPrimed = true;

    const fresh = [];
    for (const c of cards) {
      const key = c.cls + ':' + c.id;
      if (seen[key]) continue;
      seen[key] = true;
      fresh.push({
        key, accent: c.accent,
        label: c.outcome || c.cls,
        title: c.sym + ' / ' + c.chain,
        body: c.claim,
        meta: 'conf ' + (c.conf == null ? '—' : c.conf.toFixed(2)) +
          ' · horizon ' + c.horizon + ' · ' + c.id
      });
    }
    if (priming || !fresh.length) return;

    if (this.state.soundOn) this.beep();
    this.setState((st) => ({ toasts: fresh.concat(st.toasts).slice(0, TOAST_BACKLOG) }));
  }

  dismissToast(key) {
    this.setState((st) => ({ toasts: st.toasts.filter((t) => t.key !== key) }));
  }

  /**
   * Follows a toast to its card: the toast has done its job so it closes, and
   * the card blinks on arrival. Landing on a wall of alert cards with no idea
   * which one you just clicked is the whole problem this solves.
   */
  openAlertCard(key) {
    clearTimeout(this.pingTimer);
    this.setState((st) => ({
      page: 'alerts',
      toasts: st.toasts.filter((t) => t.key !== key),
      alertPing: key
    }));
    this.pingTimer = setTimeout(() => this.setState({ alertPing: null }), ALERT_PING_MS);
  }

  /** Clears the backlog too, not just the three on screen. */
  dismissAllToasts() {
    this.setState({ toasts: [] });
  }

  pushTape(update) {
    const tape = nextTape(this.state.tape, this.tapeSeq++, update, (nextState) => this.setState(nextState));
    if (!update) this.state.tape = tape;
  }
  renderVals() {
    const st = this.state, showAdj = this.props.showAdjusted !== false, live = this.props.liveFeed !== false;
    const nav = (p) => () => this.setState({ page: p });
    // One selected look for every filter group. ALL used to go purple while
    // the chain chips went to their own colour, so switching filters changed
    // the shape of the control as well as the selection.
    const chip = (label, active, go) => ({
      label, go,
      bg: active ? CHIP_ACTIVE_BG : '#0a1226',
      fg: active ? CHIP_ACTIVE_FG : '#8b96b8',
      bd: active ? CHIP_ACTIVE_BD : '#1c2a4d'
    });
    const views = [['ALL', 'All'], ['WATCHLIST', '★ Watchlist'], ['CONFIRMED', 'Confirmed+'], ['EXPERIMENTAL', 'Experimental']].map(([k, label]) => chip(label, st.viewF === k, () => this.setState({ viewF: k })));
    // The table's chain chips are the only chain selector; the old navbar
    // pills duplicated this and carried invented latency figures.
    // Chain chips carry the same colour the chain has in the table's CHAIN
    // column, so the filter and the rows read as one palette.
    const tint = (hex, alpha) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
    };
    const chainChip = (name, active, go) => {
      if (name === 'ALL') return chip(name, active, go);
      const c = chainColor(name);
      // Chain colour stays in the text; the selected background and border
      // are the same blue every chip uses.
      return {
        label: name, go, fg: c,
        bg: active ? CHIP_ACTIVE_BG : '#0a1226',
        bd: active ? CHIP_ACTIVE_BD : tint(c, 0.35)
      };
    };
    const chainFilters = ['ALL'].concat(chainList.map((c) => c.name))
      .map(k => chainChip(k, st.chainF === k, () => this.setState({ chainF: k })));
    const classFilters = ['ALL', 'MEME', 'TOKEN'].map(k => chip(k, st.classF === k, () => this.setState({ classF: k })));
    // Ten columns, ordered by how much they matter - the feed drops the trailing
    // ones as the window narrows (see .vs-feed-* in App.css). Seven of the old
    // seventeen were folded into the cells they belong with rather than dropped:
    // chain, class and age ride under the symbol, confidence under the score,
    // Δ5M under the price, and buyers under net flow. Only TOP REASON left the
    // row outright - it is a sentence, it never fit, and the expanded row has
    // always shown the same triggers in full.
    const cols = [
      [null, '', 'mark'],
      ['sym', 'ASSET', 'asset'],
      ['stage', 'STAGE', 'stage'],
      ['score', 'SCORE', 'score', true],
      ['price', 'PRICE', 'price', true],
      ['liq', 'LIQUIDITY', 'liq', true],
      [showAdj ? 'adj' : 'vol', showAdj ? 'VOL 5M' : 'VOL 24H', 'vol', true],
      ['wash', 'WASH', 'risk', true],
      ['nf', 'NET FLOW', 'flow', true],
      [null, 'TREND', 'trend']
    ];
    const headers = cols.map(([k, label, col, num]) => ({
      label, col, num: !!num, sortable: !!k,
      arrow: st.sortKey === k ? (st.sortDir < 0 ? ' ▼' : ' ▲') : '', fg: st.sortKey === k ? '#e35ff2' : '#6b7699',
      sort: k ? () => this.setState(s => ({ sortKey: k, sortDir: s.sortKey === k ? -s.sortDir : -1 })) : () => { }
    }));
    // Typed once here rather than per row - $ is stripped from both sides so
    // "cate" matches $CATE and "$cate" matches it too.
    const q = st.searchQ.trim().toLowerCase().replace(/\$/g, '');
    const filtered = this.assets.filter(a => {
      if (st.chainF !== 'ALL' && a.chain !== st.chainF) return false;
      if (st.classF !== 'ALL' && a.cls !== st.classF) return false;
      if (q && (a.sym + ' ' + a.name).toLowerCase().replace(/\$/g, '').indexOf(q) === -1) return false;
      if (st.viewF === 'WATCHLIST' && !st.watch[a.id]) return false;
      if (st.viewF === 'CONFIRMED' && a.stage < 3) return false;
      if (st.viewF === 'EXPERIMENTAL' && a.liq >= 60000) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      const k = st.sortKey; const av = a[k], bv = b[k];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;          // nulls always last, whichever way we sort
      if (bv == null) return -1;
      if (typeof av === 'string') return String(av).localeCompare(String(bv)) * st.sortDir;
      return (av - bv) * st.sortDir;
    });
    const sevMap = { HIGH: { bg: '#45103a', fg: '#ff4fae' }, MED: { bg: '#33124a', fg: '#e35ff2' }, LOW: { bg: '#1a2440', fg: '#a3aed0' } };
    const rows = sorted.map(a => {
      const si = stageInfo(a.stage);
      const tr = a.spark.slice(-14); const tMax = Math.max(...tr), tMin = Math.min(...tr);
      return {
        // Clicking a row FOCUSES the token - it does not navigate. You stay in
        // the feed, the eye lights up, and the row opens to offer the scoped
        // tabs. Jumping straight to Asset Detail used to cost you your place in
        // the table every time you wanted a second look at something.
        open: () => this.setState((s) => s.expandedId === a.id
          ? { expandedId: null }
          : { expandedId: a.id, selectedId: a.id }),
        goDetail: () => this.setState({ page: 'detail', selectedId: a.id }),
        goSocial: () => this.setState({ page: 'social', selectedId: a.id }),
        goWallets: () => this.setState({ page: 'wallets', selectedId: a.id }),
        star: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.toggleWatch(a.id); },
        // A tint alone reads as "slightly different row" at a glance. The white
        // ring is the thing that actually locates the selection - drawn inset so
        // it costs no layout and the grid columns stay aligned down the table.
        selected: st.selectedId === a.id,
        selBg: st.selectedId === a.id ? 'rgba(227,95,242,0.14)' : 'transparent',
        selBar: st.selectedId === a.id ? '#ffffff' : 'transparent',
        selRing: st.selectedId === a.id ? 'inset 0 0 0 1px #ffffff' : 'none',
        starGlyph: st.watch[a.id] ? '★' : '☆', starColor: st.watch[a.id] ? '#f06ee2' : '#3a4568',
        expanded: st.expandedId === a.id,
        trend: tr.map(v => ({ h: Math.round(15 + (v - tMin) / (tMax - tMin + 0.01) * 85) + '%', c: v >= tr[0] ? '#4d8dff' : '#ff4fae' })),
        // What the expanded row shows: the same figures the table carries, but
        // every one of them captioned in words. The sparkline and the trigger
        // codes it used to show were the two things nobody could read at a
        // glance, and the columns the feed hides on a narrow window are exactly
        // the ones worth spelling out here.
        peekStats: [
          { label: 'LIQUIDITY', value: fmtUsd(a.liq), sub: 'pool depth', color: '#dfe6f6' },
          {
            label: showAdj ? 'VOLUME 5M' : 'VOLUME 24H',
            value: fmtUsd(showAdj ? a.adj : a.vol), sub: 'traded', color: '#dfe6f6'
          },
          {
            label: 'BUYERS 5M', value: a.buyers == null ? '—' : String(a.buyers),
            sub: 'separate wallets', color: '#dfe6f6'
          },
          {
            label: 'NET FLOW', value: fmtUsd(a.nf), sub: a.nf >= 0 ? 'more in than out' : 'more out than in',
            color: a.nf >= 0 ? '#4d8dff' : '#ff4fae'
          },
          {
            label: 'PRICE 5M', value: (a.chg >= 0 ? '+' : '') + (a.chg * 100).toFixed(1) + '%',
            sub: 'move this bar', color: a.chg >= 0 ? '#4d8dff' : '#ff4fae'
          },
          {
            label: 'WASH', value: a.wash == null ? '—' : Math.round(a.wash * 100) + '%',
            // A percentage means nothing without knowing which way is good.
            sub: a.wash == null ? 'not measured yet'
              : a.wash < 0.15 ? 'looks like real trading'
                : a.wash < 0.35 ? 'some self-trading' : 'mostly self-trading',
            color: a.wash == null ? '#3a4568' : washColor(a.wash)
          },
          { label: 'AGE', value: fmtAge(a.age), sub: 'since the pool opened', color: '#dfe6f6' }
        ],
        peekFlags: a.flags.slice(0, 2).map(f => ({ sev: f.sev, bg: sevMap[f.sev].bg, fg: sevMap[f.sev].fg, text: f.text })),
        anim: st.flashId === a.id ? 'vsFlash 1.2s ease-out' : 'none',
        stage: si.n, stageBg: si.bg, stageFg: si.fg,
        score: a.score == null ? '—' : Math.round(a.score), scoreColor: a.score == null ? '#3a4568' : scoreColor(a.score),
        partialScore: a.score != null && a.scoreBasis !== 'intel',
        conf: a.conf == null ? '—' : a.conf.toFixed(2),
        sym: a.sym, name: a.name, chain: a.chain, chainColor: chainColor(a.chain), cls: a.cls, clsColor: clsColor(a.cls),
        age: a.age == null ? '—' : fmtAge(a.age),
        price: a.price == null ? '—' : fmtPrice(a.price),
        chg: a.chg == null ? '—' : (a.chg >= 0 ? '+' : '') + (a.chg * 100).toFixed(1) + '%',
        chgColor: a.chg == null ? '#3a4568' : a.chg >= 0 ? '#4d8dff' : '#ff4fae',
        liq: a.liq == null ? '—' : fmtUsd(a.liq),
        vol: (showAdj ? a.adj : a.vol) == null ? '—' : fmtUsd(showAdj ? a.adj : a.vol), volTag: '',
        buyers: a.buyers == null ? '—' : a.buyers,
        netflow: a.nf == null ? '—' : fmtUsd(a.nf), nfColor: a.nf == null ? '#3a4568' : a.nf >= 0 ? '#4d8dff' : '#ff4fae',
        wash: a.wash == null ? '—' : Math.round(a.wash * 100) + '%', washColor: a.wash == null ? '#3a4568' : washColor(a.wash), reason: a.reason
      };
    });
    // The feed reorders every 5s and a token can drop out of it. Keep showing
    // the token the user opened (with a staleness note) instead of silently
    // swapping the detail view to a different asset.
    let sel = this.assets.find(a => a.id === st.selectedId);
    if (sel) { this.lastSelected = sel; this.lastSelectedAt = Date.now(); }
    else if (st.selectedId && this.lastSelected && this.lastSelected.id === st.selectedId) sel = this.lastSelected;
    else sel = null;
    const staleMs = sel && this.lastSelected === sel && !this.assets.includes(sel) ? Date.now() - this.lastSelectedAt : 0;

    // Nav mirrors SELECTION_TABS: everything asset-scoped hangs off ASSET DETAIL,
    // everything else is app-wide. Deriving `child` from the same map keeps the
    // sidebar honest if a tab later changes scope.
    // One flat list. The three token-scoped tabs are indented under LIVE
    // OPPORTUNITIES because that is where you pick the token they describe -
    // the indent carries the relationship, so no group headers are needed and
    // the items can stay one word each.
    const navItem = (k, label, child) => {
      const active = st.page === k;
      const scoped = Boolean(SELECTION_TABS[k]);
      // A scoped tab with nothing selected has nothing to show, so it does not
      // open at all - it sends you to where the choice is actually made and
      // flags the table, rather than dumping you on an empty page.
      const disabled = scoped && !sel;
      return {
        label, child: !!child, disabled,
        go: disabled ? () => this.promptSelectAsset() : nav(k),
        hint: disabled ? 'Choose an asset from Live Opportunities' : '',
        indent: child ? 30 : 16,
        fg: active ? '#e35ff2' : (disabled ? '#4a5473' : '#8b96b8'),
        tickC: active ? '#e35ff2' : '#39445f',
        line: active ? '#e35ff2' : 'transparent',
        bg: active ? 'rgba(227,95,242,0.07)' : 'transparent'
      };
    };
    const navItems = [
      navItem('live', 'LIVE OPPORTUNITIES'),
      navItem('detail', 'DETAIL', true),
      navItem('social', 'SOCIAL', true),
      navItem('wallets', 'WALLETS', true),
      navItem('rotation', 'ROTATION'),
      navItem('alerts', 'ALERTS'),
      navItem('eval', 'EVALUATION'),
      navItem('health', 'HEALTH')
    ];
    const d = detailVals(this, sel, showAdj, {
      intel: st.intel, bars: st.bars, intelState: st.intelState, barsState: st.barsState, staleMs
    });
    const counts = [0, 0, 0, 0, 0]; this.assets.forEach(a => counts[a.stage]++);
    // Organic score comes from Jupiter (Solana) or a trade-sample analysis;
    // tokens without one are excluded rather than counted as average.
    const organicScores = this.assets
      .map(a => {
        const row = a.rawServerRow || {};
        const jup = row.jupiter;
        if (jup && Number.isFinite(jup.organicScore)) return jup.organicScore;
        if (row.flow && Number.isFinite(row.flow.organicFlow)) return row.flow.organicFlow;
        return null;
      })
      .filter(x => x !== null);
    const avgOrganic = organicScores.length
      ? (organicScores.reduce((sum, x) => sum + x, 0) / organicScores.length / 100).toFixed(2)
      : '—';

    const stats = [
      { label: 'TOKENS TRACKED', value: String(this.assets.length), color: '#ffffff' },
      { label: 'CONFIRMED+', value: String(counts[3] + counts[4]), color: '#4d8dff' },
      { label: 'EXCEPTIONAL', value: String(counts[4]), color: '#f06ee2' },
      { label: 'AVG ORGANIC SCORE', value: avgOrganic, color: avgOrganic === '—' ? '#3a4568' : '#dfe6f6',
        sub: organicScores.length ? organicScores.length + ' of ' + this.assets.length + ' scored' : 'no source' },
      // Precision@20 needs forward returns, which nothing records yet.
      { label: 'PRECISION@20 · 24H', value: '—', color: '#3a4568', sub: 'needs outcome tracking' }
    ];
    const tape = st.tape.map((e, i) => ({ ...e, kindColor: e.kc, chainColor: chainColor(e.chain), anim: i === 0 ? 'vsFlash 1s ease-out' : 'none' }));
    return {
      clock: st.clock, navItems,
      tablePingAnim: st.tablePing ? 'vsTablePing .62s ease-in-out 3' : 'none',
      liveDotColor: st.serverError ? '#ff4fae' : (live ? '#4d8dff' : '#e35ff2'),
      liveDotAnim: st.serverError ? 'none' : (live ? 'vsBlink 1.4s infinite' : 'none'),
      liveLabel: st.serverError ? 'SERVER OFFLINE' : (live ? 'LIVE' : 'PAUSED'),
      serverError: st.serverError,
      hasSelection: Boolean(sel),
      // The identity bar belongs to the asset-scoped tabs only - the same set
      // the sidebar nests under ASSET DETAIL. ALERT CARDS, EVALUATION and
      // SYSTEM HEALTH describe the screener, not a token, so a symbol and a
      // score pinned above them would be captioning the wrong thing.
      showAssetBar: Boolean(sel) && Boolean(SELECTION_TABS[st.page]),
      needsSelection: !sel && Boolean(SELECTION_TABS[st.page]),
      selectionTabLabel: SELECTION_TABS[st.page] || '',
      isLive: st.page === 'live', isDetail: st.page === 'detail', isRotation: st.page === 'rotation', isEval: st.page === 'eval', isHealth: st.page === 'health',
      goLive: nav('live'), stats, headers, rows, tape, d, rowCount: rows.length,
      views, chainFilters, classFilters,
      searchQ: st.searchQ,
      onSearch: (e) => this.setState({ searchQ: e.target.value }),
      clearSearch: () => this.setState({ searchQ: '' }),
      hasSearch: st.searchQ.trim().length > 0,
      isAlerts: st.page === 'alerts', isSocial: st.page === 'social', isWallets: st.page === 'wallets',
      toggleSound: () => this.setState(s => ({ soundOn: !s.soundOn })),
      soundLabel: st.soundOn ? 'SOUND ON' : 'SOUND OFF', soundFg: st.soundOn ? '#f06ee2' : '#6b7699',
      // Only the newest three reach the screen; the rest wait in the backlog.
      toasts: st.toasts.slice(0, TOAST_VISIBLE).map((t, i) => ({
        ...t, fresh: i === 0,
        dismiss: () => this.dismissToast(t.key),
        open: () => this.openAlertCard(t.key)
      })),
      toastBacklog: Math.max(0, st.toasts.length - TOAST_VISIBLE),
      closeAllToasts: () => this.dismissAllToasts(),
      alertPing: st.alertPing,
      chepeStats: [{ k: 'Hard vetoes today', v: '14' }, { k: 'Honeypots blocked', v: '6' }, { k: 'Fake stock tokens', v: '2' }, { k: 'Wash clusters flagged', v: '5' }],
      chepeLast: 'Last veto — $SAFEGEM2 (BNB): honeypot, sell path reverts. Chepe says no.',
      ...this.chepePickVals(),
      ...walletsVals(this, sel), ...socialVals(this, sel), ...alertsVals(this), ...rotationVals(this), ...evalVals(this), ...healthVals(this)
    };
  }



  chepePickVals() {
    const day = new Date().toISOString().slice(0, 10);
    const cands = this.assets.filter(a => (a.wash ?? 0) < 0.15 && a.stage >= 2 && a.score != null);
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
      chepePickScore: a.score == null ? '—' : String(Math.round(a.score)),
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
            <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <SideNav v={v} />
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
              {v.showAssetBar && <AssetBar v={v} />}
              <LiveOpportunities v={v} css={css} />
              <AlertCards v={v} css={css} />
              {v.needsSelection ? <SelectAssetPrompt v={v} css={css} /> : (<>
                <AssetDetail v={v} css={css} />
                <Wallets v={v} css={css} />
                <SocialScanner v={v} css={css} />
              </>)}
              <Rotation v={v} css={css} />
              <Evaluation v={v} css={css} />
              <SystemHealth v={v} css={css} />
              </div>
            </div>
          )}
          {!v.serverError && <AlertToasts v={v} css={css} />}
        </div>
      </>
    );
  }

}

App.defaultProps = { liveFeed: true, simSpeed: 2, showAdjusted: true };
export default App;
