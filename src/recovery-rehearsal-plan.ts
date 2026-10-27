/** Offline-only synthetic backup/restore/rollback rehearsal checklist. No side effects. */
import { createHash } from 'node:crypto';

export const RECOVERY_REHEARSAL_STEPS = Object.freeze([
  { id: 'backup-preflight', owner: 'sre', expected_evidence: 'fixture:rehearsal/backup-preflight' },
  { id: 'backup-capture', owner: 'sre', expected_evidence: 'fixture:rehearsal/backup-capture' },
  { id: 'backup-verify', owner: 'qa', expected_evidence: 'fixture:rehearsal/backup-verify' },
  { id: 'restore-isolated', owner: 'sre', expected_evidence: 'fixture:rehearsal/restore-isolated' },
  { id: 'restore-verify', owner: 'qa', expected_evidence: 'fixture:rehearsal/restore-verify' },
  { id: 'rollback-isolated', owner: 'sre', expected_evidence: 'fixture:rehearsal/rollback-isolated' },
  { id: 'rollback-verify', owner: 'qa', expected_evidence: 'fixture:rehearsal/rollback-verify' },
  { id: 'evidence-review', owner: 'security', expected_evidence: 'fixture:rehearsal/evidence-review' },
] as const);

export type RecoveryRehearsalStepId = (typeof RECOVERY_REHEARSAL_STEPS)[number]['id'];
export type RecoveryRehearsalRole = (typeof RECOVERY_REHEARSAL_STEPS)[number]['owner'];
export type RecoveryRehearsalStep = Readonly<{
  id: RecoveryRehearsalStepId;
  owner: RecoveryRehearsalRole;
  target_minutes: number;
  expected_evidence: string;
}>;
export type RecoveryRehearsalPlan = Readonly<{
  version: 1;
  kind: 'synthetic_recovery_rehearsal_plan';
  status: 'PLAN_COMPLETE_OFFLINE' | 'UNKNOWN';
  execution_readiness: 'UNKNOWN';
  live_authorized: false;
  backup_executed: false;
  restore_executed: false;
  rollback_executed: false;
  network_access: false;
  external_mutation: false;
  missing_steps: readonly RecoveryRehearsalStepId[];
  invalid_steps: readonly RecoveryRehearsalStepId[];
  total_target_minutes: number | null;
  steps: readonly RecoveryRehearsalStep[];
  fingerprint: string;
}>;

function safeRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(label + ': invalid_record');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + ': invalid_prototype');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (actual.length !== keys.length
      || actual.some((key) => typeof key !== 'string' || !keys.includes(key))
      || keys.some((key) => !Object.hasOwn(descriptors, key))
      || Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) {
    throw new TypeError(label + ': invalid_fields');
  }
  return value as Record<string, unknown>;
}

/** Only planned synthetic evidence IDs, never evidence of actual recovery. */
export function validateRecoveryRehearsalPlan(input: unknown): RecoveryRehearsalPlan {
  const root = safeRecord(input, ['version', 'steps'], 'rehearsal');
  if (root.version !== 1 || !Array.isArray(root.steps)
      || root.steps.length > RECOVERY_REHEARSAL_STEPS.length) {
    throw new TypeError('rehearsal: invalid_input');
  }
  const parsed = (root.steps as unknown[]).map((row) => {
    const step = safeRecord(row, ['id', 'owner', 'target_minutes', 'expected_evidence'], 'rehearsal_step');
    if (typeof step.id !== 'string'
        || !RECOVERY_REHEARSAL_STEPS.some((item) => item.id === step.id)) {
      throw new TypeError('rehearsal_step: unknown_step');
    }
    const definition = RECOVERY_REHEARSAL_STEPS.find((item) => item.id === step.id)!;
    const valid = step.owner === definition.owner
      && step.expected_evidence === definition.expected_evidence
      && typeof step.target_minutes === 'number'
      && Number.isSafeInteger(step.target_minutes)
      && step.target_minutes >= 1 && step.target_minutes <= 240;
    return { id: definition.id, valid, target_minutes: valid ? step.target_minutes as number : 0 };
  });
  const counts = new Map<RecoveryRehearsalStepId, number>();
  for (const step of parsed) counts.set(step.id, (counts.get(step.id) ?? 0) + 1);
  const missingSteps = Object.freeze(RECOVERY_REHEARSAL_STEPS
    .filter((step) => !counts.has(step.id)).map((step) => step.id));
  const invalidSteps = Object.freeze(RECOVERY_REHEARSAL_STEPS
    .filter((step) => counts.has(step.id)
      && (counts.get(step.id) !== 1 || parsed.find((entry) => entry.id === step.id)?.valid !== true))
    .map((step) => step.id));
  const canonicalOrder = parsed.every((step, index) => step.id === RECOVERY_REHEARSAL_STEPS[index]?.id);
  const complete = missingSteps.length === 0 && invalidSteps.length === 0 && canonicalOrder;
  const steps: readonly RecoveryRehearsalStep[] = complete
    ? Object.freeze(parsed.map((entry, index) => Object.freeze({
      id: entry.id,
      owner: RECOVERY_REHEARSAL_STEPS[index]!.owner,
      target_minutes: entry.target_minutes,
      expected_evidence: RECOVERY_REHEARSAL_STEPS[index]!.expected_evidence,
    })))
    : Object.freeze([]);
  const totalTargetMinutes = complete
    ? parsed.reduce((sum, step) => sum + step.target_minutes, 0) : null;
  const core = Object.freeze({
    version: 1 as const,
    kind: 'synthetic_recovery_rehearsal_plan' as const,
    status: complete ? 'PLAN_COMPLETE_OFFLINE' as const : 'UNKNOWN' as const,
    execution_readiness: 'UNKNOWN' as const,
    live_authorized: false as const,
    backup_executed: false as const,
    restore_executed: false as const,
    rollback_executed: false as const,
    network_access: false as const,
    external_mutation: false as const,
    missing_steps: missingSteps,
    invalid_steps: invalidSteps,
    total_target_minutes: totalTargetMinutes,
    steps,
  });
  const fingerprint = createHash('sha256').update(JSON.stringify(core)).digest('hex');
  return Object.freeze({ ...core, fingerprint });
}
