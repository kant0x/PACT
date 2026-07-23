import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import type { ArenaChallengeKind } from '@pact/shared';
import { ARENA_JUDGE_TRAINING_VERSION, arenaJudgeInstructions } from '../src/arena-judge-rubric.js';

type GoldenRow = {
  id: string;
  kind: ArenaChallengeKind;
  task: string;
  submission: string;
  validatedEvidence: string;
  deterministicChecks: Array<{ code: string; passed: boolean; detail: string }>;
  label: { score: number; reasoning: string };
};

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is required for the arena judge eval');
const model = process.env.ARENA_JUDGE_MODEL?.trim();
if (!model) throw new Error('ARENA_JUDGE_MODEL must be the candidate base or ft: model id');
const repoRoot = resolve(import.meta.dirname, '../../..');
const inputPath = resolve(repoRoot, process.env.ARENA_JUDGE_GOLDEN_FILE ?? 'training/arena-judge/golden.jsonl');
const outputPath = resolve(repoRoot, process.env.ARENA_JUDGE_EVAL_REPORT ?? 'training/data/arena-judge/eval-report.json');
const rows = (await readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as GoldenRow);
if (rows.length < 20) throw new Error('Release eval requires at least 20 held-out golden judgments');
const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
const band = (score: number) => score < 35 ? 'WEAK' : score <= 65 ? 'ACCEPTABLE' : 'STRONG';
const details = [];
for (const row of rows) {
  const response = await client.responses.create({
    model,
    instructions: arenaJudgeInstructions(row.kind),
    input: JSON.stringify({
      rubricVersion: ARENA_JUDGE_TRAINING_VERSION,
      kind: row.kind,
      task: row.task,
      submission: row.submission,
      validatedEvidence: row.validatedEvidence,
      deterministicChecks: row.deterministicChecks
    }),
    store: false,
    max_output_tokens: 300,
    text: { format: { type: 'json_schema', name: 'arena_quality_decision', strict: true, schema: {
      type: 'object', additionalProperties: false,
      properties: { score: { type: 'integer', minimum: 0, maximum: 100 }, reasoning: { type: 'string', minLength: 1, maxLength: 800 } },
      required: ['score', 'reasoning']
    } } }
  });
  const actual = JSON.parse(response.output_text) as { score: number; reasoning: string };
  details.push({ id: row.id, expected: row.label.score, actual: actual.score, absoluteError: Math.abs(row.label.score - actual.score), bandMatch: band(row.label.score) === band(actual.score) });
}
const mae = details.reduce((sum, item) => sum + item.absoluteError, 0) / details.length;
const bandAccuracy = details.filter((item) => item.bandMatch).length / details.length;
const passed = mae <= 8 && bandAccuracy >= 0.9;
await writeFile(outputPath, JSON.stringify({ model, cases: rows.length, mae, bandAccuracy, passed, thresholds: { maxMae: 8, minBandAccuracy: 0.9 }, details }, null, 2), 'utf8');
console.log(JSON.stringify({ model, cases: rows.length, mae, bandAccuracy, passed, report: outputPath }, null, 2));
if (!passed) process.exitCode = 1;
