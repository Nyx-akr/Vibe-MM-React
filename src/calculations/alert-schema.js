/**
 * Alert contract.
 *
 * The shape every alert takes, whoever builds it. This file is the single
 * agreement between the server (raw inputs) and the app (everything derived),
 * so the alert page, the webhook payload and the evaluation join all read the
 * same object.
 *
 * Nothing here computes. It declares the vocabulary and validates the result.
 *
 * Why it exists: the score model treats danger as a penalty, so a token that
 * looks like a rug scores low, drops below CONFIRMED and stops being alertable.
 * Risk has to be its own class with its own trigger, not a deduction from an
 * opportunity score.
 */

/* ======================================================= alert classes ==== */

/**
 * What kind of claim the card is making. Direction, not magnitude - the stage
 * badge already carries magnitude and must keep agreeing with the number
 * beside it.
 */
export const ALERT_CLASSES = Object.freeze({
  OPPORTUNITY: {
    key: 'OPPORTUNITY',
    label: 'Opportunity',
    // Fires off the existing score model. Unchanged behaviour.
    trigger: 'stage >= 3',
    accent: '#4d8dff'
  },
  RISK: {
    key: 'RISK',
    label: 'Risk',
    // Fires off risk families DIRECTLY - never off the opportunity score.
    // A token with no opportunity signal at all can still be a RISK alert.
    trigger: 'riskScore >= 60 on >= 2 independent families',
    accent: '#ff4fae'
  },
  RESOLUTION: {
    key: 'RESOLUTION',
    label: 'Resolution',
    // Closes a prior alert. The only class that can reference another alert.
    trigger: 'a prior alert met an invalidation condition or its horizon',
    accent: '#8b96b8'
  }
});

/* =================================================== evidence families ==== */

/**
 * Evidence is grouped by WHAT IT OBSERVES, not by which number produced it.
 *
 * The point of the grouping is independence. Four signals derived from the
 * same trade tape are one signal seen four ways - they must not stack into
 * confidence. `correlatesWith` records the families whose inputs overlap, and
 * confidence is discounted across any correlated pair that both fire.
 *
 * `components` maps each family onto the existing 12-component score model so
 * nothing has to be recomputed. Families with an empty `components` list have
 * no data source yet - they are the shopping list.
 */
export const EVIDENCE_FAMILIES = Object.freeze([
  {
    key: 'flow', label: 'Flow', classes: ['OPPORTUNITY'],
    observes: 'Size and direction of traded volume',
    components: ['volumeAnomaly', 'tradeActivity', 'netDemand'],
    correlatesWith: ['liquidity'],
    source: 'have'
  },
  {
    key: 'breadth', label: 'Breadth', classes: ['OPPORTUNITY'],
    observes: 'How many distinct actors, and their quality',
    components: ['buyerBreadth', 'holderGrowth', 'walletQuality'],
    correlatesWith: [],
    source: 'have'
  },
  {
    key: 'liquidity', label: 'Liquidity', classes: ['OPPORTUNITY', 'RISK'],
    observes: 'Pool depth, executability, price agreement across venues',
    components: ['liquidity', 'priceConfirmation', 'crossVenue', 'usdReference'],
    correlatesWith: ['flow'],
    source: 'have'
  },
  {
    key: 'rotation', label: 'Rotation', classes: ['OPPORTUNITY'],
    observes: 'Capital arriving from a named cohort rather than from nowhere',
    components: ['capitalRotation'],
    correlatesWith: [],
    source: 'have'
  },
  {
    key: 'contract', label: 'Contract', classes: ['RISK'],
    observes: 'Mint and freeze authority, sell tax, LP lock state, proxy upgrades',
    components: ['contractSafety'],
    correlatesWith: [],
    // The GoPlus normalizer is already in lib/providers.js but stays dormant
    // without GOPLUS_API_KEY. This family is one env var from being real.
    source: 'dormant'
  },
  {
    key: 'holders', label: 'Holders', classes: ['RISK'],
    observes: 'Supply distribution and movement toward exchange deposits',
    components: [],
    correlatesWith: ['breadth'],
    source: 'missing'
  },
  {
    key: 'deployer', label: 'Deployer', classes: ['RISK'],
    observes: 'Funding path of the deployer and the fate of its prior tokens',
    components: [],
    correlatesWith: [],
    source: 'missing'
  },
  {
    key: 'integrity', label: 'Integrity', classes: ['OPPORTUNITY', 'RISK'],
    observes: 'Whether the inputs themselves can be trusted',
    components: ['dataQuality', 'organicFlow'],
    correlatesWith: [],
    // Shown on every card, but it cannot CONSTITUTE a risk claim - "only one
    // provider priced this pool" is a coverage fact, true of a third of the
    // table. Immaturity and thin coverage discount confidence; they are not
    // evidence that a token is dangerous.
    constitutesRisk: false,
    source: 'have'
  },
  {
    key: 'narrative', label: 'Narrative', classes: ['OPPORTUNITY', 'RISK'],
    observes: 'What is being said, and whether it looks coordinated',
    components: [],
    correlatesWith: [],
    // Corroboration only. Never an input to score or confidence - it is the
    // slowest and most gameable leg, and it is a model opinion about text,
    // not a measurement.
    weightsScore: false,
    source: 'missing'
  }
]);

export const FAMILY_KEYS = Object.freeze(EVIDENCE_FAMILIES.map((f) => f.key));

/* ================================================== per-family scoring ==== */

/**
 * Every family reports the same tuple, so the card can render a strength bar
 * per family and a reader can distrust one leg while still using the others.
 *
 *   value       0-100  how strongly this family supports the claim
 *   confidence  0-1    how much the family trusts its own inputs
 *   evidence    string one human sentence, stating metric AND baseline
 *   inputs      object the raw numbers it read, for the audit trail
 *   observedAt  ms     when the underlying data was sampled, not when scored
 *
 * A family with no data reports null, never a zero. Absent evidence and
 * evidence of absence are different claims and the card must say which.
 */
export const FAMILY_STRENGTH = Object.freeze({
  ABSENT: { min: null, label: 'no data', bars: 0 },
  WEAK: { min: 0, label: 'weak', bars: 1 },
  MODERATE: { min: 40, label: 'moderate', bars: 2 },
  STRONG: { min: 65, label: 'strong', bars: 3 },
  DECISIVE: { min: 85, label: 'decisive', bars: 4 }
});

export function strengthOf(value) {
  if (value == null || !Number.isFinite(value)) return FAMILY_STRENGTH.ABSENT;
  if (value >= 85) return FAMILY_STRENGTH.DECISIVE;
  if (value >= 65) return FAMILY_STRENGTH.STRONG;
  if (value >= 40) return FAMILY_STRENGTH.MODERATE;
  return FAMILY_STRENGTH.WEAK;
}

/**
 * Which of a card's families actually CONSTITUTE a risk claim.
 *
 * A family qualifies only if it observes danger (not data coverage) and is
 * reporting at or above the trigger. Integrity is deliberately excluded: it
 * moves confidence, never the claim itself.
 */
export const RISK_TRIGGER = 60;

export function constitutingRisk(families) {
  return (families || []).filter((f) => {
    const spec = EVIDENCE_FAMILIES.find((s) => s.key === f.key);
    if (!spec || spec.classes.indexOf('RISK') === -1) return false;
    if (spec.constitutesRisk === false) return false;
    return f.value != null && f.value >= RISK_TRIGGER;
  });
}

/**
 * A risk flag's family strength, taken from the penalty it already carries.
 *
 * assessRisk() calibrated those penalties (2-6 points) against each other, so
 * they are a finer and more honest scale than the two severity labels. Mapping
 * off severity alone produced a step function with the trigger sitting in the
 * gap between its two values.
 */
export function valueFromPenalty(penalty) {
  if (!Number.isFinite(penalty)) return 40;
  return Math.max(0, Math.min(95, 40 + penalty * 8));
}

/**
 * Confidence across families, discounted for overlap.
 *
 * Two correlated families that both fire count as roughly one and a half, not
 * two. Without this an alert built entirely out of the trade tape reads as
 * well-corroborated when it is a single observation restated.
 */
export function combineConfidence(families) {
  const firing = (families || []).filter((f) => f.value != null && f.value >= 40);
  if (!firing.length) return 0;

  let total = 0;
  const counted = new Set();
  for (const f of firing) {
    const spec = EVIDENCE_FAMILIES.find((s) => s.key === f.key);
    const overlaps = (spec ? spec.correlatesWith : []).some((k) => counted.has(k));
    total += (f.confidence == null ? 0.5 : f.confidence) * (overlaps ? 0.5 : 1);
    counted.add(f.key);
  }
  // Saturating, so a pile-up of weak families never reads as certainty.
  return Math.min(0.97, 1 - Math.exp(-total / 1.8));
}

/* =========================================== invalidation + resolution ==== */

/**
 * What would prove this alert wrong. Machine-checkable, because a prose
 * caveat nobody evaluates is decoration.
 *
 * Every alert carries at least one. An alert that cannot be wrong is not a
 * claim, and Evaluation cannot score it.
 */
export const INVALIDATION_KINDS = Object.freeze({
  // A metric crosses back over a line.     { metric, op, value, withinMs }
  THRESHOLD: 'threshold',
  // A named onchain event lands.           { event, withinMs }
  EVENT: 'event',
  // The claim had a horizon and it passed. { afterMs }
  HORIZON: 'horizon'
});

export const RESOLUTIONS = Object.freeze({
  CONFIRMED: 'confirmed',      // horizon passed, nothing invalidated it
  INVALIDATED: 'invalidated',  // an invalidation condition fired
  EXPIRED: 'expired',          // horizon passed with inputs too stale to judge
  PENDING: 'pending'
});

/* ========================================================= the payload ==== */

/**
 * One alert. This is what the webhook carries, what the card renders, and what
 * the score journal stores.
 *
 * The producer column matters: the server stays raw-only, so every derived
 * field below is built in the app. The single exception is the narrative
 * family, which needs a key that cannot ship to a browser - it arrives
 * pre-scored on its own lane and is the only derived value the server emits.
 *
 *   id            app     stable across restatements of the same alert
 *   class         app     ALERT_CLASSES key
 *   stage         app     existing bucketed score - OPPORTUNITY only
 *   score         app     0-100, the class's own score
 *   confidence    app     combineConfidence() over the families
 *   token         server  address, symbol, chain - raw identity
 *   claim         app     one sentence, the thing being asserted
 *   families      app     array of the tuple above, one per firing family
 *   invalidations app     at least one, machine-checkable
 *   horizonMs     app     when resolution is due
 *   resolution    app     RESOLUTIONS key, PENDING until the horizon
 *   supersedes    app     id of the alert this restates, if any
 *   observedAt    server  when the newest input was sampled
 *   emittedAt     app     when the card was built
 */
export function validateAlert(alert) {
  const problems = [];
  const a = alert || {};

  if (a.id == null) problems.push('id is required');
  if (!ALERT_CLASSES[a.class]) problems.push('class must be an ALERT_CLASSES key');
  if (a.claim == null) problems.push('claim is required - the card has nothing to say');

  const families = a.families || [];
  if (!families.length) problems.push('at least one evidence family must report');
  for (const f of families) {
    if (!FAMILY_KEYS.includes(f.key)) problems.push('unknown family: ' + f.key);
    if (f.value != null && !f.evidence) {
      problems.push(f.key + ' reports a value with no evidence sentence');
    }
  }

  // The rule the whole page rests on.
  if (!(a.invalidations || []).length) {
    problems.push('an alert with no invalidation condition is not a claim');
  }

  if (a.class === 'RISK') {
    if (constitutingRisk(families).length < 2) {
      problems.push('RISK needs >= 2 independent risk families at >= 60');
    }
  }

  const narrative = families.find((f) => f.key === 'narrative');
  if (narrative && narrative.weighted) {
    problems.push('narrative must not weight the score - corroboration only');
  }

  return { ok: problems.length === 0, problems };
}
