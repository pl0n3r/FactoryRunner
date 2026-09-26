import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseRunnerIdentity } from '../src/index.ts';

const versionFile = new URL('../config/version.json', import.meta.url);
const version = JSON.parse(await readFile(versionFile, 'utf8')) as { version: string };
parseRunnerIdentity({
  version: 1,
  runner_id: '00000000-0000-4000-8000-000000000001',
  protocol_version: 1,
  runtime: 'node',
  runtime_version: version.version,
  platform: 'linux',
  location: 'build-check',
  capabilities: ['contract-check'],
  max_parallel: 1,
});
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../dist/runtime-contract.json', import.meta.url),
  `${JSON.stringify({ name: '@pl0n3r/factoryrunner', version: version.version, protocol_version: 1 })}\n`,
  'utf8',
);
