/**
 * WALLET TRACKER: trade detection, alarm rules and list import, on controlled data.
 *
 *   npm test
 */
import assert from 'node:assert';
import { detectWalletMoves, shouldAlarm } from '../src/services/wallet-alerts.js';
import { parseWalletList } from '../src/data/smart-wallets.js';

let pass = 0;
const ok = (name) => { pass += 1; console.log('  ok  ' + name); };

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const wallet = (alert) => ({ address: A, label: 'Test KOL', alert: { on: true, buy: true, sell: true, minUsd: 0, ...alert } });

// A fake wallet-intel memory whose totals the test moves by hand.
let pools = [];
const profileOf = () => ({ pools });
const pool = (trades, grossUsd, netUsd) => ({ poolAddress: 'P1', symbol: 'CAT', chain: 'solana', trades, grossUsd, netUsd, lastAt: 1000 + trades });

{
  const memory = {};
  pools = [pool(5, 1000, 400)];
  assert.deepStrictEqual(detectWalletMoves([wallet()], profileOf, memory), []);
  ok('the first look only records - past trades are not news');

  pools = [pool(5, 1000, 400)];
  assert.deepStrictEqual(detectWalletMoves([wallet()], profileOf, memory), []);
  ok('nothing changed, nothing reported');

  pools = [pool(7, 1600, 900)];
  const [buy] = detectWalletMoves([wallet()], profileOf, memory);
  assert.strictEqual(buy.side, 'buy');
  assert.strictEqual(buy.usd, 600);
  assert.strictEqual(buy.trades, 2);
  assert.strictEqual(buy.symbol, 'CAT');
  ok('new trades with net USD rising read as a buy, sized by the gross change');

  pools = [pool(8, 2400, 100)];
  const [sell] = detectWalletMoves([wallet()], profileOf, memory);
  assert.strictEqual(sell.side, 'sell');
  assert.strictEqual(sell.usd, 800);
  ok('net USD falling reads as a sell');

  pools = [pool(8, 2400, 100), { ...pool(1, 50, 50), poolAddress: 'P2', symbol: 'DOG' }];
  const [fresh] = detectWalletMoves([wallet()], profileOf, memory);
  assert.strictEqual(fresh.symbol, 'DOG');
  ok('a pool the wallet had never touched counts from zero');
}

{
  const memory = {};
  pools = [];
  detectWalletMoves([wallet()], () => null, memory);
  pools = [pool(1, 300, 300)];
  assert.strictEqual(detectWalletMoves([wallet()], profileOf, memory).length, 1);
  ok('a wallet first seen with no history still alarms on its first trade');
}

{
  const buy = { side: 'buy', usd: 500 };
  const sell = { side: 'sell', usd: 500 };
  assert.strictEqual(shouldAlarm(wallet(), buy), true);
  assert.strictEqual(shouldAlarm(wallet({ on: false }), buy), false);
  assert.strictEqual(shouldAlarm(wallet({ buy: false }), buy), false);
  assert.strictEqual(shouldAlarm(wallet({ buy: false }), sell), true);
  assert.strictEqual(shouldAlarm(wallet({ minUsd: 1000 }), buy), false);
  assert.strictEqual(shouldAlarm(wallet({ minUsd: 500 }), buy), true);
  ok('alarm rules: muted, buys/sells switches and the minimum size');
}

{
  const lines = [
    A + ', Some KOL, kol, sol, @somekol',
    'not-an-address, Nobody',
    '0x5b43453fce04b92e190f391a83136bfbecedefd1\tA Fund\tFUND',
    A + ', duplicate',
  ].join('\n');
  const { wallets, skipped } = parseWalletList(lines);
  assert.strictEqual(wallets.length, 2);
  assert.strictEqual(skipped, 2);
  assert.deepStrictEqual(wallets[0], { address: A, name: 'Some KOL', category: 'KOL', chain: 'SOL', handle: 'somekol' });
  assert.strictEqual(wallets[1].category, 'FUND');
  ok('import reads comma or tab lines, drops bad and duplicate addresses');

  const json = parseWalletList(JSON.stringify([{ address: A, name: 'J' }]));
  assert.strictEqual(json.wallets.length, 1);
  assert.strictEqual(json.wallets[0].category, 'KOL');
  ok('import reads a JSON array too');
}

console.log('\n' + pass + ' passed');
