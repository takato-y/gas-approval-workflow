/**
 * Token.js
 * 承認リンク用トークンの発行・検証。
 *
 * 形式: base64url(JSON の中身) + "." + base64url(HMAC-SHA256(中身, 鍵))
 * - 署名で改ざんを見破り、中身の有効期限で期限切れを判定する。
 * - 1回限りの判定は、サーバー側（承認トークンシート）の記録で行う（checkTokenRecord_）。
 * - 鍵はスクリプトのプロパティに置き、コードには書かない。
 *
 * 純粋ロジックは暗号処理を引数 cryptoAdapter で受け取るため、Node.js でテストできる。
 */

const TOKEN_FORMAT_VERSION = 1;
const TOKEN_MAX_LENGTH = 512;
const TOKEN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID_PATTERN = /^REQ-\d{8}-\d{4}$/;
const SECRET_MIN_LENGTH = 32;

/**
 * GAS の Utilities を使う暗号処理の窓口。
 * @return {{hmac: function(string, string): string, encode: function(string): string, decode: function(string): string}}
 */
function gasCryptoAdapter_() {
  return {
    hmac: function (message, secret) {
      return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(message, secret));
    },
    encode: function (text) {
      return Utilities.base64EncodeWebSafe(text, Utilities.Charset.UTF_8);
    },
    decode: function (encoded) {
      return Utilities.newBlob(Utilities.base64DecodeWebSafe(encoded, Utilities.Charset.UTF_8)).getDataAsString('UTF-8');
    },
  };
}

/** 鍵が十分な長さかを確かめる（未設定のまま動かさない） */
function assertSecret_(secret) {
  if (typeof secret !== 'string' || secret.length < SECRET_MIN_LENGTH) {
    throw approvalError_('SECRET_NOT_CONFIGURED', '署名用の鍵が未設定または短すぎます');
  }
}

/**
 * トークンの中身を作る。
 * @param {string} tokenId 推測できない乱数（UUID）
 * @param {string} requestId
 * @param {number} step
 * @param {number} nowMs 発行時刻（ミリ秒）
 * @param {number} ttlHours 有効時間
 */
function buildTokenClaims_(tokenId, requestId, step, nowMs, ttlHours) {
  return { v: TOKEN_FORMAT_VERSION, tid: tokenId, rid: requestId, step: step, exp: nowMs + Math.round(ttlHours * 3600 * 1000) };
}

/**
 * 中身に署名してトークン文字列にする。
 * @param {Object} claims buildTokenClaims_ の戻り値
 * @param {string} secret
 * @param {Object} cryptoAdapter
 * @return {string}
 */
function signToken_(claims, secret, cryptoAdapter) {
  assertSecret_(secret);
  validateClaims_(claims);
  const body = cryptoAdapter.encode(JSON.stringify(claims));
  return body + '.' + cryptoAdapter.hmac(body, secret);
}

/**
 * トークンの形式・署名・有効期限を検証し、中身を返す。
 * 署名を先に確かめるため、有効期限を書き換えたトークンは署名不一致になる。
 * @param {string} token
 * @param {string} secret
 * @param {number} nowMs
 * @param {Object} cryptoAdapter
 * @return {{v: number, tid: string, rid: string, step: number, exp: number}}
 */
function verifyToken_(token, secret, nowMs, cryptoAdapter) {
  assertSecret_(secret);
  if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX_LENGTH) {
    throw approvalError_('TOKEN_MALFORMED', 'トークンの形式が不正です');
  }
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw approvalError_('TOKEN_MALFORMED', 'トークンの形式が不正です');
  }
  const expected = cryptoAdapter.hmac(parts[0], secret);
  if (!timingSafeEqual_(expected, parts[1])) {
    throw approvalError_('TOKEN_BAD_SIGNATURE', 'トークンの署名が一致しません');
  }
  let claims;
  try {
    claims = JSON.parse(cryptoAdapter.decode(parts[0]));
  } catch (e) {
    throw approvalError_('TOKEN_MALFORMED', 'トークンの中身を読めません');
  }
  validateClaims_(claims);
  if (nowMs >= claims.exp) throw approvalError_('TOKEN_EXPIRED', 'トークンの有効期限が切れています');
  return claims;
}

/** 中身の項目を確かめる */
function validateClaims_(claims) {
  const ok = claims && typeof claims === 'object' &&
    claims.v === TOKEN_FORMAT_VERSION &&
    typeof claims.tid === 'string' && TOKEN_ID_PATTERN.test(claims.tid) &&
    typeof claims.rid === 'string' && REQUEST_ID_PATTERN.test(claims.rid) &&
    (claims.step === 1 || claims.step === 2) &&
    typeof claims.exp === 'number' && Number.isFinite(claims.exp);
  if (!ok) throw approvalError_('TOKEN_MALFORMED', 'トークンの中身が不正です');
}

/**
 * 長さと内容を一定時間で比較する（比較時間の差から署名を推測されないようにする）。
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function timingSafeEqual_(a, b) {
  const x = String(a);
  const y = String(b);
  // 比較回数は a（サーバーで計算した期待値）の長さだけで決まる
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) {
    diff |= x.charCodeAt(i) ^ (i < y.length ? y.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/**
 * サーバー側の記録とトークンの中身を照合する（1回限り・取り消し・取り違えの確認）。
 * @param {?{tokenId: string, requestId: string, step: number, approver: string,
 *           expiresAt: Date, status: string}} record 承認トークンシートの行。無ければ null
 * @param {Object} claims verifyToken_ の戻り値
 * @param {number} nowMs
 */
function checkTokenRecord_(record, claims, nowMs) {
  if (!record) throw approvalError_('TOKEN_UNKNOWN', '発行記録の無いトークンです');
  if (record.status === TOKEN_STATUS.USED) throw approvalError_('TOKEN_USED', 'このリンクは使用済みです');
  if (record.status !== TOKEN_STATUS.ACTIVE) throw approvalError_('TOKEN_REVOKED', 'このリンクは無効になっています');
  if (record.requestId !== claims.rid || Number(record.step) !== claims.step) {
    throw approvalError_('TOKEN_MISMATCH', 'トークンと記録が一致しません');
  }
  const expiresAt = record.expiresAt instanceof Date ? record.expiresAt.getTime() : Number(new Date(record.expiresAt));
  if (!Number.isFinite(expiresAt) || nowMs >= expiresAt) throw approvalError_('TOKEN_EXPIRED', 'トークンの有効期限が切れています');
}

/**
 * 操作している人が、トークンを割り当てた承認者本人かを確かめる。
 * メールアドレスを取得できない場合は拒否する（確認できないものは通さない）。
 * @param {{approver: string}} record
 * @param {string} activeUserEmail Session.getActiveUser().getEmail() の値
 */
function checkApproverIdentity_(record, activeUserEmail) {
  const actor = normalizeEmail_(activeUserEmail);
  if (actor === '') throw approvalError_('IDENTITY_UNAVAILABLE', '利用者のメールアドレスを確認できません');
  if (actor !== normalizeEmail_(record.approver)) throw approvalError_('UNAUTHORIZED_APPROVER', '割り当てられた承認者ではありません');
  return actor;
}
