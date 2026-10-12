import {
  asRecord,
  exactKeys,
  slug,
  stableSha256,
  stringValue,
  uuid,
} from './validation.ts';

export type BrowserRemoteCapability =
  | 'browser.navigate'
  | 'browser.click_ref'
  | 'browser.type_ref'
  | 'browser.close';

export type BrowserRemoteProfile = {
  version: 1;
  authority: 'unchanged';
  runner_id: string;
  location: string;
  capability: BrowserRemoteCapability;
  remote_alias: string;
  fingerprint: string;
};

type BrowserRemoteProfileCore = Omit<BrowserRemoteProfile, 'fingerprint'>;

const PROFILE_KEYS = [
  'version',
  'runner_id',
  'location',
  'capability',
  'remote_alias',
] as const;

const ALLOWED_CAPABILITIES = new Set<BrowserRemoteCapability>([
  'browser.navigate',
  'browser.click_ref',
  'browser.type_ref',
  'browser.close',
]);

const OPAQUE_ALIAS_RE = /^[a-z][a-z0-9-]{0,63}$/;

function browserCapability(value: unknown): BrowserRemoteCapability {
  const parsed = stringValue(value, 'capability', 64);
  if (!ALLOWED_CAPABILITIES.has(parsed as BrowserRemoteCapability)) {
    throw new TypeError('capability browser no permitida.');
  }
  return parsed as BrowserRemoteCapability;
}

function opaqueAlias(value: unknown): string {
  const parsed = stringValue(value, 'remote_alias', 64);
  if (!OPAQUE_ALIAS_RE.test(parsed)) {
    throw new TypeError('remote_alias debe ser opaco y provider-neutral.');
  }
  return parsed;
}

export function browserRemoteProfile(input: unknown): BrowserRemoteProfile {
  const record = asRecord(input, 'BrowserRemoteProfileInput');
  exactKeys(record, PROFILE_KEYS, 'BrowserRemoteProfileInput');

  // Presence and enumerability alone do not rule out an accessor. A caller
  // may supply a getter whose side effects would run during validation.
  const ownData = (key: (typeof PROFILE_KEYS)[number]): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError(`BrowserRemoteProfileInput.${key} requiere un campo de datos.`);
    }
    return descriptor.value as unknown;
  };

  if (ownData('version') !== 1) {
    throw new TypeError('BrowserRemoteProfileInput version inválida.');
  }

  const core: BrowserRemoteProfileCore = {
    version: 1,
    authority: 'unchanged',
    runner_id: uuid(ownData('runner_id'), 'runner_id'),
    location: slug(ownData('location'), 'location'),
    capability: browserCapability(ownData('capability')),
    remote_alias: opaqueAlias(ownData('remote_alias')),
  };

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
