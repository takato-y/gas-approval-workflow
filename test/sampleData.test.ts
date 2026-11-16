/**
 * sampleData.test.ts
 * サンプルデータ作成コマンド（tools/）のテスト。作ったデータを GAS 側の処理に通して整合も確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEADERS, formRows, employeeRows, csvCell, toCsv, buildSampleFiles } from '../tools/sample-data.ts';
import { main } from '../tools/generate-sample-data.ts';
import { loadGas } from './helpers/loadGas.ts';
import { createEnv } from './helpers/env.ts';

const START = Date.parse('2026-11-16T09:00:00+09:00');
const base = { count: 20, seed: 42, startMs: START, withInvalid: false };

test('TC-064 同じ種なら同じデータ、違う種なら違うデータになる', () => {
  assert.deepEqual(formRows(base), formRows(base));
  assert.notDeepEqual(formRows(base), formRows({ ...base, seed: 7 }));
  assert.equal(formRows(base).length, 20);
});

test('TC-065 作ったフォーム回答は GAS の受付処理を通り、境界の金額を含み、不正な行は拒否される', () => {
  const rows = formRows({ ...base, withInvalid: true });
  const amounts = rows.map((r) => Number(r[5]));
  for (const b of [49999, 50000, 99999, 100000]) assert.ok(amounts.includes(b), '境界の金額 ' + b);
  const env = createEnv();
  const results = rows.map((r) => env.submitForm(r, new Date(START)));
  assert.equal(results.filter((x) => x !== null).length, 20, '有効な20件はすべて受付');
  assert.equal(results.slice(-2).filter((x) => x === null).length, 2, '不正な2件は拒否');
  const twoStep = env.requests().filter((r) => r[10] === 2).length;
  assert.equal(twoStep, amounts.slice(0, 20).filter((a) => a >= 100000).length, '10万円以上は2段承認');
});

test('TC-066 CSV の見出しは GAS 側のシート定義と一致する', () => {
  const gasHeaders = loadGas().get('SHEET_HEADERS');
  assert.deepEqual([...HEADERS.requests], Array.from(gasHeaders['申請一覧']));
  assert.deepEqual([...HEADERS.tokens], Array.from(gasHeaders['承認トークン']));
  assert.deepEqual([...HEADERS.audit], Array.from(gasHeaders['監査ログ']));
  assert.deepEqual([...HEADERS.employees], Array.from(gasHeaders['社員名簿']));
  // 社員名簿のサンプルには、フォームの回答のサンプルに出てくる申請者がすべて載っている
  const roster = new Set(employeeRows().map((r) => String(r[0])));
  for (const r of formRows(base)) assert.ok(roster.has(String(r[1])), '名簿に無い申請者: ' + r[1]);
});

test('TC-067 CSV のエスケープ: 区切り・引用符・改行は引用符で囲み、数式になる先頭文字は無効化する', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('1行目\n2行目'), '"1行目\n2行目"');
  assert.equal(csvCell('=SUM(A1:A3)'), "'=SUM(A1:A3)");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell(-5), '-5', '数値の負数はそのまま');
  assert.equal(toCsv(['a', 'b'], [[1, 'x']], true), '﻿a,b\r\n1,x\r\n');
});

test('TC-068 コマンド: 7つの CSV を出力し、メールアドレスは example.com だけ。不正な引数はエラー終了', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-data-'));
  const quiet = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(main(['--out', out, '--count', '5', '--seed', '3', '--with-invalid']), 0);
    const files = fs.readdirSync(out).sort();
    assert.deepEqual(files, Object.keys(buildSampleFiles({ ...base, threshold: 1, bom: false })).sort());
    const all = files.map((f) => fs.readFileSync(path.join(out, f), 'utf8')).join('\n');
    const emails = all.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [];
    assert.ok(emails.length > 0);
    assert.deepEqual(emails.filter((e) => !e.endsWith('@example.com')), []);
    assert.equal(fs.readFileSync(path.join(out, 'フォームの回答 1.csv'), 'utf8').trim().split('\r\n').length, 1 + 5 + 2);
    assert.equal(main(['--count', '0', '--out', out]), 1);
    assert.equal(main(['--count', 'abc', '--out', out]), 1);
    assert.equal(main(['--unknown']), 2);
  } finally {
    console.log = quiet.log;
    console.error = quiet.error;
    fs.rmSync(out, { recursive: true, force: true });
  }
});
