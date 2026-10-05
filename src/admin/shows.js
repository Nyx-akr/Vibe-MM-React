/**
 * What each panel and each number actually SHOWS, in plain words.
 *
 * provenance.js answers "where did this come from". This answers the question
 * that comes first and that the dashboard cannot answer either: what am I
 * looking at. Someone who has never seen the tab should be able to read the
 * panel block, look at the screen, and know what every control and every
 * figure in front of them is for.
 *
 * It lives apart from provenance.js for two reasons. It is prose, and prose is
 * edited by different people at different times than an expression tree is;
 * and it is keyed by LABEL, which means a dynamic group - the score
 * components, the provider rows, the rank bands - gets a description without
 * provenance.js having to generate one.
 *
 * Lookup order for a field: exact label, then the first matching prefix in
 * `_starts`. A field with neither simply shows no line, which is better than a
 * generic one that says nothing.
 *
 * Rules for writing here:
 *   - say what the reader sees, not how it is computed (that is the card below)
 *   - name the controls, the states and the colours, because those are the
 *     parts with no other documentation anywhere
 *   - if a number can be absent or withheld, say when and why
 */

/** One level of nesting is allowed: `{ t, sub: [...] }`. */
export const SHOWS = {

  /* ------------------------------------------------ LIVE OPPORTUNITIES -- */
  live: {
    _panels: {
      'HEADER STATS': [
        'Five tiles summarising the whole board, recomputed every 5 seconds — they describe the rows currently on screen, not the market.',
        {
          t: 'Left to right:',
          sub: [
            'Tokens tracked — how many pools survived screening across every chain.',
            'Confirmed+ and Exceptional — how many of those reached the two highest stages.',
            'Avg organic score — how genuine the trading looks, averaged over the tokens we sampled ourselves.',
            'Precision@20 — of the twenty highest-ranked tokens at a moment in the past, how many actually rose by the horizon.',
          ],
        },
        'A tile shows a dash rather than a number whenever the sample behind it is too thin to act on. The sub-line under it says which floor it failed.',
      ],
      'FEED COLUMNS': [
        'The table itself: one row per screened pool, sorted by whichever column header you click.',
        'Above it, filters for view (all / watchlist / confirmed / experimental), chain, and class, plus a search box that matches symbol or name.',
        {
          t: 'Each row carries, left to right:',
          sub: [
            'A star to watchlist it, and an eye on the row the token-scoped tabs are describing.',
            'Identity — symbol, name, chain, class and pool age.',
            'Stage badge and score, with confidence under the score.',
            'Price with its 5-minute move, liquidity, volume, wash risk, net flow and buyer count.',
            'A sparkline of recent 5-minute volume.',
          ],
        },
        'Clicking a row focuses the token and expands it — it does not navigate away. The expanded strip repeats the same figures captioned in words.',
        'A small ring beside a score means that token was scored before its contract and holder data arrived.',
      ],
    },
    'TOKENS TRACKED': 'How many pools are on the board right now, after screening — the denominator for everything else on this tab.',
    'CONFIRMED+': 'How many tokens reached CONFIRMED or EXCEPTIONAL. The quick read on whether the board is finding anything today.',
    EXCEPTIONAL: 'How many tokens scored 85 or above — the top band, usually zero or a handful.',
    'AVG ORGANIC SCORE': 'How genuine the trading looks across the board, 0–100, averaged only over tokens we sampled ourselves. The sub-line says how many that was.',
    'TOP 20 HIT RATE': 'Of the twenty highest-ranked tokens at a past moment, the share that rose by the horizon — the one tile that grades the board rather than describing it. ' +
      'A dash means the sample was too thin to report, and the sub-line says which floor it failed: too few resolved picks, too few separate moments, or no horizon resolving at all. ' +
      'The label names the horizon actually used, which is not always 24h.',
    SCORE: 'The headline ranking number, 0–100, averaged over the last 15 minutes so the board does not reshuffle on every poll.',
    CONF: 'How much of the scoring model actually resolved for this token — 1.00 means every input was available.',
    PRICE: 'Current price in dollars, from whichever provider answered first.',
    'DELTA 5M': 'How much the price moved in the last 5 minutes. Green up, pink down.',
    LIQUIDITY: 'Dollars sitting in the pool. Low liquidity means a small trade moves the price a lot.',
    VOLUME: 'Dollars traded — 5-minute or 24-hour, depending on the adjusted-view toggle.',
    WASH: 'How much of the volume looks like the same wallets trading with themselves. Lower is better; above roughly a third is mostly self-trading.',
    'NET FLOW': 'Dollars bought minus dollars sold in the window. Positive means more money came in than left.',
    BUYERS: 'How many wallets bought in the last 5 minutes.',
    STAGE: 'Which band the score falls in: WATCH, EMERGING, CONFIRMED or EXCEPTIONAL.',
    AGE: 'How long ago the pool opened.',
    'TREND (sparkline)': 'Recent 5-minute volume drawn as bars. Empty when the server has not held the pool long enough to draw one.',
  },

  /* ------------------------------------------------------ ASSET DETAIL -- */
  detail: {
    _panels: {
      'THE SCORE': [
        'The one token you have selected, and the arithmetic behind its number.',
        {
          t: 'Two scores are shown deliberately:',
          sub: [
            'FINAL — the settled score, averaged over 15 minutes. This is what the board ranks on and what the stage badge follows.',
            'RIGHT NOW — this poll on its own. The gap between the two is how volatile the token is at the moment.',
          ],
        },
        'Under them, the arithmetic: a raw weighted score, minus a risk penalty, clamped to 0–100.',
        'Confidence says how much of the model resolved; score basis says whether the contract and holder data has arrived yet.',
      ],
      'SCORE DECOMPOSITION': [
        'Every component of the score as its own bar, with the weight it carries and the reading behind it.',
        'A greyed row is a component no provider could answer for — it is left out of the average rather than counted as zero, so a missing source never drags the score down.',
        'The weights come from the live model, so this list is as long as the model is.',
      ],
      'MARKET TILES': [
        'Provider readings for this token, shown exactly as reported — holder counts, supply, routed price impact, cross-source price checks, launchpad, sell simulation.',
        'Grey means no provider answered for this token or this chain. Several sources are Solana-only or EVM-only, so gaps are normal rather than failures.',
      ],
      'PRICE & SCORE': [
        'The price of the pool as candles, with our own scores drawn over it on a 0-100 scale: the average score, the score from this poll, and any of the components behind it.',
        'Pick a range — 1H, 6H, 24H or 7D — to look back and see whether what we scored came before what the price did.',
        'Scores exist only for hours the app was open, so a line can start later than the candles.',
      ],
      'WHAT MOVES THIS SCORE': [
        'The same components again, but as POINTS — how far each one pushed the score above or below a neutral 50.',
        'Positive chips pushed the score up, negative pulled it down, and they add up to the raw score minus 50, so the panel can print its own arithmetic.',
        'This is the panel to read when you want to know why a token scored what it did, rather than what its inputs were.',
      ],
      'RISK FLAGS': [
        'Specific things wrong with this token, each with a severity — HIGH, MED or LOW — and a sentence saying what triggered it.',
        'Each flag carries a penalty that is subtracted from the score, capped at 15 points in total however many fire.',
        '"None triggered" is a real result, not an empty panel.',
      ],
      'CONTRACT SAFETY': [
        'Pass or fail on each contract check three providers run: honeypot simulation, mint and freeze authority, LP lock, insider graph, measured buy and sell tax.',
        'The share that passed becomes a modifier on the score, so a contract that fails checks cannot score highly on market activity alone.',
      ],
      'OUTCOME TRACKING': [
        'What happened after the score, at 15 minutes, 1, 4, 12 and 24 hours.',
        'Every horizon is currently a dash — this panel is not wired to the measurement. The EVALUATION tab does measure forward returns.',
      ],
    },
    FINAL: 'The settled score — the one the board ranks on and the stage badge follows.',
    'RIGHT NOW': 'What this token scores on this poll alone. A wide gap to FINAL means it is still moving.',
    RAW: 'The weighted average of every component that resolved, before risk penalties.',
    'RISK PENALTY': 'Points subtracted for triggered risk flags, capped at 15 however many fire.',
    CONFIDENCE: 'What fraction of the model resolved for this token. Below about 0.7, treat the score as provisional.',
    'SCORE BASIS': 'Whether contract, holder and routed-impact data has arrived yet, and how many inputs are in.',
    'CANDLES': 'Where the price candles come from for each range: minute bars up to 6 hours, 15-minute bars for 24 hours and 7 days.',
    'SCORE LINES': 'Our own recorded scores, drawn over the price on the same time axis.',
    'FORWARD RETURNS': 'What the token did after it was scored. Not measured on this panel.',

    // The twelve components and two modifiers. These labels come from the
    // live score model, so they are described here rather than generated.
    'Volume anomaly': 'Whether volume is unusually high for THIS pool\u2019s own recent normal, not against other tokens.',
    'Trade activity': 'The same question asked of the number of buys rather than the dollars.',
    'Buyer breadth': 'How many different wallets are buying — width of interest, not size of it.',
    'Net demand': 'Whether more money is arriving than leaving.',
    'Liquidity / executability': 'Whether you could actually get in and out at size, combining pool depth with the price impact of a $10k route.',
    'Price confirmation': 'Whether two independent providers agree on the price. Disagreement usually means a thin or stale pool.',
    'Holder growth': 'Whether the holder count is rising, over the last hour.',
    'Wallet quality': 'How clean the holder and trader base looks. Produced on the WALLETS tab; this is the same number, not a second opinion.',
    'Capital rotation': 'Whether money is arriving from other tokens the same wallets were in.',
    'Cross-venue confirm': 'Whether it trades in more than one venue, and whether the sources agree it exists.',
    'USD reference': 'Whether the quote token\u2019s price here agrees with the exchanges. Guards against a mispriced pair.',
    'Data quality': 'How much of the model resolved. Scored as a component so a token nobody can measure cannot top the board.',
    'Organic flow': 'How genuine the trading looks — our own read, with Jupiter shown beside it as a cross-check rather than averaged in.',
    'Contract safety': 'The share of contract checks that passed. A modifier, so failing checks pull down a score built on market activity.',

    // Market tiles: provider readings, one line each.
    'ORGANIC \u00b7 JUPITER': 'Jupiter\u2019s own organic-volume score, shown next to ours for comparison. Never averaged into ours.',
    'ORGANIC VOL 24H': 'What share of the day\u2019s volume Jupiter classes as organic.',
    'HOLDERS \u0394 1H': 'How much the holder count moved in the last hour.',
    'CIRC SUPPLY': 'Tokens actually in circulation.',
    'DEV MIGRATIONS': 'How many other tokens this deployer has launched. Above zero is worth a look; a large number is a factory.',
    LAUNCHPAD: 'Which launchpad minted it, when a provider names one. This is what decides MEME versus TOKEN on the board.',
    'PRICE vs LLAMA': 'How far this price is from DefiLlama\u2019s independent one. A third opinion on price.',
    'SELL SIMULATION': 'Whether a sell actually executes in simulation. FAIL means a honeypot.',
    _starts: [
      ['RISK FLAGS', 'A specific problem found with this token, and the penalty it costs.'],
      ['HIGH flag', 'A serious problem — these carry the largest score penalty.'],
      ['MED flag', 'A moderate problem worth knowing about before acting.'],
      ['LOW flag', 'A minor caveat, penalised lightly.'],
    ],
  },

  /* ----------------------------------------------------------- WALLETS -- */
  wallets: {
    _panels: {
      WINDOW: [
        'The sample everything else on this tab is computed from: one pool’s recent trades, with how many trades, how many wallets, how long a span, and how long ago it was taken.',
        'Opening this tab asks the server to sample the pool right away. If the provider refuses, a slightly older sample already in memory is used instead and the line says so.',
      ],
      'WALLET STATS': [
        'Five numbers describing who traded this token in the sampled window, rather than how much was traded.',
        {
          t: 'What to look for:',
          sub: [
            'Top wallet share above 25% means one address is most of the volume.',
            'Any co-entry wallets at all means a group arrived together, which is the pattern behind faked demand.',
            'Buyers and sellers close together means real two-way trading rather than a one-sided pump.',
          ],
        },
      ],
      'WALLET QUALITY': [
        'A single 0–100 verdict on how clean the holder and trader base looks, with the parts it is made of underneath.',
        'Graded CLEAN, MIXED or POOR. A part that could not be measured is left out of the average rather than scored zero, and the coverage line says how many of the checks were measurable.',
        'This tab owns the number: the score consumes what is produced here, so the figure on ASSET DETAIL is always this one.',
      ],
      'BACKGROUND SERVICE': [
        'The always-on service that analyses wallets across every pool the server has sampled, whether or not this tab is open.',
        'It shows how many pools are watched, how many wallets are in memory, how many coordinated groups have been logged, and when it last ran.',
        'It issues no extra provider calls of its own — it re-reads samples the server already holds.',
      ],
    },
    'SAMPLE WINDOW': 'Which trades this tab is describing, and how fresh they are.',
    'ACTIVE WALLETS': 'How many separate addresses traded this token in the window.',
    'NET FLOW': 'Dollars bought minus dollars sold across every wallet in the window.',
    'BUYERS / SELLERS': 'How many wallets bought and how many sold. A wallet that did both counts on each side.',
    'TOP WALLET SHARE': 'What share of the window’s volume the single largest wallet was. Above 25% is one address carrying the token.',
    'CO-ENTRY WALLETS': 'How many wallets arrived as a group rather than independently — the signature of one person running many addresses.',
    'WALLET QUALITY': 'The overall verdict on the holder and trader base, 0–100, graded CLEAN, MIXED or POOR.',
    'WALLET INTEL': 'Whether the background wallet service is running, and how far its coverage reaches.',
  },

  /* ---------------------------------------------------- SOCIAL SCANNER -- */
  social: {
    _panels: {
      'SOCIAL STATS': [
        'How much this token is being talked about, measured inside a corpus of posts collected for every token rather than searched for this one.',
        {
          t: 'The two numbers that matter more than the raw count:',
          sub: [
            'Per author — mentions divided by distinct authors. Above 3 means one account repeating itself, not a crowd.',
            'Vs baseline — mentions against this ticker’s own normal level. 2× or more is a genuine spike.',
          ],
        },
        'A dash means the ticker could not be matched against the corpus, which is stated rather than filled with a zero.',
      ],
      MEASUREMENT: [
        'How the comparison is being made: how long the baseline has been building, how many tokens are measured per sweep, and how many feeds answered.',
        'The baseline keeps building with this tab closed, so a ticker opened for the first time can still be compared against its own history.',
      ],
    },
    MENTIONS: 'How many posts in the collected corpus mention this ticker.',
    'UNIQUE AUTHORS': 'How many different accounts those mentions came from.',
    'PER AUTHOR': 'Mentions divided by authors. Above 3 is one account talking to itself.',
    'VS BASELINE': 'How far above or below this ticker’s normal chatter level it is right now.',
    'POSTS SCANNED': 'How big the corpus is — the denominator for every count on this tab.',
    BASELINE: 'How much history the comparison has behind it, and what normal looks like for this ticker.',
    COVERAGE: 'How many tokens the social service is measuring, and how many have chatter right now.',
    'SOURCES ANSWERING': 'How many of the configured feeds returned posts on the last sweep.',
  },

  /* ---------------------------------------------------------- ROTATION -- */
  rotation: {
    _panels: {
      'TOKEN ROTATION': [
        'Whether money is moving INTO this token out of other tokens, or out of it into them — measured by following the same wallets across pools.',
        {
          t: 'Four numbers:',
          sub: [
            'Net rotation — arrived minus left. Positive means this token is winning capital from its neighbours.',
            'Arrived and Left — the two sides of that, separately.',
            'Connected pools — how many other pools share at least one wallet with this one.',
          ],
        },
        'Only pools the server has actually sampled can appear, so this is a floor on the real rotation, never the whole picture.',
      ],
      'CHAIN ROTATION': [
        'The same question across the whole chain: how much money moved between sampled pools, and a map of which pools fed which.',
        'Wallets holding two pools at once are held OUT of the rotated total — that is money sitting in both, not money moving between them.',
      ],
      SERVICE: [
        'The always-on graph service behind this tab: how many chains it holds and how many pools it has connected.',
        'It costs nothing extra to run — it rides the wallet sample rather than polling for its own data.',
      ],
    },
    'NET ROTATION': 'Money arriving from other tokens minus money leaving for them. Positive means this token is pulling capital in.',
    ARRIVED: 'Dollars that came in from wallets that had just sold another sampled pool.',
    LEFT: 'Dollars that left for wallets that then bought another sampled pool.',
    'CONNECTED POOLS': 'How many other pools share at least one wallet with this one.',
    'ROTATION SERVICE': 'Whether the rotation graph is running, and how much of the market it currently covers.',
    _starts: [
      ['CHAIN ROTATED', 'Total dollars that moved between sampled pools on this chain in the window.'],
      ['PARALLEL', 'Dollars from wallets holding both pools at once — excluded, because it is not a move between them.'],
    ],
  },

  /* ---------------------------------------------------- MARKET ROTATION -- */
  market: {
    _panels: {
      'MARKET STATS': [
        'Where money moved between pools across the whole market, rather than for the one token you have open.',
        {
          t: 'Three numbers:',
          sub: [
            'Measured rotation \u2014 dollars that left one sampled pool and arrived in another.',
            'Pools sampled \u2014 the coverage everything else on the page rests on.',
            'Parallel \u2014 wallets that bought both or sold both, held out, because holding two positions is not money moving between them.',
          ],
        },
        'Every figure is a floor, never a total: only pools the sampler has reached can take part, and nothing is counted across chains.',
      ],
      'WHERE IT WENT': [
        'The pools that gained the most and lost the most, up to six each way, with what each took in and gave up on hover.',
      ],
      CHAINS: [
        'One ribbon diagram per chain: pools on the left gave money to pools on the right, and the thickness is how much.',
        'When there are more flows than can be drawn, the caption says how many of them are shown and what share of the total that is.',
      ],
      SERVICE: [
        'The background graph behind this tab \u2014 how many chains it holds and when it last rebuilt.',
        'It costs no extra provider calls: it reads the trade samples the wallet service already pulled.',
      ],
    },
    'MEASURED ROTATION': 'Dollars that moved between sampled pools, summed across chains.',
    'POOLS SAMPLED': 'How many pools the sampler has reached. Everything else on this tab is limited by it.',
    'PARALLEL \u2014 EXCLUDED': 'Money from wallets that moved the same way in two pools \u2014 excluded, because that is two positions rather than a move.',
    'NET MOVERS': 'Pools that gained or lost capital to their neighbours in this window.',
    'ROTATION SERVICE \u00b7 MARKET': 'Whether the chain-level rotation graph is running, and how fresh it is.',
  },

  /* ------------------------------------------------------- ALERT CARDS -- */
  alerts: {
    _panels: {
      COLUMNS: [
        'Tokens that crossed a threshold, in three columns by what the crossing means: OPPORTUNITY, RISK and RESOLUTION.',
        'Each card names the token, what fired, and the conditions that would retire the alert — so an alert can be wrong in a way you can check rather than just disappear.',
        'The newest three also appear as toasts over the dashboard; the rest queue behind them.',
      ],
      INVALIDATION: [
        'The rules that retire an alert: what would have to become true for it to no longer apply.',
        'This is what separates an alert from a notification — each one states in advance what would disprove it.',
      ],
    },
    OPPORTUNITY: 'Tokens whose score and stage cleared the opportunity thresholds.',
    RISK: 'Tokens carrying a triggered risk flag.',
    RESOLUTION: 'Alerts that have already played out, kept as the record of what happened.',
    'INVALIDATION RULES': 'How many retirement conditions are currently attached across the open alerts.',
  },

  /* -------------------------------------------------------- EVALUATION -- */
  eval: {
    _panels: {
      'THE ANSWER': [
        'The top of the page. Two controls in the page header apply to everything below: TIME WINDOW (1H / 6H / 24H — how long after a score the price is checked; greyed options have too little data yet) and GROUP BY (RANK — where the token stood on the board at that moment; SCORE — the stage band).',
        'A verdict badge: EDGE (blue), NO CLEAR EDGE (amber), INVERTED (pink) or COLLECTING (grey, not enough data yet), with one plain sentence.',
        {
          t: 'Three numbers:',
          sub: [
            'Rank IC: how closely score order matched return order.',
            'Top − Bottom: how much better the top 20% did than the bottom 20%.',
            'Ordered: how many steps down the ranking went the right way.',
          ],
        },
        'A strip of bars, one per 15-minute moment, oldest on the left: blue above the line when the ordering worked at that moment, pink below when it was backwards. Mostly blue means a steady edge rather than one lucky burst.',
      ],
      'HOW MUCH DATA': [
        'Beside the answer: how many predictions it stands on.',
        'A stacked bar splits them into resolved (pink — the outcome is known), maturing (blue — too young, never a loss) and in a price gap (amber — the price record has a hole, left out).',
        'A READY TO JUDGE checklist ticks when there are enough resolved predictions over enough separate moments; until both tick the verdict stays COLLECTING.',
      ],
      'HOW EACH GROUP DID': [
        'The evidence, full width: one row per group from highest ranked to lowest (or highest score band to lowest).',
        'The bar shows how the group did against the whole board at the same moment — right of the centre line is better, left is worse. If the score works, the bars step from right to left going down.',
        'Columns: excess, beat rate, raw return, went-up rate, best and worst point in the window, rug rate, average score and count. Faded rows have too few predictions to compare.',
      ],
      'IN PRICE': [
        'What all checked predictions looked like in plain price terms, market included: median return, share that went up, typical best and worst point, and rug rate.',
      ],
      'WARNING FLAGS': [
        'Each warning flag the score model attached, with two bars: how often it appeared on predictions that then did worse than the board (pink) and on ones that did better (blue).',
        'A flag with a much longer pink bar is a real warning; one with equal bars warns of nothing. LOSS RATE is the share of that flag’s predictions that lost.',
      ],
    },
    'OUTCOME REPORT': 'Whether the score-versus-outcome measurement has run yet on this tab.',
    VERDICT: 'The overall answer: EDGE, NO CLEAR EDGE, INVERTED, or COLLECTING while there is not enough data.',
    'RANK IC': 'How closely the score ordering matched the return ordering, with a t-statistic checking it is not luck. Around 0.03–0.05 is already useful for a screener.',
    'RANK IC · EACH MOMENT': 'The strip of bars under the three numbers — the same Rank IC, one bar per 15-minute moment.',
    'TOP − BOTTOM': 'How much better the top fifth by score did than the bottom fifth. Withheld when either group is too small.',
    ORDERED: 'How many steps down the ranking went the right way — a check that the ordering holds in the middle, not just at the ends.',
    INPUTS: 'How much data the measurement had: predictions from the score journal, outcomes from the recorded price series.',
    PREDICTIONS: 'Every prediction split three ways: resolved (a known outcome at the selected window), maturing (never counted as a loss), or in a price gap. One per token per 15 minutes, so a token watched all hour counts about 4 times, not 60.',
    'READY TO JUDGE': 'The two checks the verdict needs before it will say anything but COLLECTING.',
    'TOKENS SCORED': 'How many tokens the app has a score history for, and how many of those have a recorded price to check against.',
    'EXCESS RETURN': 'How the tokens did against the rest of the board at the same moment, rather than in absolute terms — memecoins move together, so raw return mostly measures the day.',
    'MEDIAN RETURN': 'The typical raw return of every checked prediction at the selected window, market included.',
    'WENT UP': 'The share of checked predictions whose price was simply higher at the end.',
    'BEST / WORST POINT': 'The typical best and worst price reached between the score and the end of the window.',
    'RUG RATE': 'The share of checked predictions whose liquidity fell by more than 80% by the end of the window.',
    'BRIER / ECE': 'How well the score works as a probability rather than a ranking. Shown here, off the tab, because the score was never built to be one.',
    'FLAG COMPARISON': 'How many flags had enough predictions to compare, and how many losers and winners they were compared across.',
    _starts: [
      ['RANK ', 'One fifth of the board by rank at each moment, with how it did against the rest.'],
      ['SCORE ', 'One score band, with how the tokens in it did against the rest of the board.'],
      ['FLAG ', 'One warning flag: how often it came before a loss compared with before a win.'],
    ],
  },

  /* ------------------------------------------------------ SYSTEM HEALTH -- */
  health: {
    _panels: {
      VERDICT: [
        'The whole system in one line: operational, degraded or outage, with the problems that set it.',
        'Before the first report lands it says "Checking…" rather than guessing.',
      ],
      PARTS: [
        'Seven parts, each judged on whether it is doing its job right now: the collector server, the market board per chain, data sources, background jobs, data files, the history archive and the services in this browser.',
      ],
      'DATA SOURCES': [
        'One row per upstream provider, grouped by what it is for. Status is judged on the last 15 minutes: DOWN at half the calls failing, DEGRADED at a tenth. One stray timeout is not a status.',
        'Only market data is critical. A dead social feed thins one panel; it does not stale the board.',
      ],
      'THIS BROWSER': [
        'The services running inside the browser rather than on the server. If one stalls, the panels reading it go quietly stale and nothing else would say so.',
      ],
      'SERVER & ARCHIVE': [
        'What the collector is holding and how big the archive on disk is.',
      ],
    },
    OVERALL: 'The worst level across every part, with its reasons.',
    'HISTORY POOLS': 'How many pools the server is keeping a rolling sample series for.',
    ARCHIVE: 'Bytes of history the server has archived to disk.',
    'ROTATION GRAPHS HELD': 'How many chains and pools the browser rotation service currently has connected.',
  },
};

/** The plain-words block for a panel, or null. */
export function showsForPanel(page, group) {
  const p = SHOWS[page];
  const panels = p && p._panels;
  return (panels && panels[group]) || null;
}

/**
 * The plain-words line for a field: exact label first, then the prefix rules.
 *
 * A field with neither gets nothing, which is deliberate - a generic sentence
 * that fits every number says nothing about any of them, and the page is
 * already dense enough without one.
 */
export function showsForField(page, label) {
  const p = SHOWS[page];
  if (!p || !label) return null;
  if (Object.prototype.hasOwnProperty.call(p, label) && label !== '_panels' && label !== '_starts') {
    return p[label];
  }
  const starts = p._starts || [];
  for (let i = 0; i < starts.length; i += 1) {
    if (String(label).indexOf(starts[i][0]) === 0) return starts[i][1];
  }
  return null;
}
