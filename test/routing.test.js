/**
 * routing.test.js
 * FN-002 承認経路の決定・FN-001 の入力検査のテスト。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGas } = require('./helpers/loadGas');

const { ctx } = loadGas();
/** vm 内で作られたオブジェクトを比較できる形にする */
const plain = (v) => JSON.parse(JSON.stringify(v));

const RULES = ctx.parseRules_([
  ['開発部', 0, 50000, 'dev-lead@example.com', 'dev-sub@example.com'],
  ['*', 0, 50000, 'manager@example.com', 'manager-sub@example.com'],
  ['*', 50000, '', 'director@example.com', 'director-sub@example.com'],
]);
const SETTINGS = {
  multiStepThreshold: 100000,
  finalApprover: 'cfo@example.com',
  adminEmail: 'admin@example.com',
};
const req = (over) => Object.assign({ applicant: 'staff@example.com', department: '営業部', amount: 1000 }, over);

test('TC-001 しきい値未満は1段承認になる', () => {
  assert.deepEqual(plain(ctx.resolveApprovalRoute_(req({ amount: 99999 }), RULES, SETTINGS)), [
    { step: 1, approver: 'director@example.com' },
  ]);
});

test('TC-002 しきい値ちょうどは2段承認になる（境界値）', () => {
  assert.deepEqual(plain(ctx.resolveApprovalRoute_(req({ amount: 100000 }), RULES, SETTINGS)), [
    { step: 1, approver: 'director@example.com' },
    { step: 2, approver: 'cfo@example.com' },
  ]);
});

test('TC-003 しきい値を超える高額申請は最終承認者が2段目に入る', () => {
  const route = plain(ctx.resolveApprovalRoute_(req({ amount: 2500000 }), RULES, SETTINGS));
  assert.equal(route.length, 2);
  assert.equal(route[1].approver, 'cfo@example.com');
});

test('TC-004 部署別ルールが全部署ルールより先に一致する', () => {
  const route = plain(ctx.resolveApprovalRoute_(req({ department: '開発部', amount: 3000 }), RULES, SETTINGS));
  assert.equal(route[0].approver, 'dev-lead@example.com');
});

test('TC-005 金額上限は「未満」で判定する（49999 と 50000 の境界）', () => {
  assert.equal(ctx.resolveApprovalRoute_(req({ amount: 49999 }), RULES, SETTINGS)[0].approver, 'manager@example.com');
  assert.equal(ctx.resolveApprovalRoute_(req({ amount: 50000 }), RULES, SETTINGS)[0].approver, 'director@example.com');
});

test('TC-006 承認者が申請者本人なら代理承認者に回す（自己承認の防止）', () => {
  const route = plain(ctx.resolveApprovalRoute_(req({ applicant: 'Manager@Example.com ', amount: 1000 }), RULES, SETTINGS));
  assert.equal(route[0].approver, 'manager-sub@example.com');
});

test('TC-007 代理承認者が無く本人しかいない場合はエラーにする', () => {
  const rules = ctx.parseRules_([['*', 0, '', 'boss@example.com', '']]);
  assert.throws(() => ctx.resolveApprovalRoute_(req({ applicant: 'boss@example.com' }), rules, SETTINGS), { code: 'SELF_APPROVAL' });
});

test('TC-008 最終承認者が申請者本人なら管理者に回す', () => {
  const route = plain(ctx.resolveApprovalRoute_(req({ applicant: 'cfo@example.com', amount: 300000 }), RULES, SETTINGS));
  assert.deepEqual(route[1], { step: 2, approver: 'admin@example.com' });
});

test('TC-009 1段目と最終承認者が同じ人なら2段目を加えない', () => {
  const rules = ctx.parseRules_([['経理部', 0, '', 'cfo@example.com', 'acct-sub@example.com']]);
  const route = plain(ctx.resolveApprovalRoute_(req({ department: '経理部', amount: 500000 }), rules, SETTINGS));
  assert.deepEqual(route, [{ step: 1, approver: 'cfo@example.com' }]);
});

test('TC-010 一致するルールが無ければ NO_RULE', () => {
  const rules = ctx.parseRules_([['開発部', 0, '', 'dev-lead@example.com', '']]);
  assert.throws(() => ctx.resolveApprovalRoute_(req({ department: '営業部' }), rules, SETTINGS), { code: 'NO_RULE' });
});

test('TC-011 フォーム回答を申請に変換する（カンマ付き金額・メールの正規化）', () => {
  const r = ctx.parseFormResponse_([
    new Date('2026-11-15T09:00:00+09:00'), ' Staff@Example.com', '営業部', '備品購入', 'ノートPC', '128,000', '故障のため',
  ]);
  assert.equal(r.applicant, 'staff@example.com');
  assert.equal(r.amount, 128000);
  assert.equal(r.category, '備品購入');
});

test('TC-012 金額が整数・範囲内でなければ INVALID_INPUT', () => {
  for (const bad of ['1.5', '-100', '0', '100000000', 'abc', '', '１２３']) {
    assert.throws(() => ctx.parseAmount_(bad), { code: 'INVALID_INPUT' }, '入力: ' + bad);
  }
  assert.equal(ctx.parseAmount_(99999999), 99999999);
});

test('TC-013 選択肢にない部署・区分、長すぎる文字列は INVALID_INPUT', () => {
  const base = [new Date(), 'staff@example.com', '営業部', '経費', '交通費', '1000', '出張'];
  const cases = [
    [2, '人事部'], [3, '寄付'], [4, 'あ'.repeat(201)], [6, ''], [1, 'not-an-email'],
  ];
  for (const [col, value] of cases) {
    const v = base.slice();
    v[col] = value;
    assert.throws(() => ctx.parseFormResponse_(v), { code: 'INVALID_INPUT' }, '列: ' + col);
  }
});

test('TC-014 承認ルールの不正な行は INVALID_RULE', () => {
  assert.throws(() => ctx.parseRules_([['*', 100, 50, 'a@example.com', '']]), { code: 'INVALID_RULE' });
  assert.throws(() => ctx.parseRules_([['*', 0, '', 'not-an-email', '']]), { code: 'INVALID_RULE' });
  assert.throws(() => ctx.parseRules_([['*', 'x', '', 'a@example.com', '']]), { code: 'INVALID_RULE' });
});

test('TC-015 設定の読み取り: 数値は初期値で補い、メール未設定はエラー', () => {
  const s = ctx.parseSettings_([
    ['最終承認者メール', 'CFO@example.com'],
    ['管理者メール', 'admin@example.com'],
  ]);
  assert.equal(s.multiStepThreshold, 100000);
  assert.equal(s.finalApprover, 'cfo@example.com');
  assert.throws(() => ctx.parseSettings_([['管理者メール', 'admin@example.com']]), { code: 'INVALID_SETTING' });
  assert.throws(() => ctx.parseSettings_([
    ['最終承認者メール', 'cfo@example.com'], ['管理者メール', 'admin@example.com'], ['督促上限回数', -1],
  ]), { code: 'INVALID_SETTING' });
});
