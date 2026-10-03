import {
  browserRemoteObservabilityCompatibility,
} from './browser-remote-observability-compatibility.ts';
import {
  browserRemoteObservabilityConsumerPacketCompatibility,
  type BrowserRemoteObservabilityConsumerPacketCompatibility,
} from './browser-remote-observability-consumer-packet-compatibility.ts';
import { browserRemoteObservabilityManifest } from './browser-remote-observability-manifest.ts';

export type BrowserRemoteObservabilityPublicConsumerCompatibility =
  BrowserRemoteObservabilityConsumerPacketCompatibility;

export function browserRemoteObservabilityPublicConsumerCompatibility(
  packetInput: unknown,
  consumerInput: unknown,
): BrowserRemoteObservabilityPublicConsumerCompatibility {
  const manifest = browserRemoteObservabilityManifest();
  const compatibility = browserRemoteObservabilityCompatibility(
    manifest,
    consumerInput,
  );
  return browserRemoteObservabilityConsumerPacketCompatibility(
    packetInput,
    manifest,
    consumerInput,
    compatibility,
  );
}
