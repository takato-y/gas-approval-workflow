/**
 * StateMachine.js
 * 申請の状態遷移（純粋ロジック）。
 *
 * 承認待ち(段階n) --承認--> 承認待ち(段階n+1)   ※ n < 総段階
 * 承認待ち(最終段階) --承認--> 承認済み
 * 承認待ち(段階n) --却下--> 却下
 * 承認済み・却下からはどの操作も受け付けない（二重承認・却下後の承認を防ぐ）。
 */

const ACTION = Object.freeze({
  APPROVE: 'approve',
  REJECT: 'reject',
});

/**
 * 現在の状態と操作から次の状態を決める。許されない操作はエラーにする。
 * @param {{status: string, currentStep: number, totalSteps: number}} current
 * @param {{type: string, step: number}} action step は操作に使ったトークンの段階
 * @return {{status: string, currentStep: number, totalSteps: number, completed: boolean, nextStep: ?number}}
 */
function transition_(current, action) {
  const totalSteps = Number(current.totalSteps);
  const currentStep = Number(current.currentStep);
  if (!(totalSteps === 1 || totalSteps === 2) || !(currentStep >= 1 && currentStep <= totalSteps)) {
    throw approvalError_('INVALID_STATE', '申請の段階の記録が不正です');
  }
  if (!action || (action.type !== ACTION.APPROVE && action.type !== ACTION.REJECT)) {
    throw approvalError_('INVALID_ACTION', '操作の種類が不正です');
  }
  if (current.status === STATUS.APPROVED || current.status === STATUS.REJECTED) {
    throw approvalError_('ALREADY_DECIDED', 'この申請は既に' + current.status + 'です');
  }
  if (current.status !== STATUS.PENDING) {
    throw approvalError_('INVALID_STATE', '申請の状態の記録が不正です');
  }
  if (Number(action.step) !== currentStep) {
    throw approvalError_('STEP_MISMATCH', '現在の承認段階ではない操作です');
  }

  if (action.type === ACTION.REJECT) {
    return { status: STATUS.REJECTED, currentStep: currentStep, totalSteps: totalSteps, completed: true, nextStep: null };
  }
  if (currentStep < totalSteps) {
    return { status: STATUS.PENDING, currentStep: currentStep + 1, totalSteps: totalSteps, completed: false, nextStep: currentStep + 1 };
  }
  return { status: STATUS.APPROVED, currentStep: currentStep, totalSteps: totalSteps, completed: true, nextStep: null };
}
