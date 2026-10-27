"""FactoryRunner #609: offline negative QA; never attests an actual runtime."""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path
import re
import unittest

DOC = Path(__file__).resolve().parents[1] / "docs" / "launch-qa-smoke.md"
_SHA = re.compile(r"[0-9a-f]{40}\Z")
_NO_CREDENTIALS = re.compile(r"(?:gh[pousr]_|github_pat_|sk-[A-Za-z0-9]{18,}|@)")


def preflight_status(evidence: object, expected_sha: str) -> str:
    """Reject unverifiable caller-provided evidence; never authorize operations."""
    if not isinstance(evidence, Mapping) or not _SHA.fullmatch(expected_sha):
        return "BLOCKED"
    # This is a purely local structural filter, NOT a trusted attestor.
    if set(evidence) != {
        "mode", "sha", "release", "environment", "owner_gate",
        "privacy", "service_limits", "backup_restore", "rollback",
    }:
        return "BLOCKED"
    if evidence.get("mode") != "real_authorized":
        return "BLOCKED"
    if evidence.get("sha") != expected_sha:
        return "BLOCKED"
    for key in ("release", "environment", "owner_gate", "privacy", "service_limits", "backup_restore", "rollback"):
        value = evidence.get(key)
        if type(value) is not str or not value or _NO_CREDENTIALS.search(value):
            return "BLOCKED"
    # Caller assertions are never sufficient proof of privileges or restore.
    return "REQUIRES_EXTERNAL_VERIFICATION"


def provenance_status(record: object, expected_sha: str) -> str:
    """A synthetic fixture cannot authenticate its own provenance."""
    if not isinstance(record, Mapping) or not _SHA.fullmatch(expected_sha):
        return "UNKNOWN"
    keys = {"project", "sha", "release", "environment", "observed_at", "source_ref", "result"}
    if set(record) != keys or record.get("project") != "pl0n3r/FactoryRunner":
        return "UNKNOWN"
    if record.get("sha") != expected_sha:
        return "UNKNOWN"
    for key in keys - {"sha"}:
        val = record.get(key)
        if type(val) is not str or not val or _NO_CREDENTIALS.search(val):
            return "UNKNOWN"
    # A source_ref string does not establish an authenticated source.
    return "UNVERIFIED_SOURCE"


def terminal_status(record: object, expected_sha: str) -> str:
    """Never accept untrusted CI/fixture claims as production terminal proof."""
    if not isinstance(record, Mapping):
        return "UNKNOWN"
    if record.get("sha") != expected_sha or not _SHA.fullmatch(expected_sha):
        return "UNKNOWN"
    if record.get("status") != "VALIDATED_IN_PRODUCTION":
        return "UNKNOWN"
    if record.get("pending") != [] or record.get("mode") == "synthetic_only":
        return "UNKNOWN"
    # A forged status field still lacks authenticated provenance and authority.
    return "REQUIRES_EXTERNAL_VERIFICATION"


class LaunchQaSmokeTests(unittest.TestCase):
    def test_autorizacion(self):
        sha = "a" * 40
        self.assertEqual(preflight_status(None, sha), "BLOCKED")
        self.assertEqual(preflight_status({"owner_gate": "A"}, sha), "BLOCKED")
        fixture = dict(mode="real_authorized", sha=sha, release="v0", environment="fixture",
                       owner_gate="A", privacy="claimed", service_limits="claimed",
                       backup_restore="claimed", rollback="claimed")
        self.assertEqual(preflight_status(fixture, sha), "REQUIRES_EXTERNAL_VERIFICATION")
        self.assertEqual(preflight_status({**fixture, "environment": "user@example.org"}, sha), "BLOCKED")
        self.assertIn("#611", DOC.read_text(encoding="utf-8"))

    def test_evidencia(self):
        sha = "b" * 40
        record = dict(project="pl0n3r/FactoryRunner", sha=sha, release="fixture",
                      environment="fixture", observed_at="2026-10-27T00:00:00Z",
                      source_ref="fixture:smoke", result="PASS")
        self.assertEqual(provenance_status(record, sha), "UNVERIFIED_SOURCE")
        self.assertEqual(provenance_status({**record, "sha": "c" * 40}, sha), "UNKNOWN")
        self.assertEqual(provenance_status({**record, "subject_email": "a@b.org"}, sha), "UNKNOWN")

    def test_negativos(self):
        doc = DOC.read_text(encoding="utf-8")
        for phrase in ("p95", "accesibilidad", "CodeQL", "SonarCloud", "kill switch",
                       "rollback", "restore", "SHA", "privacidad", "permisos"):
            self.assertIn(phrase.casefold(), doc.casefold())
        self.assertNotIn("live_authorized=true", doc)
        self.assertNotIn("readiness=READY", doc)
        self.assertNotIn("@coderabbitai review", doc)

    def test_recibo_terminal(self):
        sha = "d" * 40
        self.assertEqual(terminal_status(None, sha), "UNKNOWN")
        for label in ("DEPLOY_OBSERVED", "NO_OBSERVADO", "UNKNOWN", "success"):
            self.assertEqual(terminal_status({"sha": sha, "status": label, "pending": []}, sha), "UNKNOWN")
        claimed = {"sha": sha, "status": "VALIDATED_IN_PRODUCTION", "pending": [], "mode": "real"}
        self.assertEqual(terminal_status(claimed, sha), "REQUIRES_EXTERNAL_VERIFICATION")
        self.assertEqual(terminal_status({**claimed, "mode": "synthetic_only"}, sha), "UNKNOWN")
        self.assertEqual(terminal_status({**claimed, "pending": ["smoke"]}, sha), "UNKNOWN")


# The factory-acceptance marker names module-level targets. Keep those targets
# callable by pytest/direct invocation as well as unittest discovery in CI.
def test_autorizacion():
    LaunchQaSmokeTests("test_autorizacion").test_autorizacion()


def test_evidencia():
    LaunchQaSmokeTests("test_evidencia").test_evidencia()


def test_negativos():
    LaunchQaSmokeTests("test_negativos").test_negativos()


def test_recibo_terminal():
    LaunchQaSmokeTests("test_recibo_terminal").test_recibo_terminal()


if __name__ == "__main__":
    unittest.main()
