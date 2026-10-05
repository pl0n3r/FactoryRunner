import { stableSha256 } from './validation.ts';

export type ExecutionRecoveryHandoffPublicExportName =
  | 'executionRecoveryHandoffManifest'
  | 'executionRecoveryHandoffManifestPreview'
  | 'executionRecoveryHandoffManifestVerify'
  | 'executionRecoveryHandoffPacket'
  | 'executionRecoveryHandoffPreview'
  | 'executionRecoveryHandoffVerify';

export type ExecutionRecoveryHandoffPublicManifestEntry = Readonly<{
  export_name: ExecutionRecoveryHandoffPublicExportName;
  contract_version: 1;
}>;

export type ExecutionRecoveryHandoffPublicManifest = Readonly<{
  version: 1;
  authority: 'unchanged';
  exports: readonly ExecutionRecoveryHandoffPublicManifestEntry[];
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type ManifestCore = Omit<ExecutionRecoveryHandoffPublicManifest, 'fingerprint'>;

const EXPORT_NAMES: readonly ExecutionRecoveryHandoffPublicExportName[] = Object.freeze([
  'executionRecoveryHandoffManifest',
  'executionRecoveryHandoffManifestPreview',
  'executionRecoveryHandoffManifestVerify',
  'executionRecoveryHandoffPacket',
  'executionRecoveryHandoffPreview',
  'executionRecoveryHandoffVerify',
]);

function entries(): readonly ExecutionRecoveryHandoffPublicManifestEntry[] {
  return Object.freeze(
    EXPORT_NAMES.map((exportName) =>
      Object.freeze({
        export_name: exportName,
        contract_version: 1 as const,
      }),
    ),
  );
}

export function executionRecoveryHandoffPublicManifest(): ExecutionRecoveryHandoffPublicManifest {
  const core: ManifestCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    exports: entries(),
    execution: false,
    network_access: false,
    external_mutation: false,
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
