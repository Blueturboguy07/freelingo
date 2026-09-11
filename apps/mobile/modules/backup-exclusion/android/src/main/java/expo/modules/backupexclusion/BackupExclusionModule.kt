package expo.modules.backupexclusion

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Backup exclusion for the pack cache (INV-PACK-11, INV-PER-06).
 *
 * Android has no runtime per-file backup opt-out. Exclusion is *declared* statically in
 * `res/xml/backup_rules.xml` (Auto Backup, API <= 30) and `res/xml/data_extraction_rules.xml`
 * (API 31+), both written by this module's config plugin (`app.plugin.js`) and wired onto
 * `<application android:fullBackupContent/android:dataExtractionRules>`.
 *
 * So this returns `true` — the exclusion is already in force — but only once it has
 * confirmed the path exists, so a typo in the caller still surfaces as a rejection
 * rather than a cheerful `true`.
 */
class BackupExclusionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BackupExclusion")

    AsyncFunction("setExcludedFromBackup") { path: String ->
      val file = File(android.net.Uri.parse(path).path ?: path)
      if (!file.exists()) {
        throw PathNotFoundException(path)
      }
      true
    }
  }
}

internal class PathNotFoundException(path: String) :
  expo.modules.kotlin.exception.CodedException("No file or directory to exclude from backup at: $path")
