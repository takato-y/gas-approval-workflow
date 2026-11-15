/**
 * docsTrace.test.ts
 * 設計書のエラーID（ERR-xxx）と障害対応手順書の対応を検査する。
 * 詳細設計に出てくるエラーIDがすべて障害対応手順書の4章の見出しと7章の表にあり、
 * 障害対応手順書に詳細設計に無いエラーIDが無いことを確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const ERR_ID = /(?<![A-Za-z0-9_-])ERR-\d+(?![A-Za-z0-9_-])/g;

function read(name: string): string {
  return fs.readFileSync(path.join(DOCS, name), 'utf8');
}

/** 「## n.」で始まる章の本文を返す（次の「## 」の手前まで） */
function chapter(text: string, no: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ' + no + '.'));
  assert.ok(start >= 0, no + '章が見つかりません');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

function ids(text: string): Set<string> {
  return new Set(text.match(ERR_ID) || []);
}

test('TC-086 詳細設計のエラーIDはすべて障害対応手順書の4章の見出しと7章の表にあり、手順書に設計書に無いエラーIDが無い', () => {
  const design = ids(read('03_詳細設計.md'));
  const runbook = read('07_障害対応手順書.md');
  assert.ok(design.size > 0, '詳細設計にエラーIDがありません');

  const headings = new Set(
    chapter(runbook, 4).split('\n')
      .map((l) => /^### (ERR-\d+) /.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]),
  );
  const table = new Set(
    chapter(runbook, 7).split('\n')
      .map((l) => /^\| (ERR-\d+) \|/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]),
  );

  const missingHeading = [...design].filter((id) => !headings.has(id));
  const missingTable = [...design].filter((id) => !table.has(id));
  const extra = [...ids(runbook)].filter((id) => !design.has(id));
  assert.deepEqual(missingHeading, [], '4章に見出しの無いエラーID');
  assert.deepEqual(missingTable, [], '7章の表に無いエラーID');
  assert.deepEqual(extra, [], '詳細設計に無いエラーID');
});
