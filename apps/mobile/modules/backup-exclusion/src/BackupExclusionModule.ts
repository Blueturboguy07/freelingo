import { NativeModule, requireNativeModule } from 'expo';

declare class BackupExclusionNativeModule extends NativeModule {
  setExcludedFromBackup(path: string): Promise<boolean>;
}

export default requireNativeModule<BackupExclusionNativeModule>('BackupExclusion');
