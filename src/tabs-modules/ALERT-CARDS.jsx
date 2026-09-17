import React from 'react';
import { stageInfo, chainColor } from '../utils/formatters';
import {
  ALERT_CLASSES, EVIDENCE_FAMILIES, RESOLUTIONS,
  strengthOf, combineConfidence, validateAlert,
  constitutingRisk, valueFromPenalty
} from '../calculations/alert-schema';
import { journalFor } from '../services/score-journal';
import { chainKeys } from '../data/chains';

/**
 * What the bot would actually have sent, grouped by the claim it makes.
 *
 * Three columns, three classes. OPPORTUNITY is the score model as before.
 * RISK fires off the risk families directly, because a token that looks like
 * a rug scores LOW - if risk only ever subtracted from the opportunity score
 * the worst tokens would be the quietest ones. RESOLUTION closes prior alerts
 * out of the score journal.
 *
 * Nothing here is composed. Every evidence line is what a family reported and
 * every card carries the condition that would prove it wrong.
 */

const OPP_HORIZON_MS = 6 * 3600e3;
const RISK_HORIZON_MS = 4 * 3600e3;

/** Which risk family each existing risk-flag code belongs to. */
const FLAG_FAMILY = {
  CONTRACT_CHECKS: 'contract',
  THIN_LIQUIDITY: 'liquidity',
  EXTREME_TURNOVER: 'liquidity',
  VOLUME_CONCENTRATED: 'holders',
  LOW_ORGANIC_FLOW: 'integrity',
  SINGLE_SOURCE: 'integrity',
  NEW_POOL: 'integrity'
};

const familySpec = (key) => EVIDENCE_FAMILIES.find((f) => f.key === key);

/**
 * An opportunity family, averaged over the score components it owns.
 * Confidence is how much of the family actually reported - a family speaking
 * from one of its three inputs is not as sure as one speaking from all three.
 */
function opportunityFamily(row, key) {
  const spec = familySpec(key);
  const owned = (row.scoreModel || []).filter((c) => spec.components.indexOf(c.key) !== -1);
  const live = owned.filter((c) => !c.pending && c.value != null);
  if (!live.length) return { key, label: spec.label, value: null, confidence: 0, evidence: null };

  const weight = live.reduce((t, c) => t + c.weight, 0);
  const value = Math.round(live.reduce((t, c) => t + c.value * c.weight, 0) / (weight || 1));
  const lead = live.slice().sort((x, y) => (y.value * y.weight) - (x.value * x.weight))[0];
  return {
    key, label: spec.label, value,
    confidence: owned.length ? live.length / owned.length : 0,
    evidence: lead && lead.evidence ? lead.evidence : lead.label + ' scored ' + lead.value
  };
}

/** A risk family, built from the flags that fired inside it. */
function riskFamilies(row) {
  const byFamily = {};
  for (const flag of row.riskFlags || []) {
    const key = FLAG_FAMILY[flag.code];
    if (!key) continue;
    const value = valueFromPenalty(flag.penalty);
    const current = byFamily[key];
    if (!current || value > current.value) {
      byFamily[key] = {
        key, label: familySpec(key).label, value,
        confidence: flag.severity === 'HIGH' ? 0.8 : 0.55,
        evidence: flag.detail || flag.code
      };
    }
  }
  return Object.keys(byFamily).map((k) => byFamily[k]);
}

export function alertsVals(app) {
  const assets = app.assets || [];
  const now = Date.now();

  /* ---------------------------------------------------------- opportunity */

  const opportunities = assets
    .filter((a) => a.stage >= 3 && a.score != null)
    .sort((x, y) => y.score - x.score)
    .slice(0, 4)
    .map((a) => {
      const row = a.rawServerRow || {};
      const si = stageInfo(a.stage);
      const families = ['flow', 'breadth', 'liquidity', 'rotation', 'integrity']
        .map((k) => opportunityFamily(row, k))
        .filter((f) => f.value != null);

      const floor = a.stage >= 4 ? 85 : 70;
      return {
        cls: 'OPPORTUNITY', accent: ALERT_CLASSES.OPPORTUNITY.accent,
        stage: si.n, stageBg: si.bg, stageFg: si.fg,
        sym: a.sym, chain: a.chain, chainColor: chainColor(a.chain),
        claim: si.n + ' on ' + a.sym + ' — score ' + a.score + ' across ' +
          families.length + ' independent famil' + (families.length === 1 ? 'y' : 'ies') + '.',
        families,
        conf: a.conf == null ? combineConfidence(families) : a.conf,
        invalidations: [
          'score falls below ' + floor + ' within ' + (OPP_HORIZON_MS / 3600e3) + 'h',
          'liquidity drops under $50K before the horizon'
        ],
        horizon: (OPP_HORIZON_MS / 3600e3) + 'h',
        ts: new Date(Number.isFinite(row.stageSince) ? row.stageSince : now)
          .toISOString().slice(11, 19),
        id: 'alert ' + String(row.tokenAddress || a.id).slice(0, 8),
        slug: String(a.sym || '').replace(/^\$/, '').toLowerCase()
      };
    });

  /* ----------------------------------------------------------------- risk */

  const risks = assets
    .map((a) => {
      const row = a.rawServerRow || {};
      const families = riskFamilies(row);
      // Integrity is shown but never counts toward the trigger - see the
      // schema. Coverage and immaturity move confidence, not the claim.
      const firing = constitutingRisk(families);
      return { a, row, families, firing };
    })
    // The schema's own rule: two independent risk families, not one.
    .filter((r) => r.firing.length >= 2)
    .sort((x, y) => y.firing.length - x.firing.length ||
      (y.row.riskPenalty || 0) - (x.row.riskPenalty || 0))
    .slice(0, 4)
    .map(({ a, row, families, firing }) => {
      const worst = firing.slice().sort((x, y) => y.value - x.value)[0];
      return {
        cls: 'RISK', accent: ALERT_CLASSES.RISK.accent,
        stage: null, stageBg: '#45103a', stageFg: '#ff4fae',
        sym: a.sym, chain: a.chain, chainColor: chainColor(a.chain),
        claim: firing.length + ' independent risk families fired on ' + a.sym +
          ' — led by ' + worst.label.toLowerCase() + '.',
        families,
        conf: combineConfidence(firing),
        invalidations: firing.map((f) => f.label.toLowerCase() + ' clears within ' +
          (RISK_HORIZON_MS / 3600e3) + 'h'),
        horizon: (RISK_HORIZON_MS / 3600e3) + 'h',
        ts: new Date(now).toISOString().slice(11, 19),
        id: 'alert ' + String(row.tokenAddress || a.id).slice(0, 8),
        slug: String(a.sym || '').replace(/^\$/, '').toLowerCase()
      };
    });

  /* ----------------------------------------------------------- resolution */

  // Symbols for tokens that may have left the live table since they alerted.
  const symbolFor = {};
  for (const a of assets) {
    const addr = (a.rawServerRow || {}).tokenAddress;
    if (addr) symbolFor[addr] = a.sym;
  }

  const resolutions = [];
  for (const chainKey of chainKeys) {
    const journal = journalFor(chainKey);
    for (const addr of Object.keys(journal)) {
      const series = journal[addr] || [];
      if (series.length < 2) continue;

      const alerted = series.findIndex((m) => m.stage >= 3);
      if (alerted === -1) continue;
      const opened = series[alerted];
      const latest = series[series.length - 1];
      const elapsed = latest.t - opened.t;

      let outcome = null;
      if (latest.stage < 3) outcome = RESOLUTIONS.INVALIDATED;
      else if (elapsed >= OPP_HORIZON_MS) outcome = RESOLUTIONS.CONFIRMED;
      if (!outcome) continue;

      const delta = latest.score - opened.score;
      resolutions.push({
        cls: 'RESOLUTION', accent: ALERT_CLASSES.RESOLUTION.accent,
        stage: null, stageBg: '#1a2440',
        stageFg: outcome === RESOLUTIONS.CONFIRMED ? '#4d8dff' : '#ff4fae',
        outcome: outcome.toUpperCase(),
        sym: symbolFor[addr] || ('$' + addr.slice(0, 4).toUpperCase()),
        chain: chainKey.toUpperCase().slice(0, 4),
        chainColor: chainColor(chainKey.toUpperCase().slice(0, 4)),
        claim: outcome === RESOLUTIONS.CONFIRMED
          ? 'Held ' + stageInfo(Math.max(3, latest.stage)).n + ' through the ' +
            (OPP_HORIZON_MS / 3600e3) + 'h horizon.'
          : 'Fell out of CONFIRMED after ' + (elapsed / 3600e3).toFixed(1) + 'h.',
        families: [{
          key: 'flow', label: 'Score path', value: Math.max(0, Math.min(100, latest.score)),
          confidence: 0.9,
          evidence: 'Opened at ' + opened.score + ', now ' + latest.score +
            ' (' + (delta >= 0 ? '+' : '') + delta + ') over ' +
            (elapsed / 3600e3).toFixed(1) + 'h'
        }],
        conf: 0.9,
        invalidations: ['resolved — the journal is the record, nothing further to check'],
        horizon: 'closed',
        sortT: latest.t,
        ts: new Date(latest.t).toISOString().slice(11, 19),
        id: 'alert ' + addr.slice(0, 8),
        slug: addr.slice(0, 8)
      });
    }
  }
  resolutions.sort((x, y) => y.sortT - x.sortT);

  /* ----------------------------------------------------------- validation */

  // The contract is enforced here, not assumed. A card that fails validation
  // is a bug in this file, and the column footer says so rather than hiding it.
  const invalid = [];
  for (const card of [...opportunities, ...risks, ...resolutions]) {
    const check = validateAlert({
      id: card.id, class: card.cls, claim: card.claim,
      families: card.families, invalidations: card.invalidations
    });
    if (!check.ok) invalid.push(card.id + ': ' + check.problems[0]);
  }

  const columns = [
    {
      key: 'OPPORTUNITY', label: 'OPPORTUNITY', accent: ALERT_CLASSES.OPPORTUNITY.accent,
      cards: opportunities,
      empty: 'Nothing is at CONFIRMED or above right now, so no opportunity alert would have been sent.'
    },
    {
      key: 'RISK', label: 'RISK', accent: ALERT_CLASSES.RISK.accent,
      cards: risks.slice(0, 4),
      empty: 'No token has two independent risk families above 60. Only contract, liquidity and holders can constitute a risk claim today — deployer history is not wired, and integrity moves confidence rather than the claim.'
    },
    {
      key: 'RESOLUTION', label: 'RESOLUTION', accent: ALERT_CLASSES.RESOLUTION.accent,
      cards: resolutions.slice(0, 4),
      empty: 'No prior alert has reached its horizon yet. Resolutions appear once a scored token has been tracked for ' + (OPP_HORIZON_MS / 3600e3) + 'h.'
    }
  ];

  return { alertColumns: columns, alertInvalid: invalid };
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
  const total = columns.reduce((t, col) => t + col.cards.length, 0);

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
