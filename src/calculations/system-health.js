/**
 * SYSTEM HEALTH, judged.
 *
 * Takes what the collector wrote about itself (system.json, with providers
 * already run through providerHealth()) and what the browser services report,
 * and answers one question per part of the system: is it doing its job right
 * now? Each part gets a level, a one-line headline and the problems that set
 * the level - never a level without a reason, because "DEGRADED" alone just
 * sends you digging.
 *
 * Pure: no services, no clock except `now`. The tab gathers the inputs.
 *
 * Levels, worst last: ok < warn < down. `unknown` is "not reported yet" and
 * never drags the overall verdict down on its own.
 */

export const LEVEL_RANK = { unknown: 0, ok: 1, warn: 2, down: 3 };
const worst = (levels) => levels.reduce((w, l) => (LEVEL_RANK[l] > LEVEL_RANK[w] ? l : w), 'ok');

/* ------------------------------------------------------------ catalog ---- */

/**
 * What each upstream host is FOR. The group decides how much its failure
 * matters: market data failing means the board is stale; a social source
 * failing only thins one panel. Hosts not listed here still show, as OTHER.
 */
export const SOURCE_GROUPS = [
  { key: 'market', label: 'Market data', critical: true, what: 'pools, prices, trades, bars' },
  { key: 'security', label: 'Security checks', critical: false, what: 'honeypot, rug and contract checks' },
  { key: 'intel', label: 'Token intel & routing', critical: false, what: 'holders, organic flow, price impact' },
  { key: 'prices', label: 'Reference prices', critical: false, what: 'CEX and index prices' },
  { key: 'social', label: 'Social', critical: false, what: 'mentions and chatter' },
  { key: 'other', label: 'Other', critical: false, what: '' },
];

const SOURCES = {
  'api.dexscreener.com': { label: 'DexScreener', group: 'market' },
  'api.geckoterminal.com': { label: 'GeckoTerminal', group: 'market' },
  'lite-api.jup.ag': { label: 'Jupiter', group: 'intel' },
  'aggregator-api.kyberswap.com': { label: 'KyberSwap', group: 'intel' },
  'api.gopluslabs.io': { label: 'GoPlus', group: 'security' },
  'api.rugcheck.xyz': { label: 'RugCheck', group: 'security' },
  'api.honeypot.is': { label: 'honeypot.is', group: 'security' },
  'coins.llama.fi': { label: 'DefiLlama', group: 'prices' },
  'api.binance.com': { label: 'Binance', group: 'prices' },
  'api.coinbase.com': { label: 'Coinbase', group: 'prices' },
  'api.coingecko.com': { label: 'CoinGecko', group: 'prices' },
  'www.reddit.com': { label: 'Reddit', group: 'social' },
  'a.4cdn.org': { label: '4chan', group: 'social' },
  'mastodon.social': { label: 'Mastodon', group: 'social' },
  'api.warpcast.com': { label: 'Farcaster', group: 'social' },
  'public.api.bsky.app': { label: 'Bluesky', group: 'social' },
};

/** Server collectors, in the order a reader cares about them. */
const JOBS = [
  { key: 'market', label: 'Market board', what: 'trending pools + prices, every chain' },
  { key: 'trades', label: 'Trades', what: 'wallet-level trades, one pool per pass' },
  { key: 'intel', label: 'Token intel', what: 'security + holder checks' },
  { key: 'ohlcv', label: 'Price bars', what: 'OHLCV candles' },
  { key: 'social', label: 'Social', what: 'social corpus' },
  { key: 'reference', label: 'Reference prices', what: 'CEX + index prices' },
  { key: 'promotion', label: 'Promotions', what: 'paid boosts and ads' },
  { key: 'system', label: 'Self-report', what: 'writes this page\'s data' },
  { key: 'coverage', label: 'Coverage', what: 'what the archive recorded' },
  { key: 'deep', label: 'Deep history', what: '48h history rebuild' },
  { key: 'probe', label: 'Archive probe', what: 'write + read-back test' },
  { key: 'scan', label: 'Archive scan', what: 'full archive integrity scan' },
];

/** What an error kind means, in words a reader can act on. */
export const ERROR_KIND_TEXT = {
  rateLimited: 'rate-limited (429) — we are calling too fast',
  timeout: 'timing out',
  server: 'provider errors (5xx)',
  client: 'rejecting requests (4xx) — often "token not found"',
  network: 'unreachable',
};

/* ------------------------------------------------------------ helpers ---- */

export function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.round(h / 24) + 'd';
}

export function bytes(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}

function dominantKind(kinds) {
  const entries = Object.entries(kinds || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries[0][0] : null;
}

/* ------------------------------------------------------------- server ---- */

function serverPart(system, now, waiting) {
  if (!system && waiting) {
    return { key: 'server', label: 'Collector server', level: 'unknown', headline: 'Checking…',
      sub: 'reading system.json', problems: [] };
  }
  if (!system) {
    return { key: 'server', label: 'Collector server', level: 'down', headline: 'No report',
      problems: ['system.json could not be read - the collector is not running or not reachable.'] };
  }
  const age = system.writtenAgeMs;
  const problems = [];
  let level = 'ok';
  if (age != null && age > 120000) { level = 'down'; problems.push('Last self-report ' + ago(age) + ' ago - the collector has stopped.'); }
  else if (age != null && age > 45000) { level = 'warn'; problems.push('Self-report is ' + ago(age) + ' old (normally every 15s).'); }
  const mem = system.memory || {};
  if (mem.rssMb > 1500) { level = worst([level, 'warn']); problems.push('Using ' + mem.rssMb + ' MB of memory.'); }
  return {
    key: 'server', label: 'Collector server', level,
    headline: level === 'down' ? 'Stopped' : 'Up ' + ago((system.uptimeSeconds || 0) * 1000),
    sub: 'reported ' + ago(age) + ' ago · ' + (mem.rssMb != null ? mem.rssMb + ' MB' : '—'),
    problems,
  };
}

/* ------------------------------------------------------------- chains ---- */

function chainsPart(system, now) {
  const warm = system && system.warm;
  const state = (warm && warm.state) || {};
  const chainKeys = (warm && warm.chains) || Object.keys(state);
  const interval = (warm && warm.intervalMs) || 5000;
  const rows = chainKeys.map((key) => {
    const s = state[key] || {};
    const age = s.at ? now - s.at : null;
    const level = !s.at ? 'down'
      : s.error ? 'warn'
        : age > Math.max(interval * 12, 60000) ? 'down'
          : age > Math.max(interval * 4, 20000) ? 'warn'
            : !s.rows ? 'warn' : 'ok';
    return {
      key, level, ageMs: age, rows: s.rows || 0, ms: s.ms, error: s.error || null,
      why: !s.at ? 'never collected' : s.error ? s.error
        : level === 'down' ? 'stale for ' + ago(age) : level === 'warn' && !s.rows ? 'returned no pools'
          : level === 'warn' ? 'late by ' + ago(age) : null,
    };
  });
  const fresh = rows.filter((r) => r.level === 'ok').length;
  const bad = rows.filter((r) => r.level !== 'ok');
  const level = !rows.length ? 'unknown'
    : bad.some((r) => r.level === 'down') && fresh === 0 ? 'down'
      : bad.length ? 'warn' : 'ok';
  return {
    part: {
      key: 'chains', label: 'Market board', level,
      headline: rows.length ? fresh + ' / ' + rows.length + ' chains fresh' : 'No chains',
      sub: 'refreshes every ' + ago(interval),
      problems: bad.map((r) => r.key + ': ' + r.why),
    },
    rows,
  };
}

/* ------------------------------------------------------------ sources ---- */

function sourcesPart(providers) {
  const rows = (providers || []).map((p) => {
    const meta = SOURCES[p.provider] || { label: p.provider, group: 'other' };
    const level = p.status === 'DOWN' ? 'down' : p.status === 'DEGRADED' ? 'warn'
      : p.status === 'IDLE' ? 'unknown' : 'ok';
    const kinds = (p.recent && p.recent.kinds) || p.errorKinds || {};
    const kind = dominantKind(kinds);
    const window = p.recent || { calls: p.calls, errors: p.errors, callsPerMinute: p.callsPerMinute, errorRatePct: p.errorRatePct };
    const successPct = window.calls ? 100 - (window.errorRatePct || 0) : null;
    const why = level === 'ok' || level === 'unknown' ? null
      : (kind ? ERROR_KIND_TEXT[kind] : (p.lastError || 'failing'));
    return {
      host: p.provider, label: meta.label, group: meta.group, level, status: p.status,
      successPct, callsPerMinute: window.callsPerMinute, calls: window.calls, errors: window.errors,
      p50Ms: p.p50Ms, p95Ms: p.p95Ms, kind, why, lastError: p.lastError,
      lastErrorAt: p.lastErrorAt, lastOkAt: p.lastOkAt, spark: p.spark, window: p.window,
      lifetime: { calls: p.calls, errors: p.errors, errorRatePct: p.errorRatePct },
    };
  });
  const groups = SOURCE_GROUPS.map((g) => {
    const members = rows.filter((r) => r.group === g.key);
    const level = !members.length ? 'unknown'
      : members.every((r) => r.level === 'down') ? 'down'
        : members.some((r) => r.level === 'down' || r.level === 'warn') ? 'warn' : 'ok';
    return Object.assign({}, g, { level, rows: members });
  }).filter((g) => g.rows.length);

  // Only the critical group can take the whole system down; a dead social
  // feed thins one panel, it does not stale the board.
  const failing = rows.filter((r) => r.level === 'down' || r.level === 'warn');
  const critical = groups.find((g) => g.critical);
  const level = !rows.length ? 'unknown'
    : critical && critical.level === 'down' ? 'down'
      : failing.length ? 'warn' : 'ok';
  const healthy = rows.filter((r) => r.level === 'ok').length;
  return {
    part: {
      key: 'sources', label: 'Data sources', level,
      headline: rows.length ? healthy + ' / ' + rows.length + ' healthy' : 'No calls yet',
      sub: (rows[0] && rows[0].window === 'lifetime') ? 'since server start' : 'last 15 minutes',
      problems: failing.map((r) => r.label + ' ' + (r.level === 'down' ? 'down' : 'degraded') +
        (r.successPct != null ? ' (' + Math.round(r.successPct) + '% ok)' : '') + ' — ' + r.why),
    },
    rows,
    groups,
  };
}

/* --------------------------------------------------------------- jobs ---- */

function jobsPart(system, now) {
  const collectors = (system && system.collectors) || {};
  const schedule = (system && system.schedule) || {};
  const rows = JOBS.filter((j) => collectors[j.key]).map((j) => {
    const c = collectors[j.key];
    const interval = schedule[j.key] || null;
    const age = c.at ? now - c.at : null;
    // Overdue at three missed turns, with a floor so a 2.5s job is not
    // flagged over one slow upstream call.
    const overdue = interval && age != null && age > Math.max(interval * 3, 60000) + (c.ms || 0);
    const level = c.error ? 'warn' : overdue ? 'down' : 'ok';
    return {
      key: j.key, label: j.label, what: j.what, level, ageMs: age, intervalMs: interval,
      ms: c.ms, runs: c.runs, failures: c.failures, error: c.error,
      detail: c.skipped || null,
    };
  });
  const bad = rows.filter((r) => r.level !== 'ok');
  return {
    part: {
      key: 'jobs', label: 'Background jobs', level: !rows.length ? 'unknown' : bad.length ? worst(bad.map((r) => r.level)) : 'ok',
      headline: rows.length ? (rows.length - bad.length) + ' / ' + rows.length + ' on schedule' : 'No jobs reported',
      sub: rows.reduce((s, r) => s + (r.runs || 0), 0).toLocaleString('en-US') + ' runs',
      problems: bad.map((r) => r.label + ': ' + (r.error || ('last ran ' + ago(r.ageMs) + ' ago'))),
    },
    rows,
  };
}

/* ------------------------------------------------------------ storage ---- */

function archivePart(system, now, timeline) {
  const store = system && system.store;
  if (!store) return { key: 'archive', label: 'History archive', level: 'unknown', headline: '—', problems: [] };
  if (!store.enabled) {
    return { key: 'archive', label: 'History archive', level: 'warn', headline: 'Off',
      sub: 'memory only', problems: ['The archive is disabled - nothing survives a restart.'] };
  }
  const health = store.health || {};
  let level = health.level === 'failed' ? 'down' : health.level === 'degraded' ? 'warn' : 'ok';
  const usage = store.usage || {};
  const problems = (health.problems || []).slice();

  // Is it recording NOW? The last two finished blocks of the 24h strip answer
  // that; the whole-day share is context, not the verdict - a gap from a
  // night the machine was off is history, not a current fault.
  const day = timeline && timeline.day;
  const cells = (day && day.ok && day.cells) || [];
  const latest = cells.slice(-3, -1);
  if (latest.length && latest.every((c) => c.state === 'lost')) {
    level = 'down'; problems.push('Nothing recorded in the last ' + ago(latest.length * day.bucketMs) + '.');
  } else if (latest.some((c) => c.state === 'lost' || c.state === 'partial')) {
    level = level === 'down' ? level : 'warn'; problems.push('Recording thinly in the last ' + ago(latest.length * day.bucketMs) + '.');
  }
  const dayPct = day && day.ok && day.recorded != null ? Math.round(day.recorded * 100) : null;
  return {
    key: 'archive', label: 'History archive', level,
    headline: bytes(usage.bytes) + ' on disk',
    sub: (dayPct != null ? dayPct + '% of 24h recorded · ' : '') + 'flushed ' + ago(health.sinceFlushMs) + ' ago',
    problems,
  };
}

/**
 * The raw files the app reads. A write that fails leaves the previous copy
 * in place, so the app keeps reading old data with no error of its own -
 * which is why a file stuck failing is the thing to show, not the count.
 */
function rawFilesPart(system, now) {
  const raw = system && system.raw;
  if (!raw) return { part: { key: 'files', label: 'Data files', level: 'unknown', headline: '—', problems: [] }, stuck: [] };
  const failing = raw.failing || {};
  const stuck = Object.keys(failing).map((rel) => {
    const f = failing[rel];
    const lastOkAge = f.lastOkAt ? now - f.lastOkAt : null;
    const recentFail = f.lastErrorAt && now - f.lastErrorAt < 10 * 60000;
    // Stuck: failing lately AND no good write since the last failure.
    const isStuck = recentFail && (!f.lastOkAt || f.lastOkAt < f.lastErrorAt);
    return { rel, errors: f.errors, lastOkAgeMs: lastOkAge, lastErrorAt: f.lastErrorAt, stuck: isStuck, error: f.lastError };
  }).filter((f) => f.stuck).sort((a, b) => (b.lastOkAgeMs || Infinity) - (a.lastOkAgeMs || Infinity));

  const total = (raw.writes || 0) + (raw.errors || 0);
  const failPct = total ? (raw.errors / total) * 100 : 0;
  const writeAge = raw.lastWriteAt ? now - raw.lastWriteAt : null;
  const problems = [];
  let level = 'ok';
  if (raw.error) { level = 'down'; problems.push('Store unavailable: ' + raw.error); }
  if (writeAge != null && writeAge > 60000) { level = worst([level, 'down']); problems.push('No file written for ' + ago(writeAge) + '.'); }
  stuck.forEach((f) => {
    level = worst([level, 'warn']);
    problems.push(f.rel + ' not updated ' + (f.lastOkAgeMs != null ? 'for ' + ago(f.lastOkAgeMs) : 'since start') +
      (/EPERM|EBUSY/.test(f.error || '') ? ' — file locked (OneDrive sync?)' : ''));
  });
  // Lifetime failures without a stuck file: note it, do not alarm.
  const sub = raw.failing
    ? (failPct >= 0.1 ? failPct.toFixed(1) + '% of writes failed since start' : 'all writes landing')
    : (raw.errors ? raw.errors.toLocaleString('en-US') + ' failed writes since start' : 'all writes landing');
  if (!raw.failing && failPct > 5) { level = worst([level, 'warn']); problems.push(failPct.toFixed(0) + '% of file writes failing — last: ' + (raw.lastError || '').slice(0, 80)); }
  return {
    part: {
      key: 'files', label: 'Data files', level,
      headline: stuck.length ? stuck.length + ' file' + (stuck.length > 1 ? 's' : '') + ' stuck' : 'Writing',
      sub, problems,
    },
    stuck,
  };
}

/* ------------------------------------------------------------ browser ---- */

function browserPart(browser, now) {
  const services = [
    { key: 'wallet', label: 'Wallet intel', s: browser.wallet, stale: 60000,
      detail: (s) => (s.walletsKnown || 0).toLocaleString('en-US') + ' wallets · ' + (s.poolsHeld || 0) + ' pools' },
    { key: 'social', label: 'Social intel', s: browser.social, stale: 60000,
      detail: (s) => (s.tokensKnown || 0).toLocaleString('en-US') + ' tokens · ' + (s.corpusPosts || 0).toLocaleString('en-US') + ' posts' },
    { key: 'rotation', label: 'Rotation graph', s: browser.rotation, stale: 120000,
      detail: (s) => (s.chainsHeld || 0) + ' chains · ' + (s.poolsConnected || 0) + ' pools' },
  ].map((x) => {
    const s = x.s || {};
    const age = s.lastTickAt ? now - s.lastTickAt : null;
    const level = !s.running ? 'down' : s.lastError ? 'warn'
      : age == null ? 'unknown' : age > x.stale ? 'warn' : 'ok';
    return { key: x.key, label: x.label, level, ageMs: age, detail: x.s ? x.detail(s) : '—',
      error: !s.running ? 'stopped' : s.lastError || (age != null && age > x.stale ? 'no tick for ' + ago(age) : null) };
  });

  const st = browser.storage || {};
  const storeLevel = st.error ? 'warn' : st.backend === 'memory' ? 'warn' : st.backend === 'indexeddb' ? 'ok' : st.backend ? 'ok' : 'unknown';
  services.push({
    key: 'store', label: 'Browser storage', level: storeLevel, ageMs: null,
    detail: (st.keys || 0) + ' keys · ' + bytes(st.approxBytes),
    error: st.error || (st.backend === 'memory' ? 'memory only - nothing is saved' : null),
  });

  const reads = browser.reads || {};
  const bad = services.filter((s) => s.level === 'down' || s.level === 'warn');
  return {
    part: {
      key: 'browser', label: 'This browser', level: bad.length ? worst(bad.map((s) => s.level)) : 'ok',
      headline: (services.length - bad.length) + ' / ' + services.length + ' running',
      sub: (reads.reads || 0).toLocaleString('en-US') + ' file reads · ' + (reads.errors || 0) + ' failed',
      problems: bad.map((s) => s.label + ': ' + s.error),
    },
    services,
  };
}

/* ------------------------------------------------------------ verdict ---- */

/**
 * The whole page in one object.
 *
 *   system    fetchLiveSystemData() output (providers already derived), or null
 *   browser   { wallet, social, rotation, storage, reads } status snapshots
 */
export function systemHealth({ system, browser, timeline, waiting = false, now = Date.now() }) {
  const server = serverPart(system, now, waiting);
  // Job and chain ages are measured at the moment the report was written, so a
  // report that is itself 15s old does not make every job look 15s late -
  // the server part already says when the report is stale.
  const reportedAt = (system && (system.now || system.writtenAt)) || now;
  const chains = chainsPart(system, reportedAt);
  const sources = sourcesPart(system && system.providers);
  const jobs = jobsPart(system, reportedAt);
  const archive = archivePart(system, now, timeline);
  const files = rawFilesPart(system, now);
  const web = browserPart(browser || {}, now);

  const parts = system
    ? [server, chains.part, sources.part, jobs.part, files.part, archive, web.part]
    : [server, web.part];
  const level = worst(parts.map((p) => p.level));
  const issues = parts.flatMap((p) => (p.level === 'ok' || p.level === 'unknown' ? [] :
    p.problems.map((text) => ({ part: p.label, level: p.level, text }))));
  // Hard failures first.
  issues.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);

  const checking = !system && waiting;
  return {
    level: checking ? 'unknown' : level,
    checking,
    title: checking ? 'Checking…' : level === 'down' ? 'Outage' : level === 'warn' ? 'Degraded' : 'All systems operational',
    summary: checking ? 'Reading the collector’s latest report.' : !issues.length ? 'Every part is doing its job.'
      : parts.filter((p) => p.level === 'down' || p.level === 'warn').map((p) => p.label).join(' · '),
    issues,
    parts,
    chains: chains.rows,
    sources: sources.groups,
    jobs: jobs.rows,
    stuckFiles: files.stuck,
    browser: web.services,
    resources: system ? {
      uptimeSeconds: system.uptimeSeconds,
      node: system.node,
      heapMb: system.memory && system.memory.heapUsedMb,
      rssMb: system.memory && system.memory.rssMb,
      cacheEntries: system.cache && system.cache.entries,
      inflight: system.cache && system.cache.inflight,
      historyPools: system.cache && system.cache.historyPools,
      observationTokens: system.cache && system.cache.observationTokens,
      holderSeries: system.cache && system.cache.holderSeries,
      walletSets: system.memory && system.memory.walletSetsSampled,
      archiveBytes: system.store && system.store.usage && system.store.usage.bytes,
      archiveRecords: system.scan && system.scan.records,
      archiveDays: system.store && system.store.usage && system.store.usage.days
        ? system.store.usage.days.map((d) => ({ day: d.day, bytes: d.bytes })) : [],
      pending: system.store && system.store.pending,
      writeLatencyMs: system.store && system.store.writeLatency && system.store.writeLatency.avg,
      reportedAgeMs: system.writtenAgeMs,
    } : null,
  };
}
