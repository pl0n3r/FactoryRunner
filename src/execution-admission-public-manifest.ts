import { stableSha256 } from './validation.ts';

export type ExecutionAdmissionPublicExportName =
  | 'executionAdmissionDecision'
  | 'ExecutionAdmissionDecision'
  | 'ExecutionAdmissionState'
  | 'admissionEvidence'
  | 'AdmissionEvidence';

export type ExecutionAdmissionPublicManifestEntry = Readonly<{
  export_name: ExecutionAdmissionPublicExportName;
  contract_version: 1;
}>;

export type ExecutionAdmissionPublicManifest = Readonly<{
  version: 1;
  authority: 'unchanged';
  exports: readonly ExecutionAdmissionPublicManifestEntry[];
  execution: false;
  network_access: false;
  external_mutation: false;
  fingerprint: string;
}>;

type ManifestCore = Omit<ExecutionAdmissionPublicManifest, 'fingerprint'>;

const EXPORT_NAMES: readonly ExecutionAdmissionPublicExportName[] = Object.freeze([
  'executionAdmissionDecision',
  'ExecutionAdmissionDecision',
  'ExecutionAdmissionState',
  'admissionEvidence',
  'AdmissionEvidence',
]);

function entries(): readonly ExecutionAdmissionPublicManifestEntry[] {
  return Object.freeze(
    EXPORT_NAMES.map((exportName) =>
      Object.freeze({
        export_name: exportName,
        contract_version: 1 as const,
      }),
    ),
  );
}

export function executionAdmissionPublicManifest(): ExecutionAdmissionPublicManifest {
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
