/**
 * The wire types and their conversion - the one standard every wire on the
 * DATA FLOW uses (src/flow/types.js).
 *
 *   npm test
 *
 * What a dot SHOWS is what passes: a list shows its length and passes it as
 * a number, a dict shows its key count and passes that, a bool is 1 / 0.
 */
import assert from 'node:assert';
import { typeOfValue, showValue, coerce } from '../src/flow/types.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ok  ' + name); };

const samples = { number: 77, bool: true, text: 'CONFIRMED', list: [4, 3, 0], dict: { EMERGING: 73, CONFIRMED: 44, EXCEPTIONAL: 7 } };

// Every value is exactly one of the five types.
Object.entries(samples).forEach(([t, x]) => assert.strictEqual(typeOfValue(x), t));
assert.strictEqual(typeOfValue(null), null);
assert.strictEqual(typeOfValue(NaN), null);
ok('every value is one of number, bool, text, list, dict');

// A dot shows the value only, no words.
assert.strictEqual(showValue(77), '77');
assert.strictEqual(showValue(true), '1');
assert.strictEqual(showValue(false), '0');
assert.strictEqual(showValue([1, 2, 3]), '3');
assert.strictEqual(showValue(samples.dict), '3');
assert.strictEqual(showValue('CONFIRMED'), 'CONFIRMED');
ok('a dot shows the value only: a list its length, a dict its key count');

// What a dot shows is what passes into a number.
Object.values(samples).forEach((x) => {
  if (typeof x === 'string') return;
  assert.strictEqual(String(coerce(x, 'number')), showValue(x));
});
ok('what a dot shows is what passes into a number dot');

// The whole table.
assert.strictEqual(coerce([1, 2, 3], 'number'), 3);
assert.strictEqual(coerce(samples.dict, 'number'), 3);
assert.strictEqual(coerce(true, 'number'), 1);
assert.strictEqual(coerce('124 tokens', 'number'), 124);
assert.strictEqual(coerce('CONFIRMED', 'number'), null);
assert.strictEqual(coerce(0, 'bool'), false);
assert.strictEqual(coerce([], 'bool'), false);
assert.strictEqual(coerce('x', 'bool'), true);
assert.strictEqual(coerce(77, 'text'), '77');
assert.strictEqual(coerce(true, 'text'), '1');
assert.deepStrictEqual(coerce(samples.dict, 'list'), [73, 44, 7]);
assert.deepStrictEqual(coerce(5, 'list'), [5]);
// Same type passes untouched; nothing stays nothing.
Object.entries(samples).forEach(([t, x]) => assert.strictEqual(coerce(x, t), x));
Object.keys(samples).forEach((t) => assert.strictEqual(coerce(null, t), null));
ok('every type converts into every other the one standard way');

console.log('\n' + pass + ' passed');
