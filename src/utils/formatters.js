import { chainColors } from '../data/chains';

export function fmtUsd(v) { const a = Math.abs(v); const s = v < 0 ? '-' : ''; if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1) + 'K'; return s + '$' + a.toFixed(0); }
export function fmtAge(s) { if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return (s / 3600).toFixed(1) + 'h'; return Math.round(s / 86400) + 'd'; }
export function fmtPrice(p) { return p >= 100 ? '$' + p.toFixed(2) : p >= 1 ? '$' + p.toFixed(3) : p >= 0.01 ? '$' + p.toFixed(4) : '$' + p.toFixed(p < 0.0001 ? 7 : 6); }
/**
 * The four stages, one clearly separate hue each: grey, blue, pink, amber -
 * the app's own #4d8dff and #f06ee2 for the two that matter most.
 *
 * All four hues have to stay distinct, not just the pair you are looking at.
 * EMERGING and CONFIRMED were once two shades of the same blue; moving
 * CONFIRMED to pink would have collided with EXCEPTIONAL instead, so
 * EXCEPTIONAL takes amber - which also reads as the top of a ramp.
 */
export function stageInfo(st) { return [null, { n: 'WATCH', bg: '#1a2440', fg: '#a3aed0' }, { n: 'EMERGING', bg: '#0e2a5c', fg: '#4d8dff' }, { n: 'CONFIRMED', bg: '#3a1140', fg: '#f06ee2' }, { n: 'EXCEPTIONAL', bg: '#3a2c0f', fg: '#ffc65e' }][st]; }
export function chainColor(c) { return chainColors[c] || '#a3aed0'; }
export function clsColor(c) { return { MEME: '#e35ff2', TOKEN: '#a3aed0', STOCK: '#4fc3f7', ETF: '#8fd3ff' }[c]; }
/**
 * The main page's call (calculations/phase.js SIGNALS): colour, background,
 * and the sort rank - BUY first, then the exits, then the rest.
 */
export const SIGNAL_INFO = {
  BUY: { fg: '#3ddc97', bg: 'rgba(61,220,151,0.14)', rank: 5, text: 'Waking up and not run yet - the entry zone' },
  SHORT: { fg: '#b06bff', bg: 'rgba(176,107,255,0.16)', rank: 4, text: 'Peaking, and a perp venue lists it. Not yet proven by the grading - see Evaluation' },
  SELL: { fg: '#ff4d5e', bg: 'rgba(255,77,94,0.14)', rank: 3, text: 'Peaking - take profit, do not chase' },
  WATCH: { fg: '#8b96b8', bg: 'rgba(139,150,184,0.10)', rank: 2, text: 'No call yet' },
  AVOID: { fg: '#6b7699', bg: 'rgba(107,118,153,0.10)', rank: 1, text: 'The burst is over' },
};
export function signalInfo(sig) { return SIGNAL_INFO[sig] || { fg: '#3a4568', bg: 'transparent', rank: 0, text: 'Not enough history for a call yet' }; }
/** The attention cycle, in order, each with the colour of what it usually calls for. */
export const PHASE_ORDER = ['QUIET', 'WAKING', 'RUNNING', 'PEAKING', 'FADING'];
export function phaseColor(p) { return { QUIET: '#6b7699', WAKING: '#3ddc97', RUNNING: '#ffc65e', PEAKING: '#ff4d5e', FADING: '#8b5a6b' }[p] || '#3a4568'; }
export function scoreColor(s) { return s >= 90 ? '#f06ee2' : s >= 80 ? '#4d8dff' : s >= 68 ? '#6ea0ff' : '#a3aed0'; }
export function washColor(wp) { return wp >= 0.3 ? '#ff4fae' : wp >= 0.15 ? '#e35ff2' : '#6b7699'; }

/** Colour for values the server could not supply — greyed out, never invented. */
export const UNAVAILABLE = '#3a4568';
/** True when the server gave us nothing usable for a field. */
export const isMissing = (v) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
/** Formats a real number, or a grey em dash when the value is missing. */
export function fmtOr(v, format) { return isMissing(v) ? '—' : format(v); }
export function fmtPct(v, digits = 1) { return isMissing(v) ? '—' : v.toFixed(digits) + '%'; }
export function fmtNum(v) { return isMissing(v) ? '—' : v.toLocaleString('en-US'); }
