"""Aceptación de unicidad de order_id por poll batch (FactoryRunner #240)."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def observe() -> dict[str, object]:
    script = r"""
import { RuntimeSupervisor } from './src/runtime-supervisor.ts';

const RUNNER = '11111111-1111-7111-8111-111111111111';
const ORDER_A = '22222222-2222-7222-8222-222222222222';
const ORDER_B = '33333333-3333-7333-8333-333333333333';

function order(orderId, workItem) {
  return {
    version: 1,
    order_id: orderId,
    work_item_id: workItem,
    runner_id: RUNNER,
    capability: 'git',
    attempt: 1,
    issued_at: 1000,
    expires_at: 2000,
    instruction_ref: 'controlbot:instruction:240',
  };
}

const orderA = order(ORDER_A, 'factoryrunner:work:240:a');
const orderB = order(ORDER_B, 'factoryrunner:work:240:b');
const polledA = { ...orderA, fingerprint: 'a'.repeat(64) };
const polledB = { ...orderB, fingerprint: 'b'.repeat(64) };

const counts = { validated: 0, ack: 0, execute: 0, publish: 0 };
const pollCursors = [];
let polls = 0;

const client = {
  async poll(cursor) {
    pollCursors.push(cursor);
    polls += 1;
    if (polls === 1) {
      return {
        version: 1,
        cursor: 'cursor-duplicate',
        orders: [polledA, polledA],
      };
    }
    return {
      version: 1,
      cursor: 'cursor-ok',
      orders: [polledA, polledB],
    };
  },
  validatedOrder(orderId) {
    counts.validated += 1;
    if (orderId === ORDER_A) return orderA;
    if (orderId === ORDER_B) return orderB;
    throw new TypeError('unknown order');
  },
  async ack() { counts.ack += 1; },
  async publishEvents() { counts.publish += 1; },
  async publishHeartbeat() {},
};

const storedOrders = [];
const storedEvents = [];
const journal = {
  recover() {
    return {
      orders: [...storedOrders],
      events: [...storedEvents],
    };
  },
  appendOrder(item) { storedOrders.push(item); },
  appendEvent(item) { storedEvents.push(item); },
};

const delivered = new Set();
let deliverySequence = 0;
const outbox = {
  recover() {
    return {
      pending: [],
      delivered: [...delivered].map((delivery_id) => ({ delivery_id })),
    };
  },
  enqueueAck() {
    deliverySequence += 1;
    return { delivery_id: 'delivery-' + deliverySequence };
  },
  enqueueEvents() {
    deliverySequence += 1;
    return { delivery_id: 'delivery-' + deliverySequence };
  },
  markDelivered(deliveryId) { delivered.add(deliveryId); },
};

const loop = {
  async execute() { counts.execute += 1; },
};

let eventSequence = 0;
const supervisor = new RuntimeSupervisor({
  client,
  journal,
  outbox,
  loop,
  now: () => 1010,
  event_id: () => '00000000-0000-7000-8000-' + String(++eventSequence).padStart(12, '0'),
});

let duplicateError = null;
try {
  await supervisor.tick(16);
} catch (caught) {
  duplicateError = {
    name: caught instanceof Error ? caught.name : typeof caught,
    message: caught instanceof Error ? caught.message : String(caught),
  };
}
const afterDuplicate = {
  counts: { ...counts },
  storedOrders: storedOrders.length,
  storedEvents: storedEvents.length,
  delivered: delivered.size,
};

const uniqueResult = await supervisor.tick(16);

console.log(JSON.stringify({
  duplicateError,
  afterDuplicate,
  pollCursors,
  uniqueResult,
  finalCounts: counts,
  storedOrders: storedOrders.map((item) => item.order_id),
  delivered: delivered.size,
}));
"""
    completed = subprocess.run(
        ("node", "--experimental-strip-types", "--input-type=module", "-e", script),
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=True,
        timeout=20,
    )
    return json.loads(completed.stdout.strip().splitlines()[-1])


class FactoryRunnerRuntimePollUniquenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.observed = observe()

    def test_duplicate_order_ids_fail_closed_before_execution(self):
        error = self.observed["duplicateError"]
        self.assertEqual(error["name"], "TypeError")
        self.assertIn("order_id duplicado", error["message"])
        self.assertEqual(
            self.observed["afterDuplicate"],
            {
                "counts": {"validated": 0, "ack": 0, "execute": 0, "publish": 0},
                "storedOrders": 0,
                "storedEvents": 0,
                "delivered": 0,
            },
        )

    def test_unique_batch_preserves_cursor_and_processing_contract(self):
        self.assertEqual(self.observed["pollCursors"], [None, None])
        self.assertEqual(
            self.observed["uniqueResult"],
            {"processed": 2, "cursor": "cursor-ok"},
        )
        self.assertEqual(
            self.observed["finalCounts"],
            {"validated": 4, "ack": 2, "execute": 2, "publish": 2},
        )
        self.assertEqual(
            self.observed["storedOrders"],
            [
                "22222222-2222-7222-8222-222222222222",
                "33333333-3333-7333-8333-333333333333",
            ],
        )
        self.assertEqual(self.observed["delivered"], 4)


if __name__ == "__main__":
    unittest.main()
