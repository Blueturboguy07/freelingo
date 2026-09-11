import { NativeModule, registerWebModule } from 'expo';

/**
 * The web target exists only for token-conformance tests; there is no device backup to
 * be excluded from, and claiming otherwise would make INV-PACK-11 pass for free.
 */
class BackupExclusionModule extends NativeModule {
  async setExcludedFromBackup(_path: string): Promise<boolean> {
    return false;
  }
}

export default registerWebModule(BackupExclusionModule, 'BackupExclusionModule');
