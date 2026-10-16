#!/usr/bin/env node
/**
 * Grades the model against what prices did next, from the server's archive.
 *
 *   npm run backtest
 *   node --import ./scripts/node-loader.mjs scripts/backtest-early.mjs <server data dir> \
 *     [--out <report.json>] [--wallets <smart-wallets.json>] [--history <dir>] [--since <days>] [--dump <rows.json>]
 *     [--weights <key>=<n>,...] [--board-min <pct>]
 *
 * A CANDIDATE ENGINE is graded beside the flow when --weights or --board-min
 * is given: EARLY re-weighted from the flow's own input values, and BUY
 * re-called with the flow's PHASE_RULES and hold rule, optionally gated on
 * the board's median 6h change (no BUY, fresh or held, while it is under
 * --board-min %). SELL / SHORT / AVOID are the flow's own. The flow itself
 * is never changed by this script.
 *
 * WHAT IS GRADED: THE DATA FLOW ITSELF. Every 15 minutes, for every token the
 * archive holds, this script feeds the token's point-in-time inputs - only
 * samples, trades and holder counts at or before that moment - through
 * flow/score-flow.js flowScore(), the very function the app runs on every
 * poll. So the EARLY, PHASE and SIGNAL graded here cannot differ from the ones
 * on screen: there is one model, and this is it.
 *
 * Each moment is then judged as the trade it would have been:
 *
 *   FAST   +10% take profit / -7% stop, else close after 6h
 *   SWING  the TRADE PLAN the app shows (+20% / -15% within 24h by default)
 *
 * BUY is graded as a long, SELL and SHORT as a short (SELL = "get out": the
 * short side is what holding on would have cost), AVOID and WATCH both ways.
 * The retired fifteen-input board score is graded beside it for as long as
 * the score trail still holds hours it was recorded in.
 *
 * Smart wallets are learned point-in-time: a wallet counts as smart at a
 * moment only from buys whose own 6 hours were already over by then.
 * --wallets writes the list as of now, which the app reads from
 * /raw/smart-wallets.json. --out writes /raw/model-eval.json, which the
 * Evaluation tab and the admin DATA FLOW read.
 *
 * No dependencies; node >= 18.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { flowScore, EARLY_MODEL, PHASES, SIGNALS, PLAN_RULES, PHASE_RULES, EARLY_MIN_PARTS, ENGINES, ENGINE_RULES, TRADE_SIZES, roundTripCostPct } from '../src/flow/score-flow.js';
import { isMajorToken, tradeStatsFrom } from '../src/calculations/core.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const DATA = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) || '../Vibe-mm-server/data';
const OUT = flag('--out');
const WALLETS_OUT = flag('--wallets');
const DUMP = flag('--dump');
const HISTORY = flag('--history');
const SINCE_DAYS = Number(flag('--since') || 30);
const WEIGHTS_IN = Object.fromEntries(String(flag('--weights') || '').split(',').filter(Boolean)
  .map((kv) => { const i = kv.lastIndexOf('='); return [kv.slice(0, i), Number(kv.slice(i + 1))]; }));
const BOARD_MIN = flag('--board-min') === null ? null : Number(flag('--board-min'));
const CANDIDATE = Object.keys(WEIGHTS_IN).length > 0 || BOARD_MIN !== null;
const CAND_WEIGHTS = Object.fromEntries(EARLY_MODEL.map((c) => [c.key, Number.isFinite(WEIGHTS_IN[c.key]) ? WEIGHTS_IN[c.key] : c.weight]));

const MIN = 60000;
const H = 60 * MIN;
const STEP = 15 * MIN;
/** The holding windows every call is also graded on (the TIME FRAME selector). */
const HOLDS = [['1h', 1 * 3600000], ['2h', 2 * 3600000], ['6h', 6 * 3600000], ['12h', 12 * 3600000], ['24h', 24 * 3600000]];
const TRADES = {
  fast: { tp: 0.10, sl: -0.07, horizon: 6 * H, label: '+10% / -7% within 6h' },
  swing: { tp: PLAN_RULES.targetPct / 100, sl: -PLAN_RULES.stopPct / 100, horizon: PLAN_RULES.horizonHours * H,
    label: '+' + PLAN_RULES.targetPct + '% / -' + PLAN_RULES.stopPct + '% within ' + PLAN_RULES.horizonHours + 'h (the TRADE PLAN)' },
};
/** Smart, as of a moment: enough resolved buys, on more than one token, winning at twice the base rate. */
const SMART = { minResolved: 3, minTokens: 2, minRate: 0.40, minBuyUsd: 20 };
const fin = Number.isFinite;

/* ------------------------------------------------------------ reading -- */

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) fn(line);
}

const pools = new Map();      // chain|pool -> { chain, pool, token, symbol, samples: Map(t -> s) }
const prices = new Map();     // chain|token -> Map(t -> price)
const holders = new Map();    // chain|token -> [[t, count]]
const created = new Map();    // chain|pool -> ms
const capRef = new Map();     // chain|token -> { cap, price }
const jupHolders = new Map(); // chain|token -> [[t, count]]
const tapes = new Map();      // chain|pool -> Map(key -> trade)
const since = Date.now() - SINCE_DAYS * 86400000;

function addPrice(key, t, p) {
  if (!fin(p) || p <= 0 || !fin(t)) return;
  if (!prices.has(key)) prices.set(key, new Map());
  prices.get(key).set(t, p);
}

async function readLog() {
  const dir = path.join(DATA, 'log');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}(\.1m)?\.jsonl$/.test(f)).sort();
  for (const f of files) {
    if (Date.parse(f.slice(0, 10)) < since - 86400000) continue;
    await eachLine(path.join(dir, f), (line) => {
      const kind = (line.match(/"kind":"([^"]+)"/) || [])[1];
      if (!['pool', 'observation', 'holders', 'snapshot', 'trades'].includes(kind)) return;
      let r; try { r = JSON.parse(line); } catch (e) { return; }
      if (kind === 'pool') {
        const key = r.chain + '|' + r.pool;
        let p = pools.get(key);
        if (!p) { p = { chain: r.chain, pool: r.pool, token: r.token, symbol: r.symbol, samples: new Map() }; pools.set(key, p); }
        if (r.token) p.token = r.token;
        for (const s of r.samples || []) {
          if (!fin(s.t)) continue;
          p.samples.set(s.t, s);
          if (p.token) addPrice(r.chain + '|' + p.token, s.t, s.priceUsd);
        }
      } else if (kind === 'observation') {
        for (const s of r.series || []) addPrice(r.chain + '|' + r.token, s.t, s.price);
      } else if (kind === 'holders') {
        const key = r.chain + '|' + r.token;
        if (!holders.has(key)) holders.set(key, []);
        // 0 is a provider that could not count, not a count (the flow's HOLDER COUNT agrees).
        for (const s of r.series || []) if (fin(s.count) && s.count > 0) holders.get(key).push([s.t, s.count]);
      } else if (kind === 'trades') {
        const key = r.chain + '|' + r.pool;
        if (!tapes.has(key)) tapes.set(key, new Map());
        const tape = tapes.get(key);
        for (const x of r.trades || []) {
          if (!x || !fin(x.at) || !x.wallet) continue;
          tape.set(x.at + '|' + x.wallet + '|' + x.kind + '|' + x.usd,
            { wallet: String(x.wallet).toLowerCase(), kind: x.kind, usd: x.usd, at: x.at });
        }
      } else if (kind === 'snapshot') {
        const at = fin(r.at) ? r.at : r.t;
        const ic = (r.keys || []).indexOf('gt.poolCreatedAt');
        const id = (r.keys || []).indexOf('ds.pairCreatedAt');
        const ih = (r.keys || []).indexOf('jup.holderCount');
        for (const row of r.rows || []) {
          const c = (ic >= 0 && row.v[ic]) || (id >= 0 && row.v[id]);
          if (fin(c)) created.set(r.chain + '|' + row.pool, c);
          if (ih >= 0 && fin(row.v[ih]) && row.v[ih] > 0 && row.token) {
            const key = r.chain + '|' + row.token;
            if (!jupHolders.has(key)) jupHolders.set(key, []);
            jupHolders.get(key).push([at, row.v[ih]]);
          }
        }
      }
    });
  }
}

/** Pool ages and market caps the snapshots never covered: the current market files. */
function readMarketFiles() {
  const raw = path.join(DATA, 'raw');
  if (!fs.existsSync(raw)) return;
  for (const chain of fs.readdirSync(raw)) {
    const f = path.join(raw, chain, 'market.json');
    if (!fs.existsSync(f)) continue;
    let d; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { continue; }
    for (const row of d.rows || []) {
      const s = row.sources || {};
      const ds = s.dexscreener || {}; const gt = s.geckoterminal || {};
      const c = gt.poolCreatedAt || ds.pairCreatedAt;
      const key = chain + '|' + row.poolAddress;
      if (fin(c) && !created.has(key)) created.set(key, c);
      const cap = ds.marketCapUsd || gt.marketCapUsd || ds.fdvUsd || gt.fdvUsd;
      const price = ds.priceUsd || gt.priceUsd;
      if (fin(cap) && fin(price) && price > 0) capRef.set(chain + '|' + row.tokenAddress, { cap, price });
    }
  }
}

/**
 * The score trail. Hours recorded under the retired fifteen-input model carry
 * its component keys (volumeAnomaly...); their headline column is the old
 * board score, graded beside the flow for as long as those hours are kept.
 */
const oldTrail = new Map();   // chain|token -> [[t, oldScore]]
function readTrail() {
  const app = path.join(DATA, 'app');
  if (!fs.existsSync(app)) return;
  for (const chain of fs.readdirSync(app)) {
    const dir = path.join(app, chain, 'trail');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).sort()) {
      let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
      if (!(d.keys || []).includes('volumeAnomaly')) continue;
      for (const [token, marks] of Object.entries(d.tokens || {})) {
        const key = chain + '|' + token;
        if (!oldTrail.has(key)) oldTrail.set(key, []);
        for (const m of marks) if (fin(m[1])) oldTrail.get(key).push([m[0], m[1]]);
      }
    }
  }
  oldTrail.forEach((list) => list.sort((a, b) => a[0] - b[0]));
}

/* ------------------------------------------------------------ helpers -- */

function lastAtOrBefore(ts, t) {
  let lo = 0; let hi = ts.length - 1; let ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

/** One trade from pts[i0]: barriers, else closed at the horizon. dir 1 long, -1 short. */
function trade(pts, i0, cfg, dir = 1) {
  const p0 = pts[i0][1]; const end = pts[i0][0] + cfg.horizon;
  let i = i0 + 1;
  for (; i < pts.length && pts[i][0] <= end; i++) {
    const r = dir * (pts[i][1] / p0 - 1);
    if (r >= cfg.tp) return cfg.tp;
    if (r <= cfg.sl) return cfg.sl;
  }
  const j = i - 1;
  if (j > i0 && end - pts[j][0] < 20 * MIN && (i < pts.length || pts[j][0] >= end - 20 * MIN)) return dir * (pts[j][1] / p0 - 1);
  return null;   // the record ends early - unresolved, never a guess
}

function rank(xs) {
  const o = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < o.length;) {
    let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++;
    for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
}
function spearman(a, b) {
  if (a.length < 8) return null;
  const ra = rank(a); const rb = rank(b); const n = a.length; const ma = (n - 1) / 2;
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : null;
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const sd = (xs) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : null; };
const r3 = (x) => (fin(x) ? Math.round(x * 1000) / 1000 : null);
const pct = (x) => (fin(x) ? Math.round(x * 10000) / 100 : null);
const quantiles = (xs) => {
  const s = xs.filter(fin).sort((a, b) => a - b);
  const q = (p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
  return { n: s.length, p10: r3(q(0.1)), p25: r3(q(0.25)), p50: r3(q(0.5)), p75: r3(q(0.75)), p90: r3(q(0.9)) };
};
const get = (field) => (typeof field === 'function' ? field : (r) => r[field]);

/** Rank IC per hour, averaged, with its t-stat. */
function ic(rows, field, y) {
  const f = get(field); const byHour = new Map();
  for (const r of rows) {
    const x = f(r);
    if (!fin(x) || !fin(r[y])) continue;
    const h = Math.floor(r.t / H);
    if (!byHour.has(h)) byHour.set(h, { x: [], y: [] });
    byHour.get(h).x.push(x); byHour.get(h).y.push(r[y]);
  }
  const ics = [];
  byHour.forEach((g) => { const v = spearman(g.x, g.y); if (v !== null) ics.push(v); });
  if (ics.length < 4) return { ic: null, t: null, hours: ics.length };
  const m = mean(ics); const s = sd(ics);
  return { ic: r3(m), t: s ? Math.round((m / (s / Math.sqrt(ics.length))) * 10) / 10 : null, hours: ics.length };
}

/** The recommendation list: top K per hour, against every scored token. */
function topK(rows, field, y, k = 10) {
  const f = get(field); const byHour = new Map();
  for (const r of rows) {
    const x = f(r);
    if (!fin(x) || !fin(r[y])) continue;
    const h = Math.floor(r.t / H);
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push([x, r[y]]);
  }
  const top = []; const all = [];
  byHour.forEach((g) => { g.sort((a, b) => b[0] - a[0]); g.slice(0, k).forEach((p) => top.push(p[1])); g.forEach((p) => all.push(p[1])); });
  if (!top.length) return null;
  return {
    picks: top.length,
    avgTradePct: pct(mean(top)), winPct: pct(mean(top.map((v) => (v > 0 ? 1 : 0)))),
    boardAvgTradePct: pct(mean(all)), boardWinPct: pct(mean(all.map((v) => (v > 0 ? 1 : 0)))),
    edgePct: pct(mean(top) - mean(all)),
  };
}

/* --------------------------------------------------------------- main -- */

await readLog();
readMarketFiles();
readTrail();

const priceSeries = new Map();
prices.forEach((m, key) => priceSeries.set(key, Array.from(m.entries()).sort((a, b) => a[0] - b[0])));
const priceTimes = new Map();
priceSeries.forEach((px, key) => priceTimes.set(key, px.map((x) => x[0])));

// Every buy's own outcome, known only once its 6 hours are over.
const tapeLists = new Map();
const walletEvents = new Map();
let buysJudged = 0; let buysWon = 0;
tapes.forEach((tape, poolKey) => {
  const list = Array.from(tape.values()).sort((a, b) => a.at - b.at);
  tapeLists.set(poolKey, list);
  const p = pools.get(poolKey);
  if (!p || !p.token) return;
  const tokenKey = p.chain + '|' + p.token;
  const px = priceSeries.get(tokenKey); const pts = priceTimes.get(tokenKey);
  if (!px) return;
  for (const x of list) {
    if (x.kind !== 'buy' || !fin(x.usd) || x.usd < SMART.minBuyUsd) continue;
    const k = lastAtOrBefore(pts, x.at);
    if (k < 0 || x.at - pts[k] > 5 * MIN) continue;
    const o = trade(px, k, TRADES.fast);
    if (o === null) continue;
    const win = o >= TRADES.fast.tp ? 1 : 0;
    buysJudged += 1; buysWon += win;
    if (!walletEvents.has(x.wallet)) walletEvents.set(x.wallet, []);
    walletEvents.get(x.wallet).push([x.at + TRADES.fast.horizon, tokenKey, win]);
  }
});
const walletRecord = new Map();
walletEvents.forEach((ev, wallet) => {
  ev.sort((a, b) => a[0] - b[0]);
  const times = []; const n = []; const wins = []; const tokens = []; const seen = new Set(); let w = 0;
  ev.forEach((e, i) => { seen.add(e[1]); w += e[2]; times.push(e[0]); n.push(i + 1); wins.push(w); tokens.push(seen.size); });
  walletRecord.set(wallet, { times, n, wins, tokens });
});
function smartAt(wallet, t) {
  const r = walletRecord.get(wallet);
  if (!r) return false;
  const i = lastAtOrBefore(r.times, t);
  return i >= 0 && r.n[i] >= SMART.minResolved && r.tokens[i] >= SMART.minTokens && r.wins[i] / r.n[i] >= SMART.minRate;
}

// THE BOARD, moment by moment: the median 6h price change of every screened
// token, kept on each row (board6h) to grade calls against the market. A BUY
// gate on it was tested Oct 13 2026 and rejected: the training hours never
// saw the board below -1%, and in the test hours BUYs made while it bled
// worst (under -3%) were the best ones.
const boardAt = new Map();   // t -> median 6h change, %
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
{
  const tokens = new Map();
  for (const p of pools.values()) if (p.token && !tokens.has(p.chain + '|' + p.token)) tokens.set(p.chain + '|' + p.token, p.symbol);
  const changes = new Map();
  tokens.forEach((symbol, key) => {
    const px = priceSeries.get(key); const pts = priceTimes.get(key); const ref = capRef.get(key);
    if (!px || px.length < 2) return;
    for (let t = Math.ceil(pts[0] / STEP) * STEP; t <= pts[pts.length - 1]; t += STEP) {
      const k = lastAtOrBefore(pts, t); const k0 = lastAtOrBefore(pts, t - 6 * H);
      if (k < 0 || k0 < 0 || t - pts[k] > 5 * MIN || t - 6 * H - pts[k0] > 15 * MIN) continue;
      const cap = ref ? ref.cap * (px[k][1] / ref.price) : null;
      if (isMajorToken({ symbol, marketCapUsd: cap })) continue;
      if (!changes.has(t)) changes.set(t, []);
      changes.get(t).push((px[k][1] / px[k0][1] - 1) * 100);
    }
  });
  changes.forEach((list, t) => { if (list.length >= 10) boardAt.set(t, median(list)); });
}

/**
 * The candidate engine's BUY / WATCH, for one moment: the flow's SIGNAL logic
 * (flow/score-flow.js callFor and the hold rule) on the re-weighted EARLY.
 * `memory` is the candidate's own last call per token, like the flow's.
 */
const candMemory = new Map();
function candidateCall(key, t, flow, inputs, board) {
  const r = PHASE_RULES;
  let w = 0; let u = 0; let present = 0;
  EARLY_MODEL.forEach((c) => { const x = inputs[c.key]; if (fin(x)) { w += x * CAND_WEIGHTS[c.key]; u += CAND_WEIGHTS[c.key]; present += 1; } });
  const raw = present >= EARLY_MIN_PARTS && u ? Math.round(w / u) : null;
  const early = raw === null ? null : (flow.vetoed ? 0 : raw);
  const bleeding = BOARD_MIN !== null && fin(board) && board < BOARD_MIN;
  let s;
  if (['SELL', 'SHORT', 'AVOID'].includes(flow.signal) || !flow.phase) s = flow.signal;
  else if (flow.phase === 'WAKING' && !flow.vetoed && fin(early) && early >= r.buyMinEarly && !bleeding) s = 'BUY';
  else s = 'WATCH';
  const prev = candMemory.get(key);
  const fresh = prev && t >= prev.t && t - prev.t <= r.holdMemoryMin * MIN;
  let held = false;
  if (fresh && s === 'WATCH' && prev.s === 'BUY' && !bleeding && !flow.vetoed) {
    if (flow.phase === 'WAKING' && fin(early) && early >= r.buyHoldEarly) held = true;
    else if (flow.phase === 'QUIET' && t - prev.since <= r.buyQuietHoldMin * MIN) held = true;
    if (held) s = 'BUY';
  }
  if (s) candMemory.set(key, { s, t, since: held ? prev.since : t });
  return { signal: s, early };
}

// Every pool's tape, by wallet, per chain - for ROTATION (a wallet selling one
// token to buy another). The flow keeps only trades at or before each moment.
const walletTapes = new Map();   // chain -> { size, tradesOf }
{
  const byChain = new Map();
  tapeLists.forEach((list, key) => {
    const [chain, pool] = key.split('|');
    if (!byChain.has(chain)) byChain.set(chain, new Map());
    const m = byChain.get(chain);
    list.forEach((x) => { if (!m.has(x.wallet)) m.set(x.wallet, []); m.get(x.wallet).push({ pool, kind: x.kind, usd: x.usd, at: x.at }); });
  });
  byChain.forEach((m, chain) => walletTapes.set(chain, { size: m.size, tradesOf: (w) => m.get(w) || [] }));
}

let perpSymbols = {};
try { perpSymbols = JSON.parse(fs.readFileSync(path.join(DATA, 'raw', 'perps.json'), 'utf8')).symbols || {}; } catch (e) { perpSymbols = {}; }

const rows = [];
for (const p of pools.values()) {
  if (!p.token) continue;
  const S = Array.from(p.samples.values()).sort((a, b) => a.t - b.t);
  if (S.length < 50) continue;
  const ts = S.map((s) => s.t);
  const tokenKey = p.chain + '|' + p.token;
  const px = priceSeries.get(tokenKey) || [];
  const pts = priceTimes.get(tokenKey) || [];
  const hs = (holders.get(tokenKey) || []).sort((a, b) => a[0] - b[0]); const hts = hs.map((x) => x[0]);
  const js = (jupHolders.get(tokenKey) || []).sort((a, b) => a[0] - b[0]); const jts = js.map((x) => x[0]);
  const c = created.get(p.chain + '|' + p.pool);
  const ref = capRef.get(tokenKey);
  const old = oldTrail.get(tokenKey); const oldTs = old ? old.map((m) => m[0]) : [];
  const tape = tapeLists.get(p.chain + '|' + p.pool) || []; const tapeTs = tape.map((x) => x.at);
  const listedOn = perpSymbols[String(p.symbol || '').toUpperCase()] || [];

  for (let t = Math.ceil(S[0].t / STEP) * STEP + STEP; t <= S[S.length - 1].t; t += STEP) {
    if (t < since) continue;
    const i = lastAtOrBefore(ts, t);
    if (i < 0 || t - ts[i] > 5 * MIN) continue;
    // The board's own screen (core.js screenRows): stables, wrapped natives
    // and majors are never candidates, so they are never graded either.
    const capNow = ref && fin(S[i].priceUsd) ? ref.cap * (S[i].priceUsd / ref.price) : null;
    if (isMajorToken({ symbol: p.symbol, marketCapUsd: capNow })) continue;
    const j0 = lastAtOrBefore(ts, t - 6 * H - MIN) + 1;
    const hi = lastAtOrBefore(hts, t); const ji = lastAtOrBefore(jts, t);
    const holdersNow = hi >= 0 && t - hs[hi][0] < 6 * H ? hs[hi][1] : (ji >= 0 && t - js[ji][0] < 6 * H ? js[ji][1] : null);
    // The pool's trade tape as the app would hold it: the last two hours.
    const a = lastAtOrBefore(tapeTs, t - 2 * H) + 1; const b = lastAtOrBefore(tapeTs, t);
    const trades = b >= a ? tape.slice(a, b + 1) : [];
    // THE MODEL: the app's own flow, fed this moment's inputs.
    const out = flowScore({
      chain: p.chain, tokenAddress: p.token, poolAddress: p.pool, symbol: p.symbol,
      priceUsd: S[i].priceUsd, liquidityUsd: S[i].liquidityUsd,
      poolAgeHours: fin(c) && t > c ? (t - c) / H : null,
    }, {
      now: t,
      samples: S.slice(Math.max(0, j0), i + 1),
      own: trades.length ? { trades, stats: tradeStatsFrom(trades) } : null,
      intel: holdersNow ? { holders: { count: holdersNow } } : null,
      listing: { perp: { listedOn, checked: 1, total: 1, labels: {} } },
      // A wallet is smart only from what was known at this moment.
      smartWallets: { has: (w) => smartAt(w, t), size: walletRecord.size },
      walletTape: walletTapes.get(p.chain) || null,
    });
    const row = {
      chain: p.chain, token: p.token, symbol: p.symbol, t, liquidity: S[i].liquidityUsd,
      early: out.score, signal: out.signal, phase: out.phase, board6h: boardAt.has(t) ? boardAt.get(t) : null,
      smartBuyers: out.smart.buyers, smartSellers: out.smart.sellers, measures: out.measures,
    };
    out.scoreModel.forEach((m) => { row[m.key] = m.pending ? null : m.value; });
    // Every engine's own score and call, graded side by side.
    ENGINES.forEach((e) => { row['call.' + e.key] = out.engines[e.key].signal; row['score.' + e.key] = out.engines[e.key].score; });
    row.vetoed = out.vetoed;
    row.mktNet = out.flowValues['f:pipe:MARKET NET FLOW 2H']; row.mktConn = out.flowValues['f:pipe:CONNECTED POOLS 2H'];
    row.cost1k = out.flowValues['f:pipe:EXECUTION COST'];
    if (CANDIDATE) {
      const cand = candidateCall(p.chain + ':' + p.token, t, out, row, row.board6h);
      row.candSignal = cand.signal; row.candEarly = cand.early;
    }
    const k = lastAtOrBefore(pts, t);
    if (k >= 0 && t - pts[k] <= 5 * MIN) {
      row.fast = trade(px, k, TRADES.fast); row.swing = trade(px, k, TRADES.swing);
      row.shortFast = trade(px, k, TRADES.fast, -1); row.shortSwing = trade(px, k, TRADES.swing, -1);
      // HOLDING WINDOWS: the plain return after each window, no target or stop.
      HOLDS.forEach(([label, ms]) => { row['hold' + label] = trade(px, k, { horizon: ms, tp: Infinity, sl: -Infinity }); });
    }
    if (old) {
      const q = lastAtOrBefore(oldTs, t);
      if (q >= 0 && t - oldTs[q] <= 5 * MIN) row.oldBoard = old[q][1];
    }
    rows.push(row);
  }
}

// One row per token per moment, like screenRows: the deepest pool wins.
{
  const best = new Map();
  rows.forEach((r) => {
    const k = r.chain + '|' + r.token + '|' + r.t;
    const seen = best.get(k);
    if (!seen || (r.liquidity || 0) > (seen.liquidity || 0)) best.set(k, r);
  });
  rows.length = 0;
  best.forEach((r) => rows.push(r));
}
if (!rows.length) { console.error('nothing to grade in ' + DATA); process.exit(1); }

const times = rows.map((r) => r.t).sort((a, b) => a - b);
const cut = times[Math.floor(times.length * 0.6)];
const train = rows.filter((r) => r.t < cut);
const test = rows.filter((r) => r.t >= cut);

const inputs = {};
EARLY_MODEL.forEach((c) => { inputs[c.label] = { key: c.key, score: 'EARLY', fast: ic(rows, c.key, 'fast'), swing: ic(rows, c.key, 'swing') }; });

// Walk-forward: weights refitted from TRAIN ICs only (negatives dropped), judged on TEST.
const fitted = {};
EARLY_MODEL.forEach((c) => {
  const v = mean([ic(train, c.key, 'fast').ic, ic(train, c.key, 'swing').ic].filter(fin));
  fitted[c.key] = fin(v) && v > 0 ? Math.round(v * 200) : 0;
});
const fittedScore = (r) => {
  let w = 0; let u = 0; let n = 0;
  EARLY_MODEL.forEach((c) => { if (fin(r[c.key]) && fitted[c.key] > 0) { w += r[c.key] * fitted[c.key]; u += fitted[c.key]; n += 1; } });
  return n >= EARLY_MIN_PARTS && u ? w / u : null;
};

const scoreReport = (field) => ({
  all: { fast: ic(rows, field, 'fast'), swing: ic(rows, field, 'swing') },
  test: { fast: ic(test, field, 'fast'), swing: ic(test, field, 'swing') },
  top10: { fast: topK(rows, field, 'fast'), swing: topK(rows, field, 'swing') },
  top10Test: { fast: topK(test, field, 'fast'), swing: topK(test, field, 'swing') },
});
// The average alone misleads on memes: a few big runners can lift it while
// most trades lose. So the median trade and the average win and loss too.
const tradeStats = (vals) => {
  const v = vals.filter(fin);
  if (!v.length) return null;
  const sorted = v.slice().sort((a, b) => a - b);
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const wins = v.filter((x) => x > 0); const losses = v.filter((x) => x <= 0);
  return { n: v.length, avgPct: pct(mean(v)), winPct: pct(mean(v.map((x) => (x > 0 ? 1 : 0)))), medianPct: pct(mid),
    avgWinPct: wins.length ? pct(mean(wins)) : null, avgLossPct: losses.length ? pct(mean(losses)) : null };
};
const groupReport = (field, values) => Object.fromEntries(values.map((name) => {
  const g = rows.filter((r) => r[field] === name);
  return [name, {
    moments: g.length,
    long: { fast: tradeStats(g.map((r) => r.fast)), swing: tradeStats(g.map((r) => r.swing)) },
    short: { fast: tradeStats(g.map((r) => r.shortFast)), swing: tradeStats(g.map((r) => r.shortSwing)) },
  }];
}));
const everyone = {
  long: { fast: tradeStats(rows.map((r) => r.fast)), swing: tradeStats(rows.map((r) => r.swing)) },
  short: { fast: tradeStats(rows.map((r) => r.shortFast)), swing: tradeStats(rows.map((r) => r.shortSwing)) },
};
const hasOld = rows.some((r) => fin(r.oldBoard));

// BUY ENTRIES: the moment a token turns BUY (it was not BUY 15 minutes before),
// the trade a user acting on the call would actually take. Judged on the
// walk-forward split too: TRAIN hours are what a setting was chosen on, TEST
// hours what it is judged on.
{
  const byToken = new Map();
  rows.forEach((r) => { const k = r.chain + '|' + r.token; if (!byToken.has(k)) byToken.set(k, []); byToken.get(k).push(r); });
  byToken.forEach((list) => {
    list.sort((a, b) => a.t - b.t);
    list.forEach((r, i) => {
      const prev = list[i - 1]; const last = prev && prev.t === r.t - STEP;
      r.buyEntry = r.signal === 'BUY' && !(last && prev.signal === 'BUY');
      ENGINES.forEach((e) => { const k = 'call.' + e.key; r['entry.' + e.key] = r[k] === 'BUY' && !(last && prev[k] === 'BUY'); });
      if (CANDIDATE) r.candEntry = r.candSignal === 'BUY' && !(last && prev.candSignal === 'BUY');
    });
  });
}
const longStats = (g) => ({ moments: g.length, fast: tradeStats(g.map((r) => r.fast)), swing: tradeStats(g.map((r) => r.swing)) });
const splitStats = (pick) => ({ all: longStats(rows.filter(pick)), train: longStats(train.filter(pick)), test: longStats(test.filter(pick)) });
const buyReport = {
  entries: splitStats((r) => r.buyEntry),
  states: splitStats((r) => r.signal === 'BUY'),
  ...(CANDIDATE ? { 'cand entries': splitStats((r) => r.candEntry), 'cand states': splitStats((r) => r.candSignal === 'BUY') } : {}),
  board: splitStats(() => true),
};

// ENGINES: each engine's calls graded the same way - its BUY entries and BUY
// states as a long, its SELL / SHORT as a short, its score's IC - on all,
// TRAIN and TEST hours.
const shortStats = (g) => ({ moments: g.length, fast: tradeStats(g.map((r) => r.shortFast)), swing: tradeStats(g.map((r) => r.shortSwing)) });
const engineReport = Object.fromEntries(ENGINES.map((e) => {
  const call = 'call.' + e.key;
  const isExit = (r) => r[call] === 'SELL' || r[call] === 'SHORT';
  return [e.key, {
    label: e.label,
    entries: splitStats((r) => r['entry.' + e.key]),
    states: splitStats((r) => r[call] === 'BUY'),
    exits: { all: shortStats(rows.filter(isExit)), test: shortStats(test.filter(isExit)) },
    buyShare: pct(rows.filter((r) => r[call] === 'BUY').length / rows.length),
    score: { fast: ic(rows, 'score.' + e.key, 'fast'), swing: ic(rows, 'score.' + e.key, 'swing'),
      covered: rows.filter((r) => fin(r['score.' + e.key])).length },
  }];
}));

// WALK-FORWARD per engine: each engine's BUY line chosen on TRAIN hours only
// (the line whose entries paid best, with at least 30 of them), then judged on
// TEST hours it never saw. Entries are re-derived from the score, the phase and
// the gates (no hold rule), so every line is tried the same way.
const LATE = ENGINE_RULES.lateUpPct;
const zoneOf = (key, r) => r.phase === 'WAKING' || (key !== 'cycle' && r.phase === 'RUNNING' && fin(r.measures.aboveLow6hPct) && r.measures.aboveLow6hPct < LATE);
const entriesAt = (list, key, line) => {
  const byToken = new Map();
  list.forEach((r) => { const k = r.chain + '|' + r.token; if (!byToken.has(k)) byToken.set(k, []); byToken.get(k).push(r); });
  const out = [];
  byToken.forEach((rs) => {
    rs.sort((a, b) => a.t - b.t);
    let on = false; let lastT = -Infinity;
    rs.forEach((r) => {
      const sc = r['score.' + key];
      const buy = !r.vetoed && zoneOf(key, r) && fin(sc) && sc >= line;
      if (buy && !(on && r.t - lastT <= STEP)) out.push(r);
      on = buy; lastT = r.t;
    });
  });
  return out;
};
const TEST_DAYS = Math.max(1 / 24, (test.reduce((m, r) => Math.max(m, r.t), 0) - test.reduce((m, r) => Math.min(m, r.t), Infinity)) / 86400000);
// MARKET-RELATIVE: a trade's return minus the same trade on every token in
// the same hour, so a down day cannot hide a good engine nor an up day
// flatter a bad one. PER TOKEN: each token counts once (the mean of its
// entries), so one token's long run of moments cannot carry an engine.
const hourOf = (t) => Math.floor(t / H);
const boardHour = new Map();
rows.forEach((r) => { if (!fin(r.fast)) return; const k = hourOf(r.t); const b = boardHour.get(k) || { s: 0, n: 0 }; b.s += r.fast; b.n += 1; boardHour.set(k, b); });
const excessOf = (r) => { const b = boardHour.get(hourOf(r.t)); return fin(r.fast) && b && b.n >= 20 ? r.fast - b.s / b.n : null; };
const perToken = (list, f) => {
  const by = new Map();
  list.forEach((r) => { const x = f(r); if (!fin(x)) return; const k = r.chain + '|' + r.token; if (!by.has(k)) by.set(k, []); by.get(k).push(x); });
  return tradeStats(Array.from(by.values()).map((v) => mean(v)));
};
const LINES = [30, 40, 50, 60, 70, 80, 85, 90, 95, 100];
const walkForward = Object.fromEntries(ENGINES.map((e) => {
  const tried = LINES.map((line) => {
    const tr = entriesAt(train, e.key, line); const sw = tradeStats(tr.map((r) => r.swing));
    return { line, n: tr.length, swing: sw };
  });
  const ok = tried.filter((x) => x.swing && x.swing.n >= 30);
  const best = ok.sort((a, b) => b.swing.avgPct - a.swing.avgPct)[0] || null;
  const te = best ? entriesAt(test, e.key, best.line) : [];
  return [e.key, {
    label: e.label, line: best ? best.line : null, trainSwing: best ? best.swing : null,
    test: { entries: te.length, tokens: new Set(te.map((r) => r.chain + '|' + r.token)).size,
      excess: tradeStats(te.map(excessOf)), perTokenFast: perToken(te, (r) => r.fast), perTokenExcess: perToken(te, excessOf),
      fast: tradeStats(te.map((r) => r.fast)), swing: tradeStats(te.map((r) => r.swing)),
      perDay: Math.round(te.length / TEST_DAYS * 10) / 10 },
    tried,
  }];
}));
// BY HOLDING WINDOW: each engine's BUY entries held for 1h ... 24h (a long),
// and its SELL / SHORT calls held the same (a short), market-relative and
// per token - which window each engine's calls actually pay over.
const holdReport = Object.fromEntries(ENGINES.map((e) => {
  const ent = rows.filter((r) => r['entry.' + e.key]);
  const ex = rows.filter((r) => r['call.' + e.key] === 'SELL' || r['call.' + e.key] === 'SHORT');
  return [e.key, Object.fromEntries(HOLDS.map(([label]) => {
    const k = 'hold' + label;
    const bh = new Map();
    rows.forEach((r) => { if (!fin(r[k])) return; const h = hourOf(r.t); const b = bh.get(h) || { s: 0, n: 0 }; b.s += r[k]; b.n += 1; bh.set(h, b); });
    const rel = (r, d) => { const b = bh.get(hourOf(r.t)); return fin(r[k]) && b && b.n >= 20 ? d * (r[k] - b.s / b.n) : null; };
    return [label, {
      buy: tradeStats(ent.map((r) => r[k])), buyVsMarket: tradeStats(ent.map((r) => rel(r, 1))), buyPerToken: perToken(ent, (r) => r[k]),
      buyTest: tradeStats(ent.filter((r) => r.t >= cut).map((r) => rel(r, 1))),
      // NET OF COST: the raw return minus a round trip at each trade size (the
      // archive has no route quotes, so the calibrated depth estimate).
      buyNet: Object.fromEntries(TRADE_SIZES.map((size) => [size, tradeStats(ent.map((r) => {
        const c = roundTripCostPct(r.liquidity, size, null); return fin(r[k]) && fin(c) ? r[k] - c / 100 : null;
      }))])),
      buyNetTest: Object.fromEntries(TRADE_SIZES.map((size) => [size, tradeStats(ent.filter((r) => r.t >= cut).map((r) => {
        const c = roundTripCostPct(r.liquidity, size, null); return fin(r[k]) && fin(c) ? r[k] - c / 100 : null;
      }))])),
      exit: tradeStats(ex.map((r) => (fin(r[k]) ? -r[k] : null))), exitVsMarket: tradeStats(ex.map((r) => rel(r, -1))),
    }];
  }))];
}));
const boardHold = Object.fromEntries(HOLDS.map(([label]) => [label, tradeStats(rows.map((r) => r['hold' + label]))]));

const report = {
  generatedAt: Date.now(),
  model: 'flow/score-flow.js',
  data: path.resolve(DATA),
  window: { from: times[0], to: times[times.length - 1], splitAt: cut },
  moments: rows.length,
  tokens: new Set(rows.map((r) => r.chain + '|' + r.token)).size,
  resolved: { fast: rows.filter((r) => fin(r.fast)).length, swing: rows.filter((r) => fin(r.swing)).length },
  trades: TRADES,
  scores: {
    EARLY: scoreReport('early'),
    ...(hasOld ? { 'OLD BOARD SCORE (retired)': scoreReport('oldBoard') } : {}),
    'EARLY (walk-forward weights)': { test: { fast: ic(test, fittedScore, 'fast'), swing: ic(test, fittedScore, 'swing') },
      top10Test: { fast: topK(test, fittedScore, 'fast'), swing: topK(test, fittedScore, 'swing') } },
  },
  inputs,
  signals: groupReport('signal', SIGNALS),
  phases: groupReport('phase', PHASES),
  signalSide: { BUY: 'long', SELL: 'short', SHORT: 'short', AVOID: 'long', WATCH: 'long' },
  everyone,
  buy: buyReport,
  engines: engineReport,
  walkForward,
  holds: { windows: HOLDS.map((h) => h[0]), engines: holdReport, board: boardHold },
  ...(CANDIDATE ? { candidate: { weights: CAND_WEIGHTS, boardMinPct: BOARD_MIN, signals: groupReport('candSignal', SIGNALS) } } : {}),
  smart: {
    rule: SMART, buysJudged, baseWinPct: pct(buysJudged ? buysWon / buysJudged : null),
    covered: rows.filter((r) => fin(r.smartBuyers)).length,
    buyers: { long: ic(rows, 'smartBuyers', 'fast'), short: ic(rows, 'smartBuyers', 'shortFast') },
    sellers: { long: ic(rows, 'smartSellers', 'fast'), short: ic(rows, 'smartSellers', 'shortFast') },
  },
  measures: Object.fromEntries(['aboveLow6hPct', 'belowHigh6hPct', 'range1hPct', 'buysPerBuyer', 'volAccel', 'buyerTrend']
    .map((k) => [k, quantiles(rows.map((r) => r.measures[k]))])),
  weights: { current: Object.fromEntries(EARLY_MODEL.map((c) => [c.key, c.weight])), fittedOnTrain: fitted },
};

/* ------------------------------------------------------------ printing -- */

const f3 = (x) => (fin(x) ? (x >= 0 ? '+' : '') + x.toFixed(3) : '   n/a');
const icStr = (o) => (o && fin(o.ic) ? f3(o.ic) + ' (t' + (fin(o.t) ? (o.t >= 0 ? '+' : '') + o.t : 'n/a') + ')' : 'n/a');
const tk = (o) => (o ? 'top-10/h ' + o.avgTradePct + '% avg, ' + o.winPct + '% win  vs board ' + o.boardAvgTradePct + '% / ' + o.boardWinPct + '%' : 'no picks');
const tsStr = (o) => (o ? (o.avgPct >= 0 ? '+' : '') + o.avgPct + '% win ' + Math.round(o.winPct) + '% (n=' + o.n + ')' : 'n/a');
console.log('graded ' + report.moments + ' moments, ' + report.tokens + ' tokens, ' +
  new Date(report.window.from).toISOString().slice(0, 16) + ' → ' + new Date(report.window.to).toISOString().slice(0, 16) +
  '  (model: ' + report.model + ')');
console.log('resolved trades: fast ' + report.resolved.fast + ', swing ' + report.resolved.swing + '\n');
for (const [name, s] of Object.entries(report.scores)) {
  console.log(name);
  if (s.all) console.log('  all   IC fast ' + icStr(s.all.fast) + '   swing ' + icStr(s.all.swing));
  console.log('  test  IC fast ' + icStr(s.test.fast) + '   swing ' + icStr(s.test.swing));
  if (s.top10) console.log('  all   fast  ' + tk(s.top10.fast) + '\n        swing ' + tk(s.top10.swing));
  console.log('  test  fast  ' + tk(s.top10Test.fast) + '\n        swing ' + tk(s.top10Test.swing));
}
console.log('\nsignal   moments   as a LONG: fast | swing              as a SHORT: fast | swing');
for (const [name, g] of Object.entries(report.signals).concat([['(all)', Object.assign({ moments: rows.length }, everyone)]])) {
  console.log('  ' + name.padEnd(7) + String(g.moments).padStart(7) + '   ' + tsStr(g.long.fast) + ' | ' + tsStr(g.long.swing) +
    '   ' + tsStr(g.short.fast) + ' | ' + tsStr(g.short.swing));
}
console.log('\nENGINES  BUY entries as a LONG (all | test, swing)        BUY states (swing)      SELL/SHORT as a SHORT (swing)   score IC swing   BUY share');
for (const [k, g] of Object.entries(engineReport)) {
  console.log('  ' + g.label.padEnd(12) + String(g.entries.all.moments).padStart(5) + ' ' + tsStr(g.entries.all.swing) + ' | ' +
    String(g.entries.test.moments).padStart(4) + ' ' + tsStr(g.entries.test.swing) + '   ' + tsStr(g.states.all.swing) + '   ' +
    tsStr(g.exits.all.swing) + '   ' + icStr(g.score.swing) + ' n=' + g.score.covered + '   ' + g.buyShare + '%');
}
console.log('\nWALK-FORWARD  line chosen on TRAIN → judged on TEST (entries as a LONG)        fast 6h                 swing 24h          tokens  per day');
const boardTest = { fast: tradeStats(test.map((r) => r.fast)), swing: tradeStats(test.map((r) => r.swing)) };
for (const [k, g] of Object.entries(walkForward)) {
  console.log('  ' + g.label.padEnd(12) + ' line ' + String(g.line).padStart(4) + '  train ' + tsStr(g.trainSwing).padEnd(26) + ' test ' +
    String(g.test.entries).padStart(4) + '   ' + tsStr(g.test.fast).padEnd(24) + tsStr(g.test.swing).padEnd(26) + String(g.test.tokens).padStart(5) + '   ' + g.test.perDay);
}
console.log('\nWALK-FORWARD, judged on TEST: market-relative (minus every token, same hour) and per token (each token once), fast 6h');
for (const [k, g] of Object.entries(walkForward)) {
  console.log('  ' + g.label.padEnd(17) + ' line ' + String(g.line).padStart(4) + '   vs market ' + tsStr(g.test.excess).padEnd(26) + ' per token ' + tsStr(g.test.perTokenFast).padEnd(26) + ' per token vs market ' + tsStr(g.test.perTokenExcess));
}
console.log('  ' + 'every token'.padEnd(12) + ' '.repeat(52) + ' test     ' + tsStr(boardTest.fast).padEnd(24) + tsStr(boardTest.swing));
console.log('\nHOLDING WINDOW  BUY entries held, vs market (same hour)        ' + HOLDS.map((h) => h[0].padEnd(22)).join(''));
for (const [k, g] of Object.entries(holdReport)) {
  console.log('  ' + (ENGINES.find((e) => e.key === k).label).padEnd(17) + 'buy  ' + HOLDS.map(([l]) => tsStr(g[l].buyVsMarket).padEnd(22)).join(''));
  console.log('  ' + ''.padEnd(17) + 'test ' + HOLDS.map(([l]) => tsStr(g[l].buyTest).padEnd(22)).join(''));
}
console.log('  ' + 'board (raw)'.padEnd(17) + '     ' + HOLDS.map(([l]) => tsStr(boardHold[l]).padEnd(22)).join(''));
console.log('  ' + 'SELL/SHORT (as a short, vs market), CONSENSUS row is typical:');
console.log('  ' + ''.padEnd(17) + 'exit ' + HOLDS.map(([l]) => tsStr(holdReport.consensus[l].exitVsMarket).padEnd(22)).join(''));
console.log('\nNET OF EXECUTION COST  BUY entries held 6h, raw return minus a round trip      ' + TRADE_SIZES.map((x) => ('$' + x).padEnd(22)).join(''));
for (const [k, g] of Object.entries(holdReport)) {
  console.log('  ' + (ENGINES.find((e) => e.key === k).label).padEnd(17) + 'all  ' + TRADE_SIZES.map((x) => tsStr(g['6h'].buyNet[x]).padEnd(22)).join(''));
  console.log('  ' + ''.padEnd(17) + 'test ' + TRADE_SIZES.map((x) => tsStr(g['6h'].buyNetTest[x]).padEnd(22)).join(''));
}
console.log('\nBUY, as a LONG     all: fast | swing                       train: fast | swing                     test: fast | swing');
for (const [name, g] of Object.entries(buyReport)) {
  console.log('  ' + name.padEnd(13) + ['all', 'train', 'test'].map((k) => String(g[k].moments).padStart(6) + ' ' + tsStr(g[k].fast) + ' | ' + tsStr(g[k].swing)).join('   '));
}
console.log('\nphase     moments   as a LONG: fast | swing              as a SHORT: fast | swing');
for (const [name, g] of Object.entries(report.phases)) {
  console.log('  ' + name.padEnd(8) + String(g.moments).padStart(6) + '   ' + tsStr(g.long.fast) + ' | ' + tsStr(g.long.swing) +
    '   ' + tsStr(g.short.fast) + ' | ' + tsStr(g.short.swing));
}
console.log('\ninput                         IC fast            IC swing');
for (const [label, x] of Object.entries(inputs)) console.log('  ' + label.padEnd(28) + icStr(x.fast).padEnd(19) + icStr(x.swing));
console.log('\nsmart wallets: ' + buysJudged + ' buys judged (base ' + report.smart.baseWinPct + '% won), ' +
  report.smart.covered + ' moments with tape; buyers IC long ' + icStr(report.smart.buyers.long) + ', sellers IC short ' + icStr(report.smart.sellers.short));

if (DUMP) fs.writeFileSync(DUMP, JSON.stringify(rows));
if (WALLETS_OUT) {
  const wallets = {}; const now = Date.now();
  walletRecord.forEach((r, wallet) => {
    const i = r.times.length - 1;
    if (i >= 0 && smartAt(wallet, now)) wallets[wallet] = { buys: r.n[i], wins: r.wins[i], tokens: r.tokens[i] };
  });
  fs.writeFileSync(WALLETS_OUT, JSON.stringify({ generatedAt: now, rule: SMART, count: Object.keys(wallets).length, wallets }));
  console.log('\nwrote ' + WALLETS_OUT + ' (' + Object.keys(wallets).length + ' smart wallets)');
}
if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify(report));
  console.log('\nwrote ' + OUT);
}
// A dated copy per run day, so how the model performed can be compared over
// weeks rather than only the latest report being kept.
if (HISTORY) {
  fs.mkdirSync(HISTORY, { recursive: true });
  const file = path.join(HISTORY, new Date().toISOString().slice(0, 10) + '.json');
  fs.writeFileSync(file, JSON.stringify(report));
  console.log('wrote ' + file);
}
