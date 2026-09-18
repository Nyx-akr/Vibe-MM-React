/**
 * ASSET DETAIL - the score model.
 *
 * This is the golden number and everything that feeds it. It is deliberately
 * the one file separated from core.js, because this is the model we iterate
 * on: change a weight, a curve or a penalty here and the whole board moves.
 *
 * Nothing in this file fetches. Raw numbers in, a score out.
 *
 *   raw intel   -> deriveIntel()      facts: safety checks, holders, impact
 *   row + facts -> computeComponents() twelve 0-100 inputs
 *               -> computeModifiers()  organic flow, contract safety
 *               -> assessRisk()        flags and the penalty they cost
 *               -> scoreAsset()        raw - penalty = final, then a stage
 *
 * Reading order for the score itself: SCORE_MODEL (what counts and how much),
 * then computeComponents (how each input is measured), then assessRisk (what
 * it costs to look dangerous).
 */

import {
  toNumber, clamp01, to100, multipleScore, logScore, statsFor, normalizeJupiterToken,
  zScoresFrom, bucketBaselines, rotationFor, walletQualityScore,
} from './core.js';

/* =================================================== the model =========== */

/**
 * The twelve inputs and their weights.
 *
 * Weights are only counted when an input actually resolved, so a row scored
 * on 8 of 12 inputs is the weighted average of those 8 - not a row punished
 * for the 4 that were missing. `dataQuality` reports how much of the model
 * was covered, which is the honest way to show that difference.
 */
export const SCORE_MODEL = Object.freeze([
  { key: 'volumeAnomaly', label: 'Volume anomaly', weight: 13 },
  { key: 'tradeActivity', label: 'Trade activity', weight: 8 },
  { key: 'buyerBreadth', label: 'Buyer breadth', weight: 12 },
  { key: 'netDemand', label: 'Net demand', weight: 10 },
  { key: 'liquidity', label: 'Liquidity / executability', weight: 14 },
  { key: 'priceConfirmation', label: 'Price confirmation', weight: 8 },
  { key: 'holderGrowth', label: 'Holder growth', weight: 7 },
  { key: 'walletQuality', label: 'Wallet quality', weight: 12 },
  { key: 'capitalRotation', label: 'Capital rotation', weight: 8 },
  { key: 'crossVenue', label: 'Cross-venue confirm', weight: 4 },
  { key: 'usdReference', label: 'USD reference', weight: 3 },
  { key: 'dataQuality', label: 'Data quality', weight: 5 },
]);

/** Not scored directly - these feed the risk penalty instead. */
export const SCORE_MODIFIERS = Object.freeze([
  { key: 'organicFlow', label: 'Organic flow' },
  { key: 'contractSafety', label: 'Contract safety' },
]);

export const STAGES = Object.freeze([
  { name: 'EXCEPTIONAL', min: 85 },
  { name: 'CONFIRMED', min: 70 },
  { name: 'EMERGING', min: 55 },
  { name: 'WATCH', min: 0 },
]);

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

/* =============================================== the twelve inputs ======= */

/**
 * Each component returns 0-100, or nothing at all when its input is missing.
 * "Nothing" is not zero - a pending input is excluded from the weighted
 * average rather than dragging the score down.
 */
export function computeComponents(row, extras) {
  const z = (extras.zScores && extras.zScores.metrics) || {};
  const stats = extras.tradeStats || null;
  const intel = extras.intel || null;
  const rotation = extras.rotation || null;
  const usdRef = extras.usdReference || null;
  const jup = extras.jupiter || (row && row.jupiter) || null;
  const wallet = extras.walletIntel || null;

  const parts = {};
  const evidence = {};
  const set = (key, value, note) => { parts[key] = value; evidence[key] = note; };

  // --- flow anomaly: is this busier than its own normal? ---
  // A metric can exist with a null multiple when its baseline mean was zero -
  // that is no baseline at all, so it stays pending rather than reporting
  // 'nullx baseline'.
  if (z.volume5mUsd && Number.isFinite(z.volume5mUsd.multiple)) {
    set('volumeAnomaly', multipleScore(z.volume5mUsd.multiple),
      z.volume5mUsd.multiple + 'x baseline, z ' + z.volume5mUsd.z);
  }
  if (z.buys5m && Number.isFinite(z.buys5m.multiple)) {
    set('tradeActivity', multipleScore(z.buys5m.multiple),
      z.buys5m.multiple + 'x baseline, z ' + z.buys5m.z);
  }

  // Breadth blends the anomaly with the absolute count, so a quiet token with
  // a 3x spike does not outrank a busy one with thousands of real buyers.
  {
    const hasBaseline = z.buyers5m && Number.isFinite(z.buyers5m.multiple);
    const anomaly = hasBaseline ? multipleScore(z.buyers5m.multiple) : null;
    const absolute = logScore(row.traders24h && row.traders24h.buyers, 10, 3000);
    if (anomaly !== null || absolute !== null) {
      const blended = anomaly !== null && absolute !== null
        ? Math.round(anomaly * 0.5 + absolute * 0.5) : (anomaly !== null ? anomaly : absolute);
      set('buyerBreadth', blended,
        (row.traders24h && row.traders24h.buyers != null ? row.traders24h.buyers + ' buyers 24h' : '') +
        (hasBaseline ? ', ' + z.buyers5m.multiple + 'x 5m baseline' : ''));
    }
  }

  // --- net demand: best available USD split, then counts as a last resort ---
  const jupWindow = jup && (jup.stats1h || jup.stats5m || jup.stats24h)
    ? (jup.stats1h || jup.stats5m || jup.stats24h) : null;
  if (stats && stats.netRatio !== null) {
    set('netDemand', to100(0.5 + stats.netRatio / 2),
      'net $' + stats.netUsd.toLocaleString() + ' over ' + stats.windowMinutes + 'm');
  } else if (jupWindow && jupWindow.netRatio !== null) {
    set('netDemand', to100(0.5 + jupWindow.netRatio / 2),
      'net $' + Math.round(jupWindow.netUsd).toLocaleString() + ' of $' +
      Math.round((jupWindow.buyUsd || 0) + (jupWindow.sellUsd || 0)).toLocaleString() +
      ' (Jupiter USD split)');
  } else if (Number.isFinite(row.buySellRatio24h)) {
    set('netDemand', to100((row.buySellRatio24h - 0.5) / 1.5),
      'buy/sell count ratio ' + row.buySellRatio24h.toFixed(2) + ' (no USD split yet)');
  }

  // --- can you actually get out? depth plus the real cost of a $10k trade ---
  {
    const depth = logScore(row.liquidityUsd, 10000, 1000000);
    const impact = intel && intel.impact && Number.isFinite(intel.impact.priceImpactPct)
      ? to100(1 - intel.impact.priceImpactPct / 2.5) : null;
    if (depth !== null || impact !== null) {
      const blended = depth !== null && impact !== null
        ? Math.round(depth * 0.5 + impact * 0.5) : (depth !== null ? depth : impact);
      set('liquidity', blended,
        (depth !== null ? '$' + Math.round(row.liquidityUsd).toLocaleString() + ' depth' : '') +
        (impact !== null ? ', ' + intel.impact.priceImpactPct + '% impact on $' + intel.impact.tradeUsd : ''));
    }
  }

  // --- do independent sources agree on the price? ---
  if (row.crossSource && Number.isFinite(row.crossSource.priceDeltaPct)) {
    set('priceConfirmation', to100(1 - Math.abs(row.crossSource.priceDeltaPct) / 5),
      Math.abs(row.crossSource.priceDeltaPct).toFixed(2) + '% apart');
  } else if (row.crossSource && row.crossSource.sourcesAgreeing < 2) {
    set('priceConfirmation', 40, 'only one source priced it');
  }

  // --- are new holders arriving? ---
  if (intel && intel.holders && intel.holders.growth && intel.holders.growth.perHour !== null) {
    const g = intel.holders.growth;
    const rate = intel.holders.count ? (g.perHour / intel.holders.count) * 100 : 0;
    set('holderGrowth', to100(0.5 + rate * 5),
      (g.perHour > 0 ? '+' : '') + g.perHour + ' holders/h on ' + intel.holders.count.toLocaleString());
  } else if (jup && jup.stats1h && Number.isFinite(jup.stats1h.holderChangePct)) {
    // Jupiter reports the delta per window, so this needs no local series.
    const pct = jup.stats1h.holderChangePct;
    set('holderGrowth', to100(0.5 + pct / 4),
      (pct > 0 ? '+' : '') + pct.toFixed(2) + '% holders in 1h' +
      (jup.holderCount ? ' on ' + jup.holderCount.toLocaleString() : '') + ' (Jupiter)');
  }

  // --- what do the wallets say? ---
  //
  // Nothing is decided here. Wallet quality is one number, computed by the
  // wallets module (walletQualityScore in core.js) from the same inputs the
  // WALLETS tab displays, so the figure on that tab and the figure in this
  // score are the same figure by construction rather than by coincidence.
  //
  // This block's whole job is to supply the holder-side context that the
  // wallets module cannot see - it reads trades, not provider holder lists -
  // and to record what comes back.
  {
    const cs = (intel && intel.contractSafety) || {};
    const holders = (intel && intel.holders) || {};
    const jupTop = jup && jup.audit ? toNumber(jup.audit.topHoldersPercentage) : null;
    // Preferred in this order: the wallets module's own figure (which excludes
    // the pool contract), then the provider sum, then Jupiter's audit. The
    // first is what the WALLETS tab shows, so preferring it is what keeps the
    // two views on the same number.
    const walletTop = wallet && wallet.holderSharePct !== null &&
      wallet.holderSharePct !== undefined ? wallet.holderSharePct : null;
    const providerTop = holders.topHolderSharePct !== null &&
      holders.topHolderSharePct !== undefined ? holders.topHolderSharePct : null;
    const topHolderSharePct = walletTop !== null ? walletTop
      : (providerTop !== null ? providerTop : jupTop);

    const quality = walletQualityScore(wallet, {
      topHolderSharePct,
      holderSource: walletTop !== null ? 'GoPlus, pool excluded'
        : (providerTop !== null ? 'GoPlus' : (jupTop !== null ? 'Jupiter audit' : null)),
      insidersDetected: cs.insidersDetected,
      creatorOtherTokens: cs.creatorOtherTokens,
      lpLockedPct: cs.lpLockedPct,
    });

    if (quality.score !== null) {
      set('walletQuality', quality.score,
        quality.note + (quality.measured < quality.total
          ? ' (' + quality.measured + ' of ' + quality.total + ' wallet checks)' : ''));
      evidence.walletQualityDetail = quality;
    }
  }

  // --- is the same money moving in from other pools we watch? ---
  if (rotation && rotation.sharedWalletPct !== null) {
    set('capitalRotation', to100(rotation.sharedWalletPct / 25),
      rotation.sharedWalletCount + ' wallets shared with ' +
      (rotation.peers[0] ? rotation.peers[0].symbol : 'other pools') +
      ' (' + rotation.sharedWalletPct + '% of traders)');
  }

  // --- listed in more than one place? ---
  {
    const venues = row.sources && row.sources.dexscreener ? row.sources.dexscreener.pairs : null;
    if (Number.isFinite(venues)) {
      const agreeing = row.crossSource ? row.crossSource.sourcesAgreeing : 1;
      set('crossVenue', to100((logScore(venues, 1, 20) / 100) * (agreeing > 1 ? 1 : 0.6)),
        venues + ' venues, ' + agreeing + '/2 sources');
    }
  }

  // --- is the quote token itself priced correctly? ---
  if (usdRef && Number.isFinite(row.quoteTokenPriceUsd) && usdRef.median) {
    const deviation = Math.abs(row.quoteTokenPriceUsd - usdRef.median) / usdRef.median * 100;
    set('usdReference', to100(1 - deviation / 2),
      usdRef.symbol + ' $' + row.quoteTokenPriceUsd.toFixed(4) + ' vs $' + usdRef.median.toFixed(4) +
      ' median of ' + usdRef.quotes.length + ' venues (' + deviation.toFixed(2) + '% off)');
  }

  // --- how much of the model actually resolved ---
  const measured = SCORE_MODEL.filter((c) => c.key !== 'dataQuality' && parts[c.key] != null);
  const coverable = SCORE_MODEL.length - 1;
  set('dataQuality', Math.round((measured.length / coverable) * 100),
    measured.length + ' of ' + coverable + ' inputs present');

  return { parts, evidence };
}

/* ================================================== the modifiers ======== */

/**
 * Organic flow and contract safety. Neither adds to the score; both can cost
 * points through the risk penalty, which is the right shape - a clean
 * contract is table stakes, not a reason to buy.
 */
export function computeModifiers(row, extras) {
  const stats = extras.tradeStats;
  const intel = extras.intel;
  const jup = extras.jupiter || (row && row.jupiter) || null;
  const out = {};

  // Jupiter publishes its own organic-flow score, so this no longer depends on
  // winning the trade-sampling rotation. A local trade sample still wins.
  if (!stats && jup && Number.isFinite(jup.organicScore)) {
    const share = jup.stats24h ? jup.stats24h.organicSharePct : null;
    out.organicFlow = {
      value: Math.round(jup.organicScore),
      evidence: 'Jupiter organic score ' + jup.organicScore.toFixed(1) +
        (jup.organicScoreLabel ? ' (' + jup.organicScoreLabel + ')' : '') +
        (share !== null ? ', ' + share + '% of 24h volume organic' : '') +
        (jup.stats24h && jup.stats24h.numOrganicBuyers !== null
          ? ', ' + jup.stats24h.numOrganicBuyers + ' organic buyers' : ''),
    };
  }
  if (stats) {
    // A real crowd looks like: many wallets trading once, no single wallet
    // dominating, and few wallets round-tripping repeatedly.
    const spread = clamp01((stats.oneAndDonePct || 0) / 80);
    const concentration = clamp01(1 - (stats.top5SharePct || 0) / 70);
    const churn = clamp01(1 - ((stats.tradesPerWallet || 1) - 1) / 5);
    out.organicFlow = {
      value: to100(spread * 0.4 + concentration * 0.35 + churn * 0.25),
      evidence: stats.oneAndDonePct + '% one-and-done, top-5 hold ' + stats.top5SharePct +
        '% of volume, ' + stats.tradesPerWallet + ' trades/wallet',
    };
  }
  if (intel && intel.contractSafety && intel.contractSafety.available) {
    const cs = intel.contractSafety;
    const passed = (cs.checks || []).filter((c) => c.ok).length;
    const total = (cs.checks || []).length || 1;
    out.contractSafety = {
      value: Math.round((passed / total) * 100),
      evidence: passed + '/' + total + ' checks pass' +
        (cs.rugcheckRisks && cs.rugcheckRisks.length ? ', ' + cs.rugcheckRisks.length + ' RugCheck risks' : ''),
    };
  }
  return out;
}

/* ======================================================= the penalty ===== */

/**
 * What it costs to look dangerous. Flat deductions, capped at 15 points in
 * total so a token cannot be penalised into meaninglessness by a pile-up of
 * related flags (a new pool is usually also thin and single-sourced).
 */
export function assessRisk(row, modifiers, context) {
  const flags = [];
  const add = (severity, code, detail, penalty) => flags.push({ severity, code, detail, penalty });

  const ageHours = row.poolAgeHours;
  if (Number.isFinite(ageHours)) {
    if (ageHours < 2) add('HIGH', 'NEW_POOL', 'Pool is under 2 hours old', 4);
    else if (ageHours < 24) add('MED', 'NEW_POOL', 'Pool is under 24 hours old', 2);
  }
  if (!row.crossSource || row.crossSource.sourcesAgreeing < 2) {
    add('MED', 'SINGLE_SOURCE', 'Only one provider priced this pool', 3);
  }
  if (Number.isFinite(row.liquidityUsd) && row.liquidityUsd < 50000) {
    add('HIGH', 'THIN_LIQUIDITY', 'Liquidity under $50K', 4);
  }
  const turnover = row.volumeToLiquidity24h;
  if (Number.isFinite(turnover) && turnover > 20) {
    add('MED', 'EXTREME_TURNOVER', '24h volume is ' + turnover.toFixed(0) + 'x liquidity', 3);
  }
  const stats = context && context.tradeStats;
  if (stats && stats.top5SharePct !== null && stats.top5SharePct > 70) {
    add('HIGH', 'VOLUME_CONCENTRATED',
      'Top 5 wallets are ' + stats.top5SharePct + '% of traded volume', 4);
  }
  const safety = modifiers && modifiers.contractSafety;
  if (safety && safety.value < 100) {
    add(safety.value < 70 ? 'HIGH' : 'MED', 'CONTRACT_CHECKS', safety.evidence,
      safety.value < 70 ? 6 : 3);
  }
  const organic = modifiers && modifiers.organicFlow;
  if (organic && organic.value < 40) {
    add('MED', 'LOW_ORGANIC_FLOW', organic.evidence, 3);
  }

  const penalty = Math.min(15, flags.reduce((total, f) => total + f.penalty, 0));
  return { flags, penalty };
}

/* ================================================== the stage machine ==== */

/**
 * Stage memory.
 *
 * The stage IS the score, bucketed: 0 / 55 / 70 / 85. It follows the score
 * immediately in both directions - if the score changes band, the stage
 * changes with it. There is no smoothing, no hold, no lag. The final score is
 * the thing that matters, and the badge must never say something the number
 * does not.
 *
 * What is remembered here is only WHEN the stage last changed, and the recent
 * transitions - the stage itself is recomputed from the score every time.
 *
 * The memory lives in the browser because the browser is what computes the
 * score. Hydrate it at boot and snapshot it back out to whatever storage the
 * app is using.
 */
const stageStore = new Map();

export function hydrateStages(saved) {
  if (!saved) return;
  Object.keys(saved).forEach((key) => stageStore.set(key, saved[key]));
}

export function stageSnapshot() {
  const out = {};
  stageStore.forEach((value, key) => { out[key] = value; });
  return out;
}

export function stageFor(chainKey, tokenAddress, score) {
  const key = chainKey + ':' + tokenAddress;
  // The stage is a pure function of the score. Nothing here can override it.
  const next = (STAGES.find((s) => score >= s.min) || STAGES[STAGES.length - 1]).name;
  const prior = stageStore.get(key);

  if (!prior) {
    const entry = { stage: next, since: Date.now(), history: [{ stage: next, at: Date.now() }] };
    stageStore.set(key, entry);
    return entry;
  }

  if (next !== prior.stage) {
    prior.stage = next;
    prior.since = Date.now();
    prior.history.push({ stage: next, at: Date.now() });
    if (prior.history.length > 12) prior.history.shift();
  }
  return prior;
}

/* ======================================================= the score ======= */

/**
 * Raw weighted average, minus the risk penalty, bucketed into a stage.
 *
 * `extras` carries everything the model needs beyond the row itself:
 *   zScores, tradeStats, intel, rotation, usdReference, jupiter
 */
export function scoreAsset(row, extras) {
  const context = extras || {};
  const { parts, evidence } = computeComponents(row, context);
  const modifiers = computeModifiers(row, context);

  let weighted = 0;
  let weightUsed = 0;
  const breakdown = SCORE_MODEL.map((c) => {
    const value = parts[c.key];
    const present = Number.isFinite(value);
    if (present) { weighted += value * c.weight; weightUsed += c.weight; }
    return {
      key: c.key, label: c.label, weight: c.weight,
      value: present ? value : null,
      pending: !present,
      evidence: evidence[c.key] || null,
    };
  });

  const rawScore = weightUsed ? Math.round(weighted / weightUsed) : 0;
  const risk = assessRisk(row, modifiers, context);
  const score = Math.max(0, Math.min(100, rawScore - risk.penalty));

  const stage = context.trackStage === false
    ? { stage: (STAGES.find((s) => score >= s.min) || STAGES[STAGES.length - 1]).name,
        since: Date.now(), history: [] }
    : stageFor(row.chain, row.tokenAddress, score);

  return {
    rawScore,
    riskPenalty: risk.penalty,
    riskFlags: risk.flags,
    score,
    stage: stage.stage,
    stageSince: stage.since,
    stageHistory: stage.history,
    scoreModel: breakdown,
    scoreModifiers: SCORE_MODIFIERS.map((m) => ({
      key: m.key, label: m.label,
      value: modifiers[m.key] ? modifiers[m.key].value : null,
      pending: !modifiers[m.key],
      evidence: modifiers[m.key] ? modifiers[m.key].evidence : null,
    })),
    // The wallets module's full verdict, not just the number that went into
    // the weighted average - so the WALLETS tab can render the breakdown it
    // produced without recomputing it and risking a different answer.
    walletQuality: evidence.walletQualityDetail || null,
    weightCovered: weightUsed,
    componentsPresent: breakdown.filter((b) => !b.pending).length,
    dataQuality: round(weightUsed / 100, 2),
  };
}

/* ================================================ the entry point ======== */

/**
 * THE single evaluation of a token. Everything the dashboard shows about an
 * asset comes out of this function.
 *
 * Live Opportunities does not calculate anything - it calls this for each row
 * and renders the result. The Asset Detail page calls nothing at all; it
 * renders the same object for the one token you opened. That is why the score
 * in the table and the score on the detail page are always the same number:
 * there is only ever one of them.
 *
 * Inputs are all raw, straight from the server:
 *   samples    - this pool's rolling 15s metric series (for the baselines)
 *   walletSets - sampled trades per pool, for flow and rotation
 *   intel      - this token's derived contract/holder/impact facts, if we have
 *                them yet; the score is computed on fewer inputs when we do not
 *   reference  - the quote token's price across CEX venues
 */
export function evaluateAsset(row, { samples, walletSets, intel, reference, walletIntel } = {}) {
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
  };

  const scored = scoreAsset(row, extras);
  const organic = (scored.scoreModifiers || []).find((m) => m.key === 'organicFlow');
  const organicValue = organic && !organic.pending ? organic.value : null;
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
      washRisk: organicValue === null ? null : 100 - organicValue,
    } : (jup5m ? {
      source: 'jupiter',
      netUsd: jup5m.netUsd, buyUsd: jup5m.buyUsd, sellUsd: jup5m.sellUsd,
      distinctWallets: jup5m.numTraders, windowMinutes: 5,
      organicSharePct: row.jupiter.stats24h ? row.jupiter.stats24h.organicSharePct : null,
      organicFlow: organicValue,
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
