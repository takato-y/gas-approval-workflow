/**
 * Repository.ts
 * スプレッドシートの読み書き。シートの列の位置はこのファイルだけが知る。
 */

/** 申請一覧の列（0始まり） */
const REQ_COL = Object.freeze({
  ID: 0, SUBMITTED_AT: 1, APPLICANT: 2, DEPARTMENT: 3, CATEGORY: 4, ITEM: 5, AMOUNT: 6, REASON: 7,
  STATUS: 8, CURRENT_STEP: 9, TOTAL_STEPS: 10, ROUTE: 11, LAST_NOTIFIED_AT: 12, REMINDER_COUNT: 13, UPDATED_AT: 14,
});
const REQ_WIDTH = 15;

/** 承認トークンの列（0始まり） */
const TOKEN_COL = Object.freeze({
  ID: 0, REQUEST_ID: 1, STEP: 2, APPROVER: 3, ISSUED_AT: 4, EXPIRES_AT: 5, USED_AT: 6, STATUS: 7,
});
const TOKEN_WIDTH = 8;

/** 各シートの見出し行（初期設定・サンプルデータ作成で使う） */
const SHEET_HEADERS: Readonly<{ [sheet: string]: string[] }> = Object.freeze({
  申請一覧: ['申請ID', '申請日時', '申請者メール', '部署', '申請区分', '品目・内容', '金額', '理由',
    '状態', '現在段階', '総段階', '承認経路', '最終通知日時', '督促回数', '更新日時'],
  承認トークン: ['トークンID', '申請ID', '段階', '承認者メール', '発行日時', '有効期限', '使用日時', '状態'],
  監査ログ: ['日時', '申請ID', '操作', '実行者', '結果', '詳細'],
});

/**
 * セルに書く文字列が数式として解釈されないようにする（数式インジェクション対策）。
 * フォームの自由入力を、そのままシートに書かないために使う。
 */
function sanitizeCell_<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

function getSheet_(name: string): GoogleAppsScript.Spreadsheet.Sheet {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw approvalError_('SHEET_NOT_FOUND', 'シートがありません: ' + name);
  return sheet;
}

/** 見出し行を除いたデータを返す */
function readBody_(name: string): CellValue[][] {
  return getSheet_(name).getDataRange().getValues().slice(1) as CellValue[][];
}

function readSettings_(): Settings {
  return parseSettings_(readBody_(SHEET.SETTINGS));
}

function readRules_(): Rule[] {
  return parseRules_(readBody_(SHEET.RULES));
}

/** 申請IDを採番する（REQ-年月日-連番）。排他制御の中で呼ぶこと */
function nextRequestId_(now: Date): string {
  const day = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd');
  const prefix = 'REQ-' + day + '-';
  let max = 0;
  readBody_(SHEET.REQUESTS).forEach(function (row) {
    const id = String(row[REQ_COL.ID]);
    if (id.indexOf(prefix) === 0) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
  });
  if (max >= 9999) throw approvalError_('ID_EXHAUSTED', '本日の申請IDが上限に達しました');
  return prefix + ('000' + (max + 1)).slice(-4);
}

/** 申請一覧の1行を申請オブジェクトにする */
function rowToRequest_(row: CellValue[]): ApprovalRequest {
  let route: RouteStep[] = [];
  try { route = JSON.parse(String(row[REQ_COL.ROUTE] || '[]')); } catch (e) { route = []; }
  return {
    id: String(row[REQ_COL.ID]),
    submittedAt: row[REQ_COL.SUBMITTED_AT] as Date,
    applicant: normalizeEmail_(row[REQ_COL.APPLICANT]),
    department: String(row[REQ_COL.DEPARTMENT]),
    category: String(row[REQ_COL.CATEGORY]),
    item: String(row[REQ_COL.ITEM]),
    amount: Number(row[REQ_COL.AMOUNT]),
    reason: String(row[REQ_COL.REASON]),
    status: String(row[REQ_COL.STATUS]),
    currentStep: Number(row[REQ_COL.CURRENT_STEP]),
    totalSteps: Number(row[REQ_COL.TOTAL_STEPS]),
    route: route,
    lastNotifiedAt: row[REQ_COL.LAST_NOTIFIED_AT] as Date | string,
    reminderCount: Number(row[REQ_COL.REMINDER_COUNT]) || 0,
    updatedAt: row[REQ_COL.UPDATED_AT] as Date | string,
  };
}

/** 申請オブジェクトを申請一覧の1行にする */
function requestToRow_(r: ApprovalRequest): CellValue[] {
  const row: CellValue[] = new Array(REQ_WIDTH);
  row[REQ_COL.ID] = r.id;
  row[REQ_COL.SUBMITTED_AT] = r.submittedAt;
  row[REQ_COL.APPLICANT] = r.applicant;
  row[REQ_COL.DEPARTMENT] = r.department;
  row[REQ_COL.CATEGORY] = r.category;
  row[REQ_COL.ITEM] = sanitizeCell_(r.item);
  row[REQ_COL.AMOUNT] = r.amount;
  row[REQ_COL.REASON] = sanitizeCell_(r.reason);
  row[REQ_COL.STATUS] = r.status;
  row[REQ_COL.CURRENT_STEP] = r.currentStep;
  row[REQ_COL.TOTAL_STEPS] = r.totalSteps;
  row[REQ_COL.ROUTE] = JSON.stringify(r.route);
  row[REQ_COL.LAST_NOTIFIED_AT] = r.lastNotifiedAt || '';
  row[REQ_COL.REMINDER_COUNT] = r.reminderCount || 0;
  row[REQ_COL.UPDATED_AT] = r.updatedAt || '';
  return row;
}

function appendRequest_(request: ApprovalRequest): void {
  getSheet_(SHEET.REQUESTS).appendRow(requestToRow_(request));
}

/** @return rowNumber はシート上の行番号（1始まり） */
function findRequest_(requestId: string): { rowNumber: number; request: ApprovalRequest } | null {
  const body = readBody_(SHEET.REQUESTS);
  for (let i = 0; i < body.length; i++) {
    if (String(body[i][REQ_COL.ID]) === requestId) return { rowNumber: i + 2, request: rowToRequest_(body[i]) };
  }
  return null;
}

/** 承認待ちの申請をすべて返す */
function listPendingRequests_(): Array<{ rowNumber: number; request: ApprovalRequest }> {
  return readBody_(SHEET.REQUESTS)
    .map(function (row, i) { return { rowNumber: i + 2, request: rowToRequest_(row) }; })
    .filter(function (x) { return x.request.status === STATUS.PENDING; });
}

function updateRequest_(rowNumber: number, request: ApprovalRequest): void {
  getSheet_(SHEET.REQUESTS).getRange(rowNumber, 1, 1, REQ_WIDTH).setValues([requestToRow_(request)]);
}

function appendTokenRecord_(record: Pick<TokenRecord, 'tokenId' | 'requestId' | 'step' | 'approver' | 'issuedAt' | 'expiresAt'>): void {
  const row: CellValue[] = new Array(TOKEN_WIDTH);
  row[TOKEN_COL.ID] = record.tokenId;
  row[TOKEN_COL.REQUEST_ID] = record.requestId;
  row[TOKEN_COL.STEP] = record.step;
  row[TOKEN_COL.APPROVER] = record.approver;
  row[TOKEN_COL.ISSUED_AT] = record.issuedAt;
  row[TOKEN_COL.EXPIRES_AT] = record.expiresAt;
  row[TOKEN_COL.USED_AT] = '';
  row[TOKEN_COL.STATUS] = TOKEN_STATUS.ACTIVE;
  getSheet_(SHEET.TOKENS).appendRow(row);
}

function findTokenRecord_(tokenId: string): { rowNumber: number; record: TokenRecord } | null {
  const body = readBody_(SHEET.TOKENS);
  for (let i = 0; i < body.length; i++) {
    const row = body[i];
    if (String(row[TOKEN_COL.ID]) === tokenId) {
      return {
        rowNumber: i + 2,
        record: {
          tokenId: String(row[TOKEN_COL.ID]),
          requestId: String(row[TOKEN_COL.REQUEST_ID]),
          step: Number(row[TOKEN_COL.STEP]),
          approver: normalizeEmail_(row[TOKEN_COL.APPROVER]),
          issuedAt: row[TOKEN_COL.ISSUED_AT] as Date | string,
          expiresAt: row[TOKEN_COL.EXPIRES_AT] as Date | string,
          usedAt: row[TOKEN_COL.USED_AT] as Date | string,
          status: String(row[TOKEN_COL.STATUS]),
        },
      };
    }
  }
  return null;
}

function markTokenUsed_(rowNumber: number, now: Date): void {
  getSheet_(SHEET.TOKENS).getRange(rowNumber, TOKEN_COL.USED_AT + 1, 1, 2).setValues([[now, TOKEN_STATUS.USED]]);
}

/** 申請の有効なトークンをすべて失効させる（督促でリンクを再発行するとき） */
function revokeActiveTokens_(requestId: string): number {
  const sheet = getSheet_(SHEET.TOKENS);
  let count = 0;
  readBody_(SHEET.TOKENS).forEach(function (row, i) {
    if (String(row[TOKEN_COL.REQUEST_ID]) === requestId && row[TOKEN_COL.STATUS] === TOKEN_STATUS.ACTIVE) {
      sheet.getRange(i + 2, TOKEN_COL.STATUS + 1).setValue(TOKEN_STATUS.REVOKED);
      count++;
    }
  });
  return count;
}

/** 監査ログに1行追記する。既存行は書き換えない */
function appendAudit_(entry: { at: Date; requestId: string; operation: string; actor: string; result: string; detail: string }): void {
  getSheet_(SHEET.AUDIT).appendRow([
    entry.at,
    entry.requestId || '',
    entry.operation,
    sanitizeCell_(entry.actor || ''),
    entry.result,
    sanitizeCell_(String(entry.detail || '').slice(0, 500)),
  ]);
}
