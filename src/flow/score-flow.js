/**
 * THE DEFAULT SCORE FLOW, EXECUTABLE.
 *
 * Every node here IS a box on the DATA FLOW map: same id (f:pipe:<label>),
 * and its `deps` are the boxes the map wires into it. Running the nodes in
 * order, for one token, is computing that token's score - so the map is not
 * a drawing of the score, it is the score.
 *
 * WIRES CARRY STANDARD TYPES (flow/types.js): number, bool, text, list, dict.
 * Each node declares the type it sends; what it sends is only that value.
 * Anything a panel needs beyond it (an evidence line, a flag's description)
 * is the node's NOTE, kept beside the wire - `out(value, note)` - and read
 * only for display, never as data by the next box.
 *
 * The map's edits are obeyed: a box deleted or a wire cut makes that box, and
 * everything the map marks red downstream, produce nothing; a wire drawn into
 * a dot re-feeds it (flow/runtime.js). Weights, gate thresholds and the mean
 * window are the flow's own parameter boxes (flow/params.js).
 *
 * The arithmetic is the score's own (the same core.js primitives), so the
 * default flow reproduces the old numbers exactly - see the golden check.
 */

import {
  toNumber, to100, multipleScore, logScore, zScoresFrom, bucketBaselines, rotationFor,
  walletQualityScore, organicFlowScore,
} from '../calculations/core.js';
import { GATES } from '../calculations/gates.js';
import {
  SCORE_MODEL, SCORE_MODIFIERS, STAGES, TOTAL_WEIGHT, assessRisk, settledScore, stageFor,
} from '../calculations/asset-detail.js';
import { weightOf, scoreWindowMs } from './params.js';
import { missingIds, reroutes } from './runtime.js';
import { typeOfValue, coerce } from './types.js';
import { boardValues, BOARD_TYPES } from './board-flow.js';

const fin = Number.isFinite;
const round = (v, dp) => (fin(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
const P = (label) => 'f:pipe:' + label;
const num = (x) => (fin(x) ? x : null);

/* ----------------------------------------------------------- the nodes -- */

const NODES = [];
/** A value on the wire, and a note beside it for the panels. */
const out = (value, note) => ({ __out: true, value, note });
/**
 * node(label, wire type, inputs, run). run(inputs, ctx, notes) returns the
 * value (or out(value, note)); `notes` reads an input box's note.
 */
const node = (label, type, deps, run) => NODES.push({ id: P(label), label, type, deps: deps.map(P), run });
const get = (inp, label) => inp[P(label)];

// --- EXTRACT: the readings, picked out of the token's raw record -----------
const row = (ctx) => ctx.row || {};
node('LIQUIDITY', 'number', [], (i, c) => num(row(c).liquidityUsd));
node('BUYERS 24H', 'number', [], (i, c) => (row(c).traders24h ? num(row(c).traders24h.buyers) : null));
node('BUY/SELL 24H', 'number', [], (i, c) => num(row(c).buySellRatio24h));
node('PRICE, 2 SOURCES', 'dict', [], (i, c) => row(c).crossSource || null);
node('VENUES', 'number', [], (i, c) => (row(c).sources && row(c).sources.dexscreener ? num(row(c).sources.dexscreener.pairs) : null));
node('QUOTE TOKEN PRICE', 'number', [], (i, c) => num(row(c).quoteTokenPriceUsd));
node('POOL AGE', 'number', [], (i, c) => num(row(c).poolAgeHours));
node('VOLUME / LIQUIDITY', 'number', [], (i, c) => num(row(c).volumeToLiquidity24h));
node('JUPITER STATS', 'dict', [], (i, c) => c.jupiter || row(c).jupiter || null);
node('VOLUME 24H', 'number', [], (i, c) => num(row(c).volume24hUsd));
node('MARKET CAP', 'number', [], (i, c) => num(row(c).marketCapUsd));
node('FDV', 'number', [], (i, c) => num(row(c).fdvUsd));
node('PRICE CHANGE 5M', 'number', [], (i, c) => (row(c).priceChangePct ? num(row(c).priceChangePct.m5) : null));
node('LINKS', 'dict', [], (i, c) => row(c).links || {});
node('POOL SAMPLES', 'list', [], (i, c) => c.samples || []);
node('TRADE SAMPLE', 'dict', [], (i, c) => c.own || null);
node('$10K ROUTE QUOTE', 'dict', [], (i, c) => (c.intel && c.intel.impact) || null);
node('HOLDERS', 'dict', [], (i, c) => (c.intel && c.intel.holders) || null);
node('TOP HOLDERS SHARE', 'number', [], (i, c) => (c.intel && c.intel.holders ? num(c.intel.holders.topHolderSharePct) : null));
node('CONTRACT CHECKS', 'dict', [], (i, c) => (c.intel && c.intel.contractSafety) || null);
node('LP / CREATOR / INSIDERS', 'dict', [], (i, c) => (c.intel && c.intel.contractSafety) || null);
node('USD REFERENCE', 'dict', [], (i, c) => c.usdReference || null);
node('PERP VENUES', 'dict', [], (i, c) => (c.listing && c.listing.perp) || null);
node('PROMOTION', 'list', [], (i, c) => (c.listing && c.listing.promotion) || null);
node('ETHOS (PROJECT X)', 'dict', [], (i, c) => c.ethos || null);

// --- the 5m BASELINES: history list → MEAN (number) → now ÷ mean (number) --
// Our own 15s samples are the baseline; a pool too new to have any falls back
// to buckets of its trade tape (core.js zScoresFrom / bucketBaselines).
const baselines = (c) => {
  if (!c.memo.baselines) {
    const fromSamples = zScoresFrom(c.samples || []);
    c.memo.baselines = Object.keys(fromSamples.metrics).length
      ? fromSamples : (c.own ? bucketBaselines(c.own.trades || []) : fromSamples);
  }
  return c.memo.baselines;
};
[['VOLUME 5M', 'volume5mUsd'], ['BUYS 5M', 'buys5m'], ['BUYERS 5M', 'buyers5m']].forEach(([name, metric]) => {
  // Both read history.json directly, as their boxes on the map do.
  node(name + ' HISTORY', 'list', [], (i, c) => c.samples || []);
  node(name + ' NOW', 'number', [], (i, c) => { const m = baselines(c).metrics[metric]; return m ? num(m.value) : null; });
  node(name + ' MEAN', 'number', [name + ' HISTORY'], (i, c) => {
    const m = baselines(c).metrics[metric];
    return m ? out(num(m.mean), m) : null;
  });
  // The multiple, with the z beside it for the panels.
  node(name + ' vs BASELINE', 'number', [name + ' NOW', name + ' MEAN'], (i, c, note) => {
    const m = note(name + ' MEAN');
    return m && fin(m.multiple) ? out(m.multiple, { z: m.z }) : null;
  });
});

// --- the other measures ------------------------------------------------------
node('NET FLOW RATIO', 'number', ['TRADE SAMPLE'], (i) => {
  const o = get(i, 'TRADE SAMPLE'); const s = o && o.stats;
  return s && s.netRatio !== null && s.netRatio !== undefined ? out(s.netRatio, s) : null;
});
node('TOP-5 WALLET SHARE', 'number', ['TRADE SAMPLE'], (i) => {
  const o = get(i, 'TRADE SAMPLE');
  return o && o.stats ? num(o.stats.top5SharePct) : null;
});
node('PRICE IMPACT $10K', 'number', ['$10K ROUTE QUOTE'], (i) => {
  const q = get(i, '$10K ROUTE QUOTE');
  return q && fin(q.priceImpactPct) ? out(q.priceImpactPct, { tradeUsd: q.tradeUsd }) : null;
});
node('HOLDER GROWTH RATE', 'number', ['HOLDERS'], (i) => {
  const h = get(i, 'HOLDERS');
  return h && h.growth && h.growth.perHour !== null && h.growth.perHour !== undefined ? h.growth.perHour : null;
});
node('SHARED WALLETS', 'number', ['TRADE SAMPLE'], (i, c) => {
  const r = c.walletSets ? rotationFor(c.walletSets, row(c).poolAddress) : null;
  return r && r.sharedWalletPct !== null ? out(r.sharedWalletPct, r) : null;
});
node('QUOTE DEVIATION', 'number', ['QUOTE TOKEN PRICE', 'USD REFERENCE'], (i) => {
  const q = get(i, 'QUOTE TOKEN PRICE'); const ref = get(i, 'USD REFERENCE');
  if (!ref || !fin(q) || !ref.median) return null;
  return out(Math.abs(q - ref.median) / ref.median * 100, { quote: q, ref });
});
node('WALLET SAMPLE', 'dict', ['TRADE SAMPLE'], (i, c) => c.walletIntel || null);
node('SURVIVAL', 'number', ['POOL AGE'], (i) => { const h = get(i, 'POOL AGE'); return fin(h) ? h / 24 : null; });
node('CONTACTABLE', 'number', ['LINKS'], (i) => {
  const l = get(i, 'LINKS') || {};
  return out((l.socials || []).length + (l.websites || []).length, l);
});
node('BOOSTED', 'bool', ['PROMOTION'], (i) => { const p = get(i, 'PROMOTION'); return out((p || []).length > 0, p || []); });
// 1 = no venue lists a perp of this ticker; nothing when no venue answered.
node('NO PERP ELSEWHERE', 'bool', ['PERP VENUES'], (i) => {
  const perp = get(i, 'PERP VENUES');
  if (perp && perp.listedOn.length) return out(false, perp);
  if (perp && perp.checked > 0) return out(true, perp);
  return null;
});
node('PROJECT REPUTATION', 'number', ['ETHOS (PROJECT X)'], (i) => {
  const e = get(i, 'ETHOS (PROJECT X)');
  return e ? out(num(e.score), e) : null;
});

// --- the components: each a number 0-100, nothing when its input is missing --
node('Volume anomaly', 'number', ['VOLUME 5M vs BASELINE'], (i, c, note) => {
  const m = get(i, 'VOLUME 5M vs BASELINE');
  return fin(m) ? out(multipleScore(m), m + 'x baseline, z ' + (note('VOLUME 5M vs BASELINE') || {}).z) : null;
});
node('Trade activity', 'number', ['BUYS 5M vs BASELINE'], (i, c, note) => {
  const m = get(i, 'BUYS 5M vs BASELINE');
  return fin(m) ? out(multipleScore(m), m + 'x baseline, z ' + (note('BUYS 5M vs BASELINE') || {}).z) : null;
});
node('Buyer breadth', 'number', ['BUYERS 5M vs BASELINE', 'BUYERS 24H'], (i) => {
  const m = get(i, 'BUYERS 5M vs BASELINE'); const buyers = get(i, 'BUYERS 24H');
  const anomaly = fin(m) ? multipleScore(m) : null;
  const absolute = logScore(buyers, 10, 3000);
  if (anomaly === null && absolute === null) return null;
  const blended = anomaly !== null && absolute !== null
    ? Math.round(anomaly * 0.5 + absolute * 0.5) : (anomaly !== null ? anomaly : absolute);
  return out(blended, (buyers != null ? buyers + ' buyers 24h' : '') + (fin(m) ? ', ' + m + 'x 5m baseline' : ''));
});
node('Net demand', 'number', ['NET FLOW RATIO', 'JUPITER STATS', 'BUY/SELL 24H'], (i, c, note) => {
  const ratio = get(i, 'NET FLOW RATIO'); const jup = get(i, 'JUPITER STATS'); const bs = get(i, 'BUY/SELL 24H');
  const jw = jup && (jup.stats1h || jup.stats5m || jup.stats24h) ? (jup.stats1h || jup.stats5m || jup.stats24h) : null;
  if (ratio !== null && ratio !== undefined) {
    const s = note('NET FLOW RATIO') || {};
    return out(to100(0.5 + ratio / 2), 'net $' + s.netUsd.toLocaleString() + ' over ' + s.windowMinutes + 'm');
  }
  if (jw && jw.netRatio !== null) {
    return out(to100(0.5 + jw.netRatio / 2), 'net $' + Math.round(jw.netUsd).toLocaleString() + ' of $' +
      Math.round((jw.buyUsd || 0) + (jw.sellUsd || 0)).toLocaleString() + ' (Jupiter USD split)');
  }
  if (fin(bs)) return out(to100((bs - 0.5) / 1.5), 'buy/sell count ratio ' + bs.toFixed(2) + ' (no USD split yet)');
  return null;
});
node('Liquidity / executability', 'number', ['LIQUIDITY', 'PRICE IMPACT $10K'], (i, c, note) => {
  const liq = get(i, 'LIQUIDITY'); const ip = get(i, 'PRICE IMPACT $10K');
  const depth = logScore(liq, 10000, 1000000);
  const impact = fin(ip) ? to100(1 - ip / 2.5) : null;
  if (depth === null && impact === null) return null;
  const blended = depth !== null && impact !== null
    ? Math.round(depth * 0.5 + impact * 0.5) : (depth !== null ? depth : impact);
  return out(blended, (depth !== null ? '$' + Math.round(liq).toLocaleString() + ' depth' : '') +
    (impact !== null ? ', ' + ip + '% impact on $' + (note('PRICE IMPACT $10K') || {}).tradeUsd : ''));
});
node('Price confirmation', 'number', ['PRICE, 2 SOURCES'], (i) => {
  const cs = get(i, 'PRICE, 2 SOURCES');
  if (cs && fin(cs.priceDeltaPct)) return out(to100(1 - Math.abs(cs.priceDeltaPct) / 5), Math.abs(cs.priceDeltaPct).toFixed(2) + '% apart');
  if (cs && cs.sourcesAgreeing < 2) return out(40, 'only one source priced it');
  return null;
});
node('Holder growth', 'number', ['HOLDER GROWTH RATE', 'HOLDERS', 'JUPITER STATS'], (i) => {
  const perHour = get(i, 'HOLDER GROWTH RATE'); const holders = get(i, 'HOLDERS') || {}; const jup = get(i, 'JUPITER STATS');
  if (perHour !== null && perHour !== undefined) {
    const rate = holders.count ? (perHour / holders.count) * 100 : 0;
    return out(to100(0.5 + rate * 5), (perHour > 0 ? '+' : '') + perHour + ' holders/h' +
      (fin(holders.count) ? ' on ' + holders.count.toLocaleString() : ''));
  }
  if (jup && jup.stats1h && fin(jup.stats1h.holderChangePct)) {
    const pct = jup.stats1h.holderChangePct;
    return out(to100(0.5 + pct / 4), (pct > 0 ? '+' : '') + pct.toFixed(2) + '% holders in 1h' +
      (jup.holderCount ? ' on ' + jup.holderCount.toLocaleString() : '') + ' (Jupiter)');
  }
  return null;
});
node('Wallet quality', 'number', ['TOP HOLDERS SHARE', 'WALLET SAMPLE', 'LP / CREATOR / INSIDERS', 'JUPITER STATS'], (i) => {
  const providerTop = get(i, 'TOP HOLDERS SHARE'); const wallet = get(i, 'WALLET SAMPLE');
  const cs = get(i, 'LP / CREATOR / INSIDERS') || {}; const jup = get(i, 'JUPITER STATS');
  const jupTop = jup && jup.audit ? toNumber(jup.audit.topHoldersPercentage) : null;
  const walletTop = wallet && wallet.holderSharePct !== null && wallet.holderSharePct !== undefined ? wallet.holderSharePct : null;
  const topHolderSharePct = walletTop !== null ? walletTop : (providerTop !== null ? providerTop : jupTop);
  const holderSource = walletTop !== null ? 'GoPlus, pool excluded'
    : (providerTop !== null ? 'GoPlus' : (jupTop !== null ? 'Jupiter audit' : null));
  const quality = walletQualityScore(wallet, {
    topHolderSharePct, holderSource,
    insidersDetected: cs.insidersDetected, creatorOtherTokens: cs.creatorOtherTokens, lpLockedPct: cs.lpLockedPct,
  });
  const facts = { topHolderSharePct, topHolderShareSource: holderSource };
  if (quality.score === null) return out(null, { facts });
  return out(quality.score, { facts, detail: quality,
    text: quality.note + (quality.measured < quality.total ? ' (' + quality.measured + ' of ' + quality.total + ' wallet checks)' : '') });
});
node('Capital rotation', 'number', ['SHARED WALLETS'], (i, c, note) => {
  const pct = get(i, 'SHARED WALLETS'); const r = note('SHARED WALLETS') || {};
  return fin(pct) ? out(to100(pct / 25), r.sharedWalletCount + ' wallets shared with ' +
    (r.peers && r.peers[0] ? r.peers[0].symbol : 'other pools') + ' (' + pct + '% of traders)') : null;
});
node('Cross-venue confirm', 'number', ['VENUES', 'PRICE, 2 SOURCES'], (i) => {
  const venues = get(i, 'VENUES'); const cs = get(i, 'PRICE, 2 SOURCES');
  if (!fin(venues)) return null;
  const agreeing = cs ? cs.sourcesAgreeing : 1;
  return out(to100((logScore(venues, 1, 20) / 100) * (agreeing > 1 ? 1 : 0.6)), venues + ' venues, ' + agreeing + '/2 sources');
});
node('USD reference', 'number', ['QUOTE DEVIATION'], (i, c, note) => {
  const dev = get(i, 'QUOTE DEVIATION'); const d = note('QUOTE DEVIATION');
  return fin(dev) && d ? out(to100(1 - dev / 2), d.ref.symbol + ' $' + d.quote.toFixed(4) + ' vs $' + d.ref.median.toFixed(4) +
    ' median of ' + d.ref.quotes.length + ' venues (' + dev.toFixed(2) + '% off)') : null;
});
node('Whitespace', 'number', ['NO PERP ELSEWHERE'], (i, c, note) => {
  const open = get(i, 'NO PERP ELSEWHERE'); const perp = note('NO PERP ELSEWHERE');
  if (open === false) return out(0, { perp, text: 'perp already on ' + perp.listedOn.map((k) => perp.labels[k] || k).join(', ') });
  if (open === true) return out(100, { perp, text: 'no perp on the ' + perp.checked + ' of ' + perp.total + ' venues that answered' });
  return out(null, { perp: perp || null });
});
node('Durability', 'number', ['SURVIVAL'], (i) => {
  const days = get(i, 'SURVIVAL');
  return fin(days) ? out(logScore(Math.max(days, 1), 14, 180), days.toFixed(1) + ' days old (14d = 0, 180d = 100)') : null;
});
node('Reachability', 'number', ['CONTACTABLE', 'BOOSTED'], (i, c, note) => {
  const links = note('CONTACTABLE') || {}; const promotion = note('BOOSTED') || [];
  const kinds = (links.socials || []).map((s) => String((s && s.type) || '').toLowerCase());
  const reach = {
    website: (links.websites || []).length > 0, x: kinds.includes('twitter') || kinds.includes('x'),
    telegram: kinds.includes('telegram'), boosted: get(i, 'BOOSTED') === true,
  };
  const got = [['website', 30], ['x', 30], ['telegram', 20], ['boosted', 20]].filter(([k]) => reach[k]);
  return out(got.reduce((a, [, w]) => a + w, 0), { reach: { ...reach, promotion },
    text: got.length ? got.map(([k, w]) => k + ' ' + w).join(' + ') : 'no website, X, Telegram or paid promotion' });
});
const COMPONENTS = SCORE_MODEL.filter((c) => c.key !== 'dataQuality');
node('Data quality', 'number', COMPONENTS.map((c) => c.label), (i) => {
  const measured = COMPONENTS.filter((c) => get(i, c.label) != null);
  const coverable = SCORE_MODEL.length - 1;
  return out(Math.round((measured.length / coverable) * 100), measured.length + ' of ' + coverable + ' inputs present');
});

// --- the modifiers ------------------------------------------------------------
node('Organic flow', 'number', ['WALLET SAMPLE', 'JUPITER STATS'], (i) => {
  const wallet = get(i, 'WALLET SAMPLE'); const jup = get(i, 'JUPITER STATS');
  const organic = organicFlowScore(wallet, {
    jupiterScore: jup ? jup.organicScore : null, jupiterLabel: jup ? jup.organicScoreLabel : null,
    sampledAt: wallet ? wallet.sampledAt : null,
  });
  if (organic.score === null) return out(null, { detail: organic });
  return out(organic.score, { basis: organic.basis, detail: organic,
    evidence: organic.note + (organic.basis === 'sample' && organic.measured < organic.total
      ? ' (' + organic.measured + ' of ' + organic.total + ' flow checks)' : '') });
});
node('Contract safety', 'number', ['CONTRACT CHECKS'], (i) => {
  const cs = get(i, 'CONTRACT CHECKS');
  if (!cs || !cs.available) return null;
  const passed = (cs.checks || []).filter((x) => x.ok).length;
  const total = (cs.checks || []).length || 1;
  return out(Math.round((passed / total) * 100), passed + '/' + total + ' checks pass' +
    (cs.rugcheckRisks && cs.rugcheckRisks.length ? ', ' + cs.rugcheckRisks.length + ' RugCheck risks' : ''));
});

// --- the GATES: a bool each (1 = pass), then VETO LOG (an OR, 1 = vetoed) -------
const GATE_DEPS = {
  sellable: ['CONTRACT CHECKS'], tax: ['CONTRACT CHECKS'], major: ['MARKET CAP'], ticker: [],
  age: ['POOL AGE'], liquidity: ['LIQUIDITY'], volume: ['VOLUME 24H'], wash: ['Organic flow'],
};
const GATE_LABEL = {
  sellable: 'SELLABLE', tax: 'TAX IN RANGE', major: 'NOT A MAJOR', ticker: 'REAL TICKER',
  age: 'AGE FLOOR', liquidity: 'LIQUIDITY FLOOR', volume: 'VOLUME FLOOR', wash: 'NOT WASH-FLAGGED',
};
GATES.forEach((g) => node(GATE_LABEL[g.key], 'bool', GATE_DEPS[g.key], (i, c) => {
  const gateRow = {
    symbol: row(c).symbol, marketCapUsd: get(i, 'MARKET CAP'), poolAgeHours: get(i, 'POOL AGE'),
    liquidityUsd: get(i, 'LIQUIDITY'), volume24hUsd: get(i, 'VOLUME 24H'),
  };
  const x = { intel: { contractSafety: get(i, 'CONTRACT CHECKS') }, organicFlow: get(i, 'Organic flow') };
  let r = null;
  try { r = g.test(gateRow, x); } catch (e) { r = null; }
  // Not checked (no data) is nothing on the wire - never a veto.
  return r ? out(Boolean(r.ok), r.detail) : out(null, 'not checked yet');
}));
node('VETO LOG', 'bool', GATES.map((g) => GATE_LABEL[g.key]), (i, c, note) => {
  const checks = GATES.map((g) => {
    const ok = get(i, GATE_LABEL[g.key]);
    return { key: g.key, label: g.label, ok: ok === null || ok === undefined ? null : ok, detail: note(GATE_LABEL[g.key]) || 'not checked yet' };
  });
  const vetoes = checks.filter((x) => x.ok === false);
  return out(vetoes.length > 0, { checks, vetoed: vetoes.length > 0, vetoes, unchecked: checks.filter((x) => x.ok === null).map((x) => x.label) });
});

// --- the SCORE -----------------------------------------------------------------
node('RAW', 'number', SCORE_MODEL.map((c) => c.label), (i, c, note) => {
  let weighted = 0; let used = 0;
  const breakdown = SCORE_MODEL.map((m) => {
    const value = get(i, m.label);
    const present = fin(value);
    const weight = weightOf(m);
    if (present) { weighted += value * weight; used += weight; }
    const n = note(m.label);
    return { key: m.key, label: m.label, weight, value: present ? value : null, pending: !present,
      evidence: (typeof n === 'string' ? n : n && n.text) || null };
  });
  return out(used ? Math.round(weighted / used) : 0, { used, breakdown });
});
// The flags' penalties, as a list of numbers; their codes and lines are the note.
node('RISK FLAGS', 'list', ['POOL AGE', 'PRICE, 2 SOURCES', 'LIQUIDITY', 'VOLUME / LIQUIDITY', 'TOP-5 WALLET SHARE',
  'Contract safety', 'Organic flow', 'JUPITER STATS', 'PROJECT REPUTATION'], (i, c, note) => {
  const organic = get(i, 'Organic flow'); const on = note('Organic flow') || {};
  const safety = get(i, 'Contract safety');
  const modifiers = {
    contractSafety: fin(safety) ? { value: safety, evidence: note('Contract safety') } : undefined,
    organicFlow: fin(organic) ? { value: organic, basis: on.basis, evidence: on.evidence, detail: on.detail } : undefined,
  };
  const riskRow = {
    poolAgeHours: get(i, 'POOL AGE'), crossSource: get(i, 'PRICE, 2 SOURCES'),
    liquidityUsd: get(i, 'LIQUIDITY'), volumeToLiquidity24h: get(i, 'VOLUME / LIQUIDITY'),
  };
  const top5 = get(i, 'TOP-5 WALLET SHARE');
  const r = assessRisk(riskRow, modifiers, { tradeStats: top5 === null ? null : { top5SharePct: top5 }, ethos: note('PROJECT REPUTATION') || null });
  return out(r.flags.map((f) => f.penalty), r.flags);
});
node('RISK PENALTY', 'number', ['RISK FLAGS'], (i) => {
  const pens = get(i, 'RISK FLAGS');
  return Array.isArray(pens) ? Math.min(15, pens.reduce((a, b) => a + b, 0)) : null;
});
node('RIGHT NOW', 'number', ['RAW', 'RISK PENALTY', 'VETO LOG'], (i) => {
  const raw = get(i, 'RAW'); const pen = get(i, 'RISK PENALTY'); const vetoed = get(i, 'VETO LOG');
  if (!fin(raw) || !fin(pen) || vetoed === null || vetoed === undefined) return null;
  return vetoed ? 0 : Math.max(0, Math.min(100, raw - pen));
});
node('RIGHT NOW, 15 MIN MEAN', 'number', ['RIGHT NOW'], (i, c) => {
  const now = get(i, 'RIGHT NOW');
  if (!fin(now)) return null;
  const s = c.trackStage === false
    ? { average: now, samples: 1, observedMs: 0, min: now, max: now }
    : settledScore(row(c).chain, row(c).tokenAddress, now, c.now);
  return out(s.average, s);
});
node('FINAL', 'number', ['VETO LOG', 'RIGHT NOW, 15 MIN MEAN'], (i) => {
  const vetoed = get(i, 'VETO LOG'); const mean = get(i, 'RIGHT NOW, 15 MIN MEAN');
  if (vetoed === null || vetoed === undefined || !fin(mean)) return null;
  return vetoed ? 0 : mean;
});
node('STAGE', 'text', ['FINAL'], (i, c) => {
  const score = get(i, 'FINAL');
  if (!fin(score)) return null;
  const s = c.trackStage === false
    ? { stage: (STAGES.find((x) => score >= x.min) || STAGES[STAGES.length - 1]).name, since: c.now, history: [] }
    : stageFor(row(c).chain, row(c).tokenAddress, score);
  return out(s.stage, s);
});

// COVERAGE: the share of the model's weight that resolved, 0-1.
node('COVERAGE', 'number', SCORE_MODEL.map((c) => c.label), (i) => {
  let used = 0;
  SCORE_MODEL.forEach((m) => { if (fin(get(i, m.label))) used += weightOf(m); });
  return round(used / TOTAL_WEIGHT, 3);
});
// WHAT MOVES THIS SCORE: each component's points against a neutral 50, a list
// in model order (null where the component has no value).
node('WHAT MOVES THIS SCORE', 'list', SCORE_MODEL.map((c) => c.label), (i) => {
  let used = 0;
  SCORE_MODEL.forEach((m) => { if (fin(get(i, m.label))) used += weightOf(m); });
  if (!used) return null;
  return out(SCORE_MODEL.map((m) => { const x = get(i, m.label); return fin(x) ? round(((x - 50) * weightOf(m)) / used, 1) : null; }),
    SCORE_MODEL.map((m) => m.label));
});

export const SCORE_NODES = NODES;
const TYPE_OF = Object.fromEntries(NODES.map((n) => [n.id, n.type]));
/** Each box's declared wire type, by id - what its outgoing wire carries. */
export const NODE_TYPES = { ...BOARD_TYPES, ...Object.fromEntries(NODES.map((n) => [n.id, n.type])) };

/* ----------------------------------------------------------- the runner -- */

/**
 * Runs the flow for one token. Returns { values, notes }: every box's value
 * on its wire (null = nothing: no data, or cut on the map) and its note.
 * A value that is not its box's declared type is a bug in the box and is
 * dropped, so a wire never carries anything but its standard type.
 */
export function runScoreFlow(ctx) {
  const missing = missingIds();
  const rr = reroutes();
  const values = {};
  const notes = {};
  const c = { ...ctx, memo: {}, now: ctx.now || Date.now() };
  NODES.forEach((n) => {
    if (missing.has(n.id)) { values[n.id] = null; return; }
    const inputs = {};
    // An input the user re-fed on the map reads the box that feeds it now.
    const fed = rr.get(n.id) || {};
    const srcOf = (d) => fed[d] || d;
    // A re-fed input arrives converted to the type its dot expects.
    const bv = boardValues();
    n.deps.forEach((d) => {
      const s = srcOf(d);
      const x = s in values ? values[s] : (s in bv ? bv[s] : null);
      inputs[d] = s === d ? x : coerce(x, TYPE_OF[d]);
    });
    const note = (label) => notes[srcOf(P(label))];
    let res = null;
    try { res = n.run(inputs, c, note); } catch (e) { res = null; }
    let value = res && res.__out ? res.value : res;
    if (res && res.__out) notes[n.id] = res.note;
    if (value === undefined) value = null;
    if (value !== null && typeOfValue(value) !== n.type) value = null;
    values[n.id] = value;
  });
  return { values, notes };
}

/**
 * The scorer the app uses: the flow's values, in the shape the app has always
 * read (scoreAsset's), so every tab renders the flow's numbers. A box the
 * map has cut off leaves its part of the result empty.
 */
export function flowScore(row, extras) {
  const { values: v, notes } = runScoreFlow({
    row, samples: extras.samples, own: extras.own, walletSets: extras.walletSets, intel: extras.intel,
    usdReference: extras.usdReference, walletIntel: extras.walletIntel, jupiter: extras.jupiter,
    ethos: extras.ethos, listing: extras.listing, trackStage: extras.trackStage,
  });
  const val = (label) => v[P(label)];
  const nt = (label) => notes[P(label)];
  const rawNote = nt('RAW');
  const raw = val('RAW');
  const gates = (val('VETO LOG') !== null && nt('VETO LOG')) || { checks: [], vetoed: false, vetoes: [], unchecked: [] };
  const mean = val('RIGHT NOW, 15 MIN MEAN') !== null ? nt('RIGHT NOW, 15 MIN MEAN') : null;
  const stage = val('STAGE') !== null ? nt('STAGE') : null;
  const organic = val('Organic flow'); const organicNote = nt('Organic flow') || {};
  const safety = val('Contract safety');
  const quality = nt('Wallet quality') || {};
  const modifiers = {
    organicFlow: organic !== null ? { value: organic, evidence: organicNote.evidence } : null,
    contractSafety: safety !== null ? { value: safety, evidence: nt('Contract safety') } : null,
  };
  return {
    rawScore: raw,
    gates,
    vetoed: gates.vetoed,
    riskPenalty: val('RISK PENALTY'),
    riskFlags: val('RISK FLAGS') !== null ? nt('RISK FLAGS') || [] : [],
    score: val('FINAL'),
    scoreNow: val('RIGHT NOW'),
    scoreSamples: mean ? mean.samples : 0,
    scoreObservedMs: mean ? mean.observedMs : 0,
    scoreWindowMs: scoreWindowMs(15 * 60 * 1000),
    scoreMin: mean ? mean.min : null,
    scoreMax: mean ? mean.max : null,
    stage: val('STAGE'),
    stageSince: stage ? stage.since : null,
    stageHistory: stage ? stage.history : [],
    scoreModel: raw !== null && rawNote ? rawNote.breakdown
      : SCORE_MODEL.map((c) => ({ key: c.key, label: c.label, weight: weightOf(c), value: null, pending: true, evidence: null })),
    scoreModifiers: SCORE_MODIFIERS.map((m) => ({
      key: m.key, label: m.label,
      value: modifiers[m.key] ? modifiers[m.key].value : null,
      pending: !modifiers[m.key],
      evidence: modifiers[m.key] ? modifiers[m.key].evidence : null,
    })),
    walletQuality: quality.detail || null,
    organicFlow: organicNote.detail || null,
    facts: {
      ...(quality.facts || {}),
      perp: (nt('Whitespace') || {}).perp || null,
      reach: (nt('Reachability') || {}).reach || null,
    },
    weightCovered: rawNote && raw !== null ? rawNote.used : 0,
    componentsPresent: rawNote && raw !== null ? rawNote.breakdown.filter((b) => !b.pending).length : 0,
    dataQuality: rawNote && raw !== null ? round(rawNote.used / TOTAL_WEIGHT, 2) : 0,
    // Every box's value on its wire, for the map to show what the flow computed.
    flowValues: v,
  };
}
