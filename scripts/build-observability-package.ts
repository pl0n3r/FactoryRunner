import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import process from 'node:process';
import { stripTypeScriptTypes } from 'node:module';

type PackageManifest = Readonly<{
  name: string;
  version: string;
  private: true;
  type: 'module';
  exports: Readonly<Record<string, string>>;
  files: readonly string[];
  engines?: Readonly<Record<string, string>>;
}>;

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PUBLIC_ENTRYPOINTS = Object.freeze({
  '.': 'src/browser-remote-observability-public.ts',
  './recovery-handoff': 'src/execution-recovery-handoff-public.ts',
}) satisfies Readonly<Record<string, string>>;

function fail(message: string): never {
  throw new Error(message);
}

function outputFromArgs(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--output' || argv[1].trim() === '') {
    fail('Uso: build-observability-package.ts --output <directorio-nuevo>');
  }
  const output = resolve(argv[1]);
  if (!isAbsolute(output)) fail('Output inválido.');
  const fromRoot = relative(ROOT, output);
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) {
    fail('El staging debe vivir fuera del repositorio.');
  }
  return output;
}

function expectedExports(): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(PUBLIC_ENTRYPOINTS).map(([key, entrypoint]) => [
        key,
        './' + entrypoint,
      ]),
    ),
  );
}

function packageManifest(input: unknown): PackageManifest {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail('package.json inválido.');
  }
  const manifest = input as Record<string, unknown>;
  if (
    typeof manifest.name !== 'string'
    || !manifest.name.startsWith('@pl0n3r/')
    || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || manifest.private !== true
    || manifest.type !== 'module'
  ) {
    fail('Metadata base del paquete inválida.');
  }

  const exportsValue = manifest.exports;
  const expected = expectedExports();
  if (
    typeof exportsValue !== 'object'
    || exportsValue === null
    || Array.isArray(exportsValue)
  ) {
    fail('Exports públicos inválidos.');
  }
  const actualExports = exportsValue as Record<string, unknown>;
  const actualKeys = Object.keys(actualExports).sort((left, right) => left.localeCompare(right, 'en'));
  const expectedKeys = Object.keys(expected).sort((left, right) => left.localeCompare(right, 'en'));
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || expectedKeys.some((key) => actualExports[key] !== expected[key])
  ) {
    fail('Entrypoints públicos inválidos.');
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fail('Allowlist files inválida.');
  }
  const files = manifest.files.map((value) => {
    if (
      typeof value !== 'string'
      || !value.startsWith('src/')
      || !value.endsWith('.ts')
      || value.includes('*')
      || value.includes('?')
      || normalize(value) !== value
      || value.split('/').includes('..')
    ) {
      fail('Ruta no canónica en files.');
    }
    return value;
  });
  if (new Set(files).size !== files.length) fail('files contiene duplicados.');
  const sorted = [...files].sort((left, right) => left.localeCompare(right, 'en'));
  if (files.some((value, index) => value !== sorted[index])) {
    fail('files debe estar ordenado.');
  }
  for (const entrypoint of Object.values(PUBLIC_ENTRYPOINTS)) {
    if (!files.includes(entrypoint)) fail('Falta un entrypoint público.');
  }

  const engines = manifest.engines;
  if (
    engines !== undefined
    && (
      typeof engines !== 'object'
      || engines === null
      || Array.isArray(engines)
      || Object.values(engines).some((value) => typeof value !== 'string')
    )
  ) {
    fail('engines inválido.');
  }

  return {
    name: manifest.name,
    version: manifest.version,
    private: true,
    type: 'module',
    exports: expected,
    files: Object.freeze(files),
    ...(engines === undefined
      ? {}
      : { engines: engines as Readonly<Record<string, string>> }),
  };
}

function rewriteRelativeTypeScriptImports(source: string): string {
  return source
    .replace(
      /(\bfrom\s*['"])(\.[^'"]+)\.ts(['"])/g,
      '$1$2.js$3',
    )
    .replace(
      /(\bimport\s*\(\s*['"])(\.[^'"]+)\.ts(['"]\s*\))/g,
      '$1$2.js$3',
    )
    .replace(
      /(\bimport\s*['"])(\.[^'"]+)\.ts(['"])/g,
      '$1$2.js$3',
    );
}

async function transpileAllowlist(
  manifest: PackageManifest,
  outputRoot: string,
): Promise<readonly string[]> {
  const emitted: string[] = [];
  for (const sourceRelative of manifest.files) {
    const sourcePath = resolve(ROOT, sourceRelative);
    const sourceBoundary = relative(resolve(ROOT, 'src'), sourcePath);
    if (
      sourceBoundary === ''
      || sourceBoundary.startsWith('..')
      || isAbsolute(sourceBoundary)
    ) {
      fail('Fuente fuera de src/.');
    }
    const source = await readFile(sourcePath, 'utf8');
    let outputText: string;
    try {
      outputText = stripTypeScriptTypes(source, { mode: 'strip' });
    } catch {
      fail('Fuente TypeScript no erasable en allowlist.');
    }
    outputText = rewriteRelativeTypeScriptImports(outputText);

    const emittedRelative = sourceRelative.replace(/\.ts$/, '.js');
    const emittedPath = resolve(outputRoot, emittedRelative);
    const outputBoundary = relative(outputRoot, emittedPath);
    if (outputBoundary.startsWith('..') || isAbsolute(outputBoundary)) {
      fail('Output fuera del staging.');
    }
    await mkdir(dirname(emittedPath), { recursive: true });
    await writeFile(emittedPath, outputText, 'utf8');
    emitted.push(emittedRelative);
  }
  return Object.freeze(emitted);
}

async function main(): Promise<void> {
  const outputRoot = outputFromArgs(process.argv.slice(2));
  await mkdir(outputRoot, { recursive: false });

  const manifest = packageManifest(
    JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')) as unknown,
  );
  const emitted = await transpileAllowlist(manifest, outputRoot);
  const stagedExports = Object.freeze(
    Object.fromEntries(
      Object.entries(manifest.exports).map(([key, source]) => [
        key,
        source.replace(/\.ts$/, '.js'),
      ]),
    ),
  );

  const staged = {
    name: manifest.name,
    version: manifest.version,
    private: true,
    type: 'module',
    exports: stagedExports,
    files: emitted,
    ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
  } as const;

  await writeFile(
    resolve(outputRoot, 'package.json'),
    JSON.stringify(staged, null, 2) + '\n',
    'utf8',
  );

  try {
    await copyFile(resolve(ROOT, 'README.md'), resolve(outputRoot, 'README.md'));
  } catch (error) {
    fail('README.md requerido para metadata local: ' + String(error));
  }
}

await main();
