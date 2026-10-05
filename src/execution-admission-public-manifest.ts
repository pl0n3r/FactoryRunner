import { stableSha256 } from './validation.ts';

export const EXECUTION_ADMISSION_PUBLIC_EXPORTS = Object.freeze([
  'executionAdmissionDecision',
  'ExecutionAdmissionDecision',
  'ExecutionAdmissionState',
  'admissionEvidence',
  'AdmissionEvidence',
] as const);

export type ExecutionAdmissionPublicExportName =
  (typeof EXECUTION_ADMISSION_PUBLIC_EXPORTS)[number];

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

const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

export function executionAdmissionPublicManifest(): ExecutionAdmissionPublicManifest {
  const exportedContracts = Object.freeze(
    EXECUTION_ADMISSION_PUBLIC_EXPORTS.map((export_name) =>
      Object.freeze({ export_name, contract_version: 1 as const }),
    ),
  );
  const core = Object.freeze({
    version: 1 as const,
    ...SAFETY,
    exports: exportedContracts,
  });

  return Object.freeze({ ...core, fingerprint: stableSha256(core) });
}
