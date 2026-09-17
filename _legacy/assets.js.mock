export const assetSeeds = [
  {
    id: 'glyph', sym: '$GLYPH', name: 'Glyph Protocol', chain: 'SOL', cls: 'MEME', stage: 4, score: 91, conf: 0.91, age: 5040, price: 0.00742, chg: 0.284, liq: 412000, vol: 1870000, adj: 1690000, buyers: 412, nf: 318000, wash: 0.06, canonical: false,
    reasons: [{ code: 'VOL_ANOM_5M', win: '5M', text: 'Adjusted volume 9.1× session baseline', z: '6.2', ratio: '9.1' }, { code: 'BUYER_BREADTH', win: '5M', text: 'Unique buyers 4.0× baseline; 71% first-time asset buyers', z: '5.1', ratio: '4.0' }, { code: 'LIQ_GROWTH', win: '15M', text: 'Net liquidity +$118K across 3 pools, 14 new LPs', z: '3.8', ratio: '2.6' }, { code: 'ROTATION_IN', win: '1H', text: 'Stablecoin deployment from 96 wallets exiting AI cohort', z: '3.1', ratio: '—' }],
    flags: [{ sev: 'MED', text: 'Top-10 adjusted holders own 29% (ex-pools, ex-burn)' }, { sev: 'LOW', text: 'Token age < 2h — experimental cohort baselines' }],
    reason: 'Vol 9.1× + buyers 4.0× + liq +$118K + rotation-in'
  },
  {
    id: 'nvdax', sym: 'NVDAx', name: 'NVIDIA Stock Token', chain: 'RHC', cls: 'STOCK', stage: 3, score: 84, conf: 0.87, age: 19310000, price: 212.44, chg: 0.031, liq: 2410000, vol: 944000, adj: 944000, buyers: 151, nf: 402000, wash: 0.02, canonical: true, tick: 'NVDA',
    reasons: [{ code: 'RFQ_VOL_ANOM', win: '15M', text: 'Executed RFQ notional 5.1× session-adjusted baseline', z: '5.4', ratio: '5.1' }, { code: 'TAKER_BREADTH', win: '15M', text: 'Unique takers 2.7× baseline across RFQ + AMM', z: '3.9', ratio: '2.7' }, { code: 'SECTOR_ROTATION', win: '1H', text: 'Tech cohort → semiconductor rotation, 64 linked wallets', z: '3.3', ratio: '—' }, { code: 'ORACLE_CONFIRM', win: '5M', text: 'Execution within 0.42% of Chainlink NVDA/USD, round fresh 4s', z: '—', ratio: '—' }],
    flags: [{ sev: 'MED', text: '61% of recent RFQ volume filled by one maker' }, { sev: 'LOW', text: 'US market open — session-adjusted baselines active' }],
    oracle: { feed: '0x8c2f…a41e', fresh: '4s', dev: '0.42%', seq: 'UP', mult: '1.0000', pend: '—', session: 'OPEN', corp: 'NONE' },
    reason: 'RFQ vol 5.1× session-adj + takers 2.7× + semis rotation'
  },
  {
    id: 'solpup', sym: '$SOLPUP', name: 'Solana Puppy', chain: 'SOL', cls: 'MEME', stage: 3, score: 82, conf: 0.84, age: 11160, price: 0.000318, chg: 0.147, liq: 186000, vol: 722000, adj: 641000, buyers: 238, nf: 141000, wash: 0.11, canonical: false,
    reasons: [{ code: 'VOL_ANOM_5M', win: '5M', text: 'Adjusted volume 7.2× baseline', z: '5.4', ratio: '7.2' }, { code: 'BUYER_BREADTH', win: '5M', text: 'Unique buyers 3.1× baseline', z: '4.2', ratio: '3.1' }, { code: 'XPOOL_CONFIRM', win: '5M', text: 'Confirmed across Raydium + Meteora, price consensus 0.3%', z: '—', ratio: '—' }],
    flags: [{ sev: 'MED', text: 'Top-10 adjusted holders own 31%' }, { sev: 'MED', text: 'Liquidity moderately concentrated: 2 LPs hold 58%' }],
    reason: 'Vol 7.2× + buyers 3.1× + 2-pool confirmation'
  },
  {
    id: 'amdx', sym: 'AMDx', name: 'AMD Stock Token', chain: 'RHC', cls: 'STOCK', stage: 3, score: 80, conf: 0.82, age: 19310000, price: 184.02, chg: 0.024, liq: 1120000, vol: 388000, adj: 388000, buyers: 87, nf: 167000, wash: 0.03, canonical: true, tick: 'AMD',
    reasons: [{ code: 'RFQ_VOL_ANOM', win: '15M', text: 'Executed notional 3.9× session-adjusted baseline', z: '4.1', ratio: '3.9' }, { code: 'SECTOR_ROTATION', win: '1H', text: 'Same semiconductor rotation cluster as NVDAx', z: '3.0', ratio: '—' }, { code: 'ORACLE_CONFIRM', win: '5M', text: 'Execution within 0.38% of Chainlink AMD/USD', z: '—', ratio: '—' }],
    flags: [{ sev: 'LOW', text: 'Maker concentration 44% — within profile limit' }],
    oracle: { feed: '0x3b1d…77c2', fresh: '7s', dev: '0.38%', seq: 'UP', mult: '1.0000', pend: '—', session: 'OPEN', corp: 'NONE' },
    reason: 'RFQ vol 3.9× + semis rotation + oracle confirmed'
  },
  {
    id: 'bswirl', sym: '$BSWIRL', name: 'BaseSwirl', chain: 'BASE', cls: 'TOKEN', stage: 2, score: 74, conf: 0.76, age: 262000, price: 0.0447, chg: 0.062, liq: 341000, vol: 264000, adj: 239000, buyers: 96, nf: 58000, wash: 0.09, canonical: false,
    reasons: [{ code: 'VOL_ANOM_15M', win: '15M', text: 'Adjusted volume 3.4× baseline on Aerodrome', z: '3.6', ratio: '3.4' }, { code: 'HOLDER_GROWTH', win: '1H', text: 'Holders +6.2% with funded new wallets', z: '2.9', ratio: '1.6' }],
    flags: [{ sev: 'LOW', text: 'LP 71% locked 90d; deployer wallets quiet 3d' }],
    reason: 'Vol 3.4× + holder growth, LP locked'
  },
  {
    id: 'qqqx', sym: 'QQQx', name: 'Nasdaq-100 ETF Token', chain: 'RHC', cls: 'ETF', stage: 2, score: 71, conf: 0.74, age: 19310000, price: 512.87, chg: 0.008, liq: 3180000, vol: 502000, adj: 502000, buyers: 64, nf: 88000, wash: 0.02, canonical: true, tick: 'QQQ',
    reasons: [{ code: 'TAKER_BREADTH', win: '30M', text: 'Unique takers 2.1× baseline; single-stock → ETF pattern', z: '2.8', ratio: '2.1' }, { code: 'ROTATION_IN', win: '1H', text: 'Inflows from 12 single-stock token cohorts', z: '2.4', ratio: '—' }],
    flags: [{ sev: 'LOW', text: 'Broad-market ETF — expect lower volatility profile' }],
    oracle: { feed: '0x91aa…03f7', fresh: '6s', dev: '0.11%', seq: 'UP', mult: '1.0000', pend: '—', session: 'OPEN', corp: 'NONE' },
    reason: 'Takers 2.1× + single-stock→ETF rotation'
  },
  {
    id: 'kitsune', sym: '$KITSUNE', name: 'Kitsune Cash', chain: 'SOL', cls: 'MEME', stage: 2, score: 69, conf: 0.66, age: 7620, price: 0.00194, chg: 0.208, liq: 94000, vol: 488000, adj: 302000, buyers: 118, nf: 64000, wash: 0.34, canonical: false,
    reasons: [{ code: 'VOL_ANOM_5M', win: '5M', text: 'Raw volume 8.8× baseline — 38% flagged non-organic', z: '4.8', ratio: '8.8' }, { code: 'BUYER_BREADTH', win: '5M', text: 'Unique buyers 2.4× baseline after sybil adjustment', z: '2.7', ratio: '2.4' }],
    flags: [{ sev: 'HIGH', text: 'Wash probability 0.34 — repeated back-and-forth from 9-wallet cluster' }, { sev: 'HIGH', text: 'BUNDLE: 11 fresh wallets funded by one source bought same block at launch' }, { sev: 'MED', text: 'Liquidity cycling: $41K added → withdrawn within 25m, twice in 3h' }],
    bundle: { prob: 0.71, launchBuyers: 14, sameBlock: 11, funder: '5xQm…c2', supplyPct: 18, liqCycles: 2, liqCycleUsd: 41000 },
    reason: 'Vol 8.8× raw BUT 38% flagged wash — adjusted metrics used'
  },
  {
    id: 'zkfox', sym: '$ZKFOX', name: 'ZK Fox', chain: 'BNB', cls: 'TOKEN', stage: 2, score: 68, conf: 0.71, age: 428000, price: 0.312, chg: 0.041, liq: 277000, vol: 198000, adj: 184000, buyers: 74, nf: 39000, wash: 0.07, canonical: false,
    reasons: [{ code: 'VOL_ANOM_15M', win: '15M', text: 'Adjusted volume 2.9× baseline on PancakeSwap', z: '3.1', ratio: '2.9' }, { code: 'SMART_INFLOW', win: '1H', text: '6 historically profitable wallets entered', z: '2.5', ratio: '—' }],
    flags: [{ sev: 'LOW', text: 'Contract verified; no privileged mint' }],
    reason: 'Vol 2.9× + smart-wallet inflow'
  },
  {
    id: 'tslax', sym: 'TSLAx', name: 'Tesla Stock Token', chain: 'RHC', cls: 'STOCK', stage: 1, score: 61, conf: 0.69, age: 19310000, price: 341.60, chg: -0.006, liq: 1980000, vol: 171000, adj: 171000, buyers: 41, nf: -22000, wash: 0.02, canonical: true, tick: 'TSLA',
    reasons: [{ code: 'VOL_ANOM_30M', win: '30M', text: 'Executed notional 1.9× session baseline', z: '2.1', ratio: '1.9' }],
    flags: [{ sev: 'LOW', text: 'Single-family signal — watch stage only' }],
    oracle: { feed: '0x6dd0…b911', fresh: '5s', dev: '0.19%', seq: 'UP', mult: '1.0000', pend: '—', session: 'OPEN', corp: 'NONE' },
    reason: 'Vol 1.9× only — awaiting second family'
  },
  {
    id: 'moonveil', sym: '$MOONVEIL', name: 'Moonveil', chain: 'BNB', cls: 'MEME', stage: 1, score: 58, conf: 0.52, age: 3300, price: 0.0000842, chg: 0.412, liq: 31000, vol: 214000, adj: 74000, buyers: 29, nf: 11000, wash: 0.58, canonical: false,
    reasons: [{ code: 'VOL_ANOM_5M', win: '5M', text: 'Raw volume 11× baseline — 65% flagged non-organic', z: '3.9', ratio: '11.2' }],
    flags: [{ sev: 'HIGH', text: 'Wash probability 0.58 — circular flows, uniform trade sizes' }, { sev: 'HIGH', text: 'BUNDLE: deployer-linked wallets hold 46% of supply, bought block 0-2' }, { sev: 'HIGH', text: 'Liquidity wash: $18K in/out 4× in 90m to simulate depth' }],
    bundle: { prob: 0.89, launchBuyers: 23, sameBlock: 19, funder: '0x8f…a1', supplyPct: 46, liqCycles: 4, liqCycleUsd: 18000 },
    reason: '⚠ 65% of volume flagged wash — experimental only'
  },
  {
    id: 'basedrat', sym: '$BASEDRAT', name: 'Based Rat', chain: 'BASE', cls: 'MEME', stage: 1, score: 57, conf: 0.61, age: 9900, price: 0.000761, chg: 0.088, liq: 52000, vol: 96000, adj: 84000, buyers: 44, nf: 16000, wash: 0.14, canonical: false,
    reasons: [{ code: 'BUYER_BREADTH', win: '5M', text: 'Unique buyers 2.2× baseline', z: '2.3', ratio: '2.2' }],
    flags: [{ sev: 'MED', text: 'Liquidity below standard profile — experimental cohort' }],
    reason: 'Buyers 2.2× — liquidity thin, experimental'
  },
  {
    id: 'perch', sym: '$PERCH', name: 'Perch Finance', chain: 'SOL', cls: 'TOKEN', stage: 1, score: 55, conf: 0.64, age: 1210000, price: 0.0912, chg: 0.019, liq: 148000, vol: 61000, adj: 58000, buyers: 31, nf: 9000, wash: 0.05, canonical: false,
    reasons: [{ code: 'LIQ_GROWTH', win: '1H', text: 'Net liquidity +$21K, 4 new LPs', z: '2.2', ratio: '1.8' }],
    flags: [{ sev: 'LOW', text: 'Low urgency — initial anomaly only' }],
    reason: 'Liquidity building — initial anomaly'
  }
];
