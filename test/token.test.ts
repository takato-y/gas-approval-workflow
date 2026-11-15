/**
 * token.test.ts
 * FN-003 トークンの発行・検証のテスト（改ざん・期限切れ・再利用・本人確認）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadGas } from './helpers/loadGas.ts';
import { createFakeUtilities } from './helpers/fakes.ts';

const { ctx, get } = loadGas({ Utilities: createFakeUtilities() });
const adapter = ctx.gasCryptoAdapter_();
// テスト専用の鍵（実運用の鍵は setupProject が乱数で生成しスクリプトのプロパティに保存する）
const SECRET = 'test-only-key-' + 'x'.repeat(40);
const NOW = Date.parse('2026-11-15T09:00:00+09:00');
const TID = '3f2b8c1e-9a4d-4e6b-8f0a-1c2d3e4f5a6b';

const issue = (over: Record<string, unknown> = {}) => {
  const claims = Object.assign(ctx.buildTokenClaims_(TID, 'REQ-20261115-0001', 1, NOW, 72), over || {});
  return ctx.signToken_(claims, SECRET, adapter);
};
/** トークンの中身を書き換え、署名はそのまま残す（攻撃者の操作を再現） */
type Claims = { v: number; tid: string; rid: string; step: number; exp: number };
const tamperBody = (token: string, mutate: (c: Claims) => void) => {
  const [body, sig] = token.split('.');
  const claims = JSON.parse(adapter.decode(body));
  mutate(claims);
  return adapter.encode(JSON.stringify(claims)) + '.' + sig;
};

test('TC-016 発行したトークンを検証すると中身が戻る', () => {
  const claims = ctx.verifyToken_(issue(), SECRET, NOW + 1000, adapter);
  assert.equal(claims.rid, 'REQ-20261115-0001');
  assert.equal(claims.step, 1);
  assert.equal(claims.exp, NOW + 72 * 3600 * 1000);
});

test('TC-017 申請ID・段階を書き換えたトークンは署名不一致になる', () => {
  for (const mutate of [(c: Claims) => { c.rid = 'REQ-20261115-0002'; }, (c: Claims) => { c.step = 2; }, (c: Claims) => { c.tid = crypto.randomUUID(); }]) {
    assert.throws(() => ctx.verifyToken_(tamperBody(issue(), mutate), SECRET, NOW, adapter), { code: 'TOKEN_BAD_SIGNATURE' });
  }
});

test('TC-018 有効期限を延ばす改ざんは署名不一致になる', () => {
  const forged = tamperBody(issue(), (c: Claims) => { c.exp = NOW + 365 * 24 * 3600 * 1000; });
  assert.throws(() => ctx.verifyToken_(forged, SECRET, NOW + 100 * 3600 * 1000, adapter), { code: 'TOKEN_BAD_SIGNATURE' });
});

test('TC-019 署名部の書き換え・別の鍵で作ったトークンは署名不一致になる', () => {
  const token = issue();
  const [body, sig] = token.split('.');
  const flipped = body + '.' + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  assert.throws(() => ctx.verifyToken_(flipped, SECRET, NOW, adapter), { code: 'TOKEN_BAD_SIGNATURE' });
  const other = ctx.signToken_(ctx.buildTokenClaims_(TID, 'REQ-20261115-0001', 1, NOW, 72), 'another-key-' + 'y'.repeat(40), adapter);
  assert.throws(() => ctx.verifyToken_(other, SECRET, NOW, adapter), { code: 'TOKEN_BAD_SIGNATURE' });
  assert.throws(() => ctx.verifyToken_(body + '.', SECRET, NOW, adapter), { code: 'TOKEN_MALFORMED' });
});

test('TC-020 有効期限ちょうどで期限切れ、その1ミリ秒前は有効（境界値）', () => {
  const token = issue();
  const exp = NOW + 72 * 3600 * 1000;
  assert.equal(ctx.verifyToken_(token, SECRET, exp - 1, adapter).tid, TID);
  assert.throws(() => ctx.verifyToken_(token, SECRET, exp, adapter), { code: 'TOKEN_EXPIRED' });
});

test('TC-021 形式が不正なトークンは TOKEN_MALFORMED（正しい署名付きの不正な中身を含む）', () => {
  for (const bad of ['', 'abc', 'a.b.c', 'x'.repeat(600), null, 12345]) {
    assert.throws(() => ctx.verifyToken_(bad, SECRET, NOW, adapter), { code: 'TOKEN_MALFORMED' }, String(bad).slice(0, 10));
  }
  // 鍵を知る者が誤った中身に署名した場合も、中身の検査で止める
  const body = adapter.encode(JSON.stringify({ v: 1, tid: 'not-uuid', rid: 'REQ-1', step: 9, exp: NOW + 1 }));
  assert.throws(() => ctx.verifyToken_(body + '.' + adapter.hmac(body, SECRET), SECRET, NOW, adapter), { code: 'TOKEN_MALFORMED' });
});

test('TC-022 鍵が未設定・短すぎる場合は発行も検証もしない', () => {
  const claims = ctx.buildTokenClaims_(TID, 'REQ-20261115-0001', 1, NOW, 72);
  for (const secret of [undefined, '', 'short']) {
    assert.throws(() => ctx.signToken_(claims, secret, adapter), { code: 'SECRET_NOT_CONFIGURED' });
    assert.throws(() => ctx.verifyToken_(issue(), secret, NOW, adapter), { code: 'SECRET_NOT_CONFIGURED' });
  }
});

test('TC-023 サーバー側の記録で再利用・取り消し・取り違えを拒否する', () => {
  const TS = get('TOKEN_STATUS');
  const claims = ctx.verifyToken_(issue(), SECRET, NOW, adapter);
  const base = { tokenId: TID, requestId: 'REQ-20261115-0001', step: 1, approver: 'manager@example.com',
    expiresAt: new Date(NOW + 72 * 3600 * 1000), status: TS.ACTIVE };
  assert.doesNotThrow(() => ctx.checkTokenRecord_(base, claims, NOW));
  assert.throws(() => ctx.checkTokenRecord_(null, claims, NOW), { code: 'TOKEN_UNKNOWN' });
  assert.throws(() => ctx.checkTokenRecord_({ ...base, status: TS.USED }, claims, NOW), { code: 'TOKEN_USED' });
  assert.throws(() => ctx.checkTokenRecord_({ ...base, status: TS.REVOKED }, claims, NOW), { code: 'TOKEN_REVOKED' });
  assert.throws(() => ctx.checkTokenRecord_({ ...base, requestId: 'REQ-20261115-0009' }, claims, NOW), { code: 'TOKEN_MISMATCH' });
  assert.throws(() => ctx.checkTokenRecord_({ ...base, step: 2 }, claims, NOW), { code: 'TOKEN_MISMATCH' });
  // 記録側の期限を短くした場合（運用で失効させた等）も記録側を優先する
  assert.throws(() => ctx.checkTokenRecord_({ ...base, expiresAt: new Date(NOW - 1) }, claims, NOW), { code: 'TOKEN_EXPIRED' });
});

test('TC-024 割り当てられた承認者以外・メール取得不可は拒否する', () => {
  const record = { approver: 'manager@example.com' };
  assert.equal(ctx.checkApproverIdentity_(record, 'Manager@Example.com'), 'manager@example.com');
  assert.throws(() => ctx.checkApproverIdentity_(record, 'staff@example.com'), { code: 'UNAUTHORIZED_APPROVER' });
  assert.throws(() => ctx.checkApproverIdentity_(record, ''), { code: 'IDENTITY_UNAVAILABLE' });
  assert.throws(() => ctx.checkApproverIdentity_(record, null), { code: 'IDENTITY_UNAVAILABLE' });
});

test('TC-025 署名は HMAC-SHA256 の web-safe base64 であり、別実装で計算した値と一致する', () => {
  const token = issue();
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64').replace(/\+/g, '-').replace(/\//g, '_');
  assert.equal(sig, expected);
  assert.equal(ctx.timingSafeEqual_('abc', 'abc'), true);
  assert.equal(ctx.timingSafeEqual_('abc', 'abd'), false);
  assert.equal(ctx.timingSafeEqual_('abc', 'abcd'), false);
  assert.equal(ctx.timingSafeEqual_('abc', ''), false);
});
