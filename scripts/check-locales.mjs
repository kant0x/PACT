import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'frontend', 'src');
const localeRoot = path.join(root, 'frontend', 'public', 'locales');
const sourceFiles = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(filePath);
    else if (/\.(?:tsx?|jsx?)$/.test(entry.name)) sourceFiles.push(filePath);
  }
}

walk(sourceRoot);

const keys = new Set();
for (const filePath of sourceFiles) {
  const source = fs.readFileSync(filePath, 'utf8');
  for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) keys.add(match[1]);
}

let failed = false;
for (const locale of ['ru', 'es']) {
  const document = JSON.parse(fs.readFileSync(path.join(localeRoot, `${locale}.json`), 'utf8'));
  const missing = [...keys].filter((key) => !Object.prototype.hasOwnProperty.call(document.strings, key));
  if (missing.length) {
    failed = true;
    console.error(`${locale}: ${missing.length} missing translation keys`);
    for (const key of missing) console.error(`  - ${key}`);
  } else {
    console.log(`${locale}: ${keys.size} static UI keys covered`);
  }
}

if (failed) process.exitCode = 1;
