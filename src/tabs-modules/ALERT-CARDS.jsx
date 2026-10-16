import React from 'react';
import { chainColor, signalInfo } from '../utils/formatters';
import { ALERT_CLASSES, strengthOf, boardValue, boardNote } from '../flow/board-flow';

/**
 * What the bot would actually have sent, grouped by the claim it makes.
 *
 * The cards are the DATA FLOW's ALERT ENGINE box (flow/board-flow.js): which
 * tokens alert, their evidence families, confidence and invalidations are
 * all computed there, from the model's own call. This tab only lays them out.
 */

const EMPTY = {
  OPPORTUNITY: () => 'No token is a BUY right now: nothing is waking with a high enough EARLY and clean safety checks.',
  EXIT: () => 'No token is PEAKING right now, so no SELL or SHORT alert would have been sent.',
  RISK: () => 'No token has two independent risk families above 60. Only contract, liquidity and holders can constitute a risk claim today — deployer history is not wired, and integrity moves confidence rather than the claim.',
  RESOLUTION: (plan) => 'No BUY call has hit its target, its stop or its ' + plan.horizonHours + 'h horizon yet.',
};
const COLUMN_LABEL = { OPPORTUNITY: 'BUY', EXIT: 'EXIT', RISK: 'RISK', RESOLUTION: 'RESOLUTION' };

/** One alert from the engine, dressed for its card. */
function cardOf(a) {
  const si = a.stage ? signalInfo(a.stage) : null;
  const look = a.cls === 'RISK' ? { stageBg: '#45103a', stageFg: '#ff4fae' }
    : a.cls === 'RESOLUTION' ? { stageBg: '#1a2440', stageFg: a.outcome === 'CONFIRMED' ? '#4d8dff' : '#ff4fae' }
      : { stageBg: si.bg, stageFg: si.fg };
  return {
    ...a, ...look,
    accent: ALERT_CLASSES[a.cls].accent,
    chainColor: chainColor(a.chain),
    ts: new Date(a.at).toISOString().slice(11, 19),
  };
}

export function alertsVals() {
  const engine = boardValue('ALERT ENGINE');
  const note = boardNote('ALERT ENGINE') || {};
  const plan = note.plan || { horizonHours: 24 };
  const columns = engine ? Object.keys(COLUMN_LABEL).map((key) => ({
    key, label: COLUMN_LABEL[key], accent: ALERT_CLASSES[key].accent,
    cards: (engine[key] || []).map(cardOf),
    empty: EMPTY[key](plan),
  })) : [];
  return { alertColumns: columns, alertInvalid: note.invalid || [] };
}

/* ============================================================ the cards ==== */

function Bars({ value, accent, css }) {
  const s = strengthOf(value);
  return <span style={css("display:inline-flex;gap:2px;align-items:center;flex-shrink:0", { s })}>
    {[0, 1, 2, 3].map((i) => (
      <span key={i} style={css(
        "width:6px;height:9px;border-radius:1px;background:{{ bg }}",
        { bg: i < s.bars ? accent : '#1c2a4d' }
      )} />
    ))}
  </span>;
}

function AlertCard({ c, css, ping }) {
  const ref = React.useRef(null);
  // Blinking is no help if the card is below the fold.
  React.useEffect(() => {
    if (ping && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [ping]);

  return <div ref={ref} style={css(
    "display:flex;background:#101c38;border-radius:8px;overflow:hidden;animation:{{ anim }}",
    { c, anim: ping ? 'vsAlertPing .6s ease-in-out 3' : 'none' }
  )}>
    <div style={css("width:3px;background:{{ c.accent }};flex-shrink:0", { c })} />
    <div style={css("padding:11px 13px;min-width:0;flex:1", { c })}>

      <div style={css("display:flex;gap:7px;align-items:center;margin-bottom:7px;flex-wrap:wrap", { c })}>
        <span style={css(
          "font-size:8px;font-weight:800;letter-spacing:.7px;padding:3px 8px;border-radius:999px;background:{{ c.stageBg }};color:{{ c.stageFg }}",
          { c }
        )}>{c.outcome || c.stage || c.cls}</span>
        <span style={css("font-weight:800;color:#ffffff;font-size:12.5px", { c })}>{c.sym}</span>
        <span style={css("font-size:9px;font-weight:600;color:{{ c.chainColor }}", { c })}>{c.chain}</span>
        <span style={css("margin-left:auto;font-size:9px;color:#6b7699;font-weight:700", { c })}>
          conf {c.conf == null ? '—' : c.conf.toFixed(2)}
        </span>
      </div>

      <div style={css("font-size:11.5px;color:#dfe6f6;line-height:1.5;font-weight:600;margin-bottom:9px", { c })}>
        {c.claim}
      </div>

      {/* Label and strength share a row; the evidence sentence gets the full
          width beneath it. Side-by-side crushes the sentence to one word per
          line as soon as three columns have to fit. */}
      <div style={css("display:flex;flex-direction:column;gap:7px", { c })}>
        {(c.families || []).map((f, i) => (
          <div key={i}>
            <div style={css("display:flex;gap:6px;align-items:center", { f })}>
              <span style={css("font-size:8px;letter-spacing:.6px;color:#6b7699;font-weight:700", { f })}>
                {f.label.toUpperCase()}
              </span>
              <span style={css("font-size:8px;color:#4a5578;font-weight:700", { f })}>
                {f.value == null ? '—' : f.value}
              </span>
              <span style={css("margin-left:auto;display:flex;align-items:center", { f })}>
                <Bars value={f.value} accent={c.accent} css={css} />
              </span>
            </div>
            <div style={css("font-size:10px;color:#a3aed0;line-height:1.45;margin-top:2px", { f })}>
              {f.evidence}
            </div>
          </div>
        ))}
      </div>

      <div style={css("margin-top:9px;padding-top:8px;border-top:1px solid #1c2a4d", { c })}>
        <span style={css("font-size:9px;color:{{ c.accent }};font-weight:700;letter-spacing:.5px", { c })}>
          INVALIDATES IF
        </span>
        <div style={css("font-size:9.5px;color:#8b96b8;line-height:1.5;margin-top:3px", { c })}>
          {(c.invalidations || []).join(' · ')}
        </div>
      </div>

      <div style={css("font-size:8.5px;color:#6b7699;margin-top:7px", { c })}>
        {c.ts} UTC · {c.id} · horizon {c.horizon}
      </div>
    </div>
  </div>;
}

export default function AlertCards({ v, css }) {
  const columns = v.alertColumns || [];
  // The DATA FLOW's ALERTS NOW box.
  const total = v.alertsNow || 0;

  return v.isAlerts && <>
    <div data-screen-label="Alert cards" style={css("flex:1;overflow:auto;padding:12px 14px;min-height:0", { v })}>

      {/* auto-fit rather than a hard 3-up: below ~950px the columns would each
          be too narrow to hold an evidence sentence, so they wrap instead. */}
      <div style={css("display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:10px;align-items:start", { v })}>
        {columns.map((col) => (
          <div key={col.key} style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;overflow:hidden", { col })}>

            <div style={css(
              "padding:8px 14px;border-bottom:1px solid #1c2a4d;display:flex;align-items:center;gap:8px;border-top:2px solid {{ col.accent }}",
              { col }
            )}>
              <span style={css("font-size:9px;letter-spacing:1.2px;font-weight:700;color:{{ col.accent }}", { col })}>
                {col.label}
              </span>
              <span style={css("margin-left:auto;font-size:9px;font-weight:700;color:#6b7699", { col })}>
                {col.cards.length}
              </span>
            </div>

            <div style={css("padding:12px;display:flex;flex-direction:column;gap:10px", { col })}>
              {col.cards.length
                ? col.cards.map((c, i) => (
                    <AlertCard key={i} c={c} css={css} ping={v.alertPing === c.cls + ':' + c.id} />
                  ))
                : <div style={css("font-size:10px;color:#6b7699;line-height:1.6;padding:6px 2px", { col })}>
                    {col.empty}
                  </div>}
            </div>
          </div>
        ))}
      </div>

      <div style={css("background:#0a1226;border:1px solid #1c2a4d;border-radius:10px;padding:12px 14px;font-size:10px;color:#8b96b8;line-height:1.6;margin-top:10px", { v })}>
        {total} alert{total === 1 ? '' : 's'} on screen. Every card states which evidence families
        fired, how strongly each one did, and the condition that would prove it wrong. Families that
        share inputs are discounted against each other, so four readings of the same trade tape never
        add up to four confirmations.
        {(v.alertInvalid || []).length
          ? <span style={css("color:#ff4fae", { v })}> {(v.alertInvalid || []).length} card(s) failed
              schema validation: {(v.alertInvalid || [])[0]}</span>
          : null}
      </div>
    </div>
  </>;
}
