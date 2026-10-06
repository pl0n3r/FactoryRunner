import { stableSha256 } from './validation.ts';

export type ControlBotHttpPublicCapability = 'protocol' | 'fencing' | 'session';

export const CONTROLBOT_HTTP_PUBLIC_EXPORTS = Object.freeze([
  Object.freeze({
    export_name: 'controlBotRunnerHttpRequest',
    contract_version: 1 as const,
    capability: 'protocol' as const,
  }),
  Object.freeze({
    export_name: 'assertFencedAck',
    contract_version: 1 as const,
    capability: 'fencing' as const,
  }),
  Object.freeze({
    export_name: 'assertFencedEvent',
    contract_version: 1 as const,
    capability: 'fencing' as const,
  }),
  Object.freeze({
    export_name: 'bindFencedExecution',
    contract_version: 1 as const,
    capability: 'fencing' as const,
  }),
  Object.freeze({
    export_name: 'ControlBotHttpSessionClient',
    contract_version: 1 as const,
    capability: 'session' as const,
  }),
  Object.freeze({
    export_name: 'HttpSessionClientError',
    contract_version: 1 as const,
    capability: 'session' as const,
  }),
] as const);

export type ControlBotHttpPublicExportName =
  (typeof CONTROLBOT_HTTP_PUBLIC_EXPORTS)[number]['export_name'];

export type ControlBotHttpPublicManifestEntry =
  (typeof CONTROLBOT_HTTP_PUBLIC_EXPORTS)[number];

export type ControlBotHttpPublicManifest = Readonly<{
  version: 1;
  subpath: './controlbot-http';
  protocol_version: 1;
  fencing: 'required';
  session_transport: 'injected_test_only';
  authority: 'unchanged';
  execution: false;
  network_access: false;
  external_mutation: false;
  exports: readonly ControlBotHttpPublicManifestEntry[];
  fingerprint: string;
}>;

type ManifestCore = Omit<ControlBotHttpPublicManifest, 'fingerprint'>;

const SAFETY = Object.freeze({
  authority: 'unchanged' as const,
  execution: false as const,
  network_access: false as const,
  external_mutation: false as const,
});

export function controlBotHttpPublicManifest(): ControlBotHttpPublicManifest {
  const core: ManifestCore = Object.freeze({
    version: 1,
    subpath: './controlbot-http',
    protocol_version: 1,
    fencing: 'required',
    session_transport: 'injected_test_only',
    ...SAFETY,
    exports: CONTROLBOT_HTTP_PUBLIC_EXPORTS,
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
