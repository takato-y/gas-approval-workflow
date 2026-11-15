/**
 * approvalPage.test.ts
 * FN-005 承認画面（Approval.html）と確認用の値（CSRF 対策）のテスト。
 * 画面側のスクリプトは、最小限の DOM の偽物の上で実際に動かして確かめる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createEnv, formRow } from './helpers/env.ts';
import { SRC_DIR } from './helpers/loadGas.ts';

const T0 = new Date('2026-11-15T09:00:00+09:00');
const later = (min: number) => new Date(T0.getTime() + min * 60 * 1000);
const STATUS_COL = 8;

/** 画面の HTML から data 属性を取り出す */
function dataAttr(html: string, name: string): string {
  const m = html.match(new RegExp('data-' + name + '="([^"]*)"'));
  if (!m) throw new Error('data-' + name + ' not found');
  return m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

interface FakeElement {
  id: string;
  dataset: Record<string, string>;
  value: string;
  hidden: boolean;
  disabled: boolean;
  textContent: string;
  className: string;
  classList: { toggle(name: string, on: boolean): void };
  focus(): void;
  addEventListener(type: string, fn: () => void): void;
  click(): void;
}

/** 画面側スクリプトを動かすための最小限の DOM と google.script.run の偽物 */
function runClient(html: string) {
  const elements = new Map<string, FakeElement>();
  const make = (id: string): FakeElement => {
    const handlers: Array<() => void> = [];
    const el: FakeElement = {
      id, dataset: {}, value: '', hidden: /id="confirm"[^>]*hidden/.test(html) && id === 'confirm', disabled: false,
      textContent: '', className: '', classList: { toggle() {} }, focus() {},
      addEventListener(_t, fn) { handlers.push(fn); },
      click() { if (!el.disabled) handlers.forEach((h) => h()); },
    };
    elements.set(id, el);
    return el;
  };
  for (const m of html.matchAll(/id="([\w-]+)"/g)) make(m[1]);
  const app = elements.get('app')!;
  app.dataset = { token: dataAttr(html, 'token'), nonce: dataAttr(html, 'nonce'), requestId: dataAttr(html, 'request-id') };
  const calls: unknown[][] = [];
  let success: ((r: unknown) => void) | null = null;
  const runner = {
    withSuccessHandler(fn: (r: unknown) => void) { success = fn; return runner; },
    withFailureHandler() { return runner; },
    submitDecision(...args: unknown[]) { calls.push(args); },
  };
  const document = {
    getElementById: (id: string) => elements.get(id) || null,
    querySelectorAll: (sel: string) => (sel === 'button' ? [...elements.values()].filter((e) => /approve|reject|confirm-yes|confirm-no/.test(e.id)) : []),
  };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  vm.runInNewContext(script, { document, google: { script: { run: runner } } });
  return { el: (id: string) => elements.get(id)!, calls, respond: (r: unknown) => success && success(r) };
}

test('TC-049 承認画面のテンプレート: 値は印字スクリプトレットだけで埋め込み、エスケープしない記法を使わない', () => {
  for (const file of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.html'))) {
    const src = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(!src.includes('<?!='), file + ' にエスケープしない記法がある');
    assert.ok(!/<\?(?!=)/.test(src), file + ' に印字以外のスクリプトレットがある');
    assert.ok(!/\son\w+="/.test(src), file + ' にインラインのイベント属性がある');
  }
  const env = createEnv();
  env.submitForm(formRow({ item: '"><img src=x onerror=alert(1)>', reason: "'; alert(2); //" }), T0);
  const html = env.openAs('manager@example.com', env.tokenFor('manager@example.com'), later(1));
  assert.ok(!html.includes('<img src=x'), '入力値がタグとして出ていない');
  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
  assert.match(html, /id="confirm"[^>]*hidden/, '確認枠は最初は隠れている');
  assert.match(html, /role="status"/);
});

test('TC-050 画面側スクリプト: 1回目の操作では送信せず、「確定する」で token・確認用の値・操作・コメントを送る', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  const html = env.openAs('manager@example.com', token, later(1));
  const page = runClient(html);
  page.el('approve').click();
  assert.equal(page.calls.length, 0, '1回目のクリックでは送らない');
  assert.equal(page.el('confirm').hidden, false);
  assert.match(page.el('confirm-text').textContent, /REQ-20261115-0001 を承認します/);
  page.el('confirm-no').click();
  assert.equal(page.el('confirm').hidden, true, '戻ると確認が消える');
  page.el('approve').click();
  page.el('confirm-yes').click();
  assert.equal(page.calls.length, 1);
  const [sentToken, sentNonce, decision, comment] = page.calls[0];
  assert.equal(sentToken, token);
  assert.equal(decision, 'approve');
  assert.equal(comment, '');
  assert.equal(page.el('approve').disabled, true, '送信中はボタンを押せない');
  // 送られた値をそのままサーバー側の確定処理に渡す
  const res = env.decideAs('manager@example.com', String(sentToken), String(decision), String(comment), later(2), String(sentNonce));
  assert.equal(res.ok, true);
  page.respond(res);
  assert.match(page.el('result').textContent, /承認しました/);
  assert.equal(env.requests()[0][STATUS_COL], '承認済み');
});

test('TC-051 画面側スクリプト: 却下はコメントが空なら確認を出さずに案内する', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const page = runClient(env.openAs('manager@example.com', env.tokenFor('manager@example.com'), later(1)));
  page.el('reject').click();
  assert.equal(page.el('confirm').hidden, true);
  assert.match(page.el('result').textContent, /却下の理由/);
  page.el('comment').value = '見積の再取得をお願いします';
  page.el('reject').click();
  page.el('confirm-yes').click();
  assert.deepEqual(page.calls[0].slice(2), ['reject', '見積の再取得をお願いします']);
});

test('TC-052 確認用の値が無い・改ざん・他人の値・期限切れの場合は確定しない（CSRF 対策）', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  const own = env.pageNonce('manager@example.com', token, later(1));
  const [exp, sig] = own.split('.');
  const cases: Array<[string, string, Date, string]> = [
    ['空', '', later(2), 'CONFIRM_INVALID'],
    ['形式違い', 'abc', later(2), 'CONFIRM_INVALID'],
    ['署名の改ざん', exp + '.' + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1), later(2), 'CONFIRM_INVALID'],
    ['期限の延長', String(Number(exp) + 3600000) + '.' + sig, later(2), 'CONFIRM_INVALID'],
    ['他人が開いた画面の値', env.pageNonce('staff@example.com', token, later(1)), later(2), 'CONFIRM_INVALID'],
    ['15分経過', own, later(16), 'CONFIRM_EXPIRED'],
  ];
  for (const [label, nonce, at, code] of cases) {
    const res = env.decideAs('manager@example.com', token, 'approve', '', at, nonce);
    assert.equal(res.ok, false, label);
    assert.equal(env.audit().slice(-1)[0][5], code, label);
  }
  assert.equal(env.requests()[0][STATUS_COL], '承認待ち');
  assert.equal(env.tokens()[0][7], '有効', 'トークンは使われていない');
  assert.equal(env.decideAs('manager@example.com', token, 'approve', '', later(2), own).ok, true);
});
