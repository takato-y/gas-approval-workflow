/**
 * Reminder.ts
 * 督促対象の選定（純粋ロジック）。
 *
 * - 承認待ちで、最後の通知から「督促開始時間」以上たった申請を督促する。
 * - 督促回数が上限に達した申請は、督促の代わりに管理者へ1回だけ知らせる。
 * - 管理者へ知らせた後（督促回数 = 上限 + 1）は何もしない（毎時同じ知らせを送らない）。
 */

interface ReminderItem {
  rowNumber: number;
  request: ApprovalRequest;
}

function selectReminders_(
  items: ReminderItem[],
  nowMs: number,
  settings: Pick<Settings, 'remindAfterHours' | 'maxReminders'>,
): { remind: ReminderItem[]; escalate: ReminderItem[] } {
  const remind: ReminderItem[] = [];
  const escalate: ReminderItem[] = [];
  const waitMs = settings.remindAfterHours * 3600 * 1000;
  items.forEach(function (item) {
    const r = item.request;
    if (r.status !== STATUS.PENDING) return;
    const last = toMillis_(r.lastNotifiedAt);
    // 最終通知日時が読めない場合は、止まったままにしないよう督促の対象にする
    const due = !Number.isFinite(last) || nowMs - last >= waitMs;
    if (!due) return;
    const count = Number(r.reminderCount) || 0;
    if (count < settings.maxReminders) remind.push(item);
    else if (count === settings.maxReminders) escalate.push(item);
  });
  return { remind, escalate };
}
