import {
  asRecord,
  exactKeys,
  integer,
  noSensitiveText,
  stringValue,
} from '../validation.ts';

export const CONTROLBOT_ROUTES = Object.freeze({
  poll: '/v1/runner/orders/poll',
  ack: '/v1/runner/orders/ack',
  events: '/v1/runner/events',
  heartbeat: '/v1/runner/heartbeat',
} as const);

type ControlBotRoutes = typeof CONTROLBOT_ROUTES;

export type ControlBotConnectionProfile = {
  version: 1;
  origin: string;
  routes: ControlBotRoutes;
  timeout_ms: number;
  backoff: {
    initial_ms: number;
    max_ms: number;
    max_attempts: number;
  };
  credential_ref: string;
  authority: 'unchanged';
  network_access: false;
};

const PROFILE_KEYS = [
  'version',
  'origin',
  'routes',
  'timeout_ms',
  'backoff',
  'credential_ref',
] as const;
const ROUTE_KEYS = ['poll', 'ack', 'events', 'heartbeat'] as const;
const BACKOFF_KEYS = ['initial_ms', 'max_ms', 'max_attempts'] as const;
const CREDENTIAL_REF_RE = /^credential:[a-z][a-z0-9._-]{0,63}$/;

function httpsOrigin(value: unknown): string {
  const raw = stringValue(value, 'origin', 240);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('origin inválido.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    raw !== parsed.origin
  ) {
    throw new TypeError(
      'origin debe ser un origin HTTPS canónico sin userinfo, path, query ni fragment.',
    );
  }
  return parsed.origin;
}

function routes(value: unknown): ControlBotRoutes {
  const record = asRecord(value, 'routes');
  exactKeys(record, ROUTE_KEYS, 'routes');
  for (const key of ROUTE_KEYS) {
    if (record[key] !== CONTROLBOT_ROUTES[key]) {
      throw new TypeError('routes.' + key + ' no pertenece al contrato cerrado.');
    }
  }
  return CONTROLBOT_ROUTES;
}

function backoff(value: unknown): ControlBotConnectionProfile['backoff'] {
  const record = asRecord(value, 'backoff');
  exactKeys(record, BACKOFF_KEYS, 'backoff');
  const initial = integer(record.initial_ms, 'backoff.initial_ms', 100, 5_000);
  const maximum = integer(record.max_ms, 'backoff.max_ms', initial, 60_000);
  const attempts = integer(record.max_attempts, 'backoff.max_attempts', 1, 8);
  return Object.freeze({
    initial_ms: initial,
    max_ms: maximum,
    max_attempts: attempts,
  });
}

function credentialRef(value: unknown): string {
  const parsed = noSensitiveText(
    stringValue(value, 'credential_ref', 80),
    'credential_ref',
  );
  if (!CREDENTIAL_REF_RE.test(parsed)) {
    throw new TypeError(
      'credential_ref debe ser una referencia opaca credential:<slug>.',
    );
  }
  return parsed;
}

export function parseControlBotConnectionProfile(
  input: unknown,
): ControlBotConnectionProfile {
  const record = asRecord(input, 'ControlBotConnectionProfile');
  exactKeys(record, PROFILE_KEYS, 'ControlBotConnectionProfile');
  if (record.version !== 1) {
    throw new TypeError('ControlBotConnectionProfile version inválida.');
  }

  return Object.freeze({
    version: 1,
    origin: httpsOrigin(record.origin),
    routes: routes(record.routes),
    timeout_ms: integer(record.timeout_ms, 'timeout_ms', 500, 30_000),
    backoff: backoff(record.backoff),
    credential_ref: credentialRef(record.credential_ref),
    authority: 'unchanged',
    network_access: false,
  });
}
