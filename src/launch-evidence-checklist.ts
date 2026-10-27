/**
 * Synthetic/offline inventory only. Nothing here authenticates a source,
 * connects to a service, verifies production or grants a launch decision.
 */
import { createHash } from 'node:crypto';

export const LAUNCH_EVIDENCE_GATES = Object.freeze([
  'accessibility',
  'performance_p95',
  'security_permissions',
  'security_sast',
  'security_dependencies',
  'smoke_exact_sha_health',
  'rollback_kill_switch',
  'support_runbook',
] as const);

export const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type Gate = (typeof LAUNCH_EVIDENCE_GATES)[number];
type Status = 'PASS' | 'FAIL' | 'UNKNOWN';
type Row = Readonly<{
  gate: Gate;
  source: string;
  source_sha: string;
  observed_at: string;
  status: Status;
}>;

export type LaunchEvidenceChecklist = Readonly<{
  version: 1;
  mode: 'offline_inventory';
  source_sha: string;
  as_of: string;
  complete_offline: boolean;
  readiness: 'UNKNOWN';
  live_authorized: false;
  go_no_go: 'NO_GO';
  missing_gates: readonly Gate[];
  stale_gates: readonly Gate[];
  nonpassing_gates: readonly Gate[];
  fingerprint: string;
}>;

const SHA = /^[0-9a-f]{40}$/;
const SOURCE = /^(?:artifact|evidence|repo):\/\/[a-z0-9][a-z0-9._/#-]{2,179}$/;
const GATES: ReadonlySet<string> = new Set(LAUNCH_EVIDENCE_GATES);
const STATES: ReadonlySet<string> = new Set(['PASS', 'FAIL', 'UNKNOWN']);

/** Exact own data fields, with no inherited, hidden, symbol or accessor fields. */
function strictRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('launch_evidence_invalid_record');
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('launch_evidence_invalid_prototype');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const actual = Reflect.ownKeys(input);
  if (actual.length !== keys.length || actual.some((key) => typeof key !== 'string' || !keys.includes(key))
      || keys.some((key) => !Object.hasOwn(descriptors, key))) {
    throw new TypeError('launch_evidence_invalid_keys');
  }
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value')
      || descriptor.enumerable !== true)) {
    throw new TypeError('launch_evidence_accessors_disallowed');
  }
  return input as Record<string, unknown>;
}

function timestamp(input: unknown): number {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) {
    throw new TypeError('launch_evidence_invalid_date');
  }
  const date = Date.parse(input);
  if (!Number.isFinite(date) || new Date(date).toISOString() !== input) {
    throw new TypeError('launch_evidence_invalid_date');
  }
  return date;
}

/**
 * Pure inventory validation for caller-provided, untrusted offline artifacts.
 * The 7-day freshness window is only an offline policy; PASS never proves
 * authenticity, operating readiness or authorization to go live.
 */
export function evaluateLaunchEvidenceChecklist(input: unknown, asOf: string): LaunchEvidenceChecklist {
  const at = timestamp(asOf);
  const root = strictRecord(input, ['version', 'source_sha', 'proofs']);
  if (root.version !== 1 || typeof root.source_sha !== 'string' || !SHA.test(root.source_sha)
      || !Array.isArray(root.proofs) || root.proofs.length > LAUNCH_EVIDENCE_GATES.length) {
    throw new TypeError('launch_evidence_invalid_input');
  }
  const proofs = root.proofs as unknown[];
  // Reject array holes, indexed getters and non-index properties.
  const indices = Object.getOwnPropertyDescriptors(proofs);
  if (Reflect.ownKeys(indices).length !== proofs.length + 1 || !Object.hasOwn(indices, 'length')) {
    throw new TypeError('launch_evidence_invalid_proofs');
  }
  for (let index = 0; index < proofs.length; index += 1) {
    const descriptor = indices[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw new TypeError('launch_evidence_invalid_proofs');
    }
  }
  const sourceSha = root.source_sha;
  const found = new Map<Gate, Row>();
  for (const item of proofs) {
    const record = strictRecord(item, ['gate', 'source', 'source_sha', 'observed_at', 'status']);
    if (typeof record.gate !== 'string' || !GATES.has(record.gate)
        || found.has(record.gate as Gate) || typeof record.source !== 'string'
        || !SOURCE.test(record.source) || record.source_sha !== sourceSha
        || typeof record.status !== 'string' || !STATES.has(record.status)) {
      throw new TypeError('launch_evidence_invalid_proof');
    }
    timestamp(record.observed_at);
    found.set(record.gate as Gate, record as unknown as Row);
  }
  const missingGates = Object.freeze(LAUNCH_EVIDENCE_GATES.filter((gate) => !found.has(gate)));
  const staleGates = Object.freeze(LAUNCH_EVIDENCE_GATES.filter((gate) => {
    const row = found.get(gate);
    if (!row) return false;
    const age = at - timestamp(row.observed_at);
    return age < 0 || age > MAX_EVIDENCE_AGE_MS;
  }));
  const nonpassingGates = Object.freeze(LAUNCH_EVIDENCE_GATES.filter(
    (gate) => found.has(gate) && found.get(gate)?.status !== 'PASS',
  ));
  const report = {
    version: 1 as const,
    mode: 'offline_inventory' as const,
    source_sha: sourceSha,
    as_of: asOf,
    complete_offline: missingGates.length === 0 && staleGates.length === 0 && nonpassingGates.length === 0,
    readiness: 'UNKNOWN' as const,
    live_authorized: false as const,
    go_no_go: 'NO_GO' as const,
    missing_gates: missingGates,
    stale_gates: staleGates,
    nonpassing_gates: nonpassingGates,
  };
  const orderedProofs = LAUNCH_EVIDENCE_GATES.map((gate) => found.get(gate) ?? null);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ ...report, proofs: orderedProofs })).digest('hex');
  return Object.freeze({ ...report, fingerprint });
}
