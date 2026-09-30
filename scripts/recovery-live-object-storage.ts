import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RecoveryLiveObjectStorage,
  RecoveryLiveObjectStorageError,
} from '../src/recovery/live-object-storage.ts';

const MAX_INPUT=256_000;

export class RecoveryArtifactPathError extends Error {
  constructor(){super('recovery_artifact_path_invalid');this.name='RecoveryArtifactPathError';}
}

async function confinedPath(rootInput:string,pathInput:string,forWrite=false):Promise<string>{
  if(!isAbsolute(rootInput)||!isAbsolute(pathInput)) throw new RecoveryArtifactPathError();
  const root=await realpath(rootInput);
  const candidate=resolve(pathInput);
  const rel=relative(root,candidate);
  if(rel===''||rel.startsWith('..')||isAbsolute(rel)) throw new RecoveryArtifactPathError();
  const parent=await realpath(dirname(candidate));
  const parentRel=relative(root,parent);
  if(parentRel.startsWith('..')||isAbsolute(parentRel)) throw new RecoveryArtifactPathError();
  if(!forWrite){
    const actual=await realpath(candidate);
    const actualRel=relative(root,actual);
    if(actualRel.startsWith('..')||isAbsolute(actualRel)) throw new RecoveryArtifactPathError();
    const stat=await lstat(actual);
    if(!stat.isFile()||stat.isSymbolicLink()) throw new RecoveryArtifactPathError();
    return actual;
  }
  try{
    const stat=await lstat(candidate);
    if(stat.isSymbolicLink()||!stat.isFile()) throw new RecoveryArtifactPathError();
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
  }
  return candidate;
}

export async function runRecoveryLiveObjectStorageCli(
  raw:string,
  env:NodeJS.ProcessEnv=process.env,
):Promise<string>{
  if(Buffer.byteLength(raw)>MAX_INPUT) throw new RecoveryLiveObjectStorageError();
  let input:unknown;
  try{input=JSON.parse(raw);}catch{throw new RecoveryLiveObjectStorageError();}
  const root=env.FACTORYRUNNER_RECOVERY_ARTIFACT_ROOT;
  const artifact=env.FACTORYRUNNER_RECOVERY_ARTIFACT_PATH;
  if(!root||!artifact) throw new RecoveryArtifactPathError();
  const source={
    read:async()=>readFile(await confinedPath(root,artifact)),
  };
  const sink={
    write:async(_ref:string,body:Uint8Array)=>{
      const target=await confinedPath(root,artifact,true);
      await writeFile(target,body,{flag:'wx',mode:0o600});
    },
  };
  const result=await new RecoveryLiveObjectStorage({env,source,sink}).execute(input);
  return JSON.stringify(result);
}

async function main():Promise<number>{
  try{
    const chunks:Buffer[]=[];
    for await(const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    process.stdout.write(await runRecoveryLiveObjectStorageCli(Buffer.concat(chunks).toString('utf8'))+'\n');
    return 0;
  }catch{
    process.stderr.write('recovery_live_object_storage_failed\n');
    return 1;
  }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1])){
  process.exitCode=await main();
}
