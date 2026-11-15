/**
 * reminder.test.ts
 * FN-008 督促対象の選定・FN-009 督促の実行のテスト。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGas } from './helpers/loadGas.ts';
import { createEnv, formRow, type Env } from './helpers/env.ts';

const T0 = new Date('2026-11-15T09:00:00+09:00');
const later = (h: number) => new Date(T0.getTime() + h * 3600 * 1000);
const SETTINGS = { remindAfterHours: 24, maxReminders: 3 };
const COL = { STATUS: 8, LAST: 12, COUNT: 13 };

const { ctx, get } = loadGas();
const S = get('STATUS');
const item = (id: string, over: Record<string, unknown> = {}) => ({
  rowNumber: 2,
  request: Object.assign({ id, status: S.PENDING, lastNotifiedAt: T0, reminderCount: 0 }, over),
});
/** vm 内で作られた配列を Node 側の配列にしてから比較する */
const ids = (xs: Array<{ request: { id: string } }>) => Array.from(xs, (x) => x.request.id);

/** 時間主導トリガーと同じ形のイベントで督促を実行する */
function runReminders(env: Env, at: Date) {
  return env.ctx.handleReminders_({ triggerUid: env.timeTrigger.getUniqueId(), year: at.getFullYear(), hour: at.getHours(), authMode: 'FULL' }, at);
}

test('TC-053 督促対象の選定: 最後の通知から督促開始時間ちょうどで対象、1ミリ秒前は対象外（境界値）', () => {
  const items = [item('A')];
  assert.deepEqual(ids(ctx.selectReminders_(items, T0.getTime() + 24 * 3600 * 1000 - 1, SETTINGS).remind), []);
  assert.deepEqual(ids(ctx.selectReminders_(items, T0.getTime() + 24 * 3600 * 1000, SETTINGS).remind), ['A']);
});

test('TC-054 督促対象の選定: 処理済みは対象外、上限到達は管理者通知に1回だけ回す', () => {
  const now = later(48).getTime();
  const res = ctx.selectReminders_([
    item('pending0'),
    item('pending2', { reminderCount: 2 }),
    item('reached', { reminderCount: 3 }),
    item('escalated', { reminderCount: 4 }),
    item('approved', { status: S.APPROVED }),
    item('rejected', { status: S.REJECTED }),
  ], now, SETTINGS);
  assert.deepEqual(ids(res.remind), ['pending0', 'pending2']);
  assert.deepEqual(ids(res.escalate), ['reached']);
});

test('TC-055 督促対象の選定: 最終通知日時が読めない申請は止めずに督促する', () => {
  const res = ctx.selectReminders_([item('broken', { lastNotifiedAt: '' }), item('text', { lastNotifiedAt: 'not a date' })], T0.getTime(), SETTINGS);
  assert.deepEqual(ids(res.remind), ['broken', 'text']);
});

test('TC-056 督促の実行: 古いリンクを失効させて新しいリンクを送り、督促回数を増やす', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const oldToken = env.tokenFor('manager@example.com');
  assert.deepEqual(JSON.parse(JSON.stringify(runReminders(env, later(23)))), { reminded: 0, escalated: 0, failed: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(runReminders(env, later(24)))), { reminded: 1, escalated: 0, failed: 0 });
  const mail = env.sent.slice(-1)[0];
  assert.equal(mail.to, 'manager@example.com');
  assert.match(mail.subject, /督促1回目/);
  const newToken = env.tokenFor('manager@example.com');
  assert.notEqual(newToken, oldToken);
  assert.equal(env.requests()[0][COL.COUNT], 1);
  assert.deepEqual(env.tokens().map((t) => t[7]), ['失効', '有効']);
  assert.equal(env.decideAs('manager@example.com', oldToken, 'approve', '', later(25)).ok, false, '古いリンクは使えない');
  assert.equal(env.audit().slice(-1)[0][5], 'TOKEN_REVOKED');
  assert.equal(env.decideAs('manager@example.com', newToken, 'approve', '', later(25)).ok, true);
});

test('TC-057 督促の実行: 上限回数を超えたら管理者に1回だけ知らせる', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  for (let i = 1; i <= 3; i++) runReminders(env, later(24 * i));
  assert.equal(env.requests()[0][COL.COUNT], 3);
  const res = runReminders(env, later(96));
  assert.equal(res.escalated, 1);
  const notice = env.sent.slice(-1)[0];
  assert.equal(notice.to, 'admin@example.com');
  assert.match(notice.body, /REQ-20261115-0001/);
  assert.equal(env.requests()[0][COL.COUNT], 4);
  const mails = env.sent.length;
  runReminders(env, later(200));
  assert.equal(env.sent.length, mails, '管理者への知らせを繰り返さない');
  assert.deepEqual(env.audit().filter((r) => r[2] === '管理者通知').length, 1);
});

test('TC-058 督促はトリガー以外から呼べない（イベント情報の検証）', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const bad = [
    undefined,
    {},
    { triggerUid: 'forged', year: 2026, hour: 9 },
    { triggerUid: env.formTrigger.getUniqueId(), year: 2026, hour: 9 }, // 別の関数のトリガー
    { triggerUid: env.timeTrigger.getUniqueId() }, // 時間主導トリガーの項目が無い
  ];
  for (const e of bad) {
    assert.throws(() => env.ctx.sendReminders(e), { code: 'UNTRUSTED_CALLER' });
  }
  assert.equal(env.sent.length, 1, '承認依頼の1通以外は送っていない');
  assert.equal(env.audit().slice(-1)[0][2], '拒否');
});

test('TC-059 督促の実行: 1件の失敗で他の申請の督促を止めない', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  env.submitForm(formRow({ item: '椅子' }), T0);
  // 1件目の承認経路を壊す（手作業でシートを書き換えた場合を再現）
  env.sheet('申請一覧').rows[1][11] = '[]';
  const res = runReminders(env, later(24));
  assert.deepEqual(JSON.parse(JSON.stringify(res)), { reminded: 1, escalated: 0, failed: 1 });
  assert.equal(env.requests()[1][COL.COUNT], 1);
  assert.equal(env.lock.acquired, env.lock.released);
});

test('TC-060 初期設定でフォーム送信と督促（1時間ごと）の2つのトリガーを登録する', () => {
  const env = createEnv();
  env.user.active = 'admin@example.com';
  env.ctx.setupProject();
  env.ctx.setupProject();
  const kinds = env.scriptApp.triggers.map((t) => t.getHandlerFunction() + ':' + t.kind).sort();
  assert.deepEqual(kinds, ['onFormSubmit:formSubmit', 'sendReminders:time']);
});
