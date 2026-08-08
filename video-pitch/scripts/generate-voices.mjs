import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const project = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pact-tts-'));

function loadLines(file) {
  return JSON.parse(fs.readFileSync(path.join(project, file), 'utf8')).lines;
}

function writeTempText(id, text) {
  const file = path.join(tempDir, `${id}.txt`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function generateEnglish() {
  const outputDir = path.join(project, 'assets', 'voice-en');
  fs.mkdirSync(outputDir, { recursive: true });
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const request = JSON.parse(fs.readFileSync(path.join(project, 'audio_request.json'), 'utf8'));
  for (const line of request.lines) {
    const input = writeTempText(`en-${line.id}`, line.text);
    const output = path.join(outputDir, `${line.id}.wav`);
    execFileSync(npx, [
      '--yes', 'hyperframes@0.7.90', 'tts',
      '--text-file', input,
      '--voice', request.voice,
      '--speed', request.speed,
      '--output', output,
    ], { cwd: project, stdio: 'inherit' });
  }
}

function generateRussian() {
  const outputDir = path.join(project, 'assets', 'voice-ru');
  fs.mkdirSync(outputDir, { recursive: true });
  const request = JSON.parse(fs.readFileSync(path.join(project, 'audio_request_ru.json'), 'utf8'));
  const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  for (const line of request.lines) {
    const output = path.join(outputDir, `${line.id}.mp3`);
    execFileSync(python, [
      '-m', 'edge_tts', '--voice', request.voice,
      '--rate', request.rate, '--text', line.text, '--write-media', output
    ], { cwd: project, stdio: 'inherit' });
  }
}

generateEnglish();
generateRussian();
console.log(`Generated bilingual voice assets in ${path.join(project, 'assets')}`);
