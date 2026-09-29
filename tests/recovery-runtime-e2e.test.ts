import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecoveryDatabaseAdapter,
  RecoveryGoogleDriveAdapter,
  RecoveryObjectStorageAdapter,
} from '../src/index.ts';
import type {
  RecoveryDatabaseCommand,
  RecoveryDatabaseDriver,
  RecoveryGoogleDriveCommand,
  RecoveryGoogleDriveDriver,
  RecoveryObjectStorageCommand,
  RecoveryObjectStorageDriver,
} from '../src/index.ts';
import { stableSha256 } from '../src/validation.ts';

function objectStorageDescriptor(operation:'upload'|'materialize'|'verify'='upload'){
  const value={
    version:1,project:'controlbot',provider:'object_storage',role:'primary_offsite',
    operation,namespace:'recovery:controlbot',object_ref:'object:primary-001',
    checksum_sha256:'a'.repeat(64),idempotency_key:'object-primary:001',
    authority:'unchanged',execute:false,
  };
  return {...value,descriptor_id:stableSha256(value)};
}

function googleDriveDescriptor(operation:'upload'|'materialize'|'verify'='upload'){
  const value={
    version:1,project:'controlbot',provider:'google_drive',role:'cold_copy',
    operation,namespace:'recovery:controlbot',object_ref:'object:cold-001',
    checksum_sha256:'b'.repeat(64),idempotency_key:'object-cold:001',
    authority:'unchanged',execute:false,
  };
  return {...value,descriptor_id:stableSha256(value)};
}

function databaseSnapshotDescriptor(){
  const value={
    version:1,project:'controlbot',source:'database',operation:'snapshot',
    snapshot_ref:'snapshot:db-001',idempotency_key:'db-snapshot:001',
    authority:'unchanged',execute:false,
  };
  return {...value,descriptor_id:stableSha256(value)};
}

function databaseRestoreDescriptor(kind='disposable'){
  const value={
    version:1,project:'controlbot',source:'database',operation:'restore_disposable',
    backup_id:'backup:db-001',checksum_sha256:'c'.repeat(64),
    target:{kind,target_ref:'target:db-verify-001'},
    idempotency_key:'db-restore:001',authority:'unchanged',execute:false,
  };
  return {...value,descriptor_id:stableSha256(value)};
}

function harness(){
  const objectCommands:RecoveryObjectStorageCommand[]=[];
  const driveCommands:RecoveryGoogleDriveCommand[]=[];
  const databaseCommands:RecoveryDatabaseCommand[]=[];

  const objectDriver:RecoveryObjectStorageDriver={
    async execute(command){
      objectCommands.push(command);
      return {
        status:'ok',object_ref:command.object_ref,checksum_sha256:command.checksum_sha256,
        immutable_version_ref:'version:object-001',evidence_ref:'evidence:object-001',
      };
    },
  };
  const driveDriver:RecoveryGoogleDriveDriver={
    async execute(command){
      driveCommands.push(command);
      return {
        status:'ok',object_ref:command.object_ref,checksum_sha256:command.checksum_sha256,
        remote_version_ref:'drive-version:001',evidence_ref:'evidence:drive-001',
      };
    },
  };
  const databaseDriver:RecoveryDatabaseDriver={
    async execute(command){
      databaseCommands.push(command);
      if(command.operation==='snapshot'){
        return {
          status:'ok',snapshot_ref:command.snapshot_ref,evidence_ref:'evidence:db-snapshot-001',
        };
      }
      return {
        status:'ok',backup_id:command.backup_id,checksum_sha256:command.checksum_sha256,
        target_ref:command.target_ref,evidence_ref:'evidence:db-restore-001',
      };
    },
  };

  return {
    objectCommands,driveCommands,databaseCommands,
    object:new RecoveryObjectStorageAdapter(objectDriver,'controlbot:connection/recovery-primary'),
    drive:new RecoveryGoogleDriveAdapter(driveDriver,'controlbot:connection/recovery-drive'),
    database:new RecoveryDatabaseAdapter(databaseDriver,'controlbot:connection/recovery-db'),
  };
}

function assertSanitized(value:unknown){
  const serialized=JSON.stringify(value).toLowerCase();
  for(const forbidden of [
    'password','passwd','bearer ','oauth','service_account','private_key',
    'mysql://','postgres://','https://','http://','drop table','select *',
  ]) assert.equal(serialized.includes(forbidden),false,`payload leaked forbidden text: ${forbidden}`);
}

test('object storage and Google Drive execute descriptor to evidence with exact roles and refs',async()=>{
  const h=harness();
  const primary=objectStorageDescriptor();
  const cold=googleDriveDescriptor();

  const primaryEvidence=await h.object.execute('recovery.object-storage.upload',primary);
  const coldEvidence=await h.drive.execute('recovery.google-drive.upload',cold);

  assert.equal(primaryEvidence.descriptor_id,primary.descriptor_id);
  assert.equal(primaryEvidence.object_ref,primary.object_ref);
  assert.equal(primaryEvidence.checksum_sha256,primary.checksum_sha256);
  assert.equal(primaryEvidence.immutable_version_ref,'version:object-001');

  assert.equal(coldEvidence.descriptor_id,cold.descriptor_id);
  assert.equal(coldEvidence.object_ref,cold.object_ref);
  assert.equal(coldEvidence.checksum_sha256,cold.checksum_sha256);
  assert.equal(coldEvidence.remote_version_ref,'drive-version:001');

  assert.equal(h.objectCommands.length,1);
  assert.equal(h.driveCommands.length,1);
  assert.equal('role' in h.objectCommands[0]!,false);
  assert.equal('role' in h.driveCommands[0]!,false);
});

test('database snapshot and disposable restore execute descriptor to evidence only',async()=>{
  const h=harness();
  const snapshot=databaseSnapshotDescriptor();
  const restore=databaseRestoreDescriptor();

  const snapshotEvidence=await h.database.execute('recovery.database.snapshot',snapshot);
  const restoreEvidence=await h.database.execute('recovery.database.restore-disposable',restore);

  assert.equal(snapshotEvidence.descriptor_id,snapshot.descriptor_id);
  assert.equal(snapshotEvidence.operation,'snapshot');
  assert.equal(snapshotEvidence.snapshot_ref,snapshot.snapshot_ref);

  assert.equal(restoreEvidence.descriptor_id,restore.descriptor_id);
  assert.equal(restoreEvidence.operation,'restore_disposable');
  assert.equal(restoreEvidence.backup_id,restore.backup_id);
  assert.equal(restoreEvidence.checksum_sha256,restore.checksum_sha256);
  assert.equal(restoreEvidence.target_ref,restore.target.target_ref);

  await assert.rejects(
    ()=>h.database.execute('recovery.database.restore-disposable',databaseRestoreDescriptor('production')),
    /disposable/,
  );
  assert.equal(h.databaseCommands.length,2);
});

test('commands and aggregated evidence remain secret-free across all Recovery adapters',async()=>{
  const h=harness();
  const evidence=[
    await h.object.execute('recovery.object-storage.upload',objectStorageDescriptor()),
    await h.drive.execute('recovery.google-drive.upload',googleDriveDescriptor()),
    await h.database.execute('recovery.database.snapshot',databaseSnapshotDescriptor()),
    await h.database.execute('recovery.database.restore-disposable',databaseRestoreDescriptor()),
  ];

  assertSanitized(h.objectCommands);
  assertSanitized(h.driveCommands);
  assertSanitized(h.databaseCommands);
  assertSanitized(evidence);

  for(const command of [...h.objectCommands,...h.driveCommands,...h.databaseCommands]){
    assert.equal('authority' in command,false);
    assert.equal('execute' in command,false);
  }
});

test('cross-provider and cross-capability inputs fail closed before fake drivers run',async()=>{
  const h=harness();

  await assert.rejects(
    ()=>h.object.execute('recovery.object-storage.upload',googleDriveDescriptor()),
    /fuera de contrato/,
  );
  await assert.rejects(
    ()=>h.drive.execute('recovery.google-drive.upload',objectStorageDescriptor()),
    /fuera de contrato/,
  );
  await assert.rejects(
    ()=>h.object.execute('recovery.object-storage.verify',objectStorageDescriptor('upload')),
    /no coinciden/,
  );
  await assert.rejects(
    ()=>h.database.execute('recovery.database.restore-disposable',databaseSnapshotDescriptor()),
    /no coinciden/,
  );

  assert.equal(h.objectCommands.length,0);
  assert.equal(h.driveCommands.length,0);
  assert.equal(h.databaseCommands.length,0);
});
