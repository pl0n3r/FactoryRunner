import {
  browserRemoteObservabilityConsumerPacket,
  type BrowserRemoteObservabilityConsumerPacket,
} from './browser-remote-observability-consumer-packet.ts';
import type { BrowserRemoteDirectoryHealthBundle } from './browser-remote-directory-health-bundle.ts';
import { browserRemoteObservabilityManifest } from './browser-remote-observability-manifest.ts';

export type BrowserRemoteObservabilityPublicPacket =
  BrowserRemoteObservabilityConsumerPacket;

export function browserRemoteObservabilityPublicPacket(
  healthBundleInput: BrowserRemoteDirectoryHealthBundle,
): BrowserRemoteObservabilityPublicPacket {
  return browserRemoteObservabilityConsumerPacket(
    browserRemoteObservabilityManifest(),
    healthBundleInput,
  );
}
