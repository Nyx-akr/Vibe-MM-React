/**
 * Where every number on the dashboard comes from, as something you can follow.
 *
 * The admin mirror renders the SAME viewmodel objects the frontend renders -
 * `renderVals()` is inherited, not reimplemented - and pairs each value with
 * its derivation. A derivation is one of exactly two things:
 *
 *   fetch  the value arrived as-is from a provider or from our own server.
 *          Nothing is computed, so there is nothing to explain except WHERE
 *          it came from, and the source carries its documentation link.
 *
 *   calc   the value is computed, so it is written out as an expression whose
 *          operands are LINKS: `ref()` points at another field on another tab
 *          of this admin page, `ext()` at an outside provider, `api()` at one
 *          of our own endpoints. Clicking a ref navigates to that tab and
 *          blinks the field; hovering an ext or api shows its URL.
 *
 * That is the whole point: a number is never explained by prose that can go
 * stale, it is explained by the things it is made of, each of which you can
 * open and check.
 *
 * `status` is the honest part. 'live' means the number is measured every poll.
 * 'partial' means it is measured but falls back to a constant when a provider
 * is silent. 'placeholder' means it is hard-coded in the source and does not
 * move - the dashboard shows it like any other figure, and this is the only
 * page that says so.
 */

import { PANELS, SOURCES } from '../data/catalog';

/* --------------------------------------------------------- the operands -- */

/** Glue: operators, function names, punctuation. Rendered, never clickable. */
export const op = (s) => ({ t: 'op', s });

/** A literal in the formula - a weight, a threshold, a divisor. */
export const num = (s) => ({ t: 'num', s: String(s) });

/**
 * Another field on this admin page. Clicking it goes there and blinks it.
 * `field` must match that field's label exactly, which is what makes the jump
 * land on the card rather than just the tab.
 */
export const ref = (page, field, label) => ({ t: 'ref', page, field, label: label || field });

/** An outside provider, by its id in catalog.js SOURCES. Hover shows its docs. */
export const ext = (source, field) => ({ t: 'ext', source, field });

/** One of our own endpoints. Hover shows the live URL on whichever server answered. */
export const api = (path, field) => ({ t: 'api', path, field });

/* ------------------------------------------------------------- helpers -- */

/** A value out of one of the `{label, value}` tile arrays the tabs build. */
export const tile = (list, label) => {
  const hit = (list || []).find((s) => s && s.label === label);
  return hit ? hit.value : undefined;
};

/** A value out of a `{k, v}` key/value list. */
export const kv = (list, key) => {
  const hit = (list || []).find((s) => s && s.k === key);
  return hit ? hit.v : undefined;
};

/** The row the per-row cards are sampled from: the selection, else the top. */
export const sampleRow = (v) => {
  const rows = v.rows || [];
  return rows.find((r) => r.selected) || rows[0] || null;
};

/** Provider metadata by id, for the hover card behind an `ext` operand. */
export const SOURCE_BY_ID = {};
SOURCES.forEach((s) => { SOURCE_BY_ID[s.id] = s; });

/** A documented formula from catalog.js, kept for fields not yet expressed. */
const catalogIndex = new Map();
PANELS.forEach((panel) => {
  panel.fields.forEach((field) => {
    catalogIndex.set(panel.panel + '|' + field.field, field);
  });
});
export const fromCatalog = (panel, field) => catalogIndex.get(panel + '|' + field) || null;

/**
 * The EVALUATION report as the tab rendered it, plus the formatters its cards
 * share, or null before the tab has measured anything.
 */
function outcomeCtx(v) {
  const o = v.outcome || {};
  const r = o.report;
  if (!o.ready || !r) return null;
  return {
    o, r, t: r.thresholds || {}, s: o.sources || {},
    pctOf: (x) => (x == null ? '—' : Math.round(x * 100) + '%'),
    sgn: (x) => (x == null ? '—' : (x > 0 ? '+' : '') + x + '%'),
    where: 'calculations/core.js scoreOutcomes(), tabs-modules/EVALUATION.jsx evalVals()',
  };
}

const notMeasured = () => [{
  label: 'OUTCOME REPORT', status: 'live',
  value: () => 'not measured yet - open the EVALUATION tab',
  calc: [api('/raw/<chain>/observations.json'), op('joined to the score journal')],
  note: 'fetchLiveEvalData() only runs while the EVALUATION tab is the open page.',
  feeds: [], where: 'services/api.js fetchLiveEvalData()',
}];

/* ============================================================== pages === */

export const PAGES = {

  /* ---------------------------------------------------- MARKET ROTATION -- */
  market: {
    title: 'MARKET ROTATION',
    blurb: 'The same question as ROTATION asked of a whole chain rather than one ' +
      'token: where did money move BETWEEN pools. Built from the same graph, which ' +
      'rides the wallet sample and polls nothing of its own.',
    groups: [
      {
        group: 'MARKET STATS',
        from: (v) => {
          const specs = {
            'MEASURED ROTATION': {
              calc: [op('sum over chains of ( USD that left one sampled pool and arrived in ' +
                'another ) - the same number'), ref('rotation', 'NET ROTATION'), op('reports for one token')],
              feeds: [],
            },
            'POOLS SAMPLED': {
              calc: [op('pools the wallet sampler has reached, summed over chains - see'),
                ref('wallets', 'WALLET INTEL')],
              feeds: [ref('rotation', 'CONNECTED POOLS')],
            },
            'PARALLEL \u2014 EXCLUDED': {
              calc: [op('USD from wallets that bought both pools, or sold both - held OUT of'),
                ref('market', 'MEASURED ROTATION')],
              feeds: [],
            },
          };
          return (v.mrStats || []).map((s) => {
            const spec = specs[s.label] || {};
            return {
              label: s.label,
              status: 'live',
              value: () => s.value,
              calc: spec.calc || [op('from the chain rotation graph')],
              evidence: s.note || '',
              note: s.tip || undefined,
              feeds: spec.feeds || [],
              where: 'tabs-modules/MARKET-ROTATION.jsx marketRotationVals()',
            };
          });
        },
      },
      {
        group: 'WHERE IT WENT',
        note: 'Net winners and losers, read off the same graphs the ribbons are drawn ' +
          'from, so the list and the chart describe one moment rather than two.',
        from: (v) => {
          const rows = [].concat(
            (v.mrGainers || []).map((n) => ({ n, dir: 'took in' })),
            (v.mrLosers || []).map((n) => ({ n, dir: 'gave up' })),
          );
          if (!rows.length) {
            return [{
              label: 'NET MOVERS', status: 'live',
              value: () => 'none in this window',
              calc: [op('pools whose'), ref('rotation', 'NET ROTATION'), op('is not zero')],
              feeds: [],
              where: 'tabs-modules/MARKET-ROTATION.jsx, gainers / losers',
            }];
          }
          return rows.map(({ n, dir }) => ({
            label: n.label + ' \u00b7 ' + n.chain,
            status: 'live',
            value: () => n.val,
            calc: [op('arrived USD \u2212 departed USD for this pool, the top six each way')],
            evidence: n.tip,
            feeds: [],
            where: 'tabs-modules/MARKET-ROTATION.jsx, gainers / losers',
          }));
        },
      },
      {
        group: 'CHAINS',
        note: 'One ribbon diagram per chain. Only sampled pools can take part and ' +
          'nothing crosses chains, so every figure here is a floor rather than a total.',
        from: (v) => (v.mrChains || []).map((c) => ({
          label: c.name,
          status: c.thin ? 'partial' : 'live',
          value: () => c.rotated,
          calc: [op('directed flows between sampled pools on this chain, from'),
            api('/raw/<chain>/trades.json', 'the trade samples')],
          evidence: c.window,
          note: c.drawnNote,
          feeds: [ref('market', 'MEASURED ROTATION')],
          where: 'services/rotation-intel.js rotationGraphFor()',
        })),
      },
      {
        group: 'SERVICE',
        fields: [
          {
            label: 'ROTATION SERVICE \u00b7 MARKET', status: 'live',
            value: (v) => v.mrService,
            calc: [op('chains held and when the graph was last rebuilt, on top of'),
              ref('wallets', 'WALLET INTEL')],
            note: 'It polls nothing of its own - it rides the wallet sample, so the coverage ' +
              'of that sampler is the ceiling on everything this tab can see.',
            feeds: [ref('market', 'MEASURED ROTATION'), ref('rotation', 'ROTATION SERVICE')],
            where: 'services/rotation-intel.js rotationIntelStatus()',
          },
        ],
      },
    ],
  },

  /* ------------------------------------------------------- ALERT CARDS -- */
  alerts: {
    title: 'ALERT CARDS',
    blurb: 'Tokens that crossed a threshold, grouped by what the crossing means. ' +
      'Each card carries the conditions that would invalidate it.',
    groups: [
      {
        group: 'COLUMNS',
        from: (v) => (v.alertColumns || []).map((c) => ({
          label: c.label,
          status: 'live',
          value: () => (c.cards ? c.cards.length : 0) + ' cards',
          calc: c.key === 'OPPORTUNITY'
            ? [op('rows where'), ref('live', 'SCORE'), op('and'), ref('live', 'STAGE'),
              op('cleared the opportunity thresholds')]
            : c.key === 'RISK'
              ? [op('rows carrying a triggered'), ref('detail', 'RISK FLAGS')]
              : [op('alerts whose score path resolved, read from the score journal')],
          feeds: [],
          where: 'tabs-modules/ALERT-CARDS.jsx alertsVals()',
        })),
      },
      {
        group: 'INVALIDATION',
        fields: [
          {
            label: 'INVALIDATION RULES', status: 'live',
            value: (v) => ((v.alertInvalid || []).length || 0) + ' rules',
            calc: [
              op('OPPORTUNITY:'), ref('live', 'SCORE'), op('<'), num(70),
              op('('), num(85), op('if EXCEPTIONAL) within'), num('6h'),
              op('OR'), ref('live', 'LIQUIDITY'), op('<'), num('$50K'),
              op('\u2502 RISK: each firing'), ref('detail', 'RISK FLAGS'),
              op('clears within'), num('4h'),
              op('\u2502 RESOLUTION: none, it is closed'),
            ],
            feeds: [ref('alerts', 'RESOLUTION')],
            where: 'tabs-modules/ALERT-CARDS.jsx alertsVals()',
          },
        ],
      },
    ],
  },

  /* -------------------------------------------------------- EVALUATION -- */
  eval: {
    title: 'EVALUATION',
    blurb: 'Did the score mean anything. Joins this browser score journal to the server ' +
      'raw price series - neither side can answer alone.',
    groups: [
      // Every group below reads the ONE report the tab renders (v.outcome);
      // none recomputes it. Groups follow the page top to bottom, and values
      // follow the TIME WINDOW and GROUP BY picked on the tab.
      {
        group: 'THE ANSWER',
        note: 'The score is a ranking, not a probability, so the page asks what a ranking can answer: ' +
          'did higher-scored tokens do better than the rest of the board at the same moment? (The old ' +
          'calibration bars drew a band floor against a win rate and printed a hard-coded Brier/ECE; ' +
          'the old tiles and stage table counted every 60s mark and fell back to demo constants. All removed.)',
        from: (v) => {
          const x = outcomeCtx(v);
          if (!x) return notMeasured();
          const { o, r, t, sgn, pctOf, where } = x;
          return [
            {
              label: 'VERDICT', status: 'live',
              value: () => r.verdict + ' · ' + o.horizonLabel,
              calc: [op('COLLECTING below'), num(t.minPicks), op('resolved predictions or'), num(t.minMoments),
                op('IC moments; EDGE when'), ref('eval', 'RANK IC'), op('>'), num(t.icEdge), op('and t >'), num(t.tEdge),
                op('; INVERTED when IC < −'), num(t.icEdge), op('and t < −'), num(t.tEdge),
                op('; otherwise NO CLEAR EDGE')],
              feeds: [], where,
            },
            {
              label: 'RANK IC', status: 'live',
              value: () => (r.ic.mean ?? '—') + ' (sd ' + (r.ic.sd ?? '—') + ', t ' + (r.ic.t ?? '—') +
                ', ' + pctOf(r.ic.positiveShare) + ' of ' + r.ic.moments + ' moments > 0)',
              calc: [op('mean over 15-min moments with ≥'), num(t.minIcBoard), op('resolved tokens of Spearman(score, ' +
                'return); t = mean / (sd / √moments), capped at ±99 when every moment agrees')],
              note: 'The standard measure of a ranking signal. Around 0.03-0.05 is already useful for a ' +
                'screener; the t-stat is what separates that from a lucky afternoon.',
              feeds: [ref('eval', 'VERDICT')], where,
            },
            {
              label: 'RANK IC · EACH MOMENT', status: 'live',
              value: () => (r.icSeries || []).length + ' moments, newest 96 drawn · ' +
                (r.icSeries || []).filter((p) => p.ic > 0).length + ' positive',
              calc: [op('the per-moment Spearman values behind'), ref('eval', 'RANK IC'), op(', oldest first')],
              note: 'Shows whether the edge is steady or one burst - the mean alone cannot.',
              feeds: [], where,
            },
            {
              label: 'TOP − BOTTOM', status: 'live',
              value: () => sgn(r.spreadPct),
              calc: [op('median'), ref('eval', 'EXCESS RETURN'), op('of the top 20% by score in each moment − the ' +
                'bottom 20%; withheld when either holds <'), num(t.minGroup), op('predictions')],
              feeds: [ref('eval', 'VERDICT')], where,
            },
            {
              label: 'ORDERED', status: 'live',
              value: () => r.monotonic.steps ? r.monotonic.ordered + ' of ' + r.monotonic.steps + ' steps' : '—',
              calc: [op('adjacent rank fifths (each ≥'), num(t.minGroup),
                op('predictions) where the higher-ranked has the higher median excess')],
              feeds: [], where,
            },
          ];
        },
      },
      {
        group: 'HOW MUCH DATA',
        from: (v) => {
          const x = outcomeCtx(v);
          if (!x) return [];
          const { o, r, t, s, where } = x;
          return [
            {
              label: 'INPUTS', status: 'live',
              value: () => s.journalMarks + ' marks / ' + s.journalTokens + ' tokens · ' +
                s.priceSamples + ' prices / ' + s.priceTokens + ' tokens',
              calc: [op('predictions: the score journal in the app store (IndexedDB, ~50h, 60s marks, ' +
                'thinned to 1 per 15 min past 6h)'), op('+ outcomes:'),
                api('/raw/<chain>/observations.json', 'hot 60s window'), op('merged with'),
                api('/raw/<chain>/observations-48h.json', 'archive, 48h'), op('deduped by timestamp')],
              note: s.deepFile ? undefined : 'observations-48h.json was not readable; only the hot window was used.',
              feeds: [], where: 'services/api.js fetchLiveEvalData(), mergeObservations()',
            },
            {
              label: 'PREDICTIONS', status: 'live',
              value: () => o.total + ' = ' + r.picks + ' resolved + ' + r.pending + ' maturing + ' +
                r.unresolved + ' in a price gap · ' + r.moments + ' moments',
              calc: [op('one mark per token per'), num('15 min'), op('slice (its latest); entry = first price ' +
                'at/after the mark, exit = first price at/after mark +'), num(o.horizonLabel),
                op('; either more than'), num('30 min'), op('from where it should be → in a price gap; ' +
                'younger than the window → maturing')],
              note: 'An independent prediction, not a data row: a token watched for an hour is ~4 ' +
                'predictions, not ~60. Maturing is never a loss; a gap is left out rather than priced ' +
                'from hours later.',
              feeds: [ref('eval', 'READY TO JUDGE')], where,
            },
            {
              label: 'READY TO JUDGE', status: 'live',
              value: () => o.checks.map((c) => (c.ok ? '✓ ' : '✗ ') + c.label).join(' · '),
              calc: [op('≥'), num(t.minPicks), op('resolved and ≥'), num(t.minMoments), op('IC moments, else'),
                ref('eval', 'VERDICT'), op('= COLLECTING')],
              feeds: [ref('eval', 'VERDICT')], where,
            },
            {
              label: 'TOKENS SCORED', status: 'live',
              value: () => o.tokens.scored + ' scored · ' + o.tokens.priced + ' with prices',
              calc: [op('distinct tokens in the score journal; with prices = tokens in'),
                api('/raw/<chain>/observations.json'), op('∪'), api('/raw/<chain>/observations-48h.json')],
              feeds: [], where: 'services/api.js fetchLiveEvalData()',
            },
          ];
        },
      },
      {
        group: 'HOW EACH GROUP DID',
        from: (v) => {
          const x = outcomeCtx(v);
          if (!x) return [];
          const { o, r, t, sgn, pctOf, where } = x;
          const cards = [{
            label: 'EXCESS RETURN', status: 'live',
            value: () => 'board median ' + sgn(r.board.medianRetPct) + ' raw',
            calc: [op('(exit − entry) / entry ×'), num(100), op('− median of the same for every token ' +
              'resolved in the same slice; only slices with ≥'), num(t.minBoard), op('resolved tokens')],
            note: 'Strips the market out: memecoins move together, so a raw "went up" mostly measures ' +
              'the day. Excess is what the score added over holding the whole board.',
            feeds: [ref('eval', 'TOP − BOTTOM'), ref('eval', 'VERDICT')], where,
          }];
          const groups = o.view === 'SCORE' ? r.byScore : r.byRank;
          groups.forEach((g) => {
            cards.push({
              label: (o.view === 'SCORE' ? 'SCORE ' : 'RANK ') + g.label,
              status: 'live',
              value: () => 'n ' + g.n + ' · excess ' + sgn(g.medianExcessPct) + ' · beat ' + pctOf(g.hitRate) +
                ' · raw ' + sgn(g.medianRetPct) + ' · win ' + pctOf(g.winRate) + ' · best ' + sgn(g.medianMfePct) +
                ' · worst ' + sgn(g.medianMaePct) + ' · rug ' + pctOf(g.rugRate) + ' · avg score ' + (g.avgScore ?? '—'),
              calc: o.view === 'SCORE'
                ? [op('predictions with'), num(g.lo), op('≤ score <'), num(g.hi), op('- the same cut as the stage')]
                : [op('predictions ranked in this fifth of their own moment, by score')],
              note: g.n < t.minGroup ? 'Fewer than ' + t.minGroup + ' predictions: shown faded and left out ' +
                'of the spread and ordering.' : undefined,
              feeds: [], where,
            });
          });
          return cards;
        },
      },
      {
        group: 'IN PRICE',
        from: (v) => {
          const x = outcomeCtx(v);
          if (!x) return [];
          const { r, t, sgn, pctOf, where } = x;
          const b = r.board;
          return [
            {
              label: 'MEDIAN RETURN', status: 'live', value: () => sgn(b.medianRetPct),
              calc: [op('median of (exit − entry) / entry ×'), num(100), op('over every resolved prediction, market ' +
                'included - the raw side of'), ref('eval', 'EXCESS RETURN')],
              feeds: [], where,
            },
            {
              label: 'WENT UP', status: 'live', value: () => pctOf(b.winRate),
              calc: [op('count( exit > entry )'), op('/'), op('resolved \u00d7'), num(100)],
              feeds: [], where,
            },
            {
              label: 'BEST / WORST POINT', status: 'live',
              value: () => sgn(b.medianMfePct) + ' / ' + sgn(b.medianMaePct),
              calc: [op('MFE = median( ( max price[entry..exit] \u2212 entry ) / entry )'),
                op('\u2502 MAE = median( ( min price[entry..exit] \u2212 entry ) / entry )')],
              feeds: [], where,
            },
            {
              label: 'RUG RATE', status: 'live', value: () => pctOf(b.rugRate),
              calc: [op('share of resolved predictions with exit liquidity / entry liquidity <'),
                num(t.rugLiquidityRatio), op('- red above'), num('3%')],
              note: 'Read AT the exit sample, not at the latest one.',
              feeds: [], where,
            },
            {
              label: 'BRIER / ECE', status: 'live',
              value: () => 'Brier ' + (r.brier ?? '—') + ' (base ' + (r.brierBase ?? '—') + ') / ECE ' + (r.ece ?? '—'),
              calc: [op('forecast = score /'), num(100), op(', outcome = beat the board; Brier = mean (p − o)²; ' +
                'base = p̄(1 − p̄); ECE over'), num(10), op('score deciles')],
              note: 'Admin only, off the tab: it reads the score as P(beat the board), which it was never ' +
                'built to be, so it measures the SCALE not the skill. A Brier above base means the raw score ' +
                'should not be read as a probability - not that the ranking is bad.',
              feeds: [], where,
            },
          ];
        },
      },
      {
        group: 'WARNING FLAGS',
        note: 'Replaces TOP FALSE-POSITIVE CAUSES, which counted flags on losing marks only, once per ' +
          'minute - so it ranked whichever flag was most common, and one token could add dozens. Now one ' +
          'count per prediction, and each flag is compared across losers AND winners.',
        from: (v) => {
          const x = outcomeCtx(v);
          if (!x) return [];
          const { r, t, pctOf, where } = x;
          const head = {
            label: 'FLAG COMPARISON', status: 'live',
            value: () => (r.flags || []).length + ' flags on ≥' + t.minFlag + ' predictions · ' +
              r.losers + ' losers / ' + r.winners + ' winners',
            calc: [op('per flag: share of losers carrying it vs share of winners carrying it (loser / winner = ' +
              'excess below / above 0); sorted by the difference; flags on <'), num(t.minFlag),
              op('predictions dropped')],
            feeds: [], where,
          };
          return [head].concat((r.flags || []).slice(0, 7).map((f) => ({
            label: 'FLAG ' + f.code,
            status: 'live',
            value: () => 'on ' + pctOf(f.lossShare) + ' of losers vs ' + pctOf(f.winShare) + ' of winners · ' +
              pctOf(f.lossRate) + ' of its ' + f.picks + ' predictions lost',
            calc: [op('flags at the mark \u22c8 outcome \u00b7 lossShare = count( flag \u2227 lost ) / losers'),
              op('\u00b7 winShare = count( flag \u2227 won ) / winners')],
            feeds: [], where,
          })));
        },
      },
    ],
  },

  /* ------------------------------------------------------ SYSTEM HEALTH -- */
  health: {
    title: 'SYSTEM HEALTH',
    blurb: 'One verdict, the seven parts it is made of, and the detail behind each. Every ' +
      'level is judged in calculations/system-health.js from what the collector reports ' +
      'about itself and what the browser services report - nothing on the tab is a constant.',
    groups: [
      {
        group: 'VERDICT',
        fields: [
          {
            label: 'OVERALL', status: 'live',
            value: (v) => v.health && (v.health.title + ' - ' + v.health.issues.length + ' issue(s)'),
            calc: [op('worst( level ) over the parts below, where ok < warn < down'),
              op('\u00b7 "unknown" never raises it'),
              op('\u00b7 only the critical source group ( market data ) may reach down')],
            feeds: [],
            where: 'calculations/system-health.js systemHealth()',
          },
        ],
      },
      {
        group: 'PARTS',
        from: (v) => ((v.health && v.health.parts) || []).map((part) => ({
          label: part.label.toUpperCase(),
          status: 'live',
          value: () => part.level + ' / ' + part.headline + (part.sub ? ' / ' + part.sub : ''),
          calc: {
            server: [api('/raw/system.json', 'writtenAt'), op('- DOWN over 2 min old, DEGRADED over 45s')],
            chains: [api('/raw/system.json', 'warm.state'), op('- stale at 4 missed passes, DOWN at 12')],
            sources: [op('providerHealth() over'), api('/raw/system.json', 'upstream.providers[].minutes'),
              op('- last 15 min; DOWN at'), num('50%'), op('failed, DEGRADED at'), num('10%')],
            jobs: [api('/raw/system.json', 'collectors'), op('against'), api('/raw/system.json', 'schedule'),
              op('- overdue at three missed turns')],
            files: [api('/raw/system.json', 'raw.failing'), op('- a file failing lately with no good write since')],
            archive: [api('/raw/system.json', 'store.health.level')],
            browser: [op('walletIntelStatus(), socialIntelStatus(), rotationIntelStatus(), storageStats()')],
          }[part.key] || [op('see system-health.js')],
          note: part.problems && part.problems.length ? part.problems.join(' · ') : undefined,
          feeds: [],
          where: 'calculations/system-health.js',
        })),
      },
      {
        group: 'DATA SOURCES',
        note: 'The server counts calls and errors per minute and files each error by kind ' +
          '(429, 4xx, 5xx, timeout). Every rate, percentile and status is computed in the ' +
          'browser by providerHealth() - the same function the SERVER page uses.',
        from: (v) => ((v.health && v.health.sources) || []).flatMap((g) => g.rows).map((r) => ({
          label: r.label,
          status: 'live',
          value: () => r.status + ' / ' + (r.successPct == null ? '—' : Math.round(r.successPct) + '% ok') +
            ' / ' + (r.callsPerMinute == null ? '—' : r.callsPerMinute + '/min'),
          calc: [op(r.window === 'recent' ? 'last 15 minutes of' : 'lifetime counters from'),
            api('/raw/system.json', 'upstream.providers[' + r.host + ']')],
          note: r.why || undefined,
          feeds: [],
          where: 'calculations/core.js providerHealth()',
        })),
      },
      {
        group: 'THIS BROWSER',
        fields: [
          {
            label: 'ROTATION GRAPHS HELD', status: 'live',
            value: (v) => {
              const s = v.health && v.health.browser.find((b) => b.key === 'rotation');
              return s ? s.detail : '—';
            },
            calc: [op('chains held and pools connected by'), ref('rotation', 'ROTATION SERVICE')],
            note: 'If it stalls, every panel reading rotationForPool() goes quietly stale and ' +
              'nothing else would say so.',
            feeds: [ref('rotation', 'NET ROTATION')],
            where: 'services/rotation-intel.js rotationIntelStatus()',
          },
        ],
      },
      {
        group: 'SERVER & ARCHIVE',
        fields: [
          {
            label: 'HISTORY POOLS', status: 'live',
            value: (v) => (v.health && v.health.resources ? v.health.resources.historyPools : '—'),
            calc: [api('/raw/system.json', 'cache.historyPools')],
            feeds: [],
            where: 'calculations/system-health.js resources',
          },
          {
            label: 'ARCHIVE', status: 'live',
            value: (v) => (v.health && v.health.resources ? v.health.resources.archiveBytes : '—'),
            calc: [api('/raw/system.json', 'store.usage.bytes')],
            feeds: [],
            where: 'calculations/system-health.js resources',
          },
        ],
      },
    ],
  },
};

/**
 * Every field's current value, keyed `page|LABEL`.
 *
 * This is what lets an expression show its ARITHMETIC rather than its shape:
 * an operand naming another field can print that field's value beside the
 * name, so `sum(buyUsd) - sum(sellUsd) across [ACTIVE WALLETS]` reads
 * `... across [ACTIVE WALLETS = 63]` and the reader can do the sum.
 *
 * Built once per viewmodel and cached against it. Nothing is recomputed -
 * each value comes from that field's own `value(v)`, the same call the card
 * makes, so a number here can never disagree with the card it came from.
 */
const valueCache = new WeakMap();
export function fieldValues(v) {
  if (!v || typeof v !== 'object') return new Map();
  const hit = valueCache.get(v);
  if (hit) return hit;
  const m = new Map();
  Object.keys(PAGES).forEach((page) => {
    (PAGES[page].groups || []).forEach((group) => {
      let fields;
      try { fields = group.from ? group.from(v) : group.fields; } catch (e) { fields = null; }
      (fields || []).forEach((f) => {
        if (!f || !f.value) return;
        let val;
        try { val = f.value(v); } catch (e) { val = undefined; }
        if (val !== undefined && val !== null && val !== '') m.set(page + '|' + f.label, val);
      });
    });
  });
  valueCache.set(v, m);
  return m;
}

/**
 * The tabs the admin rail still mirrors as pages of cards.
 *
 * LIVE, DETAIL, SOCIAL, WALLETS and ROTATION were removed from the rail on
 * 2026-10-05: the SCORE PIPELINE tab and DATA FLOW now show how one token is
 * fetched, scored and displayed, and those five pages repeated it a panel at a
 * time. Their catalogues moved to admin/pipeline-shown.js as the pipeline's
 * step 6, SHOWN ON THE DASHBOARD: listed at the foot of the SCORE PIPELINE tab
 * and drawn as the map's last column.
 */
export const MIRROR_PAGES = ['pipe', 'market', 'alerts', 'eval', 'health'];

/** The token tabs, now step 6 of the pipeline rather than pages of their own. */
export const MAP_ONLY_PAGES = new Set(['live', 'detail', 'social', 'wallets', 'rotation']);
