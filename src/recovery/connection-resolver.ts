import { isIP } from 'node:net';

export type RecoveryS3Connection = Readonly<{
  alias:string;
  endpoint:string;
  bucket:string;
  region:string;
  prefix:string;
  objectLockDays:number;
  accessKeyId:string;
  secretAccessKey:string;
  awsSecurityToken?:string;
}>;

const ALIAS=/^controlbot:connection\/[a-z0-9][a-z0-9._-]{1,63}$/;
const BUCKET=/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION=/^[a-z0-9][a-z0-9-]{0,31}$/;
const PREFIX=/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SENSITIVE=/password|passwd|secret|token|api[-_]?key|private[-_]?key|dsn|bearer/i;

export class RecoveryConnectionError extends Error {
  constructor(){super('recovery_connection_unavailable');this.name='RecoveryConnectionError';}
}

function envStem(alias:string):string{
  if(!ALIAS.test(alias)) throw new RecoveryConnectionError();
  return 'FACTORYRUNNER_CONNECTION_'+alias.slice('controlbot:connection/'.length).toUpperCase().replace(/[^A-Z0-9]/g,'_')+'_';
}

function required(env:NodeJS.ProcessEnv,key:string):string{
  const value=env[key];
  if(typeof value!=='string'||value.length===0) throw new RecoveryConnectionError();
  return value;
}

function endpoint(value:string):string{
  let parsed:URL;
  try{parsed=new URL(value);}catch{throw new RecoveryConnectionError();}
  const host=parsed.hostname.toLowerCase();
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||(parsed.port&&parsed.port!=='443')) throw new RecoveryConnectionError();
  if(parsed.pathname!==''&&parsed.pathname!=='/') throw new RecoveryConnectionError();
  if(isIP(host)!==0||host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||!host.includes('.')){
    throw new RecoveryConnectionError();
  }
  return parsed.origin;
}

function opaqueConfig(value:string,pattern:RegExp):string{
  if(!pattern.test(value)||value.includes('..')||value.includes('//')||SENSITIVE.test(value)) throw new RecoveryConnectionError();
  return value;
}

function objectLockDays(value:string):number{
  if(!/^[1-9][0-9]{0,3}$/.test(value)) throw new RecoveryConnectionError();
  const days=Number(value);
  if(!Number.isSafeInteger(days)||days<1||days>3650) throw new RecoveryConnectionError();
  return days;
}

export function resolveRecoveryS3Connection(alias:string,env:NodeJS.ProcessEnv=process.env):RecoveryS3Connection{
  const stem=envStem(alias);
  const config:RecoveryS3Connection={
    alias,
    endpoint:endpoint(required(env,stem+'ENDPOINT')),
    bucket:opaqueConfig(required(env,stem+'BUCKET'),BUCKET),
    region:opaqueConfig(required(env,stem+'REGION'),REGION),
    prefix:opaqueConfig(required(env,stem+'PREFIX'),PREFIX),
    objectLockDays:objectLockDays(required(env,stem+'OBJECT_LOCK_DAYS')),
    accessKeyId:required(env,stem+'ACCESS_KEY_ID'),
    secretAccessKey:required(env,stem+'SECRET_ACCESS_KEY'),
    ...(env[stem+'AWS_SECURITY_TOKEN']?{awsSecurityToken:env[stem+'AWS_SECURITY_TOKEN']}:{}),
  };
  if(config.accessKeyId.length>256||config.secretAccessKey.length>512||(config.awsSecurityToken?.length??0)>2048) throw new RecoveryConnectionError();
  return Object.freeze(config);
}
