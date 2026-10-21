/**
 * Offline-only, caller-supplied evidence inventory for the human A preflight.
 * No collector, network client, filesystem, credential handling, runtime or go-live grant.
 */
import { createHash } from 'node:crypto';

export const OFFLINE_GATES = Object.freeze([
  'branch_protection',
  'ci_exact_main',
  'codeql_exact_main',
  'controlbot_mock',
  'rollback_fake',
  'observer_synthetic',
] as const);

type Gate = (typeof OFFLINE_GATES)[number];
type Status = 'PASS' | 'FAIL' | 'UNKNOWN';
type Evidence = Readonly<{ gate: Gate; source_sha: string; status: Status }>;

type PreflightReport = Readonly<{
  version: 1;
  mode: 'offline_preflight';
  source_sha: string;
  prepared_offline: boolean;
  readiness: 'UNKNOWN';
  live_authorized: false;
  missing_gates: readonly Gate[];
  nonpassing_gates: readonly Gate[];
  fingerprint: string;
}>;

const SHA = /^[a-f0-9]{40}$/;
const GATES: ReadonlySet<string> = new Set(OFFLINE_GATES);
const STATES: ReadonlySet<string> = new Set(['PASS', 'FAIL', 'UNKNOWN']);

function safeRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('offline_preflight_invalid_record');
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('offline_preflight_invalid_prototype');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const actual = Object.keys(descriptors);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))
      || keys.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new TypeError('offline_preflight_invalid_keys');
  }
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true)) {
    throw new TypeError('offline_preflight_accessors_disallowed');
  }
  return input as Record<string, unknown>;
}

/**
 * The report is about completeness of untrusted offline inputs, NOT about their
 * authenticity. Even a full PASS matrix cannot grant live authority/readiness.
 */
export function evaluateOfflinePreflight(input: unknown): PreflightReport {
  const root = safeRecord(input, ['version', 'source_sha', 'proofs']);
  if (root.version !== 1 || typeof root.source_sha !== 'string' || !SHA.test(root.source_sha)
      || !Array.isArray(root.proofs) || root.proofs.length > OFFLINE_GATES.length) {
    throw new TypeError('offline_preflight_invalid_input');
  }
  const sourceSha = root.source_sha;
  const found = new Map<Gate, Status>();
  for (const item of root.proofs as unknown[]) {
    const row = safeRecord(item, ['gate', 'source_sha', 'status']);
    if (typeof row.gate !== 'string' || !GATES.has(row.gate)
        || typeof row.status !== 'string' || !STATES.has(row.status)
        || row.source_sha !== sourceSha || found.has(row.gate as Gate)) {
      throw new TypeError('offline_preflight_invalid_proof');
    }
    found.set(row.gate as Gate, row.status as Status);
  }
  const missingGates = Object.freeze(OFFLINE_GATES.filter((gate) => !found.has(gate)));
  const nonpassingGates = Object.freeze(OFFLINE_GATES.filter(
    (gate) => found.has(gate) && found.get(gate) !== 'PASS',
  ));
  const base = {
    version: 1 as const,
    mode: 'offline_preflight' as const,
    source_sha: sourceSha,
    prepared_offline: missingGates.length === 0 && nonpassingGates.length === 0,
    readiness: 'UNKNOWN' as const,
    live_authorized: false as const,
    missing_gates: missingGates,
    nonpassing_gates: nonpassingGates,
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(base)).digest('hex');
  return Object.freeze({ ...base, fingerprint });
}
