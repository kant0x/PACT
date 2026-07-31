import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(packageRoot, 'dist', 'schema.sql');
await mkdir(dirname(output), { recursive: true });
await copyFile(resolve(packageRoot, 'src', 'schema.sql'), output);
