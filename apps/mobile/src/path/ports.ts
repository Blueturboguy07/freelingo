import type { PathModel, LaunchFlavour } from '@freelingo/core/path';
import type { SessionFlavour } from '@freelingo/core/session';
import type { UiPreferences } from '@freelingo/ui';
export interface PathLaunch {
  readonly nodeId: string;
  readonly unitIndex: number;
  readonly flavour: SessionFlavour | Exclude<LaunchFlavour, 'practice' | 'endgame'>;
}
export interface PathScreenProps extends UiPreferences {
  readonly model: PathModel | null;
  readonly status?: 'loading' | 'ready' | 'pack-missing' | 'history-unavailable';
  readonly selectedNodeId: string | null;
  readonly onSelectNode: (id: string | null) => void;
  readonly onLaunch: (request: PathLaunch) => void;
  readonly onOpenGuidebook: (unitIndex: number) => void;
  readonly onOpenSections: () => void;
  readonly onRepairPack: () => void;
  readonly advertisedXpByNode?: Readonly<
    Record<string, Readonly<Partial<Record<LaunchFlavour, number>>>>
  >;
  readonly unavailableNodeIds?: readonly string[];
  readonly summary?: { readonly streak: number; readonly gems: number; readonly score?: number };
}
