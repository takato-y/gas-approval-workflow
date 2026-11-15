/**
 * reviewFixes.test.ts
 * v1.0.1 で追加した対策のテスト（入力の無害化・申請者ドメイン・督促の呼び出し元・通知失敗時の回復）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGas } from './helpers/loadGas.ts';
import { createEnv, formRow, SETTINGS_ROWS, type Env } from './helpers/env.ts';

const T0 = new Date('2026-11-15T09:00:00+09:00');
const later = (h: number) => new Date(T0.getTime() + h * 3600 * 1000);
const COL = { APPLICANT: 2, STATUS: 8, STEP: 9 };

/** 時間主導トリガーと同じ形で督促を実行する（トリガーからの実行では操作者は空とする） */
function runReminders(env: Env, at: Date) {
  env.user.active = '';
  return env.ctx.handleReminders_({ triggerUid: env.timeTrigger.getUniqueId(), year: at.getFullYear(), hour: at.getHours() }, at);
}

test('TC-069 数式として扱われる先頭文字のメールアドレスは受け付けず、シートへの書き込みでも無害化する', () => {
  const { ctx } = loadGas();
  for (const bad of ['=1+1@a.b', '+cmd@example.com', '-x@example.com', '@@example.com']) {
    assert.equal(ctx.isValidEmail_(bad), false, bad);
  }
  const env = createEnv();
  assert.equal(env.submitForm(formRow({ email: '=1+1@a.b' }), T0), null);
  assert.equal(env.requests().length, 0);
  assert.equal(env.audit().slice(-1)[0][5], 'INVALID_INPUT');
  // 万一、検査を通らない経路で書かれても数式にならない
  const row = ctx.requestToRow_({ id: 'x', applicant: '=HYPERLINK("x")', item: 'a', reason: 'b', route: [] });
  assert.equal(row[COL.APPLICANT], '\'=HYPERLINK("x")');
});

test('TC-070 申請者ドメインを設定すると、他のドメインからの申請を受け付けない', () => {
  const env = createEnv({ settingsRows: [...SETTINGS_ROWS, ['申請者ドメイン', '@Example.com']] });
  assert.equal(env.submitForm(formRow({ email: 'staff@example.com' }), T0), 'REQ-20261115-0001');
  assert.equal(env.submitForm(formRow({ email: 'manager@outside.example.net' }), T0), null);
  assert.equal(env.audit().slice(-1)[0][5], 'INVALID_APPLICANT');
  assert.equal(env.requests().length, 1);
  const bad = createEnv({ settingsRows: [...SETTINGS_ROWS, ['申請者ドメイン', 'not a domain']] });
  assert.equal(bad.submitForm(formRow(), T0), null);
  assert.equal(bad.audit().slice(-1)[0][5], 'INVALID_SETTING');
});

test('TC-071 督促: 正しい triggerUid を知っていても、ウェブアプリを開いた社員からの呼び出しは拒否する', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  env.user.active = 'manager@example.com'; // 実行権限の持ち主（admin）と異なる利用者
  const e = { triggerUid: env.timeTrigger.getUniqueId(), year: 2026, hour: 9 };
  assert.throws(() => env.ctx.sendReminders(e), { code: 'UNTRUSTED_CALLER' });
  assert.equal(env.sent.length, 1, '承認依頼の1通だけ');
  // トリガーからの実行（操作者が空、または実行権限の持ち主本人）は通る
  env.user.active = '';
  assert.equal(runReminders(env, later(24)).reminded, 1);
  env.user.active = 'admin@example.com';
  const e2 = { triggerUid: env.timeTrigger.getUniqueId(), year: 2026, hour: 9 };
  assert.equal(env.ctx.handleReminders_(e2, later(48)).reminded, 1);
});

test('TC-072 督促: 前回から30分未満の呼び出しは何もしない（督促を早めたり増やしたりしない）', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  env.submitForm(formRow({ item: '椅子' }), T0);
  assert.equal(runReminders(env, later(24)).reminded, 2);
  const mails = env.sent.length;
  const again = runReminders(env, new Date(later(24).getTime() + 29 * 60 * 1000));
  assert.equal(again.skipped, true);
  assert.equal(env.sent.length, mails);
  assert.equal(runReminders(env, new Date(later(24).getTime() + 30 * 60 * 1000)).skipped, undefined, '30分後は通常どおり');
});

test('TC-073 次の承認者への通知に失敗しても承認は確定し、管理者に知らせ、督促で回復する', () => {
  const env = createEnv();
  env.submitForm(formRow({ amount: '150000' }), T0);
  env.mailFailTo.add('cfo@example.com');
  const res = env.decideAs('director@example.com', env.tokenFor('director@example.com'), 'approve', '', later(1));
  assert.equal(res.ok, true, '承認自体は成功として返す');
  assert.match(res.message, /通知に失敗/);
  assert.equal(env.requests()[0][COL.STATUS], '承認待ち');
  assert.equal(env.requests()[0][COL.STEP], 2);
  assert.ok(env.audit().some((r) => r[2] === '通知' && r[4] === '失敗'));
  assert.equal(env.sent.slice(-1)[0].to, 'admin@example.com');
  assert.equal(env.lock.acquired, env.lock.released);
  // 送信が直った後、督促で最終承認者に新しいリンクが届き、承認できる
  env.mailFailTo.clear();
  assert.equal(runReminders(env, later(25)).reminded, 1);
  const t2 = env.tokenFor('cfo@example.com');
  assert.equal(env.decideAs('cfo@example.com', t2, 'approve', '', later(26)).ok, true);
  assert.equal(env.requests()[0][COL.STATUS], '承認済み');
});

test('TC-074 申請受付で承認依頼の送信に失敗しても申請は登録し、督促で回復する', () => {
  const env = createEnv();
  env.mailFailTo.add('manager@example.com');
  assert.equal(env.submitForm(formRow(), T0), 'REQ-20261115-0001');
  assert.equal(env.requests()[0][COL.STATUS], '承認待ち');
  assert.ok(env.audit().some((r) => r[2] === '受付' && r[4] === '成功'));
  assert.ok(env.audit().some((r) => r[2] === '通知' && r[4] === '失敗'));
  env.mailFailTo.clear();
  assert.equal(runReminders(env, later(24)).reminded, 1);
  assert.equal(env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(25)).ok, true);
});

test('TC-076 通知の失敗を監査ログに記録できなくても、確定済みの結果を返す', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  env.mailFailTo.add('staff@example.com');
  const audit = env.sheet('監査ログ');
  const original = audit.appendRow.bind(audit);
  // 「通知・失敗」の行の追記だけを失敗させる（シートへの追記の失敗を再現）
  audit.appendRow = (row) => {
    if (row[2] === '通知') throw new Error('fake: append failed');
    return original(row);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    const res = env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'reject', '予算外', later(1));
    assert.equal(res.ok, true);
    assert.match(res.message, /却下しました。申請者への通知に失敗/);
  } finally {
    console.error = quiet;
    audit.appendRow = original;
  }
  assert.equal(env.requests()[0][COL.STATUS], '却下');
  assert.equal(env.tokens()[0][7], '使用済み');
  assert.equal(env.sent.slice(-1)[0].to, 'admin@example.com', '管理者への連絡は続けて行う');
  assert.ok(!env.audit().some((r) => r[2] === '通知'));
  assert.ok(!env.audit().some((r) => r[2] === '拒否'), '利用者への失敗の返答（拒否）になっていない');
});

test('TC-077 督促: 設定が壊れていて実行できなかった回は「実行済み」として記録しない', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const settings = env.sheet('設定');
  const saved = settings.rows.map((r) => r.slice());
  settings.rows = settings.rows.filter((r) => r[0] !== '管理者メール');
  assert.throws(() => runReminders(env, later(24)), { code: 'INVALID_SETTING' });
  assert.equal(env.props.has('REMINDER_LAST_RUN_AT'), false);
  assert.equal(env.lock.acquired, env.lock.released);
  // 設定を直せば、30分以内でもすぐに督促できる
  settings.rows = saved;
  const res = runReminders(env, new Date(later(24).getTime() + 5 * 60 * 1000));
  assert.equal(res.skipped, undefined);
  assert.equal(res.reminded, 1);
  assert.ok(env.props.has('REMINDER_LAST_RUN_AT'));
});

test('TC-075結果の通知に失敗しても状態は確定し、利用者には「管理者に連絡した」と返す', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  env.mailFailTo.add('staff@example.com');
  const res = env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'reject', '予算外', later(1));
  assert.equal(res.ok, true);
  assert.match(res.message, /却下しました。申請者への通知に失敗/);
  assert.equal(env.requests()[0][COL.STATUS], '却下');
  assert.equal(env.sent.slice(-1)[0].to, 'admin@example.com');
});
