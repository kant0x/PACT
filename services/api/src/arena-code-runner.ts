import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import type { CodePrivateInstance } from './arena.js';

export interface ArenaCodeTestResult {
  name: string;
  hidden: boolean;
  passed: boolean;
  detail: string;
}

export interface ArenaCodeRunResult {
  runner: string;
  available: boolean;
  policyPassed: boolean;
  tests: ArenaCodeTestResult[];
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface ArenaCodeRunner {
  describe(): { provider: string; isolation: string; available: boolean | null };
  evaluate(instance: CodePrivateInstance, files: Record<string, string>): Promise<ArenaCodeRunResult>;
}

const FORBIDDEN_SOURCE = /(?:\bimport\s|\brequire\s*\(|\bprocess\s*\.|\bchild_process\b|\bnode:|\bfetch\s*\(|\bWebSocket\b|\bDeno\b|\bBun\b)/;
const RESULT_PREFIX = 'PACT_ARENA_RESULT=';

const buildHarness = (instance: CodePrivateInstance) => `
const tests = ${JSON.stringify(instance.tests)};
const results = [];
try {
  const module = await import('./index.mjs');
  const target = module[${JSON.stringify(instance.functionName)}];
  if (typeof target !== 'function') throw new Error('Required named export ${instance.functionName} is missing');
  for (const test of tests) {
    try {
      const actual = await target(...test.args);
      const passed = typeof test.expected === 'number' && typeof actual === 'number'
        ? Number.isFinite(actual) && Math.abs(actual - test.expected) <= 1e-9
        : JSON.stringify(actual) === JSON.stringify(test.expected);
      results.push({ name: test.name, hidden: test.hidden, passed, detail: passed ? 'passed' : 'unexpected result' });
    } catch (error) {
      results.push({ name: test.name, hidden: test.hidden, passed: false, detail: String(error?.message ?? error).slice(0, 180) });
    }
  }
} catch (error) {
  for (const test of tests) results.push({ name: test.name, hidden: test.hidden, passed: false, detail: String(error?.message ?? error).slice(0, 180) });
}
console.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(results));
`;

const spawnCaptured = (command: string, args: string[], timeoutMs: number) => new Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>((resolvePromise, reject) => {
  const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  child.stdout.on('data', (chunk) => { if (stdout.length < 32_000) stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { if (stderr.length < 32_000) stderr += String(chunk); });
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolvePromise({ code, stdout, stderr, timedOut });
  });
});

export class DockerArenaCodeRunner implements ArenaCodeRunner {
  private availability: boolean | null = null;

  constructor(
    private readonly image = process.env.PACT_ARENA_RUNNER_IMAGE ?? 'node:22-bookworm-slim',
    private readonly timeoutMs = Number(process.env.PACT_ARENA_RUNNER_TIMEOUT_MS ?? 8_000)
  ) {}

  describe() {
    return {
      provider: `docker:${this.image}`,
      isolation: 'network=none, read-only root, non-root user, CPU/memory/PID limits, read-only challenge mount',
      available: this.availability
    };
  }

  async evaluate(instance: CodePrivateInstance, files: Record<string, string>): Promise<ArenaCodeRunResult> {
    const source = files?.['index.mjs'];
    if (typeof source !== 'string' || source.length < 1 || source.length > 50_000 || source.includes('\0')) {
      return {
        runner: `docker:${this.image}`, available: true, policyPassed: false, tests: [], durationMs: 0,
        stdout: '', stderr: 'Submit exactly one bounded index.mjs source file.'
      };
    }
    if (Object.keys(files).length !== 1 || FORBIDDEN_SOURCE.test(source)) {
      return {
        runner: `docker:${this.image}`, available: true, policyPassed: false, tests: [], durationMs: 0,
        stdout: '', stderr: 'Source policy rejected imports, process access, networking, or additional files.'
      };
    }

    const root = resolve(tmpdir());
    const workdir = await mkdtemp(`${root}${sep}pact-arena-`);
    const resolvedWorkdir = resolve(workdir);
    if (!resolvedWorkdir.startsWith(`${root}${sep}`)) throw new Error('Arena runner temp directory escaped the OS temp root');
    const started = Date.now();
    try {
      await Promise.all([
        writeFile(resolve(workdir, 'index.mjs'), source, { encoding: 'utf8', flag: 'wx' }),
        writeFile(resolve(workdir, 'tests.mjs'), buildHarness(instance), { encoding: 'utf8', flag: 'wx' })
      ]);
      let processResult: Awaited<ReturnType<typeof spawnCaptured>>;
      const containerName = `pact-arena-${randomUUID()}`;
      try {
        const created = await spawnCaptured('docker', [
          'create', '--name', containerName, '--network', 'none', '--read-only', '--user', '65534:65534',
          '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64',
          '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
          '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
          this.image, 'node', '--disable-proto=throw', '/workspace/tests.mjs'
        ], this.timeoutMs);
        if (created.code !== 0) throw new Error(created.stderr || 'docker create failed');
        const copied = await spawnCaptured('docker', ['cp', `${resolvedWorkdir}${sep}.`, `${containerName}:/workspace`], this.timeoutMs);
        if (copied.code !== 0) throw new Error(copied.stderr || 'docker cp failed');
        processResult = await spawnCaptured('docker', ['start', '--attach', containerName], this.timeoutMs);
        this.availability = true;
      } catch (error) {
        this.availability = false;
        const message = error instanceof Error ? error.message : 'Docker runner unavailable';
        const unavailable = new Error(`ARENA_SANDBOX_UNAVAILABLE: ${message}`);
        unavailable.name = 'ArenaSandboxUnavailableError';
        throw unavailable;
      } finally {
        await spawnCaptured('docker', ['rm', '--force', containerName], 3_000).catch(() => undefined);
      }
      const resultLine = processResult.stdout.split(/\r?\n/).find((line) => line.startsWith(RESULT_PREFIX));
      let tests: ArenaCodeTestResult[] = [];
      if (resultLine) {
        try {
          const parsed = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
          if (Array.isArray(parsed)) tests = parsed;
        } catch {
          tests = [];
        }
      }
      if (processResult.timedOut) {
        tests = instance.tests.map((test) => ({ name: test.name, hidden: test.hidden, passed: false, detail: 'execution timed out' }));
      } else if (tests.length !== instance.tests.length) {
        tests = instance.tests.map((test) => ({ name: test.name, hidden: test.hidden, passed: false, detail: 'runner did not return a complete test receipt' }));
      }
      return {
        runner: `docker:${this.image}`,
        available: true,
        policyPassed: processResult.code === 0 && !processResult.timedOut,
        tests,
        durationMs: Date.now() - started,
        stdout: processResult.stdout.slice(0, 4_000),
        stderr: processResult.stderr.slice(0, 4_000)
      };
    } finally {
      await rm(resolvedWorkdir, { recursive: true, force: true });
    }
  }
}
