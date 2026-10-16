/**
 * ASSET DETAIL - the raw inputs for one token, assembled for the model.
 *
 * The model itself is the DATA FLOW (flow/score-flow.js): EARLY, PHASE,
 * SIGNAL, the safety gates, the warnings and the trade plan are all boxes
 * there. This file only prepares what those boxes read and does no scoring:
 *
 *   raw intel   -> deriveIntel()    facts: safety checks, holders, impact
 *   row + files -> evaluateAsset()  the token's inputs, run through the flow
 *
 * Nothing here fetches. Raw numbers in, inputs out.
 */

import {
  toNumber, statsFor, normalizeJupiterToken, zScoresFrom, bucketBaselines, rotationFor,
} from './core.js';

const IMPACT_TRADE_USD = 10000;
const round = (v, dp) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

/* ============================================ intel -> facts ============= */

const truthy = (value) => value === '1' || value === 1 || value === true;

/**
 * GoPlus reports contract flags; this turns them into pass/fail checks with a
 * cost. The penalties are what a failure is worth to the risk score, and they
 * are weighted by how fatal the failure is: a honeypot ends the thesis, an
 * upgradable transfer hook merely complicates it.
 */
function goPlusChecks(chainKey, record) {
  if (!record) return [];
  const checks = [];
  const add = (label, bad, detail, penalty) =>
    checks.push({ label, ok: !bad, detail, penalty: bad ? penalty : 0 });

  if (chainKey === 'solana') {
    const authOn = (field) => Boolean(record[field] && truthy(record[field].status));
    add('Mint authority revoked', authOn('mintable'),
      authOn('mintable') ? 'Supply can still be minted' : 'Cannot mint more supply', 6);
    add('Freeze authority revoked', authOn('freezable'),
      authOn('freezable') ? 'Accounts can be frozen' : 'No freeze authority', 6);
    add('Account not closable', authOn('closable'),
      authOn('closable') ? 'Token accounts can be closed' : 'Not closable', 3);
    add('Balance not mutable', authOn('balance_mutable_authority'),
      authOn('balance_mutable_authority') ? 'Balances can be altered' : 'Balances immutable', 5);
    add('No transfer hook', authOn('transfer_hook_upgradable'),
      authOn('transfer_hook_upgradable') ? 'Transfer hook is upgradable' : 'No upgradable hook', 3);
    const fee = record.transfer_fee && Object.keys(record.transfer_fee).length ? record.transfer_fee : null;
    add('No transfer fee', Boolean(fee), fee ? 'Transfer fee configured' : 'No transfer fee', 2);
  } else {
    add('Not a honeypot', truthy(record.is_honeypot),
      truthy(record.is_honeypot) ? 'Flagged as a honeypot' : 'No honeypot signature', 12);
    add('Source verified', !truthy(record.is_open_source),
      truthy(record.is_open_source) ? 'Contract is open source' : 'Source not verified', 4);
    add('Ownership not reclaimable', truthy(record.can_take_back_ownership),
      truthy(record.can_take_back_ownership) ? 'Owner can reclaim ownership' : 'No reclaim path', 6);
    add('No hidden owner', truthy(record.hidden_owner),
      truthy(record.hidden_owner) ? 'Hidden owner detected' : 'No hidden owner', 6);
    add('Transfers not pausable', truthy(record.transfer_pausable),
      truthy(record.transfer_pausable) ? 'Transfers can be paused' : 'Transfers cannot be paused', 5);
    add('Supply not mintable', truthy(record.is_mintable),
      truthy(record.is_mintable) ? 'Supply can be minted' : 'Supply fixed', 4);
    const buyTax = toNumber(record.buy_tax) || 0;
    const sellTax = toNumber(record.sell_tax) || 0;
    add('Tax under 10%', buyTax > 0.1 || sellTax > 0.1,
      'buy ' + (buyTax * 100).toFixed(1) + '% / sell ' + (sellTax * 100).toFixed(1) + '%', 5);
  }
  return checks;
}

/** GoPlus lists the top holders individually; the share is their sum. */
function topHolderShare(record) {
  const holders = (record && record.holders) || [];
  if (!holders.length) return null;
  const total = holders.reduce((sum, h) => sum + (toNumber(h.percent) || 0), 0);
  return round(total * 100, 2);
}

/** Holders per hour, from the server's raw count series. */
function holderGrowthFrom(series) {
  const list = series || [];
  if (list.length < 2) return { samples: list.length, changed: null, perHour: null, windowMs: 0 };
  const first = list[0];
  const last = list[list.length - 1];
  const windowMs = last.t - first.t;
  const changed = last.count - first.count;
  return {
    samples: list.length,
    windowMs,
    changed,
    perHour: windowMs > 0 ? round(changed / (windowMs / 3600000), 1) : null,
  };
}

/**
 * Raw provider payloads to the facts the score and the detail panels use.
 *
 * The server forwards what GoPlus, RugCheck, Jupiter, KyberSwap, honeypot.is
 * and DefiLlama each said. Deciding what any of it means happens here.
 */
export function deriveIntel(raw, row) {
  if (!raw) return null;
  const chainKey = raw.chain;
  const gp = raw.goplus;
  const rug = raw.rugcheck;
  const hp = raw.honeypot;
  // The server forwards Jupiter raw, so the window splits (net, ratio,
  // organic share) have to be derived before anything reads them.
  const jup = normalizeJupiterToken(raw.jupiterToken);

  const checks = goPlusChecks(chainKey, gp);

  // honeypot.is actually simulates a buy and a sell, so on EVM it catches what
  // static GoPlus flags miss. Appended as ordinary checks.
  if (hp) {
    if (hp.isHoneypot !== null) {
      checks.push({
        label: 'Sell path works (simulated)',
        ok: !hp.isHoneypot,
        detail: hp.isHoneypot ? (hp.reason || 'Simulated sell failed') : 'Buy and sell both simulate',
        penalty: 10,
      });
    }
    if (hp.buyTaxPct !== null || hp.sellTaxPct !== null) {
      const high = (hp.buyTaxPct || 0) > 10 || (hp.sellTaxPct || 0) > 10;
      checks.push({
        label: 'Simulated tax under 10%',
        ok: !high,
        detail: 'buy ' + (hp.buyTaxPct || 0).toFixed(1) + '% / sell ' + (hp.sellTaxPct || 0).toFixed(1) + '%',
        penalty: 5,
      });
    }
  }

  const failed = checks.filter((c) => !c.ok);

  // LP locked: prefer the deepest market's figure, else the report-level one
  // (which RugCheck gives as a fraction rather than a percentage).
  const lpLockedPct = (() => {
    const markets = (rug && rug.markets) || [];
    const withLp = markets.filter((m) => m.lpLockedPct !== null)
      .sort((a, b) => (b.liquidityA || 0) - (a.liquidityA || 0));
    if (withLp.length) return Math.min(100, round(withLp[0].lpLockedPct, 2));
    const fraction = rug ? rug.lpLockedPctRaw : null;
    return fraction === null || fraction === undefined ? null : Math.min(100, round(fraction * 100, 2));
  })();

  // Routed price impact: Jupiter quotes a fraction, KyberSwap quotes USD in
  // and out. Both become "what a $10k buy costs you in percent".
  const impact = (() => {
    const jq = raw.jupiterQuote;
    if (jq && Number.isFinite(jq.priceImpactPctRaw)) {
      return {
        tradeUsd: jq.tradeUsd || IMPACT_TRADE_USD,
        priceImpactPct: round(jq.priceImpactPctRaw * 100, 4),
        routes: jq.routes,
        source: 'jupiter',
        note: null,
      };
    }
    const kq = raw.kyberQuote;
    if (kq && Number.isFinite(kq.amountInUsd) && Number.isFinite(kq.amountOutUsd) && kq.amountInUsd) {
      return {
        tradeUsd: kq.tradeUsd || IMPACT_TRADE_USD,
        priceImpactPct: round(((kq.amountInUsd - kq.amountOutUsd) / kq.amountInUsd) * 100, 4),
        routes: kq.routes,
        gasUsd: kq.gasUsd,
        source: 'kyberswap',
        note: null,
      };
    }
    return { tradeUsd: IMPACT_TRADE_USD, priceImpactPct: null, routes: null, source: null,
      note: 'No keyless router for this chain' };
  })();

  const goPlusHolders = toNumber(gp && gp.holder_count);
  const rugHolders = rug ? rug.totalHolders : null;
  const jupHolders = jup ? jup.holderCount : null;
  const holderCount = [goPlusHolders, rugHolders, jupHolders].find((v) => Number.isFinite(v)) ?? null;

  const llama = raw.defillama;
  const feedPrice = row ? row.priceUsd : null;

  const buys24h = row && row.txns24h ? row.txns24h.buys : null;
  const buyers24h = row && row.traders24h ? row.traders24h.buyers : null;
  const tradesPerBuyer = buys24h !== null && buyers24h ? buys24h / buyers24h : null;
  const volumePerHolder = row && holderCount ? row.volume24hUsd / holderCount : null;

  const flowNotes = [];
  if (tradesPerBuyer !== null && tradesPerBuyer > 4) {
    flowNotes.push('Each buying wallet traded ' + tradesPerBuyer.toFixed(1) + 'x on average');
  }
  if (row && Number.isFinite(row.volumeToLiquidity24h) && row.volumeToLiquidity24h > 20) {
    flowNotes.push('Volume is ' + row.volumeToLiquidity24h.toFixed(0) + 'x liquidity');
  }
  if (volumePerHolder !== null && volumePerHolder > 5000) {
    flowNotes.push('$' + Math.round(volumePerHolder).toLocaleString() + ' of volume per holder');
  }

  return {
    chain: chainKey,
    tokenAddress: raw.tokenAddress,
    fetchedAt: raw.fetchedAt,
    sources: raw.sources,
    contractSafety: {
      available: Boolean(gp) || Boolean(rug) || Boolean(hp),
      checks,
      failedCount: failed.length,
      penalty: Math.min(20, failed.reduce((sum, c) => sum + c.penalty, 0)),
      rugcheckScore: rug ? rug.scoreNormalised : null,
      rugcheckRisks: (rug && rug.risks) || [],
      lpLockedPct,
      launchpad: (rug && rug.launchpad) || (jup && jup.launchpad) || null,
      creatorOtherTokens: rug ? rug.creatorTokenCount : null,
      insidersDetected: rug ? rug.graphInsidersDetected : null,
    },
    holders: {
      count: holderCount,
      goplusCount: goPlusHolders,
      rugcheckCount: rugHolders,
      jupiterCount: jupHolders,
      sourcesDisagree: Number.isFinite(goPlusHolders) && Number.isFinite(rugHolders) &&
        goPlusHolders !== rugHolders,
      topHolderSharePct: topHolderShare(gp),
      jupiterTopHoldersPct: jup && jup.audit ? jup.audit.topHoldersPercentage : null,
      totalLpProviders: rug ? rug.totalLPProviders : null,
      growth: holderGrowthFrom(raw.holderSeries),
      changePct1h: jup && jup.stats1h ? jup.stats1h.holderChangePct : null,
      changePct24h: jup && jup.stats24h ? jup.stats24h.holderChangePct : null,
    },
    impact,
    honeypot: hp,
    priceCrossCheck: llama ? {
      llamaPriceUsd: llama.priceUsd,
      confidence: llama.confidence,
      feedPriceUsd: feedPrice,
      deltaPct: llama.priceUsd && Number.isFinite(feedPrice)
        ? round(((feedPrice - llama.priceUsd) / llama.priceUsd) * 100, 2) : null,
      source: 'defillama',
    } : null,
    supply: jup ? { circulating: jup.circSupply, total: jup.totalSupply, source: 'jupiter' } : null,
    jupiter: jup,
    flow: {
      tradesPerBuyer24h: tradesPerBuyer !== null ? round(tradesPerBuyer, 2) : null,
      volumePerHolderUsd: volumePerHolder !== null ? Math.round(volumePerHolder) : null,
      volumeToLiquidity24h: row ? row.volumeToLiquidity24h : null,
      buyers24h,
      buys24h,
      organicScore: jup ? jup.organicScore : null,
      organicSharePct24h: jup && jup.stats24h ? jup.stats24h.organicSharePct : null,
      netUsd5m: jup && jup.stats5m ? jup.stats5m.netUsd : null,
      notes: flowNotes,
      concernCount: flowNotes.length,
    },
  };
}

/* ================================================ the entry point ======== */

/**
 * THE single evaluation of a token: its inputs gathered and run through the
 * DATA FLOW. Everything the dashboard shows about an asset comes out of this
 * function - the board, the detail windows and the alerts render the same
 * object, so they can never disagree.
 *
 * Inputs are all raw, straight from the server:
 *   samples    - this pool's rolling 15s metric series (for the baselines)
 *   walletSets - sampled trades per pool, for flow and rotation
 *   intel      - this token's derived contract/holder/impact facts, if we have
 *                them yet; the score is computed on fewer inputs when we do not
 *   reference  - the quote token's price across CEX venues
 */
export function evaluateAsset(row, { samples, walletSets, intel, reference, walletIntel, ethos, listing, smartWallets } = {}, scorer) {
  const poolSamples = (samples && samples[row.poolAddress]) || [];
  const fromSamples = zScoresFrom(poolSamples);
  const own = walletSets && walletSets.get(row.poolAddress);

  // Our own 15s samples are the better baseline; the trade tape is the
  // fallback for pools too new to have accumulated any.
  const zScores = Object.keys(fromSamples.metrics).length
    ? fromSamples
    : (own ? bucketBaselines(own.trades || []) : fromSamples);

  const extras = {
    zScores,
    tradeStats: own ? own.stats : null,
    rotation: walletSets ? rotationFor(walletSets, row.poolAddress) : null,
    usdReference: reference || null,
    intel: intel || null,
    // The behavioural read on this pool, from the background wallet service.
    walletIntel: walletIntel || null,
    jupiter: row.jupiter || null,
    ethos: ethos || null,
    // Perp venues and paid promotion, for the listing components.
    listing: listing || null,
    // The raw inputs themselves, for a scorer that builds its own baselines
    // and rotation from them (the DATA FLOW - flow/score-flow.js).
    samples: poolSamples,
    own: own || null,
    walletSets: walletSets || null,
    // The learned smart-wallet Set (services/smart-money.js), for PHASE & SIGNAL.
    smartWallets: smartWallets || null,
  };

  // The DATA FLOW (flow/score-flow.js flowScore) is the only scorer.
  const scored = scorer(row, extras);
  const organicValue = scored.organicFlow && Number.isFinite(scored.organicFlow.score) ? scored.organicFlow.score : null;
  // Which source answered. Anything aggregating this number across tokens has
  // to filter on it - averaging a sampled score with a borrowed Jupiter one is
  // the exact bug this rewrite removes.
  const organicBasis = (scored.organicFlow && scored.organicFlow.basis) || 'none';
  const stats = extras.tradeStats;
  const jup5m = row.jupiter && row.jupiter.stats5m;

  return {
    ...row,
    ...scored,
    topReason: topReasonFor(row, extras),
    zScores,
    tradeStats: stats,
    rotation: extras.rotation,
    usdReference: extras.usdReference,
    // Which input set produced this score, so the UI can say how complete it is.
    scoreBasis: extras.intel ? 'intel' : 'market',
    volumeBaselineMultiple: zScores.metrics.volume5mUsd
      ? zScores.metrics.volume5mUsd.multiple : null,
    // Wash probability is the inverse of organic flow - a proxy, not a
    // wash-trading model, which is why it is named as a probability and not
    // as a verdict.
    flow: stats ? {
      source: 'geckoterminal',
      netUsd: stats.netUsd, buyUsd: stats.buyUsd, sellUsd: stats.sellUsd,
      distinctWallets: stats.distinctWallets, windowMinutes: stats.windowMinutes,
      organicFlow: organicValue,
      organicBasis,
      washRisk: organicValue === null ? null : 100 - organicValue,
    } : (jup5m ? {
      source: 'jupiter',
      netUsd: jup5m.netUsd, buyUsd: jup5m.buyUsd, sellUsd: jup5m.sellUsd,
      distinctWallets: jup5m.numTraders, windowMinutes: 5,
      organicSharePct: row.jupiter.stats24h ? row.jupiter.stats24h.organicSharePct : null,
      organicFlow: organicValue,
      organicBasis,
      washRisk: organicValue === null ? null : 100 - organicValue,
    } : null),
  };
}

/* ==================================================== the one-liner ====== */

/** The two strongest signals, for the board's REASON column. */
export function topReasonFor(row, extras) {
  const zm = (extras.zScores && extras.zScores.metrics) || {};
  const parts = [];
  if (zm.volume5mUsd && Number.isFinite(zm.volume5mUsd.multiple)) {
    parts.push({ weight: Math.abs(zm.volume5mUsd.z || 0),
      text: 'Vol ' + zm.volume5mUsd.multiple.toFixed(1) + 'x base' });
  }
  if (zm.buyers5m && Number.isFinite(zm.buyers5m.multiple)) {
    parts.push({ weight: Math.abs(zm.buyers5m.z || 0),
      text: 'buyers ' + zm.buyers5m.multiple.toFixed(1) + 'x' });
  }
  if (extras.rotation && extras.rotation.sharedWalletPct) {
    parts.push({ weight: extras.rotation.sharedWalletPct / 10,
      text: 'rotation-in ' + extras.rotation.sharedWalletPct + '%' });
  }
  if (extras.tradeStats && Number.isFinite(extras.tradeStats.netRatio)) {
    parts.push({ weight: Math.abs(extras.tradeStats.netRatio) * 3,
      text: (extras.tradeStats.netUsd >= 0 ? 'net buy ' : 'net sell ') +
        '$' + Math.abs(extras.tradeStats.netUsd).toLocaleString() });
  }
  if (Number.isFinite(row.buySellRatio24h)) {
    parts.push({ weight: Math.abs(row.buySellRatio24h - 1) * 2,
      text: 'B/S ' + row.buySellRatio24h.toFixed(2) });
  }
  parts.sort((x, y) => y.weight - x.weight);
  return parts.slice(0, 2).map((p) => p.text).join(' + ') || 'awaiting baselines';
}

/** The median of the reference venues' quotes, for the usdReference input. */
export function usdReferenceMedian(reference) {
  if (!reference || !reference.quotes || !reference.quotes.length) return null;
  const prices = reference.quotes.map((q) => q.price).sort((a, b) => a - b);
  const stats = statsFor(prices);
  const m = prices.length >> 1;
  return {
    symbol: reference.symbol,
    quotes: reference.quotes,
    median: prices.length % 2 ? prices[m] : (prices[m - 1] + prices[m]) / 2,
    spreadPct: stats && stats.mean ? round((stats.stdev / stats.mean) * 100, 3) : null,
  };
}
