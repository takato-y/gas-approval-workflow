/**
 * Notifier.ts
 * 通知メールの文面作成（日時の書式だけ GAS の Utilities を使う。ほかは純粋ロジック）と送信。
 * 文面にトークン以外の秘密情報を含めない。トークンは承認者宛てのリンクにだけ入れる。
 */

const MAIL_SENDER_NAME = '経費・備品申請システム';

/** 金額を「1,234円」の形にする */
function formatYen_(amount: number): string {
  return String(Math.trunc(Number(amount))).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円';
}

/**
 * 日時を、スクリプトのタイムゾーンで「2026/11/19 16:37:37」の形にする（シートの表示と同じ形）。
 * 例外を投げない（失敗時の知らせの組み立てでも使うため）。書式にできなければ ISO 8601 の形に戻す。
 */
function formatDateTime_(date: Date): string {
  try {
    return Utilities.formatDate(date, Session.getScriptTimeZone(), DATETIME_FORMAT.TEXT);
  } catch (err) {
    // シートから読んだ値など、別の実行環境で作られた Date でも判定できるよう instanceof を使わない
    return Object.prototype.toString.call(date) === '[object Date]' && !isNaN(date.getTime()) ? date.toISOString() : String(date);
  }
}

/**
 * 申請内容の共通部分。
 * 申請者が自由に書く欄（品目・内容、理由）で、偽の「申請者:」の行や偽の案内・リンクを本文に足せないようにする。
 * - 品目・内容は1行にする（改行・制御文字・見えない文字は空白、URL はリンクにならない形）
 * - 理由は最後に置き、申請者の入力であることを示したうえで、各行の先頭に「> 」を付ける
 */
function describeRequest_(request: ApprovalRequest): string {
  return [
    '申請ID: ' + request.id,
    '申請者: ' + applicantLabel_(request),
    '部署: ' + request.department,
    '申請区分: ' + request.category,
    '品目・内容: ' + toFreeTextLine_(request.item),
    '金額: ' + formatYen_(request.amount),
    '理由（申請者の入力。各行の先頭に「> 」を付けています）:',
  ].concat(quoteFreeText_(request.reason)).join('\n');
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
      'このリンクはあなた専用で、1回だけ使えます。有効期限: ' + formatDateTime_(expiresAt),
      'このメールを転送しないでください。操作用のリンクは、上の1本だけです。',
    ].join('\n'),
  };
}

/** 申請者への結果通知メール */
function buildResultMail_(request: ApprovalRequest, status: string, comment: string): Mail {
  const lines = ['あなたの申請は「' + status + '」になりました。', '', describeRequest_(request)];
  // 承認者のコメントも自由入力なので、理由と同じく各行の先頭に「> 」を付ける
  if (comment) lines.push('', '承認者のコメント（承認者の入力。各行の先頭に「> 」を付けています）:', quoteFreeText_(comment).join('\n'));
  // 件名には品目を1行・短くして入れる（件名で改行や表示の向きを変える文字を使わせない）
  const subjectItem = truncateChars_(toFreeTextLine_(request.item), LIMITS.SUBJECT_ITEM_MAX_LENGTH);
  return { to: request.applicant, subject: '【' + status + '】' + request.id + ' ' + subjectItem, body: lines.join('\n') };
}

/** 督促メール（新しいリンクを含む） */
function buildReminderMail_(request: ApprovalRequest, approver: string, link: string, expiresAt: Date, count: number): Mail {
  const mail = buildApprovalRequestMail_(request, approver, request.currentStep, link, expiresAt);
  mail.subject = '【督促' + count + '回目】' + mail.subject.replace('【承認依頼】', '');
  mail.body = '承認待ちの申請があります。以前のリンクは無効になりました。新しいリンクから操作してください。\n\n' + mail.body;
  return mail;
}

/** 管理者への知らせ（督促の上限到達・設定不備など） */
function buildAdminNoticeMail_(adminEmail: string, subject: string, lines: string[]): Mail {
  return { to: adminEmail, subject: '【管理者確認】' + subject, body: lines.join('\n') };
}

/** メールを送る */
function sendMail_(mail: Mail): void {
  MailApp.sendEmail({ to: mail.to, subject: mail.subject, body: mail.body, name: MAIL_SENDER_NAME });
}
