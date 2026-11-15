/**
 * stateMachine.test.ts
 * FN-004 状態遷移の判定のテスト（二重承認・却下後の承認・段階の取り違え）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGas } from './helpers/loadGas.ts';

const { ctx, get } = loadGas();
const S = get('STATUS');
const A = get('ACTION');
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test('TC-026 1段承認: 承認待ち → 承認済み', () => {
  const next = plain(ctx.transition_({ status: S.PENDING, currentStep: 1, totalSteps: 1 }, { type: A.APPROVE, step: 1 }));
  assert.deepEqual(next, { status: S.APPROVED, currentStep: 1, totalSteps: 1, completed: true, nextStep: null });
});

test('TC-027 2段承認: 1段目の承認で2段目へ進み、2段目の承認で承認済み', () => {
  const s1 = ctx.transition_({ status: S.PENDING, currentStep: 1, totalSteps: 2 }, { type: A.APPROVE, step: 1 });
  assert.equal(s1.status, S.PENDING);
  assert.equal(s1.nextStep, 2);
  assert.equal(s1.completed, false);
  const s2 = ctx.transition_(s1, { type: A.APPROVE, step: 2 });
  assert.equal(s2.status, S.APPROVED);
  assert.equal(s2.completed, true);
});

test('TC-028 却下: どの段階でも却下で終了する', () => {
  for (const [step, total] of [[1, 1], [1, 2], [2, 2]]) {
    const next = ctx.transition_({ status: S.PENDING, currentStep: step, totalSteps: total }, { type: A.REJECT, step });
    assert.equal(next.status, S.REJECTED);
    assert.equal(next.completed, true);
  }
});

test('TC-029 二重承認: 承認済み・却下の申請はどの操作も ALREADY_DECIDED', () => {
  for (const status of [S.APPROVED, S.REJECTED]) {
    for (const type of [A.APPROVE, A.REJECT]) {
      assert.throws(() => ctx.transition_({ status, currentStep: 1, totalSteps: 1 }, { type, step: 1 }), { code: 'ALREADY_DECIDED' });
    }
  }
});

test('TC-030 段階の取り違え: 1段目のトークンで2段目を、2段目のトークンで1段目を操作できない', () => {
  assert.throws(() => ctx.transition_({ status: S.PENDING, currentStep: 2, totalSteps: 2 }, { type: A.APPROVE, step: 1 }), { code: 'STEP_MISMATCH' });
  assert.throws(() => ctx.transition_({ status: S.PENDING, currentStep: 1, totalSteps: 2 }, { type: A.APPROVE, step: 2 }), { code: 'STEP_MISMATCH' });
});

test('TC-031 不正な操作・記録は拒否する', () => {
  assert.throws(() => ctx.transition_({ status: S.PENDING, currentStep: 1, totalSteps: 1 }, { type: 'delete', step: 1 }), { code: 'INVALID_ACTION' });
  assert.throws(() => ctx.transition_({ status: S.PENDING, currentStep: 3, totalSteps: 2 }, { type: A.APPROVE, step: 3 }), { code: 'INVALID_STATE' });
  assert.throws(() => ctx.transition_({ status: '保留', currentStep: 1, totalSteps: 1 }, { type: A.APPROVE, step: 1 }), { code: 'INVALID_STATE' });
});
