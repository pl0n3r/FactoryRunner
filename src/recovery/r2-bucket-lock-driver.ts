import { randomUUID } from 'node:crypto';
import type {
  RecoveryObjectStorageCommand, RecoveryObjectStorageDriver,
} from '../adapters/recovery-object-storage.ts';
import type { RecoveryS3Connection } from './connection-resolver.ts';
import {
  recoveryS3Path, recoverySha256, signedRecoveryS3Request,
} from './s3-compatible-driver.ts';
import type {
  RecoveryArtifactSink, RecoveryArtifactSource, RecoveryS3Transport,
} from './s3-compatible-driver.ts';

const DAY_SECONDS=86400;
type Clock=()=>Date;
type R2Profile=Readonly<{accountId:string;apiToken:string;jurisdiction?:string}>;
type Rule=Readonly<{id:string;prefix:string;condition:string}>;

function record(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function invalid():never{throw new Error('r2_bucket_lock_unavailable');}

/**
 * Connection-scoped runtime profile, never supplied by an ExecutionOrder.
 * Missing PROVIDER preserves the historical S3 Object Lock behavior.
 */
export function resolveR2BucketLockProfile(
  config:RecoveryS3Connection,env:NodeJS.ProcessEnv,
):R2Profile|null{
  const stem='FACTORYRUNNER_CONNECTION_'+config.alias
    .slice('controlbot:connection/'.length).toUpperCase().replace(/[^A-Z0-9]/g,'_')+'_';
  const provider=env[stem+'PROVIDER']??'s3_object_lock';
  if(provider==='s3_object_lock') return null;
  if(provider!=='r2_bucket_lock') invalid();
  const accountId=env[stem+'R2_ACCOUNT_ID'];
  const apiToken=env[stem+'R2_API_TOKEN'];
  const jurisdiction=env[stem+'R2_JURISDICTION'];
  if(!accountId||!/^([a-f0-9]{32})$/.test(accountId)
     ||!apiToken||apiToken.length<16||apiToken.length>512||/[\s\u0000-\u001f]/.test(apiToken)) invalid();
  if(jurisdiction&&!/^[a-z][a-z0-9-]{1,24}$/.test(jurisdiction)) invalid();
  const expectedHost=accountId+(jurisdiction?'.'+jurisdiction:'')+'.r2.cloudflarestorage.com';
  if(new URL(config.endpoint).hostname.toLowerCase()!==expectedHost) invalid();
  return Object.freeze({accountId,apiToken,...(jurisdiction?{jurisdiction}:{})});
}

function objectKey(config:RecoveryS3Connection,command:RecoveryObjectStorageCommand):string{
  return [config.prefix,command.namespace,command.object_ref]
    .flatMap(part=>part.split('/')).filter(Boolean).join('/');
}
function etag(response:Response):string{
  const value=response.headers.get('etag');
  if(!value||value.length>128||!/^(?:"[A-Za-z0-9._:-]+"|[A-Za-z0-9._:-]+)$/.test(value)) invalid();
  return value;
}

export class R2BucketLockRecoveryDriver implements RecoveryObjectStorageDriver {
  readonly #config:RecoveryS3Connection;
  readonly #profile:R2Profile;
  readonly #source:RecoveryArtifactSource;
  readonly #sink:RecoveryArtifactSink;
  readonly #transport:RecoveryS3Transport;
  readonly #clock:Clock;

  constructor(options:{
    config:RecoveryS3Connection;profile:R2Profile;
    source:RecoveryArtifactSource;sink:RecoveryArtifactSink;
    transport?:RecoveryS3Transport;clock?:Clock;
  }){
    this.#config=options.config;this.#profile=options.profile;
    this.#source=options.source;this.#sink=options.sink;
    this.#transport=options.transport??((url,init)=>fetch(url,init));
    this.#clock=options.clock??(()=>new Date());
  }

  async execute(command:RecoveryObjectStorageCommand):Promise<unknown>{
    try{
      const key=objectKey(this.#config,command);
      const rule=await this.#verifyRule(key);
      // Use a disposable synthetic key under the exact protected object prefix.
      // Never attempt destructive probes against the actual backup object.
      await this.#proveLock(command);
      const pathname=recoveryS3Path(this.#config,command);
      if(command.operation==='upload') return await this.#upload(command,pathname,rule);
      const verified=await this.#readProtected(command,pathname);
      if(command.operation==='materialize'){
        await this.#sink.write(command.object_ref,verified.bytes);
      }
      return this.#ok(command,verified.etag,rule);
    }catch{return this.#blocked(command);}
  }

  async #verifyRule(key:string):Promise<Rule>{
    const url='https://api.cloudflare.com/client/v4/accounts/'+this.#profile.accountId+
      '/r2/buckets/'+encodeURIComponent(this.#config.bucket)+'/lock';
    const response=await this.#transport(url,{
      method:'GET',headers:{
        authorization:'Bearer '+this.#profile.apiToken,
        ...(this.#profile.jurisdiction?{'cf-r2-jurisdiction':this.#profile.jurisdiction}:{}),
      },
    });
    if(!response.ok) invalid();
    const raw=await response.text();
    if(raw.length>262144) invalid();
    const payload:unknown=JSON.parse(raw);
    if(!record(payload)||payload.success!==true||!record(payload.result)
       ||!Array.isArray(payload.result.rules)||payload.result.rules.length>1000) invalid();
    const minimum=this.#clock().getTime()+this.#config.objectLockDays*DAY_SECONDS*1000;
    const sufficient=payload.result.rules.filter((item:unknown)=>{
      if(!record(item)||item.enabled!==true||typeof item.id!=='string'
         ||item.id.length<1||item.id.length>128||typeof (item.prefix??'')!=='string'
         ||!record(item.condition)||!key.startsWith((item.prefix as string|undefined)??'')) return false;
      const condition=item.condition;
      if(condition.type==='Indefinite') return true;
      if(condition.type==='Age') return typeof condition.maxAgeSeconds==='number'
        &&Number.isFinite(condition.maxAgeSeconds)
        &&condition.maxAgeSeconds>=this.#config.objectLockDays*DAY_SECONDS;
      if(condition.type==='Date') return typeof condition.date==='string'
        &&Number.isFinite(Date.parse(condition.date))&&Date.parse(condition.date)>=minimum;
      return false;
    });
    if(sufficient.length===0) invalid();
    const selected=sufficient[0] as Record<string,unknown>;
    const condition=selected.condition as Record<string,unknown>;
    return {id:selected.id as string,prefix:(selected.prefix as string|undefined)??'',
      condition:JSON.stringify(condition)};
  }

  async #request(method:string,pathname:string,body?:Uint8Array,headers:Record<string,string>={}):Promise<Response>{
    const req=signedRecoveryS3Request(this.#config,method,pathname,
      recoverySha256(body??''),this.#clock(),headers);
    if(body) req.init.body=Buffer.from(body);
    return this.#transport(req.url,req.init);
  }

  async #proveLock(command:RecoveryObjectStorageCommand):Promise<void>{
    const probeCommand={...command,object_ref:command.object_ref+'/__r2_lock_probe_'+randomUUID()};
    const pathname=recoveryS3Path(this.#config,probeCommand);
    const probe=new TextEncoder().encode('r2-lock-probe:'+randomUUID());
    const digest=recoverySha256(probe);
    const put=await this.#request('PUT',pathname,probe,{'x-amz-meta-sha256':digest,'if-none-match':'*'});
    if(!put.ok) invalid();
    // A successful overwrite or delete signals that the alleged retention is ineffective.
    const changed=new TextEncoder().encode('tamper:'+randomUUID());
    const overwritten=await this.#request('PUT',pathname,changed,{'x-amz-meta-sha256':recoverySha256(changed)});
    await this.#assertObjectLocked(overwritten);
    const deleted=await this.#request('DELETE',pathname);
    await this.#assertObjectLocked(deleted);
    const read=await this.#request('GET',pathname);
    if(!read.ok||recoverySha256(new Uint8Array(await read.arrayBuffer()))!==digest) invalid();
  }

  async #assertObjectLocked(response:Response):Promise<void>{
    // R2 reports lock enforcement as 409 ObjectLockedByBucketPolicy, not
    // a generic AccessDenied, precondition failure, or unrelated conflict.
    if(response.status!==409) invalid();
    const errorBody=await response.text();
    if(errorBody.length>4096||!errorBody.includes('<Code>ObjectLockedByBucketPolicy</Code>')) invalid();
  }

  async #readProtected(command:RecoveryObjectStorageCommand,pathname:string):
    Promise<{bytes:Uint8Array;etag:string}>{
    const head=await this.#request('HEAD',pathname);
    if(!head.ok||head.headers.get('x-amz-meta-sha256')!==command.checksum_sha256) invalid();
    const version=etag(head);
    const get=await this.#request('GET',pathname);
    if(!get.ok||etag(get)!==version) invalid();
    const bytes=new Uint8Array(await get.arrayBuffer());
    if(recoverySha256(bytes)!==command.checksum_sha256) invalid();
    return {bytes,etag:version};
  }

  async #upload(command:RecoveryObjectStorageCommand,pathname:string,rule:Rule):Promise<unknown>{
    const existing=await this.#request('HEAD',pathname);
    if(existing.ok){
      const read=await this.#readProtected(command,pathname);
      return this.#ok(command,read.etag,rule);
    }
    if(existing.status!==404) invalid();
    const bytes=await this.#source.read(command.object_ref);
    if(recoverySha256(bytes)!==command.checksum_sha256) invalid();
    const response=await this.#request('PUT',pathname,bytes,
      {'x-amz-meta-sha256':command.checksum_sha256,'if-none-match':'*'});
    if(!response.ok) invalid();
    const read=await this.#readProtected(command,pathname);
    return this.#ok(command,read.etag,rule);
  }

  #ok(command:RecoveryObjectStorageCommand,version:string,rule:Rule){
    const marker=recoverySha256([
      this.#config.alias,version,command.checksum_sha256,rule.id,rule.prefix,rule.condition,
    ].join(':'));
    return {
      status:'ok',object_ref:command.object_ref,checksum_sha256:command.checksum_sha256,
      immutable_version_ref:'r2_bucket_lock:'+marker.slice(0,32),
      evidence_ref:'evidence:'+recoverySha256(command.descriptor_id+':'+marker).slice(0,32),
    };
  }
  #blocked(command:RecoveryObjectStorageCommand){
    return {status:'blocked',object_ref:command.object_ref,
      checksum_sha256:command.checksum_sha256,immutable_version_ref:'blocked',evidence_ref:'blocked'};
  }
}
