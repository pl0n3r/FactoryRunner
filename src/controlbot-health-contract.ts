/**
 * Contrato offline de HEALTH de ControlBot: no conecta, despacha ni concede autoridad.
 * Una firma válida solo acredita la simulación; el caller debe fijar una clave pública
 * de confianza externa antes de interpretar un HEALTH real.
 */
import { generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { asRecord, exactKeys, integer, semver, uuid } from './validation.ts';

export type ControlBotHealthPayload = Readonly<{
  version: 1;
  service: 'controlbot';
  instance_id: string;
  release_version: string;
  release_sha: string;
  observed_at: number; // Unix seconds
  nonce: string; // Challenge supplied by the verifier; never a credential
  status: 'healthy' | 'degraded';
}>;

export type SignedControlBotHealth = Readonly<{
  payload: ControlBotHealthPayload;
  signature: string; // Ed25519, base64url, 64 bytes
}>;

export type ControlBotHealthTrust = Readonly<{
  publicKey: KeyObject;
  expectedInstanceId: string;
  expectedVersion: string;
  expectedSha: string;
  expectedNonce: string;
  now: number; // Unix seconds
  maxAgeSeconds: number;
}>;

export type ControlBotHealthVerdict = Readonly<{
  status: 'OK' | 'STALE' | 'UNKNOWN';
  authenticated: boolean;
  reason: string;
}>;

const PAYLOAD_KEYS = [
  'version', 'service', 'instance_id', 'release_version',
  'release_sha', 'observed_at', 'nonce', 'status',
] as const;
const SHA_RE = /^[0-9a-f]{40}$/;
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/;

function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    throw new TypeError('SHA inválido.');
  }
  return value;
}

function payloadFrom(input: unknown): ControlBotHealthPayload {
  const record = asRecord(input, 'ControlBotHealthPayload');
  exactKeys(record, PAYLOAD_KEYS, 'ControlBotHealthPayload');
  if (record.version !== 1 || record.service !== 'controlbot') {
    throw new TypeError('Identidad de HEALTH inválida.');
  }
  if (record.status !== 'healthy' && record.status !== 'degraded') {
    throw new TypeError('Estado HEALTH inválido.');
  }
  return {
    version: 1,
    service: 'controlbot',
    instance_id: uuid(record.instance_id, 'health.instance_id'),
    release_version: semver(record.release_version, 'health.release_version'),
    release_sha: sha(record.release_sha),
    observed_at: integer(record.observed_at, 'health.observed_at'),
    nonce: uuid(record.nonce, 'health.nonce'),
    status: record.status,
  };
}

function decision(
  status: ControlBotHealthVerdict['status'],
  authenticated: boolean,
  reason: string,
): ControlBotHealthVerdict {
  return Object.freeze({ status, authenticated, reason });
}

/**
 * Fail closed: never turns missing, unsigned, invalid, mismatched or future
 * evidence into OK. STALE requires valid signature and pinned identity.
 * Freshness and nonce are checked against explicit caller inputs, not a clock
 * or trusted endpoint hidden in this module.
 */
export function assessControlBotHealth(
  input: unknown,
  trust: ControlBotHealthTrust,
): ControlBotHealthVerdict {
  try {
    if (trust.publicKey.type !== 'public' || trust.publicKey.asymmetricKeyType !== 'ed25519') {
      return decision('UNKNOWN', false, 'untrusted_key');
    }
    const instanceId = uuid(trust.expectedInstanceId, 'expectedInstanceId');
    const version = semver(trust.expectedVersion, 'expectedVersion');
    const releaseSha = sha(trust.expectedSha);
    const nonce = uuid(trust.expectedNonce, 'expectedNonce');
    const now = integer(trust.now, 'now');
    const maxAge = integer(trust.maxAgeSeconds, 'maxAgeSeconds', 1, 86_400);

    const envelope = asRecord(input, 'SignedControlBotHealth');
    exactKeys(envelope, ['payload', 'signature'], 'SignedControlBotHealth');
    const payload = payloadFrom(envelope.payload);
    if (typeof envelope.signature !== 'string' || !SIGNATURE_RE.test(envelope.signature)) {
      return decision('UNKNOWN', false, 'signature_missing_or_invalid');
    }
    const signature = Buffer.from(envelope.signature, 'base64url');
    if (signature.length !== 64 ||
      !verify(null, Buffer.from(JSON.stringify(payload)), trust.publicKey, signature)) {
      return decision('UNKNOWN', false, 'signature_invalid');
    }
    if (payload.instance_id !== instanceId || payload.release_version !== version ||
      payload.release_sha !== releaseSha || payload.nonce !== nonce) {
      return decision('UNKNOWN', false, 'identity_or_challenge_mismatch');
    }
    if (payload.observed_at > now) {
      return decision('UNKNOWN', true, 'future_observation');
    }
    if (now - payload.observed_at > maxAge) {
      return decision('STALE', true, 'observation_expired');
    }
    if (payload.status !== 'healthy') {
      return decision('UNKNOWN', true, 'health_not_healthy');
    }
    return decision('OK', true, 'signed_fresh_health');
  } catch {
    return decision('UNKNOWN', false, 'invalid_evidence');
  }
}

/**
 * Synthetic ControlBot only. The ephemeral signing key remains inside this
 * closure; no network, fixed credential, private material or persistent state.
 */
export function createControlBotHealthSimulator(identityInput: unknown): Readonly<{
  publicKey: KeyObject;
  issue: (input: unknown) => SignedControlBotHealth;
}> {
  const identity = asRecord(identityInput, 'SimulatorIdentity');
  exactKeys(identity, ['instance_id', 'release_version', 'release_sha'], 'SimulatorIdentity');
  const instanceId = uuid(identity.instance_id, 'simulator.instance_id');
  const version = semver(identity.release_version, 'simulator.release_version');
  const releaseSha = sha(identity.release_sha);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  return Object.freeze({
    publicKey,
    issue(input: unknown): SignedControlBotHealth {
      const request = asRecord(input, 'SimulatorRequest');
      exactKeys(request, ['observed_at', 'nonce', 'status'], 'SimulatorRequest');
      const payload = payloadFrom({
        version: 1,
        service: 'controlbot',
        instance_id: instanceId,
        release_version: version,
        release_sha: releaseSha,
        observed_at: request.observed_at,
        nonce: request.nonce,
        status: request.status,
      });
      return Object.freeze({
        payload: Object.freeze(payload),
        signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64url'),
      });
    },
  });
}

/** Generate a synthetic one-time challenge; the caller still owns replay control. */
export function newHealthChallenge(): string {
  return randomUUID();
}
