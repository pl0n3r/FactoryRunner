"""FactoryRunner #655: real offline RM-14 and RT-05 boundary contracts.

Both rows need external authority/provider receipts for full certification (B).
These tests execute actual TS implementation with injected synthetic drivers;
passing them NEVER constitutes a live connection or production recovery.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UNKNOWN = "UNKNOWN"
DISPOSITION = {
    "RM-14": ("REAL", "B", "Real ControlBot identity, grants and execution authorization not observed."),
    "RT-05": ("OPERACIÓN", "B", "Real provider accounts, backup/restore and immutable receipts not observed."),
}

# Calls production TS functions, not a Python copy or a document-only assertion.
# No adapters can reach external services: every driver is an in-memory fake.
NODE = r"""
import assert from 'node:assert/strict';
import { capabilityManifest } from './src/capability-manifest.ts';
import { executionAdmissionDecision } from './src/execution-admission.ts';
import {
  RecoveryDatabaseAdapter, RecoveryGoogleDriveAdapter,
  RecoveryObjectStorageAdapter
} from './src/index.ts';
import { stableSha256 } from './src/validation.ts';

const runnerId='11111111-1111-7111-8111-111111111111';
const identity={
  version:1,runner_id:runnerId,protocol_version:1,runtime:'node',
  runtime_version:'0.1.5',platform:'linux-arm64',location:'hostinger-shared',
  capabilities:['git.head'],max_parallel:1
};
const registered=[{id:'git-read',capabilities:['git.head']}];
const manifest=capabilityManifest(identity,registered);
const resource={
  version:1,runner_id:runnerId,observed_at:1200,heartbeat_sequence:3,
  runner_status:'ready',max_parallel:1,active:0,available:1,
  queued_orders:1,dispatchable_orders:1,freshness:'fresh',
  age_seconds:10,stale_after_seconds:30
};
const order=(capability='git.head')=>({
  version:1,order_id:'22222222-2222-7222-8222-222222222222',
  work_item_id:'factoryrunner:work:655',runner_id:runnerId,
  capability,attempt:1,issued_at:1100,expires_at:1300,
  instruction_ref:'controlbot:instruction:fixture-655'
});
const admit=(id,command,skills,resources=resource)=>
  executionAdmissionDecision(id,command,skills,resources,1210);
const blocked=[];
const approved=admit(identity,order(),manifest);
assert.equal(approved.decision,'ALLOW');
assert.equal(approved.authority,'unchanged');
assert.deepEqual(approved.reasons,['admission_evidence_coherent']);
assert.deepEqual(manifest.capabilities,['git.head']);
const snapshot=JSON.stringify(manifest);
for (const capability of ['browser.navigate','git.status','network.forward']) {
  const decision=admit(identity,order(capability),manifest);
  assert.equal(decision.decision,'BLOCKED');
  assert.equal(decision.authority,'unchanged');
  blocked.push('unregistered-capability');
}
const expanded={...identity,capabilities:['git.head','browser.navigate']};
assert.equal(admit(expanded,order('browser.navigate'),manifest).decision,'BLOCKED');
assert.throws(
  ()=>capabilityManifest(expanded,registered),/Capability drift/
);
blocked.push('identity-capability-drift');
const injected={...manifest,capabilities:[...manifest.capabilities,'browser.navigate']};
assert.equal(admit(identity,order('browser.navigate'),injected).decision,'BLOCKED');
blocked.push('tampered-manifest');
for (const [label,id,command,skills,resources] of [
  ['missing-identity',null,order(),manifest,resource],
  ['missing-order',identity,null,manifest,resource],
  ['missing-manifest',identity,order(),null,resource],
  ['missing-resource',identity,order(),manifest,null],
  ['stale-resource',identity,order(),manifest,{...resource,freshness:'stale'}],
  ['forged-availability',identity,order(),manifest,{...resource,available:2}],
]) {
  const verdict=admit(id,command,skills,resources);
  assert.equal(verdict.decision,'BLOCKED',label);
  assert.equal(verdict.authority,'unchanged',label);
  blocked.push(label);
}
const full=admit(identity,order(),manifest,{
  ...resource,runner_status:'busy',active:1,available:0,dispatchable_orders:0
});
assert.equal(full.decision,'WAIT_CAPACITY');
assert.equal(full.authority,'unchanged');
assert.equal(JSON.stringify(manifest),snapshot);
blocked.push('capacity-exhausted');

const sha=letter=>letter.repeat(64);
const seal=body=>({...body,descriptor_id:stableSha256(body)});
const object=seal({
  version:1,project:'controlbot',provider:'object_storage',role:'primary_offsite',
  operation:'upload',namespace:'recovery:controlbot',object_ref:'object:synthetic-001',
  checksum_sha256:sha('a'),idempotency_key:'object-primary:001',
  authority:'unchanged',execute:false
});
const drive=seal({
  version:1,project:'controlbot',provider:'google_drive',role:'cold_copy',
  operation:'upload',namespace:'recovery:controlbot',object_ref:'object:synthetic-002',
  checksum_sha256:sha('b'),idempotency_key:'object-cold:001',
  authority:'unchanged',execute:false
});
const snapshotDb=seal({
  version:1,project:'controlbot',source:'database',operation:'snapshot',
  snapshot_ref:'snapshot:synthetic-001',idempotency_key:'db-snapshot:001',
  authority:'unchanged',execute:false
});
const restore=kind=>seal({
  version:1,project:'controlbot',source:'database',operation:'restore_disposable',
  backup_id:'backup:synthetic-001',checksum_sha256:sha('c'),
  target:{kind,target_ref:'target:synthetic-001'},
  idempotency_key:'db-restore:001',authority:'unchanged',execute:false
});
const objectCalls=[],driveCalls=[],dbCalls=[];
const objectDriver={async execute(command){
  objectCalls.push(command);
  return {status:'ok',object_ref:command.object_ref,
    checksum_sha256:command.checksum_sha256,
    immutable_version_ref:'version:synthetic-001',
    evidence_ref:'evidence:synthetic-object'};
}};
const driveDriver={async execute(command){
  driveCalls.push(command);
  return {status:'ok',object_ref:command.object_ref,
    checksum_sha256:command.checksum_sha256,
    remote_version_ref:'version:synthetic-drive',
    evidence_ref:'evidence:synthetic-drive'};
}};
const databaseDriver={async execute(command){
  dbCalls.push(command);
  if(command.operation==='snapshot') return {
    status:'ok',snapshot_ref:command.snapshot_ref,evidence_ref:'evidence:synthetic-snapshot'
  };
  return {status:'ok',backup_id:command.backup_id,
    checksum_sha256:command.checksum_sha256,target_ref:command.target_ref,
    evidence_ref:'evidence:synthetic-restore'};
}};
const objectAdapter=new RecoveryObjectStorageAdapter(
  objectDriver,'controlbot:connection/recovery-primary');
const driveAdapter=new RecoveryGoogleDriveAdapter(
  driveDriver,'controlbot:connection/recovery-drive');
const databaseAdapter=new RecoveryDatabaseAdapter(
  databaseDriver,'controlbot:connection/recovery-db');
const first=await objectAdapter.execute('recovery.object-storage.upload',object);
const second=await driveAdapter.execute('recovery.google-drive.upload',drive);
const third=await databaseAdapter.execute('recovery.database.snapshot',snapshotDb);
const fourth=await databaseAdapter.execute('recovery.database.restore-disposable',restore('disposable'));
assert.equal(first.descriptor_id,object.descriptor_id);
assert.equal(first.immutable_version_ref,'version:synthetic-001');
assert.equal(second.descriptor_id,drive.descriptor_id);
assert.equal(second.remote_version_ref,'version:synthetic-drive');
assert.equal(third.snapshot_ref,snapshotDb.snapshot_ref);
assert.equal(fourth.operation,'restore_disposable');
assert.equal(fourth.target_ref,'target:synthetic-001');
assert.deepEqual([objectCalls.length,driveCalls.length,dbCalls.length],[1,1,2]);
for (const command of [...objectCalls,...driveCalls,...dbCalls]){
  assert.equal('authority' in command,false);
  assert.equal('execute' in command,false);
  assert.equal('token' in command,false);
  assert.equal('password' in command,false);
}
await assert.rejects(
  ()=>databaseAdapter.execute('recovery.database.restore-disposable',restore('production')),
  /disposable/
);
blocked.push('production-restore');
await assert.rejects(
  ()=>objectAdapter.execute('recovery.object-storage.upload',drive),
  /fuera de contrato/
);
blocked.push('cross-provider');
await assert.rejects(
  ()=>driveAdapter.execute('recovery.google-drive.upload',object),
  /fuera de contrato/
);
blocked.push('cross-capability');
assert.deepEqual([objectCalls.length,driveCalls.length,dbCalls.length],[1,1,2]);
for (const evidence of [first,second,third,fourth]){
  const serialized=JSON.stringify(evidence).toLowerCase();
  for (const forbidden of ['password','secret','private_key','token','dsn','sql','https://']){
    assert.equal(serialized.includes(forbidden),false,forbidden);
  }
}
const result={
  exercised:['RM-14','RT-05'],blocked:[...new Set(blocked)],
  admitted:approved.decision,authority:approved.authority,
  recovery_driver_calls:[objectCalls.length,driveCalls.length,dbCalls.length],
  operation: 'UNKNOWN',provenance:'synthetic-only',
  live:false,network:false,backups_real:false,authorization_real:false
};
process.stdout.write(JSON.stringify(result));
"""


def execute_real_ts() -> dict:
    node = shutil.which("node")
    if node is None:
        raise AssertionError("UNKNOWN: Node >=24 unavailable")
    env = {name: os.environ[name] for name in ("PATH", "LANG", "LC_ALL")
           if name in os.environ}
    result = subprocess.run(
        [node, "--experimental-strip-types", "--input-type=module", "-e", NODE],
        cwd=ROOT, env=env, capture_output=True, text=True,
        timeout=35, check=False,
    )
    if result.returncode:
        # Never echo stdout/stderr from an untrusted runtime into CI logs.
        raise AssertionError("UNKNOWN: real TypeScript offline contract failed")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError("UNKNOWN: invalid TypeScript evidence") from exc
    if not isinstance(value, dict):
        raise AssertionError("UNKNOWN: invalid evidence type")
    return value


class CoberturaFactoryrunner02Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.proof = execute_real_ts()

    def test_contrato_principal(self) -> None:
        """AC-01: call real TS modules for both B rows, never invent live."""
        self.assertEqual(set(DISPOSITION), {"RM-14", "RT-05"})
        self.assertEqual(set(self.proof["exercised"]), set(DISPOSITION))
        self.assertEqual(self.proof["admitted"], "ALLOW")
        self.assertEqual(self.proof["authority"], "unchanged")
        self.assertEqual(self.proof["recovery_driver_calls"], [1, 1, 2])
        for key, (kind, classification, reason) in DISPOSITION.items():
            with self.subTest(row=key):
                self.assertIn(kind, {"REAL", "OPERACIÓN"})
                self.assertEqual(classification, "B")
                self.assertTrue(reason)
        self.assertEqual(self.proof["operation"], UNKNOWN)
        self.assertFalse(self.proof["live"])

    def test_falla_cerrado(self) -> None:
        """AC-02: malformed authority, permissions and restore targets deny."""
        required = {
            "unregistered-capability", "identity-capability-drift",
            "tampered-manifest", "missing-identity", "missing-order",
            "missing-manifest", "missing-resource", "stale-resource",
            "forged-availability", "capacity-exhausted",
            "production-restore", "cross-provider", "cross-capability",
        }
        self.assertEqual(set(self.proof["blocked"]), required)
        self.assertEqual(self.proof["authority"], "unchanged")

    def test_sin_datos_reales(self) -> None:
        """AC-03: no network, production services, secrets or PII."""
        self.assertEqual(self.proof["operation"], UNKNOWN)
        self.assertEqual(self.proof["provenance"], "synthetic-only")
        for field in ("live", "network", "backups_real", "authorization_real"):
            self.assertFalse(self.proof[field])
        self.assertNotRegex(NODE, r"\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(")
        self.assertNotIn("from 'node:https'", NODE)
        self.assertNotRegex(NODE, r"-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----")
        self.assertNotIn("-----BEGIN " + "PRIVATE KEY-----", json.dumps(self.proof))
        self.assertEqual(set(self.proof["exercised"]), set(DISPOSITION))


if __name__ == "__main__":
    unittest.main()
