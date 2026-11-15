/**
 * Routing.ts
 * フォーム回答の検査と承認経路の決定（純粋ロジック・Google のサービスを使わない）。
 */

/**
 * フォーム回答の1行を申請の入力にする。入力に問題があればエラーにする。
 * @param values [タイムスタンプ, メール, 部署, 申請区分, 品目・内容, 金額, 理由]
 */
function parseFormResponse_(values: CellValue[]): FormInput {
  if (!Array.isArray(values) || values.length < 7) {
    throw approvalError_('INVALID_INPUT', 'フォーム回答の列数が不足しています');
  }
  const submittedAt = values[0] instanceof Date ? values[0] : new Date(String(values[0]));
  if (isNaN(submittedAt.getTime())) throw approvalError_('INVALID_INPUT', 'タイムスタンプが不正です');

  const applicant = normalizeEmail_(values[1]);
  if (!isValidEmail_(applicant)) throw approvalError_('INVALID_INPUT', 'メールアドレスが不正です');

  const department = String(values[2] || '').trim();
  if (FORM_CHOICES.DEPARTMENTS.indexOf(department) < 0) throw approvalError_('INVALID_INPUT', '部署が選択肢にありません');

  const category = String(values[3] || '').trim();
  if (FORM_CHOICES.CATEGORIES.indexOf(category) < 0) throw approvalError_('INVALID_INPUT', '申請区分が選択肢にありません');

  const item = String(values[4] || '').trim();
  if (item === '' || item.length > LIMITS.ITEM_MAX_LENGTH) throw approvalError_('INVALID_INPUT', '品目・内容の長さが不正です');

  const amount = parseAmount_(values[5]);

  const reason = String(values[6] || '').trim();
  if (reason === '' || reason.length > LIMITS.REASON_MAX_LENGTH) throw approvalError_('INVALID_INPUT', '理由の長さが不正です');

  return { submittedAt, applicant, department, category, item, amount, reason };
}

/** 金額を整数に変換する。桁区切りのカンマは許可し、小数・負数・範囲外はエラー */
function parseAmount_(value: unknown): number {
  const text = typeof value === 'number' ? String(value) : String(value == null ? '' : value).replace(/,/g, '').trim();
  if (!/^\d+$/.test(text)) throw approvalError_('INVALID_INPUT', '金額は整数で入力してください');
  const amount = Number(text);
  if (amount < LIMITS.AMOUNT_MIN || amount >= LIMITS.AMOUNT_MAX_EXCLUSIVE) {
    throw approvalError_('INVALID_INPUT', '金額が範囲外です');
  }
  return amount;
}

/**
 * 承認ルールシートの値（見出し行を除く）をルールの配列にする。
 * @param rows [部署, 金額下限, 金額上限, 承認者メール, 代理承認者メール]
 */
function parseRules_(rows: CellValue[][]): Rule[] {
  return (rows || [])
    .filter(function (row) { return row && String(row[0] || '').trim() !== ''; })
    .map(function (row, index): Rule {
      const min = Number(row[1]);
      const max = row[2] === '' || row[2] == null ? null : Number(row[2]);
      const approver = normalizeEmail_(row[3]);
      const delegate = normalizeEmail_(row[4]);
      const line = index + 2;
      if (!Number.isFinite(min) || min < 0) throw approvalError_('INVALID_RULE', '承認ルール ' + line + '行目: 金額下限が不正です');
      if (max !== null && (!Number.isFinite(max) || max <= min)) throw approvalError_('INVALID_RULE', '承認ルール ' + line + '行目: 金額上限が不正です');
      if (!isValidEmail_(approver)) throw approvalError_('INVALID_RULE', '承認ルール ' + line + '行目: 承認者メールが不正です');
      if (delegate !== '' && !isValidEmail_(delegate)) throw approvalError_('INVALID_RULE', '承認ルール ' + line + '行目: 代理承認者メールが不正です');
      return { department: String(row[0]).trim(), min, max, approver, delegate };
    });
}

/**
 * 申請の承認経路を決める。
 * - 承認ルールを上から照合し、部署（`*` は全部署）と金額範囲が一致した最初の行の承認者を1段目とする。
 * - 1段目が申請者本人なら代理承認者に回す（自己承認の防止）。
 * - 金額が多段承認しきい値以上なら最終承認者を2段目に加える。
 *   最終承認者が申請者本人なら管理者に回す。1段目と同じ人なら2段目は加えない。
 */
function resolveApprovalRoute_(
  request: Pick<FormInput, 'applicant' | 'department' | 'amount'>,
  rules: Rule[],
  settings: Pick<Settings, 'multiStepThreshold' | 'finalApprover' | 'adminEmail'>,
): RouteStep[] {
  const applicant = normalizeEmail_(request.applicant);
  const amount = request.amount;
  if (!Number.isInteger(amount) || amount < LIMITS.AMOUNT_MIN) throw approvalError_('INVALID_INPUT', '金額が不正です');

  const rule = (rules || []).find(function (r) {
    return (r.department === '*' || r.department === request.department) &&
      amount >= r.min && (r.max === null || amount < r.max);
  });
  if (!rule) throw approvalError_('NO_RULE', '該当する承認ルールがありません');

  let first = rule.approver;
  if (first === applicant) {
    first = rule.delegate;
    if (!first || first === applicant) throw approvalError_('SELF_APPROVAL', '申請者本人以外の承認者が設定されていません');
  }
  const route: RouteStep[] = [{ step: 1, approver: first }];

  if (amount >= settings.multiStepThreshold) {
    let finalApprover = settings.finalApprover;
    if (finalApprover === applicant) finalApprover = settings.adminEmail;
    if (!finalApprover || finalApprover === applicant) {
      throw approvalError_('SELF_APPROVAL', '申請者本人以外の最終承認者が設定されていません');
    }
    if (finalApprover !== first) route.push({ step: 2, approver: finalApprover });
  }
  return route;
}
