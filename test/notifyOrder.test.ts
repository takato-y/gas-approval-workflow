/**
 * notifyOrder.test.ts
 * 記録を flush で確定してからメールを送る順序のテスト。
 * 受付（FN-001）・2段目へ進む確定（FN-006）の承認依頼と、督促（FN-009）の督促・管理者通知が対象。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, formRow, type Env } from './helpers/env.ts';
import type { Cell, FakeRange } from './helpers/fakes.ts';

const T0 = new Date('2026-11-15T09:00:00+09:00');
const later = (h: number) => new Date(T0.getTime() + h * 3600 * 1000);
const COL = { STATUS: 8, STEP: 9, LAST: 12, COUNT: 13 };

/** 時間主導トリガーと同じ形で督促を実行する（トリガーからの実行では操作者は空とする） */
function runReminders(env: Env, at: Date) {
  env.user.active = '';
  return env.ctx.handleReminders_({ triggerUid: env.timeTrigger.getUniqueId(), year: at.getFullYear(), hour: at.getHours() }, at);
}

/** console.error を一時的に黙らせて fn を実行する */
function quietly<T>(fn: () => T): T {
  const saved = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = saved; }
}

/**
 * events に次を記録する: 申請一覧への書き込み（req）・承認トークンへの行の追加（token）・メール送信（mail）。
 * ロックの取得・flush・解放は偽物が記録する。
 */
function recordWrites(env: Env): void {
  const req = env.sheet('申請一覧');
  const reqAppend = req.appendRow.bind(req);
  req.appendRow = (row: Cell[]) => { env.events.push('req'); return reqAppend(row); };
  const reqGetRange = req.getRange.bind(req);
  req.getRange = (row: number, col: number, numRows?: number, numCols?: number) => {
    const range: FakeRange = reqGetRange(row, col, numRows, numCols);
    const setValues = range.setValues.bind(range);
    range.setValues = (values: Cell[][]) => { env.events.push('req'); return setValues(values); };
    return range;
  };
  const tokens = env.sheet('承認トークン');
  const tokenAppend = tokens.appendRow.bind(tokens);
  tokens.appendRow = (row: Cell[]) => { env.events.push('token'); return tokenAppend(row); };
  const mailApp = env.ctx.MailApp as { sendEmail(m: unknown): void };
  const send = mailApp.sendEmail.bind(mailApp);
  mailApp.sendEmail = (m: unknown) => { env.events.push('mail'); send(m); };
}

test('TC-092 受付: 承認依頼のトークン行は排他制御の中で記録して flush で確定し、ロックを解放してから送る', () => {
  const env = createEnv();
  recordWrites(env);
  env.submitForm(formRow(), T0);
  assert.deepEqual(env.events, ['acquire', 'req', 'token', 'flush', 'release', 'mail']);
  // 確定に失敗したら承認依頼は送らず、受付失敗として管理者に照合を依頼する（既存の FLUSH_FAILED の扱い）
  const fail = createEnv();
  fail.flush.fail = true;
  const id = quietly(() => fail.submitForm(formRow(), T0));
  fail.flush.fail = false;
  assert.equal(id, null);
  assert.ok(!fail.sent.some((m) => m.to === 'manager@example.com'), '承認依頼を送らない');
  assert.match(fail.sent.slice(-1)[0].body, /FLUSH_FAILED/);
});

test('TC-093 2段目へ進む確定: 次の承認者のトークン行を排他制御の中で確定してから送る。確定できなければ送らない', () => {
  const env = createEnv();
  env.submitForm(formRow({ amount: '150000' }), T0);
  const t1 = env.tokenFor('director@example.com');
  recordWrites(env);
  env.events.length = 0;
  const res = env.decideAs('director@example.com', t1, 'approve', '', later(1));
  assert.equal(res.ok, true);
  assert.deepEqual(env.events, ['acquire', 'req', 'token', 'flush', 'release', 'mail']);
  assert.equal(env.decideAs('cfo@example.com', env.tokenFor('cfo@example.com'), 'approve', '', later(2)).ok, true);

  const fail = createEnv();
  fail.submitForm(formRow({ amount: '150000' }), T0);
  const t = fail.tokenFor('director@example.com');
  fail.flush.fail = true;
  const r = quietly(() => fail.decideAs('director@example.com', t, 'approve', '', later(1)));
  fail.flush.fail = false;
  assert.equal(r.ok, false);
  assert.match(r.message, /保存できたか確認できませんでした/);
  assert.ok(!fail.sent.some((m) => m.to === 'cfo@example.com'), '次の承認者には送らない');
  assert.ok(fail.sent.some((m) => m.to === 'admin@example.com' && /保存を確認できませんでした/.test(m.subject)), '管理者に照合を依頼する');
});

test('TC-094 督促の管理者通知: 督促回数（上限＋1）を flush で確定してから送る。送れなければ回数を戻して次の見回りで再び試す', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  env.sheet('申請一覧').rows[1][COL.COUNT] = 3;
  recordWrites(env);
  env.events.length = 0;
  const res = runReminders(env, later(24));
  assert.equal(res.escalated, 1);
  assert.deepEqual(env.events, ['acquire', 'req', 'flush', 'mail', 'flush', 'release']);
  assert.equal(env.requests()[0][COL.COUNT], 4);

  const fail = createEnv();
  fail.submitForm(formRow(), T0);
  fail.sheet('申請一覧').rows[1][COL.COUNT] = 3;
  fail.mailFailTo.add('admin@example.com');
  const r = quietly(() => runReminders(fail, later(24)));
  assert.equal(r.failed, 1);
  assert.equal(fail.requests()[0][COL.COUNT], 3, '回数を戻す');
  fail.mailFailTo.delete('admin@example.com');
  const again = runReminders(fail, later(25));
  assert.equal(again.escalated, 1, '次の見回りで再び試す');
});

test('TC-095 督促: 督促回数・最終通知日時もトークン行と一緒に flush で確定してから送る。送れなければ戻す', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  recordWrites(env);
  env.events.length = 0;
  runReminders(env, later(24));
  assert.deepEqual(env.events, ['acquire', 'token', 'req', 'flush', 'mail', 'flush', 'release']);
  assert.equal(env.requests()[0][COL.COUNT], 1);

  const fail = createEnv();
  fail.submitForm(formRow(), T0);
  fail.mailFailTo.add('manager@example.com');
  const r = quietly(() => runReminders(fail, later(24)));
  assert.equal(r.failed, 1);
  assert.equal(fail.requests()[0][COL.COUNT], 0, '督促回数を戻す');
  assert.equal((fail.requests()[0][COL.LAST] as Date).getTime(), T0.getTime(), '最終通知日時を戻す');
});

test('TC-097 送れなかった承認依頼・督促の新しいトークンは失効させる（古いトークンは有効に戻さない）', () => {
  const TOKEN_STATUS_COL = 7;
  // 督促: 古いトークンは失効、送れなかった新しいトークンも失効
  const rem = createEnv();
  rem.submitForm(formRow(), T0);
  rem.mailFailTo.add('manager@example.com');
  quietly(() => runReminders(rem, later(24)));
  assert.deepEqual(rem.tokens().map((t) => t[TOKEN_STATUS_COL]), ['失効', '失効']);
  assert.equal(rem.lock.acquired, rem.lock.released);
  // 次の見回りで新しいリンクが送られ、それだけが有効になる
  rem.mailFailTo.delete('manager@example.com');
  assert.equal(runReminders(rem, later(25)).reminded, 1);
  assert.deepEqual(rem.tokens().map((t) => t[TOKEN_STATUS_COL]), ['失効', '失効', '有効']);

  // 受付: 送れなかった承認依頼のトークンを失効させる（排他制御の中で書き、解放前に flush する）
  const sub = createEnv();
  sub.mailFailTo.add('manager@example.com');
  const id = quietly(() => sub.submitForm(formRow(), T0));
  assert.equal(id, 'REQ-20261115-0001', '登録は取り消さない');
  assert.deepEqual(sub.tokens().map((t) => t[TOKEN_STATUS_COL]), ['失効']);
  assert.deepEqual(sub.events.slice(-3), ['acquire', 'flush', 'release']);

  // 2段目へ進む確定: 送れなかった次の承認者のトークンを失効させる（確定は取り消さない）
  const dec = createEnv();
  dec.submitForm(formRow({ amount: '150000' }), T0);
  dec.mailFailTo.add('cfo@example.com');
  const res = quietly(() => dec.decideAs('director@example.com', dec.tokenFor('director@example.com'), 'approve', '', later(1)));
  assert.equal(res.ok, true);
  assert.equal(dec.requests()[0][COL.STEP], 2);
  assert.deepEqual(dec.tokens().map((t) => t[TOKEN_STATUS_COL]), ['使用済み', '失効']);
});
