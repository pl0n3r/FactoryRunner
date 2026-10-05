"""Executable acceptance for offline recovery handoff manifest verifier."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "execution-recovery-handoff-manifest-verify.ts"


def run_node(source: str) -> None:
    result = subprocess.run(
        [
            "node",
            "--experimental-strip-types",
            "--input-type=module",
            "--eval",
            textwrap.dedent(source),
        ],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stdout + result.stderr)


NODE_FIXTURE = r"""
import assert from 'node:assert/strict';
import { executionRecoveryHandoffPacket } from './src/execution-recovery-handoff-packet.ts';
import { executionRecoveryHandoffVerify } from './src/execution-recovery-handoff-verify.ts';
import { executionRecoveryHandoffPreview } from './src/execution-recovery-handoff-preview.ts';
import { executionRecoveryHandoffManifest } from './src/execution-recovery-handoff-manifest.ts';
import {
  executionRecoveryHandoffManifestVerify,
} from './src/execution-recovery-handoff-manifest-verify.ts';
import { stableSha256 } from './src/validation.ts';

const executionId = 'execution:recovery:handoff:alpha';
const snapshotFingerprint = 'a'.repeat(64);
const planFingerprint = 'b'.repeat(64);

function readiness(overrides = {}) {
  const core = {
    version: 1,
    authority: 'unchanged',
    ready: true,
    reason: 'ready',
    snapshot_fingerprint: snapshotFingerprint,
    plan_fingerprint: planFingerprint,
    execution: false,
    network_access: false,
    external_mutation: false,
    counts: {
      orders: 3,
      noop: 1,
      redeliver: 1,
      resume: 1,
      block: 0,
    },
    ...overrides,
  };
  return { ...core, fingerprint: stableSha256(core) };
}

function evidence(execution = executionId) {
  const ready = readiness();
  const packet = executionRecoveryHandoffPacket(
    execution,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
  const verification = executionRecoveryHandoffVerify(
    packet,
    execution,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
  const preview = executionRecoveryHandoffPreview(
    packet,
    execution,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
  const manifest = executionRecoveryHandoffManifest(
    packet,
    verification,
    preview,
    execution,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
  return { ready, packet, verification, preview, manifest };
}

function verify(manifest, packet, verification, preview, ready = readiness()) {
  return executionRecoveryHandoffManifestVerify(
    manifest,
    packet,
    verification,
    preview,
    executionId,
    ready,
    snapshotFingerprint,
    planFingerprint,
  );
}

function refingerprint(record) {
  const { fingerprint: _discard, ...core } = record;
  return { ...core, fingerprint: stableSha256(core) };
}
"""


class FactoryRunnerExecutionRecoveryHandoffManifestVerifyTests(unittest.TestCase):
    def test_verifier_accepts_only_exact_manifest_and_bound_handoff_evidence(self) -> None:
        run_node(
            NODE_FIXTURE
            + r"""
            const { ready, packet, verification, preview, manifest } = evidence();

            const first = verify(manifest, packet, verification, preview, ready);
            const second = verify(manifest, packet, verification, preview, ready);

            assert.deepEqual(first, second);
            assert.equal(first.version, 1);
            assert.equal(first.authority, 'unchanged');
            assert.equal(first.verified, true);
            assert.equal(first.execution_id, executionId);
            assert.equal(first.manifest_fingerprint, manifest.fingerprint);
            assert.equal(first.packet_fingerprint, packet.fingerprint);
            assert.equal(first.verification_fingerprint, verification.fingerprint);
            assert.equal(first.preview_fingerprint, preview.fingerprint);
            assert.equal(first.execution, false);
            assert.equal(first.network_access, false);
            assert.equal(first.external_mutation, false);
            assert.match(first.fingerprint, /^[0-9a-f]{64}$/);

            assert.deepEqual(Object.keys(first).sort(), [
              'authority',
              'execution',
              'execution_id',
              'external_mutation',
              'fingerprint',
              'manifest_fingerprint',
              'network_access',
              'packet_fingerprint',
              'preview_fingerprint',
              'verification_fingerprint',
              'verified',
              'version',
            ]);
            """
        )

    def test_tampered_mixed_stale_or_unknown_manifest_fails_closed_without_effects(self) -> None:
        source = SOURCE.read_text(encoding="utf-8")
        for forbidden in (
            "node:fs",
            "node:http",
            "node:https",
            "node:child_process",
            "fetch(",
            "exec(",
            "spawn(",
            "writeFile",
            "appendFile",
            "ControlBotClient",
            "BrowserExecutionAdapter",
        ):
            self.assertNotIn(forbidden, source)

        run_node(
            NODE_FIXTURE
            + r"""
            globalThis.fetch = () => { throw new Error('network access attempted'); };

            const { ready, packet, verification, preview, manifest } = evidence();

            const candidates = [
              { ...manifest, fingerprint: '0'.repeat(64) },
              refingerprint({ ...manifest, packet_fingerprint: 'c'.repeat(64) }),
              refingerprint({ ...manifest, verification_fingerprint: 'd'.repeat(64) }),
              refingerprint({ ...manifest, preview_fingerprint: 'e'.repeat(64) }),
              refingerprint({ ...manifest, authority: 'elevated' }),
              refingerprint({ ...manifest, execution: true }),
              refingerprint({ ...manifest, network_access: true }),
              refingerprint({ ...manifest, external_mutation: true }),
              refingerprint({ ...manifest, version: 2 }),
              { ...manifest, unexpected: true },
            ];
            for (const candidate of candidates) {
              assert.throws(() => verify(candidate, packet, verification, preview, ready));
            }

            const other = evidence('execution:recovery:handoff:beta');
            assert.throws(() => verify(
              manifest,
              other.packet,
              other.verification,
              other.preview,
              ready,
            ));
            assert.throws(() => verify(
              manifest,
              packet,
              other.verification,
              preview,
              ready,
            ));
            assert.throws(() => verify(
              manifest,
              packet,
              verification,
              other.preview,
              ready,
            ));

            const stale = readiness();
            stale.fingerprint = 'f'.repeat(64);
            assert.throws(() => verify(manifest, packet, verification, preview, stale));

            assert.throws(() => executionRecoveryHandoffManifestVerify(
              manifest,
              packet,
              verification,
              preview,
              executionId,
              readiness(),
              'c'.repeat(64),
              planFingerprint,
            ));
            """
        )


if __name__ == "__main__":
    unittest.main()
