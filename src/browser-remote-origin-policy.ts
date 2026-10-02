import { stringValue } from './validation.ts';

export type BrowserRemoteOriginPolicy = readonly string[];

function canonicalOrigin(value: unknown): string {
  const raw = stringValue(value, 'allowed origin', 240);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('Allowed origin inválido.');
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || parsed.pathname !== '/'
  ) {
    throw new TypeError('Allowed origin inválido.');
  }

  return parsed.origin;
}

export function browserRemoteOriginPolicy(
  input: unknown,
): BrowserRemoteOriginPolicy {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) {
    throw new TypeError('Allowlist de origins inválida.');
  }

  const origins = input.map((origin) => canonicalOrigin(origin));
  if (new Set(origins).size !== origins.length) {
    throw new TypeError('Allowlist de origins duplicada.');
  }

  return Object.freeze([...origins]);
}
