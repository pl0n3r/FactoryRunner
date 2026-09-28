import { createHash } from 'node:crypto';

export type JsonRecord = Record<string, unknown>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z][a-z0-9.-]{0,63}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,255}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SECRET_TEXT_PATTERNS = [
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /\bbearer\s+[\w.~+/-]{8,}/i,
  /\b(?:password|passwd|token|secret|cookie|authorization|private[_ -]?key|api[_ -]?key|dsn)\s*[:=]\s*\S+/i,
  /\b(?:ghp_|gho_|github_pat_)\w{20,}/i,
  /\b(?:sk|rk|pk)-[\w-]{12,}/i,
] as const;

export function asRecord(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} debe ser un objeto.`);
  }
  return value as JsonRecord;
}

export function exactKeys(record: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort((a, b) => a.localeCompare(b, 'en'));
  const wanted = [...expected].sort((a, b) => a.localeCompare(b, 'en'));
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} contiene campos inválidos.`);
  }
}

export function stringValue(value: unknown, label: string, max = 255): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} inválido.`);
  }
  return value;
}

export function uuid(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 36);
  if (!UUID_RE.test(parsed)) throw new TypeError(`${label} inválido.`);
  return parsed.toLowerCase();
}

export function slug(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 64);
  if (!SLUG_RE.test(parsed)) throw new TypeError(`${label} inválido.`);
  return parsed;
}

export function ref(value: unknown, label: string, max = 256): string {
  const parsed = stringValue(value, label, max);
  if (!REF_RE.test(parsed)) throw new TypeError(`${label} inválida.`);
  return noSensitiveText(parsed, label);
}

export function semver(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 80);
  if (!SEMVER_RE.test(parsed)) throw new TypeError(`${label} inválida.`);
  return parsed;
}

export function integer(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new TypeError(`${label} inválido.`);
  }
  return value as number;
}

export function noSensitiveText(value: string, label: string): string {
  if (SECRET_TEXT_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new TypeError(`${label} contiene material sensible.`);
  }
  return value;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b, 'en'))) {
      ordered[key] = canonicalValue(record[key]);
    }
    return ordered;
  }
  throw new TypeError('Valor no serializable para fingerprint.');
}

export function stableSha256(value: unknown): string {
  const serialized = JSON.stringify(canonicalValue(value));
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
