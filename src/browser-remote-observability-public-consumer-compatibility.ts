import {
  browserRemoteObservabilityCompatibility,
  type BrowserRemoteObservabilityConsumer,
  type BrowserRemoteObservabilityRequirement,
} from './browser-remote-observability-compatibility.ts';
import {
  browserRemoteObservabilityConsumerPacketCompatibility,
  type BrowserRemoteObservabilityConsumerPacketCompatibility,
} from './browser-remote-observability-consumer-packet-compatibility.ts';
import type { BrowserRemoteObservabilityConsumerPacket } from './browser-remote-observability-consumer-packet.ts';
import { browserRemoteObservabilityManifest } from './browser-remote-observability-manifest.ts';

export type BrowserRemoteObservabilityPublicConsumerCompatibility =
  BrowserRemoteObservabilityConsumerPacketCompatibility;
export type BrowserRemoteObservabilityPublicConsumer =
  BrowserRemoteObservabilityConsumer;
export type BrowserRemoteObservabilityPublicRequirement =
  BrowserRemoteObservabilityRequirement;

export function browserRemoteObservabilityPublicConsumerCompatibility(
  packetInput: BrowserRemoteObservabilityConsumerPacket,
  consumerInput: BrowserRemoteObservabilityPublicConsumer,
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
