/** Read-only ControlBot ↔ FactoryRunner evidence comparison; never contacts either service. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

export const HTTP_V1_ROUTES = Object.freeze([
  'POST /v1/runner/ack',
  'POST /v1/runner/event',
  'POST /v1/runner/heartbeat',
  'POST /v1/runner/poll',
]);

type Repo = 'pl0n3r/FactoryRunner' | 'pl0n3r/ControlBot';
type Side = Readonly<{
  repository: Repo;
  version: string;
  sha: string;
  protocol_version: number;
  routes: readonly string[];
  observed_at: string | null;
}>;
type Input = Readonly<{
  schema_version: 1;
  factoryrunner: Side;
  controlbot: Side;
}>;

const HEX_SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DATE_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type MapInput = Record<string, unknown>;
function record(input: unknown, fields: readonly string[]): MapInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TypeError('Estructura de evidencia inválida.');
  }
  const value = input as MapInput;
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new TypeError('Campos de evidencia inválidos.');
  }
  return value;
}
function timestamp(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string' || !DATE_UTC.test(raw)) throw new TypeError('Fecha inválida.');
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new TypeError('Fecha inválida.');
  }
  return raw;
}
function side(input: unknown, repository: Repo): Side {
  const obj = record(input, [
    'repository', 'version', 'sha', 'protocol_version', 'routes', 'observed_at',
  ]);
  if (obj.repository !== repository || typeof obj.version !== 'string'
      || (obj.version !== 'UNKNOWN' && !SEMVER.test(obj.version))
      || typeof obj.sha !== 'string' || !HEX_SHA.test(obj.sha)
      || obj.protocol_version !== 1
      || !Array.isArray(obj.routes) || obj.routes.length > 8
      || obj.routes.some((route: unknown) => typeof route !== 'string'
          || !/^POST \/v1\/runner\/[a-z]+$/.test(route))
      || new Set(obj.routes).size !== obj.routes.length) {
    throw new TypeError('Identidad o contrato de fuente inválido.');
  }
  return Object.freeze({
    repository,
    version: obj.version,
    sha: obj.sha,
    protocol_version: 1,
    routes: Object.freeze([...obj.routes].sort()),
    observed_at: timestamp(obj.observed_at),
  });
}
function freshness(when: string | null, now: number): 'FRESH' | 'STALE' | 'UNKNOWN' {
  if (when === null) return 'UNKNOWN';
  const age = now - Date.parse(when);
  return age < 0 || age > MAX_AGE_MS ? 'STALE' : 'FRESH';
}
function compareRoutes(left: readonly string[], right: readonly string[]): readonly string[] {
  const differences = new Set<string>();
  for (const route of HTTP_V1_ROUTES) {
    if (!left.includes(route)) differences.add(`RUNNER_MISSING:${route}`);
    if (!right.includes(route)) differences.add(`CONTROLBOT_MISSING:${route}`);
  }
  for (const route of left) if (!HTTP_V1_ROUTES.includes(route)) differences.add(`RUNNER_UNSUPPORTED:${route}`);
  for (const route of right) if (!HTTP_V1_ROUTES.includes(route)) differences.add(`CONTROLBOT_UNSUPPORTED:${route}`);
  return Object.freeze([...differences].sort());
}

/** A compatible offline fixture is not a release or a production attestation. */
export function evaluateCompatibilityEvidence(input: unknown, nowIso: string): Readonly<Record<string, unknown>> {
  const now = timestamp(nowIso);
  if (now === null) throw new TypeError('Se requiere hora de evaluación.');
  const payload = record(input, ['schema_version', 'factoryrunner', 'controlbot']);
  if (payload.schema_version !== 1) throw new TypeError('Versión de reporte inválida.');
  const runner = side(payload.factoryrunner, 'pl0n3r/FactoryRunner');
  const bot = side(payload.controlbot, 'pl0n3r/ControlBot');
  const differences = compareRoutes(runner.routes, bot.routes);
  const runnerFreshness = freshness(runner.observed_at, Date.parse(now));
  const botFreshness = freshness(bot.observed_at, Date.parse(now));
  const reasons = [...(differences.length ? ['HTTP_CONTRACT_MISMATCH'] : []),
    ...(runner.version === 'UNKNOWN' ? ['RUNNER_VERSION_UNKNOWN'] : []),
    ...(bot.version === 'UNKNOWN' ? ['CONTROLBOT_VERSION_UNKNOWN'] : []),
    ...(runnerFreshness !== 'FRESH' ? ['RUNNER_EVIDENCE_NOT_FRESH'] : []),
    ...(botFreshness !== 'FRESH' ? ['CONTROLBOT_EVIDENCE_NOT_FRESH'] : []),
    'LIVE_ATTESTATION_NOT_PROVIDED'];
  const status = differences.length > 0 ? 'INCOMPATIBLE'
    : reasons.length > 1 ? 'UNKNOWN' : 'COMPATIBLE';
  return Object.freeze({
    schema_version: 1,
    status,
    go_no_go: 'NO_GO',
    reason_codes: Object.freeze(reasons),
    differences,
    sources: Object.freeze({
      factoryrunner: Object.freeze({ repository: runner.repository, version: runner.version,
        sha: runner.sha, protocol_version: runner.protocol_version,
        freshness: runnerFreshness, observed_at: runner.observed_at }),
      controlbot: Object.freeze({ repository: bot.repository, version: bot.version,
        sha: bot.sha, protocol_version: bot.protocol_version,
        freshness: botFreshness, observed_at: bot.observed_at }),
    }),
    deployment: 'UNKNOWN',
    production: 'UNKNOWN',
    options: Object.freeze([
      Object.freeze({ decision: 'PUBLICAR', allowed: false, reason: 'HUMAN_LIVE_GATE_REQUIRED' }),
      Object.freeze({ decision: 'NO_PUBLICAR', allowed: true, reason: 'SAFE_DEFAULT' }),
    ]),
    evaluated_at: now,
    authority: 'diagnostic_only',
    network_access: false,
    external_mutation: false,
  });
}

async function main(): Promise<void> {
  if (process.argv.length !== 4 || process.argv[2] !== '--input') {
    throw new TypeError('Uso: --input <fixture.json>');
  }
  const source = await readFile(process.argv[3], { encoding: 'utf8' });
  if (Buffer.byteLength(source) > 32_768) throw new TypeError('Fixture fuera de límites.');
  const input = JSON.parse(source) as unknown;
  const report = evaluateCompatibilityEvidence(input, new Date().toISOString());
  process.stdout.write(JSON.stringify(report) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    // Never print untrusted fields, fixture paths or confidential values.
    process.stderr.write('Evidencia inválida o ilegible.\n');
    process.exitCode = 2;
  });
}
