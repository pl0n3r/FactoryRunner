import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECOVERY_REHEARSAL_STEPS,
  validateRecoveryRehearsalPlan,
} from '../src/recovery-rehearsal-plan.ts';

function fixture(): { version: 1; steps: Array<{ id: string; owner: string; target_minutes: number; expected_evidence: string }> } {
  return {
    version: 1,
    steps: RECOVERY_REHEARSAL_STEPS.map((step, index) => ({
      ...step,
      target_minutes: (index + 1) * 10,
    })),
  };
}

test('AC-01 complete synthetic backup, restore and rollback plan describes every ordered step', () => {
  const input = fixture();
  const report = validateRecoveryRehearsalPlan(input);
  assert.equal(report.status, 'PLAN_COMPLETE_OFFLINE');
  assert.deepEqual(report.missing_steps, []);
  assert.deepEqual(report.invalid_steps, []);
  assert.equal(report.steps.length, RECOVERY_REHEARSAL_STEPS.length);
  assert.deepEqual(report.steps.map((step) => step.id), RECOVERY_REHEARSAL_STEPS.map((step) => step.id));
  assert.equal(report.total_target_minutes, 360);
  for (const step of report.steps) {
    assert.ok(['sre', 'qa', 'security'].includes(step.owner));
    assert.match(step.expected_evidence, /^fixture:rehearsal\//);
    assert.ok(step.target_minutes > 0);
    assert.ok(Object.isFrozen(step));
  }
  assert.match(report.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(validateRecoveryRehearsalPlan(fixture()), report);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.steps));
});

test('AC-02 missing, duplicated, reordered and invalid entries cannot be marked complete', () => {
  const input = fixture();
  const missing = validateRecoveryRehearsalPlan({ ...input, steps: input.steps.slice(1) });
  assert.equal(missing.status, 'UNKNOWN');
  assert.deepEqual(missing.missing_steps, ['backup-preflight']);
  assert.deepEqual(missing.steps, []);
  assert.equal(missing.total_target_minutes, null);

  const reordered = validateRecoveryRehearsalPlan({ ...input, steps: [...input.steps].reverse() });
  assert.equal(reordered.status, 'UNKNOWN');
  assert.equal(reordered.steps.length, 0);

  const duplicate = [...input.steps];
  duplicate[3] = duplicate[2]!;
  const duplicated = validateRecoveryRehearsalPlan({ ...input, steps: duplicate });
  assert.equal(duplicated.status, 'UNKNOWN');
  assert.ok(duplicated.invalid_steps.includes('backup-verify'));
  assert.ok(duplicated.missing_steps.includes('restore-isolated'));

  for (const mutation of [
    { owner: 'owner@example.test' },
    { expected_evidence: 'https://example.com/backup.zip' },
    { expected_evidence: 'password=real-secret' },
    { target_minutes: 0 },
    { target_minutes: Number.NaN },
    { target_minutes: 241 },
  ]) {
    const steps = [...input.steps];
    steps[0] = { ...steps[0]!, ...mutation };
    const report = validateRecoveryRehearsalPlan({ ...input, steps });
    assert.equal(report.status, 'UNKNOWN');
    assert.deepEqual(report.steps, []);
    assert.ok(report.invalid_steps.includes('backup-preflight'));
    assert.equal(JSON.stringify(report).includes('password=real-secret'), false);
  }
});

test('AC-03 input is schema-bound and cannot carry secrets, people or executable commands', () => {
  const good = fixture();
  assert.throws(() => validateRecoveryRehearsalPlan({ ...good, password: 'real-secret' }), /invalid_fields/);
  assert.throws(() => validateRecoveryRehearsalPlan({ ...good, execute: true }), /invalid_fields/);
  assert.throws(() => validateRecoveryRehearsalPlan({ version: 1, steps: [{ ...good.steps[0], command: 'rm -rf /' }] }), /invalid_fields/);
  assert.throws(() => validateRecoveryRehearsalPlan({ version: 1, steps: [{ ...good.steps[0], api_token: 'sample' }] }), /invalid_fields/);
  assert.throws(() => validateRecoveryRehearsalPlan({ version: 1, steps: ['irrelevant'] }), /invalid_record/);
  assert.throws(() => validateRecoveryRehearsalPlan({ version: 1, steps: [{ ...good.steps[0], id: 'restore-live' }] }), /unknown_step/);
  assert.throws(() => validateRecoveryRehearsalPlan({ version: 2, steps: [] }), /invalid_input/);
  assert.throws(() => validateRecoveryRehearsalPlan({ version: 1, steps: new Array(9).fill(good.steps[0]) }), /invalid_input/);
  assert.throws(() => validateRecoveryRehearsalPlan(Object.create({ version: 1, steps: good.steps })), /invalid_prototype/);
  const getter = { version: 1, get steps() { throw new Error('getter executed'); } };
  assert.throws(() => validateRecoveryRehearsalPlan(getter), /invalid_fields/);
  const stepGetter = { ...good.steps[0], get owner() { throw new Error('getter executed'); } };
  assert.throws(() => validateRecoveryRehearsalPlan({ version: 1, steps: [stepGetter] }), /invalid_fields/);
});

test('AC-04 no synthetic outcome grants real backup, restore, rollback or live authority', () => {
  for (const input of [fixture(), { ...fixture(), steps: [] }]) {
    const report = validateRecoveryRehearsalPlan(input);
    assert.equal(report.execution_readiness, 'UNKNOWN');
    assert.equal(report.backup_executed, false);
    assert.equal(report.restore_executed, false);
    assert.equal(report.rollback_executed, false);
    assert.equal(report.live_authorized, false);
    assert.equal(report.network_access, false);
    assert.equal(report.external_mutation, false);
    assert.equal(JSON.stringify(report).includes('Bearer '), false);
  }
});
