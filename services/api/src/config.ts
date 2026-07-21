import type { DisputeVerdict, StreamTerms } from '@pact/shared';

export interface ReputationTier {
  minScore: number;
  terms: StreamTerms;
}

export const REPUTATION_TIERS: ReputationTier[] = [
  {
    minScore: 701,
    terms: {
      collateralPct: 0,
      payoutSpeed: 'FAST',
      maxTaskSize: null,
      requiresManualCheckpoints: false,
      unlockIntervalSeconds: 1
    }
  },
  {
    minScore: 401,
    terms: {
      collateralPct: 10,
      payoutSpeed: 'FAST',
      maxTaskSize: '10000',
      requiresManualCheckpoints: false,
      unlockIntervalSeconds: 1
    }
  },
  {
    minScore: 101,
    terms: {
      collateralPct: 25,
      payoutSpeed: 'MEDIUM',
      maxTaskSize: '1000',
      requiresManualCheckpoints: true,
      unlockIntervalSeconds: 60
    }
  },
  {
    minScore: 0,
    terms: {
      collateralPct: 50,
      payoutSpeed: 'SLOW',
      maxTaskSize: '500',
      requiresManualCheckpoints: true,
      unlockIntervalSeconds: 600
    }
  }
];

export const VERDICT_SLASH_PCT: Record<DisputeVerdict, number> = {
  NO_FAULT: 0,
  PARTIAL_FAULT: 50,
  FULL_FAULT: 100
};

export const SCORE = {
  base: 80,
  completionWeight: 65,
  failurePenalty: 210,
  volumeWeight: 15
} as const;
