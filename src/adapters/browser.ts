import {
  asRecord,
  exactKeys,
  noSensitiveText,
  stableSha256,
  stringValue,
  uuid,
} from '../validation.ts';

export type BrowserCapability =
  | 'browser.navigate'
  | 'browser.click_ref'
  | 'browser.type_ref'
  | 'browser.close';

export type BrowserLocation = 'hostinger-shared' | 'macos-local';

export type BrowserExecutionContext = {
  runner_id: string;
  order_id: string;
  location: BrowserLocation;
};

export type BrowserDriverCommand =
  | { kind: 'navigate'; session_key: string; url: string }
  | { kind: 'click_ref'; session_key: string; ref: string }
  | { kind: 'type_ref'; session_key: string; ref: string; text: string }
  | { kind: 'close'; session_key: string };

export type BrowserDriverResult = {
  status: 'ok' | 'not_found' | 'blocked' | 'closed';
  ref: string | null;
};

export interface BrowserDriver {
  execute(command: BrowserDriverCommand): Promise<unknown>;
}

export type BrowserExecutionResult = {
  capability: BrowserCapability;
  status: BrowserDriverResult['status'];
  ref: string | null;
};

const CAPABILITIES = new Set<BrowserCapability>([
  'browser.navigate',
  'browser.click_ref',
  'browser.type_ref',
  'browser.close',
]);

const DRIVER_STATUSES = new Set<BrowserDriverResult['status']>([
  'ok',
  'not_found',
  'blocked',
  'closed',
]);

const LOCATIONS = new Set<BrowserLocation>(['hostinger-shared', 'macos-local']);
const OPAQUE_REF_RE = /^browserref:[A-Za-z0-9][A-Za-z0-9._:-]{7,151}$/;

export class BrowserExecutionError extends Error {
  constructor(code = 'browser_execution_failed') {
    super(code);
    this.name = 'BrowserExecutionError';
  }
}

function parseContext(value: unknown): BrowserExecutionContext {
  const record = asRecord(value, 'browser context');
  exactKeys(record, ['runner_id', 'order_id', 'location'], 'browser context');

  const location = stringValue(record.location, 'location', 32);
  if (!LOCATIONS.has(location as BrowserLocation)) {
    throw new TypeError('location inválida.');
  }

  return {
    runner_id: uuid(record.runner_id, 'runner_id'),
    order_id: uuid(record.order_id, 'order_id'),
    location: location as BrowserLocation,
  };
}

function sessionKey(context: BrowserExecutionContext): string {
  return `browsersession:${stableSha256({
    runner_id: context.runner_id,
    order_id: context.order_id,
  })}`;
}

function opaqueRef(value: unknown, label = 'browser ref'): string {
  const parsed = noSensitiveText(stringValue(value, label, 160), label);
  if (!OPAQUE_REF_RE.test(parsed)) {
    throw new TypeError(`${label} inválida.`);
  }
  return parsed;
}

function allowedOrigin(value: unknown): string {
  const raw = stringValue(value, 'allowed origin', 240);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('Allowed origin inválido.');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== '/' ||
    raw !== parsed.origin
  ) {
    throw new TypeError('Allowed origin inválido.');
  }
  return parsed.origin;
}

function navigationUrl(value: unknown, allowedOrigins: ReadonlySet<string>): string {
  const raw = noSensitiveText(stringValue(value, 'url', 2048), 'url');
  if (raw.includes('\\')) throw new TypeError('URL de navegación no permitida.');

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('URL de navegación no permitida.');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !allowedOrigins.has(parsed.origin)
  ) {
    throw new TypeError('URL de navegación no permitida.');
  }

  const rawPathStart = raw.indexOf('/', 'https://'.length);
  const rawPath = rawPathStart === -1 ? '/' : raw.slice(rawPathStart);
  let decodedPath = rawPath;
  try {
    for (let depth = 0; depth < 3 && decodedPath.includes('%'); depth += 1) {
      decodedPath = decodeURIComponent(decodedPath);
    }
  } catch {
    throw new TypeError('URL de navegación no permitida.');
  }

  if (decodedPath.includes('%')) throw new TypeError('URL de navegación no permitida.');
  const segments = new Set(decodedPath.split('/'));
  if (segments.has('.') || segments.has('..')) {
    throw new TypeError('URL de navegación no permitida.');
  }

  return parsed.href;
}

function parseDriverResult(value: unknown): BrowserDriverResult {
  const record = asRecord(value, 'browser driver result');
  exactKeys(record, ['status', 'ref'], 'browser driver result');

  if (typeof record.status !== 'string' ||
      !DRIVER_STATUSES.has(record.status as BrowserDriverResult['status'])) {
    throw new TypeError('Browser driver status inválido.');
  }

  const status = record.status as BrowserDriverResult['status'];
  const parsedRef = record.ref === null ? null : opaqueRef(record.ref, 'driver ref');

  if (status === 'closed' && parsedRef !== null) {
    throw new TypeError('Browser driver result inválido.');
  }
  if (status === 'ok' && parsedRef === null) {
    throw new TypeError('Browser driver result inválido.');
  }

  return { status, ref: parsedRef };
}

function parseCapability(value: string): BrowserCapability {
  const parsed = stringValue(value, 'browser capability', 64);
  if (!CAPABILITIES.has(parsed as BrowserCapability)) {
    throw new TypeError('Browser capability no soportada.');
  }
  return parsed as BrowserCapability;
}

export class BrowserExecutionAdapter {
  readonly id = 'browser-execution';
  readonly capabilities = Object.freeze([
    'browser.navigate',
    'browser.click_ref',
    'browser.type_ref',
    'browser.close',
  ] as const);

  readonly #driver: BrowserDriver;
  readonly #allowedOrigins: ReadonlySet<string>;
  readonly #context: BrowserExecutionContext;

  constructor(
    driver: BrowserDriver,
    allowedOrigins: readonly string[],
    context: BrowserExecutionContext,
  ) {
    if (!driver || typeof driver.execute !== 'function') {
      throw new TypeError('Browser driver requerido.');
    }
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0 || allowedOrigins.length > 32) {
      throw new TypeError('Allowlist de origins inválida.');
    }
    const parsedOrigins = allowedOrigins.map((origin) => allowedOrigin(origin));
    if (new Set(parsedOrigins).size !== parsedOrigins.length) {
      throw new TypeError('Allowlist de origins duplicada.');
    }

    this.#driver = driver;
    this.#allowedOrigins = new Set(parsedOrigins);
    this.#context = parseContext(context);
  }

  async execute(capabilityInput: string, input: unknown): Promise<BrowserExecutionResult> {
    const capability = parseCapability(capabilityInput);
    const session_key = sessionKey(this.#context);
    let command: BrowserDriverCommand;

    if (capability === 'browser.navigate') {
      const record = asRecord(input, 'browser.navigate input');
      exactKeys(record, ['url'], 'browser.navigate input');
      command = {
        kind: 'navigate',
        session_key,
        url: navigationUrl(record.url, this.#allowedOrigins),
      };
    } else if (capability === 'browser.click_ref') {
      const record = asRecord(input, 'browser.click_ref input');
      exactKeys(record, ['ref'], 'browser.click_ref input');
      command = {
        kind: 'click_ref',
        session_key,
        ref: opaqueRef(record.ref),
      };
    } else if (capability === 'browser.type_ref') {
      const record = asRecord(input, 'browser.type_ref input');
      exactKeys(record, ['ref', 'text'], 'browser.type_ref input');
      const text = noSensitiveText(stringValue(record.text, 'browser text', 4_000), 'browser text');
      command = {
        kind: 'type_ref',
        session_key,
        ref: opaqueRef(record.ref),
        text,
      };
    } else {
      const record = asRecord(input, 'browser.close input');
      exactKeys(record, [], 'browser.close input');
      command = { kind: 'close', session_key };
    }

    try {
      const result = parseDriverResult(await this.#driver.execute(command));
      return Object.freeze({
        capability,
        status: result.status,
        ref: result.ref,
      });
    } catch {
      throw new BrowserExecutionError();
    }
  }
}
