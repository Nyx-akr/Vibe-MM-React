/**
 * The smart-wallet list: /raw/smart-wallets.json.
 *
 * Learned from the server's archive by scripts/backtest-early.mjs: a wallet is
 * smart when enough of its past buys went +10% before -7% within 6 hours, on
 * more than one token (the rule travels inside the file). This module only
 * reads it and hands the DATA FLOW a Set of lowercased addresses. A missing
 * file is a normal state - the SMART boxes then show nothing, never zero.
 */

import { readRaw } from './storage/raw-store';

const REFRESH_MS = 5 * 60000;
let set = null;
let meta = null;
let fetchedAt = 0;
let loading = null;

function load() {
  if (loading) return loading;
  loading = readRaw('smart-wallets.json')
    .then((f) => {
      fetchedAt = Date.now();
      if (f && f.wallets) {
        set = new Set(Object.keys(f.wallets).map((w) => w.toLowerCase()));
        meta = { generatedAt: f.generatedAt, count: set.size, rule: f.rule || null };
      }
      return set;
    })
    .catch(() => { fetchedAt = Date.now(); return set; })
    .finally(() => { loading = null; });
  return loading;
}

/** The current Set (or null before the first read), refreshed in the background. */
export function smartWalletSet() {
  if (Date.now() - fetchedAt > REFRESH_MS) load();
  return set;
}

export const smartWalletMeta = () => meta;
