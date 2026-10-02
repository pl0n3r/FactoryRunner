import {
  BrowserExecutionAdapter,
  type BrowserCapability,
  type BrowserExecutionContext,
  type BrowserLocation,
} from './adapters/browser.ts';
import {
  browserRemoteProfile,
  type BrowserRemoteProfile,
} from './browser-remote-profile.ts';
import {
  BrowserRemoteDriver,
  type BrowserRemoteTransport,
} from './browser-remote-driver.ts';
import {
  asRecord,
  exactKeys,
  stringValue,
  uuid,
} from './validation.ts';

export type BrowserRemoteBindingInput = {
  profile: BrowserRemoteProfile;
  transport: BrowserRemoteTransport;
  allowed_origins: readonly string[];
  context: BrowserExecutionContext;
  capability: BrowserCapability;
};

const LOCATIONS = new Set<BrowserLocation>([
  'hostinger-shared',
  'macos-local',
]);

const CAPABILITIES = new Set<BrowserCapability>([
  'browser.navigate',
  'browser.click_ref',
  'browser.type_ref',
  'browser.close',
]);

function canonicalCapability(value: unknown): BrowserCapability {
  const parsed = stringValue(value, 'capability', 64);
  if (!CAPABILITIES.has(parsed as BrowserCapability)) {
    throw new TypeError('capability browser no permitida.');
  }
  return parsed as BrowserCapability;
}

function canonicalContext(value: unknown): BrowserExecutionContext {
  const record = asRecord(value, 'BrowserExecutionContext');
  exactKeys(record, ['runner_id', 'order_id', 'location'], 'BrowserExecutionContext');

  const location = stringValue(record.location, 'location', 32);
  if (!LOCATIONS.has(location as BrowserLocation)) {
    throw new TypeError('location browser no permitida.');
  }

  return Object.freeze({
    runner_id: uuid(record.runner_id, 'runner_id'),
    order_id: uuid(record.order_id, 'order_id'),
    location: location as BrowserLocation,
  });
}

function canonicalProfile(value: unknown): BrowserRemoteProfile {
  const record = asRecord(value, 'BrowserRemoteProfile');
  exactKeys(record, [
    'version',
    'authority',
    'runner_id',
    'location',
    'capability',
    'remote_alias',
    'fingerprint',
  ], 'BrowserRemoteProfile');

  const canonical = browserRemoteProfile({
    version: record.version,
    runner_id: record.runner_id,
    location: record.location,
    capability: record.capability,
    remote_alias: record.remote_alias,
  });

  if (
    record.authority !== canonical.authority
    || record.fingerprint !== canonical.fingerprint
  ) {
    throw new TypeError('BrowserRemoteProfile no es canónico.');
  }

  return canonical;
}

function transport(value: unknown): BrowserRemoteTransport {
  if (
    value === null
    || typeof value !== 'object'
    || typeof (value as BrowserRemoteTransport).execute !== 'function'
  ) {
    throw new TypeError('BrowserRemoteTransport requerido.');
  }
  return value as BrowserRemoteTransport;
}

function allowedOrigins(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('allowed_origins debe ser un arreglo.');
  }
  return value;
}

export function bindBrowserRemoteAdapter(
  input: BrowserRemoteBindingInput,
): BrowserExecutionAdapter {
  const record = asRecord(input, 'BrowserRemoteBindingInput');
  exactKeys(record, [
    'profile',
    'transport',
    'allowed_origins',
    'context',
    'capability',
  ], 'BrowserRemoteBindingInput');

  const profile = canonicalProfile(record.profile);
  const context = canonicalContext(record.context);
  const capability = canonicalCapability(record.capability);
  const remoteTransport = transport(record.transport);
  const origins = allowedOrigins(record.allowed_origins);

  if (
    profile.runner_id !== context.runner_id
    || profile.location !== context.location
    || profile.capability !== capability
  ) {
    throw new TypeError('Perfil browser remoto desalineado.');
  }

  const driver = new BrowserRemoteDriver(profile, remoteTransport);
  return new BrowserExecutionAdapter(driver, origins, context);
}
