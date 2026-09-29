import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RecoveryGoogleDriveAdapter,
  RecoveryGoogleDriveError,
} from '../src/index.ts';
import type {
  RecoveryGoogleDriveCommand,
  RecoveryGoogleDriveDriver,
} from '../src/index.ts';
import { stableSha256 } from '../src/validation.ts';

type Operation='upload'|'materialize'|'verify';
function descriptor(operation:Operation='upload',overrides:Record<string,unknown>={}){
  const canonical={
    version:1,project:'controlbot',provider:'google_drive',role:'cold_copy',
    operation,namespace:'recovery:controlbot',object_ref:'object:001',
    checksum_sha256:'a'.repeat(64),idempotency_key:'coldcopy:001',
    authority:'unchanged',execute:false,
  };
  const value={...canonical,...overrides};
  return {...value,descriptor_id:stableSha256(value)};
}
class FakeDrive implements RecoveryGoogleDriveDriver {
  readonly commands:RecoveryGoogleDriveCommand[]=[];
  readonly handler:(command:RecoveryGoogleDriveCommand)=>unknown|Error;
  constructor(handler:(command:RecoveryGoogleDriveCommand)=>unknown|Error){this.handler=handler;}
  async execute(command:RecoveryGoogleDriveCommand):Promise<unknown>{
    this.commands.push(command);
    const result=this.handler(command);
    if(result instanceof Error) throw result;
    return result;
  }
}
function success(command:RecoveryGoogleDriveCommand,extra:Record<string,unknown>={}){
  return {
    status:'ok',object_ref:command.object_ref,checksum_sha256:command.checksum_sha256,
    remote_version_ref:'drive-version:001',evidence_ref:'evidence:drive-001',...extra,
  };
}

test('google drive descriptor is cold-copy and capability matches operation',async()=>{
  const driver=new FakeDrive((command)=>success(command));
  const adapter=new RecoveryGoogleDriveAdapter(driver,'controlbot:connection/recovery-drive');
  const result=await adapter.execute('recovery.google-drive.upload',descriptor());
  assert.equal(result.operation,'upload');
  assert.equal(driver.commands[0]?.connection_ref,'controlbot:connection/recovery-drive');
  await assert.rejects(()=>adapter.execute('recovery.google-drive.verify',descriptor('upload')),/no coinciden/);
  for(const bad of [
    descriptor('upload',{provider:'object_storage'}),
    descriptor('upload',{role:'primary_offsite'}),
    descriptor('upload',{provider:'icloud'}),
  ]) await assert.rejects(()=>adapter.execute('recovery.google-drive.upload',bad),/fuera de contrato/);
});

test('driver boundary rejects credential material URLs and extra fields',async()=>{
  const driver=new FakeDrive((command)=>success(command));
  for(const ref of [
    'controlbot:connection/oauth-token',
    'controlbot:connection/service-account',
    'https://drive.example/shared',
    'person@example.invalid',
  ]) assert.throws(()=>new RecoveryGoogleDriveAdapter(driver,ref),/connection_ref/);
  const adapter=new RecoveryGoogleDriveAdapter(driver,'controlbot:connection/recovery-drive');
  for(const field of ['oauth_token','service_account','email','shared_url','provider_payload']){
    const raw={...descriptor(),[field]:'forbidden'};
    await assert.rejects(()=>adapter.execute('recovery.google-drive.upload',raw),/campos inválidos/);
  }
  assert.equal(driver.commands.length,0);
});

test('successful result must match object and checksum with safe remote evidence refs',async()=>{
  const good=new RecoveryGoogleDriveAdapter(new FakeDrive((command)=>success(command)),'controlbot:connection/recovery-drive');
  const result=await good.execute('recovery.google-drive.verify',descriptor('verify'));
  assert.equal(result.remote_version_ref,'drive-version:001');
  for(const extra of [
    {object_ref:'object:other'},
    {checksum_sha256:'b'.repeat(64)},
    {remote_version_ref:'https://drive.example/version'},
    {evidence_ref:'person@example.invalid'},
  ]){
    const adapter=new RecoveryGoogleDriveAdapter(new FakeDrive((command)=>success(command,extra)),'controlbot:connection/recovery-drive');
    await assert.rejects(()=>adapter.execute('recovery.google-drive.verify',descriptor('verify')),RecoveryGoogleDriveError);
  }
});

test('fingerprint idempotency and cold-copy contract are deterministic',async()=>{
  const driver=new FakeDrive((command)=>success(command));
  const adapter=new RecoveryGoogleDriveAdapter(driver,'controlbot:connection/recovery-drive');
  const value=descriptor('materialize');
  await adapter.execute('recovery.google-drive.materialize',value);
  await adapter.execute('recovery.google-drive.materialize',value);
  assert.equal(driver.commands[0]?.descriptor_id,driver.commands[1]?.descriptor_id);
  assert.equal(driver.commands[0]?.idempotency_key,driver.commands[1]?.idempotency_key);
  await assert.rejects(
    ()=>adapter.execute('recovery.google-drive.materialize',{...value,descriptor_id:'b'.repeat(64)}),
    /descriptor_id no coincide/,
  );
});

test('driver errors are generic and unsupported capability never reaches driver',async()=>{
  const failing=new RecoveryGoogleDriveAdapter(
    new FakeDrive(()=>new Error('oauth_token=super-secret-provider-value')),
    'controlbot:connection/recovery-drive',
  );
  await assert.rejects(
    ()=>failing.execute('recovery.google-drive.upload',descriptor()),
    (error:unknown)=>{
      assert.ok(error instanceof RecoveryGoogleDriveError);
      assert.equal(error.message,'recovery_google_drive_failed');
      assert.equal(error.message.includes('provider-value'),false);
      return true;
    },
  );
  const driver=new FakeDrive((command)=>success(command));
  const adapter=new RecoveryGoogleDriveAdapter(driver,'controlbot:connection/recovery-drive');
  await assert.rejects(()=>adapter.execute('recovery.google-drive.delete',descriptor()),/no soportada/);
  assert.equal(driver.commands.length,0);
});

test('adapter is exported and network/provider implementations stay outside the slice',async()=>{
  const module=await import('../src/index.ts');
  assert.equal(typeof module.RecoveryGoogleDriveAdapter,'function');
  const source=await import('node:fs/promises').then(({readFile})=>
    readFile(new URL('../src/adapters/recovery-google-drive.ts',import.meta.url),'utf8')
  );
  for(const forbidden of ['fetch(', 'http.request', 'https.request', 'googleapis', 'google-auth-library', 'spawn(']){
    assert.equal(source.includes(forbidden),false);
  }
});
