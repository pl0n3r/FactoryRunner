import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { stableSha256 } from '../src/validation.ts';
import { RecoveryLiveObjectStorage, RecoveryLiveObjectStorageError } from '../src/recovery/live-object-storage.ts';
import type { RecoveryS3Transport } from '../src/recovery/s3-compatible-driver.ts';

const accountId='a'.repeat(32);
const env={
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_PROVIDER:'r2_bucket_lock',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ENDPOINT:'https://'+accountId+'.r2.cloudflarestorage.com',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_BUCKET:'condor-backups',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_REGION:'auto',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_PREFIX:'recovery/condor',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_OBJECT_LOCK_DAYS:'30',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ACCESS_KEY_ID:'AKIATESTONLY',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_SECRET_ACCESS_KEY:'test-secret-not-real',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_R2_ACCOUNT_ID:accountId,
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_R2_API_TOKEN:'test-token-not-a-real-secret',
};
const bytes=new TextEncoder().encode('test-backup');
const digest=createHash('sha256').update(bytes).digest('hex');
function descriptor(operation:'upload'|'verify'|'materialize'){
  const value={version:1,project:'condor',provider:'object_storage',role:'primary_offsite',
    operation,namespace:'recovery:condor',object_ref:'backup:001',checksum_sha256:digest,
    idempotency_key:'backup:001',authority:'unchanged',execute:false};
  return {...value,descriptor_id:stableSha256(value)};
}
function rule(condition:Record<string,unknown>={type:'Age',maxAgeSeconds:31*86400}){
  return {id:'r2-recovery',enabled:true,prefix:'recovery/condor/',condition};
}
function mock(options:{
  rules?:unknown[];overwriteAllowed?:boolean;deleteAllowed?:boolean;
}={}):{transport:RecoveryS3Transport;calls:string[]}{
  const calls:string[]=[];
  const stored=new Map<string,{body:Uint8Array;meta:string}>();
  const transport:RecoveryS3Transport=async(url,init)=>{
    const method=init.method??'GET';
    calls.push(method+' '+url);
    if(url.startsWith('https://api.cloudflare.com/')){
      assert.equal(method,'GET');
      assert.match(new Headers(init.headers).get('authorization')??'',/^Bearer test-token/);
      return Response.json({success:true,result:{rules:options.rules??[rule()]}});
    }
    const path=new URL(url).pathname;
    const isProbe=path.includes('__r2_lock_probe_');
    const current=stored.get(path);
    if(method==='PUT'){
      if(isProbe&&current&&!options.overwriteAllowed) return new Response(null,{status:403});
      const body=new Uint8Array(init.body as Uint8Array);
      stored.set(path,{body,meta:new Headers(init.headers).get('x-amz-meta-sha256')??''});
      return new Response(null,{status:200});
    }
    if(method==='DELETE'){
      if(isProbe&&current&&!options.deleteAllowed) return new Response(null,{status:403});
      stored.delete(path);
      return new Response(null,{status:204});
    }
    if(!current) return new Response(null,{status:404});
    const headers={etag:'"0123456789abcdef0123456789abcdef"','x-amz-meta-sha256':current.meta};
    return new Response(method==='GET'?Buffer.from(current.body):null,{status:200,headers});
  };
  return {transport,calls};
}
function live(transport:RecoveryS3Transport,envOverride:NodeJS.ProcessEnv=env){
  return new RecoveryLiveObjectStorage({env:envOverride,transport,
    source:{async read(){return bytes;}},sink:{async write(_ref,value){assert.deepEqual(value,bytes);}},
    clock:()=>new Date('2026-11-22T06:00:00Z')});
}
function input(operation:'upload'|'verify'|'materialize'='upload'){
  return {capability:'recovery.object-storage.'+operation,
    connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor(operation)};
}

test('valid R2 bucket lock stores sanitized provider-distinct evidence without S3 object lock',async()=>{
  const {transport,calls}=mock();
  const result=await live(transport).execute(input());
  assert.match(result.immutable_version_ref,/^r2_bucket_lock:[a-f0-9]{32}$/);
  assert.equal(result.checksum_sha256,digest);
  assert.equal(JSON.stringify(result).includes(accountId),false);
  assert.equal(JSON.stringify(result).includes('test-token'),false);
  assert.ok(calls.some(call=>call.startsWith('DELETE ')&&call.includes('__r2_lock_probe_')));
  assert.ok(!calls.some(call=>call.includes('object-lock=')||call.includes('versioning=')));
  assert.ok(!calls.some(call=>call.startsWith('DELETE ')&&!call.includes('__r2_lock_probe_')));
});

test('missing, disabled, short or wrong-prefix lock rules fail closed before object writes',async()=>{
  const variants=[
    [],[rule({type:'Age',maxAgeSeconds:29*86400})],
    [{...rule(),enabled:false}],
    [{...rule(),prefix:'another-prefix/'}],
    [rule({type:'Date',date:'2026-11-24T00:00:00Z'})],
  ];
  for(const rules of variants){
    const {transport,calls}=mock({rules});
    await assert.rejects(()=>live(transport).execute(input()),RecoveryLiveObjectStorageError);
    assert.equal(calls.filter(call=>call.startsWith('PUT ')).length,0);
  }
});

test('allowed overwrite or delete of synthetic probe fails closed without deleting backup',async()=>{
  for(const options of [{overwriteAllowed:true},{deleteAllowed:true}]){
    const {transport,calls}=mock(options);
    await assert.rejects(()=>live(transport).execute(input()),RecoveryLiveObjectStorageError);
    assert.ok(calls.every(call=>!call.startsWith('DELETE ')||call.includes('__r2_lock_probe_')));
    assert.ok(!calls.some(call=>call.startsWith('PUT ')&&!call.includes('__r2_lock_probe_')));
  }
});

test('indefinite and sufficiently future Date rules are supported',async()=>{
  for(const condition of [{type:'Indefinite'},{type:'Date',date:'2027-12-31T00:00:00Z'}]){
    const {transport}=mock({rules:[rule(condition)]});
    const result=await live(transport).execute(input());
    assert.match(result.immutable_version_ref,/^r2_bucket_lock:/);
  }
});

test('unknown provider, mismatched API account and missing credentials fail closed',async()=>{
  for(const extras of [
    {FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_PROVIDER:'unknown'},
    {FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_R2_ACCOUNT_ID:'b'.repeat(32)},
    {FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_R2_API_TOKEN:''},
  ]){
    const {transport,calls}=mock();
    await assert.rejects(()=>live(transport,{...env,...extras}).execute(input()),RecoveryLiveObjectStorageError);
    assert.equal(calls.length,0);
  }
});

test('S3 default profile continues requiring COMPLIANCE per object',async()=>{
  const legacy={...env,
    FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_PROVIDER:undefined,
    FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ENDPOINT:'https://s3.example.com',
    FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_REGION:'us-east-1'};
  const transport:RecoveryS3Transport=async(url)=>{
    if(url.endsWith('?versioning=')) return new Response('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>');
    if(url.endsWith('?object-lock=')) return new Response('<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>');
    return new Response(null,{status:200,headers:{'x-amz-version-id':'version-1','x-amz-meta-sha256':digest}});
  };
  await assert.rejects(()=>live(transport,legacy).execute(input('verify')),RecoveryLiveObjectStorageError);
});
