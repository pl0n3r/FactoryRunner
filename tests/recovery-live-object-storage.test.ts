import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { stableSha256 } from '../src/validation.ts';
import { RecoveryLiveObjectStorage, RecoveryLiveObjectStorageError } from '../src/recovery/live-object-storage.ts';

const body=new TextEncoder().encode('backup-real-bytes');
const digest=createHash('sha256').update(body).digest('hex');
function descriptor(operation:'upload'|'verify'|'materialize'){
  const base={version:1,project:'condor',provider:'object_storage',role:'primary_offsite',operation,namespace:'recovery:condor',object_ref:'backup:001',checksum_sha256:digest,idempotency_key:'backup:001',authority:'unchanged',execute:false};
  return {...base,descriptor_id:stableSha256(base)};
}
const env={FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ENDPOINT:'https://s3.example.com',FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_BUCKET:'condor-backups',FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_REGION:'us-east-1',FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_PREFIX:'recovery/condor',FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ACCESS_KEY_ID:'AKIATESTONLY',FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_SECRET_ACCESS_KEY:'not-a-real-secret',FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_AWS_SECURITY_TOKEN:'provider-temporary-credential'};
const source={async read(){return body;}}, written:Uint8Array[]=[];
const sink={async write(_ref:string,value:Uint8Array){written.push(value);}};
function response(method:string){return new Response(method==='GET'?body:null,{status:200,headers:{'x-amz-version-id':'v1','x-amz-meta-sha256':digest}});}

test('opaque alias resolves runtime config and secrets never enter request URL or result',async()=>{
  const seen:{url:string;authorization:string;securityToken:string}[]=[];
  const live=new RecoveryLiveObjectStorage({env,source,sink,clock:()=>new Date('2026-09-30T05:00:00Z'),transport:async(url,init)=>{const h=new Headers(init.headers);seen.push({url,authorization:h.get('authorization')??'',securityToken:h.get('x-amz-security-token')??''});return response(init.method??'GET');}});
  const result=await live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')});
  assert.match(result.immutable_version_ref,/^version:/); assert.equal(JSON.stringify(result).includes('AKIATESTONLY'),false); assert.equal(JSON.stringify(result).includes('provider-temporary-credential'),false);
  assert.equal(seen[0].url,'https://s3.example.com/condor-backups/recovery/condor/recovery%3Acondor/backup%3A001'); assert.equal(seen[0].authorization.includes('AKIATESTONLY'),true); assert.equal(seen[0].securityToken,'provider-temporary-credential');
});

test('upload verify and materialize preserve checksum and sanitized evidence',async()=>{
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:async(_u,i)=>response(i.method??'GET')});
  for(const operation of ['upload','verify','materialize'] as const){const r=await live.execute({capability:'recovery.object-storage.'+operation,connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor(operation)});assert.equal(r.checksum_sha256,digest);assert.match(r.evidence_ref,/^evidence:/);}
  assert.deepEqual(written[0],body);
});

test('inline secrets, signed URLs and arbitrary provider fields fail closed',async()=>{
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:async()=>response('PUT')});
  for(const extra of [{access_key:'x'},{secret:'x'},{signed_url:'https://x'}]) await assert.rejects(()=>live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload'),...extra}),RecoveryLiveObjectStorageError);
});

test('endpoint is alias-bound and SSRF-shaped runtime endpoints fail closed',async()=>{
  for(const endpoint of ['http://s3.example.com','https://127.0.0.1','https://localhost','https://s3.example.com/path','https://s3.example.com:8443']){const live=new RecoveryLiveObjectStorage({env:{...env,FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ENDPOINT:endpoint},source,sink});await assert.rejects(()=>live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);}
});

test('checksum mismatch and provider version absence fail closed generically',async()=>{
  const live=new RecoveryLiveObjectStorage({env,source:{async read(){return new TextEncoder().encode('tampered');}},sink,transport:async(_u,i)=>i.method==='HEAD'?new Response(null,{status:404}):response('PUT')});
  await assert.rejects(()=>live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')}),RecoveryLiveObjectStorageError);
  const noVersion=new RecoveryLiveObjectStorage({env,source,sink,transport:async()=>new Response(null,{status:200})});
  await assert.rejects(()=>noVersion.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);
});

test('repeated upload reuses matching immutable version and mismatched existing checksum fails closed',async()=>{
  let puts=0;
  const matching=new RecoveryLiveObjectStorage({env,source,sink,transport:async(_u,i)=>{if(i.method==='HEAD')return response('HEAD');puts+=1;return response('PUT');}});
  const input={capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')};
  assert.deepEqual(await matching.execute(input),await matching.execute(input)); assert.equal(puts,0);
  const mismatch=new RecoveryLiveObjectStorage({env,source,sink,transport:async()=>new Response(null,{status:200,headers:{'x-amz-version-id':'v-existing','x-amz-meta-sha256':'b'.repeat(64)}})});
  await assert.rejects(()=>mismatch.execute(input),RecoveryLiveObjectStorageError);
});

test('live caller preserves descriptor authority and excludes destructive operations',async()=>{
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:async(_u,i)=>response(i.method??'GET')});
  const unsafe=descriptor('upload') as Record<string,unknown>; unsafe.authority='expanded'; unsafe.descriptor_id=stableSha256(Object.fromEntries(Object.entries(unsafe).filter(([k])=>k!=='descriptor_id')));
  await assert.rejects(()=>live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:unsafe}),RecoveryLiveObjectStorageError);
  await assert.rejects(()=>live.execute({capability:'recovery.object-storage.delete',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')}),RecoveryLiveObjectStorageError);
});
