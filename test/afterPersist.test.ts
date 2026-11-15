/**
 * afterPersist.test.ts
 * 状態を保存した後の処理（監査ログの記録・トークンの更新・ロックの解放）が失敗しても、
 * 保存済みの成功を利用者向けの失敗に変えないことのテスト。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, formRow, type Env } from './helpers/env.ts';
import type { Cell } from './helpers/fakes.ts';

const T0 = new Date('2026-11-15T09:00:00+09:00');
const later = (h: number) => new Date(T0.getTime() + h * 3600 * 1000);
const COL = { STATUS: 8, STEP: 9 };
const TOKEN_STATUS_COL = 7;

/** 監査ログのうち、操作名が ops に含まれる行の追記だけを失敗させる。戻り値で元に戻す */
function failAuditFor(env: Env, ops: string[]): () => void {
  const audit = env.sheet('監査ログ');
  const original = audit.appendRow.bind(audit);
  audit.appendRow = (row: Cell[]) => {
    if (ops.includes(String(row[2]))) throw new Error('fake: append failed');
    return original(row);
  };
  return () => { audit.appendRow = original; };
}

/** console.error を一時的に黙らせて fn を実行する */
function quietly<T>(fn: () => T): T {
  const saved = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = saved; }
}

test('TC-078 承認の確定後に成功の監査ログを記録できなくても、確定済みの結果を返す', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const restore = failAuditFor(env, ['承認']);
  const res = quietly(() => env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(1)));
  restore();
  assert.equal(res.ok, true);
  assert.match(res.message, /承認しました。申請者に通知しました/);
  assert.equal(env.requests()[0][COL.STATUS], '承認済み');
  assert.equal(env.tokens()[0][TOKEN_STATUS_COL], '使用済み');
  assert.equal(env.sent.slice(-1)[0].to, 'staff@example.com');
  assert.ok(!env.audit().some((r) => r[2] === '拒否'));
  assert.equal(env.lock.acquired, env.lock.released);
});

test('TC-079 申請の登録後に受付の監査ログを記録できなくても、申請IDを返して承認依頼を送る', () => {
  const env = createEnv();
  const restore = failAuditFor(env, ['受付']);
  const id = quietly(() => env.submitForm(formRow(), T0));
  restore();
  assert.equal(id, 'REQ-20261115-0001');
  assert.equal(env.requests().length, 1);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].to, 'manager@example.com');
});

test('TC-080 状態の保存後にトークンを使用済みにできなくても確定し、残ったトークンの再利用は拒否する', () => {
  const env = createEnv();
  env.submitForm(formRow({ amount: '150000' }), T0);
  const t1 = env.tokenFor('director@example.com');
  const tokens = env.sheet('承認トークン');
  const originalGetRange = tokens.getRange.bind(tokens);
  tokens.getRange = (row: number, col: number, numRows?: number, numCols?: number) => {
    const range = originalGetRange(row, col, numRows, numCols);
    range.setValues = () => { throw new Error('fake: write failed'); };
    return range;
  };
  const res = quietly(() => env.decideAs('director@example.com', t1, 'approve', '', later(1)));
  tokens.getRange = originalGetRange;
  assert.equal(res.ok, true);
  assert.equal(env.requests()[0][COL.STEP], 2, '2段目へ進んでいる');
  assert.equal(env.tokens()[0][TOKEN_STATUS_COL], '有効', 'トークンは有効のまま残っている');
  assert.ok(env.audit().some((r) => r[2] === 'トークン更新' && r[4] === '失敗'));
  // 残ったトークンでは確認画面も確定も通らない
  assert.match(env.openAs('director@example.com', t1, later(2)), /操作できません/);
  const again = env.decideAs('director@example.com', t1, 'approve', '', later(2));
  assert.equal(again.ok, false);
  assert.equal(env.audit().slice(-1)[0][5], 'STEP_MISMATCH');
  // 最終承認者は新しいリンクで承認できる
  assert.equal(env.decideAs('cfo@example.com', env.tokenFor('cfo@example.com'), 'approve', '', later(3)).ok, true);
  assert.equal(env.requests()[0][COL.STATUS], '承認済み');
});

test('TC-081 ロックの解放に失敗しても、確定済みの結果を返す', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  env.lock.failRelease = true;
  const res = quietly(() => env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'reject', '予算外', later(1)));
  env.lock.failRelease = false;
  assert.equal(res.ok, true);
  assert.equal(env.requests()[0][COL.STATUS], '却下');
});
