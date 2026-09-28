import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserExecutionAdapter,
  BrowserExecutionError,
} from '../src/index.ts';
import type {
  BrowserDriver,
  BrowserDriverCommand,
} from '../src/index.ts';

const RUNNER_ID = '11111111-1111-7111-8111-111111111111';
const ORDER_ID = '22222222-2222-7222-8222-222222222222';
const REF = 'browserref:element-0001';

class FakeDriver implements BrowserDriver {
  readonly commands: BrowserDriverCommand[] = [];
  result: unknown = { status: 'ok', ref: REF };
  error: Error | null = null;

  async execute(command: BrowserDriverCommand): Promise<unknown> {
    this.commands.push(structuredClone(command));
    if (this.error) throw this.error;
    return structuredClone(this.result);
  }
}

function adapter(location: 'hostinger-shared' | 'macos-local' = 'hostinger-shared') {
  const driver = new FakeDriver();
  const instance = new BrowserExecutionAdapter(
    driver,
    ['https://example.com', 'https://control.example.com:8443'],
    { runner_id: RUNNER_ID, order_id: ORDER_ID, location },
  );
  return { driver, instance };
}

test('browser adapter rejects unknown capabilities and arbitrary selector fields', async () => {
  const { driver, instance } = adapter();
  await assert.rejects(
    () => instance.execute('browser.eval', {}),
    /Browser capability no soportada/,
  );
  await assert.rejects(
    () => instance.execute('browser.click_ref', { ref: REF, selector: '#danger' }),
    /campos inválidos/,
  );
  await assert.rejects(
    () => instance.execute('browser.click_ref', { ref: '#danger' }),
    /browser ref inválida/,
  );
  assert.equal(driver.commands.length, 0);
});

test('browser navigation requires allowlisted HTTPS origin without userinfo query or hash', async () => {
  const { driver, instance } = adapter();

  await instance.execute('browser.navigate', { url: 'https://example.com/path' });
  assert.equal(driver.commands[0]?.kind, 'navigate');
  if (driver.commands[0]?.kind === 'navigate') {
    assert.equal(driver.commands[0].url, 'https://example.com/path');
  }

  for (const url of [
    'http://example.com/path',
    'https://user@example.com/path',
    'https://example.com/path?token=no',
    'https://example.com/path#frag',
    'https://evil.example/path',
    'https://example.com/a/../private',
    'https://example.com/a/%252e%252e/private',
  ]) {
    await assert.rejects(
      () => instance.execute('browser.navigate', { url }),
      /URL de navegación no permitida/,
    );
  }
});

test('click/type use opaque refs and type rejects sensitive or oversized text', async () => {
  const { driver, instance } = adapter();

  await instance.execute('browser.click_ref', { ref: REF });
  await instance.execute('browser.type_ref', { ref: REF, text: 'hello world' });

  assert.equal(driver.commands[0]?.kind, 'click_ref');
  assert.equal(driver.commands[1]?.kind, 'type_ref');
  if (driver.commands[1]?.kind === 'type_ref') {
    assert.equal(driver.commands[1].text, 'hello world');
  }

  await assert.rejects(
    () => instance.execute('browser.type_ref', { ref: REF, text: 'token=supersecretvalue' }),
    /material sensible/,
  );
  await assert.rejects(
    () => instance.execute('browser.type_ref', { ref: REF, text: 'x'.repeat(4_001) }),
    /browser text inválido/,
  );
});

test('browser results are sanitized and provider errors are generic', async () => {
  const { driver, instance } = adapter();
  driver.result = {
    status: 'ok',
    ref: REF,
    html: '<html>secret</html>',
  };
  await assert.rejects(
    () => instance.execute('browser.navigate', { url: 'https://example.com/' }),
    (error: unknown) => {
      assert.ok(error instanceof BrowserExecutionError);
      assert.equal(error.message, 'browser_execution_failed');
      return true;
    },
  );

  driver.result = { status: 'ok', ref: REF };
  const result = await instance.execute('browser.navigate', { url: 'https://example.com/' });
  assert.deepEqual(Object.keys(result).sort(), ['capability', 'ref', 'status']);
  assert.equal(JSON.stringify(result).includes('html'), false);

  driver.error = new Error('cookie=super-secret-provider-value');
  await assert.rejects(
    () => instance.execute('browser.close', {}),
    (error: unknown) => {
      assert.ok(error instanceof BrowserExecutionError);
      assert.equal(error.message.includes('cookie'), false);
      assert.equal(error.message.includes('provider'), false);
      return true;
    },
  );
});

test('location metadata does not change browser authorization semantics', async () => {
  const hostinger = adapter('hostinger-shared');
  const macos = adapter('macos-local');

  const hostingerResult = await hostinger.instance.execute('browser.click_ref', { ref: REF });
  const macosResult = await macos.instance.execute('browser.click_ref', { ref: REF });

  assert.deepEqual(hostingerResult, macosResult);
  assert.deepEqual(hostinger.driver.commands, macos.driver.commands);
  assert.equal(JSON.stringify(hostinger.driver.commands).includes('hostinger'), false);
  assert.equal(JSON.stringify(macos.driver.commands).includes('macos'), false);
});

test('session key is derived internally from runner/order and cannot be supplied by input', async () => {
  const { driver, instance } = adapter();

  await assert.rejects(
    () => instance.execute('browser.close', { session_key: 'attacker-session' }),
    /campos inválidos/,
  );
  await instance.execute('browser.close', {});
  assert.equal(driver.commands[0]?.kind, 'close');
  assert.match(driver.commands[0]?.session_key ?? '', /^browsersession:[0-9a-f]{64}$/);
  assert.equal((driver.commands[0]?.session_key ?? '').includes(RUNNER_ID), false);
  assert.equal((driver.commands[0]?.session_key ?? '').includes(ORDER_ID), false);
});
