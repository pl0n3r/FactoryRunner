import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AdapterRegistry,
  DurableJournal,
  ExecutionLoop,
  parseRunnerIdentity,
} from '../src/index.ts';
import type { ProgrammaticAdapterResult } from '../src/index.ts';

const runnerId = '11111111-1111-7111-8111-111111111111';
const orderId = '22222222-2222-7222-8222-222222222222';

function identity() {
  return parseRunnerIdentity({
    version: 1,
    runner_id: runnerId,
    protocol_version: 1,
    runtime: 'node',
    runtime_version: '0.1.4',
    platform: 'linux-arm64',
    location: 'test',
    capabilities: ['git'],
    max_parallel: 1,
  });
}

function order(overrides = {}) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: 'factoryrunner:work:51',
    runner_id: runnerId,
    capability: 'git',
    attempt: 1,
    issued_at: 1_000,
    expires_at: 2_000,
    instruction_ref: 'controlbot:instruction:factoryrunner-51',
    ...overrides,
  };
}

function result(): ProgrammaticAdapterResult {
  return {
    capability: 'git',
    data: { ok: true },
    evidence: { code: 'done', summary: 'Adapter completed', ref: null },
  };
}

async function withJournal(run: (path: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'factoryrunner-loop-'));
  try {
    await run(join(directory, 'runner.ndjson'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('execution loop dispatches validated orders once through registered adapter', async () => {
  await withJournal(async (path) => {
    let calls = 0;
    const registry = new AdapterRegistry([{
      id: 'fake',
      capabilities: ['git'],
      async execute(capability) {
        calls += 1;
        assert.equal(capability, 'git');
        return result();
      },
    }]);

    const firstLoop = new ExecutionLoop({
      journal: new DurableJournal(path),
      registry,
      identity: identity(),
      now: () => 1_100,
    });
    const first = await firstLoop.execute(order(), { timeout_ms: 100 });
    assert.equal(first.event.state, 'completed');
    assert.equal(first.reused, false);
    assert.equal(first.adapter_result?.capability, 'git');
    assert.equal(calls, 1);

    const restarted = new ExecutionLoop({
      journal: new DurableJournal(path),
      registry,
      identity: identity(),
      now: () => 1_200,
    });
    const replay = await restarted.execute(order(), { timeout_ms: 100 });
    assert.equal(replay.event.state, 'completed');
    assert.equal(replay.reused, true);
    assert.equal(replay.adapter_result, null);
    assert.equal(calls, 1);

    const recovered = new DurableJournal(path).recover();
    assert.deepEqual(recovered.events.map((event) => event.state), [
      'accepted', 'started', 'completed',
    ]);
  });
});

test('timeout cancel and restart preserve terminal state without duplicate effect', async () => {
  await withJournal(async (path) => {
    let timeoutCalls = 0;
    const timeoutRegistry = new AdapterRegistry([{
      id: 'timeout',
      capabilities: ['git'],
      async execute() {
        timeoutCalls += 1;
        return new Promise<ProgrammaticAdapterResult>(() => {});
      },
    }]);
    const timed = new ExecutionLoop({
      journal: new DurableJournal(path),
      registry: timeoutRegistry,
      identity: identity(),
      now: () => 1_100,
    });
    const timedOut = await timed.execute(order(), { timeout_ms: 5 });
    assert.equal(timedOut.event.state, 'failed');
    assert.equal(timedOut.event.evidence.code, 'timeout');
    assert.equal(timeoutCalls, 1);

    const timedRestart = new ExecutionLoop({
      journal: new DurableJournal(path),
      registry: timeoutRegistry,
      identity: identity(),
      now: () => 1_200,
    });
    assert.equal((await timedRestart.execute(order())).event.state, 'failed');
    assert.equal(timeoutCalls, 1);

    const cancelPath = `${path}.cancel`;
    let cancelCalls = 0;
    const cancelRegistry = new AdapterRegistry([{
      id: 'cancel',
      capabilities: ['git'],
      async execute() {
        cancelCalls += 1;
        return new Promise<ProgrammaticAdapterResult>(() => {});
      },
    }]);
    const controller = new AbortController();
    const cancelledLoop = new ExecutionLoop({
      journal: new DurableJournal(cancelPath),
      registry: cancelRegistry,
      identity: identity(),
      now: () => 1_100,
    });
    queueMicrotask(() => controller.abort());
    const cancelled = await cancelledLoop.execute(order(), {
      timeout_ms: 100,
      signal: controller.signal,
    });
    assert.equal(cancelled.event.state, 'cancelled');
    assert.equal(cancelCalls, 1);

    const cancelRestart = new ExecutionLoop({
      journal: new DurableJournal(cancelPath),
      registry: cancelRegistry,
      identity: identity(),
      now: () => 1_200,
    });
    assert.equal((await cancelRestart.execute(order())).event.state, 'cancelled');
    assert.equal(cancelCalls, 1);

    const restartPath = `${path}.restart`;
    const journal = new DurableJournal(restartPath);
    journal.appendOrder(order());
    journal.appendEvent({
      version: 1,
      event_id: '33333333-3333-7333-8333-333333333333',
      order_id: orderId,
      runner_id: runnerId,
      sequence: 1,
      state: 'accepted',
      occurred_at: 1_100,
      evidence: { code: 'accepted', summary: 'Accepted before restart', ref: null },
    });
    journal.appendEvent({
      version: 1,
      event_id: '44444444-4444-7444-8444-444444444444',
      order_id: orderId,
      runner_id: runnerId,
      sequence: 2,
      state: 'started',
      occurred_at: 1_101,
      evidence: { code: 'started', summary: 'Started before restart', ref: null },
    });

    let restartCalls = 0;
    const restartRegistry = new AdapterRegistry([{
      id: 'restart',
      capabilities: ['git'],
      async execute() {
        restartCalls += 1;
        return result();
      },
    }]);
    const recoveredLoop = new ExecutionLoop({
      journal: new DurableJournal(restartPath),
      registry: restartRegistry,
      identity: identity(),
      now: () => 1_200,
    });
    const recovered = await recoveredLoop.execute(order());
    assert.equal(recovered.event.state, 'failed');
    assert.equal(recovered.event.evidence.code, 'restart-interrupted');
    assert.equal(restartCalls, 0);

    const again = await recoveredLoop.execute(order());
    assert.equal(again.event.state, 'failed');
    assert.equal(again.reused, true);
    assert.equal(restartCalls, 0);
  });
});


test('AC01 same-instance concurrent order preserves in-flight terminal success', async () => {
  await withJournal(async (path) => {
    let dispatches = 0;
    let adapterStarted!: () => void;
    let releaseAdapter!: (value: ProgrammaticAdapterResult) => void;
    const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
    const registry = new AdapterRegistry([{
      id: 'held',
      capabilities: ['git'],
      async execute() {
        dispatches += 1;
        adapterStarted();
        return new Promise<ProgrammaticAdapterResult>((resolve) => { releaseAdapter = resolve; });
      },
    }]);
    const loop = new ExecutionLoop({
      journal: new DurableJournal(path),
      registry,
      identity: identity(),
      now: () => 1_100,
    });
    const first = loop.execute(order(), { timeout_ms: 1_000 });
    await started;
    const states = () => new DurableJournal(path).recover().events.map((event) => event.state);
    assert.deepEqual(states(), ['accepted', 'started']);
    await assert.rejects(loop.execute(order()), /Orden ya en ejecución en esta instancia/);
    assert.deepEqual(states(), ['accepted', 'started'], 'duplicate must not mark an active order interrupted');
    assert.equal(dispatches, 1);
    releaseAdapter(result());
    const completed = await first;
    assert.equal(completed.event.state, 'completed');
    assert.equal(completed.reused, false);
    assert.deepEqual(states(), ['accepted', 'started', 'completed']);
    const replay = await loop.execute(order());
    assert.equal(replay.reused, true);
    assert.equal(replay.event.state, 'completed');
    assert.equal(dispatches, 1);
  });
});

test('AC02 in-flight guard clears on timeout and cancel', async () => {
  for (const kind of ['timeout', 'cancel'] as const) {
    await withJournal(async (path) => {
      let dispatches = 0;
      let adapterStarted!: () => void;
      const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
      const registry = new AdapterRegistry([{
        id: 'held',
        capabilities: ['git'],
        async execute() {
          dispatches += 1;
          adapterStarted();
          return new Promise<ProgrammaticAdapterResult>(() => {});
        },
      }]);
      const controller = new AbortController();
      const loop = new ExecutionLoop({
        journal: new DurableJournal(path),
        registry,
        identity: identity(),
        now: () => 1_100,
      });
      const first = loop.execute(order(), {
        timeout_ms: kind === 'timeout' ? 10 : 1_000,
        signal: controller.signal,
      });
      await started;
      await assert.rejects(loop.execute(order()), /Orden ya en ejecución en esta instancia/);
      assert.deepEqual(
        new DurableJournal(path).recover().events.map((event) => event.state),
        ['accepted', 'started'],
      );
      if (kind === 'cancel') controller.abort();
      const terminal = await first;
      assert.equal(terminal.event.state, kind === 'timeout' ? 'failed' : 'cancelled');
      assert.equal(terminal.event.evidence.code, kind === 'timeout' ? 'timeout' : 'cancelled');
      const replay = await loop.execute(order());
      assert.equal(replay.reused, true, 'guard must be cleared for terminal replay');
      assert.equal(replay.event.state, terminal.event.state);
      assert.equal(dispatches, 1);
    });
  }
});
