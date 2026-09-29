import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecoveryObjectStorageAdapter,
  RecoveryObjectStorageError,
} from '../src/index.ts';
import type {
  RecoveryObjectStorageCommand,
  RecoveryObjectStorageDriver,
} from '../src/index.ts';
import { stableSha256 } from '../src/validation.ts';

function descriptor(operation:'upload'|'materialize'|'verify'='upload',overrides:Record<string,unknown>={}){
  const base={
    version:1,project:'controlbot',provider:'object_storage',role:'primary_offsite',
    operation,namespace:'recovery:controlbot',object_ref:'object:001',
    checksum_sha256:'a'.repeat(64),idempotency_key:'backup:001',
    authority:'unchanged',execute:false,
  };
  const value={...base,...overrides};
  return {...value,descriptor_id:stableSha256(value)};
}

class FakeDriver implements RecoveryObjectStorageDriver {
  readonly commands:RecoveryObjectStorageCommand[]=[];
  constructor(readonly handler:(command:RecoveryObjectStorageCommand)=>unknown|Error){}
  async execute(command:RecoveryObjectStorageCommand):Promise<unknown>{
    this.commands.push(command);
    const value=this.handler(command);
    if(value instanceof Error) throw value;
    return value;
  }
}

function ok(command:RecoveryObjectStorageCommand,overrides:Record<string,unknown>={}){
  return {
    status:'ok',object_ref:command.object_ref,checksum_sha256:command.checksum_sha256,
    immutable_version_ref:'version:001',evidence_ref:'evidence:001',...overrides,
  };
}

test('Factory descriptor is exact and capability must match operation',async()=>{
  const driver=new FakeDriver((command)=>ok(command));
  const adapter=new RecoveryObjectStorageAdapter(driver,'controlbot:connection/recovery-primary');
  const result=await adapter.execute('recovery.object-storage.upload',descriptor('upload'));
  assert.equal(result.operation,'upload');
  assert.deepEqual(driver.commands[0],{
    connection_ref:'controlbot:connection/recovery-primary',
    descriptor_id:descriptor('upload').descriptor_id,
    project:'controlbot',operation:'upload',namespace:'recovery:controlbot',
    object_ref:'object:001',checksum_sha256:'a'.repeat(64),idempotency_key:'backup:001',
  });
  await assert.rejects(()=>adapter.execute('recovery.object-storage.verify',descriptor('upload')),/no coinciden/);
  await assert.rejects(()=>adapter.execute('recovery.object-storage.upload',{...descriptor(),extra:true}),/campos inválidos/);
});

test('driver boundary accepts opaque refs and rejects secrets or URLs',async()=>{
  const driver=new FakeDriver((command)=>ok(command));
  assert.throws(()=>new RecoveryObjectStorageAdapter(driver,'https://storage.example/token=secret'),/connection_ref/);
  const adapter=new RecoveryObjectStorageAdapter(driver,'controlbot:connection/recovery-primary');
  const unsafe=descriptor('upload',{object_ref:'https://bucket.example/object'});
  unsafe.descriptor_id=stableSha256(Object.fromEntries(Object.entries(unsafe).filter(([k])=>k!=='descriptor_id')));
  await assert.rejects(()=>adapter.execute('recovery.object-storage.upload',unsafe),/object_ref/);
  assert.equal(JSON.stringify(driver.commands).includes('secret'),false);
});

test('result requires matching object checksum and safe immutable evidence refs',async()=>{
  const good=new RecoveryObjectStorageAdapter(new FakeDriver((command)=>ok(command)),'controlbot:connection/recovery-primary');
  const result=await good.execute('recovery.object-storage.verify',descriptor('verify'));
  assert.equal(result.immutable_version_ref,'version:001');
  assert.equal(result.evidence_ref,'evidence:001');

  for(const overrides of [
    {object_ref:'object:other'},
    {checksum_sha256:'b'.repeat(64)},
    {immutable_version_ref:'https://unsafe.example/version'},
  ]){
    const adapter=new RecoveryObjectStorageAdapter(new FakeDriver((command)=>ok(command,overrides)),'controlbot:connection/recovery-primary');
    await assert.rejects(()=>adapter.execute('recovery.object-storage.verify',descriptor('verify')),RecoveryObjectStorageError);
  }
});

test('descriptor fingerprint and idempotency stay deterministic',async()=>{
  const driver=new FakeDriver((command)=>ok(command));
  const adapter=new RecoveryObjectStorageAdapter(driver,'controlbot:connection/recovery-primary');
  const value=descriptor('materialize');
  await adapter.execute('recovery.object-storage.materialize',value);
  await adapter.execute('recovery.object-storage.materialize',value);
  assert.equal(driver.commands[0].descriptor_id,driver.commands[1].descriptor_id);
  assert.equal(driver.commands[0].idempotency_key,driver.commands[1].idempotency_key);

  const tampered={...value,descriptor_id:'b'.repeat(64)};
  await assert.rejects(()=>adapter.execute('recovery.object-storage.materialize',tampered),/descriptor_id no coincide/);
});

test('driver failures are generic and unsupported capability never reaches driver',async()=>{
  const failing=new RecoveryObjectStorageAdapter(
    new FakeDriver(()=>new Error('Bearer supersecrettokenvalue')),
    'controlbot:connection/recovery-primary',
  );
  await assert.rejects(
    ()=>failing.execute('recovery.object-storage.upload',descriptor('upload')),
    (error:unknown)=>{
      assert.ok(error instanceof RecoveryObjectStorageError);
      assert.equal(error.message,'recovery_object_storage_failed');
      assert.equal(error.message.includes('supersecret'),false);
      return true;
    },
  );

  const driver=new FakeDriver((command)=>ok(command));
  const adapter=new RecoveryObjectStorageAdapter(driver,'controlbot:connection/recovery-primary');
  await assert.rejects(()=>adapter.execute('recovery.object-storage.delete',descriptor('upload')),/no soportada/);
  assert.equal(driver.commands.length,0);
});

test('adapter is exported and uses only injected driver with no network implementation',async()=>{
  const module=await import('../src/index.ts');
  assert.equal(typeof module.RecoveryObjectStorageAdapter,'function');
  const source=await import('node:fs/promises').then(({readFile})=>
    readFile(new URL('../src/adapters/recovery-object-storage.ts',import.meta.url),'utf8')
  );
  for(const forbidden of ('fetch(', 'http.request', 'https.request', 'execFile', 'spawn(')) assert.equal(source.includes(forbidden),false);
});
