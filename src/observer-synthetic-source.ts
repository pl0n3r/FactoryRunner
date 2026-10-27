/**
 * FactoryRunner #616. Pure, read-only bridge for explicitly synthetic fixtures.
 * This adapter never reads runtime state or grants execution authority.
 */
import { projectSyntheticObserverFromExports } from './local-observer-source-adapter.ts';
import { projectLocalObserverSnapshot, type LocalObserverViewV1 } from './local-observer-snapshot.ts';

const SOURCE_KEYS = ['version', 'kind', 'snapshot', 'heartbeat'] as const;

function unknown(): LocalObserverViewV1 {
  return projectLocalObserverSnapshot(null);
}

/**
 * Require explicit synthetic provenance. Unexpected keys, getters, proxies,
 * missing evidence or mismatched observations produce the constant UNKNOWN
 * view, without copying untrusted strings into the returned structure.
 */
export function observeSyntheticRunnerSource(sourceInput: unknown, nowInput: unknown): LocalObserverViewV1 {
  try {
    if (sourceInput === null || typeof sourceInput !== 'object' || Array.isArray(sourceInput)) {
      return unknown();
    }
    const prototype: unknown = Object.getPrototypeOf(sourceInput);
    if (prototype !== Object.prototype && prototype !== null) return unknown();
    const keys = Reflect.ownKeys(sourceInput);
    if (keys.length !== SOURCE_KEYS.length || keys.some(key =>
      typeof key !== 'string' || !SOURCE_KEYS.includes(key as typeof SOURCE_KEYS[number]))) {
      return unknown();
    }
    const entries = SOURCE_KEYS.map(key => Object.getOwnPropertyDescriptor(sourceInput, key));
    if (entries.some(entry => !entry?.enumerable || !('value' in entry))) return unknown();
    if (entries[0]?.value !== 1 || entries[1]?.value !== 'synthetic') return unknown();
    return projectSyntheticObserverFromExports(entries[2]?.value, entries[3]?.value, nowInput);
  } catch {
    return unknown();
  }
}
