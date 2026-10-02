"""Aceptación del pin exacto de entry browser remoto antes de ACK (#218)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE_TEST = ROOT / "tests" / "test_factoryrunner_browser_remote_ack_drift.py"


def observe() -> dict[str, object]:
    source = BASE_TEST.read_text(encoding="utf-8")
    prefix = '    script = r"""\n'
    suffix = '"""\n    raw = subprocess.check_output('
    if source.count(prefix) != 1 or source.count(suffix) != 1:
        raise AssertionError("fixture #204 no tiene la forma esperada")
    script = source.split(prefix, 1)[1].split(suffix, 1)[0]

    original = (
        "replacement.register({ profile: remoteProfile('browser-secondary'), "
        "transport: secondary });"
    )
    replacement = (
        "replacement.register({ profile: remoteProfile('browser-primary'), "
        "transport: secondary });"
    )
    if script.count(original) != 1:
        raise AssertionError("fixture #204 cambió: no se encontró el binding sustituto")
    script = script.replace(original, replacement, 1)

    raw = subprocess.check_output(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        stderr=subprocess.STDOUT,
        timeout=20,
    )
    return json.loads(raw.strip().splitlines()[-1])


class FactoryRunnerBrowserRemoteEntryDriftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_same_profile_transport_substitution_during_ack_cannot_hijack_dispatch(self):
        substitution = self.observed["missing"]
        self.assertIsNotNone(substitution["error"])
        self.assertEqual(substitution["counts"]["ack"], 1)
        self.assertEqual(substitution["primaryCalls"], 0)
        self.assertEqual(substitution["secondaryCalls"], 0)
        self.assertEqual(substitution["events"], ["accepted"])

    def test_terminal_recovery_revalidates_entry_handle_without_ack_or_transport_replay(self):
        recovery = self.observed["recovery"]
        actual = {
            "first": (recovery["firstResult"], recovery["firstCounts"], recovery["firstTransportCalls"]),
            "restart": (
                recovery["restartResult"],
                recovery["restartCounts"],
                recovery["restartTransportCalls"],
            ),
            "events": recovery["events"],
        }
        self.assertEqual(
            actual,
            {
                "first": (
                    {"processed": 1, "cursor": None},
                    {"ack": 1, "publish": 1, "placement": 1, "request": 1},
                    1,
                ),
                "restart": (
                    {"processed": 1, "cursor": None},
                    {"ack": 0, "publish": 0, "placement": 1, "request": 1},
                    0,
                ),
                "events": ["accepted", "started", "completed"],
            },
        )
