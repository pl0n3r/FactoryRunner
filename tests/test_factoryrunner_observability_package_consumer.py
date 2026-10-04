import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "build-observability-package.ts"
PACKAGE_NAME = "@pl0n3r/factoryrunner"


class FactoryRunnerObservabilityPackageConsumerTests(unittest.TestCase):
    def _npm_env(self, cache: Path) -> dict[str, str]:
        cache.mkdir()
        env = os.environ.copy()
        env.update(
            {
                "npm_config_offline": "true",
                "npm_config_ignore_scripts": "true",
                "npm_config_audit": "false",
                "npm_config_fund": "false",
                "npm_config_update_notifier": "false",
                "npm_config_cache": str(cache),
            }
        )
        return env

    def _build_and_pack(self, root: Path) -> Path:
        stage = root / "stage"
        subprocess.run(
            [
                "node",
                "--experimental-strip-types",
                str(BUILDER),
                "--output",
                str(stage),
            ],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )

        staged_manifest = json.loads(
            (stage / "package.json").read_text(encoding="utf-8")
        )
        self.assertEqual(
            staged_manifest.get("exports"),
            {".": "./src/browser-remote-observability-public.js"},
        )
        self.assertNotIn("dependencies", staged_manifest)
        self.assertNotIn("scripts", staged_manifest)

        pack_dir = root / "pack"
        pack_dir.mkdir()
        completed = subprocess.run(
            [
                "npm",
                "pack",
                "--json",
                "--offline",
                "--ignore-scripts",
                "--pack-destination",
                str(pack_dir),
                ".",
            ],
            cwd=stage,
            env=self._npm_env(root / "pack-cache"),
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        payload = json.loads(completed.stdout)
        self.assertIsInstance(payload, list)
        self.assertEqual(len(payload), 1)
        filename = payload[0].get("filename")
        self.assertIsInstance(filename, str)
        tarball = pack_dir / filename
        self.assertTrue(tarball.is_file())
        return tarball

    def _install_consumer(self, root: Path, tarball: Path) -> Path:
        consumer = root / "consumer"
        consumer.mkdir()
        (consumer / "package.json").write_text(
            json.dumps(
                {
                    "name": "factoryrunner-observability-consumer-fixture",
                    "private": True,
                    "type": "module",
                },
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
        subprocess.run(
            [
                "npm",
                "install",
                "--offline",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--package-lock=false",
                "--save-exact",
                str(tarball),
            ],
            cwd=consumer,
            env=self._npm_env(root / "install-cache"),
            check=True,
            capture_output=True,
            text=True,
            timeout=60,
        )
        installed = consumer / "node_modules" / "@pl0n3r" / "factoryrunner"
        self.assertTrue(installed.is_dir())
        self.assertFalse(any(installed.rglob("*.ts")))
        return consumer

    def test_temp_consumer_installs_local_artifact_and_uses_public_observability_api_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tarball = self._build_and_pack(root)
            consumer = self._install_consumer(root, tarball)

            script = consumer / "consumer.mjs"
            script.write_text(
                """import { createHash } from 'node:crypto';
import {
  browserRemoteObservabilityPublicConsumerCompatibility,
  browserRemoteObservabilityPublicPacket,
} from '@pl0n3r/factoryrunner';

function canonicalValue(value) {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (typeof value === 'object') {
    const ordered = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b, 'en'))) {
      ordered[key] = canonicalValue(value[key]);
    }
    return ordered;
  }
  throw new TypeError('Valor no serializable.');
}

function fingerprint(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)), 'utf8')
    .digest('hex');
}

const core = Object.freeze({
  version: 1,
  authority: 'unchanged',
  status: 'READY',
  doctor_fingerprint: 'a'.repeat(64),
  health_fingerprint: 'b'.repeat(64),
  metrics_fingerprint: 'c'.repeat(64),
  snapshot_fingerprint: 'd'.repeat(64),
  readiness_fingerprint: 'e'.repeat(64),
  network_access: false,
  external_mutation: false,
});
const health = Object.freeze({ ...core, fingerprint: fingerprint(core) });
const packet = browserRemoteObservabilityPublicPacket(health);
const compatibility = browserRemoteObservabilityPublicConsumerCompatibility(
  packet,
  {
    version: 1,
    manifest_version: 1,
    required_exports: [
      { export_name: 'browserRemoteDirectoryHealth', contract_version: 1 },
      { export_name: 'browserRemoteDirectorySnapshot', contract_version: 1 },
    ],
  },
);

process.stdout.write(JSON.stringify({
  packet_status: packet.status,
  packet_authority: packet.authority,
  packet_network_access: packet.network_access,
  packet_external_mutation: packet.external_mutation,
  compatibility_status: compatibility.status,
  compatibility_authority: compatibility.authority,
  compatibility_reasons: compatibility.reasons,
  compatibility_network_access: compatibility.network_access,
  compatibility_external_mutation: compatibility.external_mutation,
}));
""",
                encoding="utf-8",
            )
            completed = subprocess.run(
                ["node", str(script)],
                cwd=consumer,
                check=False,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(completed.stdout)

        self.assertEqual(result["packet_status"], "READY")
        self.assertEqual(result["packet_authority"], "unchanged")
        self.assertIs(result["packet_network_access"], False)
        self.assertIs(result["packet_external_mutation"], False)
        self.assertEqual(result["compatibility_status"], "COMPATIBLE")
        self.assertEqual(result["compatibility_authority"], "unchanged")
        self.assertEqual(result["compatibility_reasons"], [])
        self.assertIs(result["compatibility_network_access"], False)
        self.assertIs(result["compatibility_external_mutation"], False)

    def test_consumer_fails_closed_on_unsupported_or_internal_import_without_registry_access(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tarball = self._build_and_pack(root)
            consumer = self._install_consumer(root, tarball)
            completed = subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "--eval",
                    (
                        "await import("
                        "'@pl0n3r/factoryrunner/src/runtime-supervisor.js'"
                        ");"
                    ),
                ],
                cwd=consumer,
                capture_output=True,
                text=True,
                timeout=30,
            )

        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("ERR_PACKAGE_PATH_NOT_EXPORTED", completed.stderr)
        self.assertNotIn("ENET", completed.stderr)
        self.assertNotIn("registry", completed.stderr.lower())


if __name__ == "__main__":
    unittest.main()
