import type {
  BrowserCapability,
  BrowserExecutionAdapter,
  BrowserExecutionContext,
} from './adapters/browser.ts';
import { bindBrowserRemoteAdapter } from './browser-remote-binding.ts';
import { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import { asRecord, exactKeys } from './validation.ts';

export type BrowserRemoteResolverInput = {
  directory: BrowserRemoteDirectory;
  allowed_origins: readonly string[];
  context: BrowserExecutionContext;
  capability: BrowserCapability;
};

export function resolveBrowserRemoteAdapter(
  input: BrowserRemoteResolverInput,
): BrowserExecutionAdapter {
  const record = asRecord(input, 'BrowserRemoteResolverInput');
  exactKeys(
    record,
    ['directory', 'allowed_origins', 'context', 'capability'],
    'BrowserRemoteResolverInput',
  );

  if (!(record.directory instanceof BrowserRemoteDirectory)) {
    throw new TypeError('BrowserRemoteDirectory requerido.');
  }

  const context = asRecord(record.context, 'BrowserExecutionContext');
  exactKeys(context, ['runner_id', 'order_id', 'location'], 'BrowserExecutionContext');

  const matches = record.directory.entries().filter(({ profile }) => (
    profile.runner_id === context.runner_id
    && profile.location === context.location
    && profile.capability === record.capability
  ));

  if (matches.length !== 1) {
    throw new TypeError('Binding browser remoto exacto no disponible.');
  }
  if (!Array.isArray(record.allowed_origins)) {
    throw new TypeError('allowed_origins debe ser un arreglo.');
  }

  const [entry] = matches;
  return bindBrowserRemoteAdapter({
    profile: entry.profile,
    transport: entry.transport,
    allowed_origins: record.allowed_origins as readonly string[],
    context: record.context as BrowserExecutionContext,
    capability: record.capability as BrowserCapability,
  });
}
