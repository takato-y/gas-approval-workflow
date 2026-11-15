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
    /** 本プロジェクトで使う書式（yyyyMMdd）だけを再現する */
    formatDate(date, timeZone, pattern) {
      if (pattern !== 'yyyyMMdd') throw new Error('fake formatDate: unsupported pattern ' + pattern);
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
      const get = (t) => parts.find((p) => p.type === t).value;
      return get('year') + get('month') + get('day');
    },
  };
}

/** シート1枚の偽物。値は2次元配列で持つ（1行目が見出し） */
class FakeSheet {
  constructor(name, rows) {
    this.name = name;
    this.rows = rows.map((r) => r.slice());
  }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  appendRow(row) { this.rows.push(Array.from(row)); return this; }
  getDataRange() { return this.getRange(1, 1, Math.max(this.rows.length, 1), this.width()); }
  width() { return this.rows.reduce((m, r) => Math.max(m, r.length), 1); }
  getRange(row, col, numRows = 1, numCols = 1) {
    const sheet = this;
    return {
      getSheet: () => sheet,
      getNumRows: () => numRows,
      getValues() {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const src = sheet.rows[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < numCols; c++) {
            const v = src[col - 1 + c];
            line.push(v === undefined || v === null ? '' : v);
          }
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        values.forEach((line, r) => {
          while (sheet.rows.length < row + r) sheet.rows.push([]);
          line.forEach((v, c) => { sheet.rows[row - 1 + r][col - 1 + c] = v; });
        });
        return this;
      },
      setValue(v) { return this.setValues([[v]]); },
    };
  }
  /** テスト用: 見出しを除くデータ */
  body() { return this.rows.slice(1); }
}

function createFakeSpreadsheet(sheets) {
  const map = new Map(Object.entries(sheets).map(([name, rows]) => [name, new FakeSheet(name, rows)]));
  const ss = { getSheetByName: (name) => map.get(name) || null, sheet: (name) => map.get(name) };
  return { SpreadsheetApp: { getActiveSpreadsheet: () => ss }, ss };
}

function createFakeMailApp() {
  const sent = [];
  return { MailApp: { sendEmail(message) { sent.push(message); } }, sent };
}

function createFakeProperties(initial) {
  const store = new Map(Object.entries(initial || {}));
  const props = {
    getProperty: (k) => (store.has(k) ? store.get(k) : null),
    setProperty(k, v) { store.set(k, String(v)); return props; },
    deleteProperty(k) { store.delete(k); return props; },
  };
  return { PropertiesService: { getScriptProperties: () => props }, store };
}

/** 排他制御の偽物。held を true にすると「他の処理が実行中」を再現する */
function createFakeLock() {
  const state = { held: false, acquired: 0, released: 0 };
  const lock = {
    tryLock() { if (state.held) return false; state.held = true; state.acquired++; return true; },
    waitLock() { if (!lock.tryLock()) throw new Error('lock timeout'); },
    releaseLock() { state.held = false; state.released++; },
  };
  return { LockService: { getScriptLock: () => lock }, state };
}

/** Session の偽物。user.active / user.effective を書き換えて利用者を切り替える */
function createFakeSession(user) {
  return {
    Session: {
      getActiveUser: () => ({ getEmail: () => user.active }),
      getEffectiveUser: () => ({ getEmail: () => user.effective }),
      getScriptTimeZone: () => 'Asia/Tokyo',
    },
  };
}

function createFakeScriptApp() {
  const triggers = [];
  let seq = 0;
  const makeTrigger = (handler, kind) => {
    const uid = 'trigger-' + (++seq);
    const t = { getUniqueId: () => uid, getHandlerFunction: () => handler, kind };
    triggers.push(t);
    return t;
  };
  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger(t) { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger(handler) {
      return {
        forSpreadsheet: () => ({ onFormSubmit: () => ({ create: () => makeTrigger(handler, 'formSubmit') }) }),
        timeBased: () => ({ everyHours: () => ({ create: () => makeTrigger(handler, 'time') }) }),
      };
    },
  };
  return { ScriptApp, triggers, makeTrigger };
}

function createFakeHtmlService() {
  return {
    HtmlService: {
      createHtmlOutput(html) {
        return { content: html, title: '', setTitle(t) { this.title = t; return this; }, getContent() { return this.content; } };
      },
    },
  };
}

module.exports = {
  createFakeUtilities, toSignedBytes, fromBytes, FakeSheet, createFakeSpreadsheet, createFakeMailApp,
  createFakeProperties, createFakeLock, createFakeSession, createFakeScriptApp, createFakeHtmlService,
};
