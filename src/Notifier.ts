/**
 * Notifier.ts
 * 通知メールの文面作成（純粋ロジック）と送信。
 * 文面にトークン以外の秘密情報を含めない。トークンは承認者宛てのリンクにだけ入れる。
 */

const MAIL_SENDER_NAME = '経費・備品申請システム';

/** 金額を「1,234円」の形にする */
function formatYen_(amount: number): string {
  return String(Math.trunc(Number(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
}

/** 申請内容の共通部分 */
function describeRequest_(request: ApprovalRequest): string {
  return [
    '申請ID: ' + request.id,
    '申請者: ' + request.applicant,
    '部署: ' + request.department,
    '申請区分: ' + request.category,
    '品目・内容: ' + request.item,
    '金額: ' + formatYen_(request.amount),
    '理由: ' + request.reason,
  ].join('\n');
}

/** 承認依頼メール */
function buildApprovalRequestMail_(request: ApprovalRequest, approver: string, step: number, link: string, expiresAt: Date): Mail {
  const stepLabel = request.totalSteps > 1 ? '（' + step + '/' + request.totalSteps + '段階目）' : '';
  return {
    to: approver,
    subject: '【承認依頼】' + request.id + ' ' + request.category + ' ' + formatYen_(request.amount) + stepLabel,
    body: [
      '次の申請の承認をお願いします。',
      '',
      describeRequest_(request),
      '',
      '下のリンクを開くと確認画面が表示されます。画面で「承認」または「却下」を押してください。',
      'リンクを開いただけでは承認・却下されません。',
      link,
      '',
      'このリンクはあなた専用で、1回だけ使えます。有効期限: ' + expiresAt.toISOString(),
      'このメールを転送しないでください。',
    ].join('\n'),
  };
}

/** 申請者への結果通知メール */
function buildResultMail_(request: ApprovalRequest, status: string, comment: string): Mail {
  const lines = ['あなたの申請は「' + status + '」になりました。', '', describeRequest_(request)];
  if (comment) lines.push('', '承認者のコメント: ' + comment);
  return { to: request.applicant, subject: '【' + status + '】' + request.id + ' ' + request.item, body: lines.join('\n') };
}

/** 督促メール（新しいリンクを含む） */
function buildReminderMail_(request: ApprovalRequest, approver: string, link: string, expiresAt: Date, count: number): Mail {
  const mail = buildApprovalRequestMail_(request, approver, request.currentStep, link, expiresAt);
  mail.subject = '【督促' + count + '回目】' + mail.subject.replace('【承認依頼】', '');
  mail.body = '承認待ちの申請があります。以前のリンクは無効になりました。新しいリンクから操作してください。\n\n' + mail.body;
  return mail;
}

/** 管理者への知らせ（督促の上限超過・設定不備など） */
function buildAdminNoticeMail_(adminEmail: string, subject: string, lines: string[]): Mail {
  return { to: adminEmail, subject: '【管理者確認】' + subject, body: lines.join('\n') };
}

/** メールを送る */
function sendMail_(mail: Mail): void {
  MailApp.sendEmail({ to: mail.to, subject: mail.subject, body: mail.body, name: MAIL_SENDER_NAME });
}
