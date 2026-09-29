import {
  asRecord, exactKeys, noSensitiveText, ref, stableSha256, stringValue,
} from '../validation.ts';

export type RecoveryObjectStorageCapability =
  | 'recovery.object-storage.upload'
  | 'recovery.object-storage.materialize'
  | 'recovery.object-storage.verify';

type Operation='upload'|'materialize'|'verify';

export type RecoveryObjectStorageCommand={
  connection_ref:string; descriptor_id:string; project:string; operation:Operation;
  namespace:string; object_ref:string; checksum_sha256:string; idempotency_key:string;
};

export type RecoveryObjectStorageDriverResult={
  status:'ok'|'not_found'|'checksum_mismatch'|'blocked';
  object_ref:string; checksum_sha256:string; immutable_version_ref:string; evidence_ref:string;
};

export interface RecoveryObjectStorageDriver {
  execute(command:RecoveryObjectStorageCommand):Promise<unknown>;
}

export type RecoveryObjectStorageResult={
  capability:RecoveryObjectStorageCapability; operation:Operation; descriptor_id:string;
  object_ref:string; checksum_sha256:string; immutable_version_ref:string; evidence_ref:string;
};

const CAPABILITIES=new Set<RecoveryObjectStorageCapability>([
  'recovery.object-storage.upload','recovery.object-storage.materialize','recovery.object-storage.verify',
]);
const OPERATIONS=new Set<Operation>(['upload','materialize','verify']);
const OPAQUE=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256=/^[0-9a-f]{64}$/;

export class RecoveryObjectStorageError extends Error {
  constructor(){super('recovery_object_storage_failed');this.name='RecoveryObjectStorageError';}
}

function opaque(value:unknown,label:string):string{
  const parsed=noSensitiveText(stringValue(value,label,128),label);
  if(!OPAQUE.test(parsed)||parsed.includes('..')||parsed.includes('://')) throw new TypeError(`${label} inválida.`);
  return parsed;
}

function checksum(value:unknown):string{
  const parsed=stringValue(value,'checksum_sha256',64);
  if(!SHA256.test(parsed)) throw new TypeError('checksum_sha256 inválido.');
  return parsed;
}

function connectionRef(value:unknown):string{
  const parsed=ref(value,'connection_ref',180);
  if(!parsed.startsWith('controlbot:connection/')||parsed.includes('@')||parsed.includes('..')||parsed.includes('://')){
    throw new TypeError('connection_ref inválida.');
  }
  return parsed;
}

function capability(value:string):RecoveryObjectStorageCapability{
  if(!CAPABILITIES.has(value as RecoveryObjectStorageCapability)) throw new TypeError('Recovery object-storage capability no soportada.');
  return value as RecoveryObjectStorageCapability;
}

function parseDescriptor(value:unknown):RecoveryObjectStorageCommand{
  const r=asRecord(value,'Recovery adapter descriptor');
  exactKeys(r,['version','project','provider','role','operation','namespace','object_ref','checksum_sha256','idempotency_key','authority','execute','descriptor_id'],'Recovery adapter descriptor');
  if(r.version!==1||r.provider!=='object_storage'||r.role!=='primary_offsite'||r.authority!=='unchanged'||r.execute!==false){
    throw new TypeError('Recovery adapter descriptor fuera de contrato.');
  }
  if(typeof r.operation!=='string'||!OPERATIONS.has(r.operation as Operation)) throw new TypeError('Recovery operation inválida.');
  const base={
    version:1, project:opaque(r.project,'project'), provider:'object_storage', role:'primary_offsite',
    operation:r.operation as Operation, namespace:opaque(r.namespace,'namespace'),
    object_ref:opaque(r.object_ref,'object_ref'), checksum_sha256:checksum(r.checksum_sha256),
    idempotency_key:opaque(r.idempotency_key,'idempotency_key'), authority:'unchanged', execute:false,
  } as const;
  const descriptorId=checksum(r.descriptor_id);
  if(stableSha256(base)!==descriptorId) throw new TypeError('descriptor_id no coincide.');
  return {
    connection_ref:'', descriptor_id:descriptorId, project:base.project, operation:base.operation,
    namespace:base.namespace, object_ref:base.object_ref, checksum_sha256:base.checksum_sha256,
    idempotency_key:base.idempotency_key,
  };
}

function parseDriverResult(value:unknown,command:RecoveryObjectStorageCommand):RecoveryObjectStorageDriverResult{
  const r=asRecord(value,'Recovery object-storage driver result');
  exactKeys(r,['status','object_ref','checksum_sha256','immutable_version_ref','evidence_ref'],'Recovery object-storage driver result');
  if(r.status!=='ok') throw new RecoveryObjectStorageError();
  const objectRef=opaque(r.object_ref,'driver.object_ref');
  const digest=checksum(r.checksum_sha256);
  if(objectRef!==command.object_ref||digest!==command.checksum_sha256) throw new RecoveryObjectStorageError();
  return {
    status:'ok', object_ref:objectRef, checksum_sha256:digest,
    immutable_version_ref:opaque(r.immutable_version_ref,'immutable_version_ref'),
    evidence_ref:opaque(r.evidence_ref,'evidence_ref'),
  };
}

export class RecoveryObjectStorageAdapter {
  readonly id='recovery-object-storage';
  readonly capabilities=Object.freeze([...CAPABILITIES]);
  readonly #driver:RecoveryObjectStorageDriver;
  readonly #connectionRef:string;

  constructor(driver:RecoveryObjectStorageDriver,connection_ref:string){
    if(!driver||typeof driver.execute!=='function') throw new TypeError('Recovery object-storage driver requerido.');
    this.#driver=driver;this.#connectionRef=connectionRef(connection_ref);
  }

  async execute(capabilityInput:string,descriptorInput:unknown):Promise<RecoveryObjectStorageResult>{
    const cap=capability(capabilityInput);
    const command=parseDescriptor(descriptorInput);
    const expected=cap.slice('recovery.object-storage.'.length);
    if(command.operation!==expected) throw new TypeError('Capability y operation no coinciden.');
    command.connection_ref=this.#connectionRef;

    let raw:unknown;
    try{raw=await this.#driver.execute(Object.freeze({...command}));}
    catch{throw new RecoveryObjectStorageError();}
    let result:RecoveryObjectStorageDriverResult;
    try{result=parseDriverResult(raw,command);}
    catch(error){if(error instanceof RecoveryObjectStorageError) throw error;throw new RecoveryObjectStorageError();}

    return Object.freeze({
      capability:cap, operation:command.operation, descriptor_id:command.descriptor_id,
      object_ref:result.object_ref, checksum_sha256:result.checksum_sha256,
      immutable_version_ref:result.immutable_version_ref, evidence_ref:result.evidence_ref,
    });
  }
}
