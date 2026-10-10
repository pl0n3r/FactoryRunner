import { createHash, createHmac } from 'node:crypto';
import type {
  RecoveryObjectStorageCommand, RecoveryObjectStorageDriver,
} from '../adapters/recovery-object-storage.ts';
import type { RecoveryS3Connection } from './connection-resolver.ts';

export interface RecoveryArtifactSource { read(objectRef:string):Promise<Uint8Array>; }
export interface RecoveryArtifactSink { write(objectRef:string,body:Uint8Array):Promise<void>; }
export type RecoveryS3Transport=(url:string,init:RequestInit)=>Promise<Response>;

type Clock=()=>Date;
const DAY_MS=24*60*60*1000;

function sha256(value:Uint8Array|string):string{return createHash('sha256').update(value).digest('hex');}
function hmac(key:Uint8Array|string,value:string):Buffer{return createHmac('sha256',key).update(value).digest();}
function awsEncode(value:string):string{return encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.codePointAt(0)!.toString(16).toUpperCase());}
function path(config:RecoveryS3Connection,command:RecoveryObjectStorageCommand):string{
  return '/'+[config.bucket,config.prefix,command.namespace,command.object_ref].flatMap(x=>x.split('/')).filter(Boolean).map(awsEncode).join('/');
}
function bucketPath(config:RecoveryS3Connection):string{return '/'+awsEncode(config.bucket);}
function safeVersion(value:string|null):string{
  if(!value||value.length>1024||/[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_version');
  return value;
}
function futureRetention(value:string|null,now:Date):void{
  if(!value||value.length>128||/[\u0000-\u001f\u007f]/.test(value)) throw new Error('invalid_retention');
  const timestamp=Date.parse(value);
  if(!Number.isFinite(timestamp)||timestamp<=now.getTime()) throw new Error('invalid_retention');
}
function canonicalQuery(query:Record<string,string>):string{
  return Object.entries(query)
    .sort(([left],[right])=>left<right?-1:left>right?1:0)
    .map(([key,value])=>awsEncode(key)+'='+awsEncode(value))
    .join('&');
}
function signedRequest(
  config:RecoveryS3Connection,method:string,pathname:string,payloadHash:string,now:Date,
  extra:Record<string,string>={},query:Record<string,string>={},
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
  const queryString=canonicalQuery(query);
  const canonicalRequest=[method,pathname,queryString,canonicalHeaders,signedHeaders,payloadHash].join('\n');
  const scope=`${date}/${config.region}/s3/aws4_request`;
  const toSign=['AWS4-HMAC-SHA256',amzDate,scope,sha256(canonicalRequest)].join('\n');
  const kDate=hmac('AWS4'+config.secretAccessKey,date);
  const kRegion=hmac(kDate,config.region);
  const kService=hmac(kRegion,'s3');
  const kSigning=hmac(kService,'aws4_request');
  const signature=createHmac('sha256',kSigning).update(toSign).digest('hex');
  headers.authorization=`AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host;
  return {url:config.endpoint+pathname+(queryString?'?'+queryString:''),init:{method,headers}};
}
function invalidBucketXml():never{throw new Error('invalid_bucket_configuration');}

function validXmlAttributes(attrs:string):boolean{
  let cursor=0;
  const seen=new Set<string>();
  while(cursor<attrs.length){
    const whitespace=/^\s+/.exec(attrs.slice(cursor));
    if(!whitespace) return false;
    cursor+=whitespace[0].length;
    if(cursor===attrs.length) return true;
    const name=/^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(attrs.slice(cursor));
    if(!name||seen.has(name[0])) return false;
    seen.add(name[0]);
    cursor+=name[0].length;
    const assignment=/^\s*=\s*/.exec(attrs.slice(cursor));
    if(!assignment) return false;
    cursor+=assignment[0].length;
    const quote=attrs[cursor];
    if(quote!=='"'&&quote!=="'") return false;
    const end=attrs.indexOf(quote,cursor+1);
    if(end<0||/[<>&]/.test(attrs.slice(cursor+1,end))) return false;
    cursor=end+1;
  }
  return true;
}

type BucketXmlToken={name:string;closing:boolean;selfClosing:boolean};
type BucketXmlState={
  stack:string[]; seenRoot:boolean; closedRoot:boolean;
  targetValue:string|undefined; contentStart:number;
};

function bucketXmlToken(token:string):BucketXmlToken{
  const closing=token.startsWith('</');
  const selfClosing=token.endsWith('/>');
  const inner=token.slice(closing?2:1,token.length-(selfClosing?2:1));
  const name=/^[A-Za-z][A-Za-z0-9:._-]*/.exec(inner);
  if(!name) invalidBucketXml();
  const attrs=inner.slice(name[0].length);
  if(closing ? (selfClosing||attrs.trim()!=='') : !validXmlAttributes(attrs)) invalidBucketXml();
  return {name:name[0],closing,selfClosing};
}

function openBucketXmlTag(state:BucketXmlState,token:BucketXmlToken,root:string,tag:string,index:number):void{
  if(state.closedRoot||(!state.stack.length&&(token.name!==root||state.seenRoot))
     ||(state.stack.length&&token.name===root)) invalidBucketXml();
  if(!state.stack.length) state.seenRoot=true;
  if(token.name===tag){
    if(state.stack.length!==1||state.targetValue!==undefined||token.selfClosing) invalidBucketXml();
    state.contentStart=index;
  }
  if(!token.selfClosing) state.stack.push(token.name);
  else if(!state.stack.length) state.closedRoot=true;
}

function closeBucketXmlTag(state:BucketXmlState,token:BucketXmlToken,tag:string,xml:string,index:number):void{
  if(state.stack.at(-1)!==token.name) invalidBucketXml();
  if(token.name===tag){
    if(state.stack.length!==2||state.targetValue!==undefined||state.contentStart<0) invalidBucketXml();
    const value=xml.slice(state.contentStart,index).trim();
    if(!value||/[<>]/.test(value)) invalidBucketXml();
    state.targetValue=value;
  }
  state.stack.pop();
  if(!state.stack.length) state.closedRoot=true;
}

function stripXmlDeclaration(xml:string):string{
  const source=xml.trim();
  if(!source.startsWith('<?xml')) return source;
  if(![' ', '\t', '\r', '\n'].includes(source[5]??'')) invalidBucketXml();
  const end=source.indexOf('?>');
  if(end<0||end>200) invalidBucketXml();
  const fields=source.slice(5,end).trim().split(/\s+/);
  if(fields.length<1||fields.length>2) invalidBucketXml();
  if(!['version="1.0"', "version='1.0'", 'version="1.1"', "version='1.1'"].includes(fields[0]!)) invalidBucketXml();
  if(fields.length===2){
    const encoding=fields[1]!;
    if(!encoding.startsWith('encoding=')) invalidBucketXml();
    const quoted=encoding.slice('encoding='.length);
    const quote=quoted[0];
    if((quote!=='"'&&quote!=="'")||!quoted.endsWith(quote)) invalidBucketXml();
    if(!/^[A-Za-z0-9._-]+$/.test(quoted.slice(1,-1))) invalidBucketXml();
  }
  return source.slice(end+2).trim();
}

function exactXmlValue(xml:string,root:string,tag:string):string{
  if(xml.length===0||xml.length>8192||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(xml)) invalidBucketXml();
  // S3 preflight XML only: reject DTD, entities, comments and extra PIs.
  const source=stripXmlDeclaration(xml);
  if(source.includes('<!')||source.includes('<?')||source.includes('&')) invalidBucketXml();
  const state:BucketXmlState={
    stack:[],seenRoot:false,closedRoot:false,targetValue:undefined,contentStart:-1,
  };
  let cursor=0;
  for(const match of source.matchAll(/<[^<>]*>/g)){
    const before=source.slice(cursor,match.index);
    if(/[<>]/.test(before)||(state.stack.length<=1&&before.trim())) invalidBucketXml();
    const token=bucketXmlToken(match[0]);
    if(token.closing) closeBucketXmlTag(state,token,tag,source,match.index);
    else openBucketXmlTag(state,token,root,tag,match.index+match[0].length);
    cursor=match.index+match[0].length;
  }
  if(!state.seenRoot||!state.closedRoot||state.stack.length
     ||source.slice(cursor).trim()||state.targetValue===undefined) invalidBucketXml();
  return state.targetValue;
}


export class S3CompatibleRecoveryDriver implements RecoveryObjectStorageDriver {
  readonly #config:RecoveryS3Connection;
  readonly #source:RecoveryArtifactSource;
  readonly #sink:RecoveryArtifactSink;
  readonly #transport:RecoveryS3Transport;
  readonly #clock:Clock;
  #bucketPreflight:Promise<void>|undefined;

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
      await this.#ensureBucketReady();
      const pathname=path(this.#config,command);
      if(command.operation==='upload') return await this.#upload(command,pathname);
      if(command.operation==='verify') return await this.#verify(command,pathname);
      return await this.#materialize(command,pathname);
    }catch{return this.#blocked(command);}
  }

  async #ensureBucketReady():Promise<void>{
    this.#bucketPreflight??=this.#verifyBucketConfiguration();
    await this.#bucketPreflight;
  }

  async #verifyBucketConfiguration():Promise<void>{
    const pathname=bucketPath(this.#config);
    const checks:[string,string,string][]=[
      ['versioning','VersioningConfiguration','Status'],
      ['object-lock','ObjectLockConfiguration','ObjectLockEnabled'],
    ];
    for(const [query,root,tag] of checks){
      const req=signedRequest(this.#config,'GET',pathname,sha256(''),this.#clock(),{}, {[query]:''});
      const response=await this.#transport(req.url,req.init);
      if(!response.ok) throw new Error('bucket_preflight_failed');
      const value=exactXmlValue(await response.text(),root,tag);
      if(value!=='Enabled') throw new Error('bucket_preflight_failed');
    }
  }

  #immutableVersion(response:Response,command:RecoveryObjectStorageCommand,now:Date):string{
    if(response.headers.get('x-amz-meta-sha256')!==command.checksum_sha256) throw new Error('checksum_mismatch');
    const version=safeVersion(response.headers.get('x-amz-version-id'));
    if(response.headers.get('x-amz-object-lock-mode')!=='COMPLIANCE') throw new Error('object_lock_required');
    futureRetention(response.headers.get('x-amz-object-lock-retain-until-date'),now);
    return version;
  }

  async #headImmutable(command:RecoveryObjectStorageCommand,pathname:string):Promise<string>{
    const now=this.#clock();
    const req=signedRequest(this.#config,'HEAD',pathname,sha256(''),now);
    const response=await this.#transport(req.url,req.init);
    if(!response.ok) throw new Error('object_unavailable');
    return this.#immutableVersion(response,command,now);
  }

  async #upload(command:RecoveryObjectStorageCommand,pathname:string):Promise<unknown>{
    const probeNow=this.#clock();
    const probe=signedRequest(this.#config,'HEAD',pathname,sha256(''),probeNow);
    const existing=await this.#transport(probe.url,probe.init);
    if(existing.ok) return this.#ok(command,this.#immutableVersion(existing,command,probeNow));
    if(existing.status!==404) return this.#blocked(command);

    const body=await this.#source.read(command.object_ref);
    const digest=sha256(body);
    if(digest!==command.checksum_sha256) return this.#blocked(command);

    const now=this.#clock();
    const retainUntil=new Date(now.getTime()+this.#config.objectLockDays*DAY_MS).toISOString();
    const req=signedRequest(this.#config,'PUT',pathname,digest,now,{
      'x-amz-meta-sha256':digest,
      'x-amz-object-lock-mode':'COMPLIANCE',
      'x-amz-object-lock-retain-until-date':retainUntil,
    });
    req.init.body=Buffer.from(body);
    const response=await this.#transport(req.url,req.init);
    if(!response.ok) return this.#blocked(command);
    const putVersion=safeVersion(response.headers.get('x-amz-version-id'));
    const verifiedVersion=await this.#headImmutable(command,pathname);
    if(verifiedVersion!==putVersion) return this.#blocked(command);
    return this.#ok(command,verifiedVersion);
  }

  async #verify(command:RecoveryObjectStorageCommand,pathname:string):Promise<unknown>{
    return this.#ok(command,await this.#headImmutable(command,pathname));
  }

  async #materialize(command:RecoveryObjectStorageCommand,pathname:string):Promise<unknown>{
    const verifiedVersion=await this.#headImmutable(command,pathname);
    const req=signedRequest(this.#config,'GET',pathname,sha256(''),this.#clock());
    const response=await this.#transport(req.url,req.init);
    if(!response.ok) return this.#blocked(command);
    const getVersion=safeVersion(response.headers.get('x-amz-version-id'));
    if(getVersion!==verifiedVersion||response.headers.get('x-amz-meta-sha256')!==command.checksum_sha256) return this.#blocked(command);
    const body=new Uint8Array(await response.arrayBuffer());
    if(sha256(body)!==command.checksum_sha256) return this.#blocked(command);
    await this.#sink.write(command.object_ref,body);
    return this.#ok(command,verifiedVersion);
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
