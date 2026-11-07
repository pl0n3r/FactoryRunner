"""FactoryRunner #608: negative offline QA, never authorization for Hostinger I/O."""
from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
import re
import unittest

DOC = Path(__file__).resolve().parents[1] / "docs" / "hostinger-ops-readiness.md"
_SHA = re.compile(r"[0-9a-f]{40}\Z")
_ALIAS = re.compile(r"[a-z][a-z0-9_-]{2,63}\Z")
_HOST = re.compile(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}\Z")
_SENSITIVE = re.compile(r"@|gh[pousr]_|github_pat_|sk-[A-Za-z0-9]{12,}|password\s*[=:]|token\s*[=:]|secret\s*[=:]", re.I)
_PREFLIGHT = {
    "mode", "sha", "owner_gate", "operator_scope", "account_alias", "hostname",
    "release", "environment", "privacy", "legal", "tls", "dns",
    "service_limits", "secret_custody", "monitoring", "isolation",
    "backup_restore", "rollback", "kill_switch",
}
_REQUIRED_PASSES = (
    "privacy", "legal", "tls", "dns", "service_limits", "secret_custody",
    "monitoring", "isolation", "backup_restore", "rollback",
)
_RECEIPT = {
    "project", "surface", "test", "sha", "release", "environment",
    "observed_at", "source_ref", "window", "result",
}
_TERMINAL = {
    "sha", "release", "environment", "observed_at", "source_ref",
    "status", "pending", "mode",
}


class HostileMapping(Mapping):
    """Simulate untrusted mapping accessors with side effects."""

    def __getitem__(self, key):
        raise RuntimeError("untrusted getter invoked")

    def __iter__(self):
        raise RuntimeError("untrusted iterator invoked")

    def __len__(self):
        return 1


class HostileComparison:
    def __eq__(self, other):
        raise RuntimeError("untrusted equality invoked")


def _safe(value: object) -> bool:
    return type(value) is str and bool(value.strip()) and not _SENSITIVE.search(value)


def _utc(value: object) -> bool:
    if not _safe(value) or not value.endswith("Z"):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() == timezone.utc.utcoffset(parsed)


def preflight_status(proof: object, expected_sha: str) -> str:
    """Strict structure only; caller assertions never authorize remote actions."""
    if type(proof) is not dict or type(expected_sha) is not str or not _SHA.fullmatch(expected_sha):
        return "BLOCKED"
    if any(type(key) is not str for key in proof) or set(proof) != _PREFLIGHT:
        return "BLOCKED"
    if any(type(value) is not str for value in proof.values()) or proof.get("sha") != expected_sha:
        return "BLOCKED"
    if proof.get("mode") != "real_authorized" or proof.get("owner_gate") != "SPECIFIC_OPERATIONS_APPROVAL":
        return "BLOCKED"
    if proof.get("operator_scope") != "read_only":
        return "BLOCKED"
    if not _safe(proof.get("account_alias")) or not _ALIAS.fullmatch(proof["account_alias"]):
        return "BLOCKED"
    if not _safe(proof.get("hostname")) or not _HOST.fullmatch(proof["hostname"]):
        return "BLOCKED"
    if any(proof.get(key) != "PASS" for key in _REQUIRED_PASSES):
        return "BLOCKED"
    if proof.get("kill_switch") != "RUNNING":
        return "BLOCKED"
    if not all(_safe(proof.get(key)) for key in ("release", "environment")):
        return "BLOCKED"
    # Even perfectly shaped synthetic PASS values have no authenticated origin.
    return "REQUIRES_EXTERNAL_VERIFICATION"


def provenance_status(receipt: object, expected_sha: str) -> str:
    """Validate receipt shape without trusting caller-supplied provenance."""
    if type(receipt) is not dict or type(expected_sha) is not str or not _SHA.fullmatch(expected_sha):
        return "UNKNOWN"
    if any(type(key) is not str for key in receipt) or set(receipt) != _RECEIPT:
        return "UNKNOWN"
    if any(type(value) is not str for value in receipt.values()) or receipt.get("sha") != expected_sha:
        return "UNKNOWN"
    if receipt.get("project") != "pl0n3r/FactoryRunner":
        return "UNKNOWN"
    if not _utc(receipt.get("observed_at")):
        return "UNKNOWN"
    if not all(_safe(receipt.get(key)) for key in _RECEIPT - {"sha", "observed_at"}):
        return "UNKNOWN"
    # String identifiers and "PASS" do not authenticate the source.
    return "UNVERIFIED_SOURCE"


def terminal_status(receipt: object, expected_sha: str) -> str:
    """External authoritative exact-SHA proof is never inferred offline."""
    if type(receipt) is not dict or type(expected_sha) is not str or not _SHA.fullmatch(expected_sha):
        return "UNKNOWN"
    if any(type(key) is not str for key in receipt) or set(receipt) != _TERMINAL:
        return "UNKNOWN"
    if any(type(receipt[key]) is not str for key in _TERMINAL - {"pending"}):
        return "UNKNOWN"
    if type(receipt["pending"]) is not list or receipt["pending"] or receipt.get("sha") != expected_sha:
        return "UNKNOWN"
    if receipt.get("status") != "VALIDATED_IN_PRODUCTION":
        return "UNKNOWN"
    if receipt.get("mode") != "real" or not _utc(receipt.get("observed_at")):
        return "UNKNOWN"
    if not all(_safe(receipt.get(key)) for key in ("release", "environment", "source_ref")):
        return "UNKNOWN"
    return "REQUIRES_EXTERNAL_VERIFICATION"


class HostingerOpsReadinessTests(unittest.TestCase):
    @staticmethod
    def fixture(sha: str) -> dict[str, str]:
        return dict(mode="real_authorized", sha=sha, owner_gate="SPECIFIC_OPERATIONS_APPROVAL",
                    operator_scope="read_only", account_alias="hosting_fixture",
                    hostname="runner.example.invalid", release="fixture-v1", environment="fixture",
                    privacy="PASS", legal="PASS", tls="PASS", dns="PASS",
                    service_limits="PASS", secret_custody="PASS", monitoring="PASS",
                    isolation="PASS", backup_restore="PASS", rollback="PASS",
                    kill_switch="RUNNING")

    def test_autorizacion(self):
        sha = "a" * 40
        fixture = self.fixture(sha)
        self.assertEqual(preflight_status(None, sha), "BLOCKED")
        self.assertEqual(preflight_status(HostileMapping(), sha), "BLOCKED")
        self.assertEqual(preflight_status(fixture, None), "BLOCKED")
        self.assertEqual(preflight_status({**fixture, "owner_gate": HostileComparison()}, sha), "BLOCKED")
        self.assertEqual(preflight_status({"owner_gate": "A"}, sha), "BLOCKED")
        self.assertEqual(preflight_status({**fixture, "owner_gate": "A"}, sha), "BLOCKED")
        self.assertEqual(preflight_status({**fixture, "operator_scope": "write"}, sha), "BLOCKED")
        self.assertEqual(preflight_status({**fixture, "account_alias": "user@example.invalid"}, sha), "BLOCKED")
        self.assertEqual(preflight_status({**fixture, "hostname": "bad host"}, sha), "BLOCKED")
        self.assertEqual(preflight_status(fixture, sha), "REQUIRES_EXTERNAL_VERIFICATION")
        # Conditional decisions must be recorded without implying live authority.
        doc = DOC.read_text(encoding="utf-8")
        for marker in ("#612", "#634/A", "#635/A", "NO_ACREDITADO",
                       "live_authorized=false", "readiness=UNKNOWN"):
            with self.subTest(decision_or_gate=marker):
                self.assertIn(marker, doc)

    def test_evidencia(self):
        sha = "b" * 40
        r = dict(project="pl0n3r/FactoryRunner", surface="tls", test="certificate_expiry",
                 sha=sha, release="fixture-v1", environment="fixture",
                 observed_at="2026-10-27T00:00:00Z", source_ref="fixture:offline",
                 window="fixture-window", result="PASS")
        self.assertEqual(provenance_status(r, sha), "UNVERIFIED_SOURCE")
        self.assertEqual(provenance_status(HostileMapping(), sha), "UNKNOWN")
        self.assertEqual(provenance_status(r, None), "UNKNOWN")
        self.assertEqual(provenance_status({**r, "result": HostileComparison()}, sha), "UNKNOWN")
        self.assertEqual(provenance_status({**r, "sha": "c" * 40}, sha), "UNKNOWN")
        self.assertEqual(provenance_status({**r, "observed_at": "not-a-date"}, sha), "UNKNOWN")
        self.assertEqual(provenance_status({**r, "verified": True}, sha), "UNKNOWN")
        self.assertEqual(provenance_status({**r, "environment": "token=fiction"}, sha), "UNKNOWN")

    def test_negativos(self):
        sha = "c" * 40
        fixture = self.fixture(sha)
        for key in _REQUIRED_PASSES:
            with self.subTest(gate=key):
                self.assertEqual(preflight_status({**fixture, key: "UNKNOWN"}, sha), "BLOCKED")
                partial = {**fixture}
                del partial[key]
                self.assertEqual(preflight_status(partial, sha), "BLOCKED")
        for key, value in (("kill_switch", "PAUSED"), ("backup_restore", "CLAIMED"),
                           ("rollback", "CLAIMED"), ("secret_custody", "token=fiction"),
                           ("sha", "d" * 40)):
            with self.subTest(key=key):
                self.assertEqual(preflight_status({**fixture, key: value}, sha), "BLOCKED")
        doc = DOC.read_text(encoding="utf-8").casefold()
        for term in ("dns-02", "dns-03", "mo-03", "se-02", "co-03", "tls", "rollback",
                     "restore", "aislamiento", "https", "cron", "p95", "soporte"):
            self.assertIn(term, doc)
        self.assertNotIn("live_authorized=true", doc)

    def test_recibo_terminal(self):
        sha = "d" * 40
        full = dict(sha=sha, release="fixture-v1", environment="fixture",
                    observed_at="2026-10-27T00:00:00Z", source_ref="fixture:offline",
                    status="VALIDATED_IN_PRODUCTION", pending=[], mode="real")
        self.assertEqual(terminal_status(None, sha), "UNKNOWN")
        self.assertEqual(terminal_status(HostileMapping(), sha), "UNKNOWN")
        self.assertEqual(terminal_status(full, None), "UNKNOWN")
        self.assertEqual(terminal_status({**full, "status": HostileComparison()}, sha), "UNKNOWN")
        self.assertEqual(terminal_status({**full, "pending": HostileComparison()}, sha), "UNKNOWN")
        self.assertEqual(terminal_status(full, sha), "REQUIRES_EXTERNAL_VERIFICATION")
        for key in _TERMINAL:
            with self.subTest(missing=key):
                partial = dict(full)
                del partial[key]
                self.assertEqual(terminal_status(partial, sha), "UNKNOWN")
        for key, value in (("status", "DEPLOY_OBSERVED"), ("status", "success"),
                           ("pending", ["smoke"]), ("mode", "synthetic_only"),
                           ("sha", "e" * 40), ("observed_at", "stale")):
            with self.subTest(key=key):
                self.assertEqual(terminal_status({**full, key: value}, sha), "UNKNOWN")


# Allow direct target execution as well as unittest class discovery.
def test_autorizacion():
    HostingerOpsReadinessTests("test_autorizacion").test_autorizacion()


def test_evidencia():
    HostingerOpsReadinessTests("test_evidencia").test_evidencia()


def test_negativos():
    HostingerOpsReadinessTests("test_negativos").test_negativos()


def test_recibo_terminal():
    HostingerOpsReadinessTests("test_recibo_terminal").test_recibo_terminal()


if __name__ == "__main__":
    unittest.main()
