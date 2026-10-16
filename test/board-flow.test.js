/**
 * THE BOARD FLOW (src/flow/board-flow.js), run the way the app runs it.
 *
 *   npm test
 *
 * The board-wide boxes every tab reads: the board counts, the organic
 * grades, the alert engine, system health, the selected token's wallet and
 * rotation reads, and the hit rate. Pinned here so a tab never has to
 * compute any of them again.
 */
import assert from 'node:assert';
import '../src/flow/runtime.js';
import {
  runBoardFlow, boardNote, boardValue, systemHealth, tokenRotation, marketRotation,
  tokenWallets, walletGroups, walletRanks, combineConfidence, constitutingRisk, organicGradeOf,
} from '../src/flow/board-flow.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ok  ' + name); };

const asset = (sym, chain, signal, extra = {}) => ({
  id: sym, sym, chain, cls: 'MEME', signal, score: 90, conf: 0.7, poolAddress: 'P' + sym,
  rawServerRow: { tokenAddress: 'T' + sym, scoreModel: [], riskFlags: [], measures: {}, engines: {}, ...(extra.row || {}) },
  ...extra,
});

// ---- board counts, organic grades -------------------------------------------
{
  const board = [
    asset('$A', 'SOL', 'BUY', { row: { engines: { cycle: { signal: 'BUY' } }, organicFlow: { score: 80, basis: 'sample', coverage: 100 } } }),
    asset('$B', 'SOL', 'WATCH', { cls: 'TOKEN', row: { organicFlow: { score: 50, basis: 'sample', coverage: 10 } } }),
    asset('$C', 'BASE', 'BUY', { row: { engines: { cycle: { signal: 'BUY' }, momentum: { signal: 'WATCH' } }, organicFlow: { score: 30, basis: 'jupiter', coverage: 100 } } }),
  ];
  runBoardFlow(board, { now: 1e12 });
  assert.strictEqual(boardValue('TOKENS TRACKED'), 3);
  assert.deepStrictEqual(boardValue('BOARD COUNTS'), {
    chain: { SOL: 2, BASE: 1 }, type: { MEME: 2, TOKEN: 1 },
    signal: { BUY: { SOL: 1, BASE: 1 }, WATCH: { SOL: 1 } }, engineBuys: { cycle: { SOL: 1, BASE: 1 } },
  });
  assert.deepStrictEqual(boardValue('ORGANIC GRADES'), { STRONG: 1, FAIR: 1, WEAK: 0 });
  assert.deepStrictEqual(boardNote('ORGANIC GRADES'), { sampled: 2, jupiterOnly: 1 });
  // (80 × 100 + 50 × 25) ÷ 125: coverage floored at 25.
  assert.strictEqual(boardValue('AVG ORGANIC SCORE'), 74);
  assert.strictEqual(organicGradeOf(44.9).name, 'WEAK');
  assert.strictEqual(organicGradeOf(70).name, 'STRONG');
}
ok('board counts and organic grades: per chain, per type, per signal and engine; our own sample only');

// ---- the alert engine ----------------------------------------------------------
{
  const flag = (code, penalty) => ({ code, penalty, severity: 'HIGH', detail: code });
  const board = [
    asset('$LOW', 'SOL', 'BUY', { score: 86 }),
    asset('$HIGH', 'SOL', 'BUY', { score: 95, row: { scoreModel: [
      { key: 'earlyRoom', label: 'Room to run', weight: 30, value: 100 },
      { key: 'earlyInterest', label: 'Fresh interest', weight: 6, value: 40, pending: false },
    ] } }),
    asset('$TOP', 'BASE', 'SELL', { row: { measures: { aboveLow6hPct: 140 }, smart: { sellers: 2 } } }),
    asset('$RUG', 'BASE', 'WATCH', { row: { riskFlags: [flag('THIN_LIQUIDITY', 4), flag('CONTRACT_CHECKS', 5), flag('NEW_POOL', 6)] } }),
    asset('$ONE', 'BASE', 'WATCH', { row: { riskFlags: [flag('THIN_LIQUIDITY', 4)] } }),
  ];
  runBoardFlow(board, { now: 1e12 });
  const a = boardValue('ALERT ENGINE');
  assert.deepStrictEqual(a.OPPORTUNITY.map((x) => x.sym), ['$HIGH', '$LOW'], 'BUYs, highest EARLY first');
  assert.strictEqual(a.OPPORTUNITY[0].families.find((f) => f.key === 'cycle').value, 100);
  assert.strictEqual(a.EXIT[0].sym, '$TOP');
  assert.strictEqual(a.EXIT[0].families[0].value, 100, 'the cycle family is capped at 100');
  assert.deepStrictEqual(a.RISK.map((x) => x.sym), ['$RUG'], 'RISK needs two independent families; integrity never counts');
  assert.strictEqual(boardValue('ALERTS NOW'), 4 + a.RESOLUTION.length);
  assert.deepStrictEqual(boardNote('ALERT ENGINE').invalid, ['alert T$LOW: at least one evidence family must report'],
    'a card with no evidence is reported, not hidden');
  assert.strictEqual(constitutingRisk([{ key: 'integrity', value: 90 }]).length, 0);
  assert.ok(combineConfidence([{ key: 'cycle', value: 80, confidence: 1 }, { key: 'flow', value: 80, confidence: 1 }])
    < combineConfidence([{ key: 'cycle', value: 80, confidence: 1 }, { key: 'breadth', value: 80, confidence: 1 }]),
  'correlated families count for less than independent ones');
}
ok('alert engine: BUY / EXIT / RISK cards from the model, ALERTS NOW counts them');

// ---- system health ---------------------------------------------------------------
{
  const now = 1e12;
  assert.strictEqual(systemHealth({ system: null, browser: {}, waiting: true, now }).title, 'Checking…');
  const h = systemHealth({
    now,
    system: { writtenAgeMs: 5000, uptimeSeconds: 3600, memory: { rssMb: 300 },
      providers: [{ provider: 'api.dexscreener.com', status: 'DOWN', recent: { calls: 10, errors: 10, errorRatePct: 100, kinds: { timeout: 10 } } }] },
    browser: { wallet: { running: true, lastTickAt: now }, social: { running: true, lastTickAt: now }, rotation: { running: true, lastTickAt: now },
      storage: { backend: 'indexeddb' } },
  });
  assert.strictEqual(h.parts.find((p) => p.key === 'sources').level, 'down', 'the critical group down takes data sources down');
  assert.strictEqual(h.title, 'Outage');
  assert.ok(h.issues[0].text.indexOf('timing out') !== -1, 'the problem says why');
}
ok('system health: a level per part, each with its reason');

// ---- the selected token's wallet read ------------------------------------------------
{
  const rows = [
    { address: 'pool', isPool: true, grossUsd: 1e6, netUsd: 0, tags: ['POOL'] },
    { address: 'w1', grossUsd: 100, netUsd: 100, tags: ['ACCUMULATING'] },
    { address: 'w2', grossUsd: 5000, netUsd: 0, tags: ['CHURN'] },
    { address: 'w3', grossUsd: 300, netUsd: -300, tags: ['EXITING', 'ROTATING'] },
  ];
  const store = { rows, window: {}, flow: {}, counts: {} };
  const sel = { tokenAddress: 'T1' };
  assert.strictEqual(tokenWallets(sel, { server: 'ok', tokenAddress: 'OTHER', rows }, store), store, 'a read of another token is not used');
  const fresh = { server: 'ok', tokenAddress: 'T1', rows };
  assert.strictEqual(tokenWallets(sel, fresh, store), fresh, 'the on-demand read wins');
  assert.strictEqual(tokenWallets(sel, null, { rows: [] }), null);
  assert.deepStrictEqual(walletGroups(store), { ALL: 3, ACCUMULATING: 1, CHURN: 1, EXITING: 1, ROTATING: 1 });
  assert.deepStrictEqual(walletRanks(store), { byTurnover: ['w2', 'w3', 'w1'], byNet: ['w3', 'w1'] },
    'turnover keeps the flat churner; |net| drops it');
}
ok('wallet read: the right sample, its groups and its rankings, the pool contract excluded');

// ---- rotation ----------------------------------------------------------------------
{
  const node = (pool, net, peers) => ({ poolAddress: pool, symbol: pool, rotatedUsd: Math.abs(net) + 10, netRotationUsd: net, inUsd: 5, outUsd: 5, connections: 1, peers });
  const held = [
    { chain: 'base', at: 1, graph: { poolsSampled: 3, rotatedUsd: 50, parallelUsd: 4, nodes: [
      node('X', 40, [{ direction: 'in', rotatedUsd: 5, poolAddress: 'Y' }, { direction: 'in', rotatedUsd: 9, poolAddress: 'Z' }, { direction: 'out', rotatedUsd: 0, poolAddress: 'Q' }]),
      node('Y', -40, []),
    ], edges: [{ sourcePool: 'Y', targetPool: 'X', dominantUsd: 40, counterUsd: 3, sharedWallets: 2 }] } },
    { chain: 'solana', at: 1, graph: { poolsSampled: 2, rotatedUsd: 90, parallelUsd: 1, nodes: [node('S', 7, [])], edges: [] } },
  ];
  const t = tokenRotation(held, 'X', () => ({ ticks: 4 }));
  assert.deepStrictEqual(t.inPeers.map((p) => p.poolAddress), ['Z', 'Y'], 'largest first');
  assert.strictEqual(t.outCount, 0, 'a zero path is not a destination');
  assert.strictEqual(t.poolsCompared, 2);
  assert.strictEqual(t.ticksObserved, 4);
  assert.strictEqual(tokenRotation(held, 'NOPE'), null);
  const m = marketRotation(held);
  assert.deepStrictEqual(m.chains.map((c) => c.chain), ['solana', 'base'], 'busiest chain first');
  assert.deepStrictEqual(m.chains[1].flows.map((f) => f.usd), [40, 3], 'both directions, largest first');
  assert.deepStrictEqual(m.gainers.map((g) => g.poolAddress), ['X', 'S']);
  assert.deepStrictEqual(m.losers.map((g) => g.poolAddress), ['Y']);
  assert.strictEqual(m.rotatedUsd, 140);
  assert.strictEqual(m.poolsSampled, 5);
}
ok('rotation: a pool’s peers per direction, every chain’s flows, net gainers and losers');

// ---- the hit rate ---------------------------------------------------------------------
{
  runBoardFlow([], { precisionRead: { error: 'raw store unreachable' } });
  assert.strictEqual(boardValue('TOP 20 HIT RATE'), null);
  assert.strictEqual(boardNote('TOP 20 HIT RATE').error, 'raw store unreachable');
  const read = { inputs: { observations: {}, coverage: { coverage: 0.5 } }, journal: {}, at: 1 };
  runBoardFlow([], { precisionRead: read });
  const note = boardNote('TOP 20 HIT RATE');
  assert.strictEqual(note.exhausted, true, 'nothing resolves from an empty record');
  assert.strictEqual(note.coverage, 0.5);
  runBoardFlow([], { precisionRead: read });
  assert.strictEqual(boardNote('TOP 20 HIT RATE'), note, 'the same read is not measured twice');
}
ok('TOP 20 HIT RATE: measured once per read, its whole reading beside the wire');

console.log('\n' + pass + ' passed');
