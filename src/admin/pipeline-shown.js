/**
 * Step 6 of the score pipeline: SHOWN ON THE DASHBOARD.
 *
 * Every panel of the token-facing tabs - LIVE OPPORTUNITIES, ASSET DETAIL,
 * WALLETS, SOCIAL SCANNER, ROTATION - and what each number on it is read
 * from. They used to be five mirror tabs of their own on the admin rail; the
 * SCORE PIPELINE and DATA FLOW now show the whole path, fetch to screen, so
 * these are the pipeline's last step rather than pages beside it.
 *
 * Kept under their tab keys (`live`, `detail`, ...): a field is identified as
 * tab + label, and two tabs both show a "NET FLOW" or a "LIQUIDITY", so the
 * key is what keeps them apart and every ref to them resolving.
 *
 * Registered onto PAGES by pipeline.js, the same way PAGES.pipe is.
 */

import { op, num, ref, ext, api, tile, sampleRow, fromCatalog } from './provenance';

export const SHOWN_PAGES = {

  /* ------------------------------------------------ LIVE OPPORTUNITIES -- */
  live: {
    title: 'LIVE OPPORTUNITIES',
    blurb: 'The board. Five totals over a table of every screened pool, ' +
      'recomputed in the browser on every 5s poll.',
    groups: [
      {
        group: 'HEADER STATS',
        note: 'Totals over this.assets - the scored rows the table is showing.',
        fields: [
          {
            label: 'TOKENS TRACKED', status: 'live',
            value: (v) => tile(v.stats, 'TOKENS TRACKED'),
            calc: [op('count of'), ref('pipe', 'TOKEN LIST'), op('after screenRows()')],
            note: 'screenRows() drops pools that fail the floor checks, so this is what ' +
              'survived screening, not what the provider returned.',
            feeds: [ref('live', 'AVG ORGANIC SCORE', 'AVG ORGANIC SCORE (denominator)'),
              ref('health', 'HISTORY POOLS')],
            where: 'App.jsx renderVals() <- syncLiveData()',
          },
          {
            label: 'CONFIRMED+', status: 'live',
            value: (v) => tile(v.stats, 'CONFIRMED+'),
            calc: [op('count('), ref('live', 'STAGE'), op('=== CONFIRMED )'), op('+'),
              op('count('), ref('live', 'STAGE'), op('=== EXCEPTIONAL )')],
            feeds: [ref('live', 'EXCEPTIONAL', 'EXCEPTIONAL (a subset)'),
              ref('eval', 'OUTCOMES BY STAGE')],
            where: 'App.jsx renderVals(), counts[]',
          },
          {
            label: 'EXCEPTIONAL', status: 'live',
            value: (v) => tile(v.stats, 'EXCEPTIONAL'),
            calc: [op('count('), ref('live', 'STAGE'), op('=== EXCEPTIONAL ), i.e.'),
              ref('pipe', 'FINAL'), op('>='), num(85)],
            feeds: [ref('live', 'CONFIRMED+', 'CONFIRMED+ (includes it)'),
              ref('alerts', 'OPPORTUNITY')],
            where: 'App.jsx renderVals(), counts[]',
          },
          {
            label: 'AVG ORGANIC SCORE', status: 'live',
            value: (v) => tile(v.stats, 'AVG ORGANIC SCORE'),
            calc: [op('sum('), ref('pipe', 'Organic flow'), op('x max( coverage,'), num(25),
              op(') ) / sum( max( coverage,'), num(25), op(') ), over rows whose basis is'),
              ref('wallets', 'WALLET INTEL', 'our own trade sample')],
            note: 'Tokens Jupiter alone answered for are counted as unscored and reported ' +
              'separately in the subline: its number is a different quantity over a ' +
              'different window, and it only covers Solana.',
            feeds: [],
            where: 'App.jsx renderVals(), organicReads',
          },
          {
            // Measured since 2026-09-25. It was a hard-coded em dash captioned
            // "needs outcome tracking" - the archive IS that outcome tracking.
            label: 'TOP 20 HIT RATE', status: 'live',
            value: (v) => {
              const t = (v.stats || []).find((s) => s && String(s.label).indexOf('TOP 20 HIT RATE') === 0);
              return t ? t.value + (t.sub ? '  (' + t.sub + ')' : '') : undefined;
            },
            calc: [op('of the'), num(20), op('highest-ranked tokens at a past moment, the share that rose by'),
              op('the horizon - marks from'), api('/raw/app/journal.json', 'the archived score journal'),
              op('priced against'), api('/raw/<chain>/observations-48h.json', 'the archived price series')],
            note: 'Three rules keep it honest. Coverage is NEVER multiplied into the value - a 0.70 ' +
              'measured across half a day would print as 0.35 and read as a bad model rather than a ' +
              'thin sample, so coverage rides in the sub-line instead. A pick younger than the ' +
              'horizon is maturing, never a loss. And a pick whose exit price falls in a recording ' +
              'gap is left out rather than priced from hours later. The label carries the horizon ' +
              'actually used: it walks 24h down to shorter ones and upgrades itself once a ' +
              'continuous day of uptime exists.',
            feeds: [ref('eval', 'VERDICT', 'the same question, measured differently')],
            where: 'App.jsx precisionTile() <- calculations/core.js precisionAtK()',
          },
        ],
      },
      {
        group: 'FEED COLUMNS',
        note: 'Per row. Sampled from the selected token, or the top row when nothing is selected.',
        perRow: true,
        fields: [
          {
            label: 'SCORE', status: 'live',
            value: (v) => (sampleRow(v) || {}).score,
            calc: [ref('pipe', 'FINAL'), op('- the settled score, shown as computed')],
            note: 'The SETTLED score, not the momentary one. Its biggest inputs are 5-minute ' +
              'windows that shift every poll, so ranking the board on the instantaneous value ' +
              'made it reshuffle constantly. The momentary number is on the detail page as ' +
              'RIGHT NOW. A ring beside this means it was scored before contract, holder and ' +
              'routed-impact data landed - scoreBasis "market" rather than "intel".',
            feeds: [ref('live', 'STAGE'), ref('live', 'CONFIRMED+'), ref('alerts', 'OPPORTUNITY'),
              ref('eval', 'OUTCOMES BY STAGE', 'the score journal')],
            where: 'calculations/asset-detail.js evaluateAsset()',
          },
          {
            label: 'CONF', status: 'live',
            value: (v) => (sampleRow(v) || {}).conf,
            calc: [ref('pipe', 'COVERAGE'), op('as a fraction')],
            note: 'Measured against the ACTUAL total weight in SCORE_MODEL, which is 104 and not 100 ' +
              '(walletQuality was raised 8 -> 12). Dividing by a hard-coded 100 is what once ' +
              'reported a confidence of 1.04 on a fully resolved token.',
            feeds: [],
            where: 'calculations/asset-detail.js, dataQuality',
          },
          {
            label: 'PRICE', status: 'live',
            value: (v) => (sampleRow(v) || {}).price,
            fetch: [ext('dexscreener', 'priceUsd'), op('else'), ext('geckoterminal', 'base_token_price_usd')],
            via: api('/raw/<chain>/market.json'),
            feeds: [ref('detail', 'Price confirmation'), ref('detail', 'PRICE vs LLAMA'),
              api('/raw/<chain>/observations.json', 'the 60s observation series')],
            where: 'calculations/core.js normalizeRow()',
          },
          {
            label: 'DELTA 5M', status: 'live',
            value: (v) => (sampleRow(v) || {}).chg,
            fetch: [ext('dexscreener', 'priceChange.m5'), op('else'), ext('dexscreener', 'priceChange.h1')],
            via: api('/raw/<chain>/market.json'),
            feeds: [],
            where: 'services/api.js mapServerRowToAsset()',
          },
          {
            label: 'LIQUIDITY', status: 'live',
            value: (v) => (sampleRow(v) || {}).liq,
            calc: [api('/raw/<chain>/market.json', 'LIQUIDITY'), op('as read')],
            feeds: [ref('detail', 'Liquidity / executability'), ref('detail', 'RISK FLAGS')],
            where: 'calculations/core.js normalizeRow()',
          },
          {
            label: 'VOLUME', status: 'live',
            value: (v) => (sampleRow(v) || {}).vol,
            fetch: [ext('geckoterminal', 'volume_usd.m5'), op('or'), ext('geckoterminal', 'volume_usd.h24')],
            via: api('/raw/<chain>/market.json'),
            note: 'Which one is on screen follows the adjusted-view toggle: 5m when on, 24h when off.',
            feeds: [ref('detail', 'Volume anomaly'), ref('live', 'TREND (sparkline)')],
            where: 'App.jsx renderVals(), showAdj',
          },
          {
            label: 'WASH', status: 'live',
            value: (v) => (sampleRow(v) || {}).wash,
            // mapServerRowToAsset(): wash = flow.washRisk / 100, and evaluateAsset()
            // sets washRisk = 100 - organic flow. A proxy, not a wash model.
            calc: [op('( 100 −'), ref('pipe', 'Organic flow'), op(') ÷ 100')],
            feeds: [ref('detail', 'RISK FLAGS'), ref('detail', 'Organic flow')],
            where: 'calculations/core.js, flow',
          },
          {
            label: 'NET FLOW', status: 'live',
            value: (v) => (sampleRow(v) || {}).netflow,
            // row.flow.netUsd: the pool's trade sample, else Jupiter's 5m split.
            calc: [op('buy USD − sell USD of'), api('/raw/<chain>/trades.json', 'TRADE SAMPLE'), op('; with no trade sample: Jupiter 5m buy − sell from'),
              api('/raw/<chain>/market.json', 'JUPITER STATS')],
            note: 'Source order: Jupiter first where it indexes the token, then our own trade ' +
              'sample, then raw txn counts - which cannot weigh a trade, only count it.',
            feeds: [ref('detail', 'Net demand')],
            where: 'calculations/core.js, flow',
          },
          {
            label: 'BUYERS', status: 'live',
            value: (v) => (sampleRow(v) || {}).buyers,
            fetch: [ext('geckoterminal', 'traders.m5.buyers'), op('else'), ext('geckoterminal', 'transactions.m5.buys')],
            via: api('/raw/<chain>/market.json'),
            note: 'The fallback counts TRANSACTIONS, not wallets - one wallet buying five ' +
              'times reads as five.',
            feeds: [ref('detail', 'Buyer breadth'), ref('detail', 'Trade activity')],
            where: 'services/api.js mapServerRowToAsset()',
          },
          {
            label: 'STAGE', status: 'live',
            value: (v) => (sampleRow(v) || {}).stage,
            calc: [ref('pipe', 'STAGE'), op('as computed')],
            note: 'Hysteresis comes from the stage machine, rehydrated from the browser history ' +
              'store on load, so a score hovering on a band edge does not flicker.',
            feeds: [ref('live', 'CONFIRMED+'), ref('live', 'EXCEPTIONAL'),
              ref('eval', 'OUTCOMES BY STAGE')],
            where: 'calculations/asset-detail.js, hydrateStages()',
          },
          {
            label: 'AGE', status: 'live',
            value: (v) => (sampleRow(v) || {}).age,
            calc: [api('/raw/<chain>/market.json', 'POOL AGE'), op('in seconds')],
            feeds: [ref('detail', 'RISK FLAGS')],
            where: 'services/api.js mapServerRowToAsset()',
          },
          {
            label: 'TREND (sparkline)', status: 'live',
            value: (v) => { const r = sampleRow(v); return r && r.trend ? r.trend.length + ' bars' : '-'; },
            calc: [op('last'), num(16), op('of'), api('/raw/<chain>/history.json', 'samples[pool].volume5mUsd'),
              op(', scaled'), num('15-100%'), op('of the cell')],
            note: 'Empty when the server holds fewer than two samples for the pool. An empty ' +
              'trend beats an invented rising line.',
            feeds: [ref('detail', 'Volume anomaly', 'the same series Volume anomaly reads')],
            where: 'services/api.js fetchLiveMarketData(), full.spark',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------ ASSET DETAIL -- */
  detail: {
    title: 'ASSET DETAIL',
    blurb: 'One token, fully decomposed. This page does not score - it renders the ' +
      'one score the board already computed, so the two can never disagree.',
    groups: [
      {
        group: 'THE SCORE',
        fields: [
          {
            label: 'FINAL', status: 'live',
            value: (v) => v.d && v.d.score,
            calc: [ref('pipe', 'FINAL'), op('- rendered from the board’s own evaluation, never rescored')],
            note: 'The headline everywhere, and what the STAGE follows - so the badge can ' +
              'never disagree with the number beside it.',
            feeds: [ref('live', 'STAGE'), ref('live', 'SCORE'),
              ref('eval', 'OUTCOMES BY STAGE', 'the score journal')],
            where: 'calculations/asset-detail.js settledScore()',
          },
          {
            label: 'RIGHT NOW', status: 'live',
            value: (v) => v.d && v.d.scoreNow,
            calc: [ref('pipe', 'RIGHT NOW')],
            note: 'This poll on its own. Kept visible because the gap between it and FINAL is ' +
              'how volatile the token is right now: wide means it is still moving, "settled" means ' +
              'the window agrees with the instant.',
            feeds: [ref('detail', 'FINAL', 'one reading of the average')],
            where: 'calculations/asset-detail.js scoreAsset()',
          },
          {
            label: 'RAW', status: 'live',
            value: (v) => v.d && v.d.raw,
            calc: [ref('pipe', 'RAW')],
            note: 'Dividing by the weights that RESOLVED, not by 100, is what stops a missing ' +
              'provider from dragging the score down.',
            feeds: [ref('detail', 'FINAL')],
            where: 'evaluateAsset()',
          },
          {
            label: 'RISK PENALTY', status: 'live',
            value: (v) => v.d && v.d.penalty,
            calc: [ref('pipe', 'RISK PENALTY')],
            feeds: [ref('detail', 'FINAL')],
            where: 'evaluateAsset()',
          },
          {
            label: 'CONFIDENCE', status: 'live',
            value: (v) => v.d && v.d.conf,
            calc: [op('components measured'), op('/'), num(11)],
            note: 'The model has twelve components plus two modifiers, so a fully resolved ' +
              'token reads above 1.00. The divisor and the model have drifted apart.',
            feeds: [ref('live', 'CONF')],
            where: 'evaluateAsset(), dataQuality',
          },
          {
            label: 'SCORE BASIS', status: 'live',
            value: (v) => v.d && v.d.scoreSource,
            calc: [op('"intel" once'), api('/raw/<chain>/intel.json'), op('has answered for this token, "feed" until then')],
            note: 'The enrichment loop fills two tokens per poll and caches for 45 minutes, so ' +
              'a fresh board climbs from "feed" to "intel" over a few minutes.',
            feeds: [ref('live', 'SCORE', 'the ring beside the board SCORE')],
            where: 'services/api.js, intelFor() / enrichInBackground()',
          },
        ],
      },
      // SCORE DECOMPOSITION is not here: the components are computed in that
      // panel, so it is the pipeline's step 4 (pipeline.js), not a display of it.
      {
        group: 'MARKET TILES',
        note: 'Provider readings, shown as reported. Grey means no provider answered for ' +
          'this token or this chain.',
        from: (v) => ((v.d && v.d.market) || []).map((t) => {
          const doc = fromCatalog('MARKET', t.label);
          const missing = t.value === '-' || t.value === '—';
          return {
            label: t.label,
            status: missing ? 'unmeasured' : 'live',
            value: () => t.value,
            fetch: [api('/raw/<chain>/intel.json', (doc && doc.source) || 'provider reading')],
            equation: (doc && doc.formula) || null,
            freshness: doc && doc.freshness,
            feeds: [],
            where: 'tabs-modules/ASSET-DETAIL.jsx detailVals(), market[]',
          };
        }),
      },
      {
        group: 'PRICE & SCORE',
        note: 'Candles from the raw store; score lines from the browser-only score trail ' +
          '(services/score-trail.js, its own IndexedDB database). The two share one time axis.',
        fields: [
          {
            label: 'CANDLES', status: 'live',
            value: () => '1H/6H: minute bars · 24H/7D: 15-minute bars',
            fetch: [ext('geckoterminal', 'ohlcv/minute (aggregate 1, and aggregate 15 x 700 = 7.3 days)')],
            via: api('/raw/<chain>/bars15/<pool>.json'),
            note: 'Minute ranges merge GeckoTerminal minute bars over our own 15s samples; ' +
              '15-minute ranges read the per-pool file of the collector (kept 30 days) and fill the ' +
              'time since its last 2-hourly refresh from our samples.',
            feeds: [],
            where: 'services/api.js fetchChartHistory()',
          },
          {
            label: 'SCORE LINES', status: 'live',
            value: () => 'avg score, this-poll score and each component, 0-100 left axis',
            calc: [op('one mark per token per minute from evaluateAsset(); hours older than a day ' +
              'thinned to one per 5 minutes; kept 14 days')],
            note: 'Only hours the app was open have marks, so a line can start later than the candles.',
            feeds: [],
            where: 'services/score-trail.js recordTrail() / readTrail()',
          },
        ],
      },
      {
        group: 'WHAT MOVES THIS SCORE',
        note: 'Each resolved component as the POINTS it moved the score against a ' +
          'neutral 50: (value - 50) x weight / weightUsed. These sum to (raw - 50), ' +
          'which is what lets the panel print its own arithmetic.',
        from: (v) => ((v.d && v.d.drivers) || []).map((r) => ({
          label: r.label,
          status: r.chip ? 'live' : 'partial',
          value: () => r.pointsLabel,
          calc: [op('('), ref('pipe', r.label), op('− 50 ) × weight ÷ weightUsed')],
          evidence: r.title,
          feeds: [],
          where: 'tabs-modules/ASSET-DETAIL.jsx, contributions',
        })),
      },
      {
        group: 'RISK FLAGS',
        from: (v) => {
          const flags = ((v.d && v.d.flags) || []).map((f) => ({
            label: f.sev + ' flag',
            status: 'live',
            value: () => f.text,
            calc: [ref('pipe', 'RISK FLAGS'), op('- one raised flag')],
            feeds: [ref('detail', 'RISK PENALTY'), ref('alerts', 'RISK')],
            where: 'calculations/alert-schema.js',
          }));
          return flags.length ? flags : [{
            label: 'RISK FLAGS', status: 'live',
            value: () => 'none triggered',
            calc: [ref('pipe', 'RISK FLAGS')],
            feeds: [ref('detail', 'RISK PENALTY'), ref('alerts', 'RISK')],
            where: 'calculations/alert-schema.js',
          }];
        },
      },
      {
        group: 'CONTRACT SAFETY',
        from: (v) => ((v.d && v.d.safety) || []).map((c) => ({
          label: c.label,
          status: 'live',
          value: () => (c.ok ? 'PASS' : 'FAIL'),
          calc: [api('/raw/<chain>/intel.json', 'CONTRACT CHECKS'), op('- one of the checks')],
          evidence: c.detail || '',
          feeds: [ref('detail', 'Contract safety'), ref('detail', 'FINAL')],
          where: 'calculations/asset-detail.js deriveIntel(), contractSafety',
        })),
      },
      {
        group: 'OUTCOME TRACKING',
        fields: [
          {
            label: 'FORWARD RETURNS', status: 'placeholder',
            value: (v) => ((v.d && v.d.outcomes) || []).map((o) => o.k + ' ' + o.v).join('  '),
            calc: [op('every horizon hard-coded to an em dash')],
            note: 'The EVALUATION tab does measure forward returns, by joining the score ' +
              'journal to the server observation series. This panel is not reading it.',
            feeds: [],
            where: 'tabs-modules/ASSET-DETAIL.jsx detailVals(), outcomes',
          },
        ],
      },
    ],
  },

  /* ----------------------------------------------------------- WALLETS -- */
  wallets: {
    title: 'WALLETS',
    blurb: 'One pool trade sample, read behaviourally. This tab owns WALLET QUALITY: ' +
      'the score consumes the number produced here, never the other way round.',
    groups: [
      {
        group: 'WINDOW',
        fields: [
          {
            label: 'SAMPLE WINDOW', status: 'live',
            value: (v) => v.windowLine,
            fetch: [ext('geckoterminal', 'pools/{pool}/trades')],
            via: api('/raw/<chain>/trades.json'),
            note: 'The on-demand read is preferred because it is the only one carrying the ' +
              'holder list; the background service is the fallback, so switching token paints ' +
              'immediately instead of waiting a poll.',
            feeds: [ref('wallets', 'ACTIVE WALLETS'), ref('wallets', 'NET FLOW'),
              ref('wallets', 'WALLET QUALITY'), ref('rotation', 'NET ROTATION')],
            where: 'tabs-modules/WALLETS.jsx walletsVals()',
          },
        ],
      },
      {
        group: 'WALLET STATS',
        fields: [
          {
            label: 'ACTIVE WALLETS', status: 'live',
            value: (v) => tile(v.walletStats, 'ACTIVE WALLETS'),
            calc: [op('distinct addresses in'), ref('wallets', 'SAMPLE WINDOW'),
              op(', pool contract excluded')],
            feeds: [ref('wallets', 'TOP WALLET SHARE', 'TOP WALLET SHARE (denominator)'),
              ref('wallets', 'WALLET QUALITY')],
            where: 'services/wallet-intel.js, window.wallets',
          },
          {
            label: 'NET FLOW', status: 'live',
            value: (v) => tile(v.walletStats, 'NET FLOW'),
            calc: [op('sum( buyUsd )'), op('-'), op('sum( sellUsd ) across'),
              ref('wallets', 'ACTIVE WALLETS')],
            feeds: [ref('live', 'NET FLOW'), ref('detail', 'Net demand')],
            where: 'services/wallet-intel.js, flow.netUsd',
          },
          {
            label: 'BUYERS / SELLERS', status: 'live',
            value: (v) => tile(v.walletStats, 'BUYERS / SELLERS'),
            calc: [op('count( wallets with any buy )'), op('/'), op('count( wallets with any sell )')],
            note: 'A wallet that did both counts on both sides - which is the point: ' +
              'round-tripping is what the organic read is looking for.',
            feeds: [ref('detail', 'Organic flow')],
            where: 'services/wallet-intel.js, flow',
          },
          {
            label: 'TOP WALLET SHARE', status: 'live',
            value: (v) => tile(v.walletStats, 'TOP WALLET SHARE'),
            calc: [op('largest wallet |USD|'), op('/'), op('total window volume x'), num(100)],
            feeds: [ref('wallets', 'WALLET QUALITY')],
            where: 'services/wallet-intel.js, flow.topWalletSharePct',
          },
          {
            label: 'CO-ENTRY WALLETS', status: 'live',
            value: (v) => tile(v.walletStats, 'CO-ENTRY WALLETS'),
            calc: [op('wallets in a burst: arrivals vs this pool own arrival rate, then checked ' +
              'for a group exit, over'), ref('wallets', 'SAMPLE WINDOW')],
            feeds: [ref('wallets', 'WALLET QUALITY')],
            where: 'services/wallet-intel.js, clusters',
          },
        ],
      },
      {
        group: 'WALLET QUALITY',
        note: 'The number this tab sends to the score. Displayed from the asset where the ' +
          'board already computed it; recomputed locally only for a pool the board has not scored.',
        from: (v) => {
          const q = v.quality;
          if (!q) return [];
          const parts = (q.barParts || []).map((p) => ({
            label: p.label || p.key,
            status: p.value === null ? 'unmeasured' : 'live',
            value: () => p.valueTxt,
            calc: [op('one part of'), ref('wallets', 'WALLET QUALITY')],
            evidence: p.noteTxt,
            feeds: [ref('wallets', 'WALLET QUALITY')],
            where: 'calculations/core.js walletQualityScore()',
          }));
          return [{
            label: 'WALLET QUALITY',
            status: q.score === null ? 'unmeasured' : 'live',
            value: () => (q.score === null ? '-' : q.score + ' / 100 (' + q.gradeLabel + ')'),
            // The score computed it; this tab renders that object (asset.walletQuality).
            calc: [ref('pipe', 'Wallet quality'), op('- rendered as the score computed it')],
            evidence: q.coverageTxt || '',
            note: 'Ownership rule: the wallets module produces this number and the score ' +
              'consumes it. Recomputing it inside a tab is what used to make the same token ' +
              'read two different values.',
            feeds: [ref('detail', 'Wallet quality'), ref('detail', 'FINAL')],
            where: 'calculations/core.js walletQualityScore()',
          }].concat(parts);
        },
      },
      {
        group: 'BACKGROUND SERVICE',
        fields: [
          {
            label: 'WALLET INTEL', status: 'live',
            value: (v) => v.intelLine,
            calc: [op('pools watched, wallets in memory, clusters logged - all re-read from'),
              api('/raw/<chain>/trades.json', 'samples the server already holds')],
            note: 'It issues no extra upstream calls of its own - 5s means processing, not ' +
              'sampling.',
            feeds: [ref('detail', 'Organic flow'), ref('wallets', 'WALLET QUALITY'),
              ref('rotation', 'ROTATION SERVICE')],
            where: 'services/wallet-intel.js walletIntelStatus()',
          },
        ],
      },
    ],
  },

  /* ---------------------------------------------------- SOCIAL SCANNER -- */
  social: {
    title: 'SOCIAL SCANNER',
    blurb: 'Mentions of this ticker inside a corpus fetched for every token, not for ' +
      'this one. Nothing here is simulated - an unmeasurable ticker says so.',
    groups: [
      {
        group: 'PROJECT REPUTATION',
        from: (v) => [
          {
            label: 'ETHOS SCORE', status: 'live',
            value: () => (v.ethosLabel || '—'),
            fetch: [ext('ethos', 'score'), op('for'),
              op('service:x.com:username:<the handle this token advertises>')],
            via: api('/raw/ethos.json'),
            feeds: [ref('detail', 'PROJECT REPUTATION'), ref('detail', 'RISK FLAGS')],
            where: 'services/ethos-intel.js ethosFor()',
            note: 'The handle comes from the DexScreener socials the token lists, or from ' +
              'the Jupiter twitter field on Solana. ' +
              '0 means Ethos has never seen the account - rendered ' +
              '"unrated" and grey, never as a bad score. 1200 is the starting score of an ' +
              'account that exists with nothing recorded either way; the panels show the ' +
              'distance from it rather than the raw number, because that is the only part ' +
              'that carries information.',
          },
          {
            label: 'ETHOS LEVEL', status: 'live',
            value: () => (v.ethos && v.ethos.level) || '—',
            fetch: [ext('ethos', 'level')],
            via: api('/raw/ethos.json'),
            feeds: [],
            where: 'the ethos collector on the server, every 2 min, refreshed per ' +
              'handle every 30 min - reputation moves on the order of days',
          },
          {
            label: 'ACCOUNT KIND', status: 'live',
            value: () => (v.ethos && v.ethos.kind) || '—',
            calc: [op('x.com/<handle>'), op('\u2192'), op('"profile"'),
              op('\u2502 x.com/<handle>/status/<id>'), op('\u2192'), op('"post"')],
            note: 'A /status/ URL names whoever wrote that post, often not the project, so ' +
              'only a profile handle is presented as the account belonging to the token.',
            feeds: [ref('detail', 'RISK FLAGS', 'a flag is only raised for a profile handle')],
            where: 'lib/providers.js xHandleFrom()',
          },
        ],
      },
      {
        group: 'SOCIAL STATS',
        from: (v) => {
          const specs = {
            'PER AUTHOR': {
              calc: [ref('social', 'MENTIONS'), op('/'), ref('social', 'UNIQUE AUTHORS'),
                op('- above'), num(3), op('is one account repeating itself')],
              feeds: [],
            },
            'VS BASELINE': {
              calc: [ref('social', 'MENTIONS'), op('/'), ref('social', 'BASELINE')],
              feeds: [],
            },
            'POSTS SCANNED': {
              calc: [op('size of the corpus held by the social service, across all tokens')],
              feeds: [ref('social', 'MENTIONS', 'every count above, as their denominator')],
            },
          };
          return (v.socialStats || []).map((s) => {
            // The mentions tile is captioned with the live ticker, so it is
            // matched on its prefix and given a stable label to link to.
            const isMentions = s.label.indexOf('MENTIONS OF') === 0;
            const key = isMentions ? 'MENTIONS' : s.label;
            const spec = specs[key] || {};
            return {
              label: isMentions ? 'MENTIONS' : s.label,
              sublabel: isMentions ? s.label : '',
              status: s.value === '—' || s.value === '-' ? 'unmeasured' : 'live',
              value: () => s.value,
              calc: spec.calc ||
                [op('counted from the matched posts in'), ref('social', 'SOURCES ANSWERING')],
              feeds: spec.feeds || [ref('social', 'VS BASELINE')],
              where: 'services/social-intel.js, mention / baseline',
            };
          });
        },
      },
      {
        group: 'MEASUREMENT',
        fields: [
          {
            label: 'BASELINE', status: 'live',
            value: (v) => v.socialBaselineNote,
            calc: [op('rolling mean and z of'), ref('social', 'MENTIONS'),
              op(', one sample a minute, kept with the tab closed')],
            feeds: [ref('social', 'VS BASELINE')],
            where: 'services/social-intel.js, baseline',
          },
          {
            label: 'COVERAGE', status: 'live',
            value: (v) => v.socialWatched,
            calc: [op('symbolsMeasured = seen.size per'), num('tick'),
              op('\u00b7 symbolsWithMentions = count('), ref('social', 'MENTIONS'), op('> 0 )')],
            feeds: [],
            where: 'services/social-intel.js socialIntelStatus()',
          },
          {
            label: 'SOURCES ANSWERING', status: 'live',
            value: (v) => v.socialLive,
            fetch: [api('/raw/social.json', 'the configured feeds')],
            feeds: [ref('social', 'POSTS SCANNED')],
            where: 'services/social-intel.js socialSources()',
          },
        ],
      },
    ],
  },

  /* ---------------------------------------------------------- ROTATION -- */
  rotation: {
    title: 'ROTATION',
    blurb: 'Which pools this token shares wallets with, and which way the money moved. ' +
      'Built by an always-on graph service that rides the wallet sample.',
    groups: [
      {
        group: 'TOKEN ROTATION',
        from: (v) => (v.rotStats || []).map((s) => {
          const specs = {
            'NET ROTATION': {
              calc: [ref('rotation', 'ARRIVED'), op('-'), ref('rotation', 'LEFT')],
              feeds: [ref('detail', 'Capital rotation')],
            },
            ARRIVED: {
              calc: [op('USD into this pool from wallets that had sold another sampled pool, over'),
                ref('wallets', 'SAMPLE WINDOW')],
              feeds: [ref('rotation', 'NET ROTATION')],
            },
            LEFT: {
              calc: [op('USD out of this pool from wallets that then bought another sampled pool, over'),
                ref('wallets', 'SAMPLE WINDOW')],
              feeds: [ref('rotation', 'NET ROTATION')],
            },
            'CONNECTED POOLS': {
              calc: [op('pools sharing at least one wallet with this one - then'),
                op('clamp01( sharedWalletPct /'), num(25), op(') x'), num(100)],
              feeds: [ref('detail', 'Capital rotation')],
            },
          };
          const spec = specs[s.label] || {};
          return {
            label: s.label,
            status: 'live',
            value: () => s.value,
            calc: spec.calc || [op('from the rotation graph over'), ref('wallets', 'WALLET INTEL')],
            note: 'Only pools the server warm loop has sampled can appear here - coverage ' +
              'there is the ceiling on coverage of this graph.',
            feeds: spec.feeds || [],
            where: 'services/rotation-intel.js rotationForPool()',
          };
        }),
      },
      {
        group: 'CHAIN ROTATION',
        from: (v) => (v.rotChainStats || []).map((s) => ({
          label: s.label,
          status: 'live',
          value: () => s.value,
          calc: s.label.indexOf('PARALLEL') === 0
            ? [op('USD from wallets holding both pools at once - held OUT of'),
              ref('rotation', 'CHAIN ROTATED'), op('because it is not a move between them')]
            : [op('total USD moved between sampled pools on this chain, over'),
              ref('wallets', 'SAMPLE WINDOW')],
          feeds: [],
          where: 'services/rotation-intel.js rotationGraphFor()',
        })),
      },
      {
        group: 'SERVICE',
        fields: [
          {
            label: 'ROTATION SERVICE', status: 'live',
            value: (v) => v.rotService,
            calc: [op('chains held and pools connected, built on top of'),
              ref('wallets', 'WALLET INTEL')],
            note: 'It polls nothing itself - it rides the wallet sample, so it costs no ' +
              'upstream calls.',
            feeds: [ref('rotation', 'NET ROTATION'), ref('health', 'ROTATION GRAPHS HELD')],
            where: 'services/rotation-intel.js rotationIntelStatus()',
          },
        ],
      },
    ],
  },
};
