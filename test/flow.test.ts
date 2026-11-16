/**
 * flow.test.ts
 * 偽の GAS 環境で、申請受付から承認・却下・通知までを通しで確かめる。
 * 対象: FN-001, FN-005, FN-006, FN-007, FN-010, FN-011, FN-012
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, formRow, TEST_SECRET, type Env, type EnvOptions } from './helpers/env.ts';

const T0 = new Date('2026-11-15T09:00:00+09:00');
const later = (h: number) => new Date(T0.getTime() + h * 3600 * 1000);
const COL = { STATUS: 8, STEP: 9 };
const TOKEN_STATUS_COL = 7;
const lastAudit = (env: Env) => env.audit().slice(-1)[0];
/** console.error を一時的に黙らせて fn を実行する */
function quietly<T>(fn: () => T): T {
  const saved = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = saved; }
}

test('TC-032 申請受付: 申請一覧に登録し、1段目の承認者にリンク付きメールを送る', () => {
  const env = createEnv();
  const id = env.submitForm(formRow(), T0);
  assert.equal(id, 'REQ-20261115-0001');
  const [row] = env.requests();
  assert.equal(row[COL.STATUS], '承認待ち');
  assert.equal(row[COL.STEP], 1);
  assert.equal(row[10], 1);
  assert.equal(env.tokens().length, 1);
  assert.equal(env.tokens()[0][3], 'manager@example.com');
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].to, 'manager@example.com');
  assert.match(env.sent[0].body, /^https:\/\/script\.google\.com\/.+\/exec\?t=/m);
  assert.ok(!env.sent[0].body.includes(TEST_SECRET), 'メールに鍵が含まれない');
  assert.deepEqual(lastAudit(env).slice(2, 5), ['受付', 'system', '成功']);
});

test('TC-033 申請IDは日付ごとの連番で採番する', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  assert.equal(env.submitForm(formRow({ item: '椅子' }), T0), 'REQ-20261115-0002');
  assert.equal(env.submitForm(formRow({ at: later(24) }), later(24)), 'REQ-20261116-0001');
});

test('TC-034 入力が不正な申請は登録せず、監査ログと管理者に知らせる', () => {
  const env = createEnv();
  assert.equal(env.submitForm(formRow({ amount: '12.5' }), T0), null);
  assert.equal(env.requests().length, 0);
  assert.equal(env.tokens().length, 0);
  assert.deepEqual(lastAudit(env).slice(2, 6), ['受付', 'system', '失敗', 'INVALID_INPUT']);
  assert.equal(env.sent.length, 1);
  assert.equal(env.sent[0].to, 'admin@example.com');
});

test('TC-035 トリガー以外からの onFormSubmit 呼び出しは拒否する', () => {
  const env = createEnv();
  const form = env.sheet('フォームの回答 1');
  form.appendRow(formRow());
  const range = form.getRange(2, 1, 1, 7);
  const bad = [
    undefined,
    {},
    { triggerUid: 'forged-uid', range },
    { triggerUid: env.timeTrigger.getUniqueId(), range }, // 別の関数のトリガー
    { triggerUid: env.formTrigger.getUniqueId(), range: env.sheet('申請一覧').getRange(1, 1, 1, 7) }, // 別シート
  ];
  for (const e of bad) {
    assert.throws(() => env.ctx.onFormSubmit(e), { code: 'UNTRUSTED_CALLER' });
  }
  assert.equal(env.requests().length, 0);
  assert.equal(env.sent.length, 0);
  assert.deepEqual(lastAudit(env).slice(2, 6), ['拒否', 'unknown', '失敗', 'UNTRUSTED_CALLER']);
});

test('TC-036 確認画面: リンクを開いただけでは状態を変えず、入力値はエスケープして表示する', () => {
  const env = createEnv();
  env.submitForm(formRow({ item: '<script>alert(1)</script>' }), T0);
  const token = env.tokenFor('manager@example.com');
  const html = env.openAs('manager@example.com', token, later(1));
  assert.match(html, /申請の承認/);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.equal(env.requests()[0][COL.STATUS], '承認待ち');
  assert.equal(env.tokens()[0][TOKEN_STATUS_COL], '有効');
  // doGet（公開関数）経由でも同じ画面になる。スマートフォン表示用の viewport を付ける
  env.user.active = 'manager@example.com';
  const out = env.ctx.doGet({ parameter: { t: token } });
  assert.equal(out.title, '申請の承認');
  assert.match(out.meta.viewport, /width=device-width/);
  assert.match(out.getContent(), /data-nonce="\d{13}\.[A-Za-z0-9_=-]+"/);
});

test('TC-037 承認（1段）: 承認済みにしてトークンを使用済みにし、申請者に通知する', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const res = env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(2));
  assert.equal(res.ok, true);
  assert.equal(env.requests()[0][COL.STATUS], '承認済み');
  assert.equal(env.tokens()[0][TOKEN_STATUS_COL], '使用済み');
  const notice = env.sent.slice(-1)[0];
  assert.equal(notice.to, 'staff@example.com');
  assert.match(notice.subject, /承認済み/);
  assert.deepEqual(lastAudit(env).slice(2, 5), ['承認', 'manager@example.com', '成功']);
  assert.equal(env.lock.acquired, env.lock.released, '排他制御を必ず解放する');
});

test('TC-038 二重承認: 同じリンクで2回目を押しても処理しない', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  env.decideAs('manager@example.com', token, 'approve', '', later(2));
  const mails = env.sent.length;
  const second = env.decideAs('manager@example.com', token, 'approve', '', later(3));
  assert.equal(second.ok, false);
  assert.match(second.message, /処理済み/);
  assert.equal(env.sent.length, mails, '通知を二重に送らない');
  assert.deepEqual(lastAudit(env).slice(2, 6), ['拒否', 'manager@example.com', '失敗', 'TOKEN_USED']);
  // 却下に変えて押し直すこともできない
  assert.equal(env.decideAs('manager@example.com', token, 'reject', '取り消したい', later(3)).ok, false);
  assert.equal(env.requests()[0][COL.STATUS], '承認済み');
});

test('TC-039 却下後の承認: 却下した申請に有効なトークンが残っていても承認できない', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const res = env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'reject', '予算超過のため', later(2));
  assert.equal(res.ok, true);
  assert.equal(env.requests()[0][COL.STATUS], '却下');
  assert.match(env.sent.slice(-1)[0].body, /予算超過のため/);
  // 誤って同じ申請・段階のトークンを再発行してしまった場合を再現する
  const found = env.ctx.findRequest_('REQ-20261115-0001');
  const issued = env.ctx.issueToken_(found.request, 1, env.ctx.readSettings_(), later(3), 0);
  env.ctx.sendMail_(issued.mail);
  const again = env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(4));
  assert.equal(again.ok, false);
  assert.equal(lastAudit(env)[5], 'ALREADY_DECIDED');
  assert.equal(env.requests()[0][COL.STATUS], '却下');
});

test('TC-040 承認者以外（申請者本人・他の社員・メール取得不可）は正しいリンクでも操作できない', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  for (const who of ['staff@example.com', 'other@example.com', '']) {
    const res = env.decideAs(who, token, 'approve', '', later(1));
    assert.equal(res.ok, false, '利用者: ' + who);
    assert.match(res.message, /承認者として確認できません/);
    assert.match(env.openAs(who, token, later(1)), /操作できません/);
  }
  assert.equal(env.requests()[0][COL.STATUS], '承認待ち');
  assert.equal(env.tokens()[0][TOKEN_STATUS_COL], '有効', '本来の承認者は引き続き使える');
  assert.equal(env.decideAs('manager@example.com', token, 'approve', '', later(2)).ok, true);
});

test('TC-041 2段承認: 1段目の承認で最終承認者に新しいリンクを送り、最終承認で完了する', () => {
  const env = createEnv();
  env.submitForm(formRow({ amount: '150000', item: '業務用PC' }), T0);
  assert.equal(env.requests()[0][10], 2);
  const t1 = env.tokenFor('director@example.com');
  assert.match(env.sent[0].subject, /1\/2段階目/);
  const r1 = env.decideAs('director@example.com', t1, 'approve', '', later(1));
  assert.match(r1.message, /次の承認者/);
  assert.equal(env.requests()[0][COL.STATUS], '承認待ち');
  assert.equal(env.requests()[0][COL.STEP], 2);
  const toCfo = env.sent.slice(-1)[0];
  assert.equal(toCfo.to, 'cfo@example.com');
  assert.match(toCfo.subject, /2\/2段階目/);
  // 1段目のリンクで2段目を承認することはできない
  assert.equal(env.decideAs('director@example.com', t1, 'approve', '', later(2)).ok, false);
  // 1段目の承認者が最終承認者のリンクを使うこともできない
  const t2 = env.tokenFor('cfo@example.com');
  assert.equal(env.decideAs('director@example.com', t2, 'approve', '', later(2)).ok, false);
  const r2 = env.decideAs('cfo@example.com', t2, 'approve', '', later(3));
  assert.equal(r2.ok, true);
  assert.equal(env.requests()[0][COL.STATUS], '承認済み');
  assert.equal(env.sent.slice(-1)[0].to, 'staff@example.com');
});

test('TC-042 改ざん・期限切れのトークンは拒否する', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  const tampered = token.slice(0, -2) + (token.slice(-2) === 'AA' ? 'BB' : 'AA');
  const r1 = env.decideAs('manager@example.com', tampered, 'approve', '', later(1));
  assert.equal(r1.ok, false);
  assert.equal(lastAudit(env)[5], 'TOKEN_BAD_SIGNATURE');
  const r2 = env.decideAs('manager@example.com', token, 'approve', '', later(72));
  assert.equal(r2.ok, false);
  assert.match(r2.message, /有効期限/);
  assert.equal(env.requests()[0][COL.STATUS], '承認待ち');
});

test('TC-043 却下は理由が必須。操作の種類が不正なら拒否する', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  assert.match(env.decideAs('manager@example.com', token, 'reject', '   ', later(1)).message, /理由/);
  assert.equal(env.decideAs('manager@example.com', token, 'delete', 'x', later(1)).ok, false);
  assert.equal(env.requests()[0][COL.STATUS], '承認待ち');
  assert.equal(env.tokens()[0][TOKEN_STATUS_COL], '有効');
});

test('TC-044 排他制御: 他の処理の実行中は状態を変えずに「重なった」と返す', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  env.lock.held = true;
  const res = env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(1));
  assert.equal(res.ok, false);
  assert.match(res.message, /重なりました/);
  assert.equal(env.requests()[0][COL.STATUS], '承認待ち');
});

test('TC-045 鍵・ウェブアプリURLが未設定なら申請を登録しない', () => {
  for (const opt of [{ secret: null } as EnvOptions, { secret: 'short' }, { webAppUrl: null }, { webAppUrl: 'https://evil.example.com/exec' }]) {
    const env = createEnv(opt);
    assert.equal(env.submitForm(formRow(), T0), null);
    assert.equal(env.requests().length, 0, JSON.stringify(Object.keys(opt)));
    assert.match(String(lastAudit(env)[5]), /SECRET_NOT_CONFIGURED|WEBAPP_URL_NOT_CONFIGURED/);
  }
});

test('TC-046 数式インジェクション: 「=」等で始まる入力は文字列としてシートに書く', () => {
  const env = createEnv();
  env.submitForm(formRow({ item: '=HYPERLINK("https://example.com","x")', reason: '+cmd' }), T0);
  const [row] = env.requests();
  assert.equal(row[5], '\'=HYPERLINK("https://example.com","x")');
  assert.equal(row[7], "'+cmd");
});

test('TC-047 監査ログ・トークン記録にトークン文字列と鍵を書かない', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const token = env.tokenFor('manager@example.com');
  env.decideAs('other@example.com', token, 'approve', '', later(1));
  env.decideAs('manager@example.com', token, 'approve', '', later(2));
  const dump = JSON.stringify([env.audit(), env.tokens(), env.requests()]);
  assert.ok(!dump.includes(token.split('.')[1]), '署名が書かれていない');
  assert.ok(!dump.includes(token.split('.')[0]), 'トークン本体が書かれていない');
  assert.ok(!dump.includes(TEST_SECRET), '鍵が書かれていない');
});

test('TC-048 初期設定: 管理者本人だけが実行でき、鍵は上書きせず、トリガーを重複させない', () => {
  const env = createEnv({ secret: null });
  env.user.active = 'staff@example.com';
  assert.throws(() => env.ctx.setupProject(), { code: 'NOT_ADMIN' });
  env.user.active = 'admin@example.com';
  env.user.effective = 'someone-else@example.com';
  assert.throws(() => env.ctx.setupProject(), { code: 'NOT_ADMIN' }, '実行権限の持ち主と操作者が違う');
  env.user.effective = 'admin@example.com';
  env.ctx.setupProject();
  const secret = env.props.get('APPROVAL_HMAC_SECRET') ?? '';
  assert.match(secret, /^[0-9a-f]{64}$/);
  env.ctx.setupProject();
  assert.equal(env.props.get('APPROVAL_HMAC_SECRET'), secret, '2回目は鍵を変えない');
  const handlers = env.scriptApp.triggers.map((t) => t.getHandlerFunction()).sort();
  assert.equal(handlers.filter((h) => h === 'onFormSubmit').length, 1);
  assert.deepEqual(lastAudit(env).slice(2, 5), ['初期設定', 'admin@example.com', '成功']);
});

test('TC-099 メールと管理者への知らせの日時は、スクリプトのタイムゾーンで「yyyy/MM/dd HH:mm:ss」の形にする', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  // 有効期限は発行から72時間後（T0 = 2026-11-15 09:00 日本時間）
  assert.match(env.sent[0].body, /有効期限: 2026\/11\/18 09:00:00$/m);
  assert.doesNotMatch(env.sent[0].body, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, '協定世界時の ISO 8601 の形で書かない');
});

test('TC-100 使用したトークンの「使用日時」のセルは、日時の表示形式にする', () => {
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const res = env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(2));
  assert.equal(res.ok, true);
  const sheet = env.sheet('承認トークン');
  const usedAt = env.tokens()[0][6] as Date;
  assert.ok(Object.prototype.toString.call(usedAt) === '[object Date]' && usedAt.getTime() === later(2).getTime(), '値は日時のまま書く');
  // 承認トークンの2行目（データの1行目）の G 列（使用日時）
  assert.equal(sheet.formats.get('2,7'), 'yyyy/mm/dd hh:mm:ss');
});

test('TC-101 日時の書式や使用日時の表示形式の設定に失敗しても、確定と記録を失敗にしない', () => {
  // 書式にできないときは ISO 8601 の形に戻し、例外を投げない
  const env0 = createEnv();
  const utils = env0.ctx.Utilities as { formatDate: unknown };
  utils.formatDate = () => { throw new Error('fake: formatDate failed'); };
  assert.equal(env0.ctx.formatDateTime_(T0), T0.toISOString());

  // 使用日時の表示形式の設定に失敗しても、承認は成功し、トークンは使用済みになり、失敗の記録は残さない
  const env = createEnv();
  env.submitForm(formRow(), T0);
  const sheet = env.sheet('承認トークン');
  const getRange = sheet.getRange.bind(sheet);
  sheet.getRange = (row: number, col: number, numRows?: number, numCols?: number) => {
    const range = getRange(row, col, numRows, numCols);
    range.setNumberFormat = () => { throw new Error('fake: setNumberFormat failed'); };
    return range;
  };
  const res = quietly(() => env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(2)));
  assert.equal(res.ok, true);
  assert.equal(env.tokens()[0][TOKEN_STATUS_COL], '使用済み');
  assert.ok(!env.audit().some((r) => r[2] === 'トークン更新'), 'トークン更新の失敗として記録しない');
});

test('TC-102 社員名簿の読み取り: 見出しの判定・重複・文字の整え方・セルの種類・文字数の切り方', () => {
  const env = createEnv();
  const parse = (rows: unknown[][]) => JSON.parse(JSON.stringify(env.ctx.parseEmployeeNames_(rows)));
  // 見出しがあれば読み飛ばし、無くても先頭の社員を落とさない
  assert.deepEqual(parse([['メールアドレス', '氏名'], ['a@example.com', '社員A']]), { 'a@example.com': '社員A' });
  assert.deepEqual(parse([['a@example.com', '社員A']]), { 'a@example.com': '社員A' });
  assert.deepEqual(parse([
    ['Staff@Example.com', '  営業部　社員01 '], // 大文字小文字をそろえる。全角空白は残し、前後の空白は除く
    ['staff@example.com', '別の氏名'], // 重複は上の行だけ
    ['blank@example.com', '   '], // 上の行の氏名が空なら、下の行があっても氏名なし
    ['blank@example.com', '下の行'],
    ['not-an-email', '読み飛ばす'],
    ['line@example.com', '一行目\n二行目'],
    ['bidi@example.com', '社員\u202eB\u2066\u200b\u0085'], // 表示の向きを変える文字・C1 制御文字は空白
    ['num@example.com', 12345], // 文字列でないセルは氏名なし
    ['date@example.com', new Date('2026-01-01T00:00:00+09:00')],
  ]), {
    'staff@example.com': '営業部　社員01',
    'line@example.com': '一行目 二行目',
    'bidi@example.com': '社員 B',
  });
  // 50文字で切る。サロゲートペア（𠮷）の片方だけを残さず、切った後の末尾の空白も残さない
  const cut = parse([['s@example.com', 'あ'.repeat(49) + '𠮷' + 'い'], ['t@example.com', 'x'.repeat(49) + ' y']]);
  assert.equal(cut['s@example.com'], 'あ'.repeat(49) + '𠮷');
  assert.equal(cut['t@example.com'], 'x'.repeat(49));
});

test('TC-103 社員名簿に氏名があれば、承認依頼・督促・結果のメールと確認画面に「氏名（メールアドレス）」で出す', () => {
  const env = createEnv({ employeeRows: [['staff@example.com', '営業部 社員<01>']] });
  env.submitForm(formRow(), T0);
  assert.match(env.sent[0].body, /^申請者: 営業部 社員<01>（staff@example\.com）$/m, '承認依頼');
  const token = env.tokenFor('manager@example.com');
  const html = env.openAs('manager@example.com', token, later(1));
  assert.ok(html.includes('営業部 社員&lt;01&gt;（staff@example.com）'), '確認画面はエスケープして出す');
  env.user.active = '';
  env.ctx.handleReminders_({ triggerUid: env.timeTrigger.getUniqueId(), year: 2026, hour: 9 }, later(24));
  const reminder = env.sent.filter((m) => /督促/.test(m.subject)).pop();
  assert.ok(reminder, '督促メールが送られる');
  assert.match(reminder!.body, /^申請者: 営業部 社員<01>（staff@example\.com）$/m, '督促');
  const res = env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(25));
  assert.equal(res.ok, true);
  assert.match(env.sent.slice(-1)[0].body, /^申請者: 営業部 社員<01>（staff@example\.com）$/m, '結果');
  assert.equal(env.requests()[0][2], 'staff@example.com', '申請一覧にはメールアドレスだけを保存する');
});

test('TC-104 社員名簿が無い・名簿に無い・読めない場合は、メールアドレスだけを出し、処理は止めない', () => {
  const none = createEnv();
  none.submitForm(formRow(), T0);
  assert.match(none.sent[0].body, /^申請者: staff@example\.com$/m, 'シートが無い');

  const other = createEnv({ employeeRows: [['someone@example.com', '別の社員']] });
  other.submitForm(formRow(), T0);
  assert.match(other.sent[0].body, /^申請者: staff@example\.com$/m, '名簿に無い');

  const broken = createEnv({ employeeRows: [['staff@example.com', '営業部 社員01']] });
  const roster = broken.sheet('社員名簿');
  roster.getDataRange = () => { throw new Error('fake: read failed'); };
  const id = quietly(() => broken.submitForm(formRow(), T0));
  assert.equal(id, 'REQ-20261115-0001');
  assert.match(broken.sent[0].body, /^申請者: staff@example\.com$/m, '読めない');
});

test('TC-105 督促で複数の申請に送るとき、社員名簿は1回だけ読む', () => {
  const env = createEnv({ employeeRows: [['staff@example.com', '営業部 社員01']] });
  env.submitForm(formRow(), T0);
  env.submitForm(formRow({ item: '椅子' }), T0);
  env.submitForm(formRow({ item: '机' }), T0);
  const roster = env.sheet('社員名簿');
  const read = roster.getDataRange.bind(roster);
  let reads = 0;
  roster.getDataRange = () => { reads++; return read(); };
  env.user.active = '';
  const summary = env.ctx.handleReminders_({ triggerUid: env.timeTrigger.getUniqueId(), year: 2026, hour: 9 }, later(24));
  assert.equal(summary.reminded, 3);
  assert.equal(reads, 1);
  const reminders = env.sent.filter((m) => /督促/.test(m.subject));
  assert.equal(reminders.length, 3);
  for (const m of reminders) assert.match(m.body, /^申請者: 営業部 社員01（staff@example\.com）$/m);
});

test('TC-106 社員名簿を読めない場合も、確認画面・督促・結果のメールはメールアドレスだけで出し、処理は止めない', () => {
  const env = createEnv({ employeeRows: [['staff@example.com', '営業部 社員01']] });
  env.submitForm(formRow(), T0);
  env.sheet('社員名簿').getDataRange = () => { throw new Error('fake: read failed'); };
  const html = quietly(() => env.openAs('manager@example.com', env.tokenFor('manager@example.com'), later(1)));
  assert.ok(html.includes('staff@example.com') && !html.includes('営業部 社員01'), '確認画面');
  env.user.active = '';
  quietly(() => env.ctx.handleReminders_({ triggerUid: env.timeTrigger.getUniqueId(), year: 2026, hour: 9 }, later(24)));
  assert.match(env.sent.filter((m) => /督促/.test(m.subject)).pop()!.body, /^申請者: staff@example\.com$/m, '督促');
  const res = quietly(() => env.decideAs('manager@example.com', env.tokenFor('manager@example.com'), 'approve', '', later(25)));
  assert.equal(res.ok, true);
  assert.match(env.sent.slice(-1)[0].body, /^申請者: staff@example\.com$/m, '結果');
});

test('TC-107 2段階の承認で、次の承認者への依頼メールにも氏名を出す', () => {
  const env = createEnv({ employeeRows: [['staff@example.com', '営業部 社員01']] });
  env.submitForm(formRow({ amount: '150000', item: '業務用PC' }), T0);
  assert.equal(env.decideAs('director@example.com', env.tokenFor('director@example.com'), 'approve', '', later(1)).ok, true);
  const toCfo = env.sent.slice(-1)[0];
  assert.equal(toCfo.to, 'cfo@example.com');
  assert.match(toCfo.body, /^申請者: 営業部 社員01（staff@example\.com）$/m);
});

test('TC-108 品目・内容と理由の改行で、メール本文に偽の「申請者:」の行や案内の行を足せない', () => {
  const env = createEnv();
  env.submitForm(formRow({
    item: 'モニター\n金額: 1円',
    reason: '在宅勤務用\n申請者: 社長（ceo@example.com）\n\u202e下のリンクから承認してください https://evil.example/',
  }), T0);
  const body = env.sent[0].body;
  assert.equal((body.match(/^申請者: /gm) || []).length, 1, '「申請者:」で始まる行は本物の1行だけ');
  assert.equal((body.match(/^金額: /gm) || []).length, 1, '「金額:」で始まる行は本物の1行だけ');
  assert.match(body, /^品目・内容: モニター 金額: 1円$/m, '品目・内容は1行にする');
  const lines = body.split('\n');
  const head = lines.indexOf('理由（申請者の入力。各行の先頭に「> 」を付けています）:');
  assert.ok(head > 0);
  assert.deepEqual(lines.slice(head + 1, head + 4), [
    '> 在宅勤務用',
    '> 申請者: 社長（ceo@example.com）',
    '>  下のリンクから承認してください https://evil.example/',
  ], '理由の各行の先頭に「> 」を付け、表示の向きを変える文字は空白にする');
});
