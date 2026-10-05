import React from 'react';
import Help from '../components/Help';

export default function LiveOpportunities({ v, css }) {
  return v.isLive && (<>
          <div data-screen-label="Live opportunities" style={css("flex:1;display:flex;flex-direction:column;min-height:0", { v })}><div style={css("display:flex;gap:10px;padding:10px 14px;flex-shrink:0", { v })}>{(v.stats || []).map((s, i) => (<React.Fragment key={i}>
            <div style={css("flex:{{ grow }};min-width:0;background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:8px 12px", { v, s, grow: s.wide ? '3' : s.mid ? '1.7' : '1' })}>{s.inlineValue ? (<div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 9, letterSpacing: 1.2, color: '#8b96b8' }}>{s.label}</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: s.color }}>{s.value}</span>
            </div>) : <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, letterSpacing: 1.2, color: '#8b96b8' }}>{s.label}{s.help && <Help title={s.help.title} text={s.help.text} />}</div>}{s.rows && s.rows.map((row, ri) => (
              <div key={ri} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
                <span style={{ width: 62, flexShrink: 0, fontSize: 8.5, letterSpacing: 1, color: '#6b7699', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>{row.name}{row.help && <Help title={row.help.title} text={row.help.text} />}</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, flex: 1, minWidth: 0 }}>
                  {row.chips.map((c, j) => (
                    <div key={j} className="h3eb549cf" onClick={c.go}
                      style={{ padding: '2px 8px', borderRadius: 999, fontSize: 9.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
                        background: c.bg, color: c.fg, border: '1px solid ' + c.bd, opacity: c.dim ? 0.6 : 1 }}>
                      {c.label} <span style={{ opacity: 0.75, fontWeight: 500 }}>{c.count}</span>
                    </div>
                  ))}
                </div>
                {row.reset && (<span className="h3eb549cf" onClick={row.reset} style={{ flexShrink: 0, fontSize: 9, color: '#8b96b8', cursor: 'pointer', whiteSpace: 'nowrap' }}>show all ✕</span>)}
              </div>
            ))}{s.reset && (<span className="h3eb549cf" onClick={s.reset} style={{ float: 'right', marginTop: -12, fontSize: 9, color: '#8b96b8', cursor: 'pointer' }}>show all ✕</span>)}{!s.hideValue && !s.inlineValue && (<div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 2 }}>
              <span style={{ fontSize: 17, fontWeight: 600, color: s.color }}>{s.value}</span>
              {s.verdict && (<span style={{ fontSize: 9.5, fontWeight: 600, color: s.color, letterSpacing: 0.4 }}>{s.verdict}</span>)}
            </div>)}{s.gauge && (<div style={{ position: 'relative', height: 8, marginTop: 7, marginBottom: s.gauge.ticks ? 10 : 2, borderRadius: 999, background: '#16223f' }}>
              {/* Zoned gauge: coloured bands, a marker for the value. */}
              {s.gauge.zones && s.gauge.zones.map((z, j) => (
                <div key={j} style={{ position: 'absolute', top: 0, bottom: 0, left: z.from + '%', width: (z.to - z.from) + '%', background: z.color, opacity: 0.35,
                  borderRadius: j === 0 ? '999px 0 0 999px' : j === s.gauge.zones.length - 1 ? '0 999px 999px 0' : 0 }} />
              ))}
              {s.gauge.marker != null && (<div style={{ position: 'absolute', top: -3, bottom: -3, width: 3, borderRadius: 2, background: '#ffffff',
                left: 'calc(' + Math.min(Math.max(s.gauge.marker, 0), 100) + '% - 1.5px)', boxShadow: '0 0 0 2px #0a1226' }} />)}
              {/* Filled gauge: the value as a bar, reference ticks on top. */}
              {s.gauge.fill != null && (<div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: Math.min(s.gauge.fill, 100) + '%', background: s.gauge.color, borderRadius: 999 }} />)}
              {(s.gauge.ticks || []).map((t, j) => (
                <React.Fragment key={j}>
                  <div style={{ position: 'absolute', top: -2, bottom: -2, left: t.at + '%', width: 1, background: '#8b96b8' }} />
                  <span style={{ position: 'absolute', top: 10, left: t.at + '%', transform: j ? 'none' : 'translateX(-100%)', paddingLeft: j ? 3 : 0, paddingRight: j ? 0 : 3,
                    fontSize: 7.5, color: '#6b7699', whiteSpace: 'nowrap' }}>{t.label}</span>
                </React.Fragment>
              ))}
            </div>)}{s.segments && (<>
              {/* One continuous bar: each stage's width is its share of the
                  board. A stage switched off stays in place, dimmed, so the bar
                  never reflows under the pointer. */}
              {!s.noBar && (<div style={{ display: 'flex', height: 10, marginTop: 9, borderRadius: 999, overflow: 'hidden', background: '#16223f' }}>
                {s.segments.map((g, j) => g.count > 0 && (
                  <div key={j} className={g.go ? 'h3eb549cf' : undefined} onClick={g.go}
                    title={g.name + ': ' + g.count + (g.go ? (g.on ? ' - click to hide' : ' - click to show') : '')}
                    style={{ width: (g.share * 100) + '%', background: g.fg, opacity: g.on ? 1 : 0.18, cursor: g.go ? 'pointer' : 'default',
                      borderRight: j < s.segments.length - 1 ? '1px solid #0a1226' : 'none' }} />
                ))}
              </div>)}
              {/* Names and counts sit beside the bar, not in it. Every stage is
                  listed - a stage with none still reads 0 and can be toggled. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px', marginTop: 6 }}>
                {s.segments.map((g, j) => (
                  // Clickable stages read as buttons: a pill in the stage's own
                  // badge colours when on, an outline when off. Display-only
                  // splits (the organic grades) stay a plain legend.
                  <span key={j} className={g.go ? 'h3eb549cf' : undefined} onClick={g.go}
                    style={g.go ? {
                      display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 9, fontWeight: 600,
                      whiteSpace: 'nowrap', padding: '3px 9px', borderRadius: 999,
                      background: g.on ? g.bg : '#0a1226', border: '1px solid ' + (g.on ? g.fg : '#1c2a4d'), opacity: g.on ? 1 : 0.6,
                    } : { display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'default', fontSize: 9, whiteSpace: 'nowrap', opacity: g.on ? 1 : 0.4 }}>
                    <span style={{ width: 7, height: 7, borderRadius: 2, background: g.fg }} />
                    <span style={{ color: '#8b96b8', letterSpacing: 0.6 }}>{g.name}</span>
                    <span style={{ color: '#ffffff', fontWeight: 600 }}>{g.count}</span>
                  </span>
                ))}
              </div>
            </>)}{s.chips && (<div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 6 }}>{s.chips.map((c, j) => (
              <React.Fragment key={j}>
                <div className="h3eb549cf" onClick={c.go} style={{ padding: c.big ? '4px 14px' : '2px 8px', borderRadius: 999, fontSize: c.big ? 13 : 9.5, fontWeight: c.big ? 700 : 600, cursor: 'pointer', background: c.bg, color: c.fg, border: '1px solid ' + c.bd, whiteSpace: 'nowrap' }}>{c.label} <span style={{ opacity: 0.75, fontWeight: 500 }}>{c.count}</span></div>
                {/* ALL sits on its own line; the chains wrap underneath it. */}
                {c.big && <div style={{ flexBasis: '100%', height: 0 }} />}
              </React.Fragment>
            ))}</div>)}{s.subLine && (<div style={{ fontSize: 9, color: '#8b96b8', marginTop: 4 }}>{s.subLine.map((part, j) => (
              <span key={j}>{j ? ' · ' : ''}<span style={{ color: part.color || '#8b96b8', fontWeight: part.color ? 600 : 400 }}>{part.text}</span></span>
            ))}</div>)}{s.facts && (<div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 7 }}>{s.facts.map((fct, j) => (
              <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9 }}>
                <span style={{ color: '#6b7699', width: 46, flexShrink: 0, letterSpacing: 0.4 }}>{fct.k}</span>
                <span style={{ color: fct.color || '#dfe6f6', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{fct.v}</span>
                {fct.bar != null && (<div style={{ flex: 1, minWidth: 20, height: 4, borderRadius: 999, background: '#16223f', overflow: 'hidden' }}>
                  <div style={{ width: Math.min(fct.bar, 100) + '%', height: '100%', background: '#4d8dff' }} /></div>)}
              </div>
            ))}</div>)}{s.note && (<div style={{ fontSize: 8.5, color: '#6b7699', marginTop: 5, fontStyle: 'italic' }}>{s.note}</div>)}{s.sub && (<div style={css("font-size:8.5px;color:#3a4568;margin-top:2px", { v, s })}>{s.sub}</div>)}</div>
          </React.Fragment>))}</div><div style={css("display:flex;align-items:center;gap:6px;padding:0 14px 10px;flex-shrink:0;flex-wrap:wrap", { v })}>{(v.views || []).map((v, i) => (<React.Fragment key={i}>
            <div className="h3eb549cf" onClick={v.go} style={css("padding:4px 12px;border-radius:999px;font-size:10px;font-weight:600;cursor:pointer;background:{{ v.bg }};color:{{ v.fg }};border:1px solid {{ v.bd }}", { v, v })}>{v.label}</div>
          </React.Fragment>))}<div style={css("flex:1", { v })}></div><div style={css("display:flex;align-items:center;gap:6px;margin-left:auto;background:#0a1226;border:1px solid {{ searchBd }};border-radius:999px;padding:3px 10px;flex-shrink:0", { v, searchBd: v.hasSearch ? "#f06ee2" : "#1c2a4d" })}><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={v.hasSearch ? "#f06ee2" : "#6b7699"} strokeWidth="2.5" strokeLinecap="round" style={{ flexShrink: 0 }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4.3-4.3" /></svg><input value={v.searchQ} onChange={v.onSearch} placeholder="Search symbol or name" spellCheck={false} style={css("width:170px;background:transparent;border:none;outline:none;color:#dfe6f6;font-family:inherit;font-size:10px;padding:1px 0", { v })} />{v.hasSearch && (<span className="h3eb549cf" onClick={v.clearSearch} style={css("cursor:pointer;color:#6b7699;font-size:11px;line-height:1;flex-shrink:0", { v })}>✕</span>)}</div><span style={css("font-size:10px;color:#6b7699", { v })}>{v.rowCount} assets shown</span></div><div style={css("flex:1;margin:0 14px;background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;overflow:auto;min-height:0;animation:{{ v.tablePingAnim }}", { v })}><div><div className="vs-feed-head" style={css("padding:8px 12px;border-bottom:1px solid #1c2a4d;position:sticky;top:0;background:#0d1730;z-index:2", { v })}>{(v.headers || []).map((h, i) => (<React.Fragment key={i}>
            <div className={(h.sortable ? 'h3eb549cf ' : '') + 'vs-feed-c-' + h.col + (h.num ? ' vs-feed-num' : '')} onClick={h.sort} style={css("font-size:8.5px;letter-spacing:1.1px;font-weight:700;color:{{ h.fg }};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:{{ cur }}", { v, h, cur: h.sortable ? 'pointer' : 'default' })}>{h.label}{h.arrow}</div>
          </React.Fragment>))}</div>{(v.rows || []).map((r, i) => (<React.Fragment key={i}>
            <div
              className="vs-feed-row"
              onClick={r.open}
              style={{
                padding: '7px 12px', borderBottom: '1px solid #16223f',
                borderLeft: `2px solid ${r.selBar}`, cursor: 'pointer', animation: r.anim,
                // Only a SELECTED row paints its own background. Leaving it
                // inline-transparent otherwise would outrank the :hover rule.
                ...(r.selected ? { background: r.selBg, boxShadow: r.selRing } : null)
              }}
            >
              {/* watchlist + focus */}
              <div className="vs-feed-c-mark" style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                <span className="h7a920191" onClick={r.star} style={{ fontSize: 13, lineHeight: 1, cursor: 'pointer', color: r.starColor }}>{r.starGlyph}</span>
                {r.selected && (<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><title>Focused — the token the scoped tabs are showing</title><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>)}
              </div>

              {/* identity: symbol on top, then the three things that qualify it */}
              <div className="vs-feed-c-asset" style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, minWidth: 0 }}>
                  <span style={{ fontWeight: 700, color: '#ffffff', fontSize: 12.5, flexShrink: 0 }}>{r.sym}</span>
                  <span style={{ fontSize: 10, color: '#6b7699', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2, fontSize: 8.5, whiteSpace: 'nowrap' }}>
                  <span style={{ fontWeight: 700, color: r.chainColor }}>{r.chain}</span>
                  <span style={{ color: '#39445f' }}>·</span>
                  <span style={{ color: r.clsColor }}>{r.cls}</span>
                  <span style={{ color: '#39445f' }}>·</span>
                  <span style={{ color: '#6b7699' }}>{r.age}</span>
                </div>
              </div>

              {/* stage */}
              <div className="vs-feed-c-stage">
                <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.6, padding: '2.5px 7px', borderRadius: 10, background: r.stageBg, color: r.stageFg, whiteSpace: 'nowrap' }}>{r.stage}</span>
              </div>

              {/* score, with confidence beneath it - the number and how much to trust it */}
              <div
                className="vs-feed-c-score vs-feed-num"
                title={r.partialScore ? 'Scored without contract, holder and routed-impact data yet - the enrichment loop has not reached this token' : 'Scored on the full input set'}
              >
                <div style={{ fontSize: 15, fontWeight: 700, color: r.scoreColor, lineHeight: 1.1 }}>
                  {r.score}{r.partialScore && (<span style={{ fontSize: 9, color: '#3a4568', verticalAlign: 'super', marginLeft: 2 }}>○</span>)}
                </div>
                {/* labelled, or a second bare number under the score reads as part of it */}
                <div style={{ fontSize: 8.5, color: '#6b7699' }}>conf {r.conf}</div>
              </div>

              {/* price over its 5m move */}
              <div className="vs-feed-c-price vs-feed-num">
                <div style={{ color: '#dfe6f6', fontSize: 11.5, lineHeight: 1.1 }}>{r.price}</div>
                <div style={{ fontSize: 9.5, fontWeight: 600, color: r.chgColor }}>{r.chg}</div>
              </div>

              <div className="vs-feed-c-liq vs-feed-num" style={{ fontSize: 11 }}>{r.liq}</div>

              <div className="vs-feed-c-vol vs-feed-num" style={{ fontSize: 11 }}>
                {r.vol}{r.volTag && (<span style={{ fontSize: 8.5, color: '#6b7699', marginLeft: 3 }}>{r.volTag}</span>)}
              </div>

              <div className="vs-feed-c-risk vs-feed-num" style={{ fontSize: 11, fontWeight: 600, color: r.washColor }}>{r.wash}</div>

              {/* net flow over the buyer count behind it */}
              <div className="vs-feed-c-flow vs-feed-num">
                <div style={{ fontSize: 11, fontWeight: 600, color: r.nfColor, lineHeight: 1.1 }}>{r.netflow}</div>
                <div style={{ fontSize: 8.5, color: '#6b7699' }}>{r.buyers} buyers</div>
              </div>

              <div className="vs-feed-c-trend" style={css("align-items:flex-end;gap:1.5px;height:20px;padding-bottom:2px", { v, r })}>{(r.trend || []).map((tb, i) => (<React.Fragment key={i}>
              <div style={css("width:3.5px;height:{{ tb.h }};background:{{ tb.c }};border-radius:1px", { v, r, tb })}></div>
            </React.Fragment>))}</div>
            </div>{r.expanded && (<>
              <div style={{ padding: '12px 16px 13px', background: '#0d1730', borderBottom: '1px solid #16223f' }}>

                {/* The plain sentence the table no longer has room for. */}
                {r.reason && (
                  <div style={{ fontSize: 11.5, color: '#dfe6f6', lineHeight: 1.5, marginBottom: 11 }}>
                    {r.reason}
                  </div>
                )}

                {/* Every figure captioned, so none of them needs prior knowledge. */}
                <div className="vs-peek-stats">
                  {(r.peekStats || []).map((ps, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 8, letterSpacing: 1.1, fontWeight: 700, color: '#5c6684' }}>{ps.label}</div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: ps.color, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>{ps.value}</div>
                      <div style={{ fontSize: 8.5, color: '#6b7699', marginTop: 1 }}>{ps.sub}</div>
                    </div>
                  ))}
                </div>

                {(r.peekFlags || []).length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 11 }}>
                    {r.peekFlags.map((pf, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#101c38', borderRadius: 999, padding: '3px 10px 3px 4px' }}>
                        <span style={{ fontSize: 8, fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: pf.bg, color: pf.fg, flexShrink: 0 }}>{pf.sev}</span>
                        <span style={{ fontSize: 10, color: '#c6d1ea' }}>{pf.text}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* One jump per token-scoped tab, in sidebar order. They are
                    peers, so they are drawn as peers: DETAIL used to carry a
                    gradient fill and every label an arrow, which made one
                    destination look like the primary action and the rest like
                    afterthoughts. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                  {[
                    ['DETAIL', r.goDetail],
                    ['SOCIAL', r.goSocial],
                    ['WALLETS', r.goWallets],
                    ['ROTATION', r.goRotation],
                  ].map(([label, go]) => (
                    <div
                      key={label} className="hf6f5791f" onClick={go}
                      style={{ padding: '5px 14px', borderRadius: 999, border: '1px solid #1c2a4d', color: '#b6c2de', fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >{label}</div>
                  ))}
                </div>
              </div>
            </>)}
          </React.Fragment>))}</div></div><div style={css("display:flex;gap:10px;height:170px;margin:10px 14px 12px;flex-shrink:0", { v })}><div style={css("flex:1;background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;display:flex;flex-direction:column;min-width:0", { v })}><div style={css("padding:6px 12px;border-bottom:1px solid #1c2a4d;font-size:9px;letter-spacing:1.2px;color:#8b96b8;font-weight:600", { v })}>EVENT TAPE — RAW INGESTION (LAYER A)</div><div style={css("flex:1;overflow:hidden;padding:4px 12px", { v })}>{(v.tape || []).map((e, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;gap:12px;padding:2.5px 0;font-size:10.5px;animation:{{ e.anim }}", { v, e })}><span style={css("color:#6b7699", { v, e })}>{e.ts}</span><span style={css("width:74px;font-weight:700;color:{{ e.kindColor }}", { v, e })}>{e.kind}</span><span style={css("width:52px;color:{{ e.chainColor }}", { v, e })}>{e.chain}</span><span style={css("color:#c6d1ea", { v, e })}>{e.text}</span></div>
          </React.Fragment>))}</div></div><div style={css("width:330px;background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;display:flex;flex-shrink:0;overflow:hidden", { v })}><div style={css("flex:1;padding:10px 4px 10px 14px;min-width:0", { v })}><div className="h1813ba3e" onClick={v.openChepePick} style={css("display:flex;align-items:center;gap:5px;margin-bottom:5px;padding:4px 9px;border-radius:999px;background:linear-gradient(135deg,rgba(43,107,255,.25),rgba(227,95,242,.25));border:1px solid #e35ff2;cursor:pointer;white-space:nowrap;overflow:hidden", { v })}><span style={css("font-size:8px;font-weight:800;letter-spacing:.5px;color:#f06ee2;flex-shrink:0", { v })}>DAILY PICK</span><span style={css("font-weight:800;color:#ffffff;font-size:10.5px", { v })}>{v.chepePickSym}</span><span style={css("font-size:9px;color:#8b96b8", { v })}>· {v.chepePickScore}</span></div><div style={css("font-size:8.5px;color:#a3aed0;line-height:1.35;margin-bottom:5px;font-style:italic;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical", { v })}>"{v.chepePickQuip}" — not financial advice</div><div style={css("font-size:9px;letter-spacing:1.2px;color:#f06ee2;font-weight:700;margin-bottom:4px", { v })}>CHEPE'S VETO LOG</div>{(v.chepeStats || []).map((cs, i) => (<React.Fragment key={i}>
            <div style={css("display:flex;justify-content:space-between;gap:8px;padding:1.5px 0;font-size:9.5px", { v, cs })}><span style={css("color:#8b96b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis", { v, cs })}>{cs.k}</span><span style={css("font-weight:700;color:#ffffff;flex-shrink:0", { v, cs })}>{cs.v}</span></div>
          </React.Fragment>))}</div><img src="/assets/chepe.png" alt="Chepe" style={css("width:108px;height:100%;object-fit:cover;object-position:center bottom;flex-shrink:0", { v })} /></div></div></div>
        </>);
}