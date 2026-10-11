import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCompatibilityEvidence, HTTP_V1_ROUTES } from '../scripts/check-controlbot-compat-evidence.ts';

const AT = '2026-10-11T09:00:00.000Z';
const script = resolve(fileURLToPath(new URL('../scripts/check-controlbot-compat-evidence.ts', import.meta.url)));
function fixture() {
  return {
    schema_version: 1,
    factoryrunner: {
      repository: 'pl0n3r/FactoryRunner', version: '0.1.0',
      sha: '170c563dabd56936c476a5c89e07e44a98ca746d',
      protocol_version: 1, routes: [...HTTP_V1_ROUTES], observed_at: AT,
    },
    controlbot: {
      repository: 'pl0n3r/ControlBot', version: '1.0.0',
      sha: '3039ce281d6e359c6f85673e9f20a107238b9131',
      protocol_version: 1, routes: [...HTTP_V1_ROUTES], observed_at: AT,
    },
  };
}

test('versions and exact SHA of both source repositories are reported separately', () => {
  const evidence = fixture();
  const output = evaluateCompatibilityEvidence(evidence, AT);
  assert.equal(output.status, 'COMPATIBLE');
  assert.equal(output.go_no_go, 'NO_GO');
  assert.deepEqual(output.sources, {
    factoryrunner: { repository: evidence.factoryrunner.repository, version: '0.1.0',
      sha: evidence.factoryrunner.sha, protocol_version: 1, freshness: 'FRESH', observed_at: AT },
    controlbot: { repository: evidence.controlbot.repository, version: '1.0.0',
      sha: evidence.controlbot.sha, protocol_version: 1, freshness: 'FRESH', observed_at: AT },
  });
  assert.equal(output.deployment, 'UNKNOWN');
  assert.equal(output.production, 'UNKNOWN');
  assert.deepEqual(output.options, [
    { decision: 'PUBLICAR', allowed: false, reason: 'HUMAN_LIVE_GATE_REQUIRED' },
    { decision: 'NO_PUBLICAR', allowed: true, reason: 'SAFE_DEFAULT' },
  ]);
  const missing = fixture();
  missing.controlbot.version = 'UNKNOWN';
  missing.controlbot.observed_at = null as never;
  const unknown = evaluateCompatibilityEvidence(missing, AT);
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.go_no_go, 'NO_GO');
  assert.equal((unknown.sources as {controlbot:{freshness:string}}).controlbot.freshness, 'UNKNOWN');
});

test('a route mismatch is detailed and produces NO_GO', () => {
  const evidence = fixture();
  evidence.controlbot.routes = ['POST /v1/runner/poll'];
  const report = evaluateCompatibilityEvidence(evidence, AT);
  assert.equal(report.status, 'INCOMPATIBLE');
  assert.equal(report.go_no_go, 'NO_GO');
  assert.ok((report.differences as string[]).includes('CONTROLBOT_MISSING:POST /v1/runner/ack'));
  const invalid = fixture();
  invalid.controlbot.routes.push('POST /v1/runner/poll');
  assert.throws(() => evaluateCompatibilityEvidence(invalid, AT), TypeError);
  const late = fixture();
  late.factoryrunner.observed_at = '2026-10-01T09:00:00.000Z';
  assert.equal(evaluateCompatibilityEvidence(late, AT).status, 'UNKNOWN');
});

test('fixture evaluation is offline, redacted, and never writes or uses credentials', () => {
  const originalFetch = globalThis.fetch;
  let attempted = 0;
  globalThis.fetch = (async () => { attempted += 1; throw new Error('network prohibited'); }) as typeof fetch;
  try {
    const output = evaluateCompatibilityEvidence(fixture(), AT);
    assert.equal(output.network_access, false);
    assert.equal(output.external_mutation, false);
    assert.equal(attempted, 0);
    const bad = { ...fixture(), authorization: 'Bearer synthetic-secret-do-not-echo' };
    assert.throws(() => evaluateCompatibilityEvidence(bad, AT), TypeError);
    const result = spawnSync(process.execPath,
      ['--experimental-strip-types', script, '--stdin'],
      { input: JSON.stringify(bad), encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH } });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /synthetic-secret|Bearer|authorization/i);
    const valid = spawnSync(process.execPath,
      ['--experimental-strip-types', script, '--stdin'],
      { input: JSON.stringify(fixture()), encoding: 'utf8', timeout: 5000,
        env: { PATH: process.env.PATH } });
    assert.equal(valid.status, 0, valid.stderr);
    const offline = JSON.parse(valid.stdout);
    assert.equal(offline.go_no_go, 'NO_GO');
    assert.equal(offline.network_access, false);
    assert.equal(offline.external_mutation, false);
  } finally { globalThis.fetch = originalFetch; }
});
