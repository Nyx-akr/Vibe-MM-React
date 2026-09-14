import { chainColors } from '../data/chains';

export function fmtUsd(v) { const a = Math.abs(v); const s = v < 0 ? '-' : ''; if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1) + 'K'; return s + '$' + a.toFixed(0); }
export function fmtAge(s) { if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return (s / 3600).toFixed(1) + 'h'; return Math.round(s / 86400) + 'd'; }
export function fmtPrice(p) { return p >= 100 ? '$' + p.toFixed(2) : p >= 1 ? '$' + p.toFixed(3) : p >= 0.01 ? '$' + p.toFixed(4) : '$' + p.toFixed(p < 0.0001 ? 7 : 6); }
export function stageInfo(st) { return [null, { n: 'WATCH', bg: '#1a2440', fg: '#a3aed0' }, { n: 'EMERGING', bg: '#101f42', fg: '#6ea0ff' }, { n: 'CONFIRMED', bg: '#0e2a5c', fg: '#4d8dff' }, { n: 'EXCEPTIONAL', bg: '#3a1140', fg: '#f06ee2' }][st]; }
export function chainColor(c) { return chainColors[c] || '#a3aed0'; }
export function clsColor(c) { return { MEME: '#e35ff2', TOKEN: '#a3aed0', STOCK: '#4fc3f7', ETF: '#8fd3ff' }[c]; }
export function scoreColor(s) { return s >= 90 ? '#f06ee2' : s >= 80 ? '#4d8dff' : s >= 68 ? '#6ea0ff' : '#a3aed0'; }
export function washColor(wp) { return wp >= 0.3 ? '#ff4fae' : wp >= 0.15 ? '#e35ff2' : '#6b7699'; }
