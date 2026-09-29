import {
  asRecord, exactKeys, noSensitiveText, ref, stableSha256, stringValue,
} from '../validation.ts';

type Operation='snapshot'|'restore_disposable';
export type RecoveryDatabaseCapability='recovery.database.snapshot'|'recovery.database.restore-disposable';

export type RecoveryDatabaseSnapshotCommand={
  connection_ref:string; descriptor_id:string; project:string; operation:'snapshot';
  snapshot_ref:string; idempotency_key:string;
};
export type RecoveryDatabaseRestoreCommand={
  connection_ref:string; descriptor_id:string; project:string; operation:'restore_disposable';
  backup_id:string; checksum_sha256:string; target_ref:string; idempotency_key:string;
};
export type RecoveryDatabaseCommand=RecoveryDatabaseSnapshotCommand|RecoveryDatabaseRestoreCommand;

export interface RecoveryDatabaseDriver {
  execute(command:RecoveryDatabaseCommand):Promise<unknown>;
}

export type RecoveryDatabaseResult=
  | {capability:'recovery.database.snapshot';operation:'snapshot';descriptor_id:string;snapshot_ref:string;evidence_ref:string}
  | {capability:'recovery.database.restore-disposable';operation:'restore_disposable';descriptor_id:string;backup_id:string;checksum_sha256:string;target_ref:string;evidence_ref:string};

const REFISH=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256=/^[0-9a-f]{64}$/;
const CREDENTIAL_WORDS=/(?:dsn|password|passwd|token|secret|credential|private[_-]?key)/i;

export class RecoveryDatabaseError extends Error {
  constructor(){super('recovery_database_failed');this.name='RecoveryDatabaseError';}
}

function opaque(value:unknown,label:string):string{
  const parsed=noSensitiveText(stringValue(value,label,128),label);
  if(!REFISH.test(parsed)||parsed.includes('://')||parsed.includes('..')||parsed.includes('@')){
    throw new TypeError(`${label} inválida.`);
  }
  return parsed;
}
function checksum(value:unknown):string{
  const parsed=stringValue(value,'checksum_sha256',64);
  if(!SHA256.test(parsed)) throw new TypeError('checksum_sha256 inválido.');
  return parsed;
}
function connectionRef(value:unknown):string{
  const parsed=ref(value,'connection_ref',180);
  if(!parsed.startsWith('controlbot:connection/')||parsed.includes('://')||parsed.includes('..')
    ||parsed.includes('@')||CREDENTIAL_WORDS.test(parsed)){
    throw new TypeError('connection_ref inválida.');
  }
  return parsed;
}
function capability(value:string):RecoveryDatabaseCapability{
  if(value!=='recovery.database.snapshot'&&value!=='recovery.database.restore-disposable'){
    throw new TypeError('Recovery database capability no soportada.');
  }
  return value;
}

function snapshotDescriptor(value:unknown):Omit<RecoveryDatabaseSnapshotCommand,'connection_ref'>{
  const raw=asRecord(value,'Recovery database snapshot descriptor');
  exactKeys(raw,['version','project','source','operation','snapshot_ref','idempotency_key','authority','execute','descriptor_id'],'Recovery database snapshot descriptor');
  if(raw.version!==1||raw.source!=='database'||raw.operation!=='snapshot'||raw.authority!=='unchanged'||raw.execute!==false){
    throw new TypeError('Recovery database snapshot descriptor fuera de contrato.');
  }
  const canonical={
    version:1,project:opaque(raw.project,'project'),source:'database',operation:'snapshot',
    snapshot_ref:opaque(raw.snapshot_ref,'snapshot_ref'),
    idempotency_key:opaque(raw.idempotency_key,'idempotency_key'),authority:'unchanged',execute:false,
  } as const;
  const descriptorId=checksum(raw.descriptor_id);
  if(stableSha256(canonical)!==descriptorId) throw new TypeError('descriptor_id no coincide.');
  return {descriptor_id:descriptorId,project:canonical.project,operation:'snapshot',snapshot_ref:canonical.snapshot_ref,idempotency_key:canonical.idempotency_key};
}

function restoreDescriptor(value:unknown):Omit<RecoveryDatabaseRestoreCommand,'connection_ref'>{
  const raw=asRecord(value,'Recovery database restore descriptor');
  exactKeys(raw,['version','project','source','operation','backup_id','checksum_sha256','target','idempotency_key','authority','execute','descriptor_id'],'Recovery database restore descriptor');
  if(raw.version!==1||raw.source!=='database'||raw.operation!=='restore_disposable'||raw.authority!=='unchanged'||raw.execute!==false){
    throw new TypeError('Recovery database restore descriptor fuera de contrato.');
  }
  const target=asRecord(raw.target,'target');
  exactKeys(target,['kind','target_ref'],'target');
  if(target.kind!=='disposable') throw new TypeError('target.kind debe ser disposable.');
  const canonical={
    version:1,project:opaque(raw.project,'project'),source:'database',operation:'restore_disposable',
    backup_id:opaque(raw.backup_id,'backup_id'),checksum_sha256:checksum(raw.checksum_sha256),
    target:{kind:'disposable',target_ref:opaque(target.target_ref,'target_ref')},
    idempotency_key:opaque(raw.idempotency_key,'idempotency_key'),authority:'unchanged',execute:false,
  } as const;
  const descriptorId=checksum(raw.descriptor_id);
  if(stableSha256(canonical)!==descriptorId) throw new TypeError('descriptor_id no coincide.');
  return {descriptor_id:descriptorId,project:canonical.project,operation:'restore_disposable',backup_id:canonical.backup_id,checksum_sha256:canonical.checksum_sha256,target_ref:canonical.target.target_ref,idempotency_key:canonical.idempotency_key};
}

function result(value:unknown,command:RecoveryDatabaseCommand):RecoveryDatabaseResult{
  const raw=asRecord(value,'Recovery database driver result');
  if(raw.status!=='ok') throw new RecoveryDatabaseError();
  if(command.operation==='snapshot'){
    exactKeys(raw,['status','snapshot_ref','evidence_ref'],'Recovery database snapshot result');
    const snapshotRef=opaque(raw.snapshot_ref,'driver.snapshot_ref');
    if(snapshotRef!==command.snapshot_ref) throw new RecoveryDatabaseError();
    return {capability:'recovery.database.snapshot',operation:'snapshot',descriptor_id:command.descriptor_id,snapshot_ref:snapshotRef,evidence_ref:opaque(raw.evidence_ref,'evidence_ref')};
  }
  exactKeys(raw,['status','backup_id','checksum_sha256','target_ref','evidence_ref'],'Recovery database restore result');
  const backupId=opaque(raw.backup_id,'driver.backup_id');
  const digest=checksum(raw.checksum_sha256);
  const targetRef=opaque(raw.target_ref,'driver.target_ref');
  if(backupId!==command.backup_id||digest!==command.checksum_sha256||targetRef!==command.target_ref) throw new RecoveryDatabaseError();
  return {capability:'recovery.database.restore-disposable',operation:'restore_disposable',descriptor_id:command.descriptor_id,backup_id:backupId,checksum_sha256:digest,target_ref:targetRef,evidence_ref:opaque(raw.evidence_ref,'evidence_ref')};
}

export class RecoveryDatabaseAdapter {
  readonly id='recovery-database';
  readonly capabilities=Object.freeze<RecoveryDatabaseCapability[]>(['recovery.database.snapshot','recovery.database.restore-disposable']);
  readonly #driver:RecoveryDatabaseDriver;
  readonly #connectionRef:string;

  constructor(driver:RecoveryDatabaseDriver,connection_ref:string){
    if(!driver||typeof driver.execute!=='function') throw new TypeError('Recovery database driver requerido.');
    this.#driver=driver;this.#connectionRef=connectionRef(connection_ref);
  }

  async execute(capabilityInput:string,descriptorInput:unknown):Promise<RecoveryDatabaseResult>{
    const cap=capability(capabilityInput);
    const parsed=cap==='recovery.database.snapshot'?snapshotDescriptor(descriptorInput):restoreDescriptor(descriptorInput);
    const command=Object.freeze({...parsed,connection_ref:this.#connectionRef}) as RecoveryDatabaseCommand;
    let raw:unknown;
    try{raw=await this.#driver.execute(command);}
    catch{throw new RecoveryDatabaseError();}
    try{return Object.freeze(result(raw,command));}
    catch(error){if(error instanceof RecoveryDatabaseError) throw error;throw new RecoveryDatabaseError();}
  }
}
