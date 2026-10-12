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

  return value as BrowserRemoteProfile;
}

export function browserRemoteEntryHandle(
  input: BrowserRemoteDirectoryEntry,
): BrowserRemoteEntryHandle {
  const record = asRecord(input, 'BrowserRemoteDirectoryEntry');
  exactKeys(record, ['profile', 'transport'], 'BrowserRemoteDirectoryEntry');

  // The exported JS boundary must not read caller-owned accessors.
  const profileDescriptor = Object.getOwnPropertyDescriptor(record, 'profile');
  const transportDescriptor = Object.getOwnPropertyDescriptor(record, 'transport');
  if (
    profileDescriptor === undefined
    || !Object.hasOwn(profileDescriptor, 'value')
    || transportDescriptor === undefined
    || !Object.hasOwn(transportDescriptor, 'value')
  ) {
    throw new TypeError('BrowserRemoteDirectoryEntry requiere campos de datos.');
  }
  const profile = canonicalProfile(profileDescriptor.value);
  const candidate = transportDescriptor.value;
  if (candidate === null || typeof candidate !== 'object') {
    throw new TypeError('BrowserRemoteTransport requerido.');
  }

  const transport = candidate as BrowserRemoteTransport;
  let cursor: object | null = transport;
  let execute: BrowserRemoteTransport['execute'] | null = null;
  while (cursor !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, 'execute');
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
        throw new TypeError('BrowserRemoteTransport requerido.');
      }
      execute = descriptor.value as BrowserRemoteTransport['execute'];
      break;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  if (execute === null) {
    throw new TypeError('BrowserRemoteTransport requerido.');
  }
  let consumed = false;
  const invoke = (request: BrowserRemoteTransportRequest): Promise<unknown> => {
    if (consumed) {
      return Promise.reject(
        new TypeError('BrowserRemoteEntryHandle ya fue consumido.'),
      );
    }
    consumed = true;
    return execute.call(transport, request);
  };

  return Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    profile,
    binding_fingerprint: profile.fingerprint,
    execute,
    invoke,
  });
}
