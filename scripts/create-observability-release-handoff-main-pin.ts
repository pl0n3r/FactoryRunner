import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

type JsonObject = Record<string, unknown>;

const SHA1 = /^[a-f0-9]{40}$/;
const UNKNOWN_SHA = /^0{40}$/;
const MAX_OUTPUT_BYTES = 1024;

function fail(message: string): never {
  throw new Error(message);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value), null, 2) + '\n';
}

function exactSha(value: string | undefined, label: string): string {
  if (value === undefined || !SHA1.test(value) || UNKNOWN_SHA.test(value)) {
    fail(`${label}: SHA exacto inválido o UNKNOWN.`);
  }
  return value;
}

function options(argv: readonly string[]): Readonly<{
  commit: string;
  tree: string;
  output: string;
}> {
  if (argv.length !== 6) fail('Argumentos inválidos.');
  const accepted = new Set(['--commit-sha', '--tree-sha', '--output']);
  const parsed = new Map<string, string>();
  for (let cursor = 0; cursor < argv.length; cursor += 2) {
    const flag = argv[cursor];
    const value = argv[cursor + 1];
    if (
      !accepted.has(flag)
      || value === undefined
      || value.trim() === ''
      || parsed.has(flag)
    ) {
      fail('Argumentos inválidos.');
    }
    parsed.set(flag, value);
  }

  const commit = exactSha(parsed.get('--commit-sha'), 'commit_sha');
  const tree = exactSha(parsed.get('--tree-sha'), 'tree_sha');
  const output = parsed.get('--output');
  if (output === undefined) fail('Falta output requerido.');
  if (commit === tree) fail('Identidad current-main mixed o ambigua.');

  return Object.freeze({
    commit,
    tree,
    output: resolve(output),
  });
}

async function main(): Promise<void> {
  const parsed = options(process.argv.slice(2));
  const pin = {
    schema_version: 1,
    repository: {
      ref: 'refs/heads/main',
      commit_sha: parsed.commit,
      tree_sha: parsed.tree,
    },
    verification: {
      current_main_explicit: true,
    },
    authority: 'unchanged',
    publish_authority: false,
    network_access: false,
    external_mutation: false,
  };
  const serialized = canonicalJson(pin);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTPUT_BYTES) {
    fail('Current-main pin fuera de límites.');
  }

  await writeFile(parsed.output, serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

await main();
