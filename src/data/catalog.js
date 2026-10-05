/**
 * Documentation of where every Asset Detail value comes from and how it is
 * derived. It lives in the app, beside src/calculations, because that is where
 * the derivation now happens - the server is upstream of all of it, fetching
 * and remembering raw numbers and doing no maths at all.
 *
 * Component weights are not repeated here - they are read from SCORE_MODEL at
 * runtime and merged in by payload().
 */

/**
 * `url` is where a human goes to check what the provider actually returns.
 * The admin panel shows it on hover behind every value that came from there,
 * so a disputed number can be checked at the source. "history" is our own
 * server, so its url is a path on whichever server answered.
 */
export const SOURCES = [
  {
    id: "geckoterminal", url: "https://www.geckoterminal.com/dex-api", label: "GeckoTerminal", keyless: true,
    limit: "~10 req/min accepted in practice (documented ~30); the server paces itself adaptively",
    endpoints: ["/networks/{net}/trending_pools", "/pools/{pool}/ohlcv/minute", "/pools/{pool}/trades"],
    provides: "price, liquidity, volume 5m/1h/24h, txns, traders, pool age, OHLCV bars, wallet-level trades",
    role: "pool discovery - decides which pools exist; the list is cached 3 min and the last good list is reused when it rate-limits",
  },
  {
    id: "dexscreener", url: "https://docs.dexscreener.com/api/reference", label: "DexScreener", keyless: true, limit: "~300 req/min",
    endpoints: ["/latest/dex/tokens/{addresses}"],
    provides: "price, liquidity, volume, market cap, FDV, txns, socials - preferred over GeckoTerminal where both answer",
    role: "pricing - refreshed on every request, so values move at DexScreener's pace rather than the list's",
  },
  {
    id: "jupiter", url: "https://dev.jup.ag/docs", label: "Jupiter", keyless: true, chains: "Solana only",
    endpoints: ["/tokens/v2/search (batched 40 mints)", "/swap/v1/quote"],
    provides: "holder count and change, USD buy/sell split, organic volume split, circulating supply, dev audit, launchpad, routed $10k price impact, and its own organic score",
    role: "cross-check for organic flow - its organic score is compared against ours and shown beside it, never averaged into it; it substitutes only where we have no trade sample, and the row says so when it does",
  },
  {
    id: "kyberswap", url: "https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/aggregator-api-specification", label: "KyberSwap", keyless: true, chains: "EVM only",
    endpoints: ["/{chain}/api/v1/routes"],
    provides: "routed $10k price impact on Ethereum, Base, BSC, Arbitrum, Polygon, Avalanche",
  },
  {
    id: "goplus", url: "https://docs.gopluslabs.io/reference/response-details", label: "GoPlus", keyless: true,
    endpoints: ["/token_security/{chainId}"],
    provides: "contract safety checks, holder count, top-10 holder list",
  },
  {
    id: "rugcheck", url: "https://api.rugcheck.xyz/swagger/index.html", label: "RugCheck", keyless: true, chains: "Solana only",
    endpoints: ["/tokens/{mint}/report"],
    provides: "LP lock %, insider graph, creator token count, risk list",
  },
  {
    id: "honeypot", url: "https://docs.honeypot.is/", label: "honeypot.is", keyless: true, chains: "EVM only",
    endpoints: ["/v2/IsHoneypot"],
    provides: "simulated buy and sell, measured buy/sell tax",
  },
  {
    id: "defillama", url: "https://defillama.com/docs/api", label: "DefiLlama", keyless: true,
    endpoints: ["/prices/current/{chain}:{token}"],
    provides: "independent price and confidence, as a third opinion on price",
  },
  {
    id: "ethos", url: "https://developers.ethos.network", label: "Ethos Network", keyless: true,
    limit: "200 req/min, measured from the ratelimit-policy header; bulk, so a whole board costs one call",
    endpoints: ["POST /api/v2/score/userkeys", "POST /api/v2/score/addresses"],
    provides: "reputation score and level for an X account or an Ethereum address",
    role: "project identity - scores the X account a token advertises, which works on all eight chains because it is a handle, not an address. " +
      "A score of 0 means Ethos has never seen the identity, NOT a bad reputation, and the panels grey it rather than colouring it. " +
      "1200 is the starting score. Raises a risk flag and never a score penalty.",
    chains: "all (by handle); addresses are EVM only - Solana addresses are rejected",
  },
  {
    id: "cex", url: "https://www.coingecko.com/en/api/documentation", label: "Binance + Coinbase + CoinGecko", keyless: true,
    endpoints: ["spot price"],
    provides: "quote-token USD median (SOL / ETH / BNB ...)",
  },
  {
    id: "history", url: "/raw/manifest.json", label: "Raw store (written by the collector, archived to disk)", keyless: true,
    endpoints: ["/raw/<chain>/history.json", "/raw/<chain>/observations.json", "/raw/<chain>/trades.json"],
    provides: "15s pool samples, 60s price/liquidity observations, holder series and sampled trades - all raw, so the app can build baselines over a window longer than one page view",
  },
];

export const PANELS = [
  {
    panel: "SCORE DECOMPOSITION",
    fields: [
      { field: "Volume anomaly", source: "geckoterminal + history", freshness: "15s samples, needs 8",
        formula: "clamp01(0.5 + 0.3 x log10(vol5m / mean vol5m over the window)) x 100" },
      { field: "Trade activity", source: "geckoterminal + history", freshness: "15s samples, needs 8",
        formula: "same shape as volume anomaly, applied to the 5m buy count" },
      { field: "Buyer breadth", source: "geckoterminal", freshness: "live",
        formula: "0.5 x multipleScore(buyers5m / baseline) + 0.5 x logScore(buyers24h, 10, 3000)" },
      { field: "Net demand", source: "jupiter, else geckoterminal trades, else txn counts", freshness: "30s cache",
        formula: "clamp01(0.5 + netRatio / 2) x 100 where netRatio = (buyUSD - sellUSD) / totalUSD" },
      { field: "Liquidity / executability", source: "geckoterminal + jupiter or kyberswap", freshness: "5min cache",
        formula: "0.5 x logScore(liquidityUsd, 1e4, 1e6) + 0.5 x clamp01(1 - impactPct / 2.5) x 100" },
      { field: "Price confirmation", source: "dexscreener vs geckoterminal", freshness: "live",
        formula: "clamp01(1 - abs(priceDeltaPct) / 5) x 100; flat 40 when only one source priced it" },
      { field: "Holder growth", source: "jupiter, else holder series", freshness: "30s cache",
        formula: "clamp01(0.5 + holderChange1hPct / 4) x 100" },
      { field: "Wallet quality", source: "goplus + rugcheck, else jupiter audit", freshness: "5min cache",
        formula: "clamp01(1 - top10SharePct / 60), x0.75 if insiders detected, x0.8 if creator has >20 tokens, x1.15 if LP >90% locked" },
      { field: "Capital rotation", source: "geckoterminal trades", freshness: "one pool sampled per 20s",
        formula: "clamp01(sharedWalletPct / 25) x 100 - wallets this pool shares with other sampled pools" },
      { field: "Cross-venue confirm", source: "dexscreener", freshness: "live",
        formula: "logScore(venueCount, 1, 20) x (sourcesAgreeing > 1 ? 1 : 0.6)" },
      { field: "USD reference", source: "cex", freshness: "60s cache",
        formula: "clamp01(1 - deviationPct / 2) x 100 where deviation = |quotePrice - median| / median x 100" },
      { field: "Data quality", source: "self", freshness: "live",
        formula: "measured components / 11 x 100" },
      { field: "Organic flow", source: "wallet intel (our trade sample), jupiter only as labelled fallback", freshness: "pool sampled on rotation, re-analysed every 5s tick", modifier: true,
        formula: "organicFlowScore() - weighted mean of 4 parts, see the ORGANIC FLOW panel below" },
      { field: "Contract safety", source: "goplus + rugcheck + honeypot", freshness: "5min cache", modifier: true,
        formula: "passed checks / total checks x 100" },
      { field: "RAW", source: "computed", freshness: "live",
        formula: "sum(component value x weight) / sum(weights of components that computed)" },
      { field: "RISK PENALTY", source: "computed", freshness: "live",
        formula: "min(15, sum of triggered risk-flag penalties)" },
      { field: "FINAL", source: "computed", freshness: "live",
        formula: "clamp(RAW - PENALTY, 0, 100)" },
    ],
  },
  {
    panel: "EXECUTION PRICE",
    fields: [
      { field: "Bars (primary)", source: "geckoterminal", freshness: "150s cache",
        formula: "last 60 one-minute closes from the OHLCV endpoint" },
      { field: "Bars (fallback)", source: "history", freshness: "15s samples",
        formula: "this server's own priceUsd series, drawn when GeckoTerminal rate-limits the request" },
      { field: "Bar height", source: "computed", freshness: "-",
        formula: "8 + (close - min) / (max - min) x 92 percent of panel height" },
      { field: "Price / delta 5M", source: "dexscreener, else geckoterminal", freshness: "live",
        formula: "priceUsd and priceChangePct.m5 as reported" },
    ],
  },
  {
    panel: "MARKET",
    fields: [
      { field: "MKT CAP", source: "dexscreener, else geckoterminal, else jupiter", freshness: "live", formula: "reported directly" },
      { field: "LIQUIDITY", source: "dexscreener, else geckoterminal", freshness: "live", formula: "reported directly" },
      { field: "VOL 5M", source: "dexscreener, else geckoterminal", freshness: "live", formula: "reported directly" },
      { field: "VOL 24H", source: "dexscreener, else geckoterminal", freshness: "live", formula: "reported directly" },
      { field: "BUYERS 5M", source: "geckoterminal", freshness: "live", formula: "traders5m.buyers" },
      { field: "BUYERS 24H", source: "geckoterminal", freshness: "live", formula: "traders24h.buyers" },
      { field: "B/S RATIO 24H", source: "geckoterminal", freshness: "live", formula: "buys24h / sells24h" },
      { field: "VOL/LIQ 24H", source: "computed", freshness: "live", formula: "volume24hUsd / liquidityUsd" },
      { field: "POOL AGE", source: "geckoterminal", freshness: "live", formula: "now - poolCreatedAt" },
      { field: "HOLDERS", source: "goplus, else rugcheck, else jupiter", freshness: "5min cache", formula: "first source that answers; disagreement flagged" },
      { field: "TOP-10 SHARE", source: "goplus", freshness: "5min cache", formula: "sum of the top-10 holders' percentages" },
      { field: "IMPACT $10K", source: "jupiter (Solana) or kyberswap (EVM)", freshness: "5min cache",
        formula: "quote a real $10,000 buy: (amountInUsd - amountOutUsd) / amountInUsd x 100" },
      { field: "NET BUY 5M", source: "jupiter, else geckoterminal trades", freshness: "30s cache", formula: "buyVolume - sellVolume over 5 minutes" },
      { field: "WASH PROB", source: "computed", freshness: "rotation", formula: "100 - our organic flow score (a proxy, not a wash-trading model)" },
      { field: "ORGANIC SCORE", source: "wallet intel (ours)", freshness: "rotation",
        formula: "organicFlowScore() on our own trade sample; suffixed (Jupiter) on the rows where no sample exists yet and Jupiter's number stood in" },
      { field: "ORGANIC · JUPITER", source: "jupiter", freshness: "30s cache",
        formula: "Jupiter's own 0-100 score with (ours - theirs) beside it; pink when they disagree by 25 or more. Shown for comparison - it is NOT what the score, the wash figure or the board average use" },
      { field: "ORGANIC VOL 24H", source: "jupiter", freshness: "30s cache", formula: "(buyOrganic + sellOrganic) / (buy + sell) x 100" },
      { field: "HOLDERS delta 1H", source: "jupiter", freshness: "30s cache", formula: "stats1h.holderChange percent" },
      { field: "CIRC SUPPLY", source: "jupiter", freshness: "30s cache", formula: "circSupply" },
      { field: "DEV MIGRATIONS", source: "jupiter", freshness: "30s cache", formula: "audit.devMigrations - how many prior tokens this dev migrated" },
      { field: "LAUNCHPAD", source: "jupiter", freshness: "30s cache", formula: "launchpad name, e.g. pump.fun" },
      { field: "PRICE vs LLAMA", source: "defillama", freshness: "5min cache", formula: "(feedPrice - llamaPrice) / llamaPrice x 100" },
      { field: "SELL SIMULATION", source: "honeypot", freshness: "5min cache", formula: "simulated buy then sell; EVM chains only" },
    ],
  },
  {
    panel: "ORGANIC FLOW (ours)",
    fields: [
      { field: "Crowd spread", weight: 30, source: "wallet intel", freshness: "rotation",
        formula: "clamp01(onceOnlyPct / 80) x 100 - share of wallets that traded exactly once. Bots round-trip; people buy. 80% is full marks, not an unreachable 100%" },
      { field: "Volume spread", weight: 25, source: "wallet intel", freshness: "rotation",
        formula: "clamp01(1 - (topWalletSharePct - 25) / 50) x 100 - nothing charged below 25%, because one large buyer is ordinary. Same curve as Wallet quality's own volume spread, so the two never disagree about one concentration" },
      { field: "Churn-free", weight: 25, source: "wallet intel", freshness: "rotation",
        formula: "clamp01(1 - (churnWallets / activeWallets) x 1.4) x 100 - CHURN = a wallet round-tripping 4+ trades to under 15% net position: volume that exists to be counted, not to buy" },
      { field: "Entry independence", weight: 20, source: "wallet intel", freshness: "rotation",
        formula: "clamp01(1 - (weightedClusterWallets / activeWallets) x 1.6) x 100, weighted high 1.0 / medium 0.6 / low 0.25 by coEntryClusters() confidence. The part Jupiter has no visible equivalent for" },
      { field: "SCORE", source: "computed", freshness: "rotation",
        formula: "sum(part x weight) / sum(weights of parts that resolved) - a part that could not be measured costs no weight rather than scoring zero" },
      { field: "basis", source: "computed", freshness: "rotation",
        formula: "'sample' = ours, 'jupiter' = no sample yet so Jupiter's number stood in, 'none' = no number. Anything aggregating across tokens MUST filter on this - averaging the first two together is the bug this model was rewritten to remove" },
      { field: "coverage", source: "computed", freshness: "rotation",
        formula: "resolved parts / 4 x 100. The board tile weights each token by max(coverage, 25) so a token read on one part counts less than a complete one" },
      { field: "Minimum sample", source: "wallet intel", freshness: "rotation",
        formula: "10 active wallets. Below that the window is not read at all and basis is 'none' - a thin sample is reported as unmeasured, never as a low score" },
      { field: "Cross-check", source: "jupiter", freshness: "30s cache",
        formula: "carried alongside as { value, delta, diverges } and rendered as its own tile. Never blended into the score" },
      { field: "AVG ORGANIC SCORE (board tile)", source: "computed", freshness: "per poll",
        formula: "sum(score x max(coverage,25)) / sum(max(coverage,25)) over basis === 'sample' rows only; Jupiter-only rows are counted as unscored and reported separately in the subline" },
      { field: "Known overlap", source: "self", freshness: "-",
        formula: "Wallet quality reads three of these same signals over the same sample. The two answer different questions and are consumed differently (12% weighted component vs a modifier feeding the risk penalty), but a token failing both is charged for it twice. Pre-existing, documented rather than hidden" },
    ],
  },
  {
    panel: "STAGE TIMELINE",
    fields: [
      { field: "Stage badge", source: "computed", freshness: "live",
        formula: "bands WATCH 0 / EMERGING 55 / CONFIRMED 70 / EXCEPTIONAL 85; the stage is the final score bucketed and follows it immediately in both directions" },
      { field: "Stage times", source: "app stage memory", freshness: "on change", formula: "transition timestamps kept by the app's stage machine, persisted per browser" },
    ],
  },
  {
    panel: "RISK FLAGS",
    fields: [
      { field: "NEW_POOL", source: "geckoterminal", freshness: "live", formula: "age < 2h gives HIGH and -4; age < 24h gives MED and -2" },
      { field: "SINGLE_SOURCE", source: "computed", freshness: "live", formula: "fewer than 2 providers priced the pool: -3" },
      { field: "THIN_LIQUIDITY", source: "dexscreener", freshness: "live", formula: "liquidity under $50,000: -4" },
      { field: "EXTREME_TURNOVER", source: "computed", freshness: "live", formula: "24h volume more than 20x liquidity: -3" },
      { field: "VOLUME_CONCENTRATED", source: "geckoterminal trades", freshness: "rotation", formula: "top 5 wallets over 70% of traded volume: -4" },
      { field: "CONTRACT_CHECKS", source: "goplus + rugcheck + honeypot", freshness: "5min cache", formula: "any failed check: -3, or -6 when the safety score is below 70" },
      { field: "LOW_ORGANIC_FLOW", source: "wallet intel, else jupiter", freshness: "rotation",
        formula: "organic flow under 40: MED and -3 on our own sample, LOW and -2 when the figure is Jupiter's - a borrowed number we cannot decompose is charged less" },
      { field: "ORGANIC_DISAGREEMENT", source: "computed", freshness: "rotation",
        formula: "|ours - Jupiter| >= 25: LOW and -0. Costs nothing, because a gap is not proof either is wrong - usually the 24h picture and this window simply disagree. It is raised as the point at which one organic number should stop being trusted alone" },
    ],
  },
  {
    panel: "WHAT MOVES THIS SCORE",
    fields: [
      { field: "Points", source: "computed", freshness: "live",
        formula: "(value - 50) x weight / weightUsed - the points this input moved the score against a neutral 50. They sum to (raw score - 50)." },
      { field: "Bar direction", source: "computed", freshness: "live",
        formula: "right and blue when the input helped, left and pink when it held the score back; length is the point contribution" },
      { field: "x normal chip", source: "server samples, computed in app", freshness: "15s samples, needs 8",
        formula: "current / mean over the sample series - shown only for the three inputs that have a baseline" },
      { field: "Tooltip", source: "computed", freshness: "live",
        formula: "the evidence string the component produced, plus its z-score and weight" },
    ],
  },
  {
    panel: "CONTRACT SAFETY",
    fields: [
      { field: "GoPlus checks", source: "goplus", freshness: "5min cache",
        formula: "mint authority, freeze authority, closable account, mutable balance, transfer hook, transfer fee, honeypot signature, verified source, hidden owner, pausable transfers, tax under 10%" },
      { field: "Sell path works", source: "honeypot", freshness: "5min cache", formula: "a simulated sell succeeds (EVM only)" },
      { field: "Simulated tax", source: "honeypot", freshness: "5min cache", formula: "tax measured from the simulation rather than read from the contract" },
      { field: "LP lock / insiders / creator tokens", source: "rugcheck", freshness: "5min cache", formula: "feeds Wallet quality rather than shown as a check" },
    ],
  },
  {
    panel: "OUTCOME TRACKING",
    fields: [
      { field: "15M / 1H / 4H / 12H / 24H", source: "none yet", freshness: "-",
        formula: "NOT WIRED to this panel yet. Both inputs now exist: the server keeps raw prices per token, and the app keeps a score journal. The Evaluation tab already joins the two." },
    ],
  },
];


/**
 * How data moves through the server, for the admin panel's pipeline view.
 * Kept here so the page describes the system as it is rather than as it was.
 */
export const PIPELINE = [
  { stage: "1. Discover (server)", detail: "GeckoTerminal trending_pools decides which pools exist, per chain.",
    cadence: "list cached 3 min; last good list reused on a 429" },
  { stage: "2. Fetch (server)", detail: "DexScreener, Jupiter and the rest are queried for those pools. Every provider's answer is forwarded separately - nothing is blended, ranked or scored upstream.",
    cadence: "every request (0.5s cache)" },
  { stage: "3. Warm (server)", detail: "A background loop refreshes one chain at a time so the chains never burst GeckoTerminal at once, and samples keep accruing with nobody watching.",
    cadence: "one chain every 20s" },
  { stage: "4. Remember (server)", detail: "15s pool samples, 60s price and liquidity observations, holder counts, and one pool's trades per cycle - held in RAM as raw numbers.",
    cadence: "samples every 15s, observations every 60s" },
  { stage: "5. Persist (server)", detail: "An append-only JSONL log on the machine keeps every sample at full detail, and an atomically-rewritten snapshot.json is what boot reloads - so the series survive a restart. No credentials, no cloud.",
    cadence: "pools every 30s, observations every 60s, plus a flush and fsync on shutdown" },
  { stage: "6. Normalize (app)", detail: "calculations/core.js collapses the side-by-side provider values into one row, and derives every ratio, age, delta and baseline from them.",
    cadence: "per poll, in the browser" },
  { stage: "7. Calculate (app)", detail: "calculations/asset-detail.js turns that row plus the baselines into twelve components, two modifiers, risk flags, a score and a stage. This is the only place a score exists. Wallet quality and organic flow are not derived here - they are asked of core.js and recorded, so the tabs and the score read one verdict.",
    cadence: "per poll, in the browser" },
  { stage: "8. Journal (app)", detail: "Each score is written to the score journal, so the Evaluation tab can join it to the server's raw price series and measure whether the score meant anything.",
    cadence: "one mark per token per 60s" },
];

/** Merges live SCORE_MODEL weights into the documented catalogue. */
export function payload(scoreModel) {
  const weights = {};
  (scoreModel || []).forEach((component) => { weights[component.label] = component.weight; });
  return {
    generatedAt: Date.now(),
    sources: SOURCES,
    pipeline: PIPELINE,
    panels: PANELS.map((panel) => ({
      panel: panel.panel,
      // A live SCORE_MODEL weight always wins, so the documented weights of the
      // twelve components cannot drift from the code. Panels that are not the
      // score model (organic flow's own parts) carry their own weights, which
      // are kept rather than blanked.
      fields: panel.fields.map((field) =>
        Object.assign({}, field, { weight: weights[field.field] || field.weight || null })),
    })),
  };
}