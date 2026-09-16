import type { LoadedPack, PackManifest, PackState } from '@freelingo/core/packs';
import type { VerifiedRuntimeItem } from '../../../../packages/core/src/packs/runtime-item-types';

/** All lookups are synchronous after refresh verifies the immutable on-disk payload. */
export interface VerifiedInstalledPack {
  readonly courseId: string;
  readonly contentHash: string;
  readonly manifest: PackManifest;
  readonly pack: LoadedPack;
  /** Only authenticated, currently installed audio is playable. */
  audioUri(audioId: string): string | null;
  runtimeItem(exerciseId: string): VerifiedRuntimeItem;
}
/** One repository owns native readers for an opened app runtime. Refresh precedes
 * launch/foreground work; no hashing or native open occurs inside answer transactions. */
export interface InstalledPackRepository {
  refresh(courseIds: readonly string[]): Promise<void>;
  get(courseId: string): VerifiedInstalledPack | null;
  state(courseId: string): PackState;
  close(): void;
}
