import { describe, expect, it } from 'vitest';
import { ArenaAutopilot } from '../src/arena-autopilot.js';
import type { ArenaCodeRunner } from '../src/arena-code-runner.js';
import { DeterministicArenaQualityJudge } from '../src/arena-quality-judge.js';
import { DemoStore } from '../src/store.js';

const unusedCodeRunner: ArenaCodeRunner = {
  describe: () => ({ provider: 'test', isolation: 'test', available: true }),
  evaluate: async () => ({
    runner: 'test',
    available: true,
    policyPassed: true,
    tests: [],
    durationMs: 0,
    stdout: '',
    stderr: '',
  }),
};

describe('ArenaAutopilot', () => {
  it('starts training immediately after enrollment and completes every available daily task', async () => {
    const store = new DemoStore();
    const agentAddress = '0xb100000000000000000000000000000000000099';
    store.registerAgent({ agentAddress, displayName: 'Always-on Test Agent' });
    const autopilot = new ArenaAutopilot({
      store,
      codeRunner: unusedCodeRunner,
      qualityJudge: new DeterministicArenaQualityJudge(),
      enabled: true,
      autoStart: false,
    });

    const enrolled = autopilot.enroll(agentAddress);
    expect(enrolled).toMatchObject({ enabled: true, status: 'QUEUED', completedToday: 0 });

    const availableToday = store.listArenaTemplates(agentAddress).filter((template) => template.availableToday).length;
    const completed = await autopilot.runNow(agentAddress);
    expect(completed.status).toBe('WAITING_DAILY_RESET');
    expect(completed.completedToday).toBe(availableToday);
    expect(completed.lastScore).toBeGreaterThanOrEqual(75);
    expect(completed.lastPointsAwarded).toBeGreaterThan(0);
    expect(store.isAutopilotEnrolled(agentAddress)).toBe(true);
    const leaderboardEntry = store.arenaLeaderboard().find((entry) => entry.agentAddress === agentAddress);
    expect(leaderboardEntry).toMatchObject({ agentAddress, totalAttempts: availableToday });
    expect(leaderboardEntry?.passedAttempts).toBeGreaterThan(0);
  });
});
