import {
  BrowserExecutionAdapter,
  type BrowserCapability,
  type BrowserExecutionContext,
  type BrowserLocation,
} from './adapters/browser.ts';
import { bindBrowserRemoteAdapter } from './browser-remote-binding.ts';
import { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import {
  asRecord,
  exactKeys,
  stringValue,
  uuid,
} from './validation.ts';

export type BrowserRemoteResolverInput = {
  directory: BrowserRemoteDirectory;
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

function canonicalCapability(value: unknown): BrowserCapability {
  const parsed = stringValue(value, 'capability', 64);
  if (!CAPABILITIES.has(parsed as BrowserCapability)) {
    throw new TypeError('capability browser no permitida.');
  }
  return parsed as BrowserCapability;
}

function canonicalDirectory(value: unknown): BrowserRemoteDirectory {
  if (!(value instanceof BrowserRemoteDirectory)) {
    throw new TypeError('BrowserRemoteDirectory requerido.');
  }
  return value;
}

function allowedOrigins(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError('allowed_origins debe ser un arreglo.');
  }
  return value;
}

export function resolveBrowserRemoteAdapter(
  input: BrowserRemoteResolverInput,
): BrowserExecutionAdapter {
  const record = asRecord(input, 'BrowserRemoteResolverInput');
  exactKeys(
    record,
    ['directory', 'allowed_origins', 'context', 'capability'],
    'BrowserRemoteResolverInput',
  );

  const directory = canonicalDirectory(record.directory);
  const context = canonicalContext(record.context);
  const capability = canonicalCapability(record.capability);
  const origins = allowedOrigins(record.allowed_origins);

  const matches = directory.entries().filter(({ profile }) => (
    profile.runner_id === context.runner_id
    && profile.location === context.location
    && profile.capability === capability
  ));

  if (matches.length !== 1) {
    throw new TypeError('Binding browser remoto exacto no disponible.');
  }

  const [entry] = matches;
  return bindBrowserRemoteAdapter({
    profile: entry.profile,
    transport: entry.transport,
    allowed_origins: origins,
    context,
    capability,
  });
}
