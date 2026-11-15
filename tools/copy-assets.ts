/**
 * copy-assets.ts
 * TypeScript 以外の GAS 用ファイル（appsscript.json・*.html）を dist/ に写す。
 * clasp は dist/ をそのまま push するため、ビルドの最後に実行する。
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

mkdirSync(dist, { recursive: true });
const copied = readdirSync(src).filter((name) => name === 'appsscript.json' || name.endsWith('.html'));
for (const name of copied) copyFileSync(join(src, name), join(dist, name));
console.log('copied: ' + copied.join(', '));
