"""Acceptance for offline recovery handoff manifest verification."""
from __future__ import annotations

import subprocess
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "src" / "execution-recovery-handoff-manifest-verify.ts"

COMMON = r"""
import assert from 'node:assert/strict';
import { executionRecoveryHandoffPacket as packet } from './src/execution-recovery-handoff-packet.ts';
import { executionRecoveryHandoffVerify as handoffVerify } from './src/execution-recovery-handoff-verify.ts';
import { executionRecoveryHandoffPreview as preview } from './src/execution-recovery-handoff-preview.ts';
import { executionRecoveryHandoffManifest as manifest } from './src/execution-recovery-handoff-manifest.ts';
import { executionRecoveryHandoffManifestVerify as verify } from './src/execution-recovery-handoff-manifest-verify.ts';
import { stableSha256 as hash } from './src/validation.ts';

const eid='execution:recovery:handoff:alpha', snap='a'.repeat(64), plan='b'.repeat(64);
const readyCore={version:1,authority:'unchanged',ready:true,reason:'ready',snapshot_fingerprint:snap,plan_fingerprint:plan,execution:false,network_access:false,external_mutation:false,counts:{orders:1,noop:1,redeliver:0,resume:0,block:0}};
const ready=()=>({...readyCore,fingerprint:hash(readyCore)});
function build(id=eid,r=ready()){
  const p=packet(id,r,snap,plan), v=handoffVerify(p,id,r,snap,plan), w=preview(p,id,r,snap,plan);
  return {r,p,v,w,m:manifest(p,v,w,id,r,snap,plan)};
}
const call=(e,r=ready())=>verify(e.m,e.p,e.v,e.w,eid,r,snap,plan);
"""


def run_node(script: str) -> None:
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "--eval", textwrap.dedent(script)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    if result.returncode:
        raise AssertionError(result.stdout + result.stderr)


class FactoryRunnerExecutionRecoveryHandoffManifestVerifyTests(unittest.TestCase):
    def test_verifier_accepts_only_exact_manifest_and_bound_handoff_evidence(self) -> None:
        run_node(COMMON + r"""
        const e=build(), a=call(e), b=call(e);
        assert.deepEqual(a,b);
        assert.deepEqual({
          version:a.version,authority:a.authority,verified:a.verified,execution_id:a.execution_id,
          manifest:a.manifest_fingerprint,packet:a.packet_fingerprint,
          verification:a.verification_fingerprint,preview:a.preview_fingerprint,
          execution:a.execution,network:a.network_access,mutation:a.external_mutation,
        },{
          version:1,authority:'unchanged',verified:true,execution_id:eid,
          manifest:e.m.fingerprint,packet:e.p.fingerprint,
          verification:e.v.fingerprint,preview:e.w.fingerprint,
          execution:false,network:false,mutation:false,
        });
        assert.match(a.fingerprint,/^[0-9a-f]{64}$/);
        """)

    def test_tampered_mixed_stale_or_unknown_manifest_fails_closed_without_effects(self) -> None:
        source = SOURCE.read_text(encoding="utf-8")
        for forbidden in ("node:fs","node:http","node:https","node:child_process","fetch(","spawn(","writeFile","ControlBotClient","BrowserExecutionAdapter"):
            self.assertNotIn(forbidden, source)

        run_node(COMMON + r"""
        globalThis.fetch=()=>{throw new Error('network attempted')};
        const e=build(), wrong=build('execution:recovery:handoff:beta');
        for(const bad of [
          {...e.m,fingerprint:'0'.repeat(64)},
          {...e.m,unexpected:true},
          {...e.m,authority:'elevated'},
          {...e.m,execution:true},
        ]) assert.throws(()=>verify(bad,e.p,e.v,e.w,eid,e.r,snap,plan));
        assert.throws(()=>verify(e.m,wrong.p,wrong.v,wrong.w,eid,e.r,snap,plan));
        assert.throws(()=>verify(e.m,e.p,wrong.v,e.w,eid,e.r,snap,plan));
        assert.throws(()=>verify(e.m,e.p,e.v,wrong.w,eid,e.r,snap,plan));
        const stale={...e.r,fingerprint:'f'.repeat(64)};
        assert.throws(()=>call(e,stale));
        assert.throws(()=>verify(e.m,e.p,e.v,e.w,eid,e.r,'c'.repeat(64),plan));
        """)


if __name__ == "__main__":
    unittest.main()
