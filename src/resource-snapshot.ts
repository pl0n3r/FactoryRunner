import { capacitySnapshot, type CapacitySnapshot } from './result.ts';
import { integer } from './validation.ts';

export type ResourceSnapshot = CapacitySnapshot & {
  readonly freshness: 'fresh';
  readonly age_seconds: number;
  readonly stale_after_seconds: number;
};

export function resourceSnapshot(
  identityInput: unknown,
  heartbeatInput: unknown,
  queueInput: unknown,
  nowInput: unknown,
  staleAfterSecondsInput: unknown,
): ResourceSnapshot {
  const now = integer(nowInput, 'now');
  const staleAfterSeconds = integer(
    staleAfterSecondsInput,
    'stale_after_seconds',
    1,
    86_400,
  );
  const observed = capacitySnapshot(
    identityInput,
    heartbeatInput,
    queueInput,
    now,
  );
  const ageSeconds = now - observed.observed_at;

  if (ageSeconds > staleAfterSeconds) {
    throw new TypeError('ResourceSnapshot stale.');
  }

  return Object.freeze({
    ...observed,
    freshness: 'fresh',
    age_seconds: ageSeconds,
    stale_after_seconds: staleAfterSeconds,
  });
}
