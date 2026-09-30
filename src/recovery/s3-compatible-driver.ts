import { createHash, createHmac } from 'node:crypto';
import type {
  RecoveryObjectStorageCommand, RecoveryObjectStorageDriver,
} from '../adapters/recovery-object-storage.ts';
import type { RecoveryS3Connection } from './connection-resolver.ts';

export interface RecoveryArtifactSource { read(objectRef:string):Promise<Uint8Array>; }
export interface RecoveryArtifactSink { write(objectRef:string,body:Uint8Array):Promise<void>; }
export type RecoveryS3Transport=(url:string,init:RequestInit)=>Promise<Response>;

type Clock=()=>Date;
const SHA256=/^[0-9a-f]{64}$/;

function sha256(value:Uint8Array|string):string{return createHash('sha256').update(value).digest('hex');}
function hmac(key:Uint8Array|string,value:string):Buffer{return createHmac('sha256',key).update(value).digest();}
function awsEncode(value:string):string{return encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.codePointAt(0)!.toString(16).toUpperCase());}
function path(config:RecoveryS3Connection,command:RecoveryObjectStorageCommand):string{
  return '/'+[config.bucket,config.prefix,command.namespace,command.object_ref].flatMap(x=>x.split('/')).filter(Boolean).map(awsEncode).join('/');
}
function safeVersion(value:string|null):string{
  if(!value||value.length>1024||/[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_version');
  return value;
}
function signedRequest(
  config:RecoveryS3Connection,method:string,pathname:string,payloadHash:string,now:Date,extra:Record<string,string>={},
):{url:string;init:RequestInit}{
  const amzDate=now.toISOString().replace(/[:-]|\.\d{3}/g,'');
  const date=amzDate.slice(0,8);
  const host=new URL(config.endpoint).host;
  const headers:Record<string,string>={
    host,
    'x-amz-content-sha256':payloadHash,
    'x-amz-date':amzDate,
    ...extra,
  };
  if(config.awsSecurityToken) headers['x-amz-security-token']=config.awsSecurityToken;
  const names=Object.keys(headers).sort((a,b)=>a.localeCompare(b));
  const canonicalHeaders=names.map(name=>name.toLowerCase()+':'+headers[name].trim()+'\n').join('');
  const signedHeaders=names.map(name=>name.toLowerCase()).join(';');
  const canonicalRequest=[method,pathname,'',canonicalHeaders,signedHeaders,payloadHash].join('\n');
  const scope=`${date}/${config.region}/s3/aws4_request`;
  const toSign=['AWS4-HMAC-SHA256',amzDate,scope,sha256(canonicalRequest)].join('\n');
  const kDate=hmac('AWS4'+config.secretAccessKey,date);
  const kRegion=hmac(kDate,config.region);
  const kService=hmac(kRegion,'s3');
  const kSigning=hmac(kService,'aws4_request');
  const signature=createHmac('sha256',kSigning).update(toSign).digest('hex');
  headers.authorization=`AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host;
  return {url:config.endpoint+pathname,init:{method,headers}};
}

export class S3CompatibleRecoveryDriver implements RecoveryObjectStorageDriver {
  readonly #config:RecoveryS3Connection;
  readonly #source:RecoveryArtifactSource;
  readonly #sink:RecoveryArtifactSink;
  readonly #transport:RecoveryS3Transport;
  readonly #clock:Clock;

  constructor(options:{
    config:RecoveryS3Connection; source:RecoveryArtifactSource; sink:RecoveryArtifactSink;
    transport?:RecoveryS3Transport; clock?:Clock;
  }){
    this.#config=options.config;
    this.#source=options.source;
    this.#sink=options.sink;
    this.#transport=options.transport??((url,init)=>fetch(url,init));
    this.#clock=options.clock??(()=>new Date());
  }

  async execute(command:RecoveryObjectStorageCommand):Promise<unknown>{
    try{
      const pathname=path(this.#config,command);
      if(command.operation==='upload') return await this.#upload(command,pathname);
      if(command.operation==='verify') return await this.#verify(command,pathname);
      return await this.#materialize(command,pathname);
    }catch{return this.#blocked(command);}
  }

  async #upload(command:RecoveryObjectStorageCommand,pathname:string):Promise<unknown>{
    const probe=signedRequest(this.#config,'HEAD',pathname,sha256(''),this.#clock());
    const existing=await this.#transport(probe.url,probe.init);
    if(existing.ok){
      if(existing.headers.get('x-amz-meta-sha256')!==command.checksum_sha256) return this.#blocked(command);
      return this.#ok(command,safeVersion(existing.headers.get('x-amz-version-id')));
    }
    if(existing.status!==404) return this.#blocked(command);
    const body=await this.#source.read(command.object_ref);
    const digest=sha256(body);
    if(digest!==command.checksum_sha256) return this.#blocked(command);
    const req=signedRequest(this.#config,'PUT',pathname,digest,this.#clock(),{'x-amz-meta-sha256':digest});
    req.init.body=Buffer.from(body);
    const response=await this.#transport(req.url,req.init);
    if(!response.ok) return this.#blocked(command);
    return this.#ok(command,safeVersion(response.headers.get('x-amz-version-id')));
  }

  async #verify(command:RecoveryObjectStorageCommand,pathname:string):Promise<unknown>{
    const req=signedRequest(this.#config,'HEAD',pathname,sha256(''),this.#clock());
    const response=await this.#transport(req.url,req.init);
    if(!response.ok||response.headers.get('x-amz-meta-sha256')!==command.checksum_sha256) return this.#blocked(command);
    return this.#ok(command,safeVersion(response.headers.get('x-amz-version-id')));
  }

  async #materialize(command:RecoveryObjectStorageCommand,pathname:string):Promise<unknown>{
    const req=signedRequest(this.#config,'GET',pathname,sha256(''),this.#clock());
    const response=await this.#transport(req.url,req.init);
    if(!response.ok) return this.#blocked(command);
    const body=new Uint8Array(await response.arrayBuffer());
    if(sha256(body)!==command.checksum_sha256) return this.#blocked(command);
    await this.#sink.write(command.object_ref,body);
    return this.#ok(command,safeVersion(response.headers.get('x-amz-version-id')));
  }

  #ok(command:RecoveryObjectStorageCommand,version:string){
    return {
      status:'ok',
      object_ref:command.object_ref,
      checksum_sha256:command.checksum_sha256,
      immutable_version_ref:'version:'+sha256(this.#config.alias+':'+version).slice(0,32),
      evidence_ref:'evidence:'+sha256(command.descriptor_id+':'+version).slice(0,32),
    };
  }
  #blocked(command:RecoveryObjectStorageCommand){
    return {status:'blocked',object_ref:command.object_ref,checksum_sha256:command.checksum_sha256,immutable_version_ref:'blocked',evidence_ref:'blocked'};
  }
}
