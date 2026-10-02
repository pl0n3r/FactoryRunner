import type {
  BrowserRemoteTransport,
  BrowserRemoteTransportRequest,
} from './browser-remote-driver.ts';
import type { BrowserRemoteDirectoryEntry } from './browser-remote-directory.ts';
import {
  browserRemoteProfile,
  type BrowserRemoteProfile,
} from './browser-remote-profile.ts';
import {
  asRecord,
  exactKeys,
} from './validation.ts';

export type BrowserRemoteEntryHandle = Readonly<{
  version: 1;
  authority: 'unchanged';
  profile: BrowserRemoteProfile;
  binding_fingerprint: string;
  execute: BrowserRemoteTransport['execute'];
  invoke: (request: BrowserRemoteTransportRequest) => Promise<unknown>;
}>;

const PROFILE_KEYS = [
  'version',
  'authority',
  'runner_id',
  'location',
  'capability',
  'remote_alias',
  'fingerprint',
] as const;

function canonicalProfile(value: unknown): BrowserRemoteProfile {
  const record = asRecord(value, 'BrowserRemoteProfile');
  exactKeys(record, PROFILE_KEYS, 'BrowserRemoteProfile');

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

export function browserRemoteEntryHandle(
  input: BrowserRemoteDirectoryEntry,
): BrowserRemoteEntryHandle {
  const record = asRecord(input, 'BrowserRemoteDirectoryEntry');
  exactKeys(record, ['profile', 'transport'], 'BrowserRemoteDirectoryEntry');

  const profile = canonicalProfile(record.profile);
  const transport = record.transport as BrowserRemoteTransport;
  if (
    transport === null
    || typeof transport !== 'object'
    || typeof transport.execute !== 'function'
  ) {
    throw new TypeError('BrowserRemoteTransport requerido.');
  }

  const execute = transport.execute;
  const invoke = (request: BrowserRemoteTransportRequest): Promise<unknown> => (
    execute.call(transport, request)
  );

  return Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    profile,
    binding_fingerprint: profile.fingerprint,
    execute,
    invoke,
  });
}
