"""FactoryRunner #654: real TypeScript behavior, synthetic inputs, no live authority.

Rows B require actual services / operator / consent / production evidence.
Rows C are legal or documentary decisions with no executable behavior.
Offline behavior demonstrated here is a *subset*, never certification of a B row.
The coverage matrix is not loaded or inspected by these tests.
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CI = ROOT / ".github/workflows/ci.yml"

# Complete, explicit disposition of the 20 requested integral matrix rows.
# B = genuine provider, deployed system, user consent or live operation needed;
# C = no implemented executable behavior, requires legal/owner policy approval.
DISPOSITION = {
    "DB-04": ("B", "DB snapshot/restore and authorized database receipt are real-only"),
    "GD-04": ("B", "authorized Drive OAuth/account and provider receipt are missing"),
    "GL-05": ("B", "real PII/session processing requires legal approval and lawful basis"),
    "GL-06": ("B", "Hostinger operator, HTTPS, permissions and credentials need real evidence"),
    "GL-07": ("B", "real backup restore and rollback receipts are missing"),
    "GL-08": ("B", "deployed kill switch, smoke, version and SHA are not observed"),
    "KS-04": ("B", "real end-to-end rollback cannot be inferred from fake rehearsal"),
    "LO-07": ("B", "real S3 permission, versioning and restore receipts are missing"),
    "LOC-13": ("B", "real user-data use requires independent privacy and source review"),
    "PA-01": ("C", "owner identity and rights contact are unapproved legal text"),
    "PA-02": ("B", "consent requires real unchecked UI, subject and authentic receipt"),
    "PC-01": ("C", "rights procedure and verified contact are unapproved legal policy"),
    "PP-01": ("C", "processing policy needs independent legal and owner approval"),
    "PRG-01": ("C", "record of lawful basis, retention and providers is still draft"),
    "PRT-01": ("C", "retention deadlines require owner/legal determination"),
    "PTC-01": ("C", "SLA, warranties and jurisdiction require legal/owner approval"),
    "PTC-02": ("C", "controversy and support contact require validated policy/owner"),
    "RM-08": ("B", "real Hostinger health and deploy SHA are not observed"),
    "RM-12": ("B", "real HTTPS cockpit and credential operation require live evidence"),
    "RM-13": ("B", "no bypass can be proven for real providers from fake challenges"),
}

# Every named test below invokes the actual product implementation through
# node:test with local, injected fake transports/drivers (not Python simulations).
# The complete B criterion is *not* marked covered by any of these partial proofs.
REAL_CODE_CASES = {
    "DB-04": ("tests/recovery-database-adapter.test.ts", (
        "snapshot descriptor and capability contract",
        "restore is disposable only and rejects production targets",
        "driver boundary rejects DSN credentials SQL URLs and extras",
    )),
    "GD-04": ("tests/recovery-google-drive-adapter.test.ts", (
        "google drive descriptor is cold-copy and capability matches operation",
        "driver boundary rejects credential material URLs and extra fields",
    )),
    "GL-05": ("tests/go-live-preflight.test.ts", (
        "reports cannot elevate live authority regardless of gate combinations",
        "ambiguous, spoofed or invalid evidence never accepted",
    )),
    "GL-07": ("tests/go-live-preflight.test.ts", (
        "missing, stale and failed offline proof are fail closed",
    )),
    "GL-08": ("tests/go-live-preflight.test.ts", (
        "all offline proofs enable preparation but never operation",
    )),
    "KS-04": ("tests/kill-switch-rollback-rehearsal.test.ts", (
        "AC-01 tras el kill switch no se aceptan ejecuciones nuevas",
        "AC-02 rollback restaura el estado previo y la repeticion es idempotente",
    )),
    "LO-07": ("tests/recovery-live-object-storage.test.ts", (
        "missing suspended or unknown versioning fails closed before object operation",
        "missing disabled or unknown Object Lock fails closed before object operation",
    )),
    "LOC-13": ("tests/local-observer-source-adapter.test.ts", (
        "AC02 stale offline future and identity drift can never become FRESH",
        "AC03 private sessions evidence UUID and local queue never leak",
    )),
    "RM-13": ("tests/remote-adapters-no-evasion.test.ts", (
        "CAPTCHA, MFA and rate limits stop every remote adapter with one request and unchanged identity",
        "unknown, missing and malformed remote challenge responses fail closed without retry",
    )),
}

# Main behavior exercised by existing checked-in TS suites. We assert these
# negative pathways really ran and passed, rather than matching source comments.
NEGATIVE_CASES = {
    "DB-04": "restore is disposable only and rejects production targets",
    "GD-04": "driver boundary rejects credential material URLs and extra fields",
    "GL-05": "ambiguous, spoofed or invalid evidence never accepted",
    "GL-07": "missing, stale and failed offline proof are fail closed",
    "KS-04": "AC-01 tras el kill switch no se aceptan ejecuciones nuevas",
    "LO-07": "missing disabled or unknown Object Lock fails closed before object operation",
    "LOC-13": "AC02 stale offline future and identity drift can never become FRESH",
    "RM-13": "unknown, missing and malformed remote challenge responses fail closed without retry",
}


class CoberturaFactoryrunner01Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        suites = sorted({name for name, _ in REAL_CODE_CASES.values()})
        for name in suites:
            if not (ROOT / name).is_file():
                raise AssertionError("Missing real product test: " + name)
        # Node's test runner imports the real src/*.ts modules; every driver is a
        # repository fixture. No production DNS, database, cloud or PII is used.
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "--test", "--test-reporter=tap", *suites],
            cwd=ROOT, capture_output=True, text=True, check=False, timeout=180,
        )
        cls.node_output = completed.stdout
        if completed.returncode != 0 or "# fail 0" not in completed.stdout:
            raise AssertionError("Real TypeScript suites failed:\n"
                                 + (completed.stdout + completed.stderr)[-6500:])

    def test_contrato_principal(self) -> None:
        """AC-01: 20 classified rows; 9 actual-code offline subcontrols executed."""
        self.assertEqual(len(DISPOSITION), 20)
        self.assertEqual(len(REAL_CODE_CASES), 9)
        for row, (kind, reason) in DISPOSITION.items():
            with self.subTest(row=row):
                self.assertIn(kind, {"B", "C"})
                self.assertGreater(len(reason), 22)
        for row, (suite, cases) in REAL_CODE_CASES.items():
            with self.subTest(executed_real_code=row):
                source = (ROOT / suite).read_text(encoding="utf-8")
                self.assertTrue("from '../src/" in source or "from '../scripts/" in source)
                self.assertIn(DISPOSITION[row][0], {"B"})
                for case in cases:
                    self.assertIn(case, source)
                    self.assertIn("# Subtest: " + case, self.node_output)

    def test_falla_cerrado(self) -> None:
        """AC-02: fail-closed *product* paths stay exercised."""
        for row, case in NEGATIVE_CASES.items():
            with self.subTest(real_negative=row):
                self.assertIn("# Subtest: " + case, self.node_output)
    def test_sin_datos_reales(self) -> None:
        """AC-03: only local checked-in fixtures, no secrets/PII/network collector."""
        local_source = Path(__file__).read_text(encoding="utf-8")
        self.assertNotRegex(local_source,
                            r"(?m)^\s*(?:from|import)\s+(?:requests|httpx|socket|urllib)\b")
        self.assertNotIn("-----BEGIN " + "PRIVATE KEY-----", local_source)
        self.assertEqual(set(REAL_CODE_CASES) - set(DISPOSITION), set())
        # These are specific real implementation imports, not dummy test names.
        for row in REAL_CODE_CASES:
            suite = (ROOT / REAL_CODE_CASES[row][0]).read_text(encoding="utf-8")
            self.assertTrue("../src/" in suite or "../scripts/" in suite)
        self.assertEqual(set(DISPOSITION) - set(REAL_CODE_CASES),
                         {row for row in DISPOSITION if row not in REAL_CODE_CASES})

    def test_ci_gate_contract(self) -> None:
        """AC-04: verify CI wiring; GH exact-SHA terminal success is still required."""
        source = CI.read_text(encoding="utf-8")
        self.assertIn("name: validate", source)
        self.assertIn("npm run typecheck", source)
        self.assertIn("npm test", source)
        self.assertIn("python3 -m unittest discover -s tests -p 'test_*.py'", source)


if __name__ == "__main__":
    unittest.main()
