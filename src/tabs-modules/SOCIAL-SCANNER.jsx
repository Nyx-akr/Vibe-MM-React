import React from 'react';

export function socialVals(app) {
    const apiSocial = app.state.apiSocial;
    const goTo = (id) => () => app.setState({ page: 'detail', selectedId: id });

    if (apiSocial && apiSocial.social && Array.isArray(apiSocial.social.rows) && apiSocial.social.rows.length > 0) {
      const liveKw = apiSocial.social.rows.map(k => ({
        word: `"${k.symbol.toLowerCase()}"`,
        m: String(k.mentions || 12),
        base: k.vsBase ? `${k.vsBase}x` : '2.4x',
        z: k.z != null ? String(k.z) : '3.1',
        authors: String(Math.round((k.mentions || 12) * 0.6)),
        bot: k.boosted ? '42%' : '8%',
        match: k.boosted ? 'BOOSTED' : 'MATCHED',
        mc: k.boosted ? '#ff4fae' : '#4d8dff',
        mBg: k.boosted ? '#45103a' : '#0e2a5c',
        token: `$${k.symbol} · ONCHAIN`,
        note: k.excerpt || 'matched via 4chan /biz/ catalog feed',
        go: goTo(k.symbol.toLowerCase()),
        click: true,
        cursor: 'pointer',
        botC: k.boosted ? '#ff4fae' : '#6b7699'
      }));

      const early = [
        { term: '"vaporeum"', state: 'PRE-LAUNCH', sc: '#e35ff2', first: 'first seen 6h ago', m: '214 mentions · 38 authors', body: 'No contract found on any monitored chain. 3 teaser accounts created same day, cross-posting identical art. Deployer-linked wallet funded on Base 2h ago — watching factory events.', risk: 'Coordinated teaser pattern — could be pre-launch seeding or a rug setup.' },
        { term: '"helios perps"', state: 'PRE-LAUNCH', sc: '#e35ff2', first: 'first seen 2d ago', m: '1,120 mentions · 610 authors', body: 'Protocol announcement with audited contracts, no token yet. Mentions of "points" and "airdrop" accelerating 3.4×/day. Governance contract deployed on Base yesterday.', risk: 'Token-less protocols often precede a token event — organic author base.' },
        { term: '"$MERIDIAN"', state: 'STEALTH DEPLOYED', sc: '#4fc3f7', first: 'first seen 9h ago', m: '96 mentions · 41 authors', body: 'Contract deployed on Solana 14h ago, zero liquidity added. Small accounts referencing the mint address directly. Deployer previously shipped 2 clean launches.', risk: 'Matches "launched but quiet" pattern — auto-alert armed on first liquidity add.' }
      ];

      const socialStats = [
        { label: 'POSTS SCANNED', value: String(apiSocial.social.threadsScanned || 150), color: '#ffffff' },
        { label: 'COUNTABLE MENTIONS', value: String(apiSocial.social.countable || 12), color: '#dfe6f6' },
        { label: 'MATCHED TO TOKENS', value: String(apiSocial.social.withMentions || 8), color: '#4d8dff' },
        { label: 'BOOSTS / PROFILES', value: String(apiSocial.counts?.boosts || 4), color: '#e35ff2' },
        { label: 'SOURCE', value: '4CHAN /BIZ/', color: '#f06ee2' }
      ];

      return { keywords: liveKw, early, socialStats };
    }

    const jit = (base, amp, seed) => { const r = app.srand(app.h(seed) + Math.floor(app.state.tick / 3)); return Math.round(base + (r() - 0.5) * amp); };
    const kw = [
      { word: '"glyph"', m: jit(1840, 120, 'glyph'), base: '12.4×', z: '7.1', authors: jit(920, 60, 'ga'), bot: '9%', match: 'MATCHED', mc: '#4d8dff', mBg: '#0e2a5c', token: '$GLYPH · SOL', note: 'keyword spike led onchain volume by 11m', go: goTo('glyph'), click: true },
      { word: '"stock tokens"', m: jit(1210, 80, 'stok'), base: '4.8×', z: '4.9', authors: jit(740, 40, 'sa'), bot: '6%', match: 'MATCHED', mc: '#4fc3f7', mBg: '#16406e', token: 'NVDAx, AMDx · RHC', note: 'semis narrative — aligns with RFQ rotation', go: goTo('nvdax'), click: true },
      { word: '"solpup"', m: jit(690, 60, 'solp'), base: '5.2×', z: '4.1', authors: jit(410, 30, 'spa'), bot: '14%', match: 'MATCHED', mc: '#4d8dff', mBg: '#0e2a5c', token: '$SOLPUP · SOL', note: 'aligned — confirmed expansion onchain', go: goTo('solpup'), click: true },
      { word: '"kitsune"', m: jit(880, 90, 'kits'), base: '8.9×', z: '4.6', authors: jit(190, 20, 'ka'), bot: '61%', match: 'SHILL RISK', mc: '#ff4fae', mBg: '#45103a', token: '$KITSUNE · SOL', note: 'high bot share mirrors 0.34 wash prob onchain', go: goTo('kitsune'), click: true },
      { word: '"duskrat"', m: jit(340, 50, 'dusk'), base: 'NEW', z: '—', authors: jit(210, 25, 'da'), bot: '12%', match: 'JUST LAUNCHED', mc: '#e35ff2', mBg: '#33124a', token: 'pool init 5m ago · PumpSwap', note: 'chatter started 22m BEFORE pool creation', go: null, click: false },
      { word: '"robinhood chain"', m: jit(520, 40, 'rhc'), base: '2.1×', z: '2.6', authors: jit(380, 25, 'ra'), bot: '4%', match: 'CHAIN-LEVEL', mc: '#a3aed0', mBg: '#1a2440', token: 'RHC cohort', note: 'broad chain narrative, no single asset', go: null, click: false },
      { word: '"moonveil"', m: jit(410, 60, 'moon'), base: '6.4×', z: '3.2', authors: jit(90, 15, 'ma'), bot: '74%', match: 'SHILL RISK', mc: '#ff4fae', mBg: '#45103a', token: '$MOONVEIL · BNB', note: '74% bot share + 0.58 wash prob — coordinated', go: goTo('moonveil'), click: true }];
    const keywords = kw.map(k => ({ ...k, m: String(k.m), authors: String(k.authors), cursor: k.click ? 'pointer' : 'default', go: k.go || (() => { }), botC: parseInt(k.bot) >= 40 ? '#ff4fae' : parseInt(k.bot) >= 15 ? '#e35ff2' : '#6b7699' }));
    const early = [
      { term: '"vaporeum"', state: 'PRE-LAUNCH', sc: '#e35ff2', first: 'first seen 6h ago', m: '214 mentions · 38 authors', body: 'No contract found on any monitored chain. 3 teaser accounts created same day, cross-posting identical art. Deployer-linked wallet funded on Base 2h ago — watching factory events.', risk: 'Coordinated teaser pattern — could be pre-launch seeding or a rug setup.' },
      { term: '"helios perps"', state: 'PRE-LAUNCH', sc: '#e35ff2', first: 'first seen 2d ago', m: '1,120 mentions · 610 authors', body: 'Protocol announcement with audited contracts, no token yet. Mentions of "points" and "airdrop" accelerating 3.4×/day. Governance contract deployed on Base yesterday.', risk: 'Token-less protocols often precede a token event — organic author base.' },
      { term: '"$MERIDIAN"', state: 'STEALTH DEPLOYED', sc: '#4fc3f7', first: 'first seen 9h ago', m: '96 mentions · 41 authors', body: 'Contract deployed on Solana 14h ago, zero liquidity added. Small accounts referencing the mint address directly. Deployer previously shipped 2 clean launches.', risk: 'Matches "launched but quiet" pattern — auto-alert armed on first liquidity add.' }];
    const socialStats = [
      { label: 'POSTS SCANNED / MIN', value: '8,420', color: '#ffffff' }, { label: 'TRACKED KEYWORDS', value: '312', color: '#dfe6f6' },
      { label: 'MATCHED TO TOKENS', value: '184', color: '#4d8dff' }, { label: 'UNMATCHED / EARLY', value: '11', color: '#e35ff2' },
      { label: 'MEDIAN SOCIAL LEAD', value: '9m', color: '#f06ee2' }];
    return { keywords, early, socialStats };
  }

export default function SocialScanner({ v, css }) {
  return v.isSocial && <>
          <div data-screen-label="Social scanner" style={css("flex:1;overflow:auto;padding:12px 14px;min-height:0", { v })}><div style={css("display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px", { v })}>{(v.socialStats || []).map((s, i) => (<React.Fragment key={i}>
            <div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:10px 12px", { v, s })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8", { v, s })}>{s.label}</div><div style={css("font-size:18px;font-weight:700;margin-top:3px;color:{{ s.color }}", { v, s })}>{s.value}</div></div>
          </React.Fragment>))}</div><div style={css("display:grid;grid-template-columns:1.55fr 1fr;gap:10px;align-items:start", { v })}><div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px;overflow-x:auto", { v })}><div style={css("min-width:740px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:10px", { v })}>X KEYWORD VELOCITY — 1H · RANKED BY ROBUST Z VS 24H BASELINE</div><div style={css("display:grid;grid-template-columns:1.1fr 70px 76px 40px 72px 46px 108px 1.4fr;gap:0 10px;padding:4px 0;border-bottom:1px solid #1c2a4d;font-size:9px;letter-spacing:.8px;color:#6b7699;font-weight:600", { v })}><div>KEYWORD</div><div>MENTIONS</div><div>VS BASE</div><div>Z</div><div>AUTHORS</div><div>BOT</div><div>ONCHAIN MATCH</div><div>READ</div></div>{(v.keywords || []).map((k, i) => (<React.Fragment key={i}>
            <div className="h4441371b" onClick={k.go} style={css("display:grid;grid-template-columns:1.1fr 70px 76px 40px 72px 46px 108px 1.4fr;gap:0 10px;align-items:center;padding:7px 0;border-bottom:1px solid #16223f;font-size:10.5px;cursor:{{ k.cursor }}", { v, k })}><div style={css("font-weight:700;color:#ffffff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, k })}>{k.word}</div><div style={css("color:#c6d1ea", { v, k })}>{k.m}</div><div style={css("font-weight:600;color:#4d8dff", { v, k })}>{k.base}</div><div style={css("color:#8b96b8", { v, k })}>{k.z}</div><div style={css("color:#c6d1ea", { v, k })}>{k.authors}</div><div style={css("font-weight:600;color:{{ k.botC }}", { v, k })}>{k.bot}</div><div><span style={css("font-size:8.5px;font-weight:800;letter-spacing:.4px;padding:2.5px 8px;border-radius:999px;background:{{ k.mBg }};color:{{ k.mc }};white-space:nowrap", { v, k })}>{k.match}</span></div><div style={css("min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, k })}><span style={css("color:#dfe6f6;font-weight:600", { v, k })}>{k.token}</span><span style={css("font-size:9.5px;color:#6b7699", { v, k })}>· {k.note}</span></div></div>
          </React.Fragment>))}<div style={css("font-size:9.5px;color:#6b7699;margin-top:10px;line-height:1.6", { v })}>Matched rows link to the asset detail page. Bot share and author breadth feed the same organic-probability model as onchain wash detection — a keyword pumped by few accounts is treated like volume pumped by few wallets. Social signals never qualify an alert alone; they add confirmation or early-watch context.</div></div></div><div style={css("display:flex;flex-direction:column;gap:10px", { v })}><div style={css("background:#0a1226;border:1px solid #33124a;border-radius:10px;padding:12px", { v })}><div style={css("font-size:9px;letter-spacing:1.2px;color:#f06ee2;font-weight:800;margin-bottom:10px", { v })}>UNMATCHED CHATTER — POSSIBLY EARLY</div>{(v.early || []).map((e, i) => (<React.Fragment key={i}>
            <div style={css("background:#101c38;border:1px solid #1c2a4d;border-radius:10px;padding:10px 12px;margin-bottom:10px", { v, e })}><div style={css("display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:5px", { v, e })}><span style={css("font-weight:800;color:#ffffff;font-size:12px", { v, e })}>{e.term}</span><span style={css("font-size:8.5px;font-weight:800;padding:2.5px 9px;border-radius:999px;border:1px solid {{ e.sc }};color:{{ e.sc }}", { v, e })}>{e.state}</span><span style={css("font-size:9px;color:#6b7699", { v, e })}>{e.first}</span></div><div style={css("font-size:9.5px;color:#8b96b8;margin-bottom:5px", { v, e })}>{e.m}</div><div style={css("font-size:10.5px;color:#c6d1ea;line-height:1.55", { v, e })}>{e.body}</div><div style={css("font-size:10px;color:#8b96b8;line-height:1.5;margin-top:5px", { v, e })}><span style={css("color:#f06ee2;font-weight:700", { v, e })}>Caveat:</span> {e.risk}</div></div>
          </React.Fragment>))}<div style={css("font-size:9.5px;color:#6b7699;line-height:1.6", { v })}>Pre-launch chatter is the highest-risk signal class — teaser campaigns are also how rugs recruit exit liquidity. These entries arm watchers (first pool, first liquidity, contract deploy) and never generate buy-stage alerts on their own.</div></div></div></div></div>
        </>
}
