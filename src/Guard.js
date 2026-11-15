/**
 * Guard.js
 * 呼び出し元の検証。
 *
 * トリガーの入口関数（onFormSubmit・sendReminders）は、トリガーに登録するため末尾に `_` を付けられない。
 * その結果 google.script.run からも呼べてしまうため、イベント情報を必ず検証する。
 */

/**
 * トリガーからの呼び出しであることを確かめる。
 * イベント情報の triggerUid が、このプロジェクトに登録済みのトリガーで、かつ同じ関数を指すことを確認する。
 * @param {Object} e トリガーのイベント情報
 * @param {string} handlerName 呼び出されるはずの関数名
 */
function assertTriggerEvent_(e, handlerName) {
  if (!e || typeof e !== 'object' || typeof e.triggerUid !== 'string' || e.triggerUid === '') {
    throw approvalError_('UNTRUSTED_CALLER', 'トリガー以外からの呼び出しです');
  }
  const registered = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getUniqueId() === e.triggerUid && t.getHandlerFunction() === handlerName;
  });
  if (!registered) throw approvalError_('UNTRUSTED_CALLER', '登録されていないトリガーからの呼び出しです');
}

/**
 * フォーム送信イベントの中身を確かめる（回答シートの1行であること）。
 * @param {Object} e
 */
function assertFormSubmitEvent_(e) {
  assertTriggerEvent_(e, 'onFormSubmit');
  const range = e.range;
  if (!range || typeof range.getSheet !== 'function' || range.getSheet().getName() !== SHEET.FORM || range.getNumRows() !== 1) {
    throw approvalError_('UNTRUSTED_CALLER', 'フォーム回答シート以外のイベントです');
  }
}

/**
 * 時間主導トリガーのイベントの中身を確かめる。
 * @param {Object} e
 */
function assertTimeEvent_(e) {
  assertTriggerEvent_(e, 'sendReminders');
  if (typeof e.year !== 'number' || typeof e.hour !== 'number') {
    throw approvalError_('UNTRUSTED_CALLER', '時間主導トリガーのイベントではありません');
  }
}

/**
 * 管理者本人がエディタから実行していることを確かめる。
 * 操作している人と実行権限の持ち主が同じで、設定シートの管理者メールと一致する場合だけ通す。
 * @param {{adminEmail: string}} settings
 * @return {string} 管理者のメール
 */
function assertAdmin_(settings) {
  const active = normalizeEmail_(Session.getActiveUser().getEmail());
  const effective = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (active === '' || active !== effective || active !== settings.adminEmail) {
    throw approvalError_('NOT_ADMIN', '管理者のみ実行できます');
  }
  return active;
}
