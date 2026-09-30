import { RecoveryObjectStorageAdapter } from '../adapters/recovery-object-storage.ts';
import type { RecoveryObjectStorageResult } from '../adapters/recovery-object-storage.ts';
import { resolveRecoveryS3Connection } from './connection-resolver.ts';
import {
  S3CompatibleRecoveryDriver,
} from './s3-compatible-driver.ts';
import type {
  RecoveryArtifactSink, RecoveryArtifactSource, RecoveryS3Transport,
} from './s3-compatible-driver.ts';

const KEYS=new Set(['capability','connection_ref','descriptor']);
const SENSITIVE=/access[_-]?key|secret|password|passwd|token|dsn|signed[_-]?url|private[_-]?key/i;

export type RecoveryLiveObjectStorageInput={
  capability:string;
  connection_ref:string;
  descriptor:unknown;
};

export class RecoveryLiveObjectStorageError extends Error {
  constructor(){super('recovery_live_object_storage_failed');this.name='RecoveryLiveObjectStorageError';}
}

function input(value:unknown):RecoveryLiveObjectStorageInput{
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new RecoveryLiveObjectStorageError();
  const raw=value as Record<string,unknown>;
  if(Object.keys(raw).some(key=>!KEYS.has(key)||SENSITIVE.test(key))) throw new RecoveryLiveObjectStorageError();
  if(typeof raw.capability!=='string'||typeof raw.connection_ref!=='string'||!('descriptor' in raw)) throw new RecoveryLiveObjectStorageError();
  if(SENSITIVE.test(JSON.stringify(Object.keys(raw)))) throw new RecoveryLiveObjectStorageError();
  return {capability:raw.capability,connection_ref:raw.connection_ref,descriptor:raw.descriptor};
}

export class RecoveryLiveObjectStorage {
  readonly #env:NodeJS.ProcessEnv;
  readonly #source:RecoveryArtifactSource;
  readonly #sink:RecoveryArtifactSink;
  readonly #transport?:RecoveryS3Transport;
  readonly #clock?:()=>Date;

  constructor(options:{
    env?:NodeJS.ProcessEnv; source:RecoveryArtifactSource; sink:RecoveryArtifactSink;
    transport?:RecoveryS3Transport; clock?:()=>Date;
  }){
    this.#env=options.env??process.env;
    this.#source=options.source;
    this.#sink=options.sink;
    this.#transport=options.transport;
    this.#clock=options.clock;
  }

  async execute(value:unknown):Promise<RecoveryObjectStorageResult>{
    try{
      const parsed=input(value);
      const config=resolveRecoveryS3Connection(parsed.connection_ref,this.#env);
      const driver=new S3CompatibleRecoveryDriver({
        config,source:this.#source,sink:this.#sink,
        ...(this.#transport?{transport:this.#transport}:{}),
        ...(this.#clock?{clock:this.#clock}:{}),
      });
      return await new RecoveryObjectStorageAdapter(driver,parsed.connection_ref).execute(parsed.capability,parsed.descriptor);
    }catch{throw new RecoveryLiveObjectStorageError();}
  }
}
