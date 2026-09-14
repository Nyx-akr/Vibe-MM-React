export function createTapeEvent(random = Math.random, now = new Date()) {
  const wallet = () => { const chars = '123456789abcdefghjkmnpq'; let value = ''; for (let i = 0; i < 4; i++) value += chars[Math.floor(random() * chars.length)]; return value + '…' + chars[Math.floor(random() * chars.length)] + chars[Math.floor(random() * chars.length)]; };
  const number = (a, b) => (a + random() * (b - a)).toFixed(0);
  const templates = [
    { kind: 'SWAP', kc: '#4d8dff', chain: 'SOL', text: '$GLYPH buy ' + number(800, 9000) + ' USDC @ 0.0074 · Raydium · ' + wallet() },
    { kind: 'RFQ FILL', kc: '#4fc3f7', chain: 'RHC', text: 'NVDAx $' + number(8, 80) + ',400 @ 212.' + number(10, 90) + ' · maker 0x9a…f2 · settled' },
    { kind: 'SWAP', kc: '#4d8dff', chain: 'BASE', text: '$BSWIRL buy ' + number(300, 4000) + ' USDC · Aerodrome · ' + wallet() },
    { kind: 'LIQ+', kc: '#e35ff2', chain: 'SOL', text: '$SOLPUP +$' + number(4, 30) + '.2K to Meteora pool · LP ' + wallet() },
    { kind: 'LIQ WASH', kc: '#ff4fae', chain: 'BNB', text: '$MOONVEIL liq cycle #' + number(3, 6) + ': $18K out 22m after add · flagged' },
    { kind: 'BUNDLE', kc: '#ff4fae', chain: 'SOL', text: '$KITSUNE cluster: ' + number(8, 12) + ' wallets, one funder 5xQm…c2 · same block' },
    { kind: 'REGISTRY', kc: '#f06ee2', chain: 'SOL', text: 'Known bundler 7pWr…m9Ts bought $DUSKRAT ' + number(2, 9) + 's after pool init · wash prob raised' },
    { kind: 'TRACKED', kc: '#4d8dff', chain: 'SOL', text: 'Tracked wallet 9hLm…x2Fa added $' + number(2, 18) + 'K $GLYPH' },
    { kind: 'ORACLE', kc: '#b48cff', chain: 'RHC', text: 'NVDA/USD round ' + number(1800, 1900) + ' · 212.' + number(10, 60) + ' · fresh ' + number(2, 9) + 's' },
    { kind: 'SWAP', kc: '#ff4fae', chain: 'BNB', text: '$MOONVEIL sell ' + number(200, 3000) + ' USDT · Pancake · flagged: cluster-7' },
    { kind: 'POOL NEW', kc: '#e35ff2', chain: 'SOL', text: '$DUSKRAT init $' + number(4, 15) + '.1K · PumpSwap migration · security scan queued' },
    { kind: 'TRANSFER', kc: '#8b96b8', chain: 'BASE', text: 'USDC bridge-in $' + number(20, 300) + 'K → fresh wallet ' + wallet() },
    { kind: 'RFQ FILL', kc: '#4fc3f7', chain: 'RHC', text: 'AMDx $' + number(4, 40) + ',100 @ 184.' + number(10, 90) + ' · maker 0x3c…77 · settled' },
    { kind: 'VETO', kc: '#ff4fae', chain: 'BNB', text: '$SAFEGEM2 hard veto: honeypot — sell path reverts' }
  ];
  const event = templates[Math.floor(random() * templates.length)];
  const pad = (value) => String(value).padStart(2, '0');
  event.ts = pad(now.getUTCHours()) + ':' + pad(now.getUTCMinutes()) + ':' + pad(now.getUTCSeconds());
  return event;
}
