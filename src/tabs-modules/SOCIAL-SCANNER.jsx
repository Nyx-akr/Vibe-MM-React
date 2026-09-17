import React from 'react';
import { UNAVAILABLE } from '../utils/formatters';

/** Per-source badge colour, so a post's origin is readable at a glance. */
const SOURCE_STYLE = {
  '4chan': { fg: '#8fd3ff', bg: '#16406e', label: '4CHAN /BIZ/' },
  reddit: { fg: '#ff9d6e', bg: '#4a2413', label: 'REDDIT' },
  mastodon: { fg: '#a89bff', bg: '#2a2360', label: 'MASTODON' },
  farcaster: { fg: '#d79bff', bg: '#3a1a5c', label: 'FARCASTER' },
  bluesky: { fg: '#6ea0ff', bg: '#0e2a5c', label: 'BLUESKY' },
};

function sourceStyle(key) {
  return SOURCE_STYLE[key] || { fg: '#a3aed0', bg: '#1a2440', label: String(key || '?').toUpperCase() };
}

/**
 * The "opens elsewhere" mark. Inline SVG rather than a glyph font or an emoji
 * so it inherits the row's colour through currentColor and stays crisp at the
 * 9px this panel runs at.
 */
function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 24 24" width="9" height="9" fill="none"
      stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden="true"
      style={{ flex: '0 0 auto', opacity: 0.75 }}
    >
      <path d="M14 4h6v6" />
      <path d="M20 4L10 14" />
      <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

/** "4m" / "3.2h" / "2d" from an absolute timestamp. */
function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return (s / 3600).toFixed(1) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

/**
 * The social read on ONE token.
 *
 * Everything here is measured, or it is not shown. There is no demo branch:
 * when the server cannot be reached the panel says so, because a scanner that
 * invents plausible chatter is worse than one that admits it has none.
 *
 * `mentions` counts two kinds of hit and nothing else - "$SYM" anywhere, and a
 * bare upper-case "SYM" in a post that also reads like it is about a traded
 * asset. Bare hits that fail that test are reported as `loose` and never
 * counted. See mentionsFor() in src/calculations/core.js.
 */
export function socialVals(app, sel) {
  const api = app.state.apiSocial;

  // The board model carries the ticker as `sym` with a leading $; the raw
  // server row carries it bare. Neither is called `symbol`, which is how the
  // heading used to read $UNDEFINED.
  const ticker = String(
    (api && api.symbol) || (sel && sel.rawServerRow && sel.rawServerRow.symbol) ||
    (sel && sel.sym) || '',
  ).replace(/^\$/, '').toUpperCase();

  if (!sel) return { socialReady: false, socialOffline: false };
  if (!api || api.server !== 'ok') {
    return {
      socialReady: false,
      socialOffline: true,
      socialToken: ticker,
      socialOfflineNote: app.state.serverError
        ? 'The data server is unreachable, so no feed could be read. Nothing is shown rather than simulated.'
        : 'Waiting for the first social sweep to return.',
    };
  }

  const m = api.mention || null;
  const baseline = api.baseline || {};
  const sources = api.sources || [];
  const live = sources.filter((s) => s.ok).length;

  const dim = (value) => (value == null ? UNAVAILABLE : '#ffffff');

  const socialStats = [
    {
      label: 'MENTIONS OF $' + ticker,
      value: m && m.countable ? String(m.mentions) : '—',
      color: m && m.countable && m.mentions > 0 ? '#ffffff' : UNAVAILABLE,
    },
    {
      label: 'UNIQUE AUTHORS',
      value: m && m.countable ? String(m.authors) : '—',
      color: m && m.countable && m.authors > 0 ? '#dfe6f6' : UNAVAILABLE,
    },
    {
      label: 'PER AUTHOR',
      value: m && m.concentration != null ? String(m.concentration) : '—',
      color: m && m.concentration != null && m.concentration >= 3 ? '#ff4fae' : dim(m && m.concentration),
    },
    {
      label: 'VS BASELINE',
      value: baseline.vsBase != null ? baseline.vsBase + '×' : '—',
      color: baseline.vsBase != null && baseline.vsBase >= 2 ? '#4d8dff' : dim(baseline.vsBase),
    },
    {
      label: 'POSTS SCANNED',
      value: String(api.scanned || 0),
      color: '#f06ee2',
    },
  ];

  const socialPosts = ((m && m.matched) || []).slice(0, 40).map((p, i) => {
    const st = sourceStyle(p.source);
    return {
      key: p.source + ':' + p.id + ':' + i,
      src: st.label, srcFg: st.fg, srcBg: st.bg,
      author: p.author ? '@' + p.author : 'anonymous',
      authorFg: p.author ? '#c6d1ea' : '#6b7699',
      when: ago(p.time),
      text: p.text,
      tag: p.cashtag ? 'CASHTAG' : 'CONTEXT',
      tagFg: p.cashtag ? '#4d8dff' : '#8b96b8',
      tagBg: p.cashtag ? '#0e2a5c' : '#1a2440',
      engagement: p.reactions || p.replies
        ? (p.reactions ? p.reactions + ' reactions' : '') +
          (p.reactions && p.replies ? ' · ' : '') +
          (p.replies ? p.replies + ' replies' : '')
        : '',
    };
  });

  const socialSources = sources.map((s) => ({
    key: s.source,
    name: sourceStyle(s.source).label,
    fg: sourceStyle(s.source).fg,
    url: s.url || '',
    // The label is the sentence under the link: which subreddits, which tags.
    title: s.label || '',
    posts: String(s.posts),
    ok: s.ok,
    state: s.ok ? 'LIVE' : 'DOWN',
    stateFg: s.ok ? '#4fc3f7' : '#ff4fae',
    hit: m && m.bySource ? String(m.bySource[s.source] || 0) : '0',
    hitFg: m && m.bySource && m.bySource[s.source] ? '#4d8dff' : '#3a4568',
    error: s.error || '',
  }));

  return {
    socialReady: true,
    socialOffline: false,
    socialToken: ticker,
    socialStats,
    socialPosts,
    socialSources,
    socialLive: live + ' of ' + sources.length + ' sources answering',
    socialCountable: Boolean(m && m.countable),
    // A missing measurement and an unmatchable ticker are different failures.
    // Both used to print 'not matched against text: .' with a blank cause.
    socialReason: (m && m.reason) ||
      (m ? '' : 'the sweep returned no posts to match against — the data server may be serving an older build'),
    socialLoose: m && m.loose ? String(m.loose) : '',
    socialAnon: m && m.anonPosts ? String(m.anonPosts) : '',
    socialBaselineNote: baseline.samples
      ? 'Baseline from ' + baseline.samples + ' earlier sweeps in this tab' +
        (baseline.z != null ? ' · z ' + baseline.z : '')
      : 'No baseline yet — it builds from this tab’s own sweeps, about one a minute.',
    socialBoosted: Boolean(api.boosted),
    socialPromo: api.promo
      ? {
          description: api.promo.description || '',
          kind: api.promo.kind,
          links: (api.promo.links || []).map((l, i) => ({
            key: i, type: String(l.type || 'link').toUpperCase(), url: l.url,
          })),
        }
      : null,
    socialAbsent: api.absent || '',
    socialEmpty: !socialPosts.length,
  };
}

export default function SocialScanner({ v, css }) {
  if (!v.isSocial) return false;

  if (v.socialOffline) {
    return (
      <div data-screen-label="Social scanner" style={css('flex:1;overflow:auto;padding:12px 14px;min-height:0', { v })}>
        <div style={css('background:#0a1226;border:1px solid #45103a;border-radius:10px;padding:18px 20px', { v })}>
          <div style={css('font-size:9px;letter-spacing:1.2px;color:#ff4fae;font-weight:800;margin-bottom:8px', { v })}>SOCIAL FEED UNAVAILABLE</div>
          <div style={css('font-size:11px;color:#c6d1ea;line-height:1.6', { v })}>{v.socialOfflineNote}</div>
        </div>
      </div>
    );
  }
  if (!v.socialReady) return false;

  return (
    <div data-screen-label="Social scanner" style={css('flex:1;overflow:auto;padding:12px 14px;min-height:0', { v })}>

      <div style={css('display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:10px', { v })}>
        {(v.socialStats || []).map((s, i) => (
          <div key={i} style={css('background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:10px 12px', { v, s })}>
            <div style={css('font-size:9px;letter-spacing:1.2px;color:#8b96b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, s })}>{s.label}</div>
            <div style={css('font-size:18px;font-weight:700;margin-top:3px;color:{{ s.color }}', { v, s })}>{s.value}</div>
          </div>
        ))}
      </div>

      <div style={css('display:grid;grid-template-columns:1.55fr 1fr;gap:10px;align-items:start', { v })}>

        <div style={css('background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px', { v })}>
          <div style={css('font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:4px', { v })}>
            POSTS MENTIONING ${String(v.socialToken).toUpperCase()} — NEWEST FIRST
          </div>
          <div style={css('font-size:9.5px;color:#6b7699;margin-bottom:10px', { v })}>{v.socialBaselineNote}</div>

          {!v.socialCountable && (
            <div style={css('background:#101c38;border:1px solid #45103a;border-radius:10px;padding:10px 12px;font-size:10.5px;color:#c6d1ea;line-height:1.55', { v })}>
              {v.socialReason}. Counting it anyway would measure the English
              language, not this token.
            </div>
          )}

          {v.socialCountable && v.socialEmpty && (
            <div style={css('background:#101c38;border:1px solid #1c2a4d;border-radius:10px;padding:10px 12px;font-size:10.5px;color:#8b96b8;line-height:1.55', { v })}>
              No post in the current sweep names this token. That is a real
              measurement, not a gap — a fresh microcap is usually silent here
              long before it is loud.
            </div>
          )}

          {(v.socialPosts || []).map((p) => (
            <div key={p.key} style={css('background:#101c38;border:1px solid #1c2a4d;border-radius:10px;padding:9px 11px;margin-bottom:8px', { v, p })}>
              <div style={css('display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:5px', { v, p })}>
                <span style={css('font-size:8.5px;font-weight:800;letter-spacing:.4px;padding:2.5px 8px;border-radius:999px;background:{{ p.srcBg }};color:{{ p.srcFg }}', { v, p })}>{p.src}</span>
                <span style={css('font-size:9.5px;font-weight:600;color:{{ p.authorFg }}', { v, p })}>{p.author}</span>
                <span style={css('font-size:9px;color:#6b7699', { v, p })}>{p.when}</span>
                <span style={css('font-size:8.5px;font-weight:800;padding:2px 7px;border-radius:999px;background:{{ p.tagBg }};color:{{ p.tagFg }}', { v, p })}>{p.tag}</span>
                {p.engagement && <span style={css('font-size:9px;color:#6b7699', { v, p })}>{p.engagement}</span>}
              </div>
              <div style={css('font-size:10.5px;color:#c6d1ea;line-height:1.55;word-break:break-word', { v, p })}>{p.text}</div>
            </div>
          ))}

          <div style={css('font-size:9.5px;color:#6b7699;margin-top:10px;line-height:1.6', { v })}>
            CASHTAG means the post wrote ${String(v.socialToken).toUpperCase()} outright. CONTEXT means it
            wrote the bare ticker in a post that also reads like it is about a traded
            asset. {v.socialLoose && <>{v.socialLoose} further bare matches were rejected as ordinary words and are not counted. </>}
            Mentions per author is the social twin of volume from few wallets: a high
            number means a handful of accounts are doing the talking. Social signal
            never qualifies an alert on its own.
          </div>
        </div>

        <div style={css('display:flex;flex-direction:column;gap:10px', { v })}>

          <div style={css('background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px', { v })}>
            <div style={css('font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600;margin-bottom:3px', { v })}>SOURCES</div>
            <div style={css('font-size:9.5px;color:#6b7699;margin-bottom:9px', { v })}>{v.socialLive}</div>
            <div style={css('display:grid;grid-template-columns:1fr 34px 44px 40px;gap:8px;padding-bottom:4px;border-bottom:1px solid #1c2a4d;font-size:8.5px;letter-spacing:.6px;color:#6b7699;font-weight:600', { v })}>
              <div>SOURCE</div>
              <div style={css('text-align:right', { v })}>HITS</div>
              <div style={css('text-align:right', { v })}>POSTS</div>
              <div style={css('text-align:right', { v })}>STATE</div>
            </div>
            {(v.socialSources || []).map((s) => (
              <div key={s.key} style={css('display:grid;grid-template-columns:1fr 34px 44px 40px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #16223f;font-size:10px', { v, s })}>
                <div style={css('min-width:0', { v, s })}>
                  {s.url ? (
                    <a
                      href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}
                      style={css('display:flex;align-items:center;gap:4px;font-weight:700;color:{{ s.fg }};text-decoration:none;min-width:0', { v, s })}
                    >
                      <span style={css('white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, s })}>{s.name}</span>
                      <ExternalLinkIcon />
                    </a>
                  ) : (
                    <div style={css('font-weight:700;color:{{ s.fg }};white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, s })}>{s.name}</div>
                  )}
                  {s.error && <div style={css('font-size:8.5px;color:#ff4fae;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', { v, s })}>{s.error}</div>}
                </div>
                <div style={css('font-weight:700;text-align:right;color:{{ s.hitFg }}', { v, s })}>{s.hit}</div>
                <div style={css('color:#8b96b8;text-align:right', { v, s })}>{s.posts}</div>
                <div style={css('font-weight:700;font-size:8.5px;color:{{ s.stateFg }};text-align:right', { v, s })}>{s.state}</div>
              </div>
            ))}
            <div style={css('font-size:9px;color:#6b7699;margin-top:9px;line-height:1.55', { v })}>
              Post counts are the whole sweep; the hits column is what named this
              token. Each name opens the feed this server actually read, so you can
              check the count by hand. A source that is DOWN is reported, never
              counted as silence.
            </div>
          </div>

          {v.socialPromo && (
            <div style={css('background:#0a1226;border:1px solid #33124a;border-radius:10px;padding:12px', { v })}>
              <div style={css('font-size:9px;letter-spacing:1.2px;color:#f06ee2;font-weight:800;margin-bottom:8px', { v })}>PAID PROMOTION — DEXSCREENER {v.socialPromo.kind}</div>
              {v.socialPromo.description && <div style={css('font-size:10.5px;color:#c6d1ea;line-height:1.55;margin-bottom:8px', { v })}>{v.socialPromo.description}</div>}
              <div style={css('display:flex;gap:6px;flex-wrap:wrap', { v })}>
                {v.socialPromo.links.map((l) => (
                  <a key={l.key} href={l.url} target="_blank" rel="noreferrer noopener" style={css('font-size:8.5px;font-weight:800;letter-spacing:.4px;padding:3px 9px;border-radius:999px;background:#1a2440;color:#8fd3ff;text-decoration:none', { v, l })}>{l.type}</a>
                ))}
              </div>
              <div style={css('font-size:9px;color:#8b96b8;margin-top:9px;line-height:1.55', { v })}>
                This token paid to be promoted. That is a fact about spend, not about
                interest — treat it as the opposite of organic reach.
              </div>
            </div>
          )}

          <div style={css('background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px', { v })}>
            <div style={css('font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:800;margin-bottom:8px', { v })}>NOT COVERED</div>
            <div style={css('font-size:10px;color:#8b96b8;line-height:1.6', { v })}>{v.socialAbsent}</div>
          </div>

        </div>
      </div>
    </div>
  );
}
