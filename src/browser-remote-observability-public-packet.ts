import {
  browserRemoteObservabilityConsumerPacket,
  type BrowserRemoteObservabilityConsumerPacket,
} from './browser-remote-observability-consumer-packet.ts';
import { browserRemoteObservabilityManifest } from './browser-remote-observability-manifest.ts';

export type BrowserRemoteObservabilityPublicPacket =
  BrowserRemoteObservabilityConsumerPacket;

export function browserRemoteObservabilityPublicPacket(
  healthBundleInput: unknown,
): BrowserRemoteObservabilityPublicPacket {
  return browserRemoteObservabilityConsumerPacket(
    browserRemoteObservabilityManifest(),
    healthBundleInput,
  );
}
