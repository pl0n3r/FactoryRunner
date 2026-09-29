import {
  asRecord, exactKeys, noSensitiveText, ref, stableSha256, stringValue,
} from '../validation.ts';

const OPERATIONS=['upload','materialize','verify'] as const;
type Operation=typeof OPERATIONS[number];
export type RecoveryGoogleDriveCapability=`recovery.google-drive.${Operation}`;

export type RecoveryGoogleDriveCommand={
  connection_ref:string; descriptor_id:string; project:string; operation:Operation;
  namespace:string; object_ref:string; checksum_sha256:string; idempotency_key:string;
};
export type RecoveryGoogleDriveDriverResult={
  status:'ok'|'not_found'|'checksum_mismatch'|'blocked';
  object_ref:string; checksum_sha256:string; remote_version_ref:string; evidence_ref:string;
};
export interface RecoveryGoogleDriveDriver {
  execute(command:RecoveryGoogleDriveCommand):Promise<unknown>;
}
export type RecoveryGoogleDriveResult={
  capability:RecoveryGoogleDriveCapability; operation:Operation; descriptor_id:string;
  object_ref:string; checksum_sha256:string; remote_version_ref:string; evidence_ref:string;
};

const CAPABILITIES=Object.freeze(OPERATIONS.map(
  (operation)=>`recovery.google-drive.${operation}` as RecoveryGoogleDriveCapability,
));
const REFISH=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST=/^[0-9a-f]{64}$/;
const CREDENTIAL_WORDS=/(?:oauth|token|secret|password|credential|service[_-]?account)/i;

export class RecoveryGoogleDriveError extends Error {
  constructor(){super('recovery_google_drive_failed');this.name='RecoveryGoogleDriveError';}
}

function safeOpaque(value:unknown,label:string):string{
  const parsed=noSensitiveText(stringValue(value,label,128),label);
  if(!REFISH.test(parsed)||parsed.includes('://')||parsed.includes('..')||parsed.includes('@')){
    throw new TypeError(`${label} inválida.`);
  }
  return parsed;
}
function sha256(value:unknown,label='checksum_sha256'):string{
  const parsed=stringValue(value,label,64);
  if(!DIGEST.test(parsed)) throw new TypeError(`${label} inválido.`);
  return parsed;
}
function operation(value:unknown):Operation{
  if(typeof value!=='string'||!OPERATIONS.includes(value as Operation)) throw new TypeError('Recovery operation inválida.');
  return value as Operation;
}
function driveConnection(value:unknown):string{
  const parsed=ref(value,'connection_ref',180);
  if(!parsed.startsWith('controlbot:connection/')
    ||parsed.includes('://')||parsed.includes('..')||parsed.includes('@')
    ||CREDENTIAL_WORDS.test(parsed)){
    throw new TypeError('connection_ref inválida.');
  }
  return parsed;
}
function capability(value:string):RecoveryGoogleDriveCapability{
  if(!CAPABILITIES.includes(value as RecoveryGoogleDriveCapability)){
    throw new TypeError('Recovery Google Drive capability no soportada.');
  }
  return value as RecoveryGoogleDriveCapability;
}

function descriptor(value:unknown):Omit<RecoveryGoogleDriveCommand,'connection_ref'>{
  const raw=asRecord(value,'Recovery Google Drive descriptor');
  const keys=['version','project','provider','role','operation','namespace','object_ref','checksum_sha256','idempotency_key','authority','execute','descriptor_id'] as const;
  exactKeys(raw,keys,'Recovery Google Drive descriptor');
  if(raw.version!==1||raw.provider!=='google_drive'||raw.role!=='cold_copy'
    ||raw.authority!=='unchanged'||raw.execute!==false){
    throw new TypeError('Recovery Google Drive descriptor fuera de contrato.');
  }
  const op=operation(raw.operation);
  const canonical={
    version:1,
    project:safeOpaque(raw.project,'project'),
    provider:'google_drive',
    role:'cold_copy',
    operation:op,
    namespace:safeOpaque(raw.namespace,'namespace'),
    object_ref:safeOpaque(raw.object_ref,'object_ref'),
    checksum_sha256:sha256(raw.checksum_sha256),
    idempotency_key:safeOpaque(raw.idempotency_key,'idempotency_key'),
    authority:'unchanged',
    execute:false,
  } as const;
  const descriptorId=sha256(raw.descriptor_id,'descriptor_id');
  if(stableSha256(canonical)!==descriptorId) throw new TypeError('descriptor_id no coincide.');
  return {
    descriptor_id:descriptorId,
    project:canonical.project,
    operation:canonical.operation,
    namespace:canonical.namespace,
    object_ref:canonical.object_ref,
    checksum_sha256:canonical.checksum_sha256,
    idempotency_key:canonical.idempotency_key,
  };
}

function driverResult(value:unknown,command:RecoveryGoogleDriveCommand):RecoveryGoogleDriveDriverResult{
  const raw=asRecord(value,'Recovery Google Drive driver result');
  exactKeys(raw,['status','object_ref','checksum_sha256','remote_version_ref','evidence_ref'],'Recovery Google Drive driver result');
  if(raw.status!=='ok') throw new RecoveryGoogleDriveError();
  const objectRef=safeOpaque(raw.object_ref,'driver.object_ref');
  const digest=sha256(raw.checksum_sha256);
  if(objectRef!==command.object_ref||digest!==command.checksum_sha256) throw new RecoveryGoogleDriveError();
  return {
    status:'ok',
    object_ref:objectRef,
    checksum_sha256:digest,
    remote_version_ref:safeOpaque(raw.remote_version_ref,'remote_version_ref'),
    evidence_ref:safeOpaque(raw.evidence_ref,'evidence_ref'),
  };
}

export class RecoveryGoogleDriveAdapter {
  readonly id='recovery-google-drive';
  readonly capabilities=CAPABILITIES;
  readonly #driver:RecoveryGoogleDriveDriver;
  readonly #connectionRef:string;

  constructor(driver:RecoveryGoogleDriveDriver,connection_ref:string){
    if(!driver||typeof driver.execute!=='function') throw new TypeError('Recovery Google Drive driver requerido.');
    this.#driver=driver;
    this.#connectionRef=driveConnection(connection_ref);
  }

  async execute(capabilityInput:string,descriptorInput:unknown):Promise<RecoveryGoogleDriveResult>{
    const cap=capability(capabilityInput);
    const parsed=descriptor(descriptorInput);
    if(cap!==`recovery.google-drive.${parsed.operation}`) throw new TypeError('Capability y operation no coinciden.');
    const command=Object.freeze({...parsed,connection_ref:this.#connectionRef});
    let raw:unknown;
    try{raw=await this.#driver.execute(command);}
    catch{throw new RecoveryGoogleDriveError();}
    let result:RecoveryGoogleDriveDriverResult;
    try{result=driverResult(raw,command);}
    catch(error){if(error instanceof RecoveryGoogleDriveError) throw error;throw new RecoveryGoogleDriveError();}
    return Object.freeze({
      capability:cap,
      operation:parsed.operation,
      descriptor_id:parsed.descriptor_id,
      object_ref:result.object_ref,
      checksum_sha256:result.checksum_sha256,
      remote_version_ref:result.remote_version_ref,
      evidence_ref:result.evidence_ref,
    });
  }
}
