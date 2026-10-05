import { asRecord, exactKeys, ref, stableSha256 } from './validation.ts';

const SHA256_RE = /^[0-9a-f]{64}$/;

type CanonicalPacket = Readonly<{
  execution_id: string;
  readiness_fingerprint: string;
  snapshot_fingerprint: string;
  plan_fingerprint: string;
  fingerprint: string;
}>;

type CanonicalVerification = Readonly<{
  execution_id: string;
  handoff_fingerprint: string;
  readiness_fingerprint: string;
  snapshot_fingerprint: string;
  plan_fingerprint: string;
  fingerprint: string;
}>;

type CanonicalPreview = Readonly<{
  execution_id: string;
  handoff_fingerprint: string;
  readiness_fingerprint: string;
  snapshot_fingerprint: string;
  plan_fingerprint: string;
  fingerprint: string;
}>;

export type ExecutionRecoveryHandoffManifest = Readonly<{
  version: 1;
  authority: 'unchanged';
  execution_id: string;
  packet_fingerprint: string;
  verification_fingerprint: string;
  preview_fingerprint: string;
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

function sha256(input: unknown, label: string): string {
  const value = ref(input, label, 64).toLowerCase();
  if (!SHA256_RE.test(value)) throw new TypeError(`${label} inválido.`);
  return value;
}

function parsePacket(input: unknown): CanonicalPacket {
  const record = asRecord(input, 'ExecutionRecoveryHandoffPacket');
  exactKeys(record, [
    'version',
    'authority',
    'execution_id',
    'readiness_fingerprint',
    'snapshot_fingerprint',
    'plan_fingerprint',
    'execution',
    'network_access',
    'external_mutation',
    'fingerprint',
  ], 'ExecutionRecoveryHandoffPacket');
  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('ExecutionRecoveryHandoffPacket cambia schema, authority o effects.');
  }
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    execution_id: ref(record.execution_id, 'packet.execution_id', 160),
    readiness_fingerprint: sha256(record.readiness_fingerprint, 'packet.readiness_fingerprint'),
    snapshot_fingerprint: sha256(record.snapshot_fingerprint, 'packet.snapshot_fingerprint'),
    plan_fingerprint: sha256(record.plan_fingerprint, 'packet.plan_fingerprint'),
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  const fingerprint = sha256(record.fingerprint, 'packet.fingerprint');
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionRecoveryHandoffPacket fingerprint inválido.');
  }
  return Object.freeze({
    execution_id: core.execution_id,
    readiness_fingerprint: core.readiness_fingerprint,
    snapshot_fingerprint: core.snapshot_fingerprint,
    plan_fingerprint: core.plan_fingerprint,
    fingerprint,
  });
}

function parseVerification(input: unknown): CanonicalVerification {
  const record = asRecord(input, 'ExecutionRecoveryHandoffVerification');
  exactKeys(record, [
    'version',
    'authority',
    'verified',
    'execution_id',
    'handoff_fingerprint',
    'readiness_fingerprint',
    'snapshot_fingerprint',
    'plan_fingerprint',
    'execution',
    'network_access',
    'external_mutation',
    'fingerprint',
  ], 'ExecutionRecoveryHandoffVerification');
  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.verified !== true
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('ExecutionRecoveryHandoffVerification no está verificada o cambia authority.');
  }
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    verified: true as const,
    execution_id: ref(record.execution_id, 'verification.execution_id', 160),
    handoff_fingerprint: sha256(record.handoff_fingerprint, 'verification.handoff_fingerprint'),
    readiness_fingerprint: sha256(record.readiness_fingerprint, 'verification.readiness_fingerprint'),
    snapshot_fingerprint: sha256(record.snapshot_fingerprint, 'verification.snapshot_fingerprint'),
    plan_fingerprint: sha256(record.plan_fingerprint, 'verification.plan_fingerprint'),
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  const fingerprint = sha256(record.fingerprint, 'verification.fingerprint');
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionRecoveryHandoffVerification fingerprint inválido.');
  }
  return Object.freeze({
    execution_id: core.execution_id,
    handoff_fingerprint: core.handoff_fingerprint,
    readiness_fingerprint: core.readiness_fingerprint,
    snapshot_fingerprint: core.snapshot_fingerprint,
    plan_fingerprint: core.plan_fingerprint,
    fingerprint,
  });
}

function parsePreview(input: unknown): CanonicalPreview {
  const record = asRecord(input, 'ExecutionRecoveryHandoffPreview');
  exactKeys(record, [
    'version',
    'authority',
    'status',
    'verified',
    'execution_id',
    'handoff_fingerprint',
    'readiness_fingerprint',
    'snapshot_fingerprint',
    'plan_fingerprint',
    'execution',
    'network_access',
    'external_mutation',
    'fingerprint',
  ], 'ExecutionRecoveryHandoffPreview');
  if (
    record.version !== 1
    || record.authority !== 'unchanged'
    || record.status !== 'READY'
    || record.verified !== true
    || record.execution !== false
    || record.network_access !== false
    || record.external_mutation !== false
  ) {
    throw new TypeError('ExecutionRecoveryHandoffPreview no está READY o cambia authority.');
  }
  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    status: 'READY' as const,
    verified: true as const,
    execution_id: ref(record.execution_id, 'preview.execution_id', 160),
    handoff_fingerprint: sha256(record.handoff_fingerprint, 'preview.handoff_fingerprint'),
    readiness_fingerprint: sha256(record.readiness_fingerprint, 'preview.readiness_fingerprint'),
    snapshot_fingerprint: sha256(record.snapshot_fingerprint, 'preview.snapshot_fingerprint'),
    plan_fingerprint: sha256(record.plan_fingerprint, 'preview.plan_fingerprint'),
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });
  const fingerprint = sha256(record.fingerprint, 'preview.fingerprint');
  if (stableSha256(core) !== fingerprint) {
    throw new TypeError('ExecutionRecoveryHandoffPreview fingerprint inválido.');
  }
  return Object.freeze({
    execution_id: core.execution_id,
    handoff_fingerprint: core.handoff_fingerprint,
    readiness_fingerprint: core.readiness_fingerprint,
    snapshot_fingerprint: core.snapshot_fingerprint,
    plan_fingerprint: core.plan_fingerprint,
    fingerprint,
  });
}

export function executionRecoveryHandoffManifest(
  packetInput: unknown,
  verificationInput: unknown,
  previewInput: unknown,
): ExecutionRecoveryHandoffManifest {
  const packet = parsePacket(packetInput);
  const verification = parseVerification(verificationInput);
  const preview = parsePreview(previewInput);

  const sameIdentity = (
    packet.execution_id === verification.execution_id
    && packet.execution_id === preview.execution_id
    && packet.fingerprint === verification.handoff_fingerprint
    && packet.fingerprint === preview.handoff_fingerprint
    && packet.readiness_fingerprint === verification.readiness_fingerprint
    && packet.readiness_fingerprint === preview.readiness_fingerprint
    && packet.snapshot_fingerprint === verification.snapshot_fingerprint
    && packet.snapshot_fingerprint === preview.snapshot_fingerprint
    && packet.plan_fingerprint === verification.plan_fingerprint
    && packet.plan_fingerprint === preview.plan_fingerprint
  );
  if (!sameIdentity) {
    throw new TypeError('Recovery handoff manifest mezcla evidencia no equivalente.');
  }

  const core = Object.freeze({
    version: 1 as const,
    authority: 'unchanged' as const,
    execution_id: packet.execution_id,
    packet_fingerprint: packet.fingerprint,
    verification_fingerprint: verification.fingerprint,
    preview_fingerprint: preview.fingerprint,
    execution: false as const,
    network_access: false as const,
    external_mutation: false as const,
  });

  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
