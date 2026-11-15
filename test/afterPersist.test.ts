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
  assert.equal(env.sent.filter((m) => m.to === 'manager@example.com').length, 1, '承認依頼を送る');
  // v1.0.4 から、記録できなかったことを管理者にも知らせる（TC-082）
  assert.ok(env.sent.some((m) => m.to === 'admin@example.com' && /監査ログに記録できませんでした/.test(m.subject)));
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

test('TC-082 確定後に監査ログを記録できなかった場合は、申請IDと操作名を管理者に知らせる', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const restore = failAuditFor(env, ['承認']);
  const res = quietly(() => env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(1)));
  restore();
  assert.equal(res.ok, true);
  const notice = env.sent.find((m) => m.to === 'admin@example.com' && /監査ログに記録できませんでした/.test(m.subject));
  assert.ok(notice, '管理者への知らせがある');
  assert.match(notice.subject, /REQ-20261115-0001/);
  assert.match(notice.body, /操作: 承認/);
  assert.match(notice.body, /実行者: manager@example\.com/);
  assert.ok(env.sent.some((m) => m.to === 'staff@example.com'), '申請者への結果通知も送る');
});

test('TC-083 排他制御の中の書き込みは、ロックを解放する前に flush で反映する', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  assert.deepEqual(env.events, ['acquire', 'flush', 'release'], '受付');
  env.events.length = 0;
  env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(1));
  assert.deepEqual(env.events, ['acquire', 'flush', 'release'], '承認');
  env.events.length = 0;
  env.user.active = '';
  env.ctx.handleReminders_({ triggerUid: env.timeTrigger.getUniqueId(), year: 2026, hour: 9 }, later(30));
  assert.deepEqual(env.events, ['acquire', 'flush', 'release'], '督促');
});

test('TC-084 承認の flush に失敗したら成功と返さず、管理者に照合を依頼する。再操作は状態に応じて判定される', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  env.flush.fail = true;
  const res = quietly(() => env.decideAs('manager@example.com', token, 'approve', '', later(1)));
  env.flush.fail = false;
  assert.equal(res.ok, false);
  assert.match(res.message, /保存できたか確認できませんでした/);
  assert.deepEqual(env.events.slice(-2), ['flush', 'release'], '失敗しても解放する');
  assert.ok(env.audit().some((r) => r[2] === '保存確認' && r[5] === 'FLUSH_FAILED'));
  const notice = env.sent.slice(-1)[0];
  assert.equal(notice.to, 'admin@example.com');
  assert.match(notice.subject, /保存を確認できませんでした REQ-20261115-0001/);
  assert.ok(!env.sent.some((m) => m.to === 'staff@example.com'), '結果の通知は送らない');
  // 偽物では書き込みが即時に反映されるため「反映済みだった」場合を再現している。同じリンクは処理済みとして扱われる
  const again = env.decideAs('manager@example.com', token, 'approve', '', later(2));
  assert.equal(again.ok, false);
  assert.match(again.message, /処理済み/);
});

test('TC-085 申請受付の flush に失敗したら受付失敗として管理者に知らせ、承認依頼は送らない', () => {
  const env = createEnv();
  env.flush.fail = true;
  const id = quietly(() => env.submitForm(formRow(), T0));
  env.flush.fail = false;
  assert.equal(id, null);
  assert.ok(env.audit().some((r) => r[2] === '受付' && r[5] === 'FLUSH_FAILED'));
  const notice = env.sent.slice(-1)[0];
  assert.equal(notice.to, 'admin@example.com');
  assert.match(notice.body, /FLUSH_FAILED/);
  assert.ok(!env.sent.some((m) => m.to === 'manager@example.com'));
});
