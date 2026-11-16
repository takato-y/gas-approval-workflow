/**
 * sample-data.ts
 * 手元での動作説明用に、架空のサンプルデータ（シートごとの CSV）を作る関数群。
 * 乱数は種（seed）から決まるため、同じ種なら毎回同じデータになる。
 * 人名は使わず、メールアドレスはすべて example.com の役割名にする。
 */

export type Row = Array<string | number>;

/** 各シートの見出し（GAS 側の SHEET_HEADERS と同じであることをテストで確かめる） */
export const HEADERS = {
  form: ['タイムスタンプ', 'メールアドレス', '部署', '申請区分', '品目・内容', '金額', '理由'],
  requests: ['申請ID', '申請日時', '申請者メール', '部署', '申請区分', '品目・内容', '金額', '理由',
    '状態', '現在段階', '総段階', '承認経路', '最終通知日時', '督促回数', '更新日時'],
  tokens: ['トークンID', '申請ID', '段階', '承認者メール', '発行日時', '有効期限', '使用日時', '状態'],
  audit: ['日時', '申請ID', '操作', '実行者', '結果', '詳細'],
  rules: ['部署', '金額下限', '金額上限', '承認者メール', '代理承認者メール'],
  settings: ['項目', '値'],
  employees: ['メールアドレス', '氏名'],
} as const;

export const DEPARTMENTS = ['総務部', '営業部', '開発部', '製造部', '経理部'] as const;
const DEPT_CODE: Record<string, string> = { 総務部: 'general', 営業部: 'sales', 開発部: 'dev', 製造部: 'mfg', 経理部: 'acct' };

const ITEMS: Record<string, Array<[string, number, number, string]>> = {
  経費: [
    ['出張旅費（新幹線）', 8000, 60000, '顧客訪問のため'],
    ['会議用の飲食費', 2000, 30000, '取引先との打ち合わせ'],
    ['書籍購入', 1500, 12000, '業務知識の習得のため'],
    ['研修受講料', 20000, 180000, '資格取得のため'],
  ],
  備品購入: [
    ['ノートPC', 90000, 320000, '故障による入れ替え'],
    ['モニター', 18000, 60000, '在宅勤務用'],
    ['事務用椅子', 15000, 90000, '老朽化による交換'],
    ['複合機トナー', 6000, 40000, '在庫切れのため'],
  ],
};

/** 承認ルールの境界をまたぐ金額（境界値の確認に使う） */
const BOUNDARY_AMOUNTS = [49999, 50000, 99999, 100000];

/** 種から決まる疑似乱数（mulberry32） */
export function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function settingsRows(threshold: number): Row[] {
  return [
    ['多段承認しきい値', threshold],
    ['最終承認者メール', 'cfo@example.com'],
    ['管理者メール', 'admin@example.com'],
    ['トークン有効時間', 72],
    ['督促開始時間', 24],
    ['督促上限回数', 3],
    ['申請者ドメイン', 'example.com'],
  ];
}

export function ruleRows(): Row[] {
  return [
    ['開発部', 0, 50000, 'dev-lead@example.com', 'dev-sub@example.com'],
    ['*', 0, 50000, 'manager@example.com', 'manager-sub@example.com'],
    ['*', 50000, '', 'director@example.com', 'director-sub@example.com'],
  ];
}

/** 日時を「yyyy/MM/dd HH:mm:ss」（日本時間）にする。スプレッドシートの取り込みで日時として扱われる形 */
export function formatJst(ms: number): string {
  const d = new Date(ms + 9 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '/' + p(d.getUTCMonth() + 1) + '/' + p(d.getUTCDate()) + ' ' +
    p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

export interface FormOptions {
  count: number;
  seed: number;
  /** 最初の申請の日時（ミリ秒） */
  startMs: number;
  /** 入力が不正な行（小数の金額・選択肢にない部署）を混ぜる */
  withInvalid: boolean;
}

/**
 * 社員名簿のサンプル行を作る。人名は使わず「部署 社員NN」の役割名にする。
 * フォームの回答のサンプルに出てくる申請者（各部署の staff01〜20）を、すべて載せる。
 */
export function employeeRows(): Row[] {
  const rows: Row[] = [];
  for (const dept of DEPARTMENTS) {
    for (let n = 1; n <= 20; n++) {
      const nn = String(n).padStart(2, '0');
      rows.push(['staff' + nn + '.' + DEPT_CODE[dept] + '@example.com', dept + ' 社員' + nn]);
    }
  }
  return rows;
}

/** フォームの回答のサンプル行を作る */
export function formRows(opt: FormOptions): Row[] {
  const rand = createRandom(opt.seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const rows: Row[] = [];
  for (let i = 0; i < opt.count; i++) {
    const dept = pick(DEPARTMENTS);
    const category = rand() < 0.5 ? '経費' : '備品購入';
    const [item, min, max, reason] = pick(ITEMS[category]);
    // 4件に1件は承認ルールの境界の金額にする
    const amount = i % 4 === 3 ? BOUNDARY_AMOUNTS[(i >> 2) % BOUNDARY_AMOUNTS.length] : Math.round((min + rand() * (max - min)) / 100) * 100;
    const staff = 'staff' + String(1 + Math.floor(rand() * 20)).padStart(2, '0') + '.' + DEPT_CODE[dept] + '@example.com';
    const at = opt.startMs + i * 37 * 60 * 1000;
    rows.push([formatJst(at), staff, dept, category, item, amount, reason]);
  }
  if (opt.withInvalid) {
    const at = opt.startMs + opt.count * 37 * 60 * 1000;
    rows.push([formatJst(at), 'staff99.sales@example.com', '営業部', '経費', 'タクシー代', '1234.5', '小数の金額（受付で拒否される例）']);
    rows.push([formatJst(at + 60000), 'staff98.general@example.com', '人事部', '備品購入', '名刺', 3000, '選択肢にない部署（受付で拒否される例）']);
  }
  return rows;
}

/**
 * CSV の1セルにする。区切り文字・引用符・改行を含む値は引用符で囲む。
 * 「=」「+」「-」「@」で始まる文字列は、表計算ソフトで数式として動かないよう先頭に ' を付ける。
 */
export function csvCell(value: string | number): string {
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(header: readonly string[], rows: Row[], bom: boolean): string {
  const lines = [header.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return (bom ? '﻿' : '') + lines.join('\r\n') + '\r\n';
}

export interface SampleOptions extends FormOptions {
  threshold: number;
  bom: boolean;
}

/** シート名 → CSV の内容 */
export function buildSampleFiles(opt: SampleOptions): Record<string, string> {
  return {
    '設定.csv': toCsv(HEADERS.settings, settingsRows(opt.threshold), opt.bom),
    '承認ルール.csv': toCsv(HEADERS.rules, ruleRows(), opt.bom),
    'フォームの回答 1.csv': toCsv(HEADERS.form, formRows(opt), opt.bom),
    '申請一覧.csv': toCsv(HEADERS.requests, [], opt.bom),
    '承認トークン.csv': toCsv(HEADERS.tokens, [], opt.bom),
    '監査ログ.csv': toCsv(HEADERS.audit, [], opt.bom),
    '社員名簿.csv': toCsv(HEADERS.employees, employeeRows(), opt.bom),
  };
}
