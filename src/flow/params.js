/**
 * THE FLOW'S PARAMETERS, read by the real score.
 *
 * A weight, a gate threshold or the score's MEAN window changed on the DATA
 * FLOW map is a setting in the active flow (admin/flow-store.js). The score
 * reads them from here, so the number in the navbar and on every tab is the
 * flow's number - not a copy with its own constants.
 *
 * The ids are the boxes' own (admin/pipeline.js paramId / weightId / the
 * RIGHT NOW mean's window), and each falls back to the code default, which is
 * what DEFAULT shows. On DEFAULT a change is a preview in that one tab; on a
 * user flow it is saved and every tab of the app picks it up.
 */

import { activeFlow } from '../admin/flow-store';

const setting = (id) => {
  let s = null;
  try { s = (activeFlow().settings || {})[id]; } catch (e) { s = null; }
  return s && Number.isFinite(s.n) ? s.n : null;
};

/** A component's weight in RAW: the WEIGHT · <component> box, else the model's. */
export const weightOf = (c) => { const n = setting('param:weight:' + c.key); return n === null ? c.weight : n; };

/** The gate thresholds: the PARAMETERS boxes, else gates.js GATE_RULES. */
export function gateRules(defaults) {
  const days = setting('param:minAgeDays');
  const pick = (key, def) => { const n = setting('param:' + key); return n === null ? def : n; };
  return {
    ...defaults,
    minAgeHours: days === null ? defaults.minAgeHours : days * 24,
    minLiquidityUsd: pick('minLiquidity', defaults.minLiquidityUsd),
    minVolume24hUsd: pick('minVolume24h', defaults.minVolume24hUsd),
    maxTaxPct: pick('maxTax', defaults.maxTaxPct),
    majorMarketCapUsd: pick('majorCap', defaults.majorMarketCapUsd),
    minOrganicFlow: pick('minOrganic', defaults.minOrganicFlow),
  };
}

/** The settled score's window: the RIGHT NOW, 15 MIN MEAN box, in ms. */
export const scoreWindowMs = (defMs) => {
  const n = setting('f:pipe:RIGHT NOW, 15 MIN MEAN:window');
  return n === null ? defMs : n * 60000;
};
