"""Aceptación ejecutable del runtime supervisor FactoryRunner #58."""
from __future__ import annotations

from tests.node_acceptance import NodeAcceptanceCase


class FactoryRunnerRuntimeSupervisorTests(NodeAcceptanceCase):
    def test_tick_durably_accepts_before_ack_execute_and_publish(self):
        self.assert_node_test(
            "runtime supervisor durably accepts before ack execute and publish"
        )

    def test_restart_reuses_terminal_state_without_duplicate_dispatch(self):
        self.assert_node_test(
            "runtime supervisor restart reuses terminal state without duplicate dispatch"
        )
