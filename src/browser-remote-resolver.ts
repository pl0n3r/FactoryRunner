import type {
  BrowserCapability,
  BrowserExecutionAdapter,
  BrowserExecutionContext,
} from './adapters/browser.ts';
import { bindBrowserRemoteAdapter } from './browser-remote-binding.ts';
import type { BrowserRemoteEntryHandle } from './browser-remote-entry-handle.ts';
import type { BrowserRemoteTransport } from './browser-remote-driver.ts';
import {
  BrowserRemoteDirectory,
  type BrowserRemoteDirectoryEntry,
} from './browser-remote-directory.ts';
import { asRecord, exactKeys, stringValue } from './validation.ts';

export type BrowserRemoteResolverInput = {
  directory: BrowserRemoteDirectory;
  allowed_origins: readonly string[];
  context: BrowserExecutionContext;
  capability: BrowserCapability;
};

export type BrowserRemotePinnedResolverInput = BrowserRemoteResolverInput & {
  binding_fingerprint: string;
};

export type BrowserRemoteHandleResolverInput = {
  handle: BrowserRemoteEntryHandle;
  allowed_origins: readonly string[];
  context: BrowserExecutionContext;
  capability: BrowserCapability;
  binding_fingerprint: string;
};

const SHA256_RE = /^[0-9a-f]{64}$/;

function sha256(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 64);
  if (!SHA256_RE.test(parsed)) throw new TypeError(label + ' inválido.');
  return parsed;
}

function resolverBindingContext(
  record: Record<string, unknown>,
): {
  allowedOrigins: readonly string[];
  context: BrowserExecutionContext;
  capability: BrowserCapability;
} {
  if (!Array.isArray(record.allowed_origins)) {
    throw new TypeError('allowed_origins debe ser un arreglo.');
  }

  const context = asRecord(record.context, 'BrowserExecutionContext');
  exactKeys(context, ['runner_id', 'order_id', 'location'], 'BrowserExecutionContext');

  return {
    allowedOrigins: record.allowed_origins as readonly string[],
    context: record.context as BrowserExecutionContext,
    capability: record.capability as BrowserCapability,
  };
}

function resolverContext(
  record: Record<string, unknown>,
): {
  directory: BrowserRemoteDirectory;
  allowedOrigins: readonly string[];
  context: BrowserExecutionContext;
  capability: BrowserCapability;
} {
  if (!(record.directory instanceof BrowserRemoteDirectory)) {
    throw new TypeError('BrowserRemoteDirectory requerido.');
  }

  return {
    directory: record.directory,
    ...resolverBindingContext(record),
  };
}

function bindResolvedEntry(
  entry: BrowserRemoteDirectoryEntry,
  input: {
    allowedOrigins: readonly string[];
    context: BrowserExecutionContext;
    capability: BrowserCapability;
  },
): BrowserExecutionAdapter {
  return bindBrowserRemoteAdapter({
    profile: entry.profile,
    transport: entry.transport,
    allowed_origins: input.allowedOrigins,
    context: input.context,
    capability: input.capability,
  });
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

  const parsed = resolverContext(record);
  const matches = parsed.directory.entries().filter(({ profile }) => (
    profile.runner_id === parsed.context.runner_id
    && profile.location === parsed.context.location
    && profile.capability === parsed.capability
  ));

  if (matches.length !== 1) {
    throw new TypeError('Binding browser remoto exacto no disponible.');
  }

  return bindResolvedEntry(matches[0], parsed);
}

export function resolvePinnedBrowserRemoteAdapter(
  input: BrowserRemotePinnedResolverInput,
): BrowserExecutionAdapter {
  const record = asRecord(input, 'BrowserRemotePinnedResolverInput');
  exactKeys(
    record,
    ['directory', 'allowed_origins', 'context', 'capability', 'binding_fingerprint'],
    'BrowserRemotePinnedResolverInput',
  );

  const parsed = resolverContext(record);
  const expectedFingerprint = sha256(
    record.binding_fingerprint,
    'binding_fingerprint',
  );
  const matches = parsed.directory.entries().filter(({ profile }) => (
    profile.fingerprint === expectedFingerprint
    && profile.runner_id === parsed.context.runner_id
    && profile.location === parsed.context.location
    && profile.capability === parsed.capability
  ));

  if (matches.length !== 1) {
    throw new TypeError('Binding browser remoto pinneado no disponible.');
  }

  return bindResolvedEntry(matches[0], parsed);
}


export function resolveBrowserRemoteHandleAdapter(
  input: BrowserRemoteHandleResolverInput,
): BrowserExecutionAdapter {
  const record = asRecord(input, 'BrowserRemoteHandleResolverInput');
  exactKeys(
    record,
    ['handle', 'allowed_origins', 'context', 'capability', 'binding_fingerprint'],
    'BrowserRemoteHandleResolverInput',
  );

  const parsed = resolverBindingContext(record);
  const handle = asRecord(record.handle, 'BrowserRemoteEntryHandle');
  exactKeys(
    handle,
    ['version', 'authority', 'profile', 'binding_fingerprint', 'execute', 'invoke'],
    'BrowserRemoteEntryHandle',
  );

  if (
    handle.version !== 1
    || handle.authority !== 'unchanged'
    || typeof handle.execute !== 'function'
    || typeof handle.invoke !== 'function'
  ) {
    throw new TypeError('BrowserRemoteEntryHandle inválido.');
  }

  const expectedFingerprint = sha256(
    record.binding_fingerprint,
    'binding_fingerprint',
  );
  const handleFingerprint = sha256(
    handle.binding_fingerprint,
    'handle.binding_fingerprint',
  );
  const profile = asRecord(handle.profile, 'BrowserRemoteProfile');
  const profileFingerprint = sha256(
    profile.fingerprint,
    'profile.fingerprint',
  );

  if (
    handleFingerprint !== expectedFingerprint
    || profileFingerprint !== expectedFingerprint
    || profile.runner_id !== parsed.context.runner_id
    || profile.location !== parsed.context.location
    || profile.capability !== parsed.capability
  ) {
    throw new TypeError('Handle browser remoto pinneado desalineado.');
  }

  const pinnedTransport: BrowserRemoteTransport = Object.freeze({
    execute: (request) => (
      (handle.invoke as BrowserRemoteEntryHandle['invoke'])(request)
    ),
  });

  return bindBrowserRemoteAdapter({
    profile: handle.profile as BrowserRemoteEntryHandle['profile'],
    transport: pinnedTransport,
    allowed_origins: parsed.allowedOrigins,
    context: parsed.context,
    capability: parsed.capability,
  });
}
