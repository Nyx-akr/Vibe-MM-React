/**
 * Turns what wallet intelligence has seen into "this wallet just traded"
 * events, for the WALLET TRACKER's alarms.
 *
 * Wallet intelligence keeps, per wallet, a running total for every pool it has
 * been seen in. Comparing those totals between two looks gives exactly the
 * trades that landed in between: a pool whose trade count went up was traded,
 * the change in net USD says which way, the change in gross USD says how much.
 *
 * The first look at a wallet only records where it stands. What it did before
 * we started watching is history, not news - the same rule the alert toasts
 * follow.
 *
 * Coverage is the sampler's: it reads the pools of tokens on the board, so a
 * trade in a token we do not watch is never seen and never alarms.
 */

/**
 * @param registry  the tracked wallets
 * @param profileOf (address) => walletProfile, from services/wallet-intel
 * @param memory    an object kept between calls; holds the last totals
 * @returns events, oldest first
 */
export function detectWalletMoves(registry, profileOf, memory) {
  const events = [];
  (registry || []).forEach((w) => {
    const key = String(w.address).toLowerCase();
    const profile = profileOf(w.address);
    const next = {};
    ((profile && profile.pools) || []).forEach((p) => {
      next[p.poolAddress] = { trades: p.trades, gross: p.grossUsd, net: p.netUsd, symbol: p.symbol, chain: p.chain, at: p.lastAt };
    });
    const prev = memory[key];
    memory[key] = next;
    if (!prev) return;

    Object.keys(next).forEach((pool) => {
      const b = next[pool];
      const a = prev[pool] || { trades: 0, gross: 0, net: 0 };
      if (!(b.trades > a.trades)) return;
      const netUsd = b.net - a.net;
      events.push({
        address: w.address,
        label: w.label,
        pool,
        symbol: b.symbol,
        chain: b.chain,
        side: netUsd >= 0 ? 'buy' : 'sell',
        usd: Math.max(0, b.gross - a.gross),
        netUsd,
        trades: b.trades - a.trades,
        at: b.at || Date.now(),
      });
    });
  });
  return events.sort((x, y) => x.at - y.at);
}

/** Does this event pass the wallet's own alarm settings? */
export function shouldAlarm(wallet, event) {
  const a = (wallet && wallet.alert) || {};
  if (!a.on) return false;
  if (event.side === 'buy' && !a.buy) return false;
  if (event.side === 'sell' && !a.sell) return false;
  return event.usd >= (a.minUsd || 0);
}
