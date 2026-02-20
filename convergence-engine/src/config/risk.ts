// Phase 3: Portfolio Risk Governor settings

export const RISK_LIMITS = {
  // Max exposure per market pair
  maxPositionPerPair: 0.05, // 5% of bankroll
  
  // Max exposure per event class
  exposureByClass: {
    politics: 0.15,
    sports: 0.10,
    markets: 0.10,
    general: 0.05,
  },
  
  // Max correlation within cluster
  maxCorrelation: 0.7, // prevent over-concentration in related outcomes
  
  // Drawdown kill switch
  maxDailyDrawdown: 0.10, // 10%
  maxWeeklyDrawdown: 0.25, // 25%
  
  // Resolution date clustering
  maxExposureSameResolutionDate: 0.20, 
  maxExposureSameWeek: 0.35,
};

// Correlation clusters
export const CORRELATION_CLUSTERS = {
  "fed_policy": ["fed_chair", "rate_cut", "rate_hike"],
  "trump_related": ["trump_actions", "trump_envoy", "trump_trade"],
  "2028_election": ["dem_nominee", "pres_winner_2028"],
} as const;

export function isInSameCluster(eventA: string, eventB: string): boolean {
  return Object.values(CORRELATION_CLUSTERS).some(
    cluster => cluster.includes(eventA) && cluster.includes(eventB)
  );
}
