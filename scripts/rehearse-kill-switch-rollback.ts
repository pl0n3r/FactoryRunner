/**
 * Ensayo autocontenido de kill switch y rollback. Solo fakes en memoria:
 * no importa clientes HTTP, tokens ni APIs de ejecución de FactoryRunner.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FAKE_ORDER = /^fake-[a-z0-9-]{1,48}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

type RunnerSnapshot = Readonly<{ paused: boolean; accepted: readonly string[] }>;
type ControlBotSnapshot = Readonly<{ paused: boolean }>;

function fakeOrderId(input: unknown): string {
  if (typeof input !== 'string' || !FAKE_ORDER.test(input)) {
    throw new TypeError('invalid_fake_order_id');
  }
  return input;
}

function validateTimestamp(input: unknown): string {
  if (typeof input !== 'string' || !UTC_TIMESTAMP.test(input)
      || !Number.isFinite(Date.parse(input))
      || new Date(input).toISOString().slice(0, 19) !== input.slice(0, 19)) {
    throw new TypeError('invalid_observation_time');
  }
  return input;
}

/** A new instance cannot access a real runner: it only maintains its own private fields. */
export class FakeRehearsalRunner {
  #paused: boolean;
  #accepted: string[];

  constructor(paused = false, accepted: readonly string[] = []) {
    if (typeof paused !== 'boolean' || !Array.isArray(accepted)
        || accepted.length > 32) throw new TypeError('invalid_fake_runner_state');
    this.#paused = paused;
    this.#accepted = accepted.map(fakeOrderId);
  }

  snapshot(): RunnerSnapshot {
    return Object.freeze({ paused: this.#paused, accepted: Object.freeze([...this.#accepted]) });
  }

  setPaused(value: boolean): void {
    if (typeof value !== 'boolean') throw new TypeError('invalid_fake_pause');
    this.#paused = value;
  }

  tryAccept(orderId: string): boolean {
    fakeOrderId(orderId);
    if (this.#paused) return false;
    this.#accepted.push(orderId);
    return true;
  }

  restore(snapshot: RunnerSnapshot): void {
    if (typeof snapshot.paused !== 'boolean' || !Array.isArray(snapshot.accepted)
        || snapshot.accepted.length > 32) throw new TypeError('invalid_fake_rollback');
    const prior = snapshot.accepted.map(fakeOrderId);
    this.#accepted = [...prior];
    this.#paused = snapshot.paused;
  }
}

export class FakeRehearsalControlBot {
  #paused: boolean;

  constructor(paused = false) {
    if (typeof paused !== 'boolean') throw new TypeError('invalid_fake_controlbot_state');
    this.#paused = paused;
  }

  snapshot(): ControlBotSnapshot { return Object.freeze({ paused: this.#paused }); }

  setPaused(value: boolean): void {
    if (typeof value !== 'boolean') throw new TypeError('invalid_fake_pause');
    this.#paused = value;
  }

  dispatchFake(orderId: string, runner: FakeRehearsalRunner): boolean {
    fakeOrderId(orderId);
    if (Object.getPrototypeOf(runner) !== FakeRehearsalRunner.prototype) {
      throw new TypeError('fake_runner_required');
    }
    if (this.#paused) return false;
    return runner.tryAccept(orderId);
  }

  restore(snapshot: ControlBotSnapshot): void {
    if (typeof snapshot.paused !== 'boolean') throw new TypeError('invalid_fake_rollback');
    this.#paused = snapshot.paused;
  }
}

export type RehearsalReceipt = Readonly<{
  version: 1;
  kind: 'offline_fake_only';
  observed_at: string;
  paused_rejected_at_controlbot: boolean;
  paused_rejected_at_runner: boolean;
  rollback_restored: boolean;
  original_runner_paused: boolean;
  original_controlbot_paused: boolean;
  evidence_sha256: string;
  result: 'PASS';
}>;

/**
 * Execute both negative probes, then restore the exact in-memory fake states.
 * Invalid fake-only inputs fail before any state transition.
 */
export function rehearseKillSwitchRollback(input: {
  runner: FakeRehearsalRunner;
  controlBot: FakeRehearsalControlBot;
  fakeOrderId: string;
  observedAt: string;
}): RehearsalReceipt {
  if (!input || typeof input !== 'object') throw new TypeError('invalid_rehearsal_input');
  const { runner, controlBot } = input;
  if (Object.getPrototypeOf(runner) !== FakeRehearsalRunner.prototype
      || Object.getPrototypeOf(controlBot) !== FakeRehearsalControlBot.prototype) {
    throw new TypeError('fake_only');
  }
  const order = fakeOrderId(input.fakeOrderId);
  const observed = validateTimestamp(input.observedAt);
  const beforeRunner = runner.snapshot();
  const beforeControlBot = controlBot.snapshot();
  let deniedByControlBot = false;
  let deniedByRunner = false;
  try {
    controlBot.setPaused(true);
    runner.setPaused(true);
    deniedByControlBot = !controlBot.dispatchFake(order, runner);
    deniedByRunner = !runner.tryAccept(order);
  } finally {
    runner.restore(beforeRunner);
    controlBot.restore(beforeControlBot);
  }
  const afterRunner = runner.snapshot();
  const afterControlBot = controlBot.snapshot();
  const restored = JSON.stringify(afterRunner) === JSON.stringify(beforeRunner)
    && JSON.stringify(afterControlBot) === JSON.stringify(beforeControlBot);
  if (!deniedByControlBot || !deniedByRunner || !restored) {
    throw new Error('offline_rehearsal_failed');
  }
  const summary = {
    version: 1 as const, kind: 'offline_fake_only' as const,
    observed_at: observed,
    paused_rejected_at_controlbot: deniedByControlBot,
    paused_rejected_at_runner: deniedByRunner,
    rollback_restored: restored,
    original_runner_paused: beforeRunner.paused,
    original_controlbot_paused: beforeControlBot.paused,
    result: 'PASS' as const,
  };
  return Object.freeze({
    ...summary,
    evidence_sha256: createHash('sha256').update(JSON.stringify(summary)).digest('hex'),
  });
}


/** CLI de evidencia fake-only. El SHA pinnea la revision de origen, no una release. */
export function emitRehearsalReceiptCli(args: readonly string[]): {
  source_sha: string;
  receipt: RehearsalReceipt;
} {
  if (args.length !== 2 || args[0] !== '--source-sha'
      || !/^[0-9a-f]{40}$/.test(args[1] ?? '')) {
    throw new TypeError('invalid_source_sha');
  }
  return Object.freeze({
    source_sha: args[1],
    receipt: rehearseKillSwitchRollback({
      runner: new FakeRehearsalRunner(false, ['fake-already-accepted']),
      controlBot: new FakeRehearsalControlBot(false),
      fakeOrderId: 'fake-execution-0001',
      observedAt: '2026-10-11T08:00:00Z',
    }),
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.stdout.write(JSON.stringify(emitRehearsalReceiptCli(process.argv.slice(2))) + '\n');
  } catch {
    process.stderr.write('invalid_offline_rehearsal_request\n');
    process.exitCode = 2;
  }
}
