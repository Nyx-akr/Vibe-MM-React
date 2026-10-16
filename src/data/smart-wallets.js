/**
 * The WALLET TRACKER library: KOL and smart-money wallets worth following.
 *
 * Ships EMPTY, on purpose - the same rule as data/wallet-registry.js. A wallet
 * labelled "KOL" that nobody verified is worse than no label: people would act
 * on it. Entries arrive one of two ways:
 *
 *   1. Add them to SHIPPED_WALLETS below (a reviewed list, shipped to everyone).
 *   2. Paste a list into the tracker's IMPORT box (kept in this browser only).
 *
 * One entry: { address, name, category, chain?, handle? }
 *   category - free text, shown as a chip: 'KOL', 'SMART MONEY', 'FUND', ...
 *   handle   - an X handle, without the @, if the wallet belongs to one.
 */
export const SHIPPED_WALLETS = [];

/** Drops anything without a usable full address; keeps the rest tidy. */
export function normalizeCurated(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map((w) => {
    if (!w || typeof w !== 'object') return null;
    const address = String(w.address || '').trim();
    if (address.length < 26 || /\s|…/.test(address)) return null;
    const key = address.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      address,
      name: String(w.name || w.label || '').trim() || 'Unnamed wallet',
      category: String(w.category || '').trim().toUpperCase() || 'KOL',
      chain: String(w.chain || '').trim().toUpperCase(),
      handle: String(w.handle || '').trim().replace(/^@/, ''),
    };
  }).filter(Boolean);
}

/**
 * Reads a pasted list. Accepts JSON (an array of entries) or plain lines:
 *
 *   address, name, category, chain, handle
 *
 * where everything after the address is optional. Returns the entries and a
 * count of lines that could not be used, so the box can say so.
 */
export function parseWalletList(text) {
  const raw = String(text || '').trim();
  if (!raw) return { wallets: [], skipped: 0 };
  if (raw[0] === '[') {
    try {
      const parsed = JSON.parse(raw);
      const wallets = normalizeCurated(parsed);
      return { wallets, skipped: (Array.isArray(parsed) ? parsed.length : 0) - wallets.length };
    } catch (e) {
      return { wallets: [], skipped: 1, error: 'Not valid JSON' };
    }
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = lines.map((l) => {
    const [address, name, category, chain, handle] = l.split(/[,\t;]/).map((x) => (x || '').trim());
    return { address, name, category, chain, handle };
  });
  const wallets = normalizeCurated(rows);
  return { wallets, skipped: lines.length - wallets.length };
}
