import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import type { ArenaChallengeKind } from '@pact/shared';
import { ARENA_JUDGE_TRAINING_VERSION, arenaJudgeInstructions } from '../src/arena-judge-rubric.js';

type Candidate = {
  id: string;
  kind: ArenaChallengeKind;
  task: string;
  submission: string;
  validatedEvidence: string;
  deterministicChecks: Array<{ code: string; passed: boolean; detail: string }>;
  docRefs: string[];
};

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is required to create teacher-label candidates');
const repoRoot = resolve(import.meta.dirname, '../../..');
const inputPath = resolve(repoRoot, process.env.ARENA_JUDGE_UNLABELED_FILE ?? 'training/arena-judge/unlabeled.jsonl');
const outputPath = resolve(repoRoot, process.env.ARENA_JUDGE_TEACHER_OUTPUT ?? 'training/arena-judge/candidates.teacher.jsonl');
const teacherModel = process.env.ARENA_JUDGE_TEACHER_MODEL ?? 'gpt-5.6-terra';
const rows = (await readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Candidate);
const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
const labelled = [];
for (const row of rows) {
  const response = await client.responses.create({
    model: teacherModel,
    instructions: `${arenaJudgeInstructions(row.kind)} Create a candidate label for a human reviewer; your output is not approved training data.`,
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
    text: { format: { type: 'json_schema', name: 'arena_teacher_label', strict: true, schema: {
      type: 'object', additionalProperties: false,
      properties: { score: { type: 'integer', minimum: 0, maximum: 100 }, reasoning: { type: 'string', minLength: 1, maxLength: 800 } },
      required: ['score', 'reasoning']
    } } }
  });
  labelled.push({
    ...row,
    label: JSON.parse(response.output_text),
    reviewer: '',
    reviewStatus: 'PENDING',
    teacher: { model: teacherModel, responseId: response.id }
  });
}
await writeFile(outputPath, `${labelled.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
console.log(`Wrote ${labelled.length} unapproved teacher candidates to ${outputPath}`);
console.log('A human must review, edit if needed, set reviewer, and change reviewStatus to APPROVED before dataset preparation.');
