"""Aceptación ejecutable de drain/shutdown FactoryRunner #59."""
from __future__ import annotations

from tests.node_acceptance import NodeAcceptanceCase


class FactoryRunnerDrainShutdownTests(NodeAcceptanceCase):
    def test_draining_refuses_new_orders_and_preserves_inflight_terminalization(self):
        self.assert_node_test(
            "runtime supervisor draining refuses new orders and preserves inflight terminalization"
        )

    def test_heartbeat_capacity_is_derived_from_observed_runtime_state(self):
        self.assert_node_test(
            "runtime supervisor heartbeat capacity is derived from observed runtime state"
        )
