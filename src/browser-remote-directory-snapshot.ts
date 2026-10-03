import type { BrowserRemoteProfile } from './browser-remote-profile.ts';
import { BrowserRemoteDirectory } from './browser-remote-directory.ts';
import { stableSha256 } from './validation.ts';

export type BrowserRemoteDirectorySnapshot = Readonly<{
  version: 1;
  authority: 'unchanged';
  size: number;
  profiles: readonly BrowserRemoteProfile[];
  fingerprint: string;
}>;

type BrowserRemoteDirectorySnapshotCore = Omit<
  BrowserRemoteDirectorySnapshot,
  'fingerprint'
>;

export function browserRemoteDirectorySnapshot(
  directory: BrowserRemoteDirectory,
): BrowserRemoteDirectorySnapshot {
  if (!(directory instanceof BrowserRemoteDirectory)) {
    throw new TypeError('BrowserRemoteDirectory requerido.');
  }

  const profiles = Object.freeze(
    directory
      .entries()
      .map((entry) => entry.profile)
      .sort((left, right) =>
        left.remote_alias < right.remote_alias
          ? -1
          : left.remote_alias > right.remote_alias
            ? 1
            : 0),
  );

  const core: BrowserRemoteDirectorySnapshotCore = Object.freeze({
    version: 1,
    authority: 'unchanged',
    size: profiles.length,
    profiles,
  });

  return Object.freeze({
    ...core,
    fingerprint: stableSha256(core),
  });
}
