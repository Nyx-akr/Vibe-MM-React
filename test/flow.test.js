/**
 * THE MODEL (src/flow/score-flow.js), run the way the app runs it.
 *
 *   npm test
 *
 * Every assertion goes through flowScore() - the function the board, the
 * detail page, the alerts and the backtest all call - so what is pinned here
 * is the call a user sees: the phase, the signal, EARLY, the safety gates,
 * the trade plan, and the map's edits being obeyed.
 */
import assert from 'node:assert';
import {
  flowScore, runScoreFlow, connectFlow, band, PHASE_RULES, PLAN_RULES, SAFETY_RULES, EARLY_CURVES, resetSignalMemory, ENGINES, ENGINE_RULES, tradePlanRules, TIME_FRAMES, DEFAULT_HOLD_HOURS, roundTripCostPct, DEFAULT_TRADE_USD,
} from '../src/flow/score-flow.js';

import { setActiveFlow, activeFlowId } from '../src/admin/flow-store.js';
import { activeEngine } from '../src/flow/params.js';

// DEFAULT runs QUALITY ROTATION; the cases below pin the attention-cycle logic, so they run on CYCLE.
assert.strictEqual(activeEngine(), 'quality', 'DEFAULT runs QUALITY ROTATION');
setActiveFlow('engine-cycle');
assert.strictEqual(activeEngine(), 'cycle');

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ok  ' + name); };
const MIN = 60000;
const H = 60 * MIN;
const NOW = 10 * 24 * H;

/** A pool sampled every 30s for `hours`, price from fn(minutesAgo). */
const samples = (hours, price, extra) => {
  const out = [];
  for (let t = NOW - hours * H; t <= NOW; t += 30000) {
    out.push({ t, priceUsd: price((NOW - t) / MIN), volume5mUsd: 1000, buys5m: 10, buyers5m: 5, liquidityUsd: 100000, ...(extra || {}) });
  }
  return out;
};
const run = (price, opts = {}) => flowScore({
  chain: 'solana', tokenAddress: 'T', poolAddress: 'P', symbol: 'TEST',
  priceUsd: price(0), liquidityUsd: opts.liquidity ?? 500000, poolAgeHours: opts.ageHours ?? 2000,
  ...(opts.row || {}),
}, {
  now: NOW, samples: samples(opts.hours ?? 6, price), intel: opts.intel || { holders: { count: 15000 } },
  listing: opts.listing || { perp: { listedOn: [], checked: 3, total: 3, labels: {} } },
  own: opts.own || null, smartWallets: opts.smart || null,
});

// ---- band ------------------------------------------------------------------
const pts = [[0, 40], [0.01, 100], [0.04, 100], [0.15, 0]];
assert.strictEqual(band(0, pts), 40);
assert.strictEqual(band(0.005, pts), 70, 'straight line between corners');
assert.strictEqual(band(1, pts), 0, 'flat after the last corner');
assert.strictEqual(band(NaN, pts), null);
ok('band() is piecewise-linear and flat beyond its ends');

// ---- phases and signals ---------------------------------------------------
{
  const quiet = run(() => 1);
  assert.strictEqual(quiet.phase, 'QUIET');
  assert.strictEqual(quiet.signal, 'WATCH');
  // Flat 1.00, up 2% for the last 20 minutes: moving, not run.
  const waking = run((ago) => (ago <= 20 ? 1.02 : 1.0));
  assert.strictEqual(waking.phase, 'WAKING');
  assert.ok(waking.score >= PHASE_RULES.buyMinEarly, 'a clean, seasoned waking token clears the BUY bar (EARLY ' + waking.score + ')');
  assert.strictEqual(waking.signal, 'BUY');
  // Up 12%: the move is under way.
  assert.strictEqual(run((ago) => (ago <= 20 ? 1.12 : 1.0)).phase, 'RUNNING');
  // Up 50% and still at the high: the burst's peak.
  const peak = run((ago) => (ago <= 20 ? 1.5 : 1.0));
  assert.strictEqual(peak.phase, 'PEAKING');
  assert.strictEqual(peak.signal, 'SELL');
  const shortable = run((ago) => (ago <= 20 ? 1.5 : 1.0), { listing: { perp: { listedOn: ['bybit'], checked: 3, total: 3, labels: { bybit: 'Bybit' } } } });
  assert.strictEqual(shortable.signal, 'SHORT', 'peaking with a perp venue is a SHORT');
  // Ran to 1.5 then gave back to 1.3: already 13% off the high.
  const faded = run((ago) => (ago <= 20 ? 1.3 : ago <= 60 ? 1.5 : 1.0));
  assert.strictEqual(faded.phase, 'FADING');
  assert.strictEqual(faded.signal, 'AVOID');
  assert.strictEqual(run(() => 1, { hours: 0.4 }).phase, null, 'no phase from 24 minutes of history');
}
ok('the attention cycle: QUIET, WAKING → BUY, RUNNING, PEAKING → SELL / SHORT, FADING → AVOID');

// ---- safety ------------------------------------------------------------------
{
  const thin = run((ago) => (ago <= 20 ? 1.02 : 1.0), { liquidity: SAFETY_RULES.minLiquidity - 1 });
  assert.strictEqual(thin.vetoed, true);
  assert.strictEqual(thin.score, 0, 'a failed gate zeroes EARLY');
  assert.ok(thin.rawScore > 0, 'and keeps what it would have been');
  assert.strictEqual(thin.signal, 'WATCH', 'a failed gate blocks BUY');
  const honeypot = run((ago) => (ago <= 20 ? 1.02 : 1.0), { intel: { holders: { count: 15000 },
    contractSafety: { available: true, checks: [{ label: 'Not a honeypot (sell simulation)', ok: false, detail: 'sell reverted' }] } } });
  assert.strictEqual(honeypot.gates.vetoes[0].label, 'SELLABLE');
  assert.strictEqual(honeypot.signal, 'WATCH');
  const unchecked = run((ago) => (ago <= 20 ? 1.02 : 1.0), { intel: { holders: { count: 15000 } } });
  assert.strictEqual(unchecked.vetoed, false, 'not checked is never a veto');
}
ok('safety: only evidence fails a gate, and a failure zeroes EARLY and blocks BUY');

// ---- holder count ---------------------------------------------------------------
{
  const zero = run(() => 1, { intel: { holders: { count: 0, jupiterCount: 2179 } } });
  assert.strictEqual(zero.measures.holders, 2179, 'a 0 count falls back to Jupiter');
  const none = run(() => 1, { intel: { holders: { count: 0 } } });
  assert.strictEqual(none.measures.holders, null, 'zero everywhere is unknown, not zero holders');
}
ok('a holder count of 0 is a provider that could not count, never a count');

// ---- smart money ---------------------------------------------------------------------
{
  const smart = new Set(['0xaa', '0xbb']);
  const own = { trades: [
    { wallet: '0xAA', kind: 'buy', at: NOW - 50 * MIN },
    { wallet: '0xbb', kind: 'sell', at: NOW - 10 * MIN },
    { wallet: '0xaa', kind: 'buy', at: NOW - 2 * MIN },
    { wallet: '0xcc', kind: 'buy', at: NOW - 5 * MIN },
    { wallet: '0xaa', kind: 'buy', at: NOW + MIN },
  ] };
  const r = run(() => 1, { own, smart });
  assert.deepStrictEqual(r.smart, { buyers: 1, sellers: 1 }, 'distinct, in the hour, case-blind, nothing from the future');
  assert.strictEqual(run(() => 1, { own: { trades: own.trades.slice(1, 3) }, smart }).smart.buyers, null,
    'ten minutes of tape cannot speak for the hour');
  assert.strictEqual(run(() => 1, { own }).smart.buyers, null, 'no smart list, no count - never zero');
  const exits = { trades: [{ wallet: '0xaa', kind: 'sell', at: NOW - 30 * MIN }, { wallet: '0xbb', kind: 'sell', at: NOW - 5 * MIN }] };
  assert.strictEqual(run((ago) => (ago <= 20 ? 1.08 : 1.0), { own: exits, smart }).phase, 'PEAKING',
    'smart wallets exiting after a move is a peak');
}
ok('smart money: counted from the tape against the learned list, or not at all');

// ---- trade plan -------------------------------------------------------------------------
{
  const buy = run((ago) => (ago <= 20 ? 1.02 : 1.0));
  assert.strictEqual(buy.plan.side, 'LONG');
  const pr = tradePlanRules();
  assert.strictEqual(pr.horizonHours, DEFAULT_HOLD_HOURS, 'no time frame chosen: AUTO');
  const frame = TIME_FRAMES.find((f) => f.hours === pr.horizonHours);
  assert.strictEqual(buy.plan.targetPct, frame.targetPct, 'target and stop come from the frame');
  assert.ok(Math.abs(buy.plan.target - 1.02 * (1 + frame.targetPct / 100)) < 1e-9);
  assert.ok(Math.abs(buy.plan.stop - 1.02 * (1 - frame.stopPct / 100)) < 1e-9);
  const sell = run((ago) => (ago <= 20 ? 1.5 : 1.0));
  assert.strictEqual(sell.plan.side, 'EXIT');
  assert.ok(sell.plan.target < sell.plan.entry && sell.plan.stop > sell.plan.entry, 'an exit is graded as a short');
  assert.strictEqual(run(() => 1).plan, null, 'WATCH is not a trade');
}
ok('the trade plan: BUY long, SELL / SHORT the other way, WATCH and AVOID none');

// ---- EARLY ------------------------------------------------------------------------------
{
  const r = run((ago) => (ago <= 20 ? 1.02 : 1.0));
  const room = r.scoreModel.find((p) => p.key === 'earlyRoom');
  assert.strictEqual(room.value, band(0.02, EARLY_CURVES.room));
  const young = run((ago) => (ago <= 20 ? 1.02 : 1.0), { ageHours: 3, intel: null });
  assert.ok(young.score < r.score, 'a 3-hour pool with no holder count scores lower');
  assert.strictEqual(r.inputsPresent, r.scoreModel.filter((p) => !p.pending).length);
}
ok('EARLY: band inputs, weighted over what resolved');

// ---- the hold rule -----------------------------------------------------------------
{
  resetSignalMemory();
  // Strong: 15,000 holders on an old pool. Dip: 400 holders on a 150h pool -
  // EARLY between the hold line and the BUY line.
  const call = (holders, now, tok = 'H') => flowScore({ chain: 'solana', tokenAddress: tok, priceUsd: 1.02, liquidityUsd: 5e5, poolAgeHours: holders > 1000 ? 2000 : 150 },
    { now, samples: samples(6, (ago) => (ago <= 20 ? 1.02 : 1.0)), intel: { holders: { count: holders } } });
  const strong = call(15000, NOW);
  assert.strictEqual(strong.signal, 'BUY');
  // Fewer holders pulls EARLY under the BUY line but over the hold line.
  const dip = call(400, NOW + 60000);
  assert.ok(dip.score < PHASE_RULES.buyMinEarly && dip.score >= PHASE_RULES.buyHoldEarly, 'EARLY ' + dip.score + ' sits between the lines');
  assert.strictEqual(dip.signal, 'BUY', 'a BUY holds through a dip above the hold line');
  assert.ok(/holding BUY/.test(dip.signalWhy));
  resetSignalMemory();
  assert.strictEqual(call(400, NOW + 120000).signal, 'WATCH', 'the same EARLY with no BUY before it is not a BUY');
  call(15000, NOW, 'S');
  assert.strictEqual(call(400, NOW + (PHASE_RULES.holdMemoryMin + 1) * 60000, 'S').signal, 'WATCH', 'a stale call is not held');
  resetSignalMemory();
}
ok('the hold rule: a BUY holds through a dip above its hold line, never from nothing, never when stale');

// ---- the engines ---------------------------------------------------------------------
{
  resetSignalMemory();
  const waking = (ago) => (ago <= 20 ? 1.02 : 1.0);
  const r = run(waking);
  assert.deepStrictEqual(Object.keys(r.engines), ENGINES.map((e) => e.key), 'every engine runs on every token');
  assert.strictEqual(r.engines.cycle.signal, r.signal, 'DEFAULT runs CYCLE');
  assert.strictEqual(r.engine, 'cycle');
  // Exits are shared: a peak is SELL whichever engine is asking.
  const peak = run((ago) => (ago <= 20 ? 1.5 : 1.0));
  ENGINES.forEach((e) => assert.strictEqual(peak.engines[e.key].signal, 'SELL', e.label + ' sells the peak'));
  // SMART MONEY: three smart buyers, none selling, on a waking token → BUY.
  const smart = new Set(['0xa1', '0xa2', '0xa3']);
  const own = { trades: [
    { wallet: '0xa1', kind: 'buy', at: NOW - 50 * MIN, usd: 100 }, { wallet: '0xa2', kind: 'buy', at: NOW - 5 * MIN, usd: 100 },
    { wallet: '0xa3', kind: 'buy', at: NOW - 3 * MIN, usd: 100 }] };
  const s = run(waking, { own, smart });
  assert.strictEqual(s.engines.smart.score, 90);
  assert.ok(s.engines.smart.score >= ENGINE_RULES.smartBuy);
  assert.strictEqual(s.engines.smart.signal, 'BUY');
  assert.strictEqual(run(waking).engines.smart.signal, 'WATCH', 'no tape, no smart score, no BUY');
  // ROTATION: wallets that sold another pool and bought this one.
  const ws = new Map([
    ['P', { trades: ['0x1', '0x2', '0x3', '0x4', '0x5'].map((w, k) => ({ wallet: w, kind: 'buy', at: NOW - (50 - k) * MIN, usd: 200 })) }],
    ['OTHER', { trades: ['0x1', '0x2', '0x3', '0x4'].map((w, k) => ({ wallet: w, kind: 'sell', at: NOW - (90 - k) * MIN, usd: 200 })) }],
  ]);
  const rot = flowScore({ chain: 'solana', tokenAddress: 'R', poolAddress: 'P', priceUsd: 1.02, liquidityUsd: 5e5, poolAgeHours: 2000 },
    { now: NOW, samples: samples(6, waking), own: ws.get('P'), walletSets: ws, intel: { holders: { count: 15000 } } });
  assert.strictEqual(rot.rotation.inWallets, 4, 'four of the five buyers came from another token');
  assert.strictEqual(rot.engines.rotation.score, 100);
  assert.strictEqual(rot.engines.rotation.signal, 'BUY');
  // BLEND: CYCLE, SMART and ROTATION all clear their BUY lines → votes.
  assert.ok(rot.engines.blend.score >= 100, 'two or more engines agreeing is a BLEND BUY');
  assert.ok(ENGINE_RULES.lateUpPct > PHASE_RULES.runningPct, 'the late-entry cap reaches into RUNNING');
  resetSignalMemory();
}
ok('engines: six scores and calls on every token, one shared exit, SIGNAL follows the active one');

// ---- execution cost, the market-rotation veto, TIDE -------------------------------
{
  resetSignalMemory();
  // Cost: a quote wins over the depth estimate; impact scales with size.
  assert.ok(Math.abs(roundTripCostPct(5e5, 1000, 3) - (2 * 0.3 + 0.6)) < 1e-9, 'a 3% $10K quote is 0.3% at $1K');
  assert.ok(Math.abs(roundTripCostPct(1e5, 1000, null) - (2 * 100 * 0.55 * 1000 / 5e4 + 0.6)) < 1e-9);
  const waking = (ago) => (ago <= 20 ? 1.02 : 1.0);
  const thin = run(waking, { liquidity: 60000 });
  assert.strictEqual(thin.signal, 'WATCH', 'a pool too thin for the trade size is not a BUY');
  assert.ok(/too thin/.test(thin.signalWhy));
  assert.ok(thin.plan === null || thin.plan.costPct > 2);
  // Capital leaving: wallets that sold here and bought another pool.
  const leaving = new Map([
    ['P', { trades: ['0x1', '0x2', '0x3', '0x4', '0x5'].map((w, k) => ({ wallet: w, kind: k < 4 ? 'sell' : 'buy', at: NOW - (50 - k) * MIN, usd: 500 })) }],
    ['OTHER', { trades: ['0x1', '0x2', '0x3', '0x4'].map((w, k) => ({ wallet: w, kind: 'buy', at: NOW - (40 - k) * MIN, usd: 500 })) }],
  ]);
  const lv = flowScore({ chain: 'solana', tokenAddress: 'L', poolAddress: 'P', priceUsd: 1.02, liquidityUsd: 5e5, poolAgeHours: 2000 },
    { now: NOW, samples: samples(6, waking), own: leaving.get('P'), walletSets: leaving, intel: { holders: { count: 15000 } } });
  assert.ok(lv.flowValues['f:pipe:MARKET NET FLOW 2H'] < -ENGINE_RULES.rotVetoUsd, 'capital is net leaving');
  assert.strictEqual(lv.engines.tide.score, 0, 'TIDE does not buy into capital leaving');
  // TIDE buys rotation in with smart wallets agreeing and capital not leaving.
  const smartSet = new Set(['0x1', '0x2', '0x3']);
  const arriving = new Map([
    ['P', { trades: ['0x1', '0x2', '0x3', '0x4', '0x5'].map((w, k) => ({ wallet: w, kind: 'buy', at: NOW - (50 - k) * MIN, usd: 300 })) }],
    ['OTHER', { trades: ['0x1', '0x2', '0x3', '0x4'].map((w, k) => ({ wallet: w, kind: 'sell', at: NOW - (90 - k) * MIN, usd: 300 })) }],
  ]);
  const ar = flowScore({ chain: 'solana', tokenAddress: 'A', poolAddress: 'P', priceUsd: 1.02, liquidityUsd: 5e5, poolAgeHours: 2000 },
    { now: NOW, samples: samples(6, waking), own: arriving.get('P'), walletSets: arriving, smartWallets: smartSet, intel: { holders: { count: 15000 } } });
  assert.ok(ar.flowValues['f:pipe:MARKET NET FLOW 2H'] > 0, 'capital arriving');
  assert.strictEqual(ar.engines.tide.signal, 'BUY');
  assert.strictEqual(ar.plan === null ? DEFAULT_TRADE_USD : ar.plan.tradeUsd, DEFAULT_TRADE_USD);
  resetSignalMemory();
}
ok('execution cost gates every BUY; capital leaving vetoes the rotation engines; TIDE rides the inflow');

// ---- the map's edits are obeyed ------------------------------------------------------------
{
  connectFlow({ missingIds: () => new Set(['f:pipe:PHASE']) });
  const r = run((ago) => (ago <= 20 ? 1.02 : 1.0));
  assert.strictEqual(r.phase, null, 'a deleted box produces nothing');
  assert.strictEqual(r.signal, null, 'and nothing downstream of it');
  connectFlow({ missingIds: () => new Set() });
  const { values } = runScoreFlow({ row: { priceUsd: 1, liquidityUsd: 1e5 }, samples: samples(6, () => 1), now: NOW });
  assert.strictEqual(values['f:pipe:PHASE'], 'QUIET', 'restored, it runs again');
}
ok('a box deleted on the map produces nothing, and nor does anything after it');

console.log('\n' + pass + ' passed');
