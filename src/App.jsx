import React from 'react';
import './App.css';
import LiveOpportunities from './tabs-modules/LIVE-OPPORTUNITIES';
import AssetDetail from './tabs-modules/ASSET-DETAIL';
import Rotation from './tabs-modules/ROTATION';
import MarketRotation, { marketRotationVals } from './tabs-modules/MARKET-ROTATION';
import Wallets from './tabs-modules/WALLETS';
import SocialScanner from './tabs-modules/SOCIAL-SCANNER';
import AlertCards from './tabs-modules/ALERT-CARDS';
import Evaluation from './tabs-modules/EVALUATION';
import SystemHealth from './tabs-modules/SYSTEM-HEALTH';
import WalletTracker, { trackerVals } from './tabs-modules/WALLET-TRACKER';
import { detectWalletMoves, shouldAlarm } from './services/wallet-alerts';
import { detailVals } from './tabs-modules/ASSET-DETAIL';
import { rotationVals } from './tabs-modules/ROTATION';
import { walletsVals } from './tabs-modules/WALLETS';
import { socialVals } from './tabs-modules/SOCIAL-SCANNER';
import { alertsVals } from './tabs-modules/ALERT-CARDS';
import { evalVals } from './tabs-modules/EVALUATION';
import { healthVals } from './tabs-modules/SYSTEM-HEALTH';
import { css } from './utils/css';
import { fmtUsd, chainColor, clsColor, scoreColor, signalInfo, SIGNAL_INFO, phaseColor } from './utils/formatters';
import { chains as chainList, chainKeys, chainNameToKey } from './data/chains';

/**
 * The chain filter is a SET of chains, not one chain or ALL. Every chain on is
 * what ALL means, so there is no separate flag to drift out of step with it.
 */
const allChains = () => Object.fromEntries(chainList.map((c) => [c.name, true]));
const selectedChains = (sel) => chainList.map((c) => c.name).filter((n) => sel && sel[n]);
const isAllChains = (sel) => selectedChains(sel).length === chainList.length;

/**
 * One click on a chain chip toggles that chain, and nothing else:
 *   - with ALL on (every chain on), clicking a chain turns it off - and so ALL
 *     reads off, because ALL simply means every chain is on;
 *   - turning the last missing chain back on makes ALL read on again;
 *   - turning off the only chain still on would leave an empty board, so that
 *     click restores every chain instead of showing nothing.
 */
/**
 * A saved selection, kept only for chains that still exist. Nothing saved, or
 * nothing left of it, is ALL - so a renamed chain never strands the board empty.
 */
function restoreChains(saved) {
  if (!saved) return allChains();
  const kept = Object.fromEntries(chainList.map((c) => c.name).filter((n) => saved[n]).map((n) => [n, true]));
  return Object.keys(kept).length ? kept : allChains();
}

/** Remembers the chips across reloads. ALL is stored as nothing. */
function saveChains(sel) {
  setInput('chainSelection', isAllChains(sel) ? null : sel);
  return sel;
}


/**
 * The SIGNALS filter: a set of signals (flow/score-flow.js SIGNALS), every one
 * on meaning "everything" - including tokens with no call yet. Same rules as
 * the chain chips.
 */
const SIGNAL_KEYS = Object.keys(SIGNAL_INFO);
const allSignals = () => Object.fromEntries(SIGNAL_KEYS.map((k) => [k, true]));
const isAllSignals = (sel) => SIGNAL_KEYS.every((k) => sel && sel[k]);
function restoreSignals(saved) {
  if (!saved) return allSignals();
  const kept = Object.fromEntries(SIGNAL_KEYS.filter((k) => saved[k]).map((k) => [k, true]));
  return Object.keys(kept).length ? kept : allSignals();
}
function saveSignals(sel) {
  setInput('signalSelection', isAllSignals(sel) ? null : sel);
  return sel;
}
function toggleSignal(sel, key) {
  const next = Object.assign({}, sel, { [key]: !sel[key] });
  if (!next[key]) delete next[key];
  return SIGNAL_KEYS.some((k) => next[k]) ? next : allSignals();
}

function toggleChain(sel, name) {
  const next = Object.assign({}, sel, { [name]: !sel[name] });
  if (!next[name]) delete next[name];
  return selectedChains(next).length ? next : allChains();
}
import { defaultWalletRegistry, normalizeRegistry } from './data/wallet-registry';
import { nextTape } from './services/live-feed';
import { fetchTokenOutcomes,
  fetchLiveMarketData,
  fetchLiveWalletData,
  fetchLiveEvalData,
  fetchLiveSystemData,
  fetchLiveTokenIntel,
  fetchLiveOhlcv,
  initApiBase,
  usingLocalApi,
  API_ORIGIN,
  fetchPrecisionInputs,
  fetchStorageTimeline,
  restoreDerived,
  storeFreshness
} from './services/api';
import {
  startWalletIntel, stopWalletIntel, onWalletIntel, walletIntelStatus, walletProfile,
} from './services/wallet-intel';
import {
  startSocialIntel, stopSocialIntel, onSocialIntel,
} from './services/social-intel';
import {
  startRotationIntel, stopRotationIntel, onRotationIntel,
} from './services/rotation-intel';
import { startEthosIntel, stopEthosIntel } from './services/ethos-intel';
import * as historyStore from './services/storage/history-store';
import { migrateLegacyStorage } from './services/storage/migrate';
import { getInput, setInput } from './services/storage/input-store';
import { hydrateJournal, journalFor } from './services/score-journal';
import AppHeader from './components/AppHeader';
import TabPopup from './components/TabPopup';
import EventTape from './components/EventTape';
import AlertToasts from './components/AlertToasts';
import { gateAssets, gateStats, gateDetail } from './flow/runtime';
import {
  runBoardFlow, boardValue, boardNote, dailyPickAsset,
  PRECISION_MIN_PICKS, PRECISION_HORIZONS, organicGradeOf,
} from './flow/board-flow';
import { subscribeFlows, activeFlow } from './admin/flow-store';
import { loadModelEval } from './services/model-eval';
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

/** The dashboard windows, and the full view each one's DETAILS button opens. */
const POPUPS = { detail: 'ASSET DETAIL', social: 'SOCIAL SCANNER', wallets: 'WALLETS', rotation: 'ROTATION' };

/** What the token list can be ordered by. */
const SORT_OPTIONS = [
  // The signal leads: BUY first, EARLY breaking ties (api.js signalRank).
  { key: 'signalRank', label: 'Signal' },
  { key: 'early', label: 'EARLY' },
  { key: 'chg', label: '5m change' },
  { key: 'nf', label: 'Net flow' },
  { key: 'liq', label: 'Liquidity' },
  { key: 'buyers', label: 'Buyers' },
];

/**
 * The PRECISION@20 · 24H tile.
 *
 * It used to be a hard-coded em dash captioned "needs outcome tracking". The
 * archive is that outcome tracking, so the number is now measured - but a
 * measured number still has to say how much it is worth, and that is what the
 * sub-line carries.
 *
 * THE NUMBER IS NOT DISCOUNTED BY COVERAGE. Scaling a precision by uptime
 * yields something that is no longer a precision: 0.70 measured across half a
 * day would print as 0.35 and read as a bad model rather than a thin sample.
 * So the value stays honest and the caveat sits beside it, and below a floor
 * of either coverage or sample size the tile withholds the number entirely
 * rather than showing one nobody should act on.
 */
/** Market files older than this mean the collector has stopped writing. */
const STORE_STALE_MS = 60000;
/**
 * Distinct moments the picks must come from.
 *
 * The first version gated on raw COVERAGE, which was the same discounting
 * mistake this file argues against one paragraph up - suppressing the number
 * entirely is just a discount to zero. Coverage being low does not make a
 * precision wrong; it makes it unrepresentative, and the way that bites is
 * every pick coming from one short burst.
 *
 * `slicesEvaluated` measures exactly that, so it is the gate, and coverage
 * stays what it should be: a caveat printed beside the number.
 */
const PRECISION_MIN_SLICES = 4;
/** Outcomes move on the scale of hours; re-measuring faster is wasted work. */
const PRECISION_REFRESH_MS = 300000;
/** A 24h strip bucket is 30 minutes wide; polling faster cannot move a pixel. */
const STORAGE_TIMELINE_MS = 60000;

// The horizons tried and the minimum picks are the DATA FLOW's TOP 20 HIT
// RATE box's own (flow/board-flow.js PRECISION_HORIZONS, PRECISION_MIN_PICKS);
// the tile only captions what it measured.

const hoursLabel = (ms) => {
  const h = ms / 3600000;
  return (h >= 1 ? Math.round(h) : h) + 'H';
};

function precisionTile(p) {
  const dim = '#3a4568';
  // Says what is measured in plain words - "of our top 20, how many went up,
  // this long after we ranked them" - instead of the jargon "PRECISION@20".
  // The window is the one actually used: 24H when a full day of marks exists,
  // otherwise the longest shorter one that resolves (see PRECISION_HORIZONS),
  // so a 3H reading can never be mistaken for the 24H one.
  const label = 'TOP 20 HIT RATE · ' + hoursLabel((p && p.horizonMs) || 86400000) + ' LATER';
  if (!p) return { label, value: '—', color: dim, sub: 'measuring…' };
  if (p.error) return { label, value: '—', color: dim, sub: p.error };

  const pct = p.coverage == null ? null : Math.round(p.coverage * 100);
  // Coverage is always stated over the last 24h of the RECORD. It describes
  // how complete the archive is, not the precision's own window, so it stays
  // a fixed span whichever horizon ends up being used.
  const cov = pct == null ? 'coverage unknown' : pct + '% of last 24h recorded';

  if (p.evaluated < PRECISION_MIN_PICKS) {
    return {
      label, value: '—', color: dim,
      sub: p.exhausted
        ? 'no horizon resolves yet · ' + cov
        : p.pending
          ? p.pending + ' picks still maturing · ' + cov
          : p.evaluated + ' of ' + PRECISION_MIN_PICKS + ' picks resolved · ' + cov,
    };
  }
  if ((p.slicesEvaluated || 0) < PRECISION_MIN_SLICES) {
    return {
      label, value: '—', color: dim,
      sub: 'picks come from only ' + (p.slicesEvaluated || 0) + ' moment' +
        ((p.slicesEvaluated || 0) === 1 ? '' : 's') + ' · ' + cov,
    };
  }

  // Shown as a percentage, with what it is a percentage OF in the sub-line: a
  // bare 0.28 left "out of what?" unanswered. The calculation still returns a
  // 0-1 fraction; only the display changes.
  const value = p.precision == null ? '—' : Math.round(p.precision * 100) + '%';
  // Colour tracks the target, not the coverage; the caveat is the sub-line's
  // job so the colour never implies a verdict the sample cannot support.
  const good = p.precision != null && p.precision >= 0.55;
  const fellBack = p.horizonMs && p.horizonMs < PRECISION_HORIZONS[0];
  const hitPct = p.precision == null ? null : Math.round(p.precision * 100);
  // A plain-words verdict against the two reference points the bar marks:
  // 50% is a coin flip, 55% is the target the colour already used.
  const verdict = hitPct == null ? null
    : hitPct >= 55 ? 'beating target' : hitPct >= 50 ? 'above coin flip' : 'below coin flip';
  const median = p.medianReturnPct;
  return {
    label, value, mid: true,
    color: p.precision == null ? dim : (good ? '#4d8dff' : '#e35ff2'),
    verdict,
    // One line: the count behind the percentage, and how the picks did on
    // average. Coverage and the fallback note live behind the ? instead.
    subLine: [
      { text: p.wins + ' of ' + p.evaluated + ' rose' },
      median != null && { text: 'median ' + (median > 0 ? '+' : '') + median + '%', color: median >= 0 ? '#3ddc97' : '#ff4fae' },
    ].filter(Boolean),
  };
}

/**
 * What the hit-rate tile means, behind its ?. Carries the details the tile no
 * longer prints: how much of the day was recorded, and why the window may be
 * shorter than 24h.
 */
function precisionHelp(p) {
  const h = p && p.horizonMs ? hoursLabel(p.horizonMs).toLowerCase() : '24h';
  const recorded = p && p.coverage != null ? Math.round(p.coverage * 100) + '%' : 'an unknown share';
  const fellBack = p && p.horizonMs && p.horizonMs < PRECISION_HORIZONS[0];
  return {
    title: 'Top 20 hit rate',
    text: 'Of the 20 tokens we ranked highest at a past moment, the share whose price was higher ' + h +
      ' later. 50% is a coin flip; 55% is the target. The median is the typical return of those picks. ' +
      'This browser recorded ' + recorded + ' of the last 24 hours' +
      (fellBack ? ', which is not enough for a 24h reading yet, so the longest window that resolves is shown. ' +
        'It switches to 24h after a full day of uptime.' : '.'),
  };
}

class App extends React.Component {
  constructor(props) {
    super(props); this.state = { page: 'live', sortKey: 'signalRank', sortDir: -1, selectedId: null, popup: null, clock: '', tick: 0, tape: [], flashId: null, viewF: 'ALL', chainSel: allChains(), classF: 'ALL', searchQ: '', watch: {}, soundOn: false, toasts: [], alertPing: null, serverError: false, apiBase: null, apiIsLocal: false, intel: null, intelState: 'idle', bars: null, barsState: 'idle' };
    // User inputs come from the input store, which validates the shape and
    // falls back to a default rather than handing render code a bad value.
    this.state.watch = getInput('watchlist');
    this.state.chainSel = restoreChains(getInput('chainSelection'));
    this.state.signalSel = restoreSignals(getInput('signalSelection'));
    this.assets = []; this.tapeSeq = 0;
    this.state.walletInput = ''; this.state.walletLabel = '';
    this.state.walletFilter = 'ALL';
    this.state.registry = normalizeRegistry(getInput('walletRegistry') || defaultWalletRegistry);
    // WALLET TRACKER: the imported KOL / smart-money list, how alarms are
    // delivered, and this session's log of tracked-wallet trades.
    this.state.curated = getInput('curatedWallets');
    this.state.trackerPrefs = getInput('trackerPrefs');
    this.state.walletLog = [];
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
        // What the DATA FLOW delivers: a value cut off on the map is empty here.
        this.ungatedAssets = liveAssets;
        this.runBoard(liveAssets);
        this.assets = gateAssets(liveAssets);

        const picked = selectedChains(this.state.chainSel);
        const chain = picked.length === 1 ? (chainNameToKey[picked[0]] || 'solana') : 'solana';

        if (this.state.page === 'live') {
          // Wallets reads ONE pool's trades, so it follows the selection, not
          // the chain filter - and it follows the selected token's own chain,
          // which is not necessarily the one the filter is pointing at.
          const selected = this.selectedAsset();
          const walletChain = (selected && selected.rawServerRow && selected.rawServerRow.chain) ||
            chain;
          const walletData = selected
            ? await fetchLiveWalletData(walletChain, selected, this.trackedAddresses())
            : null;
          this.setState({ apiWallets: walletData }, () => this.rerunBoard());
        } else if (this.state.page === 'eval') {
          const evalData = await fetchLiveEvalData(chain);
          if (evalData) this.setState({ apiEval: evalData });
        } else if (this.state.page === 'health') {
          const systemData = await fetchLiveSystemData();
          if (systemData) this.setState({ apiSystem: systemData }, () => this.rerunBoard());
        }

        const fresh = storeFreshness();
        this.setState({
          serverError: false,
          storeAgeMs: fresh.newestWrittenAt ? Date.now() - fresh.newestWrittenAt : null,
        });
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
    // The engines' grades (by holding window too), for the TRADE PLAN panel.
    loadModelEval().then(() => this.setState({})).catch(() => {});
    this.onKey = (e) => this.onArrowKey(e);
    window.addEventListener('keydown', this.onKey);
    // A box deleted or a wire cut on the DATA FLOW (or undone) shows at once.
    this.flowScoreKey = (() => { try { const f = activeFlow(); return f.id + '|' + (f.engine || '') + '|' + JSON.stringify(f.settings || {}); } catch (e) { return null; } })();
    this.unsubFlows = subscribeFlows(() => {
      if (this.ungatedAssets) { this.runBoard(this.ungatedAssets); this.assets = gateAssets(this.ungatedAssets); }
      this.forceUpdate();
      // A setting or a profile changed (the TIME FRAME, a weight, the engine):
      // re-score now rather than on the next poll, so the plan follows at once.
      // Box positions and other map-only edits do not re-score.
      let key = null;
      try { const f = activeFlow(); key = f.id + '|' + (f.engine || '') + '|' + JSON.stringify(f.settings || {}); } catch (e) { key = null; }
      if (key && key !== this.flowScoreKey) {
        this.flowScoreKey = key;
        clearTimeout(this.rescoreTimer); this.rescoreTimer = setTimeout(() => this.syncLiveData(), 300);
      }
    });
    const clockFn = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); this.setState({ clock: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) }); };
    clockFn(); this.clockTimer = setInterval(clockFn, 1000);
    this.simTimer = setInterval(() => this.simTick(), 2400 / Math.max(1, this.props.simSpeed ?? 2));
    // Which server answers has to be settled BEFORE anything asks one, or the
    // first round of requests goes to the deployed server regardless and the
    // intel services below capture the wrong base for their whole lifetime.
    this.apiReady = initApiBase().then(async (base) => {
      this.setState({ apiBase: base, apiIsLocal: usingLocalApi() });

      // The app store is asynchronous, and everything that scores reads its
      // memory the moment it starts: the intel services and the journal. A
      // board read BEFORE this would save empty records over the real ones.
      // Hydrating is a few ms of IndexedDB; the board waits.
      const opened = await historyStore.hydrate();
      await migrateLegacyStorage();
      hydrateJournal();
      restoreDerived();
      console.log('storage: history in ' + historyStore.describe() +
        ', ' + opened.keys + ' key(s)');

      this.startIntelServices();

      // The board reads the raw store; nothing here asks the server to fetch.
      this.syncLiveData();
      this.apiTimer = setInterval(() => this.syncLiveData(), 5000);

      // Precision@20 joins ~24h of prices to ~24h of our own score marks. That
      // is megabytes and it changes on the scale of hours, so it runs on its
      // own slow timer rather than riding the 5s poll.
      this.refreshPrecision();
      this.precisionTimer = setInterval(() => this.refreshPrecision(), PRECISION_REFRESH_MS);

      // The storage strip in SYSTEM HEALTH. A bucket is half an hour wide at
      // 24h, so re-reading it faster than a minute cannot change a pixel.
      this.refreshStorageTimeline();
      this.storageTimer = setInterval(() => this.refreshStorageTimeline(), STORAGE_TIMELINE_MS);
    });

    // A closing tab should not take the pending app-store writes with it.
    this.onHide = () => {
      if (document.visibilityState === 'hidden') historyStore.flush();
    };
    document.addEventListener('visibilitychange', this.onHide);
  }

  /**
   * Measures Precision@20 over the last 24h from stored data.
   *
   * The two halves come from the two stores: the score marks are ours, out of
   * the app store (they never leave the browser), and the forward prices are
   * raw observations the collector wrote from its archive. Coverage comes with them, because a precision measured across a
   * window we only watched a fifth of is a different claim from one measured
   * across a full day - and the tile has to be able to say which it is.
   */
  async refreshPrecision() {
    const chain = chainKeys[0];
    try {
      const inputs = await fetchPrecisionInputs({ chain, windowMs: 86400000, horizonMs: 86400000, k: 20 });
      if (!inputs) {
        this.setState({ precisionRead: { error: 'raw store unreachable' } }, () => this.rerunBoard());
        return;
      }
      // The app store's journal is the only record of what we scored. It
      // holds ~50h, so a window this browser was closed for simply has no
      // marks - reported as unresolved/thin, never filled in. The DATA FLOW's
      // TOP 20 HIT RATE box measures it (flow/board-flow.js).
      this.setState({ precisionRead: { inputs, journal: journalFor(chain), at: Date.now() } }, () => this.rerunBoard());
    } catch (e) {
      this.setState({ precisionRead: { error: 'could not measure' } }, () => this.rerunBoard());
    }
  }

  /**
   * Two strips: the last day at half-hour resolution, and the last week at
   * three-hour resolution. The day answers "is it recording now", the week
   * answers "how much of my history is actually there" - and they are the
   * same read with a different window, so neither costs more than the other.
   */
  async refreshStorageTimeline() {
    const [day, week] = await Promise.all([
      fetchStorageTimeline({ windowMs: 86400000, buckets: 96 }),
      fetchStorageTimeline({ windowMs: 7 * 86400000, buckets: 56 }),
    ]);
    this.setState({ storageTimeline: { day, week, at: Date.now() } }, () => this.rerunBoard());
  }

  startIntelServices() {

    // Wallet intelligence runs whether or not the WALLETS tab is open, so
    // every module can ask about a wallet at any time and the memory keeps
    // building across tokens instead of restarting on each visit.
    startWalletIntel({
      chains: chainKeys,
      getTracked: () => this.trackedAddresses(),
    });
    // Re-render on new wallet findings; the tick is throttled, not per-trade.
    this.offWalletIntel = onWalletIntel(() => {
      // Alarms run on every page - they are the point of tracking a wallet.
      this.checkWalletAlarms();
      if (this.state.page === 'live' || this.state.page === 'tracker') this.setState({ walletIntelAt: Date.now() });
    });

    // Social intelligence runs on the same terms: every token on the board is
    // measured every tick whether or not the SOCIAL SCANNER is open, so the
    // mention history keeps building instead of restarting on each visit and
    // any module can ask about a ticker at any time.
    startSocialIntel({
      chains: chainKeys,
      getSymbols: () => this.assets.map((a) => ({
        symbol: (a.rawServerRow && a.rawServerRow.symbol) || a.sym,
      })),
    });
    this.offSocialIntel = onSocialIntel(() => {
      if (this.state.page === 'live') this.setState({ socialIntelAt: Date.now() });
    });

    // Rotation runs on the same terms, and costs nothing extra: it attaches
    // to the trade samples wallet intelligence is already reading, so the
    // graph for every chain is standing ready before the tab is opened and
    // any module can ask what a pool is rotating into.
    // Reputation of each token's X account. One small file, read on its own
    // slow clock - the collector refreshes it every 30 min because reputation
    // moves on the order of days.
    startEthosIntel();

    startRotationIntel();
    this.offRotationIntel = onRotationIntel(() => {
      if (this.state.page === 'live' || this.state.page === 'market') this.setState({ rotationIntelAt: Date.now() });
    });

    for (let i = 0; i < 7; i++) this.pushTape(false);
  }
  componentDidUpdate(prevProps, prevState) {
    // The board flow reads the selected token and the tracked wallets (THIS
    // TOKEN, TRACKED HERE): a new pick shows at once, not on the next poll.
    if (prevState && (prevState.selectedId !== this.state.selectedId || prevState.registry !== this.state.registry)) this.rerunBoard();
    if (this.state.page !== 'live') { this.detailKey = null; return; }
    // The dashboard always describes a token: with nothing picked yet, it
    // takes the top of the list rather than opening on empty windows.
    if (!this.state.selectedId && this.firstRowId) {
      this.setState({ selectedId: this.firstRowId });
      return;
    }
    this.loadDetailData(this.assets.find(a => a.id === this.state.selectedId));
  }

  /** ↑ / ↓ walk the token list - with a popup open too, so it follows. */
  onArrowKey(e) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (this.state.page !== 'live' || e.altKey || e.ctrlKey || e.metaKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const ids = this.rowIds || [];
    if (!ids.length) return;
    e.preventDefault();
    const at = ids.indexOf(this.state.selectedId);
    const next = at < 0 ? 0 : Math.min(Math.max(at + (e.key === 'ArrowDown' ? 1 : -1), 0), ids.length - 1);
    this.setState({ selectedId: ids[next] });
  }

  /**
   * Loads the per-token extras the feed does not carry: contract safety, holder
   * counts and routed price impact (<chain>/intel.json) plus real minute bars
   * (<chain>/ohlcv.json), both from the raw store. Read once per token and again when the selection
   * changes; a failure is recorded so the view can grey the fields out.
   */
  async loadDetailData(a) {
    const row = a && a.rawServerRow;
    if (!row || !row.tokenAddress) return;
    const key = row.chain + ':' + row.tokenAddress + ':' + row.poolAddress;
    if (this.detailKey === key) return;
    this.detailKey = key;
    this.setState({ intel: null, intelState: 'loading', bars: null, barsState: 'loading', tokenOutcomes: null });
    // What this token actually did after we scored it. Same source as the
    // Evaluation tab, filtered to one token.
    fetchTokenOutcomes(row.chain, row.tokenAddress).then((outcomes) => {
      if (this.detailKey === key) this.setState({ tokenOutcomes: outcomes });
    });

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
      intel, intelState: intel ? 'ready' : 'pending',
      bars: hasBars ? barList : null,
      barsState: hasBars
        ? (bars.reason === 'local_history' ? 'local_history' : 'ready')
        : ((bars && bars.reason) || 'error')
    });
    // Neither missing piece is permanent: the collector pre-fetches intel and
    // bars for every board token on a rotation, so look again shortly.
    if (!intel || (!hasBars && bars && bars.retryAfterMs)) {
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
      setInput('watchlist', watch);
      return { watch };
    });
  }

  componentWillUnmount() {
    clearTimeout(this.rescoreTimer);
    window.removeEventListener('keydown', this.onKey);
    if (this.unsubFlows) this.unsubFlows();
    clearInterval(this.clockTimer);
    clearInterval(this.simTimer);
    clearInterval(this.apiTimer);
    clearInterval(this.precisionTimer);
    clearInterval(this.storageTimer);
    clearTimeout(this.pingTimer);
    if (this.offWalletIntel) this.offWalletIntel();
    stopWalletIntel();
    if (this.offSocialIntel) this.offSocialIntel();
    stopSocialIntel();
    if (this.offRotationIntel) this.offRotationIntel();
    stopRotationIntel();
    stopEthosIntel();
    if (this.onHide) document.removeEventListener('visibilitychange', this.onHide);
    // Debounced writes may still be pending; drain them rather than dropping.
    historyStore.flush();
  }
  beep() { try { const ctx = this.audioCtx || (this.audioCtx = new (window.AudioContext || window.webkitAudioContext)()); const o = ctx.createOscillator(), g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.setValueAtTime(0.08, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35); o.start(); o.stop(ctx.currentTime + 0.36); } catch (e) { } }
  simTick() {
    if (this.props.liveFeed === false || this.state.serverError || !this.assets.length) return;
    const r = Math.random;
    // Asset values are NOT touched here. They come from the raw store every 5s and
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

  /**
   * WALLET TRACKER alarms. Every trade a tracked wallet made since the last
   * wallet-intel update goes into the log; the ones that pass that wallet's
   * own settings (buys / sells / minimum size) also ring: a toast, the beep if
   * sound is on, and a desktop notification if those are on and the tab is in
   * the background. See services/wallet-alerts.js.
   */
  checkWalletAlarms() {
    const registry = this.state.registry || [];
    const memory = this.walletMoveMemory || (this.walletMoveMemory = {});
    const events = detectWalletMoves(registry, walletProfile, memory);
    if (!events.length) return;

    const byAddress = new Map(registry.map((w) => [w.address, w]));
    const logged = events.map((e) => ({
      ...e, key: 'wm:' + e.address + ':' + e.pool + ':' + e.at,
      alarmed: shouldAlarm(byAddress.get(e.address), e),
    }));
    const rung = logged.filter((e) => e.alarmed);
    const sym = (e) => (e.symbol ? '$' + String(e.symbol).replace(/^\$/, '') : 'a token');
    const toasts = rung.reverse().map((e) => ({
      key: e.key,
      accent: e.side === 'buy' ? '#4fd6c1' : '#ff4fae',
      label: e.side === 'buy' ? 'WALLET BUY' : 'WALLET SELL',
      title: e.label + ' ' + (e.side === 'buy' ? 'bought ' : 'sold ') + sym(e),
      body: fmtUsd(e.usd) + (e.trades > 1 ? ' across ' + e.trades + ' trades' : '') + (e.chain ? ' on ' + String(e.chain).toUpperCase() : ''),
      meta: e.address.slice(0, 4) + '…' + e.address.slice(-4),
      openLabel: 'OPEN TRACKER →',
      go: () => this.setState({ page: 'tracker' }),
    }));

    this.setState((st) => ({
      walletLog: logged.slice().reverse().concat(st.walletLog || []).slice(0, 200),
      toasts: toasts.length ? toasts.concat(st.toasts).slice(0, TOAST_BACKLOG) : st.toasts,
    }));
    if (!toasts.length) return;
    if (this.state.soundOn) this.beep();
    const prefs = this.state.trackerPrefs || {};
    if (prefs.desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      toasts.slice(0, 3).forEach((t) => { try { new Notification(t.title, { body: t.body, tag: t.key }); } catch (err) { /* blocked */ } });
    }
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
    // Only the watchlist is left here, as an on/off toggle. Confirmed+ moved to
    // the STAGES bar (hide WATCH and EMERGING), which also covers every other
    // stage combination; All is simply the watchlist switched off.
    const views = [chip('★ Watchlist', st.viewF === 'WATCHLIST',
      () => this.setState((prev) => ({ viewF: prev.viewF === 'WATCHLIST' ? 'ALL' : 'WATCHLIST' })))];
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
    // They live in the TOKENS TRACKED tile, each with the number of tokens the
    // board is tracking on that chain - the tile's total is their sum.
    const allOn = isAllChains(st.chainSel);
    const signalsAll = isAllSignals(st.signalSel);
    // The DATA FLOW's BOARD COUNTS box counts the board; a chip shows its count
    // over the chains switched on.
    const counts = boardValue('BOARD COUNTS') || { chain: {}, type: {}, signal: {}, engineBuys: {} };
    const perChain = counts.chain || {};
    const overChains = (byChain) => Object.keys(byChain || {})
      .filter((c) => allOn || st.chainSel[c]).reduce((t, c) => t + byChain[c], 0);
    const chainFilters = [
      Object.assign(chainChip('ALL', allOn, () => this.setState({ chainSel: saveChains(allChains()) })),
        // The total now lives on ALL itself, so ALL carries the tile's weight.
        { count: boardValue('TOKENS TRACKED') || 0, big: true, fg: '#ffffff' }),
    ].concat(chainList.map((c) => Object.assign(
      chainChip(c.name, Boolean(st.chainSel[c.name]),
        () => this.setState((prev) => ({ chainSel: saveChains(toggleChain(prev.chainSel, c.name)) }))),
      { count: perChain[c.name] || 0 },
    )));
    // Typed once here rather than per row - $ is stripped from both sides so
    // "cate" matches $CATE and "$cate" matches it too.
    const q = st.searchQ.trim().toLowerCase().replace(/\$/g, '');
    const filtered = this.assets.filter(a => {
      if (!allOn && !st.chainSel[a.chain]) return false;
      if (!signalsAll && !(a.signal && st.signalSel[a.signal])) return false;
      if (st.classF !== 'ALL' && a.cls !== st.classF) return false;
      if (q && (a.sym + ' ' + a.name).toLowerCase().replace(/\$/g, '').indexOf(q) === -1) return false;
      if (st.viewF === 'WATCHLIST' && !st.watch[a.id]) return false;
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
    // The token list is one line per token: everything else the old table
    // carried is in the dashboard windows for whichever token is selected.
    const rows = sorted.map(a => {
      return {
        id: a.id,
        pick: () => this.setState({ selectedId: a.id }),
        star: (e) => { if (e && e.stopPropagation) e.stopPropagation(); this.toggleWatch(a.id); },
        selected: st.selectedId === a.id,
        starGlyph: st.watch[a.id] ? '★' : '☆', starColor: st.watch[a.id] ? '#f06ee2' : '#3a4568',
        anim: st.flashId === a.id ? 'vsFlash 1.2s ease-out' : 'none',
        score: a.score == null ? '—' : Math.round(a.score), scoreColor: a.score == null ? '#3a4568' : scoreColor(a.score),
        partialScore: a.score != null && a.scoreBasis !== 'intel',
        // The board shows the call, not the score (calculations/phase.js).
        signal: a.signal || '—', signalFg: signalInfo(a.signal).fg, signalBg: signalInfo(a.signal).bg,
        signalTitle: (a.signal ? a.signal + ' - ' + (a.signalWhy || '') : signalInfo(null).text) +
          (a.phase ? '\nphase ' + a.phase + ' - ' + (a.phaseWhy || '') : '') + (Number.isFinite(a.early) ? '\nEARLY ' + a.early : ''),
        phase: a.phase || null, phaseFg: phaseColor(a.phase),
        sym: a.sym, chain: a.chain, chainColor: chainColor(a.chain),
        chg: a.chg == null ? '—' : (a.chg >= 0 ? '+' : '') + (a.chg * 100).toFixed(1) + '%',
        chgColor: a.chg == null ? '#3a4568' : a.chg >= 0 ? '#4d8dff' : '#ff4fae'
      };
    });
    // Read by componentDidUpdate (auto-select) and the arrow keys.
    // Unique, or ↓ would stall on a token the feed lists twice.
    this.rowIds = [...new Set(rows.map((r) => r.id))];
    this.firstRowId = rows.length ? rows[0].id : null;
    // The feed reorders every 5s and a token can drop out of it. Keep showing
    // the token the user opened (with a staleness note) instead of silently
    // swapping the detail view to a different asset.
    let sel = this.assets.find(a => a.id === st.selectedId);
    if (sel) { this.lastSelected = sel; this.lastSelectedAt = Date.now(); }
    else if (st.selectedId && this.lastSelected && this.lastSelected.id === st.selectedId) sel = this.lastSelected;
    else sel = null;
    const staleMs = sel && this.lastSelected === sel && !this.assets.includes(sel) ? Date.now() - this.lastSelectedAt : 0;

    // The top navbar. The token tabs are gone from it - they are the
    // dashboard's windows now, each opening its full view as a popup.
    const navItem = (k, label) => ({ label, active: st.page === k, go: nav(k) });
    const navItems = [
      navItem('live', 'LIVE OPPORTUNITIES'),
      navItem('tracker', 'WALLET TRACKER'),
      navItem('market', 'MARKET ROTATION'),
      navItem('alerts', 'ALERTS'),
      navItem('eval', 'EVALUATION'),
      navItem('health', 'HEALTH'),
      { label: 'ADMIN ↗', href: '/admin' }
    ];
    const d = detailVals(this, sel, showAdj, {
      intel: st.intel, bars: st.bars, intelState: st.intelState, barsState: st.barsState, staleMs,
      tokenOutcomes: st.tokenOutcomes
    });
    // AVG ORGANIC SCORE averages OUR score and only our score.
    //
    // It used to take Jupiter's number where it existed and a locally computed
    // one otherwise, then average the two together. Those are different
    // quantities over different windows, and Jupiter only covers Solana, so the
    // "board average" was really a Solana average with a few of our own numbers
    // mixed in. Filtering on basis === 'sample' is what keeps the tile honest;
    // tokens Jupiter alone answered for are counted as unscored here and
    // reported separately in the subline.
    //
    // Each token is weighted by how much of the model resolved for it, so a
    // token read on one of four parts does not count as much as a complete one.
    // The DATA FLOW's AVG ORGANIC SCORE and ORGANIC GRADES boxes (flow/board-flow.js).
    const avgOrganicBox = boardValue('AVG ORGANIC SCORE');
    const gradeCounts = boardValue('ORGANIC GRADES') || { STRONG: 0, FAIR: 0, WEAK: 0 };
    const gradeNote = boardNote('ORGANIC GRADES') || { sampled: 0, jupiterOnly: 0 };
    const sampled = gradeNote.sampled;
    const borrowed = gradeNote.jupiterOnly;
    // The grades' colours; the zones themselves are the flow's (ORGANIC_ZONES).
    const GRADE_COLOR = { WEAK: '#ff4fae', FAIR: '#ffb454', STRONG: '#3ddc97' };
    const organicAvg = Number.isFinite(avgOrganicBox) ? avgOrganicBox : null;
    const organicTile = {
      // The DATA FLOW's AVG ORGANIC SCORE box.
      label: 'AVG ORGANIC SCORE', value: organicAvg == null ? '—' : organicAvg + '%', mid: true,
      color: organicAvg == null ? '#3a4568' : GRADE_COLOR[organicGradeOf(organicAvg).name],
      verdict: organicAvg == null ? null : organicGradeOf(organicAvg).name.toLowerCase(),
      subLine: sampled ? [{ text: sampled + ' of ' + (boardValue('TOKENS TRACKED') || 0) + ' sampled' }] : null,
      sub: sampled ? null : (borrowed ? borrowed + ' Jupiter-only, excluded' : 'awaiting trade samples'),
      help: {
        title: 'Organic score',
        text: 'How much of the trading looks like a real crowd - many independent wallets, none dominating - ' +
          'rather than volume manufactured by a few. Averaged over the tokens we have sampled trades for. ' +
          'Grades: weak below 45%, fair 45-69%, strong 70% and up. ' +
          'Right now: ' + gradeCounts.STRONG + ' strong, ' + gradeCounts.FAIR + ' fair, ' + gradeCounts.WEAK + ' weak' +
          (borrowed ? '; ' + borrowed + ' Solana tokens with only a Jupiter reading are left out.' : '.'),
      },
    };

    // One tile for "what is on the board": the total as plain text, then a
    // toggle row per filter. The chain and stage rows each get a reset link
    // while anything in them is off, since ALL is no longer a button.
    const perClass = counts.type || {};
    const boardTile = {
      // The DATA FLOW's TOKENS TRACKED box.
      label: 'TOKENS TRACKED', value: boardValue('TOKENS TRACKED') == null ? '—' : 'ALL ' + boardValue('TOKENS TRACKED'), color: '#ffffff', wide: true, inlineValue: true,
      rows: [
        {
          name: 'CHAIN',
          chips: chainFilters.slice(1).map((c) => ({ label: c.label, count: c.count, go: c.go, fg: c.fg, bg: c.bg, bd: c.bd })),
          reset: allOn ? null : () => this.setState({ chainSel: saveChains(allChains()) }),
        },
        {
          name: 'SIGNALS',
          help: { title: 'Signals', text: 'Where each token is in its attention cycle, as a call. BUY: it has started to move and has not run yet. SELL: it has run hard and is still near its high - take profit. SHORT: the same, and a perp venue lists it. AVOID: the burst is over. WATCH: no call. Each is graded against what prices did next on the Evaluation tab. Click a signal to show or hide it.' },
          chips: SIGNAL_KEYS.map((k) => {
            const on = Boolean(st.signalSel[k]);
            const info = signalInfo(k);
            return {
              label: k, count: overChains((counts.signal || {})[k]), fg: info.fg,
              bg: on ? info.bg : '#0a1226', bd: on ? info.fg : '#1c2a4d', dim: !on,
              go: () => this.setState((prev) => ({ signalSel: saveSignals(toggleSignal(prev.signalSel, k)) })),
            };
          }),
          reset: signalsAll ? null : () => this.setState({ signalSel: saveSignals(allSignals()) }),
        },
        {
          // MEME / TOKEN, with the same toggle rules as the rows above. Two
          // types, so classF's ALL | MEME | TOKEN already says everything:
          // both on is ALL; clicking one turns it off (the other stays);
          // clicking the only one left brings both back.
          name: 'TYPE',
          chips: ['MEME', 'TOKEN'].map((k) => {
            const on = st.classF === 'ALL' || st.classF === k;
            const fg = clsColor(k);
            return {
              label: k, count: perClass[k] || 0, fg,
              bg: on ? CHIP_ACTIVE_BG : '#0a1226', bd: on ? CHIP_ACTIVE_BD : '#1c2a4d', dim: !on,
              go: () => this.setState((prev) => ({
                classF: prev.classF === 'ALL' ? (k === 'MEME' ? 'TOKEN' : 'MEME') : 'ALL',
              })),
            };
          }),
          reset: st.classF === 'ALL' ? null : () => this.setState({ classF: 'ALL' }),
        },
      ],
    };

    const stats = [
      boardTile,
      organicTile,
      Object.assign(precisionTile(boardNote('TOP 20 HIT RATE')), { help: precisionHelp(boardNote('TOP 20 HIT RATE')) })
    ];
    const storeStale = Number.isFinite(st.storeAgeMs) && st.storeAgeMs > STORE_STALE_MS;
    const tape = st.tape.map((e, i) => ({ ...e, kindColor: e.kc, chainColor: chainColor(e.chain), anim: i === 0 ? 'vsFlash 1s ease-out' : 'none' }));
    return {
      clock: st.clock, navItems,
      // The collector rewrites market files every few seconds, so old files
      // mean it has stopped. The board keeps showing the last write, but must
      // not call it live.
      liveDotColor: st.serverError ? '#ff4fae' : storeStale ? '#ffb020' : (live ? '#4d8dff' : '#e35ff2'),
      liveDotAnim: st.serverError || storeStale ? 'none' : (live ? 'vsBlink 1.4s infinite' : 'none'),
      liveLabel: st.serverError ? 'STORE OFFLINE'
        : storeStale ? 'STORE STALE · ' + Math.round(st.storeAgeMs / 1000) + 's'
          : (live ? 'LIVE' : 'PAUSED'),
      serverError: st.serverError, apiIsLocal: st.apiIsLocal,
      hasSelection: Boolean(sel),
      // The identity bar belongs to the asset-scoped tabs only - the same set
      // the sidebar nests under ASSET DETAIL. ALERT CARDS, EVALUATION and
      // SYSTEM HEALTH describe the screener, not a token, so a symbol and a
      // score pinned above them would be captioning the wrong thing.
      // Which window's full view is open. The tab components still gate on
      // their is* flags, so these stay false here and the popup turns one on.
      popup: sel && st.popup ? st.popup : null,
      popupTitle: POPUPS[st.popup] || '',
      openPopup: Object.keys(POPUPS).reduce((o, k) => { o[k] = () => this.setState({ popup: k }); return o; }, {}),
      closePopup: () => this.setState({ popup: null }),
      sortKey: st.sortKey, sortOptions: SORT_OPTIONS,
      setSort: (k) => this.setState({ sortKey: k, sortDir: -1 }),
      isLive: st.page === 'live', isDetail: false, isRotation: false, isEval: st.page === 'eval', isHealth: st.page === 'health',
      goLive: nav('live'), stats: gateStats(stats), rows, tape, d: gateDetail(d), rowCount: rows.length,
      views, chainFilters,
      searchQ: st.searchQ,
      onSearch: (e) => this.setState({ searchQ: e.target.value }),
      clearSearch: () => this.setState({ searchQ: '' }),
      hasSearch: st.searchQ.trim().length > 0,
      isAlerts: st.page === 'alerts', isSocial: false, isWallets: false,
      toggleSound: () => this.setState(s => ({ soundOn: !s.soundOn })),
      soundLabel: st.soundOn ? 'SOUND ON' : 'SOUND OFF', soundFg: st.soundOn ? '#f06ee2' : '#6b7699',
      // Only the newest three reach the screen; the rest wait in the backlog.
      toasts: st.toasts.slice(0, TOAST_VISIBLE).map((t, i) => ({
        ...t, fresh: i === 0,
        dismiss: () => this.dismissToast(t.key),
        open: t.go ? () => { this.dismissToast(t.key); t.go(); } : () => this.openAlertCard(t.key)
      })),
      toastBacklog: Math.max(0, st.toasts.length - TOAST_VISIBLE),
      closeAllToasts: () => this.dismissAllToasts(),
      alertPing: st.alertPing,
      chepeStats: [{ k: 'Hard vetoes today', v: '14' }, { k: 'Honeypots blocked', v: '6' }, { k: 'Fake stock tokens', v: '2' }, { k: 'Wash clusters flagged', v: '5' }],
      chepeLast: 'Last veto — $SAFEGEM2 (BNB): honeypot, sell path reverts. Chepe says no.',
      ...this.chepePickVals(),
      // The header's ALERTS: the alert cards on the board now (the DATA FLOW's
      // ALERTS NOW box) - it used to be a fixed 47.
      alertsNow: boardValue('ALERTS NOW'),
      ...walletsVals(this, sel), ...socialVals(this, sel), ...alertsVals(this), ...rotationVals(this, sel), ...marketRotationVals(this), ...evalVals(this), ...healthVals(this), ...trackerVals(this)
    };
  }



  /**
   * The DATA FLOW's board boxes, over every token (flow/board-flow.js). It
   * gets the raw reads only - every number the tabs show is computed there.
   */
  runBoard(assets) {
    const st = this.state || {};
    const sel = this.selectedAsset && this.selectedAsset();
    let evalOutcome = null;
    try { evalOutcome = evalVals(this).outcome; } catch (e) { evalOutcome = null; }
    runBoardFlow(assets, {
      selected: sel || null,
      walletRead: st.apiWallets || null,
      registry: st.registry || [],
      system: st.apiSystem || null,
      storageTimeline: st.storageTimeline || null,
      serverError: st.serverError,
      precisionRead: st.precisionRead || null,
      outcomes: st.tokenOutcomes || null,
      evalOutcome,
    });
  }

  /** Re-runs the board once a slow read lands, instead of waiting for the next poll. */
  rerunBoard() {
    if (!this.ungatedAssets) return;
    this.runBoard(this.ungatedAssets);
    this.assets = gateAssets(this.ungatedAssets);
    this.forceUpdate();
  }

  chepePickVals() {
    const day = new Date().toISOString().slice(0, 10);
    // The DATA FLOW's DAILY PICK box (flow/board-flow.js) picks it.
    const picked = dailyPickAsset();
    const a = picked && this.assets.find((x) => x.id === picked.id);
    if (!a) {
      return {
        chepePickSym: '—', chepePickChain: '—', chepePickChainColor: '#a3aed0',
        chepePickScore: '—', chepePickQuip: 'No BUY on the board right now', openChepePick: () => {}
      };
    }
    const quips = ['Waking up, not run yet. Chepe approves.', 'Room to run and real buyers. Good dog energy.', 'Off its low, under its high. Chepe sniffed it thoroughly.', 'Moving, safe, and nobody is rugging. Rare.'];
    return {
      chepePickSym: a.sym, chepePickChain: a.chain, chepePickChainColor: chainColor(a.chain),
      chepePickScore: 'BUY · EARLY ' + Math.round(a.score),
      chepePickQuip: quips[this.h(a.id + day) % quips.length],
      openChepePick: () => this.setState({ page: 'live', selectedId: a.id })
    };
  }


  render() {
    const v = this.renderVals(); return (
      <>
        <div style={css("font-family:'Poppins',sans-serif;font-size:12px;background:#081736;height:100dvh;display:flex;flex-direction:column", { v })}>
          <AppHeader v={v} css={css} />
          {v.serverError ? (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 20px', textAlign: 'center' }}>
              <div style={{ background: '#0a1226', border: '1px solid #ff4fae', borderRadius: '16px', padding: '36px 48px', maxWidth: '520px', boxShadow: '0 10px 30px rgba(255, 79, 174, 0.15)' }}>
                <div style={{ fontSize: '10px', fontWeight: '800', letterSpacing: '1.5px', color: '#ff4fae', textTransform: 'uppercase', marginBottom: '8px' }}>
                  CONNECTION ERROR
                </div>
                <div style={{ fontSize: '20px', fontWeight: '800', color: '#ffffff', marginBottom: '12px' }}>
                  ( raw store not reachable )
                </div>
                <div style={{ fontSize: '11px', color: '#8b96b8', lineHeight: '1.6', marginBottom: '20px' }}>
                  Nothing could be read from the raw store the collector writes. All live assets, feeds, and analytics across all tabs have been hidden.
                </div>
                {/* The real command, and where to run it.
                    This said `npm run server`, which cannot work: there is no
                    package.json at the repo root. Worse, getting a prompt to
                    type it means Ctrl+C in the supervisor window - so following
                    this hint killed the collector and produced the very error
                    that was showing it. */}
                <div style={{ background: '#0d1730', border: '1px solid #1c2a4d', borderRadius: '8px', padding: '10px 14px', fontSize: '10px', color: '#c6d1ea', fontFamily: 'monospace', textAlign: 'left', marginBottom: '8px' }}>
                  .\start-server.cmd
                </div>
                <div style={{ fontSize: '9.5px', color: '#6b7699', marginBottom: '16px' }}>
                  from the repo root, in its own window — Ctrl+C there stops the collector.
                </div>
                <div style={{ fontSize: '9.5px', color: '#6b7699' }}>
                  {/* Name the server that actually failed - with a local one in
                      play, "the server" is ambiguous. */}
                  No raw store at <span style={{ color: '#4fc3f7' }}>{API_ORIGIN}/raw</span>
                  {v.apiIsLocal ? ' (local)' : ' (deployed)'}. Retrying automatically every 5s...
                  {!v.apiIsLocal && (
                    <> Start the local collector and reload to use it instead.</>
                  )}
                </div>
              </div>
            </div>
          ) : (
            // Whatever the navbar leaves of the viewport: the dashboard is sized
            // to fit, and the other pages scroll inside their own panes.
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <LiveOpportunities v={v} css={css} />
              <WalletTracker v={v} />
              <AlertCards v={v} css={css} />
              <MarketRotation v={v} css={css} />
              <Evaluation v={v} css={css} />
              <SystemHealth v={v} css={css} />
              {v.isHealth && <EventTape v={v} />}
            </div>
          )}
          {v.popup && (
            <TabPopup v={v} title={v.popupTitle} onClose={v.closePopup}>
              {v.popup === 'detail' && <AssetDetail v={{ ...v, isDetail: true }} css={css} />}
              {v.popup === 'social' && <SocialScanner v={{ ...v, isSocial: true }} css={css} />}
              {v.popup === 'wallets' && <Wallets v={{ ...v, isWallets: true }} css={css} />}
              {v.popup === 'rotation' && <Rotation v={{ ...v, isRotation: true }} css={css} />}
            </TabPopup>
          )}
          {!v.serverError && <AlertToasts v={v} css={css} />}
        </div>
      </>
    );
  }

}

App.defaultProps = { liveFeed: true, simSpeed: 2, showAdjusted: true };
export default App;
