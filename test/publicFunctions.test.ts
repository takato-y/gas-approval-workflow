/**
 * publicFunctions.test.ts
 * FN-012 公開関数の管理。GAS では末尾に `_` が無いトップレベルの関数は google.script.run から呼べる。
 * 公開関数が許可一覧から増減したら失敗させ、レビューなしに入口が増えるのを防ぐ。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SRC_DIR, DIST_DIR } from './helpers/loadGas.ts';

/** 公開してよい関数（docs/04_権限設計.md の公開関数一覧と同じ） */
const ALLOWED_PUBLIC = ['doGet', 'onFormSubmit', 'sendReminders', 'setupProject', 'submitDecision'];

function topLevelFunctions(dir: string, ext: string): string[] {
  const names: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(ext))) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*[(<]/gm)) names.push(m[1]);
  }
  return names;
}

test('TC-061 公開関数（末尾に _ が無い関数）は許可一覧の5つだけ', () => {
  for (const [dir, ext] of [[SRC_DIR, '.ts'], [DIST_DIR, '.js']] as const) {
    const pub = topLevelFunctions(dir, ext).filter((n) => !n.endsWith('_')).sort();
    assert.deepEqual(pub, ALLOWED_PUBLIC, dir);
  }
});

test('TC-062 トップレベルで関数を変数に代入して公開していない（宣言以外の公開経路が無い）', () => {
  for (const file of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(!/^(const|let|var)\s+\w+\s*=\s*(function|\()/m.test(src), file + ' にトップレベルの関数代入がある');
    assert.ok(!/globalThis\s*\.|this\s*\[/.test(src), file + ' にグローバルへの代入がある');
  }
});

test('TC-063 ソースに鍵・実在のメールアドレス・scriptId を書いていない', () => {
  for (const dir of [SRC_DIR]) {
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      const emails = src.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
      assert.deepEqual(emails.filter((e) => !e.endsWith('@example.com')), [], file);
      assert.ok(!/APPROVAL_HMAC_SECRET['"]?\s*[:=]\s*['"][^'"]{8,}/.test(src), file + ' に鍵の値がある');
      assert.ok(!/"scriptId"\s*:\s*"(?!YOUR_SCRIPT_ID)/.test(src), file);
    }
  }
});
