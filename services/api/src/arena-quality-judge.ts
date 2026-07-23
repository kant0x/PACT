import OpenAI from 'openai';
import type { ArenaChallengeKind } from '@pact/shared';
import { sanitizeJudgeText } from './judge-security.js';
import { ARENA_RUBRIC_VERSION, sha256 } from './arena.js';
import { arenaJudgeInstructions } from './arena-judge-rubric.js';

export interface ArenaQualityJudgeInput {
  kind: ArenaChallengeKind;
  task: string;
  submission: string;
  validatedEvidence: string;
  deterministicChecks: Array<{ code: string; passed: boolean; detail: string }>;
}

export interface ArenaQualityDecision {
  provider: string;
  score: number;
  reasoning: string;
  receiptHash: string;
  tokensUsed: number | null;
}

export interface ArenaQualityJudge {
  readonly provider: string;
  evaluate(input: ArenaQualityJudgeInput): Promise<ArenaQualityDecision>;
}

const finalize = (provider: string, score: number, reasoning: string, input: ArenaQualityJudgeInput, tokensUsed: number | null): ArenaQualityDecision => {
  const boundedScore = Math.round(Math.max(0, Math.min(100, score)));
  const safeReasoning = sanitizeJudgeText(reasoning, 800).text.trim();
  return {
    provider,
    score: boundedScore,
    reasoning: safeReasoning,
    tokensUsed,
    receiptHash: sha256(JSON.stringify({
      provider,
      rubricVersion: ARENA_RUBRIC_VERSION,
      kind: input.kind,
      submissionHash: sha256(input.submission),
      evidenceHash: sha256(input.validatedEvidence),
      checks: input.deterministicChecks,
      score: boundedScore,
      reasoning: safeReasoning
    }))
  };
};

/** Explicit local rubric used for tests and offline development. It never claims to be an LLM judgment. */
export class DeterministicArenaQualityJudge implements ArenaQualityJudge {
  readonly provider = 'deterministic-rubric-v2';

  async evaluate(input: ArenaQualityJudgeInput): Promise<ArenaQualityDecision> {
    const text = sanitizeJudgeText(input.submission, 8_000).text.trim();
    const evidence = sanitizeJudgeText(input.validatedEvidence, 8_000).text.trim();
    const supported = input.deterministicChecks.filter((check) => check.passed).length;
    const coverage = input.deterministicChecks.length ? supported / input.deterministicChecks.length : 0;
    const explanationSignal = text.length >= 40 ? 1 : text.length >= 15 ? 0.6 : 0.2;
    const evidenceSignal = evidence.length >= 10 ? 1 : 0.4;
    const score = 35 + coverage * 35 + explanationSignal * 20 + evidenceSignal * 10;
    return finalize(
      this.provider,
      score,
      'Local rubric scored evidence coverage, bounded explanation substance, and consistency with deterministic checks.',
      input,
      null
    );
  }
}

export class OpenAIArenaQualityJudge implements ArenaQualityJudge {
  readonly provider: string;
  private readonly client: OpenAI;

  constructor(apiKey: string, private readonly model = process.env.ARENA_JUDGE_MODEL ?? 'gpt-4o-mini') {
    this.client = new OpenAI({
      apiKey,
      timeout: Number(process.env.ARENA_JUDGE_TIMEOUT_MS ?? 20_000),
      maxRetries: 1
    });
    this.provider = `openai:${model}`;
  }

  async evaluate(input: ArenaQualityJudgeInput): Promise<ArenaQualityDecision> {
    const safeTask = sanitizeJudgeText(input.task, 8_000).text;
    const safeSubmission = sanitizeJudgeText(input.submission, 12_000).text;
    const safeEvidence = sanitizeJudgeText(input.validatedEvidence, 12_000).text;
    const response = await this.client.responses.create({
      model: this.model,
      instructions: arenaJudgeInstructions(input.kind),
      input: JSON.stringify({
        rubricVersion: ARENA_RUBRIC_VERSION,
        kind: input.kind,
        task: safeTask,
        submission: safeSubmission,
        validatedEvidence: safeEvidence,
        deterministicChecks: input.deterministicChecks
      }),
      store: false,
      max_output_tokens: Number(process.env.ARENA_JUDGE_MAX_OUTPUT_TOKENS ?? 300),
      text: {
        format: {
          type: 'json_schema',
          name: 'arena_quality_decision',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              score: { type: 'integer', minimum: 0, maximum: 100 },
              reasoning: { type: 'string', minLength: 1, maxLength: 800 }
            },
            required: ['score', 'reasoning']
          }
        }
      }
    });
    const parsed = JSON.parse(response.output_text) as { score: number; reasoning: string };
    if (!Number.isInteger(parsed.score) || parsed.score < 0 || parsed.score > 100 || !parsed.reasoning?.trim()) {
      throw new Error('Arena quality judge returned an invalid decision');
    }
    return finalize(this.provider, parsed.score, parsed.reasoning, input, response.usage?.total_tokens ?? null);
  }
}

export const createArenaQualityJudgeFromEnv = (): ArenaQualityJudge => {
  const provider = (process.env.ARENA_JUDGE_PROVIDER ?? (process.env.NODE_ENV === 'production' ? 'openai' : 'deterministic')).toLowerCase();
  if (provider === 'deterministic') return new DeterministicArenaQualityJudge();
  if (provider !== 'openai') throw new Error(`Unsupported ARENA_JUDGE_PROVIDER: ${provider}`);
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required when ARENA_JUDGE_PROVIDER=openai');
  return new OpenAIArenaQualityJudge(apiKey);
};
