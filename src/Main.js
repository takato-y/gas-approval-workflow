/**
 * Main.js
 * 入口（公開関数）と、入口から呼ぶ処理の組み立て。
 *
 * 公開関数（末尾に `_` が無い関数）は次の4つだけ。一覧は docs/04_権限設計.md と
 * test/publicFunctions.test.js で管理し、増えたらテストが失敗する。
 *   doGet          ウェブアプリの入口（確認画面の表示のみ。状態は変えない）
 *   submitDecision 確認画面のボタンから呼ぶ（トークン・本人・状態をすべて検証する）
 *   onFormSubmit   フォーム送信トリガー（イベント情報を検証する）
 *   setupProject   初期設定（管理者本人の実行に限る）
 */

const LOCK_WAIT_MS = 10000;
const HANDLERS = Object.freeze({ FORM: 'onFormSubmit' });

/* ===================== 公開関数 ===================== */

/** フォーム送信トリガー */
function onFormSubmit(e) {
  return handleFormSubmit_(e, new Date());
}

/** ウェブアプリ: 承認リンクを開いたときの確認画面 */
function doGet(e) {
  const html = renderDecisionView_(e && e.parameter ? e.parameter.t : '', Session.getActiveUser().getEmail(), new Date());
  return HtmlService.createHtmlOutput(html).setTitle('申請の承認');
}

/**
 * 確認画面のボタンから呼ばれる。結果は利用者向けの文で返す。
 * @param {string} token
 * @param {string} decision 'approve' または 'reject'
 * @param {string} comment
 * @return {{ok: boolean, message: string}}
 */
function submitDecision(token, decision, comment) {
  return handleDecision_(token, decision, comment, Session.getActiveUser().getEmail(), new Date());
}

/** 初期設定: 署名用の鍵の生成とトリガーの登録。管理者がエディタから1回実行する */
function setupProject() {
  return handleSetup_(new Date());
}

/* ===================== 内部処理 ===================== */

function getSecret_() {
  return PropertiesService.getScriptProperties().getProperty(PROP_KEYS.SECRET);
}

function getWebAppUrl_() {
  const url = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.WEBAPP_URL);
  if (!url || url.indexOf('https://script.google.com/') !== 0) {
    throw approvalError_('WEBAPP_URL_NOT_CONFIGURED', 'ウェブアプリのURLが未設定です');
  }
  return url;
}

/** 排他制御のもとで fn を実行する。取れなければ BUSY */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) throw approvalError_('BUSY', '他の処理が実行中です');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function audit_(now, requestId, operation, actor, result, detail) {
  appendAudit_({ at: now, requestId: requestId, operation: operation, actor: actor, result: result, detail: detail });
}

/**
 * トークンを発行して記録し、承認依頼（または督促）メールを送る。
 * @return {{token: string, expiresAt: Date}}
 */
function issueTokenAndNotify_(request, step, settings, now, reminderCount) {
  const approver = request.route[step - 1].approver;
  const claims = buildTokenClaims_(Utilities.getUuid(), request.id, step, now.getTime(), settings.tokenTtlHours);
  const token = signToken_(claims, getSecret_(), gasCryptoAdapter_());
  const expiresAt = new Date(claims.exp);
  appendTokenRecord_({ tokenId: claims.tid, requestId: request.id, step: step, approver: approver, issuedAt: now, expiresAt: expiresAt });
  const link = getWebAppUrl_() + '?t=' + encodeURIComponent(token);
  const mail = reminderCount
    ? buildReminderMail_(request, approver, link, expiresAt, reminderCount)
    : buildApprovalRequestMail_(request, approver, step, link, expiresAt);
  sendMail_(mail);
  return { token: token, expiresAt: expiresAt };
}

/** 設定不備などを管理者に知らせる（知らせられなくても本処理は止めない） */
function notifyAdminSafely_(subject, lines) {
  try {
    sendMail_(buildAdminNoticeMail_(readSettings_().adminEmail, subject, lines));
  } catch (e) {
    console.error('管理者への通知に失敗: ' + (e.code || e.message));
  }
}

/** FN-001 申請受付 */
function handleFormSubmit_(e, now) {
  try {
    assertFormSubmitEvent_(e);
  } catch (err) {
    audit_(now, '', '拒否', 'unknown', '失敗', err.code || 'UNEXPECTED');
    throw err;
  }
  try {
    return withLock_(function () {
      // 鍵・URL の不備で「登録されたのに通知されない」申請を作らないよう、先に確かめる
      assertSecret_(getSecret_());
      getWebAppUrl_();
      const settings = readSettings_();
      const input = parseFormResponse_(e.range.getValues()[0]);
      const route = resolveApprovalRoute_(input, readRules_(), settings);
      const request = Object.assign({}, input, {
        id: nextRequestId_(now), status: STATUS.PENDING, currentStep: 1, totalSteps: route.length,
        route: route, lastNotifiedAt: now, reminderCount: 0, updatedAt: now,
      });
      appendRequest_(request);
      issueTokenAndNotify_(request, 1, settings, now, 0);
      audit_(now, request.id, '受付', 'system', '成功', '承認経路: ' + route.map(function (r) { return r.approver; }).join(' → '));
      return request.id;
    });
  } catch (err) {
    audit_(now, '', '受付', 'system', '失敗', err.code || 'UNEXPECTED');
    notifyAdminSafely_('申請を受け付けられませんでした', ['理由コード: ' + (err.code || 'UNEXPECTED'), 'フォームの回答シートの最終行を確認してください。']);
    if (!err.code) throw err;
    return null;
  }
}

/**
 * トークンを検証し、記録・本人・申請を取り出す（確認画面と確定処理で共通）。
 * @return {{claims: Object, tokenRow: Object, actor: string, found: Object}}
 */
function loadDecisionContext_(token, activeUserEmail, now) {
  const claims = verifyToken_(token, getSecret_(), now.getTime(), gasCryptoAdapter_());
  const tokenRow = findTokenRecord_(claims.tid);
  checkTokenRecord_(tokenRow && tokenRow.record, claims, now.getTime());
  const actor = checkApproverIdentity_(tokenRow.record, activeUserEmail);
  const found = findRequest_(claims.rid);
  if (!found) throw approvalError_('REQUEST_NOT_FOUND', '申請が見つかりません');
  if (found.request.status !== STATUS.PENDING) throw approvalError_('ALREADY_DECIDED', '処理済みの申請です');
  return { claims: claims, tokenRow: tokenRow, actor: actor, found: found };
}

/** FN-005 確認画面の HTML を作る（状態は変えない） */
function renderDecisionView_(token, activeUserEmail, now) {
  try {
    const c = loadDecisionContext_(token, activeUserEmail, now);
    return renderDecisionPage_(c.found.request, c.claims.step, token);
  } catch (err) {
    if (!err.code) throw err;
    audit_(now, '', '画面表示', normalizeEmail_(activeUserEmail) || 'unknown', '失敗', err.code);
    return renderMessagePage_('操作できません', userMessageFor_(err.code));
  }
}

/** FN-006 承認・却下の確定 */
function handleDecision_(token, decision, comment, activeUserEmail, now) {
  const actorLabel = normalizeEmail_(activeUserEmail) || 'unknown';
  let requestId = '';
  try {
    if (decision !== ACTION.APPROVE && decision !== ACTION.REJECT) throw approvalError_('INVALID_ACTION', '操作の種類が不正です');
    const note = String(comment == null ? '' : comment).trim().slice(0, LIMITS.COMMENT_MAX_LENGTH);
    if (decision === ACTION.REJECT && note === '') throw approvalError_('COMMENT_REQUIRED', '却下の理由が必要です');

    return withLock_(function () {
      // 排他制御の中で読み直してから判定する（同時に押された場合の二重処理を防ぐ）
      const c = loadDecisionContext_(token, activeUserEmail, now);
      requestId = c.claims.rid;
      const request = c.found.request;
      const next = transition_(request, { type: decision, step: c.claims.step });

      const updated = Object.assign({}, request, {
        status: next.status, currentStep: next.currentStep, updatedAt: now,
      });
      if (next.nextStep) {
        updated.lastNotifiedAt = now;
        updated.reminderCount = 0;
      }
      // 先にトークンを使用済みにし、続けて状態を書く（どちらも排他制御の中）
      markTokenUsed_(c.tokenRow.rowNumber, now);
      updateRequest_(c.found.rowNumber, updated);
      audit_(now, requestId, decision === ACTION.APPROVE ? '承認' : '却下', c.actor, '成功',
        '段階 ' + c.claims.step + '/' + request.totalSteps + (note ? ' コメントあり' : ''));

      if (next.nextStep) {
        issueTokenAndNotify_(updated, next.nextStep, readSettings_(), now, 0);
        return { ok: true, message: '承認しました。次の承認者に回しました。' };
      }
      sendMail_(buildResultMail_(updated, next.status, note));
      return { ok: true, message: next.status === STATUS.APPROVED ? '承認しました。申請者に通知しました。' : '却下しました。申請者に通知しました。' };
    });
  } catch (err) {
    if (!err.code) throw err;
    audit_(now, requestId, '拒否', actorLabel, '失敗', err.code);
    return { ok: false, message: userMessageFor_(err.code) };
  }
}

/** 署名用の鍵を作る（UUID 2つ分の乱数を16進で連結） */
function generateSecret_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** FN-011 初期設定 */
function handleSetup_(now) {
  const settings = readSettings_();
  const admin = assertAdmin_(settings);
  const props = PropertiesService.getScriptProperties();
  const created = [];
  if (!props.getProperty(PROP_KEYS.SECRET)) {
    props.setProperty(PROP_KEYS.SECRET, generateSecret_());
    created.push('署名用の鍵');
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ours = Object.keys(HANDLERS).map(function (k) { return HANDLERS[k]; });
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (ours.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger(HANDLERS.FORM).forSpreadsheet(ss).onFormSubmit().create();
  created.push('フォーム送信トリガー');
  if (HANDLERS.REMINDER) {
    ScriptApp.newTrigger(HANDLERS.REMINDER).timeBased().everyHours(1).create();
    created.push('督促トリガー（1時間ごと）');
  }
  audit_(now, '', '初期設定', admin, '成功', created.join('・'));
  return created;
}
