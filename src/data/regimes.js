/**
 * The market regimes the header picker offers. Nothing measures a regime
 * yet: the choice is the user's, kept on the DATA FLOW's MARKET REGIME
 * selector box (setting REGIME_SETTING), and the header shows that choice.
 */
export const REGIMES = [
  { id: 'RISK-ON EXPANSION', note: 'broad rally, most tokens up, liquidity rising' },
  { id: 'BROAD ROTATION', note: 'cohorts swapping leadership, wide participation' },
  { id: 'SELECTIVE ROTATION', note: 'flat overall, narrow breadth, few winners' },
  { id: 'MAJORS-LED', note: 'bid concentrated in majors, alts bleeding' },
  { id: 'RISK-OFF', note: 'broad bleed, capital retreating to stables' },
  { id: 'CAPITULATION', note: 'forced selling, liquidity vanishing' },
  { id: 'CHOP / RANGEBOUND', note: 'low dispersion, low volume against baseline' },
  { id: 'LAUNCH MANIA', note: 'new-pool rate spiking, memecoin share climbing' },
  { id: 'LIQUIDITY DRAIN', note: 'pool liquidity falling across chains' },
];

export const REGIME_SETTING = 'f:pipe:MARKET REGIME:pick';
export const REGIME_DEFAULT = 'SELECTIVE ROTATION';
