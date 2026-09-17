/**
 * The wallets the user is tracking.
 *
 * Empty by default, and deliberately so. This file used to ship five invented
 * rows - a "Kitsune bundle funder", a "Moonveil deployer cluster" - which were
 * indistinguishable on screen from measured ones and were shown whenever the
 * live sample was unavailable. A registry that invents its own bad actors is
 * worse than an empty one.
 *
 * An entry stores the FULL address. The old format kept only a truncated
 * "5xQm…c2Kd" display string, which meant a tracked wallet could never be
 * matched against a real trade; `normalizeRegistry` drops those on load.
 */
export const defaultWalletRegistry = [];

/** Shortens an address for display without losing the stored original. */
export const shortAddress = (address) => {
  const a = String(address || '');
  return a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a;
};

/**
 * Upgrades whatever is in localStorage to the current shape.
 *
 * Anything without a full address cannot be matched against trade data, so it
 * is dropped rather than carried forward as a row that can never light up.
 */
export function normalizeRegistry(saved) {
  if (!Array.isArray(saved)) return [];
  return saved
    .map((w) => {
      if (!w || typeof w !== 'object') return null;
      const address = String(w.address || '').trim();
      if (!address || address.includes('…') || address.includes('...')) return null;
      return {
        address,
        label: String(w.label || '').trim() || 'Tracked wallet',
        addedAt: Number(w.addedAt) || Date.now(),
      };
    })
    .filter(Boolean);
}
