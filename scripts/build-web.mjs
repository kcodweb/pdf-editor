// Copies the static site into www/, the folder Capacitor packages into the Android app.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

rmSync(out, { recursive: true, force: true });
mkdirSync(out);

const topLevel = readdirSync(root).filter((name) => /\.(html|js|css)$/.test(name));
for (const name of topLevel) cpSync(join(root, name), join(out, name));
for (const dir of ['fonts', 'vendor']) cpSync(join(root, dir), join(out, dir), { recursive: true });

console.log(`Copied ${topLevel.length} files plus fonts/ and vendor/ into www/`);
