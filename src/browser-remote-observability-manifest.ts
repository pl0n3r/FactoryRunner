import { stableSha256 } from './validation.ts';

export type BrowserRemoteObservabilityExportName =
  | 'browserRemoteDirectoryDoctor'
  | 'browserRemoteDirectoryHealth'
  | 'browserRemoteDirectoryHealthBundle'
  | 'browserRemoteDirectoryMetrics'
  | 'browserRemoteDirectoryReadiness'
  | 'browserRemoteDirectorySnapshot';

export type BrowserRemoteObservabilityManifestEntry = Readonly<{
  export_name: BrowserRemoteObservabilityExportName;
  contract_version: 1;
}>;

export type BrowserRemoteObservabilityManifest = Readonly<{
  version: 1;
  authority: 'unchanged';
  exports: readonly BrowserRemoteObservabilityManifestEntry[];
  fingerprint: string;
}>;

type ManifestCore = Omit<BrowserRemoteObservabilityManifest, 'fingerprint'>;

const EXPORT_NAMES: readonly BrowserRemoteObservabilityExportName[] = Object.freeze([
  'browserRemoteDirectoryDoctor',
  'browserRemoteDirectoryHealth',
  'browserRemoteDirectoryHealthBundle',
  'browserRemoteDirectoryMetrics',
  'browserRemoteDirectoryReadiness',
  'browserRemoteDirectorySnapshot',
]);

function entries(): readonly BrowserRemoteObservabilityManifestEntry[] {
  return Object.freeze(
    EXPORT_NAMES.map((exportName) =>
      Object.freeze({
        export_name: exportName,
        contract_version: 1 as const,
      }),
    ),
  );
}

export function browserRemoteObservabilityManifest(): BrowserRemoteObservabilityManifest {
  const core: ManifestCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    exports: entries(),
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
