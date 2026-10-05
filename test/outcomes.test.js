/**
 * scoreOutcomes(), proven on controlled data.
 *
 *   npm test
 */
import assert from 'node:assert';
import { scoreOutcomes, spearman } from '../src/calculations/core.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ok  ' + name); };

// Not a multiple of the slice, so an exit never lands on another moment's entry.
const HOUR = 50 * 60000;
const SLICE = 900000;
const now = Math.floor(Date.now() / SLICE) * SLICE + 1000;

/**
 * `moments` slices, 10 tokens each. `retFor(rank, moment)` gives the % return
 * of the token ranked `rank` (0 = highest score) - so the right answer is
 * known by construction.
 */
function build(retFor, { moments = 6, tokens = 10, horizon = HOUR, gapToken = null } = {}) {
  const journal = {};
  const observations = {};
  for (let m = 0; m < moments; m += 1) {
    const t = now - horizon - (m + 1) * SLICE;
    for (let i = 0; i < tokens; i += 1) {
      const token = 't' + i;
      (journal[token] || (journal[token] = [])).push({ t, score: 90 - i * 5, stage: 'X' });
      const series = observations[token] || (observations[token] = []);
      series.push({ t, price: 100, liquidity: 1000 });
      if (token !== gapToken) series.push({ t: t + horizon, price: 100 * (1 + retFor(i, m) / 100), liquidity: 1000 });
    }
  }
  Object.values(observations).forEach((s) => s.sort((a, b) => a.t - b.t));
  return { journal, observations };
}

/* ---- spearman ---------------------------------------------------------- */
{
  assert.strictEqual(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.strictEqual(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.strictEqual(spearman([1, 1, 1], [1, 2, 3]), null);
  ok('spearman is +1 / -1 / null on ordered, reversed and flat input');
}

/* ---- a perfect ranking is EDGE --------------------------------------- */
{
  const { journal, observations } = build((rank) => 10 - rank * 2);
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now });
  assert.strictEqual(r.picks, 60);
  assert.strictEqual(r.ic.mean, 1);
  assert.strictEqual(r.verdict, 'EDGE');
  assert.ok(r.spreadPct > 0);
  assert.strictEqual(r.monotonic.ordered, r.monotonic.steps);
  ok('a ranking that orders returns perfectly: IC 1, positive spread, EDGE');
}

/* ---- the market is stripped out --------------------------------------- */
{
  // Everything rises 50%, plus the same perfect ordering. Raw returns are all
  // positive - excess must still split the board in half.
  const { journal, observations } = build((rank) => 50 + 10 - rank * 2);
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now });
  assert.strictEqual(r.board.winRate, 1);
  assert.strictEqual(r.board.hitRate, 0.5);
  assert.strictEqual(r.byRank[0].medianExcessPct, 8);
  ok('a market-wide pump makes every raw return positive but not every excess');
}

/* ---- an inverted ranking ---------------------------------------------- */
{
  const { journal, observations } = build((rank) => rank * 2 - 10);
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now });
  assert.strictEqual(r.verdict, 'INVERTED');
  assert.ok(r.spreadPct < 0);
  ok('a ranking pointing the wrong way is INVERTED');
}

/* ---- noise is not an edge --------------------------------------------- */
{
  // Alternating per moment: IC flips sign, mean is ~0.
  const { journal, observations } = build((rank, m) => (m % 2 ? 1 : -1) * (10 - rank * 2));
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now });
  assert.strictEqual(r.verdict, 'NO CLEAR EDGE');
  ok('an IC that flips every moment is NO CLEAR EDGE');
}

/* ---- gaps and immaturity ---------------------------------------------- */
{
  const { journal, observations } = build((rank) => 10 - rank, { gapToken: 't3' });
  // A mark younger than the horizon.
  journal.t0.push({ t: now - 10 * 60000, score: 99, stage: 'X' });
  // t3's nearest price after its horizon is another moment's sample 10 min
  // late; a 5-min tolerance must refuse it rather than invent an exit.
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now, toleranceMs: 5 * 60000 });
  assert.strictEqual(r.unresolved, 6);
  assert.strictEqual(r.pending, 1);
  assert.strictEqual(r.picks, 54);
  ok('a missing exit price is unresolved, a young mark is pending - neither is a return');
}

/* ---- one mark per token per slice ------------------------------------- */
{
  const { journal, observations } = build((rank) => 10 - rank, { moments: 1 });
  // Five earlier marks for t0 inside the same slice must not add picks.
  const base = journal.t0[0].t;
  for (let i = 1; i <= 5; i += 1) journal.t0.push({ t: base - i * 1000, score: 90, stage: 'X' });
  journal.t0.sort((a, b) => a.t - b.t);
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now });
  assert.strictEqual(r.picks, 10);
  ok('a token scored many times in one slice gets one seat');
}

/* ---- not enough data --------------------------------------------------- */
{
  const { journal, observations } = build((rank) => 10 - rank, { moments: 2 });
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now });
  assert.strictEqual(r.verdict, 'COLLECTING');
  ok('two moments is COLLECTING, not a verdict');
}

/* ---- warning flags compare losers with winners ------------------------- */
{
  const { journal, observations } = build((rank) => 10 - rank * 2);
  // 'bad' rides on the bottom half (the losers), 'common' on everyone.
  Object.keys(journal).forEach((token) => {
    const rank = Number(token.slice(1));
    journal[token].forEach((m) => { m.flags = rank >= 5 ? ['bad', 'common'] : ['common']; });
  });
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now });
  const bad = r.flags.find((f) => f.code === 'bad');
  const common = r.flags.find((f) => f.code === 'common');
  assert.strictEqual(r.flags[0].code, 'bad');
  assert.strictEqual(bad.lossShare, 1);
  assert.strictEqual(bad.winShare, 0);
  assert.strictEqual(common.gap, 0);
  assert.strictEqual(bad.picks, 30);
  ok('a flag on every loser and no winner tops the list; a flag on everyone warns of nothing');
}

/* ---- one IC per moment, oldest first ----------------------------------- */
{
  const { journal, observations } = build((rank) => 10 - rank * 2);
  const r = scoreOutcomes(observations, journal, { horizonMs: HOUR, now });
  assert.strictEqual(r.icSeries.length, 6);
  assert.ok(r.icSeries.every((p, i) => i === 0 || p.t > r.icSeries[i - 1].t));
  assert.ok(r.icSeries.every((p) => p.ic === 1 && p.n === 10));
  ok('the per-moment IC series has one point per moment, oldest first');
}

console.log('\n' + pass + ' passed');
