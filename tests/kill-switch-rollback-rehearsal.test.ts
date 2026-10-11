import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FakeRehearsalRunner,
  FakeRehearsalControlBot,
  rehearseKillSwitchRollback,
} from '../scripts/rehearse-kill-switch-rollback.ts';

const observedAt = '2026-10-11T08:00:00Z';
const fakeOrderId = 'fake-execution-0001';

test('AC-01 tras el kill switch no se aceptan ejecuciones nuevas', () => {
  const runner = new FakeRehearsalRunner(false, ['fake-already-accepted']);
  const bot = new FakeRehearsalControlBot(false);
  const before = runner.snapshot();
  const outcome = rehearseKillSwitchRollback({ runner, controlBot: bot, fakeOrderId, observedAt });
  assert.equal(outcome.kind, 'offline_fake_only');
  assert.equal(outcome.paused_rejected_at_controlbot, true);
  assert.equal(outcome.paused_rejected_at_runner, true);
  assert.deepEqual(runner.snapshot(), before);
});

test('AC-02 rollback restaura el estado previo y la repeticion es idempotente', () => {
  for (const paused of [true, false]) {
    const runner = new FakeRehearsalRunner(paused, ['fake-original']);
    const bot = new FakeRehearsalControlBot(paused);
    const beforeRunner = runner.snapshot();
    const beforeBot = bot.snapshot();
    const first = rehearseKillSwitchRollback({ runner, controlBot: bot, fakeOrderId, observedAt });
    const second = rehearseKillSwitchRollback({ runner, controlBot: bot, fakeOrderId, observedAt });
    assert.deepEqual(first, second);
    assert.equal(first.rollback_restored, true);
    assert.deepEqual(runner.snapshot(), beforeRunner);
    assert.deepEqual(bot.snapshot(), beforeBot);
  }
});

test('AC-03 evidencia auditada no contiene secretos o entradas y no usa sistemas externos', () => {
  const runner = new FakeRehearsalRunner();
  const bot = new FakeRehearsalControlBot();
  const receipt = rehearseKillSwitchRollback({ runner, controlBot: bot, fakeOrderId, observedAt });
  assert.deepEqual(Object.keys(receipt).sort(), [
    'version', 'kind', 'observed_at', 'paused_rejected_at_controlbot',
    'paused_rejected_at_runner', 'rollback_restored',
    'original_runner_paused', 'original_controlbot_paused',
    'evidence_sha256', 'result',
  ].sort());
  assert.match(receipt.evidence_sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(receipt).includes(fakeOrderId), false);
  assert.equal(JSON.stringify(receipt).includes('password'), false);
  assert.throws(() => rehearseKillSwitchRollback({
    runner, controlBot: bot, fakeOrderId: 'fake-password=secret', observedAt,
  }), /invalid_fake_order_id/);
  assert.throws(() => rehearseKillSwitchRollback({
    runner, controlBot: bot, fakeOrderId, observedAt: 'bad-token-123',
  }), /invalid_observation_time/);
  assert.throws(() => rehearseKillSwitchRollback({
    runner, controlBot: bot, fakeOrderId, observedAt: '2026-02-30T08:00:00Z',
  }), /invalid_observation_time/);
  assert.deepEqual(runner.snapshot(), { paused: false, accepted: [] });
  assert.deepEqual(bot.snapshot(), { paused: false });
  assert.throws(() => rehearseKillSwitchRollback({
    runner: { snapshot: () => ({ paused: false, accepted: [] }) } as FakeRehearsalRunner,
    controlBot: bot, fakeOrderId, observedAt,
  }), /fake_only/);
});
