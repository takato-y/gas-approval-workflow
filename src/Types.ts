/**
 * Types.ts
 * 全ファイルで共有する型（GAS ではファイルを跨いで同じグローバル空間になるため、import は使わない）。
 * 型はコンパイル時に消えるため、実行時の負担は無い。
 */

/** エラーコード付きの Error */
interface ApprovalError extends Error {
  code: string;
}

/** シートのセルに入る値 */
type CellValue = string | number | boolean | Date;

/** 承認経路の1段 */
interface RouteStep {
  step: number;
  approver: string;
}

/** 設定シートの内容 */
interface Settings {
  multiStepThreshold: number;
  finalApprover: string;
  adminEmail: string;
  tokenTtlHours: number;
  remindAfterHours: number;
  maxReminders: number;
  /** 空文字なら確認しない */
  applicantDomain: string;
}

/** 承認ルールの1行 */
interface Rule {
  department: string;
  min: number;
  max: number | null;
  approver: string;
  delegate: string;
}

/** フォーム回答から作る申請の入力部分 */
interface FormInput {
  submittedAt: Date;
  applicant: string;
  department: string;
  category: string;
  item: string;
  amount: number;
  reason: string;
}

/** 申請一覧の1行 */
interface ApprovalRequest extends FormInput {
  id: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  route: RouteStep[];
  lastNotifiedAt: Date | string;
  reminderCount: number;
  updatedAt: Date | string;
}

/** トークンの中身 */
interface TokenClaims {
  v: number;
  tid: string;
  rid: string;
  step: number;
  exp: number;
}

/** 承認トークンシートの1行 */
interface TokenRecord {
  tokenId: string;
  requestId: string;
  step: number;
  approver: string;
  issuedAt: Date | string;
  expiresAt: Date | string;
  usedAt: Date | string;
  status: string;
}

/** 暗号処理の窓口（GAS では Utilities、テストでは Node.js の crypto を使う代替部品） */
interface CryptoAdapter {
  hmac(message: string, secret: string): string;
  encode(text: string): string;
  decode(encoded: string): string;
}

/** 送信するメール */
interface Mail {
  to: string;
  subject: string;
  body: string;
}

/** 確認画面のボタンへの返事 */
interface DecisionResult {
  ok: boolean;
  message: string;
}

/** 状態遷移の結果 */
interface TransitionResult {
  status: string;
  currentStep: number;
  totalSteps: number;
  completed: boolean;
  nextStep: number | null;
}
