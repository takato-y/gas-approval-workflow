/**
 * Config.ts
 * 定数・設定値の読み取り・共通の小さな関数。
 *
 * GAS では全ファイルが同じグローバル空間で読み込まれる。
 * 末尾が `_` の関数は google.script.run から呼べない（非公開）ため、
 * 公開を意図しない関数はすべて末尾に `_` を付ける。
 */

/** シート名 */
/**
 * 日時の表示の書式。メール・管理者への知らせ（Utilities.formatDate の書式）と、
 * シートのセルの表示形式（setNumberFormat の書式）で、同じ見た目にそろえる。
 * 時刻はスクリプトのタイムゾーン（appsscript.json の timeZone）で表す。
 */
const DATETIME_FORMAT = Object.freeze({
  TEXT: 'yyyy/MM/dd HH:mm:ss',
  CELL: 'yyyy/mm/dd hh:mm:ss',
});

const SHEET = Object.freeze({
  FORM: 'フォームの回答 1',
  REQUESTS: '申請一覧',
  RULES: '承認ルール',
  SETTINGS: '設定',
  TOKENS: '承認トークン',
  AUDIT: '監査ログ',
});

/** 申請の状態 */
const STATUS = Object.freeze({
  PENDING: '承認待ち',
  APPROVED: '承認済み',
  REJECTED: '却下',
});

/** トークンの状態 */
const TOKEN_STATUS = Object.freeze({
  ACTIVE: '有効',
  USED: '使用済み',
  REVOKED: '失効',
});

/** スクリプトのプロパティのキー（値はコードに書かない） */
const PROP_KEYS = Object.freeze({
  SECRET: 'APPROVAL_HMAC_SECRET',
  WEBAPP_URL: 'WEBAPP_URL',
  REMINDER_LAST_RUN: 'REMINDER_LAST_RUN_AT',
});

/** 申請フォームの選択肢 */
const FORM_CHOICES = Object.freeze({
  DEPARTMENTS: ['総務部', '営業部', '開発部', '製造部', '経理部'],
  CATEGORIES: ['経費', '備品購入'],
});

/** 入力の上限 */
const LIMITS = Object.freeze({
  AMOUNT_MIN: 1,
  AMOUNT_MAX_EXCLUSIVE: 100000000,
  ITEM_MAX_LENGTH: 200,
  REASON_MAX_LENGTH: 500,
  COMMENT_MAX_LENGTH: 500,
});

interface SettingDef {
  label: string;
  key: keyof Settings;
  type: 'number' | 'email' | 'domain';
  defaultValue: number | string;
}

/** 設定シートの項目名と内部名の対応・初期値 */
const SETTING_DEFS: ReadonlyArray<SettingDef> = Object.freeze([
  { label: '多段承認しきい値', key: 'multiStepThreshold', type: 'number', defaultValue: 100000 },
  { label: '最終承認者メール', key: 'finalApprover', type: 'email', defaultValue: '' },
  { label: '管理者メール', key: 'adminEmail', type: 'email', defaultValue: '' },
  { label: 'トークン有効時間', key: 'tokenTtlHours', type: 'number', defaultValue: 72 },
  { label: '督促開始時間', key: 'remindAfterHours', type: 'number', defaultValue: 24 },
  { label: '督促上限回数', key: 'maxReminders', type: 'number', defaultValue: 3 },
  // 任意。指定すると、このドメイン以外のメールアドレスからの申請を受け付けない（社外アドレスの入力を防ぐ）
  { label: '申請者ドメイン', key: 'applicantDomain', type: 'domain', defaultValue: '' },
] as SettingDef[]);

/** エラーコード付きの Error を作る */
function approvalError_(code: string, message?: string): ApprovalError {
  const error = new Error(message || code) as ApprovalError;
  error.code = code;
  return error;
}

/** 捕まえた例外からエラーコードを取り出す。想定外の例外なら null */
function errorCode_(err: unknown): string | null {
  if (err && typeof err === 'object' && typeof (err as ApprovalError).code === 'string') return (err as ApprovalError).code;
  return null;
}

/** 日時（Date または日時の文字列）をミリ秒にする。読めなければ NaN */
function toMillis_(value: unknown): number {
  if (value && typeof (value as Date).getTime === 'function') return (value as Date).getTime();
  if (value === '' || value == null) return NaN;
  return new Date(String(value)).getTime();
}

/** メールアドレスを比較用に正規化する（前後の空白除去・小文字化） */
function normalizeEmail_(value: unknown): string {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * メールアドレスの形式を簡易に確認する。
 * 先頭は英数字に限る（「=」「+」「-」「@」で始まる値はシートで数式として扱われるおそれがあるため）。
 */
function isValidEmail_(value: unknown): boolean {
  return /^[A-Za-z0-9][^\s@]*@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

/** ドメイン名の形式を簡易に確認する */
function isValidDomain_(value: unknown): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(String(value || ''));
}

/**
 * 設定シートの値（[項目, 値] の2次元配列・見出し行を除く）を設定オブジェクトにする。
 * 不正な値は初期値で補わず、エラーにする（誤った承認者へ回さないため）。
 */
function parseSettings_(rows: CellValue[][]): Settings {
  const byLabel: { [label: string]: CellValue } = {};
  (rows || []).forEach(function (row) {
    if (row && row[0] !== '' && row[0] != null) byLabel[String(row[0]).trim()] = row[1];
  });
  const settings = {} as { [K in keyof Settings]: Settings[K] };
  SETTING_DEFS.forEach(function (def) {
    const raw = Object.prototype.hasOwnProperty.call(byLabel, def.label) ? byLabel[def.label] : '';
    const target = settings as unknown as { [key: string]: number | string };
    if (raw === '' || raw == null) {
      if (def.type === 'email') throw approvalError_('INVALID_SETTING', def.label + ' が未設定です');
      target[def.key] = def.defaultValue;
      return;
    }
    if (def.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) throw approvalError_('INVALID_SETTING', def.label + ' は正の数で指定してください');
      target[def.key] = n;
    } else if (def.type === 'domain') {
      const domain = String(raw).trim().toLowerCase().replace(/^@/, '');
      if (!isValidDomain_(domain)) throw approvalError_('INVALID_SETTING', def.label + ' の形式が不正です');
      target[def.key] = domain;
    } else {
      const email = normalizeEmail_(raw);
      if (!isValidEmail_(email)) throw approvalError_('INVALID_SETTING', def.label + ' の形式が不正です');
      target[def.key] = email;
    }
  });
  return settings;
}
