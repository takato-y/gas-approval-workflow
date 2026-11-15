/**
 * fakes.ts
 * GAS サービスのテスト用の偽物。実物の仕様のうち、本プロジェクトが使う部分だけを再現する。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Cell = string | number | boolean | Date;

/** Java の byte（-128〜127）配列に変換する。GAS の Byte[] に合わせる */
export function toSignedBytes(buffer: Uint8Array): number[] {
  return Array.from(buffer, (b) => (b > 127 ? b - 256 : b));
}
export function fromBytes(bytes: number[]): Buffer {
  return Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b)));
}
/** GAS の base64EncodeWebSafe は「-」「_」を使い、末尾の「=」を残す */
function toWebSafe(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function createFakeUtilities() {
  return {
    Charset: { UTF_8: 'UTF-8' },
    computeHmacSha256Signature(value: string, key: string): number[] {
      return toSignedBytes(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest());
    },
    base64EncodeWebSafe(data: string | number[]): string {
      return toWebSafe(typeof data === 'string' ? Buffer.from(data, 'utf8') : fromBytes(data));
    },
    base64DecodeWebSafe(encoded: string): number[] {
      return toSignedBytes(Buffer.from(String(encoded).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    },
    newBlob(bytes: number[]) {
      return { getDataAsString: () => fromBytes(bytes).toString('utf8') };
    },
    getUuid(): string {
      return crypto.randomUUID();
    },
    /** 本プロジェクトで使う書式（yyyyMMdd）だけを再現する */
    formatDate(date: Date, timeZone: string, pattern: string): string {
      if (pattern !== 'yyyyMMdd') throw new Error('fake formatDate: unsupported pattern ' + pattern);
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
      const get = (t: string) => parts.find((p) => p.type === t)!.value;
      return get('year') + get('month') + get('day');
    },
  };
}

export interface FakeRange {
  getSheet(): FakeSheet;
  getNumRows(): number;
  getValues(): Cell[][];
  setValues(values: Cell[][]): FakeRange;
  setValue(v: Cell): FakeRange;
}

/** シート1枚の偽物。値は2次元配列で持つ（1行目が見出し） */
export class FakeSheet {
  name: string;
  rows: Cell[][];
  constructor(name: string, rows: Cell[][]) {
    this.name = name;
    this.rows = rows.map((r) => r.slice());
  }
  getName(): string { return this.name; }
  getLastRow(): number { return this.rows.length; }
  /** vm 内で作られた配列も Node 側の配列として持つ（比較しやすくするため） */
  appendRow(row: Cell[]): FakeSheet { this.rows.push(Array.from(row)); return this; }
  getDataRange(): FakeRange { return this.getRange(1, 1, Math.max(this.rows.length, 1), this.width()); }
  width(): number { return this.rows.reduce((m, r) => Math.max(m, r.length), 1); }
  getRange(row: number, col: number, numRows = 1, numCols = 1): FakeRange {
    const sheet = this;
    const range: FakeRange = {
      getSheet: () => sheet,
      getNumRows: () => numRows,
      getValues() {
        const out: Cell[][] = [];
        for (let r = 0; r < numRows; r++) {
          const src = sheet.rows[row - 1 + r] || [];
          const line: Cell[] = [];
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
        return range;
      },
      setValue(v) { return range.setValues([[v]]); },
    };
    return range;
  }
  /** テスト用: 見出しを除くデータ */
  body(): Cell[][] { return this.rows.slice(1); }
}

export function createFakeSpreadsheet(sheets: Record<string, Cell[][]>) {
  const map = new Map(Object.entries(sheets).map(([name, rows]) => [name, new FakeSheet(name, rows)]));
  const ss = {
    getSheetByName: (name: string) => map.get(name) || null,
    sheet: (name: string): FakeSheet => {
      const s = map.get(name);
      if (!s) throw new Error('no sheet: ' + name);
      return s;
    },
  };
  return { SpreadsheetApp: { getActiveSpreadsheet: () => ss }, ss };
}

export interface SentMail { to: string; subject: string; body: string; name?: string }

export function createFakeMailApp() {
  const sent: SentMail[] = [];
  return { MailApp: { sendEmail(message: SentMail) { sent.push(message); } }, sent };
}

export function createFakeProperties(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial || {}));
  const props = {
    getProperty: (k: string) => (store.has(k) ? store.get(k)! : null),
    setProperty(k: string, v: string) { store.set(k, String(v)); return props; },
    deleteProperty(k: string) { store.delete(k); return props; },
  };
  return { PropertiesService: { getScriptProperties: () => props }, store };
}

/** 排他制御の偽物。held を true にすると「他の処理が実行中」を再現する */
export function createFakeLock() {
  const state = { held: false, acquired: 0, released: 0 };
  const lock = {
    tryLock(): boolean { if (state.held) return false; state.held = true; state.acquired++; return true; },
    releaseLock(): void { state.held = false; state.released++; },
  };
  return { LockService: { getScriptLock: () => lock }, state };
}

/** Session の偽物。user.active / user.effective を書き換えて利用者を切り替える */
export function createFakeSession(user: { active: string; effective: string }) {
  return {
    Session: {
      getActiveUser: () => ({ getEmail: () => user.active }),
      getEffectiveUser: () => ({ getEmail: () => user.effective }),
      getScriptTimeZone: () => 'Asia/Tokyo',
    },
  };
}

export interface FakeTrigger { getUniqueId(): string; getHandlerFunction(): string; kind: string }

export function createFakeScriptApp() {
  const triggers: FakeTrigger[] = [];
  let seq = 0;
  const makeTrigger = (handler: string, kind: string): FakeTrigger => {
    const uid = 'trigger-' + (++seq);
    const t = { getUniqueId: () => uid, getHandlerFunction: () => handler, kind };
    triggers.push(t);
    return t;
  };
  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger(t: FakeTrigger) { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger(handler: string) {
      return {
        forSpreadsheet: () => ({ onFormSubmit: () => ({ create: () => makeTrigger(handler, 'formSubmit') }) }),
        timeBased: () => ({ everyHours: () => ({ create: () => makeTrigger(handler, 'time') }) }),
      };
    },
  };
  return { ScriptApp, triggers, makeTrigger };
}

export interface FakeHtmlOutput { content: string; title: string; setTitle(t: string): FakeHtmlOutput; getContent(): string }

function htmlOutput(content: string): FakeHtmlOutput {
  return { content, title: '', setTitle(t) { this.title = t; return this; }, getContent() { return this.content; } };
}

/** HTML 特殊文字のエスケープ（GAS の印字スクリプトレット <?= ?> の HTML 文脈での扱いを再現） */
function escapeForTemplate(value: unknown): string {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * HtmlService の偽物。createTemplateFromFile は src/<名前>.html を読み、
 * 印字スクリプトレット `<?= 名前.項目 ?>` だけを解釈する（それ以外の記法は使っていない）。
 */
export function createFakeHtmlService(srcDir: string) {
  return {
    HtmlService: {
      createHtmlOutput: (html: string) => htmlOutput(html),
      createTemplateFromFile(name: string) {
        const source = fs.readFileSync(path.join(srcDir, name + '.html'), 'utf8');
        const template: Record<string, unknown> & { evaluate(): FakeHtmlOutput } = {
          evaluate() {
            const rendered = source.replace(/<\?=\s*([\w.]+)\s*\?>/g, (_m, expr: string) => {
              let v: unknown = template;
              for (const key of expr.split('.')) v = v == null ? undefined : (v as Record<string, unknown>)[key];
              if (v === undefined) throw new Error('template value missing: ' + expr);
              return escapeForTemplate(v);
            });
            if (/<\?/.test(rendered)) throw new Error('unsupported scriptlet in ' + name);
            return htmlOutput(rendered);
          },
        };
        return template;
      },
    },
  };
}
