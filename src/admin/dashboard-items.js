/**
 * THE DASHBOARD, as the map draws it: the frontend's tabs, each tab's panels,
 * and in each panel the DASHBOARD ITEMS it displays.
 *
 * A dashboard item only DISPLAYS. It is a number, a chart, a list, a table or
 * a text, and it names the flow box its value comes from - nothing else. Any
 * arithmetic a panel used to do (a count, an average, a pick) is a box in the
 * flow now (pipeline.js BOARD STATS and SERVICES), so a wire into an item is
 * always "this value, shown here".
 *
 *   { label, display, from: [ref / api / store tokens], show: [page, label] }
 *
 * `show` points at the card in pipeline-shown.js whose value() the item
 * displays, so the item shows the same number the frontend does.
 */

import { ref, api } from './provenance';

/** A browser store as a source (graph.js STORES). */
const store = (id) => ({ t: 'store', id });

const pipe = (label) => ref('pipe', label);
const market = (field) => api('/raw/<chain>/market.json', field);

export const DASHBOARD = [
  {
    // On every tab: the header bar and its filters.
    tab: 'HEADER',
    panels: [
      { panel: 'TOP BAR', items: [
        { label: 'MARKET REGIME', display: 'text', from: [pipe('MARKET REGIME')] },
        { label: 'ALERTS NOW', display: 'number', from: [pipe('ALERTS NOW')] },
        { label: 'TOKEN PICKER', display: 'list', from: [pipe('TOKEN LIST'), pipe('FINAL')] },
      ] },
      { panel: 'FILTERS', items: [
        { label: 'STAGES BAR', display: 'chart', from: [pipe('STAGE COUNTS')] },
      ] },
      { panel: 'ALERT FEED', items: [
        { label: 'LIVE TAPE', display: 'list', from: [pipe('ALERT ENGINE')] },
        { label: 'TOASTS', display: 'list', from: [pipe('ALERT ENGINE')] },
      ] },
    ],
  },
  {
    tab: 'LIVE OPPORTUNITIES',
    panels: [
      { panel: 'HEADER STATS', items: [
        { label: 'TOKENS TRACKED', display: 'number', from: [pipe('TOKENS TRACKED')], show: ['live', 'TOKENS TRACKED'] },
        { label: 'AVG ORGANIC SCORE', display: 'number', from: [pipe('AVG ORGANIC SCORE')], show: ['live', 'AVG ORGANIC SCORE'] },
        { label: 'TOP 20 HIT RATE', display: 'number', from: [pipe('TOP 20 HIT RATE')], show: ['live', 'TOP 20 HIT RATE'] },
      ] },
      { panel: 'BOARD', items: [
        { label: 'ASSET', display: 'text', from: [pipe('TOKEN LIST')] },
        { label: 'STAGE', display: 'text', from: [pipe('STAGE')], show: ['live', 'STAGE'] },
        { label: 'SCORE', display: 'number', from: [pipe('FINAL')], show: ['live', 'SCORE'] },
        { label: 'CONF', display: 'number', from: [pipe('COVERAGE')], show: ['live', 'CONF'] },
        { label: 'PRICE', display: 'number', from: [market('PRICE, 2 SOURCES')], show: ['live', 'PRICE'] },
        { label: 'DELTA 5M', display: 'number', from: [market('PRICE CHANGE 5M')], show: ['live', 'DELTA 5M'] },
        { label: 'LIQUIDITY', display: 'number', from: [market('LIQUIDITY')], show: ['live', 'LIQUIDITY'] },
        { label: 'VOL 5M', display: 'number', from: [api('/raw/<chain>/history.json', 'VOLUME 5M NOW')], show: ['live', 'VOLUME'] },
        { label: 'WASH', display: 'number', from: [pipe('Organic flow')], show: ['live', 'WASH'] },
        { label: 'NET FLOW', display: 'number', from: [pipe('NET FLOW RATIO')], show: ['live', 'NET FLOW'] },
        { label: 'BUYERS', display: 'number', from: [market('BUYERS 24H')], show: ['live', 'BUYERS'] },
        { label: 'AGE', display: 'number', from: [pipe('SURVIVAL')], show: ['live', 'AGE'] },
        { label: 'TREND', display: 'chart', from: [api('/raw/<chain>/history.json', 'VOLUME 5M HISTORY')], show: ['live', 'TREND (sparkline)'] },
      ] },
      { panel: 'DAILY PICK', items: [
        { label: 'DAILY PICK', display: 'text', from: [pipe('DAILY PICK')] },
      ] },
      { panel: 'VETO LOG', items: [
        { label: 'VETO LOG', display: 'list', from: [pipe('VETO LOG')] },
      ] },
    ],
  },
  {
    tab: 'TOKEN DETAIL',
    panels: [
      { panel: 'SCORE', items: [
        { label: 'SCORE GAUGE', display: 'chart', from: [pipe('FINAL')], show: ['detail', 'FINAL'] },
        { label: 'STAGE', display: 'text', from: [pipe('STAGE')] },
        { label: 'SCORE SPARKLINE', display: 'chart', from: [pipe('RIGHT NOW, 15 MIN MEAN')] },
      ] },
      { panel: 'PRICE & SCORE', items: [
        { label: 'CANDLES', display: 'chart', from: [api('/raw/<chain>/bars15/<pool>.json')], show: ['detail', 'CANDLES'] },
        { label: 'SCORE LINES', display: 'chart', from: [store('idb:trails')], show: ['detail', 'SCORE LINES'] },
      ] },
      { panel: 'MARKET', items: [
        { label: 'PRICE', display: 'number', from: [market('PRICE, 2 SOURCES')] },
        { label: 'LIQUIDITY', display: 'number', from: [market('LIQUIDITY')] },
        { label: 'VOLUME 24H', display: 'number', from: [market('VOLUME 24H')] },
        { label: 'BUYERS 24H', display: 'number', from: [market('BUYERS 24H')] },
        { label: 'BUY/SELL 24H', display: 'number', from: [market('BUY/SELL 24H')] },
        { label: 'VENUES', display: 'number', from: [market('VENUES')] },
        { label: 'MARKET CAP', display: 'number', from: [market('MARKET CAP')] },
        { label: 'FDV', display: 'number', from: [market('FDV')] },
        { label: 'DELTA 5M', display: 'number', from: [market('PRICE CHANGE 5M')] },
        { label: 'POOL AGE', display: 'number', from: [pipe('SURVIVAL')] },
      ] },
      { panel: 'WHAT MOVES THIS SCORE', items: [
        { label: 'POINTS PER COMPONENT', display: 'chart', from: [pipe('WHAT MOVES THIS SCORE')] },
      ] },
      { panel: 'SCORE DECOMPOSITION', items: [
        { label: 'COMPONENT BARS', display: 'chart', from: [pipe('RAW')] },
        { label: 'RAW', display: 'number', from: [pipe('RAW')], show: ['detail', 'RAW'] },
        { label: 'RISK PENALTY', display: 'number', from: [pipe('RISK PENALTY')], show: ['detail', 'RISK PENALTY'] },
        { label: 'FINAL', display: 'number', from: [pipe('FINAL')], show: ['detail', 'FINAL'] },
        { label: 'CONFIDENCE', display: 'number', from: [pipe('Data quality')], show: ['detail', 'CONFIDENCE'] },
      ] },
      { panel: 'RISK FLAGS', items: [
        { label: 'RISK FLAGS', display: 'list', from: [pipe('RISK FLAGS')] },
      ] },
      { panel: 'PERP LISTING', items: [
        { label: 'LISTING VERDICT', display: 'list', from: [pipe('VETO LOG'), pipe('Whitespace'), pipe('Durability'), pipe('Reachability')] },
      ] },
      { panel: 'OUTCOME TRACKING', items: [
        { label: 'FORWARD RETURNS', display: 'list', from: [pipe('FORWARD RETURNS')], show: ['detail', 'FORWARD RETURNS'] },
      ] },
    ],
  },
  {
    tab: 'WALLETS',
    panels: [
      { panel: 'WALLET STATS', items: [
        { label: 'ACTIVE WALLETS', display: 'number', from: [pipe('WALLET INTEL')], show: ['wallets', 'ACTIVE WALLETS'] },
        { label: 'NET FLOW', display: 'number', from: [pipe('WALLET INTEL')], show: ['wallets', 'NET FLOW'] },
        { label: 'BUYERS / SELLERS', display: 'number', from: [pipe('WALLET INTEL')], show: ['wallets', 'BUYERS / SELLERS'] },
        { label: 'TOP WALLET SHARE', display: 'number', from: [pipe('WALLET INTEL')], show: ['wallets', 'TOP WALLET SHARE'] },
        { label: 'CO-ENTRY WALLETS', display: 'number', from: [pipe('WALLET INTEL')], show: ['wallets', 'CO-ENTRY WALLETS'] },
      ] },
      { panel: 'WALLET GROUPS', items: [
        { label: 'ACCUMULATING / EXITING / CHURN / ROTATING / CO-ENTRY', display: 'list', from: [pipe('WALLET INTEL')] },
        { label: 'CO-ORDINATED ENTRY', display: 'list', from: [pipe('WALLET INTEL')] },
      ] },
      { panel: 'YOUR TRACKED WALLETS', items: [
        { label: 'TRACKED WALLETS', display: 'list', from: [pipe('WALLET INTEL')] },
      ] },
      { panel: 'WALLET MAP', items: [
        { label: 'BUBBLE MAP', display: 'chart', from: [pipe('WALLET INTEL')] },
      ] },
      { panel: 'WALLET QUALITY', items: [
        { label: 'WALLET QUALITY', display: 'number', from: [pipe('Wallet quality')] },
      ] },
      { panel: 'TURNOVER WITH OTHER TOKENS', items: [
        { label: 'ALSO TRADING', display: 'list', from: [pipe('ROTATION SERVICE')] },
      ] },
    ],
  },
  {
    tab: 'SOCIAL',
    panels: [
      { panel: 'SOCIAL STATS', items: [
        { label: 'MENTIONS', display: 'number', from: [pipe('MENTIONS')] },
        { label: 'UNIQUE AUTHORS', display: 'number', from: [pipe('UNIQUE AUTHORS')] },
        { label: 'PER AUTHOR', display: 'number', from: [pipe('MENTIONS PER AUTHOR')] },
        { label: 'VS BASELINE', display: 'number', from: [pipe('VS SOCIAL BASELINE')] },
        { label: 'POSTS SCANNED', display: 'number', from: [api('/raw/social.json')] },
      ] },
      { panel: 'SOCIAL FEED', items: [
        { label: 'POSTS', display: 'list', from: [api('/raw/social.json')] },
      ] },
      { panel: 'SOURCES', items: [
        { label: 'SOURCES ANSWERING', display: 'table', from: [api('/raw/social.json')], show: ['social', 'SOURCES ANSWERING'] },
      ] },
      { panel: 'PROJECT REPUTATION · ETHOS', items: [
        { label: 'ETHOS SCORE', display: 'number', from: [pipe('PROJECT REPUTATION')], show: ['social', 'ETHOS SCORE'] },
        { label: 'ETHOS LEVEL', display: 'text', from: [api('/raw/ethos.json', 'ETHOS (PROJECT X)')], show: ['social', 'ETHOS LEVEL'] },
        { label: 'ACCOUNT KIND', display: 'text', from: [api('/raw/ethos.json', 'ETHOS (PROJECT X)')], show: ['social', 'ACCOUNT KIND'] },
      ] },
    ],
  },
  {
    tab: 'ROTATION',
    panels: [
      { panel: 'NET ROTATION', items: [
        { label: 'NET ROTATION', display: 'number', from: [pipe('ROTATION SERVICE')] },
        { label: 'CONNECTED POOLS', display: 'list', from: [pipe('ROTATION SERVICE')] },
      ] },
      { panel: 'ROTATION PATHS', items: [
        { label: 'ROTATION PATHS', display: 'chart', from: [pipe('ROTATION SERVICE')] },
      ] },
    ],
  },
  {
    tab: 'MARKET ROTATION',
    panels: [
      { panel: 'MEASURED ROTATION', items: [
        { label: 'RIBBONS', display: 'chart', from: [pipe('ROTATION SERVICE')] },
        { label: 'POOLS SAMPLED', display: 'number', from: [pipe('ROTATION SERVICE')] },
      ] },
      { panel: 'NET GAINERS / LOSERS', items: [
        { label: 'NET GAINERS', display: 'list', from: [pipe('ROTATION SERVICE')] },
        { label: 'NET LOSERS', display: 'list', from: [pipe('ROTATION SERVICE')] },
      ] },
    ],
  },
  {
    tab: 'EVALUATION',
    panels: [
      { panel: 'THE ANSWER', items: [
        { label: 'EXCESS RETURN', display: 'number', from: [pipe('SCORE EVALUATION')] },
        { label: 'RANK IC', display: 'chart', from: [pipe('SCORE EVALUATION')] },
      ] },
      { panel: 'HOW MUCH DATA', items: [
        { label: 'PREDICTIONS', display: 'number', from: [pipe('SCORE EVALUATION')] },
        { label: 'TOKENS SCORED', display: 'number', from: [pipe('SCORE EVALUATION')] },
      ] },
      { panel: 'HOW EACH GROUP DID', items: [
        { label: 'BY STAGE', display: 'table', from: [pipe('SCORE EVALUATION')] },
        { label: 'RUG RATE', display: 'number', from: [pipe('SCORE EVALUATION')] },
        { label: 'WARNING FLAGS', display: 'table', from: [pipe('SCORE EVALUATION')] },
      ] },
      { panel: 'RANK IC · EACH 15-MIN MOMENT', items: [
        { label: 'RANK IC SERIES', display: 'chart', from: [pipe('SCORE EVALUATION')] },
      ] },
    ],
  },
  {
    tab: 'HEALTH',
    panels: [
      { panel: 'DATA SOURCES', items: [
        { label: 'PROVIDER STATUS', display: 'table', from: [pipe('SYSTEM HEALTH')] },
      ] },
      { panel: 'CHAINS', items: [
        { label: 'CHAIN FRESHNESS', display: 'table', from: [pipe('SYSTEM HEALTH')] },
      ] },
      { panel: 'BACKGROUND JOBS', items: [
        { label: 'JOBS', display: 'table', from: [pipe('WALLET INTEL'), pipe('ROTATION SERVICE'), pipe('SOCIAL BASELINE')] },
      ] },
      { panel: 'THIS BROWSER', items: [
        { label: 'STORES', display: 'table', from: [store('idb:score-journal'), store('idb:trails'), store('idb:wallet-memory'), store('idb:social-memory')] },
      ] },
      { panel: 'SERVER & ARCHIVE', items: [
        { label: 'SERVER', display: 'table', from: [pipe('SYSTEM HEALTH')] },
        { label: 'ARCHIVE PER DAY', display: 'chart', from: [pipe('SYSTEM HEALTH')] },
      ] },
    ],
  },
  {
    tab: 'ALERTS',
    panels: [
      { panel: 'ALERT CARDS', items: [
        { label: 'OPPORTUNITY / RISK / RESOLUTION', display: 'list', from: [pipe('ALERT ENGINE')] },
      ] },
    ],
  },
];

/** Every item, flattened, with its tab and panel. */
export const dashboardItems = () => {
  const out = [];
  DASHBOARD.forEach((t) => t.panels.forEach((p) => p.items.forEach((it) => out.push({ ...it, tab: t.tab, panel: p.panel }))));
  return out;
};
