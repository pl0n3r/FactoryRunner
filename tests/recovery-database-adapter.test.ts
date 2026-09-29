import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecoveryDatabaseAdapter, RecoveryDatabaseError,
} from '../src/index.ts';
import type {
  RecoveryDatabaseCommand, RecoveryDatabaseDriver,
} from '../src/index.ts';
import { stableSha256 } from '../src/validation.ts';

function snapshot(overrides:Record<string,unknown>={}){
  const base={
    version:1,project:'controlbot',source:'database',operation:'snapshot',
    snapshot_ref:'snapshot:001',idempotency_key:'db-snapshot:001',
    authority:'unchanged',execute:false,
  };
  const value={...base,...overrides};
  return {...value,descriptor_id:stableSha256(value)};
}
function restore(overrides:Record<string,unknown>={}){
  const base={
    version:1,project:'controlbot',source:'database',operation:'restore_disposable',
    backup_id:'backup:001',checksum_sha256:'a'.repeat(64),
    target:{kind:'disposable',target_ref:'target:001'},
    idempotency_key:'db-restore:001',authority:'unchanged',execute:false,
  };
  const value={...base,...overrides};
  return {...value,descriptor_id:stableSha256(value)};
}
class FakeDb implements RecoveryDatabaseDriver {
  readonly commands:RecoveryDatabaseCommand[]=[];
  readonly handler:(command:RecoveryDatabaseCommand)=>unknown|Error;
  constructor(handler:(command:RecoveryDatabaseCommand)=>unknown|Error){this.handler=handler;}
  async execute(command:RecoveryDatabaseCommand):Promise<unknown>{
    this.commands.push(command);
    const value=this.handler(command);
    if(value instanceof Error) throw value;
    return value;
  }
}
function ok(command:RecoveryDatabaseCommand,extra:Record<string,unknown>={}){
  if(command.operation==='snapshot') return {status:'ok',snapshot_ref:command.snapshot_ref,evidence_ref:'evidence:snapshot-001',...extra};
  return {status:'ok',backup_id:command.backup_id,checksum_sha256:command.checksum_sha256,target_ref:command.target_ref,evidence_ref:'evidence:restore-001',...extra};
}

test('snapshot descriptor and capability contract',async()=>{
  const driver=new FakeDb((command)=>ok(command));
  const adapter=new RecoveryDatabaseAdapter(driver,'controlbot:connection/recovery-db');
  const value=snapshot();
  const out=await adapter.execute('recovery.database.snapshot',value);
  assert.equal(out.operation,'snapshot');
  assert.equal(driver.commands[0]?.connection_ref,'controlbot:connection/recovery-db');
  await assert.rejects(()=>adapter.execute('recovery.database.restore-disposable',value),/restore descriptor/);
  await assert.rejects(()=>adapter.execute('recovery.database.snapshot',snapshot({source:'media'})),/fuera de contrato/);
  await assert.rejects(()=>adapter.execute('recovery.database.snapshot',{...snapshot(),extra:true}),/campos inválidos/);
});

test('restore is disposable only and rejects production targets',async()=>{
  const adapter=new RecoveryDatabaseAdapter(new FakeDb((command)=>ok(command)),'controlbot:connection/recovery-db');
  const out=await adapter.execute('recovery.database.restore-disposable',restore());
  assert.equal(out.operation,'restore_disposable');
  assert.equal(out.target_ref,'target:001');
  for(const kind of ['production','live','cutover']){
    await assert.rejects(
      ()=>adapter.execute('recovery.database.restore-disposable',restore({target:{kind,target_ref:'target:001'}})),
      /disposable/,
    );
  }
  await assert.rejects(
    ()=>adapter.execute('recovery.database.restore-disposable',restore({checksum_sha256:'bad'})),
    /checksum_sha256/,
  );
});

test('driver boundary rejects DSN credentials SQL URLs and extras',async()=>{
  const driver=new FakeDb((command)=>ok(command));
  for(const ref of ['mysql://db.example/app','controlbot:connection/password=secret','controlbot:connection/user@example.com']){
    assert.throws(()=>new RecoveryDatabaseAdapter(driver,ref),/connection_ref/);
  }
  const adapter=new RecoveryDatabaseAdapter(driver,'controlbot:connection/recovery-db');
  await assert.rejects(()=>adapter.execute('recovery.database.snapshot',snapshot({snapshot_ref:'https://db.example/dump'})),/snapshot_ref/);
  await assert.rejects(()=>adapter.execute('recovery.database.snapshot',{...snapshot(),sql:'DROP TABLE users'}),/campos inválidos/);
  assert.equal(JSON.stringify(driver.commands).includes('DROP TABLE'),false);
});

test('results must match descriptor and driver failures are generic',async()=>{
  for(const extra of [{snapshot_ref:'snapshot:other'},{evidence_ref:'https://unsafe.example/e'}]){
    const adapter=new RecoveryDatabaseAdapter(new FakeDb((command)=>ok(command,extra)),'controlbot:connection/recovery-db');
    await assert.rejects(()=>adapter.execute('recovery.database.snapshot',snapshot()),RecoveryDatabaseError);
  }
  for(const extra of [{backup_id:'backup:other'},{checksum_sha256:'b'.repeat(64)},{target_ref:'target:other'}]){
    const adapter=new RecoveryDatabaseAdapter(new FakeDb((command)=>ok(command,extra)),'controlbot:connection/recovery-db');
    await assert.rejects(()=>adapter.execute('recovery.database.restore-disposable',restore()),RecoveryDatabaseError);
  }
  const failing=new RecoveryDatabaseAdapter(new FakeDb(()=>new Error('password=supersecret')),'controlbot:connection/recovery-db');
  await assert.rejects(
    ()=>failing.execute('recovery.database.snapshot',snapshot()),
    (error:unknown)=>error instanceof RecoveryDatabaseError&&error.message==='recovery_database_failed'&&!error.message.includes('supersecret'),
  );
});

test('fingerprint idempotency and authority stay deterministic',async()=>{
  const driver=new FakeDb((command)=>ok(command));
  const adapter=new RecoveryDatabaseAdapter(driver,'controlbot:connection/recovery-db');
  const value=restore();
  await adapter.execute('recovery.database.restore-disposable',value);
  await adapter.execute('recovery.database.restore-disposable',value);
  assert.equal(driver.commands[0]?.descriptor_id,driver.commands[1]?.descriptor_id);
  assert.equal(driver.commands[0]?.idempotency_key,driver.commands[1]?.idempotency_key);
  await assert.rejects(()=>adapter.execute('recovery.database.restore-disposable',{...value,descriptor_id:'b'.repeat(64)}),/descriptor_id/);
  await assert.rejects(()=>adapter.execute('recovery.database.snapshot',snapshot({authority:'expanded'})),/fuera de contrato/);
});

test('adapter is exported and has no real database or process implementation',async()=>{
  const module=await import('../src/index.ts');
  assert.equal(typeof module.RecoveryDatabaseAdapter,'function');
  const source=await import('node:fs/promises').then(({readFile})=>
    readFile(new URL('../src/adapters/recovery-database.ts',import.meta.url),'utf8')
  );
  for(const forbidden of ['fetch(', 'execFile', 'spawn(', 'mysql2', 'pg_dump', 'mysqldump']) assert.equal(source.includes(forbidden),false);
});
