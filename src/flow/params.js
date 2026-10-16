/**
 * THE FLOW'S PARAMETERS, read by the model.
 *
 * A weight or a threshold changed on the DATA FLOW map is a setting in the
 * active flow (admin/flow-store.js). The model reads them from here, so the
 * number on every tab is the flow's number - not a copy with its own
 * constants.
 *
 * The ids are the boxes' own (admin/pipeline.js), and each falls back to the
 * model's default (flow/score-flow.js), which is what DEFAULT shows. On
 * DEFAULT a change is a preview in that one tab; on a user flow it is saved
 * and every tab of the app picks it up.
 */

import { activeFlow } from '../admin/flow-store';

const setting = (id) => {
  let s = null;
  try { s = (activeFlow().settings || {})[id]; } catch (e) { s = null; }
  return s && Number.isFinite(s.n) ? s.n : null;
};

/** An input's weight in EARLY RAW: its WEIGHT · <input> box, else the model's. */
export const weightOf = (c) => { const n = setting('param:weight:' + c.key); return n === null ? c.weight : n; };

/** Every key of `defaults` overridden by its box `param:<prefix><key>` when set. */
function rules(prefix, defaults) {
  const out = { ...defaults };
  Object.keys(defaults).forEach((k) => { const n = setting('param:' + prefix + k); if (n !== null) out[k] = n; });
  return out;
}

/** The safety gates' threshold: MIN LIQUIDITY ($). */
export const safetyRules = (defaults) => rules('', defaults);
/** PHASE & SIGNAL thresholds: param:phase.<key>. */
export const phaseRules = (defaults) => rules('phase.', defaults);
/** The TRADE PLAN's target, stop and horizon: param:plan.<key>. */
export const planRules = (defaults) => rules('plan.', defaults);
/** One plan setting, or null when the flow has not set it (score-flow.js tradePlanRules). */
export const planSetting = (key) => setting('param:plan.' + key);
/** Each engine's BUY / HOLD lines and the late-entry cap: param:engine.<key>. */
export const engineRules = (defaults) => rules('engine.', defaults);

/**
 * The engine whose call becomes SIGNAL: the active profile's (flow-store.js
 * ENGINE_PROFILES), else QUALITY ROTATION (score-flow.js DEFAULT_ENGINE) - on
 * DEFAULT and on a user flow that never picked one.
 */
export const activeEngine = () => {
  let e = null;
  try { e = activeFlow().engine; } catch (err) { e = null; }
  return typeof e === 'string' && e ? e : 'quality';
};
