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

  // Validate the complete nested profile by own data descriptors before
  // accessing a single caller-owned value, including authority/fingerprint.
  const values = Object.fromEntries(PROFILE_KEYS.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`BrowserRemoteProfile.${key} requiere un campo de datos.`);
    }
    return [key, descriptor.value as unknown] as const;
  })) as Record<(typeof PROFILE_KEYS)[number], unknown>;

  const canonical = browserRemoteProfile({
    version: values.version,
    runner_id: values.runner_id,
    location: values.location,
    capability: values.capability,
    remote_alias: values.remote_alias,
  });

  if (
    values.authority !== canonical.authority
    || values.fingerprint !== canonical.fingerprint
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
