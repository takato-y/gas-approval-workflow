/**
 * fakes.js
 * GAS サービスのテスト用の偽物。実物の仕様のうち、本プロジェクトが使う部分だけを再現する。
 */
'use strict';

const crypto = require('node:crypto');

/** Java の byte（-128〜127）配列に変換する。GAS の Byte[] に合わせる */
function toSignedBytes(buffer) {
  return Array.from(buffer, (b) => (b > 127 ? b - 256 : b));
}
function fromBytes(bytes) {
  return Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b)));
}
/** GAS の base64EncodeWebSafe は「-」「_」を使い、末尾の「=」を残す */
function toWebSafe(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function createFakeUtilities() {
  return {
    Charset: { UTF_8: 'UTF-8' },
    computeHmacSha256Signature(value, key) {
      return toSignedBytes(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest());
    },
    base64EncodeWebSafe(data) {
      return toWebSafe(typeof data === 'string' ? Buffer.from(data, 'utf8') : fromBytes(data));
    },
    base64DecodeWebSafe(encoded) {
      return toSignedBytes(Buffer.from(String(encoded).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    },
    newBlob(bytes) {
      return { getDataAsString: () => fromBytes(bytes).toString('utf8') };
    },
    getUuid() {
      return crypto.randomUUID();
    },
  };
}

module.exports = { createFakeUtilities, toSignedBytes, fromBytes };
