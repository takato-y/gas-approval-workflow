/**
 * Main.ts
 * 入口（公開関数）と、入口から呼ぶ処理の組み立て。
 *
 * 公開関数（末尾に `_` が無い関数）は次の5つだけ。一覧は docs/04_権限設計.md と
 * test/publicFunctions.test.ts で管理し、増えたらテストが失敗する。
 *   doGet          ウェブアプリの入口（確認画面の表示のみ。状態は変えない）
 *   submitDecision 確認画面の「確定する」から呼ぶ（トークン・確認用の値・本人・状態をすべて検証する）
 *   onFormSubmit   フォーム送信トリガー（イベント情報を検証する）
 *   sendReminders  時間主導トリガー（イベント情報を検証する）
 *   setupProject   初期設定（管理者本人の実行に限る）
 */

const LOCK_WAIT_MS = 10000;
/** 督促の最短間隔（1時間ごとのトリガーの実行時刻のずれを見込んで30分） */
const REMINDER_MIN_INTERVAL_MS = 30 * 60 * 1000;
const HANDLERS: { FORM: string; REMINDER?: string } = Object.freeze({ FORM: 'onFormSubmit', REMINDER: 'sendReminders' });

/* ===================== 公開関数 ===================== */

/** フォーム送信トリガー */
function onFormSubmit(e: unknown): string | null {
  return handleFormSubmit_(e, new Date());
}

/** ウェブアプリ: 承認リンクを開いたときの確認画面 */
function doGet(e: { parameter?: { [key: string]: string } } | undefined): GoogleAppsScript.HTML.HtmlOutput {
  // X-Frame-Options は設定しない（既定の DEFAULT のまま。他サイトへの埋め込みを許可しない）
  return renderDecisionView_(e && e.parameter ? e.parameter.t : '', Session.getActiveUser().getEmail(), new Date())
    .setTitle('申請の承認')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 確認画面の「確定する」から呼ばれる。結果は利用者向けの文で返す。
 * @param nonce 確認画面を表示したときに作った確認用の値（CSRF 対策）
 */
function submitDecision(token: unknown, nonce: unknown, decision: unknown, comment: unknown): DecisionResult {
  return handleDecision_(token, nonce, decision, comment, Session.getActiveUser().getEmail(), new Date());
}

/** 時間主導トリガー（1時間ごと）: 承認待ちの督促と、上限超過の管理者への知らせ */
function sendReminders(e: unknown): { reminded: number; escalated: number; failed: number; skipped?: boolean; error?: string } {
  return handleReminders_(e, new Date());
}

/** 初期設定: 署名用の鍵の生成とトリガーの登録。管理者がエディタから1回実行する */
function setupProject(): string[] {
  return handleSetup_(new Date());
}

/* ===================== 内部処理 ===================== */

function getSecret_(): string | null {
  return PropertiesService.getScriptProperties().getProperty(PROP_KEYS.SECRET);
}

function getWebAppUrl_(): string {
  const url = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.WEBAPP_URL);
  if (!url || url.indexOf('https://script.google.com/') !== 0) {
    throw approvalError_('WEBAPP_URL_NOT_CONFIGURED', 'ウェブアプリのURLが未設定です');
  }
  return url;
}

/**
 * 排他制御のもとで fn を実行する。取れなければ BUSY。
 * fn が成功したら、ロックを解放する前に SpreadsheetApp.flush() で書き込みを反映する
 * （公式リファレンスの推奨。排他制御が効いている間に保留中の変更を確定させるため）。
 * flush が失敗した場合は、書き込みが反映されたか分からないため成功として扱わず、FLUSH_FAILED を投げる。
 */
function withLock_<T>(fn: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw approvalError_('BUSY', '他の処理が実行中です');
  try {
    const result = fn();
    flushOrThrow_();
    return result;
  } finally {
    // 解放の失敗で、保存済みの処理結果を失敗に変えない（失敗は実行ログに残す）
    try {
      lock.releaseLock();
    } catch (releaseErr) {
      console.error('ロックの解放に失敗しました: ' + (errorCode_(releaseErr) || 'UNEXPECTED'));
    }
  }
}

/**
 * 保留中の書き込みを SpreadsheetApp.flush() で反映する。失敗したら FLUSH_FAILED を投げる。
 * 排他制御の中（ロックの解放前）でだけ呼ぶこと。
 */
function flushOrThrow_(): void {
  try {
    SpreadsheetApp.flush();
  } catch (flushErr) {
    console.error('書き込みの反映（flush）に失敗しました: ' + (errorCode_(flushErr) || 'UNEXPECTED'));
    throw approvalError_('FLUSH_FAILED', '書き込みの反映を確認できませんでした');
  }
}

function audit_(now: Date, requestId: string, operation: string, actor: string, result: string, detail: string): void {
  appendAudit_({ at: now, requestId, operation, actor, result, detail });
}

/**
 * 状態を保存した後の記録（失敗しても例外を外に出さない）。
 * 保存済みの成功を、記録の失敗で利用者向けの失敗に変えないために使う。記録できなかったことは実行ログに残す。
 */
function auditSafely_(now: Date, requestId: string, operation: string, actor: string, result: string, detail: string): void {
  try {
    audit_(now, requestId, operation, actor, result, detail);
  } catch (err) {
    const code = errorCode_(err) || 'UNEXPECTED';
    console.error('監査ログに記録できませんでした: ' + [requestId, operation, result, detail].join(' / ') + ' / ' + code);
    // 欠けた行を後から補えるよう、管理者に知らせる（notifyAdminSafely_ は例外を投げない）
    notifyAdminSafely_('監査ログに記録できませんでした ' + (requestId || '（申請IDなし）'), [
      '処理は完了していますが、監査ログへの記録に失敗しました。導入・運用手順書の「障害時の対応」に従い、監査ログに手で追記してください。',
      '',
      '日時: ' + now.toISOString(),
      '申請ID: ' + (requestId || '（なし）'),
      '操作: ' + operation,
      '実行者: ' + actor,
      '結果: ' + result,
      '詳細: ' + detail,
      '理由コード: ' + code,
    ]);
  }
}

/**
 * トークンを発行して承認トークンシートに記録し、送るメールを作る（送信はしない）。
 * URL・鍵を記録より先に確かめ、送れないリンクの行を作らない。
 */
function issueToken_(request: ApprovalRequest, step: number, settings: Settings, now: Date, reminderCount: number): { tokenId: string; token: string; expiresAt: Date; mail: Mail } {
  const baseUrl = getWebAppUrl_();
  const secret = getSecret_();
  assertSecret_(secret);
  const approver = request.route[step - 1].approver;
  const claims = buildTokenClaims_(Utilities.getUuid(), request.id, step, now.getTime(), settings.tokenTtlHours);
  const token = signToken_(claims, secret, gasCryptoAdapter_());
  const expiresAt = new Date(claims.exp);
  appendTokenRecord_({ tokenId: claims.tid, requestId: request.id, step, approver, issuedAt: now, expiresAt });
  const link = baseUrl + '?t=' + encodeURIComponent(token);
  const mail = reminderCount
    ? buildReminderMail_(request, approver, link, expiresAt, reminderCount)
    : buildApprovalRequestMail_(request, approver, step, link, expiresAt);
  return { tokenId: claims.tid, token, expiresAt, mail };
}

/** 承認依頼のトークンの発行を試みた結果（発行できなかった場合は error に原因を持つ） */
interface IssueAttempt {
  issued: { tokenId: string; token: string; expiresAt: Date; mail: Mail } | null;
  error: unknown;
}

/**
 * 排他制御の中で承認依頼のトークンを発行して記録する（送信はしない）。
 * 記録は withLock_ の flush でロックの解放前に確定し、送信は解放後に sendIssued_ で行う。
 * 発行の失敗で、確定済みの登録・承認を失敗に変えないよう、例外は外に出さず結果に持たせる。
 * @param settings 省略時は設定シートを読む（読めない場合も error に持たせる）
 */
function tryIssueToken_(request: ApprovalRequest, step: number, now: Date, settings?: Settings): IssueAttempt {
  try {
    return { issued: issueToken_(request, step, settings || readSettings_(), now, 0), error: null };
  } catch (err) {
    return { issued: null, error: err };
  }
}

/** tryIssueToken_ で用意した承認依頼を送る。発行に失敗していた場合はその原因を投げる（notifySafely_ の中で呼ぶ） */
function sendIssued_(attempt: IssueAttempt): void {
  if (!attempt.issued) throw attempt.error;
  sendMail_(attempt.issued.mail);
}

/**
 * 送れなかったリンクのトークンを失効させる（失敗は実行ログに残し、処理は止めない）。
 * 排他制御の中で呼ぶ。書き込みはその排他制御の解放前の flush で確定する。
 */
function revokeTokenSafely_(tokenId: string): void {
  try {
    revokeToken_(tokenId);
  } catch (err) {
    console.error('送れなかったトークンを失効させられませんでした: ' + tokenId + ' / ' + (errorCode_(err) || 'UNEXPECTED'));
  }
}

/**
 * 排他制御の外で承認依頼を送れなかったとき、そのトークンを失効させる（受付・確定の後）。
 * 新たに排他制御を取り、withLock_ の解放前の flush で確定する。取れない・確定できない場合も処理は止めない
 * （残った「有効」の行は、次の督促で失効する）。
 */
function revokeUnsentToken_(attempt: IssueAttempt): void {
  if (!attempt.issued) return;
  const tokenId = attempt.issued.tokenId;
  try {
    withLock_(function () { revokeTokenSafely_(tokenId); });
  } catch (err) {
    console.error('送れなかったトークンを失効させられませんでした: ' + tokenId + ' / ' + (errorCode_(err) || 'UNEXPECTED'));
  }
}

/** 督促・管理者通知の送信に失敗したとき、申請一覧の行を送信前の値に戻す（失敗は実行ログに残す） */
function restoreRequestSafely_(rowNumber: number, original: ApprovalRequest): void {
  try {
    updateRequest_(rowNumber, original);
  } catch (err) {
    console.error('申請一覧の行を戻せませんでした: ' + original.id + ' / ' + (errorCode_(err) || 'UNEXPECTED'));
  }
}

/** 設定不備などを管理者に知らせる（知らせられなくても本処理は止めない） */
function notifyAdminSafely_(subject: string, lines: string[]): void {
  try {
    sendMail_(buildAdminNoticeMail_(readSettings_().adminEmail, subject, lines));
  } catch (e) {
    console.error('管理者への通知に失敗: ' + (errorCode_(e) || 'UNEXPECTED'));
  }
}

/** FN-001 申請受付 */
function handleFormSubmit_(e: unknown, now: Date): string | null {
  try {
    assertFormSubmitEvent_(e);
  } catch (err) {
    audit_(now, '', '拒否', 'unknown', '失敗', errorCode_(err) || 'UNEXPECTED');
    throw err;
  }
  const range = e.range;
  let registered: { request: ApprovalRequest; attempt: IssueAttempt } | null = null;
  try {
    registered = withLock_(function () {
      // 鍵・URL の不備で「登録されたのに通知されない」申請を作らないよう、先に確かめる
      assertSecret_(getSecret_());
      getWebAppUrl_();
      const settings = readSettings_();
      const input = parseFormResponse_(range.getValues()[0] as CellValue[]);
      assertApplicantDomain_(input.applicant, settings);
      const route = resolveApprovalRoute_(input, readRules_(), settings);
      const request: ApprovalRequest = Object.assign({}, input, {
        id: nextRequestId_(now), status: STATUS.PENDING, currentStep: 1, totalSteps: route.length,
        route, lastNotifiedAt: now, reminderCount: 0, updatedAt: now,
      });
      appendRequest_(request);
      auditSafely_(now, request.id, '受付', 'system', '成功', '承認経路: ' + route.map(function (r) { return r.approver; }).join(' → '));
      // 承認依頼のトークン行も排他制御の中で記録し、登録と一緒に flush で確定してから送る
      return { request, attempt: tryIssueToken_(request, 1, now, settings) };
    });
  } catch (err) {
    const code = errorCode_(err);
    audit_(now, '', '受付', 'system', '失敗', code || 'UNEXPECTED');
    notifyAdminSafely_('申請を受け付けられませんでした', [
      '理由コード: ' + (code || 'UNEXPECTED'),
      'フォームの回答シートの最終行を確認してください。',
      ...(code === 'FLUSH_FAILED'
        ? ['書き込みの反映を確認できませんでした。申請一覧に登録されている場合は、督促で承認依頼が送られます。重複して登録されていないかも確認してください。']
        : []),
    ]);
    if (!code) throw err;
    return null;
  }
  // 登録とトークン行の確定の後に通知する。通知に失敗しても登録は取り消さない（督促で新しいリンクが送られる）
  const reg = registered;
  if (!notifySafely_(now, reg.request.id, function () { sendIssued_(reg.attempt); })) revokeUnsentToken_(reg.attempt);
  return reg.request.id;
}

/** 申請者のメールアドレスが、設定した申請者ドメインのものかを確かめる（未設定なら確かめない） */
function assertApplicantDomain_(applicant: string, settings: Pick<Settings, 'applicantDomain'>): void {
  if (settings.applicantDomain && !normalizeEmail_(applicant).endsWith('@' + settings.applicantDomain)) {
    throw approvalError_('INVALID_APPLICANT', '申請者ドメイン以外のメールアドレスです');
  }
}

/**
 * 状態を書いた後の通知を行う。失敗しても状態は戻さず、監査ログと管理者に知らせる。
 * 承認待ちの申請は、督促（最後の通知から督促開始時間の経過後）で新しいリンクが送られて回復する。
 * @return 通知できたら true
 */
function notifySafely_(now: Date, requestId: string, send: () => void): boolean {
  try {
    send();
    return true;
  } catch (err) {
    const code = errorCode_(err) || 'UNEXPECTED';
    // 失敗の記録・連絡も失敗しうる（シートへの追記の失敗など）。状態は保存済みのため、
    // ここでは例外を外に出さず、記録できなかったことを実行ログに残すだけにする
    auditSafely_(now, requestId, '通知', 'system', '失敗', code);
    notifyAdminSafely_('通知メールを送れませんでした ' + requestId, [
      '申請の状態は更新済みです。理由コード: ' + code,
      '承認待ちの申請は督促で新しいリンクが送られます。結果の通知が届いていない場合は、申請者に直接連絡してください。',
    ]);
    return false;
  }
}

interface DecisionContext {
  claims: TokenClaims;
  tokenRow: { rowNumber: number; record: TokenRecord };
  actor: string;
  found: { rowNumber: number; request: ApprovalRequest };
}

/** トークンを検証し、記録・本人・申請を取り出す（確認画面と確定処理で共通） */
function loadDecisionContext_(token: unknown, activeUserEmail: unknown, now: Date): DecisionContext {
  const claims = verifyToken_(token, getSecret_(), now.getTime(), gasCryptoAdapter_());
  const tokenRow = findTokenRecord_(claims.tid);
  checkTokenRecord_(tokenRow && tokenRow.record, claims, now.getTime());
  const row = tokenRow as { rowNumber: number; record: TokenRecord };
  const actor = checkApproverIdentity_(row.record, activeUserEmail);
  const found = findRequest_(claims.rid);
  if (!found) throw approvalError_('REQUEST_NOT_FOUND', '申請が見つかりません');
  const status = found.request.status;
  if (status === STATUS.APPROVED || status === STATUS.REJECTED) throw approvalError_('ALREADY_DECIDED', '処理済みの申請です');
  // 承認待ち・承認済み・却下のどれでもない値は記録の破損として扱う（「処理済み」と案内しない）
  if (status !== STATUS.PENDING) throw approvalError_('INVALID_STATE', '申請の状態の記録が不正です');
  // 前の段階のトークンが「有効」のまま残っていた場合も、確認画面を出さずに止める
  if (found.request.currentStep !== claims.step) throw approvalError_('STEP_MISMATCH', '現在の承認段階ではありません');
  return { claims, tokenRow: row, actor, found };
}

/** FN-005 確認画面を作る（状態は変えない） */
function renderDecisionView_(token: unknown, activeUserEmail: unknown, now: Date): GoogleAppsScript.HTML.HtmlOutput {
  try {
    const c = loadDecisionContext_(token, activeUserEmail, now);
    const nonce = createConfirmNonce_(c.claims.tid, c.actor, now.getTime(), getSecret_(), gasCryptoAdapter_());
    return renderDecisionPage_(c.found.request, c.claims.step, String(token), nonce);
  } catch (err) {
    const code = errorCode_(err);
    if (!code) throw err;
    audit_(now, '', '画面表示', normalizeEmail_(activeUserEmail) || 'unknown', '失敗', code);
    return renderMessagePage_('操作できません', userMessageFor_(code));
  }
}

/** FN-006 承認・却下の確定 */
function handleDecision_(token: unknown, nonce: unknown, decision: unknown, comment: unknown, activeUserEmail: unknown, now: Date): DecisionResult {
  const actorLabel = normalizeEmail_(activeUserEmail) || 'unknown';
  let requestId = '';
  try {
    if (decision !== ACTION.APPROVE && decision !== ACTION.REJECT) throw approvalError_('INVALID_ACTION', '操作の種類が不正です');
    const type: string = decision;
    const note = String(comment == null ? '' : comment).trim().slice(0, LIMITS.COMMENT_MAX_LENGTH);
    if (type === ACTION.REJECT && note === '') throw approvalError_('COMMENT_REQUIRED', '却下の理由が必要です');

    const done = withLock_(function () {
      // 排他制御の中で読み直してから判定する（同時に押された場合の二重処理を防ぐ）
      const c = loadDecisionContext_(token, activeUserEmail, now);
      requestId = c.claims.rid;
      verifyConfirmNonce_(nonce, c.claims.tid, c.actor, now.getTime(), getSecret_(), gasCryptoAdapter_());
      const request = c.found.request;
      const next = transition_(request, { type, step: c.claims.step });

      const updated: ApprovalRequest = Object.assign({}, request, {
        status: next.status, currentStep: next.currentStep, updatedAt: now,
      });
      if (next.nextStep) {
        updated.lastNotifiedAt = now;
        updated.reminderCount = 0;
      }
      // 申請の状態の更新を確定の時点とする（ここで失敗した場合だけ利用者に失敗を返す）。
      // 以降の「トークンを使用済みにする」「監査ログに記録する」は失敗しても確定を取り消さない。
      // トークンが「有効」のまま残っても、申請の状態と段階の確認（ALREADY_DECIDED・STEP_MISMATCH）で再利用は拒否される。
      // メール送信は排他制御の外で行う
      updateRequest_(c.found.rowNumber, updated);
      try {
        markTokenUsed_(c.tokenRow.rowNumber, now);
      } catch (markErr) {
        console.error('トークンを使用済みにできませんでした: ' + requestId + ' / ' + (errorCode_(markErr) || 'UNEXPECTED'));
        auditSafely_(now, requestId, 'トークン更新', 'system', '失敗', errorCode_(markErr) || 'UNEXPECTED');
      }
      auditSafely_(now, requestId, type === ACTION.APPROVE ? '承認' : '却下', c.actor, '成功',
        '段階 ' + c.claims.step + '/' + request.totalSteps + (note ? ' コメントあり' : ''));
      // 次の段階へ進む場合は、次の承認者のトークン行も排他制御の中で記録し、状態と一緒に flush で確定してから送る
      const attempt = next.nextStep ? tryIssueToken_(updated, next.nextStep, now) : null;
      return { updated, next, attempt };
    });

    const decidedLabel = done.next.status === STATUS.REJECTED ? '却下しました。' : '承認しました。';
    if (done.attempt) {
      const attempt = done.attempt;
      const sent = notifySafely_(now, requestId, function () { sendIssued_(attempt); });
      if (!sent) revokeUnsentToken_(attempt);
      return { ok: true, message: decidedLabel + (sent ? '次の承認者に回しました。' : '次の承認者への通知に失敗したため、管理者に連絡しました。') };
    }
    const sent = notifySafely_(now, requestId, function () { sendMail_(buildResultMail_(done.updated, done.next.status, note)); });
    return { ok: true, message: decidedLabel + (sent ? '申請者に通知しました。' : '申請者への通知に失敗したため、管理者に連絡しました。') };
  } catch (err) {
    const code = errorCode_(err);
    if (!code) throw err;
    if (code === 'FLUSH_FAILED') {
      // 書き込みが反映されたか分からない。成功とは返さず、管理者に照合を依頼する。
      // 反映されていれば同じリンクは「処理済み」、反映されていなければもう一度操作できる
      auditSafely_(now, requestId, '保存確認', actorLabel, '失敗', code);
      notifyAdminSafely_('承認・却下の保存を確認できませんでした ' + requestId, [
        '書き込みの反映（flush）に失敗しました。申請一覧・承認トークン・監査ログを照合してください。',
        '申請ID: ' + requestId,
        '操作者: ' + actorLabel,
        '操作: ' + String(decision),
      ]);
      return { ok: false, message: userMessageFor_(code) };
    }
    audit_(now, requestId, '拒否', actorLabel, '失敗', code);
    return { ok: false, message: userMessageFor_(code) };
  }
}

/** FN-009 督促の実行。1件の失敗で他の申請の督促を止めない */
function handleReminders_(e: unknown, now: Date): { reminded: number; escalated: number; failed: number; skipped?: boolean; error?: string } {
  try {
    assertTimeEvent_(e, 'sendReminders');
  } catch (err) {
    audit_(now, '', '拒否', 'unknown', '失敗', errorCode_(err) || 'UNEXPECTED');
    throw err;
  }
  // 排他制御の中で数える。その回全体が失敗しても、それまでの件数を返す
  const summary = { reminded: 0, escalated: 0, failed: 0 };
  try {
    return withLock_(function () {
      // 前回の実行から短時間なら何もしない（想定外の経路で何度呼ばれても、督促を早めたり増やしたりしない）
      const props = PropertiesService.getScriptProperties();
      const last = Number(props.getProperty(PROP_KEYS.REMINDER_LAST_RUN));
      if (Number.isFinite(last) && last > 0 && now.getTime() - last < REMINDER_MIN_INTERVAL_MS) {
        return { reminded: 0, escalated: 0, failed: 0, skipped: true };
      }
      // 設定を読めた場合だけ「実行した」と記録する（設定の不備で何もしなかった回を実行済みにしない）。
      // 記録はメール送信の前に行い、送信中に再び呼ばれても最短間隔が効くようにする
      const settings = readSettings_();
      props.setProperty(PROP_KEYS.REMINDER_LAST_RUN, String(now.getTime()));
      const selected = selectReminders_(listPendingRequests_(), now.getTime(), settings);

      selected.remind.forEach(function (item) {
        const r = item.request;
        try {
          const count = r.reminderCount + 1;
          // 新しいリンクを作れない設定（URL・鍵の不備）なら、古いリンクを失効させる前に止める
          getWebAppUrl_();
          assertSecret_(getSecret_());
          // 古いリンクを失効させてから新しいリンクを作る（期限切れ対策と、出回るリンクを1本に保つため）
          revokeActiveTokens_(r.id);
          const issued = issueToken_(r, r.currentStep, settings, now, count);
          // トークン行と督促回数・最終通知日時を確定させてからメールを送る（届いたリンクが「発行記録なし」にならず、
          // 送った督促が次の見回りで重複しないように）。確定できない・送れない場合は申請一覧の行を戻し、
          // この申請の督促を失敗にする（最終通知日時が古いままのため次の見回りで再び督促する）
          updateRequest_(item.rowNumber, Object.assign({}, r, { lastNotifiedAt: now, reminderCount: count, updatedAt: now }));
          try {
            flushOrThrow_();
            sendMail_(issued.mail);
          } catch (sendErr) {
            // 送れなかった新しいリンクを失効させ、行を戻す（古いリンクは失効のまま有効に戻さない）。
            // どちらの書き込みも、この排他制御の解放前の flush で確定する
            revokeTokenSafely_(issued.tokenId);
            restoreRequestSafely_(item.rowNumber, r);
            throw sendErr;
          }
          auditSafely_(now, r.id, '督促', 'system', '成功', count + '回目 段階 ' + r.currentStep);
          summary.reminded++;
        } catch (err) {
          auditSafely_(now, r.id, '督促', 'system', '失敗', errorCode_(err) || 'UNEXPECTED');
          summary.failed++;
        }
      });

      selected.escalate.forEach(function (item) {
        const r = item.request;
        try {
          const approver = r.route[r.currentStep - 1] ? r.route[r.currentStep - 1].approver : '（不明）';
          // 「知らせ済み」（督促回数 = 上限 + 1）を確定させてから送る（次の見回りで同じ知らせを重複させないため）。
          // 確定できない・送れない場合は行を戻し、次の見回りで再び試す
          updateRequest_(item.rowNumber, Object.assign({}, r, { lastNotifiedAt: now, reminderCount: settings.maxReminders + 1, updatedAt: now }));
          const notice = buildAdminNoticeMail_(settings.adminEmail, '督促しても承認されていない申請 ' + r.id, [
            '督促を ' + settings.maxReminders + ' 回送りましたが、まだ承認されていません。',
            '承認者に直接連絡するか、承認ルールの見直しを検討してください。',
            '',
            '申請ID: ' + r.id,
            '承認段階: ' + r.currentStep + ' / ' + r.totalSteps,
            '承認者: ' + approver,
          ]);
          try {
            flushOrThrow_();
            sendMail_(notice);
          } catch (sendErr) {
            restoreRequestSafely_(item.rowNumber, r);
            throw sendErr;
          }
          auditSafely_(now, r.id, '管理者通知', 'system', '成功', '督促上限超過');
          summary.escalated++;
        } catch (err) {
          auditSafely_(now, r.id, '管理者通知', 'system', '失敗', errorCode_(err) || 'UNEXPECTED');
          summary.failed++;
        }
      });
      return { reminded: summary.reminded, escalated: summary.escalated, failed: summary.failed };
    });
  } catch (err) {
    // その回全体の失敗（BUSY・設定の不備・最後の flush の失敗など）。申請IDは空で記録する。
    // 記録に失敗した場合は auditSafely_ が管理者に知らせる
    const code = errorCode_(err);
    auditSafely_(now, '', '督促', 'system', '失敗', code || 'UNEXPECTED');
    if (code === 'FLUSH_FAILED') {
      // 督促メールは各申請のトークン行を確定してから送っているが、督促回数・最終通知日時・監査ログの行は
      // 反映されたか分からない。管理者に照合を依頼する
      notifyAdminSafely_('督促の保存を確認できませんでした', [
        '書き込みの反映（flush）に失敗しました。督促・管理者通知のメールは、申請一覧と承認トークンの記録を確定してから送っています。',
        '反映されていない可能性があるのは、監査ログの督促・管理者通知の行と、送信に失敗した申請の督促回数・最終通知日時の戻しです。申請一覧・承認トークン・監査ログを照合してください。',
        '日時: ' + now.toISOString(),
        '督促: ' + summary.reminded + '件 ／ 管理者通知: ' + summary.escalated + '件 ／ 失敗: ' + summary.failed + '件',
      ]);
    }
    if (!code) throw err;
    return { reminded: summary.reminded, escalated: summary.escalated, failed: summary.failed, error: code };
  }
}

/** 署名用の鍵を作る（UUID 2つ分の乱数を16進で連結） */
function generateSecret_(): string {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** FN-011 初期設定 */
function handleSetup_(now: Date): string[] {
  const settings = readSettings_();
  const admin = assertAdmin_(settings);
  const props = PropertiesService.getScriptProperties();
  const created: string[] = [];
  if (!props.getProperty(PROP_KEYS.SECRET)) {
    props.setProperty(PROP_KEYS.SECRET, generateSecret_());
    created.push('署名用の鍵');
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ours = [HANDLERS.FORM, HANDLERS.REMINDER].filter(Boolean);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(HANDLERS.FORM).forSpreadsheet(ss).onFormSubmit().create();
  created.push('フォーム送信トリガー');
  if (HANDLERS.REMINDER) {
    ScriptApp.newTrigger(HANDLERS.REMINDER).timeBased().everyHours(1).create();
    created.push('督促トリガー（1時間ごと）');
  }
  auditSafely_(now, '', '初期設定', admin, '成功', created.join('・'));
  return created;
}
