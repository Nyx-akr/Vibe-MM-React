/**
 * The chains the dashboard fetches and can filter by.
 *
 * `key` is the server's chain id (/api/market?chain=...), `name` is the short
 * label shown in the table's chain selector.
 */
export const chains = [
  { key: 'solana', name: 'SOL', label: 'Solana' },
  { key: 'ethereum', name: 'ETH', label: 'Ethereum' },
  { key: 'base', name: 'BASE', label: 'Base' },
  { key: 'bsc', name: 'BNB', label: 'BNB Chain' },
  { key: 'arbitrum', name: 'ARB', label: 'Arbitrum' },
  { key: 'polygon', name: 'POLY', label: 'Polygon' },
  { key: 'avalanche', name: 'AVAX', label: 'Avalanche' },
  { key: 'robinhood', name: 'RHC', label: 'Robinhood Chain' }
];

export const chainKeys = chains.map((c) => c.key);
export const chainNames = chains.map((c) => c.name);

/** Server chain id -> table label. */
export const chainKeyToName = chains.reduce((acc, c) => {
  acc[c.key] = c.name;
  return acc;
}, {});

export const chainColors = {
  SOL: '#8f7bff', ETH: '#7b8cff', BASE: '#3d7bfd', BNB: '#e8b930',
  ARB: '#4fa8ff', POLY: '#a86bff', AVAX: '#ff5f5f', RHC: '#4fc3f7'
};

/** Table label -> server chain id, for the chain selector. */
export const chainNameToKey = chains.reduce((acc, c) => {
  acc[c.name] = c.key;
  return acc;
}, {});
