/**
 * designSync.test.ts
 * 督促（FN-009）の失敗の記録・トークン行の確定とメール送信の順序・設定不備時に古いリンクを失効させないこと、
 * 確認画面（FN-005）で状態の値の破損を INVALID_STATE にすることのテスト。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, formRow, type Env } from './helpers/env.ts';
import type { Cell } from './helpers/fakes.ts';

const T0 = new Date('2026-11-15T09:00:00+09:00');
const later = (h: number) => new Date(T0.getTime() + h * 3600 * 1000);
const COL = { STATUS: 8, COUNT: 13 };
const TOKEN_STATUS_COL = 7;

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

/** 督促の行（申請IDが空＝その回全体の失敗）を返す */
function runFailures(env: Env): Cell[][] {
  return env.audit().filter((r) => r[2] === '督促' && r[1] === '' && r[4] === '失敗');
}

/** メール送信も events に記録する（flush との前後を確かめるため） */
function recordMailEvents(env: Env): void {
  const mailApp = env.ctx.MailApp as { sendEmail(m: unknown): void };
  const original = mailApp.sendEmail.bind(mailApp);
  mailApp.sendEmail = (m: unknown) => { env.events.push('mail'); original(m); };
}

test('TC-087 督促: BUSY・INVALID_SETTING・FLUSH_FAILED は例外で終わらず、監査ログに「督促・失敗」を記録する', () => {
  // BUSY: 排他制御を取れない
  const busy = createEnv();
  busy.submitForm(formRow(), T0);
  busy.lock.held = true;
  const r1 = runReminders(busy, later(24));
  busy.lock.held = false;
  assert.equal(r1.error, 'BUSY');
  assert.equal(r1.reminded, 0);
  assert.deepEqual(runFailures(busy).map((r) => r[5]), ['BUSY']);
  assert.equal(busy.props.has('REMINDER_LAST_RUN_AT'), false, '実行済みにしない');

  // INVALID_SETTING: 設定を読めない（管理者の宛先も読めないため、管理者へのメールは届かない）
  const bad = createEnv();
  bad.submitForm(formRow(), T0);
  bad.sheet('設定').rows = bad.sheet('設定').rows.filter((r) => r[0] !== '管理者メール');
  const mails = bad.sent.length;
  const r2 = quietly(() => runReminders(bad, later(24)));
  assert.equal(r2.error, 'INVALID_SETTING');
  assert.deepEqual(runFailures(bad).map((r) => r[5]), ['INVALID_SETTING']);
  assert.equal(bad.sent.length, mails);
  assert.equal(bad.lock.acquired, bad.lock.released);

  // FLUSH_FAILED: 最後の反映の確認に失敗した。管理者に照合を依頼する
  const fl = createEnv();
  fl.submitForm(formRow(), T0);
  fl.submitForm(formRow({ amount: '150000' }), T0);
  fl.sheet('申請一覧').rows[2][13] = 3; // 2件目は督促上限に到達済み（管理者通知の対象）
  const flush = fl.flush;
  let calls = 0;
  const ss = fl.ctx.SpreadsheetApp as { flush(): void };
  const originalFlush = ss.flush.bind(ss);
  // 督促・管理者通知の1件ごとの flush（記録の確定）は通し、その回の最後の flush（3回目）だけ失敗させる
  ss.flush = () => { calls++; if (calls === 3) flush.fail = true; try { originalFlush(); } finally { flush.fail = false; } };
  const r3 = quietly(() => runReminders(fl, later(24)));
  assert.equal(r3.error, 'FLUSH_FAILED');
  assert.deepEqual(runFailures(fl).map((r) => r[5]), ['FLUSH_FAILED']);
  const notice = fl.sent.filter((m) => m.to === 'admin@example.com' && /督促の保存を確認できませんでした/.test(m.subject));
  assert.equal(notice.length, 1, '管理者に照合を依頼する');
  assert.deepEqual(fl.events.slice(-2), ['flush', 'release'], '失敗しても解放する');
});

test('TC-088 督促: その回の失敗を監査ログに記録できない場合は、管理者に知らせる', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const audit = env.sheet('監査ログ');
  const original = audit.appendRow.bind(audit);
  audit.appendRow = (row: Cell[]) => {
    if (row[2] === '督促') throw new Error('fake: append failed');
    return original(row);
  };
  env.lock.held = true;
  const res = quietly(() => runReminders(env, later(24)));
  env.lock.held = false;
  audit.appendRow = original;
  assert.equal(res.error, 'BUSY');
  const notice = env.sent.find((m) => m.to === 'admin@example.com' && /監査ログに記録できませんでした/.test(m.subject));
  assert.ok(notice, '管理者への知らせがある');
  assert.match(notice.body, /操作: 督促/);
  assert.match(notice.body, /詳細: BUSY/);
});

test('TC-089 督促: トークン行を flush で確定してからメールを送る。確定できなければ送らない', () => {
  // 順序: トークン行の確定（flush）→ メール送信 → ロックの解放
  const env = createEnv();
  env.submitForm(formRow(), T0);
  recordMailEvents(env);
  env.events.length = 0;
  runReminders(env, later(24));
  assert.deepEqual(env.events, ['acquire', 'flush', 'mail', 'flush', 'release']);
  assert.equal(env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(25)).ok, true);

  // flush に失敗したら、その申請の督促メールは送らない（届いたリンクが TOKEN_UNKNOWN にならない）
  const fail = createEnv();
  fail.submitForm(formRow(), T0);
  const before = fail.sent.filter((m) => m.to === 'manager@example.com').length;
  fail.flush.fail = true;
  const res = quietly(() => runReminders(fail, later(24)));
  fail.flush.fail = false;
  assert.equal(fail.sent.filter((m) => m.to === 'manager@example.com').length, before, '督促メールを送らない');
  assert.equal(res.failed, 1);
  assert.ok(fail.audit().some((r) => r[2] === '督促' && r[1] === 'REQ-20261115-0001' && r[4] === '失敗' && r[5] === 'FLUSH_FAILED'));
  assert.equal(fail.requests()[0][COL.COUNT], 0, '督促回数を増やさない（次の見回りで再び督促する）');
  assert.equal(fail.lock.acquired, fail.lock.released);
});

test('TC-090 督促: ウェブアプリの URL・鍵が不備なら、古いリンクを失効させずにその申請の督促を失敗にする', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const oldToken = env.tokenFor('manager@example.com');
  env.props.delete('WEBAPP_URL');
  const res = quietly(() => runReminders(env, later(24)));
  assert.equal(res.failed, 1);
  assert.deepEqual(env.tokens().map((t) => t[TOKEN_STATUS_COL]), ['有効'], '失効させず、新しい行も作らない');
  assert.ok(env.audit().some((r) => r[2] === '督促' && r[4] === '失敗' && r[5] === 'WEBAPP_URL_NOT_CONFIGURED'));
  assert.equal(env.requests()[0][COL.COUNT], 0);
  // 承認者の手元のリンクはそのまま使える
  assert.equal(env.decideAs('manager@example.com', oldToken, 'approve', '', later(25)).ok, true);

  // 鍵が未設定の場合も同じ（新しいリンクを作れないまま古いリンクを失効させない）
  const noKey = createEnv();
  noKey.submitForm(formRow(), T0);
  noKey.props.delete('APPROVAL_HMAC_SECRET');
  const r2 = quietly(() => runReminders(noKey, later(24)));
  assert.equal(r2.failed, 1);
  assert.deepEqual(noKey.tokens().map((t) => t[TOKEN_STATUS_COL]), ['有効']);
  assert.ok(noKey.audit().some((r) => r[2] === '督促' && r[4] === '失敗' && r[5] === 'SECRET_NOT_CONFIGURED'));
});

test('TC-091 確認画面・確定: 申請の状態の値が壊れていれば ALREADY_DECIDED ではなく INVALID_STATE にする', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  env.sheet('申請一覧').rows[1][COL.STATUS] = '承認まち'; // 手作業の書き換えで壊れた値
  const html = env.openAs('manager@example.com', token, later(1));
  assert.match(html, /このリンクは無効です/);
  assert.doesNotMatch(html, /既に処理済み/);
  assert.equal(env.audit().slice(-1)[0][2], '画面表示');
  assert.equal(env.audit().slice(-1)[0][5], 'INVALID_STATE');
  const res = env.decideAs('manager@example.com', token, 'approve', '', later(1));
  assert.equal(res.ok, false);
  assert.equal(env.audit().slice(-1)[0][5], 'INVALID_STATE');
  assert.equal(env.requests()[0][COL.STATUS], '承認まち', '状態は変えない');
  // 承認済み・却下は従来どおり ALREADY_DECIDED
  env.sheet('申請一覧').rows[1][COL.STATUS] = '承認済み';
  env.openAs('manager@example.com', token, later(1));
  assert.equal(env.audit().slice(-1)[0][5], 'ALREADY_DECIDED');
});

test('TC-096 現在段階の値が壊れている場合は、画面表示・確定とも STEP_MISMATCH。総段階の破損は確定で INVALID_STATE', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  env.sheet('申請一覧').rows[1][9] = 5; // 現在段階を範囲外に書き換える
  const html = env.openAs('manager@example.com', token, later(1));
  assert.match(html, /このリンクは無効です/);
  assert.equal(env.audit().slice(-1)[0][2], '画面表示');
  assert.equal(env.audit().slice(-1)[0][5], 'STEP_MISMATCH');
  assert.equal(env.decideAs('manager@example.com', token, 'approve', '', later(1)).ok, false);
  assert.equal(env.audit().slice(-1)[0][5], 'STEP_MISMATCH');
  // 現在段階が一致していても総段階が壊れていれば、確定では状態遷移の検査で INVALID_STATE になる
  env.sheet('申請一覧').rows[1][9] = 1;
  env.sheet('申請一覧').rows[1][10] = 3;
  const res = env.decideAs('manager@example.com', token, 'approve', '', later(1));
  assert.equal(res.ok, false);
  assert.equal(env.audit().slice(-1)[0][5], 'INVALID_STATE');
});
