import type {
  BrowserDriver,
  BrowserDriverCommand,
  BrowserDriverResult,
} from './adapters/browser.ts';
import {
  browserRemoteProfile,
  type BrowserRemoteProfile,
} from './browser-remote-profile.ts';
import {
  asRecord,
  exactKeys,
  noSensitiveText,
  stableSha256,
  stringValue,
} from './validation.ts';

export type BrowserRemoteTransportRequest = {
  version: 1;
  authority: 'unchanged';
  profile_fingerprint: string;
  runner_id: string;
  location: string;
  capability: BrowserRemoteProfile['capability'];
  remote_alias: string;
  command: BrowserDriverCommand;
  request_fingerprint: string;
};

export type BrowserRemoteTransportResponse = {
  version: 1;
  authority: 'unchanged';
  request_fingerprint: string;
  status: BrowserDriverResult['status'];
  ref: string | null;
};

export interface BrowserRemoteTransport {
  execute(request: BrowserRemoteTransportRequest): Promise<unknown>;
}

type RemoteRequestCore = Omit<BrowserRemoteTransportRequest, 'request_fingerprint'>;

const DRIVER_STATUSES = new Set<BrowserDriverResult['status']>([
  'ok',
  'not_found',
  'blocked',
  'closed',
]);

const OPAQUE_REF_RE = /^browserref:[A-Za-z0-9][A-Za-z0-9._:-]{7,151}$/;
const SESSION_KEY_RE = /^browsersession:[0-9a-f]{64}$/;

function canonicalProfile(input: BrowserRemoteProfile): BrowserRemoteProfile {
  const record = asRecord(input, 'BrowserRemoteProfile');
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

function sessionKey(value: unknown): string {
  const parsed = stringValue(value, 'session_key', 80);
  if (!SESSION_KEY_RE.test(parsed)) {
    throw new TypeError('session_key inválido.');
  }
  return parsed;
}

function opaqueRef(value: unknown, label: string): string {
  const parsed = noSensitiveText(stringValue(value, label, 160), label);
  if (!OPAQUE_REF_RE.test(parsed)) {
    throw new TypeError(label + ' inválido.');
  }
  return parsed;
}

function commandCapability(command: BrowserDriverCommand): BrowserRemoteProfile['capability'] {
  if (command.kind === 'navigate') return 'browser.navigate';
  if (command.kind === 'click_ref') return 'browser.click_ref';
  if (command.kind === 'type_ref') return 'browser.type_ref';
  return 'browser.close';
}

function canonicalCommand(input: BrowserDriverCommand): BrowserDriverCommand {
  const record = asRecord(input, 'BrowserDriverCommand');
  const kind = stringValue(record.kind, 'command.kind', 32);

  if (kind === 'navigate') {
    exactKeys(record, ['kind', 'session_key', 'url'], 'navigate command');
    const url = noSensitiveText(stringValue(record.url, 'command.url', 2048), 'command.url');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new TypeError('command.url inválida.');
    }
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
      throw new TypeError('command.url inválida.');
    }
    return Object.freeze({
      kind: 'navigate',
      session_key: sessionKey(record.session_key),
      url: parsed.toString(),
    });
  }

  if (kind === 'click_ref') {
    exactKeys(record, ['kind', 'session_key', 'ref'], 'click_ref command');
    return Object.freeze({
      kind: 'click_ref',
      session_key: sessionKey(record.session_key),
      ref: opaqueRef(record.ref, 'command.ref'),
    });
  }

  if (kind === 'type_ref') {
    exactKeys(record, ['kind', 'session_key', 'ref', 'text'], 'type_ref command');
    return Object.freeze({
      kind: 'type_ref',
      session_key: sessionKey(record.session_key),
      ref: opaqueRef(record.ref, 'command.ref'),
      text: noSensitiveText(
        stringValue(record.text, 'command.text', 4_000),
        'command.text',
      ),
    });
  }

  if (kind === 'close') {
    exactKeys(record, ['kind', 'session_key'], 'close command');
    return Object.freeze({
      kind: 'close',
      session_key: sessionKey(record.session_key),
    });
  }

  throw new TypeError('command.kind no soportado.');
}

function parseResponse(
  value: unknown,
  requestFingerprint: string,
): BrowserDriverResult {
  const record = asRecord(value, 'BrowserRemoteTransportResponse');
  exactKeys(record, [
    'version',
    'authority',
    'request_fingerprint',
    'status',
    'ref',
  ], 'BrowserRemoteTransportResponse');

  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.request_fingerprint !== requestFingerprint
  ) {
    throw new TypeError('Respuesta remota desalineada.');
  }

  if (
    typeof record.status !== 'string'
    || !DRIVER_STATUSES.has(record.status as BrowserDriverResult['status'])
  ) {
    throw new TypeError('Remote driver status inválido.');
  }

  const status = record.status as BrowserDriverResult['status'];
  const ref = record.ref === null ? null : opaqueRef(record.ref, 'response.ref');

  if ((status === 'ok' && ref === null) || (status === 'closed' && ref !== null)) {
    throw new TypeError('Respuesta remota inválida.');
  }

  return Object.freeze({ status, ref });
}

export class BrowserRemoteDriver implements BrowserDriver {
  readonly #profile: BrowserRemoteProfile;
  readonly #transport: BrowserRemoteTransport;

  constructor(
    profile: BrowserRemoteProfile,
    transport: BrowserRemoteTransport,
  ) {
    if (!transport || typeof transport.execute !== 'function') {
      throw new TypeError('BrowserRemoteTransport requerido.');
    }
    this.#profile = canonicalProfile(profile);
    this.#transport = transport;
  }

  async execute(commandInput: BrowserDriverCommand): Promise<unknown> {
    const command = canonicalCommand(commandInput);
    if (commandCapability(command) !== this.#profile.capability) {
      throw new TypeError('Comando no corresponde a capability del perfil remoto.');
    }

    const core: RemoteRequestCore = {
      version: 1,
      authority: 'unchanged',
      profile_fingerprint: this.#profile.fingerprint,
      runner_id: this.#profile.runner_id,
      location: this.#profile.location,
      capability: this.#profile.capability,
      remote_alias: this.#profile.remote_alias,
      command,
    };
    const requestFingerprint = stableSha256(core);
    const request: BrowserRemoteTransportRequest = Object.freeze({
      ...core,
      request_fingerprint: requestFingerprint,
    });

    const response = await this.#transport.execute(request);
    return parseResponse(response, requestFingerprint);
  }
}
