/**
 * Precision@K, proven on controlled data.
 *
 *   npm test
 *
 * The live archive cannot prove this yet: a 24h outcome needs a score mark
 * that is 24h old AND a price 24h after it, and the server has not run a
 * continuous 24h. So the maths is pinned here with data whose right answer is
 * known by construction, and the tile is left to report honestly until real
 * history catches up.
 */
import assert from 'node:assert';
import { precisionAtK } from '../src/calculations/core.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ok  ' + name); };

const HOUR = 3600000;
const DAY = 86400000;
const now = Date.now();

/** A price series that starts at `from` and ends at `to` over the horizon. */
function series(markAt, from, to) {
  return [
    { t: markAt, price: from, liquidity: 100000 },
    { t: markAt + DAY, price: to, liquidity: 100000 },
  ];
}

/* ---- a clean case with a known answer -------------------------------- */
{
  // Six tokens marked 30h ago (so they have matured), three rose, three fell.
  const markAt = now - 30 * HOUR;
  const journal = {};
  const observations = {};
  ['a', 'b', 'c', 'd', 'e', 'f'].forEach((token, i) => {
    journal[token] = [{ t: markAt, score: 90 - i, stage: 'CONFIRMED', flags: [] }];
    observations[token] = series(markAt, 100, i < 3 ? 120 : 80);
  });

  const r = precisionAtK(observations, journal, { k: 20, horizonMs: DAY, windowMs: 48 * HOUR });
  assert.strictEqual(r.evaluated, 6, 'all six resolved');
  assert.strictEqual(r.wins, 3, 'three rose');
  assert.strictEqual(r.precision, 0.5, 'precision is wins/evaluated');
  ok('precision is wins over resolved picks (3 of 6 = 0.50)');
}

/* ---- K actually truncates -------------------------------------------- */
{
  // Ten tokens: the top three by score fell, the rest rose. With K=3 the
  // answer must be 0.00 - if K were ignored it would be 0.70.
  const markAt = now - 30 * HOUR;
  const journal = {};
  const observations = {};
  for (let i = 0; i < 10; i += 1) {
    const token = 't' + i;
    journal[token] = [{ t: markAt, score: 100 - i, stage: 'WATCH', flags: [] }];
    observations[token] = series(markAt, 100, i < 3 ? 80 : 120);
  }

  const top3 = precisionAtK(observations, journal, { k: 3, horizonMs: DAY, windowMs: 48 * HOUR });
  assert.strictEqual(top3.evaluated, 3, 'only K picks counted');
  assert.strictEqual(top3.precision, 0, 'the three highest-scored all fell');

  const all10 = precisionAtK(observations, journal, { k: 10, horizonMs: DAY, windowMs: 48 * HOUR });
  assert.strictEqual(all10.precision, 0.7, 'and 7 of 10 rose overall');
  ok('K truncates by SCORE RANK, not arrival order (0.00 at K=3 vs 0.70 at K=10)');
}

/* ---- unmatured marks are pending, never losses ------------------------ */
{
  // Marked one hour ago: no 24h outcome can exist yet.
  const markAt = now - HOUR;
  const journal = { a: [{ t: markAt, score: 90, stage: 'CONFIRMED', flags: [] }] };
  const observations = { a: series(markAt, 100, 120) };

  const r = precisionAtK(observations, journal, { k: 20, horizonMs: DAY, windowMs: DAY });
  assert.strictEqual(r.pending, 1, 'counted as pending');
  assert.strictEqual(r.evaluated, 0, 'not counted as evaluated');
  assert.strictEqual(r.precision, null, 'and no precision is claimed');
  ok('a mark younger than the horizon is PENDING, not a loss');
}

/* ---- a missing forward price is unresolved, never a loss -------------- */
{
  const markAt = now - 30 * HOUR;
  const journal = { a: [{ t: markAt, score: 90, stage: 'CONFIRMED', flags: [] }] };
  // Price at the mark, but nothing a day later.
  const observations = { a: [{ t: markAt, price: 100 }] };

  const r = precisionAtK(observations, journal, { k: 20, horizonMs: DAY, windowMs: 48 * HOUR });
  assert.strictEqual(r.unresolved, 1, 'counted as unresolved');
  assert.strictEqual(r.evaluated, 0, 'not silently scored as a loss');
  assert.strictEqual(r.precision, null);
  ok('a gap in the price series is UNRESOLVED, not a loss (this is what downtime looks like)');
}

/* ---- one token cannot take two seats in one slice --------------------- */
{
  // Pinned one minute into a 15min slice. Taken straight off `now`, the three
  // marks straddled a slice boundary whenever the suite ran in the last two
  // minutes of a slice, and the test failed ~13% of the time.
  const markAt = Math.floor((now - 30 * HOUR) / 900000) * 900000 + 60000;
  // The same token marked three times inside one slice, as a 60s journal gap
  // against a 15min slice naturally produces.
  const journal = {
    a: [
      { t: markAt, score: 90, stage: 'CONFIRMED', flags: [] },
      { t: markAt + 60000, score: 91, stage: 'CONFIRMED', flags: [] },
      { t: markAt + 120000, score: 92, stage: 'CONFIRMED', flags: [] },
    ],
  };
  // The LATEST mark in the slice is the one kept, so its horizon lands two
  // minutes later than the first mark's - the price series has to reach that
  // far or the pick resolves to nothing.
  const observations = {
    a: [
      { t: markAt, price: 100 },
      { t: markAt + 3 * 60000, price: 100 },
      { t: markAt + DAY, price: 120 },
      { t: markAt + DAY + 3 * 60000, price: 120 },
    ],
  };

  const r = precisionAtK(observations, journal, { k: 20, horizonMs: DAY, windowMs: 48 * HOUR, sliceMs: 900000 });
  assert.strictEqual(r.evaluated, 1, 'one token, one seat');
  assert.strictEqual(r.wins, 1, 'and it is scored once');
  ok('a token polled repeatedly inside a slice is counted ONCE, not three times');
}

/* ---- an outage must not be read as a price move ----------------------- */
{
  // Scored, then the server went down for eight hours. The next price we have
  // is from long after the mark. Using it as the entry price would invent a
  // return out of the outage, so the pick must be unresolved instead.
  const markAt = now - 30 * HOUR;
  const journal = { a: [{ t: markAt, score: 90, stage: 'CONFIRMED', flags: [] }] };
  const observations = {
    a: [
      { t: markAt - 60000, price: 100 },
      { t: markAt + 8 * HOUR, price: 300 },
      { t: markAt + DAY, price: 310 },
    ],
  };

  const r = precisionAtK(observations, journal, { k: 20, horizonMs: DAY, windowMs: 48 * HOUR });
  assert.strictEqual(r.evaluated, 0, 'not scored off a price 8h from the mark');
  assert.strictEqual(r.unresolved, 1, 'reported as unresolved');
  ok('a gap wider than the tolerance is UNRESOLVED, not a 200% win');

  // The same data inside the tolerance does resolve, so the guard is a bound
  // and not a blanket refusal.
  const tight = {
    a: [
      { t: markAt + 60000, price: 100 },
      { t: markAt + DAY + 60000, price: 120 },
    ],
  };
  const r2 = precisionAtK(tight, journal, { k: 20, horizonMs: DAY, windowMs: 48 * HOUR });
  assert.strictEqual(r2.evaluated, 1, 'a sample one minute out is fine');
  assert.strictEqual(r2.wins, 1);
  ok('a sample within the tolerance still resolves normally');
}

/* ---- the window bound is honoured ------------------------------------- */
{
  const journal = {
    recent: [{ t: now - 30 * HOUR, score: 90, stage: 'WATCH', flags: [] }],
    ancient: [{ t: now - 200 * HOUR, score: 95, stage: 'WATCH', flags: [] }],
  };
  const observations = {
    recent: series(now - 30 * HOUR, 100, 120),
    ancient: series(now - 200 * HOUR, 100, 120),
  };

  const r = precisionAtK(observations, journal, { k: 20, horizonMs: DAY, windowMs: 48 * HOUR });
  assert.strictEqual(r.evaluated, 1, 'only the mark inside the window');
  ok('marks older than the window are excluded');
}

/* ---- window == horizon must still be measurable ----------------------- */
{
  // THE REGRESSION. The tile calls this with windowMs === horizonMs === 24h.
  // When the mark window ran to `now`, every mark inside it was younger than
  // the horizon, so everything was pending and the precision was null forever
  // - the tile could never show a number no matter how much data arrived.
  // The window must end one horizon back, so 24h/24h looks at marks aged
  // 24-48h and resolves them normally.
  const markAt = now - 30 * HOUR;
  const journal = {};
  const observations = {};
  ['a', 'b', 'c', 'd'].forEach((token, i) => {
    journal[token] = [{ t: markAt, score: 90 - i, stage: 'CONFIRMED', flags: [] }];
    observations[token] = series(markAt, 100, i < 3 ? 120 : 80);
  });
  // Plus a fresh mark, which should be pending rather than breaking anything.
  journal.fresh = [{ t: now - HOUR, score: 99, stage: 'CONFIRMED', flags: [] }];
  observations.fresh = series(now - HOUR, 100, 120);

  const r = precisionAtK(observations, journal, { k: 20, horizonMs: DAY, windowMs: DAY });
  assert.strictEqual(r.evaluated, 4, 'the matured marks resolved');
  assert.strictEqual(r.precision, 0.75, '3 of 4 rose');
  assert.strictEqual(r.pending, 1, 'the fresh mark is pending, not counted');
  // Slack, because precisionAtK reads its own clock a few ms after this file
  // captured `now`.
  assert.ok(Math.abs(r.markWindow.until - (now - DAY)) < 5000,
    'the mark window ends one horizon back');
  ok('windowMs === horizonMs still resolves (the bug that made the tile permanently blank)');
}

/* ---- coverage is NOT folded into the number --------------------------- */
{
  // Same picks, same outcomes. Whatever the uptime was, the precision of THIS
  // sample is 0.50 - the caller qualifies it, the maths never discounts it.
  const markAt = now - 30 * HOUR;
  const journal = {};
  const observations = {};
  ['a', 'b', 'c', 'd'].forEach((token, i) => {
    journal[token] = [{ t: markAt, score: 90 - i, stage: 'WATCH', flags: [] }];
    observations[token] = series(markAt, 100, i < 2 ? 120 : 80);
  });
  const r = precisionAtK(observations, journal, { k: 20, horizonMs: DAY, windowMs: 48 * HOUR });
  assert.strictEqual(r.precision, 0.5);
  assert.strictEqual('coverage' in r, false, 'the result carries no coverage field to multiply by');
  ok('precision is never scaled by uptime - coverage travels beside it, not inside it');
}

console.log('\n' + pass + ' passed');
