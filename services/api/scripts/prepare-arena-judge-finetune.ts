import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ArenaChallengeKind } from '@pact/shared';
import { ARENA_JUDGE_TRAINING_VERSION, arenaJudgeInstructions } from '../src/arena-judge-rubric.js';

type ReviewedJudgment = {
  id: string;
  kind: ArenaChallengeKind;
  task: string;
  submission: string;
  validatedEvidence: string;
  deterministicChecks: Array<{ code: string; passed: boolean; detail: string }>;
  label: { score: number; reasoning: string };
  reviewer: string;
  reviewStatus: 'APPROVED';
  docRefs: string[];
};

const args = process.argv.slice(2);
const repoRoot = resolve(import.meta.dirname, '../../..');
const flag = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const inputPath = resolve(repoRoot, flag('--input', 'training/arena-judge/reviewed.jsonl'));
const outputDir = resolve(repoRoot, flag('--output-dir', 'training/data/arena-judge'));
const allowSmall = args.includes('--allow-small-dataset');
const secretPattern = /(?:sk-[A-Za-z0-9_-]{20,}|-----BEGIN [^-]+PRIVATE KEY-----|\b0x[a-fA-F0-9]{64}\b)/i;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const raw = await readFile(inputPath, 'utf8');
const rows = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line) as ReviewedJudgment; }
  catch { throw new Error(`Invalid JSON on ${inputPath}:${index + 1}`); }
});
const ids = new Set<string>();
for (const [index, row] of rows.entries()) {
  if (!row.id || ids.has(row.id)) throw new Error(`Missing or duplicate id at row ${index + 1}`);
  ids.add(row.id);
  if (!['GROUNDED_QA', 'CODE_REPAIR', 'TOOL_WORKFLOW'].includes(row.kind)) throw new Error(`Invalid kind for ${row.id}`);
  if (row.reviewStatus !== 'APPROVED' || !row.reviewer?.trim()) throw new Error(`Human approval is required for ${row.id}`);
  if (!Number.isInteger(row.label?.score) || row.label.score < 0 || row.label.score > 100) throw new Error(`Invalid score for ${row.id}`);
  if (!row.label.reasoning?.trim() || row.label.reasoning.length > 800) throw new Error(`Invalid reasoning for ${row.id}`);
  if (!row.docRefs?.length) throw new Error(`At least one rubric document reference is required for ${row.id}`);
  if (secretPattern.test(JSON.stringify(row))) throw new Error(`Possible secret detected in ${row.id}`);
}
if (rows.length < 200 && !allowSmall) {
  throw new Error(`Arena judge release training requires at least 200 approved examples; found ${rows.length}.`);
}

const asFineTuneRow = (row: ReviewedJudgment) => ({
  messages: [
    { role: 'system', content: arenaJudgeInstructions(row.kind) },
    { role: 'user', content: JSON.stringify({
      rubricVersion: ARENA_JUDGE_TRAINING_VERSION,
      kind: row.kind,
      task: row.task,
      submission: row.submission,
      validatedEvidence: row.validatedEvidence,
      deterministicChecks: row.deterministicChecks
    }) },
    { role: 'assistant', content: JSON.stringify(row.label) }
  ]
});

const train: ReviewedJudgment[] = [];
const evaluation: ReviewedJudgment[] = [];
for (const row of rows) {
  const bucket = Number.parseInt(sha256(row.id).slice(0, 8), 16) % 100;
  (bucket < 15 ? evaluation : train).push(row);
}
if (rows.length > 1 && !evaluation.length) evaluation.push(train.pop()!);
if (rows.length > 1 && !train.length) train.push(evaluation.pop()!);
await mkdir(outputDir, { recursive: true });
const encode = (items: ReviewedJudgment[]) => `${items.map((row) => JSON.stringify(asFineTuneRow(row))).join('\n')}\n`;
const trainText = encode(train);
const evalText = encode(evaluation);
await Promise.all([
  writeFile(resolve(outputDir, 'train.jsonl'), trainText, 'utf8'),
  writeFile(resolve(outputDir, 'eval.jsonl'), evalText, 'utf8'),
  writeFile(resolve(outputDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    trainingVersion: ARENA_JUDGE_TRAINING_VERSION,
    source: 'PACT_HUMAN_REVIEWED_JUDGMENTS',
    counts: { total: rows.length, train: train.length, eval: evaluation.length },
    hashes: { source: sha256(raw), train: sha256(trainText), eval: sha256(evalText) },
    rubricDocuments: [...new Set(rows.flatMap((row) => row.docRefs))],
    policies: { humanApprovalRequired: true, secretsRejected: true, deterministicCorrectnessExcluded: true }
  }, null, 2), 'utf8')
]);
console.log(`Prepared ${train.length} training and ${evaluation.length} evaluation judgments in ${outputDir}`);
