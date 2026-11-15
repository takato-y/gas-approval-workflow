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
function sendReminders(e: unknown): { reminded: number; escalated: number; failed: number } {
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
    try {
      SpreadsheetApp.flush();
    } catch (flushErr) {
      console.error('書き込みの反映（flush）に失敗しました: ' + (errorCode_(flushErr) || 'UNEXPECTED'));
      throw approvalError_('FLUSH_FAILED', '書き込みの反映を確認できませんでした');
    }
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

/** トークンを発行して記録し、承認依頼（または督促）メールを送る */
function issueTokenAndNotify_(request: ApprovalRequest, step: number, settings: Settings, now: Date, reminderCount: number): { token: string; expiresAt: Date } {
  const approver = request.route[step - 1].approver;
  const claims = buildTokenClaims_(Utilities.getUuid(), request.id, step, now.getTime(), settings.tokenTtlHours);
  const token = signToken_(claims, getSecret_(), gasCryptoAdapter_());
  const expiresAt = new Date(claims.exp);
  appendTokenRecord_({ tokenId: claims.tid, requestId: request.id, step, approver, issuedAt: now, expiresAt });
  const link = getWebAppUrl_() + '?t=' + encodeURIComponent(token);
  const mail = reminderCount
    ? buildReminderMail_(request, approver, link, expiresAt, reminderCount)
    : buildApprovalRequestMail_(request, approver, step, link, expiresAt);
  sendMail_(mail);
  return { token, expiresAt };
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
  let registered: { request: ApprovalRequest; settings: Settings } | null = null;
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
      return { request, settings };
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
  // 登録の後に通知する。通知に失敗しても登録は取り消さない（督促で新しいリンクが送られる）
  const reg = registered;
  notifySafely_(now, reg.request.id, function () { issueTokenAndNotify_(reg.request, 1, reg.settings, now, 0); });
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
  if (found.request.status !== STATUS.PENDING) throw approvalError_('ALREADY_DECIDED', '処理済みの申請です');
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
      return { updated, next };
    });

    const decidedLabel = done.next.status === STATUS.REJECTED ? '却下しました。' : '承認しました。';
    if (done.next.nextStep) {
      const nextStep = done.next.nextStep;
      const sent = notifySafely_(now, requestId, function () { issueTokenAndNotify_(done.updated, nextStep, readSettings_(), now, 0); });
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
function handleReminders_(e: unknown, now: Date): { reminded: number; escalated: number; failed: number; skipped?: boolean } {
  try {
    assertTimeEvent_(e, 'sendReminders');
  } catch (err) {
    audit_(now, '', '拒否', 'unknown', '失敗', errorCode_(err) || 'UNEXPECTED');
    throw err;
  }
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
    const summary = { reminded: 0, escalated: 0, failed: 0 };

    selected.remind.forEach(function (item) {
      const r = item.request;
      try {
        const count = r.reminderCount + 1;
        // 古いリンクを失効させてから新しいリンクを送る（期限切れ対策と、出回るリンクを1本に保つため）
        revokeActiveTokens_(r.id);
        issueTokenAndNotify_(r, r.currentStep, settings, now, count);
        updateRequest_(item.rowNumber, Object.assign({}, r, { lastNotifiedAt: now, reminderCount: count, updatedAt: now }));
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
        sendMail_(buildAdminNoticeMail_(settings.adminEmail, '督促しても承認されていない申請 ' + r.id, [
          '督促を ' + settings.maxReminders + ' 回送りましたが、まだ承認されていません。',
          '承認者に直接連絡するか、承認ルールの見直しを検討してください。',
          '',
          '申請ID: ' + r.id,
          '承認段階: ' + r.currentStep + ' / ' + r.totalSteps,
          '承認者: ' + approver,
        ]));
        updateRequest_(item.rowNumber, Object.assign({}, r, { lastNotifiedAt: now, reminderCount: settings.maxReminders + 1, updatedAt: now }));
        auditSafely_(now, r.id, '管理者通知', 'system', '成功', '督促上限超過');
        summary.escalated++;
      } catch (err) {
        auditSafely_(now, r.id, '管理者通知', 'system', '失敗', errorCode_(err) || 'UNEXPECTED');
        summary.failed++;
      }
    });
    return summary;
  });
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
