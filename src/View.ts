/**
 * View.ts
 * 承認画面（Approval.html）・案内画面（Message.html）の組み立て。
 *
 * 画面の HTML・CSS・画面側のスクリプトは .html ファイルに分け、ここでは表示する値だけを渡す。
 * 値の埋め込みは印字スクリプトレット `<?= ?>` だけを使う（GAS が文脈に応じてエスケープする）。
 * エスケープしない `<?!= ?>` は使わない。
 */

/** 承認画面に渡す値 */
interface DecisionView {
  id: string;
  applicant: string;
  department: string;
  category: string;
  item: string;
  amountText: string;
  reason: string;
  stepText: string;
  token: string;
  nonce: string;
  commentMax: number;
}

/** 案内だけを表示する画面 */
function renderMessagePage_(title: string, message: string): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile('Message');
  template.view = { title, message };
  return template.evaluate();
}

/** 承認画面に渡す値を作る（純粋ロジック） */
function buildDecisionView_(request: ApprovalRequest, step: number, token: string, nonce: string): DecisionView {
  return {
    id: request.id,
    applicant: applicantLabel_(request),
    department: request.department,
    category: request.category,
    item: request.item,
    amountText: formatYen_(request.amount),
    reason: request.reason,
    stepText: step + ' / ' + request.totalSteps,
    token,
    nonce,
    commentMax: LIMITS.COMMENT_MAX_LENGTH,
  };
}

/**
 * 承認・却下の確認画面。開いただけでは状態を変えず、
 * 画面で「承認する／却下する」→「確定する」の2回の操作をしたときに submitDecision を呼ぶ。
 */
function renderDecisionPage_(request: ApprovalRequest, step: number, token: string, nonce: string): GoogleAppsScript.HTML.HtmlOutput {
  const template = HtmlService.createTemplateFromFile('Approval');
  template.view = buildDecisionView_(request, step, token, nonce);
  return template.evaluate();
}

/** エラーコードを利用者向けの文に置き換える（内部の詳細は画面に出さない） */
function userMessageFor_(code: string | null): string {
  switch (code) {
    case 'TOKEN_EXPIRED': return 'このリンクは有効期限が切れています。督促メールの新しいリンクをお待ちください。';
    case 'TOKEN_USED':
    case 'ALREADY_DECIDED': return 'この申請は既に処理済みです。';
    case 'TOKEN_REVOKED': return 'このリンクは無効になっています。新しいメールのリンクを開いてください。';
    case 'UNAUTHORIZED_APPROVER':
    case 'IDENTITY_UNAVAILABLE': return 'この申請の承認者として確認できませんでした。会社のアカウントでログインしているか確認してください。';
    case 'COMMENT_REQUIRED': return '却下の理由を入力してください。';
    case 'CONFIRM_EXPIRED': return '画面を開いてから時間が経ちました。メールのリンクから開き直してください。';
    case 'CONFIRM_INVALID': return '確認画面から操作してください。メールのリンクから開き直してください。';
    case 'BUSY': return '他の処理と重なりました。少し待ってからもう一度押してください。';
    case 'FLUSH_FAILED': return '保存できたか確認できませんでした。管理者に連絡しました。少し待ってからメールのリンクを開き直し、状態を確認してください。';
    default: return 'このリンクは無効です。';
  }
}
