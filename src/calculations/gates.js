/**
 * The hard gates. A token must pass every one before its score counts: a
 * token that fails any gate is VETOED and its score is 0, however well it
 * trades. These are the listing spec's gates ("will this team deposit supply,
 * and will traders trade the perp") applied to the board.
 *
 * Every gate answers one of three ways:
 *   ok: true   passed
 *   ok: false  VETO - the reason is in `detail`
 *   null       not checked yet (no data for it)
 * Not checked is never a veto - otherwise a token the intel collector has not
 * reached would be vetoed for being new rather than for being bad.
 *
 * Thresholds are starting values to tune. The qualifier flow
 * (flow/nodes.js RULES.gates) reads this same table, so tuning one tunes both.
 */

export const GATE_RULES = {
  maxTaxPct: 5,
  minLiquidityUsd: 50000,
  minVolume24hUsd: 25000,
  minAgeHours: 24 * 14,
  majorMarketCapUsd: 1e9,
  // Organic flow under this = the volume is mostly the same wallets trading
  // with themselves.
  minOrganicFlow: 40,
};

import { gateRules } from '../flow/params.js';

const fin = Number.isFinite;

const usd = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
};

/** got ≥ want, written as the comparison it is. */
const atLeast = (got, want, show) => (fin(got)
  ? { ok: got >= want, detail: show(got) + ' ≥ ' + show(want) + ' ? ' + (got >= want ? 'yes' : 'no') }
  : null);

const checkOf = (intel, re) => {
  const cs = intel && intel.contractSafety;
  if (!cs || !cs.available) return null;
  const c = (cs.checks || []).find((x) => re.test(x.label || ''));
  return c ? { ok: Boolean(c.ok), detail: c.detail || c.label } : null;
};

/** The gates, in the order they are drawn and logged. */
/** The rules in force: the flow's PARAMETERS boxes, else the defaults above. */
const R = () => gateRules(GATE_RULES);

export const GATES = [
  { key: 'sellable', label: 'SELLABLE',
    test: (row, x) => checkOf(x.intel, /honeypot|sell/i) },
  { key: 'tax', label: 'TAX IN RANGE',
    test: (row, x) => checkOf(x.intel, /tax/i) },
  { key: 'major', label: 'NOT A MAJOR',
    test: (row) => (fin(row.marketCapUsd)
      ? { ok: row.marketCapUsd < R().majorMarketCapUsd,
          detail: usd(row.marketCapUsd) + ' < ' + usd(R().majorMarketCapUsd) + ' ? ' +
            (row.marketCapUsd < R().majorMarketCapUsd ? 'yes' : 'no') }
      : null) },
  // screenRows() already drops stables, wrapped natives and majors, so every
  // row that reaches scoring has passed this one.
  { key: 'ticker', label: 'REAL TICKER',
    test: (row) => ({ ok: true, detail: (row.symbol || '?') + ' is not on the stable / wrapped / major list' }) },
  { key: 'age', label: 'AGE FLOOR',
    test: (row) => atLeast(row.poolAgeHours, R().minAgeHours, (h) => (Math.round(h / 2.4) / 10) + ' days') },
  { key: 'liquidity', label: 'LIQUIDITY FLOOR',
    test: (row) => atLeast(row.liquidityUsd, R().minLiquidityUsd, usd) },
  { key: 'volume', label: 'VOLUME FLOOR',
    test: (row) => atLeast(row.volume24hUsd, R().minVolume24hUsd, usd) },
  { key: 'wash', label: 'NOT WASH-FLAGGED',
    test: (row, x) => (fin(x.organicFlow)
      ? { ok: x.organicFlow >= R().minOrganicFlow,
          detail: 'organic ' + x.organicFlow + ' ≥ ' + R().minOrganicFlow + ' ? ' +
            (x.organicFlow >= R().minOrganicFlow ? 'yes' : 'no') }
      : null) },
];

/**
 * Every gate's verdict for one row. `extras` = { intel, organicFlow }.
 * Returns { checks: [{key, label, ok, detail}], vetoed, vetoes, unchecked }.
 */
export function evaluateGates(row, extras) {
  const x = extras || {};
  const checks = GATES.map((g) => {
    let r = null;
    try { r = g.test(row || {}, x); } catch (e) { r = null; }
    return { key: g.key, label: g.label, ok: r ? r.ok : null, detail: r ? r.detail : 'not checked yet' };
  });
  const vetoes = checks.filter((c) => c.ok === false);
  return {
    checks,
    vetoed: vetoes.length > 0,
    vetoes,
    unchecked: checks.filter((c) => c.ok === null).map((c) => c.label),
  };
}
