import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import OpenAI from 'openai';

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) throw new Error('OPENAI_API_KEY is required to create a fine-tuning job');
const repoRoot = resolve(import.meta.dirname, '../../..');
const dataDir = resolve(repoRoot, process.env.ARENA_JUDGE_DATA_DIR ?? 'training/data/arena-judge');
const trainPath = resolve(dataDir, 'train.jsonl');
const evalPath = resolve(dataDir, 'eval.jsonl');
await Promise.all([access(trainPath), access(evalPath)]);
const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 });
const [trainingFile, validationFile] = await Promise.all([
  client.files.create({ file: createReadStream(trainPath), purpose: 'fine-tune' }),
  client.files.create({ file: createReadStream(evalPath), purpose: 'fine-tune' })
]);
const job = await client.fineTuning.jobs.create({
  model: process.env.ARENA_JUDGE_BASE_MODEL ?? 'gpt-4o-mini-2024-07-18',
  training_file: trainingFile.id,
  validation_file: validationFile.id,
  suffix: 'pact-arena-judge',
  method: { type: 'supervised' }
});
console.log(JSON.stringify({ jobId: job.id, status: job.status, trainingFile: trainingFile.id, validationFile: validationFile.id }, null, 2));
console.log('After the job succeeds, set ARENA_JUDGE_MODEL to the returned ft: model id and run arena:judge:eval before deployment.');
