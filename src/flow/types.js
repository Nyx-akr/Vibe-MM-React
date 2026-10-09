/**
 * THE WIRE TYPES - what any wire on the DATA FLOW carries. Five, like Max/MSP:
 * a box's name says what the value MEANS; the wire only knows what it IS.
 *
 *   number  an int or a float           FINAL, RAW, LIQUIDITY, a weight
 *   bool    0 or 1 (true / false)       a gate's pass, VETO LOG, an IF
 *   text    a word or a string          STAGE, MARKET REGIME, a symbol
 *   list    an ordered list of values   a history, risk flags, the token list
 *   dict    a keyed record              a raw file, a service's state
 *
 * Anything a panel needs beyond the value (an evidence line, a flag's
 * description) travels BESIDE the wire as the box's note, never on it.
 */

export const WIRE_TYPES = {
  number: { color: '#60a5fa', name: 'number' },
  bool: { color: '#f87171', name: 'bool (0 / 1)' },
  text: { color: '#c084fc', name: 'text' },
  list: { color: '#22d3ee', name: 'list' },
  dict: { color: '#94a3b8', name: 'dict' },
};

/** The wire type of a value, or null when nothing is on the wire. */
export const typeOfValue = (x) => {
  if (x === null || x === undefined) return null;
  if (typeof x === 'boolean') return 'bool';
  if (typeof x === 'number') return Number.isFinite(x) ? 'number' : null;
  if (typeof x === 'string') return 'text';
  if (Array.isArray(x)) return 'list';
  return 'dict';
};

/**
 * How a value reads on a dot - the value only, no words: a number as is, a
 * bool as 1 / 0, a list as how many values it holds, a dict as how many keys.
 * The dot's colour says which type it is.
 */
export const showValue = (x) => {
  const t = typeOfValue(x);
  if (t === 'bool') return x ? '1' : '0';
  if (t === 'number') return String(Math.round(x * 1000) / 1000);
  if (t === 'list') return String(x.length);
  if (t === 'dict') return String(Object.keys(x).length);
  return t ? String(x) : null;
};
/** The same, said in words - for a hover. */
export const describeValue = (x) => {
  const t = typeOfValue(x);
  if (t === 'list') return x.length + ' values';
  if (t === 'dict') return Object.keys(x).length + ' keys';
  return showValue(x);
};

/**
 * A value arriving at a dot that expects another type, converted the one
 * standard way (as Max/MSP does). A wire always connects; this is what the
 * box behind the dot then receives.
 *
 *   arriving   at a number      at a bool        at a text
 *   list       its length       1 if not empty   the items joined
 *   bool       1 / 0            as is            '1' / '0'
 *   text       the number in it 1 if not empty   as is
 *   dict       how many keys    1 if not empty   its keys
 *
 * What a dot SHOWS is what passes: a list shows its length and passes it
 * as a number, a dict shows its key count and passes that.
 */
export function coerce(x, to) {
  const t = typeOfValue(x);
  if (!t || !to || t === to) return t ? x : null;
  if (to === 'number') {
    if (t === 'list') return x.length;
    if (t === 'bool') return x ? 1 : 0;
    if (t === 'text') { const n = parseFloat(String(x).replace(/[^0-9.eE+\-]/g, '')); return Number.isFinite(n) ? n : null; }
    return Object.keys(x).length;
  }
  if (to === 'bool') {
    if (t === 'number') return x !== 0;
    if (t === 'list') return x.length > 0;
    if (t === 'text') return x.length > 0;
    return Object.keys(x).length > 0;
  }
  if (to === 'text') {
    if (t === 'bool') return x ? '1' : '0';
    if (t === 'number') return String(x);
    if (t === 'list') return x.map(String).join(' ');
    return Object.keys(x).join(' ');
  }
  if (to === 'list') return t === 'dict' ? Object.values(x) : [x];
  return null;
}
