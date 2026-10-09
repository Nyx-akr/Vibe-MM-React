/**
 * Settings a user changes ON a box - a parameter, a weight, a filter.
 *
 * A box declares a setting with a default, the box draws a control for it,
 * and every box downstream reads the current value - so changing it changes
 * the numbers that flow on. Settings belong to the ACTIVE FLOW (flow-store.js):
 * saved in a user's flow file, a preview only on DEFAULT. Clearing one puts
 * the box back on the app's own default.
 */

import { activeFlow, updateFlow, subscribeFlows } from './flow-store';

const settingsOf = () => activeFlow().settings || {};

/** The current setting for a box, or its default. */
export function getSetting(id, fallback) {
  const s = settingsOf()[id];
  return s ? { ...fallback, ...s } : { ...fallback };
}

/** Change a box's setting; every subscriber re-renders. */
export function setSetting(id, value) {
  updateFlow((doc) => ({ settings: { ...(doc.settings || {}), [id]: value } }));
}

/** Back to the default. */
export function clearSetting(id) {
  updateFlow((doc) => {
    const next = { ...(doc.settings || {}) };
    delete next[id];
    return { settings: next };
  });
}

/** Re-render on any flow change: a setting, or a switch to another flow. */
export const subscribeSettings = subscribeFlows;

/**
 * The FILTER box's rule: from a list of numbers keep the highest N, the
 * lowest N, or the N around the middle (the median). Returns them sorted
 * high to low.
 */
export function applyFilter(values, setting) {
  const sorted = (values || []).filter(Number.isFinite).slice().sort((a, b) => b - a);
  const n = Math.max(0, Math.min(sorted.length, Math.floor(Number(setting && setting.n) || 0)));
  if (!n) return [];
  if (setting.mode === 'bottom') return sorted.slice(sorted.length - n);
  if (setting.mode === 'mid') {
    const start = Math.max(0, Math.floor((sorted.length - n) / 2));
    return sorted.slice(start, start + n);
  }
  return sorted.slice(0, n);
}

/**
 * A filter's setting: its MODE (kept under its id) and its COUNT (kept under
 * id + ':n', because the count is set with the standard number input, which
 * stores a plain { n }).
 */
export function filterSetting(id, defaults) {
  return { mode: getSetting(id, { mode: defaults.mode }).mode, n: getSetting(id + ':n', { n: defaults.n }).n };
}

export const FILTER_MODES = [
  { id: 'top', label: 'HIGHEST' },
  { id: 'mid', label: 'MIDDLE' },
  { id: 'bottom', label: 'LOWEST' },
];
