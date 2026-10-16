/**
 * THE BOARD FLOW - the DATA FLOW's board-wide boxes, run once per poll over
 * every token (the score flow runs per token; these read the whole board, the
 * background services and the selected token's own reads).
 *
 * Same ids as their boxes on the map (BOARD STATS, SERVICES, WALLET READ,
 * ROTATION READ, SOCIAL STATS), standard wire types (flow/types.js), and the
 * map's edits obeyed: a box deleted or cut off produces nothing. Every tab
 * reads these values - the header, ALERTS, HEALTH, WALLETS, ROTATION, MARKET
 * ROTATION - so their numbers are the flow's. The tabs only lay them out.
 *
 * Anything a panel needs beyond the value (the full precision result, the
 * judged health report's parts) travels BESIDE the wire as the box's note,
 * read with boardNotes(), never on it.
 */

import { missingIds } from './runtime.js';
import { getSetting } from '../admin/box-settings';
import { REGIME_SETTING, REGIME_DEFAULT } from '../data/regimes';
import { chainKeys, chainNameToKey } from '../data/chains';
import { precisionAtK, mentionBaseline } from '../calculations/core';
import { tradePlanRules } from './score-flow';
import {
  walletIntelStatus, walletIntelForPool, walletProfile, walletClusters,
} from '../services/wallet-intel';
import { rotationIntelStatus, rotationHeld, rotationMemoryFor } from '../services/rotation-intel';
import { socialIntelStatus, socialRecordFor } from '../services/social-intel';
import { journalFor } from '../services/score-journal';
import { storageStats } from '../services/storage/history-store';
import { rawStoreStats } from '../services/storage/raw-store';
import { coerce } from './types';

const B = (label) => 'f:pipe:' + label;
const fin = Number.isFinite;

/** Each board box's wire type. */
export const BOARD_TYPES = {
  [B('TOKEN LIST')]: 'list',
  [B('TOKENS TRACKED')]: 'number',
  [B('SIGNAL COUNTS')]: 'dict',
  [B('BOARD COUNTS')]: 'dict',
  [B('AVG ORGANIC SCORE')]: 'number',
  [B('ORGANIC GRADES')]: 'dict',
  [B('DAILY PICK')]: 'text',
  [B('ALERT ENGINE')]: 'dict',
  [B('ALERTS NOW')]: 'number',
  [B('MARKET REGIME')]: 'text',
  // The services: each a dict of its own state.
  [B('WALLET INTEL')]: 'dict',
  [B('ROTATION SERVICE')]: 'dict',
  [B('SOCIAL BASELINE')]: 'dict',
  [B('SYSTEM HEALTH')]: 'dict',
  [B('SCORE EVALUATION')]: 'dict',
  [B('FORWARD RETURNS')]: 'dict',
  [B('TOP 20 HIT RATE')]: 'number',
  // The selector, and the selected token's own reads.
  [B('THIS TOKEN')]: 'text',
  [B('TOKEN WALLETS')]: 'dict',
  [B('WALLET COVERAGE')]: 'dict',
  [B('ACTIVE WALLETS')]: 'number',
  [B('WALLET NET FLOW')]: 'number',
  [B('BUYER WALLETS')]: 'number',
  [B('SELLER WALLETS')]: 'number',
  [B('TOP WALLET SHARE')]: 'number',
  [B('CO-ENTRY WALLETS')]: 'number',
  [B('WALLET GROUPS')]: 'dict',
  [B('WALLET RANKS')]: 'dict',
  [B('WALLET HISTORY')]: 'dict',
  [B('TRACKED HERE')]: 'list',
  [B('CLUSTERS ELSEWHERE')]: 'list',
  [B('TOKEN ROTATION')]: 'dict',
  [B('CHAIN ROTATION')]: 'dict',
  [B('MARKET ROTATION')]: 'dict',
  [B('MENTIONS')]: 'number',
  [B('UNIQUE AUTHORS')]: 'number',
  [B('MENTIONS PER AUTHOR')]: 'number',
  [B('VS SOCIAL BASELINE')]: 'number',
};

let current = {};
let currentNotes = {};
let pick = null;
const hash = (str) => { let h = 0; for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; };
/** The token behind DAILY PICK, for the card that shows it. */
export const dailyPickAsset = () => pick;
/** The last poll's board values, by box id. */
export const boardValues = () => current;
/** The last poll's notes (what travels beside a wire), by box id. */
export const boardNotes = () => currentNotes;
/** One box's value and note, by label. */
export const boardValue = (label) => (B(label) in current ? current[B(label)] : null);
export const boardNote = (label) => currentNotes[B(label)] || null;

const out = (value, note) => ({ __out: true, value, note });

/* ====================================================== ORGANIC GRADES === */

/** The organic model's own grades (organicFlowScore): weak < 45, fair 45-69, strong 70+. */
export const ORGANIC_ZONES = Object.freeze([
  { from: 0, to: 45, name: 'WEAK' },
  { from: 45, to: 70, name: 'FAIR' },
  { from: 70, to: 100, name: 'STRONG' },
]);
export const organicGradeOf = (score) => ORGANIC_ZONES.find((z) => score < z.to) || ORGANIC_ZONES[2];

/* ===================================================== TOP 20 HIT RATE === */

/** A precision reading needs at least this many resolved picks to be shown. */
export const PRECISION_MIN_PICKS = 20;
/**
 * Horizons to try, longest first. 24h is the one worth having, and the one
 * the record can least often support: it needs a score mark and a price a
 * full day apart, so one outage in that day breaks every pick that spans it.
 * The box takes the LONGEST horizon that actually resolves.
 */
export const PRECISION_HORIZONS = Object.freeze([86400000, 43200000, 21600000, 10800000, 3600000]);

let precisionMemo = { key: null, result: null };
/**
 * Precision@20 over the fetched record ({ inputs, journal, at } from
 * App.refreshPrecision). Megabytes of joins that change on the scale of
 * hours, so it is re-run only when a new read arrives.
 */
function precisionOf(read) {
  if (!read) return null;
  if (read.error) return { error: read.error };
  if (precisionMemo.key === read) return precisionMemo.result;
  const inputs = read.inputs;
  let result = null;
  let exhausted = true;
  for (const horizonMs of PRECISION_HORIZONS) {
    const attempt = precisionAtK(inputs.observations, read.journal, {
      k: 20, horizonMs, windowMs: Math.max(horizonMs, 43200000),
    });
    if (!result) result = attempt;
    if (attempt.evaluated >= PRECISION_MIN_PICKS) { result = attempt; exhausted = false; break; }
  }
  const full = Object.assign({}, result, {
    exhausted,
    coverage: inputs.coverage ? inputs.coverage.coverage : null,
    missingMs: inputs.coverage ? inputs.coverage.missingMs : null,
    longestGapMs: inputs.coverage ? inputs.coverage.longestGapMs : null,
    source: inputs.source,
    at: read.at,
  });
  precisionMemo = { key: read, result: full };
  return full;
}

/* ======================================================== ALERT ENGINE === */
/*
 * What the bot would actually have sent, grouped by the claim it makes. Four
 * classes, all read from the model (flow/score-flow.js): BUY is the SIGNAL's
 * entry call, EXIT its SELL / SHORT call at the peak. RISK fires off the
 * warning families directly, because a token that looks like a rug is rarely
 * a BUY - if risk only ever lowered the score the worst tokens would be the
 * quietest ones. RESOLUTION closes prior BUY calls out of the journal by what
 * the price did, against the same target and stop the signal is graded on.
 *
 * Nothing here is composed. Every evidence line is what a family reported and
 * every card carries the condition that would prove it wrong.
 */

/**
 * What kind of claim the card is making. Direction, not magnitude.
 */
export const ALERT_CLASSES = Object.freeze({
  OPPORTUNITY: { key: 'OPPORTUNITY', label: 'Buy', trigger: 'signal BUY', accent: '#3ddc97' },
  EXIT: { key: 'EXIT', label: 'Exit', trigger: 'signal SELL or SHORT', accent: '#ff4d5e' },
  // Fires off risk families DIRECTLY - never off the opportunity score.
  RISK: { key: 'RISK', label: 'Risk', trigger: 'riskScore >= 60 on >= 2 independent families', accent: '#ff4fae' },
  // Closes a prior alert. The only class that can reference another alert.
  RESOLUTION: { key: 'RESOLUTION', label: 'Resolution', trigger: 'a prior alert met an invalidation condition or its horizon', accent: '#e8eefc' },
});

/**
 * Evidence is grouped by WHAT IT OBSERVES, not by which number produced it.
 * Four signals derived from the same trade tape are one signal seen four
 * ways - `correlatesWith` records the families whose inputs overlap, and
 * confidence is discounted across any correlated pair that both fire.
 * `components` maps each family onto the inputs of EARLY.
 */
export const EVIDENCE_FAMILIES = Object.freeze([
  { key: 'cycle', label: 'Cycle', classes: ['OPPORTUNITY', 'EXIT'],
    observes: 'Where the price sits in its own recent range: run, waking or spent',
    components: ['earlyRoom', 'earlyWaking', 'earlyHolding'], correlatesWith: [], source: 'have' },
  { key: 'flow', label: 'Flow', classes: ['OPPORTUNITY', 'EXIT'],
    observes: 'Volume and buyers against their own recent normal, and who is trading',
    components: ['earlyInterest', 'earlyRepeat'], correlatesWith: ['cycle'], source: 'have' },
  { key: 'breadth', label: 'Breadth', classes: ['OPPORTUNITY'],
    observes: 'How many holders it stands on, and for how long',
    components: ['earlyHolders', 'earlySeasoning'], correlatesWith: [], source: 'have' },
  { key: 'liquidity', label: 'Liquidity', classes: ['RISK'],
    observes: 'Pool depth and executability', components: [], correlatesWith: ['flow'], source: 'have' },
  // The GoPlus normalizer is already in lib/providers.js but stays dormant
  // without GOPLUS_API_KEY. This family is one env var from being real.
  { key: 'contract', label: 'Contract', classes: ['RISK'],
    observes: 'Mint and freeze authority, sell tax, LP lock state, proxy upgrades',
    components: [], correlatesWith: [], source: 'dormant' },
  { key: 'holders', label: 'Holders', classes: ['RISK'],
    observes: 'Supply distribution and movement toward exchange deposits',
    components: [], correlatesWith: ['breadth'], source: 'missing' },
  { key: 'deployer', label: 'Deployer', classes: ['RISK'],
    observes: 'Funding path of the deployer and the fate of its prior tokens',
    components: [], correlatesWith: [], source: 'missing' },
  // Shown on every card, but it cannot CONSTITUTE a risk claim: coverage and
  // immaturity discount confidence; they are not evidence of danger.
  { key: 'integrity', label: 'Integrity', classes: ['OPPORTUNITY', 'RISK'],
    observes: 'Whether the inputs themselves can be trusted',
    components: [], correlatesWith: [], constitutesRisk: false, source: 'have' },
  // Corroboration only. Never an input to score or confidence.
  { key: 'narrative', label: 'Narrative', classes: ['OPPORTUNITY', 'RISK'],
    observes: 'What is being said, and whether it looks coordinated',
    components: [], correlatesWith: [], weightsScore: false, source: 'missing' },
]);
export const FAMILY_KEYS = Object.freeze(EVIDENCE_FAMILIES.map((f) => f.key));

/** A family's strength bars, for the card. A family with no data is ABSENT, never zero. */
export const FAMILY_STRENGTH = Object.freeze({
  ABSENT: { min: null, label: 'no data', bars: 0 },
  WEAK: { min: 0, label: 'weak', bars: 1 },
  MODERATE: { min: 40, label: 'moderate', bars: 2 },
  STRONG: { min: 65, label: 'strong', bars: 3 },
  DECISIVE: { min: 85, label: 'decisive', bars: 4 },
});
export function strengthOf(value) {
  if (value == null || !fin(value)) return FAMILY_STRENGTH.ABSENT;
  if (value >= 85) return FAMILY_STRENGTH.DECISIVE;
  if (value >= 65) return FAMILY_STRENGTH.STRONG;
  if (value >= 40) return FAMILY_STRENGTH.MODERATE;
  return FAMILY_STRENGTH.WEAK;
}

export const RESOLUTIONS = Object.freeze({
  CONFIRMED: 'confirmed', INVALIDATED: 'invalidated', EXPIRED: 'expired', PENDING: 'pending',
});

/** A family qualifies only if it observes danger and reports at or above the trigger. */
export const RISK_TRIGGER = 60;
const RISK_HORIZON_MS = 4 * 3600e3;
const familySpec = (key) => EVIDENCE_FAMILIES.find((f) => f.key === key);

export function constitutingRisk(families) {
  return (families || []).filter((f) => {
    const spec = familySpec(f.key);
    if (!spec || spec.classes.indexOf('RISK') === -1) return false;
    if (spec.constitutesRisk === false) return false;
    return f.value != null && f.value >= RISK_TRIGGER;
  });
}

/** A risk flag's family strength, taken from the penalty it already carries. */
function valueFromPenalty(penalty) {
  if (!fin(penalty)) return 40;
  return Math.max(0, Math.min(95, 40 + penalty * 8));
}

/**
 * Confidence across families, discounted for overlap: two correlated
 * families that both fire count as roughly one and a half, not two.
 */
export function combineConfidence(families) {
  const firing = (families || []).filter((f) => f.value != null && f.value >= 40);
  if (!firing.length) return 0;
  let total = 0;
  const counted = new Set();
  for (const f of firing) {
    const spec = familySpec(f.key);
    const overlaps = (spec ? spec.correlatesWith : []).some((k) => counted.has(k));
    total += (f.confidence == null ? 0.5 : f.confidence) * (overlaps ? 0.5 : 1);
    counted.add(f.key);
  }
  // Saturating, so a pile-up of weak families never reads as certainty.
  return Math.min(0.97, 1 - Math.exp(-total / 1.8));
}

/** The contract every card is held to. A card that fails it is a bug in the engine. */
export function validateAlert(alert) {
  const problems = [];
  const a = alert || {};
  if (a.id == null) problems.push('id is required');
  if (!ALERT_CLASSES[a.class]) problems.push('class must be an ALERT_CLASSES key');
  if (a.claim == null) problems.push('claim is required - the card has nothing to say');
  const families = a.families || [];
  if (!families.length) problems.push('at least one evidence family must report');
  for (const f of families) {
    if (!FAMILY_KEYS.includes(f.key)) problems.push('unknown family: ' + f.key);
    if (f.value != null && !f.evidence) problems.push(f.key + ' reports a value with no evidence sentence');
  }
  if (!(a.invalidations || []).length) problems.push('an alert with no invalidation condition is not a claim');
  if (a.class === 'RISK' && constitutingRisk(families).length < 2) {
    problems.push('RISK needs >= 2 independent risk families at >= 60');
  }
  const narrative = families.find((f) => f.key === 'narrative');
  if (narrative && narrative.weighted) problems.push('narrative must not weight the score - corroboration only');
  return { ok: problems.length === 0, problems };
}

/** Which risk family each risk-flag code belongs to. */
const FLAG_FAMILY = {
  CONTRACT_CHECKS: 'contract', THIN_LIQUIDITY: 'liquidity', EXTREME_TURNOVER: 'liquidity',
  VOLUME_CONCENTRATED: 'holders', LOW_ORGANIC_FLOW: 'integrity', SINGLE_SOURCE: 'integrity', NEW_POOL: 'integrity',
};

/**
 * An evidence family, averaged over the EARLY inputs it owns. Confidence is
 * how much of the family actually reported.
 */
function opportunityFamily(row, key) {
  const spec = familySpec(key);
  const owned = (row.scoreModel || []).filter((c) => spec.components.indexOf(c.key) !== -1);
  const live = owned.filter((c) => !c.pending && c.value != null);
  if (!live.length) return { key, label: spec.label, value: null, confidence: 0, evidence: null };
  const weight = live.reduce((t, c) => t + c.weight, 0);
  const value = Math.round(live.reduce((t, c) => t + c.value * c.weight, 0) / (weight || 1));
  const lead = live.slice().sort((x, y) => (y.value * y.weight) - (x.value * x.weight))[0];
  return {
    key, label: spec.label, value,
    confidence: owned.length ? live.length / owned.length : 0,
    evidence: lead && lead.evidence ? lead.evidence : lead.label + ' scored ' + lead.value,
  };
}

/** A risk family, built from the flags that fired inside it. */
function riskFamilies(row) {
  const byFamily = {};
  for (const flag of row.riskFlags || []) {
    const key = FLAG_FAMILY[flag.code];
    if (!key) continue;
    const value = valueFromPenalty(flag.penalty);
    const cur = byFamily[key];
    if (!cur || value > cur.value) {
      byFamily[key] = { key, label: familySpec(key).label, value,
        confidence: flag.severity === 'HIGH' ? 0.8 : 0.55, evidence: flag.detail || flag.code };
    }
  }
  return Object.keys(byFamily).map((k) => byFamily[k]);
}

/**
 * The alert cards, as data: { OPPORTUNITY, EXIT, RISK, RESOLUTION }, each a
 * list of alerts (at most four), and the cards that failed the contract.
 */
function alertEngine(assets, now) {
  const plan = tradePlanRules();
  const OPP_HORIZON_MS = plan.horizonHours * 3600e3;
  const pctStr = (x) => (fin(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) + '%' : '—');
  const idOf = (a, row) => 'alert ' + String(row.tokenAddress || a.id).slice(0, 8);
  const slugOf = (a) => String(a.sym || '').replace(/^\$/, '').toLowerCase();

  const opportunities = assets
    .filter((a) => a.signal === 'BUY' && a.score != null)
    .sort((x, y) => y.score - x.score)
    .slice(0, 4)
    .map((a) => {
      const row = a.rawServerRow || {};
      const families = ['cycle', 'flow', 'breadth'].map((k) => opportunityFamily(row, k)).filter((f) => f.value != null);
      return {
        cls: 'OPPORTUNITY', stage: 'BUY', sym: a.sym, chain: a.chain,
        claim: 'BUY ' + a.sym + ' — ' + (a.signalWhy || 'waking, not run yet') + '.',
        families,
        conf: a.conf == null ? combineConfidence(families) : a.conf,
        invalidations: [
          'price falls ' + plan.stopPct + '% from entry before rising ' + plan.targetPct + '% (the stop)',
          'it has not paid within ' + plan.horizonHours + 'h',
        ],
        horizon: plan.horizonHours + 'h', at: now, id: idOf(a, row), slug: slugOf(a),
      };
    });

  const aboveLow = (a) => (((a.rawServerRow || {}).measures || {}).aboveLow6hPct || 0);
  const exits = assets
    .filter((a) => a.signal === 'SELL' || a.signal === 'SHORT')
    .sort((x, y) => aboveLow(y) - aboveLow(x))
    .slice(0, 4)
    .map((a) => {
      const row = a.rawServerRow || {};
      const m = row.measures || {};
      const smart = row.smart || {};
      const families = [{
        key: 'cycle', label: 'Cycle', value: fin(m.aboveLow6hPct) ? Math.min(100, Math.round(m.aboveLow6hPct)) : null,
        confidence: 0.8, evidence: a.phaseWhy || 'peaking',
      }];
      if (fin(smart.sellers) && smart.sellers > 0) {
        families.push({ key: 'flow', label: 'Flow', value: Math.min(100, smart.sellers * 25), confidence: 0.6,
          evidence: smart.sellers + ' smart wallet' + (smart.sellers > 1 ? 's' : '') + ' selling in the last hour' });
      }
      return {
        cls: 'EXIT', stage: a.signal, sym: a.sym, chain: a.chain,
        claim: a.signal + ' ' + a.sym + ' — ' + (a.signalWhy || 'peaking') + '.',
        families,
        conf: combineConfidence(families),
        invalidations: [
          'price rises ' + plan.stopPct + '% further before falling ' + plan.targetPct + '%',
          'it makes a new high within ' + plan.horizonHours + 'h',
        ],
        horizon: plan.horizonHours + 'h', at: now, id: idOf(a, row), slug: slugOf(a),
      };
    });

  const penalty = (row) => (row.riskFlags || []).reduce((t, f) => t + (f.penalty || 0), 0);
  const risks = assets
    .map((a) => {
      const row = a.rawServerRow || {};
      const families = riskFamilies(row);
      // Integrity is shown but never counts toward the trigger.
      return { a, row, families, firing: constitutingRisk(families) };
    })
    // Two independent risk families, not one.
    .filter((r) => r.firing.length >= 2)
    .sort((x, y) => y.firing.length - x.firing.length || penalty(y.row) - penalty(x.row))
    .slice(0, 4)
    .map(({ a, row, families, firing }) => {
      const worst = firing.slice().sort((x, y) => y.value - x.value)[0];
      return {
        cls: 'RISK', stage: null, sym: a.sym, chain: a.chain,
        claim: firing.length + ' independent risk families fired on ' + a.sym + ' — led by ' + worst.label.toLowerCase() + '.',
        families,
        conf: combineConfidence(firing),
        invalidations: firing.map((f) => f.label.toLowerCase() + ' clears within ' + (RISK_HORIZON_MS / 3600e3) + 'h'),
        horizon: (RISK_HORIZON_MS / 3600e3) + 'h', at: now, id: idOf(a, row), slug: slugOf(a),
      };
    });

  // Symbols for tokens that may have left the live table since they alerted.
  const symbolFor = {};
  for (const a of assets) {
    const addr = (a.rawServerRow || {}).tokenAddress;
    if (addr) symbolFor[addr] = a.sym;
  }
  const resolutions = [];
  for (const chainKey of chainKeys) {
    const journal = journalFor(chainKey);
    for (const addr of Object.keys(journal)) {
      const series = journal[addr] || [];
      if (series.length < 2) continue;
      // The first BUY in the journal opens the call; the price path after it
      // closes it - target first, stop first, or the horizon.
      const alerted = series.findIndex((m) => m.stage === 'BUY' && fin(m.price));
      if (alerted === -1) continue;
      const opened = series[alerted];
      let outcome = null; let closedAt = null; let move = null;
      for (let k = alerted + 1; k < series.length; k++) {
        const m = series[k];
        if (!fin(m.price)) continue;
        const r = (m.price / opened.price - 1) * 100;
        if (r >= plan.targetPct) { outcome = RESOLUTIONS.CONFIRMED; closedAt = m; move = r; break; }
        if (r <= -plan.stopPct) { outcome = RESOLUTIONS.INVALIDATED; closedAt = m; move = r; break; }
        if (m.t - opened.t >= OPP_HORIZON_MS) {
          outcome = r > 0 ? RESOLUTIONS.CONFIRMED : RESOLUTIONS.INVALIDATED; closedAt = m; move = r; break;
        }
      }
      if (!outcome) continue;
      const elapsed = closedAt.t - opened.t;
      resolutions.push({
        cls: 'RESOLUTION', stage: null, outcome: outcome.toUpperCase(),
        sym: symbolFor[addr] || ('$' + addr.slice(0, 4).toUpperCase()),
        chain: chainKey.toUpperCase().slice(0, 4),
        claim: 'BUY closed ' + pctStr(move) + ' after ' + (elapsed / 3600e3).toFixed(1) + 'h' +
          (move >= plan.targetPct ? ' - target hit.' : move <= -plan.stopPct ? ' - stopped out.' : ' - horizon reached.'),
        families: [{
          key: 'cycle', label: 'Price path', value: Math.max(0, Math.min(100, Math.round(50 + move))), confidence: 0.9,
          evidence: 'Entered at $' + opened.price.toPrecision(4) + ', closed at $' + closedAt.price.toPrecision(4) +
            ' (' + pctStr(move) + ') over ' + (elapsed / 3600e3).toFixed(1) + 'h',
        }],
        conf: 0.9,
        invalidations: ['resolved — the journal is the record, nothing further to check'],
        horizon: 'closed', at: closedAt.t, id: 'alert ' + addr.slice(0, 8), slug: addr.slice(0, 8),
      });
    }
  }
  resolutions.sort((x, y) => y.at - x.at);

  // The contract is enforced here, not assumed.
  const invalid = [];
  for (const card of [...opportunities, ...exits, ...risks, ...resolutions]) {
    const check = validateAlert({ id: card.id, class: card.cls, claim: card.claim, families: card.families, invalidations: card.invalidations });
    if (!check.ok) invalid.push(card.id + ': ' + check.problems[0]);
  }
  return {
    columns: { OPPORTUNITY: opportunities, EXIT: exits, RISK: risks.slice(0, 4), RESOLUTION: resolutions.slice(0, 4) },
    invalid, plan,
  };
}

/* ======================================================= SYSTEM HEALTH === */
/*
 * Takes what the collector wrote about itself (system.json, with providers
 * already run through providerHealth()) and what the browser services report,
 * and answers one question per part of the system: is it doing its job right
 * now? Each part gets a level, a one-line headline and the problems that set
 * the level - never a level without a reason.
 *
 * Levels, worst last: ok < warn < down. `unknown` is "not reported yet" and
 * never drags the overall verdict down on its own.
 */

export const LEVEL_RANK = { unknown: 0, ok: 1, warn: 2, down: 3 };
const worst = (levels) => levels.reduce((w, l) => (LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w), 'ok');

/** What each upstream host is FOR: market data failing stales the board, a social source only thins a panel. */
export const SOURCE_GROUPS = [
  { key: 'market', label: 'Market data', critical: true, what: 'pools, prices, trades, bars' },
  { key: 'security', label: 'Security checks', critical: false, what: 'honeypot, rug and contract checks' },
  { key: 'intel', label: 'Token intel & routing', critical: false, what: 'holders, organic flow, price impact' },
  { key: 'prices', label: 'Reference prices', critical: false, what: 'CEX and index prices' },
  { key: 'social', label: 'Social', critical: false, what: 'mentions and chatter' },
  { key: 'other', label: 'Other', critical: false, what: '' },
];
const SOURCES = {
  'api.dexscreener.com': { label: 'DexScreener', group: 'market' },
  'api.geckoterminal.com': { label: 'GeckoTerminal', group: 'market' },
  'lite-api.jup.ag': { label: 'Jupiter', group: 'intel' },
  'aggregator-api.kyberswap.com': { label: 'KyberSwap', group: 'intel' },
  'api.gopluslabs.io': { label: 'GoPlus', group: 'security' },
  'api.rugcheck.xyz': { label: 'RugCheck', group: 'security' },
  'api.honeypot.is': { label: 'honeypot.is', group: 'security' },
  'coins.llama.fi': { label: 'DefiLlama', group: 'prices' },
  'api.binance.com': { label: 'Binance', group: 'prices' },
  'api.coinbase.com': { label: 'Coinbase', group: 'prices' },
  'api.coingecko.com': { label: 'CoinGecko', group: 'prices' },
  'www.reddit.com': { label: 'Reddit', group: 'social' },
  'a.4cdn.org': { label: '4chan', group: 'social' },
  'mastodon.social': { label: 'Mastodon', group: 'social' },
  'api.warpcast.com': { label: 'Farcaster', group: 'social' },
  'public.api.bsky.app': { label: 'Bluesky', group: 'social' },
};
/** Server collectors, in the order a reader cares about them. */
const JOBS = [
  { key: 'market', label: 'Market board', what: 'trending pools + prices, every chain' },
  { key: 'trades', label: 'Trades', what: 'wallet-level trades, one pool per pass' },
  { key: 'intel', label: 'Token intel', what: 'security + holder checks' },
  { key: 'ohlcv', label: 'Price bars', what: 'OHLCV candles' },
  { key: 'social', label: 'Social', what: 'social corpus' },
  { key: 'reference', label: 'Reference prices', what: 'CEX + index prices' },
  { key: 'promotion', label: 'Promotions', what: 'paid boosts and ads' },
  { key: 'system', label: 'Self-report', what: 'writes this page\'s data' },
  { key: 'coverage', label: 'Coverage', what: 'what the archive recorded' },
  { key: 'deep', label: 'Deep history', what: '48h history rebuild' },
  { key: 'probe', label: 'Archive probe', what: 'write + read-back test' },
  { key: 'scan', label: 'Archive scan', what: 'full archive integrity scan' },
];
/** What an error kind means, in words a reader can act on. */
export const ERROR_KIND_TEXT = {
  rateLimited: 'rate-limited (429) — we are calling too fast',
  timeout: 'timing out',
  server: 'provider errors (5xx)',
  client: 'rejecting requests (4xx) — often "token not found"',
  network: 'unreachable',
};

/** A duration in words ('45s', '3h 12m'), for the report's own sentences. */
export function ago(ms) {
  if (ms == null || !fin(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.round(h / 24) + 'd';
}
export function bytes(n) {
  if (n == null || !fin(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}
function dominantKind(kinds) {
  const entries = Object.entries(kinds || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries[0][0] : null;
}

function serverPart(system, now, waiting) {
  if (!system && waiting) {
    return { key: 'server', label: 'Collector server', level: 'unknown', headline: 'Checking…', sub: 'reading system.json', problems: [] };
  }
  if (!system) {
    return { key: 'server', label: 'Collector server', level: 'down', headline: 'No report',
      problems: ['system.json could not be read - the collector is not running or not reachable.'] };
  }
  const age = system.writtenAgeMs;
  const problems = [];
  let level = 'ok';
  if (age != null && age > 120000) { level = 'down'; problems.push('Last self-report ' + ago(age) + ' ago - the collector has stopped.'); }
  else if (age != null && age > 45000) { level = 'warn'; problems.push('Self-report is ' + ago(age) + ' old (normally every 15s).'); }
  const mem = system.memory || {};
  if (mem.rssMb > 1500) { level = worst([level, 'warn']); problems.push('Using ' + mem.rssMb + ' MB of memory.'); }
  return {
    key: 'server', label: 'Collector server', level,
    headline: level === 'down' ? 'Stopped' : 'Up ' + ago((system.uptimeSeconds || 0) * 1000),
    sub: 'reported ' + ago(age) + ' ago · ' + (mem.rssMb != null ? mem.rssMb + ' MB' : '—'),
    problems,
  };
}

function chainsPart(system, now) {
  const warm = system && system.warm;
  const state = (warm && warm.state) || {};
  const keys = (warm && warm.chains) || Object.keys(state);
  const interval = (warm && warm.intervalMs) || 5000;
  const rows = keys.map((key) => {
    const s = state[key] || {};
    const age = s.at ? now - s.at : null;
    const level = !s.at ? 'down'
      : s.error ? 'warn'
        : age > Math.max(interval * 12, 60000) ? 'down'
          : age > Math.max(interval * 4, 20000) ? 'warn'
            : !s.rows ? 'warn' : 'ok';
    return {
      key, level, ageMs: age, rows: s.rows || 0, ms: s.ms, error: s.error || null,
      why: !s.at ? 'never collected' : s.error ? s.error
        : level === 'down' ? 'stale for ' + ago(age) : level === 'warn' && !s.rows ? 'returned no pools'
          : level === 'warn' ? 'late by ' + ago(age) : null,
    };
  });
  const fresh = rows.filter((r) => r.level === 'ok').length;
  const bad = rows.filter((r) => r.level !== 'ok');
  const level = !rows.length ? 'unknown' : bad.some((r) => r.level === 'down') && fresh === 0 ? 'down' : bad.length ? 'warn' : 'ok';
  return {
    part: {
      key: 'chains', label: 'Market board', level,
      headline: rows.length ? fresh + ' / ' + rows.length + ' chains fresh' : 'No chains',
      sub: 'refreshes every ' + ago(interval),
      problems: bad.map((r) => r.key + ': ' + r.why),
    },
    rows,
  };
}

function sourcesPart(providers) {
  const rows = (providers || []).map((p) => {
    const meta = SOURCES[p.provider] || { label: p.provider, group: 'other' };
    const level = p.status === 'DOWN' ? 'down' : p.status === 'DEGRADED' ? 'warn' : p.status === 'IDLE' ? 'unknown' : 'ok';
    const kinds = (p.recent && p.recent.kinds) || p.errorKinds || {};
    const kind = dominantKind(kinds);
    const window = p.recent || { calls: p.calls, errors: p.errors, callsPerMinute: p.callsPerMinute, errorRatePct: p.errorRatePct };
    const successPct = window.calls ? 100 - (window.errorRatePct || 0) : null;
    const why = level === 'ok' || level === 'unknown' ? null : (kind ? ERROR_KIND_TEXT[kind] : (p.lastError || 'failing'));
    return {
      host: p.provider, label: meta.label, group: meta.group, level, status: p.status,
      successPct, callsPerMinute: window.callsPerMinute, calls: window.calls, errors: window.errors,
      p50Ms: p.p50Ms, p95Ms: p.p95Ms, kind, why, lastError: p.lastError,
      lastErrorAt: p.lastErrorAt, lastOkAt: p.lastOkAt, spark: p.spark, window: p.window,
      lifetime: { calls: p.calls, errors: p.errors, errorRatePct: p.errorRatePct },
    };
  });
  const groups = SOURCE_GROUPS.map((g) => {
    const members = rows.filter((r) => r.group === g.key);
    const level = !members.length ? 'unknown'
      : members.every((r) => r.level === 'down') ? 'down'
        : members.some((r) => r.level === 'down' || r.level === 'warn') ? 'warn' : 'ok';
    return Object.assign({}, g, { level, rows: members });
  }).filter((g) => g.rows.length);
  // Only the critical group can take the whole system down.
  const failing = rows.filter((r) => r.level === 'down' || r.level === 'warn');
  const critical = groups.find((g) => g.critical);
  const level = !rows.length ? 'unknown' : critical && critical.level === 'down' ? 'down' : failing.length ? 'warn' : 'ok';
  const healthy = rows.filter((r) => r.level === 'ok').length;
  return {
    part: {
      key: 'sources', label: 'Data sources', level,
      headline: rows.length ? healthy + ' / ' + rows.length + ' healthy' : 'No calls yet',
      sub: (rows[0] && rows[0].window === 'lifetime') ? 'since server start' : 'last 15 minutes',
      problems: failing.map((r) => r.label + ' ' + (r.level === 'down' ? 'down' : 'degraded') +
        (r.successPct != null ? ' (' + Math.round(r.successPct) + '% ok)' : '') + ' — ' + r.why),
    },
    rows,
    groups,
  };
}

function jobsPart(system, now) {
  const collectors = (system && system.collectors) || {};
  const schedule = (system && system.schedule) || {};
  const rows = JOBS.filter((j) => collectors[j.key]).map((j) => {
    const c = collectors[j.key];
    const interval = schedule[j.key] || null;
    const age = c.at ? now - c.at : null;
    // Overdue at three missed turns, with a floor so a 2.5s job is not
    // flagged over one slow upstream call.
    const overdue = interval && age != null && age > Math.max(interval * 3, 60000) + (c.ms || 0);
    const level = c.error ? 'warn' : overdue ? 'down' : 'ok';
    return { key: j.key, label: j.label, what: j.what, level, ageMs: age, intervalMs: interval,
      ms: c.ms, runs: c.runs, failures: c.failures, error: c.error, detail: c.skipped || null };
  });
  const bad = rows.filter((r) => r.level !== 'ok');
  return {
    part: {
      key: 'jobs', label: 'Background jobs', level: !rows.length ? 'unknown' : bad.length ? worst(bad.map((r) => r.level)) : 'ok',
      headline: rows.length ? (rows.length - bad.length) + ' / ' + rows.length + ' on schedule' : 'No jobs reported',
      sub: rows.reduce((s, r) => s + (r.runs || 0), 0).toLocaleString('en-US') + ' runs',
      problems: bad.map((r) => r.label + ': ' + (r.error || ('last ran ' + ago(r.ageMs) + ' ago'))),
    },
    rows,
  };
}

function archivePart(system, now, timeline) {
  const store = system && system.store;
  if (!store) return { key: 'archive', label: 'History archive', level: 'unknown', headline: '—', problems: [] };
  if (!store.enabled) {
    return { key: 'archive', label: 'History archive', level: 'warn', headline: 'Off',
      sub: 'memory only', problems: ['The archive is disabled - nothing survives a restart.'] };
  }
  const health = store.health || {};
  let level = health.level === 'failed' ? 'down' : health.level === 'degraded' ? 'warn' : 'ok';
  const usage = store.usage || {};
  const problems = (health.problems || []).slice();
  // Is it recording NOW? The last two finished blocks of the 24h strip answer
  // that; the whole-day share is context, not the verdict.
  const day = timeline && timeline.day;
  const cells = (day && day.ok && day.cells) || [];
  const latest = cells.slice(-3, -1);
  if (latest.length && latest.every((c) => c.state === 'lost')) {
    level = 'down'; problems.push('Nothing recorded in the last ' + ago(latest.length * day.bucketMs) + '.');
  } else if (latest.some((c) => c.state === 'lost' || c.state === 'partial')) {
    level = level === 'down' ? level : 'warn'; problems.push('Recording thinly in the last ' + ago(latest.length * day.bucketMs) + '.');
  }
  const dayPct = day && day.ok && day.recorded != null ? Math.round(day.recorded * 100) : null;
  return {
    key: 'archive', label: 'History archive', level,
    headline: bytes(usage.bytes) + ' on disk',
    sub: (dayPct != null ? dayPct + '% of 24h recorded · ' : '') + 'flushed ' + ago(health.sinceFlushMs) + ' ago',
    problems,
  };
}

/**
 * The raw files the app reads. A write that fails leaves the previous copy in
 * place, so a file stuck failing is the thing to show, not the count.
 */
function rawFilesPart(system, now) {
  const raw = system && system.raw;
  if (!raw) return { part: { key: 'files', label: 'Data files', level: 'unknown', headline: '—', problems: [] }, stuck: [] };
  const failing = raw.failing || {};
  const stuck = Object.keys(failing).map((rel) => {
    const f = failing[rel];
    const lastOkAge = f.lastOkAt ? now - f.lastOkAt : null;
    const recentFail = f.lastErrorAt && now - f.lastErrorAt < 10 * 60000;
    // Stuck: failing lately AND no good write since the last failure.
    const isStuck = recentFail && (!f.lastOkAt || f.lastOkAt < f.lastErrorAt);
    return { rel, errors: f.errors, lastOkAgeMs: lastOkAge, lastErrorAt: f.lastErrorAt, stuck: isStuck, error: f.lastError };
  }).filter((f) => f.stuck).sort((a, b) => (b.lastOkAgeMs || Infinity) - (a.lastOkAgeMs || Infinity));
  const total = (raw.writes || 0) + (raw.errors || 0);
  const failPct = total ? (raw.errors / total) * 100 : 0;
  const writeAge = raw.lastWriteAt ? now - raw.lastWriteAt : null;
  const problems = [];
  let level = 'ok';
  if (raw.error) { level = 'down'; problems.push('Store unavailable: ' + raw.error); }
  if (writeAge != null && writeAge > 60000) { level = worst([level, 'down']); problems.push('No file written for ' + ago(writeAge) + '.'); }
  stuck.forEach((f) => {
    level = worst([level, 'warn']);
    problems.push(f.rel + ' not updated ' + (f.lastOkAgeMs != null ? 'for ' + ago(f.lastOkAgeMs) : 'since start') +
      (/EPERM|EBUSY/.test(f.error || '') ? ' — file locked (OneDrive sync?)' : ''));
  });
  // Lifetime failures without a stuck file: note it, do not alarm.
  const sub = raw.failing
    ? (failPct >= 0.1 ? failPct.toFixed(1) + '% of writes failed since start' : 'all writes landing')
    : (raw.errors ? raw.errors.toLocaleString('en-US') + ' failed writes since start' : 'all writes landing');
  if (!raw.failing && failPct > 5) { level = worst([level, 'warn']); problems.push(failPct.toFixed(0) + '% of file writes failing — last: ' + (raw.lastError || '').slice(0, 80)); }
  return {
    part: {
      key: 'files', label: 'Data files', level,
      headline: stuck.length ? stuck.length + ' file' + (stuck.length > 1 ? 's' : '') + ' stuck' : 'Writing',
      sub, problems,
    },
    stuck,
  };
}

function browserPart(browser, now) {
  const services = [
    { key: 'wallet', label: 'Wallet intel', s: browser.wallet, stale: 60000,
      detail: (s) => (s.walletsKnown || 0).toLocaleString('en-US') + ' wallets · ' + (s.poolsHeld || 0) + ' pools' },
    { key: 'social', label: 'Social intel', s: browser.social, stale: 60000,
      detail: (s) => (s.tokensKnown || 0).toLocaleString('en-US') + ' tokens · ' + (s.corpusPosts || 0).toLocaleString('en-US') + ' posts' },
    { key: 'rotation', label: 'Rotation graph', s: browser.rotation, stale: 120000,
      detail: (s) => (s.chainsHeld || 0) + ' chains · ' + (s.poolsConnected || 0) + ' pools' },
  ].map((x) => {
    const s = x.s || {};
    const age = s.lastTickAt ? now - s.lastTickAt : null;
    const level = !s.running ? 'down' : s.lastError ? 'warn' : age == null ? 'unknown' : age > x.stale ? 'warn' : 'ok';
    return { key: x.key, label: x.label, level, ageMs: age, detail: x.s ? x.detail(s) : '—',
      error: !s.running ? 'stopped' : s.lastError || (age != null && age > x.stale ? 'no tick for ' + ago(age) : null) };
  });
  const st = browser.storage || {};
  const storeLevel = st.error ? 'warn' : st.backend === 'memory' ? 'warn' : st.backend === 'indexeddb' ? 'ok' : st.backend ? 'ok' : 'unknown';
  services.push({
    key: 'store', label: 'Browser storage', level: storeLevel, ageMs: null,
    detail: (st.keys || 0) + ' keys · ' + bytes(st.approxBytes),
    error: st.error || (st.backend === 'memory' ? 'memory only - nothing is saved' : null),
  });
  const reads = browser.reads || {};
  const bad = services.filter((s) => s.level === 'down' || s.level === 'warn');
  return {
    part: {
      key: 'browser', label: 'This browser', level: bad.length ? worst(bad.map((s) => s.level)) : 'ok',
      headline: (services.length - bad.length) + ' / ' + services.length + ' running',
      sub: (reads.reads || 0).toLocaleString('en-US') + ' file reads · ' + (reads.errors || 0) + ' failed',
      problems: bad.map((s) => s.label + ': ' + s.error),
    },
    services,
  };
}

/**
 * The whole HEALTH page in one dict.
 *
 *   system    fetchLiveSystemData() output (providers already derived), or null
 *   browser   { wallet, social, rotation, storage, reads } status snapshots
 */
export function systemHealth({ system, browser, timeline, waiting = false, now = Date.now() }) {
  const server = serverPart(system, now, waiting);
  // Job and chain ages are measured at the moment the report was written, so
  // a report that is itself 15s old does not make every job look 15s late.
  const reportedAt = (system && (system.now || system.writtenAt)) || now;
  const chains = chainsPart(system, reportedAt);
  const sources = sourcesPart(system && system.providers);
  const jobs = jobsPart(system, reportedAt);
  const archive = archivePart(system, now, timeline);
  const files = rawFilesPart(system, now);
  const web = browserPart(browser || {}, now);
  const parts = system ? [server, chains.part, sources.part, jobs.part, files.part, archive, web.part] : [server, web.part];
  const level = worst(parts.map((p) => p.level));
  const issues = parts.flatMap((p) => (p.level === 'ok' || p.level === 'unknown' ? [] :
    p.problems.map((text) => ({ part: p.label, level: p.level, text }))));
  // Hard failures first.
  issues.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  const checking = !system && waiting;
  return {
    level: checking ? 'unknown' : level,
    checking,
    title: checking ? 'Checking…' : level === 'down' ? 'Outage' : level === 'warn' ? 'Degraded' : 'All systems operational',
    summary: checking ? 'Reading the collector’s latest report.' : !issues.length ? 'Every part is doing its job.'
      : parts.filter((p) => p.level === 'down' || p.level === 'warn').map((p) => p.label).join(' · '),
    issues,
    parts,
    chains: chains.rows,
    sources: sources.groups,
    jobs: jobs.rows,
    stuckFiles: files.stuck,
    browser: web.services,
    resources: system ? {
      uptimeSeconds: system.uptimeSeconds,
      node: system.node,
      heapMb: system.memory && system.memory.heapUsedMb,
      rssMb: system.memory && system.memory.rssMb,
      cacheEntries: system.cache && system.cache.entries,
      inflight: system.cache && system.cache.inflight,
      historyPools: system.cache && system.cache.historyPools,
      observationTokens: system.cache && system.cache.observationTokens,
      holderSeries: system.cache && system.cache.holderSeries,
      walletSets: system.memory && system.memory.walletSetsSampled,
      archiveBytes: system.store && system.store.usage && system.store.usage.bytes,
      archiveRecords: system.scan && system.scan.records,
      archiveDays: system.store && system.store.usage && system.store.usage.days
        ? system.store.usage.days.map((d) => ({ day: d.day, bytes: d.bytes })) : [],
      pending: system.store && system.store.pending,
      writeLatencyMs: system.store && system.store.writeLatency && system.store.writeLatency.avg,
      reportedAgeMs: system.writtenAgeMs,
    } : null,
  };
}

/* ============================================================ ROTATION === */

/** One chain's held graph, captioned with when it was built. */
const graphOf = (entry) => (entry ? { ...entry.graph, chain: entry.chain, builtAt: entry.at, stale: entry.stale } : null);

/**
 * What rotation says about ONE pool. Null when the pool is not in a graph
 * yet, which is the honest answer before the sampling rotation reaches it.
 */
export function tokenRotation(held, poolAddress, memoryFor, { peerLimit = 12 } = {}) {
  if (!poolAddress) return null;
  let found = null;
  let entry = null;
  (held || []).forEach((e) => {
    if (found) return;
    const hit = (e.graph.nodes || []).find((n) => n.poolAddress === poolAddress);
    if (hit) { found = hit; entry = e; }
  });
  if (!found) return null;
  // Read from the node, not from graph.edges: that list is truncated for
  // display. rotationGraph() carries every pool's own peers on its node.
  const peers = found.peers || [];
  const bySize = (a, b) => b.rotatedUsd - a.rotatedUsd;
  const inAll = peers.filter((p) => p.direction === 'in' && p.rotatedUsd > 0);
  const outAll = peers.filter((p) => p.direction === 'out' && p.rotatedUsd > 0);
  const memory = memoryFor ? memoryFor(poolAddress) : null;
  return {
    chain: entry.chain,
    builtAt: entry.at,
    symbol: found.symbol,
    poolAddress,
    connections: found.connections,
    wallets: found.wallets,
    rotatedUsd: found.rotatedUsd,
    inUsd: found.inUsd,
    outUsd: found.outUsd,
    netRotationUsd: found.netRotationUsd,
    sampledAt: found.sampledAt,
    poolsCompared: Math.max(0, entry.graph.poolsSampled - 1),
    trades: found.trades,
    peers: peers.slice(0, peerLimit),
    peerCount: peers.length,
    // Sliced PER DIRECTION, and counted before slicing: one combined top-N
    // ranked by size hid whole directions. Each drawn list is largest first.
    inPeers: inAll.slice(0, peerLimit).sort(bySize),
    outPeers: outAll.slice(0, peerLimit).sort(bySize),
    inCount: inAll.length,
    outCount: outAll.length,
    // Counts that match inUsd / outUsd, as opposed to the drawn lists.
    receivedFrom: found.receivedFrom,
    sentTo: found.sentTo,
    firstTradeAt: entry.graph.firstTradeAt,
    lastTradeAt: entry.graph.lastTradeAt,
    // Cross-tick context: null until the service has watched it for a while.
    firstRotatingAt: memory && memory.firstRotatingAt,
    peakRotatedUsd: memory && memory.peakRotatedUsd,
    ticksObserved: memory && memory.ticks,
  };
}

/** One chain's graph as directed flows, largest first. */
function directedFlows(graph) {
  const flows = [];
  (graph.edges || []).forEach((e) => {
    if (e.dominantUsd > 0) flows.push({ from: e.sourcePool, to: e.targetPool, usd: e.dominantUsd, wallets: e.sharedWallets });
    if (e.counterUsd > 0) flows.push({ from: e.targetPool, to: e.sourcePool, usd: e.counterUsd, wallets: e.sharedWallets });
  });
  return flows.sort((a, b) => b.usd - a.usd);
}

/**
 * Every chain held, busiest first, as directed flows; the net gainers and
 * losers across them; and the totals - for MARKET ROTATION.
 */
export function marketRotation(held) {
  const chains = (held || [])
    .map((e) => {
      const g = graphOf(e);
      return {
        chain: e.chain, builtAt: e.at, poolsSampled: g.poolsSampled, pairsConnected: g.pairsConnected,
        rotatedUsd: g.rotatedUsd, parallelUsd: g.parallelUsd, sharedWalletCount: g.sharedWalletCount,
        pathsRotating: g.pathsRotating, firstTradeAt: g.firstTradeAt, lastTradeAt: g.lastTradeAt,
        nodes: (g.nodes || []).map((n) => ({ poolAddress: n.poolAddress, symbol: n.symbol })),
        flows: directedFlows(g),
        movers: (g.nodes || []).filter((n) => n.rotatedUsd > 0 && n.netRotationUsd !== 0)
          .map((n) => ({ chain: e.chain, poolAddress: n.poolAddress, symbol: n.symbol, net: n.netRotationUsd, inUsd: n.inUsd, outUsd: n.outUsd })),
      };
    })
    .sort((a, b) => b.rotatedUsd - a.rotatedUsd);
  const movers = chains.flatMap((c) => c.movers);
  const sum = (k) => chains.reduce((s, c) => s + (c[k] || 0), 0);
  return {
    chains: chains.map(({ movers: m, ...c }) => c),
    gainers: movers.filter((n) => n.net > 0).sort((a, b) => b.net - a.net).slice(0, 6),
    losers: movers.filter((n) => n.net < 0).sort((a, b) => a.net - b.net).slice(0, 6),
    poolsSampled: sum('poolsSampled'),
    rotatedUsd: sum('rotatedUsd'),
    parallelUsd: sum('parallelUsd'),
  };
}

/* ============================================================= WALLETS === */

/**
 * The selected token's trade sample, from one of two sources, preferred in
 * this order: the on-demand read (a fresh sample of THIS pool, the only one
 * carrying the holder list), then the background service. A read for the
 * previously selected token is neither.
 */
export function tokenWallets(sel, onDemandRead, fromStore) {
  if (!sel) return null;
  const api = onDemandRead;
  const onDemand = api && api.server === 'ok' &&
    (!sel.tokenAddress || !api.tokenAddress || api.tokenAddress === sel.tokenAddress) ? api : null;
  const source = onDemand || fromStore;
  return source && source.rows && source.rows.length ? source : null;
}

/** Each wallet tag's count over the traders (the pool contract excluded); ALL is every trader. */
export function walletGroups(source) {
  const traders = source.rows.filter((r) => !r.isPool);
  const m = { ALL: traders.length };
  traders.forEach((r) => (r.tags || []).forEach((t) => { m[t] = (m[t] || 0) + 1; }));
  return m;
}

/**
 * The traders ranked two ways, as addresses: by TURNOVER (what a bubble's
 * area encodes - a churner that moved $40k and ended flat is one of the most
 * interesting wallets, and ranking by net would drop it) and by |NET| (what
 * an arrow encodes).
 */
export function walletRanks(source) {
  const traders = source.rows.filter((r) => !r.isPool);
  return {
    byTurnover: traders.slice().sort((a, b) => b.grossUsd - a.grossUsd).map((r) => r.address),
    byNet: traders.filter((r) => Math.abs(r.netUsd) > 0)
      .sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd)).map((r) => r.address),
  };
}

/* ============================================================== THE RUN === */

/**
 * assets   the scored tokens (ungated)
 * inputs   the raw reads the board boxes take beyond the services:
 *          { selected (asset), walletRead, registry, system, storageTimeline,
 *            serverError, precisionRead, outcomes, evalOutcome, now }
 */
export function runBoardFlow(assets, inputs = {}) {
  const missing = missingIds();
  const vals = {};
  const notes = {};
  const now = inputs.now || Date.now();
  const set = (label, fn) => {
    const id = B(label);
    if (missing.has(id)) { vals[id] = null; return; }
    let x = null;
    try { x = fn(); } catch (e) { x = null; }
    if (x && x.__out) { notes[id] = x.note; x = x.value; }
    vals[id] = x === undefined ? null : x;
  };
  const val = (label) => vals[B(label)];
  const list = assets || [];
  const sel = inputs.selected || null;
  const dict = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);

  /* ---------------------------------------------------- BOARD STATS -- */
  set('TOKEN LIST', () => list.map((a) => a.sym));
  // A COUNT of the list on its wire.
  set('TOKENS TRACKED', () => (Array.isArray(val('TOKEN LIST')) ? val('TOKEN LIST').length : null));
  // How many tokens carry each call right now (flow/score-flow.js SIGNAL).
  set('SIGNAL COUNTS', () => {
    const m = {};
    list.forEach((a) => { const k = a.signal || 'NONE'; m[k] = (m[k] || 0) + 1; });
    return m;
  });
  // The board's filter chips: tokens per chain and per type, and per chain
  // the tokens each signal - and each engine's BUY - covers.
  set('BOARD COUNTS', () => {
    const inc = (m, k) => { m[k] = (m[k] || 0) + 1; };
    const chain = {}; const type = {}; const signal = {}; const engineBuys = {};
    list.forEach((a) => {
      inc(chain, a.chain);
      inc(type, a.cls);
      if (a.signal) inc(signal[a.signal] || (signal[a.signal] = {}), a.chain);
      const engines = (a.rawServerRow || {}).engines || {};
      Object.keys(engines).forEach((k) => {
        if ((engines[k] || {}).signal === 'BUY') inc(engineBuys[k] || (engineBuys[k] = {}), a.chain);
      });
    });
    return { chain, type, signal, engineBuys };
  });
  // Our own organic score only, each token weighted by how much of it resolved.
  const organicReads = list.map((a) => (a.rawServerRow || {}).organicFlow).filter((o) => o && o.score !== null);
  const ours = organicReads.filter((o) => o.basis === 'sample');
  set('AVG ORGANIC SCORE', () => {
    if (!ours.length) return null;
    const w = (o) => Math.max(o.coverage, 25);
    return Math.round(ours.reduce((s, o) => s + o.score * w(o), 0) / ours.reduce((s, o) => s + w(o), 0));
  });
  // How the sampled tokens fall across the organic grades, so one average
  // cannot hide a board that is half strong and half weak.
  set('ORGANIC GRADES', () => {
    const m = { STRONG: 0, FAIR: 0, WEAK: 0 };
    ours.forEach((o) => { m[organicGradeOf(o.score).name] += 1; });
    return out(m, { sampled: ours.length, jupiterOnly: organicReads.length - ours.length });
  });
  // One BUY on clean flow, fixed for the day: a hash of the date picks it.
  set('DAILY PICK', () => {
    const day = new Date().toISOString().slice(0, 10);
    const cands = list.filter((a) => a.signal === 'BUY' && (a.wash ?? 0) < 0.15 && a.score != null);
    pick = cands.length ? cands[hash('chepe' + day) % cands.length] : null;
    return pick ? pick.sym : null;
  });
  set('ALERT ENGINE', () => {
    const r = alertEngine(list, now);
    return out(r.columns, { invalid: r.invalid, plan: r.plan });
  });
  set('ALERTS NOW', () => {
    const d = val('ALERT ENGINE');
    return d ? Object.values(d).reduce((a, b) => a + b.length, 0) : null;
  });
  set('MARKET REGIME', () => getSetting(REGIME_SETTING, { id: REGIME_DEFAULT }).id);

  /* ------------------------------------------------------- SERVICES -- */
  const held = rotationHeld();
  set('WALLET INTEL', () => dict(walletIntelStatus()));
  set('ROTATION SERVICE', () => {
    const s = dict(rotationIntelStatus());
    // Summed across every chain held: a per-chain figure under an app-wide
    // name is how a status panel starts reporting one eighth of the truth.
    return s && { ...s, rotatedUsdHeld: held.reduce((t, e) => t + (e.graph.rotatedUsd || 0), 0) };
  });
  set('SOCIAL BASELINE', () => dict(socialIntelStatus()));
  set('SYSTEM HEALTH', () => systemHealth({
    system: inputs.system || null,
    browser: { wallet: val('WALLET INTEL'), social: val('SOCIAL BASELINE'), rotation: val('ROTATION SERVICE'),
      storage: storageStats(), reads: rawStoreStats() },
    timeline: inputs.storageTimeline || null,
    // Before the first read lands, "no report" means "not asked yet", not "down".
    waiting: !inputs.system && !inputs.serverError,
    now,
  }));
  set('SCORE EVALUATION', () => dict(inputs.evalOutcome));
  set('FORWARD RETURNS', () => dict(inputs.outcomes));
  // A share 0-1, not "43%"; the whole reading travels as the note.
  set('TOP 20 HIT RATE', () => {
    const p = precisionOf(inputs.precisionRead);
    if (!p) return null;
    const x = p.precision ?? p.value;
    return out(fin(x) ? x : null, p);
  });

  /* ----------------------------------------------- THE SELECTED TOKEN -- */
  set('THIS TOKEN', () => (sel ? sel.sym : null));
  const pool = sel ? sel.poolAddress : null;

  // WALLETS: who is in this token's trade sample.
  set('TOKEN WALLETS', () => (val('THIS TOKEN') ? tokenWallets(sel, inputs.walletRead, walletIntelForPool(pool)) : null));
  // How far the collector's first lap has got on the board, so a queued
  // pool reads as queued rather than stuck.
  set('WALLET COVERAGE', () => {
    const board = list.filter((a) => a.poolAddress);
    return { covered: board.filter((a) => walletIntelForPool(a.poolAddress)).length, pools: board.length };
  });
  const tw = () => val('TOKEN WALLETS');
  const numOrNull = (x) => (fin(x) ? x : null);
  set('ACTIVE WALLETS', () => (tw() ? numOrNull(tw().window.wallets) : null));
  set('WALLET NET FLOW', () => (tw() ? numOrNull(tw().flow.netUsd) : null));
  set('BUYER WALLETS', () => (tw() ? numOrNull(tw().flow.buyerWallets) : null));
  set('SELLER WALLETS', () => (tw() ? numOrNull(tw().flow.sellerWallets) : null));
  set('TOP WALLET SHARE', () => (tw() ? numOrNull(tw().flow.topWalletSharePct) : null));
  set('CO-ENTRY WALLETS', () => (tw() ? numOrNull(tw().counts.coEntry) : null));
  set('WALLET GROUPS', () => (tw() ? walletGroups(tw()) : null));
  set('WALLET RANKS', () => (tw() ? walletRanks(tw()) : null));
  // What the background service has learned about each trader everywhere
  // else, over every sample since it started - not just in this window.
  set('WALLET HISTORY', () => {
    if (!tw()) return null;
    const m = {};
    tw().rows.forEach((r) => {
      if (r.isPool) return;
      const p = walletProfile(r.address);
      if (!p || (p.tokensTouched <= 1 && !p.clusterHits)) return;
      m[r.address] = { tokensTouched: p.tokensTouched, clusterHits: p.clusterHits };
    });
    return m;
  });
  // Which of the user's tracked wallets turned up in THIS token.
  set('TRACKED HERE', () => {
    if (!tw()) return null;
    const byAddr = new Map(tw().rows.map((r) => [r.address.toLowerCase(), r]));
    return (inputs.registry || []).map((t) => {
      const hit = byAddr.get(String(t.address).toLowerCase()) || null;
      return { address: t.address, here: Boolean(hit), netUsd: hit ? hit.netUsd : null, buys: hit ? hit.buys : null, sells: hit ? hit.sells : null };
    });
  });
  // Co-entry clusters found on OTHER tokens, medium confidence and up, newest first.
  set('CLUSTERS ELSEWHERE', () => {
    if (!val('THIS TOKEN')) return null;
    const rank = { low: 0, medium: 1, high: 2 };
    return walletClusters().filter((c) => rank[c.confidence] >= rank.medium).slice(0, 6)
      .filter((c) => c.poolAddress !== pool);
  });

  // ROTATION: where this token's crowd is going, and its chain's picture.
  set('TOKEN ROTATION', () => (val('THIS TOKEN') ? tokenRotation(held, pool, rotationMemoryFor) : null));
  set('CHAIN ROTATION', () => {
    if (!val('THIS TOKEN')) return null;
    const chainKey = (sel.rawServerRow && sel.rawServerRow.chain) || chainNameToKey[sel.chain] || null;
    const g = graphOf(held.find((e) => e.chain === chainKey) || null);
    if (!g) return null;
    const ranked = (g.nodes || []).filter((n) => n.rotatedUsd > 0).sort((a, b) => b.netRotationUsd - a.netRotationUsd);
    return { ...g, ranked, maxNetUsd: Math.max(...ranked.map((n) => Math.abs(n.netRotationUsd)), 1) };
  });
  set('MARKET ROTATION', () => marketRotation(held));

  // SOCIAL: the selected token's numbers, from the social service's record.
  const ticker = sel ? String((sel.rawServerRow && sel.rawServerRow.symbol) || sel.sym || '').replace(/^\$/, '').toUpperCase() : '';
  const social = val('THIS TOKEN') && ticker ? socialRecordFor(ticker) : null;
  const m = social && social.mention;
  set('MENTIONS', () => (m && m.countable ? m.mentions : null));
  set('UNIQUE AUTHORS', () => (m && m.countable ? m.authors : null));
  // Anonymous posts cannot be attributed, so they are left out of the ratio.
  set('MENTIONS PER AUTHOR', () => (m && m.authors > 0 ? Math.round(((m.mentions - (m.anonPosts || 0)) / m.authors) * 100) / 100 : null));
  set('VS SOCIAL BASELINE', () => {
    if (!social) return null;
    const b = mentionBaseline(social.series, m ? m.mentions : 0);
    return out(coerce(b.vsBase, 'number'), b);
  });

  current = vals;
  currentNotes = notes;
  return vals;
}
