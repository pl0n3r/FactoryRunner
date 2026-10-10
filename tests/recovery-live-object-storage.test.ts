import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { stableSha256 } from '../src/validation.ts';
import { RecoveryLiveObjectStorage, RecoveryLiveObjectStorageError } from '../src/recovery/live-object-storage.ts';
import { S3CompatibleRecoveryDriver } from '../src/recovery/s3-compatible-driver.ts';
import type { RecoveryS3Transport } from '../src/recovery/s3-compatible-driver.ts';

const body=new TextEncoder().encode('backup-real-bytes');
const digest=createHash('sha256').update(body).digest('hex');
function descriptor(operation:'upload'|'verify'|'materialize'){
  const base={version:1,project:'condor',provider:'object_storage',role:'primary_offsite',operation,namespace:'recovery:condor',object_ref:'backup:001',checksum_sha256:digest,idempotency_key:'backup:001',authority:'unchanged',execute:false};
  return {...base,descriptor_id:stableSha256(base)};
}
const env={
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ENDPOINT:'https://s3.example.com',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_BUCKET:'condor-backups',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_REGION:'us-east-1',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_PREFIX:'recovery/condor',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_OBJECT_LOCK_DAYS:'30',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ACCESS_KEY_ID:'AKIATESTONLY',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_SECRET_ACCESS_KEY:'not-a-real-secret',
  FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_AWS_SECURITY_TOKEN:'provider-temporary-credential',
};
const config={
  alias:'controlbot:connection/recovery-primary',
  endpoint:'https://s3.example.com',
  bucket:'condor-backups',
  region:'us-east-1',
  prefix:'recovery/condor',
  objectLockDays:30,
  accessKeyId:'AKIATESTONLY',
  secretAccessKey:'not-a-real-secret',
  awsSecurityToken:'provider-temporary-credential',
};
const source={async read(){return body;}}, written:Uint8Array[]=[];
const sink={async write(_ref:string,value:Uint8Array){written.push(value);}};
const futureRetention='2099-12-31T23:59:59.000Z';
const versioningXml='<?xml version="1.0"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>';
const objectLockXml='<?xml version="1.0"?><ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>';

function preflightResponse(url:string):Response|null{
  if(url.endsWith('?versioning=')) return new Response(versioningXml,{status:200});
  if(url.endsWith('?object-lock=')) return new Response(objectLockXml,{status:200});
  return null;
}
function withPreflight(handler:RecoveryS3Transport):RecoveryS3Transport{
  return async(url,init)=>preflightResponse(url)??handler(url,init);
}
function response(method:string,headers:Record<string,string>={}){
  return new Response(method==='GET'?body:null,{status:200,headers:{
    'x-amz-version-id':'v1',
    'x-amz-meta-sha256':digest,
    'x-amz-object-lock-mode':'COMPLIANCE',
    'x-amz-object-lock-retain-until-date':futureRetention,
    ...headers,
  }});
}

test('opaque alias resolves runtime config and secrets never enter request URL or result',async()=>{
  const seen:{url:string;authorization:string;securityToken:string}[]=[];
  const live=new RecoveryLiveObjectStorage({env,source,sink,clock:()=>new Date('2026-09-30T05:00:00Z'),transport:withPreflight(async(url,init)=>{const h=new Headers(init.headers);seen.push({url,authorization:h.get('authorization')??'',securityToken:h.get('x-amz-security-token')??''});return response(init.method??'GET');})});
  const result=await live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')});
  assert.match(result.immutable_version_ref,/^version:/); assert.equal(JSON.stringify(result).includes('AKIATESTONLY'),false); assert.equal(JSON.stringify(result).includes('provider-temporary-credential'),false);
  assert.equal(seen[0].url,'https://s3.example.com/condor-backups/recovery/condor/recovery%3Acondor/backup%3A001'); assert.equal(seen[0].authorization.includes('AKIATESTONLY'),true); assert.equal(seen[0].securityToken,'provider-temporary-credential');
});

test('upload verify and materialize preserve checksum and sanitized evidence',async()=>{
  written.length=0;
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:withPreflight(async(_u,i)=>response(i.method??'GET'))});
  for(const operation of ['upload','verify','materialize'] as const){
    const r=await live.execute({capability:'recovery.object-storage.'+operation,connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor(operation)});
    assert.equal(r.checksum_sha256,digest);assert.match(r.evidence_ref,/^evidence:/);
  }
  assert.deepEqual(written[0],body);
});

test('inline secrets, signed URLs and arbitrary provider fields fail closed',async()=>{
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:withPreflight(async()=>response('PUT'))});
  for(const extra of [{access_key:'x'},{secret:'x'},{signed_url:'https://x'}]) await assert.rejects(()=>live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload'),...extra}),RecoveryLiveObjectStorageError);
});

test('endpoint is alias-bound and SSRF-shaped runtime endpoints fail closed',async()=>{
  for(const endpoint of ['http://s3.example.com','https://127.0.0.1','https://localhost','https://s3.example.com/path','https://s3.example.com:8443']){
    const live=new RecoveryLiveObjectStorage({env:{...env,FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_ENDPOINT:endpoint},source,sink});
    await assert.rejects(()=>live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);
  }
});

test('checksum mismatch and provider version absence fail closed generically',async()=>{
  const live=new RecoveryLiveObjectStorage({env,source:{async read(){return new TextEncoder().encode('tampered');}},sink,transport:withPreflight(async(_u,i)=>i.method==='HEAD'?new Response(null,{status:404}):response('PUT'))});
  await assert.rejects(()=>live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')}),RecoveryLiveObjectStorageError);
  const noVersion=new RecoveryLiveObjectStorage({env,source,sink,transport:withPreflight(async()=>new Response(null,{status:200,headers:{'x-amz-meta-sha256':digest,'x-amz-object-lock-mode':'COMPLIANCE','x-amz-object-lock-retain-until-date':futureRetention}}))});
  await assert.rejects(()=>noVersion.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);
});

test('repeated upload reuses matching immutable version and mismatched existing checksum fails closed',async()=>{
  let puts=0;
  const matching=new RecoveryLiveObjectStorage({env,source,sink,transport:withPreflight(async(_u,i)=>{if(i.method==='HEAD')return response('HEAD');puts+=1;return response('PUT');})});
  const input={capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')};
  assert.deepEqual(await matching.execute(input),await matching.execute(input)); assert.equal(puts,0);
  const mismatch=new RecoveryLiveObjectStorage({env,source,sink,transport:withPreflight(async()=>response('HEAD',{'x-amz-version-id':'v-existing','x-amz-meta-sha256':'b'.repeat(64)}))});
  await assert.rejects(()=>mismatch.execute(input),RecoveryLiveObjectStorageError);
});

test('live caller preserves descriptor authority and excludes destructive operations',async()=>{
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:withPreflight(async(_u,i)=>response(i.method??'GET'))});
  const unsafe=descriptor('upload') as Record<string,unknown>;
  unsafe.authority='expanded';
  unsafe.descriptor_id=stableSha256(Object.fromEntries(Object.entries(unsafe).filter(([k])=>k!=='descriptor_id')));
  await assert.rejects(()=>live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:unsafe}),RecoveryLiveObjectStorageError);
  await assert.rejects(()=>live.execute({capability:'recovery.object-storage.delete',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')}),RecoveryLiveObjectStorageError);
});

test('version without Object Lock compliance fails closed',async()=>{
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:withPreflight(async()=>new Response(null,{status:200,headers:{'x-amz-version-id':'v1','x-amz-meta-sha256':digest}}))});
  await assert.rejects(()=>live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);
});

test('upload requests COMPLIANCE retention and verifies immutable HEAD before success',async()=>{
  const calls:string[]=[];
  let requestedRetention='';
  const live=new RecoveryLiveObjectStorage({
    env,source,sink,clock:()=>new Date('2026-09-30T05:00:00Z'),
    transport:withPreflight(async(_url,init)=>{
      const method=init.method??'GET'; calls.push(method);
      if(method==='HEAD'&&calls.length===1) return new Response(null,{status:404});
      if(method==='PUT'){
        const headers=new Headers(init.headers);
        assert.equal(headers.get('x-amz-object-lock-mode'),'COMPLIANCE');
        requestedRetention=headers.get('x-amz-object-lock-retain-until-date')??'';
        assert.equal(requestedRetention,'2026-10-30T05:00:00.000Z');
        return new Response(null,{status:200,headers:{'x-amz-version-id':'v-new'}});
      }
      return response('HEAD',{'x-amz-version-id':'v-new','x-amz-object-lock-retain-until-date':requestedRetention});
    }),
  });
  const result=await live.execute({capability:'recovery.object-storage.upload',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('upload')});
  assert.deepEqual(calls,['HEAD','PUT','HEAD']); assert.match(result.immutable_version_ref,/^version:/);
});

test('verify requires checksum version compliance and future retention',async()=>{
  const now=()=>new Date('2026-09-30T05:00:00Z');
  const variants:Record<string,string>[]=[
    {'x-amz-meta-sha256':'b'.repeat(64)},
    {'x-amz-version-id':''},
    {'x-amz-object-lock-mode':'GOVERNANCE'},
    {'x-amz-object-lock-retain-until-date':'2026-09-30T04:59:59.000Z'},
  ];
  for(const headers of variants){
    const live=new RecoveryLiveObjectStorage({env,source,sink,clock:now,transport:withPreflight(async()=>response('HEAD',headers))});
    await assert.rejects(()=>live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);
  }
});

test('materialize requires GET to match the immutable HEAD version and checksum',async()=>{
  const writes:Uint8Array[]=[];
  const localSink={async write(_ref:string,value:Uint8Array){writes.push(value);}};
  let calls=0;
  const live=new RecoveryLiveObjectStorage({env,source,sink:localSink,transport:withPreflight(async(_url,init)=>{
    calls+=1;
    if(init.method==='HEAD') return response('HEAD',{'x-amz-version-id':'v1'});
    return response('GET',{'x-amz-version-id':'v2'});
  })});
  await assert.rejects(()=>live.execute({capability:'recovery.object-storage.materialize',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('materialize')}),RecoveryLiveObjectStorageError);
  assert.equal(calls,2); assert.equal(writes.length,0);
});

test('invalid or expired Object Lock configuration is a generic failure',async()=>{
  for(const days of ['0','3651','abc']){
    const live=new RecoveryLiveObjectStorage({env:{...env,FACTORYRUNNER_CONNECTION_RECOVERY_PRIMARY_OBJECT_LOCK_DAYS:days},source,sink,transport:withPreflight(async()=>response('HEAD'))});
    await assert.rejects(()=>live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);
  }
  const expired=new RecoveryLiveObjectStorage({env,source,sink,clock:()=>new Date('2026-09-30T05:00:00Z'),transport:withPreflight(async()=>response('HEAD',{'x-amz-object-lock-retain-until-date':'2026-09-30T04:00:00.000Z'}))});
  await assert.rejects(()=>expired.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),error=>error instanceof RecoveryLiveObjectStorageError&&error.message==='recovery_live_object_storage_failed');
});

test('enabled versioning and Object Lock allow object operation',async()=>{
  const urls:string[]=[];
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:async(url,init)=>{
    urls.push(url);
    return preflightResponse(url)??response(init.method??'GET');
  }});
  const result=await live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')});
  assert.match(result.immutable_version_ref,/^version:/);
  assert.equal(urls[0],'https://s3.example.com/condor-backups?versioning=');
  assert.equal(urls[1],'https://s3.example.com/condor-backups?object-lock=');
});

test('missing suspended or unknown versioning fails closed before object operation',async()=>{
  for(const xml of [
    '',
    '<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>',
    '<VersioningConfiguration><Status>Other</Status></VersioningConfiguration>',
  ]){
    let objectCalls=0;
    const live=new RecoveryLiveObjectStorage({env,source,sink,transport:async(url,init)=>{
      if(url.endsWith('?versioning=')) return new Response(xml,{status:200});
      if(url.endsWith('?object-lock=')) return new Response(objectLockXml,{status:200});
      objectCalls+=1;
      return response(init.method??'GET');
    }});
    await assert.rejects(()=>live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);
    assert.equal(objectCalls,0);
  }
});

test('missing disabled or unknown Object Lock fails closed before object operation',async()=>{
  for(const xml of [
    '',
    '<ObjectLockConfiguration><ObjectLockEnabled>Disabled</ObjectLockEnabled></ObjectLockConfiguration>',
    '<ObjectLockConfiguration><ObjectLockEnabled>Other</ObjectLockEnabled></ObjectLockConfiguration>',
  ]){
    let objectCalls=0;
    const live=new RecoveryLiveObjectStorage({env,source,sink,transport:async(url,init)=>{
      if(url.endsWith('?versioning=')) return new Response(versioningXml,{status:200});
      if(url.endsWith('?object-lock=')) return new Response(xml,{status:200});
      objectCalls+=1;
      return response(init.method??'GET');
    }});
    await assert.rejects(()=>live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),RecoveryLiveObjectStorageError);
    assert.equal(objectCalls,0);
  }
});

test('invalid XML HTTP errors and unsupported provider are generic failures',async()=>{
  const transports:RecoveryS3Transport[]=[
    async(url)=>url.endsWith('?versioning=')
      ?new Response('<VersioningConfiguration><Status>Enabled</Status>',{status:200})
      :new Response(objectLockXml,{status:200}),
    async()=>new Response('denied',{status:403}),
    async()=>new Response('unsupported',{status:501}),
  ];
  for(const transport of transports){
    const live=new RecoveryLiveObjectStorage({env,source,sink,transport});
    await assert.rejects(()=>live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')}),error=>error instanceof RecoveryLiveObjectStorageError&&error.message==='recovery_live_object_storage_failed');
  }
});

async function assertRejectedBucketXml(
  route:'versioning'|'object-lock', cases:readonly string[],
):Promise<void>{
  for(const xml of cases){
    let objectCalls=0;
    const live=new RecoveryLiveObjectStorage({env,source,sink,transport:async(url,init)=>{
      if(url.endsWith('?'+route+'=')) return new Response(xml,{status:200});
      const preflight=preflightResponse(url);
      if(preflight!==null) return preflight;
      objectCalls++;
      return response(init.method??'GET');
    }});
    await assert.rejects(()=>live.execute({
      capability:'recovery.object-storage.verify',
      connection_ref:'controlbot:connection/recovery-primary',
      descriptor:descriptor('verify'),
    }),RecoveryLiveObjectStorageError);
    assert.equal(objectCalls,0);
  }
}

test('nested Status under unknown element fails versioning before object operation',async()=>{
  await assertRejectedBucketXml('versioning',[
    '<VersioningConfiguration><Bogus><Status>Enabled</Status></Bogus></VersioningConfiguration>',
    '<VersioningConfiguration>ROOT_TEXT_INVALID<Status>Enabled</Status></VersioningConfiguration>',
    '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration><VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
    '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration><Outside/>',
    '<VersioningConfiguration><Status>Enabled</Status><Bogus></VersioningConfiguration>',
    '<VersioningConfiguration bogus><Status>Enabled</Status></VersioningConfiguration>',
    '<VersioningConfiguration xmlns=unquoted><Status>Enabled</Status></VersioningConfiguration>',
    '<VersioningConfiguration xmlns="unterminated><Status>Enabled</Status></VersioningConfiguration>',
    '<VersioningConfiguration xmlns="a" xmlns="b"><Status>Enabled</Status></VersioningConfiguration>',
    '<?xml bogus?><VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
    '<?xmlversion="1.0"?><VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
    '<?xmlversion="1.1"?><VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
    '<?xml encoding="UTF-8"?><VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
  ]);
});

test('nested ObjectLockEnabled under unknown element fails before object operation',async()=>{
  await assertRejectedBucketXml('object-lock',[
    '<ObjectLockConfiguration><Bogus><ObjectLockEnabled>Enabled</ObjectLockEnabled></Bogus></ObjectLockConfiguration>',
    '<ObjectLockConfiguration>ROOT_TEXT_INVALID<ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
    '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration><ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
    '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration><Outside/>',
    '<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled><Bogus></ObjectLockConfiguration>',
    '<ObjectLockConfiguration bogus><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
    '<ObjectLockConfiguration xmlns=unquoted><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>',
  ]);
});

test('direct S3 control fields with nested retention siblings remain valid',async()=>{
  const versioning='<?xml version="1.0" encoding="UTF-8"?><VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status><MfaDelete>Disabled</MfaDelete></VersioningConfiguration>';
  const objectLock='<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>30</Days></DefaultRetention></Rule></ObjectLockConfiguration>';
  let objectCalls=0;
  const live=new RecoveryLiveObjectStorage({env,source,sink,transport:async(url,init)=>{
    if(url.endsWith('?versioning=')) return new Response(versioning,{status:200});
    if(url.endsWith('?object-lock=')) return new Response(objectLock,{status:200});
    objectCalls+=1;
    return response(init.method??'GET');
  }});
  const result=await live.execute({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/recovery-primary',descriptor:descriptor('verify')});
  assert.match(result.immutable_version_ref,/^version:/);
  assert.equal(objectCalls,1);
});

test('bucket preflight is cached per driver instance and never persisted',async()=>{
  const command={
    connection_ref:config.alias,
    descriptor_id:'a'.repeat(64),
    project:'condor',
    operation:'verify' as const,
    namespace:'recovery:condor',
    object_ref:'backup:001',
    checksum_sha256:digest,
    idempotency_key:'backup:001',
  };
  let checks=0;
  const transport:RecoveryS3Transport=async(url,init)=>{
    if(url.includes('?')){
      checks+=1;
      return preflightResponse(url)!;
    }
    return response(init.method??'GET');
  };
  const first=new S3CompatibleRecoveryDriver({config,source,sink,transport});
  await first.execute(command);
  await first.execute(command);
  assert.equal(checks,2);
  const second=new S3CompatibleRecoveryDriver({config,source,sink,transport});
  await second.execute(command);
  assert.equal(checks,4);
});
