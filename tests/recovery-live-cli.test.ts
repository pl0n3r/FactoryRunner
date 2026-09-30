import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  RecoveryArtifactPathError,
  runRecoveryLiveObjectStorageCli,
} from '../scripts/recovery-live-object-storage.ts';

test('CLI rejects missing alias runtime config without echoing input',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factoryrunner-recovery-'));
  const artifact=join(root,'backup.sql.gz'); await writeFile(artifact,'payload');
  await assert.rejects(
    ()=>runRecoveryLiveObjectStorageCli(JSON.stringify({capability:'recovery.object-storage.verify',connection_ref:'controlbot:connection/missing',descriptor:{secret:'do-not-echo'}}),{
      FACTORYRUNNER_RECOVERY_ARTIFACT_ROOT:root,FACTORYRUNNER_RECOVERY_ARTIFACT_PATH:artifact,
    }),
    (error:unknown)=>error instanceof Error&&!error.message.includes('do-not-echo'),
  );
});

test('artifact path is confined to root and rejects traversal/symlink',async()=>{
  const root=await mkdtemp(join(tmpdir(),'factoryrunner-recovery-'));
  const outside=await mkdtemp(join(tmpdir(),'factoryrunner-outside-'));
  const target=join(outside,'backup.sql.gz'); await writeFile(target,'payload');
  const link=join(root,'link.sql.gz'); await symlink(target,link);
  const payload='{}';
  for(const artifact of [target,link]){
    await assert.rejects(()=>runRecoveryLiveObjectStorageCli(payload,{
      FACTORYRUNNER_RECOVERY_ARTIFACT_ROOT:root,FACTORYRUNNER_RECOVERY_ARTIFACT_PATH:artifact,
    }),RecoveryArtifactPathError);
  }
  await mkdir(join(root,'nested'));
});

test('CLI module exposes only governed recovery surface and no destructive capability',async()=>{
  const source=await import('node:fs/promises').then(({readFile})=>readFile(new URL('../scripts/recovery-live-object-storage.ts',import.meta.url),'utf8'));
  for(const forbidden of ['recovery.object-storage.delete','retention.delete','restore.production','child_process','execFile','spawn(']) assert.equal(source.includes(forbidden),false);
  assert.equal(source.includes('FACTORYRUNNER_RECOVERY_ARTIFACT_ROOT'),true);
  assert.equal(source.includes('FACTORYRUNNER_RECOVERY_ARTIFACT_PATH'),true);
});
