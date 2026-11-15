/**
 * env.ts
 * 偽の GAS 環境一式（シート・メール・プロパティ・排他制御・利用者・トリガー）を作る。
 * データはすべて架空（example.com）。
 */
import { loadGas, SRC_DIR, type GasContext, type LoadedGas } from './loadGas.ts';
import * as f from './fakes.ts';

export const WEBAPP_URL = 'https://script.google.com/a/macros/example.com/s/DEPLOYMENT_ID/exec';
// テスト専用の鍵。実運用の鍵は setupProject が乱数で作り、スクリプトのプロパティにだけ保存する
export const TEST_SECRET = 'test-only-key-0123456789abcdef0123456789abcdef';

export const SETTINGS_ROWS: f.Cell[][] = [
  ['項目', '値'],
  ['多段承認しきい値', 100000],
  ['最終承認者メール', 'cfo@example.com'],
  ['管理者メール', 'admin@example.com'],
  ['トークン有効時間', 72],
  ['督促開始時間', 24],
  ['督促上限回数', 3],
];
export const RULE_ROWS: f.Cell[][] = [
  ['部署', '金額下限', '金額上限', '承認者メール', '代理承認者メール'],
  ['開発部', 0, 50000, 'dev-lead@example.com', 'dev-sub@example.com'],
  ['*', 0, 50000, 'manager@example.com', 'manager-sub@example.com'],
  ['*', 50000, '', 'director@example.com', 'director-sub@example.com'],
];
export const FORM_HEADER = ['タイムスタンプ', 'メールアドレス', '部署', '申請区分', '品目・内容', '金額', '理由'];

export interface EnvOptions {
  /** null で未設定を再現 */
  secret?: string | null;
  webAppUrl?: string | null;
  settingsRows?: f.Cell[][];
}

export interface Env {
  gas: LoadedGas;
  ctx: GasContext;
  sent: f.SentMail[];
  /** ここに入れた宛先へのメール送信は失敗する */
  mailFailTo: Set<string>;
  props: Map<string, string>;
  lock: { held: boolean; acquired: number; released: number; failRelease: boolean };
  /** flush の呼び出し回数と、失敗させる設定 */
  flush: { calls: number; fail: boolean };
  /** ロックの取得・flush・解放が起きた順 */
  events: string[];
  user: { active: string; effective: string };
  scriptApp: ReturnType<typeof f.createFakeScriptApp>;
  formTrigger: f.FakeTrigger;
  timeTrigger: f.FakeTrigger;
  sheet(name: string): f.FakeSheet;
  audit(): f.Cell[][];
  requests(): f.Cell[][];
  tokens(): f.Cell[][];
  submitForm(values: f.Cell[], now: Date): string | null;
  tokenFor(to: string): string;
  openAs(email: string, token: string, now: Date): string;
  pageNonce(email: string, token: string, now: Date): string;
  decideAs(email: string, token: string, decision: string, comment: string, now: Date, nonce?: string): { ok: boolean; message: string };
}

export function createEnv(opt: EnvOptions = {}): Env {
  const user = { active: '', effective: 'admin@example.com' };
  const mail = f.createFakeMailApp();
  const events: string[] = [];
  const lock = f.createFakeLock(events);
  const scriptApp = f.createFakeScriptApp();
  const initialProps: Record<string, string> = {};
  if (opt.secret !== null) initialProps.APPROVAL_HMAC_SECRET = opt.secret || TEST_SECRET;
  if (opt.webAppUrl !== null) initialProps.WEBAPP_URL = opt.webAppUrl || WEBAPP_URL;
  const props = f.createFakeProperties(initialProps);

  // 見出し行はソースの定義（SHEET_HEADERS）から取る
  const headers = loadGas().get('SHEET_HEADERS') as Record<string, string[]>;
  const sheet = f.createFakeSpreadsheet({
    'フォームの回答 1': [FORM_HEADER],
    申請一覧: [headers['申請一覧'].slice()],
    承認ルール: RULE_ROWS,
    設定: opt.settingsRows || SETTINGS_ROWS,
    承認トークン: [headers['承認トークン'].slice()],
    監査ログ: [headers['監査ログ'].slice()],
  }, events);

  const gas = loadGas(Object.assign(
    { Utilities: f.createFakeUtilities() },
    sheet, mail, props, lock, { ScriptApp: scriptApp.ScriptApp },
    f.createFakeSession(user), f.createFakeHtmlService(SRC_DIR),
  ));

  const formTrigger = scriptApp.makeTrigger('onFormSubmit', 'formSubmit');
  const timeTrigger = scriptApp.makeTrigger('sendReminders', 'time');

  return {
    gas, ctx: gas.ctx, sent: mail.sent, mailFailTo: mail.failTo, props: props.store, lock: lock.state, flush: sheet.flushState, events, user, scriptApp,
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
      if (!match) throw new Error('link not found in mail');
      return decodeURIComponent(match[1]);
    },
    /** 指定した利用者として確認画面を開く */
    openAs(email, token, now) {
      user.active = email;
      return gas.ctx.renderDecisionView_(token, email, now).getContent();
    },
    /** その利用者が確認画面を開いたときに作られる確認用の値（画面を開けない利用者の分も作れる） */
    pageNonce(email, token, now) {
      const tid = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).tid;
      return gas.ctx.createConfirmNonce_(tid, email, now.getTime(), props.store.get('APPROVAL_HMAC_SECRET'), gas.ctx.gasCryptoAdapter_());
    },
    /** 指定した利用者として「確定する」を押す。nonce を省くと、本人が画面を開いた直後の値を使う */
    decideAs(email, token, decision, comment, now, nonce) {
      user.active = email;
      const confirm = nonce !== undefined ? nonce : this.pageNonce(email, token, now);
      return gas.ctx.handleDecision_(token, confirm, decision, comment, email, now);
    },
  };
}

/** フォーム回答の1行を作る */
export function formRow(over: Partial<Record<'at' | 'email' | 'dept' | 'category' | 'item' | 'amount' | 'reason', f.Cell>> = {}): f.Cell[] {
  const d = Object.assign({
    at: new Date('2026-11-15T09:00:00+09:00'), email: 'staff@example.com', dept: '営業部',
    category: '備品購入', item: 'モニター', amount: '32000', reason: '在宅勤務用',
  }, over);
  return [d.at, d.email, d.dept, d.category, d.item, d.amount, d.reason];
}
