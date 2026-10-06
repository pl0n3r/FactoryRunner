import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "src/controlbot/http-session-evidence.ts"
LEDGER = ROOT / "src/controlbot/http-session-evidence-ledger.ts"
ERROR_FIELDS = {
    "version", "outcome", "evidence_fingerprint", "authority",
    "execution", "network_access", "external_mutation",
}


class FactoryRunnerControlBotHttpSessionAbortEvidenceTests(unittest.TestCase):
    @staticmethod
    def _node(script):
        completed = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
            cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
        )
        if completed.returncode:
            raise AssertionError(
                f"node exit {completed.returncode}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        return json.loads(completed.stdout)

    def test_transport_aborted_evidence_contains_only_path_request_fingerprint_outcome_and_safety(self):
        result = self._node("""
import { httpSessionAbortEvidence } from './src/controlbot/http-session-evidence.ts';
const e = httpSessionAbortEvidence({path:'/v1/runner/poll', request_fingerprint:'a'.repeat(64)});
console.log(JSON.stringify({e, frozen:Object.isFrozen(e), bytes:new TextEncoder().encode(JSON.stringify(e)).byteLength}));
""")
        e = result["e"]
        self.assertEqual(
            set(e),
            {"version", "outcome", "path", "request_fingerprint", "evidence_fingerprint",
             "authority", "execution", "network_access", "external_mutation"},
        )
        self.assertEqual((e["version"], e["outcome"], e["path"]), (2, "transport_aborted", "/v1/runner/poll"))
        self.assertEqual(e["request_fingerprint"], "a" * 64)
        self.assertRegex(e["evidence_fingerprint"], r"^[0-9a-f]{64}$")
        self.assertIs(result["frozen"], True)
        self.assertLessEqual(result["bytes"], 1024)
        self.assertEqual(
            (e["authority"], e["execution"], e["network_access"], e["external_mutation"]),
            ("unchanged", False, False, False),
        )
        for forbidden in ("body", "payload", "reason", "signal", "authorization", "bearer", "secret", "token"):
            self.assertNotIn(forbidden, json.dumps(e).lower())

    def test_hardened_ledger_accepts_abort_without_relaxing_historical_error_shapes(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionAbortEvidence, httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
const legacy=['client_disabled','transport_timeout','transport_failed']
  .map(code => httpSessionEvidence(new HttpSessionClientError(code)));
const abort=httpSessionAbortEvidence({path:'/v1/runner/event',request_fingerprint:'b'.repeat(64)});
const ledger=new HttpSessionEvidenceLedger();
[legacy[0],abort,legacy[1],legacy[2]].forEach((e,i)=>ledger.append(i+1,e));
console.log(JSON.stringify({legacy,abort,snapshot:ledger.snapshot()}));
""")
        self.assertEqual([x["outcome"] for x in result["legacy"]], ["client_disabled", "transport_timeout", "transport_failed"])
        for item in result["legacy"]:
            self.assertEqual(item["version"], 1)
            self.assertEqual(set(item), ERROR_FIELDS)
        self.assertEqual((result["abort"]["version"], result["abort"]["outcome"]), (2, "transport_aborted"))
        self.assertEqual(
            [x["evidence"]["outcome"] for x in result["snapshot"]["entries"]],
            ["client_disabled", "transport_aborted", "transport_timeout", "transport_failed"],
        )

    def test_missing_mixed_or_spoofed_abort_fingerprint_fails_closed(self):
        result = self._node("""
import { httpSessionAbortEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
const failed=fn=>{try{fn();return false}catch{return true}};
const canonical=httpSessionAbortEvidence({path:'/v1/runner/ack',request_fingerprint:'c'.repeat(64)});
const missing={...canonical}; delete missing.request_fingerprint;
const cases={
  factory_missing:()=>httpSessionAbortEvidence({request_fingerprint:'c'.repeat(64)}),
  factory_extra:()=>httpSessionAbortEvidence({path:'/v1/runner/ack',request_fingerprint:'c'.repeat(64),reason:'secret'}),
  factory_bad_path:()=>httpSessionAbortEvidence({path:'/v1/runner/not-real',request_fingerprint:'c'.repeat(64)}),
  factory_bad_hash:()=>httpSessionAbortEvidence({path:'/v1/runner/ack',request_fingerprint:'bad'}),
  ledger_missing:()=>new HttpSessionEvidenceLedger().append(1,missing),
  ledger_spoofed_request:()=>new HttpSessionEvidenceLedger().append(1,{...canonical,request_fingerprint:'d'.repeat(64)}),
  ledger_spoofed_evidence:()=>new HttpSessionEvidenceLedger().append(1,{...canonical,evidence_fingerprint:'0'.repeat(64)}),
  ledger_mixed:()=>new HttpSessionEvidenceLedger().append(1,{...canonical,body:{token:'raw'}}),
};
console.log(JSON.stringify(Object.fromEntries(Object.entries(cases).map(([k,v])=>[k,failed(v)]))));
""")
        self.assertTrue(all(result.values()), result)

    def test_abort_evidence_and_ledger_are_bounded_deterministic_secret_free_and_non_executing(self):
        result = self._node("""
import { httpSessionAbortEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
const input=Object.freeze({path:'/v1/runner/heartbeat',request_fingerprint:'e'.repeat(64)});
const a=httpSessionAbortEvidence(input), b=httpSessionAbortEvidence(input);
const ledger=new HttpSessionEvidenceLedger(); ledger.append(1,a);
const s1=ledger.snapshot(), s2=ledger.snapshot();
console.log(JSON.stringify({
  e:a, sameE:JSON.stringify(a)===JSON.stringify(b), sameS:JSON.stringify(s1)===JSON.stringify(s2),
  frozen:Object.isFrozen(a)&&Object.isFrozen(s1)&&Object.isFrozen(s1.entries),
  eb:new TextEncoder().encode(JSON.stringify(a)).byteLength,
  sb:new TextEncoder().encode(JSON.stringify(s1)).byteLength,
}));
""")
        self.assertTrue(result["sameE"] and result["sameS"] and result["frozen"])
        self.assertLessEqual(result["eb"], 1024)
        self.assertLessEqual(result["sb"], 128 * 1024)
        self.assertEqual(
            (result["e"]["authority"], result["e"]["execution"], result["e"]["network_access"], result["e"]["external_mutation"]),
            ("unchanged", False, False, False),
        )
        lowered = (EVIDENCE.read_text() + LEDGER.read_text()).lower()
        for forbidden in ("node:http", "node:https", "fetch(", "axios", "process.env", "writefile", "appendfile", "readfile"):
            self.assertNotIn(forbidden, lowered)

    def test_existing_v1_evidence_and_single_read_ledger_contracts_remain_unchanged(self):
        result = self._node("""
import { HttpSessionClientError } from './src/controlbot/http-session-client.ts';
import { httpSessionAbortEvidence, httpSessionEvidence } from './src/controlbot/http-session-evidence.ts';
import { HttpSessionEvidenceLedger } from './src/controlbot/http-session-evidence-ledger.ts';
import { stableSha256 } from './src/validation.ts';
const body={accepted:true};
const success=httpSessionEvidence({
  version:1,path:'/v1/runner/poll',status:200,request_fingerprint:'f'.repeat(64),
  response_fingerprint:stableSha256(body),body,transport_mode:'injected_test_only',
  authority:'unchanged',execution:false,network_access:false,external_mutation:false,
});
const errors=['client_disabled','transport_timeout','transport_failed']
  .map(code=>httpSessionEvidence(new HttpSessionClientError(code)));
const canonical=httpSessionAbortEvidence({path:'/v1/runner/poll',request_fingerprint:'1'.repeat(64)});
const dynamic={...canonical}, reads={};
const next={
  outcome:['transport_aborted','http_success'], path:['/v1/runner/poll','bad'],
  request_fingerprint:['1'.repeat(64),'2'.repeat(64)], authority:['unchanged','expanded'],
  execution:[false,true], network_access:[false,true], external_mutation:[false,true],
  evidence_fingerprint:[canonical.evidence_fingerprint,'0'.repeat(64)],
};
for(const [key,values] of Object.entries(next)){
  reads[key]=0;
  Object.defineProperty(dynamic,key,{enumerable:true,configurable:true,get(){reads[key]+=1;return values[reads[key]===1?0:1]}});
}
const ledger=new HttpSessionEvidenceLedger();
const abort=ledger.append(1,dynamic).evidence;
console.log(JSON.stringify({success,errors,reads,abort}));
""")
        self.assertEqual(result["success"]["version"], 1)
        self.assertEqual(
            set(result["success"]),
            {"version", "outcome", "path", "status", "request_fingerprint", "response_fingerprint",
             "evidence_fingerprint", "authority", "execution", "network_access", "external_mutation"},
        )
        for item in result["errors"]:
            self.assertEqual(item["version"], 1)
            self.assertEqual(set(item), ERROR_FIELDS)
        self.assertEqual([x["outcome"] for x in result["errors"]], ["client_disabled", "transport_timeout", "transport_failed"])
        self.assertEqual(set(result["reads"].values()), {1})
        self.assertEqual(
            (result["abort"]["version"], result["abort"]["outcome"], result["abort"]["path"], result["abort"]["request_fingerprint"]),
            (2, "transport_aborted", "/v1/runner/poll", "1" * 64),
        )


if __name__ == "__main__":
    unittest.main()
