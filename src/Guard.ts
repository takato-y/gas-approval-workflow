/**
 * Guard.ts
 * 呼び出し元の検証。
 *
 * トリガーの入口関数（onFormSubmit など）は、トリガーに登録するため末尾に `_` を付けられない。
 * その結果 google.script.run からも呼べてしまうため、イベント情報を必ず検証する。
 */

/** トリガーのイベント情報のうち、検証に使う部分 */
interface TriggerEventLike {
  triggerUid?: unknown;
  range?: unknown;
  year?: unknown;
  hour?: unknown;
}

/**
 * トリガーからの呼び出しであることを確かめる。
 * イベント情報の triggerUid が、このプロジェクトに登録済みのトリガーで、かつ同じ関数を指すことを確認する。
 */
function assertTriggerEvent_(e: unknown, handlerName: string): asserts e is TriggerEventLike & { triggerUid: string } {
  const ev = e as TriggerEventLike | null | undefined;
  if (!ev || typeof ev !== 'object' || typeof ev.triggerUid !== 'string' || ev.triggerUid === '') {
    throw approvalError_('UNTRUSTED_CALLER', 'トリガー以外からの呼び出しです');
  }
  const uid = ev.triggerUid;
  const registered = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getUniqueId() === uid && t.getHandlerFunction() === handlerName;
  });
  if (!registered) throw approvalError_('UNTRUSTED_CALLER', '登録されていないトリガーからの呼び出しです');
}

/** フォーム送信イベントの中身を確かめる（回答シートの1行であること） */
function assertFormSubmitEvent_(e: unknown): asserts e is { triggerUid: string; range: GoogleAppsScript.Spreadsheet.Range } {
  assertTriggerEvent_(e, 'onFormSubmit');
  const range = e.range as GoogleAppsScript.Spreadsheet.Range | undefined;
  if (!range || typeof range.getSheet !== 'function' || range.getSheet().getName() !== SHEET.FORM || range.getNumRows() !== 1) {
    throw approvalError_('UNTRUSTED_CALLER', 'フォーム回答シート以外のイベントです');
  }
}

/**
 * 時間主導トリガーのイベントの中身を確かめる。
 *
 * 画面（google.script.run）からは日時を渡せないが、数値の year・hour を持つ普通のオブジェクトは渡せるため、
 * イベントの形だけでは画面からの呼び出しと区別しきれない。そこで次も確かめる。
 * - 操作者が、実行権限の持ち主（トリガーを作った管理者）以外の利用者なら拒否する。
 *   インストール型トリガーは作成者のアカウントで動くため、トリガーからの実行では
 *   操作者は空か作成者本人になる。ウェブアプリを開いた社員からの呼び出しはここで止まる。
 */
function assertTimeEvent_(e: unknown, handlerName: string): void {
  assertTriggerEvent_(e, handlerName);
  if (typeof e.year !== 'number' || typeof e.hour !== 'number') {
    throw approvalError_('UNTRUSTED_CALLER', '時間主導トリガーのイベントではありません');
  }
  assertNotOtherUser_();
}

/** 操作者が、実行権限の持ち主と異なる利用者なら拒否する（操作者が空の場合は通す） */
function assertNotOtherUser_(): void {
  const active = normalizeEmail_(Session.getActiveUser().getEmail());
  const effective = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (active !== '' && active !== effective) {
    throw approvalError_('UNTRUSTED_CALLER', 'トリガーの実行者以外からの呼び出しです');
  }
}

/**
 * 管理者本人がエディタから実行していることを確かめる。
 * 操作している人と実行権限の持ち主が同じで、設定シートの管理者メールと一致する場合だけ通す。
 */
function assertAdmin_(settings: Pick<Settings, 'adminEmail'>): string {
  const active = normalizeEmail_(Session.getActiveUser().getEmail());
  const effective = normalizeEmail_(Session.getEffectiveUser().getEmail());
  if (active === '' || active !== effective || active !== settings.adminEmail) {
    throw approvalError_('NOT_ADMIN', '管理者のみ実行できます');
  }
  return active;
}
