import React from 'react';
import App from '../App.jsx';
import SideNav from '../components/SideNav';
import AdminOps from './AdminOps';
import { PAGES, MIRROR_PAGES, MAP_ONLY_PAGES } from './provenance';
import { C, FieldCard, Group, Empty, ExplainStyles } from './Explain';
import { showsForPanel, showsForField } from './shows';
// DATA FLOW is a standalone engine now: it computes the score itself from the
// raw files rather than mirroring numbers the dashboard produced elsewhere.
import FlowChart from './FlowChart';
// Registers PAGES.pipe and step 6, so the SCORE PIPELINE tab and its refs resolve.
import { SHOWN_ORDER } from './pipeline';
import {
  API_ORIGIN, API_BASES, apiTarget, setApiTarget, probeLocalApi, usingLocalApi,
} from '../services/api';
import { readRawQuiet } from '../services/storage/raw-store';

/**
 * Keeps a render error in the map from taking the whole page with it.
 *
 * With no boundary React unmounts the entire tree on any throw, and what is
 * left is the body's blue background until a refresh. Here the error is
 * printed and RETRY remounts the map; the rest of the admin page stays up.
 */
class MapBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('DATA FLOW crashed', error, info && info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 20, fontSize: 11, color: C.dim }}>
        <div style={{ color: C.pink, fontWeight: 700, marginBottom: 6 }}>DATA FLOW crashed</div>
        <div style={{ fontFamily: 'monospace', marginBottom: 10 }}>{String(this.state.error)}</div>
        <button type="button" onClick={() => this.setState({ error: null })}>RETRY</button>
      </div>
    );
  }
}

/**
 * The admin panel: the dashboard, with its working shown.
 *
 * It EXTENDS App rather than reimplementing it. That is the whole design. The
 * polling loop, the intel services, the selection, the filters and - above all
 * - renderVals() are inherited, so every figure on this page is read out of the
 * same viewmodel object the dashboard renders. There is no second derivation
 * that could agree today and disagree tomorrow; if a number here is wrong, the
 * number on the dashboard is wrong in exactly the same way.
 *
 * What the page adds is the part the dashboard cannot show: under each value,
 * the formula, the provider it came from, the fields upstream of it, the fields
 * that read it next, and whether it is measured at all. That catalogue lives in
 * provenance.js.
 *
 * The SERVER / STORAGE / SOURCES pages are a separate component: they describe
 * the server, not the dashboard, so they share nothing with this one.
 */

const OPS_PAGES = { ops: 'SERVER', opsStore: 'STORAGE', opsSources: 'SOURCES' };

/**
 * The map sits ABOVE the tabs it describes, because it is the thing you open
 * first and the tabs are where you land afterwards. It is not a mirror of a
 * dashboard tab - there is no DATA FLOW on the dashboard - so it gets its own
 * rail entry rather than a place in the mirrored list.
 */
const FLOW_PAGE = 'flow';

/**
 * The dashboard's rail labels, back to the page keys behind them.
 *
 * The dashboard disables the four token-scoped tabs until a token is picked,
 * and sends a click to the board instead. On the admin page that is the wrong
 * behaviour: there is no board to send anyone to, and an operator opening
 * WALLETS wants to see a worked example, not a prompt. So the rail is rebuilt
 * here from the same labels, with nothing disabled, and a token is picked by
 * default - see defaultToken().
 */
const PAGE_FOR_LABEL = {
  'LIVE OPPORTUNITIES': 'live', DETAIL: 'detail', SOCIAL: 'social',
  WALLETS: 'wallets', ROTATION: 'rotation', 'MARKET ROTATION': 'market', ALERTS: 'alerts',
  EVALUATION: 'eval', HEALTH: 'health',
};

/** The page to actually show: a map-only tab (set by inherited App code) means the map. */
const shownPage = (page) => (MAP_ONLY_PAGES.has(page) ? FLOW_PAGE : page);

/** Which data server this page - and the dashboard - reads. */
function ServerSwitch({ target, localUp, onPick }) {
  const options = [
    ['auto', 'AUTO', 'probe in dev, deployed otherwise'],
    ['local', 'LOCAL', API_BASES.local],
    ['remote', 'DEPLOYED', API_BASES.remote],
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {options.map(([k, label, hint]) => (
        <div key={k} onClick={() => onPick(k)} title={hint}
          style={{
            cursor: 'pointer', fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
            padding: '4px 10px', borderRadius: 999,
            border: `1px solid ${target === k ? C.blue : C.border}`,
            background: target === k ? '#0e2a5c' : C.panel,
            color: target === k ? '#6ea0ff' : C.faint,
          }}>{label}</div>
      ))}
      <span style={{ fontSize: 9.5, color: C.dim, marginLeft: 2 }}>{API_ORIGIN}</span>
      {localUp !== null && (
        <span title={localUp ? 'our server is answering on ' + API_BASES.local
          : 'nothing on ' + API_BASES.local}
          style={{ fontSize: 8.5, color: localUp ? C.blue : C.grey }}>
          {localUp ? 'local up' : 'local down'}
        </span>
      )}
    </div>
  );
}

/**
 * A stable DOM id per field, so a jump can find its card.
 *
 * Labels are what the operands point at - a ref names the field by the same
 * caption the dashboard shows - so the id is built from the label rather than
 * from an index that would move as the model grows.
 */
const cardId = (page, label) =>
  'vs-' + page + '-' + String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** One mirrored tab: the dashboard's numbers, each with its lineage under it. */
function MirrorPage({ page, v, needsSelection, onJump, ping }) {
  const spec = PAGES[page];
  if (!spec) {
    return <Empty>No provenance catalogue for this tab yet.</Empty>;
  }
  if (needsSelection) {
    return (
      <Empty>
        <strong style={{ color: C.text }}>{spec.title}</strong> describes one token, and
        no rows have arrived yet to pick one from. The highest-scoring token is selected
        automatically as soon as the first poll lands; the selector in the header changes it.
      </Empty>
    );
  }

  /**
   * One page's groups as card bands. `key` is the catalogue page the cards
   * belong to - not necessarily the tab on screen: the SCORE PIPELINE tab
   * renders step 6 from the token tabs' own catalogues - so card ids and the
   * jump ring stay keyed by where the field is defined.
   */
  const renderGroups = (key, groups, titleOf) => groups.map((group, i) => {
    // A group either lists its fields up front, or generates them from the
    // live viewmodel - the score decomposition and the provider rows are as
    // long as the model is, and hard-coding their length here would be one
    // more thing to keep in step with the code.
    let fields;
    try { fields = group.from ? group.from(v) : group.fields; } catch (e) { fields = []; }
    // The plain-words block is keyed by label in shows.js rather than written
    // into provenance.js, so a GENERATED group - the score components, the
    // provider rows, the rank bands - gets described without provenance.js
    // having to produce prose alongside its expressions.
    const described = {
      ...group,
      group: titleOf ? titleOf(group) : group.group,
      shows: group.shows || showsForPanel(key, group.group),
    };
    if (!fields || !fields.length) {
      return (
        <Group key={key + i} group={described}>
          <Empty>Nothing to describe here yet - this group is generated from live data.</Empty>
        </Group>
      );
    }
    return (
      <Group key={key + i} group={described} right={
        <span style={{ fontSize: 9, color: C.grey }}>{fields.length} fields</span>
      }>
        {fields.map((field, j) => {
          const pinged = Boolean(ping && ping.page === key && ping.field === field.label);
          const card = field.shows
            ? field
            : { ...field, shows: showsForField(key, field.label) };
          return (
            <FieldCard
              // Remounting on each ping is what makes a SECOND jump to the
              // same field blink again - a CSS animation does not restart
              // while the element and its animation name stay put.
              key={j + (pinged ? ':' + ping.at : '')}
              id={cardId(key, field.label)}
              field={card}
              v={v}
              value={field.value ? field.value(v) : undefined}
              onJump={onJump}
              pinged={pinged}
            />
          );
        })}
      </Group>
    );
  });

  const isPipe = page === 'pipe';
  return (
    <>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.white }}>{spec.title}</div>
        <div style={{ fontSize: 10.5, color: C.dim, marginTop: 3, maxWidth: 820, lineHeight: 1.6 }}>
          {spec.blurb}
        </div>
      </div>
      {renderGroups(page, spec.groups, isPipe ? (g) => g.stage + ' · ' + g.group : null)}

      {/* Step 6: the token tabs' panels, each number with what it is read from. */}
      {isPipe && (
        <>
          <div style={{ margin: '26px 0 12px', borderTop: `2px solid ${C.border}`, paddingTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.white }}>6 &middot; SHOWN ON THE DASHBOARD</div>
            <div style={{ fontSize: 10.5, color: C.dim, marginTop: 3, maxWidth: 820, lineHeight: 1.6 }}>
              Every panel of the token tabs and the step above it reads from. Nothing here is
              computed a second time: each card names the pipeline box it displays.
            </div>
          </div>
          {SHOWN_ORDER.map((key) => renderGroups(key, PAGES[key].groups,
            (g) => PAGES[key].title + ' · ' + g.group))}
        </>
      )}
    </>
  );
}

export default class AdminPanel extends App {
  constructor(props) {
    super(props);
    this.state = {
      ...this.state,
      // Which server this page reads, and whether the local one is even up.
      target: apiTarget(), localUp: null,
      // The field a jumped-from operand is pointing at, while it blinks.
      ping: null,
      // The map is home: the token-by-token tabs it replaced are gone.
      page: FLOW_PAGE,
    };
  }

  componentDidMount() {
    // Everything the dashboard does: settle on a server, poll, start the
    // background intel services. The mirror is worthless without them - the
    // wallet, social and rotation numbers only exist because they run.
    super.componentDidMount();
    probeLocalApi().then((localUp) => this.setState({ localUp }));
  }

  componentWillUnmount() {
    if (super.componentWillUnmount) super.componentWillUnmount();
    clearTimeout(this.pingTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.rawTimer);
  }

  /**
   * The selected token's RAW records, exactly as the files hold them: its
   * market.json row, its pool's trades.json entry and history.json samples,
   * its intel.json record, its quote token's reference.json quotes and its
   * ethos.json entry - the same files the board's poll just read, through the
   * same cached reader, so this costs one revalidation per file, not a parse.
   *
   * The pipeline shows these so an input step is the data itself with the
   * keys the app extracts highlighted - not a sentence about the data.
   */
  async loadRawBundle(a) {
    const s = a && a.rawServerRow;
    if (!s || !s.chain) return;
    const key = s.chain + ':' + s.tokenAddress + ':' + s.poolAddress;
    const fresh = this.rawBundle && this.rawBundle.key === key && Date.now() - this.rawBundle.at < 10000;
    if (fresh || this.rawLoading === key) return;
    this.rawLoading = key;
    try {
      const [market, trades, history, intel, reference, ethos, perps, promotion] = await Promise.all([
        readRawQuiet(s.chain + '/market.json', null),
        readRawQuiet(s.chain + '/trades.json', null),
        readRawQuiet(s.chain + '/history.json', null),
        readRawQuiet(s.chain + '/intel.json', null),
        readRawQuiet('reference.json', null),
        readRawQuiet('ethos.json', null),
        readRawQuiet('perps.json', null),
        readRawQuiet(s.chain + '/promotion.json', null),
      ]);
      const ethosToken = ethos && ethos.tokens && ethos.tokens[s.chain]
        ? ethos.tokens[s.chain][s.tokenAddress] || null : null;
      const quote = String(s.quoteSymbol || '').toUpperCase();
      this.rawBundle = {
        key, at: Date.now(),
        marketFile: market ? { feed: market.feed, chain: market.chain, rowCount: market.rowCount,
          fetchedAtIso: market.fetchedAtIso, rows: market.rows || [] } : null,
        market: market && market.rows ? market.rows.find((r) => r.tokenAddress === s.tokenAddress) || null : null,
        trades: trades && trades.pools ? trades.pools.find((p) => p.poolAddress === s.poolAddress) || null : null,
        history: history && history.samples ? history.samples[s.poolAddress] || null : null,
        intel: intel && intel.tokens ? intel.tokens[s.tokenAddress] || null : null,
        reference: reference && reference.symbols ? reference.symbols[quote] || null : null,
        ethos: ethosToken ? {
          token: ethosToken,
          profile: (ethos.handles || {})[ethosToken.handle] || null,
        } : null,
        // Perp venues match by TICKER (venues list symbols, not contracts), so
        // this token's record is its symbol's entry plus every venue's status -
        // "no perp" only means something next to how many venues answered.
        perps: perps ? {
          symbol: String(s.symbol || '').toUpperCase(),
          listedOn: (perps.symbols || {})[String(s.symbol || '').toUpperCase()] || [],
          venues: perps.venues || {},
          checked: perps.venuesReachable, total: perps.venuesTotal,
        } : null,
        // DexScreener's paid boosts and profiles on this chain, this token's rows.
        promotion: promotion ? {
          rows: (promotion.rows || []).filter((r) =>
            String(r.tokenAddress || '').toLowerCase() === String(s.tokenAddress || '').toLowerCase()),
          feedRows: (promotion.rows || []).length,
        } : null,
        // What the file says its per-token record looks like, so a card with
        // no record for this token can still draw the format it expects.
        shapes: { ethos: (ethos && ethos.shape) || null },
      };
      this.forceUpdate();
    } finally {
      this.rawLoading = null;
      // Keep it current while a page that shows it is open.
      clearTimeout(this.rawTimer);
      this.rawTimer = setTimeout(() => this.loadRawBundle(this.selectedAsset()), 10000);
    }
  }

  componentDidUpdate(prevProps, prevState) {
    // The dashboard loads a token's intel (holders, routed quote, contract
    // checks) only while DETAIL is open. The map and the SCORE PIPELINE show
    // those same inputs, so they load it too - through the same loader, which
    // fetches once per token. The parent is skipped on these pages because it
    // forgets the loaded token whenever DETAIL is not open, which would refetch
    // on every render.
    // Now that the map is the admin's home, it is loaded on every page; the
    // parent's version is not called at all, because it is that one-line
    // DETAIL-only gate and nothing else.
    this.loadDetailData(this.selectedAsset());
    this.loadRawBundle(this.selectedAsset());
    this.defaultToken();
  }

  /**
   * Pick a token so DETAIL, SOCIAL, WALLETS and ROTATION always have one.
   *
   * The highest-scoring row, because it is the one with the most of its model
   * resolved - a token scored on four inputs would show a page of dashes and
   * teach an operator nothing about where the numbers come from. Only ever
   * fills an EMPTY selection, so an explicit choice in the header is never
   * overwritten on the next poll.
   */
  defaultToken() {
    if (this.state.selectedId) return;
    const rows = this.assets || [];
    if (!rows.length) return;
    const best = rows.reduce((top, a) =>
      ((a.score ?? -1) > (top.score ?? -1) ? a : top), rows[0]);
    if (best) this.setState({ selectedId: best.id });
  }

  /**
   * Follow an operand to the field it names.
   *
   * Switching tab is not enough on its own: the target is one card among
   * dozens, so it is scrolled to and blinked. Without that, 'it is on the
   * WALLETS tab' is still a search.
   */
  jumpTo = (page, field) => {
    clearTimeout(this.pingTimer);
    clearTimeout(this.settleTimer);
    // A token tab's field now lives in step 6 of the SCORE PIPELINE tab: go
    // there, keep the ring keyed by the field's own catalogue page.
    if (MAP_ONLY_PAGES.has(page)) {
      this.setState({ page: 'pipe', ping: { page, field, at: Date.now() } },
        () => this.settleJump(page, field, 0));
      return;
    }
    this.setState({ page, ping: { page, field, at: Date.now() } }, () => this.settleJump(page, field, 0));
  };

  /**
   * Scroll to the jumped-to card, waiting for it if it is not there yet.
   *
   * Several groups only exist once their endpoint has answered - SYSTEM
   * HEALTH and EVALUATION each render a fallback set of cards with entirely
   * different labels until then. A jump that gave up on the first frame would
   * land on the right tab and then sit there, which is the failure that looks
   * most like a broken link. So it retries for a few seconds and keeps the
   * ring armed until the card turns up.
   */
  settleJump(page, field, attempt) {
    const id = 'vs-' + page + '-' + String(field).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Let the ring finish, then drop it, so an unrelated re-render later
      // does not replay the animation.
      this.pingTimer = setTimeout(() => this.setState({ ping: null }), 2200);
      return;
    }
    if (attempt >= 20) { this.setState({ ping: null }); return; }
    this.settleTimer = setTimeout(() => this.settleJump(page, field, attempt + 1), 300);
  }

  /** Pin this page - and the dashboard - to one server, or hand it to the probe. */
  pickServer = async (next) => {
    if (next === this.state.target) return;
    await setApiTarget(next);
    this.setState({ target: apiTarget(), localUp: await probeLocalApi(), apiIsLocal: usingLocalApi() });
    this.syncLiveData();
  };

  /** Admin picks the token the scoped tabs describe, without leaving the tab. */
  pickToken = (e) => {
    const id = e.target.value;
    this.setState({ selectedId: id || null });
  };

  render() {
    const v = this.renderVals();
    const selectedNow = this.selectedAsset();
    // The score pipeline reads the token's scored row exactly as the board
    // holds it, and the intel the detail page loaded - the objects, not a
    // re-derivation, so every step on the map is the number the app used.
    v.pipe = {
      s: (selectedNow && selectedNow.rawServerRow) || null,
      intel: this.state.intel || null,
      // Only when it is THIS token's: a bundle from the previous selection
      // must never be shown under the new one.
      raw: this.rawBundle && selectedNow && selectedNow.rawServerRow &&
        this.rawBundle.key === selectedNow.rawServerRow.chain + ':' + selectedNow.rawServerRow.tokenAddress +
          ':' + selectedNow.rawServerRow.poolAddress ? this.rawBundle : null,
      assets: this.assets || [],
    };
    const page = shownPage(this.state.page);
    const isOps = Object.prototype.hasOwnProperty.call(OPS_PAGES, page);
    const isFlow = page === FLOW_PAGE;

    // The dashboard's own rail, plus the three server pages under it. Built
    // from v.navItems so the mirror's nav cannot drift from the dashboard's.
    const navItems = [
      {
        label: 'DATA FLOW', child: false, disabled: false,
        go: () => this.setState({ page: FLOW_PAGE }),
        hint: 'every panel, file and provider on one canvas', indent: 16,
        fg: isFlow ? '#e35ff2' : '#8b96b8',
        tickC: isFlow ? '#e35ff2' : '#39445f',
        line: isFlow ? '#e35ff2' : 'transparent',
        bg: isFlow ? 'rgba(227,95,242,0.07)' : 'transparent',
      },
      // The pipeline's steps as cards, in order - the same catalogue the map
      // lays out as its columns, readable top to bottom.
      {
        label: 'SCORE PIPELINE', child: true, disabled: false,
        go: () => this.setState({ page: 'pipe' }),
        hint: 'every step from raw file to score, for the selected token', indent: 30,
        fg: page === 'pipe' ? '#e35ff2' : '#8b96b8',
        tickC: page === 'pipe' ? '#e35ff2' : '#39445f',
        line: page === 'pipe' ? '#e35ff2' : 'transparent',
        bg: page === 'pipe' ? 'rgba(227,95,242,0.07)' : 'transparent',
      },
      // The dashboard's rail minus the tabs that now live only on the map.
      ...v.navItems.filter((item) => !MAP_ONLY_PAGES.has(PAGE_FOR_LABEL[item.label])).map((item) => {
        const key = PAGE_FOR_LABEL[item.label];
        if (!key) return item;
        const active = page === key;
        return {
          ...item,
          disabled: false, hint: '',
          go: () => this.setState({ page: key }),
          fg: active ? '#e35ff2' : '#8b96b8',
          tickC: active ? '#e35ff2' : '#39445f',
          line: active ? '#e35ff2' : 'transparent',
          bg: active ? 'rgba(227,95,242,0.07)' : 'transparent',
        };
      }),
      ...Object.entries(OPS_PAGES).map(([k, label], i) => ({
        label: i === 0 ? 'SERVER' : label,
        child: i > 0, disabled: false,
        go: () => this.setState({ page: k }),
        hint: '', indent: i > 0 ? 30 : 16,
        fg: page === k ? '#e35ff2' : '#8b96b8',
        tickC: page === k ? '#e35ff2' : '#39445f',
        line: page === k ? '#e35ff2' : 'transparent',
        bg: page === k ? 'rgba(227,95,242,0.07)' : 'transparent',
      })),
    ];

    const selected = this.selectedAsset();

    return (
      <div style={{
        fontFamily: "'Poppins', sans-serif", fontSize: 12, background: '#081736',
        minHeight: '100vh', display: 'flex', flexDirection: 'column', color: C.text,
      }}>
        <ExplainStyles />
        {/* The dashboard's top bar, rebuilt: same height and chrome, but the
            things an operator needs instead of the things a trader needs. */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, height: 46, padding: '0 14px',
          background: C.panel, borderBottom: `1px solid ${C.border}`, flexShrink: 0,
          position: 'sticky', top: 0, zIndex: 50,
        }}>
          <div style={{ fontSize: 14, fontWeight: 800, color: C.white, whiteSpace: 'nowrap' }}>
            VibeScreener <span style={{ color: C.pink }}>Admin</span>
          </div>
          <div style={{ width: 1, height: 24, background: C.border }} />
          <ServerSwitch target={this.state.target} localUp={this.state.localUp} onPick={this.pickServer} />
          <div style={{ flex: 1 }} />

          {/* Every token-scoped tab describes one asset. Choosing it here means
              an operator never has to go to the board and come back. */}
          <select value={this.state.selectedId || ''} onChange={this.pickToken}
            style={{
              background: '#0d1730', border: `1px solid ${C.border}`, borderRadius: 999,
              color: C.text, fontFamily: 'inherit', fontSize: 10, padding: '4px 10px',
              maxWidth: 240,
            }}>
            {/* Only before the first poll - after that one is always picked. */}
            {!this.state.selectedId && (
              <option value="">waiting for the first poll</option>
            )}
            {(this.assets || []).slice(0, 60).map((a) => (
              <option key={a.id} value={a.id}>
                {a.sym} {a.chain} {a.score == null ? '' : Math.round(a.score)}
              </option>
            ))}
          </select>

          <div style={{ fontSize: 11, color: '#b6c2de', whiteSpace: 'nowrap' }}>{v.clock} UTC</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{
              width: 7, height: 7, borderRadius: '50%', background: v.liveDotColor,
              animation: v.liveDotAnim,
            }} />
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: v.liveDotColor }}>
              {v.liveLabel}
            </span>
          </div>
          <a href="/" style={{ fontSize: 10.5, color: C.dim, textDecoration: 'none', whiteSpace: 'nowrap' }}>
            dashboard &rarr;
          </a>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <SideNav v={{ ...v, navItems }} />
          <div style={{
            flex: 1, minWidth: 0,
            overflow: isFlow ? 'hidden' : 'auto',
            position: isFlow ? 'relative' : 'static',
            padding: isFlow ? 0 : '14px 16px 40px',
          }}>
            {v.serverError && !isOps && !isFlow && (
              <div style={{
                background: C.panel, border: `1px solid ${C.hot}`, borderRadius: 10,
                padding: '12px 14px', marginBottom: 14, fontSize: 11, color: C.hot, lineHeight: 1.6,
              }}>
                No answer from <span style={{ color: '#4fc3f7' }}>{API_ORIGIN}</span>
                {this.state.apiIsLocal ? ' (local)' : ' (deployed)'}. Every value below is
                whatever was last held in memory, or empty. Retrying every 5s.
              </div>
            )}

            {isFlow ? (
              <MapBoundary>
                <FlowChart v={v} onJumpToMirror={this.jumpTo} />
              </MapBoundary>
            ) : isOps ? (
              <AdminOps initialTab={page === 'opsStore' ? 'storage' : page === 'opsSources' ? 'sources' : 'server'} />
            ) : (
              <MirrorPage
                page={page}
                v={v}
                onJump={this.jumpTo}
                ping={this.state.ping}
                needsSelection={page === 'pipe'
                  && !selected}
              />
            )}

            {!isOps && !isFlow && (
              <div style={{ fontSize: 9, color: C.grey, marginTop: 18, lineHeight: 1.7, maxWidth: 900 }}>
                Read-only. Every value above is read out of the same renderVals() object the
                dashboard renders, so this page cannot show a different number than the tab it
                mirrors. The formulas come from data/catalog.js and admin/provenance.js, beside
                the code that computes them.
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }
}

/** The mirror's page list, re-exported for anything that needs the order. */
export { MIRROR_PAGES };
