/**
 * env.js
 * 偽の GAS 環境一式（シート・メール・プロパティ・排他制御・利用者・トリガー）を作る。
 * データはすべて架空（example.com）。
 */
'use strict';

const { loadGas } = require('./loadGas');
const f = require('./fakes');

const WEBAPP_URL = 'https://script.google.com/a/macros/example.com/s/DEPLOYMENT_ID/exec';
// テスト専用の鍵。実運用の鍵は setupProject が乱数で作り、スクリプトのプロパティにだけ保存する
const TEST_SECRET = 'test-only-key-0123456789abcdef0123456789abcdef';

const SETTINGS_ROWS = [
  ['項目', '値'],
  ['多段承認しきい値', 100000],
  ['最終承認者メール', 'cfo@example.com'],
  ['管理者メール', 'admin@example.com'],
  ['トークン有効時間', 72],
  ['督促開始時間', 24],
  ['督促上限回数', 3],
];
const RULE_ROWS = [
  ['部署', '金額下限', '金額上限', '承認者メール', '代理承認者メール'],
  ['開発部', 0, 50000, 'dev-lead@example.com', 'dev-sub@example.com'],
  ['*', 0, 50000, 'manager@example.com', 'manager-sub@example.com'],
  ['*', 50000, '', 'director@example.com', 'director-sub@example.com'],
];
const FORM_HEADER = ['タイムスタンプ', 'メールアドレス', '部署', '申請区分', '品目・内容', '金額', '理由'];

/**
 * @param {{secret?: (string|null), webAppUrl?: (string|null), settingsRows?: Array}} [opt]
 */
function createEnv(opt) {
  const o = opt || {};
  const user = { active: '', effective: 'admin@example.com' };
  const mail = f.createFakeMailApp();
  const lock = f.createFakeLock();
  const scriptApp = f.createFakeScriptApp();
  const initialProps = {};
  if (o.secret !== null) initialProps.APPROVAL_HMAC_SECRET = o.secret || TEST_SECRET;
  if (o.webAppUrl !== null) initialProps.WEBAPP_URL = o.webAppUrl || WEBAPP_URL;
  const props = f.createFakeProperties(initialProps);

  // 見出し行はソースの定義（SHEET_HEADERS）から取る
  const probe = loadGas();
  const headers = probe.get('SHEET_HEADERS');
  const sheet = f.createFakeSpreadsheet({
    'フォームの回答 1': [FORM_HEADER],
    申請一覧: [headers['申請一覧'].slice()],
    承認ルール: RULE_ROWS,
    設定: o.settingsRows || SETTINGS_ROWS,
    承認トークン: [headers['承認トークン'].slice()],
    監査ログ: [headers['監査ログ'].slice()],
  });

  const gas = loadGas(Object.assign(
    { Utilities: f.createFakeUtilities() },
    sheet, mail, props, lock, scriptApp,
    f.createFakeSession(user), f.createFakeHtmlService(),
  ));

  const formTrigger = scriptApp.makeTrigger('onFormSubmit', 'formSubmit');
  const timeTrigger = scriptApp.makeTrigger('sendReminders', 'time');

  const env = {
    gas, ctx: gas.ctx, ss: sheet.ss, sent: mail.sent, props: props.store, lock: lock.state, user, scriptApp,
    formTrigger, timeTrigger,
    sheet: (name) => sheet.ss.sheet(name),
    audit: () => sheet.ss.sheet('監査ログ').body(),
    requests: () => sheet.ss.sheet('申請一覧').body(),
    tokens: () => sheet.ss.sheet('承認トークン').body(),

    /** フォーム回答を1行追記し、フォーム送信トリガーと同じイベントで呼ぶ */
    submitForm(values, now) {
      const form = sheet.ss.sheet('フォームの回答 1');
      form.appendRow(values);
      const range = form.getRange(form.getLastRow(), 1, 1, FORM_HEADER.length);
      return gas.ctx.handleFormSubmit_({ triggerUid: formTrigger.getUniqueId(), range, values: values.map(String), authMode: 'FULL' }, now);
    },
    /** 最後に送られた、指定した宛先へのメールからトークンを取り出す */
    tokenFor(to) {
      const m = mail.sent.filter((x) => x.to === to).pop();
      if (!m) throw new Error('mail not found for ' + to);
      const match = m.body.match(/\?t=([^\s]+)/);
      return decodeURIComponent(match[1]);
    },
    /** 指定した利用者として確認画面を開く */
    openAs(email, token, now) {
      user.active = email;
      return gas.ctx.renderDecisionView_(token, email, now);
    },
    /** 指定した利用者としてボタンを押す */
    decideAs(email, token, decision, comment, now) {
      user.active = email;
      return gas.ctx.handleDecision_(token, decision, comment, email, now);
    },
  };
  return env;
}

/** フォーム回答の1行を作る */
function formRow(over) {
  const d = Object.assign({
    at: new Date('2026-11-15T09:00:00+09:00'), email: 'staff@example.com', dept: '営業部',
    category: '備品購入', item: 'モニター', amount: '32000', reason: '在宅勤務用',
  }, over || {});
  return [d.at, d.email, d.dept, d.category, d.item, d.amount, d.reason];
}

module.exports = { createEnv, formRow, WEBAPP_URL, TEST_SECRET };
